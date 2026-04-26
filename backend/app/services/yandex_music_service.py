from __future__ import annotations

import asyncio
import time
from collections.abc import Iterable
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field, replace
from datetime import datetime
from threading import local
from typing import Any

from app.core.config import settings


@dataclass
class ArtistSnapshot:
    id: str
    name: str
    image_url: str | None = None
    raw: dict = field(default_factory=dict)


@dataclass
class TrackSnapshot:
    id: str
    title: str
    artists: list[ArtistSnapshot]
    cover_uri: str | None = None
    duration_ms: int | None = None
    played_at: datetime | None = None
    source: str = "history"
    raw: dict = field(default_factory=dict)


@dataclass
class SimilarArtistSnapshot:
    source_artist_id: str
    artist: ArtistSnapshot
    weight: int = 1


@dataclass
class ArtistCatalogCollabSnapshot:
    source_artist_id: str
    artist: ArtistSnapshot
    weight: int = 1
    tracks: list[str] = field(default_factory=list)


@dataclass
class ArtistFamiliarSnapshot:
    artist_id: str
    known_track_count: int = 0
    wave_track_count: int = 0
    collection_track_count: int = 0
    collection_album_count: int = 0
    raw: dict = field(default_factory=dict)


@dataclass
class LikedArtistSnapshot:
    artist: ArtistSnapshot
    liked_at: datetime | None = None


@dataclass
class ListeningSnapshot:
    tracks: list[TrackSnapshot]
    similar_artists: list[SimilarArtistSnapshot]
    source_status: dict
    artist_familiar: list[ArtistFamiliarSnapshot] = field(default_factory=list)
    catalog_collabs: list[ArtistCatalogCollabSnapshot] = field(default_factory=list)
    liked_artists: list[LikedArtistSnapshot] = field(default_factory=list)
    similar_source_ids: list[str] = field(default_factory=list)
    catalog_source_ids: list[str] = field(default_factory=list)


def _raw_dict(value: Any) -> dict:
    if value is None:
        return {}
    if hasattr(value, "to_dict"):
        try:
            return value.to_dict()
        except Exception:
            return {}
    if isinstance(value, dict):
        return value
    return {}


def _field(value: Any, name: str, default: Any = None) -> Any:
    if isinstance(value, dict):
        return value.get(name, default)
    return getattr(value, name, default)


def _parse_datetime(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _cover_url(cover_uri: str | None) -> str | None:
    if not cover_uri:
        return None
    if cover_uri.startswith("http"):
        return cover_uri
    return f"https://{cover_uri.replace('%%', '400x400')}"


def _artist_from_any(value: Any) -> ArtistSnapshot | None:
    artist_id = _field(value, "id")
    name = _field(value, "name")
    if artist_id is None or not name:
        return None
    cover = _field(value, "cover")
    image = _field(value, "image_url") or _field(value, "og_image")
    if not image and cover:
        image = _field(cover, "uri") or _field(cover, "prefix")
    return ArtistSnapshot(
        id=str(artist_id),
        name=str(name),
        image_url=_cover_url(image),
        raw=_raw_dict(value),
    )


def _track_from_any(value: Any, *, source: str, played_at: datetime | None = None) -> TrackSnapshot | None:
    track = _field(value, "track", value)
    track_id = _field(track, "id") or _field(track, "real_id")
    title = _field(track, "title")
    artists_raw = _field(track, "artists", []) or []
    artists = [artist for artist in (_artist_from_any(item) for item in artists_raw) if artist]
    if track_id is None or not title or not artists:
        return None
    return TrackSnapshot(
        id=str(track_id),
        title=str(title),
        artists=artists,
        cover_uri=_cover_url(_field(track, "cover_uri")),
        duration_ms=_field(track, "duration_ms"),
        played_at=played_at,
        source=source,
        raw=_raw_dict(track),
    )


def _extract_tracks(value: Any, *, source: str) -> list[TrackSnapshot]:
    tracks: list[TrackSnapshot] = []

    def visit(item: Any, depth: int = 0) -> None:
        if item is None or depth > 8:
            return
        maybe_track = _track_from_any(item, source=source, played_at=_field(item, "played_at"))
        if maybe_track:
            tracks.append(maybe_track)
            return
        if isinstance(item, dict):
            for nested in item.values():
                visit(nested, depth + 1)
            return
        if isinstance(item, list | tuple | set):
            for nested in item:
                visit(nested, depth + 1)
            return
        for attr in ("items", "tracks", "track_ids", "events", "track"):
            nested = getattr(item, attr, None)
            if nested is not None:
                visit(nested, depth + 1)

    visit(value)
    return tracks


def _tracks_from_likes(likes: Any) -> list[TrackSnapshot]:
    if likes is None:
        return []

    short_tracks = list(getattr(likes, "tracks", []) or [])
    full_by_id: dict[str, Any] = {}
    fetch_tracks = getattr(likes, "fetch_tracks", None)
    if callable(fetch_tracks):
        for full_track in fetch_tracks() or []:
            track_id = str(_field(full_track, "id") or _field(full_track, "real_id") or "")
            if track_id:
                full_by_id[track_id] = full_track

    tracks: list[TrackSnapshot] = []
    for short_track in short_tracks:
        track_id = str(_field(short_track, "id") or "")
        full_track = _field(short_track, "track") or full_by_id.get(track_id) or short_track
        liked_at = _parse_datetime(_field(short_track, "timestamp"))
        maybe_track = _track_from_any(full_track, source="liked_tracks", played_at=liked_at)
        if maybe_track:
            tracks.append(maybe_track)

    if tracks:
        return tracks

    return _extract_tracks(likes, source="liked_tracks")


def _track_id_from_ref(value: Any) -> str | None:
    track = _field(value, "track")
    data = _field(value, "data")
    item_id = _field(data, "item_id") if data is not None else None
    full_model = _field(data, "full_model") if data is not None else None
    for source in (value, track, data, item_id, full_model):
        if source is None:
            continue
        for field_name in ("id", "track_id", "trackId", "real_id", "realId"):
            track_id = _field(source, field_name)
            if track_id is not None and str(track_id).strip():
                return str(track_id)
    return None


def _played_at_from_ref(value: Any, fallback: datetime | None = None) -> datetime | None:
    return (
        _parse_datetime(_field(value, "timestamp"))
        or _parse_datetime(_field(value, "played_at"))
        or _parse_datetime(_field(value, "playedAt"))
        or fallback
    )


def _history_track_refs(history: Any) -> list[tuple[str, datetime | None]]:
    refs: list[tuple[str, datetime | None]] = []
    tabs = _field(history, "history_tabs") or _field(history, "historyTabs") or []

    for tab in tabs:
        for item in _field(tab, "items", []) or []:
            item_played_at = _played_at_from_ref(item)
            for track_ref in _field(item, "tracks", []) or []:
                track_id = _track_id_from_ref(track_ref)
                if track_id:
                    refs.append((track_id, _played_at_from_ref(track_ref, item_played_at)))

    return refs


def _resolve_history_tracks(
    client: Any,
    refs: list[tuple[str, datetime | None]],
    *,
    batch_size: int = 100,
) -> tuple[list[TrackSnapshot], int, int]:
    if not refs:
        return [], 0, 0

    full_by_id: dict[str, TrackSnapshot] = {}
    failures = 0
    ordered_ids = _unique_ids(track_id for track_id, _played_at in refs)
    for index in range(0, len(ordered_ids), batch_size):
        batch = ordered_ids[index : index + batch_size]
        try:
            full_tracks = client.tracks(batch)
        except Exception:  # noqa: BLE001
            failures += len(batch)
            continue
        for full_track in full_tracks or []:
            track = _track_from_any(full_track, source="history")
            if track:
                full_by_id[track.id] = track

    tracks: list[TrackSnapshot] = []
    missing = 0
    for track_id, played_at in refs:
        track = full_by_id.get(track_id)
        if track is None:
            missing += 1
            continue
        tracks.append(replace(track, played_at=played_at, source="history"))

    return tracks, missing, failures


def _tracks_from_history(client: Any, history: Any) -> tuple[list[TrackSnapshot], int, int, int]:
    refs = _history_track_refs(history)
    embedded_tracks = _extract_tracks(history, source="history")
    if not refs:
        return embedded_tracks, 0, 0, 0

    resolved_tracks, missing, failures = _resolve_history_tracks(client, refs)
    return _dedupe_tracks([*resolved_tracks, *embedded_tracks]), len(refs), missing, failures


def _liked_artists_from_likes(likes: Any) -> list[LikedArtistSnapshot]:
    result: list[LikedArtistSnapshot] = []
    for item in likes or []:
        artist = _artist_from_any(_field(item, "artist", item))
        if not artist:
            continue
        result.append(LikedArtistSnapshot(artist=artist, liked_at=_parse_datetime(_field(item, "timestamp"))))
    return result


def _dedupe_tracks(tracks: Iterable[TrackSnapshot]) -> list[TrackSnapshot]:
    seen: set[tuple[str, str, str | None]] = set()
    result: list[TrackSnapshot] = []
    for index, track in enumerate(tracks):
        played = track.played_at.isoformat() if track.played_at else str(index)
        key = (track.id, track.source, played)
        if key in seen:
            continue
        seen.add(key)
        result.append(track)
    return result


def _unique_ids(values: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    ordered: list[str] = []
    for value in values:
        if not value or value in seen:
            continue
        seen.add(value)
        ordered.append(value)
    return ordered


def _run_threaded(items: Iterable[str], task) -> tuple[list[Any], int]:
    ordered_items = list(items)
    if not ordered_items:
        return [], 0

    results: list[Any] = []
    failures = 0
    max_workers = max(1, min(settings.external_fetch_workers, len(ordered_items)))

    if max_workers == 1:
        for item in ordered_items:
            try:
                result = task(item)
            except Exception:  # noqa: BLE001
                failures += 1
                continue
            if result is not None:
                results.append(result)
        return results, failures

    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {executor.submit(task, item): item for item in ordered_items}
        for future in as_completed(futures):
            try:
                result = future.result()
            except Exception:  # noqa: BLE001
                failures += 1
                continue
            if result is not None:
                results.append(result)

    return results, failures


def _format_seconds(seconds: float) -> str:
    return f"{seconds:.1f}s"


def _status_with_duration(message: str, seconds: float) -> str:
    return f"{message} / {_format_seconds(seconds)}"


def _elapsed_status(message: str, started_at: float) -> str:
    return _status_with_duration(message, time.perf_counter() - started_at)


def _int_field(value: Any, name: str) -> int:
    raw_value = _field(value, name, 0)
    if isinstance(raw_value, bool):
        return int(raw_value)
    if isinstance(raw_value, int):
        return raw_value
    if isinstance(raw_value, str) and raw_value.isdigit():
        return int(raw_value)
    return 0


def _artist_familiar_from_info(artist_id: str, value: Any) -> ArtistFamiliarSnapshot | None:
    raw = _raw_dict(value)
    wave = _field(value, "wave", {}) or {}
    collection = _field(value, "collection", {}) or {}
    wave_track_count = _int_field(wave, "trackCount")
    collection_track_count = _int_field(collection, "trackCount")
    collection_album_count = _int_field(collection, "albumCount")
    known_track_count = wave_track_count + collection_track_count
    if known_track_count == 0 and collection_album_count == 0 and not raw:
        return None
    return ArtistFamiliarSnapshot(
        artist_id=artist_id,
        known_track_count=known_track_count,
        wave_track_count=wave_track_count,
        collection_track_count=collection_track_count,
        collection_album_count=collection_album_count,
        raw=raw,
    )


def _fetch_artist_familiar(client: Any, artist_id: str) -> ArtistFamiliarSnapshot | None:
    response = client._request.get(
        f"{client.base_url}/artists/{artist_id}/familiar-you/info"
        "?withWaveInfo=true&withCollectionInfo=true"
    )
    return _artist_familiar_from_info(artist_id, response)


def _catalog_collabs_from_tracks(
    source_artist_id: str, tracks: Iterable[TrackSnapshot]
) -> list[ArtistCatalogCollabSnapshot]:
    by_artist_id: dict[str, ArtistCatalogCollabSnapshot] = {}
    for track in tracks:
        artist_ids = {artist.id for artist in track.artists}
        if source_artist_id not in artist_ids:
            continue
        for artist in track.artists:
            if artist.id == source_artist_id:
                continue
            collab = by_artist_id.get(artist.id)
            if collab is None:
                collab = ArtistCatalogCollabSnapshot(source_artist_id=source_artist_id, artist=artist, weight=0)
                by_artist_id[artist.id] = collab
            collab.weight += 1
            if track.title not in collab.tracks and len(collab.tracks) < settings.edge_track_title_limit:
                collab.tracks.append(track.title)
    return sorted(by_artist_id.values(), key=lambda item: (item.weight, item.artist.name.lower()), reverse=True)


def _artist_catalog_tracks(client: Any, artist_id: str, *, track_limit: int | None = None) -> list[TrackSnapshot]:
    tracks: list[TrackSnapshot] = []
    seen_track_ids: set[str] = set()
    page = 0
    page_size = max(settings.catalog_tracks_page_size, 1)
    track_limit = max(track_limit or settings.catalog_tracks_limit_per_artist, 1)

    while len(tracks) < track_limit:
        response = client.artists_tracks(artist_id, page=page, page_size=page_size)
        page_tracks = _extract_tracks(response, source="artist_catalog")
        new_tracks = [track for track in page_tracks if track.id not in seen_track_ids]
        for track in new_tracks:
            seen_track_ids.add(track.id)
            tracks.append(track)
            if len(tracks) >= track_limit:
                break

        pager = _field(response, "pager", {}) or {}
        total = _int_field(pager, "total")
        page += 1
        if not page_tracks or not new_tracks:
            break
        if total and page * page_size >= total:
            break
        if len(page_tracks) < page_size:
            break

    return tracks


def _catalog_collabs_for_artist(
    client: Any, artist_id: str, *, track_limit: int | None = None
) -> tuple[list[ArtistCatalogCollabSnapshot], int]:
    catalog_tracks = _artist_catalog_tracks(client, artist_id, track_limit=track_limit)
    return _catalog_collabs_from_tracks(artist_id, catalog_tracks), len(catalog_tracks)


def _similar_from_artist(client: Any, artist_id: str) -> list[SimilarArtistSnapshot]:
    response = client.artists_similar(artist_id)
    raw_artists = response if isinstance(response, list) else getattr(
        response, "similar_artists", getattr(response, "artists", response)
    )
    extracted = [
        artist
        for artist in (_artist_from_any(item) for item in raw_artists or [])
        if artist is not None
    ][: settings.similar_artists_per_source]
    return [SimilarArtistSnapshot(source_artist_id=artist_id, artist=artist) for artist in extracted]


def _mock_snapshot() -> ListeningSnapshot:
    artists = [
        ArtistSnapshot("a1", "Noize MC"),
        ArtistSnapshot("a2", "Monetochka"),
        ArtistSnapshot("a3", "Oxxxymiron"),
        ArtistSnapshot("a4", "ATL"),
        ArtistSnapshot("a5", "Shortparis"),
        ArtistSnapshot("a6", "Husky"),
    ]
    tracks = [
        TrackSnapshot("t1", "Mock Collab One", [artists[0], artists[1]], source="history"),
        TrackSnapshot("t2", "Mock Collab Two", [artists[0], artists[2]], source="history"),
        TrackSnapshot("t3", "Mock Wave", [artists[3]], source="my_wave"),
        TrackSnapshot("t4", "Mock Repeat", [artists[0]], source="history"),
        TrackSnapshot("t4", "Mock Repeat", [artists[0]], source="history"),
        TrackSnapshot("t5", "Mock Pulse", [artists[4], artists[5]], source="my_wave"),
    ]
    similar = [
        SimilarArtistSnapshot("a1", artists[2]),
        SimilarArtistSnapshot("a3", artists[5]),
        SimilarArtistSnapshot("a4", artists[4]),
    ]
    catalog_collabs = [
        ArtistCatalogCollabSnapshot("a1", artists[3], weight=4, tracks=["Full Catalog Song"]),
        ArtistCatalogCollabSnapshot("a3", artists[4], weight=2, tracks=["Another Catalog Song"]),
    ]
    liked_artists = [LikedArtistSnapshot(artists[0]), LikedArtistSnapshot(artists[4])]
    familiar = [
        ArtistFamiliarSnapshot("a1", known_track_count=8, wave_track_count=6, collection_track_count=2),
        ArtistFamiliarSnapshot("a3", known_track_count=3, wave_track_count=2, collection_track_count=1),
    ]
    return ListeningSnapshot(
        tracks=tracks,
        similar_artists=similar,
        source_status={"history": "mock", "my_wave": "mock", "similar": "mock", "catalog_collabs": "mock"},
        artist_familiar=familiar,
        catalog_collabs=catalog_collabs,
        liked_artists=liked_artists,
        similar_source_ids=["a1", "a3", "a4"],
        catalog_source_ids=["a1", "a3"],
    )


def _fetch_snapshot_sync(token: str) -> ListeningSnapshot:
    from yandex_music import Client

    sync_started_at = time.perf_counter()
    client = Client(token).init()
    worker_state = local()
    source_status: dict[str, str] = {}
    tracks: list[TrackSnapshot] = []
    liked_artists: list[LikedArtistSnapshot] = []

    def worker_client():
        thread_client = getattr(worker_state, "client", None)
        if thread_client is None:
            thread_client = Client(token).init()
            worker_state.client = thread_client
        return thread_client

    stage_started_at = time.perf_counter()
    try:
        liked = client.users_likes_tracks()
        liked_tracks = _tracks_from_likes(liked)
        tracks.extend(liked_tracks)
        source_status["liked_tracks"] = _elapsed_status(f"ok: {len(liked_tracks)} tracks", stage_started_at)
    except Exception as exc:  # noqa: BLE001
        source_status["liked_tracks"] = _elapsed_status(f"failed: {exc}", stage_started_at)

    stage_started_at = time.perf_counter()
    try:
        raw_liked_artists = client.users_likes_artists()
        liked_artists = _liked_artists_from_likes(raw_liked_artists)
        source_status["liked_artists"] = _elapsed_status(f"ok: {len(liked_artists)} artists", stage_started_at)
    except Exception as exc:  # noqa: BLE001
        source_status["liked_artists"] = _elapsed_status(f"failed: {exc}", stage_started_at)

    history_started_at = time.perf_counter()
    history = None
    history_refs_count = 0
    history_missing_count = 0
    history_resolve_failures = 0
    history_tracks: list[TrackSnapshot] = []
    stage_started_at = time.perf_counter()
    try:
        history = client.music_history()
        history_refs_count = len(_history_track_refs(history))
        source_status["history_fetch"] = _elapsed_status(f"ok: {history_refs_count} refs", stage_started_at)
    except Exception as exc:  # noqa: BLE001
        source_status["history_fetch"] = _elapsed_status(f"failed: {exc}", stage_started_at)

    stage_started_at = time.perf_counter()
    if history is None:
        source_status["history_resolve"] = _elapsed_status("skipped", stage_started_at)
        source_status["history"] = _status_with_duration(
            "failed: history fetch did not return data",
            time.perf_counter() - history_started_at,
        )
    else:
        try:
            history_tracks, history_refs_count, history_missing_count, history_resolve_failures = _tracks_from_history(
                client,
                history,
            )
            tracks.extend(history_tracks)
            resolve_message = f"ok: {len(history_tracks)} tracks from {history_refs_count} refs"
            if history_missing_count:
                resolve_message += f" ({history_missing_count} unresolved)"
            if history_resolve_failures:
                resolve_message += f" ({history_resolve_failures} ids failed)"
            source_status["history_resolve"] = _elapsed_status(resolve_message, stage_started_at)
            source_status["history"] = _status_with_duration(
                resolve_message,
                time.perf_counter() - history_started_at,
            )
        except Exception as exc:  # noqa: BLE001
            source_status["history_resolve"] = _elapsed_status(f"failed: {exc}", stage_started_at)
            source_status["history"] = _status_with_duration(
                f"failed: {exc}",
                time.perf_counter() - history_started_at,
            )

    stage_started_at = time.perf_counter()
    try:
        wave_items = client.music_history_items(wave_seeds=[["user:onyourwave"]])
        wave_tracks = _extract_tracks(wave_items, source="my_wave")
        tracks.extend(wave_tracks)
        source_status["my_wave"] = _elapsed_status(f"ok: {len(wave_tracks)} tracks", stage_started_at)
    except Exception as exc:  # noqa: BLE001
        source_status["my_wave"] = _elapsed_status(f"failed: {exc}", stage_started_at)

    tracks = _dedupe_tracks(tracks)

    listen_counts: dict[str, int] = {}
    artist_by_id: dict[str, ArtistSnapshot] = {}
    for track in tracks:
        for artist in track.artists:
            artist_by_id[artist.id] = artist
            listen_counts[artist.id] = listen_counts.get(artist.id, 0) + 1

    familiar_by_artist_id: dict[str, ArtistFamiliarSnapshot] = {}
    known_counts: dict[str, int] = {}

    def store_familiar(familiar: ArtistFamiliarSnapshot | None) -> None:
        if familiar is None:
            return
        familiar_by_artist_id[familiar.artist_id] = familiar
        known_counts[familiar.artist_id] = familiar.known_track_count

    familiar_base_seconds = 0.0
    familiar_neighbors_seconds = 0.0
    familiar_depth_seconds = 0.0
    catalog_base_seconds = 0.0
    catalog_depth_seconds = 0.0
    similar_base_seconds = 0.0
    similar_depth_seconds = 0.0

    base_familiar_source_ids = _unique_ids(
        artist_id
        for artist_id, _count in sorted(listen_counts.items(), key=lambda item: item[1], reverse=True)[
            : settings.familiar_source_limit
        ]
    )
    stage_started_at = time.perf_counter()
    familiar_results, familiar_failures = _run_threaded(
        base_familiar_source_ids,
        lambda artist_id: _fetch_artist_familiar(worker_client(), artist_id),
    )
    for familiar in familiar_results:
        store_familiar(familiar)

    liked_artist_ids = {liked_artist.artist.id for liked_artist in liked_artists}
    missing_liked_familiar_ids = [artist_id for artist_id in sorted(liked_artist_ids) if artist_id not in known_counts]
    liked_familiar_results, liked_familiar_failures = _run_threaded(
        missing_liked_familiar_ids,
        lambda artist_id: _fetch_artist_familiar(worker_client(), artist_id),
    )
    familiar_failures += liked_familiar_failures
    for familiar in liked_familiar_results:
        store_familiar(familiar)
    familiar_base_seconds = time.perf_counter() - stage_started_at
    familiar_base_message = (
        f"ok: {len(familiar_results) + len(liked_familiar_results)} stats from "
        f"{len(base_familiar_source_ids) + len(missing_liked_familiar_ids)} candidates"
    )
    if familiar_failures:
        familiar_base_message += f" ({familiar_failures} failed)"
    source_status["familiar_base"] = _status_with_duration(familiar_base_message, familiar_base_seconds)

    ranked_artist_ids = [
        artist_id
        for artist_id, _count in sorted(
            listen_counts.items(),
            key=lambda item: (known_counts.get(item[0], 0) or item[1], item[1]),
            reverse=True,
        )
    ]

    catalog_collabs: list[ArtistCatalogCollabSnapshot] = []
    catalog_source_count = 0
    catalog_track_count = 0
    catalog_scanned_artist_ids: set[str] = set()
    base_catalog_source_ids = _unique_ids(ranked_artist_ids[: settings.catalog_collab_source_limit])
    stage_started_at = time.perf_counter()
    catalog_results, catalog_failures = _run_threaded(
        base_catalog_source_ids,
        lambda artist_id: (
            artist_id,
            *_catalog_collabs_for_artist(
                worker_client(),
                artist_id,
                track_limit=settings.catalog_tracks_limit_per_artist,
            ),
        ),
    )
    for artist_id, artist_collabs, track_count in catalog_results:
        catalog_track_count += track_count
        catalog_source_count += 1
        catalog_scanned_artist_ids.add(artist_id)
        catalog_collabs.extend(artist_collabs)
    catalog_base_seconds = time.perf_counter() - stage_started_at

    if catalog_collabs:
        catalog_message = (
            f"ok: {len(catalog_collabs)} links from {catalog_source_count} artists / {catalog_track_count} tracks"
        )
    elif catalog_failures:
        catalog_message = f"empty ({catalog_failures} sources failed)"
    else:
        catalog_message = "empty"
    source_status["catalog_base"] = _status_with_duration(catalog_message, catalog_base_seconds)
    source_status["catalog_collabs"] = _status_with_duration(catalog_message, catalog_base_seconds)

    similar: list[SimilarArtistSnapshot] = []
    similar_scanned_artist_ids: set[str] = set()
    base_similar_source_ids = _unique_ids(ranked_artist_ids[: settings.similar_source_limit])
    stage_started_at = time.perf_counter()
    similar_results, similar_failures = _run_threaded(
        base_similar_source_ids,
        lambda artist_id: (artist_id, _similar_from_artist(worker_client(), artist_id)),
    )
    for artist_id, artist_similar in similar_results:
        similar.extend(artist_similar)
        similar_scanned_artist_ids.add(artist_id)
    similar_base_seconds = time.perf_counter() - stage_started_at

    if similar:
        similar_message = f"ok: {len(similar)} artists"
    elif similar_failures:
        similar_message = f"empty ({similar_failures} sources failed)"
    else:
        similar_message = "empty"
    source_status["similar_base"] = _status_with_duration(similar_message, similar_base_seconds)
    source_status["similar"] = _status_with_duration(similar_message, similar_base_seconds)

    existing_familiar_ids = set(familiar_by_artist_id)
    neighbor_scores: dict[str, int] = {}
    for collab in catalog_collabs:
        if collab.artist.id not in existing_familiar_ids:
            neighbor_scores[collab.artist.id] = max(neighbor_scores.get(collab.artist.id, 0), collab.weight * 3)
    for item in similar:
        if item.artist.id not in existing_familiar_ids:
            neighbor_scores[item.artist.id] = max(neighbor_scores.get(item.artist.id, 0), item.weight)

    neighbor_familiar_source_ids = _unique_ids(
        artist_id
        for artist_id, _score in sorted(neighbor_scores.items(), key=lambda item: item[1], reverse=True)[
            : settings.familiar_neighbor_source_limit
        ]
    )
    stage_started_at = time.perf_counter()
    neighbor_familiar_results, neighbor_familiar_failures = _run_threaded(
        neighbor_familiar_source_ids,
        lambda artist_id: _fetch_artist_familiar(worker_client(), artist_id),
    )
    neighbor_familiar_count = 0
    for familiar in neighbor_familiar_results:
        if familiar and familiar.artist_id not in existing_familiar_ids:
            neighbor_familiar_count += 1
        store_familiar(familiar)
        if familiar:
            existing_familiar_ids.add(familiar.artist_id)
    familiar_neighbors_seconds = time.perf_counter() - stage_started_at
    familiar_neighbors_message = (
        f"ok: {neighbor_familiar_count} new stats from {len(neighbor_familiar_source_ids)} candidates"
    )
    if neighbor_familiar_failures:
        familiar_neighbors_message += f" ({neighbor_familiar_failures} failed)"
    source_status["familiar_neighbors"] = _status_with_duration(
        familiar_neighbors_message,
        familiar_neighbors_seconds,
    )

    deep_catalog_collabs: list[ArtistCatalogCollabSnapshot] = []
    deep_catalog_source_count = 0
    deep_catalog_track_count = 0
    deep_catalog_source_scores: dict[str, int] = {}
    for collab in catalog_collabs:
        if collab.artist.id in catalog_scanned_artist_ids:
            continue
        known_count = known_counts.get(collab.artist.id, 0)
        deep_catalog_source_scores[collab.artist.id] = max(
            deep_catalog_source_scores.get(collab.artist.id, 0),
            max(known_count, 1) * 100 + collab.weight * 3,
        )

    deep_catalog_source_ids = _unique_ids(
        artist_id
        for artist_id, _score in sorted(deep_catalog_source_scores.items(), key=lambda item: item[1], reverse=True)[
            : settings.deep_catalog_collab_source_limit
        ]
    )
    missing_deep_catalog_familiar_ids = [
        artist_id for artist_id in deep_catalog_source_ids if artist_id not in existing_familiar_ids
    ]
    stage_started_at = time.perf_counter()
    deep_catalog_familiar_results, deep_catalog_familiar_failures = _run_threaded(
        missing_deep_catalog_familiar_ids,
        lambda artist_id: _fetch_artist_familiar(worker_client(), artist_id),
    )
    familiar_failures += deep_catalog_familiar_failures
    deep_catalog_source_familiar_count = 0
    for familiar in deep_catalog_familiar_results:
        if familiar and familiar.artist_id not in existing_familiar_ids:
            deep_catalog_source_familiar_count += 1
        store_familiar(familiar)
        if familiar:
            existing_familiar_ids.add(familiar.artist_id)
    familiar_depth_seconds += time.perf_counter() - stage_started_at

    stage_started_at = time.perf_counter()
    deep_catalog_results, deep_catalog_failures = _run_threaded(
        deep_catalog_source_ids,
        lambda artist_id: (
            artist_id,
            *_catalog_collabs_for_artist(
                worker_client(),
                artist_id,
                track_limit=settings.deep_catalog_tracks_limit_per_artist,
            ),
        ),
    )
    catalog_failures += deep_catalog_failures
    for artist_id, artist_collabs, track_count in deep_catalog_results:
        catalog_track_count += track_count
        catalog_source_count += 1
        deep_catalog_track_count += track_count
        deep_catalog_source_count += 1
        catalog_scanned_artist_ids.add(artist_id)
        catalog_collabs.extend(artist_collabs)
        deep_catalog_collabs.extend(artist_collabs)
    catalog_depth_seconds = time.perf_counter() - stage_started_at
    catalog_depth_message = (
        f"ok: {sum(len(item[1]) for item in deep_catalog_results)} links from "
        f"{deep_catalog_source_count} artists / {deep_catalog_track_count} tracks"
    )
    if deep_catalog_failures:
        catalog_depth_message += f" ({deep_catalog_failures} failed)"
    source_status["catalog_depth"] = _status_with_duration(catalog_depth_message, catalog_depth_seconds)

    deep_similar: list[SimilarArtistSnapshot] = []
    deep_similar_source_count = 0
    deep_similar_source_scores: dict[str, int] = {}
    for item in similar:
        if item.artist.id in similar_scanned_artist_ids:
            continue
        known_count = known_counts.get(item.artist.id, 0)
        if known_count > 0:
            deep_similar_source_scores[item.artist.id] = max(
                deep_similar_source_scores.get(item.artist.id, 0),
                known_count * 100 + item.weight,
            )

    deep_similar_source_ids = _unique_ids(
        artist_id
        for artist_id, _score in sorted(deep_similar_source_scores.items(), key=lambda item: item[1], reverse=True)[
            : settings.deep_similar_source_limit
        ]
    )
    stage_started_at = time.perf_counter()
    deep_similar_results, deep_similar_failures = _run_threaded(
        deep_similar_source_ids,
        lambda artist_id: (artist_id, _similar_from_artist(worker_client(), artist_id)),
    )
    similar_failures += deep_similar_failures
    for artist_id, artist_similar in deep_similar_results:
        similar.extend(artist_similar)
        deep_similar.extend(artist_similar)
        similar_scanned_artist_ids.add(artist_id)
        deep_similar_source_count += 1
    similar_depth_seconds = time.perf_counter() - stage_started_at
    similar_depth_message = f"ok: {len(deep_similar)} artists from {deep_similar_source_count} sources"
    if deep_similar_failures:
        similar_depth_message += f" ({deep_similar_failures} failed)"
    source_status["similar_depth"] = _status_with_duration(similar_depth_message, similar_depth_seconds)

    deep_neighbor_scores: dict[str, int] = {}
    for collab in deep_catalog_collabs:
        if collab.artist.id not in existing_familiar_ids:
            deep_neighbor_scores[collab.artist.id] = max(
                deep_neighbor_scores.get(collab.artist.id, 0),
                known_counts.get(collab.source_artist_id, 0) * 100 + collab.weight * 3,
            )
    for item in deep_similar:
        if item.artist.id not in existing_familiar_ids:
            deep_neighbor_scores[item.artist.id] = max(
                deep_neighbor_scores.get(item.artist.id, 0),
                known_counts.get(item.source_artist_id, 0) * 100 + item.weight,
            )

    deep_neighbor_familiar_source_ids = _unique_ids(
        artist_id
        for artist_id, _score in sorted(deep_neighbor_scores.items(), key=lambda item: item[1], reverse=True)[
            : settings.deep_familiar_source_limit
        ]
    )
    stage_started_at = time.perf_counter()
    deep_neighbor_familiar_results, deep_neighbor_familiar_failures = _run_threaded(
        deep_neighbor_familiar_source_ids,
        lambda artist_id: _fetch_artist_familiar(worker_client(), artist_id),
    )
    deep_neighbor_familiar_count = 0
    for familiar in deep_neighbor_familiar_results:
        if familiar and familiar.artist_id not in existing_familiar_ids:
            deep_neighbor_familiar_count += 1
        store_familiar(familiar)
        if familiar:
            existing_familiar_ids.add(familiar.artist_id)
    familiar_depth_seconds += time.perf_counter() - stage_started_at
    familiar_depth_count = deep_catalog_source_familiar_count + deep_neighbor_familiar_count
    familiar_depth_candidates = len(missing_deep_catalog_familiar_ids) + len(deep_neighbor_familiar_source_ids)
    familiar_depth_failures = deep_catalog_familiar_failures + deep_neighbor_familiar_failures
    familiar_depth_message = f"ok: {familiar_depth_count} new stats from {familiar_depth_candidates} candidates"
    if familiar_depth_failures:
        familiar_depth_message += f" ({familiar_depth_failures} failed)"
    source_status["familiar_depth"] = _status_with_duration(familiar_depth_message, familiar_depth_seconds)

    artist_familiar = list(familiar_by_artist_id.values())

    if deep_catalog_source_count:
        catalog_message = (
            f"ok: {len(catalog_collabs)} links from {catalog_source_count} artists / {catalog_track_count} tracks "
            f"(depth: {deep_catalog_source_count} artists / {deep_catalog_track_count} tracks)"
        )
    source_status["catalog_collabs"] = _status_with_duration(
        catalog_message,
        catalog_base_seconds + catalog_depth_seconds,
    )

    if deep_similar_source_count:
        similar_message = f"ok: {len(similar)} artists (depth: {deep_similar_source_count} sources)"
    source_status["similar"] = _status_with_duration(similar_message, similar_base_seconds + similar_depth_seconds)

    if artist_familiar:
        depth_familiar_count = deep_catalog_source_familiar_count + deep_neighbor_familiar_count
        familiar_message = (
            f"ok: {len(artist_familiar)} artists "
            f"({neighbor_familiar_count} external, {depth_familiar_count} depth)"
        )
    elif familiar_failures or neighbor_familiar_failures or deep_neighbor_familiar_failures:
        familiar_message = (
            f"empty ({familiar_failures + neighbor_familiar_failures + deep_neighbor_familiar_failures} sources failed)"
        )
    else:
        familiar_message = "empty"
    source_status["familiar_you"] = _status_with_duration(
        familiar_message,
        familiar_base_seconds + familiar_neighbors_seconds + familiar_depth_seconds,
    )
    source_status["sync_total"] = _status_with_duration(
        "fetch_snapshot",
        time.perf_counter() - sync_started_at,
    )
    return ListeningSnapshot(
        tracks=tracks,
        similar_artists=similar,
        source_status=source_status,
        artist_familiar=artist_familiar,
        catalog_collabs=catalog_collabs,
        liked_artists=liked_artists,
        similar_source_ids=sorted(similar_scanned_artist_ids),
        catalog_source_ids=sorted(catalog_scanned_artist_ids),
    )


async def fetch_listening_snapshot(token: str) -> ListeningSnapshot:
    if settings.mock_yandex or token.startswith("mock-"):
        return _mock_snapshot()
    return await asyncio.to_thread(_fetch_snapshot_sync, token)


def _fetch_artist_familiar_batch_sync(token: str, artist_ids: list[str]) -> list[ArtistFamiliarSnapshot]:
    from yandex_music import Client

    worker_state = local()

    def worker_client():
        thread_client = getattr(worker_state, "client", None)
        if thread_client is None:
            thread_client = Client(token).init()
            worker_state.client = thread_client
        return thread_client

    results, _failures = _run_threaded(
        _unique_ids(artist_ids),
        lambda artist_id: _fetch_artist_familiar(worker_client(), artist_id),
    )
    return [item for item in results if item is not None]


async def fetch_artist_familiar_batch(token: str, artist_ids: Iterable[str]) -> list[ArtistFamiliarSnapshot]:
    artist_id_list = _unique_ids(artist_ids)
    if not artist_id_list or settings.mock_yandex or token.startswith("mock-"):
        return []
    return await asyncio.to_thread(_fetch_artist_familiar_batch_sync, token, artist_id_list)
