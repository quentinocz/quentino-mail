import { BrowserWindow } from 'electron';

/**
 * Proklikání průvodce importem v administraci Upgates.
 *
 * Průvodce má čtyři kroky (jaká data → jak importovat → jak často → soubor)
 * a políčko na soubor se objeví až po nich. Nechávat to na člověku znamenalo
 * čtyři kliknutí pokaždé — a hlavně se v tom dá u třetího kroku omylem vybrat
 * „Pravidelně", což by z jednorázového souboru udělalo denní import.
 *
 * Aplikace proto klikne sama a zastaví se **před posledním tlačítkem**:
 * „Vytvořit import" zůstává na člověku, protože od té chvíle se produkty
 * v e-shopu doopravdy mění.
 */

/** Co se v průvodci vybírá. Hodnoty jsou `data-value` karet na stránce. */
export const CHOICE = {
  /** Vlastní formát Upgates — přesně to, co aplikace vyrábí */
  type: 'general-xml',
  /** Jen nové položky: import se stejným kódem nemůže přepsat cizí produkt */
  processing: 'insert',
  /** Jednorázově — jinak by se ze souboru stal denní import */
  repetition: 'once'
} as const;

export interface GuideResult {
  type: boolean;
  processing: boolean;
  repetition: boolean;
  /** Je vidět krok s výběrem souboru? */
  fileStep: boolean;
}

/**
 * Klikne za člověka první tři kroky.
 *
 * Klikne se **vždycky**, i když karta už vypadá vybraně: výběr dalšího kroku
 * se na stránce objeví teprve v obsluze kliknutí. Přeskočit kliknutí u už
 * zvýrazněné karty znamenalo, že se další krok nikdy neukázal.
 */
export function guideScript(choice: { type: string; processing: string; repetition: string } = CHOICE): string {
  return `
    (function () {
      function pick(wrap, value) {
        var box = document.querySelector(wrap);
        if (!box) return false;
        var item = box.querySelector('.Item[data-value="' + value + '"]');
        if (!item) return false;
        item.click();
        return true;
      }
      var out = {
        type: pick('#import_type', ${JSON.stringify(choice.type)}),
        processing: false,
        repetition: false,
        fileStep: false
      };
      if (out.type) {
        out.processing = pick('#data_processing', ${JSON.stringify(choice.processing)});
        out.repetition = pick('#repetition_type', ${JSON.stringify(choice.repetition)});
      }
      var file = document.querySelector('#frmguideForm-file');
      var step = file && file.closest('fieldset');
      out.fileStep = !!(step && step.offsetParent !== null);
      return out;
    })()
  `;
}

/** Přečte, co průvodce po vložení souboru ukazuje — důkaz, že ho přijal. */
export const FILE_TAKEN = `
  (function () {
    var info = document.querySelector('#GuideFileInfo');
    var save = document.querySelector('#frmguideForm-save');
    return {
      name: info ? (info.textContent || '').trim() : '',
      saveShown: !!(save && save.offsetParent !== null)
    };
  })()
`;

/**
 * Počká, až se průvodce načte, a proklikne ho.
 *
 * Čeká se na karty výběru typu — stránka administrace se dokresluje a hned
 * po otevření na ní ještě nic není.
 */
export async function runGuide(win: BrowserWindow, processing: string = CHOICE.processing,
                               timeoutMs = 60_000): Promise<GuideResult | null> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (win.isDestroyed()) return null;
    const ready = await win.webContents.executeJavaScript(
      `!!document.querySelector('#import_type .Item')`, true
    ).catch(() => false);
    if (ready === true) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (win.isDestroyed()) return null;
  const out = await win.webContents
    .executeJavaScript(guideScript({ ...CHOICE, processing }), true).catch(() => null);
  return (out ?? null) as GuideResult | null;
}

export const __test = { guideScript, CHOICE };
