def login(client, email, password="Password123!"):
    return client.post("/api/login", json={"email": email, "password": password})


def test_anonymous_gets_401(client):
    assert client.get("/api/admin/users").status_code == 401


def test_platform_manager_gets_403_on_user_management(client):
    assert login(client, "platform@x.com").status_code == 200
    assert client.get("/api/admin/users").status_code == 403
    assert client.post("/api/admin/users", json={}).status_code == 403


def test_admin_end_to_end_flow(client):
    assert login(client, "admin@x.com").status_code == 200
    created = client.post("/api/admin/users", json={"name": "Dana Lee", "email": "dana@x.com",
                                                    "password": "Secret123!", "profile": "Customer"})
    assert created.status_code == 201
    uid = created.get_json()["id"]
    found = client.get("/api/admin/users?name=dana&profile=Customer").get_json()
    assert found["total"] == 1
    assert client.post(f"/api/admin/users/{uid}/suspend").get_json()["status"] == "suspended"
    assert "temporary_password" in client.post(f"/api/admin/users/{uid}/reset-password").get_json()
    assert client.delete(f"/api/admin/users/{uid}").status_code == 204
    logs = client.get("/api/admin/audit-logs").get_json()
    assert logs["total"] == 4


def test_duplicate_email_returns_409_and_designer_signup_notifies_admin(client):
    body = {"name": "Oakline", "email": "o@x.com", "password": "Secret123!", "profile": "Interior Designer"}
    assert client.post("/api/register", json=body).status_code == 201
    assert client.post("/api/register", json=body).status_code == 409
    login(client, "admin@x.com")
    assert client.get("/api/admin/notifications").get_json()["unread"] == 1
