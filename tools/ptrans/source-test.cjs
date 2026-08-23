/**
 * Zkouška doplňování zdrojových textů nad skutečným feedem.
 *
 * Model se nevolá — testuje se, co se **naplánuje** a jestli se hotový
 * zdrojový text rozešle do všech cílových jazyků.
 *
 *   npx tsc -p tsconfig.main.json --outDir dist/ptdist
 *   node tools/ptrans/source-test.cjs /home/claude/feed.xml
 */
const path = require('path');
const fs = require('fs');
const { db, store, DIST } = require('./harness.cjs');

const feed = fs.readFileSync(process.argv[2] || '/home/claude/feed.xml', 'utf8');
store.syncFromFeed(feed);

const source = require(path.join(DIST, 'ptrans/source.js'));
const codes = store.listProducts({ limit: 400 }).rows.map(r => r.code);
console.log('produktů ve vzorku:', codes.length);

console.log('\nco chybí v češtině:');
let missingTotal = 0;
for (const item of source.missingByField(codes)) {
  const pct = Math.round(item.missing / codes.length * 100);
  console.log(`  ${item.label.padEnd(16)} ${String(item.missing).padStart(4)}×  ${pct}%`);
  missingTotal += item.missing;
}

const plan = source.planSourceFill({ codes });
console.log('\nnaplánováno:', plan.length, 'z', missingTotal, 'chybějících');
console.log('(rozdíl = produkty bez názvu i popisu, ty se přeskakují)');

const forced = source.planSourceFill({ codes, force: true });
console.log('s přepsáním všeho:', forced.length);

const only = source.planSourceFill({ codes, fields: ['google_title'] });
console.log('jen Google titulek:', only.length);

// Rozeslání zdroje do cílových jazyků
const probe = plan.find(p => p.field === 'seo_title') || plan[0];
if (probe) {
  const langs = store.targetLangs();
  const before = langs.map(l => store.fieldValue(probe.code, l, probe.field));
  store.propagateSource(probe.code, probe.field, 'ZKOUŠKA ZDROJE');
  const after = langs.map(l => {
    const row = db.prepare(
      'SELECT source_value FROM ptrans_fields WHERE code = ? AND lang = ? AND field = ?'
    ).get(probe.code, l, probe.field);
    return row ? row.source_value : null;
  });
  console.log('\nrozeslání zdroje u', probe.code, '/', probe.field);
  console.log('  jazyky:', langs.join(', '));
  console.log('  před:  ', JSON.stringify(before));
  console.log('  po:    ', JSON.stringify(after));
  const ok = after.every(v => v === 'ZKOUŠKA ZDROJE');
  console.log(ok ? '  ✓ zdroj dorazil do všech jazyků' : '  ✗ někde chybí');
}

// Doplněný zdroj musí zároveň otevřít práci pro překlad, jinak by se čerstvý
// text nikam nepřeložil
if (probe) {
  const states = store.targetLangs().map(l => {
    const row = db.prepare(
      'SELECT state FROM ptrans_fields WHERE code = ? AND lang = ? AND field = ?'
    ).get(probe.code, l, probe.field);
    return `${l}:${row ? row.state : '—'}`;
  });
  console.log('  stav po doplnění:', states.join(' '));
}
