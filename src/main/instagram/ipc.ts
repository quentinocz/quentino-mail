/**
 * Kanály instagramového modulu. Stejná dohoda jako ve zbytku aplikace:
 * handler nikdy nevyhodí výjimku ven, vrací `{ ok, data | error }`.
 */
import { ipcMain, dialog, shell, BrowserWindow } from 'electron';
import * as ig from './index';

function handle(channel: string, fn: (...args: any[]) => any) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  });
}

export function registerIgIpc() {
  /* Přehled a připojení */
  handle('ig:overview', () => ig.overview());
  handle('ig:saveConnection', (p: any) => ig.saveConnection(p ?? {}));
  handle('ig:installCallback', () => ig.installCallbackPage());
  handle('ig:testStorage', () => ig.testStorage());

  handle('ig:connect', (lang: string) => {
    const url = ig.connect(lang);
    shell.openExternal(url);
    return url;
  });
  handle('ig:connectToken', (lang: string, token: string) => ig.connectWithToken(lang, token));
  handle('ig:finishConnect', (igUserId: string) => ig.finishConnect(igUserId));
  handle('ig:disconnect', (id: number) => ig.disconnect(id));
  handle('ig:setSource', (id: number) => ig.setSource(id));
  handle('ig:limit', (id: number) => ig.accountLimit(id));

  /* Trhy a značka */
  handle('ig:markets', () => ig.markets());
  handle('ig:saveMarket', (m: any) => ig.saveMarket(m));
  handle('ig:deleteMarket', (lang: string) => ig.deleteMarket(lang));
  handle('ig:brand', () => ig.brand());
  handle('ig:saveBrand', (b: any) => ig.saveBrand(b));

  /* Feed zdrojového účtu */
  handle('ig:feed', (limit?: number, offset?: number) => ig.feed(limit ?? 60, offset ?? 0));
  handle('ig:sync', (full?: boolean) => ig.syncSource(!!full));
  handle('ig:thumb', (sourcePostId: number) => ig.thumb(sourcePostId));
  handle('ig:createFromSource', (sourcePostId: number) => ig.createFromSource(sourcePostId));

  /* Příspěvky */
  handle('ig:pickMedia', async () => {
    const win = BrowserWindow.getFocusedWindow();
    const res = await dialog.showOpenDialog(win!, {
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Fotky a videa', extensions: ['jpg', 'jpeg', 'png', 'mp4', 'mov'] },
        { name: 'Vše', extensions: ['*'] }
      ]
    });
    return res.canceled ? [] : res.filePaths;
  });
  handle('ig:preview', (file: string) => ig.preview(file));
  handle('ig:createDraft', (files: string[], brief: string, mediaNote: string) =>
    ig.createDraft(files ?? [], brief ?? '', mediaNote ?? ''));
  handle('ig:updateDraft', (postId: number, patch: any) => ig.updateDraft(postId, patch ?? {}));
  handle('ig:post', (id: number) => ig.getPost(id));
  handle('ig:drafts', () => ig.listDrafts());
  handle('ig:deletePost', (id: number) => ig.deletePost(id));
  handle('ig:warnings', (postId: number) => ig.mediaWarnings(postId));

  /* Generování a publikace */
  handle('ig:generate', (postId: number, langs: string[]) => ig.generate(postId, langs ?? []));
  handle('ig:chooseVariant', (captionId: number, index: number) => ig.chooseVariant(captionId, index));
  handle('ig:editCaption', (captionId: number, text: string) => ig.editCaption(captionId, text));
  handle('ig:publish', (captionId: number, at?: string | null) => ig.publishCaption(captionId, at ?? null));
  handle('ig:publishPost', (postId: number, at?: string | null) => ig.publishPost(postId, at ?? null));

  /* Fronta */
  handle('ig:jobs', () => ig.jobs());
  handle('ig:cancelJob', (id: number) => ig.cancelJob(id));
  handle('ig:retryJob', (id: number) => ig.retryJob(id));
  handle('ig:runQueue', () => ig.processQueue());
  handle('ig:refreshTokens', () => ig.refreshTokens(true));
}
