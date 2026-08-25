/**
 * Spuštění nad databází z minulé verze.
 *
 * Tohle je zkouška na chybu, kterou žádná jiná nechytí: všechny ostatní si
 * zakládají čistou databázi, takže v ní nová verze schématu sedí sama se
 * sebou. Skutečný uživatel ale databázi z minulé verze má — a když se v ní
 * zakládání schématu zadrhne, aplikace se spustí a **neotevře okno**. Zvenku
 * to vypadá, že se nestalo vůbec nic.
 *
 * Konkrétní past: rejstřík (`CREATE INDEX`) napsaný rovnou k tabulce běží
 * dřív, než doplňující `ALTER TABLE ... ADD COLUMN`. V nové databázi sloupec
 * v tabulce je, takže se nic nestane; ve staré ještě není a `no such column`
 * shodí celou migraci. Rejstříky nad dodatečnými sloupci proto patří až za
 * ALTERy.
 *
 * Zkouška si starou podobu schématu bere z gitu (`origin/main`), takže se
 * drží skutečnosti a není co ručně udržovat.
 *
 *   node tools/migrate-test.cjs
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const BASE = process.env.MIGRATE_BASE || 'origin/main';

/** Soubory se schématem — hlavní i ty, které si přidávají moduly. */
const SOURCES = [
  'src/main/db.ts',
  'src/main/instagram/schema.ts',
  'src/main/ptrans/schema.ts',
  'src/main/articles/schema.ts'
];

/**
 * Rozebere zdroj na dvě části v tom pořadí, v jakém je pouští aplikace:
 * nejdřív bloky se schématem, pak doplňující ALTERy.
 */
function parts(source) {
  const blocks = [];
  let at = 0;
  for (;;) {
    const open = source.indexOf('`', at);
    if (open === -1) break;
    const close = source.indexOf('`', open + 1);
    if (close === -1) break;
    const body = source.slice(open + 1, close);
    if (body.includes('CREATE TABLE')) blocks.push(body);
    at = close + 1;
  }
  const alters = [...source.matchAll(/exec\((['"`])((?:ALTER TABLE|CREATE INDEX)[\s\S]*?)\1\)/g)]
    .map(found => found[2]);
  return { blocks, alters };
}

function collect(read) {
  const blocks = [];
  const alters = [];
  for (const file of SOURCES) {
    const source = read(file);
    if (source === null) continue;   // soubor v té verzi ještě neexistoval
    const piece = parts(source);
    blocks.push(...piece.blocks);
    alters.push(...piece.alters);
  }
  return { blocks, alters };
}

const older = collect(file => {
  try { return execSync(`git show ${BASE}:${file}`, { cwd: ROOT }).toString(); }
  catch { return null; }
});
const current = collect(file => {
  try { return fs.readFileSync(path.join(ROOT, file), 'utf8'); }
  catch { return null; }
});

if (!older.blocks.length) {
  console.log(`Nelze načíst schéma z ${BASE} — zkouška se přeskakuje.`);
  process.exit(0);
}

const file = '/tmp/quentino-migrace.db';
fs.rmSync(file, { force: true });
const db = new DatabaseSync(file);

// 1) Databáze, jakou má člověk z minulé verze
for (const block of older.blocks) db.exec(block);
for (const alter of older.alters) { try { db.exec(alter); } catch { /* už tam je */ } }

// 2) A teď start nové verze — přesně tak, jak to dělá aplikace: bloky se
//    schématem naostro (chyba shodí start), ALTERy s tolerancí „už existuje"
let bad = 0;
const check = (label, ok, detail = '') => {
  if (!ok) bad++;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
};

console.log(`databáze z ${BASE}, spuštění současné verze:\n`);

let failure = '';
try {
  for (const block of current.blocks) db.exec(block);
} catch (e) {
  failure = e.message;
}
check('zakládání schématu projde', !failure, failure);

let alterFailure = '';
for (const alter of current.alters) {
  try { db.exec(alter); } catch (e) {
    // „duplicate column" je v pořádku, cokoli jiného ne
    if (!/duplicate column|already exists/i.test(e.message)) alterFailure ||= `${alter}\n        → ${e.message}`;
  }
}
check('doplnění sloupců a rejstříků projde', !alterFailure, alterFailure);

// 3) A že se doplnilo, co se doplnit mělo
const columns = table => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name));
const indexes = new Set(db.prepare(
  "SELECT name FROM sqlite_master WHERE type = 'index'"
).all().map(r => r.name));

const voucher = columns('voucher_codes');
check('poukazy mají sloupce pro rezervaci a kolize',
  ['used_by', 'claimed_by', 'claimed_at', 'used_dup'].every(c => voucher.has(c)),
  `má: ${[...voucher].join(', ')}`);
check('rejstřík nad rezervacemi vznikl', indexes.has('idx_voucher_codes_claim'));

console.log(bad
  ? `\n${bad} věcí nesedí — aplikace by se nad starou databází nespustila`
  : '\naplikace se nad databází z minulé verze spustí');
process.exit(bad ? 1 : 0);
