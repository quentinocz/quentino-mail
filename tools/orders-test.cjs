/**
 * Zkouška rozboru feedu objednávek. Bere soubor, ne síť — data zákazníků
 * se nikam neposílají a zkouška jde pustit i bez připojení.
 *
 *   node tools/orders-test.cjs <objednavky.xml> [trh]
 */
const fs = require('fs');
const path = require('path');
const DIST = process.env.PTDIST || path.join(__dirname, '../dist/ptdist/main');
require.cache[require.resolve('electron')] = {
  id: 'electron', filename: 'electron', loaded: true,
  exports: { net: {}, BrowserWindow: { getAllWindows: () => [] }, app: { getPath: () => '/tmp' } }
};
const dbPath = require.resolve(path.join(DIST, 'db.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {
  getDb: () => { throw new Error('databáze se v téhle zkoušce nepoužívá'); },
  getSetting: () => '', setSetting: () => {}
} };
const secPath = require.resolve(path.join(DIST, 'secure.js'));
require.cache[secPath] = { id: secPath, filename: secPath, loaded: true, exports: {
  encrypt: v => v, decrypt: v => v
} };

const feed = require(path.join(DIST, 'orderfeed.js'));
const xml = fs.readFileSync(process.argv[2], 'utf8');
const market = process.argv[3] || 'cz';
const orders = feed.parseOrders(xml, market);

console.log('objednávek:', orders.length);
const withPhone = orders.filter(o => o.phone).length;
const withEmail = orders.filter(o => o.email).length;
const withItems = orders.filter(o => o.items.length).length;
console.log(`  s telefonem: ${withPhone} (${Math.round(withPhone / orders.length * 100)} %)`);
console.log(`  s e-mailem:  ${withEmail} (${Math.round(withEmail / orders.length * 100)} %)`);
console.log(`  s položkami: ${withItems} (${Math.round(withItems / orders.length * 100)} %)`);

console.log('\nprvní objednávka (osobní údaje zkrácené):');
const o = orders[0];
if (o) {
  const mask = s => (s || '').replace(/[^@.\s+]/g, '•');
  console.log({
    ...o,
    name: mask(o.name), email: mask(o.email), phone: (o.phone || '').slice(0, 4) + '•••',
    items: o.items.map(i => ({ ...i, title: i.title.slice(0, 30) }))
  });
}

console.log('\ntvary telefonů:');
const shapes = {};
for (const order of orders) {
  const key = order.phone ? order.phone.slice(0, 4) + ` (${order.phone.length} znaků)` : '(prázdné)';
  shapes[key] = (shapes[key] ?? 0) + 1;
}
for (const [key, n] of Object.entries(shapes).sort((a, b) => b[1] - a[1]).slice(0, 8)) {
  console.log(`  ${String(n).padStart(4)}×  ${key}`);
}

console.log('\nprázdná pole:');
for (const field of ['code', 'status', 'createdAt', 'currency', 'total', 'shipment', 'payment', 'tracking', 'invoice']) {
  const empty = orders.filter(order => !order[field]).length;
  if (empty) console.log(`  ${field}: chybí u ${empty} z ${orders.length}`);
}
