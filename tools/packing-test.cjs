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
    created_at TEXT NOT NULL DEFAULT '', PRIMARY KEY (code, market));
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

// Faktura 022605 patří k objednávce 023100 — čísla se neshodují schválně
db.prepare('INSERT INTO shop_orders (code, market, invoice, created_at) VALUES (?, ?, ?, ?)')
  .run('022605', 'cz', '999111', '2026-08-01');

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

/* ---------- 3. objednávka podle faktury ---------- */

console.log('\nObjednávka podle čísla');

check('číslo objednávky přímo', packing.findOrder('022605')?.messageId, 1);
check('bez vodicích nul', packing.findOrder('22605')?.messageId, 1);
check('faktura přes feed objednávek', packing.findOrder('999111')?.messageId, 1);
check('neznámé číslo', packing.findOrder('880123'), null);
check('krátký nesmysl', packing.findOrder('ab'), null);

/* ---------- 4. starší záznamy ---------- */

console.log('\nZáznamy z doby před počítáním kusů');

db.prepare('UPDATE packing SET packed_json = ?, counts_json = ? WHERE message_pk = ?')
  .run('[0,1]', '{}', 1);
hit = packing.scanItem(1, 'OP01HN');
check('odškrtnutá položka se dopočítá na plný počet', [hit.ok, hit.reason], [false, 'already']);

console.log(failed === 0 ? '\n✓ balení sedí' : `\n✗ ${failed} nesedí`);
process.exit(failed === 0 ? 0 : 1);
