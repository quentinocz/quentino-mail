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
// `safeTop`/`safeBottom`: Chromium `env(safe-area-inset-*)` neumí nasimulovat,
// takže se proměnné přebijí ručně. Bez toho by náhled ukazoval telefon bez
// výřezu a odsazení hlavičky by se nikdy neprověřilo.
const DEVICES = [
  { name: 'se', width: 375, height: 667, safeTop: 20, safeBottom: 0 },  // iPhone SE / 8 — bez výřezu
  { name: 'i15', width: 393, height: 852, safeTop: 59, safeBottom: 34 } // s výřezem a proužkem
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
    deviceScaleFactor: device.desktop ? 1 : 2,
    isMobile: !device.desktop,
    hasTouch: !device.desktop
  });
  /*
   * Odznak objednávky v provozu čeká na e-shop a na dopravce — a právě
   * v té chvíli se na telefonu dřív koukalo na číslo s cenou místo dopravy
   * a platby. Náhled to zdrží schválně, aby bylo na snímku vidět, že
   * zkratky naskočí i bez něj.
   */
  await page.addInitScript(() => { window.__badgeDelay = 4000; });
  page.on('pageerror', e => problems.push(`${device.name}: chyba stránky: ${e.message}`));
  page.on('console', m => {
    // Chybějící favicona v náhledu nic neznamená
    if (m.type() === 'error' && !/favicon/.test(m.text() + m.location().url)) {
      problems.push(`${device.name}: konzole: ${m.text()}`);
    }
  });

  if (device.safeTop || device.safeBottom) {
    await page.addStyleTag({ content:
      `:root { --safe-top: ${device.safeTop ?? 0}px; --safe-bottom: ${device.safeBottom ?? 0}px; }` });
  }
  await page.goto('http://localhost:4321/index.html', { waitUntil: 'load' });
  await page.waitForTimeout(900);
  if (device.safeTop || device.safeBottom) {
    await page.addStyleTag({ content:
      `:root { --safe-top: ${device.safeTop ?? 0}px; --safe-bottom: ${device.safeBottom ?? 0}px; }` });
  }

  const click = async (selector, options = {}) => {
    try { await page.locator(selector, options).first().click({ timeout: 3000 }); }
    catch { problems.push(`${device.name}: nešlo kliknout: ${selector}${options.hasText ? ` (${options.hasText})` : ''}`); }
    await page.waitForTimeout(450);
  };

  const snap = async (name) => {
    await page.waitForTimeout(350);
    await page.screenshot({ path: path.join(SHOTS, `${device.name}-${name}.png`) });
  };

  /*
   * Gesta se v náhledu musí opravdu provést, ne jen předpokládat — tah přes
   * řádek je kód, který se nedá zkontrolovat okem na statickém obrázku.
   * Dotyky se posílají jako skutečné události, takže projdou stejnou cestou
   * jako prst na displeji.
   */
  const swipe = async (selector, dx, dy = 0) => {
    await page.evaluate(({ selector, dx, dy }) => {
      const el = document.querySelector(selector);
      if (!el) throw new Error('není co táhnout: ' + selector);
      const r = el.getBoundingClientRect();
      const x0 = Math.max(2, r.left + Math.min(40, r.width / 2));
      const y0 = r.top + Math.min(40, r.height / 2);
      const send = (type, x, y) => {
        const list = [new Touch({ identifier: 1, target: el, clientX: x, clientY: y })];
        const done = type === 'touchend';
        el.dispatchEvent(new TouchEvent(type, {
          bubbles: true, cancelable: true,
          touches: done ? [] : list, targetTouches: done ? [] : list, changedTouches: list
        }));
      };
      send('touchstart', x0, y0);
      for (let i = 1; i <= 8; i++) send('touchmove', x0 + (dx * i) / 8, y0 + (dy * i) / 8);
      send('touchend', x0 + dx, y0 + dy);
    }, { selector, dx, dy });
    await page.waitForTimeout(400);
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
      /*
       * Co leží pod výřezem.
       *
       * Rozhraní kreslí přes celou obrazovku, takže si o odsazení musí
       * každá nejvýš položená hlavička říct sama přes `--safe-top`. Když
       * na to jedna zapomene, schová se pod hodinami a nikdo si toho
       * nevšimne, dokud to neuvidí na skutečném telefonu. Hledá se proto
       * text a tlačítka, která začínají výš, než kam sahá bezpečná zóna.
       */
      const safeTop = parseFloat(getComputedStyle(document.documentElement)
        .getPropertyValue('--safe-top')) || 0;
      const underNotch = [];
      if (safeTop > 0) {
        for (const el of document.querySelectorAll('button, a, input, h1, h2, h3, .brand, [class*="head"]')) {
          const r = el.getBoundingClientRect();
          if (r.width < 8 || r.height < 8 || r.bottom <= 0) continue;
          const style = getComputedStyle(el);
          if (style.visibility === 'hidden') continue;
          // Hlavička smí pod výřez sahat **pozadím** — o to právě jde, ať
          // pruh nezůstane prázdný. Vadí až obsah pod ním. Když má prvek
          // horní okraj aspoň tak velký jako bezpečná zóna, je to vyřešené.
          if (parseFloat(style.paddingTop) >= safeTop - 2) continue;
          // Co odrolovalo nad okraj rolující plochy, není vidět — hlásit to
          // jako „pod výřezem" by bylo plané: jen se to schovalo pod hlavičku
          // vlastního rámu. Bere se proto ten kus, který je skutečně vidět.
          let visibleTop = r.top;
          for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
            const how = getComputedStyle(n);
            if (!/auto|scroll|hidden/.test(how.overflowY + how.overflow)) continue;
            visibleTop = Math.max(visibleTop, n.getBoundingClientRect().top);
          }
          if (visibleTop >= r.bottom) continue;   // odrolované úplně mimo
          if (visibleTop >= safeTop - 2) continue;
          const text = (el.textContent ?? '').trim().slice(0, 24);
          underNotch.push(`${String(el.className || el.tagName).slice(0, 24)}${text ? ` „${text}"` : ''}`);
        }
      }
      return {
        spilling: [...new Set(spilling)].slice(0, 4),
        underNotch: [...new Set(underNotch)].slice(0, 3),
        tabs: onTop('.m-tabs'),
        chrome: Math.round(chrome),
        viewport: window.innerHeight
      };
    });
    rows.push({ device: device.name, label, ...data });
  };

  await check('pošta — seznam'); await snap('01-seznam');

  // Tah přes zprávu odkryje akce — doleva to, co zprávu odklidí,
  // doprava to, co se dá vzít zpět
  await swipe('.msg-item', -150);
  console.log('  odsun doleva:', await page.evaluate(() =>
    getComputedStyle(document.querySelector('.swipe-front')).transform));
  await check('pošta — tah přes zprávu'); await snap('01c-tah-zprava');
  // Zavřít se musí tahem zpátky; klepnutí vedle by otevřelo jinou zprávu
  await swipe('.msg-item', 220);
  await page.waitForTimeout(250);
  await swipe('.msg-item', 200);
  console.log('  odsun doprava:', await page.evaluate(() =>
    getComputedStyle(document.querySelector('.swipe-front')).transform));
  await check('pošta — tah doprava'); await snap('01d-tah-doprava');
  await swipe('.msg-item', -300);
  await page.waitForTimeout(250);
  console.log('  po zavření:', await page.evaluate(() =>
    getComputedStyle(document.querySelector('.swipe-front')).transform));

  // Tažení dolů nad začátkem seznamu = synchronizace
  await swipe('.msg-list', 0, 120);
  await page.waitForTimeout(150);

  await click('.m-round[aria-label="Filtry a řazení"]');
  await check('filtry (panel)'); await snap('02-filtry');
  await page.keyboard.press('Escape'); await page.waitForTimeout(350);

  await click('.msg-item');
  await check('zpráva'); await snap('03-zprava');

  await click('.m-round[aria-label="Další akce"]');
  await check('akce zprávy (panel)'); await snap('04-akce');
  await page.keyboard.press('Escape'); await page.waitForTimeout(350);

  // Odpověď je ten případ, kde se psaní na telefonu lámalo: hlavička je
  // předvyplněná, text dlouhý a pod ním ještě podpis
  await click('.toolbar-btn.primary', { hasText: 'Odpovědět' });
  await check('odpověď — hlavička sbalená'); await snap('04b-odpoved');
  await click('.compose-summary');
  await check('odpověď — hlavička rozbalená'); await snap('04c-odpoved-hlavicka');
  await click('.compose-collapse');
  await click('.sig-row .linkish');
  // Až dolů: dřív tady podpis končil uprostřed a měl vlastní posuvník
  await page.evaluate(() => {
    const body = document.querySelector('.composer-body');
    if (body) body.scrollTop = body.scrollHeight;
  });
  await check('odpověď — podpis'); await snap('04d-odpoved-podpis');
  await click('.composer-head button:last-child');
  await page.waitForTimeout(300);

  await click('.m-head-btn');   // zpět na seznam
  await click('.m-head-btn.right');
  await check('psaní zprávy'); await snap('05-psani');
  await click('.composer-foot .btn.ghost');
  await check('nástroje (panel)'); await snap('06-nastroje');

  // Poukazy: hláška o dvojím vydání kódu je hodně textu na úzký displej
  await click('button', { hasText: 'Dárkový poukaz' });
  await check('poukazy — výběr'); await snap('06b-poukazy-vyber');
  await click('.btn.ghost', { hasText: 'Spravovat šablony' });
  await check('poukazy — kolize'); await snap('06c-poukazy-kolize');
  await page.keyboard.press('Escape'); await page.waitForTimeout(300);

  await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  await click('.composer-head button:last-child');

  await click('.m-tabs button:nth-child(3)');
  await click('.sheet-action', { hasText: 'Sociální sítě' });
  await check('social'); await snap('07-social');
  // Účty a značka jsou nově pod „…" — pás pilulek se na telefon nevešel
  await click('.ig-topbar .m-round');
  await check('social — panel'); await snap('07b-social-panel');
  await click('.sheet-action', { hasText: 'Účty a připojení' });
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
  await click('.ch-brandrow .m-round');
  await click('.sheet-action', { hasText: 'Nastavení chatu' });
  await check('chat — nastavení'); await snap('14-chat-nastaveni');
  await click('.modal-head .icon-btn');

  await click('.m-tabs button:nth-child(1)');
  // Složky se otevírají klepnutím na název složky v hlavičce
  // Funkce mají místo ve spodní liště, kde býval Instagram
  await click('.m-tabs button:nth-child(3)');
  await check('funkce (panel)'); await snap('13b-funkce');

  /*
   * AI Přehled. Na telefonu se čte ráno jako první a je to jediné okno
   * s grafem — dlaždice se musí složit po dvou a proužky se nesmí vysypat
   * z šířky displeje.
   */
  await click('.sheet-action', { hasText: 'AI Přehled' });
  await check('přehled dne'); await snap('13c-prehled-dne');
  await page.evaluate(() => {
    const body = document.querySelector('.dg-body');
    if (body) body.scrollTop = body.scrollHeight;
  });
  await page.waitForTimeout(250);
  await check('přehled dne — postřehy'); await snap('13d-prehled-postrehy');
  await click('.dg-modal .modal-head .icon-btn:last-child');
  await click('.m-tabs button:nth-child(3)');

  await click('.sheet-action', { hasText: 'Balení objednávek' });
  await check('balení — seznam'); await snap('14-baleni-seznam');
  await click('.pk-row');
  await check('balení — objednávka'); await snap('15-baleni-detail');
  /*
   * Balení se čtečkou: hledáček je nativní pruh nahoře, rozhraní si pod ním
   * musí udělat místo. V náhledu tam zůstane prázdno — kontroluje se právě to,
   * že se seznam položek vejde pod něj a nezůstane schovaný za spodní lištou.
   */
  await page.locator('.pk-modal .modal-head .icon-btn').last().click();
  await page.waitForTimeout(400);
  // Čtečka se ptá při otevření okna, takže se odpověď přepíše mezi otevřeními
  await page.evaluate(() => {
    window.__answers['scan:available'] = true;
    window.__answers['scan:start'] = { panel: 267 };
  });
  await click('.m-tabs button:nth-child(3)');
  await click('.sheet-action', { hasText: 'Balení objednávek' });
  await page.waitForTimeout(600);
  await click('.pk-row');
  await page.locator('.pk-modal .modal-head .icon-btn').first().click();
  await page.waitForTimeout(500);
  await page.evaluate(() => window.__emit?.('scan:code', { text: 'QM-042' }));
  await page.waitForTimeout(400);
  await check('balení — čtečka'); await snap('15b-baleni-ctecka');
  /*
   * Načtení faktury staré objednávky: musí ji to přidat do seznamu, otevřít
   * a nahoře říct, že je podle feedu doručená — jinak by se zabalila znovu.
   */
  await page.evaluate(() => window.__emit?.('scan:code', { text: '998700' }));
  await page.waitForTimeout(500);
  await check('balení — stará objednávka'); await snap('15c-baleni-stara');
  await page.locator('.pk-modal .modal-head .icon-btn').first().click();
  await page.waitForTimeout(300);
  // V hlavičce balení jsou dvě ikony (obnovit, zavřít) — zavírá ta poslední
  try { await page.locator('.pk-modal .modal-head .icon-btn').last().click({ timeout: 3000 }); }
  catch { problems.push(`${device.name}: nešlo zavřít balení`); }
  await page.waitForTimeout(400);
  // Katalog: na telefonu je to hlavně naskladnění u regálu — pole pro čtečku
  // musí být palcem dosažitelné a mřížka produktů čitelná po dvou
  await click('.m-tabs button:nth-child(3)');
  await click('.sheet-action', { hasText: 'Katalog a naskladnění' });
  await check('katalog — produkty'); await snap('16-katalog');
  await click('.kat-open');
  await check('katalog — detail'); await snap('17-katalog-detail');
  await click('.kat-sheet-head .icon-btn');
  await click('.kat-tabs button', { hasText: 'Naskladnění' });
  await check('naskladnění — seznam'); await snap('18-naskladneni');
  await click('.kat-session-open');
  await check('naskladnění — řádky'); await snap('19-naskladneni-radky');
  /*
   * Hledáček jen v horní části, stejně jako u balení: nahoře fotoaparát,
   * dole počet na pípnutí a mezi tím seznam toho, co je načtené. Bez
   * seznamu by se pípalo naslepo a týž kód by se snadno přidal dvakrát.
   */
  await click('.kat-scanbtn');
  await page.waitForTimeout(500);
  await check('naskladnění — čtečka'); await snap('19b-naskladneni-ctecka');
  await click('.kat-scanbtn');
  await page.waitForTimeout(400);
  await click('.modal-foot .btn.ghost', { hasText: 'Zkontrolovat' });
  await check('naskladnění — co se zapíše'); await snap('20-naskladneni-plan');
  // Hledání podle názvu: štítek občas chybí a kód se po paměti nepíše
  await page.fill('.kat-scan', 'kšandy');
  await page.waitForTimeout(500);
  await check('naskladnění — našeptávač'); await snap('21-naseptavac');
  await click('.kat-hit-main');
  await check('naskladnění — varianty'); await snap('22-naseptavac-varianty');
  await click('.modal-head .icon-btn');
  await page.waitForTimeout(300);

  await click('.m-head-picker');
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

// Pod výřezem nemá být nic — každá nejvýš položená hlavička si musí říct
// o odsazení přes `--safe-top`
const notch = rows.filter(r => r.underNotch?.length);
if (notch.length) {
  console.log('\nPOD VÝŘEZEM:');
  for (const r of notch) console.log(`  ${pad(r.device, 6)}${pad(r.label, 22)}${r.underNotch.join(' · ')}`);
}

console.log(problems.length ? '\nPROBLÉMY:\n' + problems.slice(0, 14).join('\n') : '\nžádné chyby');
if (notch.length || problems.length) process.exitCode = 1;

await browser.close();
server.close();
