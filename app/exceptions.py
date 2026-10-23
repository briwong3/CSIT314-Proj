"""Domain errors. The boundary layer maps each one to an HTTP status."""


class AppError(Exception):
    status = 400


class ValidationError(AppError):
    status = 400


class AuthError(AppError):
    status = 401


class PermissionDenied(AppError):
    status = 403


class NotFound(AppError):
    status = 404


class Conflict(AppError):
    status = 409
