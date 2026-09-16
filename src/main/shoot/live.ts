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
  /** Splní se, až smyčka doopravdy skončí. */
  done: Promise<void>;
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

/**
 * Spustí náhled.
 *
 * ## Proč se čeká na doběhnutí předchozí smyčky
 *
 * Zastavení náhledu neukončí smyčku hned — ta ještě čeká na odpověď na
 * poslední `capture-preview`, což trvá desetinu vteřiny. Kdyby se mezitím
 * spustila druhá, běžely by obě: na tělo by chodily dva dotazy najednou,
 * náhled by blikal a fotoaparát hlásil, že je zaneprázdněný. Proto se
 * počká, až ta stará doopravdy skončí.
 */
export async function startLive(session: CameraSession): Promise<void> {
  if (loop && !loop.stop) return;
  // Předchozí smyčka ještě dobíhá — počká se na ni, ne aby běžely dvě
  if (loop) await loop.done;

  let finished = () => { /* nahradí se hned */ };
  const mine: Loop = {
    stop: false,
    hold: 0,
    done: new Promise<void>(resolve => { finished = resolve; })
  };
  loop = mine;

  const file = path.join(session.dir, PREVIEW_FILE);

  (async () => {
    let misses = 0;
    try {
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
          /*
           * Zaneprázdněné tělo potřebuje víc než okamžik. Ptát se hned
           * znovu ho jen drží zaneprázdněné dál a pět pokusů proletí
           * za vteřinu, takže se náhled vypne dřív, než se tělo vzpamatuje.
           */
          await wait(/-110|busy|0x2019/i.test(reply.error) ? 900 : 300);
          continue;
        }
        misses = 0;
        const bytes = readFrame(file, reply.text, session.dir);
        if (bytes) emit('shoot:frame', bytes);
      }
    } finally {
      /*
       * Uvolnit se musí **vždycky**, i když smyčka spadne. Jinak by na
       * `done` čekal příští start navěky a náhled by se už nikdy nerozjel.
       */
      if (loop === mine) loop = null;
      finished();
      if (!mine.stop) emit('shoot:live', { running: false, error: '' });
    }
  })();

  emit('shoot:live', { running: true, error: '' });
}

/**
 * Zastaví náhled.
 *
 * Odkaz na smyčku se **nezahazuje** — uklidí si ho sama, až doopravdy
 * skončí. Dřív se nulovala tady, takže se hned dala spustit druhá, zatímco
 * první ještě čekala na odpověď od těla; obě pak posílaly dotazy naráz
 * a náhled se zasekl tak, že ho nešlo spustit ani zastavit.
 */
export function stopLive(): void {
  if (loop) loop.stop = true;
  emit('shoot:live', { running: false, error: '' });
}

/** Počká, až náhled doopravdy skončí. Používá se při zavírání. */
export function liveSettled(): Promise<void> {
  return loop ? loop.done : Promise.resolve();
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
