from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


def make_session_factory(url: str, **engine_kwargs):
    """Works for Supabase (PostgreSQL) and for SQLite (used by the unit tests)."""
    engine = create_engine(url, pool_pre_ping=True, **engine_kwargs)
    return sessionmaker(bind=engine, expire_on_commit=False), engine
