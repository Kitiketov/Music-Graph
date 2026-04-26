# Music Graph

FastAPI + React + D3 app for visualizing a Yandex Music listening graph and comparing it with friends.

## What is implemented

- QR login flow through `ya-passport-auth` with app JWT sessions.
- PostgreSQL models for users, credentials, sync jobs, tracks, artists, edges, invites, and friendships.
- ARQ worker that syncs Yandex Music history / "My Wave" data through `yandex-music`.
- React + D3 dashboard with graph limit slider, search, edge filters, friend invites, and shared artist highlighting.
- Mock Yandex mode for development without a real account token.

Yandex Music is accessed through unofficial libraries. Treat this as a personal/friends project and keep tokens private.

## Run with Docker

```bash
cp .env.example .env
docker compose up --build
```

Open:

- Frontend: http://localhost:5173
- API docs: http://localhost:8000/docs

For UI development without real Yandex auth, set this in `.env`:

```env
MOCK_YANDEX=true
```

## Backend checks

```bash
cd backend
python -m compileall app tests
pytest
```

## Frontend checks

```bash
cd frontend
npm install
npm run build
```
