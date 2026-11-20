/**
 * Kolik objednávka opravdu vydělala.
 *
 * Reklamní systémy znají jen tržbu. Jenže kravata za 600 Kč s nákupní cenou
 * 100 Kč a ponožky za 300 Kč s nákupní cenou 180 Kč snesou úplně jiné
 * náklady na reklamu — a jedno PNO pro celý e-shop by na ponožkách
 * prodělávalo a na kravatách zbytečně šetřilo. Tenhle modul proto z každé
 * objednávky spočítá zisk před reklamou:
 *
 *   zboží bez DPH − nákupní ceny + doprava a platba zaplacené zákazníkem
 *   (bez DPH) − co nás doprava stojí
 *
 * Funkce tu jsou čisté (bez databáze), aby se daly vyzkoušet na vzorku.
 */
import type { ShopOrder } from '../../shared/types';
import type { AdsConfig } from '../../shared/ads';

/** Co víme o kódu z katalogu — produkt i varianta mají vlastní kód. */
export interface PriceInfo {
  /** Kód produktu (u varianty kód rodiče) — po něm se sčítá */
  product: string;
  category: string;
  /** Nákupní cena bez DPH; null = v e-shopu nevyplněná */
  purchase: number | null;
  /** Prodejní cena bez DPH podle katalogu */
  novat: number | null;
}

export type PriceLookup = (code: string) => PriceInfo | null;

export interface OrderLine {
  product: string;
  code: string;
  quantity: number;
  /** Tržba bez DPH v Kč */
  revenue: number;
  /** Nákupní cena za řádek; odhadnutá, když chybí */
  purchase: number;
  estimated: boolean;
}

export interface OrderMoney {
  code: string;
  market: string;
  /** Den vzniku objednávky (YYYY-MM-DD, místní čas e-shopu) */
  date: string;
  cancelled: boolean;
  /** Zboží bez DPH v Kč */
  revenue: number;
  /** Doprava a platba, co zaplatil zákazník, bez DPH */
  fees: number;
  purchase: number;
  shipCost: number;
  /** Zisk před reklamou */
  profit: number;
  /** Některá položka neměla nákupní cenu — zisk je zčásti odhad */
  estimated: boolean;
  lines: OrderLine[];
}

/**
 * Stornované a vrácené objednávky se nepočítají.
 *
 * Reklama za ně zaplatila, ale zisk nepřinesly — kdyby se počítaly,
 * vycházely by kampaně lepší, než jsou. Stav je text z e-shopu, proto
 * se pozná podle slova, ne podle čísla stavu.
 */
export function isCancelled(status: string): boolean {
  return /storn|zru[sš]en|vr[aá]cen|cancel|refund/i.test(status ?? '');
}

/** Den z času vzniku — feed ho má v místním čase e-shopu i s posunem. */
export function orderDate(createdAt: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(createdAt ?? '');
  return match ? match[1] : '';
}

function vatOf(cfg: AdsConfig, market: string): number {
  const rate = cfg.vat[market] ?? cfg.vat.cz ?? 21;
  return 1 + rate / 100;
}

/** Koruny z měny objednávky. Neznámá měna = koruny (feed ji občas nevyplní). */
function toCzk(cfg: AdsConfig, currency: string, amount: number): number {
  return /eur/i.test(currency ?? '') ? amount * cfg.eurRate : amount;
}

/**
 * Náklad dopravy podle názvu.
 *
 * Přesná shoda vyhrává; jinak se zkusí, jestli název začíná zapsaným
 * („Zásilkovna" pokryje „Zásilkovna Z-Box"). Doprava e-mailem a osobní
 * odběr nic nestojí — jinak by se na dárkovém poukazu počítal balík.
 */
export function shipCostOf(cfg: AdsConfig, name: string): number {
  const clean = (name ?? '').trim().toLowerCase();
  if (!clean) return cfg.defaultShipCost;
  const exact = cfg.shipping.find(one => one.name.trim().toLowerCase() === clean);
  if (exact) return exact.cost;
  const prefix = cfg.shipping
    .filter(one => one.name.trim() && clean.startsWith(one.name.trim().toLowerCase()))
    .sort((a, b) => b.name.length - a.name.length)[0];
  if (prefix) return prefix.cost;
  if (/e-?mail|elektronick|osobn|vyzvednut/i.test(clean)) return 0;
  return cfg.defaultShipCost;
}

/**
 * Je cena položky za kus, nebo za celý řádek?
 *
 * Export Upgates to v různých šablonách dělá různě a u řádku „2 ks" je to
 * rozdíl dvojnásobku. Rozhodne součet: který výklad dá s dopravou
 * a platbou celkovou cenu objednávky, ten platí. Když export uvádí cenu
 * za kus zvlášť, žádné hádání není potřeba.
 */
export function linePrices(order: ShopOrder): number[] {
  const items = order.items ?? [];
  if (items.every(item => typeof item.unitPrice === 'number')) {
    return items.map(item => (item.unitPrice ?? 0) * (item.quantity || 1));
  }
  const asUnit = items.map(item => item.price * (item.quantity || 1));
  const asLine = items.map(item => item.price);
  const fees = (order.shipmentPrice ?? 0) + (order.paymentPrice ?? 0);
  const expected = (order.total || 0) - fees;
  const sum = (list: number[]) => list.reduce((a, b) => a + b, 0);
  if (!order.total) return asUnit;
  return Math.abs(sum(asLine) - expected) < Math.abs(sum(asUnit) - expected) ? asLine : asUnit;
}

/**
 * Peníze jedné objednávky.
 *
 * `marginOf` dá marži pro produkt bez nákupní ceny (z kategorie nebo
 * celého obchodu) — bez ní by takový produkt vypadal jako čistý zisk.
 */
export function orderMoney(
  order: ShopOrder,
  lookup: PriceLookup,
  cfg: AdsConfig,
  marginOf: (category: string) => number
): OrderMoney {
  const vat = vatOf(cfg, order.market);
  const prices = linePrices(order);
  let estimated = false;
  const lines: OrderLine[] = (order.items ?? []).map((item, index) => {
    const revenue = toCzk(cfg, order.currency, prices[index] ?? 0) / vat;
    const info = lookup(item.code);
    const quantity = item.quantity || 1;
    let purchase = 0;
    let lineEstimated = false;
    if (info?.purchase != null) {
      purchase = info.purchase * quantity;
    } else if (revenue > 0) {
      // Bez nákupní ceny se vezme marže kategorie (nebo obchodu)
      purchase = revenue * (1 - marginOf(info?.category ?? ''));
      lineEstimated = true;
    }
    if (lineEstimated) estimated = true;
    return {
      product: info?.product ?? item.code,
      code: item.code,
      quantity,
      revenue,
      purchase,
      estimated: lineEstimated
    };
  });

  const revenue = lines.reduce((sum, line) => sum + line.revenue, 0);
  const purchase = lines.reduce((sum, line) => sum + line.purchase, 0);
  const fees = toCzk(cfg, order.currency, (order.shipmentPrice ?? 0) + (order.paymentPrice ?? 0)) / vat;
  const shipCost = shipCostOf(cfg, order.shipment);
  const cancelled = isCancelled(order.status);
  return {
    code: order.code,
    market: order.market,
    date: orderDate(order.createdAt),
    cancelled,
    revenue,
    fees,
    purchase,
    shipCost,
    profit: revenue + fees - purchase - shipCost,
    estimated,
    lines
  };
}

/**
 * Marže pro produkty bez nákupní ceny.
 *
 * Medián kategorie, protože průměr by roztáhl jeden produkt s chybně
 * zadanou nákupní cenou. Kategorie s méně než třemi produkty se
 * nepočítá — na dvou kusech se medián ukazovat nedá — a platí marže
 * celého obchodu.
 */
export function marginTable(
  products: { category: string; purchase: number | null; novat: number | null }[],
  fallback: number
): (category: string) => number {
  const byCategory = new Map<string, number[]>();
  const all: number[] = [];
  for (const one of products) {
    if (one.purchase == null || !one.novat || one.novat <= 0) continue;
    const margin = 1 - one.purchase / one.novat;
    if (!Number.isFinite(margin) || margin <= -1 || margin >= 1) continue;
    all.push(margin);
    const list = byCategory.get(one.category) ?? [];
    list.push(margin);
    byCategory.set(one.category, list);
  }
  const median = (list: number[]) => {
    const sorted = [...list].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  };
  const shop = all.length >= 3 ? median(all) : fallback;
  const cache = new Map<string, number>();
  for (const [category, list] of byCategory) {
    if (list.length >= 3) cache.set(category, median(list));
  }
  return (category: string) => cache.get(category) ?? shop;
}

/** Marže jednoho produktu z katalogu; null, když chybí cena bez DPH. */
export function productMargin(info: { purchase: number | null; novat: number | null }): number | null {
  if (info.purchase == null || !info.novat || info.novat <= 0) return null;
  return 1 - info.purchase / info.novat;
}

/**
 * Cílové PNO z marže.
 *
 * Bod zlomu je marže — při PNO rovném marži produkt na reklamě vydělá
 * nulu. Požadovaný podíl zisku se od marže odečte. Když vyjde pod 3 %,
 * produkt cíl nesplní při žádné rozumné reklamě; vrací se 0, aby to
 * bylo vidět, a ne aby se reklamě dovolilo prodělávat.
 */
export function targetPno(margin: number | null, profitShare: number): number | null {
  if (margin == null) return null;
  const target = margin - profitShare;
  return target < 0.03 ? 0 : target;
}

/** Den o `n` dní dřív, jako YYYY-MM-DD (počítá se v poledne kvůli letnímu času). */
export function shiftDay(day: string, n: number): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + n);
  return date.toISOString().slice(0, 10);
}

/** Místní dnešek jako YYYY-MM-DD */
export function localDay(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
