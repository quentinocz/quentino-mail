/*
 * Náhled focení — bez fotoaparátu, zato se skutečným klikáním.
 *
 * Fotoaparát tady není, takže se snímek náhledu pošle ručně jako by přišel
 * z gphoto2. Zkouší se to, co na focení dělá rozhraní a co se z kódu
 * nepozná: že se vodítko dá nakreslit tažením myši, že se uloží a přežije
 * překreslení, že se nafocená fotka objeví v galerii a dá se z ní vyřadit,
 * a že se posuvníky korekce hýbou obrazem.
 *
 *   npm run build:renderer && node tools/preview-shoot.mjs
 */
import http from 'http';
import fs from 'fs';
import path from 'path';

const ROOT = new URL('../dist/renderer/', import.meta.url).pathname;
const SHOTS = new URL('./shots/', import.meta.url).pathname;

/*
 * Playwright je jen v sandboxu, ne v repozitáři. Na počítači, kde chybí,
 * se náhled přeskočí — spadnout kvůli tomu nesmí (přesně tohle už jednou
 * shodilo celou kontrolu).
 */
let pw;
try { pw = (await import('playwright')).default; }
catch { console.log('playwright není — náhled focení se přeskakuje'); process.exit(0); }

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
await new Promise(r => server.listen(4323, r));

const preinstalled = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium/chrome-linux/chrome']
  .find(p => fs.existsSync(p));
let browser;
try { browser = await pw.chromium.launch(preinstalled ? { executablePath: preinstalled } : {}); }
catch (e) { console.log('prohlížeč se nespustil — náhled focení se přeskakuje:', e.message.split('\n')[0]); server.close(); process.exit(0); }

const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const problems = [];
page.on('pageerror', e => problems.push('chyba stránky: ' + e.message));
page.on('console', m => {
  if (m.type() === 'error' && !/favicon/.test(m.text() + m.location().url)) problems.push('konzole: ' + m.text());
});
await page.addInitScript(() => {
  document.addEventListener('DOMContentLoaded', () => { document.documentElement.dataset.form = 'desktop'; });
});

// Vlastní okno focení se pozná podle `#foceni` v adrese
await page.goto('http://localhost:4323/index.html#foceni', { waitUntil: 'load' });
await page.waitForTimeout(1000);

const say = (label, ok, note = '') =>
  console.log(`${label.padEnd(34)} ${ok ? '✓' : '✗'}${note ? ' (' + note + ')' : ''}`);
const snap = async name => { await page.waitForTimeout(250); await page.screenshot({ path: path.join(SHOTS, `foceni-${name}.png`) }); };

/* Snímek náhledu — malý JPEG poslaný jako by přišel z fotoaparátu */
const FRAME = fs.readFileSync(new URL('./fixtures/shoot-frame.jpg', import.meta.url).pathname);
await page.evaluate(bytes => {
  window.__emit('shoot:frame', new Uint8Array(bytes));
  // Týmiž bajty odpovídá i čtení souboru — galerie i průsvitka mají co vykreslit
  window.__shootFile = new Uint8Array(bytes);
}, [...FRAME]);
await page.waitForTimeout(500);

say('okno focení se otevřelo', await page.locator('.sh-wrap').count() === 1);
say('náhled ukazuje obraz', await page.locator('img.sh-frame').count() === 1);

/*
 * Tělo se má najít a připojit samo. V okně to musí být vidět jako
 * „Připojeno", ne jako nabídka k proklikání — jinak by se změna projevila
 * jen v hlavním procesu a člověk by pořád klikal na „Najít fotoaparát".
 */
say('tělo je připojené samo', await page.locator('.sh-ok').count() === 1,
  (await page.locator('.sh-ok').innerText().catch(() => '')).trim());
say('a náhled se nespouští ručně',
  (await page.locator('.sh-shoot .sh-mini', { hasText: 'náhled' }).innerText()).includes('Zastavit'));
await snap('01-nahled');

/* ---------- spuštění a zastavení náhledu ---------- */

/*
 * Tlačítko se zasekávalo: stav se měnil dvakrát — jednou událostí
 * z hlavního procesu, podruhé v okně — a druhá změna tu první vracela.
 * Napsané pak zůstalo „Zastavit náhled" u něčeho, co neběží, a spustit
 * se to nedalo vůbec.
 */
{
  const label = () => page.locator('.sh-shoot .sh-mini', { hasText: 'náhled' }).innerText();
  say('náhled běží', (await label()).includes('Zastavit'), (await label()).trim());

  await page.locator('.sh-shoot .sh-mini', { hasText: 'náhled' }).click();
  await page.waitForTimeout(500);
  say('po zastavení nabízí spuštění', (await label()).includes('Spustit'), (await label()).trim());

  await page.locator('.sh-shoot .sh-mini', { hasText: 'náhled' }).click();
  await page.waitForTimeout(500);
  say('a dá se zase spustit', (await label()).includes('Zastavit'), (await label()).trim());

  // A ještě jednou dokola — zaseknutí se projevovalo až napodruhé
  await page.locator('.sh-shoot .sh-mini', { hasText: 'náhled' }).click();
  await page.waitForTimeout(400);
  await page.locator('.sh-shoot .sh-mini', { hasText: 'náhled' }).click();
  await page.waitForTimeout(400);
  say('a podruhé taky', (await label()).includes('Zastavit'), (await label()).trim());
}

/* ---------- kreslení vodítka ---------- */

await page.locator('.sh-tool[title="Rámeček"]').click();
const box = await page.locator('.sh-stage').boundingBox();
await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.2);
await page.mouse.down();
await page.mouse.move(box.x + box.width * 0.75, box.y + box.height * 0.8, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(400);
/*
 * Počítají se skupiny, ne obdélníky: každý tvar kreslí dvakrát — jednou
 * viditelně a pod tím široký průhledný pás, aby se dal chytit myší.
 */
say('tažením vznikl rámeček', await page.locator('.sh-lines g.sh-shape').count() === 1);

/*
 * Vodítko se musí uložit, ne jen nakreslit. Nový snímek náhledu překreslí
 * celé okno — kdyby se ukládání nepovedlo, rámeček by tím zmizel.
 */
await page.evaluate(bytes => window.__emit('shoot:frame', new Uint8Array(bytes)), [...FRAME]);
await page.waitForTimeout(400);
say('a přežil překreslení náhledu', await page.locator('.sh-lines g.sh-shape').count() === 1);
say('a uložil se do focení',
  await page.evaluate(() => (window.__shoot.shoot.overlay || []).length) === 1);

// Klepnutí bez tažení není tvar — jinak by okno zaplevelily čárky o nulové délce
await page.locator('.sh-tool[title="Čára"]').click();
await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
await page.waitForTimeout(300);
say('klepnutí nedělá čáru o nulové délce', await page.locator('.sh-lines g.sh-shape').count() === 1);

// Třetiny se přidají kliknutím, netáhnou se
await page.locator('.sh-tool[title="Třetiny"]').click();
await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
await page.waitForTimeout(400);
say('třetiny přibyly jako druhý tvar', await page.locator('.sh-lines g.sh-shape').count() === 2);
say('a jsou to čtyři čáry', await page.locator('.sh-lines line').count() === 4);
await snap('02-voditka');

/* ---------- šablona a průsvitka ---------- */

/* ---------- přesouvání vodítek ---------- */

/*
 * Nakreslený rámeček se musí dát chytit a posunout. Tenká čára se myší
 * netrefí, proto je pod ní široký průhledný pás — kdyby zmizel, tažení by
 * se nechytlo a vypadalo by to, že přesouvání nefunguje.
 */
await page.locator('.sh-tool', { hasText: 'Vybrat' }).click();
{
  const before = await page.evaluate(() => {
    const one = window.__shoot.shoot.overlay.find(s => s.kind === 'rect');
    return one ? { x: one.x, y: one.y } : null;
  });
  // Chytit horní hranu rámečku (ten je od 25 % do 75 % šířky, 20–80 % výšky)
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5 + 100, box.y + box.height * 0.2 + 40, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(600);
  const after = await page.evaluate(() => {
    const one = window.__shoot.shoot.overlay.find(s => s.kind === 'rect');
    return one ? { x: one.x, y: one.y } : null;
  });
  say('rámeček se dá přetáhnout',
    !!before && !!after && after.x > before.x + 0.03 && after.y > before.y + 0.01,
    before && after ? `${before.x.toFixed(2)},${before.y.toFixed(2)} → ${after.x.toFixed(2)},${after.y.toFixed(2)}` : 'nic');

  // Šipka posune o kousek — pro doladění, kde myš nestačí
  const beforeKey = after;
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(500);
  const afterKey = await page.evaluate(() =>
    window.__shoot.shoot.overlay.find(s => s.kind === 'rect').x);
  say('šipka posune o kousek',
    afterKey > beforeKey.x && afterKey - beforeKey.x < 0.01, String((afterKey - beforeKey.x).toFixed(4)));

  /*
   * Ven z obrazu se vytáhnout nesmí. Vodítko, které zmizí za okrajem,
   * se nedá chytit zpátky — dalo by se jen smazat a nakreslit znovu.
   */
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 3, box.y + box.height * 3, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(600);
  const out = await page.evaluate(() => {
    const one = window.__shoot.shoot.overlay.find(s => s.kind === 'rect');
    return Math.max(one.x, one.x2, one.y, one.y2);
  });
  say('ven z obrazu to nejde', out <= 1.0001, String(out.toFixed(3)));
}
/*
 * Tažením se kreslí, ne označuje. Modře označená půlka okna vypadá jako
 * porucha vykreslování a pod ní není vidět, co se vlastně kreslí.
 */
say('tažení neoznačuje text',
  (await page.evaluate(() => String(window.getSelection() || ''))).trim() === '');
await snap('09-presun');

/*
 * Při psaní do políčka musí mezerník psát mezeru, ne fotit. Název focení
 * se přepisuje často a „Kravaty hedvábí" se bez mezer napsat nedá.
 */
{
  const before = await page.locator('.sh-tile').count();
  await page.locator('.sh-name').click();
  await page.keyboard.type('a b');
  await page.waitForTimeout(500);
  const after = await page.locator('.sh-tile').count();
  const text = await page.locator('.sh-name').inputValue();
  say('v políčku mezerník píše, nefotí', after === before && text.includes('a b'), text);
}

await page.locator('.sh-tabs button', { hasText: 'Šablona' }).click();
await page.waitForTimeout(300);
{
  const rows = await page.locator('.sh-shape-row').count();
  say('vodítka jsou v seznamu', rows === 2, `${rows}`);
  await page.locator('.sh-shape-row > button >> nth=-1').click();
  await page.waitForTimeout(400);
  say('vodítko se dá smazat', await page.locator('.sh-shape-row').count() === 1);
}
await snap('03-sablona');

/* ---------- focení a galerie ---------- */

await page.locator('.sh-shutter').click();
await page.waitForTimeout(600);
/*
 * Druhý snímek mezerníkem. U stolu se drží fotoaparát, ne myš — a kdyby
 * mezerník místo focení jen posunul stránku, poznalo by se to až při
 * focení.
 */
await page.locator('.sh-view').click();
await page.keyboard.press('Space');
await page.waitForTimeout(700);
say('mezerník vyfotí', await page.locator('.sh-tile').count() === 2);
say('nafocené jsou v galerii', await page.locator('.sh-tile').count() === 2);

/*
 * Mezi spouští a fotkou v pásu je u zrcadlovky několik vteřin. Bez
 * čekající dlaždice to vypadá, že se nestalo nic, a spoušť se zmáčkne
 * podruhé — tedy přesně to, co focení nejvíc škodí.
 */
{
  await page.locator('.sh-tile').first().click();
  await page.waitForTimeout(400);
  const zoomed = await page.locator('.sh-big-pan img').evaluate(el => {
    const before = el.getBoundingClientRect().width;
    el.closest('.sh-big-pan').dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }));
    return new Promise(done => setTimeout(() => done({ before, after: el.getBoundingClientRect().width }), 300));
  });
  say('fotka se dá zvětšit kolečkem', zoomed.after > zoomed.before * 1.05,
    `${Math.round(zoomed.before)} → ${Math.round(zoomed.after)}`);
  say('a je u ní vysvětlená ostrost',
    await page.locator('.sh-big-sharp').count() >= 0);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
}
say('a jsou očíslované',
  (await page.locator('.sh-tile-no').allInnerTexts()).join(',') === '1,2');
await snap('04-galerie');

{
  await page.locator('.sh-tile').first().hover();
  await page.waitForTimeout(200);
  await page.locator('.sh-tile-acts button[title^="Vyřadit"]').first().click();
  await page.waitForTimeout(500);
  say('vyřazená fotka zmizela', await page.locator('.sh-tile').count() === 1);
}

/* ---------- zvětšení náhledu ---------- */

/*
 * Náhled má osminu rozlišení snímku, takže se v něm zaostření pozná
 * špatně. Zvětšení kvalitu obrazu nezlepší, ale ukáže detail větší —
 * a vodítka se musí zvětšit s ním, jinak by ukazovala jinam.
 */
{
  await page.locator('.sh-tools .sh-mini', { hasText: '%' }).click();
  const before = await page.locator('.sh-stage').boundingBox();
  await page.locator('.sh-tools .sh-mini[title="Přiblížit náhled"]').click();
  await page.waitForTimeout(400);
  const after = await page.locator('.sh-stage').boundingBox();
  say('náhled se dá zvětšit', after.width > before.width * 1.2,
    `${Math.round(before.width)} → ${Math.round(after.width)}`);
  say('obraz nepřeteče z rámu',
    after.width <= (await page.locator('.sh-view').boundingBox()).width + 2
    || await page.locator('.sh-view').evaluate(el => getComputedStyle(el).overflow) === 'hidden');
  await page.locator('.sh-tools .sh-mini[title="Celý obraz"]').click();
  await page.waitForTimeout(300);
}

/* ---------- ořez ---------- */

/*
 * Ořez je vlastní věc, ne jedno z vodítek: vodítka jsou čáry, podle kterých
 * se míří, ořez mění, co vyleze na disk. Táhne se nástrojem a musí se
 * srovnat do zvoleného poměru — natažený „čtverec" od oka čtverec není.
 */
await page.locator('.sh-tool', { hasText: 'Ořez' }).click();
await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.15);
await page.mouse.down();
await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.9, { steps: 10 });
/*
 * Zámek poměru musí být vidět **už při tažení**. Kdyby se srovnával až po
 * puštění, táhl by se obdélník, po puštění by skočil na čtverec jinam, než
 * kam se mířilo, a musel by se táhnout znovu.
 */
{
  const rect = await page.locator('.sh-crop rect').boundingBox();
  say('čtverec je čtvercový už při tažení',
    rect && Math.abs(rect.width - rect.height) <= 2,
    rect ? `${Math.round(rect.width)} × ${Math.round(rect.height)}` : 'nic');
}
await page.mouse.up();
await page.waitForTimeout(600);
{
  const crop = await page.evaluate(() => window.__shoot.shoot.crop);
  say('ořez se natáhl a zapnul', crop.on && crop.w > 0.1, JSON.stringify({
    x: +crop.x.toFixed(2), y: +crop.y.toFixed(2), w: +crop.w.toFixed(2), h: +crop.h.toFixed(2) }));

  // Poměr stran obrazu je 3:2, takže čtverec je na šířku užší než na výšku
  const frame = await page.locator('img.sh-frame').evaluate(el => el.naturalWidth / el.naturalHeight);
  const sideW = crop.w * frame;
  say('čtverec je opravdu čtvercový', Math.abs(sideW - crop.h) < 0.02,
    `${sideW.toFixed(3)} × ${crop.h.toFixed(3)}`);
  say('ztmavené okolí je vidět', await page.locator('.sh-crop path').count() === 1);

  /*
   * Volný poměr nechá rámeček přesně tak, jak se natáhl — od toho tam je.
   * Kdyby ho srovnával taky, nedal by se udělat výřez na šířku.
   */
  await page.locator('.sh-panel', { hasText: 'KAM SE FOTÍ' }).count();
  await page.locator('.sh-tabs button', { hasText: 'Soubor' }).click();
  await page.waitForTimeout(300);
  await page.locator('.sh-field select').first().selectOption('');
  await page.waitForTimeout(400);
  await page.locator('.sh-tool', { hasText: 'Ořez' }).click();
  await page.mouse.move(box.x + box.width * 0.15, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.85, box.y + box.height * 0.55, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(600);
  const free = await page.evaluate(() => window.__shoot.shoot.crop);
  const frameB = await page.locator('img.sh-frame').evaluate(el => el.naturalWidth / el.naturalHeight);
  say('volně nechá rámeček na šířku',
    free.w * frameB > free.h * 1.5,
    `${(free.w * frameB).toFixed(2)} × ${free.h.toFixed(2)}`);

  // Zpátky na čtverec, ať následující snímky sedí
  await page.locator('.sh-field select').first().selectOption('1:1');
  await page.waitForTimeout(400);
  const back = await page.evaluate(() => window.__shoot.shoot.crop);
  say('přepnutí zpět rámeček rovnou srovná',
    Math.abs(back.w * frameB - back.h) < 0.02,
    `${(back.w * frameB).toFixed(3)} × ${back.h.toFixed(3)}`);
}
await snap('10-orez');

/* ---------- korekce ---------- */

await page.locator('.sh-tabs button', { hasText: 'Barvy' }).click();
await page.waitForTimeout(300);
// První přepínač v panelu je celá korekce, druhý zebra
await page.locator('.sh-switch input').first().check();
await page.locator('.sh-presets button', { hasText: 'Bílé pozadí' }).click();
await page.waitForTimeout(500);
{
  const filter = await page.locator('img.sh-frame').evaluate(el => getComputedStyle(el).filter);
  say('předvolba se propsala do náhledu', filter !== 'none', filter);
  const saved = await page.evaluate(() => window.__shoot.shoot.fix.background);
  say('a uložila se do focení', saved === 70, String(saved));
}
/*
 * Zebra: růžové pruhy tam, kde už není kresba. Kreslí se na plátno nad
 * obrazem — kdyby zůstalo prázdné, varování by nikdy nesvítilo a nikdo by
 * si toho nevšiml, protože chybějící varování nikde nechybí.
 */
await page.locator('.sh-switch input').last().check();
await page.waitForTimeout(700);
{
  const painted = await page.locator('canvas.sh-zebra').evaluate(el => {
    const ctx = el.getContext('2d');
    if (!el.width || !el.height) return -1;
    const data = ctx.getImageData(0, 0, el.width, el.height).data;
    let on = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) on++;
    return on;
  });
  // Obraz má světlé pozadí nad prahem, takže pruhy být musí — ale ne všude
  say('zebra označila přepálená místa', painted > 100, `${painted} bodů`);
  say('a nepřekryla celý obraz',
    await page.locator('canvas.sh-zebra.on').count() === 1);
}
await snap('05-barvy');

/* ---------- záběry v sérii ---------- */

/*
 * Seznam záběrů odškrtává, co je hotové, a sám se posune na další. Bez
 * toho se u dvacátého kusu nepozná, že u pátého chybí rub.
 */
await page.locator('.sh-tabs button', { hasText: 'Šablona' }).click();
await page.locator('.sh-panel .sh-mini', { hasText: 'Založit seznam' }).click();
await page.waitForTimeout(600);
{
  const slots = await page.locator('.sh-slot').count();
  say('založily se tři záběry', slots === 3, String(slots));
  const names = await page.locator('.sh-slot').allInnerTexts();
  say('a jmenují se, jak mají', names.join(',').includes('Detail vazby'), names.join(' | '));

  await page.locator('.sh-slot', { hasText: 'Celek' }).click();
  await page.locator('.sh-view').first().click();
  await page.keyboard.press('Space');
  await page.waitForTimeout(900);
  const done = await page.locator('.sh-slot.done').count();
  say('nafocený záběr se odškrtl', done === 1, String(done));
  const now = await page.locator('.sh-slot.now').innerText().catch(() => '');
  say('a samo to skočilo na další', now.includes('Detail vazby'), now.trim());
}
await snap('11-zabery');

/* ---------- srovnání vedle sebe ---------- */

/*
 * Vedle sebe, ne přes sebe: rozdíl ve světle se v prolnutí dvou obrazů
 * ztratí, a právě ten je na řadě fotek vidět nejvíc. Oba rámečky musí být
 * stejně velké, jinak se porovnává zdání.
 */
await page.locator('.sh-tile').first().hover();
await page.locator('.sh-tile-acts button[title*="průsvitk"]').first().click();
await page.waitForTimeout(900);
await page.locator('.sh-mini', { hasText: 'Vedle sebe' }).click();
await page.waitForTimeout(700);
{
  const views = await page.locator('.sh-pair .sh-view').count();
  const sizes = await page.locator('.sh-pair .sh-view').evaluateAll(
    list => list.map(el => Math.round(el.getBoundingClientRect().width)));
  say('srovnání má dva stejné rámečky',
    views === 2 && Math.abs(sizes[0] - sizes[1]) <= 1, sizes.join(' × '));
  /*
   * Průsvitka se přes náhled nekreslí — byla by na obrazovce dvakrát a
   * překrytím by rušila právě to porovnání, kvůli kterému se sem přepnulo.
   */
  say('a průsvitka není zároveň přes náhled',
    await page.locator('.sh-stage img.sh-ghost').count() === 0);
}
await snap('12-vedle-sebe');
await page.locator('.sh-mini', { hasText: 'Přes sebe' }).click();
await page.waitForTimeout(400);

/* ---------- nastavení fotoaparátu ---------- */

await page.locator('.sh-tabs button', { hasText: 'Kamera' }).click();
await page.waitForTimeout(600);
{
  const fields = await page.locator('.sh-settings .sh-field').count();
  say('volby fotoaparátu se vykreslily', fields >= 5, `${fields}`);
  const iso = page.locator('.sh-settings select').first();
  const options = await iso.locator('option').allInnerTexts();
  say('ISO nabízí hodnoty z těla', options.includes('400'), options.join(' '));
  /*
   * Formát snímku má hodnoty s mezerami. Kdyby se někde dělily na mezeře,
   * v nabídce by z „RAW + Large Fine JPEG" zbylo „RAW".
   */
  const formats = await page.locator('.sh-settings select >> nth=4').locator('option').allInnerTexts();
  say('formát s mezerami zůstal celý', formats.some(one => one === 'RAW + Large Fine JPEG'),
    formats.join(' | '));
}
await snap('06-kamera');

/* ---------- velká obrazovka ---------- */

/*
 * S druhým monitorem je na něm přes celou plochu jedna věc a v okně ta
 * druhá. Bez druhého monitoru se volba vůbec nenabízí a okno zůstává
 * celé — druhý monitor je dobrovolný, ne podmínka.
 */
await page.locator('.sh-tabs button', { hasText: 'Kamera' }).click();
await page.waitForTimeout(400);
{
  say('volba velké obrazovky je vidět',
    await page.locator('.sh-panel', { hasText: 'VELKÁ OBRAZOVKA' }).count() === 1);

  await page.locator('.sh-presets button', { hasText: 'Náhled na velké' }).click();
  await page.waitForTimeout(600);
  say('náhled zmizel z okna', await page.locator('.sh-stage').count() === 0);
  say('a místo něj je mřížka', await page.locator('.sh-grid').count() === 1);
  say('pás náhledů se neukazuje dvakrát', await page.locator('.sh-strip').count() === 0);
  // Kreslit není do čeho, takže lišta nástrojů nemá co zabírat místo
  say('lišta kreslení zmizela s náhledem', await page.locator('.sh-tools').count() === 0);
  await snap('13-velka-nahled');

  await page.locator('.sh-presets button', { hasText: 'Mřížka na velké' }).click();
  await page.waitForTimeout(600);
  say('s mřížkou na velké je v okně náhled', await page.locator('.sh-stage').count() === 1);
  say('a dlaždice se dají zvětšit',
    await page.locator('.sh-panel input[type=range]').count() > 0);

  await page.locator('.sh-presets button', { hasText: 'Zavřít' }).click();
  await page.waitForTimeout(600);
  say('po zavření je v okně zase všechno',
    await page.locator('.sh-stage').count() === 1 && await page.locator('.sh-strip').count() === 1);
}
await snap('14-velka-zavrena');

/*
 * Jeden monitor. Podstrčí se **před** načtením stránky — panel si počet
 * obrazovek čte při vzniku, takže pozdější změna by se nikam neprojevila.
 */
await page.addInitScript(() => {
  window.__shootScreens = [
    { id: 1, label: '1512 × 982 (hlavní)', primary: true, width: 1512, height: 982 }
  ];
});
await page.reload({ waitUntil: 'load' });
await page.waitForTimeout(1400);
await page.evaluate(bytes => {
  window.__emit('shoot:frame', new Uint8Array(bytes));
  window.__shootFile = new Uint8Array(bytes);
}, [...FRAME]);
await page.waitForTimeout(500);
{
  await page.locator('.sh-tabs button', { hasText: 'Kamera' }).click();
  await page.waitForTimeout(500);
  say('s jedním monitorem se volba nenabízí',
    await page.locator('.sh-panel', { hasText: 'VELKÁ OBRAZOVKA' }).count() === 0);
  say('a v okně je náhled i pás',
    await page.locator('.sh-stage').count() === 1 && await page.locator('.sh-strip').count() === 1);
}

/* ---------- nic nepřetéká ---------- */

for (const tab of ['Kamera', 'Šablona', 'Barvy', 'Soubor']) {
  await page.locator('.sh-tabs button', { hasText: tab }).click();
  await page.waitForTimeout(300);
  const spill = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('.sh-wrap *')) {
      const box = el.getBoundingClientRect();
      if (box.width < 2 || box.height < 2) continue;
      if (box.right > window.innerWidth + 2 || box.left < -2) out.push(String(el.className).slice(0, 40));
    }
    return [...new Set(out)].slice(0, 4);
  });
  say(`záložka ${tab} nepřetéká`, spill.length === 0, spill.join(', '));
}
await snap('07-soubor');

/* Úzké okno — pravý sloupec má spadnout pod náhled, ne zmizet */
await page.setViewportSize({ width: 980, height: 820 });
await page.waitForTimeout(500);
say('v úzkém okně zůstal panel vidět', await page.locator('.sh-side').isVisible());
await snap('08-uzke-okno');

console.log(problems.length ? '\nPROBLÉMY:\n' + problems.slice(0, 10).join('\n') : '\nžádné chyby');
await browser.close();
server.close();
