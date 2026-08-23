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
        operatorPersonId: 1, signMode: 'first', signSuffix: 'Quentino' },
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
    'ig:thumb': null,
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
          origin: 'feed', doneLangs: [], todoLangs: ['sk', 'en', 'de'],
          states: { sk: { total: 6, todo: 6, worst: 'same' }, en: { total: 6, todo: 6, worst: 'same' },
            de: { total: 6, todo: 6, worst: 'missing' } } },
        { code: 'MZU01', title: 'Bordó manžetové uzlíky', image: null, category: 'Manžetové knoflíčky',
          manufacturer: 'Quentino', availability: 'Skladem', price: '199 CZK', active: true,
          origin: 'file', doneLangs: ['en'], todoLangs: ['sk', 'de'],
          states: { sk: { total: 6, todo: 2, worst: 'missing' }, en: { total: 6, todo: 0, worst: 'ok' },
            de: { total: 6, todo: 6, worst: 'missing' } } },
        { code: 'PKT23', title: 'Bordó pánská kravata BULDOČCI', image: null, category: 'Kravaty',
          manufacturer: 'Quentino', availability: 'Skladem více než 20 ks', price: '449 CZK', active: true,
          origin: 'feed', doneLangs: ['en'], todoLangs: ['sk', 'de'],
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
    'vouchers:list': []
  };
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
    invoke: function (channel) {
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
