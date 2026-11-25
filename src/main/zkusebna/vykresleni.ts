import fs from 'fs';
import { setSetting } from '../db';
import { ZK_PODKLAD_HEX, ZkVrstvaTyp, ZkVek } from '../../shared/zkusebna';
import { Obraz, nacti, novyObraz, uloz } from './png';
import * as px from './pixely';
import * as store from './store';
import * as obrazky from './obrazky';
import { dekoduj, fotkyProduktu, proKabinu } from './produkty';
import { rozdilBarev } from './latka';

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
 *  4. **Kontrola:** uvnitř tvaru se musí změnit obraz (jinak model nic
 *     nenakreslil) a barvy musí sedět na výrobek z fotky. Co neprojde,
 *     zkusí se jednou znovu s důraznějším zadáním a pak se označí jako
 *     nesedící — kabina u něj zůstane u šablony se vzorkem.
 *  5. **Kontrola okem** v okně Produkty → Vykreslení: mřížka náhledů,
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

/** Zadání pro model. Krátké a jednoznačné — každé slovo navíc je prostor pro fantazii. */
export function zadaniVykresleni(typ: ZkVrstvaTyp, varianta: string, sada: boolean, znovu = ''): string {
  const kus = NAZVY_PRO_MODEL[druhKusu(typ, varianta)] ?? 'accessory';
  return [
    'Image 1 is a studio photo of a model. Inside the transparent area of the mask there is a flat placeholder of a ' + kus + '.',
    'Replace the placeholder with a photorealistic ' + kus + ' that is EXACTLY the product shown in the other image(s):',
    'the same fabric, colours, pattern, pattern size and texture' + (typ === 'ksandy' ? ', the same metal parts and clips' : '') + '.',
    sada ? 'The product photo shows a set — use only the ' + kus + ' from it.' : '',
    'Keep exactly the outline, position, size and angle of the placeholder; fill the masked shape completely.',
    'Real fabric with natural soft folds, depth and subtle highlights matching the soft studio light of image 1.',
    'Do not change anything outside the mask. Do not add any other object, text or logo.',
    znovu
  ].filter(Boolean).join(' ');
}

/* --------------------------------------------------------- kreslíř */

export type Kreslir = (zadani: string, vstup: Obraz, maska: Obraz, predlohy: Obraz[]) => Promise<Obraz>;
let kreslir: Kreslir = (zadani, vstup, maska, predlohy) => obrazky.upravPodlePredlohy(zadani, vstup, maska, predlohy);

/** Pro zkoušky: kreslíř bez OpenAI. */
export function nastavKreslire(fn: Kreslir | null): void {
  kreslir = fn ?? ((zadani, vstup, maska, predlohy) => obrazky.upravPodlePredlohy(zadani, vstup, maska, predlohy));
}

/* ---------------------------------------------------------- pomůcky */

function nactiVrstvu(postava: string, typ: ZkVrstvaTyp, varianta: string): Obraz | null {
  const v = store.vrstvy(postava).find(one => one.typ === typ && one.varianta === varianta
    && (one.stav === 'hotovo' || one.stav === 'schvaleno') && one.soubor && fs.existsSync(one.soubor));
  return v ? nacti(fs.readFileSync(v.soubor)) : null;
}

/** Postava s kulisou v obvyklých barvách — model kreslí do známého prostředí. */
function kulisa(postavaId: string, sako: boolean, sirka: number, vyska: number): Obraz | null {
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
function vyrez(okraje: px.Okraje, sirka: number, vyska: number, naCm: number): { x: number; y: number; w: number; h: number; W: number; H: number } {
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

function vyrizni(o: Obraz, r: { x: number; y: number; w: number; h: number }): Obraz {
  return px.vyrizniObdelnik(o, r);
}

/**
 * Kontrola výsledku uvnitř tvaru šablony:
 *  * kolik se změnilo proti vstupu (nic = model nekreslil),
 *  * jak daleko je průměrná barva od výrobku.
 */
export function zkontroluj(vstup: Obraz, vysledek: Obraz, tvar: Obraz, barvaVyrobku: number[] | null): { zmena: number; barva: number; potiz: string } {
  let n = 0; let stejne = 0; let r = 0; let g = 0; let b = 0;
  for (let i = 0; i < tvar.body.length; i += 4) {
    if (tvar.body[i + 3] < 200) continue;
    n += 1;
    const d = Math.abs(vstup.body[i] - vysledek.body[i]) + Math.abs(vstup.body[i + 1] - vysledek.body[i + 1])
      + Math.abs(vstup.body[i + 2] - vysledek.body[i + 2]);
    if (d < 24) stejne += 1;
    r += vysledek.body[i]; g += vysledek.body[i + 1]; b += vysledek.body[i + 2];
  }
  if (!n) return { zmena: 0, barva: 0, potiz: 'Šablona kusu je prázdná.' };
  const zmena = 1 - stejne / n;
  const barva = barvaVyrobku ? rozdilBarev([r / n, g / n, b / n], barvaVyrobku) : 0;
  if (zmena < 0.3) return { zmena, barva, potiz: 'Model kus nenakreslil — uvnitř tvaru zůstala šablona.' };
  if (barvaVyrobku && barva > 150) return { zmena, barva, potiz: 'Barvy nakresleného kusu nesedí na fotku výrobku.' };
  return { zmena, barva, potiz: '' };
}

const hexNa = (hex: string) => (/^#[0-9a-f]{6}$/i.test(hex) ? [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)) : null);

/* ------------------------------------------------------------ jeden kus */

export interface VykresleniVysledek { kod: string; cast: number; postava: string; stav: string; potiz: string }

/**
 * Vykreslí jeden kus (hlavní nebo část sady) na jednu postavu.
 * `fotky` jde podvrhnout (zkoušky); jinak se stáhnou z katalogu.
 */
export async function vykresliKus(
  kod: string,
  cast: number,
  postavaId: string,
  moznosti: { fotky?: Obraz[] } = {}
): Promise<VykresleniVysledek> {
  const row = store.produktyRows().find(one => one.kod === kod);
  if (!row || !row.typ) throw new Error('Produkt v kabině není zařazený.');
  const kus = cast < 0 ? { typ: row.typ as ZkVrstvaTyp, varianta: row.varianta, hex: row.hex } : row.casti?.[cast];
  if (!kus) throw new Error('Tahle část sady neexistuje.');
  const p = store.postava(postavaId);
  if (!p || !p.hotovo) throw new Error('Postava není nakreslená.');
  const sablona = nactiVrstvu(postavaId, kus.typ, kus.varianta);
  if (!sablona) throw new Error(`Postava nemá šablonu ${kus.typ} ${kus.varianta} — nejdřív ji překresli ve Vizuálech.`);

  const naCm = (p.podrazka - p.temeno) / Math.max(40, p.vyskaCm);
  const maska0 = new Uint8Array(p.sirka * p.vyska);
  for (let i = 0; i < maska0.length; i++) maska0[i] = sablona.body[i * 4 + 3] > 8 ? 255 : 0;
  const kde = px.okraje(maska0, p.sirka, p.vyska);
  if (!kde.w) throw new Error('Šablona kusu je prázdná.');
  const r = vyrez(kde, p.sirka, p.vyska, naCm);

  /* Vstup: postava s kulisou a šablonou v barvě výrobku na místě kusu */
  const scena = kulisa(postavaId, kus.typ === 'kapesnicek', p.sirka, p.vyska);
  if (!scena) throw new Error('Postava nemá základ.');
  const sKusem = px.slozeni([{ obraz: scena }, { obraz: sablona, hex: kus.hex || '#808080' }], p.sirka, p.vyska);
  const vstup = px.prevzorkuj(vyrizni(sKusem, r), r.W, r.H);
  const tvarVyrezu = px.prevzorkuj(vyrizni(sablona, r), r.W, r.H);
  /* Maska: průhledné = smí se kreslit (tvar šablony), jinak neprůhledné */
  const maska = novyObraz(r.W, r.H);
  for (let i = 0; i < maska.body.length; i += 4) maska.body[i + 3] = tvarVyrezu.body[i + 3] > 8 ? 0 : 255;

  let fotky = moznosti.fotky ?? [];
  if (!moznosti.fotky) {
    for (const url of fotkyProduktu(kod).slice(0, 2)) {
      try {
        const odpoved = await fetch(url);
        if (odpoved.ok) fotky.push(dekoduj(Buffer.from(await odpoved.arrayBuffer())));
      } catch { /* bez fotky se to zkusí s druhou */ }
    }
  }
  fotky = fotky.filter(one => one.sirka > 20).map(one => {
    const k = Math.min(1, 1024 / Math.max(one.sirka, one.vyska));
    return k < 1 ? px.prevzorkuj(one, Math.round(one.sirka * k), Math.round(one.vyska * k)) : one;
  });
  if (!fotky.length) throw new Error('Produkt nemá fotku, podle které by se dal nakreslit.');

  const barvaVyrobku = hexNa(kus.hex);
  const sada = (row.casti?.length ?? 0) > 0;
  let potiz = '';
  let hotovy: Obraz | null = null;
  for (let pokus = 0; pokus < 2 && !hotovy; pokus++) {
    const znovu = pokus === 0 ? '' : potiz.includes('nenakreslil')
      ? 'The previous attempt left the placeholder unchanged — this time really paint the product inside the whole masked shape.'
      : 'The previous attempt had wrong colours — copy the colours and pattern of the product photo exactly.';
    const vysledek = px.prevzorkuj(await kreslir(zadaniVykresleni(kus.typ, kus.varianta, sada, znovu), vstup, maska, fotky), r.W, r.H);
    const k = zkontroluj(vstup, vysledek, tvarVyrezu, barvaVyrobku);
    potiz = k.potiz;
    if (!potiz) hotovy = vysledek;
  }

  const soubor = store.cestaVykresleni(postavaId, kod, cast);
  const nahled = store.cestaVykresleni(postavaId, kod, cast, true);
  /* Nové kreslení se nepovedlo, ale staré je dobré → staré zůstává, jen se to řekne */
  const stare = store.vykresleni(kod).find(one => one.cast === cast && one.postava === postavaId);
  if (!hotovy && stare && stare.soubor && fs.existsSync(stare.soubor) && (stare.stav === 'hotovo' || stare.stav === 'schvaleno')
    && stare.varianta === kus.varianta) {
    return { kod, cast, postava: postavaId, stav: 'nesedi', potiz: `${potiz} Zůstává předchozí vykreslení.` };
  }
  const zaznam: store.ZkVykresleniRow = {
    kod, cast, postava: postavaId, typ: kus.typ, varianta: kus.varianta, soubor: '', nahled: '',
    x: r.x, y: r.y, w: r.w, h: r.h, stav: hotovy ? 'hotovo' : 'nesedi', potiz, model: obrazky.model().id,
    kdy: new Date().toISOString()
  };
  if (hotovy) {
    /* Vrstva ve dvojnásobném rozlišení; průhlednost z šablony (tvar sedí na límec a kapsu) */
    const W2 = r.w * MERITKO; const H2 = r.h * MERITKO;
    const obraz = px.prevzorkuj(hotovy, W2, H2);
    const tvar = px.prevzorkuj(vyrizni(sablona, r), W2, H2);
    for (let i = 0; i < obraz.body.length; i += 4) obraz.body[i + 3] = tvar.body[i + 3];
    fs.writeFileSync(soubor, uloz(obraz));
    /* Náhled do okna: kus na modelu, malý */
    const scenaVyrez = vyrizni(scena, r);
    const maly = px.slozeni([{ obraz: scenaVyrez }, { obraz: px.prevzorkuj(obraz, r.w, r.h) }], r.w, r.h);
    const k = Math.min(1, 220 / Math.max(r.w, r.h));
    fs.writeFileSync(nahled, uloz(px.prevzorkuj(maly, Math.max(1, Math.round(r.w * k)), Math.max(1, Math.round(r.h * k)))));
    zaznam.soubor = soubor;
    zaznam.nahled = nahled;
  }
  store.zapisVykresleni(zaznam);
  return { kod, cast, postava: postavaId, stav: zaznam.stav, potiz };
}

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
  /* Kus, který neprojde kontrolou, se kreslí dvakrát — počítá se s pětinou takových */
  return { kusu, usd: Math.round(kusu * 1.2 * obrazky.cenaObrazku() * 100) / 100 };
}

export async function vykresliVse(
  rozsah: 'chybi' | 'vse',
  hlas?: (p: { hotovo: number; celkem: number; co: string }) => void,
  kody?: string[]
): Promise<{ hotovo: number; nesedi: number; chyb: number; posledniChyba: string }> {
  const ukoly = plan(rozsah, kody);
  let hotovo = 0; let nesedi = 0; let chyb = 0; let posledniChyba = '';
  for (let i = 0; i < ukoly.length; i++) {
    const u = ukoly[i];
    hlas?.({ hotovo: i, celkem: ukoly.length, co: `Vykresluji ${u.nazev} (${i + 1} z ${ukoly.length})` });
    try {
      const r = await vykresliKus(u.kod, u.cast, u.postava);
      if (r.stav === 'hotovo') hotovo += 1; else nesedi += 1;
    } catch (e: any) {
      chyb += 1;
      posledniChyba = String(e?.message ?? e);
      /* Strop, klíč, ověření organizace — dalším kusem se to nespraví */
      if (/strop|klíč|verif|401|403|kredit|billing/i.test(posledniChyba)) break;
    }
  }
  setSetting('zkVykreslenoKdy', new Date().toISOString());
  return { hotovo, nesedi, chyb, posledniChyba };
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

export const __test = { vyrez, zkontroluj };
