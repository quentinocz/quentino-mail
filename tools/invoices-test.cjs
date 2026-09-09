/**
 * Zkouška hromadného stahování faktur.
 *
 * Do administrace se tady přihlásit nedá, takže se zkouší přesně to, co se
 * bez ní rozbít může: jestli se z jedné otevřené faktury pozná vzor adresy,
 * jestli se do něj správně dosadí číslo, jestli se odhlášení pozná dřív než
 * po stovce marných pokusů — a jestli sloučený PDF opravdu obsahuje všechny
 * stránky. Sloučení je jediná část, kde se pracuje se skutečným PDF, a právě
 * proto se zkouší na opravdových souborech, ne na atrapě.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { db, DIST } = require('./ptrans/harness.cjs');
const { PDFDocument } = require('pdf-lib');

let failed = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${label}`);
  if (!ok) { console.log('      čekáno:', JSON.stringify(want)); console.log('      dostal:', JSON.stringify(got)); }
}
function ok(label, value) { check(label, !!value, true); }

db.exec(`
  CREATE TABLE IF NOT EXISTS shop_orders (
    code TEXT NOT NULL, market TEXT NOT NULL DEFAULT 'cz', status TEXT NOT NULL DEFAULT '',
    paid INTEGER NOT NULL DEFAULT 0, paid_date TEXT NOT NULL DEFAULT '', resolved INTEGER NOT NULL DEFAULT 0,
    invoice TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '',
    currency TEXT NOT NULL DEFAULT '', total REAL NOT NULL DEFAULT 0, tracking TEXT NOT NULL DEFAULT '',
    customer_id TEXT NOT NULL DEFAULT '', name TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '', shipment TEXT NOT NULL DEFAULT '', payment TEXT NOT NULL DEFAULT '',
    items_json TEXT NOT NULL DEFAULT '[]', billing_json TEXT, postal_json TEXT, seen_at TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (code, market)
  );
`);
const today = new Date().toISOString().slice(0, 10);
for (const [code, invoice, name] of [['023748', '2600412', 'Novák'], ['023749', '2600413', 'Svoboda'], ['023750', '2600414', 'Dvořák']]) {
  db.prepare('INSERT OR REPLACE INTO shop_orders (code, market, invoice, created_at, name) VALUES (?,?,?,?,?)')
    .run(code, 'cz', invoice, `${today}T08:00:00`, name);
}
// Kalibrace „číslo objednávky : ID v administraci" — podle ní se dopočítá ID
db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES('adminOrderRef', '23748:9100')").run();

const electron = require('electron');
// Mezisklad stažených faktur leží v datech aplikace; v testu je to /tmp,
// a musí se před během vyprázdnit, jinak by druhý běh nic nestahoval
fs.rmSync(path.join(os.tmpdir(), 'faktury'), { recursive: true, force: true });
const invoices = require(path.join(DIST, 'invoices.js'));
const { __test } = invoices;

/** Malý, ale skutečný PDF — sloučení se nedá zkoušet na vymyšlených bajtech. */
async function samplePdf(pages, text) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([420, 595]).drawText(`${text} ${i + 1}`, { x: 40, y: 540, size: 12 });
  return Buffer.from(await doc.save());
}

(async () => {
  console.log('\nfaktury hromadně:\n');

  /* ---------- naučení adresy ---------- */

  const known = invoices.jobsFor(['023748', '023749', '023750']);
  check('objednávky se načtou i s číslem faktury', known.map(j => j.invoice), ['2600412', '2600413', '2600414']);
  check('a s dopočítaným ID záznamu', known[0].adminId, 9100);

  const byInvoice = __test.templateFrom('https://eshop.admin.s1.upgates.com/manager/invoices/pdf/default/2600413/', known);
  check('v adrese se pozná číslo faktury', byInvoice && byInvoice.template,
    'https://eshop.admin.s1.upgates.com/manager/invoices/pdf/default/{invoice}/');
  check('a řekne se podle čeho', byInvoice && byInvoice.kind, 'číslo faktury');

  const byId = __test.templateFrom('https://eshop.admin.s1.upgates.com/manager/orders/invoice/?order=9100&print=1', known);
  check('když je v adrese ID záznamu, pozná se taky', byId && byId.template,
    'https://eshop.admin.s1.upgates.com/manager/orders/invoice/?order={id}&print=1');

  const byCode = __test.templateFrom('https://x.upgates.com/f/23750.pdf', known);
  check('i číslo objednávky', byCode && byCode.template, 'https://x.upgates.com/f/{code}.pdf');

  /*
   * Skutečná adresa z Upgates — a nejzákeřnější případ.
   *
   * Objednávka 023728 má fakturu 023722, jenže 023722 je **zároveň číslo
   * jiné objednávky**. Když se každé číslo hledalo zvlášť napříč všemi
   * objednávkami, vyšlo z toho `invoice_number={code}` a e-shop pak tiskl
   * fakturu někoho jiného. Adresa se proto vykládá proti jedné objednávce
   * a rozhoduje i název parametru.
   */
  const prekryv = [
    { code: '023728', invoice: '023722', adminId: 1185, name: 'Fedrová' },
    // Tahle objednávka má číslo, které je zároveň číslem faktury té první
    { code: '023722', invoice: '023716', adminId: 1179, name: 'Kramárová' }
  ];
  const skutecna = __test.templateFrom(
    'https://quentino.admin.s19.upgates.com/orders/edit-order/preview/1185/'
    + '?template_id=invoice&invoice_number=023722', prekryv);
  check('číslo v invoice_number je faktura, ne cizí objednávka',
    skutecna && skutecna.template,
    'https://quentino.admin.s19.upgates.com/orders/edit-order/preview/{id}/'
    + '?template_id=invoice&invoice_number={invoice}');
  check('a patří k objednávce, která adresu vysvětlí celou',
    skutecna && skutecna.matched.code, '023728');
  check('nic cizího v adrese nezbylo', skutecna && skutecna.leftovers, []);

  /*
   * Dvě čísla v adrese. Takhle vypadá skutečná adresa faktury v Upgates:
   * v cestě je objednávka, v parametru vnitřní číslo faktury. Nahradit jen
   * to první znamenalo, že se ke každé objednávce stáhla tatáž faktura —
   * proto se nahrazují všechna a co zbude, se vypíše.
   */
  const dva = __test.templateFrom(
    'https://x.upgates.com/orders/edit-order/view-invoice/9100/?invoice_id=1446', known);
  check('objednávka v cestě se nahradí',
    dva && dva.template, 'https://x.upgates.com/orders/edit-order/view-invoice/{id}/?invoice_id=1446');
  check('a cizí číslo faktury se vypíše jako zbytek', dva && dva.leftovers, ['1446']);

  /*
   * Odkaz na fakturu z detailu objednávky. Tohle je druhá cesta, když se
   * adresa dosadit nedá — a musí sáhnout přesně na tu fakturu, která
   * v detailu je.
   */
  check('odkaz na fakturu se najde v detailu', invoices.invoiceHref(
    '<a href="/orders/edit-order/default/9100/">Detail</a>'
    + '<a href="/orders/edit-order/view-invoice/9100/?invoice_id=1446">Faktura</a>',
    'https://x.upgates.com/orders/edit-order/default/9100/'),
    'https://x.upgates.com/orders/edit-order/view-invoice/9100/?invoice_id=1446');
  check('a v HTML entitách taky', invoices.invoiceHref(
    '<a href="/f/view-invoice/9100/?invoice_id=1446&amp;print=1">Faktura</a>', 'https://x.upgates.com/'),
    'https://x.upgates.com/f/view-invoice/9100/?invoice_id=1446&print=1');
  check('bez odkazu se nic nevymýšlí',
    invoices.invoiceHref('<a href="/orders/">Zpět</a>', 'https://x.upgates.com/'), '');

  /*
   * Pojistka: adresa s cizím číslem se nesmí použít. Přesně tohle stáhlo
   * u objednávky 023853 fakturu 023855 — v adrese zůstalo `invoice_id`
   * z faktury, na které se vzor učil.
   */
  check('cizí číslo v adrese se pozná',
    __test.strangeNumber('https://x.upgates.com/orders/edit-order/view-invoice/9100/?invoice_id=1446', known[0]),
    '1446');
  check('vlastní čísla se za cizí nepovažují',
    __test.strangeNumber('https://x.upgates.com/f/2600412.pdf', known[0]), '');
  // Číslo v doméně (s19) není číslo dokladu
  check('doména se nepočítá',
    __test.strangeNumber('https://quentino.admin.s19.upgates.com/f/2600412.pdf', known[0]), '');

  /*
   * Adresa bez čísla, které by šlo s objednávkou spojit, se naučit nedá.
   * Kdyby se uložila tak, jak je, stahovalo by se pak stokrát totéž — a
   * výsledkem by byl PDF se stokrát stejnou fakturou, což je horší než chyba.
   */
  check('adresa bez poznatelného čísla se nenaučí', __test.templateFrom('https://x.upgates.com/f/tisk.pdf', known), null);

  /* ---------- dosazení ---------- */

  check('do vzoru se dosadí číslo faktury',
    __test.fillTemplate('https://x/f/{invoice}.pdf', known[0]), 'https://x/f/2600412.pdf');
  check('a ID záznamu', __test.fillTemplate('https://x/f/?o={id}', known[1]), 'https://x/f/?o=9101');
  // Objednávka bez vystavené faktury: raději nic než adresa s prázdnem
  check('bez čísla faktury se adresa nesestaví',
    __test.fillTemplate('https://x/f/{invoice}.pdf', { code: '1', invoice: '', adminId: null }), null);

  /* ---------- co přišlo místo faktury ---------- */

  const login = { status: 200, type: 'text/html', body: Buffer.from('<html><form><input type="password" name="heslo">') };
  ok('přihlašovací stránka se pozná', !__test.isPdf(login));
  check('a řekne se to jasně', __test.whyNot(login), 'místo faktury přišla přihlašovací stránka');
  check('chyba serveru se od odhlášení odliší',
    __test.whyNot({ status: 503, type: '', body: Buffer.from('') }), 'administrace vrátila chybu 503');

  /* ---------- sloučení ---------- */

  const merged = await invoices.mergePdfs([
    { name: '2600412', body: await samplePdf(2, 'Faktura A') },
    { name: '2600413', body: await samplePdf(1, 'Faktura B') }
  ]);
  check('sloučený PDF má všechny stránky', merged.pages, 3);
  ok('a je to opravdu PDF', merged.pdf.subarray(0, 4).toString('latin1') === '%PDF');
  const broken = await invoices.mergePdfs([{ name: 'rozbitá', body: Buffer.from('nic') }]);
  check('rozbitý soubor zbytek dávky nezastaví', broken.bad.length, 1);

  /* ---------- celá cesta ---------- */

  invoices.saveInvoiceSetup({ template: 'https://x/f/{invoice}.pdf', parallel: 2, openAfter: false });

  const asked = [];
  let together = 0;
  let peak = 0;
  __test.setFetch(async url => {
    asked.push(url);
    together++; peak = Math.max(peak, together);
    await new Promise(r => setTimeout(r, 5));
    together--;
    // Prostřední faktura chybí — dávka musí doběhnout i tak
    if (url.includes('2600413')) return { status: 404, type: 'text/html', body: Buffer.from('nenalezeno') };
    return { status: 200, type: 'application/pdf', body: await samplePdf(1, url) };
  });

  const out = path.join(os.tmpdir(), 'faktury-test.pdf');
  fs.rmSync(out, { force: true });
  electron.dialog.showSaveDialog = async () => ({ canceled: false, filePath: out });

  const run = await invoices.downloadInvoices(['023748', '023749', '023750']);
  check('stáhne se každá faktura jednou', asked.length, 3);
  ok('a víc než jedna najednou', peak > 1);
  ok('ale ne víc, než dovoluje nastavení', peak <= 2);
  check('do souboru se dostanou jen ty, co přišly', run.ok, 2);
  check('a chybějící je vypsaná i s důvodem', run.failed.map(f => f.reason), ['na téhle adrese faktura není (404)']);
  ok('soubor opravdu vznikl', fs.existsSync(out) && fs.readFileSync(out).subarray(0, 4).toString('latin1') === '%PDF');
  check('a má tolik stran, kolik se povedlo', run.pages, 2);

  /*
   * Odhlášení se pozná na první faktuře. Kdyby se poznalo až na konci,
   * čekalo by se zbytečně na stovku odpovědí, které stejně nejsou fakturami.
   */
  asked.length = 0;
  __test.setFetch(async url => {
    asked.push(url);
    return { status: 200, type: 'text/html', body: Buffer.from('<form><input type="password">') };
  });
  const off = await invoices.downloadInvoices(['023748', '023749', '023750']);
  ok('odhlášení se pozná', off.needsLogin);
  check('a zbytek se ani nezkouší', asked.length, 1);

  // Bez naučené adresy se nemá co stahovat — rozhraní má nabídnout naučení
  invoices.saveInvoiceSetup({ template: '' });
  const none = await invoices.downloadInvoices(['023748']);
  ok('bez naučené adresy se řekne, že chybí vzor', none.needsTemplate);

  /* ---------- stahování dopředu ---------- */

  /*
   * Smysl je jediný: u tiskárny se nemá čekat na síť. Zkouší se proto obojí —
   * že se stažené faktury podruhé netahají, a že se z meziskladu opravdu
   * tiskne (druhý tisk nesmí sáhnout na server ani jednou).
   */
  fs.rmSync(path.join(os.tmpdir(), 'faktury'), { recursive: true, force: true });
  invoices.saveInvoiceSetup({ template: 'https://x/f/{invoice}.pdf', parallel: 2, openAfter: false });

  asked.length = 0;
  __test.setFetch(async url => {
    asked.push(url);
    if (url.includes('2600413')) return { status: 404, type: 'text/html', body: Buffer.from('nenalezeno') };
    return { status: 200, type: 'application/pdf', body: await samplePdf(1, url) };
  });

  const pre = await invoices.prefetchInvoices(['023748', '023749', '023750']);
  // Chybějící faktura je běžná věc, dávku zastavit nesmí — odhlášení ano
  check('dopředu se stáhne, co jde', pre.fetched, 2);
  check('a chybějící faktura zbytek nezastaví', pre.stopped, null);

  asked.length = 0;
  const again = await invoices.prefetchInvoices(['023748', '023749', '023750']);
  check('podruhé se už nestahuje nic', [again.fetched, asked.length], [0, 0]);
  check('a ví se, kolik je po ruce', invoices.invoicesReady(['023748', '023750']).ready, 2);

  /*
   * Odhlášení je jiný případ: tam se dávka zastaví hned. Sto marných dotazů
   * na pozadí by jen zatěžovalo administraci a nikdo by se to nedozvěděl.
   */
  fs.rmSync(path.join(os.tmpdir(), 'faktury'), { recursive: true, force: true });
  asked.length = 0;
  __test.setFetch(async url => {
    asked.push(url);
    return { status: 200, type: 'text/html', body: Buffer.from('<form><input type="password">') };
  });
  const off2 = await invoices.prefetchInvoices(['023748', '023749', '023750']);
  check('odhlášení stahování na pozadí zastaví', [asked.length, off2.fetched], [1, 0]);

  __test.setFetch(async url => {
    asked.push(url);
    if (url.includes('2600413')) return { status: 404, type: 'text/html', body: Buffer.from('nenalezeno') };
    return { status: 200, type: 'application/pdf', body: await samplePdf(1, url) };
  });
  await invoices.prefetchInvoices(['023748', '023750']);

  asked.length = 0;
  const fast = await invoices.downloadInvoices(['023748', '023750']);
  check('tisk vezme faktury z meziskladu', asked.length, 0);
  check('a je jich tam tolik, kolik má být', fast.ok, 2);

  /*
   * A totéž na celé cestě: se vzorem, ve kterém zbylo cizí číslo, se
   * nesmí stáhnout ani jedna faktura.
   */
  fs.rmSync(path.join(os.tmpdir(), 'faktury'), { recursive: true, force: true });
  invoices.saveInvoiceSetup({ template: 'https://x/f/{invoice}.pdf?invoice_id=1446', mode: 'template' });
  asked.length = 0;
  const cizi = await invoices.downloadInvoices(['023748']);
  check('s cizím číslem se nestahuje nic', [asked.length, cizi.ok], [0, 0]);
  ok('a řekne se proč', (cizi.failed[0]?.reason ?? '').includes('cizí číslo'));

  __test.setFetch(null);
  console.log(failed === 0 ? '\nvše sedí\n' : `\n${failed} nesedí\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
