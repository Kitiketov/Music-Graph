from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from sqlalchemy import desc, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.core.config import settings
from app.core.security import decrypt_secret
from app.db.models import (
    Artist,
    ArtistEdge,
    Friendship,
    Track,
    TrackArtist,
    User,
    UserArtistStat,
    UserListen,
    YandexCredential,
)
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
    "friend_common": "Music Graph: пересечения с другом",
    "unheard_collabs": "Music Graph: новые коллабы",
    "unheard_liked_collabs": "Music Graph: новые коллабы любимых",
    "friend_unheard_collabs": "Music Graph: новые коллабы общих артистов",
}

SOURCE_FILTERS = {
    "known": ("familiar_wave", "familiar_collection"),
    "liked": ("liked_tracks",),
    "wave": ("my_wave", "familiar_wave"),
}

EDGE_PLAYLIST_SOURCES = {"unheard_collabs", "unheard_liked_collabs", "friend_unheard_collabs"}


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


def _normalize_track_title(title: str) -> str:
    return " ".join(title.casefold().strip().split())


def _artist_names_from_payload(raw_artists: Any, fallback: list[str]) -> list[str]:
    names: list[str] = []
    if isinstance(raw_artists, list):
        for item in raw_artists:
            if isinstance(item, dict):
                name = item.get("name")
            else:
                name = str(item)
            if name and str(name).strip():
                names.append(str(name).strip())
    return sorted(set(names or fallback))


def _edge_track_payload(value: Any) -> dict[str, Any] | None:
    if isinstance(value, dict):
        title = str(value.get("title") or "").strip()
        track_id = value.get("id") or value.get("trackId") or value.get("track_id")
        if not title:
            return None
        return {
            "id": str(track_id) if track_id is not None and str(track_id).strip() else None,
            "title": title,
            "album_id": value.get("albumId") or value.get("album_id"),
            "cover": value.get("cover"),
            "artists": value.get("artists"),
            "raw": value,
        }
    title = str(value or "").strip()
    if not title:
        return None
    return {"id": None, "title": title, "album_id": None, "cover": None, "artists": None, "raw": {}}


def _track_out(track: PlaylistTrackCandidate) -> PlaylistTrackOut:
    return PlaylistTrackOut(
        id=track.id,
        title=track.title,
        artists=track.artists,
        cover=track.cover,
        albumId=track.album_id,
        sources=track.sources,
    )


def _is_usable_for_yandex(track: PlaylistTrackCandidate) -> bool:
    return bool(track.album_id) and not track.id.startswith("catalog:")


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
    if source == "friend_common":
        return query
    return query.where(UserListen.source.in_(SOURCE_FILTERS[source]))


async def _friend_display_name(db: AsyncSession, *, user_id: UUID, friend_id: UUID | None) -> str | None:
    if friend_id is None:
        return None
    result = await db.execute(
        select(User.display_login)
        .join(Friendship, Friendship.friend_id == User.id)
        .where(Friendship.user_id == user_id, Friendship.friend_id == friend_id)
    )
    return result.scalar_one_or_none()


async def _title_suggestion(db: AsyncSession, *, user_id: UUID, request: PlaylistBuildRequest) -> str:
    if request.source not in {"friend_common", "friend_unheard_collabs"}:
        return SOURCE_LABELS[request.source]
    friend_name = await _friend_display_name(db, user_id=user_id, friend_id=request.friend_id)
    if friend_name and request.source == "friend_common":
        return f"Music Graph: общие с {friend_name}"
    if friend_name and request.source == "friend_unheard_collabs":
        return f"Music Graph: новые коллабы с {friend_name}"
    return SOURCE_LABELS[request.source]


async def _ensure_friend_access(db: AsyncSession, *, user_id: UUID, friend_id: UUID | None) -> UUID:
    if friend_id is None:
        raise ValueError("Choose a friend for intersection playlist")
    result = await db.execute(
        select(Friendship.id).where(Friendship.user_id == user_id, Friendship.friend_id == friend_id)
    )
    if result.scalar_one_or_none() is None:
        raise ValueError("Friendship not found")
    return friend_id


async def _artist_ids_for_playlist(db: AsyncSession, *, user_id: UUID, liked_only: bool = False) -> set[str]:
    stat_conditions = [UserArtistStat.user_id == user_id]
    if liked_only:
        stat_conditions.append(UserArtistStat.is_liked_artist.is_(True))
    else:
        stat_conditions.append(
            or_(
                UserArtistStat.known_track_count > 0,
                UserArtistStat.wave_track_count > 0,
                UserArtistStat.collection_track_count > 0,
                UserArtistStat.is_liked_artist.is_(True),
            )
        )

    stat_ids = set(
        (await db.execute(select(UserArtistStat.artist_id).where(*stat_conditions))).scalars().all()
    )
    if liked_only:
        return stat_ids

    listened_ids = set(
        (
            await db.execute(
                select(TrackArtist.artist_id)
                .join(UserListen, UserListen.track_id == TrackArtist.track_id)
                .where(UserListen.user_id == user_id)
            )
        )
        .scalars()
        .all()
    )
    return stat_ids | listened_ids


async def _listened_track_keys(db: AsyncSession, *, user_id: UUID) -> tuple[set[str], set[str]]:
    rows = await db.execute(
        select(Track.id, Track.title)
        .join(UserListen, UserListen.track_id == Track.id)
        .where(UserListen.user_id == user_id)
    )
    track_ids: set[str] = set()
    titles: set[str] = set()
    for track_id, title in rows.all():
        track_ids.add(str(track_id))
        normalized = _normalize_track_title(str(title))
        if normalized:
            titles.add(normalized)
    return track_ids, titles


async def _edge_playlist_candidates(
    db: AsyncSession,
    *,
    user_id: UUID,
    request: PlaylistBuildRequest,
    overfetch: int = 3,
) -> tuple[list[PlaylistTrackCandidate], int]:
    if request.source == "friend_unheard_collabs":
        friend_id = await _ensure_friend_access(db, user_id=user_id, friend_id=request.friend_id)
        relevant_artist_ids = await _artist_ids_for_playlist(db, user_id=user_id)
        relevant_artist_ids &= await _artist_ids_for_playlist(db, user_id=friend_id)
    else:
        relevant_artist_ids = await _artist_ids_for_playlist(
            db,
            user_id=user_id,
            liked_only=request.source == "unheard_liked_collabs",
        )

    if request.artist_id:
        relevant_artist_ids &= {request.artist_id}
    if not relevant_artist_ids:
        return [], 0

    listened_ids, listened_titles = await _listened_track_keys(db, user_id=user_id)
    edge_rows = await db.execute(
        select(ArtistEdge, Artist.id, Artist.name)
        .join(
            Artist,
            or_(Artist.id == ArtistEdge.source_artist_id, Artist.id == ArtistEdge.target_artist_id),
        )
        .where(
            ArtistEdge.type == "catalog_collab",
            ArtistEdge.source_artist_id.in_(relevant_artist_ids)
            | ArtistEdge.target_artist_id.in_(relevant_artist_ids),
        )
        .order_by(ArtistEdge.weight.desc(), Artist.name.asc())
    )

    artist_names_by_id: dict[str, str] = {}
    edges_by_id: dict[str, ArtistEdge] = {}
    for edge, artist_id, artist_name in edge_rows.all():
        artist_names_by_id[str(artist_id)] = str(artist_name)
        edges_by_id[str(edge.id)] = edge

    candidates: list[PlaylistTrackCandidate] = []
    seen_keys: set[str] = set()
    for edge in edges_by_id.values():
        fallback_artists = [
            name
            for name in [
                artist_names_by_id.get(edge.source_artist_id),
                artist_names_by_id.get(edge.target_artist_id),
            ]
            if name
        ]
        for item in edge.tracks or []:
            payload = _edge_track_payload(item)
            if payload is None:
                continue
            track_id = payload["id"]
            normalized_title = _normalize_track_title(payload["title"])
            if track_id and track_id in listened_ids:
                continue
            if normalized_title and normalized_title in listened_titles:
                continue

            unique_key = track_id or normalized_title
            if not unique_key or unique_key in seen_keys:
                continue
            seen_keys.add(unique_key)
            candidates.append(
                PlaylistTrackCandidate(
                    id=str(track_id or f"catalog:{unique_key}"),
                    title=payload["title"],
                    artists=_artist_names_from_payload(payload["artists"], fallback_artists),
                    cover=str(payload["cover"]) if payload["cover"] else None,
                    album_id=str(payload["album_id"]) if payload["album_id"] else None,
                    sources=["catalog_collab"],
                    raw=_raw_dict(payload["raw"]),
                )
            )

    candidates.sort(
        key=lambda track: (
            not bool(track.album_id and not track.id.startswith("catalog:")),
            track.title.casefold(),
        )
    )
    return candidates[: request.limit * overfetch], len(seen_keys)


async def _playlist_candidates(
    db: AsyncSession,
    *,
    user_id: UUID,
    request: PlaylistBuildRequest,
    overfetch: int = 3,
) -> tuple[list[PlaylistTrackCandidate], int]:
    if request.source in EDGE_PLAYLIST_SOURCES:
        return await _edge_playlist_candidates(db, user_id=user_id, request=request, overfetch=overfetch)

    if request.source == "friend_common":
        friend_id = await _ensure_friend_access(db, user_id=user_id, friend_id=request.friend_id)
        my_listen = aliased(UserListen)
        friend_listen = aliased(UserListen)
        track_id_query = (
            select(my_listen.track_id)
            .join(friend_listen, friend_listen.track_id == my_listen.track_id)
            .where(my_listen.user_id == user_id, friend_listen.user_id == friend_id)
        )
    else:
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
    usable = [track for track in candidates if _is_usable_for_yandex(track)][: request.limit]
    skipped_without_album = max(0, min(len(candidates), request.limit) - len(usable))
    return PlaylistPreviewResponse(
        source=request.source,
        titleSuggestion=await _title_suggestion(db, user_id=user_id, request=request),
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
    missing_ids = [track.id for track in tracks if not track.album_id and not track.id.startswith("catalog:")]
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
    usable = [track for track in candidates if _is_usable_for_yandex(track)][: request.limit]
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
