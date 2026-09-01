/**
 * Zkouška archů štítků — sedí tisk na koupený arch?
 *
 * Kulaté štítky se lepí na sáčky a arch se kupuje hotový: výsek je daný a
 * netrefit se o dva milimetry znamená, že se každý štítek tiskne kouskem
 * vedle. Na papíře se to pozná až po vytištění, a to je pozdě — arch je
 * jednorázový.
 *
 * Čísla níž nejsou odhad. Jsou vytažená z výrobcovy šablony Y025025W066:
 * 66 kruhů, políčko 25,4 × 25,4 mm, rozteč 30,48 mm vodorovně a 25,40 mm
 * svisle, poslední sloupec končí na 193,90 mm a poslední řada na 288,20 mm.
 * Zkouška tedy neověřuje, že výpočet dává „nějaká" čísla, ale že dává
 * přesně ta, která má výsek.
 *
 * Kromě rozteče se hlídají dvě věci, které by tisk zkazily jinak:
 * že se QR i s kódem vejde do kruhu (do rohů políčka se tisknout nedá) a
 * že posun archu opravdu posune všechna políčka o totéž.
 */
const path = require('path');
const DIST = process.env.PTDIST || path.join(__dirname, '..', 'dist', 'ptdist');
const shared = require(path.join(DIST, 'shared', 'labels.js'));
const labels = require(path.join(DIST, 'main', 'labels.js'));

let failed = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${label}`);
  if (!ok) { console.log('      čekáno:', JSON.stringify(want)); console.log('      dostal:', JSON.stringify(got)); }
}
function ok(label, value) { check(label, !!value, true); }
/** Na setinu milimetru — dál tiskárna stejně nedosáhne */
function near(label, got, want, tol = 0.01) {
  const good = Math.abs(got - want) <= tol;
  if (!good) failed++;
  console.log(`  ${good ? '✓' : '✗'} ${label}`);
  if (!good) console.log(`      čekáno ${want} mm, dostal ${Math.round(got * 100) / 100} mm`);
}

const sheet = shared.templateById('y025025w066');

console.log('\narch Y025025W066 podle výrobcovy šablony:\n');
ok('arch je v nabídce', sheet);

const layout = sheet.layout;
const geom = shared.labelGeometry(layout);

near('políčko na šířku', geom.cellW, 25.4);
near('políčko na výšku', geom.cellH, 25.4);
near('rozteč sloupců', geom.cellW + layout.gap, 30.48);
near('rozteč řad', geom.cellH + shared.gapY(layout), 25.40);
// Kde končí poslední štítek — kdyby výpočet ujel, tiskne se mimo arch
near('pravý okraj posledního sloupce',
  layout.marginSide + 5 * (geom.cellW + layout.gap) + geom.cellW, 193.90);
near('spodní okraj poslední řady',
  layout.marginTop + 10 * (geom.cellH + shared.gapY(layout)) + geom.cellH, 288.20);
check('štítků na arch', geom.perPage, 66);

/*
 * Kruh, ne čtverec. Blok QR + kód stojí uprostřed, takže nejdál od středu
 * jsou horní rohy QR a dolní rohy textu — a ty musí zůstat uvnitř kružnice
 * i s vnitřní rezervou, jinak se štítek ořízne na okraji výseku.
 */
console.log('\nvejde se QR i s kódem do kruhu:\n');
const r = 25.4 / 2 - shared.safeMm(layout);
const k = geom.textH + 1;
const corner = Math.hypot(geom.qr / 2, (geom.qr + k) / 2);
/* Rozměry se ven hlásí zaokrouhlené na desetinu, takže roh smí být o půl
   kroku zaokrouhlení dál — na papíře je to pod přesností tiskárny. */
ok(`QR ${geom.qr} mm i s textem zůstává v kruhu (${Math.round(corner * 100) / 100} ≤ ${Math.round(r * 100) / 100} mm)`,
  corner <= r + 0.06);
ok('a je na co číst', !geom.tooSmall);
// Text sedí dole, kde je kruh užší než uprostřed — širší by přetekl
ok('šířka textu je tětiva, ne celé políčko', geom.textW < geom.cellW);

/* Vlastní arch 4 × 8 je hranatý a stříhá se — tam se text roztáhne přes celé políčko. */
const plain = shared.labelGeometry(shared.templateById('a4-4x8').layout);
ok('u hranatého archu text využije celou šířku',
  Math.abs(plain.textW - (plain.cellW - 2 * shared.safeMm(shared.templateById('a4-4x8').layout))) < 0.05);

/*
 * Sazba. Políčka se pokládají na přesné souřadnice, ne do mřížky — mřížka
 * si mezery dopočítává sama a u nulové svislé mezery se rozejde s výsekem.
 */
console.log('\nkde políčka doopravdy leží:\n');
const ITEMS = [{ code: 'PS120SM-120', title: 'Kšandy Slim', label: 'Délka: 120cm', count: 66 }];

function positions(html) {
  return [...html.matchAll(/class="cell" style="left:([\d.-]+)mm;top:([\d.-]+)mm"/g)]
    .map(m => ({ left: Number(m[1]), top: Number(m[2]) }));
}

labels.labelPreview(ITEMS, layout).then(async html => {
  const cells = positions(html);
  check('na stránce je 66 políček', cells.length, 66);
  near('první políčko zleva', cells[0].left, layout.marginSide);
  near('první políčko shora', cells[0].top, layout.marginTop);
  near('druhý sloupec je o rozteč dál', cells[1].left - cells[0].left, 30.48);
  near('druhá řada je o rozteč níž', cells[6].top - cells[0].top, 25.40);
  near('poslední políčko zleva', cells[65].left, 193.90 - 25.4);
  near('poslední políčko shora', cells[65].top, 288.20 - 25.4);
  ok('kruhy se kreslí kulaté', html.includes('border-radius: 50%'));
  ok('a mají naznačený řez', html.includes('outline: 0.2mm dashed'));
  ok('název se do kruhu netiskne — není kam', !html.includes('class="name"'));

  /*
   * Doladění tiskárny. Papír se nikdy nezavede na desetinu přesně; posun
   * musí hnout celým archem stejně, ne jen prvním políčkem.
   */
  const moved = positions(await labels.labelPreview(ITEMS, { ...layout, offsetX: 1.5, offsetY: -0.8 }));
  near('posun vpravo se propíše do prvního políčka', moved[0].left - cells[0].left, 1.5);
  near('a stejně i do posledního', moved[65].left - cells[65].left, 1.5);
  near('posun nahoru taky', moved[65].top - cells[65].top, -0.8);

  console.log(failed ? `\n✗ ${failed} zkoušek selhalo\n` : '\n✓ archy štítků sedí na výsek\n');
  process.exit(failed ? 1 : 0);
}).catch(error => {
  console.log('\n✗ sazba archu spadla:', error.message, '\n');
  process.exit(1);
});
