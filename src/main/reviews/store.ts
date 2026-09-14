import crypto from 'crypto';
import { getDb, getSetting, setSetting } from '../db';
import type { Review, ReviewText } from '../../shared/types';

/**
 * Recenze zákazníků — co se drží v aplikaci.
 *
 * ## Proč vůbec v databázi, když se stejně vystavují do Supabase
 *
 * Ve vystaveném souboru je jen to, co má vidět e-shop: fotka, popisek,
 * recenze a podpis. V aplikaci je potřeba víc — vypnuté recenze, pořadí,
 * kdy co vzniklo. A hlavně se recenze **upravují**: kdyby jediná kopie
 * byla ta na webu, znamenala by každá oprava stáhnout, změnit a vystavit,
 * a při výpadku sítě by se nedalo dělat vůbec nic.
 *
 * Pravda o obsahu je tedy tady, Supabase je výkladní skříň. Druhý počítač
 * si vystavený soubor natáhne (`pull`) a doplní si, co mu chybí.
 */

export const SCHEMA = `
  CREATE TABLE IF NOT EXISTS reviews (
    id TEXT PRIMARY KEY,
    image TEXT NOT NULL DEFAULT '',
    width INTEGER NOT NULL DEFAULT 0,
    height INTEGER NOT NULL DEFAULT 0,
    sort INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    langs TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT ''
  );
`;

export const DIRTY_KEY = 'reviewsDirty';

function now(): string {
  return new Date().toISOString();
}

export function blankText(): ReviewText {
  return { caption: '', review: '', name: '' };
}

/**
 * Prázdné jazykové znění se nepočítá.
 *
 * Recenze bývá jen u některých fotek — u zbytku je pod fotkou jen popisek.
 * Rozlišit „nevyplněno" od „prázdné" je proto potřeba všude: na e-shopu se
 * blok s recenzí vůbec nevykreslí, když chybí text nebo podpis.
 */
/**
 * Texty se při ukládání **neořezávají**.
 *
 * Ořezávaly se — a bylo to k nepoužití: rozepsaná recenze se ukládá průběžně,
 * takže se každá mezera na konci vrátila z databáze zkrácená a políčko se
 * přepsalo pod rukama. V popisku, který je HTML, to navíc přehodilo kurzor na
 * začátek a vypadalo to, jako by psaní přestalo fungovat.
 *
 * Ořezává se až tam, kde na tom záleží — když se rozhoduje, co jde na web
 * (`wallItems`).
 */
export function normalizeText(value: any): ReviewText {
  return {
    caption: String(value?.caption ?? ''),
    review: String(value?.review ?? ''),
    name: String(value?.name ?? '')
  };
}

export function normalize(row: any): Review {
  const langs: Record<string, ReviewText> = {};
  const source = row?.langs && typeof row.langs === 'object' ? row.langs : {};
  for (const [lang, text] of Object.entries(source)) langs[lang] = normalizeText(text);
  if (!langs.cz) langs.cz = blankText();

  return {
    id: String(row?.id ?? '') || crypto.randomUUID(),
    image: String(row?.image ?? '').trim(),
    width: Number(row?.width) || 0,
    height: Number(row?.height) || 0,
    sort: Number(row?.sort) || 0,
    active: row?.active !== false && row?.active !== 0,
    langs,
    createdAt: String(row?.createdAt ?? row?.created_at ?? '') || now(),
    updatedAt: String(row?.updatedAt ?? row?.updated_at ?? '') || now()
  };
}

function fromRow(row: any): Review {
  let langs: any = {};
  try { langs = JSON.parse(row.langs ?? '{}'); } catch { /* poškozený řádek bereme jako prázdný */ }
  return normalize({
    id: row.id, image: row.image, width: row.width, height: row.height,
    sort: row.sort, active: row.active !== 0, langs,
    createdAt: row.created_at, updatedAt: row.updated_at
  });
}

export function listReviews(): Review[] {
  const rows = getDb().prepare(
    'SELECT * FROM reviews ORDER BY sort, created_at DESC'
  ).all() as any[];
  return rows.map(fromRow);
}

export function getReview(id: string): Review | null {
  const row = getDb().prepare('SELECT * FROM reviews WHERE id = ?').get(id) as any;
  return row ? fromRow(row) : null;
}

/** Nová recenze jde na začátek — právě přidaná je ta, se kterou se pracuje. */
export function nextSort(): number {
  const row = getDb().prepare('SELECT MIN(sort) AS low FROM reviews').get() as any;
  return (Number(row?.low) || 0) - 1;
}

export function saveReview(input: any): Review {
  const review = normalize({ ...input, updatedAt: now() });
  getDb().prepare(
    `INSERT INTO reviews (id, image, width, height, sort, active, langs, created_at, updated_at)
     VALUES (@id, @image, @width, @height, @sort, @active, @langs, @created_at, @updated_at)
     ON CONFLICT(id) DO UPDATE SET
       image = excluded.image, width = excluded.width, height = excluded.height,
       sort = excluded.sort, active = excluded.active, langs = excluded.langs,
       updated_at = excluded.updated_at`
  ).run({
    id: review.id, image: review.image, width: review.width, height: review.height,
    sort: review.sort, active: review.active ? 1 : 0,
    langs: JSON.stringify(review.langs),
    created_at: review.createdAt, updated_at: review.updatedAt
  });
  setSetting(DIRTY_KEY, '1');
  return review;
}

export function deleteReview(id: string): void {
  getDb().prepare('DELETE FROM reviews WHERE id = ?').run(id);
  setSetting(DIRTY_KEY, '1');
}

/**
 * Přesun recenze v pořadí.
 *
 * Pořadí se přepočítá celé, ne jen u přesouvané: kdyby se jen přičítalo
 * a odečítalo, sesypala by se čísla k sobě a po pár přesunech by se
 * pořadí přestalo měnit.
 */
export function moveReview(id: string, direction: -1 | 1): Review[] {
  const all = listReviews();
  const at = all.findIndex(one => one.id === id);
  const to = at + direction;
  if (at < 0 || to < 0 || to >= all.length) return all;

  const moved = all.slice();
  const [item] = moved.splice(at, 1);
  moved.splice(to, 0, item);

  const d = getDb();
  const upd = d.prepare('UPDATE reviews SET sort = ? WHERE id = ?');
  d.transaction(() => {
    moved.forEach((one, index) => upd.run(index, one.id));
  })();
  setSetting(DIRTY_KEY, '1');
  return listReviews();
}

export function isDirty(): boolean {
  return getSetting(DIRTY_KEY, '0') === '1';
}

/**
 * Co se vystavuje na web.
 *
 * Tvar je schválně tentýž, jaký měl původní ručně psaný skript: `img`,
 * `w`, `h` a jazyky s `captionHtml`, `reviewText` a `reviewName`. Zeď na
 * e-shopu se tak nemusela měnit — jen místo pole v kódu čte tenhle soubor.
 *
 * Vypnuté recenze a ty bez fotky se nevystavují: na e-shopu by z nich byl
 * prázdný rámeček.
 */
export function wallItems(items = listReviews()): any[] {
  return items
    .filter(one => one.active && one.image)
    .map(one => {
      const row: any = { img: one.image, w: one.width, h: one.height };
      for (const [lang, raw] of Object.entries(one.langs)) {
        // Tady se ořezává: v aplikaci se text drží tak, jak se píše, ale na
        // web nemá co jít popisek, ve kterém je jen mezera
        const text = {
          caption: raw.caption.trim(), review: raw.review.trim(), name: raw.name.trim()
        };
        if (!text.caption && !text.review) continue;
        const part: any = { captionHtml: text.caption };
        // Recenze se vykreslí, jen když má text i podpis — jinak visí ve vzduchu
        if (text.review && text.name) {
          part.reviewText = text.review;
          part.reviewName = text.name;
        }
        row[lang] = part;
      }
      return row;
    });
}

export const __test = { normalize, normalizeText, wallItems, blankText };
