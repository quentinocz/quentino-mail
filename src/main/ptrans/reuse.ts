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
 * Pamatuje se po odstavcích **i po větách**. Odstavec, ve kterém se mění
 * jen věta o barvě, by se jako celek nenašel nikdy; jeho ostatní věty ano.
 *
 * Co se **nepřekládá strojově**, je věta, která se od známé liší jedním
 * slovem („v červené barvě" × „v zelené barvě"). Vyměnit slovo by bylo
 * rychlé, ale skloňování a shoda v cílovém jazyce by nebyly zaručené —
 * a kvalita má přednost. Taková věta jde modelu, jen s hotovým překladem
 * podobné věty jako vzorem: model změní, co se liší, a zbytek nechá ve
 * stejném znění. Odpověď je krátká, takže je to rychlé, a sourozenci zní
 * stejně.
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

/* ---------- věty ---------- */

export interface Sentence {
  text: string;
  /** Mezera za větou (do další), u poslední prázdné */
  sep: string;
}

const VOID_TAG = /^<(br|img|hr|wbr)\b/i;

/**
 * Rozdělí vnitřek odstavce na věty.
 *
 * Dělí se jen za `.`, `!`, `?` nebo `…`, po kterých přijde mezera a velké
 * písmeno či číslice — „7 cm. Vhodné…" se rozdělí, „např. modrá" ne. A jen
 * mimo značky: věta, která by začala uvnitř `<strong>` a skončila za ním,
 * by se nedala vrátit zpátky bez rozbitého HTML. Kde to nejde čistě, zůstane
 * odstavec jednou větou.
 */
export function sentences(inner: string): Sentence[] {
  const out: Sentence[] = [];
  let start = 0;
  let depth = 0;
  let i = 0;
  while (i < inner.length) {
    const ch = inner[i];
    if (ch === '<') {
      const end = inner.indexOf('>', i);
      if (end < 0) return [{ text: inner, sep: '' }];
      const tag = inner.slice(i, end + 1);
      if (tag.startsWith('</')) depth--;
      else if (!tag.endsWith('/>') && !VOID_TAG.test(tag)) depth++;
      i = end + 1;
      continue;
    }
    if (/[.!?…]/.test(ch) && depth === 0) {
      let j = i + 1;
      while (j < inner.length && /[.!?…"“”'’)»]/.test(inner[j])) j++;
      const gap = /^(?:\s|&nbsp;)+/.exec(inner.slice(j));
      if (gap && /^(?:<[^>]+>)*["„“'(«]?[\p{Lu}\d]/u.test(inner.slice(j + gap[0].length))) {
        out.push({ text: inner.slice(start, j), sep: gap[0] });
        start = j + gap[0].length;
        i = start;
        continue;
      }
      i = j;
      continue;
    }
    i++;
  }
  if (depth !== 0) return [{ text: inner, sep: '' }];
  out.push({ text: inner.slice(start), sep: '' });
  return out.filter(one => one.text.trim() || one.sep);
}

/* ---------- podobné věty ---------- */

/** Slova a to mezi nimi. Liché pozice jsou slova. */
function tokens(text: string): string[] {
  return normalize(text).split(/(\p{L}[\p{L}\p{M}'’-]*)/u);
}

/**
 * Dva klíče pro hledání podobné věty — začátek a konec.
 *
 * Věta, která se od známé liší jedním místem („bordó" × „tmavě modrá"),
 * má buď stejný začátek, nebo stejný konec, a většinou obojí. Klíčem jsou
 * první dvě a poslední dvě slova i s tím, co je mezi nimi. Dřív to byly
 * dvě poloviny věty se stejným počtem slov — jenže barva „tmavě modrá"
 * má o slovo víc než „bordó" a taková věta se nenašla nikdy.
 */
const EDGE_WORDS = 2;

function edges(lang: string, scope: string, text: string): [string, string] {
  const list = tokens(text);
  const take = EDGE_WORDS * 2;           // slova jsou na lichých pozicích
  const hash = (side: number, part: string[]) => crypto.createHash('sha1')
    .update(`${lang}\u0000${scope}\u0000${side}\u0000${part.join('').toLowerCase()}`).digest('hex');
  return [hash(1, list.slice(0, take)), hash(2, list.slice(Math.max(0, list.length - take - 1)))];
}

/**
 * Čím se dvě věty liší: jedno souvislé místo uprostřed, zbytek do písmene
 * stejný. Vrací počet odlišných slov (na kratší straně ≥ 1), nebo `null`,
 * když se liší víc než jedním místem, víc než třemi slovy, interpunkcí,
 * čísly — nebo když je společného textu míň než polovina.
 */
function wordDiff(a: string, b: string): number | null {
  const x = tokens(a);
  const y = tokens(b);
  let head = 0;
  while (head < x.length && head < y.length && x[head] === y[head]) head++;
  let tail = 0;
  while (tail < x.length - head && tail < y.length - head
    && x[x.length - 1 - tail] === y[y.length - 1 - tail]) tail++;
  const midX = x.slice(head, x.length - tail);
  const midY = y.slice(head, y.length - tail);
  const words = (list: string[]) => list.filter(part => /\p{L}/u.test(part) && !/[^\p{L}\p{M}'’-]/u.test(part)).length;
  const wx = words(midX);
  const wy = words(midY);
  if (wx === 0 && wy === 0) return midX.join('') === midY.join('') ? 0 : null;
  // Místo, kde se věty liší, smí obsahovat jen slova a mezery mezi nimi
  const onlyWords = (list: string[]) => list.every(part => /^[\p{L}\p{M}'’-]*$/u.test(part) || /^\s+$/u.test(part));
  if (!onlyWords(midX) || !onlyWords(midY)) return null;
  if (wx > 3 || wy > 3) return null;
  const all = Math.max(words(x), words(y));
  const same = all - Math.max(wx, wy);
  if (same < 2 || same * 2 < all) return null;
  return Math.max(wx, wy);
}

export interface Near {
  /** Neznámá věta */
  source: string;
  /** Podobná, už přeložená věta a její překlad */
  like: string;
  target: string;
}

/** Nejbližší přeložená věta, která se liší jedním místem o nejvýš třech slovech. */
function nearest(lang: string, scope: string, text: string): Near | null {
  const keys = edges(lang, scope, text);
  const rows = getDb().prepare(
    `SELECT s.source, s.target, s.hits FROM ptrans_seg_index i
     JOIN ptrans_segments s ON s.lang = i.lang AND s.skey = i.skey
     WHERE i.lang = ? AND i.scope = ? AND i.ntok = 0 AND i.hkey IN (?, ?) LIMIT 200`
  ).all(lang, scope, keys[0], keys[1]) as { source: string; target: string; hits: number }[];
  let best: { row: (typeof rows)[number]; diff: number } | null = null;
  const norm = normalize(text);
  for (const row of rows) {
    if (row.source === norm) continue;
    const diff = wordDiff(norm, row.source);
    if (diff === null || diff === 0) continue;
    if (!best || diff < best.diff || (diff === best.diff && row.hits > best.row.hits)) best = { row, diff };
  }
  return best ? { source: norm, like: best.row.source, target: best.row.target } : null;
}

/* ---------- učení ---------- */

/**
 * Zapamatuje si dvojici zdroj → překlad: odstavce a v nich věty.
 *
 * Páruje se jen tam, kde obě strany mají **stejnou stavbu** — stejný počet
 * odstavců a stejné značky, u vět stejný počet vět. Když model odstavce
 * nebo věty spojil či rozdělil, nedá se poznat, co patří k čemu, a dvojice
 * by učila nesmysl; pak se radši neučí nic.
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
  const html = scope === 'blok';

  const d = getDb();
  const write = d.prepare(`
    INSERT INTO ptrans_segments (lang, skey, scope, source, target, hits, manual, updated_at)
    VALUES (@lang, @skey, @scope, @source, @target, 1, @manual, @at)
    ON CONFLICT(lang, skey) DO UPDATE SET
      target = CASE WHEN ptrans_segments.manual = 1 AND excluded.manual = 0
        THEN ptrans_segments.target ELSE excluded.target END,
      manual = max(ptrans_segments.manual, excluded.manual),
      hits = ptrans_segments.hits + 1,
      updated_at = excluded.updated_at
  `);
  // OR REPLACE: rejstřík z dřívější verze (poloviny věty) se tím přepíše
  const index = d.prepare(`INSERT OR REPLACE INTO ptrans_seg_index (lang, skey, half, scope, ntok, hkey)
    VALUES (?, ?, ?, ?, 0, ?)`);
  const at = new Date().toISOString();
  let n = 0;
  const one = (scopeHere: string, from: string, to: string, near: boolean): boolean => {
    if (!plain(from) || !plain(to)) return false;
    // Značky z rozpracovaného překladu se učit nesmí
    if (/⟦\d+⟧/.test(to) || /⟦\d+⟧/.test(from)) return false;
    /*
     * Pojistka proti posunutým dvojicím: překlad bývá o něco delší nebo
     * kratší, ne trojnásobný. Delší věta beze změny je nepřeložená, ne
     * přeložená — slovenské „Kravata" je ale „Kravata" právem.
     */
    const ratio = plain(to).length / Math.max(1, plain(from).length);
    if (ratio < 0.33 || ratio > 3) return false;
    if (from === to && plain(from).length > 24) return false;
    const skey = key(lang, scopeHere, from);
    write.run({ lang, skey, scope: scopeHere, source: from, target: to, manual: manual ? 1 : 0, at });
    if (near) {
      const keys = edges(lang, scopeHere, from);
      index.run(lang, skey, 1, scopeHere, keys[0]);
      index.run(lang, skey, 2, scopeHere, keys[1]);
    }
    return true;
  };
  for (let i = 0; i < segA.length; i++) {
    const from = normalize(segA[i].inner!);
    const to = normalize(segB[i].inner!);
    if (!one(scope, from, to, !html)) continue;
    n++;
    if (!html) continue;
    // Věty uvnitř odstavce — jen když se jich na obou stranách sešlo stejně
    const sa = sentences(from);
    const sb = sentences(to);
    if (sa.length !== sb.length) continue;
    for (let k = 0; k < sa.length; k++) one('veta', normalize(sa[k].text), normalize(sb[k].text), true);
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
 *
 * Verze 2 přidala věty a rejstřík podobných vět, verze 3 rejstřík podle
 * začátku a konce věty; po změně se projde znovu všechno.
 *
 * Projde se znovu i **po každém stažení feedu**. Dřív se paměť naplnila
 * jednou a dost: co někdo přeložil v e-shopu potom, se do ní nedostalo
 * nikdy. Projít celý katalog trvá pod vteřinu, takže to nestojí za šetření.
 * `force` = projít hned (tlačítko v záložce Paměť).
 */
const LEARNED_VERSION = '3';

export function learnFromStore(langs: string[], sourceLang: string, force = false): number {
  const marker = `${LEARNED_VERSION}:${[...langs].sort().join(',')}:${getSetting('ptransSyncedAt', '')}`;
  if (!force && getSetting('ptransSegmentsLearned', '') === marker) return 0;
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

/**
 * Co z textu přišlo z paměti — kvůli zvýraznění v náhledu.
 *
 * `b` je pořadí odstavce (nejmenšího bloku) v poli, `s` text, který z paměti
 * přišel (celý odstavec nebo jedna věta), bez značek. Rozhraní ho podle toho
 * v náhledu najde a podbarví; pole bez HTML má jediný „odstavec" 0.
 */
export interface Mark { b: number; s: string }

export interface Reuse {
  /** Celý text je známý — překlad bez modelu */
  full?: string;
  /** Známá část nahrazená značkami; model přeloží zbytek */
  masked?: string;
  /** Značka → hotový překlad odstavce nebo věty */
  slots?: Map<string, string>;
  /** Značka → který odstavec (na zvýraznění) */
  slotBlock?: Map<string, number>;
  /** U celého textu: co je z paměti */
  marks?: Mark[];
  /** Podobné věty s hotovým překladem — vzor pro model */
  near: Near[];
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

/** Kolik vzorů podobných vět nanejvýš do jednoho pole — víc už jen zdržuje. */
const NEAR_MAX = 8;

type Part = { kind: 'raw'; text: string }
  | { kind: 'known'; text: string; target: string; block: number }
  | { kind: 'open'; text: string; block: number };

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
  const html = scope === 'blok';
  const read = getDb().prepare('SELECT source, target FROM ptrans_segments WHERE lang = ? AND skey = ?');
  const known = (scopeHere: string, piece: string): string | null => {
    const norm = normalize(piece);
    const row = read.get(lang, key(lang, scopeHere, norm)) as { source: string; target: string } | undefined;
    // Otisk může v teorii kolidovat — rozhoduje shoda textu, ne otisku
    return row && row.source === norm ? row.target : null;
  };

  let knownChars = 0;
  let totalChars = 0;
  const parts: Part[] = [];
  const near: Near[] = [];
  let block = -1;
  for (const piece of list) {
    if (piece.inner === undefined) { parts.push({ kind: 'raw', text: piece.raw! }); continue; }
    block++;
    const size = plain(normalize(piece.inner)).length;
    totalChars += size;
    if (!size) { parts.push({ kind: 'raw', text: piece.inner }); continue; }
    const whole = known(scope, piece.inner);
    if (whole !== null) {
      knownChars += size;
      parts.push({ kind: 'known', text: piece.inner, target: whole, block });
      continue;
    }
    if (!html) {
      // Pole bez HTML (název, SEO popis): jen vzor podobného textu
      const like = safeNear(lang, scope, piece.inner);
      if (like) near.push(like);
      parts.push({ kind: 'open', text: piece.inner, block });
      continue;
    }
    // Odstavec jako celek neznáme — po větách
    for (const one of sentences(piece.inner)) {
      const hit = known('veta', one.text);
      const len = plain(normalize(one.text)).length;
      if (hit !== null && len) {
        knownChars += len;
        parts.push({ kind: 'known', text: one.text, target: hit, block });
      } else {
        if (len && near.length < NEAR_MAX) {
          const like = safeNear(lang, 'veta', one.text);
          if (like) near.push(like);
        }
        parts.push({ kind: 'open', text: one.text, block });
      }
      if (one.sep) parts.push({ kind: 'raw', text: one.sep });
    }
  }
  if (knownChars === 0) return near.length ? { near, knownChars, totalChars } : null;

  const loose = list.some(piece => piece.raw !== undefined && hasWords(piece.raw));
  const open = parts.some(part => part.kind === 'open' && plain(part.text));
  if (!open && !loose) {
    const full = parts.map(part => (part.kind === 'known' ? part.target : part.text)).join('');
    const marks = parts.filter(part => part.kind === 'known')
      .map(part => ({ b: (part as any).block as number, s: plain((part as any).target) }));
    return { full, marks, near, knownChars, totalChars };
  }
  if (knownChars / Math.max(1, totalChars) < MASK_FROM) return near.length ? { near, knownChars, totalChars } : null;

  const slots = new Map<string, string>();
  const slotBlock = new Map<string, number>();
  let n = start;
  const masked = parts.map(part => {
    if (part.kind !== 'known') return part.text;
    const slot = SLOT(n++);
    slots.set(slot, part.target);
    slotBlock.set(slot, part.block);
    return slot;
  }).join('');
  return { masked, slots, slotBlock, near, knownChars, totalChars };
}

/** Hledání podobné věty je vzor navíc — jeho chyba nesmí zastavit překlad. */
function safeNear(lang: string, scope: string, text: string): Near | null {
  try { return nearest(lang, scope, text); } catch { return null; }
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

/** Co bylo z paměti v textu poskládaném ze značek — na zvýraznění. */
export function slotMarks(slots: Map<string, string>, slotBlock?: Map<string, number>): Mark[] {
  return [...slots.entries()].map(([slot, target]) => ({ b: slotBlock?.get(slot) ?? 0, s: plain(target) }));
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
    'Značky ⟦1⟧, ⟦2⟧… jsou odstavce nebo věty, které už přeložené máme. Nech každou značku',
    'přesně tak, jak je, na stejném místě, a její obsah nepiš. Přelož jen zbytek. Pro souvislost znamenají:',
    ...lines
  ].join('\n');
}

/**
 * Vzory podobných vět pro model.
 *
 * Věta „Kravata v zelené barvě…" se překládá podle už hotové „Kravata
 * v červené barvě…": stejné znění, změní se jen to, čím se liší — a model
 * to slovo správně vyskloňuje. Sourozenci pak zní stejně a odpověď je krátká.
 */
export function nearHint(all: { lang?: string; near: Near[] }[]): string {
  const lines: string[] = [];
  for (const one of all) {
    for (const item of one.near) {
      lines.push(`- ${plain(item.like)}\n  → ${one.lang ? `${one.lang}: ` : ''}${plain(item.target)}\n  (teď: ${plain(item.source)})`);
    }
  }
  if (!lines.length) return '';
  return [
    '',
    'Podobné věty, které už máme přeložené. Překládej je stejným zněním a změň jen to,',
    'čím se nová věta liší — a správně to vyskloňuj a uprav shodu:',
    ...lines
  ].join('\n');
}

/** Kolik odstavců paměť zná — do přehledu v nastavení. */
export function segmentStats(): { lang: string; sentences: number; paragraphs: number; texts: number }[] {
  const rows = getDb().prepare(
    `SELECT lang,
       SUM(CASE WHEN scope = 'veta' THEN 1 ELSE 0 END) AS sentences,
       SUM(CASE WHEN scope = 'blok' THEN 1 ELSE 0 END) AS paragraphs,
       SUM(CASE WHEN scope NOT IN ('veta', 'blok') THEN 1 ELSE 0 END) AS texts
     FROM ptrans_segments GROUP BY lang ORDER BY lang`
  ).all() as any[];
  return rows.map(row => ({ lang: row.lang, sentences: row.sentences ?? 0, paragraphs: row.paragraphs ?? 0,
    texts: row.texts ?? 0 }));
}

export const __test = { pieces, normalize, skeleton, key, LEAF, sentences, tokens, wordDiff, nearest };
