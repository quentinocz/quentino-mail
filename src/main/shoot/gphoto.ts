import { execFile, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { getSetting, setSetting } from '../db';
import type { ShootTool, ShootCamera } from '../../shared/types';

/**
 * Nalezení a rozpoznání fotoaparátu připojeného přes USB.
 *
 * ## Proč gphoto2 a ne něco vlastního
 *
 * Fotoaparát na USB mluví protokolem PTP a každá značka si k němu přidala
 * vlastní rozšíření — Canon jinak než Nikon, a Canon jinak podle řady.
 * Napsat to znovu je práce na roky; gphoto2 to dělá dvacet let a zná přes
 * dva tisíce těl. Aplikace tedy nesahá na USB sama, jen si s gphoto2 píše.
 *
 * ## Proč se hledá v cestách a ne přes `which`
 *
 * Totéž co u ffmpegu v `media.ts`: aplikace spuštěná z Finderu nedědí `PATH`
 * z uživatelského shellu, takže `which gphoto2` v ní nenajde ani to, co
 * v terminálu funguje.
 */

/** Kde gphoto2 bývá. Poslední pokus je holé jméno, kdyby `PATH` výjimečně seděla. */
const GPHOTO_PLACES = [
  '/opt/homebrew/bin/gphoto2', '/usr/local/bin/gphoto2', '/usr/bin/gphoto2',
  '/opt/local/bin/gphoto2', 'gphoto2'
];

let found = '';

export function gphotoBinary(): string {
  return found;
}

export async function findGphoto(): Promise<ShootTool> {
  const saved = (getSetting('shootGphoto', '') ?? '').trim();
  const places = saved ? [saved, ...GPHOTO_PLACES] : GPHOTO_PLACES;

  for (const candidate of places) {
    const version = await new Promise<string>(resolve => {
      execFile(candidate, ['--version'], { timeout: 4000 }, (err, out) => {
        resolve(err ? '' : String(out).split('\n')[0].trim());
      });
    });
    if (version) {
      found = candidate;
      return { ok: true, path: candidate, version, note: '' };
    }
  }
  found = '';
  return {
    ok: false,
    path: '',
    version: '',
    note: process.platform === 'darwin'
      ? 'gphoto2 v počítači není. Nainstaluje se příkazem „brew install gphoto2" v Terminálu. '
        + 'Bez něj zůstane živý náhled přes webkameru — fotoaparát v režimu webkamery, '
        + 'ale bez ovládání a bez fotek v plném rozlišení.'
      : 'gphoto2 pro Windows neexistuje. Připoj fotoaparát v režimu webkamery '
        + '(u Canonu „EOS Webcam Utility") — živý náhled a snímky z náhledu fungují, '
        + 'ovládání fotoaparátu a plné rozlišení ne.'
  };
}

export function saveGphotoPath(value: string): string {
  setSetting('shootGphoto', (value ?? '').trim());
  found = '';
  return getSetting('shootGphoto', '')!;
}

/**
 * macOS si fotoaparát zabere dřív než my.
 *
 * Jakmile se tělo připojí, spustí systém `PTPCamera` (pomocník Digitalizace
 * obrazu) a ten drží PTP relaci otevřenou. gphoto2 pak hlásí
 * „Could not claim the USB device" a nikde není vidět proč. Řešení je jediné,
 * které funguje a které používají všechny tetheringové aplikace: proces
 * ukončit. Systém si ho po odpojení fotoaparátu spustí znovu sám, takže se
 * tím nic trvale nerozbije.
 *
 * Na jiných systémech se nic nedělá — tam problém není.
 */
export async function freeCamera(): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  return new Promise(resolve => {
    execFile('/usr/bin/killall', ['PTPCamera'], { timeout: 4000 }, err => {
      // Nenulový návratový kód znamená „žádný takový proces" — to je v pořádku
      resolve(!err);
    });
  });
}

function run(args: string[], timeout = 15000): Promise<{ out: string; err: string }> {
  return new Promise(resolve => {
    if (!found) { resolve({ out: '', err: 'gphoto2 není' }); return; }
    execFile(found, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (error, out, errOut) => {
      resolve({ out: String(out ?? ''), err: error ? String(errOut ?? error.message) : '' });
    });
  });
}

/**
 * Přečte seznam připojených těl.
 *
 * Výstup `--auto-detect` je tabulka se dvěma sloupci oddělenými mezerami,
 * kde model sám mezery obsahuje („Canon EOS 250D"). Port je vždy poslední
 * slovo a má tvar `usb:001,004` — dělí se tedy odzadu, ne prvním oddělovačem.
 */
export function parseCameras(text: string): ShootCamera[] {
  const out: ShootCamera[] = [];
  for (const line of String(text ?? '').split('\n')) {
    const row = line.trimEnd();
    if (!row.trim()) continue;
    if (/^Model\s+Port/i.test(row.trim())) continue;
    if (/^-+$/.test(row.trim())) continue;
    const at = row.search(/\s+(usb|ptpip|serial|disk):\S*\s*$/);
    if (at < 0) continue;
    const model = row.slice(0, at).trim();
    const port = row.slice(at).trim();
    if (model && port) out.push({ model, port });
  }
  return out;
}

export async function detectCameras(): Promise<ShootCamera[]> {
  await freeCamera();
  const { out } = await run(['--auto-detect']);
  return parseCameras(out);
}

/** Složka, kam gphoto2 odkládá snímky náhledu, než je přečteme. */
export function workDir(): string {
  const dir = path.join(app.getPath('userData'), 'focení');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export const __test = { parseCameras, GPHOTO_PLACES };
export { run as runGphoto, spawn as spawnRaw };
