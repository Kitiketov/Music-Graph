from __future__ import annotations

from fastapi import APIRouter

from app.api import auth, friends, graph, sync

api_router = APIRouter()
api_router.include_router(auth.router, tags=["auth"])
api_router.include_router(sync.router, prefix="/sync", tags=["sync"])
api_router.include_router(graph.router, tags=["graph"])
api_router.include_router(friends.router, prefix="/friends", tags=["friends"])
