import type { OrderTracking, ShipmentEvent, CarrierId } from '../shared/types';

/**
 * Živý stav objednávky a zásilky bez Upgates API.
 *
 * Zdroje jsou dva veřejné a server-renderované:
 *  1) stránka „historie objednávky", jejíž odkaz je přímo v potvrzovacím mailu
 *     — dá stav objednávky, datum zaplacení, telefon zákazníka a odkaz na dopravce,
 *  2) stránka dopravce podle tracking kódu — dá poslední stav zásilky.
 *
 * Obojí se čte přes převod HTML na text a hledání dvojic „štítek: hodnota",
 * ne přes konkrétní značky. Redesign šablony to tedy většinou přežije a když ne,
 * funkce vrátí null a karta se prostě zobrazí bez živých dat.
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';
const TIMEOUT = 12_000;

/**
 * Někteří dopravci (PPL, DPD…) dotahují výpis zásilky až JavaScriptem, takže
 * v holém HTML nic není. Pro ně si main proces zaregistruje funkci, která
 * stránku načte ve skrytém okně a vrátí až hotové DOM. Modul samotný o Electronu
 * nic neví, aby se dal testovat samostatně.
 */
type HtmlRenderer = (url: string, waitFor?: string) => Promise<string | null>;
let renderHtml: HtmlRenderer | null = null;

export function setHtmlRenderer(fn: HtmlRenderer): void {
  renderHtml = fn;
}

async function getText(url: string): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, 'Accept-Language': 'cs,sk;q=0.9,en;q=0.8' }
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- HTML → řádky textu ----------

function decodeEntities(s: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => named[n.toLowerCase()] ?? m);
}

/** Blokové značky se lámou na řádky, inline (span, strong, a) zůstávají v řádku. */
function toLines(html: string): string[] {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<\s*br\s*\/?>/gi, '\n')
      .replace(/<\/\s*(p|div|tr|td|th|h[1-6]|li|section|article|dt|dd|table)\s*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/ /g, ' ')
    .split('\n')
    .map(l => l.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean);
}

/** Najde hodnotu k štítku — buď za dvojtečkou na stejném řádku, nebo na následujícím. */
function labelValue(lines: string[], labels: string[]): string | null {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  for (let i = 0; i < lines.length; i++) {
    const l = norm(lines[i]);
    for (const lab of labels) {
      const k = norm(lab);
      if (!l.startsWith(k)) continue;
      const after = lines[i].slice(lab.length).replace(/^\s*:\s*/, '').trim();
      if (after) return after;
      const next = lines[i + 1]?.trim();
      // Následující řádek nesmí být zase štítek
      if (next && !/^[^:]{1,28}:$/.test(next)) return next;
    }
  }
  return null;
}

// ---------- dopravci ----------

interface Carrier {
  id: CarrierId;
  name: string;
  /** Podle názvu dopravy v objednávce nebo domény tracking odkazu */
  match: RegExp;
  host?: RegExp;
  url: (code: string) => string;
  /** Kód se u některých dopravců píše s mezerami, do URL patří bez nich */
  normalize?: (code: string) => string;
  /** Vypisuje dopravce stav rovnou do HTML, nebo ho dotahuje až JavaScriptem? */
  needsJs: boolean;
}

const CARRIERS: Carrier[] = [
  {
    id: 'packeta', name: 'Zásilkovna',
    match: /z[áa]silkovn|packeta|z-?box/i, host: /packeta\.com|zasilkovna\.cz/i,
    url: c => `https://tracking.packeta.com/cs/tracking/search?id=${encodeURIComponent(c)}`,
    normalize: c => c.replace(/\s+/g, ''),
    needsJs: false
  },
  {
    id: 'ppl', name: 'PPL',
    match: /\bppl\b|parcelshop|parcelbox/i, host: /ppl\.cz|ppl\.sk/i,
    // Starý odkaz main2.aspx?cls=Package&idSearch= e-shop pořád používá, sám se přesměruje sem
    url: c => `https://www.ppl.cz/vyhledat-zasilku?shipmentId=${encodeURIComponent(c)}`,
    normalize: c => c.replace(/\s+/g, ''),
    needsJs: true
  },
  {
    id: 'cpost', name: 'Česká pošta',
    match: /česk[áé] po[šs]t|bal[íi]kovn|post[aá] ?online|balik(do|na)|npb/i,
    host: /postaonline\.cz|ceskaposta\.cz|cpost\.cz|balikovna\.cz/i,
    url: c => `https://www.postaonline.cz/trackandtrace/-/zasilka/cislo?parcelNumbers=${encodeURIComponent(c)}`,
    normalize: c => c.replace(/\s+/g, ''),
    needsJs: false
  },
  {
    id: 'dpd', name: 'DPD',
    match: /\bdpd\b/i, host: /dpd(group)?\.(cz|com|sk)/i,
    url: c => `https://www.dpdgroup.com/cz/mydpd/my-parcels/incoming?parcelNumber=${encodeURIComponent(c)}`,
    normalize: c => c.replace(/\s+/g, ''),
    needsJs: true
  },
  {
    id: 'gls', name: 'GLS',
    match: /\bgls\b/i, host: /gls-group\.(eu|com)/i,
    url: c => `https://gls-group.eu/CZ/cs/sledovani-zasilek?match=${encodeURIComponent(c)}`,
    normalize: c => c.replace(/\s+/g, ''),
    needsJs: true
  },
  {
    id: 'dhl', name: 'DHL',
    match: /\bdhl\b/i, host: /dhl\.com/i,
    url: c => `https://www.dhl.com/cz-cs/home/tracking/tracking-parcel.html?tracking-id=${encodeURIComponent(c)}`,
    normalize: c => c.replace(/\s+/g, ''),
    needsJs: true
  },
  {
    id: 'wedo', name: 'WEDO',
    match: /wedo|ulo[žz]enk/i, host: /wedo\.cz|ulozenka\.cz/i,
    url: c => `https://www.wedo.cz/sledovani-zasilky?code=${encodeURIComponent(c)}`,
    normalize: c => c.replace(/\s+/g, ''),
    needsJs: true
  }
];

/** Určí dopravce podle názvu dopravy, odkazu na tracking nebo tvaru kódu. */
export function detectCarrier(shipmentName: string | null, trackingUrl: string | null, code: string | null): Carrier | null {
  if (trackingUrl) {
    let host = '';
    try { host = new URL(trackingUrl).hostname; } catch { /* neplatná URL, zkusíme dál */ }
    const byHost = CARRIERS.find(c => c.host && c.host.test(host));
    if (byHost) return byHost;
  }
  if (shipmentName) {
    const byName = CARRIERS.find(c => c.match.test(shipmentName));
    if (byName) return byName;
  }
  // Zásilkovna má charakteristické „Z 450 7169 485"
  if (code && /^z\s?\d[\d\s]{7,}$/i.test(code.trim())) return CARRIERS[0];
  return null;
}

// ---------- stránka historie objednávky ----------

const pageCache = new Map<string, { at: number; data: OrderTracking | null }>();
const PAGE_TTL = 5 * 60_000;
/** U doručených, stornovaných a vrácených objednávek se stav už nemění */
const PAGE_TTL_FINAL = 30 * 86_400_000;

/** Konečný stav objednávky — nemá smysl ho znovu ověřovat ani u e-shopu, ani u dopravce. */
export function isFinalStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  return /doru[čc]en|vyzvednut|dokon[čc]en|uzav[řr]en|storn|zru[šs]en|vr[áa]cen|odstoup|reklamac|complete|delivered|cancel|refund/i
    .test(status);
}

/**
 * Přečte veřejnou stránku „historie objednávky" (odkaz je v každém potvrzovacím
 * mailu). Vrací stav, zaplacení, telefon a odkaz na sledování zásilky.
 */
export async function readOrderPage(historyUrl: string): Promise<OrderTracking | null> {
  const hit = pageCache.get(historyUrl);
  if (hit) {
    const ttl = isFinalStatus(hit.data?.status) ? PAGE_TTL_FINAL : PAGE_TTL;
    if (Date.now() - hit.at < ttl) return hit.data;
  }

  const html = await getText(historyUrl);
  if (!html) {
    pageCache.set(historyUrl, { at: Date.now(), data: null });
    return null;
  }
  const lines = toLines(html);

  const status = labelValue(lines, ['Stav objednávky', 'Stav objednávok', 'Order status', 'Status objednávky']);
  const createdAt = labelValue(lines, ['Vytvořeno', 'Vytvorené', 'Created']);
  const paidDate = labelValue(lines, ['Zaplaceno', 'Zaplatené', 'Paid']);
  const phone = labelValue(lines, ['Telefon', 'Telefón', 'Phone']);

  // Odkaz na dopravce — v šabloně stojí u štítku „Sledování zásilky"
  let trackingUrl: string | null = null;
  let trackingCode: string | null = null;
  let shipmentName: string | null = null;
  // Každý dopravce si pojmenovává parametr po svém: Zásilkovna id, PPL idSearch,
  // Česká pošta parcelNumbers… proto se bere první, který v odkazu je.
  const CODE_PARAMS = ['id', 'idSearch', 'shipmentId', 'parcelNumbers', 'parcelNumber', 'match', 'tracking-id', 'code', 'cislo'];
  const hrefs = [...html.matchAll(/href="([^"]+)"/gi)].map(m => decodeEntities(m[1]));
  const carrierLink = hrefs.find(h => CARRIERS.some(c => c.host && c.host.test(h)));
  if (carrierLink) {
    try {
      // Odkaz může být i relativní — základem je pak stránka objednávky
      const u = new URL(carrierLink, historyUrl);
      trackingUrl = u.toString();
      for (const p of CODE_PARAMS) {
        const v = u.searchParams.get(p);
        if (v && /\d/.test(v)) { trackingCode = v; break; }
      }
      trackingCode = trackingCode ?? (u.pathname.match(/\/([A-Z]{0,2}\d[\d\s]{6,}[A-Z]?)\/?$/i) ?? [])[1] ?? null;
    } catch {
      trackingUrl = carrierLink; // neparsovatelný odkaz aspoň nabídneme k otevření
    }
  }
  shipmentName = labelValue(lines, ['Sledování zásilky', 'Sledovanie zásielky', 'Shipment tracking']);
  if (shipmentName && (/^https?:/i.test(shipmentName) || shipmentName.length > 60)) shipmentName = null;

  const data: OrderTracking = {
    source: 'page',
    shipmentError: null,
    status: status && status.length < 60 ? status : null,
    createdAt: createdAt ?? null,
    paidDate: paidDate && !/^ne/i.test(paidDate) ? paidDate : null,
    customerPhone: phone && /\d{6,}/.test(phone) ? phone : null,
    carrierId: null,
    carrierName: null,
    trackingCode: trackingCode ? trackingCode.trim() : null,
    trackingUrl,
    shipment: null
  };

  const carrier = detectCarrier(shipmentName, trackingUrl, data.trackingCode);
  if (carrier) {
    data.carrierId = carrier.id;
    // E-shop pojmenovává dopravu přesněji než my („PPL ParcelBox", „Zásilkovna Výdejní místo")
    data.carrierName = shipmentName ?? carrier.name;
    // Odkaz z e-shopu bývá zastaralý nebo obsahuje kód s mezerami — přestavíme ho načisto
    if (data.trackingCode) {
      data.trackingUrl = carrier.url(carrier.normalize?.(data.trackingCode) ?? data.trackingCode);
    }
  }

  pageCache.set(historyUrl, { at: Date.now(), data });
  return data;
}

// ---------- stránka dopravce ----------

const DATE_RE = /(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4})(?:\s+(\d{1,2})[:.](\d{2}))?/;
const DATE_LINE = new RegExp(`^${DATE_RE.source}$`);
const DATE_TAIL = new RegExp(`^(.*?)\\s+(${DATE_RE.source})$`);
/** Nadpis, za kterým začíná výpis událostí — ať se nechytí datum z patičky nebo reklamy */
const HISTORY_WORDS = 'cesta z[áa]silk|historie z[áa]silk|stav z[áa]silk|stav a pohyb|priebeh|tracking history|shipment history'
  + '|pohyb z[áa]silk|datum a [čc]as|d[áa]tum a [čc]as|sledov[áa]n[ií] z[áa]silk|informace o z[áa]silce|ud[áa]losti|pr[ůu]b[ěe]h';
const HISTORY_HEAD = new RegExp(`^(${HISTORY_WORDS})`, 'i');

function parseCzDate(s: string): number | null {
  const m = s.match(DATE_LINE);
  if (!m) return null;
  const t = new Date(+m[3], +m[2] - 1, +m[1], +(m[4] ?? 0), +(m[5] ?? 0)).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * Popis stavu, ne nadpis tabulky ani samotné datum.
 *
 * Délka musí být benevolentní — dopravci hlásí i „Doručeno" nebo „Na cestě",
 * což je osm znaků a míň. Vyloučí se proto jen věci, které popisem zjevně
 * nejsou: datum, samotný čas, číslo zásilky, nadpis sloupce.
 */
function looksLikeDescription(s: string | undefined): s is string {
  if (!s) return false;
  const t = s.trim();
  if (t.length < 4 || t.length > 200) return false;
  if (DATE_LINE.test(t) || HISTORY_HEAD.test(t)) return false;
  if (/^[\d\s.,:/-]+$/.test(t)) return false;          // čísla, časy, kódy
  if (/^\d{1,2}[:.]\d{2}$/.test(t)) return false;      // samotný čas
  return /\p{L}{3,}/u.test(t);                          // musí obsahovat slovo
}

const shipCache = new Map<string, { at: number; ev: ShipmentEvent | null }>();
const SHIP_TTL = 10 * 60_000;

/**
 * Poslední záznam z cesty zásilky.
 *
 * Dopravci se liší úplně ve všem: Zásilkovna dává popis nad datum a nejnovější
 * nahoru, PPL má tabulku „Datum a čas | Stav zásilky" a nejnovější dole. Proto
 * se posbírají všechny dvojice datum + popis a vybere se ta s nejnovějším časem —
 * na pořadí ani směru pak nezáleží.
 */
export async function readShipmentStatus(
  carrierId: CarrierId, code: string, url: string, useRenderer = false, force = false
): Promise<ShipmentEvent | null> {
  // Vykreslený a nevykreslený pokus mají vlastní cache — jinak by prázdný
  // výsledek z holého HTML zablokoval i pozdější načtení přes skryté okno
  const key = `${carrierId}:${code}:${useRenderer ? 'js' : 'raw'}`;
  const hit = shipCache.get(key);
  if (hit && !force) {
    // Neúspěch se drží krátce, ať „Zkusit znovu" opravdu zkusí znovu
    const ttl = hit.ev ? SHIP_TTL : 60_000;
    if (Date.now() - hit.at < ttl) return hit.ev;
  }

  const html = useRenderer && renderHtml
    ? await renderHtml(url, HISTORY_WORDS)
    : await getText(url);
  if (!html) {
    shipCache.set(key, { at: Date.now(), ev: null });
    return null;
  }
  const lines = toLines(html);

  // Když stránka má nadpis výpisu, bereme jen to za ním — jinak by se chytla
  // data z otevírací doby pobočky nebo z reklamních bannerů.
  const headIdx = lines.findIndex(l => HISTORY_HEAD.test(l));
  const from = headIdx >= 0 ? headIdx : 0;
  const horizon = Date.now() + 36 * 3600_000;

  // Popis stojí buď nad datem (Zásilkovna: „popis / datum"), nebo pod ním
  // (PPL: tabulka „datum | stav"). U jednotlivé události to nejde rozlišit,
  // protože oba sousedi bývají texty — pořadí se proto určí jednou za stránku
  // podle toho, co ve výpisu přijde první.
  let descFirst = true;
  for (let i = from; i < lines.length; i++) {
    if (HISTORY_HEAD.test(lines[i])) continue;
    if (parseCzDate(lines[i]) !== null) { descFirst = false; break; }
    if (looksLikeDescription(lines[i])) { descFirst = true; break; }
  }

  const events: { ts: number; ev: ShipmentEvent }[] = [];
  for (let i = from; i < lines.length; i++) {
    const line = lines[i];

    const ts = parseCzDate(line);
    if (ts !== null) {
      const near = descFirst ? lines[i - 1] : lines[i + 1];
      const far = descFirst ? lines[i + 1] : lines[i - 1];
      const desc = looksLikeDescription(near) ? near : looksLikeDescription(far) ? far : null;
      if (desc && ts <= horizon) events.push({ ts, ev: { description: desc, at: line } });
      continue;
    }
    const tail = line.match(DATE_TAIL);
    if (tail && looksLikeDescription(tail[1].trim())) {
      const t = parseCzDate(tail[2]);
      if (t !== null && t <= horizon) events.push({ ts: t, ev: { description: tail[1].trim(), at: tail[2] } });
    }
  }

  const newest = events.sort((a, b) => b.ts - a.ts)[0] ?? null;
  const ev = newest ? newest.ev : null;

  // Zařazení do fáze kvůli barevnému odlišení. Pravidla a naučené hlášky jsou
  // zadarmo, AI se ptáme jen na hlášku, kterou ještě nikdo neviděl.
  if (ev) {
    try {
      const { classifyShipment } = await import('./shipphase');
      ev.phase = await classifyShipment(`${ev.stage ?? ''} ${ev.description}`.trim());
    } catch { /* bez zařazení se ukáže jen text */ }
  }

  // Zásilkovna má nad výpisem ještě souhrnnou fázi („2. Zásilka je na cestě")
  const stage = lines.find(l => /^\d\.\s+\S.{4,60}$/.test(l) && !DATE_LINE.test(l));
  if (ev && stage) ev.stage = stage.replace(/^\d\.\s*/, '');

  shipCache.set(key, { at: Date.now(), ev });
  return ev;
}

/** Vyprázdní cache — po ručním obnovení karty. */
export function clearTrackingCache(): void {
  pageCache.clear();
  shipCache.clear();
}

/** Kompletní živá data: stránka objednávky + poslední stav zásilky. */
export async function liveTracking(historyUrl: string | null, fallback: {
  shipmentName: string | null; trackingCode: string | null; trackingUrl: string | null;
}, withRendered = false, force = false): Promise<OrderTracking | null> {
  let data: OrderTracking | null = historyUrl ? await readOrderPage(historyUrl) : null;

  // Bez stránky historie (nebo když nic nevrátila) zkusíme aspoň dopravce z Upgates API
  if (!data && (fallback.trackingCode || fallback.trackingUrl)) {
    const c = detectCarrier(fallback.shipmentName, fallback.trackingUrl, fallback.trackingCode);
    data = {
      source: 'api',
      shipmentError: null,
      status: null, createdAt: null, paidDate: null, customerPhone: null,
      carrierId: c?.id ?? null,
      carrierName: c?.name ?? null,
      trackingCode: fallback.trackingCode,
      trackingUrl: fallback.trackingUrl
        ?? (c && fallback.trackingCode ? c.url(c.normalize?.(fallback.trackingCode) ?? fallback.trackingCode) : null),
      shipment: null
    };
  }
  if (!data) return null;

  const carrier = CARRIERS.find(c => c.id === data!.carrierId);
  if (!carrier || !data.trackingCode || !data.trackingUrl) return data;


  if (withRendered) {
    // Druhá fáze: stránka se načte ve skrytém okně včetně JavaScriptu. Dělá se
    // to u každého dopravce, ne jen u těch označených — i stránka, která část
    // obsahu vypisuje rovnou, může výpis zásilky dokreslovat až doběhem skriptů.
    try {
      data.shipment = await readShipmentStatus(carrier.id, data.trackingCode, data.trackingUrl, true, force);
      if (!data.shipment) data.shipmentError = 'Stránku dopravce se nepodařilo přečíst';
    } catch {
      data.shipmentError = 'Dopravce je nedostupný';
    }
    return data;
  }

  // První fáze: jen rychlé stažení, a to jen tam, kde má smysl.
  if (!carrier.needsJs) {
    try {
      data.shipment = await readShipmentStatus(carrier.id, data.trackingCode, data.trackingUrl, false);
    } catch { /* zkusí se znovu ve druhé fázi */ }
  }
  return data;
}
