class UtilityError(Exception):
    """An expected failure with text safe to show in Telegram and the public API."""

    def __init__(self, title: str, message: str, *, status: int = 400) -> None:
        super().__init__(title)
        self.title = title
        self.message = message
        self.status = status
