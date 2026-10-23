from flask import g, session

from app.entity import UserAccount
from app.exceptions import AuthError


def current_user() -> UserAccount:
    """The logged-in user, or an AuthError (401) if nobody is logged in."""
    user_id = session.get("user_id")
    user = g.db.get(UserAccount, user_id) if user_id else None
    if user is None or not user.is_active:
        raise AuthError("Please log in")
    return user
