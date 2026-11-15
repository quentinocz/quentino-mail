/*
 * Společný základ pro zkoušky bannerů v prohlížeči.
 *
 * Bannery na e-shopu kreslí skript, a o tom, co udělá, rozhoduje
 * prohlížeč — ne to, co je ve skriptu napsáno. Zkoušky, které to měří
 * (`preview-banner-video.mjs`, `preview-banner-foto.mjs`), proto všechny
 * potřebují totéž: skutečný skript, tak jak odchází do e-shopu, místní
 * server, který si počítá, co si prohlížeč vyžádal, a stránku, která se
 * tváří jako úvodní stránka e-shopu.
 */
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { DIST } = require('./ptrans/harness.cjs');
// Trezor, AI ani nastavení mimo Electron nejsou; zkouší se kreslení, ne ony
for (const [mod, exp] of [
  ['secure.js', { encrypt: v => v, decrypt: v => v }],
  ['ai.js', { ask: async () => '[]' }],
  ['settings.js', { getSettings: () => ({ draftModel: 'zkousky-model', fastModel: 'zkousky-model' }) }]
]) {
  const cesta = require.resolve(path.join(DIST, mod));
  require.cache[cesta] = { id: cesta, filename: cesta, loaded: true, exports: exp };
}
export const banners = require(path.join(DIST, 'banners.js'));
export const { bannerScript } = require(path.join(DIST, 'bannerscript.js'));

let chyb = 0;
export function say(label, ok, note = '') {
  if (!ok) chyb += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${note ? `   ${note}` : ''}`);
}
export const pocetChyb = () => chyb;

/**
 * Prohlížeč. Playwright je jen v sandboxu, ne v repozitáři — na počítači,
 * kde chybí, se zkouška přeskočí. Spadnout kvůli tomu nesmí.
 */
export async function prohlizec(co) {
  let pw;
  try { pw = (await import('playwright')).default; }
  catch { console.log(`playwright není — ${co} se přeskakuje`); process.exit(0); }
  const hotovy = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium/chrome-linux/chrome']
    .find(one => fs.existsSync(one));
  try { return await pw.chromium.launch(hotovy ? { executablePath: hotovy } : {}); }
  catch (e) {
    console.log(`prohlížeč se nespustil — ${co} se přeskakuje:`, e.message.split('\n')[0]);
    process.exit(0);
  }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qbn-zkouska-'));
export const uklid = () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* uklidí systém */ } };

/**
 * Zkušební soubor vyrobený ffmpegem.
 *
 * Vyrábí se na místě: fotky a video v repozitáři kvůli zkoušce by
 * nafoukly každý balíček, a ffmpeg tu je tak jako tak kvůli konvertoru.
 */
export function vyrob(jmeno, args) {
  const soubor = path.join(TMP, jmeno);
  try {
    execFileSync('ffmpeg', ['-y', '-v', 'error', ...args, soubor]);
  } catch (e) {
    console.log(`✗ zkušební soubor ${jmeno} se nepodařilo vyrobit — je v počítači ffmpeg?`);
    console.log('  ' + String(e?.message ?? e).split('\n')[0]);
    process.exit(1);
  }
  return fs.readFileSync(soubor);
}

/**
 * Místní server.
 *
 * `soubory` je slovník cesta → { typ, data }. Umí částečné stahování
 * (video ho chce), počítá požadavky po cestách a všechno ostatní
 * odpoví stránkou — takže „/" i „/kravaty" je táž stránka e-shopu.
 */
export async function server(soubory) {
  const pozadavky = new Map();
  let html = '';
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    pozadavky.set(url.pathname, (pozadavky.get(url.pathname) ?? 0) + 1);
    if (url.pathname.startsWith('/zadne')) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('není');
      return;
    }
    /* /v1.webm, /v2.webm… jsou totéž video pod jinou adresou */
    const klic = Object.keys(soubory).find(one => one === url.pathname)
      ?? Object.keys(soubory).find(one => one.startsWith('*') && url.pathname.endsWith(one.slice(1)));
    if (klic) {
      const { typ, data } = soubory[klic];
      const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
      if (range) {
        const od = Number(range[1]);
        const po = range[2] ? Number(range[2]) : data.length - 1;
        res.writeHead(206, {
          'content-type': typ, 'accept-ranges': 'bytes',
          'content-range': `bytes ${od}-${po}/${data.length}`, 'content-length': po - od + 1
        });
        res.end(data.subarray(od, po + 1));
      } else {
        res.writeHead(200, { 'content-type': typ, 'accept-ranges': 'bytes', 'content-length': data.length });
        res.end(data);
      }
      return;
    }
    if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  return {
    zaklad: `http://127.0.0.1:${srv.address().port}`,
    pozadavky,
    nastav: text => { html = text; },
    zavri: () => srv.close()
  };
}

/** Banner pro zkoušku — jen to, co se liší, zbytek je obyčejná dlaždice. */
export const banner = (id, look = {}, copy = {}, extra = {}) => ({
  id, name: id,
  copy: {
    kicker: { cz: '', sk: '', en: '' }, title: { cz: `Banner ${id}`, sk: '', en: '' },
    text: { cz: '', sk: '', en: '' }, button: { cz: 'Zobrazit', sk: '', en: '' },
    href: { cz: '/x', sk: '', en: '' },
    ...copy
  },
  look: {
    image: '', video: '', bg: '#123456', fg: '#ffffff', overlay: 40,
    align: 'left', pos: 'bottom', focus: '50% 50%', ...look
  },
  ...extra
});

/**
 * Stránka, která se tváří jako úvodní stránka e-shopu.
 *
 * Skript je v hlavičce, stejně jako v Upgates, a ve stránce je místo
 * původního karuselu i sekce pro bloky — skript obojí hledá.
 */
export function stranka(sada, { hlava = '', telo = '', jazyk = 'cz' } = {}) {
  const row = banners.__test.setRow(banners.__test.normalizeSet(sada));
  const script = bannerScript({ url: '', ttl: 300, fallback: row });
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<style>body{margin:0}</style>', hlava,
    `<script>window.__quentinoLang=${JSON.stringify(jazyk)}</script>`, script, '</head><body>',
    '<div class="section bic-bnr"><div class="container"><div class="max">',
    '<div id="banner1">původní karusel</div></div></div></div>',
    '<div class="section bic-hdln"><div class="container"><div class="max">bloky šablony</div></div></div>',
    telo,
    '<div style="height:2600px">další obsah stránky</div>',
    '</body></html>'
  ].join('');
}
