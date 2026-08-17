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
 * Do úložiště jde všechno — soubory z disku i média převzatá z vlastního účtu.
 * Podstrčit Metě rovnou odkaz na její Instagram CDN se zdá jako zkratka, ale
 * ty adresy jsou podepsané a časově omezené a její vlastní stahovač na nich
 * selhává (chyby řady 22070xx). Radši jednou stáhneme a nahrajeme k sobě;
 * po zveřejnění se soubor z úložiště zase smaže.
 */
async function resolveMedia(
  postId: number,
  source: { id: number; token: string } | null
): Promise<graph.GraphMedia[]> {
  const rows = store.postMedia(postId);
  if (rows.length === 0) throw new Error('Příspěvek nemá žádná média.');

  const out: graph.GraphMedia[] = [];
  // Jedno video se Metě posílá přímo; karusel na to nemá, tam se použije adresa
  const directVideo = rows.length === 1 && !!rows[0].is_video;

  for (const row of rows) {
    const isVideo = !!row.is_video;

    if (row.source_url) {
      if (row.public_url) {
        out.push({ publicUrl: row.public_url, isVideo, coverOffset: row.cover_offset });
        continue;
      }

      const igId = String(row.source_url).replace(/^ig:/, '');
      if (!source) throw new Error('Není připojený zdrojový účet, ze kterého médium pochází.');
      let cdnUrl = '';
      try {
        const info = await graph.mediaUrls(igId, source.token);
        cdnUrl = info.media_url ?? info.thumbnail_url ?? '';
      } catch (e: any) {
        // Zneplatněný přístup se pozná u účtu, ne až u příspěvku — jinak
        // uživatel vidí chybu ve frontě a nikde nestojí, co s tím.
        if (graph.isTokenError(e)) {
          store.setAccountError(source.id, e.message);
          throw new Error(`Zdrojový účet je potřeba připojit znovu: ${e.message}`);
        }
        throw new Error(`Médium z původního příspěvku se nepodařilo načíst: ${e.message}`);
      }
      if (!cdnUrl) throw new Error('Původní příspěvek nemá dostupné médium.');

      const copy = await media.download(cdnUrl);
      if (directVideo) {
        // Do úložiště se video vůbec nedostane — jde rovnou Metě
        out.push({ publicUrl: '', isVideo, coverOffset: row.cover_offset, data: copy });
        continue;
      }
      const ext = isVideo ? 'mp4' : 'jpg';
      const copyKey = `posts/${postId}/${row.id}-${Date.now()}.${ext}`;
      const uploaded = await media.upload(copy, copyKey, isVideo ? 'video/mp4' : 'image/jpeg');
      store.setMediaPublicUrl(row.id, uploaded.publicUrl, uploaded.key);
      out.push({ publicUrl: uploaded.publicUrl, isVideo, coverOffset: row.cover_offset });
      continue;
    }

    if (row.public_url) {
      out.push({ publicUrl: row.public_url, isVideo, coverOffset: row.cover_offset });
      continue;
    }

    const buf = media.readFile(row.path);
    if (directVideo) {
      out.push({ publicUrl: '', isVideo, coverOffset: row.cover_offset, data: buf });
      continue;
    }
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
    const sourceAccount = store.sourceAccount();
    let source: { id: number; token: string } | null = null;
    if (sourceAccount) {
      try {
        source = { id: sourceAccount.id, token: store.tokenFor(sourceAccount.id) };
      } catch {
        source = null; // vypršelý přístup řeší hláška níž
      }
    }

    const items = await resolveMedia(caption.post_id, source);
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

    // Souběžné sdílení na Facebook stránku. Nepovede-li se, příspěvek na
    // Instagramu tím neruším — jen se u položky poznamená, co chybělo.
    if (account.shareFb && account.pageId) {
      try {
        // Fotky si Facebook stáhne z úložiště, video mu jde přímo — obojí
        // stejnými daty, která už máme připravená pro Instagram.
        const fbId = await graph.shareToPage(account.pageId, token, text, items);
        store.setJobState(jobId, { fb_post_id: fbId, fb_error: null });
      } catch (e: any) {
        const msg = e?.message ?? String(e);
        store.setJobState(jobId, {
          fb_error: /permission|oprávnění|OAuthException/i.test(msg)
            ? `${msg} — účet je potřeba připojit znovu, aby přidal oprávnění ke stránce.`
            : msg
        });
      }
    }
  } catch (e: any) {
    const message = e?.message ?? String(e);
    const attempts = (job.attempts ?? 0) + 1;

    if (TRANSIENT.test(message) && attempts < MAX_ATTEMPTS && !graph.isTokenError(e)) {
      // Vrátí se do fronty; nahraná média zůstanou, protože položka je pořád otevřená
      store.setJobState(jobId, {
        state: 'scheduled',
        error: `${message} — zkusím to znovu za 5 minut (pokus ${attempts} z ${MAX_ATTEMPTS}).`,
        scheduled_at: new Date(Date.now() + RETRY_AFTER).toISOString(),
        started_at: null
      });
    } else {
      store.setJobState(jobId, {
        state: 'failed',
        error: message,
        finished_at: new Date().toISOString()
      });
    }
    // Když padl přístup k cílovému účtu, označí se u něj — v Účtech je to pak vidět
    if (graph.isTokenError(e)) store.setAccountError(job.account_id, message);
  } finally {
    try { await cleanupPostMedia(caption.post_id); } catch { /* úklid není kritický */ }
    emit();
  }
}

/**
 * Chyby, u kterých má smysl to za chvíli zkusit znovu. Meta jimi hlásí
 * i vlastní zádrhely při zpracování médií (řada 22070xx), takže první
 * neúspěch neznamená, že je něco špatně s příspěvkem.
 */
const TRANSIENT = /2207076|2207001|2207053|2207032|Media upload has failed|Please try again|temporarily/i;
const RETRY_AFTER = 5 * 60_000;
const MAX_ATTEMPTS = 3;

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
