/**
 * Dlouhá odpověď od modelu — proudem, ne obyčejným dotazem.
 *
 * Knihovna Anthropic odmítne obyčejný dotaz se stropem odpovědi nad zhruba
 * 21 tisíc tokenů („Streaming is strongly recommended…"), dřív než vůbec
 * něco odešle. Překlad dlouhého popisu přes tu hranici šel — hlavně při
 * opakování se zdvojeným stropem po useknuté odpovědi — a skončil chybou,
 * kterou opakování nespravilo.
 *
 * Zkouší se proti místnímu serveru, který se tváří jako API: malý strop
 * jde obyčejně, velký proudem, a obojí vrátí text.
 *
 *   npx tsc -p tsconfig.main.json --outDir dist/ptdist
 *   node tools/ai-stream-test.cjs
 */
const http = require('http');
const path = require('path');
const os = require('os');

const DIST = process.env.PTDIST || path.join(__dirname, '../dist/ptdist/main');
const shim = (name, exports) => {
  const id = require.resolve(path.join(DIST, name));
  require.cache[id] = { id, filename: id, loaded: true, exports };
};
const noDb = { prepare: () => ({ run: () => ({}), get: () => undefined, all: () => [] }) };
shim('db.js', { getDb: () => noDb, getSetting: (_k, f = null) => f, setSetting: () => {} });
shim('settings.js', { getSettings: () => ({}), getApiKey: () => 'zkusebni-klic', listKnowledge: () => [] });
shim('accounts.js', { getAccountWithPassword: () => null });
shim('upgates.js', { ordersContextForAi: async () => '' });
require.cache[require.resolve('electron')] = { id: 'electron', filename: 'electron', loaded: true,
  exports: { BrowserWindow: { getAllWindows: () => [] }, app: { getPath: () => os.tmpdir() } } };

const seen = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    const input = JSON.parse(body || '{}');
    seen.push({ stream: !!input.stream, max: input.max_tokens });
    const message = {
      id: 'msg_1', type: 'message', role: 'assistant', model: input.model, stop_reason: 'end_turn',
      stop_sequence: null, usage: { input_tokens: 3, output_tokens: 2 },
      content: [{ type: 'text', text: `odpověď ${input.max_tokens}` }]
    };
    if (!input.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(message));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null } });
    send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: message.content[0].text } });
    send('content_block_stop', { type: 'content_block_stop', index: 0 });
    send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } });
    send('message_stop', { type: 'message_stop' });
    res.end();
  });
});

let bad = 0;
const check = (label, ok, detail = '') => {
  if (!ok) bad++;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
};

server.listen(0, '127.0.0.1', async () => {
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  const { ask } = require(path.join(DIST, 'ai.js'));
  console.log('dlouhá odpověď od modelu:\n');
  try {
    const short = await ask('model', 'systém', 'dotaz', 1000);
    check('krátká odpověď jde obyčejným dotazem', short === 'odpověď 1000' && seen[0]?.stream === false,
      JSON.stringify({ short, seen }));
    const long = await ask('model', 'systém', 'dotaz', 30000, { attempts: 1 });
    check('odpověď se stropem 30 000 tokenů projde', long === 'odpověď 30000', long);
    check('  a šla proudem', seen[1]?.stream === true, JSON.stringify(seen));
  } catch (e) {
    check('dlouhá odpověď projde', false, String(e?.message ?? e));
  }
  server.close();
  console.log(bad ? `\n${bad} věcí nesedí` : '\ndlouhý popis nenarazí na strop knihovny');
  process.exit(bad ? 1 : 0);
});
