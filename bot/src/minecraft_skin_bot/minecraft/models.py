from dataclasses import dataclass
from enum import StrEnum
from uuid import UUID


class SkinModel(StrEnum):
    CLASSIC = "classic"
    SLIM = "slim"
    UNKNOWN = "unknown"


@dataclass(frozen=True, slots=True)
class Profile:
    uuid: UUID
    name: str
    model: SkinModel
    skin_url: str | None
    cape_url: str | None
