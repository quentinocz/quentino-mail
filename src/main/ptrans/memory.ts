import { getDb } from '../db';
import { getPtransSettings, targetLangs } from './store';
import { plain } from './detect';
import { derivePattern } from './consistency';

/**
 * Paměť překladů — co se aplikace naučila z už hotových jazykových mutací.
 *
 * Ve feedu je přes tisíc produktů, které někdo přeložil dřív. Je v nich schovaná
 * odpověď na otázku „jak se u nás překládá": že kšandy jsou v SK „traky" a v EN
 * „suspenders", že „pánská kravata" je „men's necktie" (a ne „necktie for men")
 * a že barvy mají ustálené tvary. Nový produkt se má přeložit stejně — jinak
 * e-shop vypadá, jako by ho psalo pět různých lidí.
 *
 * Paměť se plní **automaticky rozborem feedu**, ne ručním psaním:
 *
 *  - **výrazy** (`term`) se páruji statisticky. Pro každé české slovo se hledá
 *    cizí slovo, které se s ním v názvech objevuje společně — Diceovým
 *    koeficientem, tedy poměrem společných výskytů k součtu samostatných.
 *    Trojice „bordó → burgundy" vyskočí sama, protože se objevuje spolu
 *    a nikde jinde.
 *  - **vzory** (`pattern`) drží slovosled podle kategorie („{…} men's necktie").
 *  - **ukázky** (`example`) jsou skutečné dvojice názvů — model se řídí
 *    příkladem líp než popisem.
 *
 * Ručně přidaný nebo upravený záznam se zamkne a učení ho nepřepíše.
 */

export type MemoryKind = 'term' | 'pattern' | 'example';

export interface MemoryEntry {
  id?: number;
  kind: MemoryKind;
  lang: string;
  /** Zdrojový text (výraz, kostra názvu, celý název) */
  source: string;
  target: string;
  category: string;
  /** Kolikrát je dvojice doložená ve feedu */
  hits: number;
  /** 0–1; u výrazů Diceův koeficient, u vzorů podíl sedících názvů */
  confidence: number;
  origin: 'feed' | 'manual';
  locked: boolean;
  updatedAt?: string;
}

/* ---------- ukládání ---------- */

export function listMemory(filter: { lang?: string; kind?: MemoryKind; search?: string } = {}): MemoryEntry[] {
  const where: string[] = [];
  const params: any[] = [];
  if (filter.lang && filter.lang !== 'all') { where.push('lang = ?'); params.push(filter.lang); }
  if (filter.kind) { where.push('kind = ?'); params.push(filter.kind); }
  if (filter.search) {
    where.push('(lower(source) LIKE ? OR lower(target) LIKE ?)');
    const like = `%${filter.search.toLowerCase()}%`;
    params.push(like, like);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = getDb().prepare(
    `SELECT * FROM ptrans_memory ${clause}
     ORDER BY locked DESC, kind, hits DESC, source LIMIT 800`
  ).all(...params) as any[];
  return rows.map(toEntry);
}

function toEntry(row: any): MemoryEntry {
  return {
    id: row.id,
    kind: row.kind,
    lang: row.lang,
    source: row.source,
    target: row.target,
    category: row.category,
    hits: row.hits,
    confidence: row.confidence,
    origin: row.origin,
    locked: row.locked === 1,
    updatedAt: row.updated_at
  };
}

export function saveMemory(entry: MemoryEntry): void {
  getDb().prepare(`
    INSERT INTO ptrans_memory (kind, lang, source, target, category, hits, confidence, origin, locked, updated_at)
    VALUES (@kind, @lang, @source, @target, @category, @hits, @confidence, @origin, @locked, @at)
    ON CONFLICT(kind, lang, source, category) DO UPDATE SET
      target = excluded.target, hits = excluded.hits, confidence = excluded.confidence,
      origin = excluded.origin, locked = excluded.locked, updated_at = excluded.updated_at
  `).run({
    kind: entry.kind,
    lang: entry.lang,
    source: entry.source,
    target: entry.target,
    category: entry.category ?? '',
    hits: entry.hits ?? 0,
    confidence: entry.confidence ?? 1,
    origin: entry.origin ?? 'manual',
    locked: entry.locked ? 1 : 0,
    at: new Date().toISOString()
  });
}

export function deleteMemory(id: number): void {
  getDb().prepare('DELETE FROM ptrans_memory WHERE id = ?').run(id);
}

/* ---------- učení z feedu ---------- */

interface Pair {
  source: string;
  target: string;
  category: string;
}

/** Dvojice názvů, u kterých je překlad hotový — podklad pro učení. */
function titlePairs(lang: string): Pair[] {
  const s = getPtransSettings();
  const rows = getDb().prepare(
    `SELECT f.source_value AS source, COALESCE(f.translated, f.value) AS target, p.category
     FROM ptrans_fields f
     JOIN ptrans_products p ON p.code = f.code
     WHERE f.lang = ? AND f.field = 'title' AND f.state IN ('ok', 'manual')
       AND p.active = 1 AND p.archived = 0
       AND f.source_value != '' AND COALESCE(f.translated, f.value) != ''`
  ).all(lang) as Pair[];

  // Dvojice, kde je „překlad" doslova zdroj, by paměť jen zaplevelila
  return rows.filter(pair => plain(pair.source).toLowerCase() !== plain(pair.target).toLowerCase()
    && s.sourceLang !== lang);
}

const STOP_WORDS = new Set(['a', 'i', 's', 'se', 'v', 've', 'na', 'do', 'k', 'ke', 'z', 'ze', 'o',
  'the', 'and', 'of', 'for', 'with', 'in', 'to', 'a']);

function words(text: string): string[] {
  return plain(text).toLowerCase()
    // Apostrof je součást slova: „men's" je jeden výraz, ne „men" a „s"
    .replace(/[^\p{L}\p{N}\s'’-]/gu, ' ')
    .replace(/[’]/g, "'")
    .split(/[\s-]+/)
    .map(word => word.replace(/^'+|'+$/g, ''))
    .filter(word => word.length >= 2 && !STOP_WORDS.has(word));
}

/**
 * Slova a jejich spojení. Spojení drží slovosled („pánská kravata") a na cizí
 * straně pokrývají i případy, kdy jedno české slovo odpovídá dvěma nebo třem
 * cizím: kapesníček → pocket square, motýlek → bow tie.
 */
function phrases(text: string, maxLength = 2): string[] {
  const list = words(text);
  const out = [...list];
  for (let size = 2; size <= maxLength; size++) {
    for (let i = 0; i + size <= list.length; i++) out.push(list.slice(i, i + size).join(' '));
  }
  return [...new Set(out)];
}

export interface LearnResult {
  lang: string;
  pairs: number;
  terms: number;
  patterns: number;
  examples: number;
}

/**
 * Naučí se z hotových překladů.
 *
 * Nic se nemaže: zamčené (ručně upravené) záznamy zůstávají, ostatní se
 * přepíšou čerstvě spočítanými. Když se výraz přestane potvrzovat, spadne mu
 * jistota a v přehledu je hned vidět.
 */
export function learnFromFeed(langs?: string[]): LearnResult[] {
  const list = langs?.length ? langs : targetLangs();
  const out: LearnResult[] = [];

  for (const lang of list) {
    const pairs = titlePairs(lang);
    if (pairs.length < 5) {
      out.push({ lang, pairs: pairs.length, terms: 0, patterns: 0, examples: 0 });
      continue;
    }

    const terms = learnTerms(pairs, lang);
    const patterns = learnPatterns(pairs, lang);
    const examples = learnExamples(pairs, lang);
    out.push({ lang, pairs: pairs.length, terms, patterns, examples });
  }
  return out;
}

/**
 * Spárování výrazů podle společného výskytu.
 *
 * Pro každý zdrojový výraz se spočítá, s jakým cizím výrazem se v názvech
 * potkává. Dice = 2 × společné výskyty ÷ (výskyty zdroje + výskyty cíle);
 * jednička znamená „vždycky spolu a nikde jinde".
 */
function learnTerms(pairs: Pair[], lang: string): number {
  const sourceCount = new Map<string, number>();
  const targetCount = new Map<string, number>();
  const together = new Map<string, Map<string, number>>();

  for (const pair of pairs) {
    const left = phrases(pair.source);
    const right = phrases(pair.target, 3);
    for (const word of left) sourceCount.set(word, (sourceCount.get(word) ?? 0) + 1);
    for (const word of right) targetCount.set(word, (targetCount.get(word) ?? 0) + 1);
    for (const word of left) {
      const row = together.get(word) ?? new Map<string, number>();
      for (const other of right) row.set(other, (row.get(other) ?? 0) + 1);
      together.set(word, row);
    }
  }

  const locked = new Set(
    (getDb().prepare("SELECT source FROM ptrans_memory WHERE kind = 'term' AND lang = ? AND locked = 1")
      .all(lang) as { source: string }[]).map(row => row.source)
  );

  getDb().prepare("DELETE FROM ptrans_memory WHERE kind = 'term' AND lang = ? AND locked = 0").run(lang);

  let saved = 0;
  for (const [source, occurrences] of sourceCount) {
    if (occurrences < 3 || locked.has(source)) continue;
    const row = together.get(source);
    if (!row) continue;

    const scores: { target: string; dice: number; hits: number }[] = [];
    for (const [target, hits] of row) {
      if (hits < 3) continue;
      scores.push({
        target,
        dice: (2 * hits) / (occurrences + (targetCount.get(target) ?? 0)),
        hits
      });
    }
    scores.sort((a, b) => b.dice - a.dice);
    let [top] = scores;
    if (!top) continue;

    // Delší tvar, který ten nejlepší obsahuje a je skoro stejně doložený, je
    // přesnější: „kapesníček → pocket" se takhle opraví na „pocket square"
    const longer = scores.find(item => item.target !== top.target
      && item.target.split(' ').length > top.target.split(' ').length
      && item.target.includes(top.target)
      && item.dice >= top.dice * 0.85);
    if (longer) top = longer;

    const best = top.target;
    const bestScore = top.dice;
    const bestHits = top.hits;
    // Nejlepší shoda je totéž slovo → v tomhle jazyce se výraz nemění a není
    // co učit. Brát druhého v pořadí by vyrobilo nesmysl.
    if (best === source) continue;
    // Práh 0,55 je usazený na skutečném feedu: níž začne přibývat nesmyslů
    // typu „pánská → blue", které jen shodou okolností chodí spolu
    if (!best || bestScore < 0.55) continue;

    saveMemory({
      kind: 'term', lang, source, target: best, category: '',
      hits: bestHits, confidence: Number(bestScore.toFixed(2)), origin: 'feed', locked: false
    });
    saved++;
  }
  return saved;
}

/** Tvar názvu podle kategorie — zdroj i cíl, ať je vidět, co se s čím páruje. */
function learnPatterns(pairs: Pair[], lang: string): number {
  const byCategory = new Map<string, Pair[]>();
  for (const pair of pairs) {
    if (!pair.category) continue;
    const list = byCategory.get(pair.category) ?? [];
    list.push(pair);
    byCategory.set(pair.category, list);
  }

  getDb().prepare("DELETE FROM ptrans_memory WHERE kind = 'pattern' AND lang = ? AND locked = 0").run(lang);

  let saved = 0;
  for (const [category, list] of byCategory) {
    if (list.length < 5) continue;
    const source = derivePattern(list.map(pair => pair.source));
    const target = derivePattern(list.map(pair => pair.target));
    if (!target.pattern) continue;

    const locked = getDb().prepare(
      "SELECT 1 FROM ptrans_memory WHERE kind = 'pattern' AND lang = ? AND category = ? AND locked = 1"
    ).get(lang, category);
    if (locked) continue;

    saveMemory({
      kind: 'pattern', lang, category,
      source: source.pattern || '(různé)',
      target: target.pattern,
      hits: list.length,
      confidence: Number((target.matching / list.length).toFixed(2)),
      origin: 'feed', locked: false
    });
    saved++;
  }
  return saved;
}

/** Pár skutečných dvojic na kategorii — do promptu jako příklad. */
function learnExamples(pairs: Pair[], lang: string, perCategory = 3): number {
  getDb().prepare("DELETE FROM ptrans_memory WHERE kind = 'example' AND lang = ? AND locked = 0").run(lang);

  const byCategory = new Map<string, Pair[]>();
  for (const pair of pairs) {
    const list = byCategory.get(pair.category || '') ?? [];
    list.push(pair);
    byCategory.set(pair.category || '', list);
  }

  let saved = 0;
  for (const [category, list] of byCategory) {
    const seen = new Set<string>();
    let taken = 0;
    for (const pair of list) {
      // Ukázky mají být různé — pět variant téhož modelu nic nepřidá
      const key = words(pair.target).slice(0, 2).join(' ');
      if (seen.has(key)) continue;
      seen.add(key);
      saveMemory({
        kind: 'example', lang, category,
        source: plain(pair.source), target: plain(pair.target),
        hits: 1, confidence: 1, origin: 'feed', locked: false
      });
      saved++;
      if (++taken >= perCategory) break;
    }
  }
  return saved;
}

/* ---------- použití při překladu ---------- */

/**
 * Část promptu s tím, co se hodí zrovna pro tenhle text.
 *
 * Do promptu jde jen to, co se v překládaném textu opravdu vyskytuje —
 * kdyby tam byl celý slovník o tisíci výrazech, model by v něm utonul a
 * platilo by se za tokeny, které nic neřeší.
 */
export function memoryHint(text: string, lang: string, category: string): string {
  const d = getDb();
  const found = new Set(phrases(text));
  if (found.size === 0) return '';

  const rows = d.prepare(
    `SELECT source, target, confidence FROM ptrans_memory
     WHERE kind = 'term' AND lang = ? ORDER BY length(source) DESC, hits DESC`
  ).all(lang) as { source: string; target: string; confidence: number }[];

  // Delší shoda vyhrává: když sedí „pánská kravata → men's necktie", jednotlivá
  // slova už do promptu nemusí — jen by si s víceslovným tvarem konkurovala
  const matched = rows.filter(row => found.has(row.source));
  const covered = new Set<string>();
  const terms: typeof matched = [];
  for (const row of matched) {
    const parts = row.source.split(' ');
    if (parts.length > 1) parts.forEach(part => covered.add(part));
    if (parts.length === 1 && covered.has(row.source)) continue;
    terms.push(row);
    if (terms.length >= 25) break;
  }

  const pattern = d.prepare(
    `SELECT source, target FROM ptrans_memory WHERE kind = 'pattern' AND lang = ? AND category = ?`
  ).get(lang, category) as { source: string; target: string } | undefined;

  const examples = d.prepare(
    `SELECT source, target FROM ptrans_memory WHERE kind = 'example' AND lang = ? AND category = ? LIMIT 4`
  ).all(lang, category) as { source: string; target: string }[];

  if (terms.length === 0 && !pattern && examples.length === 0) return '';

  const lines: string[] = ['', 'Jak se to u nás překládá (drž se toho):'];
  if (terms.length) {
    lines.push('- ustálené výrazy:');
    for (const term of terms) lines.push(`    ${term.source} → ${term.target}`);
  }
  if (pattern?.target) {
    lines.push(`- tvar názvu v kategorii „${category}": ${pattern.target}`);
    if (pattern.source && pattern.source !== '(různé)') lines.push(`  (ve zdroji: ${pattern.source})`);
    lines.push('  Dodrž stejný slovosled i pořadí přívlastků.');
  }
  if (examples.length) {
    lines.push('- hotové dvojice ze stejné kategorie:');
    for (const example of examples) lines.push(`    ${example.source} → ${example.target}`);
  }
  return lines.join('\n');
}

/** Přehled do rozhraní: kolik se toho aplikace naučila. */
export function memoryStats(): { lang: string; terms: number; patterns: number; examples: number; manual: number }[] {
  const rows = getDb().prepare(
    `SELECT lang, kind, COUNT(*) AS n, SUM(locked) AS locked FROM ptrans_memory GROUP BY lang, kind`
  ).all() as { lang: string; kind: string; n: number; locked: number }[];

  const map = new Map<string, { lang: string; terms: number; patterns: number; examples: number; manual: number }>();
  for (const row of rows) {
    const entry = map.get(row.lang) ?? { lang: row.lang, terms: 0, patterns: 0, examples: 0, manual: 0 };
    if (row.kind === 'term') entry.terms = row.n;
    if (row.kind === 'pattern') entry.patterns = row.n;
    if (row.kind === 'example') entry.examples = row.n;
    entry.manual += row.locked ?? 0;
    map.set(row.lang, entry);
  }
  return [...map.values()];
}
