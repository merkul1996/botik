const tg = window.Telegram?.WebApp;
if (tg) { tg.ready(); tg.expand(); }
const userId = String(tg?.initDataUnsafe?.user?.id || "web-user");
const userName = tg?.initDataUnsafe?.user?.first_name || "Пользователь";
const initData = tg?.initData || "";
const $ = window.Neuro$ || ((id) => document.getElementById(id));

function runApp() {

function trackEvent(event, data) {
  apiPost("/api/track-event", { event, data }).catch(() => {});
}

function apiHeaders() {
  const h = { "Content-Type": "application/json" };
  if (initData) h["X-Telegram-Init-Data"] = initData;
  return h;
}
const FETCH_TIMEOUT = 25000;
function fetchWithTimeout(url, opts, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms || FETCH_TIMEOUT);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(t));
}
function apiGet(url) {
  return fetchWithTimeout(url, { headers: initData ? { "X-Telegram-Init-Data": initData } : {} });
}
function apiPost(url, body, timeoutMs) {
  const b = typeof body === "object" && body !== null ? { ...body } : body;
  if (initData && typeof b === "object") b.initData = initData;
  return fetchWithTimeout(url, { method: "POST", headers: apiHeaders(), body: JSON.stringify(b || {}) }, timeoutMs || FETCH_TIMEOUT);
}

const _apiCache=new Map();
const _CACHE_TTL={"/api/personas":300000,"/api/gifts":300000,"/api/moods":600000,"/api/events":60000,"/api/scenes":120000};
async function cachedGet(url,params){
  const key=params?url+"?"+new URLSearchParams(params):url;
  const ttl=_CACHE_TTL[url];
  if(ttl&&_apiCache.has(key)){const c=_apiCache.get(key);if(Date.now()-c.at<ttl)return c.data}
  const r=await apiGet(key);if(!r.ok)return null;
  const data=await r.json();
  if(ttl)_apiCache.set(key,{data,at:Date.now()});
  return data;
}

const MOOD_LABELS={default:"Обычное",flirty:"Флирт",tender:"Нежное",playful:"Весёлое",sad:"Грустное"};
const EL = {
  status:$("statusBadge"), grid:$("charactersGrid"), msgs:$("chatMessages"),
  chatAv:$("chatAvatar"), chatNm:$("chatName"), chatSt:$("chatStatus"),
  chatContextStatus:$("chatContextStatus"), chatMoodLabel:$("chatMoodLabel"),
  typing:$("typingIndicator"), input:$("messageInput"), send:$("sendBtn"),
  profName:$("profileName"), profAv:$("profileAvatar"), badge:$("profilePlanBadge"),
  lim:$("statLimit"), used:$("statUsed"), left:$("statLeft"),
  planF:$("planFree"), planP:$("planPro"),
  strk:$("streakCount"), strkB:$("streakBest"),
  profileRelationships:$("profileRelationships"),
  ob:$("onboardingOverlay"),
  affPill:$("chatAffPill"), giftPanel:$("giftPanel"), giftGrid:$("giftGrid"),
  diaryPanel:$("diaryPanel"), diaryScroll:$("diaryScroll"), diaryClose:$("diaryCloseBtn"),
  chatMenuBtn:$("chatMenuBtn"), chatMenuDropdown:$("chatMenuDropdown"),
  menuGift:$("menuGift"), menuTimeline:$("menuTimeline"), menuDiary:$("menuDiary"),
  emojiToggleBtn:$("emojiToggleBtn"), emojiPicker:$("emojiPicker"), moodToggleBtn:$("moodToggleBtn"),
  momentsPanel:$("momentsPanel"), momentsClose:$("momentsCloseBtn"), momentsScroll:$("momentsScroll"),
  momentsAvatar:$("momentsAvatar"), momentsName:$("momentsName"), momentsStatus:$("momentsStatus"), momentsList:$("momentsList"),
  achievGrid:$("achievementsGrid"), achievCount:$("achievCountBadge"),
  leaderBody:$("leaderboardBody"),
  notifSwitch:$("notifSwitch"),
  eventBanner:$("eventBannerContainer"),
  girlMoodBadge:$("girlMoodBadge"), girlMoodEmoji:$("girlMoodEmoji"), girlMoodLabel:$("girlMoodLabel"),
  moodDetailOverlay:$("moodDetailOverlay"), mdEmoji:$("mdEmoji"), mdLabel:$("mdLabel"),
  mdReason:$("mdReason"), mdIntensityFill:$("mdIntensityFill"), mdIntensityLabel:$("mdIntensityLabel"),
  mdHistory:$("mdHistory"), mdCloseBtn:$("mdCloseBtn"),
  timelinePanel:$("timelinePanel"),
  tlCloseBtn:$("tlCloseBtn"), tlScroll:$("tlScroll"),
  questsGrid:$("questsGrid"),
  storiesBar:$("storiesBar"), storyOverlay:$("storyOverlay"),
  storyCloseBtn:$("storyCloseBtn"), storyPersonaName:$("storyPersonaName"),
  storyText:$("storyText"),
};

let personas=[], gifts=[];
let pid="luna", plan="free", mood="default", sending=false;
let affections={};
let starsBalance=0;
let challengeSelectedPersonaId=null;

function updateChatLimitBar(remaining, total){
  const bar=document.getElementById("chatLimitBar");
  if(!bar)return;
  if(remaining===undefined||total===undefined){bar.classList.add("hidden");return}
  bar.classList.remove("hidden");
  bar.className="chat-limit-bar"+(remaining<=0?" danger":remaining<=5?" warn":"");
  if(remaining<=0){
    bar.innerHTML=`Лимит исчерпан. <a href="#" onclick="go('pageProfile');return false" style="color:#7d8dff">Перейти на Pro</a>`;
  }else{
    bar.textContent=`Осталось ${remaining} из ${total} сообщений`;
  }
}

function status(t,on=true){if(EL.status)EL.status.innerHTML=on?`<span class="hdr-dot"></span>${esc(t)}`:esc(t)}
window.addEventListener("online",()=>status("Онлайн",true));
window.addEventListener("offline",()=>status("Нет связи",false));

/* ── Onboarding (enhanced) ── */
const OB=`ob_${userId}`;

function checkOnboarding(){
  const done=localStorage.getItem(OB);
  const overlay=document.getElementById("onboardingOverlay");
  if(done||!overlay){if(overlay)overlay.classList.add("hidden");return}
  overlay.classList.remove("hidden");
  initOnboarding();
}

function initOnboarding(){
  const steps=document.querySelectorAll(".onboarding-step");
  const dots=document.querySelectorAll(".ob-dot");
  let currentStep=0;
  let selectedPersona=null;

  function showStep(n){
    steps.forEach(s=>s.style.display="none");
    const target=steps[n];
    if(target){target.style.display="";target.style.animation="none";target.offsetHeight;target.style.animation=""}
    dots.forEach((d,i)=>d.classList.toggle("active",i===n));
    currentStep=n;
    if(n===2)renderObPersonas();
    if(n===3&&selectedPersona)fillStep3();
  }

  async function fillStep3(){
    const avEl=document.getElementById("obChosenAvatar");
    const nameEl=document.getElementById("obChosenName");
    const greetEl=document.getElementById("obChosenGreeting");
    if(avEl)avEl.innerHTML=selectedPersona.avatar?.startsWith("/")
      ?`<img src="${selectedPersona.avatar}" alt="">`
      :`<div class="ob-persona-letter" style="background:${selectedPersona.color||'var(--accent)'};width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:36px;font-weight:800;color:#fff">${(selectedPersona.name||"?")[0]}</div>`;
    if(nameEl)nameEl.textContent=selectedPersona.name;
    if(greetEl){
      greetEl.innerHTML='<span class="ob-typing-dots"><span>.</span><span>.</span><span>.</span></span>';
      try{
        const r=await apiPost("/api/onboarding-greeting",{personaId:selectedPersona.id});
        if(r.ok){const d=await r.json();if(d.greeting)greetEl.textContent=d.greeting;else greetEl.textContent=selectedPersona.greeting||"Привет! Рада знакомству! 💕"}
        else greetEl.textContent=selectedPersona.greeting||"Привет! Рада знакомству! 💕";
      }catch(e){logError("onboarding/greeting",e);greetEl.textContent=selectedPersona.greeting||"Привет! Рада знакомству! 💕"}
    }
  }

  document.querySelectorAll(".ob-next-btn").forEach(btn=>{
    btn.onclick=()=>showStep(parseInt(btn.dataset.next));
  });

  function renderObPersonas(){
    const grid=document.getElementById("obPersonaGrid");
    if(!grid||!personas.length)return;
    grid.innerHTML="";
    const mainPersonas=personas.filter(p=>!p.custom&&!p.premium);
    for(const p of mainPersonas.slice(0,9)){
      const card=document.createElement("div");
      card.className="ob-persona-card";
      const avContent=p.avatar?.startsWith("/")
        ?`<img src="${p.avatar}" alt="${esc(p.name)}">`
        :`<div class="ob-persona-letter" style="background:${p.color||'var(--accent)'}">${esc((p.name||"?")[0])}</div>`;
      card.innerHTML=`${avContent}<div class="ob-persona-name">${esc(p.name)}</div><div class="ob-persona-style">${esc(p.style||"")}</div>`;
      card.onclick=()=>{
        grid.querySelectorAll(".ob-persona-card").forEach(c=>c.classList.remove("selected"));
        card.classList.add("selected");
        selectedPersona=p;
        setTimeout(()=>showStep(3),300);
      };
      grid.appendChild(card);
    }
  }

  document.getElementById("obStartChat").onclick=()=>{
    localStorage.setItem(OB,"1");
    document.getElementById("onboardingOverlay").classList.add("hidden");
    apiPost("/api/track-event",{event:"onboarding_completed",data:{personaId:selectedPersona?.id}}).catch(()=>{});
    if(selectedPersona){
      pid=selectedPersona.id;
      renderCards();chatHdr();go("pageChat");loadHistory(pid);
    }
  };
}

/* ── Nav ── */
const pages=["pageCharacters","pageFantasy","pageChat","pageProfile"];
const navs=document.querySelectorAll(".nav-btn");
const bottomNav=document.querySelector(".bottom-nav");
const _pageLoaded = new Set(["pageCharacters"]);
window.go=go;
function go(p){
  pages.forEach(id=>{const e=$(id);if(e)e.classList.toggle("active",id===p)});
  navs.forEach(b=>b.classList.toggle("on",b.dataset.page===p));
  if(bottomNav) bottomNav.classList.toggle("nav-hidden", p!=="pageCharacters");
  const firstVisit = !_pageLoaded.has(p);
  _pageLoaded.add(p);
  if(p==="pageChat"){if(EL.msgs&&!EL.msgs.children.length&&pid)loadHistory(pid);if(EL.msgs)EL.msgs.scrollTop=EL.msgs.scrollHeight;if(EL.input)EL.input.focus();loadChatContext();setChatMoodClass();loadGirlMood()}
  if(p==="pageProfile"){
    if(firstVisit){loadAchievements();loadLeaderboard();loadQuests();loadReferral();loadNotifSettings()}
    else{loadAchievements();loadLeaderboard();loadQuests();loadReferral()}
  }
  if(p==="pageFantasy"){fantasyInit()}
  trackEvent("page_view", { page: p });
}
function setChatMoodClass(){
  const pageEl=$("pageChat");if(!pageEl)return;
  pageEl.classList.remove("chat-mood-flirty","chat-mood-tender","chat-mood-playful","chat-mood-sad");
  if(mood&&mood!=="default")pageEl.classList.add("chat-mood-"+mood);
}
navs.forEach(b=>b.addEventListener("click",()=>go(b.dataset.page)));
const chatBackBtn=$("chatBackBtn"); if(chatBackBtn) chatBackBtn.onclick=()=>go("pageCharacters");
const profileBackBtn=$("profileBackBtn"); if(profileBackBtn) profileBackBtn.onclick=()=>go("pageCharacters");
const fantasyBackBtn=$("fantasyBackBtn"); if(fantasyBackBtn) fantasyBackBtn.onclick=()=>go("pageCharacters");

/* ── Helpers ── */
const LVL_XP=[0,50,150,300,500,700,1000];
function affFor(pId){return affections[pId]||{level:1,label:"Незнакомка",xp:0,xpForNext:50,maxLevel:false}}
function affPct(a){
  if(a.maxLevel)return 100;
  const curMin=LVL_XP[a.level-1]||0;
  const nextMin=a.xpForNext||LVL_XP[a.level]||curMin+50;
  const range=nextMin-curMin;
  if(range<=0)return 100;
  return Math.min(100,Math.max(0,Math.round(((a.xp-curMin)/range)*100)));
}

/* ── Creator / Constructor ── */
const CR_STEPS = [
  { key:"artStyle", title:"Стиль", hint:"Выбери стиль изображения", cols:2, options:[
    {id:"realistic",emoji:"📷",label:"Реалистик",sub:"Фотореализм"},
    {id:"anime",emoji:"🎨",label:"Аниме",sub:"Аниме-стиль"},
  ]},
  { key:"ethnicity", title:"Этничность", hint:"Откуда твоя девушка?", cols:2, options:[
    {id:"european",emoji:"🇪🇺",label:"Европейка"},{id:"asian",emoji:"🇯🇵",label:"Азиатка"},
    {id:"latina",emoji:"🇧🇷",label:"Латина"},{id:"dark",emoji:"🌍",label:"Темнокожая"},
    {id:"slavic",emoji:"🇷🇺",label:"Славянка"},{id:"arab",emoji:"🌙",label:"Арабка"},
  ]},
  { key:"age", title:"Возраст", hint:"Сколько ей лет?", cols:2, options:[
    {id:"18-20",emoji:"🌸",label:"18-20"},{id:"21-25",emoji:"💫",label:"21-25"},
    {id:"26-30",emoji:"🔥",label:"26-30"},{id:"30+",emoji:"👑",label:"30+"},
  ]},
  { key:"hairColor", title:"Цвет волос", hint:"Какой цвет волос?", cols:3, options:[
    {id:"blonde",emoji:"👱‍♀️",label:"Блонд"},{id:"brunette",emoji:"👩",label:"Брюнетка"},
    {id:"redhead",emoji:"🦰",label:"Рыжая"},{id:"pink",emoji:"🩷",label:"Розовые"},
    {id:"blue",emoji:"💙",label:"Голубые"},{id:"black",emoji:"🖤",label:"Чёрные"},
  ], sub:{ key:"hairLength", title:"Длина волос", cols:3, options:[
    {id:"short",emoji:"✂️",label:"Короткие"},{id:"medium",emoji:"💇‍♀️",label:"Средние"},{id:"long",emoji:"💁‍♀️",label:"Длинные"},
  ]}},
  { key:"eyeColor", title:"Цвет глаз", hint:"Какие глаза?", cols:3, options:[
    {id:"brown",emoji:"🟤",label:"Карие"},{id:"blue",emoji:"🔵",label:"Голубые"},
    {id:"green",emoji:"🟢",label:"Зелёные"},{id:"grey",emoji:"⚪",label:"Серые"},
    {id:"violet",emoji:"🟣",label:"Фиолетовые"},
  ]},
  { key:"body", title:"Фигура", hint:"Какая фигура?", cols:2, options:[
    {id:"slim",emoji:"🩰",label:"Стройная",sub:"Изящная и утончённая"},
    {id:"athletic",emoji:"🏃‍♀️",label:"Спортивная",sub:"Подтянутая и сильная"},
    {id:"curvy",emoji:"🍑",label:"Пышная",sub:"Аппетитные формы"},
    {id:"petite",emoji:"🌺",label:"Миниатюрная",sub:"Маленькая и хрупкая"},
  ]},
  { key:"outfit", title:"Одежда", hint:"В чём она одета?", cols:2, options:[
    {id:"casual",emoji:"👕",label:"Повседневная"},{id:"elegant",emoji:"👗",label:"Элегантная"},
    {id:"sporty",emoji:"🏋️‍♀️",label:"Спортивная"},{id:"bold",emoji:"🔥",label:"Дерзкая"},
    {id:"cozy",emoji:"🧸",label:"Домашняя"},
  ]},
  { key:"character", title:"Характер и флирт", hint:"Какой у неё характер?", cols:2, options:[
    {id:"tender",emoji:"💕",label:"Нежная",sub:"Романтичная, ласковая"},
    {id:"bold",emoji:"⚡",label:"Дерзкая",sub:"Уверенная, провокационная"},
    {id:"shy",emoji:"🥺",label:"Стеснительная",sub:"Скромная, тихая"},
    {id:"playful",emoji:"😜",label:"Игривая",sub:"Весёлая, шаловливая"},
    {id:"mysterious",emoji:"🌙",label:"Загадочная",sub:"Интригующая, глубокая"},
    {id:"cold",emoji:"❄️",label:"Холодная",sub:"Сдержанная, умная"},
  ], sub:{ key:"flirtLevel", title:"Флирт", cols:3, options:[
    {id:"open",emoji:"💋",label:"Открытый"},{id:"moderate",emoji:"😊",label:"Умеренный"},{id:"shy",emoji:"😳",label:"Скромный"},
  ]}},
  { key:"_name", title:"Имя", hint:"Как её зовут? (оставь пустым — AI придумает)", isName:true },
];
const TOTAL_CR_STEPS = CR_STEPS.length;

let crState = {};
let crStep = 0;
let crGenerating = false;
let crResult = null;
const crEl = {
  page:$("pageCreate"), back:$("crBackBtn"), label:$("crStepLabel"),
  progress:$("crProgress"), body:$("crBody"),
  prev:$("crPrevBtn"), next:$("crNextBtn"),
};

function openCreator(){
  crState = { artStyle:"realistic", ethnicity:"european", age:"21-25",
    hairColor:"brunette", hairLength:"long", eyeColor:"brown",
    body:"slim", outfit:"casual", character:"tender", flirtLevel:"open", name:"" };
  crStep=0; crResult=null; crGenerating=false;
  if(crEl.page)crEl.page.classList.add("active");
  renderCreatorStep();
}

function closeCreator(){
  if(crEl.page)crEl.page.classList.remove("active");
}

function renderCreatorStep(){
  if(!crEl.body)return;

  if(crGenerating){
    crEl.body.innerHTML=`<div class="cr-generating"><div class="cr-spin"></div><div class="cr-gen-text">Создаём персонажа...<br>AI генерирует характер и поведение</div></div>`;
    if(crEl.prev)crEl.prev.style.display="none";
    if(crEl.next)crEl.next.style.display="none";
    if(crEl.label)crEl.label.textContent="";
    renderCreatorProgress();
    return;
  }

  if(crResult){
    const p=crResult;
    const avHtml=p.avatar?`<img src="${p.avatar}" alt="${esc(p.name)}">`:
      (p.creatorParams?buildCssAvatar(p.creatorParams,p.name):`<span class="cr-preview-letter">${esc((p.name||"?").charAt(0))}</span>`);
    const tagsHtml=(p.tags||[]).map(t=>`<span class="tag">${esc(t)}</span>`).join("");
    crEl.body.innerHTML=`<div class="cr-result">
      <div class="cr-result-av">${avHtml}</div>
      <div class="cr-result-name">${esc(p.name)}</div>
      <div class="cr-result-style">${esc(p.style||"")}</div>
      <div class="cr-result-desc">${esc(p.description||"")}</div>
      <div class="cr-preview-tags">${tagsHtml}</div>
    </div>`;
    if(crEl.prev){crEl.prev.style.display="";crEl.prev.textContent="Создать ещё";}
    if(crEl.next){crEl.next.style.display="";crEl.next.textContent="Написать ей";}
    if(crEl.label)crEl.label.textContent="Готово!";
    renderCreatorProgress();
    return;
  }

  const step=CR_STEPS[crStep];
  if(!step)return;

  if(crEl.label)crEl.label.textContent=`${crStep+1}/${TOTAL_CR_STEPS}`;
  renderCreatorProgress();

  let html=`<div class="cr-subtitle">${step.title}</div><div class="cr-hint">${step.hint||""}</div>`;

  if(step.isName){
    html+=`<input class="cr-name-input" id="crNameInput" type="text" placeholder="Имя (например: Алиса, Лика, Рин...)" value="${esc(crState.name||"")}" maxlength="20">`;
  } else {
    const cols=step.cols===3?"cols3":"";
    html+=`<div class="cr-chips ${cols}">`;
    for(const opt of step.options){
      const on=crState[step.key]===opt.id?"on":"";
      html+=`<div class="cr-chip ${on}" data-key="${step.key}" data-val="${opt.id}">
        <span class="cr-chip-emoji">${opt.emoji}</span>
        <span class="cr-chip-label">${opt.label}</span>
        ${opt.sub?`<span class="cr-chip-sub">${opt.sub}</span>`:""}
      </div>`;
    }
    html+=`</div>`;

    if(step.sub){
      const s=step.sub;
      const scols=s.cols===3?"cols3":"";
      html+=`<div class="cr-sub-group"><div class="cr-sub-title">${s.title}</div><div class="cr-chips ${scols}">`;
      for(const opt of s.options){
        const on=crState[s.key]===opt.id?"on":"";
        html+=`<div class="cr-chip ${on}" data-key="${s.key}" data-val="${opt.id}">
          <span class="cr-chip-emoji">${opt.emoji}</span>
          <span class="cr-chip-label">${opt.label}</span>
        </div>`;
      }
      html+=`</div></div>`;
    }
  }

  crEl.body.innerHTML=html;

  crEl.body.querySelectorAll(".cr-chip").forEach(chip=>{
    chip.addEventListener("click",()=>{
      const k=chip.dataset.key, v=chip.dataset.val;
      crState[k]=v;
      crEl.body.querySelectorAll(`.cr-chip[data-key="${k}"]`).forEach(c=>c.classList.toggle("on",c.dataset.val===v));
    });
  });

  const nameInput=document.getElementById("crNameInput");
  if(nameInput) nameInput.addEventListener("input",()=>{ crState.name=nameInput.value.trim(); });

  if(crEl.prev){crEl.prev.style.display="";crEl.prev.textContent="Назад";crEl.prev.disabled=crStep===0;}
  if(crEl.next){crEl.next.style.display="";crEl.next.textContent=crStep===TOTAL_CR_STEPS-1?"Создать":"Далее";crEl.next.disabled=false;}
}

function renderCreatorProgress(){
  if(!crEl.progress)return;
  crEl.progress.innerHTML="";
  for(let i=0;i<TOTAL_CR_STEPS;i++){
    const d=document.createElement("div");
    d.className=`cr-dot${i<crStep?" done":""}${i===crStep&&!crGenerating&&!crResult?" cur":""}${crGenerating||crResult?" done":""}`;
    crEl.progress.appendChild(d);
  }
}

async function crFinish(){
  crGenerating=true;
  renderCreatorStep();
  try{
    const r=await apiPost("/api/generate-persona",{params:crState}, 60000);
    const d=await r.json();
    if(!r.ok){ crGenerating=false; renderCreatorStep(); addMsg(d.error||"Ошибка создания","s"); go("pageChat"); closeCreator(); return; }
    crResult=d.persona;
    personas.push(crResult);
    crGenerating=false;
    renderCreatorStep();
    renderCards();
  }catch(e){
    crGenerating=false; renderCreatorStep();
    addMsg("Ошибка: "+(e?.message||"сервер не ответил"),"s"); go("pageChat"); closeCreator();
  }
}

if(crEl.back) crEl.back.onclick=()=>{
  if(crGenerating)return;
  if(crResult){ closeCreator(); return; }
  if(crStep===0){ closeCreator(); return; }
  crStep--; renderCreatorStep();
};

if(crEl.prev) crEl.prev.onclick=()=>{
  if(crGenerating)return;
  if(crResult){ crResult=null; crStep=0; crState.name=""; openCreator(); return; }
  if(crStep>0){ crStep--; renderCreatorStep(); }
};

if(crEl.next) crEl.next.onclick=()=>{
  if(crGenerating)return;
  if(crResult){
    pid=crResult.id; closeCreator();
    if(EL.msgs)EL.msgs.innerHTML="";chatHdr();
    addMsg(crResult.greeting||"Привет!","b"); go("pageChat"); return;
  }
  if(crStep<TOTAL_CR_STEPS-1){ crStep++; renderCreatorStep(); }
  else { crFinish(); }
};

const openCreatorBtn = $("openCreatorBtn");
if (openCreatorBtn) openCreatorBtn.onclick = () => openCreator();

/* ── CSS Avatar Builder ── */
const AV_GRADIENTS = {
  european: ["#f8b4b4","#e879a8","#c06080"],
  asian: ["#f0b4e0","#c88edd","#9060c0"],
  latina: ["#ffc878","#f09050","#d06040"],
  dark: ["#c894ff","#9060c0","#5a3080"],
  slavic: ["#94c8ff","#6090d0","#4060a0"],
  arab: ["#ffd078","#e0a050","#b07030"],
};
const AV_HAIR = {
  blonde:"#ffd700",brunette:"#8b6040",redhead:"#e84020",
  pink:"#ff69b4",blue:"#40a0f0",black:"#303030",
};
const AV_EYES = {
  brown:"#8b5e3c",blue:"#4080e0",green:"#40a060",grey:"#808898",violet:"#9040c0",
};
const AV_BODY_ICON = { slim:"\u{1F9CD}\u200D\u2640\uFE0F", athletic:"\u{1F3CB}\uFE0F\u200D\u2640\uFE0F", curvy:"\u{1F483}", petite:"\u{1F338}" };
const AV_OUTFIT_ICON = { casual:"\u{1F455}", elegant:"\u{1F457}", sporty:"\u{1F3BD}", bold:"\u{1F525}", cozy:"\u{1F9F8}" };
const AV_STYLE_ICON = { realistic:"\u{1F4F7}", anime:"\u{1F3A8}" };

function buildCssAvatar(cp, name, size){
  if(!cp) return "";
  const g = AV_GRADIENTS[cp.ethnicity] || AV_GRADIENTS.european;
  const hc = AV_HAIR[cp.hairColor] || AV_HAIR.brunette;
  const ec = AV_EYES[cp.eyeColor] || AV_EYES.brown;
  const bodyIc = AV_BODY_ICON[cp.body] || "\u{1F9CD}\u200D\u2640\uFE0F";
  const outIc = AV_OUTFIT_ICON[cp.outfit] || "\u{1F455}";
  const styleIc = AV_STYLE_ICON[cp.artStyle] || "";
  const letter = (name||"?").charAt(0).toUpperCase();

  if(size==="mini"){
    return `<div class="css-av-mini" style="background:linear-gradient(135deg,${g[0]},${g[2]})">
      <span class="css-av-icon">${bodyIc}</span>
    </div>`;
  }

  return `<div class="css-av">
    <div class="css-av-bg" style="background:linear-gradient(160deg,${g[0]} 0%,${g[1]} 50%,${g[2]} 100%)"></div>
    <div class="css-av-glow" style="background:${hc}"></div>
    <div class="css-av-ring"></div>
    <div class="css-av-ring2"></div>
    <span class="css-av-icon">${bodyIc}</span>
    <span class="css-av-letter">${letter}</span>
    <div class="css-av-traits">
      <span class="css-av-trait">${outIc}</span>
      <span class="css-av-trait" style="color:${hc}">●</span>
      <span class="css-av-trait" style="color:${ec}">◉</span>
      ${styleIc?`<span class="css-av-trait">${styleIc}</span>`:""}
    </div>
    <div class="css-av-stripe" style="background:linear-gradient(90deg,${hc},${ec})"></div>
  </div>`;
}

/* ── Characters ── */
function cur(){return personas.find(p=>p.id===pid)||personas[0]}

async function pick(id){
  const p=personas.find(x=>x.id===id);
  if(p?.premium&&plan!=="pro"){go("pageProfile");addMsg(`${p.name} доступна только на Pro.`,"s");return}
  pid=id;renderCards();chatHdr();
  if(EL.msgs)EL.msgs.innerHTML="";if(EL.giftPanel)EL.giftPanel.classList.remove("open");
  await loadHistory(id);go("pageChat");
}

async function loadHistory(pId){
  try{
    const r=await apiGet(`/api/history?personaId=${encodeURIComponent(pId)}&limit=30`);
    if(!r.ok)return;const d=await r.json();const msgs=d.messages||[];
    if(!msgs.length)return;
    for(const m of msgs)addMsg(m.content,m.role==="assistant"?"b":"u");
  }catch(e){logError("loadHistory",e)}
}

function renderCards(){
  if(!EL.grid)return;
  if(!personas.length){EL.grid.innerHTML=Array(4).fill(0).map(()=>'<div class="skeleton skeleton-card"></div>').join("");return}
  EL.grid.innerHTML="";
  for(const p of personas){
    const locked=p.premium&&plan!=="pro";
    const a=affFor(p.id);const pct=affPct(a);
    const c=document.createElement("div");
    c.className=`card${p.id===pid?" selected":""}${locked?" locked":""}`;
    const img=p.avatar?.startsWith("/")?p.avatar:"";
    const hasCssAv=!img&&p.creatorParams;
    const bgStyle=img?"":(hasCssAv?"":(p.color?`background:linear-gradient(135deg,${p.color},${p.color}88)`:"background:var(--surface-2)"));
    const bgInner=hasCssAv?buildCssAvatar(p.creatorParams,p.name):(!img&&p.name?`<span class="card-custom-av">${p.name.charAt(0)}</span>`:"");
    const isCustom = !!p.custom;
    c.innerHTML=`
      <div class="card-bg" style="${bgStyle}">${bgInner}</div>
      ${locked?'<div class="card-lock">🔒 PRO</div>':""}
      ${isCustom?'<button class="card-del" data-id="'+esc(p.id)+'" title="Удалить">✕</button>':""}
      <div class="card-body">
        <div class="card-name">${esc(p.name)}</div>
        <div class="card-desc">${esc(p.description||p.style)}</div>
        <div class="card-aff">
          <span class="card-aff-heart">❤️</span>
          <span class="card-aff-lvl">${a.level}</span>
          <div class="card-aff-bar"><div class="card-aff-fill" style="width:${pct}%"></div></div>
        </div>
      </div>`;
    if(img){const bg=c.querySelector(".card-bg");if(bg)bg.dataset.bg=img}
    c.onclick=()=>pick(p.id);
    const delBtn = c.querySelector(".card-del");
    if(delBtn) delBtn.onclick = (e) => { e.stopPropagation(); deletePersona(p.id, p.name); };
    EL.grid.appendChild(c);
  }
  if("IntersectionObserver" in window){
    const obs=new IntersectionObserver((entries)=>{
      for(const e of entries){if(e.isIntersecting&&e.target.dataset.bg){e.target.style.backgroundImage=`url('${safeUrl(e.target.dataset.bg)}')`;delete e.target.dataset.bg;obs.unobserve(e.target)}}
    },{rootMargin:"200px"});
    EL.grid.querySelectorAll(".card-bg[data-bg]").forEach(el=>obs.observe(el));
  }else{
    EL.grid.querySelectorAll(".card-bg[data-bg]").forEach(el=>{el.style.backgroundImage=`url('${safeUrl(el.dataset.bg)}')`;delete el.dataset.bg});
  }
}

async function deletePersona(personaId, name) {
  if (!confirm(`Удалить ${name}?`)) return;
  try {
    const r = await apiPost("/api/delete-custom-persona", { personaId });
    if (!r.ok) { showToast("Ошибка удаления"); return; }
    personas = personas.filter(p => p.id !== personaId);
    if (pid === personaId) pid = personas[0]?.id || "luna";
    renderCards();
    showToast(`${name} удалена`);
  } catch(e) { logError("deletePersona",e); showToast("Ошибка удаления"); }
}

/* ── Chat context & moments ── */
let chatContextCache=null;
async function loadChatContext(){
  try{
    const r=await apiGet(`/api/chat-context?personaId=${encodeURIComponent(pid)}`);
    if(!r.ok)return;const d=await r.json();
    chatContextCache=d;
    if(EL.chatContextStatus)EL.chatContextStatus.textContent=d.statusMessage||"";
    const a=d.affection||affFor(pid);
    if(EL.affPill)EL.affPill.textContent=`❤️ ${a.level} · ${a.label}`;
    if(d.girlMood) updateGirlMoodUI(d.girlMood);
  }catch(e){logError("loadChatContext",e)}
}
function openMomentsPanel(){
  const p=cur();if(!p)return;
  if(EL.momentsAvatar){
    if(p.avatar?.startsWith("/"))EL.momentsAvatar.innerHTML=`<img src="${p.avatar}" alt="">`;
    else if(p.creatorParams)EL.momentsAvatar.innerHTML=buildCssAvatar(p.creatorParams,p.name,"mini");
    else{EL.momentsAvatar.textContent=(p.name||"?").charAt(0);EL.momentsAvatar.style.background=p.color||"var(--accent)"}
  }
  if(EL.momentsName)EL.momentsName.textContent=p.name;
  const ctx=chatContextCache||{affection:affFor(pid),statusMessage:"",lastGift:null,lastDateScenario:null};
  if(EL.momentsStatus)EL.momentsStatus.textContent=ctx.statusMessage?ctx.statusMessage+" · "+ctx.affection.label:ctx.affection.label;
  if(EL.momentsList){
    EL.momentsList.innerHTML="";
    const gm = currentGirlMood;
    const items=[
      {emoji:gm.emoji,text:"Настроение сейчас",sub:gm.label+(gm.reason?" — "+gm.reason:""),color:gm.color},
      {emoji:"❤️",text:"Уровень отношений",sub:ctx.affection.label+" · "+ctx.affection.level},
    ];
    if(ctx.lastGift)items.push({emoji:ctx.lastGift.emoji||"🎁",text:"Последний подарок",sub:ctx.lastGift.name});
    items.forEach(i=>{
      const div=document.createElement("div");div.className="moments-item";
      if(i.color) div.style.borderColor=i.color+"33";
      div.innerHTML=`<span class="moments-item-emoji">${i.emoji}</span><div><div class="moments-item-text">${esc(i.text)}</div><div class="moments-item-sub">${esc(i.sub)}</div></div>`;
      EL.momentsList.appendChild(div);
    });
    const tlBtn=document.createElement("div");tlBtn.className="moments-item";tlBtn.style.cursor="pointer";tlBtn.style.borderColor="var(--accent)";
    tlBtn.innerHTML=`<span class="moments-item-emoji">💫</span><div><div class="moments-item-text" style="color:var(--accent)">История отношений</div><div class="moments-item-sub">Открыть таймлайн</div></div>`;
    tlBtn.onclick=()=>{if(EL.momentsPanel)EL.momentsPanel.classList.remove("open");loadTimeline();if(EL.timelinePanel)EL.timelinePanel.classList.add("open")};
    EL.momentsList.appendChild(tlBtn);
  }
  if(EL.momentsPanel)EL.momentsPanel.classList.add("open");
}
if(EL.chatAv)EL.chatAv.addEventListener("click",openMomentsPanel);
if(EL.momentsClose)EL.momentsClose.onclick=()=>{if(EL.momentsPanel)EL.momentsPanel.classList.remove("open")};

/* ── Chat ── */
function chatHdr(){
  const p=cur();if(!p)return;
  if(EL.chatAv){
    if(p.avatar?.startsWith("/")) EL.chatAv.innerHTML=`<img src="${p.avatar}" alt="${esc(p.name)}">`;
    else if(p.creatorParams) EL.chatAv.innerHTML=buildCssAvatar(p.creatorParams,p.name,"mini");
    else EL.chatAv.innerHTML=`<span class="chat-av-letter" style="background:${p.color||'var(--accent)'}">${esc((p.name||"?").charAt(0))}</span>`;
  }
  if(EL.chatNm)EL.chatNm.textContent=p.name;if(EL.chatSt)EL.chatSt.textContent="Онлайн";
  const a=affFor(pid);
  if(EL.affPill)EL.affPill.textContent=`❤️ ${a.level} · ${a.label}`;
  if(EL.chatContextStatus)EL.chatContextStatus.textContent=chatContextCache?.statusMessage||"";
  if(EL.chatMoodLabel)EL.chatMoodLabel.textContent=MOOD_LABELS[mood]?"· "+MOOD_LABELS[mood]:"";
  setChatMoodClass();
}

function addMsg(text,type){
  if(!EL.msgs)return;
  const row=document.createElement("div");row.className=`bubble-row ${type}`;
  if(type==="b"){const p=cur();
    if(p?.avatar?.startsWith("/")){const av=document.createElement("div");av.className="bubble-mini-av";av.innerHTML=`<img src="${p.avatar}" alt="">`;row.appendChild(av)}
    else if(p?.creatorParams){const av=document.createElement("div");av.className="bubble-mini-av";av.innerHTML=buildCssAvatar(p.creatorParams,p.name,"mini");row.appendChild(av)}}
  const bbl=document.createElement("div");bbl.className=`bubble ${type}`;bbl.textContent=text;
  if(type==="b"){const fav=document.createElement("button");fav.className="bubble-fav";fav.textContent="♥";
    fav.onclick=e=>{e.stopPropagation();fav.classList.add("saved");saveFav(text)};bbl.appendChild(fav)}
  row.appendChild(bbl);EL.msgs.appendChild(row);EL.msgs.scrollTop=EL.msgs.scrollHeight;
}

async function saveFav(text){try{await apiPost("/api/favorite",{personaId:pid,content:text})}catch(e){logError("saveFav",e)}}
function setTyping(v){
  if(EL.typing)EL.typing.classList.toggle("on",v);
  if(EL.chatSt)EL.chatSt.textContent=v?"Печатает...":"Онлайн";
  if(v&&EL.msgs)EL.msgs.scrollTop=EL.msgs.scrollHeight;
  const av=$("chatAvatar");if(av)av.classList.toggle("pulse",v);
}

function showToast(msg,dur=3000){
  const t=document.createElement("div");t.className="toast";t.textContent=msg;
  document.body.appendChild(t);setTimeout(()=>t.remove(),dur);
}

const CHAT_TIMEOUT = 90000;
async function doSend(text){
  sending=true;
  if(EL.send){EL.send.disabled=true;EL.send.classList.add("loading");EL.send.innerHTML='<span class="send-spin"></span>'}
  setTyping(true);
  try{
    const r=await apiPost("/api/chat",{personaId:pid,message:text,mood}, CHAT_TIMEOUT);
    if(!r.ok){const e=await r.json().catch(()=>({}));if(e.limitReached&&e.upgrade){showUpgradePrompt();return}throw new Error(e.error||"Ошибка")}
    const d=await r.json();
    if(d.jealousy)addMsg(d.jealousy,"s");
    addMsg(d.reply,"b");
    if(d.girlMood) updateGirlMoodUI(d.girlMood);
    if(d.affection){affections[pid]=d.affection;chatHdr();renderCards()}
    if(d.limitToday!==undefined){
      plan=d.plan||plan;
      if(EL.lim)EL.lim.textContent=d.limitToday;if(EL.used)EL.used.textContent=d.usageToday;if(EL.left)EL.left.textContent=d.remainingToday;
      updateChatLimitBar(d.remainingToday, d.limitToday);
    }
    if(d.newAchievements?.length)d.newAchievements.forEach(id=>showAchievementPopup(id));
    if(d.challengeCompleted){addMsg("Вызов пройден! +"+(d.challengeBonus||20)+" сообщений. 🎉","s");loadProf()}
  }catch(e){addMsg(e?.name==="AbortError"?"Сервер не ответил. Проверь интернет и попробуй снова.":`Ошибка: ${e?.message||e}`,"s")}
  finally{
    setTyping(false);sending=false;
    if(EL.send){EL.send.disabled=false;EL.send.classList.remove("loading");EL.send.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>'}
  }
}

let _lastSendTs=0;
async function send(){const now=Date.now();if(now-_lastSendTs<500)return;_lastSendTs=now;const t=EL.input?EL.input.value.trim():"";if(!t||sending)return;EL.input.value="";addMsg(t,"u");await doSend(t)}
if(EL.send)EL.send.onclick=send;
if(EL.input)EL.input.addEventListener("keydown",e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();send()}});
document.querySelectorAll(".mood-chip").forEach(b=>{b.addEventListener("click",()=>{
  document.querySelectorAll(".mood-chip").forEach(x=>x.classList.remove("on"));b.classList.add("on");mood=b.dataset.mood;
  if(EL.chatMoodLabel)EL.chatMoodLabel.textContent=MOOD_LABELS[mood]?"· "+MOOD_LABELS[mood]:"";setChatMoodClass()})});

/* ── Chat Menu Dropdown ── */
function closeChatMenu(){ if(EL.chatMenuDropdown) EL.chatMenuDropdown.classList.remove("open"); }
if(EL.chatMenuBtn) EL.chatMenuBtn.onclick = (e) => {
  e.stopPropagation();
  EL.chatMenuDropdown && EL.chatMenuDropdown.classList.toggle("open");
};
if(EL.menuGift) EL.menuGift.onclick = () => { closeChatMenu(); if(EL.giftPanel){EL.giftPanel.classList.toggle("open");if(EL.giftPanel.classList.contains("open"))renderGifts();} };
if(EL.menuTimeline) EL.menuTimeline.onclick = () => { closeChatMenu(); loadTimeline(); if(EL.timelinePanel) EL.timelinePanel.classList.add("open"); };
if(EL.menuDiary) EL.menuDiary.onclick = () => { closeChatMenu(); loadDiary(); if(EL.diaryPanel) EL.diaryPanel.classList.add("open"); };
document.addEventListener("click", (e) => {
  if(EL.chatMenuDropdown && EL.chatMenuDropdown.classList.contains("open") && !EL.chatMenuDropdown.contains(e.target) && e.target !== EL.chatMenuBtn) closeChatMenu();
});

/* ── Emoji Picker ── */
const EMOJI_DATA = [
  { cat:"Смайлы", items:["😊","😂","🥰","😍","😘","😜","🤗","😏","😢","😭","😡","🥺","😳","🤔","😴","🤩","🥳","😎","🤭","🫣","😇","🥹","😤","💀","👻"] },
  { cat:"Любовь", items:["❤️","🧡","💛","💚","💙","💜","🖤","🤍","💕","💗","💖","💘","💝","💞","🫶","😻","💋","🌹","🔥","✨"] },
  { cat:"Жесты", items:["👍","👎","👏","🤝","✌️","🤞","🤟","👋","💪","🫂","🙏","🤙","👌","🫡","🫰","✊","👊","🖐️","🤚","👆"] },
  { cat:"Животные", items:["🐱","🐶","🐻","🦊","🐰","🐼","🦄","🐸","🐧","🦋","🐝","🐞","🐣","🐾","🐳","🦭","🐨","🐮","🐷","🐵"] },
  { cat:"Еда", items:["🍕","🍔","🍟","🍣","🍩","🍪","🧁","🍰","🍫","🎂","🍓","🍑","🍒","🍌","🥂","🍷","🍻","☕","🧃","🫧"] },
  { cat:"Разное", items:["⭐","🌙","☀️","🌈","💎","🎵","🎶","🎀","🎯","🏆","👑","💡","📸","💌","🎈","🎉","🎊","🪄","🎭","🌸"] }
];
function buildEmojiPicker() {
  if(!EL.emojiPicker) return;
  let html = "";
  for(const cat of EMOJI_DATA) {
    html += `<div class="emoji-cat-title">${cat.cat}</div><div class="emoji-grid">`;
    for(const em of cat.items) html += `<button type="button" class="emoji-item" data-em="${em}">${em}</button>`;
    html += `</div>`;
  }
  EL.emojiPicker.innerHTML = html;
  EL.emojiPicker.addEventListener("click", (e) => {
    const btn = e.target.closest(".emoji-item");
    if(!btn) return;
    const em = btn.dataset.em;
    if(EL.input) { EL.input.value += em; EL.input.focus(); }
  });
}
buildEmojiPicker();
if(EL.emojiToggleBtn) EL.emojiToggleBtn.onclick = () => {
  if(!EL.emojiPicker) return;
  const isOpen = !EL.emojiPicker.classList.contains("hidden");
  EL.emojiPicker.classList.toggle("hidden");
  EL.emojiToggleBtn.classList.toggle("active", !isOpen);
  if(!isOpen && EL.moodToggleBtn) { const mb = $("moodBar"); if(mb && !mb.classList.contains("hidden")){ mb.classList.add("hidden"); EL.moodToggleBtn.classList.remove("active"); } }
};
if(EL.moodToggleBtn) EL.moodToggleBtn.onclick = () => {
  const mb = $("moodBar");
  if(!mb) return;
  const isOpen = !mb.classList.contains("hidden");
  mb.classList.toggle("hidden");
  EL.moodToggleBtn.classList.toggle("active", !isOpen);
  if(!isOpen && EL.emojiPicker) { EL.emojiPicker.classList.add("hidden"); if(EL.emojiToggleBtn) EL.emojiToggleBtn.classList.remove("active"); }
};

/* ── Gifts ── */
const topUpBtn=document.getElementById("giftTopUpBtn");
if(topUpBtn)topUpBtn.onclick=()=>topUpBalance(50);

/* ── Quiz: Чья ты пара ── */
const QUIZ_QUESTIONS=[
  {q:"Какой отдых тебе ближе?",opts:[{t:"Романтика при свечах",p:"luna"},{t:"Тусовка с друзьями",p:"sofi"},{t:"Тренировка на природе",p:"nika"}]},
  {q:"Как ты решаешь конфликты?",opts:[{t:"Говорю по душам",p:"mila"},{t:"Остро и с огоньком",p:"roksi"},{t:"Беру ситуацию под контроль",p:"eva"}]},
  {q:"Что важнее в партнёре?",opts:[{t:"Тепло и забота",p:"mila"},{t:"Ум и вызов",p:"kira"},{t:"Таинственность",p:"zlata"}]},
  {q:"Идеальное свидание?",opts:[{t:"Уютное кафе",p:"luna"},{t:"Ночной город",p:"zlata"},{t:"Выставка или галерея",p:"dana"}]},
  {q:"Как тебе нравится флиртовать?",opts:[{t:"Нежно и робко",p:"aria"},{t:"Дерзко и открыто",p:"nova"},{t:"Играю и дразню",p:"zlata"}]},
  {q:"Что тебя больше привлекает?",opts:[{t:"Когда она командует",p:"eva"},{t:"Когда она рисует тебя",p:"dana"},{t:"Когда она вызывает на спор",p:"nika"}]},
  {q:"Как начать утро?",opts:[{t:"Кофе в постель вдвоём",p:"luna"},{t:"Пробежка вместе",p:"nika"},{t:"Философский разговор",p:"dana"}]},
];
let quizStep=0;let quizScores={};
function openQuiz(){
  quizStep=0;quizScores={};
  document.getElementById("quizOverlay")?.classList.remove("off");
  renderQuizStep();
}
function closeQuiz(){document.getElementById("quizOverlay")?.classList.add("off")}
function renderQuizStep(){
  const screen=document.getElementById("quizScreen");
  if(!screen)return;
  if(quizStep<QUIZ_QUESTIONS.length){
    const q=QUIZ_QUESTIONS[quizStep];
    screen.innerHTML=`
      <div class="quiz-title">Вопрос ${quizStep+1} из ${QUIZ_QUESTIONS.length}</div>
      <p class="quiz-q">${q.q}</p>
      <div class="quiz-opts" id="quizOpts"></div>`;
    const opts=document.getElementById("quizOpts");
    q.opts.forEach(o=>{
      const b=document.createElement("button");b.type="button";b.className="quiz-opt";b.textContent=o.t;
      b.onclick=()=>{quizScores[o.p]=(quizScores[o.p]||0)+1;quizStep++;renderQuizStep();};
      opts.appendChild(b);
    });
    return;
  }
  const ids=Object.keys(quizScores);let best=ids[0]||"luna";ids.forEach(id=>{if((quizScores[id]||0)>(quizScores[best]||0))best=id});
  const persona=personas.find(p=>p.id===best)||personas[0];
  const av=persona.avatar?.startsWith("/")?`<img src="${persona.avatar}" alt="">`:"<span style='font-size:32px'>"+(persona.name||"?").charAt(0)+"</span>";
  screen.innerHTML=`
    <div class="quiz-title">Твоя пара</div>
    <div class="quiz-result-av" style="background:${persona.color||'var(--accent)'}">${av}</div>
    <div class="quiz-result-name">${esc(persona.name)}</div>
    <div class="quiz-result-desc">${esc(persona.description||persona.style||"")}</div>
    <button type="button" class="quiz-result-btn" id="quizWriteBtn">Написать ${esc(persona.name)}</button>`;
  document.getElementById("quizWriteBtn")?.addEventListener("click",()=>{pick(persona.id);go("pageChat");closeQuiz();});
}
document.getElementById("quizOpenBtn")?.addEventListener("click",openQuiz);
document.getElementById("quizOverlay")?.addEventListener("click",e=>{if(e.target.id==="quizOverlay")closeQuiz()});

function renderGifts(){
  if(!EL.giftGrid)return;
  const balanceEl=document.getElementById("giftBalance");
  if(balanceEl)balanceEl.innerHTML=`Баланс: ${starsBalance} ⭐ <button type="button" class="topup-btn" id="topupStarsBtn">Пополнить</button>`;
  const topupBtn=document.getElementById("topupStarsBtn");
  if(topupBtn)topupBtn.onclick=()=>showTopupModal();
  EL.giftGrid.innerHTML="";
  for(const g of gifts){
    const canAfford=starsBalance>=g.stars;
    const d=document.createElement("div");d.className="gift-item";
    d.innerHTML=`
      <span class="gift-emoji">${g.emoji}</span>
      <div class="gift-name">${g.name}</div>
      <div class="gift-price">⭐ ${g.stars}</div>
      <div class="gift-xp">+${g.xp} XP</div>
      <button type="button" class="gift-btn" ${!canAfford?"disabled":""}>${canAfford?"Подарить":`Нужно ${g.stars} ⭐`}</button>`;
    const btn=d.querySelector(".gift-btn");
    if(btn&&canAfford)btn.onclick=(e)=>{e.stopPropagation();sendGift(g.id)};
    EL.giftGrid.appendChild(d);
  }
}

function showTopupModal(){
  const presets=[50,100,250,500,1000];
  const overlay=document.createElement("div");
  overlay.className="topup-overlay";
  overlay.setAttribute("role","dialog");
  overlay.setAttribute("aria-modal","true");
  overlay.setAttribute("aria-label","Пополнение баланса");
  overlay.innerHTML=`<div class="topup-modal">
    <h3>Пополнить баланс Stars</h3>
    <div class="topup-presets">${presets.map(a=>`<button class="topup-preset-btn" data-amount="${a}">${a} ⭐</button>`).join("")}</div>
    <button class="topup-close-btn" aria-label="Закрыть">Закрыть</button>
  </div>`;
  document.body.appendChild(overlay);
  trapFocus(overlay);
  overlay.querySelector(".topup-close-btn").onclick=()=>{releaseFocus(overlay);overlay.remove()};
  overlay.onclick=e=>{if(e.target===overlay){releaseFocus(overlay);overlay.remove()}};
  overlay.querySelectorAll(".topup-preset-btn").forEach(btn=>{
    btn.onclick=async()=>{
      const amount=Number(btn.dataset.amount);
      try{
        showToast("Создаю платёж...");
        const r=await apiPost("/api/create-invoice",{type:"stars",amount});
        const d=await r.json();
        if(d.invoiceLink&&window.Telegram?.WebApp?.openInvoice){
          window.Telegram.WebApp.openInvoice(d.invoiceLink,(status)=>{
            if(status==="paid"){showToast(`+${amount} ⭐ на балансе!`);overlay.remove();loadProf();renderGifts()}
            else showToast("Оплата отменена");
          });
        }else if(d.invoiceLink){window.open(d.invoiceLink,"_blank")}
      }catch(e){logError("topUp",e);showToast("Ошибка")}
    };
  });
}

async function sendGift(giftId){
  try{
    const r=await apiPost("/api/gift",{personaId:pid,giftId});
    const e=await r.json().catch(()=>({}));
    if(!r.ok){addMsg(e.error||"Ошибка","s");return}
    if(e.starsBalance!==undefined)starsBalance=e.starsBalance;
    addMsg(e.reaction,"b");
    if(e.affection){affections[pid]=e.affection;chatHdr();renderCards()}
    if(e.newAchievements?.length)e.newAchievements.forEach(id=>showAchievementPopup(id));
    renderGifts();
    if(EL.giftPanel)EL.giftPanel.classList.remove("open");
  }catch(err){addMsg("Ошибка отправки подарка","s")}
}

/* ── Profile ── */
function setProfAvatar(name){
  const letter=(name||"П").trim().charAt(0).toUpperCase();
  if(EL.profAv)EL.profAv.textContent=letter;EL.profAv?.classList.remove("has-img");
}
function renderProfileRelationships(){
  if(!EL.profileRelationships)return;
  EL.profileRelationships.innerHTML="";
  for(const p of personas){
    const locked=p.premium&&plan!=="pro";
    const a=affFor(p.id);const pct=affPct(a);
    const row=document.createElement("div");
    row.className=`relation-row${locked?" locked":""}`;
    const avContent=p.avatar?.startsWith("/")
      ?`<img src="${p.avatar}" alt="${esc(p.name)}">`
      :(p.name||"?").charAt(0);
    const avStyle=p.avatar?.startsWith("/")?"":`style="background:${p.color||'var(--accent)'}"`;
    row.innerHTML=`
      <div class="relation-av" ${avStyle}>${avContent}</div>
      <div class="relation-body">
        <div class="relation-name">${esc(p.name)}</div>
        <div class="relation-lvl">❤️ ${esc(a.label)} · ${a.level}/7</div>
        <div class="relation-bar-wrap"><div class="relation-bar" style="width:${pct}%"></div></div>
      </div>
      <button type="button" class="relation-act" ${locked?"disabled":""}>Написать</button>`;
    const btn=row.querySelector(".relation-act");
    if(btn&&!locked)btn.onclick=()=>{pick(p.id);go("pageChat");};
    EL.profileRelationships.appendChild(row);
  }
}
function updProf(d){
  plan=d.plan||"free";
  if(EL.profName)EL.profName.textContent=d.userName||userName||"Пользователь";
  setProfAvatar(d.userName||userName);
  if(EL.badge){EL.badge.textContent=plan==="pro"?"Pro":"Free";EL.badge.className=`prof-badge ${plan}`;}
  if(plan==="pro"&&EL.badge){
    if(d.trialEndsAt){
      const dl=Math.max(0,Math.ceil((new Date(d.trialEndsAt).getTime()-Date.now())/864e5));
      if(dl>0)EL.badge.innerHTML=`Pro <span class="trial-tag">Пробный: ${dl} ${decl(dl)}</span>`;
    }else if(d.proExpiresAt){
      const dl=Math.max(0,Math.ceil((new Date(d.proExpiresAt).getTime()-Date.now())/864e5));
      EL.badge.innerHTML=`Pro <span class="trial-tag">${dl} ${decl(dl)}</span>`;
    }
  }
  if(EL.lim)EL.lim.textContent=d.limitToday??"-";if(EL.used)EL.used.textContent=d.usageToday??"-";if(EL.left)EL.left.textContent=d.remainingToday??"-";
  if(EL.planF)EL.planF.classList.toggle("on",plan==="free");if(EL.planP)EL.planP.classList.toggle("on",plan==="pro");
  updateChatLimitBar(d.remainingToday, d.limitToday);
  if(d.streak!==undefined){if(EL.strk)EL.strk.textContent=`${d.streak} ${decl(d.streak)}`;if(EL.strkB)EL.strkB.textContent=`Рекорд: ${d.longestStreak||0}`}
  
  if(d.starsBalance!==undefined)starsBalance=d.starsBalance;
  if(d.affections)affections=d.affections;
  renderProfileRelationships();
  renderChallenge(d.challenge);
  renderCards();
}

function decl(n){const a=Math.abs(n)%100,l=a%10;if(a>10&&a<20)return"дней";if(l===1)return"день";return l>=2&&l<=4?"дня":"дней"}

function renderChallenge(ch){
  const box=document.getElementById("profileChallenge");
  if(!box)return;
  const basePersonas=personas.filter(p=>!String(p.id).startsWith("custom_"));
  if(!ch){
    box.innerHTML=`
      <p class="challenge-desc">7 дней подряд пиши одной девушке — получи +20 сообщений и эксклюзив.</p>
      <div class="challenge-pick" id="challengePick"></div>
      <button type="button" class="challenge-start" id="challengeStartBtn" disabled>Выбери девушку</button>`;
    const pickEl=document.getElementById("challengePick");
    basePersonas.forEach(p=>{
      const btn=document.createElement("button");btn.type="button";btn.className="challenge-pick-btn"+(challengeSelectedPersonaId===p.id?" on":"");
      btn.dataset.personaId=p.id;
      if(p.avatar?.startsWith("/"))btn.innerHTML=`<img src="${p.avatar}" alt="">`;else btn.textContent=(p.name||"?").charAt(0);btn.style.background=p.color||"var(--surface-2)";
      btn.onclick=()=>{challengeSelectedPersonaId=p.id;renderChallenge(null);};
      pickEl.appendChild(btn);
    });
    const startBtn=document.getElementById("challengeStartBtn");
    if(startBtn){
      startBtn.onclick=async()=>{if(!challengeSelectedPersonaId)return;startBtn.disabled=true;startBtn.textContent="...";
        try{const r=await apiPost("/api/challenge/start",{personaId:challengeSelectedPersonaId});if(r.ok){await loadProf();}else startBtn.disabled=false;}catch(e){logError("startChallenge",e);startBtn.disabled=false;}
        startBtn.textContent="Начать вызов";};
    }
    const sel=challengeSelectedPersonaId?basePersonas.find(p=>p.id===challengeSelectedPersonaId):null;
    if(sel&&startBtn){startBtn.disabled=false;startBtn.textContent="Начать вызов с "+sel.name;}
    return;
  }
  if(ch.completedAt){
    const p=personas.find(x=>x.id===ch.personaId)||{name:"Подруга"};
    box.innerHTML=`
      <p class="challenge-done">✅ Вызов пройден! +20 сообщений.</p>
      <button type="button" class="challenge-share" id="challengeShareBtn">📤 Поделиться результатом</button>`;
    document.getElementById("challengeShareBtn")?.addEventListener("click",()=>{
      const t="Я 7 дней подряд общался с "+p.name+" в НейроСпутнике — прошёл вызов! 💕 Попробуй тоже!";
      navigator.clipboard.writeText(t).then(()=>{
        const b=document.getElementById("challengeShareBtn");
        if(b)b.textContent="✓ Скопировано!";
        setTimeout(()=>{if(b)b.textContent="📤 Поделиться результатом"},1500);
      }).catch(()=>{});
    });
    return;
  }
  const p=personas.find(x=>x.id===ch.personaId)||{name:"Подруга"};
  const days=ch.streakDays||0;
  box.innerHTML=`
    <p class="challenge-progress">Вызов: 7 дней с ${esc(p.name)}. Пиши ей каждый день!</p>
    <div class="challenge-bar-wrap"><div class="challenge-bar" style="width:${Math.min(100,(days/7)*100)}%"></div></div>
    <p class="challenge-desc">${days}/7 дней. Осталось ${7-days}.</p>`;
}
async function loadProf(){const r=await apiGet("/api/profile");if(!r.ok)return;updProf(await r.json())}

async function setPlan(p){
  if(p===plan)return;
  try{const r=await apiPost("/api/profile/plan",{plan:p});
    if(!r.ok)return;updProf(await r.json())}catch(e){logError("setPlan",e)}
}
if(EL.planF)EL.planF.onclick=()=>setPlan("free");
if(EL.planP)EL.planP.onclick=()=>{if(plan==="pro")return;if(tg?.openInvoice){buyPro();return}setPlan("pro")};

async function buyPro(){
  try{const r=await apiPost("/api/create-invoice",{type:"pro"});
    if(!r.ok){setPlan("pro");return}const d=await r.json();
    if(d.invoiceLink&&tg?.openInvoice)tg.openInvoice(d.invoiceLink,(s)=>{if(s==="paid")loadProf()});
    else setPlan("pro")}catch(e){logError("buyPro",e);setPlan("pro")}
}
async function topUpBalance(amount){
  if(!tg?.openInvoice)return;
  try{
    const r=await apiPost("/api/create-invoice",{type:"stars",amount:amount||50});
    if(!r.ok)return;
    const d=await r.json();
    if(d.invoiceLink)tg.openInvoice(d.invoiceLink,(s)=>{if(s==="paid"){loadProf();renderGifts()}});
  }catch(e){logError("topUpBalance",e)}
}

function showUpgradePrompt(){
  const overlay=document.createElement("div");
  overlay.className="upgrade-overlay";
  overlay.setAttribute("role","dialog");
  overlay.setAttribute("aria-modal","true");
  overlay.setAttribute("aria-label","Обновление до Pro");
  overlay.innerHTML=`
    <div class="upgrade-modal">
      <div class="upgrade-icon">💬</div>
      <h3>Сообщения закончились</h3>
      <p>Ты отправил все 20 бесплатных сообщений сегодня</p>
      <button class="upgrade-btn" id="upgradeProBtn">Перейти на Pro — 200 ⭐</button>
      <p class="upgrade-note">200 сообщений/день, все персонажи</p>
      <button class="upgrade-close" id="upgradeCloseBtn" aria-label="Закрыть">Подожду до завтра</button>
    </div>`;
  document.body.appendChild(overlay);
  trapFocus(overlay);
  document.getElementById("upgradeProBtn").onclick=async()=>{
    try{
      const r=await apiPost("/api/create-invoice",{type:"pro"});
      const d=await r.json();
      if(d.invoiceLink&&window.Telegram?.WebApp?.openInvoice){
        window.Telegram.WebApp.openInvoice(d.invoiceLink,(status)=>{
          if(status==="paid"){overlay.remove();showToast("Pro активирован!")}
        });
      }
    }catch(e){logError("upgradePrompt",e);showToast("Ошибка")}
  };
  document.getElementById("upgradeCloseBtn").onclick=()=>{releaseFocus(overlay);overlay.remove()};
}

/* ── Referral (new deep-link system) ── */
async function loadReferral() {
  const linkInput = document.getElementById("refLinkInput");
  const countEl = document.getElementById("refCount");
  const bonusEl = document.getElementById("refBonus");
  if (!linkInput) return;

  try {
    const r = await apiGet("/api/referral");
    if (!r.ok) return;
    const d = await r.json();

    const botUser = d.botUsername || "";
    const refLink = botUser ? `https://t.me/${botUser}?start=ref_${d.code}` : d.code;
    linkInput.value = refLink;
    if (countEl) countEl.textContent = d.count;
    if (bonusEl) bonusEl.textContent = d.totalBonus;
  } catch(e) {logError("loadReferral",e)}
}

const refCopyBtn = document.getElementById("refCopyBtn");
if (refCopyBtn) refCopyBtn.onclick = () => {
  const input = document.getElementById("refLinkInput");
  if (input) { navigator.clipboard.writeText(input.value).then(() => showToast("Ссылка скопирована!")); }
};

const refShareBtn = document.getElementById("refShareBtn");
if (refShareBtn) refShareBtn.onclick = () => {
  const input = document.getElementById("refLinkInput");
  if (input?.value && window.Telegram?.WebApp?.openTelegramLink) {
    const shareUrl = encodeURIComponent(input.value);
    const shareText = encodeURIComponent("Заходи в НейроСпутник — AI-девушки для общения! Тебе понравится 💕");
    window.Telegram.WebApp.openTelegramLink(`https://t.me/share/url?url=${shareUrl}&text=${shareText}`);
  } else if (navigator.share) {
    navigator.share({ title: "НейроСпутник", text: "AI-девушки для общения!", url: input?.value });
  } else {
    showToast("Скопируй ссылку и отправь другу");
  }
};

const refApplyBtn = document.getElementById("refApplyBtn");
if (refApplyBtn) refApplyBtn.onclick = async () => {
  const input = document.getElementById("refCodeInput");
  if (!input?.value.trim()) { showToast("Введи код"); return; }
  try {
    const r = await apiPost("/api/referral/apply", { code: input.value.trim() });
    const d = await r.json();
    if (r.ok) { showToast(d.message || "Бонус получен!"); loadReferral(); loadProf(); }
    else { showToast(d.error || "Ошибка"); }
  } catch(e) { logError("refApply",e); showToast("Ошибка"); }
};

/* ── Diary ── */
/* Diary via menu */
if(EL.diaryClose)EL.diaryClose.onclick=()=>{if(EL.diaryPanel)EL.diaryPanel.classList.remove("open")}

async function loadDiary(){
  if(!EL.diaryScroll)return;
  EL.diaryScroll.innerHTML='<div style="text-align:center;padding:20px;color:var(--muted)">Загрузка...</div>';
  try{
    const r=await apiGet(`/api/diary?personaId=${encodeURIComponent(pid)}`);
    if(!r.ok)return;
    const d=await r.json();
    const p=cur();
    EL.diaryScroll.innerHTML="";
    if(!d.entries?.length){EL.diaryScroll.innerHTML='<div style="text-align:center;padding:20px;color:var(--muted)">Дневник пока пуст</div>';return}
    const hdr=document.createElement("div");
    hdr.style.cssText="text-align:center;padding:0 0 12px;font-size:13px;color:var(--muted)";
    hdr.textContent=`Дневник ${p?.name||"девушки"} · Уровень ${d.currentLevel}/7`;
    EL.diaryScroll.appendChild(hdr);
    for(const e of d.entries){
      const div=document.createElement("div");
      div.className=`diary-entry${e.locked?" locked":""}`;
      div.innerHTML=`
        <div class="diary-entry-lvl">Уровень ${e.level}</div>
        ${e.locked
          ?'<div class="diary-entry-text">🔒 Разблокируй, повысив уровень отношений...</div><span class="diary-entry-lock">🔒</span>'
          :`<div class="diary-entry-text">"${esc(e.text)}"</div>`}`;
      EL.diaryScroll.appendChild(div);
    }
  }catch(e){logError("loadDiary",e);EL.diaryScroll.innerHTML='<div style="text-align:center;padding:20px;color:var(--muted)">Ошибка загрузки</div>'}
}

/* ── Achievements ── */
let allAchievements=[];
let achievUnlockedCount=0;
async function loadAchievements(){
  try{
    const r=await apiGet("/api/achievements");if(!r.ok)return;
    const d=await r.json();
    allAchievements=d.achievements||[];
    achievUnlockedCount=d.unlockedCount||0;
    renderAchievements();
    if(EL.achievCount)EL.achievCount.textContent=`${d.unlockedCount}/${d.totalCount}`;
  }catch(e){logError("loadAchievements",e)}
}

function renderAchievements(){
  if(!EL.achievGrid)return;
  EL.achievGrid.innerHTML="";
  if(!allAchievements.length){
    EL.achievGrid.innerHTML=`<div class="empty-state" style="grid-column:1/-1"><div class="empty-state-icon">🏆</div><div class="empty-state-title">Достижения</div><p class="empty-state-p">Напиши сообщение — откроешь первое достижение.</p><button type="button" class="empty-state-btn" onclick="go('pageChat')">В чат</button></div>`;
    return;
  }
  if(achievUnlockedCount===0){
    const empty=document.createElement("div");empty.className="empty-state";empty.style.gridColumn="1/-1";
    empty.innerHTML=`<div class="empty-state-icon">🏆</div><div class="empty-state-title">Пока нет достижений</div><p class="empty-state-p">Напиши сообщение — откроешь первое достижение.</p><button type="button" class="empty-state-btn">В чат</button>`;
    empty.querySelector("button").onclick=()=>go("pageChat");
    EL.achievGrid.appendChild(empty);
  }
  for(const a of allAchievements){
    const div=document.createElement("div");
    div.className=`achiev-item${a.unlocked?"":" locked"}`;
    div.innerHTML=`
      <span class="achiev-icon">${a.unlocked?esc(a.icon):"🔒"}</span>
      <div class="achiev-title">${esc(a.title)}</div>
      <div class="achiev-desc">${esc(a.desc)}</div>`;
    EL.achievGrid.appendChild(div);
  }
}

function showAchievementPopup(achievementId){
  const a=allAchievements.find(x=>x.id===achievementId);
  if(!a)return;
  const popup=document.createElement("div");
  popup.className="achiev-popup";
  popup.innerHTML=`<span class="achiev-popup-icon">${esc(a.icon||"🏆")}</span><span class="achiev-popup-text">Ачивка: ${esc(a.title)}!</span>`;
  document.body.appendChild(popup);
  setTimeout(()=>popup.remove(),3200);
}

/* ── Leaderboard ── */
async function loadLeaderboard(){
  if(!EL.leaderBody)return;
  try{
    const r=await apiGet("/api/leaderboard");if(!r.ok)return;
    const d=await r.json();
    EL.leaderBody.innerHTML="";
    if(!d.leaderboard?.length){EL.leaderBody.innerHTML='<tr><td colspan="3" style="text-align:center;color:var(--muted)">Пока пусто</td></tr>';return}
    for(const e of d.leaderboard){
      const rc=e.rank===1?"gold":e.rank===2?"silver":e.rank===3?"bronze":"";
      const tr=document.createElement("tr");
      if(e.isYou)tr.className="you";
      tr.innerHTML=`<td class="leader-rank ${rc}">${e.rank<=3?["🥇","🥈","🥉"][e.rank-1]:e.rank}</td><td>${e.isYou?"Ты":esc(e.name)}</td><td>${e.totalXp} XP</td>`;
      EL.leaderBody.appendChild(tr);
    }
  }catch(e){logError("loadLeaderboard",e)}
}

/* ── Quests ── */
async function loadQuests() {
  if (!EL.questsGrid) return;
  try {
    const r = await apiGet("/api/quests");
    if (!r.ok) return;
    const d = await r.json();
    renderQuests(d.quests || []);
  } catch(e) {logError("loadQuests",e)}
}

function renderQuests(quests) {
  if (!EL.questsGrid) return;
  EL.questsGrid.innerHTML = "";
  for (const q of quests) {
    const pct = Math.min(100, Math.round((q.progress / q.target) * 100));
    const done = q.status === "completed";
    const div = document.createElement("div");
    div.className = `quest-card${done ? " completed" : ""}`;
    div.innerHTML = `
      <div class="quest-icon">${esc(q.icon)}</div>
      <div class="quest-info">
        <div class="quest-title">${esc(q.title)}</div>
        <div class="quest-desc">${esc(q.desc)}</div>
        <div class="quest-progress">
          <div class="quest-bar"><div class="quest-fill" style="width:${pct}%"></div></div>
          <span class="quest-count">${q.progress}/${q.target}</span>
        </div>
      </div>
      <div class="quest-reward">${done ? "✅" : `+${q.reward.bonusMessages} 💬`}</div>`;
    EL.questsGrid.appendChild(div);
  }
}

/* ── Notification toggle ── */
let notifEnabled=false;
if(EL.notifSwitch)EL.notifSwitch.onclick=async()=>{
  notifEnabled=!notifEnabled;
  EL.notifSwitch.classList.toggle("on",notifEnabled);
  const best=findBestPersona();
  try{await apiPost("/api/settings/notifications",{enabled:notifEnabled,personaId:best})}catch(e){logError("notifToggle",e)}
};

function findBestPersona(){
  let best=null,maxLvl=0;
  for(const [id,a] of Object.entries(affections)){
    if(a.level>maxLvl){maxLvl=a.level;best=id}
  }
  return best||"luna";
}

async function loadNotifSettings(){
  try{
    const r=await apiGet("/api/settings/notifications");if(!r.ok)return;
    const d=await r.json();
    notifEnabled=d.settings?.enabled||false;
    if(EL.notifSwitch)EL.notifSwitch.classList.toggle("on",notifEnabled);
  }catch(e){logError("loadNotifSettings",e)}
}

/* ── Events ── */
async function loadEvents(){
  if(!EL.eventBanner)return;
  try{
    const r=await apiGet("/api/events");if(!r.ok)return;
    const d=await r.json();
    EL.eventBanner.innerHTML="";
    for(const ev of d.active||[]){
      const div=document.createElement("div");div.className="event-banner";
      div.innerHTML=`
        <span class="event-banner-emoji">${ev.emoji}</span>
        <span class="event-banner-text">${esc(ev.banner||ev.title)}</span>
        <span class="event-banner-tag">${ev.xpMultiplier>1?`x${ev.xpMultiplier} XP`:"Активен"}</span>`;
      EL.eventBanner.appendChild(div);
    }
  }catch(e){logError("loadEvents",e)}
}

/* ══════════════════════════════════════════════════
   FANTASY MODULE (direct scenario → filters → chat)
   ══════════════════════════════════════════════════ */
let fantasyScenarios=[];
let fcScenarioId=null, fcFilters={}, fcSetting=null, fcSending=false;
let fcCurrentScenario=null;
let fsState=null;

const FF_GROUPS=[
  {key:"character",title:"Характер",opts:[
    {id:"tender",label:"Нежная",icon:"💕"},{id:"bold",label:"Дерзкая",icon:"🔥"},
    {id:"shy",label:"Стеснительная",icon:"🙈"},{id:"playful",label:"Игривая",icon:"😜"},
    {id:"mysterious",label:"Загадочная",icon:"🌙"},{id:"cold",label:"Властная",icon:"👑"}]},
  {key:"flirtLevel",title:"Стиль флирта 18+",opts:[
    {id:"open",label:"Открытый 💋"},{id:"moderate",label:"Умеренный 😏"},{id:"shy",label:"Стеснительный 🙊"}]},
  {key:"initiative",title:"Кто ведёт?",opts:[
    {id:"she_leads",label:"Она ведёт 👸"},{id:"you_lead",label:"Ты ведёшь 🤴"},{id:"equal",label:"На равных 🤝"}]},
  {key:"defaultMood",title:"Настроение",opts:[
    {id:"playful",label:"Игривое 😄"},{id:"romantic",label:"Романтичное 💕"},
    {id:"provocative",label:"Провокационное 😈"},{id:"tender",label:"Нежное 🥰"}]},
  {key:"style",title:"Стиль общения",opts:[
    {id:"sweet",label:"Ласковый 🍭"},{id:"sarcastic",label:"Саркастичный 😼"},
    {id:"simple",label:"Простой 🤙"},{id:"intellectual",label:"Интеллектуальный 🧠"}]},
];

async function fantasyInit(){
  try{
    const accessR=await apiGet("/api/fantasy/access");
    const accessD=await accessR.json();
    if(!accessD.hasAccess){showFantasyPaywall();return}
  }catch(e){logError("fantasyInit/access",e)}
  try{
    const promo=$("fantasyPromo"), hub=$("fantasyHub");
    if(promo)promo.style.display="none";
    if(hub)hub.style.display="flex";
    const sr=await apiGet("/api/fantasy/scenarios");
    if(sr.ok){const d=await sr.json();fantasyScenarios=d.scenarios||[]}
    fantasyRenderHub();
  }catch(e){console.error("fantasyInit",e)}
}

function showFantasyPaywall(){
  const hub=document.getElementById("fantasyHub");
  if(!hub)return;
  hub.style.display="flex";
  const promo=$("fantasyPromo");if(promo)promo.style.display="none";
  hub.innerHTML=`
    <div class="fantasy-paywall">
      <div class="paywall-icon">🔥</div>
      <h2 class="paywall-title">Fantasy+ 18+</h2>
      <p class="paywall-desc">Создавай своих девушек, выбирай сценарии и наслаждайся откровенными диалогами</p>
      <ul class="paywall-features">
        <li>15 горячих сценариев</li>
        <li>Конструктор персонажей</li>
        <li>Интерактивные истории</li>
        <li>Свободный чат без ограничений</li>
        <li>Генерация уникальных аватаров</li>
      </ul>
      <button class="paywall-btn" id="fantasyBuyBtn">Получить доступ — 449 ⭐</button>
      <p class="paywall-note">Подписка на 30 дней</p>
    </div>`;
  document.getElementById("fantasyBuyBtn").onclick=async()=>{
    try{
      showToast("Создаю платёж...");
      const r=await apiPost("/api/fantasy/subscribe",{});
      const d=await r.json();
      if(d.alreadyActive){showToast("Доступ уже активен!");fantasyInit();return}
      if(d.invoiceLink&&window.Telegram?.WebApp?.openInvoice){
        window.Telegram.WebApp.openInvoice(d.invoiceLink,(status)=>{
          if(status==="paid"){showToast("Оплата успешна!");fantasyInit()}
          else showToast("Оплата отменена");
        });
      }else{showToast("Ошибка оплаты")}
    }catch(e){logError("fantasyBuy",e);showToast("Ошибка")}
  };
}

function fantasyRenderHub(){
  const grid=$("fantasyScenariosGrid");
  if(!grid)return;
  grid.innerHTML=fantasyScenarios.map(s=>`
    <div class="fantasy-sc-card" data-sc="${s.id}">
      ${s.avatar?`<div class="fantasy-sc-img" style="background-image:url('${safeUrl(s.avatar)}')"></div>`:`<span class="fantasy-sc-icon">${s.icon}</span>`}
      <div class="fantasy-sc-title">${esc(s.title)}</div>
    </div>`).join("");
  grid.querySelectorAll(".fantasy-sc-card").forEach(c=>c.onclick=()=>{
    ffOpen(c.dataset.sc);
  });
}

/* ── Filter Panel ── */
function ffOpen(scenarioId){
  const sc=fantasyScenarios.find(s=>s.id===scenarioId);
  if(!sc)return;
  fcScenarioId=scenarioId;
  fcCurrentScenario=sc;
  fcFilters={character:"bold",flirtLevel:"open",initiative:"equal",defaultMood:"playful",style:"sweet"};

  const overlay=$("fantasyFilter");if(!overlay)return;
  overlay.classList.add("active");
  trapFocus(overlay);

  const hdr=$("ffHeader");
  if(hdr){
    hdr.innerHTML=`
      <div class="ff-avatar" id="ffAvatarEl" style="background-image:url('${safeUrl(sc.avatar||"")}')"></div>
      <div style="flex:1"><div class="ff-title">${esc(sc.title)}</div><div class="ff-desc">${esc(sc.description)}</div>
        <button class="ff-gen-btn" id="ffGenAvatar">✨ Новый аватар</button>
      </div>`;
    const genBtn=$("ffGenAvatar");
    if(genBtn)genBtn.onclick=async()=>{
      genBtn.disabled=true;genBtn.textContent="⏳ Генерация...";
      try{
        const r=await apiPost("/api/fantasy/generate-avatar",{scenarioId:fcScenarioId},30000);
        if(!r.ok)throw new Error("err");
        const d=await r.json();
        const avEl=$("ffAvatarEl");
        if(avEl)avEl.style.backgroundImage=`url('${safeUrl(d.avatar)}')`;
        if(fcCurrentScenario)fcCurrentScenario.avatar=d.avatar;
        genBtn.textContent="✨ Новый аватар";
      }catch(e){genBtn.textContent="⚠ Ошибка";}
      genBtn.disabled=false;
    };
  }

  ffRenderFilters();
}

function ffRenderFilters(){
  const body=$("ffBody");if(!body)return;
  body.innerHTML=FF_GROUPS.map(g=>{
    const val=fcFilters[g.key]||"";
    return `<div>
      <div class="ff-group-title">${g.title}</div>
      <div class="ff-chips" data-grp="${g.key}">${g.opts.map(o=>
        `<div class="ff-chip ${val===o.id?'on':''}" data-v="${o.id}">${o.icon||''} ${o.label}</div>`
      ).join("")}</div>
    </div>`;
  }).join("");

  body.querySelectorAll(".ff-chips").forEach(grp=>{
    grp.querySelectorAll(".ff-chip").forEach(c=>c.onclick=()=>{
      fcFilters[grp.dataset.grp]=c.dataset.v;
      grp.querySelectorAll(".ff-chip").forEach(x=>x.classList.toggle("on",x.dataset.v===c.dataset.v));
    });
  });
}

function ffClose(){
  const overlay=$("fantasyFilter");if(overlay){overlay.classList.remove("active");releaseFocus(overlay);}
}

const ffCloseBtn=$("ffClose");
if(ffCloseBtn)ffCloseBtn.onclick=ffClose;
const ffOverlay=$("fantasyFilter");
if(ffOverlay)ffOverlay.onclick=(e)=>{if(e.target===ffOverlay)ffClose()};

const ffChatBtn=$("ffChatBtn");
if(ffChatBtn)ffChatBtn.onclick=()=>{ffClose();fantasyOpenChat()};

const ffStoryBtn=$("ffStoryBtn");
if(ffStoryBtn)ffStoryBtn.onclick=()=>{ffClose();fantasyOpenStory()};

/* ── Fantasy Chat ── */
function fantasyOpenChat(){
  const sc=fcCurrentScenario;
  if(!sc)return;
  const el=$("fantasyChat");if(!el)return;
  el.classList.add("active");

  const av=$("fcChatAv"),nm=$("fcChatName"),role=$("fcChatRole");
  if(av){
    if(sc.avatar){
      av.style.background=`url('${safeUrl(sc.avatar)}') center/cover`;
      av.textContent="";
    }else{
      av.textContent=sc.icon||"";
      av.style.background="var(--pink)";
    }
  }
  if(nm)nm.textContent=sc.title;
  if(role)role.textContent=sc.description.split(".")[0];

  const strip=$("fcSettingStrip");
  if(strip){
    fcSetting=sc.settings[0];
    strip.innerHTML=sc.settings.map(s=>`<button class="fc-setting-chip ${s===fcSetting?'on':''}" data-s="${esc(s)}">${esc(sc.settingLabels[s]||s)}</button>`).join("");
    strip.querySelectorAll(".fc-setting-chip").forEach(c=>c.onclick=()=>{
      fcSetting=c.dataset.s;
      strip.querySelectorAll(".fc-setting-chip").forEach(x=>x.classList.toggle("on",x===c));
    });
  }

  const msgs=$("fcMessages");
  if(msgs){
    msgs.innerHTML="";
    fcAddMsg(sc.description.split(".")[0]+".","b",{name:sc.title,color:"var(--pink)",avatar:sc.avatar});
  }
}

function fcAddMsg(text,type,persona){
  const msgs=$("fcMessages");if(!msgs)return;
  const row=document.createElement("div");
  row.className=`bubble-row ${type}`;
  if(type==="b"&&persona){
    const avInner=persona.avatar
      ?`<div style="width:100%;height:100%;border-radius:50%;background:url('${safeUrl(persona.avatar)}') center/cover"></div>`
      :`<div style="width:100%;height:100%;border-radius:50%;background:${persona.color||'var(--pink)'};display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:800;color:#fff">${(persona.name||'?')[0]}</div>`;
    const avDiv = document.createElement("div");
    avDiv.className = "bubble-mini-av";
    avDiv.innerHTML = avInner;
    const bbl = document.createElement("div");
    bbl.className = "bubble b";
    bbl.textContent = text;
    row.appendChild(avDiv);
    row.appendChild(bbl);
  }else if(type==="u"){
    const bbl = document.createElement("div");
    bbl.className = "bubble u";
    bbl.textContent = text;
    row.appendChild(bbl);
  }else{
    const bbl = document.createElement("div");
    bbl.className = "bubble s";
    bbl.textContent = text;
    row.appendChild(bbl);
  }
  msgs.appendChild(row);
  msgs.scrollTop=msgs.scrollHeight;
}

const fcChatBack=$("fcChatBack");
if(fcChatBack)fcChatBack.onclick=()=>{$("fantasyChat")?.classList.remove("active")};

const fcInput=$("fcInput"),fcSendBtn=$("fcSendBtn");
async function fcSend(){
  if(fcSending)return;
  const msg=fcInput?.value?.trim();
  if(!msg)return;
  fcInput.value="";
  fcAddMsg(msg,"u");
  fcSending=true;
  if(fcSendBtn)fcSendBtn.disabled=true;
  const typing=$("fcTyping");if(typing)typing.classList.add("on");
  try{
    const r=await apiPost("/api/fantasy/chat",{scenarioId:fcScenarioId,filters:fcFilters,message:msg,setting:fcSetting},75000);
    if(!r.ok)throw new Error("err");
    const d=await r.json();
    fcAddMsg(d.reply,"b",{name:fcCurrentScenario?.title||"",color:"var(--pink)",avatar:fcCurrentScenario?.avatar});
  }catch(e){
    fcAddMsg("Ошибка. Попробуй ещё раз.","s");
  }
  if(typing)typing.classList.remove("on");
  fcSending=false;
  if(fcSendBtn)fcSendBtn.disabled=false;
  fcInput?.focus();
}
if(fcSendBtn)fcSendBtn.onclick=fcSend;
if(fcInput)fcInput.onkeydown=(e)=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();fcSend()}};

/* ── Fantasy Story ── */
async function fantasyOpenStory(){
  if(!fcScenarioId)return;
  const el=$("fantasyStory");if(!el)return;
  el.classList.add("active");

  const title=$("fsTitle"),scene=$("fsScene"),choices=$("fsChoices"),result=$("fsResult"),reaction=$("fsReaction"),prog=$("fsProgress");
  if(scene)scene.textContent="Загрузка...";
  if(choices)choices.innerHTML="";
  if(result)result.style.display="none";
  if(reaction)reaction.style.display="none";

  try{
    const r=await apiPost("/api/fantasy/story/start",{scenarioId:fcScenarioId,filters:fcFilters});
    if(!r.ok)throw new Error("err");
    const d=await r.json();
    fsState=d.state;
    if(title)title.textContent=d.chapter?.title||"История";
    fsRenderScene(d.scene,d.totalChapters);
  }catch(e){
    if(scene)scene.textContent="Не удалось загрузить историю.";
  }
}

function fsRenderScene(sceneData,totalChapters){
  const scene=$("fsScene"),choices=$("fsChoices"),prog=$("fsProgress"),reaction=$("fsReaction"),result=$("fsResult");
  if(!sceneData||!fsState)return;

  if(result)result.style.display="none";
  if(reaction)reaction.style.display="none";

  const totalScenes=totalChapters*3;
  const currentScene=fsState.chapterIdx*3+fsState.sceneIdx;
  if(prog)prog.innerHTML=Array.from({length:totalScenes},(_,i)=>`<div class="cr-dot ${i<currentScene?'done':i===currentScene?'cur':''}"></div>`).join("");

  if(scene)scene.textContent=sceneData.text;
  if(choices){
    choices.innerHTML=(sceneData.choices||[]).map((c,i)=>`<button class="date-choice" data-idx="${i}">${esc(c)}</button>`).join("");
    choices.querySelectorAll(".date-choice").forEach(b=>b.onclick=()=>fsChoose(parseInt(b.dataset.idx)));
  }
}

async function fsChoose(idx){
  const choices=$("fsChoices"),reaction=$("fsReaction"),result=$("fsResult"),scene=$("fsScene"),title=$("fsTitle");
  if(choices)choices.querySelectorAll(".date-choice").forEach(b=>b.disabled=true);

  try{
    const r=await apiPost("/api/fantasy/story/choice",{choiceIdx:idx});
    if(!r.ok)throw new Error("err");
    const d=await r.json();

    if(d.state) fsState=d.state;

    if(reaction){reaction.textContent=d.reaction||"";reaction.style.display=d.reaction?"block":"none"}

    if(d.finished){
      if(result){
        result.style.display="block";
        result.innerHTML=`<div class="date-result-emoji">🔥</div>
          <div class="date-result-title">История завершена!</div>
          <div class="date-result-xp">Очки: ${d.totalScore}</div>
          <button class="date-result-btn" id="fsFinishBtn">Закрыть</button>`;
        $("fsFinishBtn").onclick=()=>$("fantasyStory")?.classList.remove("active");
      }
      if(choices)choices.innerHTML="";
    }else{
      if(title&&d.nextChapter)title.textContent=d.nextChapter.title;
      setTimeout(()=>{
        if(d.nextScene)fsRenderScene(d.nextScene,d.totalChapters);
      },1500);
    }
  }catch(e){
    if(reaction){reaction.textContent="Ошибка. Попробуй ещё раз.";reaction.style.display="block"}
  }
}

const fsBackBtn=$("fsBack");
if(fsBackBtn)fsBackBtn.onclick=()=>$("fantasyStory")?.classList.remove("active");

/* ── Girl Mood System ── */
let currentGirlMood = { id:"neutral", label:"Обычное", emoji:"😊", color:"#7c5cff", glow:"rgba(124,92,255,.2)", intensity:50, reason:"" };

function updateGirlMoodUI(mood) {
  if (!mood) return;
  const prev = currentGirlMood;
  currentGirlMood = mood;
  if (EL.girlMoodEmoji) EL.girlMoodEmoji.textContent = mood.emoji;
  if (EL.girlMoodLabel) EL.girlMoodLabel.textContent = mood.label;
  if (EL.girlMoodBadge) {
    EL.girlMoodBadge.style.setProperty("--mood-glow", mood.glow);
    EL.girlMoodBadge.style.borderColor = mood.color + "44";
    EL.girlMoodBadge.classList.toggle("glow", mood.intensity > 60);
    EL.girlMoodBadge.style.background = mood.color + "18";
  }
  if (prev.id !== mood.id && prev.id !== "neutral") showMoodChangeToast(mood);
}

function showMoodChangeToast(mood) {
  const existing = document.querySelector(".mood-change-toast");
  if (existing) existing.remove();
  const t = document.createElement("div");
  t.className = "mood-change-toast";
  t.style.background = mood.color + "cc";
  t.style.boxShadow = `0 4px 24px ${mood.glow}`;
  t.innerHTML = `<span class="mct-emoji">${mood.emoji}</span><div class="mct-text"><span class="mct-label">${esc(mood.label)}</span>${mood.reason ? `<span class="mct-reason">${esc(mood.reason)}</span>` : ""}</div>`;
  document.body.appendChild(t);
  requestAnimationFrame(() => { requestAnimationFrame(() => t.classList.add("show")); });
  setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 500); }, 3000);
}

async function loadGirlMood() {
  try {
    const r = await apiGet(`/api/girl-mood?personaId=${encodeURIComponent(pid)}`);
    if (!r.ok) return;
    const d = await r.json();
    updateGirlMoodUI(d);
  } catch(e) {logError("loadGirlMood",e)}
}

if (EL.girlMoodBadge) EL.girlMoodBadge.onclick = () => openMoodDetail();
if (EL.mdCloseBtn) EL.mdCloseBtn.onclick = () => { if (EL.moodDetailOverlay) { EL.moodDetailOverlay.classList.remove("open"); releaseFocus(EL.moodDetailOverlay); } };
if (EL.moodDetailOverlay) EL.moodDetailOverlay.onclick = (e) => { if (e.target === EL.moodDetailOverlay) { EL.moodDetailOverlay.classList.remove("open"); releaseFocus(EL.moodDetailOverlay); } };

async function openMoodDetail() {
  if (!EL.moodDetailOverlay) return;
  const m = currentGirlMood;
  if (EL.mdEmoji) EL.mdEmoji.textContent = m.emoji;
  if (EL.mdLabel) { EL.mdLabel.textContent = m.label; EL.mdLabel.style.color = m.color; }
  if (EL.mdReason) EL.mdReason.textContent = m.reason || "Настроение сейчас стабильное";
  if (EL.mdIntensityFill) {
    EL.mdIntensityFill.style.width = m.intensity + "%";
    EL.mdIntensityFill.style.background = `linear-gradient(90deg, ${m.color}88, ${m.color})`;
  }
  const iWord = m.intensity > 75 ? "Очень сильно" : m.intensity > 50 ? "Средне" : m.intensity > 25 ? "Немного" : "Едва заметно";
  if (EL.mdIntensityLabel) EL.mdIntensityLabel.textContent = `${iWord} (${m.intensity}%)`;

  try {
    const r = await apiGet(`/api/girl-mood?personaId=${encodeURIComponent(pid)}`);
    if (r.ok) {
      const d = await r.json();
      if (EL.mdHistory && d.history?.length) {
        EL.mdHistory.innerHTML = `<div class="md-history-title">Последние изменения</div>`;
        for (const h of d.history.slice(0, 6)) {
          const ago = formatTimeAgo(h.at);
          const div = document.createElement("div"); div.className = "md-history-item";
          div.innerHTML = `<span class="md-history-emoji">${h.to === m.id ? m.emoji : "→"}</span><span class="md-history-text">${esc(h.reason || h.to)}</span><span class="md-history-time">${ago}</span>`;
          EL.mdHistory.appendChild(div);
        }
      } else if (EL.mdHistory) {
        EL.mdHistory.innerHTML = `<div class="md-history-title">Пока без истории</div><div style="font-size:12px;color:var(--muted)">Пиши сообщения — настроение будет меняться</div>`;
      }
    }
  } catch(e) {logError("openMoodDetail",e)}
  EL.moodDetailOverlay.classList.add("open");
  trapFocus(EL.moodDetailOverlay);
}

function formatTimeAgo(ts) {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "сейчас";
  if (mins < 60) return `${mins} мин`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} ч`;
  const days = Math.floor(hrs / 24);
  return `${days} дн`;
}

/* ── Relationship Timeline ── */
/* Timeline via menu */
if (EL.tlCloseBtn) EL.tlCloseBtn.onclick = () => { if (EL.timelinePanel) EL.timelinePanel.classList.remove("open"); };

async function loadTimeline() {
  if (!EL.tlScroll) return;
  EL.tlScroll.innerHTML = '<div style="text-align:center;padding:40px;color:var(--muted)"><div class="loading-spin" style="margin:0 auto 12px"></div>Загрузка...</div>';
  try {
    const r = await apiGet(`/api/timeline?personaId=${encodeURIComponent(pid)}`);
    if (!r.ok) { EL.tlScroll.innerHTML = '<div style="text-align:center;padding:40px;color:var(--muted)">Ошибка загрузки</div>'; return; }
    const d = await r.json();
    renderTimeline(d);
  } catch { EL.tlScroll.innerHTML = '<div style="text-align:center;padding:40px;color:var(--muted)">Ошибка загрузки</div>'; }
}

function renderTimeline(data) {
  if (!EL.tlScroll) return;
  EL.tlScroll.innerHTML = "";
  const p = cur();
  const hero = document.createElement("div"); hero.className = "tl-hero";
  const avContent = p?.avatar?.startsWith("/") ? `<img src="${p.avatar}" alt="">` : `<span style="font-size:28px;font-weight:800;color:#fff;display:flex;align-items:center;justify-content:center;width:100%;height:100%;background:${p?.color || 'var(--accent)'}">${(p?.name || "?").charAt(0)}</span>`;
  const moodBg = data.currentMood?.color || "#7c5cff";
  hero.innerHTML = `
    <div class="tl-hero-av">${avContent}</div>
    <div class="tl-hero-name">${esc(p?.name || "Девушка")}</div>
    <div class="tl-hero-mood" style="background:${moodBg}22;color:${moodBg};border:1px solid ${moodBg}44">
      ${data.currentMood?.emoji || "😊"} ${esc(data.currentMood?.label || "Обычное")}
    </div>
    <div class="tl-hero-level">❤️ ${esc(data.affection?.label || "Незнакомка")} · Уровень ${data.affection?.level || 1}/7</div>`;
  EL.tlScroll.appendChild(hero);

  const st = data.stats || {};
  const stats = document.createElement("div"); stats.className = "tl-stats";
  stats.innerHTML = `
    <div class="tl-stat"><div class="tl-stat-val">${st.daysSinceFirst || 0}</div><div class="tl-stat-label">Дней вместе</div></div>
    <div class="tl-stat"><div class="tl-stat-val">${st.totalEvents || 0}</div><div class="tl-stat-label">Событий</div></div>
    <div class="tl-stat"><div class="tl-stat-val">${st.specialMoments || 0}</div><div class="tl-stat-label">Особых</div></div>`;
  EL.tlScroll.appendChild(stats);

  const events = data.events || [];
  if (!events.length) {
    const empty = document.createElement("div"); empty.className = "tl-empty";
    empty.innerHTML = `<div class="tl-empty-emoji">💫</div><div class="tl-empty-title">Пока пусто</div><div class="tl-empty-text">Начни общение — и здесь появится история ваших отношений</div>`;
    EL.tlScroll.appendChild(empty);
    return;
  }

  const sec = document.createElement("div"); sec.className = "tl-section-title"; sec.textContent = "Хронология";
  EL.tlScroll.appendChild(sec);

  const line = document.createElement("div"); line.className = "tl-line";
  let lastDateStr = "";

  for (const ev of events) {
    const d = new Date(ev.timestamp);
    const dateStr = d.toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
    if (dateStr !== lastDateStr) {
      const sep = document.createElement("div"); sep.className = "tl-date-sep"; sep.textContent = dateStr;
      line.appendChild(sep);
      lastDateStr = dateStr;
    }
    const meta = ev.meta || {};
    const isMajor = ["level_up","max_level","ring_gift","confession","first_message"].includes(ev.type);
    const evt = document.createElement("div"); evt.className = "tl-event";
    const dotColor = meta.color || "#7c5cff";
    const timeStr = d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
    let detail = "";
    if (ev.type === "mood_change" && ev.data) detail = `${ev.data.emoji || ""} ${esc(ev.data.label || "")}${ev.data.reason ? " — " + esc(ev.data.reason) : ""}`;
    else if (ev.type === "level_up" && ev.data) detail = `Уровень ${ev.data.from} → ${ev.data.to}: ${esc(ev.data.label)}`;
    else if (ev.type === "first_gift" && ev.data) detail = `${ev.data.emoji || "🎁"} ${esc(ev.data.gift)} (+${ev.data.xp} XP)`;
    else if (ev.type === "ring_gift" && ev.data) detail = `${ev.data.emoji || "💍"} ${esc(ev.data.gift)}`;
    else if (ev.type === "first_message" && ev.data) detail = `"${esc(ev.data.text || "")}"`;
    else if (ev.type === "confession" && ev.data) detail = `"${esc(ev.data.message || "")}"`;
    else if (ev.type === "max_level") detail = "Максимальный уровень — Родная";

    evt.innerHTML = `
      <div class="tl-dot${isMajor ? " major" : ""}" style="background:${dotColor}"></div>
      <div class="tl-card${isMajor ? " highlight" : ""}" style="--tl-color:${dotColor}">
        <div style="position:absolute;top:0;left:0;width:3px;height:100%;background:${dotColor};border-radius:2px"></div>
        <div class="tl-card-top">
          <span class="tl-card-emoji">${meta.emoji || "📌"}</span>
          <span class="tl-card-label">${esc(meta.label || ev.type)}</span>
          <span class="tl-card-time">${timeStr}</span>
        </div>
        ${detail ? `<div class="tl-card-detail">${detail}</div>` : ""}
      </div>`;
    line.appendChild(evt);
  }
  EL.tlScroll.appendChild(line);
}

/* ── Init ── */
/* ── Stories ── */
let storiesData = [];
async function loadStories() {
  if (!EL.storiesBar) return;
  try {
    const r = await apiGet("/api/stories");
    if (!r.ok) return;
    const d = await r.json();
    storiesData = d.stories || [];
    renderStories();
  } catch(e) {logError("loadStories",e)}
}
function renderStories() {
  if (!EL.storiesBar) return;
  EL.storiesBar.innerHTML = "";
  const seen = new Set();
  for (const s of storiesData) {
    if (seen.has(s.personaId)) continue;
    seen.add(s.personaId);
    const p = personas.find(x => x.id === s.personaId);
    if (!p) continue;
    const div = document.createElement("div");
    div.className = "story-item";
    const avImg = p.avatar?.startsWith("/")
      ? `<img src="${p.avatar}" alt="">`
      : `<div class="story-av-letter" style="background:${p.color||'var(--accent)'}">${(p.name||"?").charAt(0)}</div>`;
    div.innerHTML = `<div class="story-av">${avImg}</div><div class="story-name">${esc(p.name)}</div>`;
    div.onclick = () => openStory(s.personaId);
    EL.storiesBar.appendChild(div);
  }
}
function openStory(personaId) {
  const story = storiesData.find(s => s.personaId === personaId);
  const p = personas.find(x => x.id === personaId);
  if (!story || !p) return;
  if (EL.storyPersonaName) EL.storyPersonaName.textContent = p.name;
  if (EL.storyText) EL.storyText.textContent = story.text;
  if (EL.storyOverlay) { EL.storyOverlay.classList.add("open"); trapFocus(EL.storyOverlay); }
  trackEvent("story_viewed", { personaId });
}
if (EL.storyCloseBtn) EL.storyCloseBtn.onclick = () => {
  if (EL.storyOverlay) { EL.storyOverlay.classList.remove("open"); releaseFocus(EL.storyOverlay); }
};
document.querySelectorAll(".story-react-btn").forEach(btn => {
  btn.onclick = () => {
    const react = btn.dataset.react;
    const pName = EL.storyPersonaName?.textContent;
    const p = personas.find(x => x.name === pName);
    if (p) apiPost("/api/stories/react", { personaId: p.id, reaction: react });
    btn.style.transform = "scale(1.4)";
    setTimeout(() => {
      btn.style.transform = "";
      if (EL.storyOverlay) EL.storyOverlay.classList.remove("open");
      showToast("Реакция отправлена!");
    }, 300);
  };
});

async function init(){
  if(EL.profName)EL.profName.textContent=userName;
  status("Загрузка...",false);
  try{
    const [prData,grData,custom]=await Promise.all([
      cachedGet("/api/personas"),
      cachedGet("/api/gifts"),
      apiGet("/api/custom-personas"),
    ]);
    const base=prData?.personas||[];
    const customList=custom.ok?(await custom.json()).personas||[]:[];
    personas=[...base,...customList];
    if(grData)gifts=grData.gifts||[];
    await loadProf();
    renderCards();chatHdr();
    checkOnboarding();
    status("Онлайн",true);
    loadStories();loadEvents();
    setTimeout(()=>{renderGifts();loadGirlMood()},100);
  }catch(e){
    const msg=e?.name==="AbortError"?"Сервер не ответил. Проверь интернет.":`Ошибка: ${e?.message||e}`;
    status("Недоступно",false);
    addMsg(msg,"s");
  }
}
init();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", runApp);
} else {
  runApp();
}
