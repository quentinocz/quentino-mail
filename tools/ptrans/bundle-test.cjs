/**
 * Rozpoznání setů pro Google (`is_bundle_google_merchant`) na názvech
 * ve tvaru, jaký má Quentino.
 *
 * ## Proč
 *
 * Kontrola exportu z 18. 11. ukázala, že stejné zboží dostává různou
 * odpověď podle toho, jak je pojmenované: „motýlek s kapesníčkem" vyšel
 * jako set, „motýlek včetně kapesníčku" (40 motýlků PMKV/PMSKV) ne, a
 * svatební regata s kapesníčkem taky ne — regata mezi druhy výrobků
 * chyběla. Import by jim v e-shopu „set" vypnul.
 *
 *   node tools/ptrans/bundle-test.cjs
 */
const path = require('path');
const { db, DIST } = require('./harness.cjs');
const bundle = require(path.join(DIST, 'ptrans/bundle.js'));

let bad = 0;
const ok = (label, value, note = '') => {
  if (!value) bad++;
  console.log(`  ${value ? '✓' : '✗'} ${label}${note ? `   ${note}` : ''}`);
};

const NAZVY = [
  ['PMSK70L', 'Starorůžový pánský motýlek lesklý s kapesníčkem', true],
  ['PMKV02', 'Tmavě hnědý pánský motýlek s jemným květinovým vzorem včetně kapesníčku', true],
  ['LXS120LBZ', 'Lněné béžové kšandy s motýlkem včetně kapesníčku', true],
  ['REGJL02', 'Vínově červená svatební regata s kapesníčkem', true],
  ['REGV04', 'Světle béžovo hnědá svatební regata s jemným ornamentálním vzorem a kapesníčkem', true],
  ['KPK06', 'Pánská dárková sada – světlounce růžová kravata, kapesníček a ponožky', true],
  // Jeden výrobek — vzor, lem nebo motiv nejsou druhý výrobek
  ['PMKV11', 'Černý pánský motýlek s modrými květinkami', false],
  ['KAPL02', 'Bílý pánský kapesníček s vínově červeným lemem', false],
  ['REGJ02', 'Bílá svatební regata s jemnou strukturou', false],
  ['PKHVB19', 'Bordó pánská hedvábná kravata s modrým geometrickým vzorem', false],
  ['PNL MIX', 'Černé ponožky PIVO a CHMEL', false]
];

console.log('\nsety podle názvu:\n');
db.exec('DELETE FROM ptrans_products;');
const vloz = db.prepare(`INSERT INTO ptrans_products (code, title, category, categories) VALUES (?, ?, '', '')`);
for (const [code, nazev] of NAZVY) vloz.run(code, nazev);
for (const [code, nazev, set] of NAZVY) {
  const verdikt = bundle.detectBundle(code);
  ok(`${set ? 'set    ' : 'není set'}  ${nazev}`, verdikt.isBundle === set, verdikt.reason);
}

/*
 * Uložené „ne" z dřívějška se před exportem přepočítá — jinak by lepší
 * pravidla do e-shopu nikdy nedošla. Ruční volba zůstane.
 */
console.log('\npřepočet před exportem:\n');
const store = require(path.join(DIST, 'ptrans/store.js'));
db.exec('DELETE FROM ptrans_fields;');
store.saveTranslation('PMKV02', 'cz', 'google_bundle', 'no', 'pravidla');
store.saveTranslation('PMKV02', 'sk', 'google_bundle', 'no', 'pravidla');
store.saveTranslation('REGJL02', 'cz', 'google_bundle', 'no', 'ruční', true);
store.saveTranslation('KAPL02', 'cz', 'google_bundle', 'no', 'pravidla');
const zmeneno = bundle.refreshBundles();
const hodnota = (code, lang) => db.prepare(
  "SELECT value FROM ptrans_fields WHERE code = ? AND lang = ? AND field = 'google_bundle'").get(code, lang)?.value;
ok('„ne" od pravidel se přepočítá na set', hodnota('PMKV02', 'cz') === 'yes' && hodnota('PMKV02', 'sk') === 'yes',
  `změněno ${zmeneno}`);
ok('  ruční volba zůstane', hodnota('REGJL02', 'cz') === 'no');
ok('  a správné „ne" taky', hodnota('KAPL02', 'cz') === 'no' && zmeneno === 2);

console.log(bad ? `\n✗ ${bad} chyb` : '\n✓ sety sedí');
process.exit(bad ? 1 : 0);
