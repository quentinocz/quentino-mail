/**
 * Komunikace s Meta Graph API.
 *
 * Publikování na Instagram má vždycky tři kroky: vytvoř kontejner s odkazem na
 * médium → počkej, až ho Meta zpracuje → zveřejni. Obrázky si Meta stahuje
 * z veřejné adresy, přímý upload z počítače neexistuje — proto je potřeba
 * úložiště (viz `media.ts`).
 */
import { getSecrets } from './store';

const VERSION = 'v23.0';
const GRAPH = `https://graph.facebook.com/${VERSION}`;

export interface GraphMedia {
  publicUrl: string;
  isVideo: boolean;
  coverOffset?: number | null;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Chyba z Graph API i s číselným kódem, aby se dala poznat od ostatních. */
export class GraphError extends Error {
  code?: number;
  constructor(message: string, code?: number) {
    super(message);
    this.name = 'GraphError';
    this.code = code;
  }
}

/**
 * Poznává chyby, po kterých nemá smysl nic zkoušet znovu — účet je potřeba
 * připojit nanovo. 190 = zneplatněná session (změna hesla, nově vydaný token),
 * 102 = session vypršela, 463 = token po expiraci.
 */
export function isTokenError(e: unknown): boolean {
  const code = (e as GraphError | undefined)?.code;
  if (code === 190 || code === 102 || code === 463) return true;
  return /access token|OAuthException|session has been invalidated/i.test((e as Error | undefined)?.message ?? '');
}

async function graph(
  path: string,
  params: Record<string, string>,
  token: string,
  method: 'GET' | 'POST' = 'GET'
): Promise<any> {
  // Výměna kódu za token se dělá bez přihlášení — prázdný parametr by Meta odmítla
  const qs = new URLSearchParams(token ? { ...params, access_token: token } : { ...params });
  const url = method === 'GET' ? `${GRAPH}/${path}?${qs}` : `${GRAPH}/${path}`;
  const res = await fetch(url, method === 'GET' ? {} : { method: 'POST', body: qs });
  const data = await res.json().catch(() => ({}));
  if (data?.error) {
    const e = data.error;
    // Hláška od Mety je anglická a technická; u nejčastějších případů ji nahradíme
    // tím, co má uživatel udělat.
    const friendly = e.code === 190 || e.code === 102 || e.code === 463
      ? 'Přístup k účtu už neplatí — Facebook session zneplatnil (typicky změna hesla nebo nově vydaný token). Připoj účet znovu.'
      : `${e.message}${e.code ? ` (kód ${e.code})` : ''}`;
    throw new GraphError(friendly, e.code);
  }
  if (!res.ok) throw new GraphError(`Meta odpověděla ${res.status}.`, res.status);
  return data;
}

/* ---------- Přihlášení a tokeny ---------- */

export function authUrl(state: string): string {
  const s = getSecrets();
  if (!s.appId) throw new Error('Není vyplněné App ID Meta aplikace (Instagram → Účty → Připojení).');
  if (!s.callbackUrl) throw new Error('Není vyplněná adresa pro návrat z přihlášení.');
  const scopes = [
    'instagram_basic',
    'instagram_content_publish',
    'pages_show_list',
    'business_management'
  ].join(',');
  return `https://www.facebook.com/${VERSION}/dialog/oauth`
    + `?client_id=${encodeURIComponent(s.appId)}`
    + `&redirect_uri=${encodeURIComponent(s.callbackUrl)}`
    + `&scope=${scopes}&state=${encodeURIComponent(state)}&response_type=code`;
}

/** Kód z přihlášení → krátkodobý token → dlouhodobý (60 dní). */
export async function exchangeCode(code: string): Promise<string> {
  const s = getSecrets();
  if (!s.appSecret) throw new Error('Není vyplněný App Secret Meta aplikace.');
  const short = await graph('oauth/access_token', {
    client_id: s.appId,
    client_secret: s.appSecret,
    redirect_uri: s.callbackUrl,
    code
  }, '');
  return exchangeLongLived(short.access_token);
}

export async function exchangeLongLived(token: string): Promise<string> {
  const s = getSecrets();
  const long = await graph('oauth/access_token', {
    grant_type: 'fb_exchange_token',
    client_id: s.appId,
    client_secret: s.appSecret,
    fb_exchange_token: token
  }, '');
  return long.access_token as string;
}

export interface DiscoveredAccount {
  igUserId: string;
  username: string;
  pageName: string;
  pageToken: string;
}

/**
 * Najde všechny Instagram účty napojené na stránky, ke kterým dal uživatel
 * přístup. Token stránky se používá k publikování — nevyprší dřív než ten
 * uživatelský, ze kterého vznikl.
 */
export async function discoverAccounts(userToken: string): Promise<DiscoveredAccount[]> {
  const res = await graph('me/accounts', {
    fields: 'name,access_token,instagram_business_account{id,username}',
    limit: '100'
  }, userToken);
  const out: DiscoveredAccount[] = [];
  for (const p of res.data ?? []) {
    if (!p.instagram_business_account) continue;
    out.push({
      igUserId: p.instagram_business_account.id,
      username: p.instagram_business_account.username ?? '',
      pageName: p.name ?? '',
      pageToken: p.access_token
    });
  }
  return out;
}

/** Ověření ručně vloženého tokenu — vrátí účty, ke kterým dává přístup. */
export async function verifyToken(token: string): Promise<DiscoveredAccount[]> {
  const accounts = await discoverAccounts(token);
  if (accounts.length === 0) {
    throw new Error('K tomuto tokenu nepatří žádná stránka s napojeným Instagram účtem typu Business nebo Creator.');
  }
  return accounts;
}

/* ---------- Čtení zdrojového účtu ---------- */

const HISTORY_FIELDS =
  'id,media_type,media_url,thumbnail_url,permalink,caption,timestamp,like_count,comments_count,'
  + 'children{id,media_type,media_url,thumbnail_url}';

export async function fetchHistory(igUserId: string, token: string, since: string | null, max = 2000): Promise<any[]> {
  let url = `${GRAPH}/${igUserId}/media?fields=${HISTORY_FIELDS}&limit=50&access_token=${encodeURIComponent(token)}`;
  const all: any[] = [];
  while (url) {
    const page = await fetch(url).then(r => r.json());
    if (page.error) throw new Error(page.error.message);
    for (const m of page.data ?? []) {
      if (since && new Date(m.timestamp) <= new Date(since)) return all;
      all.push(m);
    }
    url = page.paging?.next ?? '';
    if (all.length >= max) break;
  }
  return all;
}

/** Odkazy na média vyprší, proto se čtou až ve chvíli, kdy jsou potřeba. */
export async function mediaUrls(igMediaId: string, token: string): Promise<any> {
  return graph(igMediaId, {
    fields: 'media_type,media_url,thumbnail_url,children{id,media_type,media_url,thumbnail_url}'
  }, token);
}

/* ---------- Publikování ---------- */

async function waitReady(containerId: string, token: string, maxMs = 5 * 60_000): Promise<void> {
  const started = Date.now();
  let wait = 3000;
  while (Date.now() - started < maxMs) {
    await sleep(wait);
    wait = Math.min(8000, wait + 1000);
    const s = await graph(containerId, { fields: 'status_code,status' }, token);
    if (s.status_code === 'FINISHED') return;
    if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') {
      throw new Error(`Instagram odmítl médium: ${s.status ?? s.status_code}`);
    }
  }
  throw new Error('Zpracování média trvalo příliš dlouho. Zkus to znovu, nebo zmenši video.');
}

export function validateCaption(text: string): void {
  if (!text.trim()) throw new Error('Popisek je prázdný.');
  if (text.length > 2200) throw new Error(`Popisek má ${text.length} znaků, Instagram povoluje 2 200.`);
  const tags = (text.match(/#/g) ?? []).length;
  if (tags > 30) throw new Error(`Popisek má ${tags} hashtagů, Instagram povoluje 30.`);
}

export async function publish(
  igUserId: string,
  token: string,
  caption: string,
  media: GraphMedia[]
): Promise<{ containerId: string; igMediaId: string; permalink: string | null }> {
  validateCaption(caption);
  if (media.length === 0) throw new Error('Příspěvek nemá žádná média.');
  if (media.length > 10) throw new Error('Karusel může mít nejvýš 10 položek.');

  let containerId: string;

  if (media.length > 1) {
    const children: string[] = [];
    for (const m of media) {
      const c = await graph(`${igUserId}/media`, m.isVideo
        ? { media_type: 'VIDEO', video_url: m.publicUrl, is_carousel_item: 'true' }
        : { image_url: m.publicUrl, is_carousel_item: 'true' }, token, 'POST');
      if (m.isVideo) await waitReady(c.id, token);
      children.push(c.id);
    }
    const c = await graph(`${igUserId}/media`, {
      media_type: 'CAROUSEL', children: children.join(','), caption
    }, token, 'POST');
    containerId = c.id;
  } else {
    const m = media[0];
    const params: Record<string, string> = m.isVideo
      ? { media_type: 'REELS', video_url: m.publicUrl, caption, share_to_feed: 'true' }
      : { image_url: m.publicUrl, caption };
    if (m.isVideo && m.coverOffset != null) params.thumb_offset = String(Math.round(m.coverOffset * 1000));
    const c = await graph(`${igUserId}/media`, params, token, 'POST');
    containerId = c.id;
  }

  await waitReady(containerId, token);
  const published = await graph(`${igUserId}/media_publish`, { creation_id: containerId }, token, 'POST');

  let permalink: string | null = null;
  try {
    const info = await graph(published.id, { fields: 'permalink' }, token);
    permalink = info.permalink ?? null;
  } catch { /* odkaz je jen pro pohodlí */ }

  return { containerId, igMediaId: published.id, permalink };
}

/** Kolik příspěvků účet za posledních 24 h publikoval přes API (limit je 100). */
export async function publishingLimit(igUserId: string, token: string): Promise<{ used: number; cap: number } | null> {
  try {
    const r = await graph(`${igUserId}/content_publishing_limit`, { fields: 'quota_usage,config' }, token);
    const row = r.data?.[0];
    if (!row) return null;
    return { used: row.quota_usage ?? 0, cap: row.config?.quota_total ?? 100 };
  } catch {
    return null;
  }
}
