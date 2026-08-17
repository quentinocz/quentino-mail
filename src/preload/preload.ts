import { contextBridge, ipcRenderer } from 'electron';

const invoke = (channel: string, ...args: any[]) => ipcRenderer.invoke(channel, ...args);

const on = (channel: string, cb: (payload: any) => void) => {
  const listener = (_e: any, payload: any) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

const ALLOWED_INVOKE = [
  'accounts:list', 'accounts:save', 'accounts:delete', 'accounts:test',
  'folders:list', 'sync:folder', 'sync:all',
  'messages:list', 'messages:get', 'messages:thread', 'messages:setFlag',
  'messages:delete', 'messages:move', 'messages:archive', 'messages:categorize',
  'messages:bulkFlag', 'messages:bulkDelete', 'messages:bulkArchive', 'trash:empty',
  'send:now', 'send:schedule', 'outbox:list', 'outbox:cancel', 'outbox:processNow',
  'settings:get', 'settings:save',
  'knowledge:list', 'knowledge:save', 'knowledge:delete', 'knowledge:importFile',
  'persons:list', 'persons:save', 'persons:delete',
  'config:export', 'config:import', 'config:importUnlock',
  'products:search', 'products:refresh', 'products:status', 'products:list', 'products:facets',
  'contacts:search',
  'appsync:get', 'appsync:save', 'appsync:run', 'appsync:pickFolder',
  'ai:summarize', 'ai:reply', 'ai:improve', 'ai:translateIncoming', 'ai:translateText',
  'ai:usage', 'ai:digest', 'quota:get', 'shell:openUrl',
  'upgates:config', 'upgates:saveConfig', 'upgates:test', 'upgates:orders',
  'orders:card', 'orders:badge', 'orders:refresh', 'orders:shipment',
  'voucher:create', 'ship:relearn', 'customer:context', 'customer:conversation', 'customer:messageText', 'orderlinks:refresh', 'orderlinks:pending', 'orderlinks:resolve',
  'packing:scan', 'packing:setItem', 'packing:setDone', 'packing:reset',
  'messages:exportPdf', 'files:saveTempImage',
  'files:openAttachment', 'files:showInFolder', 'files:pickAttachments', 'files:pickImage', 'files:readAsDataUrl',
  'stats:categories'
];

const ALLOWED_EVENTS = ['sync:state', 'messages:changed', 'folders:changed', 'outbox:changed', 'products:changed', 'packing:progress'];

contextBridge.exposeInMainWorld('api', {
  invoke: (channel: string, ...args: any[]) => {
    if (!ALLOWED_INVOKE.includes(channel)) return Promise.resolve({ ok: false, error: 'Nepovolený kanál' });
    return invoke(channel, ...args);
  },
  on: (channel: string, cb: (payload: any) => void) => {
    if (!ALLOWED_EVENTS.includes(channel)) return () => {};
    return on(channel, cb);
  }
});
