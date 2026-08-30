/**
 * Doplněný český text musí přežít další načtení feedu.
 *
 * Past, do které se dá spadnout jednou a nedostat se z ní ven: aplikace
 * doplní chybějící český SEO titulek, uloží si ho a rozešle jako zdroj
 * k cílovým jazykům. V e-shopu ale pořád není — bude tam až po importu
 * exportu. Při dalším načtení feedu se `source_value` přepsalo prázdnem
 * z feedu, zatímco uložený český text zůstal. Pole tím uvízlo mezi dvěma
 * stavy: **přeložit nejde** (chybí zdroj) a **doplnit se nemá** (už to prý
 * je). Přesně tohle se stalo u REGJ01 a REGJ02.
 *
 * Zkouší se, že feed má přednost, když v něm hodnota je, že naše hodnota
 * nastoupí, když je feed prázdný, a že se stará databáze v tomhle stavu
 * jednorázově spraví.
 *
 *   npx tsc -p tsconfig.main.json --outDir dist/ptdist
 *   node tools/ptrans/source-test.cjs
 */
const path = require('path');
const { db, store, DIST } = require('./harness.cjs');
const source = require(path.join(DIST, 'ptrans/source.js'));

let bad = 0;
const check = (label, got, want) => {
  const ok = got === want;
  if (!ok) bad++;
  console.log(`  ${ok ? '✓' : '✗'} ${label}`);
  if (!ok) {
    console.log('      čekáno:', JSON.stringify(want));
    console.log('      dostal:', JSON.stringify(got));
  }
};

/** Malý feed ve tvaru, jaký vydává Upgates. */
const feed = (seoTitleCz) => `<?xml version="1.0" encoding="UTF-8"?>
<PRODUCTS version="2.0">
  <PRODUCT>
    <CODE>REGJ01</CODE>
    <ACTIVE_YN>1</ACTIVE_YN>
    <DESCRIPTIONS>
      <DESCRIPTION language="cz">
        <TITLE>Bílá svatební regata</TITLE>
        <URL>https://www.quentino.cz/p/bila-svatebni-regata</URL>
        <SHORT_DESCRIPTION><![CDATA[Bílá regata pro ženicha, ručně šitá v Česku.]]></SHORT_DESCRIPTION>
        <LONG_DESCRIPTION><![CDATA[<p>Bílá svatební regata s jemnou strukturou.</p>]]></LONG_DESCRIPTION>
      </DESCRIPTION>
      <DESCRIPTION language="sk">
        <TITLE></TITLE>
        <SHORT_DESCRIPTION></SHORT_DESCRIPTION>
        <LONG_DESCRIPTION></LONG_DESCRIPTION>
      </DESCRIPTION>
    </DESCRIPTIONS>
    <SEO_OPTIMALIZATION>
      <SEO language="cz">
        <SEO_URL>bila-svatebni-regata</SEO_URL>
        <SEO_TITLE>${seoTitleCz}</SEO_TITLE>
        <SEO_META_DESCRIPTION></SEO_META_DESCRIPTION>
      </SEO>
      <SEO language="sk">
        <SEO_URL>bila-svadobna-regata</SEO_URL>
        <SEO_TITLE></SEO_TITLE>
        <SEO_META_DESCRIPTION></SEO_META_DESCRIPTION>
      </SEO>
    </SEO_OPTIMALIZATION>
  </PRODUCT>
</PRODUCTS>`;

const CODE = 'REGJ01';
const skSource = () => (db.prepare(
  "SELECT source_value FROM ptrans_fields WHERE code = ? AND lang = 'sk' AND field = 'seo_title'"
).get(CODE)?.source_value ?? '');
const missing = () => source.missingByField([CODE]).find(f => f.field === 'seo_title').missing;

store.savePtransSettings({
  languages: [{ code: 'sk', label: 'Slovenština', enabled: true }],
  // Google texty bývají ve výchozím nastavení vypnuté; tahle zkouška je
  // potřebuje zapnuté, protože právě u nich se past projevila
  fields: { ...store.getPtransSettings().fields, google_title: true, google_desc: true }
});
store.syncFromFeed(feed(''));

console.log('\ndoplněný český text a další feed:\n');

check('napoprvé je SEO titulek prázdný', skSource(), '');
check('a hlásí se jako chybějící', missing(), 1);

// Přesně to, co udělá doplnění zdrojových textů
const NAPSANY = 'Bílá svatební regata pro ženicha | Quentino';
store.saveTranslation(CODE, 'cz', 'seo_title', NAPSANY, 'model');
store.propagateSource(CODE, 'seo_title', NAPSANY);
check('po doplnění je z čeho překládat', skSource(), NAPSANY);
check('a nehlásí se jako chybějící', missing(), 0);

// Feed se načte znovu — v e-shopu ten titulek pořád není
store.syncFromFeed(feed(''));
check('další feed nesmí náš text zahodit', skSource(), NAPSANY);
check('a pole nesmí uvíznout jako „kompletní bez zdroje"', missing(), 0);

console.log('\noprava databáze, která v té pasti už je:\n');

// Stav, ve kterém databáze uvízla dřív: uložený český text, ale u cílových
// jazyků prázdný zdroj. Nové načtení feedu už to nezpůsobí, jenže databáze,
// které v tom stavu jsou, by se nespravily do dalšího stažení.
db.prepare("UPDATE ptrans_fields SET source_value = '' WHERE code = ? AND field = 'seo_title' AND lang != 'cz'")
  .run(CODE);
check('nastavený stav: zdroj chybí', skSource(), '');
store.repairSourceValues();
check('oprava zdroj vrátí', skSource(), NAPSANY);

// Až se export naimportuje, platí e-shop
store.syncFromFeed(feed('Titulek napsaný ručně v e-shopu'));
check('co je ve feedu, má přednost', skSource(), 'Titulek napsaný ručně v e-shopu');

console.log('\nkdyž o českém textu cílové jazyky nevědí:\n');

/*
 * Přesně stav z hlášení: dialog u pole hlásí „kompletní", karta u téhož pole
 * ukazuje „prázdné" a „chybí" — a další běh s tím nehne. Uložený český text
 * existuje, ale `source_value` u cílových jazyků je prázdné, takže překlad
 * nemá z čeho vycházet. Vzniká to pokaždé, když text napsala aplikace (a
 * v e-shopu ještě není) nebo když se pole zapnulo v nastavení až po
 * posledním načtení feedu.
 */
store.saveTranslation(CODE, 'cz', 'google_title', 'Bílá regata Quentino', 'model');
db.prepare("UPDATE ptrans_fields SET source_value = '' WHERE code = ? AND field = 'google_title' AND lang != 'cz'")
  .run(CODE);

const gap = source.missingByField([CODE]).find(f => f.field === 'google_title');
check('doplnění to bere jako hotové', gap.missing, 0);
check('a překlad přitom nemá z čeho', db.prepare(
  "SELECT count(*) AS n FROM ptrans_fields WHERE code = ? AND field = 'google_title' AND lang != 'cz' AND trim(source_value) != ''"
).get(CODE).n, 0);

check('srovnání zdrojů pole spraví', store.alignSources([CODE]) > 0, true);
check('a překlad má z čeho vycházet',
  db.prepare("SELECT source_value FROM ptrans_fields WHERE code = ? AND lang = 'sk' AND field = 'google_title'")
    .get(CODE)?.source_value, 'Bílá regata Quentino');
check('druhé srovnání už nemá co dělat', store.alignSources([CODE]), 0);

/*
 * A co srovnání dělat nesmí: sahat na zdroj, který **je** vyplněný, jen se
 * liší od feedu. Přesně tak to totiž vypadá po úklidu HTML — u pole zůstane
 * uklizený originál, ve feedu je pořád ten s balastem. Přepsat ho zpátky by
 * znamenalo, že se všechny hotové překlady označí jako zastaralé.
 */
db.prepare("UPDATE ptrans_fields SET source_value = 'jiný text, ale vyplněný' WHERE code = ? AND lang = 'sk' AND field = 'google_title'")
  .run(CODE);
store.alignSources([CODE]);
check('vyplněný zdroj se nepřepisuje', db.prepare(
  "SELECT source_value FROM ptrans_fields WHERE code = ? AND lang = 'sk' AND field = 'google_title'"
).get(CODE).source_value, 'jiný text, ale vyplněný');

console.log(bad ? `\n${bad}× neprošlo` : '\ndoplněný český text přežije feed i restart a dojde k překladu');
process.exit(bad ? 1 : 0);
