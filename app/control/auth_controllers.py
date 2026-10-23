from app.entity import Notification, Profile, UserAccount
from app.exceptions import AuthError, PermissionDenied

SELF_REGISTER_PROFILES = ("Customer", "Interior Designer")  # admin accounts are never self-registered


class LoginController:
    def __init__(self, session):
        self.session = session

    def execute(self, email, password) -> UserAccount:
        user = UserAccount.find_by_email(self.session, email)
        if not user or not user.check_password(password):
            raise AuthError("Incorrect email or password")
        if not user.is_active:
            raise AuthError("Your account has been suspended. Please contact the platform.")
        return user


class RegisterController:
    """Use case: a visitor signs up. A new interior designer notifies every admin."""

    def __init__(self, session):
        self.session = session

    def execute(self, name, email, password, profile_name) -> UserAccount:
        if profile_name not in SELF_REGISTER_PROFILES:
            raise PermissionDenied("This account type cannot be created from the sign-up form")
        profile = Profile.get_by_name(self.session, profile_name)
        user = UserAccount.create(self.session, name, email, password, profile)
        if profile_name == "Interior Designer":
            Notification.notify_admins(self.session, "designer_registered",
                                       f"{user.name} registered as an Interior Designer", related_user_id=user.id)
        self.session.commit()
        return user
