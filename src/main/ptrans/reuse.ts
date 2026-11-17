import crypto from 'crypto';
import { getDb, getSetting, setSetting } from '../db';
import { HTML_FIELDS } from './xml';
import { tidyHtml } from './html';
import { plain, detectLanguage, hashText } from './detect';

/**
 * Opakované texty — co už jednou přeložené je, se znovu neplatí.
 *
 * Většina produktů v e-shopu má sourozence: stejná kravata v deseti barvách,
 * stejné kšandy ve třech vzorech. Popisy se mezi nimi liší větou o barvě,
 * zbytek je do písmene stejný — materiál, šíře, péče, „ručně šito v Česku".
 * Překladač ale dřív každý z nich posílal modelu celý, takže se za tytéž
 * odstavce platilo desetkrát a desetkrát se na ně čekalo. Výstup modelu je
 * přitom to, co je na překladu nejdražší i nejpomalejší.
 *
 * Proto se pamatuje **každý přeložený odstavec**, ne jen celý text:
 *
 *  - **celý text známe** (sourozenec se stejným popisem, parametr „100 %
 *    hedvábí"): přeloží se bez modelu, okamžitě a zadarmo,
 *  - **známe většinu**: odstavce, které už přeložené máme, dostane model
 *    jako značky `⟦1⟧`, `⟦2⟧` a přeloží jen to, čím se produkt liší. Hotové
 *    odstavce se do jeho odpovědi dosadí zpátky,
 *  - **neznáme skoro nic**: jde to celé, jako dřív.
 *
 * Vedlejší zisk je jednotnost: stejná věta je u všech sourozenců přeložená
 * stejně, ne pokaždé trochu jinak podle nálady modelu.
 *
 * Odstavec = nejmenší blok HTML (`<p>`, `<li>`, `<td>`, nadpis), uvnitř
 * kterého už žádný další blok není. U textů bez HTML (název, parametr,
 * SEO popis) je odstavcem celý text.
 */

const BLOCKS = 'p|li|h[1-6]|td|th|dt|dd|figcaption|blockquote';
/** Co uvnitř odstavce být nesmí — jinak by to nebyl nejmenší blok. */
const NESTED = `${BLOCKS}|ul|ol|table|thead|tbody|tfoot|tr|div|section|article`;
const LEAF = new RegExp(
  `(<(${BLOCKS})\\b[^>]*>)((?:(?!<\\/?(?:${NESTED})\\b)[\\s\\S])*?)(<\\/\\2\\s*>)`,
  'gi'
);

/** Značka pro hotový odstavec. Znaky, které se v popisu produktu nevyskytnou. */
const SLOT = (n: number) => `⟦${n}⟧`;
const ANY_SLOT = /⟦\d+⟧/g;

export interface Piece {
  /** Text mimo odstavce: značky, mezery, výjimečně volný text */
  raw?: string;
  /** Vnitřek odstavce tak, jak je */
  inner?: string;
}

/**
 * Rozloží text na odstavce a to, co je mezi nimi.
 *
 * Text bez HTML odstavců (název, parametr, holý popis) je jeden kus.
 */
export function pieces(text: string): Piece[] {
  const out: Piece[] = [];
  if (!text.includes('<')) return [{ inner: text }];
  let at = 0;
  for (const found of text.matchAll(LEAF)) {
    const start = found.index ?? 0;
    const open = found[1];
    const inner = found[3];
    if (start > at) out.push({ raw: text.slice(at, start) });
    out.push({ raw: open });
    out.push({ inner });
    out.push({ raw: found[4] });
    at = start + found[0].length;
  }
  if (at === 0) return [{ inner: text }];
  if (at < text.length) out.push({ raw: text.slice(at) });
  return out;
}

/** Klíč odstavce — na mezerách nezáleží, na značkách uvnitř ano. */
export function normalize(inner: string): string {
  return inner.replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Kde se odstavec hledá.
 *
 * Odstavce popisů jsou společné všem popisům (věta o materiálu stojí stejně
 * v krátkém i dlouhém). Celé texty jen v rámci svého pole: SEO titulek je
 * zkrácený na sedmdesát znaků, a kdyby se jeho překlad dosadil do názvu
 * se stejným zněním, uřízl by ho.
 */
function scopeOf(field: string, text: string): string {
  return HTML_FIELDS.has(field) && pieces(text).length > 1 ? 'blok' : field;
}

function key(lang: string, scope: string, inner: string): string {
  return crypto.createHash('sha1').update(`${lang}\u0000${scope}\u0000${normalize(inner)}`).digest('hex');
}

/** Je ve volném textu mezi odstavci něco ke čtení (ne jen značky a mezery)? */
function hasWords(raw: string): boolean {
  return /\p{L}/u.test(raw.replace(/<[^>]*>/g, ''));
}

/** Kostra značek bez atributů — `alt` a `title` se překládají, jména značek ne. */
function skeleton(list: Piece[]): string {
  return list
    .filter(piece => piece.raw !== undefined)
    .map(piece => (piece.raw!.match(/<\/?[a-zA-Z][a-zA-Z0-9]*/g) ?? []).join('').toLowerCase())
    .join('|');
}

/* ---------- učení ---------- */

/**
 * Zapamatuje si dvojici zdroj → překlad, odstavec po odstavci.
 *
 * Páruje se jen tam, kde obě strany mají **stejnou stavbu** — stejný počet
 * odstavců a stejné značky. Když model odstavce spojil nebo rozdělil, nedá
 * se poznat, co patří k čemu, a dvojice by učila nesmysl; pak se radši
 * neučí nic.
 *
 * Ruční úprava má přednost: co člověk opravil, překladač nepřepíše.
 */
export function learn(lang: string, field: string, source: string, target: string, manual = false): number {
  const src = clean(field, source);
  const tgt = clean(field, target);
  if (!src.trim() || !tgt.trim()) return 0;
  const a = pieces(src);
  const b = pieces(tgt);
  const segA = a.filter(piece => piece.inner !== undefined);
  const segB = b.filter(piece => piece.inner !== undefined);
  if (segA.length !== segB.length || skeleton(a) !== skeleton(b)) return 0;
  const scope = scopeOf(field, src);

  const write = getDb().prepare(`
    INSERT INTO ptrans_segments (lang, skey, scope, source, target, hits, manual, updated_at)
    VALUES (@lang, @skey, @scope, @source, @target, 1, @manual, @at)
    ON CONFLICT(lang, skey) DO UPDATE SET
      target = CASE WHEN ptrans_segments.manual = 1 AND excluded.manual = 0
        THEN ptrans_segments.target ELSE excluded.target END,
      manual = max(ptrans_segments.manual, excluded.manual),
      hits = ptrans_segments.hits + 1,
      updated_at = excluded.updated_at
  `);
  const at = new Date().toISOString();
  let n = 0;
  for (let i = 0; i < segA.length; i++) {
    const from = normalize(segA[i].inner!);
    const to = normalize(segB[i].inner!);
    if (!plain(from) || !plain(to)) continue;
    // Značky z rozpracovaného překladu se učit nesmí
    if (ANY_SLOT.test(to) || ANY_SLOT.test(from)) { ANY_SLOT.lastIndex = 0; continue; }
    ANY_SLOT.lastIndex = 0;
    /*
     * Pojistka proti posunutým dvojicím: překlad bývá o něco delší nebo
     * kratší, ne trojnásobný. Delší věta beze změny je nepřeložená, ne
     * přeložená — slovenské „Kravata" je ale „Kravata" právem.
     */
    const ratio = plain(to).length / Math.max(1, plain(from).length);
    if (ratio < 0.33 || ratio > 3) continue;
    if (from === to && plain(from).length > 24) continue;
    write.run({ lang, skey: key(lang, scope, from), scope, source: from, target: to, manual: manual ? 1 : 0, at });
    n++;
  }
  return n;
}

/** Text tak, jak ho vidí model — uklizený, ať klíče sedí na obou stranách. */
function clean(field: string, text: string): string {
  return HTML_FIELDS.has(field) ? tidyHtml(text ?? '') : (text ?? '');
}

/**
 * Prvotní naplnění z toho, co už přeložené je.
 *
 * Jen dvě spolehlivé skupiny: překlady, které udělala aplikace a zdroj se od
 * té doby nezměnil, a ruční úpravy. Překlady, které ve feedu byly odjakživa,
 * se berou jen tehdy, když v nich rozpoznávání jazyka **s jistotou** najde
 * cílový jazyk — z feedu, kde stojí čeština místo slovenštiny, by se paměť
 * naučila „překládat" češtinu do češtiny.
 */
const LEARNED_VERSION = '1';

export function learnFromStore(langs: string[], sourceLang: string): number {
  const marker = `${LEARNED_VERSION}:${[...langs].sort().join(',')}`;
  if (getSetting('ptransSegmentsLearned', '') === marker) return 0;
  const rows = getDb().prepare(
    `SELECT lang, field, source_value, value, translated, translated_hash, manual, state FROM ptrans_fields
     WHERE lang IN (${langs.map(() => '?').join(',')}) AND state IN ('ok', 'manual')
       AND trim(source_value) != ''`
  ).all(...langs) as any[];
  let n = 0;
  const run = getDb().transaction(() => {
    for (const row of rows) {
      const manual = row.manual === 1;
      const ours = !!row.translated && row.translated_hash === hashText(row.source_value);
      let target = '';
      if (manual || ours) target = row.translated ?? row.value;
      else if (plain(row.value) !== plain(row.source_value)
        && detectLanguage(row.value, [sourceLang, row.lang]) === row.lang) target = row.value;
      if (!target) continue;
      n += learn(row.lang, row.field, row.source_value, target, manual);
    }
  });
  run();
  setSetting('ptransSegmentsLearned', marker);
  return n;
}

/* ---------- použití ---------- */

export interface Reuse {
  /** Celý text je známý — překlad bez modelu */
  full?: string;
  /** Známá část nahrazená značkami; model přeloží zbytek */
  masked?: string;
  /** Značka → hotový překlad odstavce */
  slots?: Map<string, string>;
  /** Kolik znaků textu je už přeložených (na hlášku a rozhodování) */
  knownChars: number;
  totalChars: number;
}

/**
 * Kdy má smysl posílat modelu text se značkami.
 *
 * Značka v textu stojí trochu souvislosti; u jedné krátké věty v dlouhém
 * popisu se to nevyplatí. Pod třetinu známého textu jde text modelu celý.
 */
const MASK_FROM = 0.3;

/**
 * Co z textu už přeložené je.
 *
 * `start` je číslo první značky — v jednom dotazu jich může být víc polí
 * a značky se nesmějí opakovat.
 */
export function lookup(lang: string, field: string, source: string, start = 1): Reuse | null {
  const text = clean(field, source);
  if (!text.trim()) return null;
  const list = pieces(text);
  const scope = scopeOf(field, text);
  const read = getDb().prepare('SELECT source, target FROM ptrans_segments WHERE lang = ? AND skey = ?');

  let knownChars = 0;
  let totalChars = 0;
  const found: (string | null)[] = list.map(piece => {
    if (piece.inner === undefined) return null;
    const norm = normalize(piece.inner);
    const size = plain(norm).length;
    totalChars += size;
    if (!size) return null;
    const row = read.get(lang, key(lang, scope, norm)) as { source: string; target: string } | undefined;
    // Otisk může v teorii kolidovat — rozhoduje shoda textu, ne otisku
    if (!row || row.source !== norm) return null;
    knownChars += size;
    return row.target;
  });
  if (knownChars === 0) return null;

  const loose = list.some(piece => piece.raw !== undefined && hasWords(piece.raw));
  const unknown = list.some((piece, i) => piece.inner !== undefined && plain(normalize(piece.inner)) && found[i] === null);
  if (!unknown && !loose) {
    const full = list.map((piece, i) => (piece.inner !== undefined ? (found[i] ?? piece.inner) : piece.raw)).join('');
    return { full, knownChars, totalChars };
  }
  if (knownChars / Math.max(1, totalChars) < MASK_FROM) return null;

  const slots = new Map<string, string>();
  let n = start;
  const masked = list.map((piece, i) => {
    if (piece.inner === undefined) return piece.raw;
    if (found[i] === null) return piece.inner;
    const slot = SLOT(n++);
    slots.set(slot, found[i]!);
    return slot;
  }).join('');
  return { masked, slots, knownChars, totalChars };
}

/**
 * Dosadí hotové odstavce zpátky do odpovědi modelu.
 *
 * Každá značka musí v odpovědi být **právě jednou** a žádná cizí navíc.
 * Když model značku vynechal, zdvojil nebo si vymyslel, nedá se poznat, kde
 * odstavec chybí — vrací se `null` a pole se přeloží znovu, celé a bez
 * značek.
 */
export function unmask(value: string, slots: Map<string, string>): string | null {
  const seen = value.match(ANY_SLOT) ?? [];
  if (seen.length !== slots.size) return null;
  for (const slot of slots.keys()) {
    if (seen.filter(one => one === slot).length !== 1) return null;
  }
  return value.replace(ANY_SLOT, slot => slots.get(slot) ?? slot);
}

/** Vysvětlivka pro model: co značky znamenají. */
export function slotHint(all: { lang?: string; slots: Map<string, string> }[]): string {
  const lines: string[] = [];
  for (const one of all) {
    for (const [slot, text] of one.slots) {
      const short = plain(text);
      lines.push(`${slot}${one.lang ? ` (${one.lang})` : ''} = ${short.length > 220 ? short.slice(0, 217) + '…' : short}`);
    }
  }
  if (!lines.length) return '';
  return [
    '',
    'Značky ⟦1⟧, ⟦2⟧… jsou odstavce, které už přeložené máme. Nech každou značku přesně tak,',
    'jak je, na stejném místě, a její obsah nepiš. Přelož jen zbytek. Pro souvislost znamenají:',
    ...lines
  ].join('\n');
}

/** Kolik odstavců paměť zná — do přehledu v nastavení. */
export function segmentStats(): { lang: string; segments: number }[] {
  return getDb().prepare('SELECT lang, COUNT(*) AS segments FROM ptrans_segments GROUP BY lang ORDER BY lang')
    .all() as { lang: string; segments: number }[];
}

export const __test = { pieces, normalize, skeleton, key, LEAF };
