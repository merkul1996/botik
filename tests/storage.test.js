/**
 * Тесты хранилища в режиме memory (без DATABASE_URL).
 * Запуск: node tests/storage.test.js
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), override: true });

process.env.DATABASE_URL = "";
const {
  initStorage,
  getStorageMode,
  getUserProfile,
  setUserPlan,
  getTodayUsageCount,
  incrementTodayUsage,
  decrementBonusMessage,
  updateStreak,
  getStreak,
  addUserFact,
  getUserFacts,
  applyReferral,
  getAffection,
  addAffectionXp,
  setLastChatPersona,
  getLastChatPersona,
  setActiveDate,
  getActiveDate,
  clearActiveDate,
  getBalance,
  addBalance,
  deductBalance,
  hasFantasyAccess,
  grantFantasyAccess,
} = require("../src/storage");

async function run() {
  await initStorage();
  if (getStorageMode() !== "memory") {
    console.error("Тесты рассчитаны на mode=memory. Убери DATABASE_URL.");
    process.exit(1);
  }

  const uid = "test-user-" + Date.now();
  let ok = 0;
  let fail = 0;

  function assert(cond, msg) {
    if (cond) { ok++; return; }
    fail++;
    console.error("FAIL:", msg);
  }

  // --- Profile ---
  const profile = await getUserProfile(uid);
  assert(profile && (profile.plan === "pro" || profile.plan === "free"), "getUserProfile returns plan");
  assert(profile.referralCode != null, "referralCode exists");
  assert(profile.bonusMessages !== undefined, "bonusMessages exists");
  assert(profile.starsBalance !== undefined, "starsBalance exists");

  // --- Facts ---
  await addUserFact(uid, "luna", "люблю кофе");
  const facts = await getUserFacts(uid, "luna", 5);
  assert(facts.length === 1 && facts[0] === "люблю кофе", "addUserFact/getUserFacts");

  // --- Usage ---
  const usage0 = await getTodayUsageCount(uid);
  await incrementTodayUsage(uid);
  const usage1 = await getTodayUsageCount(uid);
  assert(usage1 === usage0 + 1, "incrementTodayUsage");

  // --- Streaks ---
  await updateStreak(uid);
  const streak = await getStreak(uid);
  assert(streak.currentStreak >= 1, "updateStreak/getStreak");

  // --- Affection ---
  const aff = await getAffection(uid, "luna");
  assert(aff && aff.level >= 1, "getAffection");

  // --- Last Chat Persona ---
  await setLastChatPersona(uid, "luna");
  const lastChat = await getLastChatPersona(uid);
  assert(lastChat && lastChat.personaId === "luna", "setLastChatPersona/getLastChatPersona");

  // --- Active Date ---
  await setActiveDate(uid, { personaId: "luna", round: 1 });
  const date = await getActiveDate(uid);
  assert(date && date.personaId === "luna", "setActiveDate/getActiveDate");
  await clearActiveDate(uid);
  assert((await getActiveDate(uid)) === null, "clearActiveDate");

  // --- Stars Balance ---
  const uid2 = "test-balance-" + Date.now();
  await getUserProfile(uid2);
  const bal0 = await getBalance(uid2);
  assert(bal0 === 0, "initial balance = 0");
  await addBalance(uid2, 100);
  assert(await getBalance(uid2) === 100, "addBalance +100");
  const deducted = await deductBalance(uid2, 30);
  assert(deducted === true, "deductBalance success");
  assert(await getBalance(uid2) === 70, "balance after deduct = 70");
  const failDeduct = await deductBalance(uid2, 200);
  assert(failDeduct === false, "deductBalance insufficient");
  assert(await getBalance(uid2) === 70, "balance unchanged after failed deduct");

  // --- Bonus Messages ---
  const uid3 = "test-bonus-" + Date.now();
  const p3 = await getUserProfile(uid3);
  assert(await decrementBonusMessage(uid3) === false, "decrement when 0 returns false");

  // --- Pro Subscription with Expiry ---
  const uid4 = "test-pro-" + Date.now();
  await getUserProfile(uid4);
  await setUserPlan(uid4, "pro", 30);
  const prof4 = await getUserProfile(uid4);
  assert(prof4.plan === "pro", "setUserPlan pro");
  assert(prof4.proExpiresAt != null, "proExpiresAt set");
  const expiresDate = new Date(prof4.proExpiresAt);
  const diff = expiresDate.getTime() - Date.now();
  assert(diff > 29 * 86400000 && diff < 31 * 86400000, "proExpiresAt ~30 days");

  // --- Fantasy Access ---
  const uid5 = "test-fantasy-" + Date.now();
  assert(await hasFantasyAccess(uid5) === false, "no fantasy access initially");
  await grantFantasyAccess(uid5, 30);
  assert(await hasFantasyAccess(uid5) === true, "fantasy access after grant");

  // --- Referral ---
  const refUid = "test-ref-" + Date.now();
  const refProf = await getUserProfile(refUid);
  assert(typeof refProf.referralCode === "string" && refProf.referralCode.length > 0, "referralCode generated");
  const selfApply = await applyReferral(refUid, refProf.referralCode);
  assert(selfApply && selfApply.ok === false, "applyReferral rejects own code");
  const refUid2 = "test-ref2-" + Date.now();
  await getUserProfile(refUid2);
  const crossApply = await applyReferral(refUid2, refProf.referralCode);
  assert(crossApply && crossApply.ok === true, "applyReferral cross-user succeeds");

  // --- Affection XP ---
  const affBefore = await getAffection(uid, "luna");
  await addAffectionXp(uid, "luna", 50);
  const affAfter = await getAffection(uid, "luna");
  assert(affAfter.xp > affBefore.xp, "addAffectionXp increases XP");

  // ═══════════════════════════════════════
  // Config module tests
  // ═══════════════════════════════════════
  console.log("\n--- Config ---");
  const config = require("../src/config");
  assert(typeof config.PRO_PRICE_STARS === "number" && config.PRO_PRICE_STARS > 0, "PRO_PRICE_STARS > 0");
  assert(typeof config.FANTASY_PRICE_STARS === "number" && config.FANTASY_PRICE_STARS > 0, "FANTASY_PRICE_STARS > 0");
  assert(config.FREE_DAILY_LIMIT > 0, "FREE_DAILY_LIMIT > 0");
  assert(config.PRO_DAILY_LIMIT > config.FREE_DAILY_LIMIT, "PRO_DAILY_LIMIT > FREE");
  assert(config.MAX_MESSAGE_LENGTH > 0, "MAX_MESSAGE_LENGTH defined");
  assert(config.AI_CHAT_TIMEOUT_MS > 0, "AI_CHAT_TIMEOUT_MS defined");
  assert(Array.isArray(config.STARS_PRESETS) && config.STARS_PRESETS.length > 0, "STARS_PRESETS is non-empty array");
  assert(Array.isArray(config.ADMIN_USER_IDS), "ADMIN_USER_IDS is array");

  // ═══════════════════════════════════════
  // Logger module tests
  // ═══════════════════════════════════════
  console.log("\n--- Logger ---");
  const logger = require("../src/logger");
  assert(typeof logger.info === "function", "logger.info exists");
  assert(typeof logger.error === "function", "logger.error exists");
  assert(typeof logger.child === "function", "logger.child exists");
  const childLog = logger.child({ module: "test" });
  assert(typeof childLog.info === "function", "child logger works");

  // ═══════════════════════════════════════
  // Scheduler module tests
  // ═══════════════════════════════════════
  console.log("\n--- Scheduler ---");
  const scheduler = require("../src/scheduler");
  assert(typeof scheduler.schedule === "function", "scheduler.schedule exists");
  assert(typeof scheduler.startAll === "function", "scheduler.startAll exists");
  assert(typeof scheduler.stopAll === "function", "scheduler.stopAll exists");
  assert(typeof scheduler.getJobStats === "function", "scheduler.getJobStats exists");

  let jobRan = false;
  scheduler.schedule("test_job", 100, () => { jobRan = true; });
  const stats = scheduler.getJobStats();
  assert(Array.isArray(stats) && stats.some(j => j.name === "test_job"), "scheduled job appears in stats");
  scheduler.startAll();
  await new Promise(r => setTimeout(r, 200));
  assert(jobRan === true, "scheduled job executed");
  scheduler.stopAll();

  // ═══════════════════════════════════════
  // Notifications module tests
  // ═══════════════════════════════════════
  console.log("\n--- Notifications ---");
  const {
    buildInactivityMessage, buildMorningMessage, buildEveningMessage,
  } = require("../src/notifications");
  const testPersona = { name: "Луна", greeting: "Привет!" };
  const inactMsg = buildInactivityMessage(testPersona, 3 * 3600 * 1000);
  assert(typeof inactMsg === "string" && inactMsg.length > 0, "buildInactivityMessage returns string");
  assert(inactMsg.includes("Луна"), "inactivity message includes persona name");
  const mornMsg = buildMorningMessage(testPersona, 2);
  assert(typeof mornMsg === "string" && mornMsg.includes("Луна"), "buildMorningMessage works");
  const eveMsg = buildEveningMessage(testPersona, 3);
  assert(typeof eveMsg === "string" && eveMsg.includes("Луна"), "buildEveningMessage works");

  // ═══════════════════════════════════════
  // Analytics module tests
  // ═══════════════════════════════════════
  console.log("\n--- Analytics ---");
  const { trackEvent, getStats } = require("../src/analytics");
  assert(typeof trackEvent === "function", "trackEvent exists");
  assert(typeof getStats === "function", "getStats exists");
  trackEvent(uid, "test_event", { source: "unit_test" });
  const analyticsStats = await getStats();
  assert(analyticsStats && typeof analyticsStats === "object", "getStats returns object");

  console.log(`\nResults: OK=${ok}, FAIL=${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
