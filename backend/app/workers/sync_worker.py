from __future__ import annotations

import asyncio
from uuid import UUID

from arq.connections import RedisSettings

from app.core.config import settings
from app.db.models import SyncJob
from app.db.session import AsyncSessionLocal
from app.services.sync_service import set_job_status, sync_user_music


async def sync_user(ctx, job_id: str, user_id: str) -> None:
    parsed_job_id = UUID(job_id)
    parsed_user_id = UUID(user_id)
    async with AsyncSessionLocal() as db:
        job = await db.get(SyncJob, parsed_job_id)
        if job is None or job.user_id != parsed_user_id or job.status not in {"queued", "running"}:
            return
        try:
            await sync_user_music(db, parsed_job_id, parsed_user_id)
        except asyncio.CancelledError:
            await set_job_status(
                db,
                parsed_job_id,
                status="failed",
                progress=100,
                message="Sync timed out",
                error=f"Sync timed out after {settings.sync_job_timeout_seconds}s",
            )
            raise
        except Exception as exc:  # noqa: BLE001 - job errors should be visible in UI
            await set_job_status(
                db,
                parsed_job_id,
                status="failed",
                progress=100,
                message="Sync failed",
                error=str(exc),
            )
            raise


class WorkerSettings:
    functions = [sync_user]
    redis_settings = RedisSettings.from_dsn(settings.redis_url)
    job_timeout = settings.sync_job_timeout_seconds
    max_tries = 1
