/**
 * Kanály instagramového modulu. Stejná dohoda jako ve zbytku aplikace:
 * handler nikdy nevyhodí výjimku ven, vrací `{ ok, data | error }`.
 */
import { ipcMain, dialog, shell, BrowserWindow } from 'electron';
import * as ig from './index';
import { callerWindow } from '../caller';
import { mediaUrl } from '../mediafile';

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
  handle('ig:addMarket', (lang: string) => ig.addMarket(lang));
  handle('ig:connectToken', (lang: string, token: string) => ig.connectWithToken(lang, token));
  // Náhradní cesta, když návratovou stránku prohlížeč nepředá zpět aplikaci:
  // uživatel zkopíruje adresu z řádku prohlížeče a vloží ji sem.
  handle('ig:pasteCallback', (url: string) => ig.handleCallbackUrl(url));
  handle('ig:finishConnect', (igUserId: string) => ig.finishConnect(igUserId));
  handle('ig:disconnect', (id: number) => ig.disconnect(id));
  handle('ig:setSource', (id: number) => ig.setSource(id));
  handle('ig:setShareFb', (id: number, value: boolean) => ig.setShareFb(id, !!value));
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
    const win = callerWindow();
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
  handle('ig:blankCaptions', (postId: number, langs: string[]) => ig.blankCaptions(postId, langs ?? []));
  handle('ig:chooseVariant', (captionId: number, index: number) => ig.chooseVariant(captionId, index));
  handle('ig:editCaption', (captionId: number, text: string) => ig.editCaption(captionId, text));
  handle('ig:publish', (captionId: number, at?: string | null, channels?: any) =>
    ig.publishCaption(captionId, at ?? null, channels));
  handle('ig:publishPost', (postId: number, at?: string | null, force?: boolean, channels?: any) =>
    ig.publishPost(postId, at ?? null, !!force, channels));
  handle('ig:retryFacebook', (jobId: number) => ig.retryFacebook(jobId));
  handle('ig:relogin', (lang: string) => {
    const url = ig.oauth.relogin(lang);
    shell.openExternal(url);
    return url;
  });

  /*
   * Plánovač. Návrh se **neukládá sám**: vrátí se, dá se přečíst,
   * přehodit a vyhodit, a teprve pak se z něj stanou příspěvky. Rovnou
   * uložený měsíc by znamenal třicet rozdělaných, které pak někdo maže.
   */
  handle('ig:planSetup', () => ig.planSetup());
  handle('ig:savePlanSetup', (value: any) => ig.savePlanSetup(value ?? {}));
  handle('ig:planPropose', () => ig.proposeMonth());
  handle('ig:planAccept', (items: any[]) => ig.acceptPlan(items ?? []));
  handle('ig:planned', (from: string, to: string) => ig.plannedPosts(String(from ?? ''), String(to ?? '')));
  handle('ig:planMove', (id: number, at: string) => ig.movePlan(Number(id), String(at ?? '')));
  /* Jeden příspěvek na teď — bez termínu, na vyžádání nebo podle přání */
  handle('ig:proposeOne', (wish: string) => ig.proposeOne(String(wish ?? '')));
  handle('ig:acceptOne', (item: any) => ig.acceptOne(item ?? {}));
  /* Přehození dvou termínů tažením v seznamu rozdělaných */
  handle('ig:planSwap', (a: number, b: number) => ig.swapPlan(Number(a), Number(b)));
  /* Odsouhlasení k publikaci a připomínky toho, co se nestíhá */
  handle('ig:approve', (id: number, on: boolean) => ig.approvePost(Number(id), !!on));
  handle('ig:alerts', () => ig.planAlerts());

  /* Fronta */
  handle('ig:jobs', () => ig.jobs());
  handle('ig:cancelJob', (id: number) => ig.cancelJob(id));
  handle('ig:retryJob', (id: number) => ig.retryJob(id));
  handle('ig:runQueue', () => ig.processQueue());
  handle('ig:refreshTokens', () => ig.refreshTokens(true));

  /*
   * Střih videa. Projekt se ukládá po každé změně sám — časová osa se
   * ladí desítkami malých úprav a „neuložil jsem to" je tady nejhorší
   * možná chyba: přijde se o práci, kterou nejde zopakovat z hlavy.
   */
  handle('ig:video', (postId: number) => {
    const p = ig.videoProjekt(Number(postId));
    // Náhled si sám o soubory řekne přes vlastní protokol; povolí se mu
    // jen to, co v projektu skutečně je
    ig.povolProjekt(p);
    return p;
  });
  handle('ig:videoSave', (p: any) => ig.saveVideoProjekt(p));
  handle('ig:videoPick', () => ig.pickKlipy());
  handle('ig:videoPickAudio', () => ig.pickZvuk());
  handle('ig:videoProbe', (soubor: string) => ig.videoPopis(String(soubor ?? '')));
  handle('ig:videoUrl', (soubor: string) => {
    // Adresa se vydá jen pro soubor, který už je v projektu nebo ve znělkách
    ig.povolSoubor(String(soubor ?? ''));
    return mediaUrl(String(soubor ?? ''));
  });
  handle('ig:videoRecord', (postId: number, lang: string, bytes: any, pripona?: string) =>
    ig.saveNahravka(Number(postId), String(lang ?? ''), new Uint8Array(bytes ?? []), String(pripona || 'webm')));
  handle('ig:videoTranslate', (postId: number, langs: string[]) =>
    ig.prelozTitulky(Number(postId), Array.isArray(langs) ? langs : []));
  handle('ig:videoRender', (postId: number, lang: string, obrazky: any[]) =>
    ig.vykresliVideo(Number(postId), String(lang ?? ''), Array.isArray(obrazky) ? obrazky : []));
  handle('ig:videoStop', () => ig.stopVideoRender());
  handle('ig:videoFeed', (postId: number, on: boolean) => ig.setDoMrizky(Number(postId), !!on));
  handle('ig:stings', () => ig.znelky());
  handle('ig:stingAdd', (kam: any) => ig.addZnelka(kam === 'zacatek' || kam === 'konec' ? kam : 'kamkoli'));
  handle('ig:stingSave', (id: string, patch: any) => ig.saveZnelka(String(id ?? ''), patch ?? {}));
  handle('ig:stingRemove', (id: string) => ig.removeZnelka(String(id ?? '')));
}
