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
  ok('bez fousů se vrstva fousů nekreslí', !vrstvy.includes('fousy'), vrstvy.join(' → '));

  const sFousy = zk.vrstvyVzhledu({ ...v, fousy: 'plnovous' }).map(one => one.typ);
  ok('s fousy se kreslí hned za vlasy',
    sFousy[sFousy.indexOf('fousy') - 1] === 'vlasy', sFousy.join(' → '));

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
    vysledek.nesedi.length === 0 && vysledek.hotovo >= 20,
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

  /* Varianty jedné vrstvy vychází ze stejného kroku, ne jedna z druhé */
  const dozadu = vrstvy.find(one => one.typ === 'vlasy' && one.varianta === 'dozadu');
  ok('druhá varianta vlasů není prázdná',
    !!dozadu && dozadu.stav !== 'nesedi' && dozadu.podil > 0,
    dozadu ? `${dozadu.stav}, ${(dozadu.podil * 100).toFixed(1)} %` : 'chybí');

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

/* ---------- 8c. ujetý krok: tón, posun a kreslení mimo pruh ---------- */

console.log('\nkdyž model ujede');

{
  /*
   * Tohle je ta chyba z ostrého provozu: krátké vlasy vyšly na 23 %
   * postavy místo tří procent. Model nevrátí obrázek beze změny ani tam,
   * kam sáhnout neměl — celek je o stupeň světlejší, o dva body
   * posunutý, a někde navíc překreslený. Rozdíl dvou kroků to pak vezme
   * všechno jako „kus látky".
   *
   * Zkouší se to na kresbě, ne na vygenerovaných obrázcích: každý pokus
   * u modelu stojí peníze a tohle se musí dát proměřit zadarmo.
   */
  const vrstvy = require(path.join(DIST, 'zkusebna/vrstvy.js'));
  const P = { id: 'dospely-bezny', vek: 'dospely', telo: 'bezny', vyskaCm: 180, sirka: SIRKA, vyska: VYSKA };

  /* Kravata leží v horní polovině trupu — do pruhu pro ten kus */
  const kravata = { x: 56, y: 52, w: 8, h: 40 };
  const sKravatou = sePřidaným(pred, kravata, [120, 40, 30]);

  const zdravy = vrstvy.__test.vrstvaZKroku(P, 'kravata', 'kravata', pred, sKravatou, 'zkouška');
  ok('čistý krok projde a vrstva je ta kravata',
    zdravy.vrstva.stav === 'hotovo' && Math.abs(zdravy.vrstva.okraje.x - kravata.x) <= 3,
    `${zdravy.vrstva.stav}, ${(zdravy.vrstva.podil * 100).toFixed(1)} % postavy`);

  /*
   * 1. Celý obrázek o stupeň světlejší. Čtrnáct stupňů na složku je přes
   * práh rozdílu, takže bez srovnání tónu se jako „kus látky" označí celá
   * postava — tohle je ta chyba z ostrého provozu.
   */
  const svetlejsi = { sirka: SIRKA, vyska: VYSKA, body: Uint8Array.from(sKravatou.body) };
  for (let i = 0; i < svetlejsi.body.length; i += 4) {
    if (svetlejsi.body[i + 3] < 128) continue;
    for (let k = 0; k < 3; k++) svetlejsi.body[i + k] = Math.min(255, svetlejsi.body[i + k] + 14);
  }
  /* Nejdřív se ukáže, že se samotným pevným prahem je to průšvih —
     jinak by zkouška níž mohla projít i bez obrany proti ujetí */
  const bezOpravy = px.okraje(
    px.uklid(px.rozdil(pred, svetlejsi, undefined, 38, 0), SIRKA, VYSKA), SIRKA, VYSKA);
  ok('  s pevným prahem by vrstva spolkla celou postavu',
    bezOpravy.podil > 0.2, `${(bezOpravy.podil * 100).toFixed(1)} % plátna`);
  const poTonu = vrstvy.__test.vrstvaZKroku(P, 'kravata', 'kravata', pred, svetlejsi, 'zkouška');
  ok('celkové projasnění vrstvu nezvětší',
    poTonu.vrstva.stav === 'hotovo' && poTonu.vrstva.podil < zdravy.vrstva.podil * 1.5,
    `${poTonu.vrstva.stav}, ${(poTonu.vrstva.podil * 100).toFixed(1)} % místo ${(zdravy.vrstva.podil * 100).toFixed(1)} %`);

  /* 2. Překreslené boty, když se obléká kravata — mimo pruh, nezajímá nás to */
  const sBotami = { sirka: SIRKA, vyska: VYSKA, body: Uint8Array.from(sKravatou.body) };
  for (let y = 160; y < 176; y++) {
    for (let x = 40; x < 80; x++) {
      const i = (y * SIRKA + x) * 4;
      if (sBotami.body[i + 3] < 128) continue;
      sBotami.body[i] = 20; sBotami.body[i + 1] = 20; sBotami.body[i + 2] = 20;
    }
  }
  const poBotach = vrstvy.__test.vrstvaZKroku(P, 'kravata', 'kravata', pred, sBotami, 'zkouška');
  ok('co model překreslil mimo pruh, do vrstvy nepatří',
    poBotach.vrstva.stav === 'hotovo'
    && poBotach.vrstva.okraje.y + poBotach.vrstva.okraje.h < 140,
    `vrstva končí na ${poBotach.vrstva.okraje.y + poBotach.vrstva.okraje.h}, boty byly na 160+`);
  /*
   * A hlavně: krok, ze kterého se obléká dál, musí být mimo pruh bod po
   * bodu ten původní. Jinak se odchylky přes dvaadvacet kroků sčítají a
   * po deseti má postava jiný odstín pleti než na začátku.
   */
  let stejne = true;
  for (let y = 150; y < VYSKA && stejne; y++) {
    for (let x = 0; x < SIRKA; x++) {
      const i = (y * SIRKA + x) * 4;
      for (let k = 0; k < 4; k++) {
        if (poBotach.krok.body[i + k] !== pred.body[i + k]) { stejne = false; break; }
      }
      if (!stejne) break;
    }
  }
  ok('  a krok pro další oblékání zůstal mimo pruh nedotčený', stejne);

  /*
   * Výřez: modelu jde jen kus obrázku kolem toho, co se obléká.
   *
   * Je to tři věci naráz — levnější (obrázek se platí podle plochy),
   * spolehlivější (mimo výřez se překreslit nedá **z principu**) a
   * detailnější (kapesníček dostane víc bodů). Zkouší se, že výřez
   * sedne na pruh kusu, že splňuje meze rozhraní a že se vložením
   * zpátky nezmění nic mimo něj.
   */
  {
    const okraje = px.okraje(
      (() => {
        const m = new Uint8Array(SIRKA * VYSKA);
        for (let i = 0; i < m.length; i++) m[i] = pred.body[i * 4 + 3] > 24 ? 255 : 0;
        return m;
      })(), SIRKA, VYSKA);

    /*
     * Nejdřív to, co není naše volba: rozhraní nevezme obrázek menší
     * než 0,65 megabodu. Plátno téhle zkoušky je 120×180, tedy menší
     * než ta mez celé — a tam se výřez **musí** vzdát a poslat celý
     * obrázek. Kdyby to mlčky poslalo menší, vrátí rozhraní chybu a
     * nevznikne nic; proto se to zkouší jako první.
     */
    const maleP = vrstvy.__test.vyrezKusu('kravata', okraje, SIRKA, VYSKA);
    ok('na plátně pod mezí rozhraní jde celý obrázek, ne výřez',
      maleP.x === 0 && maleP.y === 0 && maleP.w === SIRKA && maleP.h === VYSKA,
      `${maleP.w}×${maleP.h} z ${SIRKA}×${VYSKA}`);

    /*
     * A teď geometrie na opravdovém plátně postavy (1024×1536), kde se
     * výřez vyplatí. Postava zabírá obvyklý sloupec doprostřed.
     */
    const VS = 1024, VV = 1536;
    const velkaPostava = { x: 300, y: 90, w: 430, h: 1380 };
    const velky = vrstvy.__test.vyrezKusu('kravata', velkaPostava, VS, VV);
    ok('výřez pro kravatu je menší než celé plátno',
      velky.w * velky.h < VS * VV * 0.7,
      `${velky.w}×${velky.h} z ${VS}×${VV}, tedy ${Math.round(velky.w * velky.h / (VS * VV) * 100)} %`);
    ok('  a drží meze rozhraní (násobek 16, poměr do 1:3, nad 0,65 Mb)',
      velky.w % 16 === 0 && velky.h % 16 === 0
      && velky.w * 3 >= velky.h && velky.h * 3 >= velky.w
      && velky.w * velky.h >= 655360,
      `${velky.w}×${velky.h} = ${velky.w * velky.h} bodů`);
    const pruhVelky = vrstvy.__test.pruhKusu('kravata', velkaPostava, VV);
    ok('  a pruh, kde kravata na postavě leží, je celý uvnitř',
      velky.y <= pruhVelky.od && velky.y + velky.h >= pruhVelky.do,
      `výřez ${velky.y}–${velky.y + velky.h}, pruh ${pruhVelky.od}–${pruhVelky.do}`);
    /*
     * Starší modely berou jen tři předepsané rozměry. Poslat jim výřez
     * 752×960 znamená chybu rozhraní, takže se jim dává čtverec —
     * pořád dvakrát levnější než plátno na výšku.
     */
    const pevny = vrstvy.__test.vyrezKusu('kravata', velkaPostava, VS, VV, false);
    ok('  a modelu s pevnými rozměry jde jeden z nich',
      [[1024, 1024], [1024, 1536], [1536, 1024]].some(([w, h]) => pevny.w === w && pevny.h === h),
      `${pevny.w}×${pevny.h}`);

    /*
     * Zbytek zkoušky pracuje s malým plátnem, aby šel obrázek po
     * bodech přečíst. Mez rozhraní se proto předá menší — je to
     * vlastnost rozhraní, ne naše volba, a jinde se nemění.
     */
    const vyrezKravaty = vrstvy.__test.vyrezKusu('kravata', okraje, SIRKA, VYSKA, true, 1500);
    ok('  na malém plátně s menší mezí výřez vznikne',
      vyrezKravaty.w * vyrezKravaty.h < SIRKA * VYSKA,
      `${vyrezKravaty.w}×${vyrezKravaty.h} z ${SIRKA}×${VYSKA}`);
    const pruhKravaty = vrstvy.__test.pruhKusu('kravata', okraje, VYSKA);
    ok('  a pruh, kde kravata leží, je celý uvnitř',
      vyrezKravaty.y <= pruhKravaty.od && vyrezKravaty.y + vyrezKravaty.h >= pruhKravaty.do,
      `výřez ${vyrezKravaty.y}–${vyrezKravaty.y + vyrezKravaty.h}, pruh ${pruhKravaty.od}–${pruhKravaty.do}`);

    /* Vyříznout a vložit zpátky beze změny nesmí nic pokazit */
    const tamZpet = px.vlozObdelnik(pred, px.vyrizniObdelnik(pred, vyrezKravaty), vyrezKravaty);
    let shodne = true;
    for (let i = 0; i < pred.body.length && shodne; i++) {
      if (tamZpet.body[i] !== pred.body[i]) shodne = false;
    }
    ok('  vyříznutí a vložení zpátky obrázek nezmění', shodne);

    /*
     * A celý krok přes výřez: model „obleče" jen ve výřezu a vrstva
     * z toho vyjde stejně jako kdyby dostal celý obrázek.
     */
    const kravata = { x: 56, y: 52, w: 8, h: 40 };
    const vyrezObraz = px.vyrizniObdelnik(pred, vyrezKravaty);
    for (let y = kravata.y - vyrezKravaty.y; y < kravata.y - vyrezKravaty.y + kravata.h; y++) {
      for (let x = kravata.x - vyrezKravaty.x; x < kravata.x - vyrezKravaty.x + kravata.w; x++) {
        if (y < 0 || x < 0 || y >= vyrezObraz.vyska || x >= vyrezObraz.sirka) continue;
        const i = (y * vyrezObraz.sirka + x) * 4;
        if (vyrezObraz.body[i + 3] < 128) continue;
        vyrezObraz.body[i] = 120; vyrezObraz.body[i + 1] = 40; vyrezObraz.body[i + 2] = 30;
      }
    }
    const celek = px.vlozObdelnik(pred, vyrezObraz, vyrezKravaty);
    const zVyrezu = vrstvy.__test.vrstvaZKroku(P, 'kravata', 'kravata', pred, celek, 'zkouška', vyrezKravaty);
    ok('vrstva z výřezu je ta kravata, ne nic jiného',
      zVyrezu.vrstva.stav === 'hotovo'
      && Math.abs(zVyrezu.vrstva.okraje.x - kravata.x) <= 3
      && Math.abs(zVyrezu.vrstva.okraje.h - kravata.h) <= 6,
      `${zVyrezu.vrstva.okraje.x},${zVyrezu.vrstva.okraje.y} ${zVyrezu.vrstva.okraje.w}×${zVyrezu.vrstva.okraje.h}`);
  }

  /*
   * Duch postavy ve vrstvě. Tohle je ta chyba, která byla vidět na
   * vrstvě s vlasy: kromě vlasů v ní visel **tenký obrys hlavy a
   * ramen**. Model totiž celý obrázek překreslí a kolem obrysů po sobě
   * nechá slabý rozdíl. Na modelu by z toho byl šmouhovitý stín přes
   * obličej.
   *
   * Vlasy proti holé hlavě jsou rozdíl o stovky stupňů, duch o desítky —
   * a je tenký. Proti tomu stojí dvě věci: práh odvozený od síly
   * skutečné změny a dvojí zúžení masky, které spolkne všechno tenčí
   * než zhruba čtyři body.
   */
  {
    const hlava = { x: 48, y: 22, w: 24, h: 18 };
    const sVlasy = { sirka: SIRKA, vyska: VYSKA, body: Uint8Array.from(pred.body) };
    /* Silná změna: tmavé vlasy na světlé hlavě */
    for (let y = hlava.y; y < hlava.y + hlava.h; y++) {
      for (let x = hlava.x; x < hlava.x + hlava.w; x++) {
        const i = (y * SIRKA + x) * 4;
        if (sVlasy.body[i + 3] < 128) continue;
        sVlasy.body[i] = 48; sVlasy.body[i + 1] = 38; sVlasy.body[i + 2] = 30;
      }
    }
    /* A slabý duch: obrys postavy posunutý o dva stupně jasu */
    for (let y = 20; y < 150; y++) {
      for (const x of [36, 37, 38, 83, 84, 85]) {
        const i = (y * SIRKA + x) * 4;
        if (sVlasy.body[i + 3] < 128) continue;
        for (let k = 0; k < 3; k++) sVlasy.body[i + k] = Math.min(255, sVlasy.body[i + k] + 22);
      }
    }

    const maska = px.uklid(px.rozdil(pred, sVlasy), SIRKA, VYSKA);
    const kde = px.okraje(maska, SIRKA, VYSKA);
    ok('ve vrstvě zůstanou vlasy, ne duch celé postavy',
      kde.y >= hlava.y - 4 && kde.y + kde.h <= hlava.y + hlava.h + 6,
      `vrstva od ${kde.y} do ${kde.y + kde.h}, vlasy jsou ${hlava.y}–${hlava.y + hlava.h}`);
    ok('  a vlasy v ní zůstanou celé',
      kde.w >= hlava.w - 6 && kde.h >= hlava.h - 6, `${kde.w}×${kde.h} proti ${hlava.w}×${hlava.h}`);
    /* S pevným prahem a jedním zúžením tam duch zůstane — ať je vidět rozdíl */
    const sDuchem = px.okraje(px.uklid(px.rozdil(pred, sVlasy, undefined, 38, 0), SIRKA, VYSKA), SIRKA, VYSKA);
    ok('  (s pevným prahem by duch ve vrstvě zůstal)',
      sDuchem.h > hlava.h * 2, `sahá přes ${sDuchem.h} bodů`);
  }

  /*
   * Zaplněné pozadí — chyba z ostrého provozu, kde z vrstvy s krátkými
   * vlasy leželo na postavě **osm procent**. Hlava zůstala holá a model
   * místo vlasů zaplnil prázdno kolem krku a ramen.
   *
   * Příčina: pruh pro kus je vodorovný a jde přes celé plátno, takže
   * maska otevřela i prázdno vedle postavy — a tam, kde model vidí
   * průhledno a povolení kreslit, kreslí. Oprava je jeden zákon na
   * dvou místech. Maska otevře jen postavu a její těsné okolí. A co
   * přijde zpátky mimo postavu, se vezme jen tam, kde je to těsně
   * u změny na postavě **a vypadá to stejně** — vlasy přerůstající
   * hlavu mají barvu vlasů, zaplněné pozadí barvu pozadí.
   *
   * Zkouší se to na plátně 1024×1536, protože dosah se počítá
   * z velikosti postavy: na kresbičce 120×180 by vyšel jinak a
   * neměřilo by se to, co běží v provozu.
   */
  {
    const SV = 1024;
    const VV = 1536;
    const hlava = { x: 430, y: 120, w: 160, h: 200 };
    const velka = png.novyObraz(SV, VV);
    for (let y = 0; y < VV; y++) {
      for (let x = 0; x < SV; x++) {
        const vHlave = x >= hlava.x && x < hlava.x + hlava.w && y >= hlava.y && y < hlava.y + hlava.h;
        const vTele = x >= 330 && x < 700 && y >= hlava.y + hlava.h && y < 1450;
        if (!vHlave && !vTele) continue;
        const i = (y * SV + x) * 4;
        velka.body[i] = 206; velka.body[i + 1] = 170; velka.body[i + 2] = 140; velka.body[i + 3] = 255;
      }
    }
    const VP = { id: 'dospely-bezny', vek: 'dospely', telo: 'bezny', vyskaCm: 180, sirka: SV, vyska: VV };
    const pruhVlasu = vrstvy.__test.pruhKusu('vlasy', vrstvy.__test.okrajePostavy(velka), VV);
    /** Zaplní prázdno v pruhu vlasů — to, co model udělal místo vlasů. */
    const zaplnPozadi = obraz => {
      for (let y = pruhVlasu.od; y <= Math.min(VV - 1, pruhVlasu.do); y++) {
        for (let x = 0; x < SV; x++) {
          const i = (y * SV + x) * 4;
          if (obraz.body[i + 3] >= 24) continue;
          obraz.body[i] = 232; obraz.body[i + 1] = 228; obraz.body[i + 2] = 220; obraz.body[i + 3] = 255;
        }
      }
      return obraz;
    };

    /* a) Vlasy na hlavě a k tomu zaplněné pozadí */
    const vlasy = { x: hlava.x, y: hlava.y, w: hlava.w, h: 70 };
    const sVlasy = { sirka: SV, vyska: VV, body: Uint8Array.from(velka.body) };
    for (let y = vlasy.y; y < vlasy.y + vlasy.h; y++) {
      for (let x = vlasy.x; x < vlasy.x + vlasy.w; x++) {
        const i = (y * SV + x) * 4;
        if (sVlasy.body[i + 3] < 128) continue;
        sVlasy.body[i] = 44; sVlasy.body[i + 1] = 34; sVlasy.body[i + 2] = 28;
      }
    }
    zaplnPozadi(sVlasy);

    /* Nejdřív bez obrany, ať je vidět, co se v provozu dělo */
    const bezObrany = px.uklid(px.rozdil(velka, px.slep(velka, sVlasy, pruhVlasu)), SV, VV);
    const naPostaveBez = vrstvy.__test.naPostave(
      bezObrany, vrstvy.__test.siluetaPostavy(velka), SV, VV);
    const kdeBez = px.okraje(bezObrany, SV, VV);
    ok('  (bez obrany je vrstva zaplněné pozadí přes celé plátno)',
      naPostaveBez < 0.2 && kdeBez.w > SV * 0.9,
      `na postavě ${Math.round(naPostaveBez * 100)} % vrstvy, široká ${kdeBez.w} z ${SV}`);

    const sObranou = vrstvy.__test.vrstvaZKroku(VP, 'vlasy', 'kratke', velka, sVlasy, 'zkouška');
    const kde = sObranou.vrstva.okraje;
    ok('zaplněné pozadí se do vrstvy nedostane',
      sObranou.vrstva.stav === 'hotovo'
      && Math.abs(kde.x - vlasy.x) <= 6 && Math.abs(kde.w - vlasy.w) <= 12
      && Math.abs(kde.h - vlasy.h) <= 12,
      `${sObranou.vrstva.stav}: ${kde.x},${kde.y} ${kde.w}×${kde.h}, vlasy ${vlasy.w}×${vlasy.h}`);

    /*
     * b) A naopak: vlasy, které hlavu opravdu přerůstají, se uříznout
     * nesmí. Kdyby se bralo jen to, co leží na původním obrysu, byl by
     * z každého účesu přilepený čepec.
     */
    const prerustajici = { sirka: SV, vyska: VV, body: Uint8Array.from(velka.body) };
    const ucles = { x: hlava.x - 18, y: hlava.y - 30, w: hlava.w + 36, h: 100 };
    for (let y = ucles.y; y < ucles.y + ucles.h; y++) {
      for (let x = ucles.x; x < ucles.x + ucles.w; x++) {
        const i = (y * SV + x) * 4;
        prerustajici.body[i] = 44; prerustajici.body[i + 1] = 34;
        prerustajici.body[i + 2] = 28; prerustajici.body[i + 3] = 255;
      }
    }
    zaplnPozadi(prerustajici);
    const sUcesem = vrstvy.__test.vrstvaZKroku(VP, 'vlasy', 'kratke', velka, prerustajici, 'zkouška');
    const kdeU = sUcesem.vrstva.okraje;
    ok('  a účes, který hlavu přerůstá, zůstane celý',
      sUcesem.vrstva.stav === 'hotovo'
      && Math.abs(kdeU.x - ucles.x) <= 4 && Math.abs(kdeU.w - ucles.w) <= 8
      && Math.abs(kdeU.h - ucles.h) <= 8,
      `${kdeU.x},${kdeU.y} ${kdeU.w}×${kdeU.h} proti ${ucles.w}×${ucles.h}`);

    /*
     * A totéž na vstupu: maska je to jediné, co modelu dopředu řekne,
     * kam nemá sahat. Otevřená je postava a pás kolem ní, ne pruh přes
     * celé plátno — tam, kde není co oblékat, se kreslit nedá.
     */
    const maskaVlasu = vrstvy.__test.maskaProKus('vlasy', velka);
    let otevrenych = 0;
    let naPostave = 0;
    let uKraje = 0;
    for (let y = 0; y < VV; y++) {
      for (let x = 0; x < SV; x++) {
        const i = (y * SV + x) * 4;
        if (maskaVlasu.body[i + 3] !== 0) continue;
        otevrenych += 1;
        if (x < 80 || x > SV - 80) uKraje += 1;
        if (velka.body[i + 3] >= 24) naPostave += 1;
      }
    }
    ok('maska pro vlasy otevře hlavu, ne pruh přes celé plátno',
      otevrenych > 0 && uKraje === 0,
      `${otevrenych} otevřených bodů, u kraje plátna ${uKraje}`);
    /* Celý pruh by byl 373 řádků přes celé plátno; otevřená je čtvrtina */
    const celyPruh = (Math.min(VV - 1, pruhVlasu.do) - pruhVlasu.od + 1) * SV;
    ok('  a z pruhu zůstane otevřená jen postava a pás kolem ní',
      otevrenych < celyPruh * 0.35 && naPostave / otevrenych > 0.5,
      `${Math.round(otevrenych / celyPruh * 100)} % pruhu, z toho ${Math.round(naPostave / otevrenych * 100)} % sama postava`);
  }

  /*
   * Obličej. Tohle je ta chyba, kvůli které ve vrstvě se sakem visela
   * celá hlava i s vousy a na krocích oblékání se člověk od kroku ke
   * kroku měnil: pruhy pro kusy jsou zlomky výšky postavy a šest
   * z jedenácti jich sahalo **na hlavu**. Sako začínalo třináct bodů
   * pod temenem, košile čtyřicet, kravata padesát — model tedy měl
   * obličej povolený k překreslení.
   *
   * Přičíst k zlomkům jiný zlomek nejde: hlava je u dospělého sedmina
   * postavy, u dítěte pětina, u kojence ještě víc. Kde končí, se ale
   * dá změřit — od ramen nahoru se postava zužuje do krku.
   */
  {
    const SV = 1024;
    const VV = 1536;
    /* Postava tvaru člověka: hlava, krk, ramena, trup, nohy */
    const clovek = png.novyObraz(SV, VV);
    const bod = (x, y) => {
      if (x < 0 || y < 0 || x >= SV || y >= VV) return;
      const i = (y * SV + x) * 4;
      clovek.body[i] = 206; clovek.body[i + 1] = 170; clovek.body[i + 2] = 140; clovek.body[i + 3] = 255;
    };
    const hlava = { cx: 512, cy: 230, rx: 80, ry: 105 };
    for (let y = hlava.cy - hlava.ry; y <= hlava.cy + hlava.ry; y++) {
      for (let x = hlava.cx - hlava.rx; x <= hlava.cx + hlava.rx; x++) {
        const dx = (x - hlava.cx) / hlava.rx;
        const dy = (y - hlava.cy) / hlava.ry;
        if (dx * dx + dy * dy <= 1) bod(x, y);
      }
    }
    const KRK = { od: 320, do: 375 };
    for (let y = KRK.od; y < KRK.do; y++) for (let x = 472; x < 552; x++) bod(x, y);
    for (let y = KRK.do; y < 430; y++) {
      const sir = 80 + Math.round((y - KRK.do) / 55 * 210);
      for (let x = 512 - sir / 2; x < 512 + sir / 2; x++) bod(Math.round(x), y);
    }
    for (let y = 430; y < 1000; y++) for (let x = 367; x < 657; x++) bod(x, y);
    for (let y = 1000; y < 1460; y++) for (let x = 392; x < 632; x++) bod(x, y);

    const kde = vrstvy.__test.okrajePostavy(clovek);
    ok('krk se na postavě najde měřením, ne odhadem',
      Math.abs(kde.krk - KRK.do) <= 12, `krk na ${kde.krk}, ve skutečnosti ${KRK.do}`);

    const naHlave = [];
    const bezKrku = { x: kde.x, y: kde.y, w: kde.w, h: kde.h, podil: kde.podil };
    const drive = [];
    for (const def of zk.ZK_VRSTVY) {
      if (def.typ === 'postava' || def.typ === 'vlasy' || def.typ === 'fousy') continue;
      if (vrstvy.__test.pruhKusu(def.typ, kde, VV).od < kde.krk) naHlave.push(def.typ);
      if (vrstvy.__test.pruhKusu(def.typ, bezKrku, VV).od < kde.krk) drive.push(def.typ);
    }
    ok('  (dřív sahalo na hlavu šest kusů z jedenácti)',
      drive.length >= 5, drive.join(' · '));
    ok('žádný kus oblečení nezačíná nad krkem',
      naHlave.length === 0, naHlave.length ? naHlave.join(' · ') : 'ani jeden');
    ok('  ale vlasy a vousy na hlavu dosáhnou dál',
      vrstvy.__test.pruhKusu('vlasy', kde, VV).od < kde.krk
      && vrstvy.__test.pruhKusu('fousy', kde, VV).od < kde.krk,
      `vlasy od ${vrstvy.__test.pruhKusu('vlasy', kde, VV).od}, krk na ${kde.krk}`);

    /*
     * A celý krok: model obleče sako a **při tom překreslí obličej**.
     * Do vrstvy se sakem obličej patřit nesmí — a hlavně se nesmí
     * změnit ani v kroku, ze kterého se obléká dál.
     */
    const sSakem = { sirka: SV, vyska: VV, body: Uint8Array.from(clovek.body) };
    for (let y = 430; y < 980; y++) {
      for (let x = 367; x < 657; x++) {
        const i = (y * SV + x) * 4;
        if (sSakem.body[i + 3] < 128) continue;
        sSakem.body[i] = 60; sSakem.body[i + 1] = 70; sSakem.body[i + 2] = 110;
      }
    }
    /* Překreslený obličej: jiná pleť, jiný člověk */
    for (let y = kde.y; y < KRK.od; y++) {
      for (let x = 0; x < SV; x++) {
        const i = (y * SV + x) * 4;
        if (sSakem.body[i + 3] < 128) continue;
        sSakem.body[i] = 150; sSakem.body[i + 1] = 110; sSakem.body[i + 2] = 92;
      }
    }
    const VP = { id: 'dospely-bezny', vek: 'dospely', telo: 'bezny', vyskaCm: 180, sirka: SV, vyska: VV };
    const vrstvaSaka = vrstvy.__test.vrstvaZKroku(VP, 'sako', 'jednoradove', clovek, sSakem, 'zkouška');
    ok('překreslený obličej se do vrstvy se sakem nedostane',
      vrstvaSaka.vrstva.okraje.y >= kde.krk - 4,
      `vrstva začíná na ${vrstvaSaka.vrstva.okraje.y}, krk je na ${kde.krk}`);
    let hlavaStejna = true;
    for (let y = kde.y; y < KRK.od && hlavaStejna; y++) {
      for (let x = 0; x < SV; x++) {
        const i = (y * SV + x) * 4;
        for (let k = 0; k < 4; k++) {
          if (vrstvaSaka.krok.body[i + k] !== clovek.body[i + k]) { hlavaStejna = false; break; }
        }
        if (!hlavaStejna) break;
      }
    }
    ok('  a v kroku pro další oblékání zůstal původní obličej, bod po bodu', hlavaStejna);

    /*
     * Vlasy se do řady kroků nezapisují vůbec. Dřív se na nich
     * oblékalo dál, takže jediný nepovedený účes otrávil všechno po
     * sobě — na krocích měla postava od vlasů dál černou hlavu.
     */
    ok('na vlasech ani vousech se dál neobléká',
      !vrstvy.__test.zapisujeKrok('vlasy', 'kratke')
      && !vrstvy.__test.zapisujeKrok('fousy', 'plnovous')
      && vrstvy.__test.zapisujeKrok('kosile', 'klasicka'));
  }


  /*
   * Základ se kontroluje dřív, než se na něj začne oblékat. Je to ta
   * nejlevnější kontrola v kabině: postava stojí jeden obrázek, oblečení
   * dvaadvacet.
   */
  const zkontroluj = vrstvy.__test.zkontrolujPostavu;
  check('postava, co se vejde celá, projde',
    zkontroluj({ x: 30, y: 10, w: 60, h: 160, podil: 0.3 }, VYSKA), '');
  ok('useknutá nahoře neprojde',
    /nahoře/.test(zkontroluj({ x: 30, y: 0, w: 60, h: 170, podil: 0.3 }, VYSKA)));
  ok('useknutá dole taky ne',
    /dole/.test(zkontroluj({ x: 30, y: 8, w: 60, h: 172, podil: 0.3 }, VYSKA)));
  ok('prázdné plátno se pozná',
    /prázdné plátno/.test(zkontroluj({ x: 0, y: 0, w: 2, h: 2, podil: 0.001 }, VYSKA)));
  ok('detail místo celé figury taky',
    /detail/.test(zkontroluj({ x: 2, y: 10, w: 116, h: 160, podil: 0.8 }, VYSKA)));
  ok('a moc malá postava se nepustí dál',
    /moc malá/.test(zkontroluj({ x: 40, y: 40, w: 30, h: 60, podil: 0.12 }, VYSKA)));

  /* 3. Skutečné přemalování uvnitř pruhu se ale zatajit nesmí */
  const prekreslene = { sirka: SIRKA, vyska: VYSKA, body: Uint8Array.from(sKravatou.body) };
  for (let y = 40; y < 110; y++) {
    for (let x = 36; x < 84; x++) {
      const i = (y * SIRKA + x) * 4;
      if (prekreslene.body[i + 3] < 128) continue;
      prekreslene.body[i] = 30; prekreslene.body[i + 1] = 90; prekreslene.body[i + 2] = 200;
    }
  }
  const poPrekresleni = vrstvy.__test.vrstvaZKroku(P, 'kravata', 'kravata', pred, prekreslene, 'zkouška');
  /*
   * Velká vrstva se **neza­kazuje, upozorňuje se na ni**. Procento je
   * odhad podle zástupné kresby a na skutečné fotce zahodilo i vrstvu,
   * která byla v pořádku (krátké vlasy: 11 % proti mezi 10 %).
   * Rozhodnout má člověk u obrázku, ne číslo.
   */
  ok('na nezvykle velkou vrstvu se upozorní, ale použít jde',
    poPrekresleni.vrstva.stav === 'hotovo' && /okolí/.test(poPrekresleni.vrstva.potiz),
    poPrekresleni.vrstva.potiz);
  ok('  a obrázek u ní zůstane, ať je vidět, co vyšlo',
    !!poPrekresleni.vrstva.soubor && fs.existsSync(poPrekresleni.vrstva.soubor));

  /*
   * Co se zakazuje, jsou tři věci — a všechny jsou o tom, jestli kusy na
   * sebe pasují, ne o velikosti.
   */
  const zk2 = zk.zkontrolujVrstvu;
  const postavaMery = { y: 10, h: 160 };
  check('nic se nezměnilo → nedá se použít',
    !!zk2('kravata', { okraje: { x: 0, y: 0, w: 0, h: 0 }, podil: 0, naPostave: 0 }, postavaMery).potiz, true);
  ok('vrstva vedle postavy → nedá se použít',
    /vedle ní/.test(zk2('kravata',
      { okraje: { x: 0, y: 20, w: 20, h: 20 }, podil: 0.05, naPostave: 0.3 }, postavaMery).potiz));
  ok('vrstva přes celou postavu → nedá se použít',
    /celý obrázek/.test(zk2('kravata',
      { okraje: { x: 0, y: 0, w: 100, h: 160 }, podil: 0.95, naPostave: 1 }, postavaMery).potiz));
  const vPoradku = zk2('kravata',
    { okraje: { x: 50, y: 40, w: 10, h: 40 }, podil: 0.05, naPostave: 0.98 }, postavaMery);
  check('a co leží na postavě a není celá, projde bez řečí', [vPoradku.potiz, vPoradku.varovani], ['', '']);
  const velke = zk2('vlasy',
    { okraje: { x: 30, y: 10, w: 40, h: 30 }, podil: 0.19, naPostave: 0.95 }, postavaMery);
  ok('velké vlasy jsou upozornění, ne zákaz', !velke.potiz && !!velke.varovani, velke.varovani);
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
  /* Základ je šedý — žádný kus oblečení se v šedé nekreslí, takže se
     rozdíl dvou kroků neztratí */
  ok('základ je šedý, aby se rozdíl vrstvy neztratil',
    /mid-grey/.test(zadani.__test.zadaniPostavy('dospely', 'bezny')));

  setSetting('zkZadani:postava:dospely:bezny',
    'Full-body photo of a man wearing only a white undershirt and light grey briefs.');
  ok('starší uložené znění se spodním prádlem se už nepoužije',
    !/briefs/i.test(zadani.zadaniPostavyTed('dospely', 'bezny')));
  setSetting('zkZadani:postava:dospely:bezny', 'Vlastní zadání bez problému.');
  check('ale vlastní zadání, které projde, zůstane',
    zadani.zadaniPostavyTed('dospely', 'bezny'), 'Vlastní zadání bez problému.');
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

console.log(failed ? `\n✗ ${failed} chyb` : '\n✓ zkušební kabina sedí');
process.exit(failed ? 1 : 0);
