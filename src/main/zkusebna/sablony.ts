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

  return { limec, pas: pasY, ramenoL, ramenoR, sponaL, sponaR, kapsa, naCm };
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
export function kotvyPostavy(postavaId: string): { kotvy: Kotvy; postava: Obraz; orez: Uint8Array } | null {
  const p = store.postava(postavaId);
  const zaklad = store.vrstvy(postavaId).find(one => one.typ === 'postava' && one.soubor && fs.existsSync(one.soubor));
  if (!p || !zaklad) return null;
  const postava = nacti(fs.readFileSync(zaklad.soubor));
  const kosile = maskaVrstvy(postavaId, 'kosile', 'klasicka');
  const kalhoty = maskaVrstvy(postavaId, 'kalhoty', 'oblekove');
  const kotvy = zmerKotvy(p, postava, kosile, kalhoty, rucneKotvy(postavaId));
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

type Stin = (x: number, y: number) => number;

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
      const s = Math.max(0, Math.min(255, stin(x + 0.5, y + 0.5)));
      const k = i * 4;
      const puvA = obraz.body[k + 3] / 255;
      const noveA = a + puvA * (1 - a);
      const sedy = noveA > 0 ? (s * a + obraz.body[k] * puvA * (1 - a)) / noveA : s;
      obraz.body[k] = obraz.body[k + 1] = obraz.body[k + 2] = Math.round(sedy);
      obraz.body[k + 3] = Math.round(noveA * 255);
    }
  }
}

const zvon = (v: number, sirka: number) => Math.exp(-((v / sirka) ** 2));
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
  const kh = kt * 1.02;
  const top = k.limec.y + 0.2 * c;
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
}

/** Motýlek: dvě křídla stažená uprostřed a uzlík přes ně. */
function motylek(obraz: Obraz, k: Kotvy, s: ZkSablona): void {
  const c = k.naCm;
  const w = s.sirkaCm * c;
  const h = (s.vyskaCm ?? s.sirkaCm * 0.45) * c;
  const cx = k.limec.x;
  const cy = k.limec.y + h * 0.42;
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

/** Regata: nabraná šála v rozepnutém límci, dole zaoblená. */
function regata(obraz: Obraz, k: Kotvy, s: ZkSablona): void {
  const c = k.naCm;
  const w = s.sirkaCm * c;
  const h = (s.vyskaCm ?? 12) * c;
  const cx = k.limec.x;
  const top = k.limec.y - 0.3 * c;
  const pul = (y: number) => {
    const d = (y - top) / h;
    if (d <= 0.75) return w * (0.275 + 0.225 * Math.sin((Math.min(1, d / 0.45) * Math.PI) / 2));
    return w * 0.5 * Math.sqrt(Math.max(0, 1 - ((d - 0.75) / 0.25) ** 2));
  };
  const tvar: Bod[] = [];
  const kroku = 30;
  for (let i = 0; i <= kroku; i++) { const y = top + (h * i) / kroku; tvar.push({ x: cx - pul(y), y }); }
  for (let i = kroku; i >= 0; i--) { const y = top + (h * i) / kroku; tvar.push({ x: cx + pul(y), y }); }
  vypln(obraz, tvar, (x, y) => {
    const d = (y - top) / h;
    const u = omez((x - cx) / Math.max(1, pul(y)), -1, 1);
    let v = 128;
    v += 15 * Math.sin(u * Math.PI * 2.5 + d * 2) * Math.min(1, d * 2.5);
    if (d < 0.2) v -= 14 * (1 - d / 0.2);
    if (Math.abs(u) > 0.82) v -= ((Math.abs(u) - 0.82) / 0.18) * 20;
    return v;
  });
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
 * Kšandy: dva pásky od ramen k pasu, s posuvkou a sponou.
 *
 * Spona a posuvka jsou kov, ale vrstva se barví látkou — kreslí se proto
 * světle, aby po podložení vyšly jako lesklý kov v odstínu kšand, ne
 * jako další kus látky. Nahoře se pásek ořízne obrysem postavy: přes
 * rameno jde dozadu a nad ramenem nemá co dělat.
 */
function ksandy(obraz: Obraz, k: Kotvy, s: ZkSablona, silueta: Uint8Array): void {
  const c = k.naCm;
  const w = s.sirkaCm * c;
  for (const [nahore, dole] of [[k.ramenoL, k.sponaL], [k.ramenoR, k.sponaR]] as [Bod, Bod][]) {
    const dx = dole.x - nahore.x;
    const dy = dole.y - nahore.y;
    const d = Math.hypot(dx, dy) || 1;
    const smer = { x: dx / d, y: dy / d };
    const kSpone = { x: dole.x - smer.x * 2.6 * c, y: dole.y - smer.y * 2.6 * c };
    const zacatek = { x: nahore.x - smer.x * 3 * c, y: nahore.y - smer.y * 3 * c };
    vypln(obraz, podel(zacatek, kSpone, w), (x, y) => {
      const { u, t } = osa(zacatek, kSpone, x, y, w);
      let v = 128 + 5 * (1 - u * u) + 6 * (1 - t) - 3;
      if (Math.abs(u) > 0.78) v -= ((Math.abs(u) - 0.78) / 0.22) * 20;
      /* Prošívaný lem a jemné žebrování pruženky — bez nich byl pásek placka */
      if (Math.abs(Math.abs(u) - 0.7) < 0.05) v += 10;
      v += 3 * Math.sin((2 * Math.PI * x) / Math.max(2, 0.22 * c));
      return v;
    }, silueta);

    /* Posuvka zhruba ve třetině délky */
    const tPos = 0.36;
    const stredPos = { x: nahore.x + dx * tPos, y: nahore.y + dy * tPos };
    const posA = { x: stredPos.x - smer.x * 0.65 * c, y: stredPos.y - smer.y * 0.65 * c };
    const posB = { x: stredPos.x + smer.x * 0.65 * c, y: stredPos.y + smer.y * 0.65 * c };
    const sirkaPos = w + 0.5 * c;
    vypln(obraz, podel(posA, posB, sirkaPos), (x, y) => {
      const { u, t } = osa(posA, posB, x, y, sirkaPos);
      let v = 205 + 14 * (1 - u * u);
      if (Math.abs(u) > 0.8 || t < 0.12 || t > 0.88) v -= 55;
      return v;
    });

    /* Spona: kovová, přes horní hranu kalhot */
    const sirkaSpony = Math.max(w * 1.25, 2.6 * c);
    const sponaB = { x: dole.x + smer.x * 0.6 * c, y: dole.y + smer.y * 0.6 * c };
    vypln(obraz, podel(kSpone, sponaB, sirkaSpony), (x, y) => {
      const { u, t } = osa(kSpone, sponaB, x, y, sirkaSpony);
      let v = 200 + 18 * (1 - u * u) - 10 * t;
      if (Math.abs(u) > 0.84 || t < 0.08) v -= 60;
      if (t > 0.78) v -= 35 * Math.abs(Math.sin(u * Math.PI * 4));
      return v;
    });
  }
}

/** Kapesníček do špičky: trojúhelník nad kapsou saka. */
function kapesnicek(obraz: Obraz, k: Kotvy, s: ZkSablona): void {
  const c = k.naCm;
  const w = s.sirkaCm * c;
  const h = (s.vyskaCm ?? 3.6) * c;
  const { x, y } = k.kapsa;
  const levy = { x: x - w / 2, y: y + 0.15 * c };
  const pravy = { x: x + w / 2, y: y - 0.15 * c };
  const spicka = { x: x + 0.12 * w, y: y - h };
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
  orez?: Uint8Array
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
    ksandy(obraz, kotvy, s, orez ?? new Uint8Array(sirka * vyska).fill(255));
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
export function vygenerujSablony(postavaId: string, jen?: { typ: ZkVrstvaTyp; varianta: string }): ZkVrstva[] {
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
      const obraz = nakresliSablonu(def.typ, v.id, kotvy, postava.sirka, postava.vyska, orez);
      if (!obraz) continue;
      const maska = new Uint8Array(postava.sirka * postava.vyska);
      for (let i = 0; i < maska.length; i++) maska[i] = obraz.body[i * 4 + 3] > 128 ? 255 : 0;
      const kde = px.okraje(maska, postava.sirka, postava.vyska);
      const soubor = store.cestaVrstvy(postavaId, def.typ, v.id);
      fs.writeFileSync(soubor, uloz(obraz));
      const vrstva: ZkVrstva = {
        postava: postavaId, typ: def.typ, varianta: v.id, soubor, url: '',
        sirka: postava.sirka, vyska: postava.vyska,
        podil: kdePostava.podil > 0 ? kde.podil / kdePostava.podil : 0,
        okraje: { x: kde.x, y: kde.y, w: kde.w, h: kde.h },
        stav: kde.w > 0 ? 'hotovo' : 'nesedi',
        potiz: kde.w > 0 ? '' : 'Šablona se na plátno nevešla — zkontroluj body na postavě.',
        zadani: popisSablony(def.typ, v.id),
        kdy: new Date().toISOString()
      };
      store.zapisVrstvu(vrstva);
      out.push(vrstva);
    }
  }
  return out;
}

/* -------------------------------------------------------------- náhled */

/**
 * Náhled pro okno: postava s kulisou a doplňky, aby se dalo posoudit,
 * jestli body sedí. Dvě podoby — bez saka (kravata a kšandy, ty jsou
 * pod sakem schované) a se sakem (motýlek a kapesníček v klopě).
 */
export function nahledSablon(postavaId: string, zmenseni = 2): {
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
  bez.push({ obraz: kus('ksandy', ksandyV), hex: '#2d4a7c' });
  bez.push({ obraz: kus('kravata', kravataV), hex: '#7a1f2b' });
  const se = kulisa(true);
  se.push({ obraz: kus('kravata', motylekV), hex: '#7a1f2b' });
  se.push({ obraz: kus('kapesnicek', 'spicka'), hex: '#efe7d8' });

  const naData = (kusy: { obraz: Obraz; hex?: string }[]) => {
    const slozene = px.zmensi(px.slozeni(kusy, sirka, vyska), zmenseni);
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
