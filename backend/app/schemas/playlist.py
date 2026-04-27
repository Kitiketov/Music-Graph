from __future__ import annotations

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field

PlaylistSource = Literal[
    "known",
    "liked",
    "wave",
    "graph",
    "friend_common",
    "unheard_collabs",
    "unheard_liked_collabs",
    "friend_unheard_collabs",
]
PlaylistVisibility = Literal["private", "public"]


class PlaylistBuildRequest(BaseModel):
    source: PlaylistSource = "known"
    limit: int = Field(default=50, ge=1, le=100)
    artist_id: str | None = None
    friend_id: UUID | None = None


class PlaylistCreateRequest(PlaylistBuildRequest):
    title: str = Field(default="Music Graph: знакомые треки", min_length=1, max_length=120)
    visibility: PlaylistVisibility = "private"


class PlaylistTrackOut(BaseModel):
    id: str
    title: str
    artists: list[str]
    cover: str | None = None
    albumId: str | None = None
    sources: list[str] = Field(default_factory=list)


class PlaylistPreviewResponse(BaseModel):
    source: PlaylistSource
    titleSuggestion: str
    totalAvailable: int
    usableCount: int
    skippedWithoutAlbum: int
    tracks: list[PlaylistTrackOut]


class PlaylistCreateResponse(BaseModel):
    title: str
    kind: int | str
    url: str | None = None
    addedCount: int
    skippedWithoutAlbum: int
    tracks: list[PlaylistTrackOut]
