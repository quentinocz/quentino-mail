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
  'src/main/articles/schema.ts',
  'src/main/shoot/store.ts'
];

/**
 * Projde zdroj znak po znaku a vytáhne z něj obsah šablonových řetězců
 * (`…`), přičemž ví, co je komentář a co řetězec.
 *
 * Dřív se jen hledal první a druhý apostrof zpětný — jenže zpětné
 * apostrofy jsou i v komentářích (`CREATE TABLE IF NOT EXISTS` v poznámce
 * u focení) a od té chvíle se páruje všechno o jeden posunuté. Schéma
 * instagramu se tím z celé zkoušky vytratilo a past se sloupcem plan_at
 * zůstala neodhalená, dokud nad ní nespadla aplikace na počítači.
 *
 * Vrací i zdroj bez komentářů — podle něj se pak ověřuje, že se žádná
 * tabulka po cestě neztratila.
 */
function scan(source) {
  const bodies = [];
  let bare = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      i = end === -1 ? source.length : end;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < source.length && source[j] !== ch) j += source[j] === '\\' ? 2 : 1;
      bare += source.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === '`') {
      let j = i + 1;
      while (j < source.length && source[j] !== '`') j += source[j] === '\\' ? 2 : 1;
      const body = source.slice(i + 1, j);
      bodies.push(body);
      bare += '`' + body + '`';
      i = j + 1;
      continue;
    }
    bare += ch;
    i += 1;
  }
  return { bodies, bare };
}

/**
 * Rozebere zdroj na dvě části v tom pořadí, v jakém je pouští aplikace:
 * nejdřív bloky se schématem, pak doplňující příkazy (ALTER i CREATE INDEX).
 */
function parts(source) {
  const { bodies, bare } = scan(source);
  // Blok se schématem musí obsahovat opravdový `CREATE TABLE … ( … )`,
  // ne jen zmínku — jinak by se jako SQL pouštěl kus věty.
  const blocks = bodies.filter(body => /CREATE TABLE[\s\S]*\([\s\S]*\)/.test(body));
  const tables = s => (s.match(/CREATE TABLE IF NOT EXISTS/g) || []).length;
  // Pojistka na samotné rozebírání: kolik tabulek je ve zdroji, tolik jich
  // musí být i v nalezených blocích. Kdyby se rozebírání zase rozešlo,
  // je to vidět hned tady, a ne až na cizím počítači.
  const ztraceno = tables(bare) - blocks.reduce((sum, b) => sum + tables(b), 0);
  const after = [...bare.matchAll(/exec\((['"`])((?:ALTER TABLE|CREATE INDEX)[\s\S]*?)\1\)/g)]
    .map(found => found[2]);
  /*
   * Moduly si doplňky nesou v poli, které se jmenuje ALTERS nebo třeba
   * igAlters. Dřív se hledalo jen velké ALTERS — a právě proto tahle
   * zkouška prošla i ve chvíli, kdy instagramový modul zakládal rejstřík
   * nad sloupcem plan_at, který u starších databází ještě neexistoval.
   * Sloupce z igAlters se nevyškrtly, stará databáze se postavila i s nimi
   * a past se neukázala. Proto se teď bere každý název končící na „lters".
   */
  for (const list of bare.matchAll(/[A-Za-z]*(?:ALTERS|Alters)[^=]*=\s*\[([\s\S]*?)\]/g)) {
    for (const item of list[1].matchAll(/(['"])((?:ALTER TABLE|CREATE INDEX)[\s\S]*?)\1/g)) {
      after.push(item[2]);
    }
  }
  return { blocks, after, ztraceno };
}

const blocks = [];
const after = [];
let ztraceno = 0;
const chybi = [];
for (const file of SOURCES) {
  let source;
  try { source = fs.readFileSync(path.join(ROOT, file), 'utf8'); } catch { chybi.push(file); continue; }
  const piece = parts(source);
  blocks.push(...piece.blocks);
  after.push(...piece.after);
  ztraceno += piece.ztraceno;
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
    /*
     * Když byl vyškrtnutý sloupec poslední, zůstane za tím předchozím
     * čárka a SQLite skončí na „near )". Čárka se proto maže u poslední
     * skutečné řádky — komentáře a prázdné řádky se přeskakují.
     */
    for (let i = kept.length - 1; i >= 0; i--) {
      const line = kept[i].trim();
      if (!line || line.startsWith('--')) continue;
      kept[i] = kept[i].replace(/,\s*$/, '');
      break;
    }
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
let starePotize = '';
for (const block of blocks) {
  /*
   * Komentáře se před rozdělením vyhodí. Středník na konci věty
   * v komentáři („vyhrává novější; bez razítka…") jinak rozsekne
   * CREATE TABLE v půlce a SQLite hlásí „incomplete input" — chybu,
   * která ve skutečnosti nikde není: aplikace pouští celý blok naráz.
   */
  const bezPoznamek = ageBlock(block).replace(/^\s*--.*$/gm, '');
  for (const statement of bezPoznamek.split(/;\s*\n/)) {
    if (!statement.trim()) continue;
    try { db.exec(statement + ';'); older++; } catch (e) {
      /*
       * Tolerovat se smí jediné: rejstřík nad sloupcem, který se ve staré
       * databázi teprve doplní. Cokoli jiného znamená, že se tabulka
       * nezaložila — a zkouška by pak nad neexistující tabulkou „prošla",
       * aniž by cokoli ověřila. Přesně takhle prošlo schéma instagramu.
       */
      if (/no such column/i.test(e.message)) continue;
      starePotize ||= `${statement.trim().slice(0, 90)}\n        → ${e.message}`;
    }
  }
}
check('stará podoba databáze se dá postavit', older > 0 && !starePotize, starePotize || `příkazů: ${older}`);
check('žádná tabulka se při rozebírání zdrojů neztratila', ztraceno === 0,
  `mimo bloky zůstalo tabulek: ${ztraceno}`);
check('všechny zdroje se schématem se našly', chybi.length === 0, `chybí: ${chybi.join(', ')}`);
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
// Rejstřík plánovače — ten, kvůli kterému se aplikace nad starou databází
// neotevřela. Musí vzniknout, a to až po doplnění sloupce.
check('rejstřík nad plánem příspěvků vznikl', indexes.has('idx_ig_posts_plan'));
check('plánovací sloupce v ig_posts jsou', ['plan_at', 'plan_kind', 'plan_idea', 'plan_code']
  .every(c => columnsOf('ig_posts').has(c)));

console.log(bad
  ? `\n${bad} věcí nesedí — aplikace by se nad starou databází nespustila`
  : '\naplikace se nad databází z minulé verze spustí');
process.exit(bad ? 1 : 0);
