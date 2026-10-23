import pytest

from app.control.account_controllers import CreateUserController, SearchUsersController
from app.control.auth_controllers import RegisterController
from app.control.log_notification_controllers import (ListNotificationsController,
                                                      MarkNotificationReadController,
                                                      ViewAuditLogController)
from app.control.profile_controllers import ListProfilesController, UpdateProfilePermissionsController
from app.entity import Profile
from app.exceptions import NotFound, PermissionDenied, ValidationError
from tests.conftest import make_user


def test_platform_manager_cannot_use_any_user_management_feature(session, platform_manager):
    for controller in (CreateUserController, SearchUsersController, ViewAuditLogController, ListProfilesController):
        with pytest.raises(PermissionDenied):
            controller(session, platform_manager)


def test_customer_and_anonymous_are_denied(session, customer):
    with pytest.raises(PermissionDenied):
        SearchUsersController(session, customer)
    with pytest.raises(PermissionDenied):
        SearchUsersController(session, None)


def test_suspended_admin_loses_access(session, admin):
    admin.suspend()
    with pytest.raises(PermissionDenied):
        SearchUsersController(session, admin)


def test_admin_sees_which_profile_can_access_what(session, admin):
    data = ListProfilesController(session, admin).execute()
    by_name = {p["name"]: set(p["permissions"]) for p in data["profiles"]}
    assert "manage_accounts" in by_name["User Admin"]
    assert "manage_accounts" not in by_name["Platform Management"]
    assert "search_projects" in by_name["Customer"]


def test_admin_grants_and_revokes_access_for_a_profile(session, admin, customer):
    customer_profile = Profile.get_by_name(session, "Customer")
    UpdateProfilePermissionsController(session, admin).execute(customer_profile.id, ["search_projects", "view_reports"])
    session.refresh(customer)
    assert customer.can("view_reports") and not customer.can("save_favourites")


def test_unknown_permission_is_rejected_and_admin_cannot_lock_themselves_out(session, admin):
    admin_profile = Profile.get_by_name(session, "User Admin")
    with pytest.raises(ValidationError):
        UpdateProfilePermissionsController(session, admin).execute(admin_profile.id, ["fly_to_the_moon"])
    with pytest.raises(ValidationError):
        UpdateProfilePermissionsController(session, admin).execute(admin_profile.id, ["manage_accounts"])


def test_registering_a_designer_notifies_every_admin(session, admin):
    second = make_user(session, "User Admin", "Second Admin", "admin2@x.com")
    RegisterController(session).execute("Oakline Studio", "oakline@x.com", "Secret123!", "Interior Designer")
    for a in (admin, second):
        data = ListNotificationsController(session, a).execute()
        assert data["unread"] == 1 and "Oakline Studio" in data["notifications"][0]["message"]


def test_registering_a_customer_does_not_notify_admins(session, admin):
    RegisterController(session).execute("Cathy", "cathy@x.com", "Secret123!", "Customer")
    assert ListNotificationsController(session, admin).execute()["unread"] == 0


def test_cannot_self_register_as_admin(session):
    with pytest.raises(PermissionDenied):
        RegisterController(session).execute("Mallory", "m@x.com", "Secret123!", "User Admin")


def test_mark_notification_read(session, admin):
    RegisterController(session).execute("Kiln Design", "kiln@x.com", "Secret123!", "Interior Designer")
    note_id = ListNotificationsController(session, admin).execute()["notifications"][0]["id"]
    MarkNotificationReadController(session, admin).execute(note_id)
    assert ListNotificationsController(session, admin).execute()["unread"] == 0
    with pytest.raises(NotFound):
        MarkNotificationReadController(session, admin).execute(9999)
