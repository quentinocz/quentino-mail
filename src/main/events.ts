import crypto from 'crypto';
import { getDb } from './db';
import { ask } from './ai';
import { getSettings } from './settings';
import type { ShopEvent, ShopEventImpact, ShopEventKind, WebPlan } from '../shared/types';

/**
 * Události, které čísla vysvětlují.
 *
 * ## Proč se zapisují ručně
 *
 * Z feedu se pozná, že týden v srpnu byl slabý. Nepozná se z něj proč —
 * jestli byla dovolená, inventura, nebo prostě nikdo nekupoval. Tahle
 * jediná věta je přitom rozdíl mezi „nedělej nic" a „příště zavři obchod
 * o víkendu, ne ve všední dny". Modelu ani kódu ji nemá kdo dodat; ví ji
 * jen člověk, a to jen chvíli — za rok si nikdo nevzpomene, kdy přesně
 * běžela která sleva.
 *
 * ## Co se z nich počítá
 *
 * Ke každé události se spočítá, co se v jejích dnech dělo, a porovná se
 * to s běžným dnem **před** ní. Ne s průměrem celého roku: sezóna sama o
 * sobě zvedá čísla natolik, že by akce v prosinci vyšla skvěle i kdyby
 * nebyla. Základ jsou čtyři týdny před začátkem, a z nich se vyhazují dny
 * jiných událostí — jinak by dovolená hned po akci vyšla jako propadák
 * proti nafouknutému základu.
 *
 * Výsledkem je rozdíl v korunách za celé období. U dovolené je to odhad,
 * o kolik přišla, u akce, co přinesla — a přesně na tohle se za rok
 * člověk ptá.
 */

export const EVENT_KINDS: ShopEventKind[] = ['akce', 'dovolena', 'inventura', 'jine'];

/** Kolik dní před událostí se bere jako „běžný provoz". */
const BASE_DAYS = 28;

function ensureTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS shop_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL DEFAULT 'jine',
      title TEXT NOT NULL DEFAULT '',
      from_day TEXT NOT NULL,
      to_day TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_shop_events_from ON shop_events(from_day);
  `);
  /*
   * Odkud událost je. Sloupce přibyly později, proto `ALTER` v pokusu —
   * u databáze z minulé verze se doplní, u nové projde naprázdno.
   * `source_id` drží identifikátor toho, z čeho událost vznikla (plánovaná
   * změna textů na webu), aby se při úpravě zdroje nezaložila podruhé.
   */
  for (const sql of [
    "ALTER TABLE shop_events ADD COLUMN source TEXT NOT NULL DEFAULT 'rucne'",
    "ALTER TABLE shop_events ADD COLUMN source_id TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE shop_events ADD COLUMN source_hash TEXT NOT NULL DEFAULT ''",
    /*
     * Sloupce kvůli sdílení mezi zařízeními.
     *
     * `uid` je jméno události napříč zařízeními — číselné `id` je v každé
     * databázi jiné a podle něj se sloučit nedá. `updated_at` rozhoduje,
     * která verze platí, a `deleted` drží stopu po smazání: bez ní by se
     * smazaná událost při první synchronizaci vrátila z druhého zařízení,
     * kde o smazání nikdo neví.
     */
    "ALTER TABLE shop_events ADD COLUMN uid TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE shop_events ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''",
    'ALTER TABLE shop_events ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0'
  ]) {
    try { db.exec(sql); } catch { /* sloupec už je */ }
  }
  // Události zapsané před sdílením — bez uid by se neměly čím představit
  try {
    const stare = db.prepare("SELECT id FROM shop_events WHERE uid = ''").all() as any[];
    for (const row of stare) {
      db.prepare('UPDATE shop_events SET uid = ?, updated_at = COALESCE(NULLIF(updated_at, \'\'), created_at) WHERE id = ?')
        .run(crypto.randomUUID(), row.id);
    }
  } catch { /* prázdná tabulka */ }
}

function day(value: unknown): string {
  const text = String(value ?? '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : '';
}

function shift(dayText: string, by: number): string {
  const at = new Date(`${dayText}T12:00:00`);
  at.setDate(at.getDate() + by);
  return at.toISOString().slice(0, 10);
}

/** Kolik dní má období včetně obou krajů. */
function span(from: string, to: string): number {
  const a = new Date(`${from}T12:00:00`).getTime();
  const b = new Date(`${to}T12:00:00`).getTime();
  return Math.max(1, Math.round((b - a) / 86_400_000) + 1);
}

function rowToEvent(row: any): ShopEvent {
  return {
    id: Number(row.id),
    kind: (EVENT_KINDS as string[]).includes(row.kind) ? row.kind : 'jine',
    title: String(row.title ?? ''),
    from: String(row.from_day ?? ''),
    to: String(row.to_day ?? ''),
    note: String(row.note ?? ''),
    source: row.source === 'webtext' ? 'webtext' : 'rucne'
  };
}

export function listEvents(): ShopEvent[] {
  ensureTable();
  const rows = getDb().prepare(
    'SELECT * FROM shop_events WHERE deleted = 0 ORDER BY from_day DESC, id DESC'
  ).all() as any[];
  return rows.map(rowToEvent);
}

/**
 * Uložení. Otočené datum se narovná — kdo píše „od 20. do 15.", myslel
 * obojí naopak a chyba by jinak tiše nastavila prázdné období.
 */
export function saveEvent(patch: Partial<ShopEvent>): ShopEvent[] {
  ensureTable();
  const from = day(patch.from);
  const to = day(patch.to) || from;
  if (!from) throw new Error('Událost musí mít datum.');
  const title = String(patch.title ?? '').trim();
  if (!title) throw new Error('Událost musí mít název — za rok už nikdo nepozná, co to bylo.');
  const kind = (EVENT_KINDS as string[]).includes(String(patch.kind)) ? String(patch.kind) : 'jine';
  const note = String(patch.note ?? '').trim();
  const [start, end] = from <= to ? [from, to] : [to, from];

  const db = getDb();
  const now = new Date().toISOString();
  if (patch.id) {
    db.prepare(
      'UPDATE shop_events SET kind = ?, title = ?, from_day = ?, to_day = ?, note = ?, updated_at = ? WHERE id = ?'
    ).run(kind, title, start, end, note, now, patch.id);
  } else {
    db.prepare(
      `INSERT INTO shop_events (kind, title, from_day, to_day, note, created_at, uid, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(kind, title, start, end, note, now, crypto.randomUUID(), now);
  }
  shareEvents();
  return listEvents();
}

/**
 * Smazání je **značka**, ne výmaz.
 *
 * Kdyby se řádek opravdu zahodil, přišel by zpátky při první synchronizaci
 * z druhého zařízení — tam o smazání nikdo neví a událost by tam pořád
 * byla. Škrtnutá událost se proto drží dál, jen se nikde neukazuje.
 */
export function deleteEvent(id: number): ShopEvent[] {
  ensureTable();
  getDb().prepare('UPDATE shop_events SET deleted = 1, updated_at = ? WHERE id = ?')
    .run(new Date().toISOString(), id);
  shareEvents();
  return listEvents();
}

/* ---------- sdílení mezi zařízeními ---------- */

/** Řádek, jak putuje mezi zařízeními — bez místního `id`, to je v každé databázi jiné */
export interface EventShare {
  uid: string;
  kind: string;
  title: string;
  from: string;
  to: string;
  note: string;
  createdAt: string;
  updatedAt: string;
  deleted: boolean;
  source: string;
  sourceId: string;
  sourceHash: string;
}

/**
 * Všechny události k odeslání — **včetně smazaných**.
 *
 * Smazaná událost musí odjet taky, jinak by ji druhá strana poslala zpátky
 * jako novinku. Je jich pár desítek za celou historii, takže se posílá
 * prostě všechno a neřeší se, co už druhá strana zná.
 */
export function eventsExport(): EventShare[] {
  ensureTable();
  const rows = getDb().prepare('SELECT * FROM shop_events').all() as any[];
  return rows.map(row => ({
    uid: String(row.uid || ''),
    kind: String(row.kind || 'jine'),
    title: String(row.title || ''),
    from: String(row.from_day || ''),
    to: String(row.to_day || ''),
    note: String(row.note || ''),
    createdAt: String(row.created_at || ''),
    updatedAt: String(row.updated_at || row.created_at || ''),
    deleted: !!row.deleted,
    source: String(row.source || 'rucne'),
    sourceId: String(row.source_id || ''),
    sourceHash: String(row.source_hash || '')
  })).filter(one => one.uid);
}

/**
 * Sloučení toho, co přišlo odjinud. **Novější zápis vyhrává.**
 *
 * Slučovat po polích nemá smysl: událost je jedna věta a když ji někdo
 * opraví, platí jeho verze celá. Vrací `true`, když se něco doopravdy
 * změnilo — jen tehdy má smysl překreslovat okno.
 */
export function eventsImport(list: unknown): boolean {
  if (!Array.isArray(list)) return false;
  ensureTable();
  const db = getDb();
  const mine = new Map<string, { id: number; updated: string }>();
  for (const row of db.prepare('SELECT id, uid, updated_at, created_at FROM shop_events').all() as any[]) {
    if (row.uid) mine.set(String(row.uid), { id: row.id, updated: String(row.updated_at || row.created_at || '') });
  }

  let changed = false;
  for (const one of list as any[]) {
    const uid = String(one?.uid ?? '').trim();
    const from = day(one?.from);
    if (!uid || !from) continue;
    const updated = String(one?.updatedAt ?? one?.createdAt ?? '');
    const found = mine.get(uid);
    if (found && found.updated >= updated) continue;
    const kind = (EVENT_KINDS as string[]).includes(String(one?.kind)) ? String(one.kind) : 'jine';
    const to = day(one?.to) || from;
    const values = [kind, String(one?.title ?? ''), from, to, String(one?.note ?? ''),
      updated, one?.deleted ? 1 : 0, String(one?.source ?? 'rucne'),
      String(one?.sourceId ?? ''), String(one?.sourceHash ?? '')];
    if (found) {
      db.prepare(
        `UPDATE shop_events SET kind = ?, title = ?, from_day = ?, to_day = ?, note = ?,
           updated_at = ?, deleted = ?, source = ?, source_id = ?, source_hash = ? WHERE id = ?`
      ).run(...values, found.id);
    } else {
      db.prepare(
        `INSERT INTO shop_events (kind, title, from_day, to_day, note, updated_at, deleted,
           source, source_id, source_hash, uid, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(...values, uid, String(one?.createdAt ?? updated));
    }
    changed = true;
  }
  return changed;
}

/**
 * Rozeslání ostatním zařízením.
 *
 * Posílá se po každém zápisu. Živé propojení je zkratka — když zrovna
 * nedrží, dojde to sdílenou složkou při příští synchronizaci, takže se
 * tady chyba nemusí řešit.
 */
function shareEvents(): void {
  try {
    // Načítá se až tady: události samy o živém propojení nic vědět nemusí
    const live = require('./live');
    live.publish('events', eventsExport());
  } catch { /* propojení není zapnuté, nevadí */ }
}

/* ---------- události z naplánovaných textů na webu ---------- */

/**
 * Co plánovaná změna textů doopravdy říká.
 *
 * Bere se z ní jen to, co se objeví na webu: lišta, texty u produktu,
 * tlačítko, odkazy. Nastavení „co schovat" se vypisuje slovy — model má
 * rozhodnout podle obsahu, a „hideShip: true" mu neřekne nic.
 */
function planSummary(plan: WebPlan): string {
  const parts: string[] = [];
  /*
   * Texty jsou trojjazyčné; do zadání jde česky. Slovenská a anglická verze
   * říkají totéž a model by z nich jen počítal znaky navíc.
   */
  const add = (label: string, value?: { cz?: string } | string | null) => {
    const text = (typeof value === 'string' ? value : value?.cz ?? '').trim();
    if (text) parts.push(`${label}: ${text}`);
  };
  if (plan.topbar?.on) add('horní lišta', plan.topbar.text);
  const p: any = plan.product ?? {};
  if (p.on) {
    add('nadpis u produktu', p.header);
    add('nad rámečkem', p.above);
    add('místo celého rámečku', p.one);
    add('expedice', p.ship);
    add('doručení', p.delivery);
    add('osobní odběr', p.pickup);
    add('pod rámečkem', p.below);
    if (p.hideHeader || p.hideShip || p.hideDelivery || p.hidePickup) {
      parts.push('schovává část rámečku s dopravou');
    }
  }
  if (plan.button?.on) add('tlačítko do košíku', plan.button.text);
  if (plan.links?.on) {
    const items = (plan.links.items ?? []).map((one: any) => one?.text?.cz).filter(Boolean);
    if (plan.links.mode === 'off') parts.push('schovává odkazy pod tlačítkem');
    else if (items.length) add('odkazy pod tlačítkem', items.join(' · '));
  }
  return parts.join('\n');
}

function hashOf(text: string): string {
  return crypto.createHash('md5').update(text).digest('hex').slice(0, 12);
}

const PLAN_SYSTEM = `Z naplánované změny textů na e-shopu urči, co to je za událost.

Vrať POUZE JSON: {"kind":"akce|dovolena|inventura|jine","title":"název do 40 znaků","note":"co se tou změnou zákazníkovi říká, jedna věta"}

- "akce" je sleva, doprava zdarma, dárek, výprodej — cokoli, co má prodat víc.
- "dovolena" je zavřeno, pozdější expedice, nepřítomnost.
- "inventura" je uzavření skladu kvůli počítání zboží.
- Když to není ani jedno (běžné upřesnění termínu doručení, provozní hláška), dej "jine".
- Název piš česky a konkrétně podle textu, ne obecně. Žádné uvozovky navíc.`;

/**
 * Událost z naplánované změny textů na webu.
 *
 * ## Proč to nedělá člověk
 *
 * Akce se na webu **ohlašuje** — doprava zdarma, sleva, „expedujeme až od
 * 5. 8.". Kdo to psal do plánovaných textů, už jednou zapsal co i odkdy
 * dokdy; zapisovat totéž ještě jednou do událostí je práce navíc, kterou
 * nikdo dělat nebude. Z plánu se proto událost založí sama a člověk ji
 * může přepsat.
 *
 * Model se ptá jen na to, co kód nepozná: jestli je to akce, dovolená,
 * nebo běžné upřesnění, a jak to pojmenovat. Když se nepovede (chybí klíč,
 * spadne síť), událost stejně vznikne — s názvem, který změně dal člověk.
 *
 * Text se hlídá otiskem: dokud se nezmění, model se znovu neptá. Bez toho
 * by každé uložení rozepsané změny stálo volání modelu.
 */
export async function eventFromPlan(plan: WebPlan): Promise<void> {
  ensureTable();
  const summary = planSummary(plan);
  const from = day(plan.from);
  const to = day(plan.to) || from;
  if (!from || !summary) return;

  const stamp = hashOf(`${from}|${to}|${summary}`);
  const db = getDb();
  const found = db.prepare(
    "SELECT * FROM shop_events WHERE source = 'webtext' AND source_id = ?"
  ).get(plan.id) as any;
  if (found && found.source_hash === stamp) return;

  let kind: string = 'jine';
  let title = String(plan.name ?? '').trim();
  let note = summary.split('\n')[0] ?? '';
  try {
    const s = getSettings();
    const raw = await ask(
      s.fastModel || s.draftModel,
      PLAN_SYSTEM,
      `Platí od ${from} do ${to}.\n\n${summary}`,
      300
    );
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
      const one = JSON.parse(raw.slice(start, end + 1));
      if ((EVENT_KINDS as string[]).includes(one?.kind)) kind = one.kind;
      if (String(one?.title ?? '').trim()) title = String(one.title).trim().slice(0, 60);
      if (String(one?.note ?? '').trim()) note = String(one.note).trim().slice(0, 200);
    }
  } catch {
    /*
     * Bez modelu se událost pořád vyplatí založit: datum a to, že se něco
     * dělo, jsou samy o sobě víc než nic — a název se dá přepsat.
     */
  }
  if (!title) title = 'Změna textů na webu';

  const now = new Date().toISOString();
  if (found) {
    db.prepare(
      `UPDATE shop_events SET kind = ?, title = ?, from_day = ?, to_day = ?, note = ?, source_hash = ?,
         updated_at = ?, deleted = 0 WHERE id = ?`
    ).run(kind, title, from, to, note, stamp, now, found.id);
  } else {
    db.prepare(
      `INSERT INTO shop_events (kind, title, from_day, to_day, note, created_at, source, source_id, source_hash, uid, updated_at)
       VALUES (?,?,?,?,?,?, 'webtext', ?, ?, ?, ?)`
    ).run(kind, title, from, to, note, now, plan.id, stamp, crypto.randomUUID(), now);
  }
  shareEvents();
}

/** Zrušená změna textů si odnese i svoji událost — jinak by zůstala viset. */
export function dropEventOfPlan(planId: string): void {
  ensureTable();
  // Taky jen škrtnutí — jinak by se událost vrátila z druhého zařízení
  getDb().prepare(
    "UPDATE shop_events SET deleted = 1, updated_at = ? WHERE source = 'webtext' AND source_id = ?"
  ).run(new Date().toISOString(), String(planId));
  shareEvents();
}

type OrderRow = { created_at: string; status: string; currency: string; total: number };

function ordersBetween(from: string, to: string): OrderRow[] {
  try {
    return getDb().prepare(
      `SELECT created_at, status, currency, total FROM shop_orders
        WHERE substr(created_at, 1, 10) >= ? AND substr(created_at, 1, 10) <= ?`
    ).all(from, to) as any[];
  } catch {
    return [];
  }
}

/** Stornované objednávky se nepočítají — tržba z nich nikdy nebyla. */
function sumOrders(rows: OrderRow[], currency: string, skip: Set<string>) {
  let orders = 0;
  let revenue = 0;
  for (const row of rows) {
    const at = (row.created_at || '').slice(0, 10);
    if (skip.has(at)) continue;
    if (/storn|cancel|zrus|zruš/i.test(row.status || '')) continue;
    orders++;
    if ((row.currency || 'CZK').toUpperCase() === currency) revenue += Number(row.total || 0);
  }
  return { orders, revenue };
}

function postsBetween(from: string, to: string) {
  try {
    const rows = getDb().prepare(
      `SELECT like_count, comment_count FROM ig_source_posts
        WHERE substr(posted_at, 1, 10) >= ? AND substr(posted_at, 1, 10) <= ?`
    ).all(from, to) as any[];
    return {
      posts: rows.length,
      likes: rows.reduce((sum, one) => sum + Number(one.like_count || 0), 0),
      comments: rows.reduce((sum, one) => sum + Number(one.comment_count || 0), 0)
    };
  } catch {
    return { posts: 0, likes: 0, comments: 0 };
  }
}

/**
 * Události i s tím, co se v nich dělo.
 *
 * `currency` je převažující měna přehledu — porovnávat koruny s eury nemá
 * smysl, takže se počítá jen ta jedna a ostatní se do rozdílu nepletou.
 */
export function eventsWithImpact(currency = 'CZK', today = new Date().toISOString().slice(0, 10)): ShopEventImpact[] {
  const all = listEvents();
  // Dny, které patří nějaké události — základ se z nich nesmí počítat
  const busy = new Set<string>();
  for (const one of all) {
    for (let at = one.from; at <= one.to; at = shift(at, 1)) busy.add(at);
  }

  return all.map(one => {
    const days = span(one.from, one.to);
    const future = one.from > today;
    const inside = sumOrders(ordersBetween(one.from, one.to), currency, new Set());

    const baseFrom = shift(one.from, -BASE_DAYS);
    const baseTo = shift(one.from, -1);
    const baseRows = ordersBetween(baseFrom, baseTo);
    const skip = new Set([...busy].filter(at => at >= baseFrom && at <= baseTo));
    const baseDays = Math.max(1, BASE_DAYS - skip.size);
    const base = sumOrders(baseRows, currency, skip);

    const perDay = inside.orders / days;
    const basePerDay = base.orders / baseDays;
    const baseMoneyPerDay = base.revenue / baseDays;
    // Bez čeho srovnávat se nic netvrdí — prázdný základ by udělal z každé
    // události zázrak (dělení skoro nulou)
    const known = !future && base.orders >= 5;

    return {
      ...one,
      days,
      future,
      orders: inside.orders,
      revenue: Math.round(inside.revenue),
      currency,
      perDay: Math.round(perDay * 10) / 10,
      basePerDay: known ? Math.round(basePerDay * 10) / 10 : null,
      deltaPct: known && basePerDay > 0
        ? Math.round(((perDay - basePerDay) / basePerDay) * 100)
        : null,
      /*
       * Rozdíl v penězích za celé období. U dovolené vyjde záporný (tolik
       * se neprodalo), u akce kladný — a je to odhad, ne účetnictví:
       * počítá se proti běžnému dni před událostí.
       */
      moneyDiff: known ? Math.round(inside.revenue - baseMoneyPerDay * days) : null,
      ...postsBetween(one.from, one.to)
    };
  });
}

/**
 * Události do zadání pro model.
 *
 * Bere se posledních pár let, ne jen letošek: otázka „co loni fungovalo"
 * má smysl jen tehdy, když si model může přečíst, co se loni dělo. Řádek
 * je schválně jedna věta s čísly — ať se dá citovat jako podklad.
 */
export function eventsForAi(currency = 'CZK', limit = 24): string {
  const rows = eventsWithImpact(currency).slice(0, limit);
  if (rows.length === 0) return '';
  const lines = rows.map(one => {
    const when = one.from === one.to ? one.from : `${one.from} až ${one.to} (${one.days} dní)`;
    const money = one.moneyDiff == null ? ''
      : `, rozdíl proti běžnému provozu ${one.moneyDiff > 0 ? '+' : ''}${one.moneyDiff} ${currency}`;
    const rate = one.deltaPct == null ? ''
      : `, ${one.perDay} objednávky na den proti obvyklým ${one.basePerDay} (${one.deltaPct > 0 ? '+' : ''}${one.deltaPct} %)`;
    const social = one.posts > 0
      ? `, na sítích ${one.posts} příspěvků (${one.likes} lajků)` : '';
    const note = one.note ? ` — ${one.note}` : '';
    return `- [${one.kind}] ${one.title}: ${when}${rate}${money}${social}${note}`;
  });
  return `UDÁLOSTI, KTERÉ ZAPSAL ČLOVĚK (vysvětlují, proč čísla v těch dnech vypadají jinak):\n${lines.join('\n')}`;
}

export const __test = { span, shift };
