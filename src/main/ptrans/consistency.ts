import { getDb } from '../db';
import { getPtransSettings } from './store';
import { plain } from './detect';

/**
 * Konzistence názvů.
 *
 * Když se každý produkt překládá zvlášť, model si pokaždé zvolí trochu jiný
 * slovosled: „Men's black tie", „Black tie for men", „Tie black men's". Pro
 * jeden produkt je to jedno, pro kategorii se sto kusy je to nepořádek, který
 * je vidět v e-shopu i ve feedu pro Google.
 *
 * Řeší se to třemi vrstvami, každá jinak silná:
 *   1. **Vzory** — z už hotových překladů se odvodí tvar názvu pro kategorii
 *      („Men's {…} tie") a ten se modelu předloží jako závazný.
 *   2. **Ukázky** — pár skutečných dvojic zdroj → překlad ze stejné kategorie.
 *      Model se řídí příkladem líp než popisem.
 *   3. **Kontrola** — po překladu se hledají názvy, které se vzoru vymykají,
 *      a nabídnou se k přegenerování.
 *
 * Ruční pravidlo v nastavení má přednost před odvozeným vzorem — někdy je
 * potřeba tvar určit dřív, než je z čeho odvozovat.
 */

export interface CategoryPattern {
  category: string;
  lang: string;
  /** Tvar názvu, např. „Men's {…} tie" */
  pattern: string;
  /** Z kolika hotových názvů se odvodil */
  samples: number;
  /** Kolik z nich vzoru odpovídá */
  matching: number;
}

export interface Example {
  source: string;
  target: string;
}

/** Slova, která nesou tvar názvu (opakují se), a ta, co se mění (barvy, vzory). */
function tokenize(title: string): string[] {
  return plain(title).toLowerCase().split(/[\s,–—-]+/).filter(Boolean);
}

/**
 * Odvodí tvar názvu ze skupiny hotových názvů.
 *
 * Slova, která jsou skoro ve všech názvech, tvoří kostru; ta ostatní se
 * nahradí `{…}`. Zachovává se pořadí podle nejčastější varianty, ne podle
 * abecedy — jde přece právě o slovosled.
 */
export function derivePattern(titles: string[]): { pattern: string; matching: number } {
  const clean = titles.map(t => plain(t)).filter(Boolean);
  if (clean.length < 3) return { pattern: '', matching: 0 };

  const counts = new Map<string, number>();
  for (const title of clean) {
    for (const word of new Set(tokenize(title))) {
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  const common = new Set(
    [...counts.entries()].filter(([, n]) => n / clean.length >= 0.6).map(([word]) => word)
  );
  if (common.size === 0) return { pattern: '', matching: 0 };

  // Kostra podle nejčastějšího pořadí: vezme se nejdelší název a proškrtá
  const shapes = new Map<string, number>();
  for (const title of clean) {
    const shape: string[] = [];
    for (const word of tokenize(title)) {
      if (common.has(word)) shape.push(word);
      else if (shape[shape.length - 1] !== '{…}') shape.push('{…}');
    }
    const key = shape.join(' ');
    shapes.set(key, (shapes.get(key) ?? 0) + 1);
  }
  const [best, matching] = [...shapes.entries()].sort((a, b) => b[1] - a[1])[0];
  // Vzor s velkým prvním písmenem vypadá jako skutečný název
  const pattern = best.charAt(0).toUpperCase() + best.slice(1);
  return { pattern, matching };
}

/** Odpovídá název tvaru kategorie? Porovnává se kostra, ne text. */
export function matchesPattern(title: string, pattern: string): boolean {
  if (!pattern) return true;
  const words = new Set(tokenize(pattern).filter(word => word !== '{…}'));
  if (words.size === 0) return true;
  const inTitle = tokenize(title);
  // Všechna kostra musí být v názvu a ve stejném pořadí
  let at = -1;
  for (const word of tokenize(pattern)) {
    if (word === '{…}') continue;
    const found = inTitle.indexOf(word, at + 1);
    if (found === -1) return false;
    at = found;
  }
  return true;
}

/** Hotové názvy v kategorii — podklad pro vzor i ukázky. */
function translatedTitles(category: string, lang: string, limit = 40):
  { source: string; target: string }[] {
  if (!category) return [];
  return getDb().prepare(
    `SELECT f.source_value AS source, COALESCE(f.translated, f.value) AS target
     FROM ptrans_fields f
     JOIN ptrans_products p ON p.code = f.code
     WHERE f.lang = ? AND f.field = 'title' AND f.state IN ('ok', 'manual')
       AND p.category = ? AND p.active = 1
       AND COALESCE(f.translated, f.value) != ''
     ORDER BY (f.translated IS NOT NULL) DESC, f.manual DESC, p.code
     LIMIT ?`
  ).all(lang, category, limit) as { source: string; target: string }[];
}

/** Vzor názvu pro kategorii a jazyk. Ruční pravidlo vyhrává nad odvozeným. */
export function patternFor(category: string, lang: string): CategoryPattern {
  const s = getPtransSettings();
  const manual = s.titleRules?.[lang]?.[category];
  const rows = translatedTitles(category, lang);
  if (manual) {
    return {
      category, lang, pattern: manual, samples: rows.length,
      matching: rows.filter(row => matchesPattern(row.target, manual)).length
    };
  }
  const derived = derivePattern(rows.map(row => row.target));
  return { category, lang, pattern: derived.pattern, samples: rows.length, matching: derived.matching };
}

/**
 * Ukázkové dvojice pro prompt.
 *
 * Vybírají se různé názvy, ne pět variant téhož — jinak model dostane pětkrát
 * stejnou informaci. Přednost mají překlady, které jsme dělali my nebo je
 * někdo ručně schválil.
 */
export function examplesFor(category: string, lang: string, limit = 4): Example[] {
  const rows = translatedTitles(category, lang);
  const out: Example[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const key = tokenize(row.target).slice(0, 3).join(' ');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ source: plain(row.source), target: plain(row.target) });
    if (out.length >= limit) break;
  }
  return out;
}

/** Kousek promptu se vzorem a ukázkami. Prázdný, když není z čeho vycházet. */
export function consistencyHint(category: string, lang: string): string {
  const pattern = patternFor(category, lang);
  const examples = examplesFor(category, lang);
  if (!pattern.pattern && examples.length === 0) return '';

  const lines: string[] = ['', 'Jednotnost názvů (důležité):'];
  if (pattern.pattern) {
    lines.push(`- Názvy v kategorii „${category}" mají v tomhle jazyce tvar: ${pattern.pattern}`);
    lines.push('- Dodrž stejný slovosled i pořadí přívlastků. Měň jen to, čím se produkt liší.');
  }
  if (examples.length > 0) {
    lines.push('- Hotové názvy ze stejné kategorie (drž se jejich stavby):');
    for (const example of examples) lines.push(`    ${example.source} → ${example.target}`);
  }
  return lines.join('\n');
}

/* ---------- kontrola po překladu ---------- */

export interface Deviation {
  code: string;
  title: string;
  translated: string;
  category: string;
  lang: string;
  pattern: string;
}

/**
 * Názvy, které se vymykají tvaru své kategorie.
 *
 * Kategorie s méně než pěti hotovými názvy se přeskakují — z tří kusů se
 * spolehlivý vzor odvodit nedá a hlásit „nesedí" by bylo plané.
 */
export function findDeviations(lang: string, limit = 200): Deviation[] {
  const d = getDb();
  const categories = d.prepare(
    `SELECT category, COUNT(*) AS n FROM ptrans_products
     WHERE active = 1 AND archived = 0 AND category != '' GROUP BY category HAVING n >= 5`
  ).all() as { category: string; n: number }[];

  const out: Deviation[] = [];
  for (const row of categories) {
    const pattern = patternFor(row.category, lang);
    if (!pattern.pattern || pattern.samples < 5) continue;
    // Vzor, kterému nesedí ani polovina názvů, není vzor
    if (pattern.matching / pattern.samples < 0.5) continue;

    const titles = d.prepare(
      `SELECT p.code, p.title, COALESCE(f.translated, f.value) AS target
       FROM ptrans_fields f JOIN ptrans_products p ON p.code = f.code
       WHERE f.lang = ? AND f.field = 'title' AND p.category = ? AND p.active = 1
         AND f.state IN ('ok', 'manual') AND COALESCE(f.translated, f.value) != ''`
    ).all(lang, row.category) as { code: string; title: string; target: string }[];

    for (const item of titles) {
      if (matchesPattern(item.target, pattern.pattern)) continue;
      out.push({
        code: item.code,
        title: item.title,
        translated: item.target,
        category: row.category,
        lang,
        pattern: pattern.pattern
      });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** Přehled vzorů pro nastavení: co se kde používá a jak moc to sedí. */
export function patternOverview(lang: string): CategoryPattern[] {
  const categories = getDb().prepare(
    `SELECT category, COUNT(*) AS n FROM ptrans_products
     WHERE active = 1 AND archived = 0 AND category != '' GROUP BY category ORDER BY n DESC`
  ).all() as { category: string; n: number }[];

  return categories
    .map(row => patternFor(row.category, lang))
    .filter(pattern => pattern.samples > 0);
}
