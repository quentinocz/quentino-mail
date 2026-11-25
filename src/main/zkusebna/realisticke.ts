import fs from 'fs';
import { ZK_KRESLICI, ZK_KRESLICI_SLOVY, ZK_VRSTVY, ZkVrstva, ZkVrstvaTyp, signalniBarva } from '../../shared/zkusebna';
import { Obraz, nacti, novyObraz, uloz } from './png';
import * as px from './pixely';
import * as store from './store';
import * as obrazky from './obrazky';
import { AI_SABLONA, REVIZE, kotvyPostavy, nakresliSablonu, popisSablony } from './sablony';
import { kulisa, poSkupinach, soubezne, vyrez } from './vykresleni';

/**
 * Realistické šablony — tvar a světlo kusu od AI, látka dál z fotky.
 *
 * ## Proč
 *
 * Patrik (25. 11.): „šablony by mohly být ještě mnohem více realistické
 * a lépe sedět na modelu… nemůžu plýtvat kreditem na sto vykreslení
 * jednoho produktu, které ani nefunguje".
 *
 * Kreslená šablona je geometrie: rovné hrany, uzel z vzorečku, kšandy
 * jako pruhy s namalovanou sponou. Vypadá to „animovaně", ať je pod ní
 * látka jakkoli věrná. Vykreslit každý produkt zvlášť je drahé a u
 * každého kusu je šance, že si model vzor vymyslí.
 *
 * ## Jak
 *
 * AI dostane kreslenou šablonu v kreslicí barvě (purpurová kravata,
 * modré kšandy, zelený kapesníček) a překreslí ji na **skutečný kus
 * z hladké látky té barvy** — záhyby, uzel zastrčený pod límcem,
 * prohnutí kšand přes hrudník, kovové posuvky a spony. Z výsledku se
 * vezme jen to, co je v kreslicí barvě (tvar), a jas té barvy (mapa
 * světla). Vzor tam AI nekreslí vůbec — ten se do kabiny skládá dál
 * ze skutečné fotky výrobku, takže si ho nemůže vymyslet.
 *
 * Platí se **jednou za postavu a šablonu** (~14 obrázků na postavu),
 * ne za produkt — a zlepší to všech několik set produktů naráz.
 *
 * ## Spolehlivost
 *
 *  * AI smí kreslit jen v tvaru šablony a kousek kolem (doladí obrys).
 *  * Kontrola zadarmo: tvar musí pokrýt kreslenou šablonu (kravata 80 %,
 *    kšandy 60 %), nesmí být o moc větší, musí být v jednom kuse a mít
 *    záhyby (ne plochou barvu).
 *  * Co neprojde, se **neuloží místo šablony**, ale jako návrh s náhledem
 *    „před / po" — člověk ho může přesto použít, nebo zahodit. Kreslená
 *    šablona zůstává, dokud se nerozhodne.
 *  * Jeden pokus, žádné automatické opakování.
 */

const KUSY: Record<string, string> = {
  kravata: 'necktie with a realistic four-in-hand knot tucked under the shirt collar, the blade hanging naturally over the shirt',
  pletena: 'knitted necktie with a small knot under the collar and a square bottom end',
  motylek: 'bow tie with a realistic pinched centre knot and soft rounded wings, sitting on the collar',
  regata: 'wedding cravat (ascot) with a gathered knot and a pleated, wide blade',
  ksandy: 'pair of braces (suspenders): two elastic woven straps running over the shoulders down to the trousers waistband,'
    + ' with polished silver metal adjusters and silver metal clips gripping the waistband',
  kapesnicek: 'pocket square folded to a point, peeking out of the breast pocket of the jacket'
};

function druh(typ: ZkVrstvaTyp, varianta: string): string {
  if (typ === 'kravata') {
    if (varianta.startsWith('motylek')) return 'motylek';
    if (varianta === 'regata') return 'regata';
    if (varianta === 'pletena') return 'pletena';
    return 'kravata';
  }
  return typ;
}

export function zadaniSablony(typ: ZkVrstvaTyp, varianta: string): string {
  const kus = KUSY[druh(typ, varianta)] ?? 'accessory';
  const barva = ZK_KRESLICI_SLOVY[typ] || ZK_KRESLICI[typ];
  return [
    'Image 1 is a studio photo of a model. Inside the transparent area of the mask there is a rough, flat placeholder of a '
      + kus + ', coloured ' + barva + '.',
    'Repaint it as a photorealistic ' + kus + ' made of plain, solid, matte fabric in exactly that one colour ' + barva
      + ': no pattern, no print, no stripes, no texture motif, no logo, no second colour on the fabric.',
    'Real fabric with natural soft folds, thickness, depth, soft shadows and subtle highlights matching the soft studio light of image 1.',
    'Keep the same position, size, width and angle as the placeholder; you may refine the outline so it sits naturally on the shirt, collar and body.',
    typ === 'ksandy' ? 'The metal adjusters and clips stay polished silver metal, realistic, at the same place and size as in the placeholder.' : '',
    'Do not change the person, the shirt, the collar or anything else. Do not add any other object, text or logo.'
  ].filter(Boolean).join(' ');
}

/* --------------------------------------------------------- kreslíř */

export type KreslirSablon = (zadani: string, vstup: Obraz, maska: Obraz) => Promise<Obraz>;
let kreslir: KreslirSablon = (zadani, vstup, maska) => obrazky.upravPodlePredlohy(zadani, vstup, maska, []);

/** Pro zkoušky: kreslíř bez OpenAI. */
export function nastavKreslire(fn: KreslirSablon | null): void {
  kreslir = fn ?? ((zadani, vstup, maska) => obrazky.upravPodlePredlohy(zadani, vstup, maska, []));
}

/* ----------------------------------------------------------- soubory */

function cestyNavrhu(postavaId: string, typ: ZkVrstvaTyp, varianta: string) {
  const zaklad = store.cestaVrstvy(postavaId, typ, varianta).replace(/\.png$/, '');
  return {
    obraz: `${zaklad}-ai-navrh.png`,
    kov: `${zaklad}-ai-navrh-kov.png`,
    nahled: `${zaklad}-ai-navrh-nahled.png`,
    info: `${zaklad}-ai-navrh.json`
  };
}

export interface NavrhSablony { nahled: string; potiz: string; kdy: string }

/** Nepoužitý návrh od AI (neprošel kontrolou) — nebo nic. */
export function navrh(postavaId: string, typ: ZkVrstvaTyp, varianta: string): NavrhSablony | null {
  const c = cestyNavrhu(postavaId, typ, varianta);
  if (!fs.existsSync(c.obraz) || !fs.existsSync(c.info)) return null;
  try {
    const info = JSON.parse(fs.readFileSync(c.info, 'utf8'));
    const nahled = fs.existsSync(c.nahled) ? `data:image/png;base64,${fs.readFileSync(c.nahled).toString('base64')}` : '';
    return { nahled, potiz: String(info.potiz ?? ''), kdy: String(info.kdy ?? '') };
  } catch {
    return null;
  }
}

function smazNavrh(postavaId: string, typ: ZkVrstvaTyp, varianta: string): void {
  for (const soubor of Object.values(cestyNavrhu(postavaId, typ, varianta))) {
    try { if (fs.existsSync(soubor)) fs.unlinkSync(soubor); } catch { /* nevadí */ }
  }
}

function pocetBodu(o: Obraz): number {
  let n = 0;
  for (let i = 3; i < o.body.length; i += 4) if (o.body[i] > 128) n += 1;
  return n;
}

function zapisSablonu(postavaId: string, typ: ZkVrstvaTyp, varianta: string, obraz: Obraz, kov: Obraz | null): ZkVrstva {
  const soubor = store.cestaVrstvy(postavaId, typ, varianta);
  const stara = store.vrstvy(postavaId).find(one => one.typ === typ && one.varianta === varianta);
  /* Podíl na postavě: starý přepočtený poměrem ploch (postavu kvůli tomu měřit znovu netřeba) */
  let podil = stara?.podil ?? 0;
  try {
    if (stara?.soubor && fs.existsSync(stara.soubor)) {
      const pred = pocetBodu(nacti(fs.readFileSync(stara.soubor)));
      if (pred > 0) podil = podil * (pocetBodu(obraz) / pred);
    }
  } catch { /* zůstane starý podíl */ }
  fs.writeFileSync(soubor, uloz(obraz));
  let kovSoubor: string | undefined;
  if (kov) {
    kovSoubor = soubor.replace(/\.png$/, '-kov.png');
    fs.writeFileSync(kovSoubor, uloz(kov));
  }
  const maska = new Uint8Array(obraz.sirka * obraz.vyska);
  for (let i = 0; i < maska.length; i++) maska[i] = obraz.body[i * 4 + 3] > 128 ? 255 : 0;
  const kde = px.okraje(maska, obraz.sirka, obraz.vyska);
  const vrstva: ZkVrstva = {
    postava: postavaId, typ, varianta, soubor, url: '',
    sirka: obraz.sirka, vyska: obraz.vyska, podil,
    okraje: { x: kde.x, y: kde.y, w: kde.w, h: kde.h },
    stav: 'hotovo',
    potiz: '',
    zadani: `${AI_SABLONA} · ${popisSablony(typ, varianta)}`,
    kdy: new Date().toISOString(),
    kov: kovSoubor
  };
  store.zapisVrstvu(vrstva);
  return vrstva;
}

/* ---------------------------------------------------------- kontrola */

export interface KontrolaSablony { pokryti: number; navic: number; souvisle: number; zahyby: number; potiz: string }

/**
 * Kontrola tvaru a světla od AI proti kreslené šabloně. Zadarmo — počítá
 * se z obrázku, který už je zaplacený.
 */
export function zkontrolujSablonu(
  typ: ZkVrstvaTyp,
  puvodni: Uint8Array,
  nova: Uint8Array,
  svetlo: Obraz,
  sirka: number,
  vyska: number,
  /** Kolik bodů uvnitř šablony AI změnila (0–1). */
  zmena = 1
): KontrolaSablony {
  let p = 0; let n = 0; let oba = 0;
  for (let i = 0; i < puvodni.length; i++) {
    if (puvodni[i]) p += 1;
    if (nova[i]) n += 1;
    if (puvodni[i] && nova[i]) oba += 1;
  }
  const pokryti = p ? oba / p : 0;
  const navic = p ? n / p : 0;
  const velke = px.jenVelke(nova, sirka, vyska, 0.999);
  let nejvetsi = 0;
  for (let i = 0; i < velke.length; i++) if (velke[i]) nejvetsi += 1;
  const souvisle = n ? nejvetsi / n : 0;
  /* Záhyby: rozptyl jasu kreslicí barvy uvnitř tvaru */
  let s = 0; let s2 = 0; let m = 0;
  for (let i = 0; i < nova.length; i++) {
    if (!nova[i]) continue;
    const k = i * 4;
    const l = px.svetlostBodu(svetlo.body[k], svetlo.body[k + 1], svetlo.body[k + 2]);
    s += l; s2 += l * l; m += 1;
  }
  const zahyby = m ? Math.sqrt(Math.max(0, s2 / m - (s / m) ** 2)) : 0;
  const minPokryti = typ === 'ksandy' ? 0.6 : 0.8;
  let potiz = '';
  if (zmena < 0.05) potiz = 'AI šablonu nezměnila — vrátila kreslenou.';
  else if (!n) potiz = 'AI kus v kreslicí barvě nenakreslila.';
  else if (pokryti < minPokryti) potiz = `Tvar od AI pokrývá jen ${Math.round(pokryti * 100)} % šablony.`;
  else if (navic > 1.4) potiz = `Tvar od AI je o ${Math.round((navic - 1) * 100)} % větší než šablona.`;
  else if (typ !== 'ksandy' && souvisle < 0.85) potiz = 'Tvar od AI je rozpadlý na víc kusů.';
  else if (zahyby < 4) potiz = 'AI nakreslila plochou barvu bez záhybů — nebylo by to realističtější než kreslená šablona.';
  return { pokryti, navic, souvisle, zahyby, potiz };
}

/* ------------------------------------------------------------ jedna */

export interface VysledekSablony { ok: boolean; potiz: string; nahled: string }

const BARVA_NAHLEDU: Partial<Record<ZkVrstvaTyp, string>> = { ksandy: '#2d4a7c', kapesnicek: '#efe7d8' };

/** Šablona kusu, ze které AI vychází: ruční úprava z revize, jinak kreslená. */
function vychozi(postavaId: string, typ: ZkVrstvaTyp, varianta: string) {
  const mereni = kotvyPostavy(postavaId);
  if (!mereni) throw new Error('Nejdřív se musí nakreslit postava.');
  const { kotvy, postava, orez } = mereni;
  const { sirka, vyska } = postava;
  const mam = store.vrstvy(postavaId).find(one => one.typ === typ && one.varianta === varianta && one.soubor && fs.existsSync(one.soubor));
  if (mam && mam.zadani.startsWith(REVIZE)) {
    const obraz = nacti(fs.readFileSync(mam.soubor));
    const kov = mam.kov && fs.existsSync(mam.kov) ? nacti(fs.readFileSync(mam.kov)) : null;
    if (obraz.sirka === sirka && obraz.vyska === vyska) return { obraz, kov, kotvy, sirka, vyska };
  }
  const kov = typ === 'ksandy' ? novyObraz(sirka, vyska) : null;
  const obraz = nakresliSablonu(typ, varianta, kotvy, sirka, vyska, orez, kov ?? undefined);
  if (!obraz) throw new Error(`Pro ${typ} ${varianta} šablona není.`);
  return { obraz, kov, kotvy, sirka, vyska };
}

/**
 * Nechá AI dokreslit šablonu realisticky. Projde-li kontrolou, nahradí
 * kreslenou šablonu hned; jinak se uloží jako návrh k posouzení.
 */
export async function zrealistuj(postavaId: string, typ: ZkVrstvaTyp, varianta: string): Promise<VysledekSablony> {
  const def = ZK_VRSTVY.find(one => one.typ === typ);
  if (!def?.sablona) throw new Error('Realisticky se dají dokreslit jen šablony doplňků.');
  const p = store.postava(postavaId);
  if (!p || !p.hotovo) throw new Error('Postava není nakreslená.');
  const { obraz: sablona, kov, kotvy, sirka, vyska } = vychozi(postavaId, typ, varianta);
  const naCm = kotvy.naCm;

  const puvodni = new Uint8Array(sirka * vyska);
  for (let i = 0; i < puvodni.length; i++) puvodni[i] = sablona.body[i * 4 + 3] > 128 ? 255 : 0;
  const kovPuvodni = new Uint8Array(sirka * vyska);
  if (kov) for (let i = 0; i < kovPuvodni.length; i++) kovPuvodni[i] = kov.body[i * 4 + 3] > 64 ? 255 : 0;
  const obe = new Uint8Array(sirka * vyska);
  for (let i = 0; i < obe.length; i++) obe[i] = puvodni[i] || kovPuvodni[i] ? 255 : 0;
  const kde = px.okraje(obe, sirka, vyska);
  if (!kde.w) throw new Error('Šablona kusu je prázdná — zkontroluj body na postavě.');
  /* Kde smí AI kreslit: tvar a kousek kolem, ať doladí obrys */
  const rozsah = px.rozsir(obe, sirka, vyska, Math.max(2, Math.round(0.6 * naCm)));

  const scena = kulisa(postavaId, typ === 'kapesnicek', sirka, vyska);
  if (!scena) throw new Error('Postava nemá základ.');
  const signal = ZK_KRESLICI[typ];
  const vstupPlatno = px.slozeni([{ obraz: scena }, { obraz: sablona, hex: signal }, ...(kov ? [{ obraz: kov }] : [])], sirka, vyska);
  const r = vyrez(kde, sirka, vyska, naCm);
  const vstup = px.prevzorkuj(px.vyrizniObdelnik(vstupPlatno, r), r.W, r.H);
  const rozsahObraz = novyObraz(sirka, vyska);
  for (let i = 0; i < rozsah.length; i++) rozsahObraz.body[i * 4 + 3] = rozsah[i];
  const rozsahVyrez = px.prevzorkuj(px.vyrizniObdelnik(rozsahObraz, r), r.W, r.H);
  const maska = novyObraz(r.W, r.H);
  for (let i = 0; i < maska.body.length; i += 4) maska.body[i + 3] = rozsahVyrez.body[i + 3] > 8 ? 0 : 255;

  const vracene = await kreslir(zadaniSablony(typ, varianta), vstup, maska);
  const zpet = px.prevzorkuj(px.prevzorkuj(vracene, r.W, r.H), r.w, r.h);
  const platno = px.vlozObdelnik(scena, zpet, r);

  /* Tvar: co je v kreslicí barvě, jen v dovoleném rozsahu; odlesky se dolijí zavřením děr */
  let latka = px.maskaBarvy(platno, signalniBarva(typ), 30, 0.3, 22);
  for (let i = 0; i < latka.length; i++) if (!rozsah[i]) latka[i] = 0;
  latka = px.zavriDiry(latka, sirka, vyska, Math.max(2, Math.round(0.25 * naCm)));
  for (let i = 0; i < latka.length; i++) if (!rozsah[i]) latka[i] = 0;
  if (typ !== 'ksandy') latka = px.jenVelke(latka, sirka, vyska, 0.15);

  /* Kov kšand: kolem původních spon to, co AI změnila a není kreslicí barva */
  let kovNovy: Obraz | null = null;
  if (kov) {
    const okoli = px.rozsir(kovPuvodni, sirka, vyska, Math.max(2, Math.round(0.35 * naCm)));
    kovNovy = novyObraz(sirka, vyska);
    let novych = 0; let puvodnich = 0;
    for (let i = 0; i < okoli.length; i++) {
      if (kovPuvodni[i]) puvodnich += 1;
      if (!okoli[i] || latka[i]) continue;
      const k = i * 4;
      const zmena = Math.abs(platno.body[k] - scena.body[k]) + Math.abs(platno.body[k + 1] - scena.body[k + 1])
        + Math.abs(platno.body[k + 2] - scena.body[k + 2]);
      if (!kovPuvodni[i] && zmena < 45) continue;
      kovNovy.body[k] = platno.body[k]; kovNovy.body[k + 1] = platno.body[k + 1]; kovNovy.body[k + 2] = platno.body[k + 2];
      kovNovy.body[k + 3] = 255;
      novych += 1;
    }
    /* AI spony vynechala → zůstanou kreslené, ať kšandy nevisí ve vzduchu */
    kovNovy = novych >= puvodnich * 0.3 ? px.vyhladObrys(kovNovy, 1) : kov;
  }

  /*
   * Vrátila AI obrázek beze změny? Pak by „realistická" byla jen kopie
   * kreslené. Srovnává se ve výřezu, který AI dostala — po převzorkování
   * zpátky na postavu by se rozdíl ztratil v rozmazání.
   */
  const vracenoVyrez = px.prevzorkuj(vracene, r.W, r.H);
  const tvarVyrez = px.prevzorkuj(px.vyrizniObdelnik(sablona, r), r.W, r.H);
  let uvnitr = 0; let jinak = 0;
  for (let j = 0; j < tvarVyrez.body.length; j += 4) {
    if (tvarVyrez.body[j + 3] < 200) continue;
    uvnitr += 1;
    if (Math.abs(vracenoVyrez.body[j] - vstup.body[j]) + Math.abs(vracenoVyrez.body[j + 1] - vstup.body[j + 1])
      + Math.abs(vracenoVyrez.body[j + 2] - vstup.body[j + 2]) >= 12) jinak += 1;
  }
  const k = zkontrolujSablonu(typ, puvodni, latka, platno, sirka, vyska, uvnitr ? jinak / uvnitr : 0);
  const mapa = px.stinovaMapa(platno, latka);

  /* Náhled před / po v ukázkové barvě */
  const hex = BARVA_NAHLEDU[typ] ?? '#7a1f2b';
  const pred = px.slozeni([{ obraz: scena }, { obraz: sablona, hex }, ...(kov ? [{ obraz: kov }] : [])], sirka, vyska);
  const po = px.slozeni([{ obraz: scena }, { obraz: mapa, hex }, ...(kovNovy ? [{ obraz: kovNovy }] : [])], sirka, vyska);
  const nahledObraz = vedleSebe(px.vyrizniObdelnik(pred, r), px.vyrizniObdelnik(po, r), 300);
  const nahled = `data:image/png;base64,${uloz(nahledObraz).toString('base64')}`;

  if (!k.potiz) {
    zapisSablonu(postavaId, typ, varianta, mapa, kovNovy);
    smazNavrh(postavaId, typ, varianta);
    return { ok: true, potiz: '', nahled };
  }
  const c = cestyNavrhu(postavaId, typ, varianta);
  fs.writeFileSync(c.obraz, uloz(mapa));
  if (kovNovy) fs.writeFileSync(c.kov, uloz(kovNovy));
  else if (fs.existsSync(c.kov)) fs.unlinkSync(c.kov);
  fs.writeFileSync(c.nahled, uloz(nahledObraz));
  fs.writeFileSync(c.info, JSON.stringify({ ...k, kdy: new Date().toISOString() }));
  return { ok: false, potiz: k.potiz, nahled };
}

/** Dva výřezy vedle sebe ve stejné výšce, na bílém. */
function vedleSebe(a: Obraz, b: Obraz, vyska: number): Obraz {
  const k = Math.min(1, vyska / Math.max(1, a.vyska));
  const w = Math.max(1, Math.round(a.sirka * k)); const h = Math.max(1, Math.round(a.vyska * k));
  const mezera = 6;
  const out = novyObraz(w * 2 + mezera, h);
  out.body.fill(255);
  const aa = px.prevzorkuj(a, w, h); const bb = px.prevzorkuj(b, w, h);
  for (const [o, dx] of [[aa, 0], [bb, w + mezera]] as const) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4; const j = (y * out.sirka + x + dx) * 4;
        const al = o.body[i + 3] / 255;
        for (let c = 0; c < 3; c++) out.body[j + c] = Math.round(o.body[i + c] * al + 250 * (1 - al));
        out.body[j + 3] = 255;
      }
    }
  }
  return out;
}

/** Návrh, který neprošel kontrolou, se přesto použije — rozhodl člověk. */
export function pouzijNavrh(postavaId: string, typ: ZkVrstvaTyp, varianta: string): void {
  const c = cestyNavrhu(postavaId, typ, varianta);
  if (!fs.existsSync(c.obraz)) throw new Error('Návrh už tu není.');
  const obraz = nacti(fs.readFileSync(c.obraz));
  const kov = fs.existsSync(c.kov) ? nacti(fs.readFileSync(c.kov)) : null;
  zapisSablonu(postavaId, typ, varianta, obraz, kov);
  smazNavrh(postavaId, typ, varianta);
}

export function zahodNavrh(postavaId: string, typ: ZkVrstvaTyp, varianta: string): void {
  smazNavrh(postavaId, typ, varianta);
}

/* ------------------------------------------------------------- dávka */

export interface PlanSablony { postava: string; typ: ZkVrstvaTyp; varianta: string }

/** Šablony, které ještě nejsou realistické (a nejsou ručně upravené). */
export function plan(postavaId?: string): PlanSablony[] {
  const out: PlanSablony[] = [];
  for (const p of store.postavy()) {
    if (!p.hotovo || (postavaId && p.id !== postavaId)) continue;
    const vrstvy = store.vrstvy(p.id);
    for (const def of ZK_VRSTVY) {
      if (!def.sablona || def.nePro?.includes(p.vek)) continue;
      for (const v of def.varianty) {
        const mam = vrstvy.find(one => one.typ === def.typ && one.varianta === v.id);
        if (!mam || !mam.soubor || mam.zadani.startsWith(AI_SABLONA)) continue;
        out.push({ postava: p.id, typ: def.typ, varianta: v.id });
      }
    }
  }
  return out;
}

export function odhad(postavaId?: string): { kusu: number; usd: number } {
  const kusu = plan(postavaId).length;
  return { kusu, usd: Math.round(kusu * obrazky.cenaObrazku() * 100) / 100 };
}

export async function zrealistujVse(
  postavaId: string | undefined,
  hlas?: (p: { hotovo: number; celkem: number; co: string }) => void
): Promise<{ hotovo: number; navrhu: number; chyb: number; posledniChyba: string }> {
  const ukoly = plan(postavaId);
  let hotovo = 0; let navrhu = 0; let chyb = 0; let posledniChyba = ''; let dokonceno = 0;
  try {
    await poSkupinach(ukoly, soubezne(), async u => {
      hlas?.({ hotovo: dokonceno, celkem: ukoly.length, co: `Dokresluji šablonu ${u.typ} ${u.varianta} (${dokonceno + 1} z ${ukoly.length})` });
      try {
        const r = await zrealistuj(u.postava, u.typ, u.varianta);
        if (r.ok) hotovo += 1; else navrhu += 1;
      } catch (e: any) {
        chyb += 1;
        posledniChyba = String(e?.message ?? e);
        if (/strop|klíč|verif|401|403|kredit|billing/i.test(posledniChyba)) throw e;
      } finally {
        dokonceno += 1;
      }
    });
  } catch { /* chyba je v posledniChyba */ }
  return { hotovo, navrhu, chyb, posledniChyba };
}

export const __test = { zkontrolujSablonu, vedleSebe };
