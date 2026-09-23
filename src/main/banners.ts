import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { getSetting, setSetting } from './db';
import { czMs, czLocal, shiftMinutes, translateWeb, webStorage, webTextsConfig } from './webtexts';
import { translateUrl, alternatesOf, shopOrigins } from './articles/urlmap';
import { uploadArticleFiles, filesReady } from './articles/files';
import { bannerScript } from './bannerscript';
import { stashPreview } from './bannerpreview';
import { eventFromWeb, dropEventOfSource } from './events';
import type {
  Banner, BannerSet, BannerCopy, BannerLook, BannerSmart, BannerClash, BannerLink, BannerRatio, BannerSharedLook,
  BannerLinks, BannersState, WebText
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
  if (/^https?:\/\//i.test(one)) return one;
  /*
   * Ikonka navržená AI jde do plánu rovnou jako `data:` adresa — má pár
   * set bajtů a nemá smysl kvůli ní chodit do správce souborů. Bezpečná
   * je proto, že SVG **skládá aplikace** z ověřených tvarů (bannericon.ts),
   * ne model; base64 navíc nemůže obsahovat uvozovku ani mezeru, takže se
   * z `url(...)` nedá utéct. Strop délky drží plán pro web malý.
   */
  if (/^data:image\/(svg\+xml|png|webp|jpeg|gif);base64,[A-Za-z0-9+/=]{16,8000}$/.test(one)) return one;
  return '';
}

/**
 * Adresa videa na pozadí.
 *
 * Jen http(s) a jen webm/mp4 — do stránky se z toho dělá `<video src>`
 * a cokoli jiného by buď nehrálo, nebo to nebyla adresa videa. Parametry
 * za otazníkem se povolují, e-shop si do adresy přidává svoje.
 */
export function safeVideo(value: any): string {
  const one = String(value ?? '').trim();
  if (/["'()\\\s<>]/.test(one)) return '';
  if (!/^https?:\/\//i.test(one)) return '';
  return /\.(webm|mp4)(\?|#|$)/i.test(one) ? one : '';
}

/** Ikonka z AI, ne fotka — kreslí se doprostřed, ne přes celé kolečko. */
export const jeIkonka = (value: string) => /^data:image\/svg\+xml;/.test(String(value ?? ''));

/** Odkaz. Relativní cesta i celá adresa; nic, co by se dalo spustit. */
export function safeHref(value: any): string {
  const one = String(value ?? '').trim();
  if (!one) return '';
  if (/^https?:\/\//i.test(one)) return one;
  if (one.startsWith('/')) return one;
  return '';
}

/**
 * Z napsaného nechá jen to, co je opravdu emoji.
 *
 * Do políčka se dá napsat cokoli — a písmeno v šedém čtverci na webu
 * vypadá jako chyba vykreslování, ne jako ikonka. Přesně to se stalo:
 * v pruhu odkazů svítilo „N B S B". Zůstávají proto jen obrázkové znaky;
 * spojovník, variantní selektor a odstíny pleti se nechávají, aby se
 * složená emoji nerozpadla.
 */
export function onlyEmoji(value: any, max = 3): string {
  const chars = Array.from(String(value ?? '').trim());
  const keep = chars.filter(one =>
    /\p{Extended_Pictographic}/u.test(one)
    || /[\u200D\uFE0F\u{1F3FB}-\u{1F3FF}]/u.test(one));
  return keep.slice(0, max).join('');
}

/** Tučnost po stovkách — cokoli jiného prohlížeč stejně zaokrouhlí. */
const weight = (value: any, fallback: number) => {
  const n = Math.round(Number(value) / 100) * 100;
  return Number.isFinite(n) && n >= 300 && n <= 900 ? n : fallback;
};

function look(value: any): BannerLook {
  const image = safeImage(value?.image);
  const overlay = clamp(value?.overlay, 0, 90, 40);
  return {
    image,
    video: safeVideo(value?.video),
    // Primární barva e-shopu je černá (`--pr: #000`), tak z ní vychází i dlaždice
    bg: color(value?.bg, '#000000'),
    fg: color(value?.fg, '#ffffff'),
    overlay,
    /*
     * Na střed a doprostřed, protože přesně tak stojí banner na e-shopu
     * (`jc-c ai-c` v jeho šabloně). Dlaždice v mřížce se často hodí spíš
     * dolů a doleva — od toho jsou předlohy, které si to přepíšou.
     */
    align: oneOf(value?.align, ['left', 'center', 'right'] as const, 'center'),
    pos: oneOf(value?.pos, ['top', 'middle', 'bottom'] as const, 'middle'),
    focus: focus(value?.focus),
    /*
     * Výchozí je pokaždé to, co se nejvíc drží e-shopu: jeho písmo a jeho
     * tlačítko. Kdo chce banner odlišit, udělá to vědomě — opačné pořadí
     * by znamenalo, že se od webu odlišují i bannery, u kterých to nikdo
     * nechtěl.
     *
     * Čísla níž nejsou vymyšlená: jsou změřená na quentino.cz (22. 9. 2026).
     * Web je psaný Rajdhani ve váze 300/400/700, nadpisy má ve **400**
     * (ne tučné), prostrkání −0,06 em, tlačítka **hranatá** a černá.
     * Tučný nadpis se zakulacenými rohy by vedle toho byl cizí prvek.
     */
    font: oneOf(value?.font, ['shop', 'inter', 'jost', 'playfair', 'bebas'] as const, 'shop'),
    titleWeight: weight(value?.titleWeight, 400),
    titleSize: clamp(value?.titleSize, 70, 150, 100),
    caps: !!value?.caps,
    textWeight: weight(value?.textWeight, 400),
    button: oneOf(value?.button, ['shop', 'fill', 'outline', 'soft', 'link'] as const, 'shop'),
    radius: clamp(value?.radius, 0, 28, 0)
  };
}

/** Ta část vzhledu, kterou nastavuje sada pro všechny bannery najednou. */
export function sharedLook(value: any): BannerSharedLook {
  const full = look(value);
  return {
    fg: full.fg, overlay: full.overlay, align: full.align, pos: full.pos,
    font: full.font, titleWeight: full.titleWeight, titleSize: full.titleSize,
    caps: full.caps, textWeight: full.textWeight, button: full.button, radius: full.radius
  };
}

/**
 * Výsledný vzhled dlaždice.
 *
 * Banner bez vlastního vzhledu si společnou část bere ze sady; svoje má
 * vždycky jen fotku, barvu pozadí a výřez. Skládá se to **tady**, ne
 * ve skriptu na webu — ten pak dostane hotové hodnoty a nemusí o sdílení
 * vůbec vědět.
 */
export function resolveLook(one: Banner, set: BannerSet): BannerLook {
  if (one.ownLook) return one.look;
  const merged: BannerLook = {
    ...one.look, ...set.look,
    image: one.look.image, video: one.look.video, bg: one.look.bg, focus: one.look.focus
  };
  /*
   * Čitelnost se dorovnává až po sloučení: ztmavení může přijít ze sady,
   * kde o téhle fotce nikdo neví.
   */
  const hasText = filled(one.copy.title) || filled(one.copy.text) || filled(one.copy.kicker);
  if ((merged.image || merged.video) && hasText && merged.overlay < MIN_OVERLAY) {
    merged.overlay = MIN_OVERLAY;
  }
  return merged;
}

function smart(value: any): BannerSmart {
  const until = String(value?.until ?? '').trim();
  return {
    kind: oneOf(value?.kind, ['none', 'countdown', 'code', 'delivery'] as const, 'none'),
    until,
    untilMs: until ? czMs(until, true) : 0,
    // Kód se čte nahlas a přepisuje do košíku: velká písmena a nic exotického
    code: String(value?.code ?? '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 24),
    // Jen pár znaků, a jen skutečná emoji — písmeno v rohu vypadá jako chyba
    emoji: onlyEmoji(value?.emoji, 3),
    effect: oneOf(value?.effect, ['none', 'snow', 'shine', 'pulse', 'float'] as const, 'none'),
    /*
     * Meze jsou tam kvůli stránce, ne kvůli vkusu: dvě stě padajících emoji
     * na čtyřech dlaždicích je dvě stě animovaných prvků na úvodní stránce
     * a na starším telefonu se to pozná na plynulosti rolování.
     */
    fxCount: clamp(value?.fxCount, 3, 40, 14),
    fxSize: clamp(value?.fxSize, 8, 44, 15),
    fxSpeed: clamp(value?.fxSpeed, 2, 24, 8)
  };
}

function copy(value: any): BannerCopy {
  return {
    kicker: text(value?.kicker),
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
    ownLook: !!value?.ownLook,
    copy: copy(value?.copy ?? value),
    look: look(value?.look ?? value),
    smart: smart(value?.smart ?? value)
  };
  /*
   * Čitelnost se vynucuje tady, ne v okně: plán může přijít i z druhého
   * počítače nebo z ručně upraveného souboru a nečitelný nadpis na fotce
   * je chyba, kterou nikdo nenahlásí — jen se z banneru neklikne.
   */
  const hasText = filled(one.copy.title) || filled(one.copy.text) || filled(one.copy.kicker);
  // Video ztmavení potřebuje stejně jako fotka — pod pohyblivým obrazem je text čitelný ještě hůř
  const podklad = !!one.look.image || !!one.look.video;
  if (podklad && hasText && one.look.overlay < MIN_OVERLAY) one.look.overlay = MIN_OVERLAY;
  return one;
}

const RATIOS = ['auto', '1:1', '4:5', '3:4', '2:3', '4:3', '16:9', '2:1', '3:1'] as const;

const ratio = (value: any): BannerRatio => oneOf(value, RATIOS, 'auto');

/** Nejvíc odkazů v pruhu. Víc než osm se na počítači nevejde do řádku. */
const MAX_LINKS = 8;

function link(value: any): BannerLink {
  return {
    id: String(value?.id ?? '') || crypto.randomUUID(),
    image: safeImage(value?.image),
    emoji: onlyEmoji(value?.emoji, 2),
    text: text(value?.text),
    href: {
      cz: safeHref(value?.href?.cz),
      sk: safeHref(value?.href?.sk),
      en: safeHref(value?.href?.en)
    }
  };
}

function links(value: any): BannerLinks {
  return {
    on: !!value?.on,
    shape: oneOf(value?.shape, ['circle', 'square', 'text'] as const, 'circle'),
    items: (Array.isArray(value?.items) ? value.items : []).slice(0, MAX_LINKS).map(link)
  };
}

/** Odkaz bez textu i bez cíle je jen mezera — na web nemá co posílat. */
export function liveLinks(set: BannerSet): BannerLink[] {
  return set.links.on
    ? set.links.items.filter(one => filled(one.text) && (one.href.cz || one.href.sk || one.href.en))
    : [];
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
    look: sharedLook(value?.look),
    ratio: ratio(value?.ratio),
    phoneRatio: ratio(value?.phoneRatio),
    rotate: clamp(value?.rotate, 0, 60, 0),
    banners,
    links: links(value?.links)
  };
}

/* ---------- co dává smysl vystavit ---------- */

export function liveBanners(set: BannerSet): Banner[] {
  return set.banners.filter(one => !one.off
    && (filled(one.copy.title) || filled(one.copy.text) || filled(one.copy.kicker)
      || !!one.look.image || !!one.look.video));
}

export function validateSet(set: BannerSet): string {
  if (!set.name) return 'Sada nemá jméno — bez něj se v seznamu nepozná.';
  if (set.from && !Number.isFinite(set.fromMs)) return 'Platnost od není platné datum.';
  if (set.to && !Number.isFinite(set.toMs)) return 'Platnost do není platné datum.';
  if (set.from && set.to && !(set.toMs > set.fromMs)) {
    return 'Konec platnosti musí být po jejím začátku.';
  }
  const live = liveBanners(set);
  if (live.length === 0 && liveLinks(set).length === 0) {
    return 'Sada nemá ani jeden banner s textem nebo fotkou.';
  }
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
export function bannerRow(one: Banner, set?: BannerSet): any {
  const row: any = {
    id: one.id,
    kicker: one.copy.kicker,
    title: one.copy.title,
    text: one.copy.text,
    button: one.copy.button,
    href: one.copy.href,
    // Na web jde hotový vzhled, ne „vezmi si to ze sady" — skript o sdílení neví
    look: set ? resolveLook(one, set) : one.look
  };
  if (one.smart.kind !== 'none' || one.smart.emoji || one.smart.effect !== 'none') {
    row.smart = {
      kind: one.smart.kind,
      untilMs: Number.isFinite(one.smart.untilMs) ? one.smart.untilMs : 0,
      code: one.smart.code,
      emoji: one.smart.emoji,
      effect: one.smart.effect,
      fxCount: one.smart.fxCount,
      fxSize: one.smart.fxSize,
      fxSpeed: one.smart.fxSpeed
    };
  }
  return row;
}

export function setRow(set: BannerSet): any {
  const row: any = {
    id: set.id,
    fromMs: set.fromMs,
    toMs: set.toMs,
    layout: set.layout,
    phone: set.phone,
    ratio: set.ratio,
    phoneRatio: set.phoneRatio,
    rotate: set.rotate,
    banners: liveBanners(set).map(one => bannerRow(one, set))
  };
  const odkazy = liveLinks(set);
  if (odkazy.length > 0) {
    row.links = {
      shape: set.links.shape,
      items: odkazy.map(one => ({
        id: one.id, image: one.image, emoji: one.emoji, text: one.text, href: one.href
      }))
    };
  }
  return row;
}

export function payload(sets: BannerSet[] = listSets()): string {
  const out = sets
    .filter(one => !one.off && (liveBanners(one).length > 0 || liveLinks(one).length > 0))
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
 * Nahrání fotky banneru — do e-shopu, ne k nám.
 *
 * ## Proč do Upgates a ne do našeho úložiště
 *
 * Fotka banneru je obsah e-shopu. Když leží v jeho správci souborů, je
 * vidět tam, kde ji člověk hledá, jde vyměnit i bez aplikace a jede
 * z téže CDN jako zbytek fotek na stránce — tedy z domény, kterou
 * prohlížeč zákazníka už má navázanou. Naše úložiště by znamenalo druhé
 * místo, kam se musí chodit, a spojení navíc při načítání úvodní stránky.
 *
 * Fotka se převádí do WebP už v okně (tamtéž, kde se převádějí fotky
 * produktů), sem přijdou hotové bajty. Uloží se do dočasného souboru,
 * protože nahrávání do administrace jede přes soubory na disku — je to
 * tatáž cesta, jakou se do e-shopu dostávají přílohy článků.
 *
 * Vrací se **adresa z administrace**, tedy to, co e-shop sám o souboru
 * říká. Složit ji odhadem by znamenalo odkaz, který vypadá správně a
 * nevede nikam.
 */
export async function uploadImage(name: string, bytes: number[] | Uint8Array): Promise<string> {
  const data = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes ?? []);
  if (data.length === 0) throw new Error('Fotka je prázdná.');

  const base = String(name ?? 'banner')
    .replace(/\.[^.]+$/, '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'banner';
  /*
   * Otisk obsahu v názvu. Dvakrát nahraná táž fotka skončí pod týmž
   * jménem, kdežto **upravená fotka dostane nové** — a tím i novou adresu,
   * takže se nečeká, až vyprší CDN. Bez toho by se po výměně fotky na
   * webu ještě hodinu ukazovala ta stará a vypadalo by to, že nahrání
   * nefunguje.
   */
  const stamp = crypto.createHash('sha1').update(Buffer.from(data)).digest('hex').slice(0, 10);
  const dir = path.join(app.getPath('temp'), 'quentino-bannery');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `banner-${base}-${stamp}.webp`);
  fs.writeFileSync(file, Buffer.from(data));

  const [done] = await uploadArticleFiles([file]);
  // Dočasný soubor už není k čemu; adresa je na e-shopu
  try { fs.rmSync(file, { force: true }); } catch { /* uklidí ho systém */ }

  if (!done?.url) {
    throw new Error(done?.note
      || 'Fotka se nahrála, ale adresu se ve správci souborů nepodařilo přečíst.');
  }
  const url = safeImage(done.url);
  if (!url) throw new Error(`Adresa z administrace se nedá použít: ${done.url}`);
  return url;
}

/** Nejvíc, co má smysl pouštět na úvodní stránce jako pozadí banneru. */
const MAX_VIDEO_MB = 12;

/**
 * Video na pozadí banneru.
 *
 * Nahrává se **tak, jak je** — na rozdíl od fotky se nepřevádí. WebP na
 * video nestačí a překódovat webm v aplikaci by znamenalo tahat s sebou
 * ffmpeg kvůli jedné funkci; převod patří do Konvertoru médií, kde už je.
 *
 * Strop velikosti není opatrnost: video na pozadí se stahuje každému
 * návštěvníkovi úvodní stránky, takže deset megabajtů znamená deset
 * megabajtů na každého — a na telefonu v mobilní síti prázdnou dlaždici,
 * než se to stáhne.
 */
export async function uploadVideo(name: string, bytes: number[] | Uint8Array): Promise<string> {
  const data = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes ?? []);
  if (data.length === 0) throw new Error('Video je prázdné.');
  if (data.length > MAX_VIDEO_MB * 1024 * 1024) {
    throw new Error(`Video má ${(data.length / 1024 / 1024).toFixed(1)} MB. `
      + `Na pozadí banneru se vejde do ${MAX_VIDEO_MB} MB — zmenši ho v Konvertoru médií.`);
  }

  const ext = /\.(webm|mp4)$/i.exec(String(name ?? ''))?.[1]?.toLowerCase() ?? '';
  if (!ext) throw new Error('Na pozadí banneru jde webm nebo mp4.');

  const base = String(name ?? 'video')
    .replace(/\.[^.]+$/, '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'video';
  const stamp = crypto.createHash('sha1').update(Buffer.from(data)).digest('hex').slice(0, 10);
  const dir = path.join(app.getPath('temp'), 'quentino-bannery');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `banner-${base}-${stamp}.${ext}`);
  fs.writeFileSync(file, Buffer.from(data));

  const [done] = await uploadArticleFiles([file]);
  try { fs.rmSync(file, { force: true }); } catch { /* uklidí ho systém */ }

  if (!done?.url) {
    throw new Error(done?.note
      || 'Video se nahrálo, ale adresu se ve správci souborů nepodařilo přečíst.');
  }
  const url = safeVideo(done.url);
  if (!url) throw new Error(`Adresa z administrace se nedá použít: ${done.url}`);
  return url;
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
        copy: { kicker: b.kicker, title: b.title, text: b.text, button: b.button, href: b.href }
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
  const slots: { banner: Banner; field: 'kicker' | 'title' | 'text' | 'button' }[] = [];

  for (const one of set.banners) {
    for (const field of ['kicker', 'title', 'text', 'button'] as const) {
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

  /* Texty odkazů pod bannerem jdou stejným dotazem — je to jedna stránka */
  if (set.links.items.length > 0) {
    const zdroj = set.links.items.map(one => one.text.cz);
    if (zdroj.some(Boolean)) {
      const hotovo = await translateWeb(zdroj);
      set.links.items.forEach((one, i) => {
        if (!one.text.cz) return;
        one.text.sk = hotovo[i]?.sk ?? '';
        one.text.en = hotovo[i]?.en ?? '';
      });
    }
    for (const one of set.links.items) {
      if (!one.href.cz) continue;
      try {
        const [sk, en] = await Promise.all([findHref(one.href.cz, 'sk'), findHref(one.href.cz, 'en')]);
        if (sk.url) one.href.sk = sk.url;
        if (en.url) one.href.en = en.url;
      } catch { /* odkaz bez překladu zůstane český */ }
    }
  }

  for (const one of set.banners) {
    const cz = one.copy.href.cz;
    if (!cz) continue;
    try {
      const [sk, en] = await Promise.all([findHref(cz, 'sk'), findHref(cz, 'en')]);
      // Nenalezený odkaz nepřepisuje ten, co už tam je — ručně zadaný je víc
      if (sk.url) one.copy.href.sk = sk.url;
      if (en.url) one.copy.href.en = en.url;
    } catch {
      /* Odkaz bez překladu zůstane český — banner pořád někam vede */
    }
  }
  return set;
}

/** Z „/kravaty" celá česká adresa — bez ní není co se ptát. */
function czAbsolute(href: string): string {
  const clean = safeHref(href);
  if (!clean) return '';
  if (/^https?:\/\//i.test(clean)) return clean;
  const home = shopOrigins().find(one => one.lang === 'cz')?.origin ?? '';
  return home ? home + clean : '';
}

/**
 * Existuje ta stránka vůbec?
 *
 * Používá se jen na **dohad** — na adresu složenou výměnou domény. Bez
 * tohohle se do banneru dostal odkaz, který vypadal správně a vedl na
 * stránku 404: „/kravaty" se prostě přilepilo na wearquentino.com, kde se
 * ta stránka jmenuje jinak. Raději žádný odkaz než odkaz do prázdna.
 */
async function stranka(url: string, timeoutMs = 9000): Promise<boolean> {
  if (!/^https?:\/\//i.test(url)) return false;
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'follow', signal: stop.signal });
    return res.ok;
  } catch {
    /*
     * Bez sítě se dohad nezahazuje. Nefunkční síť není důkaz, že stránka
     * neexistuje, a smazat kvůli výpadku rozepsaný odkaz by bylo horší
     * než ho nechat a označit jako dohad.
     */
    return true;
  } finally {
    clearTimeout(timer);
  }
}

export interface FoundHref { url: string; via: string }

/**
 * Kam český odkaz vede v jiném trhu.
 *
 * ## Proč se to chodí zeptat webu
 *
 * Trhy jsou tři samostatné e-shopy a **slug se v nich liší**: z „/kravaty"
 * je na anglickém webu „/neckties". Dřív se adresa skládala výměnou domény,
 * takže z toho vylezlo „wearquentino.com/kravaty" — odkaz, který vypadá
 * správně, tváří se jako dohledaný a vede na stránku 404. Přesně to bylo
 * na bannerech vidět.
 *
 * Pořadí je proto takové, aby se **nejdřív hledalo a až pak hádalo**:
 *
 *  1. **přepínač jazyků na té stránce** — e-shop sám říká, co je jeho
 *     protějšek; jistější zdroj neexistuje a rovnou se to zapamatuje,
 *  2. naučená mapa adres (z článků a z dřívějších dotazů),
 *  3. dohad výměnou domény — a ten se **ověří stažením**. Když stránka
 *     není, vrátí se prázdno, ne rozbitý odkaz.
 */
export async function findHref(cz: string, toLang: string): Promise<FoundHref> {
  const absolute = czAbsolute(cz);
  if (!absolute) return { url: '', via: 'none' };

  // 1) Zeptat se stránky. Naplní to i mapu, takže podruhé se nikam nechodí.
  try {
    const found = await alternatesOf(absolute);
    const target = safeHref(found[toLang] ?? '');
    if (target) return { url: target, via: 'page' };
  } catch {
    /* Bez sítě se pokračuje mapou a dohadem */
  }

  // 2) a 3) mapa, nebo dohad — a dohad se ověří
  const guess = translateUrl(absolute, 'cz', toLang);
  const url = safeHref(guess.url);
  if (!url) return { url: '', via: 'none' };
  if (guess.via === 'domain' && !(await stranka(url))) return { url: '', via: 'none' };
  return { url, via: guess.via };
}

/**
 * Odkaz pro jeden banner, hned při psaní.
 *
 * Volá se z okna po vyplnění české adresy, aby bylo vidět, kam to v ostatních
 * trzích povede, ještě než se sada uloží. Vrací i to, **odkud návrh je** —
 * „z přepínače jazyků na té stránce" je jiná jistota než „ze stejné cesty na
 * jiné doméně" a u druhého se vyplatí se podívat.
 */
export async function resolveHref(cz: string):
  Promise<{ sk: string; en: string; skVia: string; enVia: string }> {
  const clean = safeHref(cz);
  if (!clean) return { sk: '', en: '', skVia: 'none', enVia: 'none' };
  const [sk, en] = await Promise.all([findHref(clean, 'sk'), findHref(clean, 'en')]);
  return { sk: sk.url, en: en.url, skVia: sk.via, enVia: en.via };
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
    /*
     * Fotky jdou do správce souborů e-shopu, ne do našeho úložiště —
     * připravenost se proto ptá na administraci, ne na klíč k Supabase.
     * A **ne na naučenou adresu**: ta je jen pojistka, cesta se skládá
     * z adresy administrace a nahrávání jde i bez ní.
     */
    uploadReady: filesReady()
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

/**
 * Celá stránka náhledu, i s tím, co kolem bannerů má e-shop.
 *
 * Je v ní schválně i prázdný `#banner1`: skript hledá místo původního
 * karuselu a schovává ho, takže kdyby v náhledu nebylo, zkoušelo by se
 * něco jiného než na webu a nepoznalo by se, že vodítko přestalo platit.
 *
 * Písmo a tlačítko „jako e-shop" si banner nenastavuje a dědí je ze
 * stránky — rámeček náhledu ale stránku e-shopu nemá, takže se tu doplní
 * to, co e-shop doopravdy má: Rajdhani a třídy `btn fg bg-pr` (změřeno na
 * quentino.cz 22. 9. 2026: nadpisy ve váze 400, tlačítka černá a hranatá,
 * odsazení 16/32).
 *
 * Vrací **adresu**, ne HTML: kód vložený přímo ve stránce okno aplikace
 * spustit nesmí (`script-src 'self'` platí i pro rámeček přes `srcdoc`)
 * a náhled by zůstal prázdný. Viz `bannerpreview.ts`.
 */
export function previewUrl(value: any, lang = 'cz'): string {
  const script = previewScript(value);
  const safeLang = ['cz', 'sk', 'en'].includes(String(lang)) ? String(lang) : 'cz';
  const html = [
    '<!doctype html><html lang="cs"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css?family=',
    'Rajdhani%3A300%2C400%2C700&display=swap&subset=latin%2Clatin-ext">',
    '<style>',
    'html,body{margin:0;background:#fff;color:#000;font-family:Rajdhani,sans-serif}',
    /*
     * Na střed schválně. Kontejner šablony e-shopu má „text-align: center"
     * a banner nastavený doleva se kvůli tomu na webu kreslil na střed,
     * zatímco v náhledu byl vlevo — náhled tu dědičnost neměl čím
     * napodobit, a tak se o chybě nedozvěděl.
     */
    '.qbn-ukazka{padding:0 16px;text-align:center}',
    '.qbn-jako{height:64px;display:flex;align-items:center;justify-content:center;',
    'border-bottom:1px solid #e6e6e9;color:#9b9ba3;font-size:12px;letter-spacing:.08em;',
    'text-transform:uppercase}',
    '#banner1{margin:18px 0;padding:26px;border:1px dashed #d4d4d8;',
    'color:#9b9ba3;font-size:13px;text-align:center}',
    '.btn{display:inline-flex;align-items:center;padding:12px 21px;border:0;border-radius:0;',
    'font-size:16px;font-weight:400;letter-spacing:-.02em;line-height:1.2;color:#000}',
    '.btn.bg-pr{background:#000}.btn.fg{color:#fff}',
    '.btn.pt-3{padding-top:16px}.btn.pb-3{padding-bottom:16px}',
    '.btn.pr-5{padding-right:32px}.btn.pl-5{padding-left:32px}',
    '.btn.fs-4{font-size:18px}',
    '</style>',
    `<script>window.__quentinoLang=${JSON.stringify(safeLang)}</script>`,
    script,
    '</head><body>',
    '<div class="qbn-jako">hlavička e-shopu</div>',
        /*
     * Fotka uvnitř původního karuselu je tu schválně: na ní se pozná, že
     * skript zahodil i to, co se k banneru stahovalo. Adresa nikam nevede.
     */
    '<div class="qbn-ukazka"><div id="banner1">původní karusel Upgates',
    '<img alt="" src="https://cdn.invalid/stary-banner.jpg" width="1" height="1"></div>',
    '<div class="qbn-jako" style="border:0;border-top:1px solid #e6e6e9">další obsah stránky</div>',
    '</div>',
    /*
     * Výšku hlásí stránka sama. Hádat ji zvenčí nejde: mění se s počtem
     * bannerů, se zalomením textu i s tím, jestli se odpočet vejde na
     * jeden řádek — a špatný odhad by udělal v okně pruh prázdna.
     */
    '<script>(function(){function s(){try{parent.postMessage(',
    '{qbn:document.documentElement.scrollHeight},"*")}catch(e){}}',
    'if(window.ResizeObserver)new ResizeObserver(s).observe(document.documentElement);',
    'setTimeout(s,60);setTimeout(s,450);setTimeout(s,1200);})()</script>',
    '</body></html>'
  ].join('');
  return stashPreview(html);
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
    const line = [one.copy.kicker.cz, one.copy.title.cz, one.copy.text.cz]
      .filter(Boolean).join(' — ');
    if (line) parts.push(line);
    if (one.smart.kind === 'code' && one.smart.code) parts.push(`slevový kód ${one.smart.code}`);
    if (one.smart.kind === 'delivery') parts.push('garance doručení do Vánoc');
  }
  return parts.join('\n');
}

/**
 * Kopie celé sady.
 *
 * Nejčastější způsob, jak vzniká nová kampaň, je „jako ta minulá, ale
 * jiné texty". Překlikat kvůli tomu dvanáct políček u čtyř dlaždic nikdo
 * nebude — a kdo to zkusí, na jednu z nich zapomene.
 *
 * Kopie se zakládá **vypnutá**. Sada, která platí pořád, se jinak hned
 * začne prát s originálem o tentýž čas a na webu by se objevila dřív,
 * než se v ní stihne cokoli přepsat.
 */
export async function copySet(id: string): Promise<BannersState> {
  const source = readSets().find(one => one.id === String(id));
  if (!source) throw new Error('Sada, která se má zkopírovat, v seznamu není.');

  const copy = normalizeSet({
    ...source,
    id: crypto.randomUUID(),
    name: `${source.name} (kopie)`.slice(0, 80),
    off: true,
    // Nové identifikátory: jinak by si dvě sady nárokovaly tytéž dlaždice
    banners: source.banners.map(one => ({ ...one, id: crypto.randomUUID() })),
    links: { ...source.links, items: source.links.items.map(one => ({ ...one, id: crypto.randomUUID() })) }
  });

  writeSets(prune([...readSets(), copy]));
  setSetting('bannersDirty', '1');
  // Vypnutá sada se na web nevystavuje, ale stav se má srovnat hned
  return publishSafely();
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
  setClashes, safeHref, safeImage, prune, fallbackSet, setSummary, liveLinks,
  sharedLook, resolveLook, onlyEmoji
};
