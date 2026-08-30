import { getDb, getSetting, setSetting } from '../db';
import { splitProducts, tagText, getField, productParameters, paramKey, productUrl, TEXT_FIELDS } from './xml';
import { fieldState, hashText, plain, FieldState, NEEDS_WORK } from './detect';
import { needsTidy } from './html';

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
  limits: {
    seoTitle: number; seoDesc: number;
    /** Technický strop Googlu */
    googleTitle: number;
    /** Kolik z titulku Google v inzerátu opravdu zobrazí — sem se cílí */
    googleTitleVisible: number;
    googleDesc: number;
  };
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
    seo_title: true, seo_desc: true, seo_url: true, redirect: true,
    google_title: false, google_desc: false,
    params: false
  },
  prompt: '',
  glossary: [],
  googleTitle: {},
  titleRules: {},
  limits: { seoTitle: 70, seoDesc: 155, googleTitle: 150, googleTitleVisible: 70, googleDesc: 5000 },
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
  /**
   * Neuklízet produkty, které v tomhle vstupu nejsou.
   *
   * Nutné, když se předává jen výřez feedu (třeba jen novinky) — bez toho by
   * úklid smazal všechno ostatní jako „zmizelo z feedu".
   */
  keepMissing?: boolean;
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

/**
 * Načte z feedu **jen produkty, které aplikace ještě nezná**.
 *
 * Rozdíl proti běžnému stažení je v tom, čeho se to nedotkne: stávající
 * produkty zůstanou přesně tak, jak jsou, včetně rozpracovaných překladů a
 * stavů. Používá se, když do e-shopu přibylo pár novinek a nemá smysl kvůli
 * nim přepočítávat tisíc produktů, u kterých se nic nezměnilo.
 */
export function ingestNewOnly(xml: string): SyncResult {
  const d = getDb();
  const known = new Set(
    (d.prepare('SELECT code FROM ptrans_products').all() as { code: string }[]).map(row => row.code)
  );
  const fresh = splitProducts(xml).filter(item => !known.has(item.code));
  if (fresh.length === 0) {
    return { products: 0, fields: 0, removed: 0, paired: 0, at: new Date().toISOString() };
  }
  // Znovu poskládaný feed jen z novinek projde stejnou cestou jako celý
  const xmlOfNew = `<PRODUCTS>${fresh.map(item => `<PRODUCT>${item.block}</PRODUCT>`).join('')}</PRODUCTS>`;
  return ingest(xmlOfNew, { origin: 'feed', keepMissing: true });
}

/**
 * Vrátí vybrané produkty do stavu, v jakém jsou právě teď ve feedu.
 *
 * Zahodí to, co aplikace u produktu vymyslela a co ještě není v e-shopu —
 * překlady, vygenerované texty i ruční úpravy. Po tom, co se export
 * naimportuje do Upgates a feed se znovu stáhne, je tohle způsob, jak srovnat
 * aplikaci s realitou: co je ve feedu, je pravda.
 *
 * Ručně upravená pole se dají uchovat (`keepManual`) — bývá to práce, kterou
 * nikdo nechce dělat dvakrát.
 */
export function revertToFeed(codes: string[], options: { keepManual?: boolean } = {}): number {
  if (codes.length === 0) return 0;
  const d = getDb();
  const marks = codes.map(() => '?').join(',');
  const guard = options.keepManual ? ' AND manual = 0' : '';
  const changes = d.prepare(
    `UPDATE ptrans_fields SET translated = NULL, translated_at = NULL, translated_hash = NULL,
       model = '', manual = CASE WHEN ? THEN manual ELSE 0 END
     WHERE code IN (${marks})${guard}`
  ).run(options.keepManual ? 1 : 0, ...codes).changes;

  // Stavy se musí přepočítat, jinak by pole zůstalo označené jako hotové
  recomputeStates(codes);
  return changes;
}

/**
 * Přepočet po změně pravidel.
 *
 * Stavy polí leží v databázi hotové, aby se seznam nemusel počítat při každém
 * otevření. Když se ale změní způsob, jakým se stav určuje, zůstala by tam
 * stará čísla — a oprava by se navenek vůbec neprojevila. Značka verze říká,
 * podle jakých pravidel se počítalo naposledy; nesouhlasí-li, přepočítá se
 * jednou všechno.
 *
 * Verze se zvedá při každé změně `fieldState` — a taky když přibude něco,
 * co se při přepočtu ukládá vedle stavu (příznak nepořádku v HTML).
 */
const STATE_RULES_VERSION = '6';

export function refreshStatesIfNeeded(): number {
  if (getSetting('ptransStateRules', '') === STATE_RULES_VERSION) return 0;
  repairSourceValues();
  const changed = recomputeStates();
  setSetting('ptransStateRules', STATE_RULES_VERSION);
  return changed;
}

/**
 * Náprava polí, která uvízla mezi dvěma stavy.
 *
 * Když aplikace doplnila český text a pak se znovu načetl feed, `source_value`
 * u cílových jazyků se přepsalo prázdnem z feedu — text v e-shopu totiž pořád
 * není, dokud se neimportuje export. Pole se tím dostalo do slepé uličky:
 * přeložit nejde (chybí zdroj) a doplnit se nemá (uložený text už existuje).
 *
 * Nové načtení feedu tohle řeší samo, ale databáze, které v tom stavu už jsou,
 * by se nespravily do dalšího stažení. Proto jednorázový úklid.
 */
export function repairSourceValues(): number {
  const d = getDb();
  const lang = getPtransSettings().sourceLang;
  const own = `SELECT s.translated FROM ptrans_fields s
    WHERE s.code = ptrans_fields.code AND s.field = ptrans_fields.field
      AND s.lang = ? AND trim(coalesce(s.translated, '')) != ''`;
  return d.prepare(
    `UPDATE ptrans_fields SET source_value = (${own})
     WHERE lang != ? AND trim(source_value) = '' AND EXISTS (${own})`
  ).run(lang, lang, lang).changes as number;
}

/**
 * Je v textu balast po kopírování z cizí stránky?
 *
 * Kouká se na obě strany — na originál i na text v cílovém jazyce. Balast
 * v češtině je ten původní; jazykové mutace ho zdědily a v e-shopu rozbíjejí
 * stránku úplně stejně, takže se hlásí i tam, kde překlad ještě neproběhl.
 */
function messyFlag(row: { translated?: string | null; value: string; source_value: string }): boolean {
  return needsTidy(row.source_value) || needsTidy(row.translated || row.value);
}

/** Přepočítá stav polí podle toho, co je ve feedu a co máme uložené. */
export function recomputeStates(codes?: string[]): number {
  const d = getDb();
  const s = getPtransSettings();
  const where = codes?.length ? ` WHERE code IN (${codes.map(() => '?').join(',')})` : '';
  const rows = d.prepare(
    `SELECT code, lang, field, value, source_value, translated, translated_hash, manual
     FROM ptrans_fields${where}`
  ).all(...(codes ?? [])) as any[];

  const update = d.prepare(
    'UPDATE ptrans_fields SET state = ?, messy = ? WHERE code = ? AND lang = ? AND field = ?');
  const run = d.transaction(() => {
    for (const row of rows) {
      const ours = !!row.translated && plain(row.translated) === plain(row.value);
      const state = fieldState({
        value: row.value,
        source: row.source_value,
        field: row.field,
        sourceLang: s.sourceLang,
        targetLang: row.lang,
        translatedHash: ours ? row.translated_hash : null,
        sourceHash: hashText(row.source_value),
        manual: row.manual === 1
      });
      /*
       * Při té příležitosti i příznak nepořádku v HTML.
       *
       * Počítá se tady, a ne při každém dotazu: projít popisy tisíce produktů
       * trvá skoro vteřinu, což by se při každém překliknutí stránky poznalo.
       * Kouká se na obě strany — na text v cílovém jazyce i na zdrojový.
       * Balast v češtině je totiž ten původní; překlad ho jen zdědí, a hledá
       * se hlavně proto, aby se dal opravit u zdroje.
       */
      const messy = messyFlag(row);
      update.run(state, messy ? 1 : 0, row.code, row.lang, row.field);
    }
  });
  run();
  return rows.length;
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
    INSERT INTO ptrans_fields (code, lang, field, value, source_value, state, messy)
    VALUES (@code, @lang, @field, @value, @source_value, @state, @messy)
    ON CONFLICT(code, lang, field) DO UPDATE SET
      value = excluded.value, source_value = excluded.source_value, state = excluded.state,
      messy = excluded.messy
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

      /*
       * Zdrojový text: co je ve feedu, a když tam nic není, co jsme si napsali sami.
       *
       * Tohle je jádro jedné tiché pasti. Aplikace umí doplnit chybějící český
       * SEO titulek nebo texty pro Google — uloží je k sobě a rozešle je jako
       * zdroj k cílovým jazykům. Jenže v e-shopu pořád nejsou, dokud se
       * neimportuje export. Při dalším načtení feedu se `source_value`
       * přepsalo tím, co je ve feedu, tedy prázdnem — a překlad najednou
       * neměl z čeho vycházet. Zároveň zůstal uložený český text, takže
       * doplnění hlásilo „kompletní" a nic nedoplnilo. Pole tak uvízlo mezi
       * dvěma stavy: přeložit nejde (chybí zdroj) a doplnit se nemá (už to
       * prý je). Přesně tohle se stalo u REGJ01 a REGJ02.
       *
       * Feed má přednost — když v něm hodnota je, platí ta. Naše se použije
       * jen tam, kde by jinak bylo prázdno.
       */
      const sourceOf = (field: string) => {
        const fromFeed = getField(block, s.sourceLang, field) ?? '';
        if (fromFeed.trim()) return fromFeed;
        const own = readField.get(code, s.sourceLang, field) as
          { translated: string | null } | undefined;
        return own?.translated?.trim() ? own.translated : fromFeed;
      };
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
          const source = sourceOf(field);
          const saved = readField.get(code, lang, field) as
            { translated: string | null; translated_hash: string | null; manual: number } | undefined;

          // Když je v feedu pořád to, co jsme přeložili, bere se jako náš překlad
          const ours = !!saved?.translated && plain(saved.translated) === plain(value);
          const state: FieldState = fieldState({
            value,
            source,
            field,
            sourceLang: s.sourceLang,
            targetLang: lang,
            translatedHash: ours ? saved?.translated_hash : null,
            sourceHash: hashText(source),
            manual: saved?.manual === 1
          });

          upsertField.run({
            code, lang, field, value, source_value: source, state,
            // Balast v HTML se pozná rovnou při čtení feedu, ať se dá podle
            // toho filtrovat bez procházení popisů při každém dotazu
            messy: messyFlag({ translated: saved?.translated, value, source_value: source }) ? 1 : 0
          });
          fields++;
        }
      }
    }
  });
  run();

  // Ručně nahrané produkty úklid přeskakuje — ve feedu ještě nejsou a smazat
  // je by znamenalo zahodit i jejich překlady
  const removed = origin === 'feed' && !options.keepMissing
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
  /** Odkud produkt je: z online feedu, nebo z ručně nahraného souboru */
  origin: 'feed' | 'file';
  /** Odkaz do e-shopu, ať jde produkt otevřít a podívat se, jak vypadá */
  url: string;
  /** Stav po jazycích: kolik polí je hotových a kolik čeká */
  states: Record<string, { total: number; todo: number; worst: FieldState }>;
  /**
   * Jazyky, kde je hotové úplně všechno, co se překládat má.
   *
   * V seznamu je tohle jediné, co se opravdu hodí vědět. „5 z 9 polí" svádí
   * k tomu počítat procenta, ale produkt s pěti přeloženými poli se na e-shopu
   * chová stejně jako ten bez jediného — pořád je rozbitý.
   */
  doneLangs: string[];
  /** Jazyky, kde ještě něco chybí */
  todoLangs: string[];
}

const STATE_ORDER: FieldState[] = ['missing', 'same', 'source', 'stale', 'manual', 'ok'];

export interface ProductQueryInput {
  search?: string;
  category?: string;
  manufacturer?: string;
  /** Jen produkty, které mají v tomhle jazyce co dělat */
  lang?: string;
  /**
   * `todo` = cokoli, co ještě čeká na práci, `messy` = produkty, kterým se do
   * popisu dostal balast z cizí stránky (viz `html.ts`) — ten se nepozná podle
   * stavu pole, protože s překladem nesouvisí.
   */
  state?: FieldState | 'todo' | 'messy' | 'all';
  field?: string;
  onlyActive?: boolean;
  /**
   * Odkud produkty brát. `file` je režim „pracuju jen s tím, co jsem nahrál" —
   * novinky, které v online feedu ještě nejsou, se v hromadě tisíce produktů
   * jinak nedají najít.
   */
  origin?: 'all' | 'feed' | 'file';
  /**
   * Jen tyhle kódy. Používá se, když si rozhraní dotahuje čerstvý stav
   * produktů, které z filtru zrovna vypadly, ale mají ještě chvíli zůstat
   * v seznamu vidět.
   */
  codes?: string[];
  limit?: number;
  offset?: number;
  sort?: 'title' | 'todo' | 'code';
}

/**
 * Podmínka výběru produktů podle filtru — společná pro seznam i pro „vybrat vše".
 *
 * Skládá se na jednom místě schválně: kdyby se filtr psal dvakrát, „vybrat vše"
 * by dřív nebo později vybralo něco jiného, než co je vidět v seznamu.
 */
function filterClause(query: ProductQueryInput, langs: string[]): { clause: string; params: any[] } {
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
  if (query.origin && query.origin !== 'all') { where.push('p.origin = ?'); params.push(query.origin); }
  if (query.codes?.length) {
    where.push(`p.code IN (${query.codes.map(() => '?').join(',')})`);
    params.push(...query.codes);
  }

  const fieldFilter = query.field ? ' AND f.field = ?' : '';
  const langList = langs.map(() => '?').join(',');

  // Nepořádek v HTML není stav pole — je to vlastnost textu a hlídá se
  // příznakem, který se počítá při přepočtu stavů
  if (query.state === 'messy') {
    where.push(`EXISTS (SELECT 1 FROM ptrans_fields f WHERE f.code = p.code AND f.messy = 1${fieldFilter})`);
    if (query.field) params.push(query.field);
    return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
  }

  const wanted = query.state && query.state !== 'all'
    ? (query.state === 'todo' ? NEEDS_WORK : [query.state])
    : null;

  // Produkty, které vyhovují filtru stavu (aspoň jedno pole v daném stavu)
  if (wanted) {
    where.push(`EXISTS (SELECT 1 FROM ptrans_fields f WHERE f.code = p.code AND f.lang IN (${langList})
      AND f.state IN (${wanted.map(() => '?').join(',')})${fieldFilter})`);
    params.push(...langs, ...wanted);
    if (query.field) params.push(query.field);
  }

  return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

export function listProducts(query: ProductQueryInput): { rows: ProductRow[]; total: number; todo: number } {
  const d = getDb();
  const s = getPtransSettings();
  const langs = query.lang && query.lang !== 'all' ? [query.lang] : targetLangs(s);
  const langList = langs.map(() => '?').join(',');
  const { clause, params } = filterClause(query, langs);

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
    // Hotovo = v daném jazyce nezbývá ani jedno pole. Jazyk, o kterém databáze
    // ještě nic neví (nesledovaná pole), se nepočítá jako hotový — jen o něm
    // zatím nic nevíme, což není totéž.
    const doneLangs = langs.filter(lang => states[lang] && states[lang].todo === 0);
    const todoLangs = langs.filter(lang => !states[lang] || states[lang].todo > 0);

    return {
      code: row.code,
      title: row.title,
      image: row.image,
      // Odkaz do trhu, který je zrovna vyfiltrovaný — u „všech jazyků" ten zdrojový
      url: productUrl(row.raw_xml ?? '', langs.length === 1 ? langs[0] : s.sourceLang, s.sourceLang),
      category: row.category,
      manufacturer: row.manufacturer,
      availability: row.availability,
      price: row.price,
      active: row.active === 1,
      origin: row.origin === 'file' ? 'file' : 'feed',
      states,
      doneLangs,
      todoLangs
    };
  });

  const todo = (d.prepare(
    `SELECT COUNT(DISTINCT code) AS n FROM ptrans_fields
     WHERE lang IN (${langList}) AND state IN (${NEEDS_WORK.map(() => '?').join(',')})`
  ).get(...langs, ...NEEDS_WORK) as any).n as number;

  return { rows: out, total, todo };
}

/**
 * Kódy všech produktů, které vyhovují filtru — bez ohledu na stránkování.
 *
 * „Vybrat vše na stránce" je málo, když má filtr osm set produktů a stránka
 * šedesát: hromadná akce se pak musí spouštět čtrnáctkrát. Vrací se jen kódy,
 * takže je to i pro celý feed pár desítek kilobajtů.
 */
export function listCodes(query: ProductQueryInput): string[] {
  const s = getPtransSettings();
  const langs = query.lang && query.lang !== 'all' ? [query.lang] : targetLangs(s);
  const { clause, params } = filterClause(query, langs);
  const order = query.sort === 'code' ? 'p.code' : 'p.title';
  return (getDb().prepare(
    `SELECT p.code FROM ptrans_products p ${clause} ORDER BY ${order} LIMIT ?`
  ).all(...params, MAX_CODES) as any[]).map(row => row.code as string);
}

/** Strop, aby se omylem nevybral celý feed do jedné zprávy. */
const MAX_CODES = 5000;

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
/**
 * Hodnota pole tak, jak je právě teď — bez ohledu na to, jestli se sleduje.
 *
 * `ptrans_fields` obsahuje jen jazyky, do kterých se překládá, a jen pole
 * zapnutá v nastavení. Zdrojový jazyk tam řádky nemá vůbec, takže „vezmi
 * název a popis produktu" by v češtině vrátilo prázdno. Fallback do
 * původního XML je tím pádem nutný všude, kde se s produktem pracuje jako
 * s celkem — při psaní SEO textů, u Google atributů i v auditu.
 */
export function fieldValue(code: string, lang: string, field: string): string {
  const d = getDb();
  const row = d.prepare(
    'SELECT translated, value FROM ptrans_fields WHERE code = ? AND lang = ? AND field = ?'
  ).get(code, lang, field) as { translated: string | null; value: string } | undefined;
  const known = (row?.translated || row?.value || '').trim();
  if (known) return known;

  const product = d.prepare('SELECT raw_xml FROM ptrans_products WHERE code = ?')
    .get(code) as { raw_xml: string } | undefined;
  if (!product) return '';
  return (getField(product.raw_xml, lang, field) ?? '').trim();
}

/**
 * Zapíše zdrojový text i k cílovým jazykům.
 *
 * Když se doplní český SEO titulek, musí se to promítnout do `source_value`
 * u všech jazyků — jinak by překlad pořád vycházel z prázdna a stav pole by
 * zůstal viset na „chybí zdroj". Volá se hned po doplnění zdrojového textu.
 */
export function propagateSource(code: string, field: string, source: string): void {
  const d = getDb();
  const s = getPtransSettings();
  const langs = targetLangs(s);
  if (langs.length === 0) return;

  const upsert = d.prepare(`
    INSERT INTO ptrans_fields (code, lang, field, value, source_value, state)
    VALUES (@code, @lang, @field, @value, @source, @state)
    ON CONFLICT(code, lang, field) DO UPDATE SET source_value = excluded.source_value
  `);
  const read = d.prepare(
    'SELECT value, translated, translated_hash, manual FROM ptrans_fields WHERE code = ? AND lang = ? AND field = ?'
  );

  for (const lang of langs) {
    const row = read.get(code, lang, field) as any;
    upsert.run({ code, lang, field, value: row?.value ?? '', source, state: 'missing' });
  }
  recomputeStates([code]);
}

export function saveTranslation(code: string, lang: string, field: string, value: string,
                                model: string, manual = false): void {
  const d = getDb();
  const row = d.prepare('SELECT source_value FROM ptrans_fields WHERE code = ? AND lang = ? AND field = ?')
    .get(code, lang, field) as { source_value: string } | undefined;
  const source = row?.source_value ?? '';
  d.prepare(`
    INSERT INTO ptrans_fields (code, lang, field, value, source_value, state, translated, translated_at,
      translated_hash, model, manual, messy)
    VALUES (@code, @lang, @field, @value, @source, @state, @value, @at, @hash, @model, @manual, @messy)
    ON CONFLICT(code, lang, field) DO UPDATE SET
      value = excluded.value, state = excluded.state, translated = excluded.translated,
      translated_at = excluded.translated_at, translated_hash = excluded.translated_hash,
      model = excluded.model, manual = excluded.manual, messy = excluded.messy
  `).run({
    code, lang, field, value, source,
    state: manual ? 'manual' : 'ok',
    at: new Date().toISOString(),
    hash: hashText(source),
    model,
    manual: manual ? 1 : 0,
    // Po úklidu musí příznak zhasnout hned, ne až po dalším přepočtu stavů —
    // jinak by uklizený produkt zůstal ve filtru „nepořádek v HTML" viset
    messy: messyFlag({ translated: value, value, source_value: source }) ? 1 : 0
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
