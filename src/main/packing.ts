import { BrowserWindow } from 'electron';
import { getDb } from './db';
import { buildOrderCard, shopMatchesSender } from './ordercard';
import { isFinalStatus } from './ordertrack';
import { findByCode } from './products';
import type {
  OrderCard, PackingFind, PackingHit, PackingOrder, PackingScan, PackingState
} from '../shared/types';

/**
 * Podklady pro balení objednávek.
 *
 * Objednávky se sbírají z potvrzovacích e-mailů — projdou se zprávy za zvolené
 * období, z každé se sestaví karta objednávky a výsledek se uloží do databáze,
 * aby se při dalším otevření nemuselo znovu stahovat nic než živý stav.
 */

const CACHE_TTL = 10 * 60_000;
const ORDER_SUBJECT = /(objedn[áa]v|order\b|bestellung)/i;
const SUBJECT_NUMBER = /(?:č\.|c\.|no\.|nr\.|#)\s*\d{3,}/i;

function emit(channel: string, payload: unknown) {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload);
}

interface Candidate { id: number; date: string; subject: string; fromAddr: string }

/**
 * Kód ze štítku do porovnatelné podoby.
 *
 * Na vlastních QR je „quentino:PS120CRV", na těch z e-shopu celá adresa
 * produktu — a v objednávce je holý kód. Bez tohohle by se nesešly.
 */
function normCode(raw: string): string {
  return (raw ?? '')
    .trim()
    .replace(/^quentino:/i, '')
    .replace(/^.*\/p\//, '')
    .trim()
    .toUpperCase();
}

/** Zprávy, které podle hlavičky vypadají na potvrzení objednávky z našeho e-shopu. */
function candidates(days: number): Candidate[] {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const rows = getDb().prepare(
    `SELECT id, date, subject, from_addr FROM messages
     WHERE date >= ? ORDER BY date DESC LIMIT 400`
  ).all(since) as any[];

  return rows
    .filter(r => ORDER_SUBJECT.test(r.subject) && SUBJECT_NUMBER.test(r.subject))
    .filter(r => shopMatchesSender(r.from_addr ?? ''))
    .map(r => ({ id: r.id, date: r.date, subject: r.subject, fromAddr: r.from_addr }));
}

function readCache(id: number): OrderCard | null | undefined {
  const row = getDb().prepare('SELECT json, at FROM order_cache WHERE message_pk = ?').get(id) as any;
  if (!row) return undefined;
  const card = row.json ? JSON.parse(row.json) as OrderCard : null;
  // Doručené a stornované objednávky se už nezmění — ty se znovu nenačítají
  // ani při ručním obnovení, jinak by každý sken zbytečně stahoval historii.
  // Výjimkou jsou starší záznamy uložené ještě bez stavu zásilky.
  if (card && isFinalStatus(card.tracking?.status ?? card.live?.status)
    && !(card.tracking?.trackingCode && !card.tracking.shipment)) return card;
  if (Date.now() - new Date(row.at).getTime() > CACHE_TTL) return undefined;
  return card;
}

function writeCache(id: number, card: OrderCard | null) {
  getDb().prepare(
    `INSERT INTO order_cache (message_pk, json, at) VALUES (?, ?, ?)
     ON CONFLICT(message_pk) DO UPDATE SET json = excluded.json, at = excluded.at`
  ).run(id, card ? JSON.stringify(card) : null, new Date().toISOString());
}

function readPacked(id: number): PackingState {
  const row = getDb().prepare(
    'SELECT packed_json, counts_json, done, done_at FROM packing WHERE message_pk = ?'
  ).get(id) as any;
  if (!row) return { packed: [], counts: {}, done: false, doneAt: null };

  let packed: number[] = [];
  try { packed = JSON.parse(row.packed_json) ?? []; } catch { /* poškozený záznam bereme jako prázdný */ }
  let counts: Record<string, number> = {};
  try { counts = JSON.parse(row.counts_json ?? '{}') ?? {}; } catch { /* dtto */ }

  /*
   * Záznamy z doby před počítáním kusů mají jen seznam odškrtnutých položek.
   * Odškrtnutá položka znamenala „celá zabalená", takže se dopočítá na plný
   * počet — jinak by po aktualizaci vypadalo rozdělané balení jako nezačaté.
   */
  if (Object.keys(counts).length === 0 && packed.length > 0) {
    const items = cardOf(id)?.items ?? [];
    for (const i of packed) counts[String(i)] = Math.max(1, items[i]?.qty ?? 1);
  }

  return { packed, counts, done: !!row.done, doneAt: row.done_at ?? null };
}

/** Karta objednávky z uložených podkladů — bez ohledu na stáří, jen kvůli počtům. */
function cardOf(id: number): OrderCard | null {
  const row = getDb().prepare('SELECT json FROM order_cache WHERE message_pk = ?').get(id) as any;
  if (!row?.json) return null;
  try { return JSON.parse(row.json) as OrderCard; } catch { return null; }
}

/** Kolik kusů má být u položky — z uložené karty, s pojistkou na jeden kus. */
function qtyOf(id: number, index: number): number {
  const item = cardOf(id)?.items?.[index];
  return Math.max(1, item?.qty ?? 1);
}

function save(id: number, state: PackingState) {
  getDb().prepare(
    `INSERT INTO packing (message_pk, packed_json, counts_json, done, done_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(message_pk) DO UPDATE SET packed_json = excluded.packed_json,
       counts_json = excluded.counts_json, done = excluded.done, done_at = excluded.done_at`
  ).run(id, JSON.stringify(state.packed), JSON.stringify(state.counts),
    state.done ? 1 : 0, state.doneAt);
}

/**
 * Nastaví, kolik kusů položky už je v krabici.
 *
 * Seznam odškrtnutých položek se z počtů dopočítá — položka je odškrtnutá
 * teprve tehdy, když je v krabici všech svých kusů. Zbytek aplikace se tak
 * nemusí ptát dvakrát a starší obrazovky fungují dál beze změny.
 */
export function setItemCount(messageId: number, index: number, count: number): PackingState {
  const qty = qtyOf(messageId, index);
  const value = Math.max(0, Math.min(qty, Math.round(count)));
  const state = readPacked(messageId);

  if (value === 0) delete state.counts[String(index)];
  else state.counts[String(index)] = value;

  state.packed = value >= qty
    ? [...new Set([...state.packed, index])].sort((a, b) => a - b)
    : state.packed.filter(i => i !== index);

  save(messageId, state);
  return state;
}

/** Odškrtne nebo odškrtnutí zruší u celé položky — tedy všech jejích kusů. */
export function setItemPacked(messageId: number, index: number, value: boolean): PackingState {
  return setItemCount(messageId, index, value ? qtyOf(messageId, index) : 0);
}

/**
 * Načtený kód přiřadí k položce objednávky a přidá jeden kus.
 *
 * Na štítku bývá kód varianty, v objednávce může být kód produktu (nebo
 * naopak), takže se hledá přes katalog: ten z kódu vrátí obojí a porovnává se
 * pak proti oběma. Když je táž položka v objednávce vícekrát, přednost dostane
 * ta, které ještě kusy chybí — jinak by se druhý kus neměl kam připsat.
 */
export function scanItem(messageId: number, raw: string): PackingHit {
  const text = normCode(raw);
  if (!text) return { ok: false, reason: 'empty', message: 'Prázdný kód' };

  const card = cardOf(messageId);
  if (!card) return { ok: false, reason: 'noOrder', message: 'Objednávka není načtená' };

  const found = findByCode(text);
  const wanted = new Set([text, normCode(found?.code ?? ''), normCode(found?.productCode ?? '')]
    .filter(Boolean));

  const state = readPacked(messageId);
  const matching = card.items
    .map((it, i) => ({ it, i }))
    .filter(({ it }) => wanted.has(normCode(it.code ?? '')));

  if (matching.length === 0) {
    return {
      ok: false, reason: 'notInOrder',
      message: found ? `${found.title} v téhle objednávce není` : `Kód ${text} v objednávce není`
    };
  }

  // Nejdřív položky, kterým ještě kusy chybí
  const spot = matching.find(({ it, i }) =>
    (state.counts[String(i)] ?? 0) < Math.max(1, it.qty ?? 1)) ?? matching[0];
  const qty = Math.max(1, spot.it.qty ?? 1);
  const before = state.counts[String(spot.i)] ?? 0;

  if (before >= qty) {
    return {
      ok: false, reason: 'already', index: spot.i, code: spot.it.code, title: spot.it.title,
      count: before, qty, needMore: 0,
      message: `${spot.it.title} — všech ${qty} ks už je odškrtnutých`
    };
  }

  const next = setItemCount(messageId, spot.i, before + 1);
  const count = next.counts[String(spot.i)] ?? 0;
  const needMore = qty - count;

  return {
    ok: true, index: spot.i, code: spot.it.code, title: spot.it.title,
    count, qty, needMore,
    message: qty > 1
      ? `${spot.it.title} — ${count}/${qty} ks${needMore > 0 ? `, ještě ${needMore}` : ''}`
      : spot.it.title
  };
}

/**
 * Objednávka podle čísla z faktury.
 *
 * QR kód na faktuře nese číslo faktury, které nemusí být totéž co číslo
 * objednávky — proto se zkouší obojí: nejdřív přímo jako číslo objednávky,
 * pak přes tabulku objednávek z feedu, kde je faktura vedle svého čísla
 * objednávky. Vodicí nuly se ignorují, na faktuře i v e-shopu se liší.
 */
export function findOrder(raw: string): PackingFind | null {
  const digits = (raw ?? '').replace(/\D+/g, '');
  if (digits.length < 3) return null;

  const wanted = new Set<string>([digits, digits.replace(/^0+/, '')]);
  const rows = getDb().prepare(
    `SELECT code FROM shop_orders WHERE invoice != '' AND (invoice = ? OR invoice = ?)`
  ).all(digits, digits.replace(/^0+/, '')) as any[];
  for (const r of rows) {
    const c = String(r.code ?? '').replace(/\D+/g, '');
    if (c) { wanted.add(c); wanted.add(c.replace(/^0+/, '')); }
  }

  const cached = getDb().prepare(
    `SELECT message_pk, json FROM order_cache WHERE json IS NOT NULL
     ORDER BY at DESC LIMIT 800`
  ).all() as any[];

  for (const row of cached) {
    let card: OrderCard | null = null;
    try { card = JSON.parse(row.json) as OrderCard; } catch { continue; }
    const num = (card?.orderNumber ?? '').replace(/\D+/g, '');
    if (!num) continue;
    if (wanted.has(num) || wanted.has(num.replace(/^0+/, ''))) {
      return { messageId: row.message_pk as number, orderNumber: card!.orderNumber };
    }
  }
  return null;
}

/** Označí celou objednávku jako zabalenou (nebo označení zruší). */
export function setOrderDone(messageId: number, value: boolean): void {
  const state = readPacked(messageId);
  state.done = value;
  state.doneAt = value ? new Date().toISOString() : null;
  save(messageId, state);
}

/** Vynuluje odškrtání u objednávky. */
export function resetPacking(messageId: number): void {
  getDb().prepare('DELETE FROM packing WHERE message_pk = ?').run(messageId);
}

/**
 * Projde e-maily za zvolené období a sestaví seznam objednávek k balení.
 * Postup hlásí událostí `packing:progress`, ať uživatel u delšího načítání vidí, co se děje.
 */
export async function scanOrders(days: number, force = false): Promise<PackingScan> {
  const list = candidates(days);
  const orders: PackingOrder[] = [];
  const statuses = new Set<string>();

  emit('packing:progress', { done: 0, total: list.length, label: null });

  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    emit('packing:progress', { done: i, total: list.length, label: c.subject });

    let card = force ? undefined : readCache(c.id);
    if (card === undefined) {
      try {
        card = await buildOrderCard(c.id, true);
      } catch {
        card = null; // nedostupná zpráva balení neblokuje
      }
      writeCache(c.id, card);
    }
    if (!card) continue;

    const status = card.tracking?.status ?? card.live?.status ?? null;
    if (status) statuses.add(status);

    const p = readPacked(c.id);
    orders.push({
      messageId: c.id, date: c.date, card,
      packed: p.packed, counts: p.counts, done: p.done, doneAt: p.doneAt
    });
  }

  emit('packing:progress', { done: list.length, total: list.length, label: null });

  return {
    orders,
    statuses: [...statuses].sort((a, b) => a.localeCompare(b, 'cs')),
    scannedAt: new Date().toISOString()
  };
}
