/**
 * Sklik (Seznam.cz) — API Drak, JSON.
 *
 * ## Jak se s ním mluví
 *
 * `POST https://api.sklik.cz/drak/json/v5/<metoda>` a v těle pole
 * parametrů v pořadí podle dokumentace. Prvním parametrem je skoro vždy
 * `{ session, userId? }` — session se získá z API tokenu metodou
 * `client.loginByToken`. Token se vytváří v Skliku (Nastavení účtu →
 * Správa API tokenů — token pro **Drak**; token pro Fenix je pro jiné API
 * a loginByToken ho odmítne) a je tajný jako heslo: ukládá se šifrovaně
 * a mezi Macy ho přenáší jen trezor.
 *
 * Povinné položky se v dokumentaci poznají jen tak, že u nich chybí
 * „(optional)". Patrik (21. 11.) dostal „Bad arguments", protože
 * campaigns.list chce v displayOptions vždy offset a limit — proto se tu
 * stránkuje i tam, kde by stačil jeden dotaz, a chyba 400 vypisuje
 * diagnostiku (které pole chybí), ne jen obecnou hlášku.
 *
 * Peníze jsou v haléřích; tady se hned přepočítají na koruny, aby zbytek
 * modulu počítal stejně jako u Googlu. Konverze a jejich hodnota jsou to,
 * co posílá měřicí kód Skliku na webu.
 *
 * ## Co modul ve Skliku dělá
 *
 * Čte kampaně a denní statistiky a umí změnit denní rozpočet kampaně.
 * Cílové PNO ani nabídky Sklik přes API nastavuje jinak než Google (u Zboží
 * modifikátory, u vyhledávání ruční CPC) — to zatím zůstává v Skliku.
 */
import { getSetting, setSetting } from '../db';
import { encrypt, decrypt } from '../secure';
import type { CampaignInfo, DayRow } from './google';

const API = 'https://api.sklik.cz/drak/json/v5';
const TOKEN_KEY = 'adsSklikToken';

export function sklikToken(): string {
  const raw = getSetting(TOKEN_KEY, '') || '';
  if (!raw) return '';
  try { return decrypt(raw); } catch { return ''; }
}

export function saveSklikToken(token: string): void {
  setSetting(TOKEN_KEY, token.trim() ? encrypt(token.trim()) : '');
  session = null;
}

let session: { value: string; until: number } | null = null;

/** Srozumitelná chyba z odpovědi Drak */
export function explainSklik(status: number, json: any): string {
  const code = Number(json?.status ?? status);
  const list = Array.isArray(json?.diagnostics) ? json.diagnostics : [];
  const diag = list.map((d: any) => d?.id ?? d?.diagnostic ?? '').filter(Boolean);
  // Lidsky: id + co chybí (field) nebo text problému
  const detail = list.map((d: any) => [d?.id, d?.field ? `pole ${d.field}` : '', d?.problemMessage].filter(Boolean).join(' – '))
    .filter(Boolean).join('; ');
  if (code === 401) {
    return 'Sklik odmítl přihlášení — token je neplatný nebo zrušený, nebo je to token pro Fenix. '
      + 'V Skliku (Nastavení účtu → Správa API tokenů) vytvoř token pro API Drak.';
  }
  if (code === 403) return 'Sklik: k účtu není přístup. Když se spravuje cizí účet, vyplň jeho číslo (userId).';
  if (code === 429) return 'Sklik: příliš mnoho dotazů naráz. Zkusí se to znovu při dalším běhu.';
  if (diag.includes('campaign_dayBudget_is_too_low')) return 'Sklik: denní rozpočet je pod minimem, které Sklik dovolí.';
  if (diag.includes('campaign_dayBudget_is_too_high')) return 'Sklik: denní rozpočet je nad maximem, které Sklik dovolí.';
  return `Sklik: ${json?.statusMessage ?? `HTTP ${status}`}${detail ? ` (${detail})` : ''}`;
}

async function call(method: string, params: unknown[]): Promise<any> {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params)
  });
  const json: any = await res.json().catch(() => ({}));
  const code = Number(json?.status ?? res.status);
  if (!res.ok || (code !== 200 && code !== 206)) throw new Error(explainSklik(res.status, json));
  // Každá odpověď nese obnovenou session — ta platí dál
  if (json.session && session) session = { value: json.session, until: Date.now() + 15 * 60_000 };
  return json;
}

async function user(userId: string): Promise<{ session: string; userId?: number }> {
  if (!session || session.until < Date.now()) {
    const token = sklikToken();
    if (!token) throw new Error('Chybí API token Skliku (Reklamy → Nastavení → Sklik).');
    const json = await call('client.loginByToken', [token]);
    if (!json.session) throw new Error('Sklik nevrátil session — token je nejspíš neplatný.');
    session = { value: json.session, until: Date.now() + 15 * 60_000 };
  }
  const id = Number(String(userId ?? '').replace(/\D/g, ''));
  return id ? { session: session.value, userId: id } : { session: session.value };
}

/* ---------- převod odpovědí ---------- */

const kc = (halers: unknown) => (Number(halers) || 0) / 100;

/**
 * Typ kampaně do řeči zbytku modulu: Zboží a produktové kampaně se chovají
 * jako Nákupy (produkty z feedu), vyhledávání jako vyhledávání.
 */
function typeOf(type: string): string {
  if (/zbozi|product/i.test(type)) return 'SHOPPING';
  if (/fulltext|simple/i.test(type)) return 'SEARCH';
  if (/context/i.test(type)) return 'DISPLAY';
  if (/video/i.test(type)) return 'VIDEO';
  return String(type ?? '').toUpperCase();
}

export function parseSklikCampaigns(list: any[]): CampaignInfo[] {
  return (Array.isArray(list) ? list : []).filter(c => c && !c.deleted).map(c => {
    const status = String(c.status ?? '');
    return {
      id: String(c.id ?? ''),
      name: String(c.name ?? ''),
      type: typeOf(String(c.type ?? '')),
      status: /suspend|deleted/i.test(status) ? 'PAUSED' : 'ENABLED',
      budget: c.budget?.dayBudget != null ? kc(c.budget.dayBudget) : (c.dayBudget != null ? kc(c.dayBudget) : null),
      // Ve Skliku se cíl návratnosti přes API nenastavuje — nabízení je ruční
      bidding: 'MANUAL_CPC',
      targetRoas: null,
      budgetId: c.budget?.id != null ? String(c.budget.id) : String(c.id ?? ''),
      budgetShared: false,
      // Jestli kampaň brzdí rozpočet, se pozná ze statistik (exhaustedBudget po dnech) — doplní fetch
      limited: /exhausted_day_budget/i.test(status)
    };
  }).filter(c => c.id);
}

/**
 * Sdílený rozpočet (víc kampaní na jednom rozpočtu) se po kampaních nemění:
 * přidání jedné kampani by ve skutečnosti přidalo všem. Pozná se podle
 * toho, že stejné budget.id má víc kampaní.
 */
export function markShared(list: CampaignInfo[]): CampaignInfo[] {
  const count = new Map<string, number>();
  for (const c of list) if (c.budgetId) count.set(c.budgetId, (count.get(c.budgetId) ?? 0) + 1);
  return list.map(c => ({ ...c, budgetShared: (count.get(c.budgetId ?? '') ?? 0) > 1 }));
}

/**
 * Kampaně, kterým v posledních 7 dnech aspoň třikrát došel rozpočet —
 * u nich má smysl přidávat (stejně jako „Omezeno rozpočtem" v Google Ads).
 */
export function limitedFrom(days: (DayRow & { exhausted?: number })[], to: string): Set<string> {
  const since = new Date(`${to}T12:00:00Z`);
  since.setUTCDate(since.getUTCDate() - 7);
  const from = since.toISOString().slice(0, 10);
  const hits = new Map<string, number>();
  for (const d of days) {
    if (d.date > from && (d.exhausted ?? 0) > 0) hits.set(d.id, (hits.get(d.id) ?? 0) + 1);
  }
  return new Set([...hits].filter(([, n]) => n >= 3).map(([id]) => id));
}

/** Denní statistiky z readReport: každý prvek je kampaň s polem `stats` po dnech */
export function parseSklikReport(report: any[]): (DayRow & { exhausted: number })[] {
  const out: (DayRow & { exhausted: number })[] = [];
  for (const entry of Array.isArray(report) ? report : []) {
    const id = String(entry?.id ?? entry?.campaignId ?? '');
    if (!id) continue;
    for (const st of Array.isArray(entry.stats) ? entry.stats : []) {
      // Datum chodí jako 2026-11-18, 2026-11-18T00:00:00+01:00 nebo (XML-RPC styl) 20261118T00:00:00
      const m = String(st?.date ?? '').match(/^(\d{4})-?(\d{2})-?(\d{2})/);
      if (!m) continue;
      const date = `${m[1]}-${m[2]}-${m[3]}`;
      const row = {
        date, id,
        exhausted: Number(st.exhaustedBudget) || 0,
        cost: kc(st.totalMoney),
        clicks: Number(st.clicks) || 0,
        impressions: Number(st.impressions) || 0,
        conversions: Number(st.conversions) || 0,
        value: kc(st.conversionValue)
      };
      if (row.impressions || row.cost || row.clicks || row.exhausted) out.push(row);
    }
  }
  return out;
}

/* ---------- volání ---------- */

/** Surové kampaně (po stránkách — offset a limit jsou v campaigns.list povinné) */
async function listRaw(userId: string, filter: Record<string, unknown>, columns: string[]): Promise<any[]> {
  const u = await user(userId);
  const out: any[] = [];
  for (let offset = 0; offset < 5000; offset += 100) {
    const json = await call('campaigns.list', [u, filter, { offset, limit: 100, displayColumns: columns }]);
    const page = Array.isArray(json.campaigns) ? json.campaigns : [];
    out.push(...page);
    if (page.length < 100) break;
  }
  return out;
}

export async function sklikCampaigns(userId = ''): Promise<CampaignInfo[]> {
  const raw = await listRaw(userId, { isDeleted: false }, ['id', 'name', 'status', 'type', 'budget.id', 'budget.dayBudget']);
  return markShared(parseSklikCampaigns(raw));
}

export async function sklikDays(from: string, to: string, userId = ''): Promise<(DayRow & { exhausted: number })[]> {
  const u = await user(userId);
  const created = await call('campaigns.createReport', [u,
    { dateFrom: from, dateTo: to, isDeleted: false },
    { statGranularity: 'daily', includeCurrentDayStats: true }]);
  const reportId = created.reportId;
  if (!reportId) return [];
  const total = Number(created.totalCount) || 0;
  const rows: (DayRow & { exhausted: number })[] = [];
  /*
   * Sklik omezuje počet řádků jednoho čtení (kampaně × dny). Při 90 dnech
   * by 100 kampaní na stránku dalo 9 000 řádků; tady se stránka zmenší tak,
   * aby se vešla i do skromného limitu.
   */
  const days = Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1);
  const pageSize = Math.max(1, Math.min(100, Math.floor(3000 / days)));
  for (let offset = 0; offset < Math.max(total, 1); offset += pageSize) {
    const json = await call('campaigns.readReport', [u, reportId, {
      offset, limit: pageSize, allowEmptyStatistics: false,
      displayColumns: ['id', 'name', 'impressions', 'clicks', 'totalMoney', 'conversions', 'conversionValue', 'exhaustedBudget']
    }]);
    rows.push(...parseSklikReport(json.report));
    if (!total) break;
  }
  return rows;
}

/** Denní rozpočet kampaně (Kč) — kontrola před zápisem */
export async function sklikBudgetNow(campaignId: string, userId = ''): Promise<number | null> {
  return (await campaignNow(campaignId, userId)).budget;
}

async function campaignNow(campaignId: string, userId: string): Promise<{ budget: number | null; type: string }> {
  const raw = await listRaw(userId, { ids: [Number(campaignId)] }, ['id', 'type', 'budget.dayBudget']);
  const c = raw[0];
  return { budget: c?.budget?.dayBudget != null ? kc(c.budget.dayBudget) : null, type: String(c?.type ?? '') };
}

/**
 * Změna denního rozpočtu. Sklik nemá „naoko" pro update, takže přesnost
 * hlídá kontrola aktuální hodnoty před zápisem (proposals.execute).
 * campaigns.update chce u kampaně vždy i `type` (měnit ho nejde, ale bez
 * něj vrátí Bad arguments) — přečte se těsně před zápisem.
 */
export async function sklikSetBudget(campaignId: string, kcPerDay: number, userId = ''): Promise<void> {
  const { type } = await campaignNow(campaignId, userId);
  if (!type) throw new Error(`Sklik: kampaň ${campaignId} se nenašla.`);
  const u = await user(userId);
  await call('campaigns.update', [u, [{ id: Number(campaignId), type, dayBudget: Math.round(kcPerDay) * 100 }]]);
}

/**
 * Zkouška připojení pro Nastavení. Kromě počtu kampaní ukáže i útratu za
 * posledních 7 dní — podle ní se pozná, že čísla sedí se Sklikem
 * (haléře vs. koruny), dřív než se z nich začne počítat zisk.
 */
export async function sklikTest(userId = ''): Promise<string> {
  session = null;
  const list = await sklikCampaigns(userId);
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
  let spend = '';
  try {
    const days = await sklikDays(from, to, userId);
    const cost = days.filter(d => d.date < to).reduce((s, d) => s + d.cost, 0);
    spend = `, útrata za posledních 7 dní ${Math.round(cost).toLocaleString('cs-CZ')} Kč — porovnej se Sklikem`;
  } catch (err: any) {
    spend = ` (statistiky zatím nejdou: ${err?.message ?? err})`;
  }
  return `${list.length} kampaní (${list.filter(c => c.status === 'ENABLED').length} aktivních)${spend}`;
}
