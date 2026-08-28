import { BrowserWindow } from 'electron';
import { ask, rateLimitedRecently } from '../ai';
import { getSettings } from '../settings';
import { getDb } from '../db';
import { getPtransSettings, savePtransSettings, productFields, saveTranslation, targetLangs,
  PtransSettings, FieldRow } from './store';
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
  /** Naplnění pruhu 0–1; počítá se i z rozjetých volání, aby se pruh hýbal */
  bar: number;
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

/**
 * Přeloží jeden produkt do jednoho jazyka.
 *
 * Vrací, kolik polí se opravdu uložilo. Chyba se nevyhazuje výš — jeden
 * nepovedený produkt nesmí zastavit dávku o tisíci kusech.
 */
export async function translateOne(target: TranslateTarget, signal?: AbortSignal):
  Promise<{ saved: number; error?: string; noSource?: string[] }> {
  const s = getPtransSettings();
  const model = s.model || getSettings().draftModel;
  const rows = productFields(target.code, [target.lang]);
  // Adresa a přesměrování se neposílají modelu — skládá je kód
  const wanted = (target.fields?.length ? target.fields : rows.map(r => r.field))
    .filter(field => !DERIVED_FIELDS.has(field));

  /*
   * Přeložit jde jen to, co ve zdrojovém jazyce existuje.
   *
   * Pole bez českého znění se do zadání pro model nedává — nemá co překládat.
   * Dřív se ale takové pole i tak započítalo jako hotový úkol a běh skončil
   * hláškou „hotovo, 0 chyb", i když se nezměnilo vůbec nic. Nejčastější
   * případ je chybějící český SEO titulek: v seznamu svítí „čeká na překlad",
   * překlad proběhne, a je to pořád stejné. Proto se to teď počítá a nahlásí.
   */
  const payload: Record<string, string> = {};
  const noSource: string[] = [];
  for (const field of wanted) {
    const row = rows.find(r => r.field === field);
    const source = row?.source ?? '';
    if (source.trim()) payload[field] = forModel(field, source);
    else noSource.push(field);
  }
  if (Object.keys(payload).length === 0) {
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
    memory
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
      let saved = 0;
      for (const piece of [rest, { [big]: payload[big] }]) {
        if (Object.keys(piece).length === 0) continue;
        const part = await translateOne(
          { ...target, fields: Object.keys(piece) }, signal
        );
        saved += part.saved;
        if (part.error) return { saved, error: part.error, noSource };
      }
      return { saved, noSource };
    }

    const answer = await ask(
      model,
      buildSystem(s, [target.lang]),
      `${hint}\n\nTexty k překladu:\n${JSON.stringify(payload, null, 1)}`,
      // Strop podle odhadu výstupu, ne podle délky vstupu: překlad je zhruba
      // stejně dlouhý jako zdroj, ale tokenů je zhruba poloviční počet znaků
      Math.min(OUTPUT_MAX, Math.ceil(estimate(chars) * 1.4) + 600),
      { signal }
    );
    const translated = parseJson(answer);

    let saved = 0;
    for (const field of wanted) {
      let value = translated[field];
      if (typeof value !== 'string' || !value.trim()) continue;
      value = fromModel(field, value);
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
    return { saved, noSource };
  } catch (e: any) {
    /*
     * Jedno pole, které se nevejde ani samo, se rozdělit nedá — uvnitř je
     * HTML a rozpůlit ho by znamenalo rozbít značky. Ať je aspoň jasné,
     * co s tím: zkrátit popis, nebo použít model s větším stropem.
     */
    if (e?.truncated && Object.keys(payload).length === 1) {
      const field = Object.keys(payload)[0];
      return {
        saved: 0,
        error: `${target.code} (${target.lang}): ${FIELD_LABELS[field] ?? field} má `
          + `${Object.values(payload)[0].length} znaků a překlad se nevejde do jedné odpovědi. `
          + `Zkrať text v e-shopu, nebo zvol model s vyšším stropem odpovědi.`
      };
    }
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

/*
 * Kolik toho smí jít do jednoho dotazu.
 *
 * Odpověď musí obsahovat překlad všech žádaných jazyků. Popisy produktů
 * nejsou stejně dlouhé: většina má kolem dvou tisíc znaků, ale najdou se
 * i třicetitisícové. U těch by tři jazyky v jednom dotazu narazily na strop
 * odpovědi, model by ji usekl uprostřed a z JSON by nezbylo nic použitelného.
 *
 * Dávka se proto skládá podle velikosti, ne podle počtu jazyků: běžný produkt
 * projde se všemi trhy v jednom dotazu, u dlouhého se jazyky rozdělí a
 * u opravdu obřího se rozdělí i pole. Rychlost se tím bere jen tam, kde by
 * jinak dotaz stejně spadl.
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

/** Kolik znaků nese zadání pro jeden jazyk. */
function payloadChars(part: Record<string, string>): number {
  return Object.values(part).reduce((sum, value) => sum + value.length, 0);
}

/**
 * Rozdělí jazyky do dávek tak, aby se odpověď na každou vešla do rozpočtu.
 * Jazyk, který se nevejde ani sám, dostane vlastní dávku — o dělení polí se
 * pak postará `translateOne`.
 */
function packLangs(langs: string[], charsOf: (lang: string) => number): string[][] {
  const out: string[][] = [];
  let batch: string[] = [];
  let sum = 0;
  for (const lang of langs) {
    const need = estimate(charsOf(lang));
    if (batch.length > 0 && sum + need > OUTPUT_BUDGET) {
      out.push(batch);
      batch = [];
      sum = 0;
    }
    batch.push(lang);
    sum += need;
  }
  if (batch.length) out.push(batch);
  return out;
}

/**
 * Jeden produkt do všech jazyků naráz.
 *
 * Dřív se pro každý jazyk posílal vlastní dotaz. Zdrojový text, pravidla
 * i názvosloví se tak posílaly znovu a znovu — u tří trhů trojnásobek
 * vstupních tokenů a trojnásobek příležitostí narazit na limit. A když
 * jeden z těch dotazů spadl, zůstal jeden trh nepřeložený, zatímco ostatní
 * prošly; zvenku to vypadalo, jako by aplikace jazyk přeskočila.
 *
 * Teď jde ven jeden dotaz. Když se nepovede nebo se v odpovědi některý
 * jazyk nevrátí, dotáhne se ten jazyk zvlášť — společný dotaz je zrychlení,
 * ne podmínka.
 */
export async function translateProduct(code: string, targets: TranslateTarget[], signal?: AbortSignal):
  Promise<{ saved: number; errors: string[]; noSource: string[]; failed: string[] }> {
  if (targets.length === 0) return { saved: 0, errors: [], noSource: [], failed: [] };

  const s = getPtransSettings();
  const model = s.model || getSettings().draftModel;

  // Zadání po jazycích. Zdroj je pro všechny stejný, ale která pole se
  // překládají, se mezi jazyky liší — jeden trh může mít hotovo víc.
  const payload: Record<string, Record<string, string>> = {};
  const rowsByLang = new Map<string, FieldRow[]>();
  const byLangTarget = new Map<string, TranslateTarget>();
  const noSource: string[] = [];
  for (const target of targets) {
    const rows = productFields(code, [target.lang]);
    rowsByLang.set(target.lang, rows);
    byLangTarget.set(target.lang, target);
    const wanted = (target.fields?.length ? target.fields : rows.map(r => r.field))
      .filter(field => !DERIVED_FIELDS.has(field));
    const part: Record<string, string> = {};
    for (const field of wanted) {
      const source = rows.find(r => r.field === field)?.source ?? '';
      if (source.trim()) part[field] = forModel(field, source);
      else noSource.push(field);
    }
    if (Object.keys(part).length) payload[target.lang] = part;
  }
  const langs = Object.keys(payload);
  if (langs.length === 0) return { saved: 0, errors: [], noSource, failed: [] };

  let saved = 0;
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

  for (const batch of packLangs(langs, lang => payloadChars(payload[lang]))) {
    if (batch.length === 1) {
      // Sám jazyk: běžná cesta, která si umí poradit i s dělením polí
      const one = await translateOne(byLangTarget.get(batch[0])!, signal);
      saved += one.saved;
      if (one.error) { errors.push(one.error); failed.push(batch[0]); }
      continue;
    }

    const part: Record<string, Record<string, string>> = {};
    for (const lang of batch) part[lang] = payload[lang];
    const done = new Set<string>();
    try {
      saved += await askBatch(code, part, batch, rowsByLang, byLangTarget, model, s, done, signal);
    } catch (e: any) {
      if (isAborted(e)) throw e;
      // Pád společného dotazu ještě není chyba překladu — každý trh dostane
      // vlastní pokus hned pod tímhle a teprve ten rozhodne
      errors.push(`${code}: ${e.message}`);
    }
    // Co se ze společné odpovědi nevrátilo, se dotáhne po jednom
    for (const lang of batch) {
      if (done.has(lang)) continue;
      const one = await translateOne(byLangTarget.get(lang)!, signal);
      saved += one.saved;
      if (one.error) { errors.push(one.error); failed.push(lang); }
    }
    // Když se to po jednom nakonec povedlo, hláška o pádu dávky jen mate
    if (failed.length === 0) {
      const at = errors.findIndex(text => text.startsWith(`${code}: `));
      if (at >= 0) errors.splice(at, 1);
    }
  }

  return { saved, errors: errors.slice(0, 4), noSource, failed };
}

/** Jeden společný dotaz na několik jazyků. Vrací, kolik polí se uložilo. */
async function askBatch(
  code: string,
  payload: Record<string, Record<string, string>>,
  langs: string[],
  rowsByLang: Map<string, FieldRow[]>,
  byLangTarget: Map<string, TranslateTarget>,
  model: string,
  s: PtransSettings,
  done: Set<string>,
  signal?: AbortSignal
): Promise<number> {
  const product = getDb().prepare('SELECT title, category, manufacturer FROM ptrans_products WHERE code = ?')
    .get(code) as { title: string; category: string; manufacturer: string } | undefined;
  const everyField = Array.from(new Set(Object.values(payload).flatMap(part => Object.keys(part))));
  const flat = Object.values(payload).flatMap(part => Object.values(part)).join(' \n');
  const chars = Object.values(payload).reduce((sum, part) => sum + payloadChars(part), 0);

  const hint = [
    product?.category ? `Kategorie: ${product.category}` : '',
    product?.manufacturer ? `Značka: ${product.manufacturer}` : '',
    'Vysvětlivky k polím:',
    ...everyField.filter(f => FIELD_LABELS[f]).map(f => `- ${f}: ${FIELD_LABELS[f]}`),
    s.limits.seoTitle && everyField.includes('seo_title') ? `- seo_title nejvýš ${s.limits.seoTitle} znaků` : '',
    s.limits.seoDesc && everyField.includes('seo_desc') ? `- seo_desc nejvýš ${s.limits.seoDesc} znaků` : '',
    everyField.includes('title') ? consistencyHint(product?.category ?? '', langs[0]) : '',
    memoryHint(flat, langs[0], product?.category ?? '')
  ].filter(Boolean).join('\n');

  const answer = await ask(
    model,
    buildSystem(s, langs),
    `${hint}\n\nTexty k překladu po jazycích:\n${JSON.stringify(payload, null, 1)}`,
    // S rezervou nad odhadem — JSON a uvozovky taky něco zaberou
    Math.min(OUTPUT_MAX, Math.ceil(estimate(chars) * 1.3) + 600),
    { signal }
  );

  const byLang = parseByLang(answer, langs);
  let saved = 0;
  for (const lang of langs) {
    const translated = byLang[lang];
    if (!translated || Object.keys(translated).length === 0) continue;
    saved += saveTranslated(byLangTarget.get(lang)!, rowsByLang.get(lang) ?? [], translated, model);
    done.add(lang);
  }
  return saved;
}

/** Odpověď rozdělená po jazycích; přijme i tvar bez obalu, když je jazyk jeden. */
function parseByLang(raw: string, langs: string[]): Record<string, Record<string, string>> {
  let text = raw.trim();
  if (text.startsWith('```')) text = text.replace(/^```[a-z]*\n?/i, '').replace(/```\s*$/, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('Model nevrátil JSON.');
  const parsed = JSON.parse(text.slice(start, end + 1));

  const out: Record<string, Record<string, string>> = {};
  for (const lang of langs) {
    const part = parsed?.[lang];
    if (!part || typeof part !== 'object') continue;
    const fields: Record<string, string> = {};
    for (const [key, value] of Object.entries(part)) {
      if (typeof value === 'string') fields[key] = value;
    }
    if (Object.keys(fields).length) out[lang] = fields;
  }
  return out;
}

/** Uloží přeložená pole jednoho jazyka a odvodí z názvu adresu. */
function saveTranslated(target: TranslateTarget, rows: FieldRow[],
                        translated: Record<string, string>, model: string): number {
  const s = getPtransSettings();
  let saved = 0;
  for (const [field, raw] of Object.entries(translated)) {
    if (DERIVED_FIELDS.has(field)) continue;
    let value = typeof raw === 'string' ? raw : '';
    if (!value.trim()) continue;
    value = fromModel(field, value);
    if (field === 'seo_title') value = clamp(value, s.limits.seoTitle);
    if (field === 'seo_desc') value = clamp(value, s.limits.seoDesc);
    saveTranslation(target.code, target.lang, field, value, model);
    saved++;
  }
  if (s.fields.seo_url !== false) {
    const result = applySlug(target.code, target.lang, rows, model, translated.title);
    if (result) saved += result.redirect ? 2 : 1;
  }
  return saved;
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

  // Než se začne překládat, mrkne se do paměti. Když je prázdná, vytáhne se
  // teď — z produktů, které jsou ve feedu přeložené, se dá slovosled i
  // názvosloví přečíst za pár vteřin a zbytek běhu se toho drží. Bez toho by
  // první velký překlad vznikl bez jakéhokoli vzoru.
  if (memoryStats().every(row => row.terms === 0)) {
    try { learnFromFeed(langs); } catch { /* paměť je pomůcka, ne podmínka */ }
  }

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

  cancelled = false;
  abort = new AbortController();
  const speed = new Speed(s.secondsPerUnit || 12);
  const started = Date.now();
  const errors: string[] = [];
  const noSourceFields: string[] = [];
  let done = 0;
  let failed = 0;
  let noSource = 0;
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
   * až poté, co osm produktů po sobě proběhne bez zádrhelu. Nastavení
   * „souběžných překladů" je od téhle chvíle strop, ne výchozí tempo.
   */
  let lanes = 1;
  let goodRun = 0;

  /*
   * Plynulý pruh.
   *
   * Hotové úkoly se počítaly po celých produktech, takže při třech vybraných
   * produktech pruh skákal po třetinách a mezi skoky se půl minuty nedělo
   * nic. Rozjeté volání se proto započítává průběžně: podle toho, jak dlouho
   * už běží, oproti tomu, jak dlouho takové volání obvykle trvá. Nikdy
   * nedojde až na konec svého dílku — dokončení musí zůstat skutečné.
   */
  const inFlight = new Map<number, { at: number; units: number }>();
  let ticket = 0;
  const partial = () => {
    let sum = 0;
    for (const item of inFlight.values()) {
      const expect = Math.max(2, speed.perUnit * item.units);
      sum += item.units * Math.min(0.92, (Date.now() - item.at) / 1000 / expect);
    }
    return sum;
  };
  const publish = (label?: string) => {
    const soft = Math.min(total, done + partial());
    current = {
      running: true,
      done,
      total,
      failed,
      bar: total > 0 ? Math.min(1, soft / total) : 0,
      etaSeconds: speed.eta(Math.max(0, total - soft), lanes),
      secondsPerUnit: Number(speed.perUnit.toFixed(1)),
      label: label ?? current?.label ?? '',
      errors: errors.slice(-5)
    };
    emit('ptrans:progress', current);
  };

  publish('');
  const ticker = setInterval(() => { if (current?.running) publish(); }, 700);

  const runId = (getDb().prepare(
    'INSERT INTO ptrans_runs (started_at, total, note) VALUES (?,?,?)'
  ).run(new Date().toISOString(), total, langs.join(',')) as any).lastInsertRowid;

  /** Kolik pokusů dostane jeden produkt, než se to vzdá. */
  const ATTEMPTS = 4;

  /** Jeden produkt od začátku do konce — a s ověřením, že opravdu do konce. */
  const oneProduct = async (code: string, item: { source: SourceTarget[]; work: TranslateTarget[] }) => {
    /* ---------- 1) čeština: co chybí, se dopíše ---------- */
    for (const target of item.source) {
      if (cancelled) break;
      const id = ++ticket;
      inFlight.set(id, { at: Date.now(), units: 1 });
      publish(`${code} — doplňuji ${SOURCE_LABELS[target.field] ?? target.field}`
        + ` v ${s.sourceLang.toUpperCase()}`);
      const at = Date.now();
      const result = await fillSourceOne(code, target.field, abort?.signal);
      speed.add((Date.now() - at) / 1000);
      inFlight.delete(id);
      done++;
      // Přerušené volání není chyba — po zastavení by se jen sypaly hlášky
      if (result.error && !isAborted(result)) { failed++; errors.push(result.error); }
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
        await new Promise(resolve =>
          setTimeout(resolve, 600 * attempt + (rateLimitedRecently() ? 6000 * attempt : 0)));
        if (cancelled) break;
      }

      const id = ++ticket;
      const at = Date.now();
      inFlight.set(id, { at, units: attempt === 1 ? targets.length : 0 });
      publish(`${code} → ${targets.map(t => labelOf(t.lang, s)).join(', ')}`
        + (attempt > 1 ? ` (${attempt}. pokus)` : ''));

      const result = await translateProduct(code, targets, abort?.signal).catch(e => {
        if (isAborted(e)) return { saved: 0, errors: [], noSource: [], failed: [] };
        return {
          saved: 0, errors: [`${code}: ${e.message}`], noSource: [],
          failed: targets.map(t => t.lang)
        };
      });
      speed.add((Date.now() - at) / 1000 / Math.max(1, targets.length));
      inFlight.delete(id);
      if (attempt === 1) done += targets.length;

      for (const field of result.noSource) {
        noSource++;
        if (!noSourceFields.includes(field)) noSourceFields.push(field);
      }

      if (result.failed.length) {
        goodRun = 0;
        if (rateLimitedRecently()) lanes = Math.max(1, Math.floor(lanes / 2));
      } else if (++goodRun >= 8 && lanes < maxLanes && !rateLimitedRecently()) {
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

  const queue = [...plan.entries()];
  const workers = Array.from({ length: maxLanes }, async (_unused, lane) => {
    while (queue.length > 0 && !cancelled) {
      // Přebytečné pruhy počkají, dokud se limit neuvolní
      if (lane >= lanes) {
        await new Promise(resolve => setTimeout(resolve, 1500));
        continue;
      }
      const [code, item] = queue.shift()!;
      await oneProduct(code, item);
      publish();
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
  if (done > 0) savePtransSettings({ secondsPerUnit: Number(speed.perUnit.toFixed(1)) });
  getDb().prepare('UPDATE ptrans_runs SET finished_at = ?, done = ?, failed = ?, seconds = ? WHERE id = ?')
    .run(new Date().toISOString(), done, failed, seconds, runId);

  current = { ...current!, running: false, done, total, failed, bar: 1, etaSeconds: 0, label: '',
    errors: finalErrors.slice(-5) };
  emit('ptrans:progress', current);
  emit('ptrans:changed', {});

  return {
    done, failed, seconds, cancelled,
    errors: (finalErrors.length ? finalErrors : errors).slice(0, 20),
    noSource,
    noSourceFields: noSourceFields.map(field => FIELD_LABELS[field] ?? field),
    tidied: tidied.fields,
    stuck: leftover.map(target => `${target.code} (${target.lang.toUpperCase()})`).slice(0, 20)
  };
}
