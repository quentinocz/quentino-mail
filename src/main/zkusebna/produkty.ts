import { nativeImage } from 'electron';
import { ask } from '../ai';
import { getSetting, setSetting } from '../db';
import { listProducts } from '../products';
import { getDb } from '../db';
import {
  ZkProdukt, ZkVek, ZkVrstvaTyp, ZK_VRSTVY, sablonaPro, variantaPodleRozmeru, vrstvaDef
} from '../../shared/zkusebna';
import { getField, productParameters } from '../ptrans/xml';
import { Obraz, nacti, novyObraz, uloz } from './png';
import { barvaProduktu, okraje, pozadiOdKraje, zmensi } from './pixely';
import { najdiLatku } from './latka';
import * as store from './store';

/**
 * Co z katalogu patří na model a jakou to má barvu.
 *
 * ## Proč se to netřídí jen podle kategorie
 *
 * Kategorie v e-shopu jsou pro zákazníka, ne pro kabinu: „Svatební"
 * obsahuje sako, vestu, kravatu i kapesníček. Třídí se proto podle slov
 * v názvu a kategorii naráz, a co z toho nevyjde jednoznačně, dotřídí
 * model — a nakonec to **vidí člověk**, protože špatně zařazený produkt
 * se v kabině projeví tak, že si zákazník obleče kravatu místo pásku.
 *
 * ## Proč se barva počítá z fotky a nebere z názvu
 *
 * V názvu je „modrá", jenže modrých je dvacet a zákazník si v kabině
 * vybírá **přesný odstín**. Z fotky se proto vezme nejčastější barva
 * látky: pozadí se doplní od kraje (ne podle bílé — u bílé košile by se
 * umazala košile) a z toho, co zbude, se vybere nejhustší shluk barev.
 * Průměr by nešel: průměr šedého saka s bílou košilí a černou kravatou
 * je mdlá šedohnědá, která nesedí na nic.
 *
 * Ručně přepsaná barva se už nikdy nepřepočítá. Kdo barvu opravil, má
 * k tomu důvod, který z fotky vidět není.
 */

/* ----------------------------------------------------------- zařazení */

/** Bez diakritiky a malými písmeny — ať „Kšandy" a „ksandy" sedí na totéž. */
function bezDiakritiky(text: string): string {
  return String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export interface Zarazeni {
  typ: ZkVrstvaTyp | '';
  varianta: string;
  /** Jak jistě — podle toho se pozná, co má dotřídit model. */
  jiste: boolean;
  /** Další kusy sady podle názvu (kšandy **s motýlkem**). */
  casti?: { typ: ZkVrstvaTyp; varianta: string }[];
  /** Proč to musí před kabinou vidět člověk. */
  kontrola?: string;
}

/** Rozměr výrobku z katalogu — šířka kravaty a kšand, rozměr motýlka. */
export interface Rozmer {
  sirkaCm?: number;
  vyskaCm?: number;
}

const cislo = (text: string) => Number.parseFloat(text.replace(',', '.'));

/**
 * Rozměr z parametrů a popisu výrobku.
 *
 * Na e-shopu je to takhle (zjištěno 23. 11. na quentino.cz):
 *  - kravaty a kšandy mají parametr „Šířka" („7cm", „2,5cm"),
 *  - motýlek parametr nemá, rozměr je jen v popisu („Rozměry: 12 × 5,5 cm"),
 *  - kravata má šířku i v popisu („Šířka kravaty: 7 cm").
 * Parametr má přednost, popis je záloha.
 */
export function rozmerZTextu(parametry: { nazev: string; hodnota: string }[], popis: string): Rozmer {
  const out: Rozmer = {};
  for (const one of parametry) {
    const nazev = bezDiakritiky(one.nazev);
    const m = /(\d+(?:[.,]\d+)?)\s*cm/i.exec(one.hodnota) ?? /^(\d+(?:[.,]\d+)?)$/.exec(one.hodnota.trim());
    if (!m) continue;
    if (/^sir(k|e)/.test(nazev)) out.sirkaCm = cislo(m[1]);
  }
  const text = bezDiakritiky(popis.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' '));
  const rozmery = /rozmer\w*\s*:?\s*(\d+(?:[.,]\d+)?)\s*(?:x|×|\*)\s*(\d+(?:[.,]\d+)?)\s*cm/i.exec(
    popis.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/<[^>]+>/g, ' ')
  );
  if (rozmery) {
    const a = cislo(rozmery[1]);
    const b = cislo(rozmery[2]);
    if (!out.sirkaCm) out.sirkaCm = Math.max(a, b);
    out.vyskaCm = Math.min(a, b);
  }
  if (!out.sirkaCm) {
    const sirka = /sir(?:k|e)a?\s*(?:kravaty|ksand|sli)?\s*:?\s*(\d+(?:[.,]\d+)?)\s*cm/.exec(text);
    if (sirka) out.sirkaCm = cislo(sirka[1]);
  }
  return out;
}

/**
 * Rozměr výrobku z databáze překladů, kde je celý blok z feedu.
 *
 * Katalog aplikace si z feedu bere jen to, co potřebuje pošta (název,
 * cena, sklad); parametry a popis má celé jen modul Překlady. Když tam
 * výrobek není, rozměr se nezjistí a zařazení se řídí názvem.
 */
export function rozmerProduktu(kod: string): Rozmer {
  try {
    const row = getDb().prepare('SELECT raw_xml FROM ptrans_products WHERE code = ?').get(kod) as { raw_xml?: string } | undefined;
    const blok = row?.raw_xml ?? '';
    if (!blok) return {};
    const parametry = productParameters(blok).map(one => ({
      nazev: (/<NAME language="cz"[^>]*>([\s\S]*?)<\/NAME>/.exec(one)?.[1] ?? '').replace(/<!\[CDATA\[|\]\]>/g, '').trim(),
      hodnota: (/<VALUE language="cz"[^>]*>([\s\S]*?)<\/VALUE>/.exec(one)?.[1] ?? '').replace(/<!\[CDATA\[|\]\]>/g, '').trim()
    }));
    const popis = `${getField(blok, 'cz', 'short') ?? ''} ${getField(blok, 'cz', 'long') ?? ''}`;
    return rozmerZTextu(parametry, popis);
  } catch {
    return {};
  }
}

/**
 * Zařazení podle slov a rozměru.
 *
 * Varianta tu není kosmetika: podle ní se vybere **šablona**, a ta má
 * šířku výrobku. Sedmička je nejčastější kravata (190 ze 251), takže
 * bez rozměru se bere ona; dětská kravata je vždy šestka (všech 53 na
 * e-shopu), dětský motýlek a „MINI" mají vlastní menší šablonu.
 */
export function zarad(nazev: string, kategorie: string, rozmer: Rozmer = {}): Zarazeni {
  const text = `${bezDiakritiky(nazev)} ${bezDiakritiky(kategorie)}`;
  const jmeno = bezDiakritiky(nazev);
  const nalezy: { typ: ZkVrstvaTyp; delka: number }[] = [];
  /*
   * Hledá se jen mezi **zbožím**. Oblek a košile jsou v kabině kulisa,
   * kterou si zákazník nastavuje barvou — přiřadit k nim produkt nemá
   * kam, a kdyby se to zkusilo, „Kravata k obleku" by se stala sakem.
   */
  for (const def of ZK_VRSTVY) {
    if (!def.zbozi) continue;
    for (const slovo of def.slova) {
      const hledane = bezDiakritiky(slovo);
      /*
       * Název váží víc než kategorie a **dřív zmíněný kus víc než
       * pozdější**: v sadě „motýlek s kapesníčkem" nebo „regata
       * s kapesníčkem" je hlavní kus první, kapesníček je přídavek.
       */
      const kde = hledane ? jmeno.indexOf(hledane) : -1;
      if (kde >= 0) nalezy.push({ typ: def.typ, delka: 1000 - kde * 4 + hledane.length });
      else if (hledane && text.includes(hledane)) nalezy.push({ typ: def.typ, delka: hledane.length });
    }
  }
  if (nalezy.length === 0) return { typ: '', varianta: '', jiste: false };
  /*
   * Delší slovo vyhrává. „Oblek" je v názvu „Pásek k obleku" taky, ale
   * „pasek" je přesnější shoda než „oblek" — a bez tohohle pravidla by
   * se každý doplněk s obleky v názvu stal sakem.
   */
  nalezy.sort((a, b) => b.delka - a.delka);
  /*
   * Sada „motýlek a kapesníček" nebo „regata s kapesníčkem": na model
   * jde ten hlavní kus — v názvu je první, kapesníček je „s"/„a" navíc.
   */
  const typ = nalezy[0].typ;
  /* Jisté, když jiný typ nemá stejně silnou shodu (dvě slova téhož typu nevadí) */
  const jiny = nalezy.find(one => one.typ !== typ);
  const jiste = !jiny || nalezy[0].delka > jiny.delka;
  const varianta = variantaHlavniho(typ, jmeno, text, rozmer);
  const { casti, kontrola } = sada(jmeno, typ);
  return { typ, varianta, jiste, ...(casti.length ? { casti } : {}), ...(kontrola ? { kontrola } : {}) };
}

/**
 * Hlavní kus sady má variantu podle **svého** slova. „Kšandy s motýlkem"
 * jsou kšandy, a kdyby se varianta brala z celého názvu, vyšly by
 * z motýlka. Totéž u „kravaty s kapesníčkem".
 */
function variantaHlavniho(typ: ZkVrstvaTyp, jmeno: string, text: string, rozmer: Rozmer): string {
  if (typ !== 'kravata') return variantaZbozi(typ, text, rozmer);
  const prvni = KUS_SLOVA.map(one => ({ ...one, kde: jmeno.search(one.re) }))
    .filter(one => one.typ === 'kravata' && one.kde >= 0)
    .sort((a, b) => a.kde - b.kde)[0];
  if (!prvni) return variantaZbozi(typ, text, rozmer);
  /* Zbytek názvu za hlavním slovem do varianty nepatří — jen hlavní slovo a přívlastky */
  const omezeny = `${jmeno.slice(0, prvni.kde)}${jmeno.slice(prvni.kde).split(/\s(?:s|a|se|i|vcetne|plus|\+)\s/)[0]}`;
  return variantaZbozi(typ, omezeny, rozmer);
}

/** Slova, podle kterých se v názvu pozná kus — v pořadí, v jakém v názvu stojí. */
const KUS_SLOVA: { re: RegExp; typ: ZkVrstvaTyp; varianta: (detske: boolean, mini: boolean) => string }[] = [
  { re: /motyl/, typ: 'kravata', varianta: (d, m) => (m ? 'motylek-mini' : d ? 'motylek-detsky' : 'motylek') },
  { re: /regat/, typ: 'kravata', varianta: () => 'regata' },
  { re: /kravat/, typ: 'kravata', varianta: d => (d ? 'kravata-6' : 'kravata') },
  { re: /ksand|\bsle\b/, typ: 'ksandy', varianta: d => (d ? 'uzke' : 'siroke') },
  { re: /kapesn|vreckov/, typ: 'kapesnicek', varianta: () => 'spicka' }
];

/**
 * Je to sada? Co dalšího je na modelu a proč to má vidět člověk.
 *
 * Patrik (23. 11.): u „kšand s motýlkem" se na modelu ukázaly jen
 * kšandy, u „kravaty s kapesníčkem" se produkt zařadil jako kapesníček
 * a u dárkové sady se na kravatu dláždila fotka šesti věcí. Sada proto
 * dostane další kusy a **musí ji zkontrolovat člověk** — každý kus
 * potřebuje vlastní látku, a ta se z jedné fotky celé sady nedá
 * spolehlivě vystřihnout.
 */
export function sada(jmeno: string, hlavni: ZkVrstvaTyp | ''): { casti: { typ: ZkVrstvaTyp; varianta: string }[]; kontrola: string } {
  const detske = /detsk|deti|kids|junior/.test(jmeno);
  const mini = /\bmini\b/.test(jmeno);
  const casti: { typ: ZkVrstvaTyp; varianta: string }[] = [];
  const videne = new Set<string>(hlavni ? [hlavni] : []);
  const nalezene = KUS_SLOVA.map(one => ({ ...one, kde: jmeno.search(one.re) }))
    .filter(one => one.kde >= 0)
    .sort((a, b) => a.kde - b.kde);
  for (const one of nalezene) {
    if (videne.has(one.typ)) continue;
    videne.add(one.typ);
    casti.push({ typ: one.typ, varianta: one.varianta(detske, mini) });
  }
  let kontrola = '';
  if (/\bsada\b|\bset\b|darkov|baleni|\(\d+ ?ks\)|\d+ ?ks\b/.test(jmeno)) kontrola = 'Sada více kusů — na fotce je víc věcí, látku je potřeba zadat ke každému kusu.';
  else if (casti.length) kontrola = 'Sada — každý kus potřebuje vlastní látku (nahraj fotku nebo vyber barvu).';
  return { casti, kontrola };
}

export function variantaZbozi(typ: ZkVrstvaTyp, text: string, rozmer: Rozmer = {}): string {
  const detske = /detsk|deti|kids|junior|chlapec/.test(text);
  if (typ === 'kravata') {
    if (/motyl|bow/.test(text)) {
      if (/\bmini\b/.test(text)) return 'motylek-mini';
      const podle = variantaPodleRozmeru('kravata', 'motylek', rozmer);
      if (podle && rozmer.sirkaCm) return podle;
      return detske ? 'motylek-detsky' : 'motylek';
    }
    if (/regat|ascot/.test(text)) return 'regata';
    if (/pleten|knit/.test(text)) return 'pletena';
    const podle = variantaPodleRozmeru('kravata', 'kravata', rozmer);
    if (podle) return podle;
    if (detske) return 'kravata-6';
    if (/\buzk|slim|skinny/.test(text)) return 'kravata-5';
    return 'kravata';
  }
  if (typ === 'ksandy') {
    const podle = variantaPodleRozmeru('ksandy', 'ksandy', rozmer);
    if (podle) return podle;
    if (detske || /\buzk/.test(text)) return 'uzke';
    /* Široké (3,5 cm) jsou na e-shopu nejčastější: 89 ze 126 */
    return 'siroke';
  }
  return vrstvaDef(typ).varianty[0]?.id ?? '';
}

/** Sedí uložená varianta k rodině? Jinak se přepočítá (motýlek nesmí zůstat jako kravata 7 cm). */
export function sjednotVariantu(typ: ZkVrstvaTyp, varianta: string): string {
  const def = vrstvaDef(typ);
  if (def.varianty.some(one => one.id === varianta)) return varianta;
  return def.varianty[0]?.id ?? '';
}
/* -------------------------------------------------------------- barva */

/**
 * Rozbalí obrázek na body.
 *
 * PNG si aplikace čte sama; fotky z e-shopu jsou ale JPEG a ten umí
 * rozbalit Electron. Předvynásobená průhlednost, kvůli které se
 * `nativeImage` u vrstev nepoužívá, tady nevadí: fotka produktu je
 * neprůhledná a jde jen o odhad barvy.
 */
export function dekoduj(data: Buffer): Obraz {
  try { return nacti(data); } catch { /* není PNG, zkusí se JPEG */ }
  const img = nativeImage.createFromBuffer(data);
  const velikost = img.getSize();
  if (!velikost.width || !velikost.height) throw new Error('Obrázek se nepodařilo přečíst.');
  const bgra = Buffer.from(img.getBitmap() as unknown as Uint8Array);
  const body = new Uint8Array(velikost.width * velikost.height * 4);
  for (let i = 0; i < body.length; i += 4) {
    body[i] = bgra[i + 2];
    body[i + 1] = bgra[i + 1];
    body[i + 2] = bgra[i];
    body[i + 3] = bgra[i + 3];
  }
  return { sirka: velikost.width, vyska: velikost.height, body };
}

/**
 * Barva **a vzorek** produktu z jeho fotky.
 *
 * Obojí z jednoho stažení: fotky je přes čtyři stovky a stahovat je
 * dvakrát by znamenalo dvakrát tak dlouhé projití katalogu.
 */
export async function zFotky(
  urls: string | string[],
  typ: ZkVrstvaTyp | '' = '',
  varianta = '',
  nazev = '',
  casti: { typ: ZkVrstvaTyp; varianta: string }[] = []
): Promise<{ hex: string; vzorek: string; vzorekCm: number; casti: { hex: string; vzorek: string; vzorekCm: number }[] }> {
  const nic = { hex: '', vzorek: '', vzorekCm: 0, casti: [] };
  const adresy = (Array.isArray(urls) ? urls : [urls]).filter(Boolean);
  if (!adresy.length) return nic;
  /*
   * Kolik fotek: u kšand a sad všechny (do tří) — první fotka kšand je
   * detail spony, pásek je až na dalších. U ostatního stačí první, a
   * další se stáhne, jen když na první nic rozumného není.
   */
  const vic = typ === 'ksandy' || casti.length > 0;
  const fotky: Obraz[] = [];
  const stahni = async (url: string) => {
    try {
      const odpoved = await fetch(url);
      if (!odpoved.ok) return;
      fotky.push(dekoduj(Buffer.from(await odpoved.arrayBuffer())));
    } catch { /* fotka, která se nestáhne, nevadí — zkusí se další */ }
  };
  for (const url of adresy.slice(0, vic ? 3 : 1)) await stahni(url);
  if (!fotky.length) return nic;
  const naData = (o: Obraz) => `data:image/png;base64,${uloz(o).toString('base64')}`;
  try {
    let hlavni: { obraz: Obraz; cm: number; roh?: boolean } | null = null;
    let hex = '';
    if (typ === 'kapesnicek') {
      hlavni = vzorekZFotky(fotky[0], typ, varianta, nazev);
    } else {
      let latka = najdiLatku(fotky, typ, varianta, nazev, casti.length && typ === 'ksandy' ? { jenKus: 'pasek' } : {});
      if ((!latka || latka.jistota < 0.3) && !vic && adresy.length > 1) {
        for (const url of adresy.slice(1, 3)) await stahni(url);
        latka = najdiLatku(fotky, typ, varianta, nazev) ?? latka;
      }
      if (latka) { hlavni = { obraz: latka.obraz, cm: latka.cm }; if (latka.jistota >= 0.25) hex = latka.hex; }
    }
    if (!hex) {
      const mensi = zmensi(fotky[0], Math.max(1, Math.round(fotky[0].sirka / 300)));
      hex = barvaProduktu(mensi).hex;
    }
    /*
     * Kusy sady: motýlek u kšand se hledá jako křídlo mezi pásky. Barva
     * z názvu („Cihlové kšandy s motýlkem") platí i pro něj, jen když
     * název neříká, že má vzor („…s květovaným motýlkem").
     */
    const vzorVNazvu = /kvet|vzor|kostk|ornament|paisley|pruh|puntik|barevn|kar[oa]/.test(bezDiakritiky(nazev));
    const vysledkyCasti = casti.map(c => {
      const jenKus = c.typ === 'kravata' && c.varianta.startsWith('motylek') ? 'motylek' as const : undefined;
      if (!jenKus) return { hex: '', vzorek: '', vzorekCm: 0 };
      const l = najdiLatku(fotky, c.typ, c.varianta, nazev, vzorVNazvu ? { jenKus, barva: null } : { jenKus });
      return l ? { hex: l.hex, vzorek: naData(l.obraz), vzorekCm: l.cm } : { hex: '', vzorek: '', vzorekCm: 0 };
    });
    return {
      hex,
      vzorek: hlavni ? naData(hlavni.obraz) : '',
      vzorekCm: hlavni?.cm ?? 0,
      casti: vysledkyCasti
    };
  } catch {
    return nic;
  }
}

/** Adresy fotek produktu z katalogu — hlavní a pár dalších. */
export function fotkyProduktu(kod: string): string[] {
  try {
    const row = getDb().prepare('SELECT image, images FROM products WHERE code = ?').get(kod) as { image?: string; images?: string } | undefined;
    const vse = [row?.image ?? '', ...String(row?.images ?? '').split('\n')].map(one => one.trim()).filter(Boolean);
    return [...new Set(vse)].slice(0, 3);
  } catch { return []; }
}

/**
 * Kousek látky z fotky — větší, bez švů a se známou velikostí.
 *
 * Patrik (23. 11.): textura kravaty na modelu „nevypadá vůbec jak by
 * měla". Tři důvody, každý viditelný:
 *
 *  1. **měřítko** — vzorek se dláždil bod na bod, takže 2,5 cm látky
 *     z fotky vyšlo na modelu přes osm centimetrů a z drobných kytek
 *     byly talíře, ze kterých se na úzkou kravatu vešel jen kus;
 *  2. **švy** — čtvereček dlážděný vedle sebe má na každém kraji hranu
 *     a na kravatě se z toho dělají pruhy;
 *  3. **rozlišení** — vzorek se bral z fotky zmenšené na 300 bodů.
 *
 * Teď se bere z fotky zmenšené na 600 bodů, co největší kus, který je
 * celý na výrobku, a zrcadlí se do dlaždice 2 × 2 (navazuje na všech
 * stranách). K němu se odhadne, **kolik centimetrů látky ukazuje**:
 * u motýlka z jeho šířky na fotce (známe ji z katalogu), u ostatních
 * z obvyklého záběru fotek na e-shopu. Kabina ho podle toho zmenší.
 */
export function vzorekZFotky(
  obraz: Obraz,
  typ: ZkVrstvaTyp | '' = '',
  varianta = '',
  nazev = ''
): { obraz: Obraz; cm: number; roh?: boolean } | null {
  const sirka = 600;
  const vetsi = zmensi(obraz, Math.max(1, Math.round(obraz.sirka / sirka)));
  /*
   * Kapesníček: z kapsy kouká špička. Bílý kapesníček s barevným lemem
   * se dřív vydláždil jako „průměrná" látka a na modelu byl celý
   * barevný (Patrik, 23. 11.). Fotky na e-shopu ho ukazují jako
   * kosočtverec — horní roh fotky je přesně ta špička i s lemem, a ten
   * se na šablonu položí celý, ne po dlaždicích.
   */
  if (typ === 'kapesnicek') {
    const roh = rohVyrobku(vetsi);
    /* Záporné „cm" = roh, kreslí se přes celý tvar (a nečte se znovu jako starý vzorek) */
    if (roh) return { obraz: roh, cm: -1, roh: true };
  }
  /*
   * Revize (24. 11.): výběr místa, vyrovnání světla a dlaždice bez švů
   * jsou v latka.ts — viz tam, proč (spona místo pásku, kaleidoskop).
   */
  const latka = najdiLatku([obraz], typ, varianta, nazev);
  if (latka) return { obraz: latka.obraz, cm: latka.cm };
  return null;
}

/**
 * Horní roh výrobku na fotce (kapesníček jako kosočtverec) — špička i s lemem.
 *
 * Roh se **přetáhne na tvar šablony**: trojúhelník špičky z fotky se
 * afinně namapuje na trojúhelník, který z kapsy kouká v kabině (špička
 * kousek vpravo od středu, základna u kapsy). Hrany kosočtverce tak
 * padnou na hrany šablony a lem bílého kapesníčku je vidět tam, kde má
 * být — po obou horních hranách, ne jako barevná skvrna uprostřed.
 * Kabina obrázek natáhne přes obdélník vrstvy, takže na velikosti
 * (pánský, dětský) nezáleží.
 */
export const ROH_SABLONY = { apex: [0.62, 0], levy: [0, 1], pravy: [1, 0.92] } as const;

function rohVyrobku(obraz: Obraz): Obraz | null {
  const pozadi = pozadiOdKraje(obraz);
  const maska = new Uint8Array(pozadi.length);
  for (let i = 0; i < maska.length; i++) maska[i] = pozadi[i] ? 0 : 255;
  const kde = okraje(maska, obraz.sirka, obraz.vyska);
  if (kde.w < 40 || kde.h < 40) return null;
  const S = obraz.sirka;
  /* Nejvyšší bod výrobku — tam je špička (střed nejvyššího řádku) */
  let od = -1; let doK = -1;
  for (let x = kde.x; x < kde.x + kde.w; x++) {
    if (maska[kde.y * S + x]) { if (od < 0) od = x; doK = x; }
  }
  const P = { x: od >= 0 ? (od + doK) / 2 : kde.x + kde.w / 2, y: kde.y + 2 };
  /* Kus pod špičkou: z kapsy kouká zhruba šestina výšky kosočtverce */
  const yd = Math.round(kde.y + kde.h * 0.16);
  let lx = -1; let rx = -1;
  for (let x = kde.x; x < kde.x + kde.w; x++) {
    if (maska[yd * S + x]) { if (lx < 0) lx = x; rx = x; }
  }
  if (lx < 0 || rx - lx < 8) return null;
  /* O kousek dovnitř, ať se nebere vyhlazený okraj s pozadím */
  const vnitr = (rx - lx) * 0.03;
  const Lp = { x: lx + vnitr, y: yd };
  const Rp = { x: rx - vnitr, y: yd };
  const W = 160; const H = 84;
  const A = { x: ROH_SABLONY.apex[0] * W, y: ROH_SABLONY.apex[1] * H };
  const L = { x: ROH_SABLONY.levy[0] * W, y: ROH_SABLONY.levy[1] * H };
  const R = { x: ROH_SABLONY.pravy[0] * W, y: ROH_SABLONY.pravy[1] * H };
  const det = (L.y - R.y) * (A.x - R.x) + (R.x - L.x) * (A.y - R.y);
  const teziste = { x: (P.x + Lp.x + Rp.x) / 3, y: (P.y + Lp.y + Rp.y) / 3 };
  const out = novyObraz(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const px0 = x + 0.5; const py0 = y + 0.5;
      const la = ((L.y - R.y) * (px0 - R.x) + (R.x - L.x) * (py0 - R.y)) / det;
      const ll = ((R.y - A.y) * (px0 - R.x) + (A.x - R.x) * (py0 - R.y)) / det;
      const lr = 1 - la - ll;
      let sx = la * P.x + ll * Lp.x + lr * Rp.x;
      let sy = la * P.y + ll * Lp.y + lr * Rp.y;
      /* Mimo výrobek (rohy obdélníku mimo trojúhelník) → posun ke středu, ať tam není pozadí */
      for (let krok = 0; krok < 8; krok++) {
        const ix = Math.max(0, Math.min(S - 1, Math.round(sx)));
        const iy = Math.max(0, Math.min(obraz.vyska - 1, Math.round(sy)));
        if (maska[iy * S + ix]) break;
        sx += (teziste.x - sx) * 0.25;
        sy += (teziste.y - sy) * 0.25;
      }
      const ix = Math.max(0, Math.min(S - 1, Math.round(sx)));
      const iy = Math.max(0, Math.min(obraz.vyska - 1, Math.round(sy)));
      const z = (iy * S + ix) * 4;
      const k = (y * W + x) * 4;
      out.body[k] = obraz.body[z]; out.body[k + 1] = obraz.body[z + 1];
      out.body[k + 2] = obraz.body[z + 2]; out.body[k + 3] = 255;
    }
  }
  return out;
}

/** Dlaždice 2 × 2 ze zrcadlených kopií — navazuje na všech stranách, bez švů. */
export function zrcadli(o: Obraz): Obraz {
  const out = novyObraz(o.sirka * 2, o.vyska * 2);
  for (let y = 0; y < out.vyska; y++) {
    const zy = y < o.vyska ? y : 2 * o.vyska - 1 - y;
    for (let x = 0; x < out.sirka; x++) {
      const zx = x < o.sirka ? x : 2 * o.sirka - 1 - x;
      const z = (zy * o.sirka + zx) * 4;
      const k = (y * out.sirka + x) * 4;
      out.body[k] = o.body[z]; out.body[k + 1] = o.body[z + 1];
      out.body[k + 2] = o.body[z + 2]; out.body[k + 3] = 255;
    }
  }
  return out;
}

/** Verze způsobu, jakým se vzorek z fotky bere. Změna = při projití katalogu znovu. */
const VERZE_VZORKU = '5';

/** Látky nahrané ručně — `kod` pro hlavní kus, `kod~1` pro část sady. Projití katalogu je nepřepíše. */
export function nahraneLatky(): Set<string> {
  try {
    const seznam = JSON.parse(getSetting('zkNahraneLatky', '[]') || '[]');
    return new Set(Array.isArray(seznam) ? seznam.map(String) : []);
  } catch { return new Set(); }
}

/**
 * Látka z nahrané fotky — pro hlavní kus (`cast` = -1) nebo část sady.
 *
 * Patrik (23. 11.): u sad je na fotce víc věcí a z jedné fotky se látka
 * každého kusu spolehlivě vystřihnout nedá. Fotka jednotlivého kusu
 * (nebo detail látky) to vyřeší — a jde použít i tam, kde se vzorek
 * z fotky e-shopu nepovedl.
 */
export function latkaZFotky(kod: string, cast: number, data: Buffer): { hex: string; vzorek: string } {
  const row = store.produktyRows().find(one => one.kod === kod);
  if (!row || !row.typ) throw new Error('Produkt v kabině není zařazený.');
  const obraz = dekoduj(data);
  const mensi = zmensi(obraz, Math.max(1, Math.round(obraz.sirka / 300)));
  const hex = barvaProduktu(mensi).hex;
  const kus = cast >= 0 ? row.casti?.[cast] : null;
  if (cast >= 0 && !kus) throw new Error('Tahle část sady neexistuje.');
  const typ = (kus ? kus.typ : row.typ) as ZkVrstvaTyp;
  const varianta = kus ? kus.varianta : row.varianta;
  const latka = vzorekZFotky(obraz, typ, varianta);
  const vzorek = latka ? `data:image/png;base64,${uloz(latka.obraz).toString('base64')}` : '';
  if (!vzorek && !hex) throw new Error('Z fotky se látka nedala přečíst — zkus fotku s výrobkem na světlém pozadí.');
  if (kus) {
    const casti = [...(row.casti ?? [])];
    casti[cast] = { ...kus, hex: hex || kus.hex, vzorek: vzorek || kus.vzorek, vzorekCm: latka?.cm ?? kus.vzorekCm };
    store.zapisProdukt({ ...row, casti });
  } else {
    store.zapisProdukt({ ...row, hex: hex || row.hex, vzorek: vzorek || row.vzorek, vzorekCm: latka?.cm ?? row.vzorekCm });
  }
  const nahrane = nahraneLatky();
  nahrane.add(cast >= 0 ? `${kod}~${cast}` : kod);
  setSetting('zkNahraneLatky', JSON.stringify([...nahrane]));
  return { hex, vzorek };
}

/* ---------------------------------------------------------- dotřídění */

const SYSTEM = `Třídíš doplňky k obleku do kategorií pro zkušební kabinu e-shopu.

Dostaneš seznam produktů (kód, název, kategorie). U každého řekni, na které
místo na modelu patří. Možnosti:
${ZK_VRSTVY.filter(one => one.zbozi)
    .map(one => `- ${one.typ} (${one.nazev}) — varianty: ${one.varianty.map(v => v.id).join(', ')}`)
    .join('\n')}

Obleky, saka, košile ani kalhoty v seznamu nejsou schválně: ty se neprodávají
a v kabině jsou jen kulisa, kterou si zákazník nastaví barvou. Když produkt na
model nepatří (dárkový poukaz, čisticí sada, obal), vrať prázdný typ. Nehádej: radši prázdný typ než špatné zařazení — špatně
zařazený produkt zákazníkovi v kabině obleče kravatu místo pásku.

Vrať JEN JSON bez komentářů:
{"produkty":[{"kod":"...","typ":"sako","varianta":"jednoradove"}]}`;

/**
 * Nechá model dotřídit, co se podle slov zařadit nedalo.
 *
 * Posílá se po dávkách a jen kód, název a kategorie — fotky ani ceny
 * model k rozhodnutí nepotřebuje a byl by to zbytečně drahý dotaz.
 */
export async function dotridAi(produkty: { kod: string; nazev: string; kategorie: string }[]): Promise<Map<string, Zarazeni>> {
  const out = new Map<string, Zarazeni>();
  if (produkty.length === 0) return out;
  const model = getSetting('fastModel', 'claude-haiku-4-5-20251001')!;
  const davka = 60;
  for (let i = 0; i < produkty.length; i += davka) {
    const kus = produkty.slice(i, i + davka);
    const seznam = kus.map(one => `${one.kod} | ${one.nazev} | ${one.kategorie}`).join('\n');
    const odpoved = await ask(model, SYSTEM, seznam, 4000);
    try {
      const json = JSON.parse(odpoved.slice(odpoved.indexOf('{'), odpoved.lastIndexOf('}') + 1));
      for (const row of json.produkty ?? []) {
        if (!row?.kod || !row?.typ) continue;
        if (!ZK_VRSTVY.some(one => one.typ === row.typ && one.zbozi)) continue;
        out.set(String(row.kod), {
          typ: row.typ,
          varianta: String(row.varianta || vrstvaDef(row.typ).varianty[0]?.id || ''),
          jiste: false
        });
      }
    } catch { /* nečitelná dávka se prostě nezařadí a zůstane na člověku */ }
  }
  return out;
}

/* ------------------------------------------------------------ průchod */

export interface Prubeh { hotovo: number; celkem: number; co: string }

/**
 * Projde katalog a doplní, co kam patří a jakou to má barvu.
 *
 * Ručně opravené produkty zůstávají, jak jsou — i když se jejich fotka
 * mezitím změnila.
 */
export async function projdiKatalog(
  options: { sAi?: boolean; sBarvami?: boolean; hlas?: (p: Prubeh) => void } = {}
): Promise<{ zarazeno: number; obarveno: number; nezarazeno: number }> {
  const zname = new Map(store.produktyRows().map(one => [one.kod, one]));
  const strankaPrvni = listProducts({ limit: 1 });
  const celkem = strankaPrvni.total;
  const krok = 200;

  let zarazeno = 0;
  let obarveno = 0;
  const kAi: { kod: string; nazev: string; kategorie: string }[] = [];
  const kBarve: { kod: string; url: string }[] = [];
  /* Názvy kvůli barvě („Béžové kšandy" nejsou černé, i když je na fotce černá spona) */
  const nazvy = new Map<string, string>();
  /*
   * Vzorky se čtou znovu, když se změnil způsob, jakým se z fotky berou
   * (kapesníček teď bere roh s lemem). Ručně nahrané látky zůstávají.
   */
  const verzeVzorku = getSetting('zkVzorkyVerze', '') === VERZE_VZORKU;
  const nahrane = nahraneLatky();

  for (let offset = 0; offset < celkem; offset += krok) {
    const strana = listProducts({ limit: krok, offset });
    if (strana.items.length === 0) break;
    options.hlas?.({ hotovo: offset, celkem, co: 'Třídím podle názvu' });
    for (const produkt of strana.items) {
      nazvy.set(produkt.code, produkt.title?.cz ?? '');
      const stare = zname.get(produkt.code);
      /*
       * Vzorek z dřívějška je malý (56 bodů z fotky zmenšené na 300) a neví
       * se, kolik centimetrů látky ukazuje — na modelu pak kytky vyšly
       * jako talíře. Takový se přečte znovu, i u schváleného produktu.
       */
      const staryVzorek = (!stare?.vzorekCm || !verzeVzorku) && !nahrane.has(produkt.code);
      if (stare?.schvaleno) {
        /*
         * Schválený produkt si nechá typ i barvu, ale **varianta se
         * přepočítá**, pokud ji nevybral člověk: dřív byla jen „kravata"
         * a „motýlek", a dětská kravata tak na modelu vyšla jako sedmička.
         */
        if (stare.typ && !stare.variantaRucne) {
          const nalez = zarad(produkt.title?.cz ?? '', produkt.category ?? '', rozmerProduktu(produkt.code));
          const novaSada = !!nalez.typ && (!!nalez.casti?.length || !!nalez.kontrola)
            && !stare.casti?.length && !stare.kontrola;
          if (novaSada) {
            /*
             * Schválená sada z doby, kdy aplikace sady neznala: na modelu
             * byl jen první kus (nebo dokonce ten špatný). Zařadí se
             * znovu a čeká na kontrolu — schválení se zruší.
             */
            store.zapisProdukt({
              ...stare, typ: nalez.typ as ZkVrstvaTyp, varianta: nalez.varianta,
              casti: (nalez.casti ?? []).map(c => ({ ...c, hex: stare.hex, vzorek: '' })),
              kontrola: nalez.kontrola || '', schvaleno: false
            });
            zarazeno += 1;
          } else if (nalez.typ === stare.typ && nalez.varianta && nalez.varianta !== stare.varianta) {
            store.zapisProdukt({ ...stare, varianta: nalez.varianta });
            zarazeno += 1;
          }
        }
        if (staryVzorek && produkt.image) kBarve.push({ kod: produkt.code, url: produkt.image });
        continue;
      }
      const nalez = zarad(produkt.title?.cz ?? '', produkt.category ?? '', rozmerProduktu(produkt.code));
      if (!nalez.typ) {
        kAi.push({ kod: produkt.code, nazev: produkt.title?.cz ?? '', kategorie: produkt.category ?? '' });
        continue;
      }
      /* Části sady si nechají látku, kterou už mají (třeba ručně nahranou) */
      const casti = (nalez.casti ?? []).map(c => {
        const mela = stare?.casti?.find(one => one.typ === c.typ);
        return mela ? { ...mela, varianta: mela.varianta || c.varianta } : { ...c, hex: stare?.hex ?? '', vzorek: '' };
      });
      store.zapisProdukt({
        kod: produkt.code,
        typ: nalez.typ,
        varianta: stare?.variantaRucne && stare.typ === nalez.typ ? stare.varianta : nalez.varianta,
        hex: stare?.rucne ? stare.hex : (stare?.hex ?? ''),
        vzorek: stare?.vzorek ?? '',
        vzorekCm: stare?.vzorekCm ?? 0,
        rucne: !!stare?.rucne,
        variantaRucne: !!stare?.variantaRucne && stare.typ === nalez.typ,
        casti,
        kontrola: nalez.kontrola ?? '',
        meritko: stare?.meritko ?? 1,
        velikosti: (produkt.variants?.length ?? 0) > 0,
        schvaleno: false
      });
      zarazeno += 1;
      if ((!stare?.hex || staryVzorek) && produkt.image) {
        kBarve.push({ kod: produkt.code, url: produkt.image });
      }
    }
  }

  if (options.sAi !== false && kAi.length) {
    options.hlas?.({ hotovo: celkem, celkem, co: `Dotřiďuji ${kAi.length} produktů` });
    const dotridene = await dotridAi(kAi);
    for (const [kod, nalez] of dotridene) {
      if (!nalez.typ) continue;
      store.zapisProdukt({
        kod, typ: nalez.typ, varianta: nalez.varianta, hex: '', vzorek: '',
        rucne: false, velikosti: false, schvaleno: false
      });
      zarazeno += 1;
    }
  }

  if (options.sBarvami !== false) {
    for (let i = 0; i < kBarve.length; i++) {
      options.hlas?.({ hotovo: i, celkem: kBarve.length, co: 'Čtu barvy a vzory z fotek' });
      const row0 = store.produktyRows().find(one => one.kod === kBarve[i].kod);
      if (!row0) continue;
      const fotky = fotkyProduktu(kBarve[i].kod);
      const nazev = nazvy.get(kBarve[i].kod) ?? '';
      const nalez = await zFotky(fotky.length ? fotky : [kBarve[i].url], row0.typ as ZkVrstvaTyp, row0.varianta, nazev,
        (row0.casti ?? []).map(c => ({ typ: c.typ, varianta: c.varianta })));
      if (!nalez.hex && !nalez.vzorek) continue;
      const row = store.produktyRows().find(one => one.kod === kBarve[i].kod);
      if (!row) continue;
      /* Ručně opravená barva zůstane; vzorek látky se ale přečte i tak */
      const hex = row.rucne ? row.hex : (nalez.hex || row.hex);
      store.zapisProdukt({
        ...row,
        hex,
        vzorek: nalez.vzorek || row.vzorek,
        vzorekCm: nalez.vzorek ? nalez.vzorekCm : row.vzorekCm,
        /*
         * Kusy sady: látka z fotky, kde ji jde najít (motýlek mezi pásky),
         * jinak aspoň barva. Ručně nahranou nebo od AI nepřepisuje — a
         * kontrolu to nenahrazuje.
         */
        casti: (row.casti ?? []).map((c, ci) => {
          const n = nalez.casti[ci];
          if (nahrane.has(`${row.kod}~${ci}`) || (row.ai && c.vzorek)) return c;
          if (n?.vzorek) return { ...c, hex: n.hex || c.hex, vzorek: n.vzorek, vzorekCm: n.vzorekCm };
          return c.vzorek || c.hex ? c : { ...c, hex };
        })
      });
      obarveno += 1;
    }
    setSetting('zkVzorkyVerze', VERZE_VZORKU);
  }

  return { zarazeno, obarveno, nezarazeno: Math.max(0, kAi.length - zarazeno) };
}

/* ------------------------------------------------- produkty pro kabinu */

/**
 * Cena jako číslo.
 *
 * Z feedu chodí cena jako text („1 790 Kč", „1.790,00 Kč") — kabina z ní
 * ale počítá součet celého vzhledu. Mezery i nedělitelné mezery pryč,
 * čárka je desetinná tečka, tečka mezi trojicemi je oddělovač tisíců.
 */
export function cenaNaCislo(text: string): number {
  const cisty = String(text || '')
    .replace(/[\s\u00a0\u202f]/g, '')
    .replace(/[^0-9,.]/g, '')
    .replace(/\.(?=\d{3}\b)/g, '')
    .replace(',', '.');
  const cislo = Number.parseFloat(cisty);
  return Number.isFinite(cislo) ? cislo : 0;
}

/** Produkty, jak je potřebuje kabina — jen ty zařazené a s adresou. */
/**
 * Komu je produkt určený, pokud to z názvu nebo kategorie plyne.
 *
 * Dětský motýlek na dospělém modelu je nabídka, která nemá co udělat —
 * a dospělé kšandy na dítěti radí velikost, která nikdy nesedne. Co se
 * nepozná, platí pro všechny: hádat tady znamená schovat zboží.
 */
export function proVek(nazev: string, kategorie: string): ZkVek[] | undefined {
  const t = bezDiakritiky(`${nazev} ${kategorie}`);
  const jmeno = bezDiakritiky(nazev);
  if (/kojenec|miminko|baby|newborn/.test(t)) return ['kojenec', 'dite'];
  /* MINI motýlek je pro nejmenší — na kojence spíš než na školáka */
  if (/\bmini\b/.test(jmeno) && /detsk/.test(jmeno)) return ['kojenec', 'dite'];
  if (/detsk|deti|pro deti|kids|child|junior/.test(jmeno)) return ['dite', 'kojenec'];
  /*
   * Co není dětské, je pro dospělého. Dřív to „platilo pro všechny"
   * a pánská kravata zůstala viset na dětském modelu (Patrik, 23. 11.).
   * Kategorie se tu nebere: „Kravaty pro tátu a syna" obsahují oboje.
   */
  return ['dospely'];
}

export function proKabinu(limit = 400, vcetneKontroly = false): ZkProdukt[] {
  /* Jen zboží, které kabina zná — pásek z dřívějška tu už místo nemá */
  /*
   * Sada a jiný produkt, který potřebuje kontrolu, se ukáže až schválený.
   * Patrik (23. 11.): dárková sada se na kravatu dláždila z fotky šesti
   * věcí — „nedovolit je bez kontroly". Zákazník, který na takový produkt
   * klikne, dostane slušnou zprávu a podobné kusy (to dělá kabina).
   */
  const zarazene = store.produktyRows().filter(one => one.typ
    && ZK_VRSTVY.some(d => d.typ === one.typ && d.zbozi)
    && (vcetneKontroly || !one.kontrola || one.schvaleno));
  if (zarazene.length === 0) return [];
  const mapa = new Map(zarazene.map(one => [one.kod, one]));
  const out: ZkProdukt[] = [];
  const krok = 200;
  const celkem = listProducts({ limit: 1 }).total;
  for (let offset = 0; offset < celkem && out.length < limit; offset += krok) {
    const strana = listProducts({ limit: krok, offset });
    if (strana.items.length === 0) break;
    for (const produkt of strana.items) {
      const row = mapa.get(produkt.code);
      if (!row?.typ) continue;
      /* Co není skladem, se do kabiny nedává: zklamání na jedno kliknutí */
      if (produkt.stock != null && produkt.stock <= 0) continue;
      /*
       * Varianty se posílají i se zásobou, protože kabina na nich staví
       * dvě věci naráz: radu „na výšku 120 cm vychází tahle" a vložení
       * do košíku s tou velikostí. Vyprodaná velikost se neskrývá —
       * rada, která mlčí o tom, že zrovna tahle není, je horší než rada
       * s poznámkou „není skladem".
       */
      const velikostiSeznam = (produkt.variants ?? []).map(one => ({
        kod: one.code,
        popis: one.label,
        skladem: one.stock == null || one.stock > 0
      }));
      /*
       * Ostatní jazykové verze se posílají jen tam, kde se opravdu liší:
       * seznam se stahuje zákazníkovi do mobilu a trojnásobek názvů
       * a adres u čtyř set produktů je čtvrt megabajtu navíc.
       */
      const trhy: ZkProdukt['trhy'] = {};
      for (const trh of ['sk', 'en'] as const) {
        const url = produkt.url?.[trh] ?? '';
        if (!url || url === (produkt.url?.cz ?? '')) continue;
        trhy[trh] = {
          nazev: produkt.title?.[trh] ?? '',
          url,
          cena: produkt.price?.[trh] ?? '',
          cenaCislo: cenaNaCislo(produkt.price?.[trh] ?? '')
        };
      }
      out.push({
        kod: produkt.code,
        nazev: produkt.title?.cz ?? '',
        url: produkt.url?.cz ?? '',
        cena: produkt.price?.cz ?? '',
        cenaCislo: cenaNaCislo(produkt.price?.cz ?? ''),
        obrazek: produkt.image ?? '',
        typ: row.typ as ZkVrstvaTyp,
        varianta: sjednotVariantu(row.typ as ZkVrstvaTyp, row.varianta),
        hex: row.hex,
        vzorek: row.vzorek,
        /* Starý vzorek (56 bodů z fotky na 300) ukazuje zhruba 2,8 cm látky; ruční doladění násobí */
        vzorekCm: row.vzorek && (row.vzorekCm ?? 0) >= 0 ? (row.vzorekCm || 2.8) * (row.meritko || 1) : undefined,
        vzorekRoh: (row.vzorekCm ?? 0) < 0 || undefined,
        casti: row.casti?.length
          ? row.casti.map(c => ({
            ...c,
            vzorekCm: c.vzorek && (c.vzorekCm ?? 0) >= 0 ? (c.vzorekCm || 2.8) * (row.meritko || 1) : undefined,
            vzorekRoh: (c.vzorekCm ?? 0) < 0 || undefined
          }))
          : undefined,
        velikosti: row.velikosti || velikostiSeznam.length > 1,
        skladem: produkt.stock == null || produkt.stock > 0,
        velikostiSeznam: velikostiSeznam.length > 1 ? velikostiSeznam : undefined,
        proVek: proVek(produkt.title?.cz ?? '', produkt.category ?? ''),
        trhy: Object.keys(trhy).length > 0 ? trhy : undefined
      });
      if (out.length >= limit) break;
    }
  }
  return out;
}

export const __test = { zarad, bezDiakritiky, cenaNaCislo, rozmerZTextu, variantaZbozi, vzorekZFotky, zrcadli, rohVyrobku };
