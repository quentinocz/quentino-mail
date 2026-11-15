/*
 * Fotka v banneru — zkouška v prohlížeči.
 *
 * ## Co se měří a proč
 *
 * Fotka banneru byla pozadí ve stylu. To má dvě vady, které nejsou
 * vidět: Google obrázky ze stylů neindexuje (fotky z bannerů tak ve
 * vyhledávání obrázků nebyly a neměly popis) a prohlížeč se o pozadí
 * dozví pozdě, přestože je to největší věc na úvodní stránce a podle ní
 * Google měří rychlost načtení. Teď je fotka skutečný obrázek s popisem,
 * první má přednost a telefon dostane menší soubor.
 *
 * Nic z toho se nepozná čtením skriptu. Jestli si telefon opravdu
 * stáhne menší soubor, rozhoduje prohlížeč podle šířky dlaždice a
 * hustoty displeje — a pozná se to jen na serveru, podle toho, o co si
 * prohlížeč řekl. Proto si tu server počítá požadavky.
 *
 *   npm run typecheck   (přeloží hlavní proces do dist/ptdist)
 *   node tools/preview-banner-foto.mjs
 */
import { banner, pocetChyb, prohlizec, say, server, stranka, uklid, vyrob } from './banner-web.mjs';

const VELKA = vyrob('velka.png', ['-f', 'lavfi', '-i', 'testsrc2=size=1800x1200', '-frames:v', '1']);
const MALA = vyrob('mala.png', ['-f', 'lavfi', '-i', 'testsrc2=size=900x600', '-frames:v', '1']);
const web = await server({
  '*velka.png': { typ: 'image/png', data: VELKA },
  '*mala.png': { typ: 'image/png', data: MALA }
});
const Z = web.zaklad;
const browser = await prohlizec('zkouška fotky v banneru');
const chybyStranky = [];

/** Fotka banneru, jak ji uloží aplikace po nahrání: velká, menší a jejich šířky. */
const foto = (n, extra = {}) => ({
  image: `${Z}/f${n}-velka.png`, imageW: 1800,
  imageSmall: `${Z}/f${n}-mala.png`, imageSmallW: 900,
  ...extra
});
const text = cz => ({ cz, sk: '', en: '' });

/*
 * Pravidla, jaká mívá šablona e-shopu na obrázky. S nimi se fotka
 * v dlaždici musí vyrovnat — jinak by se nevyplnila a pod ní by
 * prosvítala barva pozadí.
 */
const SABLONA = '<style>img{max-width:100%;height:auto}.section img{width:auto;height:auto;border:2px solid red}</style>';

async function otevri(sada, { sirka = 1240, hustota = 1, cesta = '/', jazyk = 'cz' } = {}) {
  web.nastav(stranka(sada, { hlava: SABLONA, jazyk }));
  web.pozadavky.clear();
  const page = await browser.newPage({ viewport: { width: sirka, height: 900 }, deviceScaleFactor: hustota });
  page.on('pageerror', e => chybyStranky.push(String(e?.message ?? e)));
  await page.goto(`${Z}${cesta}`);
  await page.waitForFunction(() => !!document.querySelector('.qbn .qbn-card'), null, { timeout: 5000 })
    .catch(() => undefined);
  /* Fotky se dotáhnou; čeká se na ně, ne na hodiny */
  await page.waitForFunction(() => [...document.querySelectorAll('.qbn img.qbn-img')]
    .filter(one => one.loading !== 'lazy').every(one => one.complete), null, { timeout: 5000 })
    .catch(() => undefined);
  await page.waitForTimeout(300);
  return page;
}
const stazeno = jmeno => web.pozadavky.get(jmeno) ?? 0;

console.log('\nfotka v banneru — v prohlížeči:\n');

/* ---------- 1. skutečný obrázek s popisem ---------- */
{
  const page = await otevri({
    id: 's', name: 's', layout: 'wide', phone: 'wide', rotate: 0,
    banners: [banner('a', foto(1, { focus: '0% 100%' }), { alt: text('Muž v modrém obleku s vínovými kšandami') })]
  });
  const stav = await page.evaluate(() => {
    const karta = document.querySelector('.qbn .qbn-card');
    const img = karta.querySelector('img.qbn-img');
    const a = karta.getBoundingClientRect();
    const b = img ? img.getBoundingClientRect() : null;
    const styl = img ? getComputedStyle(img) : null;
    return {
      je: !!img, alt: img?.alt ?? '',
      vyplni: !!b && Math.abs(a.width - b.width) < 1.5 && Math.abs(a.height - b.height) < 1.5
        && Math.abs(a.left - b.left) < 1.5 && Math.abs(a.top - b.top) < 1.5,
      rozmery: b ? `${Math.round(b.width)}×${Math.round(b.height)} v dlaždici ${Math.round(a.width)}×${Math.round(a.height)}` : '',
      orez: styl?.objectFit ?? '', vyrez: styl?.objectPosition ?? '', ramecek: styl?.borderTopWidth ?? '',
      nacteno: !!img && img.complete && img.naturalWidth > 0,
      pozadi: getComputedStyle(karta.querySelector('.qbn-photo')).backgroundImage
    };
  });
  say('fotka banneru je skutečný obrázek, ne pozadí ve stylu', stav.je && stav.nacteno && stav.pozadi === 'none',
    stav.je ? 'img' : 'obrázek chybí');
  say('  má popis, který přečte Google i čtečka', stav.alt === 'Muž v modrém obleku s vínovými kšandami', stav.alt);
  say('  vyplní celou dlaždici, i když má šablona na obrázky vlastní pravidla',
    stav.vyplni && stav.orez === 'cover' && stav.ramecek === '0px', stav.rozmery);
  say('  a výřez se drží nastaveného místa', stav.vyrez === '0% 100%', stav.vyrez);
  await page.screenshot({ path: new URL('./shots/banner-foto-siroky.png', import.meta.url).pathname });

  /* Přednačtení z hlavičky — a že se fotka kvůli němu nestáhne dvakrát */
  const hlava = await page.evaluate(() => {
    const link = document.querySelector('link[rel="preload"][as="image"]');
    return link ? {
      sada: link.getAttribute('imagesrcset') ?? '', sirky: link.getAttribute('imagesizes') ?? '',
      prednost: link.getAttribute('fetchpriority') ?? ''
    } : null;
  });
  say('první fotka se začne stahovat už z hlavičky', !!hlava && hlava.prednost === 'high' && hlava.sada.includes('1800w'),
    hlava ? hlava.sirky : 'odkaz na přednačtení chybí');
  say('  a nestáhne se kvůli tomu dvakrát', stazeno('/f1-velka.png') === 1,
    `velká ${stazeno('/f1-velka.png')}×, menší ${stazeno('/f1-mala.png')}×`);
  say('široký banner na monitoru si vezme velkou fotku', stazeno('/f1-velka.png') === 1 && stazeno('/f1-mala.png') === 0);
  await page.close();
}

/* ---------- 2. telefon dostane menší soubor ---------- */
{
  const sada = {
    id: 's', name: 's', layout: 'quad', phone: 'grid', rotate: 0,
    banners: [banner('a', foto(1)), banner('b', foto(2)), banner('c', foto(3)), banner('d', foto(4))]
  };
  const page = await otevri(sada, { sirka: 390, hustota: 3 });
  const velkych = [1, 2, 3, 4].reduce((a, n) => a + stazeno(`/f${n}-velka.png`), 0);
  const malych = [1, 2, 3, 4].reduce((a, n) => a + stazeno(`/f${n}-mala.png`), 0);
  say('telefon si stáhne menší podobu fotek, velkou ani jednu', malych === 4 && velkych === 0,
    `menších ${malych}, velkých ${velkych} · ${Math.round(MALA.length / 1024)} kB místo ${Math.round(VELKA.length / 1024)} kB na fotku`);
  await page.screenshot({ path: new URL('./shots/banner-foto-telefon.png', import.meta.url).pathname });
  await page.close();

  /* Čtvrtinová dlaždice na počítači velkou fotku taky nepotřebuje */
  const pocitac = await otevri(sada, { sirka: 1240, hustota: 1 });
  const velkychPc = [1, 2, 3, 4].reduce((a, n) => a + stazeno(`/f${n}-velka.png`), 0);
  say('  a dlaždice ve čtveřici na počítači taky', velkychPc === 0,
    `velkých ${velkychPc} ze 4`);
  await pocitac.close();

  /*
   * A obráceně: fotka nahraná dřív menší podobu nemá. Telefon pak
   * stáhne velkou — což je přesně to, jak to fungovalo doteď. Bez téhle
   * zkoušky by „telefon dostane menší" mohlo projít, i kdyby prohlížeč
   * z nějakého důvodu bral menší fotku vždycky.
   */
  const stara = await otevri({
    id: 's', name: 's', layout: 'quad', phone: 'grid', rotate: 0,
    banners: [banner('a', { image: `${Z}/f1-velka.png` })]
  }, { sirka: 390, hustota: 3 });
  const bezSady = await stara.evaluate(() => document.querySelector('.qbn img.qbn-img').srcset === '');
  say('  (fotka bez menší podoby se na telefonu stáhne celá — tak to bylo doteď)',
    stazeno('/f1-velka.png') === 1 && bezSady);
  await stara.close();
}

/* ---------- 3. kdo má přednost ---------- */
{
  const page = await otevri({
    id: 's', name: 's', layout: 'quad', phone: 'grid', rotate: 6,
    banners: ['a', 'b', 'c', 'd', 'e'].map((id, i) => banner(id, foto(i + 1))),
    highlights: {
      on: true, where: 'all', layout: 'mozaika', phone: 'carousel',
      banners: [banner('h1', foto(8)), banner('h2', foto(9))]
    }
  });
  const prednosti = await page.evaluate(() => ({
    banner: [...document.querySelectorAll('.qbn img.qbn-img')].map(one => one.getAttribute('fetchpriority')),
    bloky: [...document.querySelectorAll('.qhl img.qbn-img')].map(one => `${one.getAttribute('fetchpriority')}/${one.loading}`)
  }));
  say('přednost má první dlaždice; stránka rotace, která není vidět, počká',
    prednosti.banner.join(' ') === 'high auto auto auto low', prednosti.banner.join(' · '));
  say('  a bloky pod bannerem se stahují, až na ně přijde řada',
    prednosti.bloky.length === 2 && prednosti.bloky.every(one => one === 'low/lazy'), prednosti.bloky.join(' · '));
  await page.close();
}

/* ---------- 4. popis v jazyce trhu, a když chybí ---------- */
{
  const sada = {
    id: 's', name: 's', layout: 'wide', phone: 'wide', rotate: 0,
    banners: [banner('a', foto(1), {
      title: { cz: 'Kšandy k obleku', sk: 'Traky k obleku', en: '' },
      alt: { cz: 'Muž s kšandami', sk: 'Muž s trakmi', en: '' }
    })]
  };
  const sk = await otevri(sada, { jazyk: 'sk' });
  const altSk = await sk.evaluate(() => document.querySelector('.qbn img.qbn-img').alt);
  say('popis fotky je v jazyce trhu', altSk === 'Muž s trakmi', altSk);
  await sk.close();

  const bez = await otevri({
    ...sada, banners: [banner('a', foto(1), { title: text('Kšandy k obleku') })]
  });
  const altBez = await bez.evaluate(() => document.querySelector('.qbn img.qbn-img').alt);
  say('  a když ho nikdo nenapsal, poslouží nadpis', altBez === 'Kšandy k obleku', altBez);
  await bez.close();
}

/* ---------- 5. kde se nepřednačítá a kde obrázek není ---------- */
{
  const sada = {
    id: 's', name: 's', layout: 'wide', phone: 'wide', rotate: 0,
    banners: [banner('a', foto(1))]
  };
  /*
   * Skript je v hlavičce každé stránky, ale banner jen na té úvodní.
   * Na kategorii by přednačtení stáhlo fotku, kterou nikdo neuvidí.
   */
  web.nastav(stranka(sada).replace(/<div class="section bic-bnr">.*?<\/div><\/div><\/div>/, ''));
  web.pozadavky.clear();
  const kategorie = await browser.newPage({ viewport: { width: 1240, height: 900 } });
  await kategorie.goto(`${Z}/kravaty`);
  await kategorie.waitForTimeout(900);
  const odkazu = await kategorie.evaluate(() => document.querySelectorAll('link[rel="preload"][as="image"]').length);
  say('mimo úvodní stránku se fotka banneru nestahuje vůbec',
    odkazu === 0 && stazeno('/f1-velka.png') + stazeno('/f1-mala.png') === 0,
    `${odkazu} přednačtení, ${stazeno('/f1-velka.png') + stazeno('/f1-mala.png')} stažení`);
  await kategorie.close();

  const bezFotky = await otevri({
    id: 's', name: 's', layout: 'wide', phone: 'wide', rotate: 0,
    banners: [banner('a', {}, { title: text('Jen barva a nadpis') })]
  });
  const obrazku = await bezFotky.evaluate(() => document.querySelectorAll('.qbn img').length);
  say('banner bez fotky žádný obrázek nemá — ani rozbitou ikonku', obrazku === 0, `${obrazku} obrázků`);
  await bezFotky.close();
}

say('skript při tom nikde nespadl', chybyStranky.length === 0, chybyStranky.slice(0, 2).join(' · '));

await browser.close();
web.zavri();
uklid();
console.log(pocetChyb() ? `\n✗ ${pocetChyb()} chyb` : '\n✓ fotka v banneru sedí');
process.exit(pocetChyb() ? 1 : 0);
