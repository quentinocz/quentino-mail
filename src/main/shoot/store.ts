import crypto from 'crypto';
import { getDb } from '../db';
import type {
  Shoot, ShootPhoto, ShootOverlay, ShootGhost, ShootFix, ShootCrop, ShootSlot
} from '../../shared/types';

/**
 * Uložená focení.
 *
 * ## Proč se focení vůbec ukládá
 *
 * Produktové focení není jedna fotka, ale série, která musí vypadat stejně —
 * stejný výřez, stejné světlo, stejné nastavení. Když se ke zboží za týden
 * dokupuje další barva, musí se to nafotit do stejné řady. Bez uloženého
 * focení by se vodítka kreslila znovu od oka a nastavení na těle dohledávalo
 * z paměti, což znamená, že řada bude „skoro stejná" — a to je na e-shopu
 * vidět.
 *
 * Ukládá se proto všechno, co výsledný snímek určuje: vodítka, šablona,
 * nastavení fotoaparátu, cílová složka i korekce barev. Samotné fotky
 * zůstávají soubory na disku; v databázi je jen cesta k nim.
 */

export const SCHEMA = `
  CREATE TABLE IF NOT EXISTS shoot_sessions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    folder TEXT NOT NULL DEFAULT '',
    camera TEXT NOT NULL DEFAULT '',
    port TEXT NOT NULL DEFAULT '',
    format TEXT NOT NULL DEFAULT 'jpg',
    webp INTEGER NOT NULL DEFAULT 0,
    webp_quality INTEGER NOT NULL DEFAULT 82,
    overlay TEXT NOT NULL DEFAULT '[]',
    ghost TEXT NOT NULL DEFAULT '{}',
    settings TEXT NOT NULL DEFAULT '{}',
    fix TEXT NOT NULL DEFAULT '{}',
    crop TEXT NOT NULL DEFAULT '{}',
    plan TEXT NOT NULL DEFAULT '[]',
    reference TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS shoot_photos (
    id TEXT PRIMARY KEY,
    shoot_id TEXT NOT NULL,
    file TEXT NOT NULL DEFAULT '',
    raw TEXT NOT NULL DEFAULT '',
    webp TEXT NOT NULL DEFAULT '',
    width INTEGER NOT NULL DEFAULT 0,
    height INTEGER NOT NULL DEFAULT 0,
    bytes INTEGER NOT NULL DEFAULT 0,
    sort INTEGER NOT NULL DEFAULT 0,
    pick INTEGER NOT NULL DEFAULT 0,
    slot TEXT NOT NULL DEFAULT '',
    sharp REAL NOT NULL DEFAULT 0,
    clipped REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT ''
  );

  CREATE INDEX IF NOT EXISTS shoot_photos_shoot ON shoot_photos(shoot_id, sort);
`;

/**
 * Sloupce doplněné později.
 *
 * `CREATE TABLE IF NOT EXISTS` existující tabulku nezmění, takže komu
 * focení už jednou naskočilo, tomu by ořez ani ostrost nikdy nepřibyly —
 * a aplikace by spadla na „no such column" při prvním uložení.
 */
export const ALTERS = [
  "ALTER TABLE shoot_sessions ADD COLUMN crop TEXT NOT NULL DEFAULT '{}'",
  "ALTER TABLE shoot_sessions ADD COLUMN plan TEXT NOT NULL DEFAULT '[]'",
  "ALTER TABLE shoot_sessions ADD COLUMN reference TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE shoot_photos ADD COLUMN slot TEXT NOT NULL DEFAULT ''",
  'ALTER TABLE shoot_photos ADD COLUMN sharp REAL NOT NULL DEFAULT 0',
  'ALTER TABLE shoot_photos ADD COLUMN clipped REAL NOT NULL DEFAULT 0'
];

function now(): string {
  return new Date().toISOString();
}

function id(): string {
  return crypto.randomUUID();
}

function readJson<T>(text: string, fallback: T): T {
  try {
    const value = JSON.parse(text || '');
    return (value ?? fallback) as T;
  } catch {
    return fallback;
  }
}

type Row = {
  id: string; name: string; folder: string; camera: string; port: string;
  format: string; webp: number; webp_quality: number;
  overlay: string; ghost: string; settings: string; fix: string;
  crop: string; plan: string; reference: string;
  note: string; created_at: string; updated_at: string;
};

function toShoot(row: Row): Shoot {
  return {
    id: row.id,
    name: row.name,
    folder: row.folder,
    camera: row.camera,
    port: row.port,
    format: (row.format as Shoot['format']) || 'jpg',
    webp: !!row.webp,
    webpQuality: row.webp_quality || 82,
    overlay: readJson<ShootOverlay[]>(row.overlay, []),
    ghost: readJson<ShootGhost>(row.ghost, { file: '', opacity: 40, mirror: false }),
    settings: readJson<Record<string, string>>(row.settings, {}),
    fix: { ...blankFix(), ...readJson<Partial<ShootFix>>(row.fix, {}) },
    crop: { ...blankCrop(), ...readJson<Partial<ShootCrop>>(row.crop, {}) },
    plan: readJson<ShootSlot[]>(row.plan, []),
    reference: row.reference ?? '',
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    photos: 0
  };
}

export function blankFix(): ShootFix {
  return {
    on: false,
    // Vyvážení bílé podle klikem vybraného místa; prázdné = nepoužito
    white: '',
    exposure: 0,
    contrast: 0,
    saturation: 0,
    temperature: 0,
    /*
     * „Dočistit pozadí" zvedne světla nad prahem na čistou bílou. Práh je
     * úmyslně vysoko: níž by se spolu s pozadím vybělily i světlé látky,
     * a to je na kravatě z bílého hedvábí okamžitě vidět.
     */
    background: 0,
    backgroundLevel: 242,
    preset: '',
    zebra: false,
    /*
     * 250, ne 255. Kresba mizí dřív, než kanál dojede na maximum — na 250
     * už je v bílém hedvábí plocha bez struktury, kterou z fotky nikdo
     * nevytáhne. Hlásit až 255 znamená hlásit to pozdě.
     */
    zebraLevel: 250
  };
}

export function blankCrop(): ShootCrop {
  /*
   * Čtverec uprostřed na dvou třetinách obrazu. Na e-shopu je produktová
   * fotka čtvercová, takže volný ořez by znamenal nastavovat totéž pokaždé
   * znovu; a vycentrovaný rámeček je blíž k výsledku než nic.
   */
  return { on: false, ratio: '1:1', x: 1 / 6, y: 1 / 6, w: 2 / 3, h: 2 / 3 };
}

export function listShoots(): Shoot[] {
  const rows = getDb().prepare(
    'SELECT * FROM shoot_sessions ORDER BY datetime(updated_at) DESC'
  ).all() as Row[];
  const counts = getDb().prepare(
    'SELECT shoot_id, COUNT(*) AS n FROM shoot_photos GROUP BY shoot_id'
  ).all() as { shoot_id: string; n: number }[];
  const byId = new Map(counts.map(one => [one.shoot_id, one.n]));
  return rows.map(row => ({ ...toShoot(row), photos: byId.get(row.id) ?? 0 }));
}

export function getShoot(shootId: string): Shoot | null {
  const row = getDb().prepare('SELECT * FROM shoot_sessions WHERE id = ?').get(shootId) as Row | undefined;
  if (!row) return null;
  const count = getDb().prepare('SELECT COUNT(*) AS n FROM shoot_photos WHERE shoot_id = ?')
    .get(shootId) as { n: number };
  return { ...toShoot(row), photos: count?.n ?? 0 };
}

/**
 * Nové focení.
 *
 * Název dostane datum, protože focení stejného zboží se opakuje — „Kravaty
 * hedvábí" samo o sobě po půl roce neřekne, které z těch tří to je.
 */
export function newShoot(name: string, folder: string): Shoot {
  const stamp = now();
  const day = new Date().toLocaleDateString('cs-CZ');
  const title = (name || '').trim() || `Focení ${day}`;
  const fresh: Row = {
    id: id(), name: title, folder: folder || '', camera: '', port: '',
    format: 'jpg', webp: 0, webp_quality: 82,
    overlay: '[]', ghost: JSON.stringify({ file: '', opacity: 40, mirror: false }),
    settings: '{}', fix: JSON.stringify(blankFix()),
    crop: JSON.stringify(blankCrop()), plan: '[]', reference: '', note: '',
    created_at: stamp, updated_at: stamp
  };
  getDb().prepare(`
    INSERT INTO shoot_sessions
      (id, name, folder, camera, port, format, webp, webp_quality, overlay, ghost,
       settings, fix, crop, plan, reference, note, created_at, updated_at)
    VALUES (@id, @name, @folder, @camera, @port, @format, @webp, @webp_quality, @overlay, @ghost,
       @settings, @fix, @crop, @plan, @reference, @note, @created_at, @updated_at)
  `).run(fresh);
  return { ...toShoot(fresh), photos: 0 };
}

const FIELDS: Record<string, string> = {
  name: 'name', folder: 'folder', camera: 'camera', port: 'port',
  format: 'format', note: 'note', reference: 'reference'
};
const JSON_FIELDS: Record<string, string> = {
  overlay: 'overlay', ghost: 'ghost', settings: 'settings', fix: 'fix',
  crop: 'crop', plan: 'plan'
};

export function saveShoot(shootId: string, patch: Partial<Shoot>): Shoot | null {
  const had = getShoot(shootId);
  if (!had) return null;

  const sets: string[] = [];
  const values: any[] = [];
  for (const [key, column] of Object.entries(FIELDS)) {
    if ((patch as any)[key] === undefined) continue;
    sets.push(`${column} = ?`);
    values.push(String((patch as any)[key] ?? ''));
  }
  for (const [key, column] of Object.entries(JSON_FIELDS)) {
    if ((patch as any)[key] === undefined) continue;
    sets.push(`${column} = ?`);
    values.push(JSON.stringify((patch as any)[key]));
  }
  if (patch.webp !== undefined) { sets.push('webp = ?'); values.push(patch.webp ? 1 : 0); }
  if (patch.webpQuality !== undefined) {
    sets.push('webp_quality = ?');
    values.push(Math.max(1, Math.min(100, Math.round(patch.webpQuality))));
  }
  if (!sets.length) return had;

  sets.push('updated_at = ?');
  values.push(now(), shootId);
  getDb().prepare(`UPDATE shoot_sessions SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getShoot(shootId);
}

export function deleteShoot(shootId: string): boolean {
  getDb().prepare('DELETE FROM shoot_photos WHERE shoot_id = ?').run(shootId);
  getDb().prepare('DELETE FROM shoot_sessions WHERE id = ?').run(shootId);
  return true;
}

/* ---------- fotky ---------- */

type PhotoRow = {
  id: string; shoot_id: string; file: string; raw: string; webp: string;
  width: number; height: number; bytes: number; sort: number; pick: number;
  slot: string; sharp: number; clipped: number; created_at: string;
};

function toPhoto(row: PhotoRow): ShootPhoto {
  return {
    id: row.id, shootId: row.shoot_id, file: row.file, raw: row.raw, webp: row.webp,
    width: row.width, height: row.height, bytes: row.bytes,
    sort: row.sort, pick: !!row.pick,
    slot: row.slot ?? '', sharp: row.sharp ?? 0, clipped: row.clipped ?? 0,
    createdAt: row.created_at
  };
}

export function listPhotos(shootId: string): ShootPhoto[] {
  const rows = getDb().prepare(
    'SELECT * FROM shoot_photos WHERE shoot_id = ? ORDER BY sort, datetime(created_at)'
  ).all(shootId) as PhotoRow[];
  return rows.map(toPhoto);
}

export function addPhoto(shootId: string, photo: Partial<ShootPhoto>): ShootPhoto {
  const next = getDb().prepare(
    'SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM shoot_photos WHERE shoot_id = ?'
  ).get(shootId) as { n: number };
  const row: PhotoRow = {
    id: id(), shoot_id: shootId,
    file: photo.file ?? '', raw: photo.raw ?? '', webp: photo.webp ?? '',
    width: photo.width ?? 0, height: photo.height ?? 0, bytes: photo.bytes ?? 0,
    sort: next?.n ?? 1, pick: photo.pick ? 1 : 0,
    slot: photo.slot ?? '', sharp: photo.sharp ?? 0, clipped: photo.clipped ?? 0,
    created_at: now()
  };
  getDb().prepare(`
    INSERT INTO shoot_photos
      (id, shoot_id, file, raw, webp, width, height, bytes, sort, pick, slot, sharp, clipped, created_at)
    VALUES (@id, @shoot_id, @file, @raw, @webp, @width, @height, @bytes, @sort, @pick,
       @slot, @sharp, @clipped, @created_at)
  `).run(row);
  touch(shootId);
  return toPhoto(row);
}

export function getPhoto(photoId: string): ShootPhoto | null {
  const row = getDb().prepare('SELECT * FROM shoot_photos WHERE id = ?').get(photoId) as PhotoRow | undefined;
  return row ? toPhoto(row) : null;
}

export function savePhoto(photoId: string, patch: Partial<ShootPhoto>): ShootPhoto | null {
  const had = getPhoto(photoId);
  if (!had) return null;
  const sets: string[] = [];
  const values: any[] = [];
  if (patch.webp !== undefined) { sets.push('webp = ?'); values.push(patch.webp); }
  if (patch.pick !== undefined) { sets.push('pick = ?'); values.push(patch.pick ? 1 : 0); }
  if (patch.sort !== undefined) { sets.push('sort = ?'); values.push(patch.sort); }
  if (patch.width !== undefined) { sets.push('width = ?'); values.push(patch.width); }
  if (patch.height !== undefined) { sets.push('height = ?'); values.push(patch.height); }
  if (patch.slot !== undefined) { sets.push('slot = ?'); values.push(patch.slot); }
  if (patch.sharp !== undefined) { sets.push('sharp = ?'); values.push(patch.sharp); }
  if (patch.clipped !== undefined) { sets.push('clipped = ?'); values.push(patch.clipped); }
  if (!sets.length) return had;
  values.push(photoId);
  getDb().prepare(`UPDATE shoot_photos SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  touch(had.shootId);
  return getPhoto(photoId);
}

export function dropPhoto(photoId: string): ShootPhoto | null {
  const had = getPhoto(photoId);
  if (!had) return null;
  getDb().prepare('DELETE FROM shoot_photos WHERE id = ?').run(photoId);
  touch(had.shootId);
  return had;
}

function touch(shootId: string): void {
  getDb().prepare('UPDATE shoot_sessions SET updated_at = ? WHERE id = ?').run(now(), shootId);
}

export const __test = { toShoot, toPhoto, blankFix, blankCrop };
