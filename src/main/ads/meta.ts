/**
 * Meta (Facebook a Instagram reklamy) — Marketing API přes Graph API.
 *
 * ## Připojení
 *
 * Tokenem **systémového uživatele** z Business Manageru (Nastavení firmy →
 * Uživatelé → Systémoví uživatelé → Vygenerovat token, oprávnění
 * `ads_read` a pro změny rozpočtů `ads_management`). Takový token
 * nevyprší a nepotřebuje přihlašovací okno ani schválení aplikace — stejná
 * úvaha jako u servisního účtu Google. Token je tajný: ukládá se šifrovaně
 * a mezi Macy ho přenáší jen trezor. Do adresy se nedává (posílá se
 * v hlavičce Authorization), aby se neobjevil v logu proxy.
 *
 * ## Co modul s Metou dělá
 *
 * Čte kampaně a denní výkon (útrata, nákupy a jejich hodnota z pixelu)
 * a umí změnit denní rozpočet kampaně s rozpočtem na úrovni kampaně
 * (Advantage+ / CBO). Kampaň s rozpočty po sadách reklam se jen čte —
 * měnit by se musel každý rozpočet zvlášť.
 *
 * Částky v API jsou v nejmenších jednotkách měny účtu (haléře, centy) —
 * u rozpočtů; útrata v insights je naopak v celých jednotkách. Obojí se
 * tu převádí na měnu účtu, přepočet na koruny dělá zbytek modulu.
 */
import { getSetting, setSetting } from '../db';
import { encrypt, decrypt } from '../secure';
import type { CampaignInfo, DayRow } from './google';

const TOKEN_KEY = 'adsMetaToken';
export const META_VERSION = 'v26.0';
const GRAPH = `https://graph.facebook.com/${META_VERSION}`;

export function metaToken(): string {
  const raw = getSetting(TOKEN_KEY, '') || '';
  if (!raw) return '';
  try { return decrypt(raw); } catch { return ''; }
}

export function saveMetaToken(token: string): void {
  setSetting(TOKEN_KEY, token.trim() ? encrypt(token.trim()) : '');
}

/** Srozumitelná chyba z odpovědi Graph API */
export function explainMeta(status: number, json: any): string {
  const e = json?.error ?? {};
  const code = Number(e.code);
  if (code === 190) return 'Meta odmítla token — je neplatný nebo zrušený. Vygeneruj v Business Manageru nový token systémového uživatele.';
  if ([10, 200, 294].includes(code) || (code >= 200 && code < 300)) {
    return 'Meta: token nemá oprávnění k reklamnímu účtu. Systémový uživatel potřebuje přístup k účtu a oprávnění ads_read '
      + '(pro změny rozpočtů i ads_management).';
  }
  if ([4, 17, 613, 80004].includes(code)) return 'Meta: příliš mnoho dotazů — zkusí se to znovu při dalším běhu.';
  const msg = e.error_user_msg || e.message || `HTTP ${status}`;
  return `Meta: ${msg}`;
}

async function graph(path: string, params: Record<string, string> = {}, method: 'GET' | 'POST' = 'GET'): Promise<any> {
  const token = metaToken();
  if (!token) throw new Error('Chybí token Meta (Reklamy → Nastavení → Meta).');
  const url = path.startsWith('http') ? new URL(path) : new URL(`${GRAPH}/${path.replace(/^\//, '')}`);
  // Token z adresy „další stránky" pryč — jde v hlavičce
  url.searchParams.delete('access_token');
  const init: RequestInit = { method, headers: { Authorization: `Bearer ${token}` } };
  if (method === 'GET') {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  } else {
    init.body = new URLSearchParams(params);
  }
  const res = await fetch(url, init);
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || json?.error) throw new Error(explainMeta(res.status, json));
  return json;
}

/** Všechny stránky výsledku (Graph API stránkuje přes paging.next) */
async function all(path: string, params: Record<string, string>): Promise<any[]> {
  const out: any[] = [];
  let json = await graph(path, params);
  for (let page = 0; page < 50; page++) {
    out.push(...(Array.isArray(json.data) ? json.data : []));
    const next = json?.paging?.next;
    if (!next) break;
    json = await graph(next);
  }
  return out;
}

/* ---------- převod odpovědí ---------- */

export interface MetaAccount { id: string; name: string; currency: string; active: boolean }

const actId = (id: string) => (String(id).startsWith('act_') ? String(id) : `act_${String(id).replace(/\D/g, '')}`);

export function parseAccounts(list: any[]): MetaAccount[] {
  return (Array.isArray(list) ? list : []).map(a => ({
    id: actId(a.id ?? a.account_id ?? ''),
    name: String(a.name ?? a.account_id ?? ''),
    currency: String(a.currency ?? 'CZK').toUpperCase(),
    // 1 = aktivní; ostatní (zablokovaný, neuhrazený…) se ukážou, ale nedoporučí
    active: Number(a.account_status) === 1
  })).filter(a => a.id !== 'act_');
}

/** Typ kampaně podle cíle do řeči zbytku modulu */
function typeOf(objective: string): string {
  if (/SALES|CONVERSIONS|PRODUCT_CATALOG/i.test(objective)) return 'SALES';
  if (/TRAFFIC|LINK_CLICKS/i.test(objective)) return 'TRAFFIC';
  if (/AWARENESS|REACH|BRAND/i.test(objective)) return 'AWARENESS';
  if (/ENGAGEMENT|VIDEO_VIEWS|POST_ENGAGEMENT/i.test(objective)) return 'ENGAGEMENT';
  return String(objective ?? '').replace(/^OUTCOME_/, '') || 'OTHER';
}

export function parseMetaCampaigns(list: any[]): CampaignInfo[] {
  return (Array.isArray(list) ? list : []).map(c => {
    const daily = c.daily_budget != null && c.daily_budget !== '' ? Number(c.daily_budget) / 100 : null;
    return {
      id: String(c.id ?? ''),
      name: String(c.name ?? ''),
      type: typeOf(String(c.objective ?? '')),
      status: String(c.effective_status ?? c.status ?? '') === 'ACTIVE' ? 'ENABLED' : 'PAUSED',
      budget: daily,
      bidding: String(c.bid_strategy ?? 'LOWEST_COST_WITHOUT_CAP'),
      targetRoas: null,
      // Rozpočet po sadách reklam (bez daily_budget na kampani) se přes kampaň měnit nedá
      budgetId: daily != null ? String(c.id) : '',
      budgetShared: false,
      limited: false
    };
  }).filter(c => c.id);
}

/**
 * Nákupy z `actions`. Meta hlásí tentýž nákup pod víc typy (omni_purchase
 * zahrnuje web i aplikaci, purchase a offsite_conversion.fb_pixel_purchase
 * jsou z pixelu) — sečíst je by nákupy zdvojilo. Bere se první, který je.
 */
const PURCHASE = ['omni_purchase', 'purchase', 'offsite_conversion.fb_pixel_purchase'];

function purchaseOf(list: any): number {
  const rows = Array.isArray(list) ? list : [];
  for (const type of PURCHASE) {
    const hit = rows.find((a: any) => a?.action_type === type);
    if (hit) return Number(hit.value) || 0;
  }
  return 0;
}

export function parseMetaInsights(rows: any[]): DayRow[] {
  return (Array.isArray(rows) ? rows : []).map(r => ({
    date: String(r.date_start ?? '').slice(0, 10),
    id: String(r.campaign_id ?? ''),
    cost: Number(r.spend) || 0,
    clicks: Number(r.clicks) || 0,
    impressions: Number(r.impressions) || 0,
    conversions: purchaseOf(r.actions),
    value: purchaseOf(r.action_values)
  })).filter(r => r.date && r.id && (r.cost || r.impressions || r.clicks));
}

/* ---------- volání ---------- */

export async function metaAccounts(): Promise<MetaAccount[]> {
  return parseAccounts(await all('me/adaccounts', { fields: 'account_id,name,currency,account_status', limit: '100' }));
}

export async function metaCampaigns(accountId: string): Promise<CampaignInfo[]> {
  return parseMetaCampaigns(await all(`${actId(accountId)}/campaigns`, {
    fields: 'id,name,objective,status,effective_status,daily_budget,lifetime_budget,bid_strategy',
    limit: '200'
  }));
}

export async function metaDays(accountId: string, from: string, to: string): Promise<DayRow[]> {
  return parseMetaInsights(await all(`${actId(accountId)}/insights`, {
    level: 'campaign',
    time_increment: '1',
    time_range: JSON.stringify({ since: from, until: to }),
    fields: 'campaign_id,campaign_name,spend,impressions,clicks,actions,action_values',
    limit: '500'
  }));
}

/** Denní rozpočet kampaně v měně účtu — kontrola před zápisem */
export async function metaBudgetNow(campaignId: string): Promise<number | null> {
  const json = await graph(String(campaignId), { fields: 'daily_budget' });
  return json.daily_budget != null && json.daily_budget !== '' ? Number(json.daily_budget) / 100 : null;
}

/** Změna denního rozpočtu (v měně účtu); Meta chce nejmenší jednotky */
export async function metaSetBudget(campaignId: string, perDay: number): Promise<void> {
  await graph(String(campaignId), { daily_budget: String(Math.round(perDay * 100)) }, 'POST');
}

/** Zkouška: účet, počet kampaní a útrata za 7 dní (ať jde porovnat se Správcem reklam) */
export async function metaTest(accountId: string): Promise<string> {
  const list = await metaCampaigns(accountId);
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
  let spend = '';
  try {
    const days = await metaDays(accountId, from, to);
    const cost = days.filter(d => d.date < to).reduce((s, d) => s + d.cost, 0);
    spend = `, útrata za posledních 7 dní ${Math.round(cost).toLocaleString('cs-CZ')} (v měně účtu) — porovnej se Správcem reklam`;
  } catch (err: any) {
    spend = ` (statistiky zatím nejdou: ${err?.message ?? err})`;
  }
  return `${list.length} kampaní (${list.filter(c => c.status === 'ENABLED').length} aktivních)${spend}`;
}
