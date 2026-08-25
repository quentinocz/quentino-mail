/**
 * Zkouška překladu a exportu s falešným modelem.
 *
 * Model se nahradí funkcí, která vrátí „přeložený" text (předřadí značku
 * jazyka), takže jde ověřit celý řetěz: rozdělení práce → volání → uložení →
 * změna stavu → export do XML. Bez jediného tokenu navíc.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const { db, store, xml, DIST } = require('./harness.cjs');

// Falešný model
const ai = require(path.join(DIST, 'ai.js'));
let calls = 0;
ai.ask = async (model, system, user) => {
  calls++;
  const payload = JSON.parse(user.slice(user.indexOf('{')));
  const lang = /jazyka „([a-z]{2,5})"/.exec(system)?.[1] ?? '??';
  const out = {};
  for (const [key, value] of Object.entries(payload)) {
    // HTML se má zachovat — falešný překlad mění jen text uvnitř značek
    out[key] = String(value).replace(/>([^<]+)</g, (m, text) => `>[${lang}] ${text.trim()}<`);
    if (!out[key].includes('[')) out[key] = `[${lang}] ${value}`;
  }
  return JSON.stringify(out);
};

const settings = require(path.join(DIST, 'settings.js'));
settings.getSettings = () => ({ draftModel: 'test-model', brandPrompt: '' });

const translate = require(path.join(DIST, 'ptrans/translate.js'));
const exportxml = require(path.join(DIST, 'ptrans/exportxml.js'));

(async () => {
  const feed = fs.readFileSync('/home/claude/feed.xml', 'utf8');
  store.syncFromFeed(feed);

  // Tři produkty, u kterých je co dělat
  const todo = store.listProducts({ state: 'todo', limit: 3 });
  const codes = todo.rows.map(r => r.code);
  console.log('produkty:', codes.join(', '));

  const plan = translate.planWork(codes, ['sk', 'en'], {});
  console.log('úkolů:', plan.length, '→', plan.map(p => `${p.code}/${p.lang}:${p.fields.length}`).join(' '));

  const started = Date.now();
  const result = await translate.run({ codes, langs: ['sk', 'en'] });
  console.log('výsledek:', JSON.stringify(result), '· volání modelu:', calls,
    '· trvalo', ((Date.now() - started) / 1000).toFixed(1) + ' s');

  const after = store.productFields(codes[0], ['sk']);
  console.log('\npo překladu (' + codes[0] + ', sk):');
  for (const row of after) {
    console.log(' ', row.field.padEnd(10), row.state.padEnd(7), JSON.stringify((row.translated ?? row.value).slice(0, 70)));
  }

  const built = exportxml.buildExport({ langs: ['sk', 'en'] });
  console.log('\nexport:', built.products, 'produktů,', built.fields, 'polí,', built.xml.length, 'znaků');
  fs.writeFileSync(path.join(os.tmpdir(), 'ptrans-export.xml'), built.xml);

  // Kontrola tvaru: musí to být platné XML se stejnými značkami
  const { XMLParser } = (() => { try { return require('fast-xml-parser'); } catch { return {}; } })();
  const opens = (built.xml.match(/<PRODUCT>/g) ?? []).length;
  const closes = (built.xml.match(/<\/PRODUCT>/g) ?? []).length;
  console.log('bloků PRODUCT:', opens, '/', closes, opens === closes ? '✓' : '✗');
  const sample = built.xml.split('<PRODUCT>')[1].split('</PRODUCT>')[0];
  console.log('\nukázka exportu (prvních 900 znaků):\n' + sample.slice(0, 900));

  const full = exportxml.buildExport({ langs: ['sk'], mode: 'full' });
  console.log('\nplný režim:', full.xml.length, 'znaků (slim byl', built.xml.length + ')');
})();
