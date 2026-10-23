import secrets

from app.control.base import AdminController
from app.entity import AuditLog, Profile, UserAccount
from app.exceptions import Conflict, ValidationError


class CreateUserController(AdminController):
    """Use case: admin creates a user."""

    def execute(self, name, email, password, profile_name) -> UserAccount:
        profile = Profile.get_by_name(self.session, profile_name)
        user = UserAccount.create(self.session, name, email, password, profile)
        AuditLog.record(self.session, self.actor, "create_user", "user", user.id,
                        f"Created {user.email} as {profile.name}")
        self.session.commit()
        return user


class SearchUsersController(AdminController):
    """Use case: manage users - view user data, search by name, filter by role/status."""

    def execute(self, name=None, profile=None, status=None, page=1, page_size=20) -> dict:
        users, total = UserAccount.search(self.session, name, profile, status, page, page_size)
        return {"total": total, "page": int(page), "users": [u.to_dict() for u in users]}


class ViewUserController(AdminController):
    def execute(self, user_id) -> UserAccount:
        return UserAccount.get(self.session, user_id)


class UpdateUserController(AdminController):
    """Use case: admin edits a user (name, email, profile)."""

    def execute(self, user_id, name=None, email=None, profile_name=None) -> UserAccount:
        user = UserAccount.get(self.session, user_id)
        profile = Profile.get_by_name(self.session, profile_name) if profile_name else None
        if profile and user.id == self.actor.id and profile.id != user.profile_id \
                and not profile.has_permission("manage_accounts"):
            raise ValidationError("You cannot remove your own admin access")
        user.update(self.session, name=name, email=email, profile=profile)
        AuditLog.record(self.session, self.actor, "update_user", "user", user.id, f"Updated {user.email}")
        self.session.commit()
        return user


class DashboardStatsController(AdminController):
    """Use case: admin opens the dashboard (counts, accounts per profile, newest sign-ups)."""

    def execute(self) -> dict:
        return UserAccount.dashboard_stats(self.session)


class SuspendUserController(AdminController):
    def execute(self, user_id, reason=None) -> UserAccount:
        user = UserAccount.get(self.session, user_id)
        if user.id == self.actor.id:
            raise ValidationError("You cannot suspend your own account")
        user.suspend()
        details = f"Suspended {user.email}"
        if reason and reason.strip():
            details += f" · Reason: {reason.strip()[:300]}"
        AuditLog.record(self.session, self.actor, "suspend_user", "user", user.id, details)
        self.session.commit()
        return user


class ReactivateUserController(AdminController):
    def execute(self, user_id) -> UserAccount:
        user = UserAccount.get(self.session, user_id)
        user.reactivate()
        AuditLog.record(self.session, self.actor, "reactivate_user", "user", user.id, f"Reactivated {user.email}")
        self.session.commit()
        return user


class DeleteUserController(AdminController):
    """Use case: admin permanently deletes a user."""

    def execute(self, user_id) -> None:
        user = UserAccount.get(self.session, user_id)
        if user.id == self.actor.id:
            raise ValidationError("You cannot delete your own account")
        if user.can("manage_accounts") and UserAccount.count_with_permission(self.session, "manage_accounts") <= 1:
            raise Conflict("You cannot delete the last admin")
        email, uid = user.email, user.id
        user.delete(self.session)
        AuditLog.record(self.session, self.actor, "delete_user", "user", uid, f"Deleted {email}")
        self.session.commit()


class ResetPasswordController(AdminController):
    """Use case: admin resets a user's password. Returns a one-time temporary password."""

    def execute(self, user_id) -> str:
        user = UserAccount.get(self.session, user_id)
        temporary = secrets.token_urlsafe(9)
        user.set_password(temporary, must_change=True)
        AuditLog.record(self.session, self.actor, "reset_password", "user", user.id, f"Reset password for {user.email}")
        self.session.commit()
        return temporary
