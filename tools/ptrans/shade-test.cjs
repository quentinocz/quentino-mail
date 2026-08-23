/**
 * Odstín z názvu produktu.
 *
 * Pro Google jsou barva a odstín dvě různé věci: `g:color` chce základní
 * barvu (filtruje se podle ní), titulek a popis naopak odstín — tak produkt
 * vypadá a tak ho zákazník hledá. Tenhle test kontroluje, že se odstín z
 * názvu vytáhne celý a nic navíc.
 *
 *   node tools/ptrans/shade-test.cjs [feed.xml]
 */
const fs = require('fs');
const path = require('path');
const { db, store, DIST } = require('./harness.cjs');
const colors = require(path.join(DIST, 'ptrans/colors.js'));

store.syncFromFeed(fs.readFileSync(process.argv[2] || '/home/claude/feed.xml', 'utf8'));
colors.learnColors();

console.log('=== ruční příklady ===');
const cases = [
  'Hořčicově žluté pánské kšandy s motýlkem',
  'Tmavě modrý vázací pánský motýlek s jemnými puntíky',
  'Starorůžová pánská kravata',
  'Smaragdově zelená elegantní kravata s paisley vzorem',
  'Barevná dámská stuha s květy',
  'Bílé manžetové knoflíčky s modrými květy',
  'Set kravata pro tátu a syna',
  'Světle modré pánské kšandy s motýlkem',
  'Pánský kapesníček do saka'
];
for (const title of cases) {
  const shade = colors.shadeFromTitle(title);
  const base = shade ? colors.baseColorOf(shade) : null;
  console.log(`  ${title.slice(0, 50).padEnd(52)} odstín=${(shade || '—').padEnd(22)}`
    + ` g:color=${base ? colors.baseLabel(base, 'cz') : '—'}`);
}

console.log('\n=== napříč feedem ===');
const rows = store.listProducts({ state: 'all', limit: 400 }).rows;
let withShade = 0;
let differs = 0;
const samples = [];
for (const row of rows) {
  const shade = colors.shadeFromTitle(row.title);
  if (!shade) continue;
  withShade++;
  const key = colors.baseColorOf(shade);
  const base = key ? colors.baseLabel(key, 'cz') : '';
  // Zajímavé jsou ty, kde se odstín liší od základní barvy — právě kvůli nim
  // se to celé rozlišuje
  if (base && colors.normalize(shade) !== colors.normalize(base)) {
    differs++;
    if (samples.length < 15) samples.push(`${shade} → ${base}`);
  }
}
console.log(`z ${rows.length} produktů má ${withShade} rozpoznatelný odstín,`
  + ` u ${differs} se odstín liší od základní barvy`);
console.log('ukázky:');
for (const sample of samples) console.log('  •', sample);

// Kontrola, že se odstín nerozlézá do zbytku názvu
const tooLong = rows
  .map(row => ({ title: row.title, shade: colors.shadeFromTitle(row.title) }))
  .filter(item => item.shade && item.shade.split(/\s+/).length > 3);
console.log('\nodstíny delší než tři slova (měly by být vzácné):', tooLong.length);
for (const item of tooLong.slice(0, 5)) console.log(`  ✗ „${item.shade}" z „${item.title}"`);
