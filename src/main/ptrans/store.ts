import { getDb, getSetting, setSetting } from '../db';
import { splitProducts, tagText, getField, productParameters, paramKey, TEXT_FIELDS } from './xml';
import { fieldState, hashText, plain, FieldState, NEEDS_WORK } from './detect';

/**
 * Databáze produktů pro překlady.
 *
 * Feed z Upgates je zdroj pravdy o produktech, ale ne o tom, co je hotové —
 * to si aplikace musí pamatovat sama (kdy jsme co přeložili a z jakého
 * originálu). Proto se ukládá dvojí:
 *   - `ptrans_products` — produkt i s **původním blokem XML**, aby šel export
 *     poskládat přesně ve tvaru, jaký Upgates přijímá zpět,
 *   - `ptrans_fields` — jednotlivá pole po jazycích i se stavem překladu.
 */

export { SCHEMA } from './schema';

export interface PtransLanguage {
  code: string;
  label: string;
  enabled: boolean;
}

export interface PtransSettings {
  /** Z čeho se překládá; ve feedu je to jazyk s vyplněnými texty */
  sourceLang: string;
  languages: PtransLanguage[];
  /** Která pole se překládají */
  fields: Record<string, boolean>;
  /** Vlastní pokyny pro překlad (tón značky, čeho se držet) */
  prompt: string;
  /** Termíny, které mají v každém jazyce znít stejně */
  glossary: { source: string; targets: Record<string, string> }[];
  /** Šablona Google titulku po jazycích, např. „{title} {param:Barva} | Quentino" */
  googleTitle: Record<string, string>;
  /** Ruční tvar názvu podle jazyka a kategorie: titleRules['en']['Kravaty'] */
  titleRules?: Record<string, Record<string, string>>;
  limits: { seoTitle: number; seoDesc: number; googleTitle: number; googleDesc: number };
  model: string;
  /** Kolik produktů se překládá najednou */
  concurrency: number;
  /** Naměřená rychlost — kolik sekund zabere jeden produkt a jazyk */
  secondsPerUnit: number;
}

const DEFAULTS: PtransSettings = {
  sourceLang: 'cz',
  languages: [
    { code: 'sk', label: 'Slovenština', enabled: true },
    { code: 'en', label: 'Angličtina', enabled: true },
    { code: 'de', label: 'Němčina', enabled: false }
  ],
  fields: {
    title: true, short: true, long: true,
    seo_title: true, seo_desc: true, seo_url: true,
    google_title: false, google_desc: false,
    params: false
  },
  prompt: '',
  glossary: [],
  googleTitle: {},
  titleRules: {},
  limits: { seoTitle: 70, seoDesc: 155, googleTitle: 150, googleDesc: 5000 },
  model: '',
  concurrency: 2,
  secondsPerUnit: 12
};

export function getPtransSettings(): PtransSettings {
  try {
    const raw = getSetting('ptrans', '');
    const saved = raw ? JSON.parse(raw) : {};
    return {
      ...DEFAULTS,
      ...saved,
      fields: { ...DEFAULTS.fields, ...(saved.fields ?? {}) },
      limits: { ...DEFAULTS.limits, ...(saved.limits ?? {}) },
      titleRules: saved.titleRules ?? {},
      languages: Array.isArray(saved.languages) && saved.languages.length
        ? saved.languages
        : DEFAULTS.languages
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function savePtransSettings(patch: Partial<PtransSettings>): PtransSettings {
  const next = { ...getPtransSettings(), ...patch };
  setSetting('ptrans', JSON.stringify(next));
  return next;
}

/** Jazyky, do kterých se právě překládá. */
export function targetLangs(s = getPtransSettings()): string[] {
  return s.languages.filter(l => l.enabled).map(l => l.code);
}

/* ---------- naplnění z feedu ---------- */

export interface SyncResult {
  products: number;
  fields: number;
  removed: number;
  /** Kolik dřív ručně nahraných produktů se objevilo v online feedu */
  paired: number;
  at: string;
}

export interface IngestOptions {
  /** `feed` = online feed (uklidí, co zmizelo), `file` = ručně nahraný soubor */
  origin?: 'feed' | 'file';
}

/**
 * Projde feed a přepíše databázi produktů.
 *
 * Překlady, které jsme udělali, se nepřepisují — u každého pole zůstává, co
 * a kdy jsme přeložili, aby se poznalo, že se od té doby změnil originál.
 */
export function syncFromFeed(xml: string): SyncResult {
  return ingest(xml, { origin: 'feed' });
}

/**
 * Produkty z ručně nahraného souboru.
 *
 * Nové zboží se do online feedu propíše se zpožděním, ale překládat se dá
 * hned. Produkty se uloží stejně jako z feedu, jen s příznakem `file`, aby je
 * úklid po stažení feedu nesmazal. Až se objeví ve feedu, spárují se podle
 * kódu — překlady u nich zůstanou, protože se vážou právě na kód.
 */
export function ingestFile(xml: string): SyncResult {
  return ingest(xml, { origin: 'file' });
}

function ingest(xml: string, options: IngestOptions = {}): SyncResult {
  const d = getDb();
  const s = getPtransSettings();
  const langs = targetLangs(s);
  const now = new Date().toISOString();
  const products = splitProducts(xml);
  if (products.length === 0) throw new Error('Feed neobsahuje žádné produkty — zkontroluj adresu.');

  const origin = options.origin ?? 'feed';
  const upsertProduct = d.prepare(`
    INSERT INTO ptrans_products (code, product_id, active, archived, title, image, category, categories,
      manufacturer, availability, stock, price, url, raw_xml, source_hash, seen_at, origin, added_at)
    VALUES (@code, @product_id, @active, @archived, @title, @image, @category, @categories,
      @manufacturer, @availability, @stock, @price, @url, @raw_xml, @source_hash, @seen_at,
      @origin, @seen_at)
    ON CONFLICT(code) DO UPDATE SET
      product_id = excluded.product_id, active = excluded.active, archived = excluded.archived,
      title = excluded.title, image = excluded.image, category = excluded.category,
      categories = excluded.categories, manufacturer = excluded.manufacturer,
      availability = excluded.availability, stock = excluded.stock, price = excluded.price,
      url = excluded.url, raw_xml = excluded.raw_xml, source_hash = excluded.source_hash,
      seen_at = excluded.seen_at,
      -- Jakmile produkt dorazí ve feedu, přepíná se z „ze souboru" na „z feedu"
      origin = CASE WHEN excluded.origin = 'feed' THEN 'feed' ELSE ptrans_products.origin END
  `);

  const readField = d.prepare(
    'SELECT translated, translated_hash, manual FROM ptrans_fields WHERE code = ? AND lang = ? AND field = ?'
  );
  const upsertField = d.prepare(`
    INSERT INTO ptrans_fields (code, lang, field, value, source_value, state)
    VALUES (@code, @lang, @field, @value, @source_value, @state)
    ON CONFLICT(code, lang, field) DO UPDATE SET
      value = excluded.value, source_value = excluded.source_value, state = excluded.state
  `);

  const fromFile = new Set(
    (d.prepare("SELECT code FROM ptrans_products WHERE origin = 'file'").all() as { code: string }[])
      .map(row => row.code)
  );
  let paired = 0;
  let fields = 0;
  const run = d.transaction(() => {
    for (const { code, block } of products) {
      if (origin === 'feed' && fromFile.has(code)) paired++;
      const sourceOf = (field: string) => getField(block, s.sourceLang, field) ?? '';
      const title = sourceOf('title');
      const sourceHash = hashText([sourceOf('title'), sourceOf('short'), sourceOf('long')].join('\n'));

      upsertProduct.run({
        code,
        product_id: tagText(block, 'PRODUCT_ID'),
        active: tagText(block, 'ACTIVE_YN') === '0' ? 0 : 1,
        archived: tagText(block, 'ARCHIVED_YN') === '1' ? 1 : 0,
        title,
        image: mainImage(block),
        category: primaryCategory(block),
        categories: allCategories(block).join('\n'),
        manufacturer: tagText(block, 'MANUFACTURER'),
        availability: tagText(block, 'AVAILABILITY'),
        stock: numberOrNull(tagText(block, 'STOCK')),
        price: sourcePrice(block, s.sourceLang),
        url: getField(block, s.sourceLang, 'seo_url') ?? '',
        raw_xml: block,
        source_hash: sourceHash,
        origin,
        seen_at: now
      });

      const keys = fieldKeys(block, s);
      for (const lang of langs) {
        for (const field of keys) {
          const value = getField(block, lang, field) ?? '';
          const source = getField(block, s.sourceLang, field) ?? '';
          const saved = readField.get(code, lang, field) as
            { translated: string | null; translated_hash: string | null; manual: number } | undefined;

          // Když je v feedu pořád to, co jsme přeložili, bere se jako náš překlad
          const ours = !!saved?.translated && plain(saved.translated) === plain(value);
          const state: FieldState = fieldState({
            value,
            source,
            sourceLang: s.sourceLang,
            targetLang: lang,
            translatedHash: ours ? saved?.translated_hash : null,
            sourceHash: hashText(source),
            manual: saved?.manual === 1
          });

          upsertField.run({ code, lang, field, value, source_value: source, state });
          fields++;
        }
      }
    }
  });
  run();

  // Ručně nahrané produkty úklid přeskakuje — ve feedu ještě nejsou a smazat
  // je by znamenalo zahodit i jejich překlady
  const removed = origin === 'feed'
    ? d.prepare("DELETE FROM ptrans_products WHERE seen_at != ? AND origin = 'feed'").run(now).changes
    : 0;
  d.prepare('DELETE FROM ptrans_fields WHERE code NOT IN (SELECT code FROM ptrans_products)').run();
  setSetting('ptransSyncedAt', now);

  return { products: products.length, fields, removed, paired, at: now };
}

/** Klíče polí, která se u produktu sledují (podle nastavení). */
export function fieldKeys(block: string, s = getPtransSettings()): string[] {
  const keys = TEXT_FIELDS.filter(f => s.fields[f] !== false) as string[];
  if (s.fields.params) {
    const count = productParameters(block).length;
    for (let i = 0; i < count; i++) {
      keys.push(paramKey(i, 'name'), paramKey(i, 'value'));
    }
  }
  return keys;
}

/* ---------- drobnosti z bloku produktu ---------- */

function numberOrNull(value: string): number | null {
  const n = Number(String(value).replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n) : null;
}

function mainImage(block: string): string | null {
  const wrap = /<IMAGES>([\s\S]*?)<\/IMAGES>/.exec(block);
  if (!wrap) return null;
  let first: string | null = null;
  let main: string | null = null;
  for (const part of wrap[1].split('<IMAGE>').slice(1)) {
    const url = tagText(part, 'URL');
    if (!url) continue;
    if (!first) first = url;
    if (!main && tagText(part, 'MAIN_YN') === '1') main = url;
  }
  return main ?? first;
}

function categoryBlocks(block: string): string[] {
  const wrap = /<CATEGORIES>([\s\S]*?)<\/CATEGORIES>/.exec(block);
  if (!wrap) return [];
  return wrap[1].split('<CATEGORY>').slice(1).map(part => part.split('</CATEGORY>')[0]);
}

function primaryCategory(block: string): string {
  const list = categoryBlocks(block);
  const primary = list.find(part => tagText(part, 'PRIMARY_YN') === '1');
  return tagText(primary ?? list[0] ?? '', 'NAME');
}

function allCategories(block: string): string[] {
  return categoryBlocks(block).map(part => tagText(part, 'NAME')).filter(Boolean);
}

function sourcePrice(block: string, lang: string): string {
  const price = new RegExp(`<PRICE language="${lang}"[^>]*>([\\s\\S]*?)</PRICE>`).exec(block);
  if (!price) return '';
  const list = /<PRICELIST>([\s\S]*?)<\/PRICELIST>/.exec(price[1]);
  const body = list ? list[1] : price[1];
  const value = tagText(body, 'PRICE_SALE') || tagText(body, 'PRICE_WITH_VAT');
  const currency = tagText(price[1], 'CURRENCY');
  return value ? `${value} ${currency}`.trim() : '';
}

/* ---------- čtení pro rozhraní ---------- */

export interface ProductRow {
  code: string;
  title: string;
  image: string | null;
  category: string;
  manufacturer: string;
  availability: string;
  price: string;
  active: boolean;
  /** Stav po jazycích: kolik polí je hotových a kolik čeká */
  states: Record<string, { total: number; todo: number; worst: FieldState }>;
}

const STATE_ORDER: FieldState[] = ['missing', 'same', 'source', 'stale', 'manual', 'ok'];

export interface ProductQueryInput {
  search?: string;
  category?: string;
  manufacturer?: string;
  /** Jen produkty, které mají v tomhle jazyce co dělat */
  lang?: string;
  state?: FieldState | 'todo' | 'all';
  field?: string;
  onlyActive?: boolean;
  limit?: number;
  offset?: number;
  sort?: 'title' | 'todo' | 'code';
}

export function listProducts(query: ProductQueryInput): { rows: ProductRow[]; total: number; todo: number } {
  const d = getDb();
  const s = getPtransSettings();
  const langs = query.lang && query.lang !== 'all' ? [query.lang] : targetLangs(s);

  const where: string[] = [];
  const params: any[] = [];
  if (query.onlyActive !== false) where.push('p.active = 1 AND p.archived = 0');
  if (query.search) {
    where.push('(lower(p.title) LIKE ? OR lower(p.code) LIKE ?)');
    const like = `%${query.search.toLowerCase()}%`;
    params.push(like, like);
  }
  if (query.category) { where.push('p.categories LIKE ?'); params.push(`%${query.category}%`); }
  if (query.manufacturer) { where.push('p.manufacturer = ?'); params.push(query.manufacturer); }

  const wanted = query.state && query.state !== 'all'
    ? (query.state === 'todo' ? NEEDS_WORK : [query.state])
    : null;

  const fieldFilter = query.field ? ' AND f.field = ?' : '';
  const langList = langs.map(() => '?').join(',');

  // Produkty, které vyhovují filtru stavu (aspoň jedno pole v daném stavu)
  if (wanted) {
    where.push(`EXISTS (SELECT 1 FROM ptrans_fields f WHERE f.code = p.code AND f.lang IN (${langList})
      AND f.state IN (${wanted.map(() => '?').join(',')})${fieldFilter})`);
    params.push(...langs, ...wanted);
    if (query.field) params.push(query.field);
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (d.prepare(`SELECT COUNT(*) AS n FROM ptrans_products p ${clause}`).get(...params) as any).n as number;

  const order = query.sort === 'code' ? 'p.code' : 'p.title';
  const rows = d.prepare(
    `SELECT p.* FROM ptrans_products p ${clause} ORDER BY ${order} LIMIT ? OFFSET ?`
  ).all(...params, query.limit ?? 60, query.offset ?? 0) as any[];

  const stateRows = d.prepare(
    `SELECT code, lang, state, COUNT(*) AS n FROM ptrans_fields
     WHERE code = ? AND lang IN (${langList}) GROUP BY lang, state`
  );

  const out: ProductRow[] = rows.map(row => {
    const states: ProductRow['states'] = {};
    for (const entry of stateRows.all(row.code, ...langs) as any[]) {
      const bucket = states[entry.lang] ?? (states[entry.lang] = { total: 0, todo: 0, worst: 'ok' });
      bucket.total += entry.n;
      if (NEEDS_WORK.includes(entry.state)) bucket.todo += entry.n;
      if (STATE_ORDER.indexOf(entry.state) < STATE_ORDER.indexOf(bucket.worst)) bucket.worst = entry.state;
    }
    return {
      code: row.code,
      title: row.title,
      image: row.image,
      category: row.category,
      manufacturer: row.manufacturer,
      availability: row.availability,
      price: row.price,
      active: row.active === 1,
      states
    };
  });

  const todo = (d.prepare(
    `SELECT COUNT(DISTINCT code) AS n FROM ptrans_fields
     WHERE lang IN (${langList}) AND state IN (${NEEDS_WORK.map(() => '?').join(',')})`
  ).get(...langs, ...NEEDS_WORK) as any).n as number;

  return { rows: out, total, todo };
}

export interface FieldRow {
  code: string;
  lang: string;
  field: string;
  value: string;
  source: string;
  state: FieldState;
  translated: string | null;
  translatedAt: string | null;
  model: string;
  manual: boolean;
}

export function productFields(code: string, langs?: string[]): FieldRow[] {
  const list = langs ?? targetLangs();
  const rows = getDb().prepare(
    `SELECT * FROM ptrans_fields WHERE code = ? AND lang IN (${list.map(() => '?').join(',')})
     ORDER BY lang, field`
  ).all(code, ...list) as any[];
  return rows.map(row => ({
    code: row.code,
    lang: row.lang,
    field: row.field,
    value: row.value,
    source: row.source_value,
    state: row.state,
    translated: row.translated,
    translatedAt: row.translated_at,
    model: row.model,
    manual: row.manual === 1
  }));
}

/** Uloží překlad jednoho pole a rovnou ho promítne do „hodnoty ve feedu". */
export function saveTranslation(code: string, lang: string, field: string, value: string,
                                model: string, manual = false): void {
  const d = getDb();
  const row = d.prepare('SELECT source_value FROM ptrans_fields WHERE code = ? AND lang = ? AND field = ?')
    .get(code, lang, field) as { source_value: string } | undefined;
  const source = row?.source_value ?? '';
  d.prepare(`
    INSERT INTO ptrans_fields (code, lang, field, value, source_value, state, translated, translated_at,
      translated_hash, model, manual)
    VALUES (@code, @lang, @field, @value, @source, @state, @value, @at, @hash, @model, @manual)
    ON CONFLICT(code, lang, field) DO UPDATE SET
      value = excluded.value, state = excluded.state, translated = excluded.translated,
      translated_at = excluded.translated_at, translated_hash = excluded.translated_hash,
      model = excluded.model, manual = excluded.manual
  `).run({
    code, lang, field, value, source,
    state: manual ? 'manual' : 'ok',
    at: new Date().toISOString(),
    hash: hashText(source),
    model,
    manual: manual ? 1 : 0
  });
}

/** Přehled do hlavičky: kolik polí čeká v jednotlivých jazycích. */
export function summary(): { lang: string; todo: number; total: number; byState: Record<string, number> }[] {
  const d = getDb();
  return targetLangs().map(lang => {
    const rows = d.prepare(
      `SELECT state, COUNT(*) AS n FROM ptrans_fields f
       JOIN ptrans_products p ON p.code = f.code AND p.active = 1 AND p.archived = 0
       WHERE lang = ? GROUP BY state`
    ).all(lang) as any[];
    const byState: Record<string, number> = {};
    let total = 0;
    let todo = 0;
    for (const row of rows) {
      byState[row.state] = row.n;
      total += row.n;
      if (NEEDS_WORK.includes(row.state)) todo += row.n;
    }
    return { lang, todo, total, byState };
  });
}

export function feedInfo(): { syncedAt: string | null; products: number } {
  const products = (getDb().prepare('SELECT COUNT(*) AS n FROM ptrans_products').get() as any).n as number;
  return { syncedAt: getSetting('ptransSyncedAt', '') || null, products };
}
