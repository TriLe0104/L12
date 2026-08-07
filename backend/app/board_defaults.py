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

# Built-in card fields shown on JobCard / CardEditor (order = display order).
# Editor-only fields (priority, customer, owner) follow the same catalog so the
# settings UI can hide them from the card grid; the header still always shows
# job number + due date.
BUILTIN_CARD_FIELDS: list[dict[str, Any]] = [
    {"key": "po_number", "kind": "builtin", "label": "PO #", "visible": True},
    {"key": "part_number", "kind": "builtin", "label": "Part #", "visible": True},
    {"key": "qty", "kind": "builtin", "label": "Qty", "visible": True},
    {"key": "dims", "kind": "builtin", "label": "Dims", "visible": True},
    {"key": "mat_dim", "kind": "builtin", "label": "Mat Dim", "visible": True},
    {"key": "material", "kind": "builtin", "label": "Material", "visible": True},
    {"key": "finish", "kind": "builtin", "label": "Finish", "visible": True},
    {"key": "inspection", "kind": "builtin", "label": "Inspection", "visible": True},
    {"key": "hardware", "kind": "builtin", "label": "Hardware", "visible": True},
    {"key": "priority", "kind": "builtin", "label": "Priority", "visible": True},
    {"key": "customer", "kind": "builtin", "label": "Customer", "visible": True},
    {"key": "owner", "kind": "builtin", "label": "Owner", "visible": True},
]

# Keys that JobCard shows today (editor adds priority/customer/owner).
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
}

BUILTIN_CARD_KEYS = {f["key"] for f in BUILTIN_CARD_FIELDS}

# Dashboard table columns — visibility + order only; data still comes from PO.
BUILTIN_DASHBOARD_COLUMNS: list[dict[str, Any]] = [
    {"key": "job", "label": "Job", "visible": True},
    {"key": "po_number", "label": "PO #", "visible": True},
    {"key": "customer", "label": "Customer", "visible": True},
    {"key": "priority", "label": "Priority", "visible": True},
    {"key": "stage", "label": "Stage", "visible": True},
    {"key": "status", "label": "Status", "visible": True},
    {"key": "owner", "label": "Owner", "visible": True},
    {"key": "material", "label": "Material", "visible": True},
    {"key": "finish", "label": "Finish", "visible": True},
    {"key": "due", "label": "Due", "visible": True},
    {"key": "modified", "label": "Modified", "visible": True},
    {"key": "comments", "label": "Comments", "visible": True},
    {"key": "qty", "label": "Qty", "visible": True},
]

BUILTIN_DASHBOARD_KEYS = {c["key"] for c in BUILTIN_DASHBOARD_COLUMNS}

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

# v2: shop-floor status catalog (need material → ready to ship).
DOCUMENT_VERSION = 2

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
        # JobCard historically hid priority/customer/owner; keep that default.
        if entry["key"] not in JOBCARD_VISIBLE_DEFAULT and entry["key"] in {
            "priority",
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


def upgrade_document(doc: dict[str, Any]) -> dict[str, Any]:
    """Rewrite a stored board document onto the v2 status catalog.

    Preserves card fields, custom fields, dashboard columns, kanban column order /
    labels / tones / isCompleted, materialTypes (and any other forward keys), and
    mapped custom colours. Labels and statusKeys always follow the new catalog.
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

    return out


def document_needs_status_upgrade(doc: dict[str, Any] | None) -> bool:
    if not isinstance(doc, dict):
        return True
    try:
        version = int(doc.get("version") or 0)
    except (TypeError, ValueError):
        version = 0
    if version < DOCUMENT_VERSION:
        return True
    keys = [
        str(s.get("key"))
        for s in (doc.get("statuses") or [])
        if isinstance(s, dict) and s.get("key")
    ]
    expected = [s.value for s in POStatus]
    if keys != expected:
        return True
    return False


# Built-in status keys — current catalog.
BUILTIN_STATUS_KEYS = {s.value for s in POStatus}
BUILTIN_STAGE_KEYS = {s.value for s in Stage}

# Retired keys still recognised by normalize_status_key / repairs.
RETIRED_STATUS_KEYS = frozenset(LEGACY_STATUS_MAP) - BUILTIN_STATUS_KEYS
