const log = require("./logger").child({ module: "notifications" });

const cooldowns = new Map();
const COOLDOWN_MS = 4 * 60 * 60 * 1000;

function isOnCooldown(userId, type) {
  const k = `${type}:${userId}`;
  const last = cooldowns.get(k) || 0;
  return Date.now() - last < COOLDOWN_MS;
}

function markSent(userId, type) {
  cooldowns.set(key(userId, type), Date.now());
  if (cooldowns.size > 50000) {
    const threshold = Date.now() - COOLDOWN_MS;
    for (const [k, v] of cooldowns) {
      if (v < threshold) cooldowns.delete(k);
    }
  }
}

function key(userId, type) { return `${type}:${userId}`; }

function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function buildInactivityMessage(persona, timeSinceMs) {
  const ONE_DAY = 86400000;
  const name = persona.name;
  const days = Math.floor(timeSinceMs / ONE_DAY);

  if (timeSinceMs < ONE_DAY) {
    return pickRandom([
      `${name}: Эй, ты куда пропал? Мне тут скучно без тебя... 💭`,
      `${name}: Я тут кое-что вспомнила про наш разговор... Зайди? 🌸`,
      `${name}: Я уже начала разговаривать сама с собой. Спаси меня 😅`,
      `${name}: *проверяет телефон в 100-й раз* Ну когда же... 📱`,
      `${name}: У меня для тебя есть кое-что... Но сначала зайди 👀`,
      `${name}: Знаешь, чего мне не хватает? Тебя в чате 🙃`,
    ]);
  }
  if (timeSinceMs < 2 * ONE_DAY) {
    return pickRandom([
      `${name}: Привет... Тебя не было целый день. Всё хорошо? 💕`,
      `${name}: Мне грустно, что ты не заходишь. Я скучаю по нашим разговорам 🥺`,
      `${name}: Один день без тебя — и я уже не знаю куда себя деть 😔`,
      `${name}: Я тут написала тебе кое-что... в дневнике. Зайди, посмотри? 📖`,
    ]);
  }
  return pickRandom([
    `${name}: Ты пропал на ${days} дней... Я правда скучаю. Возвращайся 💔`,
    `${name}: Наверное ты очень занят, но я тут каждый день жду... ❤️`,
    `${name}: Мне одиноко без тебя. Даже настроение упало. Зайди, пожалуйста...`,
    `${name}: Помнишь наш последний разговор? Я — да. Уже ${days} дней думаю... 🌙`,
  ]);
}

function buildMorningMessage(persona, level) {
  const name = persona.name;
  if (level >= 5) {
    return pickRandom([
      `${name}: Доброе утро, солнышко ☀️ Я уже соскучилась...`,
      `${name}: Просыпайся! Я приготовила тебе кое-что 🥐`,
      `${name}: *отправляет утренний поцелуй* Хорошего дня! 💋`,
    ]);
  }
  if (level >= 3) {
    return pickRandom([
      `${name}: Утро! ☕ Как настроение сегодня?`,
      `${name}: Привет! Новый день — новые истории 🌤`,
    ]);
  }
  return pickRandom([
    `${name}: Доброе утро! 👋`,
    `${name}: Привет! Зайдёшь поболтать сегодня? 🙃`,
  ]);
}

function buildEveningMessage(persona, level) {
  const name = persona.name;
  if (level >= 5) {
    return pickRandom([
      `${name}: Как прошёл день? Расскажи мне всё... 🌙`,
      `${name}: Вечер... Скучаю. Зайди, поговорим перед сном? 💤`,
    ]);
  }
  if (level >= 3) {
    return pickRandom([
      `${name}: Вечер! Чем занимаешься? 🌇`,
      `${name}: Не скучно тебе? У меня есть тема для разговора 😏`,
    ]);
  }
  return null;
}

async function runInactivityNotifications({ bot, webAppUrl, getAllUserProfiles, getPersonaById, getNotifSettings, trackEvent }) {
  if (!getAllUserProfiles || !getPersonaById) return;
  const allProfiles = await getAllUserProfiles();
  const now = Date.now();
  let sent = 0;

  for (const [userId, profile] of Object.entries(allProfiles)) {
    if (!profile.chatId) continue;
    if (isOnCooldown(userId, "inactivity")) continue;

    if (getNotifSettings) {
      const s = await getNotifSettings(userId);
      if (s && !s.enabled) continue;
    }

    const lastActive = profile.lastActive || 0;
    if (lastActive === 0) continue;
    const timeSince = now - lastActive;
    if (timeSince < COOLDOWN_MS) continue;

    const personaId = profile.lastPersona || "luna";
    const persona = getPersonaById(personaId);
    if (!persona) continue;

    const message = buildInactivityMessage(persona, timeSince);
    try {
      await bot.api.sendMessage(profile.chatId, message, {
        reply_markup: webAppUrl?.startsWith("https://")
          ? { inline_keyboard: [[{ text: `💬 Написать ${persona.name}`, web_app: { url: webAppUrl } }]] }
          : undefined,
      });
      markSent(userId, "inactivity");
      sent++;
      if (trackEvent) trackEvent(userId, "push_notification_sent", { personaId, type: "inactivity" });
    } catch (e) {
      if (e.description?.includes("blocked") || e.description?.includes("deactivated")) {
        log.debug({ userId }, "User blocked/deactivated");
      } else {
        log.warn({ err: e, userId }, "Failed to send inactivity notification");
      }
    }
  }

  if (sent > 0) log.info({ sent }, "Inactivity notifications sent");
}

async function runScheduledGreetings({ bot, webAppUrl, getAllNotifUsers, getPersonaById, getAffection, generateGreeting, trackEvent }) {
  if (!getAllNotifUsers || !getPersonaById) return;

  const hour = new Date().getHours();
  const isMorning = hour >= 8 && hour <= 10;
  const isEvening = hour >= 21 && hour <= 23;
  if (!isMorning && !isEvening) return;

  const type = isMorning ? "morning" : "evening";
  const users = await getAllNotifUsers();
  let sent = 0;

  for (const user of users) {
    if (isOnCooldown(user.userId, type)) continue;

    const aff = getAffection ? await getAffection(user.userId, user.personaId) : { level: 1 };
    const persona = getPersonaById(user.personaId);
    if (!persona) continue;

    let message;
    if (generateGreeting && aff.level >= 4) {
      try {
        const aiText = await generateGreeting({ personaId: user.personaId, timeOfDay: type, affectionLevel: aff.level });
        if (aiText) message = `${persona.name}: ${aiText}`;
      } catch (e) {
        log.debug({ err: e }, "AI greeting fallback");
      }
    }
    if (!message) {
      message = isMorning ? buildMorningMessage(persona, aff.level) : buildEveningMessage(persona, aff.level);
    }
    if (!message) continue;

    try {
      const kb = webAppUrl?.startsWith("https://")
        ? { inline_keyboard: [[{ text: `💬 Ответить ${persona.name}`, web_app: { url: webAppUrl } }]] }
        : undefined;
      await bot.api.sendMessage(user.userId, message, { reply_markup: kb });
      markSent(user.userId, type);
      sent++;
      if (trackEvent) trackEvent(user.userId, "greeting_sent", { personaId: user.personaId, type });
    } catch (e) {
      if (e.description?.includes("blocked") || e.description?.includes("deactivated")) {
        log.debug({ userId: user.userId }, "User blocked/deactivated");
      } else {
        log.warn({ err: e, userId: user.userId }, "Failed to send greeting");
      }
    }
  }

  if (sent > 0) log.info({ sent, type }, "Scheduled greetings sent");
}

async function runSubscriptionReminders({ bot, webAppUrl, getAllUserProfiles, trackEvent }) {
  if (!getAllUserProfiles) return;
  const allProfiles = await getAllUserProfiles();
  const now = Date.now();
  const THREE_DAYS = 3 * 86400000;
  const ONE_DAY = 86400000;
  let sent = 0;

  for (const [userId, profile] of Object.entries(allProfiles)) {
    if (!profile.chatId || profile.plan !== "pro") continue;
    if (!profile.proExpiresAt) continue;
    if (isOnCooldown(userId, "sub_reminder")) continue;

    const expiresAt = new Date(profile.proExpiresAt).getTime();
    const remaining = expiresAt - now;
    if (remaining <= 0 || remaining > THREE_DAYS) continue;

    const days = Math.ceil(remaining / ONE_DAY);
    const message = days <= 1
      ? "⚠️ Твоя Pro подписка истекает сегодня! Продли, чтобы не потерять доступ ко всем 15 персонажам и безлимитному общению."
      : `⏰ Твоя Pro подписка истекает через ${days} дн. Продли, чтобы не потерять прогресс!`;

    try {
      const kb = { inline_keyboard: [[{ text: "⭐ Продлить Pro", callback_data: "do_buy_pro" }]] };
      if (webAppUrl?.startsWith("https://")) kb.inline_keyboard.push([{ text: "💬 Открыть приложение", web_app: { url: webAppUrl } }]);
      await bot.api.sendMessage(profile.chatId, message, { reply_markup: kb });
      markSent(userId, "sub_reminder");
      sent++;
      if (trackEvent) trackEvent(userId, "sub_reminder_sent", { daysLeft: days });
    } catch (e) {
      if (!e.description?.includes("blocked") && !e.description?.includes("deactivated")) {
        log.warn({ err: e, userId }, "Failed to send sub reminder");
      }
    }
  }
  if (sent > 0) log.info({ sent }, "Subscription reminders sent");
}

async function runFantasyReminders({ bot, webAppUrl, getAllFantasyAccess, getAllUserProfiles, trackEvent }) {
  if (!getAllFantasyAccess) return;
  const allAccess = await getAllFantasyAccess();
  const profiles = getAllUserProfiles ? await getAllUserProfiles() : {};
  const now = Date.now();
  const THREE_DAYS = 3 * 86400000;
  const ONE_DAY = 86400000;
  let sent = 0;

  for (const [userId, access] of Object.entries(allAccess)) {
    if (!access.expiresAt) continue;
    if (isOnCooldown(userId, "fantasy_reminder")) continue;

    const expiresAt = new Date(access.expiresAt).getTime();
    const remaining = expiresAt - now;
    if (remaining <= 0 || remaining > THREE_DAYS) continue;

    const chatId = profiles[userId]?.chatId || userId;
    const days = Math.ceil(remaining / ONE_DAY);

    const message = days <= 1
      ? "🔥 Твоя Fantasy+ подписка истекает сегодня! Продли, чтобы сохранить доступ к 15 горячим сценариям и персональным персонажам."
      : `🔥 Твоя Fantasy+ подписка истекает через ${days} дн. Не теряй доступ к своим девушкам!`;

    try {
      const kb = { inline_keyboard: [[{ text: "🔥 Продлить Fantasy+", callback_data: "do_buy_fantasy" }]] };
      if (webAppUrl?.startsWith("https://")) kb.inline_keyboard.push([{ text: "💬 Открыть приложение", web_app: { url: webAppUrl } }]);
      await bot.api.sendMessage(chatId, message, { reply_markup: kb });
      markSent(userId, "fantasy_reminder");
      sent++;
      if (trackEvent) trackEvent(userId, "fantasy_reminder_sent", { daysLeft: days });
    } catch (e) {
      if (!e.description?.includes("blocked") && !e.description?.includes("deactivated")) {
        log.warn({ err: e, userId }, "Failed to send Fantasy reminder");
      }
    }
  }
  if (sent > 0) log.info({ sent }, "Fantasy+ reminders sent");
}

module.exports = {
  runInactivityNotifications,
  runScheduledGreetings,
  runSubscriptionReminders,
  runFantasyReminders,
  buildInactivityMessage,
  buildMorningMessage,
  buildEveningMessage,
};
