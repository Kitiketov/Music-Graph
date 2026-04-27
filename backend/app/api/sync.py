from __future__ import annotations

import asyncio
import json
from typing import Annotated
from uuid import UUID

from arq import create_pool
from arq.connections import RedisSettings
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.deps import get_current_user
from app.core.security import decode_access_token
from app.db.models import SyncJob, User
from app.db.session import get_db
from app.schemas.sync import SyncStartResponse, SyncStatusResponse
from app.services.sync_service import create_sync_job, mark_stale_sync_jobs

router = APIRouter()


def _job_status(job: SyncJob) -> SyncStatusResponse:
    return SyncStatusResponse(
        job_id=job.id,
        status=job.status,
        progress=job.progress,
        message=job.message,
        sourceStatus=job.source_status or {},
        error=job.error,
        created_at=job.created_at,
        started_at=job.started_at,
        finished_at=job.finished_at,
    )


@router.post("/start", response_model=SyncStartResponse)
async def start_sync(
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> SyncStartResponse:
    job, created = await create_sync_job(db, user.id)
    if created:
        redis = await create_pool(RedisSettings.from_dsn(settings.redis_url))
        try:
            await redis.enqueue_job("sync_user", str(job.id), str(user.id))
        finally:
            await redis.close()
    return SyncStartResponse(job_id=job.id, status=job.status)


@router.get("/status/{job_id}", response_model=SyncStatusResponse)
async def sync_status(
    job_id: str,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> SyncStatusResponse:
    await mark_stale_sync_jobs(db, user_id=user.id)
    job = await db.get(SyncJob, UUID(job_id))
    if job is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Sync job not found")
    if job.user_id != user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Sync job belongs to another user")
    return _job_status(job)


@router.get("/events/{job_id}")
async def sync_events(
    job_id: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    access_token: str | None = None,
) -> StreamingResponse:
    parsed_job_id = UUID(job_id)
    if not access_token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing access_token")
    try:
        viewer_id = decode_access_token(access_token)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid access_token") from exc

    async def stream():
        while True:
            job = await db.get(SyncJob, parsed_job_id)
            if job is None:
                yield "event: error\ndata: Sync job not found\n\n"
                return
            if job.user_id != viewer_id:
                yield "event: error\ndata: Forbidden\n\n"
                return
            payload = _job_status(job).model_dump(mode="json")
            yield f"data: {json.dumps(payload)}\n\n"
            if job.status in {"completed", "failed"}:
                return
            await asyncio.sleep(1)

    return StreamingResponse(stream(), media_type="text/event-stream")
