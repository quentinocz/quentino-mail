import { getDb } from '../db';
import { getPtransSettings, targetLangs } from './store';
import { parameterMap } from './seo';
import { plain } from './detect';
import { getField } from './xml';

/**
 * Barva pro Google Nákupy.
 *
 * Na e-shopu je barev přes sto — světle modrá, tmavě modrá, nebeská, denim.
 * Zákazníkovi to dává smysl, Googlu ne: ten filtruje podle hrstky **základních
 * barev** a odstín navíc mu jen rozmělní shodu. Proto se každý odstín převádí
 * na základní barvu a ta se teprve zapisuje do `color_google_merchant`.
 *
 * Převodník se plní ze tří zdrojů:
 *   1. **z feedu** — část produktů základní barvu vyplněnou má a k ní je vidět
 *      i odstín v parametru; z té dvojice se převod přečte, aniž by ho někdo
 *      musel psát,
 *   2. **z předpon** — „světle modrá" je modrá i bez toho, aby to bylo někde
 *      napsané; předpony a přípony se odříznou a zbytek se hledá znovu,
 *   3. **ručně** — co člověk opraví, se zamkne a učení to nepřepíše.
 *
 * Základní barvy musí být v jazyce trhu — Google je čte tak, jak je dostane.
 */

/** Základní paleta. Klíč je bezdiakritický tvar v češtině, hodnoty po jazycích. */
export const BASE_COLORS: { key: string; labels: Record<string, string> }[] = [
  { key: 'cerna', labels: { cz: 'Černá', sk: 'Čierna', en: 'Black', de: 'Schwarz' } },
  { key: 'bila', labels: { cz: 'Bílá', sk: 'Biela', en: 'White', de: 'Weiß' } },
  { key: 'seda', labels: { cz: 'Šedá', sk: 'Sivá', en: 'Grey', de: 'Grau' } },
  { key: 'modra', labels: { cz: 'Modrá', sk: 'Modrá', en: 'Blue', de: 'Blau' } },
  { key: 'zelena', labels: { cz: 'Zelená', sk: 'Zelená', en: 'Green', de: 'Grün' } },
  { key: 'cervena', labels: { cz: 'Červená', sk: 'Červená', en: 'Red', de: 'Rot' } },
  { key: 'ruzova', labels: { cz: 'Růžová', sk: 'Ružová', en: 'Pink', de: 'Rosa' } },
  { key: 'fialova', labels: { cz: 'Fialová', sk: 'Fialová', en: 'Purple', de: 'Lila' } },
  { key: 'zluta', labels: { cz: 'Žlutá', sk: 'Žltá', en: 'Yellow', de: 'Gelb' } },
  { key: 'oranzova', labels: { cz: 'Oranžová', sk: 'Oranžová', en: 'Orange', de: 'Orange' } },
  { key: 'hneda', labels: { cz: 'Hnědá', sk: 'Hnedá', en: 'Brown', de: 'Braun' } },
  { key: 'bezova', labels: { cz: 'Béžová', sk: 'Béžová', en: 'Beige', de: 'Beige' } },
  { key: 'zlata', labels: { cz: 'Zlatá', sk: 'Zlatá', en: 'Gold', de: 'Gold' } },
  { key: 'stribrna', labels: { cz: 'Stříbrná', sk: 'Strieborná', en: 'Silver', de: 'Silber' } },
  { key: 'vicebarevna', labels: { cz: 'Vícebarevná', sk: 'Viacfarebná', en: 'Multicolour', de: 'Mehrfarbig' } }
];

/**
 * Předpony a přípony, které odstín jen zjemňují.
 *
 * Pořadí je podstatné: delší tvary napřed, jinak by „světlounce" zůstalo
 * po odříznutí „světle" jako „unce".
 */
const SHADES = [
  'velmi světle', 'velmi tmavě', 'světlounce', 'tmavounce', 'pastelově', 'smetanově',
  'světle', 'tmavě', 'středně', 'sytě', 'jemně', 'lehce', 'hluboce', 'matně', 'metalicky',
  'light', 'dark', 'pale', 'deep', 'bright', 'pastel', 'svetlo', 'tmavo'
];

/** Odstíny, které se na základní barvu nedají odvodit řezáním — jen slovníkem. */
const SEED: Record<string, string> = {
  smaragdova: 'zelena', smaragdove: 'zelena', olivova: 'zelena', khaki: 'zelena',
  salvejova: 'zelena', mentolova: 'zelena', lahvove: 'zelena', myrta: 'zelena',
  tyrkysova: 'modra', denim: 'modra', nebeska: 'modra', kralovska: 'modra',
  namornicka: 'modra', petrolejova: 'modra', indigo: 'modra', azurova: 'modra',
  bordo: 'cervena', bordova: 'cervena', vinova: 'cervena', cihlova: 'cervena',
  malinova: 'cervena', korálova: 'cervena', koralova: 'cervena',
  staroruzova: 'ruzova', lososova: 'ruzova', pudrova: 'ruzova', fuchsiova: 'ruzova',
  levandulova: 'fialova', svestkova: 'fialova', lila: 'fialova', ametystova: 'fialova',
  hnedozluta: 'hneda', karamelova: 'hneda', cokoladova: 'hneda', koňaková: 'hneda',
  konakova: 'hneda', taupe: 'hneda', skoricova: 'hneda',
  krémová: 'bezova', kremova: 'bezova', pisková: 'bezova', piskova: 'bezova',
  ecru: 'bezova', slonovinova: 'bezova', champagne: 'bezova', sampanska: 'bezova',
  antracitova: 'seda', grafitova: 'seda', stribrnoseda: 'seda',
  hořcicova: 'zluta', horcicova: 'zluta', okrova: 'zluta',
  meděná: 'oranzova', medena: 'oranzova', broskvova: 'oranzova',
  vzorovana: 'vicebarevna', pestra: 'vicebarevna', duhova: 'vicebarevna',
  barevna: 'vicebarevna', barevne: 'vicebarevna', barevny: 'vicebarevna',
  vicebarevne: 'vicebarevna', vicebarevny: 'vicebarevna', mix: 'vicebarevna'
};

export interface ColorRule {
  /** Odstín tak, jak je v parametru (bezdiakritický tvar malými písmeny) */
  source: string;
  /** Klíč základní barvy */
  base: string;
  hits: number;
  origin: 'feed' | 'rule' | 'manual';
  locked: boolean;
}

/** Klíč pro hledání — bez diakritiky, malými písmeny, bez přebytečných mezer. */
export function normalize(value: string): string {
  return plain(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function baseLabel(key: string, lang: string): string {
  const found = BASE_COLORS.find(c => c.key === key);
  if (!found) return '';
  return found.labels[lang] || found.labels.en || found.labels.cz;
}

/* ---------- převodník ---------- */

export function listColorRules(search?: string): ColorRule[] {
  const where = search ? 'WHERE source LIKE ?' : '';
  const params = search ? [`%${normalize(search)}%`] : [];
  return getDb().prepare(
    `SELECT source, base, hits, origin, locked FROM ptrans_colors ${where}
     ORDER BY hits DESC, source LIMIT 500`
  ).all(...params).map((row: any) => ({ ...row, locked: !!row.locked })) as ColorRule[];
}

export function saveColorRule(source: string, base: string, manual = true): void {
  const key = normalize(source);
  if (!key || !BASE_COLORS.some(c => c.key === base)) return;
  getDb().prepare(
    `INSERT INTO ptrans_colors (source, base, hits, origin, locked, updated_at)
     VALUES (?,?,1,?,?,?)
     ON CONFLICT(source) DO UPDATE SET
       base = excluded.base, origin = excluded.origin, locked = excluded.locked,
       updated_at = excluded.updated_at`
  ).run(key, base, manual ? 'manual' : 'feed', manual ? 1 : 0, new Date().toISOString());
}

export function deleteColorRule(source: string): void {
  getDb().prepare('DELETE FROM ptrans_colors WHERE source = ?').run(normalize(source));
}

function lookup(key: string): string | null {
  const row = getDb().prepare('SELECT base FROM ptrans_colors WHERE source = ?').get(key) as any;
  return row?.base ?? null;
}

/**
 * Základní barva pro odstín.
 *
 * Postup je od nejjistějšího k nejméně jistému: přesná shoda v převodníku,
 * pak odříznutí odstiňujících slov, pak jednotlivá slova (u „modro zelená"
 * rozhodne to první), a nakonec zabudovaný slovník. Když nesedí nic, vrací se
 * `null` — prázdný atribut je lepší než špatný.
 */
export function baseColorOf(value: string): string | null {
  const key = normalize(value);
  if (!key) return null;

  const direct = lookup(key) ?? (BASE_COLORS.some(c => c.key === key) ? key : null) ?? SEED[key];
  if (direct) return direct;

  let rest = key;
  for (const shade of SHADES) {
    const cut = normalize(shade);
    if (rest.startsWith(cut + ' ')) rest = rest.slice(cut.length + 1);
  }
  if (rest !== key) {
    const found = lookup(rest) ?? (BASE_COLORS.some(c => c.key === rest) ? rest : null) ?? SEED[rest];
    if (found) return found;
  }

  for (const word of rest.split(' ')) {
    const found = lookup(word) ?? (BASE_COLORS.some(c => c.key === word) ? word : null) ?? SEED[word];
    if (found) return found;
  }

  // Poslední pokus: shoda na kmeni. Čeština mění koncovku podle rodu a čísla
  // („vícebarevná" / „vícebarevné" / „vícebarevný") a psát všechny tvary do
  // převodníku by bylo zbytečné — liší se posledním písmenem.
  for (const word of rest.split(' ')) {
    if (word.length < 5) continue;
    const stem = word.slice(0, -1);
    const match = BASE_COLORS.find(c => c.key.startsWith(stem))
      ?? Object.keys(SEED).find(key => key.startsWith(stem));
    if (typeof match === 'string') return SEED[match];
    if (match) return match.key;
  }
  return null;
}

/* ---------- učení z feedu ---------- */

export interface ColorLearnResult {
  products: number;
  learned: number;
  unknown: string[];
}

/**
 * Přečte převody z produktů, které základní barvu ve feedu vyplněnou mají.
 *
 * Dvojice „parametr Barva → color_google_merchant" je hotový převod, který
 * někdo kdysi udělal ručně. Zamčené záznamy se nepřepisují; co se nepodařilo
 * zařadit, se vrátí jako seznam — ať je v rozhraní vidět, co ještě chybí.
 */
export function learnColors(): ColorLearnResult {
  const d = getDb();
  const s = getPtransSettings();
  const rows = d.prepare('SELECT code, raw_xml FROM ptrans_products').all() as any[];

  const locked = new Set(
    (d.prepare('SELECT source FROM ptrans_colors WHERE locked = 1').all() as any[]).map(r => r.source)
  );
  const seen = new Map<string, Map<string, number>>();
  const unknown = new Set<string>();
  let products = 0;

  for (const row of rows) {
    const shade = parameterMap(row.code, s.sourceLang).barva;
    if (!shade) continue;
    products++;

    const filled = getField(row.raw_xml, s.sourceLang, 'google_color') ?? '';
    const base = filled ? baseFromLabel(filled, s.sourceLang) : null;
    const key = normalize(shade);
    if (!key) continue;

    if (base) {
      const bucket = seen.get(key) ?? new Map<string, number>();
      bucket.set(base, (bucket.get(base) ?? 0) + 1);
      seen.set(key, bucket);
    } else if (!baseColorOf(shade)) {
      unknown.add(shade);
    }
  }

  const insert = d.prepare(
    `INSERT INTO ptrans_colors (source, base, hits, origin, locked, updated_at)
     VALUES (?,?,?,'feed',0,?)
     ON CONFLICT(source) DO UPDATE SET base = excluded.base, hits = excluded.hits,
       origin = 'feed', updated_at = excluded.updated_at`
  );
  const now = new Date().toISOString();
  let learned = 0;

  for (const [key, bucket] of seen) {
    if (locked.has(key)) continue;
    // Když je u jednoho odstínu ve feedu víc základních barev, rozhoduje ta
    // častější — ojedinělý překlep by jinak přebil desítky správných zápisů
    const best = [...bucket.entries()].sort((a, b) => b[1] - a[1])[0];
    if (!best) continue;
    insert.run(key, best[0], best[1], now);
    learned++;
  }

  return { products, learned, unknown: [...unknown].sort().slice(0, 60) };
}

/** Ze zapsaného názvu barvy zpátky na klíč základní barvy. */
function baseFromLabel(label: string, lang: string): string | null {
  const key = normalize(label);
  for (const color of BASE_COLORS) {
    if (normalize(color.labels[lang] ?? '') === key) return color.key;
    if (Object.values(color.labels).some(text => normalize(text) === key)) return color.key;
  }
  return null;
}

/** Barva produktu pro daný jazyk, nebo prázdný řetězec, když se nedá určit. */
export function colorFor(code: string, lang: string): string {
  const s = getPtransSettings();
  const shade = parameterMap(code, s.sourceLang).barva;
  if (!shade) return '';
  const base = baseColorOf(shade);
  return base ? baseLabel(base, lang) : '';
}

/** Přehled do rozhraní: kolik odstínů se umí zařadit a kolik ne. */
export function colorCoverage(): { shades: number; mapped: number; missing: string[] } {
  const d = getDb();
  const s = getPtransSettings();
  const rows = d.prepare('SELECT code FROM ptrans_products WHERE active = 1').all() as any[];
  const shades = new Set<string>();
  const missing = new Set<string>();

  for (const row of rows) {
    const shade = parameterMap(row.code, s.sourceLang).barva;
    if (!shade) continue;
    shades.add(normalize(shade));
    if (!baseColorOf(shade)) missing.add(shade);
  }
  return { shades: shades.size, mapped: shades.size - missing.size, missing: [...missing].sort() };
}

export { targetLangs };
