from sqlalchemy import Boolean, ForeignKey, Integer, String, select
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.entity.base import Base
from app.exceptions import Conflict, NotFound, ValidationError

# Every action the platform can allow. A profile "grants access" by holding permissions.
ALL_PERMISSIONS = {
    "manage_accounts": "Create, edit, suspend and delete user accounts",
    "manage_profiles": "Edit profiles and grant or revoke their permissions",
    "view_audit_log": "View the admin audit log",
    "receive_admin_notifications": "Receive admin notifications (e.g. new designer registered)",
    "manage_company": "Manage company information",
    "manage_portfolio": "Manage portfolio projects",
    "view_insights": "View interest insights",
    "search_projects": "Search and view projects",
    "save_favourites": "Save projects to favourites",
    "manage_categories": "Manage IDP categories",
    "view_reports": "View daily, weekly and monthly reports",
}

# Platform Management has NO account permissions, so it cannot touch user management.
DEFAULT_PROFILES = {
    "User Admin": ["manage_accounts", "manage_profiles", "view_audit_log", "receive_admin_notifications"],
    "Interior Designer": ["manage_company", "manage_portfolio", "view_insights"],
    "Customer": ["search_projects", "save_favourites"],
    "Platform Management": ["manage_categories", "view_reports"],
}

class Profile(Base):
    __tablename__ = "profiles"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(60), unique=True, nullable=False)
    description: Mapped[str] = mapped_column(String(255), default="")
    is_builtin: Mapped[bool] = mapped_column(Boolean, default=False)
    _codes = relationship("ProfilePermission", cascade="all, delete-orphan", lazy="selectin")

    # ---- behaviour -------------------------------------------------
    @property
    def permissions(self) -> set[str]:
        return {p.code for p in self._codes}

    def has_permission(self, code: str) -> bool:
        return code in self.permissions

    def set_permissions(self, codes) -> None:
        codes = set(codes)
        unknown = codes - set(ALL_PERMISSIONS)
        if unknown:
            raise ValidationError(f"Unknown permissions: {sorted(unknown)}")
        self._codes[:] = [ProfilePermission(code=c) for c in sorted(codes)]

    def update_details(self, session, name=None, description=None) -> None:
        """Rename / re-describe. Built-in profiles keep their name because sign-up looks them up by it."""
        if name is not None and name.strip() != self.name:
            name = name.strip()
            if self.is_builtin:
                raise ValidationError("Built-in profile names cannot be changed")
            if not name:
                raise ValidationError("Profile name is required")
            if session.scalar(select(Profile).where(Profile.name == name)):
                raise Conflict("A profile with this name already exists")
            self.name = name
        if description is not None:
            self.description = description.strip()[:255]

    def to_dict(self) -> dict:
        return {"id": self.id, "name": self.name, "description": self.description,
                "is_builtin": self.is_builtin, "permissions": sorted(self.permissions)}

    # ---- persistence ----------------------------------------------
    @classmethod
    def get(cls, session, profile_id: int) -> "Profile":
        profile = session.get(cls, profile_id)
        if not profile:
            raise NotFound("Profile not found")
        return profile

    @classmethod
    def get_by_name(cls, session, name: str) -> "Profile":
        profile = session.scalar(select(cls).where(cls.name == name))
        if not profile:
            raise NotFound(f"Profile '{name}' not found")
        return profile

    @classmethod
    def create(cls, session, name, description="", permissions=()) -> "Profile":
        name = (name or "").strip()
        if not name:
            raise ValidationError("Profile name is required")
        if session.scalar(select(cls).where(cls.name == name)):
            raise Conflict("A profile with this name already exists")
        profile = cls(name=name, description=(description or "").strip()[:255], is_builtin=False)
        profile.set_permissions(permissions)
        session.add(profile)
        session.flush()
        return profile

    @classmethod
    def list_all(cls, session) -> list["Profile"]:
        return list(session.scalars(select(cls).order_by(cls.name)))

    @classmethod
    def seed_defaults(cls, session) -> None:
        for name, codes in DEFAULT_PROFILES.items():
            exists = session.scalar(select(cls).where(cls.name == name))
            if not exists:
                profile = cls(name=name, is_builtin=True)
                profile.set_permissions(codes)
                session.add(profile)
        session.commit()


class ProfilePermission(Base):
    """One row per permission held by a profile."""
    __tablename__ = "profile_permission_rows"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    profile_id: Mapped[int] = mapped_column(ForeignKey("profiles.id", ondelete="CASCADE"))
    code: Mapped[str] = mapped_column(String(60), nullable=False)
