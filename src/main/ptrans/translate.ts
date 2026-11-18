import { BrowserWindow } from 'electron';
import { ask, rateLimitedRecently } from '../ai';
import { getSettings } from '../settings';
import { getDb } from '../db';
import { getPtransSettings, savePtransSettings, productFields, saveTranslation, targetLangs,
  alignSources, PtransSettings, FieldRow } from './store';
import { HTML_FIELDS, DERIVED_FIELDS } from './xml';
import { tidyHtml } from './html';
import { tidyProducts } from './tidy';
import { NEEDS_WORK, plain, clamp } from './detect';
import { languageNote } from './style';
import { consistencyHint } from './consistency';
import { setSeoUrl } from './redirects';
import { memoryHint, memoryStats, learnFromFeed } from './memory';
import { planSourceFill, fillSourceOne, SourceField, SourceTarget, SOURCE_LABELS } from './source';
import { applyAttributes } from './google';
import { lookup, unmask, learn, slotHint, nearHint, slotMarks, learnFromStore, Near, Mark } from './reuse';
import * as activity from './activity';
import { Speed, DEFAULT_SPEED, blend, simulate } from './activity';

/**
 * Překlad produktových textů.
 *
 * Nepřekládá se pole po poli, ale **celý produkt do jednoho jazyka najednou**.
 * Model tak vidí název, krátký i dlouhý popis pohromadě a udrží mezi nimi
 * stejné názvosloví; zároveň je to výrazně méně volání, takže je to levnější
 * i rychlejší. Odpověď chodí jako JSON, protože „vrať jen text" u pěti polí
 * spolehlivě nefunguje.
 *
 * SEO adresa se negeneruje modelem — přepis do bezdiakritického tvaru je
 * mechanická práce, kterou zvládne kód přesněji a zadarmo.
 */

export interface TranslateTarget {
  code: string;
  lang: string;
  /** Která pole přeložit; prázdné = všechna, která to potřebují */
  fields?: string[];
  /** Přeložit i to, co už přeložené je */
  force?: boolean;
}

export interface ProgressState {
  running: boolean;
  done: number;
  total: number;
  failed: number;
  /** Kolik sekund podle dosavadního tempa zbývá */
  etaSeconds: number | null;
  /** Průměr posledních měření (sekundy na produkt a jazyk) */
  secondsPerUnit: number;
  label: string;
  errors: string[];
  /**
   * Naplnění pruhu 0–1 — podle toho, kolik textu model **opravdu napsal**,
   * ne podle uplynulého času (viz activity.ts).
   */
  bar: number;
  products?: { done: number; total: number };
  fields?: { done: number; total: number };
  /** Co se právě překládá: produkty, jejich pole a na co se čeká */
  current?: activity.ProductActivity[];
  /** Naměřená rychlost modelu — do vysvětlivky k odhadu */
  speed?: Speed;
  lanes?: number;
}

function emit(channel: string, payload: unknown) {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload);
}

/* ---------- stav běhu ---------- */

let cancelled = false;
let current: ProgressState | null = null;
/**
 * Přerušení rozběhnutých volání.
 *
 * Samotný příznak `cancelled` zařídí jen to, že se nezačne nic nového —
 * požadavky, které už letí, doběhnou. U šesti souběžných překladů to
 * znamenalo, že se běh po stisku „Zastavit" ještě klidně půl minuty vlekl.
 * Signál je ukončí okamžitě.
 */
let abort: AbortController | null = null;

export function progress(): ProgressState | null {
  return current;
}

export function stop(): void {
  cancelled = true;
  abort?.abort();
  if (current?.running) {
    current = { ...current, label: 'zastavuji…' };
    emit('ptrans:progress', current);
  }
}

/** Přerušené volání není chyba překladu — hlásit ho v seznamu chyb by mátlo. */
function isAborted(error: any): boolean {
  return cancelled || error?.name === 'AbortError' || /abort/i.test(String(error?.message ?? ''));
}

/* ---------- co je potřeba přeložit ---------- */

/** Rozpadne výběr produktů a jazyků na jednotlivé úkoly. */
export function planWork(codes: string[], langs: string[], options: { force?: boolean; fields?: string[] } = {}):
  TranslateTarget[] {
  const d = getDb();
  const s = getPtransSettings();
  const wanted = options.fields?.length ? options.fields : null;
  const out: TranslateTarget[] = [];

  // Pořadí podle kategorie: první přeložené kusy dělají vzor pro zbytek
  // kategorie, takže se jednotnost udržuje sama
  const ordered = [...codes].sort((a, b) => {
    const ca = categoryOf(a);
    const cb = categoryOf(b);
    return ca === cb ? a.localeCompare(b) : ca.localeCompare(cb, 'cs');
  });

  for (const code of ordered) {
    for (const lang of langs) {
      const rows = d.prepare(
        'SELECT field, state FROM ptrans_fields WHERE code = ? AND lang = ?'
      ).all(code, lang) as { field: string; state: string }[];

      const fields = rows
        .filter(row => (wanted ? wanted.includes(row.field) : s.fields[row.field] !== false))
        .filter(row => (options.force ? row.state !== 'manual' : NEEDS_WORK.includes(row.state as any)))
        .map(row => row.field);

      if (fields.length > 0) out.push({ code, lang, fields, force: options.force });
    }
  }
  return out;
}

/**
 * Kolik z toho se vůbec dá přeložit.
 *
 * Pole bez textu ve zdrojovém jazyce nikdy nezmizí ze seznamu „čeká na
 * překlad" — přeložit prázdno nejde. Kdyby se počítalo mezi nedokončené,
 * hlásil by běh chyby napořád a každý produkt by zbytečně dostal všechny
 * pokusy. Hlásí se to zvlášť, jako „chybí české znění".
 */
export function withSource(targets: TranslateTarget[]): TranslateTarget[] {
  const d = getDb();
  const read = d.prepare(
    'SELECT field FROM ptrans_fields WHERE code = ? AND lang = ? AND trim(source_value) != \'\''
  );
  return targets
    .map(target => {
      const have = new Set((read.all(target.code, target.lang) as { field: string }[])
        .map(row => row.field));
      const fields = (target.fields ?? []).filter(field => have.has(field));
      return { ...target, fields };
    })
    .filter(target => (target.fields?.length ?? 0) > 0);
}

function categoryOf(code: string): string {
  const row = getDb().prepare('SELECT category FROM ptrans_products WHERE code = ?')
    .get(code) as { category: string } | undefined;
  return row?.category ?? '';
}

/* ---------- vlastní překlad ---------- */

function labelOf(lang: string, s: PtransSettings): string {
  return s.languages.find(l => l.code === lang)?.label ?? lang;
}

/** Popisky polí pro model — ať ví, co má v ruce. */
/**
 * Zdrojový text tak, jak se pošle modelu.
 *
 * Popisy vložené kopírováním z jiného okna vlečou s sebou obal cizí stránky
 * (`<article>`, `class` na půl obrazovky, `data-start`). Modelu to k ničemu
 * není, ale platí se to a hlavně se tím nafukuje odpověď — v tomhle feedu je
 * takového balastu **třetina všech znaků v popisech** a nejdelší popis se
 * kvůli němu do jedné odpovědi vůbec nevešel. Zadání se proto uklidí; text
 * v něm zůstane do písmene stejný.
 */
function forModel(field: string, source: string): string {
  return HTML_FIELDS.has(field) ? tidyHtml(source) : source;
}

/** Přeložený text před uložením — balast se do překladu propsat nemá. */
function fromModel(field: string, value: string): string {
  return HTML_FIELDS.has(field) ? tidyHtml(value) : plain(value);
}

const FIELD_LABELS: Record<string, string> = {
  title: 'název produktu (krátký, bez HTML)',
  short: 'krátký popis (HTML)',
  long: 'dlouhý popis (HTML)',
  seo_title: 'SEO titulek pro vyhledávače',
  seo_desc: 'SEO meta popis',
  google_title: 'název pro Google Nákupy',
  google_desc: 'popis pro Google Nákupy'
};

/**
 * Zadání pro model — pro jeden jazyk, nebo pro několik naráz.
 *
 * Několik jazyků v jednom dotazu není jen úspora času. Zdrojový text,
 * pravidla, názvosloví i popis značky se pošlou **jednou místo třikrát**,
 * takže se úměrně sníží i spotřeba vstupních tokenů — a právě ta je to,
 * co naráží na limity API. Míň dotazů znamená míň příležitostí, aby jeden
 * z nich spadl a jeden trh zůstal nepřeložený.
 */
function buildSystem(s: PtransSettings, targetLangs: string[]): string {
  const brand = getSettings().brandPrompt?.trim();
  const glossary = s.glossary
    .filter(entry => targetLangs.some(lang => entry.targets[lang]))
    .map(entry => `- „${entry.source}" → `
      + targetLangs.filter(l => entry.targets[l]).map(l => `${l}: „${entry.targets[l]}"`).join(', '))
    .join('\n');
  const many = targetLangs.length > 1;

  return [
    `Jsi profesionální překladatel produktových textů pro e-shop s módními doplňky.`,
    many
      ? `Překládáš z jazyka „${s.sourceLang}" do jazyků: ${targetLangs.join(', ')}.`
      : `Překládáš z jazyka „${s.sourceLang}" do jazyka „${targetLangs[0]}".`,
    '',
    'Pravidla:',
    '- Zachovej význam a všechna fakta. Nic nepřidávej ani neubírej.',
    '- Zachovej HTML značky, atributy i jejich pořadí. Překládej jen text mezi značkami.',
    '- Zachovej rozdělení do odstavců a odrážek.',
    '- Míry, kódy, čísla a názvy značky nech beze změny.',
    // Emodži v textu jsou záměr autora, ne překlep. Model je jinak rád
    // „uklidí" a z textu zmizí, aniž by si toho někdo všiml.
    '- Emodži i další symboly zachovej přesně tak, jak jsou, a na stejném místě.',
    '- Piš přirozeně v cílovém jazyce, ne doslovně. Text má znít, jako by ho psal rodilý mluvčí.',
    '- Nepřekládej do češtiny ani nenech nic v češtině.',
    // Hotové odstavce z paměti (viz reuse.ts) — model je nesmí přepsat ani vynechat
    '- Značky jako ⟦3⟧ jsou hotové odstavce: nech je beze změny na jejich místě.',
    // Psaní velkých písmen se mezi jazyky liší a model má sklon přenést
    // zvyk zdrojového jazyka. V názvech je to hned vidět.
    targetLangs.map(lang => (many ? `- ${lang}: ${languageNote(lang)}` : languageNote(lang)))
      .filter(Boolean).join('\n'),
    glossary ? `\nZávazné názvosloví:\n${glossary}` : '',
    brand ? `\nO značce (pro tón textu):\n${brand}` : '',
    s.prompt.trim() ? `\nVlastní pokyny:\n${s.prompt.trim()}` : '',
    '',
    many
      ? 'Odpověz POUZE JSON objektem, kde klíč je kód jazyka a hodnota objekt'
        + ` se stejnými klíči, jaké dostaneš na vstupu. Například:`
        + ` {"${targetLangs[0]}": {"title": "…"}, "${targetLangs[1]}": {"title": "…"}}.`
        + ' Vrať všechny žádané jazyky. Žádný jiný text.'
      : 'Odpověz POUZE JSON objektem se stejnými klíči, jaké dostaneš na vstupu. Žádný jiný text.'
  ].filter(Boolean).join('\n');
}

/** Z odpovědi modelu vytáhne JSON i tehdy, když ho zabalí do bloku kódu. */
function parseJson(raw: string): Record<string, string> {
  let text = raw.trim();
  if (text.startsWith('```')) text = text.replace(/^```[a-z]*\n?/i, '').replace(/```\s*$/, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('Model nevrátil JSON.');
  const parsed = JSON.parse(text.slice(start, end + 1));
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

/** Ořízne text na daný počet znaků na hranici slova (SEO titulky a popisy). */
/** Přepis názvu na adresu: bez diakritiky, malá písmena, pomlčky. */
export function slugify(value: string): string {
  return plain(value)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[ľĺŕčšžťďňäôåøæ]/gi, ch => ({
      ľ: 'l', ĺ: 'l', ŕ: 'r', č: 'c', š: 's', ž: 'z', ť: 't', ď: 'd', ň: 'n',
      ä: 'a', ô: 'o', å: 'a', ø: 'o', æ: 'ae'
    } as Record<string, string>)[ch.toLowerCase()] ?? ch)
    .replace(/ß/g, 'ss')
    .toLowerCase()
    // Apostrof se zahazuje, nedělá se z něj pomlčka: „men's" má být
    // „mens", ne „men-s" s osamocené písmenem uprostřed adresy
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

/* ---------- příprava zadání a paměť odstavců ---------- */

/** Kdo pole „přeložil", když se vzalo z paměti — ať je v kartě vidět odkud. */
export const REUSE_MODEL = 'paměť odstavců';

/**
 * Pole, u kterých model značky nedodržel.
 *
 * Další pokus o totéž pole jde bez značek — celý text. Jinak by se stejná
 * chyba opakovala, dokud nedojdou pokusy.
 */
const noMask = new Set<string>();

interface Prepared {
  /** Co jde modelu (se značkami, kde je co dosadit) */
  payload: Record<string, string>;
  /** Zdroj tak, jak ho vidí model, ale bez značek — na učení paměti */
  sources: Record<string, string>;
  masks: Record<string, Map<string, string>>;
  /** Značka → odstavec, ať se dá v náhledu podbarvit, co přišlo z paměti */
  slotBlocks: Record<string, Map<string, number>>;
  /** Podobné věty s hotovým překladem — vzor pro model */
  near: Near[];
  noSource: string[];
  /** Kolik polí se přeložilo rovnou z paměti */
  reused: number;
  /** Název, když se vzal z paměti — adresa se z něj odvodí stejně */
  reusedTitle?: string;
}

/**
 * Zadání pro jeden jazyk.
 *
 * Co celé známe, se rovnou uloží a do zadání nejde. Co známe z velké
 * části, jde se značkami. `force` („přeložit znovu i hotové") paměť
 * obchází: kdo chce nový překlad, nechce dostat ten starý.
 */
function prepare(target: TranslateTarget, rows: FieldRow[], model: string, slot = { next: 1 }): Prepared {
  const wanted = (target.fields?.length ? target.fields : rows.map(r => r.field))
    .filter(field => !DERIVED_FIELDS.has(field));
  const out: Prepared = { payload: {}, sources: {}, masks: {}, slotBlocks: {}, near: [], noSource: [], reused: 0 };
  for (const field of wanted) {
    const source = rows.find(r => r.field === field)?.source ?? '';
    if (!source.trim()) { out.noSource.push(field); continue; }
    const text = forModel(field, source);
    const marker = `${target.code}|${target.lang}|${field}`;
    const known = target.force || noMask.has(marker) ? null : safeLookup(target.lang, field, text, slot.next);
    if (known?.full !== undefined) {
      const value = finalValue(field, known.full);
      saveTranslation(target.code, target.lang, field, value, REUSE_MODEL, false, known.marks ?? []);
      activity.setField(target.code, target.lang, field,
        { status: 'memory', expected: 0, written: 0, preview: activity.previewOf(value) });
      emitField(target.code, target.lang, field);
      out.reused++;
      if (field === 'title') out.reusedTitle = known.full;
      continue;
    }
    out.sources[field] = text;
    if (known?.near.length) out.near.push(...known.near);
    if (known?.masked !== undefined && known.slots) {
      out.payload[field] = known.masked;
      out.masks[field] = known.slots;
      if (known.slotBlock) out.slotBlocks[field] = known.slotBlock;
      slot.next += known.slots.size;
    } else {
      out.payload[field] = text;
    }
    // Kolik toho model napíše: text bez značek hotových odstavců
    activity.expectField(target.code, target.lang, field, workOf(out.payload[field]));
    // Kolik vět z paměti a kolik jich jde modelu podle vzoru podobné věty — do průběhu
    activity.setField(target.code, target.lang, field,
      { fromMemory: known?.slots?.size ?? 0, patterned: known?.near.length ?? 0 });
  }
  return out;
}

/** Kolik znaků textu má model napsat — bez HTML a bez hotových odstavců. */
export function workOf(text: string): number {
  return Math.max(12, plain(text.replace(/⟦\d+⟧/g, '')).length);
}

/**
 * Uloží jedno přeložené pole — hned, jak ho model dopíše.
 *
 * Dřív se ukládalo až po celé odpovědi: v kartě produktu svítila u
 * slovenštiny „čeština", i když byla dávno napsaná, a čekalo se na
 * angličtinu. Teď se pole uloží ve chvíli, kdy je v odpovědi uzavřené
 * (hotový řetězec v JSON se už nezmění), a okno se o tom dozví.
 * Vrací `false`, když model nedodržel značky hotových odstavců.
 */
function saveOne(target: TranslateTarget, field: string, raw: string, model: string,
                 ready: Pick<Prepared, 'masks' | 'slotBlocks' | 'sources'>): boolean {
  const whole = fromAnswer(target, field, raw, ready.masks);
  if (whole === null) {
    activity.setField(target.code, target.lang, field, { status: 'pending', written: 0 });
    return false;
  }
  const value = finalValue(field, whole);
  saveTranslation(target.code, target.lang, field, value, model, false, marksOf(field, ready));
  activity.setField(target.code, target.lang, field, { status: 'done', preview: activity.previewOf(value) });
  remember(target.lang, field, ready.sources[field], value);
  emitField(target.code, target.lang, field);
  return true;
}

/** Okno se dozví, že u produktu přibylo pole — otevřená karta se obnoví. */
function emitField(code: string, lang: string, field: string) {
  emit('ptrans:field', { code, lang, field });
}

/* ---------- kolik dotazů naráz ---------- */

/**
 * Strop souběžných dotazů na model pro celou aplikaci.
 *
 * Produkt se teď překládá několika dotazy naráz (jazyky, velká pole) a
 * produktů běží víc. Bez stropu by se při souběžnosti 3 sešlo i dvacet
 * dotazů a API by začalo odmítat. Strop roste s nastavenou souběžností.
 */
let inFlightAsks = 0;
const askQueue: (() => void)[] = [];

function gate(concurrency: number): Promise<() => void> {
  const max = Math.max(4, Math.min(12, (concurrency || 2) * 4));
  const release = () => {
    inFlightAsks--;
    askQueue.shift()?.();
  };
  return new Promise(resolve => {
    const go = () => { inFlightAsks++; resolve(release); };
    if (inFlightAsks < max) go();
    else askQueue.push(go);
  });
}

/* ---------- měření rychlosti ---------- */

let speedNow: Speed = { ...DEFAULT_SPEED };

/**
 * Sleduje jeden dotaz: kdy přišlo první slovo a jak rychle se pak psalo.
 * Vrací zpětná volání pro `ask` a funkci, která měření na konci zapíše.
 */
function measure(code: string, langs: string[], nested: boolean, chars: number,
                 slotsOf: (lang: string, field: string) => Map<string, string> | undefined,
                 onClosed?: (lang: string, field: string, raw: string) => void) {
  const at = Date.now();
  let first = 0;
  activity.setPhase(code, 'waiting');
  return {
    onText: (soFar: string) => {
      if (!first) first = Date.now();
      for (const one of activity.onStream(code, langs, nested, soFar, slotsOf)) {
        try { onClosed?.(one.lang, one.field, one.value); } catch { /* uloží se na konci */ }
      }
    },
    onWait: (ms: number, reason: string) => {
      first = 0;
      activity.setPhase(code, 'limit', reason, Date.now() + ms);
    },
    done: () => {
      const end = Date.now();
      if (!first) return;
      const writing = (end - first) / 1000;
      speedNow = blend(speedNow, (first - at) / 1000, writing > 0.5 ? chars / writing : null);
      activity.setPhase(code, 'saving');
    }
  };
}

/** Pro odhad: co je známé, bez hledání podobných vět (to je pomalé a odhad ho nepotřebuje). */
function quickLookup(lang: string, field: string, text: string) {
  try { return lookup(lang, field, text, 1, { near: false }); } catch { return null; }
}

/** Paměť je zrychlení, ne podmínka — její chyba nesmí zastavit překlad. */
function safeLookup(lang: string, field: string, text: string, start: number) {
  try { return lookup(lang, field, text, start); } catch { return null; }
}

/** Úprava hodnoty před uložením: úklid HTML a délkové limity SEO polí. */
function finalValue(field: string, raw: string): string {
  const s = getPtransSettings();
  let value = fromModel(field, raw);
  if (field === 'seo_title') value = clamp(value, s.limits.seoTitle);
  if (field === 'seo_desc') value = clamp(value, s.limits.seoDesc);
  return value;
}

/**
 * Hodnota z odpovědi modelu, se značkami nahrazenými hotovými odstavci.
 * `null` = značky nesedí, pole zůstane na další pokus (už bez nich).
 */
function fromAnswer(target: TranslateTarget, field: string, raw: string,
                    masks: Record<string, Map<string, string>>): string | null {
  const slots = masks[field];
  if (!slots) return raw;
  const whole = unmask(raw, slots);
  if (whole === null) noMask.add(`${target.code}|${target.lang}|${field}`);
  return whole;
}

/** Co v hotovém poli přišlo z paměti — podle značek, které model dodržel. */
function marksOf(field: string, ready: { masks: Record<string, Map<string, string>>;
  slotBlocks: Record<string, Map<string, number>> }): Mark[] {
  const slots = ready.masks[field];
  return slots ? slotMarks(slots, ready.slotBlocks[field]) : [];
}

/** Zapamatuje si nový překlad po odstavcích — pro sourozence, kteří přijdou. */
function remember(lang: string, field: string, source: string | undefined, value: string) {
  if (!source) return;
  try { learn(lang, field, source, value); } catch { /* paměť je pomůcka */ }
}

/** Vysvětlivka ke značkám pro jeden nebo víc jazyků. */
function maskHint(parts: { lang?: string; masks: Record<string, Map<string, string>> }[]): string {
  return slotHint(parts.flatMap(part => Object.values(part.masks).map(slots => ({ lang: part.lang, slots }))));
}

/**
 * Přeloží jeden produkt do jednoho jazyka.
 *
 * Vrací, kolik polí se opravdu uložilo. Chyba se nevyhazuje výš — jeden
 * nepovedený produkt nesmí zastavit dávku o tisíci kusech.
 */
export async function translateOne(target: TranslateTarget, signal?: AbortSignal):
  Promise<{ saved: number; error?: string; noSource?: string[]; reused?: number }> {
  return runTranslate(target, signal, 1);
}

/**
 * Jeden překlad. `factor` zvětšuje strop odpovědi při opakování.
 *
 * Odhad výstupu je jen odhad: angličtina bývá delší než čeština a HTML značky
 * se do něj nepočítají. Když se odpověď přesto usekne, nestačí to nahlásit —
 * překlad se zkusí znovu s větším stropem, a když je pole víc, rozdělí se.
 */
async function runTranslate(target: TranslateTarget, signal: AbortSignal | undefined,
                            factor: number): Promise<{ saved: number; error?: string; noSource?: string[]; reused?: number }> {
  const s = getPtransSettings();
  const model = s.model || getSettings().draftModel;
  const rows = productFields(target.code, [target.lang]);

  /*
   * Přeložit jde jen to, co ve zdrojovém jazyce existuje.
   *
   * Pole bez českého znění se do zadání pro model nedává — nemá co překládat.
   * Dřív se ale takové pole i tak započítalo jako hotový úkol a běh skončil
   * hláškou „hotovo, 0 chyb", i když se nezměnilo vůbec nic. Nejčastější
   * případ je chybějící český SEO titulek: v seznamu svítí „čeká na překlad",
   * překlad proběhne, a je to pořád stejné. Proto se to teď počítá a nahlásí.
   */
  const prepared = prepare(target, rows, model);
  const { payload, noSource, masks, sources } = prepared;
  const wanted = Object.keys(payload);
  if (wanted.length === 0 && prepared.reused > 0) {
    // Všechno se našlo v paměti — model není potřeba vůbec
    let saved = prepared.reused;
    if (s.fields.seo_url !== false && prepared.reusedTitle) {
      const result = applySlug(target.code, target.lang, rows, REUSE_MODEL, prepared.reusedTitle);
      if (result) saved += result.redirect ? 2 : 1;
    }
    return { saved, noSource, reused: prepared.reused };
  }
  if (wanted.length === 0) {
    return {
      saved: 0,
      noSource,
      error: `${target.code} (${target.lang}): ${noSource.map(f => FIELD_LABELS[f] ?? f).join(', ')}`
        + ` — chybí text ve zdrojovém jazyce, není co překládat`
    };
  }

  const product = getDb().prepare('SELECT title, category, manufacturer FROM ptrans_products WHERE code = ?')
    .get(target.code) as { title: string; category: string; manufacturer: string } | undefined;

  // Kvůli jednotnosti dostane model tvar názvů v kategorii a pár hotových
  // dvojic — bez toho si pokaždé zvolí jiný slovosled
  const consistency = payload.title || payload.seo_title || payload.google_title
    ? consistencyHint(product?.category ?? '', target.lang)
    : '';
  // Paměť překladů: ustálené výrazy, které se v tomhle textu opravdu vyskytují
  const memory = memoryHint(Object.values(payload).join(' \n'), target.lang, product?.category ?? '');

  const hint = [
    product?.category ? `Kategorie: ${product.category}` : '',
    product?.manufacturer ? `Značka: ${product.manufacturer}` : '',
    'Vysvětlivky k polím:',
    ...wanted.filter(f => FIELD_LABELS[f]).map(f => `- ${f}: ${FIELD_LABELS[f]}`),
    s.limits.seoTitle && payload.seo_title ? `- seo_title nejvýš ${s.limits.seoTitle} znaků` : '',
    s.limits.seoDesc && payload.seo_desc ? `- seo_desc nejvýš ${s.limits.seoDesc} znaků` : '',
    consistency,
    memory,
    maskHint([{ masks }]),
    nearHint([{ near: prepared.near }])
  ].filter(Boolean).join('\n');

  try {
    /*
     * Dlouhý popis se posílá zvlášť.
     *
     * Strop odpovědi je konečný a `long` má většinou dva tisíce znaků, ale
     * občas i třicet tisíc. Takový produkt se dřív nepřeložil **nikdy**:
     * odpověď se usekla, JSON nešel přečíst a chyba vypadala jako rozmar
     * modelu. Když se odhad nevejde do rozpočtu, jde nejdřív zbytek polí
     * a dlouhý popis pak sám za sebe.
     */
    const chars = Object.values(payload).reduce((sum, value) => sum + value.length, 0);
    if (estimate(chars) > OUTPUT_BUDGET && Object.keys(payload).length > 1) {
      const big = Object.entries(payload).sort((a, b) => b[1].length - a[1].length)[0][0];
      const rest = Object.fromEntries(Object.entries(payload).filter(([field]) => field !== big));
      let saved = prepared.reused;
      for (const piece of [rest, { [big]: payload[big] }]) {
        if (Object.keys(piece).length === 0) continue;
        const part = await translateOne(
          { ...target, fields: Object.keys(piece) }, signal
        );
        saved += part.saved;
        if (part.error) return { saved, error: part.error, noSource, reused: prepared.reused };
      }
      return { saved, noSource, reused: prepared.reused };
    }

    for (const field of wanted) activity.setField(target.code, target.lang, field, { status: 'waiting', written: 0 });
    // Pole uložená už během odpovědi — na konci se jen započítají
    const early = new Map<string, boolean>();
    const meter = measure(target.code, [target.lang], false,
      wanted.reduce((sum, field) => sum + workOf(payload[field]), 0), (_l, field) => masks[field],
      (_lang, field, raw) => {
        if (early.has(field) || !wanted.includes(field) || !raw.trim()) return;
        early.set(field, saveOne(target, field, raw, model, prepared));
      });
    const release = await gate(s.concurrency);
    let answer: string;
    try {
      answer = await ask(
      model,
      buildSystem(s, [target.lang]),
      `${hint}\n\nTexty k překladu:\n${JSON.stringify(payload, null, 1)}`,
      /*
       * Strop odpovědi s velkou rezervou. Strop se neplatí — platí se, co
       * model opravdu napíše — ale useknutá odpověď znamená opakování, a
       * to stojí minutu čekání. HTML značky a slovenská diakritika mají
       * víc tokenů na znak, než by odpovídalo délce textu.
       */
      Math.min(OUTPUT_MAX, Math.max(2000, Math.ceil(estimate(chars) * 2 * factor) + 1000)),
      { signal, onText: meter.onText, onWait: meter.onWait }
      );
    } finally {
      release();
    }
    meter.done();
    const translated = parseJson(answer);

    let saved = prepared.reused;
    let broken = 0;
    for (const field of wanted) {
      const raw = translated[field];
      if (typeof raw !== 'string' || !raw.trim()) continue;
      const ok = early.has(field) ? early.get(field)! : saveOne(target, field, raw, model, prepared);
      if (ok) saved++;
      else broken++;
    }

    // Adresa se odvodí z přeloženého názvu — kód to zvládne přesněji než model.
    // Zároveň se stará adresa uloží do přesměrování (301), aby odkazy na ni
    // nekončily na chybové stránce.
    if (s.fields.seo_url !== false) {
      const result = applySlug(target.code, target.lang, rows, model, translated.title ?? prepared.reusedTitle);
      if (result) saved += result.redirect ? 2 : 1;
    }
    if (broken) {
      return { saved, noSource, reused: prepared.reused,
        error: `${target.code} (${target.lang}): model nedodržel značky hotových odstavců — přeloží se znovu celé` };
    }
    return { saved, noSource, reused: prepared.reused };
  } catch (e: any) {
    /*
     * Useknutá odpověď se dá spravit, ne jen nahlásit.
     *
     * Odhad výstupu vychází z délky zdroje, jenže překlad bývá delší (a HTML
     * značky se do odhadu nepočítají). Když se odpověď usekne, jde se znovu:
     * nejdřív se rozdělí pole, a když je pole jediné, zvětší se strop.
     * Bez toho končil dlouhý popis hláškou, se kterou uživatel nic nesvede.
     */
    if (e?.truncated && Object.keys(payload).length > 1) {
      const big = Object.entries(payload).sort((a, b) => b[1].length - a[1].length)[0][0];
      let saved = prepared.reused;
      for (const fields of [Object.keys(payload).filter(one => one !== big), [big]]) {
        if (fields.length === 0) continue;
        const part = await runTranslate({ ...target, fields }, signal, factor);
        saved += part.saved;
        if (part.error) return { saved, error: part.error, noSource };
      }
      return { saved, noSource };
    }
    if (e?.truncated && factor < 3) {
      return runTranslate(target, signal, factor * 2);
    }
    /*
     * Jedno pole, které se nevejde ani s dvojnásobným stropem, se rozdělit
     * nedá — uvnitř je HTML a rozpůlit ho by znamenalo rozbít značky. Ať je
     * aspoň jasné, co s tím: zkrátit popis, nebo použít model s větším stropem.
     */
    if (e?.truncated && Object.keys(payload).length === 1) {
      const field = Object.keys(payload)[0];
      return {
        saved: prepared.reused,
        reused: prepared.reused,
        error: `${target.code} (${target.lang}): ${FIELD_LABELS[field] ?? field} má `
          + `${Object.values(payload)[0].length} znaků a překlad se nevejde do jedné odpovědi. `
          + `Zkrať text v e-shopu, nebo zvol model s vyšším stropem odpovědi.`
      };
    }
    return { saved: prepared.reused, reused: prepared.reused, error: `${target.code} (${target.lang}): ${e.message}` };
  }
}

/**
 * Adresa podle názvu v cílovém jazyce.
 *
 * Adresa se přepisuje podle **názvu**, ne podle svého vlastního stavu. Dřív
 * se odvozovala jen tehdy, když sama vyšla jako „čeká na překlad" — jenže
 * adresa může být v pořádku (nebo být ve všech jazycích stejná) a název se
 * přesto právě přeložil. Pak zůstala viset stará, česká adresa.
 *
 * Dvě pojistky:
 *  - **Musí být z čeho.** Když název v cílovém jazyce ještě přeložený není
 *    (ve feedu je pořád ten český), adresa se nechá být — jinak by se vyrobil
 *    český slug a k němu zbytečné přesměrování.
 *  - **Ruční úprava má přednost.** Kdo si adresu přepsal sám, ten ví proč;
 *    překlad mu ji nepřepíše.
 *
 * Vlastní zápis i doplnění 301 dělá `setSeoUrl` — je to jediné místo, kudy se
 * adresa mění, a přesměrování tak nemůže vynechat.
 */
export function applySlug(code: string, lang: string, rows: FieldRow[], model: string,
                          freshTitle?: string): { slug: string; redirect: string | null } | null {
  const urlRow = rows.find(row => row.field === 'seo_url');
  if (urlRow?.manual) return null;

  const titleRow = rows.find(row => row.field === 'title');
  const localized = freshTitle?.trim()
    || (titleRow && !NEEDS_WORK.includes(titleRow.state)
      ? (titleRow.translated || titleRow.value)
      : '');
  const slug = slugify(localized ?? '');
  if (!slug) return null;

  // Stejná adresa = není co měnit ani kam přesměrovávat
  const current = urlRow?.translated || urlRow?.value || '';
  if (slug === current.replace(/^\/+|\/+$/g, '').replace(/^p\//, '')) return null;

  return setSeoUrl(code, lang, slug, model);
}

/*
 * Kolik toho smí jít do jednoho dotazu.
 *
 * Popisy produktů nejsou stejně dlouhé: většina má kolem dvou tisíc znaků,
 * ale najdou se i třicetitisícové. Takový by narazil na strop odpovědi,
 * model by ji usekl uprostřed a z JSON by nezbylo nic použitelného — proto
 * se velký dotaz dělí po polích (viz `runTranslate`).
 */

/** Překlad bývá zhruba stejně dlouhý jako zdroj; čeština má ~2 znaky na token. */
const TOKENS_PER_CHAR = 0.5;

/** Kolik se smí sejít v jedné dávce. Držené nízko schválně: menší dotazy
 *  jsou rychlejší, míň narážejí na limit a jejich pád stojí míň práce. */
const OUTPUT_BUDGET = 7000;

/**
 * Nejvyšší strop pro jeden dotaz.
 *
 * Používá se tam, kde dávku dělit dál nejde — jedno pole s třicetitisícovým
 * popisem se rozpůlit nedá, aniž by se rozbilo HTML uvnitř. Novější modely
 * takovou odpověď zvládnou; když ne, sníží si `ask` strop sám.
 */
const OUTPUT_MAX = 32000;

const estimate = (chars: number) => Math.ceil(chars * TOKENS_PER_CHAR);

/**
 * Jeden produkt do všech jazyků — souběžnými dotazy.
 *
 * Nejdřív se uloží, co je celé v paměti; zbytek jde modelu po jazycích
 * a velkých polích naráz (viz níž). Každý dotaz má vlastní pokusy a
 * dělení; co nevyjde, se vrátí jako nehotový jazyk a běh ho zkusí znovu.
 *
 * Dřív šly všechny jazyky jedním dotazem kvůli úspoře vstupních tokenů.
 * Úspora byla malá a platila se časem: model píše jazyky po sobě.
 */
export async function translateProduct(code: string, targets: TranslateTarget[], signal?: AbortSignal):
  Promise<{ saved: number; errors: string[]; noSource: string[]; failed: string[]; reused: number }> {
  if (targets.length === 0) return { saved: 0, errors: [], noSource: [], failed: [], reused: 0 };

  const s = getPtransSettings();
  const model = s.model || getSettings().draftModel;

  // Zadání po jazycích. Zdroj je pro všechny stejný, ale která pole se
  // překládají, se mezi jazyky liší — jeden trh může mít hotovo víc.
  const payload: Record<string, Record<string, string>> = {};
  const rowsByLang = new Map<string, FieldRow[]>();
  const byLangTarget = new Map<string, TranslateTarget>();
  const prepared = new Map<string, Prepared>();
  const noSource: string[] = [];
  let reused = 0;
  let saved = 0;
  // Značky se v jednom dotazu nesmějí opakovat ani mezi jazyky
  const slot = { next: 1 };
  for (const target of targets) {
    const rows = productFields(code, [target.lang]);
    rowsByLang.set(target.lang, rows);
    const ready = prepare(target, rows, model, slot);
    prepared.set(target.lang, ready);
    noSource.push(...ready.noSource);
    reused += ready.reused;
    saved += ready.reused;
    // Co se vzalo z paměti, se už nepřekládá — ani v náhradním dotazu po jednom
    byLangTarget.set(target.lang, { ...target, fields: Object.keys(ready.payload) });
    if (Object.keys(ready.payload).length) payload[target.lang] = ready.payload;
    else if (ready.reusedTitle && s.fields.seo_url !== false) {
      const result = applySlug(code, target.lang, rows, REUSE_MODEL, ready.reusedTitle);
      if (result) saved += result.redirect ? 2 : 1;
    }
  }
  const langs = Object.keys(payload);
  if (langs.length === 0) return { saved, errors: [], noSource, failed: [], reused };

  const errors: string[] = [];
  /*
   * Které trhy to opravdu neprošly.
   *
   * Dřív se hlásila chyba za celý produkt: když slovenština vyšla a
   * angličtina ne, šly do opakování **obě**. Slovenština se tím přeložila
   * podruhé — zbytečné volání navíc přesně ve chvíli, kdy je API přetížené,
   * takže se tím pravděpodobnost dalšího pádu ještě zvyšovala. A v souhrnu
   * to vypadalo na dvojnásobek chyb, než kolik jich doopravdy bylo.
   */
  const failed: string[] = [];

  /*
   * Jazyky a velká pole **souběžně**, ne po sobě.
   *
   * Překlad trvá tak dlouho, jak dlouho model píše — a jeden dotaz píše
   * jedno pole po druhém. Dřív šla slovenština i angličtina jedním dotazem,
   * takže se na angličtinu čekalo, až model dopíše celou slovenštinu
   * (u kapesníčku KAPJL03 přes tři minuty). Teď má každý jazyk vlastní
   * dotaz a dlouhý popis a popis pro Google každý svůj; běží naráz a
   * produkt je hotový, když doběhne ten nejdelší. Platí se víc vstupu
   * (pravidla a nápovědy jdou s každým dotazem), kvalita je stejná —
   * každé pole dostane stejné zadání jako dřív.
   */
  const jobs: { lang: string; target: TranslateTarget }[] = [];
  for (const lang of langs) {
    const target = byLangTarget.get(lang)!;
    for (const fields of splitJobs(payload[lang])) jobs.push({ lang, target: { ...target, fields } });
  }
  const results = await Promise.all(jobs.map(job => translateOne(job.target, signal).catch(e => {
    if (isAborted(e)) throw e;
    return { saved: 0, reused: 0, error: `${code} (${job.lang}): ${e?.message ?? e}` } as
      { saved: number; reused?: number; error?: string };
  })));
  results.forEach((one, i) => {
    saved += one.saved;
    reused += one.reused ?? 0;
    if (one.error) {
      errors.push(one.error);
      if (!failed.includes(jobs[i].lang)) failed.push(jobs[i].lang);
    }
  });

  return { saved, errors: errors.slice(0, 4), noSource, failed, reused };
}

/**
 * Rozdělí pole jednoho jazyka do souběžných dotazů.
 *
 * Velká pole (dlouhý popis, popis pro Google) jdou každé samo; krátká
 * (název, SEO, krátký popis) spolu — u nich je víc čekání na odpověď než
 * psaní a název s SEO titulkem mají znít stejně.
 */
const OWN_JOB_FROM = 700;

function splitJobs(payload: Record<string, string>): string[][] {
  const big: string[][] = [];
  const rest: string[] = [];
  for (const [field, text] of Object.entries(payload)) {
    if (workOf(text) >= OWN_JOB_FROM) big.push([field]);
    else rest.push(field);
  }
  return rest.length ? [rest, ...big] : big;
}

/* ---------- odhad práce ---------- */

export interface WorkEstimate {
  code: string;
  /** Kolik znaků textu napíše model */
  chars: number;
  /** Kolik polí se překládá */
  fields: number;
  /** Kolik z nich se vezme celých z paměti, bez modelu */
  memory: number;
  /**
   * Nejdelší ze souběžných dotazů — produkt je hotový, až doběhne ten.
   * Na tomhle se počítá čas, ne na součtu.
   */
  longest: number;
}

/**
 * Kolik práce čeká — po produktech, v znacích, které napíše model.
 *
 * Počítá se s pamětí odstavců: co je celé známé, model nepíše vůbec, a
 * známé odstavce se nepočítají. Proto odhad u sourozenců, kteří se liší
 * barvou, neslibuje minuty za text, který se jen dosadí.
 */
export function estimateWork(codes: string[], langs: string[],
                             options: { force?: boolean; fields?: string[] } = {}): WorkEstimate[] {
  const out: WorkEstimate[] = [];
  for (const code of codes) {
    const one: WorkEstimate = { code, chars: 0, fields: 0, memory: 0, longest: 0 };
    for (const target of planWork([code], langs, options)) {
      const rows = productFields(code, [target.lang]);
      const work: Record<string, string> = {};
      for (const field of target.fields ?? []) {
        if (DERIVED_FIELDS.has(field)) continue;
        const source = rows.find(r => r.field === field)?.source ?? '';
        if (!source.trim()) continue;
        one.fields++;
        const text = forModel(field, source);
        const known = options.force ? null : quickLookup(target.lang, field, text);
        if (known?.full !== undefined) { one.memory++; continue; }
        work[field] = known?.masked ?? text;
        one.chars += workOf(work[field]);
      }
      // Stejné dělení jako při překladu: každý dotaz zvlášť, rozhoduje nejdelší
      for (const fields of splitJobs(work)) {
        one.longest = Math.max(one.longest, fields.reduce((sum, field) => sum + workOf(work[field]), 0));
      }
    }
    if (one.fields) out.push(one);
  }
  return out;
}

/** Odhad pro dialog spuštění: kolik toho je a jak dlouho to potrvá. */
export function estimateRun(codes: string[], langs: string[], options: { force?: boolean } = {}) {
  const s = getPtransSettings();
  // Paměť se tady neučí — to by u velkého katalogu zdrželo otevření dialogu.
  // Naučí se na začátku běhu (bez zamrznutí okna); odhad počítá s tím, co zná.
  const work = estimateWork(codes, langs, options);
  const speed = s.speed ?? DEFAULT_SPEED;
  const lanes = Math.max(1, Math.min(8, s.concurrency));
  return {
    products: work.length,
    fields: work.reduce((sum, one) => sum + one.fields, 0),
    memory: work.reduce((sum, one) => sum + one.memory, 0),
    chars: work.reduce((sum, one) => sum + one.chars, 0),
    seconds: Math.round(simulate(work.map(one => one.longest), speed, lanes)),
    speed,
    lanes
  };
}

/* ---------- dávkový běh ---------- */

export interface RunInput {
  codes: string[];
  langs?: string[];
  fields?: string[];
  force?: boolean;
  /**
   * Před překladem doplnit texty, které chybí ve **zdrojovém** jazyce.
   *
   * Bez toho se nedá přeložit něco, co v češtině neexistuje — a v každé
   * jazykové mutaci pak chybí totéž. Proto je to volba překladu, ne
   * samostatná akce: pořadí (nejdřív zdroj, pak překlad) je to podstatné.
   */
  fillSource?: boolean;
  /** Která zdrojová pole doplnit; prázdné = všechna, která jde */
  sourceFields?: SourceField[];
  /** Přepsat i zdrojové texty, které už existují */
  forceSource?: boolean;
}

export interface RunResult {
  done: number;
  failed: number;
  seconds: number;
  errors: string[];
  cancelled: boolean;
  /**
   * Kolik polí se nepřeložilo proto, že chybí text ve zdrojovém jazyce.
   *
   * Není to chyba běhu, ale ani úspěch: běh doběhne a v seznamu se nic
   * nezmění. Bez tohohle čísla to vypadá, že překlad nefunguje.
   */
  noSource: number;
  /** Kterých polí se to týká — do hlášky „doplň nejdřív české texty" */
  noSourceFields: string[];
  /** Kolik popisů se cestou uklidilo (balast v HTML) — jen pro hlášku */
  tidied: number;
  /** Co po běhu opravdu zbylo nehotové — „PSSK120SZ3 (EN)" */
  stuck: string[];
  /** Kolik polí mělo český text, o kterém cílové jazyky nevěděly */
  aligned: number;
  /** Kolik polí se přeložilo z paměti odstavců, bez modelu */
  reused: number;
}

/**
 * Přeloží vybrané produkty. Průběh chodí do rozhraní událostí `ptrans:progress`,
 * takže je vidět, co se právě děje a kolik zhruba zbývá.
 */export async function run(input: RunInput): Promise<RunResult> {
  if (current?.running) throw new Error('Překlad už běží.');
  const s = getPtransSettings();
  const langs = input.langs?.length ? input.langs : targetLangs(s);

  /*
   * Úklid popisů ještě před sestavením plánu.
   *
   * Nestojí to nic (žádné volání modelu, jen přepis textu) a zbytek běhu je
   * díky tomu levnější i spolehlivější: z popisů zmizí obal cizí stránky,
   * který tvoří třetinu znaků, a nejdelší popisy se přestanou lámat o strop
   * odpovědi. Text se přitom nezmění ani o písmeno.
   */
  const tidied = tidyProducts(input.codes);

  /*
   * Srovnání zdrojů ještě před plánem.
   *
   * Český text může existovat, aniž o něm cílové jazyky vědí — vznikl
   * v aplikaci a v e-shopu zatím není, nebo se pole zapnulo v nastavení až
   * po posledním načtení feedu. Navenek to vypadá nesmyslně: doplnění hlásí
   * „kompletní" a překlad „chybí zdroj", a další běh s tím nehne. Zkopírovat
   * to, co už máme, nestojí nic — tak ať se to udělá samo.
   */
  const aligned = alignSources(input.codes);

  // Než se začne překládat, mrkne se do paměti. Když je prázdná, vytáhne se
  // teď — z produktů, které jsou ve feedu přeložené, se dá slovosled i
  // názvosloví přečíst za pár vteřin a zbytek běhu se toho drží. Bez toho by
  // první velký překlad vznikl bez jakéhokoli vzoru.
  if (memoryStats().every(row => row.terms === 0)) {
    try { learnFromFeed(langs); } catch { /* paměť je pomůcka, ne podmínka */ }
  }
  /*
   * Paměť odstavců se poprvé naplní z toho, co už přeložené je — jednou,
   * napoprvé. Dál se plní sama každým překladem.
   */
  try { await learnFromStore(langs, s.sourceLang); } catch { /* pomůcka, ne podmínka */ }

  /*
   * Práce se vede po produktech, ne po dvojicích produkt–jazyk.
   *
   * U každého produktu se projde celý řetěz: doplnit, co chybí v češtině →
   * dopočítat číselníky → přeložit do všech trhů → **ověřit, že nezbylo nic
   * nehotového**. Teprve pak se jde na další. Ověření je to podstatné: běh
   * se neřídí tím, jestli volání vrátilo chybu, ale tím, co po něm zůstalo
   * v databázi. Co nesedí, zkusí se u téhož produktu znovu, klidněji.
   */
  const plan = new Map<string, { source: SourceTarget[]; work: TranslateTarget[] }>();
  const sourceFor = (code: string) => (input.fillSource
    ? planSourceFill({ codes: [code], fields: input.sourceFields, force: input.forceSource })
    : []);
  for (const code of input.codes) {
    const work = planWork([code], langs, { force: input.force, fields: input.fields });
    const source = sourceFor(code);
    if (work.length || source.length) plan.set(code, { source, work });
  }

  /*
   * Kolik toho model napíše, po produktech. Z toho je pruh i odhad času:
   * počítá se v znacích textu, ne v produktech — popis o třiceti tisících
   * znacích trvá jinak dlouho než název.
   */
  const plannedChars = new Map<string, number>();
  const plannedFields = new Map<string, number>();
  const plannedLongest = new Map<string, number>();
  for (const one of estimateWork([...plan.keys()], langs, { force: input.force, fields: input.fields })) {
    plannedChars.set(one.code, one.chars);
    plannedLongest.set(one.code, one.longest);
    plannedFields.set(one.code, one.fields);
  }

  cancelled = false;
  abort = new AbortController();
  speedNow = { ...(s.speed ?? DEFAULT_SPEED) };
  // Změna stavu pole (hotovo, z paměti) jde do okna hned — nanejvýš jednou za 150 ms
  let soon: ReturnType<typeof setTimeout> | null = null;
  activity.begin(() => {
    if (soon) return;
    soon = setTimeout(() => { soon = null; if (current?.running) publish(); }, 150);
  });
  const started = Date.now();
  const errors: string[] = [];
  const noSourceFields: string[] = [];
  let done = 0;
  let failed = 0;
  let noSource = 0;
  let reused = 0;
  let total = [...plan.values()].reduce((sum, item) => sum + item.source.length + item.work.length, 0);

  /*
   * Kolik dotazů běží naráz se za chodu přizpůsobuje.
   *
   * Pevné číslo je vždycky špatně: nízké zbytečně zdržuje, vysoké narazí na
   * limit a část práce spadne. Když server ohlásí přetížení, počet se srazí
   * na polovinu a chvíli se počká; když to zase chvíli šlape, pomalu se
   * vrací nahoru. Ubírat rychle, přidávat opatrně — opačně by se limit
   * cyklicky přejížděl.
   */
  const maxLanes = Math.max(1, Math.min(8, s.concurrency));
  /*
   * Začíná se jedním. Rychlost je až druhá věc.
   *
   * Dřív se startovalo naplno a počet se srážel, teprve když něco spadlo —
   * takže se na limit spolehlivě narazilo hned na začátku každého běhu a
   * první produkty to odnesly. Teď se jede produkt po produktu a přidá se
   * až poté, co tři produkty po sobě proběhne bez zádrhelu. Nastavení
   * „souběžných překladů" je od téhle chvíle strop, ne výchozí tempo.
   */
  let lanes = 1;
  let goodRun = 0;

  const queue = [...plan.entries()];
  let doneChars = 0;
  let productsDone = 0;
  let fieldsDone = 0;
  const fieldsTotal = () => [...plannedFields.values()].reduce((a, b) => a + b, 0);

  /**
   * Stav pro rozhraní.
   *
   * Pruh = napsané znaky / všechny znaky, které napsat zbývá. Odhad času =
   * u rozjetých produktů zbytek textu a čekání (na první slovo, na volné
   * místo u API), u čekajících čekání + text, děleno počtem souběžných.
   */
  const publish = (label?: string) => {
    const live = activity.snapshot();
    let activeExpected = 0;
    let activeWritten = 0;
    let activeSeconds = 0;
    let activeFields = 0;
    const now = Date.now();
    for (const one of live) {
      const expected = one.fields.length
        ? one.fields.reduce((sum, f) => sum + (f.status === 'memory' ? 0 : f.expected), 0)
        : (plannedChars.get(one.code) ?? 0);
      const written = activity.writtenIn(one.code);
      activeExpected += expected;
      activeWritten += written;
      activeFields += one.fields.filter(f => f.status === 'done' || f.status === 'memory').length;
      const waiting = one.phase === 'limit' || one.phase === 'retry'
        ? Math.max(0, ((one.until ?? now) - now) / 1000)
        : one.phase === 'writing' || one.phase === 'saving' ? 0
          : Math.max(0, speedNow.wait - (now - one.since) / 1000);
      /*
       * Pole se píšou souběžně (po jazycích a velkých polích), takže zbývá
       * tolik, kolik zbývá nejdelšímu z nich — ne součet.
       */
      const left = one.fields.length
        ? Math.max(0, ...one.fields.filter(f => f.status !== 'done' && f.status !== 'memory')
          .map(f => Math.max(0, f.expected - (f.status === 'writing' ? f.written : 0))))
        : (plannedLongest.get(one.code) ?? 0);
      activeSeconds = Math.max(activeSeconds, waiting + left / speedNow.cps);
    }
    let queuedChars = 0;
    let queuedSeconds = 0;
    for (const [code] of queue) {
      queuedChars += plannedChars.get(code) ?? 0;
      const longest = plannedLongest.get(code) ?? 0;
      queuedSeconds += longest > 0 ? speedNow.wait + longest / speedNow.cps : 0.2;
    }
    const allChars = doneChars + activeExpected + queuedChars;
    const soFar = doneChars + activeWritten;
    current = {
      running: true,
      done,
      total,
      failed,
      bar: allChars > 0 ? Math.min(0.999, soFar / allChars) : 0,
      // Rozpracované běží souběžně (rozhoduje nejpomalejší), čekající se rozdělí mezi pruhy
      etaSeconds: Math.round(activeSeconds + queuedSeconds / Math.max(1, lanes)),
      secondsPerUnit: s.secondsPerUnit,
      label: label ?? current?.label ?? '',
      errors: errors.slice(-5),
      products: { done: productsDone, total: plan.size },
      /*
       * Počet polí u rozpracovaného produktu bere to, co se opravdu překládá.
       * Odhad před během nevidí pole, která dostanou český text až během
       * doplnění (SEO, Google) — a hlásilo se pak „7 z 6 polí".
       */
      fields: { done: fieldsDone + activeFields,
        total: fieldsTotal() + live.reduce((sum, one) =>
          sum + Math.max(0, one.fields.length - (plannedFields.get(one.code) ?? 0)), 0) },
      current: live,
      speed: { wait: Number(speedNow.wait.toFixed(1)), cps: Math.round(speedNow.cps) },
      lanes
    };
    emit('ptrans:progress', current);
  };

  publish('');
  const ticker = setInterval(() => { if (current?.running) publish(); }, 500);

  const runId = (getDb().prepare(
    'INSERT INTO ptrans_runs (started_at, total, note) VALUES (?,?,?)'
  ).run(new Date().toISOString(), total, langs.join(',')) as any).lastInsertRowid;

  /** Kolik pokusů dostane jeden produkt, než se to vzdá. */
  const ATTEMPTS = 4;

  /** Jeden produkt od začátku do konce — a s ověřením, že opravdu do konce. */
  /** Kolik polí šlo u kterého produktu z paměti — do hlášky o hotovém produktu. */
  const reusedBy = new Map<string, number>();

  const oneProduct = async (code: string, item: { source: SourceTarget[]; work: TranslateTarget[] }) => {
    /* ---------- 1) čeština: co chybí, se dopíše ---------- */
    /*
     * Naráz, ne po jednom. SEO titulek, SEO popis a texty pro Google na
     * sobě nezávisí, a po jednom to u KAPJL03 trvalo dvacet vteřin, než
     * se vůbec začalo překládat.
     */
    if (item.source.length && !cancelled) {
      const names = item.source.map(target => SOURCE_LABELS[target.field] ?? target.field).join(', ');
      const note = `doplňuji ${s.sourceLang.toUpperCase()}: ${names}`;
      activity.setPhase(code, 'source', note);
      publish(`${code} — ${note}`);
      const results = await Promise.all(item.source.map(target => fillSourceOne(code, target.field, abort?.signal)));
      for (const result of results) {
        done++;
        // Přerušené volání není chyba — po zastavení by se jen sypaly hlášky
        if (result.error && !isAborted(result)) { failed++; errors.push(result.error); }
      }
      publish();
    }

    /*
     * Číselníky pro Google (barva, pohlaví, věk, stav, set, čárový kód).
     * Počítají se z parametrů a kategorií, model se nevolá — je to zadarmo
     * a bez nich Google nabídku potlačí. Proto se to dělá vždycky, ne jen
     * když si někdo vzpomene na tlačítko.
     */
    if (!cancelled) {
      try { applyAttributes([code], langs); } catch { /* nepodstatné pro překlad */ }
    }

    /* ---------- 2) překlad, dokud nezbývá nic ---------- */
    for (let attempt = 1; attempt <= ATTEMPTS && !cancelled; attempt++) {
      /*
       * Co zbývá, se čte z databáze — ne z toho, co vrátilo minulé volání.
       *
       * I napoprvé: plán vznikl před doplněním českých textů, takže pole,
       * které právě dostalo český originál, v něm ještě není. Bez tohohle
       * by se doplnilo v češtině a přeložilo se až o kolo později.
       */
      const targets = attempt === 1
        ? planWork([code], langs, { force: input.force, fields: input.fields })
        : withSource(planWork([code], langs, { fields: input.fields }));
      if (attempt === 1 && targets.length !== item.work.length) {
        total += targets.length - item.work.length;
      }
      if (targets.length === 0) break;

      if (attempt > 1) {
        // Další pokus je klidnější: přetížené API potřebuje čas, ne spěch
        publish(`${code} — ${attempt - 1}. opakování`);
        /*
         * Jak dlouho čekat, rozhoduje příčina, ne počítadlo pokusů.
         *
         * Když API opravdu hlásilo limit, má smysl počkat dlouho — vteřiny
         * navíc jsou levnější než další zamítnutý dotaz. Když šlo o něco
         * jiného (usekaná odpověď, chyba v JSON), dlouhé čekání nic nespraví
         * a jen prodlužuje běh.
         */
        const pause = 600 * attempt + (rateLimitedRecently() ? 6000 * attempt : 0);
        activity.setPhase(code, 'retry',
          rateLimitedRecently() ? `API je přetížené — ${attempt}. pokus` : `${attempt}. pokus`, Date.now() + pause);
        publish();
        await new Promise(resolve => setTimeout(resolve, pause));
        if (cancelled) break;
      }

      publish(`${code} → ${targets.map(t => labelOf(t.lang, s)).join(', ')}`
        + (attempt > 1 ? ` (${attempt}. pokus)` : ''));

      const result = await translateProduct(code, targets, abort?.signal).catch(e => {
        if (isAborted(e)) return { saved: 0, errors: [], noSource: [], failed: [], reused: 0 };
        return {
          saved: 0, errors: [`${code}: ${e.message}`], noSource: [],
          failed: targets.map(t => t.lang), reused: 0
        };
      });
      reused += result.reused;
      reusedBy.set(code, (reusedBy.get(code) ?? 0) + result.reused);
      if (attempt === 1) done += targets.length;

      for (const field of result.noSource) {
        noSource++;
        if (!noSourceFields.includes(field)) noSourceFields.push(field);
      }

      if (result.failed.length) {
        goodRun = 0;
        if (rateLimitedRecently()) lanes = Math.max(1, Math.floor(lanes / 2));
      /*
       * Přidává se po třech produktech bez zádrhelu, ne po osmi. S osmi se
       * u běžné dávky (dvacet, třicet produktů) druhý pruh rozjel až
       * v poslední třetině a nastavení souběžnosti skoro nic neznamenalo.
       * Při prvním náznaku limitu se pořád ubírá na polovinu.
       */
      } else if (++goodRun >= 3 && lanes < maxLanes && !rateLimitedRecently()) {
        lanes++;
        goodRun = 0;
      }

      /*
       * Poslední slovo má databáze.
       *
       * Volání mohlo vrátit chybu a přesto být hotovo (odpověď došla, jen
       * se cestou něco pokazilo), a stejně tak mohlo projít a část polí
       * nechat nedotčenou. Rozhoduje proto stav polí, ne návratová hodnota
       * — jinak se hlásí chyby u produktů, které jsou ve skutečnosti
       * přeložené.
       */
      const left = withSource(planWork([code], langs, { fields: input.fields }));
      if (left.length === 0) return true;

      // Když se poslední pokus nikam nepohnul a nejde o přetížení, další
      // kolo to nespraví — příčina je jinde (chybí zdroj, moc dlouhý text)
      if (result.saved === 0 && result.failed.length === 0 && !rateLimitedRecently()) {
        if (result.errors.length) errors.push(...result.errors);
        return false;
      }
      if (attempt === ATTEMPTS && result.errors.length) errors.push(...result.errors);
    }

    return withSource(planWork([code], langs, { fields: input.fields })).length === 0;
  };

  /*
   * Sourozenci po sobě, ne naráz.
   *
   * Kapesníček KAPJL03 může vzít odstavce z KAPJL02P jen tehdy, když je
   * KAPJL02P už přeložený. Kdyby šly vedle sebe ve dvou pruzích, nemá
   * druhý z čeho brát a oba se platí celé. Rodina = kategorie a písmena
   * na začátku kódu (KAPJL…, PSSK…) — tak jsou kódy v e-shopu stavěné.
   * Pruh si vezme první produkt, jehož rodina se zrovna nepřekládá.
   */
  const familyOf = (code: string) => `${(getDb().prepare('SELECT category FROM ptrans_products WHERE code = ?')
    .get(code) as { category: string } | undefined)?.category ?? ''}|${(/^[A-Za-z]+/.exec(code)?.[0] ?? code).toUpperCase()}`;
  const busyFamilies = new Set<string>();

  const workers = Array.from({ length: maxLanes }, async (_unused, lane) => {
    while (queue.length > 0 && !cancelled) {
      // Přebytečné pruhy počkají, dokud se limit neuvolní
      if (lane >= lanes) {
        // Krátce: jakmile se pruh uvolní, má se hned rozjet
        await new Promise(resolve => setTimeout(resolve, 300));
        continue;
      }
      const pick = queue.findIndex(([one]) => !busyFamilies.has(familyOf(one)));
      if (pick < 0) {
        // Zbývají jen sourozenci rozpracovaných — počká se, až jeden doběhne
        await new Promise(resolve => setTimeout(resolve, 300));
        continue;
      }
      const [code, item] = queue.splice(pick, 1)[0];
      const family = familyOf(code);
      busyFamilies.add(family);
      const title = (getDb().prepare('SELECT title FROM ptrans_products WHERE code = ?').get(code) as
        { title: string } | undefined)?.title ?? code;
      activity.startProduct(code, title);
      publish();
      const ok = await oneProduct(code, item).finally(() => busyFamilies.delete(family));
      const finished = activity.finishProduct(code);
      const fields = finished?.fields ?? [];
      // Co se nepovedlo, se v hlášení ukáže jako nehotové — i když to model rozepsal
      for (const one of fields) if (one.status !== 'done' && one.status !== 'memory') one.status = 'failed';
      doneChars += fields.reduce((sum, f) => sum + (f.status === 'memory' ? 0 : f.expected), 0)
        || (plannedChars.get(code) ?? 0);
      plannedChars.delete(code);
      const counted = fields.length || plannedFields.get(code) || 0;
      plannedFields.set(code, counted);
      fieldsDone += fields.filter(f => f.status === 'done' || f.status === 'memory').length;
      productsDone++;
      publish();
      /*
       * Hotový produkt se ohlásí hned, ne až po celém běhu — seznam si
       * obnoví jeho stav a náhled ukáže, co je hotové. U dávky o stovce
       * produktů se jinak deset minut nedělo nic vidět.
       */
      emit('ptrans:product', {
        code, title, ok: !!ok, reused: reusedBy.get(code) ?? 0,
        sentences: fields.reduce((sum, f) => sum + (f.fromMemory ?? 0), 0),
        patterned: fields.reduce((sum, f) => sum + (f.patterned ?? 0), 0),
        memory: fields.filter(f => f.status === 'memory').length,
        failed: fields.filter(f => f.status === 'failed').map(f => `${f.lang}:${f.field}`)
      });
    }
  });
  await Promise.all(workers);

  clearInterval(ticker);

  /*
   * Kolik toho opravdu zbylo.
   *
   * Nepočítá se, kolikrát něco spadlo — počítá se, co po běhu chybí. Pokus,
   * který napoprvé selhal a napodruhé prošel, není chyba, a hlásit ho jako
   * chybu je horší než mlčet: přesně kvůli tomu to vypadalo, že překlad
   * nefunguje, i když nakonec doběhl celý.
   */
  const leftover = cancelled
    ? []
    : withSource(planWork(input.codes, langs, { fields: input.fields }));
  failed = leftover.length;
  const stuck = new Set(leftover.map(target => `${target.code} (${target.lang})`));
  const finalErrors = errors.filter(text => [...stuck].some(key => text.startsWith(key.split(' ')[0])));

  const seconds = (Date.now() - started) / 1000;
  // Naměřená rychlost se pamatuje, aby byl odhad rozumný hned na začátku příště
  if (done > 0) savePtransSettings({ speed: { wait: Number(speedNow.wait.toFixed(2)), cps: Math.round(speedNow.cps) } });
  if (soon) clearTimeout(soon);
  activity.end();
  getDb().prepare('UPDATE ptrans_runs SET finished_at = ?, done = ?, failed = ?, seconds = ? WHERE id = ?')
    .run(new Date().toISOString(), done, failed, seconds, runId);

  current = { ...current!, running: false, done, total, failed, bar: 1, etaSeconds: 0, label: '',
    errors: finalErrors.slice(-5), current: [] };
  emit('ptrans:progress', current);
  emit('ptrans:changed', {});

  return {
    done, failed, seconds, cancelled,
    errors: (finalErrors.length ? finalErrors : errors).slice(0, 20),
    noSource,
    noSourceFields: noSourceFields.map(field => FIELD_LABELS[field] ?? field),
    tidied: tidied.fields,
    aligned,
    reused,
    stuck: leftover.map(target => `${target.code} (${target.lang.toUpperCase()})`).slice(0, 20)
  };
}
