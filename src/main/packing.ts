import { BrowserWindow } from 'electron';
import { getDb } from './db';
import { buildOrderCard, shopMatchesSender } from './ordercard';
import { isFinalStatus } from './ordertrack';
import { findByCode } from './products';
import type {
  OrderCard, OrderCardItem, PackingHit, PackingLookup, PackingOrder,
  PackingScan, PackingShopState, PackingState
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

/**
 * Objednávka z feedu, ne z pošty.
 *
 * Rozhraní pracuje s jedním číslem, ne s dvojicí zpráva/objednávka. Záporné
 * číslo proto znamená „tohle je řádek v `packing_shop`" — jeden pohled na
 * hodnotu stačí, aby bylo jasné, odkud se čte a kam se zapisuje.
 */
function isShopId(id: number): boolean {
  return id < 0;
}

function readPacked(id: number): PackingState {
  const row = getDb().prepare(
    isShopId(id)
      ? 'SELECT packed_json, counts_json, done, done_at FROM packing_shop WHERE id = ?'
      : 'SELECT packed_json, counts_json, done, done_at FROM packing WHERE message_pk = ?'
  ).get(isShopId(id) ? -id : id) as any;
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
  if (isShopId(id)) {
    const row = getDb().prepare('SELECT code, market FROM packing_shop WHERE id = ?').get(-id) as any;
    if (!row) return null;
    const order = shopOrderOf(String(row.code), String(row.market ?? ''));
    return order ? cardFromFeed(order) : null;
  }
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
  const packed = JSON.stringify(state.packed);
  const counts = JSON.stringify(state.counts);
  if (isShopId(id)) {
    // Řádek už existuje — zakládá se při otevření objednávky, aby vůbec bylo id
    getDb().prepare(
      `UPDATE packing_shop SET packed_json = ?, counts_json = ?, done = ?, done_at = ?
       WHERE id = ?`
    ).run(packed, counts, state.done ? 1 : 0, state.doneAt, -id);
    return;
  }
  getDb().prepare(
    `INSERT INTO packing (message_pk, packed_json, counts_json, done, done_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(message_pk) DO UPDATE SET packed_json = excluded.packed_json,
       counts_json = excluded.counts_json, done = excluded.done, done_at = excluded.done_at`
  ).run(id, packed, counts, state.done ? 1 : 0, state.doneAt);
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
 * Objednávka z feedu podle čísla.
 *
 * Vodicí nuly se mezi doklady liší — na faktuře „022605", ve variabilním
 * symbolu „22605". Porovnává se proto i tvar bez nul na obou stranách, jinak
 * by se stejné číslo napsané jinak nenašlo.
 */
function shopOrderOf(code: string, market?: string): any | null {
  const forms = numberForms(code);
  if (forms.length === 0) return null;
  const rows = getDb().prepare(
    `SELECT * FROM shop_orders WHERE code = ? OR ltrim(code, '0') = ?
     ORDER BY created_at DESC LIMIT 8`
  ).all(forms[0], forms[forms.length - 1]) as any[];
  if (rows.length === 0) return null;
  if (market) return rows.find(r => String(r.market ?? '') === market) ?? rows[0];
  return rows[0];
}

/**
 * Stav objednávky z feedu e-shopu.
 *
 * U starší objednávky je feed to jediné, co je aktuální: potvrzovací mail
 * říká, co si zákazník objednal v den nákupu, ale ne to, že je zásilka dávno
 * doručená nebo stornovaná. Právě tohle je potřeba vidět dřív, než někdo
 * začne balit něco, co se balit nemá.
 */
function shopStateFor(orderNumber: string | null | undefined): PackingShopState | null {
  const row = shopOrderOf(orderNumber ?? '');
  if (!row) return null;

  return {
    code: String(row.code ?? ''),
    invoice: String(row.invoice ?? ''),
    status: String(row.status ?? ''),
    at: row.updated_at || row.created_at || null,
    final: isFinalStatus(row.status)
  };
}

/** Čísla objednávky, pod kterými se dá hledat — vodicí nuly se všude liší. */
function numberForms(value: string): string[] {
  const digits = (value ?? '').replace(/\D+/g, '');
  if (!digits) return [];
  const bare = digits.replace(/^0+/, '');
  return bare && bare !== digits ? [digits, bare] : [digits];
}

/**
 * Zpráva s potvrzením objednávky daného čísla — bez ohledu na stáří.
 *
 * Běžný seznam k balení sahá jen pár dní zpátky, ale načtená faktura může být
 * i půl roku stará; hledá se proto rovnou podle čísla v předmětu, ne v okně.
 */
function messageForNumbers(numbers: string[]): Candidate | null {
  // Nejdřív hotové karty — u nich se ví, že číslo sedí přesně
  const cached = getDb().prepare(
    `SELECT c.message_pk AS id, c.json, m.date, m.subject, m.from_addr
     FROM order_cache c JOIN messages m ON m.id = c.message_pk
     WHERE c.json IS NOT NULL ORDER BY m.date DESC LIMIT 800`
  ).all() as any[];
  for (const row of cached) {
    let card: OrderCard | null = null;
    try { card = JSON.parse(row.json) as OrderCard; } catch { continue; }
    const forms = numberForms(card?.orderNumber ?? '');
    if (forms.some(f => numbers.includes(f))) {
      return { id: row.id, date: row.date ?? '', subject: row.subject ?? '', fromAddr: row.from_addr ?? '' };
    }
  }

  // Pak podle předmětu — na starší objednávku se karta teprve sestaví
  for (const number of numbers) {
    const rows = getDb().prepare(
      `SELECT id, date, subject, from_addr FROM messages
       WHERE subject LIKE ? ORDER BY date DESC LIMIT 40`
    ).all(`%${number}%`) as any[];
    for (const row of rows) {
      const subject = String(row.subject ?? '');
      if (!ORDER_SUBJECT.test(subject)) continue;
      if (!shopMatchesSender(String(row.from_addr ?? ''))) continue;
      return { id: row.id, date: row.date ?? '', subject, fromAddr: row.from_addr ?? '' };
    }
  }
  return null;
}

/**
 * Karta objednávky sestavená z feedu e-shopu.
 *
 * Feed nese u položek rovnou **kód varianty** — přesně ten, co je na štítku —
 * takže se proti němu odškrtává líp než proti mailu, kde bývá kód produktu
 * a varianta jen jako věta. Název, varianta a obrázek se doplní z katalogu;
 * adresu feed nemá, ta zůstane prázdná.
 */
function cardFromFeed(row: any): OrderCard {
  const market = String(row.market ?? 'cz');
  const currency = String(row.currency ?? '');

  let items: { title: string; code: string; quantity: number; price: number }[] = [];
  try { items = JSON.parse(row.items_json ?? '[]') ?? []; } catch { /* poškozený řádek = prázdno */ }

  const cardItems: OrderCardItem[] = items.map(item => {
    const hit = item.code ? findByCode(item.code) : null;
    return {
      qty: Math.max(1, Number(item.quantity) || 1),
      unit: 'ks',
      title: hit?.title || item.title || item.code || '—',
      code: item.code || null,
      url: null,
      price: item.price ? `${item.price} ${currency}`.trim() : '',
      availability: hit?.availability ?? null,
      variants: hit?.label ? [hit.label] : [],
      image: hit?.image ?? null,
      feedUrl: null,
      feedPrice: null,
      matched: !!hit
    };
  });

  const status = String(row.status ?? '') || null;
  return {
    orderNumber: String(row.code ?? ''),
    lang: (market === 'sk' || market === 'en' ? market : 'cz') as OrderCard['lang'],
    placedAt: row.created_at || null,
    customerEmail: row.email || null,
    customerPhone: row.phone || null,
    billing: null,
    shipping: row.name ? { name: String(row.name), company: null, lines: [], country: null } : null,
    items: cardItems,
    shipmentName: row.shipment || null,
    shipmentPrice: null,
    paymentName: row.payment || null,
    paymentPrice: null,
    total: row.total ? `${row.total} ${currency}`.trim() : null,
    historyUrl: null,
    adminUrl: null,
    adminSource: null,
    live: null,
    tracking: {
      source: 'api',
      status,
      createdAt: row.created_at || null,
      paidDate: row.paid_date || null,
      customerPhone: row.phone || null,
      carrierId: null,
      carrierName: null,
      trackingCode: row.tracking || null,
      trackingUrl: null,
      shipment: null,
      shipmentError: null
    }
  };
}

/** Číslo, pod kterým rozhraní vede objednávku z feedu — řádek se založí, když chybí. */
function shopIdFor(code: string, market: string): number {
  const d = getDb();
  d.prepare('INSERT OR IGNORE INTO packing_shop (code, market) VALUES (?, ?)').run(code, market);
  const row = d.prepare('SELECT id FROM packing_shop WHERE code = ? AND market = ?')
    .get(code, market) as any;
  return -Number(row.id);
}

/** Objednávka postavená na feedu — použije se, když k ní není potvrzovací mail. */
function orderFromFeed(row: any): PackingOrder {
  const id = shopIdFor(String(row.code ?? ''), String(row.market ?? ''));
  const state = readPacked(id);
  return {
    messageId: id,
    date: row.created_at || '',
    card: cardFromFeed(row),
    packed: state.packed, counts: state.counts, done: state.done, doneAt: state.doneAt,
    source: 'feed',
    shop: shopStateFor(String(row.code ?? ''))
  };
}

/** Objednávka postavená na potvrzovacím mailu — má navíc adresu. */
async function orderFromMail(found: Candidate): Promise<PackingOrder | null> {
  let card = cardOf(found.id);
  if (!card) {
    try { card = await buildOrderCard(found.id, true); } catch { card = null; }
    if (card) writeCache(found.id, card);
  }
  if (!card) return null;

  const state = readPacked(found.id);
  return {
    messageId: found.id, date: found.date, card,
    packed: state.packed, counts: state.counts, done: state.done, doneAt: state.doneAt,
    source: 'mail',
    shop: shopStateFor(card.orderNumber)
  };
}

/**
 * Krátký přehled feedu do hlášky, když se číslo nenajde.
 *
 * Rozsah dat řekne obojí, na čem hledání stojí: jak daleko feed sahá do
 * historie a jestli není starý. Bez toho by „nenašlo se" nešlo rozlišit od
 * „feed se týden nestáhl".
 */
function feedReach(): string {
  const row = getDb().prepare(
    `SELECT COUNT(*) AS n, MIN(created_at) AS oldest, MAX(created_at) AS newest FROM shop_orders`
  ).get() as any;
  const n = Number(row?.n ?? 0);
  if (n === 0) return 'feed objednávek je zatím prázdný, načti ho v nastavení';
  const oldest = String(row?.oldest ?? '').slice(0, 10);
  const newest = String(row?.newest ?? '').slice(0, 10);
  return oldest && newest
    ? `feed má ${n} objednávek (${oldest} až ${newest})`
    : `feed má ${n} objednávek`;
}

/**
 * Otevře objednávku podle načteného čísla — i takovou, která je dávno mimo
 * seznam k balení.
 *
 * Pořadí je dané tím, co je na papíře: na faktuře je **číslo faktury**, takže
 * se nejdřív přeloží přes feed na číslo objednávky. Teprve když načtené číslo
 * žádná faktura nemá, bere se jako číslo objednávky — jinak by se u čísla,
 * které je zároveň fakturou jedné a objednávkou druhé, otevřela ta nesprávná.
 * Když nastane obojí, druhá možnost se vrátí v `also` a rozhraní ji nabídne.
 *
 * Podklady se berou z mailu, když existuje (má navíc adresu), jinak z feedu —
 * ten má u položek rovnou kód varianty, takže se proti němu dá odškrtávat taky.
 */
export async function openOrder(raw: string): Promise<PackingLookup> {
  const asked = numberForms(raw);
  if (asked.length === 0) {
    return { ok: false, reason: 'noNumber', message: 'To není číslo objednávky ani faktury' };
  }
  const shown = asked[0];

  // 1) číslo jako faktura — to je to, co je na dokladu vytištěné
  const byInvoice = getDb().prepare(
    `SELECT * FROM shop_orders WHERE invoice != '' AND (invoice = ? OR ltrim(invoice, '0') = ?)
     ORDER BY created_at DESC LIMIT 4`
  ).all(asked[0], asked[asked.length - 1]) as any[];

  // 2) číslo jako číslo objednávky
  const byCode = shopOrderOf(shown);

  const primary = byInvoice[0] ?? byCode;
  if (!primary) {
    return {
      ok: false, reason: 'notInFeed',
      message: `Faktura ani objednávka ${shown} ve feedu není — ${feedReach()}`
    };
  }

  const code = String(primary.code ?? '');
  const order = await open(primary);
  if (!order) {
    return {
      ok: false, reason: 'noItems',
      message: `Objednávka ${code} nemá ve feedu položky a e-mail k ní nenajdu`
    };
  }

  /*
   * Číslo faktury jedné objednávky může být číslem jiné objednávky. Otevře se
   * ta z faktury, ale o druhé se musí vědět — jinak by se tiše balila špatná.
   */
  let also: PackingLookup['also'];
  if (byInvoice[0] && byCode && String(byCode.code ?? '') !== code) {
    also = {
      orderNumber: String(byCode.code ?? ''),
      note: `Číslo ${shown} je faktura objednávky ${code}, ale existuje i objednávka ${byCode.code}`
    };
  }

  return { ok: true, order, also };
}

/** Podklady k objednávce: nejdřív mail (má adresu), jinak feed. */
async function open(row: any): Promise<PackingOrder | null> {
  const numbers = numberForms(String(row.code ?? ''));
  const found = numbers.length > 0 ? messageForNumbers(numbers) : null;
  if (found) {
    const fromMail = await orderFromMail(found);
    if (fromMail) return fromMail;
  }

  let items: unknown[] = [];
  try { items = JSON.parse(row.items_json ?? '[]') ?? []; } catch { /* prázdno */ }
  return items.length > 0 ? orderFromFeed(row) : null;
}

/** Jen pro zkoušky — jednotlivé kroky hledání objednávky se jinak nedají chytit. */
/** Označí celou objednávku jako zabalenou (nebo označení zruší). */
export function setOrderDone(messageId: number, value: boolean): void {
  const state = readPacked(messageId);
  state.done = value;
  state.doneAt = value ? new Date().toISOString() : null;
  save(messageId, state);
}

/** Vynuluje odškrtání u objednávky. */
export function resetPacking(messageId: number): void {
  if (isShopId(messageId)) {
    getDb().prepare(
      `UPDATE packing_shop SET packed_json = '[]', counts_json = '{}', done = 0, done_at = NULL
       WHERE id = ?`
    ).run(-messageId);
    return;
  }
  getDb().prepare('DELETE FROM packing WHERE message_pk = ?').run(messageId);
}

/** Jen pro zkoušky — jednotlivé kroky hledání objednávky se jinak nedají chytit. */
export const __test = { messageForNumbers, shopStateFor, shopOrderOf, cardFromFeed };

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
      packed: p.packed, counts: p.counts, done: p.done, doneAt: p.doneAt,
      source: 'mail', shop: shopStateFor(card.orderNumber)
    });
  }

  emit('packing:progress', { done: list.length, total: list.length, label: null });

  return {
    orders,
    statuses: [...statuses].sort((a, b) => a.localeCompare(b, 'cs')),
    scannedAt: new Date().toISOString()
  };
}
