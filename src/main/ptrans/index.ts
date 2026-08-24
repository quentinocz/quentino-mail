import { BrowserWindow, dialog } from 'electron';
import fs from 'fs';
import { getSetting } from '../db';
import { syncFromFeed, ingestFile, ingestNewOnly, revertToFeed, recomputeStates,
  getPtransSettings, savePtransSettings, listProducts, productFields,
  saveTranslation, summary, feedInfo, targetLangs, SyncResult } from './store';
import { run, stop, progress, planWork, translateOne } from './translate';
import { applyGoogleTitles, generateSeo, previewTemplate, refreshSeoUrl, SeoKind } from './seo';
import { buildExport, exportPreview, ExportOptions } from './exportxml';
import { findDeviations, patternOverview, patternFor, derivePattern,
  suggestFix, applyFix, FixProposal } from './consistency';
import { listStyles, forgetStyle, caseStyleFor, feedExamples, LearnedStyle } from './style';
import { listTrials, countOpenTrials, decideTrial, dismissTrial, affectedByTrial, Trial } from './trials';
import { setSeoUrl, previewRedirect } from './redirects';
import { listMemory, saveMemory, deleteMemory, learnFromFeed, memoryStats, MemoryEntry, MemoryKind, LearnResult } from './memory';
import { listColorRules, saveColorRule, deleteColorRule, learnColors, colorCoverage,
  BASE_COLORS, baseColorOf, ColorRule } from './colors';
import { listBundleRules, saveBundleRule, deleteBundleRule, teachBundle, detectBundle,
  bundlePreview, BundleRule } from './bundle';
import { writeGoogleText, writeGoogleTexts, applyAttributes, googleView,
  getAttributeRules, saveAttributeRules, GOOGLE_LABELS, AttributeRules, GoogleField } from './google';
import { runAudit, auditFor, worstProducts, auditProduct, storedSummary, AuditOptions, ProductAudit } from './audit';
import { planSourceFill, fillSourceOne, missingByField, SOURCE_FIELDS, SOURCE_LABELS,
  SourceField, SourceFillOptions } from './source';

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

async function downloadFeed(): Promise<string> {
  const url = (getSetting('productFeedUrl', '') ?? '').trim();
  if (!url) throw new Error('Není vyplněná adresa produktového feedu (Nastavení → Produkty).');
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Feed se nepodařilo stáhnout (HTTP ${res.status})`);
  return res.text();
}

/**
 * Stáhne feed znovu a srovná podle něj celou databázi.
 *
 * Tohle je ta „velká" varianta: projde všechny produkty, přepočítá stavy a
 * uklidí, co z e-shopu zmizelo. Používá se, když se export naimportoval do
 * Upgates a aplikace se má dozvědět, co se doopravdy uložilo.
 */
export async function refreshFromUrl(): Promise<SyncResult> {
  return syncFeedXml(await downloadFeed());
}

/**
 * Stáhne feed, ale vezme z něj **jen produkty, které aplikace ještě nezná**.
 *
 * Rozdíl proti předchozímu je záměrný: rozpracované produkty se nedotkne.
 * Když do e-shopu přibylo pět novinek, není důvod kvůli nim sahat na tisíc
 * ostatních.
 */
export async function refreshNewOnly(): Promise<SyncResult> {
  const result = ingestNewOnly(await downloadFeed());
  emit('ptrans:changed', {});
  return result;
}

/**
 * Zahodí u vybraných produktů, co aplikace vymyslela, a nechá platit feed.
 *
 * Vrací se tím ke stavu, který je právě teď v e-shopu — proto se předtím feed
 * stáhne znovu, jinak by se aplikace vracela k něčemu zastaralému.
 */
export async function revertProducts(codes: string[], keepManual = false):
  Promise<{ fields: number; products: number }> {
  if (codes.length === 0) throw new Error('Nejsou vybrané žádné produkty.');
  await refreshFromUrl();
  const fields = revertToFeed(codes, { keepManual });
  emit('ptrans:changed', {});
  return { fields, products: codes.length };
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

/**
 * Návrh, jak vybočující název srovnat. Nic se nepřepisuje — vrací se návrh
 * a čeká se na člověka.
 */
export async function proposeFix(code: string, lang: string) {
  return suggestFix(code, lang);
}

/** Přijetí návrhu. Zapíše se jako ruční úprava, ať to překlad nepřepíše. */
export function acceptFix(code: string, lang: string, value: string) {
  applyFix(code, lang, value);
  emit('ptrans:changed', {});
  return true;
}

/* ---------- vybrané tvary textů ---------- */

/** Dvojice variant, o kterých se ještě nerozhodlo. */
export function styleTrials(lang?: string) {
  return { trials: listTrials({ lang }), open: countOpenTrials(), styles: listStyles(lang) };
}

/**
 * Rozhodnutí uživatele.
 *
 * Vrací se i seznam produktů z téže kategorie, protože hned potom se
 * nabízí přepsat je podle vybraného tvaru — samotné rozhodnutí by jinak
 * změnilo jediný produkt a zbytek by zůstal po starém.
 */
export function chooseVariant(id: number, pick: 'a' | 'b') {
  const affected = affectedByTrial(id);
  const trial = decideTrial(id, pick);
  emit('ptrans:changed', {});
  return { trial, affected: affected.codes, category: affected.category, lang: affected.lang };
}

export function dropTrial(id: number) {
  dismissTrial(id);
  emit('ptrans:changed', {});
  return true;
}

export function dropStyle(lang: string, category: string, kind: string) {
  forgetStyle(lang, category, kind);
  emit('ptrans:changed', {});
  return true;
}

/**
 * Naučí se slovosled a ustálené výrazy z produktů, které už jsou ve feedu
 * přeložené. Pouští se ručně z rozhraní — je to práce na pár vteřin, ale mění
 * to, jak budou vypadat všechny další překlady.
 */
export function learnMemory(langs?: string[]): LearnResult[] {
  const result = learnFromFeed(langs);
  emit('ptrans:changed', {});
  return result;
}

/** Ruční zásah do paměti — zápis se zamkne, aby ho učení nepřepsalo. */
export function editMemory(entry: MemoryEntry): MemoryEntry[] {
  saveMemory({ ...entry, origin: 'manual', locked: true });
  return listMemory({ lang: entry.lang, kind: entry.kind });
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
    running: progress(),
    colors: colorCoverage(),
    googleRules: getAttributeRules()
  };
}

/* ---------- Google Nákupy ---------- */

/** Naučí se převody odstínů na základní barvy z produktů, které je vyplněné mají. */
export function learnColorMap() {
  const result = learnColors();
  emit('ptrans:changed', {});
  return result;
}

/** Ruční převod odstínu — zamkne se, učení ho nepřepíše. */
export function saveColor(source: string, base: string): ColorRule[] {
  saveColorRule(source, base, true);
  emit('ptrans:changed', {});
  return listColorRules();
}

/**
 * Otočení rozhodnutí o setu.
 *
 * Kromě uložení u produktu se z toho stane pravidlo pro stejný tvar názvu —
 * tak se aplikace naučí, které sety u Quentina setem jsou a které ne.
 */
export function markBundle(code: string, isBundle: boolean, langs?: string[]): BundleRule | null {
  const rule = teachBundle(code, isBundle);
  const s = getPtransSettings();
  const list = langs?.length ? langs : [s.sourceLang, ...targetLangs(s)];
  for (const lang of list) {
    saveTranslation(code, lang, 'google_bundle', isBundle ? 'yes' : 'no', 'ruční', true);
  }
  emit('ptrans:changed', {});
  return rule;
}

/** Zapíše číselníkové atributy (barva, pohlaví, věk, stav, set) vybraným produktům. */
export function fillAttributes(codes: string[], langs?: string[], force = false) {
  const result = applyAttributes(codes, langs, force);
  emit('ptrans:changed', {});
  return result;
}

/** Nechá model napsat titulek nebo popis pro Google u jednoho produktu. */
export async function writeGoogle(code: string, lang: string,
  kind: 'google_title' | 'google_desc'): Promise<string> {
  const value = await writeGoogleText(code, lang, kind);
  emit('ptrans:changed', {});
  return value;
}

/* ---------- audit ---------- */

/**
 * Projde feed a u každého produktu vypíše, co brání tomu, aby se dobře
 * dohledal. Výsledek se ukládá, takže se v kartě produktu ukáže hned.
 */
export function audit(options: AuditOptions = {}) {
  const result = runAudit(options);
  emit('ptrans:changed', {});
  return result;
}

/**
 * Kolik zdrojových textů u výběru chybí — podklad pro dialog spuštění.
 *
 * Ukazuje se po polích, protože rozhodnutí zní „SEO ano, Google ne", ne
 * „doplnit 240 věcí".
 */
export function sourceGaps(codes: string[]) {
  return {
    fields: missingByField(codes),
    total: planSourceFill({ codes }).length,
    sourceLang: getPtransSettings().sourceLang
  };
}

/** Doplní zdrojové texty bez překladu — pro případ, že jde jen o češtinu. */
export async function fillSourceTexts(options: SourceFillOptions):
  Promise<{ done: number; failed: number; errors: string[] }> {
  const work = planSourceFill(options);
  const errors: string[] = [];
  let done = 0;
  let failed = 0;
  for (const target of work) {
    const result = await fillSourceOne(target.code, target.field);
    if (result.error) { failed++; if (errors.length < 20) errors.push(result.error); }
    else done++;
  }
  emit('ptrans:changed', {});
  return { done, failed, errors };
}

/** Uložený výsledek auditu pro jeden produkt. */
export function auditOf(code: string, langs?: string[]): ProductAudit[] {
  return auditFor(code, langs);
}

/**
 * Spraví vady, které audit označil jako opravitelné.
 *
 * Každý druh vady má svůj způsob nápravy a je jich jen několik — číselníky
 * dopočítá kód, texty napíše model, adresu složí přepis. Vady, které opravit
 * nejde (chybí obrázek, chybí parametr Materiál), se přeskočí a vrátí se
 * v `skipped`; ty musí někdo doplnit v e-shopu, aplikace si je nevymyslí.
 */
export async function fixIssues(code: string, lang: string, keys?: string[]):
  Promise<{ fixed: string[]; skipped: string[] }> {
  const found = auditFor(code, [lang])[0];
  if (!found) throw new Error('Produkt není v databázi.');

  const wanted = found.issues.filter(issue =>
    issue.fixable && (!keys?.length || keys.includes(issue.key)));

  const fixed: string[] = [];
  const skipped = found.issues
    .filter(issue => !issue.fixable)
    .map(issue => issue.key);

  // Číselníky se dopočítají všechny naráz — je to jedno volání a levné
  if (wanted.some(issue => issue.key.startsWith('google_color')
    || issue.key.startsWith('google_gender') || issue.key.startsWith('google_age')
    || issue.key.startsWith('google_condition') || issue.key.startsWith('google_bundle')
    || issue.key.startsWith('identifier'))) {
    applyAttributes([code], [lang]);
    for (const issue of wanted) {
      if (issue.key.startsWith('google_') || issue.key.startsWith('identifier')) {
        if (!issue.key.startsWith('google_title') && !issue.key.startsWith('google_desc')) {
          fixed.push(issue.key);
        }
      }
    }
  }

  for (const issue of wanted) {
    try {
      if (issue.key.startsWith('seo_title')) {
        await generateSeo(code, lang, 'seo_title');
      } else if (issue.key.startsWith('seo_desc')) {
        await generateSeo(code, lang, 'seo_desc');
      } else if (issue.key.startsWith('seo_url')) {
        refreshSeoUrl(code, lang);
      } else if (issue.key.startsWith('google_title')) {
        await writeGoogleText(code, lang, 'google_title');
      } else if (issue.key.startsWith('google_desc')) {
        await writeGoogleText(code, lang, 'google_desc');
      } else if (issue.key === 'title.untranslated') {
        await retranslateField(code, lang, 'title');
      } else {
        continue;
      }
      if (!fixed.includes(issue.key)) fixed.push(issue.key);
    } catch {
      skipped.push(issue.key);
    }
  }

  // Nový stav se rovnou přepočítá, ať karta ukazuje výsledek, ne minulost
  auditFor(code, [lang]);
  runAudit({ codes: [code], langs: [lang] });
  emit('ptrans:changed', {});
  return { fixed, skipped };
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
  derivePattern, recomputeStates,
  run, stop, progress, planWork,
  applyGoogleTitles, generateSeo, previewTemplate, refreshSeoUrl,
  buildExport, exportPreview,
  listMemory, deleteMemory, memoryStats,
  listColorRules, deleteColorRule, BASE_COLORS, baseColorOf,
  listBundleRules, saveBundleRule, deleteBundleRule, detectBundle, bundlePreview,
  googleView, writeGoogleTexts, saveAttributeRules, getAttributeRules, GOOGLE_LABELS,
  worstProducts, auditProduct, storedSummary,
  SOURCE_FIELDS, SOURCE_LABELS,
  listStyles, listTrials, countOpenTrials, caseStyleFor, feedExamples
};
export type {
  SeoKind, ExportOptions, MemoryEntry, MemoryKind, LearnResult,
  ColorRule, BundleRule, AttributeRules, GoogleField, AuditOptions, ProductAudit,
  SourceField, SourceFillOptions, FixProposal, LearnedStyle, Trial
};
