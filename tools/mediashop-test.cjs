/**
 * Zkouška fotek produktů v konvertoru médií.
 *
 * Samotný převod dělá Chromium v okně a nahrání do administrace cizí
 * stránka — ani jedno odsud nejde. Zkouší se to, co o výsledku rozhoduje
 * a co se okem nepozná:
 *
 *  1. **stav podle feedu** — přípona v adrese obrázku je jediné, podle čeho
 *     se pozná, co už je hotové; špatně přečtená znamená, že se práce buď
 *     dělá dvakrát, nebo se přeskočí,
 *  2. **paměť na den** — feed se stahuje jednou denně, takže čerstvě nahraný
 *     produkt musí být označený i proti feedu; po dni rozhoduje zase feed,
 *     jinak by se schovala i neúspěšná nahrání,
 *  3. **filtr „chybí WebP"** — z něj se pracuje, a produkt bez fotek v něm
 *     nemá co dělat,
 *  4. **adresa produktu v administraci** a **pořadí vodítek k políčku na
 *     fotky** — na stránce produktu je políček na soubor víc a vložit fotky
 *     k příloze je tichá chyba.
 */
const path = require('path');
const { db, DIST } = require('./ptrans/harness.cjs');

let failed = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${label}`);
  if (!ok) { console.log('      čekáno:', JSON.stringify(want)); console.log('      dostal:', JSON.stringify(got)); }
}
function ok(label, condition, detail = '') {
  if (!condition) failed++;
  console.log(`  ${condition ? '✓' : '✗'} ${label}`);
  if (!condition && detail) console.log('      ', detail);
}

/* Katalog: jen sloupce, které procházení potřebuje */
db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    code TEXT PRIMARY KEY,
    title_cz TEXT NOT NULL DEFAULT '', url_cz TEXT NOT NULL DEFAULT '', price_cz TEXT NOT NULL DEFAULT '',
    title_sk TEXT NOT NULL DEFAULT '', url_sk TEXT NOT NULL DEFAULT '', price_sk TEXT NOT NULL DEFAULT '',
    title_en TEXT NOT NULL DEFAULT '', url_en TEXT NOT NULL DEFAULT '', price_en TEXT NOT NULL DEFAULT '',
    image TEXT, images TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '', categories TEXT NOT NULL DEFAULT '',
    manufacturer TEXT NOT NULL DEFAULT '', availability TEXT NOT NULL DEFAULT '',
    stock INTEGER, price_num REAL, ean TEXT NOT NULL DEFAULT '',
    product_id TEXT NOT NULL DEFAULT '', stock_at TEXT NOT NULL DEFAULT '',
    search TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS product_variants (
    code TEXT PRIMARY KEY, product_code TEXT NOT NULL, variant_id TEXT NOT NULL DEFAULT '',
    label TEXT NOT NULL DEFAULT '', ean TEXT NOT NULL DEFAULT '', availability TEXT NOT NULL DEFAULT '',
    stock INTEGER, price TEXT NOT NULL DEFAULT '', main INTEGER NOT NULL DEFAULT 0,
    sort INTEGER NOT NULL DEFAULT 0
  );
`);

const CDN = 'https://quentino.cz/_obchody/quentino/obrazky';
function put(code, title, id, images) {
  db.prepare(
    `INSERT OR REPLACE INTO products (code, title_cz, url_cz, image, images, product_id, stock)
     VALUES (?,?,?,?,?,?,?)`
  ).run(code, title, `https://quentino.cz/${code}`, images[0] ?? null, images.join('\n'), id, 5);
}

put('QK-001', 'Kravata Onyx', '1351', [`${CDN}/onyx-1.webp`, `${CDN}/onyx-2.webp`]);
put('QK-002', 'Kravata Rubín', '1352', [`${CDN}/rubin-1.jpg`, `${CDN}/rubin-2.JPG`]);
put('QK-003', 'Motýlek Perla', '1353', [`${CDN}/perla-1.webp`, `${CDN}/perla-2.png?v=4`]);
put('QK-004', 'Kšandy bez fotky', '1354', []);

const shop = require(path.join(DIST, 'mediashop.js'));
const { __test } = shop;

console.log('\nfotky produktů:\n');

/* ---------- přípona z adresy ---------- */

check('přípona z adresy', __test.extOf(`${CDN}/onyx-1.webp`), 'webp');
// Verze za otazníkem je běžná u obrázků z administrace a příponu neruší
check('dotaz za adresou nevadí', __test.extOf(`${CDN}/perla-2.png?v=4`), 'png');
check('velká písmena jsou totéž', __test.extOf(`${CDN}/rubin-2.JPG`), 'jpg');
check('bez přípony vyjde prázdno', __test.extOf('https://quentino.cz/obrazek'), '');

/* ---------- stav podle feedu ---------- */

check('všechny WebP je hotovo', __test.webpState(['a.webp', 'b.webp']), 'webp');
check('žádný WebP je práce', __test.webpState(['a.jpg', 'b.png']), 'none');
// Půlka převedená je pořád práce — na e-shopu se ukazují obě
check('půlka je rozdělaná práce', __test.webpState(['a.webp', 'b.jpg']), 'mixed');
// Produkt bez fotek není hotový ani nehotový; nemá se co převádět
check('bez obrázků je prázdno', __test.webpState([]), 'empty');

/* ---------- seznam a filtry ---------- */

console.log('\nseznam v konvertoru:');
{
  const vse = shop.mediaProducts({ only: 'all' });
  check('produkt bez fotek se v seznamu neukazuje',
    vse.items.map(one => one.code), ['QK-001', 'QK-002', 'QK-003']);

  const chybi = shop.mediaProducts({ only: 'todo' });
  check('„chybí WebP" vybere rozdělané i nezačaté',
    chybi.items.map(one => one.code).sort(), ['QK-002', 'QK-003']);
  check('a spočítá se, kolik jich je', chybi.total, 2);

  const hotove = shop.mediaProducts({ only: 'done' });
  check('„hotové" vybere jen převedené', hotove.items.map(one => one.code), ['QK-001']);

  const jeden = shop.mediaProducts({ only: 'all', query: 'rubin' });
  check('hledání bere i bez diakritiky', jeden.items.map(one => one.code), ['QK-002']);

  const detail = vse.items.find(one => one.code === 'QK-003');
  check('u rozdělaného se pozná, kolik zbývá', [detail.webp, detail.images.length, detail.state],
    [1, 2, 'mixed']);
  check('a ID produktu se nese s sebou', detail.productId, '1353');
}

/* ---------- paměť na den ---------- */

console.log('\npaměť na den:');
{
  shop.markConverted('QK-002');
  const chybi = shop.mediaProducts({ only: 'todo' }).items.map(one => one.code);
  ok('čerstvě nahraný produkt z „chybí" zmizí', !chybi.includes('QK-002'), chybi.join(', '));

  const vse = shop.mediaProducts({ only: 'all' });
  const rubin = vse.items.find(one => one.code === 'QK-002');
  ok('ale v seznamu zůstane označený', !!rubin.convertedAt, JSON.stringify(rubin));
  /*
   * Feed o něm pořád tvrdí, že WebP nemá — a tak to i zůstane. Přepsat stav
   * podle naší poznámky by znamenalo, že neúspěšné nahrání nikdo nikdy
   * nenajde.
   */
  check('stav z feedu se nepřepisuje', rubin.state, 'none');

  const den = 24 * 3600 * 1000;
  shop.markConverted('QK-002', new Date(Date.now() - den - 60_000).toISOString());
  const potom = shop.mediaProducts({ only: 'todo' }).items.map(one => one.code);
  ok('po dni rozhoduje zase feed', potom.includes('QK-002'), potom.join(', '));

  const stats = shop.mediaProductStats();
  check('souhrn počítá i produkty bez fotek', [stats.total, stats.webp, stats.todo, stats.empty],
    [4, 1, 2, 1]);
}

/* ---------- administrace ---------- */

console.log('\nadministrace:');
{
  db.prepare('INSERT OR REPLACE INTO settings(key, value) VALUES(?,?)')
    .run('invoiceAdminHome', 'https://quentino.admin.s19.upgates.com/manager/');
  check('adresa produktu se složí z naučené administrace',
    __test.productAdminUrl('1351'),
    'https://quentino.admin.s19.upgates.com/manager/products/main/default/1351/');

  /*
   * Pořadí vodítek. Nejdřív políčko uvnitř sekce s obrázky, teprve pak
   * cokoli, co bere obrázky — na stránce produktu jsou i přílohy ke stažení
   * a ty mají svoje políčko taky.
   */
  const hints = __test.IMAGE_INPUT_HINTS;
  ok('nejužší vodítko míří do sekce s obrázky', hints[0].includes('sortable-images'), hints[0]);
  ok('poslední vodítko je nejširší', hints[hints.length - 1] === 'input.dz-hidden-input');
  ok('a vodítek je víc než jedno', hints.length >= 3);

  check('název souboru se z adresy zachová',
    __test.nameFromUrl(`${CDN}/kravata-onyx-detail.jpg`, 0), 'kravata-onyx-detail.jpg');
  // Adresa bez použitelného názvu nesmí skončit souborem beze jména
  check('bez názvu se doplní pořadí', __test.nameFromUrl('https://quentino.cz/obrazek', 2), 'fotka-3.jpg');
}

/* ---------- vodítka v okně ---------- */

console.log('\nhledání políčka na stránce:');
{
  const form = require(path.join(DIST, 'formfile.js'));
  const script = form.__test.markScript(['#sortable-images input[type=file]', 'input.dz-hidden-input']);
  ok('skript dostane vodítka v daném pořadí',
    script.indexOf('sortable-images') < script.indexOf('dz-hidden-input'));
  /*
   * Skryté políčko se u Dropzonu přeskočit nesmí — schovává si ho schválně,
   * takže „to viditelné" by na stránce produktu nenašlo nic.
   */
  ok('a vodítko má přednost před viditelností',
    script.indexOf('hints[i]') < script.indexOf('filter(usable)'));
  check('jediné vodítko se bere taky', form.__test.markScript('#a').includes('"#a"'), true);
  ok('bez vodítka se hledá podle pořadí', form.__test.markScript('').includes('var hints = []'));
}

console.log(failed === 0 ? '\nvše sedí\n' : `\n${failed} nesedí\n`);
process.exit(failed === 0 ? 0 : 1);
