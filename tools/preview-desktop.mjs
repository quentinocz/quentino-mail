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

/*
 * Odeslaná pošta: ve sloupci má být příjemce, ne my — odesílatel jsme tam
 * pořád my a vlastní jméno u každého řádku nic neříká. U čerstvé pošty má být
 * čas, u starší datum; obojí se pozná jedině pohledem na seznam.
 */
await click('.side-item', { hasText: 'Odeslaná pošta' });
await page.waitForTimeout(500);
await overflow('pošta — odeslané'); await snap('01c-odeslane');
await click('.side-item', { hasText: 'Vše' });
await page.waitForTimeout(400);

// Překlady se otevírají z nabídky Funkce — v panelu už samostatnou položku nemají
await click('.ig-switch button', { hasText: 'Funkce' });
await click('.ws-menu-item', { hasText: 'Překlady produktů' });
await overflow('překlady — seznam'); await snap('01-preklady-seznam');

await click('.pt-row');
await overflow('překlady — detail'); await snap('02-preklady-detail');

// Karta otevřeného produktu se musí obnovit sama, jakmile překlad postoupí
{
  await click('.pt-row');
  const before = await page.locator('.pt-cell').first().innerText().catch(() => '');
  await page.evaluate(() => {
    // Jako by právě doběhl překlad názvu do slovenštiny
    const page0 = window.__answers && window.__answers['ptrans:fields'];
    if (page0) page0.forEach(f => { if (f.field === 'title' && f.lang === 'sk') f.translated = 'ČERSTVĚ PŘELOŽENO'; });
    window.__emit('ptrans:progress', { running: true, done: 1, total: 2, failed: 0, etaSeconds: 5, secondsPerUnit: 3, label: 'PSSK120BR2 → Slovenština', errors: [] });
  });
  await page.waitForTimeout(500);
  // Překlady jsou v textových polích — `innerText` je nevidí, hodnota ano
  const after = await page.evaluate(() =>
    [...document.querySelectorAll('textarea, .rt-editor')].map(el => el.value ?? el.textContent).join(' '));
  console.log(`${'karta se obnoví sama'.padEnd(28)} ${after.includes('ČERSTVĚ PŘELOŽENO') ? '✓' : '✗'}`);
  void before;
  await page.evaluate(() => window.__emit('ptrans:progress',
    { running: false, done: 2, total: 2, failed: 0, etaSeconds: 0, secondsPerUnit: 3, label: '', errors: [] }));
  await page.waitForTimeout(200);
}

// Přeložený produkt nesmí ze seznamu zmizet uprostřed práce — zůstane na
// místě označený jako hotový a uklidí se až při dalším hledání
await page.evaluate(() => { window.__translated = 'MZU01'; window.__emit('ptrans:changed', {}); });
await page.waitForTimeout(500);
await overflow('překlady — po překladu'); await snap('01b-preklady-po-prekladu');
{
  const held = await page.locator('.pt-row.kept').count();
  // Změna filtru je „nové hledání" — podržený řádek se má uklidit
  await page.selectOption('.pt-filters select >> nth=1', 'all');
  await page.waitForTimeout(400);
  const after = await page.locator('.pt-row.kept').count();
  await page.selectOption('.pt-filters select >> nth=1', 'todo');
  await page.waitForTimeout(400);
  console.log(`${'podržený řádek'.padEnd(28)} po překladu: ${held}, po změně filtru: ${after}`
    + (held === 1 && after === 0 ? ' ✓' : ' ✗'));
}

// Zvětšené okno: s tisícem produktů se v malém dialogu pracuje mizerně
await click('.pt-modal .modal-head .icon-btn');
await overflow('překlady — zvětšeno'); await snap('02b-preklady-zvetseno');
await click('.pt-modal .modal-head .icon-btn');
await page.waitForTimeout(200);

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

// Karta produktu: Google a SEO — nejdřív zpátky na Produkty a vybrat řádek
await click('.pt-tabs button', { hasText: 'Produkty' });
await click('.pt-row');
await click('.pt-detail-head .ig-seg button', { hasText: 'Google a SEO' });
await overflow('produkt — Google'); await snap('17-produkt-google');
await click('.pt-detail-head .ig-seg button', { hasText: 'Texty' });

await click('.pt-tabs button', { hasText: 'Kvalita' });
await overflow('kvalita — audit'); await snap('18-kvalita-audit');
await click('.pt-filters .ig-seg button', { hasText: 'Barvy' });
await overflow('kvalita — barvy'); await snap('19-kvalita-barvy');
await click('.pt-filters .ig-seg button', { hasText: 'Sety' });
await overflow('kvalita — sety'); await snap('20-kvalita-sety');
await click('.pt-tabs button', { hasText: 'Produkty' });

await click('.pt-tabs button', { hasText: 'Paměť' });
await overflow('překlady — paměť'); await snap('07-preklady-pamet');
await page.keyboard.press('Escape');
await click('.pt-modal .modal-head .icon-btn:last-child');

// Nabídka AI v postranním panelu
await click('.ig-switch button', { hasText: 'Funkce' });
await overflow('nabídka Funkce'); await snap('08-nabidka-funkci');

/*
 * AI Přehled. Je to jediné okno, kde se čte víc čísel než vět — proto se
 * hlídá zvlášť: dlaždice, graf i seznam k vyřízení se musí vejít vedle sebe
 * a nic z toho nesmí přetéct.
 */
await click('.ws-menu-item', { hasText: 'AI Přehled' });
await overflow('přehled dne'); await snap('09b-prehled-dne');
await click('.dg-switch button', { hasText: 'tržba' });
await overflow('přehled dne — tržba'); await snap('09c-prehled-trzba');
// Střed okna: dlouhodobá čísla, stavy, velikosti a sítě — všechno bez AI
await page.evaluate(() => {
  const body = document.querySelector('.dg-body');
  if (body) body.scrollTop = Math.round(body.scrollHeight * 0.42);
});
await page.waitForTimeout(250);
await overflow('přehled dne — dlouhodobě'); await snap('09c2-prehled-dlouhodobe');

// Spodek okna: postřehy od AI a doptávání nad týmiž čísly
await page.evaluate(() => {
  const body = document.querySelector('.dg-body');
  if (body) body.scrollTop = body.scrollHeight;
});
await page.waitForTimeout(250);
await overflow('přehled dne — postřehy'); await snap('09d-prehled-postrehy');
await click('.dg-modal .modal-head .icon-btn:last-child');

await click('.ig-switch button', { hasText: 'Funkce' });
await click('.ws-menu-item', { hasText: 'Články' });
await overflow('články — seznam'); await snap('10-clanky-seznam');

await click('.ar-item');
await overflow('články — zadání'); await snap('11-clanky-zadani');

await click('.ar-detail-head .ig-seg button', { hasText: 'Text' });
await overflow('články — text'); await snap('12-clanky-text');

await click('.ar-detail-head .ig-seg button', { hasText: 'Odkazy' });
await overflow('články — odkazy'); await snap('13-clanky-odkazy');
await click('.pt-filters .ig-seg button', { hasText: 'V článku' });
await overflow('články — odkazy v textu'); await snap('21-clanky-odkazy-v-textu');

await click('.ar-modal .pt-tabs button', { hasText: 'Odkazy' });
await overflow('články — kontrola'); await snap('14-clanky-kontrola');

await click('.ar-modal .pt-tabs button', { hasText: 'Mapa adres' });
await overflow('články — mapa'); await snap('15-clanky-mapa');

await click('.ar-modal .pt-tabs button', { hasText: 'Nastavení' });
await overflow('články — nastavení'); await snap('16-clanky-nastaveni');

// Feed Instagramu — mřížka dlaždic je sdílená s telefonem, takže se hlídá
// i tady, jestli se řady nerozjíždějí podle poměru stran obrázků
await click('.ar-modal .modal-head .icon-btn:last-child');
await click('.ig-switch button', { hasText: 'Funkce' });
await click('.ws-menu-item', { hasText: 'Sociální sítě' });
await overflow('social — feed'); await snap('24-social-feed');
console.log('  výšky dlaždic:', await page.evaluate(() =>
  [...new Set([...document.querySelectorAll('.ig-tile')]
    .map(el => Math.round(el.getBoundingClientRect().height)))].join(', ')));
/*
 * Chat: dlouhý seznam konverzací. Právě na něm se ukázalo, že se řádky ve
 * flex sloupci smršťují do proužků, a přepínač Otevřené/Vše musí mít obě
 * půlky stejně široké.
 */
await click('.ig-switch button', { hasText: 'Chat' });
await page.waitForTimeout(600);
await overflow('chat — dlouhý seznam'); await snap('24b-chat-seznam');
await click('.ch-seg button', { hasText: 'Vše' });
await page.waitForTimeout(400);
await overflow('chat — vše'); await snap('24c-chat-vse');

await click('.ig-switch button', { hasText: 'Pošta' });

// Nastavení → AI: feedy objednávek jsou dole, proto se k nim odroluje
await click('.side-item', { hasText: 'Nastavení' });
await click('.modal-head button, .tabs button', { hasText: 'AI' });
await page.evaluate(() => {
  const label = [...document.querySelectorAll('.modal-body label')]
    .find(el => /Feedy objedn/.test(el.textContent ?? ''));
  label?.scrollIntoView({ block: 'center' });
});
await overflow('nastavení — feedy objednávek'); await snap('22-feedy-objednavek');

// Nastavení → Telefon: upozornění přes ntfy. Zvlášť se kouká na to, jestli se
// vejde dlouhé SQL pro Supabase, které se ukáže až na vyžádání.
await click('.tabs button', { hasText: 'Telefon' });
await overflow('nastavení — telefon'); await snap('22b-nastaveni-telefon');
/*
 * Slovník zkratek dopravy a plateb. Na telefonu je to jediné, co se na
 * odznak u zprávy vejde — a taky to jediné, co se z něj ráno čte.
 */
await click('.tabs .tab', { hasText: 'AI' });
await page.evaluate(() => {
  document.querySelector('.sh-list')?.scrollIntoView({ block: 'center' });
});
await page.waitForTimeout(250);
await overflow('nastavení — zkratky dopravy'); await snap('22c-nastaveni-zkratky');
// Zpátky na Telefon — další kroky pokračují tam
await click('.tabs .tab', { hasText: 'Telefon' });
await page.waitForTimeout(200);
await click('.btn.ghost', { hasText: 'Nastavení chatu v Supabase' });
await page.waitForTimeout(300);
await page.evaluate(() => document.querySelector('.modal-body')?.scrollTo(0, 9999));
await overflow('nastavení — SQL pro chat'); await snap('22c-nastaveni-chat-sql');

await page.keyboard.press('Escape');
await page.waitForTimeout(400);

// Poukazy: správa šablon je místo, kde se pozná zásoba kódů i to, že jeden
// kód vydala dvě zařízení — hláška o kolizi je nová a musí být vidět.
// Nastavení se zavírají křížkem: Escape spolkne rozepsané pole s feedy.
await click('.modal-head .icon-btn:last-child');
await page.waitForTimeout(300);
await click('.btn-compose');
await click('.toolbar-btn', { hasText: 'Poukaz' });
await overflow('poukazy — výběr šablony'); await snap('23-poukazy-vyber');
await click('.modal-foot .btn, .btn.ghost', { hasText: 'Spravovat šablony' });
await overflow('poukazy — kolize kódu'); await snap('24-poukazy-kolize');
await click('.vch-tpl-main');
await overflow('poukazy — zásoba kódů'); await snap('25-poukazy-zasoba');
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
await page.keyboard.press('Escape');
await page.waitForTimeout(400);

// Uvolnění místa ve schránce — otevírá se z ukazatele obsazení v panelu.
// Nejdřív se musí zavřít rozepsaná zpráva, jinak ji Escape jen nechá být.
await click('.composer-foot .btn', { hasText: 'Zavřít' });
await page.waitForTimeout(400);
await click('.quota-box');
await page.waitForTimeout(200);
await click('.cl-filters .btn');
await overflow('uvolnění místa'); await snap('26-uvolnit-misto');
await click('.modal-foot .btn.ghost', { hasText: 'Zavřít' });
await page.waitForTimeout(300);

/*
 * Proužek s rozdělanou prací z telefonu. Nevyskakuje přes obrazovku — na
 * počítači může být rozepsaná odpověď zákazníkovi — jen se nabídne dole.
 */
await overflow('proužek: práce z telefonu'); await snap('07c-zivy-prouzek');
// Klepnutí má skončit u té krabice, ne v seznamu, kde se k ní musí doklikat
await click('.live-offer .btn.primary');
await overflow('proužek: pokračování u objednávky'); await snap('07d-zivy-otevreno');
await click('.modal-head .icon-btn:last-child');
await page.waitForTimeout(300);

// Totéž u naskladnění: proužek má otevřít tu relaci, na které se pracuje
await page.evaluate(() => window.__emit('live:offers', [{
  key: 'stockin:ph-a1', kind: 'stockin', id: 'ph-a1', from: 'iPhone Patrik',
  title: 'Naskladnění 30. 8. 2026', detail: '3 položky · 11 ks', at: '2026-09-01T08:05:00.000Z'
}]));
await page.waitForTimeout(200);
await click('.live-offer .btn.primary');
await overflow('proužek: pokračování u naskladnění'); await snap('07e-zivy-naskladneni');
await click('.modal-head .icon-btn:last-child');
await page.waitForTimeout(300);

/*
 * Balení: hledání podle čísla. Ze čtečky je to vždycky faktura — přepínač je
 * vedle pole proto, aby se obě čísla nespletla; číslo faktury jedné
 * objednávky bývá číslem jiné objednávky.
 */
await click('.ig-switch button', { hasText: 'Funkce' });
await click('.ws-menu-item', { hasText: 'Balení objednávek' });
await overflow('balení — hledání podle čísla'); await snap('26b-baleni');
await click('.pk-as button', { hasText: 'objednávka' });
await overflow('balení — hledání podle objednávky'); await snap('26c-baleni-objednavka');

/*
 * Odškrtnutí z druhého zařízení. Musí se objevit v zaškrtávátkách, ne jen
 * v databázi — přesně tohle chybělo: v databázi to bylo, na obrazovce ne.
 */
await page.evaluate(() => window.__emit('packing:changed', {
  id: 1, code: '20260819', packed: [0, 1], counts: { '0': 1, '1': 2 }, done: false, doneAt: null
}));
await page.waitForTimeout(200);
await overflow('balení — odškrtnuto z telefonu'); await snap('26d-baleni-z-telefonu');
await click('.modal-head .icon-btn:last-child');
await page.waitForTimeout(300);

// Katalog: mřížka s obrázky a zásobou, detail s variantami, naskladnění a štítky.
// Tři záložky nad jedním seznamem — kontroluje se hlavně to, že se arch
// štítků vejde vedle ovládání a mřížka nezůstane s dírou v řadě.
await click('.ig-switch button', { hasText: 'Funkce' });
await click('.ws-menu-item', { hasText: 'Katalog a naskladnění' });
await overflow('katalog — produkty'); await snap('27-katalog');
console.log('  karet v řadě:', await page.evaluate(() => {
  const cards = [...document.querySelectorAll('.kat-card')];
  const top = cards[0]?.getBoundingClientRect().top;
  return cards.filter(el => Math.abs(el.getBoundingClientRect().top - top) < 2).length;
}));
await click('.kat-open');
await overflow('katalog — detail s variantami'); await snap('28-katalog-detail');
await click('.kat-sheet-head .icon-btn');

await click('.kat-tabs button', { hasText: 'Naskladnění' });
await overflow('naskladnění — seznam'); await snap('29-naskladneni');
await click('.kat-session');
await overflow('naskladnění — řádky'); await snap('30-naskladneni-radky');
await click('.modal-foot .btn.ghost', { hasText: 'Zkontrolovat' });
await overflow('naskladnění — co se zapíše'); await snap('31-naskladneni-plan');

// Hledání podle názvu s rozbalenými variantami — bez něj by se kód musel
// psát po paměti pokaždé, když štítek chybí
await page.fill('.kat-scan', 'kšandy');
await page.waitForTimeout(500);
await click('.kat-hit-main');
await overflow('naskladnění — našeptávač'); await snap('31b-naseptavac');

// Štítky se sázejí z vybraných produktů — nejdřív se tedy dva zaškrtnou
await click('.kat-tabs button', { hasText: 'Produkty' });
await page.evaluate(() => {
  [...document.querySelectorAll('.kat-pick input')].slice(0, 2).forEach(el => el.click());
});
await page.waitForTimeout(300);
await click('.kat-tabs button', { hasText: 'Štítky' });
await overflow('štítky — rozvržení a náhled'); await snap('32-stitky');

// Vývoz pro štítkovou tiskárnu: Zebra dostane hotový soubor, Brother CSV
// do vlastní šablony — jazyk, který by šel poslat rovnou, totiž nemá
await click('.kat-formats button', { hasText: 'Zebra' });
await overflow('štítky — Zebra'); await snap('33-stitky-zebra');
await click('.kat-formats button', { hasText: 'CSV' });
await overflow('štítky — CSV'); await snap('34-stitky-csv');
await click('.kat-formats button', { hasText: 'Archy A4' });

// Koupený arch kulatých štítků: rozteč i okraje jsou dané výsekem, tak ať
// je vidět, že se náhled trefí do kruhů a ne do mřížky
await click('.kat-templates button', { hasText: 'Kulaté' });
await overflow('štítky — kulatý arch'); await snap('34b-stitky-arch');
await click('.kat-countby button', { hasText: 'Podle skladu' });
await overflow('štítky — počty podle skladu'); await snap('34c-stitky-sklad');
await click('.kat-countby button', { hasText: 'Pevný počet' });
await click('.kat-templates button', { hasText: 'Vlastní arch' });

/*
 * Naskladněné zboží se polepuje hned — štítky se vezmou rovnou z relace.
 * Nejdřív se ale zahodí předchozí výběr: přesně tak se to dělá v provozu
 * a přesně tam to dřív skončilo výzvou „vyber produkty", protože se
 * rozhodovalo podle zaškrtnutých produktů místo podle toho, co je k tisku.
 */
await click('.kat-tabs button', { hasText: 'Štítky' });
await click('.modal-foot .btn.ghost', { hasText: 'Zrušit výběr' });
await click('.kat-tabs button', { hasText: 'Naskladnění' });
// Záložka se otevře znovu na seznamu relací, takže se do jedné musí vstoupit
await click('.kat-session');
await click('.modal-foot .btn.ghost', { hasText: 'Štítky' });
await overflow('štítky — z naskladnění'); await snap('34d-stitky-naskladneni');
// Bez položek k tisku by tlačítko nedávalo smysl — tady jich je dvaadvacet
await page.waitForSelector('.kat-preview iframe');

// Hromadný výběr: stránka jich ukazuje šedesát, filtr může mít stovky
await click('.kat-tabs button', { hasText: 'Produkty' });
await click('.modal-foot .btn.ghost', { hasText: 'Vybrat vše' });
await overflow('katalog — vybráno vše'); await snap('35-vybrat-vse');
await click('.modal-head .icon-btn');
await page.waitForTimeout(300);

// Pruh s běžícím překladem na pozadí — je vidět i mimo okno překladů
await page.evaluate(() => window.__emit('ptrans:progress', {
  running: true, done: 428, total: 1362, failed: 2, etaSeconds: 940,
  secondsPerUnit: 11.4, bar: 428 / 1362, label: 'Bordó pánská kravata BULDOČCI → SK', errors: []
}));
await overflow('pruh překladu'); await snap('09-pruh-prekladu');

console.log(problems.length ? '\nPROBLÉMY:\n' + problems.slice(0, 10).join('\n') : '\nžádné chyby');
await browser.close();
server.close();
