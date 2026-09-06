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
  /**
   * Který zdroj v Sequelu se má ptát.
   *
   * Sequel má pod jedním klíčem víc napojených zdrojů (GA4, databáze,
   * HubSpot…) a u dotazu chce vědět který — bez toho odpoví
   * „app_id is required". Nechává se prázdné, dokud se nezjistí: když je
   * zdroj jediný, doplní se sám.
   */
  appId: string;
  /** Co se v Sequelu našlo — na výběr v nastavení */
  apps: { id: string; name: string }[];
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
  let apps: { id: string; name: string }[] = [];
  try { apps = JSON.parse(getSetting('ga4Apps', '[]') || '[]'); } catch { apps = []; }
  return {
    enabled,
    hasKey: !!key,
    endpoint: getSetting('ga4Endpoint', DEFAULT_ENDPOINT)!,
    appId: getSetting('ga4AppId', '')!,
    apps: Array.isArray(apps) ? apps : [],
    lastAt: getSetting('ga4LastAt', '') || null,
    lastError: getSetting('ga4LastError', '') || null,
    ready: enabled && !!key
  };
}

export function saveGa4Config(
  p: { enabled?: boolean; key?: string; endpoint?: string; appId?: string }
): Ga4Config {
  if (p.enabled !== undefined) setSetting('ga4Enabled', p.enabled ? '1' : '0');
  if (p.key !== undefined) setSetting('ga4SequelKey', p.key ? encrypt(p.key.trim()) : '');
  if (p.appId !== undefined) setSetting('ga4AppId', p.appId.trim());
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
 * Nástroje, které server nabízí — i s tím, co po nás chtějí.
 *
 * Hádat jména parametrů byla chyba: Sequel má u dotazu i **`action`** (co se
 * má stát) a **`app_id`** (kterého zdroje se to týká), takže dotaz poslaný
 * jen s textem otázky skončil hláškou „app_id is required when
 * action='connect'" — server si domyslel akci `connect` a chyběl mu zdroj.
 * Schéma každého nástroje ale MCP posílá spolu s ním, takže se argumenty
 * skládají podle něj, ne podle domněnky.
 */
interface ToolInfo {
  name: string;
  description: string;
  schema: any;
}

let toolCache: ToolInfo[] | null = null;

async function listTools(): Promise<ToolInfo[]> {
  if (toolCache) return toolCache;
  const list = await rpc('tools/list', {}, 3);
  const tools: any[] = Array.isArray(list?.tools) ? list.tools : [];
  toolCache = tools.map(one => ({
    name: String(one?.name ?? ''),
    description: String(one?.description ?? ''),
    schema: one?.inputSchema ?? one?.input_schema ?? null
  })).filter(one => one.name);
  if (!toolCache.length) throw new Error('Sequel nenabízí žádný nástroj.');
  return toolCache;
}

/** Co ve schématu odpovídá kterému údaji — podle jména, ne podle pořadí */
const ASKS_QUESTION = /^(query|question|prompt|q|text|input|message|request|task)$/i;
const ASKS_APP = /(app|application|source|connection|integration|database|datasource)_?id$/i;

/** Akce, které něco vrací; `connect` je přihlášení, ne dotaz */
const QUERY_ACTIONS = ['query', 'ask', 'run', 'execute', 'search', 'report', 'read', 'sql'];
const LIST_ACTIONS = ['list_apps', 'list_sources', 'list_connections', 'apps', 'sources', 'list'];

function enumOf(property: any): string[] {
  const values = property?.enum ?? property?.anyOf?.flatMap((one: any) => one?.enum ?? []) ?? [];
  return Array.isArray(values) ? values.map((one: any) => String(one)) : [];
}

/**
 * Argumenty podle schématu nástroje.
 *
 * Vyplní se jen to, co nástroj doopravdy zná: otázka, zdroj a akce. Zbytek
 * povinných polí dostane první hodnotu z výčtu — víc se z popisu vyčíst nedá
 * a prázdný povinný parametr server odmítne.
 */
function argsFor(tool: ToolInfo, values: { question?: string; appId?: string; action?: 'query' | 'list' }):
  Record<string, unknown> {
  const properties = tool.schema?.properties ?? {};
  const required: string[] = Array.isArray(tool.schema?.required) ? tool.schema.required : [];
  const out: Record<string, unknown> = {};

  for (const [name, property] of Object.entries<any>(properties)) {
    const options = enumOf(property);
    if (name.toLowerCase() === 'action' && options.length) {
      const wanted = values.action === 'list' ? LIST_ACTIONS : QUERY_ACTIONS;
      const picked = wanted.map(one => options.find(o => o.toLowerCase() === one))
        .find(Boolean)
        ?? options.find(one => wanted.some(w => one.toLowerCase().includes(w)))
        ?? options.find(one => one.toLowerCase() !== 'connect');
      if (picked) out.action = picked;
      continue;
    }
    if (ASKS_QUESTION.test(name) && values.question) { out[name] = values.question; continue; }
    if (ASKS_APP.test(name) && values.appId) { out[name] = values.appId; continue; }
    // Povinný výčet, kterému nerozumíme: první hodnota je lepší než chybějící
    if (required.includes(name) && options.length && out[name] === undefined) out[name] = options[0];
  }

  /*
   * Schéma nemusí dorazit vůbec. Pak se pošlou obvyklá jména — server si
   * vezme, co zná. Bez `action` se ale neposílá nic, aby si server znovu
   * nedomyslel `connect`.
   */
  if (!Object.keys(properties).length) {
    if (values.question) { out.query = values.question; out.question = values.question; }
    if (values.appId) { out.app_id = values.appId; }
    out.action = values.action === 'list' ? 'list_apps' : 'query';
  }
  return out;
}

/** Nástroj, který se umí zeptat na data */
function queryTool(tools: ToolInfo[]): ToolInfo {
  const likely = tools.find(one => /query|ask|analytics|report|run|sql/i.test(`${one.name} ${one.description}`));
  return likely ?? tools[0];
}

async function connect(): Promise<void> {
  sessionId = null;
  toolCache = null;
  await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'quentino-mail', version: '1.0' }
  }, 1);
  await rpc('notifications/initialized', {}, null);
}

/** Text z odpovědi nástroje — MCP vrací pole bloků, zajímá nás ten textový */
function textOf(result: any): string {
  const parts: string[] = [];
  for (const block of (result?.content ?? []) as any[]) {
    if (typeof block?.text === 'string') parts.push(block.text);
  }
  if (!parts.length && result?.structuredContent && typeof result.structuredContent === 'object') {
    parts.push(JSON.stringify(result.structuredContent));
  }
  return parts.join('\n').trim();
}

/**
 * Které zdroje jsou pod klíčem napojené.
 *
 * Používá se, když v nastavení není vybraný — jediný zdroj se doplní sám,
 * z několika si člověk vybere. Sequel na to nemá zvláštní nástroj, jen jinou
 * akci téhož; když ani ta není, vrátí se prázdno a nic se nerozbije.
 */
export async function ga4Apps(): Promise<{ id: string; name: string }[]> {
  await connect();
  const tools = await listTools();
  const lister = tools.find(one => /app|source|connection|integration|list/i.test(`${one.name} ${one.description}`))
    ?? queryTool(tools);

  let text = '';
  try {
    const result = await rpc('tools/call', {
      name: lister.name,
      arguments: argsFor(lister, { action: 'list' })
    }, 5);
    text = textOf(result);
  } catch {
    return [];
  }

  const found: { id: string; name: string }[] = [];
  const seen = new Set<string>();
  /*
   * Odpověď je volný text s JSONem uvnitř. Hledají se dvojice id + jméno,
   * ať už jsou kdekoli — vyzobat je regulárním výrazem je spolehlivější než
   * hádat, jak hluboko je server zabalil.
   */
  for (const match of text.matchAll(
    /"(?:app_?id|id)"\s*:\s*"([^"]{1,64})"[^}]{0,200}?"(?:name|title|label|app_?name)"\s*:\s*"([^"]{1,80})"/gi
  )) {
    if (seen.has(match[1])) continue;
    seen.add(match[1]);
    found.push({ id: match[1], name: match[2] });
  }
  // Někdy je jméno první a id až za ním
  for (const match of text.matchAll(
    /"(?:name|title|label|app_?name)"\s*:\s*"([^"]{1,80})"[^}]{0,200}?"(?:app_?id|id)"\s*:\s*"([^"]{1,64})"/gi
  )) {
    if (seen.has(match[2])) continue;
    seen.add(match[2]);
    found.push({ id: match[2], name: match[1] });
  }

  if (found.length) setSetting('ga4Apps', JSON.stringify(found.slice(0, 20)));
  // Jediný zdroj se nastaví sám — vybírat z jedné položky nemá smysl
  if (found.length === 1 && !getSetting('ga4AppId', '')) setSetting('ga4AppId', found[0].id);
  return found;
}

/**
 * Položí Sequelu otázku a vrátí odpověď jako text.
 *
 * Používá to i doptávání v přehledu: když se člověk ptá na návštěvnost,
 * odpověď se dohledá tady, ne v objednávkách.
 */
export async function ga4Ask(question: string): Promise<string> {
  await connect();
  const tools = await listTools();
  const tool = queryTool(tools);

  let appId = getSetting('ga4AppId', '')!;
  const needsApp = Object.keys(tool.schema?.properties ?? {}).some(name => ASKS_APP.test(name));
  if (needsApp && !appId) {
    // Zdroj se nevybral — zkusí se dohledat, a když je jediný, použije se
    const apps = await ga4Apps();
    if (apps.length === 1) appId = apps[0].id;
    else if (apps.length > 1) {
      throw new Error(
        `Sequel má víc zdrojů — vyber ten správný v nastavení: ${apps.map(one => one.name).join(', ')}`
      );
    }
    await connect();
  }

  const result = await rpc('tools/call', {
    name: tool.name,
    arguments: argsFor(tool, { question, appId, action: 'query' })
  }, 4);
  const text = textOf(result);
  if (!text) throw new Error('Sequel vrátil prázdnou odpověď.');
  /*
   * Server umí vrátit chybu i jako obyčejný text s dvěstěkou — tohle je
   * přesně ten případ „app_id is required", který se dřív tvářil jako
   * platná odpověď a v přehledu z něj byla nula.
   */
  if (/"status"\s*:\s*"error"|"error"\s*:\s*"/.test(text)) {
    throw new Error(`Sequel: ${text.slice(0, 200)}`);
  }
  return text;
}

/** Co server nabízí — do nastavení, když se automatika netrefí */
export async function ga4Diagnostics(): Promise<string> {
  await connect();
  const tools = await listTools();
  return tools.map(one => {
    const properties = Object.keys(one.schema?.properties ?? {});
    const required = Array.isArray(one.schema?.required) ? one.schema.required : [];
    return `${one.name}(${properties.join(', ') || '—'})`
      + `${required.length ? ` · povinné: ${required.join(', ')}` : ''}`;
  }).join('\n');
}

/* ---------- denní snímek ---------- */

/** `YYYY-MM-DD` pro dotaz — Sequel si má vzít přesná data, ne „posledních 30 dní" */
function dayKey(back: number): string {
  const when = new Date(Date.now() - back * 86_400_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
}

/**
 * Zadání pro Sequel.
 *
 * Dvě věci, na kterých to poprvé selhalo:
 *
 *  - **Vzorová odpověď se samými nulami.** „Odpověz tímhle JSONem" a pod tím
 *    kostra s nulami je pozvánka k tomu ji opsat — a přesně to se stalo:
 *    spojení fungovalo a v přehledu stálo „0 návštěv". Kostra se proto
 *    nepřikládá, jen se vyjmenují klíče, a rovnou se říká, že nuly nemají
 *    co dělat tam, kde data jsou.
 *  - **„Posledních 30 dní" si každý vyloží po svém.** Data se počítají tady
 *    a do dotazu jdou jako konkrétní dny.
 */
function question(): string {
  const from = dayKey(29);
  const to = dayKey(0);
  const prevFrom = dayKey(59);
  const prevTo = dayKey(30);

  return `Spusť v Google Analytics 4 dva reporty a vrať jejich skutečná čísla.

Období A ("window"): ${from} až ${to}.
Období B ("prevWindow"): ${prevFrom} až ${prevTo}.
U obou období metriky: sessions, totalUsers, transactions (nebo purchases / ecommercePurchases) a purchaseRevenue.
Dále za období A pět nejsilnějších hodnot dimenze sessionSourceMedium s počtem sessions.

Odpověz jedním JSONem bez komentáře a bez uvozovacího textu, s klíči:
window a prevWindow (v každém sessions, users, purchases, revenue) a sources (pole s name a sessions).
Čísla musí být skutečné hodnoty z reportu — nuly piš jen tam, kde report opravdu vrátil nulu.
Když se report nepodaří spustit, vrať {"error":"důvod"}.`;
}

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
    const text = await ga4Ask(question());
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    let parsed: any = null;
    if (start >= 0 && end > start) {
      try { parsed = JSON.parse(text.slice(start, end + 1)); } catch { /* zůstane text */ }
    }

    if (parsed?.error) throw new Error(`Sequel: ${String(parsed.error).slice(0, 200)}`);

    const windowPeriod = periodOf(parsed?.window);
    const prevPeriod = periodOf(parsed?.prevWindow);
    /*
     * Samé nuly nejsou odpověď. Buď se vrátila opsaná kostra dotazu, nebo
     * report nic nenašel — v obou případech je poctivější říct, že se čísla
     * nepodařilo přečíst, než ukazovat „0 návštěv" jako fakt.
     */
    const empty = !windowPeriod.sessions && !windowPeriod.users && !windowPeriod.purchases;
    if (empty) {
      throw new Error(`Sequel vrátil samé nuly — zkontroluj zdroj a přístup. Odpověď: ${text.slice(0, 200)}`);
    }
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

/**
 * Zkouška spojení do nastavení.
 *
 * Hlásí i to, co přišlo — „0 návštěv" bez odpovědi se nedalo rozlousknout:
 * nevědělo se, jestli se Sequel nedostal k datům, nebo jen opsal kostru
 * z dotazu.
 */
export async function ga4Test(): Promise<string> {
  const snapshot = await ga4Snapshot(true);
  if (!snapshot) throw new Error('GA4 není zapnuté nebo chybí klíč.');
  if (snapshot.error) throw new Error(snapshot.error);
  const sessions = snapshot.window.sessions;
  return sessions
    ? `Spojení funguje — za posledních 30 dní ${sessions} návštěv.`
    : `Spojení funguje, ale čísla se nepodařilo přečíst. Odpověď: ${snapshot.text.slice(0, 200)}`;
}
