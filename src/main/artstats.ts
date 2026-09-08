import { getDb } from './db';
import { ga4Pages } from './ga4';
import type { ArticleStat, ArticleStatsView, ArticleStatDetail, Ga4Slice } from '../shared/types';

/**
 * Jak si vedou články.
 *
 * Články se v aplikaci píšou, překládají a kontrolují — a pak se o nich už
 * nikdy nic nedozví. Přitom otázka „vyplatilo se to psát" má odpověď
 * v Analytics: kolik lidí článek přečetlo, kolik jich přes něj do e-shopu
 * **vstoupilo** a kolik z toho bylo objednávek.
 *
 * Dvě čísla, která se pletou, a proto se ukazují obě:
 *
 *  - **návštěvy stránky** — kolikrát si někdo článek otevřel, i když přišel
 *    odjinud z webu,
 *  - **vstupy** — kolikrát byl článek tou první stránkou. Jen u těch se dá
 *    mluvit o tom, že článek zákazníka přivedl, protože nákup Analytics
 *    připisuje vstupní stránce.
 *
 * Článek s deseti tisíci čtenáři a nulou vstupů čtou lidé, kteří na webu
 * už jsou. To není špatně, ale je to jiná zpráva než „přivedl 300 lidí".
 *
 * Měří se jen český web — na .sk a .com zatím Analytics napojené nejsou,
 * takže u překladů se nic nepředstírá a řekne se, že se neměří.
 */

/** Adresa na porovnatelný tvar: bez domény, bez parametrů, bez lomítka na konci. */
export function normalizePath(raw: string): string {
  let value = String(raw ?? '').trim().toLowerCase();
  if (!value) return '';
  value = value.replace(/^https?:\/\/[^/]+/, '');
  value = value.split('?')[0].split('#')[0];
  if (!value.startsWith('/')) value = `/${value}`;
  if (value.length > 1) value = value.replace(/\/+$/, '');
  return value;
}

/**
 * Poslední kus adresy.
 *
 * Upgates staví adresu článku jinak podle nastavení — jednou `/clanek/nazev`,
 * jindy `/a/nazev` nebo rovnou `/nazev`. Podle celé cesty by se článek často
 * nenašel, podle posledního kusu se najde vždycky; a ten je mezi články
 * jedinečný, protože z něj vzniká odkaz.
 */
export function slugOf(path: string): string {
  const parts = normalizePath(path).split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

/** Články v češtině — jen ty, které mají adresu, jinak není co hledat. */
function czArticles(): { id: number; title: string; path: string; status: string; updatedAt: string }[] {
  const rows = getDb().prepare(`
    SELECT a.id, a.status, a.updated_at, l.title, l.seo_url, l.slug
    FROM art_articles a
    JOIN art_langs l ON l.article_id = a.id AND l.lang = 'cz'
    ORDER BY a.updated_at DESC
  `).all() as any[];
  return rows.map(row => ({
    id: Number(row.id),
    title: String(row.title ?? '').trim() || '(bez názvu)',
    path: normalizePath(String(row.seo_url ?? '') || String(row.slug ?? '')),
    status: String(row.status ?? ''),
    updatedAt: String(row.updated_at ?? '')
  })).filter(row => row.path && row.path !== '/');
}

/** Rejstřík podle celé cesty i podle posledního kusu — hledá se oběma. */
function indexOf(rows: Ga4Slice[]): Map<string, Ga4Slice> {
  const map = new Map<string, Ga4Slice>();
  for (const row of rows) {
    const path = normalizePath(row.name);
    if (!path) continue;
    if (!map.has(path)) map.set(path, row);
    const slug = slugOf(path);
    // Podle posledního kusu jen tehdy, když si ho nenárokuje nikdo jiný;
    // u shody dvou stránek by se čísla připsala té špatné
    if (slug && !map.has(`~${slug}`)) map.set(`~${slug}`, row);
  }
  return map;
}

function find(map: Map<string, Ga4Slice>, path: string): Ga4Slice | null {
  return map.get(path) ?? map.get(`~${slugOf(path)}`) ?? null;
}

export async function articleStats(days = 365): Promise<ArticleStatsView | null> {
  const list = czArticles();
  const data = await ga4Pages(days);
  if (!data) {
    return {
      at: '', days, scope: '', rows: [], views: 0, entries: 0, revenue: 0,
      missing: list.length, error: 'Napojení na Analytics není nastavené.'
    };
  }

  const pages = indexOf(data.pages);
  const landings = indexOf(data.landings);

  const rows: ArticleStat[] = list.map(article => {
    const page = find(pages, article.path);
    const entry = find(landings, article.path);
    return {
      id: article.id,
      title: article.title,
      path: article.path,
      status: article.status,
      updatedAt: article.updatedAt,
      views: page?.sessions ?? 0,
      readers: page?.users ?? 0,
      entries: entry?.sessions ?? 0,
      purchases: entry?.purchases ?? 0,
      revenue: entry?.revenue ?? 0,
      found: !!page || !!entry
    };
  });

  rows.sort((a, b) => b.views - a.views || b.entries - a.entries);
  return {
    at: data.at,
    days: data.days,
    scope: data.scope,
    rows,
    views: rows.reduce((sum, one) => sum + one.views, 0),
    entries: rows.reduce((sum, one) => sum + one.entries, 0),
    revenue: rows.reduce((sum, one) => sum + one.revenue, 0),
    missing: rows.filter(one => !one.found).length,
    error: data.error
  };
}

/**
 * Jeden článek podrobně — s vývojem po měsících a s větou, co z toho plyne.
 *
 * Věta se skládá v kódu z čísel, ne od AI: u jednoho článku jde o pár
 * porovnání a odpověď má být pokaždé stejná, ne pokaždé jinak formulovaná.
 */
export async function articleStat(id: number, days = 365): Promise<ArticleStatDetail | null> {
  const view = await articleStats(days);
  if (!view) return null;
  const stat = view.rows.find(one => one.id === id) ?? null;
  if (!stat) return null;

  const data = await ga4Pages(days);
  const months = (data?.months ?? [])
    .filter(row => normalizePath(row.path) === stat.path || slugOf(row.path) === slugOf(stat.path))
    .reduce((acc, row) => {
      const hit = acc.find(one => one.month === row.month);
      if (hit) { hit.sessions += row.sessions; hit.users += row.users; }
      else acc.push({ month: row.month, sessions: row.sessions, users: row.users });
      return acc;
    }, [] as { month: string; sessions: number; users: number }[])
    .sort((a, b) => (a.month < b.month ? -1 : 1));

  return { stat, months, scope: view.scope, days: view.days, note: noteFor(stat, view), error: view.error };
}

/** Co s tím — postavené jen na číslech, která u článku opravdu jsou. */
function noteFor(stat: ArticleStat, view: ArticleStatsView): string {
  if (!stat.found) {
    return 'Analytics tenhle článek nezná. Buď ještě není na webu, má jinou adresu, '
      + 'nebo ho zatím nikdo neotevřel.';
  }
  if (stat.views < 50) {
    return `Za ${view.days} dní ${stat.views} návštěv — na závěry je to málo. `
      + 'Stojí za to zkusit na článek odkázat z kategorie nebo ho poslat v newsletteru.';
  }
  const entryShare = stat.views > 0 ? Math.round((stat.entries / stat.views) * 100) : 0;
  const parts: string[] = [];
  if (entryShare >= 50) {
    parts.push(`Většina čtenářů (${entryShare} %) přichází na tenhle článek rovnou z vyhledávání `
      + 'nebo z odkazu — je to vstupní brána do e-shopu.');
  } else if (stat.entries === 0) {
    parts.push('Nikdo sem nepřišel zvenčí: čtou ho lidé, kteří už na webu jsou. '
      + 'Na přivedení nových zákazníků zatím nefunguje.');
  } else {
    parts.push(`Zvenčí sem přišlo ${stat.entries} návštěv z ${stat.views}, zbytek jsou lidé, `
      + 'kteří už na webu byli.');
  }
  if (stat.entries >= 100) {
    parts.push(stat.purchases > 0
      ? `Z těch příchodů bylo ${stat.purchases} objednávek za ${Math.round(stat.revenue)} Kč.`
      : 'Objednávka z toho zatím žádná — zkus do textu přidat odkaz na konkrétní zboží.');
  }
  const share = view.views > 0 ? Math.round((stat.views / view.views) * 100) : 0;
  if (share >= 15) parts.push(`Je to ${share} % veškeré čtenosti článků.`);
  return parts.join(' ');
}
