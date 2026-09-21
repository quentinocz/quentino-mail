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
    code TEXT PRIMARY KEY, title_cz TEXT NOT NULL DEFAULT '', price_num REAL,
    category TEXT NOT NULL DEFAULT '');
  CREATE TABLE IF NOT EXISTS product_variants (
    code TEXT PRIMARY KEY, product_code TEXT NOT NULL DEFAULT '', label TEXT NOT NULL DEFAULT '',
    price TEXT NOT NULL DEFAULT '');
  CREATE TABLE IF NOT EXISTS ig_source_posts (
    ig_media_id TEXT PRIMARY KEY, caption TEXT NOT NULL DEFAULT '', posted_at TEXT NOT NULL DEFAULT '',
    like_count INTEGER NOT NULL DEFAULT 0, comment_count INTEGER NOT NULL DEFAULT 0,
    permalink TEXT NOT NULL DEFAULT '');
  CREATE TABLE IF NOT EXISTS ig_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ig_media_id TEXT, fb_post_id TEXT);
  CREATE TABLE IF NOT EXISTS ig_published (
    source_media_id TEXT NOT NULL, lang TEXT NOT NULL, at TEXT NOT NULL DEFAULT '',
    permalink TEXT NOT NULL DEFAULT '', ig_media_id TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (source_media_id, lang));
`);

/*
 * Katalog. Šle mají dvě délky a každá svůj kód — pro otázku „co se prodává"
 * jsou to ale jedny šle, a právě to se tu zkouší.
 */
db.prepare("INSERT INTO products (code, title_cz, price_num, category) VALUES ('PS120', 'Kšandy červené', 890, 'Kšandy')").run();
db.prepare("INSERT INTO products (code, title_cz, price_num, category) VALUES ('QM-042', 'Knoflíčky', 595, 'Doplňky')").run();
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
/*
 * Postřehy jdou přes `askLong` — dlouhá odpověď se dopisuje druhým voláním,
 * aby se rozbor nezasekl na stropu tokenů. Doptávání používá `ask`.
 */
require.cache[aiPath] = { id: aiPath, filename: aiPath, loaded: true, exports: {
  ask: async (model, system, user) => { asked.push({ model, system, user }); return answer; },
  askLong: async (model, system, user) => { asked.push({ model, system, user }); return answer; }
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
/*
 * Kapesníček se prodává **jen do zahraničí**. Dřív z něj v korunovém sloupci
 * byla nula a z nuly v postřezích tvrzení, že se prodává zadarmo — přitom
 * je v objednávce za 14 €.
 */
order({ day: today, total: 1400, currency: 'EUR', country: 'de', code: '023748',
  items: [{ code: 'QH-009', title: 'Bílý pánský kapesníček', quantity: 1, price: 14, total: 14 }] });
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
check('dnešní objednávky i se stornem', facts.today.orders, 5);
check('storno se počítá zvlášť', facts.today.cancelled, 1);
// 1200 Kč + 800 EUR; stornovaných 5000 Kč se do tržby nedostane
check('a do tržby nespadne', facts.today.revenue, [{ currency: 'CZK', amount: 2980 }, { currency: 'EUR', amount: 2200 }]);
check('koruny se nesčítají s eury', facts.currency, 'CZK');
check('včerejšek zvlášť', facts.yesterday.orders, 2);
check('nezaplacené se počítají', facts.yesterday.unpaid, 1);

// Okno: 3 dnes + 2 včera + 1 před třemi dny + 8 výplně
check('hlavní okno je posledních 30 dní', facts.window.orders, 17);
check('a srovnává se s předchozími třiceti', facts.prevWindow.orders, 12);
check('kalendářní měsíc zůstává jako údaj', typeof facts.month.orders, 'number');
check('i s tím, kolikátého je', facts.monthDays, NOW.getDate());

check('graf má třicet dní', facts.days.length, 30);
check('a poslední je dnešek', facts.days[29].day, today);
check('země se sečtou za okno', facts.countries.map(one => [one.key, one.orders]), [['CZ', 15], ['DE', 1], ['SK', 1]]);
// Výdejny se slučují po dopravcích — jinak by tu byla jedna položka na pobočku
check('doprava po dopravcích', facts.shipments.map(one => one.key).sort(), ['PPL', 'Zásilkovna']);
check('platba taky', facts.payments.map(one => one.key).sort(), ['Dobírka', 'Karta']);

const pasek = facts.products.find(one => one.code === 'QP-118');
check('nejprodávanější sečte kusy', pasek.qty, 4);
check('a objednávky počítá po jedné', pasek.orders, 3);
/*
 * Tržba u zboží: 1200 (jeden kus) + 2000 (dva kusy na jednom řádku, cena za
 * řádek se nenásobí ještě jednou). Eura se do korunového sloupce nepřičtou,
 * ale **nesmí zmizet** — z nuly u zboží prodávaného do zahraničí se
 * v postřezích stalo „prodává se zadarmo".
 */
check('tržba u zboží nemíchá měny a nenásobí řádek', pasek.revenue, 3200);
check('a cizí měna se drží zvlášť, ne v nule',
  pasek.revenueAll, [{ currency: 'CZK', amount: 3200 }, { currency: 'EUR', amount: 8 }]);
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
/*
 * Velikosti se sledují **uvnitř kategorie**: délka kšand a šířka kravaty
 * jsou dvě různé věci a sečíst je dohromady je nesmysl.
 */
check('velikosti jsou po kategoriích', facts.sizes.map(one => one.category), ['Kšandy']);
check('a uvnitř kategorie sedí', facts.sizes[0]?.sizes.map(one => one.label).sort(), ['110 cm', '120 cm']);
// Dárek přišel bez ceny; nula u nejprodávanějšího zboží vypadá jako chyba,
// tak se vezme cena z ceníku a řekne se, že je to odhad
const knofliky = facts.products.find(one => one.code === 'QM-042');
check('cena z ceníku doplní chybějící', knofliky.revenue > 0, true);
check('a je označená jako odhad', knofliky.estimated, true);
/*
 * Zboží prodané jen v eurech: v korunách nemá co ukázat, ale cenu známe.
 * Nula by se v postřezích četla jako „prodává se zadarmo".
 */
const kapesnik = facts.products.find(one => one.code === 'QH-009');
check('zboží prodané jen v eurech není zadarmo',
  [kapesnik?.revenue, kapesnik?.revenueAll, kapesnik?.priceSource],
  [0, [{ currency: 'EUR', amount: 14 }], 'jiná měna']);
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
check('a je v něm poměr, ne dojem', growth?.basis, '17 proti 12');
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
/*
 * Samotné „prosinec bývá silný" se nedá použít. K sezóně proto patří i to,
 * kdy začíná, dokdy zahájit propagaci a co se v ní prodávalo.
 */
check('a řekne, dokdy zahájit propagaci',
  /propagaci zahájit do \d+\. \d+\./.test(pohled.season?.text ?? ''), true);
check('a jak je daleko', typeof pohled.season?.inDays, 'number');
check('má i jméno sezóny', typeof pohled.season?.name, 'string');
check('a co se v ní prodávalo', Array.isArray(pohled.season?.products), true);
/*
 * Období se hlásí tři a vždycky. Dřív se ukazovalo jen to, co překročilo
 * hranici — a e-shopu, kterému vychází silně jen jeden měsíc, zbyla jedna
 * osamělá věta a nejbližší Vánoce pod stolem, protože o kousek nedosáhly.
 * Otázka přitom nezní „je prosinec nadprůměrný", ale „co mě čeká nejdřív".
 */
check('období se hlásí tři', pohled.seasons.length, 3);
check('a jsou seřazená podle data',
  pohled.seasons.every((one, i) => i === 0 || one.month > pohled.seasons[i - 1].month), true);
check('u každého je vidět, jestli je to sezóna',
  pohled.seasons.every(one => typeof one.strong === 'boolean'), true);
check('slabší období mezi nimi být smí', pohled.seasons.some(one => !one.strong), true);
check('a jako sezóna se hlásí jen to silné', pohled.season?.strong, true);
/*
 * Období, které z průměru nevybočuje, nepatří mezi „čísla, co stojí za
 * pozornost" — karta o něm říct může, signál ne.
 */
const slabe = pohled.seasons.find(one => !one.strong);
check('a slabé se do signálů nedostane',
  dg.digestFacts(NOW).signals.some(one => one.text.includes(slabe.name)), false);
/*
 * Když sezóna není, nesmí zůstat prázdné místo: z ničeho se nepozná, jestli
 * se nepočítalo, nebo jestli fakt žádná nepřichází.
 */
const bezSezony = historie.historyView(16, 'CZK', new Date(NOW.getTime() - 120 * 86400000));
check('bez sezóny se řekne proč',
  !bezSezony.season ? (bezSezony.seasonNote ?? '').length > 20 : true, true);

// Cache: uzavřené měsíce se nepočítají znovu (přehled si jich bere dva roky)
const znovu = historie.monthlyStats(25);
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
  /*
   * Otevření okna samo nic negeneruje. Dřív se postřehy spustily, jakmile
   * byly starší než den — okno se otevřelo a dvacet vteřin se čekalo,
   * i když se člověk chtěl jen podívat na včerejšek.
   */
  const open = await dg.digestReport();
  check('otevření okna se modelu neptá', asked.length, 0);
  check('ale řekne, že dnešní chybí', open.insightStale, true);
  check('čísla jsou vždy čerstvá', open.facts.today.orders, 5);
  check('chat bez nastavení přehled neshodí', open.chatError, null);

  const first = await dg.digestReport(true);
  check('tlačítko postřeh sestaví', asked.length, 1);
  check('postřeh se rozebere na body', first.insight.headline, 'Klidný den, tržba drží.');
  check('i s otázkami k doptání', first.insight.questions, ['Proč klesla dobírka?']);
  check('a s poznámkou pro sebe na příště', first.insight.focus, 'ověřit propad ve čtvrtek');

  const second = await dg.digestReport();
  check('podruhé už se neptá', asked.length, 1);
  check('a ukáže se uložený postřeh', second.insight.headline, 'Klidný den, tržba drží.');
  check('čerstvý přehled se znovu nenabízí', second.insightStale, false);
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
   * Uložená čísla jsou ta z chvíle, kdy postřeh vznikl. Přibude objednávka —
   * dnešní okno o ní ví, archiv ne. To je přesně to, co má archiv umět:
   * ukázat, jak to vypadalo tehdy.
   */
  const tehdy = jeden.facts.window.orders;
  order({ day: today, total: 1111, email: 'pozdeji@seznam.cz' });
  check('a drží stav z té chvíle, ne dnešní',
    [dg.digestFacts().window.orders > tehdy, dg.digestFromArchive(seznam[0].at).facts.window.orders],
    [true, tehdy]);
  /*
   * Do archivu jde **celý** přehled, ne jen hrstka souhrnů. Bez včerejška,
   * grafu dnů a signálů okno na starším přehledu padalo na šedou plochu.
   */
  check('a je v něm všechno, na co se okno ptá',
    [typeof jeden.facts.yesterday?.orders, Array.isArray(jeden.facts.days),
      Array.isArray(jeden.facts.signals), Array.isArray(jeden.facts.sizes)],
    ['number', true, true, true]);

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

  /* ---------- události, které čísla vysvětlují ---------- */

  /*
   * Dovolená a akce se do čísel propíšou samy, ale **proč** to tak je, ví
   * jen člověk. Zkouší se, že se z jeho zápisu spočítá rozdíl proti
   * běžnému provozu — na tom stojí odpověď na otázku „o kolik přijdu,
   * když zavřu na týden".
   */
  const ev = require(path.join(DIST, 'events.js'));

  /*
   * Schválně dávno: zkouška si musí hlídat vlastní čísla a v posledních
   * dvou letech leží objednávky z jiných částí téhle zkoušky (dlouhodobý
   * pohled jich rozdává celý rok). Ty by se do základu připletly a rozdíl
   * by vycházel jinak.
   */
  const den = (posun) => {
    const d = new Date('2019-06-01T12:00:00Z');
    d.setDate(d.getDate() + posun);
    return d.toISOString().slice(0, 10);
  };
  // Čtyři týdny běžného provozu: dvě objednávky denně po tisíci
  for (let back = 35; back >= 8; back--) {
    for (let i = 0; i < 2; i++) {
      db.prepare(
        `INSERT INTO shop_orders (code, market, status, created_at, currency, total)
         VALUES (?, 'cz', 'Vyřízeno', ?, 'CZK', 1000)`
      ).run(`B${back}-${i}`, `${den(-back)}T10:00:00`);
    }
  }
  // Týden dovolené: nic
  ev.saveEvent({ kind: 'dovolena', title: 'Dovolená', from: den(-7), to: den(-1) });
  // A jednodenní akce ještě dřív, ať je vidět, že se počítá i jeden den
  ev.saveEvent({ kind: 'akce', title: 'Sleva 20 %', from: den(-40), to: den(-40), note: 'newsletter' });

  const udalosti = ev.eventsWithImpact('CZK', den(0));
  const dovolena = udalosti.find(one => one.title === 'Dovolená');
  check('dovolená se spočítá na dny', dovolena.days, 7);
  check('v jejích dnech se neprodalo nic', dovolena.orders, 0);
  check('a proti běžnému dni je to propad', dovolena.deltaPct, -100);
  check('odhad ztráty je za celé období', dovolena.moneyDiff, -14000);

  // Otočené datum se narovná — kdo píše „od 20. do 15.", myslel to naopak
  ev.saveEvent({ kind: 'jine', title: 'Otočená', from: den(-3), to: den(-9) });
  const otocena = ev.eventsWithImpact('CZK', den(0)).find(one => one.title === 'Otočená');
  check('otočené datum se narovná', [otocena.from < otocena.to, otocena.days], [true, 7]);

  // Bez názvu se neuloží: za rok by nikdo nepoznal, co to bylo
  let zamitnuto = '';
  try { ev.saveEvent({ kind: 'akce', title: '  ', from: den(-2) }); }
  catch (e) { zamitnuto = e.message; }
  check('událost bez názvu se neuloží', zamitnuto.includes('název'), true);

  const proAi = ev.eventsForAi('CZK');
  check('do zadání pro model jde název', proAi.includes('Dovolená'), true);
  check('i spočítaný rozdíl v penězích', proAi.includes('-14000'), true);
  check('i poznámka u akce', proAi.includes('newsletter'), true);

  /* ---------- události mezi zařízeními ---------- */

  /*
   * Zapisuje se tam, kde je člověk zrovna doma — u počítače, nebo z telefonu
   * u kávy. Dokud se události nesdílely, znal dovolenou jen jeden přístroj
   * a na druhém zel v přehledu nevysvětlený propad.
   */
  const odeslane = ev.eventsExport();
  check('k odeslání jde i jméno napříč zařízeními',
    odeslane.every(one => one.uid && one.updatedAt), true);

  /*
   * Cizí zápis. Novější vyhrává — událost je jedna věta a když ji někdo
   * opraví, platí jeho verze celá; slučovat po polích nemá co.
   */
  const cizi = odeslane.find(one => one.title === 'Dovolená');
  const zmena = ev.eventsImport([{ ...cizi, title: 'Dovolená — zavřeno',
    updatedAt: new Date(Date.now() + 1000).toISOString() }]);
  check('novější zápis odjinud přepíše starší', zmena, true);
  check('a je to vidět v seznamu',
    ev.listEvents().some(one => one.title === 'Dovolená — zavřeno'), true);

  // Starší zápis se zahodí, jinak by se opravené názvy vracely zpátky
  check('starší zápis odjinud se zahodí',
    ev.eventsImport([{ ...cizi, title: 'Stará verze', updatedAt: '2019-01-01T00:00:00.000Z' }]), false);

  // Neznámá událost se prostě přidá
  check('neznámá událost se přidá', ev.eventsImport([{
    uid: 'cizi-1', kind: 'akce', title: 'Akce z telefonu', from: den(-50), to: den(-50),
    updatedAt: new Date().toISOString(), createdAt: new Date().toISOString()
  }]), true);
  check('a je v seznamu', ev.listEvents().some(one => one.title === 'Akce z telefonu'), true);

  /*
   * Smazání je značka, ne výmaz. Kdyby se řádek zahodil, přišel by zpátky
   * při první synchronizaci z druhého zařízení, kde o smazání nikdo neví.
   */
  const kSmazani = ev.listEvents().find(one => one.title === 'Akce z telefonu');
  ev.deleteEvent(kSmazani.id);
  check('smazaná se neukazuje', ev.listEvents().some(one => one.id === kSmazani.id), false);
  check('ale odjede jako škrtnutá',
    ev.eventsExport().some(one => one.uid === 'cizi-1' && one.deleted), true);
  check('a nevrátí se zpátky',
    ev.eventsImport([{ uid: 'cizi-1', kind: 'akce', title: 'Akce z telefonu', from: den(-50), to: den(-50),
      updatedAt: '2019-01-01T00:00:00.000Z' }]), false);

  /*
   * A hlavně: události se musí dostat do zadání postřehů. Bez toho model
   * vidí propad a hledá pro něj vysvětlení v datech, kde žádné není.
   */
  const bylo = asked.length;
  await dg.digestReport(true);
  check('události jdou i do postřehů', asked[bylo].user.includes('Dovolená'), true);

  /*
   * Postřeh, který zrovna dorazil z jiného zařízení a je dnešní, stačí —
   * platit totéž podruhé nemá smysl. Tady se jen ověří, že samotné otevření
   * okna model neosloví ani po přijetí cizího postřehu.
   */
  const pred = asked.length;
  await dg.digestReport();
  check('otevření okna se po přijetí cizího postřehu neptá', asked.length, pred);

  console.log(failed ? `\n✗ ${failed} zkoušek selhalo\n` : '\n✓ přehled dne sedí\n');
  process.exit(failed ? 1 : 0);
})();
