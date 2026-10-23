import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import DateTime, Integer, String, func, select
from sqlalchemy.orm import Mapped, mapped_column

from app.entity.base import Base
from app.exceptions import ValidationError


log = logging.getLogger("audit")  # also prints to the terminal when logging is configured


def _now():
    return datetime.now(timezone.utc)


def _day(value: str) -> datetime:
    """Parse 'YYYY-MM-DD' (what <input type=date> sends) as the start of that day in UTC."""
    try:
        return datetime.strptime(value, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except ValueError:
        raise ValidationError("Dates must look like 2026-01-31")


class AuditLog(Base):
    """Append-only record of what admins did. There is deliberately no update or delete."""
    __tablename__ = "audit_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    actor_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    actor_name: Mapped[str] = mapped_column(String(120), default="")
    action: Mapped[str] = mapped_column(String(60), nullable=False)
    target_type: Mapped[str] = mapped_column(String(40), default="")
    target_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    details: Mapped[str] = mapped_column(String(500), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    @classmethod
    def record(cls, session, actor, action, target_type="", target_id=None, details=""):
        entry = cls(actor_id=actor.id if actor else None, actor_name=actor.name if actor else "system",
                    action=action, target_type=target_type, target_id=target_id, details=details)
        session.add(entry)
        log.info("%s | %s | %s %s | %s", entry.actor_name, action, target_type, target_id, details)
        return entry

    @classmethod
    def search(cls, session, action=None, actor_name=None, page=1, page_size=20, date_from=None, date_to=None):
        query = select(cls)
        if date_from:
            query = query.where(cls.created_at >= _day(date_from))
        if date_to:
            query = query.where(cls.created_at < _day(date_to) + timedelta(days=1))
        if action:
            query = query.where(cls.action == action)
        if actor_name:
            query = query.where(cls.actor_name.ilike(f"%{actor_name.strip()}%"))
        total = session.scalar(select(func.count()).select_from(query.subquery()))
        page, page_size = max(int(page), 1), min(max(int(page_size), 1), 100)
        rows = session.scalars(query.order_by(cls.id.desc()).limit(page_size).offset((page - 1) * page_size))
        return list(rows), total

    def to_dict(self) -> dict:
        return {"id": self.id, "when": self.created_at.isoformat() if self.created_at else None,
                "actor": self.actor_name, "action": self.action, "target_type": self.target_type,
                "target_id": self.target_id, "details": self.details}
