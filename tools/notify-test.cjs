/**
 * Zkouška upozornění na telefon — bez sítě.
 *
 * Dvě věci, na kterých to stojí a které se špatně kontrolují okem:
 *
 *  1. **Ven nesmí téct text zprávy.** Notifikace jde přes cizí server, takže
 *     se hlídá, co přesně se z e-mailu zákazníka dostane do titulku a textu.
 *  2. **SQL pro Supabase musí sedět na skutečné tabulky.** Vloží se do cizí
 *     databáze jednou a ručně; překlep v názvu sloupce se pozná až tím, že
 *     chat mlčí.
 */
const path = require('path');
const { db, DIST } = require('./ptrans/harness.cjs');

const notify = require(path.join(DIST, 'notify.js'));
const settings = require(path.join(DIST, 'settings.js'));

let failed = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${label}`);
  if (!ok) {
    console.log('      čekáno:', JSON.stringify(want));
    console.log('      dostal:', JSON.stringify(got));
  }
}

function ok(label, condition, detail) {
  if (!condition) failed++;
  console.log(`  ${condition ? '✓' : '✗'} ${label}`);
  if (!condition && detail) console.log('      ', detail);
}

/* ---------- 0. kdo čeká na odpověď ---------- */

/*
 * Nepřečtené zprávy nejsou totéž co nevyřízený chat: zprávu stačí
 * otevřít a nechat ji ležet — odznak zhasne a od té chvíle nic
 * nepřipomíná, že na druhé straně někdo čeká. Tohle počítá otevřené
 * rozhovory, kde poslední slovo má zákazník.
 *
 * Supabase se podstrčí, aby zkouška nepotřebovala síť; sleduje se
 * i to, co a kdy odejde na telefon.
 */
console.log('\nKdo čeká na odpověď');

const odeslano = [];
const supaPath = require.resolve(path.join(DIST, 'chat/supabase.js'));
let rozhovory = [];
require.cache[supaPath] = {
  id: supaPath, filename: supaPath, loaded: true, exports: {
    listConversations: async () => rozhovory,
    unreadTotal: async () => ({
      unread: rozhovory.reduce((s, c) => s + (c.unread || 0), 0),
      conversations: rozhovory.filter(c => c.unread > 0).length
    })
  }
};
const configPath = require.resolve(path.join(DIST, 'chat/config.js'));
require.cache[configPath] = {
  id: configPath, filename: configPath, loaded: true, exports: {
    isConfigured: () => true, markSeen: () => {}, getConfig: () => ({}), saveConfig: () => ({})
  }
};
const notifyPath = require.resolve(path.join(DIST, 'notify.js'));
const skutecnyNotify = require(notifyPath).__esModule ? require(notifyPath) : require(notifyPath);
require.cache[notifyPath] = {
  id: notifyPath, filename: notifyPath, loaded: true, exports: {
    ...skutecnyNotify,
    wantsNotify: () => true,
    chatLink: (id) => `quentino://chat/${id}`,
    notifyPhone: async (kind, title, message) => { odeslano.push({ kind, title, message }); return { ok: true }; }
  }
};

/*
 * Nastavení si při čtení sahá i do účtů pošty (kvůli zamčeným heslům).
 * Bez té tabulky `getSettings()` spadne — a protože `pollUnread` chyby
 * polyká, projevilo by se to jen tím, že se připomínka tiše neodešle.
 */
db.exec('CREATE TABLE IF NOT EXISTS accounts (id INTEGER PRIMARY KEY, pass_enc TEXT)');

const chat = require(path.join(DIST, 'chat/index.js'));

const pred = (minut) => new Date(Date.now() - minut * 60000).toISOString();

(async () => {
  rozhovory = [
    { id: 'a', name: 'Jana', unread: 0, answered: true, lastMessageAt: pred(5) },
    { id: 'b', name: 'Petr', unread: 1, answered: false, lastMessageAt: pred(42) },
    { id: 'c', name: 'Eva', unread: 0, answered: false, lastMessageAt: pred(9) }
  ];
  const ceka = await chat.cekajici();
  check('čekají ti, kde poslední slovo má zákazník', ceka.pocet, 2);
  check('nejdéle čekající je první', ceka.jmena[0], 'Petr');
  ok('a ví se, jak dlouho čeká', Math.abs(ceka.minut - 42) <= 1, `${ceka.minut} min`);
  check('odkaz vede na ten nejdéle čekající', ceka.id, 'b');

  /*
   * Přečtení nic nemění. Právě tohle odznak s nepřečtenými neuměl:
   * stačilo zprávu otevřít a zhasl, i když se neodpovědělo.
   */
  rozhovory[1].unread = 0;
  check('přečtení z čekajících nikoho neodebere', (await chat.cekajici()).pocet, 2);

  rozhovory = rozhovory.map(c => ({ ...c, answered: true }));
  check('po odpovědi nečeká nikdo', (await chat.cekajici()).pocet, 0);

  /* ---------- připomínání ---------- */

  settings.saveSettings({ notifyPhone: true, notifyTopic: 'test', notifyPhoneChat: true,
    notifyChatMode: 'once', notifyChatEvery: 15 });
  rozhovory = [{ id: 'b', name: 'Petr', unread: 1, answered: false, lastMessageAt: pred(42) }];
  odeslano.length = 0;
  await chat.pollUnread();
  check('v režimu „jednou" se nepřipomíná', odeslano.length, 0);

  settings.saveSettings({ notifyChatMode: 'repeat', notifyChatEvery: 15 });
  await chat.pollUnread();
  check('v režimu „připomínat" odejde upozornění', odeslano.length, 1);
  ok('a je v něm, jak dlouho se čeká', /42 min/.test(odeslano[0].message), odeslano[0].message);

  /* Hned podruhé se neposílá — jinak by telefon zvonil každých dvacet vteřin */
  await chat.pollUnread();
  check('podruhé hned nic neodejde', odeslano.length, 1);

  /* Čerstvá zpráva počká, než uplyne nastavená doba */
  require(path.join(DIST, 'db.js')).setSetting('chatNudgeAt', '0');
  rozhovory = [{ id: 'c', name: 'Eva', unread: 1, answered: false, lastMessageAt: pred(3) }];
  odeslano.length = 0;
  await chat.pollUnread();
  check('do uplynutí nastavené doby se nepřipomíná', odeslano.length, 0);

  /* ---------- 1. text notifikace ---------- */
  dalsiCast();
})();

function dalsiCast() {

console.log('\nText notifikace');

check('jedna zpráva: kdo a co',
  notify.mailNotification([{ fromName: 'Jana Nováková', fromAddr: 'jana@seznam.cz', subject: 'Reklamace kšand' }]),
  { title: 'Jana Nováková', message: 'Reklamace kšand' });

check('bez jména se vezme adresa',
  notify.mailNotification([{ fromName: '', fromAddr: 'info@upgates.cz', subject: 'Faktura' }]),
  { title: 'info@upgates.cz', message: 'Faktura' });

check('bez předmětu se to řekne',
  notify.mailNotification([{ fromName: 'Petr', fromAddr: null, subject: null }]),
  { title: 'Petr', message: '(bez předmětu)' });

check('víc zpráv se shrne',
  notify.mailNotification([
    { fromName: 'Jana', subject: 'Reklamace' },
    { fromName: 'Petr', subject: 'Dotaz' }
  ]),
  { title: '2 nové zprávy', message: 'Jana: Reklamace\nPetr: Dotaz' });

check('od pěti výš se skloňuje jinak',
  notify.mailNotification(Array.from({ length: 5 }, (_, i) => ({ fromName: `A${i}`, subject: 'x' }))).title,
  '5 nových zpráv');

/*
 * Nejdůležitější kontrola celého souboru: přes cizí server smí projít jen
 * odesílatel a předmět. Kdyby se sem někdy přidal náhled textu, spadne to tady.
 */
const secret = 'Číslo karty 4111 1111 1111 1111, prosím o vrácení peněz';
const out = notify.mailNotification([
  { fromName: 'Jana', fromAddr: 'jana@seznam.cz', subject: 'Vrácení zboží', body: secret, preview: secret }
]);
ok('text zprávy se ven nedostane',
  !JSON.stringify(out).includes('4111'), JSON.stringify(out));

/* ---------- 2. téma a adresa ---------- */

console.log('\nTéma');

const topic = notify.makeTopic();
ok('téma je dost dlouhé na to, aby se nedalo uhodnout', topic.length >= 30, topic);
ok('téma nemá znaky, které by se v adrese musely kódovat', /^[a-z0-9-]+$/.test(topic), topic);
ok('dvě témata za sebou nejsou stejná', notify.makeTopic() !== notify.makeTopic());

check('adresa tématu na výchozím serveru',
  notify.topicUrl('', 'quentino-abc'), 'https://ntfy.sh/quentino-abc');
check('lomítko navíc na konci serveru nevadí',
  notify.topicUrl('https://ntfy.example.com/', 'quentino-abc'),
  'https://ntfy.example.com/quentino-abc');

/* ---------- 3. odkazy do aplikace ---------- */

console.log('\nOdkazy');

/*
 * Zpráva se v odkazu určuje hlavičkou Message-ID, ne číslem řádku v databázi:
 * čísla má každé zařízení svoje, takže odkaz z počítače by v telefonu ukázal
 * na cizí zprávu. Message-ID obsahuje špičaté závorky a zavináč, které se
 * musí zakódovat, jinak se adresa rozpadne.
 */
check('odkaz na zprávu podle Message-ID',
  notify.mailLink('<abc.123@mail.example.com>'),
  'quentino-mail://mail?mid=%3Cabc.123%40mail.example.com%3E');

check('bez Message-ID se otevře aspoň pošta', notify.mailLink(null), 'quentino-mail://mail');
check('prázdná hlavička se bere jako chybějící', notify.mailLink('   '), 'quentino-mail://mail');

check('odkaz na konverzaci',
  notify.chatLink('7f3a-4b2c'), 'quentino-mail://chat?id=7f3a-4b2c');

/* ---------- 4. SQL pro Supabase ---------- */

console.log('\nSQL pro Supabase');

const sql = notify.chatWebhookSql('', 'quentino-tajne');

/*
 * Názvy tabulek a sloupců podle src/main/chat/supabase.ts: tabulky
 * `conversations` a `messages`, text zprávy je `content`, odesílatel `sender`.
 */
ok('trigger visí na tabulce messages', /on public\.messages/.test(sql), sql.slice(0, 80));
ok('bere se sloupec content, ne body', sql.includes('new.content') && !sql.includes('new.body'));
ok('jméno se hledá v conversations', sql.includes('from public.conversations'));
ok('upozorňuje se jen na zákazníka', sql.includes("new.sender is distinct from 'customer'"));

/*
 * Posílá se na kořen serveru. Na adresu tématu by ntfy bral celé tělo jako
 * text zprávy a z notifikace by byl výpis JSONu.
 */
ok('posílá se na kořen serveru, ne na adresu tématu',
  sql.includes("url := 'https://ntfy.sh'") && !sql.includes("url := 'https://ntfy.sh/quentino"));
ok('téma je v těle', sql.includes("'topic', 'quentino-tajne'"));
ok('klepnutí otevře konverzaci v aplikaci',
  sql.includes("'click', 'quentino-mail://chat?id=' || new.conversation_id"));

/*
 * pg_net si zakládá vlastní schéma `net`, takže se mu nesmí předepisovat, kam
 * se má nainstalovat — `with schema …` by spuštění shodilo hned na prvním
 * řádku. Zjistilo se to až čtením dokumentace, tak ať se to nevrátí.
 */
ok('rozšíření se instaluje bez určení schématu',
  /create extension if not exists pg_net;/.test(sql) && !/pg_net with schema/.test(sql));
ok('http_post se volá plným jménem', sql.includes('net.http_post('));

/*
 * Jediné DROP v celém skriptu smí být trigger téhož jména — kvůli tomu, aby
 * šel skript spustit znovu. Cokoli dalšího by v cizí databázi mohlo bolet.
 */
const drops = sql.split('\n').filter(line => /^\s*drop /i.test(line));
check('maže se jen vlastní trigger', drops,
  ['drop trigger if exists chat_message_notify on public.messages;']);
ok('nic se nemaže z tabulek',
  !/\bdelete\s+from\b|\btruncate\b|\balter\s+table\b|\bdrop\s+table\b/i.test(sql));

check('vlastní server se do SQL propíše',
  /url := '([^']+)'/.exec(notify.chatWebhookSql('https://ntfy.example.com/', 'x'))[1],
  'https://ntfy.example.com');

/* ---------- 5. přepínače ---------- */

console.log('\nPřepínače');

db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
// getSettings sahá i na účty, aby poznalo zamčenou klíčenku
db.exec('CREATE TABLE IF NOT EXISTS accounts (id INTEGER PRIMARY KEY, pass_enc TEXT)');
const set = (key, value) => db.prepare(
  'INSERT INTO settings(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
).run(key, value);

set('notifyPhone', '1');
set('notifyTopic', 'quentino-tajne');
set('notifyPhoneMail', '1');
set('notifyPhoneChat', '0');
check('pošta zapnutá, chat vypnutý',
  [notify.wantsNotify('mail'), notify.wantsNotify('chat')], [true, false]);

set('notifyPhone', '0');
check('hlavní vypínač přebíjí všechno', notify.wantsNotify('mail'), false);

set('notifyPhone', '1');
set('notifyTopic', '');
check('bez tématu není kam poslat', notify.wantsNotify('mail'), false);

/* ---------- 6. uložení ---------- */

console.log('\nUložení');

/*
 * Téma se vygeneruje jedním klepnutím a hned se zavírá okno — když se cestou
 * ztratí, pozná se to až tím, že notifikace nechodí. Proto se kontroluje, že
 * uložení dílčí změny projde a nesmaže po sobě zbytek.
 */
settings.saveSettings({ notifyTopic: 'quentino-ulozene', notifyPhone: true });
check('téma se uloží', settings.getSettings().notifyTopic, 'quentino-ulozene');

settings.saveSettings({ notifyPhoneChat: false });
check('dílčí uložení nesmaže téma',
  [settings.getSettings().notifyTopic, settings.getSettings().notifyPhoneChat],
  ['quentino-ulozene', false]);

check('okolní mezery se ořežou',
  (settings.saveSettings({ notifyTopic: '  quentino-x  ' }), settings.getSettings().notifyTopic),
  'quentino-x');

console.log(failed === 0 ? '\n✓ upozornění sedí' : `\n✗ ${failed} nesedí`);
  process.exit(failed === 0 ? 0 : 1);
}
