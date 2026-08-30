/**
 * Vymyšlené vlastnosti produktu.
 *
 * Konkrétní stížnost: „Bílá svatební regata s jemnou strukturou" měla
 * v SEO titulku správně strukturu, ale v Google titulku „geometrický vzor".
 * Zákazník tak v inzerátu vidí jiné zboží, než mu přijde.
 *
 * Příčina není fantazie modelu, ale ukázky: do pokynů se dávají skutečné
 * názvy ze stejné kategorie (kvůli slovosledu) a mezi nimi je i produkt
 * s geometrickým vzorem. Když má produkt sám vzor prázdný a pokyn říká
 * „vzor nebo rozlišující detail", model si vypůjčí ten z ukázky.
 *
 * Hlídá se obojí: že se vymyšlená vlastnost pozná — a hlavně že poctivý
 * text neprojde jako chyba, i když je slovenský nebo anglický.
 *
 *   npx tsc -p tsconfig.main.json --outDir dist/ptdist
 *   node tools/ptrans/facts-test.cjs
 */
const path = require('path');
const DIST = process.env.PTDIST || path.join(__dirname, '../../dist/ptdist/main');
const { checkFacts, checkTitleMatch } = require(path.join(DIST, 'ptrans/style.js'));

let bad = 0;
const check = (label, ok, detail = '') => {
  if (!ok) bad++;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `\n        ${detail}`}`);
};
const invented = (text, source) => checkFacts(text, source).map(p => p.message);

/** Skutečný produkt z feedu, na kterém se to projevilo. */
const REGJ01 = [
  'Bílá svatební regata s jemnou strukturou a kapesníčkem',
  'Bílá regata pro ženicha překvapí jemnou strukturou tkaniny a hedvábným leskem.',
  'barva bílá, šířka 8 cm'
].join(' \n');

console.log('\nvymyšlená vlastnost:\n');

check('geometrický vzor, který produkt nemá',
  invented('Pánská svatební regata bílá s geometrickým vzorem Quentino', REGJ01).length === 1,
  JSON.stringify(invented('Pánská svatební regata bílá s geometrickým vzorem Quentino', REGJ01)));

check('a je v hlášce vidět, o co jde',
  /geometrick/i.test(invented('… s geometrickým vzorem …', REGJ01)[0] ?? ''),
  invented('… s geometrickým vzorem …', REGJ01)[0]);

check('vymyšlený materiál taky',
  invented('Bílá regata z hedvábí Quentino', 'Bílá regata pro ženicha, bavlněná tkanina').length === 1);

check('vymyšlené puntíky taky',
  invented('Kravata s puntíky', 'Jednobarevná kravata bez vzoru').length === 1);

console.log('\npoctivý text nesmí propadnout:\n');

check('vlastnost z názvu projde',
  invented('Svatební regata bílá s jemnou strukturou Quentino', REGJ01).length === 0,
  JSON.stringify(invented('Svatební regata bílá s jemnou strukturou Quentino', REGJ01)));

check('lesk z popisu projde',
  invented('Bílá regata s jemným leskem Quentino', REGJ01).length === 0);

// Kontrola běží nad textem bez diakritiky a přes rodiny slov, takže
// slovenský ani anglický překlad nesmí spadnout do falešného poplachu
check('slovenský překlad téhož projde',
  invented('Svadobná regata biela s jemnou štruktúrou Quentino', REGJ01).length === 0,
  JSON.stringify(invented('Svadobná regata biela s jemnou štruktúrou Quentino', REGJ01)));

check('anglický překlad téhož projde',
  invented('White wedding cravat with fine texture by Quentino', REGJ01).length === 0,
  JSON.stringify(invented('White wedding cravat with fine texture by Quentino', REGJ01)));

check('anglický materiál z českého popisu projde',
  invented('Cotton tie by Quentino', 'Kravata z bavlny, ručně šitá').length === 0);

check('text bez vlastností projde',
  invented('Bílá svatební regata Quentino', REGJ01).length === 0);

console.log('\nrozpor s názvem produktu:\n');

/*
 * Tohle byl ten skutečný případ. Model si nic nevymyslel — REGJ01 má
 * v parametrech „vzor: Geometrický vzor", zatímco jmenuje se „…s jemnou
 * strukturou". Obojí je ve feedu pravda, jenže když si každý text vybere
 * jinou stranu, zákazník klikne na jedno a přijde mu druhé. Rozhoduje název.
 */
const NAZEV = 'Bílá svatební regata s jemnou strukturou a kapesníčkem';
const wrong = checkTitleMatch('Svatební regata bílá s geometrickým vzorem Quentino', NAZEV);

check('vzor z parametru místo detailu z názvu se pozná', wrong.length === 1, JSON.stringify(wrong));
check('a v hlášce je vidět obojí',
  /geometrickým/.test(wrong[0]?.message ?? '') && /strukturou/.test(wrong[0]?.message ?? ''),
  wrong[0]?.message);

check('detail z názvu projde',
  checkTitleMatch('Svatební regata bílá s jemnou strukturou Quentino', NAZEV).length === 0);
check('obojí naráz taky projde',
  checkTitleMatch('Regata bílá strukturovaná s geometrickým vzorem Quentino', NAZEV).length === 0);
check('slovenský překlad názvu projde',
  checkTitleMatch('Svadobná regata biela s jemnou štruktúrou Quentino', NAZEV).length === 0);
check('anglický taky', checkTitleMatch('White wedding cravat with fine texture', NAZEV).length === 0);

// Když v názvu žádná rozlišující vlastnost není, je parametr jediné, z čeho
// se dá čerpat — a to je v pořádku
check('u názvu bez vlastnosti se nekontroluje nic',
  checkTitleMatch('Kravata s puntíky Quentino', 'Modrá pánská kravata').length === 0);

console.log(bad ? `\n${bad}× neprošlo` : '\nvymyšlená vlastnost se pozná a text se drží názvu produktu');
process.exit(bad ? 1 : 0);
