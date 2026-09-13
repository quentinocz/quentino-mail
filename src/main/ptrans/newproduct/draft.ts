import { getDb } from '../../db';

/**
 * Rozdělaný nový produkt.
 *
 * Drží se v databázi, ne v paměti okna: vyplnit nový produkt je práce na
 * dvacet minut a zavřít okno omylem se dá za vteřinu. Ze stejného důvodu se
 * ukládá po každé změně, ne až na tlačítko.
 *
 * Tabulka `ptrans_drafts` je v `ptrans/schema.ts` — tam, kde jsou i ostatní,
 * aby se `db.ts` nemusel doimportovat další soubor.
 */


/** Texty produktu v jednom jazyce. Klíče sedí s `FieldKey` v ptrans/xml.ts. */
export interface DraftTexts {
  title: string;
  short: string;
  long: string;
  seo_title: string;
  seo_desc: string;
  seo_url: string;
  google_title: string;
  google_desc: string;
}

export interface DraftImage {
  /** Soubor na disku, dokud se nenahraje */
  path?: string;
  /** Adresa po nahrání do souborů e-shopu */
  url?: string;
  name: string;
  main: boolean;
  width?: number;
  height?: number;
}

export interface DraftParam {
  name: string;
  value: string;
  /** Z předlohy, nebo dopsané ručně — v rozhraní se to rozlišuje barvou */
  fromTemplate?: boolean;
}

export interface DraftProduct {
  id: string;
  /** Kód produktu v e-shopu; bez něj se importovat nedá */
  code: string;
  ean: string;
  manufacturer: string;
  /** Kód produktu, ze kterého se braly texty */
  templateCode: string;
  /** Kódy kategorií z exportu kategorií */
  categories: string[];
  /** Kód hlavní kategorie — musí být i v `categories` */
  mainCategory: string;
  images: DraftImage[];
  params: DraftParam[];
  /** Texty po jazycích; `cz` vyplňuje člověk, zbytek se překládá */
  langs: Record<string, DraftTexts>;
  /** Google atributy — společné pro všechny jazyky až na titulek a popis */
  google: Record<string, string>;
  /**
   * Cena s DPH po jazycích (`cz` v korunách, `sk`/`en` v eurech).
   *
   * Zásoba tu schválně není. Sklad se plní v administraci a naskladněním;
   * kdyby ho nesl import, každý oprav­ný import textů by po sobě přepsal
   * počet kusů podle toho, co bylo v aplikaci před týdnem.
   */
  prices: Record<string, string>;
  /**
   * Části textu, které jsou specifické pro předlohu (barva, vzor, velikost).
   * Ukládá se jako holý text výřezu, ne pozice — text se mezitím edituje
   * a pozice by po prvním napsaném písmenu ukazovaly jinam.
   */
  specifics: { lang: string; field: string; text: string; why: string }[];
  state: 'draft' | 'exported';
  createdAt: string;
  updatedAt: string;
  exportedAt: string | null;
}

export function emptyTexts(): DraftTexts {
  return { title: '', short: '', long: '', seo_title: '', seo_desc: '', seo_url: '', google_title: '', google_desc: '' };
}

function normalize(row: any): DraftProduct {
  let data: any = {};
  try { data = JSON.parse(row.data || '{}'); } catch { data = {}; }
  const langs: Record<string, DraftTexts> = {};
  for (const [lang, texts] of Object.entries(data.langs ?? {})) {
    langs[lang] = { ...emptyTexts(), ...(texts as object) };
  }
  if (!langs.cz) langs.cz = emptyTexts();
  return {
    id: row.id,
    code: row.code ?? '',
    ean: data.ean ?? '',
    manufacturer: data.manufacturer ?? '',
    templateCode: row.template ?? '',
    categories: Array.isArray(data.categories) ? data.categories : [],
    mainCategory: data.mainCategory ?? '',
    images: Array.isArray(data.images) ? data.images : [],
    params: Array.isArray(data.params) ? data.params : [],
    langs,
    google: data.google ?? {},
    prices: data.prices ?? {},
    specifics: Array.isArray(data.specifics) ? data.specifics : [],
    state: row.state === 'exported' ? 'exported' : 'draft',
    createdAt: row.created_at ?? '',
    updatedAt: row.updated_at ?? '',
    exportedAt: row.exported_at ?? null
  };
}

export function listDrafts(): DraftProduct[] {
  const rows = getDb().prepare('SELECT * FROM ptrans_drafts ORDER BY updated_at DESC').all() as any[];
  return rows.map(normalize);
}

export function getDraft(id: string): DraftProduct | null {
  const row = getDb().prepare('SELECT * FROM ptrans_drafts WHERE id = ?').get(id) as any;
  return row ? normalize(row) : null;
}

export function newDraft(): DraftProduct {
  const now = new Date().toISOString();
  const id = `np-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  getDb().prepare(`INSERT INTO ptrans_drafts (id, code, title, template, data, state, created_at, updated_at)
                   VALUES (?, '', '', '', '{}', 'draft', ?, ?)`).run(id, now, now);
  return getDraft(id)!;
}

/**
 * Uloží změnu rozdělaného produktu.
 *
 * Bere **výřez**, ne celý produkt: rozhraní posílá jen to, co se zrovna
 * změnilo (jeden text, jedna kategorie). Kdyby se posílal celý objekt,
 * dvě rychlé změny za sebou by si navzájem přepsaly starší hodnoty.
 */
export function saveDraft(id: string, patch: Partial<DraftProduct>): DraftProduct {
  const current = getDraft(id);
  if (!current) throw new Error('Rozdělaný produkt už neexistuje.');
  const next: DraftProduct = {
    ...current,
    ...patch,
    langs: patch.langs ? mergeLangs(current.langs, patch.langs) : current.langs,
    google: patch.google ? { ...current.google, ...patch.google } : current.google,
    prices: patch.prices ? { ...current.prices, ...patch.prices } : current.prices
  };
  // Hlavní kategorie musí být mezi vybranými; jinak by se do XML zapsalo
  // PRIMARY_YN u kategorie, kterou produkt vůbec nemá
  if (next.mainCategory && !next.categories.includes(next.mainCategory)) {
    next.mainCategory = next.categories[0] ?? '';
  }
  if (!next.mainCategory && next.categories.length) next.mainCategory = next.categories[0];
  const now = new Date().toISOString();
  getDb().prepare(`UPDATE ptrans_drafts SET code = ?, title = ?, template = ?, data = ?,
                   state = ?, updated_at = ?, exported_at = ? WHERE id = ?`)
    .run(next.code, next.langs.cz?.title ?? '', next.templateCode, JSON.stringify({
      ean: next.ean, manufacturer: next.manufacturer,
      categories: next.categories, mainCategory: next.mainCategory,
      images: next.images, params: next.params, langs: next.langs,
      google: next.google, prices: next.prices, specifics: next.specifics
    }), next.state, now, next.exportedAt, id);
  return getDraft(id)!;
}

function mergeLangs(current: Record<string, DraftTexts>, patch: Record<string, DraftTexts>) {
  const out = { ...current };
  for (const [lang, texts] of Object.entries(patch)) {
    out[lang] = { ...emptyTexts(), ...(out[lang] ?? {}), ...texts };
  }
  return out;
}

export function deleteDraft(id: string): void {
  getDb().prepare('DELETE FROM ptrans_drafts WHERE id = ?').run(id);
}

/* ---------- co ještě chybí ---------- */

export interface DraftGap {
  key: string;
  label: string;
  /** `blocker` brání exportu, `warn` je jen doporučení */
  level: 'blocker' | 'warn';
}

/**
 * Seznam „co ještě chybí".
 *
 * Schválně rozlišuje, co export **zastaví** a co je jen škoda. Kód a český
 * název bez hlavní kategorie se naimportovat dá, ale produkt pak v e-shopu
 * visí mimo menu a nikdo ho nenajde — proto je to blokující.
 */
export function draftGaps(draft: DraftProduct, langs: string[]): DraftGap[] {
  const out: DraftGap[] = [];
  const cz = draft.langs.cz ?? emptyTexts();
  if (!draft.code.trim()) out.push({ key: 'code', label: 'Kód produktu', level: 'blocker' });
  if (!cz.title.trim()) out.push({ key: 'title', label: 'Český název', level: 'blocker' });
  if (!cz.short.trim()) out.push({ key: 'short', label: 'Krátký popis', level: 'blocker' });
  if (!cz.long.trim()) out.push({ key: 'long', label: 'Dlouhý popis', level: 'blocker' });
  if (!draft.mainCategory) out.push({ key: 'category', label: 'Hlavní kategorie', level: 'blocker' });
  if (!(draft.prices.cz ?? '').trim()) out.push({ key: 'price', label: 'Cena v korunách', level: 'blocker' });
  else if (langs.some(lang => lang !== 'cz' && !(draft.prices[lang] ?? '').trim())) {
    out.push({ key: 'price-eur', label: 'Cena v eurech', level: 'warn' });
  }
  if (draft.images.length === 0) out.push({ key: 'images', label: 'Obrázky', level: 'warn' });
  else if (!draft.images.some(one => one.main)) out.push({ key: 'main-image', label: 'Titulní obrázek', level: 'warn' });
  else if (draft.images.some(one => !one.url)) out.push({ key: 'upload', label: 'Nahrání obrázků na e-shop', level: 'blocker' });
  if (draft.params.length === 0) out.push({ key: 'params', label: 'Parametry', level: 'warn' });
  if (!cz.seo_title.trim() || !cz.seo_desc.trim()) out.push({ key: 'seo', label: 'SEO texty', level: 'warn' });
  if (!cz.google_title.trim() || !cz.google_desc.trim()) out.push({ key: 'google', label: 'Texty pro Google', level: 'warn' });
  for (const lang of langs) {
    if (lang === 'cz') continue;
    const t = draft.langs[lang];
    if (!t?.title?.trim() || !t?.long?.trim()) {
      out.push({ key: `lang:${lang}`, label: `Překlad do ${lang.toUpperCase()}`, level: 'warn' });
    }
  }
  return out;
}

export const __test = { normalize, mergeLangs };
