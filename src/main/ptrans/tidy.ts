import { getDb } from '../db';
import { getPtransSettings, targetLangs, fieldValue, recomputeStates } from './store';
import { hashText } from './detect';
import { HTML_FIELDS } from './xml';
import { tidyHtml, needsTidy, textOnly } from './html';

/**
 * Úklid popisů v databázi — ve všech jazycích včetně zdrojového.
 *
 * `html.ts` umí uklidit jeden text. Tady se to aplikuje na produkt: nejdřív
 * na češtinu, protože tam ten nepořádek vznikl (popis se vložil kopírováním
 * z jiného okna i s obalem cizí stránky), a pak na jazykové mutace, které ho
 * zdědily překladem.
 *
 * Dvě věci, na kterých záleží víc, než je vidět:
 *
 *  1. **Uklizený zdroj se rozešle i do `source_value` cílových jazyků.**
 *     Bez toho by se otisk originálu rozešel s otiskem u překladu a všechny
 *     přeložené popisy by naskočily jako „zdroj se změnil, přelož znovu" —
 *     stovky zbytečných volání modelu za změnu, která se textu ani nedotkla.
 *
 *  2. **Nepřeložené pole se uklidí, ale nezačne se tvářit jako přeložené.**
 *     Balast je i v cizojazyčných popisech, které ve feedu leží — ty se
 *     uklidit mají, jinak zůstane e-shop rozbitý na ostatních trzích. Uklízí
 *     se ale jen hodnota z feedu; překlad se z toho nedělá, takže pole dál
 *     poctivě svítí jako „čeká na překlad".
 *
 * Text se přitom nesmí změnit ani o písmeno; kdyby se to u některého pole
 * nepovedlo, pole se přeskočí a zůstane, jak bylo.
 */

/** Pole, která nesou HTML a mají tedy co uklízet. */
const FIELDS = [...HTML_FIELDS];

export interface MessyField {
  lang: string;
  field: string;
  /** Kolik znaků balastu by ubylo */
  saved: number;
}

export interface TidyResult {
  /** Kolik polí se opravdu změnilo */
  fields: number;
  /** Jazyky, ve kterých se něco uklidilo */
  langs: string[];
  /** Ušetřené znaky */
  saved: number;
}

/** Text, se kterým se pracuje: náš překlad, jinak hodnota z feedu. */
function currentValue(row: { translated: string | null; value: string } | undefined): string {
  return (row?.translated || row?.value || '');
}

/** Co je u produktu k úklidu — bez jakéhokoli zápisu. */
export function messyFields(code: string): MessyField[] {
  const s = getPtransSettings();
  const d = getDb();
  const out: MessyField[] = [];
  const read = d.prepare(
    'SELECT translated, value FROM ptrans_fields WHERE code = ? AND lang = ? AND field = ?'
  );

  for (const field of FIELDS) {
    const source = fieldValue(code, s.sourceLang, field);
    if (needsTidy(source)) {
      out.push({ lang: s.sourceLang, field, saved: source.length - tidyHtml(source).length });
    }
    for (const lang of targetLangs(s)) {
      const row = read.get(code, lang, field) as
        { translated: string | null; value: string } | undefined;
      if (!row) continue;
      const value = currentValue(row);
      if (needsTidy(value)) out.push({ lang, field, saved: value.length - tidyHtml(value).length });
    }
  }
  return out;
}

/**
 * Uklidí popisy jednoho produktu ve všech jazycích.
 *
 * Vrací, co se změnilo. Když není co uklízet, nic nezapisuje.
 */
export function tidyProduct(code: string): TidyResult {
  const d = getDb();
  const s = getPtransSettings();
  const now = new Date().toISOString();
  const langs = new Set<string>();
  let fields = 0;
  let saved = 0;

  const read = d.prepare(
    `SELECT translated, value, source_value, state, manual FROM ptrans_fields
     WHERE code = ? AND lang = ? AND field = ?`
  );
  const writeSource = d.prepare(`
    INSERT INTO ptrans_fields (code, lang, field, value, source_value, state, translated,
      translated_at, translated_hash, model, manual, messy)
    VALUES (@code, @lang, @field, @value, @value, 'ok', @value, @at, @hash, 'úklid', @manual, 0)
    ON CONFLICT(code, lang, field) DO UPDATE SET
      value = excluded.value, source_value = excluded.source_value, state = 'ok',
      translated = excluded.translated, translated_at = excluded.translated_at,
      translated_hash = excluded.translated_hash, model = excluded.model, messy = 0
  `);
  // Uklizený originál se musí propsat i k cílovým jazykům — jinak by se
  // rozešly otisky a všechny překlady by vypadaly jako zastaralé
  const spreadSource = d.prepare(
    `UPDATE ptrans_fields SET source_value = @value, messy = 0
     WHERE code = @code AND field = @field AND lang != @lang`
  );
  const rehash = d.prepare(
    `UPDATE ptrans_fields SET translated_hash = @hash
     WHERE code = @code AND field = @field AND lang != @lang AND translated IS NOT NULL`
  );
  const writeTarget = d.prepare(`
    UPDATE ptrans_fields SET value = @value, translated = @value, translated_at = @at,
      translated_hash = @hash, model = 'úklid', messy = 0
    WHERE code = @code AND lang = @lang AND field = @field
  `);
  // Nepřeložené pole: uklidí se text z feedu, ale překlad z toho nevzniká —
  // stav pole zůstane, jaký byl (text se nezměnil, jen kód kolem něj)
  const writeUntranslated = d.prepare(
    `UPDATE ptrans_fields SET value = @value, messy = 0
     WHERE code = @code AND lang = @lang AND field = @field`
  );

  const run = d.transaction(() => {
    for (const field of FIELDS) {
      /* ---------- zdrojový jazyk ---------- */
      const source = fieldValue(code, s.sourceLang, field);
      if (needsTidy(source)) {
        const tidied = tidyHtml(source);
        // Pojistka: co se nedá uklidit beze ztráty písmene, se neuklízí
        if (textOnly(tidied) === textOnly(source)) {
          const clean = tidied;
          const row = read.get(code, s.sourceLang, field) as { manual: number } | undefined;
          writeSource.run({
            code, lang: s.sourceLang, field, value: clean, at: now,
            hash: hashText(clean), manual: row?.manual ?? 0
          });
          spreadSource.run({ code, field, lang: s.sourceLang, value: clean });
          rehash.run({ code, field, lang: s.sourceLang, hash: hashText(clean) });
          langs.add(s.sourceLang);
          fields++;
          saved += source.length - clean.length;
        }
      }

      /* ---------- jazykové mutace ---------- */
      for (const lang of targetLangs(s)) {
        const row = read.get(code, lang, field) as
          { translated: string | null; value: string; source_value: string } | undefined;
        if (!row) continue;

        const value = currentValue(row);
        if (!needsTidy(value)) continue;
        const tidied = tidyHtml(value);
        if (textOnly(tidied) !== textOnly(value)) continue;

        if (row.translated) {
          // Otisk se bere z uloženého originálu (ten je po `spreadSource` už
          // uklizený) — jinak by pole hned naskočilo jako „zdroj se změnil"
          writeTarget.run({
            code, lang, field, value: tidied, at: now, hash: hashText(row.source_value)
          });
        } else {
          writeUntranslated.run({ code, lang, field, value: tidied });
        }
        langs.add(lang);
        fields++;
        saved += value.length - tidied.length;
      }
    }
  });
  run();

  if (fields) recomputeStates([code]);
  return { fields, langs: [...langs], saved };
}

/** Hromadný úklid — pro vyfiltrovaný výběr. */
export function tidyProducts(codes: string[]): { products: number; fields: number; saved: number } {
  let products = 0;
  let fields = 0;
  let saved = 0;
  for (const code of codes) {
    const result = tidyProduct(code);
    if (result.fields === 0) continue;
    products++;
    fields += result.fields;
    saved += result.saved;
  }
  return { products, fields, saved };
}
