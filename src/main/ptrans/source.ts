import { getDb } from '../db';
import { getPtransSettings, fieldValue, propagateSource, targetLangs } from './store';
import { generateSeo, refreshSeoUrl } from './seo';
import { writeGoogleText } from './google';
import { plain } from './detect';

/**
 * Doplnění textů ve **zdrojovém** jazyce.
 *
 * Překlad umí jen převést to, co existuje. Když produkt nemá SEO titulek ani
 * v češtině, není co překládat — a v každé jazykové mutaci pak chybí totéž.
 * Tenhle krok proto předchází překladu: co v češtině chybí, se napíše podle
 * názvu a popisu produktu, a teprve pak se to překládá dál.
 *
 * Pořadí je podstatné a je to důvod, proč to není samostatné tlačítko:
 * kdyby se zdrojové texty doplňovaly až po překladu, jazykové mutace by
 * zůstaly prázdné a musel by se pouštět druhý průchod.
 *
 * Adresa (`seo_url`) se nepíše modelem — je to mechanický přepis názvu, který
 * kód zvládne přesněji a zadarmo.
 */

/** Pole, která se ve zdrojovém jazyce umí doplnit. */
export const SOURCE_FIELDS = ['seo_title', 'seo_desc', 'seo_url', 'google_title', 'google_desc'] as const;
export type SourceField = typeof SOURCE_FIELDS[number];

export const SOURCE_LABELS: Record<SourceField, string> = {
  seo_title: 'SEO titulek',
  seo_desc: 'SEO popis',
  seo_url: 'SEO adresa',
  google_title: 'Google titulek',
  google_desc: 'Google popis'
};

export interface SourceTarget {
  code: string;
  field: SourceField;
}

export interface SourceFillOptions {
  codes: string[];
  /** Která pole doplnit; prázdné = všechna, která jde */
  fields?: SourceField[];
  /** Přepsat i to, co už vyplněné je */
  force?: boolean;
}

/**
 * Co by se doplňovalo.
 *
 * Produkt bez názvu nebo bez popisu se přeskočí — model by neměl z čeho psát
 * a vymýšlel by si. Radši prázdné pole než vymyšlený text ve feedu.
 */
export function planSourceFill(options: SourceFillOptions): SourceTarget[] {
  const s = getPtransSettings();
  const lang = s.sourceLang;
  const wanted = (options.fields?.length ? options.fields : [...SOURCE_FIELDS])
    .filter(field => SOURCE_FIELDS.includes(field));

  const out: SourceTarget[] = [];
  for (const code of options.codes) {
    const title = fieldValue(code, lang, 'title');
    const body = plain(fieldValue(code, lang, 'long') || fieldValue(code, lang, 'short'));
    if (!title && !body) continue;

    for (const field of wanted) {
      // Bez popisu nemá smysl psát popisné texty; titulek se poskládá i ze
      // samotného názvu a parametrů
      if (!body && (field === 'seo_desc' || field === 'google_desc')) continue;
      if (!options.force && fieldValue(code, lang, field)) continue;
      out.push({ code, field });
    }
  }
  return out;
}

/** Doplní jedno pole ve zdrojovém jazyce a rozešle zdroj k cílovým jazykům. */
export async function fillSourceOne(code: string, field: SourceField):
  Promise<{ value: string; error?: string }> {
  const lang = getPtransSettings().sourceLang;
  try {
    let value = '';
    if (field === 'seo_url') {
      value = refreshSeoUrl(code, lang);
    } else if (field === 'google_title' || field === 'google_desc') {
      value = await writeGoogleText(code, lang, field);
    } else {
      value = await generateSeo(code, lang, field);
    }
    if (!value) return { value: '', error: `${code}/${SOURCE_LABELS[field]}: model nic nevrátil` };

    // Nový zdrojový text se musí dostat k cílovým jazykům, jinak by překlad
    // pořád vycházel z prázdna
    propagateSource(code, field, value);
    return { value };
  } catch (e: any) {
    return { value: '', error: `${code}/${SOURCE_LABELS[field]}: ${e.message}` };
  }
}

/** Kolik zdrojových textů u vybraných produktů chybí — do odhadu před spuštěním. */
export function countMissing(codes: string[], fields?: SourceField[]): number {
  return planSourceFill({ codes, fields }).length;
}

/** Přehled po polích: kolik produktů z výběru nemá v češtině co. */
export function missingByField(codes: string[]): { field: SourceField; label: string; missing: number }[] {
  const s = getPtransSettings();
  return SOURCE_FIELDS.map(field => ({
    field,
    label: SOURCE_LABELS[field],
    missing: codes.filter(code => !fieldValue(code, s.sourceLang, field)).length
  }));
}

export { targetLangs, getDb };
