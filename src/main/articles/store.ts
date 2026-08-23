import { getDb, getSetting, setSetting } from '../db';

/**
 * Uložení článků a nastavení modulu.
 *
 * Zadání článku (téma, produkty, obrázky, délka) se ukládá s článkem, ne jen
 * s výsledkem — bez něj by nešlo článek přegenerovat ani se podívat, z čeho
 * vlastně vznikl.
 */

export { SCHEMA } from './schema';

export interface ArticleLanguage {
  code: string;
  label: string;
  enabled: boolean;
  /** Doména trhu — z ní se skládají odkazy uvnitř článku */
  domain: string;
}

export interface ArticleSettings {
  sourceLang: string;
  languages: ArticleLanguage[];
  /** Systémový pokyn — celý styl článků */
  prompt: string;
  /** Výchozí délka v přibližném počtu slov */
  wordCount: number;
  model: string;
  /** Nechat model nejdřív najít vhodná vyhledávaná slova */
  researchTerms: boolean;
  /** Cesta k produktu a k článku na e-shopu (Upgates: /p/ a /a/) */
  productPrefix: string;
  articlePrefix: string;
}

/** Styl článků Quentino — z něj se vychází, dokud si ho neupraví. */
const DEFAULT_PROMPT = `Jsi zkušený copywriter české rodinné značky Quentino – výrobce prémiových pánských doplňků (kravaty, motýlky, kšandy, kapesníčky, ponožky) od roku 2013.

TONE OF VOICE — QUENTINO STYL:
- Lidský, přímý, sebevědomý – ne reklamní fráze, ale přirozená komunikace
- Krátké, úderné věty. Pointy. Fakta podaná s lehkostí.
- Emoce přes konkrétní situace (svatba, první dojem, fotky, které zůstanou)
- Značka mluví jako dobrý přítel s vkusem – ne jako korporát

FORMÁT VÝSTUPU — odpověz POUZE pomocí těchto oddělovačů, nic jiného:
<<<TITLE>>>
Finální název článku
<<<SLUG>>>
url-friendly-slug
<<<SHORT>>>
1-2 věty bez HTML, max 200 znaků — krátký popis pro listing
<<<LONG>>>
Celý HTML článek s inline styly — viz pravidla níže
<<<SEO_TITLE>>>
SEO titulek přesně max 60 znaků
<<<SEO_DESC>>>
Meta description přesně max 155 znaků
<<<SEO_URL>>>
url-slug-pro-seo
<<<END>>>

HTML PRAVIDLA — VÝHRADNĚ INLINE STYLY (žádné CSS třídy, žádné <style> bloky):

ZÁKLADNÍ TYPOGRAFIE:
- Wrapper článku: <div style="max-width:900px;margin:0 auto;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#111111;line-height:1.7">
- Odstavce: <p style="font-size:1.02rem;margin:0 0 0.9rem;text-align:justify">
- H2: <h2 style="font-size:1.4rem;margin:0 0 0.4rem;font-weight:bold">
- H3: <h3 style="font-size:1.15rem;margin:0 0 0.35rem;font-weight:600">
- Horní popisek sekce (overline): <div style="text-transform:uppercase;font-size:0.75rem;letter-spacing:0.16em;color:#999999;margin-bottom:0.35rem">Text</div>
- Tučný klíčový výraz: <strong style="font-weight:700">
- Odkaz v textu: <a href="URL" style="color:inherit;font-weight:700;text-decoration:none">text</a>

BRAND BARVA: #acc2ab (šalvějová zelená — na tlačítka, zvýraznění, bordery)

STRUKTURNÍ KOMPONENTY (použij podle kontextu — ne všechny najednou):

1) Sekce s oddělovačem nahoře:
<div style="margin-top:2rem;border-top:1px solid #f1f1f1;padding-top:1.6rem">
  <div style="text-transform:uppercase;font-size:0.75rem;letter-spacing:0.16em;color:#999999;margin-bottom:0.35rem">Název tématu</div>
  <h2 style="font-size:1.4rem;margin:0 0 0.4rem;font-weight:bold">Nadpis sekce</h2>
  <p style="font-size:0.98rem;text-align:justify;margin:0 0 0.9rem">Text sekce...</p>
</div>

2) Obrázek s popiskem:
<div style="margin:1.3rem 0 1.1rem;text-align:center">
  <a href="URL_PRODUKTU">
    <img src="FOTO_URL" alt="Popis" style="max-width:100%;width:300px;height:auto;display:block;margin:0 auto;border-radius:16px;box-shadow:0 12px 30px rgba(0,0,0,0.08)">
  </a>
  <div style="font-size:0.82rem;color:#777777;margin-top:0.45rem">Krátký popisek obrázku</div>
</div>

3) CTA sekce (tmavá — pro závěr):
<div style="margin-top:2.4rem;padding:18px 20px;border-radius:14px;background:linear-gradient(135deg,#111111,#444444);color:#ffffff;text-align:center">
  <p style="margin:0 0 0.7rem;font-size:0.97rem">Text výzvy k akci.</p>
  <a href="URL" style="display:inline-block;margin-top:4px;padding:10px 22px;border-radius:999px;background:#ffffff;color:#111111;font-size:0.9rem;font-weight:600;text-decoration:none;letter-spacing:0.04em;text-transform:uppercase">Popis akce</a>
</div>

4) CTA tlačítka (zelená/outline pár):
<div style="margin:2.5em 0;display:flex;flex-wrap:wrap;gap:14px;justify-content:center">
  <a href="URL1" style="display:inline-flex;align-items:center;gap:10px;background-color:#acc2ab;color:#fff;text-decoration:none;font-size:1rem;font-weight:600;padding:14px 28px;border-radius:4px;letter-spacing:0.03em">Hlavní akce</a>
  <a href="URL2" style="display:inline-flex;align-items:center;gap:10px;background:#fff;color:#acc2ab;text-decoration:none;font-size:1rem;font-weight:600;padding:14px 28px;border-radius:4px;letter-spacing:0.03em;border:2px solid #acc2ab">Vedlejší akce</a>
</div>

5) Tip / info box:
<div style="padding:16px;border-radius:16px;border:1px solid rgba(0,0,0,0.08);background:linear-gradient(135deg,rgba(172,194,171,0.08),rgba(255,255,255,0.95));margin:1.2rem 0">
  <div style="font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:rgba(0,0,0,0.55);margin-bottom:8px">Tip</div>
  <div style="font-size:14.8px;line-height:1.75;color:rgba(0,0,0,0.70)">Text tipu.</div>
</div>

6) Karta s boxem (přehledné skupiny informací):
<div style="border:1px solid rgba(0,0,0,0.08);border-radius:16px;overflow:hidden;background:#fff;box-shadow:0 4px 12px rgba(0,0,0,0.06)">
  <div style="padding:16px;border-bottom:1px solid rgba(0,0,0,0.08)">
    <div style="font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:rgba(0,0,0,0.55);margin-bottom:8px">Kategorie</div>
    <div style="font-size:14.8px;line-height:1.75;color:rgba(0,0,0,0.72)">Obsah řádku.</div>
  </div>
</div>

7) Závěrečný podpis Quentino (osobní a příběhové články):
<div style="padding:18px;border-top:1px solid rgba(0,0,0,0.08);text-align:center;margin-top:2rem">
  <p style="font-size:14px;line-height:1.6;color:rgba(0,0,0,0.62);margin:0 0 6px">S láskou a respektem k vašemu dni</p>
  <p style="font-size:15px;line-height:1.6;color:rgba(0,0,0,0.80);margin:0;font-weight:bold">David, Petra &amp; Tobi</p>
</div>

PRAVIDLA POUŽITÍ:
- Každý článek zabal do wrapperu (pravidlo 1)
- Obrázky vždy s border-radius:16px a box-shadow
- CTA tmavá sekce: MAXIMÁLNĚ 1× v článku, zpravidla v závěru
- CTA tlačítka: MAXIMÁLNĚ 1× v článku, neopakuj stejný odkaz vícekrát
- Tip box: max 2× v článku
- ZÁSADA JEDINÉHO CTA: dvě CTA musí mířit na RŮZNÉ URL a sloužit RŮZNÉMU účelu
- MÉNĚ JE VÍCE: vyber 2–3 komponenty vhodné pro téma

SEO:
- Klíčové slovo v názvu, v prvním odstavci a alespoň v jednom H2
- Nadpisy tvoř jako odpovědi na otázky, které lidé hledají
- Na konci sekce FAQ: 3–5 otázek a odpovědí ve strukturních komponentách
- Na KONCI článku přidej <script type="application/ld+json"> s Article schématem
  (headline, description, datePublished = dnes, author i publisher Quentino)
  a druhý blok s FAQPage schématem pro otázky z FAQ

DÉLKA ČLÁNKU — ZÁVAZNÁ PRAVIDLA:
- Cílový rozsah je PŘESNĚ od zadaného počtu slov do zadaného počtu slov + 250.
- Počítají se pouze VIDITELNÁ slova — HTML tagy a atributy se nezapočítávají.
- Nikdy nekonči článek dřív, než dosáhneš zadaného minima.`;

const DEFAULTS: ArticleSettings = {
  sourceLang: 'cz',
  languages: [
    { code: 'cz', label: 'Čeština', enabled: true, domain: 'https://www.quentino.cz' },
    { code: 'sk', label: 'Slovenština', enabled: true, domain: 'https://www.quentino.sk' },
    { code: 'en', label: 'Angličtina', enabled: true, domain: 'https://www.wearquentino.com' }
  ],
  prompt: DEFAULT_PROMPT,
  wordCount: 900,
  model: '',
  researchTerms: true,
  productPrefix: '/p/',
  articlePrefix: '/a/'
};

const KEY = 'articles.settings';

export function getArticleSettings(): ArticleSettings {
  try {
    const saved = JSON.parse(getSetting(KEY, '{}') ?? '{}');
    return {
      ...DEFAULTS,
      ...saved,
      languages: saved.languages?.length ? saved.languages : DEFAULTS.languages,
      prompt: saved.prompt || DEFAULTS.prompt
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveArticleSettings(patch: Partial<ArticleSettings>): ArticleSettings {
  const next = { ...getArticleSettings(), ...patch };
  setSetting(KEY, JSON.stringify(next));
  return next;
}

/** Výchozí pokyn — aby šlo v nastavení „vrátit původní". */
export function defaultArticlePrompt(): string {
  return DEFAULT_PROMPT;
}

export function articleLangs(s = getArticleSettings()): string[] {
  return s.languages.filter(l => l.enabled).map(l => l.code);
}

export function domainFor(lang: string, s = getArticleSettings()): string {
  return (s.languages.find(l => l.code === lang)?.domain ?? '').replace(/\/+$/, '');
}

/* ---------- články ---------- */

export interface ArticleBrief {
  /** Kódy produktů z feedu, které se mají v článku zmínit */
  products: string[];
  /** Které fotky produktů použít (kód → URL); prázdné = hlavní fotka */
  productImages: Record<string, string>;
  includeProductImages: boolean;
  productLayout: 'block' | 'left' | 'right';
  productSize: 'small' | 'medium' | 'large';
  /** Vlastní obrázky z CDN */
  images: { url: string; description: string; size: 'auto' | 'small' | 'medium' | 'full';
    layout: 'block' | 'left' | 'right'; isListing?: boolean }[];
  /** Odkazy, které se mají v článku objevit (kategorie, jiné články) */
  links: { name: string; urls: Record<string, string> }[];
  /** Název je daný a nemá se vylepšovat */
  titleFixed: boolean;
  title: string;
}

export const EMPTY_BRIEF: ArticleBrief = {
  products: [], productImages: {}, includeProductImages: true,
  productLayout: 'block', productSize: 'medium',
  images: [], links: [], titleFixed: false, title: ''
};

export interface ArticleLangRow {
  lang: string;
  title: string;
  slug: string;
  short: string;
  long: string;
  seo_title: string;
  seo_desc: string;
  seo_url: string;
  state: 'empty' | 'generated' | 'manual' | 'translated' | 'imported';
  updatedAt: string | null;
  /** Počet viditelných slov — kontrola, jestli délka sedí */
  words: number;
}

export interface ArticleRow {
  id: number;
  articleId: string | null;
  topic: string;
  status: 'draft' | 'ready';
  sourceLang: string;
  wordCount: number;
  langs: string[];
  prompt: string;
  brief: ArticleBrief;
  terms: string;
  origin: 'new' | 'import';
  createdAt: string;
  updatedAt: string;
}

export interface ArticleDetail extends ArticleRow {
  versions: ArticleLangRow[];
}

function parseRow(row: any): ArticleRow {
  return {
    id: row.id,
    articleId: row.article_id ?? null,
    topic: row.topic,
    status: row.status,
    sourceLang: row.source_lang,
    wordCount: row.word_count,
    langs: safeJson(row.langs, []),
    prompt: row.prompt ?? '',
    brief: { ...EMPTY_BRIEF, ...safeJson(row.brief, {}) },
    terms: row.terms ?? '',
    origin: row.origin === 'import' ? 'import' : 'new',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function safeJson<T>(text: string | null, fallback: T): T {
  try { return text ? JSON.parse(text) : fallback; } catch { return fallback; }
}

/** Viditelná slova — HTML značky a jejich atributy se nepočítají. */
export function visibleWords(html: string): number {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ');
  return text.split(/\s+/).filter(Boolean).length;
}

export function listArticles(filter: { search?: string; status?: string } = {}): (ArticleRow & {
  title: string;
  versions: { lang: string; state: string; words: number }[];
})[] {
  const d = getDb();
  const where: string[] = [];
  const params: any[] = [];
  if (filter.status && filter.status !== 'all') { where.push('a.status = ?'); params.push(filter.status); }
  if (filter.search) {
    where.push(`(lower(a.topic) LIKE ? OR a.id IN (SELECT article_id FROM art_langs WHERE lower(title) LIKE ?))`);
    const like = `%${filter.search.toLowerCase()}%`;
    params.push(like, like);
  }
  const rows = d.prepare(
    `SELECT * FROM art_articles a ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY a.updated_at DESC LIMIT 300`
  ).all(...params) as any[];

  const versions = d.prepare(
    'SELECT article_id, lang, state, long, title FROM art_langs'
  ).all() as any[];

  return rows.map(row => {
    const mine = versions.filter(v => v.article_id === row.id);
    // V seznamu je užitečnější skutečný název než zadání — a když ještě žádný
    // není (čerstvě založený článek), zbyde zadání
    const title = mine.find(v => v.lang === row.source_lang)?.title
      || mine.find(v => v.title)?.title
      || '';
    return {
      ...parseRow(row),
      title,
      versions: mine.map(v => ({ lang: v.lang, state: v.state, words: visibleWords(v.long ?? '') }))
    };
  });
}

export function getArticle(id: number): ArticleDetail | null {
  const d = getDb();
  const row = d.prepare('SELECT * FROM art_articles WHERE id = ?').get(id) as any;
  if (!row) return null;
  const versions = d.prepare('SELECT * FROM art_langs WHERE article_id = ? ORDER BY lang').all(id) as any[];
  return {
    ...parseRow(row),
    versions: versions.map(v => ({
      lang: v.lang,
      title: v.title ?? '',
      slug: v.slug ?? '',
      short: v.short ?? '',
      long: v.long ?? '',
      seo_title: v.seo_title ?? '',
      seo_desc: v.seo_desc ?? '',
      seo_url: v.seo_url ?? '',
      state: v.state ?? 'empty',
      updatedAt: v.updated_at ?? null,
      words: visibleWords(v.long ?? '')
    }))
  };
}

export function saveArticle(input: {
  id?: number;
  topic?: string;
  status?: 'draft' | 'ready';
  sourceLang?: string;
  wordCount?: number;
  langs?: string[];
  prompt?: string;
  brief?: Partial<ArticleBrief>;
  terms?: string;
  articleId?: string | null;
  origin?: 'new' | 'import';
  rawXml?: string | null;
}): number {
  const d = getDb();
  const now = new Date().toISOString();

  if (input.id) {
    const current = d.prepare('SELECT * FROM art_articles WHERE id = ?').get(input.id) as any;
    if (!current) throw new Error('Článek už neexistuje.');
    const brief = input.brief
      ? { ...EMPTY_BRIEF, ...safeJson(current.brief, {}), ...input.brief }
      : safeJson(current.brief, EMPTY_BRIEF);
    d.prepare(
      `UPDATE art_articles SET topic = ?, status = ?, source_lang = ?, word_count = ?, langs = ?,
       prompt = ?, brief = ?, terms = ?, updated_at = ? WHERE id = ?`
    ).run(
      input.topic ?? current.topic,
      input.status ?? current.status,
      input.sourceLang ?? current.source_lang,
      input.wordCount ?? current.word_count,
      JSON.stringify(input.langs ?? safeJson(current.langs, [])),
      input.prompt ?? current.prompt,
      JSON.stringify(brief),
      input.terms ?? current.terms,
      now,
      input.id
    );
    return input.id;
  }

  const s = getArticleSettings();
  const info = d.prepare(
    `INSERT INTO art_articles (article_id, topic, status, source_lang, word_count, langs, prompt,
      brief, terms, raw_xml, origin, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    input.articleId ?? null,
    input.topic ?? '',
    input.status ?? 'draft',
    input.sourceLang ?? s.sourceLang,
    input.wordCount ?? s.wordCount,
    JSON.stringify(input.langs ?? articleLangs(s)),
    input.prompt ?? '',
    JSON.stringify({ ...EMPTY_BRIEF, ...(input.brief ?? {}) }),
    input.terms ?? '',
    input.rawXml ?? null,
    input.origin ?? 'new',
    now,
    now
  );
  return Number(info.lastInsertRowid);
}

export function saveVersion(articleId: number, lang: string, patch: Partial<ArticleLangRow>): void {
  const d = getDb();
  const now = new Date().toISOString();
  const current = d.prepare('SELECT * FROM art_langs WHERE article_id = ? AND lang = ?')
    .get(articleId, lang) as any;

  const next = {
    title: patch.title ?? current?.title ?? '',
    slug: patch.slug ?? current?.slug ?? '',
    short: patch.short ?? current?.short ?? '',
    long: patch.long ?? current?.long ?? '',
    seo_title: patch.seo_title ?? current?.seo_title ?? '',
    seo_desc: patch.seo_desc ?? current?.seo_desc ?? '',
    seo_url: patch.seo_url ?? current?.seo_url ?? '',
    state: patch.state ?? current?.state ?? 'generated'
  };

  d.prepare(
    `INSERT INTO art_langs (article_id, lang, title, slug, short, long, seo_title, seo_desc, seo_url,
      state, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(article_id, lang) DO UPDATE SET
       title = excluded.title, slug = excluded.slug, short = excluded.short, long = excluded.long,
       seo_title = excluded.seo_title, seo_desc = excluded.seo_desc, seo_url = excluded.seo_url,
       state = excluded.state, updated_at = excluded.updated_at`
  ).run(articleId, lang, next.title, next.slug, next.short, next.long,
    next.seo_title, next.seo_desc, next.seo_url, next.state, now);

  d.prepare('UPDATE art_articles SET updated_at = ? WHERE id = ?').run(now, articleId);
}

export function deleteArticle(id: number): void {
  const d = getDb();
  d.prepare('DELETE FROM art_langs WHERE article_id = ?').run(id);
  d.prepare('DELETE FROM art_links WHERE article_id = ?').run(id);
  d.prepare('DELETE FROM art_articles WHERE id = ?').run(id);
}

export function rawXml(id: number): string | null {
  const row = getDb().prepare('SELECT raw_xml FROM art_articles WHERE id = ?').get(id) as any;
  return row?.raw_xml ?? null;
}

/** Kolik článků a jazykových verzí je v databázi — do hlavičky. */
export function articleSummary() {
  const d = getDb();
  const total = (d.prepare('SELECT COUNT(*) AS n FROM art_articles').get() as any).n as number;
  const drafts = (d.prepare("SELECT COUNT(*) AS n FROM art_articles WHERE status = 'draft'").get() as any).n as number;
  const byLang = d.prepare(
    `SELECT lang, COUNT(*) AS n FROM art_langs WHERE long != '' GROUP BY lang`
  ).all() as { lang: string; n: number }[];
  return { total, drafts, byLang };
}
