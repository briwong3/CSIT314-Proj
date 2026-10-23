from flask import Blueprint, g, jsonify, request

from app.boundary.helpers import current_user
from app.control.account_controllers import (CreateUserController, DeleteUserController,
                                             DashboardStatsController, ReactivateUserController,
                                             ResetPasswordController,
                                             SearchUsersController, SuspendUserController,
                                             UpdateUserController, ViewUserController)
from app.control.log_notification_controllers import (ListNotificationsController,
                                                      MarkNotificationReadController,
                                                      ViewAuditLogController)
from app.control.profile_controllers import (CreateProfileController, ListProfilesController,
                                             UpdateProfilePermissionsController)

admin_bp = Blueprint("admin", __name__, url_prefix="/api/admin")


@admin_bp.get("/dashboard")
def dashboard():
    return jsonify(DashboardStatsController(g.db, current_user()).execute())


@admin_bp.get("/users")
def list_users():
    a = request.args
    return jsonify(SearchUsersController(g.db, current_user()).execute(
        a.get("name"), a.get("profile"), a.get("status"), a.get("page", 1), a.get("page_size", 20)))


@admin_bp.post("/users")
def create_user():
    d = request.get_json(force=True)
    user = CreateUserController(g.db, current_user()).execute(d.get("name"), d.get("email"),
                                                             d.get("password"), d.get("profile"))
    return jsonify(user.to_dict()), 201


@admin_bp.get("/users/<int:user_id>")
def get_user(user_id):
    return jsonify(ViewUserController(g.db, current_user()).execute(user_id).to_dict())


@admin_bp.put("/users/<int:user_id>")
def update_user(user_id):
    d = request.get_json(force=True)
    user = UpdateUserController(g.db, current_user()).execute(user_id, d.get("name"), d.get("email"), d.get("profile"))
    return jsonify(user.to_dict())


@admin_bp.post("/users/<int:user_id>/suspend")
def suspend_user(user_id):
    reason = (request.get_json(silent=True) or {}).get("reason")
    return jsonify(SuspendUserController(g.db, current_user()).execute(user_id, reason).to_dict())


@admin_bp.post("/users/<int:user_id>/reactivate")
def reactivate_user(user_id):
    return jsonify(ReactivateUserController(g.db, current_user()).execute(user_id).to_dict())


@admin_bp.delete("/users/<int:user_id>")
def delete_user(user_id):
    DeleteUserController(g.db, current_user()).execute(user_id)
    return "", 204


@admin_bp.post("/users/<int:user_id>/reset-password")
def reset_password(user_id):
    temporary = ResetPasswordController(g.db, current_user()).execute(user_id)
    return jsonify({"temporary_password": temporary})  # show once; user must change it at next login


@admin_bp.get("/profiles")
def list_profiles():
    return jsonify(ListProfilesController(g.db, current_user()).execute())


@admin_bp.post("/profiles")
def create_profile():
    d = request.get_json(force=True)
    profile = CreateProfileController(g.db, current_user()).execute(d.get("name"), d.get("description"),
                                                                    d.get("permissions", []))
    return jsonify(profile.to_dict()), 201


@admin_bp.put("/profiles/<int:profile_id>/permissions")
def update_permissions(profile_id):
    d = request.get_json(force=True)
    profile = UpdateProfilePermissionsController(g.db, current_user()).execute(
        profile_id, d.get("permissions", []), d.get("name"), d.get("description"))
    return jsonify(profile.to_dict())


@admin_bp.get("/audit-logs")
def audit_logs():
    a = request.args
    return jsonify(ViewAuditLogController(g.db, current_user()).execute(
        a.get("action"), a.get("actor"), a.get("page", 1), a.get("page_size", 20), a.get("from"), a.get("to")))


@admin_bp.get("/notifications")
def notifications():
    unread = request.args.get("unread") == "1"
    return jsonify(ListNotificationsController(g.db, current_user()).execute(unread))


@admin_bp.post("/notifications/<int:notification_id>/read")
def read_notification(notification_id):
    return jsonify(MarkNotificationReadController(g.db, current_user()).execute(notification_id).to_dict())
