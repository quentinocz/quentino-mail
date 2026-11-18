/**
 * Export překladů do XML — co se do souboru opravdu dostane.
 *
 * ## Proč tahle zkouška je
 *
 * Hlášení: „dal jsem jen dopsat Google parametry a do exportu se
 * nepropsaly, pokud neproběhl překlad." Bylo to tak, a horší: export
 * ohlásil „zapsáno 12 polí" nad souborem, ve kterém nebylo ani jedno.
 * Úsporný režim se totiž neřídil tím, co se zapsalo, ale napevno
 * vypsaným seznamem klíčů, na kterém atributy pro Google chyběly.
 *
 * Export do té doby žádnou zkoušku v řetězu neměl — ty, co existovaly,
 * chtěly skutečný feed na disku. Tahle si staví malý feed ve tvaru,
 * jaký vydává Upgates, a měří se na **hotovém souboru**: hodnota se
 * z něj přečte zpátky stejnou funkcí, jakou aplikace čte feed.
 *
 * Feed se zkouší ve dvou tvarech — záznam metadat s atributy i bez
 * nich. Na tom druhém úsporný režim dřív zahazoval metadata všechna.
 *
 *   node tools/ptrans/export-test.cjs
 */
const path = require('path');
const { db, store, xml, DIST } = require('./harness.cjs');
const exportxml = require(path.join(DIST, 'ptrans/exportxml.js'));
const google = require(path.join(DIST, 'ptrans/google.js'));

let bad = 0;
const ok = (label, value, note = '') => {
  if (!value) bad++;
  console.log(`  ${value ? '✓' : '✗'} ${label}${note ? `   ${note}` : ''}`);
};

const KLICE = {
  google_title: 'title_google_merchant', google_desc: 'description_google_merchant',
  google_color: 'color_google_merchant', google_gender: 'gender_google_merchant',
  google_age: 'age_group_google_merchant', google_condition: 'condition_google_merchant',
  google_bundle: 'is_bundle_google_merchant', google_identifier: 'identifier_exists_google_merchant',
  redirect: 'redirect_301'
};
const ATRIBUTY = ['google_color', 'google_gender', 'google_age', 'google_condition', 'google_bundle', 'google_identifier'];

/** Malý feed ve tvaru Upgates. `atribut` = záznam metadat s atributem, nebo holý. */
function feed({ atribut = '', klice = Object.values(KLICE) } = {}) {
  const meta = key => `\n\t\t\t<META${atribut}>\n\t\t\t\t<META_KEY>${key}</META_KEY>\n\t\t\t\t<META_VALUES>`
    + '\n\t\t\t\t\t<META_VALUE language="cz"/>\n\t\t\t\t\t<META_VALUE language="sk"/>\n\t\t\t\t</META_VALUES>\n\t\t\t</META>';
  const produkt = (code, nazev, ean, sMetami) => `
\t<PRODUCT>
\t\t<CODE>${code}</CODE>
\t\t<ACTIVE_YN>1</ACTIVE_YN>${ean ? `\n\t\t<EAN>${ean}</EAN>` : ''}
\t\t<DESCRIPTIONS>
\t\t\t<DESCRIPTION language="cz">
\t\t\t\t<TITLE>${nazev}</TITLE>
\t\t\t\t<URL>https://www.quentino.cz/p/${code.toLowerCase()}</URL>
\t\t\t\t<SHORT_DESCRIPTION><![CDATA[Krátký popis.]]></SHORT_DESCRIPTION>
\t\t\t\t<LONG_DESCRIPTION><![CDATA[<p>Dlouhý popis z hedvábí.</p>]]></LONG_DESCRIPTION>
\t\t\t</DESCRIPTION>
\t\t\t<DESCRIPTION language="sk">
\t\t\t\t<TITLE>${nazev}</TITLE>
\t\t\t\t<SHORT_DESCRIPTION><![CDATA[Krátký popis.]]></SHORT_DESCRIPTION>
\t\t\t\t<LONG_DESCRIPTION><![CDATA[<p>Dlouhý popis z hedvábí.</p>]]></LONG_DESCRIPTION>
\t\t\t</DESCRIPTION>
\t\t</DESCRIPTIONS>
\t\t<SEO_OPTIMALIZATION>
\t\t\t<SEO language="cz"><SEO_URL>${code.toLowerCase()}</SEO_URL><SEO_TITLE>Titulek</SEO_TITLE><SEO_META_DESCRIPTION>Popis</SEO_META_DESCRIPTION></SEO>
\t\t\t<SEO language="sk"><SEO_URL>${code.toLowerCase()}-sk</SEO_URL><SEO_TITLE>Titulek</SEO_TITLE><SEO_META_DESCRIPTION>Popis</SEO_META_DESCRIPTION></SEO>
\t\t</SEO_OPTIMALIZATION>
\t\t<CATEGORIES><CATEGORY><CODE>1</CODE><NAME>Kravaty</NAME></CATEGORY></CATEGORIES>
\t\t<PRICES><PRICE language="cz"><PRICE_WITH_VAT>599</PRICE_WITH_VAT></PRICE></PRICES>
\t\t<PARAMETERS>
\t\t\t<PARAMETER><NAME language="cz">Barva</NAME><NAME language="sk">Farba</NAME><VALUE language="cz">modrá</VALUE><VALUE language="sk">modrá</VALUE></PARAMETER>
\t\t</PARAMETERS>${sMetami ? `\n\t\t<METAS>${klice.map(meta).join('')}\n\t\t</METAS>` : ''}
\t\t<STOCK>5</STOCK>
\t</PRODUCT>`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<PRODUCTS version="2.0">`
    + produkt('KR01', 'Modrá pánská kravata', '8590000000017', true)
    + produkt('KR02', 'Zelená pánská kravata', '', true)
    /* Produkt, kterému ve feedu metadata chybí úplně — novinka, které je nikdo nevyplnil */
    + produkt('KR03', 'Šedá pánská kravata', '', false)
    + '\n</PRODUCTS>';
}

function cisto(nastaveni) {
  db.exec('DELETE FROM ptrans_fields; DELETE FROM ptrans_products;');
  store.savePtransSettings({
    languages: [{ code: 'sk', label: 'Slovenština', enabled: true }],
    fields: { ...store.getPtransSettings().fields, google_title: true, google_desc: true }
  });
  store.syncFromFeed(feed(nastaveni));
}

/** Blok jednoho produktu v hotovém souboru. */
const blok = (soubor, code) =>
  xml.splitProducts(soubor).find(one => one.code === code)?.block ?? '';

for (const [tvar, atribut] of [['záznam metadat bez atributů (<META>)', ''], ['záznam metadat s atributem', ' type="text"']]) {
  console.log(`\nexport — ${tvar}:\n`);

  /* ---------- 1. jen atributy pro Google, žádný překlad ---------- */
  cisto({ atribut });
  const doplneno = google.applyAttributes(['KR01']);
  const jenGoogle = exportxml.buildExport({ codes: ['KR01'] });
  const b1 = blok(jenGoogle.xml, 'KR01');
  const vSouboru = ATRIBUTY.filter(pole => ['cz', 'sk'].every(lang => !!xml.getField(b1, lang, pole)));
  ok('doplněné atributy pro Google jsou v exportu i bez překladu',
    vSouboru.length === ATRIBUTY.length,
    `${vSouboru.length} z ${ATRIBUTY.length} · barva „${xml.getField(b1, 'sk', 'google_color')}", pohlaví „${xml.getField(b1, 'sk', 'google_gender')}"`);
  ok('  a hlášený počet sedí s tím, co v souboru je',
    jenGoogle.fields === doplneno.written && jenGoogle.missed.length === 0,
    `hlášeno ${jenGoogle.fields}, doplněno ${doplneno.written}, nezapsáno ${jenGoogle.missed.length}`);
  /*
   * A obráceně: co se nepsalo, v souboru není. Dřív tam zůstávaly celé
   * jazykové části včetně češtiny a parametrů — stav z posledního
   * stažení feedu, kterým by import přepsal, co se mezitím v e-shopu
   * změnilo.
   */
  ok('  v souboru není nic, na co se nesáhlo — název, SEO, parametry, cena ani sklad',
    !/<DESCRIPTION |<SEO |<PARAMETER>|<PRICE|<STOCK>/.test(b1) && /<CODE>KR01<\/CODE>/.test(b1),
    `${b1.length} znaků`);
  ok('  ani prázdné záznamy metadat, do kterých se nepsalo',
    !b1.includes('title_google_merchant') && !b1.includes('redirect_301'));

  /* ---------- 2. jen přeložený název ---------- */
  cisto({ atribut });
  store.saveTranslation('KR01', 'sk', 'title', 'Modrá pánska kravata', 'zkouška');
  const jenNazev = exportxml.buildExport({ codes: ['KR01'] });
  const b2 = blok(jenNazev.xml, 'KR01');
  ok('přeložený název je v exportu', xml.getField(b2, 'sk', 'title') === 'Modrá pánska kravata');
  ok('  česká část popisu v souboru není — čeština se importem nepřepíše',
    !/<DESCRIPTION language="cz"/.test(b2) && /<DESCRIPTION language="sk"/.test(b2));
  ok('  a nejsou tam ani metadata, SEO a parametry', !/<METAS>|<SEO |<PARAMETER>/.test(b2));

  /* ---------- 3. každé pole tam a zpátky ---------- */
  cisto({ atribut });
  const hodnoty = {
    title: 'Kravata „Tom & Jerry" <modrá>', short: '<p>Krátce &amp; dobře</p>',
    long: '<p>Popis s ]]> uvnitř a &nbsp; mezerou</p>',
    seo_title: 'Titulek pro vyhledávač', seo_desc: 'Popis pro vyhledávač & spol.', seo_url: 'modra-kravata-nova',
    redirect: '/stara-adresa\n/jeste-starsi', google_title: 'Pánská kravata modrá | Quentino',
    google_desc: 'Popis pro Google Nákupy.', google_color: 'Modrá', google_gender: 'male', google_age: 'adult',
    google_condition: 'new', google_bundle: 'no', google_identifier: 'yes',
    'param:0:value': 'tmavomodrá'
  };
  for (const lang of ['cz', 'sk']) {
    for (const [pole, hodnota] of Object.entries(hodnoty)) store.saveTranslation('KR02', lang, pole, hodnota, 'zkouška');
  }
  for (const rezim of ['slim', 'full']) {
    const vse = exportxml.buildExport({ codes: ['KR02'], mode: rezim });
    const b3 = blok(vse.xml, 'KR02');
    const nesedi = [];
    for (const lang of ['cz', 'sk']) {
      for (const [pole, hodnota] of Object.entries(hodnoty)) {
        const zpet = String(xml.getField(b3, lang, pole) ?? '').replace(/\s+/g, ' ').trim();
        // Zaškrtávací pole Upgates čte jako 1/0 — „no" se zapisuje jako 0
        const cekam = pole === 'google_bundle' ? xml.checkboxValue(hodnota) : hodnota;
        if (zpet !== cekam.replace(/\s+/g, ' ').trim()) nesedi.push(`${lang}.${pole}: „${zpet.slice(0, 30)}"`);
      }
    }
    ok(`všech ${Object.keys(hodnoty).length} druhů polí se ze souboru přečte zpátky beze změny (${rezim === 'slim' ? 'úsporný' : 'plný'} režim)`,
      nesedi.length === 0 && vse.missed.length === 0 && vse.fields === Object.keys(hodnoty).length * 2,
      nesedi.length ? nesedi.slice(0, 3).join(' · ') : `${vse.fields} polí`);
    if (rezim === 'full') {
      ok('  plný režim nechá produkt celý, i s cenou a skladem', /<PRICE_WITH_VAT>599/.test(b3) && /<STOCK>5/.test(b3));
    } else {
      ok('  úsporný cenu ani sklad nenese', !/<PRICE|<STOCK>/.test(b3));
    }
  }

  /* ---------- 4. produkt, kterému metadata ve feedu chybí ---------- */
  cisto({ atribut });
  google.applyAttributes(['KR03']);
  store.saveTranslation('KR03', 'sk', 'google_title', 'Šedá pánska kravata | Quentino', 'zkouška');
  const novinka = exportxml.buildExport({ codes: ['KR03'] });
  const b4 = blok(novinka.xml, 'KR03');
  ok('produktu bez metadat ve feedu se záznamy založí, hodnoty se neztratí',
    xml.getField(b4, 'sk', 'google_color') !== '' && xml.getField(b4, 'sk', 'google_color') !== null
    && xml.getField(b4, 'sk', 'google_title') === 'Šedá pánska kravata | Quentino' && novinka.missed.length === 0,
    `barva „${xml.getField(b4, 'sk', 'google_color')}", nezapsáno ${novinka.missed.length}`);

  /*
   * Feed se stahuje každou hodinu. Doplněné hodnoty v něm ještě nejsou
   * (do e-shopu se dostanou až importem), takže nové stažení je nesmí
   * smazat — jinak by export záležel na tom, kdy se zrovna klikne.
   */
  store.syncFromFeed(feed({ atribut }));
  const poStazeni = exportxml.buildExport({ codes: ['KR03'] });
  ok('  a nové stažení feedu doplněné hodnoty nesmaže',
    poStazeni.fields === novinka.fields && poStazeni.fields > 0,
    `před stažením ${novinka.fields} polí, po něm ${poStazeni.fields}`);

  /* ---------- 5. feed, kde chybí jen některé klíče ---------- */
  cisto({ atribut, klice: [KLICE.google_title, KLICE.redirect] });
  google.applyAttributes(['KR01']);
  const castecny = exportxml.buildExport({ codes: ['KR01'] });
  ok('klíč, který feed u produktu nemá, se do souboru přidá',
    ATRIBUTY.every(pole => !!xml.getField(blok(castecny.xml, 'KR01'), 'sk', pole)) && castecny.missed.length === 0);

  /* ---------- 6. aktuální stav vybraných produktů ---------- */
  cisto({ atribut });
  google.applyAttributes(['KR01']);
  const soucasny = exportxml.buildExport({ codes: ['KR01'], state: 'current' });
  const b6 = blok(soucasny.xml, 'KR01');
  /*
   * U cílového jazyka. Zdrojový jazyk aplikace po polích nesleduje —
   * nese z něj jen to, co sama napsala, a čeština z feedu se tak
   * importem nevrací ani v tomhle režimu.
   */
  ok('„aktuální stav" nese texty z feedu i doplněné atributy',
    xml.getField(b6, 'sk', 'title') === 'Modrá pánská kravata' && xml.getField(b6, 'sk', 'seo_url') === 'kr01-sk'
    && !!xml.getField(b6, 'sk', 'google_color') && !!xml.getField(b6, 'cz', 'google_color'));
  ok('  a prázdná pole se nezapisují — prázdnem se v e-shopu nic nepřepíše',
    !b6.includes('title_google_merchant') && !/<META_VALUE language="[a-z]+"\s*\/>/.test(b6));

  /* ---------- 7. výběr jazyků, polí a produktů ---------- */
  cisto({ atribut });
  google.applyAttributes(['KR01', 'KR02']);
  store.saveTranslation('KR01', 'sk', 'title', 'Modrá pánska kravata', 'zkouška');
  const jenSk = exportxml.buildExport({ langs: ['sk'] });
  ok('výběr jazyka nechá v souboru jen ten jazyk',
    !/language="cz"/.test(jenSk.xml) && /language="sk"/.test(jenSk.xml) && jenSk.products === 2);
  const jenBarva = exportxml.buildExport({ fields: ['google_color'] });
  ok('výběr pole nechá jen to pole',
    jenBarva.xml.includes('color_google_merchant') && !jenBarva.xml.includes('gender_google_merchant')
    && !/<DESCRIPTION /.test(jenBarva.xml));
  const jenJeden = exportxml.buildExport({ codes: ['KR02'] });
  ok('výběr produktů nechá jen vybrané', jenJeden.products === 1 && !jenJeden.xml.includes('KR01'));
  const nahled = exportxml.exportPreview({ codes: ['KR01'] });
  const skutecny = exportxml.buildExport({ codes: ['KR01'] });
  ok('náhled před exportem slibuje tolik, kolik export dodá',
    nahled.fields === skutecny.fields && nahled.products === skutecny.products,
    `náhled ${nahled.fields}, export ${skutecny.fields}`);

  /* ---------- 8. tvar souboru ---------- */
  const otevrenych = (skutecny.xml.match(/<PRODUCT>/g) ?? []).length;
  ok('soubor je uzavřený a začíná jako XML pro Upgates',
    skutecny.xml.startsWith('<?xml') && skutecny.xml.includes('<PRODUCTS version="2.0">')
    && skutecny.xml.trim().endsWith('</PRODUCTS>')
    && otevrenych === (skutecny.xml.match(/<\/PRODUCT>/g) ?? []).length
    && (skutecny.xml.match(/<METAS>/g) ?? []).length === (skutecny.xml.match(/<\/METAS>/g) ?? []).length);
}

/* ---------- co se zapsat nedá, se řekne ---------- */
console.log('\nco se zapsat nedá:\n');
cisto({});
store.saveTranslation('KR01', 'sk', 'param:7:value', 'hodnota parametru, který produkt nemá', 'zkouška');
store.saveTranslation('KR01', 'sk', 'title', 'Modrá pánska kravata', 'zkouška');
const sDirou = exportxml.buildExport({ codes: ['KR01'] });
ok('pole, které se do produktu zapsat nedá, se nepočítá mezi zapsaná — a je vyjmenované',
  sDirou.fields === 1 && sDirou.missed.length === 1 && sDirou.missed[0] === 'KR01/sk/param:7:value',
  `zapsáno ${sDirou.fields}, nezapsáno: ${sDirou.missed.join(', ')}`);

/*
 * ---------- co export nesmí přepsat ----------
 *
 * Export z 18. 11. (preklady_test.xml) by v e-shopu vrátil 20 českých
 * popisů a čtyři názvy do starší podoby: aplikace je měla uložené z dřívějška
 * a v e-shopu se mezitím upravily. Do úsporného exportu šlo i všechno,
 * co v e-shopu už bylo (opis feedu), zaškrtávací „sada" jako yes/no
 * (Upgates čte 1/0 a označil 1369 produktů jako sady) a zkušební produkt,
 * který v e-shopu není — import by ho založil.
 */
console.log('\nco export nesmí přepsat:\n');
/** Feed, ve kterém někdo v e-shopu upravil slovenský název KR01. */
const sUpravou = (nazev) => feed({}).replace(
  /(<CODE>KR01<\/CODE>[\s\S]*?<DESCRIPTION language="sk">\s*<TITLE>)[^<]*/, `$1${nazev}`);

cisto({});
store.saveTranslation('KR01', 'sk', 'title', 'Modrá pánska kravata', 'zkouška');
store.syncFromFeed(sUpravou('Modrá pánska kravata z hodvábu'));
const poUprave = exportxml.buildExport({ codes: ['KR01'] });
ok('text upravený v e-shopu po překladu se nepřepíše — a je vyjmenovaný',
  poUprave.fields === 0 && poUprave.kept.includes('KR01/sk/title'),
  `zapsáno ${poUprave.fields}, ponecháno: ${poUprave.kept.join(', ')}`);

cisto({});
store.saveTranslation('KR01', 'sk', 'title', 'Modrá pánska kravata', 'zkouška');
const bezUpravy = exportxml.buildExport({ codes: ['KR01'] });
ok('  bez úpravy v e-shopu se překlad zapíše', bezUpravy.fields === 1 && bezUpravy.kept.length === 0);

cisto({});
store.saveTranslation('KR01', 'sk', 'title', 'Modrá pánska kravata', 'zkouška', true);
store.syncFromFeed(sUpravou('Modrá pánska kravata z hodvábu'));
ok('  ruční úprava v aplikaci má přednost i tak', exportxml.buildExport({ codes: ['KR01'] }).fields === 1);

/* Starší překlady otisk nemají — rozhoduje text */
cisto({});
store.saveTranslation('KR01', 'cz', 'long', '<p>Dlouhý popis z hedvábí.</p>\n', 'úklid');
store.saveTranslation('KR02', 'cz', 'long', '<p>Starý popis, který v e-shopu už není.</p>', 'úklid');
db.exec("UPDATE ptrans_fields SET base_hash = NULL, state = 'same'");
const stare = exportxml.buildExport({ codes: ['KR01', 'KR02'] });
ok('starší český text bez otisku, který se v e-shopu mezitím změnil, se nepřepíše',
  stare.kept.includes('KR02/cz/long') && !blok(stare.xml, 'KR02'),
  `ponecháno: ${stare.kept.join(', ')}`);

cisto({});
store.saveTranslation('KR01', 'cz', 'title', 'Modrá pánská kravata', 'zkouška');
const stejny = exportxml.buildExport({ codes: ['KR01'] });
ok('co v e-shopu už je, se znovu nezapisuje', stejny.fields === 0 && stejny.unchanged === 1 && stejny.products === 0);

cisto({});
store.saveTranslation('KR01', 'sk', 'google_bundle', 'yes', 'zkouška');
store.saveTranslation('KR02', 'sk', 'google_bundle', 'no', 'zkouška');
const sady = exportxml.buildExport({ codes: ['KR01', 'KR02'] });
const sada = (code) => (blok(sady.xml, code).match(/is_bundle_google_merchant[\s\S]*?<META_VALUE language="sk">([^<]*)</) ?? [])[1];
ok('„sada" (zaškrtávací pole) jde do souboru jako 1/0, ne yes/no',
  sada('KR01') === '1' && sada('KR02') === '0' && sady.missed.length === 0,
  `KR01 ${sada('KR01')}, KR02 ${sada('KR02')}, nezapsáno ${sady.missed.length}`);
/*
 * Ve feedu má čeština prázdnou hodnotu (`<META_VALUE language="cz"/>`).
 * Zeštíhlení ji dřív vyhazovalo i se slovenštinou, která za ní stála.
 */

cisto({});
store.ingestFile(feed({}).replace(/KR01/g, 'ZKUSEBNI').replace(/kr01/g, 'zkusebni'));
store.saveTranslation('ZKUSEBNI', 'sk', 'title', 'Skúšobná kravata', 'zkouška');
const novy = exportxml.buildExport({ codes: ['ZKUSEBNI'] });
ok('produkt, který v e-shopu není, úsporný export nezaloží',
  novy.products === 0 && novy.skippedNew.includes('ZKUSEBNI'), `přeskočeno: ${novy.skippedNew.join(', ')}`);

console.log(bad ? `\n✗ ${bad} chyb` : '\n✓ export do XML sedí');
process.exit(bad ? 1 : 0);
