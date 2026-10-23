from flask import jsonify

from app.exceptions import AppError


def register_error_handlers(app):
    @app.errorhandler(AppError)
    def handle_app_error(err):
        return jsonify({"error": str(err)}), err.status
