# Промпт: Полное исправление проекта НейроСпутник

Ты работаешь над проектом **НейроСпутник** — Telegram Mini App, AI-компаньон с персонажами.  
Стек: Node.js, Express, PostgreSQL, Grammy (Telegram Bot), OpenAI API, fal.ai.  
Файлы: `src/server.js`, `src/bot.js`, `src/storage.js`, `src/ai.js`, `src/fantasy.js`, `src/events.js`, `src/analytics.js`, `public/app.js`, `public/index.html`.

---

## ЗАДАЧА

Исправь ВСЕ перечисленные ниже баги, недоработки и внедри новую модель монетизации.  
Каждое изменение должно работать и в режиме `memory`, и в режиме `postgres`.  
Не теряй существующую функциональность. Не ломай то, что работает.

---

## ЧАСТЬ 1: КРИТИЧЕСКИЕ БАГИ БЕЗОПАСНОСТИ

### 1.1 Аутентификация — userId должен извлекаться ТОЛЬКО из проверенной Telegram initData

**Где:** `src/server.js`, middleware `/api`

**Текущая проблема:** Если `validateTelegramInitData()` возвращает `null` (невалидная подпись), сервер fallback'ит на `req.body.userId` / `req.query.userId`. Любой может подставить чужой userId.

**Что сделать:**
- В middleware `/api`: если `telegramUser` не получен из initData, устанавливать `req.userId = "anon"` (без fallback на body/query).
- Единственное исключение — режим разработки (`NODE_ENV === "development"`), где допускается fallback для удобства тестирования.
- Убрать передачу `userId` из body во ВСЕХ POST-эндпоинтах — использовать ТОЛЬКО `req.userId` из middleware.
- В `public/app.js` — прекратить отправку `userId` в body запросов. Сервер берёт userId из `X-Telegram-Init-Data`.

```js
app.use("/api", (req, res, next) => {
  const initData = req.headers["x-telegram-init-data"] || req.query?.initData || req.body?.initData;
  const telegramUser = initData ? validateTelegramInitData(initData) : null;
  if (telegramUser && telegramUser.id) {
    req.userId = String(telegramUser.id);
    req.telegramUser = telegramUser;
  } else if (process.env.NODE_ENV === "development") {
    req.userId = String(req.body?.userId ?? req.query?.userId ?? "anon");
  } else {
    req.userId = "anon";
  }
  next();
});
```

### 1.2 Rate limit — ключ должен быть из проверенного userId

**Где:** `src/server.js`, функция `rateLimit`

**Текущая проблема:** `const key = req.body?.userId || req.query?.userId || req.ip` — ключ берётся из тела запроса, можно обойти лимит подставив разные userId.

**Что сделать:** Использовать `req.userId` (уже проверенный middleware):
```js
const key = `rl:${req.userId !== "anon" ? req.userId : req.ip}`;
```

### 1.3 SQL-инъекция в getInactiveUsers

**Где:** `src/storage.js`, функция `getInactiveUsers`

**Текущая проблема:** `INTERVAL '${hoursThreshold} hours'` — строковая интерполяция в SQL.

**Что сделать:** Параметризованный запрос:
```sql
WHERE last_activity < NOW() - ($1::integer * INTERVAL '1 hour')
```

### 1.4 Fantasy pre_checkout_query не валидирует payload "fantasy_plus"

**Где:** `src/bot.js`, обработчик `pre_checkout_query`

**Текущая проблема:** `validPayloads` проверяет только `pro_subscription` и `stars_balance_*`. Payload `fantasy_plus` отклоняется.

**Что сделать:** Добавить `payload === "fantasy_plus"` в проверку:
```js
const validPayloads = payload === "pro_subscription" || payload === "fantasy_plus" || payload.startsWith("stars_balance_");
```

---

## ЧАСТЬ 2: БАГИ ХРАНИЛИЩА (POSTGRES)

### 2.1 Профиль: referral_code не генерируется при создании

**Где:** `src/storage.js`, функция `ensureUserProfile` (ветка postgres)

**Текущая проблема:** INSERT создаёт профиль только с `(user_id, plan)`. Поле `referral_code` остаётся NULL. SELECT выбирает только `user_id, plan` — не возвращает `referral_code`, `bonus_messages`, `trial_ends_at`, `stars_balance`.

**Что сделать:**
- При INSERT генерировать `referral_code` (использовать `generateReferralCode()` или аналог).
- При INSERT выставлять `plan = 'pro'`, `trial_ends_at = NOW() + INTERVAL '3 days'` для нового пользователя (триал).
- SELECT должен возвращать ВСЕ нужные поля: `user_id, plan, referral_code, bonus_messages, stars_balance, trial_ends_at, referred_by, referral_count, referral_pro_ends_at, created_at`.

### 2.2 Стрики: бонусные сообщения не начисляются в Postgres

**Где:** `src/storage.js`, функция `updateStreak` (ветка postgres)

**Текущая проблема:** В memory-режиме при стрике 7 и 30 начисляются бонусы (`profile.bonusMessages += 10/30`). В postgres — только обновляется таблица стриков.

**Что сделать:** После обновления стрика в postgres, если `currentStreak === 7`:
```sql
UPDATE user_profiles SET bonus_messages = bonus_messages + 10 WHERE user_id = $1
```
Аналогично для `currentStreak === 30` — `+30`.

### 2.3 Триал Pro: не реализован в Postgres

**Где:** `src/storage.js`, `src/server.js`

**Текущая проблема:** В memory новый пользователь получает `plan: "pro"` + `trialEndsAt` (3 дня). В postgres — нет.

**Что сделать:**
- В `ensureUserProfile` (postgres): при INSERT выставлять `plan = 'pro'`, `trial_ends_at = NOW() + INTERVAL '3 days'`.
- В `getUserProfile`: добавить логику `resolveTrialPlan` — если `plan === 'pro'` и `trial_ends_at` прошёл, выполнить:
  ```sql
  UPDATE user_profiles SET plan = 'free' WHERE user_id = $1
  ```
  И вернуть `plan: 'free'`.
- Эта логика должна работать и в memory, и в postgres единообразно.

### 2.4 Активные свидания не персистятся в Postgres

**Где:** `src/storage.js`, функции `getActiveDate`, `setActiveDate`, `clearActiveDate`

**Текущая проблема:** Работают только с `memoryDates`. При рестарте сервера в postgres свидания теряются.

**Что сделать:** Создать таблицу `active_dates` в `initStorage`:
```sql
CREATE TABLE IF NOT EXISTS active_dates (
  user_id TEXT NOT NULL,
  persona_id TEXT NOT NULL,
  scenario TEXT,
  round INTEGER DEFAULT 0,
  data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, persona_id)
);
```
Имплементировать `getActiveDate`, `setActiveDate`, `clearActiveDate` для postgres.

### 2.5 lastChatPersona не персистится в Postgres

**Где:** `src/storage.js`, функции `setLastChatPersona`, `getLastChatPersona`

**Текущая проблема:** Только memory. Ревность не работает после рестарта.

**Что сделать:** Добавить поле `last_chat_persona TEXT` в таблицу `user_profiles` (или отдельную таблицу).  
Имплементировать get/set для postgres.

---

## ЧАСТЬ 3: ЛОГИЧЕСКИЕ ОШИБКИ

### 3.1 Бонусные сообщения не учитываются в лимите

**Где:** `src/server.js`, проверка лимита перед чатом (`POST /api/chat`)

**Текущая проблема:** Лимит проверяется как `usageToday >= limitToday`. Поле `bonusMessages` не участвует.

**Что сделать:**
- Эффективный лимит = `planLimit + bonusMessages`.
- При отправке сообщения: если `usageToday >= planLimit`, списать 1 из `bonusMessages` (через `decrementBonusMessage`).
- Если и бонусы = 0 — отказ.
- В ответе `/api/profile` возвращать: `effectiveLimit: planLimit + bonusMessages`.

### 3.2 Подарки: Stars не списываются через платёж

**Где:** `src/server.js`, `POST /api/gift`

**Текущая проблема:** Подарки имеют цену в Stars (`gift.stars`), баланс проверяется и списывается из внутреннего баланса. Но это работает только если пользователь предварительно пополнил баланс через `/api/create-invoice` type=stars.

**Что проверить и доработать:**
- Убедиться, что endpoint `/api/create-invoice` с `type: "stars"` работает корректно.
- На фронте в `public/app.js` при недостатке Stars для подарка — показывать кнопку «Пополнить баланс» с вызовом `/api/create-invoice`.
- Обновить цены подарков (см. раздел монетизации ниже).

### 3.3 Ошибки парсинга JSON от OpenAI

**Где:** `src/ai.js` — `generatePersona`, `generateDateScene` и другие функции, парсящие JSON из ответа модели.

**Текущая проблема:** `JSON.parse(raw)` без try/catch в нескольких местах. Невалидный ответ модели роняет сервер.

**Что сделать:** Обернуть ВСЕ `JSON.parse(raw)` вызовы при парсинге ответов AI в try/catch. При ошибке — логировать `raw`, возвращать fallback/понятную ошибку пользователю.

### 3.4 Кастомные персонажи не отображаются на фронте

**Где:** `public/app.js`

**Текущая проблема:** Список персонажей строится только из `/api/personas`. Кастомные персонажи (созданные через `/api/custom-personas`) не показываются в сетке.

**Что сделать:**
- При загрузке данных вызывать `/api/custom-personas?userId=...` (или использовать req.userId на сервере).
- Добавлять кастомных персонажей в сетку выбора с пометкой «Мой персонаж».
- Кастомные персонажи должны быть доступны для чата и свиданий.

### 3.5 Сцены (scenes) из ai.js не используются

**Где:** `src/ai.js` — `getScenes()`, `src/server.js` — `/api/scenes`, `public/app.js`

**Текущая проблема:** Сцены определены, API есть, но фронт их не показывает и не запускает.

**Что сделать:** Выбери одно:
- **Вариант A (рекомендуется):** Убрать `scenes` из ai.js и эндпоинт `/api/scenes` — они дублируют `dateScenarios`.
- **Вариант B:** Интегрировать как отдельный режим «Ролевая сцена» с кастомной атмосферой (выбор места, описание обстановки).

Реализуй **вариант A** — убери мёртвый код.

---

## ЧАСТЬ 4: МОНЕТИЗАЦИЯ — НОВАЯ ЦЕНОВАЯ МОДЕЛЬ

### Контекст рынка
- 1 Telegram Star ≈ $0.02 USD
- Character.ai+: ~$10/мес, Replika Pro: ~$20/мес, Chai: ~$14/мес
- Для Telegram Mini App в русскоязычном сегменте — ниже, но с запасом для роста

### 4.1 Тарифные планы

| План | Цена | Что включено |
|------|------|-------------|
| **Free** | 0 | 3 персонажа (Луна, Мила, Нова), 25 сообщений/день, 1 кастомный персонаж, базовые свидания (парк, кино, дома) |
| **Pro** | **299 Stars/мес** (~$6) | Все 11 персонажей, 300 сообщений/день, 3 кастомных персонажа, все сценарии свиданий, память, стрики-бонусы, дневник, таймлайн, лидерборд, приоритетные ответы |
| **Fantasy+** | **449 Stars/мес** (~$9) | Всё из Pro + модуль «Фантазии 18+»: 15 ролевых сценариев, свободный чат, интерактивные истории, конструктор Fantasy-персонажей, генерация аватаров |

### 4.2 Триал
- Новый пользователь получает **3 дня Pro** бесплатно.
- Fantasy+ **НЕ** входит в триал — только Pro.
- После окончания триала — показать экран сравнения Free vs Pro vs Fantasy+ с кнопками оплаты.

### 4.3 Подарки (Stars из баланса)

| Подарок | Цена (Stars) | XP |
|---------|-------------|-----|
| Роза | 5 | 10 |
| Шоколад | 10 | 15 |
| Плюшевый мишка | 25 | 30 |
| Парфюм | 50 | 50 |
| Ужин в ресторане | 100 | 80 |
| Кольцо | 200 | 150 |

### 4.4 Пополнение баланса Stars

Пресеты для пополнения:
- 50 Stars
- 100 Stars
- 250 Stars
- 500 Stars
- 1000 Stars

### 4.5 Реферальная программа

| Действие | Награда |
|----------|---------|
| Пригласил друга (друг зарегался) | +10 бонусных сообщений приглашающему |
| Друг купил Pro | +3 дня Pro приглашающему |
| 5 приглашённых друзей | +50 бонусных сообщений |
| 10 приглашённых друзей | +7 дней Pro |

---

## ЧАСТЬ 5: РЕАЛИЗАЦИЯ ПЛАТНОГО FANTASY+ 18+

### 5.1 Fantasy+ теперь платный модуль

**Где:** `src/server.js`, `src/bot.js`, `public/app.js`

**Текущая проблема:** Строка `/* Fantasy invoice endpoint removed — module is free */` в server.js. Fantasy модуль бесплатен.

**Что сделать:**

1. **Удалить комментарий** `/* Fantasy invoice endpoint removed — module is free */`.

2. **Восстановить и обновить endpoint** `POST /api/fantasy/subscribe`:
```js
app.post("/api/fantasy/subscribe", async (req, res) => {
  try {
    const already = await hasFantasyAccess(req.userId);
    if (already) return res.json({ ok: true, alreadyActive: true });

    if (!botInstance) return res.status(400).json({ error: "Бот не настроен" });

    const title = "Fantasy+ Подписка — НейроСпутник";
    const description = "Полный доступ к модулю Фантазии 18+: 15 сценариев, свободный чат, истории, конструктор персонажей. 30 дней.";
    const payload = "fantasy_plus";
    const prices = [{ label: "Fantasy+ (30 дней)", amount: 449 }];
    const link = await botInstance.api.createInvoiceLink(title, description, payload, "", "XTR", prices);
    return res.json({ ok: true, invoiceLink: link });
  } catch (e) {
    console.error("Fantasy subscribe error:", e.message);
    return res.status(500).json({ error: "Ошибка создания платежа" });
  }
});
```

3. **Middleware `requireFantasyAccess`** уже есть — убедиться, что он применяется ко ВСЕМ fantasy-эндпоинтам:
   - `POST /api/fantasy/chat`
   - `POST /api/fantasy/create-persona`
   - `GET /api/fantasy/personas`
   - `DELETE /api/fantasy/persona/:id`
   - `POST /api/fantasy/story/start`
   - `POST /api/fantasy/story/choice`
   - `POST /api/fantasy/avatar`
   
   Кроме:
   - `GET /api/fantasy/access` — проверка доступа (без middleware)
   - `GET /api/fantasy/scenarios` — список сценариев (без middleware, чтобы показывать превью)
   - `POST /api/fantasy/subscribe` — покупка (без middleware)

4. **В `src/bot.js`:**
   - Команда `/fantasy` — показывать описание модуля и кнопку покупки (449 Stars).
   - Добавить `payload === "fantasy_plus"` в `pre_checkout_query` валидацию.

5. **На фронте (`public/app.js`):**
   - При попытке зайти в Fantasy без подписки — показывать экран:
     - Описание модуля с превью сценариев
     - Цена: 449 Stars / 30 дней
     - Кнопка «Подписаться»
     - Если у пользователя нет Pro — предложить сначала Pro, потом Fantasy+
   - Показывать дату истечения Fantasy+ в профиле.

### 5.2 Обновить цену Pro подписки

**Где:** `src/bot.js` (константа `PRO_PRICE_STARS`), `src/server.js` (`POST /api/create-invoice`)

**Что сделать:**
- Изменить `PRO_PRICE_STARS = 200` → `PRO_PRICE_STARS = 299`.
- В `POST /api/create-invoice`:
```js
const link = await tempBot.api.createInvoiceLink(
  "Pro подписка — НейроСпутник",
  "Все 11 персонажей, 300 сообщений/день, все сценарии, память, стрики, дневник, приоритетные ответы. 30 дней.",
  "pro_subscription", "", "XTR",
  [{ label: "Pro подписка (30 дней)", amount: 299 }],
);
```

### 5.3 Обновить цены подарков

**Где:** `src/storage.js`, массив `GIFTS`

```js
const GIFTS = [
  { id: "rose",      name: "Роза",              emoji: "🌹", stars: 5,   xp: 10  },
  { id: "chocolate", name: "Шоколад",           emoji: "🍫", stars: 10,  xp: 15  },
  { id: "teddy",     name: "Плюшевый мишка",    emoji: "🧸", stars: 25,  xp: 30  },
  { id: "perfume",   name: "Парфюм",            emoji: "🌸", stars: 50,  xp: 50  },
  { id: "dinner",    name: "Ужин в ресторане",   emoji: "🍷", stars: 100, xp: 80  },
  { id: "ring",      name: "Кольцо",            emoji: "💍", stars: 200, xp: 150 },
];
```

### 5.4 Pro-подписка должна быть временной (30 дней)

**Где:** `src/storage.js`, `src/server.js`

**Текущая проблема:** `setUserPlan(userId, "pro")` выставляет план навсегда. Нет поля `pro_expires_at`.

**Что сделать:**
- Добавить поле `pro_expires_at TIMESTAMPTZ` в таблицу `user_profiles`.
- При оплате Pro: `setUserPlan(userId, "pro", 30)` — выставлять `pro_expires_at = NOW() + 30 days`.
- В `getUserProfile`: если `pro_expires_at` прошёл — автоматически откатывать на `free` (аналогично триалу).
- В memory-режиме — та же логика с `proExpiresAt`.
- На фронте в профиле — показывать дату окончания Pro.

### 5.5 FREE_DAILY_LIMIT обновить

**Где:** `src/server.js`, `.env.example`

Изменить значение по умолчанию:
```js
const FREE_DAILY_LIMIT = Number(process.env.FREE_DAILY_LIMIT || 25);
```

---

## ЧАСТЬ 6: РЕФАКТОРИНГ

### 6.1 Разбить server.js на модули

**Текущая проблема:** `server.js` — 5362 строки, 40+ эндпоинтов.

**Что сделать:** Разбить на файлы-роутеры:

```
src/
├── server.js           (точка входа, middleware, инициализация — ~200 строк)
├── routes/
│   ├── profile.js      (профиль, план, стрики, реферралы)
│   ├── chat.js         (чат, сообщения, факты, память)
│   ├── personas.js     (персонажи, кастомные персонажи)
│   ├── gifts.js        (подарки, баланс, инвойсы)
│   ├── dates.js        (свидания, сцены)
│   ├── fantasy.js      (Fantasy+ модуль)
│   ├── social.js       (лидерборд, достижения, квесты, истории)
│   └── admin.js        (статистика, аналитика)
├── middleware/
│   ├── auth.js         (validateTelegramInitData, userId extraction)
│   └── rateLimit.js    (rate limiting)
├── bot.js
├── storage.js
├── ai.js
├── fantasy.js
├── events.js
├── analytics.js
└── stories.js
```

Каждый роутер экспортирует `express.Router()`, подключается в `server.js`:
```js
app.use("/api", require("./routes/profile"));
app.use("/api", require("./routes/chat"));
// ...
```

### 6.2 Вынести константы

Создать `src/config.js`:
```js
module.exports = {
  PRO_PRICE_STARS: 299,
  FANTASY_PRICE_STARS: 449,
  FREE_DAILY_LIMIT: Number(process.env.FREE_DAILY_LIMIT || 25),
  PRO_DAILY_LIMIT: Number(process.env.PRO_DAILY_LIMIT || 300),
  TRIAL_DAYS: 3,
  PRO_DURATION_DAYS: 30,
  FANTASY_DURATION_DAYS: 30,
  STARS_MIN_TOPUP: 50,
  STARS_MAX_TOPUP: 1000,
  RATE_LIMIT_WINDOW: 60_000,
  RATE_LIMIT_MAX: 30,
};
```

---

## ЧАСТЬ 7: ФРОНТЕНД

### 7.1 Убрать отправку userId из тела запросов

**Где:** `public/app.js`

Во ВСЕХ `apiPost` вызовах убрать `userId` из body. Сервер определяет userId из `X-Telegram-Init-Data`.

### 7.2 Показывать лимит сообщений в чате

**Где:** `public/app.js`, `public/index.html`

В шапке чата или под полем ввода отображать: «Осталось X из Y сообщений».  
При X <= 5 — предупреждение жёлтым. При X = 0 — блокировка с кнопкой «Обновить до Pro».

### 7.3 Экран истечения триала / Pro

Когда пользователь заходит после истечения триала или Pro:
- Показать модальное окно с текстом «Твой Pro истёк»
- Таблица сравнения Free vs Pro vs Fantasy+
- Кнопки оплаты для каждого плана

### 7.4 Fantasy+ paywall на фронте

При нажатии на вкладку/раздел Fantasy:
- Если нет доступа — показать привлекательный paywall:
  - Описание модуля, скриншоты/превью 3-4 сценариев
  - Цена: 449 Stars / 30 дней
  - Кнопка «Подписаться на Fantasy+»
- Если есть доступ — показать дату истечения в профиле

### 7.5 Пополнение баланса Stars

В профиле или при недостатке Stars для подарка — кнопка «Пополнить баланс» с пресетами: 50, 100, 250, 500, 1000 Stars.

---

## ЧАСТЬ 8: ТЕСТЫ

### 8.1 Установить Jest

Добавить `jest` в devDependencies. Обновить `package.json`:
```json
"scripts": {
  "test": "jest --forceExit --detectOpenHandles"
}
```

### 8.2 Написать тесты

Минимальный набор тестов:

**tests/storage.test.js** — расширить существующий:
- Профиль: создание, триал, истечение триала, referral_code
- Стрики: бонусы за 7 и 30 дней
- Баланс: пополнение, списание, недостаточно средств
- Fantasy access: grant, check, expiration
- Pro expiration: покупка, проверка, истечение

**tests/api.test.js** — новый файл:
- `GET /api/profile` — возвращает все поля
- `POST /api/chat` — лимит, бонусные сообщения
- `POST /api/gift` — списание Stars, недостаток
- `POST /api/create-invoice` — pro, stars, fantasy
- `POST /api/fantasy/subscribe` — создание платежа
- Fantasy endpoints — 403 без подписки

---

## ЧАСТЬ 9: ОБНОВИТЬ .env.example

```env
# Telegram
BOT_TOKEN=
WEBAPP_URL=http://localhost:3000
BOT_USERNAME=

# OpenAI
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4o-mini
OPENAI_BASE_URL=

# Fantasy (18+) — отдельный провайдер AI (опционально)
FANTASY_API_KEY=
FANTASY_BASE_URL=
FANTASY_MODEL=

# Изображения
FAL_API_KEY=

# База данных
DATABASE_URL=postgresql://botik:botik@localhost:5432/botik
DATABASE_SSL=false

# Redis (опционально, для rate limiting)
REDIS_URL=

# Лимиты
FREE_DAILY_LIMIT=25
PRO_DAILY_LIMIT=300

# Окружение
NODE_ENV=development
PORT=3000
```

---

## ПРИОРИТЕТ ВЫПОЛНЕНИЯ

1. **Безопасность** (часть 1) — без этого нельзя в прод
2. **Postgres-баги** (часть 2) — основа корректной работы
3. **Монетизация** (части 4, 5) — Pro 299 Stars, Fantasy+ 449 Stars, подарки, триал, истечение подписок
4. **Логические ошибки** (часть 3) — бонусы, лимиты, JSON-парсинг
5. **Фронтенд** (часть 7) — paywall, лимиты, баланс
6. **Рефакторинг** (часть 6) — разбивка server.js
7. **Тесты** (часть 8) — Jest, покрытие
8. **.env** (часть 9) — обновить пример

---

## ОГРАНИЧЕНИЯ

- НЕ меняй поведение персонажей (behavior массивы в ai.js, fantasy.js).
- НЕ удаляй существующие персонажи или сценарии.
- НЕ ломай существующий memory-режим — он нужен для разработки.
- ВСЕ тексты интерфейса — на русском языке.
- ВСЕ ответы API — формат JSON.
- НЕ добавляй новые зависимости кроме `jest` (devDependency для тестов).
