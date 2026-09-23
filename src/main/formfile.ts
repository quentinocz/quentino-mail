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
export async function openUrl(win: BrowserWindow, url: string, timeoutMs = 45_000): Promise<void> {
  try {
    /*
     * I načtení má strop. Stránka, která se nikdy nedonačte (viselý
     * požadavek v administraci), by jinak držela celé volání navždy —
     * a v aplikaci z toho je „reply was never sent". Po vypršení se jede
     * dál: co se stihlo vykreslit, se stejně dá prohledat.
     */
    let hlidac: NodeJS.Timeout | null = null;
    await Promise.race([
      win.webContents.loadURL(url),
      new Promise<void>(resolve => { hlidac = setTimeout(resolve, timeoutMs); })
    ]).finally(() => { if (hlidac) clearTimeout(hlidac); });
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
 * Hledání, které projde i **stínový DOM**.
 *
 * `document.querySelectorAll` se do stínového kořene nepodívá — a co je
 * v něm, pro stránku jako by nebylo. Administrace e-shopu si takhle může
 * ze dne na den schovat celý nahrávací prvek a zvenčí to vypadá, že na
 * stránce žádné políčko na soubor není. Rovnou se prochází i vnořené
 * kořeny, protože komponenty bývají v sobě.
 */
const DEEP = `
  function hluboko(sel, korenu) {
    var out = [];
    var videno = 0;
    var projdi = function (root) {
      if (!root || videno > 40) return;
      try { out.push.apply(out, root.querySelectorAll(sel)); } catch (e) { /* jiný kořen */ }
      var vse;
      try { vse = root.querySelectorAll('*'); } catch (e) { return; }
      for (var i = 0; i < vse.length; i++) {
        if (vse[i].shadowRoot) { videno++; if (korenu) korenu.pocet++; projdi(vse[i].shadowRoot); }
      }
    };
    projdi(document);
    return out;
  }
`;

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
      ${DEEP}
      /*
       * Nejdřív obyčejné hledání — tak to funguje u dopravců i u importu
       * a nemá smysl na tom nic měnit. Stínový DOM se prochází, jen když
       * obyčejné hledání nenajde nic: je to dražší a potřeba to je jen
       * tam, kde si stránka prvek schovala do komponenty.
       */
      var all = Array.prototype.slice.call(document.querySelectorAll('input[type=file]'));
      if (all.length === 0) all = hluboko('input[type=file]');
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
    /*
     * **Okno první, a přesně tak jako dřív.**
     *
     * Tudy se roky vkládaly štítky dopravců, fotky produktů i importní
     * XML. Když jsem hledání přesměroval do jednotlivých rámů, přestalo
     * fungovat všechno naráz — rám odpověděl, ale ne tím, co se čekalo,
     * takže se k oknu vůbec nedošlo. Vnořené rámy jsou proto až přídavek
     * pro správce souborů a sahá se na ně, teprve když okno nic nenajde.
     */
    const found = await runJs<boolean>(win.webContents, script, 6_000).catch(() => false);
    if (found === true) return true;
    const vnorene = await subFrames<boolean>(win, script);
    if (vnorene.some(one => one.value === true)) return true;
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
    // Přesně jako dřív. „pierce" vrací i obsah vnořených rámů, jenže je to
    // zároveň jiný strom uzlů — a tahle cesta funguje roky, tak se nesahá.
    const doc: any = await dbg.sendCommand('DOM.getDocument', { depth: -1 });
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

  /*
   * A teď to říct stránce.
   *
   * `DOM.setFileInputFiles` soubor do políčka vloží, ale **událost
   * neposílá spolehlivě** — a bez ní se o něm stránka nedozví. Přesně
   * tohle se stalo ve správci souborů Upgates: soubor v políčku byl,
   * Dropzone visící na `<body>` o něm nevěděl a nenahrálo se nic.
   * Stejně to dělá i Puppeteer: vložit a pak poslat `input` a `change`.
   */
  await runJs(win.webContents, OZNAM, 6_000).catch(() => false);
  for (const frame of framesOf(win).slice(1)) {
    if (frame.detached) continue;
    await runJs(frame, OZNAM, 6_000).catch(() => false);
  }
}

/** Oznámí stránce, že se v označeném políčku objevil soubor. */
const OZNAM = `
  (function () {
    var one = document.querySelector('[${MARK}]');
    if (!one) return false;
    try {
      one.dispatchEvent(new Event('input', { bubbles: true }));
      one.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    } catch (e) { return false; }
  })()
`;

/**
 * Celá cesta: počkat na políčko a vložit do něj soubor.
 *
 * Vrací i adresu, na které se to povedlo — z ní se dá příště otevřít rovnou
 * ta správná stránka, místo aby se k ní uživatel proklikával znovu.
 */
export async function fillFileInput(
  win: BrowserWindow, file: string, hint: string | string[] = '', timeoutMs = 3 * 60_000
): Promise<{ filled: boolean; url: string; note: string }> {
  // Co na stránce bylo — zapsat hned, dokud okno žije (čeká se i tři minuty)
  const nalez = await describeDropSpots(win).catch(() => '');
  const ready = await waitForFileInput(win, hint, timeoutMs);
  if (!ready) {
    return {
      filled: false,
      url: '',
      note: `Políčko pro soubor se neobjevilo. Soubor je uložený v ${file} — vyber ho v okně ručně.`
        + (nalez ? ` (Co jsem na stránce našel — ${nalez}.)` : '')
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
 * Spuštění skriptu, které **vždycky skončí**.
 *
 * `executeJavaScript` nemá žádný vlastní časový strop: když se vykreslovací
 * proces zasekne (nejčastěji nativním `confirm` po kliknutí), příslib se
 * nikdy nevyřeší. Celé volání pak visí donekonečna a v aplikaci z toho je
 * „reply was never sent" — hláška, ze které nikdo nepozná, co se stalo.
 * Strop je proto tady, u každého jednoho dotazu na stránku.
 */
export async function runJs<T>(
  target: { executeJavaScript(code: string, gesture?: boolean): Promise<any> },
  script: string, timeoutMs = 6_000
): Promise<T> {
  let hlidac: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      target.executeJavaScript(script, true) as Promise<T>,
      new Promise<T>((_, reject) => {
        hlidac = setTimeout(() => reject(new Error('stránka neodpověděla včas')), timeoutMs);
      })
    ]);
  } finally {
    if (hlidac) clearTimeout(hlidac);
  }
}

/**
 * Umlčení nativních dialogů na stránce.
 *
 * `alert`, `confirm` a `prompt` zastaví celý vykreslovací proces, dokud na
 * ně někdo neklikne — a od té chvíle neodpoví na žádný dotaz. Aplikace do
 * administrace kliká (hledá tlačítko nahrávání), takže si tohle riziko
 * přivolává sama; proto se ty tři funkce předem nahradí za tiché.
 */
export const NO_DIALOGS = `
  (function () {
    try {
      window.alert = function () {};
      window.confirm = function () { return true; };
      window.prompt = function () { return null; };
      return true;
    } catch (e) { return false; }
  })()
`;

/**
 * Stránka nesmí zavřít naše okno.
 *
 * V prohlížeči je `window.close()` ze stránky, kterou nikdo neotevřel
 * skriptem, **tiše ignorované** — proto to v Chromu nikdo nikdy nezažil.
 * V okně aplikace ale zavře celé okno, a to i uprostřed práce. Správce
 * souborů Upgates to dělá: okno se otevřelo, načetlo a po pár vteřinách
 * zmizelo, takže aplikace neměla koho se zeptat a hlásila „okno už je
 * zavřené", zatímco člověk koukal na jiné, právě otevřené okno.
 *
 * Zavřít okno smí dál člověk (křížkem i klávesou) — přepisuje se jen ta
 * funkce ve stránce.
 */
const NO_CLOSE = `
  (function () {
    try {
      if (!window.__quentinoNoClose) {
        window.__quentinoNoClose = true;
        window.close = function () { /* okno zavírá jen člověk */ };
        if (window.self !== window.top) { try { window.top.close = function () {}; } catch (e) { /* cizí rám */ } }
      }
      return true;
    } catch (e) { return false; }
  })()
`;

/**
 * Ochrana okna: stránka nezavře okno ani nezablokuje práci dialogem.
 *
 * Zapíná se hned při otevírání, ne až když je zle — obojí se totiž stane
 * dřív, než se aplikace stihne na cokoli zeptat.
 */
export function protectWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  const chran = () => { void runJs(win.webContents, NO_CLOSE + NO_DIALOGS, 3_000).catch(() => false); };
  win.webContents.on('dom-ready', chran);
  win.webContents.on('did-finish-load', chran);
  /* Vnořené rámy mají vlastní okno — a vlastní close() */
  win.webContents.on('did-frame-finish-load', (_e, isMain, pid, frameId) => {
    if (isMain) return;
    void (async () => {
      for (const frame of framesOf(win).slice(1)) {
        if (frame.detached || frame.frameTreeNodeId !== frameId) continue;
        await runJs(frame, NO_CLOSE + NO_DIALOGS, 3_000).catch(() => false);
      }
      void pid;
    })();
  });
  chran();
}

/** Umlčí dialogy ve všech rámech okna. Chyby nevadí — je to pojistka. */
export async function silenceDialogs(win: BrowserWindow): Promise<void> {
  if (win.isDestroyed()) return;
  await runJs(win.webContents, NO_DIALOGS, 3_000).catch(() => false);
  for (const frame of framesOf(win).slice(1)) {
    if (frame.detached) continue;
    await runJs(frame, NO_DIALOGS, 3_000).catch(() => false);
  }
}

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
  const out: WebFrameMain[] = [];
  /*
   * Hlavní rám a strom pod ním se berou **zvlášť**. Když se totiž
   * `framesInSubtree` nepovede (Electron umí na rám, který se zrovna
   * přenačítá, vyhodit „Render frame was disposed"), nesmí tím zmizet
   * i hlavní rám — přesně to se stalo a aplikace pak hlásila, že stránka
   * nevrátila ani jeden rám, ačkoli na obrazovce byl správce souborů.
   */
  try { if (win.webContents.mainFrame) out.push(win.webContents.mainFrame); }
  catch { /* zkusí se ještě celé okno níž */ }
  try {
    for (const one of out[0]?.framesInSubtree ?? []) if (!out.includes(one)) out.push(one);
  } catch { /* vnořené rámy nejsou dostupné — zůstane hlavní */ }
  return out;
}

/**
 * Spustí skript ve všech rámech; vrátí dvojice rám + výsledek.
 *
 * Rám `null` znamená „celé okno" — záchrana pro případ, že se k rámům
 * nedá dostat. Bez ní stačilo, aby výčet rámů selhal, a aplikace
 * najednou neuměla to, co uměla předtím.
 */
export async function eachFrame<T>(win: BrowserWindow, script: string): Promise<{ frame: WebFrameMain | null; value: T }[]> {
  const { out } = await eachFrameDetail<T>(win, script);
  return out;
}

/** Zahozené chyby jsou to nejdražší, co v téhle cestě je — tady se schovávají. */
export const lastScriptErrors: string[] = [];

/**
 * Jen **vnořené** rámy, bez hlavního.
 *
 * Hlavní rám je totéž co okno a to se ptá zvlášť. Oddělené je to schválně:
 * kdo se ptá okna, nesmí kvůli rámu přijít o odpověď, kterou okno dá —
 * přesně tak se rozbilo vkládání souborů úplně všude.
 */
export async function subFrames<T>(
  win: BrowserWindow, script: string
): Promise<{ frame: WebFrameMain; value: T }[]> {
  const out: { frame: WebFrameMain; value: T }[] = [];
  const all = framesOf(win);
  for (const frame of all.slice(1)) {
    try {
      if (frame.detached) continue;
      const value = await runJs<T>(frame, script, 6_000);
      if (value !== undefined && value !== null) out.push({ frame, value });
    } catch { /* rám se přenačetl nebo je z cizí domény */ }
  }
  return out;
}

/**
 * Totéž, ale i s tím, co se nepovedlo.
 *
 * **Pořadí je tu podstatné.** Roky fungovalo spuštění skriptu na celém
 * okně (`webContents`) a rámy jsou až přídavek kvůli vnořenému správci
 * souborů. Když se pořadí obrátilo, přestalo fungovat i to, co předtím
 * šlo — proto se okno zkouší **první** a chyby se už nezahazují: bez
 * nich zní „stránka neodpověděla" stejně u chyby ve skriptu jako
 * u zavřeného okna.
 */
export async function eachFrameDetail<T>(
  win: BrowserWindow, script: string
): Promise<{ out: { frame: WebFrameMain | null; value: T }[]; errors: string[] }> {
  const out: { frame: WebFrameMain | null; value: T }[] = [];
  const errors: string[] = [];
  if (win.isDestroyed()) {
    errors.push('okno už je zavřené');
    return { out, errors };
  }

  try {
    out.push({ frame: null, value: await runJs<T>(win.webContents, script, 6_000) });
  } catch (e: any) {
    errors.push(`okno: ${String(e?.message ?? e).slice(0, 120)}`);
  }

  const main = framesOf(win)[0];
  for (const frame of framesOf(win)) {
    // Hlavní rám je totéž co okno — ten už odpověděl výš
    if (frame === main) continue;
    try {
      if (frame.detached) continue;
      out.push({ frame, value: await runJs<T>(frame, script, 6_000) });
    } catch (e: any) {
      errors.push(`rám ${frame.url?.slice(0, 60) ?? '?'}: ${String(e?.message ?? e).slice(0, 120)}`);
    }
  }

  lastScriptErrors.length = 0;
  lastScriptErrors.push(...errors);
  return { out, errors };
}

/** Spustí skript tam, kde se našlo nahrávání; `null` znamená celé okno. */
async function runIn<T>(win: BrowserWindow, frame: WebFrameMain | null, script: string): Promise<T> {
  // Delší strop: tímhle skriptem cestuje i obsah souboru, takže se pár vteřin počká
  if (frame && !frame.detached) return await runJs<T>(frame, script, 30_000);
  return await runJs<T>(win.webContents, script, 30_000);
}

/**
 * Co v tom kterém rámu je, aby se soubory vkládaly tam, kde je nahrávání.
 *
 * Hlídá se i **výpis souborů** (`.manager-file`): správce souborů Upgates
 * přijímá přetažení rovnou na výpis, i když na něm žádná třída
 * s „dropzone" není. Událost `drop` poslaná na výpis probublá k tomu,
 * kdo ji poslouchá, ať visí na kterémkoli rodiči.
 */
const PROBE = `
  (function () {
   try {
    ${DEEP}
    /* Kolik má stránka stínových kořenů — počítá se jednou, ne při každém hledání */
    var stinu = 0;
    try {
      var vseNaStrance = document.querySelectorAll('*');
      for (var k = 0; k < vseNaStrance.length; k++) if (vseNaStrance[k].shadowRoot) stinu++;
    } catch (e) { stinu = 0; }
    var dz = 0;
    try {
      dz = ((window.Dropzone && window.Dropzone.instances) || []).filter(function (one) {
        return one && one.element && one.element.isConnected;
      }).length;
    } catch (e) { dz = 0; }
    var PLOCHA = '.dropzone, .dz-clickable, [class*="dropzone"], [class*="Dropzone"]';
    var plocha = document.querySelector(PLOCHA) ? 1 : (hluboko(PLOCHA).length ? 1 : 0);
    var vypis = document.querySelectorAll('.manager-file').length
      || hluboko('.manager-file').length;
    var policka = document.querySelectorAll('input[type=file]').length
      || hluboko('input[type=file]').length;
    /* Tlačítka, která by nahrávání mohla otevřít — podle textu i podle obsluhy */
    var hledej = /nahr[aá]t|vlo[žz]it|p[řr]idat soubor|upload|add ?file|new file/i;
    var tlacitka = 0;
    var nazvy = [];
    var vse = document.querySelectorAll('a, button, [role=button], .btn, .smi, [onclick]');
    for (var i = 0; i < vse.length; i++) {
      var one = vse[i];
      var popis = (one.textContent || '') + ' ' + (one.getAttribute('title') || '')
        + ' ' + (one.getAttribute('data-tip') || '') + ' ' + (one.getAttribute('onclick') || '')
        + ' ' + (one.className || '') + ' ' + ((one.querySelector('i') || {}).className || '');
      if (!hledej.test(popis)) continue;
      tlacitka++;
      if (nazvy.length < 4) nazvy.push((one.textContent || one.getAttribute('title') || '')
        .replace(/\\s+/g, ' ').trim().slice(0, 30) || (one.className || '').slice(0, 30));
    }
    return {
      dz: dz, drop: plocha, input: policka,
      tiles: vypis, buttons: tlacitka, names: nazvy,
      /* Kolik toho na stránce vůbec je — podle toho se pozná prázdná stránka */
      prvku: document.getElementsByTagName('*').length,
      ramu: document.getElementsByTagName('iframe').length,
      stinu: stinu,
      url: String(location.href).slice(0, 120), title: String(document.title).slice(0, 60),
      chyba: ''
    };
   } catch (e) {
    /*
     * Skript, který spadne, vrátí Electron jako odmítnuté volání — a to
     * se pak nedá odlišit od zavřeného okna. Chyba se proto vrací jako
     * hodnota a je z ní aspoň vidět, co se nepovedlo.
     */
    return {
      dz: 0, drop: 0, input: 0, tiles: 0, buttons: 0, names: [],
      prvku: 0, ramu: 0, stinu: 0,
      url: String(location.href).slice(0, 120), title: String(document.title).slice(0, 60),
      chyba: String((e && e.message) || e).slice(0, 120)
    };
   }
  })()
`;

export interface DropSpot {
  dz: number; drop: number; input: number;
  tiles: number; buttons: number; names: string[];
  prvku: number; ramu: number; stinu: number;
  url: string; title: string; chyba: string;
}

/** Nejjednodušší možná otázka: odpovídá stránka vůbec? */
const CANARY = `
  (function () { return { t: String(document.title).slice(0, 60),
    h: String(location.href).slice(0, 120), prvku: document.getElementsByTagName('*').length }; })()
`;

/**
 * Jistá cesta: Dropzone, jeho plocha nebo políčko na soubor. Tam se dá
 * soubor vložit tak, že o tom stránka **ví**.
 */
const jiste = (one: DropSpot | null | undefined) =>
  !!one && (one.dz > 0 || one.drop > 0 || one.input > 0);

/**
 * Nejistá cesta: jen výpis souborů. Upustit soubor na výpis může
 * fungovat, ale nedá se to ověřit jinak než tím, že se objeví ve výpisu.
 */
const mozna = (one: DropSpot | null | undefined) => !!one && one.tiles > 0;

export interface Spot { frame: WebFrameMain | null; value: DropSpot; jiste: boolean }

/** Je kam soubory vložit? Vrací rám, kde to je (`null` = celé okno). */
export async function findDropSpot(win: BrowserWindow, jenJiste = false): Promise<Spot | null> {
  const all = await eachFrame<DropSpot>(win, PROBE);
  const hodi = all.filter(one => (jenJiste ? jiste(one.value) : jiste(one.value) || mozna(one.value)));
  // Dropzone má přednost před holým políčkem — ten soubor rovnou odešle
  const best = hodi.sort((a, b) => (b.value.dz - a.value.dz) || (b.value.drop - a.value.drop)
    || (b.value.input - a.value.input) || (b.value.tiles - a.value.tiles))[0];
  return best ? { frame: best.frame, value: best.value, jiste: jiste(best.value) } : null;
}

/**
 * Co se v rámech stránky našlo, jednou větou.
 *
 * Když se nahrání nepovede, je tohle to jediné, co k tomu jde z dálky
 * zjistit — bez toho zní hláška „nešlo to" stejně u iframu z cizí domény
 * jako u přejmenovaného tlačítka.
 */
export async function describeDropSpots(win: BrowserWindow): Promise<string> {
  const { out: all, errors } = await eachFrameDetail<DropSpot>(win, PROBE);
  if (all.length === 0) {
    /*
     * Nic neodpovědělo. Tady se teprve ukáže, jestli je hluchá stránka,
     * nebo jen tenhle skript: kanárek se ptá na to nejjednodušší, co
     * v prohlížeči je.
     */
    const zivot = await eachFrameDetail<{ t: string; h: string; prvku: number }>(win, CANARY);
    const kanarek = zivot.out[0]?.value;
    const stav = kanarek
      ? `stránka žije (${kanarek.t || kanarek.h}, ${kanarek.prvku} prvků), ale hledání na ní spadlo`
      : 'stránka neodpověděla ani na nejjednodušší dotaz';
    const proc = [...errors, ...zivot.errors].slice(0, 3).join(' / ');
    return proc ? `${stav} — ${proc}` : stav;
  }
  return all
    .map((one, i) => {
      const v = one.value;
      const kde = one.frame ? `rám ${i + 1}` : 'okno';
      if (!v) return `${kde}: bez odpovědi`;
      return `${kde} (${v.title || v.url}): ${v.prvku} prvků, ${v.ramu} rámů,`
        + ` ${v.stinu} stínových kořenů, dropzone ${v.dz}, plocha ${v.drop},`
        + ` políček ${v.input}, souborů ve výpisu ${v.tiles},`
        + ` tlačítek k nahrání ${v.buttons}${v.names.length ? ` [${v.names.join(' | ')}]` : ''}`
        + (v.chyba ? ` — hledání spadlo na: ${v.chyba}` : '');
    })
    .join('; ');
}

/** Počká, až se objeví místo, kam jde soubor vložit. */
export async function waitForDropSpot(
  win: BrowserWindow, timeoutMs = 12_000, jenJiste = false
): Promise<Spot | null> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (win.isDestroyed()) return null;
    const spot = await findDropSpot(win, jenJiste);
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

      /*
       * Políčko dřív než přetažení: je to jistota. Přetažení se poznat
       * nedá — událost se pošle, stránka si ji nemusí vzít a nikdo se to
       * nedozví. Proto se nejdřív zkusí to, co má výsledek.
       */
      var policko = document.querySelector('input[type=file]');
      if (policko) {
        policko.files = prenos.files;
        policko.dispatchEvent(new Event('input', { bubbles: true }));
        policko.dispatchEvent(new Event('change', { bubbles: true }));
        return 'policko';
      }

      /*
       * Přetažení. Cílem je plocha Dropzonu, a když žádná není, tak
       * **výpis souborů** — správce souborů Upgates přijímá soubory
       * upuštěné na výpis a událost od něj probublá k tomu, kdo ji
       * poslouchá, ať visí na kterémkoli rodiči.
       */
      var vypis = document.querySelector('.manager-file');
      var plocha = document.querySelector('.dropzone, .dz-clickable, [class*="dropzone"], [class*="Dropzone"]')
        || (vypis && vypis.parentNode) || document.body;
      if (plocha) {
        ['dragenter', 'dragover', 'drop'].forEach(function (jmeno) {
          plocha.dispatchEvent(new DragEvent(jmeno, {
            bubbles: true, cancelable: true, dataTransfer: prenos
          }));
        });
        return 'pretazeni';
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
export async function dropFiles(
  win: BrowserWindow, files: string[], spot?: Spot | null
): Promise<string> {
  const list = (files ?? []).filter(one => fs.existsSync(one));
  if (list.length === 0) throw new Error('soubor neexistuje');
  if (win.isDestroyed()) throw new Error('okno se zavřelo');

  const payload = list.map(one => ({
    name: path.basename(one),
    type: mimeOf(one),
    b64: fs.readFileSync(one).toString('base64')
  }));
  const script = dropScript(payload);

  const target = spot ?? await findDropSpot(win);
  if (!target) return '';
  try {
    return String(await runIn<string>(win, target.frame, script) ?? '');
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

export const __test = { markScript, MARK, dropScript, PROBE, OZNAM, NO_CLOSE };
