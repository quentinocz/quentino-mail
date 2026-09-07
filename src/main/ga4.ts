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
  /**
   * Který web ta čísla měří.
   *
   * GA4 je zatím napojené jen na český web, kdežto objednávky chodí ze všech
   * trhů. Bez tohohle by konverze vycházela nesmyslně — návštěvy jednoho
   * webu proti objednávkám ze čtyř. Až přibude .sk a .com, přidají se do
   * `ga4Sources` a tohle bude jejich soupis.
   */
  scope: string;
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

/**
 * Volání ven **přes síťovou vrstvu Electronu**, ne přes Node.
 *
 * `fetch` v Node má vlastní stack: neumí systémový proxy, jinak si poradí
 * s IPv6 a na navázání spojení má napevno deset vteřin. Když se k Sequelu
 * nedostal, hlásil „Connect Timeout Error (api.sequel.sh:443, 10000ms)" —
 * přestože týž server v prohlížeči na stejném počítači běžně odpoví.
 *
 * `net.fetch` jde přes Chromium: stejné proxy, stejné DNS, stejné střídání
 * IPv6/IPv4 jako v prohlížeči. Mimo Electron (zkoušky) se použije obyčejný
 * `fetch`, aby se dalo napojení zkoušet i bez okna.
 */
async function httpFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { net } = require('electron');
    if (net?.fetch) return await net.fetch(url, init as any);
  } catch { /* mimo Electron: zkouší se obyčejným fetchem */ }
  return fetch(url, init);
}

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

  /*
   * Spojení se svým stropem a jedním opakováním.
   *
   * Sequel na dotaz do Google Analytics klidně počítá minutu a spojení se
   * mezitím rozpadne — z toho v okně bylo holé „fetch failed", ve kterém
   * není ani adresa, ani důvod. Strop je dvě minuty (report tak dlouho
   * trvat může), a jedno klopýtnutí sítě se zkusí znovu, protože druhý
   * pokus obvykle projde.
   */
  const send = () => httpFetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {})
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000)
  });

  let res: Response;
  try {
    res = await send();
  } catch (first: any) {
    try {
      res = await send();
    } catch (again: any) {
      const why = String(again?.cause?.message ?? again?.cause?.code ?? again?.message ?? again);
      const host = (() => { try { return new URL(endpoint).host; } catch { return endpoint; } })();
      /*
       * „Connect Timeout" znamená, že spojení se vůbec nenavázalo — server
       * neodpověděl na zaklepání. Za to nemůže klíč ani zdroj, a rada
       * „zkontroluj adresu" je tu k ničemu: buď je server dole, nebo se
       * k němu tahle síť nedostane.
       */
      if (/connect timeout|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|EAI_AGAIN/i.test(why)) {
        throw new Error(
          `Server ${host} se neozval (${why.slice(0, 80)}). Buď je dočasně nedostupný, `
          + 'nebo se k němu tahle síť nedostane — zkus to za chvíli.'
        );
      }
      throw new Error(
        again?.name === 'TimeoutError'
          ? `Sequel (${host}) neodpověděl do dvou minut — zkus to znovu později.`
          : `Nepodařilo se spojit se Sequelem (${host}): ${why}. Zkontroluj internet a adresu v nastavení.`
      );
    }
  }

  const given = res.headers.get('mcp-session-id');
  if (given) sessionId = given;

  const text = await res.text();
  /*
   * Stavový kód se vyplatí přeložit do češtiny. „404" u koncového bodu
   * neznamená chybu dat, ale že na téhle adrese MCP vůbec není — a „401"
   * že neplatí klíč. Bez toho se obojí čte jako záhadné číslo.
   */
  if (!res.ok) {
    if (res.status === 404 || res.status === 405) {
      throw new Error(
        `Na adrese ${endpoint} žádné MCP není (${res.status}). Zkontroluj adresu koncového bodu `
        + 'v nastavení — Sequel ji ukazuje u napojení.'
      );
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Sequel klíč nepřijal (${res.status}) — vlož nový v nastavení.`);
    }
    throw new Error(`Sequel: ${res.status} ${text.slice(0, 200)}`);
  }
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
const ASKS_QUESTION = /^(query|question|prompt|q|text|input|message|request|task|use_?case|goal|objective|ask)$/i;
const ASKS_APP = /^(app|application|source|connection|integration|database|datasource)_?ids?$/i;
/**
 * Popis toho, co zrovna děláme.
 *
 * Sequel chce u každého nástroje `action_info` — větu, proč se ptáme. Je to
 * povinné pole bez výčtu, takže se nedalo vyplnit ničím a server dotaz
 * odmítal. Píše se tam prostá čeština; nic se z ní nepočítá, jen se to
 * u něj objeví v přehledu volání.
 */
const ASKS_WHY = /^(action_?info|reason|purpose|why|description|note|context|intent)$/i;

/** Je parametr pole? Pak se hodnota musí zabalit, jinak ji server odmítne */
function isArray(property: any): boolean {
  if (property?.type === 'array') return true;
  return Array.isArray(property?.anyOf) && property.anyOf.some((one: any) => one?.type === 'array');
}

/**
 * Akce nástroje.
 *
 * Sequel má jeden nástroj a v něm výčet akcí: `connect` naváže spojení,
 * `list` vypíše napojené zdroje a teprve něco třetího se doopravdy ptá.
 * Pořadí tady je pořadí, ve kterém se to zkouší — a `connect` ani `list`
 * mezi dotazy nepatří ani jako poslední možnost. Když se totiž pošle `list`,
 * server ochotně odpoví seznamem spojení a v přehledu z toho byly samé nuly.
 */
const QUERY_ACTIONS = [
  'query', 'run_query', 'execute_query', 'sql_query', 'run_sql', 'ask',
  'run', 'execute', 'search', 'report', 'analytics', 'fetch', 'read', 'sql', 'data'
];
const LIST_ACTIONS = ['list_apps', 'list_sources', 'list_connections', 'apps', 'sources', 'connections', 'list'];
/**
 * Akce, které nikdy nevrátí data — ať se na ně nikdy nespadne jako na náhradu.
 *
 * Kotva na začátku tady byla chyba: `reconnect` jí prošel, poslal se jako
 * dotaz a Sequel na něj odpověděl `{"action":"reconnect","status":"pending"}`
 * — což vypadalo jako odpověď a v přehledu z toho nebylo nic. Hledá se proto
 * kdekoli ve jméně.
 */
const NEVER_QUERY =
  /(connect|disconnect|list|describe|schema|tables|status|health|ping|auth|oauth|install|register|create|update|delete|remove|refresh|login|signin|token)/i;

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
function argsFor(
  tool: ToolInfo,
  values: { question?: string; appId?: string; action?: 'query' | 'list'; why?: string }
): Record<string, unknown> {
  const properties = tool.schema?.properties ?? {};
  const required: string[] = Array.isArray(tool.schema?.required) ? tool.schema.required : [];
  const out: Record<string, unknown> = {};

  for (const [name, property] of Object.entries<any>(properties)) {
    const options = enumOf(property);
    if (name.toLowerCase() === 'action' && options.length) {
      const picked = values.action === 'list' ? pickListAction(options) : pickQueryAction(options)[0];
      if (picked) out.action = picked;
      continue;
    }
    if (ASKS_QUESTION.test(name) && values.question) {
      out[name] = isArray(property) ? [values.question] : values.question;
      continue;
    }
    if (ASKS_APP.test(name) && values.appId) {
      // `connection_ids` je pole, `connection_id` text — řídí se to schématem
      out[name] = isArray(property) ? [values.appId] : values.appId;
      continue;
    }
    // Povinná věta „proč se ptáme" — bez ní Sequel dotaz odmítne
    if (ASKS_WHY.test(name) && (required.includes(name) || values.why)) {
      out[name] = values.why ?? 'Denní přehled e-shopu Quentino — návštěvnost za posledních 30 dní.';
      continue;
    }
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

/**
 * Akce, kterými má smysl se ptát — v pořadí, v jakém se zkusí.
 *
 * Vrací víc než jednu schválně: jak se u Sequelu ta správná jmenuje, se
 * z výčtu poznat nedá (`query`, `run_query`, `execute`…), takže se první
 * nepovedená prostě vymění za další.
 */
function pickQueryAction(options: string[]): string[] {
  const byName = QUERY_ACTIONS
    .map(want => options.find(one => one.toLowerCase() === want))
    .filter((one): one is string => !!one);
  const byPart = options.filter(one =>
    !NEVER_QUERY.test(one) && QUERY_ACTIONS.some(want => one.toLowerCase().includes(want)));
  const rest = options.filter(one => !NEVER_QUERY.test(one));
  const picked = [...new Set([...byName, ...byPart, ...rest])];
  if (picked.length) return picked;

  /*
   * Ani jedna akce nevypadá jako dotaz.
   *
   * Tohle už jednou zabolelo: seznam se přefiltroval do prázdna, smyčka
   * neproběhla vůbec a v okně stálo „zkoušené akce: " — bez jediné akce
   * a bez odpovědi, ze které by se dalo poznat proč. Zkusit se má vždycky
   * něco: připojení a odpojení jsou jediné dvě, které opravdu nemají co
   * vrátit, zbytek za pokus stojí.
   */
  const usable = options.filter(one => !/^(re)?connect$|^disconnect$/i.test(one.trim()));
  return usable.length ? usable : options;
}

function pickListAction(options: string[]): string | undefined {
  return LIST_ACTIONS.map(want => options.find(one => one.toLowerCase() === want)).find(Boolean)
    ?? options.find(one => /list|apps|sources|connections/i.test(one));
}

/** Nástroj, který se umí zeptat na data */
/**
 * Nástroj, který se umí zeptat na data.
 *
 * Sequel jich nabízí víc a jeden z nich je **správce spojení**
 * (`sequel_manage_connections`) — ten umí `list`, `connect` a `reconnect`
 * a na návštěvnost se ho ptát nedá. Přesně na něm napojení uvázlo: vybral se
 * jako dotazovací, žádná jeho akce nevypadala jako dotaz a v okně z toho
 * bylo „zkoušené akce: ".
 *
 * Rozhoduje proto **schéma, ne jméno**: nástroj, který se umí zeptat, má
 * v parametrech místo pro otázku (`query`, `question`, `prompt`…). Správci
 * spojení se vyhýbáme rovnou — ten má jen `action`, `app_id` a
 * `connection_id`.
 */
const MANAGES = /manage|connection|auth|admin|setup|install|integration/i;

function asksQuestion(tool: ToolInfo): boolean {
  return Object.keys(tool.schema?.properties ?? {}).some(name => ASKS_QUESTION.test(name));
}

function queryTool(tools: ToolInfo[]): ToolInfo {
  const usable = tools.filter(one => !MANAGES.test(one.name));
  return usable.find(asksQuestion)
    ?? tools.find(asksQuestion)
    ?? usable.find(one => /query|ask|analytics|report|run|sql|data/i.test(`${one.name} ${one.description}`))
    ?? usable[0]
    ?? tools[0];
}

/**
 * Nástroj, který dotaz teprve **spustí**.
 *
 * Sequel nemá jeden nástroj na dotaz, ale dva kroky: `sequel_search` řekne,
 * co se s napojeným zdrojem dá dělat, a `sequel_execute` to provede —
 * hledání samo o sobě čísla nevrátí. Pozná se podle `tool_calls`
 * v parametrech; když takový nástroj není, druhý krok se přeskočí.
 */
function runTool(tools: ToolInfo[]): ToolInfo | null {
  return tools.find(one => Object.keys(one.schema?.properties ?? {})
    .some(name => /^(tool_?calls|calls|steps|plan)$/i.test(name))) ?? null;
}

/** Nástroj, který vypíše napojené zdroje — u Sequelu je to správce spojení */
function listTool(tools: ToolInfo[]): ToolInfo {
  return tools.find(one => MANAGES.test(one.name))
    ?? tools.find(one => /app|source|connection|integration|list/i.test(`${one.name} ${one.description}`))
    ?? queryTool(tools);
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
  const lister = listTool(tools);

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

  const found = connectionsIn(text);
  if (found.length) setSetting('ga4Apps', JSON.stringify(found.slice(0, 20)));
  /*
   * Vybírat se nemusí, když je jasno: jediný zdroj, nebo jediný, který je
   * Google Analytics. Sequel u každého spojení hlásí `type`, takže se
   * databáze ani HubSpot na návštěvnost ptát nebudou.
   */
  const analytics = found.filter(one => /analytic|ga4/i.test(`${one.type} ${one.name}`));
  const obvious = analytics.length === 1 ? analytics[0] : (found.length === 1 ? found[0] : null);
  if (obvious && !getSetting('ga4AppId', '')) setSetting('ga4AppId', obvious.id);
  return found;
}

/**
 * Spojení vytažená z odpovědi.
 *
 * Sequel je vrací jako `{"connections":[{"connection_id":"…","name":"GA4 —
 * …","type":"google_analytics"}]}`, ale jistota to není — jiné verze mohou
 * použít `app_id` nebo `id`. Hledá se proto v textu, ne v pevné cestě, a
 * jméno se bere z okolí id.
 */
function connectionsIn(text: string): { id: string; name: string; type: string }[] {
  const out: { id: string; name: string; type: string }[] = [];
  const seen = new Set<string>();

  /*
   * Napojená spojení, ne nabídka.
   *
   * Odpověď nese vedle `connections` i `available_apps` — **katalog toho, co
   * by se dalo napojit** (PostgreSQL, Stripe, HubSpot…). Bez rozlišení se do
   * výběru zdrojů dostalo šestnáct věcí, které nikdo nemá, a ta jediná
   * skutečná se v nich ztratila. Když v odpovědi `connections` je, platí
   * jenom ono.
   */
  const parsed = jsonIn(text);
  const listed = parsed ? findArray(parsed, 'connections') : null;
  if (Array.isArray(listed) && listed.length) {
    for (const one of listed) {
      const id = String(one?.connection_id ?? one?.id ?? one?.app_id ?? '').trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        name: String(one?.name ?? one?.title ?? id),
        type: String(one?.type ?? one?.app_id ?? '')
      });
    }
    return out;
  }
  const ID = '(?:connection_?id|datasource_?id|source_?id|app_?id|id)';
  const NAME = '(?:name|title|label|app_?name)';

  const add = (id: string, name: string, type: string) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push({ id, name: name || id, type });
  };

  for (const match of text.matchAll(
    new RegExp(`"${ID}"\\s*:\\s*"([^"]{1,64})"([^}]{0,300})`, 'gi')
  )) {
    const around = match[2] ?? '';
    add(match[1],
      (around.match(new RegExp(`"${NAME}"\\s*:\\s*"([^"]{1,80})"`, 'i')) ?? [])[1] ?? '',
      (around.match(/"type"\s*:\s*"([^"]{1,40})"/i) ?? [])[1] ?? '');
  }
  // Někdy je jméno první a id až za ním
  for (const match of text.matchAll(
    new RegExp(`"${NAME}"\\s*:\\s*"([^"]{1,80})"([^}]{0,300}?)"${ID}"\\s*:\\s*"([^"]{1,64})"`, 'gi')
  )) {
    add(match[3], match[1], (match[2].match(/"type"\s*:\s*"([^"]{1,40})"/i) ?? [])[1] ?? '');
  }
  return out;
}

/** Největší JSON v textu — servery ho rády obalí větou */
function jsonIn(text: string): any {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

/** Pole pod daným klíčem, ať je v odpovědi zanořené jakkoli hluboko */
function findArray(node: any, key: string, depth = 0): any[] | null {
  if (!node || typeof node !== 'object' || depth > 6) return null;
  if (Array.isArray(node[key])) return node[key];
  for (const value of Object.values(node)) {
    const found = findArray(value, key, depth + 1);
    if (found) return found;
  }
  return null;
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

  /*
   * Jak se u Sequelu jmenuje akce, která se doopravdy ptá, se z výčtu
   * poznat nedá — `query`, `run_query`, `execute`… Zkusí se proto po řadě
   * a odpověď se pokaždé přečte: když přišel **seznam spojení**, je to
   * důkaz, že se poslala špatná akce (přesně z toho byly v přehledu nuly),
   * a jde se na další. Chyba schovaná v textu se bere stejně.
   */
  const properties = tool.schema?.properties ?? {};
  const actions = enumOf((properties as any).action ?? (properties as any).Action);
  // Prázdný seznam znamená „zkus to bez akce" — ne „nezkoušej nic"
  const candidates = actions.length ? pickQueryAction(actions) : [''];
  const offered = actions.length ? actions.join(', ') : 'nástroj žádné akce nenabízí';

  let last = '';
  const tried: string[] = [];
  const whyWeAsk = 'Denní přehled e-shopu Quentino — návštěvnost za posledních 30 dní.';
  for (const [index, action] of candidates.slice(0, 4).entries()) {
    const args = argsFor(tool, { question, appId, action: 'query', why: whyWeAsk });
    if (action) args.action = action;
    tried.push(action || tool.name);

    let text = textOf(await rpc('tools/call', { name: tool.name, arguments: args }, 4 + index));
    if (!text) { last = 'prázdná odpověď'; continue; }
    last = text;

    const reconnect = needsReconnect(text);
    if (reconnect) throw new Error(reconnect);

    /*
     * Druhý krok. Sequel na dotaz nejdřív odpoví **návrhem, co spustit**
     * (`tool_calls`) — čísla v tom nejsou. Teprve `sequel_execute` je
     * provede. Bez tohohle kroku se v přehledu ukazoval plán místo dat.
     */
    /*
     * Návod k použití zdroje.
     *
     * `sequel_search` nevrací hotové kroky, ale **výsledky hledání** — a
     * u nich číslo návodu (`skill_id`). Ten návod je jediné místo, kde je
     * napsané, co se dá spustit; přečte se a přiloží k odpovědi, aby se
     * z toho daly poskládat kroky pro spuštění.
     */
    const results = findArray(jsonIn(text), 'results');
    const reader = tools.find(one => /read_skill|skill|docs|help/i.test(one.name));
    const skillId = results?.map(one => one?.skill_id ?? one?.id ?? one?.skill)
      .find(one => typeof one === 'string' && one);
    if (skillId && reader) {
      /*
       * Návod je jen k pochopení, ne k výsledku. Když se ho nepodaří
       * přečíst, nesmí to shodit celý dotaz — první krok už proběhl a jeho
       * odpověď se pořád hodí víc než holé „fetch failed".
       */
      try {
        const readArgs = argsFor(reader, { question, appId, why: whyWeAsk });
        for (const name of Object.keys(reader.schema?.properties ?? {})) {
          if (/skill_?id|doc_?id|id$/i.test(name)) readArgs[name] = skillId;
        }
        const manual = textOf(await rpc('tools/call', { name: reader.name, arguments: readArgs }, 60 + index));
        tried.push(`${reader.name} (${skillId})`);
        if (manual) { last = `${text}\n\n--- návod ${skillId} ---\n${manual}`; }
      } catch (e: any) {
        last = `${text}\n\n--- návod ${skillId} se nepodařilo přečíst: ${String(e?.message ?? e)} ---`;
      }
    }

    const plan = findArray(jsonIn(text), 'tool_calls') ?? findArray(jsonIn(last), 'tool_calls');
    const runner = runTool(tools);
    if (plan?.length && runner) {
      const runArgs = argsFor(runner, { question, appId, why: whyWeAsk });
      for (const [name, property] of Object.entries<any>(runner.schema?.properties ?? {})) {
        if (/^(tool_?calls|calls|steps|plan)$/i.test(name)) {
          runArgs[name] = isArray(property) ? plan : JSON.stringify(plan);
        }
        // Sezení z prvního kroku, když ho druhý chce
        if (/^session_?id$/i.test(name)) {
          const session = String(jsonIn(text)?.session_id ?? jsonIn(text)?.data?.session_id ?? '');
          if (session) runArgs[name] = session;
        }
      }
      // Spuštění taky nesmí shodit celý dotaz — návrh z prvního kroku je
      // pořád k něčemu a v nastavení je pak vidět, na čem to skončilo
      try {
        const done = textOf(await rpc('tools/call', { name: runner.name, arguments: runArgs }, 40 + index));
        tried.push(`${runner.name} (${plan.length} kroků)`);
        if (done) { text = done; last = done; }
      } catch (e: any) {
        last = `${last}\n\n--- spuštění selhalo: ${String(e?.message ?? e)} ---`;
      }
    }

    if (looksLikeListing(text)) continue;
    if (/"status"\s*:\s*"error"|"error"\s*:\s*"/.test(text)) continue;
    return text;
  }

  /*
   * Hláška se čte z bubliny na telefonu, takže musí být krátká a říct, co
   * dál. Celá odpověď serveru se schová do nastavení — tam je na ni místo
   * a dá se z ní poznat, co Sequel vlastně poslal.
   */
  const reconnect = needsReconnect(last);
  if (reconnect) throw new Error(reconnect);
  setSetting('ga4LastDetail', [
    new Date().toISOString(),
    `nástroj: ${tool.name}`,
    `parametry: ${Object.keys(properties).join(', ') || '—'}`,
    `nabízené akce: ${offered}`,
    `zkoušené akce: ${tried.join(', ') || '—'}`,
    '',
    last || '(server neposlal nic)'
  ].join('\n').slice(0, 4000));

  const why = /"error"/.test(last) ? 'odpověděl chybou'
    : !last ? 'neposlal žádná data'
      : last === 'prázdná odpověď' ? 'neposlal žádná data'
        : 'poslal něco, co nejsou čísla návštěvnosti';
  throw new Error(
    `Sequel ${why}. Zkoušeno: ${tried.join(', ') || '—'}; nabízí: ${offered.slice(0, 120)}. `
    + 'Celou odpověď ukáže „Zobrazit poslední odpověď" v nastavení.'
  );
}

/**
 * Je to seznam spojení místo odpovědi?
 *
 * Sequel na špatnou akci ochotně odpoví výpisem napojených zdrojů — a ten
 * se pak tvářil jako platná odpověď, ze které vyšlo „0 návštěv". Pozná se
 * podle toho, že v něm není nic z toho, na co jsme se ptali.
 */
function looksLikeListing(text: string): boolean {
  if (/"connections"\s*:|"action"\s*:\s*"list/i.test(text)) return true;
  return /"connection_?id"/i.test(text) && !/"sessions"/i.test(text);
}

/**
 * Čeká napojení na nové přihlášení?
 *
 * Když v Sequelu vyprší souhlas s Google účtem, každý dotaz skončí
 * `{"action":"reconnect","status":"pending"}`. Bez pojmenování z toho byla
 * jen záhadná hláška s kusem JSONu — a přitom se to spraví jedním klikem
 * na sequel.sh.
 */
function needsReconnect(text: string): string | null {
  const pending = /"status"\s*:\s*"pending"/i.test(text);
  const asks = /"action"\s*:\s*"re[-_]?connect"|reconnect_url|needs?[-_]?reconnect|re[-_]?authorize/i.test(text);
  if (!pending && !asks) return null;
  const url = text.match(/https?:\/\/[^"'\s]+/)?.[0];
  return 'Napojení na Google Analytics v Sequelu čeká na nové přihlášení — '
    + `otevři ${url ?? 'sequel.sh'} a povol přístup znovu.`;
}

/**
 * Který web měří napojený zdroj.
 *
 * Zatím jeden — český web. Text se dá přepsat v nastavení, protože jméno
 * zdroje v Sequelu („GA4 quentino.cz") o trhu nemusí říkat nic. Až se
 * napojí i slovenský a mezinárodní web, budou tady vyjmenované všechny
 * a přehled si přestane přisuzovat cizí návštěvy.
 */
export function ga4Scope(): string {
  return getSetting('ga4Scope', 'český web (.cz)')!;
}

/** Poslední celá odpověď Sequelu — do nastavení, když se dotaz nepovedl */
export function ga4LastDetail(): string {
  return getSetting('ga4LastDetail', '') || 'Zatím se nic neuložilo.';
}

/** Co server nabízí — do nastavení, když se automatika netrefí */
export async function ga4Diagnostics(): Promise<string> {
  await connect();
  const tools = await listTools();
  return tools.map(one => {
    const properties = one.schema?.properties ?? {};
    const names = Object.keys(properties);
    const required = Array.isArray(one.schema?.required) ? one.schema.required : [];
    /*
     * Výčty patří do výpisu. Jméno parametru („action") neřekne nic; teprve
     * jeho hodnoty ukážou, jestli tam vůbec je něco, čím se dá zeptat —
     * a přesně na tom se napojení jednou zaseklo.
     */
    const enums = names
      .map(name => ({ name, values: enumOf((properties as any)[name]) }))
      .filter(item => item.values.length)
      .map(item => `${item.name}: ${item.values.join(' | ')}`);
    /*
     * Popis od serveru. Je to jediná dokumentace, kterou k Sequelu máme —
     * a právě z ní je poznat, že `search` jen navrhne, co spustit, kdežto
     * čísla vrátí až `execute`.
     */
    const about = one.description ? `\n    ${one.description.replace(/\s+/g, ' ').slice(0, 200)}` : '';
    return `${one.name}(${names.join(', ') || '—'})`
      + `${required.length ? ` · povinné: ${required.join(', ')}` : ''}`
      + about
      + (enums.length ? `\n    ${enums.join('\n    ')}` : '');
  }).join('\n\n');
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
    /*
     * Nejdřív reporty přímo. Sequel umí spustit `google_analytics.run_report`
     * a vrátit řádky — čísla se pak nikde nepřekládají do řeči a zpátky.
     * Když to nevyjde (jiný server, jiné nástroje), zbývá stará cesta: zeptat
     * se slovy a přečíst JSON z odpovědi.
     */
    try {
      await connect();
      const tools = await listTools();
      const direct = await runReports(tools, queryTool(tools), getSetting('ga4AppId', '')!);
      if (direct) {
        const snapshot: Ga4Snapshot = { at: new Date().toISOString(), scope: ga4Scope(), ...direct.snapshot };
        const anything = snapshot.window.sessions || snapshot.window.users || snapshot.window.purchases;
        if (anything) {
          setSetting(SNAPSHOT_KEY, JSON.stringify(snapshot));
          setSetting('ga4LastAt', snapshot.at);
          setSetting('ga4LastError', '');
          setSetting('ga4LastDetail', `${new Date().toISOString()}\nreporty:\n${direct.detail}`.slice(0, 8000));
          return snapshot;
        }
        /*
         * Report doběhl a je prázdný. To je taky odpověď — ne důvod zkoušet
         * oklikou přes řeč a skončit u obecnější hlášky.
         */
        setSetting('ga4LastDetail', `${new Date().toISOString()}\nreport bez čísel:\n${direct.detail}`.slice(0, 8000));
        const message = 'Report z Google Analytics doběhl, ale nevrátil žádná čísla — '
          + 'zkontroluj, jestli je ve zdroji vybraná správná služba. '
          + 'Celou odpověď ukáže „Zobrazit poslední odpověď" v nastavení.';
        setSetting('ga4LastError', message);
        return last ? { ...last, error: message } : {
          at: '', scope: ga4Scope(), window: periodOf(null), prevWindow: periodOf(null),
          sources: [], conversion: null, prevConversion: null, text: '', error: message
        };
      }
    } catch (e: any) {
      /*
       * Report se spustil a nedopadl — to je konkrétní zjištění a nemá se
       * přebít obecnější chybou z náhradní cesty. Ta se zkusí jen tehdy,
       * když se k reportu vůbec nedošlo (jiný server, jiné nástroje).
       */
      const message = String(e?.message ?? e);
      if (/report/i.test(message)) {
        setSetting('ga4LastError', message);
        return last ? { ...last, error: message } : {
          at: '', scope: ga4Scope(), window: periodOf(null), prevWindow: periodOf(null),
          sources: [], conversion: null, prevConversion: null, text: '', error: message
        };
      }
      setSetting('ga4LastDetail', `${new Date().toISOString()}\nreporty selhaly: ${message}`);
    }

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
      /*
       * Odpověď přišla, ale čísla v ní nejsou — typicky je to návrh, co
       * spustit, ne výsledek. Do bubliny se nevejde, tak se schová celá
       * do nastavení: bez ní se nedá poznat, co po nás Sequel chce.
       */
      setSetting('ga4LastDetail', `${new Date().toISOString()}\nodpověď bez čísel:\n${text}`.slice(0, 8000));
      throw new Error(
        'Sequel odpověděl, ale čísla návštěvnosti v tom nejsou — nejspíš vrátil návrh, co spustit. '
        + 'Celou odpověď ukáže „Zobrazit poslední odpověď" v nastavení.'
      );
    }
    const snapshot: Ga4Snapshot = {
      at: new Date().toISOString(),
      scope: ga4Scope(),
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
    return last
      ? { ...last, error: message }
      : {
        at: '', scope: ga4Scope(), window: periodOf(null), prevWindow: periodOf(null),
        sources: [], conversion: null, prevConversion: null, text: '', error: message
      };
  }
}


/* ---------- reporty přímo, bez překládání do řeči ---------- */

/**
 * Čísla z Google Analytics **bez prostředníka**.
 *
 * Ukázalo se, jak Sequel doopravdy funguje: `sequel_search` nevrací data,
 * ale **plán** — u napojeného zdroje vypíše nástroje i s jejich schématem
 * (`google_analytics.run_report`), a teprve `sequel_execute` je spustí.
 * Prosba typu „vrať mi JSON s návštěvností" tudy neprojde: co se má spustit,
 * musí sestavit ten, kdo se ptá.
 *
 * Sestavuje to tedy aplikace sama, a je to tak i poctivější — čísla se
 * nikde nepřekládají do řeči a zpátky. Tři reporty:
 *
 *  1. **okno** (30 dní): návštěvy, uživatelé, nákupy, tržba,
 *  2. **předchozích 30 dní** — s čím se to srovnává,
 *  3. **zdroje** za okno: pět nejsilnějších `sessionSourceMedium`.
 *
 * Metriky se berou z výčtu ve schématu, ne z hlavy: kdyby Sequel jména
 * změnil, vezmou se ta, která nabízí.
 */
async function runReports(
  tools: ToolInfo[], searchTool: ToolInfo, appId: string
): Promise<{ snapshot: Omit<Ga4Snapshot, 'at' | 'scope'>; detail: string } | null> {
  const runner = runTool(tools);
  if (!runner) return null;

  const why = 'Denní přehled e-shopu Quentino — návštěvnost za posledních 30 dní.';
  const searchArgs = argsFor(searchTool, { question: question(), appId, why });
  const found = textOf(await rpc('tools/call', { name: searchTool.name, arguments: searchArgs }, 4));
  const plan = jsonIn(found);
  const results = findArray(plan, 'results') ?? [];
  const report = results
    .flatMap((one: any) => (Array.isArray(one?.tools) ? one.tools : []))
    .find((one: any) => /run_report|report|query/i.test(String(one?.tool_id ?? one?.id ?? '')));
  if (!report) return null;

  const schema = report.input_schema ?? report.inputSchema ?? {};
  const offered = (name: string): string[] => enumOf(schema?.properties?.[name]?.items ?? {});
  const pick = (wanted: string[], name: string): string[] => {
    const list = offered(name);
    const usable = wanted.filter(one => !list.length || list.includes(one));
    return usable.length ? usable : wanted.slice(0, 1);
  };

  // Sessions a users musí být; nákupy a tržba jen když je zdroj zná
  const metrics = pick(['sessions', 'totalUsers', 'ecommercePurchases', 'totalRevenue'], 'metrics');
  /*
   * Souhrn potřebuje aspoň jednu dimenzi (schéma jinou možnost nedává).
   * `year` je nejmíň rozsekaná: třicetidenní okno je jeden řádek, na
   * přelomu roku dva — a uživatelé se sčítají po roce, ne po dnech, takže
   * se nenafouknou opakovanými návštěvami.
   */
  const totals = (from: string, to: string, id: string) => ({
    id,
    tool_id: String(report.tool_id ?? report.id),
    input: { startDate: from, endDate: to, dimensions: ['year'], metrics, limit: 10 }
  });
  const calls = [
    totals(dayKey(29), dayKey(0), 'window'),
    totals(dayKey(59), dayKey(30), 'prevWindow'),
    {
      id: 'sources',
      tool_id: String(report.tool_id ?? report.id),
      input: {
        startDate: dayKey(29),
        endDate: dayKey(0),
        dimensions: pick(['sessionSourceMedium'], 'dimensions'),
        metrics: ['sessions'],
        limit: 5,
        orderBy: [{ metric: 'sessions', desc: true }]
      }
    }
  ];

  const session = String(plan?.session_id ?? plan?.data?.session_id ?? '');
  /*
   * Jak vypadá jedno volání, ve schématu není: `tool_calls` je jen „pole"
   * bez popisu položek. Server to prozradil až chybou —
   * „undefined is not an object (evaluating 'callParams.tool.toLowerCase')"
   * — z čehož je jasné, že jméno nástroje čte z pole **`tool`**, ne
   * `tool_id`. Jak se jmenuje vstup, se z ničeho nepozná, tak se zkusí
   * obvyklá jména po řadě, dokud nepřijdou řádky.
   */
  const shapes = ['input', 'params', 'arguments', 'parameters', 'args', 'holé'] as const;
  const runOnce = async (shape: typeof shapes[number], id: number): Promise<string> => {
    const runArgs = argsFor(runner, { question: question(), appId, why });
    const list = calls.map(one => {
      /*
       * `holé` je volání bez ničeho navíc: jen jméno nástroje a jeho vstup
       * naplocho. Schéma vstupu má `additionalProperties: false`, takže
       * `id` ani `tool_id` v něm být nesmí — a právě na přebytečném poli
       * server hlásí „UNDEFINED_VALUE".
       */
      if (shape === 'holé') return { tool: one.tool_id, ...one.input };
      // Jinde `tool` i `tool_id` schválně obojí — server si vezme, co zná
      const head = { id: one.id, tool: one.tool_id, tool_id: one.tool_id };
      return { ...head, [shape]: one.input };
    });
    for (const [name, property] of Object.entries<any>(runner.schema?.properties ?? {})) {
      if (/^(tool_?calls|calls|steps|plan)$/i.test(name)) {
        runArgs[name] = isArray(property) ? list : JSON.stringify(list);
      }
      if (/^session_?id$/i.test(name) && session) runArgs[name] = session;
    }
    return textOf(await rpc('tools/call', { name: runner.name, arguments: runArgs }, id));
  };

  /*
   * Každý pokus se zapíše i s tím, jak dopadl. Dokud se ukládal jen ten
   * poslední, nedalo se poznat, který tvar server odmítl a proč — a bez
   * toho se to hádalo dokola.
   */
  let answer = '';
  const attempts: string[] = [];
  for (const [index, shape] of shapes.entries()) {
    answer = await runOnce(shape, 41 + index);
    attempts.push(`— tvar „${shape}": ${answer.slice(0, 700)}`);
    if (/"rows"/.test(answer)) break;
    // Chyba ve tvaru volání — zkusí se další pojmenování vstupu
    if (!/"error"/i.test(answer)) break;
  }
  /*
   * Report se spustil a nedopadl. To není důvod zkoušet oklikou přes řeč —
   * je to konkrétní chyba, kterou je vidět v nastavení, a hlásí se rovnou.
   */
  if (!/"rows"/.test(answer)) {
    const why = String(jsonIn(answer)?.error ?? jsonIn(answer)?.data?.error ?? '').slice(0, 160);
    setSetting('ga4LastDetail', `${new Date().toISOString()}\nreport se nepovedl:\n${found}`
      + `\n\n--- spuštění (${attempts.length} tvarů) ---\n${attempts.join('\n\n')}`.slice(0, 8000));
    throw new Error(
      why
        ? `Sequel report odpověděl chybou: ${why}. Celou odpověď ukáže „Zobrazit poslední odpověď" v nastavení.`
        : 'Sequel report nevrátil žádné řádky. Celou odpověď ukáže „Zobrazit poslední odpověď" v nastavení.'
    );
  }

  const parsed = jsonIn(answer);
  const tables = collectRows(parsed);
  if (!tables.length) return null;

  const sum = (rows: any[], key: string): number | null => {
    let total = 0;
    let seen = false;
    for (const row of rows) {
      const value = num(row?.[key]);
      if (value != null) { total += value; seen = true; }
    }
    return seen ? Math.round(total) : null;
  };
  const period = (rows: any[] | undefined): Ga4Period => ({
    sessions: rows ? sum(rows, 'sessions') : null,
    users: rows ? sum(rows, 'totalUsers') ?? sum(rows, 'users') : null,
    purchases: rows ? sum(rows, 'ecommercePurchases') ?? sum(rows, 'conversions') : null,
    revenue: rows ? sum(rows, 'totalRevenue') ?? sum(rows, 'revenue') : null
  });

  const windowRows = tables[0];
  const prevRows = tables[1];
  const sourceRows = tables[2] ?? [];
  const windowPeriod = period(windowRows);
  const prevPeriod = period(prevRows);

  return {
    snapshot: {
      window: windowPeriod,
      prevWindow: prevPeriod,
      sources: sourceRows
        .map((row: any) => ({
          name: String(row?.sessionSourceMedium ?? row?.name ?? '').trim(),
          sessions: num(row?.sessions) ?? 0
        }))
        .filter((one: { name: string }) => one.name)
        .slice(0, 5),
      conversion: conversionOf(windowPeriod),
      prevConversion: conversionOf(prevPeriod),
      text: answer.slice(0, 2000),
      error: null
    },
    detail: `${found}\n\n--- spuštění (${attempts.length} tvarů) ---\n${attempts.join('\n\n')}`
  };
}

/** Všechny tabulky z odpovědi — v pořadí, v jakém se posílaly reporty */
function collectRows(node: any, out: any[][] = [], depth = 0): any[][] {
  if (!node || typeof node !== 'object' || depth > 8) return out;
  if (Array.isArray(node.rows)) out.push(node.rows);
  for (const value of Array.isArray(node) ? node : Object.values(node)) {
    collectRows(value, out, depth + 1);
  }
  return out;
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

/** Jen pro zkoušky — vnitřní rozhodování, které se jinak nedá zvenku vidět */
export const __test = { pickQueryAction, needsReconnect, looksLikeListing };
