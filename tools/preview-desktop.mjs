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

/*
 * Nástroje z nabídky Funkce mají vlastní okno aplikace. Prohlížeč okna
 * neotevírá, takže se náhled místo klepnutí v nabídce přepne rovnou na
 * adresu toho okna — je to tentýž balík skriptů a v okně se vykreslí
 * přesně to, co by vykreslilo v aplikaci.
 *
 * Sociální sítě jsou v seznamu taky — na počítači se přestěhovaly z
 * pracovního prostoru do vlastního okna.
 */
const NASTROJE = {
  'Produkty a překlady': 'produkty', 'Články': 'clanky', 'AI Přehled': 'prehled',
  'Balení objednávek': 'baleni', 'Katalog a naskladnění': 'katalog',
  'Texty na webu': 'texty', 'Recenze zákazníků': 'recenze', 'Konvertor médií': 'media',
  'Sociální sítě': 'socialni'
};
const vOkneNastroje = () => page.url().includes('#');
/*
 * Po adrese se musí stránka načíst znovu.
 *
 * Změna textu za mřížkou je pro prohlížeč pohyb uvnitř téže stránky — nic
 * se nepřekreslí a v okně zůstane viset pošta. Aplikace o okno adresu
 * nikdy nemění (okno se s ní rovnou otevře), takže tohle je čistě věc
 * náhledu; bez `reload` náhled ukazoval poštu a tvrdil, že nástroj chybí.
 */
const doOkna = async hash => {
  await page.goto(`http://localhost:4322/index.html#${hash}`, { waitUntil: 'load' });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1000);
};
const doPosty = async () => {
  await page.goto('http://localhost:4322/index.html', { waitUntil: 'load' });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(800);
};

const click = async (selector, options = {}) => {
  // Nástroj z nabídky = vlastní okno, ne překryv nad poštou
  if (selector === '.ws-menu-item' && NASTROJE[options.hasText]) {
    await doOkna(NASTROJE[options.hasText]);
    return;
  }
  /*
   * Přepínač prostorů je jen v hlavním okně. Zavírací křížek nástroje
   * v prohlížeči nic neudělá (`window.close()` na stránce, kterou nikdo
   * neotevřel skriptem, se ignoruje), takže se sem náhled vrací sám.
   */
  if (selector.startsWith('.ig-switch') && vOkneNastroje()) await doPosty();
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
await click('.ws-menu-item', { hasText: 'Produkty a překlady' });
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

/*
 * Zvětšení okna se přestalo nabízet — nástroj má vlastní okno aplikace a
 * velikost řeší jeho rám. V náhledu je proto rovnou na celé ploše.
 */
await overflow('překlady — zvětšeno'); await snap('02b-preklady-zvetseno');

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

/*
 * Rozklik zboží. Samotné „18 ks" nic neřekne — kam se to prodává, jestli to
 * roste a za kolik, to je až ta odpověď, podle které se objednává sklad.
 */
await click('.dg-bar-row.dg-clickable');
await overflow('přehled dne — zboží rozkliknuté'); await snap('09d2-prehled-zbozi');
await click('.dg-bar-row.dg-clickable');

/*
 * Rozbor návštěvnosti. Denní snímek říká, kolik jich přišlo; tohle odkud,
 * kudy a co z toho bylo — a je to jediné místo, kde se dá dívat dva roky.
 */
await page.evaluate(() => {
  const card = document.querySelector('.dg-deep');
  if (card) card.scrollIntoView({ block: 'start' });
});
await page.waitForTimeout(300);
await overflow('přehled — návštěvnost'); await snap('09f-prehled-navstevnost');

/*
 * Vysvětlení řádku. Čísla v tabulce jsou k ničemu tomu, kdo neví, co
 * znamenají — po najetí se proto ukáže spočítané vysvětlení a k němu závěr
 * od AI. Bublina je široká a má víc řádků, takže se hlídá, že se vejde.
 */
const kanal = page.locator('.dg-deep .dg-card', { hasText: 'Kanály' }).locator('.dg-bar-row').first();
await kanal.hover();
await page.waitForTimeout(250);
await overflow('přehled — vysvětlení kanálu'); await snap('09f2-prehled-vysvetleni');

/*
 * Starší přehled. Ukládaly se u něj jen souhrny, takže mu chybí včerejšek,
 * graf i signály — a okno na tom padalo na šedou plochu. Náhled proto
 * schválně přepne do archivu a podívá se, že se pořád má co číst.
 */
await page.evaluate(() => {
  const body = document.querySelector('.dg-body');
  if (body) body.scrollTop = 0;
});
await page.selectOption('.dg-pick', { index: 1 });
await page.waitForTimeout(400);
await overflow('přehled dne — starší'); await snap('09e-prehled-starsi');
await page.selectOption('.dg-pick', '');
await page.waitForTimeout(300);
await click('.dg-modal .modal-head .icon-btn:last-child');

await click('.ig-switch button', { hasText: 'Funkce' });
await click('.ws-menu-item', { hasText: 'Články' });
await overflow('články — seznam'); await snap('10-clanky-seznam');

await click('.ar-item');
{
  // Fotky a videa se do článku dají nahrát rovnou z počítače
  const upload = await page.locator('.ar-sec-head .btn', { hasText: 'Nahrát z počítače' }).count();
  console.log(`${'nahrání příloh z počítače'.padEnd(28)} ${upload >= 2 ? '✓' : '✗'} (${upload})`);
}
await overflow('články — zadání'); await snap('11-clanky-zadani');

/*
 * Výběr produktů. Zásoba u každého řádku je tu kvůli jediné věci: článek
 * se píše na týdny dopředu a odkaz na vyprodaný kus posílá čtenáře na
 * stránku, kde si nic nekoupí.
 */
await click('.ar-sec-head .btn', { hasText: 'Vybrat z feedu' });
await page.waitForTimeout(500);
{
  const tags = await page.locator('.ar-picker .ar-stock').count();
  console.log(`${'zásoba je u produktů vidět'.padEnd(28)} ${tags ? '✓' : '✗'} (${tags})`);
}
await overflow('články — výběr produktů'); await snap('11b-clanky-produkty');
await click('.ar-picker .modal-foot .btn.ghost', { hasText: 'Zrušit' });
await page.waitForTimeout(300);

await click('.ar-detail-head .ig-seg button', { hasText: 'Text' });
await overflow('články — text'); await snap('12-clanky-text');

await click('.ar-detail-head .ig-seg button', { hasText: 'Odkazy' });
await overflow('články — odkazy'); await snap('13-clanky-odkazy');
await click('.pt-filters .ig-seg button', { hasText: 'V článku' });
await overflow('články — odkazy v textu'); await snap('21-clanky-odkazy-v-textu');

/*
 * Statistika článku. Napsat článek je práce na půl dne a doteď nebylo kde
 * zjistit, jestli k něčemu byla — čísla i větu k nim je potřeba vidět celé.
 */
await click('.ar-detail-head .ig-seg button', { hasText: 'Statistika' });
await overflow('články — statistika'); await snap('13b-clanky-statistika');

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
/*
 * Doprava a doklady. Tři cesty vedle sebe — faktury z administrace, PPL přes
 * soubor a Zásilkovna přes API — a v nich se dá snadno přetéct, protože jsou
 * to samé řádky s poli.
 */
await page.evaluate(() => {
  const head = [...document.querySelectorAll('.field > label')]
    .find(el => el.textContent.includes('Doprava a doklady'));
  head?.scrollIntoView({ block: 'start' });
});
await page.waitForTimeout(250);
await overflow('nastavení — doprava a doklady'); await snap('22c2-nastaveni-doprava');
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
 *
 * Klepnutí má skončit u té krabice, ne v seznamu, kde se k ní musí doklikat.
 * Od doby, co má každý nástroj vlastní okno, se to okno otevře rovnou na ní
 * — okno v prohlížeči nevznikne, takže se kontroluje, že si o ně rozhraní
 * řeklo i s číslem té práce.
 */
const otevrelo = async (nastroj, popis) => {
  const volani = await page.evaluate(() => (window.__calls || []).filter(one => one[0] === 'tool:open'));
  const one = volani[volani.length - 1];
  const ok = !!one && one[1] === nastroj && !!one[2];
  console.log(`${popis.padEnd(28)} ${ok ? '✓' : '✗'} (${JSON.stringify(one ?? null)})`);
};

await overflow('proužek: práce z telefonu'); await snap('07c-zivy-prouzek');
await click('.live-offer .btn.primary');
await otevrelo('packing', 'proužek otevře objednávku');

// Totéž u naskladnění: proužek má otevřít tu relaci, na které se pracuje
await page.evaluate(() => window.__emit('live:offers', [{
  key: 'stockin:ph-a1', kind: 'stockin', id: 'ph-a1', from: 'iPhone Patrik',
  title: 'Naskladnění 30. 8. 2026', detail: '3 položky · 11 ks', at: '2026-09-01T08:05:00.000Z'
}]));
await page.waitForTimeout(200);
await click('.live-offer .btn.primary');
await otevrelo('catalog', 'proužek otevře naskladnění');

/*
 * Balení: hledání podle čísla. Ze čtečky je to vždycky faktura — přepínač je
 * vedle pole proto, aby se obě čísla nespletla; číslo faktury jedné
 * objednávky bývá číslem jiné objednávky.
 */
await click('.ig-switch button', { hasText: 'Funkce' });
await click('.ws-menu-item', { hasText: 'Balení objednávek' });
await overflow('balení — hledání podle čísla'); await snap('26b-baleni');
/*
 * Celé období, ne jen práce. Dlaždice fází nesou počty a barvu, kterou má
 * i proužek u řádku — hlídá se, že se všechno vejde a že je poznat, co je
 * k zabalení a co už je pryč.
 */
await click('.pk-phase.sent');
await overflow('balení — schovaná fáze'); await snap('26b2-baleni-faze');
await click('.pk-phase.sent');
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

// Pruh s běžícím překladem na pozadí — je vidět i mimo okno překladů
await page.evaluate(() => window.__emit('ptrans:progress', {
  running: true, done: 428, total: 1362, failed: 2, etaSeconds: 940,
  secondsPerUnit: 11.4, bar: 428 / 1362, label: 'Bordó pánská kravata BULDOČCI → SK', errors: []
}));
await overflow('pruh překladu'); await snap('09-pruh-prekladu');

/*
 * Texty na webu. Zajímá tu hlavně jedna věc: rozepsaná změna má na jedné
 * obrazovce čtyři oblasti a tři jazyky, takže právě tady hrozí, že se
 * formulář rozjede do šířky nebo se v něm ztratí, co která oblast dělá.
 */
await click('.ig-switch button', { hasText: 'Funkce' });
await click('.ws-menu-item', { hasText: 'Texty na webu' });
await overflow('texty na webu — plán'); await snap('40-texty-plan');

// Běžící změna: podle ní se pozná, jestli je v seznamu vidět fáze a oblasti
await click('.wt-row', { hasText: 'Dovolená' });
await overflow('texty na webu — změna'); await snap('41-texty-zmena');

// Nová změna přes běžící: musí se ohlásit překryv i nabídka zkrácení
await click('.wt-list .btn', { hasText: 'Nová změna' });
await page.evaluate(() => {
  const fill = (el, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const [name, from] = document.querySelectorAll('.wt-when input');
  fill(name, 'Výpadek dopravce');
  const now = new Date(Date.now() + 3600000);
  const pad = n => String(n).padStart(2, '0');
  fill(from, `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:00`);
});
await page.waitForTimeout(600);
{
  const clash = await page.locator('.wt-clash').count();
  console.log(`${'překryv se ohlásí'.padEnd(28)} ${clash ? '✓' : '✗'}`);
}
// Všechny čtyři oblasti rozbalené naráz — nejvyšší možný formulář
for (const area of ['Box u produktu', 'Horní lišta', 'Lišta s odkazy', 'Bublina u tlačítka']) {
  await click('.wt-area-head', { hasText: area });
}
await click('.wt-area .btn.ghost', { hasText: 'Přidat odkaz' });
await overflow('texty na webu — nová'); await snap('42-texty-nova');

// Slovenština: prázdné políčko má našeptat český text, ne zůstat prázdné
await click('.wt-langs .tab', { hasText: 'Slovensky' });
await overflow('texty na webu — slovensky'); await snap('43-texty-slovensky');

// Vánoční garance: nastavení, ne naplánovaná změna — má vlastní záložku
await click('.wt-head-right .tab', { hasText: 'Vánoce' });
await overflow('texty na webu — Vánoce'); await snap('44b-texty-vanoce');

await click('.wt-head-right .tab', { hasText: 'Napojení' });
await overflow('texty na webu — napojení'); await snap('44-texty-napojeni');

/*
 * Poznámka zákazníka v detailu balené objednávky a dotaz před vývozem
 * dopravci. Poznámka je jedna z mála věcí, kvůli které se objednávka balí
 * jinak — musí být vidět, ne schovaná mezi údaji o dopravě.
 */
await click('.ig-switch button', { hasText: 'Funkce' });
await click('.ws-menu-item', { hasText: 'Balení objednávek' });
await click('.pk-row', { hasText: '999090' });
await overflow('balení — poznámka'); await snap('26e-baleni-poznamka');
{
  const note = await page.locator('.pk-panel.pk-cnote').count();
  console.log(`${'poznámka je v detailu'.padEnd(28)} ${note ? '✓' : '✗'}`);
}
// Přesně „PPL", ne „Štítky PPL" — obojí je ve stejné liště
await page.locator('.pk-ship button', { hasText: /^\s*PPL\s*$/ }).first().click();
await page.waitForTimeout(600);
{
  const ask = await page.locator('.pk-notes-row').count();
  console.log(`${'ptá se na poznámky'.padEnd(28)} ${ask ? '✓' : '✗'} (${ask})`);
}
await overflow('balení — schválení poznámek'); await snap('26f-baleni-poznamky-dotaz');
await click('.modal-foot .btn.ghost', { hasText: 'Zrušit' });
await page.waitForTimeout(200);
// Poslední ikona v hlavičce je zavřít; první je obnovit
await click('.pk-modal .modal-head .icon-btn >> nth=-1');
await page.waitForTimeout(300);

/*
 * Recenze zákazníků. Podstatné je, aby bylo na první pohled vidět, co je
 * kde nepřeložené — u recenzí to je nejčastější rozdělaná práce.
 */
await click('.ig-switch button', { hasText: 'Funkce' });
await click('.ws-menu-item', { hasText: 'Recenze zákazníků' });
await page.waitForTimeout(500);
{
  const rows = await page.locator('.rv-item').count();
  const missing = await page.locator('.rv-tag.todo').count();
  console.log(`${'recenze — přehled'.padEnd(28)} ${rows && missing ? '✓' : '✗'} (${rows}, nepřeložených ${missing})`);
}
await overflow('recenze — přehled'); await snap('48-recenze-prehled');
{
  // Jazyky pod sebou: česky se píše, ostatní se překládají
  const langs = await page.locator('.rv-lang').count();
  const fields = await page.locator('.rv-lang .rv-field').count();
  console.log(`${'recenze — jazyky a pole'.padEnd(28)} ${langs === 3 && fields === 9 ? '✓' : '✗'} (${langs} jazyky, ${fields} polí)`);
}
await page.locator('.rv-item').nth(1).click();
await page.waitForTimeout(400);
await overflow('recenze — druhá'); await snap('48b-recenze-detail');

/*
 * Psaní do recenze.
 *
 * Ukládalo se po každém úhozu a odpověď ze serveru se vracela zpátky do
 * políčka: text poskakoval a v popisku (což je HTML editor) skákal kurzor na
 * začátek — vypadalo to, jako by psaní přestalo fungovat. Náhled schválně
 * odpovídá **ořezaným** textem, jako to dělá hlavní proces, takže kdyby se to
 * vrátilo, napsaná mezera by tady zmizela.
 */
{
  const podpis = page.locator('input[placeholder="Jméno zákazníka"]').first();
  await podpis.click();
  await podpis.fill('');
  await page.keyboard.type('Novák ', { delay: 40 });
  // Delší, než je pauza před uložením — odpověď ze serveru už doběhla
  await page.waitForTimeout(1200);
  const value = await podpis.inputValue();
  const focus = await page.evaluate(() =>
    document.activeElement?.getAttribute('placeholder') ?? '');
  const ok = value === 'Novák ' && focus === 'Jméno zákazníka';
  console.log(`${'psaní podpisu vydrží'.padEnd(28)} ${ok ? '✓' : '✗'} `
    + `(${JSON.stringify(value)}, zaměření ${focus || '—'})`);
}

{
  /*
   * Popisek je `contenteditable`. Píše se nadvakrát s pauzou mezi tím, aby se
   * mezi úhozy stihlo uložení: kdyby se obsah políčka přepsal odpovědí,
   * kurzor by skočil na začátek a druhá půlka by se napsala před první.
   */
  const popisek = page.locator('.rv-lang .html-rich').first();
  await popisek.click();
  await page.keyboard.press('End');
  await page.keyboard.type('AA', { delay: 40 });
  await page.waitForTimeout(1200);
  await page.keyboard.type('BB', { delay: 40 });
  await page.waitForTimeout(300);
  const text = await popisek.innerText();
  const uvnitr = await page.evaluate(() => {
    const sel = document.getSelection();
    const box = document.querySelector('.rv-lang .html-rich');
    return !!(sel && box && sel.anchorNode && box.contains(sel.anchorNode));
  });
  const ok = text.includes('AABB') && uvnitr;
  console.log(`${'kurzor v popisku neskáče'.padEnd(28)} ${ok ? '✓' : '✗'} `
    + `(${text.includes('AABB') ? 'AABB' : JSON.stringify(text.slice(-24))}, `
    + `kurzor ${uvnitr ? 'v poli' : 'pryč'})`);
}
/*
 * Odkaz na označených slovech.
 *
 * Adresa se dřív ptala přes `window.prompt`, který Electron nepodporuje:
 * kliknutí na řetěz neudělalo vůbec nic a nikde se to neozvalo.
 */
{
  const popisek = page.locator('.rv-lang .html-rich').first();
  // Označí se prvních pár písmen. Dvojklik doprostřed pole by trefil prázdno
  // pod textem a nevybral by nic.
  await popisek.click({ position: { x: 12, y: 10 } });
  await page.keyboard.press('Home');
  for (let i = 0; i < 6; i++) await page.keyboard.press('Shift+ArrowRight');
  await page.waitForTimeout(150);
  // Poslední tlačítko v liště je řetěz; před ním jsou tučně, kurzíva,
  // podtrženě, odrážky a guma
  await page.locator('.rv-lang .html-bar .icon-btn').nth(5).click();
  await page.waitForTimeout(200);
  const otevrelo = await page.locator('.html-link input').count();
  await page.locator('.html-link input').fill('quentino.cz/kravaty');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  const html = await popisek.evaluate(el => el.innerHTML);
  // Adresa bez protokolu se doplní na https — jinak by odkaz mířil na soubor
  const ok = otevrelo === 1 && html.includes('href="https://quentino.cz/kravaty"');
  console.log(`${'odkaz v popisku'.padEnd(28)} ${ok ? '✓' : '✗'} `
    + `(políčko ${otevrelo ? 'je' : 'není'}, ${html.includes('https://quentino.cz/kravaty') ? 'odkaz vložen' : 'odkaz chybí'})`);
}
await overflow('recenze — psaní'); await snap('48c-recenze-psani');

/*
 * Nový produkt. Rozhoduje se tu o jediné věci: jestli je na první pohled
 * vidět, co ještě chybí, a co v textu zůstalo po předloze. Obojí by se
 * jinak přehlédlo — a přehlédnutá barva v popisu vydrží na e-shopu měsíce.
 */
await click('.ig-switch button', { hasText: 'Funkce' });
await click('.ws-menu-item', { hasText: 'Produkty a překlady' });
await page.waitForTimeout(400);
await click('.pt-tabs button', { hasText: 'Nový produkt' });
await page.waitForTimeout(500);
{
  const drafts = await page.locator('.np-item').count();
  const blockers = await page.locator('.np-gaps button.blocker').count();
  const chips = await page.locator('.np-chip').count();
  const done = await page.locator('.np-chip.done').count();
  console.log(`${'nový produkt — rozdělané'.padEnd(28)} ${drafts === 2 ? '✓' : '✗'} (${drafts})`);
  // Přepsané specifikum musí být odlišené od toho, které v textu pořád je
  console.log(`${'z předlohy — co zbývá'.padEnd(28)} ${chips === 3 && done === 1 ? '✓' : '✗'} (${chips}, přepsané ${done})`);
  console.log(`${'co ještě chybí'.padEnd(28)} ${blockers === 0 ? '✓' : '✗'} (blokuje ${blockers})`);
  // Ceny po měnách: SK i EN prodávají v eurech, políčko má být jedno
  const eura = await page.locator('.np-field > span:text-is("Cena (€)")').count();
  console.log(`${'ceny po měnách'.padEnd(28)} ${eura === 1 ? '✓' : '✗'} (eurových polí ${eura})`);
  /*
   * Prázdné euro si řekne o přepočet z korun. Přepočítávat v hlavě u každého
   * produktu je zbytečná práce a přepsat se přitom dá čárka.
   */
  const nabidka = await page.locator('.np-rate').first().innerText().catch(() => '');
  // 890 Kč při kurzu 24,26 je 36,7 €
  console.log(`${'přepočet do eur'.padEnd(28)} ${nabidka.includes('36,7') ? '✓' : '✗'} (${nabidka || '—'})`);
  // SEO a Google vedle sebe, popis víceřádkový
  const popisy = await page.locator('.np-meta-col textarea').count();
  console.log(`${'SEO a Google vedle sebe'.padEnd(28)} ${popisy === 2 ? '✓' : '✗'} (popisů ${popisy})`);
  /*
   * Nic nesmí přetékat z karty ven. Poslední políčko v „Základu" se
   * uřezávalo o kraj a nebylo to vidět, dokud se na to člověk nepodíval.
   */
  const preteka = await page.evaluate(() => [...document.querySelectorAll(
    '.np-basics, .np-meta, .np-side, .np-box'
  )].filter(el => el.scrollWidth > el.clientWidth + 1).length);
  console.log(`${'nic nepřetéká'.padEnd(28)} ${preteka === 0 ? '✓' : '✗'} (přetékajících ${preteka})`);
}
await overflow('nový produkt — rozdělaný'); await snap('49-novy-produkt');

/*
 * Strom kategorií. Zabalený strom je k ničemu, když v zabalené větvi něco
 * vybraného je — rozbalí se proto sám a u zabalených větví svítí počet.
 */
{
  const vybrane = await page.locator('.np-chip-cat').count();
  const hlavni = await page.locator('.np-chip-cat.main').count();
  console.log(`${'kategorie — vybrané nahoře'.padEnd(28)} ${vybrane === 2 && hlavni === 1 ? '✓' : '✗'} (${vybrane}, hlavní ${hlavni})`);
  /*
   * Kšandy nemají nic vybraného, takže zůstanou zabalené i s podkategorií.
   * Doplňky vybrané mají, takže se rozbalí samy — schovaná vybraná kategorie
   * by vypadala, že vybraná není.
   */
  const skryta = await page.locator('.np-cat label:has-text("Dětské kšandy")').count();
  const videt = await page.locator('.np-cat label:has-text("Kravaty")').count();
  console.log(`${'zabalené a rozbalené větve'.padEnd(28)} ${skryta === 0 && videt >= 1 ? '✓' : '✗'} `
    + `(schováno ${skryta ? 'ne' : 'ano'}, vybraná větev ${videt ? 'vidět' : 'schovaná'})`);

}

/*
 * Jazyky v záložkách. Pod sebou se v nich nedalo vyznat — česky se píše
 * celou dobu, kdežto do překladů se kouká až na konci.
 */
{
  const zalozky = await page.locator('.np-side .np-langs button').count();
  const tecky = await page.locator('.np-dot').count();
  console.log(`${'jazyky v záložkách'.padEnd(28)} ${zalozky === 3 && tecky === 2 ? '✓' : '✗'} (${zalozky}, nepřeložené ${tecky})`);
  await click('.np-side .np-langs button', { hasText: 'SK' });
  await page.waitForTimeout(250);
  await overflow('nový produkt — slovensky'); await snap('49c-novy-produkt-sk');
  await click('.np-side .np-langs button', { hasText: 'CZ' });
  await page.waitForTimeout(250);
}

/*
 * Nabídka u parametru se musí dát rozbalit celá i u vyplněného políčka —
 * `<input list>` v tom ukazoval jen to, co odpovídalo napsanému textu.
 */
{
  await page.locator('.np-params .np-suggest-open').first().click();
  await page.waitForTimeout(200);
  const moznosti = await page.locator('.np-suggest-list button').count();
  const vyplneno = await page.locator('.np-params .np-suggest input').first().inputValue();
  console.log(`${'nabídka parametrů'.padEnd(28)} ${moznosti === 3 && vyplneno ? '✓' : '✗'} (${moznosti} u „${vyplneno}")`);
  await overflow('nový produkt — nabídka parametrů'); await snap('49d-novy-produkt-parametry');
  await page.keyboard.press('Escape');
  await page.locator('.np-head').click();
  await page.waitForTimeout(200);
}

await page.locator('.np-item').nth(1).click();
await page.waitForTimeout(400);
{
  const blockers = await page.locator('.np-gaps button.blocker').count();
  console.log(`${'prázdný produkt hlásí chybějící'.padEnd(28)} ${blockers === 6 ? '✓' : '✗'} (${blockers})`);
}
await overflow('nový produkt — prázdný'); await snap('49b-novy-produkt-prazdny');
await click('.pt-modal .modal-head .icon-btn >> nth=-1');
await page.waitForTimeout(300);

/*
 * Konvertor médií. Zajímá tu hlavně záložka Focení: hlídaná složka běží na
 * pozadí, takže na ní musí být na první pohled poznat, že jede, a jaký
 * ořez se použije.
 */
await click('.ig-switch button', { hasText: 'Funkce' });
await click('.ws-menu-item', { hasText: 'Konvertor médií' });
await overflow('média — soubory'); await snap('45-media-soubory');

/*
 * Fotky produktů. Seznam musí na první pohled ukázat, co ještě není ve WebP
 * — z toho se pracuje a bez barevné značky by se to muselo číst řádek po
 * řádku.
 */
await click('.md-modal .ig-seg button', { hasText: 'Produkty' });
await page.waitForTimeout(500);
{
  const items = await page.locator('.mp-item').count();
  const tags = await page.locator('.mp-tag.todo, .mp-tag.half').count();
  console.log(`${'produkty s chybějícím WebP'.padEnd(28)} ${items && tags ? '✓' : '✗'} (${items}, značek ${tags})`);
}
await overflow('média — produkty'); await snap('45b-media-produkty');
// Produkt s půlkou hotovou — na něm je vidět, že se předvybírají jen nepřevedené
await click('.mp-item', { hasText: 'Manžetové' });
await page.waitForTimeout(400);
{
  const shots = await page.locator('.mp-shot').count();
  const chosen = await page.locator('.mp-shot.on').count();
  console.log(`${'předvybrané jsou nepřevedené'.padEnd(28)} ${shots && chosen < shots ? '✓' : '✗'} (${chosen} z ${shots})`);
}
await overflow('média — fotky produktu'); await snap('45c-media-produkt-detail');

/*
 * Srovnání před a po. Oba rámečky musí být stejně velké — kdyby se výsledek
 * kreslil menší, vypadal by hůř kvůli zmenšení, ne kvůli kompresi.
 */
await click('.mp-peek >> nth=1');
await page.waitForTimeout(900);
{
  const panes = await page.locator('.mc-view').count();
  const sizes = await page.locator('.mc-view').evaluateAll(
    list => list.map(el => Math.round(el.getBoundingClientRect().width)));
  const same = sizes.length === 2 && Math.abs(sizes[0] - sizes[1]) <= 1;
  console.log(`${'srovnání má dva stejné rámečky'.padEnd(28)} ${panes === 2 && same ? '✓' : '✗'} (${sizes.join(' × ')})`);
}
await overflow('média — před a po'); await snap('45d-media-srovnani');
await click('.mc-modal .modal-head .icon-btn >> nth=-1');
await page.waitForTimeout(300);

/*
 * Záložka se dřív jmenovala „Focení" — stejně jako celý nový nástroj v nabídce
 * Funkce, což byly dvě různé věci pod jedním jménem. Tady jsou to hlídané
 * složky, kam fotoaparát odkládá soubory; focení samo je vlastní okno.
 */
await click('.md-modal .ig-seg button', { hasText: 'Hlídané složky' });
await page.waitForTimeout(400);
{
  const folders = await page.locator('.md-folder').count();
  const running = await page.locator('.md-folder.on').count();
  console.log(`${'hlídané složky'.padEnd(28)} ${folders ? '✓' : '✗'} (${folders}, z toho běží ${running})`);
}
await overflow('média — focení'); await snap('46-media-foceni');

await click('.md-modal .ig-seg button', { hasText: 'Nastavení' });
await overflow('média — nastavení'); await snap('47-media-nastaveni');

console.log(problems.length ? '\nPROBLÉMY:\n' + problems.slice(0, 10).join('\n') : '\nžádné chyby');
await browser.close();
server.close();
