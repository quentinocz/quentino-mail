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

/* ---------- 1. text notifikace ---------- */

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

/* ---------- 3. SQL pro Supabase ---------- */

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

check('vlastní server se do SQL propíše',
  /url := '([^']+)'/.exec(notify.chatWebhookSql('https://ntfy.example.com/', 'x'))[1],
  'https://ntfy.example.com');

/* ---------- 4. přepínače ---------- */

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

console.log(failed === 0 ? '\n✓ upozornění sedí' : `\n✗ ${failed} nesedí`);
process.exit(failed === 0 ? 0 : 1);
