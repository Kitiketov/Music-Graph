from __future__ import annotations

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel

from app.schemas.auth import UserOut


class InviteCreateResponse(BaseModel):
    code: str
    invite_url: str
    expires_at: datetime


class InviteAcceptRequest(BaseModel):
    code: str


class FriendOut(BaseModel):
    id: UUID
    friend: UserOut
    created_at: datetime
    can_view_full_graph: bool


class FriendsResponse(BaseModel):
    friends: list[FriendOut]
