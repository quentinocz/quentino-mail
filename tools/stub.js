// Napodobenina nativního mostu — vrací tolik, aby se rozhraní vykreslilo
(function () {
  const listeners = new Map();
  const settings = {
    hasApiKey: true, secretsLocked: false, brandPrompt: '', draftModel: 'claude-sonnet-5',
    fastModel: 'claude-haiku-4-5', autoSummarize: true, autoCategorize: true, autoTranslate: true,
    loadRemoteImages: false, notifyNewMail: true, categoryRules: [], autoSummarizeCategories: [],
    contactInfo: '', productFeedUrl: '', adminOrderRef: '', voucherLogo: '', defaultPersonId: 0, theme: 'light'
  };
  const accounts = [{
    id: 1, name: 'Quentino', email: 'info@quentino.cz', imapHost: 'imap.example.cz', imapPort: 993,
    imapSecure: true, smtpHost: 'smtp.example.cz', smtpPort: 465, smtpSecure: true,
    username: 'info@quentino.cz', signatureHtml: '', sigConfig: null, logoPath: null, color: '#7c5cff'
  }];
  const folders = [
    { path: 'INBOX', name: 'Doručená pošta', specialUse: null, unseen: 3, total: 128 },
    { path: 'Sent', name: 'Odeslaná pošta', specialUse: '\\Sent', unseen: 0, total: 64 },
    { path: 'Trash', name: 'Koš', specialUse: '\\Trash', unseen: 0, total: 12 }
  ];
  const subjects = [
    'Dotaz k objednávce 20260819', 'Reklamace — poškozený obal', 'Faktura 2026/0841',
    'Kdy dorazí zásilka?', 'Děkuji za rychlé vyřízení'
  ];
  const messages = Array.from({ length: 12 }, (_, i) => ({
    id: i + 1, accountId: 1, folder: 'INBOX', uid: 100 + i, messageId: 'm' + i,
    subject: subjects[i % 5],
    fromAddr: 'zakaznik' + i + '@seznam.cz',
    fromName: ['Jana Nováková', 'Petr Svoboda', 'Alfa s.r.o.'][i % 3],
    toAddr: 'info@quentino.cz', date: new Date(Date.now() - i * 3600e3).toISOString(),
    snippet: 'Dobrý den, chtěl bych se zeptat na stav mé objednávky, kterou jsem zadal minulý týden…',
    seen: i > 2, flagged: i === 1, answered: false, hasAttachments: i % 4 === 0,
    category: ['orders', 'people', 'companies'][i % 3], summary: null, archived: false,
    threadKey: 't' + i, size: 12345, orderRef: null
  }));
  const full = Object.assign({}, messages[0], {
    cc: '', bodyHtml: '<p>Dobrý den,</p><p>chtěl bych se zeptat na stav objednávky <b>20260819</b>. '
      + 'Peníze jsem posílal minulé úterý, ale zatím mi nepřišlo potvrzení o odeslání.</p>'
      + '<p>Předem děkuji za odpověď.</p><p>S pozdravem<br>Jana Nováková</p>',
    bodyText: 'Dobrý den, chtěl bych se zeptat na stav objednávky 20260819.',
    attachments: [{ id: 1, filename: 'potvrzeni.pdf', mime: 'application/pdf', size: 84210, path: '/x', cid: null }],
    detectedLang: null, translationCz: null
  });
  const answers = {
    'settings:get': settings,
    'accounts:list': accounts,
    'folders:list': folders,
    'messages:list': messages,
    'messages:get': full,
    'messages:thread': [messages[0]],
    'stats:categories': { orders: { cnt: 4, unseen: 1 }, people: { cnt: 5, unseen: 2 }, companies: { cnt: 3, unseen: 0 } },
    'persons:list': [{ id: 1, name: 'Petra', positions: { cz: '', sk: '', en: '' }, displayNames: { cz: 'Petra', sk: '', en: '' }, photoPath: null }],
    'knowledge:list': [],
    'outbox:list': [],
    'quota:get': { used: 2000000000, limit: 10000000000 },
    'orderlinks:pending': 0,
    'orderlinks:refresh': { orders: 0, links: 0 },
    'orders:badge': null,
    'orders:card': null,
    'chat:overview': { config: { url: '', hasKey: false, apiBase: '', ready: false, operatorPersonId: 0, signMode: 'first', signSuffix: 'Quentino' }, persons: [], unread: 2, waiting: 1 },
    'chat:conversations': [],
    'ig:overview': {
      accounts: [], expiringSoon: 0,
      markets: [{ lang: 'CS', label: 'Čeština', note: '', tags: '', color: '#232849', enabled: true }],
      brand: { context: '', loveOn: false, love: '', tones: [], avoid: '', rules: '', emoji: 'sparse', variants: 2, useKnowledge: false },
      connection: { hasAppId: false, hasAppSecret: false, appId: '', callbackUrl: '', storage: { url: '', bucket: 'instagram', hasKey: false }, autoSync: true },
      storageReady: false, queued: 0, failed: 0, hasSource: false
    },
    'ig:feed': [], 'ig:drafts': [], 'ig:jobs': [], 'ig:markets': [],
    'products:status': { url: '', count: 0, lastSync: null },
    'vouchers:list': []
  };
  window.api = {
    invoke: function (channel) {
      return Promise.resolve({ ok: true, data: channel in answers ? answers[channel] : null });
    },
    on: function (channel, cb) {
      if (!listeners.has(channel)) listeners.set(channel, new Set());
      listeners.get(channel).add(cb);
      return function () { listeners.get(channel).delete(cb); };
    }
  };
  const root = document.documentElement;
  root.dataset.platform = 'ios';
  root.dataset.form = 'phone';   // přesně to, co teď posílá nativní obal
})();
