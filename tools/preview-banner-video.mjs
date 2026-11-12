/*
 * Video v banneru — zkouška v prohlížeči.
 *
 * ## Proč v prohlížeči
 *
 * Hlášení znělo: „video se po přehrání zastaví, mělo by běžet dokola."
 * Skript přitom `loop` nastavený měl a zkouška v kódu to hlídala — jenže
 * hlídala **slovo ve zdrojáku**, ne to, jestli se obraz hýbe. `loop` je
 * prosba, ne záruka: prohlížeč video umí zastavit sám a nikomu to
 * neřekne (na konci nepřetočí, uspí ho kvůli baterii, po návratu na
 * kartu ho nechá stát, a Safari ho umí nechat zamrzlé, i když o sobě
 * tvrdí, že hraje — WebKit 233472).
 *
 * Proto se tady neměří, co je napsané, ale **co se děje**: skutečný
 * skript banneru běží v prohlížeči proti místnímu serveru, videu se
 * schválně udělá to, co mu umí udělat prohlížeč, a změří se, jestli se
 * čas videa zase rozběhne.
 *
 * ## Kontrola oběma směry
 *
 * Vedle banneru leží na stránce **holé video** poskládané přesně tak,
 * jak ho skript skládal dřív (muted, autoplay, loop, playsinline a nic
 * víc). Dostane tutéž ránu. Kdyby zůstalo hrát i ono, zkouška by
 * neměřila nic — rána by byla slabá a oprava by „prošla" zadarmo.
 *
 *   npm run build:main -- --outDir dist/ptdist   (nebo npm run typecheck)
 *   node tools/preview-banner-video.mjs
 */
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { DIST } = require('./ptrans/harness.cjs');
for (const [mod, exp] of [
  ['secure.js', { encrypt: v => v, decrypt: v => v }],
  ['ai.js', { ask: async () => '[]' }],
  ['settings.js', { getSettings: () => ({ draftModel: 'zkousky-model', fastModel: 'zkousky-model' }) }]
]) {
  const cesta = require.resolve(path.join(DIST, mod));
  require.cache[cesta] = { id: cesta, filename: cesta, loaded: true, exports: exp };
}
const banners = require(path.join(DIST, 'banners.js'));
const { bannerScript } = require(path.join(DIST, 'bannerscript.js'));
/*
 * Playwright je jen v sandboxu, ne v repozitáři. Na počítači, kde chybí,
 * se zkouška přeskočí — spadnout kvůli tomu nesmí.
 */
let pw;
try { pw = (await import('playwright')).default; }
catch { console.log('playwright není — zkouška videa v banneru se přeskakuje'); process.exit(0); }

let chyb = 0;
function say(label, ok, note = '') {
  if (!ok) chyb += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${note ? `   ${note}` : ''}`);
}

/* ---------- zkušební video ---------- */

/*
 * Dvě vteřiny, ať je konec videa vidět několikrát za zkoušku. Vyrábí se
 * na místě: čtyřicet kilobajtů v repozitáři kvůli zkoušce by nafouklo
 * každý balíček, a ffmpeg tu je tak jako tak kvůli konvertoru médií.
 */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qbn-video-'));
const SOUBOR = path.join(TMP, 'kratke.webm');
try {
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi',
    '-i', 'testsrc2=size=320x240:rate=25:duration=2',
    '-c:v', 'libvpx-vp9', '-b:v', '200k', '-an', SOUBOR]);
} catch (e) {
  console.log('✗ zkušební video se nepodařilo vyrobit — je v počítači ffmpeg?');
  console.log('  ' + String(e?.message ?? e).split('\n')[0]);
  process.exit(1);
}
const VIDEO = fs.readFileSync(SOUBOR);

/* ---------- místní server ---------- */

const pozadavky = new Map();
let stranka = '';
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  pozadavky.set(url.pathname, (pozadavky.get(url.pathname) ?? 0) + 1);
  if (url.pathname.startsWith('/zadne')) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('není');
    return;
  }
  if (url.pathname.endsWith('.webm')) {
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    if (range) {
      const od = Number(range[1]);
      const po = range[2] ? Number(range[2]) : VIDEO.length - 1;
      res.writeHead(206, {
        'content-type': 'video/webm', 'accept-ranges': 'bytes',
        'content-range': `bytes ${od}-${po}/${VIDEO.length}`, 'content-length': po - od + 1
      });
      res.end(VIDEO.subarray(od, po + 1));
    } else {
      res.writeHead(200, { 'content-type': 'video/webm', 'accept-ranges': 'bytes', 'content-length': VIDEO.length });
      res.end(VIDEO);
    }
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(stranka);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const ZAKLAD = `http://127.0.0.1:${server.address().port}`;

/* ---------- stránka ---------- */

const banner = (id, video) => ({
  id, name: id,
  copy: {
    kicker: { cz: '', sk: '', en: '' }, title: { cz: `Banner ${id}`, sk: '', en: '' },
    text: { cz: '', sk: '', en: '' }, button: { cz: 'Zobrazit', sk: '', en: '' },
    href: { cz: '/x', sk: '', en: '' }
  },
  look: { image: '', video, bg: '#123456', fg: '#ffffff', overlay: 40, align: 'left', pos: 'bottom', focus: '50% 50%' }
});

/**
 * Stránka s bannerem a s holým videem vedle něj.
 *
 * Holé video je opis toho, jak skript video skládal před opravou — tedy
 * to, co by na webu běželo, kdyby se nic nezměnilo.
 */
function postavStranku(sada, kontrola = true) {
  const row = banners.__test.setRow(banners.__test.normalizeSet(sada));
  const script = bannerScript({ url: '', ttl: 300, fallback: row });
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<style>body{margin:0}</style>',
    '<script>window.__quentinoLang="cz"</script>', script, '</head><body>',
    '<div class="section bic-bnr"><div class="container"><div class="max">',
    '<div id="banner1">původní karusel</div></div></div></div>',
    '<div id="kontrola" style="width:160px;height:120px"></div>',
    '<div style="height:2600px">další obsah stránky</div>',
    kontrola ? `<script>(function () {
      var vid = document.createElement("video");
      vid.muted = true; vid.defaultMuted = true; vid.autoplay = true; vid.loop = true; vid.playsInline = true;
      vid.setAttribute("muted", ""); vid.setAttribute("playsinline", ""); vid.setAttribute("preload", "metadata");
      vid.style.width = "160px";
      vid.src = "${ZAKLAD}/kontrola.webm";
      var slib = vid.play(); if (slib && slib.catch) slib.catch(function () {});
      document.getElementById("kontrola").appendChild(vid);
    })();</script>` : '',
    '</body></html>'
  ].join('');
}

const SIROKY = (videa, extra = {}) => ({
  id: 's', name: 's', layout: 'wide', phone: 'wide', rotate: 0,
  banners: videa.map((v, i) => banner(String.fromCharCode(97 + i), v)),
  ...extra
});

const preinstalled = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium/chrome-linux/chrome']
  .find(one => fs.existsSync(one));
let browser;
try { browser = await pw.chromium.launch(preinstalled ? { executablePath: preinstalled } : {}); }
catch (e) {
  console.log('prohlížeč se nespustil — zkouška videa v banneru se přeskakuje:', e.message.split('\n')[0]);
  server.close();
  process.exit(0);
}
const chybyStranky = [];

async function otevri(sada, { sirka = 1240, kontrola = true } = {}) {
  stranka = postavStranku(sada, kontrola);
  const page = await browser.newPage({ viewport: { width: sirka, height: 800 } });
  page.on('pageerror', e => chybyStranky.push(String(e?.message ?? e)));
  await page.goto(`${ZAKLAD}/`);
  await page.waitForFunction(() => document.querySelectorAll('.qbn video').length > 0, null, { timeout: 5000 })
    .catch(() => undefined);
  await page.waitForTimeout(700);
  return page;
}

/** Hýbe se video? Dva odběry času po sobě — ne co o sobě video tvrdí. */
async function hybeSe(page, selector, zaMs = 700) {
  const cas = () => page.evaluate(sel => {
    const vid = document.querySelector(sel);
    return vid ? vid.currentTime : -1;
  }, selector);
  const a = await cas();
  await page.waitForTimeout(zaMs);
  const b = await cas();
  return a >= 0 && a !== b;
}

/** Čeká, až se video rozhýbe; vrací, za jak dlouho (ms), nebo -1. */
async function rozhybeSe(page, selector, doMs) {
  const od = Date.now();
  while (Date.now() - od < doMs) {
    if (await hybeSe(page, selector, 400)) return Date.now() - od;
  }
  return -1;
}

const V = n => `${ZAKLAD}/v${n}.webm`;
const BANNER = '.qbn video';
const HOLE = '#kontrola video';

console.log('\nvideo v banneru — v prohlížeči:\n');

/* ---------- 1. obyčejný běh ---------- */
{
  const page = await otevri(SIROKY([V(1)]));
  /* Dvouvteřinové video musí za šest vteřin aspoň dvakrát začít znovu */
  const prubeh = [];
  for (let i = 0; i < 14; i++) {
    prubeh.push(await page.evaluate(() => document.querySelector('.qbn video').currentTime));
    await page.waitForTimeout(450);
  }
  const navratu = prubeh.filter((t, i) => i > 0 && t < prubeh[i - 1]).length;
  say('video v banneru běží dokola', navratu >= 2, `za šest vteřin začalo znovu ${navratu}×`);
  say('  a jakmile hraje, je vidět (fotka pod ním ustoupí)',
    await page.evaluate(() => document.querySelector('.qbn video').hasAttribute('data-hraje')));
  await page.close();
}

/* ---------- 2. prohlížeč na konci nepřetočí ---------- */
{
  /*
   * Tohle je nahlášená chyba: video doběhne a zůstane stát. Napodobí se
   * tím, že se smyčka videu vezme — přesně to se stane, když prohlížeč
   * na konci nedokáže přetočit na začátek.
   */
  const page = await otevri(SIROKY([V(1)]));
  await page.evaluate(() => { for (const vid of document.querySelectorAll('video')) vid.loop = false; });
  await page.waitForTimeout(3200);
  const hole = await hybeSe(page, HOLE);
  say('  (holé video po konci zůstane stát — to je ta chyba)', !hole,
    hole ? 'hraje dál, rána nezabrala' : 'stojí na posledním snímku');
  say('když prohlížeč smyčku neudělá, banner si video pustí znovu sám', await hybeSe(page, BANNER));
  await page.close();
}

/* ---------- 3. prohlížeč video zastaví ---------- */
{
  /* Úsporný režim, návrat z jiné karty: video dostane pauzu a nikdo mu neřekne proč */
  const page = await otevri(SIROKY([V(1)]));
  await page.evaluate(() => { for (const vid of document.querySelectorAll('video')) vid.pause(); });
  const za = await rozhybeSe(page, BANNER, 5000);
  say('zastavené video se samo rozběhne', za >= 0, za >= 0 ? `za ${(za / 1000).toFixed(1)} s` : 'stojí');
  say('  (holé video zůstane zastavené)', !(await hybeSe(page, HOLE)));
  await page.close();
}

/* ---------- 4. zamrzne a tvrdí, že hraje ---------- */
{
  /*
   * Nejhorší případ: video stojí, ale `paused` je nepravda a žádná
   * událost nepřišla (takhle zamrzá Safari). Poznat se to dá jen
   * měřením času. Napodobí se nulovou rychlostí přehrávání.
   */
  const page = await otevri(SIROKY([V(1)]));
  await page.evaluate(() => { for (const vid of document.querySelectorAll('video')) vid.playbackRate = 0; });
  await page.waitForTimeout(600);
  const tvrdi = await page.evaluate(() => {
    const vid = document.querySelector('.qbn video');
    return { paused: vid.paused, ended: vid.ended };
  });
  say('  (zamrzlé video o sobě tvrdí, že hraje)', !tvrdi.paused && !tvrdi.ended, JSON.stringify(tvrdi));
  const za = await rozhybeSe(page, BANNER, 9000);
  say('zamrzlé video se pozná podle času a rozhýbe se', za >= 0,
    za >= 0 ? `za ${(za / 1000).toFixed(1)} s` : 'stojí');
  say('  (holé video zůstane zamrzlé)', !(await hybeSe(page, HOLE)));
  await page.close();
}

/* ---------- 5. co není vidět, nehraje ---------- */
{
  const page = await otevri(SIROKY([V(1)]));
  await page.evaluate(() => window.scrollTo(0, 1800));
  await page.waitForTimeout(900);
  say('odrolovaný banner video zastaví', !(await hybeSe(page, BANNER)));
  await page.evaluate(() => window.scrollTo(0, 0));
  const za = await rozhybeSe(page, BANNER, 4000);
  say('  a po návratu ho zase pustí', za >= 0, za >= 0 ? `za ${(za / 1000).toFixed(1)} s` : 'stojí');

  /* Karta prohlížeče na pozadí */
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(500);
  say('karta na pozadí video zastaví', !(await hybeSe(page, BANNER)));
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const zpet = await rozhybeSe(page, BANNER, 4000);
  say('  a po návratu na kartu hraje dál', zpet >= 0);
  await page.close();
}

/* ---------- 6. rotace: hraje jen stránka, která je navrchu ---------- */
{
  const page = await otevri(SIROKY([V(1), V(2)], { rotate: 3 }), { kontrola: false });
  const kdoHraje = async () => {
    const a = await page.evaluate(() => [...document.querySelectorAll('.qbn video')].map(v => v.currentTime));
    await page.waitForTimeout(600);
    const b = await page.evaluate(() => [...document.querySelectorAll('.qbn video')].map(v => v.currentTime));
    return a.map((t, i) => (t !== b[i] ? 1 : 0));
  };
  const hraly = [0, 0];
  let naraz = 0;
  for (let i = 0; i < 11; i++) {
    /*
     * „Naráz" se měří v jednom okamžiku, ne přes okno: odběr, do kterého
     * padne otočení stránky, vidí pohyb u obou videí — jedno právě
     * skončilo, druhé právě začalo — a to chyba není.
     */
    const bezi = await page.evaluate(() =>
      [...document.querySelectorAll('.qbn video')].filter(v => !v.paused).length);
    if (bezi > 1) naraz += 1;
    const ted = await kdoHraje();
    hraly[0] += ted[0];
    hraly[1] += ted[1];
  }
  say('při rotaci hraje video jen na stránce, která je vidět', naraz === 0,
    `obě naráz ${naraz}× z 11 odběrů`);
  say('  a na řadu přijdou obě', hraly[0] > 0 && hraly[1] > 0, `první ${hraly[0]}×, druhé ${hraly[1]}×`);
  await page.close();
}

/* ---------- 7. posuvník na telefonu ---------- */
{
  const page = await otevri({
    id: 's', name: 's', layout: 'quad', phone: 'carousel', loop: true, rotate: 0,
    banners: [banner('a', V(1)), banner('b', V(2)), banner('c', '')]
  }, { sirka: 390, kontrola: false });
  const prvni = '.qbn-track > :nth-child(1) video';
  const druhe = '.qbn-track > :nth-child(2) video';
  say('v posuvníku hraje dlaždice, která je vidět', await hybeSe(page, prvni));
  await page.evaluate(() => {
    const track = document.querySelector('.qbn-track');
    const cil = track.children[1];
    track.scrollTo({ left: cil.offsetLeft - track.offsetLeft, behavior: 'instant' });
  });
  const za = await rozhybeSe(page, druhe, 4000);
  say('  a po posunutí se pustí ta další', za >= 0, za >= 0 ? `za ${(za / 1000).toFixed(1)} s` : 'stojí');
  await page.close();
}

/* ---------- 8. video, které neexistuje ---------- */
{
  /*
   * Hlídač nesmí tahat soubor donekonečna. Smazané video ve správci
   * souborů by jinak znamenalo požadavek každé dvě vteřiny od každého
   * návštěvníka úvodní stránky.
   */
  pozadavky.clear();
  const page = await otevri(SIROKY([`${ZAKLAD}/zadne.webm`]), { kontrola: false });
  await page.waitForTimeout(16000);
  const kolik = pozadavky.get('/zadne.webm') ?? 0;
  say('chybějící video se nezkouší donekonečna', kolik >= 1 && kolik <= 4, `${kolik} požadavků za 16 vteřin`);
  say('  a místo něj zůstane fotka',
    await page.evaluate(() => !document.querySelector('.qbn video').hasAttribute('data-hraje')));
  await page.close();
}

say('skript při tom nikde nespadl', chybyStranky.length === 0, chybyStranky.slice(0, 2).join(' · '));

await browser.close();
server.close();
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* uklidí systém */ }
console.log(chyb ? `\n✗ ${chyb} chyb` : '\n✓ video v banneru sedí');
process.exit(chyb ? 1 : 0);
