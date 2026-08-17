import { app, BrowserWindow, shell, powerMonitor, screen } from 'electron';
import path from 'path';
import fs from 'fs';
import { installSystemCa } from './systemca';
import { registerIpc } from './ipc';
import { startScheduler } from './scheduler';
import { syncAllAccounts } from './imap';
import { getDb, getSetting, setSetting } from './db';
import { backfillContacts } from './contacts';
import { setHtmlRenderer, clearTrackingCache } from './ordertrack';
import { renderPage } from './render';
import { handleCallbackUrl } from './instagram';

let mainWindow: BrowserWindow | null = null;

/**
 * Přejmenování aplikace na Quentino App by jinak znamenalo ztrátu dat: Electron
 * odvozuje složku s databází od názvu, takže po přejmenování by aplikace
 * naskočila prázdná. Složku proto jednorázově přesuneme; kdyby to nešlo
 * (otevřené soubory, práva), zůstaneme u té staré.
 */
function keepUserData() {
  try {
    const next = app.getPath('userData');
    const previous = path.join(path.dirname(next), 'Quentino Mail');
    if (next === previous || fs.existsSync(next) || !fs.existsSync(previous)) return;
    try {
      fs.renameSync(previous, next);
    } catch {
      app.setPath('userData', previous);
    }
  } catch { /* nová instalace nemá co přesouvat */ }
}

keepUserData();

/**
 * Návrat z přihlášení k Instagramu. Prohlížeč otevře odkaz
 * `quentino-mail://ig-oauth?...`; podle systému přijde buď jako událost
 * `open-url` (macOS), nebo v parametrech druhého spuštění (Windows).
 */
const IG_PROTOCOL = 'quentino-mail';

function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

async function handleDeepLink(url: string) {
  if (!url || !url.startsWith(`${IG_PROTOCOL}://`)) return;
  focusMainWindow();
  try {
    const result = await handleCallbackUrl(url);
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('ig:connected', result);
  } catch (e: any) {
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.send('ig:connected', { error: e?.message ?? String(e) });
    }
  }
}

function deepLinkFromArgv(argv: string[]): string | null {
  return argv.find(a => a.startsWith(`${IG_PROTOCOL}://`)) ?? null;
}

/** Po jak dlouhé pauze se považují stavy objednávek za zastaralé */
const FRESHEN_AFTER = 10 * 60_000;
let lastFreshen = Date.now();

function freshenIfStale() {
  if (Date.now() - lastFreshen < FRESHEN_AFTER) return;
  lastFreshen = Date.now();
  clearTrackingCache();
}

/** Chyby sítě, které nesmí shodit aplikaci — typicky useknuté spojení při uspání. */
const NETWORK_ERRORS = /ECONNRESET|EPIPE|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|ECONNABORTED|EAI_AGAIN|socket hang up|Socket closed|read ECONNRESET|Connection closed/i;

/**
 * Poslední záchytná síť. Po probuzení počítače servery utnou navázaná spojení
 * a Node vyhodí ECONNRESET mimo jakýkoli await — bez tohohle Electron ukáže
 * dialog „Uncaught Exception" a aplikace spadne. Síťové chyby zahodíme,
 * ostatní si necháme vypsat do konzole, ale aplikaci taky nezabíjíme.
 */
function installCrashGuards() {
  process.on('uncaughtException', err => {
    const msg = `${(err as any)?.code ?? ''} ${err?.message ?? err}`;
    if (NETWORK_ERRORS.test(msg)) return;
    console.error('[uncaughtException]', err);
  });
  process.on('unhandledRejection', reason => {
    const msg = `${(reason as any)?.code ?? ''} ${(reason as any)?.message ?? reason}`;
    if (NETWORK_ERRORS.test(msg)) return;
    console.error('[unhandledRejection]', reason);
  });
}

// Panely nástrojů v chatu a na sociálních sítích potřebují víc místa než pošta;
// pod těmito rozměry by se tlačítka lámala do druhého řádku.
const MIN_WIDTH = 1180;
const MIN_HEIGHT = 760;

interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
}

/**
 * Poslední velikost a poloha okna.
 *
 * Uložená pozice se ověřuje proti aktuálním monitorům — po odpojení externího
 * displeje by okno jinak naskočilo mimo obrazovku a vypadalo by, že se aplikace
 * nespustila. Když se uložené umístění nikam nevejde, poloha se zahodí a okno
 * se vycentruje; velikost se zachová.
 */
function loadWindowState(): WindowState {
  // Výchozí okno je co největší, ale vždy s rezervou k okrajům obrazovky
  const area = screen.getPrimaryDisplay().workAreaSize;
  const fallback: WindowState = {
    width: Math.max(MIN_WIDTH, Math.min(1680, area.width - 80)),
    height: Math.max(MIN_HEIGHT, Math.min(1040, area.height - 60)),
    maximized: false
  };
  try {
    const raw = getSetting('windowState');
    if (!raw) return fallback;
    const s = JSON.parse(raw) as WindowState;

    const width = Math.max(MIN_WIDTH, Math.round(s.width) || fallback.width);
    const height = Math.max(MIN_HEIGHT, Math.round(s.height) || fallback.height);
    const out: WindowState = { width, height, maximized: !!s.maximized };

    if (typeof s.x === 'number' && typeof s.y === 'number') {
      // Okno musí aspoň z části zasahovat do některé z připojených obrazovek
      const visible = screen.getAllDisplays().some(d => {
        const a = d.workArea;
        return s.x! < a.x + a.width && s.x! + width > a.x
          && s.y! < a.y + a.height && s.y! + height > a.y;
      });
      if (visible) { out.x = Math.round(s.x); out.y = Math.round(s.y); }
    }
    return out;
  } catch {
    return fallback;
  }
}

function saveWindowState() {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  try {
    // V maximalizovaném či celoobrazovkovém stavu si pamatujeme rozměry, které
    // mělo okno předtím — jinak by se po obnovení nebylo kam vrátit
    const bounds = win.isMaximized() || win.isFullScreen() ? win.getNormalBounds() : win.getBounds();
    setSetting('windowState', JSON.stringify({
      x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
      maximized: win.isMaximized()
    }));
  } catch { /* zapamatování okna není kritické */ }
}

function createWindow() {
  const state = loadWindowState();

  mainWindow = new BrowserWindow({
    ...(state.x !== undefined ? { x: state.x, y: state.y } : {}),
    width: state.width,
    height: state.height,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    title: 'Quentino App',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#f6f5f8',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true
    }
  });

  // Externí odkazy vždy do systémového prohlížeče, nikdy do okna aplikace
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('http://localhost:5173') && !url.startsWith('file://')) {
      e.preventDefault();
      if (url.startsWith('http')) shell.openExternal(url);
    }
  });

  if (state.maximized) mainWindow.maximize();

  // Ukládá se se zpožděním — při tažení okna přijdou desítky událostí za vteřinu
  let saveTimer: NodeJS.Timeout | null = null;
  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveWindowState, 400);
  };
  mainWindow.on('resize', scheduleSave);
  mainWindow.on('move', scheduleSave);
  mainWindow.on('maximize', scheduleSave);
  mainWindow.on('unmaximize', scheduleSave);
  // Při zavření se uloží ještě jednou napevno, ať se nezahodí poslední změna
  mainWindow.on('close', () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveWindowState();
  });
  mainWindow.on('closed', () => { mainWindow = null; });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    mainWindow.loadURL(devUrl);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../renderer/index.html'));
  }
}

// Nad jednou SQLite databází smí běžet jen jedna instance; druhé spuštění
// jen probudí okno (a předá případný odkaz z prohlížeče).
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    focusMainWindow();
    const link = deepLinkFromArgv(argv);
    if (link) handleDeepLink(link);
  });
}

app.setAsDefaultProtocolClient(IG_PROTOCOL);
if (process.platform === 'win32') app.setAppUserModelId('cz.quentino.mail');

app.on('open-url', (e, url) => {
  e.preventDefault();
  handleDeepLink(url);
});

app.whenReady().then(() => {
  installCrashGuards();
  installSystemCa(); // kořeny z Keychainu ještě před prvním síťovým voláním
  getDb(); // inicializace DB + migrace
  setHtmlRenderer(renderPage); // dopravci, kteří stav vypisují až JavaScriptem
  try { backfillContacts(); } catch { /* jednorázové naplnění našeptávače */ }
  registerIpc();
  createWindow();
  startScheduler();
  // úvodní synchronizace na pozadí
  setTimeout(() => syncAllAccounts().catch(() => {}), 1500);

  // Odkaz, kterým se aplikace teprve spustila (Windows, studený start)
  const startLink = deepLinkFromArgv(process.argv);
  if (startLink) setTimeout(() => handleDeepLink(startLink), 2000);

  // Po probuzení jsou stará spojení mrtvá — chvíli počkáme na síť a natáhneme poštu znovu
  powerMonitor.on('resume', () => {
    lastFreshen = 0;
    freshenIfStale();
    setTimeout(() => syncAllAccounts().catch(() => {}), 4000);
  });

  // Stavy objednávek a zásilek se drží v paměti, aby se stránky nestahovaly
  // pořád dokola. Když se ale uživatel k aplikaci vrátí po delší pauze,
  // je nejspíš mezitím něco expedované — cache se proto zahodí a příští
  // otevřená objednávka si stav načte znovu.
  app.on('browser-window-focus', () => freshenIfStale());

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
