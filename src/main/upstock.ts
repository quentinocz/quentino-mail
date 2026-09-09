import { BrowserWindow } from 'electron';
import { getSetting } from './db';
import { decrypt } from './secure';
import { getUpgatesConfig } from './upgates';
import { planOf, markSent } from './stockin';
import { StockinPlanRow, SkippedRow } from '../shared/types';
import { openUrl } from './formfile';
import { signIn, keepSignedIn } from './portallogin';

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

/**
 * Skript v okně administrace — vždycky s koncem.
 *
 * `executeJavaScript` nad zavřeným oknem se nemusí nikdy vrátit, a tím se
 * zaseklo celé odesílání: uživatel zavřel okno, aby to po chybě zkusil
 * znovu, a tlačítko zůstalo viset na „Vkládám…" napořád. Proto se každé
 * volání závodí se zavřením okna a s časovým stropem — po nich se vrací
 * `null` a odesílání se ukončí normální cestou.
 */
async function runIn(win: BrowserWindow, code: string, timeoutMs = 10_000): Promise<unknown> {
  if (win.isDestroyed()) return null;
  let timer: NodeJS.Timeout | undefined;
  let onClosed: (() => void) | undefined;
  try {
    return await Promise.race([
      win.webContents.executeJavaScript(code, true).catch(() => null),
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); }),
      new Promise<null>(resolve => {
        // Zkušební okno v testu posluchače nemá — a nemusí, jen se nečeká
        if (typeof win.once !== 'function') return;
        onClosed = () => resolve(null);
        win.once('closed', onClosed);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onClosed && !win.isDestroyed() && typeof win.removeListener === 'function') {
      win.removeListener('closed', onClosed);
    }
  }
}


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
  /*
   * Přihlášení se vyplní samo, když je uložené — a i pak, když sezení vyprší
   * uprostřed práce. Bez toho se u regálu opisovalo heslo z papírku.
   */
  keepSignedIn(win, 'upgates');
  if (!win.webContents.getURL().startsWith(url)) await openUrl(win, url);
  win.show();
  win.focus();
  await signIn(win, 'upgates');

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

  let closed = false;
  for (const row of rows) {
    if (win.isDestroyed()) { closed = true; break; }
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
      const found = await optionSetFor(win, row);
      optionSet = found.value;
      if (!optionSet) {
        /*
         * Proč se nenašla. Samotné „nenašla se" se nedalo opravit —
         * teď je v důvodu vidět, co administrace nabídla, takže je poznat,
         * jestli neposlala nic, nebo jen jinak pojmenované řádky.
         */
        skipped.push({
          ...row,
          reason: found.seen.length
            ? `varianta „${row.label || row.code}" se v administraci nenašla `
              + `(nabízí: ${found.seen.slice(0, 4).join(' | ')})`
            : 'administrace k tomuhle zboží žádné varianty nevrátila'
        });
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
  /*
   * Okno se mezitím zavřelo. Zbylé řádky se neztratí do ticha — je vidět,
   * že na ně nedošlo, a dá se to spustit znovu.
   */
  if (closed || win.isDestroyed()) {
    const done = new Set(skipped.map(one => one.code));
    for (const row of rows.slice(added + skipped.length)) {
      if (!done.has(row.code)) skipped.push({ ...row, reason: 'okno administrace se zavřelo' });
    }
  }
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
  return await runIn(win, `
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
  `, 20_000) === true;
}

/**
 * Číslo sady voleb pro variantu — vytažené z administrace, ne z feedu.
 *
 * Ve feedu má varianta `VARIANT_ID`, administrace pracuje s číslem „sady
 * voleb" (`option_set_id`) a jsou to dvě různé věci. Společný mají jen kód
 * varianty a popisek, takže se vytáhne seznam z administrace a hledá se
 * v něm. Když nesedí nic jednoznačně, **nevrací se nic** — uhodnout, která
 * varianta to je, znamená naskladnit cizí velikost.
 *
 * ## Proč se čte z odpovědi, a ne ze stránky
 *
 * První verze četla `$('#optionSetDialog tbody tr')` hned po `$.nette.success`.
 * Jenže Nette snippety překreslí a jQuery UI dialog otevře **až v dalším
 * kole smyčky událostí** — v tu chvíli na stránce žádné řádky nejsou a
 * varianta se „nenašla". Odpověď serveru je přitom celá k dispozici hned:
 * v `payload.snippets` je HTML dialogu, tak se čte z ní.
 *
 * ## Proč se vrací i to, co se našlo
 *
 * Když se varianta nenajde, „nenašla se" nestačí — nedá se z toho poznat,
 * jestli administrace neposlala nic, nebo poslala tři řádky, které se jen
 * jinak jmenují. Vrací se proto i **výpis řádků**, který skončí v důvodu
 * u přeskočené položky. Bez toho se ta chyba nedala opravit jinak než
 * hádáním.
 *
 * ## Jak se porovnává
 *
 * Text se srovná bez diakritiky, bez mezer a bez jednotek: „Délka: 120 cm"
 * a „120cm" je totéž. Kromě celého kódu a popisku se zkusí i **samotné
 * číslo** z popisku — velikost je to jediné, co v obou seznamech spolehlivě
 * je.
 */
async function optionSetFor(
  win: BrowserWindow, row: StockinPlanRow
): Promise<{ value: string | null; seen: string[] }> {
  const found = await runIn(win, `
    (function () {
      return new Promise(function (done) {
        if (typeof $ === 'undefined') { done({ value: '', seen: [] }); return; }

        /* Bez diakritiky, bez mezer, bez jednotek — „Délka: 120 cm" = „120cm" */
        function norm(text) {
          return String(text || '')
            .toLowerCase()
            .normalize('NFD').replace(/[\\u0300-\\u036f]/g, '')
            .replace(/\\s+/g, '')
            .replace(/[.,;:()\\[\\]]/g, '');
        }

        var code = norm(${JSON.stringify(row.code)});
        var label = norm(${JSON.stringify(row.label ?? '')});
        /* Číslo z popisku — velikost je to jediné, co mají obě strany jistě */
        var digits = (${JSON.stringify(row.label ?? '')}.match(/\\d+/) || [''])[0];

        /* Řádky z libovolného kusu HTML: hodnota je v inputu, nebo v data- */
        function rowsFrom(root) {
          var out = [];
          root.querySelectorAll('tr, li, .option-set, [data-option-set-id]').forEach(function (el) {
            var input = el.querySelector && el.querySelector('input[value]');
            var value = (input && input.getAttribute('value'))
              || el.getAttribute('data-option-set-id')
              || el.getAttribute('data-id')
              || '';
            var text = (el.textContent || '').replace(/\\s+/g, ' ').trim();
            if (value && text) out.push({ value: String(value), text: text, key: norm(text) });
          });
          return out;
        }

        function fromHtml(html) {
          var box = document.createElement('div');
          box.innerHTML = html;
          return rowsFrom(box);
        }

        function pick(rows) {
          function hits(test) {
            var found = [];
            rows.forEach(function (one) { if (test(one)) found.push(one.value); });
            return found;
          }
          var tries = [];
          if (code) tries.push(function (one) { return one.key.indexOf(code) >= 0; });
          if (label) tries.push(function (one) { return one.key.indexOf(label) >= 0; });
          if (digits) tries.push(function (one) { return one.key.indexOf(norm(digits)) >= 0; });
          for (var i = 0; i < tries.length; i++) {
            var found = hits(tries[i]);
            // Víc shod znamená, že se to nedá rozhodnout — zkusí se další klíč
            if (found.length === 1) return found[0];
          }
          return '';
        }

        function finish(value, rows) {
          try { $('#optionSetDialog').dialog('close'); } catch (e) { /* nemusí být otevřený */ }
          try { $('.ui-dialog-content').dialog('close'); } catch (e) { /* ani tenhle */ }
          done({ value: value, seen: (rows || []).slice(0, 8).map(function (one) { return one.text; }) });
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

            var rows = html ? fromHtml(html) : [];
            var chosen = pick(rows);
            if (chosen) { finish(chosen, rows); return; }

            /*
             * Náhradní cesta přes stránku. Nette snippet překreslí a dialog
             * otevře až v dalším kole smyčky událostí, takže se čeká — do
             * dvou vteřin, po stovkách milisekund.
             */
            try { $.nette.success(payload); } catch (e) { /* jen překreslení */ }
            var tries = 0;
            var timer = setInterval(function () {
              var page = rowsFrom(document);
              var value = pick(page);
              if (value || ++tries >= 20) {
                clearInterval(timer);
                finish(value, page.length ? page : rows);
              }
            }, 100);
          },
          error: function (xhr) {
            finish('', [{ text: 'administrace odpověděla chybou ' + (xhr && xhr.status) }]);
          }
        });
      });
    })()
  `, 15_000);
  const value = String((found as any)?.value ?? '');
  const seen = Array.isArray((found as any)?.seen) ? (found as any).seen.map(String) : [];
  return { value: value || null, seen };
}

/** Kolik řádků má seznam položek — podle toho se pozná, že další opravdu přibyl. */
async function gridCount(win: BrowserWindow): Promise<number> {
  const value = await runIn(win, `
    (function () {
      var grid = document.querySelector('#grid-productsBulkOperationsGrid');
      var count = grid && grid.getAttribute('data-data_count');
      if (count !== null && count !== undefined && count !== '') return Number(count);
      return document.querySelectorAll('#snippet-productsBulkOperationsGrid-rows tbody tr').length;
    })()
  `, 8_000);
  return Number(value) || 0;
}

/** Počká, až v okně bude stránka naskladňování (uživatel se mezitím přihlásí). */
async function waitForStocking(win: BrowserWindow, timeoutMs = 5 * 60_000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (win.isDestroyed()) return false;
    const hasForm = await runIn(
      win, "!!document.querySelector('#search-product') && typeof $ !== 'undefined'", 8_000
    );
    if (hasForm === true) return true;
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
