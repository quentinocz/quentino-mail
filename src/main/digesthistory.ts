/**
 * Dlouhodobá čísla k přehledu.
 *
 * Třicet dní samo o sobě neřekne, jestli je to hodně nebo málo. „Sto třináct
 * objednávek" je dobrá zpráva v lednu a špatná v prosinci — a poznat se to dá
 * jedině proti tomu, co bylo dřív. Tenhle modul proto drží **měsíční souhrny
 * za celou historii ve feedu** a z nich počítá tři věci, které samotné okno
 * neumí:
 *
 *  1. **Zasazení do roku** — kolik z posledních dvanácti měsíců bylo slabších
 *     než těch posledních třicet dní.
 *  2. **Srovnání s loňskem** — stejné okno o rok zpátky. To je jediné
 *     srovnání, které nemate sezónou: prosinec proti prosinci, ne proti
 *     listopadu.
 *  3. **Sezóny** — které měsíce bývaly silné a kdy se na ně má začít chystat.
 *     Nic se nehádá dopředu podle kalendáře: index se počítá z **vlastních
 *     dat** e-shopu, takže Vánoce, svatby i letní útlum vyjdou samy, pokud
 *     v číslech doopravdy jsou.
 *
 * ## Proč se to ukládá
 *
 * Projít tisíce objednávek při každém otevření přehledu je zbytečné, když se
 * uzavřené měsíce už nezmění. Spočítané měsíce se proto drží v tabulce
 * `digest_months` a přepočítává se jen ten rozdělaný — a ten poslední, do
 * kterého ještě mohly dojít objednávky.
 */
import { getDb } from './db';

export interface MonthStat {
  /** `YYYY-MM` */
  month: string;
  orders: number;
  cancelled: number;
  /** V převažující měně měsíce — koruny se s eury nesčítají */
  revenue: number;
  currency: string;
  items: number;
  /** Kolik různých zákazníků (podle e-mailu) */
  customers: number;
  /** Uzavřený měsíc se už nepřepočítává */
  complete: boolean;
}

export interface SeasonHint {
  /** `YYYY-MM` měsíce, o kterém je řeč */
  month: string;
  label: string;
  /** Kolikrát silnější než průměrný měsíc (1,6 = o 60 % víc) */
  index: number;
  /** Do kdy se má začít, ať to má náběh */
  startBy: string;
  text: string;
  basis: string;
}

export interface HistoryView {
  months: MonthStat[];
  /** Kolik měsíců feed vůbec pokrývá — pod rok se sezóny nepočítají */
  coverage: number;
  /** Stejných třicet dní loni; `null`, když data tak daleko nesahají */
  lastYear: { orders: number; revenue: number } | null;
  /** Kolik z dvanácti měsíců bylo slabších než současné okno */
  rank: { better: number; of: number } | null;
  /** Nejbližší sezóna, na kterou se vyplatí chystat */
  season: SeasonHint | null;
}

const MONTHS = ['leden', 'únor', 'březen', 'duben', 'květen', 'červen',
  'červenec', 'srpen', 'září', 'říjen', 'listopad', 'prosinec'];

function ensureTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS digest_months (
      month TEXT PRIMARY KEY,
      orders INTEGER NOT NULL DEFAULT 0,
      cancelled INTEGER NOT NULL DEFAULT 0,
      revenue REAL NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT '',
      items INTEGER NOT NULL DEFAULT 0,
      customers INTEGER NOT NULL DEFAULT 0,
      complete INTEGER NOT NULL DEFAULT 0,
      computed_at TEXT NOT NULL DEFAULT ''
    );
  `);
}

function monthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function isCancelled(status: string): boolean {
  return /storn|zru[šs]en|vr[áa]cen|cancel|refund/i.test(status ?? '');
}

/**
 * Spočítá jeden měsíc z feedu.
 *
 * Storna se počítají zvlášť a do tržby nejdou — jinak by měsíc s jednou
 * velkou stornovanou objednávkou vypadal jako rekordní.
 */
function computeMonth(month: string): MonthStat {
  const rows = getDb().prepare(
    `SELECT status, currency, total, email, items_json FROM shop_orders
      WHERE substr(created_at, 1, 7) = ?`
  ).all(month) as any[];

  const money = new Map<string, number>();
  const customers = new Set<string>();
  let orders = 0;
  let cancelled = 0;
  let items = 0;

  for (const row of rows) {
    orders++;
    const email = String(row.email ?? '').trim().toLowerCase();
    if (email) customers.add(email);
    if (isCancelled(String(row.status ?? ''))) { cancelled++; continue; }
    const currency = String(row.currency || 'CZK').toUpperCase();
    money.set(currency, (money.get(currency) ?? 0) + Number(row.total || 0));
    try {
      for (const item of JSON.parse(row.items_json || '[]')) items += Number(item?.quantity) || 0;
    } catch { /* rozbitý řádek neshodí měsíc */ }
  }

  const best = [...money.entries()].sort((a, b) => b[1] - a[1])[0];
  return {
    month,
    orders,
    cancelled,
    revenue: Math.round(best?.[1] ?? 0),
    currency: best?.[0] ?? '',
    items,
    customers: customers.size,
    complete: month < monthKey(new Date())
  };
}

/**
 * Měsíční souhrny.
 *
 * Uzavřené měsíce se berou z tabulky, rozdělaný se počítá vždy znovu.
 * Zvlášť se přepočítá i **poslední uzavřený** — feed dobíhá a objednávka
 * z posledního dne měsíce může dorazit až prvního.
 */
export function monthlyStats(count = 13): MonthStat[] {
  ensureTable();
  const d = getDb();

  const first = (d.prepare(
    "SELECT MIN(substr(created_at, 1, 7)) AS m FROM shop_orders WHERE created_at != ''"
  ).get() as any)?.m as string | undefined;
  if (!first) return [];

  const now = new Date();
  const wanted: string[] = [];
  for (let back = count - 1; back >= 0; back--) {
    const when = new Date(now.getFullYear(), now.getMonth() - back, 1);
    const key = monthKey(when);
    if (key >= first) wanted.push(key);
  }

  const cached = new Map<string, MonthStat>();
  for (const row of d.prepare('SELECT * FROM digest_months').all() as any[]) {
    cached.set(row.month, {
      month: row.month, orders: row.orders, cancelled: row.cancelled,
      revenue: row.revenue, currency: row.currency, items: row.items,
      customers: row.customers, complete: !!row.complete
    });
  }

  const write = d.prepare(
    `INSERT INTO digest_months (month, orders, cancelled, revenue, currency, items, customers, complete, computed_at)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(month) DO UPDATE SET
       orders = excluded.orders, cancelled = excluded.cancelled, revenue = excluded.revenue,
       currency = excluded.currency, items = excluded.items, customers = excluded.customers,
       complete = excluded.complete, computed_at = excluded.computed_at`
  );

  const thisMonth = monthKey(now);
  const lastClosed = monthKey(new Date(now.getFullYear(), now.getMonth() - 1, 1));

  const out: MonthStat[] = [];
  for (const month of wanted) {
    const known = cached.get(month);
    const stale = !known || !known.complete || month === thisMonth || month === lastClosed;
    const stat = stale ? computeMonth(month) : known;
    if (stale) {
      write.run(stat.month, stat.orders, stat.cancelled, stat.revenue, stat.currency,
        stat.items, stat.customers, stat.complete ? 1 : 0, new Date().toISOString());
    }
    out.push(stat);
  }
  return out;
}

/** Objednávky a tržba v libovolném rozsahu dnů — na srovnání s loňskem */
function totalsBetween(fromDay: string, toDay: string, currency: string): { orders: number; revenue: number } {
  const rows = getDb().prepare(
    `SELECT status, currency, total FROM shop_orders
      WHERE substr(created_at, 1, 10) >= ? AND substr(created_at, 1, 10) <= ?`
  ).all(fromDay, toDay) as any[];

  let orders = 0;
  let revenue = 0;
  for (const row of rows) {
    orders++;
    if (isCancelled(String(row.status ?? ''))) continue;
    if (String(row.currency || 'CZK').toUpperCase() !== currency) continue;
    revenue += Number(row.total || 0);
  }
  return { orders, revenue: Math.round(revenue) };
}

function dayKey(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Sezóny z vlastních dat.
 *
 * Index měsíce je jeho průměrný denní počet objednávek dělený celoročním
 * průměrem. Prosinec s indexem 1,8 znamená, že se v něm prodávalo skoro
 * dvakrát tolik co obvykle. **Nic se nepředpokládá dopředu**: když e-shop
 * žádnou sezónu nemá, žádná se nenajde.
 *
 * Hlásí se nejbližší měsíc, který ještě nezačal a jehož index je aspoň
 * o čtvrtinu nad průměrem — a k němu datum, do kterého se má začít.
 * Tři týdny předem je odhad postavený na tom, že objednávky na dárky
 * začínají chodit dřív než v samotném měsíci.
 */
function seasonFrom(months: MonthStat[], now: Date): SeasonHint | null {
  // Pod rok dat se sezóna nedá odlišit od náhody
  const closed = months.filter(one => one.complete);
  if (closed.length < 12) return null;

  const perMonth = new Map<number, { orders: number; days: number }>();
  for (const one of closed) {
    const index = Number(one.month.slice(5, 7)) - 1;
    const [year, month] = one.month.split('-').map(Number);
    const days = new Date(year, month, 0).getDate();
    const found = perMonth.get(index) ?? { orders: 0, days: 0 };
    found.orders += one.orders;
    found.days += days;
    perMonth.set(index, found);
  }

  const daily = new Map<number, number>();
  let sum = 0;
  for (const [index, one] of perMonth) {
    const value = one.orders / Math.max(1, one.days);
    daily.set(index, value);
    sum += value;
  }
  const average = sum / Math.max(1, daily.size);
  if (average <= 0) return null;

  // Nejbližší měsíc, který teprve přijde (dívá se čtyři měsíce dopředu)
  for (let ahead = 0; ahead <= 3; ahead++) {
    const when = new Date(now.getFullYear(), now.getMonth() + ahead, 1);
    const index = when.getMonth();
    const value = daily.get(index);
    if (value == null) continue;
    const ratio = value / average;
    if (ratio < 1.25) continue;

    // Už běží? Pak se nemá co chystat, jen ať se ví, v čem se je
    const running = ahead === 0;
    const startBy = new Date(when.getTime() - 21 * 86_400_000);
    const label = `${MONTHS[index]}`;
    return {
      month: monthKey(when),
      label,
      index: Math.round(ratio * 100) / 100,
      startBy: dayKey(startBy),
      text: running
        ? `Běží ${label} — bývá o ${Math.round((ratio - 1) * 100)} % silnější než průměrný měsíc.`
        : `${label.charAt(0).toUpperCase()}${label.slice(1)} bývá o ${Math.round((ratio - 1) * 100)} %`
          + ` silnější než průměrný měsíc — chystat se má do ${startBy.getDate()}. ${startBy.getMonth() + 1}.`,
      basis: `průměrně ${value.toFixed(1)} objednávky na den proti celoročním ${average.toFixed(1)}`
        + `, z ${closed.length} měsíců historie`
    };
  }
  return null;
}

/**
 * Zasazení posledních třiceti dní do delší historie.
 *
 * `windowOrders` a `currency` přicházejí z přehledu, aby se totéž nepočítalo
 * dvakrát a aby srovnání sedělo na tutéž měnu.
 */
export function historyView(
  windowOrders: number, currency: string, now = new Date()
): HistoryView {
  const months = monthlyStats(13);

  // Stejné okno loni — jediné srovnání, které nemate sezónou
  const from = new Date(now.getTime() - 29 * 86_400_000);
  const lastYearFrom = new Date(from.getFullYear() - 1, from.getMonth(), from.getDate());
  const lastYearTo = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
  const oldest = (getDb().prepare(
    "SELECT MIN(substr(created_at, 1, 10)) AS d FROM shop_orders WHERE created_at != ''"
  ).get() as any)?.d as string | undefined;
  const lastYear = oldest && oldest <= dayKey(lastYearFrom)
    ? totalsBetween(dayKey(lastYearFrom), dayKey(lastYearTo), currency)
    : null;

  /*
   * Kolikátý je současný měsíc mezi dvanácti předchozími. Je to hrubé —
   * měsíce nejsou stejně dlouhé — ale odpovídá to na otázku, kterou si
   * člověk klade: „je tohle hodně, nebo málo?"
   */
  const closed = months.filter(one => one.complete).slice(-12);
  const rank = closed.length >= 3
    ? { better: closed.filter(one => one.orders < windowOrders).length, of: closed.length }
    : null;

  return {
    months,
    coverage: months.length,
    lastYear,
    rank,
    season: seasonFrom(months, now)
  };
}
