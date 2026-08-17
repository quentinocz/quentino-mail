import { BrowserWindow } from 'electron';
import { getDb } from './db';
import { buildOrderCard, shopMatchesSender } from './ordercard';
import { isFinalStatus } from './ordertrack';
import type { OrderCard, PackingOrder, PackingScan } from '../shared/types';

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

function readPacked(id: number): { packed: number[]; done: boolean; doneAt: string | null } {
  const row = getDb().prepare('SELECT packed_json, done, done_at FROM packing WHERE message_pk = ?').get(id) as any;
  if (!row) return { packed: [], done: false, doneAt: null };
  let packed: number[] = [];
  try { packed = JSON.parse(row.packed_json) ?? []; } catch { /* poškozený záznam bereme jako prázdný */ }
  return { packed, done: !!row.done, doneAt: row.done_at ?? null };
}

/** Odškrtne nebo odškrtnutí zruší u jedné položky objednávky. */
export function setItemPacked(messageId: number, index: number, value: boolean): PackingOrder['packed'] {
  const cur = readPacked(messageId);
  const next = value
    ? [...new Set([...cur.packed, index])].sort((a, b) => a - b)
    : cur.packed.filter(i => i !== index);
  getDb().prepare(
    `INSERT INTO packing (message_pk, packed_json, done, done_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(message_pk) DO UPDATE SET packed_json = excluded.packed_json`
  ).run(messageId, JSON.stringify(next), cur.done ? 1 : 0, cur.doneAt);
  return next;
}

/** Označí celou objednávku jako zabalenou (nebo označení zruší). */
export function setOrderDone(messageId: number, value: boolean): void {
  const cur = readPacked(messageId);
  getDb().prepare(
    `INSERT INTO packing (message_pk, packed_json, done, done_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(message_pk) DO UPDATE SET done = excluded.done, done_at = excluded.done_at`
  ).run(messageId, JSON.stringify(cur.packed), value ? 1 : 0, value ? new Date().toISOString() : null);
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
    orders.push({ messageId: c.id, date: c.date, card, packed: p.packed, done: p.done, doneAt: p.doneAt });
  }

  emit('packing:progress', { done: list.length, total: list.length, label: null });

  return {
    orders,
    statuses: [...statuses].sort((a, b) => a.localeCompare(b, 'cs')),
    scannedAt: new Date().toISOString()
  };
}
