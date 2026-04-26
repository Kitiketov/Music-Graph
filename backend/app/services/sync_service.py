from __future__ import annotations

import time
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import delete, or_, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.security import decrypt_secret
from app.db.models import (
    Artist,
    ArtistEdge,
    SyncJob,
    Track,
    TrackArtist,
    UserArtistStat,
    UserListen,
    YandexCredential,
)
from app.services.yandex_music_service import (
    ArtistFamiliarSnapshot,
    ListeningSnapshot,
    fetch_artist_familiar_batch,
    fetch_listening_snapshot,
)


def _format_seconds(seconds: float) -> str:
    return f"{seconds:.1f}s"


def _status_with_duration(message: str, seconds: float) -> str:
    return f"{message} / {_format_seconds(seconds)}"


async def set_job_status(
    db: AsyncSession,
    job_id: UUID,
    *,
    status: str,
    progress: int,
    message: str | None = None,
    source_status: dict | None = None,
    error: str | None = None,
) -> None:
    job = await db.get(SyncJob, job_id)
    if job is None:
        return
    job.status = status
    job.progress = progress
    job.message = message
    if source_status is not None:
        job.source_status = source_status
    if error is not None:
        job.error = error
    if status == "running" and job.started_at is None:
        job.started_at = datetime.now(UTC)
    if status in {"completed", "failed"}:
        job.finished_at = datetime.now(UTC)
    await db.commit()


async def _upsert_snapshot(db: AsyncSession, user_id: UUID, snapshot: ListeningSnapshot) -> None:
    for track in snapshot.tracks:
        await db.execute(
            insert(Track)
            .values(
                id=track.id,
                title=track.title,
                cover_uri=track.cover_uri,
                duration_ms=track.duration_ms,
                raw=track.raw,
            )
            .on_conflict_do_update(
                index_elements=[Track.id],
                set_={
                    "title": track.title,
                    "cover_uri": track.cover_uri,
                    "duration_ms": track.duration_ms,
                    "raw": track.raw,
                },
            )
        )
        for artist in track.artists:
            await db.execute(
                insert(Artist)
                .values(id=artist.id, name=artist.name, image_url=artist.image_url, raw=artist.raw)
                .on_conflict_do_update(
                    index_elements=[Artist.id],
                    set_={"name": artist.name, "image_url": artist.image_url, "raw": artist.raw},
                )
            )
            await db.execute(
                insert(TrackArtist)
                .values(track_id=track.id, artist_id=artist.id, role="primary")
                .on_conflict_do_nothing(index_elements=[TrackArtist.track_id, TrackArtist.artist_id])
            )

    # Replace the user's listen facts for a clean resync. Shared tracks/artists stay global.
    await db.execute(delete(UserListen).where(UserListen.user_id == user_id))
    await db.execute(
        update(UserArtistStat)
        .where(UserArtistStat.user_id == user_id)
        .values(is_liked_artist=False, liked_at=None)
    )
    if snapshot.similar_source_ids:
        await db.execute(
            delete(ArtistEdge).where(
                ArtistEdge.type == "similar",
                ArtistEdge.source_artist_id.in_(snapshot.similar_source_ids)
                | ArtistEdge.target_artist_id.in_(snapshot.similar_source_ids),
            )
        )
    if snapshot.catalog_source_ids:
        await db.execute(
            delete(ArtistEdge).where(
                ArtistEdge.type == "catalog_collab",
                ArtistEdge.source_artist_id.in_(snapshot.catalog_source_ids)
                | ArtistEdge.target_artist_id.in_(snapshot.catalog_source_ids),
            )
        )

    for index, track in enumerate(snapshot.tracks):
        played = track.played_at or datetime.now(UTC)
        event_key = f"{user_id}:{track.source}:{track.id}:{played.isoformat()}:{index}"
        await db.execute(
            insert(UserListen)
            .values(
                user_id=user_id,
                track_id=track.id,
                source=track.source,
                played_at=played,
                event_key=event_key,
            )
            .on_conflict_do_nothing(index_elements=[UserListen.event_key])
        )

    for similar in snapshot.similar_artists:
        artist = similar.artist
        await db.execute(
            insert(Artist)
            .values(id=artist.id, name=artist.name, image_url=artist.image_url, raw=artist.raw)
            .on_conflict_do_update(
                index_elements=[Artist.id],
                set_={"name": artist.name, "image_url": artist.image_url, "raw": artist.raw},
            )
        )
        source_id, target_id = sorted([similar.source_artist_id, artist.id])
        if source_id == target_id:
            continue
        await db.execute(
            insert(ArtistEdge)
            .values(
                source_artist_id=source_id,
                target_artist_id=target_id,
                type="similar",
                weight=similar.weight,
                tracks=[],
            )
            .on_conflict_do_update(
                constraint="uq_artist_edge",
                set_={"weight": ArtistEdge.weight + similar.weight},
            )
        )

    for catalog_collab in snapshot.catalog_collabs:
        artist = catalog_collab.artist
        await db.execute(
            insert(Artist)
            .values(id=artist.id, name=artist.name, image_url=artist.image_url, raw=artist.raw)
            .on_conflict_do_update(
                index_elements=[Artist.id],
                set_={"name": artist.name, "image_url": artist.image_url, "raw": artist.raw},
            )
        )
        source_id, target_id = sorted([catalog_collab.source_artist_id, artist.id])
        if source_id == target_id:
            continue
        await db.execute(
            insert(ArtistEdge)
            .values(
                source_artist_id=source_id,
                target_artist_id=target_id,
                type="catalog_collab",
                weight=catalog_collab.weight,
                tracks=catalog_collab.tracks,
            )
            .on_conflict_do_update(
                constraint="uq_artist_edge",
                set_={"weight": catalog_collab.weight, "tracks": catalog_collab.tracks},
            )
        )

    # Liked artists may only appear in familiar-you stats, so ensure FK targets exist before stats are saved.
    for liked_artist in snapshot.liked_artists:
        artist = liked_artist.artist
        await db.execute(
            insert(Artist)
            .values(id=artist.id, name=artist.name, image_url=artist.image_url, raw=artist.raw)
            .on_conflict_do_update(
                index_elements=[Artist.id],
                set_={"name": artist.name, "image_url": artist.image_url, "raw": artist.raw},
            )
        )

    familiar_ids = {item.artist_id for item in snapshot.artist_familiar}
    existing_artist_ids = set()
    if familiar_ids:
        existing_artist_ids = set(
            (await db.execute(select(Artist.id).where(Artist.id.in_(familiar_ids)))).scalars().all()
        )

    for familiar in snapshot.artist_familiar:
        if familiar.artist_id not in existing_artist_ids:
            continue
        await db.execute(
            insert(UserArtistStat)
            .values(
                user_id=user_id,
                artist_id=familiar.artist_id,
                known_track_count=familiar.known_track_count,
                wave_track_count=familiar.wave_track_count,
                collection_track_count=familiar.collection_track_count,
                collection_album_count=familiar.collection_album_count,
                raw=familiar.raw,
            )
            .on_conflict_do_update(
                constraint="uq_user_artist_stat",
                set_={
                    "known_track_count": familiar.known_track_count,
                    "wave_track_count": familiar.wave_track_count,
                    "collection_track_count": familiar.collection_track_count,
                    "collection_album_count": familiar.collection_album_count,
                    "raw": familiar.raw,
                },
            )
        )

    for liked_artist in snapshot.liked_artists:
        artist = liked_artist.artist
        await db.execute(
            insert(UserArtistStat)
            .values(
                user_id=user_id,
                artist_id=artist.id,
                known_track_count=0,
                wave_track_count=0,
                collection_track_count=0,
                collection_album_count=0,
                is_liked_artist=True,
                liked_at=liked_artist.liked_at,
                raw={"liked": True},
            )
            .on_conflict_do_update(
                constraint="uq_user_artist_stat",
                set_={"is_liked_artist": True, "liked_at": liked_artist.liked_at},
            )
        )

    await db.commit()


async def _core_artist_ids(db: AsyncSession, user_id: UUID) -> set[str]:
    result = await db.execute(
        select(TrackArtist.artist_id)
        .join(UserListen, UserListen.track_id == TrackArtist.track_id)
        .where(UserListen.user_id == user_id)
    )
    return set(result.scalars().all())


async def _cached_edge_familiar_candidates(db: AsyncSession, user_id: UUID) -> list[str]:
    core_artist_ids = await _core_artist_ids(db, user_id)
    if not core_artist_ids:
        return []

    known_artist_ids = set(
        (
            await db.execute(
                select(UserArtistStat.artist_id).where(
                    UserArtistStat.user_id == user_id,
                    or_(
                        UserArtistStat.known_track_count > 0,
                        UserArtistStat.collection_album_count > 0,
                    ),
                )
            )
        ).scalars().all()
    )
    frontier = set(core_artist_ids)
    seen = set(core_artist_ids)
    scores: dict[str, int] = {}

    for layer in range(settings.cached_edge_familiar_depth):
        if not frontier:
            break

        rows = await db.execute(
            select(
                ArtistEdge.source_artist_id,
                ArtistEdge.target_artist_id,
                ArtistEdge.type,
                ArtistEdge.weight,
                ArtistEdge.tracks,
            ).where(
                ArtistEdge.type.in_(["similar", "catalog_collab"]),
                ArtistEdge.source_artist_id.in_(frontier) | ArtistEdge.target_artist_id.in_(frontier),
            )
        )

        next_frontier: set[str] = set()
        layer_bonus = max(settings.cached_edge_familiar_depth - layer, 1)
        for source_artist_id, target_artist_id, edge_type, weight, tracks in rows.all():
            neighbor_ids: list[str] = []
            if source_artist_id in frontier and target_artist_id not in core_artist_ids:
                neighbor_ids.append(target_artist_id)
            if target_artist_id in frontier and source_artist_id not in core_artist_ids:
                neighbor_ids.append(source_artist_id)

            for neighbor_id in neighbor_ids:
                if neighbor_id in known_artist_ids:
                    continue
                if edge_type == "catalog_collab":
                    has_track_evidence = any(str(track).strip() for track in tracks or [])
                    base_score = 1_000_000 if layer == 0 else 600_000
                    track_bonus = 100_000 if has_track_evidence else 0
                    edge_score = base_score + track_bonus + weight * 1_000 * layer_bonus
                else:
                    base_score = 250_000 if layer == 0 else 100_000
                    edge_score = base_score + weight * 100 * layer_bonus
                scores[neighbor_id] = max(scores.get(neighbor_id, 0), edge_score)
                if neighbor_id not in seen:
                    next_frontier.add(neighbor_id)
                    seen.add(neighbor_id)

        frontier = next_frontier

    return [
        artist_id
        for artist_id, _score in sorted(scores.items(), key=lambda item: item[1], reverse=True)[
            : settings.cached_edge_familiar_limit
        ]
    ]


async def _upsert_artist_familiar(
    db: AsyncSession,
    *,
    user_id: UUID,
    familiar_items: list[ArtistFamiliarSnapshot],
) -> int:
    if not familiar_items:
        return 0

    familiar_ids = {item.artist_id for item in familiar_items}
    existing_artist_ids = set(
        (await db.execute(select(Artist.id).where(Artist.id.in_(familiar_ids)))).scalars().all()
    )
    saved = 0
    for familiar in familiar_items:
        if familiar.artist_id not in existing_artist_ids:
            continue
        await db.execute(
            insert(UserArtistStat)
            .values(
                user_id=user_id,
                artist_id=familiar.artist_id,
                known_track_count=familiar.known_track_count,
                wave_track_count=familiar.wave_track_count,
                collection_track_count=familiar.collection_track_count,
                collection_album_count=familiar.collection_album_count,
                raw=familiar.raw,
            )
            .on_conflict_do_update(
                constraint="uq_user_artist_stat",
                set_={
                    "known_track_count": familiar.known_track_count,
                    "wave_track_count": familiar.wave_track_count,
                    "collection_track_count": familiar.collection_track_count,
                    "collection_album_count": familiar.collection_album_count,
                    "raw": familiar.raw,
                },
            )
        )
        saved += 1

    await db.commit()
    return saved


async def _backfill_cached_edge_familiar(db: AsyncSession, *, user_id: UUID, token: str) -> int:
    candidate_ids = await _cached_edge_familiar_candidates(db, user_id)
    familiar_items = await fetch_artist_familiar_batch(token, candidate_ids)
    return await _upsert_artist_familiar(db, user_id=user_id, familiar_items=familiar_items)


async def sync_user_music(db: AsyncSession, job_id: UUID, user_id: UUID) -> None:
    sync_started_at = time.perf_counter()
    await set_job_status(db, job_id, status="running", progress=5, message="Loading Yandex token")
    credential = await db.get(YandexCredential, user_id)
    if credential is None:
        raise RuntimeError("No Yandex credential for user")

    token = decrypt_secret(credential.encrypted_music_token) or decrypt_secret(credential.encrypted_x_token)
    if not token:
        raise RuntimeError("Stored Yandex token could not be decrypted")

    await set_job_status(db, job_id, status="running", progress=20, message="Fetching music history")
    snapshot = await fetch_listening_snapshot(token)
    await set_job_status(
        db,
        job_id,
        status="running",
        progress=70,
        message=f"Saving {len(snapshot.tracks)} listened tracks",
        source_status=snapshot.source_status,
    )
    stage_started_at = time.perf_counter()
    await _upsert_snapshot(db, user_id, snapshot)
    snapshot.source_status["save_db"] = _status_with_duration("ok", time.perf_counter() - stage_started_at)
    await set_job_status(
        db,
        job_id,
        status="running",
        progress=85,
        message="Refreshing connected artists",
        source_status=snapshot.source_status,
    )
    stage_started_at = time.perf_counter()
    cached_familiar_count = await _backfill_cached_edge_familiar(db, user_id=user_id, token=token)
    snapshot.source_status["cached_familiar"] = _status_with_duration(
        f"ok: {cached_familiar_count} cached-edge artists",
        time.perf_counter() - stage_started_at,
    )
    snapshot.source_status["sync_total"] = _status_with_duration("ok", time.perf_counter() - sync_started_at)
    await set_job_status(
        db,
        job_id,
        status="completed",
        progress=100,
        message="Sync completed",
        source_status=snapshot.source_status,
    )


async def create_sync_job(db: AsyncSession, user_id: UUID) -> SyncJob:
    job = SyncJob(user_id=user_id, status="queued", progress=0, message="Queued")
    db.add(job)
    await db.commit()
    await db.refresh(job)
    return job


async def get_latest_source_status(db: AsyncSession, user_id: UUID) -> dict:
    result = await db.execute(
        select(SyncJob)
        .where(SyncJob.user_id == user_id, SyncJob.status == "completed")
        .order_by(SyncJob.finished_at.desc().nullslast())
        .limit(1)
    )
    job = result.scalar_one_or_none()
    return job.source_status if job else {}
