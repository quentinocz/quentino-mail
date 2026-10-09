/**
 * Zkušební kabina na e-shopu — skript, který skládá model z vrstev.
 *
 * ## Proč je to skript v šabloně a ne stránka
 *
 * Do šablony Upgates se dá vložit jen kus kódu na konec `<head>`. Kabina
 * proto není samostatná stránka, ale **okno, které se otevře nad tou,
 * kde zákazník zrovna je** — u produktu, v kategorii, kdekoli. Nikam se
 * neodchází a košík zůstává ten, co byl.
 *
 * ## Proč se do stránky do kliknutí nesáhne
 *
 * Požadavek zněl jasně: nesmí to brzdit načítání ani zhoršit hodnocení
 * u Googlu. Skript proto při načtení stránky **neudělá nic** než to, že
 * si zapamatuje, na co se dá kliknout. Žádný prvek nepřidá, žádný obrázek
 * nestáhne, žádné písmo nenačte, nic nepřepíše. Teprve po kliknutí si
 * stáhne seznam vrstev a obrázky k té postavě, kterou zákazník zvolil.
 * Pro vyhledávač je tedy stránka tatáž jako bez kabiny.
 *
 * ## Proč se barví na plátně a nestahuje se hotový obrázek
 *
 * Zákazník si vybírá **přesnou barvu**. Kdyby se pro každou barvu
 * stahoval hotový obrázek, čekalo by se u každého posunutí kolečkem a
 * server by musel mít předpřipravené všechny kombinace — těch je víc než
 * hvězd. Vrstva je proto šedá **mapa světla** a plátno ji složí se
 * zvolenou barvou režimem `hard-light`: polotón vydá přesně tu barvu,
 * stíny zůstanou stíny a odlesky odlesky. Přebarvení je okamžité a nic
 * se při něm nestahuje.
 *
 * ## Pozor při úpravách
 *
 * Text níž je `String.raw`, takže se v něm nesmí objevit zpětný apostrof
 * ani dolar se složenou závorkou. Řetězce se proto spojují plusem.
 */

const ZDROJ_MARK = '__QUENTINO_KABINA_ZDROJ__';
const TTL_MARK = '__QUENTINO_KABINA_TTL__';
const KONTAKT_MARK = '"__QUENTINO_KABINA_KONTAKT__"';

const TEMPLATE = String.raw`
<script>
/* Quentino — zkušební kabina. Jak produkty vypadají na modelu. */
(function () {
  "use strict";
  if (window.__quentinoKabina) return;
  window.__quentinoKabina = true;

  var ZDROJ = "__QUENTINO_KABINA_ZDROJ__";
  var TTL_MS = __QUENTINO_KABINA_TTL__ * 1000;
  var KONTAKT = "__QUENTINO_KABINA_KONTAKT__";
  var ULOZ_KLIC = "quentino-kabina-vzhledy";
  var DATA_KLIC = "quentino-kabina-data";

  /* ---------------------------------------------------------- pomůcky */

  function el(tag, trida, text) {
    var e = document.createElement(tag);
    if (trida) e.className = trida;
    if (text != null) e.textContent = text;
    return e;
  }

  function naHex(hex) {
    var t = String(hex || "").replace("#", "");
    if (t.length === 3) t = t[0] + t[0] + t[1] + t[1] + t[2] + t[2];
    if (!/^[0-9a-fA-F]{6}$/.test(t)) return null;
    return {
      r: parseInt(t.slice(0, 2), 16),
      g: parseInt(t.slice(2, 4), 16),
      b: parseInt(t.slice(4, 6), 16)
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
      var t = v / 255;
      var c = 1 - (1 - t) / (2 * (1 - s));
      return Math.max(0, Math.min(255, Math.round(c * 255)));
    }
    return zHex(uprav(rgb.r), uprav(rgb.g), uprav(rgb.b));
  }

  function svetlost(hex) {
    var rgb = naHex(hex);
    if (!rgb) return 0;
    return (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255;
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

  function cena(c) {
    try { return new Intl.NumberFormat("cs-CZ").format(Math.round(c)) + " Kč"; }
    catch (e) { return Math.round(c) + " Kč"; }
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
    if (hotove) { DATA = hotove; return Promise.resolve(DATA); }
    nacitam = fetch(ZDROJ, { credentials: "omit" })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        DATA = data;
        try { localStorage.setItem(DATA_KLIC, JSON.stringify({ kdy: Date.now(), data: data })); }
        catch (e) { /* plná schránka kabinu nezastaví */ }
        return data;
      });
    return nacitam;
  }

  function postavaPro(vzhled) {
    var hledane = vzhled.vek + "-" + vzhled.telo;
    var vse = (DATA && DATA.postavy) || [];
    for (var i = 0; i < vse.length; i++) if (vse[i].id === hledane) return vse[i];
    /* Když zrovna tahle kombinace není, vezme se stejný věk */
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
    var vse = (DATA && DATA.katalog && DATA.katalog.vrstvy) || [];
    for (var i = 0; i < vse.length; i++) if (vse[i].typ === typ) return vse[i];
    return null;
  }

  /* ------------------------------------------------------- vzhled */

  function vychozi() {
    var zaklad = (DATA && DATA.katalog && DATA.katalog.vychozi) || null;
    if (zaklad) return JSON.parse(JSON.stringify(zaklad));
    return {
      vek: "dospely", telo: "bezny", vyskaCm: 180,
      vlasyVarianta: "kratke", vlasyHex: "#3b2a20", fousy: "",
      kusy: {}
    };
  }

  function doTextu(v) {
    var casti = [[v.vek, v.telo, v.vyskaCm, v.vlasyVarianta,
      String(v.vlasyHex).replace("#", ""), v.fousy || "-"].join(":")];
    var poradi = (DATA && DATA.katalog && DATA.katalog.poradi) || [];
    for (var i = 0; i < poradi.length; i++) {
      var typ = poradi[i];
      if (typ === "postava" || typ === "vlasy" || typ === "fousy") continue;
      var kus = v.kusy[typ];
      if (!kus) continue;
      casti.push(typ + ":" + kus.varianta + ":" + String(kus.hex).replace("#", "") + ":" + (kus.produkt || ""));
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
    v.vlasyVarianta = hlava[3];
    v.vlasyHex = "#" + hlava[4];
    v.fousy = hlava[5] === "-" ? "" : hlava[5];
    v.kusy = {};
    for (var i = 1; i < casti.length; i++) {
      var k = casti[i].split(":");
      if (!k[0]) continue;
      v.kusy[k[0]] = { varianta: k[1] || "", hex: "#" + (k[2] || "ffffff"), produkt: k[3] || "" };
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

  /** Které vrstvy se pro vzhled kreslí, odspodu nahoru. */
  function vrstvyVzhledu(v) {
    var poradi = (DATA && DATA.katalog && DATA.katalog.poradi) || [];
    var out = [];
    for (var i = 0; i < poradi.length; i++) {
      var typ = poradi[i];
      if (typ === "postava") { out.push({ typ: typ, varianta: "zaklad", hex: "" }); continue; }
      if (typ === "vlasy") { out.push({ typ: typ, varianta: v.vlasyVarianta, hex: v.vlasyHex }); continue; }
      if (typ === "fousy") {
        if (v.fousy) out.push({ typ: typ, varianta: v.fousy, hex: v.vlasyHex });
        continue;
      }
      var kus = v.kusy[typ];
      if (kus) out.push({ typ: typ, varianta: kus.varianta, hex: kus.hex });
    }
    return out;
  }

  /*
   * Jedna vrstva na pomocné plátno.
   *
   * Podklad je buď **zvolená barva** (oblek, košile — to je kulisa, kterou
   * si zákazník nastavuje přibližně podle svého), nebo **vydlážděný kousek
   * látky** vystřižený z fotky produktu (kravata, motýlek, kšandy,
   * kapesníček — to je zboží a kupuje se konkrétní kus se svým vzorem).
   * Přes podklad jde mapa světla režimem hard-light, u kterého polotón
   * vydá podklad beze změny, a nakonec se to ořízne průhledností vrstvy.
   * Bez toho oříznutí by podklad zůstal i tam, kde látka není.
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

  /** Produkt podle kódu. */
  function produkt(kod) {
    if (!kod) return null;
    var vse = (DATA && DATA.produkty) || [];
    for (var i = 0; i < vse.length; i++) if (vse[i].kod === kod) return vse[i];
    return null;
  }

  function nakresli(platno, v) {
    var postava = postavaPro(v);
    if (!postava) return Promise.resolve();
    var sirka = postava.sirka;
    var vyska = postava.vyska;
    var kusy = vrstvyVzhledu(v);
    var cekani = [];
    var mam = [];
    for (var i = 0; i < kusy.length; i++) {
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
      /*
       * Výška se dělá měřítkem od chodidel. Vyšší model má tytéž
       * proporce, jen je větší — kreslit kvůli každé výšce vlastní sadu
       * vrstev by znamenalo desetkrát tolik obrázků bez viditelného
       * rozdílu.
       */
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

  /*
   * Rady jsou krátké a každá má důvod, který se dá napsat do věty.
   * „Tohle se taky kupuje" se v obleku pozná: k námořnickému saku to
   * doporučí hnědý pásek a zákazník přestane radám věřit.
   *
   * U **zboží** rada ukazuje konkrétní kus z katalogu, ne odstín:
   * zákazník si nekupuje barvu, kupuje si tuhle kravatu. U **kulisy**
   * (oblek, košile) ukazuje barvu — tu si nastavuje podle svého.
   */
  function maProdukty(typ) {
    var vse = (DATA && DATA.produkty) || [];
    for (var i = 0; i < vse.length; i++) if (vse[i].typ === typ) return true;
    return false;
  }

  function nejblizsi(typ, hex, varianta) {
    var nabidka = produktyKVrstve(typ, hex, varianta);
    return nabidka.length ? nabidka[0] : null;
  }

  function poradce(v) {
    var rady = [];
    var sako = v.kusy.sako, kosile = v.kusy.kosile, kravata = v.kusy.kravata;

    if (!kosile) {
      rady.push({ typ: "kosile", druh: "chybi", hex: "#f6f6f4",
        text: "Nastav barvu košile — na bílé vypadá motýlek jinak než na modré." });
    }
    if (!sako && !v.kusy.vesta) {
      rady.push({ typ: "sako", druh: "chybi", hex: "#1f2d4d",
        text: "Přidej sako nebo vestu, ať je vidět, na čem doplněk bude." });
    }

    if (!kravata && maProdukty("kravata")) {
      var cil = sako ? ztmav(sako.hex, 0.35) : "#5b1d26";
      var kus = nejblizsi("kravata", cil, "");
      if (kus) {
        rady.push({ typ: "kravata", druh: "ladi", hex: "", produkt: kus.kod,
          text: "K tomuhle obleku sedne " + kus.nazev.toLowerCase() + "." });
      }
    }
    if (!v.kusy.kapesnicek && (sako || v.kusy.vesta) && maProdukty("kapesnicek")) {
      var cilK = kravata ? kravata.hex : (kosile ? kosile.hex : "#f6f6f4");
      var kapesnik = nejblizsi("kapesnicek", cilK, "");
      if (kapesnik) {
        rady.push({ typ: "kapesnicek", druh: "ladi", hex: "", produkt: kapesnik.kod,
          text: "Kapesníček je nejlevnější způsob, jak oblek pozvednout — " + kapesnik.nazev.toLowerCase() + " ladí." });
      }
    }

    /* Doplněk, který na podkladu není vidět, je vyhozená koupě */
    var hlidane = ["kravata", "kapesnicek", "ksandy"];
    for (var h = 0; h < hlidane.length; h++) {
      var typ = hlidane[h];
      var mam = v.kusy[typ];
      if (!mam) continue;
      var vuci = typ === "ksandy" ? kosile : (sako || kosile);
      if (!vuci || rozdilBarev(mam.hex, vuci.hex) >= 0.1) continue;
      var def = defVrstvy(typ);
      /* Mluví se o tom, co má zákazník vybrané — „Motýlek", ne „Kravata nebo motýlek" */
      var jmeno = def ? def.nazev : typ;
      if (def) {
        for (var vv2 = 0; vv2 < def.varianty.length; vv2++) {
          if (def.varianty[vv2].id === mam.varianta) jmeno = def.varianty[vv2].nazev;
        }
      }
      var cilJiny = svetlost(vuci.hex) < 0.5 ? "#c8b394" : ztmav(vuci.hex, 0.5);
      var jiny = nejblizsi(typ, cilJiny, mam.varianta);
      rady.push({
        typ: typ, druh: "splyva",
        hex: jiny ? "" : cilJiny,
        produkt: jiny ? jiny.kod : "",
        text: jiny
          ? jmeno + " v barvě podkladu zmizí. Vedle něj vynikne " + jiny.nazev.toLowerCase() + "."
          : jmeno + " v barvě podkladu zmizí — zkus výraznější."
      });
    }

    if (sako && kosile && rozdilBarev(sako.hex, kosile.hex) < 0.12) {
      rady.push({
        typ: "kosile", druh: "splyva",
        hex: svetlost(sako.hex) < 0.5 ? "#f6f6f4" : "#1f2d4d",
        text: "Košile má skoro stejnou barvu jako sako — na takové kulise se doplněk posoudit nedá."
      });
    }
    if (v.kusy.pasek && v.kusy.ksandy) {
      rady.push({ typ: "ksandy", druh: "splyva", hex: "", text: "Pásek a kšandy naráz se nenosí. Nech jedno z toho." });
    }
    return rady;
  }

  function produktyKVrstve(typ, hex, varianta) {
    var vse = (DATA && DATA.produkty) || [];
    var out = [];
    for (var i = 0; i < vse.length; i++) {
      var p = vse[i];
      if (p.typ !== typ) continue;
      if (varianta && p.varianta && p.varianta !== varianta) continue;
      out.push(p);
    }
    out.sort(function (a, b) {
      var da = hex ? rozdilBarev(a.hex, hex) : 0;
      var db = hex ? rozdilBarev(b.hex, hex) : 0;
      if (da !== db) return da - db;
      return (b.cenaCislo || 0) - (a.cenaCislo || 0);
    });
    return out;
  }

  /* --------------------------------------------------------- košík */

  function doKosiku(p, pocet) {
    if (!p.url) return { url: "", rovnou: false };
    if (p.velikosti) return { url: p.url, rovnou: false };
    var spojka = p.url.indexOf("?") >= 0 ? "&" : "?";
    return { url: p.url + spojka + "addtocart=1&quantity=" + (pocet || 1) + "&return=back", rovnou: true };
  }

  /* --------------------------------------------------------- okno */

  var STYL = ".qkb-pozadi{position:fixed;inset:0;background:rgba(18,18,20,.62);z-index:99999;display:flex;align-items:center;justify-content:center;padding:16px}"
    + ".qkb{background:#fff;color:#18181b;border-radius:14px;max-width:1120px;width:100%;max-height:94vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 24px 70px rgba(0,0,0,.35);font:14px/1.45 system-ui,-apple-system,'Segoe UI',sans-serif}"
    + ".qkb-hlava{display:flex;align-items:center;gap:12px;padding:14px 18px;border-bottom:1px solid #e7e7e9}"
    + ".qkb-hlava h2{margin:0;font-size:17px;font-weight:650}"
    + ".qkb-hlava .qkb-sub{color:#6b7280;font-size:12.5px}"
    + ".qkb-x{margin-left:auto;border:0;background:#f2f2f4;width:32px;height:32px;border-radius:8px;cursor:pointer;font-size:17px;line-height:1}"
    + ".qkb-telo{display:grid;grid-template-columns:minmax(280px,420px) minmax(0,1fr);gap:0;min-height:0;flex:1}"
    + ".qkb-nahled{background:linear-gradient(#f7f7f8,#ececed);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:14px;position:relative}"
    + ".qkb-nahled canvas{max-width:100%;height:min(62vh,660px);width:auto}"
    + ".qkb-srovnani{display:flex;gap:10px;align-items:flex-end}"
    + ".qkb-srovnani figure{margin:0;text-align:center;flex:1}"
    + ".qkb-srovnani figcaption{font-size:11.5px;color:#6b7280;margin-top:4px}"
    + ".qkb-ovladani{overflow:auto;padding:14px 18px 18px;min-height:0}"
    + ".qkb-blok{border-top:1px solid #ededf0;padding:12px 0}"
    + ".qkb-blok:first-child{border-top:0}"
    + ".qkb-blok h3{margin:0 0 8px;font-size:13px;font-weight:650;letter-spacing:.01em}"
    + ".qkb-rada{display:flex;gap:8px;align-items:flex-start;padding:8px 10px;border-radius:9px;background:#f4f6f9;margin-bottom:6px;font-size:12.5px}"
    + ".qkb-rada.splyva{background:#fdf3ef}"
    + ".qkb-rada button{margin-left:auto;white-space:nowrap}"
    + ".qkb-volby{display:flex;flex-wrap:wrap;gap:6px}"
    + ".qkb-volba{border:1px solid #dcdce1;background:#fff;border-radius:8px;padding:5px 10px;cursor:pointer;font-size:12.5px}"
    + ".qkb-volba.on{border-color:#18181b;background:#18181b;color:#fff}"
    + ".qkb-kus{display:grid;grid-template-columns:92px minmax(0,1fr);gap:8px;align-items:start;padding:7px 0;border-top:1px dashed #ededf0}"
    + ".qkb-kus:first-of-type{border-top:0}"
    + ".qkb-kus>b{font-size:12.5px;padding-top:5px;font-weight:600}"
    + ".qkb-zbozi{background:#fbfbfc;border-radius:11px;padding:10px 12px;border:1px solid #ededf0}"
    + ".qkb-zbozi h3{margin-bottom:2px}"
    + ".qkb-mrizka{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}"
    + ".qkb-kousek{border:1px solid #dcdce1;background:#fff;border-radius:9px;padding:3px;cursor:pointer;width:62px;display:flex;flex-direction:column;align-items:center;gap:2px}"
    + ".qkb-kousek.on{border-color:#18181b;box-shadow:0 0 0 1px #18181b}"
    + ".qkb-kousek img{width:54px;height:54px;object-fit:cover;border-radius:6px;background:#f2f2f4}"
    + ".qkb-flek{width:54px;height:54px;border-radius:6px}"
    + ".qkb-kousek em{font-style:normal;font-size:10.5px;color:#6b7280}"
    + ".qkb-vybrany{flex:1 1 100%;font-size:12.5px;margin-top:4px;display:flex;gap:8px;align-items:baseline}"
    + ".qkb-vybrany a{margin-left:auto;font-size:12px}"
    + ".qkb-rada-foto{width:34px;height:34px;object-fit:cover;border-radius:6px;background:#fff}"
    + ".qkb-barvy{display:flex;flex-wrap:wrap;gap:5px;align-items:center}"
    + ".qkb-barva{width:22px;height:22px;border-radius:50%;border:1px solid rgba(0,0,0,.16);cursor:pointer;padding:0}"
    + ".qkb-barva.on{outline:2px solid #18181b;outline-offset:2px}"
    + ".qkb-presna{width:28px;height:24px;padding:0;border:1px solid #dcdce1;border-radius:6px;background:#fff;cursor:pointer}"
    + ".qkb-vyska{width:100%}"
    + ".qkb-produkt{display:flex;gap:8px;align-items:center;padding:6px;border:1px solid #ededf0;border-radius:9px;margin-top:5px}"
    + ".qkb-produkt img{width:38px;height:38px;object-fit:cover;border-radius:6px;background:#f2f2f4}"
    + ".qkb-produkt .qkb-pnazev{font-size:12.5px;font-weight:600}"
    + ".qkb-produkt .qkb-pcena{font-size:12px;color:#6b7280}"
    + ".qkb-produkt button{margin-left:auto}"
    + ".qkb-pata{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:12px 18px;border-top:1px solid #e7e7e9;background:#fafafb}"
    + ".qkb-suma{font-weight:650}"
    + ".qkb-pata .qkb-osobne{font-size:12px;color:#4b5563;flex:1 1 220px}"
    + ".qkb-btn{border:1px solid #18181b;background:#fff;color:#18181b;border-radius:9px;padding:7px 13px;cursor:pointer;font-size:13px}"
    + ".qkb-btn.plne{background:#18181b;color:#fff}"
    + ".qkb-btn[disabled]{opacity:.45;cursor:default}"
    + ".qkb-maly{font-size:12px;padding:4px 9px;border-radius:7px}"
    + ".qkb-hlaska{position:absolute;left:50%;bottom:14px;transform:translateX(-50%);background:#18181b;color:#fff;padding:7px 13px;border-radius:9px;font-size:12.5px}"
    + ".qkb-ulozene{display:flex;flex-wrap:wrap;gap:6px}"
    + ".qkb-ulozeny{display:flex;align-items:center;gap:6px;border:1px solid #dcdce1;border-radius:9px;padding:4px 6px 4px 9px;font-size:12.5px}"
    + ".qkb-ulozeny.on{border-color:#18181b}"
    + ".qkb-ulozeny button{border:0;background:transparent;cursor:pointer;font-size:13px;color:#9ca3af;padding:0 2px}"
    + "@media(max-width:860px){.qkb-telo{grid-template-columns:1fr}.qkb-nahled canvas{height:36vh}}";

  var okno = null;
  var platno = null;
  var vzhled = null;
  var hlaskaCas = null;

  function hlaska(text) {
    if (!okno) return;
    var stare = okno.querySelector(".qkb-hlaska");
    if (stare) stare.remove();
    var e = el("div", "qkb-hlaska", text);
    okno.querySelector(".qkb-nahled").appendChild(e);
    clearTimeout(hlaskaCas);
    hlaskaCas = setTimeout(function () { e.remove(); }, 2600);
  }

  function ulozene() {
    try { return JSON.parse(localStorage.getItem(ULOZ_KLIC) || "[]"); }
    catch (e) { return []; }
  }

  function zapisUlozene(list) {
    try { localStorage.setItem(ULOZ_KLIC, JSON.stringify(list.slice(0, 12))); }
    catch (e) { /* plná schránka kabinu nezastaví */ }
  }

  var srovnavam = null;

  function prekresli() {
    if (!platno || !vzhled) return;
    nakresli(platno, vzhled);
    if (srovnavam) {
      var druhe = okno.querySelector(".qkb-srovnani-b");
      if (druhe) nakresli(druhe, srovnavam);
    }
    vykresliOvladani();
    vykresliPatu();
  }

  /* ---------------------------------------------------- ovládání */

  function tlacitkoVolby(text, zapnuto, kliknuti) {
    var b = el("button", "qkb-volba" + (zapnuto ? " on" : ""), text);
    b.type = "button";
    b.addEventListener("click", kliknuti);
    return b;
  }

  function barvyRadek(vybrana, nastav, nabidka) {
    var obal = el("div", "qkb-barvy");
    var barvy = nabidka || (DATA.katalog && DATA.katalog.barvy) || [];
    for (var i = 0; i < barvy.length; i++) {
      (function (b) {
        var t = el("button", "qkb-barva" + (b.hex === vybrana ? " on" : ""));
        t.type = "button";
        t.style.background = b.hex;
        t.title = b.nazev;
        t.setAttribute("aria-label", b.nazev);
        t.addEventListener("click", function () { nastav(b.hex); });
        obal.appendChild(t);
      })(barvy[i]);
    }
    /* A přesná barva pro toho, kdo ví, co chce */
    var presna = el("input", "qkb-presna");
    presna.type = "color";
    presna.value = vybrana || "#000000";
    presna.title = "Přesná barva";
    presna.addEventListener("input", function () { nastav(presna.value); });
    obal.appendChild(presna);
    return obal;
  }

  function vykresliOvladani() {
    var kam = okno.querySelector(".qkb-ovladani");
    kam.innerHTML = "";

    /* --- rady --- */
    var rady = poradce(vzhled);
    if (rady.length) {
      var blokRad = el("div", "qkb-blok");
      blokRad.appendChild(el("h3", null, "Poradíme"));
      for (var r = 0; r < Math.min(3, rady.length); r++) {
        (function (rada) {
          var e = el("div", "qkb-rada " + rada.druh);
          /* U rady, která nabízí konkrétní kus, je vidět i jeho fotka */
          var navrzeny = rada.produkt ? produkt(rada.produkt) : null;
          if (navrzeny && (navrzeny.obrazek || navrzeny.vzorek)) {
            var mini = el("img", "qkb-rada-foto");
            mini.src = navrzeny.obrazek || navrzeny.vzorek;
            mini.alt = "";
            mini.loading = "lazy";
            e.appendChild(mini);
          }
          e.appendChild(el("span", null, rada.text));
          if (rada.hex || navrzeny) {
            var b = el("button", "qkb-btn qkb-maly", rada.druh === "chybi" ? "Přidat" : "Použít");
            b.type = "button";
            b.addEventListener("click", function () {
              var def = defVrstvy(rada.typ);
              var stavajici = vzhled.kusy[rada.typ];
              vzhled.kusy[rada.typ] = {
                varianta: navrzeny ? navrzeny.varianta
                  : (stavajici ? stavajici.varianta : (def && def.varianty[0] ? def.varianty[0].id : "")),
                hex: navrzeny && navrzeny.hex ? navrzeny.hex : rada.hex,
                produkt: navrzeny ? navrzeny.kod : (stavajici ? stavajici.produkt : "")
              };
              prekresli();
            });
            e.appendChild(b);
          }
          blokRad.appendChild(e);
        })(rady[r]);
      }
      kam.appendChild(blokRad);
    }

    /* --- postava --- */
    var blok = el("div", "qkb-blok");
    blok.appendChild(el("h3", null, "Kdo to zkouší"));
    var veky = el("div", "qkb-volby");
    var seznamVeku = (DATA.katalog && DATA.katalog.veky) || [];
    for (var i = 0; i < seznamVeku.length; i++) {
      (function (vek) {
        veky.appendChild(tlacitkoVolby(vek.nazev, vzhled.vek === vek.id, function () {
          vzhled.vek = vek.id;
          vzhled.vyskaCm = Math.round((vek.vyska[0] + vek.vyska[1]) / 2);
          if (vek.id !== "dospely") vzhled.fousy = "";
          prekresli();
        }));
      })(seznamVeku[i]);
    }
    blok.appendChild(veky);

    var tela = el("div", "qkb-volby");
    tela.style.marginTop = "6px";
    var seznamTel = (DATA.katalog && DATA.katalog.tela) || [];
    for (var t2 = 0; t2 < seznamTel.length; t2++) {
      (function (telo) {
        tela.appendChild(tlacitkoVolby(telo.nazev, vzhled.telo === telo.id, function () {
          vzhled.telo = telo.id;
          prekresli();
        }));
      })(seznamTel[t2]);
    }
    blok.appendChild(tela);

    var vyskaObal = el("label");
    vyskaObal.style.display = "block";
    vyskaObal.style.marginTop = "8px";
    vyskaObal.style.fontSize = "12.5px";
    vyskaObal.appendChild(el("span", null, "Výška: " + vzhled.vyskaCm + " cm"));
    var vyska = el("input", "qkb-vyska");
    vyska.type = "range";
    var meze = null;
    for (var mv = 0; mv < seznamVeku.length; mv++) if (seznamVeku[mv].id === vzhled.vek) meze = seznamVeku[mv].vyska;
    vyska.min = meze ? meze[0] : 150;
    vyska.max = meze ? meze[1] : 200;
    vyska.value = vzhled.vyskaCm;
    vyska.addEventListener("input", function () {
      vzhled.vyskaCm = Number(vyska.value);
      var popis = vyskaObal.querySelector("span");
      if (popis) popis.textContent = "Výška: " + vzhled.vyskaCm + " cm";
      nakresli(platno, vzhled);
    });
    vyskaObal.appendChild(vyska);
    blok.appendChild(vyskaObal);

    /* vlasy a fousy */
    var vlasyDef = defVrstvy("vlasy");
    if (vlasyDef) {
      var vlasyObal = el("div", "qkb-kus");
      vlasyObal.appendChild(el("b", null, "Vlasy"));
      var vpravo = el("div");
      var varianty = el("div", "qkb-volby");
      for (var vv = 0; vv < vlasyDef.varianty.length; vv++) {
        (function (one) {
          varianty.appendChild(tlacitkoVolby(one.nazev, vzhled.vlasyVarianta === one.id, function () {
            vzhled.vlasyVarianta = one.id;
            prekresli();
          }));
        })(vlasyDef.varianty[vv]);
      }
      vpravo.appendChild(varianty);
      vpravo.appendChild(barvyRadek(vzhled.vlasyHex, function (hex) {
        vzhled.vlasyHex = hex;
        prekresli();
      }, (DATA.katalog && DATA.katalog.vlasy) || null));
      vlasyObal.appendChild(vpravo);
      blok.appendChild(vlasyObal);
    }

    var fousyDef = defVrstvy("fousy");
    if (fousyDef && vzhled.vek === "dospely") {
      var fousyObal = el("div", "qkb-kus");
      fousyObal.appendChild(el("b", null, "Fousy"));
      var fv = el("div", "qkb-volby");
      fv.appendChild(tlacitkoVolby("Bez fousů", !vzhled.fousy, function () {
        vzhled.fousy = "";
        prekresli();
      }));
      for (var f = 0; f < fousyDef.varianty.length; f++) {
        (function (one) {
          fv.appendChild(tlacitkoVolby(one.nazev, vzhled.fousy === one.id, function () {
            vzhled.fousy = one.id;
            prekresli();
          }));
        })(fousyDef.varianty[f]);
      }
      fousyObal.appendChild(fv);
      blok.appendChild(fousyObal);
    }
    kam.appendChild(blok);

    /*
     * Oblečení se dělí na dvě věci, a je to ten nejpodstatnější rozdíl
     * v celé kabině. **Tvůj oblek** je kulisa: zákazník si ji nastaví
     * přibližně podle toho, co má doma, aby viděl, na čem ten doplněk
     * bude. **Naše doplňky** jsou zboží: vybírá se konkrétní kus se svým
     * vzorem, ne odstín. Kdyby se obojí míchalo do jednoho seznamu,
     * zákazník by si naladil motýlka, který neexistuje.
     */
    var poradi = (DATA.katalog && DATA.katalog.poradi) || [];
    var kulisa = el("div", "qkb-blok");
    kulisa.appendChild(el("h3", null, "Tvůj oblek"));
    kulisa.appendChild(el("div", "qkb-sub", "Nastav přibližně to, co máš doma — ať je vidět, na čem doplněk bude."));
    var zbozi = el("div", "qkb-blok qkb-zbozi");
    zbozi.appendChild(el("h3", null, "Naše doplňky"));
    zbozi.appendChild(el("div", "qkb-sub", "Tohle si vybíráš doopravdy. Klepni na kus, který chceš vidět na modelu."));
    var mameZbozi = false;
    for (var pi = 0; pi < poradi.length; pi++) {
      var typ = poradi[pi];
      if (typ === "postava" || typ === "vlasy" || typ === "fousy") continue;
      var def = defVrstvy(typ);
      /*
       * Vrstva, která je zboží, ale nemá v katalogu jediný kus, se chová
       * jako kulisa — jinak by se nedala nastavit vůbec.
       */
      if (def && def.zbozi && maProdukty(typ)) {
        zbozi.appendChild(radekKusu(typ, true));
        mameZbozi = true;
      } else {
        kulisa.appendChild(radekKusu(typ, false));
      }
    }
    if (mameZbozi) kam.appendChild(zbozi);
    kam.appendChild(kulisa);

    /* --- uložené vzhledy --- */
    var ulozeneBlok = el("div", "qkb-blok");
    ulozeneBlok.appendChild(el("h3", null, "Uložené vzhledy"));
    var list = ulozene();
    if (!list.length) {
      ulozeneBlok.appendChild(el("div", "qkb-sub", "Zatím žádný. Ulož si ten, co se ti líbí, a zkus vedle něj druhý."));
    }
    var radaU = el("div", "qkb-ulozene");
    for (var u = 0; u < list.length; u++) {
      (function (zaznam, index) {
        var e = el("div", "qkb-ulozeny" + (srovnavam && srovnavam.__id === zaznam.id ? " on" : ""));
        var nacti = el("button", null, zaznam.nazev || ("Vzhled " + (index + 1)));
        nacti.title = "Otevřít tenhle vzhled";
        nacti.style.color = "#18181b";
        nacti.addEventListener("click", function () {
          var nacteny = zTextu(zaznam.text);
          if (nacteny) { vzhled = nacteny; prekresli(); }
        });
        var srovnej = el("button", null, "⇄");
        srovnej.title = "Postavit vedle toho, co mám teď";
        srovnej.addEventListener("click", function () {
          var druhy = zTextu(zaznam.text);
          if (!druhy) return;
          if (srovnavam && srovnavam.__id === zaznam.id) srovnavam = null;
          else { druhy.__id = zaznam.id; srovnavam = druhy; }
          vykresliNahled();
          prekresli();
        });
        var smaz = el("button", null, "×");
        smaz.title = "Smazat";
        smaz.addEventListener("click", function () {
          var zbytek = ulozene().filter(function (one) { return one.id !== zaznam.id; });
          zapisUlozene(zbytek);
          if (srovnavam && srovnavam.__id === zaznam.id) { srovnavam = null; vykresliNahled(); }
          prekresli();
        });
        e.appendChild(nacti);
        e.appendChild(srovnej);
        e.appendChild(smaz);
        radaU.appendChild(e);
      })(list[u], u);
    }
    ulozeneBlok.appendChild(radaU);
    var ulozit = el("button", "qkb-btn qkb-maly", "Uložit tenhle vzhled");
    ulozit.type = "button";
    ulozit.style.marginTop = "8px";
    ulozit.addEventListener("click", function () {
      var list2 = ulozene();
      var nazev = "Vzhled " + (list2.length + 1);
      list2.unshift({ id: String(Date.now()), nazev: nazev, text: doTextu(vzhled) });
      zapisUlozene(list2);
      hlaska("Uloženo jako " + nazev);
      prekresli();
    });
    ulozeneBlok.appendChild(ulozit);
    kam.appendChild(ulozeneBlok);
  }

  function radekKusu(typ, jeZbozi) {
    var def = defVrstvy(typ);
    var obal = el("div", "qkb-kus" + (jeZbozi ? " zbozi" : ""));
    obal.appendChild(el("b", null, def ? def.nazev : typ));
    var vpravo = el("div");
    var kus = vzhled.kusy[typ];

    var volby = el("div", "qkb-volby");
    if (def && def.nepovinna) {
      volby.appendChild(tlacitkoVolby("Bez", !kus, function () {
        delete vzhled.kusy[typ];
        prekresli();
      }));
    }
    var varianty = (def && def.varianty) || [];
    for (var i = 0; i < varianty.length; i++) {
      (function (one) {
        volby.appendChild(tlacitkoVolby(one.nazev, !!kus && kus.varianta === one.id, function () {
          var stare = vzhled.kusy[typ];
          vzhled.kusy[typ] = {
            varianta: one.id,
            hex: stare ? stare.hex : "#1f2d4d",
            produkt: ""
          };
          /* Po přepnutí na motýlka se vybere nejbližší motýlek, ne kravata */
          if (jeZbozi) {
            var prvni = nejblizsi(typ, stare ? stare.hex : "", one.id);
            if (prvni) {
              vzhled.kusy[typ].produkt = prvni.kod;
              vzhled.kusy[typ].hex = prvni.hex || vzhled.kusy[typ].hex;
            }
          } else if (stare) {
            vzhled.kusy[typ].produkt = stare.produkt;
          }
          prekresli();
        }));
      })(varianty[i]);
    }
    vpravo.appendChild(volby);

    if (kus && !jeZbozi) {
      vpravo.appendChild(barvyRadek(kus.hex, function (hex) {
        vzhled.kusy[typ].hex = hex;
        prekresli();
      }));
    }
    /*
     * Nabídka kusů je vidět **i když zákazník zatím nic nevybral** — je to
     * výloha, ne nastavení. Dokud se tu neukazovalo nic, dokud nebyl kus
     * vybraný, byla kabina pro doplňky prázdná a nebylo z čeho vybírat.
     */
    if (jeZbozi) {
      vpravo.appendChild(produktyMrizka(typ, kus, kus ? kus.varianta : (varianty[0] ? varianty[0].id : "")));
    }
    obal.appendChild(vpravo);
    return obal;
  }

  /*
   * Nabídka konkrétních kusů.
   *
   * Dlaždice s fotkou, ne rozbalovací seznam: zákazník si vybírá motýlka,
   * a ten se vybírá očima. Řadí se podle toho, jak barevně sedne k tomu,
   * co už na modelu je — kdo si naklikal námořnický oblek, hledá k němu
   * doplněk, ne abecedu.
   */
  function produktyMrizka(typ, kus, varianta) {
    var vuci = vzhled.kusy.sako || vzhled.kusy.vesta || vzhled.kusy.kosile;
    var nabidka = produktyKVrstve(typ, vuci ? ztmav(vuci.hex, 0.3) : "", varianta);
    var obal = el("div", "qkb-mrizka");
    if (!nabidka.length) {
      obal.appendChild(el("div", "qkb-sub", "V téhle variantě teď nic skladem nemáme."));
      return obal;
    }
    for (var i = 0; i < Math.min(24, nabidka.length); i++) {
      (function (p) {
        var e = el("button", "qkb-kousek" + (kus && kus.produkt === p.kod ? " on" : ""));
        e.type = "button";
        e.title = p.nazev + " · " + p.cena;
        if (p.obrazek || p.vzorek) {
          var img = el("img");
          img.src = p.obrazek || p.vzorek;
          img.alt = p.nazev;
          img.loading = "lazy";
          e.appendChild(img);
        } else {
          var flek = el("span", "qkb-flek");
          flek.style.background = p.hex || "#ddd";
          e.appendChild(flek);
        }
        e.appendChild(el("em", null, p.cena));
        e.addEventListener("click", function () {
          /* Klepnutím na kus se doplněk rovnou nasadí, i když tam žádný nebyl */
          vzhled.kusy[typ] = {
            varianta: p.varianta || varianta,
            hex: p.hex || "#808080",
            produkt: p.kod
          };
          prekresli();
        });
        obal.appendChild(e);
      })(nabidka[i]);
    }
    /*
     * Jméno a cena jen u toho, co je **opravdu vybrané**. Dřív se tu
     * ukazoval první kus z nabídky i tehdy, když si zákazník nevybral nic,
     * a vypadalo to, že ho na modelu má.
     */
    var vybrany = kus ? produkt(kus.produkt) : null;
    if (vybrany) {
      var popis = el("div", "qkb-vybrany");
      popis.appendChild(el("b", null, vybrany.nazev));
      popis.appendChild(el("span", null, " " + vybrany.cena));
      var odkaz = el("a", null, "Otevřít produkt");
      odkaz.href = vybrany.url;
      odkaz.target = "_blank";
      odkaz.rel = "noopener";
      popis.appendChild(odkaz);
      obal.appendChild(popis);
    }
    return obal;
  }

  /* --------------------------------------------------------- pata */

  function vybraneProdukty() {
    var out = [];
    var vse = (DATA && DATA.produkty) || [];
    for (var typ in vzhled.kusy) {
      if (!Object.prototype.hasOwnProperty.call(vzhled.kusy, typ)) continue;
      var kod = vzhled.kusy[typ].produkt;
      if (!kod) continue;
      for (var i = 0; i < vse.length; i++) if (vse[i].kod === kod) out.push(vse[i]);
    }
    return out;
  }

  function vykresliPatu() {
    var pata = okno.querySelector(".qkb-pata");
    pata.innerHTML = "";
    var produkty = vybraneProdukty();
    var suma = 0;
    for (var i = 0; i < produkty.length; i++) suma += produkty[i].cenaCislo || 0;

    var popis = el("div", "qkb-suma", produkty.length
      ? cena(suma) + " za " + produkty.length + (produkty.length === 1 ? " kus" : produkty.length < 5 ? " kusy" : " kusů")
      : "Zatím bez produktů");
    pata.appendChild(popis);

    var doKos = el("button", "qkb-btn plne", "Vložit celý vzhled do košíku");
    doKos.type = "button";
    doKos.disabled = produkty.length === 0;
    doKos.addEventListener("click", function () { vlozVse(produkty, doKos); });
    pata.appendChild(doKos);

    var mail = el("button", "qkb-btn", "Poslat si na mail");
    mail.type = "button";
    mail.addEventListener("click", function () {
      var odkaz = location.origin + location.pathname + "?kabina=" + encodeURIComponent(doTextu(vzhled));
      var telo = "Tenhle vzhled jsem si složil na quentino.cz:\n\n" + odkaz + "\n\n";
      for (var i = 0; i < produkty.length; i++) {
        telo += "- " + produkty[i].nazev + " (" + produkty[i].cena + ")\n";
      }
      location.href = "mailto:?subject=" + encodeURIComponent("Můj vzhled z Quentina")
        + "&body=" + encodeURIComponent(telo);
    });
    pata.appendChild(mail);

    var obrazekBtn = el("button", "qkb-btn", "Stáhnout obrázek");
    obrazekBtn.type = "button";
    obrazekBtn.addEventListener("click", function () {
      try {
        var odkaz = document.createElement("a");
        odkaz.download = "quentino-vzhled.png";
        odkaz.href = platno.toDataURL("image/png");
        odkaz.click();
      } catch (e) { hlaska("Obrázek se nepodařilo uložit."); }
    });
    pata.appendChild(obrazekBtn);

    /*
     * Že poradíme i osobně, má být vidět pořád. Kdo si v kabině není
     * jistý, je přesně ten, kdo zavolá — a pak koupí.
     */
    var osobne = el("div", "qkb-osobne");
    var kontakt = KONTAKT && KONTAKT.text ? KONTAKT : { text: "Nevíte si rady? Rádi poradíme osobně.", telefon: "", mail: "" };
    osobne.appendChild(el("span", null, kontakt.text + " "));
    if (kontakt.telefon) {
      var tel = el("a", null, kontakt.telefon);
      tel.href = "tel:" + String(kontakt.telefon).replace(/\s/g, "");
      osobne.appendChild(tel);
    }
    if (kontakt.mail) {
      osobne.appendChild(el("span", null, kontakt.telefon ? " · " : ""));
      var m = el("a", null, kontakt.mail);
      m.href = "mailto:" + kontakt.mail;
      osobne.appendChild(m);
    }
    pata.appendChild(osobne);
  }

  /*
   * Do košíku se kusy přidávají na pozadí, jeden po druhém, adresou
   * e-shopu — žádné vlastní rozhraní, takže se nemá co rozejít s tím,
   * co dělá tlačítko na stránce produktu. Kus, který má velikosti, se
   * takhle přidat nedá: velikost se v adrese nepředává a přidala by se
   * jiná, než zákazník chce. U těch se proto otevře detail produktu.
   */
  function vlozVse(produkty, tlacitko) {
    var rovnou = [];
    var sVelikosti = [];
    for (var i = 0; i < produkty.length; i++) {
      var kam = doKosiku(produkty[i], 1);
      if (kam.rovnou) rovnou.push(kam.url);
      else sVelikosti.push(produkty[i]);
    }
    tlacitko.disabled = true;
    tlacitko.textContent = "Vkládám…";
    var postupne = rovnou.reduce(function (retez, url) {
      return retez.then(function () {
        return fetch(url, { credentials: "same-origin" }).catch(function () { return null; });
      });
    }, Promise.resolve());
    postupne.then(function () {
      tlacitko.disabled = false;
      tlacitko.textContent = "Vložit celý vzhled do košíku";
      if (sVelikosti.length) {
        hlaska(rovnou.length
          ? rovnou.length + " v košíku. U zbytku vyber velikost."
          : "Vyber velikost, ať přijde ta správná.");
        vyberVelikost(sVelikosti);
      } else {
        hlaska(rovnou.length + " kusů v košíku.");
      }
    });
  }

  function vyberVelikost(produkty) {
    var kam = okno.querySelector(".qkb-ovladani");
    var blok = el("div", "qkb-blok");
    blok.appendChild(el("h3", null, "Zbývá vybrat velikost"));
    for (var i = 0; i < produkty.length; i++) {
      (function (p) {
        var e = el("div", "qkb-produkt");
        e.appendChild(el("div", "qkb-pnazev", p.nazev));
        var jdi = el("a", "qkb-btn qkb-maly", "Vybrat velikost");
        jdi.href = p.url;
        jdi.style.marginLeft = "auto";
        e.appendChild(jdi);
        blok.appendChild(e);
      })(produkty[i]);
    }
    kam.insertBefore(blok, kam.firstChild);
    kam.scrollTop = 0;
  }

  /* -------------------------------------------------------- náhled */

  function vykresliNahled() {
    var kam = okno.querySelector(".qkb-nahled");
    kam.innerHTML = "";
    if (srovnavam) {
      var dvojice = el("div", "qkb-srovnani");
      var a = document.createElement("figure");
      platno = document.createElement("canvas");
      a.appendChild(platno);
      a.appendChild(el("figcaption", null, "Teď skládáš"));
      var b = document.createElement("figure");
      var druhe = document.createElement("canvas");
      druhe.className = "qkb-srovnani-b";
      b.appendChild(druhe);
      b.appendChild(el("figcaption", null, "Uložený vzhled"));
      dvojice.appendChild(a);
      dvojice.appendChild(b);
      kam.appendChild(dvojice);
    } else {
      platno = document.createElement("canvas");
      kam.appendChild(platno);
    }
  }

  /* --------------------------------------------------------- otevření */

  function otevri(predvolba) {
    if (okno) { okno.parentNode.style.display = "flex"; return; }
    var styl = document.createElement("style");
    styl.textContent = STYL;
    document.head.appendChild(styl);

    var pozadi = el("div", "qkb-pozadi");
    okno = el("div", "qkb");
    okno.setAttribute("role", "dialog");
    okno.setAttribute("aria-label", "Zkušební kabina");

    var hlava = el("div", "qkb-hlava");
    var nadpis = el("div");
    nadpis.appendChild(el("h2", null, "Zkušební kabina"));
    nadpis.appendChild(el("div", "qkb-sub", "Poskládej si celý vzhled a podívej se, jak sedne."));
    hlava.appendChild(nadpis);
    var zavri = el("button", "qkb-x", "×");
    zavri.type = "button";
    zavri.setAttribute("aria-label", "Zavřít");
    zavri.addEventListener("click", function () { pozadi.style.display = "none"; });
    hlava.appendChild(zavri);
    okno.appendChild(hlava);

    var telo = el("div", "qkb-telo");
    telo.appendChild(el("div", "qkb-nahled"));
    telo.appendChild(el("div", "qkb-ovladani"));
    okno.appendChild(telo);
    okno.appendChild(el("div", "qkb-pata"));

    pozadi.appendChild(okno);
    pozadi.addEventListener("click", function (e) {
      if (e.target === pozadi) pozadi.style.display = "none";
    });
    document.body.appendChild(pozadi);
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && okno && okno.parentNode.style.display !== "none") {
        okno.parentNode.style.display = "none";
      }
    });

    okno.querySelector(".qkb-nahled").appendChild(el("div", "qkb-sub", "Načítám…"));

    nactiData().then(function () {
      vzhled = predvolba || zAdresy() || vychozi();
      vykresliNahled();
      prekresli();
    }).catch(function () {
      okno.querySelector(".qkb-nahled").innerHTML = "";
      okno.querySelector(".qkb-nahled").appendChild(
        el("div", "qkb-sub", "Kabinu se teď nepodařilo načíst. Zkuste to prosím za chvíli.")
      );
    });
  }

  function zAdresy() {
    var shoda = /[?&]kabina=([^&]+)/.exec(location.search);
    if (!shoda) return null;
    try { return zTextu(decodeURIComponent(shoda[1])); } catch (e) { return null; }
  }

  /*
   * Co kabinu otevírá. Hledá se až při kliknutí kamkoli na stránce, ne
   * při načtení — stránka se tím nedotkne a vyhledávač uvidí přesně to,
   * co bez kabiny.
   */
  document.addEventListener("click", function (e) {
    var cil = e.target;
    while (cil && cil !== document.body) {
      if (cil.hasAttribute && (cil.hasAttribute("data-quentino-kabina")
        || (cil.className && String(cil.className).indexOf("quentino-kabina") >= 0))) {
        e.preventDefault();
        var predvolba = null;
        var text = cil.getAttribute("data-quentino-vzhled");
        if (text) predvolba = zTextu(text);
        otevri(predvolba);
        return;
      }
      cil = cil.parentNode;
    }
  }, false);

  /* Odkaz z mailu otevře kabinu rovnou s tím vzhledem */
  if (/[?&]kabina=/.test(location.search)) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", function () { otevri(null); });
    } else {
      otevri(null);
    }
  }

  window.quentinoKabina = { otevri: otevri };
})();
</script>
`;

/** Komentáře a odsazení pryč — pole pro skript v administraci má strop. */
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

export interface KabinaVstup {
  /** Adresa souboru s postavami, vrstvami a produkty. */
  zdroj: string;
  /** Jak dlouho stačí uložená kopie, v sekundách. */
  ttl: number;
  kontakt: { text: string; telefon: string; mail: string };
}

export function kabinaScript(vstup: KabinaVstup): string {
  const zdroj = String(vstup.zdroj ?? '').trim();
  const ttl = Math.max(30, Math.min(86400, Math.round(Number(vstup.ttl)) || 900));
  const kontakt = JSON.stringify(vstup.kontakt ?? { text: '', telefon: '', mail: '' });
  return bezKomentaru(TEMPLATE)
    .split(KONTAKT_MARK).join(kontakt)
    .split(ZDROJ_MARK).join(zdroj)
    .split(TTL_MARK).join(String(ttl))
    .trim();
}

export const __test = { ZDROJ_MARK, TTL_MARK, KONTAKT_MARK, bezKomentaru };
