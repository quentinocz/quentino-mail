/**
 * Zkouška popisků v seznamu zpráv — bez prohlížeče.
 *
 * Obojí jsou drobnosti, které okem zkontroluje jen ten, kdo zrovna ví, na co
 * se dívat, a obojí se v provozu ukázalo jako špatně:
 *
 *  1. **Čas versus datum.** Rozhodovat podle kalendářního dne znamená, že se
 *     zpráva z včerejška v jedenáct večer po půlnoci přepne na datum, i když
 *     je stará hodinu.
 *  2. **V odeslané poště je zajímavý příjemce.** Odesílatel jsme tam pořád my,
 *     takže sloupec ukazoval u každého řádku vlastní jméno.
 */
const path = require('path');
const { DIST } = require('./ptrans/harness.cjs');

const { fmtDate, recipients } = require(path.join(DIST, '../shared/maillist.js'));

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

const ago = (ms) => new Date(Date.now() - ms).toISOString();
const HOUR = 3_600_000;
const isTime = (text) => /^\d{1,2}:\d{2}$/.test(text);
const isDate = (text) => /^\d{1,2}\.\s*\d{1,2}\.?$/.test(text.trim());

/* ---------- čas nebo datum ---------- */

console.log('\nČas u čerstvé pošty');

ok('před hodinou je čas', isTime(fmtDate(ago(HOUR))), fmtDate(ago(HOUR)));
ok('před dvaceti hodinami je pořád čas', isTime(fmtDate(ago(20 * HOUR))), fmtDate(ago(20 * HOUR)));

/*
 * Hranice je čtyřiadvacet hodin, ne půlnoc. Tohle je ta chyba, kvůli které se
 * to předělávalo: zpráva stará dvacet hodin může být „včera" a podle
 * kalendáře by dostala datum.
 */
ok('těsně pod čtyřiadvacet hodin je čas',
  isTime(fmtDate(ago(23.5 * HOUR))), fmtDate(ago(23.5 * HOUR)));
ok('nad čtyřiadvacet hodin je datum',
  isDate(fmtDate(ago(25 * HOUR))), fmtDate(ago(25 * HOUR)));

ok('týden stará zpráva má datum', isDate(fmtDate(ago(7 * 24 * HOUR))), fmtDate(ago(7 * 24 * HOUR)));

/*
 * Rozhozené hodiny na straně odesílatele se stávají. Datum vpřed by mátlo
 * víc než čas, takže se budoucnost bere jako čerstvá.
 */
ok('čas v budoucnosti se bere jako čerstvý',
  isTime(fmtDate(ago(-2 * HOUR))), fmtDate(ago(-2 * HOUR)));

// U starší zprávy z jiného roku musí být vidět i rok
ok('loňská zpráva má v datu rok',
  /\d{2}$/.test(fmtDate(ago(400 * 24 * HOUR))), fmtDate(ago(400 * 24 * HOUR)));

/* ---------- komu to šlo ---------- */

console.log('\nPříjemci v odeslané poště');

check('jeden příjemce', recipients('jana@seznam.cz'), 'jana@seznam.cz');
check('víc příjemců se zkrátí', recipients('jana@seznam.cz, petr@gmail.com, sk@quentino.sk'),
  'jana@seznam.cz +2');
check('mezery navíc nevadí', recipients('  jana@seznam.cz ,  petr@gmail.com '), 'jana@seznam.cz +1');
check('prázdná hlavička', recipients(''), '(bez příjemce)');
check('chybějící hlavička', recipients(undefined), '(bez příjemce)');
check('čárka na konci nedělá příjemce navíc', recipients('jana@seznam.cz,'), 'jana@seznam.cz');

console.log(failed === 0 ? '\n✓ seznam zpráv sedí' : `\n✗ ${failed} nesedí`);
process.exit(failed === 0 ? 0 : 1);
