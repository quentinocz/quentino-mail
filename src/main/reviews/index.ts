import vm from 'node:vm';
import { getSetting, setSetting } from '../db';
import { decrypt } from '../secure';
import { getSettings } from '../settings';
import { ask } from '../ai';
import { extractLinks } from '../articles/urlmap';
import { linkUrls } from '../articles';
import {
  listReviews, getReview, saveReview, deleteReview, moveReview, nextSort,
  wallItems, normalize, blankText, isDirty, DIRTY_KEY, SCHEMA
} from './store';
import { reviewsScript, DEFAULT_WALL } from './wall';
import type { Review, ReviewsConfig, ReviewsState } from '../../shared/types';

/**
 * Recenze zákazníků na e-shopu.
 *
 * ## Odkud se berou
 *
 * Dřív byly natvrdo v kusu JavaScriptu vloženém do šablony e-shopu: přidat
 * recenzi znamenalo otevřít kód, najít správnou závorku a dát pozor na
 * apostrofy uvnitř textu. Jedna překlepnutá uvozovka shodila celou zeď.
 *
 * Teď jsou v aplikaci a **vystavují se do Supabase** — na e-shopu zůstává
 * skript, který si je stáhne. Přidání recenze je tedy vyplnit a publikovat;
 * do šablony e-shopu se už nesahá.
 *
 * ## Proč i záloha ve skriptu
 *
 * Protože Supabase může vypadnout a zeď bez fotek vypadá jako rozbitá
 * stránka. Ve skriptu je proto zapečená kopie stavu z okamžiku vystavení
 * a prohlížeč si navíc poslední úspěšně staženou sadu schovává u sebe.
 * Pořadí je: čerstvá data ze Supabase → poslední stažená → kopie ve
 * skriptu.
 */

const DEFAULT_PATH = 'quentino-recenze.json';
const PUBLISHED_KEY = 'reviewsPublishedAt';
const ERROR_KEY = 'reviewsError';

interface Secrets { url: string; key: string; bucket: string; path: string }

/**
 * Přístup do úložiště.
 *
 * Schválně se sdílí s texty na webu: je to tentýž projekt Supabase a tentýž
 * kbelík. Kdyby si recenze vedly vlastní nastavení, musel by se servisní
 * klíč vyplňovat dvakrát — a druhý by se jednou zapomněl přepsat.
 */
function secrets(): Secrets {
  const raw = getSetting('webTextsKey', '')!;
  let key = '';
  if (raw) { try { key = decrypt(raw); } catch { key = ''; } }
  return {
    url: (getSetting('webTextsUrl', '')! || getSetting('chatSupabaseUrl', '')! || '').replace(/\/+$/, ''),
    key,
    bucket: getSetting('webTextsBucket', 'web')! || 'web',
    path: getSetting('reviewsPath', DEFAULT_PATH)! || DEFAULT_PATH
  };
}

function objectUrl(s: Secrets): string {
  const path = s.path.split('/').map(encodeURIComponent).join('/');
  return `${s.url}/storage/v1/object/${encodeURIComponent(s.bucket)}/${path}`;
}

function publicUrl(s: Secrets): string {
  if (!s.url) return '';
  const path = s.path.split('/').map(encodeURIComponent).join('/');
  return `${s.url}/storage/v1/object/public/${encodeURIComponent(s.bucket)}/${path}`;
}

export function reviewsConfig(): ReviewsConfig {
  const s = secrets();
  return {
    url: s.url,
    hasKey: !!s.key,
    bucket: s.bucket,
    path: s.path,
    ready: !!(s.url && s.key),
    publicUrl: publicUrl(s)
  };
}

export function saveReviewsPath(path: string): ReviewsConfig {
  setSetting('reviewsPath', (path ?? '').trim() || DEFAULT_PATH);
  return reviewsConfig();
}

/* ---------- stav pro rozhraní ---------- */

export function reviewsState(): ReviewsState {
  const items = listReviews();
  return {
    items,
    config: reviewsConfig(),
    publishedAt: getSetting(PUBLISHED_KEY, '')!,
    dirty: isDirty(),
    error: getSetting(ERROR_KEY, '')!,
    script: reviewsScript(publicUrl(secrets()), wallItems(items), DEFAULT_WALL)
  };
}

/* ---------- vystavení ---------- */

async function createBucket(s: Secrets): Promise<void> {
  const res = await fetch(`${s.url}/storage/v1/bucket`, {
    method: 'POST',
    headers: { apikey: s.key, Authorization: `Bearer ${s.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: s.bucket, name: s.bucket, public: true })
  });
  // 409 = kbelík už existuje, což je přesně to, co jsme chtěli
  if (!res.ok && res.status !== 409) {
    throw new Error(`Kbelík ${s.bucket} nejde založit: ${res.status} ${(await res.text()).slice(0, 160)}`);
  }
}

/**
 * Vystaví recenze do Supabase.
 *
 * Posílá se **všechno**, co má být vidět, ne rozdíl: soubor je jediný a
 * prohlížeč si ho stahuje celý. Vedle položek jde i čas vystavení, aby se
 * dalo poznat, jak stará data e-shop zrovna ukazuje.
 */
export async function publishReviews(): Promise<string> {
  const s = secrets();
  if (!s.url) throw new Error('Chybí adresa projektu Supabase (Texty na webu → Napojení).');
  if (!s.key) throw new Error('Chybí servisní klíč (service_role) — bez něj se do úložiště zapsat nedá.');

  const at = new Date().toISOString();
  const body = JSON.stringify({ version: 1, at, items: wallItems() });
  const send = () => fetch(objectUrl(s), {
    method: 'POST',
    headers: {
      apikey: s.key,
      Authorization: `Bearer ${s.key}`,
      'Content-Type': 'application/json; charset=utf-8',
      // Minuta v CDN stačí: recenze se nemění každou chvíli
      'cache-control': 'max-age=60',
      'x-upsert': 'true'
    },
    body
  });

  let res = await send();
  if (res.status === 400 || res.status === 404) {
    const text = await res.text();
    if (/bucket/i.test(text)) {
      await createBucket(s);
      res = await send();
    } else {
      throw new Error(`Recenze se nepodařilo vystavit: ${res.status} ${text.slice(0, 200)}`);
    }
  }
  if (!res.ok) {
    throw new Error(`Recenze se nepodařilo vystavit: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }

  setSetting(PUBLISHED_KEY, at);
  setSetting(DIRTY_KEY, '0');
  setSetting(ERROR_KEY, '');
  return at;
}

/**
 * Natáhne vystavené recenze zpátky do aplikace.
 *
 * Je to cesta, jak druhý počítač dostane, co se vystavilo z prvního.
 * Rozdělaná změna má přednost — jinak by se práce, která ještě není na
 * webu, tiše přepsala starším stavem.
 *
 * Vystavený soubor nezná pořadí ani vypnuté recenze; ty zůstávají, jak
 * jsou tady. Páruje se podle adresy fotky: ta je u recenze to jediné,
 * co se nemění a je jedinečné.
 */
export async function pullReviews(): Promise<string> {
  const url = publicUrl(secrets());
  if (!url) return 'Chybí adresa úložiště.';
  if (isDirty()) {
    return 'V aplikaci je změna, která ještě není na webu — nejdřív ji vystav, pak se natáhne stav z webu.';
  }

  const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`, { cache: 'no-store' as any });
  // Soubor ještě není — první vystavení ho založí, není to chyba
  if (res.status === 404 || res.status === 400) return '';
  if (!res.ok) throw new Error(`Recenze se nepodařilo načíst: ${res.status}`);

  const data = await res.json() as any;
  if (!data || !Array.isArray(data.items)) return '';

  const known = new Map(listReviews().map(one => [one.image, one]));
  let added = 0;
  let updated = 0;

  for (const row of data.items) {
    const image = String(row?.img ?? '').trim();
    if (!image) continue;
    const langs: Record<string, any> = {};
    for (const [lang, part] of Object.entries(row)) {
      if (lang === 'img' || lang === 'w' || lang === 'h' || !part || typeof part !== 'object') continue;
      const one = part as any;
      langs[lang] = {
        caption: one.captionHtml ?? '', review: one.reviewText ?? '', name: one.reviewName ?? ''
      };
    }
    const mine = known.get(image);
    saveReview({
      ...(mine ?? {}),
      id: mine?.id,
      image,
      width: Number(row?.w) || mine?.width || 0,
      height: Number(row?.h) || mine?.height || 0,
      sort: mine?.sort ?? nextSort(),
      active: mine ? mine.active : true,
      langs
    });
    if (mine) updated++; else added++;
  }

  // Stažení není změna, kterou by bylo potřeba vystavovat — je to totéž, co na webu
  setSetting(DIRTY_KEY, '0');
  return added || updated
    ? `Načteno z webu: ${added} nových, ${updated} srovnaných.`
    : 'Na webu nic nového není.';
}

/* ---------- převzetí původního skriptu ---------- */

/**
 * Načte recenze z původního ručně psaného skriptu.
 *
 * Sedmadvacet recenzí ve třech jazycích se ručně přepisovat nebude. Ve
 * skriptu jsou jako pole `GALLERY_DATA`, jenže to není JSON: klíče bez
 * uvozovek, apostrofy, escapované znaky v textech. Vyhodnotí se proto jako
 * JavaScript — ale **v prázdném prostoru a s časovým stropem**, takže
 * vložený kus kódu nemá na co sáhnout a nemůže se zacyklit. Z výsledku se
 * pak bere jen to, co má správný tvar.
 */
export function parseLegacy(text: string): any[] {
  const source = String(text ?? '');
  const at = source.indexOf('GALLERY_DATA');
  const from = source.indexOf('[', at < 0 ? 0 : at);
  if (from < 0) throw new Error('V textu není pole GALLERY_DATA.');

  // Konec pole: první hranatá závorka, která zavře tu úvodní
  let depth = 0;
  let to = -1;
  for (let i = from; i < source.length; i++) {
    const ch = source[i];
    if (ch === '[') depth++;
    else if (ch === ']') { depth--; if (depth === 0) { to = i + 1; break; } }
  }
  if (to < 0) throw new Error('Pole GALLERY_DATA není uzavřené — chybí kus textu?');

  let parsed: any;
  try {
    parsed = vm.runInNewContext(`(${source.slice(from, to)})`, Object.create(null), { timeout: 1000 });
  } catch (e: any) {
    throw new Error(`Pole se nepodařilo přečíst: ${String(e?.message ?? e).slice(0, 120)}`);
  }
  if (!Array.isArray(parsed)) throw new Error('GALLERY_DATA není pole.');
  return parsed;
}

/**
 * Převezme recenze z původního skriptu do aplikace.
 *
 * Páruje se podle adresy fotky: co už tu je, se **nepřepisuje** — po
 * převzetí se recenze upravují tady a druhé spuštění importu by ruční
 * úpravy zahodilo.
 */
export function importLegacy(text: string): { added: number; skipped: number } {
  const rows = parseLegacy(text);
  const known = new Set(listReviews().map(one => one.image));
  let added = 0;
  let skipped = 0;
  let sort = nextSort();

  for (const row of rows) {
    const image = String(row?.img ?? '').trim();
    if (!image) { skipped++; continue; }
    if (known.has(image)) { skipped++; continue; }

    const langs: Record<string, any> = {};
    for (const [lang, part] of Object.entries(row)) {
      if (lang === 'img' || lang === 'w' || lang === 'h' || lang === 'alt') continue;
      if (!part || typeof part !== 'object') continue;
      const one = part as any;
      langs[lang] = {
        caption: one.captionHtml ?? '', review: one.reviewText ?? '', name: one.reviewName ?? ''
      };
    }
    saveReview({
      image,
      width: Number(row?.w) || 0,
      height: Number(row?.h) || 0,
      sort: sort++,
      active: true,
      langs
    });
    known.add(image);
    added++;
  }
  return { added, skipped };
}

/* ---------- překlad ---------- */

const TRANSLATE_SYSTEM = `Překládáš popisky a recenze zákazníků na e-shopu s pánskou módou
(kravaty, motýlky, kšandy, kapesníčky) z češtiny do slovenštiny a angličtiny.

Pravidla:
- Vrať POUZE JSON pole ve stejném pořadí a délce jako vstup, každá položka
  { "sk": "...", "en": "..." }.
- Zachovej HTML značky i jejich atributy přesně tak, jak jsou (včetně href a style).
  Překládej jen viditelný text mezi značkami.
- Recenze je citace zákazníka: překládej ji přirozeně, ale neměň její význam
  ani nepřidávej nic, co v ní není. Uvozovky ponech ve stylu cílového jazyka.
- Jména a názvy produktových kolekcí nepřekládej, pokud nemají zavedený překlad.
- Emodži ponech.`;

async function translateBatch(texts: string[]): Promise<{ sk: string; en: string }[]> {
  const source = texts.map(one => String(one ?? '').trim());
  const empty = source.map(() => ({ sk: '', en: '' }));
  if (!source.some(Boolean)) return empty;

  const out = await ask(getSettings().draftModel, TRANSLATE_SYSTEM, JSON.stringify(source), 3000);
  // Model odpověď občas zabalí do bloku s kódem — jinak by se JSON nedal načíst
  const clean = out.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();

  let parsed: any = null;
  try {
    parsed = JSON.parse(clean);
  } catch {
    throw new Error('Překlad se nepovedl přečíst — zkus to ještě jednou.');
  }
  if (!Array.isArray(parsed) || parsed.length !== source.length) {
    throw new Error(`Překlad se vrátil v jiném tvaru (${Array.isArray(parsed) ? parsed.length : '?'} `
      + `místo ${source.length}) — zkus to ještě jednou.`);
  }
  return source.map((one, i) => ({
    sk: one ? String(parsed[i]?.sk ?? '').trim() : '',
    en: one ? String(parsed[i]?.en ?? '').trim() : ''
  }));
}

/**
 * Vymění adresy odkazů v přeloženém popisku.
 *
 * Model překládá text, **adresy nechává být** — a je to tak správně:
 * vymyslet slovenskou adresu produktu z české nejde a model by ji
 * vymyslel. Správnou zná e-shop sám: `linkUrls` ji dohledá v mapě adres,
 * a co v ní není, zjistí z přepínače jazyků na samotné stránce.
 */
async function fixLinks(html: string, sourceHrefs: string[],
  links: Map<string, Record<string, { url: string; via: string }>>,
  lang: string): Promise<string> {
  /*
   * Páruje se **podle pořadí odkazů**, ne podle adresy v přeloženém textu.
   *
   * Překlad má značky ve stejném pořadí (to překladač hlídá), ale adresu
   * v nich už model mohl přepsat — a z přepsané se ta správná nedohledá.
   * Hledalo se podle adresy a u přepsaného odkazu se nenašlo nic, takže
   * v cizí mutaci zůstal český odkaz.
   */
  let index = 0;
  return (html ?? '').replace(/(<a\b[^>]*\bhref\s*=\s*)(["'])([^"']+)\2/gi,
    (match, head, quote, href) => {
      const key = sourceHrefs[index++] ?? String(href);
      const found = links.get(key)?.[lang];
      return found?.url ? `${head}${quote}${found.url}${quote}` : match;
    });
}

export interface ReviewTranslation {
  id: string;
  langs: string[];
  /** Odkazy, u kterých se nepodařilo najít adresu na cizím trhu */
  unresolved: string[];
}

/**
 * Přeloží recenzi z češtiny do slovenštiny a angličtiny.
 *
 * Podpis zákazníka se **nepřekládá**: jméno je jméno. Když u něj má být
 * v angličtině něco jiného (třeba „a" místo spojky), dá se přepsat ručně —
 * je to jedno slovo a hádat ho za člověka nemá cenu.
 */
export async function translateReview(id: string): Promise<ReviewTranslation> {
  const review = getReview(id);
  if (!review) throw new Error('Recenze už neexistuje.');
  const cz = review.langs.cz ?? blankText();
  if (!cz.caption && !cz.review) throw new Error('Česká verze je prázdná, není co překládat.');

  // Adresy nejdřív: překlad textu je na modelu, adresy na mapě a e-shopu
  const links = new Map<string, Record<string, { url: string; via: string }>>();
  const unresolved: string[] = [];
  for (const href of extractLinks(cz.caption)) {
    try {
      const found = await linkUrls(href, 'cz');
      links.set(href, found as any);
      for (const lang of ['sk', 'en']) {
        if (!found[lang] || found[lang].via === 'domain') unresolved.push(`${href} (${lang})`);
      }
    } catch {
      unresolved.push(href);
    }
  }

  const sourceHrefs = extractLinks(cz.caption);
  const [caption, text] = await translateBatch([cz.caption, cz.review]);
  const langs = { ...review.langs };
  for (const lang of ['sk', 'en'] as const) {
    langs[lang] = {
      caption: await fixLinks(caption[lang], sourceHrefs, links, lang),
      review: text[lang],
      // Podpis se přenáší beze změny — jméno se nepřekládá
      name: cz.name
    };
  }
  saveReview({ ...review, langs });
  return { id, langs: ['sk', 'en'], unresolved };
}

export {
  SCHEMA, listReviews, getReview, saveReview, deleteReview, moveReview, nextSort,
  wallItems, normalize, isDirty
};
export const __test = { secrets, publicUrl, TRANSLATE_SYSTEM, parseLegacy, fixLinks };
