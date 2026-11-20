/**
 * Zkouška trezoru sdíleného nastavení — dva Macy nad jednou složkou.
 *
 * Trezor přenáší hesla a klíče, a tak tu jde o dvě věci zároveň: aby
 * nastavení z jednoho Macu opravdu došlo na druhý (jinak se klíče zase
 * přepisují ručně), a aby se tajemství nikdy neocitlo ve složce čitelně
 * a bez hesla trezoru se k němu nikdo nedostal.
 *
 * Druhý Mac se napodobí tak, že se databáze vyprázdní (jako čerstvá
 * instalace) a sdílená složka zůstane.
 *
 *   node tools/vault-test.cjs
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { db, DIST } = require('./ptrans/harness.cjs');

// Klíčenka mimo aplikaci není: šifra = předpona + base64, ať se dá poznat i přečíst
const secPath = require.resolve(path.join(DIST, 'secure.js'));
require.cache[secPath] = { id: secPath, filename: secPath, loaded: true, exports: {
  encrypt: v => 'loc:' + Buffer.from(String(v)).toString('base64'),
  decrypt: v => (String(v).startsWith('loc:') ? Buffer.from(String(v).slice(4), 'base64').toString() : String(v))
} };
const vault = require(path.join(DIST, 'vault.js'));
const enc = v => 'loc:' + Buffer.from(v).toString('base64');

let failed = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${label}`);
  if (!ok) { console.log('      čekáno:', JSON.stringify(want)); console.log('      dostal:', JSON.stringify(got)); }
}

db.exec(`CREATE TABLE IF NOT EXISTS accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, email TEXT UNIQUE,
  imap_host TEXT, imap_port INTEGER, imap_secure INTEGER, smtp_host TEXT, smtp_port INTEGER, smtp_secure INTEGER,
  username TEXT, pass_enc TEXT, signature_html TEXT, sig_json TEXT, color TEXT)`);
db.exec(`CREATE TABLE IF NOT EXISTS ig_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, ig_user_id TEXT UNIQUE,
  username TEXT, lang TEXT, color TEXT, is_source INTEGER, token_enc TEXT, token_expires TEXT,
  page_id TEXT, page_name TEXT, share_fb INTEGER)`);

const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'trezor-'));
const set = (k, v) => db.prepare('INSERT INTO settings(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v);
const get = k => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value;
const file = path.join(shared, 'nastaveni-aplikace.json');

/* ---------- Mac A ---------- */
console.log('\nMac A založí trezor');
set('syncEnabled', '1'); set('syncFolder', shared);
set('upgatesUrl', 'https://www.quentino.cz'); set('theme', 'dark');
set('upgatesKey', enc('tajny-upgates-klic'));
set('adsGoogleService', enc('{"client_email":"r@x","private_key":"KEY"}'));
set('mediaFfmpeg', '/opt/homebrew/bin/ffmpeg');
set('productFeedSync', '2026-11-20T10:00:00Z');
set('bannersPath', 'quentino-bannery.json'); // cesta v úložišti na webu, ne na disku
set('mediaSetup', '{"watch":["/Users/x/iCloud/Fotky"]}');
db.prepare(`INSERT INTO accounts (name, email, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure, username, pass_enc, color)
  VALUES ('Info', 'info@quentino.cz', 'imap.x', 993, 1, 'smtp.x', 465, 1, 'info@quentino.cz', ?, '#7c5cff')`).run(enc('heslo-k-poste'));

let chyba = '';
try { vault.setVaultPassphrase('kratke'); } catch (e) { chyba = e.message; }
check('krátké heslo trezoru se odmítne', /10 znaků/.test(chyba), true);
vault.setVaultPassphrase('dlouhe-heslo-trezoru');
const raw = fs.readFileSync(file, 'utf8');
check('soubor ve složce vznikl', fs.existsSync(file), true);
check('tajemství ve složce nejsou čitelně (klíče, hesla)', ['tajny-upgates-klic', 'heslo-k-poste', 'KEY'].some(t => raw.includes(t)), false);
check('ani jako base64 z klíčenky', raw.includes(enc('tajny-upgates-klic')), false);
const json = JSON.parse(raw);
check('běžné nastavení je ve složce', json.plain['s:upgatesUrl'].v, 'https://www.quentino.cz');
check('cesty k programům, hlídané složky a razítka stahování se nepřenášejí',
  [!!json.plain['s:mediaFfmpeg'], !!json.plain['s:mediaSetup'], !!json.plain['s:productFeedSync']], [false, false, false]);
check('cesta v úložišti na webu (bannersPath) se přenáší', json.plain['s:bannersPath']?.v, 'quentino-bannery.json');
check('e-mailový účet je ve složce bez hesla', [!!json.plain['a:info@quentino.cz'], raw.includes('pass_enc')], [true, false]);

/* ---------- Mac B (čerstvý) ---------- */
console.log('\nMac B: čerstvá instalace, bez hesla trezoru');
const snapshot = fs.readFileSync(file, 'utf8');
db.exec("DELETE FROM settings; DELETE FROM accounts; DELETE FROM ig_accounts;");
set('syncEnabled', '1'); set('syncFolder', shared);
set('theme', 'light'); // výchozí hodnota čerstvé instalace
vault.syncVault();
check('nastavení z Macu A došlo', get('upgatesUrl'), 'https://www.quentino.cz');
check('výchozí hodnota čerstvého Macu nepřebila nastavení ostatních', get('theme'), 'dark');
check('bez hesla trezoru klíče nedošly', get('upgatesKey') ?? null, null);
check('účet se založil (heslo zatím ne)', db.prepare("SELECT pass_enc FROM accounts WHERE email = 'info@quentino.cz'").get()?.pass_enc, '');
check('Mac bez hesla trezor ve složce nepřepsal', JSON.parse(fs.readFileSync(file, 'utf8')).vault.data, JSON.parse(snapshot).vault.data);

console.log('\nMac B zadá heslo trezoru');
chyba = '';
try { vault.setVaultPassphrase('spatne-heslo-trezoru'); } catch (e) { chyba = e.message; }
check('špatné heslo se pozná dřív, než by trezor přešifrovalo', /neotevře/.test(chyba), true);
vault.setVaultPassphrase('dlouhe-heslo-trezoru');
const dec = v => Buffer.from(String(v).slice(4), 'base64').toString();
check('klíče došly a jsou zašifrované klíčenkou tohoto Macu', [get('upgatesKey').startsWith('loc:'), dec(get('upgatesKey'))],
  [true, 'tajny-upgates-klic']);
check('servisní účet Google Ads došel', dec(get('adsGoogleService')), '{"client_email":"r@x","private_key":"KEY"}');
check('heslo k poště došlo', dec(db.prepare("SELECT pass_enc FROM accounts WHERE email = 'info@quentino.cz'").get().pass_enc), 'heslo-k-poste');

console.log('\nZměny po zavedení');
set('upgatesUrl', 'https://www.quentino.sk');
vault.syncVault();
check('změna na Macu B jde do složky', JSON.parse(fs.readFileSync(file, 'utf8')).plain['s:upgatesUrl'].v, 'https://www.quentino.sk');
set('adsGoogleService', '');
vault.syncVault();
const box = require(path.join(DIST, 'settings.js')).unseal(JSON.parse(fs.readFileSync(file, 'utf8')).vault, 'dlouhe-heslo-trezoru');
check('„odebrat klíč z tohoto Macu" nesmaže klíč na ostatních', !!box.entries['s:adsGoogleService']?.v, true);

// Jiný Mac mezitím změnil klíč — novější vyhrává
const remote = JSON.parse(fs.readFileSync(file, 'utf8'));
const entries = box.entries;
entries['s:upgatesKey'] = { v: 'novy-klic', t: new Date(Date.now() + 60_000).toISOString() };
remote.vault = require(path.join(DIST, 'settings.js')).seal({ check: 'quentino', entries }, 'dlouhe-heslo-trezoru');
fs.writeFileSync(file, JSON.stringify(remote));
vault.syncVault();
check('novější klíč z jiného Macu se převezme', dec(get('upgatesKey')), 'novy-klic');

fs.rmSync(shared, { recursive: true, force: true });
console.log(failed ? `\n✗ ${failed} chyb` : '\n✓ trezor sedí');
process.exit(failed ? 1 : 0);
