/**
 * Zkouška napojení na Sequel (GA4).
 *
 * Sequel je MCP server: nejdřív řekne, jaké má nástroje a co po nás chtějí,
 * teprve pak se dá zeptat. První verze si jména parametrů **domýšlela** —
 * poslala otázku pod čtyřmi obvyklými jmény a doufala. Server si k tomu
 * domyslel akci `connect`, u které chce `app_id`, a odpověděl chybou:
 *
 *     {"status":"error","error":"app_id is required when action='connect'"}
 *
 * Na počítači z toho v přehledu byla nula návštěv, na telefonu ta hláška.
 * Zkouší se proto to, co tehdy chybělo: že se argumenty skládají **podle
 * schématu nástroje**, že se vybere akce, která data vrací, a že se chyba
 * schovaná v obyčejné odpovědi pozná jako chyba.
 *
 * Síť se nikam nevolá — `fetch` je podstrčený a odpovídá jako Sequel.
 */
const path = require('path');
const { db, DIST } = require('./ptrans/harness.cjs');

db.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");

const secPath = require.resolve(path.join(DIST, 'secure.js'));
require.cache[secPath] = { id: secPath, filename: secPath, loaded: true, exports: {
  encrypt: v => v, decrypt: v => v
} };

const ga4 = require(path.join(DIST, 'ga4.js'));

let failed = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${label}`);
  if (!ok) { console.log('      čekáno:', JSON.stringify(want)); console.log('      dostal:', JSON.stringify(got)); }
}

/* ---------- podstrčený server ---------- */

/*
 * Nástroje tak, jak je posílá skutečný Sequel (vypsané z provozu):
 * správce spojení, hledání a spuštění. Dotaz se neposílá jedním voláním —
 * `sequel_search` jen navrhne, co spustit, a čísla vrátí až `sequel_execute`.
 * Každý nástroj navíc chce `action_info`, tedy větu, proč se ptáme.
 */
const TOOLS = [
  {
    name: 'sequel_manage_connections',
    description: 'List, connect or reconnect data sources',
    inputSchema: {
      type: 'object',
      properties: {
        action_info: { type: 'string' },
        action: { type: 'string', enum: ['list', 'connect', 'reconnect'] },
        app_id: { type: 'string' },
        connection_id: { type: 'string' }
      },
      required: ['action_info', 'action']
    }
  },
  {
    name: 'sequel_search',
    description: 'Find what can be asked of the connected sources',
    inputSchema: {
      type: 'object',
      properties: {
        action_info: { type: 'string' },
        use_case: { type: 'string' },
        connection_ids: { type: 'array', items: { type: 'string' } }
      },
      required: ['action_info', 'use_case']
    }
  },
  {
    name: 'sequel_execute',
    description: 'Run the tool calls returned by search',
    inputSchema: {
      type: 'object',
      properties: {
        action_info: { type: 'string' },
        tool_calls: { type: 'array' },
        session_id: { type: 'string' }
      },
      required: ['action_info', 'tool_calls']
    }
  },
  {
    name: 'sequel_workbench',
    description: 'Run python or bash',
    inputSchema: {
      type: 'object',
      properties: {
        action_info: { type: 'string' },
        language: { type: 'string', enum: ['python', 'bash'] },
        code: { type: 'string' },
        session_id: { type: 'string' }
      },
      required: ['action_info', 'language', 'code']
    }
  }
];

let calls = [];
// Přepínače pro zkoušky: report bez řádků a report, který skončí chybou
let zeroReports = false;
let failReports = false;
// Vypršelý souhlas s Google účtem — server pak na všechno hlásí reconnect
let pendingReconnect = false;
let answer = '{"window":{"sessions":1234,"users":900,"purchases":31,"revenue":54000},'
  + '"prevWindow":{"sessions":1000,"users":800,"purchases":25,"revenue":45000},'
  + '"sources":[{"name":"google / organic","sessions":700}]}';

global.fetch = async (url, options) => {
  const body = JSON.parse(options.body);
  calls.push(body);
  const reply = (result) => ({
    ok: true,
    status: 200,
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
    text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result })
  });
  const text = (value) => reply({ content: [{ type: 'text', text: value }] });

  if (body.method === 'initialize') return reply({ protocolVersion: '2025-06-18' });
  if (body.method === 'notifications/initialized') {
    return { ok: true, status: 202, headers: { get: () => null }, text: async () => '' };
  }
  if (body.method === 'tools/list') return reply({ tools: TOOLS });
  if (body.method === 'tools/call') {
    const args = body.params?.arguments ?? {};
    const tool = body.params?.name ?? '';
    // Povinná věta „proč se ptáme" — bez ní server dotaz odmítá
    if (!args.action_info) return text('{"status":"error","error":"action_info is required"}');
    // Vypršené přihlášení do Googlu: na cokoli přijde „čeká na reconnect"
    if (pendingReconnect) return text(answer);

    /*
     * Seznam spojení. Vedle napojených zdrojů nese i **katalog toho, co by
     * se dalo napojit** (`available_apps`) — a ten se dřív dostal do výběru
     * jako šestnáct zdrojů, které nikdo nemá.
     */
    if (tool === 'sequel_manage_connections') {
      if (args.action !== 'list') return text('{"status":"error","error":"nothing to do"}');
      return text('{"status":"success","data":{"action":"list","connections":'
        + '[{"connection_id":"s6f02zyp","name":"GA4 — Quentino.cz","type":"google_analytics","expired":false},'
        + '{"connection_id":"pg01","name":"Sklad","type":"postgres","expired":false}],'
        + '"available_apps":[{"app_id":"postgres","name":"PostgreSQL"},{"app_id":"stripe","name":"Stripe"},'
        + '{"app_id":"hubspot","name":"HubSpot"}]}}');
    }

    /*
     * Hledání čísla nevrací — vrátí **plán**: u napojeného zdroje vypíše
     * nástroje i s jejich schématem. Co se má spustit, musí sestavit ten,
     * kdo se ptá.
     */
    if (tool === 'sequel_search') {
      if (!args.use_case) return text('{"status":"error","error":"use_case is required"}');
      return text(JSON.stringify({
        status: 'success',
        data: {
          results: [{
            connection_id: 's6f02zyp',
            connection_name: 'GA4 — Quentino.cz – GA4',
            app_id: 'google_analytics',
            plan_id: 'sp_1',
            instructions: 'Run two Google Analytics 4 reports…',
            tools: [{
              tool_id: 'google_analytics.run_report',
              input_schema: {
                type: 'object',
                properties: {
                  startDate: { type: 'string' },
                  endDate: { type: 'string' },
                  dimensions: { type: 'array', items: { type: 'string',
                    enum: ['date', 'month', 'year', 'country', 'deviceCategory', 'pagePath',
                      'landingPage', 'sessionSourceMedium'] } },
                  metrics: { type: 'array', items: { type: 'string',
                    enum: ['sessions', 'totalUsers', 'ecommercePurchases', 'totalRevenue', 'conversions',
                      'addToCarts', 'checkouts'] } },
                  limit: { type: 'integer' },
                  orderBy: { type: 'array' }
                },
                required: ['startDate', 'endDate', 'dimensions', 'metrics', 'limit']
              }
            }]
          }],
          skills: []
        },
        session_id: 'gvauhe'
      }));
    }

    if (tool === 'sequel_execute') {
      if (!Array.isArray(args.tool_calls) || args.tool_calls.length === 0) {
        return text('{"status":"error","error":"tool_calls is required"}');
      }
      // Zkouška „report se spustil a nedopadl" — na tvaru volání nezáleží
      if (failReports) {
        return text('{"status":"error","error":"app_id is required when action=\'connect\'"}');
      }
      /*
       * Jméno nástroje čte server z pole `tool`. Když tam není, spadne
       * uvnitř sebe — a přesně tuhle hlášku poslal v provozu, když se
       * posílalo jen `tool_id`.
       */
      const bezJmena = args.tool_calls.find(one => typeof one.tool !== 'string');
      if (bezJmena) {
        return text(JSON.stringify({ status: 'success', data: { results: args.tool_calls.map(() => ({
          output: null,
          file: { filename: '', path: '' },
          next_steps: null,
          error: "undefined is not an object (evaluating 'callParams.tool.toLowerCase')"
        })) } }));
      }
      /*
       * Ke každému volání patří i to, komu ho poslat: spojení a plán,
       * ze kterého vzešlo. Bez nich si server neuloží ani záznam a spadne
       * na `undefined` — přesně touhle hláškou, ať se vstup jmenuje jakkoli.
       */
      const bezSpojeni = args.tool_calls.find(one => !one.connection_id || !one.plan_id);
      if (bezSpojeni) {
        return text(JSON.stringify({ status: 'success', data: { results: args.tool_calls.map(() => ({
          tool: 'google_analytics.run_report',
          output: null,
          error: 'UNDEFINED_VALUE: Undefined values are not allowed'
        })) } }));
      }
      // Vstup čte z `params`; pod jiným jménem si stěžuje na chybějící pole
      const bezVstupu = args.tool_calls.find(one => typeof one.params !== 'object' || !one.params);
      if (bezVstupu) {
        return text(JSON.stringify({ status: 'success', data: { results: args.tool_calls.map(() => ({
          output: null, error: 'params is required'
        })) } }));
      }
      if (zeroReports) {
        return text(JSON.stringify({ status: 'success', data: { results: args.tool_calls.map(() => ({
          rows: [], rowCount: 0, fields: []
        })) } }));
      }
      /*
       * Hlubší rozbor: sedm reportů jedním voláním. Odpovědi chodí
       * v pořadí, v jakém volání přišla.
       */
      if (args.tool_calls.length === 7) {
        const table = (rows) => ({ rows, rowCount: rows.length, fields: [] });
        return text(JSON.stringify({ status: 'success', data: { results: [
          table([
            { month: '202607', sessions: 900, totalUsers: 700, ecommercePurchases: 18, totalRevenue: 32000 },
            { month: '202608', sessions: 1100, totalUsers: 830, ecommercePurchases: 26, totalRevenue: 41000 }
          ]),
          table([
            { sessionSourceMedium: 'google / organic', sessions: 700, totalUsers: 540,
              ecommercePurchases: 21, totalRevenue: 38000 },
            { sessionSourceMedium: 'seznam / cpc', sessions: 300, totalUsers: 250,
              ecommercePurchases: 2, totalRevenue: 2600 }
          ]),
          table([{ landingPage: '/kravaty', sessions: 400, totalUsers: 330,
            ecommercePurchases: 12, totalRevenue: 19000 }]),
          table([{ pagePath: '/jak-vybrat-kravatu', sessions: 260, totalUsers: 240,
            ecommercePurchases: 3, totalRevenue: 4200 }]),
          table([{ deviceCategory: 'mobile', sessions: 1300, totalUsers: 1000,
            ecommercePurchases: 24, totalRevenue: 36000 }]),
          table([{ country: 'Czechia', sessions: 1500, totalUsers: 1200,
            ecommercePurchases: 40, totalRevenue: 60000 }]),
          table([{ year: '2026', sessions: 2000, addToCarts: 320, checkouts: 120,
            ecommercePurchases: 44 }])
        ] } }));
      }
      /*
       * Odpovědi v pořadí, v jakém volání přišla: okno, předchozí okno,
       * zdroje. Uživatelé se sčítají po roce, ne po dnech — jinak by je
       * opakované návštěvy nafoukly.
       */
      return text(JSON.stringify({
        status: 'success',
        data: {
          results: [
            { rows: [{ year: '2026', sessions: 1234, totalUsers: 900,
              ecommercePurchases: 31, totalRevenue: 54000 }], rowCount: 1, fields: [] },
            { rows: [{ year: '2026', sessions: 1000, totalUsers: 800,
              ecommercePurchases: 25, totalRevenue: 45000 }], rowCount: 1, fields: [] },
            { rows: [{ sessionSourceMedium: 'google / organic', sessions: 700 }], rowCount: 1, fields: [] }
          ]
        }
      }));
    }
    return text('{"status":"error","error":"unsupported tool"}');
  }
  throw new Error(`neznámá metoda ${body.method}`);
};

/* ---------- zkoušky ---------- */

(async () => {
  ga4.saveGa4Config({ enabled: true, key: 'sql_test' });

  console.log('\nzdroje se dohledají:\n');
  const apps = await ga4.ga4Apps();
  check('server vrátí obě spojení', apps.map(one => one.id), ['s6f02zyp', 'pg01']);
  /*
   * Vedle napojených zdrojů posílá Sequel i katalog toho, co by se dalo
   * napojit (`available_apps`). Do výběru nepatří — jinak si člověk vybírá
   * mezi šestnácti věcmi, které nemá.
   */
  check('nabídka toho, co se dá napojit, mezi zdroje nepatří',
    apps.some(one => ['postgres', 'stripe', 'hubspot'].includes(one.id)), false);
  /*
   * Vybrat se má **Google Analytics**, ne první v pořadí — na návštěvnost se
   * databáze skladu ptát nemá smysl.
   */
  check('a vybere se to, které je analytika', ga4.getGa4Config().appId, 's6f02zyp');
  // Pro vypsání zdrojů se nesmí použít `connect` — ta chce zdroj, který
  // teprve hledáme
  const listCall = calls.find(one => one.method === 'tools/call');
  check('na vypsání se použije akce, která nechce zdroj',
    listCall.params.arguments.action, 'list');

  console.log('\ndotaz jde se zdrojem:\n');
  calls = [];
  const snapshot = await ga4.ga4Snapshot(true);
  const askCall = calls.find(one => one.method === 'tools/call');
  /*
   * Ptát se má **dotazovací** nástroj, ne správce spojení. Přesně na tomhle
   * napojení uvázlo: vybral se `sequel_manage_connections`, jehož akce jsou
   * jen list/connect/reconnect — žádná nevypadala jako dotaz a v okně z toho
   * bylo „zkoušené akce: " bez jediné akce.
   */
  check('ptá se nástroj na data, ne správce spojení', askCall.params.name, 'sequel_search');
  check('otázka jde pod jménem ze schématu',
    typeof askCall.params.arguments.use_case === 'string'
    && askCall.params.arguments.use_case.length > 20, true);
  // `connection_ids` je pole, `connection_id` text — řídí se to schématem
  check('zdroj je vyplněný a zabalený podle schématu',
    askCall.params.arguments.connection_ids, ['s6f02zyp']);
  // Povinná věta „proč se ptáme"; bez ní Sequel dotaz odmítne
  check('a je vyplněné, proč se ptáme',
    typeof askCall.params.arguments.action_info === 'string'
    && askCall.params.arguments.action_info.length > 10, true);
  check('nic navíc se neposílá', Object.keys(askCall.params.arguments).sort(),
    ['action_info', 'connection_ids', 'use_case']);
  /*
   * Druhý krok. Hledání samo čísla nevrací — vrátí návrh, co spustit,
   * a teprve `sequel_execute` ho provede. Bez toho se v přehledu ukazoval
   * plán místo dat.
   */
  const runCall = calls.filter(one => one.method === 'tools/call')
    .find(one => one.params.name === 'sequel_execute');
  check('plán z hledání se opravdu spustí', !!runCall, true);
  const spusteno = runCall?.params.arguments.tool_calls ?? [];
  check('spouští se nástroj ze schématu, ne vymyšlený',
    spusteno[0]?.tool_id, 'google_analytics.run_report');
  // Okno, předchozí okno a zdroje — tři reporty jedním voláním
  check('a tři reporty naráz', spusteno.map(one => one.id), ['window', 'prevWindow', 'sources']);
  /*
   * Metriky se berou z výčtu ve schématu, ne z hlavy: `transactions` ani
   * `purchaseRevenue` v GA4 přes Sequel nejsou, jsou to `ecommercePurchases`
   * a `totalRevenue`. Kdyby je Sequel přejmenoval, vezmou se ty nabízené.
   */
  check('metriky jsou ty, které nástroj nabízí', spusteno[0]?.input.metrics,
    ['sessions', 'totalUsers', 'ecommercePurchases', 'totalRevenue']);
  /*
   * Souhrn potřebuje aspoň jednu dimenzi. `year` je nejmíň rozsekaná —
   * uživatelé se sčítají po roce, ne po dnech, takže je opakované návštěvy
   * nenafouknou.
   */
  check('souhrn se počítá po roce, ne po dnech', spusteno[0]?.input.dimensions, ['year']);
  check('zdroje jdou podle sessionSourceMedium', spusteno[2]?.input.dimensions, ['sessionSourceMedium']);
  check('a je jich pět', spusteno[2]?.input.limit, 5);
  check('i sezení z hledání', runCall?.params.arguments.session_id, 'gvauhe');
  /*
   * Jméno nástroje čte server z pole `tool`, ne `tool_id` — přestože ve svém
   * vlastním plánu posílá `tool_id`. Prozradil to až pádem uvnitř sebe:
   * „undefined is not an object (evaluating 'callParams.tool.toLowerCase')".
   */
  check('jméno nástroje jde i pod `tool`', spusteno[0]?.tool, 'google_analytics.run_report');
  /*
   * Ke každému volání patří i to, komu ho poslat. Bez `connection_id`
   * a `plan_id` z plánu server spadl na `undefined` — a hlásil to stejně,
   * ať se vstup jmenoval jakkoli, takže to dlouho vypadalo na tvar volání.
   */
  check('a s ním spojení i plán z hledání',
    [spusteno[0]?.connection_id, spusteno[0]?.plan_id], ['s6f02zyp', 'sp_1']);
  /*
   * Jak se jmenuje vstup, ve schématu není. Zkouší se obvyklá jména po řadě,
   * dokud nepřijdou řádky — tenhle server chce `params`, a to je druhý pokus.
   */
  const tvary = calls.filter(one => one.params?.name === 'sequel_execute');
  check('tvar volání se dohledá zkoušením', tvary.length >= 2, true);
  check('a nakonec projde ten, který server bere',
    typeof tvary[tvary.length - 1]?.params.arguments.tool_calls[0].params, 'object');
  check('čísla se přečtou', snapshot.window.sessions, 1234);
  check('konverze se dopočítá', snapshot.conversion, 2.5);
  check('a je z čeho srovnávat', snapshot.prevWindow.sessions, 1000);

  console.log('\nrozbor návštěvnosti:\n');
  /*
   * Druhá otázka po „kolik jich přišlo": odkud, kudy a co z toho bylo.
   * Sedm reportů jedním voláním, až dva roky zpátky.
   */
  calls = [];
  const rozbor = await ga4.ga4Deep(365, true);
  // Poslední pokus je ten, který server přijal — tvar se dohledává zkoušením
  const deepTries = calls.filter(one => one.params?.name === 'sequel_execute');
  const deepCall = deepTries[deepTries.length - 1];
  check('rozbor jde jedním voláním', deepCall?.params.arguments.tool_calls.length, 7);
  check('a ptá se na to, co se dá vyhodnotit',
    deepCall?.params.arguments.tool_calls.map(one => one.id),
    ['months', 'channels', 'landings', 'pages', 'devices', 'countries', 'funnel']);
  // Dimenze i metriky se berou z výčtu ve schématu, ne z hlavy
  check('měsíční řada jde po měsících',
    deepCall?.params.arguments.tool_calls[0].params.dimensions, ['month']);
  check('a cesta k nákupu chce košík i pokladnu',
    deepCall?.params.arguments.tool_calls[6].params.metrics,
    ['sessions', 'addToCarts', 'checkouts', 'ecommercePurchases']);
  // Měsíc chodí z GA4 jako `YYYYMM`; na graf se hodí `YYYY-MM`
  check('měsíce se převedou na tvar pro graf', rozbor.months.map(one => one.month),
    ['2026-07', '2026-08']);
  /*
   * U kanálu je vedle návštěv i konverze a tržba — kanál, který přivede
   * lidi, a kanál, který přivede peníze, jsou dvě různé věci.
   */
  const organic = rozbor.channels.find(one => one.name === 'google / organic');
  check('u kanálu je i konverze a tržba', [organic?.conversion, organic?.revenue], [3, 38000]);
  const cpc = rozbor.channels.find(one => one.name === 'seznam / cpc');
  check('a slabý kanál je vidět', cpc?.conversion, 0.7);
  check('cesta k nákupu má všechny kroky',
    [rozbor.funnel.sessions, rozbor.funnel.addToCarts, rozbor.funnel.checkouts, rozbor.funnel.purchases],
    [2000, 320, 120, 44]);
  // Do zadání pro AI jde krátký výtah, ne celá tabulka
  const proAi = ga4.ga4DeepForAi(rozbor);
  check('do zadání pro AI jde výtah', /Kanály podle tržby/.test(proAi), true);
  check('a je v něm i cesta k nákupu', /Cesta k nákupu/.test(proAi), true);
  check('i upozornění, že měří jen jeden web', /objednávky výš jsou ze všech trhů/.test(proAi), true);

  console.log('\nnuly nejsou odpověď:\n');
  /*
   * Sequel je jazykový překladač: když dostane vzorový JSON s nulami, umí ho
   * opsat. Spojení pak „funguje" a v přehledu stojí 0 návštěv — což vypadá
   * jako pravda a není. Kostra se proto do dotazu nepřikládá a samé nuly se
   * berou jako nepřečtená odpověď.
   */
  const askText = calls.find(one => one.method === 'tools/call')?.params.arguments.use_case ?? '';
  check('v dotazu není vzorová odpověď s nulami', /"sessions":0/.test(askText), false);
  check('a jsou v něm konkrétní data', /\d{4}-\d{2}-\d{2} až \d{4}-\d{2}-\d{2}/.test(askText), true);

  answer = '{"window":{"sessions":0,"users":0,"purchases":0,"revenue":0},'
    + '"prevWindow":{"sessions":0,"users":0,"purchases":0,"revenue":0},"sources":[]}';
  zeroReports = true;
  const zeros = await ga4.ga4Snapshot(true);
  zeroReports = false;
  check('samé nuly se nevydávají za data', /nevrátil žádná čísla/.test(zeros.error ?? ''), true);
  // Celá odpověď se schová do nastavení — v bublině na ni není místo
  check('a celá odpověď se schová do nastavení', /"rows":\[\]/.test(ga4.ga4LastDetail()), true);

  console.log('\nchyba schovaná v odpovědi:\n');
  /*
   * Tohle je ta past: server odpoví dvěstěkou a chybu napíše do textu.
   * Dřív se z ní stala nula návštěv, což vypadalo jako pravda.
   */
  answer = '{"status":"error","error":"app_id is required when action=\'connect\'"}';
  failReports = true;
  const before = snapshot.at;
  const broken = await ga4.ga4Snapshot(true);
  failReports = false;
  /*
   * Hláška se čte z bubliny na telefonu, takže musí být krátká a říct, co
   * dál — celý JSON se do ní nevejde. Ten se schová do nastavení.
   */
  check('pozná se jako chyba', /odpověděl chybou.*app_id is required/.test(broken.error ?? ''), true);
  check('a řekne, kde je celá odpověď', /v nastavení/.test(broken.error ?? ''), true);
  check('celá odpověď se uloží', /app_id is required/.test(ga4.ga4LastDetail()), true);
  /*
   * Do výpisu patří **každý** pokus i s tím, jak dopadl. Dokud se ukládal jen
   * ten poslední, nedalo se poznat, který tvar volání server odmítl a proč.
   */
  check('a je u něj vidět, který tvar volání to byl',
    /tvar/.test(ga4.ga4LastDetail()), true);
  /*
   * Čísla zůstanou ta poslední známá — starý snímek je lepší než prázdno —
   * ale musí být poznat, že jsou stará: čas se nepřepíše a chyba je vidět.
   * Dřív se z chybové odpovědi stala nula návštěv, což vypadalo jako pravda.
   */
  check('poslední známá čísla zůstanou', broken.window.sessions, 1234);
  check('ale nevydávají se za čerstvá', broken.at, before);

  console.log('\nsíť selže:\n');
  /*
   * `fetch failed` samo o sobě neřekne nic — ani adresu, ani důvod. A když
   * spadne až druhý krok, nesmí se kvůli tomu ztratit ten první.
   */
  const puvodni = global.fetch;
  let pokusy = 0;
  global.fetch = async () => {
    pokusy++;
    const chyba = new Error('fetch failed');
    chyba.cause = { message: 'getaddrinfo ENOTFOUND api.sequel.sh' };
    throw chyba;
  };
  const spadlo = await ga4.ga4Snapshot(true);
  check('jedno klopýtnutí se zkusí znovu', pokusy >= 2, true);
  check('a v hlášce je adresa i důvod',
    /api\.sequel\.sh.*ENOTFOUND/.test(spadlo.error ?? ''), true);

  /*
   * Nenavázané spojení není chyba nastavení. „Zkontroluj adresu" u toho radit
   * nemá smysl — server buď neběží, nebo se k němu tahle síť nedostane.
   */
  global.fetch = async () => {
    const chyba = new Error('fetch failed');
    chyba.cause = { message: 'Connect Timeout Error (attempted address: api.sequel.sh:443, timeout: 10000ms)' };
    throw chyba;
  };
  const mlci = await ga4.ga4Snapshot(true);
  check('nenavázané spojení se nesvádí na nastavení',
    /neozval/.test(mlci.error ?? '') && !/adresu v nastavení/.test(mlci.error ?? ''), true);
  global.fetch = puvodni;

  console.log('\nvypršené přihlášení:\n');
  /*
   * Když v Sequelu vyprší souhlas s Google účtem, odpoví na dotaz
   * `{"action":"reconnect","status":"pending"}`. Vypadá to jako úspěch,
   * data v tom nejsou žádná a hláška s kusem JSONu nikomu nic neřekne.
   */
  answer = '{"status":"success","data":{"action":"reconnect","status":"pending",'
    + '"connection_id":"s6f02zyp","url":"https://sequel.sh/connections/s6f02zyp"}}';
  pendingReconnect = true;
  const stale = await ga4.ga4Snapshot(true);
  pendingReconnect = false;
  check('řekne se, že čeká přihlášení', /čeká na nové přihlášení/.test(stale.error ?? ''), true);
  check('a kam se má kliknout', /sequel\.sh\/connections/.test(stale.error ?? ''), true);
  // `reconnect` se nesmí poslat jako dotaz — z výběru akcí musí vypadnout
  check('reconnect se nebere jako dotaz',
    ga4.__test.pickQueryAction(['connect', 'reconnect', 'run_query', 'list']), ['run_query']);
  /*
   * A když se přefiltruje všechno? Přesně tohle se stalo v provozu: seznam
   * skončil prázdný, smyčka neproběhla vůbec a v okně stálo „zkoušené
   * akce: " — bez akce a bez odpovědi. Zkusit se má vždycky něco.
   */
  check('prázdno se nevrací nikdy, i když nic nevypadá jako dotaz',
    ga4.__test.pickQueryAction(['connect', 'disconnect', 'list_apps', 'refresh_token']),
    ['list_apps', 'refresh_token']);
  check('a když jsou jen připojení, zkusí se i ta',
    ga4.__test.pickQueryAction(['connect', 'disconnect']), ['connect', 'disconnect']);

  console.log('\ndiagnostika:\n');
  const tools = await ga4.ga4Diagnostics();
  check('vypíše, co server umí',
    /sequel_manage_connections\(action_info, action, app_id, connection_id\)/.test(tools), true);
  // Popis od serveru je jediná dokumentace, kterou k Sequelu máme
  check('i s tím, co k nim server sám píše', /Run the tool calls returned by search/.test(tools), true);
  check('a co je povinné', /povinné: action/.test(tools), true);
  /*
   * Výčet akcí patří do výpisu. Jméno „action" neřekne nic — teprve hodnoty
   * ukážou, jestli je tam vůbec něco, čím se dá zeptat. Přesně na tom se
   * napojení jednou zaseklo a z okna se to nedalo poznat.
   */
  check('a jaké hodnoty akce nabízí', /action: list \| connect \| reconnect/.test(tools), true);

  console.log(failed ? `\n✗ ${failed} zkoušek selhalo\n` : '\n✓ napojení na Sequel sedí\n');
  process.exit(failed ? 1 : 0);
})();
