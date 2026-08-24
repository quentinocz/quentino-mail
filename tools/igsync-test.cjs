/**
 * Sloučení publikací mezi zařízeními.
 *
 * Zkouška staví dvě samostatné databáze — „počítač" a „telefon" — pustí mezi
 * nimi synchronizaci přes sdílenou složku a kontroluje, že se dozví jeden
 * o druhém. Hlídá hlavně to, co by se dalo pokazit:
 *
 *  - publikace se nikdy neztratí (sjednocení, ne „novější vyhrává"),
 *  - při shodě platí dřívější čas, protože první publikace je ta pravá,
 *  - odkaz doplní ten, kdo ho má, i když druhý ho neměl,
 *  - trh, který vyšel, zmizí z rozpracovaných.
 *
 *   npx tsc -p tsconfig.main.json --outDir dist/ptdist
 *   node tools/igsync-test.cjs
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DIST = process.env.PTDIST || path.join(__dirname, '../dist/ptdist/main');
const FOLDER = '/tmp/igsync-slozka';

function open(file) {
  fs.rmSync(file, { force: true });
  const inner = new DatabaseSync(file);
  const norm = v => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
  return {
    exec: sql => inner.exec(sql),
    pragma: sql => inner.exec(`PRAGMA ${sql}`),
    prepare(sql) {
      const stmt = inner.prepare(sql);
      const call = (m, args) => stmt[m](...args.map(norm));
      return { run: (...a) => call('run', a), get: (...a) => call('get', a), all: (...a) => call('all', a) };
    },
    transaction: body => (...a) => { inner.exec('BEGIN'); try { const r = body(...a); inner.exec('COMMIT'); return r; } catch (e) { inner.exec('ROLLBACK'); throw e; } }
  };
}

/* Schéma se bere ze skutečných zdrojů, ne z ručního opisu. */
function schema() {
  let out = '';
  for (const file of ['../src/main/db.ts', '../src/main/instagram/schema.ts']) {
    const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
    let at = 0;
    for (;;) {
      const o = source.indexOf('`', at);
      if (o === -1) break;
      const c = source.indexOf('`', o + 1);
      if (c === -1) break;
      const body = source.slice(o + 1, c);
      if (body.includes('CREATE TABLE')) out += body + '\n';
      at = c + 1;
    }
    // Doplňkové sloupce z migrací — bez nich by tabulky vypadaly jako
    // při prvním vydání aplikace
    for (const found of source.matchAll(/exec\((['"`])(ALTER TABLE [\s\S]*?)\1\)/g)) {
      out += found[2] + ';\n';
    }
  }
  return out;
}

const SCHEMA = schema();
const devices = { pc: open('/tmp/igsync-pc.db'), phone: open('/tmp/igsync-phone.db') };
let active = 'pc';
for (const db of Object.values(devices)) {
  for (const statement of SCHEMA.split(/;\s*\n/)) {
    if (statement.trim()) { try { db.exec(statement + ';'); } catch { /* index nad chybějícím sloupcem */ } }
  }
}

const dbModule = require.resolve(path.join(DIST, 'db.js'));
require.cache[dbModule] = { id: dbModule, filename: dbModule, loaded: true, exports: {
  getDb: () => devices[active],
  getSetting: (key, fallback = null) => {
    const row = devices[active].prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : fallback;
  },
  setSetting: (key, value) => devices[active].prepare(
    'INSERT INTO settings(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value))
} };
require.cache[require.resolve('electron')] = { id: 'electron', filename: 'electron', loaded: true,
  exports: { app: { getPath: () => '/tmp' }, BrowserWindow: { getAllWindows: () => [] }, dialog: {}, net: {} } };

const store = require(path.join(DIST, 'instagram/store.js'));
const appsync = require(path.join(DIST, 'appsync.js'));

/* ---------- příprava ---------- */

fs.rmSync(FOLDER, { recursive: true, force: true });
fs.mkdirSync(FOLDER, { recursive: true });

// Oba znají tentýž zdrojový příspěvek — na Instagramu má stejné id, ale
// v každé databázi jiné číslo řádku. Právě proto se klíčuje podle id.
const on = (device, fn) => { active = device; return fn(); };
on('pc', () => devices.pc.prepare(
  `INSERT INTO ig_source_posts (id, ig_media_id, media_type, caption, posted_at)
   VALUES (7, 'IG_MEDIA_A', 'VIDEO', 'reels', '2026-08-20T10:00:00Z')`).run());
on('phone', () => devices.phone.prepare(
  `INSERT INTO ig_source_posts (id, ig_media_id, media_type, caption, posted_at)
   VALUES (41, 'IG_MEDIA_A', 'VIDEO', 'reels', '2026-08-20T10:00:00Z')`).run());

for (const device of ['pc', 'phone']) {
  on(device, () => {
    devices[device].prepare(
      "INSERT INTO settings(key, value) VALUES('syncFolder', ?)").run(FOLDER);
    devices[device].prepare(
      "INSERT INTO settings(key, value) VALUES('syncEnabled', '1')").run();
  });
}

/* ---------- co se stalo na kterém zařízení ---------- */

// Počítač: publikováno na němčinu, i s odkazem
on('pc', () => store.recordPublished({
  sourceMediaId: 'IG_MEDIA_A', lang: 'DE',
  at: '2026-08-24T09:00:00Z', permalink: 'https://instagram.com/p/de'
}));

// Telefon: tentýž trh, ale později a bez odkazu — plus vlastní trh navíc
on('phone', () => {
  store.recordPublished({ sourceMediaId: 'IG_MEDIA_A', lang: 'DE', at: '2026-08-24T18:00:00Z' });
  store.recordPublished({ sourceMediaId: 'IG_MEDIA_A', lang: 'PL', at: '2026-08-24T18:05:00Z' });
});

/* ---------- synchronizace tam a zpět ---------- */

const run = async device => { active = device; await appsync.runSync(); };

(async () => {
  await run('pc');     // počítač zapíše DE do složky
  await run('phone');  // telefon si DE převezme a přidá PL
  await run('pc');     // počítač si převezme PL

  const read = device => {
    active = device;
    return Object.fromEntries(store.listPublished().map(row => [row.lang, row]));
  };
  const pc = read('pc');
  const phone = read('phone');

  let bad = 0;
  const check = (label, ok, detail = '') => {
    if (!ok) bad++;
    console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
  };

  console.log('po synchronizaci:\n');
  check('počítač ví o polštině z telefonu', !!pc.PL, `má: ${Object.keys(pc).join(', ')}`);
  check('telefon ví o němčině z počítače', !!phone.DE, `má: ${Object.keys(phone).join(', ')}`);
  check('u němčiny platí dřívější čas',
    pc.DE?.at === '2026-08-24T09:00:00Z' && phone.DE?.at === '2026-08-24T09:00:00Z',
    `pc: ${pc.DE?.at}, telefon: ${phone.DE?.at}`);
  check('odkaz doplnil ten, kdo ho měl',
    phone.DE?.permalink === 'https://instagram.com/p/de',
    `telefon má: „${phone.DE?.permalink}"`);
  check('nic se neztratilo',
    Object.keys(pc).sort().join() === 'DE,PL' && Object.keys(phone).sort().join() === 'DE,PL');

  // Feed musí trh označit za hotový, i když si na tomhle zařízení nikdo
  // popisek nerozepsal — o to celé jde
  active = 'phone';
  const post = store.listSourcePosts(10)[0];
  check('feed na telefonu hlásí oba trhy jako hotové',
    post && ['DE', 'PL'].every(lang => post.done.includes(lang)),
    `hotovo: ${post?.done.join(', ')} · rozpracováno: ${post?.pending.join(', ')}`);
  check('hotový trh není zároveň rozpracovaný',
    post && !post.pending.some(lang => post.done.includes(lang)));

  console.log(bad ? `\n${bad} věcí nesedí` : '\npublikace se mezi zařízeními přenesou');
  process.exit(bad ? 1 : 0);
})();
