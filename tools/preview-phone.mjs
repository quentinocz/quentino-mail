// Vykreslí sestavené rozhraní v rozměrech iPhonu a uloží náhledy.
// Nativní most nahrazuje tools/stub.js, takže se dá zkontrolovat rozvržení
// bez zařízení v ruce.
import pw from 'playwright';
const { chromium } = pw;
import http from 'http';
import fs from 'fs';
import path from 'path';

const ROOT = new URL('../dist/renderer/', import.meta.url).pathname;
fs.mkdirSync(new URL('./shots/', import.meta.url).pathname, { recursive: true });
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

// Stub a odstranění CSP se po každém sestavení ztratí — proto se doplní tady
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
  const file = path.join(ROOT, rel);
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('nenalezeno'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  });
});
await new Promise(r => server.listen(4321, r));

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 393, height: 852 },   // iPhone 15
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true
});
const problems = [];
page.on('pageerror', e => problems.push('chyba stránky: ' + e.message));
page.on('console', m => { if (m.type() === 'error') problems.push('konzole: ' + m.text()); });

await page.goto('http://localhost:4321/index.html', { waitUntil: 'load' });
await page.waitForTimeout(900);

const click = async (selector, options = {}) => {
  try { await page.locator(selector, options).first().click({ timeout: 3500 }); }
  catch { problems.push('nešlo kliknout: ' + selector + (options.hasText ? ` (${options.hasText})` : '')); }
  await page.waitForTimeout(500);
};

async function snap(name) {
  await page.waitForTimeout(400);
  await page.screenshot({ path: new URL(`./shots/${name}.png`, import.meta.url).pathname });
}

async function report(label) {
  const data = await page.evaluate(() => {
    const box = sel => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    };
    // Co je na obrazovce doopravdy vidět a nic ho nepřekrývá
    const onTop = sel => {
      const el = document.querySelector(sel);
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return false;
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return !!hit && (el.contains(hit) || hit.contains(el));
    };
    return {
      formFactor: document.documentElement.dataset.formFactor,
      workspace: localStorage.getItem('workspace'),
      tabs: box('.m-tabs'),
      tabsUsable: onTop('.m-tabs'),
      head: box('.m-head'),
      drawerOpen: document.querySelector('.app')?.getAttribute('data-drawer') === 'open',
      modal: box('.modal') ?? box('.composer'),
      overflowX: document.documentElement.scrollWidth > window.innerWidth + 1
    };
  });
  return { label, ...data };
}

const out = [];

out.push(await report('pošta — seznam'));
await snap('01-posta-seznam');

await click('.msg-item');
out.push(await report('pošta — zpráva'));
await snap('02-posta-zprava');

await click('.m-head-btn');                       // Zpět
await click('.m-head-btn');                       // hamburger
out.push(await report('pošta — zásuvka'));
await snap('03-posta-zasuvka');

// Nastavení otevřené ze zásuvky — ta se musí sama zavřít
await click('.sidebar .side-item', { hasText: 'Nastavení' });
out.push(await report('nastavení'));
await snap('04-nastaveni');
await page.keyboard.press('Escape');
await click('.modal-head button:last-child');
await page.waitForTimeout(400);

for (const [index, name] of [[1, 'chat'], [2, 'social']]) {
  await click(`.m-tabs button:nth-child(${index + 1})`);
  await page.waitForTimeout(600);
  out.push(await report(name));
  await snap(`0${index + 4}-${name}`);
}

// Zpátky do pošty a otevřít psaní zprávy
await click('.m-tabs button:nth-child(1)');
await page.waitForTimeout(600);
await click('.m-head-btn.right');
out.push(await report('psaní zprávy'));
await snap('07-psani');

console.log(JSON.stringify(out, null, 1));
console.log(problems.length ? '\nPROBLÉMY:\n' + problems.slice(0, 12).join('\n') : '\nžádné chyby');

await browser.close();
server.close();
