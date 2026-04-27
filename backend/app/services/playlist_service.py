from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from sqlalchemy import desc, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.security import decrypt_secret
from app.db.models import Artist, Track, TrackArtist, User, UserListen, YandexCredential
from app.schemas.playlist import (
    PlaylistBuildRequest,
    PlaylistCreateRequest,
    PlaylistCreateResponse,
    PlaylistPreviewResponse,
    PlaylistTrackOut,
)


@dataclass
class PlaylistTrackCandidate:
    id: str
    title: str
    artists: list[str]
    cover: str | None
    album_id: str | None
    sources: list[str]
    raw: dict[str, Any]


SOURCE_LABELS = {
    "known": "Music Graph: знакомые треки",
    "liked": "Music Graph: лайкнутые треки",
    "wave": "Music Graph: волна",
    "graph": "Music Graph: треки из графа",
}

SOURCE_FILTERS = {
    "known": ("familiar_wave", "familiar_collection"),
    "liked": ("liked_tracks",),
    "wave": ("my_wave", "familiar_wave"),
}


def _raw_dict(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if hasattr(value, "to_dict"):
        try:
            raw = value.to_dict()
        except Exception:  # noqa: BLE001 - third-party model conversion should not break playlist creation
            return {}
        return raw if isinstance(raw, dict) else {}
    return {}


def _album_id_from_raw(raw: dict[str, Any]) -> str | None:
    for key in ("album_id", "albumId"):
        value = raw.get(key)
        if value is not None and str(value).strip():
            return str(value)

    albums = raw.get("albums")
    if isinstance(albums, list):
        for album in albums:
            if not isinstance(album, dict):
                continue
            value = album.get("id") or album.get("album_id") or album.get("albumId")
            if value is not None and str(value).strip():
                return str(value)
    return None


def _track_out(track: PlaylistTrackCandidate) -> PlaylistTrackOut:
    return PlaylistTrackOut(
        id=track.id,
        title=track.title,
        artists=track.artists,
        cover=track.cover,
        albumId=track.album_id,
        sources=track.sources,
    )


def _playlist_url(uid: Any, kind: Any) -> str | None:
    if uid is None or kind is None:
        return None
    return f"https://music.yandex.ru/users/{uid}/playlists/{kind}"


async def _music_token(db: AsyncSession, user_id: UUID) -> str:
    credential = await db.get(YandexCredential, user_id)
    if credential is None:
        raise ValueError("No Yandex credentials for this user")

    token = decrypt_secret(credential.encrypted_music_token) or decrypt_secret(credential.encrypted_x_token)
    if not token:
        raise ValueError("Stored Yandex token could not be decrypted")
    return token


def _apply_source_filter(query, source: str):
    if source == "graph":
        return query.where(UserListen.source != "friend_playlist")
    return query.where(UserListen.source.in_(SOURCE_FILTERS[source]))


async def _playlist_candidates(
    db: AsyncSession,
    *,
    user_id: UUID,
    request: PlaylistBuildRequest,
    overfetch: int = 3,
) -> tuple[list[PlaylistTrackCandidate], int]:
    track_id_query = (
        select(Track.id)
        .join(UserListen, UserListen.track_id == Track.id)
        .where(UserListen.user_id == user_id)
    )
    track_id_query = _apply_source_filter(track_id_query, request.source)
    if request.artist_id:
        track_id_query = track_id_query.where(
            Track.id.in_(select(TrackArtist.track_id).where(TrackArtist.artist_id == request.artist_id))
        )

    count_result = await db.execute(select(func.count()).select_from(track_id_query.distinct().subquery()))
    total_available = int(count_result.scalar_one() or 0)

    artist_names = func.array_agg(func.distinct(Artist.name)).label("artist_names")
    sources = func.array_agg(func.distinct(UserListen.source)).label("sources")
    listen_count = func.count(func.distinct(UserListen.id)).label("listen_count")
    last_played = func.max(UserListen.played_at).label("last_played")
    rows_query = (
        select(
            Track.id,
            Track.title,
            Track.cover_uri,
            Track.raw,
            artist_names,
            sources,
            listen_count,
            last_played,
        )
        .join(UserListen, UserListen.track_id == Track.id)
        .join(TrackArtist, TrackArtist.track_id == Track.id)
        .join(Artist, Artist.id == TrackArtist.artist_id)
        .where(UserListen.user_id == user_id, Track.id.in_(track_id_query.distinct()))
        .group_by(Track.id, Track.title, Track.cover_uri, Track.raw)
        .order_by(desc(listen_count), desc(last_played).nullslast(), Track.title.asc())
        .limit(request.limit * overfetch)
    )

    result = await db.execute(rows_query)
    candidates: list[PlaylistTrackCandidate] = []
    for track_id, title, cover, raw, names, source_values, _count, _last_played in result.all():
        raw_payload = _raw_dict(raw)
        candidates.append(
            PlaylistTrackCandidate(
                id=str(track_id),
                title=str(title),
                artists=sorted({name for name in (names or []) if name}),
                cover=cover,
                album_id=_album_id_from_raw(raw_payload),
                sources=sorted({source for source in (source_values or []) if source}),
                raw=raw_payload,
            )
        )

    return candidates, total_available


async def preview_playlist_tracks(
    db: AsyncSession,
    *,
    user_id: UUID,
    request: PlaylistBuildRequest,
) -> PlaylistPreviewResponse:
    candidates, total_available = await _playlist_candidates(db, user_id=user_id, request=request)
    usable = [track for track in candidates if track.album_id][: request.limit]
    skipped_without_album = max(0, min(len(candidates), request.limit) - len(usable))
    return PlaylistPreviewResponse(
        source=request.source,
        titleSuggestion=SOURCE_LABELS[request.source],
        totalAvailable=total_available,
        usableCount=len(usable),
        skippedWithoutAlbum=skipped_without_album,
        tracks=[_track_out(track) for track in usable],
    )


def _resolve_album_ids_sync(token: str, track_ids: list[str]) -> dict[str, str]:
    from yandex_music import Client

    client = Client(token).init()
    resolved: dict[str, str] = {}
    for track in client.tracks(track_ids) or []:
        raw = _raw_dict(track)
        track_id = str(raw.get("id") or raw.get("real_id") or "")
        album_id = _album_id_from_raw(raw)
        if track_id and album_id:
            resolved[track_id] = album_id
    return resolved


async def _fill_missing_album_ids(token: str, tracks: list[PlaylistTrackCandidate]) -> None:
    missing_ids = [track.id for track in tracks if not track.album_id]
    if not missing_ids or settings.mock_yandex or token.startswith("mock-"):
        return
    resolved = await asyncio.to_thread(_resolve_album_ids_sync, token, missing_ids)
    for track in tracks:
        if not track.album_id:
            track.album_id = resolved.get(track.id)


def _create_yandex_playlist_sync(
    token: str,
    *,
    title: str,
    visibility: str,
    tracks: list[PlaylistTrackCandidate],
) -> tuple[Any, Any, str | None]:
    from yandex_music import Client
    from yandex_music.utils.difference import Difference

    client = Client(token).init()
    playlist = client.users_playlists_create(title=title, visibility=visibility)
    if playlist is None:
        raise RuntimeError("Yandex did not return created playlist")

    kind = getattr(playlist, "kind", None)
    if kind is None:
        raise RuntimeError("Created playlist has no kind")

    revision = getattr(playlist, "revision", None) or 1
    diff = Difference().add_insert(
        0,
        [{"id": track.id, "album_id": track.album_id} for track in tracks if track.album_id],
    )
    updated = client.users_playlists_change(kind=kind, diff=diff.to_json(), revision=revision)
    final_playlist = updated or playlist
    uid = getattr(final_playlist, "uid", None) or getattr(playlist, "uid", None) or client.account_uid
    return kind, getattr(final_playlist, "title", None) or title, _playlist_url(uid, kind)


async def create_playlist_from_graph(
    db: AsyncSession,
    *,
    user: User,
    request: PlaylistCreateRequest,
) -> PlaylistCreateResponse:
    candidates, _total_available = await _playlist_candidates(db, user_id=user.id, request=request, overfetch=4)
    token = await _music_token(db, user.id)
    await _fill_missing_album_ids(token, candidates)
    usable = [track for track in candidates if track.album_id][: request.limit]
    skipped_without_album = max(0, min(len(candidates), request.limit) - len(usable))
    if not usable:
        raise ValueError("No tracks with album ids were found for playlist creation")

    if settings.mock_yandex or token.startswith("mock-"):
        kind = "mock"
        title = request.title
        url = None
    else:
        kind, title, url = await asyncio.to_thread(
            _create_yandex_playlist_sync,
            token,
            title=request.title,
            visibility=request.visibility,
            tracks=usable,
        )

    return PlaylistCreateResponse(
        title=str(title),
        kind=kind,
        url=url,
        addedCount=len(usable),
        skippedWithoutAlbum=skipped_without_album,
        tracks=[_track_out(track) for track in usable],
    )
