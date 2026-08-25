/**
 * Co se nedá přeložit, se musí říct nahlas.
 *
 * Přeložit jde jen to, co ve zdrojovém jazyce existuje. Pole bez českého
 * znění se do zadání pro model nedává — jenže dřív se i tak započítalo jako
 * hotový úkol a běh skončil hláškou „hotovo, 0 chyb", i když se nezměnilo
 * vůbec nic. Nejčastější případ je chybějící český SEO titulek: v seznamu
 * svítí „čeká na překlad", překlad proběhne, a je to pořád stejné.
 *
 * Zkouší se, že:
 *  - pole bez zdroje se nahlásí (`noSource`) i s názvem pole,
 *  - běh, kde je z čeho překládat, se chová beze změny,
 *  - a že se pole se zdrojem přeloží i tehdy, když je vedle něj jiné bez něj.
 *
 *   npx tsc -p tsconfig.main.json --outDir dist/ptdist
 *   node tools/ptrans/nosource-test.cjs
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { DatabaseSync } = require('node:sqlite');

const DIST = process.env.PTDIST || path.join(__dirname, '../../dist/ptdist/main');

const file = path.join(os.tmpdir(), 'ptrans-nosource.db');
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

const schemaSrc = fs.readFileSync(path.join(__dirname, '../../src/main/ptrans/schema.ts'), 'utf8');
for (const found of schemaSrc.matchAll(/`([\s\S]*?)`/g)) {
  if (!found[1].includes('CREATE TABLE')) continue;
  for (const statement of found[1].split(/;\s*\n/)) {
    if (statement.trim()) { try { db.exec(statement + ';'); } catch { /* rejstřík nad chybějícím sloupcem */ } }
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
shim('settings.js', { getSettings: () => ({ draftModel: 'x', brandPrompt: '' }), touchState: () => {} });

// Falešný model: vrátí JSON se stejnými klíči, jaké dostane
let asked = 0;
shim('ai.js', {
  ask: async (model, system, user) => {
    asked++;
    const payload = JSON.parse(user.slice(user.indexOf('{', user.indexOf('Texty k překladu:'))));
    const out = {};
    for (const [key, value] of Object.entries(payload)) out[key] = `[sk] ${value}`;
    return JSON.stringify(out);
  }
});
require.cache[require.resolve('electron')] = { id: 'electron', filename: 'electron', loaded: true,
  exports: { app: { getPath: () => os.tmpdir() }, BrowserWindow: { getAllWindows: () => [] }, dialog: {}, net: {} } };

const translate = require(path.join(DIST, 'ptrans/translate.js'));

let bad = 0;
const check = (label, ok, detail = '') => {
  if (!ok) bad++;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
};

const CODE = 'DKJL02P';
db.prepare("INSERT INTO ptrans_products (code, title, raw_xml) VALUES (?,?,'')")
  .run(CODE, 'Tmavě fialová dětská kravata');

const field = (name, value, source, state) => db.prepare(
  `INSERT INTO ptrans_fields (code, lang, field, value, source_value, state)
   VALUES (?,?,?,?,?,?)`
).run(CODE, 'sk', name, value, source, state);

// Přesně stav z feedu: český SEO titulek i popis chybí, název a popis jsou
field('title', 'Tmavě fialová dětská kravata', 'Tmavě fialová dětská kravata', 'same');
field('seo_title', '', '', 'missing');
field('seo_desc', '', '', 'missing');

console.log('pole bez českého znění:\n');

(async () => {
  const result = await translate.translateOne({
    code: CODE, lang: 'sk', fields: ['seo_title', 'seo_desc']
  });
  check('nehlásí se to jako hotové', result.saved === 0, JSON.stringify(result));
  check('řekne se, že chybí zdroj',
    (result.noSource ?? []).length === 2, JSON.stringify(result.noSource));
  check('a je v tom i jméno pole',
    /SEO titulek/.test(result.error ?? ''), result.error);
  check('model se kvůli tomu vůbec nevolal', asked === 0, `volání: ${asked}`);

  console.log('\nkdyž je z čeho překládat:\n');

  // `saved` může být víc než přeložených polí: k přeloženému názvu se rovnou
  // odvodí adresa a případné přesměrování
  const ok = await translate.translateOne({ code: CODE, lang: 'sk', fields: ['title'] });
  check('název se přeloží', ok.saved >= 1, JSON.stringify(ok));
  check('a nic se nehlásí jako chybějící', (ok.noSource ?? []).length === 0);

  // Smíšený případ: jedno pole se zdrojem, druhé bez něj. Přeložit se má to
  // první a to druhé se musí připomenout — ne zamlčet.
  const mixed = await translate.translateOne({
    code: CODE, lang: 'sk', fields: ['title', 'seo_title']
  });
  check('smíšený případ přeloží, co jde', mixed.saved === 1, JSON.stringify(mixed));
  check('a chybějící zdroj přesto připomene',
    (mixed.noSource ?? []).includes('seo_title'), JSON.stringify(mixed.noSource));

  console.log(bad
    ? `\n${bad} věcí nesedí`
    : '\nchybějící český text se nezamlčí');
  process.exit(bad ? 1 : 0);
})();
