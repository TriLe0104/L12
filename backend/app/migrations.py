"""Tiny additive migrations so an existing database picks up new columns.

`Base.metadata.create_all` only creates missing *tables*, so a column added to a
model after the fact needs an ALTER. Keep entries here append-only; anything more
involved than adding a nullable/defaulted column should move to Alembic.

New tables (e.g. `po_comments`) are created by `create_all` in the app lifespan —
no ADDED_COLUMNS entry is needed for them. This module stays column-oriented.
"""

from __future__ import annotations

from sqlalchemy import inspect, text
from sqlalchemy.engine import Engine

# NOTE: Role still uses Enum(..., native_enum=False) which persists member
# *names* ("MANAGER"). Priority / inspection are plain lowercase strings now
# (`hot`, `standard`); see REPAIRS below.
ADDED_COLUMNS: dict[str, dict[str, str]] = {
    "purchase_orders": {
        "priority": "VARCHAR(20) NOT NULL DEFAULT 'normal'",
        # SQLite has no boolean type; `hardware` is a BOOLEAN column holding 0/1
        "locked": "BOOLEAN NOT NULL DEFAULT 0",
        # the 3D model slot, alongside `thumbnail_url` rather than replacing it.
        # Plain nullable columns, so no enum-name caveat applies to these three.
        "model_url": "VARCHAR(1000)",
        "model_filename": "VARCHAR(255)",
        "model_size": "INTEGER",
        # Admin-defined attributes; JSON object keyed by custom field key.
        "custom_fields": "JSON",
        # Editable traveler packet field overrides (nullable JSON object).
        "traveler_draft": "JSON",
    },
    "users": {
        "avatar_url": "VARCHAR(1000)",
    },
}

# Absolute object-storage URLs outgrow the original 500-char columns. Postgres
# enforces the length; SQLite ignores it. Idempotent ALTER on every boot.
WIDENED_COLUMNS: list[tuple[str, str, str]] = [
    ("users", "avatar_url", "VARCHAR(1000)"),
    ("purchase_orders", "thumbnail_url", "VARCHAR(1000)"),
    ("purchase_orders", "model_url", "VARCHAR(1000)"),
]

# Idempotent data repairs applied after the column work.
REPAIRS: list[str] = [
    # Priority / inspection are lowercase wire values (`hot`, `standard`). Older
    # Enum(..., native_enum=False) rows stored member NAMES (`NORMAL`, `STANDARD`).
    "UPDATE purchase_orders SET priority = LOWER(priority) WHERE priority <> LOWER(priority)",
    "UPDATE purchase_orders SET inspection = LOWER(inspection) WHERE inspection <> LOWER(inspection)",
    # Role hierarchy change (Admin > Manager > User > Viewer): the retired `pjm` and
    # `pm` rungs both collapse into `manager`. Rows still holding the old strings
    # would fail to deserialize into the new enum, so this has to run before the app
    # reads a user -- it does, from the lifespan hook. Upper case per the note above.
    "UPDATE users SET role = UPPER(role) WHERE role <> UPPER(role)",
    "UPDATE users SET role = 'MANAGER' WHERE role IN ('PJM', 'PM')",
    # Board settings stores status as lowercase keys (`need_material_size`). The old
    # Enum column persisted member NAMES (`NEW`); normalise so both shapes keep working.
    "UPDATE purchase_orders SET status = LOWER(status) WHERE status <> LOWER(status)",
    # v2 shop-floor catalog — rewrite retired keys before board_settings validation
    # can refuse to drop them. Idempotent; Python repair in board_service covers
    # aliases / case the SQL misses.
    "UPDATE purchase_orders SET status = 'need_material_size' WHERE status IN ('new')",
    "UPDATE purchase_orders SET status = 'order_material' WHERE status IN ('rfq_finishing')",
    "UPDATE purchase_orders SET status = 'material_incoming' WHERE status IN ('await_material')",
    "UPDATE purchase_orders SET status = 'waiting_setup' WHERE status IN ('on_hold')",
    "UPDATE purchase_orders SET status = 'running' WHERE status IN ('in_machining')",
    "UPDATE purchase_orders SET status = 'deburr' WHERE status IN ('finishing')",
    "UPDATE purchase_orders SET status = 'inspection' WHERE status IN ('under_inspection')",
    "UPDATE purchase_orders SET status = 'ready_to_plate' WHERE status IN ('wait_vqc')",
    "UPDATE purchase_orders SET status = 'ready_to_ship' WHERE status IN ('shipped')",
]


def run(engine: Engine) -> list[str]:
    applied: list[str] = []
    inspector = inspect(engine)
    existing_tables = set(inspector.get_table_names())

    with engine.begin() as conn:
        for table, columns in ADDED_COLUMNS.items():
            if table not in existing_tables:
                continue
            present = {c["name"] for c in inspector.get_columns(table)}
            for column, ddl in columns.items():
                if column in present:
                    continue
                conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}"))
                applied.append(f"{table}.{column}")

        if engine.dialect.name == "postgresql":
            for table, column, ddl in WIDENED_COLUMNS:
                if table not in existing_tables:
                    continue
                cols = {c["name"]: c for c in inspector.get_columns(table)}
                col = cols.get(column)
                if not col:
                    continue
                # SQLAlchemy reports VARCHAR length; skip when already wide enough.
                length = getattr(col.get("type"), "length", None)
                if isinstance(length, int) and length >= 1000:
                    continue
                conn.execute(
                    text(f"ALTER TABLE {table} ALTER COLUMN {column} TYPE {ddl}")
                )
                applied.append(f"widened {table}.{column}")

        for statement in REPAIRS:
            result = conn.execute(text(statement))
            if result.rowcount:
                applied.append(f"repaired {result.rowcount} row(s)")

    return applied
