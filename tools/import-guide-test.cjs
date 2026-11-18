/**
 * Zkouška proklikání průvodce importem v administraci Upgates.
 *
 * Běží nad **skutečnou stránkou**: značky karet i obsluha kliknutí jsou
 * opsané z administrace (tools/fixtures/upgates-import.html). Bez toho by se
 * ověřovalo jen to, že si aplikace rozumí sama se sebou — a přesně tak vznikla
 * chyba, kvůli které aplikace hlásila „soubor je vložený", zatímco na
 * obrazovce byl pořád výběr typu importu.
 *
 * Ověřuje se, že po třech kliknutích je vidět krok s výběrem souboru, že se
 * do skrytých polí zapsalo to, co má, a že se **nevybere** pravidelný import
 * — z jednorázového souboru by udělal denní přenos.
 */
const fs = require('fs');
const path = require('path');

/*
 * Zkouška potřebuje prohlížeč, a ten na počítači, kde se jen staví aplikace,
 * být nemusí — Playwright není v závislostech schválně, stahoval by si k sobě
 * celý Chromium. Bez něj se zkouška **přeskočí**, ne aby spadl celý `typecheck`
 * a s ním sestavení aplikace.
 */
let chromium = null;
try { ({ chromium } = require('playwright')); } catch { chromium = null; }

/* Stažené prohlížeče v kontejneru nejsou — bere se ten předinstalovaný. */
const PREINSTALLED = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/opt/pw-browsers/chromium/chrome-linux/chrome'].find(one => fs.existsSync(one));

const DIST = process.env.PTDIST || path.join(__dirname, '../dist/ptdist/main');
const guide = require(path.join(DIST, 'ptrans/newproduct/guide.js'));

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

(async () => {
  console.log('\nprůvodce importem:\n');
  if (!chromium) {
    console.log('  · prohlížeč (playwright) tu není — proklikání průvodce se přeskakuje\n');
    process.exit(0);
  }
  let browser;
  try {
    browser = await chromium.launch(PREINSTALLED ? { executablePath: PREINSTALLED } : {});
  } catch (e) {
    /*
     * Playwright je nainstalovaný, ale prohlížeč k němu stažený není. Je to
     * totéž jako by tu nebyl vůbec — sestavení aplikace to zastavovat nemá.
     */
    console.log(`  · prohlížeč se nepodařilo spustit (${String(e.message).split('\n')[0]}) — přeskakuje se\n`);
    process.exit(0);
  }
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto('file://' + path.join(__dirname, 'fixtures/upgates-import.html'));
  await page.waitForTimeout(200);

  // Před prokliknutím krok se souborem vidět není — a políčko na soubor
  // přitom na stránce existuje. Přesně na tom se dřív aplikace spletla.
  const predtim = await page.evaluate(() => ({
    file: !!document.querySelector('#frmguideForm-file'),
    videt: document.querySelector('#file_input').offsetParent !== null
  }));
  check('políčko na soubor je na stránce od začátku', predtim.file, true);
  check('ale krok s ním vidět není', predtim.videt, false);

  const out = await page.evaluate(guide.__test.guideScript());
  check('proklikaly se všechny tři kroky',
    [out.type, out.processing, out.repetition], [true, true, true]);
  check('a krok s výběrem souboru je vidět', out.fileStep, true);

  const zapsano = await page.evaluate(() => ({
    type: document.querySelector('#frmguideForm-import_type').value,
    processing: document.querySelector('#frmguideForm-data_processing').value,
    repetition: document.querySelector('#frmguideForm-repetition_type').value,
    scheduler: document.querySelector('#frmguideForm-scheduler_id').value
  }));
  /*
   * Formát Upgates XML je přesně to, co aplikace vyrábí. „Pouze nové položky"
   * proto, že import se stejným kódem by jinak přepsal cizí produkt.
   */
  check('do formuláře se zapsal formát a způsob',
    [zapsano.type, zapsano.processing], ['general-xml', 'insert']);
  /*
   * Jednorázově. „Pravidelně" by ze souboru udělalo denní import — a to je
   * chyba, která se projeví až za den a nikdo ji nespojí s tímhle kliknutím.
   */
  check('a jednorázový přenos', zapsano.repetition, 'once');
  ok('vybraný běh má své číslo', zapsano.scheduler === '3', zapsano.scheduler);

  const adresa = await page.evaluate(() =>
    document.querySelector('#url_input').offsetParent !== null);
  check('krok s adresou souboru zůstal schovaný', adresa, false);

  // Soubor se vkládá přes CDP; tady stačí ověřit, že stránka po jeho přijetí
  // odkryje „Vytvořit import" — na to se aplikace ptá, než ohlásí hotovo
  await page.setInputFiles('#frmguideForm-file', {
    name: 'novy-produkt.xml', mimeType: 'text/xml', buffer: Buffer.from('<PRODUCTS/>')
  });
  await page.waitForTimeout(150);
  const potvrzeni = await page.evaluate(guide.FILE_TAKEN);
  ok('stránka vypíše jméno souboru', potvrzeni.name.includes('novy-produkt.xml'), potvrzeni.name);
  ok('a odkryje „Vytvořit import"', potvrzeni.saveShown === true);

  /*
   * Oprava už existujícího produktu. „Pouze nové položky" by soubor tiše
   * přeskočil a vypadalo by to, že import selhal — proto se u produktu,
   * který e-shop zná, vybírá „aktualizovat stávající".
   */
  await page.reload();
  await page.waitForTimeout(200);
  await page.evaluate(guide.__test.guideScript({
    type: 'general-xml', processing: 'update', repetition: 'once'
  }));
  const oprava = await page.evaluate(() => ({
    processing: document.querySelector('#frmguideForm-data_processing').value,
    fileStep: document.querySelector('#file_input').offsetParent !== null
  }));
  check('u opravy se vybere aktualizace',
    [oprava.processing, oprava.fileStep], ['update', true]);

  /*
   * Okno nastavení po „Vytvořit import". Upgates v něm má předvybranou
   * „Úpravu" u všech údajů — cen, skladu, kategorií, obrázků, variant.
   * Patrik se ptal (18. 11.), jestli se to, co v souboru chybí, nepřenastaví
   * na prázdno. Aplikace proto nechá „Úpravu" jen u toho, co soubor nese.
   */
  console.log('\nnastavení importu:\n');
  const exportxml = require(path.join(DIST, 'ptrans/exportxml.js'));
  const soubor = '<PRODUCTS><PRODUCT><CODE>A</CODE><DESCRIPTIONS><DESCRIPTION language="sk"><TITLE>x</TITLE>'
    + '<SHORT_DESCRIPTION>y</SHORT_DESCRIPTION><LONG_DESCRIPTION>z</LONG_DESCRIPTION></DESCRIPTION></DESCRIPTIONS>'
    + '<SEO_OPTIMALIZATION><SEO language="sk"><SEO_URL>u</SEO_URL><SEO_TITLE>t</SEO_TITLE>'
    + '<SEO_META_DESCRIPTION>d</SEO_META_DESCRIPTION></SEO></SEO_OPTIMALIZATION>'
    + '<METAS><META type="checkbox"><META_KEY>k</META_KEY></META></METAS></PRODUCT></PRODUCTS>';
  const sloupce = exportxml.importColumns(soubor);
  check('ze souboru se pozná, co nese', sloupce,
    ['title', 'shortDescription', 'longDescription', 'seoURL', 'seoTitle', 'seoDescription', 'meta_key', 'meta_value']);
  check('  soubor jen s metadaty nenechá ani název', exportxml.importColumns(
    '<PRODUCT><CODE>A</CODE><METAS><META><META_KEY>k</META_KEY></META></METAS></PRODUCT>'), ['meta_key', 'meta_value']);

  await page.goto('file://' + path.join(__dirname, 'fixtures/upgates-import-nastaveni.html'));
  const nastaveni = await page.evaluate(guide.__test.settingsScript(sloupce));
  const stav = await page.evaluate(() => {
    const out = {};
    document.querySelectorAll('#frm-editImportForm input[type=radio]:checked').forEach(el => { out[el.name] = el.value; });
    return out;
  });
  const naUprave = Object.keys(stav).filter(name => name.startsWith('columns-') && stav[name] === 'update')
    .map(name => name.slice(8)).sort();
  check('„Úprava" zůstala jen u toho, co soubor nese', naUprave, [...sloupce].sort());
  const vsech = Object.keys(stav).filter(name => name.startsWith('columns-')).length;
  ok('  všechno ostatní je „Nezpracovávat" — ceny, sklad, kategorie, obrázky, varianty',
    ['columns-normalPrice', 'columns-stock', 'columns-category', 'columns-imageURL', 'columns-variantStock',
      'columns-active', 'columns-availability', 'columns-parameter']
      .every(name => stav[name] === 'notProcess') && nastaveni.off === vsech - sloupce.length,
    `vypnuto ${nastaveni.off} z ${vsech}`);
  check('  nové položky se nezakládají, existující aktualizují, chybějící neoznačují',
    [stav['settings[insert_yn]'], stav['settings[update_yn]'], stav['settings[mark_missing_yn]']], ['0', '1', '0']);
  check('  žádný sloupec z exportu ve formuláři nechybí', nastaveni.missing, []);
  ok('  do okna se připíše, co a proč se nastavilo',
    await page.evaluate(() => !!document.querySelector('[data-quentino-note]')));
  /* Co člověk potom přepne, se znovu nepřenastaví */
  await page.evaluate(() => { document.querySelector('#columns-stock-2').checked = true; });
  const znovu = await page.evaluate(guide.__test.settingsScript(sloupce));
  ok('  podruhé se okno nepřenastavuje — volba člověka zůstane',
    znovu.again === true && await page.evaluate(() => document.querySelector('#columns-stock-2').checked));
  ok('  a nic se neuložilo', await page.evaluate(() => location.protocol === 'file:'));
  check('bez okna nastavení skript nic nedělá', await page.evaluate(
    'document.querySelector("#frm-editImportForm").remove(); ' + guide.__test.settingsScript(sloupce)), null);

  ok('na stránce nevznikla chyba', errors.length === 0, errors.join(' | '));

  await browser.close();
  console.log(failed === 0 ? '\nvše sedí\n' : `\n${failed} nesedí\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
