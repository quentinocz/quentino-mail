import fs from 'fs';
import { BrowserWindow } from 'electron';
import {
  ZkPostava, ZkVrstva, ZkVrstvaTyp, ZK_VRSTVY, ZK_PODKLAD_HEX,
  doZakladu, signalniBarva, vrstvaDef, zkontrolujVrstvu
} from '../../shared/zkusebna';
import { getSetting } from '../db';
import { Obraz, nacti, uloz, novyObraz } from './png';
import * as px from './pixely';
import * as obrazky from './obrazky';
import { NEJMENE_BODU } from './obrazky';
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

/** Silueta postavy — kde na plátně vůbec něco je. */
export function siluetaPostavy(obraz: Obraz): Uint8Array {
  const maska = new Uint8Array(obraz.sirka * obraz.vyska);
  for (let i = 0; i < maska.length; i++) maska[i] = obraz.body[i * 4 + 3] > 24 ? 255 : 0;
  return maska;
}

/** Kde na plátně stojí postava — a kde na ní končí hlava. */
export interface KdePostava extends px.Okraje {
  /** Řádek, kde postavě začíná krk. Nad ním je hlava. */
  krk: number;
}

export function okrajePostavy(obraz: Obraz): KdePostava {
  const silueta = siluetaPostavy(obraz);
  const kde = px.okraje(silueta, obraz.sirka, obraz.vyska);
  return { ...kde, krk: kdeKrk(silueta, obraz.sirka, kde) };
}

/**
 * Kde postavě začíná krk — nejužší místo mezi temenem a rameny.
 *
 * ## Proč se to měří, a ne odhaduje
 *
 * Pruhy pro kusy jsou zlomky výšky postavy a u šesti z jedenácti kusů
 * sahaly **na hlavu**: sako začínalo třináct bodů pod temenem, košile
 * čtyřicet, kravata padesát. Model tedy měl povoleno překreslit
 * obličej — a dělal to. Ve vrstvě se sakem visela celá hlava i s
 * vousy a na krocích oblékání se člověk od kroku ke kroku měnil.
 *
 * Nedá se to spravit tím, že se ke zlomkům přičte jiný zlomek: hlava
 * je u dítěte pětina postavy a u dospělého sedmina, u kojence ještě
 * víc. Kde končí, se ale dá **změřit**: od temene dolů se silueta
 * zužuje do krku a pod ním se rozšíří do ramen. Nejužší řádek mezi
 * temenem a rameny je krk, a spodní z nich je jeho základ — přesně
 * tam, kde sedí límec.
 */
export function kdeKrk(silueta: Uint8Array, sirka: number, postava: px.Okraje): number {
  if (postava.h < 8 || postava.w < 4) return postava.y;
  const sirkaRadku = (y: number): number => {
    let od = -1;
    let doKonce = -1;
    for (let x = postava.x; x < postava.x + postava.w; x++) {
      if (!silueta[y * sirka + x]) continue;
      if (od < 0) od = x;
      doKonce = x;
    }
    return od < 0 ? 0 : doKonce - od + 1;
  };
  const sirky: number[] = [];
  for (let y = postava.y; y < postava.y + postava.h; y++) sirky.push(sirkaRadku(y));
  const nejsirsi = Math.max(...sirky);
  if (nejsirsi <= 0) return postava.y;

  /* Ramena: první řádek shora, kde se postava rozšíří na většinu své
     největší šířky. Hlava ani krk jí nikdy nedosáhnou. */
  let ramena = -1;
  for (let i = 0; i < sirky.length; i++) {
    if (sirky[i] >= nejsirsi * 0.6) { ramena = i; break; }
  }
  /* Bez ramen (detail, useknutá postava) se radši nic neomezuje */
  if (ramena <= 2) return postava.y;

  /*
   * Od ramen se jde **nahoru, dokud se postava zužuje**. Tam, kde se
   * zužovat přestane, je nejužší místo — krk. Nejde hledat nejmenší
   * šířku shora: temeno je samo o sobě úzké a vyšlo by hned ono.
   *
   * Profil se nejdřív uhladí přes pět řádků. Na fotce je obrys
   * roztřepený a jediný zoubek o dva body by chůzi zastavil o kus
   * výš, než kde krk opravdu je.
   */
  const hladce = sirky.map((_, i) => {
    let soucet = 0;
    let kusu = 0;
    for (let j = Math.max(0, i - 2); j <= Math.min(sirky.length - 1, i + 2); j++) {
      soucet += sirky[j];
      kusu += 1;
    }
    return soucet / kusu;
  });
  let krk = ramena;
  while (krk > 1 && hladce[krk - 1] < hladce[krk]) krk -= 1;
  /*
   * A pojistka. U stojící postavy je krk v první pětině výšky; kdyby
   * měření vyšlo níž, není to krk a něco je jinak (detail, ruce
   * v bok, useknutá figura). Pak se radši neomezuje nic — pruhy
   * zůstanou jako dřív a hlídá to kontrola vrstvy.
   */
  if (krk > postava.h * 0.3) return postava.y;
  return postava.y + krk;
}

/**
 * Kolik z vrstvy leží na postavě.
 *
 * Kus látky, který se z poloviny vznáší vedle postavy, na ni nikdy
 * nesedne — a tohle je jediné měření, které to pozná. Počítá se proti
 * siluetě **kroku před**, trochu rozšířené: sako je širší než košile
 * pod ním a vlasy přidají hlavě objem, takže pár bodů za původním
 * obrysem je v pořádku.
 */
export function naPostave(maska: Uint8Array, silueta: Uint8Array, sirka: number, vyska: number): number {
  const siroka = px.zmekci(silueta, sirka, vyska, 3);
  let celkem = 0;
  let uvnitr = 0;
  for (let i = 0; i < maska.length; i++) {
    if (!maska[i]) continue;
    celkem += 1;
    if (siroka[i]) uvnitr += 1;
  }
  return celkem === 0 ? 0 : uvnitr / celkem;
}

/**
 * Výřez, který se posílá modelu — ne celá postava.
 *
 * ## Proč se posílá jen kus
 *
 * Tři důvody, a každý sám o sobě by stačil:
 *
 *  1. **cena.** Obrázek se platí podle plochy, kterou model vykreslí.
 *     Kravata na výřezu hrudníku stojí čtvrtinu toho, co kravata na
 *     celé postavě — a kusů je přes dvacet na každou postavu.
 *  2. **spolehlivost.** Čím menší plocha, tím míň místa, kde může model
 *     „ujet". Mimo výřez se vrací původní obrázek bod po bodu, takže
 *     překreslený obličej při oblékání bot není možný **z principu**,
 *     ne proto, že to pochytá kontrola.
 *  3. **detail.** Kapesníček dostane na výřezu klopy desetkrát víc
 *     bodů než na celé postavě, takže je na něm vidět látka, ne skvrna.
 *
 * ## Co se hlídá
 *
 * Rozměry musí být násobek šestnácti a poměr stran nejvýš 1:3 — to je
 * mez rozhraní. Výřez užší než to se proto rozšíří; když už by byl skoro
 * jako celé plátno, pošle se rovnou celé (ušetřit není co).
 */
export function vyrezKusu(
  typ: ZkVrstvaTyp,
  postava: px.Okraje,
  sirka: number,
  vyska: number,
  /** Bere model libovolný rozměr? Starší jen tři předepsané. */
  volneRozmery = true,
  /** Nejmenší obrázek, který rozhraní přijme. Je to vlastnost rozhraní,
      ne naše volba — proto se dá předat (a ve zkoušce zmenšit). */
  nejmene = NEJMENE_BODU
): px.Obdelnik {
  const cele: px.Obdelnik = { x: 0, y: 0, w: sirka, h: vyska };
  const pruh = pruhKusu(typ, postava, vyska);
  if (typ === 'postava') return cele;

  if (!volneRozmery) {
    /*
     * Starší modely berou jen 1024×1024, 1024×1536 a 1536×1024. Na plátně
     * na výšku z toho zbývá čtverec — a ten stojí dvě třetiny celého
     * obrázku. Kam se pruh nevejde, jde celé plátno.
     */
    const strana = Math.min(sirka, vyska);
    if (strana >= pruh.do - pruh.od) {
      const stred = Math.round((pruh.od + pruh.do) / 2 - strana / 2);
      const y = Math.max(0, Math.min(vyska - strana, stred));
      const x = Math.max(0, Math.min(sirka - strana, Math.round(postava.x + postava.w / 2 - strana / 2)));
      if (strana * strana < sirka * vyska * 0.95) return { x, y, w: strana, h: strana };
    }
    return cele;
  }

  /* Okraj kolem pruhu: model potřebuje vidět, na co kus navazuje */
  const okraj = Math.round(postava.h * 0.06);
  let y1 = Math.max(0, pruh.od - okraj);
  let y2 = Math.min(vyska, pruh.do + okraj);
  const bok = Math.round(postava.w * 0.12);
  let x1 = Math.max(0, postava.x - bok);
  let x2 = Math.min(sirka, postava.x + postava.w + bok);

  /*
   * Rozhraní má tři meze: násobek šestnácti, poměr stran do 1:3 a
   * nejmíň 0,65 megabodu. Ta poslední je ta překvapivá — menší výřez
   * než zhruba 1024×640 prostě nevezme, takže z úspory je strop.
   */
  const rozsir = () => {
    for (let pokus = 0; pokus < 40; pokus++) {
      const w = x2 - x1;
      const h = y2 - y1;
      const malyPomer = w * 3 < h;
      const velkyPomer = h * 3 < w;
      const maloBodu = w * h < nejmene;
      if (!malyPomer && !velkyPomer && !maloBodu) return;
      if (malyPomer || (maloBodu && w < sirka)) {
        const krok = Math.max(16, Math.round((sirka - w) / 8));
        x1 = Math.max(0, x1 - krok);
        x2 = Math.min(sirka, x2 + krok);
      }
      if (velkyPomer || (maloBodu && (x2 - x1) >= sirka)) {
        const krok = Math.max(16, Math.round((vyska - h) / 8));
        y1 = Math.max(0, y1 - krok);
        y2 = Math.min(vyska, y2 + krok);
      }
      if (x1 === 0 && y1 === 0 && x2 === sirka && y2 === vyska) return;
    }
  };
  rozsir();

  x1 = Math.max(0, Math.floor(x1 / 16) * 16);
  y1 = Math.max(0, Math.floor(y1 / 16) * 16);
  x2 = Math.min(sirka, Math.ceil(x2 / 16) * 16);
  y2 = Math.min(vyska, Math.ceil(y2 / 16) * 16);
  const w = x2 - x1;
  const h = y2 - y1;
  if (w * h < nejmene) return cele;
  if (w * 3 < h || h * 3 < w) return cele;
  /* Kdyby zbylo přes devadesát procent plochy, nestojí to za složitost */
  if (w * h > sirka * vyska * 0.9) return cele;
  return { x: x1, y: y1, w, h };
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
/**
 * Pruh, ve kterém kus látky leží.
 *
 * Jedno místo pro tři věci, které spolu **musí** souhlasit: co se pošle
 * modelu jako maska, odkud se bere rozdíl dvou kroků a co se z nového
 * kroku vůbec převezme. Kdyby se každá z nich počítala zvlášť, stačilo
 * by změnit jednu mez a vrstva by se brala odjinud, než kam model směl
 * kreslit — a nikdo by nepoznal proč.
 */
export function pruhKusu(
  typ: ZkVrstvaTyp,
  postava: px.Okraje | KdePostava,
  vyska: number
): { od: number; do: number } {
  const k = vrstvaDef(typ).kontrola;
  /* Rezerva kolem mezí: límec saka sahá o kousek výš, než se čeká, a
     tvrdá hranice by ho odřízla */
  const rezerva = 0.07;
  let od = Math.max(0, Math.round(postava.y + (k.odY - rezerva) * postava.h));
  /*
   * Oblečení začíná u krku. Nad ním je obličej, a ten se mezi kroky
   * měnit nesmí — ani o vous. Pruhy ze zlomků výšky tam sahaly u šesti
   * kusů z jedenácti, takže model směl obličej překreslit, a ve vrstvě
   * se sakem pak visela celá hlava.
   */
  const krk = (postava as KdePostava).krk;
  if (krk && !NAD_KRKEM.has(typ)) od = Math.max(od, krk);
  return {
    od,
    do: Math.min(vyska, Math.round(postava.y + (k.doY + rezerva) * postava.h))
  };
}

/**
 * Kusy, které na hlavu patří — ty se krkem neomezují.
 *
 * Od chvíle, kdy jsou vlasy i vousy součástí postavy, je tu jediná:
 * sama postava. Vlasy jako vrstva byly to jediné, co se kdy odečítalo
 * nad obličejem, a byly i jediné, kde se duch obličeje objevil.
 */
const NAD_KRKEM = new Set<ZkVrstvaTyp>(['postava']);

/**
 * Stane se tahle vrstva základem pro další oblékání?
 *
 * Jen první varianta kusu, a **nikdy vlasy ani vousy**. Na nich se
 * oblékalo dál a jediný nepovedený účes tím otrávil všechno po sobě:
 * na krocích měla postava od vlasů dál černou hlavu místo obličeje a
 * sako ji pak „opravilo", takže ve vrstvě se sakem visel celý
 * obličej. Oblečení začíná u krku, takže na hlavě nezáleží.
 */
export function zapisujeKrok(typ: ZkVrstvaTyp, varianta: string): boolean {
  if (NAD_KRKEM.has(typ)) return false;
  return vrstvaDef(typ).varianty[0].id === varianta;
}


/**
 * Dosah postavy — postava a její těsné okolí.
 *
 * Oblečení i vlasy přečnívají přes obrys kroku před: sako je širší než
 * košile pod ním a vlasy přidají hlavě pár centimetrů. Proto se obrys
 * rozšíří, a to podle velikosti postavy, ne pevným počtem bodů — táž
 * postava se kreslí na plátno 1024 i 1536 bodů vysoké.
 *
 * Tři procenta výšky postavy jsou na plátně 1024×1536 zhruba čtyřicet
 * bodů, tedy několikanásobek toho, oč účes přeroste holou hlavu, a
 * zároveň zlomek toho, co zabere zaplněné pozadí.
 */
export function dosahPostavy(pred: Obraz, postava: px.Okraje): Uint8Array {
  return px.rozsir(siluetaPostavy(pred), pred.sirka, pred.vyska, precnivani(postava));
}

/** Oč kus smí přerůst obrys kroku před. */
function precnivani(postava: px.Okraje): number {
  return Math.max(12, Math.round(postava.h * 0.03));
}

/**
 * Kam model opravdu smělo sáhnout — postava a těsné okolí **toho, co se
 * na ní změnilo**.
 *
 * Samotná postava a pás kolem ní nestačí. Když model nechal hlavu holou
 * a zaplnil kolem ní pozadí, zbyl by z toho prstenec vyplněného pozadí
 * kolem celé postavy a ve vrstvě by visel jako obrys. Vlasy ale
 * přerůstají hlavu **tam, kde se hlava změnila** — proto se okolí měří
 * od změny, ne od obrysu. Když se na postavě nezměnilo nic, nezůstane
 * ani okolí a v okně stojí po pravdě, že model nic nepřikreslil.
 */
function dosahZmeny(pred: Obraz, postava: px.Okraje, vPruhu: Obraz): Uint8Array {
  const silueta = siluetaPostavy(pred);
  const zmena = px.rozdil(pred, vPruhu);
  for (let i = 0; i < zmena.length; i++) if (!silueta[i]) zmena[i] = 0;

  /*
   * Barva toho, co na postavě vzniklo. Venku kolem postavy se totiž
   * nebere všechno, co je blízko — bere se jen to, co **vypadá jako ten
   * kus**. Vlasy přerůstající hlavu mají barvu vlasů, klopa saka barvu
   * saka; zaplněné pozadí má barvu pozadí a mezi vlasy a pozadím je
   * rozdíl o stovky stupňů. Bez téhle podmínky by kolem účesu zůstal
   * světlý lem a nikdo by nepoznal, odkud se vzal.
   */
  const barva = prostredniBarva(vPruhu, zmena);
  const dosah = px.rozsir(zmena, pred.sirka, pred.vyska, precnivani(postava));
  for (let i = 0; i < dosah.length; i++) {
    if (silueta[i]) { dosah[i] = 255; continue; }
    if (!dosah[i] || !barva) continue;
    const j = i * 4;
    const odchylka = Math.abs(vPruhu.body[j] - barva[0])
      + Math.abs(vPruhu.body[j + 1] - barva[1])
      + Math.abs(vPruhu.body[j + 2] - barva[2]);
    if (odchylka > PODOBNA_BARVA) dosah[i] = 0;
  }
  return dosah;
}

/**
 * Oč se smí barva kusu venku kolem postavy lišit od té, co vznikla na
 * ní. Sto dvacet stupňů přes tři složky je čtyřicet na složku — pod
 * tím se vejde stín i odlesk téže látky, nad ním končí jiná věc.
 */
const PODOBNA_BARVA = 120;

/** Prostřední barva míst, kde maska svítí. Medián, ne průměr: jeden
    bílý odlesk by průměr odtáhl, medián ne. */
function prostredniBarva(obraz: Obraz, maska: Uint8Array): [number, number, number] | null {
  const slozky: number[][] = [[], [], []];
  /* Stačí vzorek — u velkých vrstev by se jinak třídily statisíce čísel */
  const krok = Math.max(1, Math.floor(Math.sqrt(maska.length) / 64));
  for (let i = 0; i < maska.length; i += krok) {
    if (!maska[i]) continue;
    for (let k = 0; k < 3; k++) slozky[k].push(obraz.body[i * 4 + k]);
  }
  if (slozky[0].length === 0) return null;
  const median = (pole: number[]) => {
    pole.sort((a, b) => a - b);
    return pole[Math.floor(pole.length / 2)];
  };
  return [median(slozky[0]), median(slozky[1]), median(slozky[2])];
}

/**
 * Maska, kterou se modelu omezí, kam smí kreslit.
 *
 * Průhledné místo znamená „tady uprav", neprůhledné „tady nech". Když je
 * volba vypnutá, modelu se maska neposílá vůbec a spoléhá se jen na
 * zadání.
 *
 * ## Proč maska není celý pruh
 *
 * Pruh je vodorovný. U vlasů to znamená pás přes celé plátno ve výšce
 * hlavy — a hlava v něm zabírá sotva desetinu šířky. Zbytek je prázdné
 * pozadí a model ho bere jako místo, které má vyplnit: přišel zpátky
 * výřez, kde hlava zůstala holá a zaplnilo se okolí krku a ramen.
 * Maska proto otevírá jen postavu a její těsné okolí — tam, kde kus
 * oblečení vůbec může být.
 */
export function maskaProKus(
  typ: ZkVrstvaTyp,
  pred: Obraz,
  vyrez?: px.Obdelnik
): Obraz | undefined {
  if (getSetting('zkMaska', '1') !== '1') return undefined;
  const postava = okrajePostavy(pred);
  const pruh = pruhKusu(typ, postava, pred.vyska);
  const dosah = dosahPostavy(pred, postava);
  const kde = vyrez ?? { x: 0, y: 0, w: pred.sirka, h: pred.vyska };
  const maska = novyObraz(kde.w, kde.h);
  for (let y = 0; y < kde.h; y++) {
    const naPlatne = kde.y + y;
    const vPruhu = naPlatne >= pruh.od && naPlatne <= pruh.do;
    for (let x = 0; x < kde.w; x++) {
      const i = (y * kde.w + x) * 4;
      const upravit = vPruhu && dosah[naPlatne * pred.sirka + kde.x + x] !== 0;
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
  const potiz = zkontrolujPostavu(kde, obraz.vyska);
  if (potiz) throw new Error(potiz);

  /*
   * Nová postava znamená **nového člověka**: jiná ramena, jiný postoj,
   * jiné světlo. Co se oblékalo na tu starou, na něm viselo o kus vedle
   * — a v okně by u toho svítilo „hotovo". Zahodí se to hned, ať se na
   * tom nestaví dál.
   */
  const zahozeno = store.zahodOblekani(id);
  if (zahozeno > 0) hlas({ postava: id, typ: 'postava', stav: 'uklid', zahozeno });

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

/**
 * Je postava použitelná jako základ?
 *
 * Kontroluje se dřív, než se na ni začne oblékat — a je to ta
 * nejlevnější kontrola v celé kabině. Postava stojí jeden obrázek,
 * oblečení dvaadvacet: nakreslit dvaadvacet vrstev na postavu, které
 * chybí půlka bot, znamená zaplatit dvaadvacetkrát za něco, co se stejně
 * zahodí.
 *
 * Mezera u okraje musí být, protože výška se počítá od temene
 * k podrážce. Postava uříznutá dole vypadá vyšší, než je, a každý kus
 * oblečení pak sedí o kousek jinam.
 */
export function zkontrolujPostavu(kde: px.Okraje, vyska: number): string {
  if (kde.podil < 0.08) {
    return 'Na obrázku skoro nic není — model nakreslil prázdné plátno nebo samé pozadí.';
  }
  if (kde.podil > 0.75) {
    return 'Postava zabírá skoro celé plátno — nejspíš je to detail, ne celá figura.';
  }
  if (kde.y <= 2) return 'Postava je useknutá nahoře — od temene se počítá výška, takže se musí vejít celá.';
  if (kde.y + kde.h >= vyska - 2) return 'Postava je useknutá dole — nohy musí být celé, od nich se měří výška.';
  if (kde.h < vyska * 0.5) return 'Postava je na plátně moc malá — vrstvy by z ní vyšly rozmazané.';
  return '';
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
/**
 * Podklad, na který se kus kreslí.
 *
 * ## Proč se skládá, a nebere od modelu
 *
 * Dřív se obléká postupně a každý krok byl obrázek od modelu: kravata
 * se kreslila na obrázek, který vyšel z kroku s košilí. Jenže ten
 * obrázek je **nový obrázek**, ne původní postava s košilí — a jediný
 * nepovedený krok otrávil všechno po sobě. Na krocích oblékání měla
 * postava od vlasů dál černou hlavu místo obličeje a každý další kus
 * se kreslil na ni.
 *
 * Podklad se proto skládá z toho, co máme: z postavy a z vrstev, které
 * už jsou hotové. Je to tentýž výpočet, jakým se model skládá
 * zákazníkovi v prohlížeči, takže model vidí přesně to, co uvidí on.
 * Nepovedená vrstva se do podkladu nedostane a nemá co otrávit.
 *
 * Doplňky (kravata, kšandy, pásek, kapesníček) se do podkladu nedávají:
 * jsou jeden místo druhého a kreslit kravatu přes kšandy nedává smysl.
 */
export function podkladProKus(postavaId: string, typ: ZkVrstvaTyp): Obraz {
  const vrstvy = store.vrstvy(postavaId);
  const zaklad = vrstvy.find(one => one.typ === 'postava' && one.soubor);
  if (!zaklad || !fs.existsSync(zaklad.soubor)) {
    throw new Error('Nejdřív se musí nakreslit postava.');
  }
  const postava = nacti(fs.readFileSync(zaklad.soubor));
  const kusy: { obraz: Obraz; hex?: string }[] = [{ obraz: postava }];
  for (const def of ZK_VRSTVY) {
    if (def.typ === typ) break;
    if (def.typ === 'postava' || def.zbozi) continue;
    const hex = ZK_PODKLAD_HEX[def.typ];
    if (!hex) continue;
    const vrstva = vrstvy.find(one =>
      one.typ === def.typ && one.varianta === def.varianty[0].id
      && one.stav !== 'nesedi' && one.soubor && fs.existsSync(one.soubor));
    if (!vrstva) continue;
    kusy.push({ obraz: nacti(fs.readFileSync(vrstva.soubor)), hex });
  }
  if (kusy.length === 1) return postava;
  return px.slozeni(kusy, postava.sirka, postava.vyska);
}

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

  hlas({ postava: postavaId, typ, varianta, stav: 'kreslim' });
  const zaklad = podkladProKus(postavaId, typ);
  const kdePostava = okrajePostavy(zaklad);
  const vyrez = vyrezKusu(
    typ, kdePostava, zaklad.sirka, zaklad.vyska, obrazky.model().volneRozmery
  );
  const naVyrezu = vyrez.w < zaklad.sirka || vyrez.h < zaklad.vyska;
  const zadani = zadaniKusuTed(typ, varianta, naVyrezu);

  /*
   * Modelu se posílá **jen výřez**, ne celá postava: je to levnější,
   * míň místa na ujetí a víc bodů na detail.
   */
  const vstup = px.vyrizniObdelnik(zaklad, vyrez);
  const vracene = await obrazky.dokresli(zadani, vstup, maskaProKus(typ, zaklad, vyrez));
  const vysledek = vrstvaZObrazku(p, typ, varianta, zaklad, vracene, zadani, vyrez);

  /*
   * Co přišlo od modelu, se uloží jako krok oblékání. Není to podklad
   * pro nic dalšího — ten se skládá — ale v okně je na něm vidět, co
   * model opravdu nakreslil, a to je jediné, podle čeho se dá poznat,
   * proč vrstva vyšla, jak vyšla.
   */
  const poradi = ZK_VRSTVY.findIndex(one => one.typ === typ);
  const krok = store.cestaKroku(postavaId, poradi, `${typ}-${varianta}`);
  fs.writeFileSync(krok, uloz(vysledek.krok));
  if (zapisujeKrok(typ, varianta) && vysledek.vrstva.stav !== 'nesedi') {
    store.zapisKrok(postavaId, poradi, typ, krok);
  }

  store.zapisVrstvu(vysledek.vrstva);
  hlas({ postava: postavaId, typ, varianta, stav: vysledek.vrstva.stav, potiz: vysledek.vrstva.potiz });
  return { vrstva: vysledek.vrstva, krok };
}

/**
 * Z obrázku od modelu vybere kus látky. Bez sítě — tudy chodí i zkouška.
 *
 * ## Jak se kus pozná
 *
 * Podle barvy, ne podle rozdílu proti podkladu. Model dostal zadání
 * nakreslit kus v syté purpurové; purpurové body jsou ten kus. Všechno
 * ostatní — překreslený obličej, posunutý stín, jinak vykreslená ruka —
 * purpurové není, takže se do vrstvy nedostane. Ne proto, že by to
 * zahodil nějaký práh, ale protože to tam nepatří.
 *
 * Tím odpadlo všechno, co se kolem rozdílu dvou obrázků nastavělo:
 * srovnávání tónu, přizpůsobivý práh, dvojí zúžení masky, hlídání
 * dosahu změny i měření, kolik vrstvy leží na postavě. Žádné z toho
 * nefungovalo spolehlivě, protože se snažilo uhodnout, co model udělal
 * schválně a co jen tak.
 *
 * Zbyly dvě věci, a obě mají důvod:
 *
 *  * **posun** — model obrázek občas odnese o pár bodů. Měří se mimo
 *    pruh, kde se obléká, protože tam má být obrázek stejný.
 *  * **pruh a postava** — purpurová se bere jen tam, kam kus patří.
 *    Kdyby model purpurou vymaloval pozadí, není to kus látky.
 */
export function vrstvaZObrazku(
  p: ZkPostava,
  typ: ZkVrstvaTyp,
  varianta: string,
  zaklad: Obraz,
  /** Co přišlo od modelu — jen výřez, pokud se posílal výřez. */
  vracene: Obraz,
  zadani: string,
  vyrez?: px.Obdelnik
): { vrstva: ZkVrstva; krok: Obraz } {
  const def = vrstvaDef(typ);
  const kdePostava = okrajePostavy(zaklad);
  const pruh = pruhKusu(typ, kdePostava, zaklad.vyska);
  const kde0 = vyrez ?? { x: 0, y: 0, w: zaklad.sirka, h: zaklad.vyska };
  const cely = vracene.sirka === zaklad.sirka && vracene.vyska === zaklad.vyska
    ? vracene
    : px.vlozObdelnik(zaklad, vracene, kde0);

  /*
   * Kotva na měření posunu leží ve výřezu a mimo pruh: tam se nic
   * měnit nemělo, takže rozdíl je čistě posun. Když se nikam nevejde,
   * neposouvá se — zarovnání na místě, kde se zrovna obléká, by
   * naměřilo nesmysl.
   */
  const kotva = pruh.od - kde0.y >= 24
    ? { x: kde0.x, y: kde0.y, w: kde0.w, h: pruh.od - kde0.y }
    : (kde0.y + kde0.h - pruh.do >= 24
      ? { x: kde0.x, y: pruh.do, w: kde0.w, h: kde0.y + kde0.h - pruh.do }
      : null);
  const posun = kotva ? px.zarovnej(zaklad, cely, kotva, 4) : { dx: 0, dy: 0, chyba: 0 };
  const srovnany = posunObraz(cely, -posun.dx, -posun.dy);

  /* Purpurové body — a jen ty, co jsou tam, kde kus patří */
  const maska = px.maskaBarvy(srovnany, signalniBarva(typ));
  const dosah = dosahPostavy(zaklad, kdePostava);
  for (let y = 0; y < zaklad.vyska; y++) {
    const vPruhu = y >= pruh.od && y <= pruh.do;
    for (let x = 0; x < zaklad.sirka; x++) {
      const i = y * zaklad.sirka + x;
      if (!vPruhu || !dosah[i]) maska[i] = 0;
    }
  }
  /* Odlesk na látce odstín ztratí a knoflík ho nemá vůbec — díry se
     zavřou, ať jimi na modelu neprosvítá košile */
  const zavrena = px.zavriDiry(maska, zaklad.sirka, zaklad.vyska, 4);
  /*
   * A pak jen to, co leží na postavě. Kreslicí barvou vymalované
   * pozadí vedle postavy je souvislá skvrna, která se siluety
   * nedotkne — kus oblečení je na člověku.
   */
  const cista = px.jenVelke(
    px.jenNaPostave(zavrena, siluetaPostavy(zaklad), zaklad.sirka, zaklad.vyska),
    zaklad.sirka, zaklad.vyska
  );

  const kde = px.okraje(cista, zaklad.sirka, zaklad.vyska);
  const podilNaPostave = kdePostava.podil > 0 ? kde.podil / kdePostava.podil : 0;
  const nalez = zkontrolujVrstvu(
    typ,
    {
      okraje: { x: kde.x, y: kde.y, w: kde.w, h: kde.h },
      podil: podilNaPostave,
      naPostave: naPostave(cista, dosah, zaklad.sirka, zaklad.vyska)
    },
    { y: kdePostava.y, h: kdePostava.h }
  );
  const potiz = nalez.potiz;

  const obraz = def.barvitelna ? px.stinovaMapa(srovnany, cista) : px.vyrizni(srovnany, cista);

  /*
   * Vrstva se ukládá **i když neprojde kontrolou**. Používat se nebude —
   * to hlídá stav — ale v okně je pak vidět, co z toho vlastně vyšlo.
   */
  const soubor = store.cestaVrstvy(p.id, typ, varianta);
  fs.writeFileSync(soubor, uloz(obraz));

  return {
    vrstva: {
      postava: p.id, typ, varianta,
      soubor,
      url: '',
      sirka: zaklad.sirka, vyska: zaklad.vyska,
      podil: podilNaPostave,
      okraje: { x: kde.x, y: kde.y, w: kde.w, h: kde.h },
      stav: potiz ? 'nesedi' : 'hotovo',
      potiz: potiz || nalez.varovani,
      zadani,
      kdy: new Date().toISOString()
    },
    krok: srovnany
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
export function plan(
  postavaId: string,
  jenChybejici = true,
  /** `zakladni` kreslí doplňky a jednu podobu kulisy; `vse` i varianty navíc. */
  rozsah: 'zakladni' | 'vse' = 'zakladni'
): { typ: ZkVrstvaTyp; varianta: string }[] {
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
      if (rozsah === 'zakladni' && !doZakladu(def, varianta.id)) continue;
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
export async function vygenerujVse(
  postavaId: string,
  jenChybejici = true,
  rozsah: 'zakladni' | 'vse' = 'zakladni'
): Promise<{ hotovo: number; nesedi: number; potize: string[] }> {
  const p = store.postava(postavaId);
  if (!p) throw new Error(`Postava ${postavaId} v seznamu není.`);
  if (!p.hotovo) await vygenerujPostavu(postavaId);

  const ukoly = plan(postavaId, jenChybejici, rozsah);
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

export const __test = {
  maskaProKus, pruhKusu, vyrezKusu, okrajePostavy, siluetaPostavy, naPostave, dosahPostavy, kdeKrk, zapisujeKrok,
  posunObraz, vrstvaZObrazku, podkladProKus, zkontrolujPostavu, plan
};
