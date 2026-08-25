/**
 * Adresa podle přeloženého názvu a stará adresa do 301.
 *
 * Dřív se adresa odvozovala jen tehdy, když sama vyšla jako „čeká na překlad".
 * To je ale úplně jiná otázka, než jestli se právě přeložil název — a tak
 * u produktu se slušnou (nebo ve všech jazycích shodnou) adresou zůstala
 * viset ta česká. Adresa se proto řídí názvem, ne svým vlastním stavem.
 *
 * Zkouší se i to, co se stát nesmí:
 *  - z nepřeloženého názvu se adresa nedělá (jinak vznikne český slug
 *    a k němu zbytečné přesměrování),
 *  - ručně upravenou adresu překlad nepřepíše,
 *  - stejná adresa nevyrobí přesměrování sama na sebe.
 *
 *   npx tsc -p tsconfig.main.json --outDir dist/ptdist
 *   node tools/ptrans/seourl-test.cjs
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DIST = process.env.PTDIST || path.join(__dirname, '../../dist/ptdist/main');

const file = '/tmp/ptrans-seourl.db';
fs.rmSync(file, { force: true });
const inner = new DatabaseSync(file);
const norm = v => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
const db = {
  exec: sql => inner.exec(sql),
  pragma: sql => inner.exec(`PRAGMA ${sql}`),
  prepare(sql) {
    const stmt = inner.prepare(sql);
    const call = (m, args) => stmt[m](...args.map(norm));
    return { run: (...a) => call('run', a), get: (...a) => call('get', a), all: (...a) => call('all', a) };
  },
  transaction: body => (...a) => {
    inner.exec('BEGIN');
    try { const r = body(...a); inner.exec('COMMIT'); return r; }
    catch (e) { inner.exec('ROLLBACK'); throw e; }
  }
};

/* Schéma ze skutečného zdroje */
const schemaSrc = fs.readFileSync(path.join(__dirname, '../../src/main/ptrans/schema.ts'), 'utf8');
for (const found of schemaSrc.matchAll(/`([\s\S]*?)`/g)) {
  if (found[1].includes('CREATE TABLE')) {
    for (const statement of found[1].split(/;\s*\n/)) {
      if (statement.trim()) { try { db.exec(statement + ';'); } catch { /* rejstřík nad chybějícím sloupcem */ } }
    }
  }
}
db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');

const settings = new Map();
const shim = (name, exports) => {
  const id = require.resolve(path.join(DIST, name));
  require.cache[id] = { id, filename: id, loaded: true, exports };
};
shim('db.js', {
  getDb: () => db,
  getSetting: (key, fallback = null) => (settings.has(key) ? settings.get(key) : fallback),
  setSetting: (key, value) => settings.set(key, String(value))
});
shim('ai.js', { ask: async () => '{}' });
shim('settings.js', { getSettings: () => ({ draftModel: 'test', brandPrompt: '' }), touchState: () => {} });
require.cache[require.resolve('electron')] = { id: 'electron', filename: 'electron', loaded: true,
  exports: { app: { getPath: () => '/tmp' }, BrowserWindow: { getAllWindows: () => [] }, dialog: {}, net: {} } };

const store = require(path.join(DIST, 'ptrans/store.js'));
const { applySlug } = require(path.join(DIST, 'ptrans/translate.js'));

let bad = 0;
const check = (label, ok, detail = '') => {
  if (!ok) bad++;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
};

const CODE = 'PKT23';
db.prepare("INSERT INTO ptrans_products (code, title, raw_xml) VALUES (?,?,'')")
  .run(CODE, 'Bordó pánská kravata');

/** Založí pole produktu v daném stavu — jako by právě doběhlo čtení feedu. */
function field(lang, name, value, state, extra = {}) {
  db.prepare(
    `INSERT INTO ptrans_fields (code, lang, field, value, source_value, state, translated, manual)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(code, lang, field) DO UPDATE SET
       value = excluded.value, source_value = excluded.source_value, state = excluded.state,
       translated = excluded.translated, manual = excluded.manual`
  ).run(CODE, lang, name, value, extra.source ?? '', state, extra.translated ?? null, extra.manual ? 1 : 0);
}

const seoUrl = lang => {
  const row = db.prepare(
    "SELECT value, translated FROM ptrans_fields WHERE code = ? AND lang = ? AND field = 'seo_url'"
  ).get(CODE, lang);
  return row ? (row.translated || row.value) : '';
};
const redirect = lang => {
  const row = db.prepare(
    "SELECT value, translated FROM ptrans_fields WHERE code = ? AND lang = ? AND field = 'redirect'"
  ).get(CODE, lang);
  return row ? (row.translated ?? row.value) : '';
};

console.log('adresa jde za názvem:\n');

// Angličtina: název právě přeložen, adresa je pořád česká
field('en', 'title', 'Bordó pánská kravata', 'same', { source: 'Bordó pánská kravata' });
field('en', 'seo_url', 'bordo-panska-kravata', 'ok', { source: 'bordo-panska-kravata' });
field('en', 'redirect', '', 'ok');

let result = applySlug(CODE, 'en', store.productFields(CODE, ['en']), 'zkouška',
  "Burgundy men's necktie");
check('adresa se přepsala podle přeloženého názvu',
  seoUrl('en') === 'burgundy-mens-necktie', `adresa: ${seoUrl('en')}`);
check('stará adresa šla do 301',
  redirect('en') === '/p/bordo-panska-kravata', `301: ${redirect('en')}`);
check('vrací se, co se změnilo', !!result?.redirect, JSON.stringify(result));

// Druhý běh se stejným názvem už nemá co měnit — a hlavně nesmí přidat
// přesměrování sám na sebe
const before = redirect('en');
result = applySlug(CODE, 'en', store.productFields(CODE, ['en']), 'zkouška',
  "Burgundy men's necktie");
check('stejný název adresu nepřepisuje', result === null, JSON.stringify(result));
check('nevzniklo přesměrování sama na sebe', redirect('en') === before, redirect('en'));

console.log('\nkdyž se to dělat nemá:\n');

// Slovenština: název ještě přeložený není — z české verze by vznikl český slug
field('sk', 'title', 'Bordó pánská kravata', 'same', { source: 'Bordó pánská kravata' });
field('sk', 'seo_url', 'bordo-panska-kravata', 'ok', { source: 'bordo-panska-kravata' });
result = applySlug(CODE, 'sk', store.productFields(CODE, ['sk']), 'zkouška');
check('z nepřeloženého názvu se adresa nedělá', result === null, JSON.stringify(result));
check('česká adresa zůstala nedotčená', seoUrl('sk') === 'bordo-panska-kravata');

// Němčina: adresu si někdo přepsal ručně
field('de', 'title', 'Weinrote Herrenkrawatte', 'ok', { source: 'Bordó pánská kravata' });
field('de', 'seo_url', 'meine-adresse', 'manual', { manual: true });
result = applySlug(CODE, 'de', store.productFields(CODE, ['de']), 'zkouška');
check('ruční adresa se nepřepisuje', result === null, JSON.stringify(result));
check('ruční adresa zůstala', seoUrl('de') === 'meine-adresse', seoUrl('de'));

console.log('\nhotový překlad z minula:\n');

// Polština: název byl přeložený dřív (ve feedu, ne teď), adresa česká.
// Tohle je přesně případ, který dřív propadl — název se nepřekládá, tak se
// adresa neodvodila.
field('pl', 'title', 'Bordowy krawat męski', 'ok', { source: 'Bordó pánská kravata' });
field('pl', 'seo_url', 'bordo-panska-kravata', 'ok', { source: 'bordo-panska-kravata' });
field('pl', 'redirect', '', 'ok');
result = applySlug(CODE, 'pl', store.productFields(CODE, ['pl']), 'zkouška');
check('adresa se odvodí i z dřív přeloženého názvu',
  seoUrl('pl') === 'bordowy-krawat-meski', `adresa: ${seoUrl('pl')}`);
check('a stará adresa taky do 301',
  redirect('pl') === '/p/bordo-panska-kravata', `301: ${redirect('pl')}`);

console.log(bad ? `\n${bad} věcí nesedí` : '\nadresa jde za názvem a stará se neztratí');
process.exit(bad ? 1 : 0);
