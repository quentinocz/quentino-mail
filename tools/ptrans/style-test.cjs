/**
 * Zkouška jazykových pravidel a kontroly textu.
 *
 *   npx tsc -p tsconfig.main.json --outDir dist/ptdist
 *   node tools/ptrans/style-test.cjs /home/claude/feed.xml
 */
const path = require('path');
const fs = require('fs');
const { store, DIST } = require('./harness.cjs');
store.syncFromFeed(fs.readFileSync(process.argv[2] || '/home/claude/feed.xml', 'utf8'));

const style = require(path.join(DIST, 'ptrans/style.js'));

console.log('psaní velkých písmen:');
for (const lang of ['cz', 'sk', 'en', 'de']) {
  console.log(`  ${lang} → ${style.caseStyleFor(lang)}  ${style.isInflected(lang) ? '(skloňuje se)' : ''}`);
}

const CASES = [
  // [text, jazyk, má se najít chyba?]
  ['Stuha Dámská Barevná Květovaný Quentino', 'cz', true],
  ['Dámská stuha barevná s květy Quentino', 'cz', false],
  ['Světle modré pánské kšandy Quentino', 'cz', false],
  ['Light Blue Men\'s Suspenders Quentino', 'en', false],
  ['Dámská NEJLEPŠÍ stuha Quentino', 'cz', true],
  ['Dámská stuha stuha s květy Quentino', 'cz', true],
  ['Dámská stuha s květy', 'cz', true],
  ['Dámská stuha barevná s květy Quentino.', 'cz', true]
];

console.log('\nkontrola hotových textů:');
let bad = 0;
for (const [text, lang, expected] of CASES) {
  const found = style.checkText(text, { lang, kind: 'google_title', limit: 70, brand: 'Quentino' });
  const ok = (found.length > 0) === expected;
  if (!ok) bad++;
  console.log(`  ${ok ? '✓' : '✗'} ${text}`);
  for (const problem of found) console.log(`        ${problem.code}: ${problem.message}`);
}
console.log(bad ? `\n${bad} případů nesedí` : '\nvšechny případy sedí');

console.log('\nukázky z feedu (co uvidí model):');
for (const category of ['Stuhy', 'Úzké kšandy', 'Kravaty']) {
  const cz = style.feedExamples('cz', category, 3);
  const en = style.feedExamples('en', category, 3);
  console.log(`  ${category}:`);
  for (const item of cz) console.log('    cz:', item);
  for (const item of en) console.log('    en:', item);
  if (!cz.length && !en.length) console.log('    (žádné)');
}

console.log('\npravidla pro češtinu:\n');
console.log(style.titleRules('cz', 70).split('\n').map(l => '  ' + l).join('\n'));
