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

/*
 * Falešný model: vrátí JSON se stejnými klíči, jaké dostane.
 *
 * `failOnce` navíc nechá první dotaz na daný jazyk spadnout — přesně jak se
 * chová přetížené API. Podle toho se pozná, jestli aplikace zkusí znovu.
 */
let asked = 0;
let joint = 0;          // dotazů, které nesly víc jazyků najednou
let failNext = 0;       // kolik nejbližších dotazů má spadnout
let lastMaxTokens = 0;
/** Kolikrát má spadnout dotaz na konkrétní jazyk — na zkoušku, že se
 *  neopakuje i to, co už jednou vyšlo. */
let failLang = { lang: '', times: 0 };
const askedLangs = [];
shim('ai.js', {
  ask: async (model, system, user, maxTokens) => {
    asked++;
    if (failNext > 0) { failNext--; throw new Error('Overloaded'); }

    // SEO a Google texty se nepíšou v JSON, ale rovnou textem
    if (!/Texty k překladu/.test(user)) {
      return 'Doplněný český text pro e-shop — dost dlouhý na to, aby prošel limity.';
    }

    const payload = JSON.parse(user.slice(user.indexOf('{', user.indexOf('Texty k překladu'))));
    lastMaxTokens = maxTokens;
    // Věrné chování modelu: co se do stropu nevejde, se usekne
    if (JSON.stringify(payload).length / 2 > maxTokens) {
      const cut = new Error('Odpověď se nevešla do limitu'); cut.truncated = true; throw cut;
    }
    const single = /do jazyka „([a-z]{2,5})"/.exec(system)?.[1] ?? '';
    if (single) askedLangs.push(single);
    if (single && single === failLang.lang && failLang.times > 0) {
      failLang.times--;
      throw new Error('Overloaded');
    }

    const many = /do jazyků: (.+)\./.exec(system);
    if (many) {
      // Společný dotaz: odpověď je zabalená po jazycích
      joint++;
      const out = {};
      for (const [lang, fields] of Object.entries(payload)) {
        out[lang] = {};
        for (const [key, value] of Object.entries(fields)) out[lang][key] = `[${lang}] ${value}`;
      }
      return JSON.stringify(out);
    }
    const lang = /do jazyka „([a-z]{2,5})"/.exec(system)?.[1] ?? '';
    const out = {};
    for (const [key, value] of Object.entries(payload)) out[key] = `[${lang}] ${value}`;
    return JSON.stringify(out);
  },
  rateLimitedRecently: () => false
});
/*
 * Falešné okno, aby šlo číst, co se posílá do rozhraní. Bez něj by průběh
 * neměl kam odejít a nedal by se zkontrolovat pruh.
 */
const sent = [];
const fakeWindow = { webContents: { send: (channel, payload) => sent.push({ channel, payload }) } };
require.cache[require.resolve('electron')] = { id: 'electron', filename: 'electron', loaded: true,
  exports: {
    app: { getPath: () => os.tmpdir() },
    BrowserWindow: { getAllWindows: () => [fakeWindow] },
    dialog: {}, net: {}
  } };

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

  console.log('\nkdyž všechno klape:\n');

  // Produkt do dvou jazyků naráz — jeden dotaz místo dvou.
  const TWO = 'PKT23';
  db.prepare("INSERT INTO ptrans_products (code, title, raw_xml) VALUES (?,?,'')")
    .run(TWO, 'Bordó pánská kravata');
  for (const lang of ['sk', 'en']) {
    db.prepare(
      `INSERT INTO ptrans_fields (code, lang, field, value, source_value, state)
       VALUES (?,?,?,?,?,?)`
    ).run(TWO, lang, 'title', 'Bordó pánská kravata', 'Bordó pánská kravata', 'same');
  }

  const value = (code, lang) => db.prepare(
    "SELECT translated FROM ptrans_fields WHERE code = ? AND lang = ? AND field = 'title'"
  ).get(code, lang)?.translated ?? '';

  // Nejdřív bez potíží: dva jazyky mají stát jeden dotaz, ne dva
  asked = 0; joint = 0;
  let run = await translate.run({ codes: [TWO], langs: ['sk', 'en'], fillSource: false });
  check('dva jazyky = jeden dotaz', asked === 1 && joint === 1, `dotazů: ${asked}, společných: ${joint}`);
  check('a oba trhy jsou přeložené',
    value(TWO, 'sk').startsWith('[sk]') && value(TWO, 'en').startsWith('[en]'),
    `${value(TWO, 'sk')} / ${value(TWO, 'en')}`);
  check('běh je bez chyby', run.failed === 0, JSON.stringify(run));

  console.log('\nkdyž API selže:\n');

  // Druhý produkt, ale společný dotaz spadne. Nesmí to shodit oba trhy —
  // právě tohle dřív nechávalo jeden jazyk nepřeložený.
  const HARD = 'PKT99';
  db.prepare("INSERT INTO ptrans_products (code, title, raw_xml) VALUES (?,?,'')")
    .run(HARD, 'Modrá pánská kravata');
  for (const lang of ['sk', 'en']) {
    db.prepare(
      `INSERT INTO ptrans_fields (code, lang, field, value, source_value, state)
       VALUES (?,?,?,?,?,?)`
    ).run(HARD, lang, 'title', 'Modrá pánská kravata', 'Modrá pánská kravata', 'same');
  }

  asked = 0; joint = 0;
  failNext = 1;                       // společný dotaz se nepovede
  run = await translate.run({ codes: [HARD], langs: ['sk', 'en'], fillSource: false });
  check('po pádu společného dotazu se dotáhne slovenština',
    value(HARD, 'sk').startsWith('[sk]'), value(HARD, 'sk'));
  check('i angličtina', value(HARD, 'en').startsWith('[en]'), value(HARD, 'en'));
  check('a běh se netváří jako neúspěšný', run.failed === 0, JSON.stringify(run));

  console.log('\nkdyž selže i opakování:\n');

  const WORST = 'PKT98';
  db.prepare("INSERT INTO ptrans_products (code, title, raw_xml) VALUES (?,?,'')")
    .run(WORST, 'Zelená pánská kravata');
  db.prepare(
    `INSERT INTO ptrans_fields (code, lang, field, value, source_value, state)
     VALUES (?,?,?,?,?,?)`
  ).run(WORST, 'sk', 'title', 'Zelená pánská kravata', 'Zelená pánská kravata', 'same');

  failNext = 99;                      // nepovede se nic
  run = await translate.run({ codes: [WORST], langs: ['sk'], fillSource: false });
  failNext = 0;
  check('trvalý výpadek se přizná', run.failed > 0, JSON.stringify(run));
  check('a je u toho i důvod', /Overloaded/.test(run.errors[0] ?? ''), run.errors[0]);
  check('a je řečeno, co konkrétně zbylo',
    (run.stuck ?? []).some(text => text.startsWith(WORST)), JSON.stringify(run.stuck));

  console.log('\nkdyž neprojde jen jeden trh:\n');

  /*
   * Slovenština vyjde, angličtina napoprvé spadne.
   *
   * Dřív šel do opakování celý produkt: slovenština se přeložila podruhé,
   * což je zbytečné volání navíc přesně ve chvíli, kdy je API přetížené —
   * a v souhrnu to vypadalo na dvojnásobek chyb, než kolik jich bylo.
   */
  const HALF = 'PKT96';
  db.prepare("INSERT INTO ptrans_products (code, title, raw_xml) VALUES (?,?,'')")
    .run(HALF, 'Šedá pánská kravata');
  for (const lang of ['sk', 'en']) {
    db.prepare(
      `INSERT INTO ptrans_fields (code, lang, field, value, source_value, state)
       VALUES (?,?,?,?,?,?)`
    ).run(HALF, lang, 'title', 'Šedá pánská kravata', 'Šedá pánská kravata', 'same');
  }

  asked = 0; joint = 0; askedLangs.length = 0;
  failNext = 1;                      // společný dotaz spadne
  failLang = { lang: 'en', times: 1 };   // a angličtina napoprvé taky
  run = await translate.run({ codes: [HALF], langs: ['sk', 'en'], fillSource: false });
  failLang = { lang: '', times: 0 };
  check('oba trhy jsou nakonec přeložené',
    value(HALF, 'sk').startsWith('[sk]') && value(HALF, 'en').startsWith('[en]'),
    `${value(HALF, 'sk')} / ${value(HALF, 'en')}`);
  check('slovenština se nepřekládala podruhé',
    askedLangs.filter(l => l === 'sk').length === 1, askedLangs.join(','));
  check('a opakoval se jen ten trh, který spadl',
    askedLangs.filter(l => l === 'en').length === 2, askedLangs.join(','));
  check('běh se netváří jako neúspěšný', run.failed === 0, JSON.stringify(run));
  check('a nezbylo nic nehotového', (run.stuck ?? []).length === 0, JSON.stringify(run.stuck));

  console.log('\ndoplnění českých textů:\n');

  /*
   * Výchozí běh musí chybějící české SEO a Google texty napsat sám.
   *
   * Rozhraní dřív posílalo seznam polí, který se plnil až po dotazu do
   * databáze — kdo stiskl Přeložit dřív, spustil běh s prázdným seznamem
   * a nedoplnilo se nic. Vypadalo to, že volba nefunguje. Nevybrat pole
   * proto znamená „všechna, co jde", ne „nic".
   */
  const GAP = 'PKT94';
  db.prepare("INSERT INTO ptrans_products (code, title, raw_xml) VALUES (?,?,'')")
    .run(GAP, 'Hnědá pánská kravata');
  for (const lang of ['cz', 'sk']) {
    for (const [name, text] of [
      ['title', 'Hnědá pánská kravata'],
      ['long', '<p>Hnědá pánská kravata z bavlny, ručně šitá v Česku.</p>'],
      ['seo_title', ''],
      ['seo_desc', ''],
      ['google_title', ''],
      ['google_desc', '']
    ]) {
      db.prepare(
        `INSERT INTO ptrans_fields (code, lang, field, value, source_value, state)
         VALUES (?,?,?,?,?,?)`
      ).run(GAP, lang, name, lang === 'cz' ? text : text, text, text ? 'same' : 'missing');
    }
  }

  const czech = field => db.prepare(
    "SELECT translated, value FROM ptrans_fields WHERE code = ? AND lang = 'cz' AND field = ?"
  ).get(GAP, field);

  await translate.run({ codes: [GAP], langs: ['sk'], fillSource: true });
  check('český SEO titulek se doplnil sám',
    (czech('seo_title')?.translated ?? '').length > 10, JSON.stringify(czech('seo_title')));
  check('i meta popis',
    (czech('seo_desc')?.translated ?? '').length > 10, JSON.stringify(czech('seo_desc')));
  check('i Google titulek, i když se zrovna nepřekládá',
    (czech('google_title')?.translated ?? '').length > 10, JSON.stringify(czech('google_title')));
  check('i Google popis',
    (czech('google_desc')?.translated ?? '').length > 10, JSON.stringify(czech('google_desc')));

  console.log('\nprůběh:\n');

  /*
   * Pruh se dřív hýbal jen po dokončených produktech: u tří vybraných
   * produktů skákal po třetinách a mezi skoky se půl minuty nedělo nic.
   * Teď se do něj počítá i rozjeté volání, takže roste průběžně.
   */
  const BAR = 'PKT95';
  db.prepare("INSERT INTO ptrans_products (code, title, raw_xml) VALUES (?,?,'')")
    .run(BAR, 'Žlutá pánská kravata');
  for (const lang of ['sk', 'en']) {
    db.prepare(
      `INSERT INTO ptrans_fields (code, lang, field, value, source_value, state)
       VALUES (?,?,?,?,?,?)`
    ).run(BAR, lang, 'title', 'Žlutá pánská kravata', 'Žlutá pánská kravata', 'same');
  }

  sent.length = 0;
  run = await translate.run({ codes: [BAR], langs: ['sk', 'en'], fillSource: false });
  const bars = sent.filter(item => item.channel === 'ptrans:progress').map(item => item.payload.bar);
  check('pruh se hlásí', bars.length >= 2, JSON.stringify(bars));
  check('začíná na nule a končí na jedničce',
    bars[0] === 0 && bars[bars.length - 1] === 1, JSON.stringify(bars));
  check('a nikdy necouvne',
    bars.every((value, i) => i === 0 || value >= bars[i - 1]), JSON.stringify(bars));

  console.log('\nkdyž je popis obrovský:\n');

  // Popis o třiceti tisících znacích. Tři trhy v jednom dotazu by se do
  // odpovědi nevešly, takže se dávka musí rozdělit — jinak model odpověď
  // usekne a nepřeloží se nic.
  const HUGE = 'PKT97';
  const longText = '<p>' + 'Kravata z hedvábí. '.repeat(1500) + '</p>';
  db.prepare("INSERT INTO ptrans_products (code, title, raw_xml) VALUES (?,?,'')")
    .run(HUGE, 'Obří popis');
  for (const lang of ['sk', 'en']) {
    for (const [field, text] of [['title', 'Obří popis'], ['long', longText]]) {
      db.prepare(
        `INSERT INTO ptrans_fields (code, lang, field, value, source_value, state)
         VALUES (?,?,?,?,?,?)`
      ).run(HUGE, lang, field, text, text, 'same');
    }
  }

  asked = 0; joint = 0;
  run = await translate.run({ codes: [HUGE], langs: ['sk', 'en'], fillSource: false });
  const huge = lang => db.prepare(
    "SELECT translated FROM ptrans_fields WHERE code = ? AND lang = ? AND field = 'long'"
  ).get(HUGE, lang)?.translated ?? '';

  check('obří popis se nedává do společného dotazu', joint === 0, `společných: ${joint}`);
  check('a přesto se přeloží do obou trhů',
    huge('sk').startsWith('[sk]') && huge('en').startsWith('[en]'),
    `sk ${huge('sk').length} zn., en ${huge('en').length} zn.`);
  check('běh je bez chyby', run.failed === 0, JSON.stringify(run));
  check('strop odpovědi se zvedl podle délky', lastMaxTokens > 8000, `strop: ${lastMaxTokens}`);

  console.log(bad
    ? `\n${bad} věcí nesedí`
    : '\nchybějící český text se nezamlčí, chvilková chyba API nezůstane a dlouhý popis projde');
  process.exit(bad ? 1 : 0);
})();
