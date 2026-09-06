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
import { bestPosts, type SocialPost } from './digestsocial';

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
  /**
   * Jak se té sezóně říká.
   *
   * Index měsíce je z dat, jméno z kalendáře: listopad a prosinec jsou
   * Vánoce, květen až září svatby. Jméno nic nepočítá, jen říká, o čem
   * je řeč — pro e-shop s kravatami a kšandami jsou to dvě různé věci
   * s různým zbožím.
   */
  name: string;
  /** Kolikrát silnější než průměrný měsíc (1,6 = o 60 % víc) */
  index: number;
  /** Do kdy se má začít, ať to má náběh */
  startBy: string;
  /** Za kolik dní sezóna začíná (0 = už běží) */
  inDays: number;
  text: string;
  basis: string;
  /** Co se v ní historicky prodávalo nejvíc */
  products: { code: string; title: string; qty: number }[];
  /** Které příspěvky v tom období fungovaly — podklad pro chystanou kampaň */
  posts: SocialPost[];
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
  /**
   * Proč sezóna není.
   *
   * Prázdné místo je nejhorší odpověď: nedá se z něj poznat, jestli se
   * nepočítalo, nebo jestli fakt žádná sezóna nepřichází. Tohle se ukáže
   * vždycky, když `season` chybí.
   */
  seasonNote: string;
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
function seasonFrom(months: MonthStat[], now: Date): { season: SeasonHint | null; note: string } {
  /*
   * Kolik měsíců stačí. Dvanáct byl původní požadavek a v praxi znamenal,
   * že se sezóna neukázala nikdy — feed tak daleko nesahá. Půl roku stačí
   * na to, aby se dal porovnat nejbližší měsíc s ostatními; jistota je
   * menší, tak se u kratší historie chce výraznější rozdíl a v podkladu
   * je vidět, z kolika měsíců se počítalo.
   */
  const closed = months.filter(one => one.complete);
  if (closed.length < 6) {
    return {
      season: null,
      note: `Na sezónu zatím není dost historie — uzavřených měsíců je ${closed.length}, `
        + 'porovnávat se dá od šesti.'
    };
  }

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
  if (average <= 0) return { season: null, note: 'Ve feedu nejsou objednávky, ze kterých by šla sezóna poznat.' };
  // Kratší historie snese víc náhody, proto se u ní chce větší rozdíl
  const threshold = closed.length >= 12 ? 1.2 : 1.3;

  /*
   * Nejbližší měsíc, který teprve přijde. Půl roku dopředu: na Vánoce se
   * kampaň chystá v září a „za dva měsíce" je přesně ta zpráva, která se
   * hodí — se čtyřměsíčním výhledem se v létě neukázalo nic.
   */
  const upcoming: { index: number; ratio: number }[] = [];
  for (let ahead = 0; ahead <= 5; ahead++) {
    const when = new Date(now.getFullYear(), now.getMonth() + ahead, 1);
    const index = when.getMonth();
    const value = daily.get(index);
    if (value == null) continue;
    const ratio = value / average;
    upcoming.push({ index, ratio });
    if (ratio < threshold) continue;

    // Už běží? Pak se nemá co chystat, jen ať se ví, v čem se je
    const running = ahead === 0;
    const startBy = new Date(when.getTime() - 21 * 86_400_000);
    const label = `${MONTHS[index]}`;
    const name = seasonName(index);
    const inDays = Math.max(0, Math.round((when.getTime() - now.getTime()) / 86_400_000));
    const stronger = Math.round((ratio - 1) * 100);

    /*
     * Co se v té sezóně prodávalo a co se k ní hodilo napsat. Bez toho je
     * z upozornění jen „prosinec bývá silný" — s tím se nedá nic dělat.
     * Bere se **celá historie**, ne jen loňsko: dva prosince řeknou víc
     * než jeden.
     */
    const months = seasonMonths(index);
    const products = seasonProducts(months);
    const posts = bestPosts({ months, limit: 2 });

    const whenText = running
      ? `Běží ${name} (${label})`
      : inDays > 45
        ? `${name.charAt(0).toUpperCase()}${name.slice(1)} se blíží — začíná zhruba za ${Math.round(inDays / 30)} měsíce`
        : `${name.charAt(0).toUpperCase()}${name.slice(1)} se blíží — začíná zhruba za ${inDays} dní`;

    const hint: SeasonHint = {
      month: monthKey(when),
      label,
      name,
      index: Math.round(ratio * 100) / 100,
      startBy: dayKey(startBy),
      inDays: running ? 0 : inDays,
      text: `${whenText}; ${label} bývá o ${stronger} % silnější než průměrný měsíc`
        + (running ? '.' : ` — propagaci zahájit do ${startBy.getDate()}. ${startBy.getMonth() + 1}.`)
        + (products.length
          ? ` Nejvíc se v ní prodávalo: ${products.slice(0, 3).map(one => one.title).join(', ')}.`
          : ''),
      basis: `průměrně ${value.toFixed(1)} objednávky na den proti celoročním ${average.toFixed(1)}`
        + `, z ${closed.length} měsíců historie`,
      products,
      posts
    };
    return { season: hint, note: '' };
  }

  /*
   * Nic nevybočilo. I to je odpověď — jen se musí říct nahlas a s čísly,
   * ať je poznat, že se počítalo a nic se nenašlo.
   */
  const best = upcoming.sort((a, b) => b.ratio - a.ratio)[0];
  const nearest = upcoming.map(one => MONTHS[one.index]).slice(0, 3).join(', ');
  return {
    season: null,
    note: best
      ? `Nejbližší měsíce (${nearest}) z průměru nevybočují — nejsilnější z nich `
        + `${MONTHS[best.index]} je na ${Math.round(best.ratio * 100)} % celoročního průměru, `
        + `sezóna se hlásí od ${Math.round(threshold * 100)} %.`
      : 'Pro nejbližší měsíce zatím nejsou v historii žádná data k porovnání.'
  };
}

/**
 * Jméno sezóny.
 *
 * Sílu měsíce spočítala data, tohle je jen popiska — ale bez ní je rada
 * „chystej se na listopad" o polovinu míň užitečná než „chystej se na
 * Vánoce". Pro e-shop s kravatami a kšandami jsou svatby a Vánoce dvě různé
 * sezóny s jiným zbožím.
 */
function seasonName(monthIndex: number): string {
  if (monthIndex === 10 || monthIndex === 11) return 'vánoční sezóna';
  if (monthIndex >= 4 && monthIndex <= 8) return 'svatební sezóna';
  return `${MONTHS[monthIndex]}`;
}

/** Které měsíce k sezóně patří — Vánoce jsou listopad i prosinec */
function seasonMonths(monthIndex: number): number[] {
  if (monthIndex === 10 || monthIndex === 11) return [10, 11];
  if (monthIndex >= 4 && monthIndex <= 8) return [4, 5, 6, 7, 8];
  return [monthIndex];
}

/**
 * Co se v sezóně prodávalo.
 *
 * Napříč všemi roky, které feed pokrývá — jeden prosinec může být náhoda,
 * dva už ne. Stornované objednávky se nepočítají.
 */
function seasonProducts(months: number[], limit = 5): { code: string; title: string; qty: number }[] {
  let rows: any[] = [];
  try {
    rows = getDb().prepare(
      'SELECT status, created_at, items_json FROM shop_orders WHERE created_at != \'\''
    ).all() as any[];
  } catch {
    return [];
  }

  const wanted = new Set(months);
  const qty = new Map<string, number>();
  const titles = new Map<string, string>();
  for (const row of rows) {
    const month = Number(String(row.created_at ?? '').slice(5, 7)) - 1;
    if (!wanted.has(month)) continue;
    if (isCancelled(String(row.status ?? ''))) continue;
    let items: any[] = [];
    try { items = JSON.parse(row.items_json || '[]'); } catch { continue; }
    for (const item of items) {
      const code = String(item?.code || item?.title || '').trim();
      if (!code) continue;
      qty.set(code, (qty.get(code) ?? 0) + (Number(item?.quantity) || 0));
      if (!titles.has(code)) titles.set(code, String(item?.title || code));
    }
  }

  return [...qty.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([code, count]) => ({ code, title: titles.get(code) ?? code, qty: count }));
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
  /*
   * Dva roky. Třináct měsíců stačí na „stejné okno loni", ale na sezónu ne:
   * dva prosince řeknou víc než jeden a s třinácti měsíci nebylo z čeho brát.
   */
  const months = monthlyStats(25);

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

  const season = seasonFrom(months, now);
  return {
    months,
    coverage: months.length,
    lastYear,
    rank,
    season: season.season,
    seasonNote: season.note
  };
}
