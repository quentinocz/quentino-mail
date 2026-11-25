import fs from 'fs';
import { getSetting, setSetting } from '../db';
import { ZK_PODKLAD_HEX, ZkDruhFotky, ZkVrstvaTyp, ZkVek, barvaPodMapu, hardLight } from '../../shared/zkusebna';
import { Obraz, nacti, novyObraz, uloz } from './png';
import * as px from './pixely';
import * as store from './store';
import { naZmenuSablony } from './sablony';
import * as obrazky from './obrazky';
import { fotkyProduktu, proKabinu, stahniFotku } from './produkty';

/**
 * Produkt vykreslený na modelu — celý, ne jako dlaždice vzoru.
 *
 * ## Proč
 *
 * Patrik (24. 11.): „stále to ty vzory nezvládá… možná bude třeba do
 * šablony generovat přímo celou kravatu, tedy šablonu mít jako vodítko
 * pro AI, aby nedělalo nesmysly… kšandy stále působí jako animované".
 *
 * Dlaždice vzoru pod mapou světla má strop: vzor se opakuje, nesleduje
 * záhyby a kšandy bez skutečné pružné tkaniny, švů a spon zůstanou
 * kreslené. Kreslicí model to umí — když dostane přesné zadání.
 *
 * ## Jak je to spolehlivé
 *
 *  1. **Šablona je tvar.** Model dostane výřez modelu s šablonou na
 *     místě kusu a masku přesně ve tvaru šablony: smí kreslit **jen
 *     uvnitř** a tvar, polohu a velikost tím nemůže pokazit.
 *  2. **Fotka výrobku je předloha.** Jde s požadavkem jako další obrázek
 *     — model kreslí tenhle konkrétní kus, ne „nějakou kravatu".
 *  3. **Z výsledku se bere jen tvar šablony.** Co model nakreslí mimo,
 *     zahodí se; průhlednost je z šablony, takže hrany sedí na límec,
 *     kapsu i košili stejně jako dosud.
 *  4. **Model nezačíná z prázdna.** Na místě kusu už je skutečná látka
 *     z fotky pod mapou světla šablony — přesně to, co by kabina ukázala
 *     bez vykreslení. Model to jen „zfotorealističtí": barvy a velikost
 *     vzoru má před sebou, nemusí je hádat.
 *  5. **Kontrola paletou, ne průměrnou barvou.** Patrik (25. 11.): hned
 *     první kravata (bavlněná s květy, PKBA06) skončila „Nesedí: barvy
 *     nesedí" — barva výrobku byla #fcfdf7 (bílý podklad), ale průměr
 *     látky s květy vyšel šedohnědý. Pestrý vzor jednou barvou popsat
 *     nejde. Porovnává se proto rozložení barev uvnitř tvaru: výsledek
 *     proti látce, kterou model dostal.
 *  6. **Jeden pokus, výsledek vždy vidět.** Dřív se nepovedený kus
 *     automaticky kreslil znovu (dvojí cena) a nesedící se neuložil, takže
 *     nebylo vidět, co je špatně. Teď se platí jednou, náhled je vždy
 *     a o „Přesto použít" nebo „Nakreslit znovu" rozhoduje člověk.
 *  7. **Kontrola okem** v okně Produkty → Vykreslení: mřížka náhledů,
 *     schválit / znovu / zamítnout. Zamítnuté kabina nepoužije.
 *
 * Vykresluje se ve dvojnásobném rozlišení postavy, aby kravata byla
 * ostrá i v přiblížení.
 */

export const MERITKO = 2;

const NAZVY_PRO_MODEL: Record<string, string> = {
  kravata: 'necktie with a classic knot (four-in-hand)',
  pletena: 'knitted necktie with a small knot and a square bottom end',
  motylek: 'bow tie',
  regata: 'wedding cravat (ascot) with a gathered knot and a pleated, wide blade',
  ksandy: 'pair of braces (suspenders): two elastic straps with their metal adjusters, loops and clips',
  kapesnicek: 'pocket square peeking out of the breast pocket'
};

function druhKusu(typ: ZkVrstvaTyp, varianta: string): string {
  if (typ === 'kravata') {
    if (varianta.startsWith('motylek')) return 'motylek';
    if (varianta === 'regata') return 'regata';
    if (varianta === 'pletena') return 'pletena';
    return 'kravata';
  }
  return typ;
}

const DRUH_PRO_MODEL: Record<string, string> = {
  detail: 'a close-up of the product fabric',
  cely: 'the product itself',
  na_modelu: 'the product worn by a person — use it to judge how big the pattern is relative to the item',
  sada: 'the product set',
  baleni: 'the product in its box',
  jine: 'the product'
};

/** Zadání pro model. Krátké a jednoznačné — každé slovo navíc je prostor pro fantazii. */
export function zadaniVykresleni(
  typ: ZkVrstvaTyp,
  varianta: string,
  sada: boolean,
  popis = '',
  druhyFotek: string[] = [],
  mira?: { cm: number; motivu: number | null; co: string } | null
): string {
  const kus = NAZVY_PRO_MODEL[druhKusu(typ, varianta)] ?? 'accessory';
  const predlohy = druhyFotek.map((d, i) => `Image ${i + 2} shows ${DRUH_PRO_MODEL[d] ?? 'the product'}.`).join(' ');
  const co = !mira ? '' : /pásku/.test(mira.co) ? 'strap is' : /motýlka/.test(mira.co) ? 'bow tie is (wing tip to wing tip)'
    : /kapesníčku/.test(mira.co) ? 'pocket square edge is' : 'blade is (at its widest point)';
  return [
    'Image 1 is a studio photo of a model. Inside the transparent area of the mask there is a ' + kus
      + ' made by flatly mapping the real fabric of the product onto a template — colours and pattern scale are correct, but it looks flat.',
    'Repaint the masked area as a photorealistic ' + kus + ' that is EXACTLY the product shown in the other image(s):',
    'the same fabric, colours, pattern, pattern size and texture' + (typ === 'ksandy' ? ', the same metal parts and clips' : '') + '.',
    predlohy,
    mira ? `Real size: the ${co} ${String(mira.cm).replace(',', '.')} cm`
      + (mira.motivu ? `, and the pattern motif repeats about ${mira.motivu} times across it` : '')
      + ' — image 1 already has this pattern scale; keep the motifs exactly that big, do not enlarge or shrink them.' : '',
    'Keep the colours and the pattern scale you see in image 1; the pattern follows the folds and the direction of the ' + kus + '.',
    popis ? 'Product description: ' + popis.replace(/\s+/g, ' ').slice(0, 300) + '.' : '',
    sada ? 'The product photo shows a set — use only the ' + kus + ' from it.' : '',
    'Keep exactly the outline, position, size and angle of the placeholder; fill the masked shape completely.',
    'Real fabric with natural soft folds, depth and subtle highlights matching the soft studio light of image 1.',
    'Do not change anything outside the mask. Do not add any other object, text or logo.'
  ].filter(Boolean).join(' ');
}

/**
 * Předlohy pro kreslení podle toho, co AI na fotkách poznala: nejdřív
 * fotka, ze které je látka, pak další detaily a celý výrobek, nakonec
 * jedna fotka na modelu (z ní je vidět, jak velký vzor na těle je).
 * Krabice a cizí věci se neposílají. Nejvýš čtyři — víc model nepřečte
 * líp, jen pomaleji.
 */
async function predlohy(row: store.ZkProduktRow, cast: number): Promise<{ obraz: Obraz; druh: ZkDruhFotky }[]> {
  const ai = (row.ai?.fotky ?? []).filter(one => one.url);
  let poradi: { url: string; druh: ZkDruhFotky }[];
  if (ai.length) {
    const hlavni = row.ai?.kusy.find(one => one.cast === cast)?.foto;
    const vaha = (d: ZkDruhFotky) => ({ detail: 1, cely: 1, sada: 2, na_modelu: 3, jine: 8, baleni: 9 }[d] ?? 8);
    poradi = ai.map((one, i) => ({ ...one, i }))
      .filter(one => one.druh !== 'baleni' && one.druh !== 'jine')
      .sort((a, b) => (a.i === hlavni ? -1 : b.i === hlavni ? 1 : vaha(a.druh) - vaha(b.druh) || a.i - b.i));
    const modelu = poradi.filter(one => one.druh === 'na_modelu');
    poradi = [...poradi.filter(one => one.druh !== 'na_modelu').slice(0, 3), ...modelu.slice(0, 1)].slice(0, 4);
  } else {
    poradi = fotkyProduktu(row.kod, 3).map(url => ({ url, druh: 'cely' as ZkDruhFotky }));
  }
  const stazene = await Promise.all(poradi.map(one => stahniFotku(one.url)));
  return poradi.map((one, i) => ({ obraz: stazene[i]!, druh: one.druh })).filter(one => one.obraz);
}

/* --------------------------------------------------------- kreslíř */

export type Kreslir = (zadani: string, vstup: Obraz, maska: Obraz, predlohy: Obraz[]) => Promise<Obraz>;
let kreslir: Kreslir = (zadani, vstup, maska, predlohy) => obrazky.upravPodlePredlohy(zadani, vstup, maska, predlohy);

/** Pro zkoušky: kreslíř bez OpenAI. */
export function nastavKreslire(fn: Kreslir | null): void {
  kreslir = fn ?? ((zadani, vstup, maska, predlohy) => obrazky.upravPodlePredlohy(zadani, vstup, maska, predlohy));
}

/* ---------------------------------------------------------- pomůcky */

function najdiVrstvu(postava: string, typ: ZkVrstvaTyp, varianta: string) {
  return store.vrstvy(postava).find(one => one.typ === typ && one.varianta === varianta
    && (one.stav === 'hotovo' || one.stav === 'schvaleno') && one.soubor && fs.existsSync(one.soubor));
}

export function nactiVrstvu(postava: string, typ: ZkVrstvaTyp, varianta: string): Obraz | null {
  const v = najdiVrstvu(postava, typ, varianta);
  return v ? nacti(fs.readFileSync(v.soubor)) : null;
}

/** Kov ke kšandám (spony, posuvky) ve skutečné barvě — nebo nic. */
export function nactiKov(postava: string, typ: ZkVrstvaTyp, varianta: string): Obraz | null {
  const v = najdiVrstvu(postava, typ, varianta);
  return v?.kov && fs.existsSync(v.kov) ? nacti(fs.readFileSync(v.kov)) : null;
}

function vzorekZDat(data: string | undefined): Obraz | null {
  const shoda = /^data:image\/png;base64,(.+)$/.exec(data || '');
  if (!shoda) return null;
  try { return nacti(Buffer.from(shoda[1], 'base64')); } catch { return null; }
}

/**
 * Šablona oblečená do látky výrobku — totéž, co kreslí kabina (`oblec`
 * ve skriptu): vzorek v dlaždicích ve skutečné velikosti, pod ním mapa
 * světla tvrdým světlem. U kapesníčku je vzorek roh výrobku natažený
 * přes tvar.
 *
 * Tohle dostane model jako výchozí bod. Dřív dostal tvar v jedné barvě
 * a pestrou kravatu s květy si musel vymyslet celou — a vymyslel ji
 * jinak (Patrik, 25. 11.).
 */
export function oblecVzorkem(
  sablona: Obraz,
  kus: { hex: string; vzorek?: string; vzorekCm?: number },
  meritko: number,
  naCm: number
): Obraz {
  const { sirka, vyska } = sablona;
  const out = novyObraz(sirka, vyska);
  const zaklad = barvaPodMapu(kus.hex || '#808080');
  const vz = vzorekZDat(kus.vzorek);
  let roh: { obraz: Obraz; x: number; y: number; w: number; h: number } | null = null;
  let zmenseni = 1;
  if (vz && (kus.vzorekCm ?? 0) < 0) {
    const maska = new Uint8Array(sirka * vyska);
    for (let i = 0; i < maska.length; i++) maska[i] = sablona.body[i * 4 + 3] > 8 ? 255 : 0;
    const o = px.okraje(maska, sirka, vyska);
    if (o.w > 0 && o.h > 0) roh = { obraz: px.prevzorkuj(vz, o.w, o.h), x: o.x, y: o.y, w: o.w, h: o.h };
  } else if (vz) {
    const cm = (kus.vzorekCm || 2.8) * (meritko || 1);
    zmenseni = Math.max(0.05, (cm * naCm) / Math.max(1, vz.sirka));
  }
  for (let y = 0; y < vyska; y++) {
    for (let x = 0; x < sirka; x++) {
      const i = (y * sirka + x) * 4;
      const a = sablona.body[i + 3];
      if (!a) continue;
      let r = zaklad.r; let g = zaklad.g; let b = zaklad.b;
      if (roh) {
        const rx = x - roh.x; const ry = y - roh.y;
        if (rx >= 0 && ry >= 0 && rx < roh.w && ry < roh.h) {
          const j = (ry * roh.w + rx) * 4;
          const va = roh.obraz.body[j + 3] / 255;
          r = roh.obraz.body[j] * va + r * (1 - va);
          g = roh.obraz.body[j + 1] * va + g * (1 - va);
          b = roh.obraz.body[j + 2] * va + b * (1 - va);
        }
      } else if (vz) {
        const sx = Math.floor(x / zmenseni) % vz.sirka;
        const sy = Math.floor(y / zmenseni) % vz.vyska;
        const j = (sy * vz.sirka + sx) * 4;
        if (vz.body[j + 3] > 0) { r = vz.body[j]; g = vz.body[j + 1]; b = vz.body[j + 2]; }
      }
      const stin = sablona.body[i];
      out.body[i] = hardLight(r, stin);
      out.body[i + 1] = hardLight(g, stin);
      out.body[i + 2] = hardLight(b, stin);
      out.body[i + 3] = a;
    }
  }
  return out;
}

/* ---------------------------------------------------------- paleta */

const CHROMA = 7;
const JAS = 3;

/**
 * Rozložení barev uvnitř tvaru — odolné vůči stínům.
 *
 * Fotorealistický kus má jiné stíny než plochá šablona: záhyb je o pětinu
 * tmavší, odlesk světlejší. Obyčejný histogram RGB to bral jako jinou
 * barvu (stín o 15 % = shoda 39 %). Proto se dělí na:
 *  * **odstín** — poměr složek, který stín nemění (7 × 7 přihrádek),
 *  * **jas** — hrubě (3 přihrádky) a srovnaný na průměr kusu jen napůl,
 *    aby bílá a černá kravata zůstaly rozlišené.
 * Přihrádky jsou měkké: bod se dělí mezi sousední podle vzdálenosti.
 */
export function paleta(o: Obraz, tvar: Obraz): Float64Array {
  let suma = 0; let n = 0;
  for (let i = 0; i < tvar.body.length; i += 4) {
    if (tvar.body[i + 3] < 200) continue;
    suma += px.svetlostBodu(o.body[i], o.body[i + 1], o.body[i + 2]); n += 1;
  }
  const h = new Float64Array(CHROMA * CHROMA * JAS);
  if (!n) return h;
  const srovnani = Math.pow(128 / Math.max(8, suma / n), 0.3);
  let vaha = 0;
  for (let i = 0; i < tvar.body.length; i += 4) {
    if (tvar.body[i + 3] < 200) continue;
    const r = o.body[i]; const g = o.body[i + 1]; const b = o.body[i + 2];
    const s = r + g + b + 30;
    /* Odstín: dvě protilehlé osy (červená–zelená, žlutá–modrá) v rozsahu ±0,6 */
    const c1 = Math.max(0, Math.min(1, ((r - g) / s + 0.6) / 1.2)) * (CHROMA - 1);
    const c2 = Math.max(0, Math.min(1, (((r + g) / 2 - b) / s + 0.6) / 1.2)) * (CHROMA - 1);
    const l = Math.max(0, Math.min(1, (px.svetlostBodu(r, g, b) * srovnani) / 255)) * (JAS - 1);
    const f = [c1, c2, l];
    const N = [CHROMA, CHROMA, JAS];
    const z = f.map((v, k) => Math.min(N[k] - 2, Math.floor(v)));
    const d = f.map((v, k) => v - z[k]);
    for (let roh = 0; roh < 8; roh++) {
      const b0 = roh & 1; const b1 = (roh >> 1) & 1; const b2 = (roh >> 2) & 1;
      const w = (b0 ? d[0] : 1 - d[0]) * (b1 ? d[1] : 1 - d[1]) * (b2 ? d[2] : 1 - d[2]);
      if (w <= 0) continue;
      h[((z[0] + b0) * CHROMA + (z[1] + b1)) * JAS + (z[2] + b2)] += w;
      vaha += w;
    }
  }
  if (vaha > 0) for (let k = 0; k < h.length; k++) h[k] /= vaha;
  return h;
}

/** Shoda dvou palet 0–1 (průnik histogramů). */
export function shodaPalet(a: Float64Array, b: Float64Array): number {
  let s = 0;
  for (let k = 0; k < a.length; k++) s += Math.min(a[k], b[k]);
  return s;
}

/** Pod tuhle shodu palet se výsledek označí „Nesedí" (ověřeno na pruzích a květech v testu). */
export const MEZ_SHODY = 0.5;

/**
 * Fotka výrobku oříznutá na výrobek: na celé fotce je výrobek často
 * malý uprostřed bílé plochy a model z ní bere málo detailu.
 */
export function oriznutaFotka(o: Obraz): Obraz {
  try {
    const pozadi = px.pozadiOdKraje(o);
    const vyrobek = new Uint8Array(pozadi.length);
    for (let i = 0; i < pozadi.length; i++) vyrobek[i] = pozadi[i] ? 0 : 255;
    const k = px.okraje(vyrobek, o.sirka, o.vyska);
    if (k.w < 20 || k.h < 20 || k.podil > 0.9) return o;
    const okraj = Math.round(0.06 * Math.max(k.w, k.h));
    const x = Math.max(0, k.x - okraj); const y = Math.max(0, k.y - okraj);
    const w = Math.min(o.sirka - x, k.w + 2 * okraj); const h = Math.min(o.vyska - y, k.h + 2 * okraj);
    return px.vyrizniObdelnik(o, { x, y, w, h });
  } catch {
    return o;
  }
}

/** Postava s kulisou v obvyklých barvách — model kreslí do známého prostředí. */
const kulisy = new Map<string, { klic: string; obraz: Obraz }>();

/**
 * Postava s kulisou v obvyklých barvách — model kreslí do známého prostředí.
 *
 * Skládá se z pěti PNG po půldruhém megabajtu; při schvalování se kulisa
 * ukazuje u každého produktu znovu, proto se drží v paměti, dokud se
 * žádná z vrstev nezmění (klíčem jsou časy souborů).
 */
export function kulisa(postavaId: string, sako: boolean, sirka: number, vyska: number): Obraz | null {
  const soubory = store.vrstvy(postavaId)
    .filter(one => ['postava', 'boty', 'kalhoty', 'kosile', 'sako'].includes(one.typ) && one.soubor && fs.existsSync(one.soubor))
    .map(one => `${one.typ}:${one.varianta}:${one.stav}:${fs.statSync(one.soubor).mtimeMs}`).join('|');
  const klic = `${postavaId}|${sako}|${sirka}x${vyska}`;
  const mam = kulisy.get(klic);
  if (mam && mam.klic === soubory) return mam.obraz;
  const obraz = slozKulisu(postavaId, sako, sirka, vyska);
  if (obraz) {
    kulisy.set(klic, { klic: soubory, obraz });
    if (kulisy.size > 12) kulisy.delete(kulisy.keys().next().value as string);
  }
  return obraz;
}

function slozKulisu(postavaId: string, sako: boolean, sirka: number, vyska: number): Obraz | null {
  const zaklad = nactiVrstvu(postavaId, 'postava', 'zaklad');
  if (!zaklad) return null;
  const kusy: { obraz: Obraz; hex?: string }[] = [{ obraz: zaklad }];
  for (const [typ, varianta] of [['boty', 'spolecenske'], ['kalhoty', 'oblekove'], ['kosile', 'klasicka']] as const) {
    const o = nactiVrstvu(postavaId, typ, varianta);
    if (o) kusy.push({ obraz: o, hex: ZK_PODKLAD_HEX[typ] });
  }
  if (sako) {
    const o = nactiVrstvu(postavaId, 'sako', 'jednoradove');
    if (o) kusy.push({ obraz: o, hex: ZK_PODKLAD_HEX.sako });
  }
  return px.slozeni(kusy, sirka, vyska);
}

/**
 * Výřez kolem kusu: okraj kolem šablony a poměr stran, který model umí.
 * Volné rozměry (novější modely) — co nejblíž tvaru; jinak tři pevné.
 */
export function vyrez(okraje: px.Okraje, sirka: number, vyska: number, naCm: number): { x: number; y: number; w: number; h: number; W: number; H: number } {
  const okraj = Math.max(3 * naCm, 0.35 * Math.max(okraje.w, okraje.h));
  let x = okraje.x - okraj; let y = okraje.y - okraj;
  let w = okraje.w + 2 * okraj; let h = okraje.h + 2 * okraj;
  const volne = obrazky.model().volneRozmery;
  let pomer = Math.max(1 / 2.5, Math.min(2.5, w / h));
  if (!volne) pomer = pomer < 0.8 ? 1024 / 1536 : pomer > 1.25 ? 1536 / 1024 : 1;
  /* Dorovnat na poměr: přidat tam, kde chybí */
  if (w / h < pomer) { const nw = h * pomer; x -= (nw - w) / 2; w = nw; } else { const nh = w / pomer; y -= (nh - h) / 2; h = nh; }
  /* Do plátna — posunout, případně zmenšit */
  w = Math.min(w, sirka); h = Math.min(h, vyska);
  x = Math.max(0, Math.min(sirka - w, x)); y = Math.max(0, Math.min(vyska - h, y));
  let W: number; let H: number;
  if (volne) {
    const bodu = Math.max(obrazky.NEJMENE_BODU, 1_050_000);
    W = Math.round(Math.sqrt(bodu * (w / h)) / 16) * 16;
    H = Math.round(Math.sqrt(bodu / (w / h)) / 16) * 16;
  } else {
    [W, H] = pomer < 0.8 ? [1024, 1536] : pomer > 1.25 ? [1536, 1024] : [1024, 1024];
  }
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h), W, H };
}

/**
 * Kontrola výsledku uvnitř tvaru šablony:
 *  * kolik se změnilo proti vstupu (nic = model jen vrátil, co dostal),
 *  * jak moc se rozložení barev liší od látky, kterou model dostal.
 *
 * Nic z toho nestojí kredit — počítá se z obrázku, který už je zaplacený.
 */
export function zkontroluj(vstup: Obraz, vysledek: Obraz, tvar: Obraz): { zmena: number; shoda: number; potiz: string } {
  let n = 0; let stejne = 0;
  for (let i = 0; i < tvar.body.length; i += 4) {
    if (tvar.body[i + 3] < 200) continue;
    n += 1;
    const d = Math.abs(vstup.body[i] - vysledek.body[i]) + Math.abs(vstup.body[i + 1] - vysledek.body[i + 1])
      + Math.abs(vstup.body[i + 2] - vysledek.body[i + 2]);
    if (d < 12) stejne += 1;
  }
  if (!n) return { zmena: 0, shoda: 0, potiz: 'Šablona kusu je prázdná.' };
  const zmena = 1 - stejne / n;
  const shoda = shodaPalet(paleta(vstup, tvar), paleta(vysledek, tvar));
  if (zmena < 0.05) {
    return { zmena, shoda, potiz: 'Model obrázek skoro nezměnil — výsledek je stejný jako šablona se vzorkem.' };
  }
  if (shoda < MEZ_SHODY) {
    return {
      zmena, shoda,
      potiz: `Barvy nebo vzor se odchylují od látky výrobku (shoda ${Math.round(shoda * 100)} %). Podívej se na náhled — když vypadá dobře, dej „Přesto použít".`
    };
  }
  return { zmena, shoda, potiz: '' };
}

/* ------------------------------------------------------------ jeden kus */

export interface VykresleniVysledek { kod: string; cast: number; postava: string; stav: string; potiz: string }

/**
 * Vykreslí jeden kus (hlavní nebo část sady) na jednu postavu — jedním
 * požadavkem, bez automatického opakování.
 *
 * `fotky` jde podvrhnout (zkoušky); jinak se stáhnou z katalogu.
 * `nahradit`: i nepovedený výsledek přepíše předchozí dobré vykreslení
 * (člověk klikl na „Nakreslit znovu" a chce vidět nový). Hromadný běh
 * dobré vykreslení nepovedeným nepřepíše.
 */
export async function vykresliKus(
  kod: string,
  cast: number,
  postavaId: string,
  moznosti: { fotky?: Obraz[]; nahradit?: boolean } = {}
): Promise<VykresleniVysledek> {
  const row = store.produktyRows().find(one => one.kod === kod);
  if (!row || !row.typ) throw new Error('Produkt v kabině není zařazený.');
  const kus = cast < 0
    ? { typ: row.typ as ZkVrstvaTyp, varianta: row.varianta, hex: row.hex, vzorek: row.vzorek, vzorekCm: row.vzorekCm }
    : row.casti?.[cast];
  if (!kus) throw new Error('Tahle část sady neexistuje.');
  const p = store.postava(postavaId);
  if (!p || !p.hotovo) throw new Error('Postava není nakreslená.');
  const sablona = nactiVrstvu(postavaId, kus.typ, kus.varianta);
  if (!sablona) throw new Error(`Postava nemá šablonu ${kus.typ} ${kus.varianta} — nejdřív ji překresli ve Vizuálech.`);
  const kov = nactiKov(postavaId, kus.typ, kus.varianta);

  const naCm = (p.podrazka - p.temeno) / Math.max(40, p.vyskaCm);
  const maska0 = new Uint8Array(p.sirka * p.vyska);
  for (let i = 0; i < maska0.length; i++) maska0[i] = sablona.body[i * 4 + 3] > 8 ? 255 : 0;
  const kde = px.okraje(maska0, p.sirka, p.vyska);
  if (!kde.w) throw new Error('Šablona kusu je prázdná.');
  const r = vyrez(kde, p.sirka, p.vyska, naCm);

  /* Fotky se stahují dřív než cokoli se zaplatí — bez fotky se nekreslí */
  const vybrane = moznosti.fotky
    ? moznosti.fotky.map(obraz => ({ obraz, druh: 'cely' as ZkDruhFotky }))
    : await predlohy(row, cast);
  const fotky = vybrane.filter(one => one.obraz.sirka > 20).map(one => {
    /* Na modelu se neořezává — jde o poměr vzoru k tělu a kravatě */
    const o = one.druh === 'na_modelu' ? one.obraz : oriznutaFotka(one.obraz);
    const k = Math.min(1, 1024 / Math.max(o.sirka, o.vyska));
    return { druh: one.druh, obraz: k < 1 ? px.prevzorkuj(o, Math.round(o.sirka * k), Math.round(o.vyska * k)) : o };
  });
  if (!fotky.length) throw new Error('Produkt nemá fotku, podle které by se dal nakreslit.');

  /* Vstup: postava s kulisou a na místě kusu skutečná látka pod mapou světla */
  const scena = kulisa(postavaId, kus.typ === 'kapesnicek', p.sirka, p.vyska);
  if (!scena) throw new Error('Postava nemá základ.');
  const latka = oblecVzorkem(sablona, kus, row.meritko ?? 1, naCm);
  const sKusem = px.slozeni([{ obraz: scena }, { obraz: latka }, ...(kov ? [{ obraz: kov }] : [])], p.sirka, p.vyska);
  const vstup = px.prevzorkuj(px.vyrizniObdelnik(sKusem, r), r.W, r.H);
  const tvarVyrezu = px.prevzorkuj(px.vyrizniObdelnik(sablona, r), r.W, r.H);
  /* Maska: průhledné = smí se kreslit (tvar šablony), jinak neprůhledné */
  const maska = novyObraz(r.W, r.H);
  for (let i = 0; i < maska.body.length; i += 4) maska.body[i + 3] = tvarVyrezu.body[i + 3] > 8 ? 0 : 255;

  const sada = (row.casti?.length ?? 0) > 0;
  const rozpoznany = row.ai?.kusy.find(one => one.cast === cast && one.typ);
  const zadani = zadaniVykresleni(kus.typ, kus.varianta, sada, rozpoznany?.popis ?? '', fotky.map(one => one.druh), rozpoznany?.mira);
  const vysledek = px.prevzorkuj(await kreslir(zadani, vstup, maska, fotky.map(one => one.obraz)), r.W, r.H);
  const k = zkontroluj(vstup, vysledek, tvarVyrezu);
  const potiz = k.potiz;

  const soubor = store.cestaVykresleni(postavaId, kod, cast);
  const nahled = store.cestaVykresleni(postavaId, kod, cast, true);
  /* Hromadný běh: nepovedené nové nepřepíše dobré staré */
  const stare = store.vykresleni(kod).find(one => one.cast === cast && one.postava === postavaId);
  if (potiz && !moznosti.nahradit && stare && stare.soubor && fs.existsSync(stare.soubor)
    && (stare.stav === 'hotovo' || stare.stav === 'schvaleno') && stare.varianta === kus.varianta) {
    return { kod, cast, postava: postavaId, stav: 'nesedi', potiz: `${potiz} Zůstává předchozí vykreslení.` };
  }

  /* Vrstva ve dvojnásobném rozlišení; průhlednost z šablony (tvar sedí na límec a kapsu) */
  const W2 = r.w * MERITKO; const H2 = r.h * MERITKO;
  const obraz = px.prevzorkuj(vysledek, W2, H2);
  const tvar = px.prevzorkuj(px.vyrizniObdelnik(sablona, r), W2, H2);
  for (let i = 0; i < obraz.body.length; i += 4) obraz.body[i + 3] = tvar.body[i + 3];
  fs.writeFileSync(soubor, uloz(obraz));
  /* Náhled do okna — uloží se vždy, i u nepovedeného: člověk musí vidět, co je špatně */
  const scenaVyrez = px.vyrizniObdelnik(scena, r);
  const maly = px.slozeni([{ obraz: scenaVyrez }, { obraz: px.prevzorkuj(obraz, r.w, r.h) }], r.w, r.h);
  const zm = Math.min(1, 320 / Math.max(r.w, r.h));
  fs.writeFileSync(nahled, uloz(px.prevzorkuj(maly, Math.max(1, Math.round(r.w * zm)), Math.max(1, Math.round(r.h * zm)))));

  store.zapisVykresleni({
    kod, cast, postava: postavaId, typ: kus.typ, varianta: kus.varianta, soubor, nahled,
    x: r.x, y: r.y, w: r.w, h: r.h, stav: potiz ? 'nesedi' : 'hotovo', potiz, model: obrazky.model().id,
    kdy: new Date().toISOString()
  });
  return { kod, cast, postava: postavaId, stav: potiz ? 'nesedi' : 'hotovo', potiz };
}

/* ------------------------------------------------- nová šablona, stará kresba */

/** Úseky masky v jednom řádku (od, do včetně). */
function useky(maska: Uint8Array, w: number, y: number): [number, number][] {
  const out: [number, number][] = [];
  let od = -1;
  for (let x = 0; x < w; x++) {
    const v = maska[y * w + x];
    if (v && od < 0) od = x;
    if (!v && od >= 0) { out.push([od, x - 1]); od = -1; }
  }
  if (od >= 0) out.push([od, w - 1]);
  return out;
}

/**
 * Kresba od AI přetvarovaná na nový tvar šablony — bez nového kreslení.
 *
 * Patrik (25. 11.): „bylo by dobré, kdyby AI vygenerované obrázky se
 * nemusely znovu generovat, kdyby se změnila šablona, ale dokázaly se
 * přizpůsobit, ideálně bez AI". Kravata se po posunu límce nebo pasu
 * jen posune, prodlouží nebo zúží; realistická šablona doladí obrys
 * o pár bodů. Kresba se proto přetáhne **řádek po řádku**: výška podle
 * horního a dolního okraje tvaru, v každém řádku každý úsek (list
 * kravaty, pásek kšand) na odpovídající úsek nového tvaru. Vzor
 * i záhyby zůstanou, jen se natáhnou o tolik, o kolik se změnil tvar.
 *
 * `stara`: kresba (s průhledností tvaru, ve kterém vznikla) a její
 * obdélník na postavě; `nova`: šablona přes celé plátno. Vrací novou
 * kresbu ve stejném měřítku (`m` bodů kresby na bod postavy).
 */
export function prizpusobKresbu(
  stara: Obraz,
  r: { x: number; y: number; w: number; h: number },
  nova: Obraz,
  m = MERITKO
): { obraz: Obraz; x: number; y: number; w: number; h: number; shoda: number } | null {
  /* Starý tvar v bodech kresby, nový v bodech postavy → obojí na měřítko kresby */
  const W0 = stara.sirka; const H0 = stara.vyska;
  const stary = new Uint8Array(W0 * H0);
  for (let i = 0; i < stary.length; i++) stary[i] = stara.body[i * 4 + 3] > 128 ? 255 : 0;
  const maskaNove = new Uint8Array(nova.sirka * nova.vyska);
  for (let i = 0; i < maskaNove.length; i++) maskaNove[i] = nova.body[i * 4 + 3] > 8 ? 255 : 0;
  const kde = px.okraje(maskaNove, nova.sirka, nova.vyska);
  if (!kde.w) return null;
  const okraj = 4;
  const r2 = {
    x: Math.max(0, kde.x - okraj), y: Math.max(0, kde.y - okraj),
    w: Math.min(nova.sirka, kde.x + kde.w + okraj) - Math.max(0, kde.x - okraj),
    h: Math.min(nova.vyska, kde.y + kde.h + okraj) - Math.max(0, kde.y - okraj)
  };
  const tvar = px.prevzorkuj(px.vyrizniObdelnik(nova, r2), r2.w * m, r2.h * m);
  const W1 = tvar.sirka; const H1 = tvar.vyska;
  const novy = new Uint8Array(W1 * H1);
  for (let i = 0; i < novy.length; i++) novy[i] = tvar.body[i * 4 + 3] > 128 ? 255 : 0;

  /* Shoda tvarů na postavě — skoro stejné se nepřetahuje (jen by se rozmazalo) */
  let oba = 0; let jeden = 0;
  for (let gy = Math.min(r.y, r2.y); gy < Math.max(r.y + r.h, r2.y + r2.h); gy++) {
    for (let gx = Math.min(r.x, r2.x); gx < Math.max(r.x + r.w, r2.x + r2.w); gx++) {
      const sx = Math.round((gx - r.x) * m + m / 2); const sy = Math.round((gy - r.y) * m + m / 2);
      const a = sx >= 0 && sy >= 0 && sx < W0 && sy < H0 && stary[sy * W0 + sx] > 0;
      const nx = Math.round((gx - r2.x) * m + m / 2); const ny = Math.round((gy - r2.y) * m + m / 2);
      const b = nx >= 0 && ny >= 0 && nx < W1 && ny < H1 && novy[ny * W1 + nx] > 0;
      if (a && b) oba += 1;
      if (a || b) jeden += 1;
    }
  }
  const shoda = jeden ? oba / jeden : 1;

  /* Svislé okraje obou tvarů (v bodech postavy) */
  const radky = (mm: Uint8Array, w: number, h: number) => {
    let od = -1; let po = -1;
    for (let y = 0; y < h; y++) {
      let je = false;
      for (let x = 0; x < w; x++) if (mm[y * w + x]) { je = true; break; }
      if (je) { if (od < 0) od = y; po = y; }
    }
    return { od, po };
  };
  const rs = radky(stary, W0, H0); const rn = radky(novy, W1, H1);
  if (rs.od < 0 || rn.od < 0) return null;

  const out = novyObraz(W1, H1);
  const vzorek = (x: number, y: number, c: number) => {
    const x0 = Math.max(0, Math.min(W0 - 1, Math.floor(x))); const y0 = Math.max(0, Math.min(H0 - 1, Math.floor(y)));
    const x1 = Math.min(W0 - 1, x0 + 1); const y1 = Math.min(H0 - 1, y0 + 1);
    const tx = Math.max(0, Math.min(1, x - x0)); const ty = Math.max(0, Math.min(1, y - y0));
    const v = (xx: number, yy: number) => stara.body[(yy * W0 + xx) * 4 + c];
    return (v(x0, y0) * (1 - tx) + v(x1, y0) * tx) * (1 - ty) + (v(x0, y1) * (1 - tx) + v(x1, y1) * tx) * ty;
  };
  for (let y = 0; y < H1; y++) {
    const nove = useky(novy, W1, y);
    if (!nove.length) continue;
    const t = rn.po > rn.od ? (y - rn.od) / (rn.po - rn.od) : 0;
    let ys = Math.round(rs.od + t * (rs.po - rs.od));
    let stare = useky(stary, W0, Math.max(0, Math.min(H0 - 1, ys)));
    /* Řádek bez kresby (nový tvar je jinde delší) — nejbližší řádek, kde kresba je */
    for (let d = 1; !stare.length && d < 40; d++) {
      for (const kand of [ys - d, ys + d]) {
        if (kand < 0 || kand >= H0 || stare.length) continue;
        const u = useky(stary, W0, kand);
        if (u.length) { stare = u; ys = kand; }
      }
    }
    if (!stare.length) continue;
    /* Párování úseků: stejný počet po pořadí, jinak celý rozsah na celý rozsah */
    const pary: [[number, number], [number, number]][] = nove.length === stare.length
      ? nove.map((u, i) => [u, stare[i]])
      : [[[nove[0][0], nove[nove.length - 1][1]], [stare[0][0], stare[stare.length - 1][1]]]];
    const yOld = rs.od + t * (rs.po - rs.od);
    for (const [[a0, a1], [b0, b1]] of pary) {
      for (let x = a0; x <= a1; x++) {
        const i = (y * W1 + x) * 4;
        if (!novy[y * W1 + x] && pary.length > 1) continue;
        const u = a1 > a0 ? (x - a0) / (a1 - a0) : 0.5;
        const xs = b0 + u * (b1 - b0);
        out.body[i] = Math.round(vzorek(xs, yOld, 0));
        out.body[i + 1] = Math.round(vzorek(xs, yOld, 1));
        out.body[i + 2] = Math.round(vzorek(xs, yOld, 2));
        out.body[i + 3] = tvar.body[i + 3];
      }
    }
  }
  return { obraz: out, x: r2.x, y: r2.y, w: r2.w, h: r2.h, shoda };
}

/**
 * Po změně šablony přizpůsobí všechna vykreslení té šablony na postavě.
 * Volá se samo (sablony.naZmenuSablony); vrací počet přizpůsobených.
 */
export function prizpusobVykresleni(postavaId: string, typ: ZkVrstvaTyp, varianta: string): number {
  const sablona = nactiVrstvu(postavaId, typ, varianta);
  if (!sablona) return 0;
  const p = store.postava(postavaId);
  let hotovo = 0;
  for (const v of store.vykresleni().filter(one => one.postava === postavaId && one.typ === typ && one.varianta === varianta)) {
    if (!v.soubor || !fs.existsSync(v.soubor)) continue;
    try {
      const stara = nacti(fs.readFileSync(v.soubor));
      const m = stara.sirka / Math.max(1, v.w);
      const r = prizpusobKresbu(stara, { x: v.x, y: v.y, w: v.w, h: v.h }, sablona, m);
      if (!r || r.shoda > 0.985) continue;
      fs.writeFileSync(v.soubor, uloz(r.obraz));
      /* Náhled do okna znovu: kus na modelu */
      if (p && v.nahled) {
        const scena = kulisa(postavaId, typ === 'kapesnicek', p.sirka, p.vyska);
        if (scena) {
          const rr = { x: r.x, y: r.y, w: r.w, h: r.h };
          const maly = px.slozeni([{ obraz: px.vyrizniObdelnik(scena, rr) }, { obraz: px.prevzorkuj(r.obraz, r.w, r.h) }], r.w, r.h);
          const zm = Math.min(1, 320 / Math.max(r.w, r.h));
          fs.writeFileSync(v.nahled, uloz(px.prevzorkuj(maly, Math.max(1, Math.round(r.w * zm)), Math.max(1, Math.round(r.h * zm)))));
        }
      }
      store.zapisVykresleni({
        ...v, x: r.x, y: r.y, w: r.w, h: r.h,
        potiz: v.potiz && !/Přizpůsobeno/.test(v.potiz) ? v.potiz : '',
        kdy: v.kdy
      });
      hotovo += 1;
    } catch { /* poškozená kresba zůstane, jak byla */ }
  }
  return hotovo;
}

naZmenuSablony((postava, typ, varianta) => { prizpusobVykresleni(postava, typ, varianta); });

/* ------------------------------------------------------------ dávka */

/** Které postavy se ke kusu hodí: podle věku produktu, dospělý jinak. */
function postavyPro(proVek?: ZkVek[]): string[] {
  const veky = proVek?.length ? proVek : ['dospely'];
  return store.postavy().filter(one => one.hotovo && veky.includes(one.vek)).map(one => one.id);
}

export interface PlanVykresleni { kod: string; cast: number; postava: string; nazev: string }

/** Co se vykreslí: `chybi` = co ještě nemá vykreslení, `vse` = i znovu (kromě schválených). */
export function plan(rozsah: 'chybi' | 'vse', kody?: string[]): PlanVykresleni[] {
  const hotove = new Map(store.vykresleni().map(one => [`${one.kod}|${one.cast}|${one.postava}`, one]));
  const out: PlanVykresleni[] = [];
  for (const p of proKabinu(1000)) {
    if (kody && !kody.includes(p.kod)) continue;
    const kusy = [{ cast: -1 }, ...(p.casti ?? []).map((_, i) => ({ cast: i }))];
    for (const postava of postavyPro(p.proVek)) {
      for (const k of kusy) {
        const mam = hotove.get(`${p.kod}|${k.cast}|${postava}`);
        if (mam && (mam.stav === 'schvaleno' || mam.stav === 'zamitnuto')) continue;
        if (rozsah === 'chybi' && mam && mam.stav === 'hotovo') continue;
        out.push({ kod: p.kod, cast: k.cast, postava, nazev: p.nazev });
      }
    }
  }
  return out;
}

export function odhad(rozsah: 'chybi' | 'vse'): { kusu: number; usd: number } {
  const kusu = plan(rozsah).length;
  /* Každý kus jeden požadavek — automatické opakování už není */
  return { kusu, usd: Math.round(kusu * obrazky.cenaObrazku() * 100) / 100 };
}

/** Kolik obrázků se kreslí naráz. Jeden trvá minutu i víc; tři naráz zkrátí dávku na třetinu. */
export function soubezne(): number {
  return Math.max(1, Math.min(6, Number(getSetting('zkSoubezne', '3')) || 3));
}

/**
 * Úkoly po několika naráz. Když jeden narazí na chybu, kterou další kus
 * nespraví (strop, klíč, ověření organizace), nové se už nezačínají.
 */
export async function poSkupinach<T>(
  ukoly: T[],
  naraz: number,
  udelej: (ukol: T, poradi: number) => Promise<void>
): Promise<void> {
  let dalsi = 0;
  let stop = false;
  const pracant = async () => {
    while (!stop && dalsi < ukoly.length) {
      const poradi = dalsi++;
      try {
        await udelej(ukoly[poradi], poradi);
      } catch (e: any) {
        if (/strop|klíč|API key|credit|verif|401|403|kredit|billing/i.test(String(e?.message ?? e))) stop = true;
        throw e;
      }
    }
  };
  const vysledky = await Promise.allSettled(Array.from({ length: Math.min(naraz, ukoly.length) }, () => pracant()));
  const chyba = vysledky.find(one => one.status === 'rejected') as PromiseRejectedResult | undefined;
  if (chyba && stop) throw chyba.reason;
}

export async function vykresliVse(
  rozsah: 'chybi' | 'vse',
  hlas?: (p: { hotovo: number; celkem: number; co: string }) => void,
  kody?: string[]
): Promise<{ hotovo: number; nesedi: number; chyb: number; posledniChyba: string }> {
  const ukoly = plan(rozsah, kody);
  let hotovo = 0; let nesedi = 0; let chyb = 0; let posledniChyba = '';
  let dokonceno = 0;
  const jeden = async (u: PlanVykresleni) => {
    hlas?.({ hotovo: dokonceno, celkem: ukoly.length, co: `Vykresluji ${u.nazev} (${dokonceno + 1} z ${ukoly.length})` });
    try {
      /* Konkrétní produkt (Nakreslit znovu) nahradí i dobré staré; hromadný běh ne */
      const r = await vykresliKus(u.kod, u.cast, u.postava, { nahradit: !!kody });
      if (r.stav === 'hotovo') hotovo += 1; else nesedi += 1;
    } catch (e: any) {
      chyb += 1;
      posledniChyba = String(e?.message ?? e);
      throw e;
    } finally {
      dokonceno += 1;
    }
  };
  try {
    await poSkupinach(ukoly, soubezne(), async u => {
      try { await jeden(u); } catch (e: any) {
        /* Strop, klíč, ověření organizace — dalším kusem se to nespraví */
        if (/strop|klíč|verif|401|403|kredit|billing/i.test(String(e?.message ?? e))) throw e;
      }
    });
  } catch { /* chyba je v posledniChyba */ }
  setSetting('zkVykreslenoKdy', new Date().toISOString());
  return { hotovo, nesedi, chyb, posledniChyba };
}

/* ------------------------------------------------------- schvalování */

/**
 * Produkt na modelu tak, jak ho uvidí zákazník — složený tady, zadarmo.
 *
 * Patrik (25. 11.): „zaměř se i na UI/UX práce s katalogem a postupným
 * vygenerováním a schválením každého produktu". Schvaluje se podle toho,
 * jak kus vypadá **na modelu** (šablona + látka z fotky ve změřeném
 * měřítku, nebo vykreslení od AI, když je), ne podle dlaždice vzorku.
 * Výřez je kolem kusu (kravata od límce po pas, motýlek s krkem), ať jsou
 * vidět detaily vzoru.
 */
export function nahledProduktu(kod: string, postavaId?: string, vyska = 560): { obraz: string; postava: string; vykresleno: boolean } {
  const row = store.produktyRows().find(one => one.kod === kod);
  if (!row || !row.typ) throw new Error('Produkt nemá zařazení v kabině.');
  const proVek = proKabinu(1000, true).find(one => one.kod === kod)?.proVek;
  const postava = postavaId && store.postava(postavaId)?.hotovo ? postavaId
    : postavyPro(proVek)[0] ?? store.postavy().find(one => one.hotovo)?.id;
  const p = postava ? store.postava(postava) : null;
  if (!p || !postava) throw new Error('Žádná postava není nakreslená — nejdřív Vizuály.');
  const naCm = (p.podrazka - p.temeno) / Math.max(40, p.vyskaCm);
  const kusy = [
    { cast: -1, typ: row.typ as ZkVrstvaTyp, varianta: row.varianta, hex: row.hex, vzorek: row.vzorek, vzorekCm: row.vzorekCm },
    ...(row.casti ?? []).map((c, i) => ({ cast: i, ...c }))
  ];
  const scena = kulisa(postava, kusy.some(one => one.typ === 'kapesnicek'), p.sirka, p.vyska);
  if (!scena) throw new Error('Postava nemá základ.');
  const vrstvy: { obraz: Obraz }[] = [{ obraz: scena }];
  const kde = new Uint8Array(p.sirka * p.vyska);
  let vykresleno = false;
  const hotova = store.vykresleni(kod).filter(one => one.postava === postava && (one.stav === 'hotovo' || one.stav === 'schvaleno'));
  /* Kšandy pod kravatou, kapesníček nakonec — stejně jako v kabině */
  const poradi = (t: string) => (t === 'ksandy' ? 0 : t === 'kapesnicek' ? 2 : 1);
  for (const k of [...kusy].sort((a, b) => poradi(a.typ) - poradi(b.typ))) {
    const sablona = nactiVrstvu(postava, k.typ, k.varianta);
    if (!sablona) continue;
    for (let i = 0; i < kde.length; i++) if (sablona.body[i * 4 + 3] > 8) kde[i] = 255;
    const v = hotova.find(one => one.cast === k.cast && one.varianta === k.varianta && one.soubor && fs.existsSync(one.soubor));
    if (v) {
      const maly = px.prevzorkuj(nacti(fs.readFileSync(v.soubor)), v.w, v.h);
      vrstvy.push({ obraz: px.vlozObdelnik(novyObraz(p.sirka, p.vyska), maly, { x: v.x, y: v.y, w: v.w, h: v.h }) });
      vykresleno = true;
      continue;
    }
    vrstvy.push({ obraz: oblecVzorkem(sablona, k, row.meritko ?? 1, naCm) });
    const kov = nactKovBezpecne(postava, k.typ, k.varianta);
    if (kov) vrstvy.push({ obraz: kov });
  }
  const o = px.okraje(kde, p.sirka, p.vyska);
  if (!o.w) throw new Error('Postava nemá šablonu pro tenhle kus — překresli šablony ve Vizuálech.');
  /* Výřez: kus s okrajem, aspoň 22 cm na šířku, poměr 3 : 4 */
  const okraj = 3 * naCm;
  let w = Math.max(o.w + 2 * okraj, 22 * naCm); let h = Math.max(o.h + 2 * okraj, w * 4 / 3);
  w = Math.max(w, h * 3 / 4);
  w = Math.min(w, p.sirka); h = Math.min(h, p.vyska);
  const x = Math.max(0, Math.min(p.sirka - w, o.x + o.w / 2 - w / 2));
  const y = Math.max(0, Math.min(p.vyska - h, o.y + o.h / 2 - h / 2));
  const r = { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
  const slozene = px.vyrizniObdelnik(px.slozeni(vrstvy, p.sirka, p.vyska), r);
  /* Velký náhled (okno nad mřížkou) v plném rozlišení výřezu, malý pro mřížku zmenšený */
  const cil = Math.max(200, Math.min(2400, vyska));
  const k = Math.min(1, cil / r.h);
  const maly = px.prevzorkuj(slozene, Math.max(1, Math.round(r.w * k)), Math.max(1, Math.round(r.h * k)));
  for (let i = 0; i < maly.body.length; i += 4) {
    const a = maly.body[i + 3] / 255;
    for (let c = 0; c < 3; c++) maly.body[i + c] = Math.round(maly.body[i + c] * a + 246 * (1 - a));
    maly.body[i + 3] = 255;
  }
  return { obraz: `data:image/png;base64,${uloz(maly).toString('base64')}`, postava, vykresleno };
}

function nactKovBezpecne(postava: string, typ: ZkVrstvaTyp, varianta: string): Obraz | null {
  try { return nactiKov(postava, typ, varianta); } catch { return null; }
}

/* ------------------------------------------------------------- okno */

export interface VykresleniProOkno {
  kod: string; cast: number; postava: string; typ: string; varianta: string;
  stav: string; potiz: string; kdy: string; nahled: string; nazev: string;
}

export function prehled(): VykresleniProOkno[] {
  const nazvy = new Map(proKabinu(1000, true).map(one => [one.kod, one.nazev]));
  return store.vykresleni()
    .sort((a, b) => (a.stav === 'hotovo' ? 0 : a.stav === 'nesedi' ? 1 : 2) - (b.stav === 'hotovo' ? 0 : b.stav === 'nesedi' ? 1 : 2)
      || b.kdy.localeCompare(a.kdy))
    .map(v => ({
      kod: v.kod, cast: v.cast, postava: v.postava, typ: v.typ, varianta: v.varianta,
      stav: v.stav, potiz: v.potiz, kdy: v.kdy, nazev: nazvy.get(v.kod) ?? v.kod,
      nahled: v.nahled && fs.existsSync(v.nahled) ? `data:image/png;base64,${fs.readFileSync(v.nahled).toString('base64')}` : ''
    }));
}

export function nastavStav(kod: string, cast: number, postava: string, stav: 'schvaleno' | 'zamitnuto' | 'hotovo'): void {
  store.nastavStavVykresleni(kod, cast, postava, stav);
}

/** Co jde do kabiny: hotové a schválené (zamítnuté a nesedící ne). */
export interface VykresleniDoKabiny { soubor: string; x: number; y: number; w: number; h: number; postava: string; cast: number; varianta: string }

export function doKabiny(): Map<string, VykresleniDoKabiny[]> {
  const out = new Map<string, VykresleniDoKabiny[]>();
  for (const v of store.vykresleni()) {
    if (v.stav !== 'hotovo' && v.stav !== 'schvaleno') continue;
    if (!v.soubor || !fs.existsSync(v.soubor)) continue;
    const seznam = out.get(v.kod) ?? [];
    seznam.push({ soubor: v.soubor, x: v.x, y: v.y, w: v.w, h: v.h, postava: v.postava, cast: v.cast, varianta: v.varianta });
    out.set(v.kod, seznam);
  }
  return out;
}

export const __test = { vyrez, zkontroluj, paleta, shodaPalet, oblecVzorkem, prizpusobKresbu };
