import fs from 'fs';
import path from 'path';
import { BrowserWindow } from 'electron';
import type { CameraSession } from './session';

/**
 * Živý náhled.
 *
 * ## Proč `capture-preview` ve smyčce a ne `--capture-movie`
 *
 * `--capture-movie --stdout` umí souvislý proud, ale drží fotoaparát celý
 * čas obsazený — dokud běží, nejde na tomtéž spojení nic jiného, takže by
 * se kvůli každému vyfocení a každé změně ISO musel náhled ukončit a znovu
 * spustit. Na těle to vypadá jako bliknutí zrcátka a trvá to skoro vteřinu.
 * Opakované `capture-preview` vrací tytéž snímky po jednom, mezi ně se dá
 * vsunout příkaz a náhled u toho nezhasne.
 *
 * ## Proč se snímek posílá jako bajty, ne jako data URL
 *
 * Náhled má patnáct snímků za vteřinu po zhruba sto kilobajtech. Jako
 * `data:` řetězec by to bylo o třetinu víc dat a hlavně by se každou
 * vteřinu naskládalo pár megabajtů řetězců k uklizení. Bajty projdou beze
 * změny a v okně z nich vznikne `Blob`, který se po výměně hned uvolní.
 */

/** Jméno, pod kterým gphoto2 ukládá snímek náhledu, když se nezadá jiné. */
const PREVIEW_FILE = 'capture_preview.jpg';

type Loop = {
  stop: boolean;
  /** Náhled je pozastavený, dokud se fotí nebo mění nastavení. */
  hold: number;
};

let loop: Loop | null = null;

export function livePaused(): boolean {
  return !!loop && loop.hold > 0;
}

export function liveRunning(): boolean {
  return !!loop && !loop.stop;
}

function emit(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload);
}

/**
 * Pozastaví náhled na dobu, než doběhne `work`.
 *
 * Bez toho by se při focení poslal `capture-preview` těsně za spoušť a
 * některá těla na to odpoví chybou „PTP Device Busy", která vypadá jako
 * porucha, ale je to jen předběhnutá fronta.
 */
export async function hold<T>(work: () => Promise<T>): Promise<T> {
  if (loop) loop.hold++;
  try {
    return await work();
  } finally {
    if (loop) loop.hold = Math.max(0, loop.hold - 1);
  }
}

export function startLive(session: CameraSession): void {
  if (loop && !loop.stop) return;
  const mine: Loop = { stop: false, hold: 0 };
  loop = mine;

  const file = path.join(session.dir, PREVIEW_FILE);

  (async () => {
    let misses = 0;
    while (!mine.stop) {
      if (mine.hold > 0 || !session.alive) {
        await wait(60);
        if (!session.alive) break;
        continue;
      }
      const reply = await session.send('capture-preview', { timeout: 12000 });
      if (mine.stop) break;
      if (!reply.ok) {
        /*
         * Jedna chyba nic neznamená — tělo zrovna ostří nebo dopisuje na
         * kartu. Teprve když se náhled nepovede pětkrát po sobě, je to
         * porucha a má se to říct, ne mlčky zkoušet dál donekonečna.
         */
        if (++misses >= 5) {
          emit('shoot:live', { running: false, error: reply.error || 'náhled se nepovedl' });
          break;
        }
        await wait(300);
        continue;
      }
      misses = 0;
      const bytes = readFrame(file, reply.text, session.dir);
      if (bytes) emit('shoot:frame', bytes);
    }
    if (loop === mine) loop = null;
    if (!mine.stop) emit('shoot:live', { running: false, error: '' });
  })();

  emit('shoot:live', { running: true, error: '' });
}

export function stopLive(): void {
  if (loop) loop.stop = true;
  loop = null;
  emit('shoot:live', { running: false, error: '' });
}

/**
 * Přečte snímek náhledu z disku.
 *
 * Jméno souboru se čte z výpisu („Saving file as …"), protože není zaručené:
 * některá těla vrací náhled jako `capture_preview.jpg`, jiná pod vlastním
 * jménem. Pevné jméno je až poslední záchrana.
 */
export function readFrame(fallback: string, text: string, dir: string): Uint8Array | null {
  const named = /Saving file as (.+?)\s*$/m.exec(String(text ?? ''));
  const candidates = named ? [path.resolve(dir, named[1]), fallback] : [fallback];
  for (const file of candidates) {
    try {
      const bytes = fs.readFileSync(file);
      if (bytes.length > 2) return new Uint8Array(bytes);
    } catch { /* další pokus */ }
  }
  return null;
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export const __test = { readFrame, PREVIEW_FILE };
