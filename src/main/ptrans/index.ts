import { BrowserWindow, dialog } from 'electron';
import fs from 'fs';
import { getSetting } from '../db';
import { syncFromFeed, ingestFile, getPtransSettings, savePtransSettings, listProducts, productFields,
  saveTranslation, summary, feedInfo, targetLangs, SyncResult } from './store';
import { run, stop, progress, planWork, translateOne } from './translate';
import { applyGoogleTitles, generateSeo, previewTemplate, refreshSeoUrl, SeoKind } from './seo';
import { buildExport, exportPreview, ExportOptions } from './exportxml';
import { findDeviations, patternOverview, patternFor, derivePattern } from './consistency';
import { setSeoUrl, previewRedirect } from './redirects';

/**
 * Překlady produktů — vstupní bod pro zbytek aplikace.
 *
 * Feed se stahuje jednou a slouží dvěma věcem: lehkému katalogu pro
 * našeptávání produktů v poště a chatu (`products.ts`) a téhle podrobné
 * databázi pro překlady. Proto se tady nic nestahuje samo — `products.ts`
 * po stažení zavolá `syncFeedXml`.
 */

function emit(channel: string, payload: unknown) {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload);
}

/** Zpracuje čerstvě stažený feed. Voláno po každém stažení. */
export function syncFeedXml(xml: string): SyncResult {
  const result = syncFromFeed(xml);
  emit('ptrans:changed', {});
  return result;
}

/** Ruční „načíst znovu" z rozhraní: stáhne feed a přepočítá stavy. */
export async function refreshFromUrl(): Promise<SyncResult> {
  const url = (getSetting('productFeedUrl', '') ?? '').trim();
  if (!url) throw new Error('Není vyplněná adresa produktového feedu (Nastavení → Produkty).');
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Feed se nepodařilo stáhnout (HTTP ${res.status})`);
  return syncFeedXml(await res.text());
}

/**
 * Přidání produktů z ručně nahraného XML.
 *
 * Používá se na novinky, které v online feedu ještě nejsou. Až se ve feedu
 * objeví, spárují se podle kódu a překlady u nich zůstanou.
 */
export async function importFromFile(): Promise<(SyncResult & { file: string }) | null> {
  const win = BrowserWindow.getFocusedWindow();
  const res = await dialog.showOpenDialog(win!, {
    properties: ['openFile'],
    filters: [{ name: 'XML export z Upgates', extensions: ['xml'] }]
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  const xml = fs.readFileSync(res.filePaths[0], 'utf8');
  const result = ingestFile(xml);
  emit('ptrans:changed', {});
  return { ...result, file: res.filePaths[0] };
}

/** Názvy, které se vymykají tvaru své kategorie. */
export function consistencyCheck(lang: string) {
  return {
    patterns: patternOverview(lang),
    deviations: findDeviations(lang)
  };
}

/** Nabídne tvar názvu odvozený z hotových překladů v kategorii. */
export function suggestPattern(category: string, lang: string): string {
  return patternFor(category, lang).pattern;
}

/** Přehled pro hlavičku prohlížeče. */
export function overview() {
  const settings = getPtransSettings();
  return {
    settings,
    feed: feedInfo(),
    langs: summary(),
    running: progress()
  };
}

/** Ruční úprava jednoho pole — od té chvíle na něj překladač nesahá. */
export function editField(code: string, lang: string, field: string, value: string): void {
  if (field === 'seo_url') {
    // Ruční změna adresy je stejná změna jako ta od překladače — musí po ní
    // zůstat přesměrování ze staré adresy
    setSeoUrl(code, lang, value, 'ruční', true);
  } else {
    saveTranslation(code, lang, field, value, 'ruční', true);
  }
  emit('ptrans:changed', {});
}

/** Co se doplní do přesměrování, když se adresa změní na zadanou. */
export function redirectPreview(code: string, lang: string, slug: string) {
  return previewRedirect(code, lang, slug);
}

/** Přeložit jedno pole znovu (tlačítko „přegenerovat" u konkrétního textu). */
export async function retranslateField(code: string, lang: string, field: string): Promise<string> {
  const result = await translateOne({ code, lang, fields: [field], force: true });
  if (result.error) throw new Error(result.error);
  emit('ptrans:changed', {});
  const row = productFields(code, [lang]).find(f => f.field === field);
  return row?.translated ?? '';
}

/** Uloží export do souboru, který si uživatel vybere. */
export async function exportToFile(options: ExportOptions = {}): Promise<{ path: string; products: number; fields: number } | null> {
  const built = buildExport(options);
  if (built.products === 0) throw new Error('Není co exportovat — zatím není žádný uložený překlad.');

  const win = BrowserWindow.getFocusedWindow();
  const stamp = new Date().toISOString().slice(0, 10);
  const res = await dialog.showSaveDialog(win!, {
    defaultPath: `quentino-preklady-${built.langs.join('-')}-${stamp}.xml`,
    filters: [{ name: 'XML pro import do Upgates', extensions: ['xml'] }]
  });
  if (res.canceled || !res.filePath) return null;
  fs.writeFileSync(res.filePath, built.xml, 'utf8');
  return { path: res.filePath, products: built.products, fields: built.fields };
}

export {
  getPtransSettings, savePtransSettings, listProducts, productFields, summary, targetLangs,
  derivePattern,
  run, stop, progress, planWork,
  applyGoogleTitles, generateSeo, previewTemplate, refreshSeoUrl,
  buildExport, exportPreview
};
export type { SeoKind, ExportOptions };
