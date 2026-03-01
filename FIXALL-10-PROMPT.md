# ПРОМПТ: Довести НейроСпутник до 10/10

## Контекст
Telegram Mini App «НейроСпутник» — AI-компаньон (15 персонажей, чат, свидания, подарки, Fantasy 18+).  
Стек: Node.js, Express, grammY, OpenAI, PostgreSQL, Redis, Vanilla JS.  
Текущая оценка: **7.4/10**. Цель: **10/10**.

---

## ЧАСТЬ 1: АРХИТЕКТУРА (6.5 → 10)

### 1.1. Разбить `server.js` (1501 строка) на роутеры

Создать директорию `src/routes/` и вынести эндпоинты:

```
src/routes/
  profile.js     — GET /api/profile, POST /api/referral, GET /api/referral-stats
  chat.js        — POST /api/chat, GET /api/history
  gifts.js       — GET /api/gifts, POST /api/gift
  personas.js    — GET /api/personas, POST /api/generate-persona, GET/DELETE /api/custom-personas
  dating.js      — POST /api/date/start, POST /api/date/choice, GET /api/date/active
  fantasy.js     — все /api/fantasy/* эндпоинты
  payments.js    — POST /api/create-invoice, POST /api/fantasy/subscribe
  social.js      — GET /api/leaderboard, GET /api/achievements, GET /api/stories, POST /api/stories/react
  games.js       — POST /api/challenge/start, GET /api/quests, POST /api/quiz/*
  admin.js       — GET /api/admin/stats
  misc.js        — GET /api/health, GET /api/pricing, GET /api/events, GET /api/moods, GET /api/scenes
  onboarding.js  — POST /api/onboarding-greeting, POST /api/track-event
```

В `server.js` оставить только:
- Инициализацию Express, middleware, static
- `require` роутеров: `app.use("/api", require("./routes/profile"))` и т.д.
- Инициализацию бота и scheduler
- Функцию `start()`

Каждый роутер — `express.Router()`, экспортируется как модуль. Общие зависимости (storage, ai, config, log) передаются через closure или DI.

### 1.2. Разбить `storage.js` (2178 строк) на модули

```
src/storage/
  index.js          — initStorage, getStorageMode, getPool, реэкспорт всего
  profiles.js       — ensureUserProfile, getUserProfile, setUserPlan, getAllUserProfiles
  chat.js           — addChatMessage, getRecentChatMessages, getChatHistory
  affection.js      — getAffection, addAffectionXp, getAllAffections, calcLevel, AFFECTION_LEVELS
  usage.js          — getTodayUsageCount, incrementTodayUsage, decrementBonusMessage
  balance.js        — getBalance, addBalance, deductBalance
  streaks.js        — updateStreak, getStreak
  gifts.js          — recordGift, getGifts, getLastGift, GIFTS
  dating.js         — getActiveDate, setActiveDate, clearActiveDate, DATE_SCENARIOS
  achievements.js   — getAchievementsList, getAchievements, unlockAchievement, ACHIEVEMENTS
  notifications.js  — getNotifSettings, setNotifSettings, getAllNotifUsers
  game-stats.js     — getGameStats, incrementGameStat, getLeaderboard
  facts.js          — getUserFacts, addUserFact
  referrals.js      — processReferral, getReferralStats, generateReferralCode, decodeReferralCode
  fantasy.js        — saveFantasyPersona, getFantasyPersonas, deleteFantasyPersona, hasFantasyAccess, grantFantasyAccess
  mood.js           — getGirlMood, setGirlMood, getGirlMoodPrompt, GIRL_MOODS
  timeline.js       — addTimelineEvent, getTimeline, getTimelineStats
  quests.js         — getUserQuests, updateQuestProgress, QUESTS
  stories.js        — addStory, getRecentStories, reactToStory
  custom-personas.js— saveCustomPersona, getCustomPersonas, getCustomPersona, deleteCustomPersona
```

Все модули получают `pool` и `mode` через shared state из `index.js`.

### 1.3. Разбить `ai.js` (1373 строки) на модули

```
src/ai/
  index.js          — реэкспорт
  client.js         — OpenAI client инициализация, общая функция callAI()
  personas.js       — определения 15 персонажей, getPersonas, getPersonaById
  chat.js           — generateReply
  reactions.js      — generateGiftReaction, generateJealousyReaction, generateComplimentReaction
  dating.js         — generateDateScene, generateDateReaction
  greeting.js       — generateGreeting
  games.js          — generateTruthOrDare, generateMoodGuess
  facts.js          — extractFacts
  stories.js        — generateStory
  mood-analyzer.js  — analyzeMoodFromMessage, detectSpecialMoment
  diary.js          — getDiaryEntries
  selfie.js         — generateSelfiePrompt
  story-arcs.js     — getCurrentArc, getCurrentChapter, getStoryArcs
```

### 1.4. Извлечь middleware

Создать `src/middleware/`:
```
src/middleware/
  auth.js           — validateTelegramInitData + userId extraction
  rate-limit.js     — rateLimit middleware (Redis + memory fallback)
  http-logger.js    — request/response logging
  error-handler.js  — централизованная обработка ошибок (try-catch wrapper)
```

Обёртка для route handler чтобы не писать try-catch в каждом:
```js
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
```

---

## ЧАСТЬ 2: БЕЗОПАСНОСТЬ (7.5 → 10)

### 2.1. Добавить helmet.js

```bash
npm install helmet
```

В `server.js`:
```js
const helmet = require("helmet");
app.use(helmet({ contentSecurityPolicy: false })); // CSP отключен для inline-styles в Mini App
```

### 2.2. Мигрировать `console.error` → `log` в `ai.js` и `fantasy.js`

В `src/ai.js` (14 мест) и `src/fantasy.js` (1 место) — заменить все `console.error(...)` на `log.error(...)`:
```js
const log = require("./logger").child({ module: "ai" });
```

Список строк в ai.js: 591, 604, 741, 770, 822, 835, 865, 1040, 1081, 1114, 1140, 1236, 1262, 1291.
В fantasy.js: строка 547.

### 2.3. Валидация `POST /api/track-event`

Добавить whitelist допустимых событий:
```js
const ALLOWED_CLIENT_EVENTS = new Set([
  "onboarding_completed", "page_view", "persona_selected",
  "gift_panel_opened", "paywall_shown", "share_clicked",
]);

app.post("/api/track-event", (req, res) => {
  const { event, data } = req.body || {};
  if (!event || !ALLOWED_CLIENT_EVENTS.has(event)) return res.json({ ok: false });
  trackEvent(req.userId, event, data || {});
  return res.json({ ok: true });
});
```

### 2.4. Добавить Content-Security-Policy для API

В middleware:
```js
app.use("/api", (_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  next();
});
```

### 2.5. Rate limit на публичные эндпоинты

Применить `rateLimit` middleware также к:
```js
app.use("/api/create-invoice", rateLimit);
app.use("/api/gift", rateLimit);
app.use("/api/generate-persona", rateLimit);
app.use("/api/selfie", rateLimit);
app.use("/api/fantasy/chat", rateLimit);
app.use("/api/onboarding-greeting", rateLimit);
app.use("/api/track-event", rateLimit);
```

---

## ЧАСТЬ 3: БАЗА ДАННЫХ (7 → 10)

### 3.1. Удалить мёртвый код `getGameState`/`setGameState`

В `storage.js`:
- Удалить функции `getGameState`, `setGameState` (строки 1426–1433)
- Удалить `memoryGameState` Map (строка 1424)
- Удалить из exports: `getGameState`, `setGameState`

### 3.2. Исправить двойную запись в `setActiveDate`/`clearActiveDate`

Текущий код пишет и в memory, и в postgres. Исправить:
```js
async function setActiveDate(userId, dateState) {
  if (mode === "memory") {
    memoryDates.set(dateKey(userId), dateState);
    return;
  }
  await pool.query(
    `INSERT INTO active_dates (user_id, data, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
    [userId, JSON.stringify(dateState)]
  );
}

async function clearActiveDate(userId) {
  if (mode === "memory") {
    memoryDates.delete(dateKey(userId));
    return;
  }
  await pool.query(`DELETE FROM active_dates WHERE user_id = $1`, [userId]);
}
```

### 3.3. Добавить connection pool настройки

В `initStorage()`:
```js
pool = new Pool({
  connectionString: databaseUrl,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
  max: Number(process.env.PG_MAX_CONNECTIONS || 20),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});
pool.on("error", (err) => log.error({ err }, "Unexpected PG pool error"));
```

Добавить в `.env.example`:
```
PG_MAX_CONNECTIONS=20
```

### 3.4. Обернуть `initStorage` в try-catch для каждого CREATE TABLE

Текущий код: если одна таблица падает — всё падает. Сделать resilient:
```js
async function safeQuery(sql, label) {
  try {
    await pool.query(sql);
  } catch (e) {
    log.error({ err: e, table: label }, "Table creation failed");
    throw e;
  }
}
```

### 3.5. Добавить error handling в postgres-функции без try-catch

Функции, которым нужен try-catch в postgres ветке:
- `addUserFact` (строка ~397)
- `addChatMessage` (строка ~422)
- `getActiveDate` (строка ~1292)
- Все остальные postgres-функции без обработки ошибок

Паттерн:
```js
try {
  await pool.query(...);
} catch (e) {
  log.error({ err: e, userId }, "functionName pg error");
  throw e; // или return fallback
}
```

### 3.6. Создать систему миграций

Создать `src/migrations.js`:
```js
const MIGRATIONS = [
  { id: 1, name: "initial_schema", up: async (pool) => { /* все CREATE TABLE */ } },
  { id: 2, name: "add_game_stats", up: async (pool) => { /* CREATE TABLE game_stats */ } },
  { id: 3, name: "add_pro_expires_at", up: async (pool) => { /* ALTER TABLE */ } },
];

async function runMigrations(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS migrations (id INT PRIMARY KEY, name TEXT, ran_at TIMESTAMPTZ DEFAULT NOW())`);
  const { rows } = await pool.query(`SELECT id FROM migrations ORDER BY id`);
  const done = new Set(rows.map(r => r.id));
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    log.info({ migration: m.name }, "Running migration");
    await m.up(pool);
    await pool.query(`INSERT INTO migrations (id, name) VALUES ($1, $2)`, [m.id, m.name]);
  }
}
```

---

## ЧАСТЬ 4: AI-ИНТЕГРАЦИЯ (8 → 10)

### 4.1. Добавить fallback-ответы при ошибке OpenAI

В `generateReply`:
```js
const FALLBACK_REPLIES = [
  "Прости, я немного задумалась... Повтори, пожалуйста? 🙈",
  "Ой, у меня мысли запутались. Напиши ещё раз? 💭",
  "Что-то я отвлеклась... О чём мы говорили? 😅",
];

try {
  const reply = await client.chat.completions.create(...);
  return reply.choices[0]?.message?.content || pickRandom(FALLBACK_REPLIES);
} catch (e) {
  log.error({ err: e, personaId }, "AI generation failed");
  return pickRandom(FALLBACK_REPLIES);
}
```

Аналогично для `generateGiftReaction`, `generateDateScene`, `generateGreeting` — каждая функция должна возвращать осмысленный fallback вместо "Ошибка".

### 4.2. Вынести AI timeout в config.js

```js
// config.js
AI_CHAT_TIMEOUT_MS: Number(process.env.AI_CHAT_TIMEOUT_MS || 75000),
AI_SHORT_TIMEOUT_MS: Number(process.env.AI_SHORT_TIMEOUT_MS || 30000),
```

В server.js заменить хардкод `75000`:
```js
const { AI_CHAT_TIMEOUT_MS } = require("./config");
```

### 4.3. Вынести max message length в config

```js
// config.js
MAX_MESSAGE_LENGTH: 2000,
MAX_FACTS_PER_USER: 50,
MAX_CHAT_HISTORY: 100,
SELFIE_DAILY_LIMIT: 3,
```

Заменить хардкоды в server.js (строка 687) и storage.js (строки 391, 416).

---

## ЧАСТЬ 5: МОНЕТИЗАЦИЯ (8 → 10)

### 5.1. Напоминание об истечении подписки

В `src/notifications.js` добавить функцию:
```js
async function runSubscriptionReminders({ bot, webAppUrl, getAllUserProfiles, trackEvent }) {
  const allProfiles = await getAllUserProfiles();
  const now = Date.now();
  const THREE_DAYS = 3 * 86400000;
  const ONE_DAY = 86400000;
  let sent = 0;

  for (const [userId, profile] of Object.entries(allProfiles)) {
    if (!profile.chatId || profile.plan !== "pro") continue;
    if (!profile.proExpiresAt) continue;
    const expiresAt = new Date(profile.proExpiresAt).getTime();
    const remaining = expiresAt - now;

    if (remaining <= 0 || remaining > THREE_DAYS) continue;
    if (isOnCooldown(userId, "sub_reminder")) continue;

    const days = Math.ceil(remaining / ONE_DAY);
    const message = days <= 1
      ? "⚠️ Твоя Pro подписка истекает сегодня! Продли, чтобы не потерять доступ ко всем 15 персонажам."
      : `⏰ Твоя Pro подписка истекает через ${days} дня. Продли, чтобы не потерять прогресс!`;

    try {
      await bot.api.sendMessage(profile.chatId, message, {
        reply_markup: { inline_keyboard: [[{ text: "⭐ Продлить Pro", callback_data: "buy_pro" }]] },
      });
      markSent(userId, "sub_reminder");
      sent++;
      if (trackEvent) trackEvent(userId, "sub_reminder_sent", { daysLeft: days });
    } catch {}
  }
  if (sent > 0) log.info({ sent }, "Subscription reminders sent");
}
```

В `server.js` зарегистрировать:
```js
schedule("subscription_reminders", 6 * 60 * 60 * 1000, () => runSubscriptionReminders(notifDeps));
```

### 5.2. Промокоды

В `storage.js` добавить таблицу и функции:
```sql
CREATE TABLE IF NOT EXISTS promo_codes (
  code TEXT PRIMARY KEY,
  type TEXT NOT NULL, -- 'pro_days', 'stars', 'bonus_messages'
  value INTEGER NOT NULL,
  max_uses INTEGER DEFAULT 1,
  used_count INTEGER DEFAULT 0,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS promo_redemptions (
  user_id TEXT NOT NULL,
  code TEXT NOT NULL,
  redeemed_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, code)
);
```

Функции: `createPromoCode(code, type, value, maxUses, expiresAt)`, `redeemPromoCode(userId, code)`.

Эндпоинт: `POST /api/promo` — применить промокод.

---

## ЧАСТЬ 6: ФРОНТЕНД (7 → 10)

### 6.1. Кэширование API-ответов

В `app.js` добавить простой cache layer:
```js
const apiCache = new Map();
const CACHE_TTL = { "/api/personas": 300000, "/api/gifts": 300000, "/api/moods": 600000, "/api/events": 60000 };

async function cachedGet(url) {
  const ttl = CACHE_TTL[url];
  if (ttl && apiCache.has(url)) {
    const { data, at } = apiCache.get(url);
    if (Date.now() - at < ttl) return data;
  }
  const r = await apiGet(url);
  if (!r.ok) return null;
  const data = await r.json();
  if (ttl) apiCache.set(url, { data, at: Date.now() });
  return data;
}
```

Заменить `apiGet("/api/personas")`, `apiGet("/api/gifts")` и т.д. на `cachedGet(...)`.

### 6.2. Lazy loading аватаров

В `index.html` все `<img>` аватаров:
```html
<img loading="lazy" decoding="async" src="...">
```

В `app.js` при создании карточек персонажей:
```js
img.loading = "lazy";
img.decoding = "async";
```

### 6.3. Debounce для ввода

В `app.js` для поля ввода сообщения:
```js
let sendDebounceTimer;
if (EL.input) EL.input.addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    clearTimeout(sendDebounceTimer);
    sendDebounceTimer = setTimeout(send, 150);
  }
});
```

### 6.4. Skeleton-загрузка для персонажей

Вместо пустого экрана при загрузке показывать скелетоны:
```js
function renderSkeletons(count = 6) {
  if (!EL.grid) return;
  EL.grid.innerHTML = "";
  for (let i = 0; i < count; i++) {
    const d = document.createElement("div");
    d.className = "persona-card skeleton";
    d.innerHTML = `<div class="skeleton-avatar"></div><div class="skeleton-text"></div><div class="skeleton-text short"></div>`;
    EL.grid.appendChild(d);
  }
}
```

CSS:
```css
.skeleton { animation: pulse 1.5s infinite }
.skeleton-avatar { width: 60px; height: 60px; border-radius: 50%; background: var(--surface-3) }
.skeleton-text { height: 12px; border-radius: 6px; background: var(--surface-3); margin: 8px 0 }
.skeleton-text.short { width: 60% }
@keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.4 } }
```

### 6.5. Service Worker для offline-кэша

Создать `public/sw.js`:
```js
const CACHE = "neurospytnik-v1";
const STATIC = ["/", "/app.js", "/index.html"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(STATIC)));
});

self.addEventListener("fetch", (e) => {
  if (e.request.url.includes("/api/")) return; // API не кэшируем
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request))
  );
});
```

В `index.html`:
```html
<script>if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});</script>
```

### 6.6. Виртуальный скролл для длинных чатов

При > 200 сообщениях в чате производительность падает. Добавить виртуализацию:
- Хранить сообщения в массиве `chatMessages[]`
- Рендерить только видимые (viewport + буфер)
- При скролле вверх — подгружать старые

---

## ЧАСТЬ 7: TELEGRAM BOT (8.5 → 10)

### 7.1. Исправить утечку `processedPayments`

Текущий код чистит при > 10000, но удаляет 5000 старейших. Заменить на TTL-map:
```js
const PAYMENT_TTL = 24 * 60 * 60 * 1000;
const processedPayments = new Map(); // chargeId → timestamp

function isPaymentProcessed(chargeId) {
  const ts = processedPayments.get(chargeId);
  if (!ts) return false;
  if (Date.now() - ts > PAYMENT_TTL) { processedPayments.delete(chargeId); return false; }
  return true;
}

function markPaymentProcessed(chargeId) {
  processedPayments.set(chargeId, Date.now());
  // Периодическая чистка
  if (processedPayments.size > 5000) {
    const threshold = Date.now() - PAYMENT_TTL;
    for (const [id, ts] of processedPayments) {
      if (ts < threshold) processedPayments.delete(id);
    }
  }
}
```

### 7.2. Обновить текст /start

Текст «11 уникальных AI-девушек» → «15 уникальных AI-девушек» (проверить что уже исправлено).

---

## ЧАСТЬ 8: PUSH-УВЕДОМЛЕНИЯ (8 → 10)

### 8.1. Персистентные cooldown-ы

Текущие cooldown-ы в памяти — при рестарте все пользователи получат повторный пуш.

В `notifications.js` — использовать Redis или postgres:
```js
async function isOnCooldownPersistent(userId, type, pool, redis) {
  const k = `cooldown:${type}:${userId}`;
  if (redis) {
    const exists = await redis.exists(k);
    return exists === 1;
  }
  // fallback to memory
  return isOnCooldown(userId, type);
}

async function markSentPersistent(userId, type, pool, redis) {
  const k = `cooldown:${type}:${userId}`;
  if (redis) {
    await redis.setex(k, Math.floor(COOLDOWN_MS / 1000), "1");
    return;
  }
  markSent(userId, type);
}
```

### 8.2. AI-генерация для inactivity пушей

Для пользователей с уровнем привязанности >= 4, вместо шаблонных сообщений — AI:
```js
if (generateGreeting && aff.level >= 4) {
  try {
    const aiText = await generateGreeting({ personaId, timeOfDay: "miss_you", affectionLevel: aff.level });
    if (aiText) message = `${persona.name}: ${aiText}`;
  } catch {}
}
```

---

## ЧАСТЬ 9: АНАЛИТИКА (7.5 → 10)

### 9.1. Админ-дашборд (HTML-страница)

Создать `public/admin.html` — простая страница с графиками:
- DAU график (Chart.js или lightweight)
- Воронка конверсии (визуальная)
- Revenue за период
- Ретеншен-таблица
- Список последних событий
- Статус scheduler

Защита: проверять `ADMIN_USER_IDS` при открытии (через Telegram initData).

### 9.2. Агрегированные метрики

Добавить в `getStats`:
```js
// ARPU (Average Revenue Per User)
arpu: totalRevenue > 0 && dau > 0 ? +(totalRevenue / dau).toFixed(2) : 0,
// Conversion rate
conversionRate: funnel[0]?.users > 0 ? +((funnel[4]?.users || 0) / funnel[0].users * 100).toFixed(1) : 0,
// Messages per user per day
avgMessagesPerUser: dau > 0 ? Math.round(chatEvents / dau) : 0,
```

### 9.3. Экспорт аналитики в CSV

Эндпоинт:
```js
app.get("/api/admin/export", async (req, res) => {
  // Проверка ADMIN
  const days = parseInt(req.query.days) || 30;
  const { rows } = await pool.query(
    `SELECT user_id, event, data, created_at FROM analytics_events WHERE created_at >= NOW() - ($1 || ' days')::interval ORDER BY created_at`,
    [days]
  );
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename=analytics_${days}d.csv`);
  res.write("user_id,event,data,created_at\n");
  for (const r of rows) {
    res.write(`${r.user_id},${r.event},"${JSON.stringify(r.data).replace(/"/g, '""')}",${r.created_at}\n`);
  }
  res.end();
});
```

---

## ЧАСТЬ 10: ЛОГИРОВАНИЕ (9 → 10)

### 10.1. Мигрировать оставшиеся 15 `console.error`

**ai.js** — 14 мест (строки указаны в Части 2.2):
```js
// Добавить в начало файла:
const log = require("./logger").child({ module: "ai" });
// Заменить все console.error на log.error
```

**fantasy.js** — 1 место (строка 547):
```js
const log = require("./logger").child({ module: "fantasy" });
```

### 10.2. Добавить request ID

В HTTP middleware:
```js
const crypto = require("crypto");
app.use("/api", (req, _res, next) => {
  req.requestId = crypto.randomBytes(8).toString("hex");
  next();
});
```

В логгере запросов добавить `requestId: req.requestId`. Это позволяет трассировать запрос через все модули.

---

## ЧАСТЬ 11: ТЕСТИРОВАНИЕ (3 → 10)

### 11.1. Перейти на Jest

```bash
npm install --save-dev jest
```

В `package.json`:
```json
"scripts": {
  "test": "jest --coverage --forceExit",
  "test:watch": "jest --watch"
}
```

### 11.2. Тесты для storage (расширить)

`tests/storage.test.js`:
- Тестировать все функции в memory-режиме
- Покрыть: affection (xp, level up), streaks (increment, reset), gifts (record, deduct), dating (set/get/clear), achievements (unlock, list), notifications (set/get/getAll), game stats (increment, get), leaderboard, facts (add, get, dedup), referrals (process, stats, self-referral), fantasy personas (save, get, delete, limit), girl mood (set, get, decay), timeline (add, get), quests (update, progress), stories (add, get, react), custom personas (save, get, delete), processReferral bonus_messages

### 11.3. Тесты для API эндпоинтов

Создать `tests/api.test.js`:
```bash
npm install --save-dev supertest
```

```js
const request = require("supertest");
// Тестировать: GET /api/health, GET /api/personas, POST /api/chat (с mock AI),
// POST /api/gift, GET /api/profile, POST /api/referral, POST /api/track-event,
// GET /api/admin/stats (forbidden без admin), GET /api/pricing
```

### 11.4. Тесты для бота

Создать `tests/bot.test.js`:
- Mock grammY Bot
- Тестировать: /start command, /pro command, payment flow, referral handling

### 11.5. Тесты для аналитики

Создать `tests/analytics.test.js`:
- trackEvent (memory mode)
- getStats (funnel, revenue calculation)
- buildFunnelMemory

### 11.6. Тесты для notifications

Создать `tests/notifications.test.js`:
- buildInactivityMessage (все 3 тайминга)
- buildMorningMessage (все уровни)
- buildEveningMessage (все уровни + null)
- isOnCooldown / markSent

### 11.7. Тесты для scheduler

Создать `tests/scheduler.test.js`:
- schedule, startAll, stopAll, getJobStats
- Проверка что задача не запускается параллельно

### 11.8. Настроить coverage threshold

В `package.json`:
```json
"jest": {
  "coverageThreshold": {
    "global": { "branches": 70, "functions": 80, "lines": 80, "statements": 80 }
  }
}
```

---

## ЧАСТЬ 12: ИНФРАСТРУКТУРА (7.5 → 10)

### 12.1. CI/CD с GitHub Actions

Создать `.github/workflows/ci.yml`:
```yaml
name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - run: npm test
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - run: npx eslint src/ --ext .js
```

### 12.2. ESLint

```bash
npm install --save-dev eslint
```

Создать `.eslintrc.json`:
```json
{
  "env": { "node": true, "es2022": true },
  "parserOptions": { "ecmaVersion": 2022 },
  "rules": {
    "no-unused-vars": ["warn", { "argsIgnorePattern": "^_" }],
    "no-console": "warn",
    "eqeqeq": "error",
    "no-var": "error"
  }
}
```

### 12.3. Health endpoint с dependency checks

```js
app.get("/api/health", async (_req, res) => {
  const checks = { storage: "ok", redis: "skip", ai: "skip" };
  try {
    if (getStorageMode() === "postgres") {
      await getPool().query("SELECT 1");
      checks.storage = "ok";
    }
  } catch { checks.storage = "error"; }

  try {
    if (redis) {
      await redis.ping();
      checks.redis = "ok";
    }
  } catch { checks.redis = "error"; }

  checks.ai = process.env.OPENAI_API_KEY ? "configured" : "missing";

  const ok = checks.storage !== "error";
  res.status(ok ? 200 : 503).json({
    ok,
    uptime: Math.round(process.uptime()),
    memoryMB: Math.round(process.memoryUsage().heapUsed / 1048576),
    ...checks,
  });
});
```

### 12.4. Graceful shutdown

В `server.js`:
```js
async function shutdown(signal) {
  log.info({ signal }, "Shutdown signal received");
  stopScheduler();
  if (botInstance) {
    try { await botInstance.stop(); } catch {}
  }
  server.close(() => {
    log.info("HTTP server closed");
    if (getPool()) getPool().end().then(() => process.exit(0));
    else process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000);
}

const server = app.listen(PORT, ...);
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
```

### 12.5. Docker compose production-ready

Добавить в `docker-compose.yml`:
```yaml
services:
  app:
    deploy:
      resources:
        limits:
          memory: 512M
          cpus: "1.0"
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
```

### 12.6. Backup скрипт

Создать `scripts/backup.sh`:
```bash
#!/bin/bash
DATE=$(date +%Y%m%d_%H%M%S)
docker-compose exec -T postgres pg_dump -U botik botik | gzip > backups/botik_${DATE}.sql.gz
find backups/ -name "*.sql.gz" -mtime +7 -delete
echo "Backup done: botik_${DATE}.sql.gz"
```

---

## ПОРЯДОК ВЫПОЛНЕНИЯ

| Фаза | Части | Приоритет | Оценка усилий |
|------|-------|-----------|---------------|
| 1 | 2 (безопасность), 10 (логирование) | Критичный | 1 час |
| 2 | 3 (БД), 4 (AI fallbacks) | Высокий | 2 часа |
| 3 | 7 (бот), 8 (пуши), 5 (монетизация) | Высокий | 2 часа |
| 4 | 11 (тесты) | Высокий | 4 часа |
| 5 | 1 (архитектура — роутеры, модули) | Средний | 6 часов |
| 6 | 6 (фронтенд), 9 (аналитика дашборд) | Средний | 4 часа |
| 7 | 12 (инфраструктура — CI/CD, ESLint) | Средний | 2 часа |

**Общее время: ~21 час работы.**

После выполнения всех частей приложение выходит на уровень production-grade SaaS: модульная архитектура, полное покрытие тестами, структурированное логирование, продвинутая аналитика, безопасность enterprise-уровня, graceful shutdown, CI/CD pipeline.
