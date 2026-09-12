import { BrowserWindow, app, shell } from 'electron';
import fs from 'fs';
import path from 'path';
import { getDb, getSetting, setSetting } from './db';
import { getUpgatesConfig } from './upgates';
import { listProducts } from './products';
import { openUrl, waitForFileInput, insertFiles } from './formfile';
import { keepSignedIn, signIn, signInNote } from './portallogin';
import { mediaSetup } from './media';
import type { MediaFile, MediaProduct, MediaProductPage, MediaProductQuery, MediaProductSetup,
  MediaUpload } from '../shared/types';

/**
 * Fotky produktů z e-shopu — stáhnout, převést do WebP a nahrát zpátky.
 *
 * ## Proč to je v aplikaci
 *
 * Katalog má stovky produktů a fotky se k nim nahrávaly roky. Většina je
 * v JPEG o dvou megabajtech a Google to počítá do hodnocení. Přepsat je
 * ručně znamená u každého produktu otevřít administraci, stáhnout fotky,
 * převést je někde jinde a nahrát zpátky — deset kliknutí na produkt.
 *
 * ## Jak se pozná, co už je hotové
 *
 * **Z feedu.** V něm jsou adresy všech obrázků produktu a v adrese je
 * přípona souboru, který na e-shopu leží. Produkt, jehož obrázky končí na
 * `.webp`, je hotový; produkt s `.jpg` není. Nic se nemusí hádat ani
 * stahovat — stačí se podívat na to, na co se odkazuje.
 *
 * **A z paměti na den.** Feed se stahuje jednou denně, takže fotky nahrané
 * před hodinou v něm ještě nejsou a produkt by se tvářil, že hotový není.
 * Co se povedlo nahrát, se proto pamatuje čtyřiadvacet hodin a v seznamu
 * se ukáže jako čerstvě převedené. Po dni paměť vyprší a rozhoduje zase
 * feed — kdyby se nahrání na e-shopu neuložilo, nesmí to zůstat schované
 * za naší poznámkou napořád.
 */

/* ---------- stav podle feedu ---------- */

const DONE_KEY = 'mediaWebpDone';
const DAY = 24 * 3600 * 1000;

/** Přípona z adresy obrázku, bez dotazu za otazníkem. */
export function extOf(url: string): string {
  const clean = String(url ?? '').split('?')[0].split('#')[0];
  const found = /\.([a-z0-9]{2,5})$/i.exec(clean);
  return found ? found[1].toLowerCase() : '';
}

/**
 * Stav převodu produktu podle obrázků, na které se odkazuje.
 *
 * `none` znamená „nemá ani jeden WebP", ne „nemá obrázky" — produkt bez
 * obrázků je `empty` a v seznamu nemá co dělat: není co převádět.
 */
export function webpState(urls: string[]): MediaProduct['state'] {
  const list = (urls ?? []).filter(Boolean);
  if (list.length === 0) return 'empty';
  const webp = list.filter(one => extOf(one) === 'webp').length;
  if (webp === list.length) return 'webp';
  return webp === 0 ? 'none' : 'mixed';
}

function doneMap(): Record<string, string> {
  try {
    const saved = JSON.parse(getSetting(DONE_KEY, '{}') ?? '{}');
    return saved && typeof saved === 'object' ? saved : {};
  } catch {
    return {};
  }
}

/** Paměť na den. Starší záznamy se zahazují, ať soubor nastavení neroste. */
export function markConverted(code: string, at = new Date().toISOString()): void {
  const fresh: Record<string, string> = {};
  const now = Date.now();
  for (const [key, when] of Object.entries(doneMap())) {
    if (now - new Date(when).getTime() < DAY) fresh[key] = when;
  }
  fresh[code] = at;
  setSetting(DONE_KEY, JSON.stringify(fresh));
}

export function convertedAt(code: string, now = Date.now()): string {
  const when = doneMap()[code];
  if (!when) return '';
  return now - new Date(when).getTime() < DAY ? when : '';
}

/* ---------- seznam produktů ---------- */

function imagesOf(code: string): string[] {
  const row = getDb().prepare('SELECT images, image FROM products WHERE code = ?').get(code) as any;
  if (!row) return [];
  const all = String(row.images ?? '').split('\n').filter(Boolean);
  if (all.length > 0) return all;
  return row.image ? [String(row.image)] : [];
}

export function productIdOf(code: string): string {
  const row = getDb().prepare('SELECT product_id FROM products WHERE code = ?').get(code) as any;
  return String(row?.product_id ?? '');
}

/**
 * Stránka produktů pro konvertor.
 *
 * Filtrování a řazení dělá katalog — je to tentýž seznam, jaký se prochází
 * v kompozeru, jen se k němu doplní obrázky a stav převodu. Filtr „co ještě
 * není ve WebP" se musí použít až nad výsledkem: stav se počítá z obrázků,
 * a ty v SQL nejsou v použitelné podobě.
 */
export function mediaProducts(q: MediaProductQuery = {}): MediaProductPage {
  /*
   * Bere se celý výsledek filtru, ne jedna stránka. Stav převodu se počítá
   * z obrázků, které v SQL nejsou v použitelné podobě, takže filtr „co ještě
   * není ve WebP" i celkový počet musí vzniknout až tady — ze stránky po
   * dvou stech by vyšlo „5 produktů z 200" místo skutečného počtu.
   */
  const found = [];
  for (let offset = 0; offset < 4000; offset += 200) {
    const page = listProducts({
      query: q.query, category: q.category, sort: 'title', offset, limit: 200, lang: 'cz'
    });
    found.push(...page.items);
    if (found.length >= page.total || page.items.length === 0) break;
  }
  const now = Date.now();
  const done = doneMap();
  const freshly = (code: string) => {
    const when = done[code];
    return when && now - new Date(when).getTime() < DAY ? when : '';
  };

  const all: MediaProduct[] = found.map(one => {
    const urls = imagesOf(one.code);
    return {
      code: one.code,
      productId: productIdOf(one.code),
      title: one.title.cz || one.title.en || one.title.sk || one.code,
      url: one.url.cz || '',
      thumb: one.image,
      // Přípona se počítá tady, ne v okně — ať je pravidlo „co je hotové" na jednom místě
      images: urls.map(url => ({ url, ext: extOf(url) })),
      webp: urls.filter(url => extOf(url) === 'webp').length,
      state: webpState(urls),
      convertedAt: freshly(one.code)
    };
  });

  /*
   * Čerstvě nahraný produkt se z výběru „co chybí" nevyhazuje. Kdyby zmizel,
   * vypadalo by to, že se práce ztratila — a hlavně by nešlo zkontrolovat,
   * jestli se nahrání povedlo. Zůstává, jen označený.
   */
  const wanted = q.only === 'todo'
    ? all.filter(one => (one.state === 'none' || one.state === 'mixed') && !one.convertedAt)
    : q.only === 'done'
      ? all.filter(one => one.state === 'webp' || one.convertedAt)
      : all.filter(one => one.state !== 'empty');

  const offset = Math.max(0, q.offset ?? 0);
  const limit = Math.min(Math.max(q.limit ?? 40, 1), 200);
  return { items: wanted.slice(offset, offset + limit), total: wanted.length, offset, limit };
}

/** Souhrn pro hlavičku: kolik produktů je hotových a kolik ne. */
export function mediaProductStats(): { total: number; webp: number; todo: number; empty: number } {
  const rows = getDb().prepare('SELECT code, images, image FROM products').all() as any[];
  const done = doneMap();
  const now = Date.now();
  let webp = 0; let todo = 0; let empty = 0;
  for (const row of rows) {
    const all = String(row.images ?? '').split('\n').filter(Boolean);
    const list = all.length > 0 ? all : (row.image ? [String(row.image)] : []);
    const state = webpState(list);
    const fresh = !!done[row.code] && now - new Date(done[row.code]).getTime() < DAY;
    if (state === 'empty') empty++;
    else if (state === 'webp' || fresh) webp++;
    else todo++;
  }
  return { total: rows.length, webp, todo, empty };
}

/* ---------- vlastní nastavení u produktu ---------- */

const SETUP_KEY = 'mediaProductSetup';
/** Kolik produktů si pamatovat. Vlastní nastavení je výjimka, ne pravidlo. */
const SETUP_CAP = 300;

function setupMap(): Record<string, MediaProductSetup> {
  try {
    const saved = JSON.parse(getSetting(SETUP_KEY, '{}') ?? '{}');
    return saved && typeof saved === 'object' ? saved : {};
  } catch {
    return {};
  }
}

/** Vlastní nastavení produktu, nebo `null`, když platí obecné. */
export function productSetup(code: string): MediaProductSetup | null {
  return setupMap()[code] ?? null;
}

/**
 * Uloží nebo zruší vlastní nastavení produktu.
 *
 * `null` znamená „zpátky na obecné" — to je jiný stav než uložené nastavení,
 * které se obecnému náhodou rovná: kdyby se ukládalo i to, změna obecného
 * nastavení by se u takového produktu tiše neprojevila.
 */
export function saveProductSetup(code: string, value: MediaProductSetup | null):
  MediaProductSetup | null {
  const all = setupMap();
  if (value) all[code] = value;
  else delete all[code];

  const keys = Object.keys(all);
  if (keys.length > SETUP_CAP) {
    for (const key of keys.slice(0, keys.length - SETUP_CAP)) delete all[key];
  }
  setSetting(SETUP_KEY, JSON.stringify(all));
  return productSetup(code);
}

/* ---------- stažení originálů ---------- */

function workRoot(): string {
  const setup = mediaSetup();
  const base = setup.outDir && fs.existsSync(setup.outDir)
    ? setup.outDir
    : path.join(app.getPath('downloads'), 'quentino-web');
  return base;
}

/** Složka produktu ve výstupní složce — ať jsou fotky jednoho produktu spolu. */
export function productFolder(code: string): string {
  const dir = path.join(workRoot(), 'produkty', code.replace(/[^\w.-]+/g, '_'));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Název souboru z adresy obrázku.
 *
 * Jméno se zachovává schválně: na e-shopu se podle něj poznají fotky téhož
 * produktu a v administraci se řadí abecedně. Náhodné jméno by pořadí
 * fotek u produktu rozházelo.
 */
export function nameFromUrl(url: string, index: number): string {
  const clean = String(url ?? '').split('?')[0].split('#')[0];
  const base = decodeURIComponent(clean.split('/').pop() ?? '').replace(/[^\w.-]+/g, '-');
  return base && /\.[a-z0-9]{2,5}$/i.test(base) ? base : `fotka-${index + 1}.jpg`;
}

/**
 * Stáhne fotky produktu.
 *
 * Stahuje se po jedné, ne najednou: je to vlastní e-shop a deset
 * souběžných stažení velkých fotek mu nepomůže v ničem. Co se nepovede,
 * se přeskočí a řekne — jedna chybějící fotka není důvod nepřevést
 * zbytek.
 *
 * `wanted` vybírá jen některé fotky, a **porovnává se proti feedu**: co
 * v katalogu u produktu není, se nestahuje. Okno tak nemůže přes tenhle
 * kanál sáhnout na libovolnou adresu.
 *
 * Vrací i adresy, ze kterých soubory vznikly, ve stejném pořadí jako
 * soubory — rozhraní podle nich pozná, který náhled patří ke kterému
 * výsledku. Párovat to podle názvu souboru by selhalo u dvou fotek,
 * které se jmenují stejně a liší se jen složkou.
 */
export async function downloadProductImages(code: string, wanted?: string[]):
  Promise<{ files: MediaFile[]; urls: string[]; skipped: string[]; dir: string }> {
  const all = imagesOf(code);
  if (all.length === 0) throw new Error('Produkt nemá ve feedu žádné obrázky.');
  const pick = wanted && wanted.length > 0 ? all.filter(one => wanted.includes(one)) : all;
  if (pick.length === 0) throw new Error('Žádná z vybraných fotek u produktu ve feedu není.');
  const dir = productFolder(code);
  const files: MediaFile[] = [];
  const urls: string[] = [];
  const skipped: string[] = [];

  for (let i = 0; i < pick.length; i++) {
    const url = pick[i];
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length === 0) throw new Error('prázdný soubor');
      const file = path.join(dir, `origin-${String(i + 1).padStart(2, '0')}-${nameFromUrl(url, i)}`);
      fs.writeFileSync(file, bytes);
      files.push({ path: file, name: path.basename(file), size: bytes.length, kind: 'image' });
      urls.push(url);
    } catch (e: any) {
      skipped.push(`${nameFromUrl(url, i)} — ${String(e?.message ?? e)}`);
    }
  }
  if (files.length === 0) throw new Error(`Nestáhla se ani jedna fotka. ${skipped.join('; ')}`);
  return { files, urls, skipped, dir };
}

/**
 * Uloží převedenou fotku do složky produktu.
 *
 * Tady se **přepisuje**, na rozdíl od zbytku konvertoru: ve složce produktu
 * leží jen to, co aplikace sama stáhla a převedla, žádný originál z foťáku.
 * Číslovat kopie by při druhém pokusu znamenalo nahrát na e-shop starou
 * verzi z prvního.
 */
export function saveProductWebp(code: string, name: string, bytes: Uint8Array):
  { file: string; size: number } {
  const dir = productFolder(code);
  const file = path.join(dir, name.replace(/[^\w.-]+/g, '-').replace(/\.[^.]+$/, '') + '.webp');
  fs.writeFileSync(file, bytes);
  return { file, size: fs.statSync(file).size };
}

export function revealProduct(code: string): void {
  shell.openPath(productFolder(code));
}

/* ---------- nahrání do administrace ---------- */

/**
 * Adresa produktu v administraci.
 *
 * Skládá se z adresy administrace, kterou aplikace zná kvůli fakturám,
 * a z vnitřního ID produktu z feedu. Napevno ji zapsat nejde — v adrese je
 * číslo serveru, na kterém e-shop běží (`…s19.upgates.com`), a to má každý
 * e-shop jiné.
 */
export function productAdminUrl(productId: string): string {
  const home = (getSetting('invoiceAdminHome', '') ?? '').trim()
    || `${getUpgatesConfig().url.replace(/\/+$/, '')}/manager/`;
  const root = home.replace(/\/manager\/?$/, '').replace(/\/+$/, '');
  return `${root}/manager/products/main/default/${encodeURIComponent(productId)}/`;
}

/**
 * Vodítka k políčku na fotky na stránce produktu.
 *
 * Na stránce je políček na soubor víc — obrázky, soubory ke stažení,
 * varianty — a Dropzone je všechna schovává, takže „to viditelné" tu
 * nepomůže. Jde se od nejužšího k nejširšímu: nejdřív políčko uvnitř
 * sekce s obrázky, pak jakékoli, které bere obrázky, a teprve nakonec
 * cokoli. Kdyby Upgates sekci přejmenovaly, spadne to na širší vodítko
 * místo na chybu.
 */
const IMAGE_INPUT_HINTS = [
  '#sortable-images input[type=file]',
  '[id*="pictureSection"] input[type=file]',
  'input.dz-hidden-input[accept*="image"]',
  'input[type=file][accept*="image"]',
  'input.dz-hidden-input'
];

let uploadWin: BrowserWindow | null = null;

/**
 * Otevře produkt v administraci a vloží do něj převedené fotky.
 *
 * Vkládá se přes ladicí rozhraní prohlížeče, tedy touž cestou jako výběr
 * myší — Dropzone dostane jednu událost se všemi soubory a nahraje je.
 * **Staré fotky se nemažou**: smazání je nevratné a patří člověku, který
 * se na výsledek podívá. V okně tedy po nahrání zůstanou obě sady a starou
 * si smaže sám.
 */
export async function uploadProductImages(code: string, files: string[]): Promise<MediaUpload> {
  const productId = productIdOf(code);
  if (!productId) {
    return {
      opened: false, filled: false,
      note: `Produkt ${code} nemá ve feedu ID, takže se v administraci nedá otevřít. `
        + 'Stáhni katalog znovu (Katalog → obnovit) a zkus to znovu.'
    };
  }

  const win = uploadWin && !uploadWin.isDestroyed() ? uploadWin : new BrowserWindow({
    width: 1280, height: 900,
    title: `Fotky produktu ${code}`,
    webPreferences: { partition: 'persist:upgates', sandbox: true }
  });
  uploadWin = win;
  win.on('closed', () => { uploadWin = null; });

  keepSignedIn(win, 'upgates');
  await openUrl(win, productAdminUrl(productId));
  win.show();
  win.focus();
  const login = signInNote('upgates', await signIn(win, 'upgates'));

  const ready = await waitForFileInput(win, IMAGE_INPUT_HINTS, 3 * 60_000);
  if (!ready) {
    return {
      opened: true, filled: false,
      note: [login, `Políčko pro fotky se na stránce neobjevilo. Fotky jsou v ${productFolder(code)}`
        + ' — přetáhni je do sekce s obrázky ručně.'].filter(Boolean).join(' ')
    };
  }
  try {
    await insertFiles(win, files);
    markConverted(code);
    return {
      opened: true, filled: true,
      note: [login, `Nahráno ${files.length} fotek. Zkontroluj pořadí, smaž staré verze a produkt ulož `
        + '— mazání ani uložení aplikace nedělá.'].filter(Boolean).join(' ')
    };
  } catch (e: any) {
    return {
      opened: true, filled: false,
      note: [login, `Fotky se nepodařilo vložit (${String(e?.message ?? e)}). Jsou v ${productFolder(code)}`
        + ' — přetáhni je do okna ručně.'].filter(Boolean).join(' ')
    };
  }
}

export const __test = { webpState, extOf, nameFromUrl, productAdminUrl, IMAGE_INPUT_HINTS };
