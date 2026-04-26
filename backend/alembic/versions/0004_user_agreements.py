from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0004_user_agreements"
down_revision: str | None = "0003_liked_artists"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("users", sa.Column("terms_version", sa.String(length=32), nullable=True))
    op.add_column("users", sa.Column("privacy_version", sa.String(length=32), nullable=True))
    op.add_column("users", sa.Column("terms_accepted_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "terms_accepted_at")
    op.drop_column("users", "privacy_version")
    op.drop_column("users", "terms_version")
