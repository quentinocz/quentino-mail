import { BrowserWindow } from 'electron';
import type { WebFrameMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Vložení souboru do formuláře v okně administrace dopravce.
 *
 * `input.value` se ze skriptu nastavit nedá a je to tak správně — kdyby šlo,
 * uměla by libovolná stránka nahrát cizí soubory. Používá se proto ladicí
 * rozhraní Chromia (`DOM.setFileInputFiles`), tedy tatáž cesta, jakou jde
 * výběr myší: prohlížeč pak sám pošle událost `change` a stránka o souboru
 * ví, ať je psaná v čemkoli.
 *
 * ## Proč se políčko hledá, a ne adresuje
 *
 * U PPL je administrace starý ASP.NET formulář a políčko má stálé `id`.
 * Podání Online České pošty je aplikace psaná v Angularu: `id` se generují
 * za běhu a po každé verzi jsou jiná. Napevno zapsaný výběr by tedy vydržel
 * do nejbližší jejich úpravy a chyba by vypadala jako „soubor nejde vložit".
 *
 * Hledá se proto **první políčko na soubor, které na stránce je** — na
 * stránce importu je právě jedno. Známé `id` se použije jako vodítko, když
 * na stránce je; jinak rozhodne pořadí. A hlavně se čeká: uživatel se
 * mezitím přihlašuje a proklikává k importu, takže políčko se objeví až za
 * chvíli.
 */

/**
 * Otevření adresy, které nespadne na přesměrování.
 *
 * `loadURL` vrací chybu `ERR_ABORTED (-3)` pokaždé, když stránka během
 * načítání sama pošle prohlížeč jinam — a přesně to dělá přihlášení přes
 * SSO: Podání Online odskočí na `amex.postaonline.cz/cas/oidc/authorize`.
 * Není to chyba, je to normální průběh; jenže nezachycená výjimka utla celé
 * volání a okno pak jen viselo. Chyby přesměrování se tedy přeskakují,
 * ostatní se hlásí dál.
 */
export async function openUrl(win: BrowserWindow, url: string): Promise<void> {
  try {
    await win.webContents.loadURL(url);
  } catch (e: any) {
    const code = Number(e?.errno ?? e?.code ?? 0);
    const text = String(e?.message ?? e);
    // -3 ERR_ABORTED, -2 ERR_FAILED při odskoku na přihlášení
    if (code === -3 || /ERR_ABORTED|ERR_FAILED/.test(text)) return;
    throw e;
  }
}

/** Značka, kterou si políčko označíme — přes ni ho pak najde ladicí rozhraní. */
const MARK = 'data-quentino-file';

/**
 * Skript do okna: najde políčko na soubor a označí ho.
 *
 * Vrací `true`, když nějaké našel. Skryté políčko se přeskakuje — stránky
 * jich mívají víc a to viditelné je to, do kterého by klikal člověk.
 */
function markScript(hint: string | string[]): string {
  const hints = (Array.isArray(hint) ? hint : [hint]).filter(Boolean);
  return `
    (function () {
      function usable(el) {
        if (!el || el.disabled) return false;
        /* Skryté políčko není to, do kterého by klikal člověk */
        var box = el.getBoundingClientRect();
        return box.width > 0 || box.height > 0 || el.offsetParent !== null;
      }
      var all = Array.prototype.slice.call(document.querySelectorAll('input[type=file]'));
      var hints = ${JSON.stringify(hints)};
      var found = null;
      /*
       * Vodítka se zkoušejí v pořadí. Na stránce produktu v administraci je
       * políček na soubor víc (obrázky, přílohy, varianty) a to viditelné
       * není ani jedno z nich — Dropzone si svoje schovává. Bez pořadí
       * vodítek by se fotky vložily k příloze.
       */
      for (var i = 0; i < hints.length && !found; i++) {
        var hit = document.querySelector(hints[i]);
        if (hit && all.indexOf(hit) >= 0) found = hit;
      }
      found = found || all.filter(usable)[0] || all[0];
      if (!found) return false;
      found.setAttribute(${JSON.stringify(MARK)}, '1');
      return true;
    })()
  `;
}

/**
 * Počká, až se políčko na soubor objeví.
 *
 * Čeká se dlouho schválně: mezi otevřením okna a stránkou importu je
 * přihlášení a pár kliknutí, což je u někoho deset vteřin a u někoho dvě
 * minuty. Zavření okna čekání ukončí — uživatel si to rozmyslel.
 */
export async function waitForFileInput(
  win: BrowserWindow, hint: string | string[] = '', timeoutMs = 3 * 60_000
): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  const script = markScript(hint);
  while (Date.now() < until) {
    if (win.isDestroyed()) return false;
    // Ve všech rámech: správce souborů Upgates je ve vnořeném rámu
    const all = await eachFrame<boolean>(win, script);
    if (all.some(one => one.value === true)) return true;
    await new Promise(resolve => setTimeout(resolve, 700));
  }
  return false;
}

/**
 * Vloží soubor do označeného políčka.
 *
 * Okno je naše vlastní, soubor jsme právě vytvořili a odeslání formuláře se
 * nedělá — to zůstává na člověku, protože podání zásilek je nevratné.
 */
export async function insertFile(win: BrowserWindow, file: string): Promise<void> {
  return insertFiles(win, [file]);
}

/**
 * Vloží víc souborů najednou.
 *
 * `DOM.setFileInputFiles` bere celý seznam, takže stránka dostane jednu
 * událost `change` se všemi soubory — přesně jako by je člověk vybral
 * v dialogu najednou. Po jednom by Dropzone u každého souboru začal nový
 * přenos a ten předchozí zahodil.
 */
export async function insertFiles(win: BrowserWindow, files: string[]): Promise<void> {
  const list = (files ?? []).filter(one => fs.existsSync(one));
  if (list.length === 0) throw new Error('soubor neexistuje');
  if (win.isDestroyed()) throw new Error('okno se zavřelo');

  const dbg = win.webContents.debugger;
  let attached = false;
  try {
    if (!dbg.isAttached()) { dbg.attach('1.3'); attached = true; }
    await dbg.sendCommand('DOM.enable');
    const doc: any = await dbg.sendCommand('DOM.getDocument', { depth: -1, pierce: true });
    const found: any = await dbg.sendCommand('DOM.querySelector', {
      nodeId: doc.root.nodeId,
      selector: `[${MARK}]`
    });
    let nodeId = found?.nodeId ?? 0;
    /*
     * `querySelector` prohledá jen ten jeden dokument. Políčko ve
     * vnořeném rámu (správce souborů Upgates) je proto pro něj neviditelné
     * — na to je hledání napříč dokumenty.
     */
    if (!nodeId) {
      const search: any = await dbg.sendCommand('DOM.performSearch', {
        query: `[${MARK}]`, includeUserAgentShadowDOM: true
      });
      if (search?.resultCount > 0) {
        const res: any = await dbg.sendCommand('DOM.getSearchResults', {
          searchId: search.searchId, fromIndex: 0, toIndex: 1
        });
        nodeId = res?.nodeIds?.[0] ?? 0;
      }
      if (search?.searchId) {
        try { await dbg.sendCommand('DOM.discardSearchResults', { searchId: search.searchId }); }
        catch { /* uklidí se se zavřením okna */ }
      }
    }
    if (!nodeId) throw new Error('políčko pro soubor se na stránce nenašlo');
    await dbg.sendCommand('DOM.setFileInputFiles', { nodeId, files: list });
  } finally {
    if (attached && dbg.isAttached()) { try { dbg.detach(); } catch { /* okno se mohlo zavřít */ } }
  }
}

/**
 * Celá cesta: počkat na políčko a vložit do něj soubor.
 *
 * Vrací i adresu, na které se to povedlo — z ní se dá příště otevřít rovnou
 * ta správná stránka, místo aby se k ní uživatel proklikával znovu.
 */
export async function fillFileInput(
  win: BrowserWindow, file: string, hint: string | string[] = '', timeoutMs = 3 * 60_000
): Promise<{ filled: boolean; url: string; note: string }> {
  const ready = await waitForFileInput(win, hint, timeoutMs);
  if (!ready) {
    return {
      filled: false,
      url: '',
      note: `Políčko pro soubor se neobjevilo. Soubor je uložený v ${file} — vyber ho v okně ručně.`
    };
  }
  const url = win.isDestroyed() ? '' : win.webContents.getURL();
  try {
    await insertFile(win, file);
    return { filled: true, url, note: 'Soubor je vložený. Zkontroluj nastavení importu a potvrď ho.' };
  } catch (e: any) {
    return {
      filled: false,
      url,
      note: `Soubor se nepodařilo vložit (${String(e?.message ?? e)}). Je uložený v ${file} — vyber ho ručně.`
    };
  }
}

/* ==================== vložení souboru bez políčka ==================== */

/**
 * Rámce stránky, hlavní i vnořené.
 *
 * Správce souborů Upgates běží ve **vnořeném rámu**, takže
 * `document.querySelectorAll` v hlavním dokumentu nenajde ani políčko na
 * soubor, ani dlaždice s adresami — a nahrávání pak končilo hláškou
 * „políčko se ve správci souborů neobjevilo", i když na obrazovce bylo
 * vidět všechno. Hledá se proto ve všech rámech.
 */
export function framesOf(win: BrowserWindow): WebFrameMain[] {
  if (win.isDestroyed()) return [];
  try {
    const root = win.webContents.mainFrame;
    return [root, ...root.framesInSubtree].filter((one, i, all) => all.indexOf(one) === i);
  } catch {
    return [];
  }
}

/** Spustí skript ve všech rámech; vrátí dvojice rám + výsledek. */
export async function eachFrame<T>(win: BrowserWindow, script: string): Promise<{ frame: WebFrameMain; value: T }[]> {
  const out: { frame: WebFrameMain; value: T }[] = [];
  for (const frame of framesOf(win)) {
    try {
      if (frame.detached) continue;
      const value = await frame.executeJavaScript(script, true) as T;
      out.push({ frame, value });
    } catch { /* rám se mezitím přenačetl nebo je z cizí domény */ }
  }
  return out;
}

/** Co v tom kterém rámu je, aby se soubory vkládaly tam, kde je nahrávání. */
const PROBE = `
  (function () {
    var dz = 0;
    try {
      dz = ((window.Dropzone && window.Dropzone.instances) || []).filter(function (one) {
        return one && one.element && one.element.isConnected;
      }).length;
    } catch (e) { dz = 0; }
    var plocha = document.querySelector('.dropzone, .dz-clickable, [class*="dropzone"]') ? 1 : 0;
    return { dz: dz, drop: plocha, input: document.querySelectorAll('input[type=file]').length };
  })()
`;

export interface DropSpot { dz: number; drop: number; input: number }

const usable = (one: DropSpot | null | undefined) =>
  !!one && (one.dz > 0 || one.drop > 0 || one.input > 0);

/** Je kam soubory vložit? Vrací rám, kde to je. */
export async function findDropSpot(win: BrowserWindow): Promise<WebFrameMain | null> {
  const all = await eachFrame<DropSpot>(win, PROBE);
  // Dropzone má přednost před holým políčkem — ten soubor rovnou odešle
  const best = all.filter(one => usable(one.value))
    .sort((a, b) => (b.value.dz - a.value.dz) || (b.value.drop - a.value.drop))[0];
  return best?.frame ?? null;
}

/**
 * Co se v rámech stránky našlo, jednou větou.
 *
 * Když se nahrání nepovede, je tohle to jediné, co k tomu jde z dálky
 * zjistit — bez toho zní hláška „nešlo to" stejně u iframu z cizí domény
 * jako u přejmenovaného tlačítka.
 */
export async function describeDropSpots(win: BrowserWindow): Promise<string> {
  const all = await eachFrame<DropSpot>(win, PROBE);
  if (all.length === 0) return 'stránka nevrátila ani jeden rám';
  return all
    .map((one, i) => `rám ${i + 1}: dropzone ${one.value?.dz ?? 0},`
      + ` plocha ${one.value?.drop ?? 0}, políček ${one.value?.input ?? 0}`)
    .join('; ');
}

/** Počká, až se objeví místo, kam jde soubor vložit. */
export async function waitForDropSpot(win: BrowserWindow, timeoutMs = 12_000): Promise<WebFrameMain | null> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (win.isDestroyed()) return null;
    const spot = await findDropSpot(win);
    if (spot) return spot;
    if (Date.now() >= until) return null;
    await new Promise(resolve => setTimeout(resolve, 700));
  }
}

/**
 * Skript, který soubory vloží do stránky.
 *
 * Soubory cestují jako base64 **v textu skriptu**: prohlížeč stránce
 * nedovolí sáhnout si na disk a je to tak správně, takže se obsah pošle
 * s sebou a `File` se složí až uvnitř.
 *
 * Zkouší se tři cesty od nejspolehlivější:
 * 1. `Dropzone.addFile` — správce souborů Upgates na Dropzonu stojí a
 *    tohle je přesně to, co dělá jeho vlastní dialog;
 * 2. přetažení: uměle poslaná událost `drop` s přenosem souborů — pro
 *    případ, že instance Dropzonu není vidět v `window`;
 * 3. políčko na soubor: `input.files` se z `DataTransfer` nastavit **dá**
 *    (zakázané je jen `value`), takže není potřeba ladicí rozhraní.
 */
function dropScript(payload: { name: string; type: string; b64: string }[]): string {
  return `
    (function () {
      var data = ${JSON.stringify(payload)};
      var soubory = data.map(function (one) {
        var text = atob(one.b64);
        var pole = new Uint8Array(text.length);
        for (var i = 0; i < text.length; i++) pole[i] = text.charCodeAt(i);
        return new File([pole], one.name, { type: one.type });
      });

      var instance = [];
      try {
        instance = ((window.Dropzone && window.Dropzone.instances) || []).filter(function (one) {
          return one && one.element && one.element.isConnected;
        });
      } catch (e) { instance = []; }
      if (instance.length > 0) {
        var kam = instance[0];
        soubory.forEach(function (one) { kam.addFile(one); });
        /* Některé instance mají frontu vypnutou a čekají na pokyn */
        try {
          if (kam.options && kam.options.autoProcessQueue === false) kam.processQueue();
        } catch (e) { /* fronta se rozjede sama */ }
        return 'dropzone';
      }

      var prenos = new DataTransfer();
      soubory.forEach(function (one) { prenos.items.add(one); });

      var plocha = document.querySelector('.dropzone, .dz-clickable, [class*="dropzone"]');
      if (plocha) {
        ['dragenter', 'dragover', 'drop'].forEach(function (jmeno) {
          plocha.dispatchEvent(new DragEvent(jmeno, {
            bubbles: true, cancelable: true, dataTransfer: prenos
          }));
        });
        return 'pretazeni';
      }

      var policko = document.querySelector('input[type=file]');
      if (policko) {
        policko.files = prenos.files;
        policko.dispatchEvent(new Event('input', { bubbles: true }));
        policko.dispatchEvent(new Event('change', { bubbles: true }));
        return 'policko';
      }
      return '';
    })()
  `;
}

/**
 * Vloží soubory do stránky bez ohledu na to, jestli na ní políčko je.
 *
 * Vrací, kterou cestou to prošlo (`dropzone`, `pretazeni`, `policko`),
 * nebo prázdný řetězec, když nebylo kam.
 */
export async function dropFiles(win: BrowserWindow, files: string[], frame?: WebFrameMain | null): Promise<string> {
  const list = (files ?? []).filter(one => fs.existsSync(one));
  if (list.length === 0) throw new Error('soubor neexistuje');
  if (win.isDestroyed()) throw new Error('okno se zavřelo');

  const payload = list.map(one => ({
    name: path.basename(one),
    type: mimeOf(one),
    b64: fs.readFileSync(one).toString('base64')
  }));
  const script = dropScript(payload);

  const target = frame && !frame.detached ? frame : await findDropSpot(win);
  if (!target) return '';
  try {
    return String(await target.executeJavaScript(script, true) ?? '');
  } catch {
    return '';
  }
}

/** Typ obsahu podle přípony — Dropzone podle něj pozná, že jde o obrázek. */
function mimeOf(file: string): string {
  const ext = path.extname(file).toLowerCase();
  const known: Record<string, string> = {
    '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.gif': 'image/gif', '.svg': 'image/svg+xml', '.avif': 'image/avif',
    '.webm': 'video/webm', '.mp4': 'video/mp4', '.pdf': 'application/pdf'
  };
  return known[ext] ?? 'application/octet-stream';
}

export const __test = { markScript, MARK, dropScript, PROBE };
