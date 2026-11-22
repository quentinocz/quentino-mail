/**
 * Modul Reklamy — data, zisk, segmenty a návrhy změn.
 *
 * Stahuje výkon ze všech zapnutých účtů Google Ads (každý patří jednomu
 * trhu — CZ, SK, .com), páruje ho s objednávkami téhož trhu a s nákupními
 * cenami z katalogu a ukazuje zisk po reklamě, kampaně, produkty
 * v segmentech a návrhy změn. Čísla jdou vidět za všechny trhy dohromady
 * i za každý zvlášť; cílové PNO má každý trh podle své marže.
 *
 * Všechny částky jsou v Kč bez DPH: účet v eurech se přepočte kurzem,
 * hodnota konverzí se zbaví DPH podle trhu účtu.
 */
import { BrowserWindow, shell } from 'electron';
import { getDb, getSetting, setSetting } from '../db';
import { deviceLabel } from '../device';
import { webStorage } from '../webtexts';
import type { ShopOrder } from '../../shared/types';
import {
  AdsConfig, AdsStatus, AdsOverview, AdsSystemTile, AdsAlert, AdsDay, AdsCampaignRow,
  AdsProducts, AdsProductRow, AdsSegment, AdsShipMethod, AdsGoogleCustomer, AdsProposals, AdsChange,
  AdsProposal, AdsAccount, AdsChatTurn, AdsChatReply, AdsSeasons, AdsSeasonPlan, AdsAutopilotState, AdsMetaAccount
} from '../../shared/ads';
import {
  orderMoney, marginTable, productMargin, targetPno, shiftDay, localDay, PriceInfo, OrderMoney
} from './economics';
import { segmentProducts, marginBand, supplementalTsv } from './segments';
import * as google from './google';
import * as sklik from './sklik';
import * as meta from './meta';
import { generate, vocabularyOf, EngineCampaign, roasForPno } from './engine';
import * as prop from './proposals';
import * as chat from './chat';
import * as seas from './seasons';
import * as auto from './autopilot';
import { ask } from '../ai';
import { getSettings } from '../settings';
import {
  getAdsConfig, saveAdsConfig, saveCampaigns, saveDays, syncConfig, syncStats, isShared,
  lastRun, markRun, writeLocal, activeAccounts, accountInfo, accountCzk, accountValue, migrateItems
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

/** Trhy, za které se počítá: 'all' = všechny sledované, jinak jeden */
function marketsOf(cfg: AdsConfig, scope = 'all'): string[] {
  const all = cfg.markets.length ? cfg.markets : ['cz'];
  return scope === 'all' || !scope ? all : [scope];
}

/** Objednávky ve sledovaných trzích mezi dvěma dny (včetně). */
function ordersBetween(cfg: AdsConfig, catalog: Catalog, from: string, to: string, scope = 'all'): OrderMoney[] {
  const markets = marketsOf(cfg, scope);
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

function vatOf(cfg: AdsConfig, market: string): number {
  return 1 + (cfg.vat[market] ?? 21) / 100;
}

/** Řádek z reklam už přepočtený: náklady v Kč, hodnota v Kč bez DPH, s trhem */
interface AdRow {
  system: string; date: string; campaign_id: string; account: string; market: string;
  cost: number; clicks: number; impressions: number; conversions: number; value: number;
}

/**
 * Dny kampaní s účtem a trhem. Účet je u dne, a když chybí (data z doby
 * jednoho účtu), vezme se od kampaně.
 */
function campaignDays(cfg: AdsConfig, from: string, to: string, scope = 'all'): AdRow[] {
  const markets = new Set(marketsOf(cfg, scope));
  const rows = getDb().prepare(
    `SELECT d.system, d.date, d.campaign_id, d.cost, d.clicks, d.impressions, d.conversions, d.value,
            COALESCE(NULLIF(d.account, ''), c.account, '') AS account
     FROM ads_campaign_day d LEFT JOIN ads_campaigns c ON c.system = d.system AND c.id = d.campaign_id
     WHERE d.date BETWEEN ? AND ?`
  ).all(from, to) as any[];
  const out: AdRow[] = [];
  for (const r of rows) {
    const acc = accountInfo(cfg, r.account);
    if (!markets.has(acc.market)) continue;
    out.push({
      system: r.system, date: r.date, campaign_id: String(r.campaign_id), account: acc.id, market: acc.market,
      cost: accountCzk(cfg, acc, Number(r.cost) || 0), clicks: Number(r.clicks) || 0,
      impressions: Number(r.impressions) || 0, conversions: Number(r.conversions) || 0,
      value: accountValue(cfg, acc, Number(r.value) || 0)
    });
  }
  return out;
}

/** Marže objednávek po dopravě po trzích (bez reklamy) */
function marginsByMarket(cfg: AdsConfig, orders: OrderMoney[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of new Set([...cfg.markets, ...orders.map(o => o.market)])) {
    const list = orders.filter(o => o.market === m);
    const revenue = list.reduce((s, o) => s + o.revenue + o.fees, 0);
    out.set(m, revenue > 0 ? list.reduce((s, o) => s + o.profit, 0) / revenue : cfg.fallbackMargin);
  }
  return out;
}

/* ---------- přehled ---------- */

const spanDays = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;

/** Období a stejně dlouhé období před ním (pro srovnání) */
export interface AdsRange { from: string; to: string; prevFrom: string; prevTo: string }

function period(days: number): AdsRange {
  // Končí se včerejškem: dnešek je rozdělaný a srovnával by se celý den s půlkou
  const to = shiftDay(localDay(), -1);
  const from = shiftDay(to, -(days - 1));
  return { from, to, prevFrom: shiftDay(from, -days), prevTo: shiftDay(from, -1) };
}

export function overview(daysWanted = 30, scope = 'all', range?: AdsRange): AdsOverview {
  const cfg = getAdsConfig();
  migrateItems(cfg);
  const days = range ? spanDays(range.from, range.to) : Math.min(365, Math.max(7, Math.round(daysWanted) || 30));
  const { from, to, prevFrom, prevTo } = range ?? period(days);
  const catalog = loadCatalog(cfg);
  const orders = ordersBetween(cfg, catalog, prevFrom, to, scope);
  const now = orders.filter(o => o.date >= from);
  const prev = orders.filter(o => o.date <= prevTo);
  const sum = (list: OrderMoney[], key: 'revenue' | 'profit' | 'fees') => list.reduce((a, o) => a + o[key], 0);

  const ads = campaignDays(cfg, prevFrom, to, scope);
  const adsNow = ads.filter(r => r.date >= from);
  const adsPrev = ads.filter(r => r.date <= prevTo);
  const costOf = (list: AdRow[]) => list.reduce((a, r) => a + r.cost, 0);

  const revenue = sum(now, 'revenue') + sum(now, 'fees');
  const grossProfit = sum(now, 'profit');
  const cost = costOf(adsNow);
  const margin = revenue > 0 ? grossProfit / revenue : null;
  const target = targetPno(margin, cfg.targetProfitShare);
  const prevRevenue = sum(prev, 'revenue') + sum(prev, 'fees');
  const margins = marginsByMarket(cfg, now);

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
      cost: a.reduce((s, x) => s + x.cost, 0),
      conversions: a.reduce((s, x) => s + x.conversions, 0)
    });
  }

  // Systémy — Google, Sklik, Meta (nepřipojený jako prázdná dlaždice s odkazem do Nastavení)
  const g = google.googleSecrets();
  const systems: AdsSystemTile[] = (['google', 'sklik', 'meta'] as const).map(system => {
    const rows = adsNow.filter(r => r.system === system);
    const agg = rows.reduce((acc: Agg, r) => {
      acc.cost += r.cost; acc.conversions += r.conversions; acc.value += r.value;
      return acc;
    }, emptyAgg());
    // Zisk z konverzí podle marže trhu, ze kterého konverze je
    const profit = rows.reduce((s, r) => s + r.value * (margins.get(r.market) ?? cfg.fallbackMargin) - r.cost, 0);
    const byDay = new Map<string, { cost: number; value: number }>();
    for (const r of rows) {
      const one = byDay.get(r.date) ?? { cost: 0, value: 0 };
      one.cost += r.cost;
      one.value += r.value;
      byDay.set(r.date, one);
    }
    return {
      system,
      connected: system === 'google' ? (g.connected || rows.length > 0)
        : system === 'sklik' ? (cfg.sklik.enabled || rows.length > 0)
          : (cfg.meta.enabled && !!cfg.meta.accountId) || rows.length > 0,
      cost: agg.cost,
      value: agg.value,
      conversions: agg.conversions,
      profit,
      pno: agg.value > 0 ? agg.cost / agg.value : null,
      targetPno: target,
      daily: daily.map(d => ({ date: d.date, ...(byDay.get(d.date) ?? { cost: 0, value: 0 }) }))
    };
  });

  // Rozpad po trzích — aby bylo vidět, který trh táhne a který prodělává
  const byMarket = marketsOf(cfg, scope).map(m => {
    const o = now.filter(x => x.market === m);
    const r = o.reduce((s, x) => s + x.revenue + x.fees, 0);
    const c = adsNow.filter(x => x.market === m).reduce((s, x) => s + x.cost, 0);
    return {
      market: m, revenue: r, cost: c,
      profitAfterAds: o.reduce((s, x) => s + x.profit, 0) - c,
      pno: r > 0 ? c / r : null,
      targetPno: targetPno(margins.get(m) ?? null, cfg.targetProfitShare)
    };
  });

  return {
    from, to, days, market: scope || 'all', markets: byMarket,
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
  cfg: AdsConfig, catalog: Catalog, orders: OrderMoney[], ads: AdRow[], daily: AdsDay[], share: number | null
): AdsAlert[] {
  const out: AdsAlert[] = [];
  const g = google.googleSecrets();
  const anyAds = ads.length > 0;

  // Tempo útraty proti měsíčnímu stropu (Pojistky): kam to dojde, když to půjde dál stejně
  if (cfg.guards.monthlyBudget > 0) {
    const today = localDay();
    const monthStart = `${today.slice(0, 8)}01`;
    const daysInMonth = new Date(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0).getDate();
    const done = Number(today.slice(8, 10)) - 1; // dnešek je rozdělaný
    if (done >= 3) {
      const spent = campaignDays(cfg, monthStart, shiftDay(today, -1), 'all').reduce((sum, r) => sum + r.cost, 0);
      const projected = (spent / done) * daysInMonth;
      const cap = cfg.guards.monthlyBudget;
      const fmt = (n: number) => `${Math.round(n).toLocaleString('cs-CZ')} Kč`;
      if (projected > cap * 1.02) {
        out.push({ level: 'warn', title: `Tempo útraty přetáhne měsíční strop`, text:
          `Zatím ${fmt(spent)} za ${done} dní; stejným tempem to na konci měsíce bude ${fmt(projected)} při stropu ${fmt(cap)}. `
          + 'Návrhy na přidání rozpočtu se teď nenabízejí; zvaž ubrat nebo strop zvednout v Nastavení.' });
      } else if (projected < cap * 0.7) {
        out.push({ level: 'info', title: 'Útrata je pod měsíčním stropem', text:
          `Stejným tempem ${fmt(projected)} z ${fmt(cap)}. Je prostor přidat kampaním, které drží cíl.` });
      }
    }
  }

  if (cfg.autonomy === 'guarded' && cfg.autopilot.pausedAt) {
    out.push({ level: 'bad', title: 'Autopilot se zabrzdil', text: `${cfg.autopilot.pausedReason} Znovu ho pustíš v Nastavení.` });
  }

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

export function campaigns(daysWanted = 30, scope = 'all', range?: AdsRange): AdsCampaignRow[] {
  const cfg = getAdsConfig();
  migrateItems(cfg);
  const days = Math.min(365, Math.max(7, Math.round(daysWanted) || 30));
  const { from, to } = range ?? period(days);
  const catalog = loadCatalog(cfg);
  const margins = marginsByMarket(cfg, ordersBetween(cfg, catalog, from, to, 'all'));
  const markets = new Set(marketsOf(cfg, scope));

  const list = getDb().prepare(
    'SELECT system, id, name, type, status, budget, bidding, target_roas, account FROM ads_campaigns'
  ).all() as any[];
  const agg = new Map<string, Agg>();
  for (const r of campaignDays(cfg, from, to, scope)) {
    const key = `${r.system}|${r.campaign_id}`;
    const one = agg.get(key) ?? emptyAgg();
    one.cost += r.cost; one.clicks += r.clicks; one.impressions += r.impressions;
    one.conversions += r.conversions; one.value += r.value;
    agg.set(key, one);
  }
  return list
    .map(row => {
      const acc = accountInfo(cfg, row.account);
      const a = agg.get(`${row.system}|${row.id}`) ?? emptyAgg();
      const margin = margins.get(acc.market) ?? cfg.fallbackMargin;
      return {
        system: row.system, account: acc.id, market: acc.market,
        id: row.id, name: row.name, type: row.type, status: row.status,
        budget: row.budget != null ? accountCzk(cfg, acc, row.budget) : null, bidding: row.bidding,
        targetRoas: row.target_roas ?? null,
        cost: a.cost, clicks: a.clicks, conversions: a.conversions, value: a.value,
        profit: a.value * margin - a.cost,
        pno: a.value > 0 ? a.cost / a.value : null,
        targetPno: targetPno(margin, cfg.targetProfitShare)
      } as AdsCampaignRow;
    })
    // Kampaně vypnutých účtů a jiných trhů pryč; pozastavené bez útraty jen zabírají místo
    .filter(row => markets.has(row.market) && accountInfo(cfg, row.account).enabled)
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

export function products(daysWanted = 30, scope = 'all', range?: AdsRange): AdsProducts {
  const cfg = getAdsConfig();
  migrateItems(cfg);
  const days = Math.min(365, Math.max(7, Math.round(daysWanted) || 30));
  const { from, to } = range ?? period(days);
  const catalog = loadCatalog(cfg);
  const markets = new Set(marketsOf(cfg, scope));

  // Výkon z reklam po produktech a účtech (varianty se sečtou k rodiči)
  const rows = getDb().prepare(
    `SELECT account, item_id, SUM(cost) AS cost, SUM(clicks) AS clicks, SUM(impressions) AS impressions,
            SUM(conversions) AS conversions, SUM(value) AS value
     FROM ads_item_day WHERE date BETWEEN ? AND ? GROUP BY account, item_id`
  ).all(from, to) as any[];
  const perf = new Map<string, Agg>();
  const unmatched = new Map<string, number>();
  for (const r of rows) {
    const acc = accountInfo(cfg, r.account);
    if (!markets.has(acc.market)) continue;
    const cost = accountCzk(cfg, acc, Number(r.cost) || 0);
    const info = matchItem(catalog, String(r.item_id));
    if (!info) { unmatched.set(r.item_id, (unmatched.get(r.item_id) ?? 0) + cost); continue; }
    const one = perf.get(info.product) ?? emptyAgg();
    one.cost += cost; one.clicks += Number(r.clicks) || 0; one.impressions += Number(r.impressions) || 0;
    one.conversions += Number(r.conversions) || 0; one.value += accountValue(cfg, acc, Number(r.value) || 0);
    perf.set(info.product, one);
  }

  // Prodané kusy ze všech objednávek
  const sold = new Map<string, number>();
  for (const order of ordersBetween(cfg, catalog, from, to, scope)) {
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
  const lost = [...unmatched.entries()].map(([itemId, cost]) => ({ itemId, cost })).sort((a, b) => b.cost - a.cost);
  return { from, to, rows: out, counts, unmatched: lost.slice(0, 50) };
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
  return rows.map(r => {
    const known = cfg.shipping.find(one => one.name.toLowerCase() === String(r.name).toLowerCase());
    // Slovenská a anglická doprava je v eurech a s jinou DPH
    const market = String(r.market || 'cz');
    const paid = (Number(r.paid) || 0) * (market === 'cz' ? 1 : cfg.eurRate);
    return {
      name: String(r.name),
      orders: Number(r.n) || 0,
      paidAvg: paid / vatOf(cfg, market),
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
 * Stáhne kampaně a výkon ze všech zapnutých účtů Google Ads.
 *
 * Bere se posledních 28 dní, protože konverze se do reklamních systémů
 * dopisují zpětně (nákup den po kliknutí patří ke dni kliknutí). Účet,
 * ze kterého ještě nic není, se poprvé stáhne za 90 dní, aby segmenty
 * měly z čeho počítat.
 *
 * Chyba jednoho účtu nezastaví ostatní: slovenský účet bez přístupu
 * nesmí připravit český trh o čerstvá data. Chyby se pamatují po účtech.
 */
export function fetchGoogle(daysBack?: number): Promise<string> {
  if (fetching) return fetching;
  fetching = (async () => {
    const cfg = getAdsConfig();
    migrateItems(cfg);
    if (!google.googleSecrets().connected) throw new Error('Tenhle Mac není připojený ke Google Ads.');
    const accounts = activeAccounts(cfg);
    if (!accounts.length) throw new Error('Přidej v Nastavení aspoň jeden účet Google Ads.');
    const to = localDay();
    const at = new Date().toISOString();
    const errors: Record<string, string> = {};
    const done: string[] = [];
    for (const acc of accounts) {
      try {
        /*
         * Bez přístupu k účtu se zkusí najít manažerský účet (MCC), přes
         * který přístup je, a zapamatuje se u účtu. Patrik (22. 11.): český
         * účet šel přímo, slovenský najednou „nemá přístup" — byl pod MCC.
         */
        try {
          await google.gaql(cfg, 'SELECT customer.id FROM customer LIMIT 1', acc.id);
        } catch (err: any) {
          if (err?.code !== 'USER_PERMISSION_DENIED') throw err;
          const manager = await google.findManager(cfg, acc.id);
          if (!manager) throw err;
          const fresh = getAdsConfig();
          saveAdsConfig({ google: { ...fresh.google, accounts: fresh.google.accounts.map(a => (a.id === acc.id ? { ...a, login: manager } : a)) } });
          cfg.google.accounts = getAdsConfig().google.accounts;
        }
        const any = getDb().prepare("SELECT 1 FROM ads_campaign_day WHERE system = 'google' AND account = ? LIMIT 1").get(acc.id);
        const back = daysBack ?? (any ? 28 : 90);
        const from = shiftDay(to, -(back - 1));
        const list = google.parseCampaigns(await google.gaql(cfg, google.CAMPAIGNS_QUERY, acc.id));
        const days = google.parseCampaignDays(await google.gaql(cfg, google.campaignDaysQuery(from, to), acc.id));
        const prods = google.parseProductDays(await google.gaql(cfg, google.productDaysQuery(from, to), acc.id));
        // Hledané dotazy vždy za 30 dní — podklad pro vylučující slova
        const terms = google.parseSearchTerms(await google.gaql(cfg,
          google.searchTermsQuery(shiftDay(to, -30), shiftDay(to, -1)), acc.id));
        saveTerms(acc.id, terms, at);
        saveCampaigns('google', list, at, acc.id);
        saveDays('ads_campaign_day', 'google', from, to, days, at, acc.id);
        saveDays('ads_item_day', 'google', from, to, prods, at, acc.id);
        done.push(`${MARKET_NAME[acc.market] ?? acc.market}: ${list.length} kampaní`);
      } catch (err: any) {
        errors[acc.id] = String(err?.message ?? err);
      }
    }
    setSetting('adsAccountErrors', JSON.stringify(errors));
    if (!done.length) {
      const first = Object.values(errors)[0] ?? 'neznámá chyba';
      setSetting('adsGoogleError', first);
      throw new Error(first);
    }
    setSetting('adsGoogleFetched', at);
    setSetting('adsGoogleError', Object.keys(errors).length
      ? `Některé účty se nestáhly: ${Object.entries(errors).map(([id, e]) => `${accountInfo(cfg, id).name || id} — ${e}`).join('; ')}`
      : '');
    try { syncStats('google'); } catch { /* složka příště */ }
    emit({ fetched: at });
    return done.join(', ') + (Object.keys(errors).length ? ` (${Object.keys(errors).length} účet s chybou)` : '');
  })().finally(() => { fetching = null; });
  return fetching;
}

const MARKET_NAME: Record<string, string> = { cz: 'CZ', sk: 'SK', en: '.com' };

let fetchingSklik: Promise<string> | null = null;

/**
 * Stáhne kampaně a výkon ze Skliku. Stejné okno jako Google (28 dní,
 * poprvé 90), aby se dopsané konverze opravily i zpětně.
 *
 * Sklik nevrací produkty po dnech ani hledané dotazy tak, jak je potřebují
 * segmenty a vylučující slova — ty zůstávají na Googlu. Ze Skliku jsou
 * kampaně, útrata a konverze, a to stačí na zisk po reklamě a rozpočty.
 */
export function fetchSklik(daysBack?: number): Promise<string> {
  if (fetchingSklik) return fetchingSklik;
  fetchingSklik = (async () => {
    const cfg = getAdsConfig();
    if (!cfg.sklik.enabled) throw new Error('Sklik je v Nastavení vypnutý.');
    if (!sklik.sklikToken()) throw new Error('Tenhle Mac nemá uložený token Skliku.');
    const to = localDay();
    const at = new Date().toISOString();
    try {
      const any = getDb().prepare("SELECT 1 FROM ads_campaign_day WHERE system = 'sklik' LIMIT 1").get();
      const from = shiftDay(to, -((daysBack ?? (any ? 28 : 90)) - 1));
      const days = await sklik.sklikDays(from, to, cfg.sklik.userId);
      const limited = sklik.limitedFrom(days, to);
      const list = (await sklik.sklikCampaigns(cfg.sklik.userId))
        .map(c => ({ ...c, limited: c.limited || limited.has(c.id) }));
      saveCampaigns('sklik', list, at, 'sklik');
      saveDays('ads_campaign_day', 'sklik', from, to, days, at, 'sklik');
      setSetting('adsSklikFetched', at);
      setSetting('adsSklikError', '');
      try { syncStats('sklik'); } catch { /* složka příště */ }
      emit({ fetched: at });
      return `Sklik: ${list.length} kampaní`;
    } catch (err: any) {
      setSetting('adsSklikError', String(err?.message ?? err));
      throw err;
    }
  })().finally(() => { fetchingSklik = null; });
  return fetchingSklik;
}

let fetchingMeta: Promise<string> | null = null;

/**
 * Stáhne kampaně a výkon z Mety. Stejné okno jako ostatní (28 dní, poprvé
 * 90): Meta konverze dopisuje zpětně podle atribučního okna.
 */
export function fetchMeta(daysBack?: number): Promise<string> {
  if (fetchingMeta) return fetchingMeta;
  fetchingMeta = (async () => {
    const cfg = getAdsConfig();
    if (!cfg.meta.enabled || !cfg.meta.accountId) throw new Error('Meta není v Nastavení zapnutá.');
    if (!meta.metaToken()) throw new Error('Tenhle Mac nemá uložený token Meta.');
    const to = localDay();
    const at = new Date().toISOString();
    try {
      const any = getDb().prepare("SELECT 1 FROM ads_campaign_day WHERE system = 'meta' LIMIT 1").get();
      const from = shiftDay(to, -((daysBack ?? (any ? 28 : 90)) - 1));
      const list = await meta.metaCampaigns(cfg.meta.accountId);
      const days = await meta.metaDays(cfg.meta.accountId, from, to);
      saveCampaigns('meta', list, at, 'meta');
      saveDays('ads_campaign_day', 'meta', from, to, days, at, 'meta');
      setSetting('adsMetaFetched', at);
      setSetting('adsMetaError', '');
      try { syncStats('meta'); } catch { /* složka příště */ }
      emit({ fetched: at });
      return `Meta: ${list.length} kampaní`;
    } catch (err: any) {
      setSetting('adsMetaError', String(err?.message ?? err));
      throw err;
    }
  })().finally(() => { fetchingMeta = null; });
  return fetchingMeta;
}

/** Co se má stahovat na tomhle Macu */
function sources(cfg: AdsConfig): { google: boolean; sklik: boolean; meta: boolean } {
  return {
    google: google.googleSecrets().connected && activeAccounts(cfg).length > 0,
    sklik: cfg.sklik.enabled && !!sklik.sklikToken(),
    meta: cfg.meta.enabled && !!cfg.meta.accountId && !!meta.metaToken()
  };
}

/**
 * Stáhne všechny připojené systémy. Chyba jednoho nezastaví druhý —
 * výsledek říká, co prošlo a co ne; chyba jen když neprošlo nic.
 */
export async function fetchAll(daysBack?: number): Promise<string> {
  const cfg = getAdsConfig();
  const src = sources(cfg);
  if (!src.google && !src.sklik && !src.meta) {
    throw new Error('Tenhle Mac nemá připojený Google Ads, Sklik ani Metu (Reklamy → Nastavení).');
  }
  const done: string[] = [];
  const errors: string[] = [];
  if (src.google) {
    try { done.push(await fetchGoogle(daysBack)); } catch (err: any) { errors.push(`Google: ${err?.message ?? err}`); }
  }
  if (src.sklik) {
    try { done.push(await fetchSklik(daysBack)); } catch (err: any) { errors.push(String(err?.message ?? err)); }
  }
  if (src.meta) {
    try { done.push(await fetchMeta(daysBack)); } catch (err: any) { errors.push(String(err?.message ?? err)); }
  }
  if (!done.length) throw new Error(errors.join(' · '));
  return [...done, ...errors.map(e => `chyba — ${e}`)].join(', ');
}

/** Dotazy se ukládají v měně účtu; přepočet až při čtení, jako u ostatních čísel */
function saveTerms(account: string, terms: google.TermRow[], at: string): void {
  const d = getDb();
  const ins = d.prepare(`INSERT OR REPLACE INTO ads_search_terms
    (system, campaign_id, term, clicks, impressions, cost, conversions, value, fetched_at, account)
    VALUES ('google',?,?,?,?,?,?,?,?,?)`);
  d.transaction(() => {
    d.prepare("DELETE FROM ads_search_terms WHERE system = 'google' AND account = ?").run(account);
    for (const t of terms) {
      ins.run(t.campaignId, t.term, t.clicks, t.impressions, t.cost, t.conversions, t.value, at, account);
    }
  })();
}

/* ---------- návrhy ---------- */

/**
 * Přepočítá návrhy z posledních 30 dní — pro každý trh zvlášť.
 *
 * Každý trh má vlastní marži (slovenské objednávky mají jinou DPH, dopravu
 * i ceny), a tedy vlastní cílové PNO. Kampaně slovenského účtu se proto
 * měří slovenským cílem, ne českým. Vyřazení žroutů jde přes společný
 * feed, a tak se počítá jednou, za všechny trhy.
 *
 * Běží po nočním stažení na Macu, který ho udělal, a na požádání.
 * Návrhy pak putují sdílenou složkou na ostatní Macy.
 */
export function runEngine(): number {
  const cfg = getAdsConfig();
  migrateItems(cfg);
  const catalog = loadCatalog(cfg);
  const { from, to } = period(30);
  const margins = marginsByMarket(cfg, ordersBetween(cfg, catalog, from, to, 'all'));
  const budgets = new Map((getDb().prepare(
    "SELECT system, id, budget_id, budget_shared, limited FROM ads_campaigns"
  ).all() as any[]).map(r => [`${r.system}|${r.id}`, r]));
  const everything = campaigns(30, 'all');
  const termRows = getDb().prepare(
    "SELECT campaign_id, term, clicks, cost, conversions, account FROM ads_search_terms WHERE system = 'google'"
  ).all() as any[];
  const prods = products(30, 'all').rows;
  const today = localDay();
  const monthStart = `${today.slice(0, 8)}01`;
  const monthSpend = campaignDays(cfg, monthStart, today, 'all').reduce((s, r) => s + r.cost, 0);
  const lastDay = new Date(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0).getDate();
  const dataDays = (getDb().prepare('SELECT COUNT(DISTINCT date) AS n FROM ads_campaign_day').get() as any)?.n ?? 0;
  const vocabulary = vocabularyOf(catalog.products.map(p => p.title));
  const excluded = new Set(prop.excludedCodes(today).map(one => one.code));
  const cooling = prop.coolingCampaigns(cfg.guards.cooldownDays, today);
  const blocked = prop.blockedFingerprints(today);

  // Google po trzích, Sklik zvlášť (jen CZ) — každý systém má své návrhy
  const runs: { system: 'google' | 'sklik' | 'meta'; market: string }[] = [
    ...[...new Set(activeAccounts(cfg).map(a => a.market))].filter(m => cfg.markets.includes(m))
      .map(market => ({ system: 'google' as const, market })),
    ...(cfg.sklik.enabled && cfg.markets.includes('cz') ? [{ system: 'sklik' as const, market: 'cz' }] : []),
    ...(cfg.meta.enabled && cfg.meta.accountId && cfg.markets.includes(cfg.meta.market)
      ? [{ system: 'meta' as const, market: cfg.meta.market }] : [])
  ];
  const drafts = {
    google: [] as ReturnType<typeof generate>, sklik: [] as ReturnType<typeof generate>, meta: [] as ReturnType<typeof generate>
  };
  let feedDone = false;
  runs.forEach(({ system, market }) => {
    const all = everything.filter(r => r.system === system);
    const margin = margins.get(market) ?? cfg.fallbackMargin;
    const list: EngineCampaign[] = all.filter(r => r.market === market).map(r => {
      const m = budgets.get(`${system}|${r.id}`);
      return {
        id: r.id, account: r.account, name: r.name, type: r.type, status: r.status, bidding: r.bidding,
        targetRoas: r.targetRoas, budget: r.budget, budgetId: m?.budget_id ?? '',
        budgetShared: !!m?.budget_shared, limited: !!m?.limited,
        cost: r.cost, conversions: r.conversions, value: r.value
      };
    });
    const ids = new Set(list.map(c => c.id));
    const terms = system !== 'google' ? [] : termRows.filter(t => ids.has(String(t.campaign_id))).map(t => ({
      campaignId: String(t.campaign_id), term: t.term, clicks: t.clicks, conversions: t.conversions,
      cost: accountCzk(cfg, accountInfo(cfg, t.account), Number(t.cost) || 0)
    }));
    // Strop je společný pro všechny trhy i systémy
    const otherDaily = everything.filter(r => !(r.system === system && r.market === market) && r.status === 'ENABLED')
      .reduce((s, r) => s + (r.budget ?? 0), 0);
    const withFeed = system === 'google' && !feedDone;
    if (withFeed) feedDone = true;
    drafts[system].push(...generate({
      cfg, system, market, margin, targetPno: targetPno(margin, cfg.targetProfitShare) ?? 0, campaigns: list, terms,
      vocabulary,
      // Žrouti jdou přes společný feed — jednou, ne za každý trh
      products: withFeed
        ? prods.map(p => ({ code: p.code, title: p.title, segment: p.segment, cost: p.cost, profit: p.profit }))
        : [],
      excluded, cooling, blocked, monthSpend, otherDaily,
      daysLeft: lastDay - Number(today.slice(8, 10)) + 1,
      dataDays: Number(dataDays) || 0
    }));
  });
  drafts.google.sort((a, b) => b.impact - a.impact);
  drafts.sklik.sort((a, b) => b.impact - a.impact);
  drafts.meta.sort((a, b) => b.impact - a.impact);
  const fresh = prop.saveGenerated(drafts.google, 'google') + prop.saveGenerated(drafts.sklik, 'sklik')
    + prop.saveGenerated(drafts.meta, 'meta');
  setSetting('adsProposalsAt', new Date().toISOString());
  try { prop.shareProposals(); } catch { /* složka příště */ }
  emit({ proposals: fresh });
  return fresh;
}

export function proposals(): AdsProposals {
  const cfg = getAdsConfig();
  migrateItems(cfg);
  const catalog = loadCatalog(cfg);
  const { from, to } = period(30);
  const margins = marginsByMarket(cfg, ordersBetween(cfg, catalog, from, to, 'all'));
  // Všechny systémy — Sklik má účet 'sklik' (ID kampaní se mezi systémy nepotkají: Google má delší)
  const accountOf = new Map((getDb().prepare('SELECT id, account FROM ads_campaigns')
    .all() as any[]).map(r => [String(r.id), String(r.account ?? '')]));
  return prop.proposalsView(campaignId => {
    const acc: AdsAccount = accountInfo(cfg, accountOf.get(campaignId) ?? '');
    return {
      margin: margins.get(acc.market) ?? cfg.fallbackMargin,
      cost: (n: number) => accountCzk(cfg, acc, n),
      value: (n: number) => accountValue(cfg, acc, n)
    };
  });
}

const feedAfter = async () => { if (webStorage().key) await publishFeed(); };

/* ---------- nová kampaň pro segment ---------- */

/**
 * Návrh nové kampaně Nákupy jen pro hvězdy jednoho trhu.
 *
 * Proč: hvězdy (vydělávají a mají dost dat) se v jedné velké kampani dělí
 * o rozpočet se vším ostatním. Vlastní kampaň jim dá rozpočet, který jim
 * nedojde, a cíl návratnosti podle jejich marže. Kampaň vybírá produkty
 * podle custom_label_0 = hvezdy z doplňkového feedu, takže se složení
 * mění samo s každým přepočtem segmentů.
 *
 * Rozpočet = jejich dosavadní denní útrata + 30 % (aby měly kam růst),
 * cíl ROAS z marže hvězd a cíle zisku.
 */
export function proposeSegmentCampaign(market: string): AdsProposal {
  const cfg = getAdsConfig();
  if (!cfg.google.merchantId) throw new Error('Doplň v Nastavení → Google Ads → Pokročilé ID účtu Merchant Center.');
  const account = activeAccounts(cfg).find(a => a.market === market);
  if (!account) throw new Error(`Pro trh ${MARKET_NAME[market] ?? market} není zapnutý účet Google Ads.`);
  if (!webStorage().key || !getSetting('adsFeedPublished', '')) {
    throw new Error('Kampaň vybírá produkty podle doplňkového feedu se segmenty — nejdřív ho vystav a přidej do Merchant Center (Nastavení).');
  }
  const rows = products(30, market).rows.filter(p => p.segment === 'hvezdy');
  if (rows.length < 3) throw new Error(`Hvězd je na trhu ${MARKET_NAME[market] ?? market} zatím ${rows.length} — vlastní kampaň má smysl od tří.`);
  const name = `Quentino · Hvězdy · ${MARKET_NAME[market] ?? market} (Nákupy)`;
  const existing = getDb().prepare("SELECT id FROM ads_campaigns WHERE system = 'google' AND name = ? AND account = ?").get(name, account.id);
  if (existing) throw new Error(`Kampaň „${name}" už v účtu je.`);
  const cost = rows.reduce((s, p) => s + p.cost, 0);
  const value = rows.reduce((s, p) => s + p.value, 0);
  const marginW = rows.reduce((s, p) => s + (p.margin ?? cfg.fallbackMargin) * Math.max(1, p.value), 0)
    / Math.max(1, rows.reduce((s, p) => s + Math.max(1, p.value), 0));
  const target = targetPno(marginW, cfg.targetProfitShare) ?? 0;
  if (!(target > 0)) throw new Error('Marže hvězd nestačí na cíl zisku — vlastní kampaň by ho nedržela.');
  const troas = Math.round(roasForPno(cfg, target, market) * 10) / 10;
  const budget = Math.max(100, Math.round(((cost / 30) * 1.3) / 10) * 10);
  const pno = value > 0 ? cost / value : null;
  const draft = {
    fingerprint: `campaign-new|google|${account.id}|hvezdy`,
    system: 'google' as const, market, notBefore: '', kind: 'campaign-new' as const,
    targetId: account.id, targetName: name,
    title: `Nová kampaň: ${name} — ${rows.length} hvězd, ${kc(budget)} denně, cílové ROAS ${Math.round(troas * 100)} %`,
    plain: `Hvězdy (${rows.length} produktů, které vydělávají a mají dost prodejů) teď soutěží o rozpočet se vším ostatním. `
      + `Vlastní kampaň Nákupy jim dá ${kc(budget)} denně a cíl návratnosti podle jejich marže. Vznikne pozastavená — `
      + 'v Google Ads ji zkontroluješ (produkty, rozpočet) a zapneš. Produkty vybírá podle segmentu z feedu, takže se složení '
      + 'samo mění. Zvaž, jestli hvězdy pak v ostatních kampaních vyloučit (custom_label_0 = hvezdy), ať si nekonkurují.',
    why: `Hvězdy za 30 dní: útrata ${kc(cost)}, hodnota konverzí ${kc(value)}${pno != null ? `, PNO ${Math.round(pno * 1000) / 10} %` : ''}; `
      + `marže ${Math.round(marginW * 100)} %, cílové PNO ${Math.round(target * 1000) / 10} %.`,
    impact: 0, confidence: Math.min(4, Math.max(1, Math.floor(rows.reduce((s, p) => s + p.conversions, 0) / 25) + 1)),
    ops: [{
      kind: 'campaign-create' as const, account: account.id, market, name, budget, troas, segment: 'hvezdy',
      merchantId: cfg.google.merchantId, feedLabel: cfg.google.feedLabels[market] ?? '', geo: google.GEO_OF_MARKET[market] ?? []
    }]
  };
  // Stejný návrh už čeká — nezakládat druhý
  const waiting = prop.proposalsView(() => ({ margin: 0, cost: n => n, value: n => n })).open
    .find(p => p.fingerprint === draft.fingerprint);
  if (waiting) return waiting;
  const [saved] = prop.saveChat([draft]);
  emit({ proposals: 1 });
  return saved;
}

const kc = (n: number) => `${Math.round(n).toLocaleString('cs-CZ')} Kč`;

/* ---------- autopilot ---------- */

function firstProposalAt(): string {
  return String((getDb().prepare('SELECT MIN(created_at) AS at FROM ads_proposals').get() as any)?.at ?? '');
}

function autopilotLast(): { at: string; applied: string[] } | null {
  try { return JSON.parse(getSetting('adsAutopilotLast', '') || 'null'); } catch { return null; }
}

export function autopilotState(view = proposals()): AdsAutopilotState {
  return auto.autopilotState(getAdsConfig(), view.changes, firstProposalAt(), localDay(), autopilotLast());
}

/**
 * Noční kolo autopilota (po stažení dat a přepočtu návrhů). Nejdřív
 * brzda, pak nejvýš pár návrhů podle odhadu. Vrací krátký výsledek do
 * záznamu nočního běhu (ten vidí všechny Macy).
 */
export async function autopilotNight(): Promise<string> {
  const cfg = getAdsConfig();
  const view = proposals();
  const state = auto.autopilotState(cfg, view.changes, firstProposalAt(), localDay(), autopilotLast());
  if (!state.active) return '';
  const reason = auto.brake(view.changes);
  if (reason) {
    saveAdsConfig({ autopilot: { ...cfg.autopilot, pausedAt: new Date().toISOString(), pausedReason: reason } });
    emit();
    return 'autopilot se zabrzdil';
  }
  const applied: string[] = [];
  for (const p of auto.pick(cfg, view.open)) {
    try {
      const done = await prop.applyProposal(cfg, p.id, feedAfter, `${auto.AUTOPILOT_PREFIX} · ${deviceLabel()}`);
      if (done.status === 'applied' || done.status === 'approved') applied.push(p.title);
    } catch { /* stav (zastaralé, chyba) je u návrhu */ }
  }
  setSetting('adsAutopilotLast', JSON.stringify({ at: new Date().toISOString(), applied }));
  if (applied.length) emit();
  return applied.length ? `autopilot: ${applied.length} změn` : 'autopilot: nic k použití';
}

/** Pustit zabrzděného autopilota znovu */
export function resumeAutopilot(): AdsStatus {
  const cfg = getAdsConfig();
  saveAdsConfig({ autopilot: { ...cfg.autopilot, pausedAt: '', pausedReason: '' } });
  emit();
  return status();
}

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
  const data = products(daysWanted, 'all');
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
    try { if (syncStats('google') + syncStats('sklik') + syncStats('meta') > 0) emit(); } catch { /* složka příště */ }
    try { if (prop.shareProposals()) emit(); } catch { /* složka příště */ }
    // Návrhy schválené na Macu bez přihlášení provede ten přihlášený
    try { if (await prop.applyApproved(getAdsConfig(), feedAfter) > 0) emit(); } catch { /* stav je u návrhu */ }
    if (now.getHours() < 3) return;
    const day = localDay(now);
    if (lastRun()?.day === day) return;
    const src = sources(getAdsConfig());
    if (!src.google && !src.sklik && !src.meta) return;
    const mark = { day, device: deviceLabel(), finishedAt: '', result: '', error: '' };
    try {
      mark.result = await fetchAll();
      try {
        const fresh = runEngine();
        if (fresh) mark.result += `, ${fresh} nových návrhů`;
      } catch (err: any) {
        mark.result += `, návrhy: ${err?.message ?? err}`;
      }
      try {
        const ap = await autopilotNight();
        if (ap) mark.result += `, ${ap}`;
      } catch (err: any) {
        mark.result += `, autopilot: ${err?.message ?? err}`;
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

/* ---------- sezóny ---------- */

/** Hlavní kategorie z cesty v katalogu („Kšandy > Široké" → „Kšandy") */
const topCategory = (category: string) => String(category ?? '').split(/\s*[>|/]\s*/)[0].trim() || 'Ostatní';

/**
 * Denní tržby (bez DPH) ze všech objednávek — celkem a po hlavních
 * kategoriích. Bere se celá historie, kterou aplikace má: sezónní index
 * chce aspoň rok, nejlépe víc.
 */
function dailySales(cfg: AdsConfig, catalog: Catalog, scope: string): { total: Map<string, number>; byCategory: Map<string, Map<string, number>> } {
  const categoryOf = new Map(catalog.products.map(p => [p.code, topCategory(p.category)]));
  const total = new Map<string, number>();
  const byCategory = new Map<string, Map<string, number>>();
  for (const o of ordersBetween(cfg, catalog, '2000-01-01', localDay(), scope)) {
    total.set(o.date, (total.get(o.date) ?? 0) + o.revenue);
    for (const line of o.lines) {
      const cat = categoryOf.get(line.product) ?? 'Ostatní';
      const map = byCategory.get(cat) ?? new Map<string, number>();
      map.set(o.date, (map.get(o.date) ?? 0) + line.revenue);
      byCategory.set(cat, map);
    }
  }
  return { total, byCategory };
}

function seasonIndexOf(cfg: AdsConfig, catalog: Catalog, scope: string) {
  const today = localDay();
  const sales = dailySales(cfg, catalog, scope);
  return { today, sales, idx: seas.seasonIndex(sales.total, today) };
}

export function seasons(scope = 'all'): AdsSeasons {
  const cfg = getAdsConfig();
  const catalog = loadCatalog(cfg);
  const { today, sales, idx } = seasonIndexOf(cfg, catalog, scope);
  // Kategorie s největší tržbou — víc jich graf nepřehledně zahltí
  const top = [...sales.byCategory.entries()]
    .map(([name, map]) => ({ name, map, sum: [...map.values()].reduce((s, v) => s + v, 0) }))
    .sort((a, b) => b.sum - a.sum).slice(0, 6);
  return {
    today,
    index: idx.index,
    categories: top.map(c => ({ name: c.name, index: seas.seasonIndex(c.map, today).index })),
    weeks: idx.weeks,
    years: idx.years,
    events: seas.eventsView(idx, today).map(e => ({ ...e, planned: prop.planCount(e.id) }))
  };
}

/**
 * Plán rozpočtů na událost. Bez `save` jen náhled; s ním se dosavadní
 * kroky téže události zruší a nové se uloží jako naplánované návrhy.
 */
export function seasonPlan(eventId: string, save = false, scope = 'all'): AdsSeasonPlan {
  const cfg = getAdsConfig();
  migrateItems(cfg);
  const catalog = loadCatalog(cfg);
  const { today, idx } = seasonIndexOf(cfg, catalog, scope);
  const metaOf = new Map((getDb().prepare(
    'SELECT system, id, budget_id, budget_shared FROM ads_campaigns'
  ).all() as any[]).map(r => [`${r.system}|${r.id}`, r]));
  const list: seas.PlanCampaign[] = campaigns(30, scope)
    .filter(c => c.system === 'google' || c.system === 'sklik' || c.system === 'meta')
    .map(c => {
      const m = metaOf.get(`${c.system}|${c.id}`);
      return {
        system: c.system as 'google' | 'sklik' | 'meta', id: c.id, account: c.account, market: c.market, name: c.name,
        status: c.status, budget: c.budget, budgetId: String(m?.budget_id ?? ''), budgetShared: !!m?.budget_shared,
        pno: c.pno, targetPno: c.targetPno, conversions: c.conversions
      };
    });
  const plan = seas.planEvent(cfg, eventId, list, idx, today);
  let saved = 0;
  if (save) {
    prop.dropPlan(eventId);
    saved = prop.saveChat(plan.drafts).length;
    emit({ proposals: saved });
  }
  return {
    eventId, uplift: plan.uplift, notes: plan.notes, saved,
    steps: plan.drafts.map(d => ({ date: d.notBefore, title: d.title, plain: d.plain, system: d.system, kind: d.kind }))
  };
}

/** Zruší naplánované kroky události */
export function dropSeasonPlan(eventId: string): number {
  const n = prop.dropPlan(eventId);
  emit();
  return n;
}

/* ---------- poradce ---------- */

/**
 * Otázka na poradce. Odpověď je text a z navržených kroků rovnou návrhy
 * (ty jdou přes stejné pojistky a kontroly jako návrhy enginu).
 */
export async function askAdvisor(history: AdsChatTurn[], question: string, scope = 'all'): Promise<AdsChatReply> {
  const q = String(question ?? '').trim();
  if (!q) throw new Error('Napiš otázku.');
  const cfg = getAdsConfig();
  migrateItems(cfg);
  const catalog = loadCatalog(cfg);
  const { from, to } = period(30);
  const margins = marginsByMarket(cfg, ordersBetween(cfg, catalog, from, to, 'all'));
  const today = localDay();
  const monthStart = `${today.slice(0, 8)}01`;
  const lastDay = new Date(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0).getDate();
  const budgets = new Map((getDb().prepare(
    'SELECT system, id, budget_id, budget_shared, limited FROM ads_campaigns'
  ).all() as any[]).map(r => [`${r.system}|${r.id}`, {
    budgetId: String(r.budget_id ?? ''), budgetShared: !!r.budget_shared, limited: !!r.limited
  }]));
  const view = proposals();
  const ctx: chat.ChatContext = {
    cfg, today,
    overview: overview(30, scope),
    campaigns: campaigns(30, scope),
    meta: budgets,
    products: products(30, scope).rows,
    open: view.open,
    changes: view.changes,
    vocabulary: vocabularyOf(catalog.products.map(p => p.title)),
    margins: Object.fromEntries([...margins].map(([m, v]) => [m, Math.round(v * 1000) / 1000])),
    monthSpend: campaignDays(cfg, monthStart, today, 'all').reduce((s, r) => s + r.cost, 0),
    daysLeft: lastDay - Number(today.slice(8, 10)) + 1,
    seasons: (() => {
      try {
        const { idx } = seasonIndexOf(cfg, catalog, scope);
        return seas.eventsView(idx, today).slice(0, 6);
      } catch { return []; }
    })()
  };
  const s = getSettings();
  const text = await ask(s.insightModel || s.draftModel, chat.SYSTEM,
    chat.userMessage(ctx, (history ?? []).map(t => ({ role: t.role, text: t.text })), q), 6000);
  const reply = chat.parseReply(text);
  const { drafts, notes } = chat.draftsFrom(reply.actions, ctx, q);
  const created = prop.saveChat(drafts);
  if (created.length) emit({ proposals: created.length });
  return { answer: reply.answer || 'Odpověď nepřišla — zkus otázku položit jinak.', proposals: created, notes };
}

/* ---------- stav pro okno ---------- */

export function status(): AdsStatus {
  seedShipping();
  const cfg = getAdsConfig();
  const g = google.googleSecrets();
  const catalog = loadCatalog(cfg);
  return {
    config: cfg,
    autopilot: autopilotState(),
    google: {
      connected: g.connected,
      hasSecret: g.hasSecret,
      service: g.service,
      account: activeAccounts(cfg).map(a => a.name || a.id).join(', '),
      accountErrors: (() => { try { return JSON.parse(getSetting('adsAccountErrors', '{}') || '{}'); } catch { return {}; } })(),
      lastFetch: getSetting('adsGoogleFetched', '') || '',
      lastError: getSetting('adsGoogleError', '') || ''
    },
    sklik: {
      hasToken: !!sklik.sklikToken(),
      lastFetch: getSetting('adsSklikFetched', '') || '',
      lastError: getSetting('adsSklikError', '') || ''
    },
    meta: {
      hasToken: !!meta.metaToken(),
      lastFetch: getSetting('adsMetaFetched', '') || '',
      lastError: getSetting('adsMetaError', '') || ''
    },
    lastRun: lastRun(),
    shared: isShared(),
    feedUrl: feedUrl(),
    feedPublishedAt: getSetting('adsFeedPublished', '') || '',
    purchase: { withPrice: catalog.withPrice, total: catalog.products.length }
  };
}

export function saveConfig(patch: Partial<AdsConfig>): AdsStatus {
  if (patch.autonomy === 'guarded' && getAdsConfig().autonomy !== 'guarded') {
    const state = autopilotState();
    if (!state.eligible) throw new Error(`Autopilot ještě nejde zapnout: ${state.missing.join(', ')}.`);
  }
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

/** Připojení servisním účtem — obsah JSON souboru s klíčem */
export function connectService(json: string): AdsStatus {
  google.saveServiceKey(json);
  emit();
  return status();
}

export function disconnectGoogle(): AdsStatus {
  google.forgetGoogle();
  emit();
  return status();
}

/**
 * Uloží token Skliku a hned ho vyzkouší. Špatný token se neuloží — jinak
 * by noční běh každou noc padal na přihlášení a nikdo by nevěděl proč.
 */
export async function connectSklik(token: string, userId: string): Promise<{ status: AdsStatus; message: string }> {
  const before = sklik.sklikToken();
  const clean = String(token ?? '').trim();
  if (clean) sklik.saveSklikToken(clean);
  saveAdsConfig({ sklik: { ...getAdsConfig().sklik, userId: String(userId ?? '').replace(/\D/g, '') } });
  try {
    const message = await sklik.sklikTest(getAdsConfig().sklik.userId);
    saveAdsConfig({ sklik: { ...getAdsConfig().sklik, enabled: true } });
    setSetting('adsSklikError', '');
    emit();
    return { status: status(), message };
  } catch (err) {
    if (clean) sklik.saveSklikToken(before);
    throw err;
  }
}

/**
 * Uloží token Meta a načte reklamní účty, ke kterým má přístup. Token
 * se uloží jen tehdy, když Meta účty vrátí (špatný token = chyba, nic se
 * nezmění).
 */
export async function metaConnect(token: string): Promise<AdsMetaAccount[]> {
  const before = meta.metaToken();
  const clean = String(token ?? '').trim();
  if (clean) meta.saveMetaToken(clean);
  try {
    const list = await meta.metaAccounts();
    setSetting('adsMetaError', '');
    emit();
    return list;
  } catch (err) {
    if (clean) meta.saveMetaToken(before);
    throw err;
  }
}

/** Vybere reklamní účet Meta, vyzkouší ho a zapne stahování */
export async function metaUse(account: AdsMetaAccount, market: string): Promise<{ status: AdsStatus; message: string }> {
  const message = await meta.metaTest(account.id);
  saveAdsConfig({ meta: { enabled: true, accountId: account.id, name: account.name || 'Meta',
    currency: account.currency || 'CZK', market: market || 'cz' } });
  emit();
  return { status: status(), message };
}

export function disconnectMeta(): AdsStatus {
  meta.saveMetaToken('');
  emit();
  return status();
}

export function disconnectSklik(): AdsStatus {
  sklik.saveSklikToken('');
  emit();
  return status();
}

export async function googleCustomers(): Promise<AdsGoogleCustomer[]> {
  return google.listCustomers(getAdsConfig());
}
