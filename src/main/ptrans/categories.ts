import { getSetting, setSetting } from '../db';

/**
 * Strom kategorií e-shopu.
 *
 * Produktový feed nese u produktu jen **názvy** kategorií — z něj se nedá
 * poznat, co je pod čím, ani co je vůbec kategorie na produkty a co jen
 * stránka v menu. Na to je samostatný export kategorií, který Upgates vydává
 * na vlastní (tajné) adrese.
 *
 * Nový produkt se bez toho zařadit nedá: do XML se kategorie zapisují kódem
 * (`K00026`) a jedna z nich musí být označená jako hlavní.
 */

/** Klíč nastavení s adresou exportu kategorií. Adresa je tajná — v kódu být nesmí. */
export const CATEGORY_FEED_KEY = 'categoryFeedUrl';
const CACHE_KEY = 'ptrans.categories';

export interface ShopCategory {
  /** Kód, kterým se kategorie zapisuje do produktového XML */
  code: string;
  id: string;
  parentId: string;
  active: boolean;
  type: string;
  /** Název po jazycích; klíč je kód jazyka z feedu */
  names: Record<string, string>;
  /**
   * Jestli do kategorie vůbec patří produkty.
   *
   * Menu, kontakty, články a „proč my" jsou v témž exportu jako kategorie
   * zboží. Kdyby se nabízely k zařazení, dalo by se zboží pověsit do stránky
   * „O nás" — a v e-shopu by pak nebylo nikde.
   */
  holdsProducts: boolean;
}

export interface CategoryTree {
  /** Všechny kategorie zploštěle, seřazené podle cesty */
  items: (ShopCategory & { depth: number; path: string })[];
  at: string;
  source: string;
}

/* ---------- čtení XML ---------- */

function tag(block: string, name: string): string {
  const m = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? decode(m[1].trim()) : '';
}

function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

/**
 * Kategorie, do kterých se dá zařadit zboží.
 *
 * Upgates rozlišuje typ stránky — `siteWithProducts` je kategorie se zbožím,
 * `site`, `url`, `contact`, `news`, `linkCategory` a `why-us` jsou stránky.
 * Porovnává se malými písmeny a „obsahuje products", aby to přežilo i typ,
 * který se v exportu objeví až později.
 */
function holdsProducts(type: string): boolean {
  return /product/i.test(type);
}

export function parseCategories(xml: string): ShopCategory[] {
  const out: ShopCategory[] = [];
  for (const piece of xml.split('<CATEGORY>').slice(1)) {
    const block = piece.split('</CATEGORY>')[0];
    const code = tag(block, 'CODE');
    const id = tag(block, 'CATEGORY_ID');
    if (!id) continue;
    const names: Record<string, string> = {};
    const wrap = block.match(/<DESCRIPTIONS>([\s\S]*?)<\/DESCRIPTIONS>/);
    if (wrap) {
      const re = /<DESCRIPTION language="([^"]+)"[^>]*>([\s\S]*?)<\/DESCRIPTION>/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(wrap[1]))) {
        const name = tag(m[2], 'NAME');
        if (name) names[m[1]] = name;
      }
    }
    const type = tag(block, 'TYPE');
    out.push({
      code, id,
      parentId: tag(block, 'PARENT_ID'),
      active: tag(block, 'ACTIVE_YN') !== '0',
      type,
      names,
      holdsProducts: holdsProducts(type)
    });
  }
  return out;
}

/* ---------- strom ---------- */

/**
 * Zploští strom do seznamu v pořadí, v jakém se má vykreslit.
 *
 * Kategorie, jejíž rodič v exportu není, se bere jako kořenová — jinak by
 * z nabídky zmizela úplně a vypadalo by to, že v e-shopu není.
 */
export function flatten(items: ShopCategory[], lang = 'cz'):
  (ShopCategory & { depth: number; path: string })[] {
  const byParent = new Map<string, ShopCategory[]>();
  const ids = new Set(items.map(one => one.id));
  for (const one of items) {
    const parent = one.parentId && ids.has(one.parentId) ? one.parentId : '';
    const list = byParent.get(parent) ?? [];
    list.push(one);
    byParent.set(parent, list);
  }
  const nameOf = (one: ShopCategory) => one.names[lang] || one.names.cz || Object.values(one.names)[0] || one.code;
  const out: (ShopCategory & { depth: number; path: string })[] = [];
  const seen = new Set<string>();
  const walk = (parent: string, depth: number, prefix: string) => {
    const list = (byParent.get(parent) ?? []).slice()
      .sort((a, b) => nameOf(a).localeCompare(nameOf(b), 'cs'));
    for (const one of list) {
      // Pojistka proti kruhu v datech: rodič sám sebou by jinak zacyklil vykreslení
      if (seen.has(one.id)) continue;
      seen.add(one.id);
      const path = prefix ? `${prefix} / ${nameOf(one)}` : nameOf(one);
      out.push({ ...one, depth, path });
      walk(one.id, depth + 1, path);
    }
  };
  walk('', 0, '');
  return out;
}

/* ---------- uložení a stažení ---------- */

export function storedTree(lang = 'cz'): CategoryTree | null {
  try {
    const raw = getSetting(CACHE_KEY, '');
    if (!raw) return null;
    const saved = JSON.parse(raw) as { items: ShopCategory[]; at: string; source: string };
    if (!Array.isArray(saved.items) || saved.items.length === 0) return null;
    return { items: flatten(saved.items, lang), at: saved.at, source: saved.source };
  } catch {
    return null;
  }
}

export async function refreshCategories(lang = 'cz'): Promise<CategoryTree> {
  const url = (getSetting(CATEGORY_FEED_KEY, '') ?? '').trim();
  if (!url) throw new Error('Není vyplněná adresa exportu kategorií (Nastavení → Produkty).');
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Kategorie se nepodařilo stáhnout (HTTP ${res.status})`);
  const items = parseCategories(await res.text());
  if (items.length === 0) throw new Error('V exportu kategorií nebyla ani jedna kategorie — sedí adresa?');
  const at = new Date().toISOString();
  setSetting(CACHE_KEY, JSON.stringify({ items, at, source: url }));
  return { items: flatten(items, lang), at, source: url };
}

/** Strom pro rozhraní; když se nikdy nestahoval, stáhne se teď. */
export async function categoryTree(lang = 'cz'): Promise<CategoryTree> {
  return storedTree(lang) ?? await refreshCategories(lang);
}

/** Kategorie podle kódu — pro sestavení `<CATEGORIES>` v exportu. */
export function categoryByCode(code: string): ShopCategory | null {
  const tree = storedTree();
  return tree?.items.find(one => one.code === code) ?? null;
}

export const __test = { parseCategories, flatten, holdsProducts };
