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
    username: 'info@quentino.cz', logoPath: null, color: '#7c5cff',
    // Podpis je jeden z důvodů, proč se psaní na telefonu nevešlo na obrazovku
    // — bez něj by se to na náhledech nepoznalo
    signatureHtml: [
      '<div style="font-size:13px;line-height:1.5;color:#444">',
      '<b>Quentino</b><br>',
      'Kravaty, motýlky a doplňky, které vydrží<br>',
      '<a href="https://www.quentino.cz">www.quentino.cz</a> · ',
      '<a href="mailto:info@quentino.cz">info@quentino.cz</a> · +420 607 043 067<br>',
      'Quentino s.r.o., Bubenská 1477/1, 170 00 Praha 7, IČO 09876543',
      '</div>'
    ].join(''),
    sigConfig: null
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
    'orders:badge': {
      orderNumber: '20260819', total: '2\u00a0480 Kč', status: 'Odeslána', tone: 'sent',
      carrierName: 'Zásilkovna', shipmentStage: 'na cestě'
    },
    'orders:card': {
      orderNumber: '20260819', lang: 'cz', placedAt: '2026-08-12T09:14:00Z',
      customerEmail: 'zakaznik0@seznam.cz', customerPhone: '+420 777 123 456',
      billing: { name: 'Jana Nováková', company: null, lines: ['Dlouhá 12', '110 00 Praha 1'], country: 'CZ' },
      shipping: { name: 'Jana Nováková', company: null, lines: ['Z-Box Praha 1, Dlouhá'], country: 'CZ' },
      items: [
        { qty: 1, unit: 'ks', title: 'Kožený pásek Quentino — hnědý', code: 'QP-118', url: null,
          price: '1\u00a0290 Kč', availability: 'Skladem', variants: ['Délka: 110 cm'],
          image: null, feedUrl: null, feedPrice: null, matched: false },
        { qty: 2, unit: 'ks', title: 'Manžetové knoflíčky Onyx', code: 'QM-042', url: null,
          price: '595 Kč', availability: 'Skladem', variants: [],
          image: null, feedUrl: null, feedPrice: null, matched: false }
      ],
      shipmentName: 'Zásilkovna', shipmentPrice: '79 Kč',
      paymentName: 'Kartou online', paymentPrice: '0 Kč',
      total: '2\u00a0480 Kč', historyUrl: null, adminUrl: 'https://example.upgates.cz/order/1', adminSource: 'api',
      live: {
        status: 'Odeslána', paid: true, paidDate: '2026-08-12', deliveredDate: null,
        trackingCode: 'Z 1234 5678', trackingUrl: 'https://tracking.packeta.com/Z12345678',
        adminUrl: 'https://example.upgates.cz/order/1'
      },
      tracking: {
        source: 'api', status: 'Odeslána', createdAt: '2026-08-12T09:14:00Z', paidDate: '2026-08-12',
        customerPhone: '+420 777 123 456', carrierId: null, carrierName: 'Zásilkovna',
        trackingCode: 'Z 1234 5678', trackingUrl: 'https://tracking.packeta.com/Z12345678',
        shipment: { description: 'Předáno dopravci', at: '2026-08-12T14:02:00Z', phase: 'transit' },
        shipmentError: null
      }
    },
    'customer:context': {
      email: 'zakaznik0@seznam.cz', name: 'Jana Nováková', total: 3,
      messages: [
        { id: 1, folder: 'INBOX', subject: 'Dotaz k objednávce 20260819', date: '2026-08-19T14:26:00Z',
          snippet: 'Dobrý den, chtěl bych se zeptat…', seen: false, outgoing: false },
        { id: 90, folder: 'Sent', subject: 'Re: Potvrzení objednávky', date: '2026-08-13T08:10:00Z',
          snippet: 'Dobrý den, objednávka byla expedována…', seen: true, outgoing: true }
      ],
      orders: []
    },
    'chat:overview': {
      config: { url: 'https://x.supabase.co', hasKey: true, apiBase: 'https://quentino.cz', ready: true,
        operatorPersonId: 1, signMode: 'first', signSuffix: 'Quentino',
        lastSeen: '2026-08-24T09:00:00Z', idleDays: 0 },
      persons: [{ id: 1, name: 'Petra Nováková', short: 'Petra' }, { id: 2, name: 'Tomáš Kraus', short: 'Tomáš' }],
      unread: 2, waiting: 1
    },
    'chat:conversations': [
      { id: 'c1', sessionId: 'abc123def', status: 'open', name: 'Jana Nováková', email: 'jana@seznam.cz',
        phone: '+420 777 123 456', locale: 'cs', lastMessageAt: new Date(Date.now() - 4 * 60e3).toISOString(),
        unread: 2, channel: 'widget', createdAt: new Date(Date.now() - 40 * 60e3).toISOString(),
        leftAt: null, answered: false },
      { id: 'c2', sessionId: 'ff8812aa', status: 'open', name: null, email: null, phone: null,
        locale: 'sk', lastMessageAt: new Date(Date.now() - 55 * 60e3).toISOString(), unread: 0,
        channel: 'widget', createdAt: new Date(Date.now() - 90 * 60e3).toISOString(),
        leftAt: new Date(Date.now() - 50 * 60e3).toISOString(), answered: true },
      { id: 'c3', sessionId: '77aa11bb', status: 'closed', name: 'Peter Kovac', email: 'peter@gmail.com',
        phone: null, locale: 'en', lastMessageAt: new Date(Date.now() - 26 * 3600e3).toISOString(),
        unread: 0, channel: 'telegram', createdAt: new Date(Date.now() - 30 * 3600e3).toISOString(),
        leftAt: null, answered: true }
    ],
    'chat:messages': [
      { id: 'm1', conversationId: 'c1', sender: 'customer',
        content: 'Dobry den, objednala jsem u vas pasek a chtela bych vedet, jestli uz je odeslany.',
        contentType: 'text', createdAt: new Date(Date.now() - 30 * 60e3).toISOString(), readAt: null },
      { id: 'm2', conversationId: 'c1', sender: 'operator',
        content: 'Dobry den, dekuji za zpravu. Objednavku 20260819 jsme predali Zasilkovne dnes rano.\nPetra, Quentino',
        contentType: 'text', createdAt: new Date(Date.now() - 22 * 60e3).toISOString(),
        readAt: new Date(Date.now() - 21 * 60e3).toISOString() },
      { id: 'm3', conversationId: 'c1', sender: 'customer',
        content: 'Super, dekuji! A jeste bych se zeptala, jestli mate ten pasek i v cerne barve a v delce 115 cm?',
        contentType: 'text', createdAt: new Date(Date.now() - 6 * 60e3).toISOString(), readAt: null },
      { id: 'm4', conversationId: 'c1', sender: 'customer',
        content: 'Pripadne jestli byste mi mohli poslat foto.',
        contentType: 'text', createdAt: new Date(Date.now() - 4 * 60e3).toISOString(), readAt: null }
    ],
    'chat:markRead': null,
    'chat:suggest': 'Dobry den, cerny pasek v delce 115 cm mame skladem.',
    'chat:cards': [],
    'chat:searchProducts': [],
    'ig:overview': {
      accounts: [], expiringSoon: 0,
      markets: [{ lang: 'CS', label: 'Čeština', note: '', tags: '', color: '#232849', enabled: true }],
      brand: { context: '', loveOn: false, love: '', tones: [], avoid: '', rules: '', emoji: 'sparse', variants: 2, useKnowledge: false },
      connection: { hasAppId: false, hasAppSecret: false, appId: '', callbackUrl: '', storage: { url: '', bucket: 'instagram', hasKey: false }, autoSync: true },
      storageReady: true, queued: 2, failed: 0, hasSource: true
    },
    'ig:feed': Array.from({ length: 8 }, (_, i) => ({
      id: i + 1, igMediaId: 'm' + i, mediaType: i % 3 === 0 ? 'VIDEO' : 'IMAGE',
      permalink: 'https://instagram.com/p/x' + i,
      caption: 'Nová kolekce koženého zboží — ručně šité pásky z italské kůže. #quentino',
      postedAt: new Date(Date.now() - i * 86400e3).toISOString(),
      likeCount: 120 + i * 7, commentCount: 3 + i, childCount: i % 4 === 0 ? 3 : 0,
      done: i % 2 === 0 ? ['CS', 'EN'] : ['CS'], pending: i % 3 === 0 ? ['DE'] : []
    })),
    /* Náhledy příspěvků. Skutečný Instagram má většinu obsahu na výšku
       (Reels 9:16, fotky 4:5), takže náhled musí ukázat i je — na čtvercích
       by se nikdy nepoznalo, že se dlaždice roztahují. */
    'ig:thumb': [
      'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAKAAWgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDQooorYyCiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKK4z/hYX/UL/wDJj/7Gj/hYX/UL/wDJj/7Gp5kOzOzorjP+Fhf9Qv8A8mP/ALGj/hYX/UL/APJj/wCxo5kFmdnRXGf8LC/6hf8A5Mf/AGNH/Cwv+oX/AOTH/wBjRzILM7OiuM/4WF/1C/8AyY/+xo/4WF/1C/8AyY/+xo5kFmdnRXGf8LC/6hf/AJMf/Y0f8LC/6hf/AJMf/Y0cyCzOzorjP+Fhf9Qv/wAmP/saP+Fhf9Qv/wAmP/saOZBZnZ0Vxn/Cwv8AqF/+TH/2NH/Cwv8AqF/+TH/2NHMgszs6K4z/AIWF/wBQv/yY/wDsaP8AhYX/AFC//Jj/AOxo5kFmdnRXGf8ACwv+oX/5Mf8A2NH/AAsL/qF/+TH/ANjRzILM7OiuM/4WF/1C/wDyY/8AsaP+Fhf9Qv8A8mP/ALGjmQWZ2dFcZ/wsL/qF/wDkx/8AY0f8LC/6hf8A5Mf/AGNHMgszs6K4z/hYX/UL/wDJj/7Gj/hYX/UL/wDJj/7GjmQWZ2dFcZ/wsL/qF/8Akx/9jR/wsL/qF/8Akx/9jRzILM7OiuM/4WF/1C//ACY/+xo/4WF/1C//ACY/+xo5kFmdnRXGf8LC/wCoX/5Mf/Y0f8LC/wCoX/5Mf/Y0cyCzOzorjP8AhYX/AFC//Jj/AOxo/wCFhf8AUL/8mP8A7GjmQWZ2dFcZ/wALC/6hf/kx/wDY0f8ACwv+oX/5Mf8A2NHMgszs6K4z/hYX/UL/APJj/wCxo/4WF/1C/wDyY/8AsaOZBZnZ0Vxn/Cwv+oX/AOTH/wBjR/wsL/qF/wDkx/8AY0cyCzOzorjP+Fhf9Qv/AMmP/saP+Fhf9Qv/AMmP/saOZBZnZ0Vxn/Cwv+oX/wCTH/2NH/Cwv+oX/wCTH/2NHMgszs6K4z/hYX/UL/8AJj/7Gj/hYX/UL/8AJj/7GjmQWZ2dFcZ/wsL/AKhf/kx/9jRRzILM4yiiiszQKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiium0PTdMutO0/7Xb5lury6Qyhm3ERwxukYXcASzNjseeo4IAOZort00HSWuJSum3TTpFCTY+QxYbmcM3libcoAWPq5xvzjBGHWOl2VzYeQllLeW0GoXohXmTb/wAewUsI2Bb5Q33CfXBANAHDUV3WgQJbSyW7iaKztdTkF4bZxJG8ICgrK3HyABtpwd2W4BxWL4duJ7e/u7YQrbpcaZcb12csBayEHJyQG4bg4PHYCgDn6K7HUwp8LMsP2iOzSytmjZyDBJKdnmBBjiQMXJOTwGGOlcdQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQB2f/AAr3/qKf+S//ANlR/wAK9/6in/kv/wDZV2dFacqM7s4z/hXv/UU/8l//ALKj/hXv/UU/8l//ALKuzoo5UF2cZ/wr3/qKf+S//wBlR/wr3/qKf+S//wBlXZ0UcqC7OM/4V7/1FP8AyX/+yo/4V7/1FP8AyX/+yrs6KOVBdnGf8K9/6in/AJL/AP2VH/Cvf+op/wCS/wD9lXZ0UcqC7OM/4V7/ANRT/wAl/wD7Kj/hXv8A1FP/ACX/APsq7OijlQXZxn/Cvf8AqKf+S/8A9lR/wr3/AKin/kv/APZV2dFHKguzjP8AhXv/AFFP/Jf/AOyo/wCFe/8AUU/8l/8A7Kuzoo5UF2cZ/wAK9/6in/kv/wDZUf8ACvf+op/5L/8A2VdnRRyoLs4z/hXv/UU/8l//ALKj/hXv/UU/8l//ALKuzoo5UF2cZ/wr3/qKf+S//wBlR/wr3/qKf+S//wBlXZ0UcqC7OM/4V7/1FP8AyX/+yo/4V7/1FP8AyX/+yrs6KOVBdnGf8K9/6in/AJL/AP2VH/Cvf+op/wCS/wD9lXZ0UcqC7OM/4V7/ANRT/wAl/wD7Kj/hXv8A1FP/ACX/APsq7OijlQXZxn/Cvf8AqKf+S/8A9lR/wr3/AKin/kv/APZV2dFHKguzjP8AhXv/AFFP/Jf/AOyo/wCFe/8AUU/8l/8A7Kuzoo5UF2cZ/wAK9/6in/kv/wDZUf8ACvf+op/5L/8A2VdnRRyoLs4z/hXv/UU/8l//ALKj/hXv/UU/8l//ALKuzoo5UF2cZ/wr3/qKf+S//wBlR/wr3/qKf+S//wBlXZ0UcqC7OM/4V7/1FP8AyX/+yo/4V7/1FP8AyX/+yrs6KOVBdnGf8K9/6in/AJL/AP2VH/Cvf+op/wCS/wD9lXZ0UcqC7OM/4V7/ANRT/wAl/wD7Kj/hXv8A1FP/ACX/APsq7OijlQXZxn/Cvf8AqKf+S/8A9lRXZ0UcqC7CiiiqEFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAf/Z',
      'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAKAAWgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDh6KKK2GFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUVQ/tT/AKY/+Pf/AFqP7U/6Y/8Aj3/1qnmQF+iqH9qf9Mf/AB7/AOtR/an/AEx/8e/+tRzIC/RVD+1P+mP/AI9/9aj+1P8Apj/49/8AWo5kBfoqh/an/TH/AMe/+tR/an/TH/x7/wCtRzIC/RVD+1P+mP8A49/9aj+1P+mP/j3/ANajmQF+iqH9qf8ATH/x7/61H9qf9Mf/AB7/AOtRzIC/RVD+1P8Apj/49/8AWo/tT/pj/wCPf/Wo5kBfoqh/an/TH/x7/wCtR/an/TH/AMe/+tRzIC/RVD+1P+mP/j3/ANaj+1P+mP8A49/9ajmQF+iqH9qf9Mf/AB7/AOtR/an/AEx/8e/+tRzIC/RVD+1P+mP/AI9/9aj+1P8Apj/49/8AWo5kBfoqh/an/TH/AMe/+tR/an/TH/x7/wCtRzIC/RVD+1P+mP8A49/9aj+1P+mP/j3/ANajmQF+iqH9qf8ATH/x7/61H9qf9Mf/AB7/AOtRzIC/RVD+1P8Apj/49/8AWo/tT/pj/wCPf/Wo5kBfoqh/an/TH/x7/wCtR/an/TH/AMe/+tRzIC/RVD+1P+mP/j3/ANaj+1P+mP8A49/9ajmQF+iqH9qf9Mf/AB7/AOtR/an/AEx/8e/+tRzIC/RVD+1P+mP/AI9/9aj+1P8Apj/49/8AWo5kBfoqh/an/TH/AMe/+tR/an/TH/x7/wCtRzIC/RVD+1P+mP8A49/9aj+1P+mP/j3/ANajmQF+iqH9qf8ATH/x7/61H9qf9Mf/AB7/AOtRzIC/RVD+1P8Apj/49/8AWoo5kBQooorMQUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFdNoem6Zdadp/wBrt8y3V5dIZQzbiI4Y3SMLuAJZmx2PPUcEAHM0V26aDpLXEpXTbpp0ihJsfIYsNzOGbyxNuUALH1c435xgjDrHS7K5sPISylvLaDUL0QrzJt/49gpYRsC3yhvuE+uCAaAOGorutAgS2lkt3E0Vna6nILw2ziSN4QFBWVuPkADbTg7stwDisXw7cT29/d2whW3S40y43rs5YC1kIOTkgNw3BweOwFAHP0V2OphT4WZYftEdmllbNGzkGCSU7PMCDHEgYuScngMMdK46gAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigC//AGX/ANNv/Hf/AK9H9l/9Nv8Ax3/69X6K05UMof2X/wBNv/Hf/r0f2X/02/8AHf8A69X6KOVAUP7L/wCm3/jv/wBej+y/+m3/AI7/APXq/RRyoCh/Zf8A02/8d/8Ar0f2X/02/wDHf/r1foo5UBQ/sv8A6bf+O/8A16P7L/6bf+O//Xq/RRyoCh/Zf/Tb/wAd/wDr0f2X/wBNv/Hf/r1foo5UBQ/sv/pt/wCO/wD16P7L/wCm3/jv/wBer9FHKgKH9l/9Nv8Ax3/69H9l/wDTb/x3/wCvV+ijlQFD+y/+m3/jv/16P7L/AOm3/jv/ANer9FHKgKH9l/8ATb/x3/69H9l/9Nv/AB3/AOvV+ijlQFD+y/8Apt/47/8AXo/sv/pt/wCO/wD16v0UcqAof2X/ANNv/Hf/AK9H9l/9Nv8Ax3/69X6KOVAUP7L/AOm3/jv/ANej+y/+m3/jv/16v0UcqAof2X/02/8AHf8A69H9l/8ATb/x3/69X6KOVAUP7L/6bf8Ajv8A9ej+y/8Apt/47/8AXq/RRyoCh/Zf/Tb/AMd/+vR/Zf8A02/8d/8Ar1foo5UBQ/sv/pt/47/9ej+y/wDpt/47/wDXq/RRyoCh/Zf/AE2/8d/+vR/Zf/Tb/wAd/wDr1foo5UBQ/sv/AKbf+O//AF6P7L/6bf8Ajv8A9er9FHKgKH9l/wDTb/x3/wCvR/Zf/Tb/AMd/+vV+ijlQFD+y/wDpt/47/wDXo/sv/pt/47/9er9FHKgKH9l/9Nv/AB3/AOvR/Zf/AE2/8d/+vV+ijlQFD+y/+m3/AI7/APXoq/RRyoAoooqgCiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKAP//Z',
      'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAGQAZADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDpqKKKkoKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAorwOinYVz3yivA6KLBc98orwOiiwXPfKK8DoosFz3yivA6KLBc98orwOiiwXPfKK8DoosFz3yivA6KLBc98orwOiiwXPfKK8DoosFz3yivA6KLBc98orwOiiwXPfKK8DoosFz3yivA6KLBc98orwOiiwXPfKK8DoosFz3yivA6KLBc98orwOiiwXPfKK8DoosFz3yivA6KLBc98orwOiiwXPfKK8DoosFz3yivA6KLBc98orwOiiwXPfKK8DoosFwoorTXS7SPT7e4vL9oJLmNpoo1g3goHKctkYYlWwMY4GSM0xGZRXW3vg2GXxFNZ6Zdt9m+0zwK0seDHIkgRUPJyCXiG7/azjjFVD4XtftkES6tG0MkVxI7oI5Gj8mMyH5UkYYIGBkg9eOOQDnaK6RfB5ligWLUYftU/kNHC7RglZSoTgOWzh1JBXGM8njOLf29lCUNletcq2Q2+Hy2Ug+mSCD25+oFAFWiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAq4mr30dgbFZgICCozGpYKTkqGxuAJ6gHHX1qnRQBoy+IdVma4ZrshrmZZ5SiKhaRejZAGDnk46kAnJFJLr2pTTLK06KyxyxgRwoigSKVf5QAMkEgnGenPArPooAvjXdSFtHbrc7Vj27WVFD4U5UFwNxAOMAnAwPQVFfand6kyNcuh2Z2rHEsajJyThQBk9z1qrRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRXtv9gaN/0CLH/wABk/wo/sDRv+gRY/8AgMn+FK47HiVFe2/2Bo3/AECLH/wGT/Cj+wNG/wCgRY/+Ayf4UXCx4lRXtv8AYGjf9Aix/wDAZP8ACj+wNG/6BFj/AOAyf4UXCx4lRXtv9gaN/wBAix/8Bk/wo/sDRv8AoEWP/gMn+FFwseJUV7b/AGBo3/QIsf8AwGT/AAo/sDRv+gRY/wDgMn+FFwseJUV7b/YGjf8AQIsf/AZP8KP7A0b/AKBFj/4DJ/hRcLHiVFe2/wBgaN/0CLH/AMBk/wAKP7A0b/oEWP8A4DJ/hRcLHiVFe2/2Bo3/AECLH/wGT/Cj+wNG/wCgRY/+Ayf4UXCx4lRXtv8AYGjf9Aix/wDAZP8ACj+wNG/6BFj/AOAyf4UXCx4lRXtv9gaN/wBAix/8Bk/wo/sDRv8AoEWP/gMn+FFwseJUV7b/AGBo3/QIsf8AwGT/AAo/sDRv+gRY/wDgMn+FFwseJUV7b/YGjf8AQIsf/AZP8KP7A0b/AKBFj/4DJ/hRcLHiVFe2/wBgaN/0CLH/AMBk/wAKP7A0b/oEWP8A4DJ/hRcLHiVFe2/2Bo3/AECLH/wGT/Cj+wNG/wCgRY/+Ayf4UXCx4lRXtv8AYGjf9Aix/wDAZP8ACj+wNG/6BFj/AOAyf4UXCx4lRXtv9gaN/wBAix/8Bk/wo/sDRv8AoEWP/gMn+FFwseJUV7b/AGBo3/QIsf8AwGT/AAo/sDRv+gRY/wDgMn+FFwseJUV7b/YGjf8AQIsf/AZP8KP7A0b/AKBFj/4DJ/hRcLHiVFe2/wBgaN/0CLH/AMBk/wAKP7A0b/oEWP8A4DJ/hRcLHiVFe2/2Bo3/AECLH/wGT/Cj+wNG/wCgRY/+Ayf4UXCx4lRXtv8AYGjf9Aix/wDAZP8ACj+wNG/6BFj/AOAyf4UXCx4lRXtv9gaN/wBAix/8Bk/wo/sDRv8AoEWP/gMn+FFwseJUV7b/AGBo3/QIsf8AwGT/AAo/sDRv+gRY/wDgMn+FFwseJUV7b/YGjf8AQIsf/AZP8KP7A0b/AKBFj/4DJ/hRcLHiVFe2/wBgaN/0CLH/AMBk/wAKP7A0b/oEWP8A4DJ/hRcLF+iiikMKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKAP//Z',
      'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAHCAWgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwB9FFFYmIUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQBU/tbTf+gha/wDf5f8AGj+1tN/6CFr/AN/l/wAa8xorTlL5D07+1tN/6CFr/wB/l/xo/tbTf+gha/8Af5f8a8xoo5Q5D07+1tN/6CFr/wB/l/xo/tbTf+gha/8Af5f8a8xoo5Q5D07+1tN/6CFr/wB/l/xo/tbTf+gha/8Af5f8a8xoo5Q5D07+1tN/6CFr/wB/l/xo/tbTf+gha/8Af5f8a8xoo5Q5D07+1tN/6CFr/wB/l/xo/tbTf+gha/8Af5f8a8xoo5Q5D07+1tN/6CFr/wB/l/xo/tbTf+gha/8Af5f8a8xoo5Q5D07+1tN/6CFr/wB/l/xo/tbTf+gha/8Af5f8a8xoo5Q5D07+1tN/6CFr/wB/l/xo/tbTf+gha/8Af5f8a8xoo5Q5D07+1tN/6CFr/wB/l/xo/tbTf+gha/8Af5f8a8xoo5Q5D07+1tN/6CFr/wB/l/xo/tbTf+gha/8Af5f8a8xoo5Q5D07+1tN/6CFr/wB/l/xo/tbTf+gha/8Af5f8a8xoo5Q5D07+1tN/6CFr/wB/l/xo/tbTf+gha/8Af5f8a8xoo5Q5D07+1tN/6CFr/wB/l/xo/tbTf+gha/8Af5f8a8xoo5Q5D07+1tN/6CFr/wB/l/xo/tbTf+gha/8Af5f8a8xoo5Q5D07+1tN/6CFr/wB/l/xo/tbTf+gha/8Af5f8a8xoo5Q5D07+1tN/6CFr/wB/l/xo/tbTf+gha/8Af5f8a8xoo5Q5D07+1tN/6CFr/wB/l/xo/tbTf+gha/8Af5f8a8xoo5Q5D07+1tN/6CFr/wB/l/xo/tbTf+gha/8Af5f8a8xoo5Q5D07+1tN/6CFr/wB/l/xo/tbTf+gha/8Af5f8a8xoo5Q5D07+1tN/6CFr/wB/l/xo/tbTf+gha/8Af5f8a8xoo5Q5D07+1tN/6CFr/wB/l/xo/tbTf+gha/8Af5f8a8xoo5Q5D07+1tN/6CFr/wB/l/xorzGijlDkCiitnQ9Eh1GC6uLuV4o47ecwBMZlljiaTHP8IC8/VR3zVFmNRW9/YcK6GLtIpLuVhK3mRXSIoVDjcI2Xew4JJ4wOuKwaACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACtLTPEOq6QGS0vZ0iMcieV5rBBvQqWwCORnIPqBWbRQBpR628MDxw2NpE7LJGsyq2+NHyGUfNgjBIywJwetZtFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQB6zRRRWJiFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFAH//Z'
    ],
    'ig:drafts': [], 'ig:jobs': [], 'ig:markets': [],
    'packing:scan': null,   // doplní se níž, až bude karta objednávky sestavená
    'packing:setItem': [0],
    'packing:setDone': true,
    'packing:reset': true,
    'ptrans:overview': {
      settings: {
        sourceLang: 'cz',
        languages: [
          { code: 'sk', label: 'Slovenština', enabled: true },
          { code: 'en', label: 'Angličtina', enabled: true },
          { code: 'de', label: 'Němčina', enabled: true }
        ],
        fields: { title: true, short: true, long: true, seo_title: true, seo_desc: true, seo_url: true,
          google_title: false, google_desc: false, params: false },
        prompt: '', glossary: [{ source: 'kšandy', targets: { sk: 'traky', en: 'suspenders' } }],
        googleTitle: { sk: '{title} {param:Barva} | Quentino' },
        limits: { seoTitle: 70, seoDesc: 155, googleTitle: 150, googleDesc: 5000 },
        model: '', concurrency: 2, secondsPerUnit: 11.4
      },
      feed: { syncedAt: new Date(Date.now() - 3 * 3600e3).toISOString(), products: 1204 },
      colors: { shades: 21, mapped: 20, missing: ['Vícebarevné'] },
      googleRules: {
        gender: [{ match: 'dámsk', value: 'female' }, { match: 'pánsk', value: 'male' }],
        age: [{ match: 'dětsk', value: 'kids' }],
        defaultGender: 'male', defaultAge: 'adult', condition: 'new'
      },
      langs: [
        { lang: 'sk', todo: 539, total: 7224, byState: { missing: 170, same: 350, source: 19, ok: 6685 } },
        { lang: 'en', todo: 481, total: 7224, byState: { missing: 169, same: 310, source: 2, ok: 6743 } }
      ],
      running: null
    },
    'ptrans:list': {
      total: 137, todo: 137,
      rows: [
        { code: 'PSSK120BR2', title: 'Bordó pánské široké kšandy s černou pravou kůží', image: null,
          category: 'Kšandy', manufacturer: 'Quentino', availability: 'Skladem', price: '649 CZK', active: true,
          origin: 'feed', url: 'https://www.quentino.cz/p/ukazkovy-produkt', doneLangs: [], todoLangs: ['sk', 'en', 'de'],
          states: { sk: { total: 6, todo: 6, worst: 'same' }, en: { total: 6, todo: 6, worst: 'same' },
            de: { total: 6, todo: 6, worst: 'missing' } } },
        { code: 'MZU01', title: 'Bordó manžetové uzlíky', image: null, category: 'Manžetové knoflíčky',
          manufacturer: 'Quentino', availability: 'Skladem', price: '199 CZK', active: true,
          origin: 'file', url: 'https://www.quentino.cz/p/novinka', doneLangs: ['en'], todoLangs: ['sk', 'de'],
          states: { sk: { total: 6, todo: 2, worst: 'missing' }, en: { total: 6, todo: 0, worst: 'ok' },
            de: { total: 6, todo: 6, worst: 'missing' } } },
        { code: 'PKT23', title: 'Bordó pánská kravata BULDOČCI', image: null, category: 'Kravaty',
          manufacturer: 'Quentino', availability: 'Skladem více než 20 ks', price: '449 CZK', active: true,
          origin: 'feed', url: 'https://www.quentino.cz/p/ukazkovy-produkt', doneLangs: ['en'], todoLangs: ['sk', 'de'],
          states: { sk: { total: 6, todo: 1, worst: 'stale' }, en: { total: 6, todo: 0, worst: 'ok' },
            de: { total: 6, todo: 6, worst: 'missing' } } }
      ]
    },
    'ptrans:fields': [
      { code: 'PSSK120BR2', lang: 'sk', field: 'title', value: 'Bordó pánske široké traky s čiernou pravou kožou',
        source: 'Bordó pánské široké kšandy s černou pravou kůží', state: 'ok', translated: 'Bordó pánske široké traky s čiernou pravou kožou', translatedAt: new Date(Date.now() - 2 * 3600e3).toISOString(),
        model: 'claude-sonnet-5', manual: false },
      { code: 'PSSK120BR2', lang: 'sk', field: 'short', value: '<p>Bordó pánske traky z kvalitnej gumy…</p>',
        source: '<p>Bordó pánské kšandy z kvalitní pruženky…</p>', state: 'ok', translated: '<p>Bordó pánske traky z kvalitnej gumy…</p>', translatedAt: new Date(Date.now() - 2 * 3600e3).toISOString(),
        model: 'claude-sonnet-5', manual: false },
      { code: 'PSSK120BR2', lang: 'sk', field: 'long', value: '<p data-start="67">Široké traky v bordó odtieni s pravou kožou…</p>',
        source: '<p data-start="67">Široké kšandy v bordó odstínu s pravou kůží…</p>', state: 'ok', translated: '<p data-start="67">Široké traky v bordó odtieni s pravou kožou…</p>', translatedAt: new Date(Date.now() - 2 * 3600e3).toISOString(),
        model: 'claude-sonnet-5', manual: false },
      { code: 'PSSK120BR2', lang: 'sk', field: 'seo_title', value: 'Bordó široké traky | Quentino',
        source: 'Bordó široké kšandy | Quentino', state: 'ok', translated: 'Bordó široké traky | Quentino', translatedAt: new Date(Date.now() - 2 * 3600e3).toISOString(),
        model: 'claude-sonnet-5', manual: false },
      { code: 'PSSK120BR2', lang: 'sk', field: 'seo_desc', value: 'Bordó pánske traky s pravou kožou, vyrobené v ČR.',
        source: 'Bordó pánské kšandy s pravou kůží, vyrobené v ČR.', state: 'ok', translated: 'Bordó pánske traky s pravou kožou, vyrobené v ČR.', translatedAt: new Date(Date.now() - 2 * 3600e3).toISOString(),
        model: 'claude-sonnet-5', manual: false },
      { code: 'PSSK120BR2', lang: 'sk', field: 'seo_url', value: 'bordo-panske-siroke-traky',
        source: 'bordo-panske-siroke-ksandy', state: 'ok', translated: 'bordo-panske-siroke-traky', translatedAt: new Date(Date.now() - 2 * 3600e3).toISOString(),
        model: 'claude-sonnet-5', manual: false },
      { code: 'PSSK120BR2', lang: 'sk', field: 'redirect', value: '/p/bordo-panske-siroke-ksandy',
        source: '/p/bordo-siroke-ksandy', state: 'ok', translated: '/p/bordo-panske-siroke-ksandy', translatedAt: new Date(Date.now() - 2 * 3600e3).toISOString(),
        model: 'claude-sonnet-5', manual: false },
      { code: 'PSSK120BR2', lang: 'en', field: 'title', value: 'Men\'s burgundy wide suspenders with black leather',
        source: 'Bordó pánské široké kšandy s černou pravou kůží', state: 'ok', translated: 'Men\'s burgundy wide suspenders with black leather', translatedAt: new Date(Date.now() - 2 * 3600e3).toISOString(),
        model: 'claude-sonnet-5', manual: false },
      { code: 'PSSK120BR2', lang: 'en', field: 'short', value: '<p>Burgundy wide suspenders made of quality elastic…</p>',
        source: '<p>Bordó pánské kšandy z kvalitní pruženky…</p>', state: 'ok', translated: '<p>Burgundy wide suspenders made of quality elastic…</p>', translatedAt: new Date(Date.now() - 2 * 3600e3).toISOString(),
        model: 'claude-sonnet-5', manual: false },
      { code: 'PSSK120BR2', lang: 'en', field: 'long', value: '<p data-start="67">Wide suspenders in burgundy with genuine leather…</p>',
        source: '<p data-start="67">Široké kšandy v bordó odstínu s pravou kůží…</p>', state: 'ok', translated: '<p data-start="67">Wide suspenders in burgundy with genuine leather…</p>', translatedAt: new Date(Date.now() - 2 * 3600e3).toISOString(),
        model: 'claude-sonnet-5', manual: false },
      { code: 'PSSK120BR2', lang: 'en', field: 'seo_title', value: 'Men\'s Burgundy Wide Suspenders | Quentino',
        source: 'Bordó široké kšandy | Quentino', state: 'ok', translated: 'Men\'s Burgundy Wide Suspenders | Quentino', translatedAt: new Date(Date.now() - 2 * 3600e3).toISOString(),
        model: 'claude-sonnet-5', manual: false },
      { code: 'PSSK120BR2', lang: 'en', field: 'seo_desc', value: 'Burgundy suspenders with genuine leather, made in Czechia.',
        source: 'Bordó pánské kšandy s pravou kůží, vyrobené v ČR.', state: 'ok', translated: 'Burgundy suspenders with genuine leather, made in Czechia.', translatedAt: new Date(Date.now() - 2 * 3600e3).toISOString(),
        model: 'claude-sonnet-5', manual: false },
      { code: 'PSSK120BR2', lang: 'en', field: 'seo_url', value: 'mens-burgundy-wide-suspenders',
        source: 'bordo-panske-siroke-ksandy', state: 'ok', translated: 'mens-burgundy-wide-suspenders', translatedAt: new Date(Date.now() - 2 * 3600e3).toISOString(),
        model: 'claude-sonnet-5', manual: false },
      { code: 'PSSK120BR2', lang: 'en', field: 'redirect', value: '/p/bordo-panske-siroke-ksandy\n/p/burgundy-suspenders',
        source: '/p/bordo-siroke-ksandy', state: 'ok', translated: '/p/bordo-panske-siroke-ksandy\n/p/burgundy-suspenders', translatedAt: new Date(Date.now() - 2 * 3600e3).toISOString(),
        model: 'claude-sonnet-5', manual: false },
      { code: 'PSSK120BR2', lang: 'de', field: 'title', value: '',
        source: 'Bordó pánské široké kšandy s černou pravou kůží', state: 'missing', translated: null, translatedAt: null,
        model: '', manual: false },
      { code: 'PSSK120BR2', lang: 'de', field: 'short', value: '',
        source: '<p>Bordó pánské kšandy z kvalitní pruženky…</p>', state: 'missing', translated: null, translatedAt: null,
        model: '', manual: false },
      { code: 'PSSK120BR2', lang: 'de', field: 'long', value: '',
        source: '<p data-start="67">Široké kšandy v bordó odstínu s pravou kůží…</p>', state: 'missing', translated: null, translatedAt: null,
        model: '', manual: false },
      { code: 'PSSK120BR2', lang: 'de', field: 'seo_title', value: '',
        source: 'Bordó široké kšandy | Quentino', state: 'missing', translated: null, translatedAt: null,
        model: '', manual: false },
      { code: 'PSSK120BR2', lang: 'de', field: 'seo_desc', value: '',
        source: 'Bordó pánské kšandy s pravou kůží, vyrobené v ČR.', state: 'missing', translated: null, translatedAt: null,
        model: '', manual: false },
      { code: 'PSSK120BR2', lang: 'de', field: 'seo_url', value: '',
        source: 'bordo-panske-siroke-ksandy', state: 'missing', translated: null, translatedAt: null,
        model: '', manual: false },
      { code: 'PSSK120BR2', lang: 'de', field: 'redirect', value: '',
        source: '/p/bordo-siroke-ksandy', state: 'missing', translated: null, translatedAt: null,
        model: '', manual: false }
    ],
    'ptrans:plan': 12,
    'ptrans:sourceGaps': {
      sourceLang: 'cz',
      total: 31,
      fields: [
        { field: 'seo_title', label: 'SEO titulek', missing: 7 },
        { field: 'seo_desc', label: 'SEO popis', missing: 12 },
        { field: 'seo_url', label: 'SEO adresa', missing: 0 },
        { field: 'google_title', label: 'Google titulek', missing: 9 },
        { field: 'google_desc', label: 'Google popis', missing: 3 }
      ]
    },
    'ptrans:fillSource': { done: 31, failed: 0, errors: [] },
    'ptrans:redirectPreview': { oldPath: '/p/bordo-panske-siroke-ksandy',
      list: ['/p/bordo-siroke-ksandy', '/p/bordo-panske-siroke-ksandy'] },
    'supabase:status': [
      { host: 'xyzchat.supabase.co', uses: ['chat'],
        lastSeen: '2026-08-24T09:00:00Z', idleDays: 0, warn: false },
      { host: 'xyzmedia.supabase.co', uses: ['média pro Instagram'],
        lastSeen: '2026-08-19T12:00:00Z', idleDays: 5, warn: true }
    ],
    'supabase:ping': { result: [], status: [] },
    'orderfeed:contact': {
      phone: '+420607043067', name: 'Jana Nováková', orders: 3, via: 'podle e-mailu',
      order: { code: '023687', market: 'cz', status: 'Doručeno', paid: true, paidDate: '2026-08-10',
        resolved: true, invoice: '023689', createdAt: '2026-08-09T17:47:26+02:00',
        updatedAt: '2026-08-24T11:55:12+02:00', currency: 'CZK', total: 548,
        tracking: 'NB9574204633L', customerId: '20571', name: 'Jana Nováková',
        email: 'jana.novakova@seznam.cz', phone: '+420607043067',
        shipment: 'Balíkovna', payment: 'Bankovní převod',
        items: [{ title: 'Světle růžové pánské kšandy', code: 'PS120SR', quantity: 1, price: 479 }] }
    },
    'orderfeed:list': {
      stats: { total: 4182, withPhone: 3971, markets: [{ market: 'cz', n: 3410 }, { market: 'sk', n: 612 }, { market: 'en', n: 160 }] },
      feeds: [
        { id: 'feed1', label: 'posledních 24h', market: 'cz', recent: true, enabled: true,
          everyMinutes: 5, urlHint: 'www.quentino.cz/…-iBFIpamZa4', orders: 3410,
          newest: '2026-08-24T10:40:00+02:00', lastSync: '2026-08-24T11:58:00Z', lastError: '' },
        { id: 'feed2', label: 'CZ vše', market: 'cz', recent: false, enabled: true,
          everyMinutes: 720, urlHint: 'www.quentino.cz/…-qNj8D9bR95', orders: 3410,
          newest: '2026-08-24T10:40:00+02:00', lastSync: '2026-08-24T06:00:00Z', lastError: '' },
        { id: 'feed3', label: 'SK vše', market: 'sk', recent: false, enabled: true,
          everyMinutes: 720, urlHint: 'www.quentino.sk/…-KOfIk1SiRF', orders: 612,
          newest: '2026-08-23T19:12:00+02:00', lastSync: '2026-08-24T06:01:00Z', lastError: '' }
      ]
    },
    'orderfeed:byEmail': [],
    'orderfeed:byCode': null,
    'ptrans:trials': {
      open: 2,
      trials: [
        { id: 1, code: 'STUHA07', lang: 'cz', field: 'google_title', category: 'Stuhy',
          title: 'Barevná dámská stuha s květy', chosen: '', createdAt: '2026-08-24T09:00:00Z',
          variantA: 'Dámská stuha barevná s květy Quentino',
          variantB: 'Barevná dámská stuha s květy Quentino' },
        { id: 2, code: 'PSSK120BR2', lang: 'cz', field: 'google_title', category: 'Široké kšandy',
          title: 'Bordó pánské široké kšandy s černou kůží', chosen: '',
          createdAt: '2026-08-24T09:02:00Z',
          variantA: 'Pánské široké kšandy bordó s černou kůží Quentino',
          variantB: 'Bordó pánské široké kšandy s černou kůží Quentino' }
      ],
      styles: [
        { lang: 'cz', category: 'Úzké kšandy', kind: 'google_title', hits: 34,
          example: 'Pánské kšandy světle modré Quentino',
          rejected: 'Světle modré pánské kšandy Quentino', updatedAt: '2026-08-23T18:00:00Z' }
      ]
    },
    'ptrans:proposeFix': {
      code: 'PKSBA05', lang: 'cz', category: 'Vzorované kapesníčky do saka',
      current: 'Černý pánský kapesníček šedo růžovými květy',
      suggested: 'Černý pánský kapesníček se šedo růžovými květy',
      pattern: '{…} pánský kapesníček s {…}', note: 'přibylo: se'
    },
    'ptrans:acceptFix': true,
    'ptrans:chooseVariant': { trial: null, affected: ['A', 'B', 'C'], category: 'Stuhy', lang: 'cz' },
    'ptrans:dropTrial': true,
    'ptrans:dropStyle': true,
    'ptrans:consistency': {
      patterns: [
        { category: 'Kravaty', lang: 'en', pattern: "Men\'s {…} tie", samples: 42, matching: 39 },
        { category: 'Kšandy', lang: 'en', pattern: "Men\'s {…} suspenders", samples: 31, matching: 31 },
        { category: 'Motýlci', lang: 'en', pattern: "Men\'s {…} bow tie", samples: 18, matching: 13 }
      ],
      deviations: [
        { code: 'PKT23', title: 'Bordó pánská kravata BULDOČCI', translated: 'Burgundy tie for men BULLDOGS',
          category: 'Kravaty', lang: 'en', pattern: "Men\'s {…} tie" },
        { code: 'PMB07', title: 'Černý pánský motýlek', translated: 'Black bow tie mens',
          category: 'Motýlci', lang: 'en', pattern: "Men\'s {…} bow tie" }
      ]
    },
    'ptrans:exportPreview': { products: 137, fields: 812 },
    'ptrans:google': [
      { lang: 'cz', bundleReason: 'název spojuje dva výrobky (ksandy + motylek)', bundleLearned: false,
        fields: [
          { field: 'google_title', label: 'Titulek', manual: false,
            value: 'Bordó pánské široké kšandy s pravou kůží | Quentino',
            feed: 'Bordó pánské široké kšandy s pravou kůží | Quentino',
            suggested: 'Bordó pánské široké kšandy Bordó 3,5 cm | Quentino' },
          { field: 'google_desc', label: 'Popis', manual: false,
            value: 'Bordó pánské kšandy Quentino z kvalitní pruženky, šířka 3,5 cm, kovové klipy a pravá kůže. Vyrobeno v České republice.',
            feed: 'Bordó pánské kšandy Quentino z kvalitní pruženky, šířka 3,5 cm, kovové klipy a pravá kůže. Vyrobeno v České republice.',
            suggested: '' },
          { field: 'google_color', label: 'Barva', value: '', feed: '', suggested: 'Červená', manual: false },
          { field: 'google_gender', label: 'Pohlaví', value: 'male', feed: 'male', suggested: 'male', manual: false },
          { field: 'google_age', label: 'Věková skupina', value: '', feed: '', suggested: 'adult', manual: false },
          { field: 'google_condition', label: 'Stav', value: 'new', feed: 'new', suggested: 'new', manual: false },
          { field: 'google_bundle', label: 'Set', value: 'yes', feed: '', suggested: 'yes', manual: true },
          { field: 'google_identifier', label: 'Má čárový kód', value: 'no', feed: 'no', suggested: 'no', manual: false }
        ] }
    ],
    'ptrans:auditOf': [
      { code: 'PSSK120BR2', title: 'Bordó pánské široké kšandy s černou pravou kůží', lang: 'cz', score: 62,
        issues: [
          { key: 'google_color.missing', severity: 'warn', field: 'google_color', fixable: true,
            message: 'Chybí barva pro Google. Z parametru vychází „Červená".' },
          { key: 'google_age.missing', severity: 'warn', field: 'google_age', fixable: true,
            message: 'Chybí věková skupina (vychází „adult").' },
          { key: 'seo_desc.short', severity: 'warn', field: 'seo_desc', fixable: true,
            message: 'Meta popis má 48 znaků, nevyužívá dostupné místo.' },
          { key: 'param.material', severity: 'info', fixable: false,
            message: 'Produkt nemá parametr Materiál.' }
        ] }
    ],
    'ptrans:audit': {
      checked: 3612, averageScore: 88,
      byLang: [
        { lang: 'cz', average: 83, errors: 79, warnings: 239 },
        { lang: 'sk', average: 91, errors: 67, warnings: 63 },
        { lang: 'en', average: 91, errors: 67, warnings: 29 }
      ],
      top: [
        { key: 'identifier.mismatch', severity: 'warn', count: 200,
          message: 'Produkt nemá EAN, ale nemá ani nastavené „nemá čárový kód" — Google pak nabídku hůř páruje.' },
        { key: 'google_color.missing', severity: 'warn', count: 54,
          message: 'Chybí barva pro Google. Z parametru vychází „Červená".' },
        { key: 'seo_title.offtopic', severity: 'warn', count: 41,
          message: 'SEO titulek neobsahuje hlavní slovo z názvu produktu.' },
        { key: 'google_title.missing', severity: 'error', count: 39,
          message: 'Chybí titulek pro Google Nákupy.' },
        { key: 'google_desc.promo', severity: 'error', count: 25,
          message: 'Popis pro Google obsahuje reklamní text nebo výzvu ke kliknutí.' }
      ]
    },
    'ptrans:worst': [
      { code: 'PSSK120BR2', title: 'Bordó pánské široké kšandy s černou pravou kůží', score: 7, errors: 4 },
      { code: 'PKT23', title: 'Bílá svatební regata s jemnou strukturou a kapesníčkem', score: 7, errors: 4 },
      { code: 'MZU01', title: 'Bílý pánský kapesníček do saka s tmavě fialovým lemem', score: 24, errors: 3 }
    ],
    'ptrans:colors': {
      rules: [
        { source: 'modra', base: 'modra', hits: 210, origin: 'feed', locked: false },
        { source: 'vinova', base: 'cervena', hits: 58, origin: 'feed', locked: false },
        { source: 'smetanova', base: 'bezova', hits: 31, origin: 'feed', locked: false },
        { source: 'smaragdova', base: 'zelena', hits: 4, origin: 'manual', locked: true }
      ],
      base: [
        { key: 'cerna', labels: { cz: 'Černá', sk: 'Čierna', en: 'Black', de: 'Schwarz' } },
        { key: 'modra', labels: { cz: 'Modrá', sk: 'Modrá', en: 'Blue', de: 'Blau' } },
        { key: 'zelena', labels: { cz: 'Zelená', sk: 'Zelená', en: 'Green', de: 'Grün' } },
        { key: 'cervena', labels: { cz: 'Červená', sk: 'Červená', en: 'Red', de: 'Rot' } },
        { key: 'bezova', labels: { cz: 'Béžová', sk: 'Béžová', en: 'Beige', de: 'Beige' } },
        { key: 'vicebarevna', labels: { cz: 'Vícebarevná', sk: 'Viacfarebná', en: 'Multicolour', de: 'Mehrfarbig' } }
      ]
    },
    'ptrans:bundles': {
      rules: [
        { category: 'Pánské sety Motýlek a Kšandy', pattern: 'ksandy motylek', isBundle: true, hits: 30, updatedAt: null },
        { category: '', pattern: 'motylek kvetinka', isBundle: false, hits: 4, updatedAt: null }
      ],
      preview: {
        total: 1204, bundles: 153,
        samples: [
          { code: 'PSSK120BR2', title: 'Stříbrné pánské kšandy s motýlkem',
            reason: 'název spojuje dva výrobky (ksandy + motylek)' },
          { code: 'PKT23', title: 'Starorůžový set s květovaným motýlkem pro tátu a syna',
            reason: 'název obsahuje „set"' }
        ]
      }
    },
    'ptrans:learnColors': { products: 1192, learned: 19, unknown: [] },
    'ptrans:auditSummary': null,
    'ptrans:memory': {
      entries: [
        { id: 1, kind: 'term', lang: 'en', source: 'kšandy', target: 'suspenders', category: '',
          hits: 96, confidence: 0.97, origin: 'feed', locked: 0 },
        { id: 2, kind: 'term', lang: 'en', source: 'pánská kravata', target: "men's necktie", category: '',
          hits: 121, confidence: 0.98, origin: 'feed', locked: 0 },
        { id: 3, kind: 'term', lang: 'en', source: 'kapesníček', target: "men's pocket square",
          category: '', hits: 64, confidence: 0.93, origin: 'feed', locked: 0 },
        { id: 4, kind: 'term', lang: 'en', source: 'motýlek matný', target: 'matte bow tie',
          category: 'Motýlci', hits: 12, confidence: 1, origin: 'manual', locked: 1 }
      ],
      stats: [
        { lang: 'sk', terms: 503, patterns: 35, examples: 123, manual: 2 },
        { lang: 'en', terms: 461, patterns: 35, examples: 121, manual: 1 }
      ]
    },
    'ptrans:learn': [{ lang: 'en', pairs: 461, terms: 461, patterns: 35, examples: 121 }],
    'articles:overview': {
      settings: {
        sourceLang: 'cz',
        languages: [
          { code: 'cz', label: 'Čeština', enabled: true, domain: 'https://www.quentino.cz' },
          { code: 'sk', label: 'Slovenština', enabled: true, domain: 'https://www.quentino.sk' },
          { code: 'en', label: 'Angličtina', enabled: true, domain: 'https://www.wearquentino.com' }
        ],
        prompt: 'Jsi zkušený copywriter české rodinné značky Quentino…',
        wordCount: 900, model: '', researchTerms: true, productPrefix: '/p/', articlePrefix: '/a/'
      },
      summary: { total: 25, drafts: 3, byLang: [{ lang: 'cz', n: 25 }, { lang: 'sk', n: 25 }, { lang: 'en', n: 25 }] },
      running: null, checking: null, urlmap: 348
    },
    'articles:list': [
      { id: 1, articleId: '67', topic: 'Co obléct dětem na vysvědčení a první školní den',
        status: 'ready', sourceLang: 'cz', wordCount: 1200, langs: ['cz', 'sk', 'en'], prompt: '',
        brief: { products: ['PKT23'], productImages: {}, includeProductImages: true, productLayout: 'block',
          productSize: 'medium', images: [], links: [], titleFixed: false, title: '' },
        terms: '', origin: 'import', createdAt: '', updatedAt: '',
        versions: [{ lang: 'cz', state: 'imported', words: 1375 }, { lang: 'sk', state: 'translated', words: 1435 },
          { lang: 'en', state: 'imported', words: 1873 }] },
      { id: 2, articleId: null, topic: 'Jak vybrat motýlka na svatbu podle barvy obleku',
        status: 'draft', sourceLang: 'cz', wordCount: 900, langs: ['cz', 'sk'], prompt: '',
        brief: { products: [], productImages: {}, includeProductImages: true, productLayout: 'block',
          productSize: 'medium', images: [], links: [], titleFixed: false, title: '' },
        terms: '', origin: 'new', createdAt: '', updatedAt: '',
        versions: [{ lang: 'cz', state: 'generated', words: 942 }, { lang: 'sk', state: 'empty', words: 0 }] },
      { id: 3, articleId: null, topic: '', status: 'draft', sourceLang: 'cz', wordCount: 600,
        langs: ['cz'], prompt: '',
        brief: { products: [], productImages: {}, includeProductImages: true, productLayout: 'block',
          productSize: 'medium', images: [], links: [], titleFixed: false, title: '' },
        terms: '', origin: 'new', createdAt: '', updatedAt: '', versions: [] }
    ],
    'articles:get': {
      id: 1, articleId: '67', topic: 'Co obléct dětem na vysvědčení a první školní den',
      status: 'ready', sourceLang: 'cz', wordCount: 1200, langs: ['cz', 'sk', 'en'], prompt: '',
      brief: {
        products: ['PKT23'], productImages: {}, includeProductImages: true,
        productLayout: 'block', productSize: 'medium',
        images: [{ url: 'https://quentino.s19.cdn-upgates.com/q/priklad.jpg',
          description: 'Tobias s vysvědčením', size: 'auto', layout: 'block', isListing: true }],
        links: [{ name: 'Dětské kravaty', urls: { cz: 'https://www.quentino.cz/detske-kravaty/' } }],
        titleFixed: false, title: 'Co obléct dětem na vysvědčení'
      },
      terms: 'HLAVNÍ: co obléct dětem na vysvědčení\nVEDLEJŠÍ: dětská kravata, slavnostní oblečení pro chlapce…',
      origin: 'import', createdAt: '2026-07-07T16:54:38Z', updatedAt: '2026-08-20T10:00:00Z',
      versions: [
        { lang: 'cz', title: 'Co obléct dětem na vysvědčení a první školní den', slug: 'co-oblect-detem',
          short: 'Jak slavnostně obléct chlapce na vysvědčení nebo první školní den.',
          long: '<div style="max-width:900px;margin:0 auto;line-height:1.7"><p style="text-align:justify">Vysvědčení nebo první školní den — to není jen další ráno.</p><h2 style="font-size:1.4rem">Proč na tom záleží</h2><p style="text-align:justify">Oblečení je jeden z nejjednodušších způsobů, jak dítěti ukázat, že daný den má váhu.</p><p><a href="https://www.quentino.cz/p/salvejove-zelena-detska-kravata">Šalvějově zelená dětská kravata</a></p></div>',
          seo_title: 'Co obléct dětem na vysvědčení | Quentino', seo_desc: 'Praktický průvodce slavnostním oblečením pro chlapce.',
          seo_url: 'co-oblect-detem-na-vysvedceni', state: 'imported', updatedAt: null, words: 1375 },
        { lang: 'sk', title: 'Čo obliecť deťom na vysvedčenie', slug: 'co-obliect-detom',
          short: 'Ako slávnostne obliecť chlapca na vysvedčenie.', long: '<p>Slovenská verze…</p>',
          seo_title: 'Čo obliecť deťom | Quentino', seo_desc: 'Sprievodca slávnostným oblečením.',
          seo_url: 'co-obliect-detom-na-vysvedcenie', state: 'translated', updatedAt: null, words: 1435 },
        { lang: 'en', title: 'What to Wear for the First Day of School', slug: 'what-to-wear',
          short: 'How to dress a boy for a school celebration.', long: '<p>English version…</p>',
          seo_title: 'What to Wear | Quentino', seo_desc: 'A practical guide.',
          seo_url: 'what-to-wear-first-day-school', state: 'imported', updatedAt: null, words: 1873 }
      ]
    },
    'articles:products': [
      { code: 'PKT23', title: 'Bordó pánská kravata BULDOČCI',
        url: 'https://www.quentino.cz/p/bordo-panska-kravata-buldocci', image: null }
    ],
    'articles:links': [
      'https://www.quentino.cz/p/salvejove-zelena-detska-kravata',
      'https://www.quentino.cz/detske-kravaty/'
    ],
    'articles:review': {
      title: 'Co obléct dětem na vysvědčení',
      html: '<div style="max-width:900px;line-height:1.7"><p>Vysvědčení nebo první školní den — to není jen další ráno. Podívejte se na <a href="https://www.quentino.cz/p/salvejove-zelena-detska-kravata" data-link="1" data-tone="ok" target="_blank">šalvějově zelenou dětskou kravatu<sup class="lnk">1</sup></a>.</p><p>Další kousky najdete v kategorii <a href="https://www.quentino.cz/detske-kravaty/" data-link="2" data-tone="bad" target="_blank">dětské kravaty<sup class="lnk">2</sup></a> a taky mezi <a href="https://www.quentino.cz/p/stara-adresa" data-link="3" data-tone="unknown" target="_blank">novinkami<sup class="lnk">3</sup></a>.</p></div>',
      links: [
        { index: 1, url: 'https://www.quentino.cz/p/salvejove-zelena-detska-kravata',
          text: 'šalvějově zelenou dětskou kravatu', kind: 'product', status: null,
          note: '', suggestion: null, unverified: false },
        { index: 2, url: 'https://www.quentino.cz/detske-kravaty/', text: 'dětské kravaty',
          kind: 'category', status: 404, note: 'HTTP 404',
          suggestion: 'https://www.quentino.cz/detske/', unverified: false },
        { index: 3, url: 'https://www.quentino.cz/p/stara-adresa', text: 'novinkami',
          kind: 'product', status: null,
          note: 'nepodařilo se ověřit — server neodpověděl ani po opakování',
          suggestion: null, unverified: true }
      ]
    },
    'articles:dismissLink': true,
    'articles:lastCheck': [
      { id: 1, articleId: 1, articleTitle: 'Co obléct dětem na vysvědčení', lang: 'cz',
        url: 'https://www.quentino.cz/p/stara-adresa-kravaty', kind: 'product', status: 404,
        suggestion: 'https://www.quentino.cz/p/salvejove-zelena-detska-kravata',
        note: 'produkt PKT23 — adresa se změnila, stará vede přes 301' },
      { id: 2, articleId: 1, articleTitle: 'Co obléct dětem na vysvědčení', lang: 'sk',
        url: 'https://www.quentino.sk/detske-kravaty-stare/', kind: 'category', status: null,
        suggestion: null, unverified: true,
        note: 'nepodařilo se ověřit — server neodpověděl ani po opakování' }
    ],
    'articles:urlmap': [
      { fromLang: 'cz', fromPath: '/kravaty', toLang: 'en', toPath: '/neckties', kind: 'category',
        hits: 5, locked: 0, updatedAt: null },
      { fromLang: 'cz', fromPath: '/staroruzova-kolekce', toLang: 'sk', toPath: '/staroruzova-kolekcia',
        kind: 'category', hits: 3, locked: 0, updatedAt: null },
      { fromLang: 'cz', fromPath: '/detske-kravaty', toLang: 'en', toPath: '/kids-neckties',
        kind: 'category', hits: 1, locked: 1, updatedAt: null }
    ],
    'articles:progress': null,
    'articles:checkProgress': null,
    'products:status': { url: '', count: 0, lastSync: null },
    // Poukazy: jedna šablona s pevným kódem, jedna se zásobou — a k tomu
    // jeden kód, který podle synchronizace vydala dvě zařízení, aby bylo
    // vidět, jak vypadá hláška o kolizi
    'vouchers:list': [
      { id: 'tpl-300', name: 'Omluva za zpožděnou zásilku 300 Kč', value: '300', unit: 'CZK',
        validUntil: '2027-06-30', note: 'Platí při nákupu nad 1 500 Kč', lang: 'cz',
        codeMode: 'unique', fixedCode: '', codesTotal: 120, codesFree: 61, codesMine: 20,
        codesDup: 1, updatedAt: '2026-08-24T09:12:00Z' },
      { id: 'tpl-doprava', name: 'Doprava zdarma — reklamace', value: '', unit: 'shipping',
        validUntil: '2026-12-31', note: '', lang: 'cz', codeMode: 'fixed',
        fixedCode: 'DOPRAVAZDARMA', codesTotal: 0, codesFree: 0, codesMine: 0, codesDup: 0,
        updatedAt: '2026-08-11T14:40:00Z' }
    ],
    'vouchers:codes': [
      { code: 'Q7H2-4KDA', usedAt: null, usedFor: '', usedBy: '', claimedElsewhere: false, duplicate: '' },
      { code: 'Q7H2-9XPL', usedAt: null, usedFor: '', usedBy: '', claimedElsewhere: false, duplicate: '' },
      { code: 'Q7H2-2MRT', usedAt: null, usedFor: '', usedBy: '', claimedElsewhere: true, duplicate: '' },
      { code: 'Q7H2-8BQZ', usedAt: null, usedFor: '', usedBy: '', claimedElsewhere: true, duplicate: '' },
      { code: 'Q7H2-1CVN', usedAt: '2026-08-22T10:04:00Z', usedFor: 'novak@seznam.cz',
        usedBy: 'mac', claimedElsewhere: false, duplicate: '' },
      { code: 'Q7H2-5RGW', usedAt: '2026-08-23T16:20:00Z', usedFor: 'svobodova@gmail.com',
        usedBy: 'mac', claimedElsewhere: false, duplicate: 'iPhone (7e44a732)@2026-08-23T18:02:00Z' }
    ],
    'vouchers:clashes': [
      { templateId: 'tpl-300', templateName: 'Omluva za zpožděnou zásilku 300 Kč',
        code: 'Q7H2-5RGW', used: '2026-08-23T16:20:00Z', usedFor: 'svobodova@gmail.com',
        duplicate: 'iPhone (7e44a732)@2026-08-23T18:02:00Z' }
    ]
  };
  // „Sladit teď" vrací tentýž seznam — v náhledu není s čím se slaďovat
  answers['vouchers:sync'] = answers['vouchers:list'];
  // „Vybrat všech N" — v náhledu stačí kódy z první stránky
  answers['ptrans:codes'] = answers['ptrans:list'].rows.map(row => row.code);

  // Balení: dvě objednávky ze stejné karty, jedna rozdělaná a jedna hotová
  // Stav „Přijata" je ten, který se balí — „Odeslána" si aplikace schovává sama
  const toPack = (number) => Object.assign({}, answers['orders:card'], {
    orderNumber: number,
    live: Object.assign({}, answers['orders:card'].live, { status: 'Přijata' }),
    tracking: Object.assign({}, answers['orders:card'].tracking, { status: 'Přijata' })
  });
  answers['packing:scan'] = {
    orders: [
      { messageId: 1, date: new Date(Date.now() - 3 * 3600e3).toISOString(),
        card: toPack('20260819'), packed: [0], done: false, doneAt: null },
      { messageId: 2, date: new Date(Date.now() - 26 * 3600e3).toISOString(),
        card: toPack('20260812'), packed: [], done: false, doneAt: null }
    ],
    statuses: ['Přijata'],
    scannedAt: new Date().toISOString()
  };

  window.api = {
    invoke: function (channel, arg) {
      // Náhledy se střídají podle příspěvku, ať je vidět víc poměrů stran
      if (channel === 'ig:thumb') {
        var list = answers['ig:thumb'] || [];
        return Promise.resolve({ ok: true, data: list[(Number(arg) || 0) % list.length] || null });
      }
      return Promise.resolve({ ok: true, data: channel in answers ? answers[channel] : null });
    },
    on: function (channel, cb) {
      if (!listeners.has(channel)) listeners.set(channel, new Set());
      listeners.get(channel).add(cb);
      return function () { listeners.get(channel).delete(cb); };
    }
  };
  // Jen pro náhledy: vyvolá událost, jako by ji poslal hlavní proces
  window.__emit = function (channel, payload) {
    (listeners.get(channel) || []).forEach(function (cb) { cb(payload); });
  };
  const root = document.documentElement;
  root.dataset.platform = 'ios';
  root.dataset.form = 'phone';   // přesně to, co teď posílá nativní obal
})();
