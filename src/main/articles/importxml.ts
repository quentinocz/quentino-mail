import { getDb } from '../db';
import { splitArticles, tag, langScope, langsIn, fromExportLang, decode } from './xml';
import { saveArticle, saveVersion, getArticleSettings } from './store';
import { learnUrlMap } from './urlmap';

/**
 * Načtení stávajících článků z exportu Upgates.
 *
 * Export je jediný způsob, jak se aplikace o hotových článcích dozví — API na
 * ně není. Načítá se celý blok včetně `ARTICLE_ID`, aby se dal článek později
 * naimportovat zpátky jako **úprava**, ne jako nový.
 *
 * Po načtení se hned zkusí naučit mapa odkazů: články, které přeložené jsou,
 * jsou nejlepší (a jediný) zdroj toho, jak se jmenují kategorie na ostatních
 * trzích.
 */

export interface ImportResult {
  articles: number;
  updated: number;
  versions: number;
  learned: { articles: number; pairs: number; skipped: number };
}

/** Slug z plné adresy v `<URL>` — v exportu je tam celá adresa i s doménou. */
function slugFromUrl(url: string): string {
  const clean = (url ?? '').split(/[?#]/)[0].replace(/\/+$/, '');
  return clean.split('/').pop() ?? '';
}

export function importArticlesXml(xml: string): ImportResult {
  const d = getDb();
  const s = getArticleSettings();
  const blocks = splitArticles(xml);

  let created = 0;
  let updated = 0;
  let versions = 0;

  const findByUpgates = d.prepare('SELECT id FROM art_articles WHERE article_id = ?');

  for (const block of blocks) {
    const articleId = tag(block, 'ARTICLE_ID').trim();
    const created_at = tag(block, 'CREATION_TIME').trim();
    const langs = langsIn(block).map(fromExportLang);
    if (langs.length === 0) continue;

    const existing = articleId ? findByUpgates.get(articleId) as any : null;
    const sourceLang = langs.includes(s.sourceLang) ? s.sourceLang : langs[0];
    const sourceTitle = tag(langScope(block, 'DESCRIPTION', langs.includes('cz') ? 'cz' : langsIn(block)[0]), 'TITLE');

    const id = saveArticle({
      id: existing?.id,
      articleId: articleId || null,
      topic: existing ? undefined : shortTopic(sourceTitle),
      status: 'ready',
      sourceLang,
      langs,
      origin: 'import',
      rawXml: block
    });
    if (existing) updated++; else created++;

    // `raw_xml` se u aktualizace nepřepisuje přes saveArticle — je to jediné
    // místo, kde se hodí sáhnout přímo, aby se export vždy stavěl z čerstvého
    d.prepare('UPDATE art_articles SET raw_xml = ?, created_at = COALESCE(NULLIF(?, \'\'), created_at) WHERE id = ?')
      .run(block, created_at, id);

    for (const exportLang of langsIn(block)) {
      const lang = fromExportLang(exportLang);
      const desc = langScope(block, 'DESCRIPTION', exportLang);
      const seo = langScope(block, 'SEO', exportLang);
      const url = tag(desc, 'URL');
      const seoUrl = tag(seo, 'SEO_URL') || slugFromUrl(url);

      saveVersion(id, lang, {
        title: tag(desc, 'TITLE'),
        slug: slugFromUrl(url) || seoUrl,
        short: tag(desc, 'SHORT_DESCRIPTION'),
        long: tag(desc, 'LONG_DESCRIPTION'),
        seo_title: tag(seo, 'SEO_TITLE'),
        seo_desc: tag(seo, 'SEO_META_DESCRIPTION'),
        seo_url: seoUrl,
        state: 'imported'
      });
      versions++;
    }
  }

  return { articles: created, updated, versions, learned: learnUrlMap() };
}

/** Z názvu udělá krátké zadání, ať má článek v seznamu co ukázat. */
function shortTopic(title: string): string {
  const clean = decode(title).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return clean.slice(0, 120);
}
