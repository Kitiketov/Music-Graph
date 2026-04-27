from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import get_current_user
from app.db.models import User
from app.db.session import get_db
from app.schemas.playlist import (
    PlaylistBuildRequest,
    PlaylistCreateRequest,
    PlaylistCreateResponse,
    PlaylistPreviewResponse,
)
from app.services.playlist_service import create_playlist_from_graph, preview_playlist_tracks

router = APIRouter()


@router.post("/preview", response_model=PlaylistPreviewResponse)
async def preview_playlist(
    payload: PlaylistBuildRequest,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> PlaylistPreviewResponse:
    return await preview_playlist_tracks(db, user_id=user.id, request=payload)


@router.post("/create", response_model=PlaylistCreateResponse)
async def create_playlist(
    payload: PlaylistCreateRequest,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> PlaylistCreateResponse:
    try:
        return await create_playlist_from_graph(db, user=user, request=payload)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc
