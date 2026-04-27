from __future__ import annotations

import secrets
from datetime import UTC, datetime, timedelta
from uuid import UUID

from sqlalchemy import delete, or_, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.db.models import FriendInvite, Friendship, User
from app.schemas.auth import UserOut
from app.schemas.friends import FriendOut


async def create_invite(db: AsyncSession, inviter_id: UUID) -> FriendInvite:
    invite = FriendInvite(
        inviter_id=inviter_id,
        code=secrets.token_urlsafe(12),
        expires_at=datetime.now(UTC) + timedelta(days=7),
    )
    db.add(invite)
    await db.commit()
    await db.refresh(invite)
    return invite


def invite_url(code: str) -> str:
    return f"{settings.frontend_url}/invite/{code}"


async def accept_invite(db: AsyncSession, *, user_id: UUID, code: str) -> None:
    result = await db.execute(select(FriendInvite).where(FriendInvite.code == code))
    invite = result.scalar_one_or_none()
    if invite is None:
        raise ValueError("Invite not found")
    if invite.expires_at < datetime.now(UTC):
        raise ValueError("Invite expired")
    if invite.inviter_id == user_id:
        raise ValueError("You cannot accept your own invite")

    invite.accepted_by_id = user_id
    invite.accepted_at = datetime.now(UTC)

    for left, right in ((invite.inviter_id, user_id), (user_id, invite.inviter_id)):
        await db.execute(
            insert(Friendship)
            .values(user_id=left, friend_id=right, can_view_full_graph=True)
            .on_conflict_do_nothing(index_elements=[Friendship.user_id, Friendship.friend_id])
        )
    await db.commit()


async def list_friends(db: AsyncSession, user_id: UUID) -> list[FriendOut]:
    result = await db.execute(
        select(Friendship, User)
        .join(User, User.id == Friendship.friend_id)
        .where(Friendship.user_id == user_id)
        .order_by(User.display_login)
    )
    return [
        FriendOut(
            id=friendship.id,
            friend=UserOut(id=friend.id, display_login=friend.display_login, avatar_url=friend.avatar_url),
            created_at=friendship.created_at,
            can_view_full_graph=friendship.can_view_full_graph,
        )
        for friendship, friend in result.all()
    ]


async def remove_friend(db: AsyncSession, *, user_id: UUID, friend_id: UUID) -> bool:
    result = await db.execute(
        delete(Friendship).where(
            or_(
                (Friendship.user_id == user_id) & (Friendship.friend_id == friend_id),
                (Friendship.user_id == friend_id) & (Friendship.friend_id == user_id),
            )
        )
    )
    await db.commit()
    return bool(result.rowcount)
