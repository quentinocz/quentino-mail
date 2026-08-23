/**
 * Zkouška článkové vrstvy nad skutečným exportem — bez Electronu.
 *
 * Stojí na stejné náhradě databáze jako harness překladů: modul `db.js` se
 * podstrčí přes require.cache, takže se testuje kód aplikace, ne jeho kopie.
 *
 *   npx tsc -p tsconfig.main.json --outDir dist/ptdist
 *   node tools/articles/harness.cjs <export-clanku.xml>
 */
const path = require('path');
const fs = require('fs');
const base = require('../ptrans/harness.cjs');

const { db, DIST } = base;

const artStore = require(path.join(DIST, 'articles/store.js'));
db.exec(artStore.SCHEMA);

const artXml = require(path.join(DIST, 'articles/xml.js'));
const urlmap = require(path.join(DIST, 'articles/urlmap.js'));
const importxml = require(path.join(DIST, 'articles/importxml.js'));

module.exports = { db, DIST, artStore, artXml, urlmap, importxml };

if (require.main === module) {
  const file = process.argv[2]
    || '/root/.claude/uploads/4a930501-b469-5e69-a9df-84a041e4b180/4fa6b67f-Exportarticles20260823_155700.xml';
  const xml = fs.readFileSync(file, 'utf8');

  console.time('import');
  const result = importxml.importArticlesXml(xml);
  console.timeEnd('import');
  console.log('nových:', result.articles, '· aktualizovaných:', result.updated,
    '· jazykových verzí:', result.versions);
  console.log('naučeno z článků:', JSON.stringify(result.learned));

  console.log('\nsouhrn:', JSON.stringify(artStore.articleSummary()));

  const rows = artStore.listArticles({});
  console.log('\nprvních 5 článků:');
  for (const row of rows.slice(0, 5)) {
    const versions = row.versions.map(v => `${v.lang}:${v.words}sl`).join(' ');
    console.log('  •', String(row.articleId).padEnd(4), row.topic.slice(0, 52).padEnd(54), versions);
  }

  console.log('\nmapa adres (kategorie):');
  for (const row of urlmap.listUrlMap({ kind: 'category' }).slice(0, 12)) {
    console.log(`  ${row.fromLang}→${row.toLang}  ${row.fromPath.padEnd(30)} → ${row.toPath.padEnd(30)} ${row.hits}×`);
  }
  console.log('\nmapa adres (produkty):', urlmap.listUrlMap({ kind: 'product' }).length,
    '· články:', urlmap.listUrlMap({ kind: 'article' }).length);
}
