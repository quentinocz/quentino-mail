/**
 * Zkušební kabina — co se stáhne po kliknutí a složí model z vrstev.
 *
 * ## Proč je to okno nad stránkou a ne vlastní stránka
 *
 * Zákazník kliká u produktu, který právě vidí. Kdyby se kabina otevřela
 * jako stránka, odešel by z produktu a zpátky už se obvykle nejde.
 * Takhle se nikam neodchází a košík zůstává ten, co byl.
 *
 * ## Proč se barví na plátně a nestahuje se hotový obrázek
 *
 * Vrstva je šedá **mapa světla**. Plátno ji složí s vybranou barvou nebo
 * s vydlážděným kouskem látky režimem `hard-light`: polotón vydá přesně
 * zvolenou barvu, stíny zůstanou stíny. Kdyby se pro každou kombinaci
 * stahoval hotový obrázek, čekalo by se u každého kliknutí a server by
 * musel mít předpřipravené kombinace, kterých je víc než hvězd.
 *
 * ## Proč jsou doplňky konkrétní kusy a kulisa jen barva
 *
 * Quentino prodává doplňky — kravaty, motýlky, kšandy, kapesníčky,
 * pásky. Oblek a košile se neprodávají; zákazník si je nastaví přibližně
 * podle toho, co má doma, aby viděl, na čem ten doplněk bude. Vybírat si
 * motýlka jako odstín by znamenalo ukázat mu něco, co si nemůže koupit.
 *
 * ## Proč se kabina minimalizuje a nezavírá
 *
 * Doplňky se vybírají prohlížením: zákazník přidá motýlka, jde se
 * podívat na kapesníčky, přidá kapesníček. Kabina proto žije **napříč
 * stránkami** — co v ní je, se ukládá do prohlížeče a bublina ji vrátí
 * na kterékoli stránce. Jinak by každý odchod z produktu znamenal
 * začínat znovu.
 *
 * ## Pozor při úpravách
 *
 * Text je `String.raw`: nesmí v něm být zpětný apostrof ani dolar se
 * složenou závorkou. Řetězce se spojují plusem.
 */

const ZDROJ_MARK = '__QUENTINO_KABINA_ZDROJ__';
const TTL_MARK = '__QUENTINO_KABINA_TTL__';

const TEMPLATE = String.raw`
/* Quentino — zkušební kabina. Jak doplňky vypadají na modelu. */
(function () {
  "use strict";
  if (window.quentinoKabina) return;

  var ZDROJ = "__QUENTINO_KABINA_ZDROJ__";
  var TTL_MS = __QUENTINO_KABINA_TTL__ * 1000;
  var ULOZ_KLIC = "quentino-kabina-vzhledy";
  var DATA_KLIC = "quentino-kabina-data";
  var STAV_KLIC = "quentino-kabina-stav";
  var IDS_KLIC = "quentino-kabina-cisla";

  /* ----------------------------------------------------------- jazyk */

  function jazykStranky() {
    var kod = (document.documentElement.getAttribute("lang") || "").toLowerCase();
    var host = location.hostname.toLowerCase();
    if (kod.indexOf("cs") === 0 || kod.indexOf("cz") === 0) return "cz";
    if (kod.indexOf("sk") === 0) return "sk";
    if (host.indexOf(".cz") > 0) return "cz";
    if (host.indexOf(".sk") > 0) return "sk";
    return "en";
  }

  var JAZYK = jazykStranky();
  var MISTO = { cz: "cs-CZ", sk: "sk-SK", en: "en-GB" };

  /*
   * Překlady. Krátké a konkrétní: v okně na mobilu je na každý řádek
   * jedna řádka, takže věta, která se zabalí na tři, zabere místo
   * modelu.
   */
  var SLOVA = {
    cz: {
      kabina: "Zkušební kabina", podnadpis: "Vyberte si doplňky a podívejte se, jak sednou.",
      zavrit: "Zavřít", minimalizovat: "Nechat na později", zpet: "Zpět",
      postava: "Upravit postavu", postavaDelsi: "Věk, postava, výška i barva obleku",
      vek: "Kdo to zkouší", telo: "Postava", vyska: "Výška",
      kravata: "Kravata nebo motýlek", ksandy: "Kšandy", pasek: "Pásek", kapesnicek: "Kapesníček",
      bezFousu: "Bez", kulisa: "Co má na sobě", sako: "Sako", sakoVidi: "Se sakem",
      sakoSkryto: "Bez saka", vesta: "Vesta", kosile: "Košile", kalhoty: "Kalhoty", boty: "Boty",
      vzhledy: "Vzhledy", novy: "Další vzhled", prejmenovat: "Přejmenovat", smazat: "Odebrat",
      vzhled: "Vzhled", kusy: "Co je na modelu", nic: "Na modelu zatím není žádný doplněk.",
      pridat: "Přidat", vymenit: "Vyměnit", odebrat: "Odebrat", nekupuji: "Nekupuji",
      pocet: "Počet", velikost: "Velikost", neniSkladem: "není skladem",
      radaVyska: "Na výšku %v cm vychází %s.", radaRoky: "Na %v roky vychází %s.",
      radaOdhad: "Na výšku %v cm odhadujeme %s. Nejste si jistí?",
      radaNevim: "S velikostí rádi poradíme.", napsat: "Napište nám",
      doporucujeme: "Hodí se k tomu", hledat: "Hledat doplněk", nenalezeno: "Nic takového tu není.",
      vseVKategorii: "Celá nabídka", celkem: "Celkem", doKosiku: "Do košíku",
      vlozeno: "V košíku", vkladam: "Vkládám…", kosik: "Přejít do košíku",
      chyba: "Teď to nejde. Zkuste to prosím znovu.",
      nactitam: "Načítám…", nahrada: "Tenhle kus se na modelu zkusit nedá, ale vybrat můžete jiný.",
      prepnutoDite: "Přepnul jsem model na dítě.", prepnutoDospely: "Přepnul jsem model na dospělého.",
      porovnat: "Porovnat", poslat: "Poslat na mail", odkaz: "Zkopírovat odkaz",
      zkopirovano: "Odkaz je ve schránce.", sdilet: "Sdílet",
      upravit: "Upravit model", upravitDelsi: "Kdo to zkouší a v čem — oblek si nastavte podle svého",
      hotovo: "Hotovo", zacitZnovu: "Začít znovu", vybrat: "Vybrat doplněk", vse: "Vše",
      kravaty: "Kravaty", motylky: "Motýlky", regaty: "Regaty", ksandyMn: "Kšandy", kapesnicky: "Kapesníčky",
      bez: "Bez", smazatVzhled: "Smazat vzhled", naModelu: "Na modelu",
      vyskaProc: "Podle výšky poradíme délku kšand.", zavritDelsi: "Zavřít — vzhled si pamatujeme",
      neniVKabine: "Tenhle kousek si v kabině zatím vyzkoušet nejde — připravujeme ho. Mezitím tu máte podobné:",
      novyVzhledDite: "Dětský kousek jsme dali na nový vzhled s dětským modelem.",
      novyVzhledDospely: "Pánský kousek jsme dali na nový vzhled s dospělým modelem.",
      sada: "sada", vSade: "Součást sady",
      priblizit: "Přiblížit", oddalit: "Oddálit", celyModel: "Celý model",
      velkyObrazek: "Velký obrázek celého modelu", velkyRada: "Klepnutím přiblížíte, dalším vrátíte",
      chybiVrstva: "Pro tenhle model zatím není připravená vrstva — dokresli ji v aplikaci ve Vizuálech."
    },
    sk: {
      kabina: "Skúšobná kabína", podnadpis: "Vyberte si doplnky a pozrite sa, ako sadnú.",
      zavrit: "Zavrieť", minimalizovat: "Nechať na neskôr", zpet: "Späť",
      postava: "Upraviť postavu", postavaDelsi: "Vek, postava, výška aj farba obleku",
      vek: "Kto to skúša", telo: "Postava", vyska: "Výška",
      kravata: "Kravata alebo motýlik", ksandy: "Traky", pasek: "Opasok", kapesnicek: "Vreckovka",
      bezFousu: "Bez", kulisa: "Čo má na sebe", sako: "Sako", sakoVidi: "So sakom",
      sakoSkryto: "Bez saka", vesta: "Vesta", kosile: "Košeľa", kalhoty: "Nohavice", boty: "Topánky",
      vzhledy: "Vzhľady", novy: "Ďalší vzhľad", prejmenovat: "Premenovať", smazat: "Odobrať",
      vzhled: "Vzhľad", kusy: "Čo je na modeli", nic: "Na modeli zatiaľ nie je žiadny doplnok.",
      pridat: "Pridať", vymenit: "Vymeniť", odebrat: "Odobrať", nekupuji: "Nekupujem",
      pocet: "Počet", velikost: "Veľkosť", neniSkladem: "nie je na sklade",
      radaVyska: "Na výšku %v cm vychádza %s.", radaRoky: "Na %v roky vychádza %s.",
      radaOdhad: "Na výšku %v cm odhadujeme %s. Nie ste si istí?",
      radaNevim: "S veľkosťou radi poradíme.", napsat: "Napíšte nám",
      doporucujeme: "Hodí sa k tomu", hledat: "Hľadať doplnok", nenalezeno: "Nič také tu nie je.",
      vseVKategorii: "Celá nabídka", celkem: "Celkom", doKosiku: "Do košíka",
      vlozeno: "V košíku", vkladam: "Vkladám…", kosik: "Prejsť do košíka",
      chyba: "Teraz to nejde. Skúste to prosím znova.",
      nactitam: "Načítavam…", nahrada: "Tento kus sa na modeli skúsiť nedá, ale vybrať môžete iný.",
      prepnutoDite: "Prepol som model na dieťa.", prepnutoDospely: "Prepol som model na dospelého.",
      porovnat: "Porovnať", poslat: "Poslať na mail", odkaz: "Skopírovať odkaz",
      zkopirovano: "Odkaz je v schránke.", sdilet: "Zdieľať",
      upravit: "Upraviť model", upravitDelsi: "Kto to skúša a v čom — oblek si nastavte podľa seba",
      hotovo: "Hotovo", zacitZnovu: "Začať odznova", vybrat: "Vybrať doplnok", vse: "Všetko",
      kravaty: "Kravaty", motylky: "Motýliky", regaty: "Regaty", ksandyMn: "Traky", kapesnicky: "Vreckovky",
      bez: "Bez", smazatVzhled: "Zmazať vzhľad", naModelu: "Na modeli",
      vyskaProc: "Podľa výšky poradíme dĺžku trakov.", zavritDelsi: "Zavrieť — vzhľad si pamätáme",
      neniVKabine: "Tento kúsok si v kabíne zatiaľ vyskúšať nedá — pripravujeme ho. Zatiaľ tu máte podobné:",
      novyVzhledDite: "Detský kúsok sme dali na nový vzhľad s detským modelom.",
      novyVzhledDospely: "Pánsky kúsok sme dali na nový vzhľad s dospelým modelom.",
      sada: "sada", vSade: "Súčasť sady",
      priblizit: "Priblížiť", oddalit: "Oddialiť", celyModel: "Celý model",
      velkyObrazek: "Veľký obrázok celého modelu", velkyRada: "Ťuknutím priblížite, ďalším vrátite",
      chybiVrstva: "Pre tento model zatiaľ nie je pripravená vrstva."
    },
    en: {
      kabina: "Fitting room", podnadpis: "Pick the accessories and see how they look.",
      zavrit: "Close", minimalizovat: "Keep for later", zpet: "Back",
      postava: "Adjust the model", postavaDelsi: "Age, build, height, hair and suit colour",
      vek: "Who is trying", telo: "Build", vyska: "Height",
      kravata: "Tie or bow tie", ksandy: "Braces", pasek: "Belt", kapesnicek: "Pocket square",
      bezFousu: "None", kulisa: "What he is wearing", sako: "Jacket", sakoVidi: "With jacket",
      sakoSkryto: "No jacket", vesta: "Waistcoat", kosile: "Shirt", kalhoty: "Trousers", boty: "Shoes",
      vzhledy: "Looks", novy: "Another look", prejmenovat: "Rename", smazat: "Remove",
      vzhled: "Look", kusy: "On the model", nic: "No accessory on the model yet.",
      pridat: "Add", vymenit: "Swap", odebrat: "Remove", nekupuji: "Not buying",
      pocet: "Quantity", velikost: "Size", neniSkladem: "out of stock",
      radaVyska: "For %v cm the size is %s.", radaRoky: "For age %v the size is %s.",
      radaOdhad: "For %v cm we would say %s. Not sure?",
      radaNevim: "We are happy to help with the size.", napsat: "Write to us",
      doporucujeme: "Goes well with", hledat: "Search accessories", nenalezeno: "Nothing like that here.",
      vseVKategorii: "See all", celkem: "Total", doKosiku: "Add to cart",
      vlozeno: "In the cart", vkladam: "Adding…", kosik: "Go to cart",
      chyba: "That did not work. Please try again.",
      nactitam: "Loading…", nahrada: "This one cannot be tried on the model, but you can pick another.",
      prepnutoDite: "Switched the model to a child.", prepnutoDospely: "Switched the model to an adult.",
      porovnat: "Compare", poslat: "Send by e-mail", odkaz: "Copy link",
      zkopirovano: "Link copied.", sdilet: "Share",
      upravit: "Adjust the model", upravitDelsi: "Who is trying and what he wears — set the suit like your own",
      hotovo: "Done", zacitZnovu: "Start over", vybrat: "Choose an accessory", vse: "All",
      kravaty: "Ties", motylky: "Bow ties", regaty: "Cravats", ksandyMn: "Braces", kapesnicky: "Pocket squares",
      bez: "None", smazatVzhled: "Delete look", naModelu: "On the model",
      vyskaProc: "We use the height to suggest the braces length.", zavritDelsi: "Close — we keep your look",
      neniVKabine: "This one is not ready for the fitting room yet — we are working on it. Meanwhile, here are similar ones:",
      novyVzhledDite: "We put the kids' piece on a new look with a child model.",
      novyVzhledDospely: "We put the men's piece on a new look with an adult model.",
      sada: "set", vSade: "Part of the set",
      priblizit: "Zoom in", oddalit: "Zoom out", celyModel: "Whole model",
      velkyObrazek: "Large image of the whole model", velkyRada: "Tap to zoom in, tap again to fit",
      chybiVrstva: "This layer is not ready for this model yet."
    }
  };

  function t(klic, nahrady) {
    var text = (SLOVA[JAZYK] || SLOVA.cz)[klic];
    if (text == null) text = SLOVA.cz[klic] || klic;
    if (nahrady) {
      for (var k in nahrady) {
        if (Object.prototype.hasOwnProperty.call(nahrady, k)) {
          text = text.split("%" + k).join(String(nahrady[k]));
        }
      }
    }
    return text;
  }

  /* --------------------------------------------------------- pomůcky */

  function el(tag, trida, text) {
    var e = document.createElement(tag);
    if (trida) e.className = trida;
    if (text != null) e.textContent = text;
    return e;
  }

  function tlac(trida, text, kliknuti) {
    var b = el("button", trida, text);
    b.type = "button";
    if (kliknuti) b.addEventListener("click", kliknuti);
    return b;
  }

  function naHex(hex) {
    var t2 = String(hex || "").replace("#", "");
    if (t2.length === 3) t2 = t2[0] + t2[0] + t2[1] + t2[1] + t2[2] + t2[2];
    if (!/^[0-9a-fA-F]{6}$/.test(t2)) return null;
    return {
      r: parseInt(t2.slice(0, 2), 16),
      g: parseInt(t2.slice(2, 4), 16),
      b: parseInt(t2.slice(4, 6), 16)
    };
  }

  function zHex(r, g, b) {
    function one(v) {
      var x = Math.max(0, Math.min(255, Math.round(v))).toString(16);
      return x.length < 2 ? "0" + x : x;
    }
    return "#" + one(r) + one(g) + one(b);
  }

  /*
   * Barva, kterou se podloží plátno, aby po složení vyšla přesně ta
   * zvolená. Neutrální bod režimu hard-light leží na 127,5 a ten se do
   * osmi bitů nevejde — mapa má polotón 128, takže by každý oblek vyšel
   * o stupeň světlejší. Tady se ten stupeň předem odečte.
   */
  function podMapu(hex) {
    var rgb = naHex(hex) || { r: 0, g: 0, b: 0 };
    var s = 128 / 255;
    function uprav(v) {
      var x = v / 255;
      var c = 1 - (1 - x) / (2 * (1 - s));
      return Math.max(0, Math.min(255, Math.round(c * 255)));
    }
    return zHex(uprav(rgb.r), uprav(rgb.g), uprav(rgb.b));
  }

  function rozdilBarev(a, b) {
    var x = naHex(a), y = naHex(b);
    if (!x || !y) return 1;
    var d = Math.sqrt((x.r - y.r) * (x.r - y.r) + (x.g - y.g) * (x.g - y.g) + (x.b - y.b) * (x.b - y.b));
    return Math.min(1, d / 441.67);
  }

  function ztmav(hex, dil) {
    var rgb = naHex(hex);
    if (!rgb) return hex;
    var k = Math.max(0, 1 - dil);
    return zHex(rgb.r * k, rgb.g * k, rgb.b * k);
  }

  function bezDiakritiky(text) {
    return String(text || "").normalize ? String(text).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
      : String(text || "").toLowerCase();
  }

  /** Cesta z adresy — tím se produkt ze stránky pozná v našich datech. */
  function cesta(url) {
    if (!url) return "";
    try { return new URL(url, location.href).pathname.replace(/\/+$/, "").toLowerCase(); }
    catch (e) { return String(url).replace(/\/+$/, "").toLowerCase(); }
  }

  /* Měna se bere z ceny produktu, ne z jazyka: e-shop ji může mít
     nastavenou jinak, než by člověk podle jazyka čekal */
  var MENA = JAZYK === "cz" ? "Kč" : "€";
  function zapamatujMenu(produkty) {
    for (var i = 0; i < produkty.length; i++) {
      /* Cena v jazyce, ve kterém se zákazník dívá — na anglickém e-shopu eura, ne koruny */
      var c = String(proTrh(produkty[i]).cena || "").replace(/[0-9\s .,]/g, "").trim();
      if (c) { MENA = c; return; }
    }
  }

  function cena(c) {
    var cislo;
    try { cislo = new Intl.NumberFormat(MISTO[JAZYK] || "cs-CZ").format(Math.round(c)); }
    catch (e) { cislo = String(Math.round(c)); }
    return cislo + " " + MENA;
  }

  /* ------------------------------------------------------------ data */

  var DATA = null;
  var nacitam = null;

  function zCache() {
    try {
      var raw = localStorage.getItem(DATA_KLIC);
      if (!raw) return null;
      var ulozene = JSON.parse(raw);
      if (!ulozene || Date.now() - ulozene.kdy > TTL_MS) return null;
      return ulozene.data;
    } catch (e) { return null; }
  }

  function nactiData() {
    if (DATA) return Promise.resolve(DATA);
    if (nacitam) return nacitam;
    var hotove = zCache();
    if (hotove) { DATA = hotove; zapamatujMenu(DATA.produkty || []); return Promise.resolve(DATA); }
    nacitam = fetch(ZDROJ, { credentials: "omit" })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        DATA = data;
        zapamatujMenu(DATA.produkty || []);
        try { localStorage.setItem(DATA_KLIC, JSON.stringify({ kdy: Date.now(), data: data })); }
        catch (e) { /* plná schránka kabinu nezastaví */ }
        return data;
      });
    return nacitam;
  }

  function katalog() { return (DATA && DATA.katalog) || {}; }
  function nastaveni() { return (DATA && DATA.nastaveni) || {}; }

  /** Produkt v jazyce, ve kterém se zákazník dívá. */
  function proTrh(p) {
    if (!p) return p;
    var d = p.trhy && p.trhy[JAZYK];
    if (!d || !d.url) return p;
    /*
     * Kopie celého produktu, přepíše se jen jazyk. Dřív se vypisovala
     * pole jedno po druhém a vypadlo z nich měřítko vzorku — na
     * anglické a slovenské verzi se pak látka dláždila bod na bod
     * a z drobného vzoru byly talíře.
     */
    var out = {};
    for (var klic in p) if (Object.prototype.hasOwnProperty.call(p, klic)) out[klic] = p[klic];
    out.nazev = d.nazev || p.nazev;
    out.url = d.url;
    out.cena = d.cena || p.cena;
    out.cenaCislo = d.cenaCislo || p.cenaCislo;
    return out;
  }

  function produkty() {
    var vse = (DATA && DATA.produkty) || [];
    var out = [];
    for (var i = 0; i < vse.length; i++) out.push(proTrh(vse[i]));
    return out;
  }

  var PRODUKTY = null;
  function vsechny() {
    if (!PRODUKTY) PRODUKTY = produkty();
    return PRODUKTY;
  }

  function produkt(kod) {
    if (!kod) return null;
    var vse = vsechny();
    var dil = String(kod).split("~");
    for (var i = 0; i < vse.length; i++) {
      if (vse[i].kod !== dil[0]) continue;
      if (dil.length < 2) return vse[i];
      /*
       * Další kus sady: kšandy s motýlkem jsou jeden produkt, ale na
       * modelu dva kusy. Patrik (23. 11.): „u sady kšandy+motýlek se
       * zobrazí jen kšandy". Kus sady má vlastní vzorek a vrstvu, ale
       * kupuje se s hlavním produktem — v košíku a součtu není.
       */
      var c = (vse[i].casti || [])[Number(dil[1])];
      if (!c) return null;
      return {
        kod: kod, sada: vse[i].kod, nazev: vse[i].nazev, url: vse[i].url, obrazek: vse[i].obrazek,
        cena: "", cenaCislo: 0, typ: c.typ, varianta: c.varianta, hex: c.hex,
        vzorek: c.vzorek, vzorekCm: c.vzorekCm, vzorekRoh: c.vzorekRoh, proVek: vse[i].proVek,
        vykresleni: c.vykresleni
      };
    }
    return null;
  }

  /** Je kus na modelu jen součástí sady (nekupuje se zvlášť)? */
  function jeDilSady(kus) {
    return !!(kus && kus.produkt && String(kus.produkt).indexOf("~") > 0);
  }

  /** Sundá z modelu ostatní kusy sady, když hlavní kus odchází. */
  function odeberSadu(v, kod) {
    if (!kod) return;
    for (var typ in v.kusy) {
      if (!Object.prototype.hasOwnProperty.call(v.kusy, typ)) continue;
      var k = v.kusy[typ];
      if (k && k.produkt && String(k.produkt).indexOf(kod + "~") === 0) delete v.kusy[typ];
    }
  }

  /** Produkt podle toho, co o něm ví stránka. */
  function najdiProdukt(co) {
    var vse = vsechny();
    var hledana = cesta(co.url);
    var i;
    if (hledana) {
      for (i = 0; i < vse.length; i++) if (cesta(vse[i].url) === hledana) return vse[i];
    }
    if (co.kod) {
      for (i = 0; i < vse.length; i++) if (vse[i].kod === co.kod) return vse[i];
    }
    var nazev = bezDiakritiky(co.nazev);
    if (nazev.length > 4) {
      for (i = 0; i < vse.length; i++) if (bezDiakritiky(vse[i].nazev) === nazev) return vse[i];
    }
    return null;
  }

  function postavaPro(vzhled) {
    var hledane = vzhled.vek + "-" + vzhled.telo;
    var vse = (DATA && DATA.postavy) || [];
    for (var i = 0; i < vse.length; i++) if (vse[i].id === hledane) return vse[i];
    for (var j = 0; j < vse.length; j++) if (vse[j].vek === vzhled.vek) return vse[j];
    return vse[0] || null;
  }

  function vrstvaPro(postava, typ, varianta) {
    var vse = (DATA && DATA.vrstvy) || [];
    for (var i = 0; i < vse.length; i++) {
      var v = vse[i];
      if (v.postava === postava && v.typ === typ && v.varianta === varianta) return v;
    }
    return null;
  }

  function defVrstvy(typ) {
    var vse = katalog().vrstvy || [];
    for (var i = 0; i < vse.length; i++) if (vse[i].typ === typ) return vse[i];
    return null;
  }

  function nazevVrstvy(typ) {
    var d = defVrstvy(typ);
    var preklad = t(typ);
    if (preklad !== typ) return preklad;
    return d ? d.nazev : typ;
  }

  function maProdukty(typ) {
    var vse = vsechny();
    for (var i = 0; i < vse.length; i++) if (vse[i].typ === typ) return true;
    return false;
  }

  /* --------------------------------------------------------- vzhledy */

  function vychozi() {
    var zaklad = katalog().vychozi;
    if (zaklad) {
      var kopie = JSON.parse(JSON.stringify(zaklad));
      kopie.kusy = kopie.kusy || {};
      return kopie;
    }
    return {
      vek: "dospely", telo: "bezny", vyskaCm: 180,
      sako: "auto", kusy: {}
    };
  }

  /**
   * Je sako vidět?
   *
   * S kšandami se samo schová — kšandy se nosí pod sakem a vidět z nich
   * není nic, takže ukázat kšandy v saku znamená ukázat sako. Přebít se
   * to dá oběma směry: ke kšandám se často vybírá kapesníček a ten je
   * v klopě saka.
   */
  function sakoVidi(v) {
    if (!v.kusy.sako) return false;
    var rezim = v.sako || "auto";
    if (rezim === "vidi") return true;
    if (rezim === "skryto") return false;
    return !v.kusy.ksandy;
  }

  /*
   * Je sako na modelu opravdu nakreslené? Nestačí, že ho zákazník chce:
   * když vrstva saka pro tuhle postavu chybí (neprošla kontrolou), byl
   * by kapesníček „v kapse" na holé košili (Patrik, 23. 11.).
   */
  function sakoNaModelu(v) {
    if (!sakoVidi(v)) return false;
    var postava = postavaPro(v);
    return !!(postava && vrstvaPro(postava.id, "sako", v.kusy.sako.varianta));
  }

  function vrstvyVzhledu(v) {
    var poradi = katalog().poradi || [];
    var sako = sakoNaModelu(v);
    var out = [];
    for (var i = 0; i < poradi.length; i++) {
      var typ = poradi[i];
      if (typ === "postava") { out.push({ typ: typ, varianta: "zaklad", hex: "" }); continue; }
      if (typ === "sako" && !sako) continue;
      if (typ === "kapesnicek" && !sako) continue;
      var kus = v.kusy[typ];
      if (kus) out.push({ typ: typ, varianta: kus.varianta, hex: kus.hex, produkt: kus.produkt });
    }
    return out;
  }

  function doTextu(v) {
    /* Místa po vlasech a vousech zůstávají prázdná: odkaz z loňska má
       v hlavičce sedm dílů a čte se podle pořadí */
    var casti = [[v.vek, v.telo, v.vyskaCm, "-", "-", "-", v.sako || "auto"].join(":")];
    var poradi = katalog().poradi || [];
    for (var i = 0; i < poradi.length; i++) {
      var typ = poradi[i];
      if (typ === "postava") continue;
      var kus = v.kusy[typ];
      if (!kus) continue;
      var radek = [typ, kus.varianta, String(kus.hex).replace("#", ""), kus.produkt || "",
        kus.pocet == null ? "" : String(kus.pocet), kus.velikost || ""].join(":");
      casti.push(radek.replace(/:+$/, ""));
    }
    return casti.join("|");
  }

  function zTextu(text) {
    var casti = String(text || "").split("|");
    var hlava = (casti[0] || "").split(":");
    if (hlava.length < 6) return null;
    var v = vychozi();
    v.vek = hlava[0];
    v.telo = hlava[1];
    v.vyskaCm = Number(hlava[2]) || v.vyskaCm;
    v.sako = hlava[6] === "vidi" || hlava[6] === "skryto" ? hlava[6] : "auto";
    v.kusy = {};
    for (var i = 1; i < casti.length; i++) {
      var k = casti[i].split(":");
      if (!k[0]) continue;
      v.kusy[k[0]] = {
        varianta: k[1] || "", hex: "#" + (k[2] || "ffffff"), produkt: k[3] || "",
        pocet: k[4] === "" || k[4] == null ? undefined : Math.max(0, Number(k[4]) || 0),
        velikost: k[5] || ""
      };
    }
    return v;
  }

  /* ------------------------------------------------------- skládání */

  var obrazky = {};

  function obrazek(url) {
    if (obrazky[url]) return obrazky[url];
    obrazky[url] = new Promise(function (hotovo, chyba) {
      var img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = function () { hotovo(img); };
      img.onerror = function () { chyba(new Error("vrstva se nenačetla")); };
      img.src = url;
    });
    return obrazky[url];
  }

  /*
   * Jedna vrstva na pomocné plátno. Podklad je buď zvolená barva
   * (kulisa), nebo vydlážděný kousek látky z fotky produktu (zboží).
   * Přes podklad jde mapa světla režimem hard-light a nakonec se to
   * ořízne průhledností vrstvy — bez oříznutí by podklad zůstal i tam,
   * kde látka není.
   */
  var pomocne = null;
  function oblec(img, hex, vzorekImg, sirka, vyska, zmenseni, roh) {
    if (!pomocne) pomocne = document.createElement("canvas");
    pomocne.width = sirka;
    pomocne.height = vyska;
    var ctx = pomocne.getContext("2d");
    ctx.clearRect(0, 0, sirka, vyska);
    ctx.globalCompositeOperation = "source-over";
    if (vzorekImg && roh) {
      /*
       * Kapesníček: vzorek je špička výrobku i s lemem, natažená přes
       * obdélník vrstvy. Bílý kapesníček s barevným lemem tak má bílou
       * plochu a lem po hranách — dřív byl celý barevný (Patrik, 23. 11.).
       */
      ctx.fillStyle = podMapu(hex || "#808080");
      ctx.fillRect(0, 0, sirka, vyska);
      ctx.drawImage(vzorekImg, roh[0], roh[1], roh[2], roh[3]);
    } else if (vzorekImg) {
      var vzor = ctx.createPattern(vzorekImg, "repeat");
      /*
       * Vzorek se zmenší na skutečnou velikost látky. Dlážděný bod na bod
       * ukazoval 2,5 cm látky z fotky přes osm centimetrů kravaty a z
       * drobných kytek byly talíře.
       */
      if (vzor && zmenseni && zmenseni !== 1 && vzor.setTransform && window.DOMMatrix) {
        try { vzor.setTransform(new DOMMatrix().scale(zmenseni, zmenseni)); } catch (e) { /* bez zmenšení */ }
      }
      ctx.fillStyle = vzor || podMapu(hex || "#808080");
      ctx.fillRect(0, 0, sirka, vyska);
    } else {
      ctx.fillStyle = podMapu(hex);
      ctx.fillRect(0, 0, sirka, vyska);
    }
    ctx.globalCompositeOperation = "hard-light";
    ctx.drawImage(img, 0, 0, sirka, vyska);
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage(img, 0, 0, sirka, vyska);
    ctx.globalCompositeOperation = "source-over";
    return pomocne;
  }

  /*
   * Výřez, který se ukazuje: hlava až půlka stehen, ne celá postava.
   * Patrik (23. 11.): boty neprodáváme, model nemusí být vidět od hlavy
   * k patě — má být přiblížený na to podstatné. Na celé postavě byla
   * kravata úzká čárka a kapesníček skoro neviditelný.
   */
  var vyrezTed = null;

  function vyrezPostavy(postava) {
    var sirka = postava.sirka;
    var vyska = postava.vyska;
    var temeno = postava.temeno || 0;
    var h = Math.max(1, (postava.podrazka || vyska) - temeno);
    var k = postava.kotvy || null;
    var pas = k && k.pas ? k.pas : temeno + h * 0.42;
    var y0 = Math.max(0, Math.round(temeno - h * 0.04));
    var y1 = Math.min(vyska, Math.round(pas + h * 0.2));
    var vys = Math.max(10, y1 - y0);
    var sir = Math.min(sirka, Math.round(vys * 0.8));
    var stred = k && k.kravata ? k.kravata[0] : sirka / 2;
    var x0 = Math.max(0, Math.min(sirka - sir, Math.round(stred - sir / 2)));
    return { x: x0, y: y0, w: sir, h: vys, sirka: sirka, vyska: vyska };
  }

  /** Kolik bodů plátna je centimetr na postavě. */
  function bodyNaCm(postava) {
    var h = (postava.podrazka || postava.vyska) - (postava.temeno || 0);
    return h > 0 && postava.vyskaCm ? h / postava.vyskaCm : 0;
  }

  /*
   * Celá postava od temene po podrážky — pro velký obrázek. Patrik
   * (25. 11.): „přidej možnost na PC i mobilu zobrazit větší obrázek
   * celého poskládaného modela".
   */
  function celaPostava(postava) {
    var vyska = postava.vyska;
    var temeno = postava.temeno || 0;
    var podrazka = postava.podrazka || vyska;
    var h = Math.max(1, podrazka - temeno);
    var y0 = Math.max(0, Math.round(temeno - h * 0.03));
    var y1 = Math.min(vyska, Math.round(podrazka + h * 0.02));
    return { x: 0, y: y0, w: postava.sirka, h: Math.max(10, y1 - y0), sirka: postava.sirka, vyska: vyska };
  }

  function nakresli(platno, v) {
    if (!plne) plne = document.createElement("canvas");
    return slozModel(v, plne, vyrezPostavy).then(function (vyrez) {
      if (!vyrez) return;
      vyrezTed = vyrez;
      zmensiNa(platno, plne, vyrez);
    });
  }

  /** Složí model do plátna „cil“ v dvojnásobném rozlišení; „oblast“ vybere výřez postavy. */
  function slozModel(v, cil, oblast) {
    var postava = postavaPro(v);
    if (!postava) return Promise.resolve(null);
    var sirka = postava.sirka;
    var vyska = postava.vyska;
    var kusy = vrstvyVzhledu(v);
    var cekani = [];
    var mam = [];
    var i;
    for (i = 0; i < kusy.length; i++) {
      var vr = vrstvaPro(postava.id, kusy[i].typ, kusy[i].varianta);
      if (!vr || !vr.url) continue;
      var zbozi = produkt(kusy[i].produkt);
      /*
       * Kus vykreslený na modelu celý (AI podle fotky, šablona jako
       * vodítko) má přednost před šablonou se vzorkem — vzor, záhyby
       * i spony jsou tam skutečné. Šablona zůstává jako záloha.
       */
      var vyk = zbozi && zbozi.vykresleni ? zbozi.vykresleni[postava.id] : null;
      mam.push({
        kus: kusy[i], vrstva: vr, vykresleni: vyk || null,
        vzorek: zbozi && zbozi.vzorek && !vyk ? zbozi.vzorek : "",
        vzorekCm: zbozi && zbozi.vzorekCm ? zbozi.vzorekCm : 0,
        roh: zbozi && zbozi.vzorekRoh && vr.okraje ? vr.okraje : null
      });
      cekani.push(obrazek(vr.url).catch(function () { return null; }));
    }
    /* Kov kšand (spony, posuvky) — kreslí se přes obarvený pásek, sám se nebarví */
    for (var kv = 0; kv < mam.length; kv++) {
      cekani.push(mam[kv].vrstva.kov ? obrazek(mam[kv].vrstva.kov).catch(function () { return null; }) : Promise.resolve(null));
    }
    /* Vzorky látek se načítají vedle vrstev, ne po nich — jinak se model
       překresluje dvakrát a při přepínání kravat to poskakuje */
    for (var z = 0; z < mam.length; z++) {
      cekani.push(mam[z].vzorek ? obrazek(mam[z].vzorek).catch(function () { return null; }) : Promise.resolve(null));
    }
    for (var zv = 0; zv < mam.length; zv++) {
      cekani.push(mam[zv].vykresleni ? obrazek(mam[zv].vykresleni[0]).catch(function () { return null; }) : Promise.resolve(null));
    }
    var naCm = bodyNaCm(postava);
    return Promise.all(cekani).then(function (nactene) {
      var vyrez = oblast(postava);
      /*
       * Plné plátno ve dvojnásobném rozlišení postavy: vykreslené kusy
       * jsou v něm ostré i v přiblížení. Kulisa se jen zvětší (je to
       * hladká látka), práce navíc je jedno zvětšení obrázku na vrstvu.
       */
      cil.width = Math.round(vyrez.w * PLNE);
      cil.height = Math.round(vyrez.h * PLNE);
      var ctx = cil.getContext("2d");
      ctx.clearRect(0, 0, cil.width, cil.height);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.save();
      ctx.scale(PLNE, PLNE);
      ctx.translate(-vyrez.x, -vyrez.y);
      for (var j = 0; j < mam.length; j++) {
        var img = nactene[j];
        if (!img) continue;
        var def = defVrstvy(mam[j].kus.typ);
        var vzorekImg = nactene[mam.length * 2 + j] || null;
        var kovImg = nactene[mam.length + j] || null;
        var vykImg = nactene[mam.length * 3 + j] || null;
        var zmenseni = vzorekImg && mam[j].vzorekCm && naCm
          ? (mam[j].vzorekCm * naCm) / Math.max(1, vzorekImg.width) : 1;
        /*
         * Doplněk vrhá na košili jemný stín. Bez něj ležel jako nálepka —
         * přesně to „kostrbaté" na šablonách. Stín se bere z průhlednosti
         * vrstvy, takže sedí na tvar.
         */
        var stin = def && def.zbozi && naCm;
        if (stin) {
          ctx.shadowColor = "rgba(0,0,0,.28)";
          /* Stín se transformací plátna nezvětšuje — násobí se ručně */
          ctx.shadowBlur = Math.max(2, naCm * 0.5) * PLNE;
          ctx.shadowOffsetX = 0;
          ctx.shadowOffsetY = Math.max(1, naCm * 0.18) * PLNE;
        }
        if (vykImg) {
          var vk = mam[j].vykresleni;
          ctx.drawImage(vykImg, vk[1], vk[2], vk[3], vk[4]);
        } else if (def && def.barvitelna && (mam[j].kus.hex || vzorekImg)) {
          ctx.drawImage(oblec(img, mam[j].kus.hex, vzorekImg, sirka, vyska, zmenseni, mam[j].roh), 0, 0);
        } else {
          ctx.drawImage(img, 0, 0, sirka, vyska);
        }
        if (kovImg && !vykImg) ctx.drawImage(kovImg, 0, 0, sirka, vyska);
        if (stin) {
          ctx.shadowColor = "rgba(0,0,0,0)";
          ctx.shadowBlur = 0;
          ctx.shadowOffsetY = 0;
        }
      }
      ctx.restore();
      return vyrez;
    });
  }

  /* Plné rozlišení výřezu — zmenšuje se z něj na velikost okna */
  var plne = null;
  var PLNE = 2;

  /*
   * Zmenšení na velikost, ve které se model ukazuje.
   *
   * Plátno má rozměr obrázku postavy (přes tisíc bodů) a prohlížeč ho
   * zmenšoval na třetinu obrazovky sám — bez vyhlazení, takže hrany
   * kravaty a kšand byly zubaté. Teď se zmenší tady, po polovinách a
   * s vyhlazením, na přesný počet bodů displeje.
   */
  /*
   * Lupa. Patrik (23. 11.): „přidej možnost náhled modela přibližovat".
   * Přibližuje se z plného rozlišení výřezu, ne zvětšením obrázku na
   * displeji — vzor kravaty je pak ostrý i na čtyřnásobku. x, y je
   * střed pohledu v dílech výřezu.
   */
  var lupa = { k: 1, x: 0.5, y: 0.5 };
  var pohledTed = null;

  function zmensiNa(cil, zdroj, vyrez) {
    var dpr = Math.min(3, window.devicePixelRatio || 1);
    var k = Math.max(1, Math.min(4, lupa.k || 1));
    var misto = cil.parentNode;
    var scena = misto && misto.parentNode;
    /*
     * Přiblížený model vyplní celou scénu, i pod tlačítky. Patrik (25. 11.):
     * „okno s modelem jej při přiblížení ořezává, mělo by jít přiblížit
     * tak, že model bude pod tlačítky taky vidět". Výška scény se při
     * prvním přiblížení zapamatuje, ať okno neposkočí.
     */
    var vyplnit = k > 1.01 && scena && scena.classList && scena.classList.contains("qkb-scena");
    if (scena && scena.setAttribute) {
      if (vyplnit && scena.getAttribute("data-lupa") !== "1") {
        scena.style.height = scena.offsetHeight + "px";
        scena.setAttribute("data-lupa", "1");
      } else if (!vyplnit && scena.getAttribute("data-lupa") === "1") {
        scena.style.height = "";
        scena.setAttribute("data-lupa", "0");
      }
    }
    var w, h;
    if (vyplnit) {
      w = Math.max(50, Math.min(3200, Math.round((scena.clientWidth || 300) * dpr)));
      h = Math.max(50, Math.min(3200, Math.round((scena.clientHeight || 400) * dpr)));
    } else {
      var vyskaCss = cil.clientHeight || Math.round(window.innerHeight * 0.36);
      h = Math.max(50, Math.min(Math.round(zdroj.height * 0.75), Math.round(vyskaCss * dpr)));
      w = Math.max(20, Math.round((zdroj.width * h) / zdroj.height));
    }
    /* Pohled má poměr stran cílového plátna; když je širší než model, je kolem pozadí */
    var sh = zdroj.height / k;
    var sw = vyplnit ? sh * (w / h) : zdroj.width / k;
    var sx = sw <= zdroj.width ? Math.max(0, Math.min(zdroj.width - sw, lupa.x * zdroj.width - sw / 2)) : (zdroj.width - sw) / 2;
    var sy = Math.max(0, Math.min(zdroj.height - sh, lupa.y * zdroj.height - sh / 2));
    /* Střed se srovná s tím, kam se pohled opravdu vešel — jinak by tah u kraje „lepil" */
    lupa.x = (sx + sw / 2) / zdroj.width;
    lupa.y = (sy + sh / 2) / zdroj.height;
    /* Kus pohledu, který na modelu opravdu je, a kam na plátno patří */
    var ix0 = Math.max(0, sx), iy0 = Math.max(0, sy);
    var ix1 = Math.min(zdroj.width, sx + sw), iy1 = Math.min(zdroj.height, sy + sh);
    var dx = ((ix0 - sx) * w) / sw, dy = ((iy0 - sy) * h) / sh;
    var dw = ((ix1 - ix0) * w) / sw, dh = ((iy1 - iy0) * h) / sh;
    var mezi = zdroj;
    var mx = ix0, my = iy0, mw = ix1 - ix0, mh = iy1 - iy0;
    while (mw / 2 >= dw * 1.05) {
      var pul = document.createElement("canvas");
      pul.width = Math.max(1, Math.round(mw / 2));
      pul.height = Math.max(1, Math.round(mh / 2));
      var pc = pul.getContext("2d");
      pc.imageSmoothingEnabled = true;
      pc.imageSmoothingQuality = "high";
      pc.drawImage(mezi, mx, my, mw, mh, 0, 0, pul.width, pul.height);
      mezi = pul;
      mx = 0; my = 0; mw = pul.width; mh = pul.height;
    }
    cil.width = w;
    cil.height = h;
    var c = cil.getContext("2d");
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = "high";
    c.clearRect(0, 0, w, h);
    if (mw > 0 && mh > 0) c.drawImage(mezi, mx, my, mw, mh, dx, dy, dw, dh);
    /* Pohled v bodech postavy (plné plátno je PLNE× větší) */
    pohledTed = { x: sx / PLNE, y: sy / PLNE, w: sw / PLNE, h: sh / PLNE };
    /* Kde pohled leží na plátně postavy a v jakém měřítku — kvůli bodům a zkouškám */
    cil.setAttribute("data-x", String(vyrez.x + pohledTed.x));
    cil.setAttribute("data-y", String(vyrez.y + pohledTed.y));
    cil.setAttribute("data-m", String(w / pohledTed.w));
    cil.setAttribute("data-lupa", String(Math.round(k * 100) / 100));
    cil.style.touchAction = k > 1.01 ? "none" : "pan-y";
    if (misto && misto.setAttribute) misto.setAttribute("data-lupa", k > 1.01 ? "1" : "0");
  }

  /** Přiblížení na k; bod (fx, fy) v dílech plátna zůstane pod prstem. */
  function priblizNa(k, fx, fy) {
    if (!platno || !plne || !vyrezTed) return;
    k = Math.max(1, Math.min(4, k));
    var W = plne.width, H = plne.height;
    var p = pohledTed ? { x: pohledTed.x * PLNE, y: pohledTed.y * PLNE, w: pohledTed.w * PLNE, h: pohledTed.h * PLNE } : { x: 0, y: 0, w: W, h: H };
    if (fx == null) { fx = 0.5; fy = 0.5; }
    var bodX = p.x + fx * p.w;
    var bodY = p.y + fy * p.h;
    var sh = H / k;
    var sw = p.h > 0 ? sh * (p.w / p.h) : W / k;
    lupa.k = k;
    lupa.x = (bodX - fx * sw + sw / 2) / W;
    lupa.y = (bodY - fy * sh + sh / 2) / H;
    prekresliLupu();
  }

  var lupaCeka = false;
  function prekresliLupu() {
    if (lupaCeka) return;
    lupaCeka = true;
    var hned = function () {
      lupaCeka = false;
      if (platno && plne && vyrezTed) zmensiNa(platno, plne, vyrezTed);
      vykresliBody();
      vykresliLupu();
    };
    if (window.requestAnimationFrame) window.requestAnimationFrame(hned); else setTimeout(hned, 16);
  }

  /*
   * Přiblížení tlačítkem jde rovnou na detail u krku — tam je to, kvůli
   * čemu zákazník přibližuje (uzel kravaty, motýlek, vzor).
   */
  function priblizNaDetail(k) {
    var postava = postavaPro(vzhled());
    var kotva = postava && postava.kotvy ? postava.kotvy.kravata : null;
    if (lupa.k <= 1.01 && kotva && vyrezTed && pohledTed) {
      var fx = (kotva[0] - vyrezTed.x - pohledTed.x) / pohledTed.w;
      var fy = (kotva[1] + (postava.kotvy.pas - kotva[1]) * 0.25 - vyrezTed.y - pohledTed.y) / pohledTed.h;
      lupa.k = k;
      lupa.x = Math.max(0, Math.min(1, fx));
      lupa.y = Math.max(0, Math.min(1, fy));
      prekresliLupu();
      return;
    }
    priblizNa(k, 0.5, 0.5);
  }

  function vykresliLupu() {
    if (!okno) return;
    var lista = okno.querySelector(".qkb-lupa");
    if (!lista) return;
    var zpet = lista.querySelector(".qkb-lupa-zpet");
    if (zpet) zpet.style.display = lupa.k > 1.01 ? "" : "none";
    var minus = lista.querySelector(".qkb-lupa-minus");
    if (minus) minus.disabled = lupa.k <= 1.01;
    var plus = lista.querySelector(".qkb-lupa-plus");
    if (plus) plus.disabled = lupa.k >= 3.99;
  }

  /*
   * Ovládání lupy na plátně: kolečko s Ctrl (a sevření prstů na touchpadu,
   * které prohlížeč posílá jako Ctrl + kolečko), dva prsty na mobilu,
   * tažení přiblíženého obrázku a dvojklik / dvojí ťuknutí.
   * Obyčejné kolečko ani tah jedním prstem na nepřiblíženém modelu se
   * nechytají — zákazník jimi posouvá nabídku.
   */
  function napojLupu(misto) {
    var prsty = {};
    var zacatek = null;
    var posledniTuk = 0;
    var dil = function (e) {
      var r = platno.getBoundingClientRect();
      return { x: (e.clientX - r.left) / Math.max(1, r.width), y: (e.clientY - r.top) / Math.max(1, r.height) };
    };
    misto.addEventListener("wheel", function (e) {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      var d = dil(e);
      priblizNa(lupa.k * Math.exp(-e.deltaY * 0.01), d.x, d.y);
    }, { passive: false });
    misto.addEventListener("dblclick", function (e) {
      if (e.target && e.target.closest && e.target.closest("button")) return;
      var d = dil(e);
      priblizNa(lupa.k > 1.01 ? 1 : 2.4, d.x, d.y);
    });
    misto.addEventListener("pointerdown", function (e) {
      if (e.target && e.target.closest && e.target.closest("button")) return;
      prsty[e.pointerId] = { x: e.clientX, y: e.clientY };
      var klice = Object.keys(prsty);
      if (klice.length === 2) {
        var a = prsty[klice[0]], b = prsty[klice[1]];
        zacatek = { vzdalenost: Math.hypot(a.x - b.x, a.y - b.y) || 1, k: lupa.k };
      } else if (e.pointerType === "touch") {
        var ted = Date.now();
        if (ted - posledniTuk < 300) {
          var d = dil(e);
          priblizNa(lupa.k > 1.01 ? 1 : 2.4, d.x, d.y);
          posledniTuk = 0;
        } else {
          posledniTuk = ted;
        }
      }
      if (lupa.k > 1.01 || klice.length === 2) {
        try { misto.setPointerCapture(e.pointerId); } catch (chyba) { /* nic */ }
      }
    });
    misto.addEventListener("pointermove", function (e) {
      var predtim = prsty[e.pointerId];
      if (!predtim) return;
      prsty[e.pointerId] = { x: e.clientX, y: e.clientY };
      var klice = Object.keys(prsty);
      if (klice.length === 2 && zacatek) {
        var a = prsty[klice[0]], b = prsty[klice[1]];
        var r = platno.getBoundingClientRect();
        var stred = { x: ((a.x + b.x) / 2 - r.left) / Math.max(1, r.width), y: ((a.y + b.y) / 2 - r.top) / Math.max(1, r.height) };
        priblizNa(zacatek.k * (Math.hypot(a.x - b.x, a.y - b.y) / zacatek.vzdalenost), stred.x, stred.y);
        return;
      }
      if (lupa.k <= 1.01 || !pohledTed || !plne) return;
      var r2 = platno.getBoundingClientRect();
      lupa.x -= ((e.clientX - predtim.x) / Math.max(1, r2.width)) * pohledTed.w * PLNE / plne.width;
      lupa.y -= ((e.clientY - predtim.y) / Math.max(1, r2.height)) * pohledTed.h * PLNE / plne.height;
      prekresliLupu();
    });
    var pust = function (e) {
      delete prsty[e.pointerId];
      if (Object.keys(prsty).length < 2) zacatek = null;
    };
    misto.addEventListener("pointerup", pust);
    misto.addEventListener("pointercancel", pust);
  }

  /* ----------------------------------------------------- doporučení */

  /*
   * Rodina varianty: kravata 5–9 cm i pletená jsou kravata, motýlky
   * všech velikostí motýlek. Šířka je jen pro šablonu na modelu.
   */
  function rodina(typ, varianta) {
    if (typ !== "kravata") return typ;
    varianta = String(varianta || "");
    if (varianta.indexOf("motylek") === 0) return "motylek";
    if (varianta === "regata") return "regata";
    return "kravata";
  }

  function produktyKVrstve(typ, hex, varianta, vek) {
    var vse = vsechny();
    var out = [];
    for (var i = 0; i < vse.length; i++) {
      var p = vse[i];
      if (p.typ !== typ) continue;
      /* Rodina, ne přesná varianta: kdo má sedmičku, chce vidět i šestky */
      if (varianta && p.varianta && rodina(typ, p.varianta) !== rodina(typ, varianta)) continue;
      /* Dětský motýlek na dospělém modelu je nabídka, která nemá co udělat */
      if (vek && p.proVek && p.proVek.indexOf(vek) < 0) continue;
      out.push(p);
    }
    out.sort(function (a, b) {
      var da = hex ? rozdilBarev(a.hex, hex) : 0;
      var db = hex ? rozdilBarev(b.hex, hex) : 0;
      return da - db || b.cenaCislo - a.cenaCislo;
    });
    return out;
  }

  function nejblizsi(typ, hex, varianta, vek) {
    var n = produktyKVrstve(typ, hex, varianta, vek);
    return n[0] || null;
  }

  /**
   * Co doporučit k tomu, co už na modelu je.
   *
   * Každé doporučení musí mít **proč**. Náhodné „tohle se taky kupuje"
   * se v obleku pozná: k námořnickému saku to doporučí hnědý pásek a
   * zákazník přestane radám věřit.
   */
  function poradce(v) {
    var rady = [];
    var sako = v.kusy.sako;
    var kosile = v.kusy.kosile;
    var kravata = v.kusy.kravata;

    if (!kravata && (sako || v.kusy.vesta) && maProdukty("kravata")) {
      var podklad = sako ? sako.hex : v.kusy.vesta.hex;
      var kus = nejblizsi("kravata", ztmav(podklad, 0.18), "", v.vek);
      if (kus) rady.push({ typ: "kravata", produkt: kus.kod, druh: "chybi" });
    }
    if (!v.kusy.kapesnicek && sako && sakoVidi(v) && maProdukty("kapesnicek")) {
      var kap = kravata && kravata.produkt ? produkt(kravata.produkt) : null;
      var kapesnicek = nejblizsi("kapesnicek", kap ? kap.hex : (kosile ? kosile.hex : ""), "", v.vek);
      if (kapesnicek) rady.push({ typ: "kapesnicek", produkt: kapesnicek.kod, druh: "ladi" });
    }
    if (!v.kusy.pasek && !v.kusy.ksandy && maProdukty("pasek") && v.kusy.boty) {
      var pasek = nejblizsi("pasek", v.kusy.boty.hex, "", v.vek);
      if (pasek) rady.push({ typ: "pasek", produkt: pasek.kod, druh: "ladi" });
    }
    /* Doplněk, který na podkladu splyne, je vyhozená koupě */
    var poradi = katalog().poradi || [];
    for (var i = 0; i < poradi.length; i++) {
      var typ = poradi[i];
      var def = defVrstvy(typ);
      if (!def || !def.zbozi) continue;
      var naModelu = v.kusy[typ];
      if (!naModelu || !naModelu.produkt) continue;
      var pod = typ === "kapesnicek" ? (sako ? sako.hex : "") : (kosile ? kosile.hex : "");
      if (!pod) continue;
      if (rozdilBarev(naModelu.hex, pod) > 0.14) continue;
      var jiny = null;
      var nabidka = produktyKVrstve(typ, "", naModelu.varianta, v.vek);
      for (var j = 0; j < nabidka.length; j++) {
        if (rozdilBarev(nabidka[j].hex, pod) > 0.3) { jiny = nabidka[j]; break; }
      }
      if (jiny) rady.push({ typ: typ, produkt: jiny.kod, druh: "splyva" });
    }
    return rady;
  }

  /* ------------------------------------------------------- velikosti */

  function rozsahVelikosti(popis) {
    var text = String(popis || "").toLowerCase().replace(",", ".");
    var m = text.match(/(\d+)\s*(?:-|–|až)\s*(\d+)\s*(?:měs|mes|month)/);
    if (m) return { od: Number(m[1]) / 12, do: Number(m[2]) / 12, druh: "roky" };
    m = text.match(/(\d+)\s*(?:měs|mes|month)/);
    if (m) return { od: Number(m[1]) / 12, do: Number(m[1]) / 12, druh: "roky" };
    m = text.match(/(\d+(?:\.\d+)?)\s*(?:-|–|až|to)\s*(\d+(?:\.\d+)?)\s*(?:rok|roky|roků|let|year)/);
    if (m) return { od: Number(m[1]), do: Number(m[2]), druh: "roky" };
    m = text.match(/(\d+(?:\.\d+)?)\s*(?:rok|roky|roků|let|year)/);
    if (m) return { od: Number(m[1]), do: Number(m[1]), druh: "roky" };
    m = text.match(/(\d{2,3})\s*(?:-|–|\/|až)\s*(\d{2,3})/);
    if (m) return { od: Number(m[1]), do: Number(m[2]), druh: "cm" };
    m = text.match(/(\d{2,3})\s*cm/);
    if (m) return { od: Number(m[1]), do: Number(m[1]), druh: "cm" };
    return null;
  }

  function rokyPostavy(v) {
    var veky = katalog().veky || [];
    var def = null;
    for (var i = 0; i < veky.length; i++) if (veky[i].id === v.vek) def = veky[i];
    if (!def || !def.vyska) return 0;
    var roky = def.roky || [0, 0];
    var dil = (v.vyskaCm - def.vyska[0]) / Math.max(1, def.vyska[1] - def.vyska[0]);
    dil = Math.max(0, Math.min(1, dil));
    return Math.round((roky[0] + dil * (roky[1] - roky[0])) * 10) / 10;
  }

  /**
   * Která velikost zákazníkovi sedí.
   *
   * Dětské kšandy se v košíku zaseknou právě na tomhle: rodič netuší,
   * jestli „70 cm" je na čtyřleté dítě, a nákup odloží. Mlčet je tedy
   * nejhorší možnost — a druhá nejhorší je tvrdit to jistě. U odhadu je
   * proto vidět, že je to odhad, a nabídne se doptání.
   */
  function radaVelikosti(p, v) {
    var seznam = (p && p.velikostiSeznam) || [];
    if (seznam.length === 0) return null;
    if (seznam.length === 1) return { kod: seznam[0].kod, popis: seznam[0].popis, jiste: true, text: "" };
    var dil = nastaveni().ksandyDil || 0.62;
    var roky = rokyPostavy(v);
    var delka = Math.round(v.vyskaCm * dil);
    var kandidati = [];
    for (var i = 0; i < seznam.length; i++) {
      var r = rozsahVelikosti(seznam[i].popis);
      if (!r) continue;
      if (r.druh === "roky") {
        var od = roky < r.od ? r.od - roky : (roky > r.do ? roky - r.do : 0);
        kandidati.push({ v: seznam[i], podle: "roky", odchylka: od, jiste: od === 0 });
      } else if (r.do >= v.vyskaCm * 0.85) {
        var ov = v.vyskaCm < r.od ? r.od - v.vyskaCm : (v.vyskaCm > r.do ? v.vyskaCm - r.do : 0);
        kandidati.push({ v: seznam[i], podle: "vyska", odchylka: ov / 10, jiste: ov === 0 });
      } else {
        var stred = (r.od + r.do) / 2;
        kandidati.push({ v: seznam[i], podle: "delka", odchylka: Math.abs(stred - delka) / 10, jiste: false });
      }
    }
    if (kandidati.length === 0) return { kod: "", popis: "", jiste: false, text: t("radaNevim") };
    kandidati.sort(function (a, b) {
      return a.odchylka - b.odchylka || (b.v.skladem ? 1 : 0) - (a.v.skladem ? 1 : 0);
    });
    var vyhra = kandidati[0];
    var popis = "„" + vyhra.v.popis + "“";
    var text;
    if (vyhra.jiste && vyhra.podle === "roky") text = t("radaRoky", { v: roky, s: popis });
    else if (vyhra.jiste) text = t("radaVyska", { v: v.vyskaCm, s: popis });
    else text = t("radaOdhad", { v: v.vyskaCm, s: popis });
    return { kod: vyhra.v.kod, popis: vyhra.v.popis, jiste: vyhra.jiste, text: text };
  }

  /* ----------------------------------------------------------- košík */

  /*
   * Čísla produktů, která kabina potká.
   *
   * Vložení do košíku odesílá tentýž formulář, co má detail produktu, a
   * ten potřebuje číslo produktu (a u velikostí číslo varianty). Ve
   * feedu ani jedno není. Čte se tedy ze stránky — z té otevřené
   * zdarma, u ostatních se stránka stáhne na pozadí, a co se jednou
   * přečte, zůstane v prohlížeči.
   */
  function cislaZPameti() {
    try { return JSON.parse(localStorage.getItem(IDS_KLIC) || "{}") || {}; } catch (e) { return {}; }
  }
  var CISLA = cislaZPameti();

  function zapamatujCislo(url, cislo, moznosti) {
    var klic = cesta(url);
    if (!klic || !cislo) return;
    /* Z karty ve výpisu přijde číslo produktu bez variant. Kdyby se tím
       přepsaly varianty přečtené dřív ze stránky, muselo by se stahovat
       znovu — a u velikostí by do té doby vložení do košíku neprošlo. */
    var stare = CISLA[klic];
    CISLA[klic] = {
      id: String(cislo),
      moznosti: moznosti || (stare ? stare.moznosti : null) || null,
      kdy: Date.now()
    };
    try { localStorage.setItem(IDS_KLIC, JSON.stringify(CISLA)); } catch (e) { /* nic */ }
  }

  /** Čísla ze stránky produktu — z té otevřené, nebo stažené na pozadí. */
  function cisla(p) {
    var klic = cesta(p.url);
    var mam = CISLA[klic];
    var chybiVarianty = p.velikosti && (!mam || !mam.moznosti);
    if (mam && !chybiVarianty && Date.now() - (mam.kdy || 0) < TTL_MS * 8) return Promise.resolve(mam);
    return fetch(p.url, { credentials: "same-origin" })
      .then(function (r) { return r.ok ? r.text() : ""; })
      .then(function (html) {
        if (!html) return null;
        var doc = new DOMParser().parseFromString(html, "text/html");
        var id = doc.querySelector("input[name='product_id']");
        if (!id || !id.value) return null;
        var moznosti = [];
        var vybery = doc.querySelectorAll("select[name='option_set_id'] option[value], input[name='option_set_id'][value]");
        for (var i = 0; i < vybery.length; i++) {
          var o = vybery[i];
          var popis = o.textContent || o.getAttribute("data-label") || "";
          if (!popis && o.id) {
            var label = doc.querySelector("label[for='" + o.id + "']");
            popis = label ? label.textContent : "";
          }
          if (o.value) moznosti.push({ id: o.value, popis: String(popis || "").replace(/\s+/g, " ").trim() });
        }
        zapamatujCislo(p.url, id.value, moznosti);
        return CISLA[cesta(p.url)];
      })
      .catch(function () { return null; });
  }

  /** Která varianta na stránce odpovídá té naší. */
  function sedneVarianta(moznosti, popis) {
    if (!moznosti || moznosti.length === 0 || !popis) return "";
    var hledane = bezDiakritiky(popis).replace(/[^a-z0-9]/g, "");
    var i;
    for (i = 0; i < moznosti.length; i++) {
      var m = bezDiakritiky(moznosti[i].popis).replace(/[^a-z0-9]/g, "");
      if (m && (m === hledane || m.indexOf(hledane) >= 0 || hledane.indexOf(m) >= 0)) return moznosti[i].id;
    }
    /* Když se texty neshodnou, zkusí se čísla: „Délka: 120 cm" a „120cm" */
    var cislaNase = (popis.match(/\d+/g) || []).join("-");
    if (!cislaNase) return "";
    for (i = 0; i < moznosti.length; i++) {
      if ((moznosti[i].popis.match(/\d+/g) || []).join("-") === cislaNase) return moznosti[i].id;
    }
    return "";
  }

  /** Jeden kus do košíku. Vrací „povedlo se", ne „e-shop to potvrdil". */
  function vlozKus(p, pocet, velikostPopis) {
    return cisla(p).then(function (zname) {
      if (!zname || !zname.id) return false;
      var optionSet = "";
      if (p.velikosti) {
        optionSet = sedneVarianta(zname.moznosti, velikostPopis);
        /* Bez čísla velikosti by se do košíku dostal jiný kus, než si
           zákazník vybral — to je horší než nevložit nic */
        if (!optionSet && zname.moznosti && zname.moznosti.length > 1) return false;
      }
      var telo = new FormData();
      telo.append("product_id", zname.id);
      telo.append("option_set_id", optionSet);
      telo.append("quantity", String(Math.max(1, Math.round(pocet))));
      var spojka = p.url.indexOf("?") >= 0 ? "&" : "?";
      return fetch(p.url + spojka + "do=productForm-submit", {
        method: "POST",
        credentials: "same-origin",
        headers: { "X-Requested-With": "XMLHttpRequest" },
        body: telo
      }).then(function (r) { return r.ok; }).catch(function () { return false; });
    });
  }

  /** Odkaz do košíku — ze stránky, protože v každé jazykové verzi jiný. */
  function kosikOdkaz() {
    var a = document.querySelector("a[href*='/kosik'], a[href*='/cart'], a[href*='/kosik/']");
    return a ? a.getAttribute("href") : "";
  }

  /* ----------------------------------------------------------- styl */

  var STYL = ".qkb-pozadi{position:fixed;inset:0;z-index:99999;display:flex;align-items:flex-end;"
    + "justify-content:center;background:rgba(18,18,20,.55);-webkit-tap-highlight-color:transparent}"
    + ".qkb{position:relative;box-sizing:border-box;display:flex;flex-direction:column;width:100%;max-height:94vh;"
    + "background:#fff;color:#18181b;border-radius:16px 16px 0 0;overflow:hidden;"
    + "font:400 14px/1.45 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;"
    + "box-shadow:0 -8px 40px rgba(0,0,0,.3)}"
    + ".qkb *{box-sizing:border-box}"
    /* Jen písmo. Barvu tu mít nesmí: pravidlo „.qkb button" je
       přebíjivější než „.qkb-kosik", takže černé tlačítko do košíku mělo
       černý nápis a na snímku z mobilu vyšlo prázdné. */
    + ".qkb button{font:inherit}"
    + ".qkb-hlava{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:12px 14px;"
    + "border-bottom:1px solid #e8e8eb}"
    + ".qkb-hlava h2{margin:0;font-size:16px;font-weight:600}"
    + ".qkb-sub{color:#71717a;font-size:12px}"
    + ".qkb-hlava-text{flex:1 1 auto;min-width:0}"
    + ".qkb-ikona{flex:0 0 auto;width:36px;height:36px;border:0;border-radius:10px;background:#f4f4f5;"
    + "cursor:pointer;font-size:17px;line-height:1;display:inline-flex;align-items:center;justify-content:center}"
    + ".qkb-ikona:hover{background:#e8e8eb}"
    + ".qkb-telo{flex:1 1 auto;overflow:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch}"
    + ".qkb-scena{position:sticky;top:0;z-index:3;display:flex;justify-content:center;padding:8px 0 4px;"
    + "background:linear-gradient(#fafafa,#f1f1f3)}"
    + ".qkb-platno{position:relative;display:inline-block;line-height:0}"
    + ".qkb-platno canvas{display:block;height:36vh;width:auto;max-width:100%;touch-action:pan-y;user-select:none;-webkit-user-select:none}"
    /* Bod je malý a průsvitný: má upozornit, ne zakrýt model. Cíl pro prst je větší, než co je vidět */
    + ".qkb-bod{position:absolute;transform:translate(-50%,-50%);width:22px;height:22px;padding:0;"
    + "border:1.5px solid rgba(255,255,255,.92);border-radius:999px;background:rgba(24,24,27,.6);color:#fff;cursor:pointer;"
    + "font-size:13px;font-weight:600;line-height:1;display:inline-flex;align-items:center;justify-content:center;"
    + "box-shadow:0 1px 4px rgba(0,0,0,.18)}"
    + ".qkb-bod::after{content:'';position:absolute;inset:-8px;border-radius:999px}"
    + ".qkb-bod:focus-visible{outline:2px solid #2563eb;outline-offset:2px}"
    + "@media (prefers-reduced-motion:no-preference){.qkb-bod{animation:qkbTik 2.6s ease-in-out infinite}}"
    + "@keyframes qkbTik{0%,72%,100%{box-shadow:0 1px 4px rgba(0,0,0,.18)}"
    + "84%{box-shadow:0 1px 6px rgba(0,0,0,.25),0 0 0 7px rgba(24,24,27,.14)}}"
    /* align-items je tu kvůli počítači: scéna je vodorovný flex a bez
       něj se tlačítka roztáhla přes celou výšku modelu do obřích oválů */
    + ".qkb-scena-lista{position:absolute;left:0;right:0;bottom:4px;display:flex;gap:6px;"
    + "align-items:center;justify-content:center;flex-wrap:wrap;padding:0 8px}"
    + ".qkb-chip{display:inline-flex;align-items:center;gap:6px;padding:7px 12px;border:1px solid #d4d4d8;"
    + "border-radius:999px;background:#fff;cursor:pointer;font-size:12.5px;line-height:1;white-space:nowrap}"
    + ".qkb-chip[aria-pressed='true']{background:#18181b;border-color:#18181b;color:#fff}"
    + ".qkb-chip-hlavni{border-color:#18181b;font-weight:600}"
    + ".qkb-blok{padding:12px 14px;border-top:1px solid #f0f0f2}"
    + ".qkb-blok h3{margin:0 0 8px;font-size:13px;font-weight:600;text-transform:uppercase;"
    + "letter-spacing:.04em;color:#52525b}"
    + ".qkb-pas{display:flex;gap:8px;overflow-x:auto;padding-bottom:4px;scrollbar-width:thin}"
    + ".qkb-pas::-webkit-scrollbar{height:4px}"
    + ".qkb-pas::-webkit-scrollbar-thumb{background:#d4d4d8;border-radius:4px}"
    + ".qkb-karta{flex:0 0 auto;width:112px;border:1px solid #e8e8eb;border-radius:12px;background:#fff;"
    + "padding:8px;cursor:pointer;text-align:left}"
    + ".qkb-karta img{width:100%;height:84px;object-fit:contain;border-radius:8px;background:#f7f7f8}"
    + ".qkb-karta b{display:block;margin-top:6px;font-size:12px;font-weight:600;line-height:1.25;"
    + "max-height:2.5em;overflow:hidden}"
    + ".qkb-karta i{display:block;margin-top:3px;font-size:12px;font-style:normal;color:#52525b}"
    + ".qkb-kus{display:flex;gap:10px;padding:10px 0;border-bottom:1px solid #f4f4f5}"
    + ".qkb-kus:last-child{border-bottom:0}"
    + ".qkb-kus[data-nic='1']{opacity:.55}"
    + ".qkb-kus img{flex:0 0 auto;width:56px;height:56px;object-fit:contain;border-radius:8px;background:#f7f7f8}"
    + ".qkb-bezobrazku{flex:0 0 auto;width:56px;height:56px;border-radius:8px;background:#f0f0f2}"
    + ".qkb-karta .qkb-bezobrazku{width:100%;height:84px}"
    + ".qkb-kus-telo{flex:1 1 auto;min-width:0}"
    + ".qkb-kus-nazev{font-weight:600;font-size:13.5px;line-height:1.3}"
    + ".qkb-kus-radek{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:6px}"
    + ".qkb-pocet{display:inline-flex;align-items:center;border:1px solid #d4d4d8;border-radius:999px;"
    + "overflow:hidden}"
    + ".qkb-pocet button{width:36px;height:36px;border:0;background:#fff;cursor:pointer;font-size:17px}"
    + ".qkb-pocet button:hover{background:#f4f4f5}"
    + ".qkb-pocet span{min-width:30px;text-align:center;font-size:14px;font-weight:600}"
    + ".qkb select{height:36px;max-width:100%;padding:0 8px;border:1px solid #d4d4d8;border-radius:9px;"
    + "background:#fff;font:inherit}"
    + ".qkb-rada{margin-top:5px;font-size:12px;color:#52525b}"
    + ".qkb-rada b{font-weight:600;color:#18181b}"
    /*
     * Vedlejší tlačítka jako tiché oválky v barvách kabiny. Modrý
     * podtržený text vypadal jako odkaz z roku 2005 a na mobilu se do
     * něj špatně trefovalo (Patrik, 23. 11.).
     */
    + ".qkb-odkaz{display:inline-flex;align-items:center;min-height:32px;padding:0 12px;border:1px solid #e4e4e7;"
    + "border-radius:999px;background:#fff;color:#27272a;cursor:pointer;font:inherit;font-size:12.5px;font-weight:500;"
    + "text-decoration:none;line-height:1}"
    + ".qkb-odkaz:hover{background:#f4f4f5;border-color:#d4d4d8}"
    + ".qkb-odkaz:focus-visible{outline:2px solid #18181b;outline-offset:2px}"
    + ".qkb-upozorneni{position:relative;margin:12px 14px 0;padding:12px 40px 12px 12px;border-radius:12px;"
    + "background:#fef9ec;border:1px solid #f3e3b5;color:#3f3a2b;font-size:13px;line-height:1.4}"
    + ".qkb-upozorneni b{display:block;margin-bottom:2px;font-weight:600}"
    + ".qkb-upozorneni-x{position:absolute;right:6px;top:6px;width:28px;height:28px;background:transparent}"
    + ".qkb-hledani{display:flex;gap:8px;align-items:center}"
    + ".qkb-hledani input{flex:1 1 auto;height:40px;padding:0 12px;border:1px solid #d4d4d8;"
    + "border-radius:10px;font:inherit;min-width:0}"
    + ".qkb-mrizka{display:grid;grid-template-columns:repeat(auto-fill,minmax(104px,1fr));gap:8px;margin-top:10px}"
    + ".qkb-mrizka .qkb-karta{width:auto}"
    + ".qkb-kontakt{padding:12px 14px;border-top:1px solid #f0f0f2;color:#52525b;font-size:12.5px}"
    + ".qkb-kontakt a{color:#18181b}"
    + ".qkb-pata{flex:0 0 auto;display:flex;align-items:center;gap:10px;padding:10px 14px;"
    + "border-top:1px solid #e8e8eb;background:#fff;"
    + "padding-bottom:calc(10px + env(safe-area-inset-bottom))}"
    + ".qkb-suma{flex:1 1 auto;min-width:0;line-height:1.2}"
    + ".qkb-suma b{display:block;font-size:17px;font-weight:700}"
    + ".qkb-kosik{flex:0 0 auto;padding:13px 18px;border:0;border-radius:11px;background:#18181b;"
    + "color:#fff;cursor:pointer;font-size:15px;font-weight:600}"
    + ".qkb-kosik[disabled]{opacity:.45;cursor:default}"
    + ".qkb-hlaska{position:absolute;left:14px;right:14px;bottom:72px;z-index:6;padding:10px 12px;"
    + "border-radius:10px;background:#18181b;color:#fff;font-size:13px;text-align:center}"
    + ".qkb-barvy{display:flex;gap:7px;flex-wrap:wrap}"
    + ".qkb-barva{width:32px;height:32px;padding:0;border:2px solid #fff;border-radius:999px;cursor:pointer;"
    + "box-shadow:0 0 0 1px #d4d4d8}"
    + ".qkb-barva[aria-pressed='true']{box-shadow:0 0 0 2px #18181b}"
    + ".qkb-rada-radek{display:flex;gap:8px;align-items:center;margin-top:8px}"
    + ".qkb input[type='range']{width:100%}"
    + ".qkb-blok:empty{display:none}"
    + ".qkb-prepinac{display:inline-flex;border:1px solid #d4d4d8;border-radius:999px;background:#fff;padding:2px;gap:2px}"
    + ".qkb-vypinace{display:inline-flex;gap:6px}"
    + ".qkb-vypinac[aria-pressed='true']{background:#fff;color:#18181b;border-color:#18181b}"
    + ".qkb-vypinac[disabled]{opacity:.5;cursor:not-allowed}"
    + ".qkb-vypinac-ikona{width:26px;height:15px;border-radius:999px;background:#d4d4d8;position:relative;flex:0 0 auto;"
    + "transition:background .15s}"
    + ".qkb-vypinac-ikona::after{content:'';position:absolute;left:2px;top:2px;width:11px;height:11px;border-radius:999px;"
    + "background:#fff;transition:transform .15s;box-shadow:0 1px 2px rgba(0,0,0,.2)}"
    + ".qkb-vypinac[aria-pressed='true'] .qkb-vypinac-ikona{background:#18181b}"
    + ".qkb-vypinac[aria-pressed='true'] .qkb-vypinac-ikona::after{transform:translateX(11px)}"
    /* Lupa vedle modelu, ne přes něj — přes rameno by zakrývala to, co se přibližuje */
    + ".qkb-lupa{position:absolute;left:calc(100% + 8px);top:4px;z-index:2;display:flex;flex-direction:column;gap:4px;line-height:1}"
    + ".qkb-lupa button{width:32px;height:32px;padding:0;border:1px solid rgba(24,24,27,.12);border-radius:9px;"
    + "background:rgba(255,255,255,.92);color:#18181b;font-size:17px;cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,.1)}"
    + ".qkb-lupa button[disabled]{opacity:.4;cursor:default}"
    + ".qkb-platno[data-lupa='1'] canvas{cursor:grab}"
    /* Přiblížený model vyplní celou scénu a tlačítka leží na něm */
    + ".qkb-scena[data-lupa='1']{padding:0;box-sizing:border-box}"
    /* Velký obrázek celého modelu přes celou obrazovku */
    + ".qkb-velky{position:fixed;inset:0;z-index:20;background:#f4f4f5;display:flex}"
    + ".qkb-velky-obal{flex:1 1 auto;overflow:auto;display:flex;align-items:center;justify-content:center;cursor:zoom-in;"
    + "-webkit-overflow-scrolling:touch;overscroll-behavior:contain}"
    + ".qkb-velky canvas{display:block;max-width:100vw;max-height:100vh;max-height:100dvh;width:auto;height:auto}"
    + ".qkb-velky.plna .qkb-velky-obal{display:block;cursor:zoom-out}"
    + ".qkb-velky.plna canvas{max-width:none;max-height:none;margin:0 auto}"
    + ".qkb-velky-zavrit{position:absolute;top:12px;right:12px;width:42px;height:42px;padding:0;border:0;border-radius:999px;"
    + "background:#18181b;color:#fff;font-size:22px;line-height:1;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.25)}"
    + ".qkb-velky-rada{position:absolute;left:50%;bottom:14px;transform:translateX(-50%);padding:6px 12px;border-radius:999px;"
    + "background:rgba(24,24,27,.72);color:#fff;font-size:12px;line-height:1.3;pointer-events:none;white-space:nowrap}"
    + ".qkb-lupa-velky{display:inline-flex;align-items:center;justify-content:center}"
    + ".qkb-scena[data-lupa='1'] .qkb-platno{position:absolute;inset:0;display:block}"
    + ".qkb-scena[data-lupa='1'] .qkb-platno canvas{width:100%;height:100%;max-width:none}"
    + ".qkb-scena[data-lupa='1'] .qkb-scena-lista{position:absolute;left:0;right:0;bottom:10px;margin:0;z-index:2}"
    + ".qkb-scena[data-lupa='1'] .qkb-lupa{left:auto;right:10px;top:10px}"
    + ".qkb-platno[data-lupa='1']:active canvas{cursor:grabbing}"
    + ".qkb-prepinac .qkb-chip{border:0;padding:6px 11px}"
    + ".qkb-upravuji .qkb-pravy>:not(.qkb-zavoj),.qkb-upravuji .qkb-varianty,.qkb-upravuji .qkb-pata,"
    + ".qkb-upravuji .qkb-chip-hlavni,.qkb-upravuji .qkb-bod{display:none}"
    + ".qkb-zavoj{display:flex;flex-direction:column;min-height:100%;background:#fff}"
    + ".qkb-panel-hlava{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid #f0f0f2}"
    + ".qkb-panel-hlava h2{margin:0;font-size:15px;font-weight:600}"
    + ".qkb-zpet{flex:0 0 auto;padding:8px 12px;border:1px solid #d4d4d8;border-radius:999px;background:#fff;"
    + "cursor:pointer;font-size:13px;font-weight:600;color:#18181b}"
    + ".qkb-panel-pata{position:sticky;bottom:0;margin-top:auto;padding:10px 14px;"
    + "padding-bottom:calc(10px + env(safe-area-inset-bottom));background:#fff;border-top:1px solid #e8e8eb}"
    + ".qkb-panel-pata .qkb-kosik{width:100%}"
    + ".qkb-pas-zalom{flex-wrap:wrap;overflow:visible}"
    + ".qkb-filtry{margin-bottom:10px}"
    + ".qkb-barva-bez{background:#fff linear-gradient(135deg,transparent 46%,#a1a1aa 46%,#a1a1aa 54%,transparent 54%)}"
    + ".qkb-karta{position:relative}"
    + ".qkb-karta-na{border-color:#18181b;box-shadow:0 0 0 1px #18181b}"
    + ".qkb-stitek{position:absolute;left:12px;top:12px;padding:3px 7px;border-radius:999px;background:#18181b;"
    + "color:#fff;font-size:10.5px;font-weight:600;line-height:1.2}"
    + ".qkb-rada-radek{flex-wrap:wrap}"
    /*
     * Na mobilu je model nalepený nahoře, zatímco se pod ním listuje
     * nabídkou. Lepí se ale jen v rámci svého rodiče — a tím byl levý
     * sloupec, takže po prvním posunu model zmizel nahoru. Levý sloupec
     * se proto na mobilu „rozpustí" a model se lepí k celému oknu.
     */
    + "@media (max-width:719px){.qkb-levy{display:contents}"
    + ".qkb-hlava .qkb-sub{display:none}.qkb-hlava{padding:10px 12px}}"
    + "@media (min-width:720px){"
    + ".qkb-pozadi{align-items:center;padding:20px}"
    + ".qkb{max-width:1060px;max-height:88vh;border-radius:16px}"
    + ".qkb-telo{display:grid;grid-template-columns:minmax(280px,40%) 1fr;overflow:hidden}"
    + ".qkb-levy{overflow:auto;border-right:1px solid #f0f0f2}"
    + ".qkb-pravy{overflow:auto}"
    + ".qkb-scena{position:static;flex-direction:column;align-items:center;padding:14px 0 10px}"
    + ".qkb-scena[data-lupa='1']{position:relative;padding:0}"
    + ".qkb-platno canvas{height:46vh}"
    + ".qkb-scena-lista{position:static;margin-top:10px}"
    + ".qkb-hlava h2{font-size:18px}"
    + "}";

  /* ----------------------------------------------------------- okno */

  var pozadi = null;
  var okno = null;
  var platno = null;
  var hlaskaCas = null;

  /*
   * Vzhledy k porovnání. Aktivní je ten na indexu „kde".
   *
   * Zakládá se **až s načtenými daty**, ne při spuštění skriptu: výchozí
   * oblek (kalhoty, košile, sako, boty) je v těch datech, aby se dal
   * změnit bez zasahování do šablony e-shopu. Dokud tam nebyl, otevřela
   * se kabina s modelem ve spodním prádle a kravatou — a s ní zmizel i
   * bod na kapesníček, protože ten je v klopě saka.
   */
  var varianty = [];
  var kde = 0;
  function vzhled() {
    if (!varianty.length) varianty = [vychozi()];
    return varianty[kde];
  }

  function hlaska(text) {
    if (!okno) return;
    var stara = okno.querySelector(".qkb-hlaska");
    if (stara && stara.parentNode) stara.parentNode.removeChild(stara);
    if (!text) return;
    var h = el("div", "qkb-hlaska", text);
    okno.appendChild(h);
    if (hlaskaCas) clearTimeout(hlaskaCas);
    hlaskaCas = setTimeout(function () {
      if (h.parentNode) h.parentNode.removeChild(h);
    }, 4200);
  }

  function ulozStav() {
    var kusu = 0;
    var kusy = vzhled().kusy;
    for (var typ in kusy) {
      if (!Object.prototype.hasOwnProperty.call(kusy, typ)) continue;
      var d = defVrstvy(typ);
      if (d && d.zbozi && kusy[typ] && kusy[typ].produkt && !jeDilSady(kusy[typ])) kusu += 1;
    }
    try {
      if (kusu > 0) {
        localStorage.setItem(STAV_KLIC, JSON.stringify({
          kusu: kusu, kdy: Date.now(),
          varianty: varianty.map(doTextu), kde: kde
        }));
      } else {
        localStorage.removeItem(STAV_KLIC);
      }
    } catch (e) { /* plná schránka kabinu nezastaví */ }
    if (window.__quentinoKabinaStav) {
      try { window.__quentinoKabinaStav(); } catch (e) { /* nic */ }
    }
  }

  function zeStavu() {
    try {
      var s = JSON.parse(localStorage.getItem(STAV_KLIC) || "null");
      if (!s || !s.varianty || !s.varianty.length) return false;
      var nove = [];
      for (var i = 0; i < s.varianty.length; i++) {
        var v = zTextu(s.varianty[i]);
        if (v) nove.push(v);
      }
      if (!nove.length) return false;
      varianty = nove;
      kde = Math.min(Math.max(0, s.kde || 0), varianty.length - 1);
      return true;
    } catch (e) { return false; }
  }

  /* ---------------------------------------------------------- scéna */

  function prekresli() {
    if (!platno) return;
    nakresli(platno, vzhled()).then(vykresliBody);
    vykresliVse();
    ulozStav();
  }

  function vykresliBody() {
    if (!okno) return;
    var misto = okno.querySelector(".qkb-platno");
    if (!misto) return;
    var stare = misto.querySelectorAll(".qkb-bod");
    for (var s = 0; s < stare.length; s++) stare[s].parentNode.removeChild(stare[s]);
    var v = vzhled();
    var vrstvy = katalog().vrstvy || [];
    var sako = sakoNaModelu(v);
    for (var i = 0; i < vrstvy.length; i++) {
      var def = vrstvy[i];
      if (!def.bod || !def.zbozi) continue;
      if (!maProdukty(def.typ)) continue;
      if (def.typ === "kapesnicek" && !sako) continue;
      var obsazeno = !!v.kusy[def.typ];
      /*
       * Bod je jen tam, kde doplněk **chybí**. Fajfka na obsazeném místě
       * ležela přímo na uzlu kravaty a zakrývala to, kvůli čemu tu
       * zákazník je; vyměnit se dá v seznamu „Na modelu".
       */
      if (obsazeno) continue;
      var b = tlac("qkb-bod", "+", (function (typ) {
        return function (e) { e.stopPropagation(); otevriVyber(typ); };
      })(def.typ));
      /*
       * Místo bodu: ze změřených bodů postavy (límec, rameno, kapsa), a
       * když nejsou, z odhadu v katalogu. Přepočítá se do výřezu, který
       * se ukazuje.
       */
      var postavaB = postavaPro(v);
      var vyrez = vyrezTed || (postavaB ? vyrezPostavy(postavaB) : null);
      var zmereno = postavaB && postavaB.kotvy ? postavaB.kotvy[def.typ] : null;
      var bx = zmereno ? zmereno[0] : def.bod.x * (vyrez ? vyrez.sirka : 1);
      var by = zmereno ? zmereno[1] : def.bod.y * (vyrez ? vyrez.vyska : 1);
      if (vyrez) {
        var p = pohledTed || { x: 0, y: 0, w: vyrez.w, h: vyrez.h };
        bx = (bx - vyrez.x - p.x) / p.w;
        by = (by - vyrez.y - p.y) / p.h;
      }
      /* Při přiblížení je bod mimo pohled — schová se, ať neleží na kraji jinde */
      if (bx < 0.03 || bx > 0.97 || by < 0.03 || by > 0.97) {
        if (lupa.k > 1.01) continue;
      }
      b.style.left = (Math.max(0.05, Math.min(0.95, bx)) * 100) + "%";
      b.style.top = (Math.max(0.05, Math.min(0.95, by)) * 100) + "%";
      b.setAttribute("data-obsazeno", obsazeno ? "1" : "0");
      b.setAttribute("data-typ", def.typ);
      var popis = obsazeno ? nazevVrstvy(def.typ) : (def.pobidka || nazevVrstvy(def.typ));
      b.setAttribute("title", popis);
      b.setAttribute("aria-label", popis);
      misto.appendChild(b);
    }
  }

  function vykresliScenu() {
    var scena = okno.querySelector(".qkb-scena");
    scena.innerHTML = "";
    var misto = el("div", "qkb-platno");
    platno = document.createElement("canvas");
    platno.setAttribute("role", "img");
    platno.setAttribute("aria-label", t("kabina"));
    misto.appendChild(platno);
    scena.appendChild(misto);

    var lista = el("div", "qkb-scena-lista");
    /*
     * Jedno tlačítko na celou postavu, ne nastavení každé drobnosti.
     * Priorita jsou produkty: kdo si chce model upravit, najde to na
     * první pohled, a kdo ne, nemá se o co zakopnout.
     */
    var upravit = tlac("qkb-chip qkb-chip-hlavni", t("upravit"), otevriPanel);
    upravit.setAttribute("title", t("upravitDelsi"));
    lista.appendChild(upravit);
    /*
     * Sako jako přepínač o dvou polohách, ne jedno tlačítko. Jedno
     * tlačítko s nápisem „Bez saka" nebylo poznat, jestli říká, jak to
     * je, nebo co se stane po kliknutí.
     */
    /*
     * Sako a vesta jako dva vypínače přímo pod modelem. Patrik (23. 11.):
     * „nevidím nikde tlačítko na zobrazení/skrytí saka, vesty". Dřív byl
     * přepínač jen u saka, a jen když pro postavu existovala vrstva —
     * jinak nebylo nic. Na e-shopu se nehotová vrstva pořád neukazuje
     * (zákazník by klikal do prázdna), v náhledu v aplikaci ale zůstane
     * vypínač vidět, zašedlý a s vysvětlením, co chybí.
     */
    var postavaS = postavaPro(vzhled());
    var vNahledu = location.protocol === "qkbnahled:";
    var vypinace = el("div", "qkb-vypinace");
    vypinace.setAttribute("role", "group");
    var pridejVypinac = function (typ, zapnuto, prepni) {
      var def = defVrstvy(typ);
      var varianta = (vzhled().kusy[typ] && vzhled().kusy[typ].varianta)
        || (def && def.varianty && def.varianty[0] ? def.varianty[0].id : "");
      var ma = postavaS && vrstvaPro(postavaS.id, typ, varianta);
      if (!ma && !vNahledu) return;
      var b = tlac("qkb-chip qkb-vypinac", null, function () { if (ma) prepni(!zapnuto); });
      b.appendChild(el("span", "qkb-vypinac-ikona"));
      b.appendChild(document.createTextNode(t(typ)));
      b.setAttribute("aria-pressed", ma && zapnuto ? "true" : "false");
      b.setAttribute("data-typ", typ);
      if (!ma) {
        b.disabled = true;
        b.setAttribute("title", t("chybiVrstva"));
      }
      vypinace.appendChild(b);
    };
    pridejVypinac("sako", sakoVidi(vzhled()), nastavSako);
    pridejVypinac("vesta", !!vzhled().kusy.vesta, nastavVestu);
    if (vypinace.firstChild) lista.appendChild(vypinace);
    scena.appendChild(lista);

    /* Lupa: plus, minus a návrat na celý model */
    var lupaLista = el("div", "qkb-lupa");
    var plus = tlac("qkb-lupa-plus", "+", function (e) { e.stopPropagation(); priblizNaDetail(Math.min(4, lupa.k <= 1.01 ? 2.2 : lupa.k * 1.5)); });
    plus.setAttribute("aria-label", t("priblizit"));
    plus.setAttribute("title", t("priblizit"));
    var minus = tlac("qkb-lupa-minus", "−", function (e) { e.stopPropagation(); priblizNa(lupa.k / 1.5 < 1.1 ? 1 : lupa.k / 1.5); });
    minus.setAttribute("aria-label", t("oddalit"));
    minus.setAttribute("title", t("oddalit"));
    var zpet = tlac("qkb-lupa-zpet", "⤢", function (e) { e.stopPropagation(); lupa = { k: 1, x: 0.5, y: 0.5 }; prekresliLupu(); });
    zpet.setAttribute("aria-label", t("celyModel"));
    zpet.setAttribute("title", t("celyModel"));
    var velkyBtn = tlac("qkb-lupa-velky", null, function (e) { e.stopPropagation(); ukazVelky(); });
    /* Ikona jako SVG — znak „čtyř rohů" některé telefony nemají v písmu */
    velkyBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" '
      + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>';
    velkyBtn.setAttribute("aria-label", t("velkyObrazek"));
    velkyBtn.setAttribute("title", t("velkyObrazek"));
    lupaLista.appendChild(plus);
    lupaLista.appendChild(minus);
    lupaLista.appendChild(zpet);
    lupaLista.appendChild(velkyBtn);
    misto.appendChild(lupaLista);
    napojLupu(misto);
    vykresliLupu();
  }

  var posledniVesta = "";
  function nastavVestu(ano) {
    var v = vzhled();
    if (ano) {
      var def = defVrstvy("vesta");
      v.kusy.vesta = {
        varianta: (def && def.varianty && def.varianty[0] ? def.varianty[0].id : "klasicka"),
        hex: posledniVesta || (v.kusy.sako && v.kusy.sako.hex) || "#2a3142"
      };
    } else if (v.kusy.vesta) {
      posledniVesta = v.kusy.vesta.hex;
      delete v.kusy.vesta;
    }
    vykresliScenu();
    prekresli();
  }

  function nastavSako(ano) {
    var v = vzhled();
    if (ano && !v.kusy.sako) {
      var vychoziSako = (vychozi().kusy || {}).sako || { varianta: "jednoradove", hex: "#1f2d4d" };
      v.kusy.sako = { varianta: vychoziSako.varianta, hex: vychoziSako.hex };
    }
    v.sako = ano ? "vidi" : "skryto";
    vykresliScenu();
    prekresli();
  }

  /* -------------------------------------------------------- varianty */

  function vykresliVarianty() {
    var blok = okno.querySelector(".qkb-varianty");
    blok.innerHTML = "";
    /* Dokud na modelu žádný doplněk není, je nabídka dalšího vzhledu k ničemu */
    if (varianty.length < 2 && kNakupu().length === 0) return;
    blok.appendChild(el("h3", null, t("vzhledy")));
    /* Zalamují se: na počítači byly ve vodorovném posuvníku a „Další vzhled" utíkal z okna */
    var pas = el("div", "qkb-pas qkb-pas-zalom");
    for (var i = 0; i < varianty.length; i++) {
      var chip = tlac("qkb-chip", varianty[i].nazev || (t("vzhled") + " " + (i + 1)), (function (index) {
        return function () { kde = index; vykresliScenu(); prekresli(); };
      })(i));
      chip.setAttribute("aria-pressed", i === kde ? "true" : "false");
      pas.appendChild(chip);
    }
    pas.appendChild(tlac("qkb-chip", "+ " + t("novy"), function () {
      var kopie = JSON.parse(JSON.stringify(vzhled()));
      kopie.nazev = t("vzhled") + " " + (varianty.length + 1);
      varianty.push(kopie);
      kde = varianty.length - 1;
      vykresliScenu();
      prekresli();
    }));
    if (varianty.length > 1) {
      pas.appendChild(tlac("qkb-chip", t("smazatVzhled"), function () {
        varianty.splice(kde, 1);
        kde = Math.max(0, kde - 1);
        vykresliScenu();
        prekresli();
      }));
    }
    blok.appendChild(pas);
  }

  /* ------------------------------------------------------- kusy */

  function pocetKusu(kus) {
    return kus.pocet == null ? 1 : Math.max(0, Math.round(kus.pocet));
  }

  function radekKusu(typ, kus) {
    var p = produkt(kus.produkt);
    var radek = el("div", "qkb-kus");
    var pocet = pocetKusu(kus);
    if (pocet === 0) radek.setAttribute("data-nic", "1");
    radek.setAttribute("data-typ", typ);

    if (p && p.obrazek) {
      var img = document.createElement("img");
      img.src = p.obrazek;
      img.alt = "";
      img.loading = "lazy";
      radek.appendChild(img);
    } else {
      radek.appendChild(el("div", "qkb-bezobrazku"));
    }

    var telo = el("div", "qkb-kus-telo");
    telo.appendChild(el("div", "qkb-kus-nazev", (p && p.nazev) || nazevVrstvy(typ)));
    var druh = nazevVrstvy(typ);
    if (p && p.casti && p.casti.length) {
      for (var ic = 0; ic < p.casti.length; ic++) druh += " + " + nazevVrstvy(p.casti[ic].typ);
      druh += " (" + t("sada") + ")";
    }
    telo.appendChild(el("div", "qkb-sub", druh + (p ? " · " + p.cena : "")));

    var ovladani = el("div", "qkb-kus-radek");
    var krok = el("div", "qkb-pocet");
    krok.appendChild(tlac("", "−", function () {
      kus.pocet = Math.max(0, pocetKusu(kus) - 1);
      prekresli();
    }));
    krok.appendChild(el("span", null, String(pocet)));
    krok.appendChild(tlac("", "+", function () {
      kus.pocet = Math.min(99, pocetKusu(kus) + 1);
      prekresli();
    }));
    krok.setAttribute("aria-label", t("pocet"));
    ovladani.appendChild(krok);

    if (p && p.velikostiSeznam && p.velikostiSeznam.length > 1) {
      var vyber = document.createElement("select");
      vyber.setAttribute("aria-label", t("velikost"));
      var rada = radaVelikosti(p, vzhled());
      if (!kus.velikost && rada && rada.kod) kus.velikost = rada.kod;
      for (var i = 0; i < p.velikostiSeznam.length; i++) {
        var vel = p.velikostiSeznam[i];
        var o = document.createElement("option");
        o.value = vel.kod;
        o.textContent = vel.popis + (vel.skladem ? "" : " (" + t("neniSkladem") + ")");
        if (vel.kod === kus.velikost) o.selected = true;
        vyber.appendChild(o);
      }
      vyber.addEventListener("change", function () {
        kus.velikost = this.value;
        ulozStav();
      });
      ovladani.appendChild(vyber);
    }

    ovladani.appendChild(tlac("qkb-odkaz", t("vymenit"), function () {
      otevriVyber(typ, rodina(typ, kus.varianta));
    }));
    ovladani.appendChild(tlac("qkb-odkaz", t("odebrat"), function () {
      delete vzhled().kusy[typ];
      odeberSadu(vzhled(), kus.produkt);
      vykresliScenu();
      prekresli();
    }));
    telo.appendChild(ovladani);

    /* Rada s velikostí — hlavně u dětských kšand, kde na ní stojí nákup */
    if (p && p.velikostiSeznam && p.velikostiSeznam.length > 1) {
      var r = radaVelikosti(p, vzhled());
      if (r && r.text) {
        var radaEl = el("div", "qkb-rada");
        radaEl.appendChild(el("b", null, r.jiste ? "✓ " : "≈ "));
        radaEl.appendChild(document.createTextNode(r.text + " "));
        if (!r.jiste) {
          var kontakt = nastaveni().kontakt || {};
          if (kontakt.mail) {
            var a = document.createElement("a");
            a.href = "mailto:" + kontakt.mail + "?subject=" + encodeURIComponent(t("velikost") + " — " + p.nazev);
            a.textContent = t("napsat");
            radaEl.appendChild(a);
          } else if (kontakt.telefon) {
            radaEl.appendChild(document.createTextNode(kontakt.telefon));
          }
        }
        telo.appendChild(radaEl);
      }
    }

    radek.appendChild(telo);
    return radek;
  }

  function vykresliKusy() {
    var blok = okno.querySelector(".qkb-kusy");
    blok.innerHTML = "";
    blok.appendChild(el("h3", null, t("kusy")));
    var poradi = katalog().poradi || [];
    var mam = 0;
    for (var i = 0; i < poradi.length; i++) {
      var typ = poradi[i];
      var def = defVrstvy(typ);
      if (!def || !def.zbozi) continue;
      var kus = vzhled().kusy[typ];
      if (!kus || !kus.produkt || jeDilSady(kus)) continue;
      blok.appendChild(radekKusu(typ, kus));
      mam += 1;
    }
    if (mam === 0) {
      blok.appendChild(el("div", "qkb-sub", t("nic")));
      return;
    }
    /*
     * Začít znovu je tady, ne pod křížkem. Křížek dřív zavřel kabinu
     * **i se vším, co v ní bylo** — a kdo chtěl jen zavřít okno, přišel
     * o vzhled. Teď křížek jen zavře a vzhled zůstane v bublině.
     */
    var znovu = el("div", "qkb-rada-radek");
    znovu.appendChild(tlac("qkb-odkaz", t("zacitZnovu"), function () {
      var kusy = vzhled().kusy;
      for (var typ2 in kusy) {
        if (!Object.prototype.hasOwnProperty.call(kusy, typ2)) continue;
        var d = defVrstvy(typ2);
        if (d && d.zbozi) delete kusy[typ2];
      }
      vykresliScenu();
      prekresli();
    }));
    blok.appendChild(znovu);
  }

  /* --------------------------------------------------- doporučení */

  function kartaProduktu(p, kliknuti) {
    var k = tlac("qkb-karta", null, kliknuti);
    if (p.obrazek) {
      var img = document.createElement("img");
      img.src = p.obrazek;
      img.alt = "";
      img.loading = "lazy";
      k.appendChild(img);
    } else {
      /* Prázdné src je v prohlížeči rozbitý obrázek, ne nic */
      k.appendChild(el("div", "qkb-bezobrazku"));
    }
    k.appendChild(el("b", null, p.nazev));
    k.appendChild(el("i", null, p.cena));
    k.setAttribute("title", p.nazev);
    /* Co už na modelu je, má být v nabídce poznat — jinak se kliká naslepo */
    var naModelu = vzhled().kusy[p.typ];
    if (naModelu && naModelu.produkt === p.kod) {
      k.className += " qkb-karta-na";
      k.setAttribute("aria-pressed", "true");
      k.appendChild(el("span", "qkb-stitek", "✓ " + t("naModelu")));
    }
    return k;
  }

  /** Souvisejíci produkty ze stránky, kde zákazník klikl. */
  var SOUVISEJICI = [];

  function vykresliRady() {
    var blok = okno.querySelector(".qkb-rady");
    blok.innerHTML = "";
    var nabidka = [];
    var videne = {};
    var i, p;
    /*
     * Nejdřív to, co k produktu přiřadil e-shop: „souvisejicí" je
     * rozhodnutí člověka, který zboží zná, a to je lepší podklad než
     * barevná blízkost. Teprve pak radí kabina sama.
     */
    for (i = 0; i < SOUVISEJICI.length; i++) {
      p = najdiProdukt(SOUVISEJICI[i]);
      if (!p || videne[p.kod]) continue;
      if (vzhled().kusy[p.typ] && vzhled().kusy[p.typ].produkt === p.kod) continue;
      videne[p.kod] = 1;
      nabidka.push(p);
    }
    var rady = poradce(vzhled());
    for (i = 0; i < rady.length; i++) {
      p = produkt(rady[i].produkt);
      if (!p || videne[p.kod]) continue;
      videne[p.kod] = 1;
      nabidka.push(p);
    }
    if (nabidka.length === 0) return;
    blok.appendChild(el("h3", null, t("doporucujeme")));
    var pas = el("div", "qkb-pas");
    for (i = 0; i < Math.min(nabidka.length, 12); i++) {
      pas.appendChild(kartaProduktu(nabidka[i], (function (kus) {
        return function () { nasad(kus); };
      })(nabidka[i])));
    }
    blok.appendChild(pas);
  }

  /* ------------------------------------------------------- hledání */

  var hledanyTyp = "";
  /* Rodina v rámci typu: kravata / motýlek / regata. Prázdná = celý typ. */
  var hledanaRodina = "";

  /** Kategorie k procházení — jen ty, ve kterých něco je. */
  function kategorieVyberu() {
    var vse = [
      { typ: "kravata", rodina: "kravata", nazev: t("kravaty") },
      { typ: "kravata", rodina: "motylek", nazev: t("motylky") },
      { typ: "kravata", rodina: "regata", nazev: t("regaty") },
      { typ: "ksandy", rodina: "", nazev: t("ksandyMn") },
      { typ: "kapesnicek", rodina: "", nazev: t("kapesnicky") }
    ];
    var produktyVse = vsechny();
    return vse.filter(function (k) {
      for (var i = 0; i < produktyVse.length; i++) {
        var p = produktyVse[i];
        if (p.typ === k.typ && (!k.rodina || rodina(p.typ, p.varianta) === k.rodina)) return true;
      }
      return false;
    });
  }

  function hledej(dotaz) {
    var slova = bezDiakritiky(dotaz).split(/\s+/).filter(function (s) { return s.length > 1; });
    var vse = vsechny();
    var out = [];
    for (var i = 0; i < vse.length; i++) {
      var p = vse[i];
      if (hledanyTyp && p.typ !== hledanyTyp) continue;
      if (hledanaRodina && rodina(p.typ, p.varianta) !== hledanaRodina) continue;
      if (slova.length) {
        var text = bezDiakritiky(p.nazev + " " + p.typ + " " + p.varianta);
        var sedi = true;
        for (var j = 0; j < slova.length; j++) if (text.indexOf(slova[j]) < 0) sedi = false;
        if (!sedi) continue;
      }
      out.push(p);
      if (out.length >= 48) break;
    }
    /*
     * Dětské zboží se neschovává, jen řadí za dospělé — kdo hledá
     * dětské kšandy, má je najít, i když je na modelu dospělý. Model se
     * přepne sám při nasazení.
     */
    var vek = vzhled().vek;
    out.sort(function (a, b) {
      var sa = !a.proVek || a.proVek.indexOf(vek) >= 0 ? 0 : 1;
      var sb = !b.proVek || b.proVek.indexOf(vek) >= 0 ? 0 : 1;
      return sa - sb;
    });
    return out;
  }

  function vykresliHledani() {
    var blok = okno.querySelector(".qkb-hledani-blok");
    blok.innerHTML = "";
    var nadpis = el("h3", null, hledanyTyp ? nazevVrstvy(hledanyTyp) : t("vybrat"));
    blok.appendChild(nadpis);

    /*
     * Kategorie jako řada voleb nad hledáním. Dřív byla kategorie vidět
     * jen po kliknutí na bod na modelu a zrušit se dala nenápadným
     * křížkem — kdo chtěl jen projít motýlky, musel je hledat slovem.
     */
    var filtry = el("div", "qkb-pas qkb-filtry");
    var vseChip = tlac("qkb-chip", t("vse"), function () {
      hledanyTyp = ""; hledanaRodina = "";
      vykresliHledani();
    });
    vseChip.setAttribute("aria-pressed", hledanyTyp ? "false" : "true");
    filtry.appendChild(vseChip);
    var kategorie = kategorieVyberu();
    for (var ik = 0; ik < kategorie.length; ik++) {
      var k = kategorie[ik];
      var chip = tlac("qkb-chip", k.nazev, (function (k2) {
        return function () { hledanyTyp = k2.typ; hledanaRodina = k2.rodina; vykresliHledani(); };
      })(k));
      var vybrana = hledanyTyp === k.typ && (!hledanaRodina || hledanaRodina === k.rodina)
        && (hledanaRodina === k.rodina || !k.rodina);
      chip.setAttribute("aria-pressed", vybrana ? "true" : "false");
      filtry.appendChild(chip);
    }
    blok.appendChild(filtry);

    var radek = el("div", "qkb-hledani");
    var pole = document.createElement("input");
    pole.type = "search";
    pole.placeholder = t("hledat");
    pole.setAttribute("aria-label", t("hledat"));
    radek.appendChild(pole);
    blok.appendChild(radek);

    var vysledky = el("div", "qkb-mrizka");
    blok.appendChild(vysledky);

    /* Odkaz do kategorie e-shopu — jen když je zadaný; uhodnout ho nejde */
    var kat = (nastaveni().kategorie || {})[hledanyTyp];
    var adresa = kat && (kat[JAZYK] || kat.cz);
    if (hledanyTyp && adresa) {
      var cele = document.createElement("a");
      cele.href = adresa;
      cele.className = "qkb-odkaz";
      cele.textContent = t("vseVKategorii");
      var obal = el("div", "qkb-rada");
      obal.appendChild(cele);
      blok.appendChild(obal);
    }

    function ukaz() {
      vysledky.innerHTML = "";
      var nalez = hledej(pole.value);
      if (nalez.length === 0) {
        vysledky.appendChild(el("div", "qkb-sub", t("nenalezeno")));
        return;
      }
      for (var i = 0; i < Math.min(nalez.length, 24); i++) {
        vysledky.appendChild(kartaProduktu(nalez[i], (function (p) {
          return function () { nasad(p); };
        })(nalez[i])));
      }
    }

    var cekani = null;
    pole.addEventListener("input", function () {
      if (cekani) clearTimeout(cekani);
      /* Hledá se v tom, co už je stažené, ale překreslit mřížku po
         každém znaku je na mobilu znát */
      cekani = setTimeout(ukaz, 140);
    });
    ukaz();
  }

  function otevriVyber(typ, rodinaVyberu) {
    hledanyTyp = typ || "";
    hledanaRodina = rodinaVyberu || "";
    vykresliHledani();
    var blok = okno.querySelector(".qkb-hledani-blok");
    if (blok && blok.scrollIntoView) blok.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /* ------------------------------------------------- nasazení kusu */

  /** Dá produkt na model — a když je dětský, přepne i model. */
  /** Má vzhled na sobě něco ke koupi (ne jen oblek)? */
  function maZbozi(v) {
    for (var typ in v.kusy) {
      if (!Object.prototype.hasOwnProperty.call(v.kusy, typ)) continue;
      var d = defVrstvy(typ);
      if (d && d.zbozi && v.kusy[typ] && v.kusy[typ].produkt) return true;
    }
    return false;
  }

  function nastavVek(v, cil) {
    v.vek = cil;
    var veky = katalog().veky || [];
    for (var i = 0; i < veky.length; i++) {
      if (veky[i].id === cil && veky[i].vyska) {
        v.vyskaCm = Math.round((veky[i].vyska[0] + veky[i].vyska[1]) / 2);
      }
    }
  }

  function nasad(p) {
    if (!p) return;
    var v = vzhled();
    if (p.proVek && p.proVek.indexOf(v.vek) < 0) {
      var cil = p.proVek[0];
      /*
       * Dětský kus k pánské kravatě: model by se přepnul na dítě i s pánskou
       * kravatou, která na něm visí po kolena. Kabina to pozná sama
       * (Patrik, 23. 11.) a když už je na modelu něco jiného, založí
       * **nový vzhled** se správným modelem — oba se dají porovnat.
       */
      if (maZbozi(v)) {
        var novy = vychozi();
        novy.nazev = t("vzhled") + " " + (varianty.length + 1);
        nastavVek(novy, cil);
        varianty.push(novy);
        kde = varianty.length - 1;
        v = novy;
        hlaska(cil === "dospely" ? t("novyVzhledDospely") : t("novyVzhledDite"));
      } else {
        nastavVek(v, cil);
        hlaska(cil === "dospely" ? t("prepnutoDospely") : t("prepnutoDite"));
      }
    }
    var stary = v.kusy[p.typ];
    /* Co odchází, nese s sebou i zbytek své sady; nová sada si přinese svoje kusy */
    if (stary && stary.produkt) odeberSadu(v, String(stary.produkt).split("~")[0]);
    if (jeDilSady(stary)) {
      var hlavni = String(stary.produkt).split("~")[0];
      for (var typH in v.kusy) {
        if (Object.prototype.hasOwnProperty.call(v.kusy, typH) && v.kusy[typH] && v.kusy[typH].produkt === hlavni) delete v.kusy[typH];
      }
      odeberSadu(v, hlavni);
      stary = null;
    }
    v.kusy[p.typ] = {
      varianta: p.varianta || (stary && stary.varianta) || "",
      hex: p.hex || "#808080",
      produkt: p.kod,
      pocet: stary ? pocetKusu(stary) || 1 : 1,
      velikost: ""
    };
    var casti = p.casti || [];
    for (var ic = 0; ic < casti.length; ic++) {
      var jiny = v.kusy[casti[ic].typ];
      if (jiny && jiny.produkt && !jeDilSady(jiny)) odeberSadu(v, jiny.produkt);
      v.kusy[casti[ic].typ] = {
        varianta: casti[ic].varianta, hex: casti[ic].hex || "#808080",
        produkt: p.kod + "~" + ic, pocet: 0, velikost: ""
      };
    }
    var rada = radaVelikosti(p, v);
    if (rada && rada.kod) v.kusy[p.typ].velikost = rada.kod;
    /*
     * Po výběru se omezení na kategorii pustí — zákazník, který si právě
     * vybral kapesníček, hledá dál něco jiného a nenašel by nic.
     * Překresluje se **tady**, ne při každé změně modelu: jinak by
     * rozepsané slovo v poli zmizelo pokaždé, když vedle přibude kus.
     */
    hledanyTyp = "";
    hledanaRodina = "";
    vykresliScenu();
    vykresliHledani();
    prekresli();
    var radek = okno.querySelector(".qkb-kus[data-typ='" + p.typ + "']");
    if (radek && radek.scrollIntoView) radek.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  /* -------------------------------------------------------- postava */

  function barvyRadek(vybrana, nastav, nabidka) {
    var pas = el("div", "qkb-barvy");
    for (var i = 0; i < nabidka.length; i++) {
      var b = tlac("qkb-barva", null, (function (hex) {
        return function () { nastav(hex); };
      })(nabidka[i].hex));
      b.style.background = nabidka[i].hex;
      b.setAttribute("title", nabidka[i].nazev);
      b.setAttribute("aria-label", nabidka[i].nazev);
      b.setAttribute("aria-pressed", nabidka[i].hex === vybrana ? "true" : "false");
      pas.appendChild(b);
    }
    return pas;
  }

  function panelOtevren() {
    return !!(okno && okno.querySelector(".qkb-zavoj"));
  }

  /** Zavře úpravu modelu bez sahání do historie (volá se i z „zpět" prohlížeče). */
  function zavriPanelHned() {
    if (!okno) return;
    var z = okno.querySelector(".qkb-zavoj");
    if (z && z.parentNode) z.parentNode.removeChild(z);
    okno.className = okno.className.replace(/\s*qkb-upravuji/g, "");
    var tlacitko = okno.querySelector(".qkb-chip-hlavni");
    if (tlacitko) { try { tlacitko.focus({ preventScroll: true }); } catch (e) { /* nic */ } }
  }

  function zavriPanel() {
    if (history.state && history.state.qkb === 2) {
      ignorujPopstate = true;
      history.back();
    }
    zavriPanelHned();
  }

  /*
   * Úprava modelu.
   *
   * Patrik (23. 11.): úprava neměla jasný způsob, jak se vrátit zpět, a
   * křížek v ní vypadal, že zavře celou kabinu. Teď je to panel místo
   * nabídky doplňků — vlevo nahoře „‹ Zpět", dole „Hotovo", a model
   * zůstává vidět (na mobilu nahoře nad panelem), takže je každá změna
   * vidět hned. Tlačítko zpět v telefonu panel zavře, ne stránku.
   */
  function otevriPanel() {
    if (!okno) return;
    if (!panelOtevren()) {
      okno.className += " qkb-upravuji";
      var pravy = okno.querySelector(".qkb-pravy");
      var zavoj = el("div", "qkb-zavoj");
      pravy.insertBefore(zavoj, pravy.firstChild);
      if (!(history.state && history.state.qkb === 2)) doHistorie(2);
    }
    vykresliPanel();
    var telo = okno.querySelector(".qkb-telo");
    var panel = okno.querySelector(".qkb-zavoj");
    if (window.matchMedia && window.matchMedia("(min-width:720px)").matches) {
      okno.querySelector(".qkb-pravy").scrollTop = 0;
    } else if (telo && panel) {
      /* Panel těsně pod nalepený model — jinak by „Zpět" zůstalo schované pod ním */
      var scena = okno.querySelector(".qkb-scena");
      var posun = panel.getBoundingClientRect().top - telo.getBoundingClientRect().top
        - (scena ? scena.offsetHeight : 0);
      telo.scrollTop = Math.max(0, telo.scrollTop + posun);
    }
  }

  function vykresliPanel() {
    var zavoj = okno.querySelector(".qkb-zavoj");
    if (!zavoj) return;
    zavoj.innerHTML = "";
    var v = vzhled();

    var hlava = el("div", "qkb-panel-hlava");
    var zpet = tlac("qkb-zpet", "‹ " + t("zpet"), zavriPanel);
    zpet.setAttribute("aria-label", t("zpet"));
    hlava.appendChild(zpet);
    var text = el("div", "qkb-hlava-text");
    text.appendChild(el("h2", null, t("upravit")));
    text.appendChild(el("div", "qkb-sub", t("upravitDelsi")));
    hlava.appendChild(text);
    zavoj.appendChild(hlava);

    function chipy(nadpis, nabidka, vybrane, nastav) {
      var blok = el("div", "qkb-blok");
      blok.appendChild(el("h3", null, nadpis));
      var pas = el("div", "qkb-pas qkb-pas-zalom");
      for (var i = 0; i < nabidka.length; i++) {
        var chip = tlac("qkb-chip", nabidka[i].nazev, (function (id) {
          return function () { nastav(id); };
        })(nabidka[i].id));
        chip.setAttribute("aria-pressed", nabidka[i].id === vybrane ? "true" : "false");
        if (nabidka[i].popis) chip.setAttribute("title", nabidka[i].popis);
        pas.appendChild(chip);
      }
      blok.appendChild(pas);
      return blok;
    }

    function znovu() {
      vykresliScenu();
      prekresli();
      vykresliPanel();
    }

    /* Kdo to zkouší — jen věky, pro které je postava nakreslená */
    var postavy = (DATA && DATA.postavy) || [];
    var veky = (katalog().veky || []).filter(function (one) {
      for (var i = 0; i < postavy.length; i++) if (postavy[i].vek === one.id) return true;
      return false;
    });
    zavoj.appendChild(chipy(t("vek"), veky, v.vek, function (id) {
      v.vek = id;
      for (var i = 0; i < veky.length; i++) {
        if (veky[i].id === id && veky[i].vyska) v.vyskaCm = Math.round((veky[i].vyska[0] + veky[i].vyska[1]) / 2);
      }
      znovu();
    }));
    /* Postava (štíhlá/silnější) jen tam, kde je víc než jedna — volba, která nic nedělá, mate */
    var tela = (katalog().tela || []).filter(function (one) {
      for (var i = 0; i < postavy.length; i++) if (postavy[i].vek === v.vek && postavy[i].telo === one.id) return true;
      return false;
    });
    if (tela.length > 1) {
      zavoj.appendChild(chipy(t("telo"), tela, v.telo, function (id) { v.telo = id; znovu(); }));
    }

    var vyskaBlok = el("div", "qkb-blok");
    vyskaBlok.appendChild(el("h3", null, t("vyska") + " · " + v.vyskaCm + " cm"));
    var meze = [140, 205];
    var vsechnyVeky = katalog().veky || [];
    for (var iv = 0; iv < vsechnyVeky.length; iv++) if (vsechnyVeky[iv].id === v.vek && vsechnyVeky[iv].vyska) meze = vsechnyVeky[iv].vyska;
    var rozsah = document.createElement("input");
    rozsah.type = "range";
    rozsah.min = String(meze[0]);
    rozsah.max = String(meze[1]);
    rozsah.value = String(v.vyskaCm);
    rozsah.setAttribute("aria-label", t("vyska"));
    rozsah.addEventListener("input", function () {
      v.vyskaCm = Number(this.value);
      vyskaBlok.querySelector("h3").textContent = t("vyska") + " · " + v.vyskaCm + " cm";
    });
    rozsah.addEventListener("change", function () { prekresli(); });
    vyskaBlok.appendChild(rozsah);
    vyskaBlok.appendChild(el("div", "qkb-sub", t("vyskaProc")));
    zavoj.appendChild(vyskaBlok);

    /*
     * Kulisa. Zákazník si ji nastavuje **přibližně** podle toho, co má
     * doma — proto jen barva a jen pár odstínů. Boty tu nejsou: model se
     * ukazuje po stehna a boty neprodáváme.
     */
    var postava = postavaPro(v);
    var poradi = katalog().poradi || [];
    for (var ik = 0; ik < poradi.length; ik++) {
      var typ = poradi[ik];
      var def = defVrstvy(typ);
      if (!def || def.zbozi || typ === "postava" || typ === "boty") continue;
      /* Varianty jen ty, které jsou pro tuhle postavu nakreslené */
      var varianty2 = (def.varianty || []).filter(function (one) {
        return postava && vrstvaPro(postava.id, typ, one.id);
      });
      if (!varianty2.length) continue;
      var kus = v.kusy[typ];
      var blok = el("div", "qkb-blok");
      blok.appendChild(el("h3", null, nazevVrstvy(typ)));
      var barvy = barvyRadek(kus ? kus.hex : "", (function (typ2, var2) {
        return function (hex) {
          var stary = v.kusy[typ2];
          v.kusy[typ2] = { varianta: (stary && stary.varianta) || var2[0].id, hex: hex };
          /* Kdo vybírá barvu saka, chce ho vidět — ale „auto" (s kšandami bez saka) se nepřebíjí */
          if (typ2 === "sako" && v.sako === "skryto") v.sako = "auto";
          znovu();
        };
      })(typ, varianty2), katalog().barvy || []);
      /* Nepovinný kus (vesta, sako) má na začátku volbu „bez" — místo nenápadného odkazu „odebrat" */
      if (def.nepovinna) {
        var bez = tlac("qkb-barva qkb-barva-bez", null, (function (typ2) {
          return function () { delete v.kusy[typ2]; znovu(); };
        })(typ));
        bez.setAttribute("title", t("bez"));
        bez.setAttribute("aria-label", t("bez"));
        bez.setAttribute("aria-pressed", kus ? "false" : "true");
        barvy.insertBefore(bez, barvy.firstChild);
      }
      blok.appendChild(barvy);
      if (varianty2.length > 1 && kus) {
        var pasO = el("div", "qkb-pas qkb-pas-zalom");
        pasO.style.marginTop = "8px";
        for (var io = 0; io < varianty2.length; io++) {
          var chipO = tlac("qkb-chip", varianty2[io].nazev, (function (typ2, id) {
            return function () { v.kusy[typ2].varianta = id; znovu(); };
          })(typ, varianty2[io].id));
          chipO.setAttribute("aria-pressed", varianty2[io].id === kus.varianta ? "true" : "false");
          pasO.appendChild(chipO);
        }
        blok.appendChild(pasO);
      }
      zavoj.appendChild(blok);
    }

    var pata = el("div", "qkb-panel-pata");
    pata.appendChild(tlac("qkb-kosik", t("hotovo"), zavriPanel));
    zavoj.appendChild(pata);
  }

  /* ----------------------------------------------------------- pata */

  function kNakupu() {
    var out = [];
    var poradi = katalog().poradi || [];
    for (var i = 0; i < poradi.length; i++) {
      var kus = vzhled().kusy[poradi[i]];
      if (!kus || !kus.produkt || jeDilSady(kus)) continue;
      var pocet = pocetKusu(kus);
      if (pocet === 0) continue;
      var p = produkt(kus.produkt);
      if (!p) continue;
      out.push({ produkt: p, pocet: pocet, velikost: kus.velikost });
    }
    return out;
  }

  function vykresliPatu() {
    var pata = okno.querySelector(".qkb-pata");
    pata.innerHTML = "";
    var nakup = kNakupu();
    var suma = 0;
    var kusu = 0;
    for (var i = 0; i < nakup.length; i++) {
      suma += nakup[i].produkt.cenaCislo * nakup[i].pocet;
      kusu += nakup[i].pocet;
    }
    var vlevo = el("div", "qkb-suma");
    vlevo.appendChild(el("b", null, cena(suma)));
    vlevo.appendChild(el("span", "qkb-sub", t("celkem") + " · " + kusu + " " + (JAZYK === "en" ? "pcs" : "ks")));
    pata.appendChild(vlevo);

    var tlacitko = tlac("qkb-kosik", t("doKosiku"), function () { doKosiku(nakup, tlacitko); });
    if (nakup.length === 0) tlacitko.disabled = true;
    pata.appendChild(tlacitko);
  }

  /** Jak se vybraná velikost jmenuje — podle toho se hledá na stránce. */
  function popisVelikosti(p, kod) {
    var s = (p && p.velikostiSeznam) || [];
    for (var i = 0; i < s.length; i++) if (s[i].kod === kod) return s[i].popis;
    return "";
  }

  function doKosiku(nakup, tlacitko) {
    if (nakup.length === 0) return;
    tlacitko.disabled = true;
    tlacitko.textContent = t("vkladam");
    var hotovo = 0;
    var neslo = [];
    var postupne = Promise.resolve();
    for (var i = 0; i < nakup.length; i++) {
      postupne = postupne.then((function (co) {
        return function () {
          return vlozKus(co.produkt, co.pocet, popisVelikosti(co.produkt, co.velikost))
            .then(function (ok) { if (ok) hotovo += 1; else neslo.push(co); });
        };
      })(nakup[i]));
    }
    postupne.then(function () {
      tlacitko.disabled = false;
      tlacitko.textContent = t("doKosiku");
      if (hotovo === 0) {
        /*
         * Když vložení neprojde, zákazník nemá zůstat u ničeho: otevře
         * se stránka produktu, kde si ho přidá sám. U velikostí je to
         * stejně to jediné, co je vždycky spolehlivé.
         */
        hlaska(t("chyba"));
        if (neslo.length && neslo[0].produkt.url) location.href = neslo[0].produkt.url;
        return;
      }
      hlaska(t("vlozeno") + ": " + hotovo + (neslo.length ? " · " + neslo.length + "×" + t("chyba") : ""));
      var odkaz = kosikOdkaz();
      var pata = okno.querySelector(".qkb-pata");
      pata.innerHTML = "";
      var vlevo = el("div", "qkb-suma");
      vlevo.appendChild(el("b", null, t("vlozeno")));
      vlevo.appendChild(el("span", "qkb-sub", hotovo + " × " + t("doKosiku")));
      pata.appendChild(vlevo);
      pata.appendChild(tlac("qkb-kosik", t("kosik"), function () {
        location.href = odkaz || "/kosik";
      }));
    });
  }

  /* --------------------------------------------------------- kontakt */

  function vykresliKontakt() {
    var blok = okno.querySelector(".qkb-kontakt");
    blok.innerHTML = "";
    var kontakt = nastaveni().kontakt || {};
    if (!kontakt.text && !kontakt.telefon && !kontakt.mail) return;
    if (kontakt.text) blok.appendChild(document.createTextNode(kontakt.text + " "));
    if (kontakt.telefon) {
      var tel = document.createElement("a");
      tel.href = "tel:" + String(kontakt.telefon).replace(/\s+/g, "");
      tel.textContent = kontakt.telefon;
      blok.appendChild(tel);
    }
    if (kontakt.telefon && kontakt.mail) blok.appendChild(document.createTextNode(" · "));
    if (kontakt.mail) {
      var mail = document.createElement("a");
      mail.href = "mailto:" + kontakt.mail + "?subject=" + encodeURIComponent(t("kabina"))
        + "&body=" + encodeURIComponent(odkazVzhledu());
      mail.textContent = kontakt.mail;
      blok.appendChild(mail);
    }
    /*
     * Vzhled jako odkaz. Je to celé v adrese, takže nic neukládáme a
     * odkaz funguje komukoli — typicky partnerovi před svatbou, což je
     * u svatebních doplňků ta nejčastější druhá otázka po ceně.
     */
    var sdilet = el("div", "qkb-rada-radek");
    sdilet.appendChild(tlac("qkb-odkaz", t("odkaz"), function () {
      var adresa = odkazVzhledu();
      var hotovo = function () { hlaska(t("zkopirovano")); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(adresa).then(hotovo, function () { hlaska(adresa); });
      } else {
        hlaska(adresa);
      }
    }));
    blok.appendChild(sdilet);
  }

  function odkazVzhledu() {
    return location.origin + location.pathname + "?kabina=" + encodeURIComponent(doTextu(vzhled()));
  }

  function vykresliVse() {
    if (!okno) return;
    vykresliVarianty();
    vykresliRady();
    vykresliKusy();
    /*
     * Hledání se překresluje jen poprvé. Překreslit ho při každé změně
     * modelu by znamenalo, že rozepsané slovo v poli zmizí pokaždé, když
     * zákazník vedle klikne na plus u počtu.
     */
    if (!okno.querySelector(".qkb-hledani-blok").firstChild) vykresliHledani();
    vykresliPatu();
    vykresliKontakt();
  }

  /* -------------------------------------------------------- otevření */

  function postav() {
    var styl = document.createElement("style");
    styl.setAttribute("data-qkb", "kabina");
    styl.textContent = STYL;
    document.head.appendChild(styl);

    pozadi = el("div", "qkb-pozadi");
    okno = el("div", "qkb");
    okno.setAttribute("role", "dialog");
    okno.setAttribute("aria-modal", "true");
    okno.setAttribute("aria-label", t("kabina"));

    var hlava = el("div", "qkb-hlava");
    var text = el("div", "qkb-hlava-text");
    text.appendChild(el("h2", null, t("kabina")));
    text.appendChild(el("div", "qkb-sub", t("podnadpis")));
    hlava.appendChild(text);
    /*
     * Jen jedno tlačítko: zavřít. Dřív byly dvě — „nechat na později"
     * a „zavřít", a zavřít zahodilo celý vzhled. Rozdíl nikdo neviděl.
     * Teď se vzhled pamatuje vždycky a bublina ho vrátí; kdo chce začít
     * znovu, má na to tlačítko u doplňků.
     */
    var zavri = tlac("qkb-ikona", "×", zavrit);
    zavri.setAttribute("title", t("zavritDelsi"));
    zavri.setAttribute("aria-label", t("zavrit"));
    hlava.appendChild(zavri);
    okno.appendChild(hlava);

    var telo = el("div", "qkb-telo");
    var levy = el("div", "qkb-levy");
    levy.appendChild(el("div", "qkb-scena"));
    levy.appendChild(el("div", "qkb-blok qkb-varianty"));
    var pravy = el("div", "qkb-pravy");
    pravy.appendChild(el("div", "qkb-blok qkb-rady"));
    pravy.appendChild(el("div", "qkb-blok qkb-kusy"));
    pravy.appendChild(el("div", "qkb-blok qkb-hledani-blok"));
    pravy.appendChild(el("div", "qkb-kontakt"));
    telo.appendChild(levy);
    telo.appendChild(pravy);
    okno.appendChild(telo);
    okno.appendChild(el("div", "qkb-pata"));

    pozadi.appendChild(okno);
    pozadi.addEventListener("click", function (e) { if (e.target === pozadi) zavrit(); });
    document.body.appendChild(pozadi);
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape" || !pozadi || pozadi.style.display === "none") return;
      if (velkyOtevren()) { zavriVelky(); return; }
      if (panelOtevren()) { zavriPanel(); return; }
      zavrit();
    });
    /*
     * Tlačítko zpět v telefonu. Bez tohohle odvedlo zákazníka z produktu
     * pryč, i když měl otevřenou jen kabinu — na mobilu nejčastější
     * způsob, jak se „zavírá okno". Otevření kabiny (a úpravy modelu)
     * proto přidá krok do historie a zpět ho zase sundá.
     */
    window.addEventListener("popstate", function () {
      if (ignorujPopstate) { ignorujPopstate = false; return; }
      if (!pozadi || pozadi.style.display === "none") return;
      if (velkyOtevren()) { skryjVelky(); return; }
      if (panelOtevren()) { zavriPanelHned(); return; }
      schovej();
    });
  }

  var ignorujPopstate = false;

  /* Otočení telefonu nebo změna okna: model se zmenšuje na přesné body displeje, tak znovu */
  var naZmenu = null;
  window.addEventListener("resize", function () {
    if (!pozadi || pozadi.style.display === "none") return;
    if (naZmenu) clearTimeout(naZmenu);
    naZmenu = setTimeout(function () {
      if (platno && plne && vyrezTed) zmensiNa(platno, plne, vyrezTed);
    }, 200);
  });

  /*
   * Velký obrázek celého modelu přes celou obrazovku. Přizpůsobí se
   * oknu; klepnutí přepne na plné rozlišení (posouvá se prstem nebo
   * kolečkem) a zpět. Zavírá se křížkem, Esc, klepnutím vedle nebo
   * tlačítkem zpět v telefonu.
   */
  var velky = null;
  function velkyOtevren() { return !!velky && velky.style.display !== "none"; }

  function ukazVelky() {
    if (!okno) return;
    if (!velky) {
      velky = el("div", "qkb-velky");
      velky.setAttribute("role", "dialog");
      velky.setAttribute("aria-label", t("velkyObrazek"));
      var obal = el("div", "qkb-velky-obal");
      var c = document.createElement("canvas");
      c.setAttribute("role", "img");
      c.setAttribute("aria-label", t("kabina"));
      obal.appendChild(c);
      velky.appendChild(obal);
      var krizek = tlac("qkb-velky-zavrit", "\u00d7", function (e) { e.stopPropagation(); zavriVelky(); });
      krizek.setAttribute("aria-label", t("zavrit"));
      krizek.setAttribute("title", t("zavrit"));
      velky.appendChild(krizek);
      velky.appendChild(el("div", "qkb-velky-rada", t("velkyRada")));
      obal.addEventListener("click", function (e) {
        if (e.target === obal && !/plna/.test(velky.className)) { zavriVelky(); return; }
        prepniPlnou(e);
      });
      pozadi.appendChild(velky);
    }
    velky.className = "qkb-velky";
    velky.style.display = "";
    var platnoVelke = velky.querySelector("canvas");
    platnoVelke.style.width = "";
    platnoVelke.style.height = "";
    var stav = (history.state && history.state.qkb) || 1;
    try { history.pushState({ qkb: stav + 1, velky: 1 }, ""); } catch (e) { /* bez historie to jde taky */ }
    slozModel(vzhled(), platnoVelke, celaPostava);
  }

  function prepniPlnou(e) {
    var c = velky.querySelector("canvas");
    var obal = velky.querySelector(".qkb-velky-obal");
    var r = c.getBoundingClientRect();
    var fx = r.width ? (e.clientX - r.left) / r.width : 0.5;
    var fy = r.height ? (e.clientY - r.top) / r.height : 0.3;
    if (/plna/.test(velky.className)) {
      velky.className = "qkb-velky";
      c.style.width = "";
      c.style.height = "";
      return;
    }
    velky.className = "qkb-velky plna";
    var dpr = Math.min(3, window.devicePixelRatio || 1);
    /* Plné rozlišení: bod plátna na bod displeje, aspoň ale dvakrát větší než přizpůsobený */
    var sirka = Math.max(r.width * 2, c.width / dpr);
    c.style.width = Math.round(sirka) + "px";
    c.style.height = Math.round(sirka * c.height / Math.max(1, c.width)) + "px";
    /* Místo, kam se klepnulo, zůstane uprostřed */
    obal.scrollLeft = Math.max(0, fx * sirka - obal.clientWidth / 2);
    obal.scrollTop = Math.max(0, fy * (sirka * c.height / Math.max(1, c.width)) - obal.clientHeight / 2);
  }

  function skryjVelky() { if (velky) velky.style.display = "none"; }

  function zavriVelky() {
    if (history.state && history.state.velky) {
      ignorujPopstate = true;
      try { history.back(); } catch (e) { ignorujPopstate = false; }
    }
    skryjVelky();
  }

  function doHistorie(uroven) {
    try { history.pushState({ qkb: uroven }, ""); } catch (e) { /* bez historie to jde taky */ }
  }

  function schovej() {
    if (!pozadi) return;
    skryjVelky();
    zavriPanelHned();
    ulozStav();
    pozadi.style.display = "none";
    document.documentElement.removeAttribute("data-qkb-otevreno");
    /* Zámek posouvání se musí pustit, jinak zůstane stránka ztuhlá */
    document.documentElement.style.overflow = "";
  }

  /** Zavře kabinu. Vzhled zůstane — bublina ho vrátí. */
  function zavrit() {
    var hloubka = (history.state && history.state.qkb) || 0;
    if (hloubka) {
      ignorujPopstate = true;
      try { history.go(-hloubka); } catch (e) { ignorujPopstate = false; }
    }
    schovej();
  }

  /* Starší jméno — zavaděč a odkazy v šabloně ho můžou volat */
  function minimalizuj() { zavrit(); }

  function otevri(predvolba) {
    if (!pozadi) postav();
    if (pozadi.style.display !== "flex" && !(history.state && history.state.qkb)) doHistorie(1);
    pozadi.style.display = "flex";
    document.documentElement.style.overflow = "hidden";
    /* Bublina patří k zavřené kabině. Přes otevřenou by jen překážela */
    document.documentElement.setAttribute("data-qkb-otevreno", "1");
    if (!DATA) {
      okno.querySelector(".qkb-scena").appendChild(el("div", "qkb-sub", t("nactitam")));
    }
    return nactiData().then(function () {
      PRODUKTY = null;
      if (!varianty.length) { varianty = [vychozi()]; kde = 0; }
      if (typeof predvolba === "string") {
        var zOdkazu = zTextu(predvolba);
        if (zOdkazu) { varianty = [zOdkazu]; kde = 0; }
      } else if (predvolba && predvolba.kusy) {
        varianty = [predvolba];
        kde = 0;
      } else if (!zeStavu()) {
        var zAdres = zAdresy();
        if (zAdres) { varianty = [zAdres]; kde = 0; }
      }
      vykresliScenu();
      prekresli();
      return true;
    }).catch(function (chyba) {
      /*
       * Když se data stáhla, ale kabina spadla při kreslení, bývá na vině
       * vzhled uložený v prohlížeči z dřívější verze. Zkusí se ještě
       * jednou s čistým vzhledem — zákazník přijde o rozpracovaný vzhled,
       * ale ne o kabinu.
       */
      if (typeof console !== "undefined") console.error("[kabina]", chyba);
      if (DATA && !otevri.znovu) {
        otevri.znovu = true;
        try { localStorage.removeItem(STAV_KLIC); } catch (e) { /* nic */ }
        varianty = [vychozi()];
        kde = 0;
        try {
          vykresliScenu();
          prekresli();
          return true;
        } catch (e2) {
          if (typeof console !== "undefined") console.error("[kabina]", e2);
          chyba = e2;
        }
      }
      var scena = okno.querySelector(".qkb-scena");
      scena.innerHTML = "";
      scena.appendChild(el("div", "qkb-sub", t("chyba")));
      /* V náhledu v aplikaci se ukáže i proč — na e-shopu ne */
      if (location.protocol === "qkbnahled:") {
        scena.appendChild(el("div", "qkb-sub", String((chyba && (chyba.stack || chyba.message)) || chyba).slice(0, 400)));
      }
      return false;
    });
  }

  /** Produkt ze stránky — zavaděč tím otevírá kabinu od tlačítka. */
  function pridej(co) {
    if (!co) return otevri(null);
    if (co.id) zapamatujCislo(co.url, co.id, null);
    SOUVISEJICI = co.souvisejici || [];
    return otevri(null).then(function (ok) {
      if (!ok) return;
      var p = najdiProdukt({ url: co.url, kod: co.kod, nazev: co.nazev });
      if (!p) {
        neniVKabine(co.nazev || "");
        return;
      }
      nasad(p);
    });
  }

  /*
   * Produkt, který v kabině není — ještě neprošel kontrolou (sada, nový
   * kus), nebo ho kabina nezná vůbec. Patrik (23. 11.): „být připravena
   * na scénář, že zákazník bude chtít vložit produkt, který není ještě
   * revidován, a nějak mu to slušně oznámit". Místo čtyřvteřinové
   * hlášky zůstane nahoře vysvětlení a pod ním podobné kusy podle názvu.
   */
  function hadejDruh(nazev) {
    var n = bezDiakritiky(nazev);
    if (/motyl|bow/.test(n)) return { typ: "kravata", rodina: "motylek" };
    if (/regat|cravat/.test(n)) return { typ: "kravata", rodina: "regata" };
    if (/kravat|tie/.test(n)) return { typ: "kravata", rodina: "kravata" };
    if (/ksand|trak|brace|suspend/.test(n)) return { typ: "ksandy", rodina: "" };
    if (/kapesn|vreckov|pocket/.test(n)) return { typ: "kapesnicek", rodina: "" };
    return null;
  }

  function neniVKabine(nazev) {
    var pravy = okno && okno.querySelector(".qkb-pravy");
    if (!pravy) return;
    var stare = pravy.querySelector(".qkb-upozorneni");
    if (stare && stare.parentNode) stare.parentNode.removeChild(stare);
    var blok = el("div", "qkb-upozorneni");
    blok.setAttribute("role", "status");
    if (nazev) blok.appendChild(el("b", null, nazev));
    blok.appendChild(el("span", null, t("neniVKabine")));
    var pryc = tlac("qkb-ikona qkb-upozorneni-x", "×", function () {
      if (blok.parentNode) blok.parentNode.removeChild(blok);
    });
    pryc.setAttribute("aria-label", t("zavrit"));
    blok.appendChild(pryc);
    pravy.insertBefore(blok, pravy.firstChild);
    var druh = hadejDruh(nazev);
    if (druh) otevriVyber(druh.typ, druh.rodina);
  }

  function zAdresy() {
    var shoda = /[?&]kabina=([^&]+)/.exec(location.search);
    if (!shoda) return null;
    try { return zTextu(decodeURIComponent(shoda[1])); } catch (e) { return null; }
  }

  window.quentinoKabina = { otevri: otevri, pridej: pridej, minimalizuj: minimalizuj };

  /* Odkaz z mailu otevře kabinu rovnou s tím vzhledem */
  if (/[?&]kabina=/.test(location.search)) otevri(null);
})();
`;

export interface KabinaVstup {
  /** Adresa souboru s postavami, vrstvami a produkty. */
  zdroj: string;
  /** Jak dlouho stačí uložená kopie, v sekundách. */
  ttl: number;
}

/** Komentáře a odsazení pryč — skript se stahuje zákazníkovi do mobilu. */
function bezKomentaru(text: string): string {
  const out: string[] = [];
  let vBloku = false;
  for (const radek of text.split('\n')) {
    const orez = radek.trim();
    if (vBloku) {
      if (orez.includes('*/')) vBloku = false;
      continue;
    }
    if (orez.startsWith('/*')) {
      if (!orez.includes('*/')) vBloku = true;
      continue;
    }
    if (orez.startsWith('//')) continue;
    if (!orez) continue;
    out.push(orez);
  }
  return out.join('\n');
}

export function kabinaScript(vstup: KabinaVstup): string {
  const zdroj = String(vstup.zdroj ?? '').trim();
  const ttl = Math.max(30, Math.min(86400, Math.round(Number(vstup.ttl)) || 900));
  return bezKomentaru(TEMPLATE)
    .split(ZDROJ_MARK).join(zdroj)
    .split(TTL_MARK).join(String(ttl))
    .trim();
}

export const __test = { ZDROJ_MARK, TTL_MARK, bezKomentaru };
