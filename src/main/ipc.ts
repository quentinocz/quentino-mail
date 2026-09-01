import { ipcMain, shell, dialog, BrowserWindow, app } from 'electron';
import fs from 'fs';
import path from 'path';
import { listAccounts, saveAccount, deleteAccount } from './accounts';
import {
  listFolders, syncFolder, listMessages, getMessageFull, setFlags,
  deleteMessage, moveMessage, archiveMessage, getThread, testConnection, syncAllAccounts,
  bulkSetFlags, bulkDelete, bulkArchive, emptyTrash, getMailboxQuota
} from './imap';
import { sendNow, scheduleSend, testSmtp } from './smtp';
import {
  getSettings, saveSettings, listKnowledge, saveKnowledge, deleteKnowledge,
  listPersons, savePerson, deletePerson, exportConfig, importConfig, configNeedsPassphrase
} from './settings';
import { searchProducts, refreshFeed, feedStatus, listProducts, productFacets,
  productDetail, findByCode, suggestForStockin, productCodes, refreshStock, stockSyncedAt } from './products';
import { searchContacts } from './contacts';
import { getSyncConfig, saveSyncConfig, runSync, pushVouchersSoon, syncVouchersNow } from './appsync';
import { scanOld, freeUp } from './cleanup';
import { listSessions, createSession, sessionOf, itemsOf, addScan, setQty, renameSession,
  deleteSession, planOf, emitChanged as emitStockin } from './stockin';
import { sendViaWindow, sendViaApi, apiCanWriteStock, confirmSent } from './upstock';
import { labelItems, labelsToPdf, labelPreview, labelsExport, zplPlan,
  DEFAULT_LAYOUT, DEFAULT_ROLL } from './labels';
import { summarize, generateReply, improveText, translateIncoming, translateText, categorizeUncategorized, getAiUsage, generateDigest } from './ai';
import { getUpgatesConfig, saveUpgatesConfig, testUpgates, ordersByEmail } from './upgates';
import { buildOrderCard, buildOrderBadge, resetShopDomains } from './ordercard';
import { clearTrackingCache } from './ordertrack';
import {
  scanOrders, setItemPacked, setItemCount, setOrderDone, resetPacking, scanItem, openOrder,
  mailForOrder
} from './packing';
import { chatWebhookSql, makeTopic, notifyTest } from './notify';
import { refreshOrderLinks, pendingCount, setOrderReplyResolved } from './orderlink';
import * as ptrans from './ptrans';
import * as orderfeed from './orderfeed';
import * as keepalive from './keepalive';
import * as articles from './articles';
import { customerContext, customerConversation, messageText } from './customer';
import { relearnPhase } from './shipphase';
import { createVouchers } from './voucher';
import {
  listTemplates, saveTemplate, deleteTemplate, addCodes, listCodes, deleteCode,
  takeCode, releaseCode, specFromTemplate, listClashes, clearClash
} from './vouchers';
import { listOutbox, cancelOutbox, processOutbox } from './scheduler';
import { getDb } from './db';
import { registerIgIpc } from './instagram/ipc';
import { registerChatIpc } from './chat/ipc';
import { refreshWatchers } from './idle';

/** Zpráva do všech oken — po stažení feedu se musí překreslit, co je otevřené. */
function emit(channel: string, payload: unknown) {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload);
}

/** Záloha zamčená heslem čeká tady, než uživatel heslo doplní. */
let pendingImport: any = null;

/** Všechny handlery vrací { ok, data | error } — renderer nikdy nedostane výjimku bez kontextu. */
function handle(channel: string, fn: (...args: any[]) => any) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  });
}

export function registerIpc() {
  // Účty
  handle('accounts:list', () => listAccounts());
  handle('accounts:save', (cfg) => {
    const saved = saveAccount(cfg);
    refreshWatchers(); // nový nebo změněný účet začne poslouchat hned
    return saved;
  });
  handle('accounts:delete', (id) => {
    const res = deleteAccount(id);
    refreshWatchers();
    return res;
  });
  handle('accounts:test', async (cfg) => {
    await testConnection(cfg);
    await testSmtp(cfg);
    return true;
  });

  // Složky a zprávy
  handle('folders:list', (accountId, refresh) => listFolders(accountId, refresh));
  handle('sync:folder', (accountId, folder) => syncFolder(accountId, folder));
  handle('sync:all', () => syncAllAccounts());
  handle('messages:list', (accountId, folder, opts) => listMessages(accountId, folder, opts ?? {}));
  handle('messages:get', (dbId) => getMessageFull(dbId));
  handle('messages:thread', (dbId) => getThread(dbId));
  handle('messages:setFlag', (dbId, flag, value) => setFlags(dbId, flag, value));
  handle('messages:delete', (dbId) => deleteMessage(dbId));
  handle('messages:move', (dbId, folder) => moveMessage(dbId, folder));
  handle('messages:archive', (dbId) => archiveMessage(dbId));
  handle('messages:categorize', (accountId, folder) => categorizeUncategorized(accountId, folder, 50));

  // Hromadné operace
  handle('messages:bulkFlag', (ids, flag, value) => bulkSetFlags(ids, flag, value));
  handle('messages:bulkDelete', (ids) => bulkDelete(ids));
  handle('messages:bulkArchive', (ids, deleteAfter) => bulkArchive(ids, !!deleteAfter));
  handle('trash:empty', (accountId) => emptyTrash(accountId));

  // Odesílání
  handle('send:now', (draft) => sendNow(draft));
  handle('send:schedule', (draft) => scheduleSend(draft));
  handle('outbox:list', () => listOutbox());
  handle('outbox:cancel', (id) => cancelOutbox(id));
  handle('outbox:processNow', () => processOutbox());

  // Nastavení
  handle('settings:get', () => getSettings());
  handle('settings:save', (s) => saveSettings(s));

  // Synchronizace mezi zařízeními
  handle('appsync:get', () => getSyncConfig());
  handle('appsync:save', (cfg) => saveSyncConfig(cfg));
  handle('appsync:run', () => runSync());
  handle('appsync:pickFolder', async () => {
    const win = BrowserWindow.getFocusedWindow();
    const res = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] });
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0];
  });

  // Našeptávač kontaktů
  handle('contacts:search', (q: string) => searchContacts(q));

  // Produktový feed
  handle('products:search', (q: string) => searchProducts(q));
  handle('products:refresh', async () => {
    const status = await refreshFeed();
    resetShopDomains(); // po přesyncu se mohly změnit jazykové mutace e-shopu
    return status;
  });
  handle('products:status', () => feedStatus());
  handle('products:list', (q) => listProducts(q ?? {}));
  handle('products:facets', () => productFacets());

  // Osoby pro podpisy
  handle('persons:list', () => listPersons());
  handle('persons:save', (p) => savePerson(p));
  handle('persons:delete', (id) => deletePerson(id));

  // Export / import nastavení
  handle('config:export', async (passphrase?: string) => {
    const win = BrowserWindow.getFocusedWindow();
    const res = await dialog.showSaveDialog(win!, {
      defaultPath: `quentino-mail-zaloha-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (res.canceled || !res.filePath) return null;
    // Záloha obsahuje hesla a API klíče — soubor patří jen vlastníkovi
    fs.writeFileSync(res.filePath, JSON.stringify(exportConfig(passphrase || undefined), null, 2), { encoding: 'utf8', mode: 0o600 });
    return res.filePath;
  });
  handle('config:import', async () => {
    const win = BrowserWindow.getFocusedWindow();
    const res = await dialog.showOpenDialog(win!, {
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    const data = JSON.parse(fs.readFileSync(res.filePaths[0], 'utf8'));
    // Zamčenou zálohu si odložíme a počkáme, až uživatel doplní heslo
    if (configNeedsPassphrase(data)) {
      pendingImport = data;
      return { needPassphrase: true };
    }
    pendingImport = null;
    return { message: importConfig(data) };
  });
  handle('config:importUnlock', (passphrase: string) => {
    if (!pendingImport) throw new Error('Není co odemykat — vyber soubor se zálohou znovu.');
    const msg = importConfig(pendingImport, passphrase);
    pendingImport = null;
    return { message: msg };
  });

  // Znalostní báze pro AI
  handle('knowledge:list', () => listKnowledge());
  handle('knowledge:save', (doc) => saveKnowledge(doc));
  handle('knowledge:delete', (id) => deleteKnowledge(id));
  handle('knowledge:importFile', async () => {
    const win = BrowserWindow.getFocusedWindow();
    const res = await dialog.showOpenDialog(win!, {
      properties: ['openFile'],
      filters: [{ name: 'Textové soubory', extensions: ['txt', 'md', 'html', 'csv'] }]
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    const p = res.filePaths[0];
    const content = fs.readFileSync(p, 'utf8').slice(0, 100_000);
    return { title: path.basename(p).replace(/\.[^.]+$/, ''), content };
  });

  // AI
  handle('ai:usage', () => getAiUsage());
  handle('ai:digest', () => generateDigest());

  // Upgates API (objednávky zákazníka)
  handle('upgates:config', () => getUpgatesConfig());
  handle('upgates:saveConfig', (cfg) => saveUpgatesConfig(cfg));
  handle('upgates:test', () => testUpgates());
  handle('upgates:orders', (email: string) => ordersByEmail(email));

  // Karta objednávky vyčtená z potvrzovacího e-mailu
  handle('orders:card', (dbId: number, withLive?: boolean) => buildOrderCard(dbId, withLive !== false));
  handle('orders:badge', (dbId: number) => buildOrderBadge(dbId));
  // Druhá fáze: dopravci, kteří stav vypisují až JavaScriptem (PPL, DPD, GLS).
  // Karta se zobrazí hned a stav zásilky se doplní, jakmile doběhne.
  handle('orders:shipment', async (dbId: number, force?: boolean) =>
    (await buildOrderCard(dbId, true, true, !!force))?.tracking ?? null);
  handle('orders:refresh', (dbId: number) => {
    clearTrackingCache(); // vynutí nové čtení stránky e-shopu i dopravce
    return buildOrderCard(dbId, true, true);
  });

  // Zprávy zákazníků navázané na objednávky
  // Dárkové poukazy do přílohy
  handle('voucher:create', (spec: any) => createVouchers(spec));

  /**
   * Šablony poukazů a zásoba kódů.
   *
   * Po každé změně se rovnou pošle do sdílené složky (`pushVouchersSoon`),
   * ať se nová šablona nebo ubraný kód objeví na druhém zařízení hned a ne
   * až s dalším velkým kolem synchronizace.
   */
  const changed = <T>(value: T): T => { pushVouchersSoon(); return value; };
  handle('vouchers:list', () => listTemplates());
  handle('vouchers:save', (t: any) => changed(saveTemplate(t)));
  handle('vouchers:delete', (id: string) => changed(deleteTemplate(id)));
  handle('vouchers:addCodes', (id: string, raw: string) => changed(addCodes(id, raw ?? '')));
  handle('vouchers:codes', (id: string) => listCodes(id));
  handle('vouchers:deleteCode', (id: string, code: string) => changed(deleteCode(id, code)));
  handle('vouchers:release', (id: string, code: string) => changed(releaseCode(id, code)));
  /** Kódy, které podle synchronizace vydala dvě zařízení — normálně prázdné */
  /**
   * Sladit poukazy hned. Aplikace to dělá sama každých pár vteřin, ale když
   * někdo čeká na kódy z druhého zařízení, je lepší mít tlačítko než hádat,
   * jestli se něco děje. (Rychlost dodání souboru řídí cloud, ne my.)
   */
  handle('vouchers:sync', () => { syncVouchersNow(); return listTemplates(); });
  handle('vouchers:clashes', () => listClashes());
  handle('vouchers:clearClash', (id: string, code: string) => clearClash(id, code));
  /** Odebere kód ze šablony a rovnou z něj vysází PDF do přílohy */
  handle('vouchers:use', async (id: string, forWhom: string) => {
    const { code, remaining } = takeCode(id, forWhom ?? '');
    try {
      const files = await createVouchers(specFromTemplate(id, code));
      changed(null); // ubraný kód ať druhé zařízení ví hned
      return { code, remaining, files };
    } catch (e) {
      releaseCode(id, code); // sazba selhala — kód se vrací do zásoby
      changed(null);
      throw e;
    }
  });

  handle('ship:relearn', (text: string, phase: string) => relearnPhase(text, phase as any));
  handle('customer:context', (email: string) => customerContext(email));
  handle('customer:conversation', (email: string) => customerConversation(email));
  handle('customer:messageText', async (dbId: number) => {
    const m = await getMessageFull(dbId);
    return messageText(m.bodyText, m.bodyHtml);
  });
  handle('orderlinks:refresh', () => refreshOrderLinks());
  handle('orderlinks:pending', (accountId: number | null) => pendingCount(accountId ?? null));
  handle('orderlinks:resolve', (dbId: number, value: boolean) => setOrderReplyResolved(dbId, !!value));

  // Balení objednávek
  handle('packing:scan', (days: number, force?: boolean) => scanOrders(days ?? 7, !!force));
  handle('packing:setItem', (dbId: number, index: number, value: boolean) => setItemPacked(dbId, index, !!value));
  handle('packing:setCount', (dbId: number, index: number, count: number) => setItemCount(dbId, index, count ?? 0));
  handle('packing:scanItem', (dbId: number, code: string) => scanItem(dbId, code ?? ''));
  handle('packing:openOrder', (code: string) => openOrder(code ?? ''));
  handle('packing:mailFor', (orderNumber: string) => mailForOrder(orderNumber ?? ''));

  /*
   * Upozornění na telefon. Push přímo do vlastní aplikace by znamenal placený
   * účet u Applu, takže doručuje ntfy — POST na adresu s tajným názvem tématu.
   */
  handle('notify:topic', () => makeTopic());
  handle('notify:test', (server: string, topic: string) => notifyTest(server ?? '', topic ?? ''));
  handle('notify:chatSql', (server: string, topic: string) => chatWebhookSql(server ?? '', topic ?? ''));
  handle('packing:setDone', (dbId: number, value: boolean) => setOrderDone(dbId, !!value));
  handle('packing:reset', (dbId: number) => resetPacking(dbId));

  // Export zprávy do PDF
  handle('messages:exportPdf', async (fileName: string, html: string) => {
    const win = BrowserWindow.getFocusedWindow();
    const res = await dialog.showSaveDialog(win!, {
      defaultPath: `${fileName.replace(/[/\\:*?"<>|]/g, '_').slice(0, 80) || 'zprava'}.pdf`,
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    });
    if (res.canceled || !res.filePath) return null;
    const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
    try {
      await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
      const pdf = await w.webContents.printToPDF({ printBackground: true });
      fs.writeFileSync(res.filePath, pdf);
    } finally {
      w.destroy();
    }
    return res.filePath;
  });

  // Uložení obrázku z editoru (data URI → soubor pro CID přílohu)
  handle('files:saveTempImage', (name: string, base64: string) => {
    const dir = path.join(app.getPath('userData'), 'tmp-images');
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, name.replace(/[/\\:*?"<>|]/g, '_'));
    fs.writeFileSync(p, Buffer.from(base64, 'base64'));
    return p;
  });
  handle('quota:get', (accountId) => getMailboxQuota(accountId));

  /* ---------- Katalog: varianty, zásoby, štítky ---------- */
  handle('catalog:detail', (code: string) => productDetail(code));
  handle('catalog:scan', (raw: string) => findByCode(raw));
  handle('catalog:suggest', (query: string, limit?: number) => suggestForStockin(query ?? '', limit ?? 8));
  handle('catalog:codes', (query: any) => productCodes(query ?? {}));
  handle('catalog:refreshStock', async () => {
    const out = await refreshStock();
    emit('products:changed', {});
    return out;
  });
  handle('catalog:stockAt', () => stockSyncedAt());
  handle('labels:preview', (items: any[], layout: any) =>
    labelPreview(items ?? [], { ...DEFAULT_LAYOUT, ...(layout ?? {}) }));
  handle('labels:items', (codes: string[], perItem?: number) => labelItems(codes ?? [], perItem ?? 1));
  handle('labels:pdf', (items: any[], layout: any) =>
    labelsToPdf(items ?? [], { ...DEFAULT_LAYOUT, ...(layout ?? {}) }));
  handle('labels:roll', (roll: any) => zplPlan({ ...DEFAULT_ROLL, ...(roll ?? {}) }));
  handle('labels:export', (kind: 'zpl' | 'csv', items: any[], roll: any) =>
    labelsExport(kind === 'csv' ? 'csv' : 'zpl', items ?? [], { ...DEFAULT_ROLL, ...(roll ?? {}) }));

  /* ---------- Naskladnění ---------- */
  handle('stockin:list', () => listSessions());
  handle('stockin:create', (title?: string) => { const s = createSession(title ?? ''); emitStockin(); return s; });
  handle('stockin:open', (id: string) => ({ session: sessionOf(id), items: itemsOf(id) }));
  handle('stockin:scan', (id: string, raw: string, qty?: number) => {
    const out = addScan(id, raw, qty ?? 1);
    if (out.added) emitStockin();
    return out;
  });
  handle('stockin:qty', (id: string, code: string, qty: number) => { setQty(id, code, qty); emitStockin(); return true; });
  handle('stockin:rename', (id: string, title: string, note?: string) => {
    renameSession(id, title, note ?? ''); emitStockin(); return true;
  });
  handle('stockin:delete', (id: string) => { deleteSession(id); emitStockin(); return true; });
  handle('stockin:plan', (id: string) => planOf(id));
  handle('stockin:sendWindow', (id: string) => sendViaWindow(id));
  handle('stockin:sendApi', (id: string) => sendViaApi(id));
  handle('stockin:apiCheck', () => apiCanWriteStock());
  handle('stockin:confirm', (id: string) => { confirmSent(id); return true; });

  /*
   * Čtečka kódů fotoaparátem je jen na telefonu — na počítači je čtečka
   * klávesnicová a kódy padají rovnou do pole. Kanály tu přesto jsou, aby
   * rozhraní bylo v obou obalech stejné a nemuselo se ptát, kde běží.
   */
  handle('scan:available', () => false);
  handle('scan:start', () => {
    throw new Error('Čtení kódů fotoaparátem funguje v aplikaci na telefonu. '
      + 'Tady stačí načíst kód čtečkou do pole — chová se jako klávesnice.');
  });
  handle('scan:stop', () => true);
  handle('scan:feedback', () => true);
  handle('scan:count', () => true);
  /* Úklid schránky: najít staré velké zprávy a stáhnout je k sobě ze serveru */
  handle('mail:cleanupScan', (accountId: number, olderThanDays: number, minSizeKb: number) =>
    scanOld(accountId, olderThanDays ?? 365, minSizeKb ?? 0));
  handle('mail:cleanupRun', (accountId: number, items: any[]) => freeUp(accountId, items ?? []));
  /**
   * Otevření odkazu mimo aplikaci.
   *
   * Schémata jsou vyjmenovaná schválně: `shell.openExternal` umí spustit i
   * `file:` nebo vlastní schéma nějaké nainstalované aplikace, takže
   * cokoli, co by se sem dostalo ze stránky, by mohlo spustit program.
   * `tel:` je tu kvůli volání zákazníkovi, `mailto:` kvůli odkazům
   * v článcích.
   */
  handle('shell:openUrl', (url: string) => {
    if (typeof url !== 'string') return false;
    if (!/^(https:\/\/|tel:|mailto:)/i.test(url)) return false;
    shell.openExternal(url);
    return true;
  });
  handle('ai:summarize', (dbId) => summarize(dbId));
  handle('ai:reply', (req) => generateReply(req));
  handle('ai:improve', (text, mode) => improveText(text, mode));
  handle('ai:translateIncoming', (dbId) => translateIncoming(dbId));
  handle('ai:translateText', (text, lang) => translateText(text, lang));

  // Soubory
  handle('files:openAttachment', (p: string) => shell.openPath(p));
  handle('files:showInFolder', (p: string) => shell.showItemInFolder(p));
  handle('files:pickAttachments', async () => {
    const win = BrowserWindow.getFocusedWindow();
    const res = await dialog.showOpenDialog(win!, { properties: ['openFile', 'multiSelections'] });
    return res.canceled ? [] : res.filePaths;
  });
  handle('files:pickImage', async () => {
    const win = BrowserWindow.getFocusedWindow();
    const res = await dialog.showOpenDialog(win!, {
      properties: ['openFile'],
      filters: [{ name: 'Obrázky', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }]
    });
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0];
  });
  // Náhled lokálního obrázku v UI (logo podpisu) — data URI kvůli CSP
  handle('files:readAsDataUrl', (p: string) => {
    const ext = path.extname(p).toLowerCase().slice(1);
    const mime: Record<string, string> = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp'
    };
    const buf = fs.readFileSync(p);
    if (buf.length > 5 * 1024 * 1024) throw new Error('Obrázek je příliš velký (max 5 MB)');
    return `data:${mime[ext] ?? 'application/octet-stream'};base64,${buf.toString('base64')}`;
  });

  // Statistiky pro sidebar (počty v kategoriích)
  handle('stats:categories', (accountId: number) => {
    const rows = getDb().prepare(
      `SELECT category, COUNT(*) as cnt, SUM(CASE WHEN seen = 0 THEN 1 ELSE 0 END) as unseen
       FROM messages WHERE account_id = ? AND folder = 'INBOX' GROUP BY category`
    ).all(accountId) as any[];
    const out: Record<string, { cnt: number; unseen: number }> = {};
    for (const r of rows) out[r.category ?? 'none'] = { cnt: r.cnt, unseen: r.unseen };
    return out;
  });

  // Verze aplikace — do hlavičky nastavení, ať je po vydání vidět, co běží
  handle('app:version', () => ({
    version: app.getVersion(),
    platform: process.platform,
    electron: process.versions.electron ?? ''
  }));

  // Překlady produktů
  handle('ptrans:overview', () => ptrans.overview());
  handle('ptrans:saveSettings', (patch: any) => ptrans.savePtransSettings(patch ?? {}));
  handle('ptrans:refresh', () => ptrans.refreshFromUrl());
  handle('ptrans:list', (query: any) => ptrans.listProducts(query ?? {}));
  /** Kódy všech produktů podle filtru — pro „vybrat vše", ne jen aktuální stránku */
  handle('ptrans:codes', (query: any) => ptrans.listCodes(query ?? {}));
  handle('ptrans:fields', (code: string, langs?: string[]) => ptrans.productFields(code, langs));
  handle('ptrans:edit', (code: string, lang: string, field: string, value: string) => {
    ptrans.editField(code, lang, field, String(value ?? ''));
    return true;
  });
  handle('ptrans:retranslate', (code: string, lang: string, field: string) =>
    ptrans.retranslateField(code, lang, field));
  handle('ptrans:run', (input: any) => ptrans.run(input ?? { codes: [] }));
  handle('ptrans:stop', () => { ptrans.stop(); return true; });
  handle('ptrans:progress', () => ptrans.progress());
  handle('ptrans:plan', (codes: string[], langs: string[], options: any) =>
    ptrans.planWork(codes ?? [], langs ?? [], options ?? {}).length);
  handle('ptrans:googleTitles', (codes: string[], langs?: string[]) =>
    ptrans.applyGoogleTitles(codes ?? [], langs));
  handle('ptrans:templatePreview', (template: string, code: string, lang: string) =>
    ptrans.previewTemplate(template ?? '', code, lang));
  handle('ptrans:generateSeo', (code: string, lang: string, kind: string) =>
    ptrans.generateSeo(code, lang, kind as any));
  handle('ptrans:seoUrl', (code: string, lang: string) => ptrans.refreshSeoUrl(code, lang));
  handle('ptrans:redirectPreview', (code: string, lang: string, slug: string) =>
    ptrans.redirectPreview(code, lang, slug));
  /**
   * Stav projektů Supabase — kdy se který naposledy ozval.
   *
   * Aplikace jich používá víc (chat, úložiště médií pro Instagram) a můžou
   * to být i dva různé projekty. Bezplatný tarif každý z nich po pár dnech
   * ticha uspí.
   */
  handle('supabase:status', () => keepalive.status());
  handle('supabase:ping', async () => {
    const result = await keepalive.keepAwake(true);
    return { result, status: keepalive.status() };
  });

  /* ---------- objednávky z feedu e-shopu ---------- */
  handle('orderfeed:list', () => ({ feeds: orderfeed.feedStatuses(), stats: orderfeed.orderStats() }));
  handle('orderfeed:save', (feeds: any[]) => {
    orderfeed.saveOrderFeeds(feeds ?? []);
    return { feeds: orderfeed.feedStatuses(), stats: orderfeed.orderStats() };
  });
  handle('orderfeed:refresh', async (id?: string) => {
    const result = id ? [{ feed: id, orders: (await orderfeed.refreshFeed(id)).orders }]
      : await orderfeed.refreshDueFeeds(true);
    emit('orderfeed:changed', {});
    return { result, feeds: orderfeed.feedStatuses(), stats: orderfeed.orderStats() };
  });
  handle('orderfeed:contact', (input: any) => orderfeed.lookupContact(input ?? {}));
  handle('orderfeed:byEmail', (email: string, limit?: number) =>
    orderfeed.ordersByEmail(email, limit ?? 12));
  handle('orderfeed:byCode', (code: string) => orderfeed.orderByCode(code));

  handle('ptrans:exportPreview', (options: any) => ptrans.exportPreview(options ?? {}));
  handle('ptrans:export', (options: any) => ptrans.exportToFile(options ?? {}));
  handle('ptrans:importFile', () => ptrans.importFromFile());
  handle('ptrans:consistency', (lang: string) => ptrans.consistencyCheck(lang));
  handle('ptrans:suggestPattern', (category: string, lang: string) => ptrans.suggestPattern(category, lang));
  handle('ptrans:proposeFix', (code: string, lang: string) => ptrans.proposeFix(code, lang));
  handle('ptrans:acceptFix', (code: string, lang: string, value: string) =>
    ptrans.acceptFix(code, lang, value));
  handle('ptrans:trials', (lang?: string) => ptrans.styleTrials(lang));
  handle('ptrans:chooseVariant', (id: number, pick: 'a' | 'b') => ptrans.chooseVariant(id, pick));
  handle('ptrans:dropTrial', (id: number) => ptrans.dropTrial(id));
  handle('ptrans:dropStyle', (lang: string, category: string, kind: string) =>
    ptrans.dropStyle(lang, category, kind));
  handle('ptrans:memory', (filter: any) => ({
    entries: ptrans.listMemory(filter ?? {}),
    stats: ptrans.memoryStats()
  }));
  handle('ptrans:learn', (langs?: string[]) => ptrans.learnMemory(langs));
  handle('ptrans:saveMemory', (entry: any) => ptrans.editMemory(entry));
  handle('ptrans:deleteMemory', (id: number) => { ptrans.deleteMemory(id); return true; });

  /* ---------- feed: srovnat, nebo jen donačíst nové ---------- */
  handle('ptrans:refreshNew', () => ptrans.refreshNewOnly());
  handle('ptrans:revert', (codes: string[], keepManual?: boolean) =>
    ptrans.revertProducts(codes ?? [], !!keepManual));

  /* ---------- Google Nákupy ---------- */
  handle('ptrans:google', (code: string, langs?: string[]) => ptrans.googleView(code, langs));
  handle('ptrans:googleWrite', (code: string, lang: string, kind: string) =>
    ptrans.writeGoogle(code, lang, kind as any));
  handle('ptrans:googleFill', (codes: string[], langs?: string[], force?: boolean) =>
    ptrans.fillAttributes(codes ?? [], langs, !!force));
  handle('ptrans:googleRules', () => ptrans.getAttributeRules());
  handle('ptrans:saveGoogleRules', (patch: any) => ptrans.saveAttributeRules(patch ?? {}));
  handle('ptrans:colors', (search?: string) => ({
    rules: ptrans.listColorRules(search),
    base: ptrans.BASE_COLORS
  }));
  handle('ptrans:learnColors', () => ptrans.learnColorMap());
  handle('ptrans:saveColor', (source: string, base: string) => ptrans.saveColor(source, base));
  handle('ptrans:deleteColor', (source: string) => { ptrans.deleteColorRule(source); return true; });
  handle('ptrans:bundles', () => ({
    rules: ptrans.listBundleRules(),
    preview: ptrans.bundlePreview()
  }));
  handle('ptrans:markBundle', (code: string, isBundle: boolean, langs?: string[]) =>
    ptrans.markBundle(code, isBundle, langs));
  handle('ptrans:deleteBundleRule', (category: string, pattern: string) => {
    ptrans.deleteBundleRule(category, pattern); return true;
  });

  /* ---------- audit feedu ---------- */
  handle('ptrans:audit', (options: any) => ptrans.audit(options ?? {}));
  handle('ptrans:auditOf', (code: string, langs?: string[]) => ptrans.auditOf(code, langs));
  handle('ptrans:worst', (lang: string, limit?: number) => ptrans.worstProducts(lang, limit ?? 60));
  handle('ptrans:auditSummary', () => ptrans.storedSummary());

  /* ---------- doplnění textů ve zdrojovém jazyce ---------- */
  handle('ptrans:sourceGaps', (codes: string[]) => ptrans.sourceGaps(codes ?? []));
  handle('ptrans:fillSource', (options: any) => ptrans.fillSourceTexts(options ?? { codes: [] }));
  handle('ptrans:fixIssues', (code: string, lang: string, keys?: string[]) =>
    ptrans.fixIssues(code, lang, keys));
  handle('ptrans:tidy', (codes: string[]) => ptrans.tidyDescriptions(codes ?? []));
  handle('ptrans:tidyPreview', (code: string) => ptrans.tidyPreview(code));

  /* ---------- Články (jen na počítači) ---------- */
  handle('articles:overview', () => articles.overview());
  handle('articles:saveSettings', (patch: any) => articles.saveArticleSettings(patch ?? {}));
  handle('articles:defaultPrompt', () => articles.defaultArticlePrompt());
  handle('articles:list', (filter: any) => articles.listArticles(filter ?? {}));
  handle('articles:get', (id: number) => articles.getArticle(id));
  handle('articles:save', (input: any) => articles.saveArticle(input ?? {}));
  handle('articles:delete', (id: number) => { articles.deleteArticle(id); return true; });
  handle('articles:editVersion', (id: number, lang: string, patch: any) =>
    articles.editVersion(id, lang, patch ?? {}));
  handle('articles:generate', (input: any) => articles.generateArticle(input));
  handle('articles:translate', (id: number, langs: string[], force?: boolean) =>
    articles.translateArticle(id, langs ?? [], !!force));
  handle('articles:progress', () => articles.articleProgress());
  handle('articles:stop', () => { articles.stopArticles(); return true; });
  handle('articles:terms', (topic: string, lang: string, title?: string) =>
    articles.researchTerms(topic, lang, title ?? ''));
  handle('articles:products', (codes: string[], lang: string) =>
    articles.productsForArticle(codes ?? [], lang));
  handle('articles:preview', (id: number, lang: string) => articles.preview(id, lang));
  handle('articles:links', (id: number, lang: string) => articles.articleLinks(id, lang));
  handle('articles:review', (id: number, lang: string) => articles.articleReview(id, lang));
  handle('articles:testUrl', (url: string) => articles.testUrl(url));
  handle('articles:dismissLink', (id: number, lang: string, url: string) =>
    articles.dismissLink(id, lang, url));
  handle('articles:import', () => articles.importFromFile());
  handle('articles:export', (input: any) => articles.exportToFile(input ?? {}));
  handle('articles:check', (options: any) => articles.checkLinks(options ?? {}));
  handle('articles:lastCheck', () => articles.lastCheck());
  handle('articles:checkProgress', () => articles.checkProgress());
  handle('articles:stopCheck', () => { articles.stopCheck(); return true; });
  handle('articles:fix', (id: number, lang: string, from: string, to: string) =>
    articles.applyFix(id, lang, from, to));
  handle('articles:fixAll', (ids?: number[]) => articles.applyAllFixes(ids));
  handle('articles:urlmap', (filter: any) => articles.listUrlMap(filter ?? {}));
  handle('articles:learnLinks', () => articles.learnLinks());
  handle('articles:saveUrlPair', (fromLang: string, fromPath: string, toLang: string, toPath: string, kind: string) =>
    articles.saveUrlPair(fromLang, fromPath, toLang, toPath, kind ?? 'other'));
  handle('articles:deleteUrlPair', (fromLang: string, fromPath: string, toLang: string) => {
    articles.deletePair(fromLang, fromPath, toLang); return true;
  });

  // Instagram (vlastní modul)
  registerIgIpc();

  // Chat na e-shopu
  registerChatIpc();
}
