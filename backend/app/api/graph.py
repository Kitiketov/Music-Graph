from __future__ import annotations

from typing import Annotated
from uuid import UUID

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import get_current_user
from app.db.models import User
from app.db.session import get_db
from app.schemas.graph import CompareResponse, GraphResponse
from app.services.graph_service import build_user_graph, compare_users

router = APIRouter()


def _edge_types(value: str | None) -> set[str]:
    if not value:
        return {"collab"}
    return {item.strip() for item in value.split(",") if item.strip()}


@router.get("/media/image")
async def image_proxy(
    user: Annotated[User, Depends(get_current_user)],
    url: Annotated[str, Query(min_length=1)],
) -> Response:
    if not url.startswith(("https://", "http://")):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unsupported image URL")

    try:
        async with httpx.AsyncClient(timeout=10, follow_redirects=True) as client:
            response = await client.get(url)
            response.raise_for_status()
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Could not fetch image") from exc

    content_type = response.headers.get("content-type", "application/octet-stream").split(";")[0].strip()
    if not content_type.startswith("image/"):
        raise HTTPException(status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, detail="URL is not an image")
    if len(response.content) > 5 * 1024 * 1024:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="Image is too large")

    return Response(content=response.content, media_type=content_type)


@router.get("/graph/me", response_model=GraphResponse)
async def my_graph(
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    limit: Annotated[int, Query(ge=1, le=5000)] = 100,
    min_listens: Annotated[int, Query(ge=1)] = 1,
    depth: Annotated[int, Query(ge=1, le=3)] = 1,
    edge_types: str | None = Query(default=None),
    shared_with: Annotated[UUID | None, Query()] = None,
) -> GraphResponse:
    try:
        return await build_user_graph(
            db,
            viewer_id=user.id,
            owner_id=user.id,
            limit=limit,
            min_listens=min_listens,
            depth=depth,
            edge_types=_edge_types(edge_types),
            shared_with_user_id=shared_with,
        )
    except PermissionError as exc:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(exc)) from exc


@router.get("/graph/users/{user_id}", response_model=GraphResponse)
async def user_graph(
    user_id: UUID,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    limit: Annotated[int, Query(ge=1, le=5000)] = 100,
    min_listens: Annotated[int, Query(ge=1)] = 1,
    depth: Annotated[int, Query(ge=1, le=3)] = 1,
    edge_types: str | None = Query(default=None),
) -> GraphResponse:
    try:
        return await build_user_graph(
            db,
            viewer_id=user.id,
            owner_id=user_id,
            limit=limit,
            min_listens=min_listens,
            depth=depth,
            edge_types=_edge_types(edge_types),
            shared_with_user_id=user.id,
        )
    except PermissionError as exc:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(exc)) from exc


@router.get("/compare/{friend_id}", response_model=CompareResponse)
async def compare(
    friend_id: UUID,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> CompareResponse:
    try:
        return await compare_users(db, viewer_id=user.id, friend_id=friend_id)
    except PermissionError as exc:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(exc)) from exc
