import { BrowserWindow } from 'electron';
import { getSetting } from './db';
import { decrypt } from './secure';
import { getUpgatesConfig } from './upgates';
import { planOf, markSent } from './stockin';
import { StockinPlanRow, SkippedRow } from '../shared/types';

/**
 * Zápis naskladnění do Upgates.
 *
 * Dvě cesty, obě mířící na totéž místo:
 *
 *  1. **Přes okno administrace** (výchozí, funguje hned). Aplikace otevře
 *     vlastní okno se stránkou Sklad → Naskladňování, kde je uživatel
 *     přihlášený, a položky do ní přidá **jejím vlastním voláním**
 *     `addOperationStockingUp` — tedy přesně tím, co by se stalo klikáním.
 *     Nic se neobchází a nic se nepředstírá; uspoří se jen ruční ťukání.
 *     Poslední krok — uložení — zůstává na člověku: nevratná věc má být
 *     stisknutá, ne odhadnutá.
 *
 *  2. **Přes API** (když to klíč dovolí). Rychlejší a bez okna, ale závisí
 *     na oprávnění API uživatele. Proto se nejdřív zeptáme, co API dovolí,
 *     a teprve pak nabídneme.
 *
 * Proč vůbec dvě: e-shop je cizí systém a nejde spoléhat na to, že bude
 * pořád stejný. Když se rozbije jedna cesta, druhá funguje dál.
 */

const STOCKING_PATH = '/manager/products/default/stocking/';

function emit(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload);
}

/* ---------- cesta 1: okno administrace ---------- */

let sending: BrowserWindow | null = null;

/**
 * Otevře okno s naskladňováním a nasype do něj položky.
 *
 * Okno má vlastní trvalé sezení (`persist:upgates`), takže přihlášení platí
 * i příště — jinak by se člověk hlásil při každé naskladnění znovu.
 */
export async function sendViaWindow(sessionId: string):
  Promise<{ added: number; skipped: SkippedRow[]; needsLogin: boolean }> {
  const cfg = getUpgatesConfig();
  if (!cfg.url) throw new Error('Není vyplněná adresa administrace (Nastavení → AI → Upgates).');

  const rows = planOf(sessionId);
  if (rows.length === 0) throw new Error('Naskladnění je prázdné.');

  const win = sending && !sending.isDestroyed() ? sending : new BrowserWindow({
    width: 1200,
    height: 860,
    title: 'Naskladnění v Upgates',
    webPreferences: { partition: 'persist:upgates', sandbox: true }
  });
  sending = win;
  win.on('closed', () => { sending = null; });

  const url = `${cfg.url}${STOCKING_PATH}`;
  if (!win.webContents.getURL().startsWith(url)) await win.loadURL(url);
  win.show();
  win.focus();

  /*
   * Čekání na přihlášení.
   *
   * Do administrace se hlásí člověk, ne aplikace — heslo aplikace nikde
   * nedrží a držet nemá. Když okno skončí na přihlašovací stránce, počká se,
   * až se uživatel přihlásí a stránka naskladňování se objeví.
   */
  const ready = await waitForStocking(win);
  if (!ready) {
    return {
      added: 0,
      skipped: rows.map(one => ({ ...one, reason: 'nepřihlášeno' })),
      needsLogin: true
    };
  }

  let added = 0;
  /*
   * U nedodělaných řádků se vede i důvod. Bez něj byla jediná zpětná vazba
   * „3 se nepodařilo" a nedalo se poznat, jestli chybí číslo z feedu, nebo
   * se nenašla varianta — a to jsou dvě úplně jiné opravy.
   */
  const skipped: SkippedRow[] = [];

  for (const row of rows) {
    if (win.isDestroyed()) break;
    if (!row.productId) { skipped.push({ ...row, reason: 'chybí ve feedu' }); continue; }

    emit('stockin:progress', { done: added + skipped.length, total: rows.length, code: row.code });

    /*
     * Varianta: číslo z feedu tady neplatí.
     *
     * Ve feedu má varianta `VARIANT_ID`, administrace ale pracuje s číslem
     * „sady voleb" (`option_set_id`) a jsou to dvě různé věci. Proto se
     * seznam variant vytáhne ze samotné administrace (`getVariants`) a
     * varianta se v něm najde podle kódu — podle toho jediného, co mají obě
     * strany společné.
     */
    let optionSet: string | null = null;
    if (row.variantId || row.label) {
      optionSet = await optionSetFor(win, row);
      if (!optionSet) {
        skipped.push({ ...row, reason: 'varianta se v administraci nenašla' });
        continue;
      }
    }

    const before = await gridCount(win);
    const ok = await addOne(win, row, optionSet);
    const after = await gridCount(win);

    // Za přidané se počítá jen to, o co se seznam v administraci opravdu
    // rozrostl. „HTTP 200" ještě neznamená, že tam řádek přibyl.
    if (ok && after > before) added++;
    else skipped.push({ ...row, reason: ok ? 'formulář řádek nepřidal' : 'zápis do formuláře selhal' });
  }

  emit('stockin:progress', { done: rows.length, total: rows.length, code: '' });
  return { added, skipped, needsLogin: false };
}

/**
 * Jedna položka do formuláře — přesně tím, co dělá stránka sama.
 *
 * Nejdřív `getProductForStocking`, který produkt načte a **vrátí platné
 * `option_set_id`**, a teprve pak `addOperationStockingUp`. První verze
 * volala jen to druhé, a rovnou s číslem varianty z feedu: okno se otevřelo,
 * ale do formuláře nepřibylo nic.
 *
 * Počet se nepředává jen parametrem — stránka ho čte z vlastního políčka
 * `#product_preview_count`, takže se vyplní obojí.
 */
async function addOne(win: BrowserWindow, row: StockinPlanRow, optionSet: string | null): Promise<boolean> {
  return win.webContents.executeJavaScript(`
    (function () {
      return new Promise(function (done) {
        if (typeof $ === 'undefined') { done(false); return; }
        var base = ${JSON.stringify(STOCKING_PATH)};
        var productId = ${JSON.stringify(row.productId)};
        var optionSet = ${JSON.stringify(optionSet ?? '')};
        var quantity = ${JSON.stringify(String(row.qty))};

        try { $('#product_preview_count').val(quantity); } catch (e) { /* políčko nemusí být */ }

        $.ajax({
          url: base + '?do=getProductForStocking',
          data: { product_id: productId, option_set_id: optionSet },
          success: function (payload) {
            try { $.nette.success(payload); } catch (e) { /* jen překreslení */ }
            var resolved = (payload && payload.option_set_id != null) ? payload.option_set_id : optionSet;
            /*
             * Produkt má varianty, ale nevíme kterou. Stránka by na tomhle
             * místě otevřela dialog „Vyberte variantu produktu" — a hádat za
             * člověka znamená naskladnit cizí velikost. Radši se nepřidá nic
             * a řádek se vrátí jako nedodělaný.
             */
            if (payload && payload.option_set_yn && !(Number(resolved) > 0)) { done(false); return; }
            $.ajax({
              url: base + '?do=addOperationStockingUp',
              data: { product_id: productId, option_set_id: resolved, quantity: quantity },
              success: function (second) {
                try { $.nette.success(second); } catch (e) {}
                try { $('body').trigger('datagridAjaxCompleteInit', ['productsBulkOperationsGrid']); } catch (e) {}
                done(true);
              },
              error: function () { done(false); }
            });
          },
          error: function () { done(false); }
        });
      });
    })()
  `, true).catch(() => false);
}

/**
 * Číslo sady voleb pro variantu — vytažené z administrace, ne z feedu.
 *
 * Ve feedu má varianta `VARIANT_ID`, administrace pracuje s číslem „sady
 * voleb" (`option_set_id`) a jsou to dvě různé věci. Společný mají jen kód
 * varianty, takže se vytáhne seznam z administrace a hledá se v něm podle
 * kódu; když ten nesedí, tak podle popisku („Délka: 120cm"). Když nesedí nic
 * jednoznačně, **nevrací se nic** — uhodnout, která varianta to je, znamená
 * naskladnit cizí velikost.
 *
 * ## Proč se čte z odpovědi, a ne ze stránky
 *
 * První verze četla `$('#optionSetDialog tbody tr')` hned po `$.nette.success`.
 * Jenže Nette snippety překreslí a jQuery UI dialog otevře **až v dalším
 * kole smyčky událostí** — v tu chvíli na stránce žádné řádky nejsou a
 * varianta se „nenašla". Produkty s variantami se proto do formuláře
 * nepřidaly vůbec, kdežto ty bez variant ano; vypadalo to jako náhoda.
 *
 * Odpověď serveru je přitom celá k dispozici hned: v `payload.snippets` je
 * HTML dialogu. Čte se tedy z ní, a na stránku se sáhne až jako na náhradní
 * řešení — a to s čekáním, ne naslepo.
 */
async function optionSetFor(win: BrowserWindow, row: StockinPlanRow): Promise<string | null> {
  const found = await win.webContents.executeJavaScript(`
    (function () {
      return new Promise(function (done) {
        if (typeof $ === 'undefined') { done(''); return; }

        var code = ${JSON.stringify(row.code)}.toLowerCase();
        var label = ${JSON.stringify(row.label ?? '')}.toLowerCase();

        /* Řádky z libovolného kusu HTML — hledá se input s hodnotou a text řádku */
        function rowsFrom(html) {
          var box = document.createElement('div');
          box.innerHTML = html;
          var out = [];
          box.querySelectorAll('tr').forEach(function (tr) {
            var input = tr.querySelector('input[value]');
            var value = input && input.getAttribute('value');
            if (value) out.push({ value: String(value), text: (tr.textContent || '').toLowerCase() });
          });
          return out;
        }

        /* Totéž ze stránky — až když v odpovědi nic není */
        function rowsFromPage() {
          var out = [];
          document.querySelectorAll(
            '#optionSetDialog tr, [id*="optionSet"] tr, .ui-dialog:visible tr'
          ).forEach(function (tr) {
            var input = tr.querySelector('input[value]');
            var value = input && input.getAttribute('value');
            if (value) out.push({ value: String(value), text: (tr.textContent || '').toLowerCase() });
          });
          return out;
        }

        function pick(rows) {
          var byCode = [], byLabel = [];
          rows.forEach(function (one) {
            if (code && one.text.indexOf(code) >= 0) byCode.push(one.value);
            else if (label && one.text.indexOf(label) >= 0) byLabel.push(one.value);
          });
          var hits = byCode.length ? byCode : byLabel;
          // Víc shod znamená, že se to nedá rozhodnout — radši nic
          return hits.length === 1 ? hits[0] : '';
        }

        function finish(value) {
          try { $('#optionSetDialog').dialog('close'); } catch (e) { /* nemusí být otevřený */ }
          try { $('.ui-dialog-content').dialog('close'); } catch (e) { /* ani tenhle */ }
          done(value);
        }

        $.ajax({
          url: ${JSON.stringify(STOCKING_PATH)} + '?do=getVariants',
          data: { product_id: ${JSON.stringify(row.productId)} },
          type: 'get',
          success: function (payload) {
            /*
             * Z odpovědi. Snippety jsou objekt { id: html }; projdou se
             * všechny, protože jméno snippetu se mezi verzemi administrace
             * liší, kdežto tvar řádků ne.
             */
            var html = '';
            if (payload && payload.snippets) {
              Object.keys(payload.snippets).forEach(function (key) {
                var part = payload.snippets[key];
                if (typeof part === 'string') html += part;
              });
            }
            if (typeof payload === 'string') html += payload;

            var chosen = html ? pick(rowsFrom(html)) : '';
            if (chosen) { finish(chosen); return; }

            /*
             * Náhradní cesta přes stránku. Nette snippet překreslí a dialog
             * otevře až v dalším kole smyčky událostí, takže se čeká — do
             * dvou vteřin, po stovkách milisekund.
             */
            try { $.nette.success(payload); } catch (e) { /* jen překreslení */ }
            var tries = 0;
            var timer = setInterval(function () {
              var value = pick(rowsFromPage());
              if (value || ++tries >= 20) {
                clearInterval(timer);
                finish(value);
              }
            }, 100);
          },
          error: function () { finish(''); }
        });
      });
    })()
  `, true).catch(() => '');
  return found ? String(found) : null;
}

/** Kolik řádků má seznam položek — podle toho se pozná, že další opravdu přibyl. */
async function gridCount(win: BrowserWindow): Promise<number> {
  const value = await win.webContents.executeJavaScript(`
    (function () {
      var grid = document.querySelector('#grid-productsBulkOperationsGrid');
      var count = grid && grid.getAttribute('data-data_count');
      if (count !== null && count !== undefined && count !== '') return Number(count);
      return document.querySelectorAll('#snippet-productsBulkOperationsGrid-rows tbody tr').length;
    })()
  `, true).catch(() => 0);
  return Number(value) || 0;
}

/** Počká, až v okně bude stránka naskladňování (uživatel se mezitím přihlásí). */
async function waitForStocking(win: BrowserWindow, timeoutMs = 5 * 60_000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (win.isDestroyed()) return false;
    const hasForm = await win.webContents.executeJavaScript(
      "!!document.querySelector('#search-product') && typeof $ !== 'undefined'", true
    ).catch(() => false);
    if (hasForm) return true;
    await new Promise(resolve => setTimeout(resolve, 800));
  }
  return false;
}

/** Uzavře naskladnění — volá se, až uživatel v Upgates uložení potvrdí. */
export function confirmSent(sessionId: string): void {
  markSent(sessionId);
  emit('stockin:changed', {});
}

/* ---------- cesta 2: API ---------- */

export interface ApiService {
  name: string;
  privilege: string;
}

/**
 * Co API dovolí.
 *
 * `/api/v2/status` vrací seznam služeb i s oprávněním. Aplikace ho dosud jen
 * počítala („povolených endpointů: 12"), což se hodí na test spojení, ale
 * neodpoví na jedinou otázku, která u naskladnění rozhoduje: **smí tenhle
 * klíč zapisovat produkty?**
 */
export async function apiServices(): Promise<ApiService[]> {
  const cfg = getUpgatesConfig();
  const key = getSetting('upgatesKey');
  if (!cfg.url || !cfg.login || !key) throw new Error('Upgates API není nastaveno.');
  const auth = Buffer.from(`${cfg.login}:${decrypt(key)}`).toString('base64');
  const res = await fetch(`${cfg.url}/api/v2/status`, {
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' }
  });
  if (!res.ok) throw new Error(`Upgates API: HTTP ${res.status}`);
  const data: any = await res.json();
  return (data?.services ?? []).map((s: any) => ({
    name: String(s?.name ?? s?.service ?? ''),
    privilege: String(s?.privilege ?? '')
  })).filter((s: ApiService) => s.name);
}

/** Umí API zapisovat produkty? Podle toho se nabízí rychlá cesta. */
export async function apiCanWriteStock(): Promise<{ can: boolean; detail: string }> {
  try {
    const services = await apiServices();
    const products = services.find(s => /product/i.test(s.name));
    if (!products) {
      return { can: false, detail: 'API o produktech nic nevrací — zápis skladu přes něj nepůjde.' };
    }
    const can = /write|edit|full|rw/i.test(products.privilege);
    return {
      can,
      detail: can
        ? `API smí zapisovat produkty (${products.name}: ${products.privilege}).`
        : `API má u produktů jen „${products.privilege}" — na zápis skladu to nestačí.`
        + ' Práva se dají zvednout v Upgates u API uživatele.'
    };
  } catch (e: any) {
    return { can: false, detail: e?.message ?? String(e) };
  }
}

/**
 * Zápis skladu přes API.
 *
 * Připraveno, ale úmyslně opatrné: posílá se **nová hodnota zásoby**
 * spočítaná z toho, co je teď ve feedu, plus přijaté kusy. Když API zápis
 * odmítne, nic se nepředstírá — vrátí se chyba a zůstane cesta oknem.
 */
export async function sendViaApi(sessionId: string):
  Promise<{ written: number; failed: { code: string; error: string }[] }> {
  const cfg = getUpgatesConfig();
  const key = getSetting('upgatesKey');
  if (!cfg.url || !cfg.login || !key) throw new Error('Upgates API není nastaveno.');
  const auth = Buffer.from(`${cfg.login}:${decrypt(key)}`).toString('base64');

  const rows = planOf(sessionId);
  const failed: { code: string; error: string }[] = [];
  let written = 0;

  for (const row of rows) {
    const base = row.stockNow ?? row.stockBefore ?? 0;
    const body = {
      products: [row.variantId
        ? { code: row.code, variants: [{ code: row.code, stock: base + row.qty }] }
        : { code: row.code, stock: base + row.qty }]
    };
    try {
      const res = await fetch(`${cfg.url}/api/v2/products`, {
        method: 'PUT',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      written++;
    } catch (e: any) {
      failed.push({ code: row.code, error: e?.message ?? String(e) });
    }
    emit('stockin:progress', { done: written + failed.length, total: rows.length, code: row.code });
  }

  if (written > 0 && failed.length === 0) confirmSent(sessionId);
  return { written, failed };
}

/**
 * Vstup pro zkoušku.
 *
 * Vkládání do administrace se bez přihlášeného e-shopu vyzkoušet nedá, ale
 * to, co se do okna posílá, ano — a přesně tam byla chyba, kvůli které se
 * formulář neplnil. Zkouška si proto sáhne na jednotlivé kroky.
 */
export const __test = { addOne, optionSetFor, gridCount };
