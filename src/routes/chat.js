const { Router } = require("express");
const log = require("../logger").child({ module: "routes/chat" });
const V = require("../validate");
const {
  getUserFacts, addUserFact, addChatMessage, getRecentChatMessages,
  getUserProfile, getTodayUsageCount, incrementTodayUsage, decrementBonusMessage,
  getBalance, deductBalance, addBalance, updateStreak, getStreak,
  getCustomPersona, getAffection, addAffectionXp, getAllAffections,
  recordGift, getLastGift, setLastChatPersona, getLastChatPersona,
  GIFTS, getGifts, getGirlMood, setGirlMood, getGirlMoodPrompt,
  addTimelineEvent, getTimeline, getTimelineStats, getTimelineTypes,
  getGameStats, incrementGameStat, getQuestsList, getUserQuests, updateQuestProgress,
  updateChallengeStreak, trackActivity, GIRL_MOODS,
  getAchievements, unlockAchievement,
} = require("../storage");
const {
  getPersonas, getPersonaById, generateReply, generateGiftReaction,
  getDiaryEntries, analyzeMoodFromMessage, detectSpecialMoment,
  extractFacts, generateJealousyReaction, getCurrentArc, getCurrentChapter,
} = require("../ai");
const { getXpMultiplier } = require("../events");
const { trackEvent } = require("../analytics");
const { MAX_MESSAGE_LENGTH, AI_CHAT_TIMEOUT_MS } = require("../config");

module.exports = function createChatRouter({ getEffectivePlan, getPlanLimit, rateLimit, checkAchievements, checkQuests }) {
  const router = Router();

  router.get("/gifts", (_req, res) => { res.json({ gifts: getGifts() }); });

  router.post("/gift", rateLimit, async (req, res) => {
    const personaId = V.id(req.body?.personaId) || "luna";
    const giftId = V.id(req.body?.giftId);
    if (!giftId) return res.status(400).json({ error: "Подарок не указан" });
    try {
      const gift = GIFTS.find(g => g.id === giftId);
      if (!gift) return res.status(400).json({ error: "Подарок не найден" });
      const balance = await getBalance(req.userId);
      if (balance < gift.stars) return res.status(403).json({ error: `Недостаточно Stars. Нужно ${gift.stars} ⭐, у тебя ${balance}.`, need: gift.stars, balance });
      const deducted = await deductBalance(req.userId, gift.stars);
      if (!deducted) return res.status(403).json({ error: "Недостаточно Stars." });

      let persona = getPersonaById(personaId);
      if (!persona || (persona.id === "luna" && personaId !== "luna")) {
        const customP = await getCustomPersona(req.userId, personaId);
        if (customP) persona = customP;
      }
      try {
        await recordGift(req.userId, personaId, giftId);
        const eventXpMul = getXpMultiplier();
        const aff = await addAffectionXp(req.userId, personaId, Math.round(gift.xp * eventXpMul));
        const reaction = await generateGiftReaction({ personaId, giftName: gift.name, giftEmoji: gift.emoji, affectionLevel: aff.level });
        await addChatMessage({ userId: req.userId, personaId, role: "assistant", content: reaction });
        await incrementGameStat(req.userId, "giftCount");
        const tlType = giftId === "ring" ? "ring_gift" : "first_gift";
        await addTimelineEvent(req.userId, personaId, tlType, { gift: gift.name, emoji: gift.emoji, xp: gift.xp });
        await setGirlMood(req.userId, personaId, giftId === "ring" ? "loving" : "excited", giftId === "ring" ? 90 : 75, `Подарок: ${gift.name}`);
        const newBalance = await getBalance(req.userId);
        const newAchievements = await checkAchievements(req.userId, { giftId });
        trackEvent(req.userId, "gift_sent", { personaId, giftId });
        const { behavior, ...safePer } = persona || {};
        return res.json({ ok: true, reaction, gift, affection: aff, persona: safePer, starsBalance: newBalance, newAchievements });
      } catch (giftErr) {
        log.error({ err: giftErr, userId: req.userId }, "Gift delivery failed, refunding");
        await addBalance(req.userId, gift.stars).catch(re => log.error({ err: re }, "Refund failed!"));
        return res.status(500).json({ error: "Ошибка отправки подарка. Звёзды возвращены." });
      }
    } catch (e) {
      log.error({ err: e, userId: req.userId }, "POST /gift failed");
      return res.status(500).json({ error: "Ошибка отправки подарка" });
    }
  });

  router.post("/chat", async (req, res) => {
    const personaId = V.id(req.body?.personaId) || "luna";
    const mood = V.str(req.body?.mood, 30) || "default";
    const uid = req.userId;
    try {
      const text = V.str(req.body?.message, MAX_MESSAGE_LENGTH).trim();
      if (!text) return res.status(400).json({ error: "Поле message обязательно" });
      if (text.length > MAX_MESSAGE_LENGTH) return res.status(400).json({ error: "Сообщение слишком длинное" });
      const normalized = text.toLowerCase();

      const profile = await getUserProfile(uid);
      const plan = getEffectivePlan(profile);
      const usageToday = await getTodayUsageCount(uid);
      const limitToday = getPlanLimit(plan);
      const bonusMessages = profile?.bonusMessages ?? 0;
      const remainingToday = Math.max(0, limitToday - usageToday + bonusMessages);

      let persona;
      if (String(personaId).startsWith("custom_")) {
        persona = await getCustomPersona(uid, personaId);
        if (!persona) return res.status(404).json({ error: "Персонаж не найден" });
      } else {
        persona = getPersonaById(personaId);
        if (!persona) return res.status(404).json({ error: "Персонаж не найден" });
        if (persona.premium && plan !== "pro") return res.status(403).json({ error: `Персонаж ${persona.name} доступен только на тарифе Pro.`, plan });
      }

      await updateStreak(uid);
      await trackActivity(uid);
      if (remainingToday <= 0) {
        return res.status(429).json({
          error: "Лимит сообщений на сегодня исчерпан", limitReached: true, plan, usageToday, limitToday, remainingToday: 0,
          upgrade: plan === "free" ? { text: "Перейди на Pro — 200 сообщений в день!", action: "upgrade_pro" } : null,
        });
      }

      const rememberPrefixes = ["remember:", "запомни:"];
      const prefix = rememberPrefixes.find(item => normalized.startsWith(item));
      if (prefix) {
        const fact = text.slice(prefix.length).trim();
        if (fact) {
          await addUserFact(uid, personaId, fact);
          const { behavior, ...safePer } = persona;
          return res.json({ persona: safePer, reply: `Сохранила в память. Я запомнила: ${fact}`, plan, usageToday, limitToday, remainingToday });
        }
      }

      await addChatMessage({ userId: uid, personaId, role: "user", content: text });
      const facts = await getUserFacts(uid, personaId, 10);
      const recentMessages = await getRecentChatMessages({ userId: uid, personaId, limit: 8 });
      if (recentMessages.length === 0) await addTimelineEvent(uid, personaId, "first_message", { text: text.slice(0, 100) });

      const aff = await getAffection(uid, personaId);
      let jealousyMsg = null;
      const lastChat = await getLastChatPersona(uid);
      if (lastChat && lastChat.personaId !== personaId && aff.level >= 3) {
        const otherPersona = getPersonaById(lastChat.personaId);
        if (otherPersona && Date.now() - lastChat.at < 3600000) jealousyMsg = await generateJealousyReaction(personaId, otherPersona.name, aff.level);
      }
      await setLastChatPersona(uid, personaId);

      const girlMoodState = await getGirlMood(uid, personaId);
      const girlMoodPromptText = getGirlMoodPrompt(girlMoodState);
      const arc = getCurrentArc(aff.level);
      const chapter = arc ? getCurrentChapter(aff.level, arc) : null;
      const arcPrompt = chapter ? `[СЮЖЕТ: Сейчас глава "${chapter.title}" из арки "${arc.title}". ${chapter.prompt}]` : "";

      const reply = await Promise.race([
        generateReply({
          personaId, persona,
          message: jealousyMsg ? `[Контекст: она заметила что ты только что писал другой девушке] ${text}` : text,
          memory: { facts, recentMessages, arcPrompt }, mood: String(mood), affectionLevel: aff.level, girlMoodPrompt: girlMoodPromptText,
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("AI_TIMEOUT")), AI_CHAT_TIMEOUT_MS)),
      ]);

      await addChatMessage({ userId: uid, personaId, role: "assistant", content: reply });
      const chatXpMul = getXpMultiplier();
      await addAffectionXp(uid, personaId, Math.round(1 * chatXpMul));
      await incrementGameStat(uid, "msgCount");

      const moodAnalysis = await analyzeMoodFromMessage(text, girlMoodState.current, personaId, aff.level).catch(() => null);
      let updatedGirlMood = girlMoodState;
      if (moodAnalysis && moodAnalysis.mood && moodAnalysis.mood !== girlMoodState.current) {
        updatedGirlMood = await setGirlMood(uid, personaId, moodAnalysis.mood, moodAnalysis.intensity, moodAnalysis.reason);
      }
      const specialMoments = detectSpecialMoment(text, aff.level);
      for (const m of specialMoments) await addTimelineEvent(uid, personaId, m.type, m.data);

      if (jealousyMsg) {
        await setGirlMood(uid, personaId, "jealous", 70, "Писал другой девушке");
        updatedGirlMood = await getGirlMood(uid, personaId);
      }
      if (usageToday < limitToday) await incrementTodayUsage(uid);
      else await decrementBonusMessage(uid);

      const challengeResult = await updateChallengeStreak(uid, personaId);
      const nextUsage = await getTodayUsageCount(uid);
      const profileAfter = await getUserProfile(uid);
      const nextRemaining = Math.max(0, limitToday - nextUsage + (profileAfter.bonusMessages ?? 0));
      const updatedAff = await getAffection(uid, personaId);

      if (updatedAff.level > aff.level) {
        await addTimelineEvent(uid, personaId, "level_up", { from: aff.level, to: updatedAff.level, label: updatedAff.label });
        if (updatedAff.level === 7) await addTimelineEvent(uid, personaId, "max_level", { label: updatedAff.label });
      }

      const { behavior, ...safePer } = persona;
      const newAchievements = await checkAchievements(uid, {});
      const moodMeta = GIRL_MOODS[updatedGirlMood.current] || GIRL_MOODS.neutral;
      const payload = {
        persona: safePer, reply, plan, usageToday: nextUsage, limitToday, remainingToday: nextRemaining,
        affection: updatedAff, jealousy: jealousyMsg, newAchievements,
        girlMood: { id: updatedGirlMood.current, label: moodMeta.label, emoji: moodMeta.emoji, color: moodMeta.color, glow: moodMeta.glow, intensity: updatedGirlMood.intensity, reason: moodAnalysis?.reason || "" },
      };
      if (challengeResult?.completed) { payload.challengeCompleted = true; payload.challengeBonus = challengeResult.bonus; }
      else if (challengeResult?.updated) payload.challengeStreak = challengeResult.streakDays;
      trackEvent(uid, "chat_message", { personaId });
      res.json(payload);

      (async () => {
        try {
          const existingFacts = await getUserFacts(uid, personaId, 20);
          const newFacts = await extractFacts(text, reply, existingFacts);
          for (const fact of newFacts) await addUserFact(uid, personaId, fact);
        } catch (e) { log.warn({ err: e }, "Fact extraction failed"); }
      })();
      checkQuests(uid, {}).catch(() => {});
    } catch (error) {
      log.error({ err: error, userId: req.userId }, "POST /chat failed");
      const msg = error.message === "AI_TIMEOUT" ? "Ответ занял слишком много времени. Попробуй ещё раз." : "Ошибка сервера";
      return res.status(500).json({ error: msg });
    }
  });

  router.get("/quests", async (req, res) => {
    try {
      const quests = getQuestsList();
      const userProgress = await getUserQuests(req.userId);
      const result = quests.map(q => ({ ...q, progress: userProgress[q.id]?.progress || 0, status: userProgress[q.id]?.status || "active", completedAt: userProgress[q.id]?.completedAt || null }));
      return res.json({ quests: result });
    } catch { return res.status(500).json({ error: "Ошибка квестов" }); }
  });

  router.get("/girl-mood", async (req, res) => {
    const personaId = String(req.query.personaId || "luna");
    try {
      const moodState = await getGirlMood(req.userId, personaId);
      const meta = GIRL_MOODS[moodState.current] || GIRL_MOODS.neutral;
      res.json({ id: moodState.current, label: meta.label, emoji: meta.emoji, color: meta.color, glow: meta.glow, intensity: moodState.intensity, history: moodState.history.slice(-10).reverse() });
    } catch { res.status(500).json({ error: "Ошибка получения настроения" }); }
  });

  router.get("/timeline", async (req, res) => {
    const personaId = String(req.query.personaId || "luna");
    const limit = Math.min(100, Number(req.query.limit) || 50);
    try {
      const events = await getTimeline(req.userId, personaId, limit);
      const stats = await getTimelineStats(req.userId, personaId);
      const aff = await getAffection(req.userId, personaId);
      const moodState = await getGirlMood(req.userId, personaId);
      const moodMeta = GIRL_MOODS[moodState.current] || GIRL_MOODS.neutral;
      res.json({
        events: events.map(e => ({ ...e, meta: getTimelineTypes()[e.type] || { label: e.type, emoji: "📌", color: "#7c5cff" } })),
        stats, affection: aff,
        currentMood: { id: moodState.current, label: moodMeta.label, emoji: moodMeta.emoji, color: moodMeta.color, intensity: moodState.intensity },
      });
    } catch (e) {
      log.error({ err: e }, "Timeline error");
      res.status(500).json({ error: "Ошибка загрузки таймлайна" });
    }
  });

  router.get("/diary", async (req, res) => {
    const personaId = String(req.query.personaId || "luna");
    try {
      const entries = getDiaryEntries(personaId);
      if (!entries) return res.json({ entries: [], maxLevel: 0 });
      const aff = await getAffection(req.userId, personaId);
      const unlocked = entries.slice(0, aff.level).map((text, i) => ({ level: i + 1, text, locked: false }));
      const locked = entries.slice(aff.level).map((_, i) => ({ level: aff.level + i + 1, text: null, locked: true }));
      if (aff.level >= 7 && !(await getAchievements(req.userId)).includes("diary_full")) await unlockAchievement(req.userId, "diary_full");
      return res.json({ entries: [...unlocked, ...locked], currentLevel: aff.level });
    } catch { return res.status(500).json({ error: "Ошибка загрузки дневника" }); }
  });

  return router;
};
