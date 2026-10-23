from flask import Blueprint, g, jsonify, request, session

from app.boundary.helpers import current_user
from app.control.auth_controllers import LoginController, RegisterController

auth_bp = Blueprint("auth", __name__, url_prefix="/api")


@auth_bp.post("/login")
def login():
    data = request.get_json(force=True)
    user = LoginController(g.db).execute(data.get("email"), data.get("password"))
    session["user_id"] = user.id
    session.permanent = bool(data.get("remember"))  # "Remember me": cookie survives closing the browser
    return jsonify({"user": user.to_dict(), "permissions": sorted(user.profile.permissions)})


@auth_bp.post("/logout")
def logout():
    session.clear()
    return jsonify({"ok": True})


@auth_bp.post("/register")
def register():
    data = request.get_json(force=True)
    user = RegisterController(g.db).execute(data.get("name"), data.get("email"),
                                            data.get("password"), data.get("profile"))
    return jsonify(user.to_dict()), 201


@auth_bp.get("/me")
def me():
    user = current_user()
    return jsonify({"user": user.to_dict(), "permissions": sorted(user.profile.permissions)})
