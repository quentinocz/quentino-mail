import fs from 'fs';
import { getSetting, setSetting } from '../db';
import {
  ZkPostava, ZkSablona, ZkVrstva, ZkVrstvaTyp, ZK_PODKLAD_HEX, ZK_VRSTVY, sablonaPro
} from '../../shared/zkusebna';
import { Obraz, nacti, novyObraz, uloz } from './png';
import * as px from './pixely';
import * as store from './store';

/**
 * Šablony zboží — kravaty, motýlky, kšandy a kapesníčky bez modelu.
 *
 * ## Proč ne od modelu
 *
 * Patrik (23. 11.): vrstvy na sebe nepasovaly. Model vrací pokaždé
 * **nový obrázek**, ne tentýž s kravatou navíc — a z toho, co přidal,
 * se nedá spolehlivě vystřihnout jen ten kus. K tomu rozdíly, na kterých
 * u doplňků záleží nejvíc, model nedodrží vůbec: kravata 6 proti 8 cm,
 * kšandy 2,5 proti 3,5 cm, dětský motýlek proti pánskému.
 *
 * ## Jak to vzniká místo toho
 *
 * Postava se kreslí jednou, rovnou v košili, kalhotách a botách. Z toho
 * se změří **body**: střed límce, horní hrana kalhot, ramena a kapsa
 * saka. Na ně se pak položí tvar doplňku v jeho skutečných rozměrech
 * (body na centimetr se berou z výšky postavy) a k tvaru se spočítá
 * mapa světla — záhyby, uzel, oblost látky. Na e-shopu se pod mapu
 * podloží kousek látky z fotky výrobku, takže zákazník vidí **ten vzor,
 * který kupuje**, ne vymyšlený.
 *
 * Nic se neplatí, nic neujede a šablona se dá kdykoli překreslit —
 * třeba když se body posunou o kus vedle.
 *
 * ## Proč body jdou opravit rukou
 *
 * Měření je odhad z obrázku: límec se pozná jako nejvyšší bod košile
 * uprostřed, pas jako horní hrana kalhot. U neobvyklé postavy (ruce
 * před tělem, sako přes košili) to může ujet o centimetr. Proto se body
 * dají v okně posunout tažením a uloží se k postavě.
 */

export interface Bod { x: number; y: number }

export interface Kotvy {
  /** Střed límce nahoře — odtud visí kravata a sedí motýlek. */
  limec: Bod;
  /** Horní hrana kalhot pod límcem (řádek). */
  pas: number;
  /** Kde kšandy začínají na ramenou — vlevo a vpravo z pohledu diváka. */
  ramenoL: Bod;
  ramenoR: Bod;
  /** Kde se kšandy chytají kalhot. */
  sponaL: Bod;
  sponaR: Bod;
  /** Horní hrana náprsní kapsy saka, uprostřed. Kapsa je u člověka vlevo, na obrázku vpravo. */
  kapsa: Bod;
  /** Bodů na centimetr. */
  naCm: number;
  /**
   * Šířka trupu u ramen v bodech. Podle ní se zmenší kapesníček:
   * kojenec má kapsu saka velkou jako pánský kapesníček sám
   * (Patrik, 23. 11.: „kapesníček vůbec nepasuje do kapsy u kojence").
   */
  ramena?: number;
  /** Sklon horní hrany kapsy (dy/dx) — kapesníček na ní sedí. */
  kapsaSklon?: number;
  /** Šířka kapsy v bodech, když se našla na saku. */
  kapsaSirka?: number;
}

/** Ruční oprava bodů — díly plátna, aby nezáleželo na jeho velikosti. */
export interface KotvyRucne {
  limec?: [number, number];
  pas?: number;
  kapsa?: [number, number];
  /** Vodorovná vzdálenost ramenního bodu od středu límce. */
  ramena?: number;
  /** Vodorovná vzdálenost spony od středu límce. */
  spony?: number;
}

/* ------------------------------------------------------------- měření */

export function maskaVrstvy(postavaId: string, typ: ZkVrstvaTyp, varianta: string): Uint8Array | null {
  const vrstva = store.vrstvy(postavaId).find(one => one.typ === typ && one.varianta === varianta
    && one.stav !== 'nesedi' && one.soubor && fs.existsSync(one.soubor));
  if (!vrstva) return null;
  const obraz = nacti(fs.readFileSync(vrstva.soubor));
  const out = new Uint8Array(obraz.sirka * obraz.vyska);
  for (let i = 0; i < out.length; i++) out[i] = obraz.body[i * 4 + 3] > 128 ? 255 : 0;
  return out;
}

/** Nejvyšší bod masky ve sloupcích kolem `x` (± půl šířky). */
function vrchol(maska: Uint8Array, sirka: number, vyska: number, x: number, pul: number, odY = 0): number {
  for (let y = Math.max(0, odY); y < vyska; y++) {
    for (let xx = Math.max(0, Math.round(x - pul)); xx <= Math.min(sirka - 1, Math.round(x + pul)); xx++) {
      if (maska[y * sirka + xx]) return y;
    }
  }
  return -1;
}

/** Levý a pravý okraj masky na řádku. */
function radek(maska: Uint8Array, sirka: number, y: number): { od: number; do: number } | null {
  let od = -1;
  let doKonce = -1;
  for (let x = 0; x < sirka; x++) {
    if (!maska[y * sirka + x]) continue;
    if (od < 0) od = x;
    doKonce = x;
  }
  return od < 0 ? null : { od, do: doKonce };
}

/**
 * Změří body na postavě.
 *
 * Košile a kalhoty jsou vrstvy vyříznuté z téhož obrázku jako postava,
 * takže leží přesně na ní. Když chybí (stará postava, zástupná kresba
 * bez nich), počítá se z obrysu postavy a poměrů těla.
 */
export function zmerKotvy(
  p: Pick<ZkPostava, 'vyskaCm'>,
  postava: Obraz,
  kosile: Uint8Array | null,
  kalhoty: Uint8Array | null,
  rucne: KotvyRucne = {}
): Kotvy {
  const { sirka, vyska } = postava;
  const silueta = new Uint8Array(sirka * vyska);
  for (let i = 0; i < silueta.length; i++) silueta[i] = postava.body[i * 4 + 3] > 24 ? 255 : 0;
  const kde = px.okraje(silueta, sirka, vyska);
  const naCm = kde.h > 0 ? kde.h / Math.max(40, p.vyskaCm) : vyska / 200;
  const trup = kosile ?? silueta;

  /* Střed: těžiště košile v horních třech centimetrech, jinak obrys */
  const vrsekKosile = kosile ? vrchol(kosile, sirka, vyska, kde.x + kde.w / 2, kde.w / 2) : -1;
  let stred = kde.x + kde.w / 2;
  if (kosile && vrsekKosile >= 0) {
    let soucet = 0;
    let kusu = 0;
    for (let y = vrsekKosile; y < Math.min(vyska, vrsekKosile + 3 * naCm); y++) {
      for (let x = 0; x < sirka; x++) if (kosile[y * sirka + x]) { soucet += x; kusu += 1; }
    }
    if (kusu) stred = soucet / kusu;
  }

  /* Límec: nejvyšší bod košile uprostřed (± 1 cm) */
  let limecY = kosile ? vrchol(kosile, sirka, vyska, stred, naCm) : -1;
  if (limecY < 0) limecY = Math.round(kde.y + kde.h * 0.16);

  /* Pas: horní hrana kalhot uprostřed (± 2 cm), pod límcem */
  let pas = kalhoty ? vrchol(kalhoty, sirka, vyska, stred, 2 * naCm, limecY + 8 * naCm) : -1;
  if (pas < 0 || pas - limecY < 10 * naCm) pas = Math.round(limecY + kde.h * 0.27);

  const delkaTrupu = pas - limecY;
  /* Šířka ramen: kousek pod límcem, kde je trup nejširší nahoře */
  const radekRamen = radek(trup, sirka, Math.round(limecY + delkaTrupu * 0.14))
    ?? { od: Math.round(stred - 20 * naCm), do: Math.round(stred + 20 * naCm) };
  const ramena = Math.max(10 * naCm, radekRamen.do - radekRamen.od);
  /* Šířka v pase: horní řádek kalhot o centimetr níž */
  const radekPasu = radek(kalhoty ?? silueta, sirka, Math.min(vyska - 1, Math.round(pas + naCm)))
    ?? { od: Math.round(stred - ramena * 0.4), do: Math.round(stred + ramena * 0.4) };
  const pasSirka = Math.max(8 * naCm, radekPasu.do - radekPasu.od);

  const limec: Bod = rucne.limec
    ? { x: rucne.limec[0] * sirka, y: rucne.limec[1] * vyska }
    : { x: stred, y: limecY };
  const pasY = rucne.pas !== undefined ? rucne.pas * vyska : pas;
  const delka = pasY - limec.y;

  /*
   * Kšandy začínají na rameni zhruba v půlce mezi krkem a koncem ramene
   * a k pasu se mírně sbíhají. Horní bod se bere z obrysu košile v tom
   * sloupci — rameno se svažuje, a kšanda, která začíná nad ním, by
   * visela ve vzduchu.
   */
  const dRamena = rucne.ramena !== undefined ? rucne.ramena * sirka : ramena * 0.24;
  const dSpony = rucne.spony !== undefined ? rucne.spony * sirka : pasSirka * 0.27;
  const vrsekRamene = (x: number) => {
    const y = vrchol(trup, sirka, vyska, x, 1, Math.round(limec.y - 6 * naCm));
    return y >= 0 && y < limec.y + delka * 0.3 ? y + 0.3 * naCm : limec.y + delka * 0.05;
  };
  const ramenoL = { x: limec.x - dRamena, y: vrsekRamene(limec.x - dRamena) };
  const ramenoR = { x: limec.x + dRamena, y: vrsekRamene(limec.x + dRamena) };
  const sponaL = { x: limec.x - dSpony, y: pasY + 0.8 * naCm };
  const sponaR = { x: limec.x + dSpony, y: pasY + 0.8 * naCm };

  const kapsa: Bod = rucne.kapsa
    ? { x: rucne.kapsa[0] * sirka, y: rucne.kapsa[1] * vyska }
    : { x: limec.x + ramena * 0.235, y: limec.y + delka * 0.33 };

  return { limec, pas: pasY, ramenoL, ramenoR, sponaL, sponaR, kapsa, naCm, ramena, kapsaSklon: -0.12 };
}

export function rucneKotvy(postavaId: string): KotvyRucne {
  try {
    const ulozene = JSON.parse(getSetting(`zkKotvy:${postavaId}`, '{}') || '{}');
    return ulozene && typeof ulozene === 'object' ? ulozene : {};
  } catch { return {}; }
}

export function ulozRucneKotvy(postavaId: string, rucne: KotvyRucne | null): void {
  setSetting(`zkKotvy:${postavaId}`, rucne ? JSON.stringify(rucne) : '');
}

/** Body postavy z uložených vrstev. Null, dokud postava není. */
/**
 * Náprsní kapsa na saku — horní hrana lištové kapsy.
 *
 * Revize (24. 11.): kapesníček seděl vedle kapsy (u dospělého o tři
 * centimetry vlevo, u kojence o pět níž), protože místo bylo jen odhad
 * z ramen. Lištová kapsa je na mapě světla saka vidět jako krátká skoro
 * vodorovná hrana: hledá se čára, podél které je největší svislý rozdíl
 * jasu, mírně stoupající doprava. Ze dvou hran lišty se bere horní.
 */
export function najdiKapsu(sako: Obraz, odhad: Bod, naCm: number): { kapsa: Bod; sklon: number; sirka: number } | null {
  const { sirka: W, vyska: H, body } = sako;
  const c = naCm;
  const jas = (x: number, y: number) => {
    const i = (y * W + x) * 4;
    return body[i + 3] > 128 ? body[i] : -1;
  };
  const gy = (x: number, y: number) => {
    const a = jas(x, y - 1); const b = jas(x, y + 1);
    return a < 0 || b < 0 ? 0 : Math.abs(b - a);
  };
  const pul = Math.round(3.2 * c);
  const x0Od = Math.round(odhad.x - 2 * c); const x0Do = Math.round(odhad.x + 6 * c);
  const yOd = Math.round(odhad.y - 6 * c); const yDo = Math.round(odhad.y + 5 * c);
  const krok = Math.max(1, Math.round(c / 4));
  let nej = { skore: 0, x: 0, y: 0, s: 0 };
  const skore = (x0: number, y0: number, s: number, polovina = pul) => {
    let sum = 0;
    for (let dx = -polovina; dx <= polovina; dx += 1) {
      const x = x0 + dx; const y = Math.round(y0 + s * dx);
      if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) return 0;
      sum += gy(x, y);
    }
    return sum;
  };
  for (const s of [-0.3, -0.24, -0.18, -0.12, -0.06, 0, 0.06]) {
    for (let y0 = yOd; y0 <= yDo; y0 += 1) {
      for (let x0 = x0Od; x0 <= x0Do; x0 += krok) {
        const v = skore(x0, y0, s);
        if (v > nej.skore) nej = { skore: v, x: x0, y: y0, s };
      }
    }
  }
  if (!nej.skore) return null;
  /*
   * Lišta má dvě rovnoběžné hrany. Ke nejsilnější se hledá druhá — nad
   * i pod ní — a bere se horní (na ní kapesníček sedí). Konce lišty jsou
   * tam, kde jsou vidět **obě** hrany: jedna sama bývá klopa nebo šev.
   */
  let druha = { d: 0, skore: 0 };
  for (let d = Math.round(0.6 * c); d <= Math.round(2.2 * c); d++) {
    for (const smer of [-1, 1]) {
      const v = skore(nej.x, nej.y + smer * d, nej.s);
      const v1 = skore(nej.x, nej.y + smer * (d - 1), nej.s);
      const v2 = skore(nej.x, nej.y + smer * (d + 1), nej.s);
      if (v >= v1 && v >= v2 && v > druha.skore) druha = { d: smer * d, skore: v };
    }
  }
  const horni = druha.skore > nej.skore * 0.1 ? Math.min(nej.y, nej.y + druha.d) : nej.y;
  const hrana = (x: number, y: number) => {
    let m = 0;
    for (let dy = -1; dy <= 1; dy++) {
      if (x < 1 || y + dy < 1 || x >= W - 1 || y + dy >= H - 1) continue;
      m = Math.max(m, gy(x, y + dy));
    }
    return m;
  };
  const profil: number[] = [];
  const rozsah = Math.round(7 * c);
  for (let dx = -rozsah; dx <= rozsah; dx++) {
    const x = nej.x + dx;
    /* Silnější hrana nese délku lišty; klopa, která přes ni jde šikmo, dá jen krátkou špičku */
    profil.push(hrana(x, Math.round(nej.y + nej.s * dx)));
  }
  /* Vyhladit přes 0,3 cm, ať jeden slabý bod lištu nerozdělí */
  const okno = Math.max(1, Math.round(0.15 * c));
  const hladky = profil.map((_, i) => {
    let sum = 0; let n = 0;
    for (let j = i - okno; j <= i + okno; j++) if (j >= 0 && j < profil.length) { sum += profil[j]; n += 1; }
    return sum / n;
  });
  const maxP = [...hladky].sort((a, b) => b - a)[Math.floor(hladky.length * 0.15)];
  if (maxP <= 0) return null;
  /* Nejdelší souvislý úsek nad prahem */
  const prah = maxP * 0.45;
  let nejUsek = { l: rozsah, r: rozsah, delka: 0 };
  for (let i = 0; i < hladky.length;) {
    if (hladky[i] <= prah) { i += 1; continue; }
    let j = i;
    while (j + 1 < hladky.length && hladky[j + 1] > prah) j += 1;
    if (j - i > nejUsek.delka) nejUsek = { l: i, r: j, delka: j - i };
    i = j + 1;
  }
  const l = nejUsek.l; const r = nejUsek.r;
  nej = { ...nej, y: horni };
  const sirka = (r - l) * Math.hypot(1, nej.s);
  if (sirka < 2 * c || sirka > 16 * c) return null;
  const stred = (l + r) / 2 - rozsah;
  return { kapsa: { x: nej.x + stred, y: nej.y + nej.s * stred }, sklon: nej.s, sirka };
}

export function kotvyPostavy(postavaId: string): { kotvy: Kotvy; postava: Obraz; orez: Uint8Array } | null {
  const p = store.postava(postavaId);
  const zaklad = store.vrstvy(postavaId).find(one => one.typ === 'postava' && one.soubor && fs.existsSync(one.soubor));
  if (!p || !zaklad) return null;
  const postava = nacti(fs.readFileSync(zaklad.soubor));
  const kosile = maskaVrstvy(postavaId, 'kosile', 'klasicka');
  const kalhoty = maskaVrstvy(postavaId, 'kalhoty', 'oblekove');
  const rucne = rucneKotvy(postavaId);
  const kotvy = zmerKotvy(p, postava, kosile, kalhoty, rucne);
  /*
   * Kapsa podle saka. Když ji člověk posunul ručně, platí jeho poloha,
   * ale sklon a šířka kapsy se pořád změří ze saka kolem ní — dřív se po
   * ručním posunu vrátily na odhad a kapesníček změnil tvar (Patrik,
   * 25. 11.: „překreslení není přesné").
   */
  if (rucne.kapsa) {
    const sako = store.vrstvy(postavaId).find(one => one.typ === 'sako' && one.varianta === 'jednoradove'
      && one.soubor && fs.existsSync(one.soubor) && (one.stav === 'hotovo' || one.stav === 'schvaleno'));
    if (sako) {
      try {
        const obraz = nacti(fs.readFileSync(sako.soubor));
        const nalez = obraz.sirka === postava.sirka ? najdiKapsu(obraz, kotvy.kapsa, kotvy.naCm) : null;
        if (nalez && Math.hypot(nalez.kapsa.x - kotvy.kapsa.x, nalez.kapsa.y - kotvy.kapsa.y) < 3 * kotvy.naCm) {
          kotvy.kapsaSklon = nalez.sklon; kotvy.kapsaSirka = nalez.sirka;
        }
      } catch { /* bez saka zůstane odhad */ }
    }
  } else {
    const sako = store.vrstvy(postavaId).find(one => one.typ === 'sako' && one.varianta === 'jednoradove'
      && one.soubor && fs.existsSync(one.soubor) && (one.stav === 'hotovo' || one.stav === 'schvaleno'));
    if (sako) {
      try {
        const obraz = nacti(fs.readFileSync(sako.soubor));
        const nalez = obraz.sirka === postava.sirka ? najdiKapsu(obraz, kotvy.kapsa, kotvy.naCm) : null;
        if (nalez) { kotvy.kapsa = nalez.kapsa; kotvy.kapsaSklon = nalez.sklon; kotvy.kapsaSirka = nalez.sirka; }
      } catch { /* bez saka zůstane odhad */ }
    }
  }
  return { kotvy, postava, orez: orezKsand(postava, kosile, kalhoty) };
}

/**
 * Kudy smí vést kšandy: po košili a kalhotách.
 *
 * Obrys celé postavy nestačí — u kojence je hlava široká skoro jako
 * ramena a pásek, který začíná kus nad ramenem, by vyšel na krku.
 */
function orezKsand(postava: Obraz, kosile: Uint8Array | null, kalhoty: Uint8Array | null): Uint8Array {
  const { sirka, vyska } = postava;
  const out = new Uint8Array(sirka * vyska);
  if (!kosile) {
    for (let i = 0; i < out.length; i++) out[i] = postava.body[i * 4 + 3] > 24 ? 255 : 0;
    return px.rozsir(out, sirka, vyska, 1);
  }
  for (let i = 0; i < out.length; i++) out[i] = kosile[i] || (kalhoty && kalhoty[i]) ? 255 : 0;
  return px.rozsir(out, sirka, vyska, 2);
}

/* -------------------------------------------------------------- kresba */

/** Šedá mapy světla, nebo skutečná barva (kov). */
type Stin = (x: number, y: number) => number | [number, number, number];

/** Je bod uvnitř mnohoúhelníku? (sudý počet průsečíků = venku) */
function uvnitr(poly: Bod[], x: number, y: number): boolean {
  let ano = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) ano = !ano;
  }
  return ano;
}

/**
 * Vyplní tvar mapou světla.
 *
 * Okraj se vyhlazuje podvzorkováním 4 × 4 bodů: tvar bez vyhlazení má
 * na šikmé hraně schody, které po podložení vzorku vypadají jako
 * vystřižené nůžkami na papír.
 */
function vypln(obraz: Obraz, poly: Bod[], stin: Stin, orez?: Uint8Array): void {
  let x1 = Infinity; let y1 = Infinity; let x2 = -Infinity; let y2 = -Infinity;
  for (const b of poly) { x1 = Math.min(x1, b.x); y1 = Math.min(y1, b.y); x2 = Math.max(x2, b.x); y2 = Math.max(y2, b.y); }
  const od = { x: Math.max(0, Math.floor(x1)), y: Math.max(0, Math.floor(y1)) };
  const doK = { x: Math.min(obraz.sirka - 1, Math.ceil(x2)), y: Math.min(obraz.vyska - 1, Math.ceil(y2)) };
  const N = 4;
  for (let y = od.y; y <= doK.y; y++) {
    for (let x = od.x; x <= doK.x; x++) {
      const i = y * obraz.sirka + x;
      if (orez && !orez[i]) continue;
      let pokryti = 0;
      for (let sy = 0; sy < N; sy++) {
        for (let sx = 0; sx < N; sx++) {
          if (uvnitr(poly, x + (sx + 0.5) / N, y + (sy + 0.5) / N)) pokryti += 1;
        }
      }
      if (!pokryti) continue;
      const a = pokryti / (N * N);
      const hodnota = stin(x + 0.5, y + 0.5);
      const rgb = typeof hodnota === 'number' ? [hodnota, hodnota, hodnota] : hodnota;
      const k = i * 4;
      const puvA = obraz.body[k + 3] / 255;
      const noveA = a + puvA * (1 - a);
      for (let j = 0; j < 3; j++) {
        const s = Math.max(0, Math.min(255, rgb[j]));
        obraz.body[k + j] = Math.round(noveA > 0 ? (s * a + obraz.body[k + j] * puvA * (1 - a)) / noveA : s);
      }
      obraz.body[k + 3] = Math.round(noveA * 255);
    }
  }
}

const zvon = (v: number, sirka: number) => Math.exp(-((v / sirka) ** 2));

/**
 * Uzel pod límec. Revize (24. 11.): uzel kravaty seděl **pod** zapnutým
 * límcem jako nálepka, cípy límce byly pod ním. Ve skutečnosti uzel
 * vychází z V mezi cípy a cípy ho po stranách překrývají. Límec postavy
 * je zapnutý (bez kravaty), takže V začíná ve středu límce a rozevírá
 * se dolů zhruba se sklonem cípů — co je nad touhle čarou, schová se
 * pod límec, a těsně pod ní padá na uzel stín cípu.
 */
function podLimec(obraz: Obraz, k: Kotvy, od: Bod, doK: Bod): void {
  const c = k.naCm;
  const sklon = 1.25;
  const x0 = Math.max(0, Math.floor(od.x)); const x1 = Math.min(obraz.sirka - 1, Math.ceil(doK.x));
  const y0 = Math.max(0, Math.floor(od.y)); const y1 = Math.min(obraz.vyska - 1, Math.ceil(doK.y));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = (y * obraz.sirka + x) * 4;
      if (!obraz.body[i + 3]) continue;
      const cara = k.limec.y + Math.abs(x + 0.5 - k.limec.x) / sklon + 0.12 * c;
      const pod = y + 0.5 - cara;
      if (pod < -0.6) { obraz.body[i + 3] = 0; continue; }
      if (pod < 0.6) {
        /* Hrana pod cípem: vyhlazená, ne schod */
        obraz.body[i + 3] = Math.round(obraz.body[i + 3] * ((pod + 0.6) / 1.2));
      }
      const stin = pod / (0.45 * c);
      if (stin < 1) {
        const ubrat = 30 * (1 - Math.max(0, stin));
        for (let j = 0; j < 3; j++) obraz.body[i + j] = Math.max(0, obraz.body[i + j] - ubrat);
      }
    }
  }
}
const omez = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/**
 * Kravata: uzel a list, který se k pasu rozšiřuje do špičky.
 *
 * Uzel je u úzké kravaty menší — čtyřka z pětky má kolem tří
 * centimetrů, z devítky skoro pět. Špička končí u horní hrany kalhot,
 * jak se kravata správně nosí, a pro dítě platí totéž.
 */
function kravata(obraz: Obraz, k: Kotvy, s: ZkSablona, pletena: boolean): void {
  const c = k.naCm;
  const cx = k.limec.x;
  const W = s.sirkaCm * c;
  const kt = (pletena ? 3.2 : omez(0.42 * s.sirkaCm + 1.2, 3, 5)) * c;
  const kb = kt * 0.6;
  const kh = kt * 1.12;
  /* Uzel začíná pod límcem — jeho horní část schová V mezi cípy (podLimec) */
  const top = k.limec.y - 0.5 * c;
  let spicka = k.pas - 0.5 * c;
  if (spicka - top < 12 * c) spicka = top + 12 * c;
  const y0 = top + kh - 0.4 * c;
  /* Pletená je rovná, jen pod uzlem se na pár centimetrech rozšíří; hladká se rozšiřuje až ke špičce */
  const yW = pletena ? spicka - 0.3 * c : spicka - W * 0.45;

  const pul = (y: number) => {
    if (pletena) {
      const t = omez((y - y0) / (6 * c), 0, 1);
      return kb / 2 * 1.05 + (W / 2 - kb / 2 * 1.05) * (1 - (1 - t) ** 2);
    }
    /*
     * Pod uzlem vychází kravata užší než uzel a rozšiřuje se hned pod
     * ním — dřív se rozšiřovala až u pasu a na hrudi byla úzká čárka,
     * sedmička vypadala jako pětka.
     */
    const t = omez((y - y0) / Math.max(1, yW - y0), 0, 1);
    const zacatek = kb / 2 * 0.92;
    return zacatek + (W / 2 - zacatek) * Math.pow(t, 0.7);
  };

  /* List */
  const list: Bod[] = [];
  const kroku = 28;
  for (let i = 0; i <= kroku; i++) {
    const y = y0 + ((yW - y0) * i) / kroku;
    list.push({ x: cx - pul(y), y });
  }
  if (pletena) {
    /* Pletená kravata končí rovně, jen se zaoblenými rohy */
    list.push({ x: cx - W / 2 + 0.3 * c, y: spicka });
    list.push({ x: cx + W / 2 - 0.3 * c, y: spicka });
  } else {
    list.push({ x: cx, y: spicka });
  }
  for (let i = kroku; i >= 0; i--) {
    const y = y0 + ((yW - y0) * i) / kroku;
    list.push({ x: cx + pul(y), y });
  }
  const delka = spicka - y0;
  vypln(obraz, list, (x, y) => {
    const w = y < yW || pletena ? pul(y) : (W / 2) * Math.max(0.05, (spicka - y) / (spicka - yW));
    const u = omez((x - cx) / Math.max(1, w), -1, 1);
    const t = omez((y - y0) / Math.max(1, delka), 0, 1);
    let v = 128;
    v += 9 * (1 - u * u) - 5;
    if (Math.abs(u) > 0.8) v -= ((Math.abs(u) - 0.8) / 0.2) * 24;
    v += 8 * (1 - t) - 4;
    v += 4 * Math.sin(t * 7 + u * 1.2);
    /* Lesk látky: měkký pruh kousek vlevo od středu, jak dopadá světlo */
    v += 7 * zvon(u + 0.3, 0.35) * (1 - t * 0.5);
    /* Důlek pod uzlem */
    const podUzlem = (y - y0) / (2.4 * c);
    if (podUzlem < 1) v -= 20 * zvon(u, 0.16) * (1 - podUzlem);
    if (pletena) v += 10 * Math.sin((2 * Math.PI * (y - y0)) / (0.38 * c));
    return v;
  });

  /* Uzel přes list */
  /*
   * Uzel má oblé boky a zaoblený spodek, jako skutečný uzel z látky.
   * Rovný lichoběžník vypadal jako vystřižený z papíru.
   */
  const pulkaUzlu = (v0: number) => {
    const zuzeni = kt / 2 + (kb / 2 - kt / 2) * Math.pow(v0, 0.8);
    /* Dole se boky stáčejí ke středu */
    return v0 > 0.82 ? zuzeni * Math.sqrt(Math.max(0, 1 - ((v0 - 0.82) / 0.18) ** 2)) * 0.6 + zuzeni * 0.4 * (1 - (v0 - 0.82) / 0.18) : zuzeni;
  };
  const uzel: Bod[] = [];
  const krokyUzlu = 20;
  for (let i = 0; i <= krokyUzlu; i++) {
    const v0 = i / krokyUzlu;
    uzel.push({ x: cx - pulkaUzlu(v0), y: top + v0 * kh + (i === 0 ? 0.1 * c : 0) });
  }
  for (let i = krokyUzlu; i >= 0; i--) {
    const v0 = i / krokyUzlu;
    uzel.push({ x: cx + pulkaUzlu(v0), y: top + v0 * kh + (i === 0 ? 0.1 * c : 0) });
  }
  vypln(obraz, uzel, (x, y) => {
    const v0 = omez((y - top) / kh, 0, 1);
    const pulka = Math.max(1, pulkaUzlu(v0));
    const u = (x - cx) / pulka;
    let v = 122;
    v -= 14 * zvon(u + 0.55 - v0 * 1.1, 0.2);
    v += 12 * zvon(u - 0.25, 0.3) * (1 - v0);
    if (v0 < 0.18) v -= 24 * (1 - v0 / 0.18);
    if (Math.abs(u) > 0.8) v -= ((Math.abs(u) - 0.8) / 0.2) * 18;
    if (pletena) v += 8 * Math.sin((2 * Math.PI * (y - top)) / (0.38 * c));
    return v;
  });
  podLimec(obraz, k, { x: cx - W, y: top - c }, { x: cx + W, y: top + kh + 2 * c });
}

/** Motýlek: dvě křídla stažená uprostřed a uzlík přes ně. */
function motylek(obraz: Obraz, k: Kotvy, s: ZkSablona): void {
  const c = k.naCm;
  const w = s.sirkaCm * c;
  const h = (s.vyskaCm ?? s.sirkaCm * 0.45) * c;
  const cx = k.limec.x;
  /* Uzlík motýlka je na zapnutém límci, ne pod ním — dřív visel o dva centimetry níž */
  const cy = k.limec.y + h * 0.2;
  const A = w / 2;
  const hh = h / 2;
  const uz = Math.max(0.55 * c, w * 0.08);
  const p = h * 0.2;
  const ease = (t: number) => Math.pow(Math.sin((t * Math.PI) / 2), 0.8);

  for (const strana of [-1, 1]) {
    const kridlo: Bod[] = [];
    const kroku = 18;
    for (let i = 0; i <= kroku; i++) {
      const t = i / kroku;
      kridlo.push({ x: cx + strana * (uz + (A - uz) * t), y: cy - (p + (hh - p) * ease(t)) });
    }
    for (let i = 1; i < kroku; i++) {
      const sv = i / kroku;
      kridlo.push({ x: cx + strana * (A - 0.06 * w * Math.sin(Math.PI * sv)), y: cy - hh + 2 * hh * sv });
    }
    for (let i = kroku; i >= 0; i--) {
      const t = i / kroku;
      kridlo.push({ x: cx + strana * (uz + (A - uz) * t), y: cy + (p + (hh - p) * ease(t)) });
    }
    vypln(obraz, kridlo, (x, y) => {
      const t = omez((Math.abs(x - cx) - uz) / Math.max(1, A - uz), 0, 1);
      const okraj = p + (hh - p) * ease(t);
      const q = omez((y - cy) / Math.max(1, okraj), -1, 1);
      let v = 128;
      v += 12 * Math.cos(q * Math.PI * 2) * Math.pow(1 - t, 1.5);
      v += 8 * (1 - q * q) * t;
      if (Math.abs(q) > 0.85) v -= ((Math.abs(q) - 0.85) / 0.15) * 18;
      if (t < 0.15) v -= 16 * (1 - t / 0.15);
      if (t > 0.93) v -= ((t - 0.93) / 0.07) * 14;
      return v;
    });
  }
  const uh = p * 1.35;
  const r = Math.min(uz * 0.4, uh * 0.4);
  const uzlik: Bod[] = [
    { x: cx - uz * 1.15 + r, y: cy - uh }, { x: cx + uz * 1.15 - r, y: cy - uh },
    { x: cx + uz * 1.15, y: cy - uh + r }, { x: cx + uz * 1.15, y: cy + uh - r },
    { x: cx + uz * 1.15 - r, y: cy + uh }, { x: cx - uz * 1.15 + r, y: cy + uh },
    { x: cx - uz * 1.15, y: cy + uh - r }, { x: cx - uz * 1.15, y: cy - uh + r }
  ];
  vypln(obraz, uzlik, (x, y) => {
    const u = (x - cx) / Math.max(1, uz * 1.15);
    const q = (y - cy) / Math.max(1, uh);
    let v = 120 + 12 * (1 - u * u);
    v -= 7 * Math.cos(u * Math.PI * 3) * 0.5;
    if (Math.abs(q) > 0.75) v -= ((Math.abs(q) - 0.75) / 0.25) * 16;
    return v;
  });
}

/**
 * Regata: svatební kravata s nabraným uzlem a širokým řaseným listem.
 *
 * Patrik (23. 11.): „regata se vykresluje úplně nesmyslně". Dřív to byl
 * nafouklý ovál přes celý límec. Skutečná regata (fotky v kategorii
 * Regaty) má pod límcem **nabraný uzel** — zhruba 5 × 4 cm s vodorovnými
 * sklady — a pod ním list, který se rozšiřuje do 9–10 cm, je podélně
 * řasený (sklady se od uzlu rozbíhají jako vějíř) a končí špičkou
 * kousek nad půlkou hrudi.
 */
function regata(obraz: Obraz, k: Kotvy, s: ZkSablona): void {
  const c = k.naCm;
  const W = s.sirkaCm * c;
  const cx = k.limec.x;
  const top = k.limec.y - 0.4 * c;
  /* Uzel: šířka podle listu, výška kolem 4 cm (u dětí přes délku trupu menší) */
  const trup = Math.max(10 * c, k.pas - k.limec.y);
  const kw = Math.min(W * 0.56, trup * 0.16);
  const kh = Math.min(4.2 * c, trup * 0.1);
  const delka = Math.min((s.vyskaCm ?? 22) * c, trup * 0.62);
  const y0 = top + kh * 0.78;
  const spicka = top + delka;
  const ySir = y0 + (spicka - y0) * 0.8;
  const Wl = Math.min(W, trup * 0.3);

  const pul = (y: number) => {
    if (y <= ySir) {
      const t = omez((y - y0) / Math.max(1, ySir - y0), 0, 1);
      return kw * 0.42 + (Wl / 2 - kw * 0.42) * Math.pow(t, 0.75);
    }
    return (Wl / 2) * Math.max(0, (spicka - y) / Math.max(1, spicka - ySir));
  };
  const list: Bod[] = [];
  const kroku = 36;
  for (let i = 0; i <= kroku; i++) {
    const y = y0 + ((ySir - y0) * i) / kroku;
    list.push({ x: cx - pul(y), y });
  }
  list.push({ x: cx, y: spicka });
  for (let i = kroku; i >= 0; i--) {
    const y = y0 + ((ySir - y0) * i) / kroku;
    list.push({ x: cx + pul(y), y });
  }
  /* Kolik skladů má list: u pánské regaty pět, u dětské méně */
  const skladu = Wl > 7 * c ? 5 : 4;
  vypln(obraz, list, (x, y) => {
    const w = Math.max(1, pul(y));
    const u = omez((x - cx) / w, -1, 1);
    const t = omez((y - y0) / Math.max(1, spicka - y0), 0, 1);
    let v = 128;
    /* Sklady se od uzlu rozbíhají: fáze podle u, které se s šířkou samo roztahuje */
    const faze = (u + 1) * 0.5 * skladu * Math.PI * 2;
    v += 15 * Math.sin(faze) * (0.55 + 0.45 * t);
    /* Hřbet skladu je ostřejší než údolí */
    v += 6 * Math.max(0, Math.sin(faze)) ** 3;
    /* Pod uzlem stín a látka se tam stahuje */
    if (t < 0.12) v -= 22 * (1 - t / 0.12);
    if (Math.abs(u) > 0.84) v -= ((Math.abs(u) - 0.84) / 0.16) * 18;
    /* Měkký lesk vlevo, jako u kravaty */
    v += 6 * zvon(u + 0.35, 0.4);
    return v;
  });

  /* Nabraný uzel přes list */
  const pulUzlu = (y: number) => {
    const d = omez((y - top) / kh, 0, 1);
    /* Nahoře pod límcem užší, uprostřed nejširší, dole se stáčí do listu */
    const sirka = kw / 2 * (0.86 + 0.14 * Math.sin(d * Math.PI));
    return d > 0.8 ? sirka * (1 - 0.35 * ((d - 0.8) / 0.2) ** 2) : sirka;
  };
  const uzel: Bod[] = [];
  const krokyUzlu = 24;
  for (let i = 0; i <= krokyUzlu; i++) { const y = top + (kh * i) / krokyUzlu; uzel.push({ x: cx - pulUzlu(y), y }); }
  for (let i = krokyUzlu; i >= 0; i--) { const y = top + (kh * i) / krokyUzlu; uzel.push({ x: cx + pulUzlu(y), y }); }
  vypln(obraz, uzel, (x, y) => {
    const d = omez((y - top) / kh, 0, 1);
    const u = omez((x - cx) / Math.max(1, pulUzlu(y)), -1, 1);
    let v = 126;
    /* Vodorovné sklady nabrané látky — mírně do oblouku */
    const vlny = (d + 0.08 * u * u) * 4.5 * Math.PI * 2;
    v += 14 * Math.sin(vlny);
    v += 8 * (1 - u * u) - 4;
    if (Math.abs(u) > 0.8) v -= ((Math.abs(u) - 0.8) / 0.2) * 22;
    if (d < 0.1) v -= 20 * (1 - d / 0.1);
    if (d > 0.88) v -= 14 * ((d - 0.88) / 0.12);
    return v;
  });
  podLimec(obraz, k, { x: cx - Wl, y: top - c }, { x: cx + Wl, y: top + kh + 2 * c });
}

/** Obdélník podél úsečky — pásek kšand, spona, posuvka. */
function podel(a: Bod, b: Bod, sirka: number): Bod[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.hypot(dx, dy) || 1;
  const nx = (-dy / d) * (sirka / 2);
  const ny = (dx / d) * (sirka / 2);
  return [
    { x: a.x + nx, y: a.y + ny }, { x: b.x + nx, y: b.y + ny },
    { x: b.x - nx, y: b.y - ny }, { x: a.x - nx, y: a.y - ny }
  ];
}

/** Kolmá vzdálenost bodu od osy a poloha podél ní (0 = začátek, 1 = konec). */
function osa(a: Bod, b: Bod, x: number, y: number, sirka: number): { u: number; t: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d2 = dx * dx + dy * dy || 1;
  const t = ((x - a.x) * dx + (y - a.y) * dy) / d2;
  const d = Math.sqrt(d2);
  const kolmo = ((x - a.x) * -dy + (y - a.y) * dx) / d;
  return { u: kolmo / (sirka / 2), t };
}

/**
 * Kov: stříbrný, se světlem shora zleva a tmavším okrajem.
 *
 * `u` je napříč (−1…1), `t` podél (0…1), `lesk` přidá pruh odrazu.
 */
function kov(u: number, t: number, okraj = 0.8, lesk = 1): [number, number, number] {
  let v = 196 + 26 * (1 - u * u) - 18 * t;
  v += 30 * lesk * zvon(u + 0.35, 0.18);
  if (Math.abs(u) > okraj) v -= ((Math.abs(u) - okraj) / (1 - okraj)) * 80;
  return [v - 4, v - 1, v + 4];
}

/** Bod v souřadnicích podél pásku: `podel` cm po směru, `napric` cm do strany. */
function mistni(a: Bod, smer: Bod, podel0: number, napric: number): Bod {
  return { x: a.x + smer.x * podel0 - smer.y * napric, y: a.y + smer.y * podel0 + smer.x * napric };
}

/**
 * Kšandy: dva pásky od ramen k pasu, s posuvkou a sponou.
 *
 * Spona a posuvka jsou **kov a kreslí se zvlášť** (`kovy`) ve skutečné
 * barvě. Patrik (23. 11.): „ty spony vypadají divně" — dřív byly
 * v téže vrstvě jako pásek, takže se obarvily látkou: stříbrná spona
 * vínových kšand vypadala jako kus růžového plastu. Tvar podle fotek
 * kšand na e-shopu: posuvka je rámeček s příčkou, přes který pásek
 * vede, spona je „krokodýl" — oblá příčka, za kterou je pásek
 * přehnutý, žebrovaná destička a zoubky dole.
 *
 * Nahoře se pásek ořízne obrysem postavy: přes rameno jde dozadu a nad
 * ramenem nemá co dělat.
 */
function ksandy(obraz: Obraz, k: Kotvy, s: ZkSablona, silueta: Uint8Array, kovy?: Obraz): void {
  const c = k.naCm;
  const w = s.sirkaCm * c;
  /*
   * Spona podle fotek kšand Quentino: chromové očko, kterým je pásek
   * provlečený, a pod ním tmavý „krokodýl" se zoubky. Revize (24. 11.):
   * dřív byla celá spona stříbrná destička, u kojence větší než jeho
   * knoflíky. Velikost se teď odvíjí jen od šířky pásku.
   */
  const sirkaSpony = w * 0.92 + 0.1 * c;
  const delkaSpony = sirkaSpony * 1.05 + 0.55 * c;
  for (const [nahore, dole] of [[k.ramenoL, k.sponaL], [k.ramenoR, k.sponaR]] as [Bod, Bod][]) {
    const dx = dole.x - nahore.x;
    const dy = dole.y - nahore.y;
    const d = Math.hypot(dx, dy) || 1;
    const smer = { x: dx / d, y: dy / d };
    /* Spona drží kalhoty zubama kousek pod jejich horní hranou */
    const sponaKonec = { x: dole.x + smer.x * 0.5 * c, y: dole.y + smer.y * 0.5 * c };
    const sponaZacatek = { x: sponaKonec.x - smer.x * delkaSpony, y: sponaKonec.y - smer.y * delkaSpony };
    /* Pásek končí přehnutý za příčkou spony */
    const kSpone = { x: sponaZacatek.x + smer.x * 0.45 * c, y: sponaZacatek.y + smer.y * 0.45 * c };
    const zacatek = { x: nahore.x - smer.x * 3 * c, y: nahore.y - smer.y * 3 * c };
    const tPos = 0.36;
    const stredPos = { x: nahore.x + dx * tPos, y: nahore.y + dy * tPos };
    const delkaPasku = Math.hypot(kSpone.x - zacatek.x, kSpone.y - zacatek.y) || 1;
    /* Kde na pásku je posuvka a kde pod ní končí zdvojený kus (přehnutý konec) */
    const tPosNaPasku = Math.hypot(stredPos.x - zacatek.x, stredPos.y - zacatek.y) / delkaPasku;
    const tKonecDvojiteho = tPosNaPasku + (5 * c) / delkaPasku;
    vypln(obraz, podel(zacatek, kSpone, w), (x, y) => {
      const { u, t } = osa(zacatek, kSpone, x, y, w);
      let v = 128 + 5 * (1 - u * u) + 6 * (1 - t) - 3;
      if (Math.abs(u) > 0.78) v -= ((Math.abs(u) - 0.78) / 0.22) * 20;
      /* Prošívaný lem a jemné žebrování pruženky — bez nich byl pásek placka */
      if (Math.abs(Math.abs(u) - 0.7) < 0.05) v += 10;
      v += 3 * Math.sin((2 * Math.PI * x) / Math.max(2, 0.22 * c));
      /* Pod posuvkou je pásek dvojitý — jeho konec je vidět jako jemná hrana se stínem */
      const odKonce = (t - tKonecDvojiteho) * delkaPasku;
      if (t > tPosNaPasku && odKonce < 0) v += 3;
      if (odKonce >= 0 && odKonce < 0.35 * c) v -= 16 * (1 - odKonce / (0.35 * c));
      /* Přehyb kolem příčky spony */
      const kKonci = (1 - t) * delkaPasku;
      if (kKonci < 0.5 * c) v -= 18 * (1 - kKonci / (0.5 * c));
      return v;
    }, silueta);

    const cil = kovy ?? obraz;
    const naSedou = (rgb: [number, number, number]): number | [number, number, number] =>
      kovy ? rgb : 200 + (rgb[1] - 200) * 0.5;

    /* Posuvka: rámeček s příčkou uprostřed, pásek je skrz něj vidět */
    const vyskaPos = Math.max(1.2 * c, 0.42 * w + 0.4 * c);
    const sirkaPos = w + 0.45 * c;
    const tloustka = Math.max(1.2, 0.22 * c);
    const posA = { x: stredPos.x - smer.x * vyskaPos / 2, y: stredPos.y - smer.y * vyskaPos / 2 };
    const rameno = (od: number, doK: number, z: number, na: number) => [
      mistni(posA, smer, od, z), mistni(posA, smer, doK, z), mistni(posA, smer, doK, na), mistni(posA, smer, od, na)
    ];
    /* Každý drát: obdélník a jeho osa (podél pásku, nebo napříč) — světlo podle polohy přes drát */
    const pruty: { poly: Bod[]; podelny: boolean; stred: number }[] = [
      { poly: rameno(0, tloustka, -sirkaPos / 2, sirkaPos / 2), podelny: false, stred: tloustka / 2 },
      { poly: rameno(vyskaPos - tloustka, vyskaPos, -sirkaPos / 2, sirkaPos / 2), podelny: false, stred: vyskaPos - tloustka / 2 },
      { poly: rameno(vyskaPos / 2 - tloustka / 2, vyskaPos / 2 + tloustka / 2, -sirkaPos / 2, sirkaPos / 2), podelny: false, stred: vyskaPos / 2 },
      { poly: rameno(0, vyskaPos, -sirkaPos / 2, -sirkaPos / 2 + tloustka), podelny: true, stred: -sirkaPos / 2 + tloustka / 2 },
      { poly: rameno(0, vyskaPos, sirkaPos / 2 - tloustka, sirkaPos / 2), podelny: true, stred: sirkaPos / 2 - tloustka / 2 }
    ];
    const posB = { x: posA.x + smer.x * vyskaPos, y: posA.y + smer.y * vyskaPos };
    for (const prut of pruty) {
      vypln(cil, prut.poly, (x, y) => {
        const { u, t } = osa(posA, posB, x, y, sirkaPos);
        const kde = prut.podelny ? u * sirkaPos / 2 : t * vyskaPos;
        return naSedou(kov(omez((kde - prut.stred) / (tloustka / 2), -1, 1), 0.2, 0.7, 1.2));
      });
    }

    /* Očko: chromový drátěný rámeček na konci pásku */
    const ocko = 0.55 * c;
    const drat = Math.max(1.2, 0.16 * c);
    const sirkaOcka = w + 0.2 * c;
    const ramenoOcka = (od0: number, do0: number, z: number, na: number) => [
      mistni(sponaZacatek, smer, od0, z), mistni(sponaZacatek, smer, do0, z),
      mistni(sponaZacatek, smer, do0, na), mistni(sponaZacatek, smer, od0, na)
    ];
    const dratyOcka: { poly: Bod[]; podelny: boolean; stred: number }[] = [
      { poly: ramenoOcka(0, drat, -sirkaOcka / 2, sirkaOcka / 2), podelny: false, stred: drat / 2 },
      { poly: ramenoOcka(ocko - drat, ocko, -sirkaOcka / 2, sirkaOcka / 2), podelny: false, stred: ocko - drat / 2 },
      { poly: ramenoOcka(0, ocko, -sirkaOcka / 2, -sirkaOcka / 2 + drat), podelny: true, stred: -sirkaOcka / 2 + drat / 2 },
      { poly: ramenoOcka(0, ocko, sirkaOcka / 2 - drat, sirkaOcka / 2), podelny: true, stred: sirkaOcka / 2 - drat / 2 }
    ];
    const konecOcka = { x: sponaZacatek.x + smer.x * ocko, y: sponaZacatek.y + smer.y * ocko };
    for (const d0 of dratyOcka) {
      vypln(cil, d0.poly, (x, y) => {
        const { u, t } = osa(sponaZacatek, konecOcka, x, y, sirkaOcka);
        const kde = d0.podelny ? u * sirkaOcka / 2 : t * ocko;
        return naSedou(kov(omez((kde - d0.stred) / (drat / 2), -1, 1), 0.2, 0.7, 1.3));
      });
    }

    /* Krokodýl: tmavé tělo s leskem, chromový kloub nahoře, zoubky dole */
    const telOd = ocko - drat * 0.3;
    const delkaTela = delkaSpony - telOd;
    const obrys: Bod[] = [];
    const kroku = 14;
    /* Tělo se ke kalhotám zužuje — krokodýl je nahoře u kloubu nejširší */
    const sirkaTela = (t: number) => sirkaSpony / 2 * (1 - 0.2 * t) * (t > 0.92 ? Math.sqrt(Math.max(0.3, 1 - ((t - 0.92) / 0.08) ** 2)) : 1);
    for (let i = 0; i <= kroku; i++) {
      const t = i / kroku;
      obrys.push(mistni(sponaZacatek, smer, telOd + t * delkaTela, -sirkaTela(t)));
    }
    const zubu = 4;
    for (let i = 0; i <= zubu * 2; i++) {
      const napric = -sirkaTela(1) + (2 * sirkaTela(1) * i) / (zubu * 2);
      obrys.push(mistni(sponaZacatek, smer, delkaSpony + (i % 2 ? 0.14 * c : 0), napric));
    }
    for (let i = kroku; i >= 0; i--) {
      const t = i / kroku;
      obrys.push(mistni(sponaZacatek, smer, telOd + t * delkaTela, sirkaTela(t)));
    }
    const zacatekTela = { x: sponaZacatek.x + smer.x * telOd, y: sponaZacatek.y + smer.y * telOd };
    vypln(cil, obrys, (x, y) => {
      const { u, t } = osa(zacatekTela, sponaKonec, x, y, sirkaSpony);
      /* Černý lesklý plast/lak: tmavý, s úzkým odleskem a světlejší hranou */
      let v = 44 + 10 * (1 - u * u) - 10 * t;
      v += 70 * zvon(u + 0.42, 0.12) * (1 - t * 0.6);
      v += 26 * zvon(u - 0.55, 0.08);
      if (Math.abs(u) > 0.88) v -= 18;
      /* Kloub nahoře: chromová páska přes tělo */
      if (t < 0.2) {
        const kov0 = kov(u, t * 2, 0.88, 1);
        return naSedou(kov0.map(one => one - 10) as [number, number, number]);
      }
      if (t < 0.24) v -= 20;
      /* Prolis pro palec uprostřed a jemné vroubky */
      const prolis = zvon(u, 0.35) * zvon((t - 0.5) / 0.18, 1);
      v -= 14 * prolis;
      if (t > 0.34 && t < 0.62) v += 6 * Math.sin((2 * Math.PI * t * delkaTela) / Math.max(2, 0.2 * c));
      /* Dole chromová čelist se zoubky, která drží kalhoty */
      if (t > 0.8) {
        const celist = kov(u, (t - 0.8) / 0.2, 0.86, 0.9);
        return naSedou(celist.map(one => one - 25 - 30 * ((t - 0.8) / 0.2)) as [number, number, number]);
      }
      return naSedou([v, v + 1, v + 3]);
    });
  }
}

/**
 * Kapesníček do špičky: trojúhelník nad kapsou saka.
 *
 * Velikost podle trupu: pánský kapesníček kouká 7 cm na šířku, ale na
 * kojenci by to byla půlka hrudi — tam je celá kapsa sotva tak velká.
 */
function kapesnicek(obraz: Obraz, k: Kotvy, s: ZkSablona): void {
  const c = k.naCm;
  const plna = s.sirkaCm * c;
  /* Ramena dospělého kolem 44 cm → 7 cm kapesníčku; kojenec kolem 20 cm → přes 3 cm */
  let w = k.ramena ? Math.min(plna, Math.max(2.2 * c, k.ramena * 0.16)) : plna;
  /* Do kapsy se musí vejít: nejvýš dvě třetiny její šířky */
  if (k.kapsaSirka) w = Math.min(w, k.kapsaSirka * 0.68);
  const h = (s.vyskaCm ?? 3.6) * c * (w / plna);
  const { x, y } = k.kapsa;
  const sklon = k.kapsaSklon ?? -0.04;
  /* Základna leží na hraně kapsy (kousek pod ní, ať nekouká mezera), špička kolmo nahoru */
  const levy = { x: x - w / 2, y: y - sklon * w / 2 + 0.12 * c };
  const pravy = { x: x + w / 2, y: y + sklon * w / 2 + 0.12 * c };
  const spicka = { x: x + 0.12 * w + sklon * h * 0.3, y: y + sklon * 0.12 * w - h };
  /* Jen to, co kouká z kapsy — zbytek je v ní schovaný */
  const tvar: Bod[] = [levy, spicka, pravy];
  vypln(obraz, tvar, (px0, py) => {
    /* Na které straně hřbetu (špička → střed kapsy) bod leží */
    const strana = (spicka.x - x) * (py - y) - (spicka.y - y) * (px0 - x);
    let v = strana > 0 ? 142 : 112;
    const odHrbetu = Math.abs(strana) / (Math.hypot(spicka.x - x, spicka.y - y) || 1);
    if (odHrbetu < 0.35 * c) v += 18 * (1 - odHrbetu / (0.35 * c));
    if (py > y - 0.4 * c) v -= 22 * Math.min(1, (py - (y - 0.4 * c)) / (0.4 * c));
    return v;
  });
}

/**
 * Nakreslí šablonu jednoho kusu na plátno postavy.
 *
 * Výsledek je mapa světla se 128 jako látkou — přesně jako vrstvy od
 * modelu, takže skript na e-shopu nepozná rozdíl a nic se v něm nemění.
 */
export function nakresliSablonu(
  typ: ZkVrstvaTyp,
  varianta: string,
  kotvy: Kotvy,
  sirka: number,
  vyska: number,
  /** Kudy smí vést kšandy (košile a kalhoty). */
  orez?: Uint8Array,
  /** Sem se nakreslí kov (spony, posuvky) ve skutečné barvě; bez něj jde do mapy světla. */
  kovy?: Obraz
): Obraz | null {
  const s = sablonaPro(typ, varianta);
  if (!s) return null;
  const obraz = novyObraz(sirka, vyska);
  if (s.tvar === 'kravata') kravata(obraz, kotvy, s, false);
  else if (s.tvar === 'pletena') kravata(obraz, kotvy, s, true);
  else if (s.tvar === 'motylek') motylek(obraz, kotvy, s);
  else if (s.tvar === 'regata') regata(obraz, kotvy, s);
  else if (s.tvar === 'kapesnicek') kapesnicek(obraz, kotvy, s);
  else if (s.tvar === 'ksandy') {
    ksandy(obraz, kotvy, s, orez ?? new Uint8Array(sirka * vyska).fill(255), kovy);
  }
  return obraz;
}

/** Popis šablony do okna — co se nakreslilo a v jakém rozměru. */
export function popisSablony(typ: ZkVrstvaTyp, varianta: string): string {
  const s = sablonaPro(typ, varianta);
  if (!s) return 'šablona';
  const cm = (v: number) => String(v).replace('.', ',');
  if (s.tvar === 'motylek' || s.tvar === 'kapesnicek' || s.tvar === 'regata') {
    return `šablona ${cm(s.sirkaCm)} × ${cm(s.vyskaCm ?? 0)} cm`;
  }
  return `šablona, šířka ${cm(s.sirkaCm)} cm`;
}

/**
 * Nakreslí a uloží šablony pro postavu — všechny, nebo jen jednu.
 *
 * Vrací počet uložených vrstev. Ukládá se jako „hotovo": šablona není
 * odhad modelu, takže ji není potřeba kontrolovat tak jako vrstvu od
 * něj. Schvaluje se stejně — okem, v náhledu kabiny.
 */
/** Šablona upravená ručně v revizi podkladů — hromadné překreslení ji nechá být. */
export const REVIZE = 'Upraveno v revizi';

/**
 * Šablona, kterou dokreslila AI (realistické záhyby, uzel, spony).
 * Zaplacená — hromadné překreslení ji nechá být stejně jako ruční úpravu.
 */
export const AI_SABLONA = 'Realistická (AI)';

/**
 * Kdo chce vědět, že se šablona změnila — vykreslení od AI se pak
 * přizpůsobí novému tvaru bez nového kreslení (vykresleni.ts).
 * Registrace místo importu: vykreslení samo šablony potřebuje.
 */
type PoZmene = (postavaId: string, typ: ZkVrstvaTyp, varianta: string) => void;
const poZmene: PoZmene[] = [];
export function naZmenuSablony(fn: PoZmene): void { poZmene.push(fn); }
export function sablonaZmenena(postavaId: string, typ: ZkVrstvaTyp, varianta: string): void {
  for (const fn of poZmene) { try { fn(postavaId, typ, varianta); } catch { /* přizpůsobení nesmí shodit kreslení šablon */ } }
}

export function vygenerujSablony(
  postavaId: string,
  jen?: { typ: ZkVrstvaTyp; varianta: string },
  /**
   * Přepsat i šablony upravené v revizi? Ano při nové postavě a nových
   * bodech (stará úprava by seděla vedle), ne při hromadném běhu „vše" —
   * ten by jinak ruční práci tiše zahodil.
   */
  prepsatRevize = true
): ZkVrstva[] {
  const mereni = kotvyPostavy(postavaId);
  if (!mereni) throw new Error('Nejdřív se musí nakreslit postava.');
  const p = store.postava(postavaId);
  const { kotvy, postava, orez } = mereni;
  const silueta = new Uint8Array(postava.sirka * postava.vyska);
  for (let i = 0; i < silueta.length; i++) silueta[i] = postava.body[i * 4 + 3] > 24 ? 255 : 0;
  const kdePostava = px.okraje(silueta, postava.sirka, postava.vyska);
  const out: ZkVrstva[] = [];
  for (const def of ZK_VRSTVY) {
    if (!def.sablona) continue;
    if (p && def.nePro?.includes(p.vek)) continue;
    for (const v of def.varianty) {
      if (jen && (jen.typ !== def.typ || jen.varianta !== v.id)) continue;
      if (!jen && !prepsatRevize && store.vrstvy(postavaId)
        .some(one => one.typ === def.typ && one.varianta === v.id
          && (one.zadani.startsWith(REVIZE) || one.zadani.startsWith(AI_SABLONA)))) continue;
      const kovy = def.typ === 'ksandy' ? novyObraz(postava.sirka, postava.vyska) : undefined;
      const obraz = nakresliSablonu(def.typ, v.id, kotvy, postava.sirka, postava.vyska, orez, kovy);
      if (!obraz) continue;
      const maska = new Uint8Array(postava.sirka * postava.vyska);
      for (let i = 0; i < maska.length; i++) maska[i] = obraz.body[i * 4 + 3] > 128 ? 255 : 0;
      const kde = px.okraje(maska, postava.sirka, postava.vyska);
      const soubor = store.cestaVrstvy(postavaId, def.typ, v.id);
      fs.writeFileSync(soubor, uloz(obraz));
      let kovSoubor: string | undefined;
      if (kovy) {
        kovSoubor = soubor.replace(/\.png$/, '-kov.png');
        fs.writeFileSync(kovSoubor, uloz(kovy));
      }
      const vrstva: ZkVrstva = {
        postava: postavaId, typ: def.typ, varianta: v.id, soubor, url: '',
        sirka: postava.sirka, vyska: postava.vyska,
        podil: kdePostava.podil > 0 ? kde.podil / kdePostava.podil : 0,
        okraje: { x: kde.x, y: kde.y, w: kde.w, h: kde.h },
        stav: kde.w > 0 ? 'hotovo' : 'nesedi',
        potiz: kde.w > 0 ? '' : 'Šablona se na plátno nevešla — zkontroluj body na postavě.',
        zadani: popisSablony(def.typ, v.id),
        kdy: new Date().toISOString(),
        kov: kovSoubor
      };
      store.zapisVrstvu(vrstva);
      out.push(vrstva);
    }
  }
  for (const v of out) sablonaZmenena(postavaId, v.typ, v.varianta);
  return out;
}

/* -------------------------------------------------------------- náhled */

/**
 * Náhled pro okno: postava s kulisou a doplňky, aby se dalo posoudit,
 * jestli body sedí. Dvě podoby — bez saka (kravata a kšandy, ty jsou
 * pod sakem schované) a se sakem (motýlek a kapesníček v klopě).
 */
export function nahledSablon(postavaId: string, zmenseni = 2, vyrez?: { x: number; y: number; w: number; h: number }): {
  bezSaka: string; seSakem: string; sirka: number; vyska: number; kotvy: Kotvy;
} | null {
  const mereni = kotvyPostavy(postavaId);
  if (!mereni) return null;
  const { kotvy, postava, orez } = mereni;
  const { sirka, vyska } = postava;
  const vrstvy = store.vrstvy(postavaId);
  const nactiVrstvu = (typ: ZkVrstvaTyp, varianta: string): Obraz | null => {
    const v = vrstvy.find(one => one.typ === typ && one.varianta === varianta && one.soubor && fs.existsSync(one.soubor));
    if (!v) return null;
    const obraz = nacti(fs.readFileSync(v.soubor));
    return obraz.sirka === sirka && obraz.vyska === vyska ? obraz : null;
  };
  const kulisa = (seSakem: boolean) => {
    const kusy: { obraz: Obraz; hex?: string }[] = [{ obraz: postava }];
    for (const [typ, varianta] of [['boty', 'spolecenske'], ['kalhoty', 'oblekove'], ['kosile', 'klasicka']] as const) {
      const o = nactiVrstvu(typ, varianta);
      if (o) kusy.push({ obraz: o, hex: ZK_PODKLAD_HEX[typ] });
    }
    if (seSakem) {
      const sako = nactiVrstvu('sako', 'jednoradove');
      if (sako) kusy.push({ obraz: sako, hex: ZK_PODKLAD_HEX.sako });
    }
    return kusy;
  };
  const kus = (typ: ZkVrstvaTyp, varianta: string) => nakresliSablonu(typ, varianta, kotvy, sirka, vyska, orez)!;
  const kusSKovem = (typ: ZkVrstvaTyp, varianta: string, hex: string) => {
    const kovy = novyObraz(sirka, vyska);
    const obraz = nakresliSablonu(typ, varianta, kotvy, sirka, vyska, orez, kovy)!;
    return [{ obraz, hex }, { obraz: kovy }];
  };

  /*
   * Doplňky v náhledu podle věku: na dítě dětská kravata (6 cm), úzké
   * kšandy a dětský motýlek, na kojence MINI. S pánskými kusy vypadalo
   * dítě v náhledu, jako by mu všechno bylo velké — a to se dalo splést
   * s tím, že šablony nesedí.
   */
  const vek = store.postava(postavaId)?.vek ?? 'dospely';
  const kravataV = vek === 'dospely' ? 'kravata' : 'kravata-6';
  const ksandyV = vek === 'dospely' ? 'siroke' : 'uzke';
  const motylekV = vek === 'dospely' ? 'motylek' : vek === 'dite' ? 'motylek-detsky' : 'motylek-mini';
  const bez = kulisa(false);
  bez.push(...kusSKovem('ksandy', ksandyV, '#2d4a7c'));
  bez.push({ obraz: kus('kravata', kravataV), hex: '#7a1f2b' });
  const se = kulisa(true);
  se.push({ obraz: kus('kravata', motylekV), hex: '#7a1f2b' });
  se.push({ obraz: kus('kapesnicek', 'spicka'), hex: '#efe7d8' });

  const naData = (kusy: { obraz: Obraz; hex?: string }[]) => {
    const cele = px.slozeni(kusy, sirka, vyska);
    /* Velký editor bodů: jen výřez od hlavy po pas, v plném rozlišení */
    const slozene = px.zmensi(vyrez ? px.vyrizniObdelnik(cele, vyrez) : cele, zmenseni);
    /* Bílé pozadí — na průhledném by tmavé sako splynulo s oknem */
    for (let i = 0; i < slozene.body.length; i += 4) {
      const a = slozene.body[i + 3] / 255;
      for (let j = 0; j < 3; j++) slozene.body[i + j] = Math.round(slozene.body[i + j] * a + 250 * (1 - a));
      slozene.body[i + 3] = 255;
    }
    return `data:image/png;base64,${uloz(slozene).toString('base64')}`;
  };
  return { bezSaka: naData(bez), seSakem: naData(se), sirka, vyska, kotvy };
}

export const __test = { zmerKotvy, nakresliSablonu, uvnitr };
