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
 * Rozpoznávání stojí na znacích a slovech, které jazyky **skutečně odlišují**.
 * První verze používala i slova jako „je" nebo „na", která jsou stejná v češtině
 * i slovenštině, a označkovala kvůli nim stovky správných slovenských textů jako
 * české. Radši méně signálů a jistota než horlivost.
 */

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
}

/** Stav jednoho pole v jednom jazyce. */
export function fieldState(input: StateInput): FieldState {
  const value = plain(input.value);
  const source = plain(input.source);

  if (input.manual) return 'manual';
  if (!value) return 'missing';
  if (source && value.toLowerCase() === source.toLowerCase()) return 'same';

  if (input.translatedHash) {
    // Přeloženo námi — jediné, co se ještě může pokazit, je změna zdroje
    return input.sourceHash && input.sourceHash !== input.translatedHash ? 'stale' : 'ok';
  }

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
