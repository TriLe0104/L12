"""Tiny additive migrations so an existing database picks up new columns.

`Base.metadata.create_all` only creates missing *tables*, so a column added to a
model after the fact needs an ALTER. Keep entries here append-only; anything more
involved than adding a nullable/defaulted column should move to Alembic.
"""

from __future__ import annotations

from sqlalchemy import inspect, text
from sqlalchemy.engine import Engine

# NOTE: SQLAlchemy's Enum(..., native_enum=False) persists the member *name*
# ("NORMAL"), not its value ("normal"), so defaults here must be upper case.
ADDED_COLUMNS: dict[str, dict[str, str]] = {
    "purchase_orders": {
        "priority": "VARCHAR(20) NOT NULL DEFAULT 'NORMAL'",
        # SQLite has no boolean type; `hardware` is a BOOLEAN column holding 0/1
        "locked": "BOOLEAN NOT NULL DEFAULT 0",
        # the 3D model slot, alongside `thumbnail_url` rather than replacing it.
        # Plain nullable columns, so no enum-name caveat applies to these three.
        "model_url": "VARCHAR(500)",
        "model_filename": "VARCHAR(255)",
        "model_size": "INTEGER",
    },
    "users": {
        "avatar_url": "VARCHAR(500)",
    },
}

# Idempotent data repairs applied after the column work.
REPAIRS: list[str] = [
    "UPDATE purchase_orders SET priority = UPPER(priority) WHERE priority <> UPPER(priority)",
    # Role hierarchy change (Admin > Manager > User > Viewer): the retired `pjm` and
    # `pm` rungs both collapse into `manager`. Rows still holding the old strings
    # would fail to deserialize into the new enum, so this has to run before the app
    # reads a user -- it does, from the lifespan hook. Upper case per the note above.
    "UPDATE users SET role = UPPER(role) WHERE role <> UPPER(role)",
    "UPDATE users SET role = 'MANAGER' WHERE role IN ('PJM', 'PM')",
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

        for statement in REPAIRS:
            result = conn.execute(text(statement))
            if result.rowcount:
                applied.append(f"repaired {result.rowcount} row(s)")

    return applied
