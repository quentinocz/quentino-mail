/**
 * Zkouška vyplnění přihlášení do cizí administrace.
 *
 * Aplikace otevírá administraci v okně a hlásí se do ní sama. Když se to
 * nepovede, člověk kouká na přihlašovací stránku a neví proč — proto se tu
 * zkouší přesně ta místa, na kterých to selhávalo:
 *
 *  1. **které tlačítko se zmáčkne.** Formulář mívá dřív než odeslání jiné
 *     tlačítko (oko u hesla, přepínač jazyka). `querySelector` se seznamem
 *     selektorů vrací první prvek v pořadí stránky, ne první podle pořadí
 *     selektorů — klikalo se tedy na oko, nic se neodeslalo a aplikace přesto
 *     hlásila „odesláno",
 *  2. **které políčko je jméno.** Podle názvu se hledat nedá (`username`,
 *     `login`, `email`…), platí ale „heslo a nejbližší textové políčko nad ním",
 *  3. **vyplnění bez odeslání**, když si to člověk tak nastaví.
 */
const fs = require('fs');
const path = require('path');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch { chromium = null; }

const PREINSTALLED = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/opt/pw-browsers/chromium/chrome-linux/chrome'].find(one => fs.existsSync(one));

const DIST = process.env.PTDIST || path.join(__dirname, '../dist/ptdist/main');

let failed = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${label}`);
  if (!ok) { console.log('      čekáno:', JSON.stringify(want)); console.log('      dostal:', JSON.stringify(got)); }
}

/* Formulář s pastí: oko u hesla je v pořadí dřív než odeslání. */
const FORM = `
<!doctype html><meta charset="utf-8">
<form id="login" onsubmit="window.__odeslano = true; return false;">
  <input type="text" name="j_username" id="u" placeholder="Přihlašovací jméno">
  <input type="password" name="j_password" id="p" placeholder="Heslo">
  <button onclick="window.__oko = true; return false;">oko</button>
  <button type="submit" onclick="window.__submit = true;">Přihlásit</button>
</form>`;

(async () => {
  console.log('\nvyplnění přihlášení:\n');
  if (!chromium) {
    console.log('  · prohlížeč (playwright) tu není — vyplnění formuláře se přeskakuje\n');
    process.exit(0);
  }
  let browser;
  try {
    browser = await chromium.launch(PREINSTALLED ? { executablePath: PREINSTALLED } : {});
  } catch (e) {
    console.log(`  · prohlížeč se nepodařilo spustit (${String(e.message).split('\n')[0]}) — přeskakuje se\n`);
    process.exit(0);
  }
  const { __test } = require(path.join(DIST, 'portallogin.js'));
  const page = await browser.newPage();

  await page.setContent(FORM);
  const out = await page.evaluate(__test.fillScript('patrik', 'tajne', true));
  check('vyplnilo a odeslalo', out, 'odesláno');
  const stav = await page.evaluate(() => ({
    user: document.querySelector('#u').value,
    pass: document.querySelector('#p').value,
    oko: !!window.__oko,
    submit: !!window.__submit
  }));
  check('jméno i heslo jsou v políčkách', [stav.user, stav.pass], ['patrik', 'tajne']);
  /*
   * Tohle je celá ta chyba: kliknutí skončilo na oku u hesla, nic se
   * neodeslalo — a aplikace přesto hlásila, že přihlásila.
   */
  check('zmáčklo se odeslání, ne oko u hesla', [stav.submit, stav.oko], [true, false]);

  await page.setContent(FORM);
  // `setContent` přepíše dokument, ale `window` zůstává — příznaky z minulé
  // zkoušky by se jinak počítaly jako výsledek téhle
  await page.evaluate(() => { window.__oko = false; window.__submit = false; window.__odeslano = false; });
  const bez = await page.evaluate(__test.fillScript('patrik', 'tajne', false));
  const potom = await page.evaluate(() => ({
    pass: document.querySelector('#p').value, submit: !!window.__submit
  }));
  check('bez „rovnou přihlásit" se jen vyplní', [bez, potom.pass, potom.submit],
    ['vyplněno', 'tajne', false]);

  // Jméno se hledá podle polohy, ne podle názvu — každý portál ho pojmenuje jinak
  await page.setContent(`
    <!doctype html><meta charset="utf-8">
    <form><input type="search" id="hledani">
      <input type="email" id="mail"><input type="password" id="p">
      <input type="submit" value="Dál"></form>`);
  await page.evaluate(__test.fillScript('patrik@quentino.cz', 'tajne', false));
  check('jméno je políčko nad heslem, ne vyhledávání', await page.evaluate(() => ({
    mail: document.querySelector('#mail').value,
    hledani: document.querySelector('#hledani').value
  })), { mail: 'patrik@quentino.cz', hledani: '' });

  /*
   * PPL: tři políčka, a to prostřední je identifikace firmy.
   *
   * Přesné HTML z klientské administrace PPL (2608.0026). Dokud se jméno
   * hledalo jako „nejbližší textové políčko nad heslem", psalo se do
   * identifikace firmy — a přihlášení samozřejmě neprošlo.
   */
  await page.setContent(`
    <!doctype html><meta charset="utf-8">
    <form><table class="frm"><tbody>
      <tr><td><label for="u" id="ul">Uživatelské jméno:</label></td>
        <td><input name="ctl00$contentPH$EtiketyLogin1$UserName" type="text" id="u" class="UserName"></td></tr>
      <tr><td><label for="f" id="fl">Identifikace firmy:</label></td>
        <td><input name="ctl00$contentPH$EtiketyLogin1$FirId" type="text" id="f" class="FirId"></td></tr>
      <tr><td><label for="p" id="pl">Heslo:</label></td>
        <td><input name="ctl00$contentPH$EtiketyLogin1$Password" type="password" id="p" class="Password"></td></tr>
      <tr><td colspan="2"><a onclick="window.__odeslano = true;" id="log" class="button"
        href="javascript:void(0)">Přihlásit</a></td></tr>
    </tbody></table></form>`);
  await page.evaluate(() => { window.__odeslano = false; });
  const pplOut = await page.evaluate(__test.fillScript('patrik', 'tajne', true, '12345'));
  check('PPL: jméno, firma i heslo jdou každé do svého', [
    pplOut,
    await page.evaluate(() => document.querySelector('#u').value),
    await page.evaluate(() => document.querySelector('#f').value),
    await page.evaluate(() => document.querySelector('#p').value),
    await page.evaluate(() => window.__odeslano)
  ], ['odesláno', 'patrik', '12345', 'tajne', true]);

  /*
   * Bez identifikace firmy se formulář **neodesílá**. Poloprázdné
   * přihlášení u PPL stejně neprojde a jen by na obrazovce svítila chyba;
   * takhle zbývá jen doplnit jedno políčko.
   */
  await page.evaluate(() => {
    window.__odeslano = false;
    document.querySelector('#u').value = '';
    document.querySelector('#f').value = '';
  });
  const bezFirmy = await page.evaluate(__test.fillScript('patrik', 'tajne', true, ''));
  check('PPL bez identifikace firmy se jen vyplní', [
    bezFirmy, await page.evaluate(() => window.__odeslano)
  ], ['vyplněno', false]);

  // Bez formuláře se nemá co dělat — a hlavně se to má poznat
  await page.setContent('<!doctype html><meta charset="utf-8"><p>už přihlášen</p>');
  check('na stránce bez hesla se nic neděje',
    await page.evaluate(__test.fillScript('patrik', 'tajne', true)), 'bez formuláře');

  await browser.close();
  console.log(failed === 0 ? '\nvše sedí\n' : `\n${failed} nesedí\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
