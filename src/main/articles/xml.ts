import { getArticleSettings, domainFor } from './store';

/**
 * Čtení a psaní XML článků pro Upgates (`<TEXTS>` / `<TEXT type="article">`).
 *
 * Export z Upgates má texty jako escapované entity, import bere i CDATA.
 * Píše se proto CDATA — v HTML článku je tolik uvozovek a špičatých závorek,
 * že by escapování bylo nečitelné a lehce by se v něm udělala chyba.
 *
 * Jazykové kódy: e-shop uvnitř používá `cz`, import článků chce ISO `cs`.
 * Překlápí se až tady, aby se zbytek aplikace nemusel starat.
 */

export function toImportLang(lang: string): string {
  return lang === 'cz' ? 'cs' : lang;
}

export function fromExportLang(lang: string): string {
  return lang === 'cs' ? 'cz' : lang;
}

export function splitArticles(xml: string): string[] {
  return xml.match(/<TEXT\b[^>]*>[\s\S]*?<\/TEXT>/g) ?? [];
}

export function tag(block: string, name: string): string {
  const found = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(block);
  return found ? decode(found[1]) : '';
}

/** Jazyková část bloku — `<DESCRIPTION language="cz">…`. */
export function langScope(block: string, wrapper: string, lang: string): string {
  const re = new RegExp(`<${wrapper}\\s+language="${lang}"[^>]*>([\\s\\S]*?)</${wrapper}>`);
  return re.exec(block)?.[1] ?? '';
}

export function langsIn(block: string, wrapper = 'DESCRIPTION'): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${wrapper}\\s+language="([a-z]{2,5})"`, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(block))) if (!out.includes(match[1])) out.push(match[1]);
  return out;
}

/**
 * Rozbalí hodnotu prvku.
 *
 * Export z Upgates má texty jako escapované entity, náš export je píše do
 * CDATA. Rozdíl je podstatný: **obsah CDATA se dekódovat nesmí.** V HTML
 * článku je `&amp;` skutečné `&amp;` a druhé dekódování by z něj udělalo `&`,
 * takže by se článek po každém průchodu tam a zpět tiše měnil.
 */
export function decode(value: string): string {
  const text = value ?? '';
  if (!text.includes('<![CDATA[')) return entities(text).trim();

  const parts: string[] = [];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>/g;
  let match: RegExpExecArray | null;
  let last = 0;
  while ((match = re.exec(text))) {
    parts.push(entities(text.slice(last, match.index)));
    parts.push(match[1]);
    last = match.index + match[0].length;
  }
  parts.push(entities(text.slice(last)));
  return parts.join('').trim();
}

function entities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#13;/g, '\r')
    .replace(/&amp;/g, '&');
}

export function escape(value: string): string {
  return (value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** HTML do CDATA. `]]>` uvnitř textu se musí rozdělit, jinak sekci ukončí. */
export function cdata(value: string): string {
  return `<![CDATA[${(value ?? '').replace(/\]\]>/g, ']]]]><![CDATA[>')}]]>`;
}

/** Slug z názvu — bez diakritiky, malými písmeny, spojený pomlčkami. */
export function slugify(value: string): string {
  return (value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90);
}

export interface ArticleVersionXml {
  lang: string;
  title: string;
  slug: string;
  short: string;
  long: string;
  seo_title: string;
  seo_desc: string;
  seo_url: string;
}

export interface ArticleImageXml {
  url: string;
  description?: string;
  isListing?: boolean;
}

/**
 * Poskládá jeden `<TEXT>`. `articleId` se vyplní jen u článků, které na
 * e-shopu už existují — import podle něj pozná, že má stávající článek
 * přepsat, a ne založit druhý.
 */
export function buildArticle(versions: ArticleVersionXml[], options: {
  articleId?: string | null;
  images?: ArticleImageXml[];
  active?: boolean;
  createdAt?: string;
  categories?: { code?: string; name: string; primary?: boolean }[];
} = {}): string {
  const created = (options.createdAt ?? new Date().toISOString()).slice(0, 19);
  const listingIndex = Math.max(0, (options.images ?? []).findIndex(img => img.isListing));

  const descriptions = versions.map(v => {
    const url = `${domainFor(v.lang)}${getArticleSettings().articlePrefix}${v.seo_url || v.slug}`;
    return [
      `\t\t\t<DESCRIPTION language="${toImportLang(v.lang)}">`,
      `\t\t\t\t<TITLE>${escape(v.title)}</TITLE>`,
      `\t\t\t\t<SHORT_DESCRIPTION>${cdata(v.short)}</SHORT_DESCRIPTION>`,
      `\t\t\t\t<LONG_DESCRIPTION>${cdata(v.long)}</LONG_DESCRIPTION>`,
      `\t\t\t\t<URL>${escape(url)}</URL>`,
      `\t\t\t</DESCRIPTION>`
    ].join('\n');
  }).join('\n');

  const seo = versions.map(v => [
    `\t\t\t<SEO language="${toImportLang(v.lang)}">`,
    `\t\t\t\t<SEO_URL>${escape(v.seo_url || v.slug)}</SEO_URL>`,
    `\t\t\t\t<SEO_TITLE>${escape(v.seo_title)}</SEO_TITLE>`,
    `\t\t\t\t<SEO_META_DESCRIPTION>${escape(v.seo_desc)}</SEO_META_DESCRIPTION>`,
    `\t\t\t</SEO>`
  ].join('\n')).join('\n');

  const images = (options.images ?? []).map((img, index) => {
    const titles = versions.map(v =>
      `\t\t\t\t\t<TITLE language="${toImportLang(v.lang)}">${escape(img.description ?? '')}</TITLE>`
    ).join('\n');
    return [
      `\t\t\t<IMAGE>`,
      `\t\t\t\t<URL>${escape(img.url)}</URL>`,
      `\t\t\t\t<TITLES>`,
      titles,
      `\t\t\t\t</TITLES>`,
      `\t\t\t\t<MAIN_YN>${index === listingIndex ? 1 : 0}</MAIN_YN>`,
      `\t\t\t\t<LIST_YN>${index === listingIndex ? 1 : 0}</LIST_YN>`,
      `\t\t\t\t<POSITION>${index + 1}</POSITION>`,
      `\t\t\t</IMAGE>`
    ].join('\n');
  }).join('\n');

  const categories = (options.categories ?? []).map(cat => [
    `\t\t\t<CATEGORY>`,
    cat.code ? `\t\t\t\t<CODE>${escape(cat.code)}</CODE>` : '',
    `\t\t\t\t<NAME>${escape(cat.name)}</NAME>`,
    `\t\t\t\t<PRIMARY_YN>${cat.primary ? 1 : 0}</PRIMARY_YN>`,
    `\t\t\t</CATEGORY>`
  ].filter(Boolean).join('\n')).join('\n');

  return [
    `\t<TEXT type="article">`,
    options.articleId ? `\t\t<ARTICLE_ID>${escape(options.articleId)}</ARTICLE_ID>` : '',
    `\t\t<ACTIVE_YN>${options.active === false ? 0 : 1}</ACTIVE_YN>`,
    `\t\t<CREATION_TIME>${created}</CREATION_TIME>`,
    `\t\t<DESCRIPTIONS>`,
    descriptions,
    `\t\t</DESCRIPTIONS>`,
    `\t\t<SEO_OPTIMALIZATION>`,
    seo,
    `\t\t</SEO_OPTIMALIZATION>`,
    categories ? `\t\t<CATEGORIES>\n${categories}\n\t\t</CATEGORIES>` : '',
    images ? `\t\t<IMAGES>\n${images}\n\t\t</IMAGES>` : '',
    `\t</TEXT>`
  ].filter(Boolean).join('\n');
}

export function wrapTexts(blocks: string[]): string {
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + `<!--Quentino App: články · ${new Date().toLocaleString('cs-CZ')}-->\n`
    + '<TEXTS version="1.0">\n'
    + blocks.join('\n')
    + '\n</TEXTS>\n';
}
