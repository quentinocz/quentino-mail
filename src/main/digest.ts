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
 */
import { getDb, getSetting, setSetting } from './db';
import { getSettings } from './settings';
import { ask } from './ai';
import { shortFor } from './shorthand';
import { listConversations } from './chat/supabase';
import { isConfigured as chatConfigured } from './chat/config';
import type {
  DigestDay, DigestFacts, DigestInsight, DigestMoney, DigestNote, DigestProduct,
  DigestReport, DigestSlice, DigestTask, DigestTotals
} from '../shared/types';

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

function itemsOf(row: Row): { title: string; code: string; quantity: number; price: number }[] {
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

  const rows = ordersFrom(dayKey(prevMonthStart));
  const inRange = (row: Row, from: Date, to?: Date) => {
    const day = (row.created_at || '').slice(0, 10);
    if (!day) return false;
    if (day < dayKey(from)) return false;
    return to ? day < dayKey(to) : true;
  };

  const todayKey = dayKey(now);
  const yesterdayKey = dayKey(shiftDays(now, -1));
  const today = totalsOf(rows.filter(row => (row.created_at || '').slice(0, 10) === todayKey));
  const yesterday = totalsOf(rows.filter(row => (row.created_at || '').slice(0, 10) === yesterdayKey));
  const monthRows = rows.filter(row => inRange(row, monthStart));
  const month = totalsOf(monthRows);
  const prevMonth = totalsOf(rows.filter(row => inRange(row, prevMonthStart, prevMonthEnd)));

  /*
   * Převažující měna. Sčítat koruny s eury nejde, ale dlaždice i graf
   * potřebují jedno číslo — bere se ta, ve které je nejvíc peněz, a zbytek
   * se ukazuje vedle.
   */
  const currency = month.revenue[0]?.currency ?? today.revenue[0]?.currency ?? 'CZK';

  // Posledních 30 dní i s prázdnými — v grafu je díra po víkendu informace
  const days: DigestDay[] = [];
  for (let back = 29; back >= 0; back--) {
    const key = dayKey(shiftDays(now, -back));
    const dayRows = rows.filter(row => (row.created_at || '').slice(0, 10) === key);
    const totals = totalsOf(dayRows);
    days.push({ day: key, orders: totals.orders, revenue: inCurrency(totals, currency) });
  }

  // Nejprodávanější zboží měsíce. Skládá se po kódech, protože týž produkt
  // chodí ve feedu s názvem v jazyce trhu
  const products = new Map<string, DigestProduct>();
  for (const row of monthRows) {
    if (isCancelled(row.status)) continue;
    const seen = new Set<string>();
    for (const item of itemsOf(row)) {
      const code = String(item.code || item.title || '').trim();
      if (!code) continue;
      const one = products.get(code)
        ?? { code, title: String(item.title || code), qty: 0, orders: 0, revenue: 0 };
      const qty = Number(item.quantity) || 0;
      one.qty += qty;
      one.revenue += (Number(item.price) || 0) * qty;
      if (!seen.has(code)) { one.orders++; seen.add(code); }
      products.set(code, one);
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
    ).get(dayKey(monthStart)) as any)?.n ?? 0);
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

  const monthRevenue = inCurrency(month, currency);
  const paidOrders = month.orders - month.cancelled;

  return {
    currency,
    today, yesterday, month, prevMonth,
    monthLabel: new Intl.DateTimeFormat('cs-CZ', { month: 'long', year: 'numeric' }).format(now),
    days,
    countries: sliceRows(monthRows, countryOf, key => key),
    // Dopravci a platby se ukazují ve zkratkách ze slovníku — pobočky by
    // jinak daly stovku řádků, jednu na výdejnu
    shipments: sliceRows(monthRows, row => shortFor('shipment', row.shipment), key => key),
    payments: sliceRows(monthRows, row => shortFor('payment', row.payment), key => key),
    products: [...products.values()]
      .map(one => ({ ...one, revenue: Math.round(one.revenue) }))
      .sort((a, b) => b.qty - a.qty)
      .slice(0, 8),
    returning,
    average: paidOrders > 0 ? Math.round(monthRevenue / paidOrders) : 0,
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
    `Dnes: ${facts.today.orders} objednávek za ${money(facts.today)}`
      + `${facts.today.cancelled ? `, storno ${facts.today.cancelled}` : ''}`
      + `${facts.today.unpaid ? `, nezaplacených ${facts.today.unpaid}` : ''}`,
    `Včera: ${facts.yesterday.orders} objednávek za ${money(facts.yesterday)}`,
    `${facts.monthLabel}: ${facts.month.orders} objednávek za ${money(facts.month)}`
      + `, průměr ${facts.average} ${facts.currency}, vracejících se zákazníků ${facts.returning}`,
    `Stejná část minulého měsíce: ${facts.prevMonth.orders} objednávek za ${money(facts.prevMonth)}`,
    `Denní řada (posledních 30 dní, počet objednávek): `
      + facts.days.map(one => `${one.day.slice(5)}:${one.orders}`).join(' '),
    `Země: ${slice(facts.countries)}`,
    `Doprava: ${slice(facts.shipments)}`,
    `Platba: ${slice(facts.payments)}`,
    `Nejprodávanější tento měsíc: `
      + (facts.products.map(one => `${one.title} (${one.code}) ${one.qty} ks za ${one.revenue} ${facts.currency}`)
        .join('; ') || '—')
  ].join('\n');
}

/** Co bylo minule — aby AI navazovala a neopakovala se */
function memoryForAi(history: { at: string; facts: any; insight: DigestInsight }[]): string {
  if (!history.length) return '';
  return history.map(one => {
    const when = one.at.slice(0, 10);
    const orders = one.facts?.month?.orders;
    const notes = (one.insight?.notes ?? []).map((note: DigestNote) => `- ${note.text}`).join('\n');
    // Vlastní poznámka „na co se podívat příště" je to hlavní, kvůli čemu se
    // paměť vede — bez ní by každý den začínal od nuly
    const focus = one.insight?.focus ? `\nChtěl jsi příště ověřit: ${one.insight.focus}` : '';
    return `[${when}${orders != null ? `, měsíc měl tehdy ${orders} objednávek` : ''}]\n`
      + `${one.insight?.headline ?? ''}\n${notes}${focus}`;
  }).join('\n\n');
}

const INSIGHT_SYSTEM = `Jsi obchodní analytik e-shopu Quentino (pásky, peněženky a kožená galanterie; trhy CZ, SK a EU).
Dostaneš čísla z feedu objednávek a svoje dřívější postřehy. Napiš krátký, konkrétní rozbor pro majitele.

Pravidla:
- Piš česky, věcně, bez marketingových frází a bez oslovení.
- Vycházej JEN z předložených čísel. Nic si nedomýšlej; když na něco data nestačí, napiš to.
- Čísla v textu musí sedět na zadání.
- Hledej trendy (růst/pokles, změny v dopravě, platbách, zemích, zboží), rizika (nezaplacené, storna, propad) a konkrétní návrhy (cena, sada, zásoba, doprava) — návrh musí být proveditelný tenhle týden.
- Když už jsi něco navrhoval dřív, navaž: co se potvrdilo, co ne.
- Nejvýš pět bodů, každý jedna věta.

Vrať POUZE JSON, nic dalšího:
{"headline":"jedna až dvě věty souhrnu",
 "followUp":"navázání na minulý přehled nebo null",
 "notes":[{"kind":"trend|napad|pozor","text":"…"}],
 "focus":"co si sám chceš ověřit v příštím přehledu, nebo null",
 "questions":["dvě až tři otázky, na které se podle tebe vyplatí doptat"]}`;

/** Odpověď modelu na strukturu; když se JSON nepovede, zachrání se aspoň text */
function parseInsight(raw: string, model: string): DigestInsight {
  const at = new Date().toISOString();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const one = JSON.parse(raw.slice(start, end + 1));
      const notes: DigestNote[] = Array.isArray(one.notes)
        ? one.notes
          .map((note: any) => ({
            kind: ['trend', 'napad', 'pozor'].includes(note?.kind) ? note.kind : 'trend',
            text: String(note?.text ?? '').trim()
          }))
          .filter((note: DigestNote) => note.text)
          .slice(0, 6)
        : [];
      return {
        at,
        headline: String(one.headline ?? '').trim(),
        notes,
        followUp: one.followUp ? String(one.followUp).trim() : null,
        focus: one.focus ? String(one.focus).trim() : null,
        questions: Array.isArray(one.questions)
          ? one.questions.map((q: any) => String(q ?? '').trim()).filter(Boolean).slice(0, 3)
          : [],
        model
      };
    } catch { /* spadne se do záchrany níž */ }
  }
  // Model se občas rozpovídá mimo JSON; věta navíc je pořád lepší než nic
  const lines = raw.split('\n').map(line => line.trim()).filter(Boolean);
  return {
    at,
    headline: lines[0] ?? '',
    notes: lines.slice(1, 6).map(text => ({ kind: 'trend' as const, text: text.replace(/^[-•*]\s*/, '') })),
    followUp: null,
    focus: null,
    questions: [],
    model
  };
}

async function makeInsight(facts: DigestFacts): Promise<DigestInsight> {
  const s = getSettings();
  const history = storedInsights();
  const memory = memoryForAi(history);
  const answer = await ask(
    s.draftModel,
    INSIGHT_SYSTEM,
    `# Čísla\n${factsForAi(facts)}\n\n${memory ? `# Co jsi psal dřív (nejnovější nahoře)\n${memory}\n` : ''}`,
    1200
  );
  const insight = parseInsight(answer, s.draftModel);

  ensureTable();
  const d = getDb();
  d.prepare('INSERT OR REPLACE INTO digest_reports (at, facts, insight) VALUES (?,?,?)').run(
    insight.at,
    JSON.stringify({
      today: facts.today, month: facts.month, prevMonth: facts.prevMonth,
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
