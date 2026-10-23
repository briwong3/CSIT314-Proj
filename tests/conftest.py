import pytest
from sqlalchemy.pool import StaticPool

from app import create_app
from app.database import make_session_factory
from app.entity import Base, Profile, UserAccount

PASSWORD = "Password123!"


@pytest.fixture()
def session():
    Session, engine = make_session_factory("sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    s = Session()
    Profile.seed_defaults(s)
    yield s
    s.close()


def make_user(session, profile_name, name=None, email=None):
    profile = Profile.get_by_name(session, profile_name)
    user = UserAccount.create(session, name or f"{profile_name} User", email or f"{profile_name.replace(' ', '').lower()}@x.com",
                              PASSWORD, profile)
    session.commit()
    return user


@pytest.fixture()
def admin(session):
    return make_user(session, "User Admin", "Alex Admin", "admin@x.com")


@pytest.fixture()
def platform_manager(session):
    return make_user(session, "Platform Management", "Pat Platform", "platform@x.com")


@pytest.fixture()
def customer(session):
    return make_user(session, "Customer", "Casey Customer", "customer@x.com")


@pytest.fixture()
def client():
    app = create_app("sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False})
    Base.metadata.create_all(app.engine)
    with app.session_factory() as s:
        Profile.seed_defaults(s)
        make_user(s, "User Admin", "Alex Admin", "admin@x.com")
        make_user(s, "Platform Management", "Pat Platform", "platform@x.com")
    return app.test_client()
