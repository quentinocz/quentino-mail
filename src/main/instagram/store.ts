import { getDb, getSetting, setSetting } from '../db';
import { encrypt, decrypt } from '../secure';
import { DEFAULT_MARKETS } from './schema';
import type {
  IgAccount, IgBrand, IgMarket, IgPost, IgCaption, IgMediaItem, IgSourcePost, IgJob, IgConnection
} from '../../shared/types';

/* ---------- Připojení (Meta aplikace + úložiště médií) ---------- */

export interface IgSecrets {
  appId: string;
  appSecret: string;
  storageUrl: string;
  storageBucket: string;
  storageKey: string;
  callbackUrl: string;
}

export function getSecrets(): IgSecrets {
  const enc = getSetting('igAppSecret', '')!;
  const skey = getSetting('igStorageKey', '')!;
  return {
    appId: getSetting('igAppId', '')!,
    appSecret: enc ? decrypt(enc) : '',
    storageUrl: (getSetting('igStorageUrl', '')! || '').replace(/\/+$/, ''),
    storageBucket: getSetting('igStorageBucket', 'instagram')!,
    storageKey: skey ? decrypt(skey) : '',
    callbackUrl: getSetting('igCallbackUrl', '')!
  };
}

export function saveSecrets(p: Partial<IgSecrets>): void {
  if (p.appId !== undefined) setSetting('igAppId', p.appId.trim());
  if (p.appSecret !== undefined) setSetting('igAppSecret', p.appSecret ? encrypt(p.appSecret.trim()) : '');
  if (p.storageUrl !== undefined) setSetting('igStorageUrl', p.storageUrl.trim().replace(/\/+$/, ''));
  if (p.storageBucket !== undefined) setSetting('igStorageBucket', p.storageBucket.trim() || 'instagram');
  if (p.storageKey !== undefined) setSetting('igStorageKey', p.storageKey ? encrypt(p.storageKey.trim()) : '');
  if (p.callbackUrl !== undefined) setSetting('igCallbackUrl', p.callbackUrl.trim());
}

export function connectionState(): IgConnection {
  const s = getSecrets();
  return {
    hasAppId: !!s.appId,
    hasAppSecret: !!s.appSecret,
    appId: s.appId,
    callbackUrl: s.callbackUrl,
    storage: { url: s.storageUrl, bucket: s.storageBucket, hasKey: !!s.storageKey },
    autoSync: getSetting('igAutoSync', '1') === '1'
  };
}

/* ---------- Účty ---------- */

function rowToAccount(r: any): IgAccount {
  return {
    id: r.id,
    igUserId: r.ig_user_id,
    username: r.username,
    lang: r.lang,
    color: r.color,
    isSource: !!r.is_source,
    tokenExpires: r.token_expires,
    connectedAt: r.connected_at,
    lastError: r.last_error ?? null
  };
}

export function listAccounts(): IgAccount[] {
  const rows = getDb().prepare('SELECT * FROM ig_accounts ORDER BY is_source DESC, lang').all() as any[];
  return rows.map(rowToAccount);
}

export function sourceAccount(): IgAccount | null {
  const r = getDb().prepare('SELECT * FROM ig_accounts WHERE is_source = 1 LIMIT 1').get() as any;
  return r ? rowToAccount(r) : null;
}

export function accountForLang(lang: string): IgAccount | null {
  const r = getDb().prepare('SELECT * FROM ig_accounts WHERE lang = ? LIMIT 1').get(lang) as any;
  return r ? rowToAccount(r) : null;
}

export function saveAccountToken(a: {
  igUserId: string; username: string; lang: string; token: string; expires: string; isSource?: boolean;
}): IgAccount {
  const d = getDb();
  const market = listMarkets().find(m => m.lang === a.lang);
  const color = market?.color ?? '#7c5cff';
  // Když se už připojený účet připojuje znovu, příznak zdroje si drží
  const existing = d.prepare('SELECT is_source FROM ig_accounts WHERE ig_user_id = ?').get(a.igUserId) as any;
  const isSource = existing ? !!existing.is_source : (a.isSource ?? a.lang === 'CS');
  d.prepare(
    `INSERT INTO ig_accounts (ig_user_id, username, lang, color, is_source, token_enc, token_expires, connected_at, last_error)
     VALUES (?,?,?,?,?,?,?,datetime('now'),NULL)
     ON CONFLICT(ig_user_id) DO UPDATE SET
       username = excluded.username, lang = excluded.lang, color = excluded.color,
       is_source = excluded.is_source, token_enc = excluded.token_enc,
       token_expires = excluded.token_expires, connected_at = datetime('now'), last_error = NULL`
  ).run(a.igUserId, a.username, a.lang, color, isSource ? 1 : 0, encrypt(a.token), a.expires);
  // Zdrojový účet může být jen jeden
  if (isSource) d.prepare('UPDATE ig_accounts SET is_source = 0 WHERE ig_user_id != ?').run(a.igUserId);
  return accountForLang(a.lang)!;
}

export function tokenFor(accountId: number): string {
  const r = getDb().prepare('SELECT token_enc, token_expires FROM ig_accounts WHERE id = ?').get(accountId) as any;
  if (!r || !r.token_enc) throw new Error('Účet nemá platný přístup — připoj ho znovu.');
  if (r.token_expires && new Date(r.token_expires) < new Date()) {
    throw new Error('Přístup k účtu vypršel — připoj ho znovu.');
  }
  return decrypt(r.token_enc);
}

export function setAccountToken(accountId: number, token: string, expires: string): void {
  getDb().prepare('UPDATE ig_accounts SET token_enc = ?, token_expires = ?, last_error = NULL WHERE id = ?')
    .run(encrypt(token), expires, accountId);
}

export function setAccountError(accountId: number, message: string | null): void {
  getDb().prepare('UPDATE ig_accounts SET last_error = ? WHERE id = ?').run(message, accountId);
}

export function deleteAccount(id: number): void {
  getDb().prepare('DELETE FROM ig_accounts WHERE id = ?').run(id);
}

export function setSourceAccount(id: number): void {
  const d = getDb();
  d.prepare('UPDATE ig_accounts SET is_source = 0').run();
  d.prepare('UPDATE ig_accounts SET is_source = 1 WHERE id = ?').run(id);
}

/* ---------- Trhy ---------- */

export function listMarkets(): IgMarket[] {
  const d = getDb();
  const count = (d.prepare('SELECT COUNT(*) AS c FROM ig_markets').get() as any).c as number;
  if (count === 0) {
    const ins = d.prepare('INSERT INTO ig_markets (lang, label, note, tags, color, enabled, ord) VALUES (?,?,?,?,?,?,?)');
    DEFAULT_MARKETS.forEach((m, i) => ins.run(m.lang, m.label, m.note, m.tags, m.color, 1, i));
  }
  const rows = d.prepare('SELECT * FROM ig_markets ORDER BY ord, lang').all() as any[];
  return rows.map(r => ({
    lang: r.lang, label: r.label, note: r.note, tags: r.tags, color: r.color, enabled: !!r.enabled
  }));
}

export function saveMarket(m: IgMarket): IgMarket[] {
  const d = getDb();
  d.prepare(
    `INSERT INTO ig_markets (lang, label, note, tags, color, enabled, ord)
     VALUES (?,?,?,?,?,?,(SELECT COALESCE(MAX(ord)+1,0) FROM ig_markets))
     ON CONFLICT(lang) DO UPDATE SET label = excluded.label, note = excluded.note,
       tags = excluded.tags, color = excluded.color, enabled = excluded.enabled`
  ).run(m.lang.toUpperCase(), m.label, m.note, m.tags, m.color, m.enabled ? 1 : 0);
  return listMarkets();
}

export function deleteMarket(lang: string): IgMarket[] {
  getDb().prepare('DELETE FROM ig_markets WHERE lang = ?').run(lang);
  return listMarkets();
}

/* ---------- Profil značky ---------- */

const DEFAULT_BRAND: IgBrand = {
  context: 'Quentino — český výrobce a prodejce. Doplň, čím se značka zabývá, pro koho tvoří a čím se liší.',
  loveOn: false,
  love: '',
  tones: ['přátelský', 'věcný', 'bez patosu'],
  avoid: 'Superlativy bez obsahu, klišé typu „nenechte si ujít", vykřičníky na konci každé věty, emoji v každé větě.',
  rules: 'Bez nabubřelých frází. Konkrétní detail místo obecného chvalozpěvu. Hashtagy až na konec, oddělené prázdným řádkem.',
  variants: 2,
  useKnowledge: false
};

export function getBrand(): IgBrand {
  const raw = getSetting('igBrand', '');
  if (!raw) return { ...DEFAULT_BRAND };
  try {
    return { ...DEFAULT_BRAND, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_BRAND };
  }
}

export function saveBrand(b: Partial<IgBrand>): IgBrand {
  const next = { ...getBrand(), ...b };
  next.variants = Math.min(4, Math.max(1, Math.round(next.variants || 1)));
  setSetting('igBrand', JSON.stringify(next));
  return next;
}

/* ---------- Zdrojové příspěvky ---------- */

export function upsertSourcePosts(items: any[]): number {
  const d = getDb();
  const stmt = d.prepare(
    `INSERT INTO ig_source_posts (ig_media_id, media_type, permalink, caption, posted_at, like_count, comment_count, children_json)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(ig_media_id) DO UPDATE SET
       caption = excluded.caption, like_count = excluded.like_count,
       comment_count = excluded.comment_count, children_json = excluded.children_json`
  );
  const tx = d.transaction((rows: any[]) => {
    for (const m of rows) {
      stmt.run(
        m.id, m.media_type ?? 'IMAGE', m.permalink ?? '', m.caption ?? '', m.timestamp ?? '',
        m.like_count ?? 0, m.comments_count ?? 0, JSON.stringify(m.children?.data ?? [])
      );
    }
  });
  tx(items);
  return items.length;
}

export function newestSourceDate(): string | null {
  const r = getDb().prepare('SELECT posted_at FROM ig_source_posts ORDER BY posted_at DESC LIMIT 1').get() as any;
  return r?.posted_at ?? null;
}

/** Feed pro rozhraní i s tím, které trhy už příspěvek dostaly. */
export function listSourcePosts(limit = 120, offset = 0): IgSourcePost[] {
  const d = getDb();
  const rows = d.prepare(
    'SELECT * FROM ig_source_posts ORDER BY posted_at DESC LIMIT ? OFFSET ?'
  ).all(limit, offset) as any[];
  if (rows.length === 0) return [];

  const states = d.prepare(
    `SELECT p.source_post_id AS sid, c.lang AS lang, c.status AS status,
            (SELECT state FROM ig_jobs j WHERE j.caption_id = c.id ORDER BY j.id DESC LIMIT 1) AS job
     FROM ig_posts p JOIN ig_captions c ON c.post_id = p.id
     WHERE p.source_post_id IS NOT NULL`
  ).all() as any[];

  const byPost = new Map<number, { done: string[]; pending: string[] }>();
  for (const s of states) {
    const entry = byPost.get(s.sid) ?? { done: [], pending: [] };
    if (s.status === 'published' || s.job === 'done') entry.done.push(s.lang);
    else entry.pending.push(s.lang);
    byPost.set(s.sid, entry);
  }

  return rows.map(r => ({
    id: r.id,
    igMediaId: r.ig_media_id,
    mediaType: r.media_type,
    permalink: r.permalink,
    caption: r.caption,
    postedAt: r.posted_at,
    likeCount: r.like_count,
    commentCount: r.comment_count,
    childCount: (() => { try { return JSON.parse(r.children_json || '[]').length; } catch { return 0; } })(),
    done: byPost.get(r.id)?.done ?? [],
    pending: byPost.get(r.id)?.pending ?? []
  }));
}

export function sourcePost(id: number): any {
  return getDb().prepare('SELECT * FROM ig_source_posts WHERE id = ?').get(id) as any;
}

/* ---------- Příspěvky, média, popisky ---------- */

export function createPost(p: { kind: 'new' | 'source'; sourcePostId?: number | null; brief?: string; mediaNote?: string }): number {
  const r = getDb().prepare(
    'INSERT INTO ig_posts (kind, source_post_id, brief, media_note) VALUES (?,?,?,?)'
  ).run(p.kind, p.sourcePostId ?? null, p.brief ?? '', p.mediaNote ?? '');
  return Number(r.lastInsertRowid);
}

export function updatePost(id: number, p: { brief?: string; mediaNote?: string }): void {
  if (p.brief !== undefined) getDb().prepare('UPDATE ig_posts SET brief = ? WHERE id = ?').run(p.brief, id);
  if (p.mediaNote !== undefined) getDb().prepare('UPDATE ig_posts SET media_note = ? WHERE id = ?').run(p.mediaNote, id);
}

export function setPostMedia(postId: number, media: IgMediaItem[]): void {
  const d = getDb();
  const tx = d.transaction(() => {
    d.prepare('DELETE FROM ig_post_media WHERE post_id = ?').run(postId);
    const ins = d.prepare(
      `INSERT INTO ig_post_media (post_id, position, path, mime, is_video, width, height, cover_offset, source_url)
       VALUES (?,?,?,?,?,?,?,?,?)`
    );
    media.forEach((m, i) => ins.run(
      postId, i, m.path ?? '', m.mime ?? '', m.isVideo ? 1 : 0,
      m.width ?? null, m.height ?? null, m.coverOffset ?? null, m.sourceUrl ?? null
    ));
  });
  tx();
}

export function postMedia(postId: number): any[] {
  return getDb().prepare('SELECT * FROM ig_post_media WHERE post_id = ? ORDER BY position').all(postId) as any[];
}

export function setMediaPublicUrl(mediaId: number, url: string | null, key: string | null): void {
  getDb().prepare('UPDATE ig_post_media SET public_url = ?, storage_key = ? WHERE id = ?').run(url, key, mediaId);
}

export function saveCaptions(postId: number, captions: { lang: string; variants: string[] }[]): void {
  const d = getDb();
  const stmt = d.prepare(
    `INSERT INTO ig_captions (post_id, lang, variants_json, chosen, status, updated_at)
     VALUES (?,?,?,0,'draft',datetime('now'))
     ON CONFLICT(post_id, lang) DO UPDATE SET
       variants_json = excluded.variants_json, chosen = 0, edited = NULL,
       status = 'draft', updated_at = datetime('now')
     WHERE ig_captions.status != 'published'`
  );
  const tx = d.transaction(() => {
    for (const c of captions) stmt.run(postId, c.lang, JSON.stringify(c.variants));
  });
  tx();
}

export function updateCaption(id: number, p: { chosen?: number; edited?: string | null; status?: string }): void {
  const d = getDb();
  if (p.chosen !== undefined) d.prepare('UPDATE ig_captions SET chosen = ?, edited = NULL, updated_at = datetime(\'now\') WHERE id = ?').run(p.chosen, id);
  if (p.edited !== undefined) d.prepare('UPDATE ig_captions SET edited = ?, updated_at = datetime(\'now\') WHERE id = ?').run(p.edited, id);
  if (p.status !== undefined) d.prepare('UPDATE ig_captions SET status = ? WHERE id = ?').run(p.status, id);
}

export function captionText(row: any): string {
  if (row.edited != null && String(row.edited).trim() !== '') return String(row.edited);
  try {
    const v = JSON.parse(row.variants_json || '[]');
    return v[row.chosen] ?? v[0] ?? '';
  } catch {
    return '';
  }
}

function rowToCaption(r: any): IgCaption {
  let variants: string[] = [];
  try { variants = JSON.parse(r.variants_json || '[]'); } catch { /* prázdné */ }
  return {
    id: r.id, lang: r.lang, variants, chosen: r.chosen,
    text: captionText(r), status: r.status, edited: r.edited != null && String(r.edited).trim() !== ''
  };
}

export function getPost(id: number): IgPost | null {
  const d = getDb();
  const p = d.prepare('SELECT * FROM ig_posts WHERE id = ?').get(id) as any;
  if (!p) return null;
  const media = postMedia(id).map(m => ({
    id: m.id, path: m.path, mime: m.mime, isVideo: !!m.is_video,
    width: m.width, height: m.height, coverOffset: m.cover_offset, sourceUrl: m.source_url
  }));
  const caps = (d.prepare('SELECT * FROM ig_captions WHERE post_id = ? ORDER BY lang').all(id) as any[]).map(rowToCaption);
  const src = p.source_post_id ? sourcePost(p.source_post_id) : null;
  return {
    id: p.id, kind: p.kind, sourcePostId: p.source_post_id, brief: p.brief, mediaNote: p.media_note,
    createdAt: p.created_at, media, captions: caps,
    sourceCaption: src?.caption ?? '', sourcePermalink: src?.permalink ?? ''
  };
}

export function deletePost(id: number): void {
  getDb().prepare('DELETE FROM ig_posts WHERE id = ?').run(id);
}

export function captionRow(id: number): any {
  return getDb().prepare('SELECT * FROM ig_captions WHERE id = ?').get(id) as any;
}

/* ---------- Fronta publikací ---------- */

export function enqueue(captionId: number, accountId: number, at: string): number {
  const r = getDb().prepare(
    `INSERT INTO ig_jobs (caption_id, account_id, state, scheduled_at) VALUES (?,?,'scheduled',?)`
  ).run(captionId, accountId, at);
  return Number(r.lastInsertRowid);
}

export function dueJobs(limit = 3): any[] {
  return getDb().prepare(
    `SELECT * FROM ig_jobs WHERE state = 'scheduled' AND scheduled_at <= ? ORDER BY scheduled_at LIMIT ?`
  ).all(new Date().toISOString(), limit) as any[];
}

export function setJobState(id: number, patch: Record<string, unknown>): void {
  const keys = Object.keys(patch);
  if (keys.length === 0) return;
  const sql = `UPDATE ig_jobs SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`;
  getDb().prepare(sql).run(...keys.map(k => patch[k] as any), id);
}

export function listJobs(limit = 80): IgJob[] {
  const rows = getDb().prepare(
    `SELECT j.*, c.lang AS lang, c.post_id AS post_id, c.variants_json, c.chosen, c.edited,
            a.username AS username, a.color AS color
     FROM ig_jobs j
     JOIN ig_captions c ON c.id = j.caption_id
     JOIN ig_accounts a ON a.id = j.account_id
     ORDER BY CASE j.state WHEN 'publishing' THEN 0 WHEN 'scheduled' THEN 1 ELSE 2 END,
              j.scheduled_at DESC LIMIT ?`
  ).all(limit) as any[];
  return rows.map(r => ({
    id: r.id,
    captionId: r.caption_id,
    postId: r.post_id,
    lang: r.lang,
    username: r.username,
    color: r.color,
    state: r.state,
    scheduledAt: r.scheduled_at,
    finishedAt: r.finished_at,
    permalink: r.permalink,
    error: r.error,
    preview: captionText(r).slice(0, 160)
  }));
}

export function cancelJob(id: number): void {
  getDb().prepare(`DELETE FROM ig_jobs WHERE id = ? AND state IN ('scheduled','failed')`).run(id);
}

export function retryJob(id: number): void {
  getDb().prepare(
    `UPDATE ig_jobs SET state = 'scheduled', error = NULL, scheduled_at = ? WHERE id = ? AND state = 'failed'`
  ).run(new Date().toISOString(), id);
}
