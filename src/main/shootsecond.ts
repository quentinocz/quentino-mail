import { BrowserWindow, screen, shell } from 'electron';
import path from 'path';
import { getSetting, setSetting } from './db';
import type { ShootSecond, ShootScreen } from '../shared/types';

/**
 * Druhá obrazovka u focení.
 *
 * ## K čemu to je
 *
 * U stolu s fotoaparátem stojí monitor, na kterém se kontroluje, co je
 * v záběru — a na tom se nemá co dělit o místo s panely, galerií a
 * nastavením. Na velké obrazovce je proto přes celou plochu jedna věc:
 * buď živý náhled, nebo mřížka nafoceného. V okně aplikace zůstane ta
 * druhá, aby se obojí vidělo zároveň a nemuselo přepínat.
 *
 * ## Proč se neotvírá samo
 *
 * Připojený druhý monitor ještě neznamená, že se na něm fotí — může na
 * něm být pošta. Okno se proto otevře až na vyžádání a pamatuje si, na
 * které obrazovce bylo, aby se příště nemuselo vybírat znovu.
 */

const KEY = 'shootSecond';

let secondWindow: BrowserWindow | null = null;
let watching = false;

const DEFAULTS: ShootSecond = {
  open: false, displayId: 0, mode: 'live', tile: 220, webcam: '', webcamLabel: ''
};

/** Které zařízení webkamery zrovna běží. Drží se jen za běhu, viz `save`. */
let webcam = '';
let webcamLabel = '';

export function secondSetup(): ShootSecond {
  try {
    const saved = JSON.parse(getSetting(KEY, '{}') ?? '{}');
    return {
      ...DEFAULTS,
      ...saved,
      webcam,
      webcamLabel,
      open: !!secondWindow && !secondWindow.isDestroyed()
    };
  } catch {
    return { ...DEFAULTS, webcam, webcamLabel };
  }
}

function save(patch: Partial<ShootSecond>): ShootSecond {
  const next = { ...secondSetup(), ...patch };
  /*
   * Zařízení webkamery se **neukládá**. Platí jen pro spuštěné okno —
   * po restartu už žádný proud neběží a uložená hodnota by velkou
   * obrazovku nechala čekat na obraz, který nikdo neposílá.
   */
  setSetting(KEY, JSON.stringify({ displayId: next.displayId, mode: next.mode, tile: next.tile }));
  return next;
}

/**
 * Připojené obrazovky.
 *
 * Popisek je rozměr, ne jméno — jméno systém u většiny monitorů nevrací
 * a „Neznámý displej" v nabídce nepomůže vybrat ten správný.
 */
export function screens(): ShootScreen[] {
  const primary = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map(one => ({
    id: one.id,
    primary: one.id === primary,
    width: one.size.width,
    height: one.size.height,
    label: `${one.size.width} × ${one.size.height}${one.id === primary ? ' (hlavní)' : ''}`
  }));
}

/** Kterou obrazovku použít. Uložená, jinak první, která není hlavní. */
function pickDisplay(wanted: number) {
  const all = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay().id;
  return all.find(one => one.id === wanted)
    ?? all.find(one => one.id !== primary)
    ?? all[0];
}

function emit(payload: ShootSecond): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('shoot:second', payload);
}

/**
 * Hlídá odpojení monitoru.
 *
 * Odpojený monitor by nechal okno viset mimo viditelnou plochu — na
 * obrazovce po něm nezbyde nic a zavřít se nedá, protože ho není vidět.
 */
function watchDisplays(): void {
  if (watching) return;
  watching = true;
  screen.on('display-removed', () => {
    if (!secondWindow || secondWindow.isDestroyed()) return;
    const where = secondWindow.getBounds();
    const still = screen.getAllDisplays().some(one => {
      const area = one.bounds;
      return where.x < area.x + area.width && where.x + where.width > area.x
        && where.y < area.y + area.height && where.y + where.height > area.y;
    });
    if (!still) closeSecond();
  });
}

export function openSecond(displayId: number, mode: ShootSecond['mode']): ShootSecond {
  watchDisplays();
  const setup = save({ displayId, mode });
  const display = pickDisplay(displayId);
  if (!display) return { ...setup, open: false };

  if (secondWindow && !secondWindow.isDestroyed()) {
    /*
     * Otevřené okno se jen přestěhuje. Zavřít a otevřít znovu by
     * znamenalo, že na vteřinu zmizí náhled — a to je zrovna ta vteřina,
     * kdy se čeká na to, až se produkt přestane houpat.
     */
    secondWindow.setFullScreen(false);
    secondWindow.setBounds(display.bounds);
    secondWindow.setFullScreen(true);
    secondWindow.focus();
    const next = { ...setup, open: true };
    emit(next);
    return next;
  }

  secondWindow = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    title: 'Focení — velká obrazovka',
    backgroundColor: '#000000',
    // Bez rámu a bez menu: na téhle obrazovce se nemá co ovládat, jen kouká
    frame: false,
    fullscreen: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  secondWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url);
    return { action: 'deny' };
  });
  secondWindow.on('closed', () => {
    secondWindow = null;
    emit({ ...secondSetup(), open: false });
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) secondWindow.loadURL(`${devUrl}#foceni-velka`);
  else secondWindow.loadFile(path.join(__dirname, '../../renderer/index.html'), { hash: 'foceni-velka' });

  const next = { ...setup, open: true };
  emit(next);
  return next;
}

export function closeSecond(): ShootSecond {
  if (secondWindow && !secondWindow.isDestroyed()) secondWindow.close();
  secondWindow = null;
  const next = { ...secondSetup(), open: false };
  emit(next);
  return next;
}

/** Přepnutí mezi náhledem a mřížkou. Okno v aplikaci ukáže to druhé. */
export function setSecond(patch: Partial<ShootSecond>): ShootSecond {
  if (patch.webcam !== undefined) webcam = patch.webcam;
  if (patch.webcamLabel !== undefined) webcamLabel = patch.webcamLabel;
  const next = {
    ...save(patch), webcam, webcamLabel,
    open: !!secondWindow && !secondWindow.isDestroyed()
  };
  emit(next);
  return next;
}

export function closeSecondQuietly(): void {
  if (secondWindow && !secondWindow.isDestroyed()) secondWindow.destroy();
  secondWindow = null;
}
