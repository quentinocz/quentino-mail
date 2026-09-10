/**
 * Skript, který na e-shopu skládá texty o doručení — a umí je nechat přepsat.
 *
 * ## Proč je to tady, a ne jako soubor na webu
 *
 * Do šablony e-shopu se nedá sáhnout; jediné, co jde, je vložit skript na
 * konec `<head>`. Ten skript ale potřebuje vědět **adresu plánu** (souboru
 * s naplánovanými náhradami), a ta je u každého úložiště jiná. Kdyby se
 * skript vozil zvlášť, musel by se po každé změně adresy přepisovat ručně
 * a nikdo by nepoznal, že ta na webu je stará. Takhle ho aplikace vypíše
 * už s vyplněnou adresou a jde jen zkopírovat.
 *
 * ## Jak se plán čte, aby stránku nezdržel
 *
 * Nejdřív se **vykreslí dynamický text** — přesně ten, co byl na webu doteď.
 * Teprve pak (a mimo hlavní vlákno vykreslování) se sáhne po plánu, a když
 * v něm zrovna něco běží, text se přepíše. Kdyby úložiště nefungovalo,
 * nestane se nic — na stránce zůstane dynamický text.
 *
 * Načtený plán se ukládá do `localStorage`. Kdo si prohlíží deset produktů,
 * stáhne plán jednou za pět minut, ne desetkrát.
 *
 * ## Proč se plánuje v prohlížeči, a ne v aplikaci
 *
 * V souboru je **celý plán i s budoucími okny** a každé má počátek a konec
 * jako čas v milisekundách. Prohlížeč si sám vybere, co zrovna platí, a to
 * i z kopie uložené před hodinou. Aplikace tedy nemusí běžet ve chvíli, kdy
 * má náhrada začít nebo skončit — stačí, že plán někdy dřív vydala.
 */

/** Kde se ve skriptu nahrazuje adresa plánu a jak dlouho stačí uložená kopie. */
const SOURCE_MARK = '__QUENTINO_PLAN_URL__';
const TTL_MARK = '__QUENTINO_PLAN_TTL__';

/*
 * Pozor při úpravách: text níž je `String.raw`, takže se v něm nesmí objevit
 * zpětný apostrof ani `${`. Skript je proto psaný bez šablonových řetězců —
 * spojuje se plusem. Kdyby se tohle porušilo, překlad spadne na TS1005.
 */
const TEMPLATE = String.raw`
<script>
/* Quentino — texty o doručení. Dynamické, s možností naplánované náhrady. */
(function () {
  "use strict";
  if (window.__quentinoTexts) return;
  window.__quentinoTexts = true;

  var SOURCE = "__QUENTINO_PLAN_URL__";
  var TTL_MS = __QUENTINO_PLAN_TTL__ * 1000;
  /*
   * Jak často se texty přepočítají. Za provozu stačí minuta — mění se
   * s denní dobou. Při zkoušení se ale nastavuje krátká platnost uložené
   * kopie a čekat na projevení změny minutu je věčnost, tak se přepočítává
   * stejně často, jak se plán obnovuje.
   */
  var TICK_MS = Math.max(1000, Math.min(60000, TTL_MS));
  var STORE = "quentino-texty-1";
  var TZ = "Europe/Prague";

  /* ================= jazyk ================= */

  function getLang() {
    var h = (location.hostname || "").toLowerCase();
    if (h.slice(-3) === ".sk") return "sk";
    if (h.slice(-4) === ".com") return "en";
    return "cz";
  }
  var LANG = getLang();

  /* Text z plánu je ve všech jazycích; chybí-li ten náš, vezme se český. */
  function pick(value) {
    if (!value) return "";
    if (typeof value === "string") return value;
    var out = value[LANG] || value.cz || "";
    return typeof out === "string" ? out.trim() : "";
  }

  /* ================= text do CSS a tučná slova ================= */

  /*
   * Text do hodnoty CSS.
   *
   * Tady se dá spolehlivě pokazit víc, než by čekal: hodnota je řetězec
   * v uvozovkách, takže uvozovka uvnitř textu ji ukončí, zpětné lomítko
   * začne únikovou sekvenci a konec řádku ji rozbije úplně. A hlavně —
   * únik „\A“ (konec řádku) je šestnáctkové číslo znaku, takže si přibere
   * i to, co za ním následuje: po „\A“ napsané „21.9.“ prohlížeč přečetl
   * jako znak 0A21 a na e-shopu se místo data objevilo „ਡ.9.“. Mezera za
   * únikem ho ukončí a sama se nevypíše — proto se odděluje „\A “ i mezerou.
   */
  function cssText(value) {
    return String(value)
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\r?\n/g, "\\A ");
  }
  function cssLines(lines) {
    return '"' + lines.map(cssText).join("\\A ") + '"';
  }

  /*
   * Tučné slovo se píše dvěma hvězdičkami, jako se to píše v poště nebo
   * v chatu. Hodnota CSS „content“ ale žádné formátování uvnitř neumí, tak
   * se tam hvězdičky jen zahodí a text zůstane obyčejný; kde se kreslí
   * skutečnými prvky, udělá se z toho tučný text.
   */
  function plain(value) {
    return String(value).split("**").join("");
  }
  function bolded(value) {
    return String(value).indexOf("**") >= 0;
  }
  function escapeHtml(value) {
    return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function boldHtml(value) {
    var parts = String(value).split("**");
    var out = "";
    for (var i = 0; i < parts.length; i++) {
      out += (i % 2 ? "<b>" + escapeHtml(parts[i]) + "</b>" : escapeHtml(parts[i]));
    }
    return out;
  }

  /* ================= plán a jeho úschova ================= */

  var plan = null;
  /*
   * Náhrada za localStorage. V anonymním okně Safari a při zakázaných
   * datech stránek „localStorage“ vyhodí výjimku už při čtení — bez tohohle
   * by celý skript spadl a nezobrazil ani dynamický text.
   */
  var memory = null;

  function readCache() {
    try {
      var raw = window.localStorage.getItem(STORE);
      return raw ? JSON.parse(raw) : memory;
    } catch (e) {
      return memory;
    }
  }

  function writeCache(box) {
    memory = box;
    try { window.localStorage.setItem(STORE, JSON.stringify(box)); } catch (e) { /* jen paměť */ }
  }

  /*
   * Co zrovna platí.
   *
   * Oken může být naplánovaných víc; aplikace hlídá, aby se nepřekrývala,
   * ale kdyby se to přesto stalo, rozhoduje to, které začalo později —
   * novější rozhodnutí je to platné. Oblasti, které okno nenastavuje,
   * zůstanou prázdné a chová se jako vždycky.
   */
  function overrides() {
    var out = { product: null, topbar: "", links: null, button: "" };
    if (!plan || !plan.plans || !plan.plans.length) return out;
    var now = Date.now();
    var live = [];
    for (var i = 0; i < plan.plans.length; i++) {
      var one = plan.plans[i];
      if (!one || one.off) continue;
      if (typeof one.fromMs !== "number" || typeof one.toMs !== "number") continue;
      if (now >= one.fromMs && now <= one.toMs) live.push(one);
    }
    live.sort(function (a, b) { return a.fromMs - b.fromMs; });

    for (var j = 0; j < live.length; j++) {
      var p = live[j];
      if (p.product && p.product.on) out.product = p.product;
      if (p.topbar && p.topbar.on) out.topbar = pick(p.topbar.text);
      if (p.links && p.links.on) out.links = p.links;
      if (p.button && p.button.on) out.button = pick(p.button.text);
    }
    return out;
  }

  /* ================= kalendář ================= */

  function nowCz() {
    var f = new Intl.DateTimeFormat("cs-CZ", {
      timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false
    }).formatToParts(new Date());
    var o = {};
    f.forEach(function (p) { if (p.type !== "literal") o[p.type] = p.value; });
    return { y: +o.year, m: +o.month, d: +o.day, minutes: +o.hour * 60 + +o.minute };
  }

  function weekdayShort(y, m, d) {
    return new Intl.DateTimeFormat("en", { timeZone: TZ, weekday: "short" })
      .format(new Date(Date.UTC(y, m - 1, d)));
  }

  function easterSunday(y) {
    var a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
    var f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
    var h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
    var l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
    return { m: Math.floor((h + l - 7 * m + 114) / 31), d: ((h + l - 7 * m + 114) % 31) + 1 };
  }
  function addDays(y, m, d, n) {
    var t = new Date(Date.UTC(y, m - 1, d));
    t.setUTCDate(t.getUTCDate() + n);
    return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
  }
  function sameDate(a, y, m, d) { return a.y === y && a.m === m && a.d === d; }
  function isWeekend(y, m, d) {
    var wd = weekdayShort(y, m, d);
    return wd === "Sat" || wd === "Sun";
  }
  function isHolidayCZ(y, m, d) {
    var fixed = [[1,1],[5,1],[5,8],[7,5],[7,6],[9,28],[10,28],[11,17],[12,24],[12,25],[12,26]];
    for (var i = 0; i < fixed.length; i++) if (fixed[i][0] === m && fixed[i][1] === d) return true;
    var es = easterSunday(y);
    if (sameDate(addDays(y, es.m, es.d, -2), y, m, d)) return true;
    if (sameDate(addDays(y, es.m, es.d, 1), y, m, d)) return true;
    return false;
  }
  function isWorkingDay(y, m, d) { return !isWeekend(y, m, d) && !isHolidayCZ(y, m, d); }
  function nextWorkingDay(y, m, d) {
    var c = addDays(y, m, d, 1);
    while (!isWorkingDay(c.y, c.m, c.d)) c = addDays(c.y, c.m, c.d, 1);
    return c;
  }
  function daysBetween(a, b) {
    return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86400000);
  }
  function gapReason(from, to) {
    var hasWeekend = false, hasHoliday = false;
    var cur = { y: from.y, m: from.m, d: from.d };
    while (!(cur.y === to.y && cur.m === to.m && cur.d === to.d)) {
      cur = addDays(cur.y, cur.m, cur.d, 1);
      if (isWeekend(cur.y, cur.m, cur.d)) hasWeekend = true;
      if (isHolidayCZ(cur.y, cur.m, cur.d)) hasHoliday = true;
      if (daysBetween(from, cur) > 14) break;
    }
    if (hasHoliday) return "holiday";
    if (hasWeekend) return "weekend";
    return "other";
  }
  function fmtDate(o) {
    if (LANG === "en") {
      return new Date(Date.UTC(o.y, o.m - 1, o.d)).toLocaleDateString("en-US", { month: "short", day: "2-digit" });
    }
    return String(o.d).padStart(2, "0") + "." + String(o.m).padStart(2, "0") + ".";
  }

  /* ================= texty ================= */

  var BOX = {
    cz: {
      guarantee: "🎄 Garance doručení do Vánoc při objednání do 18.12.",
      header: "PŘEDPOKLÁDANÝ STAV DORUČENÍ:",
      ship_label: "✅ Expedice:",
      delivery_label: "✅ Předpokládané doručení:",
      pickup_label: "🏪 Osobní odběr:",
      ship_before_noon: "✅ Expedice: ihned zpracováváme (do 12:00)",
      ship_after_noon: "✅ Expedice: objednávku okamžitě připravíme k odeslání",
      ship_nonwork: function (d) { return "⚡ Expedice: bez zdržení – odesíláme " + d; },
      ship_xmas: function (d) { return "🎄 Expedice: odešleme " + d + " (vánoční režim)"; },
      ship_newyear: function (d) { return "🥂 Expedice: odešleme " + d + " (sváteční režim)"; },
      delivery_date: function (d) { return "✅ Předpokládané doručení: " + d + " u Vás"; },
      delivery_weekend: "✅ Předpokládané doručení: hned po víkendu",
      delivery_holidays: "✅ Předpokládané doručení: hned po svátcích",
      delivery_generic: "✅ Předpokládané doručení: co nejdříve",
      pickup: "🏪 Osobní odběr: ihned, Lipová 656, Markvartovice"
    },
    sk: {
      guarantee: "🎄 Garancia doručenia do Vianoc pri objednávke do 18.12.",
      header: "PREDPOKLADANÝ STAV DORUČENIA:",
      ship_label: "✅ Expedícia:",
      delivery_label: "✅ Predpokladané doručenie:",
      pickup_label: "🏪 Osobný odber:",
      ship_before_noon: "✅ Expedícia: ihneď spracúvame (do 12:00)",
      ship_after_noon: "✅ Expedícia: objednávku okamžite pripravíme na odoslanie",
      ship_nonwork: function (d) { return "⚡ Expedícia: bez zdržania – odosielame " + d; },
      ship_xmas: function (d) { return "🎄 Expedícia: odošleme " + d + " (vianočný režim)"; },
      ship_newyear: function (d) { return "🥂 Expedícia: odošleme " + d + " (sviatočný režim)"; },
      delivery_date: function (d) { return "✅ Predpokladané doručenie: " + d + " u Vás"; },
      delivery_weekend: "✅ Predpokladané doručenie: hneď po víkende",
      delivery_holidays: "✅ Predpokladané doručenie: hneď po sviatkoch",
      delivery_generic: "✅ Predpokladané doručenie: čo najskôr",
      pickup: "🏪 Osobný odber: ihneď, Lipová 656, Markvartovice"
    },
    en: {
      guarantee: "🎄 Guaranteed Christmas delivery for orders placed by Dec 18",
      header: "ESTIMATED DELIVERY STATUS:",
      ship_label: "✅ Dispatch:",
      delivery_label: "✅ Estimated delivery:",
      pickup_label: "🏪 Pick up in store:",
      ship_before_noon: "✅ Dispatch: processed immediately (before 12:00)",
      ship_after_noon: "✅ Dispatch: we prepare your order for shipping immediately",
      ship_nonwork: function (d) { return "⚡ Dispatch: fast & smooth – shipping on " + d; },
      ship_xmas: function (d) { return "🎄 Dispatch: shipping on " + d + " (holiday schedule)"; },
      ship_newyear: function (d) { return "🥂 Dispatch: shipping on " + d + " (holiday schedule)"; },
      delivery_date: function (d) { return "✅ Estimated delivery: " + d; },
      delivery_weekend: "✅ Estimated delivery: right after the weekend",
      delivery_holidays: "✅ Estimated delivery: right after the holidays",
      delivery_generic: "✅ Estimated delivery: as soon as possible",
      pickup: "🏪 Pick up in store: Lipová 656, Markvartovice"
    }
  };

  var BAR = {
    cz: {
      xmasGuarantee: "🎄 Garance doručení do Vánoc při objednání do 18.12.",
      xmasMode: function (d) { return "🎄 Vánoční režim • Odesíláme " + d + " • Doručení hned poté"; },
      newYear: function (d) { return "🥂 Sváteční režim • Odesíláme " + d + " • Doručení hned poté"; },
      morningLead: "⚡ Expresní doručení • Dnes odesíláme prioritně • ",
      forenoonLead: "⚡ Expresní doručení • Objednávky zpracováváme ihned • ",
      thuAfter: "✨ Expresní servis • Připravíme ihned • Odesíláme ještě tento pracovní týden",
      friAfter: "✨ Expresní servis • Připravíme ihned • Odesíláme hned první pracovní den",
      afternoon: "✨ Expresní servis • Objednávku okamžitě připravíme k odeslání",
      evening: "✨ Expresní servis • Objednávku připravíme hned ráno",
      nonwork: "✨ Expresní servis • Objednávku připravíme hned • Odesíláme v nejbližší pracovní den",
      deliveryTomorrow: "Zítra u Vás",
      deliveryAfterWeekend: "Hned po víkendu",
      deliveryAfterHolidays: "Hned po svátcích",
      deliveryAsap: "Co nejdříve"
    },
    sk: {
      xmasGuarantee: "🎄 Garancia doručenia do Vianoc pri objednávke do 18.12.",
      xmasMode: function (d) { return "🎄 Vianočný režim • Odosielame " + d + " • Doručenie hneď potom"; },
      newYear: function (d) { return "🥂 Sviatočný režim • Odosielame " + d + " • Doručenie hneď potom"; },
      morningLead: "⚡ Expresné doručenie • Dnes odosielame prioritne • ",
      forenoonLead: "⚡ Expresné doručenie • Objednávky spracúvame ihneď • ",
      thuAfter: "✨ Expresný servis • Pripravíme ihneď • Odosielame ešte tento pracovný týždeň",
      friAfter: "✨ Expresný servis • Pripravíme ihneď • Odosielame hneď prvý pracovný deň",
      afternoon: "✨ Expresný servis • Objednávku okamžite pripravíme na odoslanie",
      evening: "✨ Expresný servis • Objednávku pripravíme hneď ráno",
      nonwork: "✨ Expresný servis • Objednávku pripravíme hneď • Odosielame v najbližší pracovný deň",
      deliveryTomorrow: "Zajtra u Vás",
      deliveryAfterWeekend: "Hneď po víkende",
      deliveryAfterHolidays: "Hneď po sviatkoch",
      deliveryAsap: "Čo najskôr"
    },
    en: {
      xmasGuarantee: "🎄 Guaranteed Christmas delivery for orders placed by Dec 18",
      xmasMode: function (d) { return "🎄 Holiday schedule • Shipping on " + d + " • Delivery right after"; },
      newYear: function (d) { return "🥂 Holiday schedule • Shipping on " + d + " • Delivery right after"; },
      morningLead: "⚡ Express delivery • Priority dispatch today • ",
      forenoonLead: "⚡ Express delivery • Orders processed immediately • ",
      thuAfter: "✨ Express service • Prepared right away • Shipped within this business week",
      friAfter: "✨ Express service • Prepared right away • Shipped first business day",
      afternoon: "✨ Express service • We prepare your order for shipping immediately",
      evening: "✨ Express service • Prepared first thing in the morning",
      nonwork: "✨ Express service • Prepared right away • Shipped next business day",
      deliveryTomorrow: "With you tomorrow",
      deliveryAfterWeekend: "Right after the weekend",
      deliveryAfterHolidays: "Right after the holidays",
      deliveryAsap: "As soon as possible"
    }
  };

  var LINKS = {
    cz: [
      { text: "💍 Sleva na svatební objednávky", href: "https://www.quentino.cz/sleva-na-svatebni-objednavky" },
      { text: "❤️ Vytvořte si vlastní svatební web", href: "https://svatba.quentino.cz", blank: true }
    ],
    sk: [
      { text: "💍 Zľava na svadobné objednávky", href: "https://www.quentino.sk/zlava-na-svadobne-objednavky" },
      { text: "❤️ Vytvorte si vlastný svadobný web", href: "https://svadba.quentino.sk", blank: true }
    ],
    en: [
      { text: "💍 Discount on wedding orders", href: "https://www.wearquentino.com/discount-on-wedding-orders" },
      { text: "❤️ Create your own wedding website", href: "https://svatba.quentino.cz", blank: true }
    ]
  };

  /* ================= tučné slovo ve skutečných prvcích ================= */

  /*
   * Box u produktu i horní lišta se kreslí přes CSS „content“ v pseudoprvku —
   * je to jediné, na co jde v šabloně e-shopu dosáhnout. Uvnitř jedné hodnoty
   * „content“ se ale nedá zvýraznit jedno slovo; je to jeden kus textu.
   *
   * Když se v textu objeví tučné slovo, vloží se proto na to místo skutečný
   * prvek a pseudoprvek se schová. Aby to vypadalo stejně, **opíší se
   * z pseudoprvku spočítané vlastnosti** — písmo, barva, odsazení, rámeček,
   * umístění. Napsat vzhled natvrdo by znamenalo, že o vzhledu boxu
   * rozhoduje tenhle skript místo vlastního CSS e-shopu, a po první úpravě
   * vzhledu by se rozešly.
   *
   * Bez tučného slova se nekreslí nic navíc — za normálního provozu tahle
   * část na vzhled vůbec nesahá.
   */

  var COPIED = [
    "display", "position", "top", "right", "bottom", "left", "zIndex", "float",
    "marginTop", "marginRight", "marginBottom", "marginLeft",
    "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
    "border", "borderRadius", "background", "boxShadow", "color", "opacity", "transform",
    "fontFamily", "fontSize", "fontWeight", "fontStyle", "lineHeight", "letterSpacing",
    "textAlign", "textTransform", "textShadow", "whiteSpace", "maxWidth"
  ];

  function richStyle() {
    if (document.getElementById("q-rich-style")) return;
    var style = document.createElement("style");
    style.id = "q-rich-style";
    style.textContent = [
      ".q-no-before::before { content: none !important; display: none !important; }",
      ".q-no-after::after { content: none !important; display: none !important; }",
      ".q-rich-line { display: block; }",
      ".q-rich b { font-weight: 800; }"
    ].join("\n");
    document.head.appendChild(style);
  }

  /*
   * Kus textu, podle kterého se pozná ten správný pseudoprvek. Emoji
   * a interpunkce se vynechávají: v spočítané hodnotě „content“ bývají
   * zapsané únikem, kdežto písmena a číslice tam jsou tak, jak jsou.
   */
  function probeOf(lines) {
    var best = "";
    for (var i = 0; i < lines.length; i++) {
      var one = plain(lines[i]).replace(/[^0-9A-Za-zÀ-ž ]+/g, " ").replace(/\s+/g, " ").trim();
      if (one.length > best.length) best = one;
    }
    return best.slice(0, 12);
  }

  /*
   * Který prvek a který jeho pseudoprvek text kreslí.
   *
   * Hledá se i mezi potomky: proměnná se dědí, takže „content“ může sedět
   * na vnořeném prvku a ne na tom, kterému se hodnota nastavuje.
   */
  function findPseudo(host, probe) {
    if (!window.getComputedStyle || !probe) return null;
    var candidates = [host];
    var kids = host.querySelectorAll ? host.querySelectorAll("*") : [];
    for (var k = 0; k < kids.length && k < 120; k++) candidates.push(kids[k]);
    var which = ["::before", "::after"];
    for (var i = 0; i < candidates.length; i++) {
      for (var j = 0; j < which.length; j++) {
        var value = "";
        try { value = window.getComputedStyle(candidates[i], which[j]).content || ""; } catch (e) { value = ""; }
        if (value && value.indexOf(probe) >= 0) return { el: candidates[i], which: which[j] };
      }
    }
    return null;
  }

  function copyLook(from, which, to) {
    var css = null;
    try { css = window.getComputedStyle(from, which); } catch (e) { return; }
    if (!css) return;
    for (var i = 0; i < COPIED.length; i++) {
      var value = css[COPIED[i]];
      if (value) to.style[COPIED[i]] = value;
    }
    // Pseudoprvek bývá „inline“; řádky pod sebou potřebují blok
    if (!to.style.display || to.style.display === "inline") to.style.display = "block";
  }

  function findRich(root) {
    var kids = (root && root.children) || [];
    for (var i = 0; i < kids.length; i++) {
      if (String(kids[i].className).indexOf("q-rich") >= 0) return kids[i];
    }
    return null;
  }

  /*
   * Prvek, který text kreslí, se hledá **jen jednou** a pak se označí.
   *
   * Podruhé už by se nenašel: jakmile se pseudoprvek schová, jeho „content“
   * je pryč a hledání podle vykresleného textu nemá čeho se chytit. Kdyby
   * se hledalo pokaždé, text by při každém přepočtu na okamžik zmizel
   * a zase se objevil — blikalo by to každou minutu.
   */
  function carrierOf(host, lines) {
    if (host.classList && host.classList.contains("q-carrier")) return host;
    var marked = host.querySelector ? host.querySelector(".q-carrier") : null;
    if (marked) return marked;

    var found = findPseudo(host, probeOf(lines));
    if (!found) return null;
    found.el.classList.add("q-carrier");
    found.el.setAttribute("data-q-pseudo", found.which);
    return found.el;
  }

  function clearRich(host) {
    var carrier = (host.classList && host.classList.contains("q-carrier"))
      ? host
      : (host.querySelector ? host.querySelector(".q-carrier") : null);
    if (!carrier) return;
    var box = findRich(carrier);
    if (box && box.parentNode) box.parentNode.removeChild(box);
    carrier.classList.remove("q-no-before");
    carrier.classList.remove("q-no-after");
  }

  /**
   * Vykreslí řádky skutečnými prvky, je-li v nich tučné slovo.
   *
   * Kreslí se **až po** nastavení hodnoty do CSS: podle vykresleného textu
   * se pozná, ve kterém pseudoprvku sedí. Když se to nepozná, neudělá se nic
   * a zůstane obyčejný text — je lepší přijít o tučné písmo než o celý box.
   */
  function rich(host, variable, lines) {
    var need = false;
    for (var i = 0; i < lines.length; i++) if (bolded(lines[i])) need = true;
    if (!need) { clearRich(host); return; }

    richStyle();
    var carrier = carrierOf(host, lines);
    if (!carrier) return;
    var which = carrier.getAttribute("data-q-pseudo") || "::before";

    var box = findRich(carrier);
    if (!box) {
      box = document.createElement("div");
      box.className = "q-rich";
      if (which === "::before" && carrier.firstChild) carrier.insertBefore(box, carrier.firstChild);
      else carrier.appendChild(box);
      copyLook(carrier, which, box);
    }
    box.innerHTML = lines.map(function (one) {
      return '<span class="q-rich-line">' + boldHtml(one) + "</span>";
    }).join("");
    carrier.classList.add(which === "::after" ? "q-no-after" : "q-no-before");
  }

  /* ================= 1. box u produktu ================= */

  function isInStock() {
    var abbr = document.querySelector("abbr.icon-text[data-product-id]");
    if (!abbr) return false;
    var txt = (abbr.textContent || "").trim();
    if (txt.indexOf("Není skladem") >= 0) return false;
    if (txt.indexOf("Na dotaz") >= 0) return false;
    return true;
  }

  function dynamicShip(t, T) {
    if (t.m === 12 && t.d >= 18 && t.d <= 26) {
      var x = nextWorkingDay(t.y, 12, 26);
      return { day: x, line: T.ship_xmas(fmtDate(x)) };
    }
    if ((t.m === 12 && t.d === 31) || (t.m === 1 && t.d === 1)) {
      var n = (t.m === 12) ? nextWorkingDay(t.y, 12, 31) : nextWorkingDay(t.y, 1, 1);
      return { day: n, line: T.ship_newyear(fmtDate(n)) };
    }
    if (!isWorkingDay(t.y, t.m, t.d)) {
      var w = nextWorkingDay(t.y, t.m, t.d);
      return { day: w, line: T.ship_nonwork(fmtDate(w)) };
    }
    if (t.minutes < 12 * 60) {
      return { day: { y: t.y, m: t.m, d: t.d }, line: T.ship_before_noon };
    }
    return { day: nextWorkingDay(t.y, t.m, t.d), line: T.ship_after_noon };
  }

  function dynamicDelivery(t, shipDay, T) {
    var deliveryDay = nextWorkingDay(shipDay.y, shipDay.m, shipDay.d);
    var today = { y: t.y, m: t.m, d: t.d };
    if (daysBetween(today, deliveryDay) <= 2) return T.delivery_date(fmtDate(deliveryDay));
    var reason = gapReason(today, deliveryDay);
    if (reason === "holiday") return T.delivery_holidays;
    if (reason === "weekend") return T.delivery_weekend;
    return T.delivery_generic;
  }

  /*
   * Řádky boxu. Náhrada se vždycky týká jen toho, co je vyplněné —
   * nevyplněné řádky se počítají dál podle kalendáře a denní doby, protože
   * jinak by se každá dovolená musela po návratu ručně mazat, aby se e-shop
   * vrátil k pravdě.
   */
  /*
   * Náhrada mění **jen hodnotu za dvojtečkou**, popisek zůstává.
   *
   * Řádek je „✅ Expedice: ihned zpracováváme (do 12:00)“ a nahradit se
   * potřebuje to za dvojtečkou — datum, poznámka. Kdyby se přepisoval celý
   * řádek, musel by se pokaždé znovu opisovat i emotikon a slovo Expedice,
   * a stačilo by jednou zapomenout, aby v boxu zůstalo holé „21.9.“ bez
   * jakéhokoli vysvětlení. Přesně to se stalo při prvním nasazení.
   */
  function valued(label, value) {
    return label + " " + value;
  }

  function boxLines(o) {
    var T = BOX[LANG] || BOX.cz;
    var t = nowCz();
    var lines = [];

    /*
     * Pozor na prázdné texty: oblast má všechna políčka vždycky, jen bývají
     * prázdná. Ptát se na „o.header“ je proto vždycky pravda — musí se ptát
     * na jeho obsah, jinak nadpis zmizí, jakmile se oblast zaškrtne.
     */
    var head = (o && pick(o.header)) || T.header;
    var hideHead = !!(o && o.hideHeader);
    var above = o ? pick(o.above) : "";
    var below = o ? pick(o.below) : "";
    var one = o ? pick(o.one) : "";

    if (one) {
      if (!hideHead) lines.push(head);
      /*
       * Řádek navíc patří dovnitř boxu, pod nadpis — ne nad něj. Nadpis je
       * hlavička celého boxu a text nad ní by visel mimo.
       */
      if (above) lines.push(above);
      lines.push(one);
    } else {
      var ship = dynamicShip(t, T);
      var shipText = o ? pick(o.ship) : "";
      var deliveryText = o ? pick(o.delivery) : "";
      var pickupText = o ? pick(o.pickup) : "";

      // Vánoční garance platí, jen dokud se expedice počítá sama
      if (!shipText && t.m === 12 && t.d >= 1 && t.d <= 18) lines.push(T.guarantee);
      if (!hideHead) lines.push(head);
      if (above) lines.push(above);

      if (!(o && o.hideShip)) {
        lines.push(shipText ? valued(T.ship_label, shipText) : ship.line);
      }
      if (!(o && o.hideDelivery)) {
        lines.push(deliveryText
          ? valued(T.delivery_label, deliveryText)
          : dynamicDelivery(t, ship.day, T));
      }
      if (!(o && o.hidePickup)) {
        if (pickupText) lines.push(valued(T.pickup_label, pickupText));
        else if (isInStock()) lines.push(T.pickup);
      }
    }

    if (below) lines.push(below);
    return lines;
  }

  function applyBox(ov) {
    var el = document.querySelector(".pd-shrt-desc");
    if (!el) return;
    var lines = boxLines(ov.product);
    el.style.setProperty("--shipbox-content", cssLines(lines.map(plain)));
    rich(el, "--shipbox-content", lines);
  }

  /* ================= 2. horní lišta s doručením ================= */

  function barMessage() {
    var T = BAR[LANG] || BAR.cz;
    var t = nowCz();
    var today = { y: t.y, m: t.m, d: t.d };
    var wd = weekdayShort(t.y, t.m, t.d);

    if (t.m === 12 && t.d >= 1 && t.d <= 18) return T.xmasGuarantee;
    if (t.m === 12 && t.d >= 18 && t.d <= 26) return T.xmasMode(fmtDate(nextWorkingDay(t.y, 12, 26)));
    if ((t.m === 12 && t.d === 31) || (t.m === 1 && t.d === 1)) {
      return T.newYear(fmtDate((t.m === 12) ? nextWorkingDay(t.y, 12, 31) : nextWorkingDay(t.y, 1, 1)));
    }
    if (!isWorkingDay(t.y, t.m, t.d)) return T.nonwork;
    if (t.minutes >= 12 * 60 && wd === "Thu") return T.thuAfter;
    if (t.minutes >= 12 * 60 && wd === "Fri") return T.friAfter;

    if (t.minutes < 12 * 60) {
      var deliveryDay = nextWorkingDay(t.y, t.m, t.d);
      var tomorrow = addDays(t.y, t.m, t.d, 1);
      var phrase;
      if (sameDate(deliveryDay, tomorrow.y, tomorrow.m, tomorrow.d)) phrase = T.deliveryTomorrow;
      else {
        var reason = gapReason(today, deliveryDay);
        phrase = reason === "holiday" ? T.deliveryAfterHolidays
          : reason === "weekend" ? T.deliveryAfterWeekend : T.deliveryAsap;
      }
      return (t.minutes < 10 * 60 ? T.morningLead : T.forenoonLead) + phrase;
    }
    if (t.minutes < 17 * 60) return T.afternoon;
    return T.evening;
  }

  function applyBar(ov) {
    var el = document.querySelector(".hdr-phn");
    if (!el) return;
    var msg = ov.topbar || barMessage();
    el.style.setProperty("--topbar-msg", cssLines([plain(msg)]));
    rich(el, "--topbar-msg", [msg]);
  }

  /* ================= 3. lišta s odkazy ================= */

  var rotation = null;
  var shownItems = null;

  function linkItems(ov) {
    var base = (LINKS[LANG] || LINKS.cz).slice();
    var o = ov.links;
    if (!o) return base;
    if (o.mode === "off") return [];

    var extra = [];
    for (var i = 0; i < (o.items || []).length; i++) {
      var one = o.items[i];
      var text = pick(one.text), href = pick(one.href);
      if (!text) continue;
      extra.push({ text: text, href: href || "#", blank: !!one.blank });
    }
    if (o.mode === "replace") return extra;
    return base.concat(extra);
  }

  function ensureStyle() {
    if (document.getElementById("q-weddingbar-anim-style")) return;
    var style = document.createElement("style");
    style.id = "q-weddingbar-anim-style";
    style.textContent = [
      ".q-weddingbar-link { display: inline-flex; align-items: center; gap: 4px; }",
      ".q-weddingbar-text { display: inline-block; transition: opacity 0.4s ease, transform 0.4s ease; }",
      ".q-weddingbar-text.fade-out { opacity: 0; transform: translateY(-6px); }",
      ".q-weddingbar-text.fade-in  { opacity: 0; transform: translateY(6px); }",
      ".q-weddingbar-text.visible  { opacity: 1; transform: translateY(0); }"
    ].join("\n");
    document.head.appendChild(style);
  }

  function setItem(bar, item) {
    var link = bar.querySelector(".q-weddingbar-link");
    var textEl = bar.querySelector(".q-weddingbar-text");
    if (!link || !textEl) return;
    link.href = item.href;
    link.target = item.blank ? "_blank" : "";
    link.rel = item.blank ? "noopener" : "";
    // Skutečný prvek — tučné slovo se sem dá vložit rovnou, bez oklik
    textEl.innerHTML = boldHtml(item.text);
  }

  function buildBar(items) {
    ensureStyle();
    var bar = document.createElement("div");
    bar.className = "q-weddingbar";
    bar.setAttribute("role", "region");
    bar.setAttribute("aria-label", "Quentino");
    var link = document.createElement("a");
    link.className = "q-weddingbar-link";
    var text = document.createElement("span");
    text.className = "q-weddingbar-text visible";
    link.appendChild(text);
    link.insertAdjacentHTML("beforeend",
      '<svg class="ic ic-sm" aria-hidden="true"><use href="/images/icons/fa/solid.svg#angle-right"></use></svg>');
    var container = document.createElement("div");
    container.className = "container";
    container.appendChild(link);
    bar.appendChild(container);
    setItem(bar, items[0]);
    return bar;
  }

  /*
   * Střídání se pouští znovu při každé změně seznamu. Kdyby se jen doplnily
   * položky do běžícího intervalu, ukazoval by se po změně plánu ještě chvíli
   * text, který už neplatí.
   */
  function startRotation(bar, items) {
    if (rotation) { clearInterval(rotation); rotation = null; }
    var textEl = bar.querySelector(".q-weddingbar-text");
    if (!textEl || items.length < 2) return;
    var idx = 0;
    rotation = setInterval(function () {
      textEl.classList.remove("visible");
      textEl.classList.add("fade-out");
      setTimeout(function () {
        idx = (idx + 1) % items.length;
        setItem(bar, items[idx]);
        textEl.classList.remove("fade-out");
        textEl.classList.add("fade-in");
        void textEl.offsetWidth;
        textEl.classList.remove("fade-in");
        textEl.classList.add("visible");
      }, 400);
    }, 5000);
  }

  function insertBar(bar) {
    var bottom = document.querySelector(".hdr-bottom");
    if (bottom && bottom.parentNode) { bottom.parentNode.insertBefore(bar, bottom); return true; }
    var alertBox = document.querySelector(".hdr-alert");
    if (alertBox && alertBox.parentNode) { alertBox.parentNode.insertBefore(bar, alertBox.nextSibling); return true; }
    return false;
  }

  function setupAutoHide(bar) {
    var header = document.querySelector("header.Header") || document.querySelector("header");
    if (!header) return;
    var ticking = false;
    function check() {
      ticking = false;
      var h = header.getBoundingClientRect().height;
      if (h > 0 && h < 120) bar.classList.add("is-hidden");
      else bar.classList.remove("is-hidden");
    }
    function onMove() {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(check);
    }
    window.addEventListener("scroll", onMove, { passive: true });
    window.addEventListener("resize", onMove);
    check();
  }

  function applyLinks(ov) {
    var items = linkItems(ov);
    var bar = document.querySelector(".q-weddingbar");

    if (!items.length) {
      if (bar && bar.parentNode) bar.parentNode.removeChild(bar);
      if (rotation) { clearInterval(rotation); rotation = null; }
      shownItems = "";
      return;
    }

    var stamp = JSON.stringify(items);
    if (bar && stamp === shownItems) return;
    shownItems = stamp;

    if (bar) {
      setItem(bar, items[0]);
      startRotation(bar, items);
      return;
    }
    var fresh = buildBar(items);
    if (!insertBar(fresh)) return;
    startRotation(fresh, items);
    setupAutoHide(fresh);
  }

  /* ================= 4. bublina u tlačítka objednávky ================= */

  var tipEl = null;

  function tipStyle() {
    if (document.getElementById("q-btntip-style")) return;
    var style = document.createElement("style");
    style.id = "q-btntip-style";
    style.textContent = [
      ".q-btntip { position: fixed; z-index: 99999; max-width: 320px; padding: 8px 12px;",
      "  border-radius: 10px; background: rgba(23,23,23,.95); color: #fff; font-size: 14px;",
      "  line-height: 1.35; box-shadow: 0 6px 20px rgba(0,0,0,.25); pointer-events: none;",
      "  opacity: 0; transition: opacity .15s ease; white-space: pre-line; }",
      ".q-btntip.on { opacity: 1; }",
      ".q-btnnote { margin-top: 8px; font-size: 14px; line-height: 1.35; opacity: .85; white-space: pre-line; }"
    ].join("\n");
    document.head.appendChild(style);
  }

  function showTip(button, text) {
    tipStyle();
    if (!tipEl) {
      tipEl = document.createElement("div");
      tipEl.className = "q-btntip";
      tipEl.setAttribute("role", "tooltip");
      document.body.appendChild(tipEl);
    }
    tipEl.innerHTML = boldHtml(text);
    tipEl.classList.add("on");
    var box = button.getBoundingClientRect();
    var own = tipEl.getBoundingClientRect();
    var top = box.top - own.height - 10;
    // Nad tlačítkem nemusí být místo — u dlouhé objednávky bývá dole u kraje
    if (top < 8) top = box.bottom + 10;
    var left = box.left + (box.width - own.width) / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - own.width - 8));
    tipEl.style.top = Math.round(top) + "px";
    tipEl.style.left = Math.round(left) + "px";
  }

  function hideTip() {
    if (tipEl) tipEl.classList.remove("on");
  }

  /*
   * Na dotykovém displeji se nikam nenajíždí a klepnutí objednávku odešle —
   * bublina by se tam nikdy neukázala. Místo ní se text napíše pod tlačítko.
   */
  function applyButton(ov) {
    var button = document.querySelector('button[name="formSendButton"]');
    if (!button) return;
    var text = ov.button;
    var note = document.querySelector(".q-btnnote");

    if (!text) {
      hideTip();
      if (note && note.parentNode) note.parentNode.removeChild(note);
      button.removeAttribute("data-q-tip");
      return;
    }

    var touch = window.matchMedia && window.matchMedia("(hover: none)").matches;
    if (touch) {
      tipStyle();
      if (!note) {
        note = document.createElement("div");
        note.className = "q-btnnote";
        if (button.parentNode) button.parentNode.appendChild(note);
      }
      note.innerHTML = boldHtml(text);
      return;
    }

    button.setAttribute("data-q-tip", text);
    if (button.getAttribute("data-q-tip-on") === "1") return;
    button.setAttribute("data-q-tip-on", "1");
    button.addEventListener("mouseenter", function () {
      var current = button.getAttribute("data-q-tip");
      if (current) showTip(button, current);
    });
    button.addEventListener("focus", function () {
      var current = button.getAttribute("data-q-tip");
      if (current) showTip(button, current);
    });
    button.addEventListener("mouseleave", hideTip);
    button.addEventListener("blur", hideTip);
    window.addEventListener("scroll", hideTip, { passive: true });
  }

  /* ================= 5. telefon online ================= */

  function applyPhone() {
    var bar = document.querySelector(".hdr-alert");
    if (!bar) return;
    var status = bar.querySelector(".qa-status-phone");
    if (!status) return;
    var t = nowCz();
    var on = (t.minutes >= 7 * 60 && t.minutes < 19 * 60);
    bar.classList.toggle("phone-on", on);
    bar.classList.toggle("phone-off", !on);
    status.textContent = on ? "Online" : "Po–Ne 7:00–19:00";
  }

  /* ================= běh ================= */

  function applyAll() {
    var ov = overrides();
    /*
     * Každá oblast zvlášť v try/catch. Kdyby se jedna z nich o něco rozbila
     * (třeba změněné třídy v šabloně), nesmí to shodit ostatní — dřív to
     * byly čtyři samostatné skripty a přesně tuhle vlastnost měly.
     */
    try { applyBox(ov); } catch (e) { /* box zůstane, jak byl */ }
    try { applyBar(ov); } catch (e) { /* lišta zůstane, jak byla */ }
    try { applyLinks(ov); } catch (e) { /* odkazy zůstanou */ }
    try { applyButton(ov); } catch (e) { /* bublina není povinná */ }
    try { applyPhone(); } catch (e) { /* stav telefonu není povinný */ }
  }

  /*
   * Stažení plánu. Nikdy nesmí zdržet vykreslení stránky, proto se pouští
   * až po prvním vykreslení a výsledek se jen promítne do už hotového textu.
   */
  var fetching = false;
  function refresh(force) {
    if (fetching || !SOURCE) return;
    var box = readCache();
    if (!force && box && box.at && (Date.now() - box.at) < TTL_MS) return;
    fetching = true;
    try {
      fetch(SOURCE, { credentials: "omit", mode: "cors" })
        .then(function (res) { return res.ok ? res.json() : null; })
        .then(function (data) {
          fetching = false;
          if (!data || !data.plans) return;
          plan = data;
          writeCache({ at: Date.now(), data: data });
          applyAll();
        })
        .catch(function () {
          /*
           * Výpadek úložiště nesmí nic pokazit: v paměti zůstane poslední
           * známý plán (klidně i starý — okna v něm mají vlastní platnost,
           * takže samy skončí), a když žádný není, běží dynamické texty.
           */
          fetching = false;
        });
    } catch (e) {
      fetching = false;
    }
  }

  function start() {
    var box = readCache();
    if (box && box.data) plan = box.data;
    applyAll();

    // Plán se dotahuje mimo vykreslování — na stránce už mezitím text je
    if (window.requestIdleCallback) window.requestIdleCallback(function () { refresh(false); }, { timeout: 3000 });
    else setTimeout(function () { refresh(false); }, 300);

    setInterval(function () { applyAll(); refresh(false); }, TICK_MS);
    // Vrácení k odložené záložce: text může být hodinu starý
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) { applyAll(); refresh(false); }
    });
  }

  /*
   * Lišty jsou součástí hlavičky a ta se u některých šablon dokresluje až po
   * načtení. Proto se to zkouší znovu, dokud se nechytne — s tvrdým stropem,
   * aby pozorovatel nezůstal viset na každé stránce navěky.
   */
  function watchHeader() {
    if (!document.body) return;
    /*
     * Mezi načtením a dokreslením hlavičky přijdou stovky změn v DOM.
     * Kdyby se na každou počítaly texty znovu, bylo by to vidět na výkonu
     * stránky — proto se seskupí do nejbližšího vykreslení.
     */
    var queued = false;
    var observer = new MutationObserver(function () {
      if (queued) return;
      queued = true;
      requestAnimationFrame(function () { queued = false; applyAll(); });
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(function () { observer.disconnect(); applyAll(); }, 5000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { start(); watchHeader(); });
  } else {
    start();
    watchHeader();
  }
})();
</script>
`;

export interface ScriptConfig {
  /** Veřejná adresa souboru s plánem */
  url: string;
  /** Jak dlouho stačí uložená kopie plánu (sekundy) */
  ttl: number;
}

/**
 * Skript pro vložení na konec `<head>` e-shopu.
 *
 * Adresa plánu se dosazuje až tady, aby na webu nemohla zůstat stará —
 * kdo změní úložiště, zkopíruje skript znovu a je hotovo.
 */
export function headScript(cfg: ScriptConfig): string {
  const ttl = Number.isFinite(cfg.ttl) && cfg.ttl > 0 ? Math.round(cfg.ttl) : 300;
  return TEMPLATE
    .split(SOURCE_MARK).join(cfg.url.replace(/"/g, ''))
    .split(TTL_MARK).join(String(ttl))
    .trim();
}

export const __test = { TEMPLATE, SOURCE_MARK, TTL_MARK };
