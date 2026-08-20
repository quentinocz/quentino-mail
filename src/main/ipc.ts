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
import { searchProducts, refreshFeed, feedStatus, listProducts, productFacets } from './products';
import { searchContacts } from './contacts';
import { getSyncConfig, saveSyncConfig, runSync } from './appsync';
import { summarize, generateReply, improveText, translateIncoming, translateText, categorizeUncategorized, getAiUsage, generateDigest } from './ai';
import { getUpgatesConfig, saveUpgatesConfig, testUpgates, ordersByEmail } from './upgates';
import { buildOrderCard, buildOrderBadge, resetShopDomains } from './ordercard';
import { clearTrackingCache } from './ordertrack';
import { scanOrders, setItemPacked, setOrderDone, resetPacking } from './packing';
import { refreshOrderLinks, pendingCount, setOrderReplyResolved } from './orderlink';
import * as ptrans from './ptrans';
import { customerContext, customerConversation, messageText } from './customer';
import { relearnPhase } from './shipphase';
import { createVouchers } from './voucher';
import {
  listTemplates, saveTemplate, deleteTemplate, addCodes, listCodes, deleteCode,
  takeCode, releaseCode, specFromTemplate
} from './vouchers';
import { listOutbox, cancelOutbox, processOutbox } from './scheduler';
import { getDb } from './db';
import { registerIgIpc } from './instagram/ipc';
import { registerChatIpc } from './chat/ipc';
import { refreshWatchers } from './idle';

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

  // Šablony poukazů a zásoba kódů
  handle('vouchers:list', () => listTemplates());
  handle('vouchers:save', (t: any) => saveTemplate(t));
  handle('vouchers:delete', (id: string) => deleteTemplate(id));
  handle('vouchers:addCodes', (id: string, raw: string) => addCodes(id, raw ?? ''));
  handle('vouchers:codes', (id: string) => listCodes(id));
  handle('vouchers:deleteCode', (id: string, code: string) => deleteCode(id, code));
  handle('vouchers:release', (id: string, code: string) => releaseCode(id, code));
  /** Odebere kód ze šablony a rovnou z něj vysází PDF do přílohy */
  handle('vouchers:use', async (id: string, forWhom: string) => {
    const { code, remaining } = takeCode(id, forWhom ?? '');
    try {
      const files = await createVouchers(specFromTemplate(id, code));
      return { code, remaining, files };
    } catch (e) {
      releaseCode(id, code); // sazba selhala — kód se vrací do zásoby
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
  handle('shell:openUrl', (url: string) => {
    if (typeof url === 'string' && url.startsWith('https://')) shell.openExternal(url);
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

  // Překlady produktů
  handle('ptrans:overview', () => ptrans.overview());
  handle('ptrans:saveSettings', (patch: any) => ptrans.savePtransSettings(patch ?? {}));
  handle('ptrans:refresh', () => ptrans.refreshFromUrl());
  handle('ptrans:list', (query: any) => ptrans.listProducts(query ?? {}));
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
  handle('ptrans:exportPreview', (options: any) => ptrans.exportPreview(options ?? {}));
  handle('ptrans:export', (options: any) => ptrans.exportToFile(options ?? {}));
  handle('ptrans:importFile', () => ptrans.importFromFile());
  handle('ptrans:consistency', (lang: string) => ptrans.consistencyCheck(lang));
  handle('ptrans:suggestPattern', (category: string, lang: string) => ptrans.suggestPattern(category, lang));

  // Instagram (vlastní modul)
  registerIgIpc();

  // Chat na e-shopu
  registerChatIpc();
}
