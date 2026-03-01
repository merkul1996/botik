const ALL_EVENTS = [
  {
    id: "valentines", title: "День Святого Валентина", emoji: "💘",
    banner: "💘 Неделя любви — x2 XP за подарки!",
    start: "02-10", end: "02-16", xpMultiplier: 2,
    specialGifts: ["valentines_heart", "valentines_rose"],
    description: "Романтический сезон! Подари Валентинку и получи двойной XP.",
    specialGift: { id: "valentine_card", name: "Валентинка", emoji: "💌", stars: 2, xp: 50 },
    specialPersona: {
      id: "cupid", name: "Купидон",
      style: "игривая, романтичная, шаловливая",
      description: "Маленький Купидон в человеческом обличье. Помогает с любовью!",
      greeting: "Привет, лучник любви здесь! Кому сегодня стрелу в сердце?",
      color: "#ff69b4", tags: ["валентин", "любовь"], premium: false,
      behavior: [
        "Ты — Купидон, девушка 20 лет, игривая и озорная.",
        "Ты помешана на любви и романтике.",
        "Помогаешь парням с советами про девушек.",
        "Флиртуешь легко и задорно.",
        "Доступна только в период Дня Валентина.",
      ],
    },
  },
  {
    id: "march8", title: "8 Марта", emoji: "🌷",
    banner: "🌷 Праздник весны — подари цветы!",
    start: "03-05", end: "03-10", xpMultiplier: 1.5,
    specialGifts: ["spring_bouquet"],
    description: "Праздник весны! Все девушки в праздничном настроении.",
    specialGift: { id: "tulips", name: "Букет тюльпанов", emoji: "🌷", stars: 2, xp: 40 },
    specialPersona: null,
  },
  {
    id: "spring", title: "Весеннее настроение", emoji: "🌸",
    banner: "🌸 Весна пришла — девушки в хорошем настроении!",
    start: "03-20", end: "04-10", xpMultiplier: 1.3,
    specialGifts: ["cherry_blossom"],
    description: "Весенние настроение! Девушки рады и открыты.",
    specialGift: null, specialPersona: null,
  },
  {
    id: "summer", title: "Лето любви", emoji: "☀️",
    banner: "☀️ Лето любви — x1.5 XP за сообщения",
    start: "06-01", end: "08-31", xpMultiplier: 1.5,
    specialGifts: ["summer_cocktail", "sunflower"],
    description: "Летний сезон! Пляжные свидания и горячие разговоры.",
    specialGift: { id: "icecream", name: "Мороженое", emoji: "🍦", stars: 1, xp: 20 },
    specialPersona: null,
  },
  {
    id: "halloween", title: "Хэллоуин", emoji: "🎃",
    banner: "🎃 Жуткая неделя — тёмные секреты девушек",
    start: "10-28", end: "11-02", xpMultiplier: 1.5,
    specialGifts: ["pumpkin", "ghost_candy"],
    description: "Страшно интересно! Девушки раскрывают тёмные секреты.",
    specialGift: null, specialPersona: null,
  },
  {
    id: "newyear", title: "Новый Год", emoji: "🎄",
    banner: "🎄 Новогодние чудеса — x2 XP!",
    start: "12-25", end: "01-05", xpMultiplier: 2,
    specialGifts: ["champagne", "fireworks", "newyear_gift"],
    description: "Праздничная магия! Загадай желание с любимой девушкой.",
    specialGift: { id: "champagne", name: "Шампанское", emoji: "🍾", stars: 3, xp: 60 },
    specialPersona: null,
  },
];

function getActiveEvents() {
  const now = new Date();
  const md = `${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return ALL_EVENTS.filter(ev => {
    if (ev.start <= ev.end) return md >= ev.start && md <= ev.end;
    return md >= ev.start || md <= ev.end;
  });
}

function getAllEvents() { return ALL_EVENTS; }

function getXpMultiplier() {
  const active = getActiveEvents();
  if (active.length === 0) return 1;
  return Math.max(...active.map(e => e.xpMultiplier));
}

module.exports = { EVENTS: ALL_EVENTS, ALL_EVENTS, getActiveEvents, getAllEvents, getXpMultiplier };
