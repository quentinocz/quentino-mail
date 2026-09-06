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

// Takhle vypadá nástroj Sequelu: akce, zdroj a teprve pak otázka
const TOOL = {
  name: 'sequel',
  description: 'Query connected data sources',
  inputSchema: {
    type: 'object',
    properties: {
      /*
       * Skutečná jména akcí. Dotaz se nejmenuje `query`, ale `run_query` —
       * a přesně na tom to spadlo: kód sáhl po `list`, server ochotně
       * odpověděl seznamem spojení a v přehledu z toho byly nuly.
       */
      action: { type: 'string', enum: ['connect', 'list', 'run_query', 'disconnect'] },
      app_id: { type: 'string' },
      connection_id: { type: 'string' },
      query: { type: 'string' }
    },
    required: ['action']
  }
};

let calls = [];
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

  if (body.method === 'initialize') return reply({ protocolVersion: '2025-06-18' });
  if (body.method === 'notifications/initialized') {
    return { ok: true, status: 202, headers: { get: () => null }, text: async () => '' };
  }
  if (body.method === 'tools/list') return reply({ tools: [TOOL] });
  if (body.method === 'tools/call') {
    const args = body.params?.arguments ?? {};
    // Přesně to, co dělá skutečný server: bez zdroje se ptát nedá
    if (args.action === 'connect' || (args.action === 'run_query' && !args.connection_id)) {
      return reply({ content: [{ type: 'text', text: '{"status":"error","error":"app_id is required when action=\'connect\'"}' }] });
    }
    /*
     * Seznam spojení. Tohle je ta past: na špatnou akci server neodpoví
     * chybou, ale ochotně vrátí výpis — a ten se dřív bral jako odpověď.
     */
    if (args.action === 'list') {
      return reply({ content: [{ type: 'text', text: '{"status":"success","data":{"action":"list","connections":'
        + '[{"connection_id":"s6f02zyp","name":"GA4 — Quentino.cz","type":"google_analytics","expired":false},'
        + '{"connection_id":"pg01","name":"Sklad","type":"postgres","expired":false}]}}' }] });
    }
    return reply({ content: [{ type: 'text', text: answer }] });
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
  // Ne `list` ani `connect` — dotaz se u Sequelu jmenuje jinak a musí se najít
  check('akce je dotaz, ne výpis ani připojení', askCall.params.arguments.action, 'run_query');
  check('a zdroj je vyplněný', askCall.params.arguments.connection_id, 's6f02zyp');
  check('otázka jde pod jménem ze schématu',
    typeof askCall.params.arguments.query === 'string' && askCall.params.arguments.query.length > 20, true);
  check('nic navíc se neposílá', Object.keys(askCall.params.arguments).sort(),
    ['action', 'app_id', 'connection_id', 'query']);
  check('čísla se přečtou', snapshot.window.sessions, 1234);
  check('konverze se dopočítá', snapshot.conversion, 2.5);
  check('a je z čeho srovnávat', snapshot.prevWindow.sessions, 1000);

  console.log('\nnuly nejsou odpověď:\n');
  /*
   * Sequel je jazykový překladač: když dostane vzorový JSON s nulami, umí ho
   * opsat. Spojení pak „funguje" a v přehledu stojí 0 návštěv — což vypadá
   * jako pravda a není. Kostra se proto do dotazu nepřikládá a samé nuly se
   * berou jako nepřečtená odpověď.
   */
  const askText = calls.find(one => one.method === 'tools/call')?.params.arguments.query ?? '';
  check('v dotazu není vzorová odpověď s nulami', /"sessions":0/.test(askText), false);
  check('a jsou v něm konkrétní data', /\d{4}-\d{2}-\d{2} až \d{4}-\d{2}-\d{2}/.test(askText), true);

  answer = '{"window":{"sessions":0,"users":0,"purchases":0,"revenue":0},'
    + '"prevWindow":{"sessions":0,"users":0,"purchases":0,"revenue":0},"sources":[]}';
  const zeros = await ga4.ga4Snapshot(true);
  check('samé nuly se nevydávají za data', /samé nuly/.test(zeros.error ?? ''), true);

  console.log('\nchyba schovaná v odpovědi:\n');
  /*
   * Tohle je ta past: server odpoví dvěstěkou a chybu napíše do textu.
   * Dřív se z ní stala nula návštěv, což vypadalo jako pravda.
   */
  answer = '{"status":"error","error":"app_id is required when action=\'connect\'"}';
  const before = snapshot.at;
  const broken = await ga4.ga4Snapshot(true);
  check('pozná se jako chyba', /app_id is required/.test(broken.error ?? ''), true);
  /*
   * Čísla zůstanou ta poslední známá — starý snímek je lepší než prázdno —
   * ale musí být poznat, že jsou stará: čas se nepřepíše a chyba je vidět.
   * Dřív se z chybové odpovědi stala nula návštěv, což vypadalo jako pravda.
   */
  check('poslední známá čísla zůstanou', broken.window.sessions, 1234);
  check('ale nevydávají se za čerstvá', broken.at, before);

  console.log('\ndiagnostika:\n');
  const tools = await ga4.ga4Diagnostics();
  check('vypíše, co server umí', /sequel\(action, app_id, connection_id, query\)/.test(tools), true);
  check('a co je povinné', /povinné: action/.test(tools), true);

  console.log(failed ? `\n✗ ${failed} zkoušek selhalo\n` : '\n✓ napojení na Sequel sedí\n');
  process.exit(failed ? 1 : 0);
})();
