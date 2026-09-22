import crypto from 'crypto';
import { getSetting, setSetting } from './db';
import { czMs, czLocal, shiftMinutes, translateWeb, webStorage, webTextsConfig } from './webtexts';
import { translateUrl } from './articles/urlmap';
import { bannerScript } from './bannerscript';
import { eventFromWeb, dropEventOfSource } from './events';
import type {
  Banner, BannerSet, BannerCopy, BannerLook, BannerSmart, BannerClash, BannersState, WebText
} from '../shared/types';

/**
 * Bannery na úvodní stránce e-shopu.
 *
 * ## Co se řeší
 *
 * Šablona Upgates má na hlavní stránce karusel a mění se v administraci —
 * pro každý trh zvlášť, bez plánování dopředu a bez čehokoli, co se hýbe
 * s časem. Vánoční akce, která má začít v pátek v osm, se tak dá udělat
 * jedině tak, že u toho někdo v pátek v osm sedí. Třikrát, protože
 * quentino.cz, quentino.sk a wearquentino.com jsou tři samostatné e-shopy.
 *
 * ## Jak je to udělané
 *
 * Stejně jako naplánované texty o doručení, protože to funguje a je to
 * jedno úložiště: aplikace vystaví **celý plán** (i sady, které začnou za
 * týden) jako obyčejný JSON do veřejného kbelíku Supabase Storage. Skript
 * v hlavičce e-shopu si ho stáhne, schová původní karusel a na jeho místo
 * vykreslí vlastní mřížku. Prohlížeč si sám vybere sadu, která zrovna
 * platí, a sám počítá odpočty.
 *
 * Z toho plyne to podstatné: **aplikace nemusí běžet**, když má sada
 * začít nebo skončit, a odpočet do konce akce tiká i v noci.
 *
 * ## Proč je záložní sada přímo ve skriptu
 *
 * Kdyby úložiště nebylo dostupné, zůstalo by na úvodní stránce prázdné
 * místo — původní karusel je v tu chvíli už schovaný. Do skriptu, který se
 * vkládá do šablony, se proto zapeče jedna vybraná sada. Ta se vykreslí
 * okamžitě, ještě než se plán stáhne, a když se plán nestáhne vůbec,
 * zůstane. Vedlejší užitek: úvodní stránka má bannery hned v prvním
 * vykreslení a nic na ní nepodskočí.
 */

const DEFAULT_PATH = 'quentino-bannery.json';
const DEFAULT_TTL = 300;
/** Sady, které skončily před víc než dvěma měsíci, se samy uklidí. */
const KEEP_DAYS = 60;
/** Nejvíc bannerů v jedné sadě. Víc než tři otočky po čtyřech nikdo nepročte. */
const MAX_BANNERS = 12;
/**
 * Nejmenší ztmavení fotky, když je na ní text.
 *
 * Není to nastavení vkusu. Bílý nadpis na světlé fotce látky je nečitelný
 * a na malém telefonu v slunci úplně. Při fotce s textem se proto ztmavení
 * nepustí pod tuhle hodnotu, i kdyby se posuvník stáhl na nulu.
 */
export const MIN_OVERLAY = 18;

/* ---------- nastavení ---------- */

function bannersPath(): string {
  return getSetting('bannersPath', DEFAULT_PATH)! || DEFAULT_PATH;
}

function ttl(): number {
  return Number(getSetting('bannersTtl', String(DEFAULT_TTL))) || DEFAULT_TTL;
}

/** Veřejná adresa souboru v kbelíku — pro plán i pro nahrané fotky. */
export function publicUrlOf(path: string): string {
  const s = webStorage();
  if (!s.url) return '';
  const clean = String(path).replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');
  return `${s.url}/storage/v1/object/public/${encodeURIComponent(s.bucket)}/${clean}`;
}

function objectUrlOf(path: string): string {
  const s = webStorage();
  const clean = String(path).replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');
  return `${s.url}/storage/v1/object/${encodeURIComponent(s.bucket)}/${clean}`;
}

/* ---------- tvar sady ---------- */

function text(value: any): WebText {
  if (typeof value === 'string') return { cz: value, sk: '', en: '' };
  return {
    cz: String(value?.cz ?? '').trim(),
    sk: String(value?.sk ?? '').trim(),
    en: String(value?.en ?? '').trim()
  };
}

const filled = (t: WebText) => !!(t.cz || t.sk || t.en);

const clamp = (value: any, low: number, high: number, fallback: number) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.max(low, Math.min(high, n)) : fallback;
};

const oneOf = <T extends string>(value: any, allowed: readonly T[], fallback: T): T =>
  (allowed as readonly string[]).includes(String(value)) ? (String(value) as T) : fallback;

/** Barva jen jako #rrggbb nebo #rgb — do skriptu se vkládá do stylu. */
function color(value: any, fallback: string): string {
  const one = String(value ?? '').trim();
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(one) ? one : fallback;
}

/** Výřez fotky, „50% 50%". Cokoli jiného by se dostalo do stylu jako text. */
function focus(value: any): string {
  const one = String(value ?? '').trim();
  return /^\d{1,3}% \d{1,3}%$/.test(one) ? one : '50% 50%';
}

/**
 * Adresa obrázku.
 *
 * Jen http(s) a data:image — do stylu se vkládá jako `url(...)` a `javascript:`
 * nebo uvozovka uvnitř by z toho udělaly cestu, jak do stránky e-shopu dostat
 * cizí kód.
 */
export function safeImage(value: any): string {
  const one = String(value ?? '').trim();
  if (/["'()\\\s]/.test(one)) return '';
  return /^https?:\/\//i.test(one) ? one : '';
}

/** Odkaz. Relativní cesta i celá adresa; nic, co by se dalo spustit. */
export function safeHref(value: any): string {
  const one = String(value ?? '').trim();
  if (!one) return '';
  if (/^https?:\/\//i.test(one)) return one;
  if (one.startsWith('/')) return one;
  return '';
}

function look(value: any): BannerLook {
  const image = safeImage(value?.image);
  const overlay = clamp(value?.overlay, 0, 90, 40);
  return {
    image,
    bg: color(value?.bg, '#1c1c22'),
    fg: color(value?.fg, '#ffffff'),
    overlay,
    align: oneOf(value?.align, ['left', 'center', 'right'] as const, 'left'),
    pos: oneOf(value?.pos, ['top', 'middle', 'bottom'] as const, 'bottom'),
    focus: focus(value?.focus)
  };
}

function smart(value: any): BannerSmart {
  const until = String(value?.until ?? '').trim();
  return {
    kind: oneOf(value?.kind, ['none', 'countdown', 'code', 'delivery'] as const, 'none'),
    until,
    untilMs: until ? czMs(until, true) : 0,
    // Kód se čte nahlas a přepisuje do košíku: velká písmena a nic exotického
    code: String(value?.code ?? '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 24),
    // Jen pár znaků — emoji je jedno, ne věta
    emoji: Array.from(String(value?.emoji ?? '').trim()).slice(0, 3).join(''),
    effect: oneOf(value?.effect, ['none', 'snow', 'shine', 'pulse', 'float'] as const, 'none')
  };
}

function copy(value: any): BannerCopy {
  return {
    title: text(value?.title),
    text: text(value?.text),
    button: text(value?.button),
    href: {
      cz: safeHref(value?.href?.cz ?? (typeof value?.href === 'string' ? value.href : '')),
      sk: safeHref(value?.href?.sk),
      en: safeHref(value?.href?.en)
    }
  };
}

export function normalizeBanner(value: any): Banner {
  const one: Banner = {
    id: String(value?.id ?? '') || crypto.randomUUID(),
    name: String(value?.name ?? '').trim().slice(0, 60),
    off: !!value?.off,
    copy: copy(value?.copy ?? value),
    look: look(value?.look ?? value),
    smart: smart(value?.smart ?? value)
  };
  /*
   * Čitelnost se vynucuje tady, ne v okně: plán může přijít i z druhého
   * počítače nebo z ručně upraveného souboru a nečitelný nadpis na fotce
   * je chyba, kterou nikdo nenahlásí — jen se z banneru neklikne.
   */
  const hasText = filled(one.copy.title) || filled(one.copy.text);
  if (one.look.image && hasText && one.look.overlay < MIN_OVERLAY) one.look.overlay = MIN_OVERLAY;
  return one;
}

export function normalizeSet(value: any): BannerSet {
  const from = String(value?.from ?? '').trim();
  const to = String(value?.to ?? '').trim();
  const banners = (Array.isArray(value?.banners) ? value.banners : [])
    .slice(0, MAX_BANNERS)
    .map(normalizeBanner);
  return {
    id: String(value?.id ?? '') || crypto.randomUUID(),
    name: String(value?.name ?? '').trim().slice(0, 80),
    from, to,
    /*
     * Prázdná platnost znamená „pořád". Je to ta obvyklá sada, která na
     * stránce visí mezi akcemi — kdyby se musela zadávat data, psalo by se
     * do ní každý rok nové „do".
     */
    fromMs: from ? czMs(from) : 0,
    toMs: to ? czMs(to, true) : Number.MAX_SAFE_INTEGER,
    off: !!value?.off,
    layout: oneOf(value?.layout, ['quad', 'wide'] as const, 'quad'),
    phone: oneOf(value?.phone, ['grid', 'wide'] as const, 'grid'),
    rotate: clamp(value?.rotate, 0, 60, 0),
    banners
  };
}

/* ---------- co dává smysl vystavit ---------- */

export function liveBanners(set: BannerSet): Banner[] {
  return set.banners.filter(one => !one.off
    && (filled(one.copy.title) || filled(one.copy.text) || !!one.look.image));
}

export function validateSet(set: BannerSet): string {
  if (!set.name) return 'Sada nemá jméno — bez něj se v seznamu nepozná.';
  if (set.from && !Number.isFinite(set.fromMs)) return 'Platnost od není platné datum.';
  if (set.to && !Number.isFinite(set.toMs)) return 'Platnost do není platné datum.';
  if (set.from && set.to && !(set.toMs > set.fromMs)) {
    return 'Konec platnosti musí být po jejím začátku.';
  }
  const live = liveBanners(set);
  if (live.length === 0) return 'Sada nemá ani jeden banner s textem nebo fotkou.';
  /*
   * Odpočet a garance doručení stojí na datu. Bez něj by skript nevykreslil
   * nic — odpočet by prostě chyběl a banner by vypadal jako obyčejná
   * dlaždice, takže by se na to přišlo až tím, že akci nikdo nezaznamenal.
   */
  const bad = live.find(one => (one.smart.kind === 'countdown' || one.smart.kind === 'delivery')
    && !(Number.isFinite(one.smart.untilMs) && one.smart.untilMs > 0));
  if (bad) return `Banner „${bad.name || 'beze jména'}" má odpočet bez data, do kdy běží.`;
  return '';
}

/* ---------- překryvy ---------- */

const overlap = (a: BannerSet, b: BannerSet) => a.fromMs <= b.toMs && b.fromMs <= a.toMs;

/**
 * Sady, které se s tou plánovanou perou o tentýž čas.
 *
 * Překryv není chyba — prohlížeč vezme tu, která začala později, protože to
 * je skoro vždycky ta zamýšlená (akce přebíjí běžnou sadu). Je to ale
 * pravidlo, které nikdo nevidí, takže se to ukáže dřív, než se sada uloží.
 */
export function setClashes(set: BannerSet, all: BannerSet[] = listSets()): BannerClash[] {
  return all
    .filter(one => one.id !== set.id && !one.off && overlap(one, set))
    .map(one => ({
      id: one.id,
      name: one.name || 'beze jména',
      from: one.from,
      to: one.to,
      // Zkrátit jde jen tu, která začala dřív, a jen když má vlastní konec
      shortenTo: one.fromMs < set.fromMs && set.from ? shiftMinutes(set.from, -1) : ''
    }));
}

/* ---------- seznam ---------- */

function readSets(): BannerSet[] {
  const raw = getSetting('bannerSets', '')!;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(normalizeSet) : [];
  } catch {
    return [];
  }
}

function writeSets(sets: BannerSet[]): void {
  setSetting('bannerSets', JSON.stringify(sets));
}

export function listSets(): BannerSet[] {
  return readSets().sort((a, b) => a.fromMs - b.fromMs || a.name.localeCompare(b.name, 'cs'));
}

function prune(sets: BannerSet[]): BannerSet[] {
  const limit = Date.now() - KEEP_DAYS * 86_400_000;
  const keep = getSetting('bannerFallback', '')!;
  // Záložní sada se neuklízí, i kdyby dávno doběhla — je zapečená ve skriptu
  return sets.filter(one => one.id === keep || !Number.isFinite(one.toMs) || one.toMs > limit);
}

/* ---------- soubor pro web ---------- */

/** Jeden banner tak, jak ho potřebuje prohlížeč — bez jména a vypnutých věcí. */
export function bannerRow(one: Banner): any {
  const row: any = {
    id: one.id,
    title: one.copy.title,
    text: one.copy.text,
    button: one.copy.button,
    href: one.copy.href,
    look: one.look
  };
  if (one.smart.kind !== 'none' || one.smart.emoji || one.smart.effect !== 'none') {
    row.smart = {
      kind: one.smart.kind,
      untilMs: Number.isFinite(one.smart.untilMs) ? one.smart.untilMs : 0,
      code: one.smart.code,
      emoji: one.smart.emoji,
      effect: one.smart.effect
    };
  }
  return row;
}

export function setRow(set: BannerSet): any {
  return {
    id: set.id,
    fromMs: set.fromMs,
    toMs: set.toMs,
    layout: set.layout,
    phone: set.phone,
    rotate: set.rotate,
    banners: liveBanners(set).map(bannerRow)
  };
}

export function payload(sets: BannerSet[] = listSets()): string {
  const out = sets
    .filter(one => !one.off && liveBanners(one).length > 0)
    .map(setRow);
  return JSON.stringify({ v: 1, updatedAt: new Date().toISOString(), sets: out });
}

/* ---------- vystavení ---------- */

async function createBucket(): Promise<void> {
  const s = webStorage();
  const res = await fetch(`${s.url}/storage/v1/bucket`, {
    method: 'POST',
    headers: { apikey: s.key, Authorization: `Bearer ${s.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: s.bucket, name: s.bucket, public: true })
  });
  if (!res.ok && res.status !== 409) {
    throw new Error(`Kbelík ${s.bucket} nejde založit: ${res.status} ${(await res.text()).slice(0, 160)}`);
  }
}

/** Uloží soubor do kbelíku a vrátí jeho veřejnou adresu. */
async function put(path: string, body: BodyInit, type: string, cache: string): Promise<string> {
  const s = webStorage();
  if (!s.url) throw new Error('Chybí adresa projektu Supabase — nastav ji v Textech na webu.');
  if (!s.key) throw new Error('Chybí servisní klíč (service_role) — bez něj se do úložiště zapsat nedá.');

  const send = () => fetch(objectUrlOf(path), {
    method: 'POST',
    headers: {
      apikey: s.key,
      Authorization: `Bearer ${s.key}`,
      'Content-Type': type,
      'cache-control': cache,
      'x-upsert': 'true'
    },
    body
  });

  let res = await send();
  if (res.status === 400 || res.status === 404) {
    const message = await res.text();
    if (/bucket/i.test(message)) {
      await createBucket();
      res = await send();
    } else {
      throw new Error(`Nahrání se nepovedlo: ${res.status} ${message.slice(0, 200)}`);
    }
  }
  if (!res.ok) throw new Error(`Nahrání se nepovedlo: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return publicUrlOf(path);
}

export async function publish(): Promise<string> {
  await put(bannersPath(), payload(), 'application/json; charset=utf-8', 'max-age=60');
  const at = new Date().toISOString();
  setSetting('bannersPublishedAt', at);
  setSetting('bannersDirty', '0');
  setSetting('bannersError', '');
  return at;
}

/**
 * Nahrání fotky banneru.
 *
 * Fotka se převádí do WebP už v okně (tamtéž, kde se převádějí fotky
 * produktů), sem přijdou hotové bajty. Název se skládá z otisku obsahu:
 * dvakrát nahraná táž fotka skončí na téže adrese a zabere místo jednou,
 * kdežto **upravená fotka dostane novou adresu**, takže se nemusí čekat,
 * až vyprší CDN. Bez toho by se po výměně fotky na webu ještě hodinu
 * ukazovala ta stará a vypadalo by to, že nahrání nefunguje.
 */
export async function uploadImage(name: string, bytes: number[] | Uint8Array): Promise<string> {
  const data = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes ?? []);
  if (data.length === 0) throw new Error('Fotka je prázdná.');
  const stamp = crypto.createHash('sha1').update(Buffer.from(data)).digest('hex').slice(0, 10);
  const base = String(name ?? 'banner')
    .replace(/\.[^.]+$/, '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'banner';
  // Rok na věčnost: adresa se mění s obsahem, takže starou verzi nikdo nedostane
  return put(`bannery/${base}-${stamp}.webp`, Buffer.from(data), 'image/webp', 'max-age=31536000, immutable');
}

/**
 * Stažení vystaveného plánu.
 *
 * Pravda je ve vystaveném souboru, ne v tomhle počítači — na dvou počítačích
 * by se jinak rozešly dvě různé sady a ten, kdo vystavil později, by práci
 * toho druhého smazal. Jména sad a vypnuté bannery jsou ale jen v aplikaci,
 * takže se slučuje podle identifikátoru.
 */
export async function pull(): Promise<string> {
  const url = publicUrlOf(bannersPath());
  if (!url) return 'Chybí adresa úložiště — nastav ji v Textech na webu.';
  if (getSetting('bannersDirty', '0') === '1') {
    return 'V aplikaci je změna, která ještě není na webu — nejdřív ji vystav, pak se natáhne stav z webu.';
  }
  const res = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' as any });
  if (res.status === 404 || res.status === 400) return '';
  if (!res.ok) throw new Error(`Bannery se nepodařilo načíst: ${res.status}`);

  const data = await res.json() as any;
  if (!data || !Array.isArray(data.sets)) return '';

  const known = new Map(readSets().map(one => [one.id, one]));
  const merged: BannerSet[] = data.sets.map((row: any) => {
    const mine = known.get(String(row.id));
    const names = new Map((mine?.banners ?? []).map(one => [one.id, one.name]));
    return normalizeSet({
      ...row,
      name: mine?.name ?? '',
      from: Number(row.fromMs) > 0 ? czLocal(Number(row.fromMs)) : '',
      to: Number(row.toMs) < Number.MAX_SAFE_INTEGER ? czLocal(Number(row.toMs)) : '',
      banners: (row.banners ?? []).map((b: any) => ({
        ...b,
        name: names.get(String(b.id)) ?? '',
        copy: { title: b.title, text: b.text, button: b.button, href: b.href }
      }))
    });
  });
  // Vypnuté sady se nevystavují, ale v aplikaci mají zůstat
  for (const one of known.values()) if (one.off) merged.push(one);
  writeSets(prune(merged));
  return '';
}

/* ---------- překlad ---------- */

/**
 * Doplní slovenštinu a angličtinu do celé sady.
 *
 * Texty jdou na model **jedním dotazem**: nadpis, popisek i tlačítko jednoho
 * banneru spolu souvisí a čtyři nezávislé překlady by v jedné mřížce mluvily
 * čtyřmi tóny.
 *
 * Odkazy překládá mapa adres, ne model. Slovenská verze produktu má vlastní
 * slug, který se z českého slova neuhodne — a uhodnutý odkaz vede na
 * stránku 404, což je horší než banner bez odkazu.
 */
export async function translateSet(value: any): Promise<BannerSet> {
  const set = normalizeSet(value);
  const source: string[] = [];
  const slots: { banner: Banner; field: 'title' | 'text' | 'button' }[] = [];

  for (const one of set.banners) {
    for (const field of ['title', 'text', 'button'] as const) {
      if (one.copy[field].cz) { source.push(one.copy[field].cz); slots.push({ banner: one, field }); }
    }
  }
  if (source.length > 0) {
    const done = await translateWeb(source);
    slots.forEach((slot, i) => {
      slot.banner.copy[slot.field].sk = done[i]?.sk ?? '';
      slot.banner.copy[slot.field].en = done[i]?.en ?? '';
    });
  }

  for (const one of set.banners) {
    const cz = one.copy.href.cz;
    if (!cz) continue;
    try {
      one.copy.href.sk = safeHref(translateUrl(cz, 'cz', 'sk').url) || one.copy.href.sk;
      one.copy.href.en = safeHref(translateUrl(cz, 'cz', 'en').url) || one.copy.href.en;
    } catch {
      /* Odkaz bez překladu zůstane český — banner pořád někam vede */
    }
  }
  return set;
}

/**
 * Odkaz pro jeden banner, hned při psaní.
 *
 * Volá se z okna po vyplnění české adresy, aby bylo vidět, kam to v ostatních
 * trzích povede, ještě než se sada uloží. Vrací i to, **odkud návrh je** —
 * „z přepínače jazyků na té stránce" je jiná jistota než „ze stejné cesty na
 * jiné doméně" a u druhého se vyplatí se podívat.
 */
export function resolveHref(cz: string): { sk: string; en: string; skVia: string; enVia: string } {
  const clean = safeHref(cz);
  if (!clean) return { sk: '', en: '', skVia: 'none', enVia: 'none' };
  const sk = translateUrl(clean, 'cz', 'sk');
  const en = translateUrl(clean, 'cz', 'en');
  return { sk: safeHref(sk.url), en: safeHref(en.url), skVia: sk.via, enVia: en.via };
}

/* ---------- stav pro okno ---------- */

/** Sada zapečená do skriptu. Není-li vybraná, vezme se ta, co platí pořád. */
export function fallbackSet(sets: BannerSet[] = listSets()): BannerSet | null {
  const wanted = getSetting('bannerFallback', '')!;
  const found = sets.find(one => one.id === wanted);
  if (found) return found;
  const always = sets.filter(one => !one.off && liveBanners(one).length > 0 && !one.from && !one.to);
  return always[0] ?? null;
}

function state(error = ''): BannersState {
  const config = webTextsConfig();
  const sets = listSets();
  const fallback = fallbackSet(sets);
  return {
    config,
    sets,
    fallbackId: fallback?.id ?? '',
    publishedAt: getSetting('bannersPublishedAt', '')!,
    dirty: getSetting('bannersDirty', '0') === '1',
    error: error || getSetting('bannersError', '')!,
    script: bannerScript({
      url: publicUrlOf(bannersPath()),
      ttl: ttl(),
      fallback: fallback ? setRow(fallback) : null
    }),
    uploadReady: !!(config.url && config.hasKey)
  };
}

export function bannersState(): BannersState {
  return state();
}

/**
 * Skript pro živý náhled rozepsané sady.
 *
 * Náhled nekreslí vlastní kopie komponent, ale **spouští tentýž skript**,
 * jaký poběží na e-shopu — jen se mu místo adresy plánu podstrčí rozepsaná
 * sada jako záloha. Dvě samostatná vykreslení by se rozešla přesně v tom,
 * kvůli čemu náhled existuje: v tom, jak to nakonec vypadá.
 *
 * Sada projde stejným zpřísněním jako při uložení, takže je v náhledu vidět
 * i to, co se v ní opravilo — třeba dorovnané ztmavení pod textem.
 */
export function previewScript(value: any): string {
  return bannerScript({ url: '', ttl: DEFAULT_TTL, fallback: setRow(normalizeSet(value)) });
}

export async function loadBanners(): Promise<BannersState> {
  let error = '';
  try {
    error = await pull();
  } catch (e: any) {
    error = `Stav z webu se nepodařilo načíst (${String(e?.message ?? e)}). Ukazuje se poslední známá sada.`;
  }
  return state(error);
}

async function publishSafely(): Promise<BannersState> {
  try {
    await publish();
    return state();
  } catch (e: any) {
    const message = String(e?.message ?? e);
    setSetting('bannersError', message);
    return state(message);
  }
}

/**
 * Uložení sady.
 *
 * Ukládá se a hned vystavuje. Kdyby se to rozdělilo, zůstala by v aplikaci
 * sada, o které si člověk myslí, že na webu je — a zjistil by to až tím, že
 * na e-shopu visí něco jiného.
 */
export async function saveSet(value: any): Promise<BannersState> {
  const set = normalizeSet(value);
  const bad = validateSet(set);
  if (bad) throw new Error(bad);

  const sets = readSets().filter(one => one.id !== set.id);
  sets.push(set);
  writeSets(prune(sets));
  setSetting('bannersDirty', '1');

  /*
   * Naplánovaná sada je skoro vždycky akce — a akce patří do událostí
   * v přehledu, protože se s ní pak vysvětluje propad nebo skok v tržbě.
   * Zapisovat datum podruhé ručně by nikdo nedělal. Nečeká se na to:
   * rozhoduje o tom model a uložení banneru kvůli tomu nesmí trvat déle.
   */
  if (set.from) {
    void eventFromWeb({
      source: 'banner',
      id: set.id,
      name: set.name,
      from: set.from,
      to: set.to || set.from,
      summary: setSummary(set)
    }).catch(() => { /* událost je doplněk, ne podmínka */ });
  }

  return publishSafely();
}

/** Co sada zákazníkovi říká — podklad pro událost v přehledu. */
export function setSummary(set: BannerSet): string {
  const parts: string[] = [];
  for (const one of liveBanners(set)) {
    const line = [one.copy.title.cz, one.copy.text.cz].filter(Boolean).join(' — ');
    if (line) parts.push(line);
    if (one.smart.kind === 'code' && one.smart.code) parts.push(`slevový kód ${one.smart.code}`);
    if (one.smart.kind === 'delivery') parts.push('garance doručení do Vánoc');
  }
  return parts.join('\n');
}

export async function deleteSet(id: string): Promise<BannersState> {
  writeSets(readSets().filter(one => one.id !== String(id)));
  if (getSetting('bannerFallback', '') === String(id)) setSetting('bannerFallback', '');
  setSetting('bannersDirty', '1');
  try { dropEventOfSource('banner', String(id)); } catch { /* událost je doplněk */ }
  return publishSafely();
}

export async function toggleSet(id: string, off: boolean): Promise<BannersState> {
  writeSets(readSets().map(one => (one.id === String(id) ? { ...one, off: !!off } : one)));
  setSetting('bannersDirty', '1');
  return publishSafely();
}

/**
 * Výběr záložní sady.
 *
 * Změní se tím skript, který má být v šabloně e-shopu — a ten se tam
 * nedostane sám. Okno proto po přepnutí říká, že se má znovu zkopírovat;
 * kdyby to mlčelo, ležela by v šabloně stará záloha a poznalo by se to až
 * ve chvíli, kdy je úložiště nedostupné.
 */
export function setFallback(id: string): BannersState {
  setSetting('bannerFallback', String(id ?? ''));
  return state();
}

export async function shortenSets(id: string, ids: string[]): Promise<BannersState> {
  const sets = readSets();
  const target = sets.find(one => one.id === String(id));
  if (!target) throw new Error('Sada, kvůli které se má zkracovat, v seznamu není.');
  const wanted = new Set((ids ?? []).map(String));

  writeSets(sets.map(one => {
    if (!wanted.has(one.id) || one.id === target.id || !target.from) return one;
    const to = shiftMinutes(target.from, -1);
    const toMs = czMs(to, true);
    // Kdyby zkrácení nechalo prázdno, sada se vypne — mazat má člověk
    if (!(toMs > one.fromMs)) return { ...one, off: true };
    return { ...one, to, toMs };
  }));
  setSetting('bannersDirty', '1');
  return publishSafely();
}

export function bannerClashes(value: any): BannerClash[] {
  return setClashes(normalizeSet(value));
}

export async function publishBanners(): Promise<BannersState> {
  return publishSafely();
}

export const __test = {
  normalizeSet, normalizeBanner, validateSet, payload, setRow, liveBanners,
  setClashes, safeHref, safeImage, prune, fallbackSet, setSummary
};
