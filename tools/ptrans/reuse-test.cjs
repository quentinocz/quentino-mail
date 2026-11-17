/**
 * Paměť odstavců — co už přeložené je, se znovu neplatí.
 *
 * Sourozenci v e-shopu (kravata v deseti barvách) mají popisy shodné až na
 * větu o barvě. Zkouší se, že:
 *  - text, který celý známe, se přeloží bez modelu,
 *  - text, který známe z většiny, jde modelu se značkami a model dostane
 *    jen to, čím se produkt liší,
 *  - výsledek je **do písmene stejný**, jako kdyby se překládalo celé,
 *  - značku, kterou model zkazí, aplikace pozná a pole přeloží znovu celé,
 *  - „přeložit znovu" paměť obchází a ruční oprava má přednost,
 *  - ve společném dotazu dostane každý jazyk svoje názvosloví.
 *
 *   npx tsc -p tsconfig.main.json --outDir dist/ptdist
 *   node tools/ptrans/reuse-test.cjs
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { DatabaseSync } = require('node:sqlite');
const { smazDb } = require('../tmpdb.cjs');

const DIST = process.env.PTDIST || path.join(__dirname, '../../dist/ptdist/main');

const file = path.join(os.tmpdir(), 'ptrans-reuse.db');
smazDb(file);
const inner = new DatabaseSync(file);
const norm = v => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
const db = {
  exec: sql => inner.exec(sql),
  pragma: sql => inner.exec(`PRAGMA ${sql}`),
  prepare(sql) {
    const stmt = inner.prepare(sql);
    const call = (m, args) => {
      const params = args.length === 1 && args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])
        ? [Object.fromEntries(Object.entries(args[0]).map(([k, v]) => [k, norm(v)]))]
        : args.map(norm);
      return stmt[m](...params);
    };
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

const settings = new Map([['ptrans', JSON.stringify({ fields: { seo_url: false } })]]);
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

/*
 * Falešný model. Překládá po kouscích textu mezi značkami — stejný kousek
 * vždycky stejně — a značky ⟦n⟧ nechává být. Díky tomu se dá říct přesně,
 * jak má vypadat překlad celého textu, a porovnat ho s tím, co poskládala
 * paměť.
 */
const tr = (lang, text) => text.split(/(<[^>]*>|⟦\d+⟧)/)
  .map(part => (part.startsWith('<') || /^⟦\d+⟧$/.test(part) || !part.trim() ? part : `${lang.toUpperCase()}:${part}`))
  .join('');
let calls = 0;
let charsOut = 0;          // kolik textu musel model napsat (bez značek)
let breakSlots = 0;        // kolik odpovědí má značky zkazit
let lastUser = '';
const users = [];
shim('ai.js', {
  ask: async (model, system, user) => {
    calls++;
    lastUser = user;
    users.push(user);
    const payload = JSON.parse(user.slice(user.indexOf('{', user.indexOf('Texty k překladu'))));
    const many = /do jazyků: (.+)\./.exec(system);
    const one = (lang, fields) => {
      const out = {};
      for (const [key, value] of Object.entries(fields)) {
        let text = tr(lang, value);
        charsOut += text.replace(/<[^>]*>|⟦\d+⟧/g, '').length;
        if (breakSlots > 0 && /⟦\d+⟧/.test(text)) { breakSlots--; text = text.replace(/⟦\d+⟧/, ''); }
        out[key] = text;
      }
      return out;
    };
    if (many) {
      const out = {};
      for (const [lang, fields] of Object.entries(payload)) out[lang] = one(lang, fields);
      return JSON.stringify(out);
    }
    const lang = /do jazyka „([a-z]{2,5})"/.exec(system)?.[1] ?? '';
    return JSON.stringify(one(lang, payload));
  },
  rateLimitedRecently: () => false
});
require.cache[require.resolve('electron')] = { id: 'electron', filename: 'electron', loaded: true,
  exports: { app: { getPath: () => os.tmpdir() }, BrowserWindow: { getAllWindows: () => [] }, dialog: {}, net: {} } };

const translate = require(path.join(DIST, 'ptrans/translate.js'));
const reuse = require(path.join(DIST, 'ptrans/reuse.js'));
const { tidyHtml } = require(path.join(DIST, 'ptrans/html.js'));

let bad = 0;
const check = (label, ok, detail = '') => {
  if (!ok) bad++;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
};

/* ---------- rozklad na odstavce ---------- */
console.log('rozklad textu na odstavce:\n');
{
  const P = reuse.__test.pieces;
  const segs = text => P(text).filter(p => p.inner !== undefined).map(p => p.inner);
  check('odstavce a odrážky jsou každý zvlášť',
    JSON.stringify(segs('<p>Jedna <strong>věta</strong>.</p><ul><li>Dva</li><li>Tři</li></ul>'))
      === JSON.stringify(['Jedna <strong>věta</strong>.', 'Dva', 'Tři']));
  check('odstavec v odrážce se bere jako nejmenší blok',
    JSON.stringify(segs('<ul><li><p>Uvnitř</p></li></ul>')) === JSON.stringify(['Uvnitř']));
  check('text bez HTML je jeden kus', JSON.stringify(segs('Modrá kravata')) === JSON.stringify(['Modrá kravata']));
  const text = '<h2>Nadpis</h2>\n<p>A <a href="/x">odkaz</a></p>';
  check('složení zpátky dá přesně původní text', P(text).map(p => p.raw ?? p.inner).join('') === text);
}

/* ---------- sourozenci ---------- */

const PARAS = [
  'Pánská kravata z ručně tkaného hedvábí, které drží tvar i po celém dni v kanceláři.',
  'Šíře 7 cm sedí k běžným klopám saka i k úzkým střihům.',
  'Ručně šito v naší dílně v Česku, každý kus prochází kontrolou.',
  'Čistit pouze chemicky, nežehlit napřímo.'
];
const desc = color => `<p>Barva: ${color}, odstín vybraný ke společenským oblekům.</p>\n`
  + PARAS.map(p => `<p>${p}</p>`).join('\n');

function product(code, title, long) {
  db.prepare("INSERT INTO ptrans_products (code, title, category, raw_xml) VALUES (?,?,?,'')")
    .run(code, title, 'Kravaty');
  for (const lang of ['sk', 'en']) {
    const add = (field, text) => db.prepare(
      `INSERT INTO ptrans_fields (code, lang, field, value, source_value, state) VALUES (?,?,?,?,?,'same')`
    ).run(code, lang, field, text, text);
    add('title', title);
    add('long', long);
  }
}
const value = (code, lang, field) => db.prepare(
  'SELECT translated, model FROM ptrans_fields WHERE code = ? AND lang = ? AND field = ?'
).get(code, lang, field) ?? {};

product('KR-MODRA', 'Modrá pánská kravata', desc('modrá'));
product('KR-CERVENA', 'Červená pánská kravata', desc('červená'));
product('KR-MODRA2', 'Modrá pánská kravata', desc('modrá'));

(async () => {
  console.log('\nsourozenci se stejným popisem:\n');

  calls = 0; charsOut = 0;
  let run = await translate.run({ codes: ['KR-MODRA'], langs: ['sk', 'en'], fillSource: false });
  const firstChars = charsOut;
  check('první produkt se přeloží celý', run.failed === 0 && value('KR-MODRA', 'en', 'long').translated
    === tr('en', tidyHtml(desc('modrá'))), value('KR-MODRA', 'en', 'long').translated);

  calls = 0; charsOut = 0;
  run = await translate.run({ codes: ['KR-MODRA2'], langs: ['sk', 'en'], fillSource: false });
  check('stejný produkt podruhé: model se nevolá vůbec', calls === 0, `dotazů: ${calls}`);
  check('  a překlad je do písmene stejný',
    value('KR-MODRA2', 'sk', 'long').translated === value('KR-MODRA', 'sk', 'long').translated
    && value('KR-MODRA2', 'en', 'title').translated === value('KR-MODRA', 'en', 'title').translated);
  check('  v kartě je vidět, že je z paměti', value('KR-MODRA2', 'sk', 'long').model === translate.REUSE_MODEL,
    value('KR-MODRA2', 'sk', 'long').model);
  check('  a běh to hlásí', run.reused === 4 && run.failed === 0, JSON.stringify({ reused: run.reused, failed: run.failed }));

  console.log('\nsourozenec, který se liší barvou:\n');

  calls = 0; charsOut = 0;
  run = await translate.run({ codes: ['KR-CERVENA'], langs: ['sk', 'en'], fillSource: false });
  const expectSk = tr('sk', tidyHtml(desc('červená')));
  check('výsledek je stejný, jako kdyby se překládal celý', value('KR-CERVENA', 'sk', 'long').translated === expectSk,
    `${value('KR-CERVENA', 'sk', 'long').translated}\n        ≠ ${expectSk}`);
  check('model dostal hotové odstavce jako značky', /⟦1⟧/.test(lastUser) && !lastUser.includes('Šíře 7 cm sedí k běžným klopám saka i k úzkým střihům.</p>'));
  check(`model psal jen zlomek textu (${charsOut} z ${firstChars} znaků)`, charsOut < firstChars * 0.4);
  check('a běh je bez chyby', run.failed === 0, JSON.stringify(run.errors));

  console.log('\nkdyž model zkazí značku:\n');

  product('KR-ZELENA', 'Zelená pánská kravata', desc('zelená'));
  breakSlots = 1;
  run = await translate.run({ codes: ['KR-ZELENA'], langs: ['sk'], fillSource: false });
  check('pole s chybějící značkou se neuloží napůl a přeloží se znovu celé',
    value('KR-ZELENA', 'sk', 'long').translated === tr('sk', tidyHtml(desc('zelená'))),
    value('KR-ZELENA', 'sk', 'long').translated);
  check('  a běh skončí bez chyby', run.failed === 0, JSON.stringify(run.errors));

  console.log('\n„přeložit znovu" a ruční oprava:\n');

  calls = 0;
  await translate.run({ codes: ['KR-MODRA2'], langs: ['sk'], fillSource: false, force: true });
  check('„přeložit znovu" jde k modelu, ne do paměti', calls > 0, `dotazů: ${calls}`);

  const sentence = PARAS[1];
  reuse.learn('sk', 'long', `<p>${sentence}</p>`, '<p>Šírka 7 cm pasuje ku klopám (ručne opravené).</p>', true);
  reuse.learn('sk', 'long', `<p>${sentence}</p>`, '<p>Strojová verzia</p>', false);
  const found = reuse.lookup('sk', 'long', `<p>${sentence}</p>`);
  check('ruční oprava věty má přednost před dalším strojovým překladem',
    found?.full === '<p>Šírka 7 cm pasuje ku klopám (ručne opravené).</p>', found?.full);

  console.log('\nco se neučí:\n');

  check('dvojice s jinou stavbou se nepáruje (model spojil odstavce)',
    reuse.learn('en', 'long', '<p>Jedna věta tady.</p><p>Druhá věta tady.</p>', '<p>One sentence. Second sentence.</p>') === 0);
  check('dlouhá věta beze změny není překlad',
    reuse.learn('en', 'long', '<p>Tahle věta zůstala česky i v angličtině.</p>', '<p>Tahle věta zůstala česky i v angličtině.</p>') === 0);
  check('krátké shodné slovo se učí (slovenská „Kravata" je „Kravata")',
    reuse.learn('sk', 'title', 'Kravata', 'Kravata') === 1);
  check('název se nehledá mezi odstavci popisů',
    reuse.lookup('en', 'title', 'Čistit pouze chemicky, nežehlit napřímo.') === null);

  console.log('\nnázvosloví ve společném dotazu:\n');

  db.prepare(`INSERT INTO ptrans_memory (kind, lang, source, target, category, hits, confidence, origin, locked)
    VALUES ('term','sk','kšandy','traky','',5,1,'manual',1), ('term','en','kšandy','suspenders','',5,1,'manual',1)`).run();
  db.prepare("INSERT INTO ptrans_products (code, title, raw_xml) VALUES ('KS1','Kšandy','')").run();
  for (const lang of ['sk', 'en']) {
    db.prepare(`INSERT INTO ptrans_fields (code, lang, field, value, source_value, state)
      VALUES ('KS1',?, 'title', 'Černé kšandy s koženými poutky', 'Černé kšandy s koženými poutky', 'same')`).run(lang);
  }
  users.length = 0;
  await translate.run({ codes: ['KS1'], langs: ['sk', 'en'], fillSource: false });
  const joint = users.find(text => text.includes('po jazycích')) ?? '';
  check('angličtina dostane svoje „suspenders", ne slovenské „traky"',
    /\[en\][\s\S]*suspenders/.test(joint) && /\[sk\][\s\S]*traky/.test(joint), joint.slice(0, 400));

  console.log(bad ? `\n${bad} věcí nesedí` : '\nco už je přeložené, se znovu neplatí — a výsledek je stejný');
  process.exit(bad ? 1 : 0);
})();
