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
    note TEXT NOT NULL DEFAULT '',
    pickup_id TEXT NOT NULL DEFAULT '', pickup_name TEXT NOT NULL DEFAULT '', weight REAL NOT NULL DEFAULT 0,
    items_json TEXT NOT NULL DEFAULT '[]', billing_json TEXT, postal_json TEXT, seen_at TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (code, market)
  );
`);

const add = (row) => db.prepare(
  `INSERT OR REPLACE INTO shop_orders
   (code, market, name, email, phone, currency, total, shipment, payment, pickup_id, note,
    items_json, billing_json, postal_json)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
).run(row.code, 'cz', row.name, row.email, row.phone, row.currency ?? 'CZK', row.total,
  row.shipment, row.payment, row.pickupId ?? '', row.note ?? '', JSON.stringify(row.items ?? []),
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

/* ---------- poznámka zákazníka ---------- */

/*
 * Poznámka jde na štítek, který uvidí kurýr, takže se přidává jen tehdy,
 * když ji člověk schválil. Když se přidá, je v souboru **u všech řádků**:
 * uložená úloha v administraci PPL mapuje sloupce podle pořadí a soubor
 * jednou o třinácti a podruhé o čtrnácti sloupcích by jí nesedl. Objednávka
 * bez poznámky má v tom sloupci mezeru — prázdné namapované pole import
 * odmítá.
 */
console.log('\npoznámka zákazníka:');
add({
  code: '024300', name: 'Petr Dvořák', email: 'petr@example.cz', phone: '+420777000111',
  total: 890, shipment: 'PPL ParcelShop', payment: 'GoPay', pickupId: 'KM10439155',
  note: 'Prosím zavolejte předem, jsem doma až po 17. hodině',
  items: [{ title: 'Kravata', quantity: 1 }],
  postal: { name: 'Petr Dvořák', company: 'Chýnov', street: 'Nádražní 12', city: 'Chýnov',
    zip: '39155', country: 'CZ' }
});
add({
  code: '024301', name: 'Eva Malá', email: 'eva@example.cz', phone: '+420777000222',
  total: 450, shipment: 'PPL ParcelShop', payment: 'GoPay', pickupId: 'KM10439155',
  items: [{ title: 'Ponožky', quantity: 1 }],
  postal: { name: 'Eva Malá', company: 'Chýnov', street: 'Nádražní 12', city: 'Chýnov',
    zip: '39155', country: 'CZ' }
});

{
  const pair = ppl.pplRows(['024300', '024301']).rows;
  // Zkrácená na to, co PPL vytiskne — celá je vidět v dotazu před vývozem
  check('poznámka se natáhne k té správné objednávce',
    pair.map(r => r.note), ['Prosím zavolejte předem, jsem', '']);

  const bez = ppl.pplCsv(pair, false, false).toString('binary').split('\r\n').filter(Boolean);
  ok('bez schválení sloupec vůbec není', !bez[0].endsWith(';note'));
  check('a sloupců zůstane, kolik jich bylo', bez[1].split(';').length, 13);

  const sni = ppl.pplCsv(pair, false, true).toString('binary').split('\r\n').filter(Boolean);
  ok('po schválení je sloupec v hlavičce', sni[0].endsWith(';note'));
  check('a je u všech řádků, ne jen u té s poznámkou',
    sni.slice(1).map(line => line.split(';').length), [14, 14]);
  /*
   * Mezera, ne prázdno: prázdné namapované pole import PPL odmítá. Do
   * uvozovek ji dává tentýž kód jako u jmen s mezerou — soubor se tím
   * nechová jinak než u ostatních sloupců.
   */
  check('objednávka bez poznámky má mezeru', sni[2].split(';').pop(), '" "');
  ok('a ta s poznámkou její text', sni[1].includes('zavolejte p'));
}

/*
 * Schvaluje se po jedné, ne všechny naráz: jedna poznámka bývá pokyn pro
 * kurýra, druhá vzkaz pro nás, který na štítku nemá co dělat. Neschválená
 * se z řádku vymaže, ale sloupec zůstane — jinak by souboru ubyl sloupec
 * a uložená úloha v administraci PPL by mu nesedla.
 */
{
  add({
    code: '024302', name: 'Karel Novotný', email: 'karel@example.cz', phone: '+420777000333',
    total: 300, shipment: 'PPL ParcelShop', payment: 'GoPay', pickupId: 'KM10439155',
    note: 'Vzkaz pro nás, ne pro kurýra',
    items: [{ title: 'Motýlek', quantity: 1 }],
    postal: { name: 'Karel Novotný', company: 'Chýnov', street: 'Nádražní 12', city: 'Chýnov',
      zip: '39155', country: 'CZ' }
  });
  const tri = ppl.pplRows(['024300', '024301', '024302']).rows;
  const jenJedna = tri.map(one => (one.code === '024300' ? one : { ...one, note: '' }));
  const soubor = ppl.pplCsv(jenJedna, false, true).toString('binary').split('\r\n').filter(Boolean);
  // Diakritika je v souboru ve Windows-1250, tak se porovnává jen tvar
  const posledni = soubor.slice(1).map(line => line.split(';').pop());
  ok('schválená poznámka v souboru zůstane', posledni[0].length > 10, posledni[0]);
  check('neschválené se změní na mezeru', posledni.slice(1), ['" "', '" "']);
}

/*
 * Délka podle dopravce. PPL uřízla „Prosím kurýra zavolat před domem" na
 * „Prosím kurýra zavolat před dom" — přesně třicet znaků, uprostřed slova.
 * Aplikace proto zkracuje sama a na hranici slova.
 */
{
  const ship = require(path.join(DIST, 'shipexport.js'));
  check('výchozí délka je ta, co PPL vytiskla', ppl.pplSetup().noteLimit, 30);
  const pokyn = 'Prosím kurýra zavolat před domem';
  check('řeže se na hranici slova, ne uprostřed',
    ship.shortNote(pokyn, 30), 'Prosím kurýra zavolat před');
  // Schválený text je ten, který člověk viděl — ne ten z databáze
  const schvalene = ship.approvedNotes([{ code: '024300', text: 'Zavolat před domem' }], 30);
  check('ručně přepsaný text vyhraje', schvalene.get('024300'), 'Zavolat před domem');
  // I ručně přepsaný se ještě jednou pojistí proti limitu
  check('a přesto se nevejde-li, zkrátí',
    ship.approvedNotes([{ code: 'x', text: pokyn }], 30).get('x'), 'Prosím kurýra zavolat před');
  check('prázdný text se zahodí', ship.approvedNotes([{ code: 'x', text: '  ' }], 30).size, 0);
}

/*
 * Dlouhá poznámka se zkracuje na hranici slova. Delší text štítek stejně
 * neunese a useknuté slovo uprostřed vypadá jako chyba tisku.
 */
{
  const ship = require(path.join(DIST, 'shipexport.js'));
  const dlouha = 'Zboží prosím předejte sousedce paní Novákové ve druhém patře vpravo, '
    + 'já budu do konce měsíce mimo republiku a nemám to jak převzít';
  const kratka = ship.shortNote(dlouha);
  ok('dlouhá poznámka se zkrátí', kratka.length <= 100, `délka ${kratka.length}`);
  ok('a nekončí půlkou slova', dlouha.startsWith(kratka) && !/\S$/.test(dlouha[kratka.length] ?? ' '));
  check('krátká zůstane celá', ship.shortNote('Zvoňte na Nováka'), 'Zvoňte na Nováka');
  // Konce řádků z formuláře e-shopu by v CSV rozbily řádek
  check('konce řádků se srovnají na mezery',
    ship.shortNote('první řádek\ndruhý řádek'), 'první řádek druhý řádek');
}

/*
 * Dotaz před vývozem stojí na tom, že se poznámky najdou — a jen u toho
 * dopravce, kterého se vývoz týká.
 */
{
  const ship = require(path.join(DIST, 'shipexport.js'));
  const nalezene = ship.orderNotes(['024300', '024301'], 'PPL', 30);
  check('hlásí se jen objednávky s poznámkou', nalezene.map(one => one.code), ['024300']);
  ok('a je u nich vidět jméno', nalezene[0].name === 'Petr Dvořák');
  /*
   * Celá poznámka i její zkrácená podoba. Bez originálu se v dotazu nedá
   * poznat, co se ztratilo — a právě to se přepisuje ručně.
   */
  ok('do dotazu jde celý text', nalezene[0].note.includes('17. hodině'));
  check('i zkrácený na to, co dopravce vytiskne', nalezene[0].short, 'Prosím zavolejte předem, jsem');
  check('u cizího dopravce se nehlásí nic',
    ship.orderNotes(['024300', '024301'], 'Balíkovna').length, 0);
}

console.log(failed === 0 ? '\nvše sedí\n' : `\n${failed} nesedí\n`);
process.exit(failed === 0 ? 0 : 1);
