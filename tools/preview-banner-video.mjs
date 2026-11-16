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
import { banner as dlazdice, pocetChyb, prohlizec, say, server, stranka, uklid, vyrob } from './banner-web.mjs';

/*
 * Dvě vteřiny, ať je konec videa vidět několikrát za zkoušku.
 */
const VIDEO = vyrob('kratke.webm', ['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=25:duration=2',
  '-c:v', 'libvpx-vp9', '-b:v', '200k', '-an']);
const web = await server({ '*.webm': { typ: 'video/webm', data: VIDEO } });
const ZAKLAD = web.zaklad;
const pozadavky = web.pozadavky;

const banner = (id, video) => dlazdice(id, { video });

/**
 * Stránka s bannerem a s holým videem vedle něj.
 *
 * Holé video je opis toho, jak skript video skládal před opravou — tedy
 * to, co by na webu běželo, kdyby se nic nezměnilo.
 */
function postavStranku(sada, kontrola = true) {
  return stranka(sada, {
    telo: '<div id="kontrola" style="width:160px;height:120px"></div>' + (kontrola ? `<script>(function () {
      var vid = document.createElement("video");
      vid.muted = true; vid.defaultMuted = true; vid.autoplay = true; vid.loop = true; vid.playsInline = true;
      vid.setAttribute("muted", ""); vid.setAttribute("playsinline", ""); vid.setAttribute("preload", "metadata");
      vid.style.width = "160px";
      vid.src = "${ZAKLAD}/kontrola.webm";
      var slib = vid.play(); if (slib && slib.catch) slib.catch(function () {});
      document.getElementById("kontrola").appendChild(vid);
    })();</script>` : '')
  });
}

const SIROKY = (videa, extra = {}) => ({
  id: 's', name: 's', layout: 'wide', phone: 'wide', rotate: 0,
  banners: videa.map((v, i) => banner(String.fromCharCode(97 + i), v)),
  ...extra
});

const browser = await prohlizec('zkouška videa v banneru');
const chybyStranky = [];

async function otevri(sada, { sirka = 1240, kontrola = true } = {}) {
  web.nastav(postavStranku(sada, kontrola));
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

/* ---------- 9. dva formáty: hraje se ten, který jde ---------- */
{
  /*
   * Video se při nahrání převádí na MP4 a k němu WebM. Prohlížeč má
   * dostat WebM první (je menší) a na MP4 přejít sám, když WebM nejde.
   * Tady se první formát schválně nedá stáhnout — hrát se má druhý.
   */
  pozadavky.clear();
  const page = await otevri({
    id: 's', name: 's', layout: 'wide', phone: 'wide', rotate: 0,
    banners: [dlazdice('a', { video: V(1), videoAlt: `${ZAKLAD}/zadne-alt.webm` })]
  }, { kontrola: false });
  const zdroje = await page.evaluate(() => [...document.querySelectorAll('.qbn video source')]
    .map(one => `${one.type}:${one.src.split('/').pop()}`));
  say('video nabízí oba formáty, menší první',
    zdroje.join(' ') === 'video/webm:zadne-alt.webm video/webm:v1.webm', zdroje.join(' · '));
  const za = await rozhybeSe(page, BANNER, 5000);
  say('  a když první nejde, hraje se druhý', za >= 0, za >= 0 ? `za ${(za / 1000).toFixed(1)} s` : 'stojí');
  await page.close();

  const poradi = await otevri({
    id: 's', name: 's', layout: 'wide', phone: 'wide', rotate: 0,
    banners: [dlazdice('a', { video: `${ZAKLAD}/film.mp4`, videoAlt: V(2) })]
  }, { kontrola: false });
  const typy = await poradi.evaluate(() => [...document.querySelectorAll('.qbn video source')].map(one => one.type));
  say('  WebM je před MP4, ať se zapíše do banneru jakkoli', typy.join(' ') === 'video/webm video/mp4', typy.join(' · '));
  await poradi.close();
}

/* ---------- 10. tlačítko pauzy ---------- */
{
  const page = await otevri(SIROKY([V(1)]), { kontrola: false });
  await page.waitForFunction(() => document.querySelector('.qbn video')?.hasAttribute('data-hraje'), null, { timeout: 5000 })
    .catch(() => undefined);
  const knoflik = page.locator('.qbn .qbn-vbtn');
  const videt = await knoflik.isVisible().catch(() => false);
  say('u hrajícího videa je tlačítko pauzy', videt,
    videt ? await knoflik.getAttribute('aria-label') : 'není vidět');
  const adresaPred = page.url();
  await knoflik.click();
  /*
   * Zastavené zůstane zastavené. Hlídač, který video rozhýbává, nesmí
   * přebít člověka, který ho zastavil schválně — proto se čeká déle,
   * než kolik hlídači stačí na oživení.
   */
  await page.waitForTimeout(5200);
  say('po klepnutí video stojí — a hlídač ho neoživí', !(await hybeSe(page, BANNER)),
    `tlačítko: ${await knoflik.getAttribute('aria-label')}`);
  say('  klepnutí neotevřelo odkaz, ve kterém dlaždice leží', page.url() === adresaPred, page.url());
  await knoflik.click();
  const za = await rozhybeSe(page, BANNER, 4000);
  say('  a druhé klepnutí ho zase pustí', za >= 0);
  await page.close();

  /* Kde zůstala fotka, nemá tlačítko co zastavit */
  const bez = await otevri(SIROKY([`${ZAKLAD}/zadne.webm`]), { kontrola: false });
  await bez.waitForTimeout(3000);
  say('u dlaždice, kde video nehraje, tlačítko není', !(await bez.locator('.qbn .qbn-vbtn').isVisible().catch(() => false)));
  await bez.close();
}

/* ---------- 11. kdo šetří data, dostane fotku ---------- */
{
  const setrim = async (sada, { sirka = 1240, setri = false } = {}) => {
    web.nastav(postavStranku(sada, false));
    pozadavky.clear();
    const page = await browser.newPage({ viewport: { width: sirka, height: 800 } });
    if (setri) {
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'connection', { configurable: true, get: () => ({ saveData: true }) });
      });
    }
    await page.goto(`${ZAKLAD}/`);
    await page.waitForFunction(() => !!document.querySelector('.qbn .qbn-card'), null, { timeout: 5000 })
      .catch(() => undefined);
    await page.waitForTimeout(900);
    const videi = await page.evaluate(() => document.querySelectorAll('.qbn video').length);
    await page.close();
    return { videi, stazeni: pozadavky.get('/v1.webm') ?? 0 };
  };
  const usporne = await setrim(SIROKY([V(1)]), { setri: true });
  say('v úsporném režimu dat se video ani nezačne stahovat', usporne.videi === 0 && usporne.stazeni === 0,
    `${usporne.videi} videí, ${usporne.stazeni} požadavků`);

  const jenPc = { ...SIROKY([V(1)]) };
  jenPc.banners[0].look.videoNoPhone = true;
  const telefon = await setrim(jenPc, { sirka: 390 });
  const pocitac = await setrim(jenPc, { sirka: 1240 });
  say('„na telefonu jen fotka" video na telefonu nepustí', telefon.videi === 0 && telefon.stazeni === 0,
    `${telefon.videi} videí, ${telefon.stazeni} požadavků`);
  say('  ale na počítači hraje dál', pocitac.videi === 1 && pocitac.stazeni >= 1);
}

say('skript při tom nikde nespadl', chybyStranky.length === 0, chybyStranky.slice(0, 2).join(' · '));

await browser.close();
web.zavri();
uklid();
console.log(pocetChyb() ? `\n✗ ${pocetChyb()} chyb` : '\n✓ video v banneru sedí');
process.exit(pocetChyb() ? 1 : 0);
