from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0003_liked_artists"
down_revision: str | None = "0002_user_artist_stats"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "user_artist_stats",
        sa.Column("is_liked_artist", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.add_column("user_artist_stats", sa.Column("liked_at", sa.DateTime(timezone=True), nullable=True))
    op.alter_column("user_artist_stats", "is_liked_artist", server_default=None)


def downgrade() -> None:
    op.drop_column("user_artist_stats", "liked_at")
    op.drop_column("user_artist_stats", "is_liked_artist")
