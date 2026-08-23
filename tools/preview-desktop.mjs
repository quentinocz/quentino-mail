// Náhled obrazovek, které jsou jen na počítači (překlady produktů).
// Stejný princip jako preview-phone.mjs, jen v okně notebooku a bez dotyku.
//
//   npm run build:renderer && node tools/preview-desktop.mjs
import pw from 'playwright';
import http from 'http';
import fs from 'fs';
import path from 'path';

const ROOT = new URL('../dist/renderer/', import.meta.url).pathname;
const SHOTS = new URL('./shots/', import.meta.url).pathname;
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
await new Promise(r => server.listen(4322, r));

const preinstalled = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium/chrome-linux/chrome']
  .find(p => fs.existsSync(p));
const browser = await pw.chromium.launch(preinstalled ? { executablePath: preinstalled } : {});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const problems = [];
page.on('pageerror', e => problems.push('chyba stránky: ' + e.message));
page.on('console', m => {
  if (m.type() === 'error' && !/favicon/.test(m.text() + m.location().url)) problems.push('konzole: ' + m.text());
});

// Stub hlásí telefon; tady chceme počítač
await page.addInitScript(() => {
  document.addEventListener('DOMContentLoaded', () => { document.documentElement.dataset.form = 'desktop'; });
});
await page.goto('http://localhost:4322/index.html', { waitUntil: 'load' });
await page.waitForTimeout(900);

const click = async (selector, options = {}) => {
  try { await page.locator(selector, options).first().click({ timeout: 4000 }); }
  catch { problems.push(`nešlo kliknout: ${selector}${options.hasText ? ` (${options.hasText})` : ''}`); }
  await page.waitForTimeout(500);
};
const snap = async name => { await page.waitForTimeout(300); await page.screenshot({ path: path.join(SHOTS, `mac-${name}.png`) }); };

const overflow = async label => {
  const data = await page.evaluate(() => {
    const spill = [];
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      if (r.right > window.innerWidth + 2 || r.left < -2) {
        let fixed = false;
        for (let n = el; n && n !== document.body; n = n.parentElement) {
          if (getComputedStyle(n).position === 'fixed') { fixed = true; break; }
        }
        if (!fixed) spill.push(String(el.className).slice(0, 40));
      }
    }
    return [...new Set(spill)].slice(0, 4);
  });
  console.log(`${label.padEnd(28)} ${data.length ? 'přetéká: ' + data.join(', ') : '—'}`);
};

// Překlady se otevírají z nabídky AI — v panelu už samostatnou položku nemají
await click('.ig-switch button', { hasText: 'AI' });
await click('.ws-menu-item', { hasText: 'Překlady produktů' });
await overflow('překlady — seznam'); await snap('01-preklady-seznam');

await click('.pt-row');
await overflow('překlady — detail'); await snap('02-preklady-detail');

await click('.pt-detail-head .btn.ghost');
await overflow('překlady — spuštění'); await snap('03-preklady-spusteni');
await page.keyboard.press('Escape');
await click('.pt-run .modal-head .icon-btn');

await click('.pt-tabs button', { hasText: 'Jednotnost' });
await overflow('překlady — jednotnost'); await snap('06-preklady-jednotnost');

await click('.pt-tabs button', { hasText: 'Nastavení' });
await overflow('překlady — nastavení'); await snap('04-preklady-nastaveni');
await page.evaluate(() => document.querySelector('.pt-settings')?.scrollTo(0, 900));
await snap('05-preklady-nastaveni-dole');

await click('.pt-tabs button', { hasText: 'Paměť' });
await overflow('překlady — paměť'); await snap('07-preklady-pamet');
await page.keyboard.press('Escape');
await click('.pt-modal .modal-head .icon-btn:last-child');

// Nabídka AI v postranním panelu
await click('.ig-switch button', { hasText: 'AI' });
await overflow('nabídka AI'); await snap('08-nabidka-ai');

await click('.ws-menu-item', { hasText: 'Články' });
await overflow('články — seznam'); await snap('10-clanky-seznam');

await click('.ar-item');
await overflow('články — zadání'); await snap('11-clanky-zadani');

await click('.ar-detail-head .ig-seg button', { hasText: 'Text' });
await overflow('články — text'); await snap('12-clanky-text');

await click('.ar-detail-head .ig-seg button', { hasText: 'Odkazy' });
await overflow('články — odkazy'); await snap('13-clanky-odkazy');

await click('.ar-modal .pt-tabs button', { hasText: 'Odkazy' });
await overflow('články — kontrola'); await snap('14-clanky-kontrola');

await click('.ar-modal .pt-tabs button', { hasText: 'Mapa adres' });
await overflow('články — mapa'); await snap('15-clanky-mapa');

await click('.ar-modal .pt-tabs button', { hasText: 'Nastavení' });
await overflow('články — nastavení'); await snap('16-clanky-nastaveni');

// Pruh s běžícím překladem na pozadí — je vidět i mimo okno překladů
await click('.ar-modal .modal-head .icon-btn:last-child');
await page.evaluate(() => window.__emit('ptrans:progress', {
  running: true, done: 428, total: 1362, failed: 2, etaSeconds: 940,
  secondsPerUnit: 11.4, label: 'Bordó pánská kravata BULDOČCI → SK', errors: []
}));
await overflow('pruh překladu'); await snap('09-pruh-prekladu');

console.log(problems.length ? '\nPROBLÉMY:\n' + problems.slice(0, 10).join('\n') : '\nžádné chyby');
await browser.close();
server.close();
