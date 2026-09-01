/**
 * Zkouška feedu objednávek — rozbor adres a načasování stahování.
 *
 * Dvě věci, na kterých teď stojí balení, a ani jedna není vidět:
 *
 *  1. **Adresy.** Balení se přestěhovalo z potvrzovacích e-mailů na feed.
 *     Adresa je jediné, co při balení člověk opisuje, a názvy značek se mezi
 *     šablonami exportu liší — když se netrefí, karta mlčky ukáže prázdno.
 *  2. **Načasování.** E-shop soubor přegenerovává v pevných značkách. Počítat
 *     interval od posledního stažení znamená trvale se opožďovat o kus periody,
 *     což se pozná jedině tím, že nová objednávka „chvíli není".
 */
const fs = require('fs');
const path = require('path');

const DIST = process.env.PTDIST || path.join(__dirname, '../dist/ptdist/main');
require.cache[require.resolve('electron')] = {
  id: 'electron', filename: 'electron', loaded: true,
  exports: { net: {}, BrowserWindow: { getAllWindows: () => [] }, app: { getPath: () => '/tmp' } }
};
const dbPath = require.resolve(path.join(DIST, 'db.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {
  getDb: () => { throw new Error('databáze se v téhle zkoušce nepoužívá'); },
  getSetting: () => '', setSetting: () => {}
} };
const secPath = require.resolve(path.join(DIST, 'secure.js'));
require.cache[secPath] = { id: secPath, filename: secPath, loaded: true, exports: {
  encrypt: v => v, decrypt: v => v
} };

const feed = require(path.join(DIST, 'orderfeed.js'));

let failed = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${label}`);
  if (!ok) {
    console.log('      čekáno:', JSON.stringify(want));
    console.log('      dostal:', JSON.stringify(got));
  }
}

function ok(label, condition, detail) {
  if (!condition) failed++;
  console.log(`  ${condition ? '✓' : '✗'} ${label}`);
  if (!condition && detail) console.log('      ', detail);
}

/* ---------- adresy ---------- */

console.log('\nAdresy z exportu');

const xml = fs.readFileSync(path.join(__dirname, 'fixtures/objednavky.xml'), 'utf8');
const orders = feed.parseOrders(xml, 'cz');
const byCode = code => orders.find(o => o.code === code);

const first = byCode('023687');
check('doručovací adresa i s výdejním místem', first.postal, {
  name: 'Jana Nováková',
  company: '',
  street: 'Balíkovna, Vodičkova 30',
  city: 'Praha 1',
  zip: '110 00',
  country: 'CZ',
  state: ''
});

/*
 * `<STREET>` je v obou blocích. Kdyby se hledalo v celé objednávce místo
 * uvnitř `<ADDRESSES>`, vydávala by se fakturační ulice za doručovací.
 */
check('fakturační adresa se nepomíchá s doručovací',
  [first.billing.street, first.postal.street],
  ['Dlouhá 12', 'Balíkovna, Vodičkova 30']);

const second = byCode('023688');
ok('bez doručovacího bloku zůstane jen fakturační',
  second.postal === null && second.billing !== null, JSON.stringify(second.postal));
check('firma i jméno z fakturační adresy',
  [second.billing.company, second.billing.name], ['Alfa s.r.o.', 'Petr Svoboda']);

/*
 * Prázdná adresa v kartě vypadá, jako by se doručovalo nikam — proto se
 * z bloku bez jediné vyplněné značky vrací „nic".
 */
const third = byCode('023689');
ok('objednávka bez adres nemá prázdné skořápky',
  third.billing === null && third.postal === null,
  JSON.stringify([third.billing, third.postal]));

/* ---------- načasování stahování ---------- */

console.log('\nKdy se sáhne pro feed');

const at = (text) => new Date(`2026-09-01T${text}:00.000Z`).getTime();
const iso = (text) => new Date(at(text)).toISOString();

ok('bez posledního stažení se stahuje hned', feed.feedDue(5, ''));
ok('nesmyslné datum posledního stažení nezablokuje', feed.feedDue(5, 'nesmysl'));

/*
 * Jádro věci. Soubor se přegenerovává v :00, :05, :10… Stažení ve 12:03
 * (třeba po spuštění aplikace) nesmí znamenat, že se další sáhne až ve 12:08 —
 * to by se pořád četl soubor z 12:05 a aplikace by byla trvale o krok pozadu.
 */
ok('po značce se stahuje, i když od posledního neuplynula celá perioda',
  feed.feedDue(5, iso('12:03'), at('12:06')));
ok('před značkou se nestahuje',
  !feed.feedDue(5, iso('12:03'), at('12:04')));
ok('těsně po značce se ještě počká, než e-shop soubor dopíše',
  !feed.feedDue(5, iso('12:03'), at('12:05')));
ok('dvě stažení v jedné značce se nekonají',
  !feed.feedDue(5, iso('12:06'), at('12:09')));
ok('další značka zase spustí stahování',
  feed.feedDue(5, iso('12:06'), at('12:11')));

// Velký export jednou denně na značky nehraje — tam rozhoduje prostý odstup
ok('denní feed se po dvou hodinách nestahuje',
  !feed.feedDue(24 * 60, iso('10:00'), at('12:00')));

// Posunuté hodiny na počítači by jinak feed zamkly do budoucnosti
ok('datum v budoucnosti feed nezamkne', feed.feedDue(5, iso('13:00'), at('12:00')));

console.log(failed === 0 ? '\n✓ feed objednávek sedí' : `\n✗ ${failed} nesedí`);
process.exit(failed === 0 ? 0 : 1);
