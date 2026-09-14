/**
 * Zkouška recenzí zákazníků.
 *
 * Vystavení do Supabase ani překlad se odsud vyzkoušet nedají. Zkouší se
 * to, co o výsledku rozhoduje a co by se poznalo až na hotovém e-shopu:
 *
 *  1. **co se vystavuje** — vypnutá recenze ani recenze bez fotky na web
 *     nepatří, a blok s recenzí se vykresluje jen tehdy, když má text
 *     i podpis; jinak visí citace bez toho, kdo ji řekl,
 *  2. **skript pro e-shop** — musí v sobě mít adresu dat i záložní kopii
 *     a nesmí se dát ukončit textem recenze (`</script>` uvnitř citace),
 *  3. **převzetí původního skriptu** — sedmadvacet recenzí se ručně
 *     přepisovat nebude, takže se čte to, co na e-shopu doopravdy je.
 */
const fs = require('fs');
const path = require('path');
const { db, DIST } = require('./ptrans/harness.cjs');

let failed = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${label}`);
  if (!ok) { console.log('      čekáno:', JSON.stringify(want)); console.log('      dostal:', JSON.stringify(got)); }
}
function ok(label, condition, detail = '') {
  if (!condition) failed++;
  console.log(`  ${condition ? '✓' : '✗'} ${label}`);
  if (!condition && detail) console.log('      ', detail);
}

const store = require(path.join(DIST, 'reviews/store.js'));
const wall = require(path.join(DIST, 'reviews/wall.js'));
db.exec(store.SCHEMA);

console.log('\nrecenze zákazníků:\n');

/* ---------- co se vystavuje ---------- */

const CDN = 'https://quentino.s19.cdn-upgates.com';
store.saveReview({
  id: 'a', image: `${CDN}/a/a1-svatba.webp`, width: 1000, height: 1000, sort: 0, active: true,
  langs: {
    cz: { caption: 'Ženich v <strong>hnědé kravatě</strong>.', review: '„Doporučuju!"', name: 'Tomáš' },
    sk: { caption: 'Ženích v <strong>hnedej kravate</strong>.', review: '„Odporúčam!"', name: 'Tomáš' }
  }
});
store.saveReview({
  id: 'b', image: `${CDN}/b/b2-motylek.webp`, width: 800, height: 800, sort: 1, active: true,
  // Recenze bez podpisu: text je, ale není vidět, kdo ho řekl
  langs: { cz: { caption: 'MINI motýlek.', review: '„Nádhera."', name: '' } }
});
store.saveReview({
  id: 'c', image: `${CDN}/c/c3-vypnuta.webp`, width: 600, height: 600, sort: 2, active: false,
  langs: { cz: { caption: 'Zatím neschválená.', review: '', name: '' } }
});
store.saveReview({
  id: 'd', image: '', sort: 3, active: true,
  langs: { cz: { caption: 'Rozdělaná, fotka ještě není.', review: '', name: '' } }
});

const items = store.wallItems();
check('vystavují se jen zapnuté recenze s fotkou',
  items.map(one => one.img), [`${CDN}/a/a1-svatba.webp`, `${CDN}/b/b2-motylek.webp`]);
check('tvar položky sedí s tím, co zeď čte',
  Object.keys(items[0]).sort(), ['cz', 'h', 'img', 'sk', 'w']);
check('popisek jde ven jako HTML', items[0].cz.captionHtml, 'Ženich v <strong>hnědé kravatě</strong>.');
check('recenze s podpisem se vystaví celá',
  [items[0].cz.reviewText, items[0].cz.reviewName], ['„Doporučuju!"', 'Tomáš']);
/*
 * Bez podpisu by na webu visela citace bez toho, kdo ji řekl. Text se proto
 * nevystaví vůbec — a v aplikaci na to rozhraní upozorňuje.
 */
ok('recenze bez podpisu se nevystaví', items[1].cz.reviewText === undefined, JSON.stringify(items[1]));
ok('ale popisek zůstane', items[1].cz.captionHtml === 'MINI motýlek.');
// Jazyk, který ještě není přeložený, se nevystavuje — zeď si vezme češtinu
ok('nepřeložený jazyk se nevystavuje', items[1].sk === undefined);

/* ---------- text se ukládá tak, jak se píše ---------- */

console.log('\ntext se drží tak, jak se napsal:');
{
  /*
   * Ořezávání při ukládání bylo k nepoužití: rozepsaná recenze se ukládá
   * průběžně, takže se každá mezera na konci vrátila z databáze zkrácená
   * a políčko se přepsalo pod rukama. V popisku (HTML) to navíc přehodilo
   * kurzor na začátek a vypadalo to, jako by psaní přestalo fungovat.
   */
  store.saveReview({
    id: 'mezera', image: `${CDN}/m/m-mezera.webp`, width: 900, height: 900, sort: 9, active: true,
    langs: { cz: { caption: '<p>Rozepsaná věta </p>', review: 'Skvělé ', name: 'Petr ' } }
  });
  const ulozena = store.listReviews().find(one => one.id === 'mezera');
  check('mezera na konci zůstane uložená',
    [ulozena.langs.cz.caption, ulozena.langs.cz.review, ulozena.langs.cz.name],
    ['<p>Rozepsaná věta </p>', 'Skvělé ', 'Petr ']);

  // Ořezává se až tam, kde na tom záleží — co jde na web
  const naWebu = store.wallItems().find(one => one.img.includes('m-mezera'));
  check('na web jde text ořezaný',
    [naWebu.cz.captionHtml, naWebu.cz.reviewText, naWebu.cz.reviewName],
    ['<p>Rozepsaná věta </p>', 'Skvělé', 'Petr']);

  // Popisek, ve kterém je jen mezera, na web nepatří
  store.saveReview({
    id: 'prazdna', image: `${CDN}/m/m-prazdna.webp`, width: 900, height: 900, sort: 10, active: true,
    langs: { cz: { caption: '   ', review: '', name: '' } }
  });
  const nic = store.wallItems().find(one => one.img.includes('m-prazdna'));
  ok('recenze jen s mezerou se nevystaví', nic !== undefined && nic.cz === undefined,
    JSON.stringify(nic));
}

/* ---------- pořadí ---------- */

console.log('\npořadí:');
{
  const before = store.listReviews().map(one => one.id);
  check('nová jde na začátek', before.slice(0, 2), ['a', 'b']);
  const moved = store.moveReview('b', -1).map(one => one.id);
  check('posun nahoru prohodí sousedy', moved.slice(0, 2), ['b', 'a']);
  // Přepočítává se celé pořadí; jinak by se čísla sesypala a posun přestal fungovat
  const again = store.moveReview('b', 1).map(one => one.id);
  check('a zpátky taky', again.slice(0, 2), ['a', 'b']);
  check('posun za okraj nic nerozhází',
    store.moveReview('a', -1).map(one => one.id).slice(0, 2), ['a', 'b']);
}

/* ---------- skript pro e-shop ---------- */

console.log('\nskript pro e-shop:');
{
  const source = 'https://xyzabc.supabase.co/storage/v1/object/public/web/quentino-recenze.json';
  const script = wall.reviewsScript(source, items, wall.DEFAULT_WALL);

  ok('skript je jeden blok', script.startsWith('<script defer>') && script.trim().endsWith('<\/script>'));
  ok('adresa dat je uvnitř', script.includes(source));
  ok('záložní kopie taky', script.includes('a1-svatba.webp'));
  ok('a je v něm kód zdi', script.includes('q-wall') && script.includes('q-btn-sm5'));

  /*
   * `</script>` v textu recenze by ukončilo celý blok dřív, než začne —
   * a zeď by se rozpadla i s kusem HTML navíc na stránce.
   */
  const zakerna = [{ img: `${CDN}/x/x-test.webp`, w: 1, h: 1,
    cz: { captionHtml: 'Konec <\/script> a pokračování' } }];
  const risky = wall.reviewsScript(source, zakerna, wall.DEFAULT_WALL);
  const uvnitr = risky.slice('<script defer>'.length, risky.length - '<\/script>'.length);
  ok('text recenze skript neukončí', !uvnitr.includes('<\/script>'), uvnitr.slice(0, 120));
  ok('a přitom v datech zůstane', risky.includes('<\\/script>'));
}

/* ---------- převzetí původního skriptu ---------- */

console.log('\npřevzetí původního skriptu:');
{
  const parse = require(path.join(DIST, 'reviews/index.js')).__test.parseLegacy;
  const legacy = `
    const GALLERY_DATA = [
      { img: 'https://cdn/x/1.webp', w: 828, h: 828,
        cz: { captionHtml: 'Táta a syn v kšandách.' },
        sk: { captionHtml: 'Otec a syn v trakoch.' },
        en: { captionHtml: "Father and son's braces." } },
      { img: 'https://cdn/x/2.webp', w: 480, h: 480,
        cz: { captionHtml: 'Parta v <strong><a href="https://www.quentino.cz/p/kravata">kravatách</a></strong>.',
              reviewText: '„Doplňky sedly perfektně."', reviewName: 'Tomáš' } }
    ];
  `;
  const rows = parse(legacy);
  check('přečtou se obě položky', rows.length, 2);
  // Apostrofy uvnitř textu jsou přesně to, na čem JSON.parse selže
  check('apostrof v textu nevadí', rows[0].en.captionHtml, "Father and son's braces.");
  check('rozměry se přenesou', [rows[0].w, rows[0].h], [828, 828]);
  check('i recenze s podpisem', rows[1].cz.reviewName, 'Tomáš');

  // Vyhodnocuje se v prázdném prostoru — vložený kód nemá na co sáhnout
  let unikl = null;
  try {
    unikl = parse("GALLERY_DATA = [ { img: (typeof process !== 'undefined' ? 'ANO' : 'NE') } ]");
  } catch (e) { unikl = [{ img: 'CHYBA' }]; }
  check('vložený kód se nedostane k prostředí', unikl[0].img, 'NE');

  let hlaska = '';
  try { parse('tady žádné pole není'); } catch (e) { hlaska = String(e.message); }
  ok('bez pole se to řekne srozumitelně', hlaska.includes('GALLERY_DATA'), hlaska);
}

/* ---------- skutečný skript z e-shopu ---------- */

{
  const fixture = path.join(__dirname, 'fixtures/recenze-legacy.txt');
  if (!fs.existsSync(fixture)) {
    console.log('  · ukázka původního skriptu chybí — čtení nad ní se přeskakuje');
  } else {
    const parse = require(path.join(DIST, 'reviews/index.js')).__test.parseLegacy;
    const rows = parse(fs.readFileSync(fixture, 'utf8'));
    ok('ze skutečného skriptu se přečtou všechny recenze', rows.length >= 3, String(rows.length));
    ok('a mají fotku i český popisek',
      rows.every(one => one.img && one.cz && typeof one.cz.captionHtml === 'string'));
    ok('u některých je i recenze s podpisem',
      rows.some(one => one.cz.reviewText && one.cz.reviewName));
  }
}

console.log(failed === 0 ? '\nvše sedí\n' : `\n${failed} nesedí\n`);
process.exit(failed === 0 ? 0 : 1);
