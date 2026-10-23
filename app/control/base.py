from app.exceptions import PermissionDenied


class AdminController:
    """Base for every admin use case. Checks the actor's permission before anything runs.

    Platform Management and other profiles have no 'manage_accounts' permission,
    so they are rejected here and can never interfere with user management.
    """
    required_permission = "manage_accounts"

    def __init__(self, session, actor):
        if actor is None or not actor.can(self.required_permission):
            raise PermissionDenied("You do not have access to this feature")
        self.session = session
        self.actor = actor
