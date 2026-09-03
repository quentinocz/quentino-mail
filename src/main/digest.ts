/**
 * Přehled dne.
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
import { ask } from './ai';
import { shortFor } from './shorthand';
import { listConversations } from './chat/supabase';
import { isConfigured as chatConfigured } from './chat/config';
import type {
  DigestDay, DigestFacts, DigestInsight, DigestNote, DigestProduct,
  DigestReport, DigestSignal, DigestSlice, DigestTask, DigestTotals
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

/* ---------- signály: závěry, které spočítá kód ---------- */

interface SignalInput {
  currency: string;
  days: DigestDay[];
  window: DigestTotals;
  prevWindow: DigestTotals;
  returning: number;
  windowRows: Row[];
  prevRows: Row[];
  payments: DigestSlice[];
  shipments: DigestSlice[];
  countries: DigestSlice[];
  products: DigestProduct[];
  prevProducts: Map<string, number>;
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
   */
  if (now.orders >= 10) {
    const share = Math.round((input.returning / now.orders) * 100);
    out.push({
      kind: share >= 25 ? 'up' : 'watch',
      text: `Opakovaně nakupuje ${share} % objednávek.`,
      basis: `${input.returning} z ${now.orders} za 30 dní`
    });
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
export function digestFacts(now = new Date()): DigestFacts {
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
  const windowStart = shiftDays(now, -(WINDOW - 1));
  const prevWindowStart = shiftDays(now, -(2 * WINDOW - 1));

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

  // Celé okno i s prázdnými dny — v grafu je díra po víkendu informace
  const days: DigestDay[] = [];
  for (let back = WINDOW - 1; back >= 0; back--) {
    const key = dayKey(shiftDays(now, -back));
    const dayRows = rows.filter(row => (row.created_at || '').slice(0, 10) === key);
    const totals = totalsOf(dayRows);
    days.push({ day: key, orders: totals.orders, revenue: inCurrency(totals, currency) });
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
  const products = new Map<string, DigestProduct>();
  for (const row of windowRows) {
    if (isCancelled(row.status)) continue;
    const sameCurrency = (row.currency || 'CZK').toUpperCase() === currency;
    const seen = new Set<string>();
    for (const item of itemsOf(row)) {
      const code = String(item.code || item.title || '').trim();
      if (!code) continue;
      const one = products.get(code)
        ?? { code, title: String(item.title || code), qty: 0, orders: 0, revenue: 0 };
      const qty = Number(item.quantity) || 0;
      one.qty += qty;
      if (sameCurrency) {
        const line = Number(item.total) || (Number(item.price) || 0) * qty;
        one.revenue += line;
      }
      if (!seen.has(code)) { one.orders++; seen.add(code); }
      products.set(code, one);
    }
  }

  // Totéž za předchozích třicet dní — jen kvůli srovnání, na obrazovku nejde
  const prevProducts = new Map<string, number>();
  for (const row of rows.filter(one => inRange(one, prevWindowStart, windowStart))) {
    if (isCancelled(row.status)) continue;
    for (const item of itemsOf(row)) {
      const code = String(item.code || item.title || '').trim();
      if (!code) continue;
      prevProducts.set(code, (prevProducts.get(code) ?? 0) + (Number(item.quantity) || 0));
    }
  }

  /*
   * Vracející se zákazníci. Počítá se proti celé historii ve feedu, ne jen
   * proti načtenému oknu — jinak by každý zákazník vypadal jako nový.
   */
  let returning = 0;
  try {
    returning = Number((getDb().prepare(
      `SELECT COUNT(*) AS n FROM shop_orders o
        WHERE o.created_at >= ? AND o.email != ''
          AND EXISTS (SELECT 1 FROM shop_orders p
                       WHERE p.email = o.email AND p.created_at < o.created_at)`
    ).get(dayKey(windowStart)) as any)?.n ?? 0);
  } catch { /* starší databáze bez sloupce e-mailu */ }

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
  const shipments = sliceRows(windowRows, row => shortFor('shipment', row.shipment), key => key);
  const payments = sliceRows(windowRows, row => shortFor('payment', row.payment), key => key);
  const prevRows = rows.filter(one => inRange(one, prevWindowStart, windowStart));
  const topProducts = [...products.values()]
    .map(one => ({ ...one, revenue: Math.round(one.revenue) }))
    .sort((a, b) => b.qty - a.qty)
    .slice(0, 8);

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
      currency, days, window: windowTotals, prevWindow, returning,
      windowRows, prevRows, payments, shipments, countries,
      products: topProducts, prevProducts
    }),
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
    `Nejprodávanější (30 dní): `
      + (facts.products.map(one => `${one.title} (${one.code}) ${one.qty} ks za ${one.revenue} ${facts.currency}`)
        .join('; ') || '—')
  ].join('\n');
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

async function makeInsight(facts: DigestFacts): Promise<DigestInsight> {
  const s = getSettings();
  const history = storedInsights();
  const memory = memoryForAi(history);
  const user = `# Spočítané signály (z nich vycházej)\n${signalsForAi(facts)}\n\n`
    + `# Čísla\n${factsForAi(facts)}\n\n`
    + `${memory ? `# Co jsi psal dřív (nejnovější nahoře)\n${memory}\n` : ''}`;

  /*
   * Strop je schválně vysoký a přesto se hlídá. Když se odpověď nevejde,
   * zůstane JSON rozseknutý uprostřed věty — a takový postřeh se nesmí
   * uložit jako postřeh dne, jinak by se celý den ukazoval zmetek. Zkusí
   * se proto ještě jednou a stručněji.
   */
  let answer = await ask(s.draftModel, INSIGHT_SYSTEM, user, 2400);
  let insight = parseInsight(answer, s.draftModel);
  if (!insightUsable(insight)) {
    answer = await ask(
      s.draftModel,
      `${INSIGHT_SYSTEM}\n\nMinulý pokus se nevešel do limitu. Piš výrazně stručněji: nejvýš dva body, každý do 140 znaků, "basis" do 60 znaků.`,
      user,
      2400
    );
    const second = parseInsight(answer, s.draftModel);
    if (insightUsable(second) || !insightUsable(insight)) insight = second;
  }

  ensureTable();
  const d = getDb();
  d.prepare('INSERT OR REPLACE INTO digest_reports (at, facts, insight) VALUES (?,?,?)').run(
    insight.at,
    JSON.stringify({
      today: facts.today, window: facts.window, prevWindow: facts.prevWindow, month: facts.month,
      currency: facts.currency, average: facts.average, returning: facts.returning,
      products: facts.products.slice(0, 5), countries: facts.countries.slice(0, 5)
    }),
    JSON.stringify(insight)
  );
  // Historie je paměť, ne archiv — třicet zápisů je půl roku ohlédnutí
  d.prepare(
    'DELETE FROM digest_reports WHERE at NOT IN (SELECT at FROM digest_reports ORDER BY at DESC LIMIT 30)'
  ).run();
  setSetting(INSIGHT_KEY, insight.at);
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

  const history = storedInsights(1);
  const last = history[0]?.insight ?? null;
  const lastAt = last?.at ?? getSetting(INSIGHT_KEY, '') ?? '';
  const age = lastAt ? Date.now() - new Date(lastAt).getTime() : Number.POSITIVE_INFINITY;

  let insight = last;
  let insightError: string | null = null;
  if (force || age >= EVERY_MS) {
    try {
      insight = await makeInsight(facts);
    } catch (e: any) {
      insightError = String(e?.message ?? e);
      // Starý postřeh je pořád lepší než prázdné místo — jen se řekne,
      // že se nový nepovedl
    }
  }

  const nextInsightAt = insight?.at
    ? new Date(new Date(insight.at).getTime() + EVERY_MS).toISOString()
    : null;

  return {
    facts,
    tasks: [...tasks, ...chat.tasks].sort((a, b) =>
      (Number(b.urgent) - Number(a.urgent)) || (a.at < b.at ? 1 : -1)),
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

  const talk = history.slice(-6)
    .map(one => `${one.role === 'user' ? 'Majitel' : 'Ty'}: ${one.text}`)
    .join('\n');

  return ask(
    s.draftModel,
    ASK_SYSTEM,
    `# Čísla\n${factsForAi(facts)}\n\n`
    + `# Čeká na vyřízení (${tasks.length})\n`
    + (tasks.map(one => `- ${one.who}: ${one.subject}`).join('\n') || '— nic')
    + (memory ? `\n\n# Tvoje dřívější postřehy\n${memory}` : '')
    + (talk ? `\n\n# Dosavadní hovor\n${talk}` : '')
    + `\n\n# Otázka\n${asked}`,
    900
  );
}
