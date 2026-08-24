import { getDb } from '../db';
import { saveStyle, learnedStyle } from './style';

/**
 * Dvě varianty k porovnání.
 *
 * U některých kategorií není jedna správná odpověď — „Dámská stuha barevná
 * s květy" a „Barevná dámská stuha s květy" jsou obojí česky správně a liší
 * se jen tím, co má stát vepředu. Model to sám nerozhodne a hádat za
 * uživatele nemá smysl, protože je to věc vkusu a znalosti zákazníků.
 *
 * Proto se u **první** položky v kategorii napíšou varianty dvě, uloží se
 * jako nerozhodnutá dvojice a použije se první z nich. Běh se nezastavuje —
 * čekat na člověka uprostřed tisícovky produktů by nedávalo smysl. Až
 * uživatel vybere, uloží se to jako tvar kategorie a zbytek se dá přepsat
 * jedním tlačítkem.
 *
 * Dvojice vzniká jen tam, kde ještě žádná odpověď není: jedna na kategorii,
 * jazyk a druh textu. Jinak by se ptalo pořád dokola.
 */

export interface Trial {
  id: number;
  code: string;
  lang: string;
  field: string;
  category: string;
  variantA: string;
  variantB: string;
  chosen: string;
  createdAt: string;
  /** Název produktu ve zdrojovém jazyce — aby bylo poznat, o co jde */
  title?: string;
}

function toTrial(row: any): Trial {
  return {
    id: row.id, code: row.code, lang: row.lang, field: row.field,
    category: row.category ?? '', variantA: row.variant_a, variantB: row.variant_b,
    chosen: row.chosen ?? '', createdAt: row.created_at ?? '', title: row.title ?? ''
  };
}

/**
 * Má se u téhle kategorie ptát?
 *
 * Ne, když už je rozhodnuto, a ne, když dvojice čeká na odpověď — druhá
 * otázka na totéž by byla jen otravná.
 */
export function shouldAsk(lang: string, category: string, field: string): boolean {
  if (!category) return false;
  if (learnedStyle(lang, category, field)) return false;
  const open = getDb().prepare(
    `SELECT COUNT(*) AS n FROM ptrans_trials
     WHERE lang = ? AND category = ? AND field = ? AND chosen = ''`
  ).get(lang, category, field) as any;
  return (open?.n ?? 0) === 0;
}

export function openTrial(entry: {
  code: string; lang: string; field: string; category: string;
  variantA: string; variantB: string;
}): number {
  // Dvě stejné varianty nemá cenu předkládat
  if (entry.variantA.trim().toLowerCase() === entry.variantB.trim().toLowerCase()) return 0;
  const result = getDb().prepare(
    `INSERT INTO ptrans_trials (code, lang, field, category, variant_a, variant_b, created_at)
     VALUES (?,?,?,?,?,?,?)`
  ).run(entry.code, entry.lang, entry.field, entry.category,
    entry.variantA.trim(), entry.variantB.trim(), new Date().toISOString()) as any;
  return Number(result.lastInsertRowid);
}

export function listTrials(options: { lang?: string; includeDecided?: boolean } = {}): Trial[] {
  const where = [options.includeDecided ? '1=1' : `t.chosen = ''`];
  const params: any[] = [];
  if (options.lang && options.lang !== 'all') { where.push('t.lang = ?'); params.push(options.lang); }
  const rows = getDb().prepare(
    `SELECT t.*, p.title AS title FROM ptrans_trials t
     LEFT JOIN ptrans_products p ON p.code = t.code
     WHERE ${where.join(' AND ')}
     ORDER BY t.chosen = '' DESC, t.created_at DESC LIMIT 200`
  ).all(...params) as any[];
  return rows.map(toTrial);
}

export function countOpenTrials(): number {
  const row = getDb().prepare(`SELECT COUNT(*) AS n FROM ptrans_trials WHERE chosen = ''`).get() as any;
  return row?.n ?? 0;
}

/**
 * Uživatel vybral.
 *
 * Kromě vítěze se pamatuje i poražený — modelu se pak dá říct nejen „piš
 * takhle", ale i „takhle ne", což zabírá líp než samotná ukázka.
 */
export function decideTrial(id: number, pick: 'a' | 'b'): Trial | null {
  const d = getDb();
  const row = d.prepare('SELECT * FROM ptrans_trials WHERE id = ?').get(id) as any;
  if (!row) return null;

  const winner = pick === 'a' ? row.variant_a : row.variant_b;
  const loser = pick === 'a' ? row.variant_b : row.variant_a;
  d.prepare('UPDATE ptrans_trials SET chosen = ?, decided_at = ? WHERE id = ?')
    .run(pick, new Date().toISOString(), id);

  if (row.category) {
    saveStyle({
      lang: row.lang, category: row.category, kind: row.field,
      example: winner, rejected: loser
    });
  }
  return toTrial({ ...row, chosen: pick });
}

/** Kolik produktů v kategorii by se rozhodnutím dalo přepsat. */
export function affectedByTrial(id: number): { codes: string[]; category: string; lang: string; field: string } {
  const row = getDb().prepare('SELECT * FROM ptrans_trials WHERE id = ?').get(id) as any;
  if (!row?.category) return { codes: [], category: '', lang: '', field: '' };
  const codes = (getDb().prepare(
    'SELECT code FROM ptrans_products WHERE category = ? AND archived = 0'
  ).all(row.category) as any[]).map(r => r.code as string);
  return { codes, category: row.category, lang: row.lang, field: row.field };
}

export function dismissTrial(id: number): void {
  getDb().prepare('DELETE FROM ptrans_trials WHERE id = ?').run(id);
}
