const log = require("./logger").child({ module: "analytics" });

const memoryEvents = [];
let pool = null;

async function initAnalytics(pgPool) {
  pool = pgPool;
  if (pool) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS analytics_events (
        id BIGSERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        event TEXT NOT NULL,
        data JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_analytics_event ON analytics_events (event);
      CREATE INDEX IF NOT EXISTS idx_analytics_created ON analytics_events (created_at);
      CREATE INDEX IF NOT EXISTS idx_analytics_user ON analytics_events (user_id);
      CREATE INDEX IF NOT EXISTS idx_analytics_user_event ON analytics_events (user_id, event);
    `);
    log.info("Analytics tables ready");
  }
}

async function trackEvent(userId, event, data = {}) {
  const entry = { userId, event, data, createdAt: new Date().toISOString() };
  if (pool) {
    try {
      await pool.query(
        `INSERT INTO analytics_events (user_id, event, data) VALUES ($1, $2, $3)`,
        [userId, event, JSON.stringify(data)]
      );
    } catch (e) { log.warn({ err: e, event }, "Analytics track error"); }
  } else {
    memoryEvents.push(entry);
    if (memoryEvents.length > 10000) memoryEvents.splice(0, 5000);
  }
}

async function getStats(days = 7) {
  const since = new Date(Date.now() - days * 86400000).toISOString();

  if (pool) {
    try {
      const [dau, totalEv, topPersonas, topEvents, funnel, revenue, retention, daily] = await Promise.all([
        pool.query(`SELECT COUNT(DISTINCT user_id) as c FROM analytics_events WHERE created_at >= $1`, [since]),
        pool.query(`SELECT COUNT(*) as c FROM analytics_events WHERE created_at >= $1`, [since]),
        pool.query(
          `SELECT data->>'personaId' as persona, COUNT(*) as c
           FROM analytics_events WHERE event = 'chat_message' AND created_at >= $1
           GROUP BY persona ORDER BY c DESC LIMIT 10`, [since]
        ),
        pool.query(
          `SELECT event, COUNT(*) as c FROM analytics_events
           WHERE created_at >= $1 GROUP BY event ORDER BY c DESC`, [since]
        ),
        buildFunnelPg(since),
        getRevenuePg(since),
        getRetentionPg(days),
        getDailyActivesPg(days),
      ]);

      return {
        period: `${days} days`,
        dau: parseInt(dau.rows[0]?.c) || 0,
        totalEvents: parseInt(totalEv.rows[0]?.c) || 0,
        topPersonas: topPersonas.rows.map(r => ({ persona: r.persona, count: parseInt(r.c) })),
        eventBreakdown: topEvents.rows.map(r => ({ event: r.event, count: parseInt(r.c) })),
        funnel,
        revenue,
        retention,
        dailyActives: daily,
      };
    } catch (e) {
      log.error({ err: e }, "getStats error");
      return { error: e.message };
    }
  }

  const filtered = memoryEvents.filter(e => e.createdAt >= since);
  const users = new Set(filtered.map(e => e.userId));
  const eventCounts = {};
  filtered.forEach(e => { eventCounts[e.event] = (eventCounts[e.event] || 0) + 1; });

  return {
    period: `${days} days`,
    dau: users.size,
    totalEvents: filtered.length,
    topPersonas: [],
    eventBreakdown: Object.entries(eventCounts)
      .map(([event, count]) => ({ event, count }))
      .sort((a, b) => b.count - a.count),
    funnel: buildFunnelMemory(filtered),
    revenue: { total: 0, proCount: 0, fantasyCount: 0, starsCount: 0 },
    retention: {},
    dailyActives: [],
  };
}

async function buildFunnelPg(since) {
  try {
    const steps = [
      { key: "app_opened", label: "Открыли приложение" },
      { key: "onboarding_completed", label: "Прошли онбординг" },
      { key: "chat_message", label: "Отправили сообщение" },
      { key: "gift_sent", label: "Отправили подарок" },
      { key: "pro_purchased", label: "Купили Pro" },
    ];
    const result = [];
    for (const s of steps) {
      const r = await pool.query(
        `SELECT COUNT(DISTINCT user_id) as c FROM analytics_events WHERE event = $1 AND created_at >= $2`,
        [s.key, since]
      );
      result.push({ step: s.label, event: s.key, users: parseInt(r.rows[0]?.c) || 0 });
    }
    if (result[0].users > 0) {
      result.forEach(s => { s.pct = Math.round((s.users / result[0].users) * 100); });
    }
    return result;
  } catch (e) {
    log.warn({ err: e }, "Funnel query error");
    return [];
  }
}

function buildFunnelMemory(events) {
  const steps = ["app_opened", "onboarding_completed", "chat_message", "gift_sent", "pro_purchased"];
  const labels = ["Открыли приложение", "Прошли онбординг", "Отправили сообщение", "Отправили подарок", "Купили Pro"];
  const result = steps.map((event, i) => {
    const users = new Set(events.filter(e => e.event === event).map(e => e.userId)).size;
    return { step: labels[i], event, users };
  });
  if (result[0].users > 0) {
    result.forEach(s => { s.pct = Math.round((s.users / result[0].users) * 100); });
  }
  return result;
}

async function getRevenuePg(since) {
  try {
    const [pro, fantasy, stars] = await Promise.all([
      pool.query(`SELECT COUNT(*) as c FROM analytics_events WHERE event = 'pro_purchased' AND created_at >= $1`, [since]),
      pool.query(`SELECT COUNT(*) as c FROM analytics_events WHERE event = 'fantasy_purchased' AND created_at >= $1`, [since]),
      pool.query(
        `SELECT COALESCE(SUM((data->>'amount')::int), 0) as total, COUNT(*) as c
         FROM analytics_events WHERE event = 'stars_topup' AND created_at >= $1`, [since]
      ),
    ]);
    const config = require("./config");
    const proCount = parseInt(pro.rows[0]?.c) || 0;
    const fantasyCount = parseInt(fantasy.rows[0]?.c) || 0;
    const starsTotal = parseInt(stars.rows[0]?.total) || 0;
    const starsCount = parseInt(stars.rows[0]?.c) || 0;
    const totalStars = proCount * config.PRO_PRICE_STARS + fantasyCount * config.FANTASY_PRICE_STARS + starsTotal;
    return { totalStars, proCount, fantasyCount, starsCount, estimatedUSD: +(totalStars * 0.013).toFixed(2) };
  } catch (e) {
    log.warn({ err: e }, "Revenue query error");
    return { totalStars: 0, proCount: 0, fantasyCount: 0, starsCount: 0, estimatedUSD: 0 };
  }
}

async function getRetentionPg(days) {
  try {
    const r = await pool.query(`
      WITH first_seen AS (
        SELECT user_id, MIN(created_at::date) as first_day
        FROM analytics_events GROUP BY user_id
      ),
      activity AS (
        SELECT DISTINCT user_id, created_at::date as day
        FROM analytics_events
      )
      SELECT
        f.first_day,
        COUNT(DISTINCT f.user_id) as cohort_size,
        COUNT(DISTINCT CASE WHEN a.day = f.first_day + 1 THEN a.user_id END) as d1,
        COUNT(DISTINCT CASE WHEN a.day = f.first_day + 7 THEN a.user_id END) as d7,
        COUNT(DISTINCT CASE WHEN a.day = f.first_day + 30 THEN a.user_id END) as d30
      FROM first_seen f
      LEFT JOIN activity a ON a.user_id = f.user_id
      WHERE f.first_day >= (NOW() - ($1 || ' days')::interval)::date
      GROUP BY f.first_day
      ORDER BY f.first_day DESC
      LIMIT 14
    `, [days]);
    return r.rows.map(row => ({
      date: row.first_day,
      cohort: parseInt(row.cohort_size),
      d1: parseInt(row.d1),
      d7: parseInt(row.d7),
      d30: parseInt(row.d30),
      d1pct: parseInt(row.cohort_size) > 0 ? Math.round(parseInt(row.d1) / parseInt(row.cohort_size) * 100) : 0,
    }));
  } catch (e) {
    log.warn({ err: e }, "Retention query error");
    return [];
  }
}

async function getDailyActivesPg(days) {
  try {
    const r = await pool.query(`
      SELECT created_at::date as day, COUNT(DISTINCT user_id) as dau, COUNT(*) as events
      FROM analytics_events
      WHERE created_at >= NOW() - ($1 || ' days')::interval
      GROUP BY day ORDER BY day
    `, [days]);
    return r.rows.map(row => ({ date: row.day, dau: parseInt(row.dau), events: parseInt(row.events) }));
  } catch (e) {
    log.warn({ err: e }, "Daily actives query error");
    return [];
  }
}

module.exports = { initAnalytics, trackEvent, getStats };
