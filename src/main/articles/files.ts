import { BrowserWindow, app, shell } from 'electron';
import fs from 'fs';
import path from 'path';
import { getSetting, setSetting } from '../db';
import { getUpgatesConfig } from '../upgates';
import {
  openUrl, waitForFileInput, insertFiles, eachFrame,
  findDropSpot, waitForDropSpot, dropFiles, describeDropSpots, silenceDialogs
} from '../formfile';
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

/**
 * Dá se vůbec někam nahrávat?
 *
 * **Naučená adresa není podmínka** — cesta do správce souborů se skládá
 * z adresy administrace a naučení je jen pojistka pro případ, že by ji
 * Upgates změnily. Ptát se na naučení znamenalo hlásit „není naučené"
 * i tam, kde nahrávání roky fungovalo.
 */
export function filesReady(): boolean {
  return /^https?:\/\//i.test(filesAdminUrl());
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

/**
 * Přečte ze stránky, ať je ta stránka v kterémkoli rámu.
 *
 * Výpis souborů Upgates je ve **vnořeném rámu**, takže čtení z hlavního
 * dokumentu vracelo prázdno: žádné dlaždice, žádné složky, žádné políčko
 * na soubor. Bere se první rám, který něco vrátil.
 */
async function read<T>(win: BrowserWindow, script: string, fallback: T): Promise<T> {
  if (win.isDestroyed()) return fallback;
  const all = await eachFrame<T>(win, script);
  const plny = all.find(one => Array.isArray(one.value)
    ? one.value.length > 0
    : one.value !== undefined && one.value !== null && one.value !== false);
  return (plny?.value ?? all[0]?.value ?? fallback) as T;
}

/**
 * Nahraje soubory do správce souborů a vrátí jejich veřejné adresy.
 *
 * Když se adresy najdou všechny, okno se **samo zavře** — aplikace z něj
 * dostala všechno, co potřebovala, a nechávat ho otevřené znamenalo jen
 * další okno, které musí člověk zavírat po každé fotce.
 *
 * Zůstane otevřené jedině tehdy, když se některá adresa přečíst nepovedla:
 * pak je to jediné místo, odkud se dá opsat, a zavřít ho by znamenalo
 * zahodit výsledek nahrávání.
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
  let login = '';
  try {
    await openUrl(win, filesAdminUrl());
    if (win.isDestroyed()) throw new Error('zavřeno');
    win.show();
    win.focus();
    login = signInNote('upgates', await signIn(win, 'upgates'));
  } catch (e: any) {
    /*
     * Zavřené okno uprostřed otevírání hlásí Electron jako „Object has
     * been destroyed" — hláška, ze které nikdo nepozná, co se stalo.
     */
    if (win.isDestroyed()) throw new Error('Okno správce souborů se zavřelo dřív, než se stihlo nahrát.');
    throw e;
  }

  /*
   * Kam soubory vložit.
   *
   * Nehledá se políčko na soubor, ale **Dropzone** — správce souborů na něm
   * stojí a `addFile` je přesně to, co dělá jeho vlastní dialog. Políčko na
   * výpisu totiž vůbec být nemusí (Dropzone si ho vyrobí až s otevřeným
   * nahráváním) a když je, bývá ve vnořeném rámu, kde ho hledání v hlavním
   * dokumentu nenašlo. Přesně proto nahrávání končilo hláškou „políčko se
   * ve správci souborů neobjevilo", ačkoli na obrazovce bylo všechno vidět.
   *
   * Když se nenajde nic, zkusí se kliknout na tlačítko nahrávání a čeká se
   * znovu — teprve pak je to opravdu slepá ulička.
   */
  /*
   * Nález se zapisuje **hned**, dokud okno žije.
   *
   * Hledání trvá i dvě minuty a člověk, který mezitím nic nevidí, okno
   * zavře — pak se aplikace ptala zavřeného okna a do hlášky napsala
   * „okno už je zavřené", což o administraci neřeklo vůbec nic. Tohle je
   * pohled na stránku z chvíle, kdy byla ještě otevřená.
   */
  let nalez = await describeDropSpots(win).catch(() => '');

  /*
   * Čeká se krátce. Dřív to bylo dvanáct vteřin, minuta, přenačtení
   * a ještě čtyřicet vteřin — dohromady přes dvě minuty, po které se
   * v okně nic nedělo. Kdo u toho sedí, okno v půlce zavře, a aplikace
   * se pak ptá zavřeného okna. Nahrávání se buď otevře hned, nebo ne.
   */
  let spot = await waitForDropSpot(win, 6_000, true);
  if (!spot && !win.isDestroyed()) {
    await odemkniNahravani(win);
    spot = await waitForDropSpot(win, 20_000, true);
  }
  /*
   * Stránka mlčí? Přenačíst a zkusit znovu.
   *
   * Okno správce souborů může zůstat viset po předchozím nepovedeném
   * pokusu — a pak na dotazy neodpovídá vůbec nic, ani ta nejjednodušší
   * otázka. Přenačtení je levné a spraví právě tenhle stav; bez něj
   * skončila celá cesta hláškou „stránka neodpověděla".
   */
  if (!spot && !win.isDestroyed()) {
    await openUrl(win, filesAdminUrl());
    await new Promise(resolve => setTimeout(resolve, 1500));
    spot = await waitForDropSpot(win, 10_000, true);
    if (!spot && !win.isDestroyed()) {
      await odemkniNahravani(win);
      spot = await waitForDropSpot(win, 15_000, true);
    }
  }

  /*
   * Poslední pokus: samotný výpis souborů. Upustit soubor na výpis
   * v administraci funguje, jen se to nedá ověřit jinak než tím, že se
   * soubor ve výpisu objeví — a to se stejně kontroluje níž.
   */
  if (!spot && !win.isDestroyed()) spot = await findDropSpot(win);
  const ready = !!spot;

  // Strom složek je na stránce stejně — nastavení z něj pak nabídne výběr
  rememberFolders(await read<ArticleFolder[]>(win, FOLDERS, []));

  /*
   * Co ve výpisu bylo před nahráním. Bez toho by se u druhého souboru
   * téhož jména vrátila adresa toho staršího — a v článku by byla cizí
   * fotka. Platí to pro obě cesty, tu vlastní i ruční.
   */
  const before = new Set((await read<Tile[]>(win, TILES, [])).map(one => one.id));

  if (!ready) {
    // Čerstvější pohled má přednost, ale jen když je se koho ptát
    if (!win.isDestroyed()) nalez = await describeDropSpots(win).catch(() => nalez) || nalez;
    return rucniCesta(win, list, names, before, login,
      'Ve správci souborů se neotevřelo nahrávání (nenašel jsem Dropzone, políčko na soubor '
      + 'ani výpis souborů).', nalez);
  }

  /*
   * Vlastní vložení, **prověřenou cestou první**.
   *
   * Ladicí rozhraní (`DOM.setFileInputFiles`) je táž cesta, jakou se
   * vkládají štítky dopravců a fotky produktů, a stránka ji nerozezná od
   * výběru myší. Dropzone a upuštění jsou přídavek pro případ, že na
   * stránce žádné políčko není — ne náhrada za něco, co funguje.
   */
  let zpusob = '';
  if (await waitForFileInput(win, ['input.dz-hidden-input', 'input[type=file]'], 4_000)) {
    try {
      await insertFiles(win, list);
      zpusob = 'policko';
    } catch { /* zkusí se Dropzone níž */ }
  }
  if (!zpusob) zpusob = await dropFiles(win, list, spot).catch(() => '');

  const found = zpusob ? await collectUrls(win, names, before) : new Map<string, string>();

  /*
   * Přetažení se ověřit nedá.
   *
   * Událost se pošle a tím to končí — jestli si ji stránka vzala, se
   * pozná jedině tak, že se soubor objeví ve výpisu. Když se neobjeví,
   * nemá smysl tvrdit „nahrálo se, jen neznám adresu"; to byla ta hláška,
   * po které nebylo jasné, co vlastně dělat. Místo toho se jde ruční
   * cestou, která soubor připraví k přetažení a dál čeká.
   */
  if (found.size === 0) {
    if (!win.isDestroyed()) nalez = await describeDropSpots(win).catch(() => nalez) || nalez;
    return rucniCesta(win, list, names, before, login,
      `Soubor jsem do stránky vložil (${zpusob || 'žádnou cestou'}), ale ve výpisu se neobjevil.`,
      nalez);
  }

  const out: ArticleUpload[] = [];
  for (let i = 0; i < list.length; i++) {
    const url = found.get(names[i]) ?? '';
    out.push({
      name: names[i], url, file: list[i],
      note: [login, url ? '' : 'Soubor se nahrál, ale adresu se nepodařilo přečíst — otevři ho '
        + 've správci souborů tlačítkem oka a adresu sem vlož.'].filter(Boolean).join(' ')
    });
  }

  closeIfDone(win, out);
  return out;
}

/**
 * Ruční cesta: soubor se připraví a čeká se, až ho člověk přetáhne.
 *
 * Nevyhazuje se chyba. Soubory jsou hotové, okno správce souborů je
 * otevřené a jediné, co schází, je přetažení — pak se **adresy přečtou
 * úplně stejně**, jen se počká déle. Slepá hláška po třech minutách
 * čekání byla to nejhorší z obou světů.
 */
async function rucniCesta(
  win: BrowserWindow, list: string[], names: string[], before: Set<string>,
  login: string, proc: string, nalez: string
): Promise<ArticleUpload[]> {
  const kam = rucniSlozka();
  const kopie = list.map(one => {
    const cil = path.join(kam, path.basename(one));
    try { fs.copyFileSync(one, cil); } catch { /* originál zůstává */ }
    return cil;
  });
  try { shell.showItemInFolder(kopie[0] ?? kam); } catch { /* složka se otevře ručně */ }

  const naleze = await collectUrls(win, names, before, 300);
  return list.map((one, i) => {
    const url = naleze.get(names[i]) ?? '';
    return {
      name: names[i], url, file: kopie[i] ?? one,
      /*
       * Hláška o přihlášení se **nesmí zahodit**. Byla tu spočítaná
       * a zahozená: když aplikace do administrace nedostane, vypadá to
       * úplně stejně jako „na stránce nic není" — a přesně to je nejčastější
       * příčina, na kterou se přitom přijde jedinou větou.
       */
      note: [login, url
        ? 'Nahráno ručně, adresu jsem přečetl z výpisu.'
        : `${proc} Soubor leží v ${kam} — přetáhni ho do okna správce souborů `
          + 'a adresu pak vlož sem. '
          + `Otevřeno bylo ${filesAdminUrl()}; kdyby to byla špatná stránka, dojdi ve `
          + 'stejném okně do správce souborů a použij „Naučit adresu".'
          + (nalez ? ` (Co jsem na stránce našel — ${nalez}.)` : '')].filter(Boolean).join(' ')
    };
  });
}

/** Kam se odloží soubory, když je nejde vložit za člověka. */
function rucniSlozka(): string {
  const dir = path.join(app.getPath('downloads'), 'quentino-web', 'nahrat');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Otevře ve správci souborů nahrávání.
 *
 * Výpis souborů žádné políčko na soubor nemá — Dropzone si ho vyrobí
 * teprve tehdy, když se nahrávání otevře. Hledá se proto tlačítko, které
 * to udělá, a to podle **textu**, ne podle třídy: třídy se v šabloně mění
 * s každou verzí, kdežto „Nahrát soubory" zůstává.
 */
async function odemkniNahravani(win: BrowserWindow): Promise<boolean> {
  /*
   * Před klikáním se umlčí nativní dialogy. `confirm` zastaví celý
   * vykreslovací proces, dokud na něj někdo neklikne — a od té chvíle
   * stránka neodpoví na žádný dotaz. Aplikace do administrace kliká, takže
   * si to riziko přivolává sama; odtud „reply was never sent".
   */
  await silenceDialogs(win);
  return read<boolean>(win, REVEAL, false);
}

/** Vlastní skript je zvlášť, aby se dal vyzkoušet bez administrace. */
const REVEAL = `
    (function () {
      var hledej = /nahr[aá]t|vlo[žz]it|p[řr]idat soubor|upload|add ?file|new file/i;
      /*
       * **Co se nesmí kliknout.**
       *
       * Tlačítko „Nový" ve správci souborů Upgates volá
       * "upUploader.browse();" a to otevře **systémový dialog pro výběr
       * souboru**. Ten zastaví celé okno: aplikace pak nedostane odpověď
       * na žádný další dotaz a volání skončí hláškou „reply was never
       * sent". Totéž dělá plocha Dropzonu (.dz-clickable) a popisek
       * svázaný s políčkem na soubor — proto se vyhazují ze seznamu,
       * i když se jinak trefí do hledaného textu.
       *
       * Otevřít nahrávání je tu k tomu, aby na stránce vzniklo políčko na
       * soubor. Když se místo toho otevře dialog, je to horší než nedělat
       * nic.
       */
      var zakaz = /browse[ ]*[(]|upUploader|AddFileButton|CallAddFileToFileManager|dz-clickable|fileinput|file-input/i;
      var popisOf = function (one) {
        var ikona = one.querySelector ? one.querySelector('i') : null;
        return (one.textContent || '') + ' ' + (one.getAttribute('title') || '')
          + ' ' + (one.getAttribute('data-tip') || '')
          + ' ' + (one.getAttribute('data-original-title') || '')
          + ' ' + (one.getAttribute('onclick') || '')
          + ' ' + (one.className || '') + ' ' + ((ikona && ikona.className) || '');
      };
      var kandidati = Array.prototype.slice.call(document.querySelectorAll(
        'a, button, [role=button], .btn, .smi, [onclick]'));
      var videt = [];
      var schovane = [];
      for (var i = 0; i < kandidati.length; i++) {
        var one = kandidati[i];
        var popis = popisOf(one);
        if (!hledej.test(popis)) continue;
        if (zakaz.test(popis)) continue;
        /* Popisek svázaný s políčkem na soubor otevře dialog stejně jako klik do něj */
        if (one.tagName === 'LABEL' && one.getAttribute('for')) continue;
        var box = one.getBoundingClientRect();
        if (box.width > 0 || box.height > 0) videt.push(one); else schovane.push(one);
      }
      /*
       * Nejdřív to, na co by člověk klikl. Schované tlačítko se zkusí až
       * potom: v administraci bývá schovaná ta část lišty, která se
       * rozbaluje pod „více", a klik na ni funguje stejně.
       */
      var kam = videt.concat(schovane)[0];
      if (!kam) return false;
      kam.click();
      return true;
    })()
  `;

/**
 * Zavře okno správce souborů, když už v něm není co dělat.
 *
 * Zavírá se až po přečtení adres, ne hned po nahrání: dokud adresy nejsou,
 * je ta stránka jediné místo, kde jsou vidět.
 */
function closeIfDone(win: BrowserWindow, out: ArticleUpload[]): void {
  if (out.some(one => !one.url)) return;
  if (win.isDestroyed()) return;
  /*
   * Se zavřením se chvíli počká — kvůli člověku, ne kvůli stránce. Okno,
   * které zmizí v tutéž vteřinu, co se v něm objeví nahraná fotka, vypadá
   * jako by se zavřelo chybou; po chvilce je vidět, že se nahrálo.
   */
  setTimeout(() => { if (!win.isDestroyed()) win.close(); }, 900);
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

  /*
   * Sledování adres i čekání na zavření se zapíná **dřív než cokoli, co
   * se dá čekat**. Okno se totiž dá zavřít hned — a když se to stalo
   * během přihlašování, sáhlo přihlášení na zavřené okno a z učení
   * vypadlo „Object has been destroyed" místo výsledku. Zavření okna je
   * tady normální konec, ne chyba.
   */
  let last = '';
  const note = (_e: unknown, url: string) => { if (url) last = url; };
  win.webContents.on('did-navigate', note);
  win.webContents.on('did-navigate-in-page', note);
  const zavreno = new Promise<void>(resolve => win.once('closed', () => resolve()));

  keepSignedIn(win, 'upgates');
  try {
    await openUrl(win, home);
    if (!win.isDestroyed()) {
      win.show();
      win.focus();
      await signIn(win, 'upgates');
    }
  } catch {
    /* Zavřené okno uprostřed přihlašování — vyhodnotí se to, kam se došlo */
  }

  await zavreno;

  /*
   * Adresa se bere jen tehdy, když je to opravdu správce souborů.
   * Zapsat kteroukoli stránku administrace by vypadalo jako naučeno
   * a nahrávání by pak končilo na „políčko se neobjevilo".
   */
  if (!/\/manager\/files\//.test(last)) {
    return {
      url: filesAdminUrl(),
      note: filesReady()
        ? 'Okno se zavřelo jinde než ve správci souborů — nic se neuložilo. '
          + 'Nevadí: nahrávat jde i bez toho, adresa se skládá z adresy administrace.'
        : 'Okno se zavřelo jinde než ve správci souborů a adresu administrace '
          + 'aplikace nezná — doplň ji v Nastavení → AI → Upgates.'
    };
  }
  saveFilesUrl(last);
  return { url: last, note: 'Adresa správce souborů je zapamatovaná.' };
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

export const __test = { filesAdminUrl, TILES, FOLDERS, REVEAL };
