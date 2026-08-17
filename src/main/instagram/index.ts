/**
 * Vnější rozhraní instagramového modulu — všechno, co volá `ipc.ts`.
 * Ostatní soubory ve složce zůstávají vnitřní.
 */
import fs from 'fs';
import path from 'path';
import { app, BrowserWindow } from 'electron';
import { getDb, setSetting } from '../db';
import * as store from './store';
import * as graph from './graph';
import * as media from './media';
import * as captions from './captions';
import * as publisher from './publish';
import * as oauth from './oauth';
import type { IgOverview, IgMediaItem, IgPost } from '../../shared/types';

export { store, media, publisher, oauth };
export const connect = oauth.startConnect;
export const finishConnect = oauth.finishConnect;
export const connectWithToken = oauth.connectWithToken;
export const handleCallbackUrl = oauth.handleCallbackUrl;
export const syncSource = publisher.syncSource;

/**
 * Přidání účtu pro daný trh. Když aplikace drží platný přístup z minulého
 * přihlášení, použije ho; jinak řekne rozhraní, že se má otevřít prohlížeč.
 */
export async function addMarket(lang: string): Promise<
  { saved?: unknown; pick?: unknown[]; needsLogin?: boolean }
> {
  const result = await oauth.connectFromSaved(lang);
  return result ?? { needsLogin: true };
}
export const refreshTokens = publisher.refreshTokens;
export const processQueue = publisher.processQueue;

function emit(payload: unknown = {}) {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('ig:changed', payload);
}

/* ---------- Přehled pro rozhraní ---------- */

export function overview(): IgOverview {
  const accounts = store.listAccounts();
  const jobs = store.listJobs(20);
  return {
    accounts,
    markets: store.listMarkets(),
    brand: store.getBrand(),
    connection: store.connectionState(),
    storageReady: media.storageConfigured(),
    queued: jobs.filter(j => j.state === 'scheduled' || j.state === 'publishing').length,
    failed: jobs.filter(j => j.state === 'failed').length,
    hasSource: !!store.sourceAccount()
  };
}

export function saveConnection(p: Partial<store.IgSecrets> & { autoSync?: boolean }): IgOverview {
  store.saveSecrets(p);
  if (p.autoSync !== undefined) setSetting('igAutoSync', p.autoSync ? '1' : '0');
  return overview();
}

export async function installCallbackPage(): Promise<string> {
  const url = await media.installCallbackPage();
  store.saveSecrets({ callbackUrl: url });
  return url;
}

export async function testStorage(): Promise<string> {
  return media.testStorage();
}

export async function accountLimit(accountId: number): Promise<{ used: number; cap: number } | null> {
  const account = store.listAccounts().find(a => a.id === accountId);
  if (!account) return null;
  return graph.publishingLimit(account.igUserId, store.tokenFor(account.id));
}

/* ---------- Náhledy ---------- */

const thumbDir = () => path.join(app.getPath('userData'), 'ig-thumbs');

/**
 * Náhled příspěvku ze zdrojového účtu. Odkazy na Instagram CDN vyprší, proto
 * se první stažený náhled uloží na disk a pak už se bere odtamtud.
 */
export async function thumb(sourcePostId: number): Promise<string | null> {
  const row = store.sourcePost(sourcePostId);
  if (!row) return null;

  const dir = thumbDir();
  const file = path.join(dir, `${row.ig_media_id}.jpg`);
  if (fs.existsSync(file)) {
    return `data:image/jpeg;base64,${fs.readFileSync(file).toString('base64')}`;
  }

  const source = store.sourceAccount();
  if (!source) return null;
  try {
    const info = await graph.mediaUrls(row.ig_media_id, store.tokenFor(source.id));
    const url = info.thumbnail_url
      ?? info.media_url
      ?? info.children?.data?.[0]?.thumbnail_url
      ?? info.children?.data?.[0]?.media_url;
    if (!url) return null;
    const buf = await media.download(url);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, buf);
    return `data:image/jpeg;base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

/** Náhled lokálního souboru vybraného do nového příspěvku. */
export function preview(file: string): string | null {
  try {
    if (media.isVideoFile(file)) return null;
    const buf = media.readFile(file);
    if (buf.length > 12 * 1024 * 1024) return null;
    return `data:${media.mimeFor(file)};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

/* ---------- Příspěvky ---------- */

export function feed(limit = 60, offset = 0) {
  return store.listSourcePosts(limit, offset);
}

export function getPost(id: number): IgPost | null {
  return store.getPost(id);
}

export function listDrafts(): IgPost[] {
  const rows = getDb().prepare(
    `SELECT p.id FROM ig_posts p
     WHERE p.archived = 0
       AND EXISTS (SELECT 1 FROM ig_captions c WHERE c.post_id = p.id AND c.status != 'published')
     ORDER BY p.created_at DESC LIMIT 40`
  ).all() as any[];
  return rows.map(r => store.getPost(r.id)).filter((p): p is IgPost => !!p);
}

/** Nový příspěvek ze souborů na disku. */
export function createDraft(files: string[], brief: string, mediaNote: string): IgPost {
  const postId = store.createPost({ kind: 'new', brief, mediaNote });
  store.setPostMedia(postId, filesToMedia(files));
  emit();
  return store.getPost(postId)!;
}

export function updateDraft(postId: number, p: { brief?: string; mediaNote?: string; files?: string[] }): IgPost {
  store.updatePost(postId, p);
  if (p.files) store.setPostMedia(postId, filesToMedia(p.files));
  return store.getPost(postId)!;
}

function filesToMedia(files: string[]): IgMediaItem[] {
  return files.map(f => {
    const mime = media.mimeFor(f);
    const isVideo = mime.startsWith('video/');
    let width: number | null = null;
    let height: number | null = null;
    if (!isVideo) {
      try {
        const size = media.imageSize(media.readFile(f));
        if (size) { width = size.width; height = size.height; }
      } catch { /* rozměry jsou jen pro upozornění */ }
    }
    return { path: f, mime, isVideo, width, height };
  });
}

/** Upozornění na poměr stran a formáty — ukazuje se v rozhraní před publikací. */
export function mediaWarnings(postId: number): string[] {
  const out: string[] = [];
  for (const m of store.postMedia(postId)) {
    const name = path.basename(m.path || 'médium');
    if (m.width && m.height) {
      const w = media.aspectWarning(m.width, m.height);
      if (w) out.push(`${name}: ${w}`);
    }
    if (!m.is_video && m.mime && !['image/jpeg', 'image/png'].includes(m.mime)) {
      out.push(`${name}: Instagram spolehlivě bere jen JPEG a PNG.`);
    }
  }
  return out;
}

/** Příspěvek převzatý z vlastního účtu — média zůstávají na Instagramu. */
export function createFromSource(sourcePostId: number): IgPost {
  const row = store.sourcePost(sourcePostId);
  if (!row) throw new Error('Původní příspěvek nenalezen.');

  const existing = getDb().prepare(
    'SELECT id FROM ig_posts WHERE source_post_id = ? ORDER BY id DESC LIMIT 1'
  ).get(sourcePostId) as any;
  if (existing) return store.getPost(existing.id)!;

  let children: any[] = [];
  try { children = JSON.parse(row.children_json || '[]'); } catch { /* bez karuselu */ }

  const items: IgMediaItem[] = children.length
    ? children.map((c: any) => ({
        path: '', mime: '', isVideo: c.media_type === 'VIDEO',
        sourceUrl: `ig:${c.id}`
      }))
    : [{ path: '', mime: '', isVideo: row.media_type === 'VIDEO' || row.media_type === 'REELS', sourceUrl: `ig:${row.ig_media_id}` }];

  const postId = store.createPost({ kind: 'source', sourcePostId, brief: '' });
  store.setPostMedia(postId, items);
  emit();
  return store.getPost(postId)!;
}

export function deletePost(id: number): void {
  store.deletePost(id);
  emit();
}

/* ---------- Generování ---------- */

/** Obrázky pro model: z disku, nebo stažené z Instagramu u převzatých příspěvků. */
async function imagesForModel(post: IgPost): Promise<{ mime: string; b64: string }[]> {
  const out: { mime: string; b64: string }[] = [];
  const source = store.sourceAccount();

  for (const m of post.media.slice(0, 3)) {
    if (m.isVideo) continue;
    try {
      if (m.path) {
        const buf = media.readFile(m.path);
        if (buf.length > 4.5 * 1024 * 1024) continue; // model má na obrázek limit
        out.push({ mime: m.mime, b64: buf.toString('base64') });
      } else if (m.sourceUrl && source) {
        const info = await graph.mediaUrls(String(m.sourceUrl).replace(/^ig:/, ''), store.tokenFor(source.id));
        const url = info.media_url ?? info.thumbnail_url;
        if (!url) continue;
        const buf = await media.download(url);
        if (buf.length > 4.5 * 1024 * 1024) continue;
        out.push({ mime: 'image/jpeg', b64: buf.toString('base64') });
      }
    } catch { /* obrázek navíc není podmínka */ }
  }
  return out;
}

export async function generate(postId: number, langs: string[]): Promise<IgPost> {
  const post = store.getPost(postId);
  if (!post) throw new Error('Příspěvek nenalezen.');

  const mode: 'brief' | 'source' = post.kind === 'source' ? 'source' : 'brief';
  const result = await captions.generate({
    mode,
    brief: post.brief,
    source: post.sourceCaption ?? '',
    mediaNote: post.mediaNote ?? '',
    langs,
    variants: store.getBrand().variants,
    images: await imagesForModel(post)
  });

  store.saveCaptions(postId, result.captions);
  emit();
  return store.getPost(postId)!;
}

/**
 * Připraví prázdné popisky, aby se daly napsat ručně. Generování se tím
 * nevylučuje — kdo si to rozmyslí, dá později Vygenerovat texty a přepíše to.
 */
export function blankCaptions(postId: number, langs: string[]): IgPost {
  if (langs.length === 0) throw new Error('Vyber aspoň jeden trh.');
  const post = store.getPost(postId);
  if (!post) throw new Error('Příspěvek nenalezen.');
  const fresh = langs.filter(l => !post.captions.some(c => c.lang === l));
  if (fresh.length === 0) return post;
  store.saveCaptions(postId, fresh.map(lang => ({ lang, variants: [''] })));
  emit();
  return store.getPost(postId)!;
}

export function chooseVariant(captionId: number, index: number): void {
  store.updateCaption(captionId, { chosen: index });
}

export function editCaption(captionId: number, text: string): void {
  store.updateCaption(captionId, { edited: text });
}

/* ---------- Publikace ---------- */

export function publishCaption(captionId: number, at?: string | null): number {
  return publisher.schedule(captionId, at);
}

/**
 * Zařadí popisky příspěvku k publikaci. `force` pošle i ty, které už vyšly —
 * hodí se, když se má stejný příspěvek zopakovat (třeba po přepsání textu).
 */
export function publishPost(
  postId: number,
  at?: string | null,
  force = false
): { queued: number; skipped: string[] } {
  const post = store.getPost(postId);
  if (!post) throw new Error('Příspěvek nenalezen.');
  const skipped: string[] = [];
  let queued = 0;
  const alreadyOut = post.captions.filter(c => c.status === 'published').length;
  if (!force && alreadyOut === post.captions.length && alreadyOut > 0) {
    throw new Error('Příspěvek už vyšel na všech vybraných trzích. Zaškrtni „publikovat znovu", pokud ho chceš zopakovat.');
  }
  for (const c of post.captions) {
    if (!force && c.status === 'published') continue;
    try {
      publisher.schedule(c.id, at);
      queued++;
    } catch (e: any) {
      skipped.push(`${c.lang}: ${e.message}`);
    }
  }
  if (queued === 0 && skipped.length) throw new Error(skipped.join('\n'));
  return { queued, skipped };
}

export const jobs = () => store.listJobs();
export const retryFacebook = (jobId: number) => publisher.retryFacebook(jobId);
export const cancelJob = (id: number) => { store.cancelJob(id); emit(); };
export const retryJob = (id: number) => { store.retryJob(id); emit(); setTimeout(() => publisher.processQueue().catch(() => {}), 200); };

/* ---------- Účty a trhy ---------- */

export function disconnect(id: number): void {
  store.deleteAccount(id);
  emit();
}

export function setShareFb(id: number, value: boolean): void {
  store.setShareFb(id, value);
  emit();
}

export function setSource(id: number): void {
  store.setSourceAccount(id);
  emit();
}

export const markets = () => store.listMarkets();
export const saveMarket = (m: any) => store.saveMarket(m);
export const deleteMarket = (lang: string) => store.deleteMarket(lang);
export const brand = () => store.getBrand();
export const saveBrand = (b: any) => store.saveBrand(b);
