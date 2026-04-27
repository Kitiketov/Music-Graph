from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.deps import get_current_user
from app.db.models import FriendInvite, User
from app.db.session import get_db
from app.schemas.auth import (
    CURRENT_PRIVACY_VERSION,
    CURRENT_TERMS_VERSION,
    AgreementAcceptance,
    DeviceStartResponse,
    MeResponse,
    QrStartResponse,
    QrStatusResponse,
    UserOut,
)
from app.services.auth_service import (
    get_device_status,
    get_qr_status,
    start_device_login,
    start_qr_login,
)

router = APIRouter()


def _user_out(user: User) -> UserOut:
    return UserOut(
        id=user.id,
        display_login=user.display_login,
        avatar_url=user.avatar_url,
        terms_version=user.terms_version,
        privacy_version=user.privacy_version,
    )


def _validate_agreement(agreement: AgreementAcceptance) -> None:
    if not agreement.accepted_terms:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Accept the user agreement and privacy policy before login",
        )
    if agreement.terms_version != CURRENT_TERMS_VERSION or agreement.privacy_version != CURRENT_PRIVACY_VERSION:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Agreement version is outdated. Refresh the page and accept the current version.",
        )


@router.post("/auth/qr/start", response_model=QrStartResponse)
async def start_qr(agreement: AgreementAcceptance) -> QrStartResponse:
    _validate_agreement(agreement)
    state = await start_qr_login(
        terms_version=agreement.terms_version,
        privacy_version=agreement.privacy_version,
    )
    return QrStartResponse(
        session_id=state.session_id,
        qr_url=state.qr_url,
        mock=settings.mock_yandex,
    )


@router.get("/auth/qr/status/{session_id}", response_model=QrStatusResponse)
async def qr_status(session_id: str, db: Annotated[AsyncSession, Depends(get_db)]) -> QrStatusResponse:
    state = get_qr_status(session_id)
    if state is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="QR session not found")

    user_out = None
    if state.user_id:
        user = await db.get(User, state.user_id)
        if user:
            user_out = _user_out(user)

    return QrStatusResponse(
        status=state.status,
        message=state.message,
        access_token=state.access_token,
        user=user_out,
    )


@router.post("/auth/device/start", response_model=DeviceStartResponse)
async def start_device(agreement: AgreementAcceptance) -> DeviceStartResponse:
    _validate_agreement(agreement)
    state = await start_device_login(
        terms_version=agreement.terms_version,
        privacy_version=agreement.privacy_version,
    )
    return DeviceStartResponse(
        session_id=state.session_id,
        user_code=state.user_code,
        verification_url=state.verification_url,
        expires_in_seconds=state.expires_in_seconds,
        interval_seconds=state.interval_seconds,
        mock=settings.mock_yandex,
    )


@router.get("/auth/device/status/{session_id}", response_model=QrStatusResponse)
async def device_status(
    session_id: str, db: Annotated[AsyncSession, Depends(get_db)]
) -> QrStatusResponse:
    state = get_device_status(session_id)
    if state is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Device session not found")

    user_out = None
    if state.user_id:
        user = await db.get(User, state.user_id)
        if user:
            user_out = _user_out(user)

    return QrStatusResponse(
        status=state.status,
        message=state.message,
        access_token=state.access_token,
        user=user_out,
    )


@router.get("/me", response_model=MeResponse)
async def me(user: Annotated[User, Depends(get_current_user)]) -> MeResponse:
    return MeResponse(user=_user_out(user))


@router.delete("/me", status_code=status.HTTP_204_NO_CONTENT)
async def delete_me(
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> None:
    await db.execute(
        update(FriendInvite)
        .where(FriendInvite.accepted_by_id == user.id)
        .values(accepted_by_id=None, accepted_at=None)
    )
    await db.delete(user)
    await db.commit()
