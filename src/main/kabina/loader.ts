/**
 * Zavaděč kabiny — to jediné, co se vkládá do šablony e-shopu.
 *
 * ## Proč je kabina rozdělená na dva kusy
 *
 * Celá kabina má po odmazání komentářů kolem čtyřiceti kilobajtů. Kdyby
 * se vložila do šablony, nesla by si ji **každá stránka e-shopu**, včetně
 * těch, kde nikdo kabinu neotevře — a tedy i stránka, kterou si měří
 * Google. Zadání znělo, že to nesmí brzdit načítání ani zhoršit hodnocení.
 *
 * V šabloně je proto jen tohle: pár kilobajtů, které umí tři věci —
 * přidat tlačítka, poznat minimalizovanou kabinu a na kliknutí dotáhnout
 * zbytek. Dokud zákazník neklikne, nestáhne se nic.
 *
 * ## Proč se tlačítka přidávají až po načtení
 *
 * Do stránky se sahá v `requestIdleCallback`, tedy až když prohlížeč
 * nemá co dělat. Vyhledávač vidí stránku, jaká byla; zákazník vidí
 * tlačítko dřív, než stihne dočíst popis. A protože výpis produktů se
 * dotahuje po částech (tlačítko „DALŠÍ"), hlídá se i přírůstek — jinak
 * by druhá dvacítka produktů tlačítko neměla.
 *
 * ## Proč se produkt čte ze stránky a ne z našich dat
 *
 * Zákazník kliká u produktu, který právě vidí. Jeho adresu a číslo má
 * stránka u sebe — v kartě jako `data-product-id` a `data-href`,
 * v detailu ve skrytých polích formuláře košíku. Tím se produkt najde
 * v našem seznamu a tím se taky dá vložit do košíku i s velikostí, což
 * samotná adresa neumí.
 *
 * ## Pozor při úpravách
 *
 * Text je `String.raw`: nesmí v něm být zpětný apostrof ani dolar se
 * složenou závorkou. Řetězce se spojují plusem.
 */

const SKRIPT_MARK = '__QUENTINO_KABINA_SKRIPT__';
const VYBER_MARK = '"__QUENTINO_KABINA_VYBER__"';

/**
 * Kde na stránce e-shopu co je.
 *
 * Výchozí hodnoty jsou odečtené z quentino.cz (šablona Upgates): karta
 * ve výpisu je `article.card-item` s `data-product-id` a `data-href`,
 * obrázek v ní je odkaz `a.p-i-media`, a v detailu je formulář
 * `form#frm-productForm` se skrytým `product_id` a tlačítkem
 * `.AddToCartButton`. Kdyby se šablona změnila, přepíše se to
 * v nastavení aplikace a skript v šabloně zůstane, jak je.
 */
export interface KabinaVyber {
  /** Kam v detailu produktu vedle tlačítka do košíku. */
  detail: string[];
  /** Karta produktu ve výpisu. */
  karta: string[];
  /** Obrázek v kartě — nad něj se dává decentní tlačítko. */
  kartaObrazek: string[];
  /** Kde na stránce jsou související produkty. */
  souvisejici: string[];
}

export const VYCHOZI_VYBER: KabinaVyber = {
  detail: [
    'form#frm-productForm .pd-add-to-cart .AddToCart',
    '.pd-add-to-cart .AddToCart',
    '.pd-order-buttons .AddToCart',
    'form .AddToCartButton'
  ],
  karta: [
    'article.card-item[data-product-id]',
    '.card-item[data-product-id]',
    '[data-product-id].p-i'
  ],
  kartaObrazek: ['a.p-i-media', '.p-i-media'],
  souvisejici: [
    '#snippet--relatedProducts',
    '.pd-related',
    '.products-related',
    '.RelatedProducts'
  ]
};

const TEMPLATE = String.raw`
<script>
/* Quentino — zkušební kabina, zavaděč. Celá kabina se stáhne až na kliknutí. */
(function () {
  "use strict";
  if (window.__quentinoKabinaZavadec) return;
  window.__quentinoKabinaZavadec = true;

  var SKRIPT = "__QUENTINO_KABINA_SKRIPT__";
  var VYBER = "__QUENTINO_KABINA_VYBER__";
  var STAV_KLIC = "quentino-kabina-stav";

  /* --------------------------------------------------------- jazyk */

  function jazyk() {
    var kod = (document.documentElement.getAttribute("lang") || "").toLowerCase();
    var host = location.hostname.toLowerCase();
    if (kod.indexOf("cs") === 0 || kod.indexOf("cz") === 0) return "cz";
    if (kod.indexOf("sk") === 0) return "sk";
    if (host.indexOf(".cz") > 0) return "cz";
    if (host.indexOf(".sk") > 0) return "sk";
    return "en";
  }

  var SLOVA = {
    cz: { zkusit: "Vyzkoušet na modelu", karta: "Zkusit na modelu", kabina: "Zkušební kabina" },
    sk: { zkusit: "Vyskúšať na modeli", karta: "Skúsiť na modeli", kabina: "Skúšobná kabína" },
    en: { zkusit: "See it on the model", karta: "Try on model", kabina: "Fitting room" }
  };
  var JAZYK = jazyk();
  function slovo(klic) { return (SLOVA[JAZYK] || SLOVA.cz)[klic] || SLOVA.cz[klic]; }

  /* ------------------------------------------------- dotažení kabiny */

  var nacitam = null;

  function nactiKabinu() {
    if (window.quentinoKabina) return Promise.resolve(window.quentinoKabina);
    if (nacitam) return nacitam;
    nacitam = new Promise(function (hotovo, chyba) {
      var s = document.createElement("script");
      s.src = SKRIPT;
      s.async = true;
      s.onload = function () {
        if (window.quentinoKabina) hotovo(window.quentinoKabina);
        else chyba(new Error("kabina se nenačetla"));
      };
      s.onerror = function () { nacitam = null; chyba(new Error("kabina se nenačetla")); };
      document.head.appendChild(s);
    });
    return nacitam;
  }

  /*
   * Čekání se ukazuje na tlačítku, na které se kliklo.
   *
   * Kabina se stahuje po kliknutí, takže mezi kliknutím a oknem je
   * zlomek sekundy až dvě na pomalém mobilu. Bez odezvy to vypadá, že
   * tlačítko nefunguje, a zákazník klikne ještě dvakrát.
   */
  function sCekanim(tlacitko, co) {
    if (tlacitko) tlacitko.setAttribute("data-qkb-ceka", "1");
    return co().then(function (k) {
      if (tlacitko) tlacitko.removeAttribute("data-qkb-ceka");
      return k;
    }).catch(function (e) {
      if (tlacitko) tlacitko.removeAttribute("data-qkb-ceka");
      throw e;
    });
  }

  function otevri(produkt, tlacitko) {
    sCekanim(tlacitko, nactiKabinu).then(function (k) {
      if (produkt) k.pridej(produkt);
      else k.otevri(null);
    }).catch(function () {
      /* Když se kabina nestáhne, zákazník nemá zůstat u ničeho:
         u produktu je pořád jeho stránka a ta funguje bez nás */
      if (produkt && produkt.url) location.href = produkt.url;
    });
  }

  /* ------------------------------------------------ čtení ze stránky */

  function prvni(seznam, kde) {
    for (var i = 0; i < seznam.length; i++) {
      var found = (kde || document).querySelector(seznam[i]);
      if (found) return found;
    }
    return null;
  }

  function text(el) { return el ? String(el.textContent || "").replace(/\s+/g, " ").trim() : ""; }

  function naplno(url) {
    if (!url) return "";
    try { return new URL(url, location.href).href; } catch (e) { return url; }
  }

  /** Produkt z karty ve výpisu. */
  function zKarty(karta) {
    var odkaz = karta.getAttribute("data-href") || "";
    if (!odkaz) {
      var a = karta.querySelector("a[href]");
      odkaz = a ? a.getAttribute("href") || "" : "";
    }
    var obrazek = karta.querySelector("img");
    return {
      id: karta.getAttribute("data-product-id") || "",
      url: naplno(odkaz || ""),
      nazev: text(karta.querySelector(".p-i-header")) || text(karta.querySelector("h4, h3, h2")),
      cena: text(karta.querySelector(".price-main")),
      obrazek: obrazek ? obrazek.getAttribute("src") || "" : ""
    };
  }

  /** Produkt z detailu — i s číslem, které potřebuje košík. */
  function zDetailu() {
    var id = document.querySelector("input[name='product_id']");
    if (!id || !id.value) return null;
    var obrazek = document.querySelector(".pd-gallery img, .p-detail img, main img");
    return {
      id: id.value,
      url: naplno(location.pathname),
      nazev: text(document.querySelector("h1")),
      cena: text(prvni([".pd-prices .price-main", ".price-main"])),
      obrazek: obrazek ? obrazek.getAttribute("src") || "" : "",
      /* Prázdné pole znamená „produkt bez variant"; s variantami je
         v něm id té vybrané a vložení do košíku se bez něj netrefí */
      optionSet: (document.querySelector("input[name='option_set_id']") || {}).value || ""
    };
  }

  /**
   * Související produkty — nabídka „co k tomu" uvnitř kabiny.
   *
   * Nebere se z našich dat, ale ze stránky: e-shop už jednou rozhodl,
   * co k tomuhle produktu patří, a to rozhodnutí je lepší než barevná
   * blízkost. Když na stránce nic takového není, kabina si vystačí se
   * svým poradcem.
   */
  function souvisejici() {
    var kde = prvni(VYBER.souvisejici);
    if (!kde) return [];
    var karty = [];
    for (var i = 0; i < VYBER.karta.length && karty.length === 0; i++) {
      karty = [].slice.call(kde.querySelectorAll(VYBER.karta[i]));
    }
    return karty.slice(0, 12).map(zKarty).filter(function (p) { return !!p.url; });
  }

  /* --------------------------------------------------------- tlačítka */

  /*
   * Vlastní předpona tříd. Kabina má svoje .qkb-*, zavaděč .qkbz-* —
   * a jsou na stránce obě naráz. Když se obojí jmenovalo stejně, stylovala
   * se karta produktu v kabině jako tlačítko nad obrázkem ve výpisu.
   */
  var STYL = "[data-qkb-ceka]{opacity:.6;pointer-events:none}"
    + ".qkbz-vlozit{display:inline-flex;align-items:center;justify-content:center;gap:7px;"
    + "width:100%;margin-top:8px;padding:11px 14px;border-radius:9px;cursor:pointer;"
    + "border:1px solid currentColor;background:transparent;color:inherit;"
    + "font:inherit;font-size:15px;line-height:1.2;text-align:center}"
    + ".qkbz-vlozit:hover{background:rgba(0,0,0,.05)}"
    + ".qkbz-obal{position:relative;display:block;width:100%}"
    + ".qkbz-karta{position:absolute;right:8px;bottom:8px;z-index:3;display:inline-flex;"
    + "align-items:center;gap:6px;max-width:calc(100% - 16px);padding:7px 10px;border:0;"
    + "border-radius:999px;background:rgba(255,255,255,.94);color:#18181b;cursor:pointer;"
    + "font:inherit;font-size:12px;line-height:1;box-shadow:0 1px 6px rgba(0,0,0,.18);"
    + "opacity:0;transform:translateY(4px);transition:opacity .16s,transform .16s}"
    + ".qkbz-obal:hover .qkbz-karta,.qkbz-karta:focus-visible{opacity:1;transform:none}"
    + ".qkbz-karta span{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}"
    + "@media (hover:none){.qkbz-karta{opacity:.92;transform:none;padding:8px;font-size:0}"
    + ".qkbz-karta span{display:none}}"
    + ".qkbz-bublina{position:fixed;left:14px;bottom:14px;z-index:99998;display:inline-flex;"
    + "align-items:center;gap:8px;padding:10px 14px;border:0;border-radius:999px;"
    + "background:#18181b;color:#fff;cursor:pointer;font:inherit;font-size:14px;"
    + "box-shadow:0 6px 20px rgba(0,0,0,.28)}"
    + "html[data-qkb-otevreno] .qkbz-bublina{display:none}"
    + ".qkbz-bublina b{display:inline-flex;align-items:center;justify-content:center;"
    + "min-width:20px;height:20px;padding:0 5px;border-radius:999px;background:#fff;"
    + "color:#18181b;font-size:12px}"
    + "@media print{.qkbz-vlozit,.qkbz-karta,.qkbz-bublina{display:none}}";

  var stylVlozen = false;
  function styl() {
    if (stylVlozen) return;
    stylVlozen = true;
    var s = document.createElement("style");
    s.setAttribute("data-qkb", "styl");
    s.textContent = STYL;
    document.head.appendChild(s);
  }

  /* Panáček — jedna ikona pro všechna tlačítka, ať se nestahuje obrázek */
  var IKONA = "<svg width='16' height='16' viewBox='0 0 16 16' aria-hidden='true' focusable='false'>"
    + "<circle cx='8' cy='2.6' r='2' fill='currentColor'></circle>"
    + "<path d='M3.4 7.2c0-1.5 2-2.4 4.6-2.4s4.6.9 4.6 2.4l-.6 3h-1.5l-.4 5.1H5.3L4.9 10.2H3.4z'"
    + " fill='currentColor'></path></svg>";

  function tlacitko(trida, popis, text) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = trida;
    b.setAttribute("data-qkb", "1");
    b.setAttribute("title", popis);
    b.setAttribute("aria-label", popis);
    b.innerHTML = IKONA + "<span></span>";
    b.lastChild.textContent = text || "";
    return b;
  }

  function doDetailu() {
    var produkt = zDetailu();
    if (!produkt) return;
    var kam = prvni(VYBER.detail);
    if (!kam || kam.querySelector("[data-qkb]")) return;
    styl();
    var b = tlacitko("qkbz-vlozit", slovo("zkusit"), slovo("zkusit"));
    b.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      produkt.souvisejici = souvisejici();
      otevri(produkt, b);
    });
    kam.appendChild(b);
  }

  /**
   * Tlačítko do karty ve výpisu.
   *
   * Karta je celá klikací a obrázek v ní je odkaz, takže tlačítko
   * **nemůže** být v tom odkazu — kliknutí by odešlo na produkt.
   * Obrázek se proto obalí a tlačítko leží nad ním.
   */
  function doKarty(karta) {
    if (karta.getAttribute("data-qkb-hotovo")) return;
    var obrazek = prvni(VYBER.kartaObrazek, karta);
    if (!obrazek) return;
    var produkt = zKarty(karta);
    if (!produkt.url) return;
    karta.setAttribute("data-qkb-hotovo", "1");
    styl();
    var obal = obrazek.parentNode;
    if (!obal || String(obal.className || "").indexOf("qkbz-obal") < 0) {
      obal = document.createElement("div");
      obal.className = "qkbz-obal";
      obrazek.parentNode.insertBefore(obal, obrazek);
      obal.appendChild(obrazek);
    }
    var b = tlacitko("qkbz-karta", slovo("karta"), slovo("karta"));
    b.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      otevri(produkt, b);
    });
    obal.appendChild(b);
  }

  function doVypisu() {
    for (var i = 0; i < VYBER.karta.length; i++) {
      var karty = document.querySelectorAll(VYBER.karta[i]);
      for (var j = 0; j < karty.length; j++) doKarty(karty[j]);
      if (karty.length) return;
    }
  }

  /* --------------------------------------------- minimalizovaná kabina */

  function stav() {
    try {
      var raw = localStorage.getItem(STAV_KLIC);
      if (!raw) return null;
      var s = JSON.parse(raw);
      return s && s.kusu > 0 ? s : null;
    } catch (e) { return null; }
  }

  var bublinaEl = null;
  function bublina() {
    var s = stav();
    if (!s) {
      if (bublinaEl && bublinaEl.parentNode) bublinaEl.parentNode.removeChild(bublinaEl);
      bublinaEl = null;
      return;
    }
    if (bublinaEl) {
      bublinaEl.querySelector("b").textContent = String(s.kusu);
      return;
    }
    styl();
    bublinaEl = document.createElement("button");
    bublinaEl.type = "button";
    bublinaEl.className = "qkbz-bublina";
    bublinaEl.setAttribute("data-qkb", "1");
    bublinaEl.setAttribute("aria-label", slovo("kabina"));
    bublinaEl.innerHTML = IKONA + "<span></span><b></b>";
    bublinaEl.querySelector("span").textContent = slovo("kabina");
    bublinaEl.querySelector("b").textContent = String(s.kusu);
    bublinaEl.addEventListener("click", function () { otevri(null, bublinaEl); });
    document.body.appendChild(bublinaEl);
  }

  /*
   * Kabina si po zavření uloží, co v ní zákazník nechal, a zavaděč to
   * na každé další stránce ukáže jako bublinu. Proto to umí i zavaděč:
   * bublina musí být i tam, kde se kabina ještě nestáhla.
   */
  window.addEventListener("storage", function (e) {
    if (e.key === STAV_KLIC) bublina();
  });
  window.__quentinoKabinaStav = bublina;

  /* ------------------------------------------------------------ start */

  function zacni() {
    try { doDetailu(); } catch (e) { /* tlačítko navíc nesmí rozbít stránku */ }
    try { doVypisu(); } catch (e) { /* totéž ve výpisu */ }
    try { bublina(); } catch (e) { /* ani bublina */ }
    /*
     * Výpis se dotahuje po částech a filtry překreslují celé bloky, takže
     * jednorázové projití nestačí. Hlídá se přírůstek, ale ne hned:
     * během dotažení dvaceti karet přijde dvacet změn a dvacetkrát
     * projít stránku je zdržení, které se na mobilu pozná.
     */
    if (!window.MutationObserver) return;
    var cekani = null;
    new MutationObserver(function () {
      if (cekani) return;
      cekani = setTimeout(function () {
        cekani = null;
        try { doVypisu(); } catch (e) { /* nic */ }
        /*
         * I detail: při přepnutí velikosti si e-shop překreslí celý blok
         * s košíkem a naše tlačítko z něj zmizí. Je to levné — jakmile
         * tam tlačítko je, funkce hned skončí.
         */
        try { doDetailu(); } catch (e) { /* nic */ }
      }, 250);
    }).observe(document.body, { childList: true, subtree: true });
  }

  function poKlidu() {
    if (window.requestIdleCallback) requestIdleCallback(zacni, { timeout: 2500 });
    else setTimeout(zacni, 600);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", poKlidu);
  } else {
    poKlidu();
  }

  /* Ruční tlačítko kdekoli v šabloně: data-quentino-kabina */
  document.addEventListener("click", function (e) {
    var cil = e.target;
    while (cil && cil !== document.body) {
      if (cil.getAttribute && (cil.getAttribute("data-quentino-kabina") !== null
        || String(cil.className || "").indexOf("quentino-kabina") >= 0)) {
        e.preventDefault();
        var predvolba = cil.getAttribute("data-quentino-vzhled");
        nactiKabinu().then(function (k) { k.otevri(predvolba || null); }).catch(function () { /* nic */ });
        return;
      }
      cil = cil.parentNode;
    }
  }, false);
})();
</script>
`;

export interface KabinaLoaderVstup {
  /** Adresa souboru s kabinou. */
  skript: string;
  /** Přepsané části výběru — co se v šabloně jmenuje jinak. */
  vyber?: Partial<KabinaVyber>;
}

/** Komentáře a odsazení pryč — pole pro skript v administraci má strop. */
export function bezKomentaru(text: string): string {
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

export function kabinaLoader(vstup: KabinaLoaderVstup): string {
  const vyber: KabinaVyber = {
    detail: vstup.vyber?.detail?.length ? vstup.vyber.detail : VYCHOZI_VYBER.detail,
    karta: vstup.vyber?.karta?.length ? vstup.vyber.karta : VYCHOZI_VYBER.karta,
    kartaObrazek: vstup.vyber?.kartaObrazek?.length ? vstup.vyber.kartaObrazek : VYCHOZI_VYBER.kartaObrazek,
    souvisejici: vstup.vyber?.souvisejici?.length ? vstup.vyber.souvisejici : VYCHOZI_VYBER.souvisejici
  };
  return bezKomentaru(TEMPLATE)
    .split(VYBER_MARK).join(JSON.stringify(vyber))
    .split(SKRIPT_MARK).join(String(vstup.skript ?? '').trim())
    .trim();
}

export const __test = { SKRIPT_MARK, VYBER_MARK, bezKomentaru };
