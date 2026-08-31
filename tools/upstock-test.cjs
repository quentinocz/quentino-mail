/**
 * Zkouška kódu, který se posílá do okna administrace.
 *
 * Vkládání do Upgates se nedá vyzkoušet bez přihlášení do e-shopu — zato se
 * dá zkontrolovat to, co se v minulé verzi rozbilo tiše: **že se ten kód dá
 * vůbec přeložit** a že v něm sedí čísla a kódy z řádku. Překlep v řetězci
 * uvnitř `executeJavaScript` se jinak projeví až v okně, které nic nepřidá.
 */
const path = require('path');
const { DIST } = require('./ptrans/harness.cjs');

let failed = 0;
function check(label, got, want) {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${label}`);
  if (!ok) { console.log('      čekáno:', JSON.stringify(want)); console.log('      dostal:', JSON.stringify(got)); }
}
function ok(label, value) { check(label, !!value, true); }

const upstock = require(path.join(DIST, 'upstock.js'));

// Okno, které kód nespustí, jen si ho schová a zkusí přeložit
const sent = [];
const win = {
  isDestroyed: () => false,
  webContents: {
    executeJavaScript(code) {
      sent.push(code);
      try {
        // eslint-disable-next-line no-new-func
        new Function(code);
      } catch (e) {
        return Promise.reject(new Error(`kód se nedá přeložit: ${e.message}`));
      }
      return Promise.resolve('');
    }
  }
};

const row = {
  code: 'DS60KM', title: 'Královsky modré dětské kšandy', label: 'Délka: 60cm (pro děti do 110cm)',
  qty: 6, productId: '515', variantId: '177', stockNow: 11, stockBefore: 11, moved: false
};

console.log('\nkód posílaný do administrace:\n');

(async () => {
  // Funkce jsou vnitřní; sáhne se na ně přes zkušební vstup modulu
  const { __test } = upstock;
  ok('modul nabízí, co se dá zkoušet', !!__test);

  await __test.addOne(win, row, '9002');
  const add = sent[sent.length - 1];
  ok('kód přidání se dá přeložit', add.length > 0);
  /*
   * Tohle je přesně ta chyba, kvůli které se do formuláře nic nevkládalo:
   * volalo se jen `addOperationStockingUp`. Stránka sama volá nejdřív
   * `getProductForStocking`, který teprve vrátí platné `option_set_id`.
   */
  ok('jde nejdřív getProductForStocking', add.includes('do=getProductForStocking'));
  ok('a teprve pak addOperationStockingUp', add.includes('do=addOperationStockingUp'));
  ok('pořadí sedí',
    add.indexOf('getProductForStocking') < add.indexOf('addOperationStockingUp'));
  ok('posílá se vnitřní číslo produktu', add.includes('"515"'));
  ok('a číslo sady voleb z administrace, ne z feedu', add.includes('"9002"') && !add.includes('"177"'));
  ok('počet se vyplní i do políčka stránky', add.includes('product_preview_count'));
  // Produkt s variantami bez určené varianty se nesmí přidat naslepo
  ok('neurčenou variantu nepřidá', add.includes('option_set_yn'));

  await __test.optionSetFor(win, row);
  const vars = sent[sent.length - 1];
  ok('kód hledání varianty se dá přeložit', vars.length > 0);
  ok('ptá se administrace na varianty', vars.includes('do=getVariants'));
  // Kód se do porovnání dostává v malých písmenech, ať se štítek najde
  // i když ho administrace píše jinak
  ok('hledá podle kódu varianty', vars.includes('"DS60KM".toLowerCase()'));
  ok('a záložně podle popisku', vars.includes('Délka: 60cm'));
  // „Asi to bude tenhle" znamená naskladnit cizí velikost
  ok('při nejednoznačné shodě nevrací nic', vars.includes('hits.length === 1'));

  await __test.gridCount(win);
  const count = sent[sent.length - 1];
  ok('kód počítání řádků se dá přeložit', count.length > 0);
  ok('čte počet položek z mřížky', count.includes('data-data_count'));

  console.log(failed ? `\n✗ ${failed} zkoušek selhalo\n` : '\n✓ kód pro administraci je v pořádku\n');
  process.exit(failed ? 1 : 0);
})();
