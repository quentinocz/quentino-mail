/**
 * Zkouška zakládání nového produktu.
 *
 * Přes model ani přes administraci se odsud nic vyzkoušet nedá. Zkouší se to,
 * co o výsledku rozhoduje a co by se poznalo až na e-shopu — v nejhorším až
 * tím, že import přepsal cizí produkt:
 *
 *  1. **strom kategorií** — kdo je pod kým, a co je vůbec kategorie na zboží,
 *  2. **co se z předlohy nesmí přenést** — číslo produktu, sklad, varianty,
 *     EAN a akční cena; každá z nich napáchá jinou škodu,
 *  3. **tvar zápisu** — kategorie se zapisují kódem a hlavní smí být právě
 *     jedna; obrázky mají titulní,
 *  4. **co ještě chybí** — co export zastaví a co je jen škoda,
 *  5. **návrhy změn** — návrh, který v textu není, se nepoužije.
 */
const path = require('path');
const { db, store, DIST } = require('./ptrans/harness.cjs');

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

const categories = require(path.join(DIST, 'ptrans/categories.js'));
const draftMod = require(path.join(DIST, 'ptrans/newproduct/draft.js'));
const build = require(path.join(DIST, 'ptrans/newproduct/build.js'));
const rewrite = require(path.join(DIST, 'ptrans/newproduct/rewrite.js'));
const templ = require(path.join(DIST, 'ptrans/newproduct/template.js'));
const params = require(path.join(DIST, 'ptrans/newproduct/params.js'));

console.log('\nnový produkt:\n');

/* ---------- strom kategorií ---------- */

const CATS = `<?xml version="1.0" encoding="UTF-8"?>
<CATEGORIES version="1.0">
  <CATEGORY>
    <CODE>C-TOP</CODE><CATEGORY_ID>1</CATEGORY_ID><POSITION>2</POSITION>
    <ACTIVE_YN>1</ACTIVE_YN><TYPE>site</TYPE>
    <DESCRIPTIONS>
      <DESCRIPTION language="cz"><NAME>Top menu</NAME></DESCRIPTION>
      <DESCRIPTION language="en"><NAME>Top menu</NAME></DESCRIPTION>
    </DESCRIPTIONS>
  </CATEGORY>
  <CATEGORY>
    <CODE>K00010</CODE><CATEGORY_ID>10</CATEGORY_ID>
    <ACTIVE_YN>1</ACTIVE_YN><TYPE>siteWithProducts</TYPE>
    <DESCRIPTIONS>
      <DESCRIPTION language="cz"><NAME>Doplňky</NAME></DESCRIPTION>
      <DESCRIPTION language="sk"><NAME>Doplnky</NAME></DESCRIPTION>
    </DESCRIPTIONS>
  </CATEGORY>
  <CATEGORY>
    <CODE>K00028</CODE><CATEGORY_ID>28</CATEGORY_ID><PARENT_ID>10</PARENT_ID>
    <ACTIVE_YN>1</ACTIVE_YN><TYPE>siteWithProducts</TYPE>
    <DESCRIPTIONS>
      <DESCRIPTION language="cz"><NAME>Kravaty</NAME></DESCRIPTION>
      <DESCRIPTION language="en"><NAME>Neckties</NAME></DESCRIPTION>
    </DESCRIPTIONS>
  </CATEGORY>
  <CATEGORY>
    <CODE>K00026</CODE><CATEGORY_ID>5</CATEGORY_ID><PARENT_ID>9</PARENT_ID>
    <ACTIVE_YN>1</ACTIVE_YN><TYPE>url</TYPE>
    <DESCRIPTIONS><DESCRIPTION language="cz"><NAME>O nás</NAME></DESCRIPTION></DESCRIPTIONS>
  </CATEGORY>
</CATEGORIES>`;

{
  const rows = categories.__test.parseCategories(CATS);
  check('přečtou se všechny kategorie', rows.length, 4);
  /*
   * Kdyby se stránky v menu nabízely k zařazení, dalo by se zboží pověsit do
   * „O nás" — a v e-shopu by pak nebylo nikde.
   */
  check('zboží patří jen do kategorií se zbožím',
    rows.filter(one => one.holdsProducts).map(one => one.code), ['K00010', 'K00028']);
  check('název se čte po jazycích', rows[2].names.en, 'Neckties');

  /*
   * Uložený strom je to, z čeho se pak berou názvy kategorií do XML.
   * V aplikaci ho tam zapíše stažení exportu; tady se podstrčí rovnou.
   */
  db.prepare('INSERT INTO settings(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run('ptrans.categories', JSON.stringify({ items: rows, at: '2026-09-13T08:00:00Z', source: 'test' }));

  const flat = categories.__test.flatten(rows, 'cz');
  const kravaty = flat.find(one => one.code === 'K00028');
  check('podkategorie je zanořená', [kravaty.depth, kravaty.path], [1, 'Doplňky / Kravaty']);
  /*
   * Kategorie, jejíž rodič v exportu není, musí zůstat vidět. Kdyby zmizela,
   * vypadalo by to, že v e-shopu není — a zboží by se do ní nedalo zařadit.
   */
  const sirotek = flat.find(one => one.code === 'K00026');
  check('kategorie bez rodiče zůstane v kořeni', [sirotek.depth, sirotek.path], [0, 'O nás']);
}

/* ---------- předloha ---------- */

const FEED = `<?xml version="1.0" encoding="utf-8"?>
<PRODUCTS>
  <PRODUCT>
    <PRODUCT_ID>101</PRODUCT_ID>
    <CODE>KR00100</CODE>
    <EAN>8594001234567</EAN>
    <ACTIVE_YN>1</ACTIVE_YN>
    <MANUFACTURER>Quentino</MANUFACTURER>
    <STOCK>7</STOCK>
    <AVAILABILITY>Skladem</AVAILABILITY>
    <DESCRIPTIONS>
      <DESCRIPTION language="cz">
        <TITLE>Kravata modrá se vzorem</TITLE>
        <URL>https://www.quentino.cz/p/kr00100</URL>
        <SHORT_DESCRIPTION><![CDATA[<p>Modrá kravata s jemným vzorem.</p>]]></SHORT_DESCRIPTION>
        <LONG_DESCRIPTION><![CDATA[<p>Modrá se hodí k šedému obleku.</p>]]></LONG_DESCRIPTION>
      </DESCRIPTION>
    </DESCRIPTIONS>
    <SEO_OPTIMALIZATION>
      <SEO language="cz"><SEO_TITLE>Kravata modrá</SEO_TITLE><SEO_URL>kravata-modra</SEO_URL></SEO>
    </SEO_OPTIMALIZATION>
    <CATEGORIES>
      <CATEGORY><CODE>K00028</CODE><NAME language="cz">Kravaty</NAME><PRIMARY_YN>1</PRIMARY_YN></CATEGORY>
    </CATEGORIES>
    <IMAGES><IMAGE><URL>https://img/stara.webp</URL><MAIN_YN>1</MAIN_YN></IMAGE></IMAGES>
    <PARAMETERS>
      <PARAMETER><NAME language="cz">Barva</NAME><VALUE language="cz">modrá</VALUE></PARAMETER>
    </PARAMETERS>
    <PRICES>
      <PRICE language="cz">
        <CURRENCY>CZK</CURRENCY>
        <PRICE_WITH_VAT>790</PRICE_WITH_VAT>
        <PRICE_SALE>590</PRICE_SALE>
        <VAT>21</VAT>
      </PRICE>
    </PRICES>
    <VARIANTS>
      <VARIANT><CODE>KR00100-A</CODE><STOCK>2</STOCK></VARIANT>
    </VARIANTS>
  </PRODUCT>
</PRODUCTS>`;

store.syncFromFeed(FEED);

console.log('\nkontrola kódu:');
{
  check('obsazený kód se pozná', templ.codeTaken('KR00100').taken, true);
  // Upgates kódy nerozlišuje podle velikosti písmen; kdyby aplikace ano,
  // „kr00100" by prošlo jako volné a import by předlohu přepsal
  check('a nezáleží na velikosti písmen', templ.codeTaken('kr00100').taken, true);
  check('volný kód projde', templ.codeTaken('KR00999').taken, false);
  /*
   * Po uložení do katalogu tam produkt je — a kontrola u jeho vlastního kódu
   * hlásila „má ho …" a ukazovala přitom sama na sebe. Vypadalo to, že se kód
   * musí změnit, přitom bylo všechno v pořádku.
   */
  check('vlastní kód není kolize', templ.codeTaken('KR00100', 'KR00100').taken, false);
  check('cizí kód kolize zůstává', templ.codeTaken('KR00100', 'JINY01').taken, true);
}

/* ---------- číselník parametrů ---------- */

console.log('\nčíselník parametrů:');
{
  /*
   * Druhý produkt má stejný parametr psaný jinak („barva" malým) a navíc
   * překlady. Číselník je musí složit do jedné položky — jinak by v nabídce
   * byla „Barva" i „barva" a v e-shopu by z toho byly dva filtry.
   */
  store.ingestFile(`<PRODUCTS><PRODUCT>
    <CODE>KR00101</CODE>
    <DESCRIPTIONS><DESCRIPTION language="cz"><TITLE>Kravata zelená</TITLE></DESCRIPTION></DESCRIPTIONS>
    <PARAMETERS>
      <PARAMETER>
        <NAME language="cz">barva</NAME><NAME language="sk">Farba</NAME><NAME language="en">Colour</NAME>
        <VALUE language="cz">zelená</VALUE><VALUE language="sk">zelená</VALUE><VALUE language="en">green</VALUE>
      </PARAMETER>
      <PARAMETER>
        <NAME language="cz">Šířka</NAME>
        <VALUE language="cz">7 cm</VALUE>
      </PARAMETER>
    </PARAMETERS>
  </PRODUCT></PRODUCTS>`);

  const out = params.learnParams('cz');
  check('parametry se posbíraly z feedu', out.names, 2);

  const names = params.paramNames().map(one => one.key).sort();
  check('„Barva" a „barva" jsou jedna položka', names, ['barva', 'sirka']);

  const barva = params.paramNames().find(one => one.key === 'barva');
  check('a nese překlady z e-shopu', [barva.langs.sk, barva.langs.en], ['Farba', 'Colour']);
  check('i počet použití', barva.hits, 2);

  /*
   * Hodnoty patří ke svému parametru. Kdyby byly na jedné hromadě, nabízela
   * by se u šířky „zelená" — a kdo kliká rychle, tak si jí nevšimne.
   */
  check('hodnoty jsou u svého parametru',
    params.paramValues('Barva').map(one => one.key).sort(), ['modra', 'zelena']);
  check('u šířky jsou jiné', params.paramValues('Šířka').map(one => one.key), ['7 cm']);

  const found = params.lookupParam('Barva', 'zelená');
  check('dohledá se znění ve všech jazycích',
    [found.name.sk, found.value.en], ['Farba', 'green']);
  ok('a je vidět, že to e-shop zná', found.knownName && found.knownValue);

  // Překlep se musí poznat, jinak produkt vypadne z filtru v kategorii
  const preklep = params.lookupParam('Šíře', '7 cm');
  ok('překlep v názvu se pozná', !preklep.knownName, JSON.stringify(preklep));

  /*
   * „7 cm" a „7cm" jsou pro e-shop dvě hodnoty. Sloučit je by znamenalo
   * rozhodnout za člověka, která je ta správná — proto se neslučují.
   */
  ok('mezera uvnitř hodnoty rozlišuje', !params.lookupParam('Šířka', '7cm').knownValue);

  const resolved = params.resolveParams(
    [{ name: 'Barva', value: 'zelená' }, { name: 'Nový', value: 'cosi' }], ['cz', 'sk', 'en']);
  check('známý parametr se doplní', resolved.en[0], { name: 'Colour', value: 'green' });
  /*
   * Co číselník nezná, zůstane prázdné. Vymyslet si překlad parametru by bylo
   * horší než ho nemít: ve filtru by vznikla druhá položka s jiným zněním
   * a zákazník by u ní našel jediný produkt.
   */
  check('neznámý zůstane prázdný', resolved.sk[1], { name: '', value: '' });
}

/* ---------- měny ---------- */

console.log('\nměny podle jazyka:');
{
  const np = require(path.join(DIST, 'ptrans/newproduct/index.js'));
  /*
   * Měna se nedá hádat. Anglický e-shop může prodávat v eurech stejně jako
   * v librách a cena zapsaná v jiné měně, než e-shop čeká, znamená prodávat
   * pětadvacetkrát levněji.
   */
  check('měna se čte z feedu', np.feedCurrencies().cz, 'CZK');
}

/* ---------- sestavení XML ---------- */

console.log('\nXML pro import:');
const draft = {
  id: 'np-1',
  code: 'KR00999',
  ean: '',
  manufacturer: 'Quentino',
  templateCode: 'KR00100',
  categories: ['K00028', 'K00010'],
  mainCategory: 'K00028',
  images: [
    { url: 'https://img/nova-1.webp', name: 'nova-1.webp', main: true },
    { url: 'https://img/nova-2.webp', name: 'nova-2.webp', main: false }
  ],
  params: [{ name: 'Barva', value: 'zelená' }, { name: 'Vzor', value: 'hladká' }],
  langs: {
    cz: {
      title: 'Kravata zelená hladká',
      short: '<p>Zelená kravata bez vzoru.</p>',
      long: '<p>Zelená se hodí k hnědému obleku.</p>',
      seo_title: '', seo_desc: '', seo_url: '', google_title: '', google_desc: ''
    }
  },
  google: {},
  prices: { cz: '890', sk: '36' },
  specifics: [],
  state: 'draft', createdAt: '', updatedAt: '', exportedAt: null
};

const xmlOut = build.buildProductXml(draft, { langs: ['cz', 'sk'], sourceLang: 'cz' });

/*
 * Číslo produktu identifikuje **existující** produkt. Kdyby v souboru zůstalo,
 * import by nezaložil nový produkt, ale potichu přepsal předlohu.
 */
ok('číslo produktu z předlohy se nepřenese', !xmlOut.includes('<PRODUCT_ID>'), xmlOut.slice(0, 300));
ok('sklad se nepřenese', !/<STOCK>/.test(xmlOut));
ok('dostupnost se nepřenese', !/<AVAILABILITY>/.test(xmlOut));
ok('varianty předlohy se nepřenesou', !xmlOut.includes('<VARIANTS>'));
// EAN je unikátní číslo; dvakrát existovat nesmí
ok('EAN předlohy se nepřenese', !xmlOut.includes('8594001234567'));
/*
 * Přenesená akční cena by nový produkt rovnou vystavila ve slevě, aniž by to
 * bylo kdekoli vidět.
 */
ok('akční cena předlohy se nepřenese', !xmlOut.includes('<PRICE_SALE>'));

check('kód je nový', /<CODE>KR00999<\/CODE>/.test(xmlOut), true);
check('cena je nová', /<PRICE_WITH_VAT>890<\/PRICE_WITH_VAT>/.test(xmlOut), true);
ok('sazba DPH z předlohy zůstane', xmlOut.includes('<VAT>21</VAT>'));
// Eura se berou z pole „sk"; tvar bloku se vezme z české ceny, protože jiný
// ve feedu není
ok('eurová cena se zapíše s vlastní měnou',
  /<PRICE language="sk">[\s\S]*?<PRICE_WITH_VAT>36<\/PRICE_WITH_VAT>/.test(xmlOut), xmlOut);

{
  const wrap = /<CATEGORIES>([\s\S]*?)<\/CATEGORIES>/.exec(xmlOut)[1];
  check('kategorie se zapisují kódem', (wrap.match(/<CODE>/g) || []).length, 2);
  /*
   * Hlavní kategorie smí být právě jedna — určuje adresu produktu a
   * drobečkovou navigaci. Dvě by znamenaly, že rozhodne import sám.
   */
  check('hlavní je právě jedna', (wrap.match(/<PRIMARY_YN>1<\/PRIMARY_YN>/g) || []).length, 1);
  ok('a je to ta vybraná', /<CODE>K00028<\/CODE>[\s\S]*?<PRIMARY_YN>1<\/PRIMARY_YN>/.test(wrap), wrap);
  /*
   * Kromě kódu se zapisuje i název. Import se řídí kódem, ale aplikace si
   * z vlastního exportu čte kategorii **podle názvu** — bez něj by nový produkt
   * zůstal „bez kategorie" a přišel by o všechno, co se podle ní řídí: tvar
   * názvu, styl textů i atributy pro Google.
   */
  ok('u kategorie je i název', wrap.includes('<NAME language="cz">Kravaty</NAME>'), wrap);
}

{
  const wrap = /<IMAGES>([\s\S]*?)<\/IMAGES>/.exec(xmlOut)[1];
  ok('obrázky předlohy se nepřenesou', !wrap.includes('stara.webp'), wrap);
  check('titulní je právě jeden', (wrap.match(/<MAIN_YN>1<\/MAIN_YN>/g) || []).length, 1);
}

{
  const wrap = /<PARAMETERS>([\s\S]*?)<\/PARAMETERS>/.exec(xmlOut)[1];
  /*
   * Nepřeložený parametr se v cizí mutaci ukáže česky. Než překlad doběhne,
   * vypíše se čeština u všech jazyků — prázdná hodnota by v e-shopu udělala
   * parametr bez obsahu.
   */
  ok('parametr je ve všech jazycích', wrap.includes('<VALUE language="sk">zelená</VALUE>'), wrap);
  ok('a hodnota předlohy je pryč', !wrap.includes('>modrá<'));
}

ok('texty jsou nové', xmlOut.includes('Kravata zelená hladká') && !xmlOut.includes('Kravata modrá se vzorem'),
  xmlOut.slice(0, 400));
/*
 * Nejtišší ze všech chyb, které tady hrozí: `<SEO_URL>` se v bloku předlohy
 * veze dál a nový produkt by se naimportoval **na adresu předlohy**. Dvě
 * stránky se stejnou adresou znamenají, že jedna z nich v e-shopu přestane
 * existovat — a je to ta nová.
 */
ok('SEO adresa předlohy se nepřenese', !xmlOut.includes('kravata-modra'), xmlOut);
ok('a zůstane prázdná, ať si ji Upgates doplní z názvu',
  /<SEO_URL><\/SEO_URL>/.test(xmlOut), xmlOut);
// Odkaz na produkt v popisu je taky adresa předlohy
ok('odkaz na produkt v popisu se vyprázdní', !xmlOut.includes('/p/kr00100'), xmlOut);

/* ---------- uložení do katalogu a načtení zpátky ---------- */

console.log('\nuložení do katalogu:');
{
  const np = require(path.join(DIST, 'ptrans/newproduct/index.js'));
  const draftMod2 = require(path.join(DIST, 'ptrans/newproduct/draft.js'));

  const rozdelany = draftMod2.newDraft();
  draftMod2.saveDraft(rozdelany.id, {
    code: draft.code, templateCode: draft.templateCode, manufacturer: draft.manufacturer,
    categories: draft.categories, mainCategory: draft.mainCategory,
    images: draft.images, params: draft.params, prices: draft.prices,
    langs: { cz: draft.langs.cz }
  });

  const out = np.saveToCatalog(rozdelany.id);
  check('produkt je v katalogu', out.code, 'KR00999');
  /*
   * Odpověď nese celý produkt, ne jen kód. Rozhraní si rozdělaný produkt drží
   * v místní kopii a bez toho v ní zůstalo „ještě neuloženo" — tlačítka na
   * doplnění textů a na import zůstávala šedá, dokud se okno nezavřelo
   * a neotevřelo znovu.
   */
  check('a vrátí se i jeho nový stav', out.draft.state, 'exported');

  // Doplnění zapisuje do katalogu; rozhraní ukazuje rozdělaný produkt. Bez
  // načtení zpátky doběhlo doplnění i překlad a na obrazovce se nezměnilo nic.
  store.saveTranslation('KR00999', 'cz', 'seo_title', 'Kravata zelená | Quentino', '', true);
  store.saveTranslation('KR00999', 'sk', 'title', 'Kravata zelená hladká', '', true);

  const nacteny = np.readBack('KR00999');
  check('dopsaný SEO titulek se vrátí do formuláře',
    nacteny.langs.cz.seo_title, 'Kravata zelená | Quentino');
  check('a překlad taky', nacteny.langs.sk.title, 'Kravata zelená hladká');
  // Co člověk napsal, doplnění nepřepisuje prázdnem
  check('napsaný název zůstane', nacteny.langs.cz.title, 'Kravata zelená hladká');
}

/* ---------- co ještě chybí ---------- */

console.log('\nco ještě chybí:');
{
  const gaps = draftMod.draftGaps(draft, ['cz', 'sk']);
  check('u hotového produktu nic nebrání',
    gaps.filter(one => one.level === 'blocker').map(one => one.key), []);

  const holy = draftMod.draftGaps({ ...draft, code: '', mainCategory: '', prices: {} }, ['cz']);
  check('bez kódu, kategorie a ceny se nepustí dál',
    holy.filter(one => one.level === 'blocker').map(one => one.key).sort(),
    ['category', 'code', 'price']);

  /*
   * Obrázek vybraný z disku, ale ještě nenahraný, nemá adresu — v XML by z něj
   * byl prázdný `<URL>` a produkt by v e-shopu zůstal bez fotky.
   */
  const nenahrane = draftMod.draftGaps(
    { ...draft, images: [{ path: '/tmp/a.webp', name: 'a.webp', main: true }] }, ['cz']);
  ok('nenahraný obrázek export zastaví',
    nenahrane.some(one => one.key === 'upload' && one.level === 'blocker'),
    JSON.stringify(nenahrane));
}

/* ---------- odkazy v překladech ---------- */

console.log('\nodkazy v přeloženém textu:');
{
  const links = require(path.join(DIST, 'ptrans/newproduct/links.js'));
  const html = '<p>Hodí se k <a href="https://www.quentino.cz/kravaty">kravatám</a> i '
    + '<a class="x" href=\'https://www.quentino.cz/motylky\'>motýlkům</a>.</p>';

  const mapa = {
    'https://www.quentino.cz/kravaty': 'https://www.quentino.sk/kravaty',
    'https://www.quentino.cz/motylky': 'https://www.quentino.sk/motyliky'
  };
  const out = links.__test.replaceHrefs(html, href => mapa[href] ?? null);
  ok('vymění se obě adresy',
    out.includes('quentino.sk/kravaty') && out.includes('quentino.sk/motyliky'), out);
  // Atributy okolo odkazu musí zůstat — jinak se z textu ztratí třída i styl
  ok('zbytek značky zůstane', out.includes('class="x"'), out);
  ok('a text odkazu taky', out.includes('>kravatám</a>') && out.includes('>motýlkům</a>'), out);

  /*
   * Odkaz, pro který se adresa na cizím trhu nenašla, musí zůstat, jak byl.
   * Vyhodit ho nebo nechat poloviční by z textu udělalo nefunkční odkaz —
   * a to je horší než odkaz na český web.
   */
  const puvodni = links.__test.replaceHrefs(html, () => null);
  check('nenalezená adresa se nechá být', puvodni, html);
}

/* ---------- návrhy změn ---------- */

console.log('\nnávrhy podle nového názvu:');
{
  const text = '<p>Modrá se hodí k šedému obleku.</p>';
  const change = { field: 'long', before: 'Modrá', after: 'Zelená', why: 'barva' };
  const out = rewrite.applyChange(text, change);
  check('návrh se použije', [out.applied, out.value], [true, '<p>Zelená se hodí k šedému obleku.</p>']);
  /*
   * Mezi vypsáním návrhů a kliknutím se text edituje. Návrh, jehož původní
   * znění už v textu není, se nesmí použít „někam" — jinak by se přepsalo
   * místo, o kterém nikdo nerozhodl.
   */
  const changed = rewrite.applyChange('<p>Zelená se hodí k šedému obleku.</p>', change);
  check('na změněný text se nesáhne', changed.applied, false);
}

console.log(failed === 0 ? '\nvše sedí\n' : `\n${failed} nesedí\n`);
process.exit(failed === 0 ? 0 : 1);
