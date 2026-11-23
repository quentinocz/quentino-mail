import {
  ZkPostava, ZkVrstvaTyp, ZK_VRSTVY, ZK_KRESLICI, hexNaRgb, vrstvaDef
} from '../../shared/zkusebna';
import { Obraz, novyObraz } from './png';
import * as store from './store';
import { podkladProKus, ulozPostavu, vrstvaZObrazku } from './vrstvy';

/**
 * Ukázková postava — nakreslená kódem, bez AI a bez klíče.
 *
 * ## Proč vůbec
 *
 * Zkušební kabina stojí na vrstvách, a ty se generují za peníze. Dokud
 * nejsou, byla by kabina prázdné okno a nedalo by se na ní posoudit to,
 * co se posuzovat má: jestli se dobře ovládá, jestli radí k věci, jestli
 * je přebarvení okamžité a jestli se vzhled dá uložit a dát do košíku.
 * Tahle postava je proto **zástupná kresba**: jednoduchá, ale se stíny a
 * záhyby, takže projde tou samou cestou jako skutečné vrstvy.
 *
 * ## Proč se nekreslí vrstvy přímo
 *
 * Mohla by se nakreslit každá vrstva zvlášť a bylo by to o polovinu
 * kódu. Jenže pak by ukázka obešla přesně to, co se na skutečných
 * vrstvách může pokazit: rozdíl dvou kroků, zarovnání, úklid masky a
 * kontrolu, že kus leží tam, kam patří. Takhle se nakreslí **kroky
 * oblékání** a vrstvy z nich vzniknou tou samou cestou jako od modelu —
 * takže ukázka je zároveň zkouška celého řetězu.
 *
 * V okně je u ní napsáno, že je to zástupná kresba. Vydávat ji za fotku
 * by bylo to nejhorší, co se s ní dá udělat.
 */

/** Ukázka je menší než skutečné plátno — kreslí se na procesoru. */
export const UKAZKA_PLATNO = { sirka: 512, vyska: 768 };

interface Miry {
  /** Vršek a spodek postavy na plátně. */
  y0: number;
  h: number;
  stred: number;
  hlavaV: number;
  hlavaS: number;
  ramena: number;
  pas: number;
  /** Díly výšky, kde co začíná. */
  sije: number;
  bricho: number;
  rozkrok: number;
  kotniky: number;
}

function miry(p: ZkPostava): Miry {
  const sirka = p.sirka || UKAZKA_PLATNO.sirka;
  const vyska = p.vyska || UKAZKA_PLATNO.vyska;
  const y0 = Math.round(vyska * 0.035);
  const h = Math.round(vyska * 0.93);
  const kojenec = p.vek === 'kojenec';
  const dite = p.vek === 'dite';
  const hlavaV = Math.round(h * (kojenec ? 0.22 : dite ? 0.16 : 0.128));
  const siroky = p.telo === 'silny';
  const uzky = p.telo === 'hubeny';
  return {
    y0, h, stred: Math.round(sirka / 2),
    hlavaV,
    hlavaS: Math.round(hlavaV * 0.76),
    ramena: Math.round(h * (kojenec ? 0.24 : dite ? 0.235 : siroky ? 0.265 : uzky ? 0.228 : 0.248)),
    pas: Math.round(h * (kojenec ? 0.23 : siroky ? 0.255 : uzky ? 0.168 : 0.196)),
    sije: kojenec ? 0.24 : dite ? 0.18 : 0.148,
    bricho: kojenec ? 0.52 : 0.46,
    rozkrok: kojenec ? 0.58 : dite ? 0.52 : 0.50,
    kotniky: 0.955
  };
}

type Barva = [number, number, number];

/** Kde v šířce pruhu bod leží: −1 levý kraj, 0 střed, +1 pravý. */
function napric(x: number, stred: number, polosirka: number): number {
  return polosirka <= 0 ? 0 : (x - stred) / polosirka;
}

/**
 * Látka: oblost těla, záhyby a mírný spád světla odshora.
 *
 * Bez záhybů by mapa světla byla jednolitá a po přebarvení by z obleku
 * byla placka. Tohle je nejjednodušší způsob, jak mít na kresbě totéž,
 * co na fotce dělají sklady rukávu.
 */
function latka(t: number, y: number, vyska: number, zahyby = 9): number {
  const oblost = 0.78 + 0.34 * Math.cos(t * 1.25);
  const zahyb = 0.055 * Math.sin(t * zahyby * Math.PI);
  const spad = 1.04 - 0.1 * (y / Math.max(1, vyska));
  return Math.max(0.25, Math.min(1.45, (oblost + zahyb) * spad));
}

function bod(obraz: Obraz, x: number, y: number, barva: Barva, alfa = 255): void {
  if (x < 0 || y < 0 || x >= obraz.sirka || y >= obraz.vyska) return;
  const i = (y * obraz.sirka + x) * 4;
  obraz.body[i] = Math.max(0, Math.min(255, Math.round(barva[0])));
  obraz.body[i + 1] = Math.max(0, Math.min(255, Math.round(barva[1])));
  obraz.body[i + 2] = Math.max(0, Math.min(255, Math.round(barva[2])));
  obraz.body[i + 3] = alfa;
}

/** Svislý komolý jehlan: od `odS` nahoře po `doS` dole. */
function kuzel(
  obraz: Obraz,
  stred: number,
  odY: number,
  doY: number,
  odS: number,
  doS: number,
  barva: Barva,
  zahyby = 9
): void {
  for (let y = Math.max(0, odY); y < Math.min(obraz.vyska, doY); y++) {
    const dil = (y - odY) / Math.max(1, doY - odY);
    const polosirka = (odS + (doS - odS) * dil) / 2;
    const od = Math.round(stred - polosirka);
    const doKam = Math.round(stred + polosirka);
    for (let x = od; x <= doKam; x++) {
      const t = napric(x, stred, polosirka);
      const k = latka(t, y - odY, doY - odY, zahyby);
      bod(obraz, x, y, [barva[0] * k, barva[1] * k, barva[2] * k]);
    }
  }
}

/**
 * Trup se **spáditými rameny**.
 *
 * Kužel s rovným přechodem udělá z ramen vodorovnou hranu a z postavy
 * cedulku. Šířka proto nejdřív rychle naroste od krku k ramenům a pak se
 * zvolna stahuje k pasu — je to jediný rozdíl mezi „figurou" a „obdélníkem
 * s hlavou".
 */
function trup(
  obraz: Obraz,
  stred: number,
  odY: number,
  doY: number,
  krk: number,
  ramena: number,
  pas: number,
  barva: Barva,
  zahyby = 8
): void {
  const vyska = Math.max(1, doY - odY);
  for (let y = Math.max(0, odY); y < Math.min(obraz.vyska, doY); y++) {
    const dil = (y - odY) / vyska;
    /* Prvních pár procent je rameno, zbytek pozvolný spád k pasu */
    const náběh = Math.min(1, dil / 0.09);
    const sirka = dil < 0.09
      ? krk + (ramena - krk) * (náběh * náběh * (3 - 2 * náběh))
      : ramena + (pas - ramena) * ((dil - 0.09) / 0.91) ** 1.25;
    const polosirka = sirka / 2;
    for (let x = Math.round(stred - polosirka); x <= stred + polosirka; x++) {
      const k = latka(napric(x, stred, polosirka), y - odY, vyska, zahyby);
      bod(obraz, x, y, [barva[0] * k, barva[1] * k, barva[2] * k]);
    }
  }
}

function elipsa(obraz: Obraz, cx: number, cy: number, rx: number, ry: number, barva: Barva): void {
  for (let y = Math.round(cy - ry); y <= cy + ry; y++) {
    for (let x = Math.round(cx - rx); x <= cx + rx; x++) {
      const dx = (x - cx) / Math.max(1, rx);
      const dy = (y - cy) / Math.max(1, ry);
      if (dx * dx + dy * dy > 1) continue;
      /* Světlo zleva odshora — jinak by hlava byla plochý kruh */
      const k = 0.86 + 0.26 * Math.cos((dx + 0.3) * 1.1) * Math.cos(dy * 0.8);
      bod(obraz, x, y, [barva[0] * k, barva[1] * k, barva[2] * k]);
    }
  }
}

/**
 * Pruh přes část hlavy — vlasy a fousy.
 *
 * `jenKraje` nechá uprostřed obličej: vlasy sahají po stranách níž než
 * nad čelem, a vous drží u brady a netvoří přes půlku tváře pás. Bez toho
 * z toho byla škraboška.
 */
function cepice(
  obraz: Obraz, cx: number, cy: number, rx: number, ry: number,
  odDilu: number, doDilu: number, barva: Barva,
  jenKraje = 0
): void {
  for (let y = Math.round(cy - ry); y <= cy + ry; y++) {
    const dil = (y - (cy - ry)) / Math.max(1, 2 * ry);
    if (dil < odDilu || dil > doDilu) continue;
    for (let x = Math.round(cx - rx); x <= cx + rx; x++) {
      const dx = (x - cx) / Math.max(1, rx);
      const dy = (y - cy) / Math.max(1, ry);
      if (dx * dx + dy * dy > 1) continue;
      /* Uprostřed se nechá obličej — ale až pod čelem, ne nahoře */
      if (jenKraje > 0 && dil > odDilu + 0.12 && Math.abs(dx) < jenKraje) continue;
      const k = latka(dx, y - (cy - ry), 2 * ry, 5);
      bod(obraz, x, y, [barva[0] * k, barva[1] * k, barva[2] * k]);
    }
  }
}

/**
 * Oči, obočí a ústa.
 *
 * Postava bez obličeje není model, ale panák — a zákazník na ni nezkouší
 * oblek, protože neví, na koho se dívá. Je to pár teček, ale rozdíl mezi
 * figurínou a člověkem.
 */
function oblicej(obraz: Obraz, cx: number, cy: number, rx: number, ry: number): void {
  const oko: Barva = [62, 48, 40];
  const okoY = Math.round(cy + ry * 0.05);
  const rozchod = Math.round(rx * 0.36);
  for (const strana of [-1, 1]) {
    elipsa(obraz, cx + strana * rozchod, okoY, Math.max(1, Math.round(rx * 0.13)), Math.max(1, Math.round(ry * 0.055)), oko);
    /* Obočí kousek nad okem */
    elipsa(obraz, cx + strana * rozchod, okoY - Math.round(ry * 0.13),
      Math.max(1, Math.round(rx * 0.18)), Math.max(1, Math.round(ry * 0.028)), [96, 72, 56]);
  }
  elipsa(obraz, cx, Math.round(cy + ry * 0.47), Math.max(1, Math.round(rx * 0.2)),
    Math.max(1, Math.round(ry * 0.04)), [164, 110, 98]);
}

const PLET: Barva = [206, 170, 142];
const SPODEK: Barva = [238, 238, 236];

/**
 * Barva kusu při kreslení — ta samá, jakou se říká modelu.
 *
 * Každý kus jinou, a výraznou: vrstva vzniká z rozdílu dvou kroků a dva
 * kusy ve stejné šedé nad sebou nevydají rozdíl žádný. Na ukázce se to
 * poznalo dřív než na zaplacených obrázcích — sako vyšlo na 17 % postavy
 * místo 55 %, protože se krylo se stejně šedou košilí.
 */
function kreslici(typ: ZkVrstvaTyp): Barva {
  const rgb = hexNaRgb(ZK_KRESLICI[typ] || '#808080') ?? { r: 128, g: 128, b: 128 };
  return [rgb.r, rgb.g, rgb.b];
}

/** Nakreslí postavu ve spodním prádle — nulový krok oblékání. */
export function kresliPostavu(p: ZkPostava): Obraz {
  const obraz = novyObraz(p.sirka || UKAZKA_PLATNO.sirka, p.vyska || UKAZKA_PLATNO.vyska);
  const m = miry(p);
  const y = (dil: number) => Math.round(m.y0 + m.h * dil);

  /* Nohy */
  const rozkrok = y(m.rozkrok);
  const kotniky = y(m.kotniky);
  const nohaS = Math.round(m.pas * 0.46);
  for (const strana of [-1, 1]) {
    const stred = m.stred + strana * Math.round(m.pas * 0.26);
    kuzel(obraz, stred, rozkrok, kotniky, nohaS, Math.round(nohaS * 0.62), PLET, 5);
  }
  /* Chodidla */
  for (const strana of [-1, 1]) {
    const stred = m.stred + strana * Math.round(m.pas * 0.26);
    kuzel(obraz, stred, kotniky, y(1), Math.round(nohaS * 0.7), Math.round(nohaS * 0.8), PLET, 4);
  }

  /* Trup v nátělníku */
  const sije = y(m.sije);
  const bricho = y(m.bricho);
  trup(obraz, m.stred, sije, bricho, Math.round(m.hlavaS * 0.52), m.ramena, m.pas, SPODEK, 7);
  /* Spodní díl */
  kuzel(obraz, m.stred, bricho, rozkrok, m.pas, Math.round(m.pas * 1.02), SPODEK, 6);

  /* Paže podél těla */
  const pazeS = Math.round(m.ramena * 0.19);
  for (const strana of [-1, 1]) {
    const horni = m.stred + strana * Math.round(m.ramena * 0.5 - pazeS * 0.45);
    const dolni = m.stred + strana * Math.round(m.pas * 0.6 + pazeS * 0.5);
    for (let yy = sije; yy < y(m.bricho + 0.06); yy++) {
      const dil = (yy - sije) / Math.max(1, y(m.bricho + 0.06) - sije);
      const stred = Math.round(horni + (dolni - horni) * dil);
      const polosirka = (pazeS * (1 - 0.25 * dil)) / 2;
      for (let x = Math.round(stred - polosirka); x <= stred + polosirka; x++) {
        const k = latka(napric(x, stred, polosirka), yy - sije, 1, 4);
        bod(obraz, x, yy, [PLET[0] * k, PLET[1] * k, PLET[2] * k]);
      }
    }
  }

  /* Šíje a hlava nakonec, ať leží přes trup */
  kuzel(obraz, m.stred, y(m.sije - 0.035), sije + 2, Math.round(m.hlavaS * 0.42), Math.round(m.hlavaS * 0.5), PLET, 3);
  const hlavaCy = m.y0 + Math.round(m.hlavaV / 2);
  elipsa(obraz, m.stred, hlavaCy, Math.round(m.hlavaS / 2), Math.round(m.hlavaV / 2), PLET);
  oblicej(obraz, m.stred, hlavaCy, Math.round(m.hlavaS / 2), Math.round(m.hlavaV / 2));
  return obraz;
}

/** Dokreslí do hotového kroku jeden kus — tak vzniká další krok. */
export function kresliKus(
  p: ZkPostava, pred: Obraz, typ: ZkVrstvaTyp, varianta: string,
  /**
   * Barva látky. Kus se kreslí dvakrát: **v kreslicí barvě**, ze které
   * se vrstva vybere, a **v obyčejné**, ze které se skládá podklad pro
   * další kus. Kdyby podklad zůstal v kreslicích barvách, sedla by
   * purpurová kravata na purpurovou košili a vybraly by se obě.
   */
  barva: Barva = kreslici(typ)
): Obraz {
  const obraz: Obraz = { sirka: pred.sirka, vyska: pred.vyska, body: Uint8Array.from(pred.body) };
  const latkaBarva = barva;
  const m = miry(p);
  const y = (dil: number) => Math.round(m.y0 + m.h * dil);
  const hlavaCx = m.stred;
  const hlavaCy = m.y0 + Math.round(m.hlavaV / 2);
  const rx = Math.round(m.hlavaS / 2);
  const ry = Math.round(m.hlavaV / 2);
  const sije = y(m.sije);
  const bricho = y(m.bricho);
  const rozkrok = y(m.rozkrok);
  const kotniky = y(m.kotniky);
  const nohaS = Math.round(m.pas * 0.46);
  const pazeS = Math.round(m.ramena * 0.19);

  const rukavy = (odY: number, doY: number, sirka: number) => {
    for (const strana of [-1, 1]) {
      const horni = m.stred + strana * Math.round(m.ramena * 0.5 - sirka * 0.45);
      const dolni = m.stred + strana * Math.round(m.pas * 0.6 + sirka * 0.5);
      for (let yy = odY; yy < doY; yy++) {
        const dil = (yy - sije) / Math.max(1, y(m.bricho + 0.06) - sije);
        const stred = Math.round(horni + (dolni - horni) * dil);
        const polosirka = (sirka * (1 - 0.22 * dil)) / 2;
        for (let x = Math.round(stred - polosirka); x <= stred + polosirka; x++) {
          const k = latka(napric(x, stred, polosirka), yy - odY, doY - odY, 6);
          bod(obraz, x, yy, [latkaBarva[0] * k, latkaBarva[1] * k, latkaBarva[2] * k]);
        }
      }
    }
  };

  if (typ === 'boty') {

    for (const strana of [-1, 1]) {
      const stred = m.stred + strana * Math.round(m.pas * 0.26);
      kuzel(obraz, stred, kotniky - Math.round(m.h * 0.012), y(1), Math.round(nohaS * 0.78), Math.round(nohaS * 0.92), latkaBarva, 3);
    }
  } else if (typ === 'kalhoty') {
    kuzel(obraz, m.stred, bricho - Math.round(m.h * 0.01), rozkrok, m.pas, Math.round(m.pas * 1.04), latkaBarva, 6);
    for (const strana of [-1, 1]) {
      const stred = m.stred + strana * Math.round(m.pas * 0.26);
      kuzel(obraz, stred, rozkrok, kotniky, Math.round(nohaS * 1.08), Math.round(nohaS * 0.86), latkaBarva, 7);
    }
  } else if (typ === 'kosile') {
    const horni = varianta === 'stojacek' ? sije - Math.round(m.h * 0.012) : sije - Math.round(m.h * 0.022);
    kuzel(obraz, m.stred, horni, bricho + Math.round(m.h * 0.02), m.ramena, Math.round(m.pas * 1.02), latkaBarva, 8);
    rukavy(sije, y(m.bricho + 0.06), pazeS);
  } else if (typ === 'vesta') {
    trup(obraz, m.stred, sije + Math.round(m.h * 0.02), bricho + Math.round(m.h * 0.015),
      Math.round(m.hlavaS * 0.6), Math.round(m.ramena * 0.78), Math.round(m.pas * 1.0), latkaBarva, 6);
  } else if (typ === 'sako') {
    const doKam = y(m.bricho + 0.1);
    const sirka = Math.round(m.ramena * (varianta === 'dvouradove' ? 1.1 : 1.06));
    const horni = sije - Math.round(m.h * 0.012);
    trup(obraz, m.stred, horni, doKam, Math.round(m.hlavaS * 0.78), sirka, Math.round(m.pas * 1.2), latkaBarva, 7);
    rukavy(sije, y(m.bricho + 0.08), Math.round(pazeS * 1.25));
    /*
     * Výstřih do V, ne svislý pruh. Pruh vypadal jako šála a hlavně
     * nebylo poznat, že sako je rozepnuté — a právě v tom V je vidět
     * košile a kravata, kvůli kterým si je zákazník vybírá.
     */
    if (varianta !== 'dvouradove') {
      const knoflik = y(m.bricho - 0.03);
      const otevreni = Math.round(m.ramena * 0.3);
      for (let yy = horni; yy < knoflik; yy++) {
        const dil = (yy - horni) / Math.max(1, knoflik - horni);
        const sirkaV = Math.round(otevreni * (1 - dil) ** 1.1);
        for (let x = m.stred - sirkaV; x <= m.stred + sirkaV; x++) {
          if (x < 0 || x >= obraz.sirka) continue;
          const i = (yy * obraz.sirka + x) * 4;
          obraz.body[i] = pred.body[i];
          obraz.body[i + 1] = pred.body[i + 1];
          obraz.body[i + 2] = pred.body[i + 2];
          obraz.body[i + 3] = pred.body[i + 3];
        }
      }
    }
  }
  return obraz;
}

/**
 * Postaví celou ukázkovou postavu i se všemi vrstvami.
 *
 * Jde tou samou cestou jako skutečné generování — kroky oblékání a vrstvy
 * z jejich rozdílu. Takže když se tohle rozbije, rozbilo by se i to
 * skutečné, a pozná se to bez jediného zaplaceného obrázku.
 */
export function postavUkazku(id: string): { hotovo: number; nesedi: string[] } {
  const p0 = store.postava(id);
  if (!p0) throw new Error(`Postava ${id} v seznamu není.`);
  const p: ZkPostava = { ...p0, sirka: UKAZKA_PLATNO.sirka, vyska: UKAZKA_PLATNO.vyska };

  /*
   * Postava rovnou v košili, kalhotách a botách, každý kus v kreslicí
   * barvě — přesně tak, jak ji teď kreslí model. Uloží se tou samou
   * cestou (`ulozPostavu`): vyříznutí kulisy i šablony zboží.
   */
  let postava = kresliPostavu(p);
  for (const [typ, varianta] of [['boty', 'spolecenske'], ['kalhoty', 'oblekove'], ['kosile', 'klasicka']] as const) {
    postava = kresliKus(p, postava, typ, varianta);
  }
  store.zahodOblekani(id);
  ulozPostavu(p, postava, 'ukázková kresba');

  const vse = store.vrstvy(id);
  let hotovo = vse.filter(one => one.stav !== 'nesedi').length;
  const nesedi: string[] = vse.filter(one => one.stav === 'nesedi')
    .map(one => `${vrstvaDef(one.typ).nazev} (${one.varianta}): ${one.potiz}`);

  /*
   * Vesta a sako se dokreslují jako u modelu: na podklad složený
   * z hotových vrstev, a vrstva se vybere podle kreslicí barvy. Všechny
   * varianty z téhož podkladu.
   */
  for (const def of ZK_VRSTVY) {
    if (def.typ === 'postava' || def.sablona) continue;
    if (def.nePro?.includes(p.vek)) continue;
    for (const v of def.varianty) {
      if (def.zPostavy === v.id) continue;
      const zaklad = podkladProKus(id, def.typ);
      const po = kresliKus(p, zaklad, def.typ, v.id);
      const { vrstva } = vrstvaZObrazku(p, def.typ, v.id, zaklad, po, 'ukázková kresba');
      store.zapisVrstvu(vrstva);
      if (vrstva.stav === 'nesedi') nesedi.push(`${def.nazev} (${v.nazev}): ${vrstva.potiz}`);
      else hotovo += 1;
    }
  }
  return { hotovo, nesedi };
}

export const __test = { kresliPostavu, kresliKus, miry };
