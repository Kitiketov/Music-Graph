from __future__ import annotations

from typing import Annotated

from fastapi import Depends, Header, HTTPException, status
from jwt import PyJWTError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import decode_access_token
from app.db.models import User
from app.db.session import get_db
from app.schemas.auth import CURRENT_PRIVACY_VERSION, CURRENT_TERMS_VERSION


async def get_current_user(
    db: Annotated[AsyncSession, Depends(get_db)],
    authorization: Annotated[str | None, Header()] = None,
) -> User:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing bearer token")

    token = authorization.split(" ", 1)[1].strip()
    try:
        user_id = decode_access_token(token)
    except (PyJWTError, ValueError) as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token") from exc

    user = await db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
    if user.terms_version != CURRENT_TERMS_VERSION or user.privacy_version != CURRENT_PRIVACY_VERSION:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Current user agreement and privacy policy must be accepted",
        )
    return user
