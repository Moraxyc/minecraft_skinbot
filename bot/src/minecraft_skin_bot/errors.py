class UtilityError(Exception):
    """An expected failure with text safe to show in Telegram and the public API."""

    def __init__(
        self,
        title: str,
        message: str,
        *,
        status: int = 400,
        params: dict[str, str] | None = None,
    ) -> None:
        super().__init__(title)
        self.title = title
        self.message_template = message
        self.params = dict(params or {})
        self.message = message.format(**self.params) if self.params else message
        self.status = status
