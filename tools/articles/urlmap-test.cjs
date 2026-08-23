/**
 * Mapa adres nad skutečnými daty: nejdřív se načte produktový feed (aby šly
 * adresy produktů ověřit), pak export článků, a pak se zkouší převod odkazů
 * z české verze na ostatní trhy.
 *
 *   node tools/articles/urlmap-test.cjs <feed.xml> <export-clanku.xml>
 */
const fs = require('fs');
const { db, store } = require('../ptrans/harness.cjs');
const { artStore, urlmap, importxml } = require('./harness.cjs');

const feedFile = process.argv[2] || '/home/claude/feed.xml';
const artFile = process.argv[3]
  || '/root/.claude/uploads/4a930501-b469-5e69-a9df-84a041e4b180/4fa6b67f-Exportarticles20260823_155700.xml';

console.time('feed');
const feed = store.syncFromFeed(fs.readFileSync(feedFile, 'utf8'));
console.timeEnd('feed');
console.log('produktů:', feed.products);

console.time('články');
const result = importxml.importArticlesXml(fs.readFileSync(artFile, 'utf8'));
console.timeEnd('články');
console.log('článků:', result.articles, '· verzí:', result.versions, '· mapa:', JSON.stringify(result.learned));

console.log('\nkategorie v mapě:');
for (const row of urlmap.listUrlMap({ kind: 'category' }).slice(0, 14)) {
  console.log(`  ${row.fromLang}→${row.toLang}  ${row.fromPath.padEnd(34)} → ${row.toPath.padEnd(34)} ${row.hits}×`);
}

// Převod odkazů z české verze prvního článku
const rows = artStore.listArticles({});
const article = artStore.getArticle(rows[0].id);
const cz = article.versions.find(v => v.lang === 'cz');
console.log(`\npřevod odkazů z článku „${article.topic.slice(0, 48)}"`);
for (const target of ['sk', 'en']) {
  const out = urlmap.rewriteLinks(cz.long, 'cz', target);
  const before = urlmap.extractLinks(cz.long);
  const after = urlmap.extractLinks(out.html);
  const shown = before.map((url, i) => [url, after[i]]).filter(([a, b]) => a !== b);
  console.log(`\n  → ${target.toUpperCase()}: ${shown.length}/${before.length} přepsáno,`,
    `${out.unresolved.length} bez dohledané adresy`);
  for (const [from, to] of shown.slice(0, 6)) {
    console.log('     ', from.replace('https://www.', ''));
    console.log('      →', to.replace('https://www.', ''));
  }
  for (const item of out.unresolved.slice(0, 5)) {
    console.log('      ! nedohledáno:', item.kind, item.url.replace('https://www.', ''));
  }
}

// Kontrola, že skutečná adresa v cílovém jazyce sedí s tou, co článek už má
const skReal = article.versions.find(v => v.lang === 'sk');
if (skReal) {
  const rewritten = urlmap.extractLinks(urlmap.rewriteLinks(cz.long, 'cz', 'sk').html);
  const real = urlmap.extractLinks(skReal.long);
  let same = 0;
  const limit = Math.min(rewritten.length, real.length);
  for (let i = 0; i < limit; i++) if (rewritten[i] === real[i]) same++;
  console.log(`\nshoda s ručně přeloženou SK verzí: ${same}/${limit} odkazů`);
  for (let i = 0; i < limit; i++) {
    if (rewritten[i] !== real[i]) {
      console.log('  ✗ spočteno:', rewritten[i].replace('https://www.', ''));
      console.log('    ve feedu:', real[i].replace('https://www.', ''));
    }
  }
}
