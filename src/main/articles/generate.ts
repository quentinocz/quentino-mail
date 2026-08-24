import { BrowserWindow } from 'electron';
import { ask, askLong } from '../ai';
import { getSettings } from '../settings';
import { getDb } from '../db';
import { getArticleSettings, getArticle, saveArticle, saveVersion, domainFor,
  ArticleBrief, visibleWords } from './store';
import { slugify } from './xml';
import { rewriteLinks, translateUrl } from './urlmap';

/**
 * Psaní a překlad článků.
 *
 * Článek se generuje **po jazycích, ne najednou** — každý trh má vlastní
 * vyhledávané výrazy a vlastní odkazy, takže „přelož hotový text" by vydal
 * horší výsledek než napsat ho rovnou. Výjimkou je překlad existujícího
 * článku, kde je text daný a jde jen o převod.
 *
 * Odpověď chodí v oddělovačích `<<<TITLE>>>`, ne v JSONu: článek je HTML plné
 * uvozovek a zpětných lomítek a JSON se na tom pravidelně láme.
 */

const TAGS = ['TITLE', 'SLUG', 'SHORT', 'LONG', 'SEO_TITLE', 'SEO_DESC', 'SEO_URL', 'END'];

export interface ArticleProgress {
  running: boolean;
  done: number;
  total: number;
  failed: number;
  label: string;
  /** Kolik znaků textu už model napsal — jediný spolehlivý ukazatel postupu */
  chars: number;
  errors: string[];
}

let state: ArticleProgress = {
  running: false, done: 0, total: 0, failed: 0, label: '', chars: 0, errors: []
};
let cancelled = false;
/**
 * Přerušení rozběhnutého psaní.
 *
 * Článek se streamuje po tisících tokenů. Bez signálu se po stisku
 * „Zastavit" dopisoval celý do konce a teprve pak se běh ukončil — tedy
 * klidně minutu poté, co uživatel řekl dost.
 */
let abort: AbortController | null = null;

function emit(channel: string, payload: unknown) {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload);
}

function push(patch: Partial<ArticleProgress>) {
  state = { ...state, ...patch };
  emit('articles:progress', state);
}

export function articleProgress(): ArticleProgress | null {
  return state.running ? state : null;
}

export function stopArticles(): void {
  if (!state.running) return;
  cancelled = true;
  abort?.abort();
  push({ label: 'zastavuji…' });
}

/** Přerušení není chyba — po zastavení nemá cenu hlásit, že se něco nepovedlo. */
function isAborted(error: any): boolean {
  return cancelled || error?.name === 'AbortError' || /abort/i.test(String(error?.message ?? ''));
}

function model(): string {
  const s = getArticleSettings();
  return s.model || getSettings().draftModel;
}

/* ---------- rozbor odpovědi ---------- */

export function extractSection(text: string, name: string): string {
  const open = `<<<${name}>>>`;
  const start = text.indexOf(open);
  if (start === -1) return '';
  const from = start + open.length;
  let end = text.length;
  for (const other of TAGS) {
    if (other === name) continue;
    const at = text.indexOf(`<<<${other}>>>`, from);
    if (at !== -1 && at < end) end = at;
  }
  return text.slice(from, end).trim();
}

export interface ArticleDraft {
  title: string;
  slug: string;
  short: string;
  long: string;
  seo_title: string;
  seo_desc: string;
  seo_url: string;
}

function parseDraft(raw: string): ArticleDraft {
  const title = extractSection(raw, 'TITLE');
  const slug = extractSection(raw, 'SLUG') || slugify(title);
  return {
    title,
    slug,
    short: extractSection(raw, 'SHORT'),
    long: stripFence(extractSection(raw, 'LONG')),
    seo_title: extractSection(raw, 'SEO_TITLE'),
    seo_desc: extractSection(raw, 'SEO_DESC'),
    seo_url: extractSection(raw, 'SEO_URL') || slug
  };
}

/** Model občas HTML zabalí do ```html — do e-shopu to takhle nesmí. */
function stripFence(html: string): string {
  return html.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();
}

/* ---------- vyhledávané výrazy ---------- */

/**
 * Rozbor vyhledávaných výrazů k tématu.
 *
 * Model nemá přístup k datům z vyhledávače, ale zná, jak se lidé v daném
 * jazyce ptají — a to je přesně to, co článek potřebuje: hlavní výraz do
 * názvu, vedlejší do nadpisů a otázky do FAQ. Výsledek se ukládá k článku,
 * takže je vidět, na co článek míří, a dá se ručně upravit.
 */
export async function researchTerms(topic: string, lang: string, title = ''): Promise<string> {
  const system = 'Jsi SEO specialista. Odpovídáš stručně, v odrážkách, bez úvodu a bez závěru.';
  const user = [
    `Jazyk trhu: ${lang.toUpperCase()}`,
    title ? `Pracovní název: ${title}` : '',
    `Téma článku: ${topic}`,
    '',
    'Vypiš v jazyce trhu:',
    'HLAVNÍ: jeden hlavní vyhledávaný výraz (přesně tak, jak ho lidé píší do vyhledávače)',
    'VEDLEJŠÍ: 5–8 souvisejících výrazů, oddělených čárkou',
    'OTÁZKY: 4–6 otázek, které lidé k tématu hledají (každá na svém řádku)',
    'ZÁMĚR: jednou větou, co člověk hledá a co mu článek musí dát'
  ].filter(Boolean).join('\n');
  return ask(model(), system, user, 700);
}

/* ---------- zadání do promptu ---------- */

const SIZE_HINT: Record<string, string> = {
  auto: 'automaticky podle kontextu',
  small: 'malý — inline v textu',
  medium: 'střední — asi polovina šířky',
  full: 'velký — celá šířka'
};

const LAYOUT_HINT: Record<string, string> = {
  block: 'nad/pod textem (display:block, margin:auto)',
  left: 'obtékání vlevo (float:left, margin: 0 1.5em 1em 0)',
  right: 'obtékání vpravo (float:right, margin: 0 0 1em 1.5em)'
};

const PRODUCT_WIDTH: Record<string, string> = { small: '180px', medium: '280px', large: '420px' };

interface FeedProduct {
  code: string;
  title: string;
  url: string;
  image: string | null;
}

/**
 * Produkty pro článek z produktové databáze.
 *
 * Bere se název i adresa **v cílovém jazyce** — kdyby se vzala česká a
 * přeložila, vznikl by odkaz, který na daném trhu neexistuje.
 */
export function productsForArticle(codes: string[], lang: string): FeedProduct[] {
  if (codes.length === 0) return [];
  const d = getDb();
  const marks = codes.map(() => '?').join(',');
  const rows = d.prepare(
    `SELECT code, title, category, image, url FROM ptrans_products WHERE code IN (${marks})`
  ).all(...codes) as any[];
  const sourceLang = getArticleSettings().sourceLang;

  // `translated` je náš překlad, `value` to, co je ve feedu — v tomhle pořadí
  const fields = d.prepare(
    `SELECT code, field, COALESCE(NULLIF(translated, ''), value) AS text FROM ptrans_fields
     WHERE lang = ? AND field IN ('title','seo_url') AND code IN (${marks})`
  ).all(lang, ...codes) as any[];

  const prefix = getArticleSettings().productPrefix;
  const domain = domainFor(lang);

  return rows.map(row => {
    const pick = (field: string) => {
      const found = fields.find(f => f.code === row.code && f.field === field);
      return (found?.text ?? '').trim();
    };
    // Ve zdrojovém jazyce se pole nepřekládají, takže řádky nemají — hodnoty
    // jsou přímo u produktu
    const slug = pick('seo_url') || (lang === sourceLang ? String(row.url ?? '') : '');
    return {
      code: row.code,
      title: pick('title') || row.title,
      url: slug ? `${domain}${prefix}${slug.replace(/^\/+/, '').replace(/^p\//, '')}` : '',
      image: row.image || null
    };
  });
}

function productBlock(brief: ArticleBrief, lang: string): string {
  const products = productsForArticle(brief.products, lang);
  if (products.length === 0) return '';

  const width = PRODUCT_WIDTH[brief.productSize] ?? PRODUCT_WIDTH.medium;
  const float = brief.productLayout === 'left'
    ? 'float:left;margin:0.5em 1.5em 1em 0;'
    : brief.productLayout === 'right'
      ? 'float:right;margin:0.5em 0 1em 1.5em;'
      : 'margin:1.5em auto;display:block;';

  const lines = products.map(p => {
    const image = brief.productImages[p.code] || p.image;
    if (!brief.includeProductImages || !image) return `- ${p.title} | odkaz: ${p.url}`;
    const figure = `<figure style="${float}max-width:${width};text-align:center">`
      + `<a href="${p.url}"><img src="${image}" alt="${p.title}" style="width:100%;border-radius:16px;display:block;box-shadow:0 12px 30px rgba(0,0,0,0.08)"></a>`
      + `<figcaption style="font-size:0.85em;color:#555;margin-top:6px">`
      + `<a href="${p.url}" style="color:#111;font-weight:600;text-decoration:none">${p.title}</a></figcaption></figure>`;
    return `- ${p.title}\n  odkaz: ${p.url}\n  POVINNÝ KÓD (vlož DOSLOVA do HTML hned za odstavec, kde produkt zmíníš):\n  ${figure}`;
  }).join('\n\n');

  const head = brief.includeProductImages
    ? 'PRODUKTY (zmiň je v textu, odkaž na ně a vlož jejich obrázkový kód doslova):'
    : 'PRODUKTY (zakomponuj jako textové odkazy):';
  return `\n${head}\n${lines}`;
}

function imageBlock(brief: ArticleBrief): string {
  if (brief.images.length === 0) return '';
  const listing = Math.max(0, brief.images.findIndex(img => img.isListing));
  const lines = brief.images.map((img, index) => {
    const note = index === listing ? ' | LISTINGOVÝ — do těla článku ho nedávej' : '';
    return `- URL: ${img.url} | popis: ${img.description || '(bez popisu)'}`
      + ` | velikost: ${SIZE_HINT[img.size] ?? SIZE_HINT.auto}`
      + ` | rozložení: ${LAYOUT_HINT[img.layout] ?? LAYOUT_HINT.block}${note}`;
  }).join('\n');
  return `\nDOSTUPNÉ OBRÁZKY:\n${lines}`;
}

function linkBlock(brief: ArticleBrief, lang: string): string {
  const lines = brief.links
    .map(link => {
      const url = link.urls[lang] || translateUrl(link.urls[Object.keys(link.urls)[0]] ?? '', 'cz', lang).url;
      return url ? `- ${link.name} | URL: ${url}` : '';
    })
    .filter(Boolean)
    .join('\n');
  return lines ? `\nINTERNÍ ODKAZY (zakomponuj přirozeně do textu):\n${lines}` : '';
}

/**
 * Rozpis délky.
 *
 * Samotná věta „napiš 600 slov" nefunguje — model si počet slov neumí
 * odpočítat a psal klidně dva a půl tisíce. Co funguje, je **struktura**:
 * kolik má být sekcí a kolik slov připadá na jednu. Takové zadání se dá
 * plnit průběžně, a když se přesto netrefí, chytí to kontrola po napsání.
 */
function lengthPlan(wordCount: number): string {
  const sections = Math.max(3, Math.min(8, Math.round(wordCount / 180)));
  const intro = Math.max(60, Math.round(wordCount * 0.12));
  const perSection = Math.max(70, Math.round((wordCount - intro) / sections));
  return [
    `POŽADOVANÁ DÉLKA: ${wordCount} slov viditelného textu. Tohle je zadání, ne orientační údaj.`,
    `Rozvrhni si to takhle: úvod ${intro} slov, pak ${sections} sekcí s H2 po zhruba ${perSection} slovech`,
    'a krátké FAQ na konci. Delší článek není lepší článek — když téma dojde, skonči.',
    `Odchylka nahoru nejvýš o desetinu, tedy strop je ${Math.round(wordCount * 1.1)} slov.`
  ].join('\n');
}

/** Meze, za kterými se článek přepisuje: pod tři čtvrtiny a nad jeden a čtvrt. */
function lengthOff(words: number, target: number): 'short' | 'long' | null {
  if (!target) return null;
  if (words > target * 1.25) return 'long';
  if (words < target * 0.75) return 'short';
  return null;
}

/* ---------- generování ---------- */

export interface GenerateInput {
  articleId?: number;
  topic: string;
  title?: string;
  titleFixed?: boolean;
  langs: string[];
  wordCount?: number;
  brief?: Partial<ArticleBrief>;
  prompt?: string;
  /** Přepsat i jazyky, které už napsané jsou */
  force?: boolean;
  /**
   * Jak vzniknou jazykové mutace.
   *
   * `each` — každý jazyk se píše zvlášť. Text pak sedí na daný trh: jiné
   *   vyhledávané výrazy, jiné příklady, jiná struktura. Stojí to ale
   *   tolikrát víc, kolik je jazyků, a články si nejsou podobné.
   * `translate` — napíše se zdrojový a ostatní z něj vzniknou překladem
   *   jedna ku jedné. Levnější, rychlejší a všechny mutace mají stejnou
   *   stavbu i stejné odkazy — což je většinou to, co člověk chce.
   */
  mode?: 'each' | 'translate';
}

export async function generateArticle(input: GenerateInput): Promise<{ id: number; langs: string[]; errors: string[] }> {
  if (state.running) throw new Error('Generování už běží.');
  const s = getArticleSettings();
  const wordCount = input.wordCount ?? s.wordCount;

  const id = saveArticle({
    id: input.articleId,
    topic: input.topic,
    status: 'draft',
    wordCount,
    langs: input.langs,
    prompt: input.prompt ?? '',
    brief: { ...(input.brief ?? {}), title: input.title ?? '', titleFixed: !!input.titleFixed }
  });

  const article = getArticle(id)!;
  const brief = article.brief;
  const system = input.prompt || article.prompt || s.prompt;
  const brand = (getSettings() as any).brandContext ?? '';

  cancelled = false;
  abort = new AbortController();

  // V režimu překladu se modelem píše jen zdrojový jazyk; zbytek se z něj
  // odvodí až potom, hotovým překladovým průchodem
  const mode = input.mode ?? 'each';
  const wanted = mode === 'translate'
    ? input.langs.filter(lang => lang === article.sourceLang).length
      ? [article.sourceLang]
      : [input.langs[0]]
    : input.langs;
  const todo = input.force
    ? wanted
    : wanted.filter(lang => !article.versions.find(v => v.lang === lang && v.long));

  state = { running: true, done: 0, total: todo.length, failed: 0, label: '', chars: 0, errors: [] };
  push({});

  const written: string[] = [];
  try {
    for (const lang of todo) {
      if (cancelled) break;
      push({ label: `${lang.toUpperCase()} — hledám vyhledávané výrazy`, chars: 0 });

      let terms = article.terms;
      if (s.researchTerms) {
        try {
          terms = await researchTerms(input.topic, lang, input.title);
          if (lang === article.sourceLang || !article.terms) saveArticle({ id, terms });
        } catch { /* rozbor je pomůcka, ne podmínka */ }
      }

      push({ label: `${lang.toUpperCase()} — píšu článek`, chars: 0 });
      const user = [
        `Jazyk obsahu: ${lang.toUpperCase()}`,
        lengthPlan(wordCount),
        brand ? `Kontext značky: ${brand}` : '',
        '',
        input.title
          ? (input.titleFixed
            ? `Název článku — přelož přesně do daného jazyka, neupravuj: ${input.title}`
            : `Návrh názvu (přelož a klidně vylepši): ${input.title}`)
          : 'Název článku vymysli sám.',
        `Téma a zaměření: ${input.topic || '(bez popisu)'}`,
        terms ? `\nVYHLEDÁVANÉ VÝRAZY — hlavní patří do názvu, do prvního odstavce a do jednoho H2;\notázky použij jako FAQ na konci:\n${terms}` : '',
        productBlock(brief, lang),
        linkBlock(brief, lang),
        imageBlock(brief),
        '',
        'Odpověz POUZE pomocí oddělovačů <<<TITLE>>>, <<<SLUG>>>, <<<SHORT>>>, <<<LONG>>>,'
        + ' <<<SEO_TITLE>>>, <<<SEO_DESC>>>, <<<SEO_URL>>>, <<<END>>> — žádný JSON, žádný markdown.'
      ].filter(Boolean).join('\n');

      try {
        const raw = await askLong(model(), system, user, {
          maxTokens: 16000,
          endMark: '<<<END>>>',
          signal: abort?.signal,
          onChunk: (_text, chars) => push({ chars })
        });
        const draft = parseDraft(raw);
        if (!draft.title || !draft.long) throw new Error('Model nevrátil použitelný článek.');

        // Doměření. Zadaná délka je zadání, ne přání — když se model netrefí,
        // dostane text zpátky s úkolem ho zkrátit nebo dopsat. Ověřuje se
        // stejnou funkcí, jakou pak délku hlásí rozhraní, takže se nemůže
        // stát, že „prošlo" a v přehledu svítí něco jiného.
        const off = lengthOff(visibleWords(draft.long), wordCount);
        if (off && !cancelled) {
          push({ label: `${lang.toUpperCase()} — ${off === 'long' ? 'zkracuji' : 'dopisuji'} na ${wordCount} slov`, chars: 0 });
          try {
            const fixed = await resize(draft.long, wordCount, off, lang);
            if (fixed) draft.long = fixed;
          } catch (e: any) {
            if (isAborted(e)) break;
            // Nepovedená úprava délky není důvod zahodit hotový článek
          }
        }

        saveVersion(id, lang, {
          ...draft,
          seo_url: draft.seo_url || slugify(draft.title),
          slug: draft.slug || slugify(draft.title),
          state: 'generated'
        });
        written.push(lang);
        push({ done: state.done + 1 });
      } catch (e: any) {
        if (isAborted(e)) break;
        push({ failed: state.failed + 1, errors: [...state.errors, `${lang}: ${e.message}`] });
      }
    }
  } finally {
    push({ running: false, label: cancelled ? 'zastaveno' : 'hotovo' });
  }

  // Zbylé jazyky překladem. Až tady, po dopsání zdroje — dřív by nebylo co
  // překládat. `translateArticle` si vede vlastní postup, proto se běh
  // nejdřív ukončí a hned zase spustí.
  const rest = input.langs.filter(lang => !wanted.includes(lang));
  if (mode === 'translate' && rest.length > 0 && !cancelled && written.length > 0) {
    try {
      const result = await translateArticle(id, rest, input.force);
      written.push(...result.langs);
      if (result.errors.length) push({ errors: [...state.errors, ...result.errors] });
    } catch (e: any) {
      if (!isAborted(e)) push({ errors: [...state.errors, e.message] });
    }
  }

  // Článek, který má text ve všech zadaných jazycích, už není rozepsaný —
  // jinak by ho hromadný export přeskočil a nikdo by nevěděl proč
  const after = getArticle(id);
  const complete = !!after && input.langs.every(lang =>
    after.versions.some(v => v.lang === lang && v.long));
  if (complete) saveArticle({ id, status: 'ready' });
  emit('articles:changed', { id });

  return { id, langs: written, errors: state.errors };
}

/**
 * Zkrácení nebo dopsání hotového textu na zadanou délku.
 *
 * Píše se znovu jen tělo článku, ne název a SEO — ty už jsou v pořádku a
 * dalším průchodem by se jen zbytečně měnily. HTML se nesmí sáhnout: odkazy,
 * obrázky a JSON-LD na konci musí zůstat přesně, jak jsou, jinak by se
 * rozpadlo provázání článků, které se pracně skládalo jinde.
 */
async function resize(html: string, target: number, direction: 'short' | 'long', lang: string):
  Promise<string> {
  const words = visibleWords(html);
  const system = [
    `Upravuješ délku hotového článku v jazyce ${lang.toUpperCase()}.`,
    direction === 'long'
      ? `Text má ${words} slov, má mít ${target}. Zkrať ho — vypusť opakování, vatu a odbočky.`
      : `Text má ${words} slov, má mít ${target}. Rozveď ho — doplň konkrétní detaily k tomu, co už tam je.`,
    '',
    'Závazné:',
    '- Zachovej HTML značky, atributy, odkazy, obrázky i JSON-LD na konci beze změny.',
    '- Zachovej všechny sekce a jejich nadpisy. Neubírej ani nepřidávej H2.',
    '- Nepřidávej fakta, která v textu nejsou. Nevymýšlej si.',
    direction === 'long'
      ? '- Krať uvnitř odstavců, ne mazáním celých sekcí.'
      : '- Rozváděj uvnitř odstavců, ne přidáváním nových sekcí.',
    '',
    'Vrať POUZE upravené HTML, zakončené <<<END>>>.'
  ].join('\n');

  const raw = await askLong(model(), system, html, {
    maxTokens: 16000,
    endMark: '<<<END>>>',
    signal: abort?.signal,
    onChunk: (_text, chars) => push({ chars })
  });
  const out = raw.replace('<<<END>>>', '').trim();
  // Přijme se jen tehdy, když je na tom líp než původní text
  if (!out || !/</.test(out)) return '';
  const before = Math.abs(visibleWords(html) - target);
  const after = Math.abs(visibleWords(out) - target);
  return after < before ? out : '';
}

/* ---------- překlad hotového článku ---------- */

/**
 * Překlad existujícího článku do dalšího jazyka.
 *
 * HTML se modelu posílá celé a vrací se celé — struktura, styly i obrázky
 * musí zůstat na svém místě. Odkazy se ale **nepřekládají modelem**: ty se
 * přepíšou předem podle mapy adres, protože adresa buď existuje, nebo ne, a
 * to je věc databáze, ne odhadu.
 */
export async function translateArticle(id: number, targets: string[], force = false):
  Promise<{ langs: string[]; unresolved: { lang: string; url: string }[]; errors: string[] }> {
  if (state.running) throw new Error('Generování už běží.');
  const article = getArticle(id);
  if (!article) throw new Error('Článek nenalezen.');

  const source = article.versions.find(v => v.lang === article.sourceLang && v.long)
    ?? article.versions.find(v => v.long);
  if (!source) throw new Error('Článek nemá zdrojový text.');

  const s = getArticleSettings();
  const todo = targets.filter(lang => lang !== source.lang
    && (force || !article.versions.find(v => v.lang === lang && v.long)));

  cancelled = false;
  abort = new AbortController();
  state = { running: true, done: 0, total: todo.length, failed: 0, label: '', chars: 0, errors: [] };
  push({});

  const done: string[] = [];
  const unresolved: { lang: string; url: string }[] = [];

  try {
    for (const lang of todo) {
      if (cancelled) break;
      push({ label: `${lang.toUpperCase()} — překládám článek`, chars: 0 });

      // Odkazy nejdřív, ať model dostane už správné adresy a nesahá na ně
      const rewritten = rewriteLinks(source.long, source.lang, lang);
      for (const item of rewritten.unresolved) unresolved.push({ lang, url: item.url });

      const system = [
        s.prompt,
        '',
        'REŽIM PŘEKLADU:',
        '- Dostaneš hotový HTML článek. Přelož VIDITELNÝ text a nech všechno ostatní beze změny.',
        '- Nesahej na HTML značky, inline styly, atributy, adresy v href ani v src.',
        '- Adresy jsou už převedené na správný trh — ponech je přesně tak, jak jsou.',
        '- Zachovej strukturu, počet sekcí i délku. Nic nepřidávej ani neubírej.',
        '- V JSON-LD na konci přelož jen texty (headline, description, otázky a odpovědi).'
      ].join('\n');

      const user = [
        `Cílový jazyk: ${lang.toUpperCase()}`,
        `Zdrojový jazyk: ${source.lang.toUpperCase()}`,
        '',
        `<<<TITLE>>>\n${source.title}`,
        `<<<SHORT>>>\n${source.short}`,
        `<<<LONG>>>\n${rewritten.html}`,
        `<<<SEO_TITLE>>>\n${source.seo_title}`,
        `<<<SEO_DESC>>>\n${source.seo_desc}`,
        '<<<END>>>',
        '',
        'Vrať totéž ve stejných oddělovačích, přeložené. Navíc přidej <<<SLUG>>> a <<<SEO_URL>>>'
        + ' — adresu odvozenou z přeloženého názvu, malými písmeny, bez diakritiky, slova spojená pomlčkami.'
      ].join('\n');

      try {
        const raw = await askLong(model(), system, user, {
          maxTokens: 16000,
          endMark: '<<<END>>>',
          signal: abort?.signal,
          onChunk: (_text, chars) => push({ chars })
        });
        const draft = parseDraft(raw);
        if (!draft.long) throw new Error('Překlad se nevrátil celý.');
        saveVersion(id, lang, {
          title: draft.title || source.title,
          slug: draft.slug || slugify(draft.title || source.title),
          short: draft.short || source.short,
          long: draft.long,
          seo_title: draft.seo_title || draft.title,
          seo_desc: draft.seo_desc || source.seo_desc,
          seo_url: draft.seo_url || slugify(draft.title || source.title),
          state: 'translated'
        });
        done.push(lang);
        push({ done: state.done + 1 });
      } catch (e: any) {
        if (isAborted(e)) break;
        push({ failed: state.failed + 1, errors: [...state.errors, `${lang}: ${e.message}`] });
      }
    }
  } finally {
    const after = getArticle(id);
    const complete = !!after && after.langs.every(lang =>
      after.versions.some(v => v.lang === lang && v.long));
    if (complete) saveArticle({ id, status: 'ready' });
    push({ running: false, label: cancelled ? 'zastaveno' : 'hotovo' });
    emit('articles:changed', { id });
  }

  return { langs: done, unresolved, errors: state.errors };
}

/** Kolik slov má která verze — kontrola, že délka odpovídá zadání. */
export function wordCheck(id: number): { lang: string; words: number; target: number }[] {
  const article = getArticle(id);
  if (!article) return [];
  return article.versions.map(v => ({
    lang: v.lang,
    words: visibleWords(v.long),
    target: article.wordCount
  }));
}
