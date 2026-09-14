import { BrowserWindow } from 'electron';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { getDb, getSetting, setSetting } from '../../db';
import { fillFileInput, openUrl } from '../../formfile';
import { keepSignedIn, signIn, signInNote } from '../../portallogin';
import { getUpgatesConfig } from '../../upgates';
import { getPtransSettings, targetLangs, ingestFile, fieldValue, saveTranslation } from '../store';
import { fillSourceOne, SOURCE_FIELDS } from '../source';
import { applyAttributes } from '../google';
import { translateOne } from '../translate';
import { buildExport } from '../exportxml';
import { paramKey } from '../xml';
import { categoryTree, refreshCategories, CategoryTree } from '../categories';
import { DraftProduct, DraftGap, draftGaps, listDrafts, getDraft,
  newDraft, saveDraft, deleteDraft, emptyTexts } from './draft';
import { loadTemplate, findSpecifics, codeTaken, Specific } from './template';
import { rewriteSelection, proposeByTitle, TextChange } from './rewrite';
import { buildProductXml } from './build';
import { swapLinks } from './links';
import { learnParams, paramNames, paramValues, lookupParam, resolveParams, suggestParams,
  ParamEntry, ParamProposal } from './params';

/**
 * Nový produkt — od prázdného formuláře po XML pro import.
 *
 * Postup má čtyři kroky a každý se dá zopakovat zvlášť:
 *
 *  1. **vyplnění** češtiny (rozdělaný produkt žije v `ptrans_drafts`),
 *  2. **uložení do katalogu** — z rozdělaného produktu se poskládá blok XML
 *     ve tvaru feedu a vloží se do `ptrans_products` jako produkt s původem
 *     „file"; od té chvíle na něj platí všechno ostatní, co aplikace umí,
 *  3. **doplnění** SEO, textů pro Google a překladů do SK a EN — přesně
 *     stejnou cestou jako u produktů z feedu, ne zvláštní větví,
 *  4. **export** a vložení do importu v administraci.
 *
 * Ten druhý krok je jádro celého návrhu. Kdyby si nový produkt vedl vlastní
 * překlady, byla by v aplikaci druhá sada pravidel pro totéž — a rozešla by
 * se s tou první při první opravě.
 */

function emit(payload: unknown) {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('ptrans:changed', payload);
}

function langsOf(): string[] {
  const s = getPtransSettings();
  return [s.sourceLang, ...targetLangs(s)];
}

export interface NewProductState {
  drafts: (DraftProduct & { gaps: DraftGap[] })[];
  langs: string[];
  sourceLang: string;
  categories: CategoryTree | null;
  /** Měna, ve které e-shop v daném jazyce prodává — čte se z feedu */
  currencies: Record<string, string>;
}

/**
 * Měny podle jazyka.
 *
 * Nedá se hádat. Česky se prodává v korunách, slovensky v eurech — ale
 * anglicky to může být euro stejně jako libra, a napsat cenu v jiné měně,
 * než e-shop čeká, znamená prodávat pětadvacetkrát levněji. Bere se proto
 * z feedu: co je u produktů, to platí.
 */
export function feedCurrencies(): Record<string, string> {
  const rows = getDb().prepare(
    'SELECT raw_xml FROM ptrans_products LIMIT 40'
  ).all() as { raw_xml: string }[];
  const out: Record<string, string> = {};
  for (const row of rows) {
    const re = /<PRICE language="([^"]+)"[^>]*>([\s\S]*?)<\/PRICE>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(row.raw_xml))) {
      const currency = /<CURRENCY>([\s\S]*?)<\/CURRENCY>/.exec(m[2])?.[1]?.trim();
      if (currency && !out[m[1]]) out[m[1]] = currency;
    }
  }
  return out;
}

export function newProductState(): NewProductState {
  const langs = langsOf();
  const s = getPtransSettings();
  let categories: CategoryTree | null = null;
  // Strom se sem bere z uložené kopie; stahovat ho při každém otevření okna
  // by znamenalo čekat na síť kvůli něčemu, co se mění párkrát do roka
  try { categories = require('../categories').storedTree(s.sourceLang); } catch { categories = null; }
  return {
    drafts: listDrafts().map(one => ({ ...one, gaps: draftGaps(one, langs) })),
    langs,
    sourceLang: s.sourceLang,
    categories,
    currencies: feedCurrencies()
  };
}

/**
 * Číselník parametrů.
 *
 * Skládá se z feedu, takže hned po stažení katalogu je čerstvý. Znovu se dá
 * načíst ručně — třeba když se parametr v e-shopu právě přejmenoval.
 */
export function paramDictionary(name?: string): { names: ParamEntry[]; values: ParamEntry[] } {
  return { names: paramNames(), values: paramValues(name ?? '') };
}

export function relearnParams(): { names: number; values: number } {
  return learnParams(getPtransSettings().sourceLang);
}

export function checkParam(name: string, value: string) {
  return lookupParam(name, value);
}

/** Návrh parametrů z popisu — vrací se k potvrzení, nezapisuje se. */
export async function proposeParams(id: string, signal?: AbortSignal): Promise<ParamProposal[]> {
  const draft = getDraft(id);
  if (!draft) throw new Error('Rozdělaný produkt už neexistuje.');
  const texts = draft.langs[getPtransSettings().sourceLang] ?? emptyTexts();
  return suggestParams({
    title: texts.title,
    text: `${plainText(texts.short)}\n${plainText(texts.long)}`,
    existing: draft.params,
    signal
  });
}

/** Holý text z HTML — model nemá co dělat se značkami. */
function plainText(html: string): string {
  return (html ?? '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

export async function loadCategories(refresh = false): Promise<CategoryTree> {
  const lang = getPtransSettings().sourceLang;
  return refresh ? await refreshCategories(lang) : await categoryTree(lang);
}

export function createDraft(): DraftProduct {
  const draft = newDraft();
  /*
   * Značka se předvyplní tou, kterou má většina produktů ve feedu. U e-shopu
   * s vlastní značkou je to pokaždé totéž políčko — a prázdné se zapomínalo.
   */
  const brand = (getDb().prepare(
    `SELECT manufacturer FROM ptrans_products WHERE manufacturer != ''
     GROUP BY manufacturer ORDER BY COUNT(*) DESC LIMIT 1`
  ).get() as { manufacturer: string } | undefined)?.manufacturer ?? '';
  const next = brand ? saveDraft(draft.id, { manufacturer: brand }) : draft;
  emit({});
  return next;
}

export function updateDraft(id: string, patch: Partial<DraftProduct>):
  DraftProduct & { gaps: DraftGap[] } {
  const next = saveDraft(id, patch);
  return { ...next, gaps: draftGaps(next, langsOf()) };
}

export function removeDraft(id: string): void {
  deleteDraft(id);
  emit({});
}

/**
 * Je kód volný? `draftId` je rozdělaný produkt, který se na kód ptá —
 * jeho vlastní, už uložený produkt se za kolizi nepočítá.
 */
export function checkCode(code: string, draftId = '') {
  const own = draftId ? getDraft(draftId) : null;
  return codeTaken(code, own?.state === 'exported' ? own.code : '');
}

/* ---------- předloha ---------- */

export interface TemplateResult {
  draft: DraftProduct & { gaps: DraftGap[] };
  specifics: Specific[];
  note: string;
}

/**
 * Natáhne texty z jiného produktu a nechá vyznačit, co je na něm specifické.
 *
 * Hledání specifik se dělá **hned**, ne až na vyžádání: kdo si natáhne cizí
 * popis, přečte si ho v té chvíli — a právě v té chvíli potřebuje vidět, čeho
 * se musí dotknout.
 */
export async function useTemplate(id: string, code: string, signal?: AbortSignal):
  Promise<TemplateResult> {
  const draft = getDraft(id);
  if (!draft) throw new Error('Rozdělaný produkt už neexistuje.');
  const langs = langsOf();
  const loaded = loadTemplate(code, langs);

  let specifics: Specific[] = [];
  let note = '';
  try {
    specifics = await findSpecifics(loaded.langs[getPtransSettings().sourceLang] ?? emptyTexts(),
      getPtransSettings().sourceLang, signal);
  } catch (e: any) {
    // Zvýraznění je pomoc, ne podmínka — když model neodpoví, texty se
    // natáhnou stejně a jen se to řekne
    note = `Texty se natáhly, ale zvýraznit specifika se nepovedlo: ${e.message}`;
  }

  const next = saveDraft(id, {
    templateCode: code,
    langs: loaded.langs,
    params: loaded.params,
    categories: loaded.categories,
    mainCategory: loaded.mainCategory,
    manufacturer: loaded.manufacturer,
    google: loaded.google,
    specifics
  });
  emit({});
  return { draft: { ...next, gaps: draftGaps(next, langs) }, specifics, note };
}

export async function markSpecifics(id: string, lang: string, signal?: AbortSignal):
  Promise<Specific[]> {
  const draft = getDraft(id);
  if (!draft) throw new Error('Rozdělaný produkt už neexistuje.');
  const specifics = await findSpecifics(draft.langs[lang] ?? emptyTexts(), lang, signal);
  saveDraft(id, { specifics });
  return specifics;
}

/* ---------- přepisy textu ---------- */

export async function rewritePart(options: {
  before: string; selection: string; after: string; instruction?: string;
}, signal?: AbortSignal): Promise<string> {
  return rewriteSelection({ ...options, signal });
}

export async function titleProposal(id: string, lang: string, signal?: AbortSignal):
  Promise<TextChange[]> {
  const draft = getDraft(id);
  if (!draft) throw new Error('Rozdělaný produkt už neexistuje.');
  const texts = draft.langs[lang] ?? emptyTexts();
  const oldTitle = draft.templateCode ? fieldValue(draft.templateCode, lang, 'title') : '';
  if (!oldTitle) throw new Error('Návrh podle názvu se dá udělat jen u produktu z předlohy.');
  return proposeByTitle({
    oldTitle,
    newTitle: texts.title,
    fields: [
      { field: 'short', value: texts.short },
      { field: 'long', value: texts.long }
    ],
    signal
  });
}

/* ---------- uložení do katalogu a doplnění ---------- */

/**
 * Vloží rozdělaný produkt do katalogu překladů.
 *
 * Kontrola duplicity se dělá **až tady, znovu**. V poli u kódu se hlásí hned
 * při psaní, jenže mezi napsáním a uložením se dá stáhnout feed — a kdyby se
 * kód mezitím objevil, import by předlohu potichu přepsal.
 */
export function saveToCatalog(id: string):
  { code: string; draft: DraftProduct & { gaps: DraftGap[] } } {
  const draft = getDraft(id);
  if (!draft) throw new Error('Rozdělaný produkt už neexistuje.');
  const langs = langsOf();
  const gaps = draftGaps(draft, langs);
  const blockers = gaps.filter(one => one.level === 'blocker');
  if (blockers.length) {
    throw new Error(`Ještě chybí: ${blockers.map(one => one.label).join(', ')}.`);
  }
  const clash = codeTaken(draft.code, draft.state === 'exported' ? draft.code : '');
  if (clash.taken) {
    throw new Error(`Kód ${draft.code} už v e-shopu má „${clash.title}". Import by ho přepsal — zvol jiný.`);
  }
  const s = getPtransSettings();
  /*
   * Parametry jdou do XML rovnou ve všech jazycích, pokud je číselník zná.
   * Nechat je přeložit modelem by znamenalo dostat u každého nového produktu
   * trochu jiné znění — a filtrování v kategorii se skládá podle znění, ne
   * podle významu.
   */
  const resolved = resolveParams(draft.params, langs);
  const xml = buildProductXml(draft, {
    langs, sourceLang: s.sourceLang,
    params: resolved
  });
  ingestFile(xml);

  // Parametry se ukládají i jako pole, aby je uměl přeložit běžný překlad
  draft.params.forEach((one, index) => {
    saveTranslation(draft.code, s.sourceLang, paramKey(index, 'name'), one.name, '', true);
    saveTranslation(draft.code, s.sourceLang, paramKey(index, 'value'), one.value, '', true);
    for (const lang of langs) {
      if (lang === s.sourceLang) continue;
      const known = resolved[lang]?.[index];
      if (known?.name) saveTranslation(draft.code, lang, paramKey(index, 'name'), known.name, '', true);
      if (known?.value) saveTranslation(draft.code, lang, paramKey(index, 'value'), known.value, '', true);
    }
  });
  const next = saveDraft(id, { state: 'exported' });
  emit({});
  /*
   * Vrací se celý produkt, ne jen kód. Rozhraní si rozdělaný produkt drží
   * v místní kopii a bez téhle odpovědi by v ní zůstalo „ještě neuloženo" —
   * tlačítka na doplnění textů a na import by zůstala šedá, dokud se okno
   * nezavře a neotevře znovu.
   */
  return { code: draft.code, draft: { ...next, gaps: draftGaps(next, langs) } };
}

export interface CompleteStep {
  step: string;
  done: number;
  total: number;
}

/**
 * Doplní SEO, texty pro Google a překlady.
 *
 * Běží to po jednom a hlásí se, kde zrovna je — trvá to desítky vteřin a bez
 * hlášení to vypadá, že se aplikace zasekla.
 */
export async function completeProduct(code: string, onStep?: (s: CompleteStep) => void,
                                      signal?: AbortSignal):
  Promise<{ errors: string[]; draft: (DraftProduct & { gaps: DraftGap[] }) | null }> {
  const s = getPtransSettings();
  const targets = targetLangs(s);
  const errors: string[] = [];
  const total = SOURCE_FIELDS.length + 1 + targets.length;
  let done = 0;
  const step = (text: string) => onStep?.({ step: text, done, total });

  for (const field of SOURCE_FIELDS) {
    step(`Dopisuju ${field}`);
    const out = await fillSourceOne(code, field, signal);
    if (out.error) errors.push(out.error);
    done++;
  }
  step('Doplňuju atributy pro Google');
  applyAttributes([code], [s.sourceLang, ...targets], false);
  done++;

  for (const lang of targets) {
    step(`Překládám do ${lang.toUpperCase()}`);
    const out = await translateOne({ code, lang }, signal);
    // Hláška z překladu už kód i jazyk obsahuje — druhý prefix z ní dělal
    // „en: KR001 (en): …"
    if (out.error) errors.push(out.error);
    /*
     * Odkazy se dosazují po překladu, ne během něj. Model nechá v textu český
     * odkaz, nebo si vymění doménu po svém — obojí posílá zákazníka na cizí
     * trh. Správnou adresu zná e-shop; co se nenajde, se vypíše, ať se to dá
     * doplnit ručně.
     */
    try {
      const swap = await swapLinks(code, lang, s.sourceLang);
      for (const one of swap.unresolved) errors.push(`odkaz bez adresy: ${one}`);
    } catch (e: any) {
      errors.push(`${lang}: odkazy se nepodařilo dosadit (${e?.message ?? e})`);
    }
    done++;
  }
  step('Hotovo');
  /*
   * Dopsané texty se načtou zpátky do rozdělaného produktu.
   *
   * Doplňování zapisuje do katalogu (`ptrans_fields`), kdežto rozhraní ukazuje
   * rozdělaný produkt. Bez tohohle kroku doběhlo doplnění i překlad, ale na
   * obrazovce se nezměnilo nic — vypadalo to, že tlačítko nic nedělá.
   */
  const draft = readBack(code);
  emit({});
  return { errors, draft };
}

/** Přepíše do rozdělaného produktu to, co je po doplnění v katalogu. */
export function readBack(code: string): (DraftProduct & { gaps: DraftGap[] }) | null {
  const draft = draftByCode(code);
  if (!draft) return null;
  const langs = langsOf();
  const next: Record<string, any> = {};
  const google: Record<string, string> = { ...draft.google };
  for (const lang of langs) {
    const texts: Record<string, string> = { ...(draft.langs[lang] ?? emptyTexts()) };
    for (const field of Object.keys(emptyTexts())) {
      const value = fieldValue(code, lang, field);
      if (value) texts[field] = value;
    }
    next[lang] = texts;
  }
  for (const field of ['google_color', 'google_gender', 'google_age',
    'google_condition', 'google_bundle', 'google_identifier']) {
    const value = fieldValue(code, getPtransSettings().sourceLang, field);
    if (value) google[field] = value;
  }
  const saved = saveDraft(draft.id, { langs: next, google });
  return { ...saved, gaps: draftGaps(saved, langs) };
}

/* ---------- export ---------- */

/**
 * XML pro import.
 *
 * Bere se `state: 'current'` a plný tvar produktu: nový produkt nemá v e-shopu
 * co doplnit, takže musí jít ven celý — na rozdíl od opravy překladu, kde se
 * schválně posílá jen to, co se změnilo.
 */
export function exportXml(code: string): { xml: string; products: number; fields: number } {
  const out = buildExport({ codes: [code], state: 'current', mode: 'full', includeSource: true });
  if (out.products === 0) throw new Error('Produkt v katalogu není — ulož ho nejdřív do katalogu.');
  return { xml: out.xml, products: out.products, fields: out.fields };
}

/** Uloží XML do dočasného souboru, aby se dal vložit do formuláře v administraci. */
export function exportToTemp(code: string): string {
  const { xml } = exportXml(code);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quentino-import-'));
  const file = path.join(dir, `${code.replace(/[^\w.-]/g, '_')}.xml`);
  fs.writeFileSync(file, xml, 'utf8');
  return file;
}

export function draftByCode(code: string): DraftProduct | null {
  return listDrafts().find(one => one.code === code) ?? null;
}

export { getDraft, listDrafts, draftGaps };
export type { DraftProduct, DraftGap, Specific, TextChange, ParamProposal };

/* ---------- vložení do administrace ---------- */

const IMPORT_URL_KEY = 'ptrans.importUrl';

/**
 * Adresa stránky s importem produktů.
 *
 * Napevno zapsat nejde: v adrese je číslo serveru, na kterém e-shop běží
 * (`…s19.upgates.com`), a to má každý jiné. Skládá se z adresy administrace,
 * kterou aplikace zná kvůli fakturám, a zapamatuje se ta, na které se
 * políčko na soubor opravdu našlo.
 */
export function productImportUrl(): string {
  const saved = (getSetting(IMPORT_URL_KEY, '') ?? '').trim();
  if (saved) return saved;
  const home = (getSetting('invoiceAdminHome', '') ?? '').trim()
    || `${getUpgatesConfig().url.replace(/\/+$/, '')}/manager/`;
  const root = home.replace(/\/manager\/?$/, '').replace(/\/+$/, '');
  return `${root}/setup/export-import/default/guide/products/`;
}

let importWin: BrowserWindow | null = null;

/**
 * Otevře import v administraci a vloží do něj soubor s novým produktem.
 *
 * **Import se nespouští.** Založení produktu je zásah do e-shopu, který
 * aplikace nemá jak vzít zpět — stejné pravidlo jako u nahrávání fotek
 * a u podání zásilek: poslední kliknutí patří člověku.
 */
export async function openProductImport(code: string):
  Promise<{ filled: boolean; note: string; file: string }> {
  const file = exportToTemp(code);
  const win = importWin && !importWin.isDestroyed() ? importWin : new BrowserWindow({
    width: 1200, height: 860,
    title: `Import produktu ${code} do e-shopu`,
    webPreferences: { partition: 'persist:upgates', sandbox: true }
  });
  importWin = win;
  win.on('closed', () => { importWin = null; });

  keepSignedIn(win, 'upgates');
  await openUrl(win, productImportUrl());
  win.show();
  win.focus();
  const login = signInNote('upgates', await signIn(win, 'upgates'));

  const out = await fillFileInput(win, file);
  // Adresa, na které se políčko našlo, se zapamatuje — příště se okno otevře
  // rovnou tam a nikdo se nemusí proklikávat
  if (out.filled && out.url) setSetting(IMPORT_URL_KEY, out.url);
  const note = out.filled
    ? 'Soubor je vložený. Zkontroluj nastavení importu a spusť ho — spouštět ho za tebe nebudu.'
    : out.note;
  return { filled: out.filled, note: [login, note].filter(Boolean).join(' '), file };
}
