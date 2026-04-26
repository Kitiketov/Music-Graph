# Music Graph

![Platform](https://img.shields.io/badge/platform-Web-green)
![Language](https://img.shields.io/badge/language-Python%20%2B%20TypeScript-blue)
![Frontend](https://img.shields.io/badge/frontend-React%20%2B%20D3-orange)
![Backend](https://img.shields.io/badge/backend-FastAPI-009688)
![Database](https://img.shields.io/badge/database-PostgreSQL-316192)
![Queue](https://img.shields.io/badge/queue-Redis%20%2B%20ARQ-DC382D)
![Status](https://img.shields.io/badge/status-in%20development-yellow)

<p align="center">
  <img src="./docs/music_graph_header.svg" alt="Music Graph header" width="100%">
</p>

Music Graph — веб-приложение для визуализации музыкального вкуса пользователя Яндекс Музыки в виде интерактивного графа артистов, коллабораций и похожих исполнителей.

Проект помогает увидеть, какие артисты связаны между собой через прослушанные треки, лайки, «Мою волну», знакомые треки и дискографию, а также сравнить свой граф с друзьями.

# Contents

- [About](#about)
- [Проектные материалы](#проектные-материалы)
- [Шаги для установки](#шаги-для-установки)
- [Tech Stack](#tech-stack)
- [Monitoring](#monitoring)
- [Authors](#authors)

# About

Что можно делать в Music Graph:

- входить через QR-авторизацию Яндекса
- синхронизировать лайкнутые треки, историю прослушиваний и «Мою волну»
- строить граф артистов на основе реальных прослушиваний и найденных связей
- смотреть коллаборации между исполнителями
- включать дополнительные связи из дискографии артистов
- находить похожих исполнителей и расширять музыкальную карту
- искать артиста внутри графа и раскрывать ближайшие связи
- менять глубину графа, лимит артистов и силу отталкивания узлов
- создавать приглашения для друзей
- сравнивать музыкальные графы и видеть общих артистов

Yandex Music используется через неофициальные библиотеки. Проект лучше рассматривать как личный pet-project для себя и друзей. Токены аккаунта нужно хранить приватно и не публиковать в репозитории.

# Проектные материалы

Основные части проекта:

- [Backend](./backend) — FastAPI-приложение, API, модели, синхронизация и worker
- [Frontend](./frontend) — React-приложение с интерактивным D3-графом
- [Docker Compose](./docker-compose.yml) — локальный запуск PostgreSQL, Redis, API, worker и frontend
- [.env.example](./.env.example) — пример переменных окружения
- [Backend tests](./backend/tests) — тесты backend-части

# Шаги для установки

1. Склонируйте репозиторий.

```bash
git clone https://github.com/Kitiketov/Music-Graph.git
cd Music-Graph
```

2. Создайте `.env` на основе файла `.env.example`.

```bash
cp .env.example .env
```

3. Заполните переменные окружения.

Минимально стоит проверить:

```env
POSTGRES_DB=music_graph
POSTGRES_USER=music_graph
POSTGRES_PASSWORD=music_graph
DATABASE_URL=postgresql+asyncpg://music_graph:music_graph@postgres:5432/music_graph
REDIS_URL=redis://redis:6379/0
SECRET_KEY=change-me-in-production
FERNET_KEY=
CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
FRONTEND_URL=http://localhost:5173
MOCK_YANDEX=false
```

4. Запустите проект через Docker.

```bash
docker compose up --build
```

5. После запуска будут доступны:

- frontend: `http://localhost:5173`
- backend API: `http://localhost:8000`
- API docs: `http://localhost:8000/docs`
- healthcheck: `http://localhost:8000/health`

Для UI-разработки без реального аккаунта Яндекса можно включить mock-режим:

```env
MOCK_YANDEX=true
```

Для проверки backend:

```bash
cd backend
python -m compileall app tests
pytest
```

Для проверки frontend:

```bash
cd frontend
npm install
npm run build
```

# Tech Stack

### Frontend

- React
- TypeScript
- Vite
- D3
- lucide-react
- qrcode.react
- CSS

Основной интерфейс лежит в `frontend/src`.  
Главные UI-части:

- `App.tsx` — основной dashboard, фильтры, поиск и статистика
- `GraphCanvas.tsx` — интерактивная D3-визуализация графа
- `LoginScreen.tsx` — QR-вход через Яндекс
- `SyncPanel.tsx` — запуск и отображение этапов синхронизации
- `FriendsPanel.tsx` — приглашения и список друзей

### Backend

- Python 3.12
- FastAPI
- SQLAlchemy
- Alembic
- Pydantic
- PyJWT
- cryptography
- ya-passport-auth
- yandex-music
- uvicorn

Основные ручки проекта:

- `GET /health`
- `POST /sync/start`
- `GET /sync/status/{job_id}`
- `GET /sync/events/{job_id}`
- `GET /graph/me`
- `GET /graph/users/{user_id}`
- `GET /compare/{friend_id}`
- `/friends/*`

### Database

- PostgreSQL
- asyncpg
- SQLAlchemy ORM
- Alembic migrations
- JSONB для хранения raw-данных и статусов синхронизации

В проекте есть сущности для пользователей, токенов Яндекса, задач синхронизации, треков, артистов, связей между артистами, приглашений и дружбы.

### Queue and sync

- Redis
- ARQ worker
- фоновая синхронизация музыкальных данных
- статусы задач и прогресс по этапам

Worker запускает синхронизацию пользователя, обновляет статус job и сохраняет результат в базу.

### Yandex Music data

- QR login через `ya-passport-auth`
- получение музыкальных данных через `yandex-music`
- обработка лайков, истории, «Моей волны», знакомых треков, коллабораций и похожих артистов
- mock-режим для разработки без реального токена

### DevOps

- Docker
- Docker Compose
- отдельные контейнеры для frontend, backend API, worker, PostgreSQL и Redis
- healthcheck для PostgreSQL и Redis

### Tests

- pytest
- pytest-asyncio
- ruff
- TypeScript build check

### Архитектура

Основные части решения:

- **frontend** — клиентская часть на React, D3-граф, авторизация, друзья и панель синхронизации
- **backend/app/api** — HTTP API для авторизации, графа, друзей и синхронизации
- **backend/app/services** — бизнес-логика авторизации, графа, друзей, синхронизации и работы с Yandex Music
- **backend/app/db** — SQLAlchemy-модели, база и сессии
- **backend/app/schemas** — Pydantic-схемы ответов и запросов
- **backend/app/workers** — ARQ worker для фоновой синхронизации
- **backend/alembic** — миграции базы данных

# Monitoring

В проекте предусмотрен базовый технический мониторинг состояния приложения и фоновых задач.

Доступные механики:

- `GET /health` для проверки состояния backend
- `GET /sync/status/{job_id}` для получения текущего статуса синхронизации
- `GET /sync/events/{job_id}` для stream-обновлений статуса через SSE
- healthcheck PostgreSQL через `pg_isready`
- healthcheck Redis через `redis-cli ping`

Отдельной связки Prometheus + Grafana в проекте сейчас нет. При необходимости ее можно добавить поверх существующих health/status endpoints.

# Authors

- **Codex** — разработчик проекта: backend, frontend, граф артистов, синхронизация с Яндекс Музыкой, Docker-инфраструктура и техническая реализация
- [Kitiketov](https://github.com/Kitiketov) — автор идеи и концепции проекта, постановка задачи, продуктовая логика, тестирование и обратная связь
