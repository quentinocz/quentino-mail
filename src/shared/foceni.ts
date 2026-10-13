/**
 * Kdy se má založit nové focení.
 *
 * ## Proč to vůbec existuje
 *
 * Focení se otevře, nafotí se den, okno se zavře. Druhý den se otevře
 * znovu — a pokračuje se **v tom samém focení**, protože se zapamatovalo
 * poslední. Fotky z úterý tím skončí ve stejné sérii jako ty z pondělí,
 * míchají se v galerii, společné nastavení a vodítka patří ke včerejšku a
 * „nové focení" si musí člověk pamatovat sám. Na to se dřív nebo později
 * zapomene, a pozná se to až po dvou dnech, kdy je v jedné sérii osmdesát
 * fotek od tří různých zakázek.
 *
 * ## Proč se to neřeší prostě tím, že se každý den založí nové
 *
 * Protože focení přes půlnoc je běžná věc a focení ve dvou kusech taky:
 * dopoledne se nafotí, odpoledne se k tomu doberou dva kusy, co dorazily
 * později. Založit v takové chvíli nové focení znamená rozdělit jednu
 * sérii na dvě — a to je přesně ta chyba, jen opačná. Proto se **ptá**,
 * a ptá se jedině tehdy, kdy by pokračování bylo opravdu podezřelé.
 *
 * ## Proč je rozhodnutí čistá funkce
 *
 * Záleží na čase a na tom, co se stalo včera — tedy na věcech, které se
 * v okně nedají nastavit tak, aby se daly zkoušet. Takhle se dá projít
 * všech osm případů za vteřinu, včetně půlnoci.
 */

/** Kdy se okno ptá na nové focení. */
export type ShootNoveFoceni = 'zeptat' | 'vzdy' | 'samo' | 'nikdy';

export const SHOOT_NOVE: { id: ShootNoveFoceni; nazev: string; popis: string }[] = [
  {
    id: 'zeptat', nazev: 'Nový den se zeptat',
    popis: 'Když je poslední focení z jiného dne, okno se zeptá, jestli založit nové. Během dne mlčí.'
  },
  {
    id: 'vzdy', nazev: 'Zeptat se při každém otevření',
    popis: 'Dotaz přijde pokaždé, i když se okno zavřelo před chvílí.'
  },
  {
    id: 'samo', nazev: 'Nový den založit samo',
    popis: 'Bez ptaní. Hodí se, když se každý den fotí něco jiného.'
  },
  {
    id: 'nikdy', nazev: 'Neptat se vůbec',
    popis: 'Pokračuje se v posledním focení, dokud se nové nezaloží ručně.'
  }
];

/** Focení, ve kterém by se pokračovalo. */
export interface ShootPosledni {
  nazev: string;
  /** Kdy vzniklo. */
  kdy: string;
  fotek: number;
}

export interface ShootDenniVstup {
  rezim: ShootNoveFoceni;
  /** Prázdné = žádné focení zatím není. */
  posledni: ShootPosledni | null;
  ted: Date;
  /** Okno se právě otevřelo. Jinak: za běhu přeskočila půlnoc. */
  priOtevreni: boolean;
}

/**
 * Co se má stát.
 *
 * `prejmenovat` je drobnost, která ušetří zbytečné ptaní: focení z jiného
 * dne, ve kterém **není ani jedna fotka** a které se pořád jmenuje podle
 * data svého vzniku, nemá cenu ani nabízet k pokračování, ani kvůli němu
 * zakládat další prázdné. Přepíše se mu datum v názvu a fotí se do něj.
 */
export type ShootDenniKrok = 'nic' | 'zeptat' | 'zalozit' | 'prejmenovat';

/** Název, který focení dostane, když si ho nikdo nepojmenuje. */
export function automatickyNazev(den: Date): string {
  return `Focení ${den.toLocaleDateString('cs-CZ')}`;
}

/**
 * Je to pořád ten název, který focení dostalo samo?
 *
 * Porovnává se tvarem, ne na znak: `toLocaleDateString` dává v Node a
 * v prohlížeči různé mezery („9. 10. 2026" versus „9.10.2026") a na tom
 * by přejmenování tiše přestalo fungovat.
 */
export function jeAutomatickyNazev(nazev: string): boolean {
  return /^Focení\s+\d{1,2}\.\s*\d{1,2}\.\s*\d{4}$/.test(String(nazev || '').trim());
}

/** Týž kalendářní den podle místního času. */
export function stejnyDen(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

export function denniKrok(v: ShootDenniVstup): ShootDenniKrok {
  if (v.rezim === 'nikdy') return 'nic';
  if (!v.posledni) return 'zalozit';

  const vzniklo = new Date(v.posledni.kdy);
  /* Nečitelné datum se bere jako „z jiného dne" — raději se zeptat */
  const dnesni = Number.isFinite(vzniklo.getTime()) && stejnyDen(vzniklo, v.ted);

  if (dnesni) {
    /*
     * Během dne se mlčí. Dotaz u focení, které vzniklo před hodinou, je
     * přesně ten druh hlášky, kterou si člověk odklikne, aniž ji přečte —
     * a pak si ji odklikne i ten jediný den, kdy na ní záleželo.
     */
    return v.priOtevreni && v.rezim === 'vzdy' ? 'zeptat' : 'nic';
  }

  if (v.posledni.fotek === 0 && jeAutomatickyNazev(v.posledni.nazev)) return 'prejmenovat';
  if (v.rezim === 'samo') return 'zalozit';
  return 'zeptat';
}

/** Věta do dotazu — co se stane, když se bude pokračovat. */
export function denniDuvod(posledni: ShootPosledni, ted: Date): string {
  const vzniklo = new Date(posledni.kdy);
  /*
   * Datum už samo končí tečkou („16. 9."), takže se další nepřidává —
   * jinak z toho byla věta zakončená dvěma tečkami.
   */
  const den = Number.isFinite(vzniklo.getTime())
    ? vzniklo.toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric' }).replace(/\.$/, '')
    : 'dřívějška';
  const kusy = posledni.fotek === 1 ? '1 fotka'
    : posledni.fotek < 5 ? `${posledni.fotek} fotky`
      : `${posledni.fotek} fotek`;
  void ted;
  return posledni.fotek > 0
    ? `Poslední focení „${posledni.nazev}" je z ${den}. a je v něm ${kusy}.`
    : `Poslední focení „${posledni.nazev}" je z ${den}.`;
}
