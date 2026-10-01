/**
 * Zkouška plánovače příspěvků.
 *
 * Zkouší se to, co rozhoduje o použitelnosti a co se okem nepozná:
 *
 *  1. **termíny** — měsíc se má rozprostřít po vybraných dnech v týdnu,
 *     ne naskládat na prvních pár dní,
 *  2. **co se uloží** — z návrhu musí vzniknout rozdělaný příspěvek
 *     s textem i s nápadem na fotku, jinak je plán jen seznam přání,
 *  3. **co chybí** — u každého příspěvku se musí poznat, jestli má
 *     fotky; den před termínem je pozdě to zjišťovat.
 */
const path = require('path');
const { db, DIST } = require('./ptrans/harness.cjs');

let failed = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${label}`);
  if (!ok) { console.log('      čekáno:', JSON.stringify(want)); console.log('      dostal:', JSON.stringify(got)); }
}
function ok(label, value, note = '') {
  check(label + (value ? '' : note ? ` (${note})` : ''), !!value, true);
}

const secPath = require.resolve(path.join(DIST, 'secure.js'));
require.cache[secPath] = { id: secPath, filename: secPath, loaded: true, exports: {
  encrypt: v => v, decrypt: v => v
} };
const aiPath = require.resolve(path.join(DIST, 'ai.js'));
require.cache[aiPath] = { id: aiPath, filename: aiPath, loaded: true, exports: { ask: async () => '{}' } };

/*
 * Tabulky instagramového modulu si zkouška zakládá sama: harness dává
 * jen prázdnou databázi s nastavením, protože zbytek aplikace schéma
 * spouští až při startu Electronu.
 */
const { igSchema } = require(path.join(DIST, 'instagram/schema.js'));
db.exec(igSchema);

const planner = require(path.join(DIST, 'instagram/planner.js'));
const store = require(path.join(DIST, 'instagram/store.js'));
/*
 * Schvalování, připomínky a publikace sedí v indexu modulu — zkouší se
 * tudy, protože právě tahle vrstva rozhoduje, co se pustí ven.
 */
const ig = require(path.join(DIST, 'instagram/index.js'));
const P = planner.__test;

void db;

console.log('\nplánovač příspěvků:\n');

/* ---------- termíny ---------- */

/*
 * Rozprostření po měsíci. Osm příspěvků na pondělky, středy a pátky
 * nesmí skončit tak, že je celý měsíc hotový do desátého — pak profil
 * první polovinu měsíce mluví a druhou mlčí.
 */
{
  const pondeli = new Date('2026-10-05T09:00:00');
  const dny = P.planDays({ count: 8, days: [1, 3, 5], hour: 18, mixBest: 60, langs: ['CS'], note: '' }, pondeli);
  check('termínů je tolik, kolik se chtělo', dny.length, 8);
  ok('všechny padnou na vybrané dny v týdnu',
    dny.every(one => [1, 3, 5].includes(new Date(one + 'T12:00:00').getDay())), dny.join(' '));
  ok('a rozprostřou se přes celý měsíc',
    (new Date(dny[dny.length - 1]) - new Date(dny[0])) / 86400000 > 18,
    `${dny[0]} → ${dny[dny.length - 1]}`);
  ok('dnešek se nepoužije — příspěvek se dnes stejně nenafotí',
    dny[0] > '2026-10-05', dny[0]);

  /* Víc příspěvků než termínů: den se použije víckrát, nic se nezahodí */
  const husto = P.planDays({ count: 20, days: [2], hour: 18, mixBest: 60, langs: ['CS'], note: '' }, pondeli);
  check('víc příspěvků než termínů se nezahodí', husto.length, 20);

  const zadny = P.planDays({ count: 5, days: [], hour: 18, mixBest: 60, langs: ['CS'], note: '' }, pondeli);
  ok('bez vybraných dnů se sáhne po výchozích', zadny.length === 5);
}

/* ---------- z návrhu rozdělané příspěvky ---------- */

{
  const kolik = planner.acceptPlan([
    {
      day: '2026-10-08', hour: 18, kind: 'bestseller', title: 'Kravata měsíce',
      text: 'Tahle vazba se prodala nejčastěji.', idea: 'Detail uzlu na bílé košili',
      code: 'KR-120', tags: ['#kravaty', '#quentino']
    },
    /* Nesmysl místo data se musí zahodit, ne uložit na rok 1970 */
    { day: 'někdy', hour: 18, kind: 'sezona', title: 'Bez data', text: 'x', idea: '', code: '', tags: [] }
  ]);
  check('uloží se jen příspěvek s pořádným datem', kolik, 1);

  const plan = planner.plannedPosts('2026-10-01', '2026-10-31 23:59');
  check('a je v plánu i s hodinou', plan.map(one => one.at), ['2026-10-08 18:00']);
  check('s druhem, nápadem na fotku i kódem produktu',
    [plan[0].kind, plan[0].idea, plan[0].code],
    ['bestseller', 'Detail uzlu na bílé košili', 'KR-120']);
  /*
   * Bez fotek není co publikovat — a právě tohle se má poznat na první
   * pohled, ne až den před termínem.
   */
  check('a je na něm vidět, že chybí fotky', [plan[0].state, plan[0].media], ['waiting', 0]);

  const post = store.getPost(plan[0].id);
  ok('text z návrhu je v zadání příspěvku',
    post.brief.includes('Tahle vazba') && post.brief.includes('#kravaty'), post.brief.slice(0, 60));
  ok('a nápad na fotku v poznámce k médiím',
    post.mediaNote.includes('Detail uzlu'), post.mediaNote);

  /* Plán se v praxi mění pořád — přesun na jiný den musí jít */
  store.setPlanAt(plan[0].id, '2026-10-09 18:00');
  check('příspěvek jde přesunout na jiný den',
    planner.plannedPosts('2026-10-01', '2026-10-31 23:59')[0].at, '2026-10-09 18:00');
}

/* ---------- návrh po kouscích ---------- */

/*
 * Měsíc příspěvků je dlouhá odpověď a čekat na její poslední znak
 * znamenalo dívat se přes minutu na tlačítko „Přemýšlím". Příspěvky
 * jsou přitom v odpovědi jeden po druhém — jakmile je některý dopsaný,
 * dá se ukázat. Tohle je ta část, která z rozepsaného textu pozná, co
 * už je celé.
 */
console.log('\nnávrh přichází po kouscích:\n');

{
  const H = P.hotoveObjekty;
  const cast = '{"posts":[{"title":"První","text":"a"},{"title":"Druhý"';
  const prvni = H(cast, cast.indexOf('['));
  check('z rozepsaného textu se vezme jen dopsaný příspěvek', prvni.kusy.length, 1);
  check('a je to celý objekt', JSON.parse(prvni.kusy[0]).title, 'První');

  /* Pokračování se čte od místa, kde se skončilo — nic se nezopakuje */
  const cele = cast + ',"text":"b"}]}';
  const druhy = H(cele, prvni.dal);
  check('při pokračování přijde jen ten nový', druhy.kusy.length, 1);
  check('a je to ten druhý', JSON.parse(druhy.kusy[0]).title, 'Druhý');

  /*
   * Závorka uvnitř textu. Bez hlídání řetězců by rozhodila počítání
   * a od té chvíle by se neukázalo nic — a nikdo by nepoznal proč.
   */
  const sZavorkou = '[{"title":"Sleva {akce}","text":"do {30. 9.}"}]';
  const zav = H(sZavorkou, 0);
  check('složená závorka v textu počítání nerozhodí', zav.kusy.length, 1);
  check('a text zůstane celý', JSON.parse(zav.kusy[0]).text, 'do {30. 9.}');

  /* Uvozovka v textu se escapuje — taky se nesmí brát jako konec řetězce */
  const sUvozovkou = '[{"title":"Vzor \\"pepito\\"","text":"x"}]';
  const uv = H(sUvozovkou, 0);
  check('escapovaná uvozovka nepřeruší řetězec', uv.kusy.length, 1);
}

/* ---------- příspěvek na teď ---------- */

/*
 * Návrh na vyžádání nemá termín: dodělá se a pošle, ne zařadí do
 * rozvrhu. Dokud se termín vyžadoval všude, tenhle návrh se tiše
 * zahodil a v seznamu rozdělaných se neobjevilo nic.
 */
{
  const id = planner.acceptOne({
    day: '', hour: 18, kind: 'sezona', title: 'Na teď',
    text: 'Nové vzory hedvábných kravat.', idea: 'Detail vzoru u okna', code: '', tags: ['#kravaty']
  });
  ok('návrh na teď se uloží i bez termínu', id > 0, String(id));
  const post = store.getPost(id);
  check('a opravdu žádný termín nemá', post.planAt, '');
  ok('text i nápad na fotku v něm jsou',
    post.brief.includes('Nové vzory') && post.mediaNote.includes('Detail vzoru'));
}

/* ---------- schválení a co se nestíhá ---------- */

/*
 * Mezi „je to hotové" a „může to ven" je krok, který dělá hlava.
 * A když se nestíhá, musí se to říct dřív, než termín nastane —
 * fotky se nenafotí za hodinu.
 */
console.log('\nschválení a připomínky:\n');

{
  const ted = new Date('2026-10-10T09:00:00');
  const den = 86400000;
  const zaDny = n => new Date(ted.getTime() + n * den).toISOString().slice(0, 10) + ' 18:00';

  const bezFotek = store.createPost({ kind: 'new', brief: 'Bez fotek', mediaNote: '',
    planAt: zaDny(2), planKind: 'sezona', planIdea: 'Detail látky', planCode: '' });
  store.saveCaptions(bezFotek, [{ lang: 'CS', variants: ['Text'] }]);

  /* Dnes večer: do čtyřiadvaceti hodin, tedy čas přečíst a odsouhlasit */
  const sFotkami = store.createPost({ kind: 'new', brief: 'S fotkami', mediaNote: '',
    planAt: zaDny(0), planKind: 'bestseller', planIdea: '', planCode: '' });
  store.setPostMedia(sFotkami, [{ path: '/tmp/a.jpg', mime: 'image/jpeg', isVideo: false }]);
  store.saveCaptions(sFotkami, [{ lang: 'CS', variants: ['Text'] }]);

  const pozde = store.createPost({ kind: 'new', brief: 'Zmeškaný', mediaNote: '',
    planAt: zaDny(-2), planKind: 'sezona', planIdea: '', planCode: '' });
  store.setPostMedia(pozde, [{ path: '/tmp/b.jpg', mime: 'image/jpeg', isVideo: false }]);
  store.saveCaptions(pozde, [{ lang: 'CS', variants: ['Text'] }]);

  const potize = ig.planAlerts(ted);
  const podle = id => potize.find(one => one.postId === id)?.kind ?? '—';
  check('chybějící fotky se ozvou tři dny dopředu', podle(bezFotek), 'media');
  check('chybějící schválení den dopředu', podle(sFotkami), 'approve');
  check('a co mělo vyjít a nevyšlo, je první', potize[0]?.postId, pozde);

  /* Bez fotky nejde odsouhlasit — síť by příspěvek stejně nepřijala */
  let hlaska = '';
  try { ig.approvePost(bezFotek, true); } catch (e) { hlaska = String(e.message); }
  ok('bez fotky nejde příspěvek odsouhlasit', hlaska.includes('Bez fotky'), hlaska);

  ig.approvePost(sFotkami, true);
  ok('s fotkou a textem to jde', store.getPost(sFotkami).approved);
  check('a zmizí z připomínek',
    ig.planAlerts(ted).some(one => one.postId === sFotkami), false);

  /* A publikovat bez média se nesmí dát ani omylem */
  let pub = '';
  try { ig.publishPost(bezFotek); } catch (e) { pub = String(e.message); }
  ok('publikovat bez fotky nejde', pub.includes('bez média') || pub.includes('fotku'), pub);

  /*
   * Schválení musí spadnout, jakmile se obsah změní. Jinak by se dalo
   * odsouhlasit hotové a pak text přepsat — a publikace by poslala ven
   * něco, co nikdo neviděl.
   */
  const popisek = store.getPost(sFotkami).captions[0];
  ig.editCaption(popisek.id, 'Přepsaný text');
  check('přepsání textu zruší schválení', store.getPost(sFotkami).approved, false);
  ig.approvePost(sFotkami, true);
  ig.updateDraft(sFotkami, { brief: 'Jiné zadání' });
  check('a změna zadání taky', store.getPost(sFotkami).approved, false);

  /* Tažením se prohodí jen dva termíny, zbytek plánu zůstane */
  const aPred = store.getPost(bezFotek).planAt;
  const bPred = store.getPost(sFotkami).planAt;
  ig.swapPlan(bezFotek, sFotkami);
  check('tažení prohodí termíny dvou příspěvků',
    [store.getPost(bezFotek).planAt, store.getPost(sFotkami).planAt], [bPred, aPred]);
}

/* ---------- sdílení mezi zařízeními ---------- */

/*
 * Plán vzniká u počítače, kde jsou po ruce prodeje a katalog, ale fotí se
 * a dodělává s telefonem v ruce. Bez sdílení o sobě ta dvě zařízení
 * nevědí. Posílá se záměr a texty, ne média — fotky leží na disku toho
 * počítače, kde vznikly.
 */
console.log('\nsdílení příspěvků mezi zařízeními:\n');

{
  const id = planner.acceptOne({
    day: '2026-11-04', hour: 18, kind: 'sezona', title: 'Svatební sezóna',
    text: 'Ženich a svědci.', idea: 'Detail kapesníčku', code: '', tags: ['#svatba']
  });
  store.saveCaptions(id, [{ lang: 'CS', variants: ['Ženich a svědci.'] }]);

  const balik = store.postsForShare();
  const muj = balik.find(one => one.planTitle === 'Svatební sezóna');
  ok('příspěvek se do sdílení dostane', !!muj);
  ok('a nese klíč, podle kterého se pozná na druhém zařízení',
    !!muj && String(muj.shareId).length > 10);
  ok('texty jedou s ním', !!muj && muj.captions.length === 1);
  /* Média se neposílají: cesta k fotce je na druhém počítači bezcenná */
  ok('média se neposílají', !!muj && !('media' in muj));

  /*
   * Druhé zařízení: tentýž balík se nesmí naimportovat dvakrát a novější
   * razítko musí vyhrát.
   */
  check('podruhé se nic nezmění — razítko je stejné', store.applyPostsShare(balik), 0);

  const zvenku = balik.map(one => (one.shareId === muj.shareId
    ? { ...one, planTitle: 'Svatba jinak', updatedAt: new Date(Date.now() + 60000).toISOString() }
    : one));
  check('novější verze z druhého zařízení vyhraje', store.applyPostsShare(zvenku), 1);
  check('a opravdu se přepsala', store.getPost(id).planTitle, 'Svatba jinak');

  /* Starší verze nesmí přebít to, co je tady novější */
  const stara = balik.map(one => (one.shareId === muj.shareId
    ? { ...one, planTitle: 'Zastaralé', updatedAt: '2020-01-01T00:00:00.000Z' }
    : one));
  store.applyPostsShare(stara);
  check('starší verze se zahodí', store.getPost(id).planTitle, 'Svatba jinak');

  /*
   * Smazání. Řádek zůstane škrtnutý, aby se nevrátil ze zařízení, které
   * o smazání neví — a ze seznamu je pryč hned.
   */
  ig.deletePost(id);
  ok('smazaný příspěvek zmizí ze seznamu',
    !ig.listDrafts().some(one => one.id === id));
  const poSmazani = store.postsForShare().find(one => one.shareId === muj.shareId);
  ok('ale do sdílení jde jako škrtnutý', !!poSmazani && poSmazani.archived === 1);

  /* Příspěvek, který tu nikdy nebyl a přišel rovnou škrtnutý, se nezakládá */
  const kolik = ig.listDrafts().length;
  store.applyPostsShare([{ shareId: 'neznamy-klic', archived: 1, updatedAt: new Date().toISOString() }]);
  check('škrtnutý cizí příspěvek se nezakládá', ig.listDrafts().length, kolik);

  /* A příspěvek z druhého zařízení, který tady ještě není, se založí */
  store.applyPostsShare([{
    shareId: 'z-telefonu', updatedAt: new Date().toISOString(), archived: 0,
    kind: 'new', brief: 'Z telefonu', mediaNote: '', planAt: '2026-11-06 18:00',
    planKind: 'zakulisi', planTitle: 'Z telefonu', planIdea: 'Ruce u šicího stroje',
    planCode: '', origin: 'hand',
    captions: [{ lang: 'CS', variants: '["Z telefonu"]', chosen: 0, edited: null, status: 'draft' }]
  }]);
  const novy = ig.listDrafts().find(one => one.planTitle === 'Z telefonu');
  ok('příspěvek z druhého zařízení se založí i s textem',
    !!novy && novy.captions.some(c => c.text.includes('Z telefonu')));
}

/* ---------- název v přehledu ---------- */

/*
 * V plánu stál místo názvu první řádek zadání — jenže zadání začíná
 * textem příspěvku, takže tam byla první věta useknutá uprostřed slova
 * a u příspěvku bez textu „Bez názvu". Všechny řádky vypadaly stejně
 * a nedalo se v nich nic najít.
 */
{
  const id = planner.acceptOne({
    day: '2026-10-20', hour: 18, kind: 'bestseller', title: 'Hedvábné kravaty — nová série',
    text: 'Za poslední dva měsíce se tahle kravata prodávala nejvíc ze všech kousků v e-shopu.',
    idea: 'Detail vzoru', code: '', tags: []
  });
  check('název z návrhu se uloží', store.getPost(id).planTitle, 'Hedvábné kravaty — nová série');
  const vplanu = planner.plannedPosts('2026-10-01', '2026-10-31 23:59')
    .find(one => one.id === id);
  check('a v přehledu stojí místo první věty textu',
    vplanu.title, 'Hedvábné kravaty — nová série');

  /* Příspěvky z minulé verze název nemají — náhrada se utne na mezeře */
  const stary = store.createPost({ kind: 'new', planAt: '2026-10-21 18:00',
    brief: 'Za poslední dva měsíce se tahle kravata prodávala nejvíc ze všech kousků. Není náhoda.' });
  const nahrada = planner.plannedPosts('2026-10-01', '2026-10-31 23:59')
    .find(one => one.id === stary).title;
  ok('u staršího příspěvku se název utne na mezeře, ne uprostřed slova',
    nahrada.length <= 62 && !/\s…$/.test(nahrada) && nahrada.endsWith('…'), nahrada);
}

/* ---------- nastavení ---------- */

{
  const ulozeno = planner.savePlanSetup({ count: 999, days: [1, 9], hour: 40, mixBest: -5 });
  check('nesmyslné hodnoty se srovnají do mezí',
    [ulozeno.count, ulozeno.hour, ulozeno.mixBest, ulozeno.days], [60, 23, 0, [1]]);
}

/* ---------- média podle trhu ---------- */

/*
 * Video s vypálenými titulky je pro každý trh jiný soubor. Zkouší se to,
 * co by se jinak poznalo až po zveřejnění: že se na německý účet
 * nedostane video s českými titulky a že vykreslení pro jeden trh
 * nesmaže hotové video jiného.
 */
{
  const id = store.createPost({ kind: 'new', brief: 'video s titulky' });
  store.setPostMedia(id, [{ path: '/x/spolecna.jpg', mime: 'image/jpeg', isVideo: false }]);
  store.setPostMedia(id, [{ path: '/x/cs.mp4', mime: 'video/mp4', isVideo: true }], 'CS');
  store.setPostMedia(id, [{ path: '/x/de.mp4', mime: 'video/mp4', isVideo: true }], 'DE');

  check('trh dostane svoje video', store.postMedia(id, 'DE').map(m => m.path), ['/x/de.mp4']);
  check('trh bez vlastního videa dostane společná média',
    store.postMedia(id, 'PL').map(m => m.path), ['/x/spolecna.jpg']);
  check('bez trhu se berou jen společná',
    store.postMedia(id).map(m => m.path), ['/x/spolecna.jpg']);
  check('vykreslení pro jeden trh nesmazalo ostatní',
    store.allPostMedia(id).length, 3);
  check('jazyky s vlastním videem', store.mediaLangs(id).sort(), ['CS', 'DE']);

  /* Přepsání téhož trhu starý soubor nahradí, ne přidá */
  store.setPostMedia(id, [{ path: '/x/de2.mp4', mime: 'video/mp4', isVideo: true }], 'DE');
  check('opakované vykreslení trh přepíše', store.postMedia(id, 'DE').map(m => m.path), ['/x/de2.mp4']);
  check('a ostatních se to netkne', store.allPostMedia(id).length, 3);

  /* Reel v mřížce profilu — výchozí je ano, jinak by se video v profilu nezjevilo */
  ok('reel jde do mřížky, dokud se neřekne jinak', store.postFeed(id) === true);
  store.setPostFeed(id, false);
  ok('a volba se udrží', store.postFeed(id) === false);
}

if (failed) {
  console.log(`\n✗ ${failed} zkoušek selhalo`);
  process.exit(1);
}
console.log('\n✓ plánovač sedí');
