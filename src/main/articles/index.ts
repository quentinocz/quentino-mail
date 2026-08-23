import { BrowserWindow, dialog } from 'electron';
import fs from 'fs';
import { getDb } from '../db';
import { getArticleSettings, saveArticleSettings, defaultArticlePrompt, articleLangs,
  listArticles, getArticle, saveArticle, saveVersion, deleteArticle, rawXml, articleSummary,
  ArticleSettings } from './store';
import { buildArticle, wrapTexts, ArticleVersionXml } from './xml';
import { importArticlesXml } from './importxml';
import { generateArticle, translateArticle, articleProgress, stopArticles, researchTerms,
  productsForArticle, GenerateInput } from './generate';
import { checkLinks, lastCheck, applyFix, applyAllFixes, dismissLink, checkProgress, stopCheck, CheckOptions } from './check';
import { learnUrlMap, listUrlMap, rememberPair, deletePair, extractImages, extractLinks } from './urlmap';

/**
 * Články — vstupní bod pro zbytek aplikace.
 *
 * Modul je záměrně **jen na počítači**. Psaní a překlad článků je práce na
 * velké obrazovce se dvěma okny vedle sebe; na telefonu by z toho byl jen
 * zdroj překlepů.
 */

function emit(channel: string, payload: unknown) {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload);
}

export function overview() {
  return {
    settings: getArticleSettings(),
    summary: articleSummary(),
    running: articleProgress(),
    checking: checkProgress(),
    urlmap: listUrlMap().length
  };
}

/** Nahrání exportu článků z Upgates. */
export async function importFromFile() {
  const win = BrowserWindow.getFocusedWindow();
  const res = await dialog.showOpenDialog(win!, {
    properties: ['openFile'],
    filters: [{ name: 'XML export článků z Upgates', extensions: ['xml'] }]
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  const result = importArticlesXml(fs.readFileSync(res.filePaths[0], 'utf8'));
  emit('articles:changed', {});
  return { ...result, file: res.filePaths[0] };
}

/** Export vybraných článků do XML pro import zpět do Upgates. */
export async function exportToFile(input: { ids?: number[]; langs?: string[]; onlyReady?: boolean } = {}) {
  const d = getDb();
  const langs = input.langs?.length ? input.langs : articleLangs();
  const ids = input.ids?.length
    ? input.ids
    : (d.prepare(`SELECT id FROM art_articles${input.onlyReady === false ? '' : " WHERE status = 'ready'"}`)
        .all() as any[]).map(row => row.id);

  const blocks: string[] = [];
  let versions = 0;

  for (const id of ids) {
    const article = getArticle(id);
    if (!article) continue;
    const usable = article.versions.filter(v => langs.includes(v.lang) && v.long);
    if (usable.length === 0) continue;

    const first = usable[0];
    // Obrázky se berou z textu — do XML patří ty, které v článku opravdu jsou
    const images = [...new Set(extractImages(first.long))].map((url, index) => ({
      url,
      description: first.title,
      isListing: index === 0
    }));

    blocks.push(buildArticle(usable as ArticleVersionXml[], {
      articleId: article.articleId,
      images,
      createdAt: article.createdAt
    }));
    versions += usable.length;
  }

  if (blocks.length === 0) throw new Error('Není co exportovat — vyber článek, který má hotový text.');

  const win = BrowserWindow.getFocusedWindow();
  const stamp = new Date().toISOString().slice(0, 10);
  const res = await dialog.showSaveDialog(win!, {
    defaultPath: `quentino-clanky-${stamp}.xml`,
    filters: [{ name: 'XML pro import do Upgates', extensions: ['xml'] }]
  });
  if (res.canceled || !res.filePath) return null;
  fs.writeFileSync(res.filePath, wrapTexts(blocks), 'utf8');
  return { path: res.filePath, articles: blocks.length, versions };
}

/** Náhled článku bez ukládání — HTML se zobrazí v okně. */
export function preview(id: number, lang: string): { title: string; html: string; words: number } | null {
  const article = getArticle(id);
  const version = article?.versions.find(v => v.lang === lang);
  if (!article || !version) return null;
  return { title: version.title, html: version.long, words: version.words };
}

/** Odkazy v jednom článku — přehled, na co se v textu odkazuje. */
export function articleLinks(id: number, lang: string) {
  const article = getArticle(id);
  const version = article?.versions.find(v => v.lang === lang);
  if (!version) return [];
  return [...new Set(extractLinks(version.long))];
}

/**
 * Článek pro **ruční kontrolu** odkazů.
 *
 * Automatická kontrola umí říct, že adresa nevrací 200. Neumí říct, jestli
 * odkaz míří tam, kam podle textu mířit má — a to je to, co se pozná jedině
 * pohledem. Proto se článek vrací vykreslený, s každým odkazem očíslovaným a
 * obarveným podle posledního výsledku kontroly. V okně se to zobrazí tak, jak
 * to uvidí čtenář, a u každého odkazu je vidět, kam vede.
 *
 * Odkazy se otevírají v prohlížeči, ne v aplikaci — kliknutí je tím nejrychlejším
 * způsobem, jak si ověřit, že cíl opravdu existuje a je to ten správný produkt.
 */
export function articleReview(id: number, lang: string): {
  title: string;
  html: string;
  links: { index: number; url: string; text: string; kind: string; status: number | null;
    note: string; suggestion: string | null; unverified: boolean }[];
} | null {
  const article = getArticle(id);
  const version = article?.versions.find(v => v.lang === lang);
  if (!article || !version) return null;

  const checks = new Map(
    (lastCheck().filter(row => row.articleId === id && row.lang === lang))
      .map(row => [row.url, row])
  );

  const links: {
    index: number; url: string; text: string; kind: string; status: number | null;
    note: string; suggestion: string | null; unverified: boolean;
  }[] = [];

  // Odkazy se očíslují přímo v textu, aby šel seznam pod článkem a odkaz
  // v textu spojit pohledem
  let index = 0;
  const html = version.long.replace(
    /<a\b([^>]*?)\bhref\s*=\s*(["'])([^"']+)\2([^>]*)>([\s\S]*?)<\/a>/gi,
    (_match, before, quote, href, after, inner) => {
      index++;
      const found = checks.get(href);
      const tone = !found ? 'ok' : found.unverified ? 'unknown' : 'bad';
      links.push({
        index,
        url: href,
        text: String(inner).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80),
        kind: found?.kind ?? 'other',
        status: found?.status ?? null,
        note: found?.note ?? '',
        suggestion: found?.suggestion ?? null,
        unverified: !!found?.unverified
      });
      return `<a${before}href=${quote}${href}${quote}${after}`
        + ` data-link="${index}" data-tone="${tone}" target="_blank" rel="noreferrer">`
        + `${inner}<sup class="lnk">${index}</sup></a>`;
    }
  );

  return { title: version.title, html, links };
}

export function editVersion(id: number, lang: string, patch: Record<string, string>) {
  saveVersion(id, lang, { ...patch, state: 'manual' } as any);
  emit('articles:changed', { id });
  return getArticle(id);
}

export function learnLinks() {
  const result = learnUrlMap();
  emit('articles:changed', {});
  return result;
}

export function saveUrlPair(fromLang: string, fromPath: string, toLang: string, toPath: string, kind: string) {
  rememberPair(fromLang, fromPath, toLang, toPath, kind as any, true);
  return listUrlMap();
}

export {
  getArticleSettings, saveArticleSettings, defaultArticlePrompt, articleLangs,
  listArticles, getArticle, saveArticle, deleteArticle, rawXml, articleSummary,
  generateArticle, translateArticle, articleProgress, stopArticles, researchTerms, productsForArticle,
  checkLinks, lastCheck, applyFix, applyAllFixes, dismissLink, checkProgress, stopCheck,
  listUrlMap, deletePair, importArticlesXml
};
export type { ArticleSettings, GenerateInput, CheckOptions };
