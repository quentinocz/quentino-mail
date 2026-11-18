import { getDb } from '../db';
import { getPtransSettings, targetLangs } from './store';
import { setField, getField, fieldPlace, feedHeader, FieldKey, DERIVED_FIELDS, isCheckboxField, checkboxValue } from './xml';
import { hashText } from './detect';
import { textOnly } from './html';

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
 *
 * ## Co tu bylo špatně
 *
 * Úsporný režim se řídil **seznamem jazyků a napevno vypsaných klíčů**,
 * ne tím, co se opravdu zapsalo. Z toho vyšly tři tiché chyby:
 *
 *  * atributy pro Google (barva, pohlaví, věk, stav, set, čárový kód) na
 *    tom seznamu klíčů nebyly. Zapsaly se do bloku, export je započítal
 *    — a při zeštíhlení se zahodily. Kdo doplnil jen je, dostal soubor,
 *    ve kterém nebyly;
 *  * záznamy metadat se hledaly podle „<META " s mezerou. Feed, který
 *    je píše bez atributů, tedy „<META>", přišel o metadata všechna;
 *  * v souboru naopak zůstávaly celé jazykové části včetně češtiny a
 *    parametrů, na které nikdo nesáhl — tedy stav z posledního stažení
 *    feedu, kterým by import přepsal cokoli, co se mezitím v e-shopu
 *    změnilo.
 *
 * Teď rozhoduje to, **co se zapsalo**: jazyková část popisu nebo SEO
 * zůstane jen tam, kde se do ní psalo, z metadat jen zapsané klíče a
 * jazyky a parametry jen tehdy, když se psalo do nich. A po každém
 * zápisu se hodnota z bloku přečte zpátky — co tam není, se nepočítá
 * mezi zapsaná pole, ale vypíše mezi nezapsaná.
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
  /** Kolik polí v souboru opravdu je — ověřeno přečtením zpátky. */
  fields: number;
  langs: string[];
  /** Pole, která se zapsat nepodařila: „kód/jazyk/pole". Má být prázdné. */
  missed: string[];
  /**
   * Pole, která se schválně nepřepsala: v e-shopu je mezitím jiný text,
   * než byl, když je aplikace překládala (někdo ho upravil). „kód/jazyk/pole"
   */
  kept: string[];
  /** Produkty, které v e-shopu nejsou — úsporný export je vynechá, import by je založil */
  skippedNew: string[];
  /** Kolik polí se vynechalo, protože je v e-shopu už totéž */
  unchanged: number;
}

/**
 * Změnil se text v e-shopu od chvíle, kdy aplikace pole napsala?
 *
 * Tři případy, ve kterých aplikace pole nepřepíše:
 *  - **v e-shopu je jiný text, než tam byl při překladu** (otisk `base_hash`):
 *    někdo ho mezitím upravil a jeho práce má přednost,
 *  - **zdroj se od překladu změnil** (stav „zastaralé"): překlad patří
 *    k dřívějšímu českému textu a do e-shopu by šel neodpovídající,
 *  - u polí přeložených dřív, než aplikace otisk ukládala: v e-shopu je
 *    jiný text v cílovém jazyce, nebo — u češtiny — jiný text než ten,
 *    ze kterého aplikace vycházela. Přesně tak by export z 18. 11. vrátil
 *    19 českých popisů do podoby z srpna: úklid HTML je tehdy uložil,
 *    a v e-shopu se od té doby přepsaly.
 * Úklid značek, který text nemění, se za změnu nepočítá.
 */
function shopChanged(row: { own: string | null; state: string; base_hash: string | null },
                     now: string, source: boolean): boolean {
  const own = row.own ?? '';
  if (!source && row.state === 'stale') return true;
  if (!now.trim() || stejne(now, own)) return false;
  if (row.base_hash) return hashText(now) !== row.base_hash;
  if (textOnly(now) === textOnly(own)) return false;
  return source || row.state === 'ok';
}

const stejne = (a: string | null, b: string) =>
  String(a ?? '').replace(/\s+/g, ' ').trim() === String(b ?? '').replace(/\s+/g, ' ').trim();

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
  let sql = `SELECT f.code, f.lang, f.field, ${pickSql} AS translated, f.translated AS own, f.state,
               f.manual, f.base_hash, p.origin
             FROM ptrans_fields f LEFT JOIN ptrans_products p ON p.code = f.code
             WHERE ${pickSql} IS NOT NULL AND ${pickSql} != '' AND f.lang IN (${langs.map(() => '?').join(',')})`;
  if (options.fields?.length) {
    sql += ` AND f.field IN (${options.fields.map(() => '?').join(',')})`;
    params.push(...options.fields);
  }
  if (options.codes?.length) {
    sql += ` AND f.code IN (${options.codes.map(() => '?').join(',')})`;
    params.push(...options.codes);
  }
  const rows = d.prepare(sql + ' ORDER BY f.code').all(...params) as {
    code: string; lang: string; field: string; translated: string;
    own: string | null; state: string; manual: number; base_hash: string | null; origin: string | null
  }[];

  const byProduct = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = byProduct.get(row.code) ?? [];
    list.push(row);
    byProduct.set(row.code, list);
  }

  const readRaw = d.prepare('SELECT raw_xml FROM ptrans_products WHERE code = ?');
  const parts: string[] = [];
  const missed: string[] = [];
  const kept: string[] = [];
  const skippedNew: string[] = [];
  let unchanged = 0;
  let fields = 0;
  // Co se do souboru opravdu zapíše — zaškrtávací pole jako 1/0 (viz xml.ts)
  const expected = (row: { field: string; translated: string }) =>
    (isCheckboxField(row.field) ? checkboxValue(row.translated) : row.translated);

  for (const [code, list] of byProduct) {
    const raw = (readRaw.get(code) as { raw_xml: string } | undefined)?.raw_xml;
    if (!raw) continue;
    /*
     * Produkt, který v e-shopu není (nahraný ze souboru, rozdělaný nový),
     * do úsporného exportu nepatří: import by ho založil jako nový — bez
     * ceny, kategorie a obrázků, jen s texty. Nový produkt má vlastní
     * export (celý produkt) v záložce Nový produkt.
     */
    if (mode === 'slim' && list[0]?.origin === 'file') { skippedNew.push(code); continue; }

    let block = raw;
    const zapsane: typeof list = [];
    for (const row of list) {
      /*
       * Nepřepsat, co v e-shopu mezitím upravil člověk.
       *
       * Aplikace přeložila pole z textu, který tehdy v e-shopu byl. Když je
       * tam teď jiný (a není to náš překlad), někdo ho mezitím změnil — a
       * export by jeho práci tiše přepsal starším překladem. Ruční úprava
       * v aplikaci má přednost: tu člověk napsal vědomě.
       */
      const now = getField(raw, row.lang, row.field) ?? '';
      if (row.own && row.manual !== 1 && !DERIVED_FIELDS.has(row.field)
        && shopChanged(row, now, row.lang === s.sourceLang)) {
        kept.push(`${code}/${row.lang}/${row.field}`);
        continue;
      }
      const before = block;
      block = setField(block, row.lang, row.field, row.translated, s.sourceLang);
      /*
       * Co je v e-shopu už teď, se nepíše. Jinak by se z úsporného exportu
       * stal opis feedu — a s ním i texty, které aplikace má z dřívějška a
       * v e-shopu se mezitím změnily.
       */
      if (state === 'translated' && stejne(getField(before, row.lang, row.field), expected(row))) {
        block = before;
        unchanged++;
        continue;
      }
      /*
       * Počítá se jen to, co v bloku opravdu je. Zápis umí selhat potichu
       * (parametr, který produkt nemá) a číslo „zapsáno 12 polí" nad
       * souborem, kde nejsou, je horší než žádné číslo.
       */
      if (stejne(getField(block, row.lang, row.field), expected(row))) zapsane.push(row);
      else missed.push(`${code}/${row.lang}/${row.field}`);
    }
    if (zapsane.length === 0) continue;
    if (mode === 'slim') {
      block = slim(block, zapsane);
      /* A ještě jednou po zeštíhlení — právě tam se dřív pole ztrácela */
      for (const row of zapsane) {
        if (stejne(getField(block, row.lang, row.field), expected(row))) fields++;
        else missed.push(`${code}/${row.lang}/${row.field}`);
      }
    } else fields += zapsane.length;
    parts.push(`\t<PRODUCT>${block}</PRODUCT>`);
  }

  const head = '<?xml version="1.0" encoding="UTF-8"?>\n'
    + `<!--Quentino App: překlady ${langs.join(', ')} · ${new Date().toLocaleString('cs-CZ')}-->\n`
    + '<PRODUCTS version="2.0">\n';
  return {
    xml: `${head}${parts.join('\n')}\n</PRODUCTS>\n`,
    products: parts.length,
    fields,
    langs,
    missed,
    kept,
    skippedNew,
    unchanged
  };
}

/**
 * Ponechá jen kód produktu a to, do čeho se opravdu psalo.
 *
 * Řídí se zapsanými poli, ne seznamem jazyků: jazyková část popisu nebo
 * SEO zůstane jen tam, kde se do ní psalo, z metadat jen zapsané klíče
 * a jazyky, parametry jen když se psalo do nich.
 */
function slim(block: string, rows: { lang: string; field: string }[]): string {
  const popisy = new Set<string>();
  const seo = new Set<string>();
  const parametry = new Set<string>();
  const metas = new Map<string, Set<string>>();
  for (const row of rows) {
    const kde = fieldPlace(row.field);
    if (!kde) continue;
    if (kde.scope === 'description') popisy.add(row.lang);
    else if (kde.scope === 'seo') seo.add(row.lang);
    else if (kde.scope === 'param') parametry.add(row.lang);
    else if (kde.metaKey) {
      const jazyky = metas.get(kde.metaKey) ?? new Set<string>();
      jazyky.add(row.lang);
      metas.set(kde.metaKey, jazyky);
    }
  }

  const sekce = (name: string) =>
    new RegExp(`(\\s*)<${name}(?:\\s[^>]*)?>[\\s\\S]*?</${name}>`).exec(block)?.[0] ?? '';
  const sections: string[] = [];
  // `<CODE>` je klíč importu — bez něj by Upgates produkt nepoznal
  sections.push(sekce('CODE'));
  if (popisy.size > 0) sections.push(keepLangs(sekce('DESCRIPTIONS'), 'DESCRIPTION', popisy));
  if (seo.size > 0) sections.push(keepLangs(sekce('SEO_OPTIMALIZATION'), 'SEO', seo));
  if (metas.size > 0) sections.push(slimMetas(sekce('METAS'), metas));
  if (parametry.size > 0) sections.push(keepLangs(sekce('PARAMETERS'), 'NAME', parametry, ['VALUE']));
  return `${sections.filter(Boolean).join('')}\n\t`;
}

/** Z bloku odstraní jazykové části, které se neexportují. */
function keepLangs(piece: string, tag: string, keep: Set<string>, alsoTags: string[] = []): string {
  const tags = [tag, ...alsoTags];
  let out = piece;
  for (const name of tags) {
    /*
     * `[^>/]`, ne `[^>]`: u prázdné hodnoty `<META_VALUE language="cz"/>`
     * by `[^>]*` snědlo lomítko, pokračovalo za `>` a skončilo až na
     * `</META_VALUE>` dalšího jazyka — s vyhozenou češtinou zmizela
     * i zapsaná slovenština. Ověření po zeštíhlení to hlásilo jako
     * „nezapsáno" u produktů, kterým ve feedu čeština chyběla.
     */
    const re = new RegExp(`\\s*<${name} language="([a-z]{2,5})"[^>/]*(?:/>|>[\\s\\S]*?</${name}>)`, 'g');
    out = out.replace(re, (match, lang) => (keep.has(lang) ? match : ''));
  }
  return out;
}

/**
 * V METAS zůstanou jen klíče, do kterých se psalo, a u každého jen
 * jazyky, které se psaly.
 *
 * Záznamy se hledají značkou `<META` **s atributy i bez nich**. Dřív se
 * tu dělilo podle „<META " s mezerou, takže z feedu, který záznamy píše
 * jako holé „<META>", nezbylo po zeštíhlení nic.
 */
function slimMetas(piece: string, psane: Map<string, Set<string>>): string {
  const kept: string[] = [];
  const re = /<META\b[^>]*>[\s\S]*?<\/META>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(piece))) {
    const key = /<META_KEY>([^<]*)<\/META_KEY>/.exec(m[0])?.[1]?.trim() ?? '';
    const jazyky = psane.get(key);
    if (!jazyky) continue;
    kept.push(keepLangs(m[0], 'META_VALUE', jazyky));
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

/**
 * Které sloupce importu soubor opravdu potřebuje.
 *
 * Upgates má v nastavení importu u každého údaje volbu „Nezpracovávat" /
 * „Úprava" a výchozí je „Úprava" u všeho — ceny, sklad, kategorie, obrázky,
 * varianty. Úsporný export ty části v souboru nemá, ale spoléhat na to, jak
 * Upgates naloží s chybějícím prvkem, je zbytečné riziko. Proto se v okně
 * importu nechá „Úprava" jen u toho, co v souboru je, a všechno ostatní se
 * přepne na „Nezpracovávat" — chybějící údaj se pak nemůže vynulovat.
 *
 * Názvy jsou hodnoty `name="columns-…"` z formuláře importu.
 */
export function importColumns(xml: string): string[] {
  const out: string[] = [];
  const has = (tag: string) => new RegExp(`<${tag}[\\s>]`).test(xml);
  if (has('TITLE')) out.push('title');
  if (has('SHORT_DESCRIPTION')) out.push('shortDescription');
  if (has('LONG_DESCRIPTION')) out.push('longDescription');
  if (has('SEO_URL')) out.push('seoURL');
  if (has('SEO_TITLE')) out.push('seoTitle');
  if (has('SEO_META_DESCRIPTION')) out.push('seoDescription');
  if (has('PARAMETER')) out.push('parameter');
  if (has('META')) out.push('meta_key', 'meta_value');
  return out;
}

/** Popisky sloupců tak, jak je ukazuje administrace — do hlášky. */
export const IMPORT_COLUMN_LABELS: Record<string, string> = {
  title: 'Název produktu', shortDescription: 'Krátký popis', longDescription: 'Dlouhý popis',
  seoURL: 'URL adresa', seoTitle: 'SEO titulek', seoDescription: 'META popis',
  parameter: 'Parametry', meta_key: 'Vlastní pole - klíč', meta_value: 'Vlastní pole - hodnota'
};
