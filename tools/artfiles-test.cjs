/**
 * Zkouška nahrávání příloh článků do správce souborů.
 *
 * Samotné nahrání dělá okno s cizí stránkou a odsud nejde. Zkouší se to,
 * co o výsledku rozhoduje a co by se jinak poznalo až podle prázdného
 * rámečku v hotovém článku:
 *
 *  1. **adresa správce souborů** — skládá se z adresy administrace a číslo
 *     serveru v ní má každý e-shop jiné,
 *  2. **čtení adresy z výpisu** — Upgates soubor při nahrání přejmenují
 *     (`Snímek11.PNG` → `…/g/g6aa…-snimek11.png`), takže se adresa složit
 *     nedá a musí se přečíst z dlaždice; a musí se přečíst ta **nová**,
 *     protože název se opakuje,
 *  3. **strom složek** — z něj se bere nabídka v nastavení.
 *
 * Skripty, které se do stránky posílají, se zkoušejí nad skutečným HTML
 * správce souborů uloženým ve fixtures.
 */
const fs = require('fs');
const path = require('path');

const DIST = process.env.PTDIST || path.join(__dirname, '../dist/ptdist/main');
require.cache[require.resolve('electron')] = {
  id: 'electron', filename: 'electron', loaded: true,
  exports: {
    BrowserWindow: function () { /* okno se v téhle zkoušce neotevírá */ },
    session: { fromPartition: () => ({ webRequest: { onCompleted: () => {} } }) },
    app: { getPath: () => '/tmp' }
  }
};
const settings = new Map();
const dbPath = require.resolve(path.join(DIST, 'db.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {
  getDb: () => { throw new Error('databáze se v téhle zkoušce nepoužívá'); },
  getSetting: (key, fallback = null) => (settings.has(key) ? settings.get(key) : fallback),
  setSetting: (key, value) => settings.set(key, String(value))
} };
const secPath = require.resolve(path.join(DIST, 'secure.js'));
require.cache[secPath] = { id: secPath, filename: secPath, loaded: true, exports: {
  encrypt: v => v, decrypt: v => v
} };

const files = require(path.join(DIST, 'articles/files.js'));
const { __test } = files;

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

console.log('\npřílohy článků:\n');

/* ---------- adresa správce souborů ---------- */

settings.set('invoiceAdminHome', 'https://quentino.admin.s19.upgates.com/manager/');
check('adresa se složí z naučené administrace',
  __test.filesAdminUrl(''),
  'https://quentino.admin.s19.upgates.com/manager/files/default/default/all/?filesPaginator-page=1');
check('a s vybranou složkou míří do ní',
  __test.filesAdminUrl('1019'),
  'https://quentino.admin.s19.upgates.com/manager/files/default/default/1019/?filesPaginator-page=1');

settings.set('articleFilesUrl', 'https://jiny.admin.s3.upgates.com/manager/files/default/default/7/');
check('naučená adresa má přednost',
  __test.filesAdminUrl('1019'),
  'https://jiny.admin.s3.upgates.com/manager/files/default/default/7/');
settings.delete('articleFilesUrl');

/* ---------- čtení stránky ---------- */

/*
 * Skripty se pouštějí nad skutečným HTML správce souborů. Napsat si k tomu
 * vlastní zjednodušené HTML by znamenalo zkoušet vlastní představu místo
 * toho, co Upgates opravdu vykreslí.
 */
const fixture = path.join(__dirname, 'fixtures/upgates-soubory.html');
if (!fs.existsSync(fixture)) {
  console.log('  · fixture se stránkou správce souborů chybí — čtení se přeskakuje');
} else {
  const { JSDOM } = (() => { try { return require('jsdom'); } catch { return {}; } })();
  const html = fs.readFileSync(fixture, 'utf8');

  if (!JSDOM) {
    /*
     * Bez jsdom se skripty pustit nedají. Aspoň se ověří, že se hledá to,
     * co na stránce opravdu je — kdyby Upgates atributy přejmenovaly,
     * pozná se to tady, a ne až u prázdného článku.
     */
    ok('dlaždice nesou původní název', html.includes('data-title="Snímek11.PNG"'));
    ok('a veřejnou adresu', /data-url="https:\/\/[^"]*cdn-upgates\.com\/[^"]*"/.test(html));
    ok('skript čte právě tyhle atributy',
      __test.TILES.includes('data-title') && __test.TILES.includes('data-url')
      && __test.TILES.includes('.manager-file'));
    /*
     * Miniatura je ve složce `_cache` a v článku by byla rozmazaná —
     * skript se na `img src` schválně nedívá.
     */
    ok('a náhledy z _cache si nevšímá', !__test.TILES.includes('img'));
    ok('strom složek se hledá v odkazech', __test.FOLDERS.includes('/manager/files/default/default/'));
    ok('a číslo složky se bere z adresy', __test.FOLDERS.includes('default\\/default\\/([^\\/?]+)'));
  } else {
    const dom = new JSDOM(html);
    const run = script => dom.window.eval(script);

    const tiles = run(__test.TILES);
    ok('dlaždice se najdou', tiles.length > 0, String(tiles.length));
    const snimek = tiles.find(one => one.title === 'Snímek11.PNG');
    ok('název zůstává původní, i s diakritikou', !!snimek, JSON.stringify(tiles.slice(0, 2)));
    /*
     * Přejmenování při nahrání: bez diakritiky, malými písmeny a s náhodným
     * otiskem před názvem. Právě proto se adresa nedá složit.
     */
    ok('adresa je jiná než název souboru',
      snimek && snimek.url.endsWith('-snimek11.png') && !snimek.url.endsWith('/Snímek11.PNG'),
      snimek && snimek.url);
    ok('a není to zmenšenina z _cache', snimek && !snimek.url.includes('/_cache/'), snimek && snimek.url);

    const folders = run(__test.FOLDERS);
    const blog = folders.find(one => one.name === 'Blog');
    ok('ve stromu je složka Blog i s číslem', !!blog && blog.id === '1019', JSON.stringify(blog));
    ok('a počet souborů se do názvu nepřilepí',
      folders.every(one => !/\d$/.test(one.name) || one.name === 'Vše'),
      JSON.stringify(folders.slice(0, 6)));
  }
}

console.log(failed === 0 ? '\nvše sedí\n' : `\n${failed} nesedí\n`);
process.exit(failed === 0 ? 0 : 1);
