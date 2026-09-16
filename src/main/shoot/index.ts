import fs from 'fs';
import path from 'path';
import { app, dialog, shell, BrowserWindow } from 'electron';
import { getSetting, setSetting } from '../db';
import * as store from './store';
import * as gphoto from './gphoto';
import * as config from './config';
import * as live from './live';
import * as preview from './preview';
import { CameraSession } from './session';
import type {
  Shoot, ShootPhoto, ShootState, ShootSettings, ShootTool, ShootCamera, CameraSetting
} from '../../shared/types';

/**
 * Focení produktů — spojení fotoaparátu, vodítek a hotových souborů.
 *
 * ## Co tenhle modul řeší
 *
 * Nafotit dvacet kravat tak, aby na e-shopu tvořily řadu, znamená mít u
 * každé stejný výřez, stejné světlo a stejné nastavení těla. Přes displej
 * fotoaparátu se to hlídá od oka a po deseti kusech se to rozjede. Tady je
 * tělo připojené k počítači, náhled je přes celou obrazovku, přes něj se dá
 * nakreslit rámeček, kam produkt patří, a jako průsvitka se dá podložit
 * fotka z minula.
 *
 * ## Dva způsoby připojení
 *
 * **Přes gphoto2** (Mac, Linux): plné ovládání — ISO, clona, čas, vyvážení
 * bílé, snímek v plném rozlišení rovnou do složky, včetně RAW.
 *
 * **Jako webkamera** (kdekoliv, u Canonu přes „EOS Webcam Utility"): jen
 * náhled a snímek z něj, tedy zhruba Full HD a bez ovládání těla. Je to
 * horší, ale funguje to na Windows, kde gphoto2 není. Tuhle větev obsluhuje
 * okno samo přes `getUserMedia`; sem chodí jen hotové bajty k uložení.
 */

const SETUP_KEY = 'shootSetup';

const DEFAULTS: ShootSettings = {
  /*
   * Ponechat snímky i na kartě. Přenos po USB umí selhat uprostřed focení
   * (uspané USB, uvolněný kabel) a nafocené zboží už zpátky nepostavíš
   * stejně; plná karta je menší problém než ztracená série.
   */
  keepOnCamera: true,
  /** Jak se pojmenují soubory. `%` je pořadové číslo v rámci focení. */
  pattern: '%n',
  webp: false,
  webpQuality: 82,
  lastFolder: '',
  backend: 'gphoto',
  /*
   * Který fotoaparát tu byl posledně — podle **modelu**, ne portu. Port
   * (`usb:008,001`) se mění při každém zapojení kabelu, takže zapamatovat
   * si ho znamená, že se podruhé nepozná nic.
   */
  lastCamera: ''
};

export function shootSetup(): ShootSettings {
  try {
    const saved = JSON.parse(getSetting(SETUP_KEY, '{}') ?? '{}');
    return { ...DEFAULTS, ...saved };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveShootSetup(patch: Partial<ShootSettings>): ShootSettings {
  const next = { ...shootSetup(), ...patch };
  setSetting(SETUP_KEY, JSON.stringify(next));
  return next;
}

/* ---------- spojení ---------- */

const session = new CameraSession();
let tool: ShootTool = { ok: false, path: '', version: '', note: '' };
let cameras: ShootCamera[] = [];
let settingsCache: { handy: CameraSetting[]; rest: string[] } = { handy: [], rest: [] };
/** Všechny cesty, co tělo umí. Kvůli tomu, jestli má vypínač živého náhledu. */
let allPaths: string[] = [];

export async function shootState(): Promise<ShootState> {
  if (!tool.path) tool = await gphoto.findGphoto();
  return {
    tool,
    cameras,
    connected: session.alive,
    camera: session.model,
    port: session.port,
    live: live.liveRunning(),
    error: session.lastError,
    setup: shootSetup(),
    shoots: store.listShoots()
  };
}

export async function scanCameras(): Promise<ShootCamera[]> {
  if (!tool.path) tool = await gphoto.findGphoto();
  cameras = tool.ok ? await gphoto.detectCameras() : [];
  return cameras;
}

/**
 * Zabrané tělo se pozná až prvním příkazem, ne otevřením spojení.
 *
 * `gphoto2 --shell` naskočí a vypíše výzvu, i když k fotoaparátu vůbec
 * nedosáhne — relaci s tělem otevírá až první příkaz. „Spojení je
 * navázané" proto samo o sobě neznamená nic a zkusit se to musí.
 */
const CLAIM = /could not claim|-53|claim the usb|claim interface/i;

export function claimFailed(error: string): boolean {
  return CLAIM.test(String(error ?? ''));
}

export async function connect(port: string, model: string): Promise<ShootState> {
  if (!tool.path) tool = await gphoto.findGphoto();
  session.lastError = '';
  if (!tool.ok) return shootState();

  /*
   * Zkouší se třikrát. Digitalizace obrazu se po ukončení sama znovu
   * spustí a někdy stihne tělo zabrat dřív než my — je to závod, ne
   * trvalý stav, a druhý pokus proto obvykle projde. Před každým dalším
   * se procesy ukončí znovu.
   */
  for (let attempt = 1; attempt <= 3; attempt++) {
    const ok = await session.open(port, model);
    if (!ok) break;

    const probe = await session.send('list-config', { urgent: true, timeout: 30000 });
    if (probe.ok) {
      if (model) saveShootSetup({ lastCamera: model });
      await loadSettings();
      /*
       * Ukládání na kartu se přestaví hned po připojení, ne až u spouště.
       * Do vnitřní paměti se RAW nevejde a tělo pak spoušť odmítne — a to
       * je chyba, na kterou se u stolu kouká s produktem v ruce.
       */
      await preferCard();
      return shootState();
    }

    session.lastError = probe.error;
    session.close();
    if (!claimFailed(probe.error) || attempt === 3) break;
    await gphoto.freeCamera();
  }

  if (claimFailed(session.lastError)) {
    session.lastError = 'Fotoaparát drží jiný program. Zavři Digitalizaci obrazu, Fotky, '
      + 'EOS Utility a Lightroom, odpoj a znovu připoj kabel a zkus to znovu. '
      + 'Pomáhá i přepnout tělo z režimu čtečky karet na „PC připojení".';
  }
  return shootState();
}

/**
 * Po otevření okna najde fotoaparát sám a známý rovnou připojí.
 *
 * Focení začíná vždycky stejně: zapojit kabel, zapnout tělo, otevřít okno.
 * Klikat u toho ještě na „Najít fotoaparát" a pak na model je práce, kterou
 * počítač zvládne sám — a při focení dvaceti kusů se k tomu okno otevírá
 * opakovaně.
 *
 * Sám se připojí **jen ke známému tělu**. Kdyby se připojoval k čemukoliv,
 * co najde, sáhl by při zapojeném telefonu nebo druhém fotoaparátu na to
 * špatné a odpojil by ho z toho, k čemu ho člověk připojil.
 */
export async function autoConnect(): Promise<ShootState> {
  if (session.alive) return shootState();
  if (!tool.path) tool = await gphoto.findGphoto();
  if (!tool.ok) return shootState();

  const want = (shootSetup().lastCamera || '').trim();
  const found = await scanCameras();
  const hit = want ? found.find(one => one.model === want) : undefined;
  if (!hit) return shootState();

  const next = await connect(hit.port, hit.model);
  if (!next.connected) return next;
  await startLive();
  /*
   * Stav se musí přečíst znovu. Ten z `connect` vznikl ještě před
   * spuštěním náhledu, takže by v okně svítilo „Spustit náhled" u něčeho,
   * co už běží — a kliknutí by ho místo spuštění zastavilo.
   */
  return shootState();
}

export function disconnect(): Promise<ShootState> {
  closeCamera();
  return shootState();
}

/**
 * Pustí fotoaparát. Volá se i při ukončení aplikace.
 *
 * Nic nevrací a nic nečeká — při `will-quit` na odpověď není čas a hlavní
 * je, aby proces gphoto2 zhasl. Kdyby přežil, držel by tělo dál a další
 * spuštění aplikace by se k němu nedostalo.
 */
export function closeCamera(): void {
  live.stopLive();
  session.close();
  settingsCache = { handy: [], rest: [] };
  allPaths = [];
}

/** Posledních pár příkazů i s odpovědí — k poslání, když se něco pokazí. */
export function cameraLog() {
  return session.log();
}

export async function startLive(): Promise<boolean> {
  if (!session.alive) return false;
  await live.startLive(session);
  return true;
}

export function stopLive(): boolean {
  live.stopLive();
  return true;
}

/* ---------- nastavení fotoaparátu ---------- */

export async function loadSettings(force = false):
  Promise<{ handy: CameraSetting[]; rest: string[]; error: string }> {
  if (!session.alive) return { handy: [], rest: [], error: 'fotoaparát není připojený' };

  /*
   * Přečtené nastavení se vrací z paměti. Jedno načtení je jeden
   * `list-config` a dvacet `get-config` — a v protokolu bylo vidět, jak
   * tentýž sled proběhl třikrát po sobě, protože si o něj řeklo připojení
   * i panel v okně. Šedesát dotazů navíc tělo zbytečně zaměstnává zrovna
   * ve chvíli, kdy se chystá fotit.
   */
  if (!force && settingsCache.handy.length) return { ...settingsCache, error: '' };

  const listed = await live.hold(() => session.send('list-config', { urgent: true, timeout: 30000 }));
  if (!listed.ok) return { handy: [], rest: [], error: listed.error };

  const paths = config.parsePaths(listed.text);
  allPaths = paths;
  const handy: CameraSetting[] = [];
  for (const wanted of config.handyPaths(paths)) {
    const one = await readSetting(wanted.path);
    if (one && config.settable(one)) {
      handy.push({ ...one, label: wanted.label, group: wanted.group });
    }
  }

  settingsCache = { handy, rest: config.restPaths(paths) };
  return { ...settingsCache, error: '' };
}

/** Jedna položka i s hodnotou. Zbytek stromu se čte takhle, až když se rozklikne. */
export async function readSetting(settingPath: string): Promise<CameraSetting | null> {
  if (!session.alive) return null;
  const reply = await live.hold(() =>
    session.send(`get-config ${settingPath}`, { urgent: true, timeout: 15000 }));
  return reply.ok ? config.parseOne(reply.text, settingPath) : null;
}

export async function setCameraSetting(settingPath: string, value: string):
  Promise<{ ok: boolean; error: string; setting: CameraSetting | null }> {
  if (!session.alive) return { ok: false, error: 'fotoaparát není připojený', setting: null };
  /*
   * `set-config-value` bere hodnotu tak, jak je vypsaná v nabídce, včetně
   * mezer a lomítek („1/125", „Large Fine JPEG"). `set-config` by hodnotu
   * s mezerou rozdělilo a tělo by dostalo nesmysl.
   */
  const reply = await live.hold(() =>
    session.send(`set-config-value ${settingPath}=${value}`, { urgent: true }));
  if (!reply.ok) return { ok: false, error: reply.error, setting: null };

  /*
   * Přečíst zpátky, ne jen věřit. Tělo hodnotu často přijme a tiše dá
   * jinou — v automatickém režimu nejde přestavit čas, u některých
   * objektivů nejde nastavit clona dokořán. Bez zpětného čtení by v
   * aplikaci svítilo něco jiného, než co fotoaparát opravdu dělá.
   */
  const setting = await readSetting(settingPath);
  if (setting) {
    const at = settingsCache.handy.findIndex(one => one.path === settingPath);
    if (at >= 0) settingsCache.handy[at] = { ...settingsCache.handy[at], value: setting.value };
  }
  return { ok: true, error: '', setting };
}

/** Zaostřit bez vyfocení — u produktu se ostří jednou a pak se s tím nehýbe. */
export async function autofocus(): Promise<{ ok: boolean; error: string }> {
  if (!session.alive) return { ok: false, error: 'fotoaparát není připojený' };
  const reply = await live.hold(() =>
    session.send('set-config /main/actions/autofocusdrive=1', { urgent: true, timeout: 15000 }));
  return { ok: reply.ok, error: reply.error };
}

/* ---------- focení ---------- */

/** Přípony, které jsou RAW. Vedle JPEG se ukládají bokem, ne místo něj. */
const RAW_EXT = ['cr2', 'cr3', 'crw', 'nef', 'nrw', 'arw', 'srf', 'sr2',
  'raf', 'orf', 'rw2', 'pef', 'dng', 'raw', '3fr', 'iiq'];

function isRaw(file: string): boolean {
  return RAW_EXT.includes(path.extname(file).replace('.', '').toLowerCase());
}

function slug(text: string): string {
  return String(text ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'foceni';
}

/**
 * Kam a pod jakým jménem snímek uložit.
 *
 * Číslo je pořadí v rámci focení, ne v rámci složky: když se ve stejné
 * složce fotí dvě série, mají každá vlastní řadu a v názvu je poznat
 * která. Když jméno přesto existuje, přidá se písmeno — přepsat nafocený
 * snímek je ta nejhorší možná reakce na shodu jmen.
 */
export function targetName(shoot: Shoot, order: number, ext: string): string {
  const base = `${slug(shoot.name)}-${String(order).padStart(3, '0')}`;
  return `${base}${ext.startsWith('.') ? ext : `.${ext}`}`;
}

function freeFile(dir: string, name: string): string {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let file = path.join(dir, name);
  for (let i = 2; fs.existsSync(file); i++) file = path.join(dir, `${base}-${i}${ext}`);
  return file;
}

function shootFolder(shoot: Shoot): string {
  const dir = shoot.folder && shoot.folder.trim()
    ? shoot.folder
    : path.join(app.getPath('pictures'), 'Quentino focení', slug(shoot.name));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Vyfotí a stáhne snímek do složky focení.
 *
 * Náhled se na tu chvíli zastaví: tělo neobslouží spoušť a náhled zároveň
 * a odpovědělo by „PTP Device Busy". Stažený soubor přijde do pracovní
 * složky pod jménem z fotoaparátu (IMG_1234.CR3) a odsud se přesune do
 * cílové složky pod jménem focení — přesouvá se, aby v pracovní složce
 * nezůstávaly kopie celé série.
 */
/**
 * Chyby, které znamenají „zkus to za chvíli znovu".
 *
 * `-110 I/O in progress` a `PTP Device Busy` nejsou poruchy, ale zaneprázdněné
 * tělo: dopisuje na kartu, přeostřuje, nebo se ještě nevzpamatovalo
 * z živého náhledu. Hlásit je jako chybu znamená, že se člověk u stolu
 * dívá na hlášku místo na zboží — přitom stačí počkat půl vteřiny.
 */
const BUSY = /-110|i\/o in progress|device busy|0x2019|-53/i;

/**
 * Tělo zmizelo z USB.
 *
 * `-52` není zaneprázdněné tělo, ale odpojené: vypnuté, vybité, uvolněný
 * kabel, nebo se po neúspěšné spoušti samo shodilo. Zkoušet dál je
 * k ničemu — pomůže jedině odpojit a znovu připojit kabel.
 */
const GONE = /-52|could not find the requested device|no camera found/i;

export function cameraGone(error: string): boolean {
  return GONE.test(String(error ?? ''));
}

export function cameraBusy(error: string): boolean {
  return BUSY.test(String(error ?? ''));
}

/**
 * Kde má tělo vypínač živého náhledu.
 *
 * Jméno se mezi značkami i řadami liší — Canon má `viewfinder`, jinde je
 * to `liveview` nebo `eosviewfinder`. Hledat jen jedno jméno znamená, že
 * se na cizím těle nevypne nic a spoušť přijde do vyklopeného zrcátka.
 */
/**
 * Kam tělo ukládá snímek při focení přes kabel.
 *
 * ## Proč se to přestavuje
 *
 * Canon umí ukládat do vnitřní paměti (`Internal RAM`) nebo na kartu.
 * Do vnitřní paměti se vejde náhled, ne dvacetimegabajtový RAW — a když
 * se tam nevejde, vrátí tělo `-110 I/O in progress` a nevyfotí nic.
 * Přesně tak se to chovalo: formát RAW, cíl vnitřní paměť, spoušť odmítnuta.
 *
 * Na kartu se ukládá vždycky, když to tělo nabízí. Snímek se odtud stáhne
 * a díky `--keep` na ní zůstane i jako záloha — plná karta je menší
 * problém než ztracená série.
 */
export function targetPath(paths: string[]): string {
  return paths.find(one => /\/capturetarget$/i.test(one)) ?? '';
}

export async function preferCard(): Promise<string> {
  const where = targetPath(allPaths);
  if (!where || !session.alive) return '';
  const now = await readSetting(where);
  if (!now) return '';
  const card = now.choices.find(one => /card/i.test(one.value));
  if (!card || now.value === card.value) return '';
  const out = await session.send(`set-config-value ${where}=${card.value}`, { urgent: true });
  return out.ok ? card.value : '';
}

export function viewfinderPath(paths: string[]): string {
  const hit = paths.find(one => /\/(eos)?viewfinder$/i.test(one))
    ?? paths.find(one => /liveview/i.test(one));
  return hit ?? '';
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Vyfotí a stáhne snímek do složky focení.
 *
 * ## Proč se před vyfocením vypíná živý náhled na těle
 *
 * Zastavit naši smyčku nestačí. `capture-preview` přepne Canon do režimu
 * živého náhledu a v něm zrcátko zůstane vyklopené — tělo pak spoušť buď
 * odmítne (`PTP Device Busy`, `-110 I/O in progress`), nebo jen zaostří
 * a nevyfotí. Přesně tak se to chovalo: doostřilo a fotka žádná.
 *
 * Náhled se proto na těle vypne (`viewfinder=0`), počká se, až se zrcátko
 * vrátí, a po snímku se zapne zpátky. Vypínač nemají všechna těla, takže
 * se sahá jen na to, co se ve stromu opravdu našlo.
 */
export async function capture(shootId: string): Promise<{ ok: boolean; error: string; photo: ShootPhoto | null }> {
  const shoot = store.getShoot(shootId);
  if (!shoot) return { ok: false, error: 'focení neexistuje', photo: null };
  if (!session.alive) return { ok: false, error: 'fotoaparát není připojený', photo: null };

  const viewfinder = viewfinderPath(allPaths);
  const wasLive = live.liveRunning();

  /*
   * Náhled se **zastaví celý**, ne jen pozastaví. Pozastavení zabrání
   * dalším dotazům, ale ten rozdělaný ještě doběhne — a `capture-preview`
   * je právě to, co tělo do živého náhledu přepne. Spoušť by pak zase
   * přišla do vyklopeného zrcátka.
   */
  if (wasLive) {
    live.stopLive();
    await live.liveSettled();
  }

  if (viewfinder) {
    await session.send(`set-config ${viewfinder}=0`, { urgent: true, timeout: 15000 });
    /*
     * Zrcátko se nevrací okamžitě. Spoušť poslaná hned za vypnutím
     * náhledu je přesně ta, kterou tělo odmítne jako zaneprázdněné.
     */
    await wait(600);
  } else if (wasLive) {
    // Tělo vypínač nemá — zbývá dát mu čas, aby se z náhledu vzpamatovalo samo
    await wait(900);
  }

  // Pojistka pro případ, že se cíl mezitím přestavil na těle
  await preferCard();

  let reply = await session.send('capture-image-and-download', { urgent: true, timeout: 60000 });
  /*
   * Dva pokusy navíc. Zaneprázdněné tělo je stav na půl vteřiny, ne
   * porucha — a nechat člověka mačkat spoušť znovu ručně je horší než
   * počkat za něj. Před posledním pokusem se náhled vypne ještě jednou:
   * některá těla si ho po chybě samy zapnou zpátky.
   */
  for (let attempt = 0; attempt < 2 && !reply.ok && cameraBusy(reply.error) && session.alive; attempt++) {
    if (viewfinder) await session.send(`set-config ${viewfinder}=0`, { urgent: true, timeout: 15000 });
    await wait(1000);
    reply = await session.send('capture-image-and-download', { urgent: true, timeout: 60000 });
  }

  // Náhled se rozjede zpátky, i když se vyfotit nepovedlo — jinak zůstane okno slepé
  if (wasLive && session.alive) await startLive();

  if (!reply.ok) {
    return {
      ok: false,
      photo: null,
      /*
       * Do hlášky patří i to, co odpovědělo tělo. „Fotoaparát je
       * zaneprázdněný" samo o sobě neřekne, co dál — a bez čísla chyby
       * se to nedá ani dohledat.
       */
      error: cameraGone(reply.error)
        ? `Fotoaparát zmizel z USB (${reply.error}). Odpoj a znovu připoj kabel `
          + 'a zkontroluj, že tělo není vybité ani uspané.'
        : cameraBusy(reply.error)
        ? `Fotoaparát spoušť odmítl: ${reply.error}. `
          + (viewfinder
            ? 'Živý náhled jsem před snímkem vypnul. '
            : 'Tělo nehlásí vypínač živého náhledu, takže se vypnout nedal. ')
          + 'Zkus vypnout na těle Wi-Fi a přepnout ho do režimu M nebo Av; '
          + 'podrobnosti jsou v protokolu pod nastavením.'
        : reply.error
    };
  }

  const saved = savedFiles(reply.text)
    .map(name => path.resolve(session.dir, name))
    .filter(file => fs.existsSync(file));
  if (!saved.length) {
    return {
      ok: false,
      photo: null,
      error: 'Fotoaparát snímek nestáhl. Bývá to nastavením „Kam ukládat" na těle — '
        + 'zkus ho přepnout na paměťovou kartu. Podrobnosti jsou v protokolu pod nastavením.'
    };
  }

  const dir = shootFolder(shoot);
  const order = store.listPhotos(shootId).length + 1;
  let image = '';
  let raw = '';

  for (const source of saved) {
    const ext = path.extname(source);
    const target = freeFile(dir, targetName(shoot, order, ext));
    try {
      fs.renameSync(source, target);
    } catch {
      // Jiný svazek (pracovní složka v profilu, focení na externím disku)
      fs.copyFileSync(source, target);
      try { fs.unlinkSync(source); } catch { /* originál zůstane, nevadí */ }
    }
    if (isRaw(target)) raw = target; else image = target;
  }

  const photo = store.addPhoto(shootId, {
    file: image || raw,
    raw,
    bytes: safeSize(image || raw)
  });
  emit('shoot:photo', photo);
  return { ok: true, error: '', photo };
}

/**
 * Naváže spojení znovu, když během focení spadlo.
 *
 * gphoto2 umí skončit uprostřed práce — uspané USB, uvolněný kabel,
 * vybitá baterie. Bez tohohle zbyde v okně „fotoaparát není připojený"
 * a další snímek se nedá udělat, dokud se ručně neproklikáš nastavením,
 * přestože tělo je pořád na kabelu.
 */
export async function reconnect(): Promise<ShootState> {
  if (session.alive) return shootState();
  const port = session.port;
  const model = session.model || shootSetup().lastCamera;
  if (!model && !port) return shootState();

  await gphoto.freeCamera();
  const found = await scanCameras();
  const hit = found.find(one => one.model === model) ?? found[0];
  if (!hit) return shootState();

  const next = await connect(hit.port, hit.model);
  if (next.connected) await startLive();
  return shootState();
}

function safeSize(file: string): number {
  try { return fs.statSync(file).size; } catch { return 0; }
}

function savedFiles(text: string): string[] {
  const out: string[] = [];
  for (const line of String(text ?? '').split('\n')) {
    const hit = /^Saving file as (.+?)\s*$/.exec(line.trim());
    if (hit) out.push(hit[1]);
  }
  return out;
}

/**
 * Uloží snímek, který vznikl v okně — z webkamery nebo jako převedená kopie.
 *
 * Bajty přicházejí z okna proto, že kodér WebP i plátno s korekcemi jsou
 * tam; hlavní proces by pro totéž potřeboval nativní knihovnu navíc.
 */
export function savePhotoBytes(shootId: string, ext: string, bytes: Uint8Array, beside = ''):
  { ok: boolean; error: string; photo: ShootPhoto | null; file: string } {
  const shoot = store.getShoot(shootId);
  if (!shoot) return { ok: false, error: 'focení neexistuje', photo: null, file: '' };
  const dir = shootFolder(shoot);

  if (beside) {
    /*
     * Převedená kopie patří k už nafocenému snímku, ne do řady jako další
     * fotka — jinak by se v galerii ukázala dvakrát tatáž věc.
     */
    const target = freeFile(dir, `${path.basename(beside, path.extname(beside))}.${ext}`);
    fs.writeFileSync(target, bytes);
    const photo = store.listPhotos(shootId).find(one => one.file === beside);
    const saved = photo ? store.savePhoto(photo.id, { webp: target }) : null;
    return { ok: true, error: '', photo: saved, file: target };
  }

  const order = store.listPhotos(shootId).length + 1;
  const target = freeFile(dir, targetName(shoot, order, ext));
  fs.writeFileSync(target, bytes);
  const photo = store.addPhoto(shootId, { file: target, bytes: safeSize(target) });
  emit('shoot:photo', photo);
  return { ok: true, error: '', photo, file: target };
}

/**
 * Vyřadí snímek z focení.
 *
 * Soubor jde do koše systému, ne do nenávratna: zahodit se dá i to, co po
 * pěti minutách vypadá líp než náhrada, a vytáhnout to z koše umí každý.
 */
export async function removePhoto(photoId: string, alsoFile = true): Promise<boolean> {
  const photo = store.dropPhoto(photoId);
  if (!photo) return false;
  if (!alsoFile) return true;
  for (const file of [photo.file, photo.raw, photo.webp].filter(Boolean)) {
    try { if (fs.existsSync(file)) await shell.trashItem(file); } catch { /* koš neumí, soubor zůstane */ }
  }
  return true;
}

/* ---------- soubory ---------- */

export function readFile(file: string): Uint8Array | null {
  try { return new Uint8Array(fs.readFileSync(file)); } catch { return null; }
}

/**
 * Obsah, který okno umí vykreslit.
 *
 * U RAW vrátí JPEG vnořený fotoaparátem — Chromium CR2 ani CR3 neotevře,
 * takže při focení do RAW zůstávala v galerii prázdná dlaždice a nafocené
 * nešlo zkontrolovat, dokud se soubory neotevřely jinde.
 */
export function viewableFile(file: string): Uint8Array | null {
  return preview.viewable(file);
}

export async function pickFolder(shootId: string): Promise<string> {
  const win = BrowserWindow.getFocusedWindow();
  const res = await dialog.showOpenDialog(win!, {
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: shootSetup().lastFolder || app.getPath('pictures')
  });
  if (res.canceled || !res.filePaths.length) return '';
  const dir = res.filePaths[0];
  saveShootSetup({ lastFolder: dir });
  if (shootId) store.saveShoot(shootId, { folder: dir });
  return dir;
}

/** Fotka jako průsvitka. Bere se odkudkoliv, nemusí být z tohoto focení. */
export async function pickGhost(): Promise<string> {
  const win = BrowserWindow.getFocusedWindow();
  const res = await dialog.showOpenDialog(win!, {
    properties: ['openFile'],
    filters: [{ name: 'Fotky', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'] }]
  });
  return res.canceled || !res.filePaths.length ? '' : res.filePaths[0];
}

export function reveal(file: string): void {
  if (file && fs.existsSync(file)) shell.showItemInFolder(file);
}

export function openFolder(shootId: string): boolean {
  const shoot = store.getShoot(shootId);
  if (!shoot) return false;
  shell.openPath(shootFolder(shoot));
  return true;
}

function emit(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload);
}

/* ---------- co používá zbytek aplikace ---------- */

export const listShoots = store.listShoots;
export const getShoot = store.getShoot;
export const newShoot = store.newShoot;
export const saveShoot = store.saveShoot;
export const deleteShoot = store.deleteShoot;
export const listPhotos = store.listPhotos;
export const savePhoto = store.savePhoto;
export const SCHEMA = store.SCHEMA;
export const saveGphotoPath = gphoto.saveGphotoPath;

export const __test = { targetName, isRaw, slug, savedFiles, DEFAULTS };
