/**
 * Zkouška napojení na Zásilkovnu.
 *
 * Zásilkovna se v kontejneru volat nedá, zato se dá zkoušet přesně to, na
 * čem u cizí služby stojí všechno ostatní: jestli se pošle správný XML
 * dokument, jestli se z odpovědi přečte číslo zásilky — a hlavně jestli se
 * z chyby dostane **jejich vlastní věta**, ne naše „nepovedlo se".
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
function ok(label, value) { check(label, !!value, true); }

db.exec(`
  CREATE TABLE IF NOT EXISTS shop_orders (
    code TEXT NOT NULL, market TEXT NOT NULL DEFAULT 'cz', status TEXT NOT NULL DEFAULT '',
    paid INTEGER NOT NULL DEFAULT 0, paid_date TEXT NOT NULL DEFAULT '', resolved INTEGER NOT NULL DEFAULT 0,
    invoice TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '',
    currency TEXT NOT NULL DEFAULT '', total REAL NOT NULL DEFAULT 0, tracking TEXT NOT NULL DEFAULT '',
    customer_id TEXT NOT NULL DEFAULT '', name TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '', shipment TEXT NOT NULL DEFAULT '', payment TEXT NOT NULL DEFAULT '',
    pickup_id TEXT NOT NULL DEFAULT '', pickup_name TEXT NOT NULL DEFAULT '',
    items_json TEXT NOT NULL DEFAULT '[]', billing_json TEXT, postal_json TEXT, seen_at TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (code, market)
  );
`);

const add = (row) => db.prepare(
  `INSERT OR REPLACE INTO shop_orders
   (code, market, name, email, phone, currency, total, shipment, payment, pickup_id, pickup_name,
    items_json, postal_json)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
).run(row.code, 'cz', row.name, row.email, row.phone, 'CZK', row.total, row.shipment, row.payment,
  row.pickupId ?? '', row.pickupName ?? '', JSON.stringify(row.items ?? []),
  row.postal ? JSON.stringify(row.postal) : null);

add({ code: '024100', name: 'Jana Nováková', email: 'jana@example.cz', phone: '+420777123456',
  total: 1290, shipment: 'Zásilkovna Z-Box', payment: 'Dobírka', pickupId: '12345',
  items: [{ title: 'Kravata vínová', quantity: 1 }],
  postal: { name: 'Jana Nováková', company: 'Z-BOX Praha 1', street: 'Dlouhá 12', city: 'Praha', zip: '110 00', country: 'CZ' } });
// Výdejní místo bez čísla — zásilka se nesmí založit naslepo
add({ code: '024101', name: 'Petr Malý', email: 'petr@example.cz', phone: '+420777000111',
  total: 590, shipment: 'Zásilkovna Výdejní místo', payment: 'Platba kartou', pickupName: 'Trafika U Nádraží',
  items: [{ title: 'Motýlek', quantity: 1 }], postal: null });
// Jiný dopravce
add({ code: '024102', name: 'Eva Krátká', email: 'eva@example.cz', phone: '+420777222333',
  total: 800, shipment: 'PPL', payment: 'Dobírka', items: [], postal: null });

/*
 * Šifrování hesel stojí na Electronu (`safeStorage`), který mimo aplikaci
 * není. Zkouší se napojení na Zásilkovnu, ne trezor — heslo tedy projde tak,
 * jak je.
 */
const secPath = require.resolve(path.join(DIST, 'secure.js'));
require.cache[secPath] = { id: secPath, filename: secPath, loaded: true, exports: {
  encrypt: v => v, decrypt: v => v
} };

const packeta = require(path.join(DIST, 'packeta.js'));
const { __test } = packeta;

// Odpovědi Zásilkovny tak, jak vypadají doopravdy
const sent = [];
global.fetch = async (url, init) => {
  sent.push(String(init.body));
  const body = String(init.body);
  if (body.includes('<createPacket>')) {
    return {
      ok: true, status: 200,
      text: async () => '<?xml version="1.0"?><response><status>ok</status><result>'
        + '<id>1234567890</id><barcode>Z 123 4567 890</barcode></result></response>'
    };
  }
  if (body.includes('<packetsLabelsPdf>')) {
    const pdf = Buffer.from('%PDF-1.4 zkouška').toString('base64');
    return { ok: true, status: 200, text: async () => `<response><status>ok</status><result>${pdf}</result></response>` };
  }
  return { ok: true, status: 200, text: async () => '<response><status>ok</status></response>' };
};

(async () => {
  console.log('\nZásilkovna:\n');

  packeta.savePacketaSetup({ password: 'tajne', eshop: 'quentino.cz', labelFormat: 'A6 on A4', labelOffset: 0 });
  ok('heslo se uloží zašifrované', packeta.packetaSetup().hasPassword);

  const out = await packeta.createPackets(['024100', '024101', '024102']);
  check('založí se jen ta, co má číslo výdejny', out.created.map(one => one.code), ['024100']);
  check('a zbytek se vypíše s důvodem', out.failed.map(one => one.code), ['024101', '024102']);
  /*
   * Bez čísla výdejny se hádat nesmí: spletený název znamená balík v jiném
   * městě. V důvodu musí být vidět, o které místo šlo.
   */
  ok('u chybějícího čísla se řekne které místo', out.failed[0].reason.includes('Trafika U Nádraží'));

  const request = sent[0];
  ok('posílá se dokument s metodou v kořeni', request.includes('<createPacket>'));
  ok('heslo jde uvnitř dokumentu', request.includes('<apiPassword>tajne</apiPassword>'));
  ok('číslo objednávky je číslo zásilky', request.includes('<number>024100</number>'));
  ok('jméno se rozdělí na křestní a příjmení',
    request.includes('<name>Jana</name>') && request.includes('<surname>Nováková</surname>'));
  ok('výdejna jde číslem, ne adresou',
    request.includes('<addressId>12345</addressId>') && !request.includes('<street>'));
  ok('dobírka se přenese', request.includes('<cod>1290</cod>'));
  ok('a obsah zásilky taky', request.includes('<note>kravata</note>'));

  // Podruhé se táž objednávka nezakládá — byly by z ní dva balíky
  sent.length = 0;
  const again = await packeta.createPackets(['024100']);
  check('podruhé se nezakládá', [again.created.length, sent.length], [1, 0]);
  check('a vrátí se ta původní zásilka', again.created[0].packetId, '1234567890');

  const labels = await packeta.labelsPdf(['024100', '024101']);
  const labelRequest = sent[sent.length - 1];
  ok('štítky chtějí čísla zásilek', labelRequest.includes('<id>1234567890</id>'));
  ok('a velikost archu', labelRequest.includes('<format>A6 on A4</format>'));
  check('zásilka bez štítku se vypíše', labels.missing, ['024101']);
  // V harness je dialog na uložení zrušený — soubor tedy nevznikne, ale počet sedí
  check('štítek se počítá jen k založeným', labels.count, 1);

  /* ---------- chyby ---------- */

  global.fetch = async () => ({
    ok: true, status: 200,
    text: async () => '<response><status>fault</status><fault>PacketAttributesFault</fault>'
      + '<string>Chybná data zásilky</string><detail><attributes>'
      + '<fault><name>addressId</name><fault>Pobočka neexistuje</fault></fault>'
      + '</attributes></detail></response>'
  });
  const bad = await packeta.createPackets(['024100', '024103']);
  // Objednávka 024100 už zásilku má, takže se nevolá; ověřuje se čtení chyby
  check('chybová věta je jejich, ne naše',
    __test.faultOf('<response><status>fault</status><fault>X</fault><string>Chybná data zásilky</string>'
      + '<detail><fault><name>addressId</name><fault>Pobočka neexistuje</fault></fault></detail></response>'),
    'Chybná data zásilky (addressId: Pobočka neexistuje)');
  ok('a nespolkne se', bad.created.length === 1);

  ok('název s ampersandem dokument nerozbije', __test.esc('Trafika U & Nádraží') === 'Trafika U &amp; Nádraží');
  check('prázdné kolonky se neposílají', __test.elems({ a: '1', b: '', c: null, d: 2 }), '<a>1</a><d>2</d>');

  console.log(failed === 0 ? '\nvše sedí\n' : `\n${failed} nesedí\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
