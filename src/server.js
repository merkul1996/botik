require("dotenv").config({ override: true });

const path = require("path");
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const log = require("./logger");
const { schedule, startAll: startScheduler, stopAll: stopScheduler, getJobStats } = require("./scheduler");
const { runInactivityNotifications, runScheduledGreetings, runSubscriptionReminders, runFantasyReminders } = require("./notifications");
const { createBot } = require("./bot");
const { getPersonas, getPersonaById, generateGreeting, generateStory } = require("./ai");
const { getActiveEvents, getAllEvents, getXpMultiplier } = require("./events");
const { initAnalytics, trackEvent, getStats } = require("./analytics");
const {
  initStorage, getStorageMode, getPool,
  getUserProfile, setUserPlan, getTodayUsageCount, addBalance,
  getStreak, getAffection, getAllAffections, getAchievements, unlockAchievement,
  getGameStats, getQuestsList, getUserQuests, updateQuestProgress,
  getAllUserProfiles, getAllNotifUsers, getNotifSettings,
  getInactiveUsers, getBalance, getReferralCount,
  addStory, getRecentStories, grantFantasyAccess,
  getAllFantasyAccess, getCustomPersonas,
} = require("./storage");

const {
  PRO_PRICE_STARS, FANTASY_PRICE_STARS,
  FREE_DAILY_LIMIT, PRO_DAILY_LIMIT,
  PRO_DURATION_DAYS, FANTASY_DURATION_DAYS,
  STARS_MIN_TOPUP, STARS_MAX_TOPUP,
  RATE_LIMIT_WINDOW: RL_WINDOW, RATE_LIMIT_MAX: RL_MAX,
  ADMIN_USER_IDS, AI_CHAT_TIMEOUT_MS,
} = require("./config");

const PORT = Number(process.env.PORT || 3000);
const WEBAPP_URL = process.env.WEBAPP_URL || `http://localhost:${PORT}`;
const BOT_TOKEN = process.env.BOT_TOKEN;
let botInstance = null;
let botUsername = process.env.BOT_USERNAME || "";

/* ══════════════════════════════════════════════════
   SHARED HELPERS (passed to route modules)
   ══════════════════════════════════════════════════ */
function getEffectivePlan(profile) {
  if (!profile) return "free";
  if (profile.plan === "pro") {
    if (profile.proExpiresAt && new Date(profile.proExpiresAt) < new Date()) return "free";
    return "pro";
  }
  if (profile.referralProEndsAt && new Date(profile.referralProEndsAt) > new Date()) return "pro";
  return profile.plan || "free";
}

function getPlanLimit(plan) {
  return plan === "pro" ? PRO_DAILY_LIMIT : FREE_DAILY_LIMIT;
}

async function checkAndUnlock(userId, achievementId) {
  const unlocked = await unlockAchievement(userId, achievementId);
  return unlocked ? achievementId : null;
}

async function checkAchievements(userId, context = {}) {
  const newlyUnlocked = [];
  const stats = await getGameStats(userId);
  const allAff = await getAllAffections(userId);
  const streak = await getStreak(userId);
  const achievements = await getAchievements(userId);
  const has = (id) => achievements.includes(id);

  if (stats.msgCount >= 1 && !has("first_msg")) { const r = await checkAndUnlock(userId, "first_msg"); if (r) newlyUnlocked.push(r); }
  if (stats.msgCount >= 100 && !has("msg_100")) { const r = await checkAndUnlock(userId, "msg_100"); if (r) newlyUnlocked.push(r); }
  if (stats.msgCount >= 500 && !has("msg_500")) { const r = await checkAndUnlock(userId, "msg_500"); if (r) newlyUnlocked.push(r); }
  if (stats.msgCount >= 1000 && !has("msg_1000")) { const r = await checkAndUnlock(userId, "msg_1000"); if (r) newlyUnlocked.push(r); }
  if (stats.giftCount >= 1 && !has("first_gift")) { const r = await checkAndUnlock(userId, "first_gift"); if (r) newlyUnlocked.push(r); }
  if (stats.giftCount >= 10 && !has("gift_10")) { const r = await checkAndUnlock(userId, "gift_10"); if (r) newlyUnlocked.push(r); }
  if (context.giftId === "ring" && !has("gift_ring")) { const r = await checkAndUnlock(userId, "gift_ring"); if (r) newlyUnlocked.push(r); }
  if (streak.currentStreak >= 7 && !has("streak_7")) { const r = await checkAndUnlock(userId, "streak_7"); if (r) newlyUnlocked.push(r); }
  if (streak.currentStreak >= 30 && !has("streak_30")) { const r = await checkAndUnlock(userId, "streak_30"); if (r) newlyUnlocked.push(r); }
  if (context.customCreated && !has("custom_girl")) { const r = await checkAndUnlock(userId, "custom_girl"); if (r) newlyUnlocked.push(r); }
  const affValues = Object.values(allAff);
  if (affValues.some(a => a.level >= 3) && !has("level3")) { const r = await checkAndUnlock(userId, "level3"); if (r) newlyUnlocked.push(r); }
  if (affValues.some(a => a.level >= 5) && !has("level5")) { const r = await checkAndUnlock(userId, "level5"); if (r) newlyUnlocked.push(r); }
  if (affValues.some(a => a.level >= 7) && !has("level7")) { const r = await checkAndUnlock(userId, "level7"); if (r) newlyUnlocked.push(r); }
  const allPersonaIds = getPersonas().map(p => p.id);
  if (allPersonaIds.length > 0 && allPersonaIds.every(id => (allAff[id]?.level || 0) >= 2) && !has("all_level2")) {
    const r = await checkAndUnlock(userId, "all_level2"); if (r) newlyUnlocked.push(r);
  }
  return newlyUnlocked;
}

async function checkQuests(userId, context = {}) {
  const completedQuests = [];
  const stats = await getGameStats(userId);
  const allAff = await getAllAffections(userId);
  const streak = await getStreak(userId);
  for (const quest of getQuestsList()) {
    let progress = 0;
    if (quest.type === "messages_total") progress = stats.msgCount || 0;
    else if (quest.type === "gifts_total") progress = stats.giftCount || 0;
    else if (quest.type === "streak") progress = streak.currentStreak || 0;
    else if (quest.type === "max_level") progress = Math.max(0, ...Object.values(allAff).map(a => a.level || 0));
    else if (quest.type === "chat_days" && quest.personaId) progress = context.chatDays?.[quest.personaId] || 0;
    else if (quest.type === "custom_created") progress = context.customCreated ? 1 : 0;
    else if (quest.type === "all_personas_msg") {
      const personaIds = getPersonas().map(p => p.id);
      const chatted = personaIds.filter(id => (allAff[id]?.xp || 0) > 0).length;
      progress = chatted >= personaIds.length ? 1 : 0;
    }
    const result = await updateQuestProgress(userId, quest.id, progress);
    if (result) completedQuests.push(result);
  }
  return completedQuests;
}

/* ══════════════════════════════════════════════════
   EXPRESS APP & MIDDLEWARE
   ══════════════════════════════════════════════════ */
const app = express();
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "https://telegram.org"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "https://telegram.org"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));
app.use(cors());
app.use(express.json({ limit: "16kb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

app.use("/api", (req, res, next) => {
  req.requestId = crypto.randomBytes(6).toString("hex");
  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;
    if (req.path === "/health") return;
    const lvl = res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";
    log[lvl]({ method: req.method, path: req.path, status: res.statusCode, ms, userId: req.userId, rid: req.requestId }, "HTTP");
  });
  next();
});

function validateTelegramInitData(initData) {
  if (!BOT_TOKEN || !initData) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    if (!hash) return null;
    params.delete("hash");
    const dataCheckString = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
    const secretKey = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
    const computedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
    const computedBuf = Buffer.from(computedHash, "hex");
    const hashBuf = Buffer.from(hash, "hex");
    if (computedBuf.length !== hashBuf.length || !crypto.timingSafeEqual(computedBuf, hashBuf)) return null;
    const userStr = params.get("user");
    return userStr ? JSON.parse(userStr) : null;
  } catch { return null; }
}

app.use("/api", (req, _res, next) => {
  const initData = req.headers["x-telegram-init-data"] || req.query?.initData || req.body?.initData;
  const telegramUser = initData ? validateTelegramInitData(initData) : null;
  if (telegramUser && telegramUser.id) {
    req.userId = String(telegramUser.id);
    req.telegramUser = telegramUser;
  } else {
    req.userId = "anon";
  }
  next();
});

const PUBLIC_PATHS = ["/health", "/personas", "/gifts", "/scenes", "/moods", "/events", "/pricing"];
app.use("/api", (req, res, next) => {
  if (req.userId === "anon" && !PUBLIC_PATHS.includes(req.path)) return res.status(401).json({ error: "Требуется авторизация" });
  next();
});

/* ── Rate limiter ── */
let redis = null;
try {
  if (process.env.REDIS_URL) {
    const Redis = require("ioredis");
    redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: true });
    redis.on("error", e => log.error({ err: e }, "Redis error"));
    redis.connect().catch(() => { log.warn("Redis недоступен, используем memory rate limiter"); redis = null; });
  }
} catch { log.warn("ioredis не установлен, используем memory rate limiter"); }

const rateLimitMap = new Map();
async function rateLimit(req, res, next) {
  const key = `rl:${req.userId !== "anon" ? req.userId : req.ip}`;
  const now = Date.now();
  if (redis) {
    try {
      const count = await redis.incr(key);
      if (count === 1) await redis.expire(key, 60);
      if (count > RL_MAX) return res.status(429).json({ error: "Слишком много запросов. Подожди минуту." });
      return next();
    } catch { /* fallback to memory */ }
  }
  if (!rateLimitMap.has(key)) rateLimitMap.set(key, []);
  const hits = rateLimitMap.get(key).filter(t => now - t < RL_WINDOW);
  if (hits.length >= RL_MAX) return res.status(429).json({ error: "Слишком много запросов. Подожди минуту." });
  hits.push(now);
  rateLimitMap.set(key, hits);
  next();
}
setInterval(() => {
  const now = Date.now();
  for (const [key, hits] of rateLimitMap) {
    const valid = hits.filter(t => now - t < RL_WINDOW);
    if (valid.length === 0) rateLimitMap.delete(key);
    else rateLimitMap.set(key, valid);
  }
}, 5 * 60 * 1000);

const RATE_LIMITED_PATHS = [
  "/api/chat", "/api/create-invoice", "/api/gift", "/api/favorite",
  "/api/referral", "/api/referral/apply", "/api/profile/plan",
  "/api/generate-persona", "/api/delete-custom-persona", "/api/challenge/start",
  "/api/settings/notifications", "/api/stories/react", "/api/track-event",
  "/api/fantasy/subscribe", "/api/fantasy/create-persona", "/api/fantasy/chat",
  "/api/fantasy/generate-avatar", "/api/fantasy/story/start", "/api/fantasy/story/choice",
  "/api/fantasy/restore-access", "/api/onboarding-greeting",
];
for (const p of RATE_LIMITED_PATHS) app.use(p, rateLimit);

/* ══════════════════════════════════════════════════
   ROUTE MODULES
   ══════════════════════════════════════════════════ */
const sharedDeps = {
  getEffectivePlan, getPlanLimit, rateLimit, checkAchievements, checkQuests,
  getBotUsername: () => botUsername,
  getBotInstance: () => botInstance,
};

app.use("/api", require("./routes/profile")(sharedDeps));
app.use("/api", require("./routes/chat")(sharedDeps));
app.use("/api", require("./routes/fantasy")(sharedDeps));
app.use("/api", require("./routes/social")(sharedDeps));

/* ── Invoice (stays here because it needs botInstance) ── */
const V = require("./validate");
app.post("/api/create-invoice", async (req, res) => {
  try {
    if (!BOT_TOKEN) return res.status(400).json({ error: "Бот не настроен" });
    const type = V.str(req.body?.type, 20) || "pro";
    const starsAmount = V.int(req.body?.amount, STARS_MIN_TOPUP, STARS_MAX_TOPUP) || 50;
    const bot = botInstance || new (require("grammy").Bot)(BOT_TOKEN);

    if (type === "stars") {
      const amount = starsAmount;
      const link = await bot.api.createInvoiceLink(
        "Пополнение баланса — НейроСпутник",
        `${amount} ⭐ на подарки`,
        `stars_balance_${amount}`, "", "XTR",
        [{ label: `${amount} Stars`, amount }],
      );
      return res.json({ invoiceLink: link, type: "stars", amount });
    }

    if (type === "fantasy") {
      const link = await bot.api.createInvoiceLink(
        "Fantasy+ — НейроСпутник 18+",
        `Полный доступ к модулю Фантазии 18+ на ${FANTASY_DURATION_DAYS} дней`,
        "fantasy_plus", "", "XTR",
        [{ label: `Fantasy+ (${FANTASY_DURATION_DAYS} дн.)`, amount: FANTASY_PRICE_STARS }],
      );
      return res.json({ invoiceLink: link, type: "fantasy" });
    }

    const link = await bot.api.createInvoiceLink(
      "Pro подписка — НейроСпутник",
      `Все 15 персонажей, ${PRO_DAILY_LIMIT} сообщений/день. ${PRO_DURATION_DAYS} дней.`,
      "pro_subscription", "", "XTR",
      [{ label: "Pro подписка (30 дней)", amount: PRO_PRICE_STARS }],
    );
    return res.json({ invoiceLink: link, type: "pro" });
  } catch (e) {
    log.error({ err: e }, "Invoice creation failed");
    return res.status(500).json({ error: "Не удалось создать счёт" });
  }
});

/* ── Landing & fallback ── */
app.get("/landing", (_req, res) => { res.sendFile(path.join(__dirname, "..", "public", "landing.html")); });
app.use((_req, res) => { res.sendFile(path.join(__dirname, "..", "public", "index.html")); });

/* ══════════════════════════════════════════════════
   STARTUP
   ══════════════════════════════════════════════════ */
let _httpServer;
let _botRef;

async function start() {
  try {
    await initStorage();
    log.info({ mode: getStorageMode() }, "Storage initialized");
    if (!process.env.DATABASE_URL?.trim() && process.env.NODE_ENV === "production") {
      log.warn("DATABASE_URL пуст в production — данные в memory+файл, возможна потеря при рестарте. Настрой Postgres для прода.");
    }
    await initAnalytics(getPool());
    log.info("Analytics initialized");
  } catch (e) {
    log.error({ err: e }, "Storage init failed, falling back to memory");
  }

  _httpServer = app.listen(PORT, async () => {
    log.info({ port: PORT }, "Server started");

    const bot = _botRef = createBot({
      botToken: BOT_TOKEN, webAppUrl: WEBAPP_URL,
      onPaymentSuccess: async (userId, payload) => {
        if (payload === "pro_subscription") {
          await setUserPlan(userId, "pro", PRO_DURATION_DAYS);
          trackEvent(userId, "pro_purchased", { stars: PRO_PRICE_STARS, days: PRO_DURATION_DAYS });
          log.info({ userId, days: PRO_DURATION_DAYS }, "Pro activated");
        } else if (payload === "fantasy_plus") {
          await grantFantasyAccess(userId, FANTASY_DURATION_DAYS);
          trackEvent(userId, "fantasy_purchased", { stars: FANTASY_PRICE_STARS, days: FANTASY_DURATION_DAYS });
          log.info({ userId, days: FANTASY_DURATION_DAYS }, "Fantasy+ activated");
        } else if (payload?.startsWith("stars_balance_")) {
          const amount = parseInt(payload.replace("stars_balance_", ""), 10) || 0;
          if (amount > 0) { await addBalance(userId, amount); trackEvent(userId, "stars_topup", { amount }); log.info({ userId, amount }, "Stars topped up"); }
        }
      },
      getLastActivity: getInactiveUsers, getPersonaById, getPersonas, getUserProfile,
      getAllNotifUsers, generateGreeting, getAffection, getAllUserProfiles,
      getNotifSettings, trackEvent, getStreak, getTodayUsageCount, getBalance, getReferralCount,
    });

    botInstance = bot;
    if (bot && !botUsername) {
      try { const me = await bot.api.getMe(); botUsername = me.username || ""; log.info({ username: botUsername }, "Bot username resolved"); }
      catch (e) { log.error({ err: e }, "Failed to get bot username"); }
    }

    schedule("story_generation", 4 * 60 * 60 * 1000, async () => {
      const all = getPersonas();
      const p = all[Math.floor(Math.random() * all.length)];
      const text = await generateStory(p.id);
      if (text) await addStory(p.id, text);
    });

    (async () => {
      try {
        const existing = await getRecentStories(1);
        if (existing.length === 0) {
          const all = getPersonas();
          for (let i = 0; i < Math.min(3, all.length); i++) {
            const p = all[Math.floor(Math.random() * all.length)];
            const text = await generateStory(p.id);
            if (text) await addStory(p.id, text);
          }
        }
      } catch { /* non-critical */ }
    })();

    if (!bot) { log.warn("BOT_TOKEN not set, skipping bot"); startScheduler(); return; }

    log.info("Connecting to Telegram...");
    bot.start({ drop_pending_updates: true }).catch(e => log.fatal({ err: e }, "Bot stopped"));
    log.info("Telegram bot started (grammY)");

    const notifDeps = {
      bot, webAppUrl: WEBAPP_URL, getAllUserProfiles, getPersonaById,
      getAllNotifUsers, getNotifSettings, getAffection, generateGreeting, trackEvent,
      getAllFantasyAccess,
    };
    schedule("inactivity_push", 2 * 60 * 60 * 1000, () => runInactivityNotifications(notifDeps));
    schedule("scheduled_greetings", 30 * 60 * 1000, () => runScheduledGreetings(notifDeps));
    schedule("subscription_reminders", 6 * 60 * 60 * 1000, () => runSubscriptionReminders(notifDeps));
    schedule("fantasy_reminders", 6 * 60 * 60 * 1000, () => runFantasyReminders(notifDeps));
    startScheduler();
  });
}

function gracefulShutdown(signal) {
  log.info({ signal }, "Shutting down...");
  stopScheduler();
  if (_botRef) _botRef.stop().catch(() => {});
  if (_httpServer) _httpServer.close();
  const pool = getPool();
  if (pool) pool.end().catch(() => {});
  setTimeout(() => process.exit(0), 3000);
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

start();
