from __future__ import annotations

import base64
import hashlib
from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    database_url: str = "postgresql+asyncpg://music_graph:music_graph@localhost:5432/music_graph"
    redis_url: str = "redis://localhost:6379/0"
    secret_key: str = "change-me-in-production"
    fernet_key: str | None = None
    cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173"
    frontend_url: str = "http://localhost:5173"
    mock_yandex: bool = False
    familiar_source_limit: int = 320
    familiar_neighbor_source_limit: int = 90
    deep_familiar_source_limit: int = 60
    familiar_wave_tracks_limit: int = 100
    familiar_collection_tracks_limit: int = 100
    familiar_collection_albums_limit: int = 20
    catalog_collab_source_limit: int = 18
    deep_catalog_collab_source_limit: int = 18
    catalog_tracks_page_size: int = 100
    catalog_tracks_limit_per_artist: int = 180
    deep_catalog_tracks_limit_per_artist: int = 120
    edge_track_title_limit: int = 30
    similar_source_limit: int = 18
    deep_similar_source_limit: int = 10
    similar_artists_per_source: int = 15
    external_fetch_workers: int = 4
    cached_edge_familiar_limit: int = 600
    cached_edge_familiar_depth: int = 2
    jwt_algorithm: str = "HS256"
    access_token_ttl_seconds: int = 60 * 60 * 24 * 14

    @property
    def cors_origin_list(self) -> list[str]:
        return [item.strip() for item in self.cors_origins.split(",") if item.strip()]

    @property
    def effective_fernet_key(self) -> bytes:
        if self.fernet_key:
            return self.fernet_key.encode()
        digest = hashlib.sha256(self.secret_key.encode()).digest()
        return base64.urlsafe_b64encode(digest)


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
