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
// Šifrování klíčenky mimo aplikaci není — hodnoty se ukládají, jak jsou
const secPath = require.resolve(path.join(DIST, 'secure.js'));
require.cache[secPath] = { id: secPath, filename: secPath, loaded: true, exports: {
  encrypt: v => v, decrypt: v => v
} };

const econ = require(path.join(DIST, 'ads/economics.js'));
const seg = require(path.join(DIST, 'ads/segments.js'));
const google = require(path.join(DIST, 'ads/google.js'));
const store = require(path.join(DIST, 'ads/store.js'));
const schema = require(path.join(DIST, 'ads/schema.js'));
const { DEFAULT_ADS_CONFIG } = require(path.join(DIST, '../shared/ads.js'));

(async () => {
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
check('doplňkový feed (TSV) i se štítkem vyřazení', seg.supplementalTsv([
  { id: 'PS120', segment: 'hvezdy', band: 'marze-70-plus' },
  { id: 'PZ1', segment: 'zrouti', band: 'marze-30-50', out: true }]),
  'id\tcustom_label_0\tcustom_label_1\tcustom_label_2\nPS120\thvezdy\tmarze-70-plus\t\nPZ1\tzrouti\tmarze-30-50\tvyradit\n');

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

/* ---------- engine návrhů ---------- */
console.log('\nEngine návrhů');
const engine = require(path.join(DIST, 'ads/engine.js'));
const ecfg = JSON.parse(JSON.stringify(DEFAULT_ADS_CONFIG));
const ecamp = (over) => ({ id: '1', name: 'PMax', type: 'PERFORMANCE_MAX', status: 'ENABLED',
  bidding: 'MAXIMIZE_CONVERSION_VALUE', targetRoas: 6, budget: 1000, budgetId: '77', budgetShared: false,
  limited: false, cost: 9000, conversions: 60, value: 90000, ...over });
const einput = (over) => ({ cfg: ecfg, margin: 0.65, targetPno: 0.15, campaigns: [], terms: [],
  vocabulary: engine.vocabularyOf(['Bordó pánské široké kšandy', 'Tmavě modrý motýlek']),
  products: [], excluded: new Set(), cooling: new Set(), blocked: new Set(), monthSpend: 0, daysLeft: 20,
  dataDays: 30, ...over });

// PNO 10 % při cíli 15 % a brzdí ho rozpočet → přidat 20 %
let out = engine.generate(einput({ campaigns: [ecamp({ limited: true })] }));
check('rozpočet nahoru: brzdí ho rozpočet a je pod cílem', out.map(o => [o.kind, o.ops[0].from, o.ops[0].to]),
  [['budget-up', 1000, 1200]]);
// Přidaných 200 Kč × 30 dní × 80 % = 4 800 Kč; při průměrném PNO 10 % by vydělaly 4 800 / 0,1 × 0,65 − 4 800 = 26 400
check('  odhad počítá s horší mezní návratností (kladný, ale menší než při průměrném PNO)', out[0].impact > 0 && out[0].impact < 26400, true);
out = engine.generate(einput({ campaigns: [ecamp({ limited: false })] }));
check('bez omezení rozpočtem se rozpočet nepřidává', out.some(o => o.kind === 'budget-up'), false);
out = engine.generate(einput({ campaigns: [ecamp({ limited: true, budgetShared: true })] }));
check('sdílený rozpočet se nemění', out.some(o => o.kind === 'budget-up'), false);
const cap = JSON.parse(JSON.stringify(ecfg)); cap.guards.monthlyBudget = 30000;
out = engine.generate(einput({ cfg: cap, campaigns: [ecamp({ limited: true })], monthSpend: 28000, daysLeft: 2 }));
check('měsíční strop: přidání, které by ho přetáhlo, se nenavrhne', out.some(o => o.kind === 'budget-up'), false);

// PNO 25 % při cíli 15 %: cíl ROAS 600 % → nejvýš +15 % = 690 %
out = engine.generate(einput({ campaigns: [ecamp({ cost: 22500 })] }));
check('nad cílem: přísnější cílové ROAS o nejvýš 15 % (i za cenu části zisku)', out.map(o => [o.kind, o.ops[0].from, Math.round(o.ops[0].to * 100)]),
  [['roas-up', 6, 690]]);
check('ROAS pro PNO počítá s hodnotou s DPH (1,21 / 0,15 = 807 %)', Math.round(engine.roasForPno(ecfg, 0.15) * 100), 807);
out = engine.generate(einput({ campaigns: [ecamp({ cost: 22500, targetRoas: null })] }));
check('bez cíle: navrhne ho nastavit', out.map(o => o.kind), ['roas-set']);
out = engine.generate(einput({ campaigns: [ecamp({ cost: 22500, bidding: 'MANUAL_CPC', targetRoas: null })] }));
check('ruční CPC nad cílem: ubrat rozpočet', out.map(o => [o.kind, o.ops[0].to]), [['budget-down', 800]]);
out = engine.generate(einput({ campaigns: [ecamp({ cost: 22500, conversions: 8 })] }));
check('málo konverzí: cíl se nemění', out.some(o => o.kind === 'roas-up'), false);
out = engine.generate(einput({ campaigns: [ecamp({ cost: 22500 })], cooling: new Set(['1']) }));
check('týden po změně je kampaň v klidu', out.length, 0);
out = engine.generate(einput({ campaigns: [ecamp({ cost: 22500 })], blocked: new Set(['roas-up|google|1']) }));
check('„nenavrhovat" platí', out.length, 0);
out = engine.generate(einput({ campaigns: [ecamp({ limited: true })], dataDays: 10 }));
check('pod 14 dní dat se nic nenavrhuje', out.length, 0);

// Vylučující slova
const search = ecamp({ id: '5', name: 'Kšandy', type: 'SEARCH', bidding: 'MANUAL_CPC', targetRoas: null, cost: 3000, conversions: 30, value: 40000 });
const eterms = [
  { campaignId: '5', term: 'kšandy bazar', clicks: 80, cost: 300, conversions: 0 },
  { campaignId: '5', term: 'kšandy návod', clicks: 70, cost: 260, conversions: 0 },
  { campaignId: '5', term: 'široké kšandy', clicks: 200, cost: 900, conversions: 12 },
  { campaignId: '5', term: 'kšandy dětské', clicks: 80, cost: 320, conversions: 0 },
  { campaignId: '5', term: 'dětské kšandy růžové', clicks: 30, cost: 90, conversions: 2 }
];
out = engine.generate(einput({ campaigns: [search], terms: eterms }));
const neg = out.find(o => o.kind === 'negatives');
check('vylučující slova z dotazů bez prodeje', neg && neg.ops.map(o => o.text).sort(), ['bazar', 'návod']);
check('  slovo z názvu produktu („kšandy") se nevylučuje nikdy', neg.ops.some(o => o.text === 'kšandy'), false);
check('  slovo z dotazu, který prodal („dětské"), taky ne', neg.ops.some(o => o.text === 'dětské'), false);

// Žrouti
out = engine.generate(einput({ products: [
  { code: 'A', title: 'x', segment: 'zrouti', cost: 400, profit: -300 },
  { code: 'B', title: 'y', segment: 'zrouti', cost: 50, profit: -50 },
  { code: 'C', title: 'z', segment: 'hvezdy', cost: 900, profit: 3000 }] }));
check('žrouti s útratou nad 150 Kč ven na 30 dní', out.filter(o => o.kind === 'exclude').map(o => o.ops[0].codes), [['A']]);

/* ---------- návrhy, zápis do účtu a vrácení ---------- */
console.log('\nNávrhy: zápis do Google Ads a vrácení');
const prop = require(path.join(DIST, 'ads/proposals.js'));
// Přepočet čísel kampaně pro vyhodnocení: marže 60 %, korunový účet, DPH 21 %
const MONEY = () => ({ margin: 0.6, cost: n => n, value: n => n / 1.21 });
const draft = { fingerprint: 'budget-up|google|1', kind: 'budget-up', targetId: '1', targetName: 'PMax', title: 'Přidat',
  why: 'proto', impact: 1200, confidence: 2, ops: [{ kind: 'budget', campaignId: '1', budgetId: '77', from: 1000, to: 1200 }] };
check('nový návrh se uloží', prop.saveGenerated([draft]), 1);
const first = prop.proposalsView(MONEY).open[0];
check('stejný návrh příště jen aktualizuje (stejné ID)', [prop.saveGenerated([{ ...draft, impact: 1500 }]),
  prop.proposalsView(MONEY).open[0].id, prop.proposalsView(MONEY).open[0].impact], [0, first.id, 1500]);

// Google Ads napodobený: token, čtení kampaně, mutace
db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES ('adsGoogleRefresh','r'),('adsGoogleSecret','s')").run();
store.saveAdsConfig({ google: { ...store.getAdsConfig().google, customerId: '1234567890', clientId: 'cid', currency: 'CZK' } });
let budgetNow = 1000;
const calls = [];
global.fetch = async (url, init = {}) => {
  const body = init.body ? (String(url).includes('oauth2') ? String(init.body) : JSON.parse(init.body)) : null;
  calls.push({ url: String(url), body });
  const reply = (json) => ({ ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) });
  if (String(url).includes('oauth2')) return reply({ access_token: 'tok', expires_in: 3600 });
  if (String(url).endsWith('googleAds:search')) {
    return reply({ results: [{ campaign: { id: '1', maximizeConversionValue: { targetRoas: 6 } },
      campaignBudget: { amountMicros: String(budgetNow * 1e6) } }] });
  }
  if (String(url).endsWith('campaignBudgets:mutate')) {
    if (!body.validateOnly) budgetNow = Number(body.operations[0].update.amountMicros) / 1e6;
    return reply({ results: [{ resourceName: body.operations[0].update.resourceName }] });
  }
  return reply({});
};
const done = (await prop.applyProposal(store.getAdsConfig(), first.id, async () => {}));
check('použít: nejdřív naoko (validateOnly), pak doopravdy',
  calls.filter(c => c.url.endsWith('campaignBudgets:mutate')).map(c => c.body.validateOnly), [true, false]);
check('  rozpočet v účtu je 1 200 Kč (v milióntinách)', [budgetNow,
  calls.find(c => c.url.endsWith('campaignBudgets:mutate')).body.operations[0].update.amountMicros], [1200, '1200000000']);
check('  návrh je provedený a změna je v deníku s cestou zpět', [done.status, prop.allChanges()[0].undo[0].to], ['applied', 1000]);

// Vrácení: kontrola stavu a zpětná operace
const change = prop.allChanges()[0];
(await prop.revertChange(store.getAdsConfig(), change.id, async () => {}));
check('vrátit: rozpočet je zase 1 000 Kč a původní změna je označená jako vrácená',
  [budgetNow, !!prop.allChanges().find(c => c.id === change.id).revertedAt], [1000, true]);

// Ručně změněný rozpočet: návrh se neprovede
prop.saveGenerated([{ ...draft, fingerprint: 'budget-up|google|1|b' }]);
const second = prop.proposalsView(MONEY).open.find(p => p.fingerprint.endsWith('|b'));
budgetNow = 950;
const mutBefore = calls.filter(c => c.url.includes(':mutate')).length;
let staleErr = '';
try { (await prop.applyProposal(store.getAdsConfig(), second.id, async () => {})); } catch (e) { staleErr = e.message; }
check('když někdo rozpočet mezitím změnil, nic se nezapíše', [calls.filter(c => c.url.includes(':mutate')).length - mutBefore,
  /950 Kč/.test(staleErr), prop.getProposal(second.id).status], [0, true, 'stale']);

// Mac bez přihlášení: jen schválí, provede to přihlášený
db.prepare("UPDATE settings SET value = '' WHERE key = 'adsGoogleRefresh'").run();
budgetNow = 1000;
prop.saveGenerated([{ ...draft, fingerprint: 'budget-up|google|1|c' }]);
const third = prop.proposalsView(MONEY).open.find(p => p.fingerprint.endsWith('|c'));
check('Mac bez přihlášení návrh jen schválí', (await prop.applyProposal(store.getAdsConfig(), third.id, async () => {})).status, 'approved');
db.prepare("UPDATE settings SET value = 'r' WHERE key = 'adsGoogleRefresh'").run();
check('…a přihlášený Mac ho při kontrole provede', [(await prop.applyApproved(store.getAdsConfig(), async () => {})),
  prop.getProposal(third.id).status, budgetNow], [1, 'applied', 1200]);
check('schválený návrh se do té doby nenabízí znovu', prop.blockedFingerprints().has('budget-up|google|1|c'), false);

// Vylučující slovo: vrácení maže přesně to, co se vytvořilo
const g2 = require(path.join(DIST, 'ads/google.js'));
const negOp = g2.buildMutation('123-456-7890', { kind: 'negative', campaignId: '5', text: 'bazar', match: 'PHRASE', cost: 0, clicks: 0 });
check('vylučující slovo: frázová shoda v kampani', negOp, { service: 'campaignCriteria', operation: { create: {
  campaign: 'customers/1234567890/campaigns/5', negative: true, keyword: { text: 'bazar', matchType: 'PHRASE' } } } });
check('zrušení cíle při vrácení „nastavit cíl"', g2.buildMutation('1', { kind: 'troas', campaignId: '9', field: 'maximize_conversion_value', from: 5, to: 0 }).operation,
  { update: { resourceName: 'customers/1/campaigns/9', maximizeConversionValue: {} }, updateMask: 'maximize_conversion_value.target_roas' });

// Vyřazení žroutů: bez API, do feedu, po 30 dnech samo zpět
prop.saveGenerated([{ fingerprint: 'exclude|google|A', kind: 'exclude', targetId: 'feed', targetName: 'feed', title: 'Vyřadit',
  why: '', impact: 300, confidence: 2, ops: [{ kind: 'exclude', codes: ['A'], days: 30 }] }]);
const ex = prop.proposalsView(MONEY).open.find(p => p.kind === 'exclude');
let fed = 0;
(await prop.applyProposal(store.getAdsConfig(), ex.id, async () => { fed++; }));
check('vyřazení: produkt je ve feedu jako vyradit a feed se vystavil', [prop.excludedCodes().map(e => e.code), fed], [['A'], 1]);
check('  po 30 dnech se vrátí sám', prop.excludedCodes(econ.shiftDay(econ.localDay(), 31)).length, 0);

// Servisní účet: klíč z JSON, podepsané JWT, žádný prohlížeč
{
  const crypto = require('crypto');
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  let chyba = '';
  try { g2.saveServiceKey('{"type":"authorized_user"}'); } catch (e) { chyba = e.message; }
  check('servisní účet: jiný soubor než klíč se odmítne srozumitelně', /servisního účtu/.test(chyba), true);
  db.prepare("UPDATE settings SET value = '' WHERE key = 'adsGoogleRefresh'").run();
  const email = g2.saveServiceKey(JSON.stringify({ type: 'service_account', client_email: 'reklamy@quentino.iam.gserviceaccount.com',
    private_key: pem, private_key_id: 'k1' }));
  check('  klíč se uloží a Mac je připojený i bez přihlášení přes prohlížeč',
    [email, g2.googleSecrets().connected, g2.googleSecrets().service], ['reklamy@quentino.iam.gserviceaccount.com', true, email]);
  const tokenCalls = [];
  global.fetch = async (url, init = {}) => {
    tokenCalls.push({ url: String(url), body: String(init.body ?? '') });
    const reply = (json) => ({ ok: true, status: 200, json: async () => json });
    if (String(url).includes('oauth2')) return reply({ access_token: 'sa-token', expires_in: 3600 });
    return reply({ resourceNames: ['customers/1234567890'], results: [{ customer: { descriptiveName: 'Quentino', currencyCode: 'CZK' } }] });
  };
  const list = await g2.listCustomers({ ...store.getAdsConfig() });
  const form = new URLSearchParams(tokenCalls.find(c => c.url.includes('oauth2')).body);
  const [h, c, sig] = form.get('assertion').split('.');
  const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
  const ok = crypto.createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(sig, 'base64url'));
  check('  token se získá podepsaným JWT (jwt-bearer, adwords, platný podpis)',
    [form.get('grant_type'), claims.iss, claims.scope, claims.aud, claims.exp - claims.iat, ok],
    ['urn:ietf:params:oauth:grant-type:jwt-bearer', email, 'https://www.googleapis.com/auth/adwords',
      'https://oauth2.googleapis.com/token', 3600, true]);
  check('  a účty se načtou', list.map(x => [x.id, x.name]), [['1234567890', 'Quentino']]);
  g2.forgetGoogle();
  check('  odebrání klíče Mac odpojí', g2.googleSecrets().connected, false);
}

// Sdílení návrhů: rozhodnutí z jiného Macu se převezme, cizí deník se přidá
const shared2 = fs.mkdtempSync(path.join(os.tmpdir(), 'reklamy-'));
db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES('syncEnabled','1'),('syncFolder',?)").run(shared2);
prop.shareProposals();
const navrhy = path.join(shared2, 'reklamy', 'navrhy.json');
check('návrhy jsou ve sdílené složce', fs.existsSync(navrhy), true);
const sdil = JSON.parse(fs.readFileSync(navrhy, 'utf8'));
const jiny = sdil.proposals[0];
jiny.status = 'dismissed'; jiny.updatedAt = new Date(Date.now() + 60_000).toISOString(); jiny.decidedBy = 'Jiný Mac';
fs.writeFileSync(navrhy, JSON.stringify(sdil));
fs.writeFileSync(path.join(shared2, 'reklamy', 'zmeny-cizimac.json'), JSON.stringify({ changes: [{ id: 'cizi1', proposalId: '', revertOf: '',
  kind: 'negatives', system: 'google', targetId: '5', targetName: 'K', title: 'Cizí změna', ops: [], undo: [], at: new Date().toISOString(), device: 'Jiný Mac' }] }));
check('zamítnutí z jiného Macu i jeho změna se převezmou', [prop.shareProposals(), prop.getProposal(jiny.id).status,
  prop.allChanges().some(c => c.id === 'cizi1')], [true, 'dismissed', true]);
check('vlastní deník je ve vlastním souboru (cizí se nepřepisuje)',
  fs.readdirSync(path.join(shared2, 'reklamy')).filter(n => n.startsWith('zmeny-')).length, 2);
fs.rmSync(shared2, { recursive: true, force: true });
db.prepare("UPDATE settings SET value = '0' WHERE key = 'syncEnabled'").run();


/* ---------- Sklik ---------- */
console.log('\nSklik');
{
  const sk = require(path.join(DIST, 'ads/sklik.js'));
  const list = sk.markShared(sk.parseSklikCampaigns([
    { id: 11, name: 'Zboží – katalog', type: 'zbozi', status: 'active', budget: { id: 501, dayBudget: 25000 } },
    { id: 12, name: 'Hledání – kšandy', type: 'fulltext', status: 'suspend', budget: { id: 502, dayBudget: 10000 } },
    { id: 13, name: 'Obsah A', type: 'context', status: 'active', budget: { id: 503, dayBudget: 5000 } },
    { id: 14, name: 'Obsah B', type: 'context', status: 'active', budget: { id: 503, dayBudget: 5000 } },
    { id: 15, name: 'Smazaná', type: 'zbozi', status: 'active', deleted: true }
  ]));
  check('kampaně: haléře na koruny, typy jako u Googlu, pozastavená = PAUSED, smazaná pryč',
    list.map(c => [c.id, c.type, c.status, c.budget]),
    [['11', 'SHOPPING', 'ENABLED', 250], ['12', 'SEARCH', 'PAUSED', 100], ['13', 'DISPLAY', 'ENABLED', 50], ['14', 'DISPLAY', 'ENABLED', 50]]);
  check('  rozpočet sdílený víc kampaněmi se pozná (a engine na něj nesáhne)', list.map(c => c.budgetShared), [false, false, true, true]);
  const rep = sk.parseSklikReport([
    { id: 11, stats: [
      { date: '2026-11-18T00:00:00+01:00', totalMoney: 41250, clicks: 90, impressions: 4000, conversions: 3, conversionValue: 297000, exhaustedBudget: 1 },
      { date: '2026-11-19', totalMoney: 0, clicks: 0, impressions: 0, conversions: 0, conversionValue: 0 }] }
  ]);
  check('statistiky: den, koruny, prázdné dny pryč', rep.map(r => [r.date, r.cost, r.conversions, r.value]),
    [['2026-11-18', 412.5, 3, 2970]]);
  check('  datum i ve tvaru XML-RPC (20261118T00:00:00)',
    sk.parseSklikReport([{ id: 1, stats: [{ date: '20261118T00:00:00', clicks: 1 }] }]).map(r => r.date), ['2026-11-18']);
  check('chyba 400 řekne, které pole chybí', sk.explainSklik(400, { status: 400, statusMessage: 'Bad arguments',
    diagnostics: [{ id: 'missing_struct_field', field: 'offset', problemMessage: 'Field offset must be present' }] }),
    'Sklik: Bad arguments (missing_struct_field – pole offset – Field offset must be present)');
  check('token pro Fenix: rada vytvořit token pro Drak', /Drak/.test(sk.explainSklik(401, { status: 401 })), true);
  const ex = (date) => ({ id: '11', date, cost: 1, clicks: 1, impressions: 1, conversions: 0, value: 0, exhausted: 1 });
  check('omezeno rozpočtem: aspoň 3× za posledních 7 dní došel rozpočet',
    [...sk.limitedFrom([ex('2026-11-17'), ex('2026-11-18'), ex('2026-11-19')], '2026-11-20')], ['11']);
  check('  dvakrát nestačí, a starší dny se nepočítají',
    [...sk.limitedFrom([ex('2026-11-01'), ex('2026-11-18'), ex('2026-11-19')], '2026-11-20')], []);

  // Engine: otisk se Sklikem, bez cílů ROAS (ruční CPC) jen rozpočty
  out = engine.generate(einput({ system: 'sklik', campaigns: [ecamp({ id: '11', account: 'sklik', limited: true,
    bidding: 'MANUAL_CPC', targetRoas: null, budgetId: '501' })] }));
  check('engine: návrh pro Sklik má vlastní otisk a jde do účtu sklik',
    out.map(o => [o.fingerprint, o.ops[0].kind, o.ops[0].account]), [['budget-up|sklik|11', 'budget', 'sklik']]);

  // Zápis rozpočtu: kontrola stavu, haléře, vrácení
  const skCalls = [];
  let skBudget = 25000;
  global.fetch = async (url, init = {}) => {
    const method = String(url).split('/').pop();
    const body = JSON.parse(init.body);
    skCalls.push({ method, body });
    const reply = (json) => ({ ok: true, status: 200, json: async () => ({ status: 200, session: 'S2', ...json }) });
    if (method === 'client.loginByToken') return reply({ session: 'S1' });
    if (method === 'campaigns.list') {
      // Jako skutečný Sklik: bez offset/limit vrátí Bad arguments
      const opts = body[2] || {};
      if (opts.offset == null || opts.limit == null) {
        return { ok: false, status: 400, json: async () => ({ status: 400, statusMessage: 'Bad arguments',
          diagnostics: [{ id: 'missing_struct_field', field: 'offset', problemMessage: 'Field offset must be present' }] }) };
      }
      return reply({ campaigns: [{ id: 11, type: 'zbozi', budget: { id: 501, dayBudget: skBudget } }] });
    }
    if (method === 'campaigns.createReport') return reply({ reportId: 'R1', totalCount: 1 });
    if (method === 'campaigns.readReport') {
      return reply({ report: [{ id: 11, stats: [{ date: econ.shiftDay(econ.localDay(), -2), totalMoney: 123400, clicks: 10, impressions: 100 }] }] });
    }
    if (method === 'campaigns.update' && !body[1][0].type) {
      return { ok: false, status: 400, json: async () => ({ status: 400, statusMessage: 'Bad arguments',
        diagnostics: [{ id: 'missing_struct_field', field: 'campaigns[0].type' }] }) };
    }
    if (method === 'campaigns.update') { skBudget = body[1][0].dayBudget; return reply({}); }
    return reply({});
  };
  db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES ('adsSklikToken', 'sk-token')").run();
  store.saveAdsConfig({ sklik: { enabled: true, userId: '', name: 'Sklik' } });
  check('účet sklik = český trh v korunách', store.accountInfo(store.getAdsConfig(), 'sklik'),
    { id: 'sklik', name: 'Sklik', currency: 'CZK', market: 'cz', enabled: true });
  const skDraft = { fingerprint: 'budget-up|sklik|11', kind: 'budget-up', targetId: '11', targetName: 'Zboží', title: 'Přidat',
    why: '', plain: '', impact: 500, confidence: 2, ops: [{ kind: 'budget', campaignId: '11', budgetId: '501', from: 250, to: 300, account: 'sklik' }] };
  prop.saveGenerated([skDraft], 'sklik');
  const skP = prop.proposalsView(MONEY).open.find(p => p.fingerprint === 'budget-up|sklik|11');
  check('návrh Skliku se uloží jako system sklik', skP && skP.system, 'sklik');
  // Google na tomhle Macu připojený není — Sklik se přesto zapíše
  const done = await prop.applyProposal(store.getAdsConfig(), skP.id, async () => {});
  const upd = skCalls.find(c => c.method === 'campaigns.update');
  check('použít: přihlášení tokenem, rozpočet v haléřích, session v prvním parametru',
    [skCalls[0].method, skCalls[0].body, upd.body[1], upd.body[0].session, done.status],
    ['client.loginByToken', ['sk-token'], [{ id: 11, type: 'zbozi', dayBudget: 30000 }], 'S2', 'applied']);
  const tested = await sk.sklikTest('');
  const rr = skCalls.filter(c => c.method === 'campaigns.readReport').pop();
  check('zkouška připojení: počet kampaní a útrata za 7 dní (1 234 Kč z haléřů)', [/1 kampaní/.test(tested), /1\s234 Kč/.test(tested)], [true, true]);
  check('  čtení reportu má offset a limit (stránka zmenšená podle počtu dní)', [rr.body[2].offset, rr.body[2].limit > 0 && rr.body[2].limit <= 100], [0, true]);
  const skChange = prop.allChanges().find(c => c.proposalId === skP.id);
  await prop.revertChange(store.getAdsConfig(), skChange.id, async () => {});
  check('vrátit: rozpočet je zase 250 Kč', skBudget, 25000);
  prop.saveGenerated([{ ...skDraft, fingerprint: 'budget-up|sklik|11|b' }], 'sklik');
  const skStale = prop.proposalsView(MONEY).open.find(p => p.fingerprint.endsWith('|b'));
  skBudget = 20000;
  const before = skCalls.filter(c => c.method === 'campaigns.update').length;
  try { await prop.applyProposal(store.getAdsConfig(), skStale.id, async () => {}); } catch { /* čeká se */ }
  check('ručně změněný rozpočet ve Skliku: nic se nezapíše', [skCalls.filter(c => c.method === 'campaigns.update').length - before,
    prop.getProposal(skStale.id).status], [0, 'stale']);
  check('Google návrhy nový běh Skliku nezavřel', prop.getProposal(first.id) != null, true);
  db.prepare("UPDATE settings SET value = '' WHERE key = 'adsSklikToken'").run();
  prop.saveGenerated([{ ...skDraft, fingerprint: 'budget-up|sklik|11|c' }], 'sklik');
  const skNo = prop.proposalsView(MONEY).open.find(p => p.fingerprint.endsWith('|c'));
  check('Mac bez tokenu Skliku návrh jen schválí', (await prop.applyProposal(store.getAdsConfig(), skNo.id, async () => {})).status, 'approved');
  store.saveAdsConfig({ sklik: { enabled: false, userId: '', name: 'Sklik' } });
}


/* ---------- poradce ---------- */
console.log('\nPoradce: kroky z chatu → návrhy');
{
  const chat = require(path.join(DIST, 'ads/chat.js'));
  check('odpověď v ```json se přečte', chat.parseReply('```json\n{"answer":"Ahoj","actions":[{"type":"budget"}]}\n```').actions.length, 1);
  check('odpověď bez JSON je prostě text', chat.parseReply('Jen text.'), { answer: 'Jen text.', actions: [] });
  const ccfg = JSON.parse(JSON.stringify(DEFAULT_ADS_CONFIG));
  const row = (over) => ({ system: 'google', account: '111', market: 'cz', id: '1', name: 'PMax', type: 'PERFORMANCE_MAX',
    status: 'ENABLED', budget: 1000, bidding: 'MAXIMIZE_CONVERSION_VALUE', targetRoas: 6, cost: 9000, clicks: 1, conversions: 60,
    value: 90000, profit: 1, pno: 0.1, targetPno: 0.15, ...over });
  const ctx = {
    cfg: ccfg, today: '2026-11-20', overview: null,
    campaigns: [row({}), row({ id: '2', name: 'Sdílená' }), row({ id: '9', system: 'sklik', account: 'sklik', name: 'Zboží', bidding: 'MANUAL_CPC', targetRoas: null, budget: 200 })],
    meta: new Map([['google|1', { budgetId: '77', budgetShared: false, limited: true }], ['google|2', { budgetId: '78', budgetShared: true, limited: false }],
      ['sklik|9', { budgetId: '501', budgetShared: false, limited: false }]]),
    products: [{ code: 'K1', title: 'Kšandy', cost: 400, profit: -300 }], open: [], changes: [],
    vocabulary: engine.vocabularyOf(['Bordó pánské široké kšandy']), margins: { cz: 0.6 }, monthSpend: 0, daysLeft: 10
  };
  let r = chat.draftsFrom([{ type: 'budget', campaignId: '1', to: 1500, reason: 'Vydělává, přidat.' }], ctx, 'přidej');
  check('rozpočet nad pojistkou se zkrátí na +20 % a řekne se to', [r.drafts.map(d => [d.kind, d.ops[0].from, d.ops[0].to, d.system]), r.notes.length],
    [[['budget-up', 1000, 1200, 'google']], 1]);
  check('  vysvětlení pro laika je z odpovědi a otisk má stejný začátek jako engine',
    [r.drafts[0].plain, r.drafts[0].fingerprint.startsWith('budget-up|google|1|chat|')], ['Vydělává, přidat.', true]);
  r = chat.draftsFrom([
    { type: 'budget', campaignId: '1', to: 1200, date: '2026-12-01' },
    { type: 'budget', campaignId: '1', to: 1440, date: '2026-12-08' },
    { type: 'budget', campaignId: '1', to: 1000, date: '2026-12-27' }], ctx, 'Vánoce');
  check('plán: kroky jdou za sebou a další počítá s hodnotou předchozího',
    r.drafts.map(d => [d.notBefore, d.ops[0].from, d.ops[0].to]),
    [['2026-12-01', 1000, 1200], ['2026-12-08', 1200, 1440], ['2026-12-27', 1440, 1152]]);
  r = chat.draftsFrom([{ type: 'budget', campaignId: '2', to: 1100 }, { type: 'budget', campaignId: '404', to: 10 },
    { type: 'budget', campaignId: '1', to: 1100, date: '2025-01-01' }], ctx, 'x');
  check('sdílený rozpočet, neznámá kampaň a datum v minulosti → žádný návrh, ale vysvětlení', [r.drafts.length, r.notes.length], [0, 3]);
  r = chat.draftsFrom([{ type: 'budget', system: 'sklik', campaignId: '9', to: 230 }], ctx, 'x');
  check('Sklik: rozpočet do účtu sklik', r.drafts.map(d => [d.system, d.ops[0].account, d.ops[0].to]), [['sklik', 'sklik', 230]]);
  r = chat.draftsFrom([{ type: 'troas', system: 'sklik', campaignId: '9', to: 6 }], ctx, 'x');
  check('Sklik cíl ROAS neumí', r.drafts.length, 0);
  r = chat.draftsFrom([{ type: 'troas', campaignId: '1', to: 800 }], ctx, 'x');
  check('cíl ROAS v procentech se pozná a zkrátí na +15 %', r.drafts.map(d => [d.kind, d.ops[0].from, d.ops[0].to]), [['roas-up', 6, 6.9]]);
  r = chat.draftsFrom([{ type: 'negative', campaignId: '1', words: ['bazar', 'široké kšandy', 'ab'] }], ctx, 'x');
  check('vylučující slova: slovo z názvu produktu ani krátké ne', [r.drafts[0].ops.map(o => o.text), r.notes.length], [['bazar'], 1]);
  r = chat.draftsFrom([{ type: 'exclude', codes: ['k1', 'NIC'], days: 200 }, { type: 'pause', campaignId: '1' }], ctx, 'x');
  check('vyřazení: jen známé kódy, nejvýš 60 dní; neznámý krok jen poznámka',
    [r.drafts.map(d => [d.ops[0].codes, d.ops[0].days]), r.notes.length], [[[['K1'], 60]], 2]);
  const capCtx = { ...ctx, cfg: { ...ccfg, guards: { ...ccfg.guards, monthlyBudget: 30000 } }, monthSpend: 20000 };
  r = chat.draftsFrom([{ type: 'budget', campaignId: '1', to: 1200 }], capCtx, 'x');
  check('měsíční strop platí i pro poradce', r.drafts.length, 0);

  // Uložení: krok s datem čeká, nový běh enginu návrhy z poradce nezahodí
  r = chat.draftsFrom([{ type: 'budget', campaignId: '1', to: 1100 }, { type: 'budget', campaignId: '1', to: 1200, date: '2026-12-01' }], ctx, 'x');
  const saved = prop.saveChat(r.drafts);
  check('návrh hned je otevřený, s datem odložený do toho dne', saved.map(p => [p.status, p.snoozeUntil]), [['open', ''], ['snoozed', '2026-12-01']]);
  prop.saveGenerated([], 'google');
  check('  nový běh enginu ho nechá otevřený', prop.getProposal(saved[0].id).status, 'open');
  for (const p of saved) prop.decide(p.id, 'dismiss');
}


/* ---------- sezóny ---------- */
console.log('\nSezóny');
{
  const seas = require(path.join(DIST, 'ads/seasons.js'));
  const ev = seas.upcomingEvents('2026-11-21');
  const byId = Object.fromEntries(ev.map(e => [`${e.def.id}-${e.year}`, e]));
  check('Black Friday 2026 = čtvrtý pátek v listopadu (27. 11.), Den otců 2027 = třetí neděle v červnu (20. 6.)',
    [byId['black-friday-2026'].peak, byId['den-otcu-2027'].end], ['2026-11-27', '2027-06-17']);
  check('  proběhlé události v kalendáři nejsou, další rok ano', [!!byId['valentyn-2026'], !!byId['valentyn-2027'], !!byId['vanoce-2026']], [false, true, true]);

  // Dva roky objednávek: běžný týden 1 000 Kč denně, prosinec do 19. 12. dvojnásobek
  const daily = new Map();
  for (let d = '2024-01-01'; d < '2026-01-01'; d = econ.shiftDay(d, 1)) {
    const dec = d.slice(5, 7) === '12' && d.slice(8, 10) <= '19';
    daily.set(d, dec ? 2000 : 1000);
  }
  const idx = seas.seasonIndex(daily, '2026-11-21');
  check('sezónní index: běžný týden ≈ 1, prosinec ≈ 2× (dva roky dat)',
    [idx.years, Math.round(idx.index[20] * 10) / 10, idx.index[49] > 1.7], [[2024, 2025], 1, true]);
  check('  poslední neúplný týden roku nevypadá jako propad', idx.index[52] > 0.9, true);
  check('  navýšení na Vánoce z historie', seas.upliftFrom(idx, '2026-12-01', '2026-12-14') > 1.5, true);
  check('  bez roku dat se z historie nepočítá', seas.upliftFrom(seas.seasonIndex(new Map([['2026-11-01', 5]]), '2026-11-21'), '2026-12-01', '2026-12-14'), null);

  const pc = (over) => ({ system: 'google', id: '1', account: '111', market: 'cz', name: 'PMax', status: 'ENABLED', budget: 1000,
    budgetId: '77', budgetShared: false, pno: 0.1, targetPno: 0.15, conversions: 40, ...over });
  const empty = seas.seasonIndex(new Map(), '2026-11-21');
  const plan = seas.planEvent(DEFAULT_ADS_CONFIG, 'vanoce-2026',
    [pc({}), pc({ id: '2', name: 'Ztrátová', pno: 0.4 }), pc({ id: '3', name: 'Sdílená', budgetShared: true })], empty, '2026-11-21');
  check('plán Vánoc bez historie: odhad +60 %, nahoru po max. 20 % do začátku, dolů po konci',
    plan.drafts.map(d => [d.notBefore, d.ops[0].from, d.ops[0].to]),
    [['2026-11-22', 1000, 1200], ['2026-11-24', 1200, 1440], ['2026-11-28', 1440, 1600],
      ['2026-12-20', 1600, 1280], ['2026-12-22', 1280, 1024], ['2026-12-24', 1024, 1000]]);
  check('  prodělávající a sdílená kampaň v plánu nejsou (a řekne se proč)',
    [plan.drafts.every(d => d.targetId === '1'), plan.notes.length], [true, 2]);
  check('  kroky jsou naplánované návrhy s otiskem plánu', plan.drafts[0].fingerprint.startsWith('budget-up|google|1|plan|vanoce-2026|0|'), true);
  const soon = seas.planEvent(DEFAULT_ADS_CONFIG, 'black-friday-2026', [pc({})], empty, '2026-11-21');
  check('  blízká událost: kroky se nesmrsknou do jednoho dne (pojistka platí)',
    new Set(soon.drafts.filter(d => d.kind === 'budget-up').map(d => d.notBefore)).size,
    soon.drafts.filter(d => d.kind === 'budget-up').length);

  // Uložení a nový plán: staré kroky se zruší, nezdvojí se
  const first = prop.saveChat(plan.drafts);
  check('uložené kroky čekají v Naplánovaných', [prop.planCount('vanoce-2026'), prop.proposalsView(MONEY).planned.length >= 6], [6, true]);
  check('  nový plán téže události staré kroky zruší', [prop.dropPlan('vanoce-2026'), prop.planCount('vanoce-2026')], [6, 0]);
  check('  a engine plán nezahodí', (prop.saveChat(plan.drafts.slice(0, 1)), prop.saveGenerated([], 'google'), prop.planCount('vanoce-2026')), 1);
  prop.dropPlan('vanoce-2026');
  void first;
}


/* ---------- autopilot ---------- */
console.log('\nAutopilot');
{
  const auto = require(path.join(DIST, 'ads/autopilot.js'));
  const acfg = JSON.parse(JSON.stringify(DEFAULT_ADS_CONFIG));
  const ch = (verdict, over = {}) => ({ id: Math.random().toString(36).slice(2), revertOf: '', title: 'x', targetName: 'K',
    at: '2026-10-01T03:00:00Z', device: 'Mac', evaluation: { verdict, before: 0, after: 0, days: 14 }, ...over });
  const ten = [...Array(8)].map(() => ch('better')).concat([ch('worse'), ch('same')]);
  let st = auto.autopilotState(acfg, ten, '2026-10-01T00:00:00Z', '2026-11-21', null);
  check('odemčený: 4 týdny, 10 vyhodnocených, 90 % vyšlo', [st.eligible, st.missing, st.active], [true, [], false]);
  st = auto.autopilotState(acfg, ten.slice(0, 6), '2026-11-10T00:00:00Z', '2026-11-21', null);
  check('zamčený: řekne, kolik dní a změn chybí', [st.eligible, st.missing.length], [false, 2]);
  st = auto.autopilotState(acfg, [...Array(6)].map(() => ch('worse')).concat([...Array(5)].map(() => ch('better'))), '2026-10-01', '2026-11-21', null);
  check('pod 70 % úspěšnosti zůstane zamčený', [st.eligible, /45 %/.test(st.missing[0])], [false, true]);
  st = auto.autopilotState({ ...acfg, autonomy: 'guarded', autopilot: { ...acfg.autopilot, pausedAt: 'x' } }, ten, '2026-10-01', '2026-11-21', null);
  check('zabrzděný neběží', st.active, false);

  const P = (over) => ({ id: Math.random().toString(36).slice(2), fingerprint: 'budget-up|google|1', kind: 'budget-up', status: 'open',
    impact: 500, confidence: 3, snoozeUntil: '', ...over });
  const picked = auto.pick(acfg, [
    P({ id: 'a', impact: 300 }), P({ id: 'b', impact: 900 }), P({ id: 'drzi', impact: -200 }), P({ id: 'malo', confidence: 1 }),
    P({ id: 'roas', kind: 'roas-up' }), P({ id: 'chat', fingerprint: 'budget-up|google|1|chat|x' }),
    P({ id: 'plan', fingerprint: 'budget-up|google|1|plan|vanoce-2026|0|x', status: 'snoozed', impact: 0, confidence: 1 }),
    P({ id: 'odlozeny', status: 'snoozed' })]);
  check('vybere: krok plánu první, pak podle odhadu; ne „drží cíl", málo dat, ROAS, poradce ani ručně odložené; nejvýš 3',
    picked.map(p => p.id), ['plan', 'b', 'a']);

  const mine = (verdict, at) => ch(verdict, { device: 'Autopilot · Mac', at });
  check('brzda: dvě ze tří posledních změn autopilota hůř',
    !!auto.brake([mine('worse', '2026-11-01'), mine('better', '2026-11-02'), mine('worse', '2026-11-03'), ch('worse')]), true);
  check('  jedna špatná nestačí, a ručních změn se netýká',
    !!auto.brake([mine('worse', '2026-11-01'), mine('better', '2026-11-02'), mine('better', '2026-11-03'), ch('worse'), ch('worse')]), false);

  // Krok plánu, jehož den přišel, jde použít — a změna je v deníku podepsaná autopilotem
  db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES ('adsGoogleRefresh','r'),('adsGoogleSecret','s')").run();
  let bnow = 1000;
  global.fetch = async (url, init = {}) => {
    const body = init.body && !String(url).includes('oauth2') ? JSON.parse(init.body) : null;
    const reply = (json) => ({ ok: true, status: 200, json: async () => json });
    if (String(url).includes('oauth2')) return reply({ access_token: 't', expires_in: 3600 });
    if (String(url).endsWith('googleAds:search')) return reply({ results: [{ campaign: { id: '1' }, campaignBudget: { amountMicros: String(bnow * 1e6) } }] });
    if (body && !body.validateOnly) bnow = Number(body.operations[0].update.amountMicros) / 1e6;
    return reply({ results: [{ resourceName: 'x' }] });
  };
  const [step] = prop.saveChat([{ fingerprint: 'budget-up|google|1|plan|test-2026|0|z', system: 'google', market: 'cz',
    notBefore: econ.localDay(), kind: 'budget-up', targetId: '1', targetName: 'PMax', title: 'Plán', plain: '', why: '',
    impact: 0, confidence: 1, ops: [{ kind: 'budget', campaignId: '1', budgetId: '77', from: 1000, to: 1200, account: '1234567890' }] }]);
  const done = await prop.applyProposal(store.getAdsConfig(), step.id, async () => {}, 'Autopilot · Mac');
  check('krok plánu ve svůj den jde použít a v deníku je podepsaný autopilotem',
    [step.status, done.status, bnow, prop.allChanges().find(c => c.proposalId === step.id).device], ['snoozed', 'applied', 1200, 'Autopilot · Mac']);
  db.prepare("UPDATE settings SET value = '' WHERE key = 'adsGoogleRefresh'").run();
}


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

  // Poradce: model se napodobí — vrátí odpověď a jeden krok (rozpočet slovenské kampaně)
  const aiPath = require.resolve(path.join(DIST, 'ai.js'));
  const aiAsked = [];
  require.cache[aiPath] = { id: aiPath, filename: aiPath, loaded: true, exports: {
    ask: async (model, system, user) => {
      aiAsked.push(user);
      return JSON.stringify({ answer: 'Slovensko prodělává.', actions: [{ type: 'budget', campaignId: '19', to: 200, reason: 'Ubrat.' }] });
    }
  } };
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
  db.exec('DELETE FROM ads_campaign_day; DELETE FROM ads_item_day; DELETE FROM ads_campaigns;');
  // Starší data bez účtu se při prvním čtení přelijí k prvnímu účtu
  db.prepare("DELETE FROM settings WHERE key = 'adsItemsMigrated'").run();
  db.prepare(`INSERT INTO ads_product_day (system, date, item_id, cost, clicks, impressions, conversions, value, fetched_at)
    VALUES ('google', '2026-01-05', 'stary', 5, 1, 10, 0, 0, 'x')`).run();
  store.saveAdsConfig({ markets: ['cz'], google: { ...store.getAdsConfig().google, accounts: [
    { id: '1234567890', name: 'Quentino CZ', currency: 'CZK', market: 'cz', enabled: true }] } });
  // Reklama: kampaň a produkt (ID varianty malými, jak ho vrací Google)
  const at = new Date().toISOString();
  store.saveCampaigns('google', [{ id: '9', name: 'PMax', type: 'PERFORMANCE_MAX', status: 'ENABLED', budget: 300,
    bidding: 'MAXIMIZE_CONVERSION_VALUE', targetRoas: null }], at, '1234567890');
  store.saveDays('ads_campaign_day', 'google', yesterday, yesterday,
    [{ date: yesterday, id: '9', cost: 100, clicks: 30, impressions: 900, conversions: 1, value: price }], at, '1234567890');
  store.saveDays('ads_item_day', 'google', yesterday, yesterday,
    [{ date: yesterday, id: variant.code.toLowerCase(), cost: 100, clicks: 30, impressions: 900, conversions: 1, value: price }], at, '1234567890');

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
  check('stará data bez účtu se přelila k prvnímu účtu',
    [db.prepare('SELECT COUNT(*) AS n FROM ads_product_day').get().n,
      db.prepare("SELECT account FROM ads_item_day WHERE item_id = 'stary'").get()?.account], [0, '1234567890']);

  /* --- víc trhů: slovenský účet v eurech --- */
  store.saveAdsConfig({ google: { ...store.getAdsConfig().google, accounts: [
    { id: '1234567890', name: 'Quentino CZ', currency: 'CZK', market: 'cz', enabled: true },
    { id: '2345678901', name: 'Quentino SK', currency: 'EUR', market: 'sk', enabled: true }] } });
  check('zapnutý slovenský účet přidá slovenský trh mezi sledované', store.getAdsConfig().markets, ['cz', 'sk']);
  db.prepare(`INSERT INTO shop_orders (code, market, status, created_at, currency, total, shipment, items_json, ship_price)
    VALUES ('S1', 'sk', 'Vybavuje sa', ?, 'EUR', 40, 'Packeta', ?, 0)`)
    .run(`${yesterday}T12:00:00+01:00`, JSON.stringify([{ title: 'x', code: variant.code, quantity: 1, price: 40 }]));
  store.saveCampaigns('google', [{ id: '19', name: 'PMax SK', type: 'PERFORMANCE_MAX', status: 'ENABLED', budget: 10,
    bidding: 'MAXIMIZE_CONVERSION_VALUE', targetRoas: null, budgetId: '5' }], at, '2345678901');
  // 4 € útraty a 40 € hodnoty konverzí (se slovenskou DPH 23 %)
  store.saveDays('ads_campaign_day', 'google', yesterday, yesterday,
    [{ date: yesterday, id: '19', cost: 4, clicks: 5, impressions: 50, conversions: 1, value: 40 }], at, '2345678901');
  store.saveDays('ads_item_day', 'google', yesterday, yesterday,
    [{ date: yesterday, id: variant.code.toLowerCase(), cost: 4, clicks: 5, impressions: 50, conversions: 1, value: 40 }], at, '2345678901');
  check('stažení slovenského účtu nesmazalo český den',
    db.prepare("SELECT COUNT(*) AS n FROM ads_campaign_day WHERE account = '1234567890'").get().n, 1);
  const all = ads.overview(30, 'all');
  const sk = ads.overview(30, 'sk');
  const czOnly = ads.overview(30, 'cz');
  close('útrata ze slovenského účtu je v korunách (4 € × 25)', sk.cost.value, 100);
  check('všechny trhy = součet CZ a SK', [Math.round(all.cost.value), Math.round(all.revenue.value)],
    [Math.round(czOnly.cost.value + sk.cost.value), Math.round(czOnly.revenue.value + sk.revenue.value)]);
  close('slovenská tržba bez slovenské DPH (40 € × 25 / 1,23)', sk.revenue.value, 40 * 25 / 1.23);
  check('rozpad po trzích v přehledu', all.markets.map(m => m.market), ['cz', 'sk']);
  const kampane = ads.campaigns(30, 'all');
  close('hodnota slovenské kampaně bez slovenské DPH', kampane.find(c => c.id === '19').value, 40 * 25 / 1.23);
  check('kampaň ví, ze kterého je účtu a trhu', [kampane.find(c => c.id === '19').account, kampane.find(c => c.id === '19').market],
    ['2345678901', 'sk']);
  check('výběr trhu ukáže jen jeho kampaně', ads.campaigns(30, 'cz').map(c => c.id), ['9']);
  const prodSk = ads.products(30, 'sk').rows.find(r => r.code === variant.product_code);
  close('produkt na slovenském trhu: útrata z eur', prodSk.cost, 100);
  close('produkt za všechny trhy: útrata CZ + SK', ads.products(30, 'all').rows.find(r => r.code === variant.product_code).cost, 200);

  // Zápis jde do účtu, kterému kampaň patří — a v jeho měně
  {
    const prop2 = require(path.join(DIST, 'ads/proposals.js'));
    const urls = [];
    let eur = 10;
    db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES ('adsGoogleRefresh','r'),('adsGoogleSecret','s')").run();
    global.fetch = async (url, init = {}) => {
      urls.push(String(url));
      const body = init.body && !String(url).includes('oauth2') ? JSON.parse(init.body) : null;
      const reply = (json) => ({ ok: true, status: 200, json: async () => json });
      if (String(url).includes('oauth2')) return reply({ access_token: 't', expires_in: 3600 });
      if (String(url).endsWith('googleAds:search')) return reply({ results: [{ campaign: { id: '19' }, campaignBudget: { amountMicros: String(eur * 1e6) } }] });
      if (body && !body.validateOnly) eur = Number(body.operations[0].update.amountMicros) / 1e6;
      return reply({ results: [{ resourceName: 'x' }] });
    };
    await prop2.execute(store.getAdsConfig(), [{ kind: 'budget', campaignId: '19', budgetId: '5', from: 250, to: 300 }]);
    check('zápis do slovenské kampaně jde do slovenského účtu a v eurech (300 Kč = 12 €)',
      [urls.filter(u => u.includes(':mutate')).every(u => u.includes('/customers/2345678901/')), eur], [true, 12]);
  }

  // Poradce nad skutečnými daty: data jdou modelu, krok projde pojistkami a stane se návrhem
  {
    // Nastavení modelu čte getSettings a ten se dívá i do účtů pošty
    db.exec('CREATE TABLE IF NOT EXISTS accounts (id INTEGER PRIMARY KEY, email TEXT, pass_enc TEXT)');
    const reply = await ads.askAdvisor([], 'Jak je na tom Slovensko?', 'all');
    const sent = JSON.parse(aiAsked[0].split('DATA:\n')[1].split('\n\nOTÁZKA')[0]);
    check('poradce dostane kampaně obou trhů a otázku', [sent.kampane.map(k => k.id).sort(), aiAsked[0].endsWith('Jak je na tom Slovensko?')],
      [['19', '9'], true]);
    if (!reply.proposals.length) console.log('      poznámky:', reply.notes);
    check('  a z odpovědi vznikne návrh (10 € = 250 Kč → nejvýš −20 % = 200 Kč)', [reply.answer, reply.proposals.map(p => [p.kind, p.ops[0].to, p.market])],
      ['Slovensko prodělává.', [['budget-down', 200, 'sk']]]);
    for (const p of reply.proposals) require(path.join(DIST, 'ads/proposals.js')).decide(p.id, 'dismiss');
  }

  // Sezóny nad skutečnými daty: přehled i náhled plánu doběhnou
  {
    const sv = ads.seasons('all');
    check('sezóny: kalendář má události a index 53 týdnů', [sv.events.length > 3, sv.index.length], [true, 53]);
    const pv = ads.seasonPlan(sv.events[0].id, false, 'all');
    check('  náhled plánu doběhne a nic neuloží', [Array.isArray(pv.steps), pv.saved], [true, 0]);
  }

  // Autopilot: dokud není odemčený a zapnutý, noční kolo nic nedělá a zapnout ho nejde
  {
    check('autopilot: vypnutý v nočním běhu nic nedělá', await ads.autopilotNight(), '');
    let chyba = '';
    try { ads.saveConfig({ autonomy: 'guarded' }); } catch (e) { chyba = e.message; }
    check('  a zamčený nejde zapnout (řekne proč)', [/ještě nejde zapnout/.test(chyba), store.getAdsConfig().autonomy], [true, 'suggest']);
  }

  // Engine nad skutečným katalogem doběhne a dá přehled pro okno
  let engineOk = true;
  try { ads.runEngine(); } catch (e) { engineOk = false; console.log('      ', e.message); }
  const view = ads.proposals();
  check('engine nad skutečným katalogem doběhne a přehled návrhů má data',
    [engineOk, Array.isArray(view.open), typeof view.dataDays], [true, true, 'number']);
} else {
  console.log('\n(katalog e-shopu není po ruce — celý průchod se přeskakuje)');
}

console.log(failed ? `\n✗ ${failed} chyb` : '\n✓ Reklamy: vše sedí');
process.exit(failed ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
