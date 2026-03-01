# Telegram Mini App "НейроСпутник" (MVP)

MVP включает:
- Telegram-бота с кнопкой открытия mini app
- Интерфейс mini app (персонажи + чат)
- API для персонажей и диалога
- Подключение к OpenAI (если задан `OPENAI_API_KEY`)
- Постоянную память в PostgreSQL (если задан `DATABASE_URL`)
- Профиль пользователя и тарифы `free/pro` с дневными лимитами

## Быстрый старт

1. Установи зависимости:
   - `npm install`
2. Создай env-файл:
   - `cp .env.example .env`
3. Заполни переменные:
   - `BOT_TOKEN=<токен_бота_из_BotFather>`
   - `WEBAPP_URL=<публичный_https_URL_твоего_mini_app>`
   - `OPENAI_API_KEY=<твой_API_ключ_OpenAI>` (опционально)
   - `OPENAI_MODEL=gpt-4o-mini` (опционально)
   - `DATABASE_URL=<postgres_connection_string>` (опционально)
   - `DATABASE_SSL=false` (или `true` для облачных БД)
   - `FREE_DAILY_LIMIT=30`
   - `PRO_DAILY_LIMIT=500`
4. Запусти проект:
   - `npm run dev`
   - или `npm run dev:miniapp` (автоподключение HTTPS туннеля)

## Локальная разработка

- Для превью интерфейса открой `http://localhost:3000`.
- Для проверки в Telegram нужен публичный HTTPS URL (например, через ngrok/cloudflared) и этот URL в `WEBAPP_URL`.
- Удобный режим для Telegram: `npm run dev:miniapp` (сам запускает cloudflared и сервер с нужным HTTPS URL).
- Если `OPENAI_API_KEY` не задан, работает встроенная mock-логика ответа.
- Если `DATABASE_URL` не задан, память хранится в оперативке и сбрасывается после перезапуска.

## API

- `GET /api/health`
  - возвращает статус, активный режим AI и режим хранилища
- `GET /api/personas`
- `GET /api/profile?userId=...`
- `POST /api/profile/plan`
  - тело:
    ```json
    {
      "userId": "123",
      "plan": "pro"
    }
    ```
- `POST /api/chat`
  - тело:
    ```json
    {
      "userId": "123",
      "personaId": "luna",
      "message": "привет"
    }
    ```

Чтобы сохранить факт о пользователе, отправь сообщение:
- `запомни: я люблю кофе`

## Режимы работы

- `AI=mock`, `storage=memory`: без внешних сервисов
- `AI=openai`, `storage=memory`: умные ответы без постоянной БД
- `AI=openai`, `storage=postgres`: полный MVP с постоянной памятью и историей

## Лимиты сообщений

- Для тарифа `free` и `pro` задаются отдельные дневные лимиты.
- Лимит считается по пользовательским сообщениям в `/api/chat`.
- При достижении лимита API возвращает `429` и текст ошибки.
