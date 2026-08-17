import { getSetting, setSetting } from './db';
import { encrypt, decrypt } from './secure';
import { UpgatesOrder, UpgatesConfig, OrderLive } from '../shared/types';

/**
 * Upgates API (https://docs.upgates.com/api/intro)
 * - Basic auth (login API uživatele + klíč), URL tvaru https://ESHOP.admin.SERVER.upgates.com
 * - používáme jen čtení objednávek dle e-mailu zákazníka
 */

export function getUpgatesConfig(): UpgatesConfig {
  return {
    url: getSetting('upgatesUrl', '')!,
    login: getSetting('upgatesLogin', '')!,
    hasKey: !!getSetting('upgatesKey')
  };
}

export function saveUpgatesConfig(cfg: { url?: string; login?: string; apiKey?: string }): UpgatesConfig {
  if (cfg.url !== undefined) setSetting('upgatesUrl', cfg.url.trim().replace(/\/+$/, ''));
  if (cfg.login !== undefined) setSetting('upgatesLogin', cfg.login.trim());
  if (cfg.apiKey !== undefined) setSetting('upgatesKey', cfg.apiKey ? encrypt(cfg.apiKey) : '');
  ordersCache.clear();
  return getUpgatesConfig();
}

export function upgatesConfigured(): boolean {
  const c = getUpgatesConfig();
  return !!(c.url && c.login && c.hasKey);
}

async function upgatesFetch(pathAndQuery: string): Promise<any> {
  const cfg = getUpgatesConfig();
  const key = getSetting('upgatesKey');
  if (!cfg.url || !cfg.login || !key) throw new Error('Upgates API není nastaveno (Nastavení → AI → Upgates)');
  const auth = Buffer.from(`${cfg.login}:${decrypt(key)}`).toString('base64');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(`${cfg.url}${pathAndQuery}`, {
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      redirect: 'follow',
      signal: controller.signal
    });
    if (res.status === 401 || res.status === 403) throw new Error('Upgates API odmítlo přihlášení — zkontroluj login a klíč');
    if (!res.ok) throw new Error(`Upgates API: HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function testUpgates(): Promise<string> {
  const data = await upgatesFetch('/api/v2/status');
  const allowed = (data?.services ?? []).filter((s: any) => s.privilege !== 'deny').length;
  return `Připojení funguje (${allowed} povolených endpointů).`;
}

function mapOrder(o: any): UpgatesOrder {
  return {
    orderNumber: o.order_number ?? '',
    status: o.status ?? '',
    creationTime: o.creation_time ?? '',
    paidDate: o.paid_date ?? null,
    deliveredDate: o.delivered_date ?? null,
    trackingCode: o.tracking_code ?? null,
    trackingUrl: o.tracking_url ?? null,
    total: o.order_total ?? 0,
    currency: o.currency_id ?? '',
    shipmentName: o.shipment?.name ?? '',
    paymentName: o.payment?.name ?? '',
    products: (o.products ?? [])
      .filter((p: any) => p.type !== 'shipment' && p.type !== 'payment')
      .map((p: any) => `${p.quantity}× ${p.title}`)
      .slice(0, 8),
    adminUrl: o.admin_url ?? null
  };
}

// Cache 10 minut, ať šetříme rate limit
const ordersCache = new Map<string, { at: number; orders: UpgatesOrder[] }>();

export async function ordersByEmail(emailRaw: string): Promise<UpgatesOrder[]> {
  const email = emailRaw.trim().toLowerCase();
  if (!email.includes('@')) return [];
  const hit = ordersCache.get(email);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.orders;
  const data = await upgatesFetch(
    `/api/v2/orders?email=${encodeURIComponent(email)}&order_by=creation_time&order_dir=desc`
  );
  const orders = (data?.orders ?? []).map(mapOrder).slice(0, 10);
  ordersCache.set(email, { at: Date.now(), orders });
  return orders;
}

/**
 * Živý stav jedné objednávky dle čísla. Zkusí přímý dotaz na číslo objednávky,
 * a když ho API nepodporuje, dohledá objednávku mezi objednávkami zákazníka.
 */
export async function orderLive(orderNumber: string, email: string | null): Promise<OrderLive | null> {
  const wanted = orderNumber.replace(/^0+/, '');
  const same = (n: string) => n.replace(/^0+/, '') === wanted;

  let order: UpgatesOrder | null = null;
  try {
    const data = await upgatesFetch(`/api/v2/orders?order_number=${encodeURIComponent(orderNumber)}`);
    const hit = (data?.orders ?? []).find((o: any) => same(String(o.order_number ?? '')));
    if (hit) order = mapOrder(hit);
  } catch { /* endpoint filtr nemusí být povolený — jdeme přes e-mail */ }

  if (!order && email) {
    const list = await ordersByEmail(email);
    order = list.find(o => same(o.orderNumber)) ?? null;
  }
  if (!order) return null;

  return {
    status: order.status || null,
    paid: !!order.paidDate,
    paidDate: order.paidDate,
    deliveredDate: order.deliveredDate,
    trackingCode: order.trackingCode,
    trackingUrl: order.trackingUrl,
    adminUrl: order.adminUrl
  };
}

/** Textový blok pro AI — poslední objednávky zákazníka jako zdroj faktů. */
export async function ordersContextForAi(email: string): Promise<string> {
  if (!upgatesConfigured()) return '';
  try {
    const orders = await ordersByEmail(email);
    if (orders.length === 0) return '';
    return orders.slice(0, 3).map(o => {
      const bits = [
        `Objednávka č. ${o.orderNumber} (${new Date(o.creationTime).toLocaleDateString('cs-CZ')})`,
        `stav: ${o.status || 'neuveden'}`,
        o.paidDate ? `zaplaceno ${o.paidDate}` : 'nezaplaceno',
        o.deliveredDate ? `doručeno ${o.deliveredDate}` : null,
        `doprava: ${o.shipmentName || '—'}`,
        o.trackingCode ? `tracking: ${o.trackingCode}${o.trackingUrl ? ` (${o.trackingUrl})` : ''}` : 'tracking zatím není',
        `celkem ${o.total} ${o.currency}`,
        `položky: ${o.products.join(', ') || '—'}`
      ].filter(Boolean);
      return `- ${bits.join(' | ')}`;
    }).join('\n');
  } catch {
    return '';
  }
}
