from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import get_current_user
from app.db.models import User
from app.db.session import get_db
from app.schemas.friends import FriendsResponse, InviteAcceptRequest, InviteCreateResponse
from app.services.friend_service import accept_invite, create_invite, invite_url, list_friends, remove_friend

router = APIRouter()


@router.post("/invite", response_model=InviteCreateResponse)
async def invite(
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> InviteCreateResponse:
    created = await create_invite(db, user.id)
    return InviteCreateResponse(
        code=created.code,
        invite_url=invite_url(created.code),
        expires_at=created.expires_at,
    )


@router.post("/accept", status_code=status.HTTP_204_NO_CONTENT)
async def accept(
    payload: InviteAcceptRequest,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> None:
    try:
        await accept_invite(db, user_id=user.id, code=payload.code)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc


@router.get("", response_model=FriendsResponse)
async def friends(
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> FriendsResponse:
    return FriendsResponse(friends=await list_friends(db, user.id))


@router.delete("/{friend_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_friend(
    friend_id: UUID,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> None:
    removed = await remove_friend(db, user_id=user.id, friend_id=friend_id)
    if not removed:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Friendship not found")
