from collections.abc import Iterator
from datetime import datetime, timezone

from sqlalchemy import DateTime, create_engine
from sqlalchemy.engine import Dialect
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker
from sqlalchemy.types import TypeDecorator

from .config import settings

connect_args = {"check_same_thread": False} if settings.database_url.startswith("sqlite") else {}

engine = create_engine(settings.database_url, connect_args=connect_args, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


class UtcDateTime(TypeDecorator[datetime]):
    """A DateTime that always hands Python back an aware, UTC instant.

    Every write in this app already goes through `datetime.now(timezone.utc)`
    and every column is declared `timezone=True`, so the stored values really
    are UTC. SQLite has no timezone-aware type, though, so it returns them
    naive -- and a naive datetime serialises to JSON without an offset, which
    `new Date(...)` in a browser then reads as *local* time. On this machine
    that made the activity trail seven hours out and "just now" for anything
    from the last several hours.

    Normalising here, rather than at each place a timestamp is rendered, is what
    makes the whole class of bug go away: every reader of the database gets an
    unambiguous instant, including code written later that never hears about
    this. It is a no-op on Postgres, which keeps the offset itself.
    """

    impl = DateTime
    cache_ok = True

    def process_bind_param(self, value: datetime | None, dialect: Dialect) -> datetime | None:
        # One convention going in: UTC. A naive value is taken at its word,
        # which is the convention every writer here already follows.
        if value is None or value.tzinfo is None:
            return value
        return value.astimezone(timezone.utc)

    def process_result_value(self, value: datetime | None, dialect: Dialect) -> datetime | None:
        if value is None or value.tzinfo is not None:
            return value
        return value.replace(tzinfo=timezone.utc)


class Base(DeclarativeBase):
    # `Mapped[datetime]` anywhere in the models resolves to the UTC-stamping type
    # above, so a column added later is unambiguous without being told to be.
    # `Mapped[date]` is deliberately untouched: a due date has no time of day and
    # must not acquire an offset that could shift it across midnight.
    type_annotation_map = {datetime: UtcDateTime(timezone=True)}


def get_db() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
