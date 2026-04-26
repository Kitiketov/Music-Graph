from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0002_user_artist_stats"
down_revision: str | None = "0001_initial"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "user_artist_stats",
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("artist_id", sa.String(length=128), nullable=False),
        sa.Column("known_track_count", sa.Integer(), nullable=False),
        sa.Column("wave_track_count", sa.Integer(), nullable=False),
        sa.Column("collection_track_count", sa.Integer(), nullable=False),
        sa.Column("collection_album_count", sa.Integer(), nullable=False),
        sa.Column("raw", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["artist_id"], ["artists.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("user_id", "artist_id"),
        sa.UniqueConstraint("user_id", "artist_id", name="uq_user_artist_stat"),
    )
    op.create_index(
        "ix_user_artist_stats_user_known",
        "user_artist_stats",
        ["user_id", "known_track_count"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_user_artist_stats_user_known", table_name="user_artist_stats")
    op.drop_table("user_artist_stats")
