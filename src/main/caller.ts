import { AsyncLocalStorage } from 'async_hooks';
import { BrowserWindow } from 'electron';

/**
 * Které okno si o věc řeklo.
 *
 * ## Proč to nestačí vzít podle zaostření
 *
 * Systémová okna pro výběr souboru se přivěšují k oknu aplikace — kvůli
 * tomu, aby se otevřela nad ním a aby se s ním hýbala. Dokud bylo okno
 * jedno, stačilo `getFocusedWindow()`. Od chvíle, kdy má každý nástroj
 * vlastní okno, to přestalo platit: mezi kliknutím a otevřením dialogu
 * se zaostření může přesunout jinam (stačí kliknout do druhého okna) a
 * dialog se přivěsí k oknu, které o něj nežádalo — na Macu pak visí jako
 * list přes cizí obsah a původní okno je zablokované.
 *
 * Proto se okno bere z té zprávy, která obsluhu vyvolala. `AsyncLocalStorage`
 * je na to přesně: drží hodnotu po celou dobu obsluhy včetně `await`,
 * a to i když se mezitím obsluhuje jiná zpráva z jiného okna.
 */
const store = new AsyncLocalStorage<BrowserWindow | null>();

/** Spustí obsluhu tak, aby v ní `callerWindow()` vracelo tohle okno. */
export function withCaller<T>(win: BrowserWindow | null, fn: () => T): T {
  return store.run(win, fn);
}

/**
 * Okno, ke kterému se má dialog přivěsit.
 *
 * Když se to nepovede zjistit (třeba u věci spuštěné časovačem, ne
 * kliknutím), zbývá zaostřené okno a po něm hlavní — dialog bez okna je
 * pořád lepší než spadnutí.
 */
export function callerWindow(): BrowserWindow | null {
  const found = store.getStore();
  if (found && !found.isDestroyed()) return found;
  // Zaostřené okno bereme jen když je naše — dialog přivěšený k otevřené
  // administraci e-shopu by se schoval za ni
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && !focused.isDestroyed() && isOurs(focused)) return focused;
  return mainWindow();
}

/**
 * Hlavní okno — to s poštou.
 *
 * Pozná se podle adresy: musí to být naše stránka (soubor aplikace, nebo
 * vývojový server) a bez mřížky — okna nástrojů i velká obrazovka focení
 * mají za mřížkou, co se v nich kreslí.
 *
 * Kontrola „je to naše stránka" tam není pro parádu. Aplikace si otevírá
 * okna i do administrace e-shopu a do portálů dopravců; ta v adrese mřížku
 * taky nemají, takže by se za hlavní okno vydávalo první takové, které
 * zrovna běží — a upozornění na poštu by klepnutím otevřelo administraci.
 */
function isOurs(win: BrowserWindow): boolean {
  const url = win.webContents.getURL();
  return url.startsWith('file://') || url.startsWith('http://localhost:5173');
}

export function mainWindow(): BrowserWindow | null {
  return BrowserWindow.getAllWindows()
    .find(win => !win.isDestroyed() && isOurs(win) && !win.webContents.getURL().includes('#')) ?? null;
}
