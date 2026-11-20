/**
 * Zkouška modulu Reklamy — zisk z objednávek, segmenty, odpovědi Google Ads
 * a sdílení mezi Macy.
 *
 * Čísla v Reklamách rozhodují o penězích, a přitom se na ně nedá podívat
 * „od oka": chyba v DPH, ceně za kus nebo v párování produktů udělá
 * z prodělávající kampaně vydělávající a nikdo si toho nevšimne. Proto se
 * tu každý výpočet ověřuje na ručně spočítaném příkladu.
 *
 *   node tools/ads-test.cjs
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { db, DIST } = require('./ptrans/harness.cjs');

const econ = require(path.join(DIST, 'ads/economics.js'));
const seg = require(path.join(DIST, 'ads/segments.js'));
const google = require(path.join(DIST, 'ads/google.js'));
const store = require(path.join(DIST, 'ads/store.js'));
const schema = require(path.join(DIST, 'ads/schema.js'));
const { DEFAULT_ADS_CONFIG } = require(path.join(DIST, '../shared/ads.js'));

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
const near = (a, b, eps = 0.01) => Math.abs(a - b) < eps;
function close(label, got, want, eps = 0.01) {
  const ok = near(got, want, eps);
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : ` — čekáno ${want}, dostal ${got}`}`);
}

const cfg = JSON.parse(JSON.stringify(DEFAULT_ADS_CONFIG));
cfg.shipping = [
  { name: 'Zásilkovna', cost: 60, guessed: false },
  { name: 'PPL ParcelBox', cost: 55, guessed: false }
];

/* ---------- zisk objednávky ---------- */
console.log('\nZisk objednávky');
const catalog = {
  ps120sr: { product: 'PS120', category: 'Kšandy', purchase: 100, novat: 395.87 },
  set01: { product: 'SET01', category: 'Sety', purchase: null, novat: 500 }
};
const lookup = code => catalog[String(code).toLowerCase()] ?? null;
const order = {
  code: '1', market: 'cz', status: 'Doručeno', createdAt: '2026-11-10T17:47:26+01:00', currency: 'CZK',
  total: 479 * 2 + 69, shipment: 'PPL ParcelBox', shipmentPrice: 69, paymentPrice: 0,
  items: [{ title: 'Kšandy', code: 'PS120SR', quantity: 2, price: 479 }]
};
const m = econ.orderMoney(order, lookup, cfg, () => 0.6);
close('tržba bez DPH = 2 × 479 / 1,21', m.revenue, 958 / 1.21);
close('doprava zaplacená zákazníkem bez DPH', m.fees, 69 / 1.21);
check('nákupní cena 2 × 100', m.purchase, 200);
check('doprava nás stojí 55 Kč', m.shipCost, 55);
close('zisk = tržba + doprava − nákup − doprava', m.profit, 958 / 1.21 + 69 / 1.21 - 200 - 55);
check('den objednávky z místního času', m.date, '2026-11-10');
check('bez odhadu', m.estimated, false);

// Cena za řádek: celkem sedí s 479 (ne 958) → feed uvádí cenu za celý řádek
const lineOrder = { ...order, total: 479 + 69, items: [{ title: 'K', code: 'PS120SR', quantity: 2, price: 479 }] };
close('cena za řádek se pozná podle celkové ceny', econ.orderMoney(lineOrder, lookup, cfg, () => 0.6).revenue, 479 / 1.21);
const unitOrder = { ...order, items: [{ title: 'K', code: 'PS120SR', quantity: 2, price: 479, unitPrice: 479 }] };
close('cena za kus z exportu má přednost', econ.orderMoney(unitOrder, lookup, cfg, () => 0.6).revenue, 958 / 1.21);

// Produkt bez nákupní ceny → marže kategorie
const noPrice = { ...order, total: 605, shipmentPrice: 0, items: [{ title: 'Set', code: 'SET01', quantity: 1, price: 605 }] };
const mn = econ.orderMoney(noPrice, lookup, cfg, cat => (cat === 'Sety' ? 0.7 : 0.1));
close('bez nákupní ceny: nákup = tržba × (1 − marže kategorie)', mn.purchase, 500 * 0.3);
check('a je to označené jako odhad', mn.estimated, true);

// Eura ze slovenského trhu
const sk = { ...order, market: 'sk', currency: 'EUR', total: 40, shipmentPrice: 0,
  items: [{ title: 'K', code: 'PS120SR', quantity: 1, price: 40 }] };
close('euro × kurz / slovenské DPH 23 %', econ.orderMoney(sk, lookup, cfg, () => 0.6).revenue, 40 * 25 / 1.23);

check('storno se nepočítá', econ.isCancelled('Stornováno'), true);
check('vráceno se nepočítá', econ.isCancelled('Vráceno zákazníkem'), true);
check('doručeno se počítá', econ.isCancelled('Doručeno'), false);

console.log('\nDoprava');
check('přesný název', econ.shipCostOf(cfg, 'PPL ParcelBox'), 55);
check('začátek názvu („Zásilkovna" pokryje Z-Box)', econ.shipCostOf(cfg, 'Zásilkovna Z-Box'), 60);
check('e-mailem nic nestojí', econ.shipCostOf(cfg, 'E-mailem'), 0);
check('neznámá doprava = výchozí', econ.shipCostOf(cfg, 'DPD kurýr'), cfg.defaultShipCost);

console.log('\nMarže a cílové PNO');
const mt = econ.marginTable([
  { category: 'A', purchase: 20, novat: 100 }, { category: 'A', purchase: 30, novat: 100 },
  { category: 'A', purchase: 40, novat: 100 }, { category: 'B', purchase: 90, novat: 100 },
  { category: 'B', purchase: null, novat: 100 }
], 0.6);
close('medián kategorie A', mt('A'), 0.7);
close('kategorie s méně než 3 produkty → medián obchodu', mt('B'), 0.65);
close('cílové PNO = marže − podíl zisku', econ.targetPno(0.73, 0.5), 0.23);
check('pod 3 % = cíl nesplnitelný (0)', econ.targetPno(0.52, 0.5), 0);
check('den o 30 dní zpět přes přechod času', econ.shiftDay('2026-11-01', -30), '2026-10-02');

/* ---------- segmenty ---------- */
console.log('\nSegmenty');
const base = { cost: 0, clicks: 0, impressions: 0, conversions: 0, value: 0, margin: 0.7, stock: 10, ageDays: null };
const segs = seg.segmentProducts([
  { ...base, code: 'STAR', cost: 500, clicks: 100, impressions: 5000, conversions: 10, value: 8000 },
  { ...base, code: 'WORK', cost: 200, clicks: 40, impressions: 2000, conversions: 2, value: 1000 },
  { ...base, code: 'EAT', cost: 300, clicks: 80, impressions: 3000 },
  { ...base, code: 'LOSS', cost: 900, clicks: 60, impressions: 3000, conversions: 1, value: 500, margin: 0.4 },
  { ...base, code: 'SLEEP', impressions: 40 },
  { ...base, code: 'NEW', cost: 300, clicks: 80, ageDays: 5 },
  { ...base, code: 'OUT', cost: 300, clicks: 80, stock: 0 },
  { ...base, code: 'LOW', cost: 20, clicks: 4, conversions: 1, value: 400, stock: 2 },
  // 25 kliků bez prodeje: při poměru ~3,4 % by se čekala necelá jedna objednávka — ještě náhoda
  { ...base, code: 'EARLY', cost: 60, clicks: 25, impressions: 900 }
], 0.6);
const s = code => segs.get(code).segment;
check('nejvyšší zisk → hvězda', s('STAR'), 'hvezdy');
check('prodává se ziskem → pracant', s('WORK'), 'pracanti');
check('80 kliků bez prodeje → žrout', s('EAT'), 'zrouti');
check('prodává, ale reklama dražší než marže → žrout', s('LOSS'), 'zrouti');
check('40 zobrazení → spící', s('SLEEP'), 'spici');
check('novinka se nesoudí podle prázdných dat', s('NEW'), 'novinky');
check('vyprodané ven ze všeho', s('OUT'), 'vyprodano');
check('2 kusy skladem → doprodej', s('LOW'), 'doprodej');
check('25 kliků bez prodeje ještě není žrout (může to být náhoda)', s('EARLY'), 'spici');
check('pásmo marže', [seg.marginBand(0.73), seg.marginBand(0.55), seg.marginBand(0.2), seg.marginBand(null)],
  ['marze-70-plus', 'marze-50-70', 'marze-do-30', 'marze-neznama']);
check('doplňkový feed (TSV)', seg.supplementalTsv([{ id: 'PS120', segment: 'hvezdy', band: 'marze-70-plus' }]),
  'id\tcustom_label_0\tcustom_label_1\nPS120\thvezdy\tmarze-70-plus\n');

/* ---------- odpovědi Google Ads ---------- */
console.log('\nGoogle Ads: převod odpovědí');
const camp = google.parseCampaigns([{
  campaign: { id: '123', name: 'PMax CZ', status: 'ENABLED', advertisingChannelType: 'PERFORMANCE_MAX',
    biddingStrategyType: 'MAXIMIZE_CONVERSION_VALUE', maximizeConversionValue: { targetRoas: 4.5 } },
  campaignBudget: { amountMicros: '1040000000' }
}]);
check('kampaň: rozpočet z milióntin, cílové ROAS', [camp[0].budget, camp[0].targetRoas, camp[0].type], [1040, 4.5, 'PERFORMANCE_MAX']);
const days = google.parseCampaignDays([{ campaign: { id: '123' }, segments: { date: '2026-11-18' },
  metrics: { costMicros: '512340000', clicks: '41', impressions: '3011', conversions: 3, conversionsValue: 2870.5 } }]);
check('den kampaně (int64 jako text)', days[0], { date: '2026-11-18', id: '123', cost: 512.34, clicks: 41,
  impressions: 3011, conversions: 3, value: 2870.5 });
const prods = google.parseProductDays([
  { segments: { date: '2026-11-18', productItemId: 'PS120SR' }, metrics: { costMicros: '10000000', clicks: '2', impressions: '50', conversions: 0, conversionsValue: 0 } },
  { segments: { date: '2026-11-18', productItemId: 'ps120sr' }, metrics: { costMicros: '5000000', clicks: '1', impressions: '20', conversions: 1, conversionsValue: 479 } }
]);
check('produkt z PMax i Nákupů se sečte, ID malými', prods, [{ date: '2026-11-18', id: 'ps120sr', cost: 15, clicks: 3,
  impressions: 70, conversions: 1, value: 479 }]);
check('dotaz na produkty omezuje období', /BETWEEN '2026-10-22' AND '2026-11-18'/.test(google.productDaysQuery('2026-10-22', '2026-11-18')), true);
const err = google.explainError(403, { error: { message: 'x', details: [{ errors: [{
  errorCode: { authorizationError: 'CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION' }, message: 'not approved' }] }] } });
check('chyba přístupu projektu má srozumitelnou větu', /Explorer/.test(err), true);
const url = new URL(google.authUrl('cid', 'http://127.0.0.1:5555', 'chal', 'st'));
check('přihlášení: PKCE, offline, adwords', [url.searchParams.get('code_challenge_method'),
  url.searchParams.get('access_type'), url.searchParams.get('scope')],
['S256', 'offline', 'https://www.googleapis.com/auth/adwords']);

/* ---------- nastavení ---------- */
console.log('\nNastavení');
const norm = store.normalizeConfig({ targetProfitShare: '2', vat: { sk: 20 }, google: { customerId: '123' } });
check('podíl zisku se ořízne na 95 %', norm.targetProfitShare, 0.95);
check('DPH se doplní k výchozímu', norm.vat, { cz: 21, sk: 20, en: 21 });
check('chybějící klíče z výchozího', [norm.google.apiVersion, norm.autonomy, norm.markets], ['v26', 'suggest', ['cz']]);

/* ---------- sdílení mezi Macy ---------- */
console.log('\nSdílení mezi Macy');
db.exec(schema.SCHEMA);
const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'reklamy-'));
db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES('syncEnabled','1'),('syncFolder',?)").run(shared);
const row = (date, id, cost) => ({ date, id, cost, clicks: 1, impressions: 10, conversions: 0, value: 0 });
store.saveDays('ads_campaign_day', 'google', '2026-11-01', '2026-11-02',
  [row('2026-11-01', 'A', 100), row('2026-11-02', 'A', 50)], '2026-11-03T03:00:00Z');
store.syncStats('google');
const file = path.join(shared, 'reklamy', 'google-2026-11.json');
check('měsíc se zapsal do sdílené složky', fs.existsSync(file), true);

// Jiný Mac stáhl později: 2. 11. se přepočítal a kampaň B přibyla
const remote = JSON.parse(fs.readFileSync(file, 'utf8'));
remote.days = [
  ['2026-11-01', 'A', 100, 1, 10, 0, 0, '2026-11-03T03:00:00Z'],
  ['2026-11-02', 'A', 55, 1, 10, 0, 0, '2026-11-04T03:00:00Z'],
  ['2026-11-02', 'B', 20, 1, 10, 0, 0, '2026-11-04T03:00:00Z']
];
fs.writeFileSync(file, JSON.stringify(remote));
check('převezme se jen novější den', store.syncStats('google'), 1);
const day2 = db.prepare("SELECT campaign_id, cost FROM ads_campaign_day WHERE date = '2026-11-02' ORDER BY campaign_id").all()
  .map(r => [r.campaign_id, r.cost]);
check('den 2. 11. je celý podle novějšího stažení', day2, [['A', 55], ['B', 20]]);

// Starší cizí data nepřepíšou novější vlastní
remote.days = [['2026-11-02', 'A', 1, 1, 10, 0, 0, '2026-11-01T00:00:00Z']];
fs.writeFileSync(file, JSON.stringify(remote));
store.syncStats('google');
check('starší stažení jiného Macu nic nepřepíše',
  db.prepare("SELECT cost FROM ads_campaign_day WHERE date = '2026-11-02' AND campaign_id = 'A'").get().cost, 55);

// Nastavení: novější vyhrává
store.saveAdsConfig({ targetProfitShare: 0.4 });
store.syncConfig();
const cfgFile = path.join(shared, 'reklamy', 'nastaveni.json');
const remoteCfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
check('nastavení je ve sdílené složce', remoteCfg.config.targetProfitShare, 0.4);
remoteCfg.config.targetProfitShare = 0.55;
remoteCfg.config.updatedAt = new Date(Date.now() + 60_000).toISOString();
fs.writeFileSync(cfgFile, JSON.stringify(remoteCfg));
check('novější nastavení z jiného Macu se převezme', [store.syncConfig(), store.getAdsConfig().targetProfitShare], [true, 0.55]);
check('adresa feedu je náhodná a stálá', /^[0-9a-f]{24}$/.test(store.getAdsConfig().feedToken), true);
// Čerstvě zapnutý Mac (prázdné nastavení) nesmí přepsat sdílené výchozími hodnotami
const sdilene = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
db.prepare("DELETE FROM settings WHERE key = 'adsConfig'").run();
const cerstvy = store.getAdsConfig();
check('nový Mac si vyrobí adresu feedu, ale s prázdným razítkem', [!!cerstvy.feedToken, cerstvy.updatedAt], [true, '']);
store.syncConfig();
check('…a převezme sdílené nastavení i jeho adresu feedu',
  [store.getAdsConfig().targetProfitShare, store.getAdsConfig().feedToken],
  [sdilene.config.targetProfitShare, sdilene.config.feedToken]);

fs.rmSync(shared, { recursive: true, force: true });
db.prepare("UPDATE settings SET value = '0' WHERE key = 'syncEnabled'").run();

/* ---------- celý průchod nad skutečným katalogem ---------- */
/*
 * Katalog e-shopu v repozitáři není (je to celý feed s cenami). Když je po
 * ruce, projde se import nákupních cen i výpočet segmentů nad ním; jinak
 * se tahle část přeskočí — výpočty samotné ověřily části výš.
 */
const feedFile = process.env.ADS_FEED || '/mnt/user-data/uploads/export-full-products.xml';
if (fs.existsSync(feedFile)) {
  console.log('\nCelý průchod nad skutečným katalogem');
  // Tabulky katalogu a objednávek tak, jak je zakládá aplikace
  const src = fs.readFileSync(path.join(__dirname, '../src/main/db.ts'), 'utf8');
  for (const name of ['products', 'product_variants', 'shop_orders']) {
    const sql = new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]*?\\n    \\);`).exec(src)[0]
      .replace(/--[^\n]*/g, '');
    db.exec(sql);
  }
  const alters = /d\.exec\((["'])(ALTER TABLE (?:products|product_variants|shop_orders) ADD COLUMN .*?)\1\)/g;
  for (const match of src.matchAll(alters)) {
    try { db.exec(match[2]); } catch { /* sloupec už je */ }
  }
  const electron = require('electron');
  electron.shell = { openExternal: async () => {} };
  const products = require(path.join(DIST, 'products.js'));
  const count = products.importFeedXml(fs.readFileSync(feedFile, 'utf8'));
  const priced = db.prepare('SELECT COUNT(*) AS n FROM products WHERE purchase IS NOT NULL').get().n;
  const varPriced = db.prepare('SELECT COUNT(*) AS n FROM product_variants WHERE purchase IS NOT NULL').get().n;
  console.log(`    ${count} produktů, nákupní cenu má ${priced} produktů a ${varPriced} variant`);
  check('nákupní ceny se z feedu načetly', priced > count * 0.5, true);
  const ps = db.prepare("SELECT purchase, price_novat FROM products WHERE purchase IS NOT NULL LIMIT 1").get();
  check('cena bez DPH je u produktu s nákupní cenou', ps.price_novat > ps.purchase, true);

  // Objednávka z reálného kódu varianty, včera
  const ads = require(path.join(DIST, 'ads/index.js'));
  const variant = db.prepare(`SELECT v.code, v.product_code, COALESCE(v.purchase, p.purchase) AS purchase,
      COALESCE(v.price_novat, p.price_novat) AS novat
    FROM product_variants v JOIN products p ON p.code = v.product_code
    WHERE COALESCE(v.purchase, p.purchase) IS NOT NULL AND (p.stock IS NULL OR p.stock > 5) LIMIT 1`).get();
  const yesterday = econ.shiftDay(econ.localDay(), -1);
  const price = Math.round(variant.novat * 1.21);
  db.prepare(`INSERT INTO shop_orders (code, market, status, created_at, currency, total, shipment, items_json, ship_price)
    VALUES ('T1', 'cz', 'Vyřizuje se', ?, 'CZK', ?, 'Zásilkovna Z-Box', ?, 79)`)
    .run(`${yesterday}T10:00:00+01:00`, price + 79, JSON.stringify([{ title: 'x', code: variant.code, quantity: 1, price }]));
  db.prepare(`INSERT INTO shop_orders (code, market, status, created_at, currency, total, shipment, items_json, ship_price)
    VALUES ('T2', 'cz', 'Stornováno', ?, 'CZK', 999, 'Zásilkovna Z-Box', '[]', 0)`).run(`${yesterday}T11:00:00+01:00`);
  store.saveAdsConfig({ shipping: [{ name: 'Zásilkovna', cost: 60, guessed: false }], targetProfitShare: 0.5 });

  // Řádky ze zkoušky sdílení by se do období připletly
  db.exec('DELETE FROM ads_campaign_day; DELETE FROM ads_product_day;');
  // Reklama: kampaň a produkt (ID varianty malými, jak ho vrací Google)
  const at = new Date().toISOString();
  store.saveCampaigns('google', [{ id: '9', name: 'PMax', type: 'PERFORMANCE_MAX', status: 'ENABLED', budget: 300,
    bidding: 'MAXIMIZE_CONVERSION_VALUE', targetRoas: null }], at);
  store.saveDays('ads_campaign_day', 'google', yesterday, yesterday,
    [{ date: yesterday, id: '9', cost: 100, clicks: 30, impressions: 900, conversions: 1, value: price }], at);
  store.saveDays('ads_product_day', 'google', yesterday, yesterday,
    [{ date: yesterday, id: variant.code.toLowerCase(), cost: 100, clicks: 30, impressions: 900, conversions: 1, value: price }], at);

  const o = ads.overview(30);
  const expectProfit = price / 1.21 + 79 / 1.21 - variant.purchase - 60;
  check('storno se do objednávek nepočítá', o.orders.value, 1);
  close('zisk po reklamě = zisk objednávky − útrata', o.profitAfterAds.value, expectProfit - 100, 0.05);
  close('PNO e-shopu = útrata / obrat bez DPH', o.shopPno, 100 / ((price + 79) / 1.21), 0.0001);
  check('dlaždice Google má útratu', o.systems[0].cost, 100);

  const p = ads.products(30);
  const mine = p.rows.find(r => r.code === variant.product_code);
  check('útrata varianty se připsala produktu', mine && mine.cost, 100);
  check('prodaný kus z objednávky', mine && mine.sold, 1);
  close('bod zlomu = marže produktu', mine.breakEven, 1 - variant.purchase / variant.novat, 0.2);
  check('nic nezůstalo nespárované', p.unmatched.length, 0);
  check('každý produkt má segment', Object.values(p.counts).reduce((a, b) => a + b, 0), p.rows.length);
  const tsv = ads.feedText(30);
  check('feed má řádek i pro kód varianty', tsv.includes(`\n${variant.code}\t`), true);
  const c = ads.campaigns(30);
  check('kampaň v přehledu kampaní', [c[0].id, c[0].cost], ['9', 100]);
} else {
  console.log('\n(katalog e-shopu není po ruce — celý průchod se přeskakuje)');
}

console.log(failed ? `\n✗ ${failed} chyb` : '\n✓ Reklamy: vše sedí');
process.exit(failed ? 1 : 0);
