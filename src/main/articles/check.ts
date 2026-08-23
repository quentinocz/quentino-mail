import { BrowserWindow } from 'electron';
import { getDb } from '../db';
import { getArticleSettings } from './store';
import { extractLinks, extractImages, splitUrl, classify, slugOf, langOfUrl,
  lookupPair, productSlugInLang, LinkKind } from './urlmap';

/**
 * Kontrola odkazů v článcích.
 *
 * Adresy produktů se mění — po přejmenování zůstane v článku odkaz, který
 * vrací 404, a nikdo se to nedozví. Kontrola projde všechny odkazy i obrázky
 * ve všech jazykových verzích a u každého, který neodpovídá, zkusí najít, kam
 * dnes patří:
 *
 *   1. **přesměrování 301** u produktu — stará cesta je tam uložená, takže se
 *      pozná, který produkt to byl a jak se jmenuje teď,
 *   2. **shoda slugu** v produktové databázi,
 *   3. **mapa adres** mezi jazyky.
 *
 * Nic se neopravuje samo. Návrh se ukáže a opraví se to, co se potvrdí —
 * automatická oprava odkazu, který jen dočasně nešel načíst, by článek
 * pokazila natrvalo.
 */

export interface LinkCheck {
  id?: number;
  articleId: number;
  articleTitle: string;
  lang: string;
  url: string;
  kind: LinkKind | 'image';
  status: number | null;
  suggestion: string | null;
  note: string;
  /** Server neodpověděl — o odkazu nevíme nic, není to totéž co rozbitý */
  unverified?: boolean;
}

export interface CheckProgress {
  running: boolean;
  done: number;
  total: number;
  broken: number;
  label: string;
}

let state: CheckProgress = { running: false, done: 0, total: 0, broken: 0, label: '' };
let cancelled = false;

function emit(channel: string, payload: unknown) {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload);
}

function push(patch: Partial<CheckProgress>) {
  state = { ...state, ...patch };
  emit('articles:check', state);
}

export function checkProgress(): CheckProgress | null {
  return state.running ? state : null;
}

export function stopCheck(): void {
  if (state.running) { cancelled = true; push({ label: 'zastavuji…' }); }
}

/**
 * Ověření jedné adresy.
 *
 * Tohle je celé o tom, **nehlásit falešné poplachy**. E-shop je běžný web za
 * ochranou proti robotům: když na něj přiletí patnáct požadavků během vteřiny,
 * část jich zahodí nebo zpomalí — a odkaz, který v prohlížeči funguje, se
 * v přehledu objeví jako rozbitý. To je horší než nic nezkontrolovat, protože
 * to svádí „opravit" něco, co je v pořádku.
 *
 * Proto:
 *  - hlavička prohlížeče, ne název aplikace (WAF neznámé roboty odmítá),
 *  - HEAD, a když ho server nemá rád, ještě GET,
 *  - **opakování se zdržením**, než se odkaz označí za vadný,
 *  - a hlavně: když server neodpoví ani napodruhé, vrací se `null` jako
 *    „nepodařilo se ověřit", ne jako „nefunguje".
 */
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
  + ' (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function probe(url: string, attempts = 3): Promise<number | null> {
  const once = async (method: 'HEAD' | 'GET') => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const res = await fetch(url, {
        method,
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'User-Agent': BROWSER_UA,
          'Accept': 'text/html,application/xhtml+xml,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'cs,sk;q=0.9,en;q=0.8'
        }
      });
      return res.status;
    } finally {
      clearTimeout(timer);
    }
  };

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      let status = await once('HEAD');
      // 405 = HEAD neumí, 403/401 často blokuje jen HEAD, 429 = přetížení
      if (status === 405 || status === 501 || status === 403 || status === 401) {
        status = await once('GET');
      }
      // Přetížení není vada odkazu — chvíli počkat a zkusit znovu
      if (status === 429 || status === 503) {
        if (attempt < attempts) { await wait(1500 * attempt); continue; }
        return null;
      }
      return status;
    } catch {
      try {
        return await once('GET');
      } catch {
        if (attempt < attempts) { await wait(800 * attempt); continue; }
        return null;
      }
    }
  }
  return null;
}

/** Kam dnes vede cesta, která nefunguje. */
function suggest(url: string, lang: string): { url: string; note: string } | null {
  const parts = splitUrl(url);
  if (!parts) return null;
  const s = getArticleSettings();
  const d = getDb();
  const kind = classify(parts.path);
  const owner = langOfUrl(url) ?? lang;
  const domain = (s.languages.find(l => l.code === owner)?.domain ?? '').replace(/\/+$/, '');
  const slug = slugOf(parts.path);

  if (kind === 'product') {
    // 1) stará cesta v přesměrování → produkt, který ji kdysi měl
    const viaRedirect = d.prepare(
      `SELECT code FROM ptrans_fields WHERE field = 'redirect' AND lang = ?
         AND COALESCE(NULLIF(translated, ''), value) LIKE ? LIMIT 1`
    ).get(owner, `%${s.productPrefix}${slug}%`) as any;

    if (viaRedirect?.code) {
      const now = productSlugInLang(viaRedirect.code, owner);
      if (now) {
        return {
          url: `${domain}${s.productPrefix}${now.replace(/^\/+/, '').replace(/^p\//, '')}`,
          note: `produkt ${viaRedirect.code} — adresa se změnila, stará vede přes 301`
        };
      }
    }

    // 2) produkt existuje, jen odkaz míří na jiný trh
    const other = d.prepare(
      `SELECT code, lang FROM ptrans_fields WHERE field = 'seo_url'
         AND lower(COALESCE(NULLIF(translated, ''), value)) = ? LIMIT 1`
    ).get(slug.toLowerCase()) as any;
    if (other?.code) {
      const here = productSlugInLang(other.code, owner);
      if (here) {
        return {
          url: `${domain}${s.productPrefix}${here.replace(/^\/+/, '').replace(/^p\//, '')}`,
          note: other.lang === owner
            ? `produkt ${other.code} — adresa se mezitím změnila`
            : `odkaz mířil na jazykovou verzi ${String(other.lang).toUpperCase()}`
        };
      }
    }
  }

  // 3) mapa adres — kategorie a články
  for (const from of s.languages.map(l => l.code)) {
    if (from === owner) continue;
    const pair = lookupPair(from, parts.path, owner);
    if (pair) return { url: domain + pair.path, note: `podle mapy odkazů (${from.toUpperCase()} → ${owner.toUpperCase()})` };
  }
  return null;
}

export interface CheckOptions {
  /** Jen tyhle články; prázdné = všechny */
  articleIds?: number[];
  langs?: string[];
  /** Kontrolovat i obrázky */
  images?: boolean;
  /**
   * Kolik adres najednou. Výchozí 2 — skoro všechny odkazy míří na tentýž
   * e-shop a víc souběžných dotazů si koleduje o falešné poplachy.
   */
  concurrency?: number;
  /** Pauza mezi dotazy v milisekundách */
  spacingMs?: number;
}

export async function checkLinks(options: CheckOptions = {}): Promise<LinkCheck[]> {
  if (state.running) throw new Error('Kontrola už běží.');
  const d = getDb();
  const s = getArticleSettings();
  const langs = options.langs?.length ? options.langs : s.languages.filter(l => l.enabled).map(l => l.code);

  const marks = options.articleIds?.length ? `AND v.article_id IN (${options.articleIds.map(() => '?').join(',')})` : '';
  const rows = d.prepare(
    `SELECT v.article_id AS articleId, v.lang, v.long, v.title
     FROM art_langs v WHERE v.long != '' AND v.lang IN (${langs.map(() => '?').join(',')}) ${marks}`
  ).all(...langs, ...(options.articleIds ?? [])) as any[];

  // Stejná adresa se v článcích opakuje — kontroluje se jednou
  const targets = new Map<string, LinkCheck[]>();
  for (const row of rows) {
    const found: { url: string; kind: LinkCheck['kind'] }[] = [
      ...extractLinks(row.long).map(url => ({ url, kind: classify(splitUrl(url)?.path ?? '') as LinkCheck['kind'] })),
      ...(options.images === false ? [] : extractImages(row.long).map(url => ({ url, kind: 'image' as const })))
    ];
    for (const item of found) {
      const parts = splitUrl(item.url);
      if (!parts || !parts.origin) continue;
      const entry: LinkCheck = {
        articleId: row.articleId,
        articleTitle: row.title,
        lang: row.lang,
        url: item.url,
        kind: item.kind,
        status: null,
        suggestion: null,
        note: ''
      };
      const list = targets.get(item.url) ?? [];
      list.push(entry);
      targets.set(item.url, list);
    }
  }

  const urls = [...targets.keys()];
  cancelled = false;
  state = { running: true, done: 0, total: urls.length, broken: 0, label: '' };
  push({});

  const results: LinkCheck[] = [];
  /*
   * Souběh je schválně nízký a mezi požadavky se čeká.
   *
   * Skoro všechny odkazy míří na tentýž e-shop. Pustit na něj osm souběžných
   * dotazů znamená koledovat si o zahazování a hlášku „server neodpověděl"
   * u odkazů, které fungují. Kontrola tisícovky odkazů tak trvá minuty místo
   * vteřin — ale výsledku se dá věřit, což je jediné, k čemu je dobrá.
   */
  const concurrency = Math.max(1, Math.min(4, options.concurrency ?? 2));
  const spacing = Math.max(0, options.spacingMs ?? 250);
  let cursor = 0;

  const worker = async (index: number) => {
    // Rozestup na startu, aby první vlna nedorazila naráz
    await wait(index * spacing);
    while (cursor < urls.length && !cancelled) {
      const url = urls[cursor++];
      const status = await probe(url);
      const entries = targets.get(url)!;

      // Tři různé výsledky, ne dva. „Neověřeno" není „rozbité": server mohl
      // jen zahodit dotaz kvůli zátěži a označit kvůli tomu funkční odkaz za
      // vadný je horší, než ho nezkontrolovat vůbec.
      const ok = status !== null && status >= 200 && status < 400;
      const unverified = status === null;

      if (!ok) {
        const fix = unverified ? null : suggest(url, entries[0].lang);
        for (const entry of entries) {
          entry.status = status;
          entry.suggestion = fix?.url ?? null;
          entry.note = unverified
            ? 'nepodařilo se ověřit — server neodpověděl ani po opakování'
            : (fix?.note ?? `HTTP ${status}`);
          entry.unverified = unverified;
          results.push(entry);
        }
        push({ broken: state.broken + (unverified ? 0 : entries.length) });
      }
      push({ done: state.done + 1, label: url.slice(0, 80) });
      if (spacing) await wait(spacing);
    }
  };

  try {
    await Promise.all(Array.from({ length: concurrency }, (_, index) => worker(index)));
  } finally {
    push({ running: false, label: cancelled ? 'zastaveno' : 'hotovo' });
  }

  // Uloží se jen vadné — seznam funkčních odkazů nikoho nezajímá
  const ids = [...new Set(results.map(r => r.articleId))];
  if (ids.length) {
    d.prepare(`DELETE FROM art_links WHERE article_id IN (${ids.map(() => '?').join(',')})`).run(...ids);
  }
  const insert = d.prepare(
    `INSERT INTO art_links (article_id, lang, url, kind, status, suggestion, note, unverified, checked_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  );
  const now = new Date().toISOString();
  for (const item of results) {
    insert.run(item.articleId, item.lang, item.url, item.kind, item.status,
      item.suggestion, item.note, item.unverified ? 1 : 0, now);
  }

  emit('articles:changed', {});
  return results;
}

/** Poslední výsledek kontroly — přežije zavření okna. */
export function lastCheck(): LinkCheck[] {
  return getDb().prepare(
    `SELECT l.id, l.article_id AS articleId, l.lang, l.url, l.kind, l.status, l.suggestion, l.note,
            l.unverified,
            (SELECT title FROM art_langs v WHERE v.article_id = l.article_id AND v.lang = l.lang) AS articleTitle
     FROM art_links l ORDER BY l.unverified, l.article_id, l.lang`
  ).all().map((row: any) => ({ ...row, unverified: !!row.unverified })) as LinkCheck[];
}

/**
 * Nahradí odkaz ve všech jazykových verzích, kde je.
 *
 * Nahrazuje se celý řetězec adresy, ne cesta — tak se nemůže stát, že se
 * omylem přepíše kus jiného odkazu, který tu adresu obsahuje jako začátek.
 */
export function applyFix(articleId: number, lang: string, from: string, to: string): number {
  const d = getDb();
  const row = d.prepare('SELECT long FROM art_langs WHERE article_id = ? AND lang = ?')
    .get(articleId, lang) as any;
  if (!row?.long) return 0;

  const quoted = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let count = 0;
  const next = row.long.replace(new RegExp(`(["'])${quoted}\\1`, 'g'), (m: string, q: string) => {
    count++;
    return `${q}${to}${q}`;
  });
  if (count === 0) return 0;

  d.prepare('UPDATE art_langs SET long = ?, updated_at = ? WHERE article_id = ? AND lang = ?')
    .run(next, new Date().toISOString(), articleId, lang);
  d.prepare('DELETE FROM art_links WHERE article_id = ? AND lang = ? AND url = ?')
    .run(articleId, lang, from);
  emit('articles:changed', { id: articleId });
  return count;
}

/**
 * Odstraní odkaz ze seznamu vad, aniž by se v článku cokoli měnilo.
 *
 * Pro případy, kdy kontrola hlásí něco, co ve skutečnosti funguje — třeba
 * stránku, která robotům odpovídá jinak než prohlížeči. Po ruční kontrole je
 * tohle způsob, jak takový odkaz odbavit a nemít ho pořád v cestě.
 */
export function dismissLink(articleId: number, lang: string, url: string): boolean {
  getDb().prepare('DELETE FROM art_links WHERE article_id = ? AND lang = ? AND url = ?')
    .run(articleId, lang, url);
  emit('articles:changed', { id: articleId });
  return true;
}

/** Opraví všechno, co má návrh. Vrací počet skutečně přepsaných odkazů. */
export function applyAllFixes(articleIds?: number[]): number {
  const d = getDb();
  const marks = articleIds?.length ? `AND article_id IN (${articleIds.map(() => '?').join(',')})` : '';
  // Neověřené odkazy se hromadně neopravují — u nich se neví, jestli je co opravovat
  const rows = d.prepare(
    `SELECT article_id AS articleId, lang, url, suggestion FROM art_links
     WHERE suggestion IS NOT NULL AND suggestion != '' AND unverified = 0 ${marks}`
  ).all(...(articleIds ?? [])) as any[];

  let total = 0;
  for (const row of rows) total += applyFix(row.articleId, row.lang, row.url, row.suggestion);
  return total;
}
