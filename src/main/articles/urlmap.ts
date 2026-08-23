import { getDb } from '../db';
import { getArticleSettings, domainFor, articleLangs } from './store';

/**
 * Mapa odkazů mezi jazykovými trhy.
 *
 * Článek na e-shopu odkazuje na produkty, kategorie a jiné články — a každý
 * trh má vlastní doménu i vlastní adresy. Když se článek překládá, musí se
 * odkazy přepsat, jinak čtenář ze slovenské verze skončí na české stránce.
 *
 * Adresy se berou ze tří zdrojů, v tomhle pořadí:
 *   1. **produktová databáze** — u produktu známe SEO adresu v každém jazyce
 *      přesně, včetně starých adres z přesměrování,
 *   2. **naučená mapa** — dvojice adres vytažené z článků, které už přeložené
 *      jsou. Stejný článek ve dvou jazycích je dvojjazyčný slovník adres:
 *      když má česká i slovenská verze stejný počet odkazů, patří k sobě.
 *      Tak se zadarmo dozvíme, že `/kravaty/` je v angličtině `/neckties/`,
 *   3. **ruční záznam** — co člověk opraví, se zamkne a učení to nepřepíše.
 */

export type LinkKind = 'product' | 'category' | 'article' | 'home' | 'external' | 'other';

export interface ResolvedLink {
  url: string;
  kind: LinkKind;
  /** Odkud návrh je — kvůli důvěryhodnosti v rozhraní */
  via: 'product' | 'map' | 'domain' | 'none';
}

/** Rozebere adresu na doménu a cestu. Relativní adresa se bere jako cesta. */
export function splitUrl(url: string): { origin: string; path: string } | null {
  const trimmed = (url ?? '').trim();
  if (!trimmed || trimmed.startsWith('#') || /^(mailto|tel|javascript):/i.test(trimmed)) return null;
  if (trimmed.startsWith('/')) return { origin: '', path: trimmed };
  try {
    const parsed = new URL(trimmed);
    return { origin: parsed.origin, path: parsed.pathname + parsed.search + parsed.hash };
  } catch {
    return null;
  }
}

/** Které domény patří e-shopu — jen jejich odkazy se přepisují. */
export function shopOrigins(): { lang: string; origin: string }[] {
  return getArticleSettings().languages
    .map(l => ({ lang: l.code, origin: (l.domain ?? '').replace(/\/+$/, '') }))
    .filter(l => !!l.origin);
}

/** Ke které jazykové mutaci adresa patří (podle domény). */
export function langOfUrl(url: string): string | null {
  const parts = splitUrl(url);
  if (!parts) return null;
  if (!parts.origin) return null;
  const host = parts.origin.replace(/^https?:\/\//, '').replace(/^www\./, '');
  for (const item of shopOrigins()) {
    const own = item.origin.replace(/^https?:\/\//, '').replace(/^www\./, '');
    if (own === host) return item.lang;
  }
  return null;
}

export function classify(path: string): LinkKind {
  const s = getArticleSettings();
  const clean = path.split(/[?#]/)[0];
  if (clean === '' || clean === '/') return 'home';
  if (clean.startsWith(s.productPrefix)) return 'product';
  if (clean.startsWith(s.articlePrefix)) return 'article';
  // Vše ostatní v kořeni je v Upgates kategorie: /kravaty/, /neckties/
  return /^\/[^/]+\/?$/.test(clean) ? 'category' : 'other';
}

/** Slug z cesty — poslední část bez lomítek. */
export function slugOf(path: string): string {
  return path.split(/[?#]/)[0].replace(/^\/+|\/+$/g, '').split('/').pop() ?? '';
}

/* ---------- naučená mapa ---------- */

export function rememberPair(fromLang: string, fromPath: string, toLang: string, toPath: string,
  kind: LinkKind, locked = false): void {
  if (!fromPath || !toPath || fromLang === toLang || fromPath === toPath) return;
  const d = getDb();
  const now = new Date().toISOString();
  const existing = d.prepare(
    'SELECT to_path, hits, locked FROM art_urlmap WHERE from_lang = ? AND from_path = ? AND to_lang = ?'
  ).get(fromLang, fromPath, toLang) as any;

  // Ruční záznam má přednost — učení ho nepřepíše
  if (existing?.locked && !locked) {
    if (existing.to_path === toPath) {
      d.prepare(`UPDATE art_urlmap SET hits = hits + 1 WHERE from_lang = ? AND from_path = ? AND to_lang = ?`)
        .run(fromLang, fromPath, toLang);
    }
    return;
  }

  d.prepare(
    `INSERT INTO art_urlmap (from_lang, from_path, to_lang, to_path, kind, hits, locked, updated_at)
     VALUES (?,?,?,?,?,1,?,?)
     ON CONFLICT(from_lang, from_path, to_lang) DO UPDATE SET
       to_path = excluded.to_path,
       kind = excluded.kind,
       hits = CASE WHEN art_urlmap.to_path = excluded.to_path THEN art_urlmap.hits + 1 ELSE 1 END,
       locked = excluded.locked,
       updated_at = excluded.updated_at`
  ).run(fromLang, fromPath, toLang, toPath, kind, locked ? 1 : 0, now);
}

export function lookupPair(fromLang: string, fromPath: string, toLang: string):
  { path: string; hits: number; locked: boolean } | null {
  const row = getDb().prepare(
    'SELECT to_path, hits, locked FROM art_urlmap WHERE from_lang = ? AND from_path = ? AND to_lang = ?'
  ).get(fromLang, fromPath, toLang) as any;
  return row ? { path: row.to_path, hits: row.hits, locked: !!row.locked } : null;
}

export function listUrlMap(filter: { fromLang?: string; toLang?: string; kind?: LinkKind; search?: string } = {}) {
  const where: string[] = [];
  const params: any[] = [];
  if (filter.fromLang) { where.push('from_lang = ?'); params.push(filter.fromLang); }
  if (filter.toLang) { where.push('to_lang = ?'); params.push(filter.toLang); }
  if (filter.kind) { where.push('kind = ?'); params.push(filter.kind); }
  if (filter.search) {
    where.push('(from_path LIKE ? OR to_path LIKE ?)');
    const like = `%${filter.search}%`;
    params.push(like, like);
  }
  return getDb().prepare(
    `SELECT from_lang AS fromLang, from_path AS fromPath, to_lang AS toLang, to_path AS toPath,
            kind, hits, locked, updated_at AS updatedAt
     FROM art_urlmap ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY kind, hits DESC, from_path LIMIT 500`
  ).all(...params) as any[];
}

export function deletePair(fromLang: string, fromPath: string, toLang: string): void {
  getDb().prepare('DELETE FROM art_urlmap WHERE from_lang = ? AND from_path = ? AND to_lang = ?')
    .run(fromLang, fromPath, toLang);
}

/* ---------- učení z hotových článků ---------- */

/** Odkazy z HTML v pořadí, v jakém jsou v textu. */
export function extractLinks(html: string): string[] {
  const out: string[] = [];
  const re = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html ?? ''))) out.push(match[1]);
  return out;
}

/** Obrázky z HTML — u překladu se nemění, jen se kontroluje dostupnost. */
export function extractImages(html: string): string[] {
  const out: string[] = [];
  const re = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html ?? ''))) out.push(match[1]);
  return out;
}

export interface LearnUrlResult {
  articles: number;
  pairs: number;
  skipped: number;
}

/**
 * Naučí se dvojice adres z článků, které už jsou přeložené.
 *
 * Páruje se podle pořadí: pokud mají dvě jazykové verze stejného článku
 * stejný počet odkazů e-shopu, jde o tytéž odkazy v jiném jazyce. Když se
 * počty liší, článek se přeskočí — spárovat něco napůl by mapu jen zaplevelilo
 * a špatný odkaz je horší než žádný.
 */
export function learnUrlMap(): LearnUrlResult {
  const d = getDb();
  const langs = articleLangs();
  const rows = d.prepare("SELECT article_id, lang, long FROM art_langs WHERE long != ''").all() as any[];

  const byArticle = new Map<number, Map<string, string>>();
  for (const row of rows) {
    const map = byArticle.get(row.article_id) ?? new Map<string, string>();
    map.set(row.lang, row.long);
    byArticle.set(row.article_id, map);
  }

  let articles = 0;
  let pairs = 0;
  let skipped = 0;

  for (const [, byLang] of byArticle) {
    const present = langs.filter(l => byLang.has(l));
    if (present.length < 2) continue;

    // Jen odkazy, které patří e-shopu — cizí (YouTube) se nepřekládají
    const shopLinks = new Map<string, { path: string; kind: LinkKind }[]>();
    for (const lang of present) {
      const list: { path: string; kind: LinkKind }[] = [];
      for (const href of extractLinks(byLang.get(lang)!)) {
        const parts = splitUrl(href);
        if (!parts) continue;
        if (parts.origin && langOfUrl(href) === null) continue;
        list.push({ path: parts.path, kind: classify(parts.path) });
      }
      shopLinks.set(lang, list);
    }

    let used = false;
    for (const from of present) {
      for (const to of present) {
        if (from === to) continue;
        const found = alignLinks(shopLinks.get(from)!, shopLinks.get(to)!, from, to);
        if (found.length === 0) { skipped++; continue; }
        for (const [a, b] of found) {
          rememberPair(from, a.path, to, b.path, a.kind);
          pairs++;
          used = true;
        }
      }
    }
    if (used) articles++;
  }

  return { articles, pairs, skipped };
}

type Link = { path: string; kind: LinkKind };

/**
 * Spárování odkazů dvou jazykových verzí téhož článku.
 *
 * Prosté párování podle pořadí je křehké: stačí jeden odkaz navíc a posunou se
 * všechny další. U produktů se ale pravda dá ověřit — adresu produktu v obou
 * jazycích zná produktová databáze. Ověřené produkty se proto použijí jako
 * **kotvy**: mezi dvěma kotvami se páruje podle pořadí, ale jen když je v
 * obou verzích mezi nimi stejný počet odkazů. Kde to nesedí, se úsek
 * přeskočí — chybná dvojice v mapě je horší než chybějící.
 */
function alignLinks(a: Link[], b: Link[], from: string, to: string): [Link, Link][] {
  const anchors: [number, number][] = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i].kind !== 'product') continue;
    const expected = productPathInLang(slugOf(a[i].path), from, to);
    if (!expected) continue;
    const wanted = expected.replace(/\/+$/, '');
    const hits: number[] = [];
    for (let j = 0; j < b.length; j++) {
      if (b[j].path.split(/[?#]/)[0].replace(/\/+$/, '') === wanted) hits.push(j);
    }
    // Jednoznačná shoda; produkt zmíněný dvakrát kotvou být nemůže
    if (hits.length === 1) anchors.push([i, hits[0]]);
  }

  // Kotvy musí jít v obou verzích ve stejném pořadí — co se kříží, není kotva
  const kept: [number, number][] = [];
  let lastJ = -1;
  for (const [i, j] of anchors) {
    if (j <= lastJ) continue;
    kept.push([i, j]);
    lastJ = j;
  }

  const out: [Link, Link][] = [];
  const gap = (fromI: number, toI: number, fromJ: number, toJ: number) => {
    if (toI - fromI !== toJ - fromJ) return;
    for (let k = 0; k < toI - fromI; k++) {
      const left = a[fromI + k];
      const right = b[fromJ + k];
      if (left.kind === right.kind) out.push([left, right]);
    }
  };

  if (kept.length === 0) {
    // Bez kotev se věří pořadí jen tehdy, když je odkazů stejně
    gap(0, a.length, 0, b.length);
    return out;
  }

  gap(0, kept[0][0], 0, kept[0][1]);
  for (let n = 0; n < kept.length; n++) {
    out.push([a[kept[n][0]], b[kept[n][1]]]);
    const next = kept[n + 1];
    if (next) gap(kept[n][0] + 1, next[0], kept[n][1] + 1, next[1]);
    else gap(kept[n][0] + 1, a.length, kept[n][1] + 1, b.length);
  }
  return out;
}

/* ---------- převod jedné adresy ---------- */

/**
 * Adresa produktu v daném jazyce z produktové databáze.
 *
 * Zdrojový jazyk má adresu přímo u produktu, ostatní v tabulce polí — a tam
 * platí: co jsme přeložili, jinak co je ve feedu. Kdyby se produkt nenašel
 * podle současné adresy, zkusí se ještě přesměrování: odkaz v článku může být
 * na tvar, který produkt měl dřív.
 */
function productCodeBySlug(slug: string, lang: string): string | null {
  const d = getDb();
  const clean = slug.toLowerCase();
  const s = getArticleSettings();

  if (lang === s.sourceLang) {
    const own = d.prepare('SELECT code FROM ptrans_products WHERE lower(url) = ? LIMIT 1').get(clean) as any;
    if (own) return own.code;
  }
  const row = d.prepare(
    `SELECT code FROM ptrans_fields WHERE field = 'seo_url' AND lang = ?
       AND lower(COALESCE(NULLIF(translated, ''), value)) = ? LIMIT 1`
  ).get(lang, clean) as any;
  if (row) return row.code;

  const viaRedirect = d.prepare(
    `SELECT code FROM ptrans_fields WHERE field = 'redirect' AND lang = ?
       AND COALESCE(NULLIF(translated, ''), value) LIKE ? LIMIT 1`
  ).get(lang, `%${s.productPrefix}${slug}%`) as any;
  return viaRedirect?.code ?? null;
}

export function productSlugInLang(code: string, lang: string): string {
  const d = getDb();
  const s = getArticleSettings();
  if (lang === s.sourceLang) {
    const own = d.prepare('SELECT url FROM ptrans_products WHERE code = ?').get(code) as any;
    if (own?.url) return String(own.url).trim();
  }
  const row = d.prepare(
    `SELECT COALESCE(NULLIF(translated, ''), value) AS slug FROM ptrans_fields
     WHERE code = ? AND lang = ? AND field = 'seo_url'`
  ).get(code, lang) as any;
  return (row?.slug ?? '').trim();
}

function productPathInLang(slug: string, fromLang: string, toLang: string): string | null {
  const prefix = getArticleSettings().productPrefix;
  const code = productCodeBySlug(slug, fromLang);
  if (!code) return null;
  const target = productSlugInLang(code, toLang);
  return target ? `${prefix}${target.replace(/^\/+|\/+$/g, '').replace(/^p\//, '')}` : null;
}

/** Adresa článku v daném jazyce — z vlastní databáze článků. */
function articlePathInLang(slug: string, fromLang: string, toLang: string): string | null {
  const d = getDb();
  const prefix = getArticleSettings().articlePrefix;
  const owner = d.prepare(
    `SELECT article_id FROM art_langs WHERE lang = ? AND (lower(seo_url) = ? OR lower(slug) = ?) LIMIT 1`
  ).get(fromLang, slug.toLowerCase(), slug.toLowerCase()) as any;
  if (!owner) return null;
  const target = d.prepare('SELECT seo_url, slug FROM art_langs WHERE article_id = ? AND lang = ?')
    .get(owner.article_id, toLang) as any;
  const value = (target?.seo_url || target?.slug || '').trim();
  return value ? `${prefix}${value.replace(/^\/+|\/+$/g, '')}` : null;
}

/**
 * Přepíše jeden odkaz do cílového jazyka.
 *
 * Když se cesta najít nepodaří, vrátí se adresa na správné doméně s původní
 * cestou a `via: 'domain'` — na trhu aspoň zůstane, ale kontrola odkazů si ji
 * vezme na paškál.
 */
export function translateUrl(url: string, fromLang: string, toLang: string): ResolvedLink {
  const parts = splitUrl(url);
  if (!parts) return { url, kind: 'other', via: 'none' };

  const owner = parts.origin ? langOfUrl(url) : fromLang;
  if (parts.origin && owner === null) return { url, kind: 'external', via: 'none' };

  const sourceLang = owner ?? fromLang;
  const kind = classify(parts.path);
  const domain = domainFor(toLang);

  if (sourceLang === toLang) return { url: domain ? domain + parts.path : url, kind, via: 'domain' };

  if (kind === 'product') {
    const path = productPathInLang(slugOf(parts.path), sourceLang, toLang);
    if (path) return { url: domain + path, kind, via: 'product' };
  }
  if (kind === 'article') {
    const path = articlePathInLang(slugOf(parts.path), sourceLang, toLang);
    if (path) return { url: domain + path, kind, via: 'product' };
  }
  const learned = lookupPair(sourceLang, parts.path, toLang);
  if (learned) return { url: domain + learned.path, kind, via: 'map' };

  if (kind === 'home') return { url: domain + '/', kind, via: 'domain' };
  return { url: domain + parts.path, kind, via: 'domain' };
}

/** Přepíše všechny odkazy v HTML. Vrací i seznam těch, které se nepodařilo přeložit. */
export function rewriteLinks(html: string, fromLang: string, toLang: string):
  { html: string; unresolved: { url: string; kind: LinkKind }[] } {
  const unresolved: { url: string; kind: LinkKind }[] = [];
  const out = (html ?? '').replace(/(<a\b[^>]*\bhref\s*=\s*)(["'])([^"']+)\2/gi,
    (match, head, quote, href) => {
      const resolved = translateUrl(href, fromLang, toLang);
      if (resolved.via === 'none') return match;
      if (resolved.via === 'domain' && resolved.kind !== 'home') {
        unresolved.push({ url: href, kind: resolved.kind });
      }
      return `${head}${quote}${resolved.url}${quote}`;
    });
  return { html: out, unresolved };
}
