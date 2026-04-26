from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


def utcnow() -> datetime:
    return datetime.now(UTC)


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    yandex_uid: Mapped[str | None] = mapped_column(String(64), unique=True, index=True)
    display_login: Mapped[str] = mapped_column(String(255), index=True)
    avatar_url: Mapped[str | None] = mapped_column(Text)
    terms_version: Mapped[str | None] = mapped_column(String(32))
    privacy_version: Mapped[str | None] = mapped_column(String(32))
    terms_accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)

    credential: Mapped[YandexCredential] = relationship(back_populates="user", uselist=False)


class YandexCredential(Base):
    __tablename__ = "yandex_credentials"

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    encrypted_x_token: Mapped[str] = mapped_column(Text)
    encrypted_music_token: Mapped[str | None] = mapped_column(Text)
    encrypted_refresh_token: Mapped[str | None] = mapped_column(Text)
    token_source: Mapped[str] = mapped_column(String(32), default="qr")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)

    user: Mapped[User] = relationship(back_populates="credential")


class SyncJob(Base):
    __tablename__ = "sync_jobs"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"))
    status: Mapped[str] = mapped_column(String(32), default="queued", index=True)
    progress: Mapped[int] = mapped_column(Integer, default=0)
    message: Mapped[str | None] = mapped_column(Text)
    source_status: Mapped[dict] = mapped_column(JSONB, default=dict)
    error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Track(Base):
    __tablename__ = "tracks"

    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    title: Mapped[str] = mapped_column(Text)
    cover_uri: Mapped[str | None] = mapped_column(Text)
    duration_ms: Mapped[int | None] = mapped_column(Integer)
    raw: Mapped[dict] = mapped_column(JSONB, default=dict)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class Artist(Base):
    __tablename__ = "artists"

    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    name: Mapped[str] = mapped_column(Text, index=True)
    image_url: Mapped[str | None] = mapped_column(Text)
    raw: Mapped[dict] = mapped_column(JSONB, default=dict)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class TrackArtist(Base):
    __tablename__ = "track_artists"
    __table_args__ = (UniqueConstraint("track_id", "artist_id", name="uq_track_artist"),)

    track_id: Mapped[str] = mapped_column(String(128), ForeignKey("tracks.id", ondelete="CASCADE"), primary_key=True)
    artist_id: Mapped[str] = mapped_column(String(128), ForeignKey("artists.id", ondelete="CASCADE"), primary_key=True)
    role: Mapped[str] = mapped_column(String(32), default="primary")


class UserListen(Base):
    __tablename__ = "user_listens"
    __table_args__ = (
        Index("ix_user_listens_user_track", "user_id", "track_id"),
        Index("ix_user_listens_user_played_at", "user_id", "played_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"))
    track_id: Mapped[str] = mapped_column(String(128), ForeignKey("tracks.id", ondelete="CASCADE"))
    source: Mapped[str] = mapped_column(String(64), default="history")
    played_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    event_key: Mapped[str] = mapped_column(String(255), unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class UserArtistStat(Base):
    __tablename__ = "user_artist_stats"
    __table_args__ = (
        UniqueConstraint("user_id", "artist_id", name="uq_user_artist_stat"),
        Index("ix_user_artist_stats_user_known", "user_id", "known_track_count"),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    artist_id: Mapped[str] = mapped_column(
        String(128), ForeignKey("artists.id", ondelete="CASCADE"), primary_key=True
    )
    known_track_count: Mapped[int] = mapped_column(Integer, default=0)
    wave_track_count: Mapped[int] = mapped_column(Integer, default=0)
    collection_track_count: Mapped[int] = mapped_column(Integer, default=0)
    collection_album_count: Mapped[int] = mapped_column(Integer, default=0)
    is_liked_artist: Mapped[bool] = mapped_column(Boolean, default=False)
    liked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    raw: Mapped[dict] = mapped_column(JSONB, default=dict)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class ArtistEdge(Base):
    __tablename__ = "artist_edges"
    __table_args__ = (
        UniqueConstraint("source_artist_id", "target_artist_id", "type", name="uq_artist_edge"),
        Index("ix_artist_edges_source_type", "source_artist_id", "type"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    source_artist_id: Mapped[str] = mapped_column(String(128), ForeignKey("artists.id", ondelete="CASCADE"))
    target_artist_id: Mapped[str] = mapped_column(String(128), ForeignKey("artists.id", ondelete="CASCADE"))
    type: Mapped[str] = mapped_column(String(32))
    weight: Mapped[int] = mapped_column(Integer, default=1)
    tracks: Mapped[list] = mapped_column(JSONB, default=list)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class FriendInvite(Base):
    __tablename__ = "friend_invites"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    inviter_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"))
    code: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    accepted_by_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Friendship(Base):
    __tablename__ = "friendships"
    __table_args__ = (UniqueConstraint("user_id", "friend_id", name="uq_friendship_pair"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"))
    friend_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    can_view_full_graph: Mapped[bool] = mapped_column(Boolean, default=True)
