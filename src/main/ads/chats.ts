/**
 * Rozhovory s poradcem — uložené a sdílené mezi Macy.
 *
 * Patrik chce, aby si poradce pamatoval: rozhovor rozjetý ráno na jednom
 * Macu má jít dokončit odpoledne na jiném. Každý Mac zapisuje do sdílené
 * složky svůj soubor (`rozhovory-<mac>.json`) se všemi rozhovory, které
 * zná, a čte soubory ostatních. Tentýž rozhovor vyhraje novější verze —
 * dva Macy tak nikdy nepíšou do jednoho souboru a nic se nepřepíše
 * napůl. Smazání je záznam „smazáno" (jinak by ho jiný Mac vrátil).
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getDb, getSetting } from '../db';
import { deviceId } from '../device';
import type { AdsChat, AdsChatSummary, AdsChatTurn } from '../../shared/ads';

const toChat = (row: any): AdsChat => ({
  id: row.id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at,
  turns: (() => { try { return JSON.parse(row.turns_json); } catch { return []; } })()
});

export function listChats(): AdsChatSummary[] {
  return (getDb().prepare('SELECT * FROM ads_chats WHERE deleted = 0 ORDER BY updated_at DESC LIMIT 100').all() as any[])
    .map(row => { const c = toChat(row); return { id: c.id, title: c.title, updatedAt: c.updatedAt, turns: c.turns.length }; });
}

export function getChat(id: string): AdsChat | null {
  const row = getDb().prepare('SELECT * FROM ads_chats WHERE id = ? AND deleted = 0').get(id);
  return row ? toChat(row) : null;
}

function write(chat: AdsChat, deleted = false): void {
  getDb().prepare(`
    INSERT INTO ads_chats (id, title, turns_json, created_at, updated_at, deleted)
    VALUES (@id, @title, @turns, @createdAt, @updatedAt, @deleted)
    ON CONFLICT(id) DO UPDATE SET title = excluded.title, turns_json = excluded.turns_json,
      updated_at = excluded.updated_at, deleted = excluded.deleted
    WHERE excluded.updated_at >= ads_chats.updated_at
  `).run({ ...chat, turns: JSON.stringify(chat.turns), deleted: deleted ? 1 : 0 });
}

/**
 * Razítko nové verze: teď, ale vždy novější než ta dosavadní. Jiný Mac
 * může mít hodiny o kus napřed — bez toho by se smazání nebo přejmenování
 * jeho rozhovoru tiše neuložilo (starší razítko prohraje).
 */
function stamp(prev: string): string {
  const now = Date.now();
  const before = Date.parse(prev || '') || 0;
  return new Date(Math.max(now, before + 1)).toISOString();
}

/** Název z první otázky — krátký, ať se vejde do seznamu */
function titleOf(question: string): string {
  const t = question.replace(/\s+/g, ' ').trim();
  return t.length > 60 ? `${t.slice(0, 57).replace(/\s+\S*$/, '')}…` : t;
}

/** Nový rozhovor, nebo pokračování existujícího */
export function startChat(id: string | null | undefined, question: string): AdsChat {
  const existing = id ? getChat(id) : null;
  if (existing) return existing;
  const at = new Date().toISOString();
  return { id: crypto.randomUUID(), title: titleOf(question), turns: [], createdAt: at, updatedAt: at };
}

export function saveChat(chat: AdsChat, turns: AdsChatTurn[]): AdsChat {
  const next = { ...chat, turns, updatedAt: stamp(getChat(chat.id)?.updatedAt ?? chat.updatedAt) };
  write(next);
  shareSoon();
  return next;
}

export function renameChat(id: string, title: string): void {
  const c = getChat(id);
  if (!c) return;
  write({ ...c, title: title.trim().slice(0, 80) || c.title, updatedAt: stamp(c.updatedAt) });
  shareSoon();
}

export function deleteChat(id: string): void {
  const c = getChat(id);
  if (!c) return;
  write({ ...c, turns: [], updatedAt: stamp(c.updatedAt) }, true);
  shareSoon();
}

/* ---------- sdílená složka ---------- */

function sharedDir(): string | null {
  if (getSetting('syncEnabled', '0') !== '1') return null;
  const folder = (getSetting('syncFolder', '') || '').trim();
  if (!folder || !fs.existsSync(folder)) return null;
  const dir = path.join(folder, 'reklamy');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { return null; }
  return dir;
}

let timer: NodeJS.Timeout | null = null;
function shareSoon(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; try { shareChats(); } catch { /* příště */ } }, 1500);
}

/** Převzít rozhovory z ostatních Maců a zapsat svoje. Vrací true, když něco přišlo. */
export function shareChats(): boolean {
  const dir = sharedDir();
  if (!dir) return false;
  const d = getDb();
  const mine = `rozhovory-${deviceId().slice(0, 8)}.json`;
  let changed = false;
  let names: string[] = [];
  try { names = fs.readdirSync(dir).filter(n => /^rozhovory-.+\.json$/.test(n) && n !== mine); } catch { names = []; }
  for (const name of names) {
    let json: any = null;
    try { json = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { continue; }
    for (const c of Array.isArray(json?.chats) ? json.chats : []) {
      if (!c?.id || !c.updatedAt) continue;
      const have = d.prepare('SELECT updated_at FROM ads_chats WHERE id = ?').get(c.id) as any;
      if (have && have.updated_at >= c.updatedAt) continue;
      write({ id: c.id, title: String(c.title ?? ''), turns: Array.isArray(c.turns) ? c.turns : [],
        createdAt: String(c.createdAt ?? c.updatedAt), updatedAt: c.updatedAt }, !!c.deleted);
      changed = true;
    }
  }
  const all = (d.prepare('SELECT * FROM ads_chats ORDER BY updated_at DESC LIMIT 200').all() as any[])
    .map(row => ({ ...toChat(row), deleted: !!row.deleted }));
  const file = path.join(dir, mine);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ app: 'quentino-reklamy', chats: all }), 'utf8');
    fs.renameSync(tmp, file);
  } catch { /* složka příště */ }
  return changed;
}
