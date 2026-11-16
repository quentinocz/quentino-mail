/*
 * Měření bannerů — zkouška v prohlížeči.
 *
 * Skript hlásí do Google Analytics, že byl banner vidět a že se na něj
 * kliklo. Jestli to hlásí správně, se z kódu nepozná: „vidět" záleží na
 * tom, kde na obrazovce dlaždice je a která stránka rotace je navrchu,
 * a dvojí započítání nebo proklik přičtený tlačítku pauzy by čísla
 * zkreslily tak, že by se podle nich rozhodovalo špatně. Stránka tu
 * proto dostane falešné Analytics, které si jen zapisuje, co mu přišlo.
 *
 *   node tools/preview-banner-mereni.mjs
 */
import { banner, pocetChyb, prohlizec, say, server, stranka, uklid, vyrob } from './banner-web.mjs';

const VIDEO = vyrob('kratke.webm', ['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=25:duration=2',
  '-c:v', 'libvpx-vp9', '-b:v', '200k', '-an']);
const web = await server({ '*.webm': { typ: 'video/webm', data: VIDEO } });
const Z = web.zaklad;
const browser = await prohlizec('zkouška měření bannerů');
const chybyStranky = [];

const GTAG = '<script>window.__ud=[];window.gtag=function(){window.__ud.push([].slice.call(arguments))}</script>';
const VRSTVA = '<script>window.dataLayer=[]</script>';

async function otevri(sada, { hlava = GTAG, sirka = 1240, vyska = 900 } = {}) {
  web.nastav(stranka(sada, { hlava }));
  const page = await browser.newPage({ viewport: { width: sirka, height: vyska } });
  page.on('pageerror', e => chybyStranky.push(String(e?.message ?? e)));
  await page.goto(`${Z}/`);
  await page.waitForFunction(() => !!document.querySelector('.qbn .qbn-card'), null, { timeout: 5000 })
    .catch(() => undefined);
  /* Klepnutí nesmí stránku odvézt pryč — události by odjely s ní */
  await page.evaluate(() => document.addEventListener('click', e => e.preventDefault()));
  await page.waitForTimeout(700);
  return page;
}
const udalosti = (page, jmeno) => page.evaluate(j => (window.__ud || [])
  .filter(one => one[0] === 'event' && one[1] === j).map(one => one[2]), jmeno);
const cisla = list => list.map(one => one.promotion_id).join(' ');

console.log('\nměření bannerů — v prohlížeči:\n');

const SADA = {
  id: 's', name: 'Podzim', layout: 'quad', phone: 'grid', rotate: 3,
  banners: ['a', 'b', 'c', 'd', 'e', 'f'].map(id => banner(id, {}, { title: { cz: `Nadpis ${id}`, sk: `Nadpis ${id} sk`, en: '' } }))
};

/* ---------- 1. vidět ---------- */
{
  const page = await otevri(SADA);
  const hned = await udalosti(page, 'view_promotion');
  say('viděné jsou bannery, které jsou na obrazovce', cisla(hned) === 'a b c d', cisla(hned));
  say('  ne ty na stránce rotace, která ještě není navrchu', !cisla(hned).includes('e'));
  await page.waitForTimeout(3600);
  const poOtoceni = await udalosti(page, 'view_promotion');
  say('  ty se započítají, až na ně rotace dojde', cisla(poOtoceni) === 'a b c d e f', cisla(poOtoceni));
  await page.waitForTimeout(6500);
  const poKole = await udalosti(page, 'view_promotion');
  say('  a každý jen jednou, i když se rotace točí dál', poKole.length === 6, `${poKole.length} událostí po třech otočkách`);
  const prvni = hned[1];
  say('událost nese číslo, český nadpis, sadu a pořadí',
    prvni.promotion_id === 'b' && prvni.promotion_name === 'Nadpis b' && prvni.creative_name === 'Podzim'
    && prvni.creative_slot === '2',
    `${prvni.promotion_id} · ${prvni.promotion_name} · ${prvni.creative_name} · místo ${prvni.creative_slot}`);
  say('  a položku, podle které Analytics propagaci sčítá',
    Array.isArray(prvni.items) && prvni.items.length === 1 && prvni.items[0].promotion_id === 'b');

  /* ---------- 2. proklik ---------- */
  await page.waitForFunction(() => document.querySelector('.qbn-page.qbn-now [data-qid="ba"]'), null, { timeout: 8000 })
    .catch(() => undefined);
  await page.locator('.qbn-page.qbn-now [data-qid="bb"]').click();
  const kliky = await udalosti(page, 'select_promotion');
  say('klepnutí na banner je proklik právě toho banneru',
    kliky.length === 1 && kliky[0].promotion_id === 'b' && kliky[0].creative_slot === '2', cisla(kliky));
  await page.close();
}

/* ---------- 3. co proklik není ---------- */
{
  const page = await otevri({
    id: 's', name: 'Video', layout: 'wide', phone: 'wide', rotate: 0,
    banners: [banner('v', { video: `${Z}/v1.webm` })]
  });
  await page.waitForFunction(() => document.querySelector('.qbn video')?.hasAttribute('data-hraje'), null, { timeout: 5000 })
    .catch(() => undefined);
  await page.locator('.qbn .qbn-vbtn').click();
  say('tlačítko pauzy u videa se jako proklik nepočítá', (await udalosti(page, 'select_promotion')).length === 0);
  await page.close();

  /* Dlaždice bez odkazu nikam nevede — klepnutí na ni není proklik */
  const bezOdkazu = await otevri({
    id: 's', name: 'Bez', layout: 'wide', phone: 'wide', rotate: 0,
    banners: [banner('n', {}, { href: { cz: '', sk: '', en: '' } })]
  });
  await bezOdkazu.locator('.qbn .qbn-card').click();
  say('ani klepnutí na banner bez odkazu', (await udalosti(bezOdkazu, 'select_promotion')).length === 0
    && (await udalosti(bezOdkazu, 'view_promotion')).length === 1);
  await bezOdkazu.close();
}

/* ---------- 4. bloky pod bannerem a co je pod okrajem ---------- */
{
  const page = await otevri({
    ...SADA, rotate: 0, banners: SADA.banners.slice(0, 4),
    highlights: { on: true, where: 'all', layout: 'mozaika', phone: 'carousel', banners: [banner('h1'), banner('h2')] }
  }, { vyska: 420 });
  const nahore = await udalosti(page, 'view_promotion');
  say('blok pod okrajem obrazovky viděný není', !nahore.some(one => one.creative_name.includes('bloky')), cisla(nahore));
  await page.evaluate(() => document.querySelector('.qhl').scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(700);
  const dole = (await udalosti(page, 'view_promotion')).filter(one => one.creative_name === 'Podzim / bloky');
  say('  a po dorolování ano — s poznámkou, že je to blok', dole.length === 2, cisla(dole));
  await page.close();
}

/* ---------- 5. posuvník na telefonu: kopie dlaždic ---------- */
{
  const page = await otevri({ ...SADA, phone: 'carousel', loop: true, rotate: 0, banners: SADA.banners.slice(0, 3) },
    { sirka: 390 });
  /* Kopie pro nekonečné otáčení vlastní posluchače nemají — klepnutí se přesto musí počítat */
  await page.evaluate(() => document.querySelector('.qbn-track').children[3].click());
  const kliky = await udalosti(page, 'select_promotion');
  say('klepnutí na kopii dlaždice v posuvníku se počítá původnímu banneru',
    kliky.length === 1 && kliky[0].promotion_id === 'a', cisla(kliky));
  await page.close();
}

/* ---------- 6. kam se hlásí ---------- */
{
  const gtm = await otevri({ ...SADA, rotate: 0, banners: SADA.banners.slice(0, 2) }, { hlava: VRSTVA });
  const vrstva = await gtm.evaluate(() => window.dataLayer.filter(one => one && one.event === 'view_promotion'));
  say('bez gtag jde událost do datové vrstvy (Tag Manager)',
    vrstva.length === 2 && vrstva[0].ecommerce.promotion_id === 'a' && vrstva[0].ecommerce.items.length === 1,
    `${vrstva.length} událostí`);
  await gtm.close();

  const nic = await otevri({ ...SADA, rotate: 0, banners: SADA.banners.slice(0, 2) }, { hlava: '' });
  await nic.locator('.qbn .qbn-card').first().click();
  say('a kde Analytics není, banner běží dál a nic nespadne',
    await nic.evaluate(() => document.querySelectorAll('.qbn .qbn-card').length === 2));
  await nic.close();
}

say('skript při tom nikde nespadl', chybyStranky.length === 0, chybyStranky.slice(0, 2).join(' · '));
await browser.close();
web.zavri();
uklid();
console.log(pocetChyb() ? `\n✗ ${pocetChyb()} chyb` : '\n✓ měření bannerů sedí');
process.exit(pocetChyb() ? 1 : 0);
