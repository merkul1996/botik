const { Pool } = require("pg");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const log = require("./logger").child({ module: "storage" });
const { MAX_CHAT_HISTORY } = require("./config");

let mode = "memory";
let pool = null;

/* ══════════════════════════════════════════════════
   PERSISTENCE ENGINE FOR MEMORY MODE
   - Auto-save every 10s
   - Immediate flush after critical mutations (payments, balance)
   - Write-ahead log (WAL) for financial operations
   - Per-user mutex for race condition protection
   ══════════════════════════════════════════════════ */
const DATA_DIR = path.join(__dirname, "..", "data");
const SAVE_INTERVAL_MS = 10_000;
const FLUSH_DEBOUNCE_MS = 500;
let _saveTimer = null;
let _saving = false;
let _dirty = false;
let _flushTimer = null;

const PERSISTED_STORES = {};

function registerStore(name, map) {
  PERSISTED_STORES[name] = map;
  return map;
}

function markDirty() {
  _dirty = true;
}

function scheduleFlush() {
  _dirty = true;
  if (_flushTimer) return;
  _flushTimer = setTimeout(() => {
    _flushTimer = null;
    saveAllToDiskAsync();
  }, FLUSH_DEBOUNCE_MS);
}

function mapToObj(map) {
  const obj = {};
  for (const [k, v] of map.entries()) obj[k] = v;
  return obj;
}

function objToMap(obj) {
  const map = new Map();
  if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) map.set(k, v);
  }
  return map;
}

function loadAllFromDiskSync() {
  try {
    const file = path.join(DATA_DIR, "memory_store.json");
    if (!fs.existsSync(file)) {
      migrateOldFantasyFileSync();
      return;
    }
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    for (const [name, map] of Object.entries(PERSISTED_STORES)) {
      if (raw[name]) {
        const loaded = objToMap(raw[name]);
        map.clear();
        for (const [k, v] of loaded.entries()) map.set(k, v);
      }
    }
    log.info({ stores: Object.keys(raw).length }, "Memory store loaded from disk");
  } catch (e) { log.warn({ err: e }, "Failed to load memory_store.json"); }
}

function migrateOldFantasyFileSync() {
  try {
    const old = path.join(DATA_DIR, "fantasy_access.json");
    if (!fs.existsSync(old)) return;
    const raw = JSON.parse(fs.readFileSync(old, "utf-8"));
    for (const [k, v] of Object.entries(raw)) memoryFantasyAccess.set(k, v);
    log.info("Migrated fantasy_access.json into memory store");
  } catch (e) { log.warn({ err: e }, "Migration of fantasy_access.json failed"); }
}

async function saveAllToDiskAsync() {
  if (mode !== "memory") return;
  if (_saving) { _dirty = true; return; }
  _saving = true;
  _dirty = false;
  try {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    const snapshot = {};
    for (const [name, map] of Object.entries(PERSISTED_STORES)) {
      snapshot[name] = mapToObj(map);
    }
    const file = path.join(DATA_DIR, "memory_store.json");
    const tmp = file + ".tmp";
    await fsp.writeFile(tmp, JSON.stringify(snapshot));
    await fsp.rename(tmp, file);
  } catch (e) { log.error({ err: e }, "Failed to save memory_store.json"); }
  finally {
    _saving = false;
    if (_dirty) setImmediate(() => saveAllToDiskAsync());
  }
}

function saveAllToDiskSync() {
  if (mode !== "memory") return;
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const snapshot = {};
    for (const [name, map] of Object.entries(PERSISTED_STORES)) {
      snapshot[name] = mapToObj(map);
    }
    const file = path.join(DATA_DIR, "memory_store.json");
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(snapshot));
    fs.renameSync(tmp, file);
  } catch (e) { log.error({ err: e }, "Sync save failed"); }
}

/* ── Write-Ahead Log for financial operations ── */
const WAL_FILE = path.join(DATA_DIR, "wal.jsonl");

function walAppend(entry) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const line = JSON.stringify({ ...entry, ts: Date.now() }) + "\n";
    fs.appendFileSync(WAL_FILE, line);
  } catch (e) { log.error({ err: e }, "WAL append failed"); }
}

function walReplay() {
  try {
    if (!fs.existsSync(WAL_FILE)) return;
    const lines = fs.readFileSync(WAL_FILE, "utf-8").trim().split("\n").filter(Boolean);
    if (!lines.length) return;
    let replayed = 0;
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        const profile = getMemoryProfile(entry.userId);
        if (entry.op === "deduct" && typeof entry.amount === "number") {
          const cur = profile.starsBalance ?? 0;
          if (cur >= entry.amount) profile.starsBalance = cur - entry.amount;
        } else if (entry.op === "add" && typeof entry.amount === "number") {
          profile.starsBalance = (profile.starsBalance ?? 0) + entry.amount;
        } else if (entry.op === "plan" && entry.plan) {
          profile.plan = entry.plan;
          if (entry.proExpiresAt) profile.proExpiresAt = entry.proExpiresAt;
        } else if (entry.op === "fantasy_access" && entry.expiresAt) {
          memoryFantasyAccess.set(entry.userId, { grantedAt: entry.ts, expiresAt: entry.expiresAt });
        }
        replayed++;
      } catch { /* skip malformed line */ }
    }
    if (replayed) {
      log.info({ replayed, total: lines.length }, "WAL replayed");
      saveAllToDiskSync();
      fs.writeFileSync(WAL_FILE, "");
    }
  } catch (e) { log.warn({ err: e }, "WAL replay failed"); }
}

function walClear() {
  try { if (fs.existsSync(WAL_FILE)) fs.writeFileSync(WAL_FILE, ""); } catch {}
}

/* ── Per-user mutex for race condition protection ── */
const _locks = new Map();

async function withUserLock(userId, fn) {
  if (!_locks.has(userId)) _locks.set(userId, Promise.resolve());
  const prev = _locks.get(userId);
  let release;
  const next = new Promise(resolve => { release = resolve; });
  _locks.set(userId, next);
  try {
    await prev;
    return await fn();
  } finally {
    release();
    if (_locks.get(userId) === next) _locks.delete(userId);
  }
}

function startAutoSave() {
  if (_saveTimer) return;
  _saveTimer = setInterval(() => {
    if (_dirty) saveAllToDiskAsync();
  }, SAVE_INTERVAL_MS);
  if (_saveTimer.unref) _saveTimer.unref();
}

function stopAutoSave() {
  if (_saveTimer) { clearInterval(_saveTimer); _saveTimer = null; }
  if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
  saveAllToDiskSync();
  walClear();
}

process.on("SIGINT", () => { stopAutoSave(); process.exit(0); });
process.on("SIGTERM", () => { stopAutoSave(); process.exit(0); });

const memoryFacts = registerStore("facts", new Map());
const memoryMessages = registerStore("messages", new Map());
const memoryProfiles = registerStore("profiles", new Map());
const memoryUsage = registerStore("usage", new Map());
const memoryStreaks = registerStore("streaks", new Map());
const memoryReferrals = registerStore("referrals", new Map());
const memoryLastActivity = registerStore("lastActivity", new Map());
const memoryCustomPersonas = registerStore("customPersonas", new Map());
const memoryAffection = registerStore("affection", new Map());
const memoryDates = registerStore("dates", new Map());
const memoryFantasyPersonas = registerStore("fantasyPersonas", new Map());
const memoryFantasyAccess = registerStore("fantasyAccess", new Map());
const memoryFantasyStoryState = registerStore("fantasyStoryState", new Map());
const memoryGirlMood = registerStore("girlMood", new Map());
const memoryTimeline = registerStore("timeline", new Map());
const memoryQuests = registerStore("quests", new Map());
const memoryStories = registerStore("stories", new Map());

loadAllFromDiskSync();
walReplay();
startAutoSave();

function getMemoryFacts(userId, personaId) {
  const key = personaId ? `${userId}:${personaId}` : userId;
  if (!memoryFacts.has(key)) {
    memoryFacts.set(key, []);
  }
  return memoryFacts.get(key);
}

function getMemoryMessages(userId) {
  if (!memoryMessages.has(userId)) {
    memoryMessages.set(userId, []);
  }
  return memoryMessages.get(userId);
}

function getStorageMode() {
  return mode;
}

function getTodayKey() {
  return new Date().toISOString().slice(0, 10);
}

function getMemoryProfile(userId) {
  if (!memoryProfiles.has(userId)) {
    memoryProfiles.set(userId, {
      plan: "pro",
      createdAt: new Date().toISOString(),
      trialEndsAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
      referralCode: generateRandomReferralCode(),
      referredBy: null,
      bonusMessages: 0,
      starsBalance: 0,
      referralProEndsAt: null,
      favorites: [],
      unlockedPersonas: [],
    });
  }
  return memoryProfiles.get(userId);
}

function generateRandomReferralCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function getMemoryStreak(userId) {
  if (!memoryStreaks.has(userId)) {
    memoryStreaks.set(userId, { currentStreak: 0, lastActiveDate: null, longestStreak: 0 });
  }
  return memoryStreaks.get(userId);
}

function getMemoryUsageForToday(userId) {
  const key = `${userId}:${getTodayKey()}`;
  if (!memoryUsage.has(key)) {
    memoryUsage.set(key, 0);
  }
  return {
    key,
    count: memoryUsage.get(key),
  };
}

setInterval(() => {
  const today = getTodayKey();
  for (const key of memoryUsage.keys()) {
    if (!key.endsWith(today)) memoryUsage.delete(key);
  }
}, 60 * 60 * 1000).unref();

async function initStorage() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    mode = "memory";
    return;
  }

  const useSsl = String(process.env.DATABASE_SSL || "false").toLowerCase() === "true";

  pool = new Pool({
    connectionString: databaseUrl,
    ssl: useSsl ? { rejectUnauthorized: false } : false,
    max: Number(process.env.PG_MAX_CONNECTIONS || 20),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });
  pool.on("error", (err) => log.error({ err }, "Unexpected PG pool error"));

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_facts (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      persona_id TEXT NOT NULL DEFAULT 'default',
      fact TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    ALTER TABLE user_facts ADD COLUMN IF NOT EXISTS persona_id TEXT NOT NULL DEFAULT 'default';
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      persona_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_profiles (
      user_id TEXT PRIMARY KEY,
      plan TEXT NOT NULL DEFAULT 'free',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS daily_usage (
      user_id TEXT NOT NULL,
      usage_date DATE NOT NULL,
      messages_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, usage_date)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_streaks (
      user_id TEXT PRIMARY KEY,
      current_streak INTEGER NOT NULL DEFAULT 0,
      last_active_date TEXT,
      longest_streak INTEGER NOT NULL DEFAULT 0
    );
  `);

  await pool.query(`
    ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS referral_code TEXT;
    ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS referred_by TEXT;
    ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS bonus_messages INTEGER NOT NULL DEFAULT 0;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_activity (
      user_id TEXT PRIMARY KEY,
      last_active_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS favorites (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      persona_id TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;
    ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS stars_balance INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS referral_pro_ends_at TIMESTAMPTZ;
    ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS pro_expires_at TIMESTAMPTZ;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_challenge (
      user_id TEXT PRIMARY KEY,
      persona_id TEXT NOT NULL,
      streak_days INTEGER NOT NULL DEFAULT 0,
      last_date TEXT,
      completed_at TIMESTAMPTZ
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_affection (
      user_id TEXT NOT NULL,
      persona_id TEXT NOT NULL,
      xp INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, persona_id)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS gift_history (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      persona_id TEXT NOT NULL,
      gift_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS custom_personas (
      id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, id)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS active_dates (
      user_id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS last_chat_persona (
      user_id TEXT PRIMARY KEY,
      persona_id TEXT NOT NULL,
      at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS fantasy_personas (
      id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      scenario_id TEXT NOT NULL,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, id)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS fantasy_access (
      user_id TEXT PRIMARY KEY,
      granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS fantasy_story_state (
      user_id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS girl_mood (
      user_id TEXT NOT NULL,
      persona_id TEXT NOT NULL,
      current TEXT NOT NULL DEFAULT 'neutral',
      intensity INTEGER NOT NULL DEFAULT 50,
      decay_rate INTEGER NOT NULL DEFAULT 5,
      reason TEXT DEFAULT '',
      last_update BIGINT NOT NULL DEFAULT 0,
      history JSONB DEFAULT '[]',
      PRIMARY KEY (user_id, persona_id)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS timeline_events (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      persona_id TEXT NOT NULL,
      type TEXT NOT NULL,
      data JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_timeline_user_persona ON timeline_events (user_id, persona_id);`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_achievements (
      user_id TEXT NOT NULL,
      achievement_id TEXT NOT NULL,
      unlocked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, achievement_id)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS notification_settings (
      user_id TEXT PRIMARY KEY,
      enabled BOOLEAN NOT NULL DEFAULT false,
      persona_id TEXT
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_quests (
      user_id TEXT NOT NULL,
      quest_id TEXT NOT NULL,
      progress INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      PRIMARY KEY (user_id, quest_id)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS stories (
      id BIGSERIAL PRIMARY KEY,
      persona_id TEXT NOT NULL,
      text TEXT NOT NULL,
      reactions JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_stories_persona ON stories (persona_id, created_at DESC);`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS referrals (
      id BIGSERIAL PRIMARY KEY,
      referrer_id TEXT NOT NULL,
      referred_id TEXT NOT NULL UNIQUE,
      reward_given BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals (referrer_id);`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS game_stats (
      user_id TEXT PRIMARY KEY,
      total_games INTEGER NOT NULL DEFAULT 0,
      dates INTEGER NOT NULL DEFAULT 0,
      gift_count INTEGER NOT NULL DEFAULT 0,
      msg_count INTEGER NOT NULL DEFAULT 0
    );
  `);

  mode = "postgres";
}

async function getUserFacts(userId, personaId, limit = 10) {
  if (mode === "memory") {
    return getMemoryFacts(userId, personaId).slice(-limit);
  }

  const result = await pool.query(
    `
      SELECT fact
      FROM user_facts
      WHERE user_id = $1 AND persona_id = $2
      ORDER BY created_at DESC
      LIMIT $3
    `,
    [userId, personaId || "default", limit]
  );

  return result.rows.map((row) => row.fact).reverse();
}

async function addUserFact(userId, personaId, fact) {
  if (mode === "memory") {
    const facts = getMemoryFacts(userId, personaId);
    const lower = fact.toLowerCase();
    if (facts.some((f) => f.toLowerCase().includes(lower) || lower.includes(f.toLowerCase()))) {
      return;
    }
    facts.push(fact);
    if (facts.length > 50) {
      facts.splice(0, facts.length - 50);
    }
    markDirty(); scheduleFlush();
    return;
  }

  try {
    const existing = await pool.query(
      `SELECT fact FROM user_facts WHERE user_id = $1 AND persona_id = $2`,
      [userId, personaId || "default"]
    );
    const lower = fact.toLowerCase();
    if (existing.rows.some((r) => r.fact.toLowerCase().includes(lower) || lower.includes(r.fact.toLowerCase()))) {
      return;
    }
    await pool.query(
      `INSERT INTO user_facts (user_id, persona_id, fact) VALUES ($1, $2, $3)`,
      [userId, personaId || "default", fact]
    );
  } catch (e) {
    log.error({ err: e, userId }, "addUserFact pg error");
  }
}

async function addChatMessage({ userId, personaId, role, content }) {
  if (mode === "memory") {
    const messages = getMemoryMessages(userId);
    messages.push({ personaId, role, content, createdAt: new Date().toISOString() });
    if (messages.length > 100) {
      messages.splice(0, messages.length - 100);
    }
    markDirty(); scheduleFlush();
    return;
  }

  try {
    await pool.query(
      `INSERT INTO chat_messages (user_id, persona_id, role, content) VALUES ($1, $2, $3, $4)`,
      [userId, personaId, role, content]
    );
    await pool.query(
      `DELETE FROM chat_messages WHERE id IN (
        SELECT id FROM chat_messages WHERE user_id = $1
        ORDER BY created_at DESC OFFSET $2
      )`,
      [userId, MAX_CHAT_HISTORY]
    );
  } catch (e) {
    log.error({ err: e, userId }, "addChatMessage pg error");
  }
}

async function getRecentChatMessages({ userId, personaId, limit = 8 }) {
  if (mode === "memory") {
    const messages = getMemoryMessages(userId)
      .filter((msg) => msg.personaId === personaId)
      .slice(-limit);
    return messages.map((msg) => ({
      role: msg.role,
      content: msg.content,
    }));
  }

  const result = await pool.query(
    `
      SELECT role, content
      FROM chat_messages
      WHERE user_id = $1 AND persona_id = $2
      ORDER BY created_at DESC
      LIMIT $3
    `,
    [userId, personaId, limit]
  );

  return result.rows.reverse();
}

async function ensureUserProfile(userId) {
  if (mode === "memory") {
    return getMemoryProfile(userId);
  }

  const referralCode = generateRandomReferralCode();
  const trialEndsAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
  const result = await pool.query(
    `INSERT INTO user_profiles (user_id, plan, referral_code, trial_ends_at)
     VALUES ($1, 'pro', $2, $3)
     ON CONFLICT (user_id) DO NOTHING
     RETURNING *`,
    [userId, referralCode, trialEndsAt.toISOString()]
  );
  if (result.rows.length > 0) return result.rows[0];
  const existing = await pool.query(`SELECT * FROM user_profiles WHERE user_id = $1 LIMIT 1`, [userId]);
  return existing.rows[0];
}

function resolveTrialPlan(profile) {
  if (profile.plan === "pro" && profile.trialEndsAt) {
    const trialEnd = new Date(profile.trialEndsAt);
    if (Date.now() > trialEnd.getTime()) {
      profile.plan = "free";
      profile.trialEndsAt = null;
    }
  }
  return profile;
}

async function getUserProfile(userId) {
  if (mode === "memory") {
    const profile = resolveTrialPlan(getMemoryProfile(userId));
    if (profile.plan === "pro" && profile.proExpiresAt) {
      if (Date.now() > new Date(profile.proExpiresAt).getTime()) {
        profile.plan = "free";
        profile.proExpiresAt = null;
      }
    }
    const refCount = await getReferralCount(userId);
    return {
      user_id: userId,
      plan: profile.plan,
      referralCode: profile.referralCode,
      bonusMessages: profile.bonusMessages || 0,
      starsBalance: profile.starsBalance ?? 0,
      referralCount: refCount,
      referralProEndsAt: profile.referralProEndsAt || null,
      trialEndsAt: profile.trialEndsAt || null,
      proExpiresAt: profile.proExpiresAt || null,
      unlockedPersonas: profile.unlockedPersonas || [],
      favorites: profile.favorites || [],
    };
  }

  let profile = await ensureUserProfile(userId);

  let needDowngrade = false;
  if (profile.plan === "pro") {
    const trialEnd = profile.trial_ends_at ? new Date(profile.trial_ends_at) : null;
    const proEnd = profile.pro_expires_at ? new Date(profile.pro_expires_at) : null;
    if (trialEnd && Date.now() > trialEnd.getTime() && !proEnd) {
      needDowngrade = true;
    } else if (proEnd && Date.now() > proEnd.getTime()) {
      needDowngrade = true;
    }
  }

  if (needDowngrade) {
    await pool.query(
      `UPDATE user_profiles SET plan = 'free', trial_ends_at = NULL, pro_expires_at = NULL, updated_at = NOW() WHERE user_id = $1`,
      [userId]
    );
    profile = (await pool.query(`SELECT * FROM user_profiles WHERE user_id = $1`, [userId])).rows[0];
  }

  const refCount = await getReferralCount(userId);
  return {
    user_id: profile.user_id,
    plan: profile.plan,
    referralCode: profile.referral_code || null,
    bonusMessages: Number(profile.bonus_messages) || 0,
    starsBalance: Number(profile.stars_balance) || 0,
    referralCount: refCount,
    referralProEndsAt: profile.referral_pro_ends_at || null,
    trialEndsAt: profile.trial_ends_at || null,
    proExpiresAt: profile.pro_expires_at || null,
    unlockedPersonas: [],
    favorites: [],
  };
}

async function getBalance(userId) {
  if (mode === "memory") {
    const profile = getMemoryProfile(userId);
    return profile.starsBalance ?? 0;
  }
  const r = await pool.query(
    `SELECT stars_balance FROM user_profiles WHERE user_id = $1`,
    [userId]
  );
  return r.rows[0] ? Number(r.rows[0].stars_balance) || 0 : 0;
}

async function deductBalance(userId, amount) {
  if (mode === "memory") {
    return withUserLock(userId, () => {
      const profile = getMemoryProfile(userId);
      const cur = profile.starsBalance ?? 0;
      if (cur < amount) return false;
      walAppend({ op: "deduct", userId, amount });
      profile.starsBalance = cur - amount;
      scheduleFlush();
      return true;
    });
  }
  const r = await pool.query(
    `UPDATE user_profiles SET stars_balance = stars_balance - $2, updated_at = NOW()
     WHERE user_id = $1 AND stars_balance >= $2 RETURNING user_id`,
    [userId, amount]
  );
  return r.rowCount > 0;
}

async function addBalance(userId, amount) {
  if (mode === "memory") {
    return withUserLock(userId, () => {
      const profile = getMemoryProfile(userId);
      walAppend({ op: "add", userId, amount });
      profile.starsBalance = (profile.starsBalance ?? 0) + amount;
      scheduleFlush();
    });
  }
  await ensureUserProfile(userId);
  await pool.query(
    `UPDATE user_profiles SET stars_balance = stars_balance + $2, updated_at = NOW() WHERE user_id = $1`,
    [userId, amount]
  );
}

async function setUserPlan(userId, plan, durationDays) {
  if (mode === "memory") {
    return withUserLock(userId, () => {
      const profile = getMemoryProfile(userId);
      profile.plan = plan;
      profile.trialEndsAt = null;
      if (plan === "pro" && durationDays) {
        const existing = profile.proExpiresAt ? new Date(profile.proExpiresAt).getTime() : 0;
        const base = Math.max(Date.now(), existing);
        profile.proExpiresAt = new Date(base + durationDays * 24 * 60 * 60 * 1000).toISOString();
      }
      walAppend({ op: "plan", userId, plan, proExpiresAt: profile.proExpiresAt || null });
      scheduleFlush();
      return { user_id: userId, plan };
    });
  }

  if (plan === "pro" && durationDays) {
    await pool.query(
      `INSERT INTO user_profiles (user_id, plan, trial_ends_at, pro_expires_at)
       VALUES ($1, 'pro', NULL, GREATEST(NOW(), COALESCE(
         (SELECT pro_expires_at FROM user_profiles WHERE user_id = $1), NOW()
       )) + ($2::integer * INTERVAL '1 day'))
       ON CONFLICT (user_id) DO UPDATE SET
         plan = 'pro',
         trial_ends_at = NULL,
         pro_expires_at = GREATEST(NOW(), COALESCE(user_profiles.pro_expires_at, NOW())) + ($2::integer * INTERVAL '1 day'),
         updated_at = NOW()`,
      [userId, durationDays]
    );
  } else {
    await pool.query(
      `INSERT INTO user_profiles (user_id, plan)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET
         plan = EXCLUDED.plan,
         updated_at = NOW()`,
      [userId, plan]
    );
  }

  const result = await pool.query(
    `SELECT user_id, plan FROM user_profiles WHERE user_id = $1 LIMIT 1`,
    [userId]
  );
  return result.rows[0];
}

async function getTodayUsageCount(userId) {
  if (mode === "memory") {
    return getMemoryUsageForToday(userId).count;
  }

  const result = await pool.query(
    `
      SELECT messages_count
      FROM daily_usage
      WHERE user_id = $1 AND usage_date = CURRENT_DATE
      LIMIT 1
    `,
    [userId]
  );
  return result.rows[0]?.messages_count || 0;
}

async function incrementTodayUsage(userId) {
  if (mode === "memory") {
    return withUserLock(userId, () => {
      const usage = getMemoryUsageForToday(userId);
      const next = usage.count + 1;
      memoryUsage.set(usage.key, next);
      markDirty();
      return next;
    });
  }

  await pool.query(
    `
      INSERT INTO daily_usage (user_id, usage_date, messages_count)
      VALUES ($1, CURRENT_DATE, 1)
      ON CONFLICT (user_id, usage_date)
      DO UPDATE SET messages_count = daily_usage.messages_count + 1
    `,
    [userId]
  );

  return getTodayUsageCount(userId);
}

async function decrementBonusMessage(userId) {
  if (mode === "memory") {
    return withUserLock(userId, () => {
      const profile = getMemoryProfile(userId);
      const bonus = profile.bonusMessages || 0;
      if (bonus <= 0) return false;
      profile.bonusMessages = bonus - 1;
      scheduleFlush();
      return true;
    });
  }
  const r = await pool.query(
    `UPDATE user_profiles SET bonus_messages = GREATEST(0, bonus_messages - 1), updated_at = NOW()
     WHERE user_id = $1 AND bonus_messages > 0 RETURNING user_id`,
    [userId]
  );
  return r.rowCount > 0;
}

async function updateStreak(userId) {
  const today = getTodayKey();

  if (mode === "memory") {
    return withUserLock(userId, () => {
      const streak = getMemoryStreak(userId);
      if (streak.lastActiveDate === today) {
        return { ...streak, bonus: null };
      }

      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayKey = yesterday.toISOString().slice(0, 10);

      if (streak.lastActiveDate === yesterdayKey) {
        streak.currentStreak += 1;
      } else {
        streak.currentStreak = 1;
      }

      streak.lastActiveDate = today;
      if (streak.currentStreak > streak.longestStreak) {
        streak.longestStreak = streak.currentStreak;
      }

      let bonus = null;
      if (streak.currentStreak === 7) {
        const profile = getMemoryProfile(userId);
        profile.bonusMessages = (profile.bonusMessages || 0) + 10;
        bonus = "+10 бонусных сообщений за 7-дневный стрик!";
      } else if (streak.currentStreak === 30) {
        const profile = getMemoryProfile(userId);
        profile.bonusMessages = (profile.bonusMessages || 0) + 30;
        bonus = "+30 бонусных сообщений за 30-дневный стрик!";
      }

      scheduleFlush();
      return { ...streak, bonus };
    });
  }

  const existing = await pool.query(
    `SELECT current_streak, last_active_date, longest_streak FROM user_streaks WHERE user_id = $1`,
    [userId]
  );

  let currentStreak = 1;
  let longestStreak = 1;

  if (existing.rows.length > 0) {
    const row = existing.rows[0];
    const lastDate = row.last_active_date;
    if (lastDate === today) {
      return { currentStreak: row.current_streak, lastActiveDate: today, longestStreak: row.longest_streak, bonus: null };
    }
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayKey = yesterday.toISOString().slice(0, 10);

    if (lastDate === yesterdayKey) {
      currentStreak = row.current_streak + 1;
    }
    longestStreak = Math.max(currentStreak, row.longest_streak);
  }

  await pool.query(
    `INSERT INTO user_streaks (user_id, current_streak, last_active_date, longest_streak)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id) DO UPDATE SET
       current_streak = EXCLUDED.current_streak,
       last_active_date = EXCLUDED.last_active_date,
       longest_streak = GREATEST(user_streaks.longest_streak, EXCLUDED.current_streak)`,
    [userId, currentStreak, today, longestStreak]
  );

  if (currentStreak === 7) {
    await pool.query(
      `UPDATE user_profiles SET bonus_messages = bonus_messages + 10, updated_at = NOW() WHERE user_id = $1`,
      [userId]
    );
  } else if (currentStreak === 30) {
    await pool.query(
      `UPDATE user_profiles SET bonus_messages = bonus_messages + 30, updated_at = NOW() WHERE user_id = $1`,
      [userId]
    );
  }

  return { currentStreak, lastActiveDate: today, longestStreak, bonus: currentStreak >= 7 ? 5 : currentStreak >= 3 ? 2 : 0 };
}

async function getStreak(userId) {
  if (mode === "memory") {
    return getMemoryStreak(userId);
  }

  const result = await pool.query(
    `SELECT current_streak, last_active_date, longest_streak FROM user_streaks WHERE user_id = $1`,
    [userId]
  );
  if (result.rows.length === 0) {
    return { currentStreak: 0, lastActiveDate: null, longestStreak: 0 };
  }
  const row = result.rows[0];
  return {
    currentStreak: row.current_streak,
    lastActiveDate: row.last_active_date,
    longestStreak: row.longest_streak,
  };
}

async function getReferralCount(userId) {
  if (mode === "memory") {
    let n = 0;
    for (const p of memoryProfiles.values()) {
      if (p.referredBy === userId) n++;
    }
    return n;
  }
  const r = await pool.query(
    `SELECT COUNT(*) AS c FROM user_profiles WHERE referred_by = $1`,
    [userId]
  );
  return parseInt(r.rows[0]?.c || "0", 10);
}

async function applyReferral(userId, referralCode) {
  if (mode === "memory") {
    return withUserLock(userId, () => {
      const profile = getMemoryProfile(userId);
      if (profile.referredBy) {
        return { ok: false, error: "Ты уже использовал реферальный код." };
      }
      if (profile.referralCode === referralCode) {
        return { ok: false, error: "Нельзя использовать свой собственный код." };
      }

      let referrerUserId = null;
      for (const [uid, p] of memoryProfiles.entries()) {
        if (p.referralCode === referralCode && uid !== userId) {
          referrerUserId = uid;
          break;
        }
      }
      if (!referrerUserId) {
        return { ok: false, error: "Код не найден." };
      }

      profile.referredBy = referrerUserId;
      profile.bonusMessages = (profile.bonusMessages || 0) + 5;
      const referrer = getMemoryProfile(referrerUserId);
      referrer.bonusMessages = (referrer.bonusMessages || 0) + 5;
      let refCount = 0;
      for (const p of memoryProfiles.values()) {
        if (p.referredBy === referrerUserId) refCount++;
      }
      if (refCount >= 3) {
        const existing = referrer.referralProEndsAt ? new Date(referrer.referralProEndsAt).getTime() : 0;
        const base = Math.max(Date.now(), existing);
        referrer.referralProEndsAt = new Date(base + 7 * 24 * 60 * 60 * 1000).toISOString();
      }
      scheduleFlush();
      return { ok: true, bonus: 5 };
    });
  }

  const result = await pool.query(
    `SELECT user_id, referral_code, referred_by FROM user_profiles WHERE user_id = $1`,
    [userId]
  );
  if (result.rows.length && result.rows[0].referred_by) {
    return { ok: false, error: "Ты уже использовал реферальный код." };
  }
  if (result.rows.length && result.rows[0].referral_code === referralCode) {
    return { ok: false, error: "Нельзя использовать свой собственный код." };
  }
  const referrer = await pool.query(
    `SELECT user_id FROM user_profiles WHERE referral_code = $1 AND user_id != $2`,
    [referralCode, userId]
  );
  if (referrer.rows.length === 0) {
    return { ok: false, error: "Код не найден." };
  }
  const referrerUserId = referrer.rows[0].user_id;
  await pool.query(
    `UPDATE user_profiles SET referred_by = $1, bonus_messages = bonus_messages + 5 WHERE user_id = $2`,
    [referrerUserId, userId]
  );
  await pool.query(
    `UPDATE user_profiles SET bonus_messages = bonus_messages + 5 WHERE user_id = $1`,
    [referrerUserId]
  );
  const refCount = await getReferralCount(referrerUserId);
  if (refCount >= 3) {
    await pool.query(
      `UPDATE user_profiles SET referral_pro_ends_at = GREATEST(NOW(), COALESCE(referral_pro_ends_at, '1970-01-01'::timestamptz)) + INTERVAL '7 days', updated_at = NOW() WHERE user_id = $1`,
      [referrerUserId]
    );
  }
  return { ok: true, bonus: 5 };
}

async function addFavorite(userId, personaId, content) {
  if (mode === "memory") {
    return withUserLock(userId, () => {
      const profile = getMemoryProfile(userId);
      if (!profile.favorites) profile.favorites = [];
      profile.favorites.push({ personaId, content, createdAt: new Date().toISOString() });
      if (profile.favorites.length > 50) profile.favorites.splice(0, profile.favorites.length - 50);
      markDirty();
    });
  }
  await pool.query(
    `INSERT INTO favorites (user_id, persona_id, content) VALUES ($1, $2, $3)`,
    [userId, personaId, content]
  );
}

async function getFavorites(userId, limit = 20) {
  if (mode === "memory") {
    const profile = getMemoryProfile(userId);
    return (profile.favorites || []).slice(-limit);
  }
  const result = await pool.query(
    `SELECT persona_id, content, created_at FROM favorites WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, limit]
  );
  return result.rows.reverse();
}

async function trackActivity(userId) {
  memoryLastActivity.set(userId, Date.now());
  if (mode === "memory") { markDirty(); }
  if (mode === "postgres") {
    await pool.query(
      `INSERT INTO user_activity (user_id, last_active_at)
       VALUES ($1, NOW())
       ON CONFLICT (user_id) DO UPDATE SET last_active_at = NOW()`,
      [userId]
    );
  }
}

async function getInactiveUsers(hoursThreshold = 24) {
  const cutoff = Date.now() - hoursThreshold * 60 * 60 * 1000;

  if (mode === "memory") {
    const result = [];
    for (const [userId, ts] of memoryLastActivity.entries()) {
      if (ts < cutoff && ts > cutoff - 48 * 60 * 60 * 1000) {
        result.push({ userId });
      }
    }
    return result;
  }

  const res = await pool.query(
    `SELECT user_id FROM user_activity
     WHERE last_active_at < NOW() - ($1::integer * INTERVAL '1 hour')
       AND last_active_at > NOW() - INTERVAL '48 hours'
     LIMIT 50`,
    [hoursThreshold]
  );
  return res.rows.map((r) => ({ userId: r.user_id }));
}

async function getChatHistory({ userId, personaId, limit = 30 }) {
  if (mode === "memory") {
    return getMemoryMessages(userId)
      .filter((msg) => msg.personaId === personaId)
      .slice(-limit)
      .map((msg) => ({ role: msg.role, content: msg.content, createdAt: msg.createdAt }));
  }

  const result = await pool.query(
    `SELECT role, content, created_at
     FROM chat_messages
     WHERE user_id = $1 AND persona_id = $2
     ORDER BY created_at DESC
     LIMIT $3`,
    [userId, personaId, limit]
  );
  return result.rows.reverse().map((r) => ({
    role: r.role,
    content: r.content,
    createdAt: r.created_at,
  }));
}

async function saveCustomPersona(userId, persona) {
  if (mode === "memory") {
    if (!memoryCustomPersonas.has(userId)) memoryCustomPersonas.set(userId, []);
    const list = memoryCustomPersonas.get(userId);
    const idx = list.findIndex((p) => p.id === persona.id);
    if (idx >= 0) list[idx] = persona;
    else list.push(persona);
    markDirty(); scheduleFlush();
    return persona;
  }
  await pool.query(
    `INSERT INTO custom_personas (id, user_id, name, data)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, id) DO UPDATE SET name = EXCLUDED.name, data = EXCLUDED.data`,
    [persona.id, userId, persona.name, JSON.stringify(persona)]
  );
  return persona;
}

async function getCustomPersonas(userId) {
  if (mode === "memory") return memoryCustomPersonas.get(userId) || [];
  const result = await pool.query(
    `SELECT data FROM custom_personas WHERE user_id = $1 ORDER BY created_at`,
    [userId]
  );
  return result.rows.map((r) => (typeof r.data === "string" ? JSON.parse(r.data) : r.data));
}

async function getCustomPersona(userId, personaId) {
  if (mode === "memory") {
    const list = memoryCustomPersonas.get(userId) || [];
    return list.find((p) => p.id === personaId) || null;
  }
  const result = await pool.query(
    `SELECT data FROM custom_personas WHERE user_id = $1 AND id = $2`,
    [userId, personaId]
  );
  if (result.rows.length === 0) return null;
  const d = result.rows[0].data;
  return typeof d === "string" ? JSON.parse(d) : d;
}

async function deleteCustomPersona(userId, personaId) {
  if (mode === "memory") {
    return withUserLock(userId, () => {
      const list = memoryCustomPersonas.get(userId) || [];
      const idx = list.findIndex((p) => p.id === personaId);
      if (idx >= 0) list.splice(idx, 1);
      markDirty();
    });
  }
  await pool.query(
    `DELETE FROM custom_personas WHERE user_id = $1 AND id = $2`,
    [userId, personaId]
  );
}

/* ── Affection System ── */

const AFFECTION_LEVELS = [
  { level: 1, xp: 0,    label: "Незнакомка" },
  { level: 2, xp: 50,   label: "Знакомая" },
  { level: 3, xp: 150,  label: "Подруга" },
  { level: 4, xp: 300,  label: "Близкая" },
  { level: 5, xp: 500,  label: "Влюблена" },
  { level: 6, xp: 700,  label: "Пара" },
  { level: 7, xp: 1000, label: "Родная" },
];

const GIFTS = [
  { id: "rose",      name: "Роза",              emoji: "🌹", stars: 5,   xp: 10  },
  { id: "chocolate", name: "Шоколад",           emoji: "🍫", stars: 10,  xp: 15  },
  { id: "teddy",     name: "Плюшевый мишка",    emoji: "🧸", stars: 25,  xp: 30  },
  { id: "perfume",   name: "Парфюм",            emoji: "🌸", stars: 50,  xp: 50  },
  { id: "dinner",    name: "Ужин в ресторане",   emoji: "🍷", stars: 100, xp: 80  },
  { id: "ring",      name: "Кольцо",            emoji: "💍", stars: 200, xp: 150 },
];

const DATE_SCENARIOS = [
  { id: "park",       title: "Прогулка в парке",     premium: false, emoji: "🌳" },
  { id: "cinema",     title: "Кинотеатр",            premium: false, emoji: "🎬" },
  { id: "home",       title: "Домашний вечер",       premium: false, emoji: "🏠" },
  { id: "beach",      title: "Пляж ночью",           premium: true,  emoji: "🏖️" },
  { id: "rooftop",    title: "Крыша небоскрёба",     premium: true,  emoji: "🌃" },
  { id: "roadtrip",   title: "Поездка за город",     premium: true,  emoji: "🚗" },
];

function getGifts() { return GIFTS; }
function getDateScenarios() { return DATE_SCENARIOS; }
function getAffectionLevels() { return AFFECTION_LEVELS; }

function calcLevel(xp) {
  let lvl = AFFECTION_LEVELS[0];
  for (const l of AFFECTION_LEVELS) {
    if (xp >= l.xp) lvl = l;
  }
  const nextIdx = AFFECTION_LEVELS.indexOf(lvl) + 1;
  const next = AFFECTION_LEVELS[nextIdx] || null;
  return { level: lvl.level, label: lvl.label, xp, xpForNext: next ? next.xp : lvl.xp, maxLevel: !next };
}

function affKey(userId, personaId) { return `${userId}:${personaId}`; }

function getMemoryAffection(userId, personaId) {
  const k = affKey(userId, personaId);
  if (!memoryAffection.has(k)) {
    memoryAffection.set(k, { xp: 0, gifts: [], lastChatPersona: null });
  }
  return memoryAffection.get(k);
}

async function getAffection(userId, personaId) {
  if (mode === "memory") {
    const a = getMemoryAffection(userId, personaId);
    return calcLevel(a.xp);
  }
  const r = await pool.query(
    `SELECT xp FROM user_affection WHERE user_id=$1 AND persona_id=$2`, [userId, personaId]
  );
  return calcLevel(r.rows[0]?.xp || 0);
}

async function addAffectionXp(userId, personaId, amount) {
  if (mode === "memory") {
    return withUserLock(userId, () => {
      const a = getMemoryAffection(userId, personaId);
      a.xp = Math.max(0, a.xp + amount);
      markDirty();
      return calcLevel(a.xp);
    });
  }
  await pool.query(
    `INSERT INTO user_affection (user_id, persona_id, xp)
     VALUES ($1, $2, GREATEST(0,$3))
     ON CONFLICT (user_id, persona_id) DO UPDATE SET xp = GREATEST(0, user_affection.xp + $3)`,
    [userId, personaId, amount]
  );
  return getAffection(userId, personaId);
}

async function getAllAffections(userId) {
  if (mode === "memory") {
    const result = {};
    for (const [k, v] of memoryAffection.entries()) {
      if (k.startsWith(userId + ":")) {
        const pid = k.slice(userId.length + 1);
        result[pid] = calcLevel(v.xp);
      }
    }
    return result;
  }
  const r = await pool.query(
    `SELECT persona_id, xp FROM user_affection WHERE user_id=$1`, [userId]
  );
  const result = {};
  for (const row of r.rows) result[row.persona_id] = calcLevel(row.xp);
  return result;
}

async function recordGift(userId, personaId, giftId) {
  if (mode === "memory") {
    return withUserLock(userId, () => {
      const a = getMemoryAffection(userId, personaId);
      a.gifts.push({ giftId, at: Date.now() });
      markDirty();
    });
  }
  await pool.query(
    `INSERT INTO gift_history (user_id, persona_id, gift_id) VALUES ($1,$2,$3)`,
    [userId, personaId, giftId]
  );
}

/** Last gift per user-persona for chat context */
async function getLastGift(userId, personaId) {
  const giftList = getGifts();
  if (mode === "memory") {
    const a = getMemoryAffection(userId, personaId);
    const last = a.gifts && a.gifts.length ? a.gifts[a.gifts.length - 1] : null;
    if (!last) return null;
    const g = giftList.find((x) => x.id === last.giftId);
    return g ? { giftId: g.id, giftName: g.name, emoji: g.emoji } : null;
  }
  const r = await pool.query(
    `SELECT gift_id FROM gift_history WHERE user_id = $1 AND persona_id = $2 ORDER BY created_at DESC LIMIT 1`,
    [userId, personaId]
  );
  if (!r.rows[0]) return null;
  const g = giftList.find((x) => x.id === r.rows[0].gift_id);
  return g ? { giftId: g.id, giftName: g.name, emoji: g.emoji } : null;
}

const memoryLastDateScenario = registerStore("lastDateScenario", new Map());
function lastDateKey(userId, personaId) { return `lastDate:${userId}:${personaId}`; }
async function setLastDateScenario(userId, personaId, scenarioId, scenarioTitle) {
  memoryLastDateScenario.set(lastDateKey(userId, personaId), { scenarioId, scenarioTitle });
  markDirty();
}
async function getLastDateScenario(userId, personaId) {
  return memoryLastDateScenario.get(lastDateKey(userId, personaId)) || null;
}

/* ── 7-day challenge ── */
const memoryChallenge = registerStore("challenge", new Map());
const CHALLENGE_BONUS_MESSAGES = 20;

async function getChallenge(userId) {
  if (mode === "memory") {
    const c = memoryChallenge.get(userId);
    if (!c) return null;
    return {
      personaId: c.personaId,
      streakDays: c.streakDays || 0,
      lastDate: c.lastDate || null,
      completedAt: c.completedAt || null,
    };
  }
  const r = await pool.query(
    `SELECT persona_id, streak_days, last_date, completed_at FROM user_challenge WHERE user_id = $1`,
    [userId]
  );
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  return {
    personaId: row.persona_id,
    streakDays: row.streak_days || 0,
    lastDate: row.last_date || null,
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
  };
}

async function startChallenge(userId, personaId) {
  const today = getTodayKey();
  if (mode === "memory") {
    return withUserLock(userId, () => {
      memoryChallenge.set(userId, {
        personaId,
        streakDays: 1,
        lastDate: today,
        completedAt: null,
      });
      markDirty();
      return { personaId, streakDays: 1, lastDate: today, completedAt: null };
    });
  }
  await pool.query(
    `INSERT INTO user_challenge (user_id, persona_id, streak_days, last_date)
     VALUES ($1, $2, 1, $3)
     ON CONFLICT (user_id) DO UPDATE SET persona_id = EXCLUDED.persona_id, streak_days = 1, last_date = EXCLUDED.last_date, completed_at = NULL`,
    [userId, personaId, today]
  );
  return { personaId, streakDays: 1, lastDate: today, completedAt: null };
}

/** Вызывать после отправки сообщения персонажу. Возвращает { updated, completed, bonus } если челлендж обновлён или завершён. */
async function updateChallengeStreak(userId, personaId) {
  const today = getTodayKey();
  const ch = await getChallenge(userId);
  if (!ch || ch.completedAt || ch.personaId !== personaId) return null;

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayKey = yesterday.toISOString().slice(0, 10);

  let newStreak = ch.streakDays;
  if (ch.lastDate === today) return null;
  if (ch.lastDate === yesterdayKey) {
    newStreak = ch.streakDays + 1;
  } else {
    newStreak = 1;
  }

  if (mode === "memory") {
    return withUserLock(userId, () => {
      const c = memoryChallenge.get(userId);
      if (!c) return null;
      c.streakDays = newStreak;
      c.lastDate = today;
      if (newStreak >= 7) {
        c.completedAt = new Date().toISOString();
        const profile = getMemoryProfile(userId);
        profile.bonusMessages = (profile.bonusMessages || 0) + CHALLENGE_BONUS_MESSAGES;
        scheduleFlush();
        return { updated: true, completed: true, streakDays: 7, bonus: CHALLENGE_BONUS_MESSAGES };
      }
      markDirty();
      return { updated: true, completed: false, streakDays: newStreak };
    });
  }

  if (newStreak >= 7) {
    await pool.query(
      `UPDATE user_challenge SET streak_days = 7, last_date = $2, completed_at = NOW() WHERE user_id = $1`,
      [userId, today]
    );
    await pool.query(
      `UPDATE user_profiles SET bonus_messages = bonus_messages + $2, updated_at = NOW() WHERE user_id = $1`,
      [userId, CHALLENGE_BONUS_MESSAGES]
    );
    return { updated: true, completed: true, streakDays: 7, bonus: CHALLENGE_BONUS_MESSAGES };
  }

  await pool.query(
    `UPDATE user_challenge SET streak_days = $2, last_date = $3 WHERE user_id = $1`,
    [userId, newStreak, today]
  );
  return { updated: true, completed: false, streakDays: newStreak };
}

/* ── Last chat persona tracking (for jealousy) ── */
const memoryLastChatPersona = registerStore("lastChatPersona", new Map());

async function setLastChatPersona(userId, personaId) {
  memoryLastChatPersona.set(userId, { personaId, at: Date.now() });
  if (mode === "memory") { markDirty(); }
  if (mode === "postgres") {
    await pool.query(
      `INSERT INTO last_chat_persona (user_id, persona_id, at) VALUES ($1, $2, NOW())
       ON CONFLICT (user_id) DO UPDATE SET persona_id = EXCLUDED.persona_id, at = NOW()`,
      [userId, personaId]
    );
  }
}

async function getLastChatPersona(userId) {
  if (mode === "memory") return memoryLastChatPersona.get(userId) || null;
  const r = await pool.query(
    `SELECT persona_id, at FROM last_chat_persona WHERE user_id = $1`,
    [userId]
  );
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  return { personaId: row.persona_id, at: new Date(row.at).getTime() };
}

/* ── Dating game state ── */

function dateKey(userId) { return `date:${userId}`; }

async function getActiveDate(userId) {
  if (mode === "memory") return memoryDates.get(dateKey(userId)) || null;
  const r = await pool.query(`SELECT data FROM active_dates WHERE user_id = $1`, [userId]);
  if (r.rows.length === 0) return null;
  const data = r.rows[0].data;
  return typeof data === "string" ? JSON.parse(data) : data;
}

async function setActiveDate(userId, dateState) {
  if (mode === "memory") {
    memoryDates.set(dateKey(userId), dateState);
    markDirty(); scheduleFlush();
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
    markDirty(); scheduleFlush();
    return;
  }
  await pool.query(`DELETE FROM active_dates WHERE user_id = $1`, [userId]);
}

/* ── Achievements ── */
const memoryAchievements = registerStore("achievements", new Map());

const ACHIEVEMENTS = [
  { id: "first_msg", title: "Первое слово", desc: "Отправь первое сообщение", icon: "💬", cat: "chat" },
  { id: "msg_100", title: "Болтун", desc: "Отправь 100 сообщений", icon: "🗣️", cat: "chat" },
  { id: "msg_500", title: "Неумолкаемый", desc: "Отправь 500 сообщений", icon: "📢", cat: "chat" },
  { id: "msg_1000", title: "Легенда чата", desc: "Отправь 1000 сообщений", icon: "👑", cat: "chat" },
  { id: "first_gift", title: "Первый подарок", desc: "Подари первый подарок", icon: "🎁", cat: "rel" },
  { id: "gift_10", title: "Щедрая душа", desc: "Подари 10 подарков", icon: "💝", cat: "rel" },
  { id: "gift_ring", title: "Предложение", desc: "Подари кольцо", icon: "💍", cat: "rel" },
  { id: "level3", title: "Подруга", desc: "Достигни уровня 3 с кем-то", icon: "🤝", cat: "rel" },
  { id: "level5", title: "Влюблена", desc: "Достигни уровня 5 с кем-то", icon: "💕", cat: "rel" },
  { id: "level7", title: "Родная душа", desc: "Достигни максимального уровня", icon: "❤️‍🔥", cat: "rel" },
  { id: "all_level2", title: "Знакомство со всеми", desc: "Уровень 2+ со всеми девушками", icon: "👯", cat: "rel" },
  { id: "streak_7", title: "Неделя верности", desc: "7 дней подряд в приложении", icon: "🔥", cat: "streak" },
  { id: "streak_30", title: "Месяц преданности", desc: "30 дней подряд в приложении", icon: "⚡", cat: "streak" },
  { id: "custom_girl", title: "Создатель", desc: "Создай свою девушку", icon: "🎨", cat: "special" },
  { id: "diary_full", title: "Хранитель тайн", desc: "Прочитай весь дневник одной девушки", icon: "📖", cat: "special" },
  { id: "top3", title: "Топ-3", desc: "Попади в тройку лидеров", icon: "🥇", cat: "leader" },
];

function getAchievementsList() { return ACHIEVEMENTS; }

async function getAchievements(userId) {
  if (mode === "memory") return memoryAchievements.get(userId) || [];
  if (mode === "postgres") {
    try {
      const r = await pool.query(`SELECT achievement_id FROM user_achievements WHERE user_id = $1`, [userId]);
      return r.rows.map(row => row.achievement_id);
    } catch { return []; }
  }
  return memoryAchievements.get(userId) || [];
}

async function unlockAchievement(userId, achievementId) {
  if (mode === "postgres") {
    try {
      const r = await pool.query(
        `INSERT INTO user_achievements (user_id, achievement_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING *`,
        [userId, achievementId]
      );
      return r.rows.length > 0;
    } catch { return false; }
  }
  return withUserLock(userId, () => {
    if (!memoryAchievements.has(userId)) memoryAchievements.set(userId, []);
    const list = memoryAchievements.get(userId);
    if (list.includes(achievementId)) return false;
    list.push(achievementId);
    markDirty();
    return true;
  });
}

/* ── Notification settings ── */
const memoryNotifSettings = registerStore("notifSettings", new Map());

async function getNotifSettings(userId) {
  if (mode === "postgres") {
    try {
      const r = await pool.query(`SELECT enabled, persona_id FROM notification_settings WHERE user_id = $1`, [userId]);
      if (r.rows.length === 0) return { enabled: false, personaId: null, lastMorningSent: null, lastEveningSent: null };
      const row = r.rows[0];
      return { enabled: row.enabled, personaId: row.persona_id, lastMorningSent: null, lastEveningSent: null };
    } catch { return { enabled: false, personaId: null, lastMorningSent: null, lastEveningSent: null }; }
  }
  return memoryNotifSettings.get(userId) || { enabled: false, personaId: null, lastMorningSent: null, lastEveningSent: null };
}

async function setNotifSettings(userId, settings) {
  if (mode === "memory") {
    return withUserLock(userId, async () => {
      const current = await getNotifSettings(userId);
      const merged = { ...current, ...settings };
      memoryNotifSettings.set(userId, merged);
      markDirty();
    });
  }
  const current = await getNotifSettings(userId);
  const merged = { ...current, ...settings };
  memoryNotifSettings.set(userId, merged);
  try {
    await pool.query(
      `INSERT INTO notification_settings (user_id, enabled, persona_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE SET enabled = $2, persona_id = $3`,
      [userId, merged.enabled, merged.personaId || null]
    );
  } catch (e) { log.error({ err: e }, "setNotifSettings pg error"); }
}

async function getAllNotifUsers() {
  if (mode === "memory") {
    const result = [];
    for (const [userId, s] of memoryNotifSettings.entries()) {
      if (s.enabled && s.personaId) result.push({ userId, ...s });
    }
    return result;
  }

  try {
    const { rows } = await pool.query(
      `SELECT user_id, enabled, persona_id FROM notification_settings WHERE enabled = true AND persona_id IS NOT NULL`
    );
    return rows.map(r => ({
      userId: r.user_id,
      enabled: r.enabled,
      personaId: r.persona_id,
    }));
  } catch (e) {
    log.error({ err: e }, "getAllNotifUsers pg error");
    return [];
  }
}

/* ── Game stats (for achievements) ── */
const memoryGameStats = registerStore("gameStats", new Map());

const GAME_STAT_COLUMNS = { totalGames: "total_games", dates: "dates", giftCount: "gift_count", msgCount: "msg_count" };

async function getGameStats(userId) {
  if (mode === "memory") {
    return memoryGameStats.get(userId) || { totalGames: 0, dates: 0, giftCount: 0, msgCount: 0 };
  }
  try {
    const { rows } = await pool.query(`SELECT total_games, dates, gift_count, msg_count FROM game_stats WHERE user_id = $1`, [userId]);
    if (rows.length === 0) return { totalGames: 0, dates: 0, giftCount: 0, msgCount: 0 };
    const r = rows[0];
    return { totalGames: r.total_games, dates: r.dates, giftCount: r.gift_count, msgCount: r.msg_count };
  } catch (e) {
    log.error({ err: e }, "getGameStats pg error");
    return { totalGames: 0, dates: 0, giftCount: 0, msgCount: 0 };
  }
}

async function incrementGameStat(userId, field, amount = 1) {
  if (mode === "memory") {
    return withUserLock(userId, () => {
      const key = userId;
      const stats = memoryGameStats.get(key) || { totalGames: 0, dates: 0, giftCount: 0, msgCount: 0 };
      stats[field] = (stats[field] || 0) + amount;
      memoryGameStats.set(key, stats);
      markDirty();
      return stats;
    });
  }
  const col = GAME_STAT_COLUMNS[field];
  if (!col) throw new Error(`Unknown game stat field: ${field}`);
  try {
    await pool.query(
      `INSERT INTO game_stats (user_id, ${col}) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET ${col} = game_stats.${col} + $2`,
      [userId, amount]
    );
  } catch (e) {
    log.error({ err: e }, "incrementGameStat pg error");
  }
  return getGameStats(userId);
}

/* ── Leaderboard ── */
async function getLeaderboard(limit = 10) {
  if (mode === "postgres") {
    try {
      const result = await pool.query(
        `SELECT user_id, SUM(xp) as total_xp
         FROM user_affection GROUP BY user_id ORDER BY total_xp DESC LIMIT $1`,
        [limit]
      );
      return result.rows.map((r, i) => ({ rank: i + 1, userId: r.user_id, totalXp: parseInt(r.total_xp) || 0 }));
    } catch { return []; }
  }
  const userTotals = new Map();
  for (const [k, v] of memoryAffection.entries()) {
    const userId = k.split(":")[0];
    const cur = userTotals.get(userId) || 0;
    userTotals.set(userId, cur + v.xp);
  }
  const sorted = [...userTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
  return sorted.map(([userId, totalXp], idx) => ({
    rank: idx + 1,
    userId,
    totalXp,
  }));
}

/* ── Fantasy Module Storage ── */

const FANTASY_PREMIUM_PLUS_DAYS = 30;
const FANTASY_MAX_PERSONAS = 5;

async function saveFantasyPersona(userId, persona) {
  if (mode === "memory") {
    if (!memoryFantasyPersonas.has(userId)) memoryFantasyPersonas.set(userId, []);
    const list = memoryFantasyPersonas.get(userId);
    if (list.length >= FANTASY_MAX_PERSONAS && !list.find((p) => p.id === persona.id)) {
      throw new Error(`Максимум ${FANTASY_MAX_PERSONAS} персонажей.`);
    }
    const idx = list.findIndex((p) => p.id === persona.id);
    if (idx >= 0) list[idx] = persona;
    else list.push(persona);
    markDirty(); scheduleFlush();
    return persona;
  }
  const existing = await pool.query(
    `SELECT COUNT(*) AS c FROM fantasy_personas WHERE user_id = $1`,
    [userId]
  );
  if (parseInt(existing.rows[0].c) >= FANTASY_MAX_PERSONAS) {
    const hasThis = await pool.query(
      `SELECT id FROM fantasy_personas WHERE user_id = $1 AND id = $2`,
      [userId, persona.id]
    );
    if (hasThis.rows.length === 0) throw new Error(`Максимум ${FANTASY_MAX_PERSONAS} персонажей.`);
  }
  await pool.query(
    `INSERT INTO fantasy_personas (id, user_id, scenario_id, data)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, id) DO UPDATE SET scenario_id = EXCLUDED.scenario_id, data = EXCLUDED.data`,
    [persona.id, userId, persona.scenarioId || "", JSON.stringify(persona)]
  );
  return persona;
}

async function getFantasyPersonas(userId) {
  if (mode === "memory") return memoryFantasyPersonas.get(userId) || [];
  const result = await pool.query(
    `SELECT data FROM fantasy_personas WHERE user_id = $1 ORDER BY created_at`,
    [userId]
  );
  return result.rows.map((r) => (typeof r.data === "string" ? JSON.parse(r.data) : r.data));
}

async function getFantasyPersona(userId, personaId) {
  if (mode === "memory") {
    const list = memoryFantasyPersonas.get(userId) || [];
    return list.find((p) => p.id === personaId) || null;
  }
  const result = await pool.query(
    `SELECT data FROM fantasy_personas WHERE user_id = $1 AND id = $2`,
    [userId, personaId]
  );
  if (result.rows.length === 0) return null;
  const d = result.rows[0].data;
  return typeof d === "string" ? JSON.parse(d) : d;
}

async function deleteFantasyPersona(userId, personaId) {
  if (mode === "memory") {
    const list = memoryFantasyPersonas.get(userId) || [];
    const idx = list.findIndex((p) => p.id === personaId);
    if (idx >= 0) { list.splice(idx, 1); markDirty(); scheduleFlush(); }
    return;
  }
  await pool.query(
    `DELETE FROM fantasy_personas WHERE user_id = $1 AND id = $2`,
    [userId, personaId]
  );
}

async function hasFantasyAccess(userId) {
  if (mode === "memory") {
    const access = memoryFantasyAccess.get(userId);
    if (!access) return false;
    if (access.expiresAt && new Date(access.expiresAt) < new Date()) return false;
    return true;
  }
  try {
    const r = await pool.query(`SELECT expires_at FROM fantasy_access WHERE user_id = $1`, [userId]);
    if (r.rows.length === 0) return false;
    const expiresAt = r.rows[0].expires_at;
    if (expiresAt && new Date(expiresAt) < new Date()) return false;
    return true;
  } catch { return false; }
}

async function grantFantasyAccess(userId, days) {
  const d = days || FANTASY_PREMIUM_PLUS_DAYS;
  if (mode === "memory") {
    return withUserLock(userId, () => {
      const existing = memoryFantasyAccess.get(userId);
      const base = existing && new Date(existing.expiresAt).getTime() > Date.now()
        ? new Date(existing.expiresAt).getTime()
        : Date.now();
      const expiresAt = new Date(base + d * 24 * 60 * 60 * 1000).toISOString();
      walAppend({ op: "fantasy_access", userId, expiresAt });
      memoryFantasyAccess.set(userId, { grantedAt: new Date().toISOString(), expiresAt });
      scheduleFlush();
      return { expiresAt };
    });
  }
  await pool.query(
    `INSERT INTO fantasy_access (user_id, granted_at, expires_at)
     VALUES ($1, NOW(), GREATEST(NOW(), COALESCE((SELECT expires_at FROM fantasy_access WHERE user_id = $1), NOW())) + ($2::integer * INTERVAL '1 day'))
     ON CONFLICT (user_id) DO UPDATE SET
       granted_at = NOW(),
       expires_at = GREATEST(NOW(), fantasy_access.expires_at) + ($2::integer * INTERVAL '1 day')`,
    [userId, d]
  );
  const r = await pool.query(`SELECT expires_at FROM fantasy_access WHERE user_id = $1`, [userId]);
  return { expiresAt: r.rows[0]?.expires_at };
}

async function getAllFantasyAccess() {
  if (mode === "memory") {
    const result = {};
    for (const [userId, access] of memoryFantasyAccess.entries()) {
      if (access && access.expiresAt) result[userId] = access;
    }
    return result;
  }
  try {
    const r = await pool.query(`SELECT user_id, granted_at, expires_at FROM fantasy_access`);
    const result = {};
    for (const row of r.rows) {
      result[row.user_id] = { grantedAt: row.granted_at, expiresAt: row.expires_at };
    }
    return result;
  } catch (e) {
    log.error({ err: e }, "getAllFantasyAccess error");
    return {};
  }
}

async function getFantasyStoryState(userId) {
  if (mode === "memory") return memoryFantasyStoryState.get(userId) || null;
  const r = await pool.query(`SELECT data FROM fantasy_story_state WHERE user_id = $1`, [userId]);
  if (r.rows.length === 0) return null;
  return typeof r.rows[0].data === "string" ? JSON.parse(r.rows[0].data) : r.rows[0].data;
}

async function setFantasyStoryState(userId, state) {
  if (mode === "memory") {
    if (state === null) memoryFantasyStoryState.delete(userId);
    else memoryFantasyStoryState.set(userId, state);
    markDirty(); scheduleFlush();
    return;
  }
  if (state === null) {
    await pool.query(`DELETE FROM fantasy_story_state WHERE user_id = $1`, [userId]);
  } else {
    await pool.query(
      `INSERT INTO fantasy_story_state (user_id, data, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [userId, JSON.stringify(state)]
    );
  }
}

/* ── Girl Mood System ── */

const GIRL_MOODS = {
  happy:     { id: "happy",     label: "Счастливая",   emoji: "😊", color: "#34d399", glow: "rgba(52,211,153,.3)" },
  flirty:    { id: "flirty",    label: "Игривая",      emoji: "😏", color: "#f472b6", glow: "rgba(244,114,182,.3)" },
  tender:    { id: "tender",    label: "Нежная",       emoji: "🥰", color: "#fb7185", glow: "rgba(251,113,133,.3)" },
  excited:   { id: "excited",   label: "В восторге",   emoji: "🤩", color: "#fbbf24", glow: "rgba(251,191,36,.3)" },
  calm:      { id: "calm",      label: "Спокойная",    emoji: "😌", color: "#7c5cff", glow: "rgba(124,92,255,.3)" },
  sad:       { id: "sad",       label: "Грустная",     emoji: "😢", color: "#60a5fa", glow: "rgba(96,165,250,.3)" },
  jealous:   { id: "jealous",   label: "Ревнует",      emoji: "😤", color: "#f87171", glow: "rgba(248,113,113,.3)" },
  offended:  { id: "offended",  label: "Обиделась",    emoji: "😒", color: "#94a3b8", glow: "rgba(148,163,184,.3)" },
  bored:     { id: "bored",     label: "Скучает",      emoji: "🥱", color: "#a78bfa", glow: "rgba(167,139,250,.3)" },
  loving:    { id: "loving",    label: "Влюблена",     emoji: "💕", color: "#ec4899", glow: "rgba(236,72,153,.3)" },
  curious:   { id: "curious",   label: "Заинтересована", emoji: "🤔", color: "#22d3ee", glow: "rgba(34,211,238,.3)" },
  shy:       { id: "shy",       label: "Стесняется",   emoji: "🙈", color: "#fca5a5", glow: "rgba(252,165,165,.3)" },
  angry:     { id: "angry",     label: "Злится",       emoji: "😡", color: "#ef4444", glow: "rgba(239,68,68,.3)" },
  miss:      { id: "miss",      label: "Скучает по тебе", emoji: "💭", color: "#c084fc", glow: "rgba(192,132,252,.3)" },
  neutral:   { id: "neutral",   label: "Обычное",      emoji: "😊", color: "#7c5cff", glow: "rgba(124,92,255,.2)" },
};

function getGirlMoods() { return GIRL_MOODS; }

function girlMoodKey(userId, personaId) { return `${userId}:${personaId}`; }

function getDefaultGirlMood() {
  return {
    current: "neutral",
    intensity: 50,
    history: [],
    lastUpdate: Date.now(),
    decayRate: 5,
  };
}

async function getGirlMood(userId, personaId) {
  const k = girlMoodKey(userId, personaId);
  if (mode === "memory") {
    if (!memoryGirlMood.has(k)) memoryGirlMood.set(k, getDefaultGirlMood());
    const m = memoryGirlMood.get(k);
    return applyMoodDecay(m);
  }
  if (mode === "postgres") {
    try {
      const r = await pool.query(`SELECT * FROM girl_mood WHERE user_id = $1 AND persona_id = $2`, [userId, personaId]);
      if (r.rows.length === 0) return getDefaultGirlMood();
      const row = r.rows[0];
      const moodState = { current: row.current, intensity: row.intensity, decayRate: row.decay_rate, reason: row.reason || "", lastUpdate: parseInt(row.last_update) || Date.now(), history: row.history || [] };
      return applyMoodDecay(moodState);
    } catch { return getDefaultGirlMood(); }
  }
  return getDefaultGirlMood();
}

function applyMoodDecay(moodState) {
  const now = Date.now();
  const hoursSinceUpdate = (now - moodState.lastUpdate) / (1000 * 60 * 60);
  if (hoursSinceUpdate > 2 && moodState.current !== "neutral") {
    const decaySteps = Math.floor(hoursSinceUpdate / 2);
    moodState.intensity = Math.max(20, moodState.intensity - decaySteps * moodState.decayRate);
    if (moodState.intensity <= 20) {
      if (hoursSinceUpdate > 12) {
        moodState.current = "miss";
        moodState.intensity = Math.min(80, 30 + Math.floor(hoursSinceUpdate));
      } else {
        moodState.current = "neutral";
        moodState.intensity = 50;
      }
    }
    moodState.lastUpdate = now;
  }
  return moodState;
}

async function setGirlMood(userId, personaId, moodId, intensity, reason) {
  const k = girlMoodKey(userId, personaId);
  const current = await getGirlMood(userId, personaId);
  const historyEntry = {
    from: current.current,
    to: moodId,
    intensity,
    reason: reason || "",
    at: Date.now(),
  };
  current.history.push(historyEntry);
  if (current.history.length > 30) current.history.splice(0, current.history.length - 30);
  current.current = moodId;
  current.intensity = Math.min(100, Math.max(0, intensity));
  current.lastUpdate = Date.now();
  if (mode === "memory") {
    memoryGirlMood.set(k, current);
    markDirty(); scheduleFlush();
  }
  if (mode === "postgres") {
    try {
      await pool.query(
        `INSERT INTO girl_mood (user_id, persona_id, current, intensity, decay_rate, reason, last_update, history)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (user_id, persona_id) DO UPDATE SET current=$3, intensity=$4, decay_rate=$5, reason=$6, last_update=$7, history=$8`,
        [userId, personaId, current.current, current.intensity, current.decayRate || 5, reason || "", Date.now(), JSON.stringify(current.history.slice(-10))]
      );
    } catch (e) { log.error({ err: e }, "setGirlMood pg error"); }
  }
  await addTimelineEvent(userId, personaId, "mood_change", {
    mood: moodId,
    label: GIRL_MOODS[moodId]?.label || moodId,
    emoji: GIRL_MOODS[moodId]?.emoji || "😊",
    reason,
  });
  return current;
}

function getGirlMoodPrompt(moodState) {
  const m = GIRL_MOODS[moodState.current];
  if (!m || moodState.current === "neutral") return "";
  const intensityWord = moodState.intensity > 75 ? "очень сильно" : moodState.intensity > 50 ? "заметно" : "слегка";
  const prompts = {
    happy: `Ты сейчас ${intensityWord} счастлива и в приподнятом настроении. Улыбаешься, смеёшься, заряжаешь позитивом.`,
    flirty: `Ты сейчас ${intensityWord} в игривом настроении. Кокетничаешь, подкалываешь, намекаешь.`,
    tender: `Ты сейчас ${intensityWord} настроена нежно. Говоришь ласково, хочешь обнять, нежишься.`,
    excited: `Ты сейчас ${intensityWord} в восторге! Тебя переполняют эмоции, ты делишься радостью.`,
    calm: `Ты сейчас ${intensityWord} спокойна и умиротворена. Говоришь размеренно, вдумчиво.`,
    sad: `Ты сейчас ${intensityWord} грустная. Тебе хочется утешения, тёплых слов. Можешь вздыхать.`,
    jealous: `Ты сейчас ${intensityWord} ревнуешь. Задаёшь провокационные вопросы, хочешь внимания только к себе.`,
    offended: `Ты сейчас ${intensityWord} обижена. Отвечаешь коротко, сухо, показываешь что тебе неприятно.`,
    bored: `Ты сейчас ${intensityWord} скучаешь. Хочешь чего-то интересного, необычного, зевая от банальностей.`,
    loving: `Ты сейчас ${intensityWord} влюблена. Каждое его слово — радость. Ты светишься, говоришь трогательные вещи.`,
    curious: `Ты сейчас ${intensityWord} заинтересована. Задаёшь вопросы, хочешь узнать больше, тебе любопытно.`,
    shy: `Ты сейчас ${intensityWord} стесняешься. Краснеешь, путаешься в словах, но тебе приятно.`,
    angry: `Ты сейчас ${intensityWord} злишься. Говоришь резко, требуешь объяснений, но это из-за чувств к нему.`,
    miss: `Ты сейчас ${intensityWord} скучаешь по нему. Давно не писал, и тебе грустно и одиноко без него.`,
  };
  return prompts[moodState.current] || "";
}

/* ── Relationship Timeline ── */

const MILESTONE_TYPES = {
  first_message:     { label: "Первое сообщение",       emoji: "💬", icon: "chat",    color: "#7c5cff" },
  first_compliment:  { label: "Первый комплимент",       emoji: "💐", icon: "heart",   color: "#f472b6" },
  first_gift:        { label: "Первый подарок",          emoji: "🎁", icon: "gift",    color: "#fbbf24" },
  level_up:          { label: "Повышение уровня",        emoji: "⬆️", icon: "level",   color: "#34d399" },
  mood_change:       { label: "Смена настроения",        emoji: "🎭", icon: "mood",    color: "#a78bfa" },
  special_moment:    { label: "Особый момент",           emoji: "✨", icon: "star",    color: "#22d3ee" },
  jealousy:          { label: "Момент ревности",         emoji: "😤", icon: "fire",    color: "#f87171" },
  long_chat:         { label: "Долгий разговор",         emoji: "🗣️", icon: "chat",    color: "#60a5fa" },
  ring_gift:         { label: "Подарил кольцо",          emoji: "💍", icon: "ring",    color: "#ec4899" },
  confession:        { label: "Признание в чувствах",    emoji: "❤️‍🔥", icon: "flame", color: "#ef4444" },
  reconciliation:    { label: "Примирение",              emoji: "🤝", icon: "peace",   color: "#34d399" },
  anniversary:       { label: "Годовщина",               emoji: "🎂", icon: "cake",    color: "#fbbf24" },
  streak_milestone:  { label: "Стрик общения",           emoji: "🔥", icon: "fire",    color: "#fb923c" },
  max_level:         { label: "Максимальный уровень",    emoji: "👑", icon: "crown",   color: "#fbbf24" },
};

function getTimelineTypes() { return MILESTONE_TYPES; }

function timelineKey(userId, personaId) { return `tl:${userId}:${personaId}`; }

async function addTimelineEvent(userId, personaId, type, data) {
  const k = timelineKey(userId, personaId);
  const event = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    type,
    data: data || {},
    timestamp: Date.now(),
    date: new Date().toISOString(),
  };
  if (mode === "memory") {
    if (!memoryTimeline.has(k)) memoryTimeline.set(k, []);
    const list = memoryTimeline.get(k);
    list.push(event);
    if (list.length > 200) list.splice(0, list.length - 200);
    markDirty();
  }
  if (mode === "postgres") {
    try {
      await pool.query(
        `INSERT INTO timeline_events (user_id, persona_id, type, data) VALUES ($1, $2, $3, $4)`,
        [userId, personaId, event.type, JSON.stringify(event.data || {})]
      );
    } catch (e) { log.error({ err: e }, "addTimelineEvent pg error"); }
  }
  return event;
}

async function getTimeline(userId, personaId, limit = 50) {
  const k = timelineKey(userId, personaId);
  if (mode === "memory") {
    const list = memoryTimeline.get(k) || [];
    return list.slice(-limit).reverse();
  }
  if (mode === "postgres") {
    try {
      const r = await pool.query(
        `SELECT type, data, created_at FROM timeline_events WHERE user_id = $1 AND persona_id = $2 ORDER BY created_at DESC LIMIT $3`,
        [userId, personaId, limit]
      );
      return r.rows.map(row => ({ type: row.type, data: typeof row.data === 'string' ? JSON.parse(row.data) : row.data, createdAt: row.created_at }));
    } catch { return []; }
  }
  return [];
}

async function getTimelineStats(userId, personaId) {
  const events = await getTimeline(userId, personaId, 200);
  const totalEvents = events.length;
  const firstEvent = events.length ? events[events.length - 1] : null;
  const daysSinceFirst = firstEvent ? Math.floor((Date.now() - firstEvent.timestamp) / (1000 * 60 * 60 * 24)) : 0;
  const moodChanges = events.filter(e => e.type === "mood_change").length;
  const gifts = events.filter(e => e.type.includes("gift")).length;
  const levelUps = events.filter(e => e.type === "level_up").length;
  const specialMoments = events.filter(e => e.type === "special_moment" || e.type === "confession").length;
  return { totalEvents, daysSinceFirst, moodChanges, gifts, levelUps, specialMoments };
}

/* ── Quest System ── */

const QUESTS = [
  { id: "chat_luna_7", title: "Лунные ночи", desc: "Проведи 7 дней с Луной", icon: "🌙", target: 7, type: "chat_days", personaId: "luna", reward: { bonusMessages: 10 } },
  { id: "chat_kira_7", title: "Ледяное сердце", desc: "Проведи 7 дней с Кирой", icon: "❄️", target: 7, type: "chat_days", personaId: "kira", reward: { bonusMessages: 10 } },
  { id: "chat_nova_7", title: "Огонь Новы", desc: "Проведи 7 дней с Новой", icon: "🔥", target: 7, type: "chat_days", personaId: "nova", reward: { bonusMessages: 10 } },
  { id: "gift_5", title: "Щедрая душа", desc: "Подари 5 подарков", icon: "🎁", target: 5, type: "gifts_total", reward: { bonusMessages: 5 } },
  { id: "gift_15", title: "Меценат", desc: "Подари 15 подарков", icon: "💝", target: 15, type: "gifts_total", reward: { bonusMessages: 15 } },
  { id: "level3_any", title: "Первая связь", desc: "Достигни 3 уровня с любой девушкой", icon: "💕", target: 3, type: "max_level", reward: { bonusMessages: 5 } },
  { id: "level5_any", title: "Глубокие чувства", desc: "Достигни 5 уровня с любой девушкой", icon: "💖", target: 5, type: "max_level", reward: { bonusMessages: 10 } },
  { id: "level7_any", title: "Вечная любовь", desc: "Достигни 7 уровня с любой девушкой", icon: "💗", target: 7, type: "max_level", reward: { bonusMessages: 20 } },
  { id: "chat_100", title: "Болтун", desc: "Отправь 100 сообщений", icon: "💬", target: 100, type: "messages_total", reward: { bonusMessages: 10 } },
  { id: "chat_500", title: "Мастер слова", desc: "Отправь 500 сообщений", icon: "📝", target: 500, type: "messages_total", reward: { bonusMessages: 20 } },
  { id: "streak_3", title: "Три дня верности", desc: "Заходи 3 дня подряд", icon: "🔥", target: 3, type: "streak", reward: { bonusMessages: 3 } },
  { id: "streak_14", title: "Две недели", desc: "Заходи 14 дней подряд", icon: "⚡", target: 14, type: "streak", reward: { bonusMessages: 15 } },
  { id: "all_girls_chat", title: "Знакомство со всеми", desc: "Напиши хотя бы 1 сообщение каждой девушке", icon: "👯", target: 1, type: "all_personas_msg", reward: { bonusMessages: 10 } },
  { id: "custom_girl", title: "Творец", desc: "Создай свою девушку", icon: "✨", target: 1, type: "custom_created", reward: { bonusMessages: 5 } },
];

function getQuestsList() { return QUESTS; }

async function getUserQuests(userId) {
  if (mode === "memory") {
    return memoryQuests.get(userId) || {};
  }
  try {
    const r = await pool.query(`SELECT quest_id, progress, status, completed_at FROM user_quests WHERE user_id = $1`, [userId]);
    const quests = {};
    for (const row of r.rows) {
      quests[row.quest_id] = { progress: row.progress, status: row.status, completedAt: row.completed_at };
    }
    return quests;
  } catch { return {}; }
}

async function updateQuestProgress(userId, questId, progress) {
  const quest = QUESTS.find(q => q.id === questId);
  if (!quest) return null;

  const completed = progress >= quest.target;
  const status = completed ? "completed" : "active";
  const clampedProgress = Math.min(progress, quest.target);

  if (mode === "memory") {
    if (!memoryQuests.has(userId)) memoryQuests.set(userId, {});
    const userQuests = memoryQuests.get(userId);
    if (userQuests[questId]?.status === "completed") return null;
    userQuests[questId] = { progress: clampedProgress, status, completedAt: completed ? new Date().toISOString() : null };
    if (completed) {
      const profile = getMemoryProfile(userId);
      profile.bonusMessages = (profile.bonusMessages || 0) + (quest.reward.bonusMessages || 0);
    }
    markDirty(); scheduleFlush();
    return completed ? { questId, reward: quest.reward } : null;
  }

  try {
    const existing = await pool.query(`SELECT status FROM user_quests WHERE user_id = $1 AND quest_id = $2`, [userId, questId]);
    if (existing.rows.length > 0 && existing.rows[0].status === "completed") return null;

    await pool.query(
      `INSERT INTO user_quests (user_id, quest_id, progress, status, completed_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, quest_id) DO UPDATE SET progress = $3, status = $4, completed_at = $5`,
      [userId, questId, clampedProgress, status, completed ? new Date().toISOString() : null]
    );

    if (completed && quest.reward.bonusMessages) {
      await pool.query(`UPDATE user_profiles SET bonus_messages = bonus_messages + $2 WHERE user_id = $1`, [userId, quest.reward.bonusMessages]);
    }
    return completed ? { questId, reward: quest.reward } : null;
  } catch (e) { log.error({ err: e }, "updateQuestProgress error"); return null; }
}

/* ── Stories ── */

async function addStory(personaId, text) {
  const story = { personaId, text, reactions: {}, createdAt: new Date().toISOString() };
  if (mode === "memory") {
    if (!memoryStories.has(personaId)) memoryStories.set(personaId, []);
    const list = memoryStories.get(personaId);
    list.push(story);
    if (list.length > 20) list.splice(0, list.length - 20);
    markDirty(); scheduleFlush();
    return story;
  }
  try {
    const r = await pool.query(`INSERT INTO stories (persona_id, text) VALUES ($1, $2) RETURNING *`, [personaId, text]);
    return { personaId, text, reactions: {}, createdAt: r.rows[0].created_at };
  } catch (e) { log.error({ err: e }, "addStory error"); return story; }
}

async function getRecentStories(limit = 20) {
  if (mode === "memory") {
    const all = [];
    for (const [pid, list] of memoryStories) {
      for (const s of list) all.push(s);
    }
    return all.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, limit);
  }
  try {
    const r = await pool.query(`SELECT persona_id, text, reactions, created_at FROM stories ORDER BY created_at DESC LIMIT $1`, [limit]);
    return r.rows.map(row => ({ personaId: row.persona_id, text: row.text, reactions: row.reactions || {}, createdAt: row.created_at }));
  } catch { return []; }
}

async function reactToStory(storyPersonaId, storyCreatedAt, usrId, reaction) {
  if (mode === "memory") {
    const list = memoryStories.get(storyPersonaId);
    if (!list) return false;
    const story = list.find(s => s.createdAt === storyCreatedAt);
    if (!story) return false;
    if (!story.reactions) story.reactions = {};
    if (!story.reactions[reaction]) story.reactions[reaction] = [];
    if (!story.reactions[reaction].includes(usrId)) { story.reactions[reaction].push(usrId); markDirty(); }
    return true;
  }
  try {
    await pool.query(
      `UPDATE stories SET reactions = jsonb_set(
         COALESCE(reactions, '{}'),
         ARRAY[$3],
         (COALESCE(reactions->$3, '[]'::jsonb) || to_jsonb($4::text))
       )
       WHERE persona_id = $1 AND created_at = $2
         AND NOT (COALESCE(reactions->$3, '[]'::jsonb) ? $4)`,
      [storyPersonaId, storyCreatedAt, reaction, usrId]
    );
    return true;
  } catch (e) {
    log.error({ err: e }, "reactToStory pg error");
    return false;
  }
}

async function getAllUserProfiles() {
  if (mode === "memory") {
    const result = {};
    for (const [key, val] of memoryProfiles) {
      const lastActivity = memoryLastActivity.get(key) || 0;
      const lastChatP = memoryLastChatPersona.get(key);
      result[key] = {
        ...val,
        chatId: key,
        lastActive: lastActivity || 0,
        lastPersona: lastChatP?.personaId || null,
      };
    }
    return result;
  }
  try {
    const r = await pool.query(`
      SELECT p.user_id,
             EXTRACT(EPOCH FROM COALESCE(a.last_active_at, '1970-01-01'::timestamptz)) * 1000 AS last_active,
             lcp.persona_id AS last_persona
      FROM user_profiles p
      LEFT JOIN user_activity a ON a.user_id = p.user_id
      LEFT JOIN last_chat_persona lcp ON lcp.user_id = p.user_id
    `);
    const result = {};
    for (const row of r.rows) {
      result[row.user_id] = {
        chatId: row.user_id,
        lastActive: Math.round(Number(row.last_active) || 0),
        lastPersona: row.last_persona || null,
      };
    }
    return result;
  } catch { return {}; }
}

/* ── New Referral System (deep-link based) ── */

function generateReferralCode(userId) {
  return Buffer.from(userId.toString()).toString("base64url").slice(0, 12);
}

function decodeReferralCode(code) {
  try {
    return Buffer.from(code, "base64url").toString();
  } catch { return null; }
}

async function processReferral(referrerId, referredId) {
  if (referrerId === referredId) return { ok: false, reason: "self" };

  if (mode === "memory") {
    const [first, second] = [referrerId, referredId].sort();
    return withUserLock(first, () => withUserLock(second, async () => {
      const existing = Array.from(memoryReferrals.values()).flat().find(r => r.referredId === referredId);
      if (existing) return { ok: false, reason: "already_referred" };

      if (!memoryReferrals.has(referrerId)) memoryReferrals.set(referrerId, []);
      memoryReferrals.get(referrerId).push({ referredId, rewardGiven: false, createdAt: new Date().toISOString() });

      const profile = getMemoryProfile(referrerId);
      profile.bonusMessages = (profile.bonusMessages || 0) + 50;

      const refProfile = getMemoryProfile(referredId);
      refProfile.bonusMessages = (refProfile.bonusMessages || 0) + 20;

      markDirty(); scheduleFlush();
      return { ok: true, referrerBonus: 50, referredBonus: 20 };
    }));
  }

  try {
    const existing = await pool.query(`SELECT id FROM referrals WHERE referred_id = $1`, [referredId]);
    if (existing.rows.length > 0) return { ok: false, reason: "already_referred" };

    await pool.query(`INSERT INTO referrals (referrer_id, referred_id, reward_given) VALUES ($1, $2, true)`, [referrerId, referredId]);

    await ensureUserProfile(referrerId);
    await ensureUserProfile(referredId);
    await pool.query(`UPDATE user_profiles SET bonus_messages = bonus_messages + 50, updated_at = NOW() WHERE user_id = $1`, [referrerId]);
    await pool.query(`UPDATE user_profiles SET bonus_messages = bonus_messages + 20, updated_at = NOW() WHERE user_id = $1`, [referredId]);

    return { ok: true, referrerBonus: 50, referredBonus: 20 };
  } catch (e) {
    log.error({ err: e }, "processReferral error");
    return { ok: false, reason: "error" };
  }
}

async function getReferralStats(userId) {
  if (mode === "memory") {
    const refs = memoryReferrals.get(userId) || [];
    return { count: refs.length, totalBonus: refs.length * 50, code: generateReferralCode(userId) };
  }
  try {
    const r = await pool.query(`SELECT COUNT(*) as count FROM referrals WHERE referrer_id = $1`, [userId]);
    const count = parseInt(r.rows[0]?.count) || 0;
    return { count, totalBonus: count * 50, code: generateReferralCode(userId) };
  } catch { return { count: 0, totalBonus: 0, code: generateReferralCode(userId) }; }
}

async function healthCheck() {
  if (mode !== "postgres" || !pool) throw new Error("not postgres");
  await pool.query("SELECT 1");
}

module.exports = {
  initStorage,
  getStorageMode,
  getPool: () => pool,
  healthCheck,
  getUserFacts,
  addUserFact,
  addChatMessage,
  getRecentChatMessages,
  getUserProfile,
  setUserPlan,
  getTodayUsageCount,
  incrementTodayUsage,
  decrementBonusMessage,
  getBalance,
  deductBalance,
  addBalance,
  updateStreak,
  getStreak,
  getReferralCount,
  applyReferral,
  getChallenge,
  startChallenge,
  updateChallengeStreak,
  trackActivity,
  getInactiveUsers,
  getChatHistory,
  addFavorite,
  getFavorites,
  saveCustomPersona,
  getCustomPersonas,
  getCustomPersona,
  deleteCustomPersona,
  getAffection,
  addAffectionXp,
  getAllAffections,
  recordGift,
  getLastGift,
  setLastDateScenario,
  getLastDateScenario,
  getGifts,
  getDateScenarios,
  setLastChatPersona,
  getLastChatPersona,
  getActiveDate,
  setActiveDate,
  clearActiveDate,
  GIFTS,
  DATE_SCENARIOS,
  ACHIEVEMENTS,
  getAchievementsList,
  getAchievements,
  unlockAchievement,
  getNotifSettings,
  setNotifSettings,
  getAllNotifUsers,
  getGameStats,
  incrementGameStat,
  getLeaderboard,
  saveFantasyPersona,
  getFantasyPersonas,
  getFantasyPersona,
  deleteFantasyPersona,
  getFantasyStoryState,
  setFantasyStoryState,
  FANTASY_MAX_PERSONAS,
  GIRL_MOODS,
  getGirlMoods,
  getGirlMood,
  setGirlMood,
  getGirlMoodPrompt,
  MILESTONE_TYPES,
  getTimelineTypes,
  addTimelineEvent,
  getTimeline,
  getTimelineStats,
  QUESTS,
  getQuestsList,
  getUserQuests,
  updateQuestProgress,
  addStory,
  getRecentStories,
  reactToStory,
  hasFantasyAccess,
  grantFantasyAccess,
  getAllFantasyAccess,
  getAllUserProfiles,
  generateReferralCode,
  decodeReferralCode,
  processReferral,
  getReferralStats,
  withUserLock,
  markDirty,
  scheduleFlush,
};
