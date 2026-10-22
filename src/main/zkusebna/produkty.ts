import { nativeImage } from 'electron';
import { ask } from '../ai';
import { getSetting } from '../db';
import { listProducts } from '../products';
import { ZkProdukt, ZkVek, ZkVrstvaTyp, ZK_VRSTVY, vrstvaDef } from '../../shared/zkusebna';
import { Obraz, nacti, uloz } from './png';
import { barvaProduktu, vzorekLatky, zmensi } from './pixely';
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
}

/**
 * Zařazení podle slov. Vrací i variantu, když ji název prozradí
 * (motýlek, dvouřadové sako, košile se stojáčkem).
 */
export function zarad(nazev: string, kategorie: string): Zarazeni {
  const text = `${bezDiakritiky(nazev)} ${bezDiakritiky(kategorie)}`;
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
      if (hledane && text.includes(hledane)) nalezy.push({ typ: def.typ, delka: hledane.length });
    }
  }
  if (nalezy.length === 0) return { typ: '', varianta: '', jiste: false };
  /*
   * Delší slovo vyhrává. „Oblek" je v názvu „Pásek k obleku" taky, ale
   * „pasek" je přesnější shoda než „oblek" — a bez tohohle pravidla by
   * se každý doplněk s obleky v názvu stal sakem.
   */
  nalezy.sort((a, b) => b.delka - a.delka);
  const typ = nalezy[0].typ;
  const jiste = nalezy.length === 1 || nalezy[0].delka > nalezy[1].delka;

  let varianta = vrstvaDef(typ).varianty[0]?.id ?? '';
  if (typ === 'kravata') {
    if (/motyl/.test(text)) varianta = 'motylek';
    else if (/regat|ascot/.test(text)) varianta = 'regata';
  } else if (typ === 'sako') {
    if (/dvourad|double/.test(text)) varianta = 'dvouradove';
  } else if (typ === 'kosile') {
    if (/stojack|mandarin|band/.test(text)) varianta = 'stojacek';
  } else if (typ === 'ksandy') {
    if (/sirok|wide/.test(text)) varianta = 'siroke';
  }
  return { typ, varianta, jiste };
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
export async function zFotky(url: string): Promise<{ hex: string; vzorek: string }> {
  if (!url) return { hex: '', vzorek: '' };
  try {
    const odpoved = await fetch(url);
    if (!odpoved.ok) return { hex: '', vzorek: '' };
    const data = Buffer.from(await odpoved.arrayBuffer());
    const obraz = dekoduj(data);
    /* Zmenšení je kvůli času: na odhad barvy stačí tři sta bodů na šířku */
    const mensi = zmensi(obraz, Math.max(1, Math.round(obraz.sirka / 300)));
    const hex = barvaProduktu(mensi).hex;
    const kousek = vzorekLatky(mensi, 56);
    return {
      hex,
      vzorek: kousek ? `data:image/png;base64,${uloz(kousek).toString('base64')}` : ''
    };
  } catch {
    return { hex: '', vzorek: '' };
  }
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

  for (let offset = 0; offset < celkem; offset += krok) {
    const strana = listProducts({ limit: krok, offset });
    if (strana.items.length === 0) break;
    options.hlas?.({ hotovo: offset, celkem, co: 'Třídím podle názvu' });
    for (const produkt of strana.items) {
      const stare = zname.get(produkt.code);
      if (stare?.schvaleno) continue;
      const nalez = zarad(produkt.title?.cz ?? '', produkt.category ?? '');
      if (!nalez.typ) {
        kAi.push({ kod: produkt.code, nazev: produkt.title?.cz ?? '', kategorie: produkt.category ?? '' });
        continue;
      }
      store.zapisProdukt({
        kod: produkt.code,
        typ: nalez.typ,
        varianta: nalez.varianta,
        hex: stare?.rucne ? stare.hex : (stare?.hex ?? ''),
        vzorek: stare?.vzorek ?? '',
        rucne: !!stare?.rucne,
        velikosti: (produkt.variants?.length ?? 0) > 0,
        schvaleno: false
      });
      zarazeno += 1;
      if (!stare?.rucne && (!stare?.hex || !stare?.vzorek) && produkt.image) {
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
      const nalez = await zFotky(kBarve[i].url);
      if (!nalez.hex && !nalez.vzorek) continue;
      const row = store.produktyRows().find(one => one.kod === kBarve[i].kod);
      if (!row || row.rucne) continue;
      store.zapisProdukt({ ...row, hex: nalez.hex || row.hex, vzorek: nalez.vzorek || row.vzorek });
      obarveno += 1;
    }
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
function proVek(nazev: string, kategorie: string): ZkVek[] | undefined {
  const t = bezDiakritiky(`${nazev} ${kategorie}`);
  if (/kojenec|miminko|baby|newborn/.test(t)) return ['kojenec', 'dite'];
  if (/detsk|deti|pro deti|kids|child|junior/.test(t)) return ['dite', 'kojenec'];
  return undefined;
}

export function proKabinu(limit = 400): ZkProdukt[] {
  const zarazene = store.produktyRows().filter(one => one.typ);
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
        varianta: row.varianta,
        hex: row.hex,
        vzorek: row.vzorek,
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

export const __test = { zarad, bezDiakritiky, cenaNaCislo };
