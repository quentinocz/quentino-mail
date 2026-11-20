/**
 * Google Ads API — přihlášení a čtení statistik.
 *
 * ## Přístup
 *
 * Od 9. 9. 2026 Google nechce developer token: přístup patří projektu
 * v Google Cloudu, ze kterého je klient OAuth. Projekt potřebuje zapnuté
 * Google Ads API a úroveň přístupu aspoň Explorer (skutečné účty, 2 880
 * operací za 24 h). Modul jich za noc spotřebuje jednotky — tři dotazy
 * na kampaně a jeden na produkty, s listováním po 10 000 řádcích.
 *
 * Hlavička `developer-token` se posílá jen tehdy, když je vyplněná:
 * Google ji teď ignoruje a v některé příští verzi ji začne odmítat.
 *
 * ## Přihlášení
 *
 * Klient typu Desktop, přesměrování na 127.0.0.1 s náhodným portem a PKCE
 * — to je cesta, kterou Google doporučuje pro aplikace na počítači.
 * Vkládání kódu ručně (out-of-band) už Google nepodporuje. Rozsah
 * `adwords` neumí jen čtení; že modul ve fázi 1 nic nemění, hlídá kód
 * (v tomhle souboru není jediný zápis), a kdo chce jistotu, dá
 * přihlašovanému uživateli v Google Ads jen právo čtení.
 *
 * Refresh token se ukládá šifrovaně v tomhle Macu a do sdílené složky
 * nejde — stejně jako ostatní hesla aplikace.
 */
import http from 'http';
import crypto from 'crypto';
import type { AddressInfo } from 'net';
import { getSetting, setSetting } from '../db';
import { encrypt, decrypt } from '../secure';
import type { AdsConfig, AdsGoogleCustomer } from '../../shared/ads';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/adwords';
const API = 'https://googleads.googleapis.com';

/* ---------- tajné údaje tohoto Macu ---------- */

const SECRET_KEY = 'adsGoogleSecret';
const REFRESH_KEY = 'adsGoogleRefresh';
const DEVTOKEN_KEY = 'adsGoogleDevToken';

function readSecret(key: string): string {
  const raw = getSetting(key, '') || '';
  if (!raw) return '';
  try { return decrypt(raw); } catch { return ''; }
}

function writeSecret(key: string, value: string): void {
  setSetting(key, value ? encrypt(value) : '');
}

export function googleSecrets(): { hasSecret: boolean; connected: boolean } {
  return { hasSecret: !!readSecret(SECRET_KEY), connected: !!readSecret(REFRESH_KEY) };
}

export function saveGoogleSecret(secret: string): void {
  writeSecret(SECRET_KEY, secret.trim());
}

export function saveDeveloperToken(token: string): void {
  writeSecret(DEVTOKEN_KEY, token.trim());
}

export function forgetGoogle(): void {
  writeSecret(REFRESH_KEY, '');
  cachedToken = null;
}

/* ---------- OAuth ---------- */

function base64url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Adresa přihlášení; zvlášť kvůli zkoušce. */
export function authUrl(clientId: string, redirect: string, challenge: string, state: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirect,
    response_type: 'code',
    scope: SCOPE,
    // offline + consent = Google vrátí refresh token i při opakovaném přihlášení
    access_type: 'offline',
    prompt: 'consent',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state
  });
  return `${AUTH_URL}?${params.toString()}`;
}

const PAGE_OK = `<!doctype html><meta charset="utf-8"><title>Quentino App</title>
<body style="font:16px -apple-system,sans-serif;padding:48px;text-align:center;color:#201d29">
<h2>Přihlášeno ✓</h2><p>Google Ads je připojený. Okno můžeš zavřít a vrátit se do aplikace.</p></body>`;
const PAGE_ERR = (msg: string) => `<!doctype html><meta charset="utf-8"><title>Quentino App</title>
<body style="font:16px -apple-system,sans-serif;padding:48px;text-align:center;color:#201d29">
<h2>Přihlášení se nepovedlo</h2><p>${msg.replace(/[<>&]/g, '')}</p></body>`;

/**
 * Přihlášení přes prohlížeč.
 *
 * Aplikace na chvíli poslouchá na náhodném portu na 127.0.0.1, otevře
 * prohlížeč s přihlášením a počká, až Google pošle kód zpátky. Po pěti
 * minutách to vzdá — zapomenutá karta prohlížeče nesmí držet port
 * otevřený navždy.
 */
export async function loginGoogle(
  clientId: string,
  openExternal: (url: string) => Promise<void> | void
): Promise<void> {
  const secret = readSecret(SECRET_KEY);
  if (!clientId.trim()) throw new Error('Chybí ID klienta OAuth z Google Cloudu.');
  if (!secret) throw new Error('Chybí tajný klíč klienta OAuth (client secret).');

  const verifier = base64url(crypto.randomBytes(48));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  const state = base64url(crypto.randomBytes(16));

  const code = await new Promise<{ code: string; redirect: string }>((resolve, reject) => {
    let redirect = '';
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/') { res.writeHead(404); res.end(); return; }
      const got = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      if (url.searchParams.get('state') !== state) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(PAGE_ERR('Odpověď nepatří k tomuhle přihlášení.'));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(got ? PAGE_OK : PAGE_ERR(error ?? 'Google nevrátil kód.'));
      clearTimeout(timer);
      server.close();
      if (got) resolve({ code: got, redirect });
      else reject(new Error(error === 'access_denied' ? 'Přihlášení bylo zrušeno.' : `Google: ${error ?? 'bez kódu'}`));
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new Error('Přihlášení nedoběhlo do pěti minut.'));
    }, 5 * 60_000);
    server.on('error', err => { clearTimeout(timer); reject(err); });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      redirect = `http://127.0.0.1:${port}`;
      Promise.resolve(openExternal(authUrl(clientId.trim(), redirect, challenge, state)))
        .catch(err => { clearTimeout(timer); server.close(); reject(err); });
    });
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId.trim(),
      client_secret: secret,
      code: code.code,
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: code.redirect
    }).toString()
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || !json.refresh_token) {
    throw new Error(`Google nevydal přístup: ${json.error_description ?? json.error ?? res.status}`);
  }
  writeSecret(REFRESH_KEY, json.refresh_token);
  cachedToken = json.access_token
    ? { token: json.access_token, until: Date.now() + (Number(json.expires_in) || 3000) * 1000 - 60_000 }
    : null;
}

let cachedToken: { token: string; until: number } | null = null;

async function accessToken(cfg: AdsConfig): Promise<string> {
  if (cachedToken && cachedToken.until > Date.now()) return cachedToken.token;
  const refresh = readSecret(REFRESH_KEY);
  const secret = readSecret(SECRET_KEY);
  if (!refresh) throw new Error('Tenhle Mac není přihlášený ke Google Ads.');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cfg.google.clientId,
      client_secret: secret,
      refresh_token: refresh,
      grant_type: 'refresh_token'
    }).toString()
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    /*
     * invalid_grant = token zneplatněný: odhlášení v účtu Google, změna
     * hesla, nebo (u aplikace ve stavu Testing) uplynulých 7 dní. Znovu
     * to nepomůže, je potřeba se přihlásit.
     */
    if (json.error === 'invalid_grant') {
      forgetGoogle();
      throw new Error('Přihlášení ke Google Ads vypršelo — přihlas se znovu v Nastavení. '
        + 'Pokud se to opakuje po týdnu, je aplikace v Google Cloudu ve stavu Testing; přepni ji na In production.');
    }
    throw new Error(`Google nevydal přístupový token: ${json.error_description ?? json.error ?? res.status}`);
  }
  cachedToken = { token: json.access_token, until: Date.now() + (Number(json.expires_in) || 3000) * 1000 - 60_000 };
  return cachedToken.token;
}

/* ---------- volání API ---------- */

/**
 * Srozumitelná chyba z odpovědi Google Ads.
 *
 * Google posílá kód chyby hluboko v `details`; bez něj člověk vidí jen
 * „PERMISSION_DENIED" a neví, jestli chybí přístup projektu, nebo práva
 * v účtu. Nejčastější případy mají vlastní větu.
 */
export function explainError(status: number, body: any): string {
  const err = Array.isArray(body) ? body[0]?.error : body?.error;
  const detail = err?.details?.[0]?.errors?.[0];
  const code = detail?.errorCode ? Object.values(detail.errorCode)[0] : '';
  const message = detail?.message ?? err?.message ?? `HTTP ${status}`;
  switch (code) {
    case 'CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION':
    case 'DEVELOPER_TOKEN_NOT_APPROVED':
      return 'Projekt v Google Cloudu ještě nemá přístup ke skutečným účtům. V Cloud Console → Google Ads API '
        + '→ Overview požádej o úroveň Explorer; do té doby jdou číst jen testovací účty.';
    case 'USER_PERMISSION_DENIED':
      return 'Přihlášený uživatel nemá k účtu přístup. Když se k účtu chodí přes manažerský účet (MCC), '
        + 'vyplň v Nastavení jeho číslo.';
    case 'CUSTOMER_NOT_ENABLED':
      return 'Účet Google Ads není aktivní (zrušený nebo nedokončené nastavení).';
    case 'RESOURCE_EXHAUSTED':
    case 'RESOURCE_TEMPORARILY_EXHAUSTED':
      return 'Došel denní limit dotazů projektu. Zkusí se to znovu při dalším běhu.';
    default:
      if (status === 404) return `Verze API nebo účet nenalezeny (${message}). Zkontroluj verzi API v Nastavení.`;
      if (status === 401) return 'Google odmítl přihlášení — přihlas se znovu v Nastavení.';
      return `Google Ads: ${code ? `${code} — ` : ''}${message}`;
  }
}

function headers(cfg: AdsConfig, token: string): Record<string, string> {
  const out: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json'
  };
  const login = cfg.google.loginCustomerId.replace(/\D/g, '');
  if (login) out['login-customer-id'] = login;
  const dev = readSecret(DEVTOKEN_KEY);
  if (dev) out['developer-token'] = dev;
  return out;
}

/** Dotaz GAQL s listováním po stránkách. */
export async function gaql(cfg: AdsConfig, query: string, customerId = cfg.google.customerId): Promise<any[]> {
  const id = customerId.replace(/\D/g, '');
  if (!id) throw new Error('Není vybraný účet Google Ads.');
  const token = await accessToken(cfg);
  const url = `${API}/${cfg.google.apiVersion}/customers/${id}/googleAds:search`;
  const rows: any[] = [];
  let pageToken = '';
  for (let page = 0; page < 50; page++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: headers(cfg, token),
      body: JSON.stringify(pageToken ? { query, pageToken } : { query })
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(explainError(res.status, json));
    rows.push(...(json.results ?? []));
    pageToken = json.nextPageToken ?? '';
    if (!pageToken) break;
  }
  return rows;
}

/** Účty, ke kterým má přihlášený uživatel přístup. */
export async function listCustomers(cfg: AdsConfig): Promise<AdsGoogleCustomer[]> {
  const token = await accessToken(cfg);
  const res = await fetch(`${API}/${cfg.google.apiVersion}/customers:listAccessibleCustomers`, {
    headers: headers(cfg, token)
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(explainError(res.status, json));
  const ids: string[] = (json.resourceNames ?? []).map((name: string) => name.split('/')[1]).filter(Boolean);
  const out: AdsGoogleCustomer[] = [];
  for (const id of ids.slice(0, 20)) {
    try {
      const rows = await gaql(cfg, 'SELECT customer.id, customer.descriptive_name, customer.currency_code, '
        + 'customer.manager FROM customer LIMIT 1', id);
      const c = rows[0]?.customer ?? {};
      out.push({ id, name: c.descriptiveName ?? '', currency: c.currencyCode ?? '', manager: !!c.manager });
    } catch {
      // K účtu je přístup jen přes manažera — ukáže se aspoň číslo
      out.push({ id, name: '', currency: '', manager: false });
    }
  }
  return out;
}

/* ---------- převod odpovědí ---------- */

/** Google posílá int64 jako text a peníze v milióntinách */
const num = (value: unknown) => Number(value ?? 0) || 0;
const micros = (value: unknown) => num(value) / 1_000_000;

export interface CampaignInfo {
  id: string;
  name: string;
  type: string;
  status: string;
  budget: number | null;
  bidding: string;
  targetRoas: number | null;
}

export interface DayRow {
  date: string;
  id: string;
  cost: number;
  clicks: number;
  impressions: number;
  conversions: number;
  value: number;
}

export const CAMPAIGNS_QUERY = 'SELECT campaign.id, campaign.name, campaign.status, '
  + 'campaign.advertising_channel_type, campaign.bidding_strategy_type, '
  + 'campaign.maximize_conversion_value.target_roas, campaign.target_roas.target_roas, '
  + "campaign_budget.amount_micros FROM campaign WHERE campaign.status != 'REMOVED'";

export function campaignDaysQuery(from: string, to: string): string {
  return 'SELECT campaign.id, segments.date, metrics.cost_micros, metrics.clicks, metrics.impressions, '
    + 'metrics.conversions, metrics.conversions_value FROM campaign '
    + `WHERE segments.date BETWEEN '${from}' AND '${to}' AND metrics.impressions > 0`;
}

/**
 * Výkon po produktech. `shopping_performance_view` pokrývá Nákupy
 * i produktovou část Performance Max — to je to, co se dá řídit
 * segmenty ve feedu.
 */
export function productDaysQuery(from: string, to: string): string {
  return 'SELECT segments.date, segments.product_item_id, metrics.cost_micros, metrics.clicks, '
    + 'metrics.impressions, metrics.conversions, metrics.conversions_value FROM shopping_performance_view '
    + `WHERE segments.date BETWEEN '${from}' AND '${to}' AND metrics.impressions > 0`;
}

export function parseCampaigns(rows: any[]): CampaignInfo[] {
  return rows.map(row => {
    const c = row.campaign ?? {};
    const roas = c.maximizeConversionValue?.targetRoas ?? c.targetRoas?.targetRoas;
    const budget = row.campaignBudget?.amountMicros;
    return {
      id: String(c.id ?? ''),
      name: c.name ?? '',
      type: c.advertisingChannelType ?? '',
      status: c.status ?? '',
      budget: budget != null ? micros(budget) : null,
      bidding: c.biddingStrategyType ?? '',
      targetRoas: roas != null && num(roas) > 0 ? num(roas) : null
    };
  }).filter(one => one.id);
}

export function parseCampaignDays(rows: any[]): DayRow[] {
  return rows.map(row => ({
    date: row.segments?.date ?? '',
    id: String(row.campaign?.id ?? ''),
    cost: micros(row.metrics?.costMicros),
    clicks: num(row.metrics?.clicks),
    impressions: num(row.metrics?.impressions),
    conversions: num(row.metrics?.conversions),
    value: num(row.metrics?.conversionsValue)
  })).filter(one => one.date && one.id);
}

/**
 * Produkty sečtené přes kampaně. Jeden produkt může běžet v PMax
 * i v Nákupech zároveň a segment se dívá na produkt, ne na kampaň.
 * ID je malými písmeny, protože tak ho Google v přehledech vrací.
 */
export function parseProductDays(rows: any[]): DayRow[] {
  const map = new Map<string, DayRow>();
  for (const row of rows) {
    const date = row.segments?.date ?? '';
    const id = String(row.segments?.productItemId ?? '').trim().toLowerCase();
    if (!date || !id) continue;
    const key = `${date}|${id}`;
    const one = map.get(key) ?? { date, id, cost: 0, clicks: 0, impressions: 0, conversions: 0, value: 0 };
    one.cost += micros(row.metrics?.costMicros);
    one.clicks += num(row.metrics?.clicks);
    one.impressions += num(row.metrics?.impressions);
    one.conversions += num(row.metrics?.conversions);
    one.value += num(row.metrics?.conversionsValue);
    map.set(key, one);
  }
  return [...map.values()];
}
