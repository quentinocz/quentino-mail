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

const server = http.createServer((req, res) => {
  const rel = (req.url || '/').split('?')[0].replace(/^\//, '') || 'index.html';
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
     */
    const kde = m.text() + m.location().url;
    if (m.type() === 'error' && !/favicon|fonts\.(googleapis|gstatic)\.com/.test(kde)) {
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
  { hash: 'produkty', nadpis: 'Produkty' }
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
  say('  a nenabízí přepnutí na poštu uvnitř',
    stav.tabs.length === 1 && stav.tabs[0].includes('Funkce'), stav.tabs.join(' | '));
  await page.screenshot({ path: path.join(SHOTS, 'okno-socialni.png') });
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
        const s = getComputedStyle(blok);
        return { nad: parseFloat(s.marginTop), pod: parseFloat(s.marginBottom),
          kotva: s.overflowAnchor };
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
      // Pruh odkazů na kategorie pod bannerem
      odkazy: (() => {
        const pruh = node.ownerDocument.querySelector('.qbn-links');
        const blok = node.closest('.qbn');
        if (!pruh || !blok) return null;
        return {
          pocet: pruh.querySelectorAll('.qbn-link').length,
          podBannerem: pruh.getBoundingClientRect().top >= blok.getBoundingClientRect().bottom - 2,
          sTextem: pruh.querySelectorAll('.qbn-link-text').length
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

  // Skript pro šablonu e-shopu se dá zkopírovat, i když je vidět jen v záložce
  await page.locator('.wt-head-right .tab', { hasText: 'Kód do e-shopu' }).click();
  await page.waitForTimeout(400);
  const kod = await page.locator('.bn-script').inputValue();
  say('záložka nabízí skript do šablony', kod.includes('qbn') && kod.includes('<script>'),
    `${kod.length} znaků`);
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

console.log(problems.length ? '\n' + problems.join('\n') : '\nžádné chyby');
await browser.close();
server.close();
process.exit(bad || problems.length ? 1 : 0);
