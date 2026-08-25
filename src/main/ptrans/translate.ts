import { BrowserWindow } from 'electron';
import { ask } from '../ai';
import { getSettings } from '../settings';
import { getDb } from '../db';
import { getPtransSettings, savePtransSettings, productFields, saveTranslation, targetLangs,
  PtransSettings, FieldRow } from './store';
import { HTML_FIELDS, DERIVED_FIELDS } from './xml';
import { NEEDS_WORK, plain, clamp } from './detect';
import { languageNote } from './style';
import { consistencyHint } from './consistency';
import { setSeoUrl } from './redirects';
import { memoryHint, memoryStats, learnFromFeed } from './memory';
import { planSourceFill, fillSourceOne, SourceField } from './source';

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

/* ---------- odhad zbývajícího času ---------- */

/**
 * Odhad se počítá z **naměřených** časů, ne z konstanty: prvních pár překladů
 * jede podle zapamatované rychlosti z minula, pak už se řídí tím, co se právě
 * děje. Klouzavý průměr přes posledních deset měření drží odhad stabilní,
 * i když jeden produkt trvá výrazně dýl.
 */
class Speed {
  private samples: number[] = [];
  constructor(private fallback: number) {}

  add(seconds: number): void {
    this.samples.push(seconds);
    if (this.samples.length > 10) this.samples.shift();
  }

  get perUnit(): number {
    if (this.samples.length === 0) return this.fallback;
    const sum = this.samples.reduce((a, b) => a + b, 0);
    return sum / this.samples.length;
  }

  eta(remaining: number, concurrency: number): number {
    return Math.round((remaining * this.perUnit) / Math.max(1, concurrency));
  }
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
const FIELD_LABELS: Record<string, string> = {
  title: 'název produktu (krátký, bez HTML)',
  short: 'krátký popis (HTML)',
  long: 'dlouhý popis (HTML)',
  seo_title: 'SEO titulek pro vyhledávače',
  seo_desc: 'SEO meta popis',
  google_title: 'název pro Google Nákupy',
  google_desc: 'popis pro Google Nákupy'
};

function buildSystem(s: PtransSettings, targetLang: string): string {
  const brand = getSettings().brandPrompt?.trim();
  const glossary = s.glossary
    .filter(entry => entry.targets[targetLang])
    .map(entry => `- „${entry.source}" → „${entry.targets[targetLang]}"`)
    .join('\n');

  return [
    `Jsi profesionální překladatel produktových textů pro e-shop s módními doplňky.`,
    `Překládáš z jazyka „${s.sourceLang}" do jazyka „${targetLang}".`,
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
    // Psaní velkých písmen se mezi jazyky liší a model má sklon přenést
    // zvyk zdrojového jazyka. V názvech je to hned vidět.
    languageNote(targetLang),
    glossary ? `\nZávazné názvosloví:\n${glossary}` : '',
    brand ? `\nO značce (pro tón textu):\n${brand}` : '',
    s.prompt.trim() ? `\nVlastní pokyny:\n${s.prompt.trim()}` : '',
    '',
    'Odpověz POUZE JSON objektem se stejnými klíči, jaké dostaneš na vstupu. Žádný jiný text.'
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

/**
 * Přeloží jeden produkt do jednoho jazyka.
 *
 * Vrací, kolik polí se opravdu uložilo. Chyba se nevyhazuje výš — jeden
 * nepovedený produkt nesmí zastavit dávku o tisíci kusech.
 */
export async function translateOne(target: TranslateTarget,
                                   signal?: AbortSignal): Promise<{ saved: number; error?: string }> {
  const s = getPtransSettings();
  const model = s.model || getSettings().draftModel;
  const rows = productFields(target.code, [target.lang]);
  // Adresa a přesměrování se neposílají modelu — skládá je kód
  const wanted = (target.fields?.length ? target.fields : rows.map(r => r.field))
    .filter(field => !DERIVED_FIELDS.has(field));

  const payload: Record<string, string> = {};
  for (const field of wanted) {
    const row = rows.find(r => r.field === field);
    const source = row?.source ?? '';
    if (source.trim()) payload[field] = source;
  }
  if (Object.keys(payload).length === 0) return { saved: 0 };

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
    memory
  ].filter(Boolean).join('\n');

  try {
    const answer = await ask(
      model,
      buildSystem(s, target.lang),
      `${hint}\n\nTexty k překladu:\n${JSON.stringify(payload, null, 1)}`,
      Math.min(8000, 1200 + JSON.stringify(payload).length),
      { signal }
    );
    const translated = parseJson(answer);

    let saved = 0;
    for (const field of wanted) {
      let value = translated[field];
      if (typeof value !== 'string' || !value.trim()) continue;
      if (!HTML_FIELDS.has(field)) value = plain(value);
      if (field === 'seo_title') value = clamp(value, s.limits.seoTitle);
      if (field === 'seo_desc') value = clamp(value, s.limits.seoDesc);
      saveTranslation(target.code, target.lang, field, value, model);
      saved++;
    }

    // Adresa se odvodí z přeloženého názvu — kód to zvládne přesněji než model.
    // Zároveň se stará adresa uloží do přesměrování (301), aby odkazy na ni
    // nekončily na chybové stránce.
    if (s.fields.seo_url !== false) {
      const result = applySlug(target.code, target.lang, rows, model, translated.title);
      if (result) saved += result.redirect ? 2 : 1;
    }
    return { saved };
  } catch (e: any) {
    return { saved: 0, error: `${target.code} (${target.lang}): ${e.message}` };
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
}

/**
 * Přeloží vybrané produkty. Průběh chodí do rozhraní událostí `ptrans:progress`,
 * takže je vidět, co se právě děje a kolik zhruba zbývá.
 */
export async function run(input: RunInput): Promise<RunResult> {
  if (current?.running) throw new Error('Překlad už běží.');
  const s = getPtransSettings();
  const langs = input.langs?.length ? input.langs : targetLangs(s);
  const work = planWork(input.codes, langs, { force: input.force, fields: input.fields });

  // Než se začne překládat, mrkne se do paměti. Když je prázdná, vytáhne se
  // teď — z produktů, které jsou ve feedu přeložené, se dá slovosled i
  // názvosloví přečíst za pár vteřin a zbytek běhu se toho drží. Bez toho by
  // první velký překlad vznikl bez jakéhokoli vzoru.
  if (memoryStats().every(row => row.terms === 0)) {
    try { learnFromFeed(langs); } catch { /* paměť je pomůcka, ne podmínka */ }
  }

  cancelled = false;
  abort = new AbortController();
  const speed = new Speed(s.secondsPerUnit || 12);
  const started = Date.now();
  const errors: string[] = [];
  let done = 0;
  let failed = 0;
  // Celek běhu = doplnění zdroje + překlad. Drží se zvlášť, protože po
  // doplnění se plán překladu přepočítává a `work.length` se mění.
  let total = work.length;

  current = {
    running: true, done: 0, total, failed: 0,
    etaSeconds: work.length ? speed.eta(work.length, s.concurrency) : 0,
    secondsPerUnit: speed.perUnit, label: '', errors: []
  };
  emit('ptrans:progress', current);

  const runId = (getDb().prepare(
    'INSERT INTO ptrans_runs (started_at, total, note) VALUES (?,?,?)'
  ).run(new Date().toISOString(), work.length, langs.join(',')) as any).lastInsertRowid;

  /*
   * Nejdřív zdroj, pak překlad.
   *
   * Zdrojové texty se doplňují po jednom a sériově: je jich řádově míň než
   * překladů a každý z nich mění podklad pro všechny jazyky, takže se
   * nevyplatí to hnát paralelně a riskovat limit API.
   */
  const sourceWork = input.fillSource
    ? planSourceFill({ codes: input.codes, fields: input.sourceFields, force: input.forceSource })
    : [];

  if (sourceWork.length > 0) {
    total = work.length + sourceWork.length;
    current = { ...current, total };
    for (const target of sourceWork) {
      if (cancelled) break;
      current = {
        ...current,
        label: `${target.code} — doplňuji ${target.field} v ${s.sourceLang.toUpperCase()}`
      };
      emit('ptrans:progress', current);

      const at = Date.now();
      const result = await fillSourceOne(target.code, target.field, abort?.signal);
      speed.add((Date.now() - at) / 1000);
      done++;
      // Přerušené volání není chyba — po zastavení by se jen sypaly hlášky
      if (result.error && !isAborted(result)) { failed++; errors.push(result.error); }

      current = {
        ...current,
        done,
        failed,
        etaSeconds: speed.eta(total - done, s.concurrency),
        secondsPerUnit: speed.perUnit,
        errors: errors.slice(-5)
      };
      emit('ptrans:progress', current);
    }

    // Zdrojové texty se mezitím změnily, takže plán překladu se musí přepočítat
    // — jinak by se přeskočila právě ta pole, kvůli kterým se to dělalo
    if (!cancelled) {
      const refreshed = planWork(input.codes, langs, { force: input.force, fields: input.fields });
      work.length = 0;
      work.push(...refreshed);
      total = done + work.length;
      current = { ...current, total };
      emit('ptrans:progress', current);
    }
  }

  const queue = [...work];
  const workers = Array.from({ length: Math.max(1, Math.min(6, s.concurrency)) }, async () => {
    while (queue.length > 0 && !cancelled) {
      const target = queue.shift()!;
      const at = Date.now();
      const result = await translateOne(target, abort?.signal);
      speed.add((Date.now() - at) / 1000);

      done++;
      if (result.error && !isAborted(result)) {
        failed++;
        errors.push(result.error);
      }
      current = {
        running: true,
        done,
        total,
        failed,
        etaSeconds: speed.eta(total - done, s.concurrency),
        secondsPerUnit: Number(speed.perUnit.toFixed(1)),
        label: `${target.code} → ${labelOf(target.lang, s)}`,
        errors: errors.slice(-5)
      };
      emit('ptrans:progress', current);
    }
  });
  await Promise.all(workers);

  const seconds = (Date.now() - started) / 1000;
  // Naměřená rychlost se pamatuje, aby byl odhad rozumný hned na začátku příště
  if (done > 0) savePtransSettings({ secondsPerUnit: Number(speed.perUnit.toFixed(1)) });
  getDb().prepare('UPDATE ptrans_runs SET finished_at = ?, done = ?, failed = ?, seconds = ? WHERE id = ?')
    .run(new Date().toISOString(), done, failed, seconds, runId);

  current = { ...current!, running: false, etaSeconds: 0, label: '' };
  emit('ptrans:progress', current);
  emit('ptrans:changed', {});

  return { done, failed, seconds, errors: errors.slice(0, 20), cancelled };
}
