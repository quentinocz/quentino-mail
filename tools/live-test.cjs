/**
 * Zkouška živého propojení telefonu a počítače.
 *
 * Spojení samotné se tady vyzkoušet nedá — WebSocket na Supabase by
 * potřeboval skutečný projekt a síť. Co se vyzkoušet dá a co se taky láme,
 * je všechno kolem:
 *
 *  - **jméno kanálu**, které je zároveň heslo, takže musí být dlouhé,
 *    náhodné a bez znaků, které by se v adrese musely kódovat,
 *  - **co se stane s přijatou prací** — sloučí se týmž kódem jako ze
 *    sdílené složky a nabídne se proužkem, ne otevřením okna,
 *  - **kdy nabídka zmizí** — hotová práce se nabízet nemá,
 *  - **odškrtávání u balení**, které se posílá celé a zapisuje natvrdo.
 *
 * Poslední bod je ten, kvůli kterému zkouška existuje: kdyby se odškrtnutí
 * z telefonu na počítači ztratilo, dá se kus do krabice dvakrát a pozná se
 * to až u zákazníka.
 */
const path = require('path');
const { db, DIST } = require('./ptrans/harness.cjs');

db.exec(`
  CREATE TABLE IF NOT EXISTS stockin (
    id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
    device TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '', sent_at TEXT NOT NULL DEFAULT '');
  CREATE TABLE IF NOT EXISTS stockin_items (
    session_id TEXT NOT NULL, code TEXT NOT NULL, product_code TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '', label TEXT NOT NULL DEFAULT '', qty INTEGER NOT NULL DEFAULT 0,
    stock_before INTEGER, added_at TEXT NOT NULL DEFAULT '', PRIMARY KEY (session_id, code));
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
  CREATE TABLE IF NOT EXISTS packing (
    message_pk INTEGER PRIMARY KEY, packed_json TEXT NOT NULL DEFAULT '[]',
    counts_json TEXT NOT NULL DEFAULT '{}', done INTEGER NOT NULL DEFAULT 0, done_at TEXT);
  CREATE TABLE IF NOT EXISTS packing_shop (
    id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL, market TEXT NOT NULL DEFAULT '',
    packed_json TEXT NOT NULL DEFAULT '[]', counts_json TEXT NOT NULL DEFAULT '{}',
    done INTEGER NOT NULL DEFAULT 0, done_at TEXT, UNIQUE (code, market));
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY, date TEXT NOT NULL DEFAULT '',
    subject TEXT NOT NULL DEFAULT '', from_addr TEXT NOT NULL DEFAULT '');
  CREATE TABLE IF NOT EXISTS shop_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL, market TEXT NOT NULL DEFAULT '',
    invoice TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT '', status_at TEXT NOT NULL DEFAULT '',
    items_json TEXT NOT NULL DEFAULT '[]', address_json TEXT NOT NULL DEFAULT '',
    tracking_json TEXT NOT NULL DEFAULT '', done INTEGER NOT NULL DEFAULT 0, done_at TEXT,
    UNIQUE (code, market));
`);

const live = require(path.join(DIST, 'live.js'));
const work = require(path.join(DIST, 'livework.js'));
const stockin = require(path.join(DIST, 'stockin.js'));
const packing = require(path.join(DIST, 'packing.js'));

let failed = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${label}`);
  if (!ok) { console.log('      čekáno:', JSON.stringify(want)); console.log('      dostal:', JSON.stringify(got)); }
}
function ok(label, value) { check(label, !!value, true); }

/* ---------- jméno kanálu ---------- */

console.log('\njméno kanálu:\n');
const channel = live.newChannel();
ok('začíná poznatelně', channel.startsWith('q-'));
check('má dost znaků na to, aby se nedalo uhodnout', channel.length, 22);
ok('nemá znaky, které by se v adrese musely kódovat', encodeURIComponent(channel) === channel);
ok('dva kanály za sebou nejsou stejné', live.newChannel() !== live.newChannel());

console.log('\nkdyž spojení není:\n');
ok('odeslání se tiše vzdá, nespadne', live.publish('stockin', { sessions: [], items: [] }) === false);
check('a stav to přizná', live.status().connected, false);

/* ---------- přijaté naskladnění ---------- */

console.log('\nnaskladnění z telefonu:\n');

/** Zpráva tak, jak přijde po drátě — tvar se musí shodovat s tím, co se posílá */
function message(kind, data) {
  return { kind, from: 'telefon-1', fromName: 'iPhone Patrik', data };
}

const slice = {
  sessions: [{
    id: 'tel-abc', title: 'Kšandy z úterý', note: '', device: 'iPhone Patrik',
    state: 'open', created_at: '2026-09-01T08:00:00.000Z',
    updated_at: '2026-09-01T08:05:00.000Z', sent_at: ''
  }],
  items: [
    { session_id: 'tel-abc', code: 'PS120SM-110', product_code: 'PS120SM',
      title: 'Kšandy Slim', label: 'Délka: 110cm', qty: 6, stock_before: 2,
      added_at: '2026-09-01T08:01:00.000Z' },
    { session_id: 'tel-abc', code: 'REGJ01', product_code: 'REGJ01',
      title: 'Kravata Regent', label: '', qty: 4, stock_before: 1,
      added_at: '2026-09-01T08:02:00.000Z' }
  ]
};

/*
 * Posluchače zaregistruje `startLiveWork`, ale doručuje mu `live`, který
 * tady spojení nemá. Zpráva se proto podstrčí přímo — zkouší se, co se
 * s přijatou prací stane, ne jak doletěla.
 */
work.startLiveWork();
const deliver = live.deliver;
ok('zpráva se dá doručit i bez spojení', typeof deliver === 'function');
deliver(message('stockin', slice));

check('naskladnění se uložilo', stockin.sessionOf('tel-abc')?.title, 'Kšandy z úterý');
check('i s řádky a počty',
  stockin.itemsOf('tel-abc').map(i => [i.code, i.qty]).sort(),
  [['PS120SM-110', 6], ['REGJ01', 4]]);

console.log('\nnabídka na počítači:\n');
const offers = work.liveOffers();
check('nabízí se právě jedna věc', offers.length, 1);
check('a ví se, čeho se týká', [offers[0].kind, offers[0].id], ['stockin', 'tel-abc']);
check('v proužku je vidět, kolik toho je', offers[0].detail, '2 položek · 10 ks');
check('i odkud to přišlo', offers[0].from, 'iPhone Patrik');

// Nabídka se dá odklidit, aniž by se otevírala
check('skrytím nabídka zmizí', work.dismissOffer(offers[0].key).length, 0);

/*
 * Odeslané naskladnění se nabízet nemá — práce je hotová a proužek by jen
 * překážel. Zkouší se to poslední zprávou, ne odklizením: přesně tak to
 * dopadne v provozu, když se naskladnění zapíše z telefonu.
 */
console.log('\nhotová práce se nenabízí:\n');
deliver(message('stockin', slice));
check('rozdělaná se nabídne', work.liveOffers().length, 1);
const sent = {
  sessions: [{ ...slice.sessions[0], state: 'sent', updated_at: '2026-09-01T09:00:00.000Z', sent_at: '2026-09-01T09:00:00.000Z' }],
  items: slice.items
};
deliver(message('stockin', sent));
check('odeslaná se přestane nabízet', work.liveOffers().length, 0);

/* ---------- balení ---------- */

console.log('\nodškrtávání z telefonu:\n');
db.prepare(
  `INSERT INTO shop_orders (code, market, invoice, status, created_at, status_at, items_json)
   VALUES ('20260819', 'cz', '999111', 'Přijata', '2026-08-19T10:00:00.000Z', '', '[]')`
).run();
db.prepare("INSERT INTO packing_shop (code, market) VALUES ('20260819', 'cz')").run();

deliver(message('packing', {
  code: '20260819', market: 'cz',
  packed: '[0]', counts: '{"0":1,"1":2}', done: false, doneAt: null,
  at: '2026-09-01T10:00:00.000Z'
}));

const row = db.prepare("SELECT * FROM packing_shop WHERE code = '20260819'").get();
check('odškrtnuté kusy se zapsaly', [row.packed_json, row.counts_json], ['[0]', '{"0":1,"1":2}']);
check('a objednávka se nabídne k dobalení',
  work.liveOffers().map(o => [o.kind, o.id]), [['packing', '20260819']]);

// Zavřená krabice se nabízet nemá
deliver(message('packing', {
  code: '20260819', market: 'cz',
  packed: '[0,1]', counts: '{"0":1,"1":2}', done: true, doneAt: '2026-09-01T10:05:00.000Z',
  at: '2026-09-01T10:05:00.000Z'
}));
check('zabalená objednávka nabídku zavře', work.liveOffers().length, 0);
check('a stav zůstal zapsaný',
  db.prepare("SELECT done FROM packing_shop WHERE code = '20260819'").get().done, 1);

/*
 * Objednávka, kterou tohle zařízení ještě nezná. V provozu to nastane
 * pokaždé, když se začne balit na telefonu — počítač o ní řádek nemá.
 */
console.log('\nobjednávka, kterou počítač ještě nezná:\n');
deliver(message('packing', {
  code: '20260901', market: 'cz', packed: '[]', counts: '{"0":1}',
  done: false, doneAt: null, at: '2026-09-01T11:00:00.000Z'
}));
const fresh = db.prepare("SELECT * FROM packing_shop WHERE code = '20260901'").get();
ok('řádek se založil', !!fresh);
check('i s odškrtanými kusy', fresh?.counts_json, '{"0":1}');
work.dismissOffer('packing:20260901');

/*
 * Nabídnout se to má ve chvíli, kdy někdo řekne „dělám tohle" — ne až
 * u prvního pípnutí. U regálu to je rozdíl mezi „počítač o tom ví, než
 * k němu dojdu" a „musím čekat, až něco naskenuju".
 */
console.log('\nnabídne se hned po otevření, ne až po prvním kusu:\n');
const empty = {
  sessions: [{
    id: 'tel-nova', title: 'Naskladnění 1. 9. 2026', note: '', device: 'iPhone Patrik',
    state: 'open', created_at: '2026-09-01T12:00:00.000Z',
    updated_at: '2026-09-01T12:00:00.000Z', sent_at: ''
  }],
  items: []
};
deliver(message('stockin', empty));
check('prázdné naskladnění se nabídne taky',
  work.liveOffers().map(o => o.id), ['tel-nova']);
check('a přizná, že v něm zatím nic není',
  work.liveOffers()[0].detail, '0 položek · 0 ks');
work.dismissOffer('stockin:tel-nova');

// Balení bez jediného odškrtnutého kusu — otevřená objednávka, nic víc
deliver(message('packing', {
  code: '20260830', market: 'cz', packed: '[]', counts: '{}',
  done: false, doneAt: null, at: '2026-09-01T12:01:00.000Z'
}));
check('otevřená objednávka se nabídne bez odškrtnutého kusu',
  work.liveOffers().map(o => [o.id, o.detail]), [['20260830', 'balí se']]);
work.dismissOffer('packing:20260830');

/* ---------- podoba zpráv ---------- */

console.log('\nco se posílá:\n');
const mine = stockin.sessionSlice('tel-abc');
ok('výřez jednoho naskladnění má tvar, který druhá strana slučuje',
  Array.isArray(mine.sessions) && Array.isArray(mine.items));
check('a je v něm jen tohle jedno', mine.sessions.length, 1);
check('neznámé naskladnění se neposílá', stockin.sessionSlice('neexistuje'), null);
check('u balení se posílají jen objednávky z feedu', packing.packingSlice(42), null);

console.log(failed ? `\n✗ ${failed} zkoušek selhalo\n` : '\n✓ živé propojení sedí\n');
process.exit(failed ? 1 : 0);
