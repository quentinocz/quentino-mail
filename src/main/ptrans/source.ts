import { getDb } from '../db';
import { getPtransSettings, fieldValue, sourceText, propagateSource, targetLangs } from './store';
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
  /*
   * Prázdný seznam znamená „nic", ne „všechno".
   *
   * Dřív se prázdno bralo jako „doplň všechno" a rozhraní přitom hlásilo
   * nula volání — takže když si člověk odškrtl všechna pole, spustilo se
   * naopak úplně všechno. Kdo chce všechna pole, pole nepředá vůbec.
   */
  const wanted = (options.fields ?? [...SOURCE_FIELDS])
    .filter(field => SOURCE_FIELDS.includes(field));

  const out: SourceTarget[] = [];
  for (const code of options.codes) {
    /*
     * Rozhoduje `sourceText`, ne hodnota uložená u pole.
     *
     * Obojí vypadá stejně, ale počítá se to jinak — a rozdíl je vidět
     * přesně tam, kde to nejvíc vadí: pole se hlásilo jako „kompletní"
     * a překlad u něj přitom neměl z čeho vycházet.
     */
    const title = sourceText(code, 'title');
    const body = plain(sourceText(code, 'long') || sourceText(code, 'short'));
    if (!title && !body) continue;

    for (const field of wanted) {
      // Bez popisu nemá smysl psát popisné texty; titulek se poskládá i ze
      // samotného názvu a parametrů
      if (!body && (field === 'seo_desc' || field === 'google_desc')) continue;
      if (!options.force && sourceText(code, field)) continue;
      out.push({ code, field });
    }
  }
  return out;
}

/** Doplní jedno pole ve zdrojovém jazyce a rozešle zdroj k cílovým jazykům. */
export async function fillSourceOne(code: string, field: SourceField, signal?: AbortSignal):
  Promise<{ value: string; error?: string }> {
  const lang = getPtransSettings().sourceLang;
  try {
    let value = '';
    if (field === 'seo_url') {
      value = refreshSeoUrl(code, lang);
    } else if (field === 'google_title' || field === 'google_desc') {
      value = await writeGoogleText(code, lang, field, signal);
    } else {
      value = await generateSeo(code, lang, field, signal);
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

/**
 * Přehled po polích: kolik produktů z výběru nemá v češtině co.
 *
 * Součástí je i `translated` — jestli se pole vůbec překládá. Google texty
 * jsou ve výchozím nastavení vypnuté, takže se dají doplnit v češtině, ale
 * do žádného trhu se nedostanou. Bez téhle informace to vypadá, že překlad
 * Google textů nefunguje; přitom se prostě nesleduje.
 */
export function missingByField(codes: string[]):
  { field: SourceField; label: string; missing: number; translated: boolean }[] {
  const s = getPtransSettings();
  return SOURCE_FIELDS.map(field => ({
    field,
    label: SOURCE_LABELS[field],
    missing: codes.filter(code => !sourceText(code, field, s)).length,
    // seo_url se nepřekládá schválně — skládá ho kód z přeloženého názvu
    translated: field === 'seo_url' ? true : s.fields[field] !== false
  }));
}

export { targetLangs, getDb };
