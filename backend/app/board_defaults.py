"""Default board settings document — mirrors today's hard-coded board.

Seeded into `board_settings` on first GET/PUT so day-one behaviour matches the
previous STATUS_META / STAGE_BY_STATUS / card layout without an Admin visit.
"""

from __future__ import annotations

import re
from copy import deepcopy
from typing import Any

from .models import (
    STAGE_BY_STATUS,
    STAGE_DEFAULT_STATUS,
    STAGE_META,
    STATUS_META,
    POStatus,
    Stage,
)

# Default wire type per builtin. Admin may rename any field; type changes are
# limited per key so PO columns stay coherent (see BUILTIN_ALLOWED_TYPES).
BUILTIN_DEFAULT_TYPES: dict[str, str] = {
    "po_number": "text",
    "part_number": "text",
    "qty": "number",
    "dims": "text",
    "mat_dim": "text",
    "material": "select",
    "finish": "text",
    "inspection": "select",
    "hardware": "select",
    "priority": "select",
    "customer": "text",
    # Owner keeps the assignee picker in the UI; type is locked to text.
    "owner": "text",
}

# Safe type transitions. Identity keys stay text; hardware stays select (bool
# column); owner is locked. Everything else may move among the listed types
# while still writing the same PO column / selectionLists key.
BUILTIN_ALLOWED_TYPES: dict[str, frozenset[str]] = {
    "po_number": frozenset({"text"}),
    "part_number": frozenset({"text"}),
    "qty": frozenset({"number", "text", "select"}),
    "dims": frozenset({"text", "number", "select", "date"}),
    "mat_dim": frozenset({"text", "number", "select", "date"}),
    "material": frozenset({"select", "text"}),
    "finish": frozenset({"text", "select", "number", "date"}),
    "inspection": frozenset({"select", "text"}),
    "hardware": frozenset({"select"}),
    "priority": frozenset({"select", "text"}),
    "customer": frozenset({"text", "select", "number", "date"}),
    "owner": frozenset({"text"}),
}

# Built-in card fields shown on JobCard / CardEditor (order = display order).
# Customer/owner stay in the catalog so Settings can reveal them on the card
# grid; the header still always shows job number + due date. Priority is
# visible by default so urgency is editable (CardEditor and JobCard share
# the same `visible` flag).
BUILTIN_CARD_FIELDS: list[dict[str, Any]] = [
    {"key": "po_number", "kind": "builtin", "label": "PO #", "visible": True, "type": "text"},
    {"key": "part_number", "kind": "builtin", "label": "Part #", "visible": True, "type": "text"},
    {"key": "qty", "kind": "builtin", "label": "Qty", "visible": True, "type": "number"},
    {"key": "dims", "kind": "builtin", "label": "Dims", "visible": True, "type": "text"},
    {"key": "mat_dim", "kind": "builtin", "label": "Mat Dim", "visible": True, "type": "text"},
    {"key": "material", "kind": "builtin", "label": "Material", "visible": True, "type": "select"},
    {"key": "finish", "kind": "builtin", "label": "Finish", "visible": True, "type": "text"},
    {"key": "inspection", "kind": "builtin", "label": "Inspection", "visible": True, "type": "select"},
    {"key": "hardware", "kind": "builtin", "label": "Hardware", "visible": True, "type": "select"},
    {"key": "priority", "kind": "builtin", "label": "Priority", "visible": True, "type": "select"},
    {"key": "customer", "kind": "builtin", "label": "Customer", "visible": True, "type": "text"},
    {"key": "owner", "kind": "builtin", "label": "Owner", "visible": True, "type": "text"},
]

# Keys visible on day-one JobCard / CardEditor (customer/owner stay hidden).
JOBCARD_VISIBLE_DEFAULT = {
    "po_number",
    "part_number",
    "qty",
    "dims",
    "mat_dim",
    "material",
    "finish",
    "inspection",
    "hardware",
    "priority",
}

BUILTIN_CARD_KEYS = {f["key"] for f in BUILTIN_CARD_FIELDS}

# Rem widths matching frontend/app/(app)/dashboard/dashboard.css tracks.
# None = auto / flex share (open-ended material & finish columns).
DEFAULT_DASHBOARD_WIDTH_REM: dict[str, float | None] = {
    "job": 4.3,
    "po_number": 4.8,
    "customer": 5.7,
    "priority": 5.4,
    "stage": 6.7,
    "status": 8.75,
    "owner": 5.0,
    "material": None,
    "finish": None,
    "due": 4.3,
    "modified": 5.4,
    "comments": 2.35,
    "qty": 3.75,
    # Optional builtins — hidden until Admin enables them.
    "part_number": 4.8,
    "dims": 6.0,
    "mat_dim": 6.0,
    "inspection": 5.5,
    "hardware": 4.5,
}

# Dashboard table columns — visibility, order, optional widthRem, and filterable.
# Day-one visibles match the previous hard-coded table; extra builtins start hidden.
# filterable: stage/status/priority on by default; customer off; others not filter-capable.
BUILTIN_DASHBOARD_COLUMNS: list[dict[str, Any]] = [
    {"key": "job", "label": "Job", "visible": True, "widthRem": 4.3, "filterable": False},
    {"key": "po_number", "label": "PO #", "visible": True, "widthRem": 4.8, "filterable": False},
    {"key": "customer", "label": "Customer", "visible": True, "widthRem": 5.7, "filterable": False},
    {"key": "priority", "label": "Priority", "visible": True, "widthRem": 5.4, "filterable": True},
    {"key": "stage", "label": "Stage", "visible": True, "widthRem": 6.7, "filterable": True},
    {"key": "status", "label": "Status", "visible": True, "widthRem": 8.75, "filterable": True},
    {"key": "owner", "label": "Owner", "visible": True, "widthRem": 5.0, "filterable": False},
    {"key": "material", "label": "Material", "visible": True, "widthRem": None, "filterable": False},
    {"key": "finish", "label": "Finish", "visible": True, "widthRem": None, "filterable": False},
    {"key": "due", "label": "Due", "visible": True, "widthRem": 4.3, "filterable": False},
    {"key": "modified", "label": "Modified", "visible": True, "widthRem": 5.4, "filterable": False},
    {"key": "comments", "label": "Comments", "visible": True, "widthRem": 2.35, "filterable": False},
    {"key": "qty", "label": "Qty", "visible": True, "widthRem": 3.75, "filterable": False},
    {"key": "part_number", "label": "Part #", "visible": False, "widthRem": 4.8, "filterable": False},
    {"key": "dims", "label": "Dims", "visible": False, "widthRem": 6.0, "filterable": False},
    {"key": "mat_dim", "label": "Mat Dim", "visible": False, "widthRem": 6.0, "filterable": False},
    {"key": "inspection", "label": "Inspection", "visible": False, "widthRem": 5.5, "filterable": False},
    {"key": "hardware", "label": "Hardware", "visible": False, "widthRem": 4.5, "filterable": False},
]

BUILTIN_DASHBOARD_KEYS = {c["key"] for c in BUILTIN_DASHBOARD_COLUMNS}
BUILTIN_DASHBOARD_BY_KEY = {c["key"]: c for c in BUILTIN_DASHBOARD_COLUMNS}

# Columns that may appear as dashboard filter controls.
DASHBOARD_FILTER_KEYS = frozenset({"stage", "status", "priority", "customer"})
DEFAULT_FILTERABLE_KEYS = frozenset({"stage", "status", "priority"})


def default_dashboard_filterable(key: str) -> bool:
    return key in DEFAULT_FILTERABLE_KEYS


def can_filter_dashboard_column(key: str) -> bool:
    return key in DASHBOARD_FILTER_KEYS

# Legacy named tones (pre-color-picker). Still accepted on PUT and mapped to hex.
ALLOWED_TONES = frozenset(
    {
        "slate",
        "cyan",
        "blue",
        "teal",
        "amber",
        "red",
        "green",
        "graphite",
        "orange",
        "purple",
    }
)

# Hex values match frontend/app/globals.css --tone-* tokens (plus purple for the
# inspection / ready-to-plate stretch of the status flow).
TONE_HEX: dict[str, str] = {
    "slate": "#64748b",
    "cyan": "#0e7490",
    "blue": "#1d4ed8",
    "teal": "#0f766e",
    "amber": "#b45309",
    "red": "#c81e2b",
    "green": "#0b8457",
    "graphite": "#3f4b57",
    "orange": "#c2410c",
    "purple": "#6d28d9",
}
DEFAULT_TONE_HEX = TONE_HEX["slate"]

_HEX_RE = re.compile(r"^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$")

ALLOWED_CUSTOM_TYPES = frozenset({"text", "number", "date", "select"})

# Builtin card fields that render as selects / choice pickers. Options live in
# selectionLists[key]. Material also accepts a legacy materialTypes fallback.
MATERIAL_FIELD_KEY = "material"
INSPECTION_FIELD_KEY = "inspection"
HARDWARE_FIELD_KEY = "hardware"
PRIORITY_FIELD_KEY = "priority"

BUILTIN_SELECT_FIELD_KEYS: tuple[str, ...] = (
    MATERIAL_FIELD_KEY,
    INSPECTION_FIELD_KEY,
    HARDWARE_FIELD_KEY,
    PRIORITY_FIELD_KEY,
)

# Day-one seeds (wire values). Display casing is handled in the UI.
DEFAULT_INSPECTION_OPTIONS = ["formal", "standard", "source", "none"]
DEFAULT_HARDWARE_OPTIONS = ["no", "yes"]
DEFAULT_PRIORITY_OPTIONS = ["hot", "high", "normal", "low"]

# v2: shop-floor status catalog (need material → ready to ship).
# v3: materialTypes → selectionLists (options keyed by select field).
# v4: Priority card field visible by default (was historically hidden).
# v5: seed inspection / hardware / priority into selectionLists.
# v6: dashboardColumns.widthRem + sync custom/new builtin columns (hidden).
# v7: cardFields.type on builtins + Admin-editable builtin labels.
# v8: dashboardColumns.filterable (stage/status/priority on by default).
DOCUMENT_VERSION = 8


def default_selection_lists() -> dict[str, list[str]]:
    """Seed catalogs for every builtin select field."""
    from .material_types_default import DEFAULT_MATERIAL_TYPES

    return {
        MATERIAL_FIELD_KEY: list(DEFAULT_MATERIAL_TYPES),
        INSPECTION_FIELD_KEY: list(DEFAULT_INSPECTION_OPTIONS),
        HARDWARE_FIELD_KEY: list(DEFAULT_HARDWARE_OPTIONS),
        PRIORITY_FIELD_KEY: list(DEFAULT_PRIORITY_OPTIONS),
    }

# Retired day-one keys → current catalog. Includes enum member names and the
# pre-catalog aliases that still show up in older rows. `wait_vqc` was not in the
# user-facing rename list but sits between inspection and ship in the old flow,
# so it lands on `ready_to_plate`.
LEGACY_STATUS_MAP: dict[str, str] = {
    "new": "need_material_size",
    "rfq_finishing": "order_material",
    "await_material": "material_incoming",
    "on_hold": "waiting_setup",
    "in_machining": "running",
    "finishing": "deburr",
    "under_inspection": "inspection",
    "wait_vqc": "ready_to_plate",
    "ready_to_ship": "ready_to_ship",
    "shipped": "ready_to_ship",
    # Enum member names (pre-lowercase repair / case variants).
    "need_material_size": "need_material_size",
    "order_material": "order_material",
    "material_incoming": "material_incoming",
    "waiting_setup": "waiting_setup",
    "running": "running",
    "deburr": "deburr",
    "inspection": "inspection",
    "ready_to_plate": "ready_to_plate",
}

# Preferred legacy key when copying a custom colour onto its replacement.
STATUS_COLOR_SOURCES: dict[str, tuple[str, ...]] = {
    "need_material_size": ("need_material_size", "new"),
    "order_material": ("order_material", "rfq_finishing"),
    "material_incoming": ("material_incoming", "await_material"),
    "waiting_setup": ("waiting_setup", "on_hold"),
    "running": ("running", "in_machining"),
    "deburr": ("deburr", "finishing"),
    "inspection": ("inspection", "under_inspection"),
    "ready_to_plate": ("ready_to_plate", "wait_vqc"),
    "ready_to_ship": ("ready_to_ship", "shipped"),
}


def normalize_status_key(raw: Any) -> str:
    """Map a stored status (any case / legacy alias) onto the current catalog key.

    Unknown values fall back to `need_material_size` so no PO retains a retired key.
    """
    if raw is None:
        return POStatus.NEED_MATERIAL_SIZE.value
    text = str(raw).strip()
    if not text:
        return POStatus.NEED_MATERIAL_SIZE.value
    lowered = text.lower()
    if lowered in LEGACY_STATUS_MAP:
        return LEGACY_STATUS_MAP[lowered]
    # Enum-style NEW / IN_MACHINING already covered by lowercasing above when
    # member name matches value spelling; also accept underscored member forms.
    if text in LEGACY_STATUS_MAP:
        return LEGACY_STATUS_MAP[text]
    if lowered in BUILTIN_STATUS_KEYS:
        return lowered
    return POStatus.NEED_MATERIAL_SIZE.value


def normalize_tone(raw: Any, *, what: str = "Tone") -> str:
    """Accept #rgb / #rrggbb / #rrggbbaa or a legacy tone name; return lowercase hex.

    Raises ValueError with a plain-string message suitable for HTTP 400 detail.
    """
    if raw is None or (isinstance(raw, str) and not str(raw).strip()):
        return DEFAULT_TONE_HEX
    value = str(raw).strip()
    named = TONE_HEX.get(value.lower())
    if named:
        return named
    if _HEX_RE.match(value):
        body = value[1:]
        if len(body) == 3:
            body = "".join(c * 2 for c in body)
        return "#" + body.lower()
    raise ValueError(
        f"{what} must be a hex color (#rgb, #rrggbb, #rrggbbaa) or a known tone name"
    )


def default_statuses() -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for status, meta in STATUS_META.items():
        try:
            tone = normalize_tone(meta["tone"])
        except ValueError:
            tone = DEFAULT_TONE_HEX
        out.append({"key": status.value, "label": meta["label"], "tone": tone})
    return out


def default_kanban_columns() -> list[dict[str, Any]]:
    """Kanban columns in STAGE_META order; first statusKeys entry is the drag default."""
    kanban: list[dict[str, Any]] = []
    for stage, meta in STAGE_META.items():
        members = [s.value for s, st in STAGE_BY_STATUS.items() if st == stage]
        default = STAGE_DEFAULT_STATUS[stage].value
        if default in members:
            members = [default] + [m for m in members if m != default]
        try:
            tone = normalize_tone(meta["tone"])
        except ValueError:
            tone = DEFAULT_TONE_HEX
        kanban.append(
            {
                "key": stage.value,
                "label": meta["label"],
                "tone": tone,
                "statusKeys": members,
                "isCompleted": stage == Stage.COMPLETED,
            }
        )
    return kanban


def default_document() -> dict[str, Any]:
    """Board config that reproduces the day-one board with the current catalog."""
    card_fields = []
    for field in BUILTIN_CARD_FIELDS:
        entry = dict(field)
        # Customer/owner stay off the card grid by default; Priority is shown
        # so Managers can set urgency without an Admin Settings visit.
        if entry["key"] not in JOBCARD_VISIBLE_DEFAULT and entry["key"] in {
            "customer",
            "owner",
        }:
            entry["visible"] = False
        card_fields.append(entry)

    return {
        "version": DOCUMENT_VERSION,
        "cardFields": card_fields,
        "customFields": [],
        "statuses": default_statuses(),
        "dashboardColumns": [dict(c) for c in BUILTIN_DASHBOARD_COLUMNS],
        "kanbanColumns": default_kanban_columns(),
        # Select-field options keyed by field key (builtin selects + custom).
        "selectionLists": default_selection_lists(),
    }


def clone_default() -> dict[str, Any]:
    return deepcopy(default_document())


def _tone_from_legacy(
    old_by_key: dict[str, dict[str, Any]], new_key: str, fallback: str
) -> str:
    for src in STATUS_COLOR_SOURCES.get(new_key, (new_key,)):
        prev = old_by_key.get(src)
        if not prev:
            continue
        try:
            return normalize_tone(prev.get("tone"))
        except ValueError:
            continue
    return fallback


def _normalize_option_list(raw: Any) -> list[str]:
    """Trim, drop empties, casefold-dedupe; preserve first-seen casing/order."""
    if not isinstance(raw, list):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for item in raw:
        label = str(item or "").strip()
        if not label:
            continue
        key = label.casefold()
        if key in seen:
            continue
        seen.add(key)
        out.append(label)
    return out


def upgrade_selection_lists(doc: dict[str, Any]) -> dict[str, Any]:
    """Fold legacy materialTypes + seed builtin/custom select options into selectionLists.

    Idempotent: existing non-empty selectionLists entries win; otherwise copy from
    materialTypes / customFields.options / day-one defaults. Drops the top-level
    materialTypes key after a successful material migrate.
    """
    out = deepcopy(doc) if isinstance(doc, dict) else clone_default()
    lists_raw = out.get("selectionLists")
    lists: dict[str, list[str]] = {}
    if isinstance(lists_raw, dict):
        for key, value in lists_raw.items():
            if isinstance(key, str) and key:
                lists[key] = _normalize_option_list(value)

    seeds = default_selection_lists()

    # Material: prefer selectionLists, else materialTypes, else seed.
    material = lists.get(MATERIAL_FIELD_KEY) or []
    if not material:
        material = _normalize_option_list(out.get("materialTypes"))
    if not material:
        material = list(seeds[MATERIAL_FIELD_KEY])
    lists[MATERIAL_FIELD_KEY] = material

    # Other builtin selects: keep Admin edits; seed when missing/empty.
    for key in BUILTIN_SELECT_FIELD_KEYS:
        if key == MATERIAL_FIELD_KEY:
            continue
        existing = lists.get(key) or []
        if not existing:
            lists[key] = list(seeds[key])

    # Custom selects: keep field.options in sync with selectionLists[key].
    custom_fields = out.get("customFields")
    if isinstance(custom_fields, list):
        synced: list[dict[str, Any]] = []
        for item in custom_fields:
            if not isinstance(item, dict):
                continue
            entry = dict(item)
            if str(entry.get("type") or "") == "select":
                key = str(entry.get("key") or "")
                if key:
                    existing = lists.get(key) or []
                    if not existing:
                        existing = _normalize_option_list(entry.get("options"))
                    lists[key] = existing
                    entry["options"] = list(existing)
            synced.append(entry)
        out["customFields"] = synced

    out["selectionLists"] = lists
    out.pop("materialTypes", None)
    try:
        ver = int(out.get("version") or 0)
    except (TypeError, ValueError):
        ver = 0
    # Bump to at least v5 once all builtin selects are present.
    out["version"] = max(ver, 5)
    return out


def document_needs_selection_lists_upgrade(doc: dict[str, Any] | None) -> bool:
    """True when builtin select catalogs are missing or materialTypes still present."""
    if not isinstance(doc, dict):
        return True
    try:
        version = int(doc.get("version") or 0)
    except (TypeError, ValueError):
        version = 0
    if version < 5:
        return True
    lists = doc.get("selectionLists")
    if not isinstance(lists, dict):
        return True
    for key in BUILTIN_SELECT_FIELD_KEYS:
        raw = lists.get(key)
        if not isinstance(raw, list) or not raw:
            return True
    if "materialTypes" in doc:
        return True
    return False


def document_needs_priority_visible_upgrade(doc: dict[str, Any] | None) -> bool:
    """True when the published doc predates Priority-visible-by-default (v4)."""
    if not isinstance(doc, dict):
        return True
    try:
        version = int(doc.get("version") or 0)
    except (TypeError, ValueError):
        version = 0
    return version < 4


def apply_priority_card_visible(doc: dict[str, Any]) -> dict[str, Any]:
    """Show the Priority builtin on JobCard / CardEditor (v4 default).

    Idempotent: already-visible Priority is left alone; missing entry is appended.
    Does not change customer/owner. Bumps document version to at least 4 so Admin
    can later hide Priority without the repair re-forcing it.
    """
    out = deepcopy(doc) if isinstance(doc, dict) else clone_default()
    fields = out.get("cardFields")
    if not isinstance(fields, list):
        fields = []
        out["cardFields"] = fields
    found = False
    for item in fields:
        if isinstance(item, dict) and item.get("key") == "priority":
            item["visible"] = True
            item.setdefault("kind", "builtin")
            item.setdefault("label", "Priority")
            item.setdefault("type", BUILTIN_DEFAULT_TYPES["priority"])
            found = True
            break
    if not found:
        fields.append(
            {
                "key": "priority",
                "kind": "builtin",
                "label": "Priority",
                "visible": True,
                "type": BUILTIN_DEFAULT_TYPES["priority"],
            }
        )
    try:
        ver = int(out.get("version") or 0)
    except (TypeError, ValueError):
        ver = 0
    out["version"] = max(ver, 4)
    return out


def _parse_width_rem(raw: Any) -> float | None:
    """Normalize widthRem: number rem, or None for auto/flex."""
    if raw is None:
        return None
    if isinstance(raw, bool):
        return None
    if isinstance(raw, (int, float)):
        value = float(raw)
        if value <= 0:
            return None
        return round(value, 2)
    return None


def sync_dashboard_columns(doc: dict[str, Any]) -> list[dict[str, Any]]:
    """Merge dashboardColumns with builtins + customFields.

    - Preserve Admin order / visibility for known keys.
    - Fill missing widthRem from DEFAULT_DASHBOARD_WIDTH_REM (custom → None).
    - Append missing builtins and custom fields as **hidden**.
    - Drop columns for deleted custom fields (and unknown non-builtin keys).
    - Keep the Job column visible.
    - Preserve Admin-edited labels; fall back to cardFields / catalog / customFields.
    - Stamp `filterable` for filter-capable keys (defaults: stage/status/priority).
    """
    custom_raw = doc.get("customFields") if isinstance(doc.get("customFields"), list) else []
    custom_by_key: dict[str, dict[str, Any]] = {}
    for item in custom_raw:
        if isinstance(item, dict) and item.get("key"):
            custom_by_key[str(item["key"])] = item

    card_labels: dict[str, str] = {}
    card_raw = doc.get("cardFields") if isinstance(doc.get("cardFields"), list) else []
    for item in card_raw:
        if not isinstance(item, dict) or not item.get("key"):
            continue
        label = str(item.get("label") or "").strip()
        if label:
            card_labels[str(item["key"])] = label

    allowed = BUILTIN_DASHBOARD_KEYS | set(custom_by_key)
    raw_cols = doc.get("dashboardColumns") if isinstance(doc.get("dashboardColumns"), list) else []
    out: list[dict[str, Any]] = []
    seen: set[str] = set()

    for item in raw_cols:
        if not isinstance(item, dict):
            continue
        key = str(item.get("key") or "")
        if not key or key not in allowed or key in seen:
            continue
        stored = str(item.get("label") or "").strip()
        if key in BUILTIN_DASHBOARD_BY_KEY:
            label = stored or card_labels.get(key) or str(BUILTIN_DASHBOARD_BY_KEY[key]["label"])
        else:
            label = stored or str(custom_by_key[key].get("label") or key)
        width_present = "widthRem" in item
        width = (
            _parse_width_rem(item.get("widthRem"))
            if width_present
            else DEFAULT_DASHBOARD_WIDTH_REM.get(key)
        )
        visible = bool(item.get("visible", True))
        if key == "job":
            visible = True
        if can_filter_dashboard_column(key):
            filterable = (
                bool(item.get("filterable"))
                if "filterable" in item
                else default_dashboard_filterable(key)
            )
        else:
            filterable = False
        out.append(
            {
                "key": key,
                "label": label,
                "visible": visible,
                "widthRem": width,
                "filterable": filterable,
            }
        )
        seen.add(key)

    for entry in BUILTIN_DASHBOARD_COLUMNS:
        key = entry["key"]
        if key in seen:
            continue
        out.append(
            {
                "key": key,
                "label": card_labels.get(key) or entry["label"],
                "visible": False if key != "job" else True,
                "widthRem": entry.get("widthRem"),
                "filterable": bool(entry.get("filterable", default_dashboard_filterable(key))),
            }
        )
        seen.add(key)

    for key, cf in custom_by_key.items():
        if key in seen:
            continue
        out.append(
            {
                "key": key,
                "label": str(cf.get("label") or key),
                "visible": False,
                "widthRem": None,
                "filterable": False,
            }
        )
        seen.add(key)

    return out


def apply_dashboard_columns_upgrade(doc: dict[str, Any]) -> dict[str, Any]:
    """v6: widthRem defaults + discover custom/new builtin columns (hidden)."""
    out = deepcopy(doc) if isinstance(doc, dict) else clone_default()
    out["dashboardColumns"] = sync_dashboard_columns(out)
    try:
        ver = int(out.get("version") or 0)
    except (TypeError, ValueError):
        ver = 0
    out["version"] = max(ver, 6)
    return out


def document_needs_dashboard_columns_upgrade(doc: dict[str, Any] | None) -> bool:
    """True when widthRem / custom-column sync has not run (pre-v6) or is incomplete."""
    if not isinstance(doc, dict):
        return True
    try:
        version = int(doc.get("version") or 0)
    except (TypeError, ValueError):
        version = 0
    if version < 6:
        return True
    cols = doc.get("dashboardColumns")
    if not isinstance(cols, list) or not cols:
        return True
    by_key = {
        str(c.get("key")): c
        for c in cols
        if isinstance(c, dict) and c.get("key")
    }
    for key in BUILTIN_DASHBOARD_KEYS:
        if key not in by_key:
            return True
        if "widthRem" not in by_key[key]:
            return True
    custom = doc.get("customFields") if isinstance(doc.get("customFields"), list) else []
    for item in custom:
        if not isinstance(item, dict) or not item.get("key"):
            continue
        key = str(item["key"])
        if key not in by_key:
            return True
    return False


def apply_dashboard_filterable_upgrade(doc: dict[str, Any]) -> dict[str, Any]:
    """v8: stamp filterable on dashboard columns (stage/status/priority default on)."""
    out = deepcopy(doc) if isinstance(doc, dict) else clone_default()
    out["dashboardColumns"] = sync_dashboard_columns(out)
    try:
        ver = int(out.get("version") or 0)
    except (TypeError, ValueError):
        ver = 0
    out["version"] = max(ver, 8)
    return out


def document_needs_dashboard_filterable_upgrade(doc: dict[str, Any] | None) -> bool:
    """True when filter-capable dashboard columns lack a filterable flag (pre-v8)."""
    if not isinstance(doc, dict):
        return True
    try:
        version = int(doc.get("version") or 0)
    except (TypeError, ValueError):
        version = 0
    if version < 8:
        return True
    cols = doc.get("dashboardColumns")
    if not isinstance(cols, list) or not cols:
        return True
    by_key = {
        str(c.get("key")): c
        for c in cols
        if isinstance(c, dict) and c.get("key")
    }
    for key in DASHBOARD_FILTER_KEYS:
        col = by_key.get(key)
        if col is None:
            continue
        if "filterable" not in col:
            return True
    return False


def apply_card_field_types_upgrade(doc: dict[str, Any]) -> dict[str, Any]:
    """v7: stamp default `type` onto builtin cardFields; keep Admin labels."""
    out = deepcopy(doc) if isinstance(doc, dict) else clone_default()
    fields = out.get("cardFields")
    if isinstance(fields, list):
        for item in fields:
            if not isinstance(item, dict):
                continue
            key = str(item.get("key") or "")
            kind = str(item.get("kind") or ("builtin" if key in BUILTIN_CARD_KEYS else "custom"))
            if kind != "builtin" and key not in BUILTIN_CARD_KEYS:
                continue
            item.setdefault("kind", "builtin")
            default_type = BUILTIN_DEFAULT_TYPES.get(key, "text")
            allowed = BUILTIN_ALLOWED_TYPES.get(key, frozenset({"text"}))
            raw = item.get("type")
            ftype = str(raw) if raw is not None else default_type
            if ftype not in allowed:
                ftype = default_type
            item["type"] = ftype
            label = str(item.get("label") or "").strip()
            if not label:
                catalog = next((f for f in BUILTIN_CARD_FIELDS if f["key"] == key), None)
                item["label"] = catalog["label"] if catalog else key
    try:
        ver = int(out.get("version") or 0)
    except (TypeError, ValueError):
        ver = 0
    out["version"] = max(ver, 7)
    return out


def document_needs_card_field_types_upgrade(doc: dict[str, Any] | None) -> bool:
    """True when builtin cardFields lack a valid `type` (pre-v7)."""
    if not isinstance(doc, dict):
        return True
    try:
        version = int(doc.get("version") or 0)
    except (TypeError, ValueError):
        version = 0
    if version < 7:
        return True
    fields = doc.get("cardFields")
    if not isinstance(fields, list) or not fields:
        return True
    by_key = {
        str(f.get("key")): f
        for f in fields
        if isinstance(f, dict) and f.get("key")
    }
    for key in BUILTIN_CARD_KEYS:
        item = by_key.get(key)
        if not item:
            return True
        ftype = item.get("type")
        allowed = BUILTIN_ALLOWED_TYPES.get(key, frozenset({"text"}))
        if ftype is None or str(ftype) not in allowed:
            return True
    return False


def upgrade_document(doc: dict[str, Any]) -> dict[str, Any]:
    """Rewrite a stored board document onto the current catalog (v2–v7).

    Preserves card fields, custom fields, dashboard columns, kanban column order /
    labels / tones / isCompleted, selection lists (and any other forward keys), and
    mapped custom colours. Labels and statusKeys always follow the new catalog.
    v4 also reveals the Priority card field when upgrading from older defaults.
    v6 syncs dashboard column widths and custom/new builtin columns.
    v7 stamps builtin card field types (Admin may rename / safely retype).
    """
    if not isinstance(doc, dict):
        return clone_default()

    fresh = clone_default()
    out = deepcopy(doc)

    # Keep unrelated config; replace version / statuses / kanban membership.
    out["version"] = DOCUMENT_VERSION

    old_statuses = [
        s for s in (doc.get("statuses") or []) if isinstance(s, dict) and s.get("key")
    ]
    old_by_key = {str(s["key"]).lower(): s for s in old_statuses}

    new_statuses: list[dict[str, Any]] = []
    for entry in fresh["statuses"]:
        key = entry["key"]
        new_statuses.append(
            {
                "key": key,
                "label": entry["label"],
                "tone": _tone_from_legacy(old_by_key, key, entry["tone"]),
            }
        )
    out["statuses"] = new_statuses

    fresh_kanban_by_key = {c["key"]: c for c in fresh["kanbanColumns"]}
    old_kanban = [
        c for c in (doc.get("kanbanColumns") or []) if isinstance(c, dict) and c.get("key")
    ]

    if old_kanban:
        kanban: list[dict[str, Any]] = []
        seen: set[str] = set()
        for col in old_kanban:
            key = str(col["key"])
            template = fresh_kanban_by_key.get(key)
            if template is None:
                # Drop unknown columns; statuses must land in the four built-ins.
                continue
            try:
                tone = normalize_tone(col.get("tone"), what=f"Kanban {key} tone")
            except ValueError:
                tone = template["tone"]
            kanban.append(
                {
                    "key": key,
                    "label": str(col.get("label") or template["label"]),
                    "tone": tone,
                    "statusKeys": list(template["statusKeys"]),
                    "isCompleted": bool(col.get("isCompleted", template["isCompleted"])),
                }
            )
            seen.add(key)
        for key, template in fresh_kanban_by_key.items():
            if key not in seen:
                kanban.append(deepcopy(template))
        # Exactly one completed column — prefer the preserved flag, else defaults.
        completed = [c for c in kanban if c["isCompleted"]]
        if len(completed) != 1:
            for c in kanban:
                c["isCompleted"] = c["key"] == Stage.COMPLETED.value
        out["kanbanColumns"] = kanban
    else:
        out["kanbanColumns"] = deepcopy(fresh["kanbanColumns"])

    # Ensure required sections exist without wiping Admin customisations.
    if not isinstance(out.get("cardFields"), list) or not out["cardFields"]:
        out["cardFields"] = deepcopy(fresh["cardFields"])
    if not isinstance(out.get("customFields"), list):
        out["customFields"] = []
    if not isinstance(out.get("dashboardColumns"), list) or not out["dashboardColumns"]:
        out["dashboardColumns"] = deepcopy(fresh["dashboardColumns"])

    # v3: fold materialTypes into selectionLists (idempotent).
    out = upgrade_selection_lists(out)
    # v4: Priority visible by default (was historically hidden with customer/owner).
    out = apply_priority_card_visible(out)
    # v6: widthRem + custom/new builtin dashboard columns.
    out = apply_dashboard_columns_upgrade(out)
    # v7: builtin card field types.
    out = apply_card_field_types_upgrade(out)
    # v8: dashboard column filterable flags.
    out = apply_dashboard_filterable_upgrade(out)
    out["version"] = DOCUMENT_VERSION

    return out


def document_needs_status_upgrade(doc: dict[str, Any] | None) -> bool:
    """True when the published document still carries the pre-v2 status catalog.

    Admin may add custom statuses after upgrade — do not treat that as needing a
    rewrite. Only migrate when the document version is behind on statuses or a
    retired key is still present. Selection-list migration is gated separately.
    """
    if not isinstance(doc, dict):
        return True
    try:
        version = int(doc.get("version") or 0)
    except (TypeError, ValueError):
        version = 0
    # Status rewrite only when still on pre-v2 (or missing) catalog.
    if version < 2:
        return True
    keys = [
        str(s.get("key")).lower()
        for s in (doc.get("statuses") or [])
        if isinstance(s, dict) and s.get("key")
    ]
    if any(k in RETIRED_STATUS_KEYS for k in keys):
        return True
    return False


# Built-in status keys — current catalog.
BUILTIN_STATUS_KEYS = {s.value for s in POStatus}
BUILTIN_STAGE_KEYS = {s.value for s in Stage}

# Retired keys still recognised by normalize_status_key / repairs.
RETIRED_STATUS_KEYS = frozenset(LEGACY_STATUS_MAP) - BUILTIN_STATUS_KEYS
