const { Router } = require("express");
const log = require("../logger").child({ module: "routes/profile" });
const V = require("../validate");
const {
  getUserProfile, setUserPlan, getTodayUsageCount, getBalance, deductBalance, addBalance,
  updateStreak, getStreak, applyReferral, getChallenge, startChallenge,
  trackActivity, getChatHistory, addFavorite, getFavorites,
  saveCustomPersona, getCustomPersonas, getCustomPersona, deleteCustomPersona,
  getAllAffections, getAffection, getLastGift, getGirlMood,
  getNotifSettings, setNotifSettings, getAchievements, getAchievementsList,
  unlockAchievement, getLeaderboard, getGameStats, GIRL_MOODS,
  generateReferralCode, decodeReferralCode, processReferral, getReferralStats,
} = require("../storage");
const { getPersonas, getPersonaById, getScenes, getMoods, generatePersona, generateGreeting } = require("../ai");
const { trackEvent } = require("../analytics");

module.exports = function createProfileRouter({ getEffectivePlan, getPlanLimit, rateLimit, checkAchievements, getBotUsername }) {
  const router = Router();

  router.get("/personas", (_req, res) => {
    res.json({ personas: getPersonas() });
  });

  router.post("/onboarding-greeting", async (req, res) => {
    const { personaId } = req.body || {};
    if (!personaId) return res.json({ greeting: null });
    try {
      const greeting = await generateGreeting({ personaId, timeOfDay: "first_meet", affectionLevel: 1 });
      return res.json({ greeting: greeting || null });
    } catch (e) {
      log.warn({ err: e }, "Onboarding greeting generation failed");
      return res.json({ greeting: null });
    }
  });

  const ALLOWED_CLIENT_EVENTS = new Set([
    "onboarding_completed", "page_view", "persona_selected",
    "gift_panel_opened", "paywall_shown", "share_clicked", "fantasy_opened",
  ]);

  router.post("/track-event", (req, res) => {
    const { event, data } = req.body || {};
    if (event && ALLOWED_CLIENT_EVENTS.has(event)) trackEvent(req.userId, event, data || {});
    return res.json({ ok: true });
  });

  router.get("/scenes", async (req, res) => {
    try {
      const personaId = String(req.query.personaId || "luna");
      const aff = await getAffection(req.userId, personaId);
      const scenes = getScenes().map(s => ({ ...s, locked: s.premium && aff.level < 3 }));
      res.json({ scenes });
    } catch (e) {
      log.error({ err: e, userId: req.userId }, "GET /scenes failed");
      res.status(500).json({ error: "Ошибка загрузки сцен" });
    }
  });

  router.get("/moods", (_req, res) => { res.json({ moods: getMoods() }); });

  router.get("/profile", async (req, res) => {
    try {
      await trackActivity(req.userId);
      trackEvent(req.userId, "app_opened", {});
      const profile = await getUserProfile(req.userId);
      const usage = await getTodayUsageCount(req.userId);
      const streak = await getStreak(req.userId);
      const plan = getEffectivePlan(profile);
      const limit = getPlanLimit(plan);
      const affections = await getAllAffections(req.userId);
      const challenge = await getChallenge(req.userId);
      const bonusMessages = profile.bonusMessages ?? 0;
      return res.json({
        userId: req.userId, plan, usageToday: usage, limitToday: limit,
        remainingToday: Math.max(0, limit - usage + bonusMessages),
        streak: streak.currentStreak, longestStreak: streak.longestStreak,
        referralCode: profile.referralCode || null, referralCount: profile.referralCount ?? 0,
        referralProEndsAt: profile.referralProEndsAt || null, bonusMessages,
        starsBalance: profile.starsBalance ?? 0, trialEndsAt: profile.trialEndsAt || null,
        proExpiresAt: profile.proExpiresAt || null, affections, challenge,
      });
    } catch (e) {
      log.error({ err: e, userId: req.userId }, "GET /profile failed");
      return res.status(500).json({ error: "Не удалось получить профиль" });
    }
  });

  router.post("/referral", async (req, res) => {
    const safeCode = V.str(req.body?.code, 50).trim().toUpperCase();
    if (!safeCode) return res.status(400).json({ error: "Введи реферальный код." });
    try {
      const result = await applyReferral(req.userId, safeCode);
      if (!result.ok) return res.status(400).json({ error: result.error });
      return res.json({ ok: true, bonus: result.bonus });
    } catch (e) {
      log.error({ err: e, userId: req.userId }, "POST /referral failed");
      return res.status(500).json({ error: "Ошибка при применении кода." });
    }
  });

  router.get("/referral", async (req, res) => {
    try {
      const stats = await getReferralStats(req.userId);
      stats.botUsername = getBotUsername();
      return res.json(stats);
    } catch { return res.json({ count: 0, totalBonus: 0, code: "", botUsername: getBotUsername() }); }
  });

  router.post("/referral/apply", async (req, res) => {
    const code = V.strRequired(req.body?.code, 50);
    if (!code) return res.status(400).json({ error: "Код не указан" });
    const referrerId = decodeReferralCode(code);
    if (!referrerId) return res.status(400).json({ error: "Неверный код" });
    try {
      const result = await processReferral(referrerId, req.userId);
      if (!result.ok) {
        if (result.reason === "self") return res.status(400).json({ error: "Нельзя использовать свой код" });
        if (result.reason === "already_referred") return res.status(400).json({ error: "Ты уже использовал реферальный код" });
        return res.status(400).json({ error: "Ошибка" });
      }
      trackEvent(req.userId, "referral_applied", { referrerId });
      return res.json({ ok: true, bonus: result.referredBonus, message: `+${result.referredBonus} бонусных сообщений!` });
    } catch { return res.status(500).json({ error: "Ошибка" }); }
  });

  router.post("/profile/plan", async (req, res) => {
    try {
      await setUserPlan(req.userId, "free");
      return res.json({ ok: true, plan: "free" });
    } catch { return res.status(500).json({ error: "Ошибка обновления плана" }); }
  });

  router.get("/history", async (req, res) => {
    const personaId = String(req.query.personaId || "luna");
    const limit = Math.min(Number(req.query.limit) || 30, 100);
    try {
      const messages = await getChatHistory({ userId: req.userId, personaId, limit });
      return res.json({ messages });
    } catch (e) {
      log.error({ err: e, userId: req.userId }, "GET /history failed");
      return res.status(500).json({ error: "Ошибка загрузки истории" });
    }
  });

  router.post("/favorite", async (req, res) => {
    const personaId = V.id(req.body?.personaId) || "luna";
    const content = V.str(req.body?.content, 2000);
    if (!content) return res.status(400).json({ error: "Контент не указан" });
    try {
      await addFavorite(req.userId, personaId, content);
      return res.json({ ok: true });
    } catch { return res.status(500).json({ error: "Ошибка сохранения" }); }
  });

  router.get("/favorites", async (req, res) => {
    try {
      const items = await getFavorites(req.userId, 20);
      return res.json({ favorites: items });
    } catch { return res.status(500).json({ error: "Ошибка загрузки избранного" }); }
  });

  router.post("/generate-persona", rateLimit, async (req, res) => {
    const { params = {} } = req.body || {};
    try {
      const existing = await getCustomPersonas(req.userId);
      const profile = await getUserProfile(req.userId);
      const maxCustom = profile.plan === "pro" ? 3 : 1;
      if (existing.length >= maxCustom) {
        return res.status(400).json({
          error: profile.plan === "pro"
            ? "Максимум 3 кастомных персонажа на Pro."
            : "На Free можно создать 1 персонажа. Удали текущего или перейди на Pro.",
        });
      }
      const persona = await generatePersona(params);
      await saveCustomPersona(req.userId, persona);
      await checkAchievements(req.userId, { customCreated: true });
      trackEvent(req.userId, "persona_created", {});
      const { behavior, ...safe } = persona;
      return res.json({ ok: true, persona: safe });
    } catch (e) {
      log.error({ err: e }, "POST /generate-persona failed");
      return res.status(500).json({ error: "Не удалось создать персонажа" });
    }
  });

  router.get("/custom-personas", async (req, res) => {
    try {
      const list = await getCustomPersonas(req.userId);
      const safe = list.map(({ behavior, ...rest }) => rest);
      return res.json({ personas: safe });
    } catch { return res.status(500).json({ error: "Ошибка загрузки персонажей" }); }
  });

  router.post("/delete-custom-persona", async (req, res) => {
    const personaId = V.id(req.body?.personaId);
    if (!personaId) return res.status(400).json({ error: "ID не указан" });
    try {
      await deleteCustomPersona(req.userId, personaId);
      return res.json({ ok: true });
    } catch { return res.status(500).json({ error: "Ошибка удаления" }); }
  });

  router.get("/affection", async (req, res) => {
    try {
      const all = await getAllAffections(req.userId);
      return res.json({ affections: all });
    } catch { return res.status(500).json({ error: "Ошибка загрузки" }); }
  });

  router.get("/chat-context", async (req, res) => {
    const personaId = String(req.query.personaId || "luna");
    try {
      const [affection, lastGift, girlMoodState] = await Promise.all([
        getAffection(req.userId, personaId),
        getLastGift(req.userId, personaId),
        getGirlMood(req.userId, personaId),
      ]);
      const statusMessage =
        affection.level >= 5 ? "Доверяет тебе" :
        affection.level >= 3 ? "Становится ближе" :
        affection.level >= 2 ? "Запомнила тебя" : "Знакомство";
      const moodMeta = GIRL_MOODS[girlMoodState.current] || GIRL_MOODS.neutral;
      return res.json({
        affection: { level: affection.level, label: affection.label, xp: affection.xp },
        statusMessage,
        lastGift: lastGift ? { name: lastGift.giftName, emoji: lastGift.emoji } : null,
        lastDateScenario: null,
        girlMood: {
          id: girlMoodState.current, label: moodMeta.label, emoji: moodMeta.emoji,
          color: moodMeta.color, glow: moodMeta.glow, intensity: girlMoodState.intensity,
        },
      });
    } catch { return res.status(500).json({ error: "Ошибка загрузки контекста" }); }
  });

  router.get("/challenge", async (req, res) => {
    try {
      const challenge = await getChallenge(req.userId);
      return res.json({ challenge: challenge || null });
    } catch { return res.status(500).json({ error: "Ошибка загрузки" }); }
  });

  router.post("/challenge/start", rateLimit, async (req, res) => {
    const personaId = V.id(req.body?.personaId) || "luna";
    try {
      const existing = await getChallenge(req.userId);
      if (existing && !existing.completedAt) return res.status(400).json({ error: "У тебя уже есть активный вызов." });
      const persona = getPersonaById(personaId);
      if (!persona || persona.id !== personaId) return res.status(400).json({ error: "Персонаж не найден" });
      const challenge = await startChallenge(req.userId, personaId);
      return res.json({ ok: true, challenge });
    } catch (e) {
      log.error({ err: e }, "POST /challenge/start failed");
      return res.status(500).json({ error: "Не удалось начать вызов" });
    }
  });

  router.get("/settings/notifications", async (req, res) => {
    try { return res.json({ settings: await getNotifSettings(req.userId) }); }
    catch { return res.status(500).json({ error: "Ошибка загрузки настроек" }); }
  });

  router.post("/settings/notifications", async (req, res) => {
    try {
      const enabled = V.bool(req.body?.enabled);
      const personaId = V.id(req.body?.personaId);
      await setNotifSettings(req.userId, { enabled, personaId: personaId || null });
      return res.json({ ok: true });
    } catch { return res.status(500).json({ error: "Ошибка сохранения настроек" }); }
  });

  router.get("/achievements", async (req, res) => {
    try {
      const unlocked = await getAchievements(req.userId);
      const all = getAchievementsList().map(a => ({ ...a, unlocked: unlocked.includes(a.id) }));
      return res.json({ achievements: all, unlockedCount: unlocked.length, totalCount: all.length });
    } catch (e) {
      log.error({ err: e, userId: req.userId }, "GET /achievements failed");
      return res.status(500).json({ error: "Ошибка загрузки достижений" });
    }
  });

  router.get("/leaderboard", async (req, res) => {
    try {
      const board = await getLeaderboard(10);
      const result = board.map(entry => ({
        rank: entry.rank, name: entry.userId.slice(0, 2) + "***",
        totalXp: entry.totalXp, isYou: entry.userId === req.userId,
      }));
      return res.json({ leaderboard: result });
    } catch { return res.status(500).json({ error: "Ошибка рейтинга" }); }
  });

  return router;
};
