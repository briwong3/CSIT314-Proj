from app.control.base import AdminController
from app.entity import AuditLog, Notification


class ViewAuditLogController(AdminController):
    """Use case: admin views the log of admin actions."""
    required_permission = "view_audit_log"

    def execute(self, action=None, actor_name=None, page=1, page_size=20, date_from=None, date_to=None) -> dict:
        rows, total = AuditLog.search(self.session, action, actor_name, page, page_size, date_from, date_to)
        return {"total": total, "logs": [r.to_dict() for r in rows]}


class ListNotificationsController(AdminController):
    required_permission = "receive_admin_notifications"

    def execute(self, unread_only=False) -> dict:
        notes = Notification.for_user(self.session, self.actor, unread_only)
        return {"unread": sum(1 for n in notes if not n.is_read), "notifications": [n.to_dict() for n in notes]}


class MarkNotificationReadController(AdminController):
    required_permission = "receive_admin_notifications"

    def execute(self, notification_id) -> Notification:
        note = Notification.mark_read(self.session, self.actor, notification_id)
        self.session.commit()
        return note
