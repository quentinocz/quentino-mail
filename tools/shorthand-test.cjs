/**
 * Zkouška zkratek dopravy a plateb.
 *
 * Na odznaku u zprávy v telefonu je místo asi pro dvacet znaků a tohle
 * rozhoduje, co se do nich vejde. Zkouší se dvě věci, obě zaplacené chybou:
 *
 *  1. **Odhad zkratky.** Musí sedět na názvy, které e-shop doopravdy používá,
 *     a hlavně nesmí z „Platba kartou online" udělat „Platba" — první slovo
 *     je tady past a právě proto se hledá rozlišující slovo.
 *  2. **Odkud se nabídka bere.** První verze četla jen sloupce ve feedu.
 *     U objednávek stažených starší verzí aplikace jsou prázdné, takže
 *     nastavení neukázalo vůbec nic a vypadalo pokažené. Teď se sbírá
 *     i z rozebraných potvrzovacích e-mailů a ze slovníku samotného.
 */
const path = require('path');
const { db, DIST } = require('./ptrans/harness.cjs');

db.exec(`
  CREATE TABLE IF NOT EXISTS shop_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL, market TEXT NOT NULL DEFAULT 'cz',
    shipment TEXT NOT NULL DEFAULT '', payment TEXT NOT NULL DEFAULT '',
    UNIQUE (code, market));
  CREATE TABLE IF NOT EXISTS order_cache (
    message_pk INTEGER PRIMARY KEY, json TEXT, at TEXT NOT NULL DEFAULT '');
`);

const sh = require(path.join(DIST, 'shorthand.js'));

let failed = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${label}`);
  if (!ok) { console.log('      čekáno:', JSON.stringify(want)); console.log('      dostal:', JSON.stringify(got)); }
}

/* ---------- odhad ---------- */

console.log('\nodhad zkratky:\n');
check('Zásilkovna i s upřesněním', sh.guessShort('Zásilkovna - výdejní místo'), 'Zásilkovna');
check('Packeta je totéž', sh.guessShort('Packeta CZ'), 'Zásilkovna');
check('Česká pošta', sh.guessShort('Česká pošta - Balík do ruky'), 'ČP');
check('PPL', sh.guessShort('PPL ParcelShop'), 'PPL');
check('osobní odběr', sh.guessShort('Osobní odběr na prodejně'), 'Osobně');
/*
 * Past prvního slova: „Platba kartou online" začíná slovem, které neříká nic.
 * Právě kvůli tomuhle se hledá rozlišující slovo, ne první.
 */
check('platba kartou není „Platba"', sh.guessShort('Platba kartou online'), 'Karta');
check('dobírka', sh.guessShort('Dobírka v hotovosti'), 'Dobírka');
check('převod', sh.guessShort('Bankovním převodem předem'), 'Převod');
// Nic známého: první slovo je slabší, ale pořád lepší než celý název
// „domů" je rozlišující slovo pro kurýra, tak ať se to nesplete s neznámým
check('neznámé jméno se zkrátí na první slovo', sh.guessShort('Kamion s plachtou'), 'Kamion');
check('a dlouhé se ořízne', sh.guessShort('Nadstandardnídoprava kamionem'), 'Nadstandard…');
check('prázdné zůstane prázdné', sh.guessShort(''), '');

/* ---------- odkud se nabídka bere ---------- */

console.log('\ncož se nabídne v nastavení:\n');

const names = () => sh.shorthandRows().map(r => [r.kind, r.name, r.count]);

// 1) Feed objednávek
db.prepare("INSERT INTO shop_orders (code, shipment, payment) VALUES ('1', 'Zásilkovna', 'Dobírka')").run();
db.prepare("INSERT INTO shop_orders (code, shipment, payment) VALUES ('2', 'Zásilkovna', 'Platba kartou online')").run();
check('z feedu, nejčastější napřed',
  names(),
  [['shipment', 'Zásilkovna', 2], ['payment', 'Dobírka', 1], ['payment', 'Platba kartou online', 1]]);

/*
 * 2) Objednávky stažené starší verzí mají sloupce prázdné — přesně kvůli nim
 * nastavení nic neukazovalo. Rozebraný potvrzovací e-mail je ale má.
 */
db.prepare("INSERT INTO shop_orders (code, shipment, payment) VALUES ('3', '', '')").run();
db.prepare(
  "INSERT INTO order_cache (message_pk, json, at) VALUES (1, ?, '2026-09-01T10:00:00Z')"
).run(JSON.stringify({ orderNumber: '3', shipmentName: 'PPL ParcelShop', paymentName: 'Dobírka' }));
const withMail = sh.shorthandRows();
check('doplní se i z potvrzovacích e-mailů',
  withMail.some(r => r.kind === 'shipment' && r.name === 'PPL ParcelShop'), true);
check('a k dobírce se počet přičte',
  withMail.find(r => r.kind === 'payment' && r.name === 'Dobírka')?.count, 2);

/* 3) Ručně zadaná zkratka */
console.log('\nruční zápis:\n');
sh.saveShorthand('shipment', 'Balíkovna', 'Balíkovna');
const withManual = sh.shorthandRows();
const manual = withManual.find(r => r.name === 'Balíkovna');
check('název, který v objednávkách není, se přesto nabídne', !!manual, true);
check('a pozná se podle nulového počtu', manual?.count, 0);
check('zkratka se ukáže na odznaku', sh.shortFor('shipment', 'Balíkovna'), 'Balíkovna');

// Vlastní zkratka má přednost před odhadem
sh.saveShorthand('payment', 'Platba kartou online', 'Kartou');
check('vlastní zkratka přebije odhad', sh.shortFor('payment', 'Platba kartou online'), 'Kartou');
check('bez ní platí odhad', sh.shortFor('payment', 'Dobírka'), 'Dobírka');

// Smazání se vrátí k odhadu a řádek bez výskytu ze seznamu zmizí
sh.saveShorthand('payment', 'Platba kartou online', '');
check('smazaná zkratka vrátí odhad', sh.shortFor('payment', 'Platba kartou online'), 'Karta');
sh.saveShorthand('shipment', 'Balíkovna', '');
check('a ručně přidaný název bez zkratky zmizí',
  sh.shorthandRows().some(r => r.name === 'Balíkovna'), false);

/*
 * Doprava a platba se nepletou. „Zdarma" může být obojí a zkratka jednoho
 * nesmí platit pro druhé.
 */
console.log('\ndoprava a platba se nepletou:\n');
sh.saveShorthand('shipment', 'Zdarma', 'Zdarma');
check('zkratka u dopravy', sh.shortFor('shipment', 'Zdarma'), 'Zdarma');
check('u platby zůstává odhad', sh.shortFor('payment', 'Zdarma'), 'Zdarma');

console.log('\nkolik je z čeho brát:\n');
const scope = sh.shorthandScope();
check('spočítané objednávky', scope.orders, 3);
check('a kolik z nich má dopravu', scope.withShipment, 2);

console.log(failed ? `\n✗ ${failed} zkoušek selhalo\n` : '\n✓ zkratky sedí\n');
process.exit(failed ? 1 : 0);
