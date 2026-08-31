/**
 * Zkouška vývozu pro štítkovou tiskárnu.
 *
 * ZPL se pozná až na papíře, a to je pozdě — role má stovky štítků. Zkouška
 * proto hlídá to, co se dá spočítat: že se QR i s textem vejde do výšky
 * štítku, že souřadnice nikde nepřetečou přes okraj, že se řídicí znaky
 * nedostanou do dat a že soubor má správný počet dvojic ^XA…^XZ.
 *
 * Rozměry rolí jsou skutečné: 50 × 30 a 57 × 32 mm jsou běžné Zebra role,
 * 62 × 29 mm je Brotherovská DK-11209.
 */
const path = require('path');
const { DIST } = require('./ptrans/harness.cjs');
const labels = require(path.join(DIST, 'labels.js'));

let failed = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${label}`);
  if (!ok) { console.log('      čekáno:', JSON.stringify(want)); console.log('      dostal:', JSON.stringify(got)); }
}
function ok(label, value) { check(label, !!value, true); }

const ITEMS = [
  { code: 'PS120SM-120', title: 'Kšandy Slim tmavě modré', label: 'Délka: 120cm', count: 2 },
  { code: 'REGJ01', title: 'Kravata Regent bordó', label: '', count: 1 }
];

const ROLLS = [
  { name: '50 × 30 mm, 203 dpi', roll: { ...labels.DEFAULT_ROLL } },
  { name: '50 × 30 mm, 300 dpi', roll: { ...labels.DEFAULT_ROLL, dpi: 300 } },
  { name: '57 × 32 mm s názvem', roll: { ...labels.DEFAULT_ROLL, widthMm: 57, heightMm: 32, withTitle: true } },
  { name: '62 × 29 mm (DK-11209)', roll: { ...labels.DEFAULT_ROLL, widthMm: 62, heightMm: 29, withTitle: true } },
  // Malý štítek: QR se musí zmenšit, ne přetéct
  { name: '25 × 15 mm', roll: { ...labels.DEFAULT_ROLL, widthMm: 25, heightMm: 15 } }
];

console.log('\nco se na štítek vejde:\n');
for (const { name, roll } of ROLLS) {
  const plan = labels.zplPlan(roll);
  const zpl = labels.zplLabels(ITEMS, roll);

  // Nejvyšší Y souřadnice v souboru plus výška toho, co se na ni kreslí
  let bottom = 0;
  let right = 0;
  for (const m of zpl.matchAll(/\^FO(\d+),(\d+)\^A0N,(\d+)/g)) {
    bottom = Math.max(bottom, Number(m[2]) + Number(m[3]));
  }
  for (const m of zpl.matchAll(/\^FO(\d+),(\d+)\^BQN,2,(\d+)/g)) {
    bottom = Math.max(bottom, Number(m[2]) + Number(m[3]) * 25);
    right = Math.max(right, Number(m[1]) + Number(m[3]) * 25);
  }

  const fits = bottom <= plan.heightDots && right <= plan.widthDots;
  check(`${name}: vejde se do štítku`, fits, true);
  if (!fits) console.log(`      dno ${bottom}/${plan.heightDots}, pravý okraj ${right}/${plan.widthDots}`);
  console.log(`      QR ${plan.qrMm} mm (modul ${plan.magnification})`
    + `${plan.shrunk ? ' — zmenšeno, aby zbylo na text' : ''}`
    + `${plan.tooSmall ? ', na čtečku málo' : ''}`);
}

/*
 * Malý štítek se nemá tvářit, že to zvládne. Šest milimetrů čtečka na kód
 * o dvanácti znacích nepřečte a zjistilo by se to až u regálu.
 */
console.log('\nkdyž je štítek moc malý:\n');
ok('25 × 15 mm se přizná jako nedostatečné',
  labels.zplPlan({ ...labels.DEFAULT_ROLL, widthMm: 25, heightMm: 15 }).tooSmall);
ok('50 × 30 mm je v pořádku',
  !labels.zplPlan(labels.DEFAULT_ROLL).tooSmall);

console.log('\npodoba souboru:\n');
const zpl = labels.zplLabels(ITEMS, labels.DEFAULT_ROLL);
check('jeden štítek na položku', (zpl.match(/\^XA/g) || []).length, ITEMS.length);
check('a každý je uzavřený', (zpl.match(/\^XZ/g) || []).length, ITEMS.length);
ok('kód jde do QR', zpl.includes('^FDLA,PS120SM-120^FS'));
ok('a je i pod ním písmem', zpl.includes('^FDPS120SM-120^FS'));
ok('počet kusů se propíše', zpl.includes('^PQ2'));
ok('kóduje se v UTF-8', zpl.includes('^CI28'));
// Bez ^PW a ^LL tiskne Zebra podle toho, co si pamatuje z minula
ok('šířka i délka štítku jsou v souboru', zpl.includes('^PW') && zpl.includes('^LL'));

/*
 * `^` a `~` jsou v ZPL řídicí znaky. Kód produktu je nemá, ale soubor jde na
 * tiskárnu bez dalšího čtení — jeden takový znak v datech by se z popisku
 * stal příkazem.
 */
const nasty = labels.zplLabels(
  [{ code: 'A^B~C', title: 'X', label: '', count: 1 }], labels.DEFAULT_ROLL
);
ok('řídicí znak v kódu se zneškodní', nasty.includes('A-B-C') && !nasty.includes('A^B'));

console.log('\nCSV pro šablonu štítku:\n');
const csv = labels.labelsCsv(ITEMS);
ok('začíná BOMem, ať Excel nerozhází diakritiku', csv.charCodeAt(0) === 0xfeff);
check('hlavička a dva řádky', csv.trim().split('\r\n').length, 3);
ok('sloupce jsou oddělené středníkem', csv.includes('kod;nazev;varianta;pocet'));
ok('uvozovky v hodnotách jsou zdvojené',
  labels.labelsCsv([{ code: 'A"B', title: '', label: '', count: 1 }]).includes('"A""B"'));

console.log(failed ? `\n✗ ${failed} zkoušek selhalo\n` : '\n✓ vývoz pro štítkové tiskárny sedí\n');
process.exit(failed ? 1 : 0);
