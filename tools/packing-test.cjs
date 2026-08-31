/**
 * Zkouška balení objednávek — bez Electronu.
 *
 * Tři věci, na kterých balení stojí a které se špatně kontrolují okem:
 *
 *  1. **Počítá se po kusech, ne po položkách.** U „3 ks" musí být z čeho
 *     poznat, kolik jich už je v krabici; odškrtnutá položka je až ta,
 *     u které jsou v krabici všechny.
 *  2. **Načtený kód musí trefit správný řádek.** Na štítku bývá kód varianty,
 *     v objednávce kód produktu — a jsou objednávky, kde je táž položka
 *     dvakrát. „Asi ten první" znamená poslat zákazníkovi míň kusů.
 *  3. **Číslo z faktury není číslo objednávky.** QR na faktuře nese fakturu;
 *     objednávka se k ní musí dohledat přes feed.
 */
const path = require('path');
const { db, DIST } = require('./ptrans/harness.cjs');

db.exec(`
  CREATE TABLE IF NOT EXISTS packing (
    message_pk INTEGER PRIMARY KEY,
    packed_json TEXT NOT NULL DEFAULT '[]',
    counts_json TEXT NOT NULL DEFAULT '{}',
    done INTEGER NOT NULL DEFAULT 0,
    done_at TEXT);
  CREATE TABLE IF NOT EXISTS order_cache (
    message_pk INTEGER PRIMARY KEY, json TEXT, at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS shop_orders (
    code TEXT NOT NULL, market TEXT NOT NULL DEFAULT 'cz', invoice TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT '', paid_date TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '',
    currency TEXT NOT NULL DEFAULT '', total REAL NOT NULL DEFAULT 0,
    tracking TEXT NOT NULL DEFAULT '', name TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '',
    shipment TEXT NOT NULL DEFAULT '', payment TEXT NOT NULL DEFAULT '',
    items_json TEXT NOT NULL DEFAULT '[]', PRIMARY KEY (code, market));
  CREATE TABLE IF NOT EXISTS packing_shop (
    id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL, market TEXT NOT NULL DEFAULT '',
    packed_json TEXT NOT NULL DEFAULT '[]', counts_json TEXT NOT NULL DEFAULT '{}',
    done INTEGER NOT NULL DEFAULT 0, done_at TEXT, UNIQUE (code, market));
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY, date TEXT NOT NULL DEFAULT '',
    subject TEXT NOT NULL DEFAULT '', from_addr TEXT NOT NULL DEFAULT '');
  CREATE TABLE IF NOT EXISTS products (
    code TEXT PRIMARY KEY,
    title_cz TEXT NOT NULL DEFAULT '', url_cz TEXT NOT NULL DEFAULT '', price_cz TEXT NOT NULL DEFAULT '',
    title_sk TEXT NOT NULL DEFAULT '', url_sk TEXT NOT NULL DEFAULT '', price_sk TEXT NOT NULL DEFAULT '',
    title_en TEXT NOT NULL DEFAULT '', url_en TEXT NOT NULL DEFAULT '', price_en TEXT NOT NULL DEFAULT '',
    image TEXT, category TEXT NOT NULL DEFAULT '', categories TEXT NOT NULL DEFAULT '',
    manufacturer TEXT NOT NULL DEFAULT '', availability TEXT NOT NULL DEFAULT '',
    stock INTEGER, price_num REAL,
    ean TEXT NOT NULL DEFAULT '', product_id TEXT NOT NULL DEFAULT '', stock_at TEXT NOT NULL DEFAULT '');
  CREATE TABLE IF NOT EXISTS product_variants (
    code TEXT PRIMARY KEY, product_code TEXT NOT NULL, variant_id TEXT NOT NULL DEFAULT '',
    label TEXT NOT NULL DEFAULT '', ean TEXT NOT NULL DEFAULT '', availability TEXT NOT NULL DEFAULT '',
    stock INTEGER, price TEXT NOT NULL DEFAULT '', main INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0);
`);

const packing = require(path.join(DIST, 'packing.js'));

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

/* ---------- podklad ---------- */

function item(code, title, qty, variants = []) {
  return {
    qty, unit: 'ks', title, code, url: null, price: '', availability: null,
    variants, image: null, feedUrl: null, feedPrice: null, matched: true
  };
}

// Objednávka 022605: jedny kšandy (3 ks) a jeden pásek
const CARD = {
  orderNumber: '022605', lang: 'cz', placedAt: null, customerEmail: null, customerPhone: null,
  billing: null, shipping: null,
  items: [
    item('PS120CRV', 'Červené pánské kšandy', 3),
    item('OP01HN', 'Pásek hnědý', 1)
  ],
  shipmentName: null, shipmentPrice: null, paymentName: null, paymentPrice: null,
  total: null, historyUrl: null, adminUrl: null, adminSource: null, live: null, tracking: null
};

// Druhá objednávka: táž položka dvakrát na dvou řádcích
const SPLIT = {
  ...CARD, orderNumber: '022700',
  items: [item('PS120CRV', 'Červené pánské kšandy', 1), item('PS120CRV', 'Červené pánské kšandy', 2)]
};

db.prepare('INSERT INTO order_cache (message_pk, json, at) VALUES (?, ?, ?)')
  .run(1, JSON.stringify(CARD), new Date().toISOString());
db.prepare('INSERT INTO order_cache (message_pk, json, at) VALUES (?, ?, ?)')
  .run(2, JSON.stringify(SPLIT), new Date().toISOString());
// Půl roku stará objednávka — do okna k balení nespadá, načtená faktura ji najít musí
db.prepare('INSERT INTO order_cache (message_pk, json, at) VALUES (?, ?, ?)')
  .run(3, JSON.stringify({ ...CARD, orderNumber: '021900' }), '2026-02-10T09:00:00.000Z');

/*
 * Faktury a objednávky mají v e-shopu různá čísla — právě proto se překlad
 * dělá vždycky přes feed. 022605 je objednávka rozdělaná, 021900 je dávno
 * doručená a v seznamu k balení by se sama neobjevila.
 */
const shop = db.prepare(
  `INSERT INTO shop_orders (code, market, invoice, status, created_at, updated_at, items_json)
   VALUES (?, ?, ?, ?, ?, ?, ?)`
);
// Název ve feedu je schválně starý — přednost má ten z katalogu
const FEED_ITEMS = JSON.stringify([
  { title: 'Kšandy (starý název)', code: 'PS120CRV-110', quantity: 2, price: 479 },
  { title: 'Pásek hnědý', code: 'OP01HN', quantity: 1, price: 690 }
]);
shop.run('022605', 'cz', '999111', 'Přijata', '2026-08-20', '2026-08-21', FEED_ITEMS);
shop.run('021900', 'cz', '998700', 'Doručeno', '2026-02-10', '2026-02-14', FEED_ITEMS);
/*
 * Past, na kterou se přišlo v provozu: číslo faktury jedné objednávky je
 * zároveň číslem jiné objednávky. Faktura 020100 patří objednávce 019800,
 * ale existuje i objednávka 020100 — otevřít se musí ta z faktury.
 */
shop.run('019800', 'cz', '020100', 'Vyřizuje se', '2025-12-01', '2025-12-02', FEED_ITEMS);
shop.run('020100', 'cz', '020400', 'Vyřizuje se', '2025-12-20', '2025-12-21', FEED_ITEMS);
// Objednávka jen ve feedu, bez potvrzovacího mailu — balit se musí dát i tak
shop.run('018000', 'cz', '018100', 'Vyřizuje se', '2025-09-01', '2025-09-02', FEED_ITEMS);

// Potvrzovací maily — starší objednávka je jen tady, mimo okno k balení
const mail = db.prepare('INSERT INTO messages (id, date, subject, from_addr) VALUES (?, ?, ?, ?)');
mail.run(1, '2026-08-20T09:00:00.000Z', 'Objednávka č. 022605 přijata', 'info@quentino.cz');
mail.run(2, '2026-08-19T09:00:00.000Z', 'Objednávka č. 022700 přijata', 'info@quentino.cz');
mail.run(3, '2026-02-10T09:00:00.000Z', 'Objednávka č. 021900 přijata', 'info@quentino.cz');
// Objednávka, ke které se karta nikdy neuložila — najít se musí podle předmětu
mail.run(4, '2025-11-02T09:00:00.000Z', 'Objednávka č. 020500 přijata', 'info@quentino.cz');
mail.run(6, '2025-12-01T09:00:00.000Z', 'Objednávka č. 019800 přijata', 'info@quentino.cz');
mail.run(7, '2025-12-20T09:00:00.000Z', 'Objednávka č. 020100 přijata', 'info@quentino.cz');
mail.run(5, '2025-11-02T09:05:00.000Z', 'Sleva 020500 jen dnes', 'newsletter@jinyshop.cz');

// Doména e-shopu se bere z adresy feedu — bez ní se odesílatel neuzná
db.prepare(
  'INSERT INTO settings(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
).run('productFeedUrl', 'https://www.quentino.cz/feed.xml');

// Kšandy mají v katalogu variantu, na štítku je její kód
db.prepare('INSERT INTO products (code, title_cz, availability) VALUES (?, ?, ?)')
  .run('PS120CRV', 'Červené pánské kšandy', 'Skladem');
db.prepare('INSERT INTO product_variants (code, product_code, label) VALUES (?, ?, ?)')
  .run('PS120CRV-110', 'PS120CRV', 'Délka: 110cm');

/* ---------- 1. počítání kusů ---------- */

console.log('\nPočty kusů');

let st = packing.setItemCount(1, 0, 1);
check('jeden kus z tří: nezaškrtnuto', [st.counts['0'], st.packed], [1, []]);

st = packing.setItemCount(1, 0, 3);
check('všechny tři kusy: položka odškrtnutá', [st.counts['0'], st.packed], [3, [0]]);

st = packing.setItemCount(1, 0, 9);
check('víc kusů, než je v objednávce, se ořízne', st.counts['0'], 3);

st = packing.setItemCount(1, 0, 0);
check('nula kusy i odškrtnutí zruší', [st.counts['0'], st.packed], [undefined, []]);

st = packing.setItemPacked(1, 1, true);
check('odškrtnutí jednokusové položky', [st.counts['1'], st.packed], [1, [1]]);

/* ---------- 2. načítání kódů ---------- */

console.log('\nČtení kódů');

let hit = packing.scanItem(1, 'PS120CRV');
check('první kus ze tří', [hit.ok, hit.index, hit.count, hit.needMore], [true, 0, 1, 2]);

hit = packing.scanItem(1, 'quentino:PS120CRV-110');
check('kód varianty trefí řádek s kódem produktu', [hit.ok, hit.index, hit.count], [true, 0, 2]);

hit = packing.scanItem(1, 'https://www.quentino.cz/p/PS120CRV');
check('kód z adresy produktu', [hit.ok, hit.count, hit.needMore], [true, 3, 0]);

hit = packing.scanItem(1, 'PS120CRV');
check('čtvrtý kus se nepřipíše', [hit.ok, hit.reason], [false, 'already']);

hit = packing.scanItem(1, 'XX999');
check('cizí kód se nepřiřadí', [hit.ok, hit.reason], [false, 'notInOrder']);

// Táž položka na dvou řádcích: druhý kus musí jít na řádek, kterému chybí
packing.scanItem(2, 'PS120CRV');
hit = packing.scanItem(2, 'PS120CRV');
check('druhý kus přeskočí zaplněný řádek', [hit.ok, hit.index, hit.count], [true, 1, 1]);

/* ---------- 4. starší záznamy ---------- */

console.log('\nZáznamy z doby před počítáním kusů');

db.prepare('UPDATE packing SET packed_json = ?, counts_json = ? WHERE message_pk = ?')
  .run('[0,1]', '{}', 1);
hit = packing.scanItem(1, 'OP01HN');
check('odškrtnutá položka se dopočítá na plný počet', [hit.ok, hit.reason], [false, 'already']);

/* ---------- 3. objednávka podle faktury ---------- */

async function orders() {
  console.log('\nObjednávka podle čísla');

  const at = async (value) => (await packing.openOrder(value)).order?.messageId;
  check('číslo objednávky přímo', await at('022605'), 1);
  check('bez vodicích nul', await at('22605'), 1);
  check('faktura přes feed objednávek', await at('999111'), 1);

  const missing = await packing.openOrder('880123');
  check('neznámé číslo řekne, kam až feed sahá',
    [missing.ok, missing.reason, /feed má \d+ objednávek/.test(missing.message)],
    [false, 'notInFeed', true]);
  check('krátký nesmysl', (await packing.openOrder('ab')).reason, 'noNumber');

  // Stav z feedu jde s objednávkou, aby šlo u starší poznat, že je hotová
  const fresh = (await packing.openOrder('999111')).order;
  check('stav z feedu u rozdělané', [fresh.shop.status, fresh.shop.final], ['Přijata', false]);

  /*
   * Stará doručená objednávka: v seznamu k balení není, ale načtená faktura
   * ji musí najít — a rovnou říct, že jde o konečný stav a odkdy.
   */
  const old = (await packing.openOrder('998700')).order;
  check('stará objednávka se najde podle faktury', old?.messageId, 3);
  check('konečný stav i s datem',
    [old.shop.status, old.shop.final, old.shop.at], ['Doručeno', true, '2026-02-14']);
  check('karta se sestavila i mimo okno', old.card?.orderNumber, '021900');

  /*
   * Číslo faktury bývá číslem jiné objednávky. Otevřít se musí ta z faktury —
   * opačné pořadí by tiše balilo cizí objednávku — a o druhé se musí vědět.
   */
  const clash = await packing.openOrder('020100');
  check('faktura má přednost před stejným číslem objednávky',
    clash.order.card.orderNumber, '019800');
  check('druhá možnost se nabídne', clash.also?.orderNumber, '020100');

  console.log('\nObjednávka bez e-mailu');

  /*
   * K téhle objednávce potvrzovací mail není. Podklady se vezmou z feedu,
   * kde je u položek rovnou kód varianty — a odškrtávat se proti nim musí dát
   * stejně jako proti mailu.
   */
  const feed = (await packing.openOrder('018100')).order;
  check('objednávka jen z feedu', [feed?.source, feed?.messageId < 0], ['feed', true]);
  check('položky z feedu i s počty',
    feed.card.items.map(i => [i.code, i.qty]), [['PS120CRV-110', 2], ['OP01HN', 1]]);
  check('varianta a název se doplní z katalogu, ne z feedu',
    [feed.card.items[0].title, feed.card.items[0].variants],
    ['Červené pánské kšandy', ['Délka: 110cm']]);

  const hit = packing.scanItem(feed.messageId, 'PS120CRV-110');
  check('odškrtávání funguje i u objednávky z feedu',
    [hit.ok, hit.count, hit.needMore], [true, 1, 1]);
  const again = (await packing.openOrder('018100')).order;
  check('stav odškrtání se uloží', again.counts['0'], 1);
  check('a drží se stejné číslo', again.messageId, feed.messageId);
}

orders().then(() => {
  console.log(failed === 0 ? '\n✓ balení sedí' : `\n✗ ${failed} nesedí`);
  process.exit(failed === 0 ? 0 : 1);
});
