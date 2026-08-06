"""Default board settings document — mirrors today's hard-coded board.

Seeded into `board_settings` on first GET/PUT so day-one behaviour matches the
previous STATUS_META / STAGE_BY_STATUS / card layout without an Admin visit.
"""

from __future__ import annotations

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

ALLOWED_TONES = frozenset(
    {"slate", "cyan", "blue", "teal", "amber", "red", "green", "graphite", "orange"}
)
ALLOWED_CUSTOM_TYPES = frozenset({"text", "number", "date", "select"})

DOCUMENT_VERSION = 1


def default_document() -> dict[str, Any]:
    """Board config that reproduces the pre-settings board."""
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

    statuses = [
        {"key": status.value, "label": meta["label"], "tone": meta["tone"]}
        for status, meta in STATUS_META.items()
    ]

    # Preserve STAGE_META iteration order, but put statuses in STAGE_DEFAULT
    # first within each column so drag-drop defaults match day one.
    kanban: list[dict[str, Any]] = []
    for stage, meta in STAGE_META.items():
        members = [s.value for s, st in STAGE_BY_STATUS.items() if st == stage]
        default = STAGE_DEFAULT_STATUS[stage].value
        if default in members:
            members = [default] + [m for m in members if m != default]
        kanban.append(
            {
                "key": stage.value,
                "label": meta["label"],
                "tone": meta["tone"],
                "statusKeys": members,
                "isCompleted": stage == Stage.COMPLETED,
            }
        )

    return {
        "version": DOCUMENT_VERSION,
        "cardFields": card_fields,
        "customFields": [],
        "statuses": statuses,
        "dashboardColumns": [dict(c) for c in BUILTIN_DASHBOARD_COLUMNS],
        "kanbanColumns": kanban,
    }


def clone_default() -> dict[str, Any]:
    return deepcopy(default_document())


# Built-in status keys that existed before settings — used for migration hints.
BUILTIN_STATUS_KEYS = {s.value for s in POStatus}
BUILTIN_STAGE_KEYS = {s.value for s in Stage}
