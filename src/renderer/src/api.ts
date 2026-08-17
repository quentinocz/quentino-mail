import type {
  AccountConfig, AccountPublic, FolderInfo, MessageHeader, MessageFull,
  ComposeDraft, OutboxItem, Settings, AiReplyRequest, KnowledgeDoc, Person, ProductHit, FeedStatus, ContactHit,
  ProductQuery, ProductPage, ProductFacets,
  UpgatesOrder, UpgatesConfig, OrderCard, OrderBadge, OrderTracking, PackingScan, CustomerContext, VoucherSpec
} from '@shared/types';

declare global {
  interface Window {
    api: {
      invoke: (channel: string, ...args: any[]) => Promise<{ ok: boolean; data?: any; error?: string }>;
      on: (channel: string, cb: (payload: any) => void) => () => void;
    };
  }
}

async function call<T>(channel: string, ...args: any[]): Promise<T> {
  const res = await window.api.invoke(channel, ...args);
  if (!res.ok) throw new Error(res.error ?? 'Neznámá chyba');
  return res.data as T;
}

export const api = {
  accounts: {
    list: () => call<AccountPublic[]>('accounts:list'),
    save: (cfg: AccountConfig) => call<AccountPublic>('accounts:save', cfg),
    delete: (id: number) => call<void>('accounts:delete', id),
    test: (cfg: any) => call<boolean>('accounts:test', cfg)
  },
  folders: {
    list: (accountId: number, refresh = false) => call<FolderInfo[]>('folders:list', accountId, refresh)
  },
  sync: {
    folder: (accountId: number, folder: string) => call<void>('sync:folder', accountId, folder),
    all: () => call<void>('sync:all')
  },
  messages: {
    list: (accountId: number, folder: string, opts: any = {}) =>
      call<MessageHeader[]>('messages:list', accountId, folder, opts),
    get: (dbId: number) => call<MessageFull>('messages:get', dbId),
    thread: (dbId: number) => call<MessageHeader[]>('messages:thread', dbId),
    setFlag: (dbId: number, flag: 'seen' | 'flagged', value: boolean) =>
      call<void>('messages:setFlag', dbId, flag, value),
    delete: (dbId: number) => call<void>('messages:delete', dbId),
    move: (dbId: number, folder: string) => call<void>('messages:move', dbId, folder),
    archive: (dbId: number) => call<string>('messages:archive', dbId),
    categorize: (accountId: number, folder: string) => call<void>('messages:categorize', accountId, folder),
    bulkFlag: (ids: number[], flag: 'seen' | 'flagged', value: boolean) => call<void>('messages:bulkFlag', ids, flag, value),
    bulkDelete: (ids: number[]) => call<void>('messages:bulkDelete', ids),
    bulkArchive: (ids: number[], deleteAfter: boolean) => call<void>('messages:bulkArchive', ids, deleteAfter)
  },
  trash: {
    empty: (accountId: number) => call<number>('trash:empty', accountId)
  },
  send: {
    now: (draft: ComposeDraft) => call<void>('send:now', draft),
    schedule: (draft: ComposeDraft) => call<number>('send:schedule', draft)
  },
  outbox: {
    list: () => call<OutboxItem[]>('outbox:list'),
    cancel: (id: number) => call<void>('outbox:cancel', id),
    processNow: () => call<void>('outbox:processNow')
  },
  settings: {
    get: () => call<Settings>('settings:get'),
    save: (s: Partial<Settings>) => call<void>('settings:save', s)
  },
  contacts: {
    search: (q: string) => call<ContactHit[]>('contacts:search', q)
  },
  products: {
    search: (q: string) => call<ProductHit[]>('products:search', q),
    /** Stránkované procházení katalogu (hledání, kategorie, řazení) */
    list: (q: ProductQuery) => call<ProductPage>('products:list', q),
    /** Kategorie s počty produktů pro filtr */
    facets: () => call<ProductFacets>('products:facets'),
    refresh: () => call<FeedStatus>('products:refresh'),
    status: () => call<FeedStatus>('products:status')
  },
  persons: {
    list: () => call<Person[]>('persons:list'),
    save: (p: {
      id?: number; name: string;
      positions: { cz: string; sk: string; en: string };
      displayNames?: { cz: string; sk: string; en: string };
      photoPath?: string | null;
    }) => call<Person[]>('persons:save', p),
    delete: (id: number) => call<Person[]>('persons:delete', id)
  },
  config: {
    /** Kompletní záloha (účty s hesly, API klíče, obrázky); heslo ji zamkne */
    export: (passphrase?: string) => call<string | null>('config:export', passphrase ?? ''),
    import: () => call<{ message?: string; needPassphrase?: boolean } | null>('config:import'),
    /** Dokončí import zálohy zamčené heslem */
    importUnlock: (passphrase: string) => call<{ message: string }>('config:importUnlock', passphrase)
  },
  knowledge: {
    list: () => call<KnowledgeDoc[]>('knowledge:list'),
    save: (doc: { id?: number; title: string; content: string }) => call<KnowledgeDoc[]>('knowledge:save', doc),
    delete: (id: number) => call<KnowledgeDoc[]>('knowledge:delete', id),
    importFile: () => call<{ title: string; content: string } | null>('knowledge:importFile')
  },
  ai: {
    summarize: (dbId: number) => call<string>('ai:summarize', dbId),
    reply: (req: AiReplyRequest) => call<string>('ai:reply', req),
    improve: (text: string, mode: 'improve' | 'grammar') => call<string>('ai:improve', text, mode),
    translateIncoming: (dbId: number) => call<{ lang: string; translation: string }>('ai:translateIncoming', dbId),
    translateText: (text: string, lang: string) => call<string>('ai:translateText', text, lang),
    usage: () => call<{ month: string; calls: number; inputTokens: number; outputTokens: number; estUsd: number }>('ai:usage'),
    digest: () => call<string>('ai:digest')
  },
  upgates: {
    config: () => call<UpgatesConfig>('upgates:config'),
    saveConfig: (cfg: { url?: string; login?: string; apiKey?: string }) => call<UpgatesConfig>('upgates:saveConfig', cfg),
    test: () => call<string>('upgates:test'),
    orders: (email: string) => call<UpgatesOrder[]>('upgates:orders', email)
  },
  orders: {
    /** Přehled objednávky vyčtený z potvrzovacího e-mailu (null = není objednávka) */
    card: (dbId: number, withLive = true) => call<OrderCard | null>('orders:card', dbId, withLive),
    /** Jen číslo, částka a stav — pro odznak v seznamu zpráv */
    badge: (dbId: number) => call<OrderBadge | null>('orders:badge', dbId),
    /** Znovu načte stav ze stránky e-shopu i od dopravce (obejde cache) */
    refresh: (dbId: number) => call<OrderCard | null>('orders:refresh', dbId),
    /** Dotáhne stav zásilky u dopravců, kteří ho vypisují až JavaScriptem */
    shipment: (dbId: number, force = false) => call<OrderTracking | null>('orders:shipment', dbId, force)
  },
  voucher: {
    /** Vytvoří PDF poukazy (jeden na každý kód) a vrátí cesty k souborům */
    create: (spec: VoucherSpec) => call<string[]>('voucher:create', spec)
  },
  ship: {
    /** Ruční oprava zařazení hlášky dopravce; aplikace si ji zapamatuje */
    relearn: (text: string, phase: string) => call<void>('ship:relearn', text, phase)
  },
  customer: {
    /** Historie komunikace a objednávky podle e-mailu */
    context: (email: string) => call<CustomerContext>('customer:context', email),
    /** Konverzace i s texty zpráv, které už jsou stažené */
    conversation: (email: string) => call<CustomerContext>('customer:conversation', email),
    /** Text jedné zprávy bez citací (stáhne tělo, pokud chybí) */
    messageText: (dbId: number) => call<string>('customer:messageText', dbId)
  },
  orderLinks: {
    /** Přeindexuje objednávky a jejich vazby na příchozí poštu */
    refresh: () => call<{ orders: number; links: number }>('orderlinks:refresh'),
    pending: (accountId: number | null) => call<number>('orderlinks:pending', accountId),
    resolve: (dbId: number, value: boolean) => call<void>('orderlinks:resolve', dbId, value)
  },
  packing: {
    /** Projde objednávkové maily za posledních `days` dní */
    scan: (days: number, force = false) => call<PackingScan>('packing:scan', days, force),
    setItem: (dbId: number, index: number, value: boolean) => call<number[]>('packing:setItem', dbId, index, value),
    setDone: (dbId: number, value: boolean) => call<void>('packing:setDone', dbId, value),
    reset: (dbId: number) => call<void>('packing:reset', dbId)
  },
  pdf: {
    export: (fileName: string, html: string) => call<string | null>('messages:exportPdf', fileName, html)
  },
  quota: {
    get: (accountId: number) => call<{ used: number; limit: number } | null>('quota:get', accountId)
  },
  shell: {
    openUrl: (url: string) => call<void>('shell:openUrl', url)
  },
  appsync: {
    get: () => call<{ folder: string | null; enabled: boolean; lastRun: string | null; lastResult: string | null }>('appsync:get'),
    save: (cfg: { folder?: string | null; enabled?: boolean }) =>
      call<{ folder: string | null; enabled: boolean; lastRun: string | null; lastResult: string | null }>('appsync:save', cfg),
    run: () => call<string>('appsync:run'),
    pickFolder: () => call<string | null>('appsync:pickFolder')
  },
  files: {
    openAttachment: (p: string) => call<void>('files:openAttachment', p),
    showInFolder: (p: string) => call<void>('files:showInFolder', p),
    pickAttachments: () => call<string[]>('files:pickAttachments'),
    pickImage: () => call<string | null>('files:pickImage'),
    readAsDataUrl: (p: string) => call<string>('files:readAsDataUrl', p),
    saveTempImage: (name: string, base64: string) => call<string>('files:saveTempImage', name, base64)
  },
  stats: {
    categories: (accountId: number) =>
      call<Record<string, { cnt: number; unseen: number }>>('stats:categories', accountId)
  },
  on: (channel: string, cb: (payload: any) => void) => window.api.on(channel, cb)
};
