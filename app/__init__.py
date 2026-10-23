from pathlib import Path

from flask import Flask, g, send_from_directory

from app.boundary.admin_routes import admin_bp
from app.boundary.auth_routes import auth_bp
from app.boundary.errors import register_error_handlers
from app.config import Config
from app.database import make_session_factory


def create_app(database_url: str | None = None, **engine_kwargs) -> Flask:
    app = Flask(__name__)
    app.config["SECRET_KEY"] = Config.SECRET_KEY
    app.session_factory, app.engine = make_session_factory(database_url or Config.DATABASE_URL, **engine_kwargs)

    @app.before_request
    def open_session():
        g.db = app.session_factory()

    @app.teardown_request
    def close_session(_exc):
        db = g.pop("db", None)
        if db is not None:
            db.close()

    app.register_blueprint(auth_bp)
    app.register_blueprint(admin_bp)
    register_error_handlers(app)

    frontend = Path(__file__).resolve().parent.parent / "frontend"

    @app.get("/")
    def index():
        # Serve the dashboard from the same origin as the API so the login cookie works.
        return send_from_directory(frontend, "index.html")

    return app
