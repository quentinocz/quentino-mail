import { BrowserWindow } from 'electron';
import fs from 'fs';
import path from 'path';
import { getSetting, setSetting } from '../db';
import { getUpgatesConfig } from '../upgates';
import { openUrl, waitForFileInput, insertFiles } from '../formfile';
import { keepSignedIn, signIn, signInNote } from '../portallogin';
import type { ArticleFolder, ArticleUpload } from '../../shared/types';

/**
 * Nahrání fotek a videí k článku do správce souborů na e-shopu.
 *
 * ## Proč to nejde přes API
 *
 * Upgates API umí objednávky a produkty, ne správce souborů. Nahrává se
 * proto stejnou cestou jako import článků a štítky dopravců: v okně
 * s vlastním trvalým sezením, do políčka na soubor přes ladicí rozhraní
 * prohlížeče. Je to táž cesta, jakou by soubor vybral člověk myší —
 * správce souborů má Dropzone a ten se po vložení souborů rozjede sám.
 *
 * ## Jak se zjistí adresa, na které soubor skončil
 *
 * Tohle je jádro věci: bez adresy je nahraný soubor k ničemu, do článku se
 * vkládá odkazem. A **složit se nedá**. Upgates soubor přejmenuje hned
 * dvakrát: název se zbaví diakritiky a mezer (`Snímek11.PNG` →
 * `snimek11.png`) a před něj se přilepí náhodný otisk i s písmenem
 * složky — z `kravata.webp` se stane
 * `…cdn-upgates.com/h/h6aa5a12002c6a-kravata.webp`. Žádná předpona, kterou
 * by šlo znát dopředu.
 *
 * Naštěstí si ji stránka vede sama: každá dlaždice ve výpisu je
 * `.manager-file` a nese `data-title` s **původním** názvem a `data-url`
 * s hotovou veřejnou adresou. Čte se tedy odtud — a bere se jen dlaždice,
 * která ve výpisu před nahráním nebyla, aby se u druhého souboru téhož
 * jména nevrátila adresa toho staršího.
 *
 * Miniatura v `img src` je schválně k ničemu: je to zmenšenina ve složce
 * `_cache` a v článku by byla rozmazaná.
 */

const PARTITION = 'persist:upgates';
const URL_KEY = 'articleFilesUrl';
const FOLDER_KEY = 'articleFilesFolder';
const FOLDERS_KEY = 'articleFilesFolders';

/**
 * Stránka správce souborů.
 *
 * Cesta je u Upgates stálá, ale číslo serveru v adrese (`…s19…`) má každý
 * e-shop jiné, takže se skládá z adresy administrace. Naučená adresa má
 * přednost — kdyby Upgates cestu změnily, nemusí se čekat na novou verzi
 * aplikace.
 */
export function filesAdminUrl(folder = articleFilesFolder()): string {
  const saved = (getSetting(URL_KEY, '') ?? '').trim();
  if (saved) return saved;
  const home = (getSetting('invoiceAdminHome', '') ?? '').trim()
    || `${getUpgatesConfig().url.replace(/\/+$/, '')}/manager/`;
  const root = home.replace(/\/manager\/?$/, '').replace(/\/+$/, '');
  const where = folder && /^[\w-]+$/.test(folder) ? folder : 'all';
  return `${root}/manager/files/default/default/${where}/?filesPaginator-page=1`;
}

export function filesUrlLearned(): boolean {
  return !!(getSetting(URL_KEY, '') ?? '').trim();
}

export function saveFilesUrl(url: string): string {
  setSetting(URL_KEY, (url ?? '').trim());
  return filesAdminUrl();
}

/** Do které složky správce souborů se nahrává; prázdné = „Vše". */
export function articleFilesFolder(): string {
  return (getSetting(FOLDER_KEY, '') ?? '').trim();
}

export function saveArticleFilesFolder(id: string): string {
  setSetting(FOLDER_KEY, (id ?? '').trim());
  return articleFilesFolder();
}

/**
 * Složky, které aplikace ve správci souborů viděla.
 *
 * Sbírají se při nahrávání ze stromu, který je na stránce stejně
 * vykreslený. Nastavení z nich pak nabídne výběr — vypsat je do políčka
 * ručně by znamenalo hledat čísla složek v adrese odkazu.
 */
export function articleFolders(): ArticleFolder[] {
  try {
    const saved = JSON.parse(getSetting(FOLDERS_KEY, '[]') ?? '[]');
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

/** Koš a „nepoužité" jsou pohledy, ne složky — nahrávat se do nich nedá. */
const NOT_FOLDERS = ['trash', 'unused', 'unused-import', 'unused-api', 'search', 'groups'];

function rememberFolders(list: ArticleFolder[]): void {
  const seen = new Set<string>();
  const clean = list
    .filter(one => one.id && one.name && !NOT_FOLDERS.includes(one.id))
    .filter(one => (seen.has(one.id) ? false : seen.add(one.id)))
    .slice(0, 60);
  if (clean.length > 0) setSetting(FOLDERS_KEY, JSON.stringify(clean));
}

/* ---------- čtení stránky ---------- */

/**
 * Dlaždice ve výpisu souborů.
 *
 * `data-title` je původní název souboru, `data-url` hotová veřejná adresa.
 * Obojí si tam vede správce souborů sám kvůli svým tlačítkům, takže se
 * nemusí nic dolovat z odkazů ani z náhledů.
 */
const TILES = `
  (function () {
    var out = [];
    var nodes = document.querySelectorAll('.manager-file[data-file-id]');
    for (var i = 0; i < nodes.length; i++) {
      out.push({
        id: nodes[i].getAttribute('data-file-id') || '',
        title: nodes[i].getAttribute('data-title') || '',
        url: nodes[i].getAttribute('data-url') || ''
      });
    }
    return out;
  })()
`;

/** Strom složek vlevo. Číslo složky je v adrese odkazu, název v jeho textu. */
const FOLDERS = `
  (function () {
    var out = [];
    var nodes = document.querySelectorAll('a.sm-link-in[href*="/manager/files/default/default/"]');
    for (var i = 0; i < nodes.length; i++) {
      var href = nodes[i].getAttribute('href') || '';
      var found = /\\/default\\/default\\/([^\\/?]+)\\//.exec(href);
      if (!found) continue;
      var name = (nodes[i].getAttribute('title') || nodes[i].textContent || '')
        .replace(/\\s+/g, ' ').trim().replace(/\\s*\\(\\d+\\)$/, '').replace(/\\s*\\d+$/, '');
      if (name) out.push({ id: found[1], name: name });
    }
    return out;
  })()
`;

interface Tile { id: string; title: string; url: string }

/**
 * Opravdu tam ten soubor je?
 *
 * Ptá se serveru, ne domněnky. Adresa přečtená ze stránky bývá správná,
 * ale nahrávání může skončit chybou a dlaždice přesto na chvíli zůstat —
 * a odkaz na nic se v článku pozná až na hotovém webu. `HEAD` stačí
 * a nestahuje nic.
 */
export async function verifyUrl(url: string): Promise<boolean> {
  const ok = (res: Response) =>
    res.ok && /^(image|video)\//.test(res.headers.get('content-type') ?? '');
  try {
    const head = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    if (head.status !== 405 && head.status !== 501) return ok(head);
  } catch { /* zkusí se GET */ }
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'follow' });
    const good = ok(res);
    try { await res.body?.cancel(); } catch { /* tělo už mohlo doběhnout */ }
    return good;
  } catch {
    return false;
  }
}

let filesWin: BrowserWindow | null = null;

async function read<T>(win: BrowserWindow, script: string, fallback: T): Promise<T> {
  if (win.isDestroyed()) return fallback;
  return await win.webContents.executeJavaScript(script, true).catch(() => fallback) as T;
}

/**
 * Nahraje soubory do správce souborů a vrátí jejich veřejné adresy.
 *
 * Okno zůstane otevřené i po doběhnutí: je v něm vidět, co se nahrálo,
 * a kdyby se adresa nenašla, dá se odtud opsat. Zavřít si ho člověk může
 * sám.
 */
export async function uploadArticleFiles(files: string[]): Promise<ArticleUpload[]> {
  const list = (files ?? []).filter(one => one && fs.existsSync(one));
  if (list.length === 0) throw new Error('Není co nahrávat — soubory na disku nejsou.');
  const names = list.map(one => path.basename(one));

  const win = filesWin && !filesWin.isDestroyed() ? filesWin : new BrowserWindow({
    width: 1280, height: 900,
    title: 'Soubory na e-shopu — nahrávám přílohy článku',
    webPreferences: { partition: PARTITION, sandbox: true }
  });
  filesWin = win;
  win.on('closed', () => { filesWin = null; });

  keepSignedIn(win, 'upgates');
  await openUrl(win, filesAdminUrl());
  win.show();
  win.focus();
  const login = signInNote('upgates', await signIn(win, 'upgates'));

  /*
   * Políčko Dropzonu je schované (`visibility: hidden`, nulové rozměry),
   * takže „to viditelné" by na stránce nenašlo nic. Hledá se proto přímo
   * podle jeho třídy.
   */
  const ready = await waitForFileInput(win, [
    'input.dz-hidden-input',
    'input[type=file]'
  ], 3 * 60_000);
  if (!ready) {
    throw new Error(`Políčko pro soubor se ve správci souborů neobjevilo.${login ? ` ${login}` : ''}`);
  }

  // Strom složek je na stránce stejně — nastavení z něj pak nabídne výběr
  rememberFolders(await read<ArticleFolder[]>(win, FOLDERS, []));

  /*
   * Co ve výpisu bylo před nahráním. Bez toho by se u druhého souboru
   * téhož jména vrátila adresa toho staršího — a v článku by byla cizí
   * fotka.
   */
  const before = new Set((await read<Tile[]>(win, TILES, [])).map(one => one.id));

  await insertFiles(win, list);

  const found = await collectUrls(win, names, before);

  const out: ArticleUpload[] = [];
  for (let i = 0; i < list.length; i++) {
    const url = found.get(names[i]) ?? '';
    out.push({
      name: names[i], url, file: list[i],
      note: url ? '' : 'Soubor se nahrál, ale adresu se nepodařilo přečíst — otevři ho '
        + 've správci souborů tlačítkem oka a adresu sem vlož.'
    });
  }
  return out;
}

/**
 * Počká, až se nahrané soubory objeví ve výpisu, a přečte jejich adresy.
 *
 * Výpis se po nahrání překresluje sám (Dropzone si o to řekne), takže se
 * kouká opakovaně. Bere se jen dlaždice s novým číslem: název se opakovat
 * může, číslo ne.
 */
async function collectUrls(
  win: BrowserWindow, names: string[], before: Set<string>, tries = 60
): Promise<Map<string, string>> {
  const found = new Map<string, string>();

  for (let attempt = 0; attempt < tries; attempt++) {
    if (win.isDestroyed()) break;
    const fresh = (await read<Tile[]>(win, TILES, []))
      .filter(one => one.url && !before.has(one.id));

    for (const name of names) {
      if (found.has(name)) continue;
      const hit = fresh.find(one => one.title === name);
      if (hit && await verifyUrl(hit.url)) found.set(name, hit.url);
    }
    if (found.size === names.length) break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  return found;
}

/**
 * Naučí se adresu správce souborů z toho, kam se člověk proklikal.
 *
 * Cesta se sice skládá sama, ale kdyby ji Upgates změnily, nemá smysl
 * čekat na novou verzi aplikace. Okno se otevře na administraci, člověk
 * dojde do správce souborů a okno zavře — zapamatuje se adresa, na které
 * byl naposledy.
 */
export async function learnFilesUrl(): Promise<{ url: string; note: string }> {
  const home = (getSetting('invoiceAdminHome', '') ?? '').trim()
    || `${getUpgatesConfig().url.replace(/\/+$/, '')}/manager/`;
  if (!home) return { url: '', note: 'Není vyplněná adresa administrace (Nastavení → AI → Upgates).' };

  const win = new BrowserWindow({
    width: 1280, height: 900,
    title: 'Otevři správce souborů a okno zavři — adresu si zapamatuju',
    webPreferences: { partition: PARTITION, sandbox: true }
  });
  keepSignedIn(win, 'upgates');
  await openUrl(win, home);
  win.show();
  win.focus();
  await signIn(win, 'upgates');

  return await new Promise(resolve => {
    let last = '';
    const note = (_e: unknown, url: string) => { if (url) last = url; };
    win.webContents.on('did-navigate', note);
    win.webContents.on('did-navigate-in-page', note);
    win.once('closed', () => {
      /*
       * Adresa se bere jen tehdy, když je to opravdu správce souborů.
       * Zapsat kteroukoli stránku administrace by vypadalo jako naučeno
       * a nahrávání by pak končilo na „políčko se neobjevilo".
       */
      if (!/\/manager\/files\//.test(last)) {
        return resolve({
          url: filesAdminUrl(),
          note: 'Okno se zavřelo jinde než ve správci souborů — nic se neuložilo.'
        });
      }
      saveFilesUrl(last);
      resolve({ url: last, note: 'Adresa správce souborů je zapamatovaná.' });
    });
  });
}

/**
 * Ruční doplnění adresy, kterou aplikace nepřečetla.
 *
 * Ověří se dotazem na server — překlep v ručně vloženém odkazu je
 * pravděpodobnější než kdekoli jinde, a odkaz na nic se v článku pozná
 * až na webu.
 */
export async function noteFileUrl(_name: string, url: string): Promise<{ ok: boolean; note: string }> {
  const clean = (url ?? '').trim();
  if (!clean) return { ok: false, note: 'Prázdná adresa.' };
  if (!/^https?:\/\//i.test(clean)) return { ok: false, note: 'Adresa musí začínat http:// nebo https://.' };
  if (!await verifyUrl(clean)) {
    return { ok: false, note: 'Na téhle adrese žádný obrázek ani video není — zkontroluj ji.' };
  }
  return { ok: true, note: 'Adresa sedí.' };
}

export const __test = { filesAdminUrl, TILES, FOLDERS };
