import { getDb } from '../db';
import { ask } from '../ai';
import { getSettings } from '../settings';
import { getPtransSettings, saveTranslation, productFields, fieldValue, targetLangs } from './store';
import { getField, productParameters, tagText } from './xml';
import { applySlug } from './translate';
import { plain, clamp } from './detect';
import { languageNote, styleHint } from './style';

/**
 * Texty pro vyhledávače a Google Nákupy.
 *
 * Dvě různé věci, které se pletou dohromady:
 *  1. **Šablona titulku** — mechanické skládání („název + barva + šířka | značka").
 *     Nepotřebuje model, je okamžitá, levná a hlavně předvídatelná: co je
 *     v šabloně, to v titulku bude.
 *  2. **Psaní textu modelem** — když v e-shopu žádný SEO text není, nebo když
 *     má být lepší než ten současný.
 *
 * Šablona se píše jednou v češtině (`{param:Barva}`), ale hodnoty se berou
 * v cílovém jazyce — jinak by se musela psát zvlášť pro každý trh.
 */

export interface TemplateContext {
  code: string;
  lang: string;
}

/** Parametry produktu v daném jazyce, klíčované názvem ve zdrojovém jazyce. */
export function parameterMap(code: string, lang: string): Record<string, string> {
  const s = getPtransSettings();
  const row = getDb().prepare('SELECT raw_xml FROM ptrans_products WHERE code = ?')
    .get(code) as { raw_xml: string } | undefined;
  if (!row) return {};

  const out: Record<string, string> = {};
  for (const part of productParameters(row.raw_xml)) {
    const sourceName = valueOf(part, 'NAME', s.sourceLang);
    if (!sourceName) continue;
    const value = valueOf(part, 'VALUE', lang) || valueOf(part, 'VALUE', s.sourceLang);
    if (value) out[sourceName.toLowerCase()] = value;
  }
  return out;
}

function valueOf(part: string, tag: string, lang: string): string {
  const m = new RegExp(`<${tag} language="${lang}"[^>]*>([\\s\\S]*?)</${tag}>`).exec(part);
  return m ? plain(m[1]) : '';
}

/**
 * Dosadí do šablony. Známé zástupné texty:
 * `{title}` `{code}` `{manufacturer}` `{category}` `{availability}` `{price}`
 * a `{param:Název}` pro libovolný parametr produktu.
 */
export function renderTemplate(template: string, context: TemplateContext): string {
  const d = getDb();
  const s = getPtransSettings();
  const product = d.prepare(
    'SELECT title, category, manufacturer, availability, price, raw_xml FROM ptrans_products WHERE code = ?'
  ).get(context.code) as any;
  if (!product) return '';

  const fields = productFields(context.code, [context.lang]);
  const pick = (field: string) => {
    const row = fields.find(f => f.field === field);
    return row?.translated || row?.value || '';
  };
  const params = parameterMap(context.code, context.lang);

  const values: Record<string, string> = {
    title: pick('title') || product.title,
    code: context.code,
    manufacturer: product.manufacturer,
    category: getField(product.raw_xml, context.lang, 'title') ? product.category : product.category,
    availability: product.availability,
    price: product.price,
    ean: tagText(product.raw_xml, 'EAN')
  };

  return template
    .replace(/\{param:([^}]+)\}/gi, (_, name) => params[String(name).trim().toLowerCase()] ?? '')
    .replace(/\{([a-z_]+)\}/gi, (whole, key) => values[String(key).toLowerCase()] ?? whole)
    // Prázdné parametry po sobě nechávají dvojité mezery a osamocené oddělovače
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([|·,–-])\s+([|·,–-])/g, ' $1')
    .replace(/^[\s|·,–-]+|[\s|·,–-]+$/g, '')
    .trim();
}

/** Použije šablonu Google titulku na vybrané produkty a jazyky. */
export function applyGoogleTitles(codes: string[], langs?: string[]): { written: number; skipped: number } {
  const s = getPtransSettings();
  const list = langs?.length ? langs : targetLangs(s);
  let written = 0;
  let skipped = 0;

  for (const lang of list) {
    const template = (s.googleTitle[lang] || s.googleTitle.all || '').trim();
    if (!template) { skipped += codes.length; continue; }
    for (const code of codes) {
      const value = clamp(renderTemplate(template, { code, lang }), s.limits.googleTitle);
      if (!value) { skipped++; continue; }
      saveTranslation(code, lang, 'google_title', value, 'šablona');
      written++;
    }
  }
  return { written, skipped };
}

/** Náhled šablony na jednom produktu — do nastavení, ať je vidět výsledek. */
export function previewTemplate(template: string, code: string, lang: string): string {
  return clamp(renderTemplate(template, { code, lang }), getPtransSettings().limits.googleTitle);
}

/* ---------- psaní textů modelem ---------- */

export type SeoKind = 'seo_title' | 'seo_desc' | 'google_desc';

const RULES: Record<SeoKind, (limit: number) => string> = {
  seo_title: limit =>
    `Napiš SEO titulek stránky produktu. Nejvýš ${limit} znaků, bez uvozovek. `
    + 'Na začátek to podstatné (co to je a pro koho), na konec název značky oddělený svislítkem. '
    + 'Žádné superlativy typu „nejlepší", žádná klíčová slova naskládaná za sebou.',
  seo_desc: limit =>
    `Napiš meta popis stránky produktu. Nejvýš ${limit} znaků, jedna až dvě věty, `
    + 'konkrétně o produktu (materiál, rozměr, k čemu se hodí) a s jemnou výzvou k akci.',
  google_desc: limit =>
    `Napiš popis produktu pro Google Nákupy. Nejvýš ${limit} znaků, čistý text bez HTML a bez odrážek. `
    + 'První věta popisuje, co produkt je. Dál materiál, rozměry, provedení a použití. '
    + 'Neuváděj cenu, dopravu ani slevy — Google je za to trestá.'
};

/**
 * Nechá model napsat SEO text v cílovém jazyce.
 *
 * Podkladem je přeložený název a popis produktu, ne původní čeština — texty pak
 * drží stejné názvosloví jako zbytek jazykové mutace.
 */
export async function generateSeo(code: string, lang: string, kind: SeoKind,
                                  signal?: AbortSignal): Promise<string> {
  const s = getPtransSettings();
  const model = s.model || getSettings().draftModel;
  // `fieldValue` sahá i do původního XML — ve zdrojovém jazyce se pole
  // nesledují, takže bez toho by model psal z prázdných podkladů
  const pick = (field: string) => fieldValue(code, lang, field);

  const limit = kind === 'seo_title' ? s.limits.seoTitle
    : kind === 'seo_desc' ? s.limits.seoDesc
      : Math.min(s.limits.googleDesc, 900);

  const product = getDb().prepare('SELECT category, manufacturer FROM ptrans_products WHERE code = ?')
    .get(code) as { category: string; manufacturer: string } | undefined;

  const source = [
    `Název: ${pick('title')}`,
    product?.manufacturer ? `Značka: ${product.manufacturer}` : '',
    product?.category ? `Kategorie: ${product.category}` : '',
    `Popis: ${plain(pick('long') || pick('short')).slice(0, 1500)}`,
    Object.entries(parameterMap(code, lang)).map(([name, value]) => `${name}: ${value}`).join(', ')
  ].filter(Boolean).join('\n');

  const answer = await ask(
    model,
    [
      `Píšeš texty pro e-shop v jazyce s kódem „${lang}". Piš výhradně tímhle jazykem.`,
      RULES[kind](limit),
      // Bez tohohle model sklouzává do anglického psaní velkých písmen
      // a do doslovných obratů — česky pak text vypadá jako přeložený
      languageNote(lang),
      styleHint(lang, product?.category ?? '', kind),
      s.prompt.trim() ? `\nVlastní pokyny:\n${s.prompt.trim()}` : '',
      '\nVrať POUZE výsledný text, nic dalšího.'
    ].filter(Boolean).join('\n'),
    source,
    600,
    { signal }
  );

  const value = clamp(answer.replace(/^["„]|["“]$/g, ''), limit);
  if (value) saveTranslation(code, lang, kind, value, model);
  return value;
}

/**
 * Adresa z přeloženého názvu — bez modelu, jen přepis (a doplnění 301).
 *
 * Rozhodování je stejné jako při překladu (`applySlug`): ruční úprava se
 * nepřepisuje a z názvu, který ještě přeložený není, se adresa nedělá.
 */
export function refreshSeoUrl(code: string, lang: string): string {
  const result = applySlug(code, lang, productFields(code, [lang]), 'přepis');
  return result?.slug ?? '';
}
