/**
 * Modul Reklamy — fáze 1: data, zisk a segmenty.
 *
 * Ve fázi 1 modul do účtů nic nezapisuje. Stahuje výkon z Google Ads,
 * páruje ho s objednávkami z Upgates a nákupními cenami z katalogu
 * a ukazuje zisk po reklamě, kampaně a produkty v segmentech. Segmenty
 * vystaví jako doplňkový feed pro Merchant Center.
 *
 * Automatika a návrhy změn přijdou až po tom, co se na skutečných
 * datech ukáže, že čísla sedí (brána „14 dní s Ads i Upgates ±2 %").
 */
import { BrowserWindow, shell } from 'electron';
import { getDb, getSetting, setSetting } from '../db';
import { deviceLabel } from '../device';
import { webStorage } from '../webtexts';
import type { ShopOrder } from '../../shared/types';
import {
  AdsConfig, AdsStatus, AdsOverview, AdsSystemTile, AdsAlert, AdsDay, AdsCampaignRow,
  AdsProducts, AdsProductRow, AdsSegment, AdsShipMethod, AdsGoogleCustomer, AdsProposals, AdsChange,
  AdsProposal
} from '../../shared/ads';
import {
  orderMoney, marginTable, productMargin, targetPno, shiftDay, localDay, PriceInfo, OrderMoney
} from './economics';
import { segmentProducts, marginBand, supplementalTsv } from './segments';
import * as google from './google';
import { generate, vocabularyOf, EngineCampaign } from './engine';
import * as prop from './proposals';
import {
  getAdsConfig, saveAdsConfig, saveCampaigns, saveDays, syncConfig, syncStats, isShared,
  lastRun, markRun, writeLocal
} from './store';

function emit(payload: unknown = {}) {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('ads:changed', payload);
}

/* ---------- katalog: nákupní ceny ---------- */

interface Catalog {
  /** Kód produktu nebo varianty (malými písmeny) → ceny */
  byCode: Map<string, PriceInfo>;
  products: {
    code: string; title: string; image: string | null; category: string; stock: number | null;
    purchase: number | null; novat: number | null; variants: string[];
  }[];
  marginOf: (category: string) => number;
  withPrice: number;
}

function loadCatalog(cfg: AdsConfig): Catalog {
  const d = getDb();
  const products = d.prepare(
    `SELECT code, title_cz, image, category, stock, purchase, price_novat FROM products`
  ).all() as any[];
  const variants = d.prepare(
    `SELECT code, product_code, purchase, price_novat, stock FROM product_variants`
  ).all() as any[];
  const byCode = new Map<string, PriceInfo>();
  const list: Catalog['products'] = [];
  const parents = new Map<string, Catalog['products'][number]>();
  for (const row of products) {
    const one = {
      code: String(row.code), title: row.title_cz ?? '', image: row.image ?? null,
      category: row.category ?? '', stock: row.stock ?? null,
      purchase: row.purchase ?? null, novat: row.price_novat ?? null, variants: [] as string[]
    };
    list.push(one);
    parents.set(one.code, one);
    byCode.set(one.code.toLowerCase(), { product: one.code, category: one.category, purchase: one.purchase, novat: one.novat });
  }
  for (const row of variants) {
    const parent = parents.get(String(row.product_code));
    if (!parent) continue;
    parent.variants.push(String(row.code));
    /*
     * Varianta bez vlastní nákupní ceny bere cenu rodiče. V e-shopu je
     * nákupní cena u varianty vyplněná jen tam, kde se liší (delší kšandy
     * stojí víc) — jinak platí ta u produktu.
     */
    byCode.set(String(row.code).toLowerCase(), {
      product: parent.code,
      category: parent.category,
      purchase: row.purchase ?? parent.purchase,
      novat: row.price_novat ?? parent.novat
    });
  }
  return {
    byCode,
    products: list,
    marginOf: marginTable(list.map(p => ({ category: p.category, purchase: p.purchase, novat: p.novat })), cfg.fallbackMargin),
    withPrice: list.filter(p => p.purchase != null).length
  };
}

/* ---------- objednávky ---------- */

function toOrder(row: any): ShopOrder {
  let items: any[] = [];
  try { items = JSON.parse(row.items_json ?? '[]'); } catch { items = []; }
  return {
    code: row.code, market: row.market, status: row.status, paid: row.paid === 1, paidDate: '',
    resolved: row.resolved === 1, invoice: '', createdAt: row.created_at, updatedAt: '',
    currency: row.currency, total: Number(row.total) || 0, tracking: '', customerId: '', name: '',
    email: '', phone: '', shipment: row.shipment ?? '', payment: row.payment ?? '', note: '',
    pickupId: '', pickupName: '', weight: 0, items: Array.isArray(items) ? items : [],
    shipmentPrice: row.ship_price ?? null, paymentPrice: row.pay_price ?? null,
    billing: null, postal: null
  };
}

/** Objednávky ve sledovaných trzích mezi dvěma dny (včetně). */
function ordersBetween(cfg: AdsConfig, catalog: Catalog, from: string, to: string): OrderMoney[] {
  const markets = cfg.markets.length ? cfg.markets : ['cz'];
  const rows = getDb().prepare(
    `SELECT code, market, status, paid, resolved, created_at, currency, total, shipment, payment,
            items_json, ship_price, pay_price
     FROM shop_orders
     WHERE substr(created_at, 1, 10) BETWEEN ? AND ?
       AND market IN (${markets.map(() => '?').join(',')})`
  ).all(from, to, ...markets) as any[];
  const lookup = (code: string) => catalog.byCode.get(String(code ?? '').toLowerCase()) ?? null;
  return rows
    .map(row => orderMoney(toOrder(row), lookup, cfg, catalog.marginOf))
    .filter(one => !one.cancelled && one.date);
}

/* ---------- reklamy ---------- */

interface Agg { cost: number; clicks: number; impressions: number; conversions: number; value: number }
const emptyAgg = (): Agg => ({ cost: 0, clicks: 0, impressions: 0, conversions: 0, value: 0 });

function vatShop(cfg: AdsConfig): number {
  return 1 + (cfg.vat[cfg.markets[0] ?? 'cz'] ?? 21) / 100;
}

/** Hodnota konverze bez DPH — měření ji obvykle posílá s DPH */
function valueNovat(cfg: AdsConfig, value: number): number {
  return cfg.convValueWithVat ? value / vatShop(cfg) : value;
}

/** Účet v eurech se přepočte; Quentino má korunový, ale nic se nepředpokládá. */
function czk(cfg: AdsConfig, amount: number): number {
  return /eur/i.test(cfg.google.currency) ? amount * cfg.eurRate : amount;
}

function campaignDays(from: string, to: string): any[] {
  return getDb().prepare(
    `SELECT system, date, campaign_id, cost, clicks, impressions, conversions, value
     FROM ads_campaign_day WHERE date BETWEEN ? AND ?`
  ).all(from, to) as any[];
}

/* ---------- přehled ---------- */

function period(days: number): { from: string; to: string; prevFrom: string; prevTo: string } {
  // Končí se včerejškem: dnešek je rozdělaný a srovnával by se celý den s půlkou
  const to = shiftDay(localDay(), -1);
  const from = shiftDay(to, -(days - 1));
  return { from, to, prevFrom: shiftDay(from, -days), prevTo: shiftDay(from, -1) };
}

export function overview(daysWanted = 30): AdsOverview {
  const cfg = getAdsConfig();
  const days = Math.min(365, Math.max(7, Math.round(daysWanted) || 30));
  const { from, to, prevFrom, prevTo } = period(days);
  const catalog = loadCatalog(cfg);
  const orders = ordersBetween(cfg, catalog, prevFrom, to);
  const now = orders.filter(o => o.date >= from);
  const prev = orders.filter(o => o.date <= prevTo);
  const sum = (list: OrderMoney[], key: 'revenue' | 'profit' | 'fees') => list.reduce((a, o) => a + o[key], 0);

  const ads = campaignDays(prevFrom, to);
  const adsNow = ads.filter(r => r.date >= from);
  const adsPrev = ads.filter(r => r.date <= prevTo);
  const costOf = (list: any[]) => list.reduce((a, r) => a + czk(cfg, r.cost), 0);

  const revenue = sum(now, 'revenue') + sum(now, 'fees');
  const grossProfit = sum(now, 'profit');
  const cost = costOf(adsNow);
  const margin = revenue > 0 ? grossProfit / revenue : null;
  const target = targetPno(margin, cfg.targetProfitShare);
  const prevRevenue = sum(prev, 'revenue') + sum(prev, 'fees');

  // Dny
  const daily: AdsDay[] = [];
  for (let day = from; day <= to; day = shiftDay(day, 1)) {
    const o = now.filter(x => x.date === day);
    const a = adsNow.filter(x => x.date === day);
    daily.push({
      date: day,
      orders: o.length,
      revenue: o.reduce((s, x) => s + x.revenue + x.fees, 0),
      profit: o.reduce((s, x) => s + x.profit, 0),
      cost: a.reduce((s, x) => s + czk(cfg, x.cost), 0),
      conversions: a.reduce((s, x) => s + x.conversions, 0)
    });
  }

  // Systémy — ve fázi 1 jen Google; Sklik a Meta jako nepřipojené dlaždice
  const g = google.googleSecrets();
  const systems: AdsSystemTile[] = (['google', 'sklik', 'meta'] as const).map(system => {
    const rows = adsNow.filter(r => r.system === system);
    const agg = rows.reduce((acc: Agg, r) => {
      acc.cost += czk(cfg, r.cost); acc.conversions += r.conversions; acc.value += czk(cfg, r.value);
      return acc;
    }, emptyAgg());
    const value = valueNovat(cfg, agg.value);
    const byDay = new Map<string, { cost: number; value: number }>();
    for (const r of rows) {
      const one = byDay.get(r.date) ?? { cost: 0, value: 0 };
      one.cost += czk(cfg, r.cost);
      one.value += valueNovat(cfg, czk(cfg, r.value));
      byDay.set(r.date, one);
    }
    return {
      system,
      connected: system === 'google' ? (g.connected || rows.length > 0) : rows.length > 0,
      cost: agg.cost,
      value,
      conversions: agg.conversions,
      profit: value * (margin ?? cfg.fallbackMargin) - agg.cost,
      pno: value > 0 ? agg.cost / value : null,
      targetPno: target,
      daily: daily.map(d => ({ date: d.date, ...(byDay.get(d.date) ?? { cost: 0, value: 0 }) }))
    };
  });

  return {
    from, to, days,
    profitAfterAds: { value: grossProfit - cost, prev: sum(prev, 'profit') - costOf(adsPrev) },
    revenue: { value: revenue, prev: prevRevenue },
    cost: { value: cost, prev: costOf(adsPrev) },
    orders: { value: now.length, prev: prev.length },
    profitShare: revenue > 0 ? (grossProfit - cost) / revenue : null,
    shopPno: revenue > 0 ? cost / revenue : null,
    margin,
    targetPno: target,
    systems,
    daily,
    alerts: alerts(cfg, catalog, now, adsNow, daily, revenue > 0 ? (grossProfit - cost) / revenue : null),
    estimatedOrders: now.filter(o => o.estimated).length
  };
}

/**
 * Upozornění, která mají být vidět dřív než čísla.
 *
 * Největší riziko automatické správy reklam nejsou špatná rozhodnutí, ale
 * tiše špatná data: rozbité měření vypadá jako propad výkonu. Proto se tu
 * nejdřív kontroluje, jestli se dá číslům věřit.
 */
function alerts(
  cfg: AdsConfig, catalog: Catalog, orders: OrderMoney[], ads: any[], daily: AdsDay[], share: number | null
): AdsAlert[] {
  const out: AdsAlert[] = [];
  const g = google.googleSecrets();
  const anyAds = ads.length > 0;

  if (!anyAds) {
    out.push(g.connected
      ? { level: 'info', title: 'Zatím žádná data z Google Ads', text: 'Načti data v hlavičce okna — první stažení vezme posledních 90 dní.' }
      : { level: 'info', title: 'Google Ads není připojený', text: isShared()
        ? 'Na tomhle Macu se nepřihlašovalo a ze sdílené složky zatím nic nepřišlo. Připojení je v záložce Nastavení.'
        : 'Připojení je v záložce Nastavení. Stačí na jednom Macu — ostatní si data vezmou ze sdílené složky.' });
  }

  // Data starší než den a půl = noční běh neproběhl
  const newest = (getDb().prepare('SELECT MAX(fetched_at) AS at FROM ads_campaign_day').get() as any)?.at ?? '';
  if (anyAds && newest && Date.now() - new Date(newest).getTime() > 36 * 3600_000) {
    out.push({ level: 'warn', title: 'Data z reklam jsou starší než den', text:
      `Poslední stažení ${new Date(newest).toLocaleString('cs-CZ')}. Noční běh neproběhl — žádný přihlášený Mac nebyl zapnutý.` });
  }

  // Měření: tři dny s útratou a objednávkami, ale bez jediné konverze
  const recent = daily.slice(-3);
  if (anyAds && recent.length === 3 && recent.every(d => d.cost > 50 && d.orders > 0 && d.conversions === 0)) {
    out.push({ level: 'bad', title: 'Měření konverzí možná nefunguje', text:
      'Tři dny reklama utrácí a objednávky chodí, ale Google Ads nevidí ani jednu konverzi. Zkontroluj měřicí kód na děkovné stránce.' });
  }
  // Měření hlásí víc nákupů, než kolik bylo objednávek = počítá dvakrát
  const conv14 = daily.slice(-14).reduce((s, d) => s + d.conversions, 0);
  const orders14 = daily.slice(-14).reduce((s, d) => s + d.orders, 0);
  if (anyAds && orders14 >= 5 && conv14 > orders14 * 1.15) {
    out.push({ level: 'warn', title: 'Konverzí je víc než objednávek', text:
      `Za 14 dní ${Math.round(conv14)} konverzí v Google Ads, ale jen ${orders14} objednávek v e-shopu. `
      + 'Nákup se nejspíš měří dvakrát (dvě značky nebo konverze z GA4 i z Ads) — reklamy pak vypadají lepší, než jsou.' });
  }

  // Marže z odhadu
  const total = catalog.products.length;
  if (total > 0 && catalog.withPrice / total < 0.9) {
    out.push({ level: 'info', title: `Nákupní cenu má ${catalog.withPrice} z ${total} produktů`, text:
      'U ostatních se marže odhaduje podle kategorie. Doplněním nákupních cen v Upgates budou čísla přesnější.' });
  }
  if (orders.length && cfg.shipping.some(one => one.guessed)) {
    out.push({ level: 'info', title: 'Náklady na dopravu jsou zatím odhad', text:
      'V Nastavení doplň, kolik stojí jednotlivé dopravy — zisk z každé objednávky je o ně nižší.' });
  }
  if (share !== null && anyAds && share < cfg.targetProfitShare) {
    out.push({ level: 'warn', title: `Zisk po reklamě ${Math.round(share * 100)} % z obratu`, text:
      `Cíl je ${Math.round(cfg.targetProfitShare * 100)} %. Rozbor podle produktů ukáže, kde reklama utrácí bez zisku.` });
  }
  return out;
}

/* ---------- kampaně ---------- */

export function campaigns(daysWanted = 30): AdsCampaignRow[] {
  const cfg = getAdsConfig();
  const days = Math.min(365, Math.max(7, Math.round(daysWanted) || 30));
  const { from, to } = period(days);
  const catalog = loadCatalog(cfg);
  const orders = ordersBetween(cfg, catalog, from, to);
  const revenue = orders.reduce((s, o) => s + o.revenue + o.fees, 0);
  const margin = revenue > 0 ? orders.reduce((s, o) => s + o.profit, 0) / revenue : null;
  const target = targetPno(margin, cfg.targetProfitShare);

  const list = getDb().prepare(
    'SELECT system, id, name, type, status, budget, bidding, target_roas FROM ads_campaigns'
  ).all() as any[];
  const agg = new Map<string, Agg>();
  for (const r of campaignDays(from, to)) {
    const key = `${r.system}|${r.campaign_id}`;
    const one = agg.get(key) ?? emptyAgg();
    one.cost += czk(cfg, r.cost); one.clicks += r.clicks; one.impressions += r.impressions;
    one.conversions += r.conversions; one.value += czk(cfg, r.value);
    agg.set(key, one);
  }
  return list
    .map(row => {
      const a = agg.get(`${row.system}|${row.id}`) ?? emptyAgg();
      const value = valueNovat(cfg, a.value);
      return {
        system: row.system, id: row.id, name: row.name, type: row.type, status: row.status,
        budget: row.budget != null ? czk(cfg, row.budget) : null, bidding: row.bidding,
        targetRoas: row.target_roas ?? null,
        cost: a.cost, clicks: a.clicks, conversions: a.conversions, value,
        profit: value * (margin ?? cfg.fallbackMargin) - a.cost,
        pno: value > 0 ? a.cost / value : null,
        targetPno: target
      } as AdsCampaignRow;
    })
    // Pozastavené bez útraty v období jen zabírají místo
    .filter(row => row.status === 'ENABLED' || row.cost > 0)
    .sort((a, b) => b.cost - a.cost);
}

/* ---------- produkty a segmenty ---------- */

/**
 * Stáří produktu podle toho, kdy ho aplikace poprvé uviděla ve feedu.
 *
 * Feed z Upgates datum založení nenese. Produkty, které byly v katalogu
 * už při prvním načtení, jsou „staré" (null) — jinak by po zapnutí modulu
 * byl celý katalog třicet dní novinkou.
 */
function ages(): Map<string, number> {
  const d = getDb();
  const out = new Map<string, number>();
  let rows: any[] = [];
  try {
    rows = d.prepare("SELECT code, added_at FROM ptrans_products WHERE added_at <> ''").all() as any[];
  } catch { return out; }
  const first = rows.reduce((min, r) => (!min || r.added_at < min ? r.added_at : min), '');
  if (!first) return out;
  const firstDay = shiftDay(String(first).slice(0, 10), 1);
  const today = localDay();
  for (const r of rows) {
    const day = String(r.added_at).slice(0, 10);
    if (day <= firstDay) continue;
    const age = Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${day}T12:00:00Z`)) / 86_400_000);
    out.set(String(r.code), Math.max(0, age));
  }
  return out;
}

export function products(daysWanted = 30): AdsProducts {
  const cfg = getAdsConfig();
  const days = Math.min(365, Math.max(7, Math.round(daysWanted) || 30));
  const { from, to } = period(days);
  const catalog = loadCatalog(cfg);

  // Výkon z reklam po produktech (varianty se sečtou k rodiči)
  const rows = getDb().prepare(
    `SELECT item_id, SUM(cost) AS cost, SUM(clicks) AS clicks, SUM(impressions) AS impressions,
            SUM(conversions) AS conversions, SUM(value) AS value
     FROM ads_product_day WHERE date BETWEEN ? AND ? GROUP BY item_id`
  ).all(from, to) as any[];
  const perf = new Map<string, Agg>();
  const unmatched: { itemId: string; cost: number }[] = [];
  for (const r of rows) {
    const info = matchItem(catalog, String(r.item_id));
    if (!info) { unmatched.push({ itemId: r.item_id, cost: czk(cfg, r.cost) }); continue; }
    const one = perf.get(info.product) ?? emptyAgg();
    one.cost += czk(cfg, r.cost); one.clicks += r.clicks; one.impressions += r.impressions;
    one.conversions += r.conversions; one.value += valueNovat(cfg, czk(cfg, r.value));
    perf.set(info.product, one);
  }

  // Prodané kusy ze všech objednávek
  const sold = new Map<string, number>();
  for (const order of ordersBetween(cfg, catalog, from, to)) {
    for (const line of order.lines) sold.set(line.product, (sold.get(line.product) ?? 0) + line.quantity);
  }

  const age = ages();
  const inputs = catalog.products.map(p => {
    const a = perf.get(p.code) ?? emptyAgg();
    return {
      code: p.code, ...a,
      margin: productMargin(p) ?? catalog.marginOf(p.category),
      stock: p.stock,
      ageDays: age.has(p.code) ? age.get(p.code)! : null
    };
  });
  const segments = segmentProducts(inputs, cfg.fallbackMargin);

  const counts = { hvezdy: 0, pracanti: 0, zrouti: 0, spici: 0, novinky: 0, doprodej: 0, vyprodano: 0 } as Record<AdsSegment, number>;
  const out: AdsProductRow[] = catalog.products.map((p, index) => {
    const input = inputs[index];
    const seg = segments.get(p.code) ?? { segment: 'spici' as AdsSegment, why: '', profit: 0 };
    counts[seg.segment]++;
    const own = productMargin(p);
    const margin = own ?? catalog.marginOf(p.category);
    return {
      code: p.code, title: p.title, image: p.image, category: p.category,
      segment: seg.segment, why: seg.why,
      margin, marginEstimated: own == null,
      stock: p.stock,
      cost: input.cost, clicks: input.clicks, impressions: input.impressions,
      conversions: input.conversions, value: input.value,
      profit: seg.profit,
      pno: input.value > 0 ? input.cost / input.value : null,
      breakEven: margin,
      targetPno: targetPno(margin, cfg.targetProfitShare),
      sold: sold.get(p.code) ?? 0
    };
  });
  out.sort((a, b) => b.cost - a.cost || b.sold - a.sold || a.title.localeCompare(b.title, 'cs'));
  unmatched.sort((a, b) => b.cost - a.cost);
  return { from, to, rows: out, counts, unmatched: unmatched.slice(0, 50) };
}

/**
 * ID nabídky z Googlu → produkt v katalogu.
 *
 * Google vrací ID malými písmeny a podle šablony feedu je to kód
 * produktu, kód varianty, nebo kód s předponou jazyka („cz-ps120sm").
 * Víc se nehádá: utržený konec kódu by mohl sednout na cizí produkt
 * a útrata by se připsala něčemu, co reklamu vůbec nemá.
 */
function matchItem(catalog: Catalog, itemId: string): PriceInfo | null {
  const id = itemId.trim().toLowerCase();
  return catalog.byCode.get(id)
    ?? catalog.byCode.get(id.replace(/^(cz|sk|en|com)[-_:]/, ''))
    ?? null;
}

/* ---------- doprava ---------- */

/** Způsoby dopravy z objednávek za poslední půlrok, s tím, co zaplatil zákazník. */
export function shipMethods(): AdsShipMethod[] {
  const cfg = getAdsConfig();
  const since = shiftDay(localDay(), -180);
  const rows = getDb().prepare(
    `SELECT shipment AS name, COUNT(*) AS n, AVG(COALESCE(ship_price, 0)) AS paid, MAX(market) AS market
     FROM shop_orders WHERE substr(created_at, 1, 10) >= ? AND shipment <> ''
     GROUP BY shipment ORDER BY n DESC LIMIT 40`
  ).all(since) as any[];
  const vat = vatShop(cfg);
  return rows.map(r => {
    const known = cfg.shipping.find(one => one.name.toLowerCase() === String(r.name).toLowerCase());
    return {
      name: String(r.name),
      orders: Number(r.n) || 0,
      paidAvg: (Number(r.paid) || 0) / vat,
      cost: known ? known.cost : guessShipCost(String(r.name), cfg.defaultShipCost),
      guessed: known ? known.guessed : true
    };
  });
}

/**
 * Výchozí odhad nákladu dopravy. Jen aby čísla nebyla úplně mimo, než
 * je člověk doplní — proto je každý odhad v nastavení označený.
 */
function guessShipCost(name: string, fallback: number): number {
  if (/e-?mail|elektronick|osobn|vyzvednut/i.test(name)) return 0;
  if (/z-?box|výdej|vydej|box|balíkovna|balikovna|parcelshop|pickup/i.test(name)) return 62;
  if (/kurýr|kuryr|domů|domu|adres|ppl|dpd|gls|česká pošta|ceska posta/i.test(name)) return 95;
  return fallback;
}

/**
 * Při prvním otevření předvyplní dopravy odhadem, ať jdou rovnou upravit.
 * Bez posunutí razítka: odhad nesmí přebít dopravy, které už někdo
 * vyplnil na jiném Macu.
 */
function seedShipping(): void {
  const cfg = getAdsConfig();
  if (cfg.shipping.length) return;
  const methods = shipMethods();
  if (!methods.length) return;
  writeLocal({ ...cfg, shipping: methods.map(m => ({ name: m.name, cost: m.cost, guessed: true })) });
}

/* ---------- stažení dat ---------- */

let fetching: Promise<string> | null = null;

/**
 * Stáhne kampaně a výkon z Google Ads.
 *
 * Bere se posledních 28 dní, protože konverze se do reklamních systémů
 * dopisují zpětně (nákup den po kliknutí patří ke dni kliknutí). Úplně
 * první stažení vezme 90 dní, aby segmenty měly z čeho počítat.
 */
export function fetchGoogle(daysBack?: number): Promise<string> {
  if (fetching) return fetching;
  fetching = (async () => {
    const cfg = getAdsConfig();
    if (!google.googleSecrets().connected) throw new Error('Tenhle Mac není přihlášený ke Google Ads.');
    if (!cfg.google.customerId) throw new Error('Vyber v Nastavení účet Google Ads.');
    const any = (getDb().prepare("SELECT 1 FROM ads_campaign_day WHERE system = 'google' LIMIT 1").get());
    const back = daysBack ?? (any ? 28 : 90);
    const to = localDay();
    const from = shiftDay(to, -(back - 1));
    const at = new Date().toISOString();
    try {
      const list = google.parseCampaigns(await google.gaql(cfg, google.CAMPAIGNS_QUERY));
      const days = google.parseCampaignDays(await google.gaql(cfg, google.campaignDaysQuery(from, to)));
      const prods = google.parseProductDays(await google.gaql(cfg, google.productDaysQuery(from, to)));
      // Hledané dotazy vždy za 30 dní — podklad pro vylučující slova
      const terms = google.parseSearchTerms(await google.gaql(cfg,
        google.searchTermsQuery(shiftDay(to, -30), shiftDay(to, -1))));
      saveTerms('google', terms, at);
      saveCampaigns('google', list, at);
      saveDays('ads_campaign_day', 'google', from, to, days, at);
      saveDays('ads_product_day', 'google', from, to, prods, at);
      setSetting('adsGoogleFetched', at);
      setSetting('adsGoogleError', '');
      try { syncStats('google'); } catch { /* složka příště */ }
      emit({ fetched: at });
      return `${list.length} kampaní, ${days.length} dnů kampaní, ${prods.length} dnů produktů`;
    } catch (err: any) {
      setSetting('adsGoogleError', String(err?.message ?? err));
      throw err;
    }
  })().finally(() => { fetching = null; });
  return fetching;
}

function saveTerms(system: 'google', terms: google.TermRow[], at: string): void {
  const d = getDb();
  const cfg = getAdsConfig();
  const ins = d.prepare(`INSERT OR REPLACE INTO ads_search_terms
    (system, campaign_id, term, clicks, impressions, cost, conversions, value, fetched_at)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  d.transaction(() => {
    d.prepare('DELETE FROM ads_search_terms WHERE system = ?').run(system);
    for (const t of terms) {
      ins.run(system, t.campaignId, t.term, t.clicks, t.impressions, czk(cfg, t.cost), t.conversions, czk(cfg, t.value), at);
    }
  })();
}

/* ---------- návrhy ---------- */

/** Marže objednávek po dopravě za posledních 30 dní (bez reklamy) */
function shopMargin(cfg: AdsConfig, catalog: Catalog): number {
  const { from, to } = period(30);
  const orders = ordersBetween(cfg, catalog, from, to);
  const revenue = orders.reduce((s, o) => s + o.revenue + o.fees, 0);
  return revenue > 0 ? orders.reduce((s, o) => s + o.profit, 0) / revenue : cfg.fallbackMargin;
}

/**
 * Přepočítá návrhy z posledních 30 dní.
 *
 * Běží po nočním stažení na Macu, který ho udělal, a na požádání.
 * Návrhy pak putují sdílenou složkou na ostatní Macy.
 */
export function runEngine(): number {
  const cfg = getAdsConfig();
  const catalog = loadCatalog(cfg);
  const margin = shopMargin(cfg, catalog);
  const target = targetPno(margin, cfg.targetProfitShare) ?? 0;
  const rows = campaigns(30);
  const meta = new Map((getDb().prepare(
    "SELECT id, budget_id, budget_shared, limited FROM ads_campaigns WHERE system = 'google'"
  ).all() as any[]).map(r => [String(r.id), r]));
  const list: EngineCampaign[] = rows.filter(r => r.system === 'google').map(r => ({
    id: r.id, name: r.name, type: r.type, status: r.status, bidding: r.bidding, targetRoas: r.targetRoas,
    budget: r.budget, budgetId: meta.get(r.id)?.budget_id ?? '', budgetShared: !!meta.get(r.id)?.budget_shared,
    limited: !!meta.get(r.id)?.limited, cost: r.cost, conversions: r.conversions, value: r.value
  }));
  const terms = (getDb().prepare(
    "SELECT campaign_id, term, clicks, cost, conversions FROM ads_search_terms WHERE system = 'google'"
  ).all() as any[]).map(t => ({ campaignId: String(t.campaign_id), term: t.term, clicks: t.clicks, cost: t.cost, conversions: t.conversions }));
  const prods = products(30).rows;
  const today = localDay();
  const monthStart = `${today.slice(0, 8)}01`;
  const monthSpend = (getDb().prepare('SELECT SUM(cost) AS c FROM ads_campaign_day WHERE date >= ?').get(monthStart) as any)?.c ?? 0;
  const lastDay = new Date(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0).getDate();
  const dataDays = (getDb().prepare('SELECT COUNT(DISTINCT date) AS n FROM ads_campaign_day').get() as any)?.n ?? 0;
  const drafts = generate({
    cfg, margin, targetPno: target, campaigns: list, terms,
    vocabulary: vocabularyOf(catalog.products.map(p => p.title)),
    products: prods.map(p => ({ code: p.code, title: p.title, segment: p.segment, cost: p.cost, profit: p.profit })),
    excluded: new Set(prop.excludedCodes(today).map(one => one.code)),
    cooling: prop.coolingCampaigns(cfg.guards.cooldownDays, today),
    blocked: prop.blockedFingerprints(today),
    monthSpend: czk(cfg, Number(monthSpend) || 0),
    daysLeft: lastDay - Number(today.slice(8, 10)) + 1,
    dataDays: Number(dataDays) || 0
  });
  const fresh = prop.saveGenerated(drafts);
  setSetting('adsProposalsAt', new Date().toISOString());
  try { prop.shareProposals(); } catch { /* složka příště */ }
  emit({ proposals: fresh });
  return fresh;
}

export function proposals(): AdsProposals {
  const cfg = getAdsConfig();
  const margin = shopMargin(cfg, loadCatalog(cfg));
  const vat = cfg.convValueWithVat ? vatShop(cfg) : 1;
  return prop.proposalsView(margin, vat);
}

const feedAfter = async () => { if (webStorage().key) await publishFeed(); };

export async function applyProposal(id: string): Promise<AdsProposal> {
  const result = await prop.applyProposal(getAdsConfig(), id, feedAfter);
  emit();
  return result;
}

export function decideProposal(id: string, decision: prop.Decision): AdsProposal {
  const result = prop.decide(id, decision);
  emit();
  return result;
}

export async function revertChange(id: string): Promise<AdsChange> {
  const result = await prop.revertChange(getAdsConfig(), id, feedAfter);
  emit();
  return result;
}

/* ---------- doplňkový feed ---------- */

function feedPath(cfg: AdsConfig): string {
  return `reklamy/${cfg.feedToken}/segmenty.tsv`;
}

export function feedUrl(): string {
  const cfg = getAdsConfig();
  const s = webStorage();
  if (!s.url) return '';
  return `${s.url}/storage/v1/object/public/${encodeURIComponent(s.bucket)}/${feedPath(cfg)}`;
}

/** Obsah doplňkového feedu — produkt i všechny jeho varianty. */
export function feedText(daysWanted = 30): string {
  const cfg = getAdsConfig();
  const catalog = loadCatalog(cfg);
  const data = products(daysWanted);
  const byCode = new Map(catalog.products.map(p => [p.code, p]));
  const out = new Set(prop.excludedCodes().map(one => one.code));
  const rows: { id: string; segment: AdsSegment; band: string; out: boolean }[] = [];
  for (const row of data.rows) {
    const band = marginBand(row.margin);
    const off = out.has(row.code);
    rows.push({ id: row.code, segment: row.segment, band, out: off });
    for (const variant of byCode.get(row.code)?.variants ?? []) rows.push({ id: variant, segment: row.segment, band, out: off });
  }
  return supplementalTsv(rows);
}

/**
 * Vystaví feed se segmenty do úložiště, odkud ho Merchant Center
 * stahuje. Stejné úložiště jako bannery a texty na webu.
 */
export async function publishFeed(): Promise<string> {
  const s = webStorage();
  if (!s.url || !s.key) throw new Error('Chybí úložiště (Supabase) — nastavuje se u Textů na webu.');
  const cfg = getAdsConfig();
  const clean = feedPath(cfg).split('/').map(encodeURIComponent).join('/');
  const url = `${s.url}/storage/v1/object/${encodeURIComponent(s.bucket)}/${clean}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: s.key,
      Authorization: `Bearer ${s.key}`,
      'Content-Type': 'text/tab-separated-values; charset=utf-8',
      'cache-control': 'max-age=300',
      'x-upsert': 'true'
    },
    body: feedText()
  });
  if (!res.ok) throw new Error(`Feed se nepodařilo vystavit: ${res.status} ${(await res.text()).slice(0, 160)}`);
  const at = new Date().toISOString();
  setSetting('adsFeedPublished', at);
  emit({ feed: at });
  return at;
}

/* ---------- noční běh ---------- */

let nightly = false;

/**
 * Noční běh — kontroluje se každých deset minut, udělá se jednou za den.
 *
 * Mac, který je v noci vypnutý, ho dožene po probuzení. Když už ho dnes
 * udělal jiný Mac (`beh.json` ve sdílené složce), jen si převezme data.
 * Ve fázi 1 se jen stahuje a vystavuje feed; nic se v účtech nemění.
 */
export async function tick(): Promise<void> {
  if (nightly) return;
  const now = new Date();
  nightly = true;
  try {
    // Převzít, co udělaly jiné Macy, se dá kdykoli — běh sám až po třetí
    try { if (syncConfig()) emit(); } catch { /* složka příště */ }
    try { if (syncStats('google') > 0) emit(); } catch { /* složka příště */ }
    try { if (prop.shareProposals()) emit(); } catch { /* složka příště */ }
    // Návrhy schválené na Macu bez přihlášení provede ten přihlášený
    try { if (await prop.applyApproved(getAdsConfig(), feedAfter) > 0) emit(); } catch { /* stav je u návrhu */ }
    if (now.getHours() < 3) return;
    const day = localDay(now);
    if (lastRun()?.day === day) return;
    if (!google.googleSecrets().connected || !getAdsConfig().google.customerId) return;
    const mark = { day, device: deviceLabel(), finishedAt: '', result: '', error: '' };
    try {
      mark.result = await fetchGoogle();
      try {
        const fresh = runEngine();
        if (fresh) mark.result += `, ${fresh} nových návrhů`;
      } catch (err: any) {
        mark.result += `, návrhy: ${err?.message ?? err}`;
      }
      if (webStorage().key) {
        try { await publishFeed(); mark.result += ', feed vystaven'; } catch (err: any) {
          mark.result += `, feed: ${err?.message ?? err}`;
        }
      }
    } catch (err: any) {
      mark.error = String(err?.message ?? err);
    }
    mark.finishedAt = new Date().toISOString();
    markRun(mark);
    emit();
  } finally {
    nightly = false;
  }
}

/* ---------- stav pro okno ---------- */

export function status(): AdsStatus {
  seedShipping();
  const cfg = getAdsConfig();
  const g = google.googleSecrets();
  const catalog = loadCatalog(cfg);
  return {
    config: cfg,
    google: {
      connected: g.connected,
      hasSecret: g.hasSecret,
      account: cfg.google.customerName || cfg.google.customerId,
      lastFetch: getSetting('adsGoogleFetched', '') || '',
      lastError: getSetting('adsGoogleError', '') || ''
    },
    lastRun: lastRun(),
    shared: isShared(),
    feedUrl: feedUrl(),
    feedPublishedAt: getSetting('adsFeedPublished', '') || '',
    purchase: { withPrice: catalog.withPrice, total: catalog.products.length }
  };
}

export function saveConfig(patch: Partial<AdsConfig>): AdsStatus {
  saveAdsConfig(patch);
  emit();
  return status();
}

export async function connectGoogle(clientId: string, secret?: string): Promise<AdsStatus> {
  if (secret && secret.trim()) google.saveGoogleSecret(secret);
  saveAdsConfig({ google: { ...getAdsConfig().google, clientId: clientId.trim() } });
  await google.loginGoogle(clientId, url => shell.openExternal(url));
  emit();
  return status();
}

export function disconnectGoogle(): AdsStatus {
  google.forgetGoogle();
  emit();
  return status();
}

export async function googleCustomers(): Promise<AdsGoogleCustomer[]> {
  return google.listCustomers(getAdsConfig());
}
