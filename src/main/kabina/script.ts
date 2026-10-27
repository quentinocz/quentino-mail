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
      zkopirovano: "Odkaz je ve schránce.", sdilet: "Sdílet"
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
      zkopirovano: "Odkaz je v schránke.", sdilet: "Zdieľať"
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
      zkopirovano: "Link copied.", sdilet: "Share"
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
      var c = String(produkty[i].cena || "").replace(/[0-9\s .,]/g, "").trim();
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
    return {
      kod: p.kod, nazev: d.nazev || p.nazev, url: d.url,
      cena: d.cena || p.cena, cenaCislo: d.cenaCislo || p.cenaCislo,
      obrazek: p.obrazek, typ: p.typ, varianta: p.varianta, hex: p.hex, vzorek: p.vzorek,
      velikosti: p.velikosti, skladem: p.skladem,
      velikostiSeznam: p.velikostiSeznam, proVek: p.proVek
    };
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
    for (var i = 0; i < vse.length; i++) if (vse[i].kod === kod) return vse[i];
    return null;
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

  function vrstvyVzhledu(v) {
    var poradi = katalog().poradi || [];
    var sako = sakoVidi(v);
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
  function oblec(img, hex, vzorekImg, sirka, vyska) {
    if (!pomocne) pomocne = document.createElement("canvas");
    pomocne.width = sirka;
    pomocne.height = vyska;
    var ctx = pomocne.getContext("2d");
    ctx.clearRect(0, 0, sirka, vyska);
    ctx.globalCompositeOperation = "source-over";
    if (vzorekImg) {
      var vzor = ctx.createPattern(vzorekImg, "repeat");
      ctx.fillStyle = vzor || podMapu(hex || "#808080");
    } else {
      ctx.fillStyle = podMapu(hex);
    }
    ctx.fillRect(0, 0, sirka, vyska);
    ctx.globalCompositeOperation = "hard-light";
    ctx.drawImage(img, 0, 0, sirka, vyska);
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage(img, 0, 0, sirka, vyska);
    ctx.globalCompositeOperation = "source-over";
    return pomocne;
  }

  function nakresli(platno, v) {
    var postava = postavaPro(v);
    if (!postava) return Promise.resolve();
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
      mam.push({ kus: kusy[i], vrstva: vr, vzorek: zbozi && zbozi.vzorek ? zbozi.vzorek : "" });
      cekani.push(obrazek(vr.url).catch(function () { return null; }));
    }
    /* Vzorky látek se načítají vedle vrstev, ne po nich — jinak se model
       překresluje dvakrát a při přepínání kravat to poskakuje */
    for (var z = 0; z < mam.length; z++) {
      cekani.push(mam[z].vzorek ? obrazek(mam[z].vzorek).catch(function () { return null; }) : Promise.resolve(null));
    }
    return Promise.all(cekani).then(function (nactene) {
      platno.width = sirka;
      platno.height = vyska;
      var ctx = platno.getContext("2d");
      ctx.clearRect(0, 0, sirka, vyska);
      var meritko = Math.max(0.82, Math.min(1.18, (v.vyskaCm || postava.vyskaCm) / postava.vyskaCm));
      ctx.save();
      ctx.translate(sirka / 2, postava.podrazka || vyska);
      ctx.scale(meritko, meritko);
      ctx.translate(-sirka / 2, -(postava.podrazka || vyska));
      for (var j = 0; j < mam.length; j++) {
        var img = nactene[j];
        if (!img) continue;
        var def = defVrstvy(mam[j].kus.typ);
        var vzorekImg = nactene[mam.length + j] || null;
        if (def && def.barvitelna && (mam[j].kus.hex || vzorekImg)) {
          ctx.drawImage(oblec(img, mam[j].kus.hex, vzorekImg, sirka, vyska), 0, 0);
        } else {
          ctx.drawImage(img, 0, 0, sirka, vyska);
        }
      }
      ctx.restore();
    });
  }

  /* ----------------------------------------------------- doporučení */

  function produktyKVrstve(typ, hex, varianta, vek) {
    var vse = vsechny();
    var out = [];
    for (var i = 0; i < vse.length; i++) {
      var p = vse[i];
      if (p.typ !== typ) continue;
      if (varianta && p.varianta && p.varianta !== varianta) continue;
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
    + ".qkb-platno canvas{display:block;height:36vh;width:auto;max-width:100%}"
    + ".qkb-bod{position:absolute;transform:translate(-50%,-50%);width:26px;height:26px;padding:0;"
    + "border:2px solid #fff;border-radius:999px;background:#18181b;color:#fff;cursor:pointer;"
    + "font-size:15px;line-height:1;display:inline-flex;align-items:center;justify-content:center;"
    + "box-shadow:0 1px 6px rgba(0,0,0,.25)}"
    + ".qkb-bod[data-obsazeno='1']{background:rgba(255,255,255,.95);color:#18181b}"
    + ".qkb-bod:focus-visible{outline:2px solid #2563eb;outline-offset:2px}"
    + "@media (prefers-reduced-motion:no-preference){.qkb-bod[data-obsazeno='0']{animation:qkbTik 2.6s ease-in-out infinite}}"
    + "@keyframes qkbTik{0%,72%,100%{box-shadow:0 1px 6px rgba(0,0,0,.25)}"
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
    + ".qkb-odkaz{background:0;border:0;padding:0;color:#2563eb;cursor:pointer;font:inherit;"
    + "font-size:12px;text-decoration:underline}"
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
    + ".qkb-zavoj{position:absolute;inset:0;z-index:5;display:flex;flex-direction:column;background:#fff}"
    + ".qkb-zavoj-telo{flex:1 1 auto;overflow:auto;padding:0 0 12px}"
    + ".qkb-barvy{display:flex;gap:7px;flex-wrap:wrap}"
    + ".qkb-barva{width:32px;height:32px;padding:0;border:2px solid #fff;border-radius:999px;cursor:pointer;"
    + "box-shadow:0 0 0 1px #d4d4d8}"
    + ".qkb-barva[aria-pressed='true']{box-shadow:0 0 0 2px #18181b}"
    + ".qkb-rada-radek{display:flex;gap:8px;align-items:center;margin-top:8px}"
    + ".qkb input[type='range']{width:100%}"
    + "@media (min-width:720px){"
    + ".qkb-pozadi{align-items:center;padding:20px}"
    + ".qkb{max-width:1060px;max-height:88vh;border-radius:16px}"
    + ".qkb-telo{display:grid;grid-template-columns:minmax(280px,40%) 1fr;overflow:hidden}"
    + ".qkb-levy{overflow:auto;border-right:1px solid #f0f0f2}"
    + ".qkb-pravy{overflow:auto}"
    + ".qkb-scena{position:static;flex-direction:column;align-items:center;padding:14px 0 10px}"
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
      if (d && d.zbozi && kusy[typ] && kusy[typ].produkt) kusu += 1;
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
    var sako = sakoVidi(v);
    for (var i = 0; i < vrstvy.length; i++) {
      var def = vrstvy[i];
      if (!def.bod || !def.zbozi) continue;
      if (!maProdukty(def.typ)) continue;
      if (def.typ === "kapesnicek" && !sako) continue;
      var obsazeno = !!v.kusy[def.typ];
      var b = tlac("qkb-bod", obsazeno ? "✓" : "+", (function (typ) {
        return function (e) { e.stopPropagation(); otevriVyber(typ); };
      })(def.typ));
      b.style.left = (def.bod.x * 100) + "%";
      b.style.top = (def.bod.y * 100) + "%";
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
    var upravit = tlac("qkb-chip qkb-chip-hlavni", t("postava"), otevriPostavu);
    upravit.setAttribute("title", t("postavaDelsi"));
    lista.appendChild(upravit);
    /* Sako se dá přepnout jen tam, kde to má smysl — tedy když je */
    if (vzhled().kusy.sako) {
      var vidi = sakoVidi(vzhled());
      var prepni = tlac("qkb-chip", vidi ? t("sakoVidi") : t("sakoSkryto"), function () {
        vzhled().sako = sakoVidi(vzhled()) ? "skryto" : "vidi";
        vykresliScenu();
        prekresli();
      });
      prepni.setAttribute("aria-pressed", vidi ? "true" : "false");
      lista.appendChild(prepni);
    }
    scena.appendChild(lista);
  }

  /* -------------------------------------------------------- varianty */

  function vykresliVarianty() {
    var blok = okno.querySelector(".qkb-varianty");
    blok.innerHTML = "";
    /* Dokud na modelu žádný doplněk není, je nabídka dalšího vzhledu k ničemu */
    if (varianty.length < 2 && kNakupu().length === 0) return;
    blok.appendChild(el("h3", null, t("vzhledy")));
    var pas = el("div", "qkb-pas");
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
      pas.appendChild(tlac("qkb-chip", t("smazat"), function () {
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
    telo.appendChild(el("div", "qkb-sub", nazevVrstvy(typ) + (p ? " · " + p.cena : "")));

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

    ovladani.appendChild(tlac("qkb-odkaz", t("odebrat"), function () {
      delete vzhled().kusy[typ];
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
      if (!kus || !kus.produkt) continue;
      blok.appendChild(radekKusu(typ, kus));
      mam += 1;
    }
    if (mam === 0) blok.appendChild(el("div", "qkb-sub", t("nic")));
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

  function hledej(dotaz) {
    var slova = bezDiakritiky(dotaz).split(/\s+/).filter(function (s) { return s.length > 1; });
    var vse = vsechny();
    var out = [];
    for (var i = 0; i < vse.length; i++) {
      var p = vse[i];
      if (hledanyTyp && p.typ !== hledanyTyp) continue;
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
    var nadpis = el("h3", null, hledanyTyp ? nazevVrstvy(hledanyTyp) : t("hledat"));
    blok.appendChild(nadpis);

    var radek = el("div", "qkb-hledani");
    var pole = document.createElement("input");
    pole.type = "search";
    pole.placeholder = t("hledat");
    pole.setAttribute("aria-label", t("hledat"));
    radek.appendChild(pole);
    if (hledanyTyp) {
      radek.appendChild(tlac("qkb-chip", "×", function () {
        hledanyTyp = "";
        vykresliHledani();
      }));
    }
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
    if (hledanyTyp) {
      try { pole.focus({ preventScroll: true }); } catch (e) { pole.focus(); }
    }
  }

  function otevriVyber(typ) {
    hledanyTyp = typ;
    vykresliHledani();
    var blok = okno.querySelector(".qkb-hledani-blok");
    if (blok && blok.scrollIntoView) blok.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /* ------------------------------------------------- nasazení kusu */

  /** Dá produkt na model — a když je dětský, přepne i model. */
  function nasad(p) {
    if (!p) return;
    var v = vzhled();
    if (p.proVek && p.proVek.indexOf(v.vek) < 0) {
      var cil = p.proVek[0];
      v.vek = cil;
      var veky = katalog().veky || [];
      for (var i = 0; i < veky.length; i++) {
        if (veky[i].id === cil && veky[i].vyska) {
          v.vyskaCm = Math.round((veky[i].vyska[0] + veky[i].vyska[1]) / 2);
        }
      }
      hlaska(cil === "dospely" ? t("prepnutoDospely") : t("prepnutoDite"));
    }
    var stary = v.kusy[p.typ];
    v.kusy[p.typ] = {
      varianta: p.varianta || (stary && stary.varianta) || "",
      hex: p.hex || "#808080",
      produkt: p.kod,
      pocet: stary ? pocetKusu(stary) || 1 : 1,
      velikost: ""
    };
    var rada = radaVelikosti(p, v);
    if (rada && rada.kod) v.kusy[p.typ].velikost = rada.kod;
    /*
     * Po výběru se omezení na kategorii pustí — zákazník, který si právě
     * vybral kapesníček, hledá dál něco jiného a nenašel by nic.
     * Překresluje se **tady**, ne při každé změně modelu: jinak by
     * rozepsané slovo v poli zmizelo pokaždé, když vedle přibude kus.
     */
    hledanyTyp = "";
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

  function otevriPostavu() {
    var zavoj = el("div", "qkb-zavoj");
    var hlava = el("div", "qkb-hlava");
    var text = el("div", "qkb-hlava-text");
    text.appendChild(el("h2", null, t("postava")));
    text.appendChild(el("div", "qkb-sub", t("postavaDelsi")));
    hlava.appendChild(text);
    hlava.appendChild(tlac("qkb-ikona", "×", function () {
      if (zavoj.parentNode) zavoj.parentNode.removeChild(zavoj);
    }));
    zavoj.appendChild(hlava);

    var telo = el("div", "qkb-zavoj-telo");
    var v = vzhled();

    function chipy(nadpis, nabidka, vybrane, nastav) {
      var blok = el("div", "qkb-blok");
      blok.appendChild(el("h3", null, nadpis));
      var pas = el("div", "qkb-pas");
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
      if (zavoj.parentNode) zavoj.parentNode.removeChild(zavoj);
      vykresliScenu();
      prekresli();
      otevriPostavu();
    }

    telo.appendChild(chipy(t("vek"), katalog().veky || [], v.vek, function (id) {
      v.vek = id;
      var veky = katalog().veky || [];
      for (var i = 0; i < veky.length; i++) {
        if (veky[i].id === id && veky[i].vyska) {
          v.vyskaCm = Math.round((veky[i].vyska[0] + veky[i].vyska[1]) / 2);
        }
      }
      znovu();
    }));
    telo.appendChild(chipy(t("telo"), katalog().tela || [], v.telo, function (id) { v.telo = id; znovu(); }));

    var vyskaBlok = el("div", "qkb-blok");
    vyskaBlok.appendChild(el("h3", null, t("vyska") + " · " + v.vyskaCm + " cm"));
    var meze = [140, 205];
    var veky = katalog().veky || [];
    for (var iv = 0; iv < veky.length; iv++) if (veky[iv].id === v.vek && veky[iv].vyska) meze = veky[iv].vyska;
    var rozsah = document.createElement("input");
    rozsah.type = "range";
    rozsah.min = String(meze[0]);
    rozsah.max = String(meze[1]);
    rozsah.value = String(v.vyskaCm);
    rozsah.setAttribute("aria-label", t("vyska"));
    rozsah.addEventListener("input", function () {
      v.vyskaCm = Number(this.value);
      vyskaBlok.querySelector("h3").textContent = t("vyska") + " · " + v.vyskaCm + " cm";
      prekresli();
    });
    vyskaBlok.appendChild(rozsah);
    telo.appendChild(vyskaBlok);

    /*
     * Vlasy a vousy tu nejsou. Jsou součástí postavy, ne vrstvou —
     * zákazník si vybírá kravatu, ne účes modela, a každý další účes
     * byl obrázek navíc, který se musel povést.
     */

    /*
     * Kulisa. Zákazník si ji nastavuje **přibližně** podle toho, co má
     * doma — proto jen barva a jen pár odstínů. Oblek se u nás nekupuje;
     * kdyby se tu vybíral do detailu, kabina by slibovala něco, co
     * neprodáváme.
     */
    var poradi = katalog().poradi || [];
    for (var ik = 0; ik < poradi.length; ik++) {
      var typ = poradi[ik];
      var def = defVrstvy(typ);
      if (!def || def.zbozi || typ === "postava") continue;
      var kus = v.kusy[typ];
      var blok = el("div", "qkb-blok");
      blok.appendChild(el("h3", null, nazevVrstvy(typ)));
      blok.appendChild(barvyRadek(kus ? kus.hex : "", (function (typ2, def2) {
        return function (hex) {
          var stary = v.kusy[typ2];
          v.kusy[typ2] = {
            varianta: (stary && stary.varianta) || (def2.varianty[0] && def2.varianty[0].id) || "",
            hex: hex
          };
          znovu();
        };
      })(typ, def), katalog().barvy || []));
      if (def.nepovinna && kus) {
        var radekO = el("div", "qkb-rada-radek");
        radekO.appendChild(tlac("qkb-odkaz", t("odebrat"), (function (typ2) {
          return function () { delete v.kusy[typ2]; znovu(); };
        })(typ)));
        blok.appendChild(radekO);
      }
      if (def.varianty && def.varianty.length > 1 && kus) {
        var pasO = el("div", "qkb-pas");
        pasO.style.marginTop = "8px";
        for (var io = 0; io < def.varianty.length; io++) {
          var chipO = tlac("qkb-chip", def.varianty[io].nazev, (function (typ2, id) {
            return function () { v.kusy[typ2].varianta = id; znovu(); };
          })(typ, def.varianty[io].id));
          chipO.setAttribute("aria-pressed", def.varianty[io].id === kus.varianta ? "true" : "false");
          pasO.appendChild(chipO);
        }
        blok.appendChild(pasO);
      }
      telo.appendChild(blok);
    }

    zavoj.appendChild(telo);
    okno.appendChild(zavoj);
  }

  /* ----------------------------------------------------------- pata */

  function kNakupu() {
    var out = [];
    var poradi = katalog().poradi || [];
    for (var i = 0; i < poradi.length; i++) {
      var kus = vzhled().kusy[poradi[i]];
      if (!kus || !kus.produkt) continue;
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
    var min = tlac("qkb-ikona", "⌄", minimalizuj);
    min.setAttribute("title", t("minimalizovat"));
    min.setAttribute("aria-label", t("minimalizovat"));
    hlava.appendChild(min);
    var zavri = tlac("qkb-ikona", "×", zavrit);
    zavri.setAttribute("title", t("zavrit"));
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
    pozadi.addEventListener("click", function (e) { if (e.target === pozadi) minimalizuj(); });
    document.body.appendChild(pozadi);
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape" || !pozadi || pozadi.style.display === "none") return;
      var zavoj = okno.querySelector(".qkb-zavoj");
      if (zavoj) { zavoj.parentNode.removeChild(zavoj); return; }
      minimalizuj();
    });
  }

  function minimalizuj() {
    if (!pozadi) return;
    ulozStav();
    pozadi.style.display = "none";
    document.documentElement.removeAttribute("data-qkb-otevreno");
    /* Zámek posouvání se musí pustit, jinak zůstane stránka ztuhlá */
    document.documentElement.style.overflow = "";
  }

  function zavrit() {
    minimalizuj();
    try { localStorage.removeItem(STAV_KLIC); } catch (e) { /* nic */ }
    if (window.__quentinoKabinaStav) {
      try { window.__quentinoKabinaStav(); } catch (e) { /* nic */ }
    }
  }

  function otevri(predvolba) {
    if (!pozadi) postav();
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
    }).catch(function () {
      var scena = okno.querySelector(".qkb-scena");
      scena.innerHTML = "";
      scena.appendChild(el("div", "qkb-sub", t("chyba")));
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
        hlaska(t("nahrada"));
        return;
      }
      nasad(p);
    });
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
