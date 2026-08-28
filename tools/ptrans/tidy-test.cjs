/**
 * Zkouška úklidu HTML popisů.
 *
 * Kontroluje se jediná věc, ale důkladně: **text se nesmí změnit ani
 * o písmeno**. Zbytek (o kolik se ušetřilo, co se zahodilo) je vedlejší —
 * když se ztratí kus popisu, je to horší než neuklizený `<div>`.
 *
 * Druhá polovina zkoušky je nad databází: po úklidu nesmí žádný hotový
 * překlad naskočit jako „zdroj se změnil". Kdyby ano, jedno kliknutí na
 * úklid by znamenalo přeložit celý feed znovu.
 */
const path = require('path');
const fs = require('fs');
const { db, store, DIST } = require('./harness.cjs');
const { tidyHtml, textOnly, needsTidy } = require(path.join(DIST, 'ptrans/html.js'));
const tidy = require(path.join(DIST, 'ptrans/tidy.js'));

let failed = 0;
function check(label, got, want) {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${label}`);
  if (!ok) {
    console.log('      čekáno:', JSON.stringify(want));
    console.log('      dostal:', JSON.stringify(got));
  }
}
function ok(label, value) { check(label, !!value, true); }

console.log('\núklid jednotlivých případů:\n');

check('obal cizí stránky zmizí, text zůstane',
  tidyHtml('<article data-turn-id="x"><div class="a b c"><p>Ahoj</p></div></article>'),
  '<p>Ahoj</p>');

// Tohle je ten záludný případ: značka, jejímž celým obsahem je mezera mezi
// dvěma slovy. Zahodit ji i s obsahem znamená slepit slova k sobě.
check('mezera zabalená ve značce se zachová',
  textOnly(tidyHtml('<p>pánský motýlek<strong> </strong>ve stejném odstínu</p>')),
  'pánský motýlek ve stejném odstínu');

check('opravdu prázdná značka zmizí',
  tidyHtml('<p>A</p><p></p><p>B</p>'), '<p>A</p><p>B</p>');

check('skript se zahodí i s obsahem',
  tidyHtml('<p>Text</p><script>alert(1)</script>'), '<p>Text</p>');

check('nebezpečný odkaz přijde o cíl',
  tidyHtml('<a href="javascript:alert(1)">klik</a>'), '<a>klik</a>');

check('odkaz i obrázek si nechají, co potřebují',
  tidyHtml('<a href="/x" class="btn" onclick="q()">k</a><img src="/i.jpg" alt="A" class="z">'),
  '<a href="/x">k</a><img src="/i.jpg" alt="A">');

check('holý text se nechá být', tidyHtml('Prostě text bez značek'), 'Prostě text bez značek');
check('prázdný vstup projde', tidyHtml(''), '');

check('drobnost se nehlásí', needsTidy('<p>Text <span>a</span> konec</p>'), false);
ok('obal z chatu se hlásí i bez délky',
  needsTidy('<article data-turn-id="a"><p>Krátký text</p></article>'));

/* ---------- nad skutečným feedem ---------- */

const file = process.argv[2] || process.env.PTRANS_FEED || '/home/claude/feed.xml';
if (!fs.existsSync(file)) {
  console.log(`\nFeed ${file} není k dispozici — část nad reálnými daty se přeskakuje.`);
  process.exit(failed ? 1 : 0);
}

store.syncFromFeed(fs.readFileSync(file, 'utf8'));
const rows = db.prepare(
  `SELECT code, field, source_value AS v FROM ptrans_fields
   WHERE field IN ('long','short') AND source_value != ''`
).all();

let before = 0, after = 0, changed = 0;
const lost = [];
for (const row of rows) {
  const out = tidyHtml(row.v);
  before += row.v.length;
  after += out.length;
  if (out !== row.v) changed++;
  if (textOnly(out) !== textOnly(row.v)) lost.push(row);
}

console.log(`\nnad feedem (${rows.length} polí):\n`);
console.log(`  · uklidilo by se ${changed} polí`);
console.log(`  · ${before.toLocaleString('cs-CZ')} → ${after.toLocaleString('cs-CZ')} znaků`
  + ` (−${Math.round((1 - after / before) * 100)} %)`);
check('nikde se neztratilo písmeno', lost.length, 0);
for (const row of lost.slice(0, 3)) {
  const a = textOnly(row.v), b = textOnly(tidyHtml(row.v));
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] === b[i]) continue;
    console.log('     ', row.code, row.field);
    console.log('      před:', JSON.stringify(a.slice(Math.max(0, i - 40), i + 60)));
    console.log('      po  :', JSON.stringify(b.slice(Math.max(0, i - 40), i + 60)));
    break;
  }
}

/* ---------- úklid v databázi ---------- */

console.log('\núklid produktu ve všech jazycích:\n');

const worst = db.prepare(
  `SELECT code, field, source_value AS v FROM ptrans_fields
   WHERE field = 'long' ORDER BY length(source_value) DESC LIMIT 1`
).get();
const code = worst.code;
const langs = store.targetLangs();
const sourceLang = store.getPtransSettings().sourceLang;

// Do jednoho jazyka se udělá „hotový překlad" se stejným balastem, aby šlo
// ověřit, že úklid projde i jazykovou mutací a nerozhodí jí stav. Text se
// musí od zdroje lišit, jinak by se právem označil jako nepřeložený.
const first = langs[0];
const fake = worst.v.replace(/Šle/g, 'Traky').replace(/kšand/g, 'traky');
store.saveTranslation(code, first, 'long', fake, 'zkouška');
const stateBefore = db.prepare(
  'SELECT state FROM ptrans_fields WHERE code = ? AND lang = ? AND field = ?'
).get(code, first, 'long').state;

ok('nepořádek se najde ve zdroji i v překladu',
  tidy.messyFields(code).some(f => f.lang === sourceLang)
  && tidy.messyFields(code).some(f => f.lang === first));

const stateOther = langs[1] ? db.prepare(
  `SELECT state FROM ptrans_fields WHERE code = ? AND lang = ? AND field = 'long'`
).get(code, langs[1]).state : null;

const result = tidy.tidyProduct(code);
console.log(`  · ${code}: uklizeno ${result.fields} polí v jazycích ${result.langs.join(', ')}`
  + ` (${result.saved.toLocaleString('cs-CZ')} znaků)`);

const sourceAfter = store.fieldValue(code, sourceLang, 'long');
check('zdroj je uklizený', needsTidy(sourceAfter), false);
check('text zdroje se nezměnil', textOnly(sourceAfter), textOnly(worst.v));

const row = db.prepare(
  `SELECT translated, source_value, state, messy FROM ptrans_fields
   WHERE code = ? AND lang = ? AND field = 'long'`
).get(code, first);
check('překlad je uklizený', needsTidy(row.translated), false);
check('text překladu se nezměnil', textOnly(row.translated), textOnly(fake));
check('originál u překladu je taky uklizený', needsTidy(row.source_value), false);
check('překlad nenaskočil jako zastaralý', row.state, stateBefore);
check('příznak nepořádku zhasl', row.messy, 0);
// Druhý jazyk zůstal nepřeložený — úklid se ho má dotknout, ale nesmí ho
// začít vydávat za přeložený
const other = langs[1];
if (other) {
  const rest = db.prepare(
    `SELECT translated, value, state FROM ptrans_fields
     WHERE code = ? AND lang = ? AND field = 'long'`).get(code, other);
  check('nepřeložený trh se taky uklidil', needsTidy(rest.value), false);
  check('a nezačal se tvářit jako přeložený', rest.translated, null);
  check('stav nepřeloženého pole zůstal', stateOther, rest.state);
}

check('u produktu už není co uklízet', tidy.messyFields(code).length, 0);
check('druhé spuštění nic nemění', tidy.tidyProduct(code).fields, 0);

// Filtr musí ten produkt najít, dokud je špinavý, a pustit ho, až uklizený je
const dirty = db.prepare(
  `SELECT code FROM ptrans_fields WHERE messy = 1 AND code != ? LIMIT 1`).get(code);
if (dirty) {
  const found = store.listProducts({ state: 'messy', limit: 2000, onlyActive: false });
  ok('filtr „nepořádek v HTML" produkty najde', found.total > 0);
  check('uklizený produkt už ve filtru není',
    found.rows.some(r => r.code === code), false);
}

console.log(failed ? `\n${failed}× neprošlo` : '\núklid nechává text beze změny a nerozhazuje stavy');
process.exit(failed ? 1 : 0);
