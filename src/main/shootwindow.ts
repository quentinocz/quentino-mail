import { BrowserWindow, screen, shell } from 'electron';
import path from 'path';
import { getSetting, setSetting } from './db';

/**
 * Focení má vlastní okno aplikace.
 *
 * ## Proč ne jako ostatní nástroje v modálu
 *
 * Všechno ostatní se dá udělat a zavřít. Focení trvá hodinu a po celou tu
 * dobu musí být vidět živý náhled — a zároveň se u toho vyřizuje pošta,
 * dohledávají kódy zboží a píšou popisky. V modálním okně by to znamenalo
 * po každém snímku nástroj zavřít a zase otevřít, a při každém zavření
 * zhasnout náhled.
 *
 * Je to tentýž kód okna, jen se v adrese předá `#foceni` a aplikace pak
 * vykreslí jen focení. Tím odpadá druhý balík skriptů i druhá cesta ke
 * kanálům — okno má stejný preload a stejná práva jako hlavní.
 */

let shootWindow: BrowserWindow | null = null;

const STATE_KEY = 'shootWindowState';
const MIN_WIDTH = 900;
const MIN_HEIGHT = 620;

type State = { x?: number; y?: number; width: number; height: number; maximized: boolean };

function loadState(): State {
  const fallback: State = { width: 1280, height: 860, maximized: false };
  try {
    const raw = getSetting(STATE_KEY);
    if (!raw) return fallback;
    const saved = JSON.parse(raw) as State;
    const width = Math.max(MIN_WIDTH, Math.round(saved.width) || fallback.width);
    const height = Math.max(MIN_HEIGHT, Math.round(saved.height) || fallback.height);
    const out: State = { width, height, maximized: !!saved.maximized };
    if (typeof saved.x === 'number' && typeof saved.y === 'number') {
      /*
       * Focení se často dělá na druhé obrazovce u stolu s fotoaparátem. Když
       * ta zrovna není připojená, okno by se otevřelo mimo viditelnou plochu
       * a vypadalo by to, že se nestalo nic.
       */
      const visible = screen.getAllDisplays().some(display => {
        const area = display.workArea;
        return saved.x! < area.x + area.width && saved.x! + width > area.x
          && saved.y! < area.y + area.height && saved.y! + height > area.y;
      });
      if (visible) { out.x = Math.round(saved.x); out.y = Math.round(saved.y); }
    }
    return out;
  } catch {
    return fallback;
  }
}

function saveState(): void {
  const win = shootWindow;
  if (!win || win.isDestroyed()) return;
  try {
    const bounds = win.isMaximized() || win.isFullScreen() ? win.getNormalBounds() : win.getBounds();
    setSetting(STATE_KEY, JSON.stringify({
      x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
      maximized: win.isMaximized()
    }));
  } catch { /* zapamatování okna není kritické */ }
}

export function openShootWindow(): boolean {
  if (shootWindow && !shootWindow.isDestroyed()) {
    if (shootWindow.isMinimized()) shootWindow.restore();
    shootWindow.focus();
    return true;
  }

  const state = loadState();
  shootWindow = new BrowserWindow({
    ...(state.x !== undefined ? { x: state.x, y: state.y } : {}),
    width: state.width,
    height: state.height,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    title: 'Focení — Quentino App',
    /*
     * Tmavé pozadí, a to i ve světlém režimu. Světlost okolo náhledu mění,
     * jak se barva na fotce jeví — u bílého pozadí produktu by se podle
     * světlého rámu doostřovalo a dobělovalo špatně.
     */
    backgroundColor: '#15151a',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true
    }
  });

  shootWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url);
    return { action: 'deny' };
  });

  if (state.maximized) shootWindow.maximize();

  let timer: NodeJS.Timeout | null = null;
  const later = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(saveState, 400);
  };
  shootWindow.on('resize', later);
  shootWindow.on('move', later);
  shootWindow.on('maximize', later);
  shootWindow.on('unmaximize', later);
  shootWindow.on('close', () => {
    if (timer) clearTimeout(timer);
    saveState();
  });
  shootWindow.on('closed', () => { shootWindow = null; });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) shootWindow.loadURL(`${devUrl}#foceni`);
  else shootWindow.loadFile(path.join(__dirname, '../../renderer/index.html'), { hash: 'foceni' });

  return true;
}

export function shootWindowOpen(): boolean {
  return !!shootWindow && !shootWindow.isDestroyed();
}

export function closeShootWindow(): boolean {
  if (shootWindow && !shootWindow.isDestroyed()) shootWindow.close();
  return true;
}
