/*
 * Okna nástrojů — zkouška v prohlížeči.
 *
 * Z kódu se nepozná to podstatné: že se nástroj v samostatném okně vůbec
 * vykreslí (rozhoduje o tom text za mřížkou v adrese), že vyplní celou
 * plochu místo aby zůstal plovoucím panelem se stínem uprostřed prázdna,
 * a že nabídka Funkcí v hlavním okně nástroj skutečně otevře oknem, ne
 * překryvem přes poštu.
 *
 * Okna aplikace prohlížeč neotevírá, takže `tool:open` jen zaznamená stub
 * a tady se kontroluje, že o ně rozhraní řeklo tomu správnému kanálu.
 *
 *   npm run build:renderer && node tools/preview-okna.mjs
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const ROOT = new URL('../dist/renderer/', import.meta.url).pathname;

/*
 * Skript, který na e-shopu kreslí bannery. Do náhledu se vkládá **ten
 * skutečný**, vypsaný hlavním procesem — kdyby si okno v náhledu kreslilo
 * vlastní zjednodušenou podobu, neověřilo by se nic z toho, proč živý
 * náhled vůbec je.
 */
let BANNER_SCRIPT = '';
try {
  const require = createRequire(import.meta.url);
  BANNER_SCRIPT = require('../dist/ptdist/main/bannerscript.js')
    .bannerScript({ url: '', ttl: 300, fallback: null });
} catch {
  console.log('bannerscript není přeložený — náhled bannerů bude prázdný');
}
const SHOTS = new URL('./shots/', import.meta.url).pathname;

/*
 * Zkušební kabina. Do náhledu i do zkoušky jde **ten skutečný skript**,
 * který se vkládá do e-shopu — kdyby si zkouška kreslila vlastní
 * napodobeninu, neověřila by nic z toho, proč kabina vůbec je.
 *
 * Vrstvy jsou schválně vyrobené tady: mapa světla s polotónem přesně
 * 128 na známém místě. Jen tak jde změřit to podstatné — že zvolená
 * barva vyjde na plátně **přesně** tak, jak si ji zákazník vybral.
 */
let KABINA_SCRIPT = '';
let KABINA_ZAVADEC = '';
let KABINA_DATA = '{}';
try {
  const require2 = createRequire(import.meta.url);
  const png = require2('../dist/ptdist/main/zkusebna/png.js');
  KABINA_SCRIPT = require2('../dist/ptdist/main/kabina/script.js').kabinaScript({
    zdroj: '/kabina-data.json', ttl: 30
  });
  /* Zavaděč je to, co se vkládá do šablony — tlačítka u produktů dělá on */
  KABINA_ZAVADEC = require2('../dist/ptdist/main/kabina/loader.js').kabinaLoader({
    skript: '/kabina.js'
  });
  const SIRKA = 200;
  const VYSKA = 400;
  const vrstva = (kresli) => {
    const obraz = png.novyObraz(SIRKA, VYSKA);
    kresli((x, y, r, g, b, a) => {
      const i = (y * SIRKA + x) * 4;
      obraz.body[i] = r; obraz.body[i + 1] = g; obraz.body[i + 2] = b; obraz.body[i + 3] = a;
    });
    return 'data:image/png;base64,' + png.uloz(obraz).toString('base64');
  };
  /* Vzorek látky: kostka, ať je poznat, že se na modelu dláždí vzor */
  const vzorekUrl = (a, b) => {
    const strana = 16;
    const obraz = png.novyObraz(strana, strana);
    for (let y = 0; y < strana; y++) {
      for (let x = 0; x < strana; x++) {
        const i = (y * strana + x) * 4;
        const barva = ((x >> 2) + (y >> 2)) % 2 ? a : b;
        obraz.body[i] = barva[0]; obraz.body[i + 1] = barva[1];
        obraz.body[i + 2] = barva[2]; obraz.body[i + 3] = 255;
      }
    }
    return 'data:image/png;base64,' + png.uloz(obraz).toString('base64');
  };
  const postavaUrl = vrstva(set => {
    for (let y = 20; y < 380; y++) for (let x = 70; x < 130; x++) set(x, y, 206, 170, 142, 255);
  });
  /* Mapa světla: polotón 128 uprostřed, po krajích záhyb a odlesk */
  const mapa = (odY, doY, odX, doX) => vrstva(set => {
    for (let y = odY; y < doY; y++) {
      for (let x = odX; x < doX; x++) {
        const kraj = Math.abs(x - (odX + doX) / 2) / ((doX - odX) / 2);
        const stin = kraj > 0.8 ? 80 : kraj > 0.55 ? 180 : 128;
        set(x, y, stin, stin, stin, 255);
      }
    }
  });
  const katalogVrstvy = require2('../dist/ptdist/shared/zkusebna.js');
  KABINA_DATA = JSON.stringify({
    verze: 1,
    kdy: new Date().toISOString(),
    postavy: [{ id: 'dospely-bezny', vek: 'dospely', telo: 'bezny', vyskaCm: 180, sirka: SIRKA, vyska: VYSKA, temeno: 20, podrazka: 380 }],
    vrstvy: [
      { postava: 'dospely-bezny', typ: 'postava', varianta: 'zaklad', url: postavaUrl },
      { postava: 'dospely-bezny', typ: 'kosile', varianta: 'klasicka', url: mapa(120, 240, 80, 120) },
      { postava: 'dospely-bezny', typ: 'kalhoty', varianta: 'oblekove', url: mapa(240, 370, 75, 125) },
      { postava: 'dospely-bezny', typ: 'kravata', varianta: 'kravata', url: mapa(125, 200, 95, 105) },
      { postava: 'dospely-bezny', typ: 'kravata', varianta: 'motylek', url: mapa(124, 136, 88, 112) },
      /*
       * Sako je schválně **rozepnuté** — dva díly a mezi nimi vidět košile
       * s kravatou. Zavřený obdélník by kravatu překryl a zkouška vzoru by
       * pak měřila barvu saka, aniž by si toho kdo všiml.
       */
      { postava: 'dospely-bezny', typ: 'sako', varianta: 'jednoradove', url: vrstva(set => {
        for (let y = 110; y < 250; y++) {
          for (const [odX, doX] of [[68, 88], [112, 132]]) {
            for (let x = odX; x < doX; x++) {
              const kraj = Math.abs(x - (odX + doX) / 2) / ((doX - odX) / 2);
              const stin = kraj > 0.8 ? 80 : kraj > 0.55 ? 180 : 128;
              set(x, y, stin, stin, stin, 255);
            }
          }
        }
      }) },
      { postava: 'dospely-bezny', typ: 'vlasy', varianta: 'kratke', url: mapa(20, 40, 75, 125) },
      { postava: 'dospely-bezny', typ: 'kapesnicek', varianta: 'spicka', url: mapa(140, 150, 112, 126) },
      { postava: 'dospely-bezny', typ: 'ksandy', varianta: 'uzke', url: mapa(125, 240, 84, 92) }
    ],
    produkty: [
      { kod: 'KRA1', nazev: 'Kravata burgundská', url: '/p/kravata-burgundska', cena: '690 Kč', cenaCislo: 690, obrazek: '', vzorek: vzorekUrl([91, 29, 38], [120, 44, 54]), typ: 'kravata', varianta: 'kravata', hex: '#5b1d26', velikosti: false, skladem: true },
      { kod: 'KRA2', nazev: 'Kravata šalvějová', url: '/p/kravata-salvejova', cena: '690 Kč', cenaCislo: 690, obrazek: '', vzorek: vzorekUrl([172, 194, 171], [140, 165, 140]), typ: 'kravata', varianta: 'kravata', hex: '#acc2ab', velikosti: false, skladem: true },
      { kod: 'MOT1', nazev: 'Motýlek kostkovaný', url: '/p/motylek-kostkovany', cena: '490 Kč', cenaCislo: 490, obrazek: '', vzorek: vzorekUrl([40, 70, 120], [230, 230, 225]), typ: 'kravata', varianta: 'motylek', hex: '#2d4a7c', velikosti: false, skladem: true },
      /*
       * Vzorek jako **soubor**, ne jako text v seznamu. Tak to vypadá po
       * vystavení na web: u čtyř set produktů by vzorky v seznamu dělaly
       * dva megabajty, které si stáhne každý, kdo kabinu otevře.
       */
      { kod: 'KAP1', nazev: 'Kapesníček bílý', url: '/p/kapesnicek-bily', cena: '290 Kč', cenaCislo: 290, obrazek: '', vzorek: '/vzorek-kapesnicek.png', typ: 'kapesnicek', varianta: 'spicka', hex: '#f6f6f4', velikosti: false, skladem: true },
      { kod: 'KSA1', nazev: 'Kšandy hnědé', url: '/p/ksandy-hnede', cena: '890 Kč', cenaCislo: 890, obrazek: '', vzorek: vzorekUrl([90, 66, 49], [110, 82, 60]), typ: 'ksandy', varianta: 'uzke', hex: '#5a4231', velikosti: false, skladem: true },
      /*
       * Dětské kšandy s velikostmi — na nich se zkouší dvě věci, které
       * se jinde nezkusí: rada s velikostí (rodič jinak nákup odloží) a
       * vložení do košíku **s tou velikostí**, protože adresa e-shopu
       * velikost nepřenese a musí se odeslat formulář z detailu.
       */
      { kod: 'KSA-D', nazev: 'Dětské kšandy modré', url: '/p/detske-ksandy-modre', cena: '389 Kč', cenaCislo: 389, obrazek: '', vzorek: vzorekUrl([44, 74, 124], [60, 94, 150]), typ: 'ksandy', varianta: 'uzke', hex: '#2c4a7c', velikosti: true, skladem: true, proVek: ['dite', 'kojenec'], velikostiSeznam: [
        { kod: 'KSA-D-65', popis: 'Délka: 65 cm', skladem: true },
        { kod: 'KSA-D-75', popis: 'Délka: 75 cm', skladem: true },
        { kod: 'KSA-D-90', popis: 'Délka: 90 cm', skladem: false }
      ] }
    ],
    katalog: {
      poradi: katalogVrstvy.ZK_PORADI,
      vrstvy: katalogVrstvy.ZK_VRSTVY.map(one => ({
        typ: one.typ, nazev: one.nazev, popis: one.popis,
        barvitelna: one.barvitelna, nepovinna: one.nepovinna, zbozi: one.zbozi,
        varianty: one.varianty, bod: one.bod, pobidka: one.pobidka
      })),
      barvy: katalogVrstvy.ZK_BARVY,
      vlasy: katalogVrstvy.ZK_VLASY,
      veky: [{ id: 'dospely', nazev: 'Dospělý', popis: '', vyska: [155, 205], roky: [18, 80] },
        { id: 'dite', nazev: 'Dítě', popis: '', vyska: [86, 175], roky: [2, 15] }],
      tela: [{ id: 'hubeny', nazev: 'Štíhlý', popis: '' }, { id: 'bezny', nazev: 'Běžný', popis: '' },
        { id: 'silny', nazev: 'Silnější', popis: '' }],
      vychozi: katalogVrstvy.vychoziVzhled('dospely')
    },
    nastaveni: {
      kategorie: { kapesnicek: { cz: '/kapesnicky' } },
      ksandyDil: katalogVrstvy.ZK_KSANDY_DIL,
      kontakt: { text: 'Nevíte si rady? Rádi poradíme osobně.', telefon: '+420 607 043 067', mail: 'info@quentino.cz' }
    }
  });
} catch (e) {
  console.log('kabina není přeložená — náhled kabiny bude prázdný:', e.message.split('\n')[0]);
}

/*
 * Playwright je jen v sandboxu, ne v repozitáři. Na počítači, kde chybí,
 * se náhled přeskočí — spadnout kvůli tomu nesmí.
 */
let pw;
try { pw = (await import('playwright')).default; }
catch { console.log('playwright není — náhled oken se přeskakuje'); process.exit(0); }

fs.mkdirSync(SHOTS, { recursive: true });
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

{
  const html = path.join(ROOT, 'index.html');
  fs.copyFileSync(new URL('./stub.js', import.meta.url).pathname, path.join(ROOT, 'stub.js'));
  let text = fs.readFileSync(html, 'utf8');
  text = text.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '');
  if (!text.includes('stub.js')) {
    text = text.replace('<div id="root"></div>', '<script src="./stub.js"></script>\n    <div id="root"></div>');
  }
  fs.writeFileSync(html, text);
}

/*
 * Náhradní e-shop.
 *
 * Kabina se na quentino.cz neotevírá tlačítkem, které bychom tam dali
 * sami — otevírá se tlačítkem, které si do **cizí šablony** vloží
 * zavaděč. Proto se tady vydává výpis produktů i detail produktu se
 * stejnými názvy tříd, jaké má quentino.cz, a formulář košíku odpovídá
 * tomu skutečnému (`product_id`, `option_set_id`, `quantity` na adresu
 * s `?do=productForm-submit`). Jen tak jde zkoušet to, co se dá rozbít:
 * že se tlačítko má kam vložit a že do košíku dorazí ta velikost, co si
 * zákazník vybral.
 */
const KOSIK = [];
const ESHOP = JSON.parse(KABINA_DATA).produkty ?? [];
function slugProduktu(p) { return String(p.url).split('/').filter(Boolean).pop(); }
function cisloProduktu(p) { return String(1000 + ESHOP.indexOf(p)); }

function kartaHtml(p) {
  return `<article class="card card-item p-i" data-product-id="${cisloProduktu(p)}" data-href="${p.url}">
    <a href="${p.url}" class="p-i-media mb-3"><picture class="p-i-media-one">
      <img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" width="160" height="160" alt="${p.nazev}">
    </picture></a>
    <h4 class="p-i-header"><a href="${p.url}">${p.nazev}</a></h4>
    <div class="p-i-price"><strong class="price-main">${p.cena}</strong></div>
    <a href="#" class="btn btn-to-cart AddProductToCart" title="Do košíku">Do košíku</a>
  </article>`;
}

function strankaHtml(titulek, telo) {
  return `<!doctype html><html lang="cs"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<title>${titulek}</title><style>body{margin:0;font:14px/1.5 system-ui}`
    + `.products{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;padding:14px}`
    + `.card-item{border:1px solid #e5e5e5;border-radius:10px;padding:8px}`
    + `.p-i-media img{width:100%;height:120px;background:#f3f3f3}</style></head><body>`
    + `<header><a href="/kosik">Košík</a></header>`
    + telo + KABINA_ZAVADEC + '</body></html>';
}

function detailHtml(p) {
  const vyber = (p.velikostiSeznam ?? []).length > 1
    ? `<select name="option_set_id">`
      + p.velikostiSeznam.map((v, i) => `<option value="${2000 + i}">${v.popis}</option>`).join('')
      + `</select>`
    : `<input type="hidden" name="option_set_id" value="">`;
  const souvisejici = ESHOP.filter(one => one.kod !== p.kod).slice(0, 3).map(kartaHtml).join('');
  return strankaHtml(p.nazev, `<main><h1>${p.nazev}</h1>`
    + `<form action="${p.url}?do=productForm-submit" method="post" id="frm-productForm" class="pd-tocart">`
    + `<div class="pd-prices"><strong class="price-main">${p.cena}</strong></div>`
    + `<div class="pd-order-buttons"><div class="pd-add-to-cart">`
    + `<input type="text" name="quantity" value="1">${vyber}`
    + `<div class="AddToCart"><button type="button" class="button-to-cart AddToCartButton">Do košíku</button></div>`
    + `</div></div>`
    + `<div style="display:none"><input type="hidden" name="product_id" value="${cisloProduktu(p)}"></div>`
    + `</form>`
    + `<h2>Hodí se k tomu</h2><div class="products" id="snippet--relatedProducts">${souvisejici}</div>`
    + `</main>`);
}

const server = http.createServer((req, res) => {
  const rel = (req.url || '/').split('?')[0].replace(/^\//, '') || 'index.html';
  const dotaz = (req.url || '').split('?')[1] ?? '';

  /* Vložení do košíku — tentýž formulář, jaký odesílá kabina na e-shopu */
  if (req.method === 'POST' && /do=productForm-submit/.test(dotaz)) {
    let telo = '';
    req.on('data', kus => { telo += kus; });
    return req.on('end', () => {
      /*
       * Prázdné pole se musí přečíst jako prázdné. Dřív se bralo „co je
       * na dalším řádku", a tím u produktu bez velikostí vyšla jako
       * velikost hranice formuláře (------WebKitFormBoundary…) — tedy
       * zkouška, která by přehlédla, že se do košíku posílá nesmysl.
       */
      const pole = jmeno => {
        const m = new RegExp(`name="${jmeno}"\\r?\\n\\r?\\n([\\s\\S]*?)\\r?\\n--`).exec(telo);
        return m ? m[1].trim() : '';
      };
      KOSIK.push({
        cesta: '/' + rel,
        cislo: pole('product_id'),
        optionSet: pole('option_set_id'),
        pocet: Number(pole('quantity')) || 1
      });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
    });
  }

  if (rel === 'vzorek-kapesnicek.png') {
    const base64 = JSON.parse(KABINA_DATA).produkty
      .find(one => one.kod === 'KRA2').vzorek.split(',')[1];
    res.writeHead(200, { 'Content-Type': 'image/png' });
    return res.end(Buffer.from(base64, 'base64'));
  }
  if (rel === 'kabina-data.json') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(KABINA_DATA);
  }
  if (rel === 'kabina.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
    return res.end(KABINA_SCRIPT);
  }
  if (rel === 'kabina.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(strankaHtml('Doplňky',
      '<main><h1>Doplňky</h1><div class="products">' + ESHOP.map(kartaHtml).join('') + '</div></main>'));
  }
  if (rel === 'kosik') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(strankaHtml('Košík', '<main><h1>Košík</h1><ul id="kosik">'
      + KOSIK.map(one => `<li>${one.cislo} · ${one.optionSet || '—'} · ${one.pocet}</li>`).join('')
      + '</ul></main>'));
  }
  if (rel.startsWith('p/')) {
    const produkt = ESHOP.find(one => slugProduktu(one) === rel.slice(2));
    if (!produkt) { res.writeHead(404); return res.end('nenalezeno'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(detailHtml(produkt));
  }
  fs.readFile(path.join(ROOT, rel), (err, data) => {
    if (err) { res.writeHead(404); return res.end('nenalezeno'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(rel)] ?? 'application/octet-stream' });
    res.end(data);
  });
});
await new Promise(r => server.listen(4324, r));

const preinstalled = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium/chrome-linux/chrome']
  .find(p => fs.existsSync(p));
let browser;
try { browser = await pw.chromium.launch(preinstalled ? { executablePath: preinstalled } : {}); }
catch (e) { console.log('prohlížeč se nespustil — náhled oken se přeskakuje:', e.message.split('\n')[0]); server.close(); process.exit(0); }

const problems = [];
let bad = 0;
const say = (label, ok, note = '') => {
  if (!ok) bad++;
  console.log(`${ok ? '  ✓' : '  ✗'} ${label.padEnd(44)} ${note}`);
};

const open = async hash => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  page.on('pageerror', e => problems.push(`${hash}: chyba stránky: ${e.message}`));
  page.on('console', m => {
    /*
     * Písma z Google se v sandboxu nestáhnou — ven se odtud nedá. Není to
     * chyba kódu a v provozu se to nestane; že se o ně skript **opravdu
     * říká**, se místo toho kontroluje přímo u bannerů.
     *
     * Totéž platí pro video na pozadí: v ukázkové sadě je vymyšlená adresa
     * (cdn.example.test), která nikam nevede. Je to schválně — právě tak se
     * ověří, že se nestažené video na dlaždici nijak neprojeví.
     */
    const kde = m.text() + m.location().url;
    if (m.type() === 'error'
      && !/favicon|fonts\.(googleapis|gstatic)\.com|cdn\.example\.test|cdn\.invalid/.test(kde)) {
      problems.push(`${hash}: konzole: ${m.text()}`);
    }
  });
  await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => { document.documentElement.dataset.form = 'desktop'; });
  });
  await page.addInitScript(script => { window.__bannerScript = script; }, BANNER_SCRIPT);
  await page.goto(`http://localhost:4324/index.html#${hash}`, { waitUntil: 'load' });
  await page.waitForTimeout(1100);
  return page;
};

/* ---------- každý nástroj se ve svém okně vykreslí a vyplní ho ---------- */

/*
 * Poznávací znamení každého nástroje. Kdyby se okno otevřelo prázdné nebo
 * se v něm omylem vykreslila pošta, tohle to najde — počítat jen `.modal`
 * by prošlo i tehdy, kdyby se otevřel nástroj úplně jiný.
 */
const OKNA = [
  { hash: 'katalog', nadpis: 'Katalog' },
  { hash: 'baleni', nadpis: 'Balení' },
  { hash: 'prehled', nadpis: 'Přehled' },
  { hash: 'recenze', nadpis: 'Recenze' },
  { hash: 'texty', nadpis: 'Texty' },
  { hash: 'bannery', nadpis: 'Bannery' },
  { hash: 'media', nadpis: 'Konvertor' },
  { hash: 'clanky', nadpis: 'Články' },
  { hash: 'produkty', nadpis: 'Produkty' },
  { hash: 'kabina', nadpis: 'Zkušební kabina' }
];

/*
 * Sociální sítě nejsou překryv, ale celá obrazovka s vlastním panelem —
 * kontrolují se zvlášť, níž.
 */

for (const okno of OKNA) {
  const page = await open(okno.hash);
  const mira = await page.evaluate(() => {
    const overlay = document.querySelector('#root > .overlay');
    const modal = overlay?.querySelector(':scope > .modal');
    if (!modal) return null;
    const r = modal.getBoundingClientRect();
    const style = getComputedStyle(overlay);
    return {
      w: Math.round(r.width), h: Math.round(r.height),
      okno: window.innerWidth, vyska: window.innerHeight,
      ztmaveni: style.backgroundColor,
      hlavicka: document.querySelector('#root > .overlay .modal-head')?.innerText?.trim()?.slice(0, 40) ?? ''
    };
  });
  const vyplneno = !!mira && mira.w >= mira.okno - 1 && mira.h >= mira.vyska - 1;
  say(`okno „${okno.hash}" je vidět a vyplňuje plochu`, vyplneno,
    mira ? `${mira.w}×${mira.h} z ${mira.okno}×${mira.vyska}` : 'panel v okně není');
  say(`  a je v něm ${okno.nadpis}`,
    !!mira && mira.hlavicka.toLowerCase().includes(okno.nadpis.toLowerCase()),
    mira ? mira.hlavicka : '');
  // Ztmavení překryvu nemá nad čím být — okno je samo tím překryvem
  say('  a nekreslí ztmavení do prázdna',
    !!mira && /rgba\(0, 0, 0, 0\)|transparent/.test(mira.ztmaveni), mira?.ztmaveni ?? '');
  await page.screenshot({ path: path.join(SHOTS, `okno-${okno.hash}.png`) });
  await page.close();
}

/* ---------- AI Přehled: hlavní čísla, události, žádné díry ---------- */

/*
 * Přehled je jediné okno, kde se čte víc čísel než vět, a taky jediné, kde
 * se rozvržení pozná až na snímku. Hlídá se to, co se z kódu nevidí: že
 * dlaždice nesou jedno číslo a upřesnění mají v bublině, že je v něm karta
 * událostí, a že karty vedle sebe nenechávají prázdné sloupce.
 */
{
  const page = await open('prehled');
  const stav = await page.evaluate(() => {
    const tiles = [...document.querySelectorAll('.dg-tile')].map(one => ({
      label: one.querySelector('.dg-tile-label')?.textContent?.trim() ?? '',
      value: one.querySelector('.dg-tile-value')?.textContent?.trim() ?? '',
      tip: one.getAttribute('data-tip') ?? '',
      // Kolik řádků drobným písmem pod číslem — víc než jeden se nedá přečíst
      subs: one.querySelectorAll('.dg-tile-sub').length
    }));
    /*
     * Karty v jednom řádku mřížky. Hlídá se poměr nejvyšší ku nejnižší:
     * dvojnásobek ještě vypadá jako sloupec s víc řádky, trojnásobek už
     * jako díra vedle krátké karty. Přesně to se stalo, když karta „Sítě"
     * vyrostla přes celou obrazovku vedle pětiřádkových „Stavů".
     */
    const grids = [...document.querySelectorAll('.dg-grid')].map(one => {
      const deti = [...one.children].map(d => Math.round(d.getBoundingClientRect().height))
        .filter(h => h > 20);
      return { deti, pomer: deti.length ? Math.max(...deti) / Math.min(...deti) : 1 };
    });
    // Sezóny: tři karty vedle sebe, ne tři odstavce pod sebou
    const sezony = [...document.querySelectorAll('.dg-season')]
      .map(one => Math.round(one.getBoundingClientRect().top));
    // Čísla v kartě musí začínat na stejné svislici, jinak se pruhy rozjedou
    // Karty s vnořenými kartami se přeskakují — tam mají pruhy svislic víc
    // právem, každá vnořená karta má svoji
    const cisla = [...document.querySelectorAll('.dg-card')]
      .filter(card => !card.querySelector('.dg-card'))
      .map(card => {
      const kraje = [...card.querySelectorAll('.dg-bar-track')]
        .map(one => Math.round(one.getBoundingClientRect().left));
      return { kde: card.querySelector('.dg-card-head')?.textContent?.trim().slice(0, 24) ?? '?',
        ruznych: kraje.length > 1 ? new Set(kraje).size : 1 };
    });
    return {
      tiles,
      grids,
      sezony,
      krive: cisla.filter(one => one.ruznych > 1),
      novyden: !!document.querySelector('.dg-newday'),
      rady: {
        sloupce: document.querySelectorAll('.dg-advice-col').length,
        body: document.querySelectorAll('.dg-advice-item').length,
        kroky: document.querySelectorAll('.dg-advice-todo').length
      },
      verdikty: document.querySelectorAll('.dg-verdict').length,
      udalosti: document.querySelectorAll('.dg-ev').length,
      // Prázdné místo pod kartou v mřížce: rozdíl výšky mřížky a nejvyšší karty
      vyska: [...document.querySelectorAll('.dg-grid')].map(one => {
        const deti = [...one.children].map(d => d.getBoundingClientRect().height);
        return Math.round(one.getBoundingClientRect().height - Math.max(0, ...deti));
      })
    };
  });
  say('dlaždice nesou jedno číslo', stav.tiles.length === 4 && stav.tiles.every(one => one.subs <= 1),
    stav.tiles.map(one => `${one.label}: ${one.value}`).join(' | '));
  say('  a upřesnění mají v bublině', stav.tiles.every(one => one.tip.length > 10));
  say('karta událostí je v přehledu', stav.udalosti >= 2, `${stav.udalosti} řádků`);
  /*
   * Co z toho plyne. Kvůli téhle kartě se přehled otevírá: musí mít všechny
   * tři sloupce a u každého bodu krok, co udělat. Bez kroku je to jen hezky
   * napsané konstatování.
   */
  say('přehled radí, co s tím', stav.rady.sloupce === 3 && stav.rady.body >= 3 && stav.rady.kroky >= 3,
    `${stav.rady.sloupce} sloupce, ${stav.rady.body} bodů, ${stav.rady.kroky} kroků`);
  say('  a u čísel je slovo místo přemýšlení', stav.verdikty >= 3, `${stav.verdikty} verdiktů`);
  /*
   * Karty v řádku mají srovnatelnou výšku. Rozvržení díry neřeší — řeší je
   * obsah: každá karta ukazuje nejvýš šest řádků a zbytek shrne do věty.
   * Když se poměr rozejde, je to tím, že některá karta zase roste bez
   * stropu, a v mřížce po ní zůstane prázdné místo.
   */
  say('karty v řádku mají srovnatelnou výšku',
    stav.grids.length > 0 && stav.grids.every(one => one.pomer <= 2.2),
    stav.grids.map(one => `${one.deti.join('/')} → ${one.pomer.toFixed(1)}×`).join(' · '));
  // Tři sezóny vedle sebe: stejná horní hrana, ne tři odstavce pod sebou
  say('sezóny jsou tři karty vedle sebe',
    stav.sezony.length === 3 && new Set(stav.sezony).size === 1,
    `${stav.sezony.length} karet, hran ${new Set(stav.sezony).size}`);
  say('pruhy v kartě začínají pod sebou', stav.krive.length === 0,
    stav.krive.map(one => `${one.kde}: ${one.ruznych} svislic`).join(', '));
  // Nový den se nabízí tlačítkem, negeneruje se sám
  say('nabídne sestavit dnešní přehled', stav.novyden);

  const body = await page.$('.dg-body');
  for (const [i, frac] of [[1, 0], [2, 0.45], [3, 0.9]]) {
    await page.evaluate(f => {
      const el = document.querySelector('.dg-body');
      if (el) el.scrollTop = el.scrollHeight * f;
    }, frac);
    await page.waitForTimeout(350);
    await page.screenshot({ path: path.join(SHOTS, `okno-prehled-${i}.png`) });
  }
  void body;

  // Sezóny zvlášť — je to ta část, kterou má smysl posoudit okem
  await page.evaluate(() => {
    document.querySelector('.dg-seasons')?.scrollIntoView({ block: 'center' });
  });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, 'okno-prehled-sezony.png') });

  /*
   * Bublina po najetí. Hlídá se, že se otevře **nad** kurzorem: dole
   * zakrývala právě ten řádek, na který se přecházelo dál.
   */
  const bublina = await page.evaluate(async () => {
    const row = [...document.querySelectorAll('.dg-bar-row')].find(one => one.querySelector('.dg-pop'));
    if (!row) return null;
    row.scrollIntoView({ block: 'center' });
    await new Promise(r => setTimeout(r, 200));
    const rect = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true,
      clientX: rect.left + 40, clientY: rect.top + rect.height / 2 }));
    await new Promise(r => setTimeout(r, 120));
    const pop = row.querySelector('.dg-pop');
    const kde = pop ? pop.getBoundingClientRect() : null;
    return kde ? { nad: kde.bottom <= rect.top + 2, radek: Math.round(rect.top) } : null;
  });
  say('vysvětlení v tabulce se otevírá nahoru', !!bublina?.nad,
    bublina ? `řádek na ${bublina.radek}px` : 'bublina nenalezena');

  // A bublina od dlaždic taky — ta se kreslí až po prodlevě, přes vrstvu
  const tip = await page.evaluate(async () => {
    const tile = document.querySelector('.dg-tile[data-tip]');
    if (!tile) return null;
    tile.scrollIntoView({ block: 'center' });
    await new Promise(r => setTimeout(r, 200));
    const rect = tile.getBoundingClientRect();
    const y = rect.top + rect.height / 2;
    tile.dispatchEvent(new MouseEvent('mouseover', { bubbles: true,
      clientX: rect.left + 30, clientY: y }));
    await new Promise(r => setTimeout(r, 600));
    const layer = document.querySelector('.tip-layer');
    if (!layer) return null;
    const kde = layer.getBoundingClientRect();
    return { nad: kde.bottom <= y, sirka: Math.round(kde.width), vyska: Math.round(kde.height) };
  });
  /*
   * Události z hlavičky. Zapisuje se do nich ve chvíli, kdy se člověk dívá
   * na čísla nahoře — karta je někde uprostřed okna, takže se kvůli zápisu
   * rolovalo dolů a zpátky.
   */
  await page.click('.modal-head .icon-btn[data-tip^="Události"]');
  await page.waitForTimeout(400);
  const dialog = await page.evaluate(() => {
    const boxes = [...document.querySelectorAll('.overlay .modal')];
    const last = boxes[boxes.length - 1];
    return {
      kolik: boxes.length,
      nadpis: last?.querySelector('.modal-head')?.textContent?.trim() ?? '',
      formular: !!last?.querySelector('.dg-ev-form'),
      radky: last?.querySelectorAll('.dg-ev').length ?? 0
    };
  });
  say('události jdou otevřít z hlavičky', dialog.kolik === 2 && dialog.nadpis.includes('Události')
    && dialog.formular && dialog.radky >= 2,
    `${dialog.nadpis} · formulář ${dialog.formular ? 'ano' : 'ne'} · ${dialog.radky} řádků`);
  await page.screenshot({ path: path.join(SHOTS, 'okno-prehled-udalosti.png') });
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    const boxes = [...document.querySelectorAll('.overlay')];
    boxes[boxes.length - 1]?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  });
  await page.waitForTimeout(200);

  say('bublina u dlaždice je nad kurzorem a drží rozměr',
    !!tip?.nad && (tip?.sirka ?? 999) <= 330 && (tip?.vyska ?? 999) <= 175,
    tip ? `${tip.sirka}×${tip.vyska} px` : 'bublina nenalezena');
  await page.screenshot({ path: path.join(SHOTS, 'okno-prehled-bublina.png') });
  await page.close();
}

/* ---------- sociální sítě ve vlastním okně ---------- */

{
  const page = await open('socialni');
  const stav = await page.evaluate(() => ({
    app: document.querySelectorAll('#root > .ig-app').length,
    // V okně nástroje se prostory nepřepínají, zůstává jen nabídka Funkcí
    tabs: [...document.querySelectorAll('.ig-switch > button')].map(b => b.textContent?.trim() ?? ''),
    panel: document.querySelectorAll('.ig-app .sidebar').length
  }));
  say('okno sociálních sítí se vykreslí', stav.app === 1 && stav.panel === 1,
    `app ${stav.app}, panel ${stav.panel}`);
  /*
   * V okně nástroje není přepínač vůbec: pošta ani chat v něm nejsou a
   * celé menu nástrojů uvnitř okna jednoho nástroje nedává smysl. Kdo
   * chce jiný nástroj, přepne okno.
   */
  say('  a nemá v sobě přepínač prostorů ani nabídku nástrojů',
    stav.tabs.length === 0, stav.tabs.join(' | ') || 'žádný');
  await page.screenshot({ path: path.join(SHOTS, 'okno-socialni.png') });

  /*
   * Příspěvky — plán i rozdělaná práce v jednom. Dřív to byly dvě
   * obrazovky a rozdíl mezi nimi byl jen technický: v plánu příspěvky
   * bez textů, mezi rozdělanými ty s texty. Hledalo se na dvou místech
   * a příspěvek mezi nimi beze slova přeskakoval.
   */
  await page.locator('.side-item', { hasText: 'Příspěvky' }).click();
  await page.waitForTimeout(600);
  const prispevky = await page.evaluate(() => {
    const karty = [...document.querySelectorAll('.igd-card')];
    return {
      karet: karty.length,
      tydnu: document.querySelectorAll('.ig-plan-week').length,
      // Návrh od aplikace se čte jinak pozorně než vlastní příspěvek
      puvody: [...document.querySelectorAll('.igd-origin')].map(one => one.textContent.trim()),
      // Kolik trhů má text — číslem, ne počítáním barevných teček
      trhy: [...document.querySelectorAll('.igd-trhy')].map(one => one.textContent.trim()),
      filtry: [...document.querySelectorAll('.igd-filters .tab:not(.igd-lang-tab)')]
        .map(one => one.textContent.trim()),
      jazyky: document.querySelectorAll('.igd-filters .igd-lang-tab').length,
      snimku: document.querySelectorAll('.igd-thumb').length,
      bezFotek: document.querySelectorAll('.igd-nomedia').length,
      varovani: [...document.querySelectorAll('.igd-warn')].map(one => one.textContent.trim()),
      zamcene: [...document.querySelectorAll('.igd-approve input')].filter(one => one.disabled).length,
      odsouhlasene: document.querySelectorAll('.igd-card.ok').length,
      tazeni: karty.filter(one => one.getAttribute('draggable') === 'true').length,
      smazat: document.querySelectorAll('.igd-btns .icon-btn.danger').length
    };
  });
  say('příspěvky jsou plán i rozdělaná práce v jednom seznamu',
    prispevky.karet === 3 && prispevky.tydnu >= 2,
    `${prispevky.karet} karet v ${prispevky.tydnu} skupinách`);
  say('  je poznat, co navrhla aplikace a co jsem psal sám',
    prispevky.puvody.includes('návrh') && prispevky.puvody.includes('ruční'),
    prispevky.puvody.join(' · '));
  say('  a u každého, kolik trhů už má text',
    prispevky.trhy.length === 3 && /\d+ \/ \d+ trhů/.test(prispevky.trhy[0]),
    prispevky.trhy.join(' | '));
  say('  filtr říká, kolik čeho zbývá',
    prispevky.filtry.length === 5 && /Chybí fotky\s*\d/.test(prispevky.filtry[1]),
    prispevky.filtry.join(' · '));
  say('  a text jde přepnout na jiný trh', prispevky.jazyky >= 3, `${prispevky.jazyky} voleb`);
  say('  karta vypadá jako budoucí příspěvek',
    prispevky.snimku >= 3 && prispevky.bezFotek === 1,
    `${prispevky.snimku} náhledů, ${prispevky.bezFotek}× nápad na focení`);
  say('  a co se nestíhá, se řekne přímo na kartě',
    prispevky.varovani.length === 2, prispevky.varovani.join(' | '));
  say('  bez fotky nejde odsouhlasit', prispevky.zamcene === 1, `${prispevky.zamcene}×`);
  say('  odsouhlasený je poznat bez čtení', prispevky.odsouhlasene === 1,
    `${prispevky.odsouhlasene}×`);
  say('  příspěvky s termínem jdou přetáhnout', prispevky.tazeni === 3, `${prispevky.tazeni}×`);
  say('  a jde je smazat', prispevky.smazat === 3, `${prispevky.smazat}×`);

  /* Filtrování podle toho, co zbývá — fotí se dávkou */
  await page.locator('.igd-filters .tab', { hasText: 'Chybí fotky' }).click();
  await page.waitForTimeout(300);
  const jenBezFotek = await page.evaluate(() => document.querySelectorAll('.igd-card').length);
  say('  filtr opravdu filtruje', jenBezFotek === 1, `${jenBezFotek} karta`);
  await page.locator('.igd-filters .tab', { hasText: 'Vše' }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, 'okno-social-prispevky.png') });

  await page.locator('.ig-plan-actions .btn.primary', { hasText: 'Navrhnout měsíc' }).click();
  await page.waitForTimeout(700);
  const navrh = await page.evaluate(() => ({
    karet: document.querySelectorAll('.ig-plan-card').length,
    // Návrh se ukazuje před uložením, ať se dá vyhodit, co se nehodí
    zahodit: !!document.querySelector('.ig-plan-proposal .btn.ghost'),
    text: (document.querySelector('.ig-plan-card .ig-plan-body p')?.textContent ?? '').slice(0, 60)
  }));
  say('  návrh se ukáže dřív, než se uloží',
    navrh.karet === 2 && navrh.zahodit, `${navrh.karet} návrhů`);
  say('  a text je hotový k vložení, ne osnova', navrh.text.length > 25, navrh.text);
  await page.screenshot({ path: path.join(SHOTS, 'okno-social-plan.png') });

  /*
   * Jeden příspěvek na vyžádání — bez plánování celého měsíce.
   * Přání je nepovinné: bez něj si téma vybere sám.
   */
  await page.locator('.ig-plan-actions .btn.ghost', { hasText: 'Jeden příspěvek' }).click();
  await page.waitForTimeout(400);
  const prani = await page.evaluate(() => ({
    policko: !!document.querySelector('.igd-wish input'),
    text: (document.querySelector('.igd-wish input')?.getAttribute('placeholder') ?? '')
  }));
  say('  a jde si říct o jeden příspěvek na teď',
    prani.policko && /kravata/i.test(prani.text), prani.text.slice(0, 50));
  await page.screenshot({ path: path.join(SHOTS, 'okno-social-navrh.png') });

  /* ---------- střih videa s titulky ---------- */

  /*
   * Do střihu se vchází z příspěvku, od médií — je to jeden ze způsobů,
   * jak k příspěvku přidat obraz, ne samostatný nástroj v nabídce.
   */
  await page.locator('.igd-btns .btn.ghost', { hasText: 'Otevřít' }).first().click();
  await page.waitForTimeout(600);
  const vstup = await page.evaluate(() => ({
    tlacitko: [...document.querySelectorAll('.ig-video-vstup button')].map(b => b.textContent.trim()),
    uMedii: !!document.querySelector('.ig-card .ig-video-vstup')
  }));
  say('do střihu videa se vchází od médií příspěvku',
    vstup.tlacitko.some(t => /Video s titulky/.test(t)) && vstup.uMedii,
    vstup.tlacitko.join(' | ') || 'není');

  await page.locator('.ig-video-vstup button').first().click();
  await page.waitForTimeout(900);

  const strih = await page.evaluate(() => {
    const cisla = [...document.querySelectorAll('.qv-krok .qv-cislo')].map(n => n.textContent.trim());
    const nazvy = [...document.querySelectorAll('.qv-krok h3')].map(n => n.textContent.trim());
    const klipy = [...document.querySelectorAll('.qv-klip')].map(k => ({
      nazev: (k.querySelector('b')?.textContent ?? '').trim(),
      delka: (k.querySelector('.desc')?.textContent ?? '').trim(),
      znelka: k.className.includes('znelka'),
      tazitelny: k.getAttribute('draggable') === 'true'
    }));
    const bloky = [...document.querySelectorAll('.qv-blok')].map(b => ({
      left: Math.round(parseFloat(b.style.left)),
      width: Math.round(parseFloat(b.style.width)),
      prolnuti: !!b.querySelector('.qv-prolnuti')
    }));
    const pasky = [...document.querySelectorAll('.qv-tit')].map(t => ({
      left: Math.round(parseFloat(t.style.left)),
      text: (t.querySelector('span')?.textContent ?? '').trim(),
      uchopy: t.querySelectorAll('.qv-uchop').length,
      pozice: t.className.replace('qv-tit', '').trim()
    }));
    return {
      cisla, nazvy, klipy, bloky, pasky,
      prechody: [...document.querySelectorAll('.qv-prechod em')].map(e => e.textContent.trim()),
      radky: document.querySelectorAll('.qv-tit-radek').length,
      styly: [...document.querySelectorAll('.qv-tit-vzhled select')].length,
      jazyky: [...document.querySelectorAll('.qv-jazyk')].map(b => b.textContent.replace(/\s+/g, ' ').trim()),
      pomer: (document.querySelector('.qv-obal')?.className ?? ''),
      video: !!document.querySelector('.qv-obal video'),
      platno: !!document.querySelector('canvas.qv-titulky'),
      zvukVolby: [...document.querySelectorAll('.qv-volba')].map(b => b.textContent.trim()),
      trhy: [...document.querySelectorAll('.qv-trh')].map(t => t.textContent.replace(/\s+/g, ' ').trim()),
      celkem: (document.querySelector('.qv-top-t .desc')?.textContent ?? '').trim()
    };
  });

  say('střih videa má čtyři kroky pod sebou, nic v druhé záložce',
    strih.cisla.join('') === '1234', `${strih.cisla.join('')} — ${strih.nazvy.join(' · ')}`);
  say('  záběry jsou v pásu za sebou a jde je přetáhnout',
    strih.klipy.length === 3 && strih.klipy.every(k => k.tazitelny),
    strih.klipy.map(k => `${k.nazev} ${k.delka}`).join(' | '));
  say('  znělka je poznat od vlastního záběru',
    strih.klipy.filter(k => k.znelka).length === 1,
    `${strih.klipy.filter(k => k.znelka).length}×`);
  say('  přechod se nastavuje na spoji, kde je',
    strih.prechody.length === 2, strih.prechody.join(' · '));
  /*
   * Klíčová věc na celé obrazovce: časová osa musí ukázat, že se přechod
   * s oběma záběry **překrývá** — jinak nikdo nepochopí, proč je video
   * kratší než součet záběrů.
   */
  say('  časová osa ukazuje i prolnutí, ne jen bloky za sebou',
    strih.bloky.length === 3 && strih.bloky.filter(b => b.prolnuti).length === 2,
    strih.bloky.map(b => `${b.left}%+${b.width}%${b.prolnuti ? ' (prolnutí)' : ''}`).join(' '));
  say('  a druhý záběr začíná dřív, než první skončí',
    strih.bloky[1].left < strih.bloky[0].left + strih.bloky[0].width,
    `${strih.bloky[1].left} % vs ${strih.bloky[0].left + strih.bloky[0].width} %`);
  say('  titulky jsou v ose pásky, které jde táhnout i roztahovat',
    strih.pasky.length === 3 && strih.pasky.every(t => t.uchopy === 2),
    strih.pasky.map(t => `${t.text} @${t.left}%`).join(' | '));
  say('  a pásky v různých výškách podle toho, kde titulek v obraze je',
    new Set(strih.pasky.map(t => t.pozice)).size >= 2,
    strih.pasky.map(t => t.pozice).join(' · '));
  say('  náhled je ve poměru, který se vykreslí',
    /pomer-9-16/.test(strih.pomer) && strih.video && strih.platno, strih.pomer);
  say('  u každého titulku se dá vybrat styl i umístění',
    strih.radky === 3 && strih.styly === 6, `${strih.radky} řádků, ${strih.styly} voleb`);
  /* A doladit jeden titulek zvlášť, aniž by se měnil styl ostatních */
  await page.locator('.qv-tit-btns .icon-btn').nth(1).click();
  // Panel se rozbaluje až po překreslení seznamu — krátké čekání dělalo
  // zkoušku občas vrtkavou
  await page.waitForTimeout(600);
  const vic = await page.evaluate(() => ({
    poli: [...document.querySelectorAll('.qv-tit-vic label')].map(l => l.textContent.trim().split(/\s{2,}|\n/)[0]),
    zpet: !!document.querySelector('.qv-tit-vic .btn'),
    pisma: [...document.querySelectorAll('.qv-tit-vic select')].length
  }));
  say('  a jeden titulek jde doladit zvlášť — velikost, barva, posun, zarovnání i písmo',
    vic.poli.length === 6 && vic.zpet && vic.pisma === 3, vic.poli.join(' · '));
  await page.locator('.qv-tit-btns .icon-btn').nth(1).click();

  /* Písmo pro celý projekt, včetně vlastního nahraného */
  const pismo = await page.evaluate(() => ({
    nabidka: [...document.querySelectorAll('.qv-pismo select option')].map(o => o.textContent.trim()),
    nahrat: [...document.querySelectorAll('.qv-pismo .btn')].map(b => b.textContent.trim())
  }));
  say('  písmo titulků jde vybrat ze systémových i nahrát vlastní',
    pismo.nabidka.length === 5 && pismo.nahrat.some(t => /Nahrát vlastní/.test(t)),
    pismo.nabidka.join(' · '));
  say('  jazyk titulků se přepíná a je vidět, kolik je přeloženo',
    strih.jazyky.length === 3 && /zdroj/.test(strih.jazyky[0]) && /\d\s*\/\s*\d/.test(strih.jazyky[1]),
    strih.jazyky.join(' | '));
  say('  zvuk jde pro trh vzít z videa, z vlastního souboru, nebo vypnout',
    strih.zvukVolby.length === 3, strih.zvukVolby.join(' · '));
  say('  a u trhů stojí, co se s nimi stane',
    strih.trhy.length === 3 && strih.trhy.some(t => /titulků/.test(t)), strih.trhy.join(' | '));
  say('  v hlavičce je délka i počet záběrů',
    /záběry/.test(strih.celkem) && /titulky|titulek/.test(strih.celkem), strih.celkem);
  await page.screenshot({ path: path.join(SHOTS, 'okno-social-video.png') });

  /* Titulek se nakreslí i na plátno — je to totéž kreslení, které se vypaluje */
  await page.locator('.qv-tit-btns .icon-btn').first().click();
  await page.waitForTimeout(500);
  const nakresleno = await page.evaluate(() => {
    const c = document.querySelector('canvas.qv-titulky');
    if (!c) return { ok: false };
    const ctx = c.getContext('2d');
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    let nenulove = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 20) nenulove++;
    return { ok: true, pixelu: nenulove, celkem: data.length / 4 };
  });
  /*
   * Prázdné plátno by znamenalo, že náhled titulek nekreslí — a pak by se
   * styl ladil naslepo a poznalo by se to až na hotovém videu.
   */
  say('  titulek se v náhledu opravdu nakreslí',
    nakresleno.ok && nakresleno.pixelu > 200,
    `${nakresleno.pixelu} z ${nakresleno.celkem} pixelů`);

  /*
   * Náhled musí zůstat vidět i po sjetí k titulkům.
   *
   * Je to jediné místo, kde je vidět, jak titulek vypadá — psát text
   * a nevidět ho znamená ladit naslepo. Drží se `position: sticky`,
   * což ale potřebuje, aby rolovala sama obrazovka, ne okno nad ní.
   */
  {
    const predtim = await page.evaluate(() => {
      const r = document.querySelector('.qv-rail').getBoundingClientRect();
      const k = document.querySelectorAll('.qv-krok')[1].getBoundingClientRect();
      return { rail: Math.round(r.top), krok: Math.round(k.top) };
    });
    await page.evaluate(() => { document.querySelector('.qv').scrollTop = 700; });
    await page.waitForTimeout(350);
    const potom = await page.evaluate(() => {
      const r = document.querySelector('.qv-rail').getBoundingClientRect();
      const k = document.querySelectorAll('.qv-krok')[1].getBoundingClientRect();
      return { rail: Math.round(r.top), krok: Math.round(k.top), posun: document.querySelector('.qv').scrollTop };
    });
    say('  náhled zůstane vidět i po sjetí k titulkům',
      potom.posun > 100 && Math.abs(potom.rail - predtim.rail) < 12 && predtim.krok - potom.krok > 100,
      `posun ${potom.posun}, náhled ${predtim.rail}→${potom.rail}, krok ${predtim.krok}→${potom.krok}`);
    await page.evaluate(() => { document.querySelector('.qv').scrollTop = 0; });
    await page.waitForTimeout(250);
  }

  /*
   * Snímky z videa.
   *
   * Vytahuje je okno z téhož souboru, který přehrává. Dřív se pomocný
   * přehrávač zakládal odpojený od stránky a s `preload="metadata"` —
   * první snímek se tím nedekódoval, `loadeddata` nepřišlo a u pásků
   * i u konců střihu pořád stálo „načítám snímek…". Zkouška proto
   * nečeká na vzhled, ale na opravdu vytažené obrázky.
   */
  await page.waitForTimeout(2500);
  const snimky = await page.evaluate(() => ({
    vOse: document.querySelectorAll('.qv-osa .qv-snimky img').length,
    naPolich: [...document.querySelectorAll('.qv-konec-snimek img')].length,
    cekaji: document.querySelectorAll('.qv-konec-prazdno').length
  }));
  say('  snímky z videa se opravdu vytáhnou',
    snimky.vOse > 0, `v ose ${snimky.vOse}, u konců střihu ${snimky.naPolich}`);

  /* Přejíždění po ose ukazuje, co v tom místě je */
  const osaBox = await page.locator('.qv-osa').boundingBox();
  await page.mouse.move(osaBox.x + osaBox.width * 0.6, osaBox.y + 20);
  await page.waitForTimeout(250);
  const najeto = await page.evaluate(() => {
    const n = document.querySelector('.qv-najeto');
    return { je: !!n, cas: (n?.querySelector('b')?.textContent ?? '').trim(), obrazek: !!n?.querySelector('img') };
  });
  say('  při přejíždění po ose je vidět snímek i čas',
    najeto.je && /\d/.test(najeto.cas), `${najeto.cas}${najeto.obrazek ? ' se snímkem' : ' bez snímku'}`);

  /*
   * Mezery mezi slovy v titulku.
   *
   * Vypsat v seznamu písem emoji rodiny vypadá neškodně — jenže prohlížeč
   * z nich pak vezme i obyčejné znaky, a mezera z emoji písma zabírá celý
   * čtverec. V titulku to dělalo nesmyslně velké mezery mezi slovy a kdo
   * to nezná, hledá chybu v textu. Měří se proto poměr mezery k písmenu,
   * ne vzhled.
   */
  const mezery = await page.evaluate(() => {
    const c = document.createElement('canvas').getContext('2d');
    c.font = '700 44px Montserrat, system-ui, sans-serif';
    const mezera = c.measureText(' ').width;
    const pismeno = c.measureText('n').width;
    return { mezera, pismeno, pomer: mezera / pismeno };
  });
  say('  mezera v titulku je mezera, ne čtverec z emoji písma',
    mezery.pomer > 0.1 && mezery.pomer < 0.7,
    `mezera ${mezery.mezera.toFixed(1)} px, písmeno ${mezery.pismeno.toFixed(1)} px`);

  /*
   * Volby přechodu patří pod pás, ne do vyskakovací nabídky nad ním.
   * Pás se při víc záběrech posouvá a nabídku ořízl — po klepnutí na
   * spoj se pak nestalo nic viditelného.
   */
  await page.locator('.qv-prechod').first().click();
  await page.waitForTimeout(300);
  const nabidka = await page.evaluate(() => {
    const panel = document.querySelector('.qv-krok .qv-strih');
    const r = panel?.getBoundingClientRect();
    const pas = document.querySelector('.qv-pas')?.getBoundingClientRect();
    return {
      voleb: document.querySelectorAll('.qv-prechod-volba').length,
      popisky: [...document.querySelectorAll('.qv-prechod-volba span')].map(s => s.textContent.trim()).slice(0, 2),
      podPasem: !!r && !!pas && r.top >= pas.bottom - 2,
      videt: !!r && r.height > 40 && r.width > 200,
      delka: !!document.querySelector('.qv-prechod-delka')
    };
  });
  say('  přechody se vybírají s popisem, ne podle názvu filtru',
    nabidka.voleb === 7 && nabidka.popisky.every(p => p.length > 15),
    `${nabidka.voleb} voleb: ${nabidka.popisky.join(' | ')}`);
  say('  a nabídka stojí pod pásem, takže ji posuvný pás neořízne',
    nabidka.podPasem && nabidka.videt, `pod pásem: ${nabidka.podPasem}, vidět: ${nabidka.videt}`);
  say('  u přechodu jde nastavit i délka', nabidka.delka);
  await page.screenshot({ path: path.join(SHOTS, 'okno-social-video-prechod.png') });

  /*
   * Prostříhání: jeden pás se dvěma úchyty nad celým zdrojem. Dva
   * nezávislé posuvníky se nedaly přečíst a šel u nich nastavit konec
   * před začátkem.
   */
  await page.locator('.qv-klip').first().click();
  await page.waitForTimeout(400);
  const prostrih = await page.evaluate(() => {
    const vybrano = document.querySelector('.qv-vystrizek-vybrano');
    const uchopy = [...document.querySelectorAll('.qv-vystrizek-uchop')];
    const karta = document.querySelector('.qv-klip');
    const nazev = karta?.querySelector('b')?.getBoundingClientRect();
    const kos = karta?.querySelector('.icon-btn')?.getBoundingClientRect();
    return {
      uchopu: uchopy.length,
      vybrano: !!vybrano && parseFloat(vybrano.style.width) > 0,
      rozdelit: [...document.querySelectorAll('.qv-konce .btn')].map(b => b.textContent.trim()),
      konce: [...document.querySelectorAll('.qv-konec-popis')].map(e => e.textContent.trim()),
      mimo: document.querySelectorAll('.qv-vystrizek-mimo').length,
      vyrez: [...document.querySelectorAll('.qv-vyrez label')].map(l => l.textContent.trim().split(/\s/)[0]),
      // Název souboru se nesmí překrývat s košem — na dlouhých názvech se to stalo
      kolize: !!nazev && !!kos && nazev.right > kos.left && nazev.top < kos.bottom && nazev.bottom > kos.top
    };
  });
  say('  výstřižek má dva úchyty nad celým zdrojem',
    prostrih.uchopu === 2 && prostrih.vybrano, `${prostrih.uchopu} úchyty`);
  say('  záběr jde rozdělit v místě přehrávače',
    prostrih.rozdelit.some(t => /Rozdělit/.test(t)), prostrih.rozdelit.join(' · '));
  /*
   * Snímky v místech střihu. Posouvat úchyt podle čísel znamená hádat,
   * čím záběr začne a skončí — na obrázku je to vidět.
   */
  say('  a u obou konců i uprostřed je vidět snímek',
    prostrih.konce.length === 3 && /Začíná na/.test(prostrih.konce[0]),
    prostrih.konce.join(' · '));
  say('  co se ze zdroje vyhodí, je ztlumené', prostrih.mimo === 2, `${prostrih.mimo} části`);
  /* A ty snímky se opravdu dotáhnou, ne že u nich zůstane „načítám" */
  await page.waitForTimeout(2200);
  const konceHotove = await page.evaluate(() => ({
    obrazku: document.querySelectorAll('.qv-konec-snimek img').length,
    ceka: document.querySelectorAll('.qv-konec-prazdno').length
  }));
  say('  a snímky u konců střihu se dotáhnou',
    konceHotove.obrazku >= 2, `${konceHotove.obrazku} snímků, ${konceHotove.ceka} čeká`);

  /*
   * Klepnutí na titulek přesune náhled na něj. Bez toho se text psal
   * naslepo: v náhledu stál jiný okamžik videa.
   */
  await page.locator('.qv-tit-radek').nth(2).click();
  await page.waitForTimeout(400);
  const poKliku = await page.evaluate(() => ({
    cas: (document.querySelector('.qv-cas')?.textContent ?? '').trim(),
    zvyraznen: document.querySelectorAll('.qv-tit-radek.nyni').length
  }));
  say('  klepnutí na titulek přesune náhled na něj',
    poKliku.zvyraznen === 1, `${poKliku.cas}, zvýrazněných ${poKliku.zvyraznen}`);
  say('  a dá se přiblížit i posunout výřez',
    prostrih.vyrez.length === 3, prostrih.vyrez.join(' · '));
  say('  název souboru se nepřekrývá s košem', !prostrih.kolize);
  await page.screenshot({ path: path.join(SHOTS, 'okno-social-video-prostrih.png') });

  /*
   * Překlad se nabízí tam, kde chybí — u přepnutého trhu, ne v hlavičce
   * kroku. Právě ve chvíli, kdy člověk vidí prázdná pole, má tlačítko
   * smysl; nahoře u nadpisu ho hledal jinde.
   */
  await page.locator('.qv-jazyk', { hasText: 'DE' }).click();
  await page.waitForTimeout(400);
  const chybejici = await page.evaluate(() => {
    const stav = document.querySelector('.qv-jazyk-stav');
    return {
      text: (stav?.textContent ?? '').replace(/\s+/g, ' ').trim(),
      tlacitka: [...(stav?.querySelectorAll('.btn') ?? [])].map(b => b.textContent.trim()),
      varovne: !!stav && !stav.className.includes('ok')
    };
  });
  say('  u trhu bez překladu stojí, co se stane, a hned u toho překlad',
    chybejici.varovne && /vypálí se (místo nich )?CS/.test(chybejici.text)
      && chybejici.tlacitka.some(t => /Přeložit do DE/.test(t)),
    `${chybejici.text.slice(0, 70)} → ${chybejici.tlacitka.join(' | ')}`);

  await page.locator('.qv-jazyk-stav .btn', { hasText: 'Přeložit' }).first().click();
  await page.waitForTimeout(800);
  const poPrekladu = await page.evaluate(() =>
    [...document.querySelectorAll('.qv-jazyk')].map(b => b.textContent.replace(/\s+/g, ' ').trim()));
  say('  po překladu mají trhy všechny titulky',
    poPrekladu.length === 3 && poPrekladu.slice(1).every(t => /(\d+) \/ \1/.test(t)),
    poPrekladu.join(' | '));

  /* Měřítko a jména pásů — bez nich byla osa dva pruhy bez čísel */
  const osa = await page.evaluate(() => ({
    znacky: document.querySelectorAll('.qv-stupnice i').length,
    jmena: [...document.querySelectorAll('.qv-osa-jmena span')].map(e => e.textContent.trim()),
    hlava: (document.querySelector('.qv-hlava b')?.textContent ?? '').trim(),
    prechodVOse: [...document.querySelectorAll('.qv-prolnuti b')].map(e => e.textContent.trim())
  }));
  say('  časová osa má měřítko, jména pásů i čas u hlavy',
    osa.znacky >= 4 && osa.jmena.join('·') === 'Záběry·Titulky' && /\d/.test(osa.hlava),
    `${osa.znacky} značek, hlava ${osa.hlava}`);
  say('  a u překryvu stojí, který přechod to je',
    osa.prechodVOse.length === 2, osa.prechodVOse.join(' · '));

  /*
   * Nic v editoru nesmí polykat kliknutí.
   *
   * Tohle je zkouška za jednu konkrétní chybu: snímek pod kurzorem si
   * nad osou bral místo zápornou mezerou, takže nad hlavičkou osy ležel
   * sedmdesát pixelů vysoký neviditelný pás. Tlačítko „Titulek tady"
   * bylo vidět, nebylo zakázané, a přesto se titulek nedal přidat —
   * kliknutí došlo do toho pásu. Z kódu se to nepozná a na snímku taky
   * ne; pozná se to jedině tím, že se u každého ovládacího prvku zeptám,
   * co je na jeho středu doopravdy navrchu.
   */
  {
    const projdi = () => page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('.qv button, .qv select, .qv input, .qv textarea')) {
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        if (r.bottom < 4 || r.top > innerHeight - 4) continue;
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (!hit || el === hit || el.contains(hit) || hit.contains(el)) continue;
        /*
         * Lepivá hlavička a hlášky jsou v právu: pod hlavičku obsah při
         * rolování zajet má a hláška se za chvíli sama ztratí. Chyba je
         * jen to, co ovládání zakrývá **natrvalo a neviditelně**.
         */
        if (hit.closest('.qv-top, .toast-wrap')) continue;
        const co = (el.textContent || el.getAttribute('title') || el.tagName).trim().slice(0, 28);
        out.push(`${co} ← ${hit.className || hit.tagName}`);
      }
      return out;
    });
    const vyska = await page.evaluate(() => document.querySelector('.qv').scrollHeight);
    const zakryte = new Set();
    for (let y = 0; y < vyska; y += 400) {
      await page.evaluate(t => { document.querySelector('.qv').scrollTop = t; }, y);
      await page.waitForTimeout(220);
      for (const one of await projdi()) zakryte.add(one);
    }
    await page.evaluate(() => { document.querySelector('.qv').scrollTop = 0; });
    await page.waitForTimeout(250);
    say('  nic v editoru nepolyká kliknutí',
      zakryte.size === 0,
      zakryte.size ? [...zakryte].join(' | ') : 'prošlo celé okno');
  }

  /*
   * A pak to hlavní, k čemu se sem chodí: přidat titulek a napsat do něj.
   * Dřív se kontrolovalo jen to, že už existující titulky jdou táhnout a
   * doladit — že **vznikne nový**, nekontroloval nikdo.
   */
  {
    const pred = await page.evaluate(() => document.querySelectorAll('.qv-tit-radek').length);
    await page.locator('.qv-osa-hlava button', { hasText: 'Titulek tady' }).click();
    await page.waitForTimeout(700);
    const po = await page.evaluate(() => document.querySelectorAll('.qv-tit-radek').length);
    say('  titulek jde přidat tlačítkem v hlavičce osy', po === pred + 1, `${pred} → ${po}`);

    /*
     * Prázdný řádek se hledá podle `value`, ne podle textu v HTML —
     * textarea nemá hodnotu v obsahu, takže `hasText` by minul.
     */
    const prazdny = await page.evaluate(() =>
      [...document.querySelectorAll('.qv-tit-radek')]
        .findIndex(r => !(r.querySelector('textarea')?.value ?? 'x')));
    if (prazdny >= 0) {
      await page.locator('.qv-tit-radek').nth(prazdny).locator('textarea').fill('Nový titulek z ruky');
      await page.waitForTimeout(700);
    }
    const vose = await page.evaluate(() =>
      [...document.querySelectorAll('.qv-tit span')].map(s => s.textContent.trim()));
    say('  a text se do něj dá hned napsat — a je vidět v ose',
      vose.includes('Nový titulek z ruky'), vose.join(' | ').slice(0, 90));

    /* Uklidit po sobě, ať další zkoušky vidí stejný projekt jako dosud */
    const kam = await page.evaluate(() =>
      [...document.querySelectorAll('.qv-tit-radek')]
        .findIndex(r => r.querySelector('textarea')?.value === 'Nový titulek z ruky'));
    if (kam >= 0) {
      await page.locator('.qv-tit-radek').nth(kam).locator('.icon-btn.danger').click();
      await page.waitForTimeout(500);
    }
    const zbylo = await page.evaluate(() => document.querySelectorAll('.qv-tit-radek').length);
    say('  a smazat jedním tlačítkem', zbylo === pred, `zbylo ${zbylo}`);
  }

  /* Náhled jde zvětšit — na malém se titulky ladí špatně */
  const velikosti = await page.evaluate(() =>
    [...document.querySelectorAll('.qv-zvetseni button')].map(b => b.textContent.trim()));
  say('  náhled jde zvětšit i zmenšit', velikosti.join('') === 'SML', velikosti.join(' '));
  await page.locator('.qv-zvetseni button', { hasText: 'L' }).click();
  await page.waitForTimeout(300);
  const vetsi = await page.evaluate(() => (document.querySelector('.qv-obal')?.className ?? ''));
  say('  a volba se opravdu projeví', /vel-l/.test(vetsi), vetsi);
  await page.locator('.qv-zvetseni button', { hasText: 'M' }).click();

  /* Vykreslení: postup se hlásí průběžně, jinak to vypadá zaseknutě */
  await page.locator('.qv-konec button.primary').click();
  await page.waitForTimeout(1200);
  const poVykresleni = await page.evaluate(() => ({
    hotovo: [...document.querySelectorAll('.qv-hotovo')].map(e => e.textContent.trim()),
    zpet: [...document.querySelectorAll('.qv-konec button')].map(b => b.textContent.trim())
  }));
  say('  po vykreslení je u trhu vidět, že je hotovo',
    poVykresleni.hotovo.length === 3, poVykresleni.hotovo.join(' · '));
  say('  a cesta zpátky do příspěvku říká, co tam čeká',
    poVykresleni.zpet.some(t => /přiložen/.test(t)), poVykresleni.zpet.join(' | '));
  /*
   * Hotové video musí jít dostat z aplikace ven i bez publikování —
   * do e-shopu, do newsletteru, nebo jen na ukázku. Bez toho by se
   * hledalo v datech aplikace, kam nikdo nevidí.
   */
  const stazeni = await page.evaluate(() => ({
    uTrhu: [...document.querySelectorAll('.qv-hotovo-radek .btn')].map(b => b.textContent.trim()),
    slozka: document.querySelectorAll('.qv-hotovo-radek .icon-btn').length,
    hromadne: [...document.querySelectorAll('.qv-konec .btn')].map(b => b.textContent.trim())
  }));
  say('  hotové video jde uložit do počítače bez publikování',
    stazeni.uTrhu.length === 3 && stazeni.uTrhu.every(t => /Uložit/.test(t)),
    stazeni.uTrhu.join(' · ') || 'není');
  say('  a všechna naráz jedním tlačítkem',
    stazeni.hromadne.some(t => /Uložit .* do počítače/.test(t)), stazeni.hromadne.join(' | '));
  say('  u každého jde i ukázat ve složce', stazeni.slozka === 3, `${stazeni.slozka}×`);
  await page.screenshot({ path: path.join(SHOTS, 'okno-social-video-hotovo.png') });

  /*
   * A do střihu se musí dát vejít z nabídky, ne jen přes příspěvek —
   * hledal se právě proto, že byl schovaný za „Otevřít" a sekcí médií.
   */
  const vNabidce = await page.evaluate(() =>
    [...document.querySelectorAll('.sidebar .side-item')].map(b => b.textContent.trim()));
  say('  střih videa je i v postranní nabídce',
    vNabidce.some(t => /Video s titulky/.test(t)), vNabidce.join(' · '));
  await page.close();
}

/* ---------- nástroj z nabídky Funkcí se otevře oknem ---------- */

{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', e => problems.push('hlavní okno: chyba stránky: ' + e.message));
  page.on('console', m => {
    if (m.type() === 'error' && !/favicon/.test(m.text() + m.location().url)) {
      problems.push('hlavní okno: konzole: ' + m.text());
    }
  });
  await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => { document.documentElement.dataset.form = 'desktop'; });
  });
  await page.goto('http://localhost:4324/index.html', { waitUntil: 'load' });
  await page.waitForTimeout(1000);

  await page.locator('.ig-switch button', { hasText: 'Funkce' }).first().click();
  await page.waitForTimeout(400);
  await page.locator('.ws-menu-item', { hasText: 'Katalog a naskladnění' }).first().click();
  await page.waitForTimeout(600);

  const volani = await page.evaluate(() => (window.__calls || []).filter(one => one[0] === 'tool:open'));
  say('klepnutí v nabídce otevře okno katalogu',
    volani.some(one => one[1] === 'catalog'), JSON.stringify(volani.slice(0, 2)));
  /*
   * A hlavně: pošta zůstane vidět. Právě kvůli tomu okna vznikla — dokud
   * se nástroj kreslil přes celé okno, nedalo se u něj nic vyřizovat.
   */
  say('a pošta zůstane v hlavním okně vidět',
    await page.locator('#root > .overlay').count() === 0);

  /*
   * Bannery jsou v nabídce nové — a nový nástroj je přesně to, u čeho se
   * zapomene doplnit jedno ze tří míst (seznam oken, nabídka, obsah okna).
   * Chybět může kterékoli a projeví se to tím, že klepnutí neudělá nic.
   */
  await page.locator('.ig-switch button', { hasText: 'Funkce' }).first().click();
  await page.waitForTimeout(400);
  await page.locator('.ws-menu-item', { hasText: 'Bannery' }).first().click();
  await page.waitForTimeout(600);
  const doBanneru = await page.evaluate(() =>
    (window.__calls || []).filter(one => one[0] === 'tool:open').map(one => one[1]));
  say('a Bannery se z nabídky otevřou vlastním oknem',
    doBanneru.includes('banners'), doBanneru.join(', '));

  /*
   * Zvýraznění otevřeného okna v nabídce. Seznam posílá hlavní proces
   * událostí — tady se pošle ručně, jako by okno právě vzniklo, a to až
   * nad otevřenou nabídkou: kdyby se poslal před ní, přepsal by ho dotaz,
   * kterým se nabídka při otevření ptá na stav, a zkouška by prošla
   * jenom díky tomu.
   */
  await page.locator('.ig-switch button', { hasText: 'Funkce' }).first().click();
  await page.waitForTimeout(400);
  await page.evaluate(() => window.__emit('tool:windows', ['catalog']));
  await page.waitForTimeout(300);
  const zvyrazneno = await page.locator('.ws-menu-item.on', { hasText: 'Katalog a naskladnění' }).count();
  say('otevřený nástroj je v nabídce zvýrazněný', zvyrazneno === 1, String(zvyrazneno));
  await page.screenshot({ path: path.join(SHOTS, 'okna-nabidka.png') });
  await page.close();
}

/* ---------- Bannery: živý náhled běží na skriptu z e-shopu ---------- */

/*
 * Tohle je to jediné, co se o bannerech z kódu nepozná: jestli se v okně
 * doopravdy vykreslí čtyři dlaždice vedle sebe, jestli mají stejnou výšku
 * (aby stránka nepodskakovala), jestli odpočet tiká a jestli se na telefonu
 * přerovnají na dvě vedle sebe. Náhled uvnitř běží na tomtéž skriptu, který
 * poběží na e-shopu, takže se tu zkouší rovnou on.
 */
{
  const page = await open('bannery');
  /*
   * Bez vybrané sady se náhled nekreslí — a je to tak správně: prázdné
   * okno by ukazovalo bannery, které nikdo nevybral. Zkouška proto začíná
   * klepnutím, jako by začínal člověk.
   */
  say('bez vybrané sady se náhled nekreslí',
    await page.locator('.bn-frame').count() === 0);
  await page.locator('.wt-row', { hasText: 'Podzimní sada' }).click();
  await page.waitForTimeout(900);

  const tvar = async () => page.frameLocator('.bn-frame').locator('.qbn-page.qbn-now').evaluate(node => {
    const cards = [...node.querySelectorAll('.qbn-card')];
    const rect = one => one.getBoundingClientRect();
    return {
      pocet: cards.length,
      sloupce: new Set(cards.map(one => Math.round(rect(one).left))).size,
      radky: new Set(cards.map(one => Math.round(rect(one).top))).size,
      vysky: cards.map(one => Math.round(rect(one).height)),
      siroka: Math.round(rect(cards[0]).width),
      okno: node.ownerDocument.documentElement.clientWidth,
      stary: node.ownerDocument.querySelector('#banner1') ? 'pořád tam je' : 'pryč',
      // Zůstal po původním karuselu obrázek, který se zbytečně stahuje?
      staryObrazek: node.ownerDocument.querySelectorAll('img[src*="stary-banner"]').length,
      odpocet: node.querySelector('.qbn-smart')?.textContent?.trim() ?? '',
      kod: node.querySelector('.qbn-code b')?.textContent?.trim() ?? '',
      vlocky: node.querySelectorAll('.qbn-flake').length,
      // Na kolika řádcích leží políčka odpočtu — na telefonu musí na jednom
      odpoctoveRadky: new Set([...node.querySelectorAll('.qbn-unit')]
        .map(one => Math.round(rect(one).top))).size,
      /*
       * Vyteklo něco z dlaždice? Zalomený odpočet vytlačí tlačítko pod
       * okraj a z banneru se pak nedá kliknout tam, kam má.
       */
      vyteklo: cards.filter(card => [...card.querySelectorAll(
        '.qbn-title, .qbn-text, .qbn-btn, .qbn-smart, .qbn-code, .qbn-chip')]
        .some(one => rect(one).bottom > rect(card).bottom + 1
          || rect(one).top < rect(card).top - 1
          || rect(one).right > rect(card).right + 1)).length,
      // Text musí ležet nad ztmavením, jinak ho fotka přebije
      poradi: [...node.querySelectorAll('.qbn-card > *')].map(one => one.className),
      /*
       * Typografie. Z kódu se nepozná, jestli se volby vůbec projeví —
       * proto se čtou z vykreslené stránky: váha a prostrkání nadpisu,
       * verzálky a to, že si banner s vlastním písmem o ně opravdu řekl.
       */
      nadpis: (() => {
        const t = node.querySelector('.qbn-title');
        if (!t) return null;
        const s = getComputedStyle(t);
        return {
          vaha: s.fontWeight, pismo: s.fontFamily.split(',')[0].replace(/["']/g, ''),
          prostrkani: s.letterSpacing, verzalky: s.textTransform
        };
      })(),
      // Tlačítko „jako na e-shopu" má nést třídy šablony, ne naši vlastní
      tlacitka: [...node.querySelectorAll('.qbn-body > span:last-child')]
        .map(one => one.className),
      tucne: node.querySelectorAll('.qbn-text b').length,
      kickery: node.querySelectorAll('.qbn-kicker').length,
      fontLink: node.ownerDocument.querySelectorAll('link[href*="fonts.googleapis"]').length,
      radiusy: [...node.querySelectorAll('.qbn-card')]
        .map(one => getComputedStyle(one).borderTopLeftRadius),
      /*
       * Kolik místa má blok nad sebou a pod sebou. Bez odsazení se banner
       * lepil na hlavičku i na obsah pod ním a stránka vypadala nedodělaně.
       */
      mezery: (() => {
        const blok = node.closest('.qbn');
        if (!blok) return null;
        /*
         * Měří se vzduch kolem **celého celku**, ne kolem mřížky: pruh
         * odkazů patří k banneru, takže mezi nimi je mezera menší a ta
         * velká je až pod pruhem. Kdyby se četla jen mřížka, vyšlo by
         * u sady s odkazy nula — a to je správně.
         */
        const doc = blok.ownerDocument;
        const pruh = doc.querySelector('.qbn-links');
        const konec = (pruh || blok).getBoundingClientRect().bottom;
        let pod = blok.nextElementSibling;
        while (pod && (pod === pruh || pod.getBoundingClientRect().height === 0)) {
          pod = pod.nextElementSibling;
        }
        const nad = blok.previousElementSibling;
        return {
          nad: nad ? Math.round(blok.getBoundingClientRect().top - nad.getBoundingClientRect().bottom) : 999,
          pod: pod ? Math.round(pod.getBoundingClientRect().top - konec) : 999,
          kotva: getComputedStyle(blok).overflowAnchor
        };
      })(),
      /*
       * Rozsah padajících emoji. Padají se zápornými zpožděními, takže
       * v každém okamžiku jsou rozeseté po celé dráze — vzdálenost mezi
       * nejvyšším a nejnižším tedy měří, jak daleko dolet dosáhne. Dřív
       * se posouvalo v procentech velikosti samotného znaku a sníh padal
       * jen v horním proužku dlaždice.
       */
      padani: (() => {
        const karta = [...node.querySelectorAll('.qbn-card')]
          .find(one => one.querySelector('.qbn-flake'));
        if (!karta) return null;
        const kraje = [...karta.querySelectorAll('.qbn-flake')]
          .map(one => one.getBoundingClientRect().top - karta.getBoundingClientRect().top);
        return {
          rozsah: Math.round(Math.max(...kraje) - Math.min(...kraje)),
          vyska: Math.round(karta.getBoundingClientRect().height)
        };
      })(),
      /*
       * Zarovnání textu. Kontejner šablony e-shopu má „text-align: center"
       * a dědí se — banner nastavený doleva se proto na webu kreslil na
       * střed, zatímco v aplikaci vypadal správně. Čte se tedy skutečné
       * zarovnání z vykreslené stránky, ne nastavení.
       */
      zarovnani: [...node.querySelectorAll('.qbn-card')].map(one => ({
        chtene: one.getAttribute('data-align'),
        skutecne: getComputedStyle(one.querySelector('.qbn-title') ?? one).textAlign
      })),
      /*
       * Video na pozadí. Do stažení musí být průhledné, aby prosvítala
       * fotka — jinak by na úvodní stránce blikl černý obdélník. A musí
       * být němé a ve smyčce, jinak ho prohlížeč na telefonu nepustí.
       */
      video: (() => {
        const vid = node.querySelector('.qbn-video');
        if (!vid) return null;
        const karta = vid.closest('.qbn-card');
        const styl = getComputedStyle(vid);
        return {
          nemy: vid.muted === true,
          smycka: vid.loop === true,
          vRamci: vid.hasAttribute('playsinline'),
          podTextem: [...karta.children].indexOf(vid)
            < [...karta.children].findIndex(one => one.classList.contains('qbn-body')),
          kryje: Math.round(vid.getBoundingClientRect().width)
            === Math.round(karta.getBoundingClientRect().width),
          // Nehraje (adresa v náhledu nikam nevede) — tak nesmí být vidět
          skryte: Number(styl.opacity) === 0,
          orez: styl.objectFit
        };
      })(),
      /*
       * Bloky pod bannerem (v šabloně e-shopu „highlights"). Kreslí se
       * samostatně, protože na kategoriích a v článcích žádný banner
       * není — a právě tam ty bloky nesou kampaň.
       */
      bloky: (() => {
        const blok = node.ownerDocument.querySelector('.qhl');
        if (!blok) return null;
        const karty = [...blok.querySelectorAll('.qbn-card')];
        return {
          pocet: karty.length,
          rozvrzeni: blok.getAttribute('data-layout'),
          sloupce: new Set(karty.map(one => Math.round(one.getBoundingClientRect().left))).size,
          /*
           * Ze šablony se bere obsah, ne sekce. Sekce zůstává, protože
           * nese pozadí i odsazení — bez ní spadly bloky na bílé pozadí
           * stránky a v místě bloků byl bílý pruh. Musí tedy zmizet
           * původní obsah (obrázky ze šablony) a naše bloky musí být
           * uvnitř té sekce, ne vedle ní.
           */
          puvodni: node.ownerDocument.querySelectorAll('.bic-hdln img').length,
          vSekci: !!blok.closest('.bic-hdln'),
          pozadiSekce: (() => {
            const sekce = node.ownerDocument.querySelector('.bic-hdln');
            return sekce ? node.ownerDocument.defaultView.getComputedStyle(sekce).backgroundColor : '';
          })(),
          pruhlednost: (() => {
            const sekce = node.ownerDocument.querySelector('.bic-hdln');
            return sekce ? node.ownerDocument.defaultView.getComputedStyle(sekce).opacity : '';
          })(),
          odkryto: (() => {
            const sekce = node.ownerDocument.querySelector('.bic-hdln');
            if (!sekce) return false;
            const css = node.ownerDocument.defaultView.getComputedStyle(sekce);
            return !/\banim\b/.test(sekce.className) && css.opacity === '1' && css.visibility === 'visible';
          })(),
          // Blok v jiné podobě: text leží pod fotkou, ne na ní
          podoby: karty.map(one => one.getAttribute('data-style')),
          /* Na telefonu se z bloků dělá posuvník — prstem do strany, s tečkami */
          posuvnik: (() => {
            const track = node.ownerDocument.querySelector('.qhl .qbn-track');
            if (!track) return null;
            const prvni = track.children[0];
            return {
              tecek: node.ownerDocument.querySelectorAll('.qhl .qbn-dot').length,
              // Druhá dlaždice musí vykukovat, jinak nikdo nepozná, že se dá posunout
              vykukuje: track.scrollWidth > track.clientWidth + 20,
              sirkaPrvni: prvni ? Math.round(prvni.getBoundingClientRect().width) : 0,
              sirkaPasu: Math.round(track.clientWidth)
            };
          })(),
          textMimoFotku: (() => {
            const jiny = karty.find(one => one.getAttribute('data-style') === 'under');
            if (!jiny) return 'není';
            const foto = jiny.querySelector('.qbn-photo').getBoundingClientRect();
            const telo = jiny.querySelector('.qbn-body').getBoundingClientRect();
            return telo.top >= foto.bottom - 2 ? 'pod fotkou' : 'na fotce';
          })()
        };
      })(),
      // Pruh odkazů na kategorie pod bannerem
      odkazy: (() => {
        const pruh = node.ownerDocument.querySelector('.qbn-links');
        const blok = node.closest('.qbn');
        if (!pruh || !blok) return null;
        const kresba = pruh.querySelector('.qbn-link-ico[data-kresba]');
        return {
          pocet: pruh.querySelectorAll('.qbn-link').length,
          podBannerem: pruh.getBoundingClientRect().top >= blok.getBoundingClientRect().bottom - 2,
          sTextem: pruh.querySelectorAll('.qbn-link-text').length,
          /*
           * Nakreslená ikonka se nesmí roztáhnout přes celé kolečko jako
           * fotka — obrys kravaty od kraje ke kraji vypadá jako chyba.
           */
          kresbaMaVzduch: kresba
            ? getComputedStyle(kresba).backgroundSize.replace(/\s+/g, ' ')
            : 'není',
          /*
           * Rovnoměrnost pruhu. Dokud se šířka brala z délky popisku,
           * měly „Kravaty" a „Šle a Motýlek" jiný rozestup, ikonky
           * nesedly proti sobě a při víc kategoriích z toho byl na
           * počítači posuvník. Měří se skutečné obdélníky, ne pravidla.
           */
          /*
           * Rytmus rozestupů. Nad bannerem má být tolik místa jako mezi
           * bannerem a bloky pod ním — dřív bylo nahoře 44 a dole 88 bodů,
           * protože sousední sekce svoje rozestupy sčítaly.
           */
          rytmus: (() => {
            const sekce = blok.closest('.section') || blok.parentElement;
            const bloky = node.ownerDocument.querySelector('.qhl');
            if (!sekce) return null;
            const nad = Math.round(blok.getBoundingClientRect().top - sekce.getBoundingClientRect().top);
            const mezi = bloky
              ? Math.round(bloky.getBoundingClientRect().top - pruh.getBoundingClientRect().bottom)
              : null;
            return { nad, mezi, sedi: mezi === null || Math.abs(nad - mezi) <= 4 };
          })(),
          sloupce: (() => {
            const polozky = [...pruh.querySelectorAll('.qbn-link')];
            if (polozky.length < 2) return null;
            const r = polozky.map(one => one.getBoundingClientRect());
            const sirky = r.map(one => Math.round(one.width));
            const mezery = r.slice(1).map((one, i) => Math.round(one.left - r[i].right));
            const ikony = [...pruh.querySelectorAll('.qbn-link-ico')]
              .map(one => Math.round(one.getBoundingClientRect().top));
            return {
              stejneSiroke: Math.max(...sirky) - Math.min(...sirky) <= 1,
              stejneMezery: mezery.length === 0 || Math.max(...mezery) - Math.min(...mezery) <= 1,
              ikonyVRade: ikony.length === 0 || Math.max(...ikony) - Math.min(...ikony) <= 1,
              // Na počítači se pruh nesmí posouvat do strany
              bezPosuvniku: pruh.scrollWidth <= pruh.clientWidth + 1,
              naStred: Math.abs(
                (r[0].left - pruh.getBoundingClientRect().left)
                - (pruh.getBoundingClientRect().right - r[r.length - 1].right)
              ) <= 2,
              sirky: sirky.join('/'),
              mezery: mezery.join('/')
            };
          })()
        };
      })()
    };
  });

  const pc = await tvar();
  say('náhled kreslí čtyři dlaždice vedle sebe',
    pc.pocet === 4 && pc.sloupce === 4 && pc.radky === 1,
    `${pc.pocet} dlaždic, ${pc.sloupce} sloupců, ${pc.radky} řádek`);
  /*
   * Stejná výška je to, co drží stránku v klidu. Rozdíl by znamenal, že
   * poměr stran neplatí a že se obsah pod bannerem hne, jakmile dotečou
   * fotky — přesně to, co bylo zadané, že se dít nesmí.
   */
  say('  a mají stejnou výšku, takže stránka nepodskakuje',
    new Set(pc.vysky).size === 1, pc.vysky.join(' / '));
  /*
   * Schovat nestačilo. Karusel si i neviditelný dál stahoval své fotky
   * a sám sahal na rolování stránky — na telefonu kvůli tomu při rolování
   * nahoru přeskakovalo na banner a hlavička e-shopu se nedala uvidět.
   */
  say('  původní karusel je ze stránky pryč', pc.stary === 'pryč', pc.stary);
  say('  a jeho fotky se nestahují', pc.staryObrazek === 0, `${pc.staryObrazek} obrázků`);
  say('  odpočet je vidět', /\d/.test(pc.odpocet), pc.odpocet.replace(/\s+/g, ' ').slice(0, 40));
  say('  slevový kód taky', pc.kod === 'SLEVA10', pc.kod);

  /*
   * Tlačítka v barvách e-shopu. Měří se **vykreslená** barva, ne
   * nastavení: zelená se bere z proměnné e-shopu (--gr) a překlep
   * v názvu proměnné by se v kódu nepoznal — tlačítko by prostě
   * zůstalo průhledné a nikdo by nevěděl proč.
   */
  await page.locator('.bn-parts .tab', { hasText: 'Styl sady' }).first().click();
  const tlacitko = page.locator('.field', { hasText: 'Tlačítko' }).locator('select').first();
  const ZELENA = 'rgb(172, 194, 171)';
  const zmer = async volba => {
    await tlacitko.selectOption(volba);
    await page.waitForTimeout(700);
    return page.frameLocator('.bn-frame').locator('.qbn-btn').first().evaluate(node => {
      const css = getComputedStyle(node);
      return { pozadi: css.backgroundColor, pismo: css.color, ramecek: css.borderTopColor };
    });
  };
  const plne = await zmer('green');
  say('  plné zelené tlačítko má zelenou e-shopu',
    plne.pozadi === ZELENA, `pozadí ${plne.pozadi}, písmo ${plne.pismo}`);
  await page.screenshot({ path: path.join(SHOTS, 'bannery-tlacitka.png') });
  const obrys = await zmer('greenline');
  say('  zelený obrys má zelený rámeček i písmo, ale průhledné pozadí',
    obrys.ramecek === ZELENA && obrys.pismo === ZELENA
      && obrys.pozadi === 'rgba(0, 0, 0, 0)',
    `rámeček ${obrys.ramecek}, písmo ${obrys.pismo}, pozadí ${obrys.pozadi}`);
  const tmave = await zmer('dark');
  say('  plné černé je černé s bílým písmem',
    tmave.pismo === 'rgb(255, 255, 255)' && /rgb\(0, 0, 0\)|rgb\(20, 21, 15\)/.test(tmave.pozadi),
    `pozadí ${tmave.pozadi}, písmo ${tmave.pismo}`);
  await tlacitko.selectOption('shop');
  await page.waitForTimeout(500);
  await page.locator('.bn-parts .tab', { hasText: 'Obsah' }).first().click();
  await page.waitForTimeout(300);
  /*
   * Fotka je první věc v editaci. Dřív se nahrávala až ve druhé záložce
   * pod typografií — nejčastější úkon byl nejhůř dostupný a nováček
   * banner bez fotky vzdal. Měří se pořadí na obrazovce, ne to, že plocha
   * někde v kódu existuje.
   */
  const poradiEditace = await page.evaluate(() => {
    const drop = document.querySelector('.bn-drop');
    const nadpis = [...document.querySelectorAll('.bn-edit .field')]
      .find(one => one.querySelector('label')?.textContent?.trim().startsWith('Nadpis'));
    return {
      plocha: !!drop,
      nadFormularem: !!drop && !!nadpis
        && drop.getBoundingClientRect().top < nadpis.getBoundingClientRect().top,
      vysoka: drop ? Math.round(drop.getBoundingClientRect().height) : 0,
      // Plocha musí přijímat i pusť­ení souboru, ne jen kliknutí
      bereSoubor: !!drop && !!drop.querySelector('input[type="file"]')
    };
  });
  say('  fotka se nahrává hned v první záložce, nad texty',
    poradiEditace.plocha && poradiEditace.nadFormularem && poradiEditace.bereSoubor
      && poradiEditace.vysoka > 60,
    `plocha ${poradiEditace.vysoka} px, nad nadpisem ${poradiEditace.nadFormularem}`);
  say('  a emoji uvnitř banneru padají', pc.vlocky > 4, `${pc.vlocky} kusů`);
  say('  text leží nad ztmavením fotky',
    pc.poradi.join(',').endsWith('qbn-body'), pc.poradi.join(' → '));

  /*
   * Design se má držet e-shopu, a to znamená konkrétní čísla: nadpisy tam
   * jedou ve váze 400 se staženým prostrkáním a rohy jsou hranaté. Kdyby
   * se volby v okně nikam nepropsaly, vypadalo by to v aplikaci správně
   * a na webu jinak — proto se čtou z vykreslené stránky.
   */
  say('  nadpis si bere zvolenou tloušťku i písmo',
    pc.nadpis?.vaha === '700' && pc.nadpis?.pismo === 'Jost',
    `${pc.nadpis?.vaha} · ${pc.nadpis?.pismo} · ${pc.nadpis?.prostrkani}`);
  say('  vlastní písmo se opravdu stahuje', pc.fontLink > 0, `${pc.fontLink} odkazů`);
  say('  hranaté rohy podle e-shopu, zaoblené jen kde se řeklo',
    pc.radiusy.filter(one => one === '0px').length === 3
      && pc.radiusy.some(one => one === '14px'), pc.radiusy.join(' / '));
  say('  tlačítko „jako na e-shopu" nese třídy šablony',
    pc.tlacitka.some(one => one.includes('bg-pr')), pc.tlacitka.join(' | '));
  say('  a hvězdičky v textu udělaly tučné slovo', pc.tucne >= 4, `${pc.tucne} slov`);
  say('  řádek nad nadpisem je vidět', pc.kickery >= 3, `${pc.kickery} banneru`);
  /*
   * Vzduch kolem bloku a to, že blok nedělá „kotvu" rolování — na telefonu
   * kvůli ní při rolování nahoru přeskakovalo rovnou na banner a hlavička
   * e-shopu se nedala uvidět.
   */
  say('  blok má nad sebou i pod sebou vzduch',
    !!pc.mezery && pc.mezery.nad >= 18 && pc.mezery.pod >= 18,
    pc.mezery ? `${pc.mezery.nad} / ${pc.mezery.pod} px` : 'nezměřeno');
  say('  a nepřetahuje si rolování stránky',
    pc.mezery?.kotva === 'none', pc.mezery?.kotva ?? '');
  /*
   * Emoji musí padat přes celou dlaždici. Dřív se posouvalo v procentech
   * velikosti znaku, takže z patnácti pixelů vyšlo pár desítek bodů a
   * sníh se sypal jen v horním proužku.
   */
  say('  padající emoji projdou celou dlaždicí',
    !!pc.padani && pc.padani.rozsah > pc.padani.vyska * 0.55,
    pc.padani ? `${pc.padani.rozsah} z ${pc.padani.vyska} px` : 'nezměřeno');
  // Pruh odkazů na kategorie — pod bannerem, ne v něm
  /*
   * Zarovnání se nesmí dědit ze stránky. Tahle kontrola je tu proto, že
   * chyba prošla vším ostatním: v aplikaci banner stál vlevo, na webu na
   * střed, a poznalo se to až na e-shopu.
   */
  say('  zarovnání textu odpovídá nastavení',
    pc.zarovnani.every(one => one.chtene === one.skutecne),
    pc.zarovnani.map(one => `${one.chtene}→${one.skutecne}`).join(' '));
  say('  video na pozadí je němé, ve smyčce a v rámci stránky',
    !!pc.video && pc.video.nemy && pc.video.smycka && pc.video.vRamci,
    pc.video ? JSON.stringify(pc.video) : 'vrstva videa se nevykreslila');
  say('  kryje celou dlaždici a leží pod textem',
    !!pc.video && pc.video.kryje && pc.video.podTextem && pc.video.orez === 'cover',
    pc.video ? `${pc.video.orez}, pod textem ${pc.video.podTextem}` : 'nezměřeno');
  /*
   * Dokud video nehraje, musí prosvítat fotka. Tady se nestáhne nikdy
   * (adresa v náhledu nikam nevede), takže se rovnou ověří i ten případ,
   * na kterém záleží nejvíc: když se video nepovede stáhnout ani na webu.
   */
  say('  a než naběhne, není po něm na dlaždici stopa',
    !!pc.video && pc.video.skryte, pc.video ? `průhlednost ${pc.video.skryte}` : 'nezměřeno');
  say('  nakreslená ikonka v pruhu má kolem sebe vzduch',
    pc.odkazy?.kresbaMaVzduch === '52%', pc.odkazy?.kresbaMaVzduch);
  say('  bloky pod bannerem se vykreslily místo těch ze šablony',
    pc.bloky?.pocet === 4 && pc.bloky?.puvodni === 0,
    pc.bloky ? `${pc.bloky.pocet} bloků, ${pc.bloky.rozvrzeni}, ze šablony zbylo ${pc.bloky.puvodni}` : 'nejsou');
  /*
   * Bloky si berou obsah sekce, ne sekci. Sekce nese pozadí ze šablony
   * (na quentino.cz lehce šedé) — když se odstraňovala celá, vznikl
   * v místě bloků bílý pruh, který na stránce nikde jinde není.
   */
  say('  a zůstaly v sekci šablony, i s jejím pozadím',
    pc.bloky?.vSekci === true && pc.bloky?.pozadiSekce === 'rgb(240, 240, 240)',
    `v sekci ${pc.bloky?.vSekci}, pozadí ${pc.bloky?.pozadiSekce}`);
  /*
   * Šablona má na té sekci třídu "anim" — obsah je do příjezdu do obrazu
   * průhledný a odkrývá ho skript šablony, který o našich blocích neví.
   * Odkrytí si proto děláme sami; bez něj by bloky byly neviditelné.
   */
  say('  a jsou vidět, i když je sekce animovaná',
    pc.bloky?.odkryto === true, `průhlednost sekce ${pc.bloky?.pruhlednost}`);
  say('  a mozaika je opravdu dva sloupce', pc.bloky?.sloupce === 2, `${pc.bloky?.sloupce} sloupce`);
  /*
   * Podoba dlaždice mění i sazbu, ne jen barvu: u „text pod fotkou" musí
   * text ležet mimo fotku, jinak je to pořád tentýž banner s ozdobou.
   */
  say('  blok s textem pod fotkou ho má opravdu pod ní',
    pc.bloky?.textMimoFotku === 'pod fotkou', String(pc.bloky?.textMimoFotku));
  say('  odkazy stojí ve stejně širokých sloupcích a rovnoměrně',
    pc.odkazy?.sloupce?.stejneSiroke === true && pc.odkazy?.sloupce?.stejneMezery === true
      && pc.odkazy?.sloupce?.ikonyVRade === true && pc.odkazy?.sloupce?.bezPosuvniku === true
      && pc.odkazy?.sloupce?.naStred === true,
    pc.odkazy?.sloupce
      ? `šířky ${pc.odkazy.sloupce.sirky}, mezery ${pc.odkazy.sloupce.mezery}, `
        + `bez posuvníku ${pc.odkazy.sloupce.bezPosuvniku}, na střed ${pc.odkazy.sloupce.naStred}`
      : 'nezměřeno');
  say('  nad bannerem je stejně místa jako pod pruhem odkazů',
    pc.odkazy?.rytmus?.sedi === true,
    `nad ${pc.odkazy?.rytmus?.nad} px, mezi pruhem a bloky ${pc.odkazy?.rytmus?.mezi} px`);
  say('  pruh odkazů je pod bannerem',
    pc.odkazy?.pocet === 4 && pc.odkazy?.podBannerem === true && pc.odkazy?.sTextem === 4,
    pc.odkazy ? `${pc.odkazy.pocet} odkazů, pod blokem ${pc.odkazy.podBannerem}` : 'není');

  // Odpočet počítá prohlížeč, ne aplikace — musí se hýbat i bez zásahu
  const predtim = pc.odpocet;
  await page.waitForTimeout(1400);
  const potom = (await tvar()).odpocet;
  say('  a tiká sám', potom !== predtim && /\d/.test(potom), `${predtim.replace(/\s+/g, ' ').slice(0, 24)} → ${potom.replace(/\s+/g, ' ').slice(0, 24)}`);

  await page.screenshot({ path: path.join(SHOTS, 'bannery-pc.png') });

  await page.locator('.bn-devices .tab', { hasText: 'Telefon' }).click();
  await page.waitForTimeout(900);
  const mobil = await tvar();
  say('  bloky se na telefonu posouvají prstem',
    mobil.bloky?.posuvnik?.tecek === 4 && mobil.bloky?.posuvnik?.vykukuje === true,
    mobil.bloky?.posuvnik
      ? `${mobil.bloky.posuvnik.tecek} teček, dlaždice ${mobil.bloky.posuvnik.sirkaPrvni}`
        + ` z ${mobil.bloky.posuvnik.sirkaPasu} px`
      : 'posuvník se nevykreslil');
  say('na telefonu se přerovnají na dvě vedle sebe',
    mobil.sloupce === 2 && mobil.radky === 2,
    `${mobil.sloupce} sloupce, ${mobil.radky} řádky`);
  say('  a dlaždice jsou pořád stejně vysoké',
    new Set(mobil.vysky).size === 1, mobil.vysky.join(' / '));
  /*
   * Na půlce telefonu je dlaždice úzká a je to jediné místo, kde se obsah
   * banneru doopravdy pere o místo. Zalomený odpočet by vytlačil tlačítko
   * pod okraj a z banneru by se nedalo kliknout tam, kam má.
   */
  say('  odpočet se vejde na jeden řádek', mobil.odpoctoveRadky === 1,
    `${mobil.odpoctoveRadky} řádků`);
  say('  a nic z dlaždice nevyteklo', mobil.vyteklo === 0, `${mobil.vyteklo} dlaždic`);
  /*
   * Tvar dlaždice. Na telefonu byl natvrdo čtverec a na dva řádky nadpisu,
   * popisek a tlačítko v něm nezbývalo místo — proto se dá přepsat. Zkouší
   * se skutečným přepnutím v okně, ne nastavením v datech.
   */
  const pomer = async () => page.frameLocator('.bn-frame').locator('.qbn-card').first()
    .evaluate(one => {
      const r = one.getBoundingClientRect();
      return Math.round((r.width / r.height) * 100) / 100;
    });
  const ctverec = await pomer();
  await page.locator('.bn-sections .tab', { hasText: 'Sada' }).click();
  await page.waitForTimeout(300);
  await page.locator('.bn-layout select').last().selectOption('2:3');
  await page.waitForTimeout(900);
  const navysku = await pomer();
  say('tvar dlaždice na telefonu se dá přepnout na výšku',
    Math.abs(ctverec - 1) < 0.06 && Math.abs(navysku - 2 / 3) < 0.06,
    `${ctverec} → ${navysku}`);
  await page.locator('.bn-layout select').last().selectOption('auto');

  /*
   * Posuvník pro **hlavní banner** na telefonu. Čtyři dlaždice pod sebou
   * se na telefonu prorolují dřív, než si je kdo přečte; posuvník ukáže
   * jednu, druhou nechá vykukovat a tečky řeknou, kolik jich je. Zkouší
   * se to proklikáním, protože jinak se nedá poznat, že volba opravdu
   * mění to, co je na obrazovce.
   */
  await page.locator('.bn-layout .tab', { hasText: 'Posuvník' }).first().click();
  await page.waitForTimeout(900);
  const posuv = await page.frameLocator('.bn-frame').locator('.qbn').evaluate(node => {
    const track = node.querySelector('.qbn-track');
    if (!track) return null;
    const prvni = track.children[0];
    return {
      dlazdic: track.children.length,
      tecek: node.querySelectorAll('.qbn-dot').length,
      // Druhá dlaždice musí vykukovat, jinak to vypadá jako jediný banner
      vykukuje: track.scrollWidth > track.clientWidth + 20,
      jedenRadek: new Set([...track.children].map(one => Math.round(one.getBoundingClientRect().top))).size === 1,
      sirka: prvni ? Math.round(prvni.getBoundingClientRect().width) : 0,
      pas: Math.round(track.clientWidth),
      /*
       * Barva teček. Dřív se braly z barvy textu šablony, což je modrá
       * odkazů — tečky pak byly jediný modrý prvek na stránce. Mají mít
       * šalvějovou zelenou e-shopu, a to z **jeho** proměnné, ať se
       * přebarví s ním.
       */
      barvaTecky: (() => {
        const tecka = node.querySelector('.qbn-dot');
        return tecka ? getComputedStyle(tecka).backgroundColor : '';
      })(),
      cinnaJinak: (() => {
        const vsechny = [...node.querySelectorAll('.qbn-dot')];
        const cinna = vsechny.find(one => one.hasAttribute('data-now'));
        const jina = vsechny.find(one => !one.hasAttribute('data-now'));
        if (!cinna || !jina) return false;
        return Number(getComputedStyle(cinna).opacity) > Number(getComputedStyle(jina).opacity)
          && cinna.getBoundingClientRect().width > jina.getBoundingClientRect().width;
      })()
    };
  });
  say('hlavní banner se dá na telefonu přepnout na posuvník',
    posuv?.dlazdic === 4 && posuv?.tecek === 4 && posuv?.vykukuje === true && posuv?.jedenRadek === true,
    posuv ? `${posuv.dlazdic} dlaždic v řadě, ${posuv.tecek} teček, ${posuv.sirka} z ${posuv.pas} px`
      : 'posuvník se nevykreslil');
  say('  tečky mají šalvějovou zelenou e-shopu, ne modrou od textu',
    posuv?.barvaTecky === 'rgb(172, 194, 171)', posuv?.barvaTecky);
  say('  a na té činné je poznat, která to je',
    posuv?.cinnaJinak === true, 'rozdíl v sytosti i velikosti');
  await page.screenshot({ path: path.join(SHOTS, 'bannery-posuvnik.png') });

  /*
   * Posuvník dokola. Bez něj se na poslední dlaždici přetočí zpátky na
   * začátek — celá sada proletí pod rukama zpátky a vypadá to jako
   * chyba. Zkouší se to, co se děje ve stránce: za originály musí
   * přibýt kopie, teček zůstat tolik, kolik je opravdových dlaždic,
   * a odrolování na konec se musí samo vrátit o jednu sadu zpátky.
   */
  await page.locator('.check-row', { hasText: 'Posuvník dokola' }).locator('input').check();
  await page.waitForTimeout(900);
  const dokola = await page.frameLocator('.bn-frame').locator('.qbn').evaluate(async node => {
    const track = node.querySelector('.qbn-track');
    if (!track) return null;
    const tecek = node.querySelectorAll('.qbn-dot').length;
    const dlazdic = track.children.length;
    const kopie = [...track.children].filter(one => one.getAttribute('aria-hidden') === 'true');
    const sada = kopie.length
      ? kopie[0].offsetLeft - track.children[0].offsetLeft
      : 0;
    /*
     * Odrolovat až na první kopii a počkat, až si to posuvník srovná.
     *
     * Čeká se, dokud se to nestane — ne pevných 400 ms. Srovnání je ve
     * skriptu odložené o 120 ms po rolování (uprostřed tahu prstem by
     * posun ucukl pod rukou) a při pevném čekání zkouška občas spadla:
     * ne proto, že by se posuvník nesrovnal, ale proto, že časovač pod
     * zátěží doběhl o chvíli později. Padající zkouška, která nic
     * neříká o kódu, je horší než žádná.
     */
    track.scrollLeft = sada;
    for (let pokus = 0; pokus < 40 && track.scrollLeft > sada / 2; pokus++) {
      await new Promise(r => setTimeout(r, 50));
    }
    return {
      dlazdic,
      tecek,
      kopii: kopie.length,
      // Kopie nesmí mít vlastní video ani padající emoji
      videaVKopii: kopie.reduce((n, one) => n + one.querySelectorAll('video,.qbn-fx').length, 0),
      poSrovnani: Math.round(track.scrollLeft),
      sada: Math.round(sada)
    };
  });
  say('  posuvník se dá přepnout na otáčení dokola',
    dokola?.kopii === 4 && dokola?.dlazdic === 8 && dokola?.tecek === 4,
    `${dokola?.dlazdic} dlaždic, z toho ${dokola?.kopii} kopií, ${dokola?.tecek} teček`);
  say('  a na konci se vrátí na začátek, aniž by to bylo vidět',
    !!dokola && dokola.sada > 0 && dokola.poSrovnani < dokola.sada / 2,
    `po srovnání ${dokola?.poSrovnani} z ${dokola?.sada} px`);
  say('  kopie nestahují video ani nepouštějí efekty znovu',
    dokola?.videaVKopii === 0, `${dokola?.videaVKopii} navíc`);
  await page.locator('.check-row', { hasText: 'Posuvník dokola' }).locator('input').uncheck();
  await page.waitForTimeout(500);
  await page.locator('.bn-layout .tab', { hasText: '2 vedle sebe' }).first().click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(SHOTS, 'bannery-sada.png') });
  await page.locator('.bn-sections .tab', { hasText: 'Bannery' }).click();
  await page.waitForTimeout(600);

  await page.screenshot({ path: path.join(SHOTS, 'bannery-mobil.png') });

  /*
   * Druhá sada je „jeden přes celou šířku". Kdyby se rozvržení nepřeneslo
   * do náhledu, ukázaly by se čtyři sloupce a nikdo by nepoznal, že si
   * vybral něco jiného.
   */
  await page.locator('.bn-devices .tab', { hasText: 'Počítač' }).click();
  await page.locator('.wt-row', { hasText: 'Black Friday' }).click();
  await page.waitForTimeout(900);
  const siroky = await tvar();
  say('široká sada je jeden banner přes celou šířku',
    siroky.pocet === 1 && siroky.siroka > siroky.okno * 0.8,
    `${siroky.pocet} dlaždice, ${siroky.siroka} z ${siroky.okno} px`);
  /*
   * Víc než den odpočtu ukazuje dny a vteřiny schovává. „2 dní" je přesně
   * ta drobnost, kvůli které banner vypadá, že ho dělal někdo cizí — proto
   * se skloňování čte ze skutečně vykresleného textu.
   */
  say('  a odpočet ve dnech se skloňuje',
    /\d+\s*(den|dny|dní)/.test(siroky.odpocet) && !/vteřin/.test(siroky.odpocet),
    siroky.odpocet.replace(/\s+/g, ' ').slice(0, 40));
  await page.screenshot({ path: path.join(SHOTS, 'bannery-siroky.png') });

  /*
   * Náhled přes celé okno. Zmenšený na necelou polovinu se dá posoudit
   * rozvržení, ale ne text — a texty na bannerech jsou to, kvůli čemu se
   * na náhled kouká.
   */
  await page.locator('.bn-devices .icon-btn').click();
  await page.waitForTimeout(700);
  const velky = await page.evaluate(() => {
    const frame = document.querySelector('.bn-frame');
    const t = getComputedStyle(frame).transform;
    const m = /matrix\(([\d.]+)/.exec(t);
    return { merítko: m ? Number(m[1]) : 1, editor: document.querySelectorAll('.bn-edit').length };
  });
  say('náhled se dá rozložit přes celé okno',
    velky.merítko > 0.85, `měřítko ${Math.round(velky.merítko * 100)} %`);
  await page.screenshot({ path: path.join(SHOTS, 'bannery-velky.png') });
  await page.locator('.bn-devices .icon-btn').click();
  await page.waitForTimeout(400);

  /*
   * Odkazy pod bannerem. Dvě věci, které se jinak nedají ověřit než
   * proklikáním: že se jazyk přepíná **přímo u odkazů** (dřív se muselo
   * překlikávat jazyk náhledu vpravo, aby vůbec bylo vidět, co je pro SK
   * vyplněné) a že nakreslená ikonka od AI se dá vybrat a opravdu se
   * nastaví.
   */
  await page.locator('.wt-row', { hasText: 'Podzimní sada' }).click();
  await page.waitForTimeout(600);
  await page.locator('.bn-edit .tabs .tab', { hasText: 'Odkazy' }).first().click();
  await page.waitForTimeout(400);
  const jazyky = await page.evaluate(() => {
    const chips = [...document.querySelectorAll('.bn-link-row')][0]
      ?.querySelectorAll('.bn-chip') ?? [];
    return [...chips].map(one => `${one.textContent.trim()}:${one.className.replace('bn-chip ', '')}`);
  });
  say('u každého odkazu je vidět stav jazyků',
    jazyky.length === 3 && jazyky[0].includes('ok') && jazyky[2].includes('miss'),
    jazyky.join(' '));

  await page.locator('.bn-link-row').first().locator('button', { hasText: 'Ikonka od AI' }).click();
  await page.waitForTimeout(700);
  const navrhy = await page.locator('.bn-icon-pick').count();
  say('  a ikonku nakreslí AI ve víc variantách', navrhy >= 2, `${navrhy} návrhy`);
  await page.screenshot({ path: path.join(SHOTS, 'bannery-odkazy.png') });

  await page.locator('.bn-icon-pick').nth(1).click();
  await page.waitForTimeout(500);
  const vybrana = await page.evaluate(() => {
    const ico = document.querySelector('.bn-link-row .bn-link-ico');
    const styl = ico ? getComputedStyle(ico) : null;
    return {
      obrazek: styl?.backgroundImage.slice(0, 30) ?? '',
      // Kresba se nesmí roztáhnout přes celé kolečko jako fotka
      velikost: styl?.backgroundSize ?? '',
      nabidkaZavrena: document.querySelectorAll('.bn-icon-pick').length === 0
    };
  });
  say('  vybraná ikonka se nastaví do odkazu',
    vybrana.obrazek.includes('data:image/svg') && vybrana.velikost === '58%'
    && vybrana.nabidkaZavrena,
    `${vybrana.velikost} · nabídka zavřená ${vybrana.nabidkaZavrena}`);

  // Skript pro šablonu e-shopu se dá zkopírovat, i když je vidět jen v záložce
  await page.locator('.wt-head-right .tab', { hasText: 'Kód do e-shopu' }).click();
  await page.waitForTimeout(400);
  const kod = await page.locator('.bn-script').inputValue();
  say('záložka nabízí skript do šablony', kod.includes('qbn') && kod.includes('<script>'),
    `${kod.length} znaků`);
  /*
   * Komentáře do e-shopu neodcházejí — s nimi měl skript přes 61 000
   * znaků a pole v administraci Upgates ho odmítlo uložit. Velikost je
   * proto vidět rovnou u tlačítka, aby se to příště poznalo dřív.
   */
  say('  a je bez komentářů, aby se do Upgates vešel',
    kod.length < 45_000 && !kod.includes('Otočení telefonu'), `${kod.length} znaků`);
  const velikost = await page.locator('.bn-code .desc').last().innerText();
  say('  velikost skriptu je u tlačítka vidět', /\d+ tisíc znaků/.test(velikost), velikost.trim());
  await page.screenshot({ path: path.join(SHOTS, 'bannery-kod.png') });
  await page.close();
}

/* ---------- okno se otevře rovnou na rozdělané práci ---------- */

{
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  page.on('pageerror', e => problems.push('katalog s naskladněním: chyba stránky: ' + e.message));
  await page.addInitScript(() => {
    window.__toolArg = 'st1';
    document.addEventListener('DOMContentLoaded', () => { document.documentElement.dataset.form = 'desktop'; });
  });
  await page.goto('http://localhost:4324/index.html#katalog', { waitUntil: 'load' });
  await page.waitForTimeout(1200);
  const zeptalo = await page.evaluate(() =>
    (window.__calls || []).some(one => one[0] === 'tool:arg' && one[1] === 'catalog'));
  say('okno se zeptá, na co se má podívat', zeptalo);
  await page.close();
}



/* ---------- okno zkušební kabiny: dílna s vrstvami ---------- */

/*
 * V okně se nerozhoduje o tom, jak oblek vypadá — to je vidět v kabině.
 * Rozhoduje se tu o tom, **co je hotové, co nesedí a co to stojí**.
 * Proto se zkouší přesně tyhle tři věci, a k tomu jedna čtvrtá: že se
 * zástupná kresba nikde netváří jako hotová fotka.
 */
{
  const page = await open('kabina');
  const uvod = await page.evaluate(() => ({
    zalozky: [...document.querySelectorAll('.zk-head-right .tab')].map(one => one.textContent.trim()),
    pozor: (document.querySelector('.zk-pozor')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
    ramec: !!document.querySelector('iframe.zk-ramec'),
    lista: (document.querySelector('.zk-kabina-lista')?.textContent ?? '').replace(/\s+/g, ' ').trim()
  }));
  say('kabina se otevře náhledem toho, co uvidí zákazník',
    uvod.zalozky.join(' · ') === 'Kabina · Vizuály · Produkty · Nastavení' && uvod.ramec,
    uvod.zalozky.join(' · '));
  say('  a je u toho řečeno, že běží tentýž skript jako na e-shopu',
    /tentýž skript/.test(uvod.lista) && /kB/.test(uvod.lista), uvod.lista.slice(0, 80));
  /*
   * Zástupná kresba se nesmí tvářit jako fotka. Je to jediná věta, která
   * odlišuje „kabina je hotová" od „kabina se dá zkoušet" — a kdyby
   * chyběla, posuzovalo by se nedopatřením něco jiného.
   */
  say('  zástupná kresba se netváří jako hotová fotka',
    /zástupná kresba/.test(uvod.pozor), uvod.pozor.slice(0, 80));

  await page.locator('.zk-head-right .tab', { hasText: 'Vizuály' }).click();
  await page.waitForTimeout(500);
  const dilna = await page.evaluate(() => ({
    postav: document.querySelectorAll('.zk-postava').length,
    karet: document.querySelectorAll('.zk-karta').length,
    nesedi: [...document.querySelectorAll('.zk-potiz')].map(one => one.textContent.trim()),
    odznaky: [...document.querySelectorAll('.zk-odznak')].map(one => one.textContent.trim()),
    dogenerovat: (document.querySelector('.zk-akce .btn.primary')?.textContent ?? '').trim(),
    navic: ([...document.querySelectorAll('.zk-akce .btn')]
      .map(one => one.textContent.trim()).find(one => /varianty navíc/.test(one)) ?? ''),
    kroku: document.querySelectorAll('.zk-kroky-rada figure').length
  }));
  const cena = text => Number((/([\d.,]+)\s*\$/.exec(text) ?? [])[1]?.replace(',', '.') ?? NaN);
  say('dílna ukazuje postavy i vrstvy', dilna.postav === 3 && dilna.karet === 8,
    `${dilna.postav} postav, ${dilna.karet} vrstev`);
  say('  u nepovedené vrstvy stojí česky, co je špatně',
    dilna.nesedi.length === 1 && /zabírá/.test(dilna.nesedi[0]), dilna.nesedi[0]?.slice(0, 70) ?? 'nic');
  say('  a u každé vrstvy je vidět, v jakém je stavu',
    new Set(dilna.odznaky).size >= 3, [...new Set(dilna.odznaky)].join(' · '));
  /*
   * Kolik to bude stát, má být vidět **před** kliknutím. Dávka přes
   * dvanáct postav je jinak nenápadná cesta k účtu za padesát dolarů.
   */
  say('  a kolik stojí dogenerovat, je vidět předem',
    /\$/.test(dilna.dogenerovat), dilna.dogenerovat);
  /*
   * Dvě tlačítka, ne jedno. Potřebné vrstvy jsou to, bez čeho kabina
   * nejde otevřít; varianty navíc jsou odstíny kulis, které zákazník
   * většinou ani nepřepne. Dřív se kreslilo všechno naráz a jedna
   * postava stála přes dolar — proto musí být levnější cesta první a
   * musí být **vidět, že je levnější**.
   */
  say('  a levnější cesta (jen potřebné) je nabídnutá vedle té úplné',
    cena(dilna.dogenerovat) > 0 && cena(dilna.navic) > cena(dilna.dogenerovat),
    `potřebné ${dilna.dogenerovat} proti ${dilna.navic}`);
  say('  kroky oblékání jsou k nahlédnutí', dilna.kroku === 3, `${dilna.kroku} kroků`);
  await page.screenshot({ path: path.join(SHOTS, 'okno-kabina-vizualy.png') });

  /* Zadání pro model se dá přepsat — bez něj se nepovedená vrstva nespraví */
  await page.locator('.zk-karta .zk-karta-btns .icon-btn').first().click();
  await page.waitForTimeout(400);
  const zadani = await page.evaluate(() => ({
    pole: document.querySelectorAll('.zk-zadani textarea').length,
    text: (document.querySelector('.zk-zadani textarea')?.value ?? '').slice(0, 40),
    zpet: !!document.querySelector('.zk-zadani .btn')
  }));
  say('  zadání pro model jde přepsat a vrátit', zadani.pole === 1 && zadani.zpet, zadani.text);

  await page.locator('.zk-head-right .tab', { hasText: 'Produkty' }).click();
  await page.waitForTimeout(500);
  const produkty = await page.evaluate(() => ({
    radku: document.querySelectorAll('.zk-radek').length,
    bezTypu: [...document.querySelectorAll('.zk-radek select')]
      .filter(one => one.value === '').length,
    barvy: document.querySelectorAll('.zk-radek input[type="color"]').length
  }));
  say('produkty jdou zařadit a obarvit ručně',
    produkty.radku === 3 && produkty.barvy === 3 && produkty.bezTypu === 1,
    `${produkty.radku} řádků, ${produkty.bezTypu} nezařazený`);

  await page.locator('.zk-head-right .tab', { hasText: 'Nastavení' }).click();
  await page.waitForTimeout(500);
  const nastaveni = await page.evaluate(() => ({
    sekci: [...document.querySelectorAll('.zk-nastaveni h3')].map(one => one.textContent.trim()),
    modely: document.querySelectorAll('.zk-model').length,
    utrata: (document.querySelector('.zk-rada .desc')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
    zavadec: (document.querySelector('.zk-zavadec')?.value ?? '').slice(0, 40),
    kategorii: document.querySelectorAll('.zk-kategorie label').length,
    kategoriePolí: document.querySelectorAll('.zk-kategorie input').length,
    prvniKategorie: document.querySelector('.zk-kategorie input')?.value ?? '',
    kvality: [...document.querySelectorAll('.zk-nastaveni input[name="zkkvalita"]')].length,
    cenaKvality: ([...document.querySelectorAll('.zk-nastaveni .zk-model')]
      .find(one => /Nízká/.test(one.textContent ?? ''))?.textContent ?? '')
      .replace(/\s+/g, ' ').trim(),
    dil: [...document.querySelectorAll('.zk-nastaveni .desc')]
      .map(one => one.textContent.replace(/\s+/g, ' ').trim())
      .find(one => /120 cm →/.test(one)) ?? ''
  }));
  say('nastavení drží klíč, model, strop i větu o osobní radě',
    nastaveni.sekci.length === 9 && nastaveni.modely >= 2,
    nastaveni.sekci.join(' · '));
  /*
   * Cena za obrázek musí být vidět u každé kvality. Projet řetěz nízkou
   * kvalitou stojí čtvrtinu — a to je rozdíl mezi „zkusím to" a „radši
   * ne".
   */
  say('  a u kvality je vidět, co stojí obrázek',
    nastaveni.kvality === 3 && /za obrázek/.test(nastaveni.cenaKvality),
    nastaveni.cenaKvality);
  say('  a je vidět, kolik se tenhle měsíc utratilo',
    /utraceno/.test(nastaveni.utrata), nastaveni.utrata.slice(0, 60));
  /* Zavaděč je to jediné, co se vkládá do šablony — musí jít zkopírovat */
  say('  zavaděč do šablony je po vystavení k dispozici',
    /zavaděč/.test(nastaveni.zavadec), nastaveni.zavadec || 'chybí');
  say('  pobídky mají odkaz do kategorie pro každou jazykovou verzi',
    nastaveni.kategorii === 4 && nastaveni.kategoriePolí === 12,
    `${nastaveni.kategorii} kategorií, ${nastaveni.kategoriePolí} polí`);
  /*
   * Poměr pro radu s velikostí je číslo, kterému nikdo nerozumí, dokud
   * nevidí, co z něj vyjde. Proto je u něj příklad na dítě i dospělého.
   */
  say('  u poměru pro velikost kšand je vidět, co z něj vyjde',
    /120 cm → 74 cm/.test(nastaveni.dil), nastaveni.dil || 'bez příkladu');
  await page.screenshot({ path: path.join(SHOTS, 'okno-kabina-nastaveni.png') });
  await page.close();
}

/* ---------- zkušební kabina na e-shopu ---------- */

/*
 * Zkouška toho, co uvidí zákazník — na tomtéž zavaděči a tomtéž skriptu,
 * které se vkládají do e-shopu, a na stránkách se stejnou stavbou, jakou
 * má quentino.cz.
 *
 * Měří se to, co se okem neposoudí:
 *  1. **že se do kliknutí nic nestahuje** — kvůli rychlosti načítání i
 *     kvůli hodnocení u Googlu; tlačítka smí přibýt, data ne,
 *  2. **že zvolená barva vyjde přesně** — to je celé jádro kabiny,
 *  3. **že kšandy schovají sako** a dá se to přebít,
 *  4. **že počty a velikosti dojdou do košíku** tak, jak si je zákazník
 *     nastavil — tedy formulářem z detailu, protože adresa velikost
 *     nepřenese,
 *  5. **že kabina přežije odchod na jinou stránku**, protože doplňky se
 *     vybírají prohlížením a každý odchod by jinak znamenal začínat znovu.
 */
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  page.on('pageerror', e => problems.push(`kabina: chyba stránky: ${e.message}`));
  page.on('console', m => {
    if (m.type() === 'error' && !/favicon/.test(m.text())) problems.push(`kabina: konzole: ${m.text()}`);
  });

  await page.goto('http://localhost:4324/kabina.html', { waitUntil: 'load' });
  await page.waitForTimeout(150);
  const hnedPoNacteni = await page.evaluate(() => ({
    skript: document.querySelectorAll('script[src*="kabina.js"]').length,
    data: performance.getEntriesByType('resource').filter(one => /kabina-data|kabina\.js/.test(one.name)).length,
    okno: document.querySelectorAll('.qkb').length
  }));
  say('kabina se do kliknutí nestahuje',
    hnedPoNacteni.skript === 0 && hnedPoNacteni.data === 0 && hnedPoNacteni.okno === 0,
    `skriptů ${hnedPoNacteni.skript}, stažení ${hnedPoNacteni.data}`);
  say('  a zavaděč se vejde do pole v administraci',
    KABINA_ZAVADEC.length > 500 && KABINA_ZAVADEC.length < 12000,
    `zavaděč ${Math.round(KABINA_ZAVADEC.length / 1000)} tisíc znaků, kabina ${Math.round(KABINA_SCRIPT.length / 1000)}`);

  await page.waitForSelector('.qkbz-karta', { timeout: 4000 });
  const tlacitka = await page.evaluate(() => ({
    karet: document.querySelectorAll('article.card-item').length,
    nasich: document.querySelectorAll('.qkbz-karta').length,
    vOdkazu: [...document.querySelectorAll('.qkbz-karta')].filter(one => one.closest('a')).length,
    nadObrazkem: [...document.querySelectorAll('.qkbz-karta')]
      .filter(one => one.previousElementSibling && one.previousElementSibling.classList.contains('p-i-media')).length
  }));
  say('ve výpisu přibude tlačítko u každé karty',
    tlacitka.nasich === tlacitka.karet && tlacitka.karet >= 5,
    `${tlacitka.nasich} z ${tlacitka.karet} karet`);
  /*
   * Obrázek v kartě je odkaz na produkt. Kdyby tlačítko leželo v něm,
   * kliknutí by odešlo na produkt a kabina by se nikdy neotevřela.
   */
  say('  a leží nad obrázkem, ne v odkazu na produkt',
    tlacitka.vOdkazu === 0 && tlacitka.nadObrazkem === tlacitka.nasich,
    `v odkazu ${tlacitka.vOdkazu}, nad obrázkem ${tlacitka.nadObrazkem}`);

  /* Teprve kliknutí stáhne kabinu a nasadí produkt z té karty */
  await page.evaluate(() => {
    const karta = [...document.querySelectorAll('article.card-item')]
      .find(one => /burgundská/.test(one.textContent));
    karta.querySelector('.qkbz-karta').click();
  });
  await page.waitForSelector('.qkb-kus', { timeout: 6000 });
  await page.waitForTimeout(700);

  const poKliknuti = await page.evaluate(() => ({
    okno: document.querySelectorAll('.qkb').length,
    platno: !!document.querySelector('.qkb-platno canvas'),
    kusy: [...document.querySelectorAll('.qkb-kus-nazev')].map(one => one.textContent.trim()),
    suma: (document.querySelector('.qkb-suma b')?.textContent ?? '').trim(),
    kontakt: (document.querySelector('.qkb-kontakt')?.textContent ?? '').trim()
  }));
  say('kliknutí ve výpisu otevře kabinu s tím produktem',
    poKliknuti.okno === 1 && poKliknuti.platno && poKliknuti.kusy.some(one => /burgundská/.test(one)),
    poKliknuti.kusy.join(' · ') || 'nic');
  say('  a cena je vidět hned, bez hledání',
    /690/.test(poKliknuti.suma), poKliknuti.suma);
  say('  že poradíme i osobně, je vidět pořád',
    /osobně/.test(poKliknuti.kontakt) && /607/.test(poKliknuti.kontakt),
    poKliknuti.kontakt.slice(0, 70));

  /* Na mobilu se nesmí nic rozlézt do strany a tlačítko do košíku musí být vidět */
  const mobil = await page.evaluate(() => {
    const okno = document.querySelector('.qkb');
    const kosik = document.querySelector('.qkb-kosik');
    const r = kosik.getBoundingClientRect();
    return {
      sirka: okno.scrollWidth - okno.clientWidth,
      kosikVidi: r.top >= 0 && r.bottom <= window.innerHeight && r.width > 60,
      model: document.querySelector('.qkb-platno canvas').getBoundingClientRect().height
    };
  });
  say('na mobilu se nic nerozlézá a „do košíku" je vidět bez posouvání',
    mobil.sirka <= 1 && mobil.kosikVidi && mobil.model > 120,
    `přetečení ${mobil.sirka} px, model ${Math.round(mobil.model)} px`);

  /* Opravdu se něco nakreslilo, ne prázdné plátno */
  const nakresleno = await page.evaluate(() => {
    const c = document.querySelector('.qkb-platno canvas');
    const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let kusu = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 20) kusu++;
    return { kusu, celkem: data.length / 4 };
  });
  say('  na plátně je model, ne prázdno', nakresleno.kusu > 2000,
    `${nakresleno.kusu} z ${nakresleno.celkem} bodů`);

  /*
   * Body na modelu. Prázdné místo samo řekne „sem patří kapesníček" —
   * ve výpisu kategorií by to zákazník nehledal.
   */
  const body = await page.evaluate(() => [...document.querySelectorAll('.qkb-bod')].map(one => ({
    typ: one.getAttribute('data-typ'),
    obsazeno: one.getAttribute('data-obsazeno'),
    popis: one.getAttribute('title'),
    x: one.style.left, y: one.style.top
  })));
  say('na modelu jsou body k přidání dalšího doplňku',
    body.length >= 3 && body.every(one => one.popis && one.x && one.y),
    body.map(one => `${one.typ}${one.obsazeno === '1' ? '✓' : ''}`).join(' · '));
  say('  a kravata je poznaná jako obsazená',
    body.find(one => one.typ === 'kravata')?.obsazeno === '1');

  /* Kliknutí na bod otevře výběr jen z té kategorie */
  await page.locator('.qkb-bod[data-typ="kapesnicek"]').click();
  await page.waitForTimeout(400);
  const vyberKapesnicku = await page.evaluate(() => ({
    nadpis: (document.querySelector('.qkb-hledani-blok h3')?.textContent ?? '').trim(),
    nalezeno: [...document.querySelectorAll('.qkb-mrizka .qkb-karta b')].map(one => one.textContent.trim()),
    kategorie: (document.querySelector('.qkb-hledani-blok a')?.getAttribute('href') ?? '')
  }));
  say('bod na modelu nabídne jen tu kategorii',
    vyberKapesnicku.nalezeno.length === 1 && /Kapesníček/.test(vyberKapesnicku.nalezeno[0]),
    `${vyberKapesnicku.nadpis}: ${vyberKapesnicku.nalezeno.join(', ')}`);
  say('  a odkaz do kategorie e-shopu, když je zadaný',
    vyberKapesnicku.kategorie === '/kapesnicky', vyberKapesnicku.kategorie || 'žádný');

  await page.locator('.qkb-mrizka .qkb-karta').first().click();
  await page.waitForTimeout(900);

  /*
   * Vzorek stažený jako soubor. Po vystavení na web jsou takhle všechny:
   * v seznamu je jen adresa, obrázek se stáhne teprve tehdy, až je ten
   * kus na modelu. Jinak by si každý zákazník stáhl dva megabajty
   * vzorků, ze kterých uvidí jeden.
   */
  say('vzorek ze souboru se stáhne, až je kus na modelu',
    await page.evaluate(() => performance.getEntriesByType('resource')
      .some(one => /vzorek-kapesnicek\.png/.test(one.name))),
    'vzorek-kapesnicek.png');

  /*
   * A teď to hlavní: zvolená barva musí na plátně vyjít **přesně**.
   * Kdyby se mapa světla posunula, byl by každý oblek o stupeň jinak a
   * nikdo by nepoznal proč.
   */
  await page.locator('.qkb-chip', { hasText: 'Upravit postavu' }).click();
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const bloky = [...document.querySelectorAll('.qkb-zavoj .qkb-blok')];
    const sako = bloky.find(one => (one.querySelector('h3')?.textContent ?? '').trim() === 'Sako');
    [...sako.querySelectorAll('.qkb-barva')].find(one => one.title === 'Námořnická modrá').click();
  });
  await page.waitForTimeout(600);
  const barvaNaPlatne = await page.evaluate(() => {
    const c = document.querySelector('.qkb-platno canvas');
    /* Uprostřed levého dílu saka, kde má mapa světla polotón */
    const bod = c.getContext('2d').getImageData(78, 130, 1, 1).data;
    return [bod[0], bod[1], bod[2]];
  });
  say('zvolená barva obleku vyjde na plátně přesně',
    barvaNaPlatne[0] === 0x1f && barvaNaPlatne[1] === 0x2d && barvaNaPlatne[2] === 0x4d,
    `rgb(${barvaNaPlatne.join(', ')}) místo rgb(31, 45, 77)`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  /*
   * Vzor se na modelu vydláždí. Kdyby se místo vzorku použila jedna
   * barva, byl by kostkovaný motýlek na modelu jednobarevný flek — a
   * zákazník by si koupil něco jiného, než co viděl.
   */
  await page.evaluate(() => {
    const pole = document.querySelector('.qkb-hledani input');
    pole.value = 'motýlek';
    pole.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(400);
  const hledani = await page.evaluate(() =>
    [...document.querySelectorAll('.qkb-mrizka .qkb-karta b')].map(one => one.textContent.trim()));
  say('doplněk se dá najít rovnou v kabině',
    hledani.length === 1 && /Motýlek/.test(hledani[0]), hledani.join(', ') || 'nic');
  await page.locator('.qkb-mrizka .qkb-karta').first().click();
  await page.waitForTimeout(700);
  const vzorNaModelu = await page.evaluate(() => {
    const c = document.querySelector('.qkb-platno canvas');
    const ctx = c.getContext('2d');
    const barvy = new Set();
    for (let x = 90; x < 110; x++) {
      const bod = ctx.getImageData(x, 130, 1, 1).data;
      if (bod[3] > 200) barvy.add(`${bod[0]},${bod[1]},${bod[2]}`);
    }
    return [...barvy];
  });
  say('  vzor látky se na modelu vydláždí, ne slije do fleku',
    vzorNaModelu.length >= 2, `${vzorNaModelu.length} barev: ${vzorNaModelu.slice(0, 2).join(' · ')}`);

  /*
   * Kšandy a sako. Kšandy se nosí pod sakem a vidět z nich není nic,
   * takže je kabina sama ukáže — ale ke kšandám se vybírá kapesníček a
   * ten je v klopě saka, takže se to musí dát přebít.
   */
  await page.evaluate(() => {
    const pole = document.querySelector('.qkb-hledani input');
    pole.value = 'kšandy hnědé';
    pole.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(400);
  await page.locator('.qkb-mrizka .qkb-karta').first().click();
  await page.waitForTimeout(700);
  const poKsandach = await page.evaluate(() => ({
    chip: (document.querySelector('.qkb-scena-lista .qkb-chip[aria-pressed]')?.textContent ?? '').trim(),
    sakoVidi: document.querySelector('.qkb-scena-lista .qkb-chip[aria-pressed]')?.getAttribute('aria-pressed'),
    bodKapesnicek: !!document.querySelector('.qkb-bod[data-typ="kapesnicek"]')
  }));
  say('kšandy samy schovají sako',
    poKsandach.sakoVidi === 'false' && /Bez saka/.test(poKsandach.chip), poKsandach.chip);
  say('  a s ním zmizí i bod na kapesníček — neměl by kde být',
    poKsandach.bodKapesnicek === false);
  await page.locator('.qkb-scena-lista .qkb-chip[aria-pressed]').click();
  await page.waitForTimeout(600);
  const poPrebiti = await page.evaluate(() => ({
    sakoVidi: document.querySelector('.qkb-scena-lista .qkb-chip[aria-pressed]')?.getAttribute('aria-pressed'),
    bodKapesnicek: !!document.querySelector('.qkb-bod[data-typ="kapesnicek"]')
  }));
  say('  sako se dá vrátit i s kšandami (kvůli kapesníčku)',
    poPrebiti.sakoVidi === 'true' && poPrebiti.bodKapesnicek === true);

  /* Další vzhled k porovnání */
  await page.locator('.qkb-varianty .qkb-chip', { hasText: 'Další vzhled' }).click();
  await page.waitForTimeout(500);
  const varianty = await page.evaluate(() =>
    [...document.querySelectorAll('.qkb-varianty .qkb-chip[aria-pressed]')]
      .map(one => one.textContent.trim() + (one.getAttribute('aria-pressed') === 'true' ? '*' : '')));
  say('vzhledů může být víc a dá se mezi nimi přepínat',
    varianty.length === 2 && varianty[1].endsWith('*'), varianty.join(' · '));
  await page.locator('.qkb-varianty .qkb-chip').first().click();
  await page.waitForTimeout(500);

  await page.screenshot({ path: path.join(SHOTS, 'kabina-mobil.png') });

  /*
   * Počty. Nula je plnohodnotná odpověď: kus na modelu zůstane (vlastní
   * kravata, ke které si zákazník vybírá kapesníček), ale do košíku
   * nepůjde. Kdyby se přidal, byla by to ta nejhorší chyba, jakou může
   * kabina udělat.
   */
  const pred = await page.evaluate(() => (document.querySelector('.qkb-suma b')?.textContent ?? '').trim());
  await page.evaluate(() => {
    const kus = [...document.querySelectorAll('.qkb-kus')]
      .find(one => /Motýlek/.test(one.textContent));
    kus.querySelectorAll('.qkb-pocet button')[1].click();
  });
  await page.waitForTimeout(300);
  const poPridani = await page.evaluate(() => ({
    suma: (document.querySelector('.qkb-suma b')?.textContent ?? '').trim(),
    pocet: [...document.querySelectorAll('.qkb-kus')]
      .find(one => /Motýlek/.test(one.textContent))?.querySelector('.qkb-pocet span')?.textContent
  }));
  say('počet se dá zvýšit a cena se sečte',
    poPridani.pocet === '2' && poPridani.suma !== pred, `${pred} → ${poPridani.suma}`);
  await page.evaluate(() => {
    const kus = [...document.querySelectorAll('.qkb-kus')]
      .find(one => /Motýlek/.test(one.textContent));
    kus.querySelectorAll('.qkb-pocet button')[0].click();
    kus.querySelectorAll('.qkb-pocet button')[0].click();
  });
  await page.waitForTimeout(300);
  const poNule = await page.evaluate(() => {
    const kus = [...document.querySelectorAll('.qkb-kus')]
      .find(one => /Motýlek/.test(one.textContent));
    return {
      pocet: kus.querySelector('.qkb-pocet span').textContent,
      zeslabeno: kus.getAttribute('data-nic'),
      naModelu: !!document.querySelector('.qkb-bod[data-typ="kravata"][data-obsazeno="1"]')
    };
  });
  say('  nula znamená „na modelu ano, do košíku ne"',
    poNule.pocet === '0' && poNule.zeslabeno === '1' && poNule.naModelu,
    `počet ${poNule.pocet}, na modelu ${poNule.naModelu ? 'zůstala' : 'zmizela'}`);

  /*
   * Dětské kšandy: rada s velikostí. Rodič, který netuší, jestli „70 cm"
   * je na čtyřleté dítě, nákup odloží — a rada, která si není jistá, to
   * musí přiznat a nabídnout doptání.
   */
  await page.evaluate(() => {
    const pole = document.querySelector('.qkb-hledani input');
    pole.value = 'dětské';
    pole.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(400);
  await page.locator('.qkb-mrizka .qkb-karta').first().click();
  await page.waitForTimeout(800);
  const detske = await page.evaluate(() => {
    const kus = [...document.querySelectorAll('.qkb-kus')].find(one => /Dětské/.test(one.textContent));
    return {
      velikosti: [...(kus?.querySelectorAll('select option') ?? [])].map(one => one.textContent.trim()),
      vybrana: kus?.querySelector('select')?.value,
      rada: (kus?.querySelector('.qkb-rada')?.textContent ?? '').trim(),
      pomoc: !!kus?.querySelector('.qkb-rada a'),
      hlaska: (document.querySelector('.qkb-hlaska')?.textContent ?? '').trim()
    };
  });
  say('dětský kus přepne model na dítě',
    /dítě/i.test(detske.hlaska), detske.hlaska || 'bez hlášky');
  say('  a nabídne velikosti i s tím, co není skladem',
    detske.velikosti.length === 3 && /není skladem/.test(detske.velikosti[2]),
    detske.velikosti.join(' · '));
  say('  rada s velikostí vychází z výšky a přizná, že je to odhad',
    /odhadujeme/.test(detske.rada) && detske.pomoc, detske.rada.slice(0, 90));

  /*
   * A do košíku. Produkt s velikostmi se adresou přidat nedá, takže
   * kabina odesílá tentýž formulář, co má detail — a tady se změří, že
   * do košíku dorazila ta velikost, kterou zákazník vybral.
   */
  await page.evaluate(() => {
    const kus = [...document.querySelectorAll('.qkb-kus')].find(one => /Dětské/.test(one.textContent));
    const vyber = kus.querySelector('select');
    vyber.value = [...vyber.options].find(one => /75/.test(one.textContent)).value;
    vyber.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(250);
  await page.locator('.qkb-kosik').click();
  await page.waitForTimeout(2200);
  const kosik = await page.request.get('http://localhost:4324/kosik');
  const kosikHtml = await kosik.text();
  const pata = await page.evaluate(() => (document.querySelector('.qkb-pata')?.textContent ?? '').trim());
  const kosikRadky = kosikHtml.replace(/\s+/g, ' ').replace(/.*<ul id="kosik">/, '');
  say('kusy se vloží do košíku formulářem e-shopu',
    /1005 · 2001/.test(kosikRadky), kosikRadky.slice(0, 100));
  /* Produkt bez velikostí posílá prázdné option_set_id, ne nějakou náhodnou */
  say('  a produkt bez velikostí žádnou velikost nepřidá',
    /1003 · — /.test(kosikRadky), kosikRadky.slice(0, 100));
  say('  a kabina pak nabídne jít do košíku',
    /košíku/i.test(pata), pata.slice(0, 60));

  /*
   * Minimalizace a návrat. Doplňky se vybírají prohlížením: zákazník
   * přidá motýlka, jde se podívat na kapesníčky, přidá kapesníček.
   * Kdyby kabina odchodem ze stránky zmizela, začínal by pokaždé znovu.
   */
  await page.goto('http://localhost:4324/p/kravata-salvejova', { waitUntil: 'load' });
  await page.waitForSelector('.qkbz-bublina', { timeout: 4000 });
  const naDetailu = await page.evaluate(() => ({
    bublina: (document.querySelector('.qkbz-bublina')?.textContent ?? '').trim(),
    tlacitko: (document.querySelector('.qkbz-vlozit')?.textContent ?? '').trim(),
    kdeJe: document.querySelector('.qkbz-vlozit')?.closest('.AddToCart') ? 'u košíku' : 'jinde'
  }));
  say('na detailu je tlačítko vedle „do košíku"',
    /Vyzkoušet na modelu/.test(naDetailu.tlacitko) && naDetailu.kdeJe === 'u košíku',
    `${naDetailu.tlacitko} (${naDetailu.kdeJe})`);
  say('  a kabina zůstala k otevření i na jiné stránce',
    /Zkušební kabina/.test(naDetailu.bublina), naDetailu.bublina);

  /*
   * E-shop si při přepnutí velikosti překreslí celý blok s košíkem.
   * Kdyby zavaděč hlídal jen výpis, tlačítko by po první změně velikosti
   * zmizelo a zpátky by se dostalo jedině načtením stránky.
   */
  const poSmazani = await page.evaluate(() => {
    const blok = document.querySelector('.pd-order-buttons');
    blok.innerHTML = blok.innerHTML.replace(/<button[^>]*qkbz-vlozit[\s\S]*?<\/button>/, '');
    return document.querySelectorAll('.qkbz-vlozit').length;
  });
  say('  překreslení košíku tlačítko opravdu smaže', poSmazani === 0, `${poSmazani} tlačítek`);
  await page.waitForTimeout(800);
  const poPrekresleni = await page.evaluate(() => document.querySelectorAll('.qkbz-vlozit').length);
  say('  a vrátí se i po překreslení košíku na stránce',
    poPrekresleni === 1, `${poPrekresleni} tlačítek`);

  await page.locator('.qkbz-bublina').click();
  await page.waitForSelector('.qkb-kus', { timeout: 6000 });
  await page.waitForTimeout(700);
  const poVraceni = await page.evaluate(() =>
    [...document.querySelectorAll('.qkb-kus-nazev')].map(one => one.textContent.trim()));
  say('  a vrátí se s tím, co v ní bylo',
    poVraceni.some(one => /Dětské/.test(one)), poVraceni.join(' · ') || 'nic');

  /* Souvisejicí produkty ze stránky se nabídnou v kabině */
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  await page.locator('.qkbz-vlozit').click();
  await page.waitForTimeout(1200);
  const doporuceni = await page.evaluate(() => ({
    nadpis: (document.querySelector('.qkb-rady h3')?.textContent ?? '').trim(),
    karty: [...document.querySelectorAll('.qkb-rady .qkb-karta b')].map(one => one.textContent.trim())
  }));
  say('kabina doporučí to, co e-shop dal k produktu jako související',
    doporuceni.karty.length >= 2, `${doporuceni.nadpis}: ${doporuceni.karty.slice(0, 3).join(' · ')}`);

  await page.close();

  /* Na počítači je model vlevo a nabídka vedle — na mobilu pod sebou */
  const siroka = await browser.newPage({ viewport: { width: 1180, height: 900 } });
  siroka.on('pageerror', e => problems.push(`kabina: chyba stránky: ${e.message}`));
  await siroka.goto('http://localhost:4324/kabina.html', { waitUntil: 'load' });
  await siroka.waitForSelector('.qkbz-karta', { timeout: 4000 });
  await siroka.evaluate(() => {
    document.querySelector('article.card-item .qkbz-karta').click();
  });
  await siroka.waitForSelector('.qkb-kus', { timeout: 6000 });
  await siroka.waitForTimeout(900);
  const naPocitaci = await siroka.evaluate(() => {
    const model = document.querySelector('.qkb-platno').getBoundingClientRect();
    const nabidka = document.querySelector('.qkb-pravy').getBoundingClientRect();
    return { vedleSebe: model.right <= nabidka.left + 2, sirkaOkna: document.querySelector('.qkb').getBoundingClientRect().width };
  });
  say('na počítači stojí model vedle nabídky, ne nad ní',
    naPocitaci.vedleSebe && naPocitaci.sirkaOkna > 700,
    `okno ${Math.round(naPocitaci.sirkaOkna)} px`);
  await siroka.screenshot({ path: path.join(SHOTS, 'kabina.png') });
  await siroka.close();
}

console.log(problems.length ? '\n' + problems.join('\n') : '\nžádné chyby');
await browser.close();
server.close();
process.exit(bad || problems.length ? 1 : 0);
