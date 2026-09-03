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
    invoice TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT '',
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

/* ---------- slučování poboček ---------- */

/*
 * Tohle je jádro věci a čísla jsou ze skutečného feedu. E-shop neposílá
 * „Zásilkovna", ale jméno **konkrétní výdejny** — a těch jsou stovky, jedna
 * na pobočku. Kdyby se slovník vedl po názvech, měl by tři sta řádků, které
 * nikdo nevyplní, a na odznaku by stálo „Zásilkovna Výdejní místo - Libuň,
 * Libuň 53, Potraviny". Slučuje se proto po dopravcích.
 */
console.log('\npobočky se slučují po dopravcích:\n');
const SKUTECNE = [
  'PPL / DHL International',
  'PPL ParcelBox - ABOX BRN Kounicova (Billa)',
  'PPL ParcelBox - ABOX PRG Bechyňova (ČVUT)',
  'PPL Parcelshop - ALLWYN - Knihkupectví Muller',
  'Zásilkovna Z-Box - Z-BOX',
  'Zásilkovna Výdejní místo - Libuň, Libuň 53, Potraviny',
  'Zásilkovna Výdejní místo - Potraviny Malšovice',
  'Balíkovna - Jablonec nad Nisou Chrobák PC',
  'Balíkovna - Šumperk Sport Start',
  'Osobní odběr - Lipová 656, Markvartovice 747 14',
  'DPD',
  'InPost Paczkomaty Box / Poczta Polska',
  'Mondial Relay Box',
  'Bartolini Box',
  'Hermes PaketShop (Packeta)',
  'Hermes Lieferung nach Hause (Packeta)'
];
for (const [i, name] of SKUTECNE.entries()) {
  db.prepare('INSERT INTO shop_orders (code, shipment, payment) VALUES (?,?,?)')
    .run(`s${i}`, name, i % 2 === 0 ? 'Dobírka' : 'Platba kartou online');
}

const rodiny = (kind) => sh.shorthandRows().filter(r => r.kind === kind).map(r => [r.name, r.count]);
check('šestnáct výdejen dá sedm dopravců',
  rodiny('shipment'),
  [['PPL', 4], ['Zásilkovna', 3], ['Balíkovna', 2], ['Hermes', 2],
    ['Bartolini', 1], ['DPD', 1], ['InPost', 1], ['Mondial', 1], ['Osobně', 1]]);
// Hermes vozí Packeta, ale je to jiná síť — kdyby se slil se Zásilkovnou,
// nešly by německé zásilky na odznaku rozeznat
check('Hermes se nesleje se Zásilkovnou', sh.shortFor('shipment', 'Hermes PaketShop (Packeta)'), 'Hermes');
check('a všechny PPL pobočky mají jednu zkratku',
  [...new Set(SKUTECNE.filter(n => n.startsWith('PPL')).map(n => sh.shortFor('shipment', n)))],
  ['PPL']);

const ppl = sh.shorthandRows().find(r => r.name === 'PPL');
check('u dopravce je vidět, kolik názvů se slilo', ppl.distinct, 4);
check('i ukázka, ať jde zkontrolovat, že se to nespletlo', ppl.samples.length, 3);

/* ---------- odkud se nabídka bere ---------- */

console.log('\ncož se nabídne v nastavení:\n');

/*
 * Objednávky stažené starší verzí mají sloupce prázdné — přesně kvůli nim
 * nastavení nic neukazovalo. Rozebraný potvrzovací e-mail je ale má.
 */
db.prepare("INSERT INTO shop_orders (code, shipment, payment) VALUES ('3', '', '')").run();
db.prepare(
  "INSERT INTO order_cache (message_pk, json, at) VALUES (1, ?, '2026-09-01T10:00:00Z')"
).run(JSON.stringify({ orderNumber: '3', shipmentName: 'GLS ParcelShop Brno', paymentName: 'Dobírka' }));
const withMail = sh.shorthandRows();
check('doplní se i z potvrzovacích e-mailů',
  withMail.some(r => r.kind === 'shipment' && r.name === 'GLS'), true);
check('a k dobírce se počet přičte',
  withMail.find(r => r.kind === 'payment' && r.name === 'Dobírka')?.count, 9);

/*
 * Ruční zápis. Píše se k **dopravci**, ne k jednotlivé pobočce — psát zkratku
 * ke každé výdejně zvlášť je přesně to, čemu se slučováním vyhýbáme.
 */
console.log('\nruční zápis:\n');
sh.saveShorthand('shipment', 'WeDo', 'WeDo');
const manual = sh.shorthandRows().find(r => r.name === 'WeDo');
check('dopravce, který v objednávkách zatím není, se přesto nabídne', !!manual, true);
check('a pozná se podle nulového počtu', manual?.count, 0);

// Vlastní zkratka má přednost před jménem rodiny — a platí pro celou rodinu
sh.saveShorthand('payment', 'Karta', 'Kartou');
check('vlastní zkratka přebije jméno rodiny',
  sh.shortFor('payment', 'Platba kartou online'), 'Kartou');
check('a platí i pro jiný název téže rodiny',
  sh.shortFor('payment', 'GoPay - platební brána'), 'Kartou');
check('u jiné rodiny se nic nemění', sh.shortFor('payment', 'Dobírka'), 'Dobírka');

// Smazání se vrátí ke jménu rodiny a řádek bez výskytu ze seznamu zmizí
sh.saveShorthand('payment', 'Karta', '');
check('smazaná zkratka vrátí jméno rodiny',
  sh.shortFor('payment', 'Platba kartou online'), 'Karta');
sh.saveShorthand('shipment', 'WeDo', '');
check('a ručně přidaný dopravce bez zkratky zmizí',
  sh.shorthandRows().some(r => r.name === 'WeDo'), false);

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
check('spočítané objednávky', scope.orders, 17);
check('a kolik z nich má dopravu', scope.withShipment, 16);

/* ---------- krátká cesta k odznaku ---------- */

/*
 * Tohle je odpověď na „u některých to funguje, u některých to píše stále
 * číslo a cenu". Nebyla to chyba slučování: celý odznak čeká na e-shop
 * a na dopravce, a než se vrátí, svítí v řádku číslo s částkou z předmětu.
 * Krátká cesta jde rovnou z čísla do feedu, takže zkratky sedí hned.
 */
console.log('\nzkratky rovnou podle čísla:\n');
db.prepare("INSERT INTO shop_orders (code, shipment, payment, invoice) VALUES ('23830', 'Zásilkovna Z-Box - Z-BOX', 'Platba kartou online', '250412')").run();

const found = sh.shortsForCodes(['023830']);
check('vedoucí nula z předmětu nevadí',
  [found['023830']?.shipmentShort, found['023830']?.paymentShort], ['Zásilkovna', 'Karta']);
check('a vrací se i číslo objednávky z feedu', found['023830']?.code, '23830');

// Na faktuře je číslo faktury, ne objednávky — dohledat se musí, ale nikdy
// zaměnit: napřed objednávka, teprve když není, faktura
check('podle čísla faktury se objednávka dohledá',
  sh.shortsForCodes(['250412'])['250412']?.code, '23830');
check('co ve feedu není, se netváří, že je',
  Object.keys(sh.shortsForCodes(['999999'])).length, 0);
check('objednávka bez dopravy i platby odznak nepřepíše',
  Object.keys(sh.shortsForCodes(['3'])).length, 0);
check('ptát se jde na víc čísel najednou',
  Object.keys(sh.shortsForCodes(['023830', '999999', 's1'])).sort(), ['023830', 's1']);

console.log(failed ? `\n✗ ${failed} zkoušek selhalo\n` : '\n✓ zkratky sedí\n');
process.exit(failed ? 1 : 0);
