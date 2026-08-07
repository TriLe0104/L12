"""Load, validate, and resolve board settings.

The published document lives in a single-row `board_settings` table. Every
authenticated reader gets the same config; only Admin may PUT. Helpers here
derive status labels, kanban column membership, and drag-drop defaults so
purchase-order routes stop hard-coding STAGE_BY_STATUS.
"""

from __future__ import annotations

import re
from copy import deepcopy
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .board_defaults import (
    ALLOWED_CUSTOM_TYPES,
    BUILTIN_ALLOWED_TYPES,
    BUILTIN_CARD_KEYS,
    BUILTIN_DASHBOARD_KEYS,
    BUILTIN_DEFAULT_TYPES,
    BUILTIN_SELECT_FIELD_KEYS,
    DEFAULT_TONE_HEX,
    DOCUMENT_VERSION,
    HARDWARE_FIELD_KEY,
    INSPECTION_FIELD_KEY,
    MATERIAL_FIELD_KEY,
    PRIORITY_FIELD_KEY,
    _normalize_option_list,
    apply_card_field_types_upgrade,
    apply_dashboard_columns_upgrade,
    apply_dashboard_filterable_upgrade,
    apply_priority_card_visible,
    clone_default,
    default_selection_lists,
    document_needs_card_field_types_upgrade,
    document_needs_dashboard_columns_upgrade,
    document_needs_dashboard_filterable_upgrade,
    document_needs_priority_visible_upgrade,
    document_needs_selection_lists_upgrade,
    document_needs_status_upgrade,
    normalize_status_key,
    normalize_tone,
    sync_dashboard_columns,
    upgrade_document,
    upgrade_selection_lists,
)
from .models import BoardSettings, PurchaseOrder, User, _now

_KEY_RE = re.compile(r"^[a-z][a-z0-9_]{0,39}$")


def _as_dict(row: BoardSettings | None) -> dict[str, Any]:
    if row is None or not isinstance(row.document, dict):
        return clone_default()
    return deepcopy(row.document)


def ensure_row(db: Session) -> BoardSettings:
    """Return the singleton settings row, seeding defaults on first use.

    Also runs idempotent repairs: rewrite retired PO status keys first (settings
    validation blocks removing in-use statuses), then upgrade the published
    document (v2 statuses, v3–v5 selectionLists, v4 Priority visible, v6
    dashboard columns, v7 card field types, v8 dashboard filterable) while
    preserving unrelated Admin config.
    """
    row = db.get(BoardSettings, 1)
    if row is None:
        row = BoardSettings(id=1, document=clone_default(), version=DOCUMENT_VERSION)
        db.add(row)
        db.commit()
        db.refresh(row)
    elif not row.document:
        row.document = clone_default()
        row.version = DOCUMENT_VERSION
        db.commit()
        db.refresh(row)

    po_mapped = repair_purchase_order_statuses(db)
    doc_upgraded = False
    doc = row.document if isinstance(row.document, dict) else {}
    if document_needs_status_upgrade(doc):
        # Upgrade before any Admin PUT so the in-use check sees the new keys.
        upgraded = upgrade_document(doc)
        # Preserve forward-compatible keys already on the row.
        if isinstance(row.document, dict):
            for key, value in row.document.items():
                if key not in upgraded:
                    upgraded[key] = deepcopy(value)
        # Status upgrade also folds selection lists when present on the fresh default.
        upgraded = upgrade_selection_lists(upgraded)
        upgraded = apply_priority_card_visible(upgraded)
        upgraded = apply_dashboard_columns_upgrade(upgraded)
        upgraded = apply_dashboard_filterable_upgrade(upgraded)
        row.document = upgraded
        row.version = DOCUMENT_VERSION
        row.updated_at = _now()
        doc_upgraded = True
        doc = upgraded

    # v4: reveal Priority on cards/editor (historically hidden). Must run before
    # selection-list repair, which also bumps version to DOCUMENT_VERSION.
    if document_needs_priority_visible_upgrade(doc):
        patched = apply_priority_card_visible(doc if isinstance(doc, dict) else {})
        if isinstance(row.document, dict):
            for key, value in row.document.items():
                if key not in patched:
                    patched[key] = deepcopy(value)
        row.document = patched
        row.version = DOCUMENT_VERSION
        row.updated_at = _now()
        doc_upgraded = True
        doc = patched

    # v3/v5: fold materialTypes → selectionLists even when statuses are already current.
    if document_needs_selection_lists_upgrade(doc):
        patched = upgrade_selection_lists(doc if isinstance(doc, dict) else {})
        if isinstance(row.document, dict):
            for key, value in row.document.items():
                if key not in patched and key != "materialTypes":
                    patched[key] = deepcopy(value)
        # Keep the highest known gate (priority may already have set v4).
        try:
            prior_ver = int((doc if isinstance(doc, dict) else {}).get("version") or 0)
        except (TypeError, ValueError):
            prior_ver = 0
        try:
            patched_ver = int(patched.get("version") or 0)
        except (TypeError, ValueError):
            patched_ver = 0
        patched["version"] = max(prior_ver, patched_ver, DOCUMENT_VERSION)
        row.document = patched
        row.version = int(patched["version"])
        row.updated_at = _now()
        doc_upgraded = True
        doc = patched

    # v6: dashboard widthRem + sync custom/new builtin columns (hidden by default).
    if document_needs_dashboard_columns_upgrade(doc):
        patched = apply_dashboard_columns_upgrade(doc if isinstance(doc, dict) else {})
        if isinstance(row.document, dict):
            for key, value in row.document.items():
                if key not in patched:
                    patched[key] = deepcopy(value)
        row.document = patched
        row.version = DOCUMENT_VERSION
        row.updated_at = _now()
        doc_upgraded = True
        doc = patched

    # v7: stamp builtin card field types; preserve Admin labels.
    if document_needs_card_field_types_upgrade(doc):
        patched = apply_card_field_types_upgrade(doc if isinstance(doc, dict) else {})
        if isinstance(row.document, dict):
            for key, value in row.document.items():
                if key not in patched:
                    patched[key] = deepcopy(value)
        row.document = patched
        row.version = DOCUMENT_VERSION
        row.updated_at = _now()
        doc_upgraded = True
        doc = patched

    # v8: dashboardColumns.filterable (stage/status/priority default on).
    if document_needs_dashboard_filterable_upgrade(doc):
        patched = apply_dashboard_filterable_upgrade(doc if isinstance(doc, dict) else {})
        if isinstance(row.document, dict):
            for key, value in row.document.items():
                if key not in patched:
                    patched[key] = deepcopy(value)
        row.document = patched
        row.version = DOCUMENT_VERSION
        row.updated_at = _now()
        doc_upgraded = True

    if po_mapped or doc_upgraded:
        db.commit()
        db.refresh(row)
    return row


def repair_purchase_order_statuses(db: Session) -> dict[str, int]:
    """Rewrite retired / alias status keys on every PO. Returns {from->to: count}."""
    mapped: dict[str, int] = {}
    for po in db.scalars(select(PurchaseOrder)).all():
        current = (
            po.status
            if isinstance(po.status, str)
            else getattr(po.status, "value", str(po.status))
        )
        target = normalize_status_key(current)
        if target == current:
            continue
        po.status = target
        label = f"{current}->{target}"
        mapped[label] = mapped.get(label, 0) + 1
    return mapped


def get_document(db: Session) -> dict[str, Any]:
    return _as_dict(ensure_row(db))


def status_map(doc: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {s["key"]: s for s in doc.get("statuses", []) if isinstance(s, dict) and "key" in s}


def status_label(doc: dict[str, Any], key: str) -> str:
    meta = status_map(doc).get(key)
    if meta:
        return str(meta.get("label") or key)
    return key.replace("_", " ").upper()


def status_tone(doc: dict[str, Any], key: str) -> str:
    meta = status_map(doc).get(key)
    if meta:
        try:
            return normalize_tone(meta.get("tone"))
        except ValueError:
            pass
    return DEFAULT_TONE_HEX


def column_for_status(doc: dict[str, Any], status_key: str) -> str | None:
    for col in doc.get("kanbanColumns", []):
        if status_key in (col.get("statusKeys") or []):
            return str(col["key"])
    return None


def default_status_for_column(doc: dict[str, Any], column_key: str) -> str | None:
    for col in doc.get("kanbanColumns", []):
        if col.get("key") == column_key:
            keys = col.get("statusKeys") or []
            return str(keys[0]) if keys else None
    return None


def column_meta(doc: dict[str, Any], column_key: str) -> dict[str, Any] | None:
    for col in doc.get("kanbanColumns", []):
        if col.get("key") == column_key:
            return col
    return None


def statuses_for_meta(doc: dict[str, Any]) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for s in doc.get("statuses", []):
        try:
            tone = normalize_tone(s.get("tone"))
        except ValueError:
            tone = DEFAULT_TONE_HEX
        out.append({"value": s["key"], "label": s["label"], "tone": tone})
    return out


def stages_for_meta(doc: dict[str, Any]) -> list[dict[str, Any]]:
    """Project kanban columns into the legacy StageMeta shape for /api/meta/stages."""
    out: list[dict[str, Any]] = []
    for col in doc.get("kanbanColumns", []):
        try:
            tone = normalize_tone(col.get("tone"))
        except ValueError:
            tone = DEFAULT_TONE_HEX
        out.append(
            {
                "value": col["key"],
                "label": col["label"],
                "tone": tone,
                "statuses": list(col.get("statusKeys") or []),
            }
        )
    return out


def apply_po_overlays(db: Session, pos: list[PurchaseOrder]) -> None:
    """Attach status_label / stage / priority_label from published board settings."""
    if not pos:
        return
    doc = get_document(db)
    for po in pos:
        key = po.status if isinstance(po.status, str) else getattr(po.status, "value", str(po.status))
        po._status_label = status_label(doc, key)  # type: ignore[attr-defined]
        col = column_for_status(doc, key)
        po._stage = col or "pending"  # type: ignore[attr-defined]
        prio = po.priority if isinstance(po.priority, str) else getattr(po.priority, "value", str(po.priority))
        po._priority_label = priority_label_for(doc, prio)  # type: ignore[attr-defined]


def _require_key(value: object, *, what: str) -> str:
    if not isinstance(value, str) or not _KEY_RE.match(value):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"{what} key must be a lowercase identifier (a-z, digits, underscore), got {value!r}",
        )
    return value


def validate_document(doc: dict[str, Any], *, db: Session, previous: dict[str, Any]) -> dict[str, Any]:
    """Validate and normalise a PUT body. Raises HTTPException on failure."""
    if not isinstance(doc, dict):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Board settings must be a JSON object")

    out = clone_default()
    out["version"] = DOCUMENT_VERSION

    # ----- custom fields -----
    custom_raw = doc.get("customFields", [])
    if not isinstance(custom_raw, list):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "customFields must be a list")
    custom_fields: list[dict[str, Any]] = []
    custom_keys: set[str] = set()
    select_keys: set[str] = set()
    for item in custom_raw:
        if not isinstance(item, dict):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Each custom field must be an object")
        key = _require_key(item.get("key"), what="Custom field")
        if key in BUILTIN_CARD_KEYS or key in custom_keys:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Duplicate or reserved field key: {key}")
        if key.startswith("cf_") is False and key in BUILTIN_CARD_KEYS:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Custom field key collides with builtin: {key}")
        label = str(item.get("label") or "").strip()
        if not label:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Custom field {key} needs a label")
        ftype = str(item.get("type") or "text")
        if ftype not in ALLOWED_CUSTOM_TYPES:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                f"Custom field {key} type must be one of {sorted(ALLOWED_CUSTOM_TYPES)}",
            )
        entry: dict[str, Any] = {"key": key, "label": label, "type": ftype}
        if ftype == "select":
            # Empty options allowed so Admin can create the field then fill choices.
            options = _validate_option_list(
                item.get("options") or [],
                what=f"Select field {key} options",
                require_nonempty=False,
            )
            entry["options"] = options
            select_keys.add(key)
        custom_fields.append(entry)
        custom_keys.add(key)
    out["customFields"] = custom_fields

    # ----- card fields -----
    card_raw = doc.get("cardFields", [])
    if not isinstance(card_raw, list) or not card_raw:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "cardFields must be a non-empty list")
    default_card_by_key = {f["key"]: f for f in out["cardFields"]}
    card_fields: list[dict[str, Any]] = []
    seen_card: set[str] = set()
    builtin_select_keys: set[str] = set()
    for item in card_raw:
        if not isinstance(item, dict):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Each card field must be an object")
        key = str(item.get("key") or "")
        kind = str(item.get("kind") or ("custom" if key in custom_keys else "builtin"))
        if kind == "builtin":
            if key not in BUILTIN_CARD_KEYS:
                raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Unknown builtin card field: {key}")
            catalog = default_card_by_key[key]
            label = str(item.get("label") or "").strip() or str(catalog["label"])
            default_type = BUILTIN_DEFAULT_TYPES.get(key, "text")
            allowed = BUILTIN_ALLOWED_TYPES.get(key, frozenset({"text"}))
            raw_type = item.get("type")
            if raw_type is None:
                ftype = str(catalog.get("type") or default_type)
            else:
                ftype = str(raw_type)
            if ftype not in allowed:
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST,
                    f"Builtin field {key} type must be one of {sorted(allowed)}",
                )
            entry = {
                "key": key,
                "kind": "builtin",
                "label": label,
                "visible": bool(item.get("visible", True)),
                "type": ftype,
            }
            if ftype == "select":
                builtin_select_keys.add(key)
        else:
            if key not in custom_keys:
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST,
                    f"Card field {key} is not in customFields",
                )
            label = next(f["label"] for f in custom_fields if f["key"] == key)
            entry = {
                "key": key,
                "kind": "custom",
                "label": label,
                "visible": bool(item.get("visible", True)),
            }
        if key in seen_card:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Duplicate card field: {key}")
        seen_card.add(key)
        card_fields.append(entry)
    # Every custom field must appear in cardFields (may be hidden).
    for ck in custom_keys:
        if ck not in seen_card:
            cf = next(f for f in custom_fields if f["key"] == ck)
            card_fields.append(
                {"key": ck, "kind": "custom", "label": cf["label"], "visible": True}
            )
    # Ensure all builtins are present (append hidden if omitted).
    for bk in BUILTIN_CARD_KEYS:
        if bk not in seen_card:
            catalog = default_card_by_key[bk]
            ftype = str(catalog.get("type") or BUILTIN_DEFAULT_TYPES.get(bk, "text"))
            card_fields.append(
                {
                    "key": bk,
                    "kind": "builtin",
                    "label": catalog["label"],
                    "visible": False,
                    "type": ftype,
                }
            )
            if ftype == "select":
                builtin_select_keys.add(bk)
    # Required builtins that must stay visible on the card.
    for required in ("po_number", "part_number"):
        for cf in card_fields:
            if cf["key"] == required:
                cf["visible"] = True
    out["cardFields"] = card_fields

    # ----- statuses -----
    status_raw = doc.get("statuses", [])
    if not isinstance(status_raw, list) or not status_raw:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "statuses must be a non-empty list")
    statuses: list[dict[str, Any]] = []
    status_keys: set[str] = set()
    for item in status_raw:
        if not isinstance(item, dict):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Each status must be an object")
        key = _require_key(item.get("key"), what="Status")
        if key in status_keys:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Duplicate status key: {key}")
        label = str(item.get("label") or "").strip()
        if not label:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Status {key} needs a label")
        try:
            tone = normalize_tone(item.get("tone"), what=f"Status {key} tone")
        except ValueError as exc:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
        statuses.append({"key": key, "label": label, "tone": tone})
        status_keys.add(key)
    out["statuses"] = statuses

    prev_keys = {s["key"] for s in previous.get("statuses", []) if isinstance(s, dict)}
    removed = prev_keys - status_keys
    if removed:
        counts = _status_usage(db, removed)
        blockers = {k: n for k, n in counts.items() if n > 0}
        if blockers:
            parts = [f"{k} ({n})" for k, n in sorted(blockers.items())]
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "Cannot remove status still in use: " + ", ".join(parts),
            )

    # ----- dashboard columns -----
    dash_raw = doc.get("dashboardColumns", [])
    if not isinstance(dash_raw, list) or not dash_raw:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "dashboardColumns must be a non-empty list")
    allowed_dash = BUILTIN_DASHBOARD_KEYS | custom_keys
    seen_dash: set[str] = set()
    dash_input: list[dict[str, Any]] = []
    for item in dash_raw:
        if not isinstance(item, dict):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Each dashboard column must be an object")
        key = str(item.get("key") or "")
        if key not in allowed_dash:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Unknown dashboard column: {key}")
        if key in seen_dash:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Duplicate dashboard column: {key}")
        entry: dict[str, Any] = {
            "key": key,
            "visible": bool(item.get("visible", True)),
        }
        if "widthRem" in item:
            entry["widthRem"] = item.get("widthRem")
        if "filterable" in item:
            entry["filterable"] = bool(item.get("filterable"))
        if item.get("label"):
            entry["label"] = str(item.get("label")).strip()
        dash_input.append(entry)
        seen_dash.add(key)
    out["dashboardColumns"] = dash_input
    # Sync fills labels, widthRem defaults, missing builtins/customs (hidden), drops orphans.
    out["dashboardColumns"] = sync_dashboard_columns(out)

    # ----- kanban columns -----
    kanban_raw = doc.get("kanbanColumns", [])
    if not isinstance(kanban_raw, list) or not kanban_raw:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "kanbanColumns must be a non-empty list")
    kanban: list[dict[str, Any]] = []
    seen_cols: set[str] = set()
    assigned: dict[str, str] = {}
    for item in kanban_raw:
        if not isinstance(item, dict):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Each kanban column must be an object")
        key = _require_key(item.get("key"), what="Kanban column")
        if key in seen_cols:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Duplicate kanban column: {key}")
        label = str(item.get("label") or "").strip()
        if not label:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Kanban column {key} needs a label")
        try:
            tone = normalize_tone(item.get("tone"), what=f"Kanban column {key} tone")
        except ValueError as exc:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
        status_keys_list = item.get("statusKeys") or []
        if not isinstance(status_keys_list, list):
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                f"Kanban column {key} statusKeys must be a list",
            )
        normalised: list[str] = []
        for sk in status_keys_list:
            sk = str(sk)
            if sk not in status_keys:
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST,
                    f"Kanban column {key} references unknown status {sk}",
                )
            if sk in assigned:
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST,
                    f"Status {sk} is mapped to both {assigned[sk]} and {key}; "
                    "each status must belong to exactly one column",
                )
            assigned[sk] = key
            normalised.append(sk)
        if not normalised:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                f"Kanban column {key} needs at least one status "
                "(used as the default when a card is dragged in)",
            )
        kanban.append(
            {
                "key": key,
                "label": label,
                "tone": tone,
                "statusKeys": normalised,
                "isCompleted": bool(item.get("isCompleted", False)),
            }
        )
        seen_cols.add(key)

    unassigned = status_keys - set(assigned)
    if unassigned:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Every status must belong to exactly one kanban column. Unassigned: "
            + ", ".join(sorted(unassigned)),
        )

    completed = [c for c in kanban if c["isCompleted"]]
    if len(completed) > 1:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "At most one kanban column may be marked isCompleted (hide-completed uses it)",
        )
    out["kanbanColumns"] = kanban

    # ----- selection lists (material + custom select options) -----
    lists_out = _resolve_selection_lists(
        doc,
        previous=previous,
        default_doc=out,
        select_keys=select_keys,
        builtin_select_keys=builtin_select_keys,
        custom_fields=custom_fields,
    )
    # Block removing options still referenced by purchase orders (status-style).
    prev_lists = (
        previous.get("selectionLists")
        if isinstance(previous.get("selectionLists"), dict)
        else {}
    )
    labels = {
        MATERIAL_FIELD_KEY: "material",
        INSPECTION_FIELD_KEY: "inspection",
        HARDWARE_FIELD_KEY: "hardware",
        PRIORITY_FIELD_KEY: "priority",
    }
    for key, options in lists_out.items():
        prev_opts = prev_lists.get(key)
        if not isinstance(prev_opts, list):
            if key == MATERIAL_FIELD_KEY:
                prev_opts = previous.get("materialTypes") or []
            else:
                prev_opts = []
        what = labels.get(key) or key
        _assert_options_not_in_use(
            db,
            field_key=key,
            previous_options=[str(x) for x in prev_opts],
            next_options=options,
            what=what,
        )
    out["selectionLists"] = lists_out
    # Mirror options onto custom select field definitions.
    for entry in custom_fields:
        if entry.get("type") == "select":
            entry["options"] = list(lists_out.get(entry["key"]) or [])
    out["customFields"] = custom_fields
    # Stop publishing the legacy top-level key.
    out.pop("materialTypes", None)

    # Preserve forward-compatible keys from the PUT body or the previously
    # published document so concurrent settings features aren't wiped.
    known = {
        "version",
        "cardFields",
        "customFields",
        "statuses",
        "dashboardColumns",
        "kanbanColumns",
        "selectionLists",
        "materialTypes",  # accepted on input, dropped above after migrate
    }
    for source in (previous, doc):
        if not isinstance(source, dict):
            continue
        for key, value in source.items():
            if key not in known and key not in out:
                out[key] = deepcopy(value)
    for key, value in doc.items():
        if key not in known:
            out[key] = deepcopy(value)

    return out


def _validate_option_list(
    raw: Any,
    *,
    what: str,
    require_nonempty: bool,
) -> list[str]:
    if not isinstance(raw, list):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"{what} must be a list")
    options: list[str] = []
    seen: set[str] = set()
    for item in raw:
        label = str(item or "").strip()
        if not label:
            continue
        if len(label) > 160:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                f"{what} entry is too long (max 160): {label[:40]}…",
            )
        key = label.casefold()
        if key in seen:
            continue
        seen.add(key)
        options.append(label)
    if require_nonempty and not options:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"{what} needs at least one entry")
    return options


def _resolve_selection_lists(
    doc: dict[str, Any],
    *,
    previous: dict[str, Any],
    default_doc: dict[str, Any],
    select_keys: set[str],
    builtin_select_keys: set[str] | None = None,
    custom_fields: list[dict[str, Any]],
) -> dict[str, list[str]]:
    """Build selectionLists from PUT body, field options, or legacy materialTypes."""
    prev_lists = previous.get("selectionLists") if isinstance(previous.get("selectionLists"), dict) else {}
    body_lists = doc.get("selectionLists") if isinstance(doc.get("selectionLists"), dict) else {}
    default_lists = (
        default_doc.get("selectionLists")
        if isinstance(default_doc.get("selectionLists"), dict)
        else default_selection_lists()
    )
    active_builtin_selects = set(builtin_select_keys or ())

    wanted_keys = {*BUILTIN_SELECT_FIELD_KEYS, *select_keys, *active_builtin_selects}
    # Keep unknown keys from previous/body for forward-compat, but drop lists for
    # removed custom fields (no longer in select_keys and not builtin).
    # Also retain option catalogs for builtins that left select (hidden until retyped).
    carry_keys = set()
    for source in (prev_lists, body_lists):
        for key in source:
            if isinstance(key, str) and key and key not in wanted_keys:
                if key.startswith("cf_"):
                    continue
                carry_keys.add(key)

    result: dict[str, list[str]] = {}

    for key in BUILTIN_SELECT_FIELD_KEYS:
        raw = None
        if key in body_lists:
            raw = body_lists.get(key)
        elif key == MATERIAL_FIELD_KEY and "materialTypes" in doc:
            raw = doc.get("materialTypes")
        elif key in prev_lists:
            raw = prev_lists.get(key)
        elif key == MATERIAL_FIELD_KEY and "materialTypes" in previous:
            raw = previous.get("materialTypes")
        else:
            raw = default_lists.get(key) or []
        # Traditional builtin selects keep a non-empty catalog even when the
        # card field is temporarily typed as text (options stay for later).
        result[key] = _validate_option_list(
            raw,
            what=f"{key} options",
            require_nonempty=True,
        )

    # Builtins that became select but are not in the day-one select set.
    for key in sorted(active_builtin_selects - set(BUILTIN_SELECT_FIELD_KEYS)):
        raw = None
        if key in body_lists:
            raw = body_lists.get(key)
        elif key in prev_lists:
            raw = prev_lists.get(key)
        else:
            raw = []
        result[key] = _validate_option_list(
            raw,
            what=f"{key} options",
            require_nonempty=False,
        )

    custom_by_key = {f["key"]: f for f in custom_fields}
    for key in select_keys:
        raw = None
        if key in body_lists:
            raw = body_lists.get(key)
        elif key in custom_by_key and custom_by_key[key].get("options") is not None:
            raw = custom_by_key[key].get("options")
        elif key in prev_lists:
            raw = prev_lists.get(key)
        else:
            raw = []
        result[key] = _validate_option_list(
            raw,
            what=f"Select field {key} options",
            require_nonempty=False,
        )

    for key in sorted(carry_keys):
        raw = body_lists.get(key, prev_lists.get(key))
        try:
            result[key] = _validate_option_list(
                raw if raw is not None else [],
                what=f"Selection list {key}",
                require_nonempty=False,
            )
        except HTTPException:
            continue

    return result


def selection_lists(doc: dict[str, Any] | None = None, db: Session | None = None) -> dict[str, list[str]]:
    """Published select-option catalogs keyed by field key."""
    if doc is None:
        if db is None:
            return default_selection_lists()
        doc = get_document(db)
    if not isinstance(doc, dict):
        return default_selection_lists()

    raw = doc.get("selectionLists")
    out: dict[str, list[str]] = {}
    if isinstance(raw, dict):
        for key, value in raw.items():
            if isinstance(key, str) and key:
                cleaned = _normalize_option_list(value)
                if cleaned or key not in BUILTIN_SELECT_FIELD_KEYS:
                    out[key] = cleaned

    seeds = default_selection_lists()
    for key in BUILTIN_SELECT_FIELD_KEYS:
        if out.get(key):
            continue
        if key == MATERIAL_FIELD_KEY:
            legacy = _normalize_option_list(doc.get("materialTypes"))
            out[key] = legacy or list(seeds[key])
        else:
            out[key] = list(seeds[key])

    # Prefer options embedded on custom select fields when lists lack them.
    for item in doc.get("customFields") or []:
        if not isinstance(item, dict):
            continue
        if str(item.get("type") or "") != "select":
            continue
        key = str(item.get("key") or "")
        if not key:
            continue
        if not out.get(key):
            out[key] = _normalize_option_list(item.get("options"))

    return out


def field_options(
    doc: dict[str, Any] | None = None,
    field_key: str = MATERIAL_FIELD_KEY,
    *,
    db: Session | None = None,
) -> list[str]:
    """Options for a select field (builtin or custom)."""
    lists = selection_lists(doc=doc, db=db)
    return list(lists.get(field_key) or [])


def material_types(doc: dict[str, Any] | None = None, db: Session | None = None) -> list[str]:
    """Published material catalog; falls back to defaults when empty."""
    return field_options(doc, MATERIAL_FIELD_KEY, db=db)


def priority_label_for(doc: dict[str, Any], key: Any) -> str:
    """Display label for a priority value from selectionLists (fallback PRIORITY_META)."""
    text = str(key or "").strip()
    if not text:
        return "NORMAL"
    for opt in field_options(doc, PRIORITY_FIELD_KEY):
        if opt.casefold() == text.casefold():
            return opt.upper() if opt == opt.lower() else opt
    from .models import PRIORITY_META, Priority

    try:
        return PRIORITY_META[Priority(text.casefold())]["label"]
    except (KeyError, ValueError):
        return text.replace("_", " ").upper()


def priority_tone_for(key: Any) -> str:
    """Legacy tone name for a priority key (used by PriorityTag CSS vars)."""
    from .models import PRIORITY_META, Priority

    text = str(key or "").strip().casefold()
    try:
        return PRIORITY_META[Priority(text)]["tone"]
    except (KeyError, ValueError):
        return "slate"


def priorities_for_meta(doc: dict[str, Any]) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for opt in field_options(doc, PRIORITY_FIELD_KEY):
        out.append(
            {
                "value": opt.casefold(),
                "label": opt.upper() if opt == opt.lower() else opt,
                "tone": priority_tone_for(opt),
            }
        )
    return out


def inspections_for_meta(doc: dict[str, Any]) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for opt in field_options(doc, INSPECTION_FIELD_KEY):
        out.append(
            {
                "value": opt.casefold(),
                "label": opt.upper() if opt == opt.lower() else opt,
            }
        )
    return out


def assert_known_material(db: Session, material: str | None) -> None:
    """Refuse non-empty materials that are not on the Admin-controlled list."""
    assert_known_select_value(db, MATERIAL_FIELD_KEY, material, what="material")


def assert_known_inspection(db: Session, inspection: str | None) -> None:
    if inspection is None:
        return
    text = str(inspection).strip()
    if not text:
        return
    assert_known_select_value(db, INSPECTION_FIELD_KEY, text.casefold(), what="inspection")


def assert_known_priority(db: Session, priority: str | None) -> None:
    if priority is None:
        return
    text = str(priority).strip()
    if not text:
        return
    assert_known_select_value(db, PRIORITY_FIELD_KEY, text.casefold(), what="priority")


def assert_known_select_value(
    db: Session,
    field_key: str,
    value: Any,
    *,
    what: str | None = None,
) -> None:
    """Refuse non-empty select values that are not in that field's options list."""
    if value is None:
        return
    text = str(value).strip()
    if not text:
        return
    label = what or field_key
    allowed = {m.casefold(): m for m in field_options(db=db, field_key=field_key)}
    if text.casefold() not in allowed:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"Unknown {label} {text!r}. Pick one from board settings options.",
        )


def assert_known_custom_selects(db: Session, custom_fields: dict[str, Any] | None) -> None:
    """Validate custom select values against published options (empty/null allowed)."""
    if not custom_fields or not isinstance(custom_fields, dict):
        return
    doc = get_document(db)
    meta_by_key = {
        str(f["key"]): f
        for f in (doc.get("customFields") or [])
        if isinstance(f, dict) and f.get("key")
    }
    for key, value in custom_fields.items():
        meta = meta_by_key.get(str(key))
        if not meta or str(meta.get("type") or "") != "select":
            continue
        assert_known_select_value(db, str(key), value, what=str(meta.get("label") or key))


def _assert_options_not_in_use(
    db: Session,
    *,
    field_key: str,
    previous_options: list[str],
    next_options: list[str],
    what: str,
) -> None:
    """Block removing an option that is still referenced by purchase orders."""
    prev = {o.casefold(): o for o in previous_options if str(o).strip()}
    nxt = {o.casefold() for o in next_options if str(o).strip()}
    removed = {k: v for k, v in prev.items() if k not in nxt}
    if not removed:
        return
    counts = _option_usage(db, field_key, set(removed.keys()))
    blockers = {removed[k]: n for k, n in counts.items() if n > 0 and k in removed}
    if not blockers:
        return
    parts = [f"{label} ({n})" for label, n in sorted(blockers.items())]
    raise HTTPException(
        status.HTTP_400_BAD_REQUEST,
        f"Cannot remove {what} option still in use: " + ", ".join(parts),
    )


def _hardware_truthy(option: str) -> bool:
    return option.casefold() in {"yes", "y", "true", "1"}


def _option_usage(db: Session, field_key: str, values_cf: set[str]) -> dict[str, int]:
    """Return {casefold_value: count} for POs using any of the given option values."""
    if not values_cf:
        return {}
    counts: dict[str, int] = {v: 0 for v in values_cf}

    if field_key == MATERIAL_FIELD_KEY:
        rows = db.scalars(select(PurchaseOrder.material)).all()
        for raw in rows:
            if raw is None:
                continue
            key = str(raw).strip().casefold()
            if key in counts:
                counts[key] += 1
        return counts

    if field_key == INSPECTION_FIELD_KEY:
        rows = db.scalars(select(PurchaseOrder.inspection)).all()
        for raw in rows:
            key = (
                raw.value if hasattr(raw, "value") else str(raw)
            ).strip().casefold()
            if key in counts:
                counts[key] += 1
        return counts

    if field_key == PRIORITY_FIELD_KEY:
        rows = db.scalars(select(PurchaseOrder.priority)).all()
        for raw in rows:
            key = (
                raw.value if hasattr(raw, "value") else str(raw)
            ).strip().casefold()
            if key in counts:
                counts[key] += 1
        return counts

    if field_key == HARDWARE_FIELD_KEY:
        # Options are yes/no-style; map to boolean column.
        want_true = any(_hardware_truthy(v) for v in values_cf)
        want_false = any(not _hardware_truthy(v) for v in values_cf)
        if want_true:
            n = db.scalar(
                select(func.count()).select_from(PurchaseOrder).where(PurchaseOrder.hardware.is_(True))
            )
            for v in values_cf:
                if _hardware_truthy(v):
                    counts[v] = int(n or 0)
        if want_false:
            n = db.scalar(
                select(func.count()).select_from(PurchaseOrder).where(PurchaseOrder.hardware.is_(False))
            )
            for v in values_cf:
                if not _hardware_truthy(v):
                    counts[v] = int(n or 0)
        return counts

    # Custom select: scan custom_fields JSON.
    rows = db.scalars(select(PurchaseOrder.custom_fields)).all()
    for raw in rows:
        if not isinstance(raw, dict):
            continue
        val = raw.get(field_key)
        if val is None or val == "":
            continue
        key = str(val).strip().casefold()
        if key in counts:
            counts[key] += 1
    return counts


def _status_usage(db: Session, keys: set[str]) -> dict[str, int]:
    if not keys:
        return {}
    rows = db.execute(
        select(PurchaseOrder.status, func.count())
        .where(PurchaseOrder.status.in_(list(keys)))
        .group_by(PurchaseOrder.status)
    ).all()
    return {str(status_key): int(count) for status_key, count in rows}


def save_document(db: Session, document: dict[str, Any], actor: User) -> BoardSettings:
    previous = get_document(db)
    normalised = validate_document(document, db=db, previous=previous)
    row = ensure_row(db)
    row.document = normalised
    row.version = int(normalised.get("version") or DOCUMENT_VERSION)
    row.updated_at = _now()
    row.updated_by_id = actor.id
    db.commit()
    db.refresh(row)
    return row


def document_out(row: BoardSettings) -> dict[str, Any]:
    doc = _as_dict(row)
    return {
        "version": row.version,
        "updated_at": row.updated_at,
        "updated_by_id": row.updated_by_id,
        "document": doc,
    }
