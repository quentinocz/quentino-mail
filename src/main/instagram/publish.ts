/**
 * Odbavení fronty: příprava médií, publikace a úklid.
 *
 * Fronta má stavy `scheduled` → `publishing` → `done` / `failed`. Běží vždy
 * jen jedna položka, protože Meta na jednom účtu neschválí dva kontejnery
 * naráz a při chybě je pak vidět, čeho se týkala.
 */
import { BrowserWindow } from 'electron';
import { getDb } from '../db';
import * as store from './store';
import * as graph from './graph';
import * as media from './media';

function emit(payload: unknown = {}) {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('ig:changed', payload);
}

/* ---------- Příprava médií ---------- */

/**
 * Z každé položky příspěvku udělá veřejnou adresu, kterou si Meta stáhne.
 *
 * - soubor z disku → nahraje se do úložiště,
 * - médium převzaté z vlastního účtu → přímo z Instagram CDN, adresa se
 *   čte až teď, protože ty starší vyprší.
 */
async function resolveMedia(postId: number, sourceToken: string | null): Promise<graph.GraphMedia[]> {
  const rows = store.postMedia(postId);
  if (rows.length === 0) throw new Error('Příspěvek nemá žádná média.');

  const out: graph.GraphMedia[] = [];
  for (const row of rows) {
    const isVideo = !!row.is_video;

    if (row.source_url) {
      const igId = String(row.source_url).replace(/^ig:/, '');
      if (!sourceToken) throw new Error('Není připojený zdrojový účet, ze kterého médium pochází.');
      let url = '';
      try {
        const info = await graph.mediaUrls(igId, sourceToken);
        url = info.media_url ?? info.thumbnail_url ?? '';
      } catch (e: any) {
        throw new Error(`Médium z původního příspěvku se nepodařilo načíst: ${e.message}`);
      }
      if (!url) throw new Error('Původní příspěvek nemá dostupné médium.');
      out.push({ publicUrl: url, isVideo, coverOffset: row.cover_offset });
      continue;
    }

    if (row.public_url) {
      out.push({ publicUrl: row.public_url, isVideo, coverOffset: row.cover_offset });
      continue;
    }

    const buf = media.readFile(row.path);
    const key = `posts/${postId}/${row.id}-${Date.now()}.${(row.mime.split('/')[1] ?? 'bin').replace(/[^a-z0-9]/gi, '')}`;
    const up = await media.upload(buf, key, row.mime);
    store.setMediaPublicUrl(row.id, up.publicUrl, up.key);
    out.push({ publicUrl: up.publicUrl, isVideo, coverOffset: row.cover_offset });
  }
  return out;
}

/** Nahraná média se po vyřízení všech front smažou — Instagram už kopii má. */
async function cleanupPostMedia(postId: number): Promise<void> {
  const d = getDb();
  const open = d.prepare(
    `SELECT COUNT(*) AS c FROM ig_jobs j JOIN ig_captions c ON c.id = j.caption_id
     WHERE c.post_id = ? AND j.state IN ('scheduled','publishing')`
  ).get(postId) as any;
  if (open.c > 0) return;

  for (const row of store.postMedia(postId)) {
    if (!row.storage_key) continue;
    await media.remove(row.storage_key);
    store.setMediaPublicUrl(row.id, null, null);
  }
}

/* ---------- Jedna položka fronty ---------- */

export async function runJob(jobId: number): Promise<void> {
  const d = getDb();
  const job = d.prepare('SELECT * FROM ig_jobs WHERE id = ?').get(jobId) as any;
  if (!job) return;

  const caption = store.captionRow(job.caption_id);
  if (!caption) {
    store.setJobState(jobId, { state: 'failed', error: 'Popisek už neexistuje.', finished_at: new Date().toISOString() });
    emit();
    return;
  }

  store.setJobState(jobId, { state: 'publishing', started_at: new Date().toISOString(), attempts: (job.attempts ?? 0) + 1 });
  emit();

  try {
    const account = store.listAccounts().find(a => a.id === job.account_id);
    if (!account) throw new Error('Cílový účet už není připojený.');

    const token = store.tokenFor(account.id);
    const source = store.sourceAccount();
    let sourceToken: string | null = null;
    try { sourceToken = source ? store.tokenFor(source.id) : null; } catch { sourceToken = null; }

    const items = await resolveMedia(caption.post_id, sourceToken);
    const text = store.captionText(caption);

    const result = await graph.publish(account.igUserId, token, text, items);

    store.setJobState(jobId, {
      state: 'done',
      container_id: result.containerId,
      ig_media_id: result.igMediaId,
      permalink: result.permalink,
      error: null,
      finished_at: new Date().toISOString()
    });
    store.updateCaption(caption.id, { status: 'published' });
    store.setAccountError(account.id, null);
  } catch (e: any) {
    store.setJobState(jobId, {
      state: 'failed',
      error: e?.message ?? String(e),
      finished_at: new Date().toISOString()
    });
  } finally {
    try { await cleanupPostMedia(caption.post_id); } catch { /* úklid není kritický */ }
    emit();
  }
}

let queueRunning = false;

export async function processQueue(): Promise<void> {
  if (queueRunning) return;
  queueRunning = true;
  try {
    for (const job of store.dueJobs(3)) {
      await runJob(job.id);
    }
  } finally {
    queueRunning = false;
  }
}

/** Zařadí popisek na účet odpovídajícího trhu. `at` prázdné = hned. */
export function schedule(captionId: number, at?: string | null): number {
  const caption = store.captionRow(captionId);
  if (!caption) throw new Error('Popisek nenalezen.');
  const account = store.accountForLang(caption.lang);
  if (!account) throw new Error(`Pro trh ${caption.lang} není připojený žádný účet.`);

  const text = store.captionText(caption);
  graph.validateCaption(text);

  const when = at && at.trim() ? new Date(at).toISOString() : new Date().toISOString();
  const id = store.enqueue(captionId, account.id, when);
  store.updateCaption(captionId, { status: 'approved' });
  emit();
  if (!at || new Date(when) <= new Date()) setTimeout(() => processQueue().catch(() => {}), 200);
  return id;
}

/* ---------- Synchronizace zdrojového účtu ---------- */

export async function syncSource(full = false): Promise<number> {
  const source = store.sourceAccount();
  if (!source) throw new Error('Není připojený zdrojový účet.');
  const token = store.tokenFor(source.id);
  const since = full ? null : store.newestSourceDate();
  const items = await graph.fetchHistory(source.igUserId, token, since);
  if (items.length) store.upsertSourcePosts(items);
  emit();
  return items.length;
}

/* ---------- Obnova tokenů ---------- */

/** Tokeny platí 60 dní; obnovují se, když zbývá míň než 20. */
export async function refreshTokens(force = false): Promise<{ refreshed: number; failed: string[] }> {
  const failed: string[] = [];
  let refreshed = 0;
  const limit = Date.now() + 20 * 864e5;

  for (const account of store.listAccounts()) {
    const expires = account.tokenExpires ? new Date(account.tokenExpires).getTime() : 0;
    if (!force && expires > limit) continue;
    try {
      const current = store.tokenFor(account.id);
      const next = await graph.exchangeLongLived(current);
      store.setAccountToken(account.id, next, new Date(Date.now() + 59 * 864e5).toISOString());
      refreshed++;
    } catch (e: any) {
      store.setAccountError(account.id, `Obnova přístupu selhala: ${e?.message ?? e}`);
      failed.push(account.username || account.lang);
    }
  }
  if (refreshed || failed.length) emit();
  return { refreshed, failed };
}
