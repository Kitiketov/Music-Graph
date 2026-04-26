from __future__ import annotations

from uuid import UUID

from arq.connections import RedisSettings

from app.core.config import settings
from app.db.session import AsyncSessionLocal
from app.services.sync_service import set_job_status, sync_user_music


async def sync_user(ctx, job_id: str, user_id: str) -> None:
    async with AsyncSessionLocal() as db:
        try:
            await sync_user_music(db, UUID(job_id), UUID(user_id))
        except Exception as exc:  # noqa: BLE001 - job errors should be visible in UI
            await set_job_status(
                db,
                UUID(job_id),
                status="failed",
                progress=100,
                message="Sync failed",
                error=str(exc),
            )
            raise


class WorkerSettings:
    functions = [sync_user]
    redis_settings = RedisSettings.from_dsn(settings.redis_url)
