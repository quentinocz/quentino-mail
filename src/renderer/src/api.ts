import type {
  AccountConfig, AccountPublic, FolderInfo, MessageHeader, MessageFull,
  ComposeDraft, OutboxItem, Settings, AiReplyRequest, KnowledgeDoc, Person, ProductHit, FeedStatus, ContactHit,
  ProductQuery, ProductPage, ProductFacets,
  UpgatesOrder, UpgatesConfig, OrderCard, OrderBadge, OrderTracking, PackingScan, CustomerContext, VoucherSpec,
  VoucherTemplate,
  IgOverview, IgMarket, IgBrand, IgSourcePost, IgPost, IgJob, IgChannels,
  ChatOverview, ChatConfig, ChatConversation, ChatMessage, ChatProduct,
  PtransOverview, PtransSettings, PtransQuery, PtransPage, PtransField, PtransProgress, PtransConsistency,
  PtransMemoryEntry, PtransMemoryKind, PtransMemoryStat, PtransLearnResult,
  PtransGoogleView, PtransColorRule, PtransBaseColor, PtransBundleRule, PtransAttributeRules,
  PtransAudit, PtransAuditSummary,
  ArticleOverview, ArticleSettings, ArticleListRow, ArticleDetail, ArticleBrief, ArticleProgress,
  ArticleCheckProgress, ArticleLinkCheck, ArticleUrlPair, ArticleProduct
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
  /** Verze běžící aplikace */
  app: {
    version: () => call<{ version: string; platform: string; electron: string }>('app:version')
  },

  /** Překlady produktů — jen na počítači */
  ptrans: {
    overview: () => call<PtransOverview>('ptrans:overview'),
    saveSettings: (patch: Partial<PtransSettings>) => call<PtransSettings>('ptrans:saveSettings', patch),
    refresh: () => call<{ products: number; fields: number; removed: number; at: string }>('ptrans:refresh'),
    list: (query: PtransQuery) => call<PtransPage>('ptrans:list', query),
    fields: (code: string, langs?: string[]) => call<PtransField[]>('ptrans:fields', code, langs),
    edit: (code: string, lang: string, field: string, value: string) =>
      call<boolean>('ptrans:edit', code, lang, field, value),
    retranslate: (code: string, lang: string, field: string) =>
      call<string>('ptrans:retranslate', code, lang, field),
    /** Kolik polí by se přeložilo — pro odhad před spuštěním */
    plan: (codes: string[], langs: string[], options: { force?: boolean; fields?: string[] } = {}) =>
      call<number>('ptrans:plan', codes, langs, options),
    /**
     * `fillSource` doplní před překladem texty, které chybí ve zdrojovém
     * jazyce — přeložit se dá jen to, co existuje.
     */
    run: (input: {
      codes: string[]; langs?: string[]; fields?: string[]; force?: boolean;
      fillSource?: boolean; sourceFields?: string[]; forceSource?: boolean;
    }) =>
      call<{ done: number; failed: number; seconds: number; errors: string[] }>('ptrans:run', input),
    stop: () => call<boolean>('ptrans:stop'),
    progress: () => call<PtransProgress | null>('ptrans:progress'),
    googleTitles: (codes: string[], langs?: string[]) =>
      call<{ written: number; skipped: number }>('ptrans:googleTitles', codes, langs),
    templatePreview: (template: string, code: string, lang: string) =>
      call<string>('ptrans:templatePreview', template, code, lang),
    generateSeo: (code: string, lang: string, kind: 'seo_title' | 'seo_desc' | 'google_desc') =>
      call<string>('ptrans:generateSeo', code, lang, kind),
    seoUrl: (code: string, lang: string) => call<string>('ptrans:seoUrl', code, lang),
    /** Co se doplní do přesměrování, když se adresa změní */
    redirectPreview: (code: string, lang: string, slug: string) =>
      call<{ oldPath: string; list: string[] }>('ptrans:redirectPreview', code, lang, slug),
    exportPreview: (options: { langs?: string[]; codes?: string[]; state?: 'translated' | 'current' } = {}) =>
      call<{ products: number; fields: number }>('ptrans:exportPreview', options),
    /**
     * `state: 'current'` vezme vybrané produkty tak, jak jsou teď — překlad,
     * kde je, a hodnotu z feedu, kde není. Výchozí `translated` bere jen to,
     * co aplikace sama vyrobila.
     */
    export: (options: {
      langs?: string[]; codes?: string[]; mode?: 'slim' | 'full';
      includeSource?: boolean; state?: 'translated' | 'current';
    } = {}) =>
      call<{ path: string; products: number; fields: number } | null>('ptrans:export', options),
    /** Přidá produkty z ručně vybraného XML (novinky, které ještě nejsou ve feedu) */
    importFile: () => call<{ products: number; fields: number; paired: number; file: string } | null>('ptrans:importFile'),
    consistency: (lang: string) => call<PtransConsistency>('ptrans:consistency', lang),
    suggestPattern: (category: string, lang: string) => call<string>('ptrans:suggestPattern', category, lang),
    /** Paměť překladů — co se aplikace naučila z hotových jazykových mutací */
    memory: (filter: { lang?: string; kind?: PtransMemoryKind; search?: string } = {}) =>
      call<{ entries: PtransMemoryEntry[]; stats: PtransMemoryStat[] }>('ptrans:memory', filter),
    learn: (langs?: string[]) => call<PtransLearnResult[]>('ptrans:learn', langs),
    saveMemory: (entry: PtransMemoryEntry) => call<PtransMemoryEntry[]>('ptrans:saveMemory', entry),
    deleteMemory: (id: number) => call<boolean>('ptrans:deleteMemory', id),

    /** Stáhne feed a vezme z něj jen produkty, které aplikace ještě nezná */
    refreshNew: () => call<{ products: number; fields: number; removed: number; at: string }>('ptrans:refreshNew'),
    /** Zahodí, co aplikace vymyslela, a nechá platit stav z e-shopu */
    revert: (codes: string[], keepManual = false) =>
      call<{ fields: number; products: number }>('ptrans:revert', codes, keepManual),

    /** Atributy pro Google Nákupy u jednoho produktu, po jazycích */
    google: (code: string, langs?: string[]) => call<PtransGoogleView[]>('ptrans:google', code, langs),
    /** Nechá model napsat titulek nebo popis pro Google */
    googleWrite: (code: string, lang: string, kind: 'google_title' | 'google_desc') =>
      call<string>('ptrans:googleWrite', code, lang, kind),
    /** Zapíše číselníky (barva, pohlaví, věk, stav, set) vybraným produktům */
    googleFill: (codes: string[], langs?: string[], force = false) =>
      call<{ written: number; skipped: number }>('ptrans:googleFill', codes, langs, force),
    googleRules: () => call<PtransAttributeRules>('ptrans:googleRules'),
    saveGoogleRules: (patch: Partial<PtransAttributeRules>) =>
      call<PtransAttributeRules>('ptrans:saveGoogleRules', patch),

    colors: (search?: string) =>
      call<{ rules: PtransColorRule[]; base: PtransBaseColor[] }>('ptrans:colors', search),
    learnColors: () =>
      call<{ products: number; learned: number; unknown: string[] }>('ptrans:learnColors'),
    saveColor: (source: string, base: string) => call<PtransColorRule[]>('ptrans:saveColor', source, base),
    deleteColor: (source: string) => call<boolean>('ptrans:deleteColor', source),

    bundles: () => call<{
      rules: PtransBundleRule[];
      preview: { total: number; bundles: number; samples: { code: string; title: string; reason: string }[] };
    }>('ptrans:bundles'),
    /** Otočí rozhodnutí o setu — a naučí se z toho pravidlo */
    markBundle: (code: string, isBundle: boolean, langs?: string[]) =>
      call<PtransBundleRule | null>('ptrans:markBundle', code, isBundle, langs),
    deleteBundleRule: (category: string, pattern: string) =>
      call<boolean>('ptrans:deleteBundleRule', category, pattern),

    /** Audit kvality feedu — co brání dohledatelnosti produktů */
    audit: (options: { codes?: string[]; langs?: string[]; includeInactive?: boolean } = {}) =>
      call<PtransAuditSummary>('ptrans:audit', options),
    auditOf: (code: string, langs?: string[]) => call<PtransAudit[]>('ptrans:auditOf', code, langs),
    worst: (lang: string, limit = 60) =>
      call<{ code: string; title: string; score: number; errors: number }[]>('ptrans:worst', lang, limit),
    /** Souhrn z posledního auditu, bez nového počítání */
    auditSummary: () => call<(PtransAuditSummary & { checkedAt: string | null }) | null>('ptrans:auditSummary'),
    /** Kolik zdrojových textů u výběru chybí — po polích */
    sourceGaps: (codes: string[]) => call<{
      fields: { field: string; label: string; missing: number }[];
      total: number;
      sourceLang: string;
    }>('ptrans:sourceGaps', codes),
    /** Doplnit zdrojové texty bez překladu */
    fillSource: (options: { codes: string[]; fields?: string[]; force?: boolean }) =>
      call<{ done: number; failed: number; errors: string[] }>('ptrans:fillSource', options),
    /** Spraví vady, které audit označil jako opravitelné */
    fixIssues: (code: string, lang: string, keys?: string[]) =>
      call<{ fixed: string[]; skipped: string[] }>('ptrans:fixIssues', code, lang, keys)
  },
  /** Články pro e-shop — psaní, překlad a kontrola odkazů. Jen na počítači. */
  articles: {
    overview: () => call<ArticleOverview>('articles:overview'),
    saveSettings: (patch: Partial<ArticleSettings>) => call<ArticleSettings>('articles:saveSettings', patch),
    defaultPrompt: () => call<string>('articles:defaultPrompt'),
    list: (filter: { search?: string; status?: string } = {}) => call<ArticleListRow[]>('articles:list', filter),
    get: (id: number) => call<ArticleDetail | null>('articles:get', id),
    save: (input: Record<string, unknown>) => call<number>('articles:save', input),
    delete: (id: number) => call<boolean>('articles:delete', id),
    editVersion: (id: number, lang: string, patch: Record<string, string>) =>
      call<ArticleDetail | null>('articles:editVersion', id, lang, patch),
    generate: (input: {
      articleId?: number; topic: string; title?: string; titleFixed?: boolean; langs: string[];
      wordCount?: number; brief?: Partial<ArticleBrief>; prompt?: string; force?: boolean;
    }) => call<{ id: number; langs: string[]; errors: string[] }>('articles:generate', input),
    translate: (id: number, langs: string[], force = false) =>
      call<{ langs: string[]; unresolved: { lang: string; url: string }[]; errors: string[] }>(
        'articles:translate', id, langs, force),
    progress: () => call<ArticleProgress | null>('articles:progress'),
    stop: () => call<boolean>('articles:stop'),
    terms: (topic: string, lang: string, title = '') => call<string>('articles:terms', topic, lang, title),
    products: (codes: string[], lang: string) => call<ArticleProduct[]>('articles:products', codes, lang),
    preview: (id: number, lang: string) =>
      call<{ title: string; html: string; words: number } | null>('articles:preview', id, lang),
    links: (id: number, lang: string) => call<string[]>('articles:links', id, lang),
    /** Článek vykreslený s očíslovanými odkazy — pro ruční kontrolu pohledem */
    review: (id: number, lang: string) => call<{
      title: string; html: string;
      links: { index: number; url: string; text: string; kind: string; status: number | null;
        note: string; suggestion: string | null; unverified: boolean }[];
    } | null>('articles:review', id, lang),
    /** Vyzkoušet jedinou adresu a vidět syrový výsledek — na ladění */
    testUrl: (url: string) => call<{ status: number | null; verdict: 'ok' | 'broken' | 'unknown'; note: string }>(
      'articles:testUrl', url),
    /** Vyřadit odkaz ze seznamu vad — text článku zůstane beze změny */
    dismissLink: (id: number, lang: string, url: string) =>
      call<boolean>('articles:dismissLink', id, lang, url),
    import: () => call<{ articles: number; updated: number; versions: number;
      learned: { articles: number; pairs: number; skipped: number }; file: string } | null>('articles:import'),
    export: (input: { ids?: number[]; langs?: string[]; onlyReady?: boolean } = {}) =>
      call<{ path: string; articles: number; versions: number } | null>('articles:export', input),
    check: (options: { articleIds?: number[]; langs?: string[]; images?: boolean;
      concurrency?: number; spacingMs?: number } = {}) =>
      call<ArticleLinkCheck[]>('articles:check', options),
    lastCheck: () => call<ArticleLinkCheck[]>('articles:lastCheck'),
    checkProgress: () => call<ArticleCheckProgress | null>('articles:checkProgress'),
    stopCheck: () => call<boolean>('articles:stopCheck'),
    fix: (id: number, lang: string, from: string, to: string) =>
      call<number>('articles:fix', id, lang, from, to),
    fixAll: (ids?: number[]) => call<number>('articles:fixAll', ids),
    urlmap: (filter: { fromLang?: string; toLang?: string; kind?: string; search?: string } = {}) =>
      call<ArticleUrlPair[]>('articles:urlmap', filter),
    learnLinks: () => call<{ articles: number; pairs: number; skipped: number }>('articles:learnLinks'),
    saveUrlPair: (fromLang: string, fromPath: string, toLang: string, toPath: string, kind = 'other') =>
      call<ArticleUrlPair[]>('articles:saveUrlPair', fromLang, fromPath, toLang, toPath, kind),
    deleteUrlPair: (fromLang: string, fromPath: string, toLang: string) =>
      call<boolean>('articles:deleteUrlPair', fromLang, fromPath, toLang)
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
  /** Šablony poukazů — hodnota, platnost a zásoba kódů; synchronizují se mezi zařízeními */
  vouchers: {
    list: () => call<VoucherTemplate[]>('vouchers:list'),
    save: (t: Partial<VoucherTemplate> & { name: string }) => call<VoucherTemplate[]>('vouchers:save', t),
    delete: (id: string) => call<VoucherTemplate[]>('vouchers:delete', id),
    addCodes: (id: string, raw: string) => call<{ added: number; skipped: number }>('vouchers:addCodes', id, raw),
    codes: (id: string) => call<{ code: string; usedAt: string | null; usedFor: string }[]>('vouchers:codes', id),
    deleteCode: (id: string, code: string) =>
      call<{ code: string; usedAt: string | null; usedFor: string }[]>('vouchers:deleteCode', id, code),
    /** Vrátí kód zpátky do zásoby (když se e-mail neodeslal) */
    release: (id: string, code: string) => call<void>('vouchers:release', id, code),
    /** Odebere kód a vysází z něj PDF poukaz do přílohy */
    use: (id: string, forWhom: string) =>
      call<{ code: string; remaining: number; files: string[] }>('vouchers:use', id, forWhom)
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
  /** Instagram — vícejazyčné publikování */
  ig: {
    overview: () => call<IgOverview>('ig:overview'),
    saveConnection: (p: {
      appId?: string; appSecret?: string; storageUrl?: string; storageBucket?: string;
      storageKey?: string; callbackUrl?: string; autoSync?: boolean;
    }) => call<IgOverview>('ig:saveConnection', p),
    /** Nahraje návratovou stránku do úložiště a vrátí její adresu pro Meta aplikaci */
    installCallback: () => call<string>('ig:installCallback'),
    testStorage: () => call<string>('ig:testStorage'),

    connect: (lang: string) => call<string>('ig:connect', lang),
    /** Přidá účet pro trh; `needsLogin` = je potřeba projít přihlášením v prohlížeči */
    addMarket: (lang: string) => call<{
      saved?: any;
      pick?: { igUserId: string; username: string; pageName: string }[];
      needsLogin?: boolean;
    }>('ig:addMarket', lang),
    connectToken: (lang: string, token: string) =>
      call<{ saved?: any; pick?: { igUserId: string; username: string; pageName: string }[] }>('ig:connectToken', lang, token),
    /** Dokončení přihlášení z adresy zkopírované z prohlížeče */
    pasteCallback: (url: string) =>
      call<{ saved?: any; pick?: { igUserId: string; username: string; pageName: string }[] }>('ig:pasteCallback', url),
    finishConnect: (igUserId: string) => call<any>('ig:finishConnect', igUserId),
    disconnect: (id: number) => call<void>('ig:disconnect', id),
    setSource: (id: number) => call<void>('ig:setSource', id),
    /** Zveřejňovat obsah i na Facebook stránce daného účtu */
    setShareFb: (id: number, value: boolean) => call<void>('ig:setShareFb', id, value),
    limit: (id: number) => call<{ used: number; cap: number } | null>('ig:limit', id),

    markets: () => call<IgMarket[]>('ig:markets'),
    saveMarket: (m: IgMarket) => call<IgMarket[]>('ig:saveMarket', m),
    deleteMarket: (lang: string) => call<IgMarket[]>('ig:deleteMarket', lang),
    brand: () => call<IgBrand>('ig:brand'),
    saveBrand: (b: Partial<IgBrand>) => call<IgBrand>('ig:saveBrand', b),

    feed: (limit = 60, offset = 0) => call<IgSourcePost[]>('ig:feed', limit, offset),
    sync: (full = false) => call<number>('ig:sync', full),
    /** Náhled příspěvku (stažený z Instagramu a uložený na disk) */
    thumb: (sourcePostId: number) => call<string | null>('ig:thumb', sourcePostId),
    createFromSource: (sourcePostId: number) => call<IgPost>('ig:createFromSource', sourcePostId),

    pickMedia: () => call<string[]>('ig:pickMedia'),
    preview: (file: string) => call<string | null>('ig:preview', file),
    createDraft: (files: string[], brief: string, mediaNote: string) =>
      call<IgPost>('ig:createDraft', files, brief, mediaNote),
    updateDraft: (postId: number, patch: { brief?: string; mediaNote?: string; files?: string[] }) =>
      call<IgPost>('ig:updateDraft', postId, patch),
    post: (id: number) => call<IgPost | null>('ig:post', id),
    drafts: () => call<IgPost[]>('ig:drafts'),
    deletePost: (id: number) => call<void>('ig:deletePost', id),
    warnings: (postId: number) => call<string[]>('ig:warnings', postId),

    generate: (postId: number, langs: string[]) => call<IgPost>('ig:generate', postId, langs),
    /** Prázdné popisky k ručnímu napsání */
    blankCaptions: (postId: number, langs: string[]) => call<IgPost>('ig:blankCaptions', postId, langs),
    chooseVariant: (captionId: number, index: number) => call<void>('ig:chooseVariant', captionId, index),
    editCaption: (captionId: number, text: string) => call<void>('ig:editCaption', captionId, text),
    publish: (captionId: number, at?: string | null, channels?: IgChannels) =>
      call<number>('ig:publish', captionId, at ?? null, channels),
    publishPost: (postId: number, at?: string | null, force = false, channels?: IgChannels) =>
      call<{ queued: number; skipped: string[] }>('ig:publishPost', postId, at ?? null, force, channels),
    /** Zkusí znovu jen sdílení na Facebook stránku */
    retryFacebook: (jobId: number) => call<void>('ig:retryFacebook', jobId),
    /** Zahodí uložený přístup a otevře přihlášení znovu (kvůli novým oprávněním) */
    relogin: (lang: string) => call<string>('ig:relogin', lang),

    jobs: () => call<IgJob[]>('ig:jobs'),
    cancelJob: (id: number) => call<void>('ig:cancelJob', id),
    retryJob: (id: number) => call<void>('ig:retryJob', id),
    runQueue: () => call<void>('ig:runQueue'),
    refreshTokens: () => call<{ refreshed: number; failed: string[] }>('ig:refreshTokens')
  },
  /** Chat na e-shopu (widget quentino.cz/.sk/.com) */
  chat: {
    overview: () => call<ChatOverview>('chat:overview'),
    saveConfig: (p: Partial<ChatConfig> & { anonKey?: string }) => call<ChatConfig>('chat:saveConfig', p),
    test: () => call<string>('chat:test'),

    conversations: (onlyOpen = true) => call<ChatConversation[]>('chat:conversations', onlyOpen),
    messages: (id: string) => call<ChatMessage[]>('chat:messages', id),
    /** `personId` 0 = tuhle zprávu nepodepisovat, undefined = podle nastavení */
    send: (id: string, text: string, personId?: number | null) =>
      call<ChatMessage[]>('chat:send', id, text, personId),
    /** Nahraje obrázek tam, kam ho nahrává widget, a pošle ho do konverzace */
    sendImage: (id: string, file: string) => call<ChatMessage[]>('chat:sendImage', id, file),
    markRead: (id: string) => call<void>('chat:markRead', id),
    setStatus: (id: string, status: 'open' | 'closed') => call<void>('chat:setStatus', id, status),

    /** Produktové karty k adresám ve zprávě */
    cards: (text: string) => call<ChatProduct[]>('chat:cards', text),
    searchProducts: (q: string) => call<ChatProduct[]>('chat:searchProducts', q),
    productInDomain: (id: string, domain: 'cz' | 'sk' | 'en') =>
      call<ChatProduct | null>('chat:productInDomain', id, domain),

    /** Návrh odpovědi podle průběhu konverzace a znalostní báze */
    suggest: (id: string, note = '') => call<string>('chat:suggest', id, note)
  },
  on: (channel: string, cb: (payload: any) => void) => window.api.on(channel, cb)
};
