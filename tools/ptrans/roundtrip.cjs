/** Kontrola, že zápis překladu do XML mění jen to jedno místo. */
const { db, store, xml } = require('./harness.cjs');
const fs = require('fs');

const feed = fs.readFileSync(process.argv[2] || '/home/claude/feed.xml', 'utf8');
const products = xml.splitProducts(feed);
const one = products.find(p => p.code === 'PS00SM') || products[0];

let block = one.block;
const before = block;

const checks = [
  ['sk', 'title', 'Testovací názov'],
  ['sk', 'short', '<p>Krátky <b>popis</b> & test</p>'],
  ['sk', 'seo_title', 'SEO titulok'],
  ['en', 'google_title', 'Google title test'],
  ['de', 'title', 'Deutscher Titel'],          // jazyk, který ve feedu není
  ['de', 'seo_desc', 'Deutsche Beschreibung']
];
for (const [lang, field, value] of checks) {
  block = xml.setField(block, lang, field, value, 'cz');
  const read = xml.getField(block, lang, field);
  console.log(`${lang}/${field}: ${read === value ? 'ok' : 'CHYBA → ' + JSON.stringify(read)}`);
}

// Co se skutečně změnilo
function diffLines(a, b) {
  const A = a.split('\n'), B = b.split('\n');
  const out = [];
  for (let i = 0, j = 0; i < A.length || j < B.length;) {
    if (A[i] === B[j]) { i++; j++; continue; }
    if (B[j] !== undefined && !A.includes(B[j])) { out.push('+ ' + B[j].trim().slice(0, 90)); j++; continue; }
    if (A[i] !== undefined && !B.includes(A[i])) { out.push('- ' + A[i].trim().slice(0, 90)); i++; continue; }
    i++; j++;
  }
  return out;
}
console.log('\nzměněné řádky:');
for (const line of diffLines(before, block).slice(0, 14)) console.log('  ', line);

// Zbytek souboru musí zůstat netknutý: porovnáme délky sekcí, které neměníme
const untouched = ['<PRICES>', '<IMAGES>', '<VARIANTS>', '<CATEGORIES>'];
for (const marker of untouched) {
  const a = before.split(marker)[1]?.slice(0, 400);
  const b = block.split(marker)[1]?.slice(0, 400);
  console.log(marker, a === b ? 'beze změny' : 'ZMĚNĚNO!');
}

// Cizí čeština v CDATA a entity
const tricky = xml.setField(one.block, 'sk', 'long', '<p>A & B ]]> "C" <em>D</em></p>', 'cz');
console.log('\nCDATA a entity:', xml.getField(tricky, 'sk', 'long'));
