import { app, BrowserWindow, shell } from 'electron';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import https from 'https';
import { getSetting, setSetting } from './db';
import type { UpdateState } from '../shared/types';

/**
 * Nová verze z GitHubu — a hlavně její nasazení na jedno klepnutí.
 *
 * ## Proč ne electron-updater
 *
 * Standardní cesta (Squirrel.Mac přes `electron-updater`) **vyžaduje
 * podepsanou aplikaci**: bez certifikátu od Applu balíček odmítne a
 * aktualizace se nikdy nenainstaluje. Certifikát stojí devadesát devět
 * dolarů ročně a tahle aplikace má jednoho uživatele, takže by to byla
 * daň za pohodlí, které se dá mít i jinak.
 *
 * ## Proč se po aktualizaci nemusí nic potvrzovat
 *
 * Otravné okno „Aplikaci nelze otevřít, protože pochází od
 * neidentifikovaného vývojáře" nedělá nepodepsaný podpis sám o sobě —
 * dělá ho **karanténní značka** `com.apple.quarantine`. Tu na soubor
 * pověsí ten, kdo ho stáhl: Safari, Chrome, Mail. Když si archiv stáhne
 * a rozbalí **sama aplikace** (Node, ne prohlížeč), žádná značka nevznikne
 * a Gatekeeper nemá co hlásit. Proto se tu stahuje ručně přes `https`
 * a rozbaluje přes `ditto` — a pro jistotu se značka ještě explicitně
 * sundává, kdyby ji tam něco přidalo.
 *
 * ## Jak se vymění běžící aplikace
 *
 * Sama sebe přepsat nemůže. Stažená verze se proto rozbalí stranou
 * a spustí se krátký skript, který počká, až aplikace skončí, vymění
 * balíček a otevře ji znovu. Skript běží odpojený od aplikace, takže
 * jeho běh nezávisí na tom, že aplikace zrovna končí.
 *
 * Starý balíček se **nemaže hned**: přejmenuje se stranou a smaže až
 * potom, co se nový úspěšně přesunul. Když výměna selže uprostřed,
 * zůstane na disku to staré a dá se vrátit zpátky.
 */

/** Kde se hledají vydání. Dá se přepsat v nastavení — třeba na vlastní fork. */
const DEFAULT_REPO = 'quentinocz/quentino-mail';
const REPO_KEY = 'updateRepo';
const TOKEN_KEY = 'updateToken';
const SKIP_KEY = 'updateSkip';
const AUTO_KEY = 'updateAuto';

/** Jak často se kouká, jestli není novější verze. Šestkrát denně stačí. */
const EVERY_MS = 6 * 3600_000;

let state: UpdateState = {
  current: '', latest: '', notes: '', url: '', asset: '', size: 0,
  newer: false, checking: false, downloading: false, progress: 0,
  ready: '', error: '', checkedAt: '', auto: true, repo: DEFAULT_REPO, canInstall: true
};
let timer: ReturnType<typeof setInterval> | null = null;

function emit(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('update:changed', state);
  }
}

function repo(): string {
  return (getSetting(REPO_KEY, '') || DEFAULT_REPO).trim().replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '').replace(/\/+$/, '');
}

/**
 * Porovnání verzí. Jen čísla oddělená tečkou — `v` na začátku se zahodí.
 *
 * Schválně se nepoužívá porovnání řetězců: „5.10.0" je víc než „5.9.0",
 * ale abecedně je to naopak, a aktualizace by se po devítce přestala
 * nabízet.
 */
export function newerThan(latest: string, current: string): boolean {
  const parts = (text: string) => String(text || '').replace(/^v/i, '').split(/[.\-+]/)
    .map(one => Number.parseInt(one, 10)).map(one => (Number.isFinite(one) ? one : 0));
  const a = parts(latest);
  const b = parts(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left > right;
  }
  return false;
}

/**
 * Který soubor z vydání patří tomuhle počítači.
 *
 * Na macOS **zip, ne dmg**: z dmg by se muselo připojovat zařízení a
 * kopírovat z něj, kdežto zip stačí rozbalit. Na Windows instalátor.
 */
export function pickAsset(names: string[], platform = process.platform, arch = process.arch): string {
  const lower = names.map(one => ({ name: one, low: one.toLowerCase() }));
  if (platform === 'darwin') {
    const zips = lower.filter(one => one.low.endsWith('.zip'));
    return (zips.find(one => one.low.includes(arch)) ?? zips[0])?.name ?? '';
  }
  if (platform === 'win32') {
    const exes = lower.filter(one => one.low.endsWith('.exe'));
    return (exes.find(one => one.low.includes(arch === 'arm64' ? 'arm64' : 'x64')) ?? exes[0])?.name ?? '';
  }
  return '';
}

function headers(): Record<string, string> {
  const out: Record<string, string> = {
    // GitHub bez tohohle odpoví 403 — chce vědět, kdo se ptá
    'User-Agent': 'QuentinoApp',
    Accept: 'application/vnd.github+json'
  };
  const token = (getSetting(TOKEN_KEY, '') || '').trim();
  if (token) out.Authorization = `Bearer ${token}`;
  return out;
}

function getJson(url: string): Promise<any> {
  return new Promise((done, fail) => {
    https.get(url, { headers: headers() }, res => {
      // Vydání i soubory chodí přes přesměrování na jiný server
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        getJson(res.headers.location).then(done, fail);
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', one => chunks.push(one));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) {
          fail(new Error(res.statusCode === 404
            ? 'Vydání se nenašlo. Je repozitář správně, a když je soukromý, je vyplněný token?'
            : `GitHub odpověděl ${res.statusCode}`));
          return;
        }
        try { done(JSON.parse(text)); } catch { fail(new Error('Odpověď GitHubu se nedá přečíst.')); }
      });
    }).on('error', e => fail(e));
  });
}

/* ---------- kontrola ---------- */

export function updateState(): UpdateState {
  return {
    ...state,
    current: app.getVersion(),
    repo: repo(),
    auto: getSetting(AUTO_KEY, '1') !== '0',
    /*
     * Z vývojového běhu se aktualizovat nedá — není co vyměnit, `npm start`
     * pouští zdrojáky. Nabízet tlačítko, které skončí chybou, nemá smysl.
     */
    canInstall: app.isPackaged && (process.platform === 'darwin' || process.platform === 'win32')
  };
}

export async function checkUpdate(): Promise<UpdateState> {
  state = { ...updateState(), checking: true, error: '' };
  emit();
  try {
    const release = await getJson(`https://api.github.com/repos/${repo()}/releases/latest`);
    const tag = String(release?.tag_name ?? '').trim();
    const assets = Array.isArray(release?.assets) ? release.assets : [];
    const wanted = pickAsset(assets.map((one: any) => String(one?.name ?? '')));
    const asset = assets.find((one: any) => one?.name === wanted);
    state = {
      ...updateState(),
      checking: false,
      latest: tag,
      notes: String(release?.body ?? '').slice(0, 2000),
      url: String(release?.html_url ?? ''),
      asset: wanted,
      size: Number(asset?.size ?? 0),
      newer: !!tag && newerThan(tag, app.getVersion()),
      checkedAt: new Date().toISOString(),
      error: ''
    };
    /*
     * Vydání bez souboru pro tenhle systém se tváří jako novinka, kterou
     * nejde nainstalovat — a to je horší než mlčet. Stane se to, když
     * build pro jednu platformu spadl a vydání má jen tu druhou.
     */
    if (state.newer && !wanted) {
      state.error = 'Nové vydání zatím nemá soubor pro tenhle systém — zkus to za chvíli.';
    }
  } catch (e: any) {
    state = { ...updateState(), checking: false, error: String(e?.message ?? e) };
  }
  emit();
  return state;
}

/** Tuhle verzi už znovu nenabízet. Vrací se, jakmile vyjde další. */
export function skipUpdate(version: string): UpdateState {
  setSetting(SKIP_KEY, version);
  state = { ...state, newer: false };
  emit();
  return state;
}

export function setAuto(on: boolean): UpdateState {
  setSetting(AUTO_KEY, on ? '1' : '0');
  state = updateState();
  emit();
  return state;
}

export function setRepo(value: string, token?: string): UpdateState {
  setSetting(REPO_KEY, String(value ?? '').trim());
  if (token !== undefined) setSetting(TOKEN_KEY, String(token).trim());
  state = { ...updateState(), latest: '', newer: false, error: '' };
  emit();
  return state;
}

/* ---------- stažení ---------- */

function updatesDir(): string {
  const dir = path.join(app.getPath('userData'), 'updates');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function download(url: string, target: string, onStep: (done: number, total: number) => void): Promise<void> {
  return new Promise((done, fail) => {
    const file = fs.createWriteStream(target);
    const go = (where: string) => {
      https.get(where, {
        headers: { ...headers(), Accept: 'application/octet-stream' }
      }, res => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          go(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          fail(new Error(`Stahování skončilo chybou ${res.statusCode}`));
          return;
        }
        const total = Number(res.headers['content-length'] ?? 0);
        let got = 0;
        res.on('data', chunk => { got += chunk.length; onStep(got, total); });
        res.pipe(file);
        file.on('finish', () => file.close(() => done()));
      }).on('error', e => fail(e));
    };
    go(url);
  });
}

/**
 * Stáhne soubor vydání pro tenhle systém.
 *
 * Stahuje **aplikace, ne prohlížeč** — a právě proto se pak nemusí nic
 * potvrzovat: karanténní značku věší na soubor ten, kdo ho stáhl.
 */
export async function downloadUpdate(): Promise<UpdateState> {
  if (!state.asset) return { ...state, error: 'Není co stahovat — nejdřív zkontroluj aktualizace.' };
  state = { ...updateState(), downloading: true, progress: 0, error: '', ready: '' };
  emit();
  try {
    const release = await getJson(`https://api.github.com/repos/${repo()}/releases/latest`);
    const asset = (release?.assets ?? []).find((one: any) => one?.name === state.asset);
    if (!asset?.url) throw new Error('Soubor vydání se nenašel.');

    const target = path.join(updatesDir(), String(asset.name));
    try { fs.rmSync(target, { force: true }); } catch { /* nevadí */ }
    let last = 0;
    await download(String(asset.url), target, (got, total) => {
      const pct = total > 0 ? Math.round((got / total) * 100) : 0;
      // Hlásí se po procentech, ne po každém kousku: jinak by se okno
      // překreslovalo tisíckrát za vteřinu a stahování by kvůli tomu brzdilo
      if (pct !== last) {
        last = pct;
        state = { ...state, progress: pct };
        emit();
      }
    });
    state = { ...updateState(), downloading: false, progress: 100, ready: target, error: '' };
  } catch (e: any) {
    state = { ...updateState(), downloading: false, error: String(e?.message ?? e) };
  }
  emit();
  return state;
}

/* ---------- nasazení ---------- */

function run(command: string, args: string[]): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { stdio: 'ignore' });
    child.on('error', fail);
    child.on('close', code => (code === 0 ? done() : fail(new Error(`${command} skončil kódem ${code}`))));
  });
}

/**
 * Skript, který vymění aplikaci za staženou verzi.
 *
 * Je to samostatná funkce, aby se dal spustit ve zkoušce nasucho — výměna
 * aplikace je ta část, u které se chyba pozná až tím, že se aplikace
 * nespustí, a to je pozdě. Bere tři věci: číslo procesu, cestu k nové
 * aplikaci a cestu k té, která se má nahradit.
 *
 * Pořadí kroků je to podstatné: **starý balíček se nejdřív odsune stranou
 * a smaže se až po úspěšném přesunu nového.** Kdyby se mazal rovnou
 * a přesun selhal, nezůstalo by na disku nic.
 */
export function swapScript(): string {
  return [
    '#!/bin/sh',
    '# Výměna aplikace za staženou verzi. Spouští ji aplikace před koncem',
    '# a běží odpojeně, takže dokončí výměnu i po jejím ukončení.',
    'PID="$1"; NOVA="$2"; CIL="$3"',
    '# Počká, až aplikace skutečně skončí — jinak by se přepisoval běžící balíček',
    'for i in $(seq 1 100); do kill -0 "$PID" 2>/dev/null || break; sleep 0.2; done',
    'STARA="$CIL.stara"',
    'rm -rf "$STARA"',
    '# Nejdřív stranou, teprve pak nová: když výměna selže, je co vrátit',
    'mv "$CIL" "$STARA" || exit 1',
    'if ! mv "$NOVA" "$CIL"; then mv "$STARA" "$CIL"; exit 1; fi',
    'rm -rf "$STARA"',
    'xattr -dr com.apple.quarantine "$CIL" 2>/dev/null',
    '# Zpátky do provozu. Bez tohohle by po aktualizaci zůstala zavřená.',
    'open "$CIL"'
  ].join('\n');
}

/** Cesta k balíčku aplikace na macOS (`…/Quentino App.app`). */
function bundlePath(): string {
  const exe = app.getPath('exe');
  const at = exe.indexOf('.app/Contents/MacOS/');
  return at > 0 ? exe.slice(0, at + 4) : '';
}

/**
 * Vymění aplikaci za staženou a spustí ji znovu.
 *
 * Na macOS se archiv rozbalí stranou, sundá se z něj karanténní značka
 * (kdyby ji tam něco pověsilo) a výměnu udělá krátký skript, který počká,
 * až aplikace skončí. Sama sebe přepsat nemůže.
 *
 * Na Windows se spustí instalátor v tichém režimu a aplikace se ukončí;
 * instalátor si ji po sobě spustí sám.
 */
export async function installUpdate(): Promise<UpdateState> {
  const ready = state.ready;
  if (!ready || !fs.existsSync(ready)) {
    state = { ...updateState(), error: 'Stažený soubor nikde není — stáhni aktualizaci znovu.' };
    emit();
    return state;
  }

  try {
    if (process.platform === 'darwin') {
      const bundle = bundlePath();
      if (!bundle) throw new Error('Nepodařilo se najít, kde aplikace leží.');
      /*
       * Aplikace spuštěná z karantény běží z dočasné kopie (App
       * Translocation) a vyměnit se v ní nedá — přepsala by se kopie,
       * která po zavření zmizí. Tohle je přesně ten stav po prvním
       * stažení z prohlížeče, takže se to musí říct nahlas.
       */
      if (bundle.includes('/AppTranslocation/')) {
        throw new Error('Aplikace běží z dočasné kopie. Přesuň ji do složky Aplikace a spusť odtamtud.');
      }

      const stage = path.join(updatesDir(), 'rozbaleno');
      fs.rmSync(stage, { recursive: true, force: true });
      fs.mkdirSync(stage, { recursive: true });
      // `ditto` umí zip od Applu i s právy a symlinky; `unzip` je rozbije
      await run('/usr/bin/ditto', ['-x', '-k', ready, stage]);

      const found = fs.readdirSync(stage).find(one => one.endsWith('.app'));
      if (!found) throw new Error('V archivu není aplikace.');
      const fresh = path.join(stage, found);
      // Pro jistotu: kdyby značku pověsil někdo jiný než prohlížeč
      try { await run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', fresh]); } catch { /* nevadí */ }

      const script = path.join(updatesDir(), 'vymena.sh');
      fs.writeFileSync(script, swapScript(), 'utf8');
      fs.chmodSync(script, 0o755);

      const child = spawn('/bin/sh', [script, String(process.pid), fresh, bundle], {
        detached: true, stdio: 'ignore'
      });
      child.unref();
      setTimeout(() => app.quit(), 400);
      state = { ...updateState(), error: '' };
      emit();
      return state;
    }

    if (process.platform === 'win32') {
      // `/S` je tichá instalace NSIS; instalátor si aplikaci spustí sám
      const child = spawn(ready, ['/S'], { detached: true, stdio: 'ignore' });
      child.unref();
      setTimeout(() => app.quit(), 400);
      return state;
    }

    // Jiný systém: aspoň se otevře stránka vydání
    await shell.openExternal(state.url || `https://github.com/${repo()}/releases/latest`);
    return state;
  } catch (e: any) {
    state = { ...updateState(), error: String(e?.message ?? e) };
    emit();
    return state;
  }
}

/* ---------- hlídání na pozadí ---------- */

/**
 * Spustí hlídání.
 *
 * První kontrola až po chvíli od startu: při spuštění se navazují účty,
 * stahuje pošta a překresluje okno, a síť navíc kvůli aktualizaci je
 * přesně to, co v té chvíli nikdo nepotřebuje.
 */
export function startUpdateWatch(): void {
  if (timer) return;
  if (!app.isPackaged) return;
  const tick = async () => {
    if (getSetting(AUTO_KEY, '1') === '0') return;
    const out = await checkUpdate();
    // Verzi, kterou si člověk odložil, znovu nevytahujeme
    if (out.newer && getSetting(SKIP_KEY, '') === out.latest) {
      state = { ...state, newer: false };
      emit();
    }
  };
  setTimeout(() => { void tick(); }, 30_000);
  timer = setInterval(() => { void tick(); }, EVERY_MS);
}

export function stopUpdateWatch(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
