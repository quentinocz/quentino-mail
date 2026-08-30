import { getDb, getSetting, setSetting } from './db';
import { ProductHit, FeedStatus, MailLang, ProductQuery, ProductPage, ProductFacets,
  ProductVariant, ProductDetail, ScanHit, CatalogSuggestion } from '../shared/types';
import { syncFeedXml } from './ptrans';

/**
 * Adresa produktového feedu se v kódu nedrží.
 *
 * Export z Upgates je „tajný odkazem" — kdo ho zná, stáhne celý katalog
 * s cenami a sklady. V repozitáři (a od chvíle, kdy je veřejný, i mimo firmu)
 * nemá co dělat, takže se vyplňuje v Nastavení a leží jen v lokální databázi.
 */
export const DEFAULT_FEED_URL = '';

const LANGS: MailLang[] = ['cz', 'sk', 'en'];
const CURRENCY_SYMBOL: Record<string, string> = { CZK: 'Kč', EUR: '€', USD: '$', GBP: '£', PLN: 'zł' };

function tag(block: string, name: string): string | null {
  const m = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? m[1].trim() : null;
}

/**
 * Vytáhne značku, která může (ale nemusí) mít jazykový atribut — Upgates některé
 * texty exportuje jako `<NAME language="cz">`, jiné jako holé `<NAME>`.
 */
function tagAny(block: string, name: string, preferLang = 'cz'): string | null {
  const withLang = block.match(new RegExp(`<${name} language="${preferLang}"[^>]*>([\\s\\S]*?)</${name}>`));
  if (withLang) return withLang[1].trim();
  const plain = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return plain ? plain[1].trim() : null;
}

function clean(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .trim();
}

/** Z „1 299,00" nebo „649.00" udělá číslo pro řazení podle ceny. */
function toNumber(raw: string | null): number | null {
  if (!raw) return null;
  const n = Number(raw.replace(/\s|&nbsp;/g, '').replace(',', '.').replace(/[^\d.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** Kategorie produktu — hlavní (PRIMARY_YN=1) a seznam všech. */
function parseCategories(block: string): { primary: string; all: string[] } {
  const wrap = block.match(/<CATEGORIES>([\s\S]*?)<\/CATEGORIES>/);
  if (!wrap) return { primary: '', all: [] };
  const all: string[] = [];
  let primary = '';
  for (const cb of wrap[1].split('<CATEGORY>').slice(1)) {
    const raw = tagAny(cb.split('</CATEGORY>')[0], 'NAME');
    if (!raw) continue;
    const name = clean(raw);
    if (!name) continue;
    if (!all.includes(name)) all.push(name);
    if (!primary && tag(cb, 'PRIMARY_YN') === '1') primary = name;
  }
  return { primary: primary || all[0] || '', all };
}

/** Naparsuje Upgates XML feed a nahradí lokální katalog produktů. */
/**
 * Varianty produktu z bloku feedu.
 *
 * Varianta má vlastní kód, vlastní zásobu a vlastní cenu — a hlavně vlastní
 * název složený z parametrů („Délka: 120cm"). Bez toho se v katalogu nedá
 * odpovědět na jedinou otázku, na kterou se u telefonu odpovídá pořád:
 * „a máte to ve sto dvaceti?"
 */
function parseVariants(block: string, productCode: string): any[] {
  const wrap = block.match(/<VARIANTS>([\s\S]*?)<\/VARIANTS>/);
  if (!wrap) return [];
  const out: any[] = [];
  let sort = 0;
  for (const part of wrap[1].split('<VARIANT>').slice(1)) {
    const vb = part.split('</VARIANT>')[0];
    const code = tag(vb, 'CODE');
    if (!code) continue;
    if ((tag(vb, 'ACTIVE_YN') ?? '1') !== '1') continue;

    // Popisek: „Délka: 120cm" — z parametrů, které variantu odlišují
    const label: string[] = [];
    const params = vb.match(/<PARAMETERS>([\s\S]*?)<\/PARAMETERS>/);
    if (params) {
      for (const pb of params[1].split('<PARAMETER>').slice(1)) {
        const one = pb.split('</PARAMETER>')[0];
        const name = clean(tagAny(one, 'NAME') ?? '');
        const value = clean(tagAny(one, 'VALUE') ?? '');
        if (value) label.push(name ? `${name}: ${value}` : value);
      }
    }

    const priceBlock = /<PRICE language="cz">([\s\S]*?)<\/PRICE>/.exec(vb)?.[1] ?? '';
    const value = tag(priceBlock, 'PRICE_SALE') || tag(priceBlock, 'PRICE_WITH_VAT');
    const cur = tag(priceBlock, 'CURRENCY') ?? '';
    const stock = toNumber(tag(vb, 'STOCK'));

    out.push({
      code,
      product_code: productCode,
      variant_id: tag(vb, 'VARIANT_ID') ?? '',
      label: label.join(' · '),
      ean: clean(tag(vb, 'EAN') ?? ''),
      availability: clean(tag(vb, 'AVAILABILITY') ?? ''),
      stock: stock === null ? null : Math.round(stock),
      price: value ? `${value} ${CURRENCY_SYMBOL[cur] ?? cur}`.trim() : '',
      main: tag(vb, 'MAIN_YN') === '1' ? 1 : 0,
      sort: sort++
    });
  }
  return out;
}

export function importFeedXml(xml: string): number {
  const rows: any[] = [];
  const variants: any[] = [];
  const blocks = xml.split('<PRODUCT>');
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i].split('</PRODUCT>')[0];
    if ((tag(block, 'ACTIVE_YN') ?? '1') !== '1') continue;
    if ((tag(block, 'ARCHIVED_YN') ?? '0') === '1') continue;
    const code = tag(block, 'CODE');
    if (!code) continue;

    const row: Record<string, string | number | null> = {
      code, image: null, ean: clean(tag(block, 'EAN') ?? ''),
      product_id: tag(block, 'PRODUCT_ID') ?? '',
      title_cz: '', url_cz: '', price_cz: '',
      title_sk: '', url_sk: '', price_sk: '',
      title_en: '', url_en: '', price_en: '',
      category: '', categories: '', manufacturer: '', availability: '',
      stock: null, price_num: null
    };

    // Názvy a URL dle jazyka
    const descRe = /<DESCRIPTION language="(cz|sk|en)">([\s\S]*?)<\/DESCRIPTION>/g;
    let m: RegExpExecArray | null;
    while ((m = descRe.exec(block))) {
      const lang = m[1];
      row[`title_${lang}`] = clean(tag(m[2], 'TITLE') ?? '');
      row[`url_${lang}`] = tag(m[2], 'URL') ?? '';
    }

    // Hlavní obrázek (MAIN_YN=1, jinak první)
    const imgs = block.match(/<IMAGES>([\s\S]*?)<\/IMAGES>/);
    if (imgs) {
      let first: string | null = null;
      let main: string | null = null;
      for (const ib of imgs[1].split('<IMAGE>').slice(1)) {
        const u = tag(ib, 'URL');
        if (!u) continue;
        if (!first) first = u;
        if (!main && tag(ib, 'MAIN_YN') === '1') main = u;
      }
      row.image = main ?? first;
    }

    // Ceny dle jazyka (s DPH + měna)
    const priceRe = /<PRICE language="(cz|sk|en)">([\s\S]*?)<\/PRICE>/g;
    while ((m = priceRe.exec(block))) {
      const lang = m[1];
      const sale = tag(m[2], 'PRICE_SALE');
      const withVat = tag(m[2], 'PRICE_WITH_VAT');
      const value = sale || withVat;
      const cur = tag(m[2], 'CURRENCY') ?? '';
      if (value) {
        row[`price_${lang}`] = `${value} ${CURRENCY_SYMBOL[cur] ?? cur}`.trim();
        if (lang === 'cz') row.price_num = toNumber(value);
      }
    }

    // Kategorie, výrobce, dostupnost — pro filtrování v prohlížeči produktů
    const cats = parseCategories(block);
    row.category = cats.primary;
    row.categories = cats.all.join('\n');
    row.manufacturer = clean(tagAny(block, 'MANUFACTURER') ?? '');
    row.availability = clean(tagAny(block, 'AVAILABILITY') ?? '');
    const stock = toNumber(tag(block, 'STOCK'));
    row.stock = stock === null ? null : Math.round(stock);

    if (row.title_cz || row.title_en || row.title_sk) {
      rows.push(row);
      variants.push(...parseVariants(block, code));
    }
  }

  if (rows.length === 0) throw new Error('Feed neobsahuje žádné aktivní produkty — zkontroluj URL.');

  const d = getDb();
  const replaceAll = d.transaction(() => {
    d.prepare('DELETE FROM products').run();
    const ins = d.prepare(
      `INSERT OR REPLACE INTO products (code, title_cz, url_cz, price_cz, title_sk, url_sk, price_sk, title_en, url_en, price_en, image,
                                        category, categories, manufacturer, availability, stock, price_num, ean, product_id)
       VALUES (@code, @title_cz, @url_cz, @price_cz, @title_sk, @url_sk, @price_sk, @title_en, @url_en, @price_en, @image,
               @category, @categories, @manufacturer, @availability, @stock, @price_num, @ean, @product_id)`
    );
    for (const r of rows) ins.run(r);

    d.prepare('DELETE FROM product_variants').run();
    const insVariant = d.prepare(
      `INSERT OR REPLACE INTO product_variants
         (code, product_code, variant_id, label, ean, availability, stock, price, main, sort)
       VALUES (@code, @product_code, @variant_id, @label, @ean, @availability, @stock, @price, @main, @sort)`
    );
    for (const v of variants) insVariant.run(v);
  });
  replaceAll();
  setSetting('productFeedSync', new Date().toISOString());
  setSetting('productFeedSchema', '2');
  return rows.length;
}

export async function refreshFeed(): Promise<FeedStatus> {
  const url = getSetting('productFeedUrl', DEFAULT_FEED_URL)!;
  if (!url.trim()) {
    throw new Error('Není vyplněná adresa produktového feedu (Nastavení → Produkty).');
  }
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Feed se nepodařilo stáhnout (HTTP ${res.status})`);
  const xml = await res.text();
  importFeedXml(xml);
  // Ze stejného stažení se plní i podrobná databáze pro překlady. Kdyby se
  // rozbor pokazil, katalog pro našeptávání tím trpět nemá.
  try {
    syncFeedXml(xml);
  } catch (e) {
    console.error('Překladová databáze se nenaplnila:', e);
  }
  return feedStatus();
}

/* ---------- rychlý feed: jen zásoby a ceny ---------- */

/**
 * Zásoba se nedá číst z velkého feedu.
 *
 * Celý katalog s popisy a obrázky má přes dvacet megabajtů a obnovuje se
 * jednou za den — číslo „skladem 4 ks" z něj je tedy klidně půl dne staré.
 * Upgates umí vedle toho malý export jen s kódy, dostupností, cenami a
 * variantami; ten se obnovuje po dvou hodinách. Katalog proto stojí na obou:
 * jak produkt vypadá, ví z velkého, kolik ho je, z malého.
 */
export async function refreshStock(): Promise<{ products: number; variants: number; at: string }> {
  const url = (getSetting('stockFeedUrl', '') ?? '').trim();
  if (!url) throw new Error('Není vyplněná adresa rychlého skladového feedu (Nastavení → Produkty).');

  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Skladový feed: HTTP ${res.status}`);
  const xml = await res.text();
  return applyStockXml(xml);
}

/** Zapíše zásoby z malého feedu. Oddělené kvůli zkoušce bez sítě. */
export function applyStockXml(xml: string): { products: number; variants: number; at: string } {
  const at = new Date().toISOString();
  const d = getDb();

  const upProduct = d.prepare(
    `UPDATE products SET stock = @stock, availability = @availability, stock_at = @at WHERE code = @code`
  );
  const upVariant = d.prepare(
    `UPDATE product_variants SET stock = @stock, availability = @availability WHERE code = @code`
  );

  let products = 0;
  let variants = 0;
  const run = d.transaction(() => {
    for (const raw of xml.split('<PRODUCT>').slice(1)) {
      const block = raw.split('</PRODUCT>')[0];
      const code = tag(block, 'CODE');
      if (!code) continue;

      // Varianty se musí odečíst dřív, než se z bloku vyzobne zásoba produktu:
      // uvnitř VARIANTS je taky STOCK a bez oddělení by se první z nich
      // připsal celému produktu
      const wrap = block.match(/<VARIANTS>([\s\S]*?)<\/VARIANTS>/);
      const head = wrap ? block.slice(0, block.indexOf('<VARIANTS>')) : block;
      if (wrap) {
        for (const part of wrap[1].split('<VARIANT>').slice(1)) {
          const vb = part.split('</VARIANT>')[0];
          const vcode = tag(vb, 'CODE');
          if (!vcode) continue;
          const stock = toNumber(tag(vb, 'STOCK'));
          variants += upVariant.run({
            code: vcode,
            stock: stock === null ? null : Math.round(stock),
            availability: clean(tag(vb, 'AVAILABILITY') ?? '')
          }).changes;
        }
      }

      const stock = toNumber(tag(head, 'STOCK'));
      products += upProduct.run({
        code,
        stock: stock === null ? null : Math.round(stock),
        availability: clean(tag(head, 'AVAILABILITY') ?? ''),
        at
      }).changes;
    }
  });
  run();

  setSetting('stockFeedSync', at);
  return { products, variants, at };
}

/** Kdy naposledy dorazila čerstvá zásoba — do hlavičky katalogu. */
export function stockSyncedAt(): string | null {
  return getSetting('stockFeedSync', '') || null;
}

export function feedStatus(): FeedStatus {
  const d = getDb();
  const row = d.prepare('SELECT COUNT(*) AS cnt FROM products').get() as { cnt: number };
  return {
    url: getSetting('productFeedUrl', DEFAULT_FEED_URL)!,
    count: row.cnt,
    lastSync: getSetting('productFeedSync')
  };
}

/** Feed starší než 20 hodin (nebo prázdný / bez kategorií) → aktualizovat. */
export function feedIsStale(): boolean {
  const st = feedStatus();
  if (st.count === 0) return true;
  if (!st.lastSync) return true;
  // Katalog stažený starší verzí aplikace nemá kategorie ani dostupnost
  if (getSetting('productFeedSchema') !== '2') return true;
  return Date.now() - new Date(st.lastSync).getTime() > 20 * 3600 * 1000;
}

function mapRow(r: any): ProductHit {
  return {
    code: r.code,
    image: r.image,
    title: Object.fromEntries(LANGS.map(l => [l, r[`title_${l}`] ?? ''])) as ProductHit['title'],
    url: Object.fromEntries(LANGS.map(l => [l, r[`url_${l}`] ?? ''])) as ProductHit['url'],
    price: Object.fromEntries(LANGS.map(l => [l, r[`price_${l}`] ?? ''])) as ProductHit['price'],
    category: r.category ?? '',
    categories: r.categories ? String(r.categories).split('\n').filter(Boolean) : [],
    manufacturer: r.manufacturer ?? '',
    availability: r.availability ?? '',
    stock: r.stock ?? null
  };
}

/**
 * Stránkované procházení katalogu — základ prohlížeče produktů v kompozeru.
 * Bez dotazu vrací celý katalog, takže se dá listovat i „naslepo".
 */
export function listProducts(q: ProductQuery = {}): ProductPage {
  const limit = Math.min(Math.max(q.limit ?? 40, 1), 200);
  const offset = Math.max(q.offset ?? 0, 0);
  const lang: MailLang = q.lang ?? 'cz';

  const where: string[] = [];
  const params: any[] = [];

  const text = (q.query ?? '').trim();
  if (text) {
    // Každé slovo musí sedět (AND) — hledání „modra kravata" tak funguje podle očekávání
    for (const word of text.split(/\s+/).slice(0, 6)) {
      const like = `%${word}%`;
      where.push('(title_cz LIKE ? OR title_sk LIKE ? OR title_en LIKE ? OR code LIKE ? OR category LIKE ? OR categories LIKE ? OR url_cz LIKE ? OR url_sk LIKE ? OR url_en LIKE ?)');
      params.push(like, like, like, like, like, like, like, like, like);
    }
  }
  if (q.category) {
    where.push('(category = ? OR categories LIKE ?)');
    params.push(q.category, `%${q.category}%`);
  }
  if (q.inStockOnly) where.push('(stock IS NULL OR stock > 0)');

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const orderSql =
    q.sort === 'price' ? 'ORDER BY price_num IS NULL, price_num ASC, title_cz COLLATE NOCASE'
      : q.sort === 'stock' ? 'ORDER BY stock IS NULL, stock DESC, title_cz COLLATE NOCASE'
        : `ORDER BY (CASE WHEN title_${lang} = '' THEN 1 ELSE 0 END), title_${lang} COLLATE NOCASE`;

  const d = getDb();
  const total = (d.prepare(`SELECT COUNT(*) AS cnt FROM products ${whereSql}`).get(...params) as { cnt: number }).cnt;
  const rows = d.prepare(`SELECT * FROM products ${whereSql} ${orderSql} LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as any[];

  return { items: rows.map(mapRow), total, offset, limit };
}

/** Seznam kategorií s počty — levý filtr v prohlížeči produktů. */
export function productFacets(): ProductFacets {
  const d = getDb();
  const rows = d.prepare("SELECT categories, category FROM products").all() as any[];
  const counts = new Map<string, number>();
  for (const r of rows) {
    const names: string[] = r.categories ? String(r.categories).split('\n').filter(Boolean) : (r.category ? [r.category] : []);
    for (const n of new Set(names)) counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  const categories = [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'cs'));
  return { categories, total: rows.length };
}

/** Varianty jednoho produktu — velikost, délka, barva a jejich zásoby. */
export function productVariants(code: string): ProductVariant[] {
  const rows = getDb().prepare(
    'SELECT * FROM product_variants WHERE product_code = ? ORDER BY sort, code'
  ).all(code) as any[];
  return rows.map(r => ({
    code: r.code,
    productCode: r.product_code,
    label: r.label ?? '',
    ean: r.ean ?? '',
    availability: r.availability ?? '',
    stock: r.stock ?? null,
    price: r.price ?? '',
    main: r.main === 1
  }));
}

/** Karta produktu do katalogu: co víme z feedu plus varianty. */
export function productDetail(code: string): ProductDetail | null {
  const row = getDb().prepare('SELECT * FROM products WHERE code = ?').get(code) as any;
  if (!row) return null;
  return {
    ...mapRow(row),
    ean: row.ean ?? '',
    stockAt: row.stock_at || null,
    variants: productVariants(code)
  };
}

/**
 * Najde produkt nebo variantu podle toho, co přišlo ze čtečky.
 *
 * Čtečka pošle jeden řetězec a neřekne, co to je. Může to být EAN, kód
 * produktu, kód varianty — nebo celá adresa z QR kódu, který jsme sami
 * vytiskli. Hledá se proto ve všech čtyřech podobách a **vrací se přesná
 * shoda, nebo nic**: u naskladnění je „asi to bude tenhle" horší než „nenašel
 * jsem to", protože se přičte zásoba cizímu zboží.
 *
 * Dvě pravidla, obě zaplacená skutečnými daty z katalogu:
 *
 *  1. **Kód má přednost před EANem.** V e-shopu je jediný vyplněný EAN a je
 *     v něm omylem kód *jiného* produktu (DMJ03 má v EANu „DKJ03"). Kdyby se
 *     hledalo v obou polích naráz, načtení DKJ03 by naskladnilo DMJ03.
 *  2. **Když se na EAN chytí víc věcí, nevrací se žádná.** Duplicitní EAN
 *     není v e-shopech nic zvláštního a hádat, který z nich to je, se nesmí.
 */
export function findByCode(raw: string): ScanHit | null {
  const text = (raw ?? '').trim();
  if (!text) return null;
  // Z QR kódu vlastní výroby: „quentino:PS120SM" nebo adresa produktu
  const code = text.replace(/^quentino:/i, '').replace(/^.*\/p\//, '').trim();
  if (!code) return null;
  const d = getDb();

  const variantHit = (variant: any): ScanHit => {
    const parent = productDetail(variant.product_code);
    return {
      code: variant.code,
      productCode: variant.product_code,
      title: parent?.title.cz || variant.product_code,
      label: variant.label ?? '',
      image: parent?.image ?? null,
      stock: variant.stock ?? null,
      availability: variant.availability ?? '',
      isVariant: true
    };
  };
  const productHit = (product: any): ScanHit => ({
    code: product.code,
    productCode: product.code,
    title: product.title_cz || product.title_en || product.code,
    label: '',
    image: product.image ?? null,
    stock: product.stock ?? null,
    availability: product.availability ?? '',
    isVariant: false
  });

  // 1) kód varianty — na štítku je právě tenhle
  const byVariantCode = d.prepare(
    'SELECT * FROM product_variants WHERE code = ? COLLATE NOCASE LIMIT 1'
  ).get(code) as any;
  if (byVariantCode) return variantHit(byVariantCode);

  // 2) kód produktu
  const byProductCode = d.prepare(
    'SELECT * FROM products WHERE code = ? COLLATE NOCASE LIMIT 1'
  ).get(code) as any;
  if (byProductCode) return productHit(byProductCode);

  // 3) teprve pak EAN, a jen když je jednoznačný
  const byEan = [
    ...(d.prepare("SELECT * FROM product_variants WHERE ean != '' AND ean = ? LIMIT 2").all(code) as any[])
      .map(one => ({ kind: 'variant' as const, row: one })),
    ...(d.prepare("SELECT * FROM products WHERE ean != '' AND ean = ? LIMIT 2").all(code) as any[])
      .map(one => ({ kind: 'product' as const, row: one }))
  ];
  if (byEan.length !== 1) return null;
  return byEan[0].kind === 'variant' ? variantHit(byEan[0].row) : productHit(byEan[0].row);
}

/**
 * Napovídání do naskladnění — hledá se i podle názvu, ne jen podle kódu.
 *
 * U regálu se stane, že štítek chybí nebo je nečitelný. Psát kód po paměti
 * je pak sázka do loterie, kdežto „kšandy modré" člověk napíše bez váhání.
 * Vrací se produkt i s variantami, protože naskladňuje se konkrétní délka,
 * ne „kšandy" — a rozhraní se pak zeptá, která to je.
 */
export function suggestForStockin(query: string, limit = 8): CatalogSuggestion[] {
  const text = (query ?? '').trim();
  if (text.length < 2) return [];

  /*
   * Hledá se bez ohledu na háčky a čárky.
   *
   * SQL `LIKE` porovnává znak po znaku, takže „ksandy" nenajde „Kšandy" —
   * a u regálu nikdo nepřepíná klávesnici kvůli jednomu slovu. Katalog má
   * dvanáct set řádků, což je na projití v paměti nic, takže se sáhne pro
   * všechny a filtruje se tady.
   */
  const words = fold(text).split(/\s+/).filter(Boolean).slice(0, 5);
  const rows = getDb().prepare(
    'SELECT code, title_cz, title_en, image, stock, price_cz FROM products'
  ).all() as any[];

  const out: CatalogSuggestion[] = [];
  for (const row of rows) {
    const hay = fold(`${row.code} ${row.title_cz ?? ''} ${row.title_en ?? ''}`);
    if (!words.every(word => hay.includes(word))) continue;
    out.push({
      code: row.code,
      title: row.title_cz || row.title_en || row.code,
      image: row.image ?? null,
      stock: row.stock ?? null,
      price: row.price_cz ?? '',
      variants: productVariants(row.code)
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** Malá písmena bez diakritiky — jediná podoba, ve které se dá porovnávat. */
function fold(text: string): string {
  return (text ?? '').normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
}

export function searchProducts(query: string, limit = 20): ProductHit[] {
  if (!query.trim()) return [];
  return listProducts({ query, limit }).items;
}
