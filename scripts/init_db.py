"""Create all tables and the four built-in profiles. Run once: python -m scripts.init_db"""
from app.config import Config
from app.database import make_session_factory
from app.entity import Base, Profile

if __name__ == "__main__":
    Session, engine = make_session_factory(Config.DATABASE_URL)
    Base.metadata.create_all(engine)
    with Session() as s:
        Profile.seed_defaults(s)
    print("Database ready.")
