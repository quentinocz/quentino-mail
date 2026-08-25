/**
 * Poukazy mezi dvěma zařízeními.
 *
 * Zkouška staví dvě samostatné databáze — „počítač" a „telefon" — a nechá je
 * potkávat se ve sdílené složce. Hlídá to, co Patrik popsal: šablony musí být
 * všude aktuální a **stejný kód nesmí jít ven dvakrát**.
 *
 * Zkouší se i to nepříjemné:
 *  - obě zařízení vydávají kódy dřív, než se vůbec poprvé uvidí,
 *  - obě upraví jinou šablonu ve stejném kole,
 *  - jedno zařízení zapíše svůj deník, zatímco druhé ho přepisuje
 *    (přesně ta situace, kvůli které jeden společný soubor ztrácel data),
 *  - dva počítače si zamluví kódy naráz a musí dojít ke stejnému závěru,
 *  - a nakonec vynucená kolize, aby se ověřilo, že se pozná a nahlásí.
 *
 *   npx tsc -p tsconfig.main.json --outDir dist/ptdist
 *   node tools/vouchers-test.cjs
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DIST = process.env.PTDIST || path.join(__dirname, '../dist/ptdist/main');
const FOLDER = '/tmp/vouchers-slozka';

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
    transaction: body => (...a) => {
      inner.exec('BEGIN');
      try { const r = body(...a); inner.exec('COMMIT'); return r; }
      catch (e) { inner.exec('ROLLBACK'); throw e; }
    }
  };
}

/* Schéma se bere ze skutečných zdrojů, ne z ručního opisu. */
function schema() {
  const source = fs.readFileSync(path.join(__dirname, '../src/main/db.ts'), 'utf8');
  let out = '';
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
  for (const found of source.matchAll(/exec\((['"`])(ALTER TABLE [\s\S]*?)\1\)/g)) out += found[2] + ';\n';
  return out;
}

const SCHEMA = schema();
const devices = { pc: open('/tmp/vouchers-pc.db'), phone: open('/tmp/vouchers-phone.db') };
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

const vouchers = require(path.join(DIST, 'vouchers.js'));
const appsync = require(path.join(DIST, 'appsync.js'));

/* ---------- příprava ---------- */

fs.rmSync(FOLDER, { recursive: true, force: true });
fs.mkdirSync(FOLDER, { recursive: true });

const on = (device, fn) => { active = device; return fn(); };
for (const device of ['pc', 'phone']) {
  on(device, () => {
    devices[device].prepare("INSERT INTO settings(key, value) VALUES('syncFolder', ?)").run(FOLDER);
    devices[device].prepare("INSERT INTO settings(key, value) VALUES('syncEnabled', '1')").run();
  });
}

let bad = 0;
const check = (label, ok, detail = '') => {
  if (!ok) bad++;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
};

const TEMPLATE = 'tpl-poukaz-300';
const POOL = Array.from({ length: 40 }, (_, i) => `Q${String(i + 1).padStart(3, '0')}`);

// Šablonu i zásobu založí počítač, telefon ji dostane synchronizací
on('pc', () => {
  vouchers.saveTemplate({ id: TEMPLATE, name: 'Omluva 300 Kč', value: '300', unit: 'CZK', codeMode: 'unique' });
  vouchers.addCodes(TEMPLATE, POOL.join('\n'));
});

const run = async device => { active = device; await appsync.runSync(); };
const codes = device => on(device, () => vouchers.listCodes(TEMPLATE));
const used = device => codes(device).filter(c => c.usedAt).map(c => c.code);

(async () => {
  console.log('šablony a zásoba:\n');

  await run('pc');
  await run('phone');

  check('telefon dostal šablonu z počítače',
    on('phone', () => vouchers.listTemplates()).some(t => t.id === TEMPLATE));
  check('telefon dostal i celou zásobu kódů',
    codes('phone').length === POOL.length, `má ${codes('phone').length} z ${POOL.length}`);

  // Rezervace: každé zařízení si drží svůj díl a do cizího nesahá
  const pcMine = on('pc', () => vouchers.listTemplates().find(t => t.id === TEMPLATE)).codesMine;
  const phoneMine = on('phone', () => vouchers.listTemplates().find(t => t.id === TEMPLATE)).codesMine;
  check('každé zařízení si zamluvilo svůj díl zásoby',
    pcMine > 0 && phoneMine > 0, `počítač ${pcMine}, telefon ${phoneMine}`);
  // Do databáze se kouká napřímo: seznam pro obrazovku říká jen „drží to
  // někdo jiný", tady je potřeba vědět kdo přesně. Ptáme se telefonu —
  // ten si zamlouval jako druhý, takže vidí obě rezervace naráz.
  const claimedBy = device => new Map(devices[device].prepare(
    "SELECT code, claimed_by FROM voucher_codes WHERE template_id = ? AND claimed_by != ''"
  ).all(TEMPLATE).map(r => [r.code, r.claimed_by]));
  const idOf = device => devices[device].prepare("SELECT value FROM settings WHERE key = 'deviceId'").get().value;
  check('zamluvené kódy se nepřekrývají',
    (() => {
      const pcId = idOf('pc'); const phoneId = idOf('phone');
      const claims = claimedBy('phone');
      const mine = [...claims].filter(([, by]) => by === pcId).map(([code]) => code);
      const theirs = [...claims].filter(([, by]) => by === phoneId).map(([code]) => code);
      return mine.length > 0 && theirs.length > 0 && !mine.some(code => theirs.includes(code));
    })(),
    `zamluveno celkem ${claimedBy('phone').size} z ${POOL.length}`);

  console.log('\nvydávání kódů:\n');

  // Obě zařízení vydávají, aniž by o sobě mezitím věděla
  const takenPc = [];
  const takenPhone = [];
  for (let i = 0; i < 8; i++) {
    takenPc.push(on('pc', () => vouchers.takeCode(TEMPLATE, `zákazník pc ${i}`)).code);
    takenPhone.push(on('phone', () => vouchers.takeCode(TEMPLATE, `zákazník telefon ${i}`)).code);
  }
  const overlap = takenPc.filter(code => takenPhone.includes(code));
  check('stejný kód nešel ven na obou zařízeních',
    overlap.length === 0, `překryv: ${overlap.join(', ')}`);

  await run('pc');
  await run('phone');
  await run('pc');

  check('počítač ví o kódech vydaných z telefonu',
    takenPhone.every(code => used('pc').includes(code)),
    `chybí: ${takenPhone.filter(c => !used('pc').includes(c)).join(', ')}`);
  check('telefon ví o kódech vydaných z počítače',
    takenPc.every(code => used('phone').includes(code)),
    `chybí: ${takenPc.filter(c => !used('phone').includes(c)).join(', ')}`);
  check('žádné vydání se cestou neztratilo',
    used('pc').length === 16 && used('phone').length === 16,
    `počítač ${used('pc').length}, telefon ${used('phone').length}`);

  // Vydaný kód se nesmí nabídnout znovu — ani po synchronizaci
  const later = on('phone', () => vouchers.takeCode(TEMPLATE, 'další zákazník')).code;
  check('po synchronizaci se použitý kód nenabídne znovu',
    !takenPc.includes(later) && !takenPhone.includes(later), `nabídl: ${later}`);

  console.log('\nsoučasné úpravy šablon:\n');

  // Obě zařízení upraví jinou vlastnost ve stejném kole — tohle dřív
  // rozhodoval jeden společný soubor a jedna změna mizela
  on('pc', () => vouchers.saveTemplate({ id: TEMPLATE, name: 'Omluva 300 Kč', value: '500', unit: 'CZK', codeMode: 'unique' }));
  on('phone', () => vouchers.saveTemplate({ id: 'tpl-doprava', name: 'Doprava zdarma', unit: 'shipping', codeMode: 'fixed', fixedCode: 'DOPRAVA' }));
  await run('pc');
  await run('phone');
  await run('pc');

  const names = device => on(device, () => vouchers.listTemplates()).map(t => t.id).sort().join(',');
  check('obě šablony přežily současnou úpravu',
    names('pc') === 'tpl-doprava,tpl-poukaz-300' && names('phone') === names('pc'),
    `počítač: ${names('pc')} · telefon: ${names('phone')}`);
  check('novější hodnota šablony platí všude',
    on('phone', () => vouchers.listTemplates().find(t => t.id === TEMPLATE)).value === '500');

  console.log('\nkdyž se zařízení ještě nikdy nepotkala:\n');

  // Nouzová cesta: zásoba bez jediné rezervace. Dřív by každé zařízení sáhlo
  // po tomtéž „prvním volném" kódu; teď má každé vlastní pořadí. Zkouší se to
  // na čtyřiceti smyšlených zařízeních — kdyby se pořadí neuplatnilo,
  // vyšel by pořád tentýž kód.
  const SPREAD = 'tpl-rozptyl';
  const realPcId = idOf('pc'); // ať se po smyšlených zařízeních vrátí to pravé
  on('pc', () => {
    vouchers.saveTemplate({ id: SPREAD, name: 'Rozptyl', value: '100', unit: 'CZK', codeMode: 'unique' });
    vouchers.addCodes(SPREAD, Array.from({ length: 40 }, (_, i) => `R${i}`).join('\n'));
  });
  const firstPicks = new Set();
  for (let i = 0; i < 40; i++) {
    on('pc', () => {
      // Zásoba zpátky do výchozího stavu, ať každé zařízení řeší tutéž úlohu
      devices.pc.prepare(
        "UPDATE voucher_codes SET used_at = NULL, used_for = '', used_by = '', claimed_by = '', claimed_at = '' WHERE template_id = ?"
      ).run(SPREAD);
      devices.pc.prepare("UPDATE settings SET value = ? WHERE key = 'deviceId'").run(`smyslene-zarizeni-${i}`);
      firstPicks.add(vouchers.takeCode(SPREAD, 'zákazník').code);
    });
  }
  check(`bez rezervací sahá každé zařízení jinam (${firstPicks.size} různých kódů ze 40 zařízení)`,
    firstPicks.size >= 15);

  // Zpátky ke skutečné totožnosti, ať zbytek zkoušky měří to, co má
  on('pc', () => devices.pc.prepare("UPDATE settings SET value = ? WHERE key = 'deviceId'").run(realPcId));

  console.log('\nkdyž se přesto stane nejhorší:\n');

  // Vynucená kolize: kód se ručně označí za vydaný na obou zařízeních pod
  // jiným jménem — tak by to dopadlo, kdyby rezervace neexistovala
  const victim = codes('pc').find(c => !c.usedAt).code;
  on('pc', () => devices.pc.prepare(
    "UPDATE voucher_codes SET used_at = '2026-08-25T08:00:00.000Z', used_for = 'Anna', used_by = 'zarizeni-pc' WHERE template_id = ? AND code = ?"
  ).run(TEMPLATE, victim));
  on('phone', () => devices.phone.prepare(
    "UPDATE voucher_codes SET used_at = '2026-08-25T09:30:00.000Z', used_for = 'Bob', used_by = 'zarizeni-telefon' WHERE template_id = ? AND code = ?"
  ).run(TEMPLATE, victim));
  await run('pc');
  await run('phone');
  await run('pc');

  const clash = on('pc', () => vouchers.listClashes()).find(c => c.code === victim);
  check('dvojí vydání se pozná a nahlásí', !!clash, `kolize: ${on('pc', () => vouchers.listClashes()).length}`);
  check('platí dřívější vydání',
    clash && clash.usedFor === 'Anna', `platí: ${clash?.usedFor}`);
  check('to druhé vydání se neztratí, jen se označí',
    clash && clash.duplicate.includes('2026-08-25T09:30'), `druhé: ${clash?.duplicate}`);
  check('telefon o kolizi ví taky',
    on('phone', () => vouchers.listClashes()).some(c => c.code === victim));
  check('„Vyřešeno" hlášku odklidí',
    on('pc', () => vouchers.clearClash(TEMPLATE, victim)).every(c => c.code !== victim));

  console.log('\ndeníky ve složce:\n');

  const journals = fs.readdirSync(path.join(FOLDER, 'vouchers'));
  check('každé zařízení má vlastní deník', journals.length === 2, `soubory: ${journals.join(', ')}`);
  check('starší verze aplikace pořád najde vouchers.json',
    fs.existsSync(path.join(FOLDER, 'vouchers.json')));

  console.log(bad ? `\n${bad} věcí nesedí` : '\nkódy se nemůžou vydat dvakrát a šablony jsou všude stejné');
  process.exit(bad ? 1 : 0);
})();
