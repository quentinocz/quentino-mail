import { BrowserWindow } from 'electron';
import * as fs from 'fs';

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
  while (Date.now() < until) {
    if (win.isDestroyed()) return false;
    const found = await win.webContents.executeJavaScript(markScript(hint), true).catch(() => false);
    if (found === true) return true;
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
    const doc: any = await dbg.sendCommand('DOM.getDocument', { depth: -1 });
    const found: any = await dbg.sendCommand('DOM.querySelector', {
      nodeId: doc.root.nodeId,
      selector: `[${MARK}]`
    });
    if (!found?.nodeId) throw new Error('políčko pro soubor se na stránce nenašlo');
    await dbg.sendCommand('DOM.setFileInputFiles', { nodeId: found.nodeId, files: list });
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

export const __test = { markScript, MARK };
