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

console.log(failed ? `\n✗ ${failed} chyb` : '\n✓ zkušební kabina sedí');
process.exit(failed ? 1 : 0);
