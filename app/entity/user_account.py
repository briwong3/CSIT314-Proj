import re
from datetime import datetime, timedelta, timezone

from sqlalchemy import DateTime, ForeignKey, Integer, String, Boolean, func, or_, select
from sqlalchemy.orm import Mapped, mapped_column, relationship
from werkzeug.security import check_password_hash, generate_password_hash

from app.entity.base import Base
from app.entity.profile import Profile
from app.exceptions import Conflict, NotFound, ValidationError

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
STATUSES = ("active", "suspended")


def _now():
    return datetime.now(timezone.utc)


class UserAccount(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    profile_id: Mapped[int] = mapped_column(ForeignKey("profiles.id"), nullable=False)
    status: Mapped[str] = mapped_column(String(20), default="active", nullable=False)
    must_change_password: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    profile: Mapped[Profile] = relationship(lazy="joined")

    # ---- behaviour -------------------------------------------------
    @property
    def is_active(self) -> bool:
        return self.status == "active"

    def can(self, permission: str) -> bool:
        return self.is_active and self.profile.has_permission(permission)

    def set_password(self, password: str, must_change: bool = False) -> None:
        if len(password or "") < 8:
            raise ValidationError("Password must be at least 8 characters")
        self.password_hash = generate_password_hash(password)
        self.must_change_password = must_change

    def check_password(self, password: str) -> bool:
        return check_password_hash(self.password_hash, password or "")

    def suspend(self) -> None:
        self.status = "suspended"

    def reactivate(self) -> None:
        self.status = "active"

    def to_dict(self) -> dict:
        return {"id": self.id, "name": self.name, "email": self.email,
                "profile": self.profile.name, "status": self.status,
                "created_at": self.created_at.isoformat() if self.created_at else None}

    # ---- persistence ----------------------------------------------
    @classmethod
    def create(cls, session, name, email, password, profile: Profile) -> "UserAccount":
        name, email = (name or "").strip(), (email or "").strip().lower()
        if not name:
            raise ValidationError("Name is required")
        if not EMAIL_RE.match(email):
            raise ValidationError("Enter a valid email address")
        if cls.find_by_email(session, email):
            raise Conflict("An account with this email already exists")
        user = cls(name=name, email=email, profile=profile)
        user.set_password(password)
        session.add(user)
        session.flush()
        return user

    @classmethod
    def find_by_email(cls, session, email: str):
        return session.scalar(select(cls).where(cls.email == (email or "").strip().lower()))

    @classmethod
    def get(cls, session, user_id: int) -> "UserAccount":
        user = session.get(cls, user_id)
        if not user:
            raise NotFound("User not found")
        return user

    @classmethod
    def search(cls, session, name=None, profile_name=None, status=None, page=1, page_size=20):
        """Search by name or email (partial, case-insensitive), filter by role (profile) and status."""
        query = select(cls).join(Profile)
        if name:
            term = f"%{name.strip()}%"
            query = query.where(or_(cls.name.ilike(term), cls.email.ilike(term)))
        if profile_name:
            query = query.where(Profile.name == profile_name)
        if status:
            if status not in STATUSES:
                raise ValidationError("Status must be 'active' or 'suspended'")
            query = query.where(cls.status == status)
        total = session.scalar(select(func.count()).select_from(query.subquery()))
        page, page_size = max(int(page), 1), min(max(int(page_size), 1), 100)
        items = session.scalars(query.order_by(cls.name, cls.id).limit(page_size).offset((page - 1) * page_size))
        return list(items), total

    @classmethod
    def dashboard_stats(cls, session, now=None) -> dict:
        """Numbers for the admin dashboard: totals, weekly growth, accounts per profile, newest sign-ups."""
        now = now or _now()
        week_ago, two_weeks_ago = now - timedelta(days=7), now - timedelta(days=14)

        def count(*conditions):
            query = select(func.count()).select_from(cls)
            for condition in conditions:
                query = query.where(condition)
            return session.scalar(query)

        per_profile = session.execute(
            select(Profile.name, func.count(cls.id)).select_from(Profile)
            .outerjoin(cls, cls.profile_id == Profile.id)
            .group_by(Profile.id, Profile.name)
            .order_by(func.count(cls.id).desc(), Profile.name)).all()
        newest = session.scalars(select(cls).order_by(cls.created_at.desc(), cls.id.desc()).limit(5))
        return {
            "total_users": count(),
            "new_this_week": count(cls.created_at >= week_ago),
            "new_last_week": count(cls.created_at >= two_weeks_ago, cls.created_at < week_ago),
            "suspended": count(cls.status == "suspended"),
            "profile_count": session.scalar(select(func.count()).select_from(Profile)),
            "custom_profiles": session.scalar(select(func.count()).select_from(Profile).where(Profile.is_builtin.is_(False))),
            "by_profile": [{"profile": name, "count": n} for name, n in per_profile],
            "recent_signups": [u.to_dict() for u in newest],
        }

    @classmethod
    def count_with_permission(cls, session, permission: str) -> int:
        users = session.scalars(select(cls).where(cls.status == "active"))
        return sum(1 for u in users if u.can(permission))

    def update(self, session, name=None, email=None, profile: Profile | None = None) -> None:
        if name is not None:
            if not name.strip():
                raise ValidationError("Name is required")
            self.name = name.strip()
        if email is not None:
            email = email.strip().lower()
            if not EMAIL_RE.match(email):
                raise ValidationError("Enter a valid email address")
            other = self.find_by_email(session, email)
            if other and other.id != self.id:
                raise Conflict("An account with this email already exists")
            self.email = email
        if profile is not None:
            self.profile = profile

    def delete(self, session) -> None:
        from app.entity.notification import Notification
        session.query(Notification).filter(Notification.recipient_id == self.id).delete()
        session.delete(self)
