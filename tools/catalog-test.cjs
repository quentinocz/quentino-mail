/**
 * Zkouška katalogu, naskladnění a štítků — bez Electronu.
 *
 * Tři věci, na kterých to celé stojí a které se špatně kontrolují okem:
 *
 *  1. **Zásoba varianty se nesmí připsat produktu.** V malém feedu je uvnitř
 *     `<VARIANTS>` taky `<STOCK>`; kdo ho vyzobne prvním hledáním, přepíše
 *     zásobu celého produktu číslem první varianty.
 *  2. **Čtečka smí najít přesně jednu věc, nebo nic.** „Asi to bude tenhle"
 *     znamená naskladnit cizí zboží.
 *  3. **Slučování naskladnění nesmí počty nafukovat.** Kdyby se sčítalo, každá
 *     další synchronizace by přidala další kusy.
 */
const path = require('path');
const { db, DIST } = require('./ptrans/harness.cjs');

// Katalogové tabulky žijí v db.ts, který je v harness podstrčený — schéma se
// proto vytvoří tady, ve stejné podobě, v jaké ho zakládá aplikace
db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    code TEXT PRIMARY KEY,
    title_cz TEXT NOT NULL DEFAULT '', url_cz TEXT NOT NULL DEFAULT '', price_cz TEXT NOT NULL DEFAULT '',
    title_sk TEXT NOT NULL DEFAULT '', url_sk TEXT NOT NULL DEFAULT '', price_sk TEXT NOT NULL DEFAULT '',
    title_en TEXT NOT NULL DEFAULT '', url_en TEXT NOT NULL DEFAULT '', price_en TEXT NOT NULL DEFAULT '',
    image TEXT, category TEXT NOT NULL DEFAULT '', categories TEXT NOT NULL DEFAULT '',
    manufacturer TEXT NOT NULL DEFAULT '', availability TEXT NOT NULL DEFAULT '',
    stock INTEGER, price_num REAL,
    ean TEXT NOT NULL DEFAULT '', product_id TEXT NOT NULL DEFAULT '', stock_at TEXT NOT NULL DEFAULT '',
    search TEXT NOT NULL DEFAULT '');
  CREATE TABLE IF NOT EXISTS product_variants (
    code TEXT PRIMARY KEY, product_code TEXT NOT NULL, variant_id TEXT NOT NULL DEFAULT '',
    label TEXT NOT NULL DEFAULT '', ean TEXT NOT NULL DEFAULT '', availability TEXT NOT NULL DEFAULT '',
    stock INTEGER, price TEXT NOT NULL DEFAULT '', main INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS stockin (
    id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
    device TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '', sent_at TEXT NOT NULL DEFAULT '');
  CREATE TABLE IF NOT EXISTS stockin_items (
    session_id TEXT NOT NULL, code TEXT NOT NULL, product_code TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '', label TEXT NOT NULL DEFAULT '', qty INTEGER NOT NULL DEFAULT 0,
    stock_before INTEGER, added_at TEXT NOT NULL DEFAULT '', PRIMARY KEY (session_id, code));
`);

const products = require(path.join(DIST, 'products.js'));
const stockin = require(path.join(DIST, 'stockin.js'));
const labels = require(path.join(DIST, 'labels.js'));

let failed = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${label}`);
  if (!ok) {
    console.log('      čekáno:', JSON.stringify(want));
    console.log('      dostal:', JSON.stringify(got));
  }
}

/* ---------- podklad: dva produkty, jeden s variantami ---------- */

const BIG_FEED = `<?xml version="1.0" encoding="utf-8"?>
<PRODUCTS>
  <PRODUCT>
    <PRODUCT_ID>101</PRODUCT_ID>
    <CODE>PS120SM</CODE>
    <EAN>8594001234567</EAN>
    <ACTIVE_YN>1</ACTIVE_YN>
    <STOCK>7</STOCK>
    <AVAILABILITY>Skladem</AVAILABILITY>
    <DESCRIPTION language="cz"><TITLE>Kšandy Slim</TITLE><URL>https://www.quentino.cz/p/ps120sm</URL></DESCRIPTION>
    <IMAGES><IMAGE><URL>https://img/1.jpg</URL><MAIN_YN>1</MAIN_YN></IMAGE></IMAGES>
    <VARIANTS>
      <VARIANT>
        <VARIANT_ID>9001</VARIANT_ID>
        <CODE>PS120SM-110</CODE>
        <STOCK>2</STOCK>
        <AVAILABILITY>Skladem</AVAILABILITY>
        <PARAMETERS><PARAMETER><NAME>Délka</NAME><VALUE>110cm</VALUE></PARAMETER></PARAMETERS>
      </VARIANT>
      <VARIANT>
        <VARIANT_ID>9002</VARIANT_ID>
        <CODE>PS120SM-120</CODE>
        <STOCK>5</STOCK>
        <AVAILABILITY>Skladem</AVAILABILITY>
        <PARAMETERS><PARAMETER><NAME>Délka</NAME><VALUE>120cm</VALUE></PARAMETER></PARAMETERS>
      </VARIANT>
    </VARIANTS>
  </PRODUCT>
  <PRODUCT>
    <PRODUCT_ID>102</PRODUCT_ID>
    <CODE>REGJ01</CODE>
    <ACTIVE_YN>1</ACTIVE_YN>
    <STOCK>3</STOCK>
    <DESCRIPTION language="cz"><TITLE>Kravata Regent</TITLE><URL>https://www.quentino.cz/p/regj01</URL></DESCRIPTION>
  </PRODUCT>
</PRODUCTS>`;

console.log('\nnačtení velkého feedu:\n');
products.importFeedXml(BIG_FEED);

const detail = products.productDetail('PS120SM');
check('produkt se načetl i s vnitřním číslem', detail && detail.code, 'PS120SM');
check('varianty se rozpoznaly', detail.variants.length, 2);
check('popisek varianty je z parametru', detail.variants[1].label, 'Délka: 120cm');
check('zásoba produktu není zásoba první varianty', detail.stock, 7);

/*
 * Katalog stažený starší verzí se musí stáhnout znovu.
 *
 * Tohle je ta past, která se v aplikaci projevila jako „varianty se
 * nedetekují": tabulka variant vznikla prázdná, katalog v databázi už byl
 * a nic ho nepřimělo stáhnout se znovu — takže varianty zůstaly nikde.
 * Číslo podoby katalogu je jediná pojistka a musí se s každou takovou
 * změnou zvednout.
 */
console.log('\nkatalog z minulé verze:\n');
const nowSchema = db
  .prepare("SELECT value FROM settings WHERE key = 'productFeedSchema'").get();
check('import si poznamenal podobu katalogu', !!nowSchema, true);
db.prepare("UPDATE settings SET value = '2' WHERE key = 'productFeedSchema'").run();
check('starší podoba se pozná jako zastaralá', products.feedIsStale(), true);
db.prepare("UPDATE settings SET value = ? WHERE key = 'productFeedSchema'").run(nowSchema.value);
check('a čerstvá už ne', products.feedIsStale(), false);

/* ---------- rychlý feed: jen zásoby ---------- */

const SMALL_FEED = `<PRODUCTS>
  <PRODUCT>
    <CODE>PS120SM</CODE>
    <STOCK>4</STOCK>
    <AVAILABILITY>Skladem</AVAILABILITY>
    <VARIANTS>
      <VARIANT><CODE>PS120SM-110</CODE><STOCK>0</STOCK><AVAILABILITY>Vyprodáno</AVAILABILITY></VARIANT>
      <VARIANT><CODE>PS120SM-120</CODE><STOCK>4</STOCK><AVAILABILITY>Skladem</AVAILABILITY></VARIANT>
    </VARIANTS>
  </PRODUCT>
</PRODUCTS>`;

console.log('\nrychlý feed se zásobami:\n');
products.applyStockXml(SMALL_FEED);
const after = products.productDetail('PS120SM');
// Tohle je ta past: bez oddělení VARIANTS by tu bylo 0 — zásoba první varianty
check('zásoba produktu se vzala z hlavičky, ne z varianty', after.stock, 4);
check('varianta má svou vlastní nulu', after.variants[0].stock, 0);
check('druhá varianta má své číslo', after.variants[1].stock, 4);
check('kdy zásoba dorazila, se pamatuje', typeof products.stockSyncedAt(), 'string');

/* ---------- čtečka ---------- */

console.log('\nco čtečka najde:\n');
check('kód varianty', products.findByCode('PS120SM-120').code, 'PS120SM-120');
check('kód produktu', products.findByCode('REGJ01').code, 'REGJ01');
check('EAN produktu', products.findByCode('8594001234567').code, 'PS120SM');
check('vlastní QR „quentino:"', products.findByCode('quentino:PS120SM-110').code, 'PS120SM-110');
check('adresa produktu z QR', products.findByCode('https://www.quentino.cz/p/regj01').code, 'REGJ01');
check('malá písmena projdou', products.findByCode('ps120sm-110').code, 'PS120SM-110');
// Kdyby se hledalo „obsahuje", tohle by našlo PS120SM-110 i -120 a jedno by vybralo
check('kus kódu nenajde nic', products.findByCode('PS120'), null);
check('prázdný vstup nenajde nic', products.findByCode('   '), null);

/*
 * Skutečný případ z katalogu: jediný vyplněný EAN v e-shopu obsahuje kód
 * *jiného* produktu. Kdyby se hledalo v kódu a EANu naráz, načtení REGJ01 by
 * naskladnilo PS120SM. Kód proto vyhrává.
 */
db.prepare("UPDATE products SET ean = 'REGJ01' WHERE code = 'PS120SM'").run();
check('kód vyhrává nad cizím EANem', products.findByCode('REGJ01').code, 'REGJ01');
db.prepare("UPDATE products SET ean = '8594001234567' WHERE code = 'PS120SM'").run();

// Dvojí EAN se nesmí rozhodnout hádáním — radši nic
db.prepare("UPDATE products SET ean = '8594001234567' WHERE code = 'REGJ01'").run();
check('dvojznačný EAN nenajde nic', products.findByCode('8594001234567'), null);
db.prepare("UPDATE products SET ean = '' WHERE code = 'REGJ01'").run();
check('a po nápravě zase najde', products.findByCode('8594001234567').code, 'PS120SM');
check('u varianty se vrací i její popisek', products.findByCode('PS120SM-110').label, 'Délka: 110cm');

/* ---------- napovídání podle názvu ---------- */

console.log('\nhledání podle názvu:\n');
const byName = products.suggestForStockin('kšandy');
check('název najde produkt', byName.length, 1);
check('a nese s sebou varianty', byName[0].variants.length, 2);
check('jedno písmeno se nehledá', products.suggestForStockin('k').length, 0);
check('kód funguje taky', products.suggestForStockin('REGJ01')[0].code, 'REGJ01');
// Diakritika: u regálu nikdo nepřepíná klávesnici kvůli jednomu slovu
check('hledá se i bez háčků a čárek', products.suggestForStockin('ksandy')[0].code, 'PS120SM');
check('a naopak s nimi taky', products.suggestForStockin('kravata')[0].code, 'REGJ01');
check('víc slov musí sedět všechna', products.suggestForStockin('kšandy kravata').length, 0);

/*
 * Kód varianty. Na štítku i na faktuře je kód délky (`PS120SM-120`), kdežto
 * v katalogu se produkt vede pod seskupujícím kódem (`PS120SM`) — bez toho,
 * aby se hledalo i mezi variantami, nenajde kód ze štítku nic, i když
 * produkt v katalogu je.
 */
console.log('\nhledání kódu varianty:\n');
const one = (q) => products.listProducts({ query: q }).items.map(i => i.code);
check('kód varianty najde produkt', one('PS120SM-120'), ['PS120SM']);
check('malými písmeny taky', one('ps120sm-120'), ['PS120SM']);
// Pomlčku nikdo netrefí pokaždé na stejné místo
check('a bez pomlčky', one('ps120sm120'), ['PS120SM']);
check('kód s mezerou místo pomlčky', one('ps120sm 120'), ['PS120SM']);
check('název bez diakritiky najde produkt', one('ksandy'), ['PS120SM']);
check('název s diakritikou taky', one('Kšandy'), ['PS120SM']);
check('cizí kód nenajde nic', one('XX999'), []);
check('EAN najde produkt', one('8594001234567'), ['PS120SM']);
check('našeptávač hledá stejně jako katalog',
  products.suggestForStockin('ps120sm120')[0]?.code, 'PS120SM');

// Varianty i se zásobou jdou rovnou s kartou, ať se kvůli nim neotvírá okno
const card = products.listProducts({ query: 'PS120SM' }).items[0];
check('karta nese varianty i se zásobou', card.variants.map(v => [v.code, v.stock]),
  [['PS120SM-110', 0], ['PS120SM-120', 4]]);
check('produkt bez variant je nemá',
  products.listProducts({ query: 'REGJ01' }).items[0].variants, undefined);

/*
 * Štítky na jednu variantu. Dotiskuje se často jen jedna délka a tisknout
 * kvůli ní celou řadu je zbytečně spotřebovaný arch.
 */
console.log('\nštítky na jednu variantu:\n');
check('kód varianty dá jeden štítek',
  labels.labelItems(['PS120SM-120'], 1).map(i => [i.code, i.count]), [['PS120SM-120', 1]]);
check('a nese název produktu i délku',
  labels.labelItems(['PS120SM-120'], 1).map(i => [i.title, i.label]), [['Kšandy Slim', 'Délka: 120cm']]);
check('kód produktu se rozepíše na všechny',
  labels.labelItems(['PS120SM'], 1).map(i => i.code), ['PS120SM-110', 'PS120SM-120']);
// Zásoba je ta z rychlého feedu výš, ne ta z prvního načtení katalogu
check('počet podle skladu bere zásobu varianty',
  labels.labelItems(['PS120SM-120'], 1, true).map(i => i.count), [4]);
// Produkt i jeho varianta ve výběru najednou: štítek jen jednou
check('varianta se nezdvojí',
  labels.labelItems(['PS120SM', 'PS120SM-120'], 1).map(i => i.code),
  ['PS120SM-110', 'PS120SM-120']);

/* ---------- naskladnění ---------- */

console.log('\nnaskladnění:\n');
const session = stockin.createSession('Zkouška');
stockin.addScan(session.id, 'PS120SM-120', 1);
stockin.addScan(session.id, 'PS120SM-120', 2);
check('druhé pípnutí přičte, nezaloží nový řádek', stockin.itemsOf(session.id).length, 1);
check('počty se sčítají', stockin.itemsOf(session.id)[0].qty, 3);
check('neznámý kód se nepřidá', stockin.addScan(session.id, 'NENI-TAKOVY').added, false);
check('a nezanechá po sobě řádek', stockin.itemsOf(session.id).length, 1);

const plan = stockin.planOf(session.id);
check('do plánu se doplnilo vnitřní číslo produktu', plan[0].productId, '101');
check('i vnitřní číslo varianty', plan[0].variantId, '9002');
check('a zásoba, ke které se přičítá', plan[0].stockNow, 4);

stockin.setQty(session.id, 'PS120SM-120', 0);
check('nula řádek smaže', stockin.itemsOf(session.id).length, 0);

/* ---------- slučování mezi zařízeními ---------- */

console.log('\nslučování z telefonu:\n');
stockin.addScan(session.id, 'REGJ01', 2);
const older = '2020-01-01T00:00:00.000Z';
const remote = {
  sessions: [{
    id: session.id, title: 'Zkouška', note: '', device: 'iPhone', state: 'open',
    created_at: older, updated_at: older, sent_at: ''
  }],
  items: [
    { session_id: session.id, code: 'REGJ01', title: 'Kravata Regent', qty: 9, added_at: '' },
    { session_id: session.id, code: 'PS120SM-110', title: 'Kšandy Slim', label: 'Délka: 110cm', qty: 5, added_at: '' }
  ]
};

/*
 * Starší verze se nevnucuje.
 *
 * Tohle je ta chyba, kvůli které se opravený počet vracel na původní:
 * slučovalo se po řádcích a bralo se vyšší číslo, takže soubor z minulého
 * kola vždycky přebil čerstvou opravu — i na jediném zařízení, které si tak
 * přepisovalo vlastní práci.
 */
stockin.mergeStockin(remote);
check('starší verze počet nepřebije', stockin.itemsOf(session.id).find(one => one.code === 'REGJ01').qty, 2);
check('a nepřidá ani své řádky', stockin.itemsOf(session.id).length, 1);

// Novější strana přebírá seznam celý — jinak by nešlo řádek smazat
const newer = { ...remote, sessions: [{ ...remote.sessions[0], updated_at: new Date(Date.now() + 60_000).toISOString() }] };
stockin.mergeStockin(newer);
const merged = stockin.itemsOf(session.id);
check('novější verze počet přepíše', merged.find(one => one.code === 'REGJ01').qty, 9);
check('a přinese svoje řádky', merged.length, 2);

// Když novější strana řádek nemá, znamená to, že ho někdo smazal
const withoutLine = {
  sessions: [{ ...remote.sessions[0], updated_at: new Date(Date.now() + 120_000).toISOString() }],
  items: [{ session_id: session.id, code: 'REGJ01', title: 'Kravata Regent', qty: 9, added_at: '' }]
};
stockin.mergeStockin(withoutLine);
check('smazaný řádek se nevrátí', stockin.itemsOf(session.id).length, 1);

stockin.markSent(session.id);
stockin.mergeStockin(withoutLine);
check('odeslané naskladnění se nevrátí mezi rozpracované', stockin.sessionOf(session.id).state, 'sent');

/*
 * Smazané se nesmí vrátit.
 *
 * Přesně tohle se dělo v provozu: naskladnění smazané na telefonu se do
 * minuty objevilo zpátky, protože druhé zařízení ho poslalo ve sdíleném
 * souboru znovu. Řádek se proto nemaže, jen se označí za smazaný — a takový
 * putuje dál, aby se o tom dozvěděla i druhá strana.
 */
console.log('\nsmazání:\n');
const doomed = stockin.createSession('Ke smazání');
stockin.addScan(doomed.id, 'REGJ01', 1);
stockin.deleteSession(doomed.id);
check('smazané zmizí ze seznamu', stockin.listSessions().some(one => one.id === doomed.id), false);
check('a nedá se otevřít', stockin.sessionOf(doomed.id), null);

const zombie = {
  sessions: [{
    id: doomed.id, title: 'Ke smazání', note: '', device: 'MacBook', state: 'open',
    created_at: older, updated_at: new Date(Date.now() + 600_000).toISOString(), sent_at: ''
  }],
  items: [{ session_id: doomed.id, code: 'REGJ01', title: 'Kravata Regent', qty: 1, added_at: '' }]
};
stockin.mergeStockin(zombie);
check('a synchronizace ho nevzkřísí ani novějším časem',
  stockin.listSessions().some(one => one.id === doomed.id), false);
check('ani jeho řádky', stockin.itemsOf(doomed.id).length, 0);
// Druhá strana se o smazání musí dozvědět, jinak ho pošle znovu za minutu
check('náhrobek jde do sdílené složky',
  stockin.stockinExport().sessions.some(one => one.id === doomed.id && one.state === 'deleted'), true);

/* ---------- štítky ---------- */

console.log('\nštítky:\n');
const items = labels.labelItems(['PS120SM', 'REGJ01'], 2);
check('produkt s variantami dá štítek každé variantě', items.length, 3);
check('a produkt bez variant jeden', items.filter(one => one.code === 'REGJ01').length, 1);
check('počet kusů se propíše', items[0].count, 2);
check('na štítku varianty je její popisek', items[0].label, 'Délka: 110cm');

labels.labelPreview(items, labels.DEFAULT_LAYOUT).then(html => {
  const perPage = labels.DEFAULT_LAYOUT.cols * labels.DEFAULT_LAYOUT.rows;
  const cells = (html.match(/class="cell"/g) || []).length;
  check('náhled vysází jednu stránku', cells, Math.min(perPage, 6));
  check('pod QR je kód i písmem', html.includes('>PS120SM-110<'), true);
  check('QR je opravdu obrázek, ne text', html.includes('<svg'), true);

  console.log(failed ? `\n✗ ${failed} zkoušek selhalo\n` : '\n✓ katalog, naskladnění i štítky sedí\n');
  process.exit(failed ? 1 : 0);
});
