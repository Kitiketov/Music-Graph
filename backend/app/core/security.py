from __future__ import annotations

from datetime import UTC, datetime, timedelta
from uuid import UUID

import jwt
from cryptography.fernet import Fernet

from app.core.config import settings


def create_access_token(user_id: UUID) -> str:
    now = datetime.now(UTC)
    payload = {
        "sub": str(user_id),
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(seconds=settings.access_token_ttl_seconds)).timestamp()),
    }
    return jwt.encode(payload, settings.secret_key, algorithm=settings.jwt_algorithm)


def decode_access_token(token: str) -> UUID:
    payload = jwt.decode(token, settings.secret_key, algorithms=[settings.jwt_algorithm])
    return UUID(payload["sub"])


def _fernet() -> Fernet:
    return Fernet(settings.effective_fernet_key)


def encrypt_secret(value: str | None) -> str | None:
    if not value:
        return None
    return _fernet().encrypt(value.encode()).decode()


def decrypt_secret(value: str | None) -> str | None:
    if not value:
        return None
    return _fernet().decrypt(value.encode()).decode()
