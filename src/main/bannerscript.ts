/**
 * Skript, který na e-shopu kreslí bannery na úvodní stránce.
 *
 * ## Proč je to tady, a ne jako soubor na webu
 *
 * Do šablony Upgates se nedá sáhnout; jediné, co jde, je vložit kus kódu
 * na konec `<head>`. Ten kód ale potřebuje vědět **adresu plánu** a nést
 * **záložní sadu**, a obojí je u každého nastavení jiné. Kdyby se vozil
 * zvlášť, musel by se po každé změně přepsat ručně a nikdo by nepoznal, že
 * ten na webu je starý. Takhle ho aplikace vypíše hotový a jen se zkopíruje.
 *
 * ## Proč se bannery nekreslí, dokud není co
 *
 * Původní karusel se **neschová hned**, ale až ve chvíli, kdy máme čím ho
 * nahradit. Se záložní sadou je to hned v hlavičce, tedy ještě před prvním
 * vykreslením a bez jediného posunu stránky. Bez ní se počká na plán a do
 * té doby je na stránce to, co tam bylo — prázdné místo by bylo horší než
 * starý banner.
 *
 * ## Proč má každá dlaždice pevný poměr stran
 *
 * Zadání znělo „nesmí to škaredě poskakovat". Obrázek, který doteče později,
 * mění výšku dlaždice, a s ní skočí celá stránka pod ní. Poměr stran je
 * proto daný rozvržením, fotka se ořízne a výška je známá dřív, než se
 * cokoli stáhne. Ze stejného důvodu se při rotaci **prolíná**, a nejede se
 * do strany: všechny stránky bannerů leží v téže buňce mřížky, takže výška
 * je pořád ta nejvyšší z nich.
 */

/** Kam se ve skriptu doplní adresa plánu, platnost kopie a záložní sada. */
const URL_MARK = '__QUENTINO_BANNERS_URL__';
const TTL_MARK = '__QUENTINO_BANNERS_TTL__';
const FALLBACK_MARK = '"__QUENTINO_BANNERS_FALLBACK__"';

/*
 * Pozor při úpravách: text níž je `String.raw`, takže se v něm nesmí objevit
 * zpětný apostrof ani `${`. Skript je proto psaný bez šablonových řetězců —
 * spojuje se plusem. Kdyby se tohle porušilo, překlad spadne na TS1005.
 */
const TEMPLATE = String.raw`
<style>
/* Quentino — bannery na úvodní stránce. */

/*
 * Původní karusel se schovává až tehdy, když je čím ho nahradit — třídu
 * na <html> přidá skript. Kdyby se schovával rovnou, znamenala by chyba
 * v načtení plánu prázdné místo na hlavní stránce.
 */
.qbn-on #banner1,
.qbn-on .bnr-main .carousel,
.qbn-on .bnr-main .cover-bnr { display: none !important; }

.qbn {
  display: grid;
  width: 100%;
  margin: 0 auto;
  /* Stránky bannerů leží přes sebe v téže buňce — proto se při rotaci nehne výška */
  position: relative;
}
.qbn-page {
  grid-area: 1 / 1;
  display: grid;
  gap: 14px;
  opacity: 0;
  visibility: hidden;
  transition: opacity .55s ease;
}
.qbn-page.qbn-now { opacity: 1; visibility: visible; }

.qbn[data-layout="quad"] .qbn-page { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.qbn[data-layout="wide"] .qbn-page { grid-template-columns: minmax(0, 1fr); }

.qbn-card {
  position: relative;
  display: block;
  overflow: hidden;
  border-radius: 14px;
  background-color: var(--qbn-bg, #1c1c22);
  background-image: var(--qbn-img, none);
  background-size: cover;
  background-position: var(--qbn-focus, 50% 50%);
  background-repeat: no-repeat;
  color: var(--qbn-fg, #fff);
  text-decoration: none;
  /* Poměr stran drží výšku dřív, než dotečou fotky — bez toho stránka poskakuje */
  aspect-ratio: 3 / 4;
  isolation: isolate;
}
.qbn[data-layout="wide"] .qbn-card { aspect-ratio: 32 / 11; border-radius: 16px; }
a.qbn-card { cursor: pointer; }
a.qbn-card:hover .qbn-btn { transform: translateY(-1px); filter: brightness(1.08); }

/*
 * Ztmavení pod textem. Je to jediný důvod, proč je text na fotce čitelný,
 * takže se kreslí vždycky — i když je ztmavení nastavené nízko, zůstává
 * aspoň spád u kraje, kde text leží.
 */
.qbn-shade {
  position: absolute;
  inset: 0;
  z-index: 1;
  pointer-events: none;
  background: linear-gradient(to top,
    rgba(0, 0, 0, var(--qbn-shade, .4)) 0%,
    rgba(0, 0, 0, calc(var(--qbn-shade, .4) * .55)) 42%,
    rgba(0, 0, 0, 0) 78%);
}
.qbn-card[data-pos="top"] .qbn-shade { transform: scaleY(-1); }
.qbn-card[data-pos="middle"] .qbn-shade {
  background: rgba(0, 0, 0, var(--qbn-shade, .4));
}

.qbn-body {
  position: absolute;
  inset: 0;
  z-index: 3;
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 18px;
  box-sizing: border-box;
  /* Stín pod písmem je poslední pojistka čitelnosti na světlém místě fotky */
  text-shadow: 0 1px 3px rgba(0, 0, 0, .45);
}
.qbn-card[data-pos="top"] .qbn-body { justify-content: flex-start; }
.qbn-card[data-pos="middle"] .qbn-body { justify-content: center; }
.qbn-card[data-pos="bottom"] .qbn-body { justify-content: flex-end; }
.qbn-card[data-align="center"] .qbn-body { align-items: center; text-align: center; }
.qbn-card[data-align="right"] .qbn-body { align-items: flex-end; text-align: right; }

.qbn-title {
  margin: 0;
  font-size: clamp(16px, 1.45vw, 25px);
  line-height: 1.16;
  font-weight: 700;
  letter-spacing: -.01em;
}
.qbn[data-layout="wide"] .qbn-title { font-size: clamp(20px, 2.4vw, 40px); }
.qbn-text {
  margin: 0;
  font-size: clamp(12px, .95vw, 15px);
  line-height: 1.35;
  opacity: .94;
  /* Tři řádky a dost: čtvrtý by přerostl dlaždici a vylezl pod fotku */
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.qbn[data-layout="wide"] .qbn-text { font-size: clamp(13px, 1.1vw, 18px); max-width: 46ch; }

.qbn-btn {
  display: inline-block;
  margin-top: 4px;
  padding: 8px 16px;
  border-radius: 999px;
  background: var(--qbn-fg, #fff);
  color: var(--qbn-bg, #1c1c22);
  font-size: 13px;
  font-weight: 600;
  text-shadow: none;
  transition: transform .15s ease, filter .15s ease;
}

.qbn-emoji {
  font-size: 22px;
  line-height: 1;
  text-shadow: none;
}
.qbn-card[data-align="center"] .qbn-emoji { align-self: center; }

/* ---------- chytré bannery ---------- */

.qbn-smart { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.qbn-card[data-align="center"] .qbn-smart { justify-content: center; }
.qbn-card[data-align="right"] .qbn-smart { justify-content: flex-end; }

.qbn-unit {
  min-width: 46px;
  padding: 5px 7px;
  border-radius: 9px;
  background: rgba(0, 0, 0, .42);
  backdrop-filter: blur(3px);
  text-align: center;
  text-shadow: none;
  font-variant-numeric: tabular-nums;
}
.qbn-num { display: block; font-size: 17px; font-weight: 700; line-height: 1.1; }
.qbn-unit small { display: block; font-size: 9.5px; opacity: .82; letter-spacing: .04em; }

.qbn-code {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 7px 12px;
  border-radius: 9px;
  border: 1px dashed currentColor;
  background: rgba(0, 0, 0, .3);
  font-weight: 700;
  letter-spacing: .09em;
  text-shadow: none;
  cursor: copy;
}
.qbn-code small { font-weight: 500; letter-spacing: 0; opacity: .8; }

.qbn-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 11px;
  border-radius: 999px;
  background: rgba(0, 0, 0, .38);
  font-size: 12.5px;
  font-weight: 600;
  text-shadow: none;
}

/* ---------- efekty ---------- */

/* Vždy jen uvnitř dlaždice — vrstva je ořezaná jejím okrajem */
.qbn-fx { position: absolute; inset: 0; z-index: 2; pointer-events: none; overflow: hidden; }
.qbn-flake {
  position: absolute;
  top: -14%;
  font-size: 15px;
  opacity: .85;
  animation-name: qbn-fall;
  animation-timing-function: linear;
  animation-iteration-count: infinite;
  will-change: transform;
}
@keyframes qbn-fall {
  0% { transform: translate3d(0, -20%, 0) rotate(0deg); }
  100% { transform: translate3d(14px, 520%, 0) rotate(240deg); }
}
.qbn-fx-shine::after {
  content: "";
  position: absolute;
  top: -40%;
  left: -60%;
  width: 40%;
  height: 180%;
  background: linear-gradient(100deg, rgba(255,255,255,0) 0%, rgba(255,255,255,.38) 50%, rgba(255,255,255,0) 100%);
  transform: skewX(-18deg);
  animation: qbn-shine 4.5s ease-in-out infinite;
}
@keyframes qbn-shine {
  0%, 62% { left: -60%; }
  100% { left: 130%; }
}
.qbn-fx-pulse ~ .qbn-body .qbn-emoji { animation: qbn-pulse 2.2s ease-in-out infinite; }
@keyframes qbn-pulse {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.22); }
}
.qbn-fx-float ~ .qbn-body .qbn-emoji { animation: qbn-float 3.4s ease-in-out infinite; }
@keyframes qbn-float {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-7px); }
}

/* ---------- tablet a telefon ---------- */

@media (max-width: 1000px) {
  .qbn[data-layout="quad"] .qbn-page { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .qbn[data-layout="quad"] .qbn-card { aspect-ratio: 1 / 1; }
  .qbn[data-layout="wide"] .qbn-card { aspect-ratio: 2 / 1; }
}
@media (max-width: 620px) {
  .qbn { gap: 10px; }
  .qbn-page { gap: 10px; }
  .qbn[data-phone="grid"] .qbn-page { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .qbn[data-phone="grid"] .qbn-card { aspect-ratio: 1 / 1; }
  .qbn[data-phone="wide"] .qbn-page { grid-template-columns: minmax(0, 1fr); }
  .qbn[data-phone="wide"] .qbn-card { aspect-ratio: 5 / 3; }
  .qbn-body { padding: 12px; gap: 5px; }
  .qbn-title { font-size: 15px; }
  .qbn-text {
    font-size: 11.5px;
    /* Na dlaždici o straně poloviny displeje se třetí řádek nevejde */
    -webkit-line-clamp: 2;
  }
  .qbn-btn { padding: 6px 12px; font-size: 11.5px; }
  /*
   * Odpočet se na půlce telefonu musí vejít na jeden řádek. Zalomený na dva
   * vytlačí tlačítko pod okraj dlaždice a z banneru se pak nedá kliknout
   * tam, kam má.
   */
  .qbn-smart { gap: 4px; }
  .qbn-unit { min-width: 32px; padding: 3px 4px; }
  .qbn-num { font-size: 13px; }
  .qbn-unit small { font-size: 8px; letter-spacing: 0; }
  .qbn-chip { padding: 5px 9px; font-size: 11px; }
  .qbn-code { padding: 5px 9px; letter-spacing: .05em; }
  .qbn-emoji { font-size: 18px; }
}

/* Kdo si vypnul pohyb v systému, nemá se na co dívat ani tady */
@media (prefers-reduced-motion: reduce) {
  .qbn-page { transition: none; }
  .qbn-flake, .qbn-fx-shine::after,
  .qbn-fx-pulse ~ .qbn-body .qbn-emoji,
  .qbn-fx-float ~ .qbn-body .qbn-emoji { animation: none; }
  .qbn-flake { display: none; }
}
</style>
<script>
/* Quentino — bannery na úvodní stránce. Plán z aplikace, záloha v tomhle souboru. */
(function () {
  "use strict";
  if (window.__quentinoBanners) return;
  window.__quentinoBanners = true;

  var SOURCE = "__QUENTINO_BANNERS_URL__";
  var TTL_MS = __QUENTINO_BANNERS_TTL__ * 1000;
  var FALLBACK = "__QUENTINO_BANNERS_FALLBACK__";
  var STORE = "quentino-bannery-1";
  /*
   * Jak často se znovu rozhodne, která sada platí. Minuta stačí: sada se
   * plánuje na minuty, ne na vteřiny. Odpočet uvnitř banneru tiká vlastním
   * intervalem po vteřině.
   */
  var TICK_MS = 60000;

  /* ================= jazyk ================= */

  function getLang() {
    /*
     * Náhled v aplikaci běží v rámečku na doméně aplikace, takže by se
     * podle adresy vždycky ukázala čeština. Tohle je jediná cesta, jak
     * v náhledu přepnout na slovenskou a anglickou verzi — na e-shopu
     * proměnná není a rozhoduje doména.
     */
    if (window.__quentinoLang) return window.__quentinoLang;
    var h = (location.hostname || "").toLowerCase();
    if (h.slice(-3) === ".sk") return "sk";
    if (h.slice(-4) === ".com") return "en";
    return "cz";
  }
  var LANG = getLang();

  /* Text je ve všech jazycích; chybí-li ten náš, vezme se český. */
  function pick(value) {
    if (!value) return "";
    if (typeof value === "string") return value.trim();
    var out = value[LANG] || value.cz || "";
    return typeof out === "string" ? out.trim() : "";
  }

  var WORDS = {
    cz: {
      day: ["den", "dny", "dní"], hour: ["hodina", "hodiny", "hodin"],
      min: ["minuta", "minuty", "minut"], sec: ["vteřina", "vteřiny", "vteřin"],
      copied: "Zkopírováno", order: "Objednej do"
    },
    sk: {
      day: ["deň", "dni", "dní"], hour: ["hodina", "hodiny", "hodín"],
      min: ["minúta", "minúty", "minút"], sec: ["sekunda", "sekundy", "sekúnd"],
      copied: "Skopírované", order: "Objednaj do"
    },
    en: {
      day: ["day", "days", "days"], hour: ["hour", "hours", "hours"],
      min: ["minute", "minutes", "minutes"], sec: ["second", "seconds", "seconds"],
      copied: "Copied", order: "Order by"
    }
  };
  var W = WORDS[LANG] || WORDS.cz;

  /*
   * Skloňování počtu. „2 dní" je vidět na každém druhém e-shopu a je to
   * přesně ta drobnost, kvůli které banner vypadá, že ho dělal někdo cizí.
   */
  function plural(n, forms) {
    if (n === 1) return forms[0];
    if (n >= 2 && n <= 4) return forms[1];
    return forms[2];
  }

  function dateText(ms) {
    var locale = LANG === "sk" ? "sk-SK" : (LANG === "en" ? "en-GB" : "cs-CZ");
    try {
      return new Date(ms).toLocaleDateString(locale, { day: "numeric", month: "long" });
    } catch (e) {
      return "";
    }
  }

  /* ================= plán ================= */

  function cached() {
    try {
      var raw = localStorage.getItem(STORE);
      if (!raw) return null;
      var saved = JSON.parse(raw);
      return saved && saved.data ? saved : null;
    } catch (e) {
      return null;
    }
  }

  function remember(data) {
    try {
      localStorage.setItem(STORE, JSON.stringify({ at: Date.now(), data: data }));
    } catch (e) {
      /* Zaplněné nebo zakázané úložiště není důvod bannery nevykreslit */
    }
  }

  var plan = null;
  var saved = cached();
  if (saved) plan = saved.data;
  /*
   * Záložní sada platí, dokud nedorazí plán. Tím se kreslí hned v hlavičce
   * a stránka se po dotečení plánu nehne — v naprosté většině návštěv je
   * v plánu tatáž sada.
   */
  if (!plan && FALLBACK) plan = { sets: [FALLBACK] };

  function fetchPlan() {
    if (!SOURCE || SOURCE.indexOf("http") !== 0) return;
    try {
      fetch(SOURCE, { cache: "no-store" })
        .then(function (res) { return res.ok ? res.json() : null; })
        .then(function (data) {
          if (!data || !data.sets) return;
          remember(data);
          plan = data;
          render();
        })
        .catch(function () { /* beze změny — na stránce zůstane, co je */ });
    } catch (e) { /* prohlížeč bez fetch dostane zálohu a nic víc */ }
  }

  /* Která sada zrovna platí. Při překryvu vyhrává ta, co začala později. */
  function activeSet() {
    var sets = (plan && plan.sets) || [];
    var now = Date.now();
    var best = null;
    for (var i = 0; i < sets.length; i++) {
      var one = sets[i];
      if (!one || !one.banners || one.banners.length === 0) continue;
      var from = Number(one.fromMs) || 0;
      var to = Number(one.toMs) || 0;
      if (from > now) continue;
      if (to && to < now) continue;
      if (!best || from >= (Number(best.fromMs) || 0)) best = one;
    }
    if (!best && FALLBACK) return FALLBACK;
    return best;
  }

  /* ================= kreslení ================= */

  function el(tag, cls) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    return node;
  }

  /*
   * Text se vkládá přes textContent, nikdy jako HTML. Je to text z plánu
   * ve veřejném úložišti a i kdyby se k němu někdo dostal, nesmí z něj jít
   * udělat kód běžící na e-shopu.
   */
  function put(parent, tag, cls, value) {
    if (!value) return null;
    var node = el(tag, cls);
    node.textContent = value;
    parent.appendChild(node);
    return node;
  }

  function unit(box, value, forms) {
    var cell = el("span", "qbn-unit");
    var num = el("span", "qbn-num");
    num.textContent = value < 10 ? "0" + value : String(value);
    cell.appendChild(num);
    var label = el("small");
    label.textContent = plural(value, forms);
    cell.appendChild(label);
    box.appendChild(cell);
  }

  /** Odpočet. Vrací funkci, která ho přepočítá — volá se každou vteřinu. */
  function countdown(body, untilMs) {
    var box = el("div", "qbn-smart");
    body.appendChild(box);
    return function () {
      var left = untilMs - Date.now();
      if (left <= 0) {
        /*
         * Po vypršení odpočet zmizí a zbyde obyčejná dlaždice. Nuly na
         * hodinách by tvrdily, že akce právě teď končí, a to bylo včera.
         */
        box.style.display = "none";
        return;
      }
      box.style.display = "";
      box.textContent = "";
      var s = Math.floor(left / 1000);
      var d = Math.floor(s / 86400);
      var h = Math.floor((s % 86400) / 3600);
      var m = Math.floor((s % 3600) / 60);
      if (d > 0) unit(box, d, W.day);
      unit(box, h, W.hour);
      unit(box, m, W.min);
      /* Vteřiny jen u posledního dne — jinak je to blikání bez významu */
      if (d === 0) unit(box, s % 60, W.sec);
    };
  }

  function codeChip(body, code) {
    var chip = el("span", "qbn-code");
    var value = el("b");
    value.textContent = code;
    chip.appendChild(value);
    var hint = el("small");
    hint.textContent = "⧉";
    chip.appendChild(hint);
    chip.addEventListener("click", function (e) {
      /* Dlaždice je odkaz; kopírování kódu z ní nesmí odejít na jinou stránku */
      e.preventDefault();
      e.stopPropagation();
      try {
        navigator.clipboard.writeText(code);
        hint.textContent = W.copied;
        setTimeout(function () { hint.textContent = "⧉"; }, 1800);
      } catch (err) { /* bez schránky zůstane kód aspoň vidět */ }
    });
    body.appendChild(chip);
  }

  function deliveryChip(body, untilMs) {
    var chip = el("span", "qbn-chip");
    var when = dateText(untilMs);
    var days = Math.max(0, Math.ceil((untilMs - Date.now()) / 86400000));
    /*
     * Krátce. Na dlaždici o straně poloviny telefonu se delší věta zalomí
     * na tři řádky a vytlačí tlačítko — datum a počet dnů řeknou všechno.
     */
    chip.textContent = when
      ? W.order + " " + when + " · " + days + " " + plural(days, W.day)
      : days + " " + plural(days, W.day);
    body.appendChild(chip);
  }

  /* Padající emoji. Kusy se vyrobí jednou; pak už to jede v CSS. */
  function flakes(fx, emoji) {
    var count = window.innerWidth < 620 ? 9 : 14;
    for (var i = 0; i < count; i++) {
      var one = el("span", "qbn-flake");
      one.textContent = emoji;
      one.style.left = Math.round((i + 0.5) * (100 / count) + (i % 3) * 2 - 2) + "%";
      one.style.animationDuration = (5 + (i % 5) * 1.4).toFixed(1) + "s";
      one.style.animationDelay = "-" + ((i * 0.83) % 6).toFixed(1) + "s";
      one.style.fontSize = (11 + (i % 4) * 3) + "px";
      one.style.opacity = String(0.55 + (i % 3) * 0.16);
      fx.appendChild(one);
    }
  }

  /** Jedna dlaždice. Vrací i funkci pro odpočet, když ho banner má. */
  function card(one) {
    var href = pick(one.href);
    var node = el(href ? "a" : "div", "qbn-card");
    if (href) {
      node.setAttribute("href", href);
      var label = pick(one.title) || pick(one.text);
      if (label) node.setAttribute("aria-label", label);
    }
    var look = one.look || {};
    node.setAttribute("data-align", look.align || "left");
    node.setAttribute("data-pos", look.pos || "bottom");
    node.style.setProperty("--qbn-bg", look.bg || "#1c1c22");
    node.style.setProperty("--qbn-fg", look.fg || "#ffffff");
    node.style.setProperty("--qbn-focus", look.focus || "50% 50%");
    node.style.setProperty("--qbn-shade", String((Number(look.overlay) || 0) / 100));
    /*
     * Adresa se do stylu vkládá jen tehdy, když v ní není závorka, uvozovka
     * ani mezera — aplikace to hlídá taky, ale plán je veřejný soubor a
     * tohle je to místo, kde by se z něj dal spustit cizí kód.
     */
    var image = String(look.image || "");
    if (image && !/["'()\\\s]/.test(image) && image.indexOf("http") === 0) {
      node.style.setProperty("--qbn-img", "url(" + image + ")");
    }

    node.appendChild(el("div", "qbn-shade"));

    var smart = one.smart || {};
    var fx = el("div", "qbn-fx");
    if (smart.effect === "shine") fx.className += " qbn-fx-shine";
    if (smart.effect === "pulse") fx.className += " qbn-fx-pulse";
    if (smart.effect === "float") fx.className += " qbn-fx-float";
    if (smart.effect === "snow" && smart.emoji) flakes(fx, smart.emoji);
    node.appendChild(fx);

    var body = el("div", "qbn-body");
    if (smart.emoji && smart.effect !== "snow") put(body, "span", "qbn-emoji", smart.emoji);
    put(body, "h3", "qbn-title", pick(one.title));
    put(body, "p", "qbn-text", pick(one.text));

    var tick = null;
    var until = Number(smart.untilMs) || 0;
    if (smart.kind === "countdown" && until > 0) tick = countdown(body, until);
    if (smart.kind === "code" && smart.code) codeChip(body, smart.code);
    if (smart.kind === "delivery" && until > 0) deliveryChip(body, until);

    put(body, "span", "qbn-btn", pick(one.button));
    node.appendChild(body);
    return { node: node, tick: tick };
  }

  var box = null;
  var rotor = null;
  var ticker = null;
  var shownId = "";

  /* Kam blok patří. Od nejužšího vodítka k nejširšímu, ať přežije přejmenování. */
  var SPOTS = ["#banner1", ".bnr-main .carousel", ".bnr-main", ".bic-bnr"];

  function findSpot() {
    for (var i = 0; i < SPOTS.length; i++) {
      var found = document.querySelector(SPOTS[i]);
      if (found && found.parentNode) return found;
    }
    return null;
  }

  function draw(set) {
    var spot = findSpot();
    if (!spot) return false;

    if (!box) {
      box = el("div", "qbn");
      spot.parentNode.insertBefore(box, spot);
    }
    box.setAttribute("data-layout", set.layout === "wide" ? "wide" : "quad");
    box.setAttribute("data-phone", set.phone === "wide" ? "wide" : "grid");
    box.textContent = "";
    document.documentElement.classList.add("qbn-on");

    /*
     * Stránkuje se po čtyřech u mřížky a po jednom u širokého banneru —
     * tedy přesně po tom, co se na obrazovku vejde. Víc bannerů než jedna
     * stránka znamená rotaci, míň znamená, že se nic nepřetáčí.
     */
    var perPage = set.layout === "wide" ? 1 : 4;
    var banners = set.banners || [];
    var ticks = [];
    var pages = [];
    for (var i = 0; i < banners.length; i += perPage) {
      var page = el("div", "qbn-page");
      for (var j = i; j < Math.min(i + perPage, banners.length); j++) {
        var built = card(banners[j]);
        page.appendChild(built.node);
        if (built.tick) ticks.push(built.tick);
      }
      /*
       * Poslední stránka se dorovná prázdnými místy, aby čtvrtý banner
       * nebyl dvakrát tak široký jako ostatní. Prázdné místo je opravdu
       * prázdné, ne šedá dlaždice — ta by vypadala jako chyba.
       */
      if (set.layout !== "wide") {
        var missing = perPage - (Math.min(i + perPage, banners.length) - i);
        for (var k = 0; k < missing; k++) {
          var hole = el("div");
          hole.style.visibility = "hidden";
          page.appendChild(hole);
        }
      }
      box.appendChild(page);
      pages.push(page);
    }
    if (pages.length > 0) pages[0].className = "qbn-page qbn-now";

    if (ticker) { clearInterval(ticker); ticker = null; }
    if (ticks.length > 0) {
      var run = function () { for (var t = 0; t < ticks.length; t++) ticks[t](); };
      run();
      ticker = setInterval(run, 1000);
    }

    if (rotor) { clearInterval(rotor); rotor = null; }
    var every = Number(set.rotate) || 0;
    var still = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (pages.length > 1 && every > 0 && !still) {
      var at = 0;
      rotor = setInterval(function () {
        pages[at].className = "qbn-page";
        at = (at + 1) % pages.length;
        pages[at].className = "qbn-page qbn-now";
      }, Math.max(2, every) * 1000);
    }
    return true;
  }

  function render() {
    var set = activeSet();
    if (!set) return;
    /*
     * Překreslí se jen při změně sady. Bez toho by se blok přestavoval
     * každou minutu a rotace i odpočet by se pokaždé vrátily na začátek.
     */
    var stamp = String(set.id) + "|" + String(set.rotate) + "|" + String(set.layout)
      + "|" + String(set.phone) + "|" + (set.banners || []).length;
    if (stamp === shownId && box) return;
    if (draw(set)) shownId = stamp;
  }

  /*
   * Na místo banneru se čeká pozorovatelem, ne až na DOMContentLoaded.
   * Skript běží v hlavičce, takže v tu chvíli ještě žádný banner na stránce
   * není — a čekat na celý dokument by znamenalo, že se starý karusel na
   * okamžik ukáže a pak zmizí.
   */
  function watch() {
    if (!document.body && !document.documentElement) return;
    render();
    if (shownId) return;
    var seen = new MutationObserver(function () {
      render();
      if (shownId) seen.disconnect();
    });
    seen.observe(document.documentElement, { childList: true, subtree: true });
    /* Po deseti vteřinách je jasné, že na téhle stránce banner není */
    setTimeout(function () { seen.disconnect(); }, 10000);
  }

  watch();
  document.addEventListener("DOMContentLoaded", render);
  fetchPlan();
  setInterval(render, TICK_MS);
})();
</script>
`;

export function bannerScript(input: { url: string; ttl: number; fallback: any }): string {
  const url = String(input.url ?? '').trim();
  const ttl = Math.max(5, Math.min(3600, Math.round(Number(input.ttl)) || 300));
  /*
   * Záložní sada se do skriptu vkládá jako JSON na místo řetězce v uvozovkách
   * — proto se nahrazuje i s nimi. Bez sady zůstane prázdný řetězec, který
   * je ve skriptu nepravdivý, takže se záloha prostě nepoužije.
   */
  const fallback = input.fallback ? JSON.stringify(input.fallback) : '""';
  return TEMPLATE
    .split(FALLBACK_MARK).join(fallback)
    .split(URL_MARK).join(url)
    .split(TTL_MARK).join(String(ttl))
    .trim();
}

export const __test = { URL_MARK, TTL_MARK, FALLBACK_MARK };
