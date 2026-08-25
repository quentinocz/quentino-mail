/**
 * Zkouška překladové vrstvy nad skutečným feedem — bez Electronu.
 *
 * `src/main/db.ts` si otevírá databázi v uživatelské složce Electronu, což
 * mimo aplikaci nejde. Modul se proto podstrčí přes require.cache a zbytek
 * kódu běží nezměněný.
 *
 *   npx tsc -p tsconfig.main.json --outDir /tmp/ptdist
 *   node tools/ptrans/harness.cjs <feed.xml>
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
// V kontejneru se nedá přeložit nativní better-sqlite3 (stažení hlaviček Node
// je blokované), takže se použije vestavěné node:sqlite a tenká náhrada
// rozhraní. Aplikace samotná běží dál na better-sqlite3 — testuje se logika,
// ne ovladač.
const { DatabaseSync } = require('node:sqlite');

function open(file) {
  const inner = new DatabaseSync(file);
  return {
    exec: sql => inner.exec(sql),
    pragma: sql => inner.exec(`PRAGMA ${sql}`),
    prepare(sql) {
      const stmt = inner.prepare(sql);
      const call = (method, args) => {
        const params = args.length === 1 && args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])
          ? [normalize(args[0])]
          : args.map(value => normalize(value));
        return stmt[method](...params);
      };
      return {
        run: (...args) => call('run', args),
        get: (...args) => call('get', args),
        all: (...args) => call('all', args)
      };
    },
    transaction(body) {
      return (...args) => {
        inner.exec('BEGIN');
        try {
          const out = body(...args);
          inner.exec('COMMIT');
          return out;
        } catch (error) {
          inner.exec('ROLLBACK');
          throw error;
        }
      };
    }
  };
}

/** node:sqlite nebere boolean ani undefined, better-sqlite3 ano */
function normalize(value) {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
    const out = {};
    for (const [key, entry] of Object.entries(value)) out[key] = normalize(entry);
    return out;
  }
  return value;
}

const DIST = process.env.PTDIST || path.join(__dirname, '../../dist/ptdist/main');
const dbFile = process.env.PTRANS_DB || path.join(os.tmpdir(), 'ptrans-test.db');
if (!process.env.PTRANS_KEEP) fs.rmSync(dbFile, { force: true });
const db = open(dbFile);
db.pragma('journal_mode = WAL');
db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');

const dbModulePath = require.resolve(path.join(DIST, 'db.js'));
require.cache[dbModulePath] = {
  id: dbModulePath, filename: dbModulePath, loaded: true, exports: {
    getDb: () => db,
    getSetting: (key, fallback = null) => {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
      return row ? row.value : fallback;
    },
    setSetting: (key, value) => db.prepare(
      'INSERT INTO settings(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run(key, String(value))
  }
};

// Electron mimo aplikaci není — stačí prázdné okno a dialog
const electronStub = {
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  dialog: { showSaveDialog: async () => ({ canceled: true }) },
  app: { getPath: () => os.tmpdir() }
};
require.cache[require.resolve('electron')] = {
  id: 'electron', filename: 'electron', loaded: true, exports: electronStub
};

const store = require(path.join(DIST, 'ptrans/store.js'));
const xml = require(path.join(DIST, 'ptrans/xml.js'));
const detect = require(path.join(DIST, 'ptrans/detect.js'));
db.exec(store.SCHEMA);

module.exports = { db, store, xml, detect, DIST, dbFile };

if (require.main === module) {
  const file = process.argv[2] || '/home/claude/feed.xml';
  const feed = fs.readFileSync(file, 'utf8');

  console.time('sync');
  const result = store.syncFromFeed(feed);
  console.timeEnd('sync');
  console.log('produktů:', result.products, '· polí:', result.fields, '· smazáno:', result.removed);

  console.log('\nstav po jazycích:');
  for (const row of store.summary()) {
    console.log(' ', row.lang, '→ čeká', row.todo, 'z', row.total, JSON.stringify(row.byState));
  }

  const page = store.listProducts({ state: 'todo', limit: 5 });
  console.log('\nprodukty s prací (celkem', page.total + '):');
  for (const row of page.rows) {
    const states = Object.entries(row.states).map(([l, s]) => `${l}:${s.todo}/${s.total}`).join(' ');
    console.log('  •', row.code, row.title.slice(0, 46).padEnd(46), states);
  }
}
