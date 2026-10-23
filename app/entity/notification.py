from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, select
from sqlalchemy.orm import Mapped, mapped_column

from app.entity.base import Base
from app.exceptions import NotFound


def _now():
    return datetime.now(timezone.utc)


class Notification(Base):
    __tablename__ = "notifications"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    recipient_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    kind: Mapped[str] = mapped_column(String(40), nullable=False)
    message: Mapped[str] = mapped_column(String(300), nullable=False)
    related_user_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    is_read: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    @classmethod
    def notify_admins(cls, session, kind: str, message: str, related_user_id=None) -> int:
        """One notification per admin who may receive admin notifications."""
        from app.entity.user_account import UserAccount
        count = 0
        for user in session.scalars(select(UserAccount)):
            if user.can("receive_admin_notifications"):
                session.add(cls(recipient_id=user.id, kind=kind, message=message, related_user_id=related_user_id))
                count += 1
        return count

    @classmethod
    def for_user(cls, session, user, unread_only=False):
        query = select(cls).where(cls.recipient_id == user.id)
        if unread_only:
            query = query.where(cls.is_read.is_(False))
        return list(session.scalars(query.order_by(cls.id.desc())))

    @classmethod
    def mark_read(cls, session, user, notification_id: int) -> "Notification":
        note = session.get(cls, notification_id)
        if not note or note.recipient_id != user.id:
            raise NotFound("Notification not found")
        note.is_read = True
        return note

    def to_dict(self) -> dict:
        return {"id": self.id, "kind": self.kind, "message": self.message, "is_read": self.is_read,
                "related_user_id": self.related_user_id,
                "created_at": self.created_at.isoformat() if self.created_at else None}
