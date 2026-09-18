import { BrowserWindow, screen, shell } from 'electron';
import path from 'path';
import { getSetting, setSetting } from './db';
import { TOOL_WINDOWS, toolWindow } from '../shared/windows';
import type { ToolWindowId } from '../shared/windows';

/**
 * Okna nástrojů.
 *
 * Každý nástroj z nabídky Funkce má vlastní okno aplikace: tentýž balík
 * skriptů i tentýž preload, jen se v adrese předá text za mřížkou a
 * rozhraní podle něj vykreslí jen ten jeden nástroj. Druhý vstupní bod by
 * znamenal druhý build a druhé místo, kde se zapojují kanály.
 *
 * Napsané je to jednou pro všechny. Dřív to uměla jen `shootwindow.ts` pro
 * focení; opsat ji devětkrát by znamenalo devět kopií zapamatování polohy
 * a devět míst, kde se opravuje totéž.
 */

/** Otevřená okna podle nástroje. */
const windows = new Map<ToolWindowId, BrowserWindow>();

/**
 * Na co se má okno po otevření rovnou podívat — číslo objednávky u balení,
 * naskladnění u katalogu.
 *
 * Předává se přes hlavní proces, ne v adrese: okno může být už otevřené a
 * adresu mu měnit nejde bez načtení stránky znovu, což by zahodilo
 * rozdělanou práci.
 */
const args = new Map<ToolWindowId, string>();

const MIN_ON_SCREEN = 120;

type State = { x?: number; y?: number; width: number; height: number; maximized: boolean };

function stateKey(id: ToolWindowId): string {
  // Focení mělo vlastní klíč dřív, než okna uměly všechny nástroje —
  // přejmenováním by uživatel přišel o zapamatovanou polohu
  return id === 'shoot' ? 'shootWindowState' : `toolWindowState:${id}`;
}

function loadState(id: ToolWindowId): State {
  const def = toolWindow(id)!;
  const fallback: State = { width: def.width, height: def.height, maximized: false };
  try {
    const raw = getSetting(stateKey(id));
    if (!raw) return fallback;
    const saved = JSON.parse(raw) as State;
    const width = Math.max(def.minWidth, Math.round(saved.width) || fallback.width);
    const height = Math.max(def.minHeight, Math.round(saved.height) || fallback.height);
    const out: State = { width, height, maximized: !!saved.maximized };
    if (typeof saved.x === 'number' && typeof saved.y === 'number') {
      /*
       * Nástroje se často dělají na druhé obrazovce — focení u stolu s
       * fotoaparátem, katalog u regálu. Když ta zrovna není připojená, okno
       * by se otevřelo mimo viditelnou plochu a vypadalo by to, že se
       * nestalo nic.
       */
      const visible = screen.getAllDisplays().some(display => {
        const area = display.workArea;
        return saved.x! + width > area.x + MIN_ON_SCREEN && saved.x! < area.x + area.width - MIN_ON_SCREEN
          && saved.y! < area.y + area.height - MIN_ON_SCREEN && saved.y! + height > area.y;
      });
      if (visible) { out.x = Math.round(saved.x); out.y = Math.round(saved.y); }
    }
    return out;
  } catch {
    return fallback;
  }
}

function saveState(id: ToolWindowId): void {
  const win = windows.get(id);
  if (!win || win.isDestroyed()) return;
  try {
    const bounds = win.isMaximized() || win.isFullScreen() ? win.getNormalBounds() : win.getBounds();
    setSetting(stateKey(id), JSON.stringify({
      x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
      maximized: win.isMaximized()
    }));
  } catch { /* zapamatování okna není kritické */ }
}

/** Seznam otevřených nástrojů. Rozhraní podle něj zvýrazňuje nabídku. */
export function openTools(): ToolWindowId[] {
  return TOOL_WINDOWS
    .map(def => def.id)
    .filter(id => { const win = windows.get(id); return !!win && !win.isDestroyed(); });
}

function announce(): void {
  const list = openTools();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('tool:windows', list);
  }
}

export function openToolWindow(id: string, arg = ''): boolean {
  const def = toolWindow(id);
  if (!def) return false;

  if (arg) args.set(def.id, arg);

  const already = windows.get(def.id);
  if (already && !already.isDestroyed()) {
    if (already.isMinimized()) already.restore();
    already.focus();
    // Okno už běží, adresu mu změnit nejde — na co se má podívat, se mu řekne
    if (arg) already.webContents.send('tool:look', { id: def.id, arg });
    return true;
  }

  const state = loadState(def.id);
  const win = new BrowserWindow({
    ...(state.x !== undefined ? { x: state.x, y: state.y } : {}),
    width: state.width,
    height: state.height,
    minWidth: def.minWidth,
    minHeight: def.minHeight,
    title: def.title,
    backgroundColor: def.dark ? '#15151a' : '#f6f5f8',
    titleBarStyle: process.platform === 'darwin' && def.ownTitleBar ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true
    }
  });
  windows.set(def.id, win);

  /*
   * Jméno okna si drží aplikace, ne stránka.
   *
   * Všechna okna načítají tentýž `index.html` a ten má v hlavičce
   * `<title>Quentino App</title>`. Electron jméno okna ze stránky přebírá,
   * takže se `title` výše zahodilo hned po načtení a v doku pak stálo pod
   * sebou sedm řádků „Quentino App" — nedalo se poznat, které je které.
   * Přepsání ze stránky se proto zruší.
   */
  win.on('page-title-updated', event => { event.preventDefault(); });
  win.setTitle(def.title);

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('http://localhost:5173') && !url.startsWith('file://')) {
      event.preventDefault();
      if (url.startsWith('http')) shell.openExternal(url);
    }
  });

  if (state.maximized) win.maximize();

  let timer: NodeJS.Timeout | null = null;
  const later = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => saveState(def.id), 400);
  };
  win.on('resize', later);
  win.on('move', later);
  win.on('maximize', later);
  win.on('unmaximize', later);
  win.on('close', () => {
    if (timer) clearTimeout(timer);
    saveState(def.id);
  });
  win.on('closed', () => {
    if (windows.get(def.id) === win) windows.delete(def.id);
    args.delete(def.id);
    announce();
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) win.loadURL(`${devUrl}#${def.hash}`);
  else win.loadFile(path.join(__dirname, '../../renderer/index.html'), { hash: def.hash });

  announce();
  return true;
}

export function toolWindowOpen(id: string): boolean {
  const win = windows.get(id as ToolWindowId);
  return !!win && !win.isDestroyed();
}

export function closeToolWindow(id: string): boolean {
  const win = windows.get(id as ToolWindowId);
  if (win && !win.isDestroyed()) win.close();
  return true;
}

/** Na co se má okno podívat. Přečte se jednou — podruhé už by to skákalo samo. */
export function takeToolArg(id: string): string {
  const key = id as ToolWindowId;
  const arg = args.get(key) ?? '';
  args.delete(key);
  return arg;
}

/**
 * Jak si vyrobit hlavní okno, když žádné není.
 *
 * Na Macu aplikace po zavření hlavního okna běží dál a okno nástroje může
 * zůstat otevřené — odkaz z přehledu dne by pak neměl kam skočit. Funkci
 * dodá `main.ts` při startu; sem se netahá napřímo, jinak by si soubory
 * začaly dovážet jeden druhého dokola.
 */
let makeMain: (() => BrowserWindow) | null = null;

export function mainWindowMaker(fn: () => BrowserWindow): void {
  makeMain = fn;
}

/**
 * Skok z okna nástroje do pošty nebo chatu v hlavním okně.
 *
 * Přehled dne i balení odkazují na zprávu, které se věc týká. Dokud byly
 * překryvem nad poštou, stačilo překryv zavřít; ve vlastním okně už pošta
 * není kde — je ve vedlejším okně, které se musí najít a vytáhnout dopředu.
 *
 * Hlavní okno je to, které není nástroj ani velká obrazovka — tedy jediné
 * bez mřížky v adrese.
 */
export function gotoInMain(kind: 'message' | 'chat', id: string): boolean {
  const ours = new Set(windows.values());
  const main = BrowserWindow.getAllWindows().find(win =>
    !win.isDestroyed() && !ours.has(win) && !win.webContents.getURL().includes('#'));
  if (main) {
    if (main.isMinimized()) main.restore();
    main.focus();
    main.webContents.send('app:goto', { kind, id });
    return true;
  }
  if (!makeMain) return false;
  // Čerstvě otevřené okno ještě nemá co poslouchat — počká se, až se načte
  const fresh = makeMain();
  fresh.webContents.once('did-finish-load', () => {
    if (!fresh.isDestroyed()) fresh.webContents.send('app:goto', { kind, id });
  });
  return true;
}
