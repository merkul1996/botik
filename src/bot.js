const { Bot, InlineKeyboard, InputFile } = require("grammy");
const path = require("path");
const fs = require("fs");
const log = require("./logger").child({ module: "bot" });
const { decodeReferralCode, processReferral } = require("./storage");
const {
  PRO_PRICE_STARS, FANTASY_PRICE_STARS, PRO_DAILY_LIMIT, FREE_DAILY_LIMIT,
  PRO_DURATION_DAYS, FANTASY_DURATION_DAYS,
} = require("./config");

const AVATARS_DIR = path.join(__dirname, "..", "public", "avatars");
const FANTASY_DIR = path.join(AVATARS_DIR, "fantasy");

function av(filename) {
  const p = path.join(AVATARS_DIR, filename);
  return fs.existsSync(p) ? p : null;
}
function fav(filename) {
  const p = path.join(FANTASY_DIR, filename);
  return fs.existsSync(p) ? p : null;
}
function isHttps(url) { return typeof url === "string" && url.startsWith("https://"); }

function esc(str) {
  if (!str) return "";
  // eslint-disable-next-line no-useless-escape
  return String(str).replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

function createBot({
  botToken, webAppUrl, onPaymentSuccess, getLastActivity, getPersonaById,
  getUserProfile, getAllNotifUsers, generateGreeting, getAffection,
  getAllUserProfiles, getNotifSettings, trackEvent,
  getStreak, getTodayUsageCount, getBalance, getReferralCount,
}) {
  if (!botToken) return null;

  const bot = new Bot(botToken);
  const ok = isHttps(webAppUrl);
  const processedPayments = new Map();
  const PAYMENT_TTL = 86400000;

  bot.catch((err) => {
    const e = err.error || err;
    log.error({ err: e, userId: err.ctx?.from?.id }, "Bot error");
  });

  /* ══════════════════════════════════════════
     /start — Главное меню
     ══════════════════════════════════════════ */
  bot.command("start", async (ctx) => {
    if (!ok) return ctx.reply("Бот запущен, но WEBAPP_URL не настроен.");
    const payload = ctx.match;

    const caption =
      `✨ *Добро пожаловать в НейроСпутник\\!*\n\n` +
      `🌟 *15 AI\\-девушек* с уникальным характером\n` +
      `💬 Живое общение — они запоминают тебя\n` +
      `💕 Свидания, подарки, уровни отношений\n` +
      `🔥 Fantasy 18\\+ — 15 ролевых сценариев\n\n` +
      `📊 *${FREE_DAILY_LIMIT}* сообщений/день бесплатно\n` +
      `⭐ Pro — безлимит за *${PRO_PRICE_STARS} Stars*`;

    const kb = new InlineKeyboard()
      .webApp("💬 Открыть приложение", webAppUrl).row()
      .text("👩 Девушки", "menu_girls").text("👤 Мой профиль", "menu_profile").row()
      .text("⭐ Pro подписка", "menu_pro").text("🔥 Fantasy 18+", "menu_fantasy").row()
      .text("🎁 Пригласи друга", "menu_invite").text("❓ Помощь", "menu_help");

    const collageIds = ["luna", "kira", "mira", "vika", "nova"];
    const collagePhotos = collageIds.map(id => av(`${id}.png`)).filter(Boolean);

    try {
      if (collagePhotos.length >= 3) {
        const media = collagePhotos.map((p, i) => ({
          type: "photo",
          media: new InputFile(p),
          ...(i === 0 ? { caption, parse_mode: "MarkdownV2" } : {}),
        }));
        await ctx.replyWithMediaGroup(media);
        await ctx.reply("👇 *Выбери, что хочешь:*", { parse_mode: "MarkdownV2", reply_markup: kb });
      } else {
        const photo = av("luna.png");
        if (photo) {
          await ctx.replyWithPhoto(new InputFile(photo), { caption, parse_mode: "MarkdownV2", reply_markup: kb });
        } else {
          await ctx.reply(caption, { parse_mode: "MarkdownV2", reply_markup: kb });
        }
      }
    } catch (_e) {
      await ctx.reply(`✨ Добро пожаловать в НейроСпутник!\n\n15 AI-девушек ждут тебя. Pro за ${PRO_PRICE_STARS} Stars.`, { reply_markup: kb });
    }

    if (payload?.startsWith("ref_")) {
      const code = payload.slice(4);
      const referrerId = decodeReferralCode(code);
      if (referrerId && referrerId !== String(ctx.from.id)) {
        const result = await processReferral(referrerId, String(ctx.from.id));
        if (result.ok) {
          await ctx.reply(`🎉 Бонус! Ты получил +${result.referredBonus} сообщений по приглашению.`);
          try { await bot.api.sendMessage(referrerId, `🎉 Твой друг присоединился! +${result.referrerBonus} бонусных сообщений.`); } catch (_e) { /* blocked */ }
        }
      }
    }

    if (trackEvent) trackEvent(String(ctx.from.id), "bot_start", {});
  });

  /* ══════════════════════════════════════════
     /profile — Профиль прямо в боте
     ══════════════════════════════════════════ */
  async function sendProfile(ctx) {
    const userId = String(ctx.from.id);
    try {
      const profile = getUserProfile ? await getUserProfile(userId) : null;
      const streak = getStreak ? await getStreak(userId) : null;
      const usage = getTodayUsageCount ? await getTodayUsageCount(userId) : 0;
      const balance = getBalance ? await getBalance(userId) : 0;
      const referrals = getReferralCount ? await getReferralCount(userId) : 0;

      const plan = profile?.plan || "free";
      const limit = plan === "pro" ? PRO_DAILY_LIMIT : FREE_DAILY_LIMIT;
      const planLabel = plan === "pro" ? "⭐ Pro" : "🆓 Free";
      const streakDays = streak?.currentStreak || 0;
      const streakEmoji = streakDays >= 7 ? "🔥🔥🔥" : streakDays >= 3 ? "🔥🔥" : streakDays > 0 ? "🔥" : "❄️";

      const expiryLine = profile?.proExpiresAt
        ? `\n📅 Pro до: \`${new Date(profile.proExpiresAt).toLocaleDateString("ru")}\``
        : "";

      const text =
        `👤 *Профиль — ${esc(ctx.from.first_name || "Пользователь")}*\n\n` +
        `📋 Подписка: *${planLabel}*${expiryLine}\n` +
        `💬 Сообщений сегодня: \`${usage}/${limit}\`\n` +
        `${streakEmoji} Стрик: *${streakDays} дн\\.*\n` +
        `💰 Баланс: *${balance} Stars*\n` +
        `👥 Приглашено: *${referrals} друзей*\n` +
        `🆔 ID: \`${userId}\`\n\n` +
        (plan !== "pro" ? "_Хочешь больше? Оформи Pro подписку\\!_" : "_Спасибо, что с нами\\! 💫_");

      const kb = new InlineKeyboard();
      if (plan !== "pro") kb.text("⭐ Купить Pro", "menu_pro").row();
      if (ok) kb.webApp("💬 Открыть приложение", webAppUrl).row();
      kb.text("🔄 Обновить", "menu_profile").text("🏠 Меню", "back_main");

      await ctx.reply(text, { parse_mode: "MarkdownV2", reply_markup: kb });
    } catch (e) {
      log.error({ err: e }, "profile error");
      await ctx.reply("Не удалось загрузить профиль. Попробуй позже.");
    }
  }

  bot.command("profile", sendProfile);
  bot.callbackQuery("menu_profile", async (ctx) => { await ctx.answerCallbackQuery(); await sendProfile(ctx); });

  /* ══════════════════════════════════════════
     /girls — Карусель девушек с фото
     ══════════════════════════════════════════ */
  const ALL_GIRLS = [
    "luna", "mila", "nova", "kira", "aria", "roksi",
    "zlata", "sofi", "nika", "dana", "eva",
    "mira", "alisa", "vika", "lera",
  ];

  async function sendGirl(ctx, idx, edit) {
    idx = Math.max(0, Math.min(idx, ALL_GIRLS.length - 1));
    const id = ALL_GIRLS[idx];
    const p = getPersonaById ? getPersonaById(id) : null;
    if (!p) return;

    const lock = p.premium ? "🔒 " : "🆓 ";
    const text =
      `${lock}*${esc(p.name)}*  \\(${idx + 1}/${ALL_GIRLS.length}\\)\n\n` +
      `💫 _${esc(p.style)}_\n\n` +
      `${esc(p.description || "")}\n\n` +
      (p.premium ? "⭐ _Нужна Pro подписка_" : "✅ _Доступна бесплатно_");

    const kb = new InlineKeyboard();
    if (idx > 0) kb.text("◀️", `girl_${idx - 1}`);
    kb.text(`${idx + 1}/${ALL_GIRLS.length}`, "noop");
    if (idx < ALL_GIRLS.length - 1) kb.text("▶️", `girl_${idx + 1}`);
    kb.row();
    if (ok) kb.webApp(`💬 Написать ${p.name}`, webAppUrl).row();
    if (p.premium) kb.text("⭐ Купить Pro", "menu_pro").row();
    kb.text("🏠 Меню", "back_main");

    const photo = av(`${id}.png`);
    try {
      if (edit && ctx.callbackQuery?.message?.photo) {
        await ctx.editMessageMedia(
          { type: "photo", media: new InputFile(photo || av("luna.png")), caption: text, parse_mode: "MarkdownV2" },
          { reply_markup: kb }
        );
      } else if (photo) {
        await ctx.replyWithPhoto(new InputFile(photo), { caption: text, parse_mode: "MarkdownV2", reply_markup: kb });
      } else {
        await ctx.reply(text, { parse_mode: "MarkdownV2", reply_markup: kb });
      }
    } catch (e) {
      log.error({ err: e }, "girl card error");
      try { await ctx.reply(text, { parse_mode: "MarkdownV2", reply_markup: kb }); } catch (_e2) { /* noop */ }
    }
  }

  bot.command("girls", (ctx) => sendGirl(ctx, 0, false));
  bot.callbackQuery("menu_girls", async (ctx) => { await ctx.answerCallbackQuery(); await sendGirl(ctx, 0, false); });
  bot.callbackQuery("noop", (ctx) => ctx.answerCallbackQuery());
  for (let i = 0; i < ALL_GIRLS.length; i++) {
    bot.callbackQuery(`girl_${i}`, async (ctx) => { await ctx.answerCallbackQuery(); await sendGirl(ctx, i, true); });
  }

  /* ══════════════════════════════════════════
     /fantasy — Воронка 18+ с превью фоток
     ══════════════════════════════════════════ */
  const FANTASY_PREVIEW = [
    { id: "secretary", name: "Секретарша", desc: "Послушная и старательная... Готова выполнить любое поручение", emoji: "👩‍💼" },
    { id: "nurse", name: "Медсестра", desc: "Особый уход и внимание... Ночная смена будет долгой", emoji: "👩‍⚕️" },
    { id: "teacher", name: "Учительница", desc: "Дополнительные занятия после уроков... Один на один", emoji: "👩‍🏫" },
    { id: "trainer", name: "Тренерша", desc: "Персональная тренировка... Растяжка и не только", emoji: "🏋️‍♀️" },
    { id: "maid", name: "Горничная", desc: "Приберётся в номере... и не только в номере", emoji: "🧹" },
    { id: "neighbor", name: "Соседка", desc: "Зашла за сахаром... А дальше всё закрутилось", emoji: "🏠" },
    { id: "masseuse", name: "Массажистка", desc: "Расслабляющий массаж... руки уже скользят ниже", emoji: "💆‍♀️" },
    { id: "colleague", name: "Коллега", desc: "Корпоратив затянулся... Лифт застрял", emoji: "💼" },
    { id: "barista", name: "Бариста", desc: "Закрытие кафе... Она предлагает остаться", emoji: "☕" },
    { id: "stepsister", name: "Сводная сестра", desc: "Родители уехали... Ты застал её в душе", emoji: "🚿" },
    { id: "stepmother", name: "Мачеха", desc: "Отец в командировке... Она зашла пожелать спокойной ночи", emoji: "🌙" },
    { id: "streamer", name: "Стримерша", desc: "Приватный стрим... Только для тебя", emoji: "📱" },
    { id: "waitress", name: "Официантка", desc: "VIP-зал... Обслуживание по высшему классу", emoji: "🍷" },
    { id: "gf_friend", name: "Подруга девушки", desc: "Она пришла на вечеринку одна... Дальше ваш секрет", emoji: "🥂" },
    { id: "travel_companion", name: "Попутчица", desc: "Одно купе на двоих... Ночь длинная", emoji: "🚂" },
  ];

  async function sendFantasyCard(ctx, idx, edit) {
    idx = Math.max(0, Math.min(idx, FANTASY_PREVIEW.length - 1));
    const sc = FANTASY_PREVIEW[idx];

    const text =
      `🔥 *Fantasy 18\\+*  \\(${idx + 1}/${FANTASY_PREVIEW.length}\\)\n\n` +
      `${sc.emoji} *${esc(sc.name)}*\n\n` +
      `_${esc(sc.desc)}_\n\n` +
      "━━━━━━━━━━━━━━━\n" +
      `💰 Полный доступ: *${FANTASY_PRICE_STARS} Stars*\n` +
      `📅 Срок: ${FANTASY_DURATION_DAYS} дней\n\n` +
      "✅ 15 ролевых сценариев\n" +
      "✅ Свободный чат в роли\n" +
      "✅ Настройка характера\n" +
      "✅ AI\\-генерация аватаров";

    const kb = new InlineKeyboard();
    if (idx > 0) kb.text("◀️", `fant_${idx - 1}`);
    kb.text(`${idx + 1}/${FANTASY_PREVIEW.length}`, "noop");
    if (idx < FANTASY_PREVIEW.length - 1) kb.text("▶️", `fant_${idx + 1}`);
    kb.row();
    kb.text(`🔥 Купить Fantasy+ за ${FANTASY_PRICE_STARS} ⭐`, "do_buy_fantasy").row();
    kb.text("🏠 Меню", "back_main");

    const photo = fav(`${sc.id}.png`);
    try {
      if (edit && ctx.callbackQuery?.message?.photo) {
        await ctx.editMessageMedia(
          { type: "photo", media: new InputFile(photo || av("luna.png")), caption: text, parse_mode: "MarkdownV2" },
          { reply_markup: kb }
        );
      } else if (photo) {
        await ctx.replyWithPhoto(new InputFile(photo), { caption: text, parse_mode: "MarkdownV2", reply_markup: kb });
      } else {
        await ctx.reply(text, { parse_mode: "MarkdownV2", reply_markup: kb });
      }
    } catch (e) {
      log.error({ err: e }, "fantasy card error");
      try { await ctx.reply(`🔥 ${sc.name} — ${sc.desc}\n\nКупить Fantasy+ за ${FANTASY_PRICE_STARS} Stars`, { reply_markup: kb }); } catch (_e2) { /* noop */ }
    }

    if (trackEvent) trackEvent(String(ctx.from.id), "fantasy_preview_viewed", { scenario: sc.id, idx });
  }

  bot.command("fantasy", (ctx) => sendFantasyCard(ctx, 0, false));
  bot.callbackQuery("menu_fantasy", async (ctx) => { await ctx.answerCallbackQuery(); await sendFantasyCard(ctx, 0, false); });
  for (let i = 0; i < FANTASY_PREVIEW.length; i++) {
    bot.callbackQuery(`fant_${i}`, async (ctx) => { await ctx.answerCallbackQuery(); await sendFantasyCard(ctx, i, true); });
  }

  /* ══════════════════════════════════════════
     /pro — Воронка Pro подписки
     ══════════════════════════════════════════ */
  async function sendProOffer(ctx) {
    const text =
      "⭐ *Pro подписка — НейроСпутник*\n\n" +
      "┌──── 🆓 *Free* ────┐\n" +
      `│ ${FREE_DAILY_LIMIT} сообщений/день          │\n` +
      "│ 4 персонажа               │\n" +
      "│ Базовые функции         │\n" +
      "└──────────────────┘\n\n" +
      "┌──── ⭐ *Pro* ────┐\n" +
      `│ ${PRO_DAILY_LIMIT} сообщений/день        │\n` +
      "│ *Все 15 персонажей*       │\n" +
      "│ Все сценарии свиданий  │\n" +
      "│ Память о тебе               │\n" +
      "│ Приоритетные ответы     │\n" +
      "└──────────────────┘\n\n" +
      `💰 Всего *${PRO_PRICE_STARS} Stars* \\(~$5\\) за ${PRO_DURATION_DAYS} дней\n\n` +
      "📊 _Уже 500\\+ пользователей выбрали Pro_";

    const kb = new InlineKeyboard()
      .text(`💳 Купить Pro за ${PRO_PRICE_STARS} ⭐`, "do_buy_pro").row()
      .text("🏠 Меню", "back_main");

    const photo = av("kira.png");
    try {
      if (photo) {
        await ctx.replyWithPhoto(new InputFile(photo), { caption: text, parse_mode: "MarkdownV2", reply_markup: kb });
      } else {
        await ctx.reply(text, { parse_mode: "MarkdownV2", reply_markup: kb });
      }
    } catch (_e) {
      await ctx.reply(`⭐ Pro подписка — ${PRO_PRICE_STARS} Stars. Все 15 персонажей, ${PRO_DAILY_LIMIT} сообщений/день.`, {
        reply_markup: kb,
      });
    }
  }

  bot.command("pro", sendProOffer);
  bot.callbackQuery("menu_pro", async (ctx) => { await ctx.answerCallbackQuery(); await sendProOffer(ctx); });

  bot.callbackQuery("do_buy_pro", async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      await ctx.api.sendInvoice(
        ctx.chat.id,
        "Pro подписка — НейроСпутник",
        `Все 15 персонажей, ${PRO_DAILY_LIMIT} сообщений/день. ${PRO_DURATION_DAYS} дней.`,
        "pro_subscription", "", "XTR",
        [{ label: "Pro подписка", amount: PRO_PRICE_STARS }],
      );
    } catch (e) {
      log.error({ err: e }, "Pro invoice error");
      await ctx.reply("Не удалось создать счёт. Попробуй позже.");
    }
  });

  /* ══════════════════════════════════════════
     Fantasy+ покупка
     ══════════════════════════════════════════ */
  bot.callbackQuery("do_buy_fantasy", async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      await ctx.api.sendInvoice(
        ctx.chat.id,
        "Fantasy+ — НейроСпутник 18+",
        `Полный доступ к модулю Фантазии 18+ на ${FANTASY_DURATION_DAYS} дней`,
        "fantasy_plus", "", "XTR",
        [{ label: `Fantasy+ (${FANTASY_DURATION_DAYS} дн.)`, amount: FANTASY_PRICE_STARS }],
      );
    } catch (e) {
      log.error({ err: e }, "Fantasy invoice error");
      await ctx.reply("Не удалось создать счёт. Попробуй позже.");
    }
  });

  /* ══════════════════════════════════════════
     /invite — Реферальная программа
     ══════════════════════════════════════════ */
  async function sendInvite(ctx) {
    const userId = String(ctx.from.id);
    let code = "------";
    let count = 0;
    try {
      const prof = getUserProfile ? await getUserProfile(userId) : null;
      code = prof?.referralCode || code;
      count = getReferralCount ? await getReferralCount(userId) : 0;
    } catch (_e) { /* noop */ }

    const text =
      "🎁 *Пригласи друзей\\!*\n\n" +
      `👥 Приглашено: *${count}*\n` +
      `📋 Твой код: \`${esc(code)}\`\n\n` +
      "🎯 *Бонусы:*\n" +
      "├ 1 друг → *\\+5 сообщений* обоим\n" +
      "├ 3 друга → *7 дней Pro бесплатно*\n" +
      "└ 10 друзей → *30 дней Pro бесплатно*\n\n" +
      "_Поделись ссылкой ниже 👇_";

    const botInfo = bot.botInfo;
    const botUsername = botInfo?.username || "bot";
    const shareText = `Попробуй НейроСпутник — AI-девушки с характером! 💫\nhttps://t.me/${botUsername}?start=ref_${code}`;

    const kb = new InlineKeyboard()
      .switchInline("📤 Поделиться", shareText).row()
      .url("📋 Скопировать ссылку", `https://t.me/${botUsername}?start=ref_${code}`).row()
      .text("🏠 Меню", "back_main");

    const photo = av("sofi.png");
    try {
      if (photo) {
        await ctx.replyWithPhoto(new InputFile(photo), { caption: text, parse_mode: "MarkdownV2", reply_markup: kb });
      } else {
        await ctx.reply(text, { parse_mode: "MarkdownV2", reply_markup: kb });
      }
    } catch (_e) {
      await ctx.reply(`🎁 Твой код: ${code}\nПриглашено: ${count}`, { reply_markup: kb });
    }
  }

  bot.command("invite", sendInvite);
  bot.callbackQuery("menu_invite", async (ctx) => { await ctx.answerCallbackQuery(); await sendInvite(ctx); });

  /* ══════════════════════════════════════════
     /help — Помощь
     ══════════════════════════════════════════ */
  async function sendHelp(ctx) {
    const text =
      "📖 *Как пользоваться НейроСпутником*\n\n" +
      "💬 *Общение* — выбери девушку и пиши\\. Она отвечает уникально\\.\n\n" +
      "❤️ *Отношения* — каждое сообщение \\+ подарок повышает уровень\\. 7 уровней: от «Незнакомка» до «Родная»\\.\n\n" +
      "🎁 *Подарки* — пополни Stars и дари\\. Каждая реагирует по\\-своему\\.\n\n" +
      "💕 *Свидания* — сценарии с выборами, XP, развитие сюжета\\.\n\n" +
      "🔥 *Fantasy 18\\+* — 15 ролевых сценариев для взрослых\\.\n\n" +
      "📢 *Команды:*\n" +
      "├ /start — главное меню\n" +
      "├ /girls — каталог девушек\n" +
      "├ /profile — мой профиль\n" +
      "├ /pro — Pro подписка\n" +
      "├ /fantasy — модуль 18\\+\n" +
      "└ /invite — пригласить друга";

    const kb = new InlineKeyboard();
    if (ok) kb.webApp("💬 Открыть приложение", webAppUrl).row();
    kb.text("🏠 Меню", "back_main");

    await ctx.reply(text, { parse_mode: "MarkdownV2", reply_markup: kb }).catch(() =>
      ctx.reply("Команды: /start /girls /profile /pro /fantasy /invite")
    );
  }

  bot.command("help", sendHelp);
  bot.callbackQuery("menu_help", async (ctx) => { await ctx.answerCallbackQuery(); await sendHelp(ctx); });

  /* ══════════════════════════════════════════
     Кнопка «Назад в меню»
     ══════════════════════════════════════════ */
  bot.callbackQuery("back_main", async (ctx) => {
    await ctx.answerCallbackQuery();
    const kb = new InlineKeyboard()
      .webApp("💬 Открыть приложение", webAppUrl).row()
      .text("👩 Девушки", "menu_girls").text("👤 Профиль", "menu_profile").row()
      .text("⭐ Pro", "menu_pro").text("🔥 Fantasy 18+", "menu_fantasy").row()
      .text("🎁 Пригласить", "menu_invite").text("❓ Помощь", "menu_help");
    await ctx.reply("🏠 *Главное меню*", { parse_mode: "MarkdownV2", reply_markup: kb });
  });

  /* ══════════════════════════════════════════
     Inline query
     ══════════════════════════════════════════ */
  bot.on("inline_query", async (ctx) => {
    try {
      await ctx.answerInlineQuery([{
        type: "article", id: "invite",
        title: "НейроСпутник — AI подруги 💫",
        description: "15 девушек с уникальным характером. Попробуй!",
        input_message_content: {
          message_text: "🌟 Попробуй НейроСпутник — AI подруги для общения!\n\n15 девушек, каждая со своим характером. Общение, свидания, подарки, секреты.\n\n👇 Нажми и начни!",
        },
        ...(ok ? { reply_markup: { inline_keyboard: [[{ text: "💬 Открыть", web_app: { url: webAppUrl } }]] } } : {}),
      }], { cache_time: 300 });
    } catch (_e) { /* noop */ }
  });

  /* ══════════════════════════════════════════
     Оплата
     ══════════════════════════════════════════ */
  bot.on("pre_checkout_query", async (ctx) => {
    const p = ctx.preCheckoutQuery?.invoice_payload || "";
    const valid = p === "pro_subscription" || p === "fantasy_plus" || p.startsWith("stars_balance_");
    await ctx.answerPreCheckoutQuery(valid, valid ? undefined : { error_message: "Неизвестный тип оплаты" });
  });

  bot.on("message:successful_payment", async (ctx) => {
    const chargeId = ctx.message.successful_payment.telegram_payment_charge_id;
    if (processedPayments.has(chargeId) && Date.now() - processedPayments.get(chargeId) < PAYMENT_TTL) return;

    const userId = String(ctx.from.id);
    const payment = ctx.message.successful_payment;
    const payload = payment.invoice_payload || "";
    const totalAmount = payment.total_amount || 0;
    log.info({ userId, stars: totalAmount, payload }, "Payment received");
    if (!onPaymentSuccess) return;

    try {
      await onPaymentSuccess(userId, payload, totalAmount);
      processedPayments.set(chargeId, Date.now());
      if (processedPayments.size > 5000) {
        const t = Date.now() - PAYMENT_TTL;
        for (const [id, ts] of processedPayments) { if (ts < t) processedPayments.delete(id); }
      }

      if (payload === "pro_subscription") {
        const text =
          "🎉 *Pro подписка активирована\\!*\n\n" +
          "✅ Все 15 персонажей\n" +
          `✅ ${PRO_DAILY_LIMIT} сообщений/день\n` +
          "✅ Все сценарии свиданий\n" +
          "✅ Память о тебе\n\n" +
          "Приятного общения\\! 💫";
        const kb = ok ? new InlineKeyboard().webApp("💬 Открыть приложение", webAppUrl) : undefined;
        const photo = av("nova.png");
        try {
          if (photo) await ctx.replyWithPhoto(new InputFile(photo), { caption: text, parse_mode: "MarkdownV2", reply_markup: kb });
          else await ctx.reply(text, { parse_mode: "MarkdownV2", reply_markup: kb });
        } catch (_e) {
          await ctx.reply("🎉 Pro активирован!", { reply_markup: kb });
        }
      } else if (payload === "fantasy_plus") {
        const kb = ok ? new InlineKeyboard().webApp("🔥 Открыть Фантазии", webAppUrl) : undefined;
        await ctx.reply(`🔥 Fantasy+ активирован! Доступ на ${FANTASY_DURATION_DAYS} дней.`, { reply_markup: kb });
      } else if (payload.startsWith("stars_balance_")) {
        const amount = parseInt(payload.replace("stars_balance_", ""), 10) || 0;
        const kb = ok ? new InlineKeyboard().webApp("💬 Открыть приложение", webAppUrl) : undefined;
        await ctx.reply(`✅ Баланс пополнен на ${amount} ⭐\nДари подарки! 🎁`, { reply_markup: kb });
      }
    } catch (e) {
      log.error({ err: e, userId }, "Payment processing error");
      await ctx.reply("Оплата получена, но произошла ошибка. Напиши в поддержку.");
    }
  });

  return bot;
}

module.exports = { createBot };
