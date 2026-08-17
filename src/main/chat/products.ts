/**
 * Produktové karty.
 *
 * Ve zprávě je vždycky jen obyčejná adresa produktu — widget i webový admin
 * z ní kartu vykreslí sami. Aplikace to dělá stejně, aby zákazník viděl přesně
 * to, co odešlo: adresa se pošle nasazenému chatu a ten vrátí název, cenu
 * a obrázek z feedu.
 */
import { getSecrets } from './config';
import type { ChatProduct } from '../../shared/types';

/** Domény e-shopu, ze kterých se v textu poznají odkazy na produkty. */
export const PRODUCT_URL_RE =
  /https?:\/\/(?:www\.)?(?:quentino\.cz|quentino\.sk|wearquentino\.com)\/[^\s<>"']*/gi;

export function extractUrls(text: string): string[] {
  return text.match(PRODUCT_URL_RE) ?? [];
}

function apiBase(): string {
  const s = getSecrets();
  if (!s.apiBase) throw new Error('Není vyplněná adresa chatu (Chat → Nastavení).');
  return s.apiBase;
}

const cache = new Map<string, { at: number; products: ChatProduct[] }>();
const TTL = 10 * 60_000;

function toProduct(p: any): ChatProduct {
  return {
    id: String(p.id ?? ''),
    name: String(p.name ?? ''),
    price: String(p.price ?? ''),
    imgUrl: String(p.imgUrl ?? ''),
    url: String(p.url ?? ''),
    domain: String(p.domain ?? '')
  };
}

/** Karty k adresám ve zprávě. Výsledky se drží v paměti, feed se mění zřídka. */
export async function preview(urls: string[]): Promise<ChatProduct[]> {
  if (urls.length === 0) return [];
  const key = urls.join(',');
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.products;

  const res = await fetch(`${apiBase()}/api/chat/product-preview?urls=${encodeURIComponent(key)}`);
  if (!res.ok) throw new Error(`Karty produktů se nenačetly (${res.status}).`);
  const products = ((await res.json()) as any[]).map(toProduct);
  cache.set(key, { at: Date.now(), products });
  return products;
}

export async function search(query: string): Promise<ChatProduct[]> {
  if (query.trim().length < 2) return [];
  const res = await fetch(`${apiBase()}/api/chat/product-preview?search=${encodeURIComponent(query.trim())}`);
  if (!res.ok) throw new Error(`Hledání selhalo (${res.status}).`);
  return ((await res.json()) as any[]).map(toProduct);
}

/**
 * Tentýž produkt v jiné jazykové mutaci e-shopu. Zákazníkovi ze Slovenska
 * nemá smysl posílat český odkaz.
 */
export async function inDomain(productId: string, domain: 'cz' | 'sk' | 'en'): Promise<ChatProduct | null> {
  const res = await fetch(
    `${apiBase()}/api/chat/product-preview?id=${encodeURIComponent(productId)}&domain=${domain}`
  );
  if (!res.ok) return null;
  const list = ((await res.json()) as any[]).map(toProduct);
  return list[0] ?? null;
}

/** Z jazyka konverzace na mutaci e-shopu. */
export function domainForLocale(locale: string): 'cz' | 'sk' | 'en' {
  if (locale === 'sk') return 'sk';
  if (locale === 'en') return 'en';
  return 'cz';
}
