import fs from 'fs';
import { BrowserWindow } from 'electron';
import {
  ZkPostava, ZkVrstva, ZkVrstvaTyp, ZK_VRSTVY, vrstvaDef, zkontrolujVrstvu
} from '../../shared/zkusebna';
import { getSetting } from '../db';
import { Obraz, nacti, uloz, novyObraz } from './png';
import * as px from './pixely';
import * as obrazky from './obrazky';
import * as store from './store';
import { zadaniKusuTed, zadaniPostavyTed } from './zadani';

/**
 * Jak vrstvy vznikají.
 *
 * ## Proč se nekreslí „sako na průhledném pozadí"
 *
 * To by nikdy nesedlo. Model nakreslí sako, které by slušelo nějakému
 * člověku, ne tomu našemu: rukáv skončí jinde než ruka, ramena budou
 * o dva centimetry jinde a na postavě to bude vypadat jako nalepená
 * nálepka. A u tří těl a tří věků by se to muselo trefit devětkrát.
 *
 * ## Jak to vzniká místo toho
 *
 * Postava se **postupně dooblékává** a každá vrstva je rozdíl dvou kroků:
 *
 *   postava → + vlasy → + boty → + kalhoty → + košile → … → + sako
 *
 * Co mezi dvěma kroky přibylo, je přesně ten jeden kus látky — a je na
 * svém místě na bod, protože je to pořád tentýž obrázek. Návod k modelu
 * tuhle cestu sám doporučuje: když má něco zůstat shodné na bod, má se
 * schválená úprava složit zpátky do původního obrázku, ne se spoléhat na
 * zadání.
 *
 * ## Co se na tom může pokazit a jak se to pozná
 *
 * Model obrázek mezi kroky nepatrně posune nebo překreslí, co nemá. Proti
 * tomu stojí tři věci, všechny měřitelné:
 *
 *  1. **zarovnání podle hlavy** — posun se najde a odečte,
 *  2. **úklid masky** — smítka a osamělé body se zahodí,
 *  3. **kontrola, že kus leží tam, kam patří** — sako mezi deseti a
 *     sedmdesáti procenty výšky postavy a ne víc než půlka její plochy.
 *
 * Co kontrolou neprojde, se neuloží jako hotové, ale jako „nesedí", a
 * v okně u toho stojí česky, co je špatně. Tohle není ozdoba: generování
 * stojí peníze a jediná mlčky špatná vrstva by se objevila zákazníkovi
 * v obleku jako barevný flek u ucha.
 */

function hlas(payload: unknown) {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('zk:krok', payload);
}

/** Obdélník, ve kterém na plátně stojí postava. */
export function okrajePostavy(obraz: Obraz): px.Okraje {
  const maska = new Uint8Array(obraz.sirka * obraz.vyska);
  for (let i = 0; i < maska.length; i++) maska[i] = obraz.body[i * 4 + 3] > 24 ? 255 : 0;
  return px.okraje(maska, obraz.sirka, obraz.vyska);
}

/**
 * Maska, kterou se modelu omezí, kam smí kreslit.
 *
 * Průhledné místo znamená „tady uprav", neprůhledné „tady nech". Pruh se
 * bere z mezí, ve kterých má kus látky ležet, a nechá se kolem rezerva:
 * límec saka sahá o kousek výš, než se čeká, a tvrdá hranice by ho
 * odřízla. Když je volba vypnutá, modelu se maska neposílá vůbec a
 * spoléhá se jen na zadání.
 */
export function maskaProKus(typ: ZkVrstvaTyp, postava: px.Okraje, sirka: number, vyska: number): Obraz | undefined {
  if (getSetting('zkMaska', '1') !== '1') return undefined;
  const k = vrstvaDef(typ).kontrola;
  const rezerva = 0.07;
  const od = Math.max(0, Math.round(postava.y + (k.odY - rezerva) * postava.h));
  const doKam = Math.min(vyska, Math.round(postava.y + (k.doY + rezerva) * postava.h));
  const maska = novyObraz(sirka, vyska);
  for (let y = 0; y < vyska; y++) {
    const upravit = y >= od && y <= doKam;
    for (let x = 0; x < sirka; x++) {
      const i = (y * sirka + x) * 4;
      maska.body[i + 3] = upravit ? 0 : 255;
    }
  }
  return maska;
}

/* --------------------------------------------------------------- postava */

/**
 * Nakreslí postavu a zapíše, kde na plátně stojí.
 *
 * Temeno a podrážka nejsou kosmetika: od nich se počítá měřítko výšky
 * (postava se zvětšuje od chodidel, ne od středu plátna) a podle nich se
 * měří, jestli kus látky leží tam, kam patří.
 */
export async function vygenerujPostavu(id: string): Promise<ZkPostava> {
  const p = store.postava(id);
  if (!p) throw new Error(`Postava ${id} v seznamu není.`);
  hlas({ postava: id, typ: 'postava', stav: 'kreslim' });
  const zadani = zadaniPostavyTed(p.vek, p.telo);
  const obraz = await obrazky.nakresli(zadani, { sirka: p.sirka, vyska: p.vyska });
  const kde = okrajePostavy(obraz);
  if (kde.podil < 0.08) {
    throw new Error('Na obrázku skoro nic není — model nakreslil prázdné plátno nebo samé pozadí.');
  }

  const krok = store.cestaKroku(id, 0, 'postava');
  fs.writeFileSync(krok, uloz(obraz));
  store.zapisKrok(id, 0, 'postava', krok);

  /* Postava je zároveň první vrstva — kreslí se, jak je, nebarví se */
  const soubor = store.cestaVrstvy(id, 'postava', 'zaklad');
  fs.writeFileSync(soubor, uloz(obraz));
  store.zapisVrstvu({
    postava: id, typ: 'postava', varianta: 'zaklad', soubor, url: '',
    sirka: obraz.sirka, vyska: obraz.vyska, podil: kde.podil,
    okraje: { x: kde.x, y: kde.y, w: kde.w, h: kde.h },
    stav: 'hotovo', potiz: '', zadani, kdy: new Date().toISOString()
  });

  const hotova: ZkPostava = { ...p, temeno: kde.y, podrazka: kde.y + kde.h, hotovo: true };
  store.zapisPostavu(hotova, zadani);
  hlas({ postava: id, typ: 'postava', stav: 'hotovo' });
  return hotova;
}

/* ---------------------------------------------------------------- vrstva */

export interface VysledekVrstvy {
  vrstva: ZkVrstva;
  /** Obrázek celé postavy po tomhle kroku — v okně se na něm pozná, co model udělal. */
  krok: string;
}

/**
 * Dooblékne postavu o jeden kus a uloží z toho vrstvu.
 *
 * `kanonicka` znamená „tahle varianta je ta, ze které se pokračuje dál".
 * U kravaty je kanonická kravata, a motýlek i regata se kreslí z téhož
 * předchozího kroku — jinak by se motýlek dal zapnout jen tomu, kdo má
 * zároveň kravatu.
 */
export async function vygenerujVrstvu(
  postavaId: string,
  typ: ZkVrstvaTyp,
  varianta: string
): Promise<VysledekVrstvy> {
  const p = store.postava(postavaId);
  if (!p) throw new Error(`Postava ${postavaId} v seznamu není.`);
  const def = vrstvaDef(typ);
  if (!def.varianty.some(one => one.id === varianta)) {
    throw new Error(`Vrstva ${def.nazev} nemá variantu ${varianta}.`);
  }
  const predSoubor = store.krokPred(postavaId, typ);
  if (!predSoubor) throw new Error('Chybí krok před tímhle — nejdřív se musí nakreslit postava.');

  hlas({ postava: postavaId, typ, varianta, stav: 'kreslim' });
  const pred = nacti(fs.readFileSync(predSoubor));
  const kdePostava = okrajePostavy(pred);
  const zadani = zadaniKusuTed(typ, varianta);
  const po = await obrazky.dokresli(
    zadani, pred, maskaProKus(typ, kdePostava, pred.sirka, pred.vyska)
  );

  const vysledek = vrstvaZKroku(p, typ, varianta, pred, po, zadani);

  /* Krok se ukládá vždycky — i nepovedený, aby bylo vidět, co model udělal */
  const poradi = ZK_VRSTVY.findIndex(one => one.typ === typ);
  const krok = store.cestaKroku(postavaId, poradi, `${typ}-${varianta}`);
  fs.writeFileSync(krok, uloz(po));
  const kanonicka = def.varianty[0].id === varianta;
  if (kanonicka && vysledek.stav !== 'nesedi') store.zapisKrok(postavaId, poradi, typ, krok);

  store.zapisVrstvu(vysledek);
  hlas({ postava: postavaId, typ, varianta, stav: vysledek.stav, potiz: vysledek.potiz });
  return { vrstva: vysledek, krok };
}

/**
 * Z dvou kroků spočítá vrstvu. Bez sítě — tudy chodí i zkouška.
 */
export function vrstvaZKroku(
  p: ZkPostava,
  typ: ZkVrstvaTyp,
  varianta: string,
  pred: Obraz,
  po: Obraz,
  zadani: string
): ZkVrstva {
  const def = vrstvaDef(typ);
  const kdePostava = okrajePostavy(pred);
  /*
   * Zarovnání se měří na hlavě, protože ta se při oblékání nemá měnit —
   * ani u vlasů, kde se mění jen to, co na ní roste. U vlasů se proto
   * bere pruh přes trup.
   */
  const kotva = typ === 'vlasy' || typ === 'fousy'
    ? { x: kdePostava.x, y: Math.round(kdePostava.y + kdePostava.h * 0.45), w: kdePostava.w, h: Math.round(kdePostava.h * 0.2) }
    : { x: kdePostava.x, y: kdePostava.y, w: kdePostava.w, h: Math.max(8, Math.round(kdePostava.h * 0.12)) };
  const posun = px.zarovnej(pred, po, kotva, 6);

  const maska = px.uklid(px.rozdil(pred, po, posun), pred.sirka, pred.vyska);
  const kde = px.okraje(maska, pred.sirka, pred.vyska);
  const podilNaPostave = kdePostava.podil > 0 ? kde.podil / kdePostava.podil : 0;
  const potiz = zkontrolujVrstvu(
    typ,
    { okraje: { x: kde.x, y: kde.y, w: kde.w, h: kde.h }, podil: podilNaPostave },
    { y: kdePostava.y, h: kdePostava.h }
  );

  /*
   * Posunutý krok se před výřezem posune zpátky, aby vrstva sedla na
   * postavu, a ne na to, kam ji model odnesl.
   */
  const srovnany = posunObraz(po, -posun.dx, -posun.dy);
  const obraz = def.barvitelna ? px.stinovaMapa(srovnany, maska) : px.vyrizni(srovnany, maska);

  const soubor = store.cestaVrstvy(p.id, typ, varianta);
  if (!potiz) fs.writeFileSync(soubor, uloz(obraz));

  return {
    postava: p.id, typ, varianta,
    soubor: potiz ? '' : soubor,
    url: '',
    sirka: pred.sirka, vyska: pred.vyska,
    podil: podilNaPostave,
    okraje: { x: kde.x, y: kde.y, w: kde.w, h: kde.h },
    stav: potiz ? 'nesedi' : 'hotovo',
    potiz,
    zadani,
    kdy: new Date().toISOString()
  };
}

/** Posune obrázek o celé body. Používá se na srovnání ujetého kroku. */
export function posunObraz(obraz: Obraz, dx: number, dy: number): Obraz {
  if (!dx && !dy) return obraz;
  const out = novyObraz(obraz.sirka, obraz.vyska);
  for (let y = 0; y < obraz.vyska; y++) {
    const zy = y - dy;
    if (zy < 0 || zy >= obraz.vyska) continue;
    for (let x = 0; x < obraz.sirka; x++) {
      const zx = x - dx;
      if (zx < 0 || zx >= obraz.sirka) continue;
      const z = (zy * obraz.sirka + zx) * 4;
      const k = (y * obraz.sirka + x) * 4;
      out.body[k] = obraz.body[z];
      out.body[k + 1] = obraz.body[z + 1];
      out.body[k + 2] = obraz.body[z + 2];
      out.body[k + 3] = obraz.body[z + 3];
    }
  }
  return out;
}

/* ------------------------------------------------------------ celá postava */

/** Co všechno se pro jednu postavu chystá vygenerovat. */
export function plan(postavaId: string, jenChybejici = true): { typ: ZkVrstvaTyp; varianta: string }[] {
  const hotove = new Set(
    store.vrstvy(postavaId)
      .filter(one => one.stav === 'hotovo' || one.stav === 'schvaleno')
      .map(one => `${one.typ}:${one.varianta}`)
  );
  const out: { typ: ZkVrstvaTyp; varianta: string }[] = [];
  const p = store.postava(postavaId);
  for (const def of ZK_VRSTVY) {
    if (def.typ === 'postava') continue;
    /* Plnovous na kojenci jsou tři zaplacené obrázky k ničemu */
    if (p && def.nePro?.includes(p.vek)) continue;
    for (const varianta of def.varianty) {
      if (jenChybejici && hotove.has(`${def.typ}:${varianta.id}`)) continue;
      out.push({ typ: def.typ, varianta: varianta.id });
    }
  }
  return out;
}

/**
 * Vygeneruje všechno, co postavě chybí.
 *
 * Jde se **v pořadí vrstev** a kanonická varianta první: z ní se staví
 * krok, ze kterého vychází ostatní varianty i všechno nad ní. Kdyby se
 * šlo abecedně, motýlek by se kreslil na postavu bez košile.
 *
 * První chyba běh zastaví. Pokračovat po nepovedeném kroku znamená stavět
 * na něm celý zbytek obleku — a platit za každý další obrázek.
 */
export async function vygenerujVse(postavaId: string, jenChybejici = true): Promise<{
  hotovo: number; nesedi: number; potize: string[];
}> {
  const p = store.postava(postavaId);
  if (!p) throw new Error(`Postava ${postavaId} v seznamu není.`);
  if (!p.hotovo) await vygenerujPostavu(postavaId);

  const ukoly = plan(postavaId, jenChybejici);
  /* Kanonická varianta musí být před ostatními u téhož kusu */
  ukoly.sort((a, b) => {
    const poradiA = ZK_VRSTVY.findIndex(one => one.typ === a.typ);
    const poradiB = ZK_VRSTVY.findIndex(one => one.typ === b.typ);
    if (poradiA !== poradiB) return poradiA - poradiB;
    const defA = vrstvaDef(a.typ);
    return defA.varianty.findIndex(one => one.id === a.varianta)
      - defA.varianty.findIndex(one => one.id === b.varianta);
  });

  let hotovo = 0;
  let nesedi = 0;
  const potize: string[] = [];
  for (let i = 0; i < ukoly.length; i++) {
    const ukol = ukoly[i];
    hlas({ postava: postavaId, hotovych: i, celkem: ukoly.length, typ: ukol.typ, varianta: ukol.varianta });
    const { vrstva } = await vygenerujVrstvu(postavaId, ukol.typ, ukol.varianta);
    if (vrstva.stav === 'nesedi') {
      nesedi += 1;
      potize.push(`${vrstvaDef(ukol.typ).nazev} (${ukol.varianta}): ${vrstva.potiz}`);
      break;
    }
    hotovo += 1;
  }
  hlas({ postava: postavaId, stav: 'konec', hotovo, nesedi });
  return { hotovo, nesedi, potize };
}

export const __test = { maskaProKus, okrajePostavy, posunObraz, vrstvaZKroku };
