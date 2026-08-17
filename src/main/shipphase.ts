import { getDb } from './db';
import { getSetting } from './db';
import type { ShipPhase } from '../shared/types';

/**
 * Zařazení hlášky dopravce do fáze, aby šlo na první pohled poznat, kde
 * zásilka je — bez čtení věty.
 *
 * Pravidla řeší drtivou většinu případů a dělají to zadarmo. Hlášky se liší
 * hlavně tím, že v sobě mají název depa nebo pobočky („Zásilka dorazila na depo
 * Ostrava, Františka a Anny Ryšových 1300/44"), takže se před porovnáním
 * odstraní vlastní jména a čísla a zůstane jen kostra věty. Stejná hláška
 * z jiného města tak spadne do stejné fáze bez jediného dotazu na AI.
 *
 * AI se ptáme jen na hlášku, kterou pravidla neznají, a odpověď se uloží —
 * příště už se rozhodne z databáze.
 */

const PHASES: { phase: ShipPhase; re: RegExp }[] = [
  // Nejjednoznačnější napřed — „připraveno k vyzvednutí" obsahuje i „doruč"
  { phase: 'problem', re: /nedoru[čc]|nepoda[řr]ilo\s+(se\s+)?doru[čc]|nezasti[žz]|vr[áa]c|vr[áa]t[ií]|storn|zru[šs]|po[šs]kozen|zpo[žz]d|ztrac|reklamac|nevyzvednut|odm[íi]tn|returned|failed|damaged|lost|refus/i },
  { phase: 'ready',   re: /p[řr]ipraven[aoáe]?\s*k\s*(vyzvednut|p[řr]evzet)|k\s*vyzvednut[ íi]|ready\s*(for|to)\s*(pick|collect)|\bulo[žz]en[aoáe]?\b.*\b(v[ýy]dejn|po[bš]|z-?box)/i },
  { phase: 'delivered', re: /doru[čc]en|vyzvednut|p[řr]edan[aoáe]?\s*p[řr][íi]jemc|je\s*u\s*v[áa]s|delivered|picked\s*up|collected/i },
  { phase: 'transit', re: /na\s*cest|v\s*p[řr]eprav|do\s*p[řr]eprav|p[řr]eprav|depo|dep[óo]|t[řr][íi]d[íi]c|rozv[áa]|doru[čc]ova|v\s*ruk[áa]ch\s*[řr]idi[čc]|p[řr]evzal|p[řr]evzat[íi]|pod[áa]n|p[řr]ed[áa]n[oa]?\s*(k|do|dopravc|p[řr]epravc)|in\s*transit|out\s*for\s*delivery|on\s*the\s*way|shipped|dispatch|handed\s*over/i },
  { phase: 'pending', re: /[čc]ek[áa]me|o\s*va[šs][íi]\s*z[áa]silce\s*u[žz]\s*v[íi]me|nep[řr]edan|p[řr]ipravuje\s*se\s*k\s*p[řr]ed[áa]n|awaiting|label\s*created|pre-?advice|registrov|o[čc]ek[áa]v[áa]me/i }
];

/**
 * Kostra hlášky bez konkrétních míst a čísel — na ní se pozná, že jde
 * o tutéž hlášku z jiné pobočky.
 */
export function statusSkeleton(text: string): string {
  const words = (text ?? '').split(/\s+/).filter(Boolean);
  // Názvy měst, dep a poboček začínají velkým písmenem — bez nich je z hlášky
  // „Zásilka dorazila na depo Ostrava…" a „…depo Holubice…" tatáž věta, takže
  // se na AI ptáme jednou za formulaci, ne jednou za pobočku.
  const generic = words.filter((w, i) => i === 0 || w[0] !== w[0].toUpperCase() || /^\d/.test(w));

  return generic
    .join(' ')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // diakritika pryč
    .replace(/\d+/g, ' ')                               // čísla popisná, PSČ
    .replace(/[^\p{L}\s]/gu, ' ')                       // interpunkce
    .split(/\s+/)
    .filter(w => w.length > 1)
    .slice(0, 12)
    .join(' ')
    .trim();
}

/** Rozhodnutí podle pravidel; null = pravidla neznají. */
export function phaseByRules(text: string): ShipPhase | null {
  const t = text ?? '';
  for (const { phase, re } of PHASES) {
    if (re.test(t)) return phase;
  }
  return null;
}

function readLearned(skeleton: string): ShipPhase | null {
  try {
    const row = getDb().prepare('SELECT phase FROM ship_phase WHERE skeleton = ?').get(skeleton) as any;
    return row?.phase ?? null;
  } catch {
    return null;
  }
}

function writeLearned(skeleton: string, sample: string, phase: ShipPhase, source: string) {
  try {
    getDb().prepare(
      `INSERT INTO ship_phase (skeleton, phase, sample, source, at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(skeleton) DO UPDATE SET phase = excluded.phase, source = excluded.source, at = excluded.at`
    ).run(skeleton, phase, sample.slice(0, 200), source, new Date().toISOString());
  } catch { /* uložení je jen optimalizace */ }
}

/**
 * Zařadí hlášku do fáze. Pořadí je záměrné: pravidla (zdarma) → naučené
 * z databáze (zdarma) → AI (jen jednou pro každou novou podobu hlášky).
 */
export async function classifyShipment(text: string | null | undefined): Promise<ShipPhase> {
  const t = (text ?? '').trim();
  if (!t) return 'unknown';

  const byRules = phaseByRules(t);
  if (byRules) return byRules;

  const skeleton = statusSkeleton(t);
  if (!skeleton) return 'unknown';

  const learned = readLearned(skeleton);
  if (learned) return learned;

  // Bez API klíče zůstane hláška nezařazená — karta ji ukáže jako text
  if (!getSetting('anthropicApiKey')) return 'unknown';

  try {
    const { classifyText } = await import('./ai');
    const answer = (await classifyText(
      'Zařaď hlášku dopravce o stavu zásilky do jedné z fází. Odpověz jediným slovem z nabídky.',
      `Hláška: "${t}"\n\nFáze:\npending = čeká na předání dopravci\ntransit = je v přepravě, na cestě\nready = připravena k vyzvednutí\ndelivered = doručena nebo vyzvednuta\nproblem = nedoručeno, vráceno, storno, poškození, zpoždění`,
      ['pending', 'transit', 'ready', 'delivered', 'problem']
    )).trim().toLowerCase() as ShipPhase;

    if (['pending', 'transit', 'ready', 'delivered', 'problem'].includes(answer)) {
      writeLearned(skeleton, t, answer, 'ai');
      return answer;
    }
  } catch { /* AI je nedostupná — hláška zůstane bez zařazení */ }

  return 'unknown';
}

/** Ruční oprava zařazení — uloží se stejně jako odpověď AI. */
export function relearnPhase(text: string, phase: ShipPhase): void {
  const skeleton = statusSkeleton(text);
  if (skeleton) writeLearned(skeleton, text, phase, 'user');
}
