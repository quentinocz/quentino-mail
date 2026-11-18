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
const tr = (lang, text) => text.split(/(<[^>]*>|⟦\d+⟧|(?<=[.!?])\s+)/)
  .map(part => (part === undefined ? '' : part))
  .map(part => (part.startsWith('<') || /^⟦\d+⟧$/.test(part) || !part.trim() ? part : `${lang.toUpperCase()}:${part}`))
  .join('');
let liveCalls = 0;            // kolik dalších odpovědí má chodit po kouscích
let slowMs = 0;               // jak dlouho „model píše" každou odpověď
let inFlight = 0;
const timeline = [];          // kdy který pomalý dotaz běžel
let maxInFlight = 0;
let calls = 0;
let charsOut = 0;          // kolik textu musel model napsat (bez značek)
let breakSlots = 0;        // kolik odpovědí má značky zkazit
let lastUser = '';
const asksLog = [];             // dotazy i s jazykem
const users = [];
shim('ai.js', {
  ask: async (model, system, user, _max, options = {}) => {
    calls++;
    if (slowMs) {
      const started = Date.now();
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(r => setTimeout(r, slowMs));
      inFlight--;
      timeline.push({ user, started, ended: Date.now() });
    }
    lastUser = user;
    users.push(user);
    asksLog.push({ lang: /do jazyka „([a-z]{2,5})"/.exec(system)?.[1] ?? '', user });
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
    const answer = JSON.stringify(one(lang, payload));
    // Odpověď po kouscích, jak ji posílá API proudem
    if (liveCalls > 0 && options.onText) {
      liveCalls--;
      answering = true;
      // Skutečný model chvíli mlčí, než začne psát
      await new Promise(r => setTimeout(r, 700));
      for (const share of [0.2, 0.4, 0.6, 0.8]) {
        options.onText(answer.slice(0, Math.floor(answer.length * share)));
        await new Promise(r => setTimeout(r, 320));
      }
      options.onText(answer);
      answering = false;
    }
    return answer;
  },
  rateLimitedRecently: () => false
});
const sent = [];
let answering = false;          // model ještě píše odpověď
const fakeWindow = { webContents: { send: (channel, payload) => {
  // U hotového pole se hned podívá, jestli už je v databázi — a jestli model pořád píše
  if (channel === 'ptrans:field') {
    payload = { ...payload, answering, saved: db.prepare(
      'SELECT translated FROM ptrans_fields WHERE code = ? AND lang = ? AND field = ?'
    ).get(payload.code, payload.lang, payload.field)?.translated ?? null };
  }
  sent.push({ channel, payload });
} } };
require.cache[require.resolve('electron')] = { id: 'electron', filename: 'electron', loaded: true,
  exports: { app: { getPath: () => os.tmpdir() }, BrowserWindow: { getAllWindows: () => [fakeWindow] }, dialog: {}, net: {} } };

const translate = require(path.join(DIST, 'ptrans/translate.js'));
const reuse = require(path.join(DIST, 'ptrans/reuse.js'));
const { partialJson } = require(path.join(DIST, 'ptrans/partial.js'));
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

console.log('\nrozklad odstavce na věty:\n');
{
  const S = reuse.__test.sentences;
  const texts = inner => S(inner).map(one => one.text);
  check('věty se dělí za tečkou a velkým písmenem',
    JSON.stringify(texts('Modrá kravata. Šíře 7 cm. Ručně šito!')) === JSON.stringify(['Modrá kravata.', 'Šíře 7 cm.', 'Ručně šito!']));
  check('„např. modrá" větu nerozdělí', texts('Hodí se např. modrá nebo šedá.').length === 1);
  check('ani tečka uvnitř tučného písma',
    texts('<strong>Pozor. Nežehlit</strong> napřímo.').length === 1);
  check('složení zpátky dá přesně původní text',
    S('První věta. <em>Druhá</em> věta.').map(one => one.text + one.sep).join('') === 'První věta. <em>Druhá</em> věta.');
}

console.log('\nrozepsaná odpověď pro živý náhled:\n');
{
  check('hotové hodnoty celé, rozepsaná tak, jak je',
    JSON.stringify(partialJson('{"title": "Modrá", "long": "<p>Ručně ši')) === JSON.stringify({ title: 'Modrá', long: '<p>Ručně ši' }));
  check('i po jazycích', partialJson('{"sk": {"title": "Modrá"}, "en": {"title": "Blu')?.en?.title === 'Blu');
  check('rozepsaný escape se zahodí, hotový přeloží', partialJson('{"a": "x\\"y\\') .a === 'x"y');
  check('nesmysl nic neshodí', JSON.stringify(partialJson('Tady JSON není')) === '{}');
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

  console.log('\nvěty uvnitř odstavce:\n');

  const para = color => `<p>Pánská kravata v ${color} barvě, vybraná ke společenským oblekům. `
    + 'Vyrobena z hedvábí, které drží tvar i po celém dni. Šíře 7 cm sedí ke klopám.</p>';
  product('VT-MODRA', 'Kravata do kanceláře', para('modré'));
  product('VT-ZELENA', 'Kravata do kanceláře zelená', para('zelené'));
  await translate.run({ codes: ['VT-MODRA'], langs: ['sk'], fillSource: false });
  users.length = 0; charsOut = 0; liveCalls = 1; sent.length = 0;
  run = await translate.run({ codes: ['VT-ZELENA'], langs: ['sk'], fillSource: false });
  const asked = users.find(text => text.includes('Texty k překladu')) ?? '';
  check('stejné věty jdou jako značky, model píše jen větu o barvě',
    /⟦1⟧/.test(asked) && /⟦2⟧/.test(asked) && asked.includes('v zelené barvě') && !asked.includes('Šíře 7 cm sedí ke klopám.</p>'),
    asked.slice(-400));
  check('a výsledek je stejný, jako kdyby se překládal celý',
    value('VT-ZELENA', 'sk', 'long').translated === tr('sk', tidyHtml(para('zelené'))), value('VT-ZELENA', 'sk', 'long').translated);
  check('věta o barvě nejde strojově — model dostane podobnou hotovou jako vzor',
    /Podobné věty[\s\S]*v modré barvě[\s\S]*SK:Pánská kravata v modré barvě[\s\S]*teď: Pánská kravata v zelené barvě/.test(asked),
    asked.slice(asked.indexOf('Podobné'), asked.indexOf('Podobné') + 300));

  const marks = JSON.parse(db.prepare(
    "SELECT reuse_marks FROM ptrans_fields WHERE code = 'VT-ZELENA' AND lang = 'sk' AND field = 'long'").get().reuse_marks || '[]');
  check('uloží se, které věty jsou z paměti — na podbarvení v náhledu',
    marks.length === 2 && marks.every(mark => mark.b === 0) && marks.some(mark => mark.s.startsWith('SK:Vyrobena z hedvábí')),
    JSON.stringify(marks));
  const whole = JSON.parse(db.prepare(
    "SELECT reuse_marks FROM ptrans_fields WHERE code = 'KR-MODRA2' AND lang = 'en' AND field = 'long'").get().reuse_marks || '[]');
  check('  a u textu celého z paměti všechny odstavce', whole.length === 5, JSON.stringify(whole).slice(0, 200));

  console.log('\nprůběh běhu:\n');

  const progress = sent.filter(one => one.channel === 'ptrans:progress').map(one => one.payload).filter(p => p.running);
  const fieldsSeen = progress.flatMap(p => (p.current ?? []).flatMap(one => one.fields.filter(f => f.field === 'long')));
  check('je vidět pole, na kterém model právě píše, i kolik z něj už je',
    fieldsSeen.some(f => f.status === 'writing' && f.written > 0 && f.written < f.expected),
    JSON.stringify(fieldsSeen.map(f => `${f.status}:${f.written}/${f.expected}`)));
  check('  a hotové pole hned, i s ukázkou textu (hotové věty v ní dosazené)',
    progress.some(p => (p.current ?? []).some(one => one.fields.some(f => f.field === 'long' && f.status === 'done'
      && /SK:Pánská kravata v zelené/.test(f.preview ?? '') && /SK:Vyrobena/.test(f.preview ?? '')))),
    JSON.stringify(fieldsSeen.filter(f => f.status === 'done').map(f => f.preview)).slice(0, 300));
  check('  u pole je, kolik vět se dosadí z paměti',
    fieldsSeen.some(f => f.fromMemory === 2), JSON.stringify(fieldsSeen.map(f => f.fromMemory)));
  const bars = progress.map(p => p.bar);
  check('pruh roste podle napsaného textu, ne podle času',
    bars.some(v => v > 0.05 && v < 0.95) && bars.every((v, i) => i === 0 || v >= bars[i - 1] - 1e-9),
    bars.map(v => v.toFixed(2)).join(' '));
  check('  a odhad času se počítá', progress.every(p => Number.isFinite(p.etaSeconds)),
    progress.map(p => p.etaSeconds).join(' '));
  check('  čeká se na model → je to vidět jako „čeká na odpověď"',
    progress.some(p => (p.current ?? []).some(one => one.phase === 'waiting'))
    && progress.some(p => (p.current ?? []).some(one => one.phase === 'writing' && one.received > 0)));
  const early = sent.filter(one => one.channel === 'ptrans:field').map(one => one.payload);
  check('dopsané pole se uloží hned, ještě když model píše další',
    early.some(one => one.field === 'long' && one.answering && /SK:Pánská kravata v zelené/.test(one.saved ?? '')),
    JSON.stringify(early.map(one => [one.field, one.answering, (one.saved ?? '').slice(0, 20)])));
  check('  a uloží se jen jednou', early.filter(one => one.field === 'long').length === 1);
  const doneEvents = sent.filter(one => one.channel === 'ptrans:product').map(one => one.payload);
  check('hotový produkt se ohlásí hned — i s tím, co bylo z paměti a co podle vzoru',
    doneEvents.length === 1 && doneEvents[0].code === 'VT-ZELENA' && doneEvents[0].ok === true
    && doneEvents[0].sentences === 2 && doneEvents[0].patterned >= 1, JSON.stringify(doneEvents));
  const speed = JSON.parse(settings.get('ptrans') ?? '{}').speed;
  check('naměřená rychlost se uloží pro příští odhad', speed && speed.cps > 0 && speed.wait >= 0, JSON.stringify(speed));

  console.log('\nruční úprava:\n');

  db.prepare("UPDATE ptrans_fields SET reuse_marks = '[{\"b\":0,\"s\":\"x\"}]' WHERE code = 'VT-ZELENA' AND lang = 'sk' AND field = 'long'").run();
  require(path.join(DIST, 'ptrans/store.js')).saveTranslation('VT-ZELENA', 'sk', 'long', '<p>Ručně opraveno.</p>', 'ruční', true);
  check('po ruční opravě se podbarvení smaže — text je člověka',
    db.prepare("SELECT reuse_marks FROM ptrans_fields WHERE code = 'VT-ZELENA' AND lang = 'sk' AND field = 'long'").get().reuse_marks === '');

  console.log('\nskutečný popis kravaty ve dvou barvách (sk + en souběžně):\n');

  /*
   * Tvar, jaký mají popisy v e-shopu: nadpis s barvou, odstavec, kde barva
   * je jen v první větě, odrážky s parametry a odstavec o šití. U druhé
   * barvy má model dostat jen nadpis a jednu větu — zbytek je z paměti.
   */
  const popis = (barva, Barva) => `<h2>${Barva} pánská kravata</h2>\n`
    + `<p>Elegantní ${barva} kravata z mikrovlákna s jemným vzorem. Hodí se k tmavému obleku i ke světlé košili.</p>\n`
    + '<ul><li>Materiál: 100 % polyester</li><li>Šíře: 7 cm</li><li>Délka: 148 cm</li></ul>\n'
    + '<p>Kravata je ručně šitá v naší dílně v Česku. Dodáváme ji v dárkové krabičce.</p>';
  product('KR-BORDO', 'Bordó pánská kravata', popis('bordó', 'Bordó'));
  product('KR-NAVY', 'Tmavě modrá pánská kravata', popis('tmavě modrá', 'Tmavě modrá'));
  await translate.run({ codes: ['KR-BORDO'], langs: ['sk', 'en'], fillSource: false });
  users.length = 0; charsOut = 0; sent.length = 0; asksLog.length = 0;
  run = await translate.run({ codes: ['KR-NAVY'], langs: ['sk', 'en'], fillSource: false });
  // Každý jazyk a velké pole má vlastní dotaz — tady slovenský dlouhý popis
  const joint2 = asksLog.filter(one => one.lang === 'sk').map(one => one.user)
    .find(text => text.includes('"long"')) ?? '';
  for (const lang of ['sk', 'en']) {
    const got = value('KR-NAVY', lang, 'long').translated;
    check(`${lang}: výsledek je stejný, jako kdyby se překládal celý`, got === tr(lang, tidyHtml(popis('tmavě modrá', 'Tmavě modrá'))), got);
    const m = JSON.parse(db.prepare("SELECT reuse_marks FROM ptrans_fields WHERE code = 'KR-NAVY' AND lang = ? AND field = 'long'")
      .get(lang).reuse_marks || '[]');
    check(`${lang}: z paměti jsou odrážky, druhá věta i celý poslední odstavec`, m.length === 5
      && m.some(x => x.s.startsWith(`${lang.toUpperCase()}:Kravata je ručně šitá`)), JSON.stringify(m.map(x => x.s.slice(0, 22))));
  }
  check('model dostal jen nadpis a větu s barvou, obojí s hotovou podobnou jako vzorem',
    /Podobné věty/.test(joint2) && joint2.includes('Elegantní tmavě modrá kravata') && !joint2.includes('Dodáváme ji v dárkové krabičce.</p>'),
    joint2.slice(joint2.indexOf('Texty k překladu'), joint2.indexOf('Texty k překladu') + 500));
  const done2 = sent.filter(one => one.channel === 'ptrans:product').map(one => one.payload)[0];
  check('a hlášení o hotovém produktu to řekne', done2?.sentences === 10 && done2?.patterned >= 4, JSON.stringify(done2));

  console.log('\nnaučení z překladů, které už v e-shopu jsou:\n');

  /*
   * Produkt přeložený dřív v e-shopu (ne aplikací) — ve feedu je slovenský
   * text, aplikace ho nepřekládala. Po stažení feedu se z něj paměť naučí
   * a sourozenec dostane jeho věty, aniž by se cokoli překládalo předem.
   */
  const skPopis = barva => `<p>Elegantná ${barva} kravata pre pánov, ktorý sa nechcú vzdať štýlu. `
    + 'Je vhodná ako doplnok k obleku pre každú príležitosť.</p>';
  const czPopis = barva => `<p>Elegantní ${barva} kravata pro pány, kteří se nechtějí vzdát stylu. `
    + 'Je vhodná jako doplněk k obleku pro každou příležitost.</p>';
  db.prepare("INSERT INTO ptrans_products (code, title, category, raw_xml) VALUES ('FEED-1','Zelená kravata','Kravaty','')").run();
  db.prepare(`INSERT INTO ptrans_fields (code, lang, field, value, source_value, state) VALUES ('FEED-1','sk','long',?,?,'ok')`)
    .run(skPopis('zelená'), czPopis('zelená'));
  product('FEED-2', 'Žlutá kravata', czPopis('žlutá'));
  settings.set('ptransSyncedAt', new Date().toISOString());     // feed se právě stáhl
  users.length = 0;
  await translate.run({ codes: ['FEED-2'], langs: ['sk'], fillSource: false });
  const fromFeed = users.find(text => text.includes('Texty k překladu')) ?? '';
  check('věta z překladu, který už byl v e-shopu, se dosadí z paměti', /⟦1⟧/.test(fromFeed)
    && !fromFeed.includes('Je vhodná jako doplněk k obleku pro každou příležitost.</p>'), fromFeed.slice(-300));
  check('  a věta s barvou jde modelu podle slovenského vzoru',
    /Elegantná zelená kravata pre pánov/.test(fromFeed), fromFeed.slice(fromFeed.indexOf('Podobné'), fromFeed.indexOf('Podobné') + 260));

  console.log('\npopisy ve tvaru, jaký mají v e-shopu (KAPJL02P × KAPJL03):\n');

  /*
   * Zkrácené skutečné popisy dvou kapesníčků. Sourozenci se liší víc než
   * barvou: jiný výčet barev, jiné věty — stejné jsou dva odstavce ze šesti,
   * většina odrážek a začátek krátkého popisu. Dřív paměť nepoužila nic:
   * čtvrtina známého textu byla pod prahem, odrážky oddělené <br> se
   * nedělily na věty a krátký popis (holý text) se po větách nehledal.
   */
  const kap = (lem, jak, kratky) => ({
    long: `<p><strong>Bílý pánský kapesníček do saka s ${lem} – elegantní detail</strong></p>\n`
      + `<p>Elegantní bílý kapesníček do saka doplněný ${lem} je ideální volbou pro muže, kteří chtějí svůj outfit doladit do posledního detailu.</p>\n`
      + `<p>• Rozměry: 27 × 27 cm<br>• Bílý střed – matný z jedné strany, jemně lesklý z druhé strany<br>• Lem: ${lem}<br>• Dodáván v elegantní krabičce</p>\n`
      + '<p><strong>Proč nosit kapesníček do saka?</strong><br>Kapesníček do saka patří mezi nejoblíbenější pánské společenské doplňky. Dokáže oživit oblek a podtrhnout smysl pro detail.</p>\n'
      + `<p><strong>Jak sladit?</strong><br>${jak}</p>\n`
      + '<p><strong>Vyrobeno českou rodinnou značkou s důrazem na kvalitu a precizní zpracování.</strong></p>',
    short: kratky
  });
  const A = kap('tmavě fialovým lemem', 'Skvěle se kombinuje s motýlkem nebo kravatou v tmavě fialové barvě.',
    'Bílý pánský kapesníček do saka s tmavě fialovým lemem je elegantní doplněk k obleku na svatbu. Stylový kapesníček pro ženicha i svatební hosty.');
  const B = kap('tmavě modrým lemem s jemnými puntíky', 'Skvěle se kombinuje s tmavě modrou kravatou s jemnými puntíky, '
    + 'motýlkem nebo kšandami v tmavě modré barvě. Výborně ladí také s bílými, světle šedými a stříbrnými doplňky.',
    'Bílý pánský kapesníček do saka s tmavě modrým puntíkovaným lemem je elegantní doplněk k obleku na svatbu. Stylový kapesníček pro ženicha i svatební hosty.');
  const kapProduct = (code, title, texts) => {
    db.prepare("INSERT INTO ptrans_products (code, title, category, raw_xml) VALUES (?,?,?,'')").run(code, title, 'Kapesníčky');
    for (const lang of ['sk', 'en']) {
      for (const [field, text] of [['title', title], ['long', texts.long], ['short', texts.short]]) {
        db.prepare(`INSERT INTO ptrans_fields (code, lang, field, value, source_value, state) VALUES (?,?,?,?,?,'same')`)
          .run(code, lang, field, text, text);
      }
    }
  };
  kapProduct('KAP-A', 'Bílý kapesníček s fialovým lemem', A);
  kapProduct('KAP-B', 'Bílý kapesníček s modrým lemem', B);
  await translate.run({ codes: ['KAP-A'], langs: ['sk', 'en'], fillSource: false });
  // Kolik z dlouhého popisu znají celé odstavce — v e-shopu to byla čtvrtina
  {
    const blocks = reuse.__test.pieces(tidyHtml(B.long)).filter(p => p.inner !== undefined);
    const plainLen = t => t.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().length;
    const whole = blocks.filter(p => db.prepare('SELECT 1 FROM ptrans_segments WHERE lang = ? AND source = ? AND scope = ?')
      .get('sk', reuse.__test.normalize(p.inner), 'blok'));
    const share = whole.reduce((a, p) => a + plainLen(p.inner), 0) / blocks.reduce((a, p) => a + plainLen(p.inner), 0);
    check(`celé stejné odstavce tvoří jen ${Math.round(share * 100)} % textu — pod dřívějším prahem 30 %`, share < 0.3);
  }
  asksLog.length = 0;
  await translate.run({ codes: ['KAP-B'], langs: ['sk', 'en'], fillSource: false });
  const skLong = asksLog.find(one => one.lang === 'sk' && one.user.includes('"long"'))?.user ?? '';
  // Jen to, co model dostal k překladu — bez vysvětlivek ke značkám a vzorů
  const zadani = text => text.slice(text.indexOf('Texty k překladu'));
  const kapMarks = JSON.parse(db.prepare("SELECT reuse_marks FROM ptrans_fields WHERE code = 'KAP-B' AND lang = 'sk' AND field = 'long'").get().reuse_marks || '[]');
  check('celé stejné odstavce (Proč nosit…, Vyrobeno…) jsou z paměti, i když jsou jen čtvrtina textu',
    kapMarks.some(m => m.s.startsWith('SK:Proč nosit')) && kapMarks.some(m => m.s.startsWith('SK:Vyrobeno českou')),
    JSON.stringify(kapMarks.map(m => m.s.slice(0, 26))));
  check('  stejné odrážky oddělené <br> taky — model píše jen tu s lemem',
    kapMarks.some(m => m.s.startsWith('SK:• Rozměry')) && kapMarks.some(m => m.s.startsWith('SK:• Dodáván'))
    && zadani(skLong).includes('• Lem: tmavě modrým lemem s jemnými puntíky') && !zadani(skLong).includes('• Rozměry: 27 × 27 cm'),
    skLong.slice(skLong.indexOf('Texty k překladu'), skLong.indexOf('Texty k překladu') + 400));
  check('  a výsledek je stejný, jako kdyby se překládal celý',
    value('KAP-B', 'sk', 'long').translated === tr('sk', tidyHtml(B.long)), value('KAP-B', 'sk', 'long').translated);
  const skShort = asksLog.find(one => one.lang === 'sk' && one.user.includes('"short"'))?.user ?? '';
  const shortJson = (JSON.parse(zadani(skShort).slice(zadani(skShort).indexOf('{'))).short ?? '');
  check('krátký popis (holý text bez odstavců) se pamatuje po větách',
    /⟦\d+⟧/.test(shortJson) && !shortJson.includes('Stylový kapesníček pro ženicha i svatební hosty.'),
    skShort.slice(skShort.indexOf('Texty k překladu'), skShort.indexOf('Texty k překladu') + 300));
  check('věta, která se liší víc než jedním slovem, dostane podobnou jako vzor',
    /Podobné věty[\s\S]*Elegantní bílý kapesníček do saka doplněný tmavě fialovým lemem/.test(skLong),
    skLong.slice(skLong.indexOf('Podobné'), skLong.indexOf('Podobné') + 200));

  console.log('\njazyky a velká pole souběžně:\n');

  kapProduct('KAP-C', 'Bílý kapesníček s červeným lemem', kap('červeným lemem', 'Hodí se k šedému obleku.',
    'Úplně jiný krátký popis, aby nebyl v paměti.'));
  db.prepare("DELETE FROM ptrans_segments").run();
  db.prepare("DELETE FROM ptrans_seg_index").run();
  slowMs = 400; maxInFlight = 0; calls = 0;
  const startedAt = Date.now();
  await translate.run({ codes: ['KAP-C'], langs: ['sk', 'en'], fillSource: false });
  const took = Date.now() - startedAt;
  slowMs = 0;
  check('slovenština a angličtina se píšou naráz', maxInFlight === 2 && calls === 2,
    `dotazů ${calls}, naráz nejvýš ${maxInFlight}`);
  check('  takže produkt trvá jako jeden dotaz, ne jako dva za sebou', took < 400 * 2, `${took} ms`);

  // Dlouhý popis jako ve skutečnosti (přes tisíc znaků) dostane vlastní dotaz
  const dlouhy = kap('zeleným lemem', 'Hodí se k šedému obleku. ' + 'Doplňuje oblek na svatbu i ples a dodá mu barevný akcent. '.repeat(12),
    'Další jiný krátký popis.');
  kapProduct('KAP-D', 'Bílý kapesníček se zeleným lemem', dlouhy);
  db.prepare("DELETE FROM ptrans_segments").run();
  slowMs = 400; maxInFlight = 0; calls = 0;
  await translate.run({ codes: ['KAP-D'], langs: ['sk', 'en'], fillSource: false });
  slowMs = 0;
  check('dlouhý popis má vlastní dotaz, i ten běží naráz s ostatními', calls === 4 && maxInFlight === 4,
    `dotazů ${calls}, naráz nejvýš ${maxInFlight}`);

  console.log('\nsourozenci v jednom běhu se souběžností:\n');

  /*
   * Víc produktů v jednom běhu, souběžnost 3. Sourozenci (stejná kategorie,
   * stejná písmena kódu) nesmí jít naráz — druhý by neměl z čeho brát.
   */
  settings.set('ptrans', JSON.stringify({ ...JSON.parse(settings.get('ptrans')), concurrency: 3 }));
  for (const [code, cat] of [['AAA1', 'Aa'], ['BBB1', 'Bb'], ['CCC1', 'Cc'], ['DDD1', 'Dd']]) {
    db.prepare("INSERT INTO ptrans_products (code, title, category, raw_xml) VALUES (?,?,?,'')").run(code, `Jiný produkt ${code}`, cat);
    db.prepare(`INSERT INTO ptrans_fields (code, lang, field, value, source_value, state) VALUES (?,?,?,?,?,'same')`)
      .run(code, 'sk', 'title', `Jiný produkt ${code}`, `Jiný produkt ${code}`);
  }
  const sib = (code, lem) => {
    const text = kap(lem, 'Hodí se k obleku.', 'Krátký popis ' + code + '.');
    db.prepare("INSERT INTO ptrans_products (code, title, category, raw_xml) VALUES (?,?,?,'')").run(code, `Kapesníček ${code}`, 'Zz');
    db.prepare(`INSERT INTO ptrans_fields (code, lang, field, value, source_value, state) VALUES (?,?,?,?,?,'same')`)
      .run(code, 'sk', 'long', text.long, text.long);
  };
  sib('SOUR01', 'žlutým lemem');
  sib('SOUR02', 'oranžovým lemem');
  slowMs = 700; maxInFlight = 0;
  await translate.run({ codes: ['AAA1', 'BBB1', 'CCC1', 'SOUR01', 'SOUR02'], langs: ['sk'], fillSource: false });
  slowMs = 0;
  const sibMarks = JSON.parse(db.prepare("SELECT reuse_marks FROM ptrans_fields WHERE code = 'SOUR02' AND lang = 'sk' AND field = 'long'").get().reuse_marks || '[]');
  const first = timeline.find(one => one.user.includes('žlutým lemem'));
  const second = timeline.find(one => one.user.includes('oranžovým lemem'));
  check('sourozenci šli po sobě, i když byly volné dva pruhy', first && second && second.started >= first.ended,
    first && second ? `první ${first.started}–${first.ended}, druhý od ${second.started}` : 'chybí dotaz');
  check('  a druhý proto bere z prvního', sibMarks.some(m => m.s.startsWith('SK:Proč nosit')),
    JSON.stringify(sibMarks.map(m => m.s.slice(0, 20))));

  console.log('\nnázvosloví po jazycích:\n');

  db.prepare(`INSERT INTO ptrans_memory (kind, lang, source, target, category, hits, confidence, origin, locked)
    VALUES ('term','sk','kšandy','traky','',5,1,'manual',1), ('term','en','kšandy','suspenders','',5,1,'manual',1)`).run();
  db.prepare("INSERT INTO ptrans_products (code, title, raw_xml) VALUES ('KS1','Kšandy','')").run();
  for (const lang of ['sk', 'en']) {
    db.prepare(`INSERT INTO ptrans_fields (code, lang, field, value, source_value, state)
      VALUES ('KS1',?, 'title', 'Černé kšandy s koženými poutky', 'Černé kšandy s koženými poutky', 'same')`).run(lang);
  }
  users.length = 0; asksLog.length = 0;
  await translate.run({ codes: ['KS1'], langs: ['sk', 'en'], fillSource: false });
  const enAsk = asksLog.filter(one => one.lang === 'en' && one.user.includes('kšandy')).map(one => one.user).join('\n');
  const skAsk = asksLog.filter(one => one.lang === 'sk' && one.user.includes('kšandy')).map(one => one.user).join('\n');
  check('angličtina dostane svoje „suspenders", ne slovenské „traky"',
    /suspenders/.test(enAsk) && !/traky/.test(enAsk) && /traky/.test(skAsk), enAsk.slice(0, 400));

  console.log(bad ? `\n${bad} věcí nesedí` : '\nco už je přeložené, se znovu neplatí — a výsledek je stejný');
  process.exit(bad ? 1 : 0);
})();
