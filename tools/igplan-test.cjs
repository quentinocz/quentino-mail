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

/* ---------- nastavení ---------- */

{
  const ulozeno = planner.savePlanSetup({ count: 999, days: [1, 9], hour: 40, mixBest: -5 });
  check('nesmyslné hodnoty se srovnají do mezí',
    [ulozeno.count, ulozeno.hour, ulozeno.mixBest, ulozeno.days], [60, 23, 0, [1]]);
}

if (failed) {
  console.log(`\n✗ ${failed} zkoušek selhalo`);
  process.exit(1);
}
console.log('\n✓ plánovač sedí');
