/** Odvození tvaru názvů na skutečných datech. */
const path = require('path');
const fs = require('fs');
const { store, DIST } = require('./harness.cjs');
const consistency = require(path.join(DIST, 'ptrans/consistency.js'));

store.syncFromFeed(fs.readFileSync('/home/claude/feed.xml', 'utf8'));

for (const lang of ['en', 'sk']) {
  console.log(`\n=== ${lang.toUpperCase()} ===`);
  const patterns = consistency.patternOverview(lang)
    .filter(p => p.samples >= 8)
    .sort((a, b) => b.samples - a.samples)
    .slice(0, 8);
  for (const p of patterns) {
    const ratio = p.samples ? Math.round((p.matching / p.samples) * 100) : 0;
    console.log(`  ${p.category.padEnd(26)} ${String(p.pattern).padEnd(42)} ${p.matching}/${p.samples} (${ratio} %)`);
  }
  const dev = consistency.findDeviations(lang, 6);
  console.log(`  vymykajících se názvů: ${dev.length}`);
  for (const d of dev.slice(0, 4)) console.log(`    • ${d.code}: „${d.translated}" ≠ ${d.pattern}`);
}
