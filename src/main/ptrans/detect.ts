/**
 * Poznat, co je a co není přeložené.
 *
 * Upgates nemá „prázdný překlad": když produkt v cizí mutaci přeložený není,
 * ve feedu je pro daný jazyk **český text**. Podle `null` se tedy poznat nedá
 * a i porovnání se zdrojem stačí jen na část případů — někdo text ručně
 * upravil, změnil pár slov, a pořád je česky.
 *
 * Rozhoduje se proto ve třech krocích:
 *   1. prázdné pole → chybí,
 *   2. po očištění shodné se zdrojem → nepřeloženo,
 *   3. rozpoznání jazyka → když text vyjde jako zdrojový jazyk, taky nepřeloženo.
 *
 * Krok 2 má ale výjimku, bez které je celé počítání k ničemu: **některé
 * hodnoty jsou ve všech jazycích stejné právem**. Google atributy se nepřekládají
 * (`male`, `adult`, `new`), čárový kód je číslo, „45 cm" je „45 cm" i anglicky.
 * Když se u nich shoda se zdrojem brala jako „nepřeloženo", stačil jeden takový
 * údaj a produkt visel v „čeká na překlad" napořád — i s hotovou angličtinou
 * i slovenštinou. A překlad by to nespravil, protože `male` zůstane `male`.
 *
 * Rozpoznávání stojí na znacích a slovech, které jazyky **skutečně odlišují**.
 * První verze používala i slova jako „je" nebo „na", která jsou stejná v češtině
 * i slovenštině, a označkovala kvůli nim stovky správných slovenských textů jako
 * české. Radši méně signálů a jistota než horlivost.
 */

import { DERIVED_FIELDS } from './xml';

export type FieldState =
  /** Ve feedu není nic */
  | 'missing'
  /** Doslova totéž co zdroj — Upgates takhle vypisuje nepřeložené texty */
  | 'same'
  /** Rozpoznán zdrojový jazyk, i když text není doslova stejný */
  | 'source'
  /** Přeloženo (námi nebo dřív ručně) */
  | 'ok'
  /** Přeloženo námi, ale zdroj se od té doby změnil */
  | 'stale'
  /** Ručně upraveno v aplikaci — překladač na to nesahá */
  | 'manual';

/** Stavy, které znamenají „tohle je potřeba přeložit". */
export const NEEDS_WORK: FieldState[] = ['missing', 'same', 'source', 'stale'];

interface Markers {
  /** Písmena, která v ostatních zvažovaných jazycích nejsou */
  chars: string;
  /** Slova, která se v ostatních jazycích píšou jinak */
  words: string[];
}

/**
 * Značky jazyků. Kdo přidá další jazyk, přidá i řádek sem — bez něj se pozná
 * jen prázdné pole a doslovná shoda se zdrojem, což u nového jazyka stačí
 * (ve feedu bude čeština, tedy doslovná shoda).
 */
const MARKERS: Record<string, Markers> = {
  cz: {
    chars: 'řěů',
    words: ['pro', 'jsou', 'více', 'nebo', 'také', 'díky', 'všechny', 'český', 'česká', 'české',
      'kvalitní', 'vyrobeno', 'vhodný', 'jeho', 'této', 'velikost']
  },
  sk: {
    chars: 'ľĺŕôä',
    words: ['pre', 'sú', 'viac', 'alebo', 'tiež', 'vďaka', 'všetky', 'slovenský', 'kvalitný',
      'vyrobené', 'vhodný', 'jeho', 'tejto', 'veľkosť']
  },
  en: {
    chars: '',
    words: ['the', 'and', 'with', 'for', 'from', 'your', 'our', 'are', 'this', 'made', 'quality',
      'is', 'of', 'to', 'in', 'perfect']
  },
  de: {
    chars: 'ß',
    words: ['und', 'der', 'die', 'das', 'für', 'mit', 'ist', 'sind', 'auch', 'sehr', 'qualität',
      'hergestellt', 'ihre']
  },
  pl: {
    chars: 'ąęłńśźż',
    words: ['dla', 'oraz', 'jest', 'są', 'który', 'także', 'jakości', 'wykonane', 'twoje']
  },
  hu: {
    chars: 'őű',
    words: ['és', 'egy', 'nem', 'vagy', 'minőség', 'készült', 'ez']
  }
};

/**
 * Hodnoty z pevného slovníku Google Merchantu. Do feedu patří anglicky ve všech
 * jazykových mutacích — Google jiné nezná a přeložené by zahodil.
 */
const NEUTRAL_VALUES = new Set([
  'male', 'female', 'unisex',
  'adult', 'kids', 'toddler', 'infant', 'newborn',
  'new', 'refurbished', 'used',
  'yes', 'no', 'true', 'false',
  'in stock', 'out of stock', 'preorder', 'backorder'
]);

/** Konfekční velikosti — „XL" se nepřekládá. */
const SIZE_LABELS = /^(x{0,3}s|x{0,3}l|m|uni|one ?size|\d?xl)$/i;

/**
 * Míra, podíl nebo kód: „38-40", „100 %", „45 cm", čárový kód.
 *
 * Jednotky jsou schválně vyjmenované, ne „číslo a pár písmen". Volnější
 * pravidlo by spolklo i „3 kusy" — a to se přeložit má. Tenhle seznam radši
 * něco nechytí, než aby tiše zamlčel skutečnou práci.
 */
const UNITS = 'cm|mm|m|km|g|kg|ml|l|ks|pcs|eu|uk|us|den|dpi';
const MEASURE = new RegExp(`^[\\d\\s.,%×x/+·–-]+ ?(${UNITS})?$`, 'i');

/**
 * Je hodnota stejná ve všech jazycích právem?
 *
 * Rozhoduje se podle pole i podle hodnoty. Pole proto, že Google atributy
 * a adresy si aplikace skládá sama a nikdo je nepřekládá — u nich shoda se
 * zdrojem nic neznamená. Hodnota proto, že i v běžném poli (typicky
 * v parametru produktu) se objeví „100 %" nebo „XL", a to je česky i anglicky
 * totéž.
 */
export function isNeutral(field: string | undefined, value: string): boolean {
  if (field && DERIVED_FIELDS.has(field)) return true;
  const text = value.trim().toLowerCase();
  if (!text) return false;
  if (NEUTRAL_VALUES.has(text)) return true;
  if (SIZE_LABELS.test(text)) return true;
  if (MEASURE.test(text)) return true;
  return false;
}

/** Text bez HTML, entit a přebytečných mezer — na porovnávání i na rozpoznání. */
export function plain(value: string): string {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function words(value: string): string[] {
  return value.toLowerCase().match(/[\p{L}]+/gu) ?? [];
}

/**
 * Který z nabízených jazyků text nejspíš je. `null` = nelze rozhodnout;
 * u krátkých textů (názvy, parametry) je to běžné a je to v pořádku.
 */
export function detectLanguage(value: string, candidates: string[]): string | null {
  const text = plain(value).toLowerCase();
  if (text.length < 12) return null;
  const list = words(text);

  const score: Record<string, number> = {};
  for (const lang of candidates) {
    const marks = MARKERS[lang];
    if (!marks) continue;
    let points = 0;
    for (const ch of text) if (marks.chars.includes(ch)) points += 4;
    for (const word of list) if (marks.words.includes(word)) points += 2;
    score[lang] = points;
  }

  const ranked = Object.entries(score).sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0) return null;
  const [best, points] = ranked[0];
  const total = ranked.reduce((sum, [, value]) => sum + value, 0);
  // Slabý nebo rozpolcený výsledek se nepočítá — radši „nevím" než špatný odznak
  if (points < 4 || points / total < 0.55) return null;
  return best;
}

export interface StateInput {
  /** Hodnota ve feedu pro cílový jazyk */
  value: string;
  /** Odpovídající text ve zdrojovém jazyce */
  source: string;
  sourceLang: string;
  targetLang: string;
  /** Otisk zdroje v době, kdy jsme pole překládali (z databáze) */
  translatedHash?: string | null;
  /** Dnešní otisk zdroje */
  sourceHash?: string;
  /** Pole bylo ručně upraveno v aplikaci */
  manual?: boolean;
  /**
   * Které pole to je. Bez něj se u Google atributů a adres nepozná, že shoda
   * se zdrojem je v pořádku — a produkt by kvůli nim zůstal „čeká na překlad".
   */
  field?: string;
}

/** Stav jednoho pole v jednom jazyce. */
export function fieldState(input: StateInput): FieldState {
  const value = plain(input.value);
  const source = plain(input.source);

  if (input.manual) return 'manual';
  if (!value) return 'missing';

  // Hodnota, která je ve všech jazycích stejná právem: shoda se zdrojem ani
  // rozpoznaný jazyk o ničem nevypovídají. Zbývá jediná skutečná práce —
  // změnil se zdroj? — a tu řeší otisk níž.
  const neutral = isNeutral(input.field, value);

  if (!neutral && source && value.toLowerCase() === source.toLowerCase()) return 'same';

  if (input.translatedHash) {
    // Přeloženo námi — jediné, co se ještě může pokazit, je změna zdroje
    return input.sourceHash && input.sourceHash !== input.translatedHash ? 'stale' : 'ok';
  }

  if (neutral) return 'ok';

  const guess = detectLanguage(input.value, [input.sourceLang, input.targetLang]);
  if (guess === input.sourceLang && guess !== input.targetLang) return 'source';
  return 'ok';
}

/** Otisk zdrojového textu — poznáme podle něj, že se originál od překladu změnil. */
export function hashText(value: string): string {
  const text = plain(value);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + code, 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16)}${h2.toString(16)}`;
}
