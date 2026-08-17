import { getDb, getSetting } from './db';
import { getMessageFull } from './imap';
import { upgatesConfigured, orderLive } from './upgates';
import { parseOrderEmail } from './orderparse';
import { DEFAULT_FEED_URL } from './products';
import { liveTracking, isFinalStatus } from './ordertrack';
import type { OrderCard, OrderCardItem, MailLang, OrderBadge } from '../shared/types';

export { parseOrderEmail };

/**
 * Parser potvrzení objednávky (Upgates e-mailová šablona) — CZ / SK / EN.
 *
 * Čte se čistě z těla e-mailu (funguje offline i bez API), položky se pak
 * spárují s lokálním produktovým feedem kvůli obrázkům a odkazům a případně
 * se doplní živý stav objednávky z Upgates API.
 */

// ---------- párování s produktovým feedem ----------

const LANGS: MailLang[] = ['cz', 'sk', 'en'];

function slugOf(url: string | null): string | null {
  if (!url) return null;
  const m = url.match(/\/p\/([^/?#]+)/i) ?? url.match(/\/([^/?#]+)\/?$/);
  return m ? m[1].toLowerCase() : null;
}

/** Doplní obrázek, kanonickou URL a aktuální cenu z tabulky products. */
export function matchItemsToFeed(items: OrderCardItem[], lang: MailLang): void {
  if (items.length === 0) return;
  const d = getDb();
  const byCode = d.prepare('SELECT * FROM products WHERE lower(code) = lower(?)');
  const all = () => d.prepare('SELECT * FROM products').all() as any[];
  let cache: any[] | null = null;

  for (const it of items) {
    let row: any = null;
    if (it.code) row = byCode.get(it.code.trim()) ?? null;

    if (!row && it.url) {
      const slug = slugOf(it.url);
      if (slug) {
        cache = cache ?? all();
        row = cache.find(r => LANGS.some(l => slugOf(r[`url_${l}`]) === slug)) ?? null;
      }
    }
    if (!row && it.title) {
      cache = cache ?? all();
      const t = it.title.trim().toLowerCase();
      row = cache.find(r => LANGS.some(l => (r[`title_${l}`] ?? '').trim().toLowerCase() === t)) ?? null;
    }
    if (!row) continue;

    const pick = (field: string) =>
      row[`${field}_${lang}`] || row[`${field}_cz`] || row[`${field}_sk`] || row[`${field}_en`] || null;

    it.matched = true;
    it.image = row.image ?? null;
    it.feedUrl = pick('url');
    it.feedPrice = pick('price');
    if (!it.code) it.code = row.code;
    if (!it.title) it.title = pick('title') ?? '';
  }
}

// ---------- kontrola, že objednávka je z našeho e-shopu ----------

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; }
}

/** „quentino.cz" → „quentino"; podle toho se poznají i .sk a .com mutace */
function baseLabel(host: string): string {
  const parts = host.split('.');
  return (parts.length > 2 ? parts[parts.length - 2] : parts[0]) || host;
}

let domainCache: { at: number; hosts: Set<string>; labels: Set<string> } | null = null;

/** Domény vlastního e-shopu — z produktového feedu (všechny jazykové mutace) a z URL feedu. */
function shopDomains(): { hosts: Set<string>; labels: Set<string> } {
  if (domainCache && Date.now() - domainCache.at < 10 * 60_000) return domainCache;
  const hosts = new Set<string>();
  const feedHost = hostOf(getSetting('productFeedUrl', DEFAULT_FEED_URL));
  if (feedHost) hosts.add(feedHost);
  try {
    const rows = getDb().prepare(
      'SELECT url_cz, url_sk, url_en FROM products WHERE url_cz != \'\' OR url_sk != \'\' OR url_en != \'\' LIMIT 40'
    ).all() as any[];
    for (const r of rows) {
      for (const u of [r.url_cz, r.url_sk, r.url_en]) {
        const h = hostOf(u);
        if (h) hosts.add(h);
      }
    }
  } catch { /* feed ještě není stažený — zůstane doména z URL feedu */ }
  const labels = new Set([...hosts].map(baseLabel));
  domainCache = { at: Date.now(), hosts, labels };
  return domainCache;
}

/** Volá se po přesyncu feedu, ať se doménová sada nedrží zastaralá. */
export function resetShopDomains(): void {
  domainCache = null;
}

/** Je odesílatel z našeho e-shopu? Používá i nástroj na balení při výběru zpráv. */
export function shopMatchesSender(fromAddr: string): boolean {
  const host = (fromAddr.split('@')[1] ?? '').toLowerCase().replace(/^www\./, '');
  return matchesShop(host || null, shopDomains());
}

function matchesShop(host: string | null, d: { hosts: Set<string>; labels: Set<string> }): boolean {
  if (!host) return false;
  if (d.hosts.has(host)) return true;
  // „wearquentino.com" nebo „shop.quentino.cz" projdou přes společný název značky
  const label = baseLabel(host);
  return [...d.labels].some(l => l.length >= 4 && (label === l || label.includes(l)));
}

/**
 * Objednávka z cizího e-shopu (Tesco, Alza…) se naparsuje úplně stejně dobře
 * jako ta naše, takže samotný parser nestačí. Kartu ukážeme jen tehdy, když
 * zpráva prokazatelně patří k našemu e-shopu — podle odesílatele, odkazů na
 * produkty nebo shody s produktovým feedem.
 */
function isOurShop(card: OrderCard, fromAddr: string): boolean {
  const d = shopDomains();
  if (d.hosts.size === 0) return false;

  const senderHost = (fromAddr.split('@')[1] ?? '').toLowerCase().replace(/^www\./, '');
  if (matchesShop(senderHost || null, d)) return true;

  if (card.items.some(it => matchesShop(hostOf(it.url), d))) return true;
  if (card.historyUrl && matchesShop(hostOf(card.historyUrl), d)) return true;
  if (card.items.some(it => it.matched)) return true;

  return false;
}

// ---------- odkaz do administrace ----------

/**
 * Adresa administrace Upgates. Bere se z nastavení API, a když není vyplněné,
 * odvodí se z domény obrázků ve feedu — „quentino.s19.cdn-upgates.com" má
 * administraci na „quentino.admin.s19.upgates.com".
 */
function adminBase(): string | null {
  const cfg = getSetting('upgatesUrl', '');
  if (cfg) return cfg.replace(/\/+$/, '');
  try {
    const row = getDb().prepare("SELECT image FROM products WHERE image != '' AND image IS NOT NULL LIMIT 1").get() as any;
    const host = row?.image ? new URL(row.image).hostname : null;
    const m = host?.match(/^([a-z0-9-]+)\.([a-z0-9]+)\.cdn-upgates\.com$/i);
    return m ? `https://${m[1]}.admin.${m[2]}.upgates.com` : null;
  } catch {
    return null;
  }
}

/**
 * Odkaz do administrace.
 *
 * Adresa obsahuje vnitřní ID záznamu, ne číslo objednávky. Přesně ho dá jen
 * Upgates API; bez něj se dopočítá z kalibrace — jedné známé dvojice
 * „číslo objednávky : ID v administraci". Obě řady rostou po jedné, takže
 * rozdíl zůstává stálý. Kalibrace se dá v nastavení kdykoli přenastavit.
 */
function adminLink(card: OrderCard): { url: string | null; source: OrderCard['adminSource'] } {
  if (card.live?.adminUrl) return { url: card.live.adminUrl, source: 'api' };

  const base = adminBase();
  if (!base) return { url: null, source: null };

  const ref = (getSetting('adminOrderRef', '') ?? '').trim();
  const num = Number((card.orderNumber ?? '').replace(/\D/g, ''));
  const m = ref.match(/^(\d+)\s*[:/]\s*(\d+)$/);
  if (m && num > 0) {
    const id = num - (Number(m[1]) - Number(m[2]));
    if (id > 0) return { url: `${base}/orders/edit-order/default/${id}/`, source: 'offset' };
  }
  return { url: `${base}/orders/`, source: 'list' };
}

// ---------- trvalé uložení hotových objednávek ----------

/**
 * Doručená, stornovaná nebo vrácená objednávka se už nezmění. Načte se tedy
 * naposledy — i se stavem zásilky — a od té chvíle se čte jen z databáze.
 * Ušetří to stahování stránek u starých objednávek a zároveň zůstane vidět,
 * jak zásilka dopadla.
 */
function readFinalCache(dbId: number): OrderCard | null {
  try {
    const row = getDb().prepare('SELECT json FROM order_cache WHERE message_pk = ?').get(dbId) as any;
    if (!row?.json) return null;
    const card = JSON.parse(row.json) as OrderCard;
    if (!isFinalStatus(card.tracking?.status ?? card.live?.status)) return null;
    // Starší záznamy vznikly ještě dřív, než se u uzavřených objednávek stav
    // zásilky dotahoval — takové se musí načíst znovu, jinak by u nich
    // dopravce chyběl navždy.
    if (card.tracking?.trackingCode && !card.tracking.shipment) return null;
    return card;
  } catch {
    return null;
  }
}

function writeFinalCache(dbId: number, card: OrderCard): void {
  try {
    getDb().prepare(
      `INSERT INTO order_cache (message_pk, json, at) VALUES (?, ?, ?)
       ON CONFLICT(message_pk) DO UPDATE SET json = excluded.json, at = excluded.at`
    ).run(dbId, JSON.stringify(card), new Date().toISOString());
  } catch { /* uložení je jen optimalizace */ }
}

// ---------- veřejné API ----------

/**
 * Sestaví kartu objednávky pro danou zprávu: parse těla → obrázky z feedu →
 * (volitelně) živý stav z Upgates API. Vrací null, pokud to není objednávka.
 */
export async function buildOrderCard(dbId: number, withLive = true, withRendered = false, force = false): Promise<OrderCard | null> {
  const msg = await getMessageFull(dbId);
  const card = parseOrderEmail({
    subject: msg.subject ?? '',
    html: msg.bodyHtml,
    text: msg.bodyText,
    toAddr: msg.toAddr ?? ''
  });
  if (!card) return null;

  try { matchItemsToFeed(card.items, card.lang); } catch { /* feed není povinný */ }

  // Cizí e-shopy (Tesco, Alza…) mají stejně vypadající potvrzení — ta sem nepatří
  if (!isOurShop(card, msg.fromAddr ?? '')) return null;

  if (withLive) {
    // Uzavřená objednávka je uložená i se stavem zásilky — nic se nestahuje
    const done = force ? null : readFinalCache(dbId);
    if (done) return done;

    if (card.orderNumber && upgatesConfigured()) {
      try {
        card.live = await orderLive(card.orderNumber, card.customerEmail);
      } catch { /* živá data jsou bonus, karta funguje i bez nich */ }
    }
    try {
      card.tracking = await liveTracking(card.historyUrl, {
        shipmentName: card.shipmentName,
        trackingCode: card.live?.trackingCode ?? null,
        trackingUrl: card.live?.trackingUrl ?? null
      }, withRendered, force);
      // Telefon zákazníka v mailu není, ale na stránce objednávky ano
      if (!card.customerPhone && card.tracking?.customerPhone) card.customerPhone = card.tracking.customerPhone;
    } catch { /* stránka e-shopu nebo dopravce může být nedostupná */ }

    // Uložit až ve chvíli, kdy je zásilka dobraná — jinak by se uzavřel
    // stav bez posledního záznamu od dopravce
    const status = card.tracking?.status ?? card.live?.status ?? null;
    if (isFinalStatus(status) && (card.tracking?.shipment || !card.tracking?.trackingCode)) {
      const admin0 = adminLink(card);
      writeFinalCache(dbId, { ...card, adminUrl: admin0.url, adminSource: admin0.source });
    }
  }

  const admin = adminLink(card);
  card.adminUrl = admin.url;
  card.adminSource = admin.source;
  return card;
}

// ---------- odznak do seznamu zpráv ----------

/** Stav e-shopu (volný text) přeloží na barvu odznaku. */
export function statusTone(status: string | null, paid: boolean, delivered: boolean): OrderBadge['tone'] {
  const s = (status ?? '').toLowerCase();
  if (/storn|zru[šs]en|vr[áa]cen|reklamac|cancel|refund/.test(s)) return 'problem';
  if (delivered || /doru[čc]en|vyzvednut|dokon[čc]en|uzav[řr]en|complete|delivered/.test(s)) return 'done';
  if (/odesl[áa]n|expedov|p[řr]ed[áa]n|na cest[ěe]|shipped|dispatch/.test(s)) return 'sent';
  if (paid || /zaplacen|uhrazen|paid/.test(s)) return 'paid';
  return 'new';
}

/**
 * Lehká varianta karty pro seznam zpráv — jen číslo, částka a stav.
 * Seznam tak nemusí tahat celou kartu ke každé viditelné zprávě.
 */
export async function buildOrderBadge(dbId: number): Promise<OrderBadge | null> {
  const card = await buildOrderCard(dbId, true);
  if (!card) return null;

  const status = card.tracking?.status ?? card.live?.status ?? null;
  const paid = !!(card.live?.paid || card.tracking?.paidDate);
  const delivered = !!card.live?.deliveredDate;

  return {
    orderNumber: card.orderNumber,
    total: card.total,
    status,
    tone: statusTone(status, paid, delivered),
    carrierName: card.tracking?.carrierName ?? null,
    shipmentStage: card.tracking?.shipment?.stage ?? card.tracking?.shipment?.description ?? null
  };
}
