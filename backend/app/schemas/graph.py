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
    listenedTracks: list[str] = Field(default_factory=list)
    isShared: bool = False
    isSimilarOnly: bool = False
    isCatalogOnly: bool = False
    isLikedArtist: bool = False
    clusterId: str | None = None


class GraphEdge(BaseModel):
    source: str
    target: str
    type: str
    weight: int = 1
    tracks: list[str] = Field(default_factory=list)


class GraphCluster(BaseModel):
    id: str
    label: str
    color: str
    nodeIds: list[str]
    size: int
    totalListenCount: int
    totalTrackCount: int
    topArtists: list[str]


class GraphResponse(BaseModel):
    nodes: list[GraphNode]
    edges: list[GraphEdge]
    clusters: list[GraphCluster] = Field(default_factory=list)
    sourceStatus: dict = Field(default_factory=dict)


class CompareResponse(BaseModel):
    friendId: str
    sharedArtistIds: list[str]
    sharedCount: int
    myArtistCount: int
    friendArtistCount: int
    overlapPercent: float
