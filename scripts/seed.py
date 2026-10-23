"""Generate test data (100+ users per role). Run: python -m scripts.seed"""
import os

from faker import Faker

from app.config import Config
from app.database import make_session_factory
from app.entity import Base, Profile, UserAccount

fake = Faker()


def seed(session, customers=120, designers=105, password=None):
    password = password or os.getenv("SEED_PASSWORD", "Password123!")
    Profile.seed_defaults(session)
    plan = [("User Admin", 2), ("Platform Management", 3), ("Customer", customers), ("Interior Designer", designers)]
    made = 0
    for profile_name, count in plan:
        profile = Profile.get_by_name(session, profile_name)
        for i in range(count):
            email = f"{profile_name.lower().replace(' ', '')}{i + 1}@example.com"
            if UserAccount.find_by_email(session, email):
                continue
            UserAccount.create(session, fake.name(), email, password, profile)
            made += 1
    session.commit()
    return made


if __name__ == "__main__":
    Session, engine = make_session_factory(Config.DATABASE_URL)
    Base.metadata.create_all(engine)
    with Session() as s:
        print("Created", seed(s), "users. Admin login: useradmin1@example.com")
