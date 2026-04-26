from __future__ import annotations

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field


class SyncStartResponse(BaseModel):
    job_id: UUID
    status: str


class SyncStatusResponse(BaseModel):
    job_id: UUID
    status: str
    progress: int
    message: str | None = None
    sourceStatus: dict = Field(default_factory=dict)
    error: str | None = None
    created_at: datetime
    started_at: datetime | None = None
    finished_at: datetime | None = None
