const { Router } = require("express");
const log = require("../logger").child({ module: "routes/social" });
const V = require("../validate");
const {
  getRecentStories, reactToStory, setGirlMood, getAffection,
  getStorageMode, getPool,
} = require("../storage");
const { getCurrentArc, getCurrentChapter, getStoryArcs } = require("../ai");
const { getActiveEvents, getAllEvents } = require("../events");
const { trackEvent, getStats } = require("../analytics");
const { getJobStats } = require("../scheduler");
const { ADMIN_USER_IDS, PRO_PRICE_STARS, FANTASY_PRICE_STARS, PRO_DURATION_DAYS, FANTASY_DURATION_DAYS } = require("../config");

module.exports = function createSocialRouter() {
  const router = Router();

  router.get("/stories", async (_req, res) => {
    try { return res.json({ stories: await getRecentStories(20) }); }
    catch { return res.json({ stories: [] }); }
  });

  router.post("/stories/react", async (req, res) => {
    const personaId = V.id(req.body?.personaId);
    const reaction = V.str(req.body?.reaction, 20);
    try {
      await reactToStory(personaId, null, req.userId, reaction);
      if (personaId && reaction) await setGirlMood(req.userId, personaId, reaction === "heart" ? "loving" : "happy", 60, "Реакция на историю");
      return res.json({ ok: true });
    } catch { return res.json({ ok: true }); }
  });

  router.get("/story-arc", async (req, res) => {
    const personaId = req.query.personaId || "";
    try {
      const aff = await getAffection(req.userId, personaId);
      const level = aff.level || 1;
      const arc = getCurrentArc(level);
      const chapter = arc ? getCurrentChapter(level, arc) : null;
      const allArcs = Object.values(getStoryArcs()).map(a => ({
        id: a.id, title: a.title, levelRange: a.levelRange,
        unlocked: level >= a.levelRange[0], active: arc?.id === a.id,
        chapters: a.chapters.map((c, i) => ({ title: c.title, index: i })),
        currentChapter: arc?.id === a.id ? chapter?.index : null,
      }));
      return res.json({ arcs: allArcs, currentArc: arc?.id || null, currentChapter: chapter?.index ?? null });
    } catch { return res.json({ arcs: [], currentArc: null, currentChapter: null }); }
  });

  router.get("/events", (_req, res) => {
    return res.json({ active: getActiveEvents(), all: getAllEvents() });
  });

  router.get("/pricing", (_req, res) => {
    res.json({
      pro: { price: PRO_PRICE_STARS, duration: PRO_DURATION_DAYS },
      fantasy: { price: FANTASY_PRICE_STARS, duration: FANTASY_DURATION_DAYS },
      starsPresets: require("../config").STARS_PRESETS,
    });
  });

  router.get("/admin/stats", async (req, res) => {
    if (!ADMIN_USER_IDS.length || !ADMIN_USER_IDS.includes(req.userId)) return res.status(403).json({ error: "Forbidden" });
    try {
      const days = parseInt(req.query.days) || 7;
      const stats = await getStats(days);
      stats.scheduler = getJobStats();
      stats.uptime = Math.round(process.uptime());
      stats.memoryMB = Math.round(process.memoryUsage().heapUsed / 1048576);
      return res.json(stats);
    } catch { return res.status(500).json({ error: "Ошибка статистики" }); }
  });

  router.get("/health", async (_req, res) => {
    const checks = { storage: "ok", ai: "ok" };
    if (getStorageMode() === "postgres") {
      try { await require("../storage").healthCheck(); } catch { checks.storage = "error"; }
    }
    if (!process.env.OPENAI_API_KEY) checks.ai = "mock";
    const allOk = Object.values(checks).every(v => v === "ok" || v === "mock");
    res.status(allOk ? 200 : 503).json({ ok: allOk, uptime: process.uptime() | 0, mode: getStorageMode(), checks });
  });

  return router;
};
