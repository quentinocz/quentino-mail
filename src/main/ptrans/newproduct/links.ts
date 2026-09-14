import { linkUrls } from '../../articles';
import { extractLinks } from '../../articles/urlmap';
import { fieldValue, saveTranslation } from '../store';

/**
 * Odkazy v přeložených popisech.
 *
 * Model překlad textu zvládne, adresu ne — nechá v něm český odkaz, nebo si
 * doménu vymění po svém. Obojí posílá zákazníka na cizí trh nebo na stránku,
 * která neexistuje. Správnou adresu zná e-shop sám: `linkUrls` ji najde v mapě
 * adres, a co v mapě není, zjistí z přepínače jazyků na živé stránce.
 */

/** Pole, ve kterých mohou být odkazy. Název a SEO texty je nemají. */
const FIELDS = ['short', 'long'];

export interface LinkSwap {
  /** Odkazy, u kterých se adresa na cizím trhu nenašla */
  unresolved: string[];
  changed: number;
}

function replaceHrefs(html: string, pick: (href: string, index: number) => string | null): string {
  let index = 0;
  return html.replace(/(<a\b[^>]*\bhref\s*=\s*["'])([^"']+)(["'])/gi, (all, head, href, tail) => {
    const next = pick(href, index++);
    return next ? `${head}${next}${tail}` : all;
  });
}

/**
 * Dosadí do přeloženého textu adresy pro daný trh.
 *
 * Páruje se **podle pořadí odkazů**, ne podle adresy v přeloženém textu:
 * překlad má stejné značky ve stejném pořadí (to překladač hlídá), kdežto
 * adresa v něm už může být modelem přepsaná — a z přepsané se správná
 * nedohledá. Když se počty odkazů neshodují, páruje se podle adresy.
 */
export async function swapLinks(code: string, lang: string, sourceLang: string): Promise<LinkSwap> {
  const out: LinkSwap = { unresolved: [], changed: 0 };
  const cache = new Map<string, string | null>();

  const resolve = async (href: string): Promise<string | null> => {
    if (cache.has(href)) return cache.get(href)!;
    let found: string | null = null;
    try {
      const all = await linkUrls(href, sourceLang);
      const one = all[lang];
      // `via: 'domain'` znamená „jen jsme vyměnili doménu" — to je odhad,
      // ne zjištěná adresa, a nese riziko odkazu na neexistující stránku
      if (one && one.url && one.via !== 'domain') found = one.url;
    } catch { found = null; }
    cache.set(href, found);
    if (!found) out.unresolved.push(`${href} (${lang.toUpperCase()})`);
    return found;
  };

  for (const field of FIELDS) {
    const translated = fieldValue(code, lang, field);
    const source = fieldValue(code, sourceLang, field);
    if (!translated || !/<a\b/i.test(translated)) continue;

    const sourceLinks = extractLinks(source);
    const targetLinks = extractLinks(translated);
    const byOrder = sourceLinks.length === targetLinks.length && sourceLinks.length > 0;

    const map = new Map<string, string | null>();
    for (const href of byOrder ? sourceLinks : targetLinks) {
      if (!map.has(href)) map.set(href, await resolve(href));
    }

    const next = replaceHrefs(translated, (href, index) => {
      const key = byOrder ? sourceLinks[index] : href;
      const found = map.get(key) ?? null;
      return found && found !== href ? found : null;
    });
    if (next !== translated) {
      saveTranslation(code, lang, field, next, 'odkazy', false);
      out.changed++;
    }
  }
  return out;
}

export const __test = { replaceHrefs };
