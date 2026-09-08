/**
 * Zkouška vývozu pro PPL.
 *
 * Zkouší se proti **skutečnému exportu**, který do PPL chodí z e-shopu:
 * stejné sloupce, stejné uvozovky, stejné kódování. Import v PPL čte soubor
 * podle uložené úlohy doslova, takže na každé z těch tří věcí stojí, jestli
 * se zásilky nahrají, nebo jestli se jméno vytiskne rozsypané.
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
    pickup_id TEXT NOT NULL DEFAULT '', pickup_name TEXT NOT NULL DEFAULT '', weight REAL NOT NULL DEFAULT 0,
    items_json TEXT NOT NULL DEFAULT '[]', billing_json TEXT, postal_json TEXT, seen_at TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (code, market)
  );
`);

const add = (row) => db.prepare(
  `INSERT OR REPLACE INTO shop_orders
   (code, market, name, email, phone, currency, total, shipment, payment, pickup_id,
    items_json, billing_json, postal_json)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
).run(row.code, 'cz', row.name, row.email, row.phone, row.currency ?? 'CZK', row.total,
  row.shipment, row.payment, row.pickupId ?? '', JSON.stringify(row.items ?? []),
  JSON.stringify(row.billing ?? null), row.postal ? JSON.stringify(row.postal) : null);

// Výdejní místo: název v `company`, kód s obcí v `city` — přesně jak to chodí z e-shopu
add({
  code: '023758', name: 'Tomáš Bartoník', email: 'tomas.bartonik12@gmail.com', phone: '+420 735829763',
  total: 1049, shipment: 'PPL ParcelBox', payment: 'Platba kartou online', pickupId: 'KM10439155',
  items: [{ title: 'Vínová kravata s jemným vzorem', code: 'K-118', quantity: 2, price: 490 }],
  postal: { name: 'Tomáš Bartoník', company: 'ABOX CHV Gabrielovo nám. (Flop)',
    street: 'Gabrielovo náměstí 452', city: 'Chýnov', zip: '39155', country: 'CZ' }
});
// Adresa a dobírka
add({
  code: '023845', name: 'Taťána Malyš', email: 'tamal@centrum.cz', phone: '+420 730862251',
  total: 487, shipment: 'PPL', payment: 'Dobírka',
  items: [{ title: 'Motýlek modrý', code: 'M-3', quantity: 1, price: 390 },
    { title: 'Bílý kapesníček', code: 'KA-1', quantity: 1, price: 97 }],
  postal: { name: 'Taťána Malyš', company: '', street: 'Kubelíkova 1209/6',
    city: 'Hradec Králové', zip: '500 03', country: 'CZ' }
});
// Jiný dopravce — do souboru pro PPL nepatří
add({
  code: '023900', name: 'Jan Novák', email: 'jan@example.cz', phone: '+420 111222333',
  total: 300, shipment: 'Zásilkovna', payment: 'Dobírka',
  items: [{ title: 'Kšandy černé', code: 'KS-1', quantity: 1, price: 300 }],
  postal: { name: 'Jan Novák', company: '', street: 'Dlouhá 1', city: 'Praha', zip: '11000', country: 'CZ' }
});

const ppl = require(path.join(DIST, 'ppl.js'));
const { __test } = ppl;

console.log('\nvývoz pro PPL:\n');

/* ---------- kódování ---------- */

/*
 * Windows-1250, ne UTF-8. V UTF-8 by z „Tomáš" v PPL bylo „TomÃ¡Å¡" a s tím
 * by se vytiskl i štítek — uložená úloha čte bajty, ne deklaraci.
 */
const encoded = __test.toCp1250('Tomáš Bartoník, Ždánice, Přelouč');
check('diakritika jde ve Windows-1250', encoded.toString('latin1').length, 32);
check('a dekóduje se zpátky', encoded.toString('binary').length, 32);
check('á je jeden bajt 0xE1', encoded[3], 0xe1);
check('š je 0x9A', encoded[4], 0x9a);
check('Ž je 0x8E', __test.toCp1250('Ž')[0], 0x8e);
// Znak mimo tuhle stránku nesmí soubor rozsypat
check('cizí znak se nahradí otazníkem', __test.toCp1250('日')[0], 0x3f);

/* ---------- obsah zásilky ---------- */

check('jeden kus je jednotné číslo', __test.contentOf([{ title: 'Vínová kravata', quantity: 1 }]), 'kravata');
check('dva až čtyři mají svůj tvar', __test.contentOf([{ title: 'Vínová kravata', quantity: 3 }]), '3 kravaty');
check('od pěti se mění zase', __test.contentOf([{ title: 'Vínová kravata', quantity: 6 }]), '6 kravat');
check('druhy se sečtou zvlášť',
  __test.contentOf([{ title: 'Kravata modrá', quantity: 2 }, { title: 'Motýlek', quantity: 1 }]),
  '2 kravaty, motýlek');
// Neznámé zboží se nezamlčí — počet musí sedět, i když se nepozná co to je
check('nerozpoznané se pojmenuje obecně',
  __test.contentOf([{ title: 'Něco úplně jiného', quantity: 1 }]), 'oděvní doplněk');
ok('prázdná objednávka má aspoň něco', __test.contentOf([]).length > 0);

/* ---------- typ zásilky ---------- */

/*
 * Kód výdejny je ve feedu u dopravy (`BRANCH_ID`), ne v adrese — tam je jen
 * obec. Do souboru se ale píše obojí dohromady, protože přesně tak to čte
 * uložená úloha v administraci PPL.
 */
check('kód výdejny se přilepí k obci', __test.cityWithPoint('Jablunkov', 'KM10873991'), 'KM10873991 Jablunkov');
check('podruhé se nepřilepuje', __test.cityWithPoint('KM10873991 Jablunkov', 'KM10873991'), 'KM10873991 Jablunkov');
check('u zásilky na adresu zůstane obec sama', __test.cityWithPoint('Praha 5', ''), 'Praha 5');
// Balíkovna má v BRANCH_ID PSČ, ne kód výdejny PPL — to se nesmí plést
check('cizí číslo v BRANCH_ID se nepřilepuje', __test.cityWithPoint('Brno', '63404'), 'Brno');
check('kód výdejny znamená typ 46', __test.typeOf('Jablunkov', 'PPL ParcelBox', 'KM10873991'), 46);
check('bez kódu rozhodne dopravce', __test.typeOf('Chýnov', 'PPL ParcelShop'), 46);
check('adresa je 14', __test.typeOf('Praha 5', 'PPL'), 14);

/* ---------- řádky ---------- */

const { rows, skipped } = ppl.pplRows(['023758', '023845', '023900']);
check('do PPL jdou jen zásilky PPL', rows.map(r => r.code), ['023758', '023845']);
check('a ostatní se vypíšou i s důvodem', skipped.map(s => s.code), ['023900']);
check('variabilní symbol je číslo objednávky bez nul', rows[0].variableSymbol, '23758');
check('u výdejny se přenese název místa', rows[0].company, 'ABOX CHV Gabrielovo nám. (Flop)');
check('a obec nese kód výdejny', rows[0].city, 'KM10439155 Chýnov');
/*
 * Hodnota zásilky je cena zboží, ne částka i s dopravou: PPL si ji mapuje na
 * to, co se pojišťuje. U dobírky je rozdíl vidět — vybírá se celá částka.
 */
check('hodnota zásilky je cena zboží', rows[0].total, 980);
check('placené předem má dobírku nula', rows[0].cod, 0);
check('dobírka vybírá celou částku', rows[1].cod, 487);
check('obsah zásilky se složí z položek', rows[0].content, '2 kravaty');

/* ---------- soubor ---------- */

const csv = ppl.pplCsv(rows, true).toString('binary');
const lines = csv.split('\r\n');
check('hlavička sedí s tou, na kterou je PPL nastavené',
  lines[0],
  'name;company;street;city;zip;country;cash_on_delivery;currency;variable_symbol;phone;email;type;total;content');
/*
 * Uvozovky jen tam, kde je má export z e-shopu: kolonka s mezerou v nich je,
 * číslo ne. Uložená úloha v PPL čte soubor doslova.
 */
ok('jméno s mezerou je v uvozovkách', lines[1].startsWith('"Tom'));
ok('e-mail bez mezery uvozovky nemá', lines[1].includes(';tomas.bartonik12@gmail.com;'));
ok('PSČ s mezerou je v uvozovkách', lines[2].includes('"500 03"'));
ok('obec s kódem výdejny je v uvozovkách', lines[1].includes('"KM10439155 Chýnov"'));
ok('firma u adresní zásilky zůstane prázdná', lines[2].split(';')[1] === '');
check('řádků je tolik jako zásilek plus hlavička', lines.filter(Boolean).length, 3);
// Bez sloupce navíc musí soubor sedět se starým vzorem
ok('obsah zásilky se dá vypnout', !ppl.pplCsv(rows, false).toString('binary').includes('content'));

console.log(failed === 0 ? '\nvše sedí\n' : `\n${failed} nesedí\n`);
process.exit(failed === 0 ? 0 : 1);
