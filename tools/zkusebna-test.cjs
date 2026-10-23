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
  /* Nejdřív se ukáže, že bez opravy je to opravdu průšvih — jinak by
     zkouška níž mohla projít i s vypnutým srovnáním tónu */
  const bezOpravy = px.okraje(px.uklid(px.rozdil(pred, svetlejsi), SIRKA, VYSKA), SIRKA, VYSKA);
  ok('  bez srovnání tónu by vrstva spolkla celou postavu',
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
  ok('překreslený trup se pozná a vrstva se neuloží',
    poPrekresleni.vrstva.stav === 'nesedi' && !poPrekresleni.vrstva.soubor,
    poPrekresleni.vrstva.potiz);
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
  check('cesta produktu si nechá slug z e-shopu',
    stranky.cestaProduktu({ kod: 'KSA1', url: 'https://www.quentino.cz/p/detske-ksandy-modre' }),
    '/p/detske-ksandy-modre');
}

console.log(failed ? `\n✗ ${failed} chyb` : '\n✓ zkušební kabina sedí');
process.exit(failed ? 1 : 0);
