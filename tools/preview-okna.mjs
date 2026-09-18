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

const ROOT = new URL('../dist/renderer/', import.meta.url).pathname;
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
    if (m.type() === 'error' && !/favicon/.test(m.text() + m.location().url)) {
      problems.push(`${hash}: konzole: ${m.text()}`);
    }
  });
  await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => { document.documentElement.dataset.form = 'desktop'; });
  });
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
  { hash: 'media', nadpis: 'Konvertor' },
  { hash: 'clanky', nadpis: 'Články' },
  { hash: 'produkty', nadpis: 'Produkty' }
];

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
