import { BrowserWindow, dialog, app, shell } from 'electron';
import fs from 'fs';
import path from 'path';
import { spawn, execFile } from 'child_process';
import { getSetting, setSetting } from './db';
import crypto from 'crypto';
import type { MediaSetup, MediaFile, MediaResult, MediaTool, MediaWatch, MediaLogRow }
  from '../shared/types';

/**
 * Převod fotek a videí do formátů pro web.
 *
 * ## Proč to je v aplikaci
 *
 * Do článků a na e-shop se nahrávají fotky z foťáku — pětimegabajtové JPEG
 * o šesti tisících pixelech. Stránka se s nimi načítá vteřiny a Google to
 * počítá. Převádět je jedním z webových nástrojů znamená nahrát vlastní
 * fotky na cizí server a stáhnout zpátky; udělat to dávkou v terminálu umí
 * málokdo. Tohle je ta nudná práce, kterou má dělat program.
 *
 * ## Jak se to převádí
 *
 * **Obrázky v Chromiu, které v aplikaci stejně běží.** Electron má v sobě
 * kompletní prohlížeč i s kodérem WebP — obrázek se vykreslí na plátno
 * a plátno se uloží jako WebP. Žádná nativní knihovna navíc, žádné
 * překládání při instalaci, na Macu i na Windows stejný výsledek. Samotný
 * převod proto dělá okno aplikace, ne tenhle modul; tady se jen čte a píše.
 *
 * **Videa přes ffmpeg, když v počítači je.** Kodér videa v prohlížeči není
 * a přehrát video do `MediaRecorder` by znamenalo čekat celou jeho délku
 * a přijít o kvalitu. ffmpeg to udělá pořádně — a když v počítači není,
 * řekne se to rovnou i s tím, jak ho doinstalovat. Tvářit se, že to jde,
 * a vrátit pokažený soubor je horší než přiznat, že chybí nástroj.
 */

const KEY = 'mediaSetup';

const DEFAULTS: MediaSetup = {
  /*
   * Osmdesát dva je hodnota, kde na fotce látky a vazby ještě nejsou vidět
   * artefakty a soubor už je zlomkový. Níž se to na jemné struktuře kravat
   * začne rozpadat dřív, než si toho člověk na náhledu všimne.
   */
  quality: 82,
  resize: 'max',
  maxWidth: 1600,
  maxHeight: 1600,
  exactWidth: 1000,
  exactHeight: 1000,
  percent: 50,
  // Zvětšovat nemá smysl: z malé fotky se velká neudělá, jen se rozmaže
  keepSmaller: true,
  videoCodec: 'vp9',
  videoCrf: 33,
  videoWidth: 1280,
  videoAudio: 96,
  outDir: ''
};

export function mediaSetup(): MediaSetup {
  try {
    const saved = JSON.parse(getSetting(KEY, '{}') ?? '{}');
    return { ...DEFAULTS, ...saved };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveMediaSetup(patch: Partial<MediaSetup>): MediaSetup {
  const next = { ...mediaSetup(), ...patch };
  setSetting(KEY, JSON.stringify(next));
  return next;
}

/* ---------- vstupní soubory ---------- */

const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'avif', 'heic'];
const VIDEO_EXT = ['mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm', 'mpg', 'mpeg', 'wmv'];

function kindOf(file: string): 'image' | 'video' | 'other' {
  const ext = path.extname(file).replace('.', '').toLowerCase();
  if (IMAGE_EXT.includes(ext)) return 'image';
  if (VIDEO_EXT.includes(ext)) return 'video';
  return 'other';
}

function describe(file: string): MediaFile | null {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return null;
    const kind = kindOf(file);
    if (kind === 'other') return null;
    return { path: file, name: path.basename(file), size: stat.size, kind };
  } catch {
    return null;
  }
}

/** Výběr souborů. Vrací i ty, které se přetáhnou do okna — proto samostatně. */
export async function pickMedia(): Promise<MediaFile[]> {
  const win = BrowserWindow.getFocusedWindow();
  const res = await dialog.showOpenDialog(win!, {
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Fotky a videa', extensions: [...IMAGE_EXT, ...VIDEO_EXT] },
      { name: 'Fotky', extensions: IMAGE_EXT },
      { name: 'Videa', extensions: VIDEO_EXT }
    ]
  });
  if (res.canceled) return [];
  return res.filePaths.map(describe).filter(Boolean) as MediaFile[];
}

/** Soubory přetažené do okna — z prohlížeče přijdou jen cesty. */
export function addMedia(paths: string[]): MediaFile[] {
  return (paths ?? []).map(describe).filter(Boolean) as MediaFile[];
}

/** Obsah souboru pro převod v okně. */
export function readMedia(file: string): Uint8Array {
  return new Uint8Array(fs.readFileSync(file));
}

export async function pickOutDir(): Promise<string> {
  const win = BrowserWindow.getFocusedWindow();
  const res = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] });
  if (res.canceled || res.filePaths.length === 0) return mediaSetup().outDir;
  return saveMediaSetup({ outDir: res.filePaths[0] }).outDir;
}

function outFolder(): string {
  const saved = mediaSetup().outDir;
  if (saved && fs.existsSync(saved)) return saved;
  // Bez vlastní složky vedle stažených souborů — tam je člověk hledá
  const fallback = path.join(app.getPath('downloads'), 'quentino-web');
  fs.mkdirSync(fallback, { recursive: true });
  return fallback;
}

/**
 * Uloží převedený soubor.
 *
 * Původní se **nepřepisuje nikdy**, ani když má stejné jméno: originál
 * fotky je jediná verze, ze které jde převod udělat znovu jinak. Když
 * cílový název existuje, přidá se pořadové číslo.
 */
export function writeMedia(name: string, bytes: Uint8Array): { file: string; size: number } {
  const dir = outFolder();
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let file = path.join(dir, name);
  for (let i = 2; fs.existsSync(file); i++) file = path.join(dir, `${base}-${i}${ext}`);
  fs.writeFileSync(file, bytes);
  return { file, size: fs.statSync(file).size };
}

export function revealMedia(file: string): void {
  if (file && fs.existsSync(file)) shell.showItemInFolder(file);
  else shell.openPath(outFolder());
}

/* ---------- video ---------- */

/** Kde ffmpeg bývá. `which` na Macu v aplikaci nefunguje — PATH je jiná. */
const FFMPEG_PLACES = [
  '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg',
  'C:\\ffmpeg\\bin\\ffmpeg.exe', 'ffmpeg'
];

let ffmpegPath: string | null = null;

/**
 * Najde ffmpeg.
 *
 * Hledá se v obvyklých místech, ne přes `which`: aplikace spuštěná
 * z Finderu nemá `PATH` z uživatelského shellu, takže `which` v ní
 * nenajde ani to, co v terminálu funguje. Poslední pokus je holé
 * „ffmpeg" pro případ, že `PATH` výjimečně sedí.
 */
export async function findFfmpeg(): Promise<MediaTool> {
  const saved = (getSetting('mediaFfmpeg', '') ?? '').trim();
  const places = saved ? [saved, ...FFMPEG_PLACES] : FFMPEG_PLACES;

  for (const candidate of places) {
    const version = await new Promise<string>(resolve => {
      execFile(candidate, ['-version'], { timeout: 4000 }, (err, out) => {
        resolve(err ? '' : String(out).split('\n')[0]);
      });
    });
    if (version) {
      ffmpegPath = candidate;
      return { ok: true, path: candidate, version, note: '' };
    }
  }
  ffmpegPath = null;
  return {
    ok: false,
    path: '',
    version: '',
    note: process.platform === 'darwin'
      ? 'ffmpeg v počítači není. Nainstaluje se příkazem „brew install ffmpeg" v Terminálu.'
      : 'ffmpeg v počítači není. Stáhni ho z ffmpeg.org a cestu k němu vyplň v nastavení.'
  };
}

export function saveFfmpegPath(value: string): string {
  setSetting('mediaFfmpeg', (value ?? '').trim());
  ffmpegPath = null;
  return getSetting('mediaFfmpeg', '')!;
}

function emit(channel: string, payload: unknown) {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload);
}

/** Z „Duration: 00:01:23.45" udělá vteřiny — kvůli procentům postupu. */
export function secondsOf(line: string): number {
  const found = /(\d+):(\d\d):(\d\d(?:\.\d+)?)/.exec(line);
  if (!found) return 0;
  return Number(found[1]) * 3600 + Number(found[2]) * 60 + Number(found[3]);
}

/**
 * Parametry pro ffmpeg.
 *
 * VP9 s `-crf` a `-b:v 0` je režim „konstantní kvalita": bitrate si ffmpeg
 * zvolí sám podle obsahu, takže klidná scéna zabere míň a pohyb víc. Pevný
 * bitrate by u statického záběru plýtval a u pohybu se rozsypal.
 *
 * `scale=W:-2` dopočítá výšku a zaokrouhlí na sudé číslo — liché rozměry
 * kodéry videa odmítají.
 */
export function ffmpegArgs(input: string, output: string, setup: MediaSetup): string[] {
  const args = ['-y', '-i', input];
  if (setup.videoWidth > 0) args.push('-vf', `scale='min(${setup.videoWidth},iw)':-2`);
  args.push(
    '-c:v', setup.videoCodec === 'vp8' ? 'libvpx' : 'libvpx-vp9',
    '-crf', String(setup.videoCrf),
    '-b:v', '0',
    // Bez tohohle jede VP9 na jednom jádře a převod trvá násobně dýl
    '-row-mt', '1',
    '-pix_fmt', 'yuv420p'
  );
  if (setup.videoAudio > 0) args.push('-c:a', 'libopus', '-b:a', `${setup.videoAudio}k`);
  else args.push('-an');
  args.push(output);
  return args;
}

let running: ReturnType<typeof spawn> | null = null;

export function stopVideo(): void {
  try { running?.kill('SIGTERM'); } catch { /* už doběhlo */ }
  running = null;
}

/**
 * Převede jedno video do WebM.
 *
 * Postup se hlásí průběžně: převod minutového videa trvá i minuty a bez
 * ukazatele to vypadá, že se aplikace zasekla.
 */
export async function convertVideo(file: string): Promise<MediaResult> {
  const tool = await findFfmpeg();
  if (!tool.ok) throw new Error(tool.note);

  const setup = mediaSetup();
  const before = fs.statSync(file).size;
  const name = `${path.basename(file, path.extname(file))}.webm`;
  const dir = outFolder();
  let target = path.join(dir, name);
  for (let i = 2; fs.existsSync(target); i++) {
    target = path.join(dir, `${path.basename(file, path.extname(file))}-${i}.webm`);
  }

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(ffmpegPath || tool.path, ffmpegArgs(file, target, setup));
    running = proc;
    let total = 0;
    let last = '';

    proc.stderr.on('data', chunk => {
      const text = String(chunk);
      last = text.trim().split('\n').pop() ?? last;
      const duration = /Duration:\s*([\d:.]+)/.exec(text);
      if (duration) total = secondsOf(duration[1]);
      const at = /time=\s*([\d:.]+)/.exec(text);
      if (at && total > 0) {
        emit('media:progress', {
          file: path.basename(file),
          percent: Math.min(99, Math.round((secondsOf(at[1]) / total) * 100))
        });
      }
    });

    proc.on('error', err => { running = null; reject(err); });
    proc.on('close', code => {
      running = null;
      if (code === 0) resolve();
      // Hláška ffmpegu je přesnější než cokoli, co bychom vymysleli
      else reject(new Error(`ffmpeg skončil s chybou (${code}): ${last.slice(0, 200)}`));
    });
  });

  const after = fs.statSync(target).size;
  emit('media:progress', { file: path.basename(file), percent: 100 });
  return { file: target, name: path.basename(target), before, after };
}

/* ---------- hlídané složky pro focení ---------- */

/**
 * Složka, do které se sypou fotky z foťáku.
 *
 * ## Proč to takhle
 *
 * Nafotí se deset motýlků nastejno a všechny se ořezávají stejně. Dělat to
 * po jedné je desetkrát tatáž práce; nastavit ořez jednou a nechat aplikaci
 * zpracovat, co do složky přibude, je ta práce jednou.
 *
 * ## Kde se to převádí
 *
 * Tady se jen **hlídá a hlásí**; převod dělá okno aplikace, protože kodér
 * WebP je v Chromiu. Hlavní proces nemá jak obrázek zakódovat, aniž by se
 * přibalila nativní knihovna — a ta by se musela překládat při každé
 * instalaci na každé platformě.
 *
 * ## Na co si dát pozor
 *
 * Fotoaparát a systém soubor **zapisují postupně**. Kdyby se sáhlo hned po
 * prvním hlášení, načetla by se polovina snímku. Proto se čeká, až velikost
 * dvakrát po sobě sedí; teprve pak je soubor hotový.
 */

const WATCH_KEY = 'mediaWatch';
const LOG_KEY = 'mediaWatchLog';

export function watchFolders(): MediaWatch[] {
  try {
    const saved = JSON.parse(getSetting(WATCH_KEY, '[]') ?? '[]');
    return Array.isArray(saved) ? saved.map(normalizeWatch) : [];
  } catch {
    return [];
  }
}

function normalizeWatch(row: any): MediaWatch {
  const base = mediaSetup();
  return {
    id: String(row?.id ?? '') || crypto.randomUUID(),
    path: String(row?.path ?? ''),
    enabled: row?.enabled !== false,
    // Podsložka uvnitř složky s originály: výsledky leží u nich, ale zvlášť
    subfolder: String(row?.subfolder ?? '').trim() || 'web',
    crop: row?.crop && typeof row.crop === 'object'
      ? { x: +row.crop.x || 0, y: +row.crop.y || 0, w: +row.crop.w || 1, h: +row.crop.h || 1 }
      : null,
    quality: Number(row?.quality) || base.quality,
    resize: ['keep', 'max', 'exact', 'percent'].includes(row?.resize) ? row.resize : base.resize,
    maxWidth: Number(row?.maxWidth) || base.maxWidth,
    maxHeight: Number(row?.maxHeight) || base.maxHeight,
    exactWidth: Number(row?.exactWidth) || base.exactWidth,
    exactHeight: Number(row?.exactHeight) || base.exactHeight,
    percent: Number(row?.percent) || base.percent,
    keepSmaller: row?.keepSmaller !== false,
    done: Number(row?.done) || 0,
    lastAt: String(row?.lastAt ?? '')
  };
}

function writeWatches(list: MediaWatch[]): MediaWatch[] {
  setSetting(WATCH_KEY, JSON.stringify(list));
  restartWatchers();
  return watchFolders();
}

export async function addWatchFolder(): Promise<MediaWatch[]> {
  const win = BrowserWindow.getFocusedWindow();
  const res = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] });
  if (res.canceled || res.filePaths.length === 0) return watchFolders();
  const folder = res.filePaths[0];
  const list = watchFolders();
  if (list.some(one => one.path === folder)) return list;
  list.push(normalizeWatch({ path: folder }));
  return writeWatches(list);
}

export function saveWatchFolder(id: string, patch: Partial<MediaWatch>): MediaWatch[] {
  return writeWatches(watchFolders().map(one =>
    (one.id === id ? normalizeWatch({ ...one, ...patch }) : one)));
}

export function removeWatchFolder(id: string): MediaWatch[] {
  return writeWatches(watchFolders().filter(one => one.id !== id));
}

/** Nejnovější fotka ve složce — z ní se nastavuje ořez pro celou dávku. */
export function newestInFolder(dir: string): MediaFile | null {
  try {
    const found = fs.readdirSync(dir)
      .filter(name => kindOf(name) === 'image')
      .map(name => {
        const full = path.join(dir, name);
        try { return { full, at: fs.statSync(full).mtimeMs }; } catch { return null; }
      })
      .filter(Boolean) as { full: string; at: number }[];
    if (found.length === 0) return null;
    found.sort((a, b) => b.at - a.at);
    return describe(found[0].full);
  } catch {
    return null;
  }
}

export function watchLog(): MediaLogRow[] {
  try {
    const saved = JSON.parse(getSetting(LOG_KEY, '[]') ?? '[]');
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

/** Zápis výsledku z hlídané složky — volá ho okno, které převod udělalo. */
export function noteWatched(row: MediaLogRow): MediaLogRow[] {
  // Posledních padesát stačí: je to potvrzení, že to jede, ne archiv
  const list = [row, ...watchLog()].slice(0, 50);
  setSetting(LOG_KEY, JSON.stringify(list));
  if (!row.error) {
    const folders = watchFolders().map(one => (one.path === row.folder
      ? { ...one, done: one.done + 1, lastAt: row.at }
      : one));
    setSetting(WATCH_KEY, JSON.stringify(folders));
  }
  emit('media:watched', { log: list });
  return list;
}

/**
 * Uloží převedenou fotku do podsložky vedle originálu.
 *
 * Podsložka se založí, když není. Když stejný název už existuje, **nechá
 * se být**: hlídaná složka běží na pozadí a přepisovat v ní bez ptaní
 * něco, co už jednou vzniklo, je způsob, jak tiše přijít o práci.
 */
export function writeBeside(source: string, subfolder: string, bytes: Uint8Array):
  { file: string; size: number; skipped: boolean } {
  const dir = path.join(path.dirname(source), subfolder || 'web');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${path.basename(source, path.extname(source))}.webp`);
  if (fs.existsSync(file)) return { file, size: fs.statSync(file).size, skipped: true };
  fs.writeFileSync(file, bytes);
  return { file, size: fs.statSync(file).size, skipped: false };
}

/* ---------- samotné hlídání ---------- */

const watchers = new Map<string, fs.FSWatcher>();
/** Co se právě zapisuje; podruhé už se to nehlásí */
const pending = new Map<string, NodeJS.Timeout>();

/** Počká, až soubor přestane růst. Fotoaparát ho zapisuje po částech. */
function whenStable(file: string, tries = 20): Promise<boolean> {
  return new Promise(resolve => {
    let last = -1;
    let left = tries;
    const tick = () => {
      let size = -1;
      try { size = fs.statSync(file).size; } catch { return resolve(false); }
      if (size > 0 && size === last) return resolve(true);
      last = size;
      if (--left <= 0) return resolve(size > 0);
      setTimeout(tick, 400);
    };
    setTimeout(tick, 400);
  });
}

function onNewFile(folder: MediaWatch, name: string): void {
  if (kindOf(name) !== 'image') return;
  const file = path.join(folder.path, name);
  if (pending.has(file)) return;

  const timer = setTimeout(async () => {
    pending.delete(file);
    if (!fs.existsSync(file)) return;
    // Co už jednou vzniklo, se znovu nepřevádí — jinak by se kolo točilo pořád
    const target = path.join(path.dirname(file), folder.subfolder || 'web',
      `${path.basename(file, path.extname(file))}.webp`);
    if (fs.existsSync(target)) return;
    if (!(await whenStable(file))) return;
    const info = describe(file);
    if (info) emit('media:incoming', { folder, file: info });
  }, 600);

  pending.set(file, timer);
}

export function restartWatchers(): void {
  for (const watcher of watchers.values()) { try { watcher.close(); } catch { /* už zavřený */ } }
  watchers.clear();

  for (const folder of watchFolders()) {
    if (!folder.enabled || !folder.path) continue;
    try {
      if (!fs.existsSync(folder.path)) continue;
      const watcher = fs.watch(folder.path, { persistent: false }, (_event, name) => {
        if (name) onNewFile(folder, String(name));
      });
      watcher.on('error', () => { /* složka zmizela; hlídání se obnoví při dalším uložení */ });
      watchers.set(folder.id, watcher);
    } catch {
      // Nepřístupná složka není důvod shodit ostatní
    }
  }
}

export const __test = {
  ffmpegArgs, secondsOf, kindOf, DEFAULTS, normalizeWatch, writeBeside
};
