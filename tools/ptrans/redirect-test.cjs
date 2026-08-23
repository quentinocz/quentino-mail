/** Kontrola 301 přesměrování při změně SEO adresy. */
const path = require('path');
const fs = require('fs');
const { store, xml, DIST } = require('./harness.cjs');
const redirects = require(path.join(DIST, 'ptrans/redirects.js'));
const exportxml = require(path.join(DIST, 'ptrans/exportxml.js'));

store.syncFromFeed(fs.readFileSync('/home/claude/feed.xml', 'utf8'));

const code = 'PS00SM';
const lang = 'en';
const before = store.productFields(code, [lang]);
const url = before.find(f => f.field === 'seo_url');
const red = before.find(f => f.field === 'redirect');
console.log('před změnou:');
console.log('  seo_url  :', url?.value);
console.log('  redirect :', JSON.stringify(red?.value));

const result = redirects.setSeoUrl(code, lang, 'light-blue-mens-braces', 'test');
console.log('\npo změně na „light-blue-mens-braces":');
console.log('  seo_url  :', result.slug);
console.log('  redirect :', JSON.stringify(result.redirect));

// Druhá změna — stará adresa se přidá, nic se neztratí
const second = redirects.setSeoUrl(code, lang, 'light-blue-suspenders-men', 'test');
console.log('\npo druhé změně:');
console.log('  redirect :', JSON.stringify(second.redirect));

// Export: musí to sedět v METAS
const built = exportxml.buildExport({ langs: [lang], codes: [code] });
const meta = /<META\b[^>]*>\s*<META_KEY>redirect_301<\/META_KEY>[\s\S]*?<\/META>/.exec(built.xml);
console.log('\nv exportu:\n' + (meta ? meta[0] : 'CHYBÍ!'));
const seo = /<SEO language="en">[\s\S]*?<\/SEO>/.exec(built.xml);
console.log('\nSEO část:\n' + (seo ? seo[0] : 'chybí'));
