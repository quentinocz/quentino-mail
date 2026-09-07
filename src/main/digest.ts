/**
 * AI Přehled.
 *
 * Ráno je potřeba vědět tři věci: **jak se prodává**, **co čeká na
 * odpověď** a **co s tím**. První dvě jsou fakta — dají se spočítat
 * z feedu objednávek a z pošty, přesně a zadarmo. Třetí je úvaha a na tu
 * je tu AI.
 *
 * ## Proč je to rozdělené
 *
 * Původní přehled byl jeden odstavec od AI a měl dvě vady, které se
 * v provozu ukázaly hned:
 *
 *  - **Připomínal vyřízené věci.** Šel podle příznaku „zodpovězeno" ze
 *    serveru, jenže ten se u odpovědi odeslané odjinud nenastaví. Teď se
 *    bere celé vlákno: když po zprávě něco odešlo, je hotovo — a ke každé
 *    položce se drží odkaz, takže se dá rovnou otevřít.
 *  - **Generoval se při každém kliknutí.** Stálo to peníze a čas a pokaždé
 *    vyšlo něco trochu jiného. Čísla se proto počítají pořád (jsou to
 *    dotazy do databáze), ale **postřehy od AI nejvýš jednou za 24 hodin**;
 *    do té doby se ukazují uložené a přegenerovat jde tlačítkem.
 *
 * ## Paměť
 *
 * Každý postřeh se uloží i s čísly, ze kterých vznikl. Do příštího zadání
 * jde pár posledních — AI tak vidí, co navrhla minule a jak to dopadlo,
 * a místo opakování téhož může navazovat.
 *
 * ## Co počítá kód a co AI
 *
 * Srovnání se počítají **v kódu**, ne modelem: růst a pokles, posun
 * v platbách a dopravě, nejsilnější den v týdnu, zboží, které vyskočilo
 * nebo spadlo, nezaplacené objednávky, které leží. Vyjde z toho seznam
 * signálů — hotových vět s čísly, na které se dá spolehnout, protože je
 * nikdo nevymyslel.
 *
 * AI dostane právě tyhle signály a její úkol je jiný: **vybrat, co z toho
 * je důležité, a říct proč a co s tím**. Nemá si přidávat vlastní čísla
 * a u každého bodu musí uvést, o co se opírá — když se to nedá napsat,
 * nemá tam ten bod co dělat.
 *
 * ## Okno je klouzavé, ne kalendářní
 *
 * Prvního září má „tenhle měsíc" jeden den a srovnání s jedním dnem srpna
 * je náhoda. Hlavní okno jsou proto **poslední tři desítky dní** proti
 * předchozím třiceti; kalendářní měsíc zůstává jako údaj, ne jako podklad
 * pro závěry.
 */
import { getDb, getSetting, setSetting } from './db';
import { getSettings } from './settings';
import { ask, askLong } from './ai';
import { shortFor } from './shorthand';
import { listConversations } from './chat/supabase';
import { isConfigured as chatConfigured } from './chat/config';
import * as live from './live';
import { historyView } from './digesthistory';
import { socialView } from './digestsocial';
import { ga4Snapshot } from './ga4';
import type {
  DigestDay, DigestFacts, DigestGa4, DigestHistory, DigestInsight, DigestNote, DigestPending, DigestPost,
  DigestProduct, DigestReport, DigestSignal, DigestSizeGroup, DigestSlice, DigestSocial, DigestTask,
  DigestTotals
} from '../shared/types';

/** Délka hlavního okna ve dnech */
const WINDOW = 30;

/* ---------- pomůcky ---------- */

/** Kalendářní den v místním čase jako `YYYY-MM-DD` */
function dayKey(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function shiftDays(date: Date, by: number): Date {
  const out = new Date(date);
  out.setDate(out.getDate() + by);
  return out;
}

/**
 * Stornovaná objednávka.
 *
 * Do tržby nepatří, ale zmizet nesmí — dvacet storn za den je samo o sobě
 * ta nejdůležitější zpráva dne.
 */
function isCancelled(status: string): boolean {
  return /storn|zru[šs]en|vr[áa]cen|cancel|refund/i.test(status ?? '');
}

interface Row {
  code: string; market: string; status: string; paid: number; created_at: string;
  currency: string; total: number; email: string; shipment: string; payment: string;
  items_json: string; billing_json: string | null; postal_json: string | null;
}

/** Objednávky od data — jednou načtené, počítá se z nich všechno ostatní */
function ordersFrom(since: string): Row[] {
  try {
    return getDb().prepare(
      `SELECT code, market, status, paid, created_at, currency, total, email,
              shipment, payment, items_json, billing_json, postal_json
         FROM shop_orders WHERE created_at >= ? ORDER BY created_at DESC LIMIT 5000`
    ).all(since) as any[];
  } catch {
    return [];
  }
}

/**
 * Položky objednávky.
 *
 * `total` (cena za řádek) přibylo později — u objednávek stažených starší
 * verzí ve feedu není a dopočítá se z ceny za kus, proto je nepovinné.
 */
function itemsOf(row: Row): {
  title: string; code: string; quantity: number; price: number; total?: number;
}[] {
  try {
    const list = JSON.parse(row.items_json || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/**
 * Země objednávky.
 *
 * Nejdřív doručovací adresa — o zemi rozhoduje, kam balík jede, ne kam se
 * posílá faktura. Když adresa chybí (rychlý feed ji nenese), zbývá trh.
 */
function countryOf(row: Row): string {
  for (const raw of [row.postal_json, row.billing_json]) {
    if (!raw) continue;
    try {
      const one = JSON.parse(raw);
      const country = String(one?.country ?? '').trim();
      if (country) return country.toUpperCase().slice(0, 3);
    } catch { /* rozbitý JSON není důvod přehled nepostavit */ }
  }
  return (row.market || '').toUpperCase();
}

function emptyTotals(): DigestTotals {
  return { orders: 0, cancelled: 0, unpaid: 0, revenue: [], items: 0 };
}

function totalsOf(rows: Row[]): DigestTotals {
  const out = emptyTotals();
  const money = new Map<string, number>();
  for (const row of rows) {
    out.orders++;
    if (isCancelled(row.status)) { out.cancelled++; continue; }
    if (!row.paid) out.unpaid++;
    const currency = (row.currency || 'CZK').toUpperCase();
    money.set(currency, (money.get(currency) ?? 0) + Number(row.total || 0));
    for (const item of itemsOf(row)) out.items += Number(item.quantity) || 0;
  }
  out.revenue = [...money.entries()]
    .map(([currency, amount]) => ({ currency, amount: Math.round(amount) }))
    .sort((a, b) => b.amount - a.amount);
  return out;
}

/** Kolik je v převažující měně — do dlaždic a do grafu */
function inCurrency(totals: DigestTotals, currency: string): number {
  return totals.revenue.find(one => one.currency === currency)?.amount ?? 0;
}

/* ---------- katalog: varianty a ceník ---------- */

interface CatalogEntry {
  /** Kód produktu — u varianty ten nadřazený */
  base: string;
  title: string;
  /** Kategorie z katalogu — velikosti se srovnávají uvnitř ní, ne napříč */
  category: string;
  /** Označení varianty („110 cm"), u produktu prázdné */
  label: string;
  /** Cena z ceníku; použije se, jen když ji feed u položky nemá */
  price: number;
  /** Obrázek z feedu — v seznamu se zboží pozná dřív očima než čtením */
  image: string | null;
}

/**
 * Kódy zboží na produkty.
 *
 * Ve feedu objednávek je kód **varianty**: šle 110 cm a 120 cm mají každé
 * svůj. Pro otázku „co se prodává" jsou to ale jedny šle — a naopak pro
 * otázku „jaká velikost jde nejvíc" je zajímavá právě ta varianta. Drží se
 * tedy obojí: k jakému produktu varianta patří a jak se jmenuje.
 *
 * Ceník je tu kvůli položkám, u kterých feed cenu nenese (dárek, sada,
 * starší objednávka). Nula u nejprodávanějšího zboží vypadá jako chyba,
 * a přitom stačí sáhnout do katalogu, který je v aplikaci stejně stažený.
 */
function catalogIndex(): Map<string, CatalogEntry> {
  const out = new Map<string, CatalogEntry>();
  const d = getDb();

  /*
   * Obrázek přibyl do katalogu později. Starší databáze sloupec nemá a celý
   * dotaz by na něm spadl — katalog by zmizel a s ním kategorie u velikostí.
   */
  let catalogRows: any[] = [];
  try {
    catalogRows = d.prepare('SELECT code, title_cz, price_num, category, image FROM products').all() as any[];
  } catch {
    try {
      catalogRows = d.prepare('SELECT code, title_cz, price_num, category FROM products').all() as any[];
    } catch { catalogRows = []; }
  }
  try {
    for (const row of catalogRows) {
      const code = String(row.code ?? '').trim();
      if (!code) continue;
      out.set(code.toLowerCase(), {
        base: code,
        title: String(row.title_cz ?? code),
        label: '',
        price: Number(row.price_num) || 0,
        image: row.image || null,
        /*
         * Kategorie kvůli velikostem. „110 cm vede" napříč celým e-shopem
         * nedává smysl — kšandy, pásky a kravaty mají každé jiné velikosti
         * a míchat je dohromady znamená sečíst centimetry s obvodem krku.
         */
        category: String(row.category ?? '').trim()
      });
    }
  } catch { /* katalog nemusí být stažený */ }

  try {
    for (const row of d.prepare(
      'SELECT code, product_code, label, price FROM product_variants'
    ).all() as any[]) {
      const code = String(row.code ?? '').trim();
      const base = String(row.product_code ?? '').trim() || code;
      if (!code) continue;
      const parent = out.get(base.toLowerCase());
      out.set(code.toLowerCase(), {
        base,
        title: parent?.title ?? base,
        category: parent?.category ?? '',
        label: String(row.label ?? '').trim(),
        // Cena varianty je text („499 Kč"), tak z ní vytáhneme číslo
        price: Number(String(row.price ?? '').replace(/[^\d.,]/g, '').replace(',', '.')) || parent?.price || 0,
        image: parent?.image ?? null
      });
    }
  } catch { /* varianty jsou v databázi až od novější verze */ }

  return out;
}

/**
 * Za kolik se totéž zboží prodalo jinde — **v každé měně zvlášť**.
 *
 * Poslední záchrana ceny. Feed u části položek cenu nenese (dárek, bonus,
 * sada). Cena z jiné objednávky je pořád **skutečná cena**, za kterou to
 * někdo koupil — a rozhodně lepší než nula, ze které se v postřehu stane
 * „prodává se zadarmo".
 *
 * Měny se nemíchají: eurová cena je odpověď na eurovou objednávku, korunová
 * na korunovou. Dřív se braly jen koruny, takže zboží prodávané jen do
 * zahraničí zůstalo bez ceny úplně.
 *
 * Bere se **medián**, ne průměr: jedna sleva nebo jeden dárek zdarma by
 * průměr strhly, medián ne.
 */
function knownUnitPrices(rows: Row[]): Map<string, Map<string, number>> {
  const prices = new Map<string, Map<string, number[]>>();
  for (const row of rows) {
    if (isCancelled(row.status)) continue;
    const currency = (row.currency || 'CZK').toUpperCase();
    const perCurrency = prices.get(currency) ?? new Map<string, number[]>();
    for (const item of itemsOf(row)) {
      const code = String(item.code || item.title || '').trim().toLowerCase();
      if (!code) continue;
      const qty = Number(item.quantity) || 0;
      const unit = Number(item.price) || (qty > 0 ? (Number(item.total) || 0) / qty : 0);
      if (unit > 0) perCurrency.set(code, [...(perCurrency.get(code) ?? []), unit]);
    }
    prices.set(currency, perCurrency);
  }

  const out = new Map<string, Map<string, number>>();
  for (const [currency, perCurrency] of prices) {
    const median = new Map<string, number>();
    for (const [code, list] of perCurrency) {
      list.sort((a, b) => a - b);
      median.set(code, list[Math.floor(list.length / 2)]);
    }
    out.set(currency, median);
  }
  return out;
}

/* ---------- nákupy místo objednávek ---------- */

/** Do kolika hodin se dvě objednávky téhož zákazníka počítají jako jeden nákup */
const SAME_PURCHASE_HOURS = 48;

/**
 * Objednávky slité na nákupy.
 *
 * Když zákazníkovi neprojde platba, objedná znovu. Když si to rozmyslí
 * a přikoupí opasek, objedná znovu. Pro tržbu jsou to dvě objednávky —
 * pro otázku „kolik lidí u nás nakoupilo" jeden nákup. Bez tohohle
 * slučování vycházel opakovaný nákup nesmyslně vysoko: e-shop si sám sobě
 * počítal dvojice objednávek jako vracející se zákazníky.
 */
function purchasesOf(rows: Row[]): { purchases: number; duplicates: number } {
  const byEmail = new Map<string, string[]>();
  let anonymous = 0;

  for (const row of rows) {
    if (isCancelled(row.status)) continue;
    const email = String(row.email ?? '').trim().toLowerCase();
    if (!email) { anonymous++; continue; }
    const list = byEmail.get(email) ?? [];
    list.push(String(row.created_at ?? ''));
    byEmail.set(email, list);
  }

  let purchases = anonymous;
  let orders = anonymous;
  for (const times of byEmail.values()) {
    orders += times.length;
    const sorted = [...times].sort();
    let last = '';
    for (const at of sorted) {
      const gap = last
        ? new Date(at).getTime() - new Date(last).getTime()
        : Number.POSITIVE_INFINITY;
      if (!Number.isFinite(gap) || gap > SAME_PURCHASE_HOURS * 3600_000) purchases++;
      last = at;
    }
  }
  return { purchases, duplicates: Math.max(0, orders - purchases) };
}

function sliceRows(
  rows: Row[], keyOf: (row: Row) => string, labelOf: (key: string) => string
): DigestSlice[] {
  const found = new Map<string, DigestSlice>();
  for (const row of rows) {
    const key = keyOf(row);
    if (!key) continue;
    const one = found.get(key) ?? { key, label: labelOf(key), orders: 0, revenue: 0 };
    one.orders++;
    if (!isCancelled(row.status)) one.revenue += Number(row.total || 0);
    found.set(key, one);
  }
  return [...found.values()]
    .map(one => ({ ...one, revenue: Math.round(one.revenue) }))
    .sort((a, b) => b.orders - a.orders);
}

/**
 * Rozpad uvnitř řádku.
 *
 * „Zásilkovna 44×" je půl odpovědi — jestli se u ní platí kartou, nebo
 * dobírkou, rozhoduje o penězích i o práci s balíkem. Počítá se ke každému
 * řádku zvlášť a v rozhraní se ukáže až po najetí myší.
 */
function withSplit(
  rows: DigestSlice[], source: Row[], keyOf: (row: Row) => string, byOf: (row: Row) => string
): DigestSlice[] {
  const inside = new Map<string, Map<string, number>>();
  for (const row of source) {
    const key = keyOf(row);
    const by = byOf(row);
    if (!key || !by) continue;
    const found = inside.get(key) ?? new Map<string, number>();
    found.set(by, (found.get(by) ?? 0) + 1);
    inside.set(key, found);
  }
  return rows.map(one => ({
    ...one,
    split: [...(inside.get(one.key) ?? new Map<string, number>()).entries()]
      .map(([label, orders]) => ({ label, orders }))
      .sort((a, b) => b.orders - a.orders)
      .slice(0, 5)
  }));
}

/* ---------- signály: závěry, které spočítá kód ---------- */

interface SignalInput {
  currency: string;
  days: DigestDay[];
  window: DigestTotals;
  prevWindow: DigestTotals;
  returning: number;
  purchases: number;
  duplicates: number;
  windowRows: Row[];
  prevRows: Row[];
  payments: DigestSlice[];
  shipments: DigestSlice[];
  countries: DigestSlice[];
  products: DigestProduct[];
  prevProducts: Map<string, number>;
  sizes: DigestSizeGroup[];
  history: DigestHistory;
  social: DigestSocial | null;
}

const DAY_NAMES = ['neděle', 'pondělí', 'úterý', 'středa', 'čtvrtek', 'pátek', 'sobota'];

/** Kolik procent je rozdíl; bez základu se nepočítá nic */
function pct(now: number, before: number): number | null {
  if (!before) return null;
  return Math.round(((now - before) / before) * 100);
}

/**
 * Co se v číslech změnilo.
 *
 * Tohle je schválně **kód, ne model**. Srovnat dvě čísla a spočítat podíl
 * umí kód přesně a zadarmo, kdežto model se v tom umí splést a hlavně si
 * dokáže vymyslet trend, který v datech není. Vyjde z toho seznam vět,
 * pod kterými je vždycky vidět, z čeho vznikly.
 *
 * Prahy jsou tu proto, aby se z šumu nedělaly zprávy: pod pět objednávek
 * v srovnávaném období se nic neporovnává a rozdíly do deseti procent
 * se nehlásí.
 */
export function signalsOf(input: SignalInput): DigestSignal[] {
  const out: DigestSignal[] = [];
  const { currency, window: now, prevWindow: before } = input;
  // Kód měny je v tabulce v pořádku, ve větě ne — „19 400 CZK" nikdo neříká
  const money = (value: number) => `${Math.round(value)} ${currency === 'CZK' ? 'Kč' : currency}`;

  // 1) Objednávky a tržba proti předchozím třiceti dnům
  if (before.orders >= 5) {
    const change = pct(now.orders, before.orders);
    if (change !== null && Math.abs(change) >= 10) {
      out.push({
        kind: change > 0 ? 'up' : 'down',
        text: `Objednávek je o ${Math.abs(change)} % ${change > 0 ? 'víc' : 'míň'} než v předchozích 30 dnech.`,
        basis: `${now.orders} proti ${before.orders}`
      });
    }
    const nowMoney = now.revenue.find(one => one.currency === currency)?.amount ?? 0;
    const beforeMoney = before.revenue.find(one => one.currency === currency)?.amount ?? 0;
    const moneyChange = pct(nowMoney, beforeMoney);
    if (moneyChange !== null && Math.abs(moneyChange) >= 10) {
      out.push({
        kind: moneyChange > 0 ? 'up' : 'down',
        text: `Tržba je o ${Math.abs(moneyChange)} % ${moneyChange > 0 ? 'vyšší' : 'nižší'} než v předchozích 30 dnech.`,
        basis: `${money(nowMoney)} proti ${money(beforeMoney)}`
      });
    }
    /*
     * Průměrná objednávka. Umí se hnout na opačnou stranu než tržba —
     * a právě to je zajímavé: víc objednávek za míň peněz znamená něco
     * jiného než míň objednávek za víc.
     */
    const nowPaid = now.orders - now.cancelled;
    const beforePaid = before.orders - before.cancelled;
    if (nowPaid > 0 && beforePaid > 0) {
      const nowAvg = Math.round(nowMoney / nowPaid);
      const beforeAvg = Math.round(beforeMoney / beforePaid);
      const avgChange = pct(nowAvg, beforeAvg);
      if (avgChange !== null && Math.abs(avgChange) >= 10) {
        out.push({
          kind: avgChange > 0 ? 'up' : 'down',
          text: `Průměrná objednávka ${avgChange > 0 ? 'vzrostla' : 'klesla'} o ${Math.abs(avgChange)} %.`,
          basis: `${money(nowAvg)} proti ${money(beforeAvg)}`
        });
      }
    }
  }

  // 2) Nejsilnější a nejslabší den v týdnu
  if (now.orders >= 15) {
    const byWeekday = new Map<number, { orders: number; days: number }>();
    for (const day of input.days) {
      const weekday = new Date(`${day.day}T12:00:00`).getDay();
      const found = byWeekday.get(weekday) ?? { orders: 0, days: 0 };
      found.orders += day.orders;
      found.days++;
      byWeekday.set(weekday, found);
    }
    const perDay = [...byWeekday.entries()]
      .map(([weekday, one]) => ({ weekday, avg: one.orders / Math.max(1, one.days) }))
      .sort((a, b) => b.avg - a.avg);
    const best = perDay[0];
    const worst = perDay[perDay.length - 1];
    if (best && worst && best.avg >= worst.avg * 1.5 && best.avg >= 1) {
      out.push({
        kind: 'info',
        text: `Nejvíc se objednává v ${DAY_NAMES[best.weekday]}, nejmíň v ${DAY_NAMES[worst.weekday]}.`,
        basis: `průměrně ${best.avg.toFixed(1)} proti ${worst.avg.toFixed(1)} objednávky na den`
      });
    }
  }

  // 3) Posun v platbách a dopravě — podíl, ne počet: při růstu roste všechno
  const shareShift = (title: string, list: DigestSlice[], pick: (row: Row) => string) => {
    if (now.orders < 10 || before.orders < 10) return;
    const beforeCount = new Map<string, number>();
    for (const row of input.prevRows) {
      const key = pick(row);
      if (key) beforeCount.set(key, (beforeCount.get(key) ?? 0) + 1);
    }
    let biggest: { key: string; from: number; to: number; diff: number } | null = null;
    for (const one of list) {
      const from = ((beforeCount.get(one.key) ?? 0) / before.orders) * 100;
      const to = (one.orders / now.orders) * 100;
      const diff = to - from;
      if (!biggest || Math.abs(diff) > Math.abs(biggest.diff)) {
        biggest = { key: one.key, from, to, diff };
      }
    }
    if (!biggest || Math.abs(biggest.diff) < 8) return;
    out.push({
      kind: 'watch',
      text: `${title}: ${biggest.key} ${biggest.diff > 0 ? 'roste' : 'ustupuje'}`
        + ` — ${Math.round(biggest.to)} % objednávek místo ${Math.round(biggest.from)} %.`,
      basis: `${Math.round(biggest.to)} % z ${now.orders} proti ${Math.round(biggest.from)} % z ${before.orders}`
    });
  };
  shareShift('Platba', input.payments, row => shortFor('payment', row.payment));
  shareShift('Doprava', input.shipments, row => shortFor('shipment', row.shipment));

  // 4) Zboží, které vyskočilo nebo spadlo
  for (const product of input.products.slice(0, 5)) {
    const was = input.prevProducts.get(product.code) ?? 0;
    if (product.qty < 3) continue;
    const change = pct(product.qty, was);
    if (was === 0 && product.qty >= 5) {
      out.push({
        kind: 'up',
        text: `${product.title} se předtím neprodával, teď je mezi nejprodávanějšími.`,
        basis: `${product.qty} ks za 30 dní, předtím 0`
      });
    } else if (change !== null && Math.abs(change) >= 50) {
      out.push({
        kind: change > 0 ? 'up' : 'down',
        text: `${product.title}: prodej ${change > 0 ? 'vzrostl' : 'klesl'} o ${Math.abs(change)} %.`,
        basis: `${product.qty} ks proti ${was} ks`
      });
    }
  }

  // 5) Nezaplacené, které leží — peníze, o kterých se neví
  const stale = input.windowRows.filter(row =>
    !row.paid && !isCancelled(row.status)
    && (row.created_at || '') < new Date(Date.now() - 3 * 86_400_000).toISOString());
  if (stale.length >= 3) {
    const sum = stale
      .filter(row => (row.currency || 'CZK').toUpperCase() === currency)
      .reduce((total, row) => total + Number(row.total || 0), 0);
    out.push({
      kind: 'watch',
      text: `${stale.length} objednávek čeká na zaplacení déle než tři dny.`,
      basis: `dohromady ${money(sum)}`
    });
  }

  // 6) Storna
  if (now.orders >= 10 && now.cancelled > 0) {
    const rate = Math.round((now.cancelled / now.orders) * 100);
    const beforeRate = before.orders >= 10 ? Math.round((before.cancelled / before.orders) * 100) : null;
    if (rate >= 8 || (beforeRate !== null && rate - beforeRate >= 5)) {
      out.push({
        kind: 'watch',
        text: `Storna jsou na ${rate} % objednávek${beforeRate !== null ? ` (předtím ${beforeRate} %)` : ''}.`,
        basis: `${now.cancelled} z ${now.orders}`
      });
    }
  }

  /*
   * 7) Vracející se zákazníci. U galanterie je opakovaný nákup to, co dělá
   * rozdíl mezi kampaní a obchodem, takže se hlásí i když je všechno v normě.
   * Počítá se z **nákupů**, ne z objednávek: dvě objednávky téhož člověka
   * do dvou dnů jsou jeden nákup, ne návrat.
   */
  if (input.purchases >= 10) {
    const share = Math.round((input.returning / input.purchases) * 100);
    out.push({
      kind: share >= 25 ? 'up' : 'watch',
      text: `Opakovaně nakupuje ${share} % zákazníků.`,
      basis: `${input.returning} z ${input.purchases} nákupů za 30 dní`
    });
  }

  /*
   * 7b) Rozdvojené objednávky. Když jich je hodně, něco v košíku drhne —
   * typicky neprojde platba a zákazník objedná znovu.
   */
  if (input.duplicates >= 3 && now.orders >= 10) {
    const share = Math.round((input.duplicates / now.orders) * 100);
    if (share >= 8) {
      out.push({
        kind: 'watch',
        text: `${input.duplicates} objednávek jsou druhé pokusy téhož zákazníka do dvou dnů (${share} %).`,
        basis: `${now.orders} objednávek se slilo na ${input.purchases} nákupů`
      });
    }
  }

  // 8) Zahraničí — kolik z objednávek jde mimo domácí trh
  const home = input.countries[0];
  if (home && now.orders >= 10) {
    const abroad = now.orders - home.orders;
    if (abroad > 0) {
      out.push({
        kind: 'info',
        text: `Mimo ${home.key} jde ${Math.round((abroad / now.orders) * 100)} % objednávek.`,
        basis: input.countries.slice(1, 4).map(one => `${one.key} ${one.orders}`).join(', ')
      });
    }
  }

  /*
   * 9) Velikost uvnitř kategorie. U kšand i pásků si lidé drží jednu délku,
   * ať je barva jakákoli — a podle toho se skládá sklad. Napříč kategoriemi
   * by to ale bylo sčítání délky kšand s šířkou kravaty, takže se hlásí
   * kategorie po kategorii.
   */
  if (now.orders >= 10) {
    for (const group of input.sizes.slice(0, 2)) {
      const size = group.sizes[0];
      if (!size || size.products < 2 || group.qty <= 0) continue;
      out.push({
        kind: 'info',
        text: `${group.category}: nejžádanější velikost je ${size.label}`
          + ` — ${Math.round((size.qty / group.qty) * 100)} % kusů.`,
        basis: `${size.qty} z ${group.qty} kusů, napříč ${size.products} produkty`
      });
    }
  }

  /*
   * 10) Zasazení do roku. Bez tohohle je „113 objednávek" číslo bez váhy:
   * v lednu je to hodně, v prosinci málo.
   */
  const rank = input.history.rank;
  if (rank && rank.of >= 6) {
    if (rank.better === rank.of) {
      out.push({
        kind: 'up',
        text: `Posledních 30 dní je nejsilnějších za celou dobu, co feed sahá.`,
        basis: `${now.orders} objednávek, víc než kterýkoli z ${rank.of} uzavřených měsíců`
      });
    } else if (rank.better <= Math.floor(rank.of * 0.25)) {
      out.push({
        kind: 'down',
        text: `Posledních 30 dní patří k nejslabším obdobím roku.`,
        basis: `slabších bylo jen ${rank.better} z ${rank.of} měsíců`
      });
    }
  }

  // 10b) Loňsko — jediné srovnání, které nemate sezónou
  const lastYear = input.history.lastYear;
  if (lastYear && lastYear.orders >= 5) {
    const change = pct(now.orders, lastYear.orders);
    if (change !== null && Math.abs(change) >= 10) {
      out.push({
        kind: change > 0 ? 'up' : 'down',
        text: `Proti stejným 30 dnům loni ${change > 0 ? 'víc' : 'míň'} o ${Math.abs(change)} %.`,
        basis: `${now.orders} proti ${lastYear.orders} loni`
      });
    }
  }

  /*
   * 10c) Sezóny — z vlastních dat, ne z kalendáře. Hlásí se i ta druhá
   * v pořadí: leden bývá silnější než prosinec a chystat se dá na obojí.
   */
  const seasons = input.history.seasons?.length
    ? input.history.seasons
    : (input.history.season ? [input.history.season] : []);
  for (const season of seasons.slice(0, 2)) {
    out.push({ kind: 'watch', text: season.text, basis: season.basis });
  }

  /*
   * 11) Sociální sítě. Je to korelace, ne důkaz — příspěvek se často pouští
   * právě tehdy, když je co nabídnout — a tak se to i píše.
   */
  const social = input.social;
  if (social && input.days.length >= 14) {
    if (social.posts === 0 && social.prevPosts > 0) {
      out.push({
        kind: 'watch',
        text: `Za posledních 30 dní nevyšel žádný příspěvek, předtím jich bylo ${social.prevPosts}.`,
        basis: `${social.prevPosts} příspěvků v předchozím období`
      });
    } else if (social.posts >= 3 && social.ordersWithout > 0) {
      const diff = pct(Math.round(social.ordersWithPost * 10), Math.round(social.ordersWithout * 10));
      if (diff !== null && Math.abs(diff) >= 20) {
        out.push({
          kind: diff > 0 ? 'up' : 'info',
          text: `Ve dnech s příspěvkem chodilo o ${Math.abs(diff)} % ${diff > 0 ? 'víc' : 'míň'}`
            + ` objednávek (souvislost, ne důkaz).`,
          basis: `${social.ordersWithPost} proti ${social.ordersWithout} objednávky na den,`
            + ` ${social.daysWithPost} dní s příspěvkem`
        });
      }
    }
    /*
     * Co si říká o rozpočet. Úspěch placeného příspěvku je koupený —
     * přidávat peníze má smysl tam, kde už něco zabralo samo.
     */
    for (const post of (social.candidates ?? []).slice(0, 2)) {
      out.push({
        kind: 'up',
        text: `Stálo by za propagaci: „${post.caption.slice(0, 60)}" —`
          + ` ${post.likes} lajků, ${post.comments} komentářů bez placeného dosahu.`,
        basis: post.why ?? ''
      });
    }
  }

  return out;
}

/**
 * Signály z návštěvnosti.
 *
 * Jsou zvlášť, protože GA4 přichází ze sítě a zbytek přehledu na něj nečeká.
 * Konverzní poměr je to hlavní, co objednávky samy o sobě neřeknou: když
 * klesne při stejné návštěvnosti, je problém v e-shopu, ne v propagaci.
 */
export function ga4Signals(snapshot: DigestGa4 | null): DigestSignal[] {
  if (!snapshot || snapshot.error) return [];
  const out: DigestSignal[] = [];
  const now = snapshot.window;
  const before = snapshot.prevWindow;

  if (now.sessions != null && before.sessions) {
    const change = pct(now.sessions, before.sessions);
    if (change !== null && Math.abs(change) >= 10) {
      out.push({
        kind: change > 0 ? 'up' : 'down',
        text: `Návštěvnost je o ${Math.abs(change)} % ${change > 0 ? 'vyšší' : 'nižší'} než v předchozích 30 dnech.`,
        basis: `${now.sessions} proti ${before.sessions} návštěvám`
      });
    }
  }

  if (snapshot.conversion != null && snapshot.prevConversion) {
    const diff = Math.round((snapshot.conversion - snapshot.prevConversion) * 10) / 10;
    if (Math.abs(diff) >= 0.3) {
      out.push({
        kind: diff > 0 ? 'up' : 'watch',
        text: `Konverzní poměr ${diff > 0 ? 'stoupl' : 'klesl'} na ${snapshot.conversion} %.`,
        basis: `předtím ${snapshot.prevConversion} %`
      });
    }
  }

  const top = snapshot.sources[0];
  if (top && now.sessions) {
    out.push({
      kind: 'info',
      text: `Nejvíc návštěv chodí z „${top.name}" — ${Math.round((top.sessions / now.sessions) * 100)} %.`,
      basis: snapshot.sources.slice(0, 3).map(one => `${one.name} ${one.sessions}`).join(', ')
    });
  }

  return out;
}

/* ---------- čísla ---------- */

/**
 * Všechno, co jde spočítat bez AI.
 *
 * Počítá se při každém otevření přehledu. Jsou to dotazy do místní
 * databáze — nic se nestahuje a na nic se nečeká, takže není důvod
 * ukazovat včerejší čísla.
 */
export function digestFacts(now = new Date(), windowDays = WINDOW): DigestFacts {
  /*
   * Okno se dá přepnout: třicet dní na denní chod, dva roky na to, jestli
   * má výrobek stálé místo v sortimentu. Delší okno se v grafu **shlukuje**
   * — sedm set sloupků vedle sebe je čára, ne graf — a srovnává se vždycky
   * se stejně dlouhým obdobím před ním.
   */
  const span = Math.max(7, Math.min(730, Math.round(windowDays) || WINDOW));
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  // Kolikátého je dnes — minulý měsíc se srovnává po stejný den, jinak by
  // třetího září vycházel propad proti celému srpnu
  const dayOfMonth = now.getDate();
  const prevMonthEnd = shiftDays(new Date(now.getFullYear(), now.getMonth() - 1, dayOfMonth), 1);

  /*
   * Hlavní okno jsou **klouzavé dny**, ne kalendářní měsíc. Prvního září má
   * měsíc jeden den a srovnává se s jedním dnem srpna — z toho vyjde cokoli
   * a jakýkoli závěr nad tím je náhoda. Třicet dní je stejně dlouhých pořád.
   */
  const windowStart = shiftDays(now, -(span - 1));
  const prevWindowStart = shiftDays(now, -(2 * span - 1));

  // Načte se to starší z obou začátků, ať mají obě srovnání z čeho brát
  const from = dayKey(prevWindowStart) < dayKey(prevMonthStart)
    ? dayKey(prevWindowStart) : dayKey(prevMonthStart);
  const rows = ordersFrom(from);
  const inRange = (row: Row, start: Date, end?: Date) => {
    const day = (row.created_at || '').slice(0, 10);
    if (!day) return false;
    if (day < dayKey(start)) return false;
    return end ? day < dayKey(end) : true;
  };

  const todayKey = dayKey(now);
  const yesterdayKey = dayKey(shiftDays(now, -1));
  const today = totalsOf(rows.filter(row => (row.created_at || '').slice(0, 10) === todayKey));
  const yesterday = totalsOf(rows.filter(row => (row.created_at || '').slice(0, 10) === yesterdayKey));
  const windowRows = rows.filter(row => inRange(row, windowStart));
  const windowTotals = totalsOf(windowRows);
  const prevWindow = totalsOf(rows.filter(row => inRange(row, prevWindowStart, windowStart)));
  const month = totalsOf(rows.filter(row => inRange(row, monthStart)));
  const prevMonth = totalsOf(rows.filter(row => inRange(row, prevMonthStart, prevMonthEnd)));

  /*
   * Převažující měna. Sčítat koruny s eury nejde, ale dlaždice i graf
   * potřebují jedno číslo — bere se ta, ve které je nejvíc peněz, a zbytek
   * se ukazuje vedle.
   */
  const currency = windowTotals.revenue[0]?.currency ?? today.revenue[0]?.currency ?? 'CZK';

  /*
   * Řada do grafu. U třiceti dnů den po dni — díra po víkendu je informace.
   * U delších oken se shlukuje: sedm set sloupků vedle sebe není graf, ale
   * čára, a týdenní i měsíční průběh se čte líp.
   */
  const bucketDays = span <= 62 ? 1 : span <= 200 ? 7 : 30;
  const days: DigestDay[] = [];
  for (let back = span - 1; back >= 0; back -= bucketDays) {
    const from = dayKey(shiftDays(now, -back));
    const to = dayKey(shiftDays(now, -Math.max(0, back - bucketDays + 1)));
    const bucket = rows.filter(row => {
      const day = (row.created_at || '').slice(0, 10);
      return day >= from && day <= to;
    });
    const totals = totalsOf(bucket);
    days.push({ day: from, orders: totals.orders, revenue: inCurrency(totals, currency) });
  }

  /*
   * Nejprodávanější zboží. Skládá se po kódech, protože týž produkt chodí ve
   * feedu s názvem v jazyce trhu.
   *
   * Dvě věci, na kterých to dřív ukazovalo nesmysly:
   *  - **Měna.** Do tržby se počítají jen objednávky v převažující měně;
   *    osm eur připsaných ke korunám dělalo z pásku zboží za 32 Kč.
   *  - **Cena za řádek vs. za kus.** Export nese obojí; bere se cena za
   *    řádek, a jen když chybí, dopočítá se z ceny za kus.
   */
  const catalog = catalogIndex();
  /*
   * Velikosti po kategoriích. Napříč e-shopem to nedávalo smysl — délka
   * kšand, šířka kravaty a obvod pasu jsou tři různé věci a sečíst je
   * dohromady je nesmysl. Uvnitř kategorie je to naopak otázka, podle které
   * se skládá sklad.
   */
  const sizes = new Map<string, Map<string, { qty: number; products: Set<string> }>>();
  const variantsOf = new Map<string, Map<string, number>>();

  /*
   * Ceny, za které se totéž zboží prodalo jinde. Feed u části položek cenu
   * nenese vůbec (dárek, sada, bonus k objednávce) a katalog nemusí mít
   * korunovou cenu u zboží, které jde jen na zahraniční trh. Bez tohohle
   * z toho v přehledu byla nula — a z nuly pak v postřezích tvrzení, že se
   * kapesníček prodává zadarmo.
   */
  const seenPrice = knownUnitPrices(rows);

  const products = new Map<string, DigestProduct>();
  /* Tržba zboží po měnách — koruny s eury se nesčítají, ale ani neztrácejí */
  const productMoney = new Map<string, Map<string, number>>();
  /* Kam se které zboží prodávalo — podklad pro „hlavně do Německa" */
  const productCountries = new Map<string, Map<string, number>>();
  for (const row of windowRows) {
    if (isCancelled(row.status)) continue;
    const rowCurrency = (row.currency || 'CZK').toUpperCase();
    const seen = new Set<string>();
    for (const item of itemsOf(row)) {
      const code = String(item.code || item.title || '').trim();
      if (!code) continue;
      // Varianta se přiřadí k produktu — jinak by 110 a 120 cm byly dvoje šle
      const known = catalog.get(code.toLowerCase());
      const base = known?.base ?? code;
      const one = products.get(base)
        ?? {
          code: base, title: known?.title || String(item.title || base),
          qty: 0, orders: 0, revenue: 0, revenueAll: [], estimated: false,
          priceSource: 'neznámá' as DigestProduct['priceSource'], variants: [],
          image: known?.image ?? null, countries: [], prevQty: 0, unit: 0, note: ''
        };
      const money = productMoney.get(base) ?? new Map<string, number>();
      const qty = Number(item.quantity) || 0;
      one.qty += qty;
      // Kam se to prodávalo. „Prodává se hlavně do Německa" je rada, „18 ks"
      // je jen číslo — a obojí stojí na týchž řádcích objednávek.
      const country = countryOf(row) || '—';
      const perCountry = productCountries.get(base) ?? new Map<string, number>();
      perCountry.set(country, (perCountry.get(country) ?? 0) + qty);
      productCountries.set(base, perCountry);

      /*
       * Cena po krocích, od nejjistější k nejslabší: co je v objednávce,
       * pak ceník, pak cena, za kterou se totéž prodalo jinde. Všechno
       * v měně té objednávky — eurová objednávka je eurová tržba, ne nula.
       * Odkud se cena vzala, se drží u produktu: „0 Kč" se nesmí tvářit
       * jako fakt.
       */
      const line = Number(item.total) || (Number(item.price) || 0) * qty;
      const fromCatalog = rowCurrency === currency ? (known?.price ?? 0) : 0;
      const perCurrency = seenPrice.get(rowCurrency);
      const fromOthers = perCurrency?.get(code.toLowerCase())
        ?? perCurrency?.get(base.toLowerCase()) ?? 0;
      const add = (amount: number, source: DigestProduct['priceSource']) => {
        money.set(rowCurrency, (money.get(rowCurrency) ?? 0) + amount);
        if (source === 'feed') one.priceSource = 'feed';
        else {
          one.estimated = true;
          if (one.priceSource !== 'feed') one.priceSource = source;
        }
      };
      if (line > 0) add(line, 'feed');
      else if (fromCatalog > 0) add(fromCatalog * qty, 'ceník');
      else if (fromOthers > 0) add(fromOthers * qty, 'jinde');

      if (!seen.has(base)) { one.orders++; seen.add(base); }
      products.set(base, one);
      productMoney.set(base, money);
      // Velikost sama o sobě: lidé si ji drží napříč barvami — ale jen
      // uvnitř jednoho druhu zboží
      const label = known?.label ?? '';
      if (label) {
        const category = known?.category || 'Ostatní';
        const perCategory = sizes.get(category) ?? new Map<string, { qty: number; products: Set<string> }>();
        const size = perCategory.get(label) ?? { qty: 0, products: new Set<string>() };
        size.qty += qty;
        size.products.add(base);
        perCategory.set(label, size);
        sizes.set(category, perCategory);

        const perProduct = variantsOf.get(base) ?? new Map<string, number>();
        perProduct.set(label, (perProduct.get(label) ?? 0) + qty);
        variantsOf.set(base, perProduct);
      }
    }
  }
  for (const [base, list] of variantsOf) {
    const one = products.get(base);
    if (!one) continue;
    one.variants = [...list.entries()]
      .map(([label, qty]) => ({ label, qty }))
      .sort((a, b) => b.qty - a.qty)
      .slice(0, 4);
  }
  /*
   * Tržba do tvaru, ve kterém se ukazuje. `revenue` je převažující měna
   * (v ní se řadí a kreslí), `revenueAll` je všechno — kapesníček prodaný
   * jen do zahraničí má „14 €", ne „0 Kč".
   */
  for (const [base, money] of productMoney) {
    const one = products.get(base);
    if (!one) continue;
    one.revenue = Math.round(money.get(currency) ?? 0);
    one.revenueAll = [...money.entries()]
      .map(([code, amount]) => ({ currency: code, amount: Math.round(amount) }))
      .filter(item => item.amount > 0)
      .sort((a, b) => (a.currency === currency ? -1 : b.currency === currency ? 1 : b.amount - a.amount));
    // Prodalo se to jen jinde: cena je známá, jen v jiné měně
    if (!one.revenue && one.revenueAll.length && one.priceSource === 'feed') {
      one.priceSource = 'jiná měna';
    }
  }

  // Totéž za předchozích třicet dní — jen kvůli srovnání, na obrazovku nejde
  const prevProducts = new Map<string, number>();
  for (const row of rows.filter(one => inRange(one, prevWindowStart, windowStart))) {
    if (isCancelled(row.status)) continue;
    for (const item of itemsOf(row)) {
      const code = String(item.code || item.title || '').trim();
      if (!code) continue;
      const base = catalog.get(code.toLowerCase())?.base ?? code;
      prevProducts.set(base, (prevProducts.get(base) ?? 0) + (Number(item.quantity) || 0));
    }
  }


  /*
   * Drobná statistika u každého zboží — a k ní věta, proč to tam je.
   *
   * Samotné „18 ks" se přečte za vteřinu a nic z něj nevyplyne. Kam se to
   * prodává, jestli to roste nebo padá a za kolik se to prodává jsou tři
   * čísla, která už rozhodují o objednávce do skladu i o tom, jaký trh má
   * smysl podpořit. **Všechno se počítá z týchž řádků objednávek**, žádný
   * odhad od AI — proto se to dá ověřit.
   */
  for (const one of products.values()) {
    const perCountry = productCountries.get(one.code);
    one.countries = perCountry
      ? [...perCountry.entries()]
        .map(([key, qty]) => ({ key, label: key, qty }))
        .sort((a, b) => b.qty - a.qty)
        .slice(0, 4)
      : [];
    one.prevQty = prevProducts.get(one.code) ?? 0;
    one.unit = one.qty > 0 && one.revenue > 0 ? Math.round(one.revenue / one.qty) : 0;

    const parts: string[] = [];
    const top = one.countries[0];
    if (top && one.qty > 0) {
      const share = Math.round((top.qty / one.qty) * 100);
      parts.push(share >= 80 && one.countries.length === 1
        ? `Prodává se jen do ${top.label} (${top.qty} z ${one.qty} ks)`
        : `Nejvíc jde do ${top.label} — ${share} % kusů`);
    }
    if (one.prevQty > 0) {
      const change = Math.round(((one.qty - one.prevQty) / one.prevQty) * 100);
      if (Math.abs(change) >= 20) {
        parts.push(`proti předchozímu období ${change > 0 ? '+' : ''}${change} % (bylo ${one.prevQty} ks)`);
      } else parts.push(`drží se na svém (předtím ${one.prevQty} ks)`);
    } else if (one.qty > 0) {
      parts.push('v předchozím období se neprodalo ani kus — je to novinka, nebo se to rozjelo teď');
    }
    if (one.unit > 0) parts.push(`průměrně ${one.unit} ${currency} za kus`);
    one.note = parts.join('; ') + (parts.length ? '.' : '');
  }
  /*
   * Vracející se zákazníci. Počítá se proti celé historii ve feedu, ne jen
   * proti načtenému oknu — jinak by každý zákazník vypadal jako nový.
   *
   * Dvě podmínky navíc, obě zaplacené nesmyslem v provozu:
   *  - **starší nákup musí být starší než dva dny.** Když zákazníkovi
   *    neprojde platba a objedná znovu, není to návrat, je to tentýž nákup,
   *  - **storna se nepočítají.** Vrácená objednávka není nákup, ke kterému
   *    by se dalo vracet.
   */
  let returning = 0;
  try {
    returning = Number((getDb().prepare(
      `SELECT COUNT(*) AS n FROM shop_orders o
        WHERE o.created_at >= ? AND o.email != ''
          AND lower(o.status) NOT LIKE '%storn%' AND lower(o.status) NOT LIKE '%zrušen%'
          AND EXISTS (SELECT 1 FROM shop_orders p
                       WHERE p.email = o.email
                         AND p.created_at < datetime(o.created_at, '-${SAME_PURCHASE_HOURS} hours')
                         AND lower(p.status) NOT LIKE '%storn%' AND lower(p.status) NOT LIKE '%zrušen%')`
    ).get(dayKey(windowStart)) as any)?.n ?? 0);
  } catch { /* starší databáze bez sloupce e-mailu */ }

  const { purchases, duplicates } = purchasesOf(windowRows);

  let known = 0;
  let feedAt: string | null = null;
  try {
    const row = getDb().prepare(
      'SELECT COUNT(*) AS n, MAX(seen_at) AS at FROM shop_orders'
    ).get() as any;
    known = Number(row?.n ?? 0);
    feedAt = row?.at || null;
  } catch { /* tabulka nemusí být */ }

  const windowRevenue = inCurrency(windowTotals, currency);
  const paidOrders = windowTotals.orders - windowTotals.cancelled;

  const countries = sliceRows(windowRows, countryOf, key => key);
  // Dopravci a platby se ukazují ve zkratkách ze slovníku — pobočky by
  // jinak daly stovku řádků, jednu na výdejnu
  const shipments = withSplit(
    sliceRows(windowRows, row => shortFor('shipment', row.shipment), key => key),
    windowRows,
    row => shortFor('shipment', row.shipment),
    row => shortFor('payment', row.payment)
  );
  const payments = withSplit(
    sliceRows(windowRows, row => shortFor('payment', row.payment), key => key),
    windowRows,
    row => shortFor('payment', row.payment),
    row => shortFor('shipment', row.shipment)
  );
  const prevRows = rows.filter(one => inRange(one, prevWindowStart, windowStart));
  /*
   * Nejprodávanější. Posílá se jich padesát a rozhraní si vybere, kolik jich
   * ukáže — u dvouletého okna je „osm nejprodávanějších" k ničemu, kdežto
   * druhý dotaz do hlavního procesu jen kvůli delšímu seznamu je zbytečný.
   */
  const topProducts = [...products.values()]
    .map(one => ({ ...one, revenue: Math.round(one.revenue) }))
    .sort((a, b) => b.qty - a.qty)
    .slice(0, 50);

  /*
   * Stavy objednávek. Není to jen ozdoba: „čeká na platbu" u třetiny
   * objednávek je jiná zpráva než „vyřízeno" u třetiny, a z pouhého počtu
   * objednávek se to nepozná.
   */
  const statuses = sliceRows(windowRows, row => (row.status || '').trim(), key => key);
  /*
   * Velikosti po kategoriích. Kategorie s jedinou velikostí se nevypisuje —
   * „100 % kusů je jedna velikost" není zjištění, jen šum.
   */
  const sizeGroups = [...sizes.entries()]
    .map(([category, list]) => ({
      category,
      qty: [...list.values()].reduce((sum, one) => sum + one.qty, 0),
      sizes: [...list.entries()]
        .map(([label, one]) => ({ label, qty: one.qty, products: one.products.size }))
        .sort((a, b) => b.qty - a.qty)
        .slice(0, 8)
    }))
    .filter(one => one.sizes.length > 1)
    .sort((a, b) => b.qty - a.qty)
    .slice(0, 4);

  const history = historyView(windowTotals.orders, currency, now);
  const social = socialView(days, span);

  return {
    currency,
    today, yesterday,
    window: windowTotals, prevWindow,
    month, prevMonth,
    monthLabel: new Intl.DateTimeFormat('cs-CZ', { month: 'long', year: 'numeric' }).format(now),
    monthDays: dayOfMonth,
    days,
    countries, shipments, payments,
    products: topProducts,
    returning,
    average: paidOrders > 0 ? Math.round(windowRevenue / paidOrders) : 0,
    signals: signalsOf({
      currency, days, window: windowTotals, prevWindow, returning, purchases,
      duplicates, windowRows, prevRows, payments, shipments, countries,
      products: topProducts, prevProducts, sizes: sizeGroups, history, social
    }),
    statuses,
    purchases,
    duplicates,
    sizes: sizeGroups,
    history,
    social,
    feedAt,
    known
  };
}

/* ---------- co čeká na vyřízení ---------- */

/** Slova, po kterých se věc nesmí odložit na zítra */
const URGENT = /reklamac|stížnost|stiznost|nedoruč|nedoruc|nedorazil|ztrat|poškoz|poskoz|storn|vrácen|vracen|urgent|právn|pravn|advokát/i;

/**
 * Nevyřízená pošta a chaty.
 *
 * Rozhoduje **vlákno**, ne příznak: odpověď odeslaná z telefonu, z webmailu
 * nebo z jiného klienta příznak „zodpovězeno" nenastaví a přehled pak dokola
 * připomíná hotovou věc. Když ve vlákně po zprávě něco odešlo — nebo na ni
 * čeká odpověď ve frontě k odeslání — je vyřízeno.
 */
export function mailTasks(days = 7, limit = 12): DigestTask[] {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  let rows: any[] = [];
  try {
    rows = getDb().prepare(
      `SELECT m.id, m.from_name, m.from_addr, m.subject, m.snippet, m.summary, m.date, m.thread_key
         FROM messages m
        WHERE m.folder = 'INBOX' AND m.archived = 0 AND m.answered = 0 AND m.date >= ?
          AND (m.category IS NULL OR m.category != 'other')
          AND NOT EXISTS (
            SELECT 1 FROM messages r
             WHERE r.thread_key != '' AND r.thread_key = m.thread_key AND r.date > m.date
               AND (lower(r.folder) LIKE '%sent%' OR lower(r.folder) LIKE '%odeslan%'))
          AND NOT EXISTS (
            SELECT 1 FROM outbox o
             WHERE o.reply_to_db_id = m.id AND o.status != 'failed')
        ORDER BY m.date DESC LIMIT 60`
    ).all(since) as any[];
  } catch {
    return [];
  }

  /*
   * Z jednoho vlákna stačí poslední zpráva. Zákazník, který třikrát urguje,
   * je jedna věc k vyřízení, ne tři řádky.
   */
  const seenThread = new Set<string>();
  const out: DigestTask[] = [];
  for (const row of rows) {
    const key = String(row.thread_key || `id:${row.id}`);
    if (seenThread.has(key)) continue;
    seenThread.add(key);
    const text = `${row.subject ?? ''} ${row.summary ?? row.snippet ?? ''}`;
    out.push({
      kind: 'mail',
      id: String(row.id),
      who: String(row.from_name || row.from_addr || '').trim(),
      subject: String(row.subject ?? '').trim(),
      preview: String(row.summary || row.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 140),
      at: String(row.date ?? ''),
      urgent: URGENT.test(text),
      reason: 'nikdo neodpověděl'
    });
  }
  return out
    .sort((a, b) => (Number(b.urgent) - Number(a.urgent)) || (a.at < b.at ? 1 : -1))
    .slice(0, limit);
}

/**
 * Odeslaná objednávka.
 *
 * Stav je volný text z e-shopu, takže se hledají slova, ne hodnoty výčtu —
 * „Předána dopravci" i „Doručeno" znamenají, že u ní není co dělat.
 */
function isShipped(status: string): boolean {
  return /odesl|expedov|p[řr]ed[áa]n|na cest|doru[čc]en|vyzvednut|dokon[čc]en|uzav[řr]en|shipped|delivered|complete/i
    .test(status ?? '');
}

/**
 * Kolik práce leží.
 *
 * Ráno nejde o to, která objednávka je která — na to je balení. Jde o to,
 * jestli něco nezůstalo viset: kolik objednávek ještě nikam neodešlo, kolik
 * z nich čeká na zaplacení a jak dlouho leží ta nejstarší.
 */
export function pendingWork(tasks: DigestTask[]): Omit<DigestPending, 'mails' | 'urgentMails' | 'chats'> {
  // Dva měsíce zpět: co leží dýl, není rozdělaná práce, ale mrtvá objednávka
  const since = dayKey(shiftDays(new Date(), -60));
  let rows: Row[] = [];
  try {
    rows = ordersFrom(since);
  } catch {
    rows = [];
  }

  const open = rows.filter(row => !isCancelled(row.status) && !isShipped(row.status));
  const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const unpaidOld = open.filter(row => !row.paid && (row.created_at || '') < threeDaysAgo).length;

  let oldestDays: number | null = null;
  for (const row of open) {
    const day = (row.created_at || '').slice(0, 10);
    if (!day) continue;
    const days = Math.floor((Date.now() - new Date(`${day}T12:00:00`).getTime()) / 86_400_000);
    if (oldestDays === null || days > oldestDays) oldestDays = days;
  }

  return { unshipped: open.length, unpaidOld, oldestDays };
}

/** Otevřené konverzace, kde poslední slovo má zákazník */
async function chatTasks(): Promise<{ tasks: DigestTask[]; error: string | null }> {
  if (!chatConfigured()) return { tasks: [], error: null };
  try {
    const list = await listConversations(true);
    const tasks = list
      .filter(one => !one.answered)
      .slice(0, 8)
      .map(one => ({
        kind: 'chat' as const,
        id: one.id,
        who: (one.name || one.email || 'návštěvník chatu').trim(),
        subject: 'Chat na webu',
        preview: '',
        at: one.lastMessageAt,
        urgent: false,
        reason: one.unread > 0 ? 'čeká na odpověď' : 'poslední slovo má zákazník'
      }));
    return { tasks, error: null };
  } catch (e: any) {
    // Chat je za sítí; přehled kvůli němu nepadá, jen se řekne proč chybí
    return { tasks: [], error: String(e?.message ?? e) };
  }
}

/* ---------- postřehy od AI ---------- */

const INSIGHT_KEY = 'digestInsightAt';
const EVERY_MS = 24 * 3600 * 1000;

function ensureTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS digest_reports (
      at TEXT PRIMARY KEY,
      facts TEXT NOT NULL DEFAULT '{}',
      insight TEXT NOT NULL DEFAULT '{}'
    );
  `);
}

/** Uložené postřehy od nejnovějšího; víc než třicet se nedrží */
function storedInsights(limit = 6): { at: string; facts: any; insight: DigestInsight }[] {
  ensureTable();
  const rows = getDb().prepare(
    'SELECT at, facts, insight FROM digest_reports ORDER BY at DESC LIMIT ?'
  ).all(limit) as any[];
  const out: { at: string; facts: any; insight: DigestInsight }[] = [];
  for (const row of rows) {
    try {
      out.push({ at: row.at, facts: JSON.parse(row.facts || '{}'), insight: JSON.parse(row.insight || '{}') });
    } catch { /* poškozený zápis přeskočíme, ať přehled jede dál */ }
  }
  return out;
}

/** Čísla do zadání — krátce a v jednotkách, ať se v tom AI vyzná */
function factsForAi(facts: DigestFacts): string {
  const money = (totals: DigestTotals) =>
    totals.revenue.map(one => `${one.amount} ${one.currency}`).join(' + ') || '0';
  const slice = (list: DigestSlice[], count = 6) =>
    list.slice(0, count).map(one => `${one.label} ${one.orders}×`).join(', ') || '—';

  return [
    `Posledních 30 dní: ${facts.window.orders} objednávek za ${money(facts.window)}`
      + `, průměr ${facts.average} ${facts.currency}`
      + `, storno ${facts.window.cancelled}, nezaplacených ${facts.window.unpaid}`
      + `, opakovaný nákup ${facts.returning}`,
    `Předchozích 30 dní: ${facts.prevWindow.orders} objednávek za ${money(facts.prevWindow)}`
      + `, storno ${facts.prevWindow.cancelled}`,
    `Dnes: ${facts.today.orders} objednávek za ${money(facts.today)}`
      + `${facts.today.cancelled ? `, storno ${facts.today.cancelled}` : ''}`,
    `Včera: ${facts.yesterday.orders} objednávek za ${money(facts.yesterday)}`,
    /*
     * Kalendářní měsíc je tu jen jako údaj a rovnou se říká, kolik dní má.
     * Bez toho model druhého v měsíci srovnával dva dny s dvěma dny
     * a stavěl na tom závěry.
     */
    `${facts.monthLabel} (zatím ${facts.monthDays} ${facts.monthDays === 1 ? 'den' : 'dní'}):`
      + ` ${facts.month.orders} objednávek za ${money(facts.month)}`
      + ` — stejná část minulého měsíce ${facts.prevMonth.orders} za ${money(facts.prevMonth)}.`
      + ` Krátký měsíc není trend, závěry stav na 30denním okně.`,
    `Denní řada (30 dní, počet objednávek): `
      + facts.days.map(one => `${one.day.slice(5)}:${one.orders}`).join(' '),
    `Země (30 dní): ${slice(facts.countries)}`,
    `Doprava (30 dní): ${slice(facts.shipments)}`,
    `Platba (30 dní): ${slice(facts.payments)}`,
    /*
     * Cena se do zadání píše ve **všech** měnách, ve kterých se prodalo.
     * Nula je „nevíme", ne „zadarmo" — model z ní jinak udělal tvrzení, že
     * se kapesníček prodává za nula korun, přestože se prodával za 14 €.
     */
    `Nejprodávanější (30 dní, varianty sloučené pod produkt): `
      + (facts.products.map(one => `${one.title} (${one.code}) ${one.qty} ks`
        + ((one.revenueAll ?? []).length
          ? ` za ${(one.revenueAll ?? []).map(m => `${m.amount} ${m.currency}`).join(' + ')}`
          : ` [cenu neznáme: ${one.priceSource}; nula tu neznamená zadarmo]`)
        + (one.estimated && (one.revenueAll ?? []).length ? ` [odhad podle: ${one.priceSource}]` : '')
        + (one.variants.length ? ` [${one.variants.map(v => `${v.label} ${v.qty}`).join(', ')}]` : ''))
        .join('; ') || '—'),
    /*
     * Velikosti po kategoriích. Napříč e-shodem by se sčítala délka kšand
     * s šířkou kravaty — a model by z toho psal nesmysly o „nejžádanější
     * velikosti".
     */
    `Velikosti (uvnitř kategorie): `
      + (facts.sizes.map(group => `${group.category}: `
        + group.sizes.map(one => `${one.label} ${one.qty} ks u ${one.products} produktů`).join(', '))
        .join(' | ') || '—'),
    `Stavy objednávek: ${slice(facts.statuses)}`,
    `Nákupy (objednávky téhož zákazníka do 48 h sloučené): ${facts.purchases}`
      + `, z toho druhé pokusy nebo dokupy: ${facts.duplicates}`,
    historyForAi(facts.history),
    socialForAi(facts.social)
  ].filter(Boolean).join('\n');
}

/** Dlouhodobý kontext — bez něj je „113 objednávek" číslo bez váhy */
function historyForAi(history: DigestHistory): string {
  const parts: string[] = [];
  if (history.lastYear) {
    parts.push(`stejných 30 dní loni: ${history.lastYear.orders} objednávek za ${history.lastYear.revenue}`);
  }
  if (history.rank) {
    parts.push(`slabších než současné okno bylo ${history.rank.better} z ${history.rank.of} uzavřených měsíců`);
  }
  const months = history.months.slice(-25)
    .map(one => `${one.month}:${one.orders}`)
    .join(' ');
  if (months) parts.push(`měsíce (počet objednávek): ${months}`);
  /*
   * Sezóny na půl roku dopředu — všechny, ne jen ta nejbližší. Leden bývá
   * silnější než prosinec a rada „chystej se na leden" bez zmínky o Vánocích
   * je půlka pravdy. I „žádná sezóna" je zjištění: bez něj si ji AI domyslí.
   */
  const seasons = history.seasons?.length
    ? history.seasons
    : (history.season ? [history.season] : []);
  if (seasons.length) {
    parts.push(`sezóny (nejbližší první): ${seasons.map(one =>
      `${one.text} (${one.basis})`).join(' | ')}`);
  } else if (history.seasonNote) parts.push(`sezóna: ${history.seasonNote}`);
  if (!parts.length) return '';
  return `Dlouhodobě (feed pokrývá ${history.coverage} měsíců): ${parts.join('; ')}`;
}

/**
 * Sociální sítě do zadání.
 *
 * Rovnou se říká, že je to souvislost, ne důkaz — jinak z toho model udělá
 * „příspěvky zvýšily prodej o 30 %", což z těchhle dat nikdo neví.
 */
function socialForAi(social: DigestSocial | null): string {
  if (!social) return '';
  if (!social.posts && !social.prevPosts) return 'Sociální sítě: za posledních 60 dní nevyšel žádný příspěvek.';
  const best = social.best
    ? `; nejúspěšnější „${social.best.caption.slice(0, 60)}" (${social.best.likes} lajků, ${social.best.comments} komentářů)`
    : '';
  const list = (posts: DigestPost[] | undefined, label: string) =>
    posts?.length
      ? ` ${label}: ${posts.map(one => `„${one.caption.slice(0, 50)}" (${one.likes}/${one.comments}`
        + `${one.boosted === true ? ', propagovaný' : one.boosted === false ? ', bez propagace' : ''}`
        + `${one.lift != null ? `, kolem vydání ${one.lift > 0 ? '+' : ''}${one.lift} % objednávek` : ''})`)
        .join('; ')}.`
      : '';
  return `Sociální sítě (30 dní): ${social.posts} příspěvků`
    + ` (předchozích 30 dní ${social.prevPosts}), ${social.likes} lajků, ${social.comments} komentářů`
    + `; ve dnech s příspěvkem průměrně ${social.ordersWithPost} objednávky, ve dnech bez ${social.ordersWithout}`
    + ` — je to souvislost, ne důkaz, příspěvky se pouští právě když je co nabídnout${best}.`
    + ` Zhlédnutí ani dosah aplikace nemá.`
    /*
     * Placené a neplacené zvlášť. Bez toho se koupený dosah čte jako úspěch
     * příspěvku a starší propagovaný kus přebije všechno ostatní.
     */
    + (social.boostKnown
      ? ''
      : ' U příspěvků nevíme, které byly propagované — Instagram to u tohohle napojení nehlásí,'
        + ' takže o placeném dosahu netvrď nic.')
    + list(social.bestEver, 'Nejlepší za poslední půlrok')
    + list(social.bestOlder, 'Starší úspěchy (jen na připomenutí, mohly mít placený dosah)')
    + list(social.candidates, 'Čerstvé neplacené, které si vedou nadprůměrně (kandidáti na rozpočet)');
}

/** Návštěvnost do zadání — jen když se povedla stáhnout */
function ga4ForAi(ga4: DigestGa4 | null): string {
  if (!ga4 || ga4.error) return '';
  const period = (one: DigestGa4['window']) =>
    `${one.sessions ?? '?'} návštěv, ${one.users ?? '?'} uživatelů, ${one.purchases ?? '?'} nákupů`;
  const sources = ga4.sources.map(one => `${one.name} ${one.sessions}`).join(', ');
  /*
   * Čí návštěvy to vlastně jsou. GA4 je napojené jen na jeden web, kdežto
   * objednávky chodí ze všech trhů — dělit jedno druhým dá nesmysl a model
   * to bez upozornění udělá.
   */
  const scope = ga4.scope
    ? ` Pozor: návštěvnost je jen z ${ga4.scope}, kdežto objednávky výš jsou ze všech trhů —`
      + ' konverzi přes ně nepočítej a u zboží, které jde hlavně do zahraničí, se o návštěvnost neopírej.'
    : '';
  return `Návštěvnost z GA4 (30 dní): ${period(ga4.window)}`
    + `; předchozích 30 dní: ${period(ga4.prevWindow)}`
    + (ga4.conversion != null ? `; konverzní poměr ${ga4.conversion} %` : '')
    + (ga4.prevConversion != null ? ` proti ${ga4.prevConversion} %` : '')
    + (sources ? `; zdroje: ${sources}` : '')
    + scope;
}

/**
 * Spočítané signály do zadání.
 *
 * Tohle je to hlavní, o co se má postřeh opírat: hotové srovnání, které
 * spočítal kód. Model tedy neodvozuje trend z řady čísel — to za něj někdo
 * udělal — a zbývá mu práce, ve které je dobrý: co z toho je důležité
 * a co s tím dělat.
 */
function signalsForAi(facts: DigestFacts): string {
  if (!facts.signals.length) return '(žádný, čísla se proti minulému období výrazně nezměnila)';
  return facts.signals.map(one => `- ${one.text} [${one.basis}]`).join('\n');
}

/** Co bylo minule — aby AI navazovala a neopakovala se */
function memoryForAi(history: { at: string; facts: any; insight: DigestInsight }[]): string {
  if (!history.length) return '';
  return history.map(one => {
    const when = one.at.slice(0, 10);
    const orders = one.facts?.window?.orders ?? one.facts?.month?.orders;
    const notes = (one.insight?.notes ?? []).map((note: DigestNote) => `- ${note.text}`).join('\n');
    // Vlastní poznámka „na co se podívat příště" je to hlavní, kvůli čemu se
    // paměť vede — bez ní by každý den začínal od nuly
    const focus = one.insight?.focus ? `\nChtěl jsi příště ověřit: ${one.insight.focus}` : '';
    return `[${when}${orders != null ? `, za 30 dní tehdy ${orders} objednávek` : ''}]\n`
      + `${one.insight?.headline ?? ''}\n${notes}${focus}`;
  }).join('\n\n');
}

const INSIGHT_SYSTEM = `Jsi obchodní analytik e-shopu Quentino (pásky, kšandy, kravaty a kožená galanterie; trhy CZ, SK a EU).
Dostaneš spočítané signály, čísla z feedu objednávek a svoje dřívější postřehy. Tvůj úkol NENÍ počítat — to je hotové. Tvůj úkol je vybrat, co z toho stojí za pozornost, říct proč a co s tím.

Jak přemýšlej:
1. Projdi signály a čísla a najdi ty, které mají skutečný dopad na tržbu, marži nebo práci navíc.
2. U každého se zeptej: opírá se to o dost velký vzorek? Nemá to jiné vysvětlení (víkend, svátek, jednorázová velká objednávka)? Když ano, napiš to místo závěru.
3. Teprve co projde, napiš jako bod.

Tvrdá pravidla:
- Ke každému bodu MUSÍŠ do "basis" napsat konkrétní čísla ze zadání, o která se opírá. Když je nemáš, ten bod nepiš.
- Nevymýšlej si čísla ani skutečnosti, které v zadání nejsou (náklady, marže, ceny dopravy, kampaně, konkurence). Když by závěr takový údaj potřeboval, napiš, co by bylo potřeba zjistit.
- Návrh (kind "napad") musí mít cíl a být proveditelný tenhle týden; do "check" napiš, podle čeho se za týden pozná, jestli zabral.
- Nikdy nepiš obecné rady typu „zaměřte se na marketing" nebo „zlepšete komunikaci se zákazníky".
- Radši dva podložené body než pět dojmů. Když data na nic nestačí (málo objednávek, krátké období), napiš jeden bod, že zatím není z čeho soudit.
- Když už jsi něco navrhoval dřív, navaž: co se potvrdilo, co ne.
- Česky, věcně, bez oslovení a bez marketingových frází. Každý bod jedna věta, nejvýš čtyři body. Celá odpověď do 1200 znaků.

Vrať POUZE JSON, nic dalšího, a hlídej, ať se celý vejde:
{"headline":"jedna až dvě věty souhrnu",
 "followUp":"navázání na minulý přehled nebo null",
 "notes":[{"kind":"trend|napad|pozor","text":"…","basis":"čísla, ze kterých to plyne","check":"u návrhu jak se pozná, že zabral, jinak null"}],
 "focus":"co si sám chceš ověřit v příštím přehledu, nebo null",
 "questions":["dvě až tři otázky, na které se podle tebe vyplatí doptat"]}`;

/** Text z JSONu i s uvozovkami uvnitř — `\"` a `\n` se musí vrátit zpátky */
function unescape(text: string): string {
  return text
    .replace(/\\n/g, ' ')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
    .trim();
}

/**
 * Záchrana z nedopsané odpovědi.
 *
 * Model občas narazí na strop tokenů a JSON zůstane rozseknutý uprostřed
 * věty. `JSON.parse` na tom skončí a v okně se pak objevil **celý surový
 * JSON i se závorkami** — přesně to, co uživatel viděl. Vytahat z toho
 * hotové kusy jde i tak: co je dopsané, se ukáže, zbytek se zahodí.
 */
function salvageInsight(raw: string): Partial<DigestInsight> {
  const first = (pattern: RegExp): string | null => {
    const found = raw.match(pattern);
    return found ? unescape(found[1]) || null : null;
  };
  const notes: DigestNote[] = [];
  for (const found of raw.matchAll(
    /"kind"\s*:\s*"(trend|napad|pozor)"\s*,\s*"text"\s*:\s*"((?:[^"\\]|\\.)*)"(?:\s*,\s*"basis"\s*:\s*"((?:[^"\\]|\\.)*)")?/g
  )) {
    const text = unescape(found[2]);
    if (text) notes.push({ kind: found[1] as DigestNote['kind'], text, basis: found[3] ? unescape(found[3]) : null, check: null });
  }
  return {
    headline: first(/"headline"\s*:\s*"((?:[^"\\]|\\.)*)"/) ?? undefined,
    notes,
    followUp: first(/"followUp"\s*:\s*"((?:[^"\\]|\\.)*)"/),
    focus: first(/"focus"\s*:\s*"((?:[^"\\]|\\.)*)"/)
  };
}

/** Odpověď modelu na strukturu; z nedopsané se zachrání, co jde */
export function parseInsight(raw: string, model: string): DigestInsight {
  const at = new Date().toISOString();
  const empty: DigestInsight = {
    at, headline: '', notes: [], followUp: null, focus: null, questions: [], model
  };

  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const one = JSON.parse(raw.slice(start, end + 1));
      const notes: DigestNote[] = Array.isArray(one.notes)
        ? one.notes
          .map((note: any) => ({
            kind: ['trend', 'napad', 'pozor'].includes(note?.kind) ? note.kind : 'trend',
            text: String(note?.text ?? '').trim(),
            basis: note?.basis ? String(note.basis).trim() : null,
            check: note?.check ? String(note.check).trim() : null
          }))
          .filter((note: DigestNote) => note.text)
          .slice(0, 6)
        : [];
      return {
        ...empty,
        headline: String(one.headline ?? '').trim(),
        notes,
        followUp: one.followUp ? String(one.followUp).trim() : null,
        focus: one.focus ? String(one.focus).trim() : null,
        questions: Array.isArray(one.questions)
          ? one.questions.map((q: any) => String(q ?? '').trim()).filter(Boolean).slice(0, 3)
          : []
      };
    } catch { /* nedopsaný JSON — zkusí se z něj vytahat, co je hotové */ }
  }

  if (raw.includes('"headline"') || raw.includes('"notes"')) {
    const saved = salvageInsight(raw);
    return { ...empty, ...saved, notes: saved.notes ?? [] };
  }

  /*
   * Model se úplně minul formátem a napsal prostý text. Řádky se vezmou tak,
   * jak jsou — ale nikdy se do okna nepustí něco, co začíná složenou
   * závorkou: surový JSON na obrazovce je horší než prázdno.
   */
  const lines = raw.split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('{') && !line.startsWith('}'));
  return {
    ...empty,
    headline: lines[0] ?? '',
    notes: lines.slice(1, 5).map(text => ({
      kind: 'trend' as const, text: text.replace(/^[-•*]\s*/, ''), basis: null, check: null
    }))
  };
}

/** Dopadl postřeh k něčemu, nebo se odpověď nevešla? */
function insightUsable(one: DigestInsight): boolean {
  return one.headline.length > 0 && !one.headline.startsWith('{') && one.notes.length > 0;
}


/**
 * Čísla, která se k přehledu uloží do archivu.
 *
 * Dřív se ukládala jen hrstka souhrnů a okno se staršímu přehledu pak
 * rozsypalo — chyběl mu včerejšek, graf i signály, a okno spadlo na prázdné
 * hodnotě. Teď se odkládá celý přehled; jen se seřízne to, co by archiv
 * nafouklo (dvě stě zápisů × padesát výrobků) a co nikdo zpětně nečte.
 */
function archiveFacts(facts: DigestFacts): any {
  return {
    ...facts,
    products: facts.products.slice(0, 20),
    history: facts.history
      ? { ...facts.history, months: (facts.history.months ?? []).slice(-24) }
      : facts.history,
    social: facts.social
      ? { ...facts.social, bestEver: (facts.social.bestEver ?? []).slice(0, 3) }
      : facts.social
  };
}

async function makeInsight(facts: DigestFacts, ga4: DigestGa4 | null = null): Promise<DigestInsight> {
  const s = getSettings();
  const history = storedInsights();
  const memory = memoryForAi(history);
  const traffic = ga4ForAi(ga4);
  const user = `# Spočítané signály (z nich vycházej)\n${signalsForAi(facts)}\n\n`
    + `# Čísla\n${factsForAi(facts)}\n\n`
    + `${traffic ? `# Návštěvnost\n${traffic}\n\n` : ''}`
    + `${memory ? `# Co jsi psal dřív (nejnovější nahoře)\n${memory}\n` : ''}`;

  /*
   * Strop je schválně vysoký a přesto se hlídá. Když se odpověď nevejde,
   * zůstane JSON rozseknutý uprostřed věty — a takový postřeh se nesmí
   * uložit jako postřeh dne, jinak by se celý den ukazoval zmetek. Zkusí
   * se proto ještě jednou a stručněji.
   */
  /*
   * Streamem a s dopsáním. Jednorázové volání skončí na stropu tokenů chybou
   * „odpověď se nevešla" — a to je u postřehu k ničemu, protože delší
   * a složitější rozbor je právě ten, který stojí za přečtení. `askLong`
   * naváže druhým voláním tam, kde model přestal, takže dlouhá odpověď
   * projde celá; `endMark` mu řekne, že má dokončit JSON.
   */
  // Rozbor dělá silnější model než psaní e-mailů — hledají se souvislosti
  const model = s.insightModel || s.draftModel;
  let answer = await askLong(model, INSIGHT_SYSTEM, user, { maxTokens: 4000, endMark: '}' });
  let insight = parseInsight(answer, model);
  if (!insightUsable(insight)) {
    // Nepovedlo se ani tak — model se minul formátem. Zkusí se jednou znovu
    // a stručněji, ať se do okna nedostane zmetek.
    answer = await askLong(
      model,
      `${INSIGHT_SYSTEM}\n\nMinulá odpověď se nedala přečíst. Piš stručněji: nejvýš tři body, každý do 160 znaků.`,
      user,
      { maxTokens: 4000, endMark: '}' }
    );
    const second = parseInsight(answer, model);
    if (insightUsable(second)) insight = second;
  }

  /*
   * Ani napodruhé se nedalo nic přečíst. Uložit takový postřeh by znamenalo
   * přepsat ten včerejší prázdnem a tvářit se, že je hotovo — po kliknutí
   * na „Přegenerovat" to pak jen bliklo a nic se nezměnilo. Radši chyba,
   * která se dá přečíst: starý postřeh zůstane a je vidět proč.
   */
  if (!insightUsable(insight)) {
    throw new Error(
      `Model ${model} vrátil odpověď, ze které se postřeh nedal přečíst`
      + `${answer ? ` (začínala „${answer.slice(0, 80).replace(/\s+/g, ' ')}…“)` : ' (prázdná odpověď)'}.`
    );
  }

  ensureTable();
  const d = getDb();
  d.prepare('INSERT OR REPLACE INTO digest_reports (at, facts, insight) VALUES (?,?,?)').run(
    insight.at,
    JSON.stringify(archiveFacts(facts)),
    JSON.stringify(insight)
  );
  /*
   * Kolik přehledů se drží. Denní přehled za půl roku je 180 zápisů; drží se
   * jich 200, aby se dalo listovat zpátky i po pár přegenerováních v jeden
   * den. Je to text a hrst čísel, takže místo to nezabere.
   */
  d.prepare(
    'DELETE FROM digest_reports WHERE at NOT IN (SELECT at FROM digest_reports ORDER BY at DESC LIMIT 200)'
  ).run();
  setSetting(INSIGHT_KEY, insight.at);

  /*
   * Ostatní zařízení ať to nepočítají znovu. Posel je jen zkratka — když
   * nedoletí, dojde to sdílenou složkou při nejbližší synchronizaci.
   */
  try { publishDigest(); } catch { /* posel není podmínka */ }
  return insight;
}

/* ---------- celý přehled ---------- */

/**
 * Přehled pro okno.
 *
 * Čísla a seznam k vyřízení se počítají vždy — jsou z místní databáze
 * a zastaralá by jen mátla. Postřehy od AI se dělají nejvýš jednou za
 * 24 hodin; `force` je tlačítko „Přegenerovat".
 */
export async function digestReport(force = false): Promise<DigestReport> {
  const facts = digestFacts();
  const tasks = mailTasks();
  const chat = await chatTasks();

  /*
   * Návštěvnost je jediná část, která jde ven ze zařízení, takže se ptá
   * nejvýš jednou za den a výpadek jen ubere kartu — přehled na ni nečeká
   * a nepadá kvůli ní.
   */
  let ga4: DigestGa4 | null = null;
  try {
    ga4 = await ga4Snapshot(force);
  } catch { /* GA4 je doplněk, ne podmínka */ }
  if (ga4 && !ga4.error) facts.signals = [...facts.signals, ...ga4Signals(ga4)];

  const history = storedInsights(1);
  const last = history[0]?.insight ?? null;
  const lastAt = last?.at ?? getSetting(INSIGHT_KEY, '') ?? '';
  const age = lastAt ? Date.now() - new Date(lastAt).getTime() : Number.POSITIVE_INFINITY;

  let insight = last;
  let insightError: string | null = null;
  if (force || age >= EVERY_MS) {
    try {
      insight = await makeInsight(facts, ga4);
    } catch (e: any) {
      insightError = String(e?.message ?? e);
      // Starý postřeh je pořád lepší než prázdné místo — jen se řekne,
      // že se nový nepovedl
    }
  }

  const nextInsightAt = insight?.at
    ? new Date(new Date(insight.at).getTime() + EVERY_MS).toISOString()
    : null;

  const all = [...tasks, ...chat.tasks].sort((a, b) =>
    (Number(b.urgent) - Number(a.urgent)) || (a.at < b.at ? 1 : -1));

  return {
    facts,
    ga4,
    pending: {
      ...pendingWork(all),
      mails: tasks.length,
      urgentMails: tasks.filter(one => one.urgent).length,
      chats: chat.tasks.length
    },
    tasks: all,
    insight,
    nextInsightAt,
    insightError,
    chatError: chat.error
  };
}

/* ---------- doptávání nad daty ---------- */

const ASK_SYSTEM = `Jsi obchodní analytik e-shopu Quentino. Odpovídáš majiteli na otázky nad čísly z feedu objednávek, která máš v zadání.

Pravidla:
- Piš česky, krátce (nejvýš pět vět nebo pár odrážek), věcně a konkrétně.
- Odpovídej JEN z předložených čísel a z pošty uvedené v zadání. Když na odpověď data nestačí, řekni to rovnou a napiš, co by k tomu bylo potřeba dotáhnout.
- Čísla neodhaduj a nezaokrouhluj jinak, než jak jsou.
- Když se hodí návrh, ať je proveditelný — cena, sada, zásoba, doprava, text.`;

/**
 * Otázka nad přehledem.
 *
 * Přehled je dobrý začátek, ale skutečná otázka přijde až po něm: „proč
 * spadl čtvrtek", „vyplatí se ta doprava zdarma". Odpovídá se nad **týmiž
 * čísly**, která jsou na obrazovce — nic se nedohledává jinde, takže se
 * odpověď dá porovnat s tím, co je vidět.
 *
 * `history` je dosavadní hovor, aby se dalo ptát „a co minulý měsíc?" bez
 * opakování celé otázky. Drží ho okno, ne server — přehled se zavře a hovor
 * skončí.
 */
export async function digestAsk(
  question: string, history: { role: 'user' | 'ai'; text: string }[] = []
): Promise<string> {
  const asked = (question ?? '').trim();
  if (!asked) return '';
  const s = getSettings();
  const facts = digestFacts();
  const tasks = mailTasks(7, 8);
  const memory = memoryForAi(storedInsights(3));
  // Návštěvnost se v odpovědi hodí, ale kvůli otázce se pro ni nechodí ven —
  // bere se poslední stažený snímek
  let traffic = '';
  try {
    const snapshot = await ga4Snapshot();
    traffic = ga4ForAi(snapshot);
  } catch { /* GA4 je doplněk */ }

  const talk = history.slice(-6)
    .map(one => `${one.role === 'user' ? 'Majitel' : 'Ty'}: ${one.text}`)
    .join('\n');

  return ask(
    s.insightModel || s.draftModel,
    ASK_SYSTEM,
    `# Spočítané signály\n${signalsForAi(facts)}\n\n`
    + `# Čísla\n${factsForAi(facts)}\n\n`
    + `${traffic ? `# Návštěvnost\n${traffic}\n\n` : ''}`
    + `# Čeká na vyřízení (${tasks.length})\n`
    + (tasks.map(one => `- ${one.who}: ${one.subject}`).join('\n') || '— nic')
    + (memory ? `\n\n# Tvoje dřívější postřehy\n${memory}` : '')
    + (talk ? `\n\n# Dosavadní hovor\n${talk}` : '')
    + `\n\n# Otázka\n${asked}`,
    900
  );
}

/* ---------- sdílení mezi zařízeními ---------- */

/** Rozešle poslední postřeh ostatním zařízením */
function publishDigest(): void {
  const share = digestShare();
  if (share) live.publish('digest', share);
}

/**
 * Postřehy pro ostatní zařízení.
 *
 * Postřeh stojí volání modelu a den co den vyjde stejný — počítat ho na
 * počítači, notebooku a dvou telefonech zvlášť je čtyřnásobná cena za totéž.
 * Kdo ho udělá první, pošle ho ostatním; ti si ho uloží a do 24 hodin už
 * nic nedělají.
 *
 * Posílá se i podklad, ze kterého vznikl — v paměti pak sedí čísla k textu
 * i na zařízení, které tehdy nic nepočítalo.
 */
export function digestShare(): { at: string; facts: any; insight: DigestInsight } | null {
  const last = storedInsights(1)[0];
  return last?.insight?.at ? last : null;
}

/**
 * Přijetí postřehu odjinud.
 *
 * Novější vyhrává. Vrací `true`, když se něco doopravdy uložilo, aby se
 * okno překreslilo jen tehdy, kdy je co ukázat.
 */
export function applyDigestShare(share: any): boolean {
  const at = String(share?.insight?.at ?? share?.at ?? '').trim();
  if (!at) return false;

  const mine = storedInsights(1)[0]?.at ?? '';
  if (mine && mine >= at) return false;

  try {
    ensureTable();
    getDb().prepare(
      'INSERT OR REPLACE INTO digest_reports (at, facts, insight) VALUES (?,?,?)'
    ).run(at, JSON.stringify(share?.facts ?? {}), JSON.stringify(share?.insight ?? {}));
    setSetting(INSIGHT_KEY, at);
    return true;
  } catch {
    return false;
  }
}

/* ---------- starší přehledy ---------- */

/**
 * Seznam uložených přehledů.
 *
 * Postřehy se ukládají den po dni, takže je z čeho listovat zpátky — a je
 * to jediná část přehledu, která se **nedá spočítat znovu**: čísla se ještě
 * dopočítají z feedu, ale text vznikl nad tím, co platilo tehdy.
 */
export function digestArchive(limit = 200): {
  at: string; headline: string; orders: number | null; revenue: number | null; currency: string;
}[] {
  ensureTable();
  const rows = getDb().prepare(
    'SELECT at, facts, insight FROM digest_reports ORDER BY at DESC LIMIT ?'
  ).all(Math.min(400, Math.max(1, limit))) as any[];

  const out: { at: string; headline: string; orders: number | null; revenue: number | null; currency: string }[] = [];
  for (const row of rows) {
    let facts: any = {};
    let insight: any = {};
    try { facts = JSON.parse(row.facts || '{}'); } catch { /* poškozený zápis přeskočíme */ }
    try { insight = JSON.parse(row.insight || '{}'); } catch { /* dtto */ }
    const window = facts?.window ?? facts?.month ?? null;
    out.push({
      at: String(row.at ?? ''),
      headline: String(insight?.headline ?? ''),
      orders: window?.orders ?? null,
      revenue: window?.revenue?.[0]?.amount ?? null,
      currency: String(facts?.currency ?? 'CZK')
    });
  }
  return out;
}

/** Jeden starší přehled i s čísly, ze kterých vznikl */
export function digestFromArchive(at: string): { at: string; facts: any; insight: DigestInsight } | null {
  ensureTable();
  const row = getDb().prepare(
    'SELECT at, facts, insight FROM digest_reports WHERE at = ?'
  ).get(String(at ?? '')) as any;
  if (!row) return null;
  try {
    return { at: row.at, facts: JSON.parse(row.facts || '{}'), insight: JSON.parse(row.insight || '{}') };
  } catch {
    return null;
  }
}
