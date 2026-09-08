import { BrowserWindow } from 'electron';
import { getSetting, setSetting } from './db';
import { encrypt, decrypt } from './secure';
import type { PortalLogin } from '../shared/types';

/**
 * Přihlašovací údaje k administracím dopravců a e-shopu.
 *
 * Aplikace otevírá cizí administrace v okně (naskladnění, import zásilek,
 * faktury) a do každé se člověk hlásí ručně. Sezení sice zůstává v cookies,
 * ale ty jednou za čas vyprší — a pak se u tiskárny místo balení opisuje
 * heslo z papírku.
 *
 * ## Co se ukládá a jak
 *
 * Jméno a heslo, zašifrované systémovým trezorem (`safeStorage`) — tedy
 * stejně jako klíč k Upgates API nebo heslo Zásilkovny. Do zálohy nastavení
 * se to dostane jen zašifrované a nikam jinam se to neposílá.
 *
 * ## Co se s tím dělá
 *
 * Vyplní se přihlašovací formulář v okně. **Odeslání je volitelné** a ve
 * výchozím stavu zapnuté; kdo to nechce, nechá si jen předvyplnit políčka
 * a klikne sám. Formulář se hledá obecně (políčko na heslo a nejbližší
 * políčko na jméno nad ním), protože každá administrace vypadá jinak
 * a přihlašovací stránky se mění častěji než cokoli jiného.
 *
 * Dvoufázové přihlášení tím obejít nejde a nemá se o to co pokoušet:
 * když stránka po heslu chce ještě kód, dopíše ho člověk.
 */

const KEY = 'portalLogins';

export type PortalId = 'upgates' | 'ppl' | 'cposta';

const LABELS: Record<PortalId, string> = {
  upgates: 'Administrace e-shopu (Upgates)',
  ppl: 'Klientská administrace PPL',
  cposta: 'Podání Online České pošty'
};

interface Stored { user: string; pass: string; auto: boolean }

function all(): Record<string, Stored> {
  const raw = getSetting(KEY, '')!;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(decrypt(raw));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function write(next: Record<string, Stored>): void {
  setSetting(KEY, encrypt(JSON.stringify(next)));
}

/** Do rozhraní jde jen to, co se smí ukázat — heslo ne, jen že je uložené. */
export function portalLogins(): PortalLogin[] {
  const saved = all();
  return (Object.keys(LABELS) as PortalId[]).map(id => ({
    id,
    label: LABELS[id],
    user: saved[id]?.user ?? '',
    hasPassword: !!saved[id]?.pass,
    auto: saved[id]?.auto !== false
  }));
}

export function savePortalLogin(
  id: PortalId, next: { user?: string; password?: string; auto?: boolean }
): PortalLogin[] {
  const saved = all();
  const current = saved[id] ?? { user: '', pass: '', auto: true };
  saved[id] = {
    user: next.user !== undefined ? next.user.trim() : current.user,
    // Prázdné heslo neznamená „smaž ho" — políčko se nechává prázdné, když
    // se mění jen jméno. Smazat jde tlačítkem, které pošle prázdný řetězec
    // schválně jako `null`.
    pass: next.password === undefined ? current.pass
      : next.password ? next.password : '',
    auto: next.auto !== undefined ? next.auto : current.auto
  };
  write(saved);
  return portalLogins();
}

/**
 * Skript, který v okně vyplní přihlašovací formulář.
 *
 * Hledá se **políčko na heslo** — to je na přihlašovací stránce jediné
 * a jednoznačné — a k němu políčko na jméno: nejbližší textové políčko před
 * ním v pořadí dokumentu. Podle názvů se to hledat nedá, každý portál je má
 * jiné (`username`, `login`, `j_username`, `email`…), zato „heslo a nad ním
 * jméno" platí všude.
 *
 * Hodnota se nastavuje **přes nativní setter** a doplňuje se událost
 * `input`. Bez toho by React ani Angular o vyplnění nevěděly: čtou si
 * hodnotu ze svého stavu, ne z políčka, a odeslaly by prázdný formulář.
 */
function fillScript(user: string, pass: string, submit: boolean): string {
  return `
    (function () {
      function setValue(el, value) {
        var proto = Object.getPrototypeOf(el);
        var setter = Object.getOwnPropertyDescriptor(proto, 'value');
        if (setter && setter.set) setter.set.call(el, value);
        else el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      function visible(el) {
        if (!el || el.disabled || el.readOnly) return false;
        var box = el.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
      }

      var pass = Array.prototype.slice.call(document.querySelectorAll('input[type=password]'))
        .filter(visible)[0];
      if (!pass) return 'bez formuláře';

      /* Jméno: nejbližší textové políčko před heslem, ne podle názvu */
      var fields = Array.prototype.slice.call(
        document.querySelectorAll('input[type=text], input[type=email], input:not([type])')
      ).filter(visible);
      var before = fields.filter(function (el) {
        return el.compareDocumentPosition(pass) & Node.DOCUMENT_POSITION_FOLLOWING;
      });
      var user = before[before.length - 1] || fields[0] || null;

      if (user && ${JSON.stringify(user)}) setValue(user, ${JSON.stringify(user)});
      setValue(pass, ${JSON.stringify(pass)});
      if (!${submit ? 'true' : 'false'}) return 'vyplněno';

      /*
       * Odeslání: kliknutím na tlačítko, ne voláním submit() na formuláři.
       * To obchází posluchače, které si aplikace na odeslání pověsila,
       * takže by se u moderních portálů neodeslalo nic.
       */
      var form = pass.form;
      var button = form
        ? form.querySelector('button[type=submit], input[type=submit], button:not([type])')
        : null;
      if (button) { button.click(); return 'odesláno'; }
      if (form) { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); return 'odesláno'; }
      return 'vyplněno';
    })()
  `;
}

/**
 * Vyplní přihlášení, jakmile se formulář na stránce objeví.
 *
 * Čeká se, protože přihlašovací stránka bývá až za přesměrováním na SSO —
 * u Podání Online třeba na `amex.postaonline.cz`. Když se formulář za tu
 * dobu neobjeví, je člověk nejspíš přihlášený a nic se dělat nemá.
 */
export async function signIn(
  win: BrowserWindow, id: PortalId, timeoutMs = 20_000
): Promise<'odesláno' | 'vyplněno' | 'bez formuláře' | 'nenastaveno'> {
  const saved = all()[id];
  if (!saved?.pass) return 'nenastaveno';

  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (win.isDestroyed()) return 'bez formuláře';
    const out = await win.webContents
      .executeJavaScript(fillScript(saved.user, decrypt(saved.pass), saved.auto !== false), true)
      .catch(() => 'bez formuláře');
    if (out === 'odesláno' || out === 'vyplněno') return out;
    await new Promise(resolve => setTimeout(resolve, 800));
  }
  return 'bez formuláře';
}

/**
 * Přihlásí, kdykoli se přihlašovací stránka objeví znovu.
 *
 * Sezení vyprší i uprostřed práce — u Podání Online klidně během toho, co
 * se člověk proklikává k importu. Posluchač na dokončenou navigaci to
 * odchytí a přihlásí znovu, aby se okno nezaseklo na formuláři.
 */
export function keepSignedIn(win: BrowserWindow, id: PortalId): void {
  if (!all()[id]?.pass) return;
  const again = () => { void signIn(win, id, 4_000); };
  win.webContents.on('did-finish-load', again);
  win.on('closed', () => { try { win.webContents.off('did-finish-load', again); } catch { /* okno je pryč */ } });
}

export const __test = { fillScript, LABELS };
