/**
 * Zkouška psaní článků — bez volání modelu.
 *
 * Zkouší se to, co rozhoduje o **ceně a o tom, jestli článek dává smysl**,
 * a co se okem nepozná:
 *
 *  1. strop odpovědi odvozený od zadané délky — bez něj se šestisetslový
 *     článek rozmáchl na několikanásobek a druhý průchod ho zase zkracoval,
 *  2. meze, za kterými se délka opravuje,
 *  3. zásoba u produktů do článku — odkaz na vyprodaný kus posílá čtenáře
 *     na stránku, kde si nic nekoupí,
 *  4. dohledání slovenské a anglické adresy odkazu z české.
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
function ok(label, value, note = '') {
  check(label + (value || !note ? '' : ` (${note})`), !!value, true);
}

const secPath = require.resolve(path.join(DIST, 'secure.js'));
require.cache[secPath] = { id: secPath, filename: secPath, loaded: true, exports: {
  encrypt: v => v, decrypt: v => v
} };

const schema = require(path.join(DIST, 'articles/schema.js'));
db.exec(schema.SCHEMA);
for (const alter of schema.ALTERS ?? []) { try { db.exec(alter); } catch { /* už je */ } }

const generate = require(path.join(DIST, 'articles/generate.js'));
const store = require(path.join(DIST, 'articles/store.js'));
const urlmap = require(path.join(DIST, 'articles/urlmap.js'));
const { __test } = generate;

console.log('\npsaní článků:\n');

/* ---------- strop odpovědi ---------- */

/*
 * Šestnáct tisíc tokenů je místo asi na deset tisíc slov — u krátkého
 * článku tedy nedrží vůbec nic. Strop podle zadání zabrání rozmáchnutí
 * dřív, než vznikne, a ušetří druhý průchod, který to zkracuje.
 */
check('krátký článek má nižší strop', __test.tokenCeiling(600), 6900);
check('delší článek dostane víc místa', __test.tokenCeiling(1500), 15000);
ok('a nad šestnáct tisíc se nejde', __test.tokenCeiling(9000) === 16000);
// Rezerva musí být štědrá: HTML, styly a JSON-LD taky něco zaberou
ok('rezerva je násobná, ne těsná', __test.tokenCeiling(900) > 900 * 3);

/* ---------- meze délky ---------- */

check('trefená délka se nepřepisuje', __test.lengthOff(900, 900), null);
check('desetiprocentní odchylka projde', __test.lengthOff(980, 900), null);
check('polovina se dopisuje', __test.lengthOff(450, 900), 'short');
check('dvojnásobek se zkracuje', __test.lengthOff(1900, 900), 'long');
// Bez zadané délky není co vynucovat
check('bez zadání se nedělá nic', __test.lengthOff(5000, 0), null);
// V rozpisu musí být počet sekcí i slov na sekci — „napiš 900 slov" nefunguje
const plan = __test.lengthPlan(900);
ok('rozpis říká, kolik má být sekcí', /\d+ sekcí/.test(plan), plan);
ok('a kolik slov na jednu', /po zhruba \d+ slovech/.test(plan), plan);

/* ---------- produkty a zásoba ---------- */

db.exec(`CREATE TABLE IF NOT EXISTS ptrans_products (
  code TEXT PRIMARY KEY, product_id TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1,
  archived INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL DEFAULT '', image TEXT,
  category TEXT NOT NULL DEFAULT '', categories TEXT NOT NULL DEFAULT '',
  manufacturer TEXT NOT NULL DEFAULT '', availability TEXT NOT NULL DEFAULT '',
  stock INTEGER, price TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '',
  raw_xml TEXT NOT NULL DEFAULT '', source_hash TEXT NOT NULL DEFAULT '',
  seen_at TEXT NOT NULL DEFAULT '', origin TEXT NOT NULL DEFAULT 'feed',
  added_at TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS ptrans_fields (
  code TEXT NOT NULL, lang TEXT NOT NULL, field TEXT NOT NULL,
  value TEXT NOT NULL DEFAULT '', translated TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'todo', PRIMARY KEY (code, lang, field));`);

const addProduct = (code, title, stock, availability, url) => db.prepare(
  `INSERT OR REPLACE INTO ptrans_products (code, title, stock, availability, url, category)
   VALUES (?,?,?,?,?,'Kravaty')`
).run(code, title, stock, availability, url);

addProduct('KR01', 'Vínová kravata', 12, 'Skladem', 'vinova-kravata');
addProduct('KR02', 'Modrý motýlek', 0, 'Není skladem', 'modry-motylek');
addProduct('KR03', 'Šedé kšandy', null, 'Na dotaz', 'sede-ksandy');

console.log('\nprodukty do článku:');
{
  const list = generate.productsForArticle(['KR01', 'KR02', 'KR03'], 'cz');
  const by = code => list.find(one => one.code === code);
  /*
   * Zásoba jde až do rozhraní. Článek se píše na týdny dopředu a odkaz na
   * vyprodaný kus posílá čtenáře na stránku, kde si nic nekoupí — musí se
   * to poznat při výběru, ne až po vydání.
   */
  check('skladem se pozná podle počtu kusů', by('KR01').stock, 12);
  check('vyprodané je nula, ne prázdno', by('KR02').stock, 0);
  // Feed zásobu uvádět nemusí; nula by v tom případě lhala
  check('neznámá zásoba zůstane neznámá', by('KR03').stock, null);
  check('a je u ní aspoň dostupnost slovy', by('KR03').availability, 'Na dotaz');
  ok('odkaz se skládá z domény a slugu', by('KR01').url.endsWith('/p/vinova-kravata'), by('KR01').url);
}

/* ---------- videa ---------- */

console.log('\nvidea v článku:');
{
  /*
   * Lidé kopírují, co mají zrovna v adresním řádku. Do vloženého okna ale
   * patří jen identifikátor videa — ať přišel odkud chtěl.
   */
  const tvary = [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ?t=42',
    'https://www.youtube.com/shorts/dQw4w9WgXcQ',
    'https://www.youtube.com/embed/dQw4w9WgXcQ',
    'https://www.youtube.com/watch?list=PL123&v=dQw4w9WgXcQ&feature=share'
  ];
  check('identifikátor se pozná ze všech tvarů odkazu',
    tvary.map(__test.youtubeId), tvary.map(() => 'dQw4w9WgXcQ'));
  check('adresa souboru identifikátor nemá', __test.youtubeId('https://cdn.example.com/a.webm'), '');

  const yt = __test.videoEmbed({ url: tvary[0], description: 'Jak uvázat motýlka', size: 'medium' });
  /*
   * Poměr stran musí být ve vloženém okně napevno. Bez něj se `iframe` na
   * telefonu roztáhne přes celou stránku a rozbije rozvržení — a to je
   * chyba, kterou je vidět až na mobilu po vydání.
   */
  ok('vložené okno drží poměr stran', yt.includes('padding-top:56.25%'), yt.slice(0, 120));
  ok('a nepadají cookies dřív, než se pustí', yt.includes('youtube-nocookie.com/embed/dQw4w9WgXcQ'));
  ok('popisek se dostane pod video', yt.includes('Jak uvázat motýlka'));
  ok('a jde pustit na celou obrazovku', yt.includes('allowfullscreen'));

  const file = __test.videoEmbed({ url: 'https://cdn.example.com/a.webm', size: 'large' });
  // Bez `controls` se video nedá pustit; `playsinline` ho na iPhonu nehodí přes celou obrazovku
  ok('soubor se vloží jako přehrávač', file.includes('<video controls'), file.slice(0, 120));
  ok('a na telefonu nepřepne na celou obrazovku', file.includes('playsinline'));
  check('prázdná adresa nevyrobí nic', __test.videoEmbed({ url: '  ' }), '');

  // Do zadání jde hotový kód, ne popis — u videa by ho model pokaždé napsal jinak
  const blok = __test.videoBlock({ videos: [{ url: tvary[1], description: '', size: 'small', layout: 'left' }] });
  ok('zadání nese hotový kód', blok.includes('<iframe'), blok.slice(0, 80));
  ok('a říká, že se nesmí měnit', blok.includes('DOSLOVA'));
  check('bez videí se do zadání nic nepřidá', __test.videoBlock({ videos: [] }), '');
}

/* ---------- dohledání adres odkazu ---------- */

console.log('\nodkazy na ostatních trzích:');
{
  const index = require(path.join(DIST, 'articles/index.js'));
  // Dvojice adres se aplikace učí z už přeložených článků
  urlmap.rememberPair('cz', '/kravaty', 'sk', '/kravaty-sk', 'category');
  const found = index.linkUrls('https://www.quentino.cz/kravaty', 'cz');

  check('slovenská adresa se vezme z mapy', found.sk.url, 'https://www.quentino.sk/kravaty-sk');
  check('a je vidět, že je z dat', found.sk.via, 'map');
  /*
   * Anglická v mapě není. Vrátí se odhad s vyměněnou doménou, ale **musí
   * být poznat**, že je to odhad — jinak by se do článku dostal odkaz na
   * stránku, která na tom trhu neexistuje.
   */
  check('neznámá se jen odhadne', found.en.url, 'https://www.wearquentino.com/kravaty');
  check('a označí jako odhad', found.en.via, 'domain');
  check('zdrojový jazyk zůstává sám sebou', found.cz.url, 'https://www.quentino.cz/kravaty');
  // Prázdný vstup nesmí nic vymýšlet
  check('z prázdné adresy nic nevznikne', Object.keys(index.linkUrls('')).length, 0);
}

/* ---------- adresa importu ---------- */

console.log('\nimport zpátky do e-shopu:');
{
  const index = require(path.join(DIST, 'articles/index.js'));
  /*
   * V adrese je číslo serveru, na kterém e-shop běží — napevno ji zapsat
   * nejde. Skládá se z administrace, kterou aplikace zná kvůli fakturám.
   */
  db.prepare(
    'INSERT INTO settings(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run('invoiceAdminHome', 'https://quentino.admin.s19.upgates.com/manager/');
  check('adresa importu se složí z administrace', index.articleImportUrl(),
    'https://quentino.admin.s19.upgates.com/setup/export-import/default/guide/texts/');
  // Vlastní adresa z nastavení má přednost — servery se stěhují
  store.saveArticleSettings({ importUrl: 'https://jiny.example.com/import/' });
  check('vlastní adresa vyhraje', index.articleImportUrl(), 'https://jiny.example.com/import/');
  store.saveArticleSettings({ importUrl: '' });
}

console.log(failed === 0 ? '\nvše sedí\n' : `\n${failed} nesedí\n`);
process.exit(failed === 0 ? 0 : 1);
