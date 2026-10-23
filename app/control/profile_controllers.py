from app.control.base import AdminController
from app.entity import ALL_PERMISSIONS, AuditLog, Profile
from app.exceptions import ValidationError


class ListProfilesController(AdminController):
    """Use case: see which profile can access what."""

    def execute(self) -> dict:
        return {"profiles": [p.to_dict() for p in Profile.list_all(self.session)],
                "available_permissions": ALL_PERMISSIONS}


class CreateProfileController(AdminController):
    """Use case: admin creates a new (custom) profile."""
    required_permission = "manage_profiles"

    def execute(self, name, description, permissions) -> Profile:
        profile = Profile.create(self.session, name, description, permissions or [])
        AuditLog.record(self.session, self.actor, "create_profile", "profile", profile.id,
                        f"{profile.name}: {', '.join(sorted(permissions or [])) or 'none'}")
        self.session.commit()
        return profile


class UpdateProfilePermissionsController(AdminController):
    """Use case: grant or revoke access for a profile (customers, designers, ...)."""
    required_permission = "manage_profiles"

    def execute(self, profile_id, permissions, name=None, description=None) -> Profile:
        profile = Profile.get(self.session, profile_id)
        if self.actor.profile_id == profile.id and "manage_profiles" not in set(permissions):
            raise ValidationError("You cannot remove your own admin access")
        profile.update_details(self.session, name, description)
        profile.set_permissions(permissions)
        AuditLog.record(self.session, self.actor, "update_permissions", "profile", profile.id,
                        f"{profile.name}: {', '.join(sorted(permissions)) or 'none'}")
        self.session.commit()
        return profile
