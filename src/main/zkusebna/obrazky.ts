import { getSetting, setSetting } from '../db';
import { decrypt } from '../secure';
import { Obraz, nacti, uloz } from './png';

/**
 * Kreslení obrázků — OpenAI.
 *
 * ## Proč zvlášť a ne přes `ai.ts`
 *
 * Zbytek aplikace mluví s Anthropicem a ten obrázky nekreslí. Tohle je
 * druhý dodavatel na jedinou úlohu: vykreslit postavu a dooblékat ji.
 * Klíč má proto vlastní a evidenci spotřeby taky vlastní — aby bylo
 * poznat, kolik stojí vizuály a kolik texty.
 *
 * ## Proč se nepoužívá knihovna
 *
 * Potřebují se dvě adresy a jedna z nich posílá soubory. `fetch`
 * a `FormData` jsou v Node vestavěné, takže knihovna by přibyla do
 * závislostí kvůli dvaceti řádkům — a každá další závislost je něco, co
 * se musí hlídat při každém vydání aplikace.
 *
 * ## Proč se model dá vybrat
 *
 * Rodiny obrázkových modelů se mění rychleji než zbytek aplikace a liší
 * se v jedné podstatné věci: jak věrně drží vstupní obrázek. A právě na
 * tom celé oblékání stojí — když model postavu mezi kroky překreslí,
 * vrstva nesedne. Model je proto v nastavení a ne v kódu.
 */

/** Adresa rozhraní. V nastavení kvůli zkouškám, ne kvůli jinému dodavateli. */
const ZAKLAD = () => getSetting('openaiBase', 'https://api.openai.com/v1')!;

export interface ObrazkovyModel {
  id: string;
  nazev: string;
  popis: string;
  /** Umí držet vstupní obrázek na bod, nebo se musí doprošovat zadáním. */
  verny: 'vzdy' | 'navolbu' | 'ne';
  /** Orientační cena jednoho obrázku v dolarech, při vysoké kvalitě na výšku. */
  cena: number;
}

/**
 * Modely, které umí kreslit a upravovat obrázky.
 *
 * Seznam je tady proto, aby šlo v okně vybírat ze jmen a aby u každého
 * stálo, co od něj čekat. Kdyby přibyl další, přidá se řádek — zadat se
 * dá i jméno, které tu není.
 *
 * Starší řady zůstávají dole: kdo si je jednou vybral, nemá se dozvědět
 * „neznámý model" jen proto, že se seznam posunul. Když u OpenAI
 * doslouží, pozná se to z hlášky a rada k ní ukáže sem.
 */
export const MODELY: ObrazkovyModel[] = [
  {
    id: 'gpt-image-2.5-sunburst', nazev: 'gpt-image-2.5 Sunburst',
    popis: 'Nejpřesnější v úpravách hotového obrázku — a na tom oblékání po vrstvách stojí.',
    verny: 'vzdy', cena: 0.05
  },
  {
    id: 'gpt-image-2.5-flare', nazev: 'gpt-image-2.5 Flare',
    popis: 'Rychlejší, na běžné kreslení od nuly. Vstupní obrázek drží volněji než Sunburst.',
    verny: 'vzdy', cena: 0.05
  },
  {
    id: 'gpt-image-2', nazev: 'gpt-image-2 (starší)',
    popis: 'Předchozí řada. Vstupní obrázek drží vždy, průhledné pozadí umí.',
    verny: 'vzdy', cena: 0.22
  },
  {
    id: 'gpt-image-1', nazev: 'gpt-image-1 (starší)',
    popis: 'Ještě starší. Levnější, zadání drží o něco volněji.',
    verny: 'navolbu', cena: 0.17
  }
];

/**
 * Modely, které jsme kdysi nabízeli a u OpenAI dosloužily.
 *
 * Kdo si je vybral, nemá kvůli tomu zůstat s nefunkčním nastavením —
 * jednou se mu tiše přepne na ten současný. Vlastnoručně zadaného jména
 * se to netýká: to si člověk napsal schválně a přepisovat mu ho by bylo
 * drzé.
 */
const DOSLOUZILY = ['gpt-image-1.5', 'gpt-image-1-mini'];

export function model(): ObrazkovyModel {
  let id = getSetting('obrazkovyModel', MODELY[0].id)!;
  if (DOSLOUZILY.includes(id)) {
    id = MODELY[0].id;
    setSetting('obrazkovyModel', id);
  }
  return MODELY.find(one => one.id === id) ?? { ...MODELY[0], id, nazev: id };
}

export function klic(): string {
  const stored = getSetting('openaiApiKey', '')!;
  if (!stored) return '';
  return decrypt(stored) || '';
}

export function maKlic(): boolean {
  return !!klic();
}

/* ---------------------------------------------------------------- účetnictví */

/**
 * Evidence spotřeby. Vlastní, protože OpenAI zůstatek kreditu přes
 * rozhraní neříká — a kdo generuje vrstvy pro dvanáct postav, má vědět,
 * kolik to zatím stálo, ještě než mu to přijde na účet.
 */
export function zapisUtratu(pocet = 1): void {
  const mesic = new Date().toISOString().slice(0, 7);
  const klicZapisu = `obrazkyUtrata:${mesic}`;
  const ted = cislo(klicZapisu, 0);
  setSetting(klicZapisu, String(ted + pocet * model().cena));
  const kusy = `obrazkyKusy:${mesic}`;
  setSetting(kusy, String(cislo(kusy, 0) + pocet));
}

/**
 * Číslo z nastavení. Nula je hodnota, ne „nevyplněno".
 *
 * Strop nastavený na nulu znamená „teď nekresli nic" — a přesně to
 * dřív nefungovalo: `Number(…) || 40` udělalo z nuly čtyřicet dolarů,
 * takže jediná pojistka proti nechtěnému generování tiše nefungovala.
 */
function cislo(klic: string, vychozi: number): number {
  const ulozene = Number(getSetting(klic, String(vychozi)));
  return Number.isFinite(ulozene) ? ulozene : vychozi;
}

export function utrata(): { mesic: string; usd: number; kusu: number; strop: number } {
  const mesic = new Date().toISOString().slice(0, 7);
  return {
    mesic,
    usd: cislo(`obrazkyUtrata:${mesic}`, 0),
    kusu: cislo(`obrazkyKusy:${mesic}`, 0),
    strop: cislo('obrazkyStrop', 40)
  };
}

/**
 * Strop na měsíc.
 *
 * Generování vrstev je smyčka přes postavy a kusy oblečení; jeden
 * překlep v počtu a je to sto obrázků místo deseti. Strop je proto
 * **tvrdý**: překročit se nedá zrychlením ani opakováním, jen tím, že
 * si ho člověk v okně zvedne.
 */
export function zbyvaDoStropu(): number {
  const u = utrata();
  return Math.max(0, u.strop - u.usd);
}

/* ------------------------------------------------------------------ volání */

function hlavicky(): Record<string, string> {
  const k = klic();
  if (!k) throw new Error('Není nastaven klíč k OpenAI (Nastavení → Vizuály na modelu).');
  return { authorization: `Bearer ${k}` };
}

/** Co se dá zkusit znovu a co se opakováním nespraví nikdy. */
function znovu(stav: number, text: string): boolean {
  if (stav === 429 || stav === 408 || stav === 409) return true;
  if (stav >= 500) return true;
  return /overloaded|timeout|fetch failed|ECONNRESET|socket hang up/i.test(text);
}

/**
 * Pošle požadavek a vrátí obrázek.
 *
 * ## Proč dva tvary těla
 *
 * Kreslení od nuly (`/images/generations`) bere **jen JSON**; posílat mu
 * formulář končí na „Unsupported content type: 'multipart/form-data'" a
 * žádný obrázek nevznikne. Dokreslování (`/images/edits`) je naopak
 * formulář, protože s sebou nese soubory — vstupní obrázek a masku.
 * Dřív se oběma posílal formulář a generování postavy proto nikdy
 * neproběhlo; vidět to nebylo, protože se do té doby pracovalo jen se
 * zástupnou kresbou.
 */
async function posli(cesta: string, telo: FormData | Record<string, unknown>, pokusu = 3): Promise<Obraz> {
  let naposled = '';
  for (let pokus = 0; pokus < pokusu; pokus++) {
    if (zbyvaDoStropu() <= 0) {
      throw new Error(`Měsíční strop ${utrata().strop} $ za obrázky je vyčerpaný. Zvedni ho v okně, nebo počkej do dalšího měsíce.`);
    }
    let odpoved: Response;
    try {
      const formular = telo instanceof FormData;
      odpoved = await fetch(`${ZAKLAD()}${cesta}`, {
        method: 'POST',
        /* U formuláře si hranici doplní fetch sám — vlastní hlavička by ji přebila */
        headers: formular ? hlavicky() : { ...hlavicky(), 'content-type': 'application/json' },
        body: formular ? telo : JSON.stringify(telo)
      });
    } catch (e: any) {
      naposled = String(e?.message ?? e);
      if (!znovu(0, naposled) || pokus === pokusu - 1) break;
      await pauza(pokus);
      continue;
    }
    const text = await odpoved.text();
    if (!odpoved.ok) {
      naposled = `${odpoved.status} ${text.slice(0, 300)}`;
      if (!znovu(odpoved.status, text) || pokus === pokusu - 1) break;
      await pauza(pokus);
      continue;
    }
    const data = JSON.parse(text);
    const b64 = data?.data?.[0]?.b64_json;
    if (!b64) {
      naposled = 'Odpověď neobsahuje obrázek.';
      break;
    }
    zapisUtratu(1);
    return nacti(Buffer.from(b64, 'base64'));
  }
  throw new Error(`Obrázek se nepodařilo nakreslit: ${naposled}${radaKChybe(naposled)}`);
}

/**
 * Věta navíc tam, kde z hlášky od OpenAI není poznat, co s tím.
 *
 * Rodiny obrázkových modelů se mění rychleji než aplikace a „model not
 * found" je hláška, nad kterou člověk neví, jestli je rozbitá aplikace,
 * klíč, nebo účet. Přitom stačí vybrat jiný model.
 */
function radaKChybe(text: string): string {
  if (/model/i.test(text) && /not found|does not exist|unknown|neexistuje/i.test(text)) {
    return ` — vypadá to, že model „${model().id}" už není k dispozici. Vyber jiný v Nastavení → Vizuály na modelu.`;
  }
  if (/insufficient_quota|billing|credit/i.test(text)) {
    return ' — účet u OpenAI nemá kredit.';
  }
  return '';
}

function pauza(pokus: number): Promise<void> {
  /* Rozptyl schválně: bez něj se souběžná volání probudí naráz */
  const zaklad = Math.min(1500 * 2 ** pokus, 20_000);
  return new Promise(r => setTimeout(r, zaklad + Math.random() * zaklad * 0.3));
}

export interface Rozmer { sirka: number; vyska: number }

/** Nakreslí obrázek od nuly — tak vzniká postava. */
export async function nakresli(zadani: string, rozmer: Rozmer, prusvitne = true): Promise<Obraz> {
  const telo: Record<string, unknown> = {
    model: model().id,
    prompt: zadani,
    size: `${rozmer.sirka}x${rozmer.vyska}`,
    quality: getSetting('obrazkyKvalita', 'high')!,
    output_format: 'png',
    n: 1
  };
  /* Průhledné pozadí jde jen k png nebo webp — u jpeg by to rozhraní odmítlo */
  if (prusvitne) telo.background = 'transparent';
  return posli('/images/generations', telo);
}

/**
 * Dokreslí do hotového obrázku — tak se postava dooblékává.
 *
 * `input_fidelity: high` je tady to podstatné: bez něj si model obrázek
 * překreslí po svém a rozdíl mezi kroky pak není kus látky, ale jiný
 * člověk. Modely, které vstup drží vždycky, tu volbu neberou a poslat
 * jim ji je chyba — proto se posílá jen tam, kam patří.
 */
export async function dokresli(zadani: string, vstup: Obraz, maska?: Obraz): Promise<Obraz> {
  const telo = new FormData();
  const m = model();
  telo.append('model', m.id);
  telo.append('prompt', zadani);
  telo.append('image', new Blob([new Uint8Array(uloz(vstup))], { type: 'image/png' }), 'postava.png');
  if (maska) {
    telo.append('mask', new Blob([new Uint8Array(uloz(maska))], { type: 'image/png' }), 'maska.png');
  }
  telo.append('size', `${vstup.sirka}x${vstup.vyska}`);
  telo.append('quality', getSetting('obrazkyKvalita', 'high')!);
  telo.append('output_format', 'png');
  telo.append('background', 'transparent');
  if (m.verny === 'navolbu') telo.append('input_fidelity', 'high');
  telo.append('n', '1');
  return posli('/images/edits', telo);
}

/** Kolik by stálo vygenerovat daný počet obrázků. */
export function odhadCeny(kusu: number): number {
  return Math.round(kusu * model().cena * 100) / 100;
}

export const __test = { znovu, posli };
