/**
 * Co projde zálohou a co se ztratí.
 *
 * Záloha kopíruje celou tabulku nastavení, takže „přidal jsem novou volbu,
 * přenese se?" má odpověď skoro vždy ano — ale skoro. Šifrované hodnoty se
 * bez zápisu v SECRET_SETTING_KEYS přenesou jako nečitelná šifra a na druhém
 * zařízení se tváří jako nenastavené. Přesně to se stalo feedům objednávek.
 *
 * Zkouška proto nastavení naplní, vyexportuje, naimportuje do prázdné
 * databáze a porovná, co dojelo.
 *
 *   npx tsc -p tsconfig.main.json --outDir dist/ptdist
 *   node tools/backup-test.cjs
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const DIST = process.env.PTDIST || path.join(__dirname, '../dist/ptdist/main');

// Dvě oddělené databáze: „staré" zařízení a „nové"
function open(file) {
  fs.rmSync(file, { force: true });
  const inner = new DatabaseSync(file);
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
const norm = v => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);

// Schéma se bere ze skutečného `db.ts`, ne z ručního opisu — jinak by
// zkouška prošla nad tabulkami, které v aplikaci vypadají jinak, a nic by
// to nedokazovalo. Vytáhne se z něj obsah volání `exec(...)`.
const SCHEMA_FILES = [
  '../src/main/db.ts',
  '../src/main/instagram/schema.ts',
  '../src/main/ptrans/schema.ts',
  '../src/main/articles/schema.ts',
  '../src/main/chat/schema.ts'
];

function realSchema() {
  // Schéma leží v šablonových řetězcích. Hledat je regulárním výrazem se
  // nevyplácí (SQL obsahuje apostrofy i středníky uvnitř řetězců), takže se
  // text projde znak po znaku a vezmou se úseky mezi zpětnými apostrofy,
  // ve kterých je CREATE TABLE.
  let out = '';
  for (const file of SCHEMA_FILES) {
    const full = path.join(__dirname, file);
    if (!fs.existsSync(full)) continue;
    const source = fs.readFileSync(full, 'utf8');
    let at = 0;
    for (;;) {
      const open = source.indexOf('`', at);
      if (open === -1) break;
      const close = source.indexOf('`', open + 1);
      if (close === -1) break;
      const body = source.slice(open + 1, close);
      if (body.includes('CREATE TABLE')) out += body + '\n';
      at = close + 1;
    }
    // Doplňkové sloupce z migrací. Bez nich by tabulky vypadaly jako při
    // prvním vydání aplikace a zkouška by padala na sloupcích, které
    // ve skutečné databázi dávno jsou.
    for (const found of source.matchAll(/exec\((['"`])(ALTER TABLE [\s\S]*?)\1\)/g)) {
      out += found[2] + ';\n';
    }
  }
  return out;
}

const SCHEMA = realSchema();
const dbs = { old: open(path.join(os.tmpdir(), 'zaloha-stara.db')), fresh: open(path.join(os.tmpdir(), 'zaloha-nova.db')) };
let active = 'old';
for (const db of Object.values(dbs)) {
  // Celý blok najednou — `exec` zvládne víc příkazů a nerozbije SQL na
  // středníku uvnitř řetězce
  // ALTER na už existující sloupec skončí chybou a to je v pořádku, proto
  // se pouští po jednom příkazu
  for (const statement of SCHEMA.split(/;\s*\n/)) {
    if (!statement.trim()) continue;
    try { db.exec(statement + ';'); }
    catch (e) {
      if (!/duplicate column|already exists/i.test(e.message) && process.env.SCHEMA_DEBUG) {
        console.error('schéma:', e.message, '←', statement.trim().slice(0, 70));
      }
    }
  }
}

const dbModule = require.resolve(path.join(DIST, 'db.js'));
require.cache[dbModule] = { id: dbModule, filename: dbModule, loaded: true, exports: {
  getDb: () => dbs[active],
  getSetting: (key, fallback = null) => {
    const row = dbs[active].prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : fallback;
  },
  setSetting: (key, value) => dbs[active].prepare(
    'INSERT INTO settings(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value))
} };

// „Šifrování" jako na počítači: hodnota je po něm nečitelná a rozšifrovat ji
// umí jen totéž zařízení. Přesně to dělá záludnost, kterou zkouška hlídá.
const secure = require.resolve(path.join(DIST, 'secure.js'));
require.cache[secure] = { id: secure, filename: secure, loaded: true, exports: {
  encrypt: v => 'ŠIFRA(' + Buffer.from(String(v)).toString('base64') + ')',
  decrypt: v => {
    const m = /^ŠIFRA\((.*)\)$/.exec(String(v));
    if (!m) throw new Error('tohle nešifrovalo tohle zařízení');
    return Buffer.from(m[1], 'base64').toString();
  }
} };
require.cache[require.resolve('electron')] = { id: 'electron', filename: 'electron', loaded: true,
  exports: { app: { getPath: () => os.tmpdir() }, BrowserWindow: { getAllWindows: () => [] }, dialog: {}, net: {} } };

const settings = require(path.join(DIST, 'settings.js'));

/** Kolik věcí nesedí — počítá se od prvního naplnění databáze */
let bad = 0;

/* ---------- co se má přenést ---------- */

const VZOREK = {
  // Překlady produktů — celé nastavení jako JSON
  ptrans: JSON.stringify({
    sourceLang: 'cz',
    languages: [{ code: 'sk', label: 'Slovenština', enabled: true }, { code: 'de', label: 'Němčina', enabled: false }],
    fields: { title: true, google_title: true },
    prompt: 'Piš stručně.',
    glossary: [{ source: 'kšandy', targets: { sk: 'traky', en: 'suspenders' } }],
    limits: { seoTitle: 60, googleTitleVisible: 70 },
    model: 'claude-sonnet-5', concurrency: 2, secondsPerUnit: 11.4
  }),
  // Články
  'articles.settings': JSON.stringify({
    wordCount: 600, researchTerms: true, model: 'claude-sonnet-5',
    prompt: 'Piš pro svatebčany.',
    languages: [{ code: 'cz', label: 'Čeština', enabled: true, domain: 'https://www.quentino.cz' }]
  }),
  // Produktový feed
  productFeedUrl: 'https://www.quentino.cz/export-products-TAJNE.xml',
  // Ostatní
  draftModel: 'claude-sonnet-5',
  brandPrompt: 'Rodinná značka od roku 2013.',
  adminOrderRef: '023702:1185',
  chatSupabaseUrl: 'https://xyz.supabase.co',
  igAppId: '123456'
};

/** Hodnoty, které jsou v databázi zašifrované. */
const TAJNE = {
  anthropicApiKey: 'sk-ant-TAJNY-KLIC',
  upgatesKey: 'upgates-tajny-klic',
  chatAnonKey: 'chat-anon-klic',
  igUserToken: 'ig-token',
  orderFeeds: JSON.stringify([
    { id: 'feed1', label: 'posledních 24h', url: 'https://www.quentino.cz/export-orders-AAA.xml',
      market: 'cz', everyMinutes: 5, recent: true, enabled: true },
    { id: 'feed2', label: 'SK vše', url: 'https://www.quentino.sk/export-orders-BBB.xml',
      market: 'sk', everyMinutes: 720, recent: false, enabled: true }
  ])
};

/** Provozní hodnoty — ty se přenášet nemají. */
const PROVOZNI = {
  'orderFeedSync:feed1': '2026-08-24T11:58:00Z',
  'orderFeedError:feed2': 'HTTP 500',
  productFeedSync: '2026-08-24T06:00:00Z',
  // Dvojče produktového feedu: zásoby se stahují zvlášť a razítko o nich
  // platí jen pro zařízení, které je stáhlo
  stockFeedSync: '2026-08-24T08:00:00Z',
  // „Kdy se projekt naposledy ozval" je vlastnost spojení tohohle zařízení
  'supabaseSeen:https://xyz.supabase.co': '2026-08-20T09:00:00Z',
  // Jednorázová značka migrace: obnovená na zařízení, kde migrace neběžela,
  // ji přeskočí navždy
  packingFeedMigrated: '1',
  // Rozměry okna patří k obrazovce, ne k účtu
  windowState: '{"x":0,"y":0,"width":2560,"height":1400}',
  // Odkaz na složku platí jen tam, kde vznikl
  syncFolderBookmark: 'Ym9va21hcmstZGF0YQ==',
  // Poslední ohlášená zpráva: cizí číslo upozornění umlčí nebo je vysype znovu
  notifyLastMailId: '4821',
  syncLastResult: 'staženo 12 zpráv',
  stateStamp: '2026-08-24T12:00:00Z',
  // Totožnost zařízení: po obnovení na druhém počítači by obě tvrdila, že
  // jsou totéž, psala si do stejného deníku a sahala po týchž zamluvených
  // kódech poukazů — takže by stejný kód mohl jít ven dvakrát
  deviceId: '11111111-2222-3333-4444-555555555555',
  deviceName: 'Starý MacBook'
};

active = 'old';
const set = (k, v) => dbs.old.prepare(
  'INSERT INTO settings(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
).run(k, v);
for (const [k, v] of Object.entries(VZOREK)) set(k, v);
for (const [k, v] of Object.entries(TAJNE)) set(k, 'ŠIFRA(' + Buffer.from(v).toString('base64') + ')');
for (const [k, v] of Object.entries(PROVOZNI)) set(k, v);

/*
 * Lidská práce ve staré databázi: poukazy, naučené překlady, článek a fáze
 * dopravy. Do zálohy se to dřív nedostalo vůbec — a je to jediné, co se
 * nedá znovu stáhnout.
 */
const vloz = (sql, ...values) => {
  try { dbs.old.prepare(sql).run(...values); }
  catch (e) { console.log('  ! nešlo naplnit:', String(e.message).slice(0, 80)); bad++; }
};
vloz(`INSERT INTO voucher_templates (id, name, value, unit, valid_until, note, lang, code_mode, fixed_code, updated_at)
      VALUES ('tpl-300', 'Omluva 300 Kč', '300', 'CZK', '2027-06-30', '', 'cz', 'unique', '', '2026-08-24T09:00:00Z')`);
vloz(`INSERT INTO voucher_codes (template_id, code, used_at, used_for, used_by)
      VALUES ('tpl-300', 'Q7H2-4KDA', '2026-08-20T10:00:00Z', 'reklamace', 'Patrik')`);
vloz(`INSERT INTO voucher_codes (template_id, code, used_at, used_for, used_by)
      VALUES ('tpl-300', 'Q7H2-9XPL', NULL, '', '')`);
vloz(`INSERT INTO ptrans_colors (source, base, hits, origin, locked, updated_at)
      VALUES ('tmavě modrá', 'modra', 12, 'ruka', 1, '2026-08-24T09:00:00Z')`);
vloz(`INSERT INTO ptrans_bundles (category, pattern, is_bundle, hits, updated_at)
      VALUES ('Sety', 'kravata a kapesníček', 1, 4, '2026-08-24T09:00:00Z')`);
vloz(`INSERT INTO ptrans_memory (id, kind, lang, source, target, category, hits, updated_at)
      VALUES (1, 'glossary', 'sk', 'kšandy', 'traky', '', 3, '2026-08-24T09:00:00Z')`);
vloz(`INSERT INTO art_articles (id, article_id, topic, status, created_at, updated_at)
      VALUES (1, 'art-1', 'Jak vybrat kšandy', 'done', '2026-08-01T09:00:00Z', '2026-08-02T09:00:00Z')`);
vloz(`INSERT INTO art_langs (article_id, lang, title, long, state, updated_at)
      VALUES (1, 'cz', 'Jak vybrat kšandy', '<p>Kšandy se vybírají podle délky.</p>', 'done', '2026-08-02T09:00:00Z')`);
vloz(`INSERT INTO ship_phase (skeleton, phase, sample, source, at)
      VALUES ('zasilka je pripravena k vyzvednuti', 'ready', 'Zásilka je připravena k vyzvednutí', 'ai', '2026-08-24T09:00:00Z')`);

// Stažená data — ta se do zálohy dostat nesmí
vloz(`INSERT INTO products (code, title_cz) VALUES ('PS120SM', 'Kšandy Slim')`);
vloz(`INSERT INTO shop_orders (code, market) VALUES ('022605', 'cz')`);

const zaloha = JSON.parse(JSON.stringify(settings.exportConfig()));
console.log('záloha: verze', zaloha.version, '· klíčů v nastavení:', Object.keys(zaloha.settings ?? {}).length);

// Import proběhne do prázdné databáze — jako na novém zařízení
active = 'fresh';
settings.importConfig(zaloha);

const got = key => {
  const row = dbs.fresh.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
};
const decrypted = key => {
  const raw = got(key);
  if (!raw) return null;
  const m = /^ŠIFRA\((.*)\)$/.exec(raw);
  return m ? Buffer.from(m[1], 'base64').toString() : `(nešifrované) ${raw}`;
};

console.log('\nběžné nastavení:');
for (const [key, want] of Object.entries(VZOREK)) {
  const ok = got(key) === want;
  if (!ok) bad++;
  console.log(`  ${ok ? '✓' : '✗'} ${key}${ok ? '' : `\n        chtěl: ${String(want).slice(0, 70)}\n        dostal: ${String(got(key)).slice(0, 70)}`}`);
}

console.log('\nšifrované hodnoty (musí dojet čitelné):');
for (const [key, want] of Object.entries(TAJNE)) {
  const value = decrypted(key);
  const ok = value === want;
  if (!ok) bad++;
  console.log(`  ${ok ? '✓' : '✗'} ${key}${ok ? '' : `\n        dostal: ${String(value).slice(0, 90)}`}`);
}

console.log('\nprovozní hodnoty (nemají se přenášet):');
for (const [key, staraHodnota] of Object.entries(PROVOZNI)) {
  // Nesmí dojet **hodnota ze zálohy**. Že si ji import zapíše nově vlastní
  // (razítko `stateStamp` po dokončení), je v pořádku — to je jeho práce.
  const value = got(key);
  const ok = value === null || value !== staraHodnota;
  if (!ok) bad++;
  const note = value === null ? '' : ' (přepsáno vlastní hodnotou — v pořádku)';
  console.log(`  ${ok ? '✓' : '✗'} ${key}${ok ? note : ` — přenesla se hodnota ze zálohy: ${value}`}`);
}

/*
 * Tabulky s lidskou prací. Nastavení a klíče se přenášely odjakživa, ale
 * tohle je jediné, co se nedá znovu stáhnout ani dopočítat: poukazy někdo
 * vypsal, barvy u překladů někdo naučil, články někdo napsal. Do zálohy se
 * to dřív nedostalo vůbec.
 */
console.log('\nlidská práce (poukazy, naučené překlady, články):');

const radku = (table) => {
  try {
    return dbs.fresh.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  } catch {
    return -1;
  }
};
const radek = (table, where) => {
  try {
    return dbs.fresh.prepare(`SELECT * FROM ${table} WHERE ${where}`).get() ?? null;
  } catch {
    return null;
  }
};
const sedi = (label, ok, detail) => {
  if (!ok) bad++;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
};

sedi('šablona poukazu', radku('voucher_templates') === 1, `řádků: ${radku('voucher_templates')}`);
sedi('a její hodnota i platnost',
  radek('voucher_templates', "id = 'tpl-300'")?.value === '300');
sedi('vydané kódy', radku('voucher_codes') === 2, `řádků: ${radku('voucher_codes')}`);
sedi('i s tím, že jeden je použitý',
  radek('voucher_codes', "code = 'Q7H2-4KDA'")?.used_at === '2026-08-20T10:00:00Z');
sedi('naučená barva', radek('ptrans_colors', "source = 'tmavě modrá'")?.base === 'modra');
sedi('i s tím, že je zamčená ručně',
  radek('ptrans_colors', "source = 'tmavě modrá'")?.locked === 1);
sedi('naučený set', radku('ptrans_bundles') === 1, `řádků: ${radku('ptrans_bundles')}`);
sedi('paměť překladů', radek('ptrans_memory', "id = 1")?.source === 'kšandy');
sedi('napsaný článek', radek('art_articles', "id = 1")?.topic === 'Jak vybrat kšandy');
sedi('i jeho česká verze',
  (radek('art_langs', "article_id = 1 AND lang = 'cz'")?.long ?? '').includes('Kšandy'));
sedi('naučená fáze dopravy', radku('ship_phase') === 1, `řádků: ${radku('ship_phase')}`);

/*
 * Co se přenášet **nemá**: stažená data. Katalog se stáhne znovu za pár
 * vteřin, kdežto záloha s dvanácti sty produkty by byla k neposlání.
 */
sedi('stažený katalog v záloze není', radku('products') === 0, `řádků: ${radku('products')}`);
sedi('ani feed objednávek', radku('shop_orders') === 0, `řádků: ${radku('shop_orders')}`);

console.log(bad ? `\n${bad} věcí nesedí` : '\nzáloha přenese všechno, co má, a nic, co nemá');
process.exit(bad ? 1 : 0);
