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
    ALLOWED_TONES,
    BUILTIN_CARD_KEYS,
    BUILTIN_DASHBOARD_KEYS,
    DOCUMENT_VERSION,
    clone_default,
)
from .models import BoardSettings, PurchaseOrder, User, _now

_KEY_RE = re.compile(r"^[a-z][a-z0-9_]{0,39}$")


def _as_dict(row: BoardSettings | None) -> dict[str, Any]:
    if row is None or not isinstance(row.document, dict):
        return clone_default()
    return deepcopy(row.document)


def ensure_row(db: Session) -> BoardSettings:
    """Return the singleton settings row, seeding defaults on first use."""
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
    return row


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
    if meta and meta.get("tone") in ALLOWED_TONES:
        return str(meta["tone"])
    return "slate"


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
    return [
        {"value": s["key"], "label": s["label"], "tone": s.get("tone", "slate")}
        for s in doc.get("statuses", [])
    ]


def stages_for_meta(doc: dict[str, Any]) -> list[dict[str, Any]]:
    """Project kanban columns into the legacy StageMeta shape for /api/meta/stages."""
    return [
        {
            "value": col["key"],
            "label": col["label"],
            "tone": col.get("tone", "slate"),
            "statuses": list(col.get("statusKeys") or []),
        }
        for col in doc.get("kanbanColumns", [])
    ]


def apply_po_overlays(db: Session, pos: list[PurchaseOrder]) -> None:
    """Attach status_label / stage from the published board settings."""
    if not pos:
        return
    doc = get_document(db)
    for po in pos:
        key = po.status if isinstance(po.status, str) else getattr(po.status, "value", str(po.status))
        po._status_label = status_label(doc, key)  # type: ignore[attr-defined]
        col = column_for_status(doc, key)
        po._stage = col or "pending"  # type: ignore[attr-defined]


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
            options = item.get("options") or []
            if not isinstance(options, list) or not options:
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST,
                    f"Select field {key} needs a non-empty options list",
                )
            entry["options"] = [str(o).strip() for o in options if str(o).strip()]
            if not entry["options"]:
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST,
                    f"Select field {key} needs a non-empty options list",
                )
        custom_fields.append(entry)
        custom_keys.add(key)
    out["customFields"] = custom_fields

    # ----- card fields -----
    card_raw = doc.get("cardFields", [])
    if not isinstance(card_raw, list) or not card_raw:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "cardFields must be a non-empty list")
    card_fields: list[dict[str, Any]] = []
    seen_card: set[str] = set()
    for item in card_raw:
        if not isinstance(item, dict):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Each card field must be an object")
        key = str(item.get("key") or "")
        kind = str(item.get("kind") or ("custom" if key in custom_keys else "builtin"))
        if kind == "builtin":
            if key not in BUILTIN_CARD_KEYS:
                raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Unknown builtin card field: {key}")
            label = next(f["label"] for f in out["cardFields"] if f["key"] == key)
        else:
            if key not in custom_keys:
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST,
                    f"Card field {key} is not in customFields",
                )
            label = next(f["label"] for f in custom_fields if f["key"] == key)
            kind = "custom"
        if key in seen_card:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Duplicate card field: {key}")
        seen_card.add(key)
        card_fields.append(
            {
                "key": key,
                "kind": kind,
                "label": label,
                "visible": bool(item.get("visible", True)),
            }
        )
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
            label = next(f["label"] for f in out["cardFields"] if f["key"] == bk)
            card_fields.append(
                {"key": bk, "kind": "builtin", "label": label, "visible": False}
            )
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
        tone = str(item.get("tone") or "slate")
        if tone not in ALLOWED_TONES:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                f"Status {key} tone must be one of {sorted(ALLOWED_TONES)}",
            )
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
    dash_cols: list[dict[str, Any]] = []
    seen_dash: set[str] = set()
    for item in dash_raw:
        if not isinstance(item, dict):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Each dashboard column must be an object")
        key = str(item.get("key") or "")
        if key not in BUILTIN_DASHBOARD_KEYS:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Unknown dashboard column: {key}")
        if key in seen_dash:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Duplicate dashboard column: {key}")
        label = next(c["label"] for c in out["dashboardColumns"] if c["key"] == key)
        dash_cols.append({"key": key, "label": label, "visible": bool(item.get("visible", True))})
        seen_dash.add(key)
    for dk in BUILTIN_DASHBOARD_KEYS:
        if dk not in seen_dash:
            label = next(c["label"] for c in out["dashboardColumns"] if c["key"] == dk)
            dash_cols.append({"key": dk, "label": label, "visible": False})
    # Job column stays visible — primary identifier.
    for dc in dash_cols:
        if dc["key"] == "job":
            dc["visible"] = True
    out["dashboardColumns"] = dash_cols

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
        tone = str(item.get("tone") or "slate")
        if tone not in ALLOWED_TONES:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                f"Kanban column {key} tone must be one of {sorted(ALLOWED_TONES)}",
            )
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
    return out


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
