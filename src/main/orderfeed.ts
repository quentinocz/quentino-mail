import { net } from 'electron';
import { getDb, getSetting, setSetting } from './db';
import { encrypt, decrypt } from './secure';
import type { ShopAddress, ShopOrder, ShopOrderItem, OrderFeed, OrderFeedStatus } from '../shared/types';

/**
 * Objednávky z exportních feedů e-shopu.
 *
 * Doteď se objednávky skládaly z potvrzovacích e-mailů. Na přehled to stačí,
 * ale telefon v mailu většinou není — a přitom právě ten je potřeba, když
 * chce člověk zákazníkovi zavolat místo psaní. Feed má úplná data, takže
 * odpověď na „jaké má tenhle e-mail číslo" je otázka jednoho dotazu do
 * databáze, ne dohledávání v administraci.
 *
 * Feedy jsou dva druhy a doplňují se:
 *
 *  - **posledních 24 h** — obnovuje se každých pár minut. Malý, rychlý,
 *    a pokrývá to, co člověk zrovna řeší: dnešní objednávky.
 *  - **vše** (zvlášť pro každý trh) — obnovuje se jednou denně. Velký,
 *    ale díky němu se dá dohledat i objednávka stará půl roku.
 *
 * Stahuje se přes `net.fetch`, tedy síťovou vrstvou prohlížeče. Node má
 * jinou TLS stopu a ochrana proti robotům na ni odpovídá 403 — na kontrole
 * odkazů v článcích to už jednou stálo půl dne hledání.
 *
 * Adresy feedů obsahují tajný klíč, takže se ukládají šifrovaně, stejně jako
 * heslo k API.
 */

/* ---------- nastavení ---------- */

const FEEDS_KEY = 'orderFeeds';

/** Trh se odvodí z domény — jinak by ho musel u každého feedu vyplňovat člověk. */
function marketFromUrl(url: string): string {
  if (/\.sk\b/i.test(url)) return 'sk';
  if (/wearquentino\.com|\.com\b/i.test(url)) return 'en';
  if (/\.cz\b/i.test(url)) return 'cz';
  return 'cz';
}

export function getOrderFeeds(): OrderFeed[] {
  const raw = getSetting(FEEDS_KEY, '')!;
  if (!raw) return [];
  try {
    const list = JSON.parse(decrypt(raw)) as OrderFeed[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function saveOrderFeeds(feeds: OrderFeed[]): OrderFeed[] {
  const clean = feeds
    .filter(feed => feed.url.trim())
    .map((feed, index) => ({
      id: feed.id || `feed${index + 1}`,
      label: feed.label.trim() || `Feed ${index + 1}`,
      url: feed.url.trim(),
      market: (feed.market || marketFromUrl(feed.url)).toLowerCase(),
      // Malý feed s posledními 24 h se vyplatí tahat často, velký ne
      everyMinutes: Math.max(5, feed.everyMinutes || 60),
      recent: !!feed.recent,
      enabled: feed.enabled !== false
    }));
  setSetting(FEEDS_KEY, encrypt(JSON.stringify(clean)));
  return clean;
}

/** Adresy nesou tajný klíč — do rozhraní se posílá jen konec, ať je poznat která je která. */
export function feedStatuses(): OrderFeedStatus[] {
  const d = getDb();
  return getOrderFeeds().map(feed => {
    const row = d.prepare(
      'SELECT COUNT(*) AS n, MAX(created_at) AS newest FROM shop_orders WHERE market = ?'
    ).get(feed.market) as any;
    return {
      id: feed.id,
      label: feed.label,
      market: feed.market,
      recent: feed.recent,
      enabled: feed.enabled,
      everyMinutes: feed.everyMinutes,
      urlHint: hint(feed.url),
      orders: row?.n ?? 0,
      newest: row?.newest ?? '',
      lastSync: getSetting(`orderFeedSync:${feed.id}`, '')!,
      lastError: getSetting(`orderFeedError:${feed.id}`, '')!
    };
  });
}

function hint(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}/…${parsed.pathname.slice(-12)}`;
  } catch {
    return url.slice(-24);
  }
}

/* ---------- rozbor XML ---------- */

/**
 * Značky se hledají kdekoli uvnitř objednávky, ne po cestě.
 *
 * Upgates umí strukturu exportu měnit podle toho, co si člověk v nastavení
 * feedu zaškrtne — telefon je jednou v `COMMUNICATION`, jindy přímo
 * u zákazníka. Hledání podle názvu značky přežije obojí; pevná cesta by se
 * rozbila při první změně nastavení a nikdo by nevěděl proč.
 */
function tag(block: string, ...names: string[]): string {
  for (const name of names) {
    const match = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
    if (!match) continue;
    const value = match[1].replace(/^\s*<!\[CDATA\[|\]\]>\s*$/g, '').trim();
    // Vnořený blok není hodnota
    if (/<[a-z_]+[\s>]/i.test(value)) continue;
    if (value) return decodeEntities(value);
  }
  return '';
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#3[49];/g, "'")
    .replace(/&amp;/g, '&');
}

function blocks(xml: string, name: string): string[] {
  return xml.match(new RegExp(`<${name}[^>]*>[\\s\\S]*?</${name}>`, 'gi')) ?? [];
}

/** Telefon do tvaru, na který jde kliknout: bez mezer, s předvolbou. */
export function normalizePhone(raw: string, market = 'cz'): string {
  const clean = (raw ?? '').replace(/[^\d+]/g, '');
  if (!clean) return '';
  if (clean.startsWith('+')) return clean;
  if (clean.startsWith('00')) return `+${clean.slice(2)}`;
  // Devět číslic bez předvolby je česká nebo slovenská mobilní čísla —
  // předvolba se doplní podle trhu, ze kterého objednávka přišla
  if (clean.length === 9) return `${market === 'sk' ? '+421' : '+420'}${clean}`;
  return clean;
}

/**
 * Adresa z bloku `<BILLING>` nebo `<POSTAL>`.
 *
 * Názvy značek se u exportů liší podle stáří šablony (`ZIP_CODE` i `ZIP`,
 * `COUNTRY_ID` i `COUNTRY`), takže se u každého pole zkouší víc variant.
 * Prázdné pole export vynechává úplně — proto se nikde nespoléhá na to, že
 * značka existuje.
 *
 * Vrací `null`, když v bloku není vůbec nic; prázdná adresa v kartě je horší
 * než žádná, protože vypadá jako by se doručovalo nikam.
 */
function parseAddress(block: string): ShopAddress | null {
  const first = tag(block, 'FIRSTNAME', 'FIRST_NAME');
  const last = tag(block, 'SURNAME', 'LASTNAME', 'LAST_NAME');
  const street = [tag(block, 'STREET'), tag(block, 'HOUSENUMBER', 'HOUSE_NUMBER')]
    .filter(Boolean).join(' ');

  const address: ShopAddress = {
    name: [first, last].filter(Boolean).join(' ') || tag(block, 'NAME'),
    company: tag(block, 'COMPANY_NAME', 'COMPANY'),
    street,
    city: tag(block, 'CITY'),
    zip: tag(block, 'ZIP_CODE', 'ZIP', 'POSTCODE'),
    country: tag(block, 'COUNTRY_ID', 'COUNTRY', 'COUNTRY_CODE'),
    state: tag(block, 'STATE')
  };
  return Object.values(address).some(Boolean) ? address : null;
}

export function parseOrders(xml: string, market: string): ShopOrder[] {
  const out: ShopOrder[] = [];
  for (const block of blocks(xml, 'ORDER')) {
    const code = tag(block, 'CODE', 'ORDER_NUMBER');
    if (!code) continue;

    const items: ShopOrderItem[] = blocks(block, 'ITEM').map(item => ({
      title: tag(item, 'TITLE', 'NAME'),
      code: tag(item, 'CODE', 'PRODUCT_CODE'),
      quantity: Number(tag(item, 'QUANTITY')) || 1,
      price: Number(tag(item, 'PRICE_WITH_VAT', 'PRICE')) || 0
    })).filter(item => item.title || item.code);

    // Doprava a platba mají uvnitř svůj vlastní NAME — mimo tyhle bloky by
    // se `tag(block, 'NAME')` chytlo prvního výskytu, ať patří komukoli
    const shipmentBlock = blocks(block, 'SHIPMENT')[0] ?? '';
    const paymentBlock = blocks(block, 'PAYMENT')[0] ?? '';
    const customerBlock = blocks(block, 'CUSTOMER')[0] ?? block;

    const first = tag(customerBlock, 'FIRSTNAME', 'FIRST_NAME');
    const last = tag(customerBlock, 'SURNAME', 'LASTNAME', 'LAST_NAME');

    /*
     * Adresy. Hledají se uvnitř `<ADDRESSES>`, ne v celé objednávce: `<STREET>`
     * je v obou blocích a bez ohraničení by se fakturační ulice vydávala za
     * doručovací. Když blok `<ADDRESSES>` chybí (starší export), zkusí se
     * i přímo v objednávce.
     */
    const addresses = blocks(block, 'ADDRESSES')[0] ?? block;
    const billingBlock = blocks(addresses, 'BILLING')[0] ?? '';
    const postalBlock = blocks(addresses, 'POSTAL')[0]
      ?? blocks(addresses, 'DELIVERY')[0] ?? '';

    out.push({
      code,
      market,
      status: tag(block, 'STATUS'),
      paid: tag(block, 'PAID_YN') === '1',
      paidDate: tag(block, 'PAID_DATE'),
      resolved: tag(block, 'RESOLVED_YN') === '1',
      invoice: tag(block, 'INVOICE_NUMBER'),
      createdAt: tag(block, 'CREATION_TIME', 'CREATED_AT'),
      updatedAt: tag(block, 'LAST_UPDATE_TIME', 'UPDATED_AT'),
      currency: tag(block, 'CURRENCY', 'CURRENCY_ID'),
      total: Number(tag(block, 'TOTAL_PRICE_WITH_VAT', 'TOTAL_WITH_VAT')) || 0,
      tracking: tag(block, 'TRACING_CODE', 'TRACKING_CODE'),
      customerId: tag(customerBlock, 'CUSTOMER_ID'),
      name: [first, last].filter(Boolean).join(' '),
      email: tag(customerBlock, 'EMAIL').toLowerCase(),
      phone: normalizePhone(tag(customerBlock, 'PHONE'), market),
      shipment: tag(shipmentBlock, 'NAME'),
      payment: tag(paymentBlock, 'NAME'),
      items,
      billing: parseAddress(billingBlock),
      postal: parseAddress(postalBlock)
    });
  }
  return out;
}

/* ---------- stahování ---------- */

function save(orders: ShopOrder[]): number {
  const d = getDb();
  const now = new Date().toISOString();
  const stmt = d.prepare(`
    INSERT INTO shop_orders (code, market, status, paid, paid_date, resolved, invoice,
      created_at, updated_at, currency, total, tracking, customer_id, name, email, phone,
      shipment, payment, items_json, billing_json, postal_json, seen_at)
    VALUES (@code, @market, @status, @paid, @paidDate, @resolved, @invoice,
      @createdAt, @updatedAt, @currency, @total, @tracking, @customerId, @name, @email, @phone,
      @shipment, @payment, @items, @billing, @postal, @seen)
    ON CONFLICT(code, market) DO UPDATE SET
      status = excluded.status, paid = excluded.paid, paid_date = excluded.paid_date,
      resolved = excluded.resolved, invoice = excluded.invoice,
      updated_at = excluded.updated_at, total = excluded.total, tracking = excluded.tracking,
      name = excluded.name, email = excluded.email,
      -- Telefon se přepíše jen tehdy, když nový za něco stojí. Feed
      -- s posledními 24 h ho občas nemá vyplněný a přepsat tím dobré číslo
      -- prázdnou hodnotou by znamenalo ztratit jediné, co jsme o zákazníkovi
      -- potřebovali.
      phone = CASE WHEN excluded.phone <> '' THEN excluded.phone ELSE shop_orders.phone END,
      shipment = excluded.shipment, payment = excluded.payment,
      items_json = excluded.items_json, seen_at = excluded.seen_at,
      -- Adresu přepisuje jen ta, která za něco stojí. Rychlý feed s posledními
      -- 24 h ji nemusí nést vůbec a prázdnou hodnotou by se ztratila.
      billing_json = CASE WHEN excluded.billing_json IS NOT NULL
        THEN excluded.billing_json ELSE shop_orders.billing_json END,
      postal_json = CASE WHEN excluded.postal_json IS NOT NULL
        THEN excluded.postal_json ELSE shop_orders.postal_json END
  `);

  const write = d.transaction((list: ShopOrder[]) => {
    for (const order of list) {
      stmt.run({
        code: order.code, market: order.market, status: order.status,
        paid: order.paid ? 1 : 0, paidDate: order.paidDate, resolved: order.resolved ? 1 : 0,
        invoice: order.invoice, createdAt: order.createdAt, updatedAt: order.updatedAt,
        currency: order.currency, total: order.total, tracking: order.tracking,
        customerId: order.customerId, name: order.name, email: order.email, phone: order.phone,
        shipment: order.shipment, payment: order.payment,
        items: JSON.stringify(order.items),
        billing: order.billing ? JSON.stringify(order.billing) : null,
        postal: order.postal ? JSON.stringify(order.postal) : null,
        seen: now
      });
    }
  });
  write(orders);
  return orders.length;
}

async function download(url: string): Promise<string> {
  const fetcher: typeof fetch = (net as any)?.fetch ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const res = await fetcher(url, { redirect: 'follow', signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

export async function refreshFeed(id: string): Promise<{ orders: number }> {
  const feed = getOrderFeeds().find(item => item.id === id);
  if (!feed) throw new Error('Feed objednávek nenalezen.');
  try {
    const xml = await download(feed.url);
    const orders = parseOrders(xml, feed.market);
    if (orders.length === 0 && !/<ORDERS?\b/i.test(xml)) {
      throw new Error('Odpověď nevypadá jako export objednávek.');
    }
    save(orders);
    setSetting(`orderFeedSync:${feed.id}`, new Date().toISOString());
    setSetting(`orderFeedError:${feed.id}`, '');
    return { orders: orders.length };
  } catch (e: any) {
    setSetting(`orderFeedError:${feed.id}`, e.message ?? String(e));
    throw e;
  }
}

/**
 * Obnova všech feedů, které mají čas.
 *
 * Pouští to plánovač každou minutu, takže se tu jen rozhoduje, na který
 * feed už došlo. Chyba jednoho nesmí zastavit ostatní — velký feed může být
 * chvíli nedostupný a přitom ten malý s dnešními objednávkami funguje.
 */
/**
 * Kolik vteřin se počká po celé značce, než se sáhne pro soubor.
 *
 * E-shop soubor v tu chvíli teprve zapisuje; stažení přesně v :05:00 by
 * vrátilo ten předchozí.
 */
const FEED_GRACE_MS = 40_000;

/**
 * Je feed na řadě?
 *
 * Nepočítá se od posledního stažení, ale podle skutečného času. E-shop
 * přegenerovává soubor v pevných značkách — pětiminutový v :00, :05, :10 —
 * takže „naposledy plus pět minut" znamená trvalé opoždění: stáhne se ve
 * 12:03, další pokus ve 12:08, ale to je pořád soubor z 12:05. Takhle se
 * místo toho pozná, že přibyla nová značka, a stahuje se hned po ní.
 *
 * U feedů delších než hodina (celý export jednou denně) na značky nezáleží
 * a rozhoduje prostý odstup.
 */
export function feedDue(everyMinutes: number, lastRun: string, now = Date.now()): boolean {
  const period = Math.max(1, everyMinutes) * 60_000;
  if (!lastRun) return true;
  const last = new Date(lastRun).getTime();
  if (!Number.isFinite(last)) return true;

  // Hodiny na počítači se dají posunout; budoucí značka by jinak feed zamkla
  if (last > now) return true;

  if (period > 3_600_000) return now - last >= period;
  const slot = (t: number) => Math.floor((t - FEED_GRACE_MS) / period);
  return slot(now) > slot(last);
}

export async function refreshDueFeeds(force = false): Promise<{ feed: string; orders: number; error?: string }[]> {
  const out: { feed: string; orders: number; error?: string }[] = [];
  for (const feed of getOrderFeeds()) {
    if (!feed.enabled) continue;
    const last = getSetting(`orderFeedSync:${feed.id}`, '')!;
    if (!force && !feedDue(feed.everyMinutes, last)) continue;
    try {
      const result = await refreshFeed(feed.id);
      out.push({ feed: feed.label, orders: result.orders });
    } catch (e: any) {
      out.push({ feed: feed.label, orders: 0, error: e.message });
    }
  }
  return out;
}

/**
 * Obnova feedů před sestavením seznamu k balení.
 *
 * Rychlý feed s posledními 24 h se sahá vždycky — právě o dnešní objednávky
 * při balení jde. Kompletní exporty se tahají jen tehdy, když okno sahá dál
 * než den; jsou velké a stejně se přegenerovávají jednou denně, takže by je
 * každé otevření okna stahovalo zbytečně.
 *
 * Chyba se polyká: bez sítě se má seznam poskládat z toho, co je uložené,
 * ne se neotevřít.
 */
export async function refreshForPacking(days: number, force = false): Promise<void> {
  const wanted = getOrderFeeds().filter(f => f.enabled && (f.recent || days > 1));
  for (const feed of wanted) {
    const last = getSetting(`orderFeedSync:${feed.id}`, '')!;
    if (!force && !feedDue(feed.everyMinutes, last)) continue;
    try { await refreshFeed(feed.id); } catch { /* seznam se poskládá z uloženého */ }
  }
}

/**
 * Objednávky za posledních `days` dní, jak je vede feed.
 *
 * Řadí se podle vzniku, ne podle poslední změny: při balení se jde odshora
 * a nejstarší nezabalená objednávka nesmí spadnout dolů jen proto, že se
 * u ní něco přepsalo.
 */
export function ordersSince(days: number, limit = 400): ShopOrder[] {
  const since = new Date(Date.now() - Math.max(1, days) * 86_400_000).toISOString();
  const rows = getDb().prepare(
    `SELECT * FROM shop_orders WHERE created_at >= ? ORDER BY created_at DESC LIMIT ?`
  ).all(since, limit) as any[];
  return rows.map(toOrder);
}

/* ---------- dotazy ---------- */

function toOrder(row: any): ShopOrder {
  return {
    code: row.code, market: row.market, status: row.status,
    paid: row.paid === 1, paidDate: row.paid_date, resolved: row.resolved === 1,
    invoice: row.invoice, createdAt: row.created_at, updatedAt: row.updated_at,
    currency: row.currency, total: row.total, tracking: row.tracking,
    customerId: row.customer_id, name: row.name, email: row.email, phone: row.phone,
    shipment: row.shipment, payment: row.payment,
    items: safeItems(row.items_json),
    billing: safeAddress(row.billing_json),
    postal: safeAddress(row.postal_json)
  };
}

function safeAddress(json: string | null): ShopAddress | null {
  try {
    const value = JSON.parse(json ?? 'null');
    return value && typeof value === 'object' ? value as ShopAddress : null;
  } catch {
    return null;
  }
}

function safeItems(json: string): ShopOrderItem[] {
  try {
    const list = JSON.parse(json ?? '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function ordersByEmail(email: string, limit = 12): ShopOrder[] {
  const clean = (email ?? '').trim().toLowerCase();
  if (!clean) return [];
  return (getDb().prepare(
    'SELECT * FROM shop_orders WHERE email = ? ORDER BY created_at DESC LIMIT ?'
  ).all(clean, limit) as any[]).map(toOrder);
}

/**
 * Objednávka podle čísla.
 *
 * Čísla se mezi trhy opakují, takže když se najde víc shod, vrací se
 * nejnovější — v drtivé většině případů je to ta, o které je řeč.
 */
export function orderByCode(code: string): ShopOrder | null {
  const clean = (code ?? '').trim().replace(/^#/, '');
  if (!clean) return null;
  const row = getDb().prepare(
    `SELECT * FROM shop_orders WHERE code = ? OR code = ?
     ORDER BY created_at DESC LIMIT 1`
  ).get(clean, clean.replace(/^0+/, '')) as any;
  return row ? toOrder(row) : null;
}

/**
 * Kontakt na zákazníka — to hlavní, kvůli čemu se feedy tahají.
 *
 * Hledá se nejdřív podle čísla objednávky (to je jednoznačné), pak podle
 * e-mailu. Vrací se i to, odkud číslo pochází, aby bylo v rozhraní vidět,
 * že se nevzalo odnikud.
 */
export function contactFor(input: { email?: string; orderCode?: string }): {
  phone: string;
  name: string;
  order: ShopOrder | null;
  orders: number;
} {
  if (input.orderCode) {
    const order = orderByCode(input.orderCode);
    if (order?.phone) {
      return { phone: order.phone, name: order.name, order, orders: 1 };
    }
    // Objednávka bez telefonu ještě neznamená smůlu — ten samý zákazník
    // mohl telefon vyplnit u jiné objednávky
    if (order?.email) {
      const list = ordersByEmail(order.email);
      const withPhone = list.find(item => item.phone);
      return {
        phone: withPhone?.phone ?? '', name: order.name || withPhone?.name || '',
        order, orders: list.length
      };
    }
  }

  if (input.email) {
    const list = ordersByEmail(input.email);
    const withPhone = list.find(item => item.phone);
    return {
      phone: withPhone?.phone ?? '',
      name: withPhone?.name ?? list[0]?.name ?? '',
      order: list[0] ?? null,
      orders: list.length
    };
  }

  return { phone: '', name: '', order: null, orders: 0 };
}

/** Čísla objednávek zmíněná v textu — do chatu, kde je zákazník píše do zprávy. */
export function codesInText(text: string): string[] {
  const found = new Set<string>();
  for (const match of (text ?? '').matchAll(/\b(?:č\.|c\.|no\.|nr\.|#)?\s*(\d{5,10})\b/gi)) {
    found.add(match[1]);
  }
  return [...found].slice(0, 5);
}

/**
 * Kontakt podle toho, co je po ruce: e-mail, číslo objednávky nebo text
 * zprávy, ve kterém může číslo být zmíněné.
 */
export function lookupContact(input: { email?: string; orderCode?: string; text?: string }) {
  const direct = contactFor({ email: input.email, orderCode: input.orderCode });
  if (direct.phone) return { ...direct, via: input.orderCode ? 'podle objednávky' : 'podle e-mailu' };

  for (const code of codesInText(input.text ?? '')) {
    const found = contactFor({ orderCode: code });
    if (found.phone) return { ...found, via: `podle čísla ${code} ze zprávy` };
  }
  return { ...direct, via: direct.orders ? 'podle e-mailu' : '' };
}

export function orderStats(): { total: number; withPhone: number; markets: { market: string; n: number }[] } {
  const d = getDb();
  const total = (d.prepare('SELECT COUNT(*) AS n FROM shop_orders').get() as any)?.n ?? 0;
  const withPhone = (d.prepare(`SELECT COUNT(*) AS n FROM shop_orders WHERE phone <> ''`).get() as any)?.n ?? 0;
  const markets = d.prepare(
    'SELECT market, COUNT(*) AS n FROM shop_orders GROUP BY market ORDER BY n DESC'
  ).all() as { market: string; n: number }[];
  return { total, withPhone, markets };
}
