from typing import Protocol
from uuid import UUID

from minecraft_skin_bot.minecraft.models import Profile


class MinecraftProfileProvider(Protocol):
    async def resolve_username(self, username: str) -> UUID: ...

    async def get_profile(self, uuid: UUID) -> Profile: ...

    async def get_skin(self, url: str) -> bytes: ...
