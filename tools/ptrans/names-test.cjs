/**
 * Konzistence názvů ve zdrojovém jazyce nad skutečným feedem.
 * Model se nevolá — zkouší se, co se najde jako vybočující.
 *
 *   node tools/ptrans/names-test.cjs /home/claude/feed.xml
 */
const path = require('path');
const fs = require('fs');
const { store, DIST } = require('./harness.cjs');
store.syncFromFeed(fs.readFileSync(process.argv[2] || '/home/claude/feed.xml', 'utf8'));

const cons = require(path.join(DIST, 'ptrans/consistency.js'));
const lang = store.getPtransSettings().sourceLang;

const patterns = cons.patternOverview(lang).filter(p => p.pattern && p.samples >= 5);
console.log(`vzory v „${lang}" (${patterns.length} kategorií):`);
for (const p of patterns.slice(0, 12)) {
  const pct = Math.round(p.matching / p.samples * 100);
  console.log(`  ${String(p.samples).padStart(4)} ks  ${String(pct).padStart(3)}% sedí  ${p.category.padEnd(24)} ${p.pattern}`);
}

const dev = cons.findDeviations(lang, 400);
console.log(`\nvymykají se: ${dev.length}`);
const byCat = {};
for (const d of dev) (byCat[d.category] ??= []).push(d);
for (const [cat, list] of Object.entries(byCat).slice(0, 6)) {
  console.log(`\n  ${cat} — vzor: ${list[0].pattern}`);
  for (const d of list.slice(0, 4)) console.log(`      ${d.code.padEnd(12)} ${d.translated}`);
}
