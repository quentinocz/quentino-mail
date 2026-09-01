import { BrowserWindow } from 'electron';
import { getDb, getSetting, setSetting } from './db';
import { buildOrderCard, shopMatchesSender } from './ordercard';
import { isFinalStatus } from './ordertrack';
import { findByCode } from './products';
import { ordersSince, refreshForPacking } from './orderfeed';
import * as live from './live';
import type {
  OrderAddress, OrderCard, OrderCardItem, PackingHit, PackingLookup, PackingOrder,
  PackingScan, PackingShopState, PackingState, ShopAddress, ShopOrder
} from '../shared/types';

/**
 * Podklady pro balení objednávek.
 *
 * Zdrojem je **feed objednávek**. Dřív se procházela schránka a ke každému
 * potvrzovacímu e-mailu se skládala karta — u týdenního okna to znamenalo
 * desítky rozborů a stahování stránek objednávek, tedy dlouhé čekání pokaždé,
 * když se okno otevřelo. Feed má přitom všechno potřebné v jedné lokální
 * tabulce, u položek rovnou kód varianty (ten je i na štítku) a k tomu
 * aktuální stav objednávky.
 *
 * E-mail zůstává na dvě věci: na objednávku zadanou před chvílí, kterou feed
 * ještě nestihl, a na tlačítko „Otevřít e-mail" u konkrétní objednávky.
 */

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
function orderMails(since: string, limit = 40): Candidate[] {
  const rows = getDb().prepare(
    `SELECT id, date, subject, from_addr FROM messages
     WHERE date >= ? ORDER BY date DESC LIMIT ?`
  ).all(since, limit) as any[];

  return rows
    .filter(r => ORDER_SUBJECT.test(r.subject) && SUBJECT_NUMBER.test(r.subject))
    .filter(r => shopMatchesSender(r.from_addr ?? ''))
    .map(r => ({ id: r.id, date: r.date, subject: r.subject, fromAddr: r.from_addr }));
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
    pushSoon(id);
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
/**
 * Adresa z feedu do tvaru, jaký zná karta objednávky.
 *
 * Jméno se bere z adresy, a když v ní není, ze zákazníka — u firemních
 * objednávek bývá vyplněná jen firma, ale balík stejně přebírá člověk.
 */
function addressFromFeed(json: string | null, fallbackName = ''): OrderAddress | null {
  let a: ShopAddress | null = null;
  try { a = JSON.parse(json ?? 'null'); } catch { return null; }
  if (!a || typeof a !== 'object') return null;

  const lines = [
    a.street,
    [a.zip, a.city].filter(Boolean).join(' '),
    a.state
  ].map(line => (line ?? '').trim()).filter(Boolean);

  const name = (a.name || fallbackName || '').trim();
  if (!name && !a.company && lines.length === 0) return null;

  return {
    name: name || a.company || '',
    company: a.company || null,
    lines,
    country: a.country || null
  };
}

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

  /*
   * Adresa. Doručovací nemusí být vyplněná — pak se doručuje na fakturační,
   * a právě to je na kartě potřeba vidět. U výdejních míst je v doručovací
   * adresa toho místa, což je při balení to, co se opisuje.
   */
  const postal = addressFromFeed(row.postal_json, String(row.name ?? ''));
  const billing = addressFromFeed(row.billing_json, String(row.name ?? ''));

  const status = String(row.status ?? '') || null;
  return {
    orderNumber: String(row.code ?? ''),
    lang: (market === 'sk' || market === 'en' ? market : 'cz') as OrderCard['lang'],
    placedAt: row.created_at || null,
    customerEmail: row.email || null,
    customerPhone: row.phone || null,
    billing,
    shipping: postal ?? billing,
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
  // Nula znamená, že se řádek nepovedlo založit; volající ji musí zahodit,
  // protože kladné číslo by rozhraní vzalo jako zprávu
  return row?.id ? -Number(row.id) : 0;
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
 * Otevře objednávku podle čísla z faktury — i takovou, která je dávno mimo
 * seznam k balení.
 *
 * **Načtené číslo je vždycky číslo faktury.** QR na dokladu nic jiného nenese
 * a číslo objednávky se z něj nikdy neskenuje. Objednávka se proto pokaždé
 * dohledá přes feed: faktura → řádek ve feedu → číslo objednávky.
 *
 * Obě čísla se schválně nemíchají. Číslo faktury jedné objednávky totiž může
 * být zároveň číslem jiné objednávky, a kdyby se hledalo „nejdřív jako
 * faktura, a když to nevyjde, tak jako objednávka", otevřela by se u takového
 * čísla cizí objednávka — a poznalo by se to až podle zboží v krabici.
 * Když faktura ve feedu není, řekne se to; hádat se nebude.
 *
 * Ruční pole je na to výjimka, ale výslovná: kdo si číslo objednávky opíše
 * z e-shopu, zadá ho jako číslo objednávky (`as: 'code'`).
 *
 * Podklady se berou z mailu, když existuje (má navíc adresu), jinak z feedu —
 * ten má u položek rovnou kód varianty, takže se proti němu dá odškrtávat taky.
 */
export async function openOrder(raw: string, as: 'invoice' | 'code' = 'invoice'):
  Promise<PackingLookup> {
  const asked = numberForms(raw);
  if (asked.length === 0) {
    return { ok: false, reason: 'noNumber', message: 'To není číslo faktury' };
  }
  const shown = asked[0];

  const row = as === 'code' ? shopOrderOf(shown) : invoiceRow(asked);
  if (row) {
    const code = String(row.code ?? '');
    const order = await open(row);
    if (order) return { ok: true, order };
    return {
      ok: false, reason: 'noItems',
      message: `Objednávka ${code} nemá ve feedu položky a e-mail k ní nenajdu`
    };
  }

  /*
   * Ve feedu není — může být starší, než kam feed sahá. Potvrzovací e-mail
   * ale ve schránce být může; hledá se v něm ale jen podle čísla objednávky,
   * takže z faktury se takhle vyjít nedá.
   */
  if (as === 'code') {
    const found = messageForNumbers(asked);
    const fromMail = found ? await orderFromMail(found) : null;
    if (fromMail) return { ok: true, order: fromMail };
    return {
      ok: false, reason: 'notInFeed',
      message: `Objednávka ${shown} ve feedu není — ${feedReach()}`
    };
  }

  return {
    ok: false, reason: 'notInFeed',
    message: `Faktura ${shown} ve feedu není — ${feedReach()}`
  };
}

/**
 * Řádek feedu podle čísla faktury.
 *
 * Vede se přesně i bez úvodních nul: e-shop píše `022605`, čtečka přečte
 * `22605` a řetězcové porovnání by je minulo.
 */
function invoiceRow(forms: string[]): any | null {
  const rows = getDb().prepare(
    `SELECT * FROM shop_orders WHERE invoice != '' AND (invoice = ? OR ltrim(invoice, '0') = ?)
     ORDER BY created_at DESC LIMIT 4`
  ).all(forms[0], forms[forms.length - 1]) as any[];
  return rows[0] ?? null;
}

/**
 * Podklady k objednávce z feedu.
 *
 * Feed má přednost, i když k objednávce e-mail existuje, a to kvůli jediné
 * věci: **totožnosti**. Odškrtání se drží u čísla, pod kterým se objednávka
 * v seznamu vede, a kdyby ji jednou otevřel feed a podruhé mail, byla by to
 * dvě různá čísla a odškrtané kusy by se rozešly. Sáhne se po mailu jedině
 * tehdy, když feed u objednávky nemá položky.
 */
async function open(row: any): Promise<PackingOrder | null> {
  let items: unknown[] = [];
  try { items = JSON.parse(row.items_json ?? '[]') ?? []; } catch { /* prázdno */ }
  if (items.length > 0) return orderFromFeed(row);

  const numbers = numberForms(String(row.code ?? ''));
  const found = numbers.length > 0 ? messageForNumbers(numbers) : null;
  return found ? orderFromMail(found) : null;
}

/**
 * Zpráva s potvrzením dané objednávky — pro tlačítko „Otevřít e-mail".
 *
 * Hledá se až ve chvíli, kdy na tlačítko někdo klepne. Kdyby se dohledávalo
 * pro celý seznam předem, byl by z toho průchod schránkou pro každou
 * objednávku — přesně to, čeho se sestavením z feedu zbavujeme.
 */
export function mailForOrder(orderNumber: string): number | null {
  const numbers = numberForms(orderNumber);
  if (numbers.length === 0) return null;
  return messageForNumbers(numbers)?.id ?? null;
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
    // Vynulování je taky změna stavu — druhé zařízení o ní musí vědět,
    // jinak by tam zůstalo odškrtnuté to, co se právě zrušilo
    pushSoon(messageId);
    return;
  }
  getDb().prepare('DELETE FROM packing WHERE message_pk = ?').run(messageId);
}

/** Jen pro zkoušky — jednotlivé kroky hledání objednávky se jinak nedají chytit. */
export const __test = { messageForNumbers, shopStateFor, shopOrderOf, cardFromFeed };

/**
 * Kolik minut zpátky se po sestavení seznamu ještě kouká do pošty.
 *
 * Rychlý feed se přegenerovává po pěti minutách, takže objednávka zadaná před
 * chvílí v něm ještě není — potvrzovací e-mail ale dorazil hned. Deset minut
 * je s rezervou na obojí: na zpoždění feedu i na to, že se soubor stahuje
 * chvíli po značce.
 */
const MAIL_TOPUP_MINUTES = 10;

/**
 * Rozdělané balení z doby, kdy seznam stál na e-mailech.
 *
 * Odškrtání se drží u čísla, pod kterým se objednávka vede. Přechodem na feed
 * se to číslo změnilo, takže by rozdělaná objednávka vypadala jako nezačatá.
 * Projde se to jednou a stav se přenese; přiřadit objednávku jde přes uloženou
 * kartu, kde je její číslo.
 */
function migrateMailPacking(): void {
  const d = getDb();
  if (getSetting('packingFeedMigrated', '') === '1') return;

  const rows = d.prepare(
    `SELECT p.message_pk AS id, p.packed_json, p.counts_json, p.done, p.done_at, c.json
     FROM packing p JOIN order_cache c ON c.message_pk = p.message_pk
     WHERE c.json IS NOT NULL`
  ).all() as any[];

  for (const row of rows) {
    let card: OrderCard | null = null;
    try { card = JSON.parse(row.json) as OrderCard; } catch { continue; }
    const order = shopOrderOf(card?.orderNumber ?? '');
    if (!order) continue;

    const id = shopIdFor(String(order.code ?? ''), String(order.market ?? ''));
    // Co je na novém místě rozdělané, se nepřepisuje — přenáší se jen prázdné
    const existing = readPacked(id);
    if (existing.packed.length > 0 || Object.keys(existing.counts).length > 0 || existing.done) continue;

    d.prepare(
      `UPDATE packing_shop SET packed_json = ?, counts_json = ?, done = ?, done_at = ? WHERE id = ?`
    ).run(row.packed_json ?? '[]', row.counts_json ?? '{}', row.done ?? 0, row.done_at ?? null, -id);
  }

  setSetting('packingFeedMigrated', '1');
}

/**
 * Sestaví seznam objednávek k balení.
 *
 * Zdrojem je **feed objednávek**, ne potvrzovací e-maily. Dřív se procházela
 * schránka a ke každé zprávě se skládala karta — u týdenního okna to
 * znamenalo desítky rozborů a stahování stránek objednávek. Feed má přitom
 * všechno potřebné v jedné lokální tabulce, u položek rovnou kód varianty
 * a k tomu aktuální stav objednávky.
 *
 * Před sestavením se obnoví rychlý feed s posledními 24 h; kompletní exporty
 * jen tehdy, když okno sahá dál než den. Objednávku zadanou před chvílí feed
 * ještě nemusí mít, takže se nakonec dokouká do pošty za posledních pár minut.
 */
export async function scanOrders(days: number, force = false): Promise<PackingScan> {
  emit('packing:progress', { done: 0, total: 0, label: 'Obnovuji feed objednávek…' });
  await refreshForPacking(days, force);
  migrateMailPacking();

  const rows = ordersSince(days);
  const orders: PackingOrder[] = [];
  const statuses = new Set<string>();
  const seen = new Set<string>();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (i % 25 === 0) emit('packing:progress', { done: i, total: rows.length, label: null });
    if (row.items.length === 0) continue;
    /*
     * Bez čísla by objednávka nedostala platné číslo v seznamu a odškrtávala
     * by se pod nulou — tedy do řádku patřícího zprávě. Takový řádek ve feedu
     * nemá co dělat, ale stát se to může.
     */
    if (!row.code) continue;

    const id = shopIdFor(row.code, row.market);
    if (id >= 0) continue;
    const state = readPacked(id);
    if (row.status) statuses.add(row.status);
    for (const form of numberForms(row.code)) seen.add(form);

    orders.push({
      messageId: id,
      date: row.createdAt,
      card: cardFromFeed(feedRow(row)),
      packed: state.packed, counts: state.counts, done: state.done, doneAt: state.doneAt,
      source: 'feed',
      shop: {
        code: row.code, invoice: row.invoice, status: row.status,
        at: row.updatedAt || row.createdAt || null, final: isFinalStatus(row.status)
      }
    });
  }

  /*
   * Doplnění z pošty. Feed se přegenerovává po pěti minutách, takže objednávka
   * zadaná před chvílí v něm chybí — a právě ta je při balení ta nejdůležitější.
   */
  emit('packing:progress', { done: rows.length, total: rows.length, label: 'Kontroluji poštu…' });
  for (const fresh of await recentFromMail(seen)) {
    orders.unshift(fresh);
    const status = fresh.card.tracking?.status ?? fresh.card.live?.status ?? null;
    if (status) statuses.add(status);
  }

  emit('packing:progress', { done: rows.length, total: rows.length, label: null });

  return {
    orders,
    statuses: [...statuses].sort((a, b) => a.localeCompare(b, 'cs')),
    scannedAt: new Date().toISOString()
  };
}

/** `ShopOrder` zpátky do tvaru řádku, se kterým pracuje `cardFromFeed`. */
function feedRow(order: ShopOrder): any {
  return {
    code: order.code, market: order.market, currency: order.currency,
    items_json: JSON.stringify(order.items), status: order.status,
    phone: order.phone, name: order.name, email: order.email,
    total: order.total, created_at: order.createdAt, paid_date: order.paidDate,
    shipment: order.shipment, payment: order.payment, tracking: order.tracking,
    billing_json: order.billing ? JSON.stringify(order.billing) : null,
    postal_json: order.postal ? JSON.stringify(order.postal) : null
  };
}

/**
 * Objednávky z posledních pár minut, které ve feedu ještě nejsou.
 *
 * Prochází se jen zprávy z tohohle krátkého okna, takže je to pár řádků, ne
 * celá schránka. Karta se skládá z mailu — ta objednávka ve feedu prostě
 * ještě není a čekat na něj by znamenalo o ní nevědět.
 */
async function recentFromMail(seen: Set<string>): Promise<PackingOrder[]> {
  const since = new Date(Date.now() - MAIL_TOPUP_MINUTES * 60_000).toISOString();
  const out: PackingOrder[] = [];

  for (const row of orderMails(since)) {
    let card = cardOf(row.id);
    if (!card) {
      try { card = await buildOrderCard(row.id, true); } catch { card = null; }
      if (card) writeCache(row.id, card);
    }
    if (!card) continue;
    if (numberForms(card.orderNumber ?? '').some(form => seen.has(form))) continue;

    const state = readPacked(row.id);
    out.push({
      messageId: row.id, date: row.date, card,
      packed: state.packed, counts: state.counts, done: state.done, doneAt: state.doneAt,
      source: 'mail', shop: shopStateFor(card.orderNumber)
    });
  }
  return out;
}



/* ---------- rychlý posel ---------- */

/**
 * Odškrtávání se posílá druhému zařízení hned.
 *
 * Balí se s telefonem v ruce, ale krabice se zavírá u počítače a etiketa
 * se tiskne tam — a mezitím se nesmí stát, že jedna strana odškrtne kus,
 * o kterém druhá neví, a zboží se do krabice dá dvakrát.
 *
 * Posílají se **jen objednávky z feedu**. Ty se vedou pod dvojicí kód +
 * trh, která je na obou zařízeních stejná. Objednávka vedená podle
 * e-mailu má na každém zařízení jiné číslo zprávy, takže by se stav
 * neměl k čemu přiřadit; ty ostatně po přechodu balení na feed zbyly jen
 * pro objednávky starší, než kam feed sahá.
 *
 * Sdílená složka odškrtávání nenese — je to stav rozdělané práce, ne
 * dokument. Když posel nedoručí, dokončí se balení tam, kde začalo.
 */
const packingTimers = new Map<number, NodeJS.Timeout>();

export function packingSlice(id: number): any | null {
  if (!isShopId(id)) return null;
  const row = getDb().prepare(
    'SELECT code, market, packed_json, counts_json, done, done_at FROM packing_shop WHERE id = ?'
  ).get(-id) as any;
  if (!row) return null;
  return {
    code: String(row.code ?? ''),
    market: String(row.market ?? ''),
    packed: row.packed_json ?? '[]',
    counts: row.counts_json ?? '{}',
    done: !!row.done,
    doneAt: row.done_at ?? null,
    at: new Date().toISOString()
  };
}

/**
 * Oznámí, že se na téhle objednávce právě pracuje.
 *
 * Bez toho se druhé zařízení dozvědělo o balení až při prvním odškrtnutí —
 * jenže rozhodnutí „balím tuhle" padne dřív, při načtení faktury nebo
 * klepnutí v seznamu, a právě tehdy má počítač nabídnout, že se dá
 * pokračovat u něj. Posílá se tentýž stav jako při odškrtávání, takže na
 * druhé straně není co rozlišovat.
 */
export function workingOn(id: number): void {
  if (!isShopId(id)) return;
  const slice = packingSlice(id);
  if (slice) live.publish('packing', slice);
}

function pushSoon(id: number): void {
  if (!isShopId(id)) return;
  const running = packingTimers.get(id);
  if (running) clearTimeout(running);
  packingTimers.set(id, setTimeout(() => {
    packingTimers.delete(id);
    const slice = packingSlice(id);
    if (slice) live.publish('packing', slice);
  }, 400));
}

/**
 * Přijaté odškrtávání od druhého zařízení.
 *
 * Zapisuje se natvrdo, protože poslední slovo má ten, kdo drží krabici —
 * a stav se posílá celý, ne po kusech, takže není co slučovat. Když
 * objednávka na tomhle zařízení ještě řádek nemá, založí se.
 */
export interface AppliedPacking {
  /** Číslo, pod kterým objednávku vede rozhraní — u feedu záporné */
  id: number;
  code: string;
  packed: number[];
  counts: Record<string, number>;
  done: boolean;
  doneAt: string | null;
}

export function applyPacking(slice: any): AppliedPacking | null {
  const code = String(slice?.code ?? '');
  if (!code) return null;
  const market = String(slice?.market ?? '');
  const d = getDb();
  d.prepare(
    `INSERT INTO packing_shop (code, market, packed_json, counts_json, done, done_at)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(code, market) DO UPDATE SET
       packed_json = excluded.packed_json, counts_json = excluded.counts_json,
       done = excluded.done, done_at = excluded.done_at`
  ).run(
    code, market,
    String(slice.packed ?? '[]'), String(slice.counts ?? '{}'),
    slice.done ? 1 : 0, slice.doneAt ?? null
  );

  /*
   * Zpátky se vrací i číslo, pod kterým objednávku vede rozhraní. Bez něj by
   * si otevřené okno muselo hledat řádek podle čísla objednávky — a hlavně
   * by se muselo obejít bez toho, co se doopravdy zapsalo, takže by se
   * odškrtnutí z telefonu na obrazovce neprojevilo, dokud se seznam nenačte
   * znovu. Přesně tohle se dělo: v databázi to bylo, na obrazovce ne.
   */
  const row = d.prepare('SELECT id FROM packing_shop WHERE code = ? AND market = ?')
    .get(code, market) as any;

  const parse = <T>(text: unknown, fallback: T): T => {
    try { return JSON.parse(String(text ?? '')) as T; } catch { return fallback; }
  };
  return {
    id: -Number(row?.id ?? 0),
    code,
    packed: parse<number[]>(slice.packed, []),
    counts: parse<Record<string, number>>(slice.counts, {}),
    done: !!slice.done,
    doneAt: slice.doneAt ?? null
  };
}
