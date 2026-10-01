/**
 * Zkouška uložení hesel.
 *
 * Zkouší se to, co se jinak pozná jen tím, že vyskočí dialog systému —
 * a na sestavovacím stroji ani v zkoušce žádný nevyskočí:
 *
 *  1. **v místním režimu se na klíčenku nesmí sáhnout.** Po přepnutí se
 *     všechno čitelné přepsalo, takže co zůstalo s předponou `enc:`, se
 *     přečíst stejně nedá — klíč k tomu patří jinému podpisu aplikace.
 *     Sáhnout na to znamená jen vyvolat dotaz na heslo ke klíčence,
 *     a právě kvůli němu se přepínalo. Tohle je přesně ta chyba, kvůli
 *     které se systém ptal i po přepnutí.
 *  2. **přepnutí musí uložená hesla přepsat**, jinak by po něm zůstala
 *     čitelná jen tím starým způsobem a nic by se nevyřešilo.
 *  3. **rozšifrování nikdy nevyhodí výjimku ven** — hláška „Error while
 *     decrypting the ciphertext" uživateli nic neřekne.
 *
 *   node tools/secure-test.cjs
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

const DIST = process.env.PTDIST || path.join(__dirname, '../dist/ptdist/main');

let sahlNaKlicenku = 0;
const domov = fs.mkdtempSync(path.join(os.tmpdir(), 'quentino-secure-'));

const ePath = require.resolve('electron');
require.cache[ePath] = {
  id: ePath, filename: ePath, loaded: true, exports: {
    app: { getPath: () => domov },
    safeStorage: {
      isEncryptionAvailable: () => { sahlNaKlicenku++; return true; },
      // Klíčenka v téhle zkoušce „šifruje" otočením — jde o to, kdy se volá
      encryptString: (v) => Buffer.from(String(v).split('').reverse().join(''), 'utf8'),
      decryptString: (buf) => { sahlNaKlicenku++; return Buffer.from(buf).toString('utf8').split('').reverse().join(''); }
    }
  }
};

const secure = require(path.join(DIST, 'secure.js'));

let failed = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${label}`);
  if (!ok) { console.log('      čekáno:', JSON.stringify(want)); console.log('      dostal:', JSON.stringify(got)); }
}
function ok(label, value, note = '') {
  if (!value) failed++;
  console.log(`  ${value ? '✓' : '✗'} ${label}`);
  if (!value && note) console.log(`      ${note}`);
}

/* Nastavení si zkouška drží sama — secure.ts na něj sahá přes líné vazby */
const nastaveni = new Map();
secure.connectSecure(
  (key, fallback = null) => (nastaveni.has(key) ? nastaveni.get(key) : fallback),
  (key, value) => nastaveni.set(key, value)
);

console.log('uložení hesel:\n');

/* ---------- klíčenka ---------- */

check('výchozí je systémová klíčenka', secure.secureMode(), 'keychain');
const vKlicence = secure.encrypt('tajne-heslo');
ok('hodnota z klíčenky je označená', vKlicence.startsWith('enc:'), vKlicence.slice(0, 8));
check('a přečte se zpátky', secure.decrypt(vKlicence), 'tajne-heslo');

/* ---------- klíč v datech aplikace ---------- */

nastaveni.set('secureMode', 'local');
check('režim se přepnul', secure.secureMode(), 'local');

const vSouboru = secure.encrypt('tajne-heslo');
ok('hodnota z místního klíče je označená jinak', vSouboru.startsWith('loc:'), vSouboru.slice(0, 8));
check('a přečte se zpátky', secure.decrypt(vSouboru), 'tajne-heslo');

/*
 * Jádro celé zkoušky. Stará hodnota z klíčenky se v místním režimu musí
 * přeskočit beze slova systému — jinak se macOS zeptá na heslo ke
 * klíčence přesně v situaci, kvůli které se přepínalo.
 */
sahlNaKlicenku = 0;
const zbytek = secure.decrypt(vKlicence);
check('stará hodnota z klíčenky vrátí prázdno, ne výjimku', zbytek, '');
ok('a na klíčenku se přitom vůbec nesáhlo', sahlNaKlicenku === 0, `sáhnutí: ${sahlNaKlicenku}`);

/* ---------- přepsání uloženého ---------- */

nastaveni.set('secureMode', 'keychain');
const radky = [
  { key: 'anthropicApiKey', value: secure.encrypt('klic-k-ai') },
  { key: 'upgatesKey', value: secure.encrypt('klic-k-eshopu') },
  { key: 'productFeedUrl', value: 'https://example.com/feed.xml' }
];
const ucty = [{ id: 1, pass_enc: secure.encrypt('heslo-k-poste') }];

const db = {
  prepare(sql) {
    return {
      all: () => {
        if (/FROM settings/.test(sql)) return radky.filter(r => /^(enc|loc):/.test(r.value));
        if (/FROM accounts/.test(sql)) return ucty;
        throw new Error('no such table: ig_accounts');
      },
      run: (hodnota, klic) => {
        if (/UPDATE settings/.test(sql)) {
          const r = radky.find(x => x.key === klic);
          if (r) r.value = hodnota;
        } else {
          const u = ucty.find(x => x.id === klic);
          if (u) u.pass_enc = hodnota;
        }
      }
    };
  }
};

const vysledek = secure.setSecureMode('local', db);
check('přepnutí přepsalo tři uložené hodnoty', vysledek.changed, 3);
ok('klíč k AI je teď v místním tvaru', radky[0].value.startsWith('loc:'), radky[0].value.slice(0, 8));
ok('heslo k poště taky', ucty[0].pass_enc.startsWith('loc:'), ucty[0].pass_enc.slice(0, 8));
check('a pořád se čtou správně',
  [secure.decrypt(radky[0].value), secure.decrypt(ucty[0].pass_enc)],
  ['klic-k-ai', 'heslo-k-poste']);
check('běžné nastavení se nešifruje', radky[2].value, 'https://example.com/feed.xml');

sahlNaKlicenku = 0;
secure.decrypt(radky[0].value);
secure.decrypt(ucty[0].pass_enc);
ok('po přepnutí už se klíčenka nepoužívá vůbec', sahlNaKlicenku === 0, `sáhnutí: ${sahlNaKlicenku}`);

/* ---------- co se nedá přečíst ---------- */

check('poškozená hodnota vrátí prázdno', secure.decrypt('loc:neplatne'), '');
check('neoznačená hodnota se vrátí tak, jak je', secure.decrypt('holy-text'), 'holy-text');

try { fs.rmSync(domov, { recursive: true, force: true }); } catch { /* úklid není kritický */ }

console.log(failed ? `\n${failed} věcí nesedí` : '\nuložení hesel sedí');
process.exit(failed ? 1 : 0);
