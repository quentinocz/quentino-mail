/**
 * Co je a co není přeložené.
 *
 * Zkouška vznikla z konkrétní stížnosti: filtr „čeká na překlad" ukazoval
 * produkty, které anglické i slovenské texty dávno mají. Na vině byly údaje,
 * které jsou ve všech jazycích stejné **právem** — Google atributy (`male`,
 * `adult`, `new`), čárový kód, „45 cm". Shoda se zdrojem se u nich brala jako
 * „nepřeloženo", takže stačil jeden takový a produkt visel v seznamu napořád.
 * A překlad by to nespravil, protože `male` zůstane `male`.
 *
 * Hlídá se obojí: že se tyhle hodnoty přestaly hlásit **a** že se pořád pozná
 * skutečně nepřeložený text. Druhá polovina je důležitější — kdyby se to
 * přehnalo, seznam by byl prázdný a vypadal by správně.
 *
 *   npx tsc -p tsconfig.main.json --outDir dist/ptdist
 *   node tools/ptrans/detect-test.cjs
 */
const path = require('path');

const DIST = process.env.PTDIST || path.join(__dirname, '../../dist/ptdist/main');
const { fieldState, hashText, clamp, textLength, NEEDS_WORK } = require(path.join(DIST, 'ptrans/detect.js'));

let bad = 0;
const check = (label, ok, detail = '') => {
  if (!ok) bad++;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
};

/** Stav pole tak, jak ho počítá aplikace při čtení feedu. */
const state = (field, value, source, targetLang = 'en') => fieldState({
  value, source, field,
  sourceLang: 'cz',
  targetLang,
  sourceHash: hashText(source)
});

const waits = (field, value, source, lang) => NEEDS_WORK.includes(state(field, value, source, lang));

/* ---------- co se hlásit nemá ---------- */

console.log('stejné ve všech jazycích právem:\n');

// Přesně to, co Patrik popsal
check('google_gender „male" nečeká na překlad', !waits('google_gender', 'male', 'male'));
check('google_age „adult" nečeká na překlad', !waits('google_age', 'adult', 'adult'));
check('google_condition „new" nečeká na překlad', !waits('google_condition', 'new', 'new'));
check('čárový kód nečeká na překlad',
  !waits('google_identifier', '8594045678901', '8594045678901'));
check('barva z převodníku nečeká na překlad',
  !waits('google_color', 'Bordó', 'Bordó', 'sk'));
check('adresa (slug) nečeká na překlad',
  !waits('seo_url', 'bordo-kravata', 'bordo-kravata'));

// Prázdno je u odvozených polí často správná hodnota — a překlad ho stejně
// nevyplní, protože není co překládat
check('poukázka bez barvy nečeká na překlad', !waits('google_color', '', ''));
check('produkt bez čárového kódu nečeká na překlad', !waits('google_identifier', '', ''));
check('produkt bez přesměrování nečeká na překlad', !waits('redirect', '', ''));
check('shodný slovenský slug nečeká na překlad',
  !waits('seo_url', 'bordo-kravata', 'bordo-kravata', 'sk'));

// Parametry produktu: údaj, který se prostě nepřekládá
check('rozměr „45 cm" nečeká na překlad', !waits('param:0:value', '45 cm', '45 cm'));
check('podíl „100 %" nečeká na překlad', !waits('param:1:value', '100 %', '100 %'));
check('velikost „XL" nečeká na překlad', !waits('param:2:value', 'XL', 'XL'));
check('rozsah „38-40" nečeká na překlad', !waits('param:3:value', '38-40', '38-40'));

/* ---------- co se hlásit má ---------- */

console.log('\nskutečně nepřeložené:\n');

check('český název v angličtině čeká na překlad',
  waits('title', 'Bordó pánská kravata', 'Bordó pánská kravata'));
check('prázdné pole čeká na překlad', waits('short', '', 'Kravata z hedvábí'));
check('český popis v angličtině se pozná i po ruční úpravě',
  waits('long', 'Tato kravata je vyrobena z kvalitního hedvábí pro každou příležitost.',
    'Kravata je vyrobena z kvalitního hedvábí pro každou příležitost.'));
check('název parametru se překládat má',
  waits('param:0:name', 'Materiál', 'Materiál'));
check('hodnota parametru se slovem se překládat má',
  waits('param:0:value', 'Hedvábí', 'Hedvábí'));

/* ---------- a že se to nepřehnalo ---------- */

console.log('\nhotové překlady zůstávají hotové:\n');

check('anglický název je v pořádku',
  !waits('title', 'Burgundy men\'s necktie', 'Bordó pánská kravata'));
check('slovenský popis je v pořádku',
  !waits('long', 'Kravata je vyrobená z kvalitného hodvábu pre každú príležitosť.',
    'Kravata je vyrobena z kvalitního hedvábí pro každou příležitost.', 'sk'));

// U hodnoty, která je stejná právem, se změna zdroje pozná dál — tam je to
// jediná skutečná práce, která zbývá
const stale = fieldState({
  value: '100 %', source: '90 %', field: 'param:0:value',
  sourceLang: 'cz', targetLang: 'en',
  translatedHash: hashText('100 %'), sourceHash: hashText('90 %')
});
check('u neutrální hodnoty se pozná změněný zdroj', stale === 'stale', `stav: ${stale}`);

// Odvozené pole se ale nehlásí ani po změně zdroje — přepočítá ho běh pravidel,
// překlad s ním nemá co dělat
const derived = fieldState({
  value: 'male', source: 'female', field: 'google_gender',
  sourceLang: 'cz', targetLang: 'en',
  translatedHash: hashText('male'), sourceHash: hashText('female')
});
check('odvozené pole nečeká na překlad ani po změně zdroje',
  derived === 'ok', `stav: ${derived}`);

// Ruční úprava má přednost i u odvozeného pole — jinak by ji přepsal
// nejbližší běh pravidel
const handmade = fieldState({
  value: 'moje-adresa', source: 'moje-adresa', field: 'seo_url',
  sourceLang: 'cz', targetLang: 'en', manual: true
});
check('ručně upravená adresa zůstane ruční', handmade === 'manual', `stav: ${handmade}`);

/* ---------- emodži ---------- */

console.log('\nemodži:\n');

// Zkrácení podle `String.length` umí useknout emodži v půlce — z 🎁 zbude
// půlka dvojice a prohlížeč místo ní ukáže „�"
// Osamocená půlka dvojice — emodži samotné je dvojice v pořádku, vadí až
// půlka bez druhé
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const cut = clamp('Da nekonecnedlouhynazevproduktubezmezer🎁 a jeste neco', 40);
check('zkrácení nerozseká emodži na půlky',
  !LONE.test(cut) && cut.endsWith('🎁'), JSON.stringify(cut));

// U složených emodži je to zákeřnější: nespadne nic, jen z celé rodiny
// zbude jedna postava
const family = clamp('AAAAAAAAAAAAAAAAAAAAAAAAA👩‍👩‍👧‍👦 konec', 26);
check('složené emodži zůstane celé', family.endsWith('👩‍👩‍👧‍👦'), JSON.stringify(family));

check('emodži se počítá jako jeden znak', textLength('Kravata 🎁') === 9,
  `napočítáno ${textLength('Kravata 🎁')}`);
check('emodži projde textem beze změny',
  clamp('Kravata 🎁 z hedvábí ✨', 100) === 'Kravata 🎁 z hedvábí ✨');

console.log(bad
  ? `\n${bad} věcí nesedí`
  : '\nfiltr „čeká na překlad" ukazuje jen to, co se opravdu překládá');
process.exit(bad ? 1 : 0);
