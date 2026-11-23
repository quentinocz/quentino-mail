/**
 * Zkušební kabina — zkouška toho, co se okem nepozná.
 *
 * Na obrazovce se pozná, že model stojí v obleku. Co se nepozná:
 *
 *  1. **čtení PNG** — vlastní, bez knihovny. Zkouší se proti souborům
 *     zapsaným jiným nástrojem, včetně souboru, kde má každý řádek jiný
 *     filtr. Jedna špatná větev a obrázek se rozjede o půl bodu, což se
 *     na vrstvě pozná jako duch kolem rukávu,
 *  2. **maska z rozdílu dvou kroků** — jestli z „postava" a „postava
 *     v saku" vyjde opravdu sako a nic jiného,
 *  3. **mapa světla** — jestli polotón po přebarvení vydá **přesně** tu
 *     barvu, kterou si zákazník vybral. Tohle je celé jádro kabiny: kdyby
 *     se mapa posunula, byl by každý oblek tmavší, než jaký si vybral,
 *     a nikdo by nepoznal proč,
 *  4. **skládání vrstev** — jestli počítá stejně jako prohlížeč,
 *  5. **barva produktu z fotky** — jestli se z fotky pozná barva látky
 *     a ne barva pozadí.
 */
const fs = require('fs');
const path = require('path');
const { DIST, db } = require('./ptrans/harness.cjs');

const png = require(path.join(DIST, 'zkusebna/png.js'));
const px = require(path.join(DIST, 'zkusebna/pixely.js'));
const zk = require(path.join(DIST, '../shared/zkusebna.js'));

let failed = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${label}`);
  if (!ok) {
    console.log('      čekáno:', JSON.stringify(want));
    console.log('      dostal:', JSON.stringify(got));
  }
}
function ok(label, condition, note = '') {
  if (!condition) failed++;
  console.log(`  ${condition ? '✓' : '✗'} ${label}${note ? `   ${note}` : ''}`);
}

const FIX = path.join(__dirname, 'fixtures');

console.log('\nzkušební kabina:\n');

/* ---------- 1. čtení a zápis PNG ---------- */

console.log('PNG');
for (const jmeno of ['rgba', 'rgb', 'la', 'pal', 'filtry']) {
  const obraz = png.nacti(fs.readFileSync(path.join(FIX, `zkusebna-${jmeno}.png`)));
  const cekane = fs.readFileSync(path.join(FIX, `zkusebna-${jmeno}.raw`));
  const stejne = obraz.body.length === cekane.length
    && Buffer.compare(Buffer.from(obraz.body), cekane) === 0;
  let kde = '';
  if (!stejne) {
    for (let i = 0; i < Math.min(obraz.body.length, cekane.length); i++) {
      if (obraz.body[i] !== cekane[i]) { kde = `první rozdíl na bajtu ${i}: ${obraz.body[i]} ≠ ${cekane[i]}`; break; }
    }
  }
  ok(`${jmeno} se přečte bod po bodu stejně jako originál`, stejne,
    `${obraz.sirka}×${obraz.vyska}${kde ? ` — ${kde}` : ''}`);
}

{
  /* Zápis a čtení musí dát tytéž body — tudy chodí všechny vrstvy */
  const puvod = png.novyObraz(37, 23);
  for (let i = 0; i < 37 * 23; i++) {
    puvod.body[i * 4] = (i * 7) % 256;
    puvod.body[i * 4 + 1] = (i * 13) % 256;
    puvod.body[i * 4 + 2] = (i * 29) % 256;
    puvod.body[i * 4 + 3] = (i * 3) % 256;
  }
  const zpet = png.nacti(png.uloz(puvod));
  ok('zapsané PNG se přečte beze změny',
    zpet.sirka === 37 && zpet.vyska === 23
    && Buffer.compare(Buffer.from(zpet.body), Buffer.from(puvod.body)) === 0);
  /*
   * Lichá šířka je schválně: řádek pak nekončí na hezkém čísle a chyba
   * v odsazení filtru by se projevila právě tam.
   */
  const velikost = png.uloz(puvod).length;
  ok('a nezabírá víc než surové body', velikost < 37 * 23 * 4, `${velikost} B`);
}

{
  let potiz = '';
  try { png.nacti(Buffer.from('nic')); } catch (e) { potiz = e.message; }
  ok('co není PNG, se odmítne nahlas', /PNG/.test(potiz), potiz);
}

/* ---------- 2. maska z rozdílu dvou kroků ---------- */

console.log('\nvrstva z rozdílu');

/** Postava: svislý pruh doprostřed plátna, zbytek průhledný. */
function postava(sirka, vyska) {
  const obraz = png.novyObraz(sirka, vyska);
  for (let y = 0; y < vyska; y++) {
    for (let x = 0; x < sirka; x++) {
      const i = (y * sirka + x) * 4;
      const uvnitr = x > sirka * 0.3 && x < sirka * 0.7 && y > vyska * 0.08;
      if (!uvnitr) continue;
      obraz.body[i] = 206; obraz.body[i + 1] = 170; obraz.body[i + 2] = 140;
      obraz.body[i + 3] = 255;
    }
  }
  return obraz;
}

/** Tentýž obrázek, ale s „sakem": obdélník na trupu, se záhyby. */
function sePřidaným(zaklad, obdelnik, barva) {
  const out = { sirka: zaklad.sirka, vyska: zaklad.vyska, body: Uint8Array.from(zaklad.body) };
  for (let y = obdelnik.y; y < obdelnik.y + obdelnik.h; y++) {
    for (let x = obdelnik.x; x < obdelnik.x + obdelnik.w; x++) {
      const i = (y * out.sirka + x) * 4;
      if (out.body[i + 3] < 128) continue;
      /*
       * Záhyby i odlesk. Látka bez odlesku je zrádná: mapa světla by nad
       * polotón nikdy nevystoupila a zkouška „záhyby zůstaly" by měřila
       * jen to, že se něco ztmavilo.
       */
      const stin = x % 7 < 2 ? 0.45 : x % 7 === 3 ? 1.7 : 1;
      out.body[i] = Math.min(255, Math.round(barva[0] * stin));
      out.body[i + 1] = Math.min(255, Math.round(barva[1] * stin));
      out.body[i + 2] = Math.min(255, Math.round(barva[2] * stin));
      out.body[i + 3] = 255;
    }
  }
  return out;
}

const SIRKA = 120;
const VYSKA = 180;
const pred = postava(SIRKA, VYSKA);
const sako = { x: 40, y: 40, w: 40, h: 70 };
const po = sePřidaným(pred, sako, [60, 70, 110]);

{
  const posun = px.zarovnej(pred, po, { x: 0, y: 0, w: SIRKA, h: 24 }, 4);
  check('beze posunu se nic nehledá', [posun.dx, posun.dy], [0, 0]);

  /* Model obrázek posune — zarovnání to musí najít, jinak je maska duch */
  const posunuty = png.novyObraz(SIRKA, VYSKA);
  for (let y = 0; y < VYSKA; y++) {
    for (let x = 0; x < SIRKA; x++) {
      const zx = x - 3;
      const zy = y + 2;
      if (zx < 0 || zy < 0 || zx >= SIRKA || zy >= VYSKA) continue;
      for (let k = 0; k < 4; k++) posunuty.body[(y * SIRKA + x) * 4 + k] = po.body[(zy * SIRKA + zx) * 4 + k];
    }
  }
  const nalez = px.zarovnej(pred, posunuty, { x: 0, y: 0, w: SIRKA, h: 30 }, 5);
  check('posunutý krok se zarovná podle hlavy', [nalez.dx, nalez.dy], [3, -2]);
  /* Dva body nahoru po třech bodech vzorkování nepoznat nejdou — tohle
     projde jen díky druhému, jemnému průchodu */

  /*
   * A opačně: na kotvě, kde není co poznat, se **neposouvá**. Jednolité
   * tričko nebo klidné pozadí sedí při každém posunu stejně dobře a
   * dřív vyhrál ten, na který se narazilo první — kraj rozsahu. Na
   * postavě to znamenalo posun o šest bodů při nulové chybě, celý
   * obrázek se tím odnesl stranou a z rozdílu dvou kroků byl obrys
   * postavy místo kusu látky.
   */
  const jednolita = { x: 40, y: 60, w: 40, h: 40 };
  const klid = px.zarovnej(pred, pred, jednolita, 6);
  check('na kotvě bez kresby se neposouvá', [klid.dx, klid.dy], [0, 0]);
}

{
  const maska = px.uklid(px.rozdil(pred, po), SIRKA, VYSKA);
  const kde = px.okraje(maska, SIRKA, VYSKA);
  /*
   * Maska musí sednout na obdélník, který se přidal. Pár bodů tolerance
   * je kvůli zjemnění okraje — tvrdý okraj by na postavě vypadal jako
   * vystřižený z papíru.
   */
  ok('maska sedne na to, co přibylo',
    Math.abs(kde.x - sako.x) <= 2 && Math.abs(kde.y - sako.y) <= 2
    && Math.abs(kde.w - sako.w) <= 3 && Math.abs(kde.h - sako.h) <= 3,
    `${kde.x},${kde.y} ${kde.w}×${kde.h} místo ${sako.x},${sako.y} ${sako.w}×${sako.h}`);

  /* Smítka kolem — model posunul stín u ucha. Do vrstvy nesmí. */
  const seSmitky = { sirka: SIRKA, vyska: VYSKA, body: Uint8Array.from(po.body) };
  for (const [sx, sy] of [[50, 10], [51, 10], [92, 150], [20, 60]]) {
    const i = (sy * SIRKA + sx) * 4;
    seSmitky.body[i] = 10; seSmitky.body[i + 1] = 240; seSmitky.body[i + 2] = 10; seSmitky.body[i + 3] = 255;
  }
  const bezSmitek = px.uklid(px.rozdil(pred, seSmitky), SIRKA, VYSKA);
  const kdeBez = px.okraje(bezSmitek, SIRKA, VYSKA);
  ok('a smítka mimo kus látky se zahodí',
    Math.abs(kdeBez.y - sako.y) <= 2 && kdeBez.h <= sako.h + 3,
    `${kdeBez.x},${kdeBez.y} ${kdeBez.w}×${kdeBez.h}`);
}

/* ---------- 3. mapa světla a přesná barva ---------- */

console.log('\nmapa světla');

{
  const maska = px.uklid(px.rozdil(pred, po), SIRKA, VYSKA);
  const mapa = px.stinovaMapa(po, maska);

  /* Prostřední hodnota musí sednout na 128 — jen tak vydá hard-light přesnou barvu */
  const hodnoty = [];
  for (let i = 0; i < maska.length; i++) {
    if (maska[i] < 250) continue;
    hodnoty.push(mapa.body[i * 4]);
  }
  hodnoty.sort((a, b) => a - b);
  const stred = hodnoty[Math.floor(hodnoty.length / 2)];
  ok('prostřední hodnota mapy je polotón', Math.abs(stred - 128) <= 1, `${stred}`);

  /* Záhyby musí zůstat: mapa nesmí být jednolitá */
  const min = hodnoty[0];
  const max = hodnoty[hodnoty.length - 1];
  ok('a záhyby v ní zůstaly', max - min > 40, `${min}–${max}`);

  /*
   * A teď to hlavní: polotón přebarvený na zvolenou barvu **je** ta barva.
   * Neutrální bod režimu leží na 127,5, takže se barva pod mapu předem
   * o ten stupeň posune — jinak by každý oblek vyšel o jedničku světlejší.
   */
  const pod = zk.barvaPodMapu('#1f2d4d');
  check('polotón vydá přesně zvolenou barvu', [
    zk.hardLight(pod.r, 128), zk.hardLight(pod.g, 128), zk.hardLight(pod.b, 128)
  ], [0x1f, 0x2d, 0x4d]);
  const bila = zk.barvaPodMapu('#f6f6f4');
  check('a bílá košile vyjde bílá na jedničku',
    [zk.hardLight(bila.r, 128), zk.hardLight(bila.b, 128)], [0xf6, 0xf4]);
  ok('tmavší místo ztmaví', zk.hardLight(120, 90) < 120, `${zk.hardLight(120, 90)}`);
  ok('a světlejší vytáhne k bílé', zk.hardLight(120, 200) > 120, `${zk.hardLight(120, 200)}`);
  /* Bílá látka musí jít: kdyby se násobilo, zůstala by vždycky šedá */
  ok('bílá košile je opravdu bílá', zk.hardLight(246, 128) >= 245, `${zk.hardLight(246, 128)}`);
}

/* ---------- 4. skládání vrstev ---------- */

console.log('\nskládání');

{
  const platno = { sirka: 4, vyska: 1 };
  const spodni = png.novyObraz(4, 1);
  for (let x = 0; x < 4; x++) {
    const i = x * 4;
    spodni.body[i] = 200; spodni.body[i + 1] = 200; spodni.body[i + 2] = 200; spodni.body[i + 3] = 255;
  }
  /* Vrstva k barvení: polotón, poloviční průhlednost na posledním bodu */
  const vrchni = png.novyObraz(4, 1);
  for (let x = 0; x < 4; x++) {
    const i = x * 4;
    vrchni.body[i] = vrchni.body[i + 1] = vrchni.body[i + 2] = 128;
    vrchni.body[i + 3] = x === 3 ? 128 : 255;
  }
  const slozeno = px.slozeni([{ obraz: spodni }, { obraz: vrchni, hex: '#1f2d4d' }], platno.sirka, platno.vyska);
  check('barvená vrstva vydá na plátně zvolenou barvu',
    [slozeno.body[0], slozeno.body[1], slozeno.body[2]], [0x1f, 0x2d, 0x4d]);
  const i3 = 3 * 4;
  ok('a poloprůhledný okraj se s podkladem smíchá',
    slozeno.body[i3] > 0x1f && slozeno.body[i3] < 200,
    `${slozeno.body[i3]},${slozeno.body[i3 + 1]},${slozeno.body[i3 + 2]}`);
  check('nebarvená vrstva zůstane, jak je',
    [slozeno.body[3]], [255]);
}

/* ---------- 5. barva produktu z fotky ---------- */

console.log('\nbarva z fotky');

{
  /* Fotka: bílé pozadí, uprostřed námořnické sako se světlou košilí */
  const foto = png.novyObraz(80, 100);
  for (let y = 0; y < 100; y++) {
    for (let x = 0; x < 80; x++) {
      const i = (y * 80 + x) * 4;
      let barva = [250, 250, 248];
      if (x > 20 && x < 60 && y > 20 && y < 90) barva = [31, 45, 77];
      if (x > 36 && x < 44 && y > 24 && y < 70) barva = [245, 245, 240];
      foto.body[i] = barva[0]; foto.body[i + 1] = barva[1]; foto.body[i + 2] = barva[2];
      foto.body[i + 3] = 255;
    }
  }
  const nalez = px.barvaProduktu(foto);
  const rgb = zk.hexNaRgb(nalez.hex);
  ok('z fotky vyjde barva látky, ne pozadí',
    rgb && Math.abs(rgb.r - 31) < 12 && Math.abs(rgb.g - 45) < 12 && Math.abs(rgb.b - 77) < 12,
    `${nalez.hex} (${Math.round(nalez.podil * 100)} % plochy)`);

  /*
   * Pozadí se doplňuje od kraje, ne podle bílé — jinak by u bílé košile
   * umazalo košili. Zkouší se to na obou stranách: v rohu pozadí být
   * musí, uprostřed saka nesmí, a dohromady musí zbyt přesně sako.
   */
  const pozadi = px.pozadiOdKraje(foto);
  let pozadiBodu = 0;
  for (let i = 0; i < pozadi.length; i++) if (pozadi[i]) pozadiBodu += 1;
  const bodVeSaku = pozadi[55 * 80 + 25];
  const bodVRohu = pozadi[0];
  const sakoBodu = 39 * 69;
  ok('pozadí se pozná od kraje, ne podle bílé',
    pozadiBodu === 80 * 100 - sakoBodu && !bodVeSaku && !!bodVRohu,
    `${pozadiBodu} bodů, v saku ${bodVeSaku}, v rohu ${bodVRohu}`);
}

/* ---------- 5b. vzorek látky z fotky ---------- */

{
  /*
   * Motýlek s kostkou není jedna barva. Z fotky se proto vystřihne kousek
   * látky, který se na modelu vydláždí — a musí to být kousek **z
   * produktu**, ne z pozadí a ne z hrany, kde je stín.
   */
  const foto = png.novyObraz(120, 120);
  for (let y = 0; y < 120; y++) {
    for (let x = 0; x < 120; x++) {
      const i = (y * 120 + x) * 4;
      let barva = [250, 250, 248];
      if (x > 30 && x < 90 && y > 30 && y < 90) {
        barva = ((x >> 3) + (y >> 3)) % 2 ? [40, 70, 120] : [230, 230, 225];
      }
      foto.body[i] = barva[0]; foto.body[i + 1] = barva[1];
      foto.body[i + 2] = barva[2]; foto.body[i + 3] = 255;
    }
  }
  const kousek = px.vzorekLatky(foto, 32);
  ok('z fotky se vystřihne kousek látky', !!kousek && kousek.sirka === 32,
    kousek ? `${kousek.sirka}×${kousek.vyska}` : 'nic');
  if (kousek) {
    const barvy = new Set();
    let pozadi = 0;
    for (let i = 0; i < kousek.body.length; i += 4) {
      barvy.add(`${kousek.body[i]},${kousek.body[i + 1]},${kousek.body[i + 2]}`);
      if (kousek.body[i] > 245 && kousek.body[i + 1] > 245) pozadi += 1;
    }
    ok('  a je v něm vzor, ne jedna barva', barvy.size >= 2, `${barvy.size} barev`);
    ok('  a není v něm pozadí fotky', pozadi === 0, `${pozadi} bodů pozadí`);
  }

  /* Fotka bez produktu nesmí vrátit kus pozadí vydávaný za látku */
  const prazdna = png.novyObraz(40, 40);
  for (let i = 0; i < prazdna.body.length; i += 4) {
    prazdna.body[i] = prazdna.body[i + 1] = prazdna.body[i + 2] = 250;
    prazdna.body[i + 3] = 255;
  }
  ok('z fotky bez produktu nevznikne vzorek', px.vzorekLatky(prazdna, 16) === null);
}

/* ---------- 6. model vzhledu a rady ---------- */

console.log('\nvzhled a rady');

{
  const v = zk.vychoziVzhled('dospely');
  const vrstvy = zk.vrstvyVzhledu(v).map(one => one.typ);
  check('vzhled se kreslí odspodu nahoru a sako je nahoře',
    [vrstvy[0], vrstvy[vrstvy.length - 1]], ['postava', 'sako']);
  /* Vlasy a vousy mezi vrstvami nejsou — jsou součástí postavy */
  ok('vlasy ani vousy už nejsou vrstva na prodej',
    !vrstvy.includes('vlasy') && !vrstvy.includes('fousy'), vrstvy.join(' → '));

  /* Vzhled do adresy a zpátky — tudy chodí odkaz v e-mailu */
  const text = zk.vzhledDoTextu({ ...v, nazev: 'Na svatbu' });
  const zpet = zk.vzhledZTextu(text);
  check('vzhled se vejde do adresy a vrátí se stejný',
    [zpet.vek, zpet.telo, zpet.vyskaCm, zpet.kusy.sako.hex, zpet.kusy.kosile.hex],
    [v.vek, v.telo, v.vyskaCm, v.kusy.sako.hex, v.kusy.kosile.hex]);
  ok('a je to krátký text, ne celá databáze', text.length < 200, `${text.length} znaků`);
  check('nesmysl v adrese se neotevře jako prázdný vzhled', zk.vzhledZTextu('blbost'), null);

  /* Rady: černá na černé musí dostat slovo */
  const splyva = zk.poradce({ ...v, kusy: { ...v.kusy, kosile: { varianta: 'klasicka', hex: '#1f2d4d' } } });
  ok('košile v barvě saka dostane varování',
    splyva.some(one => one.typ === 'kosile' && one.druh === 'splyva'),
    splyva.map(one => `${one.typ}:${one.druh}`).join(' '));

  /*
   * Quentino prodává doplňky, ne obleky. Rada u doplňku proto musí
   * ukázat **konkrétní kus z katalogu**, ne odstín: zákazník si nekupuje
   * barvu, kupuje si tuhle kravatu. A bez katalogu nesmí radit vůbec —
   * doporučit kravatu, kterou nemáme, je horší než neporadit nic.
   */
  const KATALOG = [
    { kod: 'KRA1', nazev: 'Kravata burgundská', url: 'https://quentino.cz/p/kra1', cena: '690 Kč',
      cenaCislo: 690, obrazek: '', vzorek: '', typ: 'kravata', varianta: 'kravata',
      hex: '#5b1d26', velikosti: false, skladem: true },
    { kod: 'KRA2', nazev: 'Kravata šalvějová', url: 'https://quentino.cz/p/kra2', cena: '690 Kč',
      cenaCislo: 690, obrazek: '', vzorek: '', typ: 'kravata', varianta: 'kravata',
      hex: '#acc2ab', velikosti: false, skladem: true }
  ];
  const bezKravaty = zk.poradce(v, KATALOG);
  const radaKravata = bezKravaty.find(one => one.typ === 'kravata' && one.druh === 'ladi');
  ok('k obleku se doporučí konkrétní kravata z katalogu',
    !!radaKravata && !!radaKravata.produkt,
    radaKravata ? `${radaKravata.produkt}: ${radaKravata.text}` : 'nic');
  ok('  a je to ta, co k obleku barevně sedne',
    radaKravata?.produkt === 'KRA1', radaKravata?.produkt ?? '—');
  const bezKatalogu = zk.poradce(v, []);
  ok('bez katalogu se kravata nedoporučí vůbec',
    !bezKatalogu.some(one => one.typ === 'kravata'),
    bezKatalogu.map(one => one.typ).join(' · '));

  /* Doplněk, který na podkladu není vidět, je vyhozená koupě */
  const splyvaKravata = zk.poradce({
    ...v, kusy: { ...v.kusy, kravata: { varianta: 'kravata', hex: '#1f2d4d', produkt: 'KRA1' } }
  }, KATALOG);
  const varovani = splyvaKravata.find(one => one.typ === 'kravata' && one.druh === 'splyva');
  ok('kravata v barvě saka dostane varování i náhradu',
    !!varovani && !!varovani.produkt, varovani ? varovani.text : 'nic');

  const pasekIKsandy = zk.poradce({
    ...v,
    kusy: { ...v.kusy, pasek: { varianta: 'kozeny', hex: '#1b1b1d' }, ksandy: { varianta: 'uzke', hex: '#1b1b1d' } }
  });
  ok('pásek a kšandy naráz se rozmluví',
    pasekIKsandy.some(one => one.typ === 'ksandy' && one.druh === 'splyva'));

  /* Do košíku: produkt s velikostmi se naslepo přidat nesmí */
  const bezVelikosti = zk.doKosikuUrl({
    kod: 'A', nazev: '', url: 'https://quentino.cz/p/sako', cena: '', cenaCislo: 0,
    obrazek: '', vzorek: '', typ: 'sako', varianta: '', hex: '', velikosti: false, skladem: true
  });
  ok('produkt bez velikostí se přidá přímo z kabiny',
    bezVelikosti.rovnou && /addtocart=1/.test(bezVelikosti.url), bezVelikosti.url);
  const sVelikostmi = zk.doKosikuUrl({
    kod: 'B', nazev: '', url: 'https://quentino.cz/p/sako', cena: '', cenaCislo: 0,
    obrazek: '', vzorek: '', typ: 'sako', varianta: '', hex: '', velikosti: true, skladem: true
  });
  ok('produkt s velikostmi pošle na detail, ať si zákazník vybere',
    !sVelikostmi.rovnou && !/addtocart/.test(sVelikostmi.url), sVelikostmi.url);

  /* Měřítko výšky: od chodidel a v rozumných mezích */
  const p = { vyskaCm: 180 };
  ok('vyšší postava se zvětší', zk.vyskaMeritko(p, 192) > 1);
  ok('menší postava se zmenší', zk.vyskaMeritko(p, 168) < 1);
  ok('a kraje se zkrotí, ať z toho není karikatura',
    zk.vyskaMeritko(p, 400) <= 1.18 && zk.vyskaMeritko(p, 60) >= 0.82);
}

/* ---------- 7. celý řetěz oblékání ---------- */

console.log('\nřetěz oblékání');

{
  /*
   * Zástupná kresba jde **tou samou cestou** jako skutečné vrstvy: kroky
   * oblékání, rozdíl dvou sousedních, úklid masky, kontrola, že kus leží
   * tam, kam patří. Takže když projde tohle, projde i generování od
   * modelu — a pozná se to bez jediného zaplaceného obrázku.
   */
  db.exec(require(path.join(DIST, 'zkusebna/schema.js')).ZK_SCHEMA);
  const store = require(path.join(DIST, 'zkusebna/store.js'));
  const ukazka = require(path.join(DIST, 'zkusebna/ukazka.js'));

  const vysledek = ukazka.postavUkazku('dospely-bezny');
  ok('celá postava se obleče bez jediné nesedící vrstvy',
    vysledek.nesedi.length === 0 && vysledek.hotovo >= 13,
    `${vysledek.hotovo} vrstev${vysledek.nesedi.length ? ' · ' + vysledek.nesedi[0] : ''}`);

  const vrstvy = store.vrstvy('dospely-bezny');
  const sako = vrstvy.find(one => one.typ === 'sako' && one.varianta === 'jednoradove');
  /*
   * Sako musí vyjít jako **celé sako**, ne jako lem kolem košile. Přesně
   * tohle se jednou stalo: kreslilo se stejnou šedou jako košile pod ním,
   * rozdíl v místě překryvu nebyl žádný a ze saka zbylo 17 % postavy.
   * Od té doby má každý kus při kreslení vlastní výraznou barvu.
   */
  ok('sako vyjde celé, ne jen lem kolem košile',
    !!sako && sako.podil > 0.35, sako ? `${Math.round(sako.podil * 100)} % postavy` : 'chybí');

  const kosile = vrstvy.find(one => one.typ === 'kosile' && one.varianta === 'klasicka');
  ok('košile leží na trupu, ne u nohou',
    !!kosile && kosile.okraje.y < 400 && kosile.okraje.h > 100,
    kosile ? `od ${kosile.okraje.y}, vysoká ${kosile.okraje.h}` : 'chybí');

  /* Varianty jedné vrstvy vychází ze stejného podkladu, ne jedna z druhé */
  const motylek = vrstvy.find(one => one.typ === 'kravata' && one.varianta === 'motylek');
  ok('druhá varianta kravaty není prázdná',
    !!motylek && motylek.stav !== 'nesedi' && motylek.podil > 0,
    motylek ? `${motylek.stav}, ${(motylek.podil * 100).toFixed(1)} %` : 'chybí');

  /*
   * Přegenerovaná postava zahodí, co se na ni oblékalo. Vrstva je rozdíl
   * dvou kroků téhož obrázku — na jiné postavě visí o kus vedle, a
   * v okně by u ní přitom svítilo „hotovo".
   */
  {
    const pred = store.vrstvy('dospely-bezny').length;
    const zahozeno = store.zahodOblekani('dospely-bezny');
    const po = store.vrstvy('dospely-bezny');
    ok('přegenerování postavy zahodí staré oblékání',
      zahozeno === pred - 1 && po.length === 1 && po[0].typ === 'postava',
      `z ${pred} vrstev zbyla ${po.length}`);
    ok('  a kroky oblékání taky', store.kroky('dospely-bezny').length === 1);
    /* Zpátky, ať má zbytek zkoušky na čem měřit */
    ukazka.postavUkazku('dospely-bezny');
  }

  /* A složený vzhled má barvu, kterou si zákazník vybral */
  const slozeno = px.slozeni(
    zk.vrstvyVzhledu(zk.vychoziVzhled('dospely'))
      .map(one => {
        const v = vrstvy.find(r => r.typ === one.typ && r.varianta === one.varianta && r.soubor);
        if (!v) return null;
        return {
          obraz: png.nacti(fs.readFileSync(v.soubor)),
          hex: zk.vrstvaDef(one.typ).barvitelna ? one.hex : ''
        };
      })
      .filter(Boolean),
    store.postava('dospely-bezny').sirka,
    store.postava('dospely-bezny').vyska
  );
  let kusuSako = 0;
  const hledana = zk.hexNaRgb('#1f2d4d');
  for (let i = 0; i < slozeno.body.length; i += 4) {
    if (slozeno.body[i] === hledana.r && slozeno.body[i + 1] === hledana.g
      && slozeno.body[i + 2] === hledana.b) kusuSako += 1;
  }
  ok('na složeném modelu je přesně zvolená barva saka',
    kusuSako > 500, `${kusuSako} bodů v rgb(31, 45, 77)`);
}

/* ---------- 7b. šablony zboží a kulisa z jednoho obrázku ---------- */

console.log('\nšablony zboží');

{
  /*
   * Patrik (23. 11.): vrstvy od modelu na sebe nepasovaly. Teď se
   * kulisa vyřízne z jednoho obrázku postavy a zboží je šablona
   * v rozměrech z katalogu.
   */
  const store = require(path.join(DIST, 'zkusebna/store.js'));
  const sablony = require(path.join(DIST, 'zkusebna/sablony.js'));
  const produkty = require(path.join(DIST, 'zkusebna/produkty.js'));
  const ukazka = require(path.join(DIST, 'zkusebna/ukazka.js'));
  ukazka.postavUkazku('dospely-bezny');
  const vrstvy = store.vrstvy('dospely-bezny');
  const najdi = (typ, varianta) => vrstvy.find(one => one.typ === typ && one.varianta === varianta);
  const nactiMasku = v => {
    const o = png.nacti(fs.readFileSync(v.soubor));
    const m = new Uint8Array(o.sirka * o.vyska);
    for (let i = 0; i < m.length; i++) m[i] = o.body[i * 4 + 3] > 128 ? 255 : 0;
    return { o, m };
  };

  /* Kulisa z jednoho obrázku: košile, kalhoty a boty se nepřekrývají a postava nemá kreslicí barvu */
  const kosile = najdi('kosile', 'klasicka');
  const kalhoty = najdi('kalhoty', 'oblekove');
  const boty = najdi('boty', 'spolecenske');
  ok('košile, kalhoty i boty se vyříznou z obrázku postavy',
    [kosile, kalhoty, boty].every(v => v && v.stav === 'hotovo' && /z obrázku postavy/.test(v.zadani)),
    [kosile, kalhoty, boty].map(v => v ? v.stav : 'chybí').join(' · '));
  {
    const a = nactiMasku(kosile).m;
    const b = nactiMasku(kalhoty).m;
    let spolecne = 0;
    for (let i = 0; i < a.length; i++) if (a[i] && b[i]) spolecne += 1;
    ok('  a navzájem se nepřekrývají (jsou z jednoho obrázku)', spolecne === 0, `${spolecne} bodů`);
    const postava = png.nacti(fs.readFileSync(najdi('postava', 'zaklad').soubor));
    const purpur = px.maskaBarvy(postava, zk.signalniBarva('kosile'));
    let zbylo = 0;
    for (let i = 0; i < purpur.length; i++) if (purpur[i]) zbylo += 1;
    ok('  v postavě nezůstal kreslicí lem kolem košile', zbylo === 0, `${zbylo} bodů`);
  }

  /* Šablony: každá varianta zboží je, zadarmo a na bodech postavy */
  const zbozi = zk.ZK_VRSTVY.filter(d => d.sablona).flatMap(d => d.varianty.map(v => [d.typ, v.id]));
  const chybi = zbozi.filter(([t, v]) => { const x = najdi(t, v); return !x || x.stav !== 'hotovo'; });
  ok('každá varianta zboží má šablonu', chybi.length === 0, `${zbozi.length} šablon${chybi.length ? ', chybí ' + chybi.join(' ') : ''}`);
  ok('  model se na ně neptá — v plánu generování nejsou',
    require(path.join(DIST, 'zkusebna/vrstvy.js')).plan('dospely-bezny', false, 'vse')
      .every(one => !zk.vrstvaDef(one.typ).sablona && zk.vrstvaDef(one.typ).zPostavy !== one.varianta));

  const kotvy = sablony.kotvyPostavy('dospely-bezny').kotvy;
  const sirka = (typ, varianta) => najdi(typ, varianta).okraje.w;
  const k5 = sirka('kravata', 'kravata-5');
  const k9 = sirka('kravata', 'kravata-9');
  ok('kravata 9 cm je o tolik širší než pětka, o kolik má být',
    Math.abs(k9 / k5 - 9 / 5) < 0.15, `${k5} → ${k9} bodů (${(k9 / k5).toFixed(2)}×)`);
  ok('  a na postavě má svou skutečnou šířku',
    Math.abs(k9 / kotvy.naCm - 9) < 0.8, `${(k9 / kotvy.naCm).toFixed(1)} cm`);
  const kravata = najdi('kravata', 'kravata');
  ok('kravata visí od límce a končí u pasu',
    Math.abs(kravata.okraje.y - kotvy.limec.y) < kotvy.naCm
    && Math.abs(kravata.okraje.y + kravata.okraje.h - kotvy.pas) < 1.5 * kotvy.naCm,
    `od ${kravata.okraje.y} (límec ${Math.round(kotvy.limec.y)}) do ${kravata.okraje.y + kravata.okraje.h} (pas ${Math.round(kotvy.pas)})`);
  ok('motýlek pánský > dětský > MINI',
    sirka('kravata', 'motylek') > sirka('kravata', 'motylek-detsky') && sirka('kravata', 'motylek-detsky') > sirka('kravata', 'motylek-mini'));
  {
    /* Šířka jednoho pásku kšand: řádek v půlce mezi ramenem a pasem */
    const pasek = varianta => {
      const { o, m } = nactiMasku(najdi('ksandy', varianta));
      const y = Math.round((kotvy.ramenoL.y + kotvy.pas) / 2);
      let n = 0;
      for (let x = 0; x < Math.round(kotvy.limec.x); x++) if (m[y * o.sirka + x]) n += 1;
      return n / kotvy.naCm;
    };
    const [u, s2, e] = ['uzke', 'siroke', 'extra'].map(pasek);
    ok('kšandy 2,5 / 3,5 / 4 cm mají na postavě tu šířku',
      Math.abs(u - 2.5) < 0.6 && Math.abs(s2 - 3.5) < 0.6 && Math.abs(e - 4) < 0.6,
      `${u.toFixed(1)} / ${s2.toFixed(1)} / ${e.toFixed(1)} cm`);
    /* Kšandy jen po košili a kalhotách — ne na krku */
    const { o, m } = nactiMasku(najdi('ksandy', 'siroke'));
    let nadLimcem = 0;
    for (let y = 0; y < Math.round(kotvy.limec.y) - 2; y++) for (let x = 0; x < o.sirka; x++) if (m[y * o.sirka + x]) nadLimcem += 1;
    ok('  a nad límcem z nich nic není', nadLimcem === 0, `${nadLimcem} bodů`);
  }
  {
    /* Mapa světla má látku na polotónu — jinak by vyšla jiná barva, než jaká se vybrala */
    const { o, m } = nactiMasku(najdi('kravata', 'kravata'));
    const hodnoty = [];
    for (let i = 0; i < m.length; i++) if (m[i]) hodnoty.push(o.body[i * 4]);
    hodnoty.sort((a, b) => a - b);
    const median = hodnoty[Math.floor(hodnoty.length / 2)];
    ok('látka šablony leží na polotónu (barva vyjde přesně)', Math.abs(median - 128) <= 8, `medián ${median}`);
  }

  /* Ruční posun bodu šablony posune */
  {
    const pred = najdi('kravata', 'kravata').okraje.x;
    const p0 = store.postava('dospely-bezny');
    sablony.ulozRucneKotvy('dospely-bezny', { limec: [(kotvy.limec.x + 4 * kotvy.naCm) / p0.sirka, kotvy.limec.y / p0.vyska] });
    sablony.vygenerujSablony('dospely-bezny');
    const po = store.vrstvy('dospely-bezny').find(one => one.typ === 'kravata' && one.varianta === 'kravata').okraje.x;
    ok('posunutý bod límce posune kravatu', Math.abs(po - pred - 4 * kotvy.naCm) < 2, `${pred} → ${po}`);
    sablony.ulozRucneKotvy('dospely-bezny', null);
    sablony.vygenerujSablony('dospely-bezny');
  }

  /* Zařazení podle katalogu: šířka z parametru, rozměr motýlka z popisu */
  const rz = produkty.__test.rozmerZTextu;
  check('šířka kravaty z parametru „Šířka: 7cm"', rz([{ nazev: 'Šířka', hodnota: '7cm' }], '').sirkaCm, 7);
  check('šířka kšand „2,5cm"', rz([{ nazev: 'Šířka', hodnota: '2,5cm' }], '').sirkaCm, 2.5);
  check('rozměr motýlka z popisu', rz([], '<p>Elegantní motýlek. Rozměry: 12 × 5,5 cm.</p>'), { sirkaCm: 12, vyskaCm: 5.5 });
  const zarad = produkty.__test.zarad;
  check('kravata 6 cm → šablona šestky', zarad('Šedá pánská kravata', 'Kravaty', { sirkaCm: 6 }).varianta, 'kravata-6');
  check('kravata bez rozměru → sedmička (nejčastější)', zarad('Fialová pánská kravata matná', 'Kravaty').varianta, 'kravata');
  check('dětská kravata → šestka', zarad('Světle modrá dětská kravata', 'Dětské kravaty').varianta, 'kravata-6');
  check('pletená kravata', zarad('Černá pletená kravata', 'Pletené kravaty').varianta, 'pletena');
  check('dětský motýlek', zarad('Světle modrý dětský motýlek matný', 'Dětské motýlky').varianta, 'motylek-detsky');
  check('MINI motýlek', zarad('Světle modrý dětský MINI motýlek matný', 'Dětské motýlky').varianta, 'motylek-mini');
  {
    /* Motýlek s kapesníčkem je motýlek — a kapesníček je další kus sady, ne zapomenutý */
    const z = zarad('Tmavě hnědý pánský motýlek s vyšívaným vzorem a kapesníčkem', 'Motýlky');
    check('motýlek s kapesníčkem je motýlek (a kapesníček kus sady)',
      { typ: z.typ, varianta: z.varianta, casti: z.casti }, { typ: 'kravata', varianta: 'motylek', casti: [{ typ: 'kapesnicek', varianta: 'spicka' }] });
  }
  check('regata s kapesníčkem je regata', zarad('Vínově červená svatební regata s kapesníčkem', 'Regaty').varianta, 'regata');
  check('kšandy 2,5 cm → úzké', zarad('Světle modré pánské kšandy', 'Kšandy', { sirkaCm: 2.5 }).varianta, 'uzke');
  check('široké kšandy bez rozměru → 3,5 cm', zarad('Bílé pánské široké kšandy', 'Kšandy').varianta, 'siroke');
  check('kšandy 4 cm → extra široké', zarad('Černé pánské kšandy', 'Kšandy', { sirkaCm: 4 }).varianta, 'extra');

  /* K sedmičce se nabízí i šestka, ale ne motýlek */
  const nabidka = zk.produktyKVrstve([
    { kod: 'A', typ: 'kravata', varianta: 'kravata-6', hex: '#222222', cenaCislo: 1 },
    { kod: 'B', typ: 'kravata', varianta: 'motylek', hex: '#222222', cenaCislo: 1 }
  ], 'kravata', '', 'kravata').map(one => one.kod);
  check('k sedmičce se nabízí i šestka, ale ne motýlek', nabidka, ['A']);
}

/* ---------- 7c. textura, sako na postavě, body pro kabinu ---------- */

console.log('\ntextura a sako');

{
  const produkty = require(path.join(DIST, 'zkusebna/produkty.js'));
  const vrstvy = require(path.join(DIST, 'zkusebna/vrstvy.js'));
  const sablony = require(path.join(DIST, 'zkusebna/sablony.js'));
  const manifest = require(path.join(DIST, 'zkusebna/manifest.js'));

  /*
   * Patrik (23. 11.): textura kravaty „nevypadá vůbec jak by měla".
   * Vzorek se dláždil se švy a bod na bod. Teď je zrcadlený (navazuje)
   * a nese, kolik centimetrů látky ukazuje.
   */
  const kus = png.novyObraz(5, 4);
  for (let i = 0; i < 20; i++) { kus.body[i * 4] = i * 12; kus.body[i * 4 + 1] = 255 - i * 9; kus.body[i * 4 + 2] = 40; kus.body[i * 4 + 3] = 255; }
  const dlazdice = produkty.__test.zrcadli(kus);
  const bod = (o, x, y) => [o.body[(y * o.sirka + x) * 4], o.body[(y * o.sirka + x) * 4 + 1]].join(',');
  ok('vzorek se zrcadlí do dlaždice, která navazuje na všech stranách',
    dlazdice.sirka === 10 && bod(dlazdice, 0, 1) === bod(dlazdice, 9, 1) && bod(dlazdice, 2, 0) === bod(dlazdice, 2, 7));
  {
    /* Fotka: bílé pozadí, uprostřed vzorovaná látka */
    const foto = png.novyObraz(900, 900);
    for (let y = 0; y < 900; y++) for (let x = 0; x < 900; x++) {
      const i = (y * 900 + x) * 4;
      const na = x > 150 && x < 750 && y > 150 && y < 750;
      const kytka = na && ((x >> 4) + (y >> 4)) % 3 === 0;
      const v = na ? (kytka ? [230, 200, 60] : [40, 50, 90]) : [255, 255, 255];
      foto.body[i] = v[0]; foto.body[i + 1] = v[1]; foto.body[i + 2] = v[2]; foto.body[i + 3] = 255;
    }
    const latka = produkty.__test.vzorekZFotky(foto, 'kravata', 'kravata');
    let kytek = 0;
    if (latka) for (let i = 0; i < latka.obraz.body.length; i += 4) if (latka.obraz.body[i] > 200) kytek += 1;
    ok('vzorek je velký, se vzorem (ne kus jednobarevného podkladu) a ví, kolik cm ukazuje',
      !!latka && latka.obraz.sirka >= 128 && kytek > 0 && latka.cm > 2 && latka.cm < 12,
      latka ? `${latka.obraz.sirka} bodů = ${latka.cm} cm, ${kytek} bodů kytek` : 'nic');
  }

  /*
   * Sako na postavě: rukávy musí zakrýt rukávy košile vedle trupu a
   * nesmí zakrýt ruce. Patrik (23. 11.): sako mělo rukávy jako s rukama
   * v kapsách a u dítěte bylo o číslo větší.
   */
  {
    const W = 200; const H = 400;
    const zaklad = png.novyObraz(W, H);
    const kosile = new Uint8Array(W * H);
    const kalhoty = new Uint8Array(W * H);
    for (let y = 60; y < 400; y++) for (let x = 40; x < 160; x++) zaklad.body[(y * W + x) * 4 + 3] = 255;
    /* trup 70–130, ruce (rukávy) 40–68 a 132–160 od 60 do 200, pod tím dlaně do 230 */
    for (let y = 60; y < 200; y++) for (let x = 40; x < 160; x++) kosile[y * W + x] = 255;
    for (let y = 200; y < 400; y++) for (let x = 70; x < 130; x++) kalhoty[y * W + x] = 255;
    const kuze = vrstvy.__test.holaKuze(zaklad, [kosile, kalhoty]);
    const kotvy = { limec: { x: 100, y: 60 }, pas: 200, naCm: 2 };
    const sako = (zakryj) => {
      const o = png.novyObraz(W, H);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (zakryj(x, y)) o.body[(y * W + x) * 4 + 3] = 255;
      return o;
    };
    const dobre = sako((x, y) => y >= 60 && y < 225 && (x >= 40 && x < 160) && !(y > 205 && (x < 70 || x >= 130)));
    const kapsy = sako((x, y) => y >= 60 && y < 225 && x >= 66 && x < 134);
    const velke = sako((x, y) => y >= 60 && y < 260 && x >= 38 && x < 162);
    check('sako, které sedí, projde', vrstvy.__test.sedeniKulisy('sako', zaklad, dobre, kosile, kalhoty, kuze, kotvy), '');
    ok('sako s rukama v kapsách neprojde a řekne proč',
      /Rukávy saka nesedí/.test(vrstvy.__test.sedeniKulisy('sako', zaklad, kapsy, kosile, kalhoty, kuze, kotvy)));
    ok('sako o číslo větší (zakrývá ruce) neprojde',
      /velké/.test(vrstvy.__test.sedeniKulisy('sako', zaklad, velke, kosile, kalhoty, kuze, kotvy)));
  }

  /* Kabina dostane změřené body: podle pasu ořízne model, podle nich ukáže „přidat" */
  require(path.join(DIST, 'zkusebna/ukazka.js')).postavUkazku('dospely-bezny');
  const data = manifest.kabina(() => 'x', 10, {});
  const k = (data.postavy.find(one => one.id === 'dospely-bezny') || {}).kotvy;
  const m = sablony.kotvyPostavy('dospely-bezny').kotvy;
  ok('kabina dostane body postavy (pas, kravata, kšandy, kapsa)',
    !!k && Math.abs(k.pas - m.pas) <= 1 && k.kravata[1] > m.limec.y && k.kapesnicek[0] > m.limec.x,
    k ? JSON.stringify(k) : 'chybí');
}

/* ---------- 7d. sady, kov kšand, regata, kapesníček ---------- */

console.log('\nsady a šablony podle výrobků');

{
  const produkty = require(path.join(DIST, 'zkusebna/produkty.js'));
  const sablony = require(path.join(DIST, 'zkusebna/sablony.js'));
  const store = require(path.join(DIST, 'zkusebna/store.js'));
  const vrstvy = require(path.join(DIST, 'zkusebna/vrstvy.js'));
  const manifest = require(path.join(DIST, 'zkusebna/manifest.js'));
  const vystav = require(path.join(DIST, 'kabina/vystav.js'));
  const zarad = produkty.__test.zarad;

  /*
   * Patrik (23. 11.): „u sady kšandy+motýlek se zobrazí jen kšandy" a
   * u dárkových sad se na model dláždila fotka s víc věcmi. Sada se
   * pozná, dostane kusy a do kabiny jde až po kontrole.
   */
  const sada = zarad('Pánské kšandy a motýlek - sada vínová', 'Sady');
  ok('sada kšandy + motýlek: hlavní kus kšandy, motýlek jako další kus',
    sada.typ === 'ksandy' && (sada.casti || []).some(one => one.typ === 'kravata' && /motylek/.test(one.varianta)),
    JSON.stringify(sada));
  ok('  a čeká na kontrolu (bez ní by se do kabiny nedostala)', !!sada.kontrola, sada.kontrola || 'nečeká');
  ok('dárková sada s víc věcmi čeká na kontrolu',
    !!zarad('Pánská dárková sada kravata, kapesníček a manžetové knoflíčky', 'Dárkové sady').kontrola);
  ok('obyčejný kapesníček s lemem sadou není', !zarad('Bílý kapesníček s modrým lemem', 'Kapesníčky').kontrola);

  /* Věk podle názvu: kabina podle něj přepne model, nebo založí nový vzhled */
  check('MINI motýlek je pro kojence', produkty.proVek('Světle modrý dětský MINI motýlek', 'Dětské motýlky'), ['kojenec', 'dite']);
  check('dětské kšandy jsou pro dítě', produkty.proVek('Dětské kšandy modré', 'Kšandy'), ['dite', 'kojenec']);
  check('pánská kravata je pro dospělého', produkty.proVek('Vínová pánská kravata', 'Kravaty pro tátu a syna'), ['dospely']);

  /*
   * Kapesníček s lemem: z fotky se bere špička i s lemem a přetáhne se
   * na tvar šablony — lem leží po hranách, plocha zůstane bílá.
   */
  {
    const N = 600; const foto = png.novyObraz(N, N);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const i = (y * N + x) * 4; const d = Math.abs(x - 300) + Math.abs(y - 300);
      const v = d > 260 ? [255, 255, 255] : d > 238 ? [180, 30, 40] : [248, 248, 246];
      foto.body[i] = v[0]; foto.body[i + 1] = v[1]; foto.body[i + 2] = v[2]; foto.body[i + 3] = 255;
    }
    const roh = produkty.__test.vzorekZFotky(foto, 'kapesnicek', 'spicka');
    const bod = (u, v) => { const x = Math.round(u * (roh.obraz.sirka - 1)); const y = Math.round(v * (roh.obraz.vyska - 1)); const i = (y * roh.obraz.sirka + x) * 4; return [roh.obraz.body[i], roh.obraz.body[i + 1], roh.obraz.body[i + 2]]; };
    /* Těžiště trojúhelníku šablony (0,62;0) (0;1) (1;0,92) a bod těsně u levé hrany */
    const stred = bod((0.62 + 0 + 1) / 3, (0 + 1 + 0.92) / 3);
    const lem = bod(0.29, 0.55);
    ok('bílý kapesníček s lemem: plocha bílá, lem po hraně',
      !!roh && roh.cm < 0 && stred[0] > 230 && stred[1] > 230 && lem[0] > 150 && lem[1] < 80,
      roh ? `střed rgb(${stred.join(',')}), hrana rgb(${lem.join(',')})` : 'nic');
  }

  /* Šablony na postavě z ukázky */
  require(path.join(DIST, 'zkusebna/ukazka.js')).postavUkazku('dospely-bezny');
  const v = store.vrstvy('dospely-bezny');
  const najdi = (typ, varianta) => v.find(one => one.typ === typ && one.varianta === varianta);
  const k = sablony.kotvyPostavy('dospely-bezny').kotvy;
  {
    /* Kov kšand zvlášť: obarvená spona vypadala jako kus plastu (Patrik, 23. 11.) */
    const ksandy = najdi('ksandy', 'siroke');
    const kov = ksandy && ksandy.kov && fs.existsSync(ksandy.kov) ? png.nacti(fs.readFileSync(ksandy.kov)) : null;
    let kovovych = 0; let sedych = 0;
    if (kov) for (let i = 0; i < kov.body.length; i += 4) {
      if (kov.body[i + 3] < 200) continue;
      kovovych += 1;
      if (kov.body[i + 2] > kov.body[i]) sedych += 1;
    }
    ok('kšandy mají spony a posuvky jako zvláštní kovovou vrstvu',
      !!kov && kovovych > 50 && sedych / Math.max(1, kovovych) > 0.8, `${kovovych} bodů kovu`);
    const data = manifest.kabina((vr, jeKov) => (jeKov ? 'kov:' : '') + vr.typ, 5, {});
    ok('  a kabina dostane adresu kovu',
      data.vrstvy.some(one => one.typ === 'ksandy' && one.kov === 'kov:ksandy'));
    ok('  kapesníček nese svůj obdélník (roh výrobku se na něj natáhne)',
      data.vrstvy.some(one => one.typ === 'kapesnicek' && Array.isArray(one.okraje) && one.okraje[2] > 0));
  }
  {
    /* Regata: nabraný uzel a list do půlky hrudi, ne ovál přes límec */
    const regata = najdi('kravata', 'regata');
    const sirkaCm = regata.okraje.w / k.naCm;
    const konec = regata.okraje.y + regata.okraje.h;
    ok('regata je široká jako regata a končí nad pasem',
      sirkaCm > 7 && sirkaCm < 10.8 && konec < k.pas - 5 * k.naCm && regata.okraje.h / k.naCm > 14,
      `${sirkaCm.toFixed(1)} × ${(regata.okraje.h / k.naCm).toFixed(1)} cm, konec ${Math.round(konec)} (pas ${Math.round(k.pas)})`);
  }
  {
    /* Kapesníček se zmenší podle trupu — u kojence nesmí být přes půl hrudi */
    const W = 400; const H = 600;
    const kotvy = (ramenaCm) => ({ ...k, limec: { x: 200, y: 100 }, pas: 400, kapsa: { x: 260, y: 220 }, naCm: 8, ramena: ramenaCm * 8 });
    const sirka = (o) => { let od = W; let doK = 0; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (o.body[(y * W + x) * 4 + 3] > 128) { od = Math.min(od, x); doK = Math.max(doK, x); } return (doK - od) / 8; };
    const dospely = sirka(sablony.nakresliSablonu('kapesnicek', 'spicka', kotvy(44), W, H));
    const kojenec = sirka(sablony.nakresliSablonu('kapesnicek', 'spicka', kotvy(20), W, H));
    ok('kapesníček je u kojence menší než u dospělého',
      dospely > 6 && kojenec < dospely * 0.6, `${dospely.toFixed(1)} cm → ${kojenec.toFixed(1)} cm`);
  }
  {
    /*
     * Nová postava: sako a vesta dokreslené na tu předchozí se odloží.
     * Patrik (23. 11.): „vesta se vykreslila nějak velká, že nesedí na model".
     */
    const pred = najdi('sako', 'jednoradove');
    const p0 = store.postava('dospely-bezny');
    const obraz = png.nacti(fs.readFileSync(store.kroky('dospely-bezny').find(one => one.poradi === 0).soubor));
    vrstvy.ulozPostavu(p0, obraz, 'znovu');
    const po = store.vrstvy('dospely-bezny').find(one => one.typ === 'sako' && one.varianta === 'jednoradove');
    ok('po novém nakreslení postavy se staré sako odloží (nesedí na ni)',
      !!pred && pred.stav !== 'nesedi' && !!po && po.stav === 'nesedi' && /znovu/.test(po.potiz),
      `${pred ? pred.stav : '—'} → ${po ? po.stav : '—'}`);
    require(path.join(DIST, 'zkusebna/ukazka.js')).postavUkazku('dospely-bezny');
  }

  /* Vystavené vrstvy mají otisk ve jméně — jinak by prohlížeč rok ukazoval tu starou */
  {
    const a = vystav.cestaVrstvy({ postava: 'dospely-bezny', typ: 'kravata', varianta: 'kravata' }, 'abcdef0123456789');
    const b = vystav.cestaVrstvy({ postava: 'dospely-bezny', typ: 'kravata', varianta: 'kravata' }, '9999990123456789');
    const kov = vystav.cestaVrstvy({ postava: 'dospely-bezny', typ: 'ksandy', varianta: 'uzke' }, 'abcdef0123', true);
    ok('nový obsah vrstvy = nová adresa (vystavuje se s cache na rok)',
      a !== b && /\.abcdef0123\.png$/.test(a) && /-kov\.abcdef0123\.png$/.test(kov), `${a} · ${kov}`);
    ok('  vzorek látky taky', /vzorky\/KRA1-0\.[0-9a-f]{10}\.png$/.test(vystav.cestaVzorku('KRA1~0', '0123456789abcdef')),
      vystav.cestaVzorku('KRA1~0', '0123456789abcdef'));
  }
}

/* ---------- 7e. AI rozpozná fotku sady ---------- */

/* Běží asynchronně — spustí se na konci, než se sečtou chyby */
const aiZkouska = async () => {
  console.log('\nrozpoznání fotek AI');
  const store = require(path.join(DIST, 'zkusebna/store.js'));
  const rozpoznani = require(path.join(DIST, 'zkusebna/rozpoznani.js'));

  /*
   * Patrik (23. 11.): u sady kšandy + motýlek se má na model dostat obojí
   * a u dárkové sady jen to, co se nosí. AI řekne, co na fotce je a kde
   * je rovná látka; pixely jsou ze skutečné fotky.
   *
   * Fotka: bílé pozadí, dvě černé kšandy (svislé pruhy), vínový motýlek
   * s bílými puntíky a modrá krabička s knoflíčky.
   */
  const W = 800; const H = 600;
  const foto = png.novyObraz(W, H);
  const barva = (x, y) => {
    if ((x >= 100 && x < 140 || x >= 220 && x < 260) && y >= 60 && y < 560) return [20, 20, 22];
    if (x >= 420 && x < 700 && y >= 120 && y < 260) {
      const tecka = ((x - 420) % 24 < 5) && ((y - 120) % 24 < 5);
      return tecka ? [250, 250, 250] : [122, 31, 43];
    }
    if (x >= 460 && x < 620 && y >= 380 && y < 520) return [30, 60, 160];
    return [255, 255, 255];
  };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const [r, g, bb] = barva(x, y); const i = (y * W + x) * 4;
    foto.body[i] = r; foto.body[i + 1] = g; foto.body[i + 2] = bb; foto.body[i + 3] = 255;
  }
  const f = (x, y, w, h) => [x / W, y / H, w / W, h / H];
  let dotaz = '';
  rozpoznani.nastavZeptani(async (fotky, text) => {
    dotaz = text;
    return {
      model: 'podvrh',
      text: '```json\n' + JSON.stringify({ kusy: [
        { druh: 'ksandy', popis: 'černé kšandy', foto: 0, ram: f(90, 50, 180, 520), latka: f(104, 200, 32, 200), latkaCm: 3.5, barva: '#141416', lem: null, vzor: 'jednobarevny', jistota: 0.93 },
        /* Obdélník látky motýlka schválně přesahuje do pozadí — musí se zmenšit, ne vydláždit bílý pruh */
        { druh: 'motylek', popis: 'vínový motýlek s puntíkem', foto: 0, ram: f(420, 120, 280, 140), latka: f(470, 140, 260, 100), latkaCm: 10, barva: '#7a1f2b', lem: null, vzor: 'drobny', jistota: 0.9 },
        { druh: 'jine', popis: 'krabička s knoflíčky', foto: 0, ram: f(460, 380, 160, 140), latka: f(470, 390, 100, 100), latkaCm: 5, barva: '#1e3ca0', lem: null, vzor: 'jednobarevny', jistota: 0.8 }
      ] }) + '\n```'
    };
  });
  store.zapisProdukt({
    kod: 'SADA-T', typ: 'ksandy', varianta: 'siroke', hex: '#808080', vzorek: '', rucne: false, velikosti: false,
    casti: [{ typ: 'kravata', varianta: 'motylek', hex: '#808080', vzorek: '' }],
    kontrola: 'Sada', schvaleno: true
  });
  const vysledek = await rozpoznani.rozpoznej('SADA-T', { fotky: [foto], nazev: 'Pánské kšandy a motýlek - sada', dokreslit: false });
  const row = store.produktyRows().find(one => one.kod === 'SADA-T');
  const vzorek = (data) => png.nacti(Buffer.from(String(data).split(',')[1] || '', 'base64'));
  const statistika = (o) => {
    let tmave = 0; let vinove = 0; let bile = 0; let n = 0;
    for (let i = 0; i < o.body.length; i += 4) {
      n += 1;
      const [r, g, b2] = [o.body[i], o.body[i + 1], o.body[i + 2]];
      if (r < 60 && g < 60 && b2 < 60) tmave += 1;
      if (r > 100 && g < 60 && b2 < 70) vinove += 1;
      if (r > 235 && g > 235 && b2 > 235) bile += 1;
    }
    return { tmave: tmave / n, vinove: vinove / n, bile: bile / n };
  };
  ok('AI dostane k fotce i to, co podle názvu čekat', /kšandy \+ motýlek/.test(dotaz), dotaz.slice(0, 100));
  const hlavni = row.vzorek ? statistika(vzorek(row.vzorek)) : null;
  ok('kšandy mají látku z kšand (černou), ne z celé fotky',
    !!hlavni && hlavni.tmave > 0.95, hlavni ? JSON.stringify(hlavni) : 'bez vzorku');
  const motylek = row.casti[0] && row.casti[0].vzorek ? statistika(vzorek(row.casti[0].vzorek)) : null;
  ok('motýlek má svou látku i s puntíky — a bez pruhu pozadí',
    !!motylek && motylek.vinove > 0.6 && motylek.bile > 0.01 && motylek.bile < 0.25,
    motylek ? JSON.stringify(motylek) : 'bez vzorku');
  ok('  velikost vzoru se ví z toho, co AI řekla o rozměru',
    row.casti[0].vzorekCm > 2 && row.casti[0].vzorekCm < 30, String(row.casti[0].vzorekCm));
  ok('sada po rozpoznání čeká na potvrzení (nic se neschválí samo)',
    !row.schvaleno && /AI na fotce/.test(row.kontrola) && /motýlek/.test(row.kontrola), row.kontrola);
  ok('  a v přehledu je, co AI viděla — i to, co na model nepatří',
    row.ai && row.ai.kusy.length === 3 && row.ai.poznamky.some(one => /nepatří: krabička/.test(one)),
    row.ai ? row.ai.poznamky.join(' | ') : 'nic');

  /* Co na fotce je navíc a na model patří, přidá se jako další kus sady */
  const { prirad } = rozpoznani.__test;
  const kus = (druh, jistota = 0.9) => ({ druh, popis: druh, foto: 0, ram: [0, 0, 1, 1], latka: [0, 0, 1, 1], latkaCm: 5, barva: '#000000', lem: null, vzor: 'drobny', jistota });
  const p1 = prirad([{ cast: -1, typ: 'kravata', rodina: 'kravata', varianta: 'kravata' }], [kus('kravata'), kus('kapesnicek'), kus('jine')], false);
  ok('kapesníček navíc na fotce kravaty → další kus sady',
    p1.prirazeni.has(-1) && p1.nove.length === 1 && p1.nove[0].typ === 'kapesnicek', JSON.stringify(p1.poznamky));
  const p2 = prirad([{ cast: -1, typ: 'ksandy', rodina: 'ksandy', varianta: 'siroke' }, { cast: 0, typ: 'kravata', rodina: 'motylek', varianta: 'motylek' }], [kus('ksandy')], false);
  ok('chybějící kus se pozná a řekne se, co s tím',
    !p2.prirazeni.has(0) && p2.poznamky.some(one => /nenašla: motýlek/.test(one)));
  const p3 = prirad([{ cast: -1, typ: 'kravata', rodina: 'motylek', varianta: 'motylek' }], [kus('motylek', 0.2)], false);
  ok('nejistý nález (pod 35 %) se nepoužije', !p3.prirazeni.has(-1));

  /* Kapesníček s lemem: z látky a barvy lemu se nakreslí špička — lem po hranách */
  const latka = png.novyObraz(8, 8);
  for (let i = 0; i < latka.body.length; i += 4) { latka.body[i] = 246; latka.body[i + 1] = 246; latka.body[i + 2] = 244; latka.body[i + 3] = 255; }
  const roh = rozpoznani.__test.rohSLemem(latka, 4, '#1f2d6d');
  const bod = (u, v) => { const x = Math.round(u * 159); const y = Math.round(v * 83); const i = (y * 160 + x) * 4; return [roh.body[i], roh.body[i + 1], roh.body[i + 2]]; };
  ok('kapesníček s lemem: střed bílý, hrana v barvě lemu',
    bod(0.54, 0.64)[0] > 230 && bod(0.31, 0.52)[2] > 90 && bod(0.31, 0.52)[0] < 60,
    `${bod(0.54, 0.64).join(',')} · ${bod(0.31, 0.52).join(',')}`);

  /* Rozbitá odpověď AI nespadne potichu do špatné látky */
  let chyba = '';
  try { rozpoznani.__test.rozeberOdpoved('Omlouvám se, nevidím.', 1); } catch (e) { chyba = e.message; }
  ok('nečitelná odpověď AI je chyba s radou, ne tichá prázdná sada', /znovu/.test(chyba), chyba);
  check('souřadnice v bodech místo zlomků se zahodí',
    rozpoznani.__test.rozeberOdpoved(JSON.stringify({ kusy: [{ druh: 'kravata', foto: 0, ram: [100, 50, 300, 400] }] }), 1).length, 0);
};

/* ---------- 8. košík, velikosti, body na modelu ---------- */

console.log('\nvzhled k nákupu');

{
  const KRAVATA = {
    kod: 'KRA1', nazev: 'Námořnická kravata', url: 'https://www.quentino.cz/p/namornicka-kravata',
    cena: '590 Kč', cenaCislo: 590, obrazek: '', vzorek: '', typ: 'kravata', varianta: 'kravata',
    hex: '#2b3a5c', velikosti: false, skladem: true,
    trhy: {
      sk: { nazev: 'Námornícka kravata', url: 'https://www.quentino.sk/p/namornicka-kravata', cena: '23 €', cenaCislo: 23 }
    }
  };
  const KSANDY = {
    kod: 'KSA9', nazev: 'Dětské kšandy', url: 'https://www.quentino.cz/p/detske-ksandy',
    cena: '389 Kč', cenaCislo: 389, obrazek: '', vzorek: '', typ: 'ksandy', varianta: 'uzke',
    hex: '#8d2b2b', velikosti: true, skladem: true, proVek: ['dite'],
    velikostiSeznam: [
      { kod: 'KSA9-65', popis: 'Délka: 65 cm', skladem: true },
      { kod: 'KSA9-75', popis: 'Délka: 75 cm', skladem: true },
      { kod: 'KSA9-90', popis: 'Délka: 90 cm', skladem: false }
    ]
  };

  /* --- sako se s kšandami schová, ale dá se přebít --- */
  const zaklad = zk.vychoziVzhled('dospely');
  ok('bez kšand je sako vidět', zk.sakoVidi(zaklad));
  const sKsandami = { ...zaklad, kusy: { ...zaklad.kusy, ksandy: { varianta: 'uzke', hex: '#1b1b1d' } } };
  ok('kšandy sako samy schovají — jinak by po nich nebylo ani vidu',
    !zk.sakoVidi(sKsandami));
  ok('  a vrstvy to respektují',
    !zk.vrstvyVzhledu(sKsandami).some(one => one.typ === 'sako'),
    zk.vrstvyVzhledu(sKsandami).map(one => one.typ).join(' · '));
  ok('zákazník si sako vynutí zpátky (kvůli kapesníčku)',
    zk.sakoVidi({ ...sKsandami, sako: 'vidi' }));
  ok('a schová ho i bez kšand', !zk.sakoVidi({ ...zaklad, sako: 'skryto' }));
  const kapesnicekBezSaka = zk.vrstvyVzhledu({
    ...zaklad, sako: 'skryto',
    kusy: { ...zaklad.kusy, kapesnicek: { varianta: 'spicka', hex: '#fff', produkt: 'KAP1' } }
  });
  ok('kapesníček se bez saka nekreslí — neměl by kde být',
    !kapesnicekBezSaka.some(one => one.typ === 'kapesnicek'));

  /* --- body na modelu --- */
  const KATALOG = [KRAVATA, KSANDY, { ...KRAVATA, kod: 'KAP1', typ: 'kapesnicek', varianta: 'spicka' }];
  const body = zk.bodyNaModelu(zaklad, KATALOG);
  ok('body jsou jen na zboží, ne na kulise',
    body.length > 0 && body.every(one => zk.vrstvaDef(one.typ).zbozi),
    body.map(one => one.typ).join(' · '));
  ok('prázdná místa jdou první — ta zvou k nákupu',
    body.length > 0 && !body[0].obsazeno);
  ok('každý bod má pobídku', body.every(one => one.pobidka.length > 2));
  ok('na pásek bod nevznikne, když ho katalog nemá',
    !zk.bodyNaModelu(zaklad, [KRAVATA]).some(one => one.typ === 'pasek'));
  ok('bez saka zmizí i bod na kapesníček',
    !zk.bodyNaModelu({ ...zaklad, sako: 'skryto' }, KATALOG).some(one => one.typ === 'kapesnicek'));
  const sKravatou = { ...zaklad, kusy: { ...zaklad.kusy, kravata: { varianta: 'kravata', hex: '#2b3a5c', produkt: 'KRA1' } } };
  ok('obsazený bod se pozná',
    zk.bodyNaModelu(sKravatou, KATALOG).find(one => one.typ === 'kravata')?.obsazeno === true);

  /* --- počty: nula je odpověď, ne chybějící hodnota --- */
  const kNakupu = {
    ...zaklad,
    kusy: {
      kravata: { varianta: 'kravata', hex: '#2b3a5c', produkt: 'KRA1', pocet: 2 },
      ksandy: { varianta: 'uzke', hex: '#8d2b2b', produkt: 'KSA9', pocet: 0 }
    }
  };
  check('dva kusy jedné kravaty se sečtou, kus s nulou se vynechá',
    zk.cenaVzhledu(kNakupu, KATALOG), { suma: 1180, kusu: 1, chybi: 0, celkem: 2 });
  /* `chybi` jsou čtyři kusy kulisy (kalhoty, košile, sako, boty): mají
     barvu, ale žádný produkt — a to je v pořádku, neprodávají se */
  check('bez počtu se bere jeden kus — starší uložené vzhledy',
    zk.cenaVzhledu(sKravatou, KATALOG), { suma: 590, kusu: 1, chybi: 4, celkem: 1 });

  /* --- zápis vzhledu do textu: počty, velikosti, sako, starší odkazy --- */
  const sVelikosti = {
    ...zaklad, sako: 'vidi',
    kusy: { ksandy: { varianta: 'uzke', hex: '#8d2b2b', produkt: 'KSA9', pocet: 3, velikost: 'KSA9-75' } }
  };
  const tam = zk.vzhledDoTextu(sVelikosti);
  const zpet = zk.vzhledZTextu(tam);
  check('počet, velikost i sako přežijí cestu do odkazu a zpět',
    [zpet.sako, zpet.kusy.ksandy.pocet, zpet.kusy.ksandy.velikost, zpet.kusy.ksandy.produkt],
    ['vidi', 3, 'KSA9-75', 'KSA9']);
  const stary = 'dospely:bezny:180:kratke:3b2a20:-|kravata:kravata:2b3a5c:KRA1';
  const zStareho = zk.vzhledZTextu(stary);
  ok('odkaz rozeslaný před touhle změnou se pořád otevře',
    !!zStareho && zStareho.kusy.kravata.produkt === 'KRA1'
    && zStareho.sako === 'auto' && zStareho.kusy.kravata.pocet === undefined,
    zStareho ? JSON.stringify(zStareho.kusy.kravata) : 'nic');

  /* --- jazykové verze --- */
  check('na slovenském e-shopu se vkládá slovenská adresa',
    zk.proTrh(KRAVATA, 'sk').url, 'https://www.quentino.sk/p/namornicka-kravata');
  check('česká verze zůstane, i když ji feed zvlášť neposílá',
    zk.proTrh(KRAVATA, 'cz').url, 'https://www.quentino.cz/p/namornicka-kravata');
  check('bez dat pro trh se nespadne na prázdný odkaz',
    zk.proTrh({ ...KRAVATA, trhy: undefined }, 'en').url, KRAVATA.url);
  check('jazyk se pozná ze stránky', [
    zk.trhZJazyka('cs'), zk.trhZJazyka('sk-SK'), zk.trhZJazyka('en-GB'), zk.trhZJazyka('www.quentino.sk')
  ], ['cz', 'sk', 'en', 'sk']);

  /* --- do košíku formulářem, i s velikostí --- */
  const post = zk.doKosikuPost(KSANDY, 2, '1428', '5571');
  check('formulář míří na detail produktu a nese velikost',
    post, {
      akce: 'https://www.quentino.cz/p/detske-ksandy?do=productForm-submit',
      pole: { product_id: '1428', option_set_id: '5571', quantity: '2' }
    });
  ok('bez id produktu se formulář neodešle — radši otevřít detail',
    zk.doKosikuPost(KSANDY, 1, '') === null);

  /* --- rada s velikostí u dětských kšand --- */
  check('„2–4 roky" se přečte jako roky',
    zk.rozsahVelikosti('2-4 roky'), { od: 2, do: 4, druh: 'roky' });
  check('„6-12 měsíců" taky, jen v letech',
    zk.rozsahVelikosti('6-12 měsíců'), { od: 0.5, do: 1, druh: 'roky' });
  check('„98/104" je výška v centimetrech',
    zk.rozsahVelikosti('98/104'), { od: 98, do: 104, druh: 'cm' });
  check('„Délka: 120 cm" je jedno číslo',
    zk.rozsahVelikosti('Délka: 120 cm'), { od: 120, do: 120, druh: 'cm' });
  check('velikost „M" se přečíst nedá a kabina to přizná',
    zk.rozsahVelikosti('M'), null);

  const dite = { ...zk.vychoziVzhled('dite'), vyskaCm: 120 };
  const rada = zk.radaVelikosti(KSANDY, dite);
  ok('dětským kšandám se poradí délka podle výšky',
    rada.kod === 'KSA9-75' && rada.podle === 'delka' && !rada.jiste,
    `${rada.kod} · ${rada.text}`);
  ok('  a je v tom vidět, že je to odhad, i nabídka doptat se',
    /odhad|nejist/i.test(rada.text) && /napište/i.test(rada.text), rada.text);

  const PODLE_VYSKY = {
    ...KSANDY,
    velikostiSeznam: [
      { kod: 'A', popis: '98/104', skladem: true },
      { kod: 'B', popis: '110/116', skladem: true },
      { kod: 'C', popis: '122/128', skladem: true }
    ]
  };
  const poVysce = zk.radaVelikosti(PODLE_VYSKY, { ...dite, vyskaCm: 114 });
  ok('velikost podle výšky dítěte je odpověď, ne odhad',
    poVysce.kod === 'B' && poVysce.podle === 'vyska' && poVysce.jiste,
    `${poVysce.kod} · ${poVysce.text}`);
  /*
   * 120 cm nepadne do žádné velikosti — mezi 110/116 a 122/128 je mezera.
   * Vybere se větší (menší by byla krátká) a **neslíbí se, že sedne**:
   * rodič, kterému se tvrdilo „tahle vám bude", zásilku vrátí.
   */
  const mezi = zk.radaVelikosti(PODLE_VYSKY, dite);
  ok('výška mezi dvěma velikostmi se přizná jako odhad',
    mezi.kod === 'C' && !mezi.jiste, `${mezi.kod} · ${mezi.text}`);

  const poLetech = zk.radaVelikosti({
    ...KSANDY,
    velikostiSeznam: [
      { kod: 'A', popis: '1-2 roky', skladem: true },
      { kod: 'B', popis: '3-5 let', skladem: true },
      { kod: 'C', popis: '6-8 let', skladem: true }
    ]
  }, { ...zk.vychoziVzhled('dite'), vyskaCm: 100 });
  ok('a podle věku se trefí taky',
    poLetech.podle === 'roky' && poLetech.jiste,
    `${poLetech.kod} (${poLetech.popis}) · ${zk.rokyPostavy({ vek: 'dite', vyskaCm: 100 })} roky`);

  const nevim = zk.radaVelikosti({
    ...KSANDY, velikostiSeznam: [{ kod: 'A', popis: 'univerzální', skladem: true }, { kod: 'B', popis: 'M', skladem: true }]
  }, dite);
  ok('u nečitelných velikostí kabina netvrdí nic a nabídne pomoc',
    nevim.kod === '' && /napište/i.test(nevim.text), nevim.text);
  ok('produkt bez velikostí žádnou radu nepotřebuje',
    zk.radaVelikosti(KRAVATA, dite) === null);
  ok('jediná velikost se vybere sama a mlčky',
    zk.radaVelikosti({ ...KSANDY, velikostiSeznam: [{ kod: 'X', popis: 'Délka: 70 cm', skladem: true }] }, dite).kod === 'X');
}

/* ---------- 8c. jak se z obrázku vybere kus látky ---------- */

console.log('\nvrstva z obrázku od modelu');

{
  /*
   * Tohle je jádro celé kabiny a dřív bylo postavené špatně.
   *
   * Vrstva se počítala jako **rozdíl dvou obrázků**: postava před
   * obléknutím a po něm. Jenže model nevrací „tentýž obrázek a navíc
   * kravatu" — vrací nový obrázek, který je tomu starému podobný.
   * Obličej překreslí o kousek jinak, světlo posune o stupeň, celek
   * odnese o dva body. V rozdílu je pak vedle kravaty i ozvěna všeho
   * ostatního: ve vrstvě s vlasy visel duch obličeje a nešlo to
   * spravit prahem, protože duch kolem očí je silnější než hranice
   * vlasů. Kolem toho rozdílu se nastavělo srovnávání tónu,
   * přizpůsobivý práh, dvojí zúžení masky i hlídání dosahu změny — a
   * pořád to na každé druhé vrstvě selhalo.
   *
   * Teď se kus **vybírá podle barvy**. Model má kus nakreslit ve
   * výrazné barvě, která nikde na postavě není, a vrstva jsou body té
   * barvy. Překreslený obličej tu barvu nemá, takže v ní nemůže
   * skončit — ne proto, že by ho zahodil práh, ale protože tam
   * nepatří.
   *
   * Zkouší se to na kresbě, ne na vygenerovaných obrázcích: každý
   * pokus u modelu stojí peníze a tohle se musí dát proměřit zadarmo.
   */
  const vrstvy = require(path.join(DIST, 'zkusebna/vrstvy.js'));
  const P = { id: 'dospely-bezny', vek: 'dospely', telo: 'bezny', vyskaCm: 180, sirka: SIRKA, vyska: VYSKA };
  const KRAVATA = zk.hexNaRgb(zk.ZK_KRESLICI.kravata);
  const kravata = { x: 56, y: 52, w: 8, h: 40 };

  /** Co by mohlo přijít od modelu: postava a na ní kus v dané barvě. */
  const odModelu = (barva, navic) => {
    const out = { sirka: SIRKA, vyska: VYSKA, body: Uint8Array.from(pred.body) };
    for (let y = kravata.y; y < kravata.y + kravata.h; y++) {
      for (let x = kravata.x; x < kravata.x + kravata.w; x++) {
        const i = (y * SIRKA + x) * 4;
        if (out.body[i + 3] < 128) continue;
        /* Záhyb: polovina kusu tmavší, ať je co uložit do mapy světla */
        const dil = x < kravata.x + kravata.w / 2 ? 1 : 0.55;
        out.body[i] = Math.round(barva.r * dil);
        out.body[i + 1] = Math.round(barva.g * dil);
        out.body[i + 2] = Math.round(barva.b * dil);
      }
    }
    if (navic) navic(out);
    return out;
  };
  const vrstvaZ = obraz => vrstvy.__test.vrstvaZObrazku(P, 'kravata', 'kravata', pred, obraz, 'zkouška');
  const sedneNaKravatu = v =>
    Math.abs(v.okraje.x - kravata.x) <= 3 && Math.abs(v.okraje.y - kravata.y) <= 4
    && Math.abs(v.okraje.w - kravata.w) <= 5 && Math.abs(v.okraje.h - kravata.h) <= 5;

  /* 1. Čistý případ */
  const cisty = vrstvaZ(odModelu(KRAVATA));
  ok('kus v kreslicí barvě se z obrázku vybere celý',
    cisty.vrstva.stav === 'hotovo' && sedneNaKravatu(cisty.vrstva),
    `${cisty.vrstva.stav}: ${cisty.vrstva.okraje.x},${cisty.vrstva.okraje.y} `
    + `${cisty.vrstva.okraje.w}×${cisty.vrstva.okraje.h} proti ${kravata.w}×${kravata.h}`);

  {
    const obraz = png.nacti(fs.readFileSync(cisty.vrstva.soubor));
    const svetla = [];
    for (let i = 0; i < obraz.sirka * obraz.vyska; i++) {
      if (obraz.body[i * 4 + 3] > 200) svetla.push(obraz.body[i * 4]);
    }
    ok('  a zůstane v ní záhyb, ne placatá barva',
      svetla.length > 100 && Math.max(...svetla) - Math.min(...svetla) > 25,
      `jas od ${Math.min(...svetla)} do ${Math.max(...svetla)}`);
  }

  /*
   * 2. Překreslený obličej — **ten duch**. Model při oblékání kravaty
   * překreslí hlavu: jiná pleť, jiné světlo. Dřív z toho byl v každé
   * vrstvě obrys obličeje.
   */
  const sObicejem = odModelu(KRAVATA, out => {
    for (let y = 16; y < 48; y++) {
      for (let x = 0; x < SIRKA; x++) {
        const i = (y * SIRKA + x) * 4;
        if (out.body[i + 3] < 128) continue;
        out.body[i] = 170; out.body[i + 1] = 128; out.body[i + 2] = 104;
      }
    }
  });
  /* Nejdřív starou cestou, ať je vidět, odkud se duch bral */
  const starou = px.okraje(px.uklid(px.rozdil(pred, sObicejem), SIRKA, VYSKA), SIRKA, VYSKA);
  ok('  (jako rozdíl dvou obrázků by se do vrstvy dostal i obličej)',
    starou.y < kravata.y - 6, `vrstva by začínala na ${starou.y}, kravata je od ${kravata.y}`);
  const bezDucha = vrstvaZ(sObicejem);
  ok('překreslený obličej se do vrstvy nedostane — nemá tu barvu',
    bezDucha.vrstva.stav === 'hotovo' && sedneNaKravatu(bezDucha.vrstva),
    `${bezDucha.vrstva.okraje.x},${bezDucha.vrstva.okraje.y} `
    + `${bezDucha.vrstva.okraje.w}×${bezDucha.vrstva.okraje.h}`);

  /* 3. Celý obrázek o stupeň světlejší — dřív to vrstvu nafouklo na celou postavu */
  const svetlejsi = odModelu(KRAVATA, out => {
    for (let i = 0; i < out.body.length; i += 4) {
      if (out.body[i + 3] < 128) continue;
      for (let k = 0; k < 3; k++) out.body[i + k] = Math.min(255, out.body[i + k] + 14);
    }
  });
  const poTonu = vrstvaZ(svetlejsi);
  ok('celkové projasnění vrstvu nezvětší', sedneNaKravatu(poTonu.vrstva),
    `${poTonu.vrstva.okraje.w}×${poTonu.vrstva.okraje.h}`);

  /* 4. Model obrázek odnese o pár bodů — vrstva musí sednout zpátky */
  const posunuty = { sirka: SIRKA, vyska: VYSKA, body: new Uint8Array(SIRKA * VYSKA * 4) };
  {
    const zdroj = odModelu(KRAVATA);
    for (let y = 0; y < VYSKA; y++) {
      for (let x = 0; x < SIRKA; x++) {
        const zx = x - 2;
        const zy = y - 2;
        if (zx < 0 || zy < 0) continue;
        for (let k = 0; k < 4; k++) {
          posunuty.body[(y * SIRKA + x) * 4 + k] = zdroj.body[(zy * SIRKA + zx) * 4 + k];
        }
      }
    }
  }
  const poPosunu = vrstvaZ(posunuty);
  ok('odnesený obrázek se vrátí na místo', sedneNaKravatu(poPosunu.vrstva),
    `${poPosunu.vrstva.okraje.x},${poPosunu.vrstva.okraje.y} proti ${kravata.x},${kravata.y}`);

  /*
   * 5. Model kreslicí barvou vymaluje pozadí. Není to kus látky — kus
   * látky je na člověku.
   */
  const sPozadim = odModelu(KRAVATA, out => {
    for (let y = 30; y < 110; y++) {
      for (let x = 0; x < SIRKA; x++) {
        const i = (y * SIRKA + x) * 4;
        if (pred.body[i + 3] >= 24) continue;
        out.body[i] = KRAVATA.r; out.body[i + 1] = KRAVATA.g;
        out.body[i + 2] = KRAVATA.b; out.body[i + 3] = 255;
      }
    }
  });
  ok('vymalované pozadí se do vrstvy nedostane', sedneNaKravatu(vrstvaZ(sPozadim).vrstva),
    `${vrstvaZ(sPozadim).vrstva.okraje.w}×${vrstvaZ(sPozadim).vrstva.okraje.h}`);

  /*
   * 6. Odlesk uprostřed kusu. Vybělený bod odstín ztratí, a kdyby
   * zůstal průhledný, prosvítala by jím na modelu košile.
   */
  const sOdleskem = odModelu(KRAVATA, out => {
    for (let y = 60; y < 66; y++) {
      for (let x = 58; x < 62; x++) {
        const i = (y * SIRKA + x) * 4;
        out.body[i] = 250; out.body[i + 1] = 248; out.body[i + 2] = 250;
      }
    }
  });
  {
    const vrstva = vrstvaZ(sOdleskem).vrstva;
    const obraz = png.nacti(fs.readFileSync(vrstva.soubor));
    let diry = 0;
    for (let y = 60; y < 66; y++) {
      for (let x = 58; x < 62; x++) if (obraz.body[(y * SIRKA + x) * 4 + 3] < 128) diry += 1;
    }
    ok('odlesk na látce v kusu díru neudělá', diry === 0, `${diry} průhledných bodů`);
  }

  /*
   * 7. Model barvu nedodrží a nakreslí kravatu šedou. Nevznikne nic a
   * v okně to stojí černé na bílém — pořád lepší než vrstva, ve které
   * visí půl postavy a nikdo neví proč.
   */
  const sedivy = vrstvaZ(odModelu({ r: 150, g: 148, b: 150 }));
  ok('když model barvu nedodrží, vrstva nevznikne a řekne se to',
    sedivy.vrstva.stav === 'nesedi' && /nic/.test(sedivy.vrstva.potiz),
    sedivy.vrstva.potiz.slice(0, 80));
}

/* ---------- 8d. podklad, na který se kus kreslí ---------- */

{
  /*
   * Podklad se neskládá z obrázků od modelu, ale z vrstev, které už
   * máme. Dřív se oblékalo postupně a jediný nepovedený krok otrávil
   * všechno po sobě: na krocích měla postava od vlasů dál černou hlavu
   * místo obličeje a každý další kus se kreslil na ni.
   */
  const vrstvy = require(path.join(DIST, 'zkusebna/vrstvy.js'));
  const ukazka = require(path.join(DIST, 'zkusebna/ukazka.js'));
  const store = require(path.join(DIST, 'zkusebna/store.js'));
  store.zahodOblekani('dospely-bezny');
  ukazka.postavUkazku('dospely-bezny');

  const podklad = vrstvy.__test.podkladProKus('dospely-bezny', 'kravata');
  const kDispozici = store.vrstvy('dospely-bezny');
  const kosileVrstva = kDispozici.find(one => one.typ === 'kosile' && one.stav !== 'nesedi');
  ok('podklad pro kravatu je postava v kalhotách a košili',
    !!kosileVrstva && podklad.sirka > 0 && podklad.vyska > 0,
    `${kDispozici.length} vrstev k dispozici, plátno ${podklad.sirka}×${podklad.vyska}`);

  /*
   * V podkladu nesmí být žádná kreslicí barva — jinak by se kus, který
   * se zrovna kreslí, spletl s tím, co už je na postavě.
   */
  let signalnich = 0;
  for (const typ of ['kosile', 'kalhoty', 'kravata']) {
    const barva = zk.hexNaRgb(zk.ZK_KRESLICI[typ]);
    const maska = px.maskaBarvy(podklad, barva);
    for (let i = 0; i < maska.length; i++) if (maska[i]) signalnich += 1;
  }
  ok('  a není v něm ani bod kreslicí barvy', signalnich === 0, `${signalnich} bodů`);

  /* Doplňky do podkladu nepatří: jsou jeden místo druhého */
  const sKsandami = vrstvy.__test.podkladProKus('dospely-bezny', 'kapesnicek');
  const ksandyBarva = zk.hexNaRgb(zk.ZK_KRESLICI.ksandy);
  const ksandyMaska = px.maskaBarvy(sKsandami, ksandyBarva);
  let ksandyVPodkladu = 0;
  for (let i = 0; i < ksandyMaska.length; i++) if (ksandyMaska[i]) ksandyVPodkladu += 1;
  ok('  a kapesníček se nekreslí přes kšandy', ksandyVPodkladu === 0,
    `${ksandyVPodkladu} bodů kšand v podkladu`);
}

/* ---------- 8b. zadání pro kreslení ---------- */

console.log('\nzadání pro model');

{
  const zadani = require(path.join(DIST, 'zkusebna/zadani.js'));
  const { setSetting } = require(path.join(DIST, 'db.js'));

  /*
   * Postava se kreslí **oblečená**. Dřív stála ve spodním prádle —
   * pro skládání vrstev nejčistší základ, jenže model takové zadání
   * odmítne („safety_violations=[sexual]") a u dítěte a kojence
   * oprávněně. Vrstva je rozdíl dvou kroků, takže základ pod oblekem
   * může být tričko a kalhoty; podmínka je jen výrazně jiná barva.
   */
  for (const vek of ['dospely', 'dite', 'kojenec']) {
    const text = zadani.__test.zadaniPostavy(vek, 'bezny');
    ok(`postava (${vek}) je v zadání oblečená`,
      !/briefs|underwear|undershirt|bodysuit/i.test(text) && /t-shirt|top/i.test(text),
      text.slice(text.indexOf('Wearing'), text.indexOf('Wearing') + 70));
  }
  ok('a je u toho řečeno, že jde o katalog oblečení',
    /fully clothed/i.test(zadani.__test.zadaniPostavy('dite', 'bezny')));
  /*
   * Postava má vlasy rovnou v zadání. Dřív se kreslila holá a vlasy
   * byly vrstva navíc — jenže vrstva se bere z obrázku a nad obličejem
   * tím pádem vznikal jeho duch. Vlasy jsou součást člověka.
   */
  ok('postava má vlasy rovnou v zadání, nejsou vrstva',
    /hair/i.test(zadani.__test.zadaniPostavy('dospely', 'bezny'))
    && !/bald/i.test(zadani.__test.zadaniPostavy('dospely', 'bezny')));

  /*
   * A u kusu je kreslicí barva ta nejdůležitější věta: podle ní se
   * vrstva z obrázku vybírá. Musí tam být i to, že ji nesmí mít nic
   * jiného — jinak model obarví i pozadí a vrstva je k ničemu.
   */
  for (const typ of ['kravata', 'sako', 'kapesnicek']) {
    const def = zk.vrstvaDef(typ);
    const text = zadani.__test.zadaniKusu(typ, def.varianty[0].id);
    const hex = zk.ZK_KRESLICI[typ].toLowerCase();
    ok(`zadání pro ${typ} říká barvu, podle které se vrstva pozná`,
      text.toLowerCase().includes(hex) && /nothing else in the image may have it/.test(text),
      hex);
  }
  /*
   * Postava se kreslí rovnou v košili, kalhotách a botách, každý kus ve
   * své kreslicí barvě — vyříznou se z jednoho obrázku a sedí na sebe.
   */
  {
    const text = zadani.__test.zadaniPostavy('dospely', 'bezny').toLowerCase();
    ok('postava se kreslí v košili, kalhotách a botách v kreslicích barvách',
      ['kosile', 'kalhoty', 'boty'].every(typ => text.includes(zk.ZK_KRESLICI[typ].toLowerCase()))
      && /no tie/.test(text));
  }

  setSetting('zkZadani:postava2:dospely:bezny',
    'Full-body photo of a man wearing only a white undershirt and light grey briefs.');
  ok('starší uložené znění se spodním prádlem se už nepoužije',
    !/briefs/i.test(zadani.zadaniPostavyTed('dospely', 'bezny')));
  setSetting('zkZadani:postava2:dospely:bezny', 'Vlastní zadání bez problému.');
  check('ale vlastní zadání, které projde, zůstane',
    zadani.zadaniPostavyTed('dospely', 'bezny'), 'Vlastní zadání bez problému.');
  setSetting('zkZadani:postava2:dospely:bezny', '');
  /* Zadání ze starého postupu (šedé tričko) se na nový nepoužije */
  setSetting('zkZadani:postava:dospely:bezny', 'Starý postup v šedém tričku.');
  ok('zadání ze starého postupu se nepoužije',
    !/Starý postup/.test(zadani.zadaniPostavyTed('dospely', 'bezny')));
  setSetting('zkZadani:postava:dospely:bezny', '');
}

/* ---------- 9. zavaděč, skript a náhradní e-shop ---------- */

console.log('\nskript pro e-shop');

{
  const zavadec = require(path.join(DIST, 'kabina/loader.js'));
  const skript = require(path.join(DIST, 'kabina/script.js'));
  const stranky = require(path.join(DIST, 'zkusebna/nahledstranky.js'));

  const kod = zavadec.kabinaLoader({ skript: 'https://ulozi.ste/kabina/kabina.js' });
  ok('zavaděč nese adresu kabiny a nic víc nestahuje',
    kod.includes('https://ulozi.ste/kabina/kabina.js') && !/fetch\(/.test(kod),
    `${Math.round(kod.length / 1000)} tisíc znaků`);
  /*
   * Zavaděč jde do šablony e-shopu ručně, přes pole v administraci.
   * Kdyby narostl, nevejde se — a hlavně by ho nesl každý požadavek na
   * každou stránku, což je přesně to, co se slíbilo neudělat.
   */
  ok('  a vejde se do šablony', kod.length < 12000, `${kod.length} znaků`);
  ok('  má svoje třídy, aby nepřebíjel kabinu',
    /qkbz-/.test(kod) && !/[^z]qkb-karta/.test(kod));
  ok('  výchozí výběr sedí na dnešní šablonu quentino.cz',
    kod.includes('card-item') && kod.includes('p-i-media') && kod.includes('frm-productForm'));
  const vlastni = zavadec.kabinaLoader({
    skript: 'x.js', vyber: { karta: ['.moje-karta'] }
  });
  ok('  a dá se přepsat, když se šablona změní',
    vlastni.includes('.moje-karta') && vlastni.includes('p-i-media'));

  const telo = skript.kabinaScript({ zdroj: 'https://ulozi.ste/kabina/data.json', ttl: 900 });
  ok('kabina se stahuje jako soubor, ne jako kus stránky',
    !/<script/.test(telo) && telo.includes('https://ulozi.ste/kabina/data.json'),
    `${Math.round(telo.length / 1000)} tisíc znaků`);
  ok('  umí česky, slovensky i anglicky',
    telo.includes('Zkušební kabina') && telo.includes('Skúšobná kabína') && telo.includes('Fitting room'));
  ok('  vkládá do košíku formulářem z detailu',
    telo.includes('do=productForm-submit') && telo.includes('option_set_id'));

  /* Náhradní e-shop v náhledu musí mít tvar toho skutečného */
  const produkt = {
    kod: 'KSA-D', cesta: '/p/detske-ksandy', nazev: 'Dětské kšandy', cena: '389 Kč',
    obrazek: '', cislo: '1428',
    velikosti: [
      { kod: 'A', popis: 'Délka: 65 cm', skladem: true },
      { kod: 'B', popis: 'Délka: 75 cm', skladem: true }
    ]
  };
  const detail = stranky.detailStranka('3', produkt, [produkt, { ...produkt, kod: 'X', nazev: 'Kravata', cesta: '/p/kravata' }]);
  ok('detail v náhledu nese formulář košíku jako quentino.cz',
    detail.includes('id="frm-productForm"')
    && detail.includes('name="product_id" id="frmproductForm-product_id" value="1428"')
    && detail.includes('do=productForm-submit'));
  ok('  u produktu s velikostmi je výběr varianty',
    /name="option_set_id"[\s\S]*option value="2000"/.test(detail));
  ok('  a související produkty, ze kterých kabina doporučuje',
    detail.includes('snippet--relatedProducts') && detail.includes('data-product-id'));
  const vypis = stranky.vypisStranka('3', [produkt]);
  ok('výpis nese kartu s číslem i adresou produktu',
    vypis.includes('data-product-id="1428"') && vypis.includes('data-href="/3/p/detske-ksandy"')
    && vypis.includes('class="p-i-media'));
  ok('  a na obou stránkách je zavaděč',
    /qkbz-/.test(vypis) && /qkbz-/.test(detail));

  /*
   * Čtení odeslaného formuláře. Prázdné pole se musí přečíst jako
   * prázdné — dřív se bralo „co je na dalším řádku" a u produktu bez
   * velikostí z toho vyšla jako velikost hranice formuláře.
   */
  const telo2 = [
    '------X', 'Content-Disposition: form-data; name="product_id"', '', '1428',
    '------X', 'Content-Disposition: form-data; name="option_set_id"', '', '',
    '------X', 'Content-Disposition: form-data; name="quantity"', '', '2',
    '------X--', ''
  ].join('\r\n');
  check('z formuláře se přečte číslo, velikost i počet', [
    stranky.poleFormulare(telo2, 'product_id'),
    stranky.poleFormulare(telo2, 'option_set_id'),
    stranky.poleFormulare(telo2, 'quantity')
  ], ['1428', '', '2']);
  /*
   * Náhled běží v rámečku se sandboxem, takže má původ „null" a každý
   * jeho požadavek je pro prohlížeč cizí. Bez hlavičky se nestáhne ani
   * seznam, ani obrázky vrstev — a kabina v okně ukáže jen „Teď to
   * nejde". Přesně to se stalo.
   */
  const nahled = require(path.join(DIST, 'zkusebna/nahled.js'));
  const hlavy = nahled.__test.hlavicky('application/json; charset=utf-8');
  check('náhled posílá hlavičku, bez které rámeček nic nestáhne',
    [hlavy['access-control-allow-origin'], hlavy['cache-control']], ['*', 'no-store']);

  check('cesta produktu si nechá slug z e-shopu',
    stranky.cestaProduktu({ kod: 'KSA1', url: 'https://www.quentino.cz/p/detske-ksandy-modre' }),
    '/p/detske-ksandy-modre');
}

/*
 * Vlastní adresy se registrují jedním voláním. Electron bere
 * `registerSchemesAsPrivileged` jen jednou; když ho volaly tři moduly
 * zvlášť, přišel náhled kabiny o fetch a hlásil „Failed to fetch"
 * (Patrik, 23. 11.).
 */
{
  const volani = [];
  const projdi = dir => {
    for (const jmeno of fs.readdirSync(dir)) {
      const cesta = path.join(dir, jmeno);
      if (fs.statSync(cesta).isDirectory()) { projdi(cesta); continue; }
      if (!/\.ts$/.test(jmeno)) continue;
      const kod = fs.readFileSync(cesta, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      const n = (kod.match(/registerSchemesAsPrivileged\s*\(/g) || []).length;
      if (n) volani.push(`${path.relative(path.join(__dirname, '..'), cesta)}×${n}`);
    }
  };
  projdi(path.join(__dirname, '..', 'src', 'main'));
  ok('vlastní adresy (kabina, bannery, videa) se registrují jedním voláním',
    volani.length === 1 && /×1$/.test(volani[0]), volani.join(', '));
}

aiZkouska().catch(e => { failed += 1; console.log('  ✗ rozpoznání spadlo:', e && e.stack || e); }).then(() => {
  console.log(failed ? `\n✗ ${failed} chyb` : '\n✓ zkušební kabina sedí');
  process.exit(failed ? 1 : 0);
});
