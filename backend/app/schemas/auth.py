from __future__ import annotations

from uuid import UUID

from pydantic import BaseModel

CURRENT_TERMS_VERSION = "2026-04-28"
CURRENT_PRIVACY_VERSION = "2026-04-28"


class UserOut(BaseModel):
    id: UUID
    display_login: str
    avatar_url: str | None = None
    terms_version: str | None = None
    privacy_version: str | None = None


class AgreementAcceptance(BaseModel):
    accepted_terms: bool
    terms_version: str
    privacy_version: str


class QrStartResponse(BaseModel):
    session_id: str
    qr_url: str
    expires_in_seconds: int = 180
    mock: bool = False


class QrStatusResponse(BaseModel):
    status: str
    message: str | None = None
    access_token: str | None = None
    user: UserOut | None = None


class DeviceStartResponse(BaseModel):
    session_id: str
    user_code: str
    verification_url: str
    expires_in_seconds: int
    interval_seconds: int
    mock: bool = False


class MeResponse(BaseModel):
    user: UserOut
