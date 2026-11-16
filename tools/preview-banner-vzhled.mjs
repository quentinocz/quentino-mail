/*
 * Vzhled a chování banneru — zkouška v prohlížeči.
 *
 * Štítek v rohu, vlastní výřez na telefonu, termín jednotlivého banneru
 * a rotace, která se najetím myší zastaví. U všech čtyř rozhoduje
 * prohlížeč — šířka okna, hodiny návštěvníka, kde zrovna stojí myš —
 * takže se měří v něm.
 *
 *   node tools/preview-banner-vzhled.mjs
 */
import { banner, pocetChyb, prohlizec, say, server, stranka, uklid, vyrob } from './banner-web.mjs';

const FOTKA = vyrob('fotka.png', ['-f', 'lavfi', '-i', 'testsrc2=size=1200x800', '-frames:v', '1']);
const web = await server({ '*.png': { typ: 'image/png', data: FOTKA } });
const Z = web.zaklad;
const browser = await prohlizec('zkouška vzhledu banneru');
const chybyStranky = [];
const text = cz => ({ cz, sk: '', en: '' });

async function otevri(sada, { sirka = 1240, jazyk = 'cz', hodiny = 0 } = {}) {
  web.nastav(stranka(sada, { jazyk }));
  const page = await browser.newPage({ viewport: { width: sirka, height: 900 } });
  page.on('pageerror', e => chybyStranky.push(String(e?.message ?? e)));
  /* Hodiny se musí podvrhnout dřív, než si skript na stránce nařídí minutové hlídání */
  if (hodiny) await page.clock.install({ time: new Date(hodiny) });
  await page.goto(`${Z}/`);
  await page.waitForFunction(() => !!document.querySelector('.qbn .qbn-card'), null, { timeout: 5000 })
    .catch(() => undefined);
  await page.waitForTimeout(500);
  return page;
}
const SIROKY = (banners, extra = {}) => ({ id: 's', name: 's', layout: 'wide', phone: 'wide', rotate: 0, banners, ...extra });

console.log('\nvzhled a chování banneru — v prohlížeči:\n');

/* ---------- štítek ---------- */
{
  const page = await otevri({
    id: 's', name: 's', layout: 'quad', phone: 'grid', rotate: 0,
    banners: [
      banner('a', { image: `${Z}/a.png`, bg: '#102030', fg: '#ffffff' }, { badge: { cz: '−20 %', sk: '−20 % sk', en: '' } }),
      banner('b', { image: `${Z}/b.png` })
    ]
  });
  const stav = await page.evaluate(() => {
    const karty = [...document.querySelectorAll('.qbn .qbn-card')];
    const stitek = karty[0].querySelector('.qbn-badge');
    const styl = stitek ? getComputedStyle(stitek) : null;
    const a = karty[0].getBoundingClientRect();
    const b = stitek ? stitek.getBoundingClientRect() : null;
    return {
      text: stitek?.textContent ?? '', pozadi: styl?.backgroundColor ?? '', barva: styl?.color ?? '',
      vRohu: !!b && b.left - a.left < 20 && b.top - a.top < 20,
      druhy: !!karty[1].querySelector('.qbn-badge')
    };
  });
  say('štítek je v rohu dlaždice', stav.text === '−20 %' && stav.vRohu, stav.text);
  say('  v barvách obrácených proti dlaždici, ať je vidět na každé fotce',
    stav.pozadi === 'rgb(255, 255, 255)' && stav.barva === 'rgb(16, 32, 48)', `${stav.pozadi} / ${stav.barva}`);
  say('  a banner bez štítku žádný nemá', !stav.druhy);
  await page.screenshot({ path: new URL('./shots/banner-stitek.png', import.meta.url).pathname });
  await page.close();
}

/* ---------- výřez na telefonu ---------- */
{
  const sada = SIROKY([
    banner('a', { image: `${Z}/a.png`, focus: '0% 50%', focusPhone: '100% 0%' }),
    banner('b', { image: `${Z}/b.png`, focus: '0% 50%' })
  ], { layout: 'quad', phone: 'grid' });
  const vyrezy = async sirka => {
    const page = await otevri(sada, { sirka });
    const out = await page.evaluate(() => [...document.querySelectorAll('.qbn img.qbn-img')]
      .map(one => getComputedStyle(one).objectPosition));
    await page.close();
    return out;
  };
  const pc = await vyrezy(1240);
  const telefon = await vyrezy(390);
  say('na telefonu má fotka vlastní výřez', telefon[0] === '100% 0%' && pc[0] === '0% 50%',
    `počítač ${pc[0]}, telefon ${telefon[0]}`);
  say('  a kde vlastní není, platí ten z počítače', telefon[1] === '0% 50%', telefon[1]);
}

/* ---------- ztmavení ---------- */
{
  const page = await otevri(SIROKY([
    /* Vlastní vzhled: jinak polohu textu určuje sada a oba by měly stejnou */
    banner('a', { image: `${Z}/a.png`, pos: 'middle', overlay: 50 }, {}, { ownLook: true }),
    banner('b', { image: `${Z}/b.png`, pos: 'bottom', overlay: 50 }, {}, { ownLook: true })
  ], { layout: 'quad' }));
  const tma = await page.evaluate(() => [...document.querySelectorAll('.qbn .qbn-shade')]
    .map(one => getComputedStyle(one).backgroundImage.slice(0, 16)));
  say('pod textem uprostřed je tma do ztracena, ne plocha přes celou fotku',
    tma[0].startsWith('radial-gradient') && tma[1].startsWith('linear-gradient'), tma.join(' · '));
  await page.screenshot({ path: new URL('./shots/banner-ztmaveni.png', import.meta.url).pathname });
  await page.close();
}

/* ---------- termín jednotlivého banneru ---------- */
{
  const ted = Date.now();
  const cas = ms => {
    /* Okno zadává český místní čas; plán pak nese čísla. Tady rovnou čísla přes text v ISO bez pásma. */
    const d = new Date(ms);
    const cz = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Prague', dateStyle: 'short', timeStyle: 'short' }).format(d);
    return cz.replace(' ', 'T');
  };
  const sada = SIROKY([
    banner('porad'),
    banner('pozdeji', {}, {}, { from: cas(ted + 3600_000) }),
    banner('skoncil', {}, {}, { to: cas(ted - 3600_000) }),
    banner('ted', {}, {}, { from: cas(ted - 3600_000), to: cas(ted + 3600_000) })
  ], { layout: 'quad' });
  const videt = page => page.evaluate(() => [...document.querySelectorAll('.qbn .qbn-card')].map(one => one.getAttribute('data-qid')));
  let page = await otevri(sada);
  const hned = await videt(page);
  say('banner se kreslí jen ve svém termínu', hned.join(' ') === 'bporad bted', hned.join(' · '));
  await page.close();

  /*
   * A bez znovunačtení: komu běží stránka přes začátek termínu, tomu
   * se banner objeví. Jeden tu začíná a druhý končí — platných je
   * pořád stejně, takže hlídat jen jejich počet by nestačilo.
   */
  page = await otevri(sada, { hodiny: ted });
  const pred = await videt(page);
  await page.clock.fastForward(3700_000);
  await page.clock.runFor(1000);
  const potom = await videt(page);
  say('  a když jednomu termín začne a druhému skončí, blok se překreslí sám',
    pred.join(' ') === 'bporad bted' && potom.join(' ') === 'bporad bpozdeji', `${pred.join(' · ')} → ${potom.join(' · ')}`);
  await page.close();
}

/* ---------- rotace: ukazatel a zastavení myší ---------- */
{
  const page = await otevri(SIROKY([banner('a'), banner('b')], { rotate: 2 }));
  const navrchu = () => page.evaluate(() => document.querySelector('.qbn-page.qbn-now [data-qid]')?.getAttribute('data-qid'));
  say('rotace má ukazatel, kdy se otočí', await page.evaluate(() => !!document.querySelector('.qbn .qbn-prog')));
  const prvni = await navrchu();
  await page.waitForTimeout(2400);
  const druhy = await navrchu();
  say('  a bez myši se stránka otočí', prvni !== druhy, `${prvni} → ${druhy}`);
  await page.hover('.qbn .qbn-page.qbn-now .qbn-card');
  await page.waitForTimeout(5000);
  const drzi = await navrchu();
  say('pod myší rotace stojí — banner pod rukou nezmizí', drzi === druhy, `po pěti vteřinách pořád ${drzi}`);
  await page.mouse.move(600, 880);
  await page.waitForTimeout(2600);
  say('  a když myš odjede, točí se dál', (await navrchu()) !== drzi);
  await page.close();
}

say('skript při tom nikde nespadl', chybyStranky.length === 0, chybyStranky.slice(0, 2).join(' · '));
await browser.close();
web.zavri();
uklid();
console.log(pocetChyb() ? `\n✗ ${pocetChyb()} chyb` : '\n✓ vzhled a chování banneru sedí');
process.exit(pocetChyb() ? 1 : 0);
