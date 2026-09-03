/**
 * Zkouška přehledu dne.
 *
 * Dvě věci se tu hlídají obzvlášť, protože obě už jednou zlobily v provozu:
 *
 *  1. **Vyřízené se nesmí připomínat.** Přehled dřív šel podle příznaku
 *     „zodpovězeno" ze serveru. Ten se u odpovědi odeslané z jiného zařízení
 *     nenastaví, takže přehled dokola hlásil problém, který byl dávno
 *     vyřešený. Teď rozhoduje celé vlákno — a přesně to se tu zkouší.
 *  2. **Postřehy se nedělají při každém kliknutí.** Stály peníze a pokaždé
 *     vyšlo něco trochu jiného. Zkouší se, že se model zavolá jednou za
 *     24 hodin, že tlačítko „Přegenerovat" ho zavolá i tak a že se do
 *     dalšího zadání dostane, co bylo minule.
 *
 * Čísla se počítají z feedu objednávek — u nich jde hlavně o to, aby se do
 * tržby nedostalo storno a aby se nesčítaly koruny s eury.
 */
const path = require('path');
const { db, DIST } = require('./ptrans/harness.cjs');

/* ---------- tabulky ---------- */

db.exec(`
  CREATE TABLE IF NOT EXISTS shop_orders (
    code TEXT NOT NULL, market TEXT NOT NULL DEFAULT 'cz', status TEXT NOT NULL DEFAULT '',
    paid INTEGER NOT NULL DEFAULT 0, paid_date TEXT NOT NULL DEFAULT '',
    resolved INTEGER NOT NULL DEFAULT 0, invoice TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '',
    currency TEXT NOT NULL DEFAULT '', total REAL NOT NULL DEFAULT 0,
    tracking TEXT NOT NULL DEFAULT '', customer_id TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '',
    shipment TEXT NOT NULL DEFAULT '', payment TEXT NOT NULL DEFAULT '',
    items_json TEXT NOT NULL DEFAULT '[]', billing_json TEXT, postal_json TEXT,
    seen_at TEXT NOT NULL DEFAULT '', PRIMARY KEY (code, market));
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL DEFAULT 1,
    folder TEXT NOT NULL, uid INTEGER NOT NULL DEFAULT 0, subject TEXT NOT NULL DEFAULT '',
    from_addr TEXT NOT NULL DEFAULT '', from_name TEXT NOT NULL DEFAULT '',
    date TEXT NOT NULL DEFAULT '', snippet TEXT NOT NULL DEFAULT '', summary TEXT,
    seen INTEGER NOT NULL DEFAULT 0, answered INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0, thread_key TEXT NOT NULL DEFAULT '', category TEXT);
  CREATE TABLE IF NOT EXISTS outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT, reply_to_db_id INTEGER, status TEXT NOT NULL DEFAULT 'scheduled');
  CREATE TABLE IF NOT EXISTS order_cache (message_pk INTEGER PRIMARY KEY, json TEXT, at TEXT NOT NULL DEFAULT '');
  CREATE TABLE IF NOT EXISTS products (
    code TEXT PRIMARY KEY, title_cz TEXT NOT NULL DEFAULT '', price_num REAL);
  CREATE TABLE IF NOT EXISTS product_variants (
    code TEXT PRIMARY KEY, product_code TEXT NOT NULL DEFAULT '', label TEXT NOT NULL DEFAULT '',
    price TEXT NOT NULL DEFAULT '');
  CREATE TABLE IF NOT EXISTS ig_source_posts (
    ig_media_id TEXT PRIMARY KEY, caption TEXT NOT NULL DEFAULT '', posted_at TEXT NOT NULL DEFAULT '',
    like_count INTEGER NOT NULL DEFAULT 0, comment_count INTEGER NOT NULL DEFAULT 0,
    permalink TEXT NOT NULL DEFAULT '');
  CREATE TABLE IF NOT EXISTS ig_published (
    source_media_id TEXT NOT NULL, lang TEXT NOT NULL, at TEXT NOT NULL DEFAULT '',
    permalink TEXT NOT NULL DEFAULT '', ig_media_id TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (source_media_id, lang));
`);

/*
 * Katalog. Šle mají dvě délky a každá svůj kód — pro otázku „co se prodává"
 * jsou to ale jedny šle, a právě to se tu zkouší.
 */
db.prepare("INSERT INTO products (code, title_cz, price_num) VALUES ('PS120', 'Kšandy červené', 890)").run();
db.prepare("INSERT INTO products (code, title_cz, price_num) VALUES ('QM-042', 'Knoflíčky', 595)").run();
db.prepare("INSERT INTO product_variants (code, product_code, label, price) VALUES ('PS120-110', 'PS120', '110 cm', '890 Kč')").run();
db.prepare("INSERT INTO product_variants (code, product_code, label, price) VALUES ('PS120-120', 'PS120', '120 cm', '890 Kč')").run();

/* ---------- podstrčené moduly ---------- */

// Model se v zkoušce nevolá; sleduje se, s čím by se volal a kolikrát
const asked = [];
let answer = JSON.stringify({
  headline: 'Klidný den, tržba drží.',
  followUp: null,
  notes: [{ kind: 'trend', text: 'Zásilkovna dál vede.' }],
  focus: 'ověřit propad ve čtvrtek',
  questions: ['Proč klesla dobírka?']
});
const aiPath = require.resolve(path.join(DIST, 'ai.js'));
require.cache[aiPath] = { id: aiPath, filename: aiPath, loaded: true, exports: {
  ask: async (model, system, user) => { asked.push({ model, system, user }); return answer; }
} };

const setPath = require.resolve(path.join(DIST, 'settings.js'));
require.cache[setPath] = { id: setPath, filename: setPath, loaded: true, exports: {
  getSettings: () => ({ draftModel: 'zkousky-model', fastModel: 'zkousky-model' })
} };

// Chat je za sítí — tady se jen ověří, že se přehled bez něj postaví
const chatPath = require.resolve(path.join(DIST, 'chat/supabase.js'));
require.cache[chatPath] = { id: chatPath, filename: chatPath, loaded: true, exports: {
  listConversations: async () => []
} };
const cfgPath = require.resolve(path.join(DIST, 'chat/config.js'));
require.cache[cfgPath] = { id: cfgPath, filename: cfgPath, loaded: true, exports: {
  isConfigured: () => false
} };

const dg = require(path.join(DIST, 'digest.js'));

let failed = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${label}`);
  if (!ok) { console.log('      čekáno:', JSON.stringify(want)); console.log('      dostal:', JSON.stringify(got)); }
}

/* ---------- data ---------- */

const NOW = new Date();
const pad = n => String(n).padStart(2, '0');
const dayOf = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const back = days => { const d = new Date(NOW); d.setDate(d.getDate() - days); return d; };
// Přehled srovnává tenhle měsíc s minulým, takže data musí padnout do
// tohoto měsíce — první den v měsíci by jinak zkoušku shodil
const inThisMonth = days => Math.max(0, Math.min(days, NOW.getDate() - 1));

let seq = 0;
function order(one) {
  seq++;
  db.prepare(
    `INSERT INTO shop_orders (code, market, status, paid, created_at, currency, total, email,
       shipment, payment, items_json, postal_json, seen_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    one.code ?? `o${seq}`, one.market ?? 'cz', one.status ?? 'Přijata', one.paid === false ? 0 : 1,
    `${one.day}T10:0${seq % 9}:00`, one.currency ?? 'CZK', one.total ?? 1000, one.email ?? '',
    one.shipment ?? 'Zásilkovna Výdejní místo - Libuň', one.payment ?? 'Platba kartou online',
    JSON.stringify(one.items ?? [{ code: 'QP-118', title: 'Pásek hnědý', quantity: 1, price: 1000 }]),
    JSON.stringify({ country: one.country ?? 'cz' }), NOW.toISOString()
  );
}

const today = dayOf(NOW);
const yesterday = dayOf(back(1));

/*
 * Hlavní okno jsou **klouzavé dny**, ne kalendářní měsíc — prvního v měsíci
 * by se srovnával jeden den s jedním dnem a vycházely by nesmysly. Data jsou
 * proto rozdaná podle „před kolika dny", ne podle data v měsíci.
 */
order({ day: today, total: 1200, email: 'jana@seznam.cz',
  items: [{ code: 'QP-118', title: 'Pásek hnědý', quantity: 1, price: 1200, total: 1200 }] });
/*
 * Šle ve dvou délkách. Pod „co se prodává" patří k jednomu produktu,
 * ve velikostech zvlášť — a dárek bez ceny se dopočítá z ceníku.
 */
order({ day: today, total: 1780, email: 'karel@seznam.cz',
  items: [
    { code: 'PS120-110', title: 'Kšandy červené 110', quantity: 1, price: 890, total: 890 },
    { code: 'PS120-120', title: 'Kšandy červené 120', quantity: 1, price: 890, total: 890 },
    { code: 'QM-042', title: 'Knoflíčky (dárek)', quantity: 1, price: 0, total: 0 }
  ] });
// Eura se do korunové tržby nesmí připsat — osm eur u pásku z něj dělalo
// zboží za 32 Kč
order({ day: today, total: 800, currency: 'EUR', country: 'sk', shipment: 'Packeta CZ',
  items: [{ code: 'QP-118', title: 'Pásek hnědý', quantity: 1, price: 8, total: 8 }] });
// Storno se do tržby nesmí dostat, ale spočítat se musí
order({ day: today, total: 5000, status: 'Stornována' });
order({ day: yesterday, total: 1000, paid: false, payment: 'Dobírka', shipment: 'PPL ParcelShop',
  items: [{ code: 'QM-042', title: 'Knoflíčky', quantity: 1, price: 1000, total: 1000 }] });
// Dva kusy na jednom řádku: bere se cena za řádek, ne za kus krát počet
order({ day: yesterday, total: 2000, email: 'jana@seznam.cz',
  items: [{ code: 'QP-118', title: 'Pásek hnědý', quantity: 2, price: 1000, total: 2000 }] });
order({ day: dayOf(back(3)), total: 900,
  items: [{ code: 'QM-042', title: 'Knoflíčky', quantity: 1, price: 900, total: 900 }] });
// Výplň, ať je okno dost velké na signály, které se pod deseti objednávkami
// schválně nepočítají
for (let i = 5; i <= 12; i++) {
  order({ day: dayOf(back(i)), total: 1000, payment: 'Dobírka', shipment: 'PPL ParcelShop',
    items: [{ code: 'QM-042', title: 'Knoflíčky', quantity: 1, price: 1000, total: 1000 }] });
}
// Jana u nás nakoupila i před třemi týdny — teprve tím je vracející se
// zákazník; dvě objednávky do dvou dnů jsou jeden nákup, ne návrat
order({ day: dayOf(back(20)), total: 700, email: 'jana@seznam.cz',
  items: [{ code: 'QM-042', title: 'Knoflíčky', quantity: 1, price: 700, total: 700 }] });

// Předchozích třicet dní — s čím se okno srovnává
for (let i = 0; i < 12; i++) {
  order({ day: dayOf(back(35 + i)), total: 1000,
    items: [{ code: 'QM-042', title: 'Knoflíčky', quantity: 1, price: 1000, total: 1000 }] });
}

console.log('\nčísla z feedu:\n');
const facts = dg.digestFacts(NOW);
check('dnešní objednávky i se stornem', facts.today.orders, 4);
check('storno se počítá zvlášť', facts.today.cancelled, 1);
// 1200 Kč + 800 EUR; stornovaných 5000 Kč se do tržby nedostane
check('a do tržby nespadne', facts.today.revenue, [{ currency: 'CZK', amount: 2980 }, { currency: 'EUR', amount: 800 }]);
check('koruny se nesčítají s eury', facts.currency, 'CZK');
check('včerejšek zvlášť', facts.yesterday.orders, 2);
check('nezaplacené se počítají', facts.yesterday.unpaid, 1);

// Okno: 3 dnes + 2 včera + 1 před třemi dny + 8 výplně
check('hlavní okno je posledních 30 dní', facts.window.orders, 16);
check('a srovnává se s předchozími třiceti', facts.prevWindow.orders, 12);
check('kalendářní měsíc zůstává jako údaj', typeof facts.month.orders, 'number');
check('i s tím, kolikátého je', facts.monthDays, NOW.getDate());

check('graf má třicet dní', facts.days.length, 30);
check('a poslední je dnešek', facts.days[29].day, today);
check('země se sečtou za okno', facts.countries.map(one => [one.key, one.orders]), [['CZ', 15], ['SK', 1]]);
// Výdejny se slučují po dopravcích — jinak by tu byla jedna položka na pobočku
check('doprava po dopravcích', facts.shipments.map(one => one.key).sort(), ['PPL', 'Zásilkovna']);
check('platba taky', facts.payments.map(one => one.key).sort(), ['Dobírka', 'Karta']);

const pasek = facts.products.find(one => one.code === 'QP-118');
check('nejprodávanější sečte kusy', pasek.qty, 4);
check('a objednávky počítá po jedné', pasek.orders, 3);
/*
 * Tržba u zboží: 1200 (jeden kus) + 2000 (dva kusy na jednom řádku, cena za
 * řádek se nenásobí ještě jednou) a osm eur se nepřipočítá vůbec.
 */
check('tržba u zboží nemíchá měny a nenásobí řádek', pasek.revenue, 3200);
/*
 * Nákupy, ne objednávky. Jana objednala dnes i včera — to je jeden nákup,
 * ne návrat; vracejícím se zákazníkem ji dělá až nákup před třemi týdny.
 * Přesně tohle dřív dělalo z e-shopu samé „vracející se" zákazníky.
 */
check('dvě objednávky do dvou dnů jsou jeden nákup', facts.duplicates, 1);
check('a nákupů je o ten jeden míň', facts.purchases, facts.window.orders - facts.window.cancelled - 1);
check('vracející se zákazník', facts.returning, 2);

/* ---------- varianty, velikosti a ceník ---------- */

console.log('\nvarianty a ceník:\n');
const ksandy = facts.products.find(one => one.code === 'PS120');
check('dvě délky jsou jedny šle', ksandy?.qty, 2);
check('a je vidět, které to byly', ksandy?.variants.map(one => one.label).sort(), ['110 cm', '120 cm']);
check('velikost se sleduje napříč zbožím', facts.sizes.map(one => one.label).sort(), ['110 cm', '120 cm']);
// Dárek přišel bez ceny; nula u nejprodávanějšího zboží vypadá jako chyba,
// tak se vezme cena z ceníku a řekne se, že je to odhad
const knofliky = facts.products.find(one => one.code === 'QM-042');
check('cena z ceníku doplní chybějící', knofliky.revenue > 0, true);
check('a je označená jako odhad', knofliky.estimated, true);
check('stavy objednávek se počítají', facts.statuses.some(one => one.key === 'Stornována'), true);

/* ---------- signály: závěry, které spočítá kód ---------- */

/*
 * Tohle je to, co dřív dělala AI a občas si to vymyslela. Srovnání se počítá
 * v kódu a ke každé větě patří čísla, ze kterých vznikla — bez nich by se
 * nedalo poznat, jestli za tím něco je.
 */
console.log('\nsignály spočítané bez AI:\n');
const signals = facts.signals;
check('každý signál nese podklad', signals.every(one => one.basis && one.text), true);
const growth = signals.find(one => one.text.startsWith('Objednávek'));
check('růst proti předchozím 30 dnům se najde', !!growth, true);
check('a je v něm poměr, ne dojem', growth?.basis, '16 proti 12');
check('posun v platbě se pozná',
  signals.some(one => one.text.startsWith('Platba: Dobírka roste')), true);
check('opakovaný nákup se hlásí vždy',
  signals.some(one => one.text.startsWith('Opakovaně nakupuje')), true);

// Málo dat = žádný trend. Prahy jsou tu proto, aby se ze šumu nedělaly zprávy.
const chudy = dg.signalsOf({
  currency: 'CZK', days: [], window: { orders: 3, cancelled: 0, unpaid: 0, revenue: [], items: 0 },
  prevWindow: { orders: 2, cancelled: 0, unpaid: 0, revenue: [], items: 0 }, returning: 0,
  purchases: 3, duplicates: 0, windowRows: [], prevRows: [], payments: [], shipments: [],
  countries: [], products: [], prevProducts: new Map(), sizes: [],
  history: { months: [], coverage: 0, lastYear: null, rank: null, season: null }, social: null
});
check('ze tří objednávek se trend nedělá', chudy.length, 0);

/* ---------- dlouhodobý kontext a sezóny ---------- */

/*
 * Rok zpátky. Bez něj je „šestnáct objednávek" číslo bez váhy: v lednu je to
 * hodně, v prosinci málo. Sezóna se nehádá podle kalendáře — počítá se index
 * měsíce z **vlastních dat**, takže když e-shop žádnou sezónu nemá, žádná se
 * nenajde.
 */
console.log('\ndlouhodobě:\n');
const historie = require(path.join(DIST, 'digesthistory.js'));

// Čtrnáct uzavřených měsíců; jeden z nich (prosinec) schválně silný
const silny = new Date(NOW.getFullYear(), NOW.getMonth() + 3, 1).getMonth();
for (let back = 1; back <= 14; back++) {
  const month = new Date(NOW.getFullYear(), NOW.getMonth() - back, 15);
  const kolik = month.getMonth() === silny ? 40 : 8;
  for (let i = 0; i < kolik; i++) {
    const day = new Date(month.getFullYear(), month.getMonth(), 1 + (i % 26));
    order({ day: dayOf(day), total: 1000, email: `stary${back}-${i}@seznam.cz`,
      items: [{ code: 'QM-042', title: 'Knoflíčky', quantity: 1, price: 1000, total: 1000 }] });
  }
}

const pohled = historie.historyView(16, 'CZK', NOW);
check('měsíce se drží po jednom', pohled.months.length > 12, true);
check('rozdělaný měsíc se pozná', pohled.months[pohled.months.length - 1].complete, false);
check('a jde říct, kolikátý je současné okno', pohled.rank !== null, true);
check('loňské okno se dohledá', pohled.lastYear !== null, true);
// Silný měsíc je za tři měsíce — má se ozvat dopředu, ne až v něm
check('sezóna se najde z vlastních dat', !!pohled.season, true);
check('a řekne, do kdy se chystat', /chystat se má do \d+\. \d+\./.test(pohled.season?.text ?? ''), true);

// Cache: uzavřené měsíce se nepočítají znovu
const znovu = historie.monthlyStats(13);
check('uzavřené měsíce se berou z tabulky',
  db.prepare('SELECT COUNT(*) AS n FROM digest_months').get().n >= 12, true);
check('a vyjdou stejně', znovu.length, pohled.months.length);

/* ---------- sociální sítě ---------- */

/*
 * Souvislost, ne důkaz. Spočítat jde jen to, jestli ve dnech s příspěvkem
 * chodilo víc objednávek — příspěvek se často pouští právě tehdy, když je
 * co nabídnout, a tak se to i píše.
 */
console.log('\nsociální sítě:\n');
const social = require(path.join(DIST, 'digestsocial.js'));
db.prepare(`INSERT INTO ig_source_posts (ig_media_id, caption, posted_at, like_count, comment_count, permalink)
            VALUES ('m1', 'Nové kšandy', ?, 120, 8, 'https://instagram.com/p/1')`).run(`${today}T09:00:00Z`);
db.prepare(`INSERT INTO ig_source_posts (ig_media_id, caption, posted_at, like_count, comment_count, permalink)
            VALUES ('m2', 'Starší příspěvek', ?, 30, 1, '')`).run(`${dayOf(back(10))}T09:00:00Z`);

// Řada dnů chodí od nejstaršího, stejně jako v grafu
const dny = [
  { day: dayOf(back(2)), orders: 2 },
  { day: yesterday, orders: 2 },
  { day: today, orders: 6 }
];
const site = social.socialView(dny, 30);
check('příspěvky okna se spočítají', site.posts, 1);
check('starší se počítá zvlášť', site.prevPosts, 1);
check('lajky i komentáře', [site.likes, site.comments], [120, 8]);
check('den s příspěvkem se srovná s ostatními', [site.ordersWithPost, site.ordersWithout], [6, 2]);

/* ---------- co čeká na vyřízení ---------- */

console.log('\nco čeká na vyřízení:\n');
const hours = n => new Date(Date.now() - n * 3600e3).toISOString();
function mail(one) {
  db.prepare(
    `INSERT INTO messages (id, folder, subject, from_addr, from_name, date, snippet,
       answered, archived, thread_key, category)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(one.id, one.folder ?? 'INBOX', one.subject ?? 'Dotaz', one.from ?? 'zak@seznam.cz',
    one.name ?? 'Zákazník', one.date, one.snippet ?? '', one.answered ? 1 : 0,
    one.archived ? 1 : 0, one.thread ?? `t${one.id}`, one.category ?? 'people');
}

mail({ id: 1, date: hours(5), subject: 'Kdy dorazí zásilka?' });
/*
 * Tohle je ta chyba z provozu: zákazník se ptal, odpovědělo se mu — ale
 * z jiného zařízení, takže příznak „zodpovězeno" u zprávy zůstal nulový.
 * Přehled to přesto nesmí nabízet, protože ve vlákně je odchozí zpráva.
 */
mail({ id: 2, date: hours(6), subject: 'Reklamace pásku', thread: 'vyrizeno' });
mail({ id: 3, folder: 'Odeslaná pošta', date: hours(2), subject: 'Re: Reklamace pásku', thread: 'vyrizeno' });
mail({ id: 4, date: hours(7), subject: 'Vyřízeno ručně', archived: true });
mail({ id: 5, date: hours(8), subject: 'Odpověď čeká ve frontě' });
db.prepare("INSERT INTO outbox (reply_to_db_id, status) VALUES (5, 'scheduled')").run();
mail({ id: 6, date: hours(9), subject: 'Newsletter týdne', category: 'other' });
// Dvě zprávy v jednom vlákně jsou jedna věc k vyřízení, ne dvě
mail({ id: 7, date: hours(10), subject: 'Urgence', thread: 'dvakrat' });
mail({ id: 8, date: hours(4), subject: 'Urgence — ještě jednou', thread: 'dvakrat' });
mail({ id: 9, date: hours(3), subject: 'Zásilka nedorazila', name: 'Naštvaný' });

const tasks = dg.mailTasks();
const ids = tasks.map(one => one.id);
check('zpráva bez odpovědi se nabídne', ids.includes('1'), true);
check('vyřízená odpovědí ve vlákně už ne', ids.includes('2'), false);
check('archivovaná taky ne', ids.includes('4'), false);
check('ani ta s odpovědí ve frontě', ids.includes('5'), false);
check('newsletter se neřeší', ids.includes('6'), false);
check('z jednoho vlákna jeden řádek', ids.filter(id => ['7', '8'].includes(id)).length, 1);
check('naléhavé jde nahoru', tasks[0].subject, 'Zásilka nedorazila');
check('a je označené', tasks[0].urgent, true);

/* ---------- postřehy jednou za den ---------- */

(async () => {
  console.log('\npostřehy a paměť:\n');
  const first = await dg.digestReport();
  check('poprvé se model zeptá', asked.length, 1);
  check('postřeh se rozebere na body', first.insight.headline, 'Klidný den, tržba drží.');
  check('i s otázkami k doptání', first.insight.questions, ['Proč klesla dobírka?']);
  check('a s poznámkou pro sebe na příště', first.insight.focus, 'ověřit propad ve čtvrtek');
  check('čísla jsou vždy čerstvá', first.facts.today.orders, 4);
  check('chat bez nastavení přehled neshodí', first.chatError, null);

  const second = await dg.digestReport();
  check('podruhé už se neptá', asked.length, 1);
  check('a ukáže se uložený postřeh', second.insight.headline, 'Klidný den, tržba drží.');
  check('ví se, kdy bude nový', typeof second.nextInsightAt, 'string');

  /*
   * Postřeh bez jediného bodu se považuje za nepovedený a zkusí se znovu —
   * proto má i tenhle druhý pokus bod. Bez něj by se volání počítala dvě.
   */
  answer = JSON.stringify({
    headline: 'Druhý pohled.', followUp: 'Čtvrtek byl svátek.',
    notes: [{ kind: 'trend', text: 'Dobírka roste.', basis: '9 z 14' }], focus: null, questions: []
  });
  const forced = await dg.digestReport(true);
  check('tlačítko postřeh přegeneruje', asked.length, 2);
  check('a nový nahradí starý', forced.insight.headline, 'Druhý pohled.');
  // Paměť je to hlavní, kvůli čemu se postřehy ukládají — bez ní by každý
  // den začínal od nuly a AI by dokola psala totéž
  check('do zadání jde, co bylo minule', asked[1].user.includes('Klidný den, tržba drží.'), true);
  check('včetně toho, co si chtěla ověřit', asked[1].user.includes('ověřit propad ve čtvrtek'), true);

  /*
   * Nedopsaná odpověď. Model narazí na strop tokenů a JSON zůstane rozseknutý
   * uprostřed věty — na telefonu se pak v okně objevil celý surový JSON
   * i se závorkami. Vytahat z něj hotové kusy jde a **žádná složená závorka
   * se nesmí dostat na obrazovku**.
   */
  console.log('\nnedopsaná odpověď:\n');
  const utrzeny = '{"headline":"Září roste o 15 %.","followUp":null,"notes":'
    + '[{"kind":"trend","text":"Karta stoupla na 60 % objednávek.","basis":"58 z 96"},'
    + '{"kind":"pozor","text":"Jedenáct nezaplacených čeká déle než tři dny.","basis":"19 400 Kč"},'
    + '{"kind":"napad","text":"K pásku nabídnout kšandy v setu — nez';
  const zachranene = dg.parseInsight(utrzeny, 'zkousky-model');
  check('z nedopsaného JSONu se vytáhne souhrn', zachranene.headline, 'Září roste o 15 %.');
  check('i hotové body', zachranene.notes.map(one => one.kind), ['trend', 'pozor']);
  check('a jejich podklad', zachranene.notes[0].basis, '58 z 96');
  check('rozepsaný bod se zahodí',
    zachranene.notes.some(one => one.text.includes('kšandy')), false);
  check('surový JSON se do okna nedostane', zachranene.headline.startsWith('{'), false);

  // Když se model formátem mine úplně, ukáže se text — ale zase bez závorek
  const holyText = dg.parseInsight('Prodej roste.\n- Karta vede.', 'zkousky-model');
  check('prostý text se taky použije', holyText.headline, 'Prodej roste.');
  check('a odrážka se z něj sundá', holyText.notes[0].text, 'Karta vede.');

  /*
   * Archiv a PDF. Postřeh se nedá spočítat znovu — vznikl nad čísly, která
   * platila tehdy — takže se drží a dá se v něm listovat půl roku zpátky.
   */
  console.log('\nstarší přehledy a PDF:\n');
  const seznam = dg.digestArchive();
  check('uložené přehledy se dají vypsat', seznam.length >= 1, true);
  check('a je u nich vidět souhrn', typeof seznam[0].headline, 'string');
  const jeden = dg.digestFromArchive(seznam[0].at);
  // Uložená čísla jsou ta, která platila při vzniku postřehu — ne dnešní
  check('starší přehled se dohledá i s čísly', typeof jeden?.facts?.window?.orders, 'number');
  /*
   * Uložená čísla jsou ta z chvíle, kdy postřeh vznikl. V téhle zkoušce
   * mezitím přibyla historie, takže se dnešnímu oknu rovnat nemají — a to je
   * přesně to, co má archiv umět: ukázat, jak to vypadalo tehdy.
   */
  check('a drží stav z té chvíle, ne dnešní', jeden.facts.window.orders !== facts.window.orders, true);

  const pdf = require(path.join(DIST, 'digestpdf.js'));
  const html = pdf.digestHtml(facts, jeden.insight, seznam[0].at);
  check('do PDF jde i graf', html.includes('<svg'), true);
  check('a čísla z okna', html.includes(String(facts.window.orders)), true);
  // Názvy zboží chodí z feedu, takže se do stránky nesmí dostat jako HTML
  const zavadny = { ...facts, products: [{ code: 'X', title: '<script>zle()</script>',
    qty: 1, orders: 1, revenue: 1, estimated: false, variants: [] }] };
  check('název zboží se do stránky nedostane jako kód',
    pdf.digestHtml(zavadny, null, seznam[0].at).includes('<script>zle()'), false);

  const answerText = await dg.digestAsk('Jak jsme na tom se stornem?');
  check('doptat se jde nad týmiž čísly', asked.length, 3);
  check('a odpověď se vrátí', typeof answerText, 'string');
  check('v zadání jsou i čekající zprávy', asked[2].user.includes('Čeká na vyřízení'), true);

  console.log(failed ? `\n✗ ${failed} zkoušek selhalo\n` : '\n✓ přehled dne sedí\n');
  process.exit(failed ? 1 : 0);
})();
