import { BrowserWindow } from 'electron';
import { getSetting } from './db';
import { decrypt } from './secure';
import { getUpgatesConfig } from './upgates';
import { planOf, markSent } from './stockin';
import { StockinPlanRow } from '../shared/types';

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
  Promise<{ added: number; skipped: StockinPlanRow[]; needsLogin: boolean }> {
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
  if (!ready) return { added: 0, skipped: rows, needsLogin: true };

  let added = 0;
  const skipped: StockinPlanRow[] = [];

  for (const row of rows) {
    if (win.isDestroyed()) break;
    if (!row.productId) { skipped.push(row); continue; }

    emit('stockin:progress', { done: added + skipped.length, total: rows.length, code: row.code });

    const ok = await win.webContents.executeJavaScript(`
      (function () {
        // Voláme to, co volá sama stránka po výběru z našeptávače
        return new Promise(function (done) {
          if (typeof $ === 'undefined') { done(false); return; }
          $.ajax({
            url: ${JSON.stringify(STOCKING_PATH)} + '?do=addOperationStockingUp',
            data: {
              product_id: ${JSON.stringify(row.productId)},
              option_set_id: ${JSON.stringify(row.variantId || '')},
              quantity: ${JSON.stringify(String(row.qty))}
            },
            success: function (payload) {
              try { $.nette.success(payload); } catch (e) { /* jen překreslení */ }
              try { $('body').trigger('datagridAjaxCompleteInit', ['productsBulkOperationsGrid']); } catch (e) {}
              done(true);
            },
            error: function () { done(false); }
          });
        });
      })()
    `, true).catch(() => false);

    if (ok) added++;
    else skipped.push(row);
  }

  emit('stockin:progress', { done: rows.length, total: rows.length, code: '' });
  return { added, skipped, needsLogin: false };
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
