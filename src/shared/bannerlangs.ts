import type { BannerSet, Banner } from './types';

/**
 * Co v sadě bannerů chybí přeložit.
 *
 * Sada se ukládá rovnou na web. Banner, který má český nadpis a slovenský
 * prázdný, se na slovenském webu ukáže **česky** (šablona bere zdroj, když
 * překlad chybí) — a nikdo si toho nevšimne, protože aplikace se dívá na
 * češtinu. Proto se to počítá a ukazuje před uložením nahlas.
 *
 * Odkaz se nepočítá: dopočítává se sám z mapy adres a česká adresa na
 * slovenském webu pořád vede na stránku.
 */

export type BannerLang = 'sk' | 'en';
export const BANNER_TARGETS: BannerLang[] = ['sk', 'en'];

export const BANNER_FIELD_LABELS: Record<string, string> = {
  kicker: 'řádek nad nadpisem',
  title: 'nadpis',
  text: 'text',
  button: 'tlačítko',
  badge: 'štítek',
  alt: 'popis fotky',
  link: 'text odkazu'
};

const FIELDS = ['kicker', 'title', 'text', 'button', 'badge', 'alt'] as const;

export interface BannerGap {
  /** id banneru, nebo `links` pro odkazy pod bannerem */
  id: string;
  /** Kde to je — „Bannery 2 · Kšandy k obleku" */
  where: string;
  /** Kterým polím co chybí */
  fields: { field: string; langs: BannerLang[] }[];
}

function gapsOf(banner: Banner, where: string): BannerGap | null {
  const fields: BannerGap['fields'] = [];
  for (const field of FIELDS) {
    const text = (banner.copy as any)[field] as Record<string, string> | undefined;
    if (!text || !String(text.cz ?? '').trim()) continue;
    // Popis fotky bez fotky se na web neposílá
    if (field === 'alt' && !banner.look.image) continue;
    const langs = BANNER_TARGETS.filter(lang => !String(text[lang] ?? '').trim());
    if (langs.length) fields.push({ field, langs });
  }
  return fields.length ? { id: banner.id, where, fields } : null;
}

export function missingTranslations(set: BannerSet | null | undefined): BannerGap[] {
  if (!set) return [];
  const out: BannerGap[] = [];
  const label = (one: Banner, i: number, part: string) =>
    `${part} ${i + 1} · ${String(one.copy.title.cz || one.name || 'bez nadpisu').slice(0, 40)}`;
  (set.banners ?? []).forEach((one, i) => {
    const gap = gapsOf(one, label(one, i, 'Banner'));
    if (gap) out.push(gap);
  });
  (set.highlights?.banners ?? []).forEach((one, i) => {
    const gap = gapsOf(one, label(one, i, 'Blok pod bannerem'));
    if (gap) out.push(gap);
  });
  const links = (set.links?.items ?? [])
    .filter(one => String(one.text?.cz ?? '').trim());
  const linkLangs = BANNER_TARGETS.filter(lang => links.some(one => !String((one.text as any)[lang] ?? '').trim()));
  if (linkLangs.length) out.push({ id: 'links', where: 'Odkazy pod bannerem', fields: [{ field: 'link', langs: linkLangs }] });
  return out;
}

/** „SK a EN" / „EN" — do hlášek. */
export function langList(langs: BannerLang[]): string {
  return langs.map(one => one.toUpperCase()).join(' a ');
}
