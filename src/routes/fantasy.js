const { Router } = require("express");
const log = require("../logger").child({ module: "routes/fantasy" });
const V = require("../validate");
const {
  hasFantasyAccess, grantFantasyAccess,
  saveFantasyPersona, getFantasyPersonas, deleteFantasyPersona,
  getFantasyStoryState, setFantasyStoryState,
  getRecentChatMessages, addChatMessage, trackActivity,
  FANTASY_MAX_PERSONAS,
} = require("../storage");
const {
  getFantasyScenarios, getFantasyFilters,
  getFantasyStory, buildFantasyContext, generateFantasyPersona,
  generateFantasyReply, generateFantasyReaction, generateFantasyAvatar,
} = require("../fantasy");
const { trackEvent } = require("../analytics");
const { FANTASY_PRICE_STARS, FANTASY_DURATION_DAYS, ADMIN_USER_IDS } = require("../config");

module.exports = function createFantasyRouter({ rateLimit, getBotInstance }) {
  const router = Router();

  async function requireFantasyAccess(req, res, next) {
    try {
      const access = await hasFantasyAccess(req.userId);
      if (!access) return res.status(403).json({ error: "Требуется подписка Fantasy+", needSubscribe: true });
      next();
    } catch { return res.status(403).json({ error: "Ошибка проверки доступа", needSubscribe: true }); }
  }

  router.use("/fantasy/chat", rateLimit);
  router.use("/fantasy/create-persona", rateLimit);

  router.get("/fantasy/access", async (req, res) => {
    try {
      const access = await hasFantasyAccess(req.userId);
      return res.json({ hasAccess: access });
    } catch { return res.json({ hasAccess: false }); }
  });

  router.post("/fantasy/restore-access", async (req, res) => {
    if (!ADMIN_USER_IDS.includes(req.userId)) {
      return res.status(403).json({ error: "Forbidden" });
    }
    try {
      await grantFantasyAccess(req.userId, 365);
      log.info({ userId: req.userId }, "Fantasy access manually restored");
      return res.json({ ok: true, message: "Доступ восстановлен на 365 дней" });
    } catch { return res.status(500).json({ error: "Ошибка восстановления" }); }
  });

  router.get("/fantasy/scenarios", (_req, res) => { res.json({ scenarios: getFantasyScenarios() }); });
  router.get("/fantasy/filters", (_req, res) => { res.json({ filters: getFantasyFilters() }); });

  router.post("/fantasy/generate-avatar", requireFantasyAccess, async (req, res) => {
    try {
      const scenarioId = V.id(req.body?.scenarioId);
      if (!scenarioId) return res.status(400).json({ error: "scenarioId required" });
      const avatarPath = await generateFantasyAvatar(scenarioId);
      res.json({ avatar: avatarPath });
    } catch (e) {
      log.error({ err: e }, "Fantasy avatar generation failed");
      res.status(500).json({ error: "Ошибка генерации аватара" });
    }
  });

  router.post("/fantasy/subscribe", async (req, res) => {
    try {
      const already = await hasFantasyAccess(req.userId);
      if (already) return res.json({ ok: true, alreadyActive: true });
      const bot = getBotInstance();
      if (!bot) return res.status(400).json({ error: "Бот не настроен" });
      const title = "Fantasy+ Подписка — НейроСпутник";
      const description = `Полный доступ к модулю Фантазии 18+: 15 сценариев, свободный чат, истории, конструктор персонажей. ${FANTASY_DURATION_DAYS} дней.`;
      const prices = [{ label: `Fantasy+ (${FANTASY_DURATION_DAYS} дней)`, amount: FANTASY_PRICE_STARS }];
      const link = await bot.api.createInvoiceLink(title, description, "fantasy_plus", "", "XTR", prices);
      return res.json({ ok: true, invoiceLink: link, price: FANTASY_PRICE_STARS });
    } catch (e) {
      log.error({ err: e }, "Fantasy subscribe error");
      return res.status(500).json({ error: "Ошибка создания платежа" });
    }
  });

  router.post("/fantasy/create-persona", requireFantasyAccess, async (req, res) => {
    try {
      const persona = await generateFantasyPersona(req.body);
      await saveFantasyPersona(req.userId, persona);
      const { behavior, ...safe } = persona;
      res.json({ persona: safe });
    } catch { res.status(500).json({ error: "Ошибка создания персонажа" }); }
  });

  router.get("/fantasy/personas", requireFantasyAccess, async (req, res) => {
    try {
      const list = await getFantasyPersonas(req.userId);
      const safe = list.map(({ behavior, ...rest }) => rest);
      res.json({ personas: safe, max: FANTASY_MAX_PERSONAS });
    } catch { res.status(500).json({ error: "Ошибка загрузки персонажей" }); }
  });

  router.delete("/fantasy/persona/:id", requireFantasyAccess, async (req, res) => {
    try {
      await deleteFantasyPersona(req.userId, req.params.id);
      res.json({ ok: true });
    } catch { res.status(500).json({ error: "Ошибка удаления персонажа" }); }
  });

  router.post("/fantasy/chat", requireFantasyAccess, async (req, res) => {
    try {
      const scenarioId = V.id(req.body?.scenarioId);
      const message = V.strRequired(req.body?.message, 2000);
      const filters = V.safeObj(req.body?.filters);
      const setting = V.str(req.body?.setting, 100);
      if (!message || !scenarioId) return res.status(400).json({ error: "scenarioId и message обязательны" });
      const persona = buildFantasyContext(scenarioId, filters || {});
      if (!persona) return res.status(404).json({ error: "Сценарий не найден" });
      const chatKey = `fantasy_${scenarioId}`;
      const recentMessages = await getRecentChatMessages({ userId: req.userId, personaId: chatKey, limit: 8 });
      const reply = await generateFantasyReply({ persona, message, memory: { facts: [], recentMessages }, setting: setting || persona.settings?.[0] });
      await addChatMessage({ userId: req.userId, personaId: chatKey, role: "user", content: message });
      await addChatMessage({ userId: req.userId, personaId: chatKey, role: "assistant", content: reply });
      await trackActivity(req.userId);
      res.json({ reply, persona: persona.name });
    } catch (e) {
      log.error({ err: e }, "Fantasy chat error");
      res.status(500).json({ error: "Ошибка генерации ответа" });
    }
  });

  router.get("/fantasy/story/:scenarioId", requireFantasyAccess, async (req, res) => {
    try {
      const story = getFantasyStory(req.params.scenarioId);
      if (!story) return res.status(404).json({ error: "История не найдена" });
      const state = await getFantasyStoryState(req.userId);
      res.json({ story, state });
    } catch { res.status(500).json({ error: "Ошибка загрузки истории" }); }
  });

  router.post("/fantasy/story/start", requireFantasyAccess, async (req, res) => {
    try {
      const scenarioId = V.id(req.body?.scenarioId);
      const filters = V.safeObj(req.body?.filters);
      const story = getFantasyStory(scenarioId);
      if (!story) return res.status(404).json({ error: "История не найдена" });
      const state = { scenarioId, filters: filters || {}, chapterIdx: 0, sceneIdx: 0, history: [], score: 0 };
      await setFantasyStoryState(req.userId, state);
      const chapter = story.chapters[0];
      const scene = chapter.scenes[0];
      res.json({ state, chapter: { id: chapter.id, title: chapter.title }, scene, totalChapters: story.chapters.length });
    } catch { res.status(500).json({ error: "Ошибка начала истории" }); }
  });

  router.post("/fantasy/story/choice", requireFantasyAccess, async (req, res) => {
    try {
      const choiceIdx = V.int(req.body?.choiceIdx, 0, 10);
      const state = await getFantasyStoryState(req.userId);
      if (!state) return res.status(400).json({ error: "Нет активной истории" });
      const story = getFantasyStory(state.scenarioId);
      if (!story) return res.status(404).json({ error: "История не найдена" });
      const chapter = story.chapters[state.chapterIdx];
      if (!chapter) return res.status(400).json({ error: "Глава не найдена" });
      const scene = chapter.scenes[state.sceneIdx];
      if (!scene) return res.status(400).json({ error: "Сцена не найдена" });
      const idx = typeof choiceIdx === "number" ? choiceIdx : 0;
      const wasGood = idx === scene.best;
      state.score += wasGood ? 10 : 3;
      state.history.push({ choice: scene.choices[idx], good: wasGood });
      const persona = buildFantasyContext(state.scenarioId, state.filters || {});
      const reaction = persona ? await generateFantasyReaction({ persona, choiceText: scene.choices[idx], wasGood }) : (wasGood ? "Мне нравится..." : "Ну такое...");
      let nextScene = null, nextChapter = null, finished = false;
      if (state.sceneIdx + 1 < chapter.scenes.length) { state.sceneIdx += 1; nextScene = chapter.scenes[state.sceneIdx]; nextChapter = { id: chapter.id, title: chapter.title }; }
      else if (state.chapterIdx + 1 < story.chapters.length) { state.chapterIdx += 1; state.sceneIdx = 0; const nc = story.chapters[state.chapterIdx]; nextScene = nc.scenes[0]; nextChapter = { id: nc.id, title: nc.title }; }
      else finished = true;
      await setFantasyStoryState(req.userId, finished ? null : state);
      res.json({ reaction, points: wasGood ? 10 : 3, wasGood, state: finished ? null : state, nextScene, nextChapter, finished, totalScore: state.score, totalChapters: story.chapters.length });
    } catch { res.status(500).json({ error: "Ошибка обработки выбора" }); }
  });

  return router;
};
