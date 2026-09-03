/**
 * Návštěvnost z Google Analytics přes Sequel (sequel.sh).
 *
 * ## Proč přes Sequel a ne rovnou přes Google
 *
 * Data API od Googlu vyžaduje projekt v Google Cloudu, přihlášení přes OAuth
 * (nebo servisní účet), obnovování tokenů a udržování rozsahů oprávnění —
 * hromadu práce, která s prodejem nemá nic společného. Sequel má GA4 už
 * napojený a ven z něj kouká **obyčejný MCP server přes HTTP** s klíčem
 * v hlavičce. Z aplikace je to tedy jedno volání a žádné přihlašování.
 *
 * ## Jak se s ním mluví
 *
 * MCP je JSON-RPC přes HTTP:
 *
 *  1. `initialize` — server v odpovědi může vrátit hlavičku `Mcp-Session-Id`,
 *     kterou pak chce u všech dalších dotazů,
 *  2. `notifications/initialized` — potvrzení, že klient je připraven,
 *  3. `tools/list` — jak se nástroje jmenují se dopředu neví, takže se to
 *     zjistí a vybere se ten, který umí položit dotaz,
 *  4. `tools/call` — samotná otázka.
 *
 * Odpověď chodí buď jako JSON, nebo jako proud událostí (`text/event-stream`)
 * — obojí se tu přečte, protože který tvar server použije, se řídí jeho
 * náladou, ne naší.
 *
 * ## Co se ptáme
 *
 * Jednou denně jedna otázka, ve které je rovnou napsané, že se má vrátit
 * JSON. Sequel překládá řeč do dotazu na GA4, takže volnou odpověď dostaneme
 * vždycky; když se z ní JSON vyloupnout nepovede, uloží se aspoň text
 * a přehled ho dá modelu tak, jak je. Lepší nepřesná věta než prázdno.
 */
import { getSetting, setSetting } from './db';
import { encrypt, decrypt } from './secure';

const DEFAULT_ENDPOINT = 'https://api.sequel.sh/mcp';
const SNAPSHOT_KEY = 'ga4Snapshot';
const EVERY_MS = 24 * 3600 * 1000;

export interface Ga4Config {
  enabled: boolean;
  hasKey: boolean;
  endpoint: string;
  /** Kdy se naposledy povedlo něco stáhnout */
  lastAt: string | null;
  lastError: string | null;
  ready: boolean;
}

export interface Ga4Period {
  sessions: number | null;
  users: number | null;
  purchases: number | null;
  revenue: number | null;
}

export interface Ga4Snapshot {
  at: string;
  window: Ga4Period;
  prevWindow: Ga4Period;
  /** Odkud lidé chodí — jméno zdroje a počet návštěv */
  sources: { name: string; sessions: number }[];
  /** Konverzní poměr v procentech, dopočítaný z nákupů a návštěv */
  conversion: number | null;
  prevConversion: number | null;
  /** Odpověď tak, jak přišla — když se JSON nevyloupl, je tohle všechno, co máme */
  text: string;
  error: string | null;
}

/* ---------- nastavení ---------- */

export function getGa4Config(): Ga4Config {
  const key = getSetting('ga4SequelKey', '')!;
  const enabled = getSetting('ga4Enabled', '0') === '1';
  return {
    enabled,
    hasKey: !!key,
    endpoint: getSetting('ga4Endpoint', DEFAULT_ENDPOINT)!,
    lastAt: getSetting('ga4LastAt', '') || null,
    lastError: getSetting('ga4LastError', '') || null,
    ready: enabled && !!key
  };
}

export function saveGa4Config(p: { enabled?: boolean; key?: string; endpoint?: string }): Ga4Config {
  if (p.enabled !== undefined) setSetting('ga4Enabled', p.enabled ? '1' : '0');
  if (p.key !== undefined) setSetting('ga4SequelKey', p.key ? encrypt(p.key.trim()) : '');
  if (p.endpoint !== undefined) {
    setSetting('ga4Endpoint', (p.endpoint.trim() || DEFAULT_ENDPOINT).replace(/\/+$/, ''));
  }
  return getGa4Config();
}

function secrets(): { endpoint: string; key: string } {
  const raw = getSetting('ga4SequelKey', '')!;
  const key = raw ? decrypt(raw) : '';
  if (!key) throw new Error('Chybí klíč k Sequelu (Nastavení → AI přehled).');
  return { endpoint: getSetting('ga4Endpoint', DEFAULT_ENDPOINT)!, key };
}

/* ---------- MCP přes HTTP ---------- */

let sessionId: string | null = null;
let toolName: string | null = null;

/**
 * Jedno volání JSON-RPC.
 *
 * Server odpovídá buď JSONem, nebo proudem událostí — v proudu je několik
 * řádků `data: {…}` a ten poslední s naším `id` je odpověď. Rozlišuje se
 * podle hlavičky, ne podle dohadu.
 */
async function rpc(method: string, params: unknown, id: number | null): Promise<any> {
  const { endpoint, key } = secrets();
  const body: any = { jsonrpc: '2.0', method };
  if (params !== undefined) body.params = params;
  if (id !== null) body.id = id;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {})
    },
    body: JSON.stringify(body)
  });

  const given = res.headers.get('mcp-session-id');
  if (given) sessionId = given;

  const text = await res.text();
  if (!res.ok) throw new Error(`Sequel: ${res.status} ${text.slice(0, 200)}`);
  if (id === null) return null;

  const type = res.headers.get('content-type') ?? '';
  if (type.includes('text/event-stream')) {
    let answer: any = null;
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      try {
        const one = JSON.parse(line.slice(5).trim());
        if (one?.id === id) answer = one;
      } catch { /* mezi událostmi bývají i prázdné řádky */ }
    }
    if (!answer) throw new Error('Sequel neposlal odpověď.');
    if (answer.error) throw new Error(`Sequel: ${answer.error.message ?? 'chyba'}`);
    return answer.result;
  }

  const parsed = text ? JSON.parse(text) : null;
  if (parsed?.error) throw new Error(`Sequel: ${parsed.error.message ?? 'chyba'}`);
  return parsed?.result ?? null;
}

/**
 * Který nástroj se umí zeptat.
 *
 * Jmenovat ho natvrdo by znamenalo, že přejmenování na straně Sequelu
 * shodí přehled. Seznam se proto přečte a vybere se první, který podle
 * jména nebo popisu vypadá na dotaz — a když nic nesedí, vezme se první,
 * co tam je: server jich moc nemá.
 */
async function pickTool(): Promise<string> {
  if (toolName) return toolName;
  const list = await rpc('tools/list', {}, 3);
  const tools: any[] = Array.isArray(list?.tools) ? list.tools : [];
  if (!tools.length) throw new Error('Sequel nenabízí žádný nástroj.');

  const likely = tools.find(one => /query|ask|analytics|report|run/i.test(
    `${one?.name ?? ''} ${one?.description ?? ''}`
  ));
  toolName = String((likely ?? tools[0]).name ?? '');
  if (!toolName) throw new Error('Nástroj Sequelu nemá jméno.');
  return toolName;
}

/** Text z odpovědi nástroje — MCP vrací pole bloků, zajímá nás ten textový */
function textOf(result: any): string {
  const parts: string[] = [];
  for (const block of (result?.content ?? []) as any[]) {
    if (typeof block?.text === 'string') parts.push(block.text);
  }
  if (!parts.length && typeof result?.structuredContent === 'object') {
    parts.push(JSON.stringify(result.structuredContent));
  }
  return parts.join('\n').trim();
}

/**
 * Položí Sequelu otázku a vrátí odpověď jako text.
 *
 * Používá to i doptávání v přehledu: když se člověk ptá na návštěvnost,
 * odpověď se dohledá tady, ne v objednávkách.
 */
export async function ga4Ask(question: string): Promise<string> {
  sessionId = null;
  await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'quentino-mail', version: '1.0' }
  }, 1);
  await rpc('notifications/initialized', {}, null);

  const tool = await pickTool();
  /*
   * Jak se jmenuje parametr, taky nevíme — pošle se pod několika obvyklými
   * jmény naráz. Server si vezme, co zná, a zbytek přebývá.
   */
  const args: Record<string, string> = {
    query: question, question, prompt: question, sql: question
  };
  const result = await rpc('tools/call', { name: tool, arguments: args }, 4);
  const text = textOf(result);
  if (!text) throw new Error('Sequel vrátil prázdnou odpověď.');
  return text;
}

/* ---------- denní snímek ---------- */

const QUESTION = `Vrať čísla z Google Analytics 4 za dvě období: posledních 30 dní ("window") a předchozích 30 dní před nimi ("prevWindow").
U každého období: sessions (návštěvy), users (uživatelé), purchases (počet nákupů / transakcí) a revenue (tržba).
Dále 5 nejsilnějších zdrojů návštěv za posledních 30 dní (session source / medium) s počtem návštěv.
Odpověz POUZE tímto JSONem, bez komentáře:
{"window":{"sessions":0,"users":0,"purchases":0,"revenue":0},"prevWindow":{"sessions":0,"users":0,"purchases":0,"revenue":0},"sources":[{"name":"google / organic","sessions":0}]}`;

function num(value: unknown): number | null {
  const one = Number(String(value ?? '').replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(one) ? one : null;
}

function periodOf(raw: any): Ga4Period {
  return {
    sessions: num(raw?.sessions),
    users: num(raw?.users),
    purchases: num(raw?.purchases ?? raw?.transactions),
    revenue: num(raw?.revenue)
  };
}

function conversionOf(period: Ga4Period): number | null {
  if (!period.sessions || period.purchases == null) return null;
  return Math.round((period.purchases / period.sessions) * 1000) / 10;
}

function stored(): Ga4Snapshot | null {
  try {
    const raw = getSetting(SNAPSHOT_KEY, '')!;
    return raw ? JSON.parse(raw) as Ga4Snapshot : null;
  } catch {
    return null;
  }
}

/**
 * Návštěvnost za posledních třicet dní.
 *
 * Ptá se **nejvýš jednou za 24 hodin**, ze stejného důvodu jako postřehy:
 * je to volání ven a čísla se mezi dvěma otevřeními přehledu nezmění tak,
 * aby to stálo za dotaz. Když se dotaz nepovede, vrátí se poslední známý
 * snímek i s poznámkou, proč je starý.
 */
export async function ga4Snapshot(force = false): Promise<Ga4Snapshot | null> {
  const cfg = getGa4Config();
  if (!cfg.ready) return null;

  const last = stored();
  const age = last?.at ? Date.now() - new Date(last.at).getTime() : Number.POSITIVE_INFINITY;
  if (!force && last && age < EVERY_MS) return last;

  try {
    const text = await ga4Ask(QUESTION);
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    let parsed: any = null;
    if (start >= 0 && end > start) {
      try { parsed = JSON.parse(text.slice(start, end + 1)); } catch { /* zůstane text */ }
    }

    const windowPeriod = periodOf(parsed?.window);
    const prevPeriod = periodOf(parsed?.prevWindow);
    const snapshot: Ga4Snapshot = {
      at: new Date().toISOString(),
      window: windowPeriod,
      prevWindow: prevPeriod,
      sources: Array.isArray(parsed?.sources)
        ? parsed.sources
          .map((one: any) => ({ name: String(one?.name ?? '').trim(), sessions: num(one?.sessions) ?? 0 }))
          .filter((one: any) => one.name)
          .slice(0, 5)
        : [],
      conversion: conversionOf(windowPeriod),
      prevConversion: conversionOf(prevPeriod),
      text: text.slice(0, 2000),
      error: null
    };
    setSetting(SNAPSHOT_KEY, JSON.stringify(snapshot));
    setSetting('ga4LastAt', snapshot.at);
    setSetting('ga4LastError', '');
    return snapshot;
  } catch (e: any) {
    const message = String(e?.message ?? e);
    setSetting('ga4LastError', message);
    // Starý snímek je pořád lepší než prázdno — jen se řekne, že je starý
    return last ? { ...last, error: message } : { at: '', window: periodOf(null), prevWindow: periodOf(null), sources: [], conversion: null, prevConversion: null, text: '', error: message };
  }
}

/** Zkouška spojení do nastavení */
export async function ga4Test(): Promise<string> {
  const snapshot = await ga4Snapshot(true);
  if (!snapshot) throw new Error('GA4 není zapnuté nebo chybí klíč.');
  if (snapshot.error) throw new Error(snapshot.error);
  const sessions = snapshot.window.sessions;
  return sessions != null
    ? `Spojení funguje — za posledních 30 dní ${sessions} návštěv.`
    : `Spojení funguje, ale čísla se nepodařilo přečíst. Odpověď: ${snapshot.text.slice(0, 160)}`;
}
