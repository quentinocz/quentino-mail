/** Učení paměti překladů ze skutečného feedu. */
const path = require('path');
const fs = require('fs');
const { store, DIST } = require('./harness.cjs');
const memory = require(path.join(DIST, 'ptrans/memory.js'));

store.syncFromFeed(fs.readFileSync('/home/claude/feed.xml', 'utf8'));

console.time('učení');
const result = memory.learnFromFeed(['sk', 'en']);
console.timeEnd('učení');
for (const r of result) {
  console.log(`  ${r.lang}: z ${r.pairs} dvojic → ${r.terms} výrazů, ${r.patterns} vzorů, ${r.examples} ukázek`);
}

for (const lang of ['sk', 'en']) {
  console.log(`\n=== ${lang.toUpperCase()} — nejlépe doložené výrazy ===`);
  const terms = memory.listMemory({ lang, kind: 'term' }).slice(0, 18);
  for (const t of terms) {
    console.log(`  ${t.source.padEnd(22)} → ${t.target.padEnd(26)} ${t.hits}× (${t.confidence})`);
  }
}

console.log('\n=== ukázka nápovědy do promptu (nový produkt) ===');
console.log(memory.memoryHint('Smaragdově zelená pánská kravata s jemným vzorem', 'en', 'Vzorované kravaty'));
