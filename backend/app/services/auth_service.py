from __future__ import annotations

import asyncio
import secrets
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.security import create_access_token, encrypt_secret
from app.db.models import User, YandexCredential
from app.db.session import AsyncSessionLocal


@dataclass
class QrSessionState:
    session_id: str
    qr_url: str
    terms_version: str
    privacy_version: str
    status: str = "pending"
    message: str | None = None
    user_id: UUID | None = None
    access_token: str | None = None
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    expires_at: datetime = field(default_factory=lambda: datetime.now(UTC) + timedelta(minutes=3))


@dataclass
class DeviceSessionState:
    session_id: str
    user_code: str
    verification_url: str
    expires_in_seconds: int
    interval_seconds: int
    terms_version: str
    privacy_version: str
    status: str = "pending"
    message: str | None = None
    user_id: UUID | None = None
    access_token: str | None = None
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    expires_at: datetime = field(default_factory=lambda: datetime.now(UTC) + timedelta(minutes=10))


QR_SESSIONS: dict[str, QrSessionState] = {}
QR_TASKS: dict[str, asyncio.Task] = {}
DEVICE_SESSIONS: dict[str, DeviceSessionState] = {}
DEVICE_TASKS: dict[str, asyncio.Task] = {}


def _secret_value(value: Any) -> str | None:
    if value is None:
        return None
    if hasattr(value, "get_secret"):
        return value.get_secret()
    if hasattr(value, "get_secret_value"):
        return value.get_secret_value()
    return str(value)


async def upsert_yandex_user(
    db: AsyncSession,
    *,
    yandex_uid: str | None,
    display_login: str | None,
    avatar_url: str | None,
    x_token: str,
    music_token: str | None,
    refresh_token: str | None = None,
    token_source: str = "qr",
    terms_version: str | None = None,
    privacy_version: str | None = None,
) -> User:
    user: User | None = None
    if yandex_uid:
        result = await db.execute(select(User).where(User.yandex_uid == yandex_uid))
        user = result.scalar_one_or_none()

    if user is None:
        user = User(
            yandex_uid=yandex_uid,
            display_login=display_login or f"yandex-{secrets.token_hex(4)}",
            avatar_url=avatar_url,
        )
        db.add(user)
        await db.flush()
    else:
        user.display_login = display_login or user.display_login
        user.avatar_url = avatar_url or user.avatar_url

    if terms_version and privacy_version:
        user.terms_version = terms_version
        user.privacy_version = privacy_version
        user.terms_accepted_at = datetime.now(UTC)

    credential = await db.get(YandexCredential, user.id)
    if credential is None:
        credential = YandexCredential(
            user_id=user.id,
            encrypted_x_token=encrypt_secret(x_token) or "",
            encrypted_music_token=encrypt_secret(music_token),
            encrypted_refresh_token=encrypt_secret(refresh_token),
            token_source=token_source,
        )
        db.add(credential)
    else:
        credential.encrypted_x_token = encrypt_secret(x_token) or credential.encrypted_x_token
        credential.encrypted_music_token = encrypt_secret(music_token)
        credential.encrypted_refresh_token = encrypt_secret(refresh_token)
        credential.token_source = token_source

    await db.commit()
    await db.refresh(user)
    return user


async def _create_mock_login(session_id: str) -> None:
    await asyncio.sleep(1)
    async with AsyncSessionLocal() as db:
        user = await upsert_yandex_user(
            db,
            yandex_uid="mock-user",
            display_login="mock.yandex.music",
            avatar_url=None,
            x_token="mock-x-token",
            music_token="mock-music-token",
            token_source="mock",
            terms_version=QR_SESSIONS[session_id].terms_version,
            privacy_version=QR_SESSIONS[session_id].privacy_version,
        )
    state = QR_SESSIONS[session_id]
    state.status = "confirmed"
    state.user_id = user.id
    state.access_token = create_access_token(user.id)
    state.message = "Mock login completed"


async def _poll_real_qr_login(session_id: str, client_ctx: Any, client: Any, qr: Any) -> None:
    state = QR_SESSIONS[session_id]
    try:
        state.message = "Waiting for QR scan"
        creds = await client.poll_qr_until_confirmed(qr)
        info = await client.fetch_account_info(creds.x_token)

        x_token = _secret_value(creds.x_token)
        music_token = _secret_value(getattr(creds, "music_token", None))
        refresh_token = _secret_value(getattr(creds, "refresh_token", None))

        if not x_token:
            raise RuntimeError("Yandex QR login returned no x_token")

        uid = getattr(info, "uid", None) or getattr(creds, "uid", None)
        async with AsyncSessionLocal() as db:
            user = await upsert_yandex_user(
                db,
                yandex_uid=str(uid) if uid else None,
                display_login=getattr(info, "display_login", None)
                or getattr(creds, "display_login", None)
                or "Yandex Music User",
                avatar_url=getattr(info, "avatar_url", None),
                x_token=x_token,
                music_token=music_token,
                refresh_token=refresh_token,
                terms_version=state.terms_version,
                privacy_version=state.privacy_version,
            )

        state.status = "confirmed"
        state.user_id = user.id
        state.access_token = create_access_token(user.id)
        state.message = "QR login completed"
    except Exception as exc:  # noqa: BLE001 - surface auth library errors to the UI
        state.status = "failed"
        state.message = str(exc)
    finally:
        await client_ctx.__aexit__(None, None, None)


async def _poll_device_login(session_id: str, client_ctx: Any, client: Any, device_session: Any) -> None:
    state = DEVICE_SESSIONS[session_id]
    try:
        state.message = "Waiting for device code confirmation"
        creds = await client.poll_device_until_confirmed(device_session)
        x_token = _secret_value(creds.x_token)
        music_token = _secret_value(getattr(creds, "music_token", None))
        refresh_token = _secret_value(getattr(creds, "refresh_token", None))
        if not x_token:
            raise RuntimeError("Yandex device login returned no x_token")

        uid = getattr(creds, "uid", None)
        async with AsyncSessionLocal() as db:
            user = await upsert_yandex_user(
                db,
                yandex_uid=str(uid) if uid else None,
                display_login=getattr(creds, "display_login", None) or "Yandex Music User",
                avatar_url=None,
                x_token=x_token,
                music_token=music_token,
                refresh_token=refresh_token,
                token_source="device",
                terms_version=state.terms_version,
                privacy_version=state.privacy_version,
            )

        state.status = "confirmed"
        state.user_id = user.id
        state.access_token = create_access_token(user.id)
        state.message = "Device login completed"
    except Exception as exc:  # noqa: BLE001 - auth failures should be visible in the UI
        state.status = "failed"
        state.message = str(exc)
    finally:
        await client_ctx.__aexit__(None, None, None)


async def start_qr_login(*, terms_version: str, privacy_version: str) -> QrSessionState:
    session_id = secrets.token_urlsafe(18)

    if settings.mock_yandex:
        state = QrSessionState(
            session_id=session_id,
            qr_url=f"{settings.frontend_url}/mock-yandex-login/{session_id}",
            terms_version=terms_version,
            privacy_version=privacy_version,
            status="pending",
            message="Mock QR created",
        )
        QR_SESSIONS[session_id] = state
        QR_TASKS[session_id] = asyncio.create_task(_create_mock_login(session_id))
        return state

    from ya_passport_auth import PassportClient

    client_ctx = PassportClient.create()
    client = await client_ctx.__aenter__()

    qr = await client.start_qr_login()
    state = QrSessionState(
        session_id=session_id,
        qr_url=qr.qr_url,
        terms_version=terms_version,
        privacy_version=privacy_version,
        status="pending",
        message="Scan QR in Yandex app",
    )
    QR_SESSIONS[session_id] = state
    QR_TASKS[session_id] = asyncio.create_task(_poll_real_qr_login(session_id, client_ctx, client, qr))
    return state


async def start_device_login(*, terms_version: str, privacy_version: str) -> DeviceSessionState:
    session_id = secrets.token_urlsafe(18)

    if settings.mock_yandex:
        state = DeviceSessionState(
            session_id=session_id,
            user_code="MOCK-1234",
            verification_url=f"{settings.frontend_url}/mock-yandex-device/{session_id}",
            expires_in_seconds=600,
            interval_seconds=2,
            terms_version=terms_version,
            privacy_version=privacy_version,
            message="Mock device code created",
        )
        DEVICE_SESSIONS[session_id] = state
        DEVICE_TASKS[session_id] = asyncio.create_task(_create_mock_device_login(session_id))
        return state

    from ya_passport_auth import PassportClient

    client_ctx = PassportClient.create()
    client = await client_ctx.__aenter__()
    device_session = await client.start_device_login(device_name="Music Graph")
    state = DeviceSessionState(
        session_id=session_id,
        user_code=device_session.user_code,
        verification_url=device_session.verification_url,
        expires_in_seconds=device_session.expires_in,
        interval_seconds=device_session.interval,
        terms_version=terms_version,
        privacy_version=privacy_version,
        expires_at=datetime.now(UTC) + timedelta(seconds=device_session.expires_in),
        message="Enter this code in Yandex",
    )
    DEVICE_SESSIONS[session_id] = state
    DEVICE_TASKS[session_id] = asyncio.create_task(
        _poll_device_login(session_id, client_ctx, client, device_session)
    )
    return state


async def _create_mock_device_login(session_id: str) -> None:
    await asyncio.sleep(1)
    async with AsyncSessionLocal() as db:
        user = await upsert_yandex_user(
            db,
            yandex_uid="mock-user",
            display_login="mock.yandex.music",
            avatar_url=None,
            x_token="mock-x-token",
            music_token="mock-music-token",
            token_source="mock",
            terms_version=DEVICE_SESSIONS[session_id].terms_version,
            privacy_version=DEVICE_SESSIONS[session_id].privacy_version,
        )
    state = DEVICE_SESSIONS[session_id]
    state.status = "confirmed"
    state.user_id = user.id
    state.access_token = create_access_token(user.id)
    state.message = "Mock device login completed"


def get_qr_status(session_id: str) -> QrSessionState | None:
    state = QR_SESSIONS.get(session_id)
    if state is None:
        return None
    if state.status == "pending" and datetime.now(UTC) > state.expires_at:
        state.status = "expired"
        state.message = "QR session expired"
        task = QR_TASKS.get(session_id)
        if task and not task.done():
            task.cancel()
    return state


def get_device_status(session_id: str) -> DeviceSessionState | None:
    state = DEVICE_SESSIONS.get(session_id)
    if state is None:
        return None
    if state.status == "pending" and datetime.now(UTC) > state.expires_at:
        state.status = "expired"
        state.message = "Device code expired"
        task = DEVICE_TASKS.get(session_id)
        if task and not task.done():
            task.cancel()
    return state
