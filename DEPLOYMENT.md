# Развёртывание НейроСпутник

## Продакшен (production)

### Обязательные переменные

| Переменная | Назначение |
|------------|------------|
| `BOT_TOKEN` | Токен Telegram-бота |
| `WEBAPP_URL` | Публичный URL Mini App (https://...) |
| `DATABASE_URL` | **Обязательно** — PostgreSQL connection string. Без него все данные в RAM + файл, при рестарте возможна потеря |
| `OPENAI_API_KEY` | Ключ OpenAI для основного чата |
| `NODE_ENV` | `production` |

### Рекомендуемые

| Переменная | Назначение |
|------------|------------|
| `REDIS_URL` | Redis для rate limiting (если несколько инстансов). Без — in-memory fallback |
| `ADMIN_USER_IDS` | Список Telegram user ID через запятую (для admin-эндпоинтов) |
| `FANTASY_API_KEY` | Ключ uncensored-провайдера для 18+ модуля (опционально) |

### Docker Compose

```bash
# Создай .env с BOT_TOKEN, WEBAPP_URL, OPENAI_API_KEY и др.
cp .env.example .env
# Заполни секреты

docker-compose up -d
```

`docker-compose` уже настроен с:
- `DATABASE_URL=postgresql://botik:botik@postgres:5432/botik`
- `REDIS_URL=redis://redis:6379`
- `NODE_ENV=production`

### Без Docker

1. Установи и запусти PostgreSQL
2. Создай БД: `createdb botik`
3. В `.env`: `DATABASE_URL=postgresql://user:pass@localhost:5432/botik`
4. `npm install && npm start`

При пустом `DATABASE_URL` в production сервер выведет предупреждение в лог.
