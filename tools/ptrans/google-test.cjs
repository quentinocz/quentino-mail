/**
 * Barvy, sety a audit nad skutečným feedem — bez Electronu a bez volání modelu.
 *
 *   npx tsc -p tsconfig.main.json --outDir dist/ptdist
 *   node tools/ptrans/google-test.cjs [feed.xml]
 */
const fs = require('fs');
const path = require('path');
const base = require('./harness.cjs');
const { db, store, DIST } = base;

const colors = require(path.join(DIST, 'ptrans/colors.js'));
const bundle = require(path.join(DIST, 'ptrans/bundle.js'));
const google = require(path.join(DIST, 'ptrans/google.js'));
const audit = require(path.join(DIST, 'ptrans/audit.js'));

const file = process.argv[2] || '/home/claude/feed.xml';
console.time('feed');
const sync = store.syncFromFeed(fs.readFileSync(file, 'utf8'));
console.timeEnd('feed');
console.log('produktů:', sync.products, '· polí:', sync.fields);

/* ---------- barvy ---------- */

console.log('\n=== BARVY ===');
console.time('učení');
const learned = colors.learnColors();
console.timeEnd('učení');
console.log('produktů s parametrem Barva:', learned.products, '· naučeno převodů:', learned.learned);

const coverage = colors.colorCoverage();
console.log(`odstínů celkem: ${coverage.shades} · zařazeno: ${coverage.mapped}`
  + ` · nezařazeno: ${coverage.missing.length}`);
if (coverage.missing.length) {
  console.log('nezařazené odstíny:', coverage.missing.slice(0, 20).join(', '));
}

console.log('\nukázka převodů:');
for (const rule of colors.listColorRules().slice(0, 14)) {
  console.log(`  ${rule.source.padEnd(30)} → ${rule.base.padEnd(12)} ${rule.hits}× (${rule.origin})`);
}

console.log('\nzkouška odvození bez záznamu v převodníku:');
for (const shade of ['světle modrá', 'tmavě modrá', 'smaragdová', 'starorůžová',
  'pastelově zelená', 'antracitová', 'úplně vymyšlená']) {
  const key = colors.baseColorOf(shade);
  console.log(`  ${shade.padEnd(22)} → ${key ? colors.baseLabel(key, 'en') : '—'}`);
}

/* ---------- sety ---------- */

console.log('\n=== SETY ===');
const preview = bundle.bundlePreview();
console.log(`z ${preview.total} aktivních produktů vychází ${preview.bundles} jako set`);
for (const item of preview.samples.slice(0, 10)) {
  console.log(`  • ${item.title.slice(0, 52).padEnd(54)} ${item.reason}`);
}

// Učení: uživatel jeden ze setů odmítne
const sample = preview.samples[0];
if (sample) {
  console.log(`\nuživatel u „${sample.title.slice(0, 46)}" řekne, že to set NENÍ:`);
  const rule = bundle.teachBundle(sample.code, false);
  console.log('  naučené pravidlo:', JSON.stringify(rule));
  console.log('  ten samý produkt teď:', JSON.stringify(bundle.detectBundle(sample.code)));

  // Jiný produkt se stejným tvarem názvu se musí přeřadit taky
  const same = preview.samples.find(item =>
    item.code !== sample.code
    && bundle.bundlePattern(item.title) === bundle.bundlePattern(sample.title));
  if (same) {
    console.log(`  jiný produkt stejného tvaru („${same.title.slice(0, 42)}"):`,
      JSON.stringify(bundle.detectBundle(same.code)));
  }
  const after = bundle.bundlePreview();
  console.log(`  setů po naučení: ${after.bundles} (bylo ${preview.bundles})`);
}

/* ---------- číselníky ---------- */

console.log('\n=== ČÍSELNÍKY ===');
const page = store.listProducts({ state: 'all', limit: 6 });
for (const row of page.rows) {
  const attrs = google.attributesFor(row.code, 'en');
  console.log(`  ${row.code.padEnd(12)} ${row.title.slice(0, 40).padEnd(42)}`
    + ` barva=${(attrs.google_color || '—').padEnd(10)} pohlaví=${attrs.google_gender.padEnd(7)}`
    + ` věk=${attrs.google_age.padEnd(6)} set=${attrs.google_bundle}`);
}

/* ---------- audit ---------- */

console.log('\n=== AUDIT ===');
const codes = store.listProducts({ state: 'all', limit: 200 }).rows.map(row => row.code);
console.time('audit');
const summary = audit.runAudit({ codes, langs: ['cz', 'sk', 'en'] });
console.timeEnd('audit');
console.log(`zkontrolováno ${summary.checked} kombinací · průměrné skóre ${summary.averageScore}`);
for (const row of summary.byLang) {
  console.log(`  ${row.lang}: ${row.average} bodů · ${row.errors} chyb · ${row.warnings} varování`);
}
console.log('\nnejčastější vady:');
for (const row of summary.top.slice(0, 12)) {
  console.log(`  ${String(row.count).padStart(4)}× [${row.severity}] ${row.message.slice(0, 82)}`);
}

const worst = audit.worstProducts('cz', 5);
console.log('\nnejhorší produkty (cz):');
for (const row of worst) {
  console.log(`  ${String(row.score).padStart(3)} b · ${row.errors} chyb · ${row.title.slice(0, 52)}`);
}

const detail = audit.auditProduct(worst[0]?.code ?? codes[0], 'cz');
if (detail) {
  console.log(`\nrozpis pro „${detail.title.slice(0, 48)}" (${detail.score} bodů):`);
  for (const issue of detail.issues) {
    console.log(`  [${issue.severity}]${issue.fixable ? ' (opravitelné)' : ''} ${issue.message}`);
  }
}
