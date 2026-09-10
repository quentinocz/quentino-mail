/**
 * Zkouška vývozu pro Balíkovnu (Podání Online České pošty).
 *
 * Podání Online nemá pevný formát: uživatel si tam k **každému poli**
 * nastaví, ve kterém sloupci ho má hledat. Zkouší se proto přesně to, na čem
 * to stojí — že se hodnoty spočítají správně a že se do souboru dostanou
 * v tom pořadí, které je nastavené. Když se pořadí přehází, musí se přehodit
 * i soubor; kdyby ne, dorazily by do České pošty telefony ve sloupci s PSČ.
 */
const path = require('path');
const { db, DIST } = require('./ptrans/harness.cjs');

let failed = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${label}`);
  if (!ok) { console.log('      čekáno:', JSON.stringify(want)); console.log('      dostal:', JSON.stringify(got)); }
}
function ok(label, value) { check(label, !!value, true); }

db.exec(`
  CREATE TABLE IF NOT EXISTS shop_orders (
    code TEXT NOT NULL, market TEXT NOT NULL DEFAULT 'cz', status TEXT NOT NULL DEFAULT '',
    paid INTEGER NOT NULL DEFAULT 0, paid_date TEXT NOT NULL DEFAULT '', resolved INTEGER NOT NULL DEFAULT 0,
    invoice TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '',
    currency TEXT NOT NULL DEFAULT '', total REAL NOT NULL DEFAULT 0, tracking TEXT NOT NULL DEFAULT '',
    customer_id TEXT NOT NULL DEFAULT '', name TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '', shipment TEXT NOT NULL DEFAULT '', payment TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    pickup_id TEXT NOT NULL DEFAULT '', pickup_name TEXT NOT NULL DEFAULT '', weight REAL NOT NULL DEFAULT 0,
    items_json TEXT NOT NULL DEFAULT '[]', billing_json TEXT, postal_json TEXT, seen_at TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (code, market)
  );
`);

const add = (row) => db.prepare(
  `INSERT OR REPLACE INTO shop_orders
   (code, market, name, email, phone, currency, total, shipment, payment, pickup_id, weight,
    invoice, note, items_json, postal_json)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
).run(row.code, 'cz', row.name, row.email, row.phone, 'CZK', row.total, row.shipment, row.payment,
  row.pickupId ?? '', row.weight ?? 0, row.invoice ?? '', row.note ?? '',
  JSON.stringify(row.items ?? []), row.postal ? JSON.stringify(row.postal) : null);

// Skutečné tvary z exportu: výdejní místo má název v adrese, BRANCH_ID je PSČ místa
add({
  code: '023852', name: 'Tomáš Vondra', email: 'tom.vondra@email.cz', phone: '+420 739101600',
  total: 1506, shipment: 'Balíkovna', payment: 'GoPay', pickupId: '54966', weight: 630,
  items: [{ title: 'Černé pánské kšandy', code: 'PS120CRN', quantity: 3, price: 479 }],
  postal: { name: 'Tomáš Vondra', company: 'Police nad Metují AlzaBox Penny',
    street: 'Komenského náměstí 110', city: 'Police nad Metují', zip: '549 66', country: 'CZ' }
});
add({
  code: '023856', name: 'Jan Chlubna', email: 'jan.chlubna@email.cz', phone: '+420 776048528',
  total: 997, shipment: 'Balíkovna', payment: 'Dobírka', pickupId: '18004', weight: 740,
  items: [{ title: 'Cihlové pánské kšandy s motýlkem', code: 'PST120M39', quantity: 1, price: 739 },
    { title: 'Cihlové pánské ponožky', code: 'PON02CIH', quantity: 1, price: 189 }],
  postal: { name: 'Jan Chlubna', company: 'Praha 8 AlzaBox Libeň Global Car Wash',
    street: 'Zenklova 608/150', city: 'Praha, Libeň', zip: '18004', country: 'CZ' }
});
// Jiný dopravce — do souboru pro Balíkovnu nepatří
add({
  code: '023854', name: 'Roman Martynek', email: 'roman@example.cz', phone: '+420 733369313',
  total: 758, shipment: 'PPL ParcelBox', payment: 'GoPay', pickupId: 'KM10873991', weight: 180,
  items: [], postal: { name: 'Roman Martynek', company: '', street: 'Bukovecká 76',
    city: 'Jablunkov', zip: '73991', country: 'CZ' }
});

const bal = require(path.join(DIST, 'balikovna.js'));
const ship = require(path.join(DIST, 'shipexport.js'));
const { __test } = bal;

console.log('\nvývoz pro Balíkovnu:\n');

/* ---------- ulice ---------- */

/*
 * Česká pošta chce ulici a čísla zvlášť, e-shop je vede v jednom řetězci.
 * Dělí se odzadu; když číslo orientační chybí, zůstane prázdné — vymyslet
 * si ho nelze.
 */
check('ulice s číslem popisným i orientačním', ship.splitStreet('Zenklova 608/150'),
  { street: 'Zenklova', house: '608', orient: '150' });
check('ulice jen s číslem popisným', ship.splitStreet('Komenského náměstí 110'),
  { street: 'Komenského náměstí', house: '110', orient: '' });
// Vesnice bez ulic: „Zdislavice 204" je obec a číslo, ne ulice
check('obec s číslem nemá ulici', ship.splitStreet('Zdislavice 204'),
  { street: 'Zdislavice', house: '204', orient: '' });
check('adresa bez čísla zůstane celá', ship.splitStreet('Horna suča'),
  { street: 'Horna suča', house: '', orient: '' });

/* ---------- hodnoty ---------- */

const setup = bal.balikovnaSetup();
const { rows, skipped } = bal.balikovnaRows(['023852', '023856', '023854']);
check('do Balíkovny jdou jen její zásilky', rows.map(r => r.code), ['023852', '023856']);
check('a ostatní se vypíšou s důvodem', skipped.map(s => s.code), ['023854']);

const first = __test.valuesOf(rows[0], setup);
check('příjmení a jméno se rozdělí', [first.prijmeni, first.jmeno], ['Vondra', 'Tomáš']);
check('adresa se rozpadne na ulici a číslo',
  [first.ulice, first.cisloPopisne, first.cisloOrientacni], ['Komenského náměstí', '110', '']);
check('PSČ jde bez mezery', first.psc, '54966');
// Telefon patří do Mobilu — na něj Česká pošta posílá zprávu o zásilce
check('telefon jde do mobilu, ne do telefonu', [first.telefon, first.mobil], ['', '+420 739101600']);
check('hmotnost je v kilogramech', first.hmotnost, '0.63');
// Udaná cena je cena zboží, ne částka i s dopravou — pojišťuje se zboží
check('udaná cena je cena zboží', first.cena, '1437');
check('placené předem má dobírku nula', first.dobirka, '0');
check('a poukázka u nich zůstane prázdná', first.vsPoukazka, '');
check('obsah zásilky se složí z položek', first.obsah, '3 kšandy');

const second = __test.valuesOf(rows[1], setup);
check('dobírka vybírá celou částku', second.dobirka, '997');
// Bez shodného variabilního symbolu se platba dobírky nespáruje
check('u dobírky se vyplní i poukázka', second.vsPoukazka, '23856');
check('název výdejního místa se přenese', second.mistoNazev, 'Praha 8 AlzaBox Libeň Global Car Wash');

/* ---------- pořadí sloupců ---------- */

const csv = bal.balikovnaCsv(rows, setup).toString('utf8');
const lines = csv.split('\r\n').filter(Boolean);
check('řádků je tolik jako zásilek', lines.length, 2);
check('sloupců je tolik, kolik jich Podání Online čísluje', lines[0].split(';').length, 23);
ok('první sloupec je příjmení', lines[0].startsWith('Vondra;'));
// Diakritika jde v UTF-8, ne ve Windows-1250 jako u PPL
ok('diakritika je v UTF-8', csv.includes('Komenského náměstí'));

/*
 * Pořadí se řídí nastavením. Kdyby ho soubor ignoroval, dorazily by do
 * České pošty hodnoty v jiných sloupcích, než kde je konfigurace čeká —
 * a poznalo by se to až u nich.
 */
const swapped = bal.saveBalikovnaSetup({ order: 'psc,prijmeni,obsah', header: true });
const short = bal.balikovnaCsv(rows, swapped).toString('utf8').split('\r\n').filter(Boolean);
check('hlavička se dá zapnout', short[0], 'PSČ;Příjmení/Název;"Obsah zásilky"');
check('a sloupce jdou v nastaveném pořadí', short[1], '54966;Vondra;"3 kšandy"');
// Nesmyslný název sloupce nesmí shodit celý vývoz
const broken = bal.saveBalikovnaSetup({ order: 'psc,neexistuje,prijmeni', header: false });
check('neznámý sloupec se přeskočí',
  bal.balikovnaCsv(rows, broken).toString('utf8').split('\r\n')[0], '54966;Vondra');

/* ---------- vkládání souboru do okna ---------- */

/*
 * Skript, který v okně hledá políčko na soubor, se nedá vyzkoušet bez
 * administrace — zato se dá zkontrolovat to, co se v minulé verzi rozbilo
 * tiše: **že se dá vůbec přeložit**. Překlep v řetězci uvnitř
 * `executeJavaScript` se jinak projeví až v okně, které nic nevloží.
 */
const formfile = require(path.join(DIST, 'formfile.js'));
const script = formfile.__test.markScript('#neco');
try {
  // eslint-disable-next-line no-new-func
  new Function(script);
  ok('skript na hledání políčka se dá přeložit', true);
} catch (e) {
  ok(`skript na hledání políčka se dá přeložit (${e.message})`, false);
}
ok('hledá se políčko na soubor', script.includes("input[type=file]"));
ok('a značí se, aby ho pak našlo ladicí rozhraní', script.includes(formfile.__test.MARK));
// Vodítko se použije, jen když na stránce opravdu je — jinak rozhodne pořadí
ok('vodítko se dá předat', script.includes('#neco'));

/* ---------- poznámka zákazníka ---------- */

/*
 * Poznámka je v Podání Online obyčejné pole jako každé jiné — jde tedy do
 * pořadí sloupců a číslo sloupce si musí sedět s konfigurací importu.
 * Přidává se jen po schválení; u objednávky bez poznámky zůstane mezera,
 * aby namapované pole nebylo prázdné.
 */
console.log('\npoznámka zákazníka:');
add({
  code: '023860', name: 'Petr Dvořák', email: 'petr@example.cz', phone: '+420777000111',
  total: 890, shipment: 'Balíkovna', payment: 'GoPay', pickupId: '39155', weight: 300,
  note: 'Zavolejte prosím předem',
  items: [{ title: 'Kravata', code: 'KR01', quantity: 1, price: 890 }],
  postal: { name: 'Petr Dvořák', company: 'Chýnov Balíkovna', street: 'Nádražní 12',
    city: 'Chýnov', zip: '391 55', country: 'CZ' }
});
{
  const order = bal.balikovnaRows(['023860']).rows[0];
  const sPoznamkou = bal.saveBalikovnaSetup({ order: 'prijmeni,poznamka', header: true });
  check('poznámka se natáhne k objednávce',
    __test.valuesOf(order, { ...sPoznamkou, note: true }).poznamka, 'Zavolejte prosím předem');
  // Bez schválení se pole nevyplní, i kdyby v pořadí sloupců bylo
  check('bez schválení zůstane prázdné',
    __test.valuesOf(order, { ...sPoznamkou, note: false }).poznamka, '');

  const soubor = bal.balikovnaCsv([order], { ...sPoznamkou, note: true })
    .toString('utf8').split('\r\n').filter(Boolean);
  check('hlavička zná i poznámku', soubor[0], 'Příjmení/Název;Poznámka');
  ok('a text je v souboru', soubor[1].includes('Zavolejte prosím předem'));

  // Objednávka bez poznámky: mezera, ne prázdno
  const bez = bal.balikovnaRows(['023852']).rows[0];
  check('bez poznámky je v poli mezera',
    __test.valuesOf(bez, { ...sPoznamkou, note: true }).poznamka, ' ');
  // Nastavení se vrací zpátky, ať další zkoušky nestojí na tomhle pořadí
  bal.saveBalikovnaSetup({ order: 'psc,prijmeni,obsah', header: true });
}

console.log(failed === 0 ? '\nvše sedí\n' : `\n${failed} nesedí\n`);
process.exit(failed === 0 ? 0 : 1);
