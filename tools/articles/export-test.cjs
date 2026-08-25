/**
 * Export článku zpátky do XML a jeho opětovné načtení.
 *
 * Kontroluje se to, na čem záleží při importu do Upgates: že se článek pozná
 * podle ARTICLE_ID (tedy se aktualizuje, nezaloží znovu), že v něm jsou
 * všechny jazyky s texty i SEO a že se HTML cestou tam a zpět nezměnilo.
 */
const fs = require('fs');
const { db, store } = require('../ptrans/harness.cjs');
const { artStore, artXml, importxml, urlmap } = require('./harness.cjs');

store.syncFromFeed(fs.readFileSync('/home/claude/feed.xml', 'utf8'));
const file = process.argv[2]
  || '/root/.claude/uploads/4a930501-b469-5e69-a9df-84a041e4b180/4fa6b67f-Exportarticles20260823_155700.xml';
importxml.importArticlesXml(fs.readFileSync(file, 'utf8'));

const rows = artStore.listArticles({});
const article = artStore.getArticle(rows[0].id);
const versions = article.versions.filter(v => v.long);

const images = [...new Set(urlmap.extractImages(versions[0].long))]
  .map((url, i) => ({ url, description: versions[0].title, isListing: i === 0 }));

const block = artXml.buildArticle(versions, {
  articleId: article.articleId,
  images,
  createdAt: article.createdAt
});
const xml = artXml.wrapTexts([block]);
fs.writeFileSync(path.join(os.tmpdir(), 'clanek-export.xml'), xml);

console.log('velikost exportu:', Math.round(xml.length / 1024), 'kB · obrázků:', images.length);
console.log('ARTICLE_ID v exportu:', artXml.tag(block, 'ARTICLE_ID'));
console.log('jazyky:', artXml.langsIn(block).join(', '), '(v aplikaci', versions.map(v => v.lang).join(', ') + ')');

// Znovu načíst a porovnat
const before = new Map(versions.map(v => [v.lang, v]));
const blocks = artXml.splitArticles(xml);
let ok = 0, bad = 0;
for (const lang of artXml.langsIn(blocks[0])) {
  const our = artXml.fromExportLang(lang);
  const desc = artXml.langScope(blocks[0], 'DESCRIPTION', lang);
  const seo = artXml.langScope(blocks[0], 'SEO', lang);
  const source = before.get(our);
  const checks = [
    ['title', artXml.tag(desc, 'TITLE'), source.title],
    ['short', artXml.tag(desc, 'SHORT_DESCRIPTION'), source.short],
    ['long', artXml.tag(desc, 'LONG_DESCRIPTION'), source.long],
    ['seo_title', artXml.tag(seo, 'SEO_TITLE'), source.seo_title],
    ['seo_desc', artXml.tag(seo, 'SEO_META_DESCRIPTION'), source.seo_desc],
    ['seo_url', artXml.tag(seo, 'SEO_URL'), source.seo_url]
  ];
  for (const [name, got, want] of checks) {
    if (got === want) ok++;
    else {
      bad++;
      console.log(`  ✗ ${our}/${name}: ${JSON.stringify(String(got).slice(0, 70))}`);
      console.log(`      místo ${JSON.stringify(String(want).slice(0, 70))}`);
    }
  }
  const url = artXml.tag(desc, 'URL');
  if (!url.includes(source.seo_url)) { bad++; console.log(`  ✗ ${our}/URL neodpovídá SEO adrese: ${url}`); }
}
console.log(`\npole tam a zpět: ${ok} shodných, ${bad} rozdílných`);
console.log('soubor: /tmp/clanek-export.xml');

// Kde přesně se dlouhý popis liší
{
  const lang = 'cz';
  const desc = artXml.langScope(artXml.splitArticles(xml)[0], 'DESCRIPTION', 'cs');
  const got = artXml.tag(desc, 'LONG_DESCRIPTION');
  const want = before.get(lang).long;
  console.log('\ndélka got/want:', got.length, want.length);
  for (let i = 0; i < Math.max(got.length, want.length); i++) {
    if (got[i] !== want[i]) {
      console.log('první rozdíl na znaku', i);
      console.log('  got :', JSON.stringify(got.slice(Math.max(0, i - 50), i + 50)));
      console.log('  want:', JSON.stringify(want.slice(Math.max(0, i - 50), i + 50)));
      break;
    }
  }
}
