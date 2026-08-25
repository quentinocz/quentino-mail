/**
 * Spuštění nad databází z minulé verze.
 *
 * Tohle je zkouška na chybu, kterou žádná jiná nechytí: všechny ostatní si
 * zakládají čistou databázi, kde schéma sedí samo se sebou. Skutečný uživatel
 * ale databázi z minulé verze má — a když se v ní zakládání schématu zadrhne,
 * aplikace se spustí a **neotevře okno**. Zvenku to vypadá, že se nestalo
 * vůbec nic.
 *
 * Konkrétní past: rejstřík (`CREATE INDEX`) napsaný rovnou k tabulce běží
 * dřív, než doplňující `ALTER TABLE ... ADD COLUMN`. V nové databázi sloupec
 * v tabulce je, takže se nic nestane; ve staré ještě není a `no such column`
 * shodí celou migraci. Rejstříky nad dodatečnými sloupci proto patří až za
 * ALTERy.
 *
 * Stará podoba databáze se **odvozuje ze současných zdrojů**, ne z gitu:
 * z každé `CREATE TABLE` se vyškrtnou sloupce, které se doplňují ALTERem —
 * a přesně to je stav před tím, než ALTERy vznikly. Díky tomu zkouška běží
 * všude stejně, i na čerstvě staženém repozitáři bez větví (což je přesně
 * případ sestavovacího stroje, kde se dřív tiše přeskakovala).
 *
 *   node tools/migrate-test.cjs
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');

/** Soubory se schématem — hlavní i ty, které si přidávají moduly. */
const SOURCES = [
  'src/main/db.ts',
  'src/main/instagram/schema.ts',
  'src/main/ptrans/schema.ts',
  'src/main/articles/schema.ts'
];

/**
 * Rozebere zdroj na dvě části v tom pořadí, v jakém je pouští aplikace:
 * nejdřív bloky se schématem, pak doplňující příkazy (ALTER i CREATE INDEX).
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
  const after = [...source.matchAll(/exec\((['"`])((?:ALTER TABLE|CREATE INDEX)[\s\S]*?)\1\)/g)]
    .map(found => found[2]);
  // Moduly si doplňky nesou v poli ALTERS — ty se pouštějí stejně
  for (const list of source.matchAll(/ALTERS[^=]*=\s*\[([\s\S]*?)\]/g)) {
    for (const item of list[1].matchAll(/(['"])((?:ALTER TABLE|CREATE INDEX)[\s\S]*?)\1/g)) {
      after.push(item[2]);
    }
  }
  return { blocks, after };
}

const blocks = [];
const after = [];
for (const file of SOURCES) {
  let source;
  try { source = fs.readFileSync(path.join(ROOT, file), 'utf8'); } catch { continue; }
  const piece = parts(source);
  blocks.push(...piece.blocks);
  after.push(...piece.after);
}

let bad = 0;
const check = (label, ok, detail = '') => {
  if (!ok) bad++;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
};

/** Sloupce, které se do tabulky doplňují až ALTERem — ve staré databázi nejsou. */
const added = new Map();
for (const statement of after) {
  const m = /ALTER TABLE\s+(\w+)\s+ADD COLUMN\s+(\w+)/i.exec(statement);
  if (!m) continue;
  const [, table, column] = m;
  if (!added.has(table)) added.set(table, new Set());
  added.get(table).add(column);
}

/**
 * Vyškrtne z `CREATE TABLE` sloupce doplňované ALTERem. Výsledek je tabulka
 * tak, jak vypadala předtím, než ty ALTERy vznikly.
 */
function ageBlock(block) {
  return block.replace(/CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\s*\);/g, (whole, table, body) => {
    const columns = added.get(table);
    if (!columns) return whole;
    const kept = body.split('\n').filter(line => {
      const name = /^\s*(\w+)\s/.exec(line);
      return !(name && columns.has(name[1]));
    });
    return `CREATE TABLE IF NOT EXISTS ${table} (${kept.join('\n')}\n    );`;
  });
}

console.log('databáze z minulé verze, spuštění současné:\n');

const file = path.join(os.tmpdir(), 'quentino-migrace.db');
fs.rmSync(file, { force: true });
const db = new DatabaseSync(file);

// 1) Databáze, jakou má člověk z minulé verze: tabulky bez dodatečných
//    sloupců, rejstříky nad nimi se pochopitelně nezakládají
let older = 0;
for (const block of blocks) {
  for (const statement of ageBlock(block).split(/;\s*\n/)) {
    if (!statement.trim()) continue;
    try { db.exec(statement + ';'); older++; } catch { /* rejstřík nad chybějícím sloupcem */ }
  }
}
check('stará podoba databáze se dá postavit', older > 0, `příkazů: ${older}`);
check('je z čeho stárnout — nějaké ALTERy existují', added.size > 0,
  `tabulek s doplňky: ${added.size}`);

// 2) A teď start nové verze — přesně jak to dělá aplikace: bloky se schématem
//    naostro (chyba shodí start), doplňky s tolerancí „už existuje"
let failure = '';
try {
  for (const block of blocks) db.exec(block);
} catch (e) {
  failure = e.message;
}
check('zakládání schématu projde', !failure, failure);

let afterFailure = '';
for (const statement of after) {
  try { db.exec(statement); } catch (e) {
    if (!/duplicate column|already exists/i.test(e.message)) {
      afterFailure ||= `${statement}\n        → ${e.message}`;
    }
  }
}
check('doplnění sloupců a rejstříků projde', !afterFailure, afterFailure);

// 3) A že se doplnilo, co se doplnit mělo
const columnsOf = table => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name));
const indexes = new Set(db.prepare(
  "SELECT name FROM sqlite_master WHERE type = 'index'"
).all().map(r => r.name));

let missing = '';
for (const [table, columns] of added) {
  const have = columnsOf(table);
  for (const column of columns) if (!have.has(column)) missing ||= `${table}.${column}`;
}
check('všechny dodatečné sloupce se doplnily', !missing, `chybí: ${missing}`);
check('rejstřík nad rezervacemi poukazů vznikl', indexes.has('idx_voucher_codes_claim'));

console.log(bad
  ? `\n${bad} věcí nesedí — aplikace by se nad starou databází nespustila`
  : '\naplikace se nad databází z minulé verze spustí');
process.exit(bad ? 1 : 0);
