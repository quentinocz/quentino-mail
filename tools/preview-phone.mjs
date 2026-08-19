// Vykreslí sestavené rozhraní v rozměrech iPhonu a uloží náhledy.
// Nativní most nahrazuje tools/stub.js, takže se dá zkontrolovat rozvržení
// bez zařízení v ruce.
//
//   npm run build:renderer && node tools/preview-phone.mjs
//
// Výstup je v tools/shots/<zařízení>-<obrazovka>.png a v konzoli přehled,
// jestli něco nepřetéká, jestli je spodní lišta dostupná a co překrývá co.
import pw from 'playwright';
const { chromium } = pw;
import http from 'http';
import fs from 'fs';
import path from 'path';

const ROOT = new URL('../dist/renderer/', import.meta.url).pathname;
const SHOTS = new URL('./shots/', import.meta.url).pathname;
fs.mkdirSync(SHOTS, { recursive: true });
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

// Nejmenší iPhone, na kterém aplikace poběží, a dnešní běžná velikost
const DEVICES = [
  { name: 'se', width: 375, height: 667 },   // iPhone SE / 8 — nejtěsnější případ
  { name: 'i15', width: 393, height: 852 }
];

// Předinstalovaný Chromium v prostředí nemusí odpovídat verzi Playwrightu
const preinstalled = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium/chrome-linux/chrome']
  .find(p => fs.existsSync(p));
const browser = await chromium.launch(preinstalled ? { executablePath: preinstalled } : {});
const problems = [];
const rows = [];

for (const device of DEVICES) {
  const page = await browser.newPage({
    viewport: { width: device.width, height: device.height },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true
  });
  page.on('pageerror', e => problems.push(`${device.name}: chyba stránky: ${e.message}`));
  page.on('console', m => {
    // Chybějící favicona v náhledu nic neznamená
    if (m.type() === 'error' && !/favicon/.test(m.text() + m.location().url)) {
      problems.push(`${device.name}: konzole: ${m.text()}`);
    }
  });

  await page.goto('http://localhost:4321/index.html', { waitUntil: 'load' });
  await page.waitForTimeout(900);

  const click = async (selector, options = {}) => {
    try { await page.locator(selector, options).first().click({ timeout: 3000 }); }
    catch { problems.push(`${device.name}: nešlo kliknout: ${selector}${options.hasText ? ` (${options.hasText})` : ''}`); }
    await page.waitForTimeout(450);
  };

  const snap = async (name) => {
    await page.waitForTimeout(350);
    await page.screenshot({ path: path.join(SHOTS, `${device.name}-${name}.png`) });
  };

  const check = async (label) => {
    const data = await page.evaluate(() => {
      // Co přetéká vodorovně ven z okna — nejčastější zdroj „rozbitého" pocitu
      const spilling = [];
      for (const el of document.querySelectorAll('body *')) {
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        if (r.right > window.innerWidth + 2 || r.left < -2) {
          // Zasunutá zásuvka je odsunutá mimo okno záměrně — spolu s obsahem
          let fixed = false;
          for (let node = el; node && node !== document.body; node = node.parentElement) {
            if (getComputedStyle(node).position === 'fixed') { fixed = true; break; }
          }
          if (fixed) continue;
          // Vodorovné rolování je někde záměr (pás záložek)
          let node = el, scroller = false;
          while (node && node !== document.body) {
            if (getComputedStyle(node).overflowX === 'auto' || getComputedStyle(node).overflowX === 'scroll') { scroller = true; break; }
            node = node.parentElement;
          }
          if (scroller) continue;
          spilling.push(`${el.className || el.tagName}`.slice(0, 40));
        }
      }
      const onTop = sel => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) return false;
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return !!hit && (el.contains(hit) || hit.contains(el));
      };
      // Kolik svislého místa zabírá „chrom" proti obsahu
      const chrome = ['.m-head', '.m-tabs', '.list-header', '.read-toolbar', '.composer-foot']
        .map(sel => document.querySelector(sel)?.getBoundingClientRect().height ?? 0)
        .reduce((a, b) => a + b, 0);
      return {
        spilling: [...new Set(spilling)].slice(0, 4),
        tabs: onTop('.m-tabs'),
        chrome: Math.round(chrome),
        viewport: window.innerHeight
      };
    });
    rows.push({ device: device.name, label, ...data });
  };

  await check('pošta — seznam'); await snap('01-seznam');

  await click('.m-round[aria-label="Filtry a řazení"]');
  await check('filtry (panel)'); await snap('02-filtry');
  await page.keyboard.press('Escape'); await page.waitForTimeout(350);

  await click('.msg-item');
  await check('zpráva'); await snap('03-zprava');

  await click('.m-round[aria-label="Další akce"]');
  await check('akce zprávy (panel)'); await snap('04-akce');
  await page.keyboard.press('Escape'); await page.waitForTimeout(350);

  await click('.m-head-btn');   // zpět na seznam
  await click('.m-head-btn.right');
  await check('psaní zprávy'); await snap('05-psani');
  await click('.composer-foot .btn.ghost');
  await check('nástroje (panel)'); await snap('06-nastroje');
  await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  await click('.composer-head button:last-child');

  await click('.m-tabs button:nth-child(3)');
  await check('social'); await snap('07-social');
  await click('.side-item', { hasText: 'Účty' });
  await check('social — účty'); await snap('08-social-ucty');

  await click('.m-tabs button:nth-child(2)');
  await check('chat — konverzace'); await snap('09-chat-seznam');
  await click('.ch-conv');
  await check('chat — vlákno'); await snap('10-chat-vlakno');
  await click('.ch-head .m-round');
  await check('chat — akce (panel)'); await snap('11-chat-akce');
  await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  await click('.ch-composer .m-round:not(.send)');
  await check('chat — nástroje (panel)'); await snap('12-chat-nastroje');
  await click('.sheet-action', { hasText: 'Vložit produkt' });
  await check('chat — produkty'); await snap('13-chat-produkty');
  await page.keyboard.press('Escape'); await page.waitForTimeout(300);

  await click('.m-back');
  await click('.sidebar-footer .side-item', { hasText: 'Nastavení chatu' });
  await check('chat — nastavení'); await snap('14-chat-nastaveni');
  await click('.modal-head .icon-btn');

  await click('.m-tabs button:nth-child(1)');
  await click('.m-head-btn');
  await click('.sidebar .side-item', { hasText: 'Nastavení' });
  await check('nastavení'); await snap('15-nastaveni');

  await page.close();
}

const pad = (t, n) => String(t).padEnd(n);
console.log(pad('zařízení', 6) + pad('obrazovka', 22) + pad('chrom', 7) + pad('lišta', 8) + 'přetéká');
for (const r of rows) {
  console.log(
    pad(r.device, 6) + pad(r.label, 22)
    + pad(`${r.chrome}/${r.viewport}`, 7)
    + pad(r.tabs === null ? '—' : r.tabs ? 'ok' : 'skrytá', 8)
    + (r.spilling.length ? r.spilling.join(', ') : '—')
  );
}
console.log(problems.length ? '\nPROBLÉMY:\n' + problems.slice(0, 14).join('\n') : '\nžádné chyby');

await browser.close();
server.close();
