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
  /** Veřejná adresa, ze které si Meta médium stáhne (obrázky, karusel) */
  publicUrl: string;
  isVideo: boolean;
  coverOffset?: number | null;
  /** Data videa poslaná Metě přímo — pro jedno video je to spolehlivější než adresa */
  data?: Buffer;
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

/**
 * Oprávnění, bez kterých modul nefunguje celý. Poslední dvě jsou kvůli
 * souběžnému sdílení na Facebook stránku — jsou v seznamu i pro toho, kdo ho
 * nepoužívá, protože přidat je později znamená projít přihlášením znovu.
 */
export const REQUIRED_SCOPES = [
  'instagram_basic',
  'instagram_content_publish',
  'pages_show_list',
  'business_management',
  'pages_manage_posts',
  'pages_read_engagement'
];

/**
 * Co tokenu chybí proti seznamu výše. Starý token vydaný před rozšířením
 * oprávnění je jinak k nerozeznání od nového — a pozná se to až chybou při
 * publikování na stránku.
 */
export async function missingScopes(token: string): Promise<string[]> {
  try {
    const res = await graph('me/permissions', { limit: '100' }, token);
    const granted = new Set(
      (res.data ?? []).filter((p: any) => p.status === 'granted').map((p: any) => p.permission)
    );
    return REQUIRED_SCOPES.filter(scope => !granted.has(scope));
  } catch {
    return []; // když se to nepodaří zjistit, nebudeme uživateli stát v cestě
  }
}

export function authUrl(state: string): string {
  const s = getSecrets();
  if (!s.appId) throw new Error('Není vyplněné App ID Meta aplikace (Instagram → Účty → Připojení).');
  if (!s.callbackUrl) throw new Error('Není vyplněná adresa pro návrat z přihlášení.');
  const scopes = REQUIRED_SCOPES.join(',');
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
  pageId: string;
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
    fields: 'id,name,access_token,instagram_business_account{id,username}',
    limit: '100'
  }, userToken);
  const out: DiscoveredAccount[] = [];
  for (const p of res.data ?? []) {
    if (!p.instagram_business_account) continue;
    out.push({
      igUserId: p.instagram_business_account.id,
      username: p.instagram_business_account.username ?? '',
      pageId: p.id ?? '',
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

/**
 * Přímé odeslání videa Metě.
 *
 * U videa se ukázalo, že stahování z veřejné adresy Meta zvládá nespolehlivě
 * (chyby řady 22070xx, i když soubor je v pořádku a dostupný). Tenhle způsob
 * je v dokumentaci určený právě pro soubory z disku: nejdřív vznikne prázdný
 * kontejner a do něj se pošlou bajty.
 */
async function sendVideoBytes(url: string, token: string, data: Buffer, what: string): Promise<void> {
  // Odesílání občas skončí čtyřstovkou bez bližšího vysvětlení a napodruhé
  // projde beze změny — kontejner zřejmě chvíli po založení ještě není hotový.
  const delays = [0, 3000, 8000];
  let last: Error | null = null;

  for (const wait of delays) {
    if (wait) await sleep(wait);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `OAuth ${token}`,
        offset: '0',
        file_size: String(data.length),
        'Content-Type': 'application/octet-stream'
      },
      body: new Uint8Array(data)
    });

    const raw = await res.text();
    let body: any = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { /* Meta občas vrátí prostý text */ }

    if (res.ok && body?.success !== false && !body?.error) return;

    // Detail z odpovědi je při hledání příčiny cennější než holé číslo stavu
    const detail = body?.error?.message ?? (raw ? raw.slice(0, 200) : '');
    last = new GraphError(
      `${what} selhalo (${res.status})${detail ? `: ${detail}` : '.'}`,
      body?.error?.code ?? res.status
    );
    // Zamítnutí kvůli oprávnění nebo tokenu nemá smysl opakovat
    if (res.status === 401 || res.status === 403 || isTokenError(last)) break;
  }

  throw last ?? new GraphError(`${what} selhalo.`);
}

async function uploadVideo(containerId: string, token: string, data: Buffer): Promise<void> {
  await sendVideoBytes(
    `https://rupload.facebook.com/ig-api-upload/${VERSION}/${containerId}`,
    token,
    data,
    'Nahrání videa'
  );
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
      ? m.data
        // Video putuje Metě přímo: kontejner se založí prázdný a bajty se pošlou zvlášť
        ? { media_type: 'REELS', upload_type: 'resumable', caption, share_to_feed: 'true' }
        : { media_type: 'REELS', video_url: m.publicUrl, caption, share_to_feed: 'true' }
      : { image_url: m.publicUrl, caption };
    if (m.isVideo && m.coverOffset != null) params.thumb_offset = String(Math.round(m.coverOffset * 1000));
    const c = await graph(`${igUserId}/media`, params, token, 'POST');
    if (m.isVideo && m.data) await uploadVideo(c.id, token, m.data);
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

/* ---------- Souběžné sdílení na Facebook stránku ---------- */

/**
 * Video na stránku přes Reels API.
 *
 * Starší cesta (`/{page}/videos`) vrací „No permission to publish the video"
 * i s platnými oprávněními ke stránce — Meta ji pro tenhle případ opustila.
 * Aktuální postup má tři kroky: založit relaci, poslat soubor, zveřejnit.
 */
async function shareReel(pageId: string, token: string, description: string, video: GraphMedia): Promise<string> {
  const start = await graph(`${pageId}/video_reels`, { upload_phase: 'start' }, token, 'POST');
  const videoId = start.video_id as string;
  if (!videoId) throw new GraphError('Facebook nezaložil nahrávání videa.');
  const uploadUrl = (start.upload_url as string) || `https://rupload.facebook.com/video-upload/${VERSION}/${videoId}`;

  const headers: Record<string, string> = { Authorization: `OAuth ${token}` };
  if (video.data) {
    headers.offset = '0';
    headers.file_size = String(video.data.length);
    headers['Content-Type'] = 'application/octet-stream';
  } else if (video.publicUrl) {
    headers.file_url = video.publicUrl;
  } else {
    throw new GraphError('Video není odkud vzít.');
  }

  if (video.data) {
    await sendVideoBytes(uploadUrl, token, video.data, 'Nahrání videa na stránku');
  } else {
    // Soubor hostovaný jinde si Facebook stáhne sám podle hlavičky file_url
    const up = await fetch(uploadUrl, { method: 'POST', headers });
    const raw = await up.text();
    let body: any = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { /* prostý text */ }
    if (body?.error) throw new GraphError(body.error.message ?? 'Nahrání videa na stránku selhalo.', body.error.code);
    if (!up.ok) throw new GraphError(`Nahrání videa na stránku selhalo (${up.status}): ${raw.slice(0, 200)}`, up.status);
  }

  await graph(`${pageId}/video_reels`, {
    video_id: videoId,
    upload_phase: 'finish',
    video_state: 'PUBLISHED',
    description
  }, token, 'POST');

  return videoId;
}

/**
 * Zveřejní stejný obsah na Facebook stránce, ke které je Instagram připojený.
 *
 * Fotky se nahrají jako nezveřejněné a připojí se k jednomu příspěvku, takže
 * z karuselu vznikne na Facebooku album, ne pět samostatných příspěvků. Video
 * se posílá adresou; když ji nemáme (video šlo Metě přímo), sdílení se
 * přeskočí a řekne to.
 */
export async function shareToPage(
  pageId: string,
  token: string,
  caption: string,
  media: GraphMedia[]
): Promise<string> {
  const photos = media.filter(m => !m.isVideo && m.publicUrl);
  const video = media.find(m => m.isVideo);

  if (video) return shareReel(pageId, token, caption, video);

  if (photos.length === 0) throw new GraphError('Není co na stránku sdílet.');

  if (photos.length === 1) {
    const res = await graph(`${pageId}/photos`, { url: photos[0].publicUrl, caption }, token, 'POST');
    return res.post_id ?? res.id ?? '';
  }

  const ids: string[] = [];
  for (const p of photos) {
    const up = await graph(`${pageId}/photos`, { url: p.publicUrl, published: 'false' }, token, 'POST');
    ids.push(up.id);
  }
  const params: Record<string, string> = { message: caption };
  ids.forEach((id, i) => { params[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id }); });
  const res = await graph(`${pageId}/feed`, params, token, 'POST');
  return res.id ?? '';
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
