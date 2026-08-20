import { getDb, getSetting, setSetting } from './db';
import { ProductHit, FeedStatus, MailLang, ProductQuery, ProductPage, ProductFacets } from '../shared/types';
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
export function importFeedXml(xml: string): number {
  const rows: any[] = [];
  const blocks = xml.split('<PRODUCT>');
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i].split('</PRODUCT>')[0];
    if ((tag(block, 'ACTIVE_YN') ?? '1') !== '1') continue;
    if ((tag(block, 'ARCHIVED_YN') ?? '0') === '1') continue;
    const code = tag(block, 'CODE');
    if (!code) continue;

    const row: Record<string, string | number | null> = {
      code, image: null,
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

    if (row.title_cz || row.title_en || row.title_sk) rows.push(row);
  }

  if (rows.length === 0) throw new Error('Feed neobsahuje žádné aktivní produkty — zkontroluj URL.');

  const d = getDb();
  const replaceAll = d.transaction(() => {
    d.prepare('DELETE FROM products').run();
    const ins = d.prepare(
      `INSERT OR REPLACE INTO products (code, title_cz, url_cz, price_cz, title_sk, url_sk, price_sk, title_en, url_en, price_en, image,
                                        category, categories, manufacturer, availability, stock, price_num)
       VALUES (@code, @title_cz, @url_cz, @price_cz, @title_sk, @url_sk, @price_sk, @title_en, @url_en, @price_en, @image,
               @category, @categories, @manufacturer, @availability, @stock, @price_num)`
    );
    for (const r of rows) ins.run(r);
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

export function searchProducts(query: string, limit = 20): ProductHit[] {
  if (!query.trim()) return [];
  return listProducts({ query, limit }).items;
}
