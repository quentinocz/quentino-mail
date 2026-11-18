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

/* ---------- nastavení importu ---------- */

/**
 * Nastaví v okně „Před prvním importem si prosím zkontrolujte nastavení"
 * jen to, co soubor nese.
 *
 * Po „Vytvořit import" Upgates otevře nastavení, kde je u **všech** údajů
 * (ceny, sklad, kategorie, obrázky, varianty…) předvybraná „Úprava".
 * Skript tu přepne na „Nezpracovávat" všechno kromě `columns`, nové položky
 * nezakládá a chybějící neoznačuje (jinak by se 1000 produktů, které soubor
 * nemá, označilo jako chybějící). **Neukládá** — „Uložit" je na člověku;
 * do okna jen připíše, co a proč nastavil.
 *
 * Vrací `null`, když okno na stránce není; jednou nastavené okno se znovu
 * nepřenastavuje (`data-quentino`), aby nepřepsalo, co člověk změnil.
 */
export function settingsScript(columns: string[]): string {
  return `
    (function () {
      var form = document.querySelector('#frm-editImportForm');
      if (!form) return null;
      if (form.getAttribute('data-quentino') === '1') return { again: true };
      var keep = ${JSON.stringify(columns)};
      function radio(name, value) {
        var el = form.querySelector('input[type=radio][name="' + name + '"][value="' + value + '"]');
        if (!el) return false;
        if (!el.checked) {
          el.checked = true;
          el.dispatchEvent(new Event('click', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return true;
      }
      var names = {};
      form.querySelectorAll('input[type=radio][name^="columns-"]').forEach(function (el) { names[el.name] = true; });
      var update = [], off = [], missing = [];
      Object.keys(names).forEach(function (name) {
        var column = name.slice('columns-'.length);
        if (keep.indexOf(column) >= 0) { if (radio(name, 'update')) update.push(column); }
        else if (radio(name, 'notProcess')) off.push(column);
      });
      keep.forEach(function (column) { if (!names['columns-' + column]) missing.push(column); });
      var general = {
        insert: radio('settings[insert_yn]', '0'),
        update: radio('settings[update_yn]', '1'),
        missing: radio('settings[mark_missing_yn]', '0')
      };
      form.setAttribute('data-quentino', '1');
      var note = document.createElement('div');
      note.className = 'alert alert-info';
      note.setAttribute('data-quentino-note', '1');
      note.textContent = 'Quentino App: „Úprava" zůstala jen u toho, co soubor nese ('
        + update.length + ' údajů), ostatních ' + off.length + ' je „Nezpracovávat" — ceny, sklad, '
        + 'kategorie ani obrázky se nezmění. Nové položky se nezakládají, chybějící se neoznačují. '
        + 'Zkontroluj a ulož.';
      form.insertBefore(note, form.firstChild);
      return { update: update, off: off.length, missing: missing, general: general };
    })()
  `;
}

export interface SettingsResult {
  update: string[];
  off: number;
  missing: string[];
  general: { insert: boolean; update: boolean; missing: boolean };
}

/**
 * Hlídá okno importu, až člověk klikne na „Vytvořit import", a nastaví ho.
 *
 * Okno se objeví až po jeho kliknutí a po načtení další stránky, takže se
 * čeká — nejdéle `timeoutMs`, a skončí se i se zavřeným oknem.
 */
export async function watchImportSettings(win: BrowserWindow, columns: string[],
                                          timeoutMs = 20 * 60_000): Promise<SettingsResult | null> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (win.isDestroyed()) return null;
    const out = await win.webContents.executeJavaScript(settingsScript(columns), true).catch(() => null);
    if (out && !out.again) return out as SettingsResult;
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  return null;
}

export const __test = { guideScript, CHOICE, settingsScript };
