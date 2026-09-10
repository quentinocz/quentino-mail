import crypto from 'crypto';
import { getSetting, setSetting } from './db';
import { encrypt, decrypt } from './secure';
import { headScript } from './webscript';
import type {
  WebText, WebPlan, WebProductArea, WebBarArea, WebLinksArea, WebButtonArea,
  WebTextsConfig, WebTextsState, WebClash
} from '../shared/types';

/**
 * Naplánované náhrady textů na e-shopu.
 *
 * ## Co se řeší
 *
 * Skript v hlavičce e-shopu si texty o doručení počítá sám — podle dne
 * v týdnu, hodiny, svátků a Vánoc. Devětkrát z deseti to stačí. Zbývá
 * desátý případ: dovolená, výpadek dopravce, akce na pár dní. Do šablony
 * e-shopu se sáhnout nedá, takže jediné místo, kde se to dá změnit, je
 * ten skript — a přepisovat ho pokaždé znamená vydat novou verzi webu.
 *
 * ## Jak je to udělané a proč zrovna takhle
 *
 * Aplikace vystaví **celý plán**, tedy i okna, která začnou příští týden.
 * Každé okno má počátek a konec v milisekundách. Prohlížeč si sám vybere,
 * co zrovna platí. Z toho plynou dvě věci, které byly zadané:
 *
 *  - **Aplikace nemusí běžet**, když má náhrada začít nebo skončit. Rozhodne
 *    prohlížeč nad plánem, který mohl být vydaný před týdnem.
 *  - **Nezatěžuje se úložiště.** Plán se stáhne jednou za pět minut a leží
 *    v prohlížeči; kdo si prohlédne deset produktů, stáhne ho jednou.
 *
 * Plán je **obyčejný soubor JSON ve veřejném kbelíku Supabase Storage**, ne
 * tabulka. Čte se přes CDN, takže se tím nebudí databáze a není co
 * zabezpečovat pravidly přístupu — v souboru je jen to, co stejně bude
 * vidět na webu. Zapisuje do něj jedině aplikace, servisním klíčem, který
 * zůstává zašifrovaný v počítači.
 *
 * ## Kde je pravda
 *
 * **Ve vystaveném souboru.** Aplikace si drží kopii, aby šlo plán prohlížet
 * i bez sítě, ale při otevření modulu se ptá úložiště. Jinak by se na dvou
 * počítačích rozešly dva různé plány a jeden by druhý přepsal.
 */

const DEFAULT_BUCKET = 'web';
const DEFAULT_PATH = 'quentino-texty.json';
const DEFAULT_TTL = 300;
/** Změny, které skončily před víc než dvěma měsíci, se samy uklidí. */
const KEEP_DAYS = 60;

const TZ = 'Europe/Prague';

/* ---------- čas ---------- */

/**
 * Posun pražského času proti UTC v daném okamžiku.
 *
 * Napevno napsat +1 nebo +2 nejde: mezi březnem a říjnem platí letní čas
 * a plán se dělá i přes ten přechod. Zjišťuje se proto z kalendáře — co
 * ukazují hodiny v Praze v ten konkrétní okamžik.
 */
function offsetAt(ms: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(new Date(ms));
  const o: Record<string, string> = {};
  for (const p of parts) if (p.type !== 'literal') o[p.type] = p.value;
  const hour = Number(o.hour) === 24 ? 0 : Number(o.hour);
  const asUtc = Date.UTC(Number(o.year), Number(o.month) - 1, Number(o.day), hour, Number(o.minute), Number(o.second));
  return asUtc - ms;
}

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/;

/**
 * Z pražského času na hodinách udělá okamžik.
 *
 * Počítá se nadvakrát: první odhad může spadnout do jiného pásma než
 * výsledek (přesně v noci, kdy se čas přehazuje), druhé kolo to srovná.
 */
export function czMs(local: string, endOfMinute = false): number {
  const m = LOCAL.exec(String(local || '').trim());
  if (!m) return NaN;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  let ms = guess - offsetAt(guess);
  ms = guess - offsetAt(ms);
  return endOfMinute ? ms + 59_999 : ms;
}

/** Zpátky: z okamžiku pražský čas na hodinách, „2026-09-20T08:00". */
export function czLocal(ms: number): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date(ms));
  const o: Record<string, string> = {};
  for (const p of parts) if (p.type !== 'literal') o[p.type] = p.value;
  const hour = String(Number(o.hour) === 24 ? 0 : Number(o.hour)).padStart(2, '0');
  return `${o.year}-${o.month}-${o.day}T${hour}:${o.minute}`;
}

/** Posun o minuty v pražském čase — počítá se přes okamžik, ne po znacích. */
export function shiftMinutes(local: string, minutes: number): string {
  const ms = czMs(local);
  return Number.isFinite(ms) ? czLocal(ms + minutes * 60_000) : local;
}

/* ---------- nastavení ---------- */

interface Secrets { url: string; key: string; bucket: string; path: string; ttl: number }

function secrets(): Secrets {
  const raw = getSetting('webTextsKey', '')!;
  let key = '';
  if (raw) { try { key = decrypt(raw); } catch { key = ''; } }
  return {
    // Bez vlastní adresy se použije projekt chatu — bývá to tentýž
    url: (getSetting('webTextsUrl', '')! || getSetting('chatSupabaseUrl', '')! || '').replace(/\/+$/, ''),
    key,
    bucket: getSetting('webTextsBucket', DEFAULT_BUCKET)! || DEFAULT_BUCKET,
    path: getSetting('webTextsPath', DEFAULT_PATH)! || DEFAULT_PATH,
    ttl: Number(getSetting('webTextsTtl', String(DEFAULT_TTL))) || DEFAULT_TTL
  };
}

function publicUrl(s: Secrets): string {
  const own = (getSetting('webTextsPublicUrl', '')! || '').trim();
  if (own) return own;
  if (!s.url) return '';
  const path = s.path.split('/').map(encodeURIComponent).join('/');
  return `${s.url}/storage/v1/object/public/${encodeURIComponent(s.bucket)}/${path}`;
}

export function webTextsConfig(): WebTextsConfig {
  const s = secrets();
  return {
    url: s.url,
    hasKey: !!s.key,
    bucket: s.bucket,
    path: s.path,
    publicUrl: publicUrl(s),
    ttl: s.ttl,
    ready: !!(s.url && s.key)
  };
}

export function saveWebTextsConfig(next: Partial<WebTextsConfig> & { key?: string }): WebTextsConfig {
  if (next.url !== undefined) setSetting('webTextsUrl', next.url.trim().replace(/\/+$/, ''));
  if (next.key !== undefined) setSetting('webTextsKey', next.key.trim() ? encrypt(next.key.trim()) : '');
  if (next.bucket !== undefined) setSetting('webTextsBucket', next.bucket.trim() || DEFAULT_BUCKET);
  if (next.path !== undefined) setSetting('webTextsPath', next.path.trim().replace(/^\/+/, '') || DEFAULT_PATH);
  if (next.publicUrl !== undefined) setSetting('webTextsPublicUrl', next.publicUrl.trim());
  if (next.ttl !== undefined) {
    /*
     * Pět vteřin je na zkoušení, ne na provoz: při něm si prohlížeč sáhne
     * pro plán po každé druhé stránce. V provozu patří pět minut a víc —
     * začátku ani konce naplánované změny se to stejně netýká, ty si
     * prohlížeč spočítá i z hodinu staré kopie.
     */
    const ttl = Math.max(5, Math.min(3600, Math.round(next.ttl) || DEFAULT_TTL));
    setSetting('webTextsTtl', String(ttl));
  }
  return webTextsConfig();
}

/* ---------- tvar změny ---------- */

function text(value: any): WebText {
  if (typeof value === 'string') return { cz: value, sk: '', en: '' };
  return {
    cz: String(value?.cz ?? '').trim(),
    sk: String(value?.sk ?? '').trim(),
    en: String(value?.en ?? '').trim()
  };
}

const filled = (t: WebText) => !!(t.cz || t.sk || t.en);

function product(value: any): WebProductArea {
  return {
    on: !!value?.on,
    one: text(value?.one), above: text(value?.above),
    header: text(value?.header), hideHeader: !!value?.hideHeader,
    ship: text(value?.ship), delivery: text(value?.delivery), pickup: text(value?.pickup),
    hideShip: !!value?.hideShip, hideDelivery: !!value?.hideDelivery, hidePickup: !!value?.hidePickup,
    below: text(value?.below)
  };
}

function bar(value: any): WebBarArea {
  return { on: !!value?.on, text: text(value?.text) };
}

function links(value: any): WebLinksArea {
  const mode = value?.mode === 'replace' || value?.mode === 'off' ? value.mode : 'add';
  const items = Array.isArray(value?.items) ? value.items : [];
  return {
    on: !!value?.on,
    mode,
    items: items.slice(0, 8).map((one: any) => ({
      text: text(one?.text), href: text(one?.href), blank: !!one?.blank
    }))
  };
}

/** Doplní chybějící části a spočítá časy — ať přijde plán odkudkoli. */
export function normalize(value: any): WebPlan {
  const from = String(value?.from ?? '').trim();
  const to = String(value?.to ?? '').trim();
  return {
    id: String(value?.id ?? '') || crypto.randomUUID(),
    name: String(value?.name ?? '').trim(),
    from, to,
    fromMs: czMs(from),
    // Konec je včetně své minuty: „do 18:00" znamená, že v 18:00 to ještě platí
    toMs: czMs(to, true),
    off: !!value?.off,
    product: product(value?.product),
    topbar: bar(value?.topbar),
    links: links(value?.links),
    button: bar(value?.button) as WebButtonArea
  };
}

/** Nastavuje ta změna vůbec něco? Prázdná změna by na webu nebyla poznat. */
export function hasContent(plan: WebPlan): boolean {
  const p = plan.product;
  const productSet = p.on && (filled(p.one) || filled(p.above) || filled(p.header) || p.hideHeader
    || filled(p.ship) || filled(p.delivery) || filled(p.pickup)
    || p.hideShip || p.hideDelivery || p.hidePickup || filled(p.below));
  const linksSet = plan.links.on
    && (plan.links.mode === 'off' || plan.links.items.some(one => filled(one.text)));
  return !!(productSet || (plan.topbar.on && filled(plan.topbar.text)) || linksSet
    || (plan.button.on && filled(plan.button.text)));
}

export function validate(plan: WebPlan): string {
  if (!LOCAL.test(plan.from)) return 'Chybí platnost od.';
  if (!LOCAL.test(plan.to)) return 'Chybí platnost do.';
  if (!(plan.toMs > plan.fromMs)) return 'Konec platnosti musí být po jejím začátku.';
  if (!hasContent(plan)) return 'Změna nic nenastavuje — vyplň aspoň jeden text.';
  return '';
}

/* ---------- překryvy ---------- */

const overlap = (a: WebPlan, b: WebPlan) => a.fromMs <= b.toMs && b.fromMs <= a.toMs;

/**
 * Změny, které se s tou plánovanou perou o tentýž čas.
 *
 * Překryv sám o sobě není chyba — prohlížeč si vybere tu, která začala
 * později. Jenže to je pravidlo, které nikdo nevidí, a výsledek pak
 * překvapí. Proto se to ukáže dřív, než se změna uloží, a u těch, které
 * začínají dřív, se rovnou nabídne zkrácení konce.
 */
export function clashes(plan: WebPlan, all: WebPlan[] = listPlans()): WebClash[] {
  return all
    .filter(one => one.id !== plan.id && !one.off && overlap(one, plan))
    .map(one => ({
      id: one.id,
      name: one.name || 'beze jména',
      from: one.from,
      to: one.to,
      // Zkrátit jde jen tu, která začala dřív — u pozdější by konec nepomohl
      shortenTo: one.fromMs < plan.fromMs ? shiftMinutes(plan.from, -1) : ''
    }));
}

/* ---------- seznam ---------- */

function readPlans(): WebPlan[] {
  const raw = getSetting('webTextsPlans', '')!;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(normalize) : [];
  } catch {
    return [];
  }
}

function writePlans(plans: WebPlan[]): void {
  setSetting('webTextsPlans', JSON.stringify(plans));
}

export function listPlans(): WebPlan[] {
  return readPlans().sort((a, b) => a.fromMs - b.fromMs || a.name.localeCompare(b.name, 'cs'));
}

/** Změny, které skončily před dávnem, se v seznamu jen pletou. */
function prune(plans: WebPlan[]): WebPlan[] {
  const limit = Date.now() - KEEP_DAYS * 86_400_000;
  return plans.filter(one => !Number.isFinite(one.toMs) || one.toMs > limit);
}

/* ---------- soubor pro web ---------- */

/**
 * Co se posílá na web.
 *
 * Jen to, co prohlížeč potřebuje: časy a vyplněné oblasti. Název změny ani
 * vypnuté oblasti tam nemají co dělat — soubor je veřejný a čím je menší,
 * tím rychleji se stáhne.
 */
export function payload(plans: WebPlan[] = listPlans()): string {
  const out = plans
    .filter(one => !one.off && hasContent(one) && Number.isFinite(one.fromMs) && Number.isFinite(one.toMs))
    .map(one => {
      const row: any = { id: one.id, fromMs: one.fromMs, toMs: one.toMs };
      if (one.product.on) row.product = { ...one.product };
      if (one.topbar.on && filled(one.topbar.text)) row.topbar = { on: true, text: one.topbar.text };
      if (one.links.on) row.links = { on: true, mode: one.links.mode, items: one.links.items };
      if (one.button.on && filled(one.button.text)) row.button = { on: true, text: one.button.text };
      return row;
    });
  return JSON.stringify({ v: 1, updatedAt: new Date().toISOString(), plans: out });
}

function objectUrl(s: Secrets): string {
  const path = s.path.split('/').map(encodeURIComponent).join('/');
  return `${s.url}/storage/v1/object/${encodeURIComponent(s.bucket)}/${path}`;
}

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
 * Vystavení plánu.
 *
 * Kbelík se v případě potřeby založí sám — jinak by se muselo začínat
 * klikáním v Supabase a první publikování by skončilo hláškou „Bucket not
 * found", které nikdo nerozumí.
 */
export async function publish(): Promise<string> {
  const s = secrets();
  if (!s.url) throw new Error('Chybí adresa projektu Supabase.');
  if (!s.key) throw new Error('Chybí servisní klíč (service_role) — bez něj se do úložiště zapsat nedá.');

  const body = payload();
  const send = () => fetch(objectUrl(s), {
    method: 'POST',
    headers: {
      apikey: s.key,
      Authorization: `Bearer ${s.key}`,
      'Content-Type': 'application/json; charset=utf-8',
      // Prohlížeč si plán stejně drží v paměti; CDN ho může držet minutu
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
      throw new Error(`Plán se nepodařilo vystavit: ${res.status} ${text.slice(0, 200)}`);
    }
  }
  if (!res.ok) {
    throw new Error(`Plán se nepodařilo vystavit: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }

  const at = new Date().toISOString();
  setSetting('webTextsPublishedAt', at);
  setSetting('webTextsDirty', '0');
  setSetting('webTextsError', '');
  return at;
}

/**
 * Stažení vystaveného plánu.
 *
 * Pravda je na webu, ne v tomhle počítači — jinak by dva počítače měly
 * každý svůj plán a ten, kdo publikoval později, by tomu druhému změny
 * smazal. Rozdělaná změna (ještě nevystavená) má přednost, aby se
 * o rozepsanou práci nepřišlo.
 */
export async function pull(): Promise<string> {
  const s = secrets();
  const url = publicUrl(s);
  if (!url) return 'Chybí adresa plánu.';
  if (getSetting('webTextsDirty', '0') === '1') {
    return 'V aplikaci je změna, která ještě není na webu — nejdřív ji vystav, pak se natáhne stav z webu.';
  }
  const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`, { cache: 'no-store' as any });
  // Soubor ještě není — první publikování ho založí, není to chyba
  if (res.status === 404 || res.status === 400) return '';
  if (!res.ok) throw new Error(`Plán se nepodařilo načíst: ${res.status}`);

  const data = await res.json() as any;
  if (!data || !Array.isArray(data.plans)) return '';

  /*
   * Ve vystaveném souboru nejsou názvy změn ani vypnuté oblasti — jsou
   * jen v aplikaci. Slučuje se proto podle identifikátoru: co se pozná,
   * si název ponechá.
   */
  const known = new Map(readPlans().map(one => [one.id, one]));
  const merged = data.plans.map((row: any) => {
    const mine = known.get(String(row.id));
    const plan = normalize({
      id: row.id,
      name: mine?.name ?? '',
      from: czLocal(Number(row.fromMs)),
      to: czLocal(Number(row.toMs)),
      product: row.product ? { ...row.product, on: true } : undefined,
      topbar: row.topbar,
      links: row.links,
      button: row.button
    });
    return plan;
  });
  // Vypnuté změny se nevystavují, ale v aplikaci mají zůstat
  for (const one of known.values()) if (one.off) merged.push(one);
  writePlans(prune(merged));
  return '';
}

/* ---------- co dělá rozhraní ---------- */

function state(error = ''): WebTextsState {
  const config = webTextsConfig();
  return {
    config,
    plans: listPlans(),
    publishedAt: getSetting('webTextsPublishedAt', '')!,
    dirty: getSetting('webTextsDirty', '0') === '1',
    error: error || getSetting('webTextsError', '')!,
    script: headScript({ url: config.publicUrl, ttl: config.ttl })
  };
}

export function webTextsState(): WebTextsState {
  return state();
}

/** Otevření modulu: podívat se, co je vystavené, a teprve pak to ukázat. */
export async function loadWebTexts(): Promise<WebTextsState> {
  let error = '';
  try {
    error = await pull();
  } catch (e: any) {
    error = `Stav z webu se nepodařilo načíst (${String(e?.message ?? e)}). Ukazuje se poslední známý plán.`;
  }
  return state(error);
}

/**
 * Uložení změny.
 *
 * Ukládá se a hned vystavuje — kdyby se to rozdělilo, zůstala by v aplikaci
 * změna, o které si člověk myslí, že platí, a na webu by nebyla. Když
 * vystavení selže, změna se uloží stejně a modul to řekne nahlas.
 */
export async function saveWebPlan(value: any): Promise<WebTextsState> {
  const plan = normalize(value);
  const bad = validate(plan);
  if (bad) throw new Error(bad);

  const plans = readPlans().filter(one => one.id !== plan.id);
  plans.push(plan);
  writePlans(prune(plans));
  setSetting('webTextsDirty', '1');

  return publishSafely();
}

export async function deleteWebPlan(id: string): Promise<WebTextsState> {
  writePlans(readPlans().filter(one => one.id !== String(id)));
  setSetting('webTextsDirty', '1');
  return publishSafely();
}

/** Vypnutí bez mazání — na dovolenou, která se nakonec nekonala. */
export async function toggleWebPlan(id: string, off: boolean): Promise<WebTextsState> {
  writePlans(readPlans().map(one => (one.id === String(id) ? { ...one, off: !!off } : one)));
  setSetting('webTextsDirty', '1');
  return publishSafely();
}

/**
 * Zkrácení dřívějších změn tak, aby skončily minutu před tou novou.
 *
 * Kdyby zkrácení nechalo okno prázdné (nová změna začíná dřív než ta stará),
 * změna se vypne — smazat ji je rozhodnutí, které má udělat člověk.
 */
export async function shortenWebPlans(id: string, ids: string[]): Promise<WebTextsState> {
  const plans = readPlans();
  const target = plans.find(one => one.id === String(id));
  if (!target) throw new Error('Změna, kvůli které se má zkracovat, v seznamu není.');
  const wanted = new Set((ids ?? []).map(String));

  writePlans(plans.map(one => {
    if (!wanted.has(one.id) || one.id === target.id) return one;
    const to = shiftMinutes(target.from, -1);
    const toMs = czMs(to, true);
    if (!(toMs > one.fromMs)) return { ...one, off: true };
    return { ...one, to, toMs };
  }));
  setSetting('webTextsDirty', '1');
  return publishSafely();
}

export function webClashes(value: any): WebClash[] {
  return clashes(normalize(value));
}

async function publishSafely(): Promise<WebTextsState> {
  try {
    await publish();
    return state();
  } catch (e: any) {
    const message = String(e?.message ?? e);
    setSetting('webTextsError', message);
    return state(message);
  }
}

/** Ruční pokus znovu — po opravě klíče nebo když byla síť pryč. */
export async function publishWebTexts(): Promise<WebTextsState> {
  return publishSafely();
}

export const __test = {
  normalize, validate, clashes, payload, hasContent, czMs, czLocal, shiftMinutes, prune
};
