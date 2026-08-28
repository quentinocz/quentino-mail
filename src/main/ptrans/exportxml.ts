import { getDb } from '../db';
import { getPtransSettings, targetLangs } from './store';
import { setField, feedHeader, FieldKey } from './xml';

/**
 * Export přeložených produktů zpátky do XML pro import do Upgates.
 *
 * Základ je **původní blok produktu z feedu** — do něj se jen vepíšou překlady.
 * Díky tomu je výsledek ve stejném tvaru, jaký Upgates sám vydává, a import se
 * chová předvídatelně.
 *
 * Výchozí režim je „jen přeložené části": v souboru zůstane kód produktu a
 * jazykové části, které se opravdu překládaly. Import v Upgates aktualizuje jen
 * to, co v souboru je, takže se takhle nedá omylem přepsat sklad, cena nebo
 * čeština. Plný režim (celý produkt) je pro případ, že by import vyžadoval víc.
 */

export interface ExportOptions {
  /** Jazyky, jejichž překlady se mají zapsat */
  langs?: string[];
  /** Konkrétní produkty; prázdné = všechny, které mají uložený překlad */
  codes?: string[];
  /**
   * Co se vlastně exportuje.
   *
   * `translated` (výchozí) bere jen pole, u kterých aplikace něco vyrobila —
   * na to je export postavený a je to nejbezpečnější.
   *
   * `current` bere **aktuální stav produktu**: kde překlad je, použije se, kde
   * není, vezme se hodnota z feedu. Tohle je režim pro „vyber si produkty a
   * dej mi je celé, jak jsou teď" — třeba když se překlad složil z paměti a
   * žádné nové volání modelu neproběhlo, nebo když se ručně dopsala jen barva
   * a zbytek má zůstat beze změny.
   */
  state?: 'translated' | 'current';
  /** `slim` = jen překládané části, `full` = celý produkt z feedu */
  mode?: 'slim' | 'full';
  /** Přidat i zdrojový jazyk (obvykle netřeba a je to zbytečné riziko) */
  includeSource?: boolean;
  /** Která pole zapsat; prázdné = všechna, která máme přeložená */
  fields?: FieldKey[];
}

export interface ExportResult {
  xml: string;
  products: number;
  fields: number;
  langs: string[];
}

/** Sekce, které v „slim" režimu zůstávají — všechno ostatní se vyhodí. */
const KEEP_SECTIONS = ['CODE', 'DESCRIPTIONS', 'SEO_OPTIMALIZATION', 'METAS', 'PARAMETERS'];

export function buildExport(options: ExportOptions = {}): ExportResult {
  const d = getDb();
  const s = getPtransSettings();
  /*
   * Bez výslovného výběru se exportuje i **zdrojový jazyk**.
   *
   * Aplikace v češtině nejen překládá, ale i píše: doplněný SEO titulek,
   * meta popis, texty pro Google a uklizený popis vznikají v češtině a do
   * e-shopu se jinak nedostanou. V režimu „jen přeložené" se zapisují pouze
   * pole, která aplikace opravdu vyrobila, takže se tím nic cizího nepřepíše.
   */
  const langs = options.langs?.length ? options.langs : [s.sourceLang, ...targetLangs(s)];
  const mode = options.mode ?? 'slim';

  const state = options.state ?? 'translated';

  const params: any[] = [...langs];
  // V režimu „aktuální stav" se bere překlad, a když není, hodnota z feedu.
  // Prázdné pole se nezapisuje ani tak — přepsat text v e-shopu prázdnem by
  // byla ta nejhorší možná chyba, jakou umí import udělat.
  const pickSql = state === 'current'
    ? `COALESCE(NULLIF(f.translated, ''), f.value)`
    : `f.translated`;
  let sql = `SELECT f.code, f.lang, f.field, ${pickSql} AS translated FROM ptrans_fields f
             WHERE ${pickSql} IS NOT NULL AND ${pickSql} != '' AND f.lang IN (${langs.map(() => '?').join(',')})`;
  if (options.fields?.length) {
    sql += ` AND f.field IN (${options.fields.map(() => '?').join(',')})`;
    params.push(...options.fields);
  }
  if (options.codes?.length) {
    sql += ` AND f.code IN (${options.codes.map(() => '?').join(',')})`;
    params.push(...options.codes);
  }
  const rows = d.prepare(sql + ' ORDER BY f.code').all(...params) as
    { code: string; lang: string; field: string; translated: string }[];

  const byProduct = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = byProduct.get(row.code) ?? [];
    list.push(row);
    byProduct.set(row.code, list);
  }

  const readRaw = d.prepare('SELECT raw_xml FROM ptrans_products WHERE code = ?');
  const parts: string[] = [];
  let fields = 0;

  for (const [code, list] of byProduct) {
    const raw = (readRaw.get(code) as { raw_xml: string } | undefined)?.raw_xml;
    if (!raw) continue;

    let block = raw;
    for (const row of list) {
      block = setField(block, row.lang, row.field, row.translated, s.sourceLang);
      fields++;
    }
    if (mode === 'slim') {
      block = slim(block, langs, options.includeSource ? s.sourceLang : null);
    }
    parts.push(`\t<PRODUCT>${block}</PRODUCT>`);
  }

  const head = '<?xml version="1.0" encoding="UTF-8"?>\n'
    + `<!--Quentino App: překlady ${langs.join(', ')} · ${new Date().toLocaleString('cs-CZ')}-->\n`
    + '<PRODUCTS version="2.0">\n';
  return {
    xml: `${head}${parts.join('\n')}\n</PRODUCTS>\n`,
    products: parts.length,
    fields,
    langs
  };
}

/** Ponechá jen kód produktu a jazykové části vybraných jazyků. */
function slim(block: string, langs: string[], sourceLang: string | null): string {
  const keep = new Set(langs);
  if (sourceLang) keep.add(sourceLang);

  const sections: string[] = [];
  for (const name of KEEP_SECTIONS) {
    const found = new RegExp(`(\\s*)<${name}(?:\\s[^>]*)?>[\\s\\S]*?</${name}>`).exec(block);
    if (!found) continue;
    let piece = found[0];
    if (name === 'DESCRIPTIONS') piece = keepLangs(piece, 'DESCRIPTION', keep);
    if (name === 'SEO_OPTIMALIZATION') piece = keepLangs(piece, 'SEO', keep);
    if (name === 'METAS') piece = slimMetas(piece, keep);
    if (name === 'PARAMETERS') piece = keepLangs(piece, 'NAME', keep, ['VALUE']);
    sections.push(piece);
  }
  // `<CODE>` je klíč importu — bez něj by Upgates produkt nepoznal
  return `${sections.join('')}\n\t`;
}

/** Z bloku odstraní jazykové části, které se neexportují. */
function keepLangs(piece: string, tag: string, keep: Set<string>, alsoTags: string[] = []): string {
  const tags = [tag, ...alsoTags];
  let out = piece;
  for (const name of tags) {
    const re = new RegExp(`\\s*<${name} language="([a-z]{2,5})"[^>]*(?:/>|>[\\s\\S]*?</${name}>)`, 'g');
    out = out.replace(re, (match, lang) => (keep.has(lang) ? match : ''));
  }
  return out;
}

/** V METAS zůstanou jen klíče, které aplikace plní, a jen vybrané jazyky. */
function slimMetas(piece: string, keep: Set<string>): string {
  // `redirect_301` je tu podstatný: bez něj by se změněná adresa naimportovala
  // bez přesměrování a stará by začala vracet chybu
  const wanted = ['title_google_merchant', 'description_google_merchant', 'redirect_301'];
  const kept: string[] = [];
  for (const part of piece.split('<META ').slice(1)) {
    const body = `<META ${part.split('</META>')[0]}</META>`;
    const key = /<META_KEY>([^<]*)<\/META_KEY>/.exec(body)?.[1] ?? '';
    if (!wanted.includes(key)) continue;
    kept.push(keepLangs(body, 'META_VALUE', keep));
  }
  if (kept.length === 0) return '';
  return `\n\t\t<METAS>\n\t\t\t${kept.join('\n\t\t\t')}\n\t\t</METAS>`;
}

/** Kolik produktů a polí by se právě teď vyexportovalo. */
export function exportPreview(options: ExportOptions = {}): { products: number; fields: number } {
  const d = getDb();
  const langs = options.langs?.length
    ? options.langs
    : [getPtransSettings().sourceLang, ...targetLangs()];
  const pick = options.state === 'current'
    ? `COALESCE(NULLIF(translated, ''), value)`
    : 'translated';
  const params: any[] = [...langs];
  let sql = `SELECT COUNT(*) AS fields, COUNT(DISTINCT code) AS products FROM ptrans_fields
     WHERE ${pick} IS NOT NULL AND ${pick} != '' AND lang IN (${langs.map(() => '?').join(',')})`;
  if (options.codes?.length) {
    sql += ` AND code IN (${options.codes.map(() => '?').join(',')})`;
    params.push(...options.codes);
  }
  const row = d.prepare(sql).get(...params) as { fields: number; products: number };
  return { products: row.products, fields: row.fields };
}

export { feedHeader };
