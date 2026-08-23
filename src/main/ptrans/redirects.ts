import { getDb } from '../db';
import { getPtransSettings, productFields, saveTranslation } from './store';
import { plain } from './detect';

/**
 * Přesměrování starých adres (301).
 *
 * Když se produktu změní SEO adresa, stará přestane existovat — a s ní zmizí
 * i pozice ve vyhledávačích a odkazy, které na produkt vedly. Upgates na to má
 * u produktu pole `redirect_301`: seznam starých cest, každá na svém řádku ve
 * tvaru `/p/nazev-produktu`. Ve feedu ho část produktů už má vyplněný, protože
 * se adresy měnily dřív ručně.
 *
 * Pravidlo je jednoduché: **při každé změně adresy se ta předchozí přidá na
 * seznam.** Nikdy se nic nemaže — historie odkazů je to jediné, co po staré
 * adrese zbylo. Odstraní se jen ta cesta, která je zrovna aktuální, aby
 * produkt nepřesměrovával sám na sebe (to by byla smyčka).
 */

/** Cesta k produktu tak, jak ji zapisuje Upgates. */
export function productPath(slug: string): string {
  const clean = plain(slug).replace(/^\/+|\/+$/g, '').replace(/^p\//, '');
  return clean ? `/p/${clean}` : '';
}

/** Seznam cest z hodnoty pole — po řádcích, bez prázdných a bez duplicit. */
export function parseList(value: string): string[] {
  const out: string[] = [];
  for (const line of (value ?? '').split(/[\r\n]+/)) {
    const path = line.trim();
    if (path && !out.includes(path)) out.push(path);
  }
  return out;
}

/**
 * Doplní starou adresu do přesměrování daného jazyka.
 *
 * Vrací novou hodnotu pole, nebo `null`, když není co měnit (adresa se
 * nezměnila, nebo tam už ta cesta je).
 */
export function withOldPath(current: string, oldSlug: string, newSlug: string): string | null {
  const oldPath = productPath(oldSlug);
  const newPath = productPath(newSlug);
  if (!oldPath || oldPath === newPath) return null;

  const list = parseList(current);
  // Nová adresa na seznamu být nesmí — přesměrovala by sama na sebe
  const without = list.filter(path => path !== newPath);
  if (without.includes(oldPath)) {
    return without.length === list.length ? null : without.join('\n');
  }
  return [...without, oldPath].join('\n');
}

/**
 * Uloží novou SEO adresu a zároveň se postará o přesměrování.
 *
 * Tohle je jediné místo, kudy se adresa mění — ať už ji navrhne překladač,
 * přepis z názvu, nebo ji člověk přepíše ručně.
 */
export function setSeoUrl(code: string, lang: string, slug: string, model: string, manual = false): {
  slug: string;
  redirect: string | null;
} {
  const value = plain(slug).replace(/^\/+|\/+$/g, '').replace(/^p\//, '');
  if (!value) return { slug: '', redirect: null };

  const rows = productFields(code, [lang]);
  const previous = rows.find(row => row.field === 'seo_url');
  const oldSlug = previous?.translated || previous?.value || '';

  saveTranslation(code, lang, 'seo_url', value, model, manual);

  if (getPtransSettings().fields.redirect === false) return { slug: value, redirect: null };

  const redirectRow = rows.find(row => row.field === 'redirect');
  const current = redirectRow?.translated ?? redirectRow?.value ?? feedRedirect(code, lang);
  const next = withOldPath(current, oldSlug, value);
  if (next === null) return { slug: value, redirect: null };

  saveTranslation(code, lang, 'redirect', next, model, manual);
  return { slug: value, redirect: next };
}

/** Hodnota přesměrování přímo z feedu — pro případ, že pole ještě nesledujeme. */
function feedRedirect(code: string, lang: string): string {
  const row = getDb().prepare('SELECT raw_xml FROM ptrans_products WHERE code = ?')
    .get(code) as { raw_xml: string } | undefined;
  if (!row) return '';
  const meta = new RegExp(
    `<META\\b[^>]*>\\s*<META_KEY>redirect_301</META_KEY>[\\s\\S]*?</META>`
  ).exec(row.raw_xml);
  if (!meta) return '';
  const value = new RegExp(`<META_VALUE language="${lang}"[^>]*>([\\s\\S]*?)</META_VALUE>`).exec(meta[0]);
  return value ? value[1].trim() : '';
}

/** Co by se do přesměrování přidalo — pro náhled v rozhraní. */
export function previewRedirect(code: string, lang: string, newSlug: string): {
  oldPath: string;
  list: string[];
} {
  const rows = productFields(code, [lang]);
  const previous = rows.find(row => row.field === 'seo_url');
  const oldSlug = previous?.translated || previous?.value || '';
  const redirectRow = rows.find(row => row.field === 'redirect');
  const current = redirectRow?.translated ?? redirectRow?.value ?? feedRedirect(code, lang);
  const next = withOldPath(current, oldSlug, newSlug);
  return {
    oldPath: productPath(oldSlug),
    list: parseList(next ?? current)
  };
}
