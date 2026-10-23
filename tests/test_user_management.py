import pytest

from app.control.account_controllers import (CreateUserController, DeleteUserController,
                                             ReactivateUserController, ResetPasswordController,
                                             SearchUsersController, SuspendUserController,
                                             UpdateUserController)
from app.control.auth_controllers import LoginController
from app.entity import AuditLog, Profile, UserAccount
from app.exceptions import AuthError, Conflict, ValidationError
from tests.conftest import PASSWORD, make_user


def test_admin_creates_user_with_hashed_password(session, admin):
    user = CreateUserController(session, admin).execute("Dana Lee", "Dana@Example.com", "Secret123!", "Customer")
    assert user.email == "dana@example.com"
    assert user.profile.name == "Customer"
    assert user.password_hash != "Secret123!" and user.check_password("Secret123!")


def test_create_rejects_duplicate_email_bad_email_and_short_password(session, admin):
    c = CreateUserController(session, admin)
    c.execute("Dana", "dana@example.com", "Secret123!", "Customer")
    with pytest.raises(Conflict):
        c.execute("Dana 2", "dana@example.com", "Secret123!", "Customer")
    with pytest.raises(ValidationError):
        c.execute("Bad", "not-an-email", "Secret123!", "Customer")
    with pytest.raises(ValidationError):
        c.execute("Short", "short@example.com", "abc", "Customer")


def test_search_by_name_is_partial_and_case_insensitive(session, admin):
    for n, e in [("Maria Tan", "m@x.com"), ("Marcus Lim", "mc@x.com"), ("Sara Koh", "s@x.com")]:
        make_user(session, "Customer", n, e)
    result = SearchUsersController(session, admin).execute(name="mar")
    assert {u["name"] for u in result["users"]} == {"Maria Tan", "Marcus Lim"}


def test_filter_by_role_and_status_and_combined(session, admin):
    make_user(session, "Customer", "Cathy", "c@x.com")
    make_user(session, "Interior Designer", "Dan Designer", "d@x.com")
    s = make_user(session, "Interior Designer", "Dee Designer", "dd@x.com")
    SuspendUserController(session, admin).execute(s.id)
    ctl = SearchUsersController(session, admin)
    assert ctl.execute(profile="Interior Designer")["total"] == 2
    assert ctl.execute(profile="Interior Designer", status="suspended")["total"] == 1
    assert ctl.execute(profile="Interior Designer", name="dan")["users"][0]["name"] == "Dan Designer"


def test_search_is_paginated(session, admin):
    for i in range(25):
        make_user(session, "Customer", f"Customer {i:02d}", f"c{i}@x.com")
    page2 = SearchUsersController(session, admin).execute(profile="Customer", page=2, page_size=10)
    assert page2["total"] == 25 and len(page2["users"]) == 10


def test_admin_edits_user(session, admin, customer):
    UpdateUserController(session, admin).execute(customer.id, name="Casey Updated", profile_name="Interior Designer")
    session.refresh(customer)
    assert customer.name == "Casey Updated" and customer.profile.name == "Interior Designer"


def test_edit_rejects_email_used_by_someone_else(session, admin, customer):
    with pytest.raises(Conflict):
        UpdateUserController(session, admin).execute(customer.id, email=admin.email)


def test_suspended_user_cannot_log_in_until_reactivated(session, admin, customer):
    SuspendUserController(session, admin).execute(customer.id)
    with pytest.raises(AuthError):
        LoginController(session).execute(customer.email, PASSWORD)
    ReactivateUserController(session, admin).execute(customer.id)
    assert LoginController(session).execute(customer.email, PASSWORD).id == customer.id


def test_admin_cannot_suspend_or_delete_self(session, admin):
    with pytest.raises(ValidationError):
        SuspendUserController(session, admin).execute(admin.id)
    with pytest.raises(ValidationError):
        DeleteUserController(session, admin).execute(admin.id)


def test_delete_removes_user_and_cannot_delete_last_admin(session, admin, customer):
    DeleteUserController(session, admin).execute(customer.id)
    assert UserAccount.find_by_email(session, customer.email) is None
    other_admin = make_user(session, "User Admin", "Second Admin", "admin2@x.com")
    DeleteUserController(session, admin).execute(other_admin.id)   # fine: one admin remains
    third = make_user(session, "User Admin", "Third", "admin3@x.com")
    DeleteUserController(session, third).execute(admin.id)         # fine: 'third' remains
    with pytest.raises(ValidationError):
        DeleteUserController(session, third).execute(third.id)


def test_reset_password_returns_temporary_password(session, admin, customer):
    temporary = ResetPasswordController(session, admin).execute(customer.id)
    session.refresh(customer)
    assert not customer.check_password(PASSWORD)
    assert customer.check_password(temporary) and customer.must_change_password


def test_every_admin_action_is_written_to_the_audit_log(session, admin):
    u = CreateUserController(session, admin).execute("Log Me", "log@x.com", "Secret123!", "Customer")
    SuspendUserController(session, admin).execute(u.id)
    ResetPasswordController(session, admin).execute(u.id)
    DeleteUserController(session, admin).execute(u.id)
    rows, total = AuditLog.search(session)
    assert [r.action for r in reversed(rows)] == ["create_user", "suspend_user", "reset_password", "delete_user"]
    assert all(r.actor_name == "Alex Admin" for r in rows)


def test_search_matches_email_too(session, admin):
    make_user(session, "Customer", "Dana", "zebra@x.com")
    result = SearchUsersController(session, admin).execute(name="zebra")
    assert [u["name"] for u in result["users"]] == ["Dana"]


def test_dashboard_stats_count_users_profiles_and_suspended(session, admin, customer):
    from app.control.account_controllers import DashboardStatsController
    SuspendUserController(session, admin).execute(customer.id, reason="spam")
    stats = DashboardStatsController(session, admin).execute()
    assert stats["total_users"] == 2 and stats["suspended"] == 1 and stats["new_this_week"] == 2
    assert {p["profile"]: p["count"] for p in stats["by_profile"]}["Customer"] == 1
    assert stats["profile_count"] == 4 and stats["custom_profiles"] == 0
    assert stats["recent_signups"][0]["name"] in {"Alex Admin", "Casey Customer"}


def test_suspend_reason_is_saved_in_the_audit_log(session, admin, customer):
    SuspendUserController(session, admin).execute(customer.id, reason="Abusive comments")
    rows, _ = AuditLog.search(session, action="suspend_user")
    assert "Abusive comments" in rows[0].details


def test_audit_log_can_be_filtered_by_date(session, admin, customer):
    SuspendUserController(session, admin).execute(customer.id)
    assert AuditLog.search(session, date_from="2000-01-01", date_to="2999-12-31")[1] == 1
    assert AuditLog.search(session, date_to="2000-01-01")[1] == 0
    with pytest.raises(ValidationError):
        AuditLog.search(session, date_from="31/01/2026")


def test_admin_creates_and_edits_a_custom_profile(session, admin):
    from app.control.profile_controllers import CreateProfileController, UpdateProfilePermissionsController
    created = CreateProfileController(session, admin).execute("Moderator", "Reviews comments", ["view_reports"])
    assert created.name == "Moderator" and not created.is_builtin
    with pytest.raises(Conflict):
        CreateProfileController(session, admin).execute("Moderator", "", [])
    UpdateProfilePermissionsController(session, admin).execute(created.id, ["view_reports"], name="Moderators")
    assert created.name == "Moderators"
    customer_profile = Profile.get_by_name(session, "Customer")
    with pytest.raises(ValidationError):
        UpdateProfilePermissionsController(session, admin).execute(customer_profile.id, ["search_projects"], name="Clients")
