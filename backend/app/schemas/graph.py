from __future__ import annotations

from pydantic import BaseModel, Field


class GraphNode(BaseModel):
    id: str
    name: str
    image: str | None = None
    listenCount: int = 0
    trackCount: int = 0
    knownTrackCount: int | None = None
    waveTrackCount: int | None = None
    collectionTrackCount: int | None = None
    collectionAlbumCount: int | None = None
    isShared: bool = False
    isSimilarOnly: bool = False
    isCatalogOnly: bool = False
    isLikedArtist: bool = False


class GraphEdge(BaseModel):
    source: str
    target: str
    type: str
    weight: int = 1
    tracks: list[str] = Field(default_factory=list)


class GraphResponse(BaseModel):
    nodes: list[GraphNode]
    edges: list[GraphEdge]
    sourceStatus: dict = Field(default_factory=dict)


class CompareResponse(BaseModel):
    friendId: str
    sharedArtistIds: list[str]
    sharedCount: int
    myArtistCount: int
    friendArtistCount: int
    overlapPercent: float
