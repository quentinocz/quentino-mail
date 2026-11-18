import { plain } from './detect';
import { partialJsonState } from './partial';

/**
 * Co se v běhu překladu právě děje — po produktech a po polích.
 *
 * ## Proč
 *
 * Pruh se dřív hýbal podle **času**: rozjeté volání se započítávalo podle
 * toho, jak dlouho už běží, oproti tomu, jak dlouho volání obvykle trvá.
 * Vypadalo to plynule, ale nebyla to pravda — pruh se plazil k cíli a
 * skutečná práce se ukázala až skokem na konci. U tříminutového překladu
 * tak většina „postupu" přišla v poslední vteřině a do té doby to vypadalo
 * jako zaseknuté.
 *
 * Teď se počítá **skutečná práce**: kolik textu model už napsal. Odpověď
 * chodí proudem, takže se ví, které pole je hotové, na kterém se píše
 * a kolik z něj už je. Pruh je podíl napsaných znaků na všech, které
 * napsat zbývá. Pole z paměti práci nestojí, takže pruh neposouvají —
 * odhad času s nimi ale počítá od začátku.
 *
 * A když se nepíše, je vidět **proč**: čeká se na první slovo odpovědi,
 * API je přetížené a zkusí se to za osm vteřin, doplňuje se český text.
 * Stav s odpočtem nevypadá jako zaseknutý.
 */

export type FieldStatus = 'pending' | 'memory' | 'waiting' | 'writing' | 'done' | 'failed';

export interface FieldActivity {
  lang: string;
  field: string;
  status: FieldStatus;
  /** Kolik znaků textu (bez HTML) má model napsat */
  expected: number;
  /** Kolik už napsal */
  written: number;
  /** Začátek hotového textu — ať je vidět, co vzniklo */
  preview?: string;
  /** Kolik odstavců či vět se vzalo z paměti (zbytek psal model) */
  fromMemory?: number;
  /** Kolik vět šlo modelu s hotovým překladem podobné věty jako vzorem */
  patterned?: number;
}

export type Phase = 'start' | 'source' | 'waiting' | 'writing' | 'retry' | 'limit' | 'saving';

export interface ProductActivity {
  code: string;
  title: string;
  phase: Phase;
  /** Od kdy je v téhle fázi (ms) */
  since: number;
  /** Do kdy se čeká (u opakování a limitu API) */
  until?: number;
  note?: string;
  /** Kolik znaků odpovědi v aktuálním dotazu už přišlo */
  received: number;
  fields: FieldActivity[];
}

let active: Map<string, ProductActivity> | null = null;

/**
 * Kdo chce vědět o změně stavu pole — běh pošle průběh do okna hned, ne
 * až za půl vteřiny. Hotové pole se tak objeví ve chvíli, kdy ho model
 * dopsal, i když je poslední v odpovědi.
 */
let changed: (() => void) | null = null;

export function begin(onChange?: () => void): void { active = new Map(); changed = onChange ?? null; }
export function end(): void { active = null; changed = null; }
export const tracking = () => active !== null;

export function startProduct(code: string, title: string): void {
  active?.set(code, { code, title, phase: 'start', since: Date.now(), received: 0, fields: [] });
}

export function finishProduct(code: string): ProductActivity | undefined {
  const one = active?.get(code);
  active?.delete(code);
  return one;
}

function find(code: string, lang: string, field: string): FieldActivity | undefined {
  return active?.get(code)?.fields.find(one => one.lang === lang && one.field === field);
}

/** Pole, které se má přeložit. Opakované přidání jen obnoví čekání. */
export function expectField(code: string, lang: string, field: string, expected: number): void {
  const one = active?.get(code);
  if (!one) return;
  const have = find(code, lang, field);
  if (have) {
    if (have.status !== 'done' && have.status !== 'memory') {
      Object.assign(have, { status: 'pending', expected, written: 0 });
    }
    return;
  }
  one.fields.push({ lang, field, status: 'pending', expected, written: 0 });
}

export function setField(code: string, lang: string, field: string, patch: Partial<FieldActivity>): void {
  const have = find(code, lang, field);
  if (!have) return;
  const was = have.status;
  Object.assign(have, patch);
  if (patch.status && patch.status !== was) changed?.();
}

export function setPhase(code: string, phase: Phase, note?: string, until?: number): void {
  const one = active?.get(code);
  if (!one) return;
  /*
   * Produkt se překládá několika dotazy naráz. Když jeden teprve čeká a
   * druhý už píše, platí „píše"; „ukládá" až ve chvíli, kdy nic dalšího
   * nečeká ani se nepíše.
   */
  const busy = one.fields.some(f => f.status === 'writing' || f.status === 'waiting');
  if (phase === 'waiting' && one.phase === 'writing') return;
  if (phase === 'saving' && busy) return;
  if (one.phase !== phase || one.note !== note) one.since = Date.now();
  one.phase = phase;
  one.note = note;
  one.until = until;
}

/** Začátek textu na ukázku — bez HTML a značek. */
export function previewOf(text: string): string {
  const flat = plain(text).replace(/⟦\d+⟧/g, '…');
  return flat.length > 140 ? flat.slice(0, 137) + '…' : flat;
}

/**
 * Přírůstek odpovědi modelu.
 *
 * Z rozepsaného JSON se pozná, která pole jsou hotová (řetězec je
 * uzavřený) a na kterém se právě píše — a kolik z něj už je.
 * `slotsOf` dosadí do ukázky hotové odstavce místo značek.
 */
/**
 * Vrací pole, která se tímhle přírůstkem uzavřela — i s textem, tak jak ho
 * model napsal. Volající je hned uloží (a opakované hlášení téhož pole si
 * pohlídá sám). Funguje i mimo běh (tlačítko „přeložit znovu"): tam se jen
 * nic nezobrazuje.
 */
export function onStream(code: string, langs: string[], nested: boolean, soFar: string,
                         slotsOf: (lang: string, field: string) => Map<string, string> | undefined):
  { lang: string; field: string; value: string }[] {
  const out: { lang: string; field: string; value: string }[] = [];
  const one = active?.get(code);
  const { tree, open } = partialJsonState(soFar);
  if (!one) {
    // Mimo běh se jen pozná, co je uzavřené
    for (const lang of langs) {
      const fields = nested ? tree[lang] : tree;
      if (!fields || typeof fields !== 'object') continue;
      for (const [field, value] of Object.entries(fields)) {
        if (typeof value !== 'string') continue;
        const isOpen = !!open && (nested ? open[0] === lang && open[1] === field : open[0] === field);
        if (!isOpen) out.push({ lang, field, value });
      }
    }
    return out;
  }
  if (one.phase !== 'writing') setPhase(code, 'writing');
  for (const lang of langs) {
    const fields = nested ? tree[lang] : tree;
    if (!fields || typeof fields !== 'object') continue;
    for (const [field, value] of Object.entries(fields)) {
      if (typeof value !== 'string') continue;
      const have = find(code, lang, field);
      if (!have || have.status === 'memory') continue;
      const isOpen = !!open && (nested ? open[0] === lang && open[1] === field : open[0] === field);
      const slots = slotsOf(lang, field);
      const text = slots ? value.replace(/⟦\d+⟧/g, slot => slots.get(slot) ?? '') : value;
      // Psané znaky se počítají bez značek a HTML — stejně jako `expected`
      const written = plain(value.replace(/⟦\d+⟧/g, '')).length;
      if (isOpen) {
        have.status = 'writing';
        have.written = Math.min(written, Math.round(have.expected * 0.97));
      } else if (have.status !== 'done') {
        have.status = 'done';
        have.written = have.expected;
        have.preview = previewOf(text);
        out.push({ lang, field, value });
        changed?.();
      }
    }
  }
  // Napsané znaky za všechny souběžné dotazy produktu
  one.received = one.fields.reduce((sum, f) => sum + (f.status === 'done' || f.status === 'writing' ? f.written : 0), 0);
  return out;
}

/** Kolik znaků z toho, co se v produktu píše, už je napsaných. */
export function writtenIn(code: string): number {
  const one = active?.get(code);
  if (!one) return 0;
  let sum = 0;
  for (const field of one.fields) {
    if (field.status === 'done') sum += field.expected;
    else if (field.status === 'writing') sum += field.written;
  }
  return sum;
}

export function snapshot(): ProductActivity[] {
  return active ? [...active.values()].map(one => ({ ...one, fields: one.fields.map(f => ({ ...f })) })) : [];
}

/* ---------- rychlost a odhad ---------- */

/**
 * Rychlost modelu — ze dvou čísel, ne z jednoho.
 *
 * Doba překladu není úměrná jen délce textu. Každý dotaz má pevnou část
 * (než model začne psát, uplyne pár vteřin, ať je text dlouhý nebo krátký)
 * a pak část úměrnou délce. Průměr „sekund na produkt" to slévá dohromady,
 * a proto odhad u krátkých názvů přestřeloval a u dlouhých popisů
 * podstřeloval. Teď se měří obojí zvlášť: čekání na první slovo a rychlost
 * psaní ve znacích za vteřinu.
 */
export interface Speed {
  /** Vteřiny do prvního slova odpovědi */
  wait: number;
  /** Znaky textu za vteřinu, jak model píše */
  cps: number;
}

export const DEFAULT_SPEED: Speed = { wait: 4, cps: 90 };

/** Klouzavý průměr — nové měření má váhu třetiny. */
export function blend(old: Speed, wait: number | null, cps: number | null): Speed {
  const mix = (a: number, b: number | null, lo: number, hi: number) =>
    (b === null || !Number.isFinite(b) ? a : Math.min(hi, Math.max(lo, a * 0.67 + b * 0.33)));
  return { wait: mix(old.wait, wait, 0.5, 60), cps: mix(old.cps, cps, 5, 2000) };
}

/**
 * Kolik vteřin zabere práce, když se pojede tak, jako pojede běh.
 *
 * Běh nezačíná naplno: začne jedním souběžným dotazem a přidá další po
 * třech produktech bez zádrhelu (viz `run`). Odhad to proto prochází
 * stejně — jinak by sliboval rychlost, kterou běh na začátku nemá.
 */
export function simulate(products: number[], speed: Speed, maxLanes: number, startLanes = 1): number {
  const lanes = Array.from({ length: Math.max(1, maxLanes) }, () => 0);
  let open = Math.max(1, Math.min(startLanes, maxLanes));
  let good = 0;
  for (const chars of products) {
    // Nejdřív volný z otevřených pruhů
    let pick = 0;
    for (let i = 1; i < open; i++) if (lanes[i] < lanes[pick]) pick = i;
    const cost = chars > 0 ? speed.wait + chars / speed.cps : 0.2;
    lanes[pick] += cost;
    if (++good >= 3 && open < maxLanes) {
      // Nový pruh se přidá v čase, kdy se rozhodlo — ne na začátku
      lanes[open] = lanes[pick];
      open++;
      good = 0;
    }
  }
  return Math.max(...lanes.slice(0, open));
}
