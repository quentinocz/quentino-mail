import { BrowserWindow, dialog } from 'electron';
import fs from 'fs';
import { getDb, getSetting } from '../db';
import { getUpgatesConfig } from '../upgates';
import { fillFileInput, openUrl } from '../formfile';
import { signIn, signInNote, keepSignedIn } from '../portallogin';
import { getArticleSettings, saveArticleSettings, defaultArticlePrompt, articleLangs,
  listArticles, getArticle, saveArticle, saveVersion, deleteArticle, rawXml, articleSummary,
  ArticleSettings } from './store';
import { buildArticle, wrapTexts, ArticleVersionXml } from './xml';
import { importArticlesXml } from './importxml';
import { generateArticle, translateArticle, articleProgress, stopArticles, researchTerms,
  productsForArticle, GenerateInput } from './generate';
import { checkLinks, lastCheck, applyFix, applyAllFixes, dismissLink, testUrl, checkProgress, stopCheck, CheckOptions } from './check';
import { learnUrlMap, listUrlMap, rememberPair, deletePair, extractImages, extractLinks, decodeUrl,
  translateUrl, alternatesOf } from './urlmap';

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
    /*
     * Do galerie článku jde **jen listingový obrázek**.
     *
     * Ostatní obrázky jsou v textu na svém místě — s popiskem, velikostí
     * a obtékáním, jak se do článku hodí. Kdyby se posílaly i do `<IMAGES>`,
     * e-shop je vysází ještě jednou do galerie pod článkem a čtenář uvidí
     * všechno dvakrát. Listingový je výjimka: ten se v textu neukazuje
     * vůbec a slouží jako náhled v seznamu článků.
     */
    const listing = article.brief.images.find(img => img.isListing && img.url)
      ?? article.brief.images.find(img => img.url);
    const fromText = extractImages(first.long)[0];
    const cover = (listing?.url || fromText || '').trim();
    const images = cover
      ? [{ url: cover, description: listing?.description || first.title, isListing: true }]
      : [];

    blocks.push(buildArticle(usable as ArticleVersionXml[], {
      articleId: article.articleId,
      images,
      categories: getArticleSettings().categories,
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

  /*
   * Import se otevře rovnou. Exportovat a pak v administraci hledat, který
   * ze stažených souborů je ten poslední, je krok navíc, který se dá udělat
   * za člověka — a zrovna u něj se dá snadno sáhnout po starém souboru.
   */
  let opened: { filled: boolean; note: string } | null = null;
  if (getArticleSettings().openImport !== false) {
    try {
      opened = await openArticleImport(res.filePath);
    } catch (e: any) {
      opened = { filled: false, note: `Import se nepodařilo otevřít: ${String(e?.message ?? e)}` };
    }
  }
  return { path: res.filePath, articles: blocks.length, versions, opened };
}

/* ---------- import zpátky do e-shopu ---------- */

let importWin: BrowserWindow | null = null;

/**
 * Adresa stránky s importem textů.
 *
 * Napevno zapsat nejde: v adrese je číslo serveru, na kterém e-shop běží
 * (`…s19.upgates.com`), a to má každý jiné. Bere se z nastavení článků,
 * jinak se složí z adresy administrace, kterou už aplikace zná kvůli
 * fakturám.
 */
export function articleImportUrl(): string {
  const saved = (getArticleSettings().importUrl ?? '').trim();
  if (saved) return saved;
  const home = (getSetting('invoiceAdminHome', '') ?? '').trim()
    || `${getUpgatesConfig().url.replace(/\/+$/, '')}/manager/`;
  const root = home.replace(/\/manager\/?$/, '').replace(/\/+$/, '');
  return `${root}/setup/export-import/default/guide/texts/`;
}

/**
 * Otevře import v administraci e-shopu a vloží do něj vyexportovaný soubor.
 *
 * Stejná cesta jako u dopravců: okno s vlastním trvalým sezením, přihlášení
 * se vyplní samo a soubor se vloží, jakmile se políčko objeví. **Odeslání
 * se nekliká** — import textů přepisuje články na webu a to je krok, který
 * patří člověku.
 */
export async function openArticleImport(file: string): Promise<{ filled: boolean; note: string }> {
  const win = importWin && !importWin.isDestroyed() ? importWin : new BrowserWindow({
    width: 1200, height: 860,
    title: 'Import článků do e-shopu',
    webPreferences: { partition: 'persist:upgates', sandbox: true }
  });
  importWin = win;
  win.on('closed', () => { importWin = null; });

  keepSignedIn(win, 'upgates');
  await openUrl(win, articleImportUrl());
  win.show();
  win.focus();
  const login = signInNote('upgates', await signIn(win, 'upgates'));

  const out = await fillFileInput(win, file);
  const note = out.filled
    ? 'Soubor je vložený. Zkontroluj nastavení importu a spusť ho.'
    : out.note;
  return { filled: out.filled, note: [login, note].filter(Boolean).join(' ') };
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
      // V HTML je `&` zapsané jako `&amp;`; kontrola pracuje s adresou tak,
      // jak se posílá na síť, takže se musí porovnávat rozkódovaná
      const clean = decodeUrl(href);
      const found = checks.get(clean);
      const tone = !found ? 'ok' : found.unverified ? 'unknown' : 'bad';
      links.push({
        index,
        url: clean,
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

/**
 * Adresy téže stránky na ostatních trzích.
 *
 * Do článku se odkaz zadává česky a slovenská a anglická verze se má
 * dohledat sama — ručně opisovat tři adresy u každého odkazu je práce,
 * kterou aplikace umí udělat za člověka, protože mapu adres má.
 *
 * Vrací se i **jak** se adresa našla: `product`/`map` znamená, že ji
 * aplikace zná z dat, kdežto `domain` je jen vyměněná doména — tedy odhad,
 * který nemusí existovat. To se musí poznat, jinak by se do článku dostal
 * odkaz do prázdna.
 */
export async function linkUrls(url: string, fromLang?: string, probe = true) {
  const clean = decodeUrl(String(url ?? '').trim());
  const source = fromLang || getArticleSettings().sourceLang;
  const out: Record<string, { url: string; via: string; kind: string }> = {};
  if (!clean) return out;

  for (const lang of articleLangs()) {
    const resolved = translateUrl(clean, source, lang);
    out[lang] = { url: resolved.url, via: resolved.via, kind: resolved.kind };
  }

  /*
   * Co zbylo jen na odhadu (vyměněná doména), se zkusí zjistit **od
   * stránky samotné**: v hlavičce má přepínač jazyků a v něm odkaz na
   * tutéž stránku na ostatním trhu. Odhadovat `/ponozky` → `/socks` z ničeho
   * nejde, ale e-shop to ví. Stahuje se jen tehdy, když je co zjišťovat,
   * a výsledek se uloží do mapy, takže podruhé se nikam nechodí.
   */
  const missing = Object.entries(out).filter(([lang, one]) =>
    lang !== source && one.via === 'domain');
  if (probe && missing.length > 0 && /^https?:\/\//i.test(clean)) {
    const found = await alternatesOf(clean);
    for (const [lang] of missing) {
      if (found[lang]) out[lang] = { url: found[lang], via: 'page', kind: out[lang].kind };
    }
  }
  return out;
}

export function saveUrlPair(fromLang: string, fromPath: string, toLang: string, toPath: string, kind: string) {
  rememberPair(fromLang, fromPath, toLang, toPath, kind as any, true);
  return listUrlMap();
}

export {
  getArticleSettings, saveArticleSettings, defaultArticlePrompt, articleLangs,
  listArticles, getArticle, saveArticle, deleteArticle, rawXml, articleSummary,
  generateArticle, translateArticle, articleProgress, stopArticles, researchTerms, productsForArticle,
  checkLinks, lastCheck, applyFix, applyAllFixes, dismissLink, testUrl, checkProgress, stopCheck,
  listUrlMap, deletePair, importArticlesXml
};
export type { ArticleSettings, GenerateInput, CheckOptions };
