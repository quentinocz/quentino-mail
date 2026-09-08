import { getSetting, setSetting } from './db';
import { askLong } from './ai';
import { getSettings } from './settings';
import { ga4Deep, ga4DeepForAi } from './ga4';
import type { Ga4Deep, Ga4Note, Ga4Notes } from '../shared/types';

/**
 * Závěry k číslům v rozboru návštěvnosti.
 *
 * Tabulka čísel je pro někoho, kdo s reklamou dělá každý den, čitelná sama
 * o sobě. Pro majitele e-shopu, který ji otevře jednou za měsíc, není:
 * „konverze 1,8 %" neřekne, jestli je to dobře, špatně, nebo jestli je to
 * vůbec spočítané z dost dat. Proto ke každému řádku patří věta, která
 * říká **co s tím** — a ta se ukazuje až po najetí, aby přehled zůstal
 * přehledem.
 *
 * Dvě vrstvy, schválně oddělené:
 *
 *  - **Spočítaná** — podíl na návštěvách, srovnání s průměrem webu, kolik
 *    peněz na návštěvu. Ta je vždycky a nemůže si nic vymyslet; skládá ji
 *    rozhraní přímo z čísel v tabulce.
 *  - **Od AI** — tahle. Hledá souvislosti mezi řádky („nejnavštěvovanější
 *    stránka nekonvertuje, zato levnější kanál ano") a doporučuje krok.
 *    Když se nepovede, nic se neděje: spočítaná vrstva zůstává.
 *
 * Drží se, dokud se nezmění rozbor, ze kterého vznikla. Přepočítávat závěry
 * nad nezměněnými čísly by stálo peníze za tokeny a vracelo pokaždé trochu
 * jinou větu o tomtéž.
 */

const KINDS = ['dobré', 'slabé', 'zvážit'] as const;
const WHERE = ['months', 'channels', 'landings', 'pages', 'devices', 'countries', 'funnel'] as const;

const SYSTEM = `Jsi analytik e-shopu Quentino (kravaty, motýlky, kšandy, doplňky).
Dostaneš rozbor návštěvnosti z Google Analytics. Napiš krátké závěry ke konkrétním řádkům.

Pro koho píšeš: majitel e-shopu, který marketingu nerozumí a chce vědět, co s tím má udělat.
Piš česky, bez odborných zkratek. Když použiješ pojem (konverze, kanál, vstupní stránka),
vysvětli ho v té samé větě.

Pravidla, na kterých záleží:
- Každý závěr musí stát na čísle, které v datech opravdu je. Číslo ve větě zopakuj.
- Nikdy si nevymýšlej řádek, který v datech není. "row" opisuj přesně, znak po znaku.
- Nepiš obecné rady ("zlepšete UX", "testujte"). Piš krok, který jde udělat tenhle týden.
- Když je vzorek malý (pod 100 návštěv), řekni to a nedělej z toho závěr.
- Když něco vypadá jako chyba měření (třeba odkaz z vlastního webu jako zdroj), řekni to.
- Radši pět dobrých závěrů než dvanáct vycpávkových.

Odpověz **jen** JSON:
{"summary":"2–3 věty: co funguje, co ne, co bych udělal jako první",
 "notes":[{"where":"channels","row":"přesný název řádku nebo null","kind":"dobré|slabé|zvážit","text":"jedna až dvě věty, do 220 znaků"}]}

"where" je jedno z: months, channels, landings, pages, devices, countries, funnel.`;

/** Jména řádků, která v datech opravdu jsou — proti vymyšleným. */
function namesIn(deep: Ga4Deep, where: string): Set<string> {
  const list =
    where === 'channels' ? deep.channels
      : where === 'landings' ? deep.landings
        : where === 'pages' ? deep.pages
          : where === 'devices' ? deep.devices
            : where === 'countries' ? deep.countries
              : [];
  return new Set(list.map(one => one.name));
}

/**
 * Z odpovědi jen to, co se dá ukázat.
 *
 * Model občas pojmenuje řádek jinak, než jak je v datech („Google CPC" místo
 * „google / cpc"). Takový závěr by visel u ničeho, takže se z něj udělá
 * poznámka k celé sestavě — obsah se nezahazuje, jen se přestěhuje.
 */
function clean(raw: any, deep: Ga4Deep): { summary: string; notes: Ga4Note[] } {
  const notes: Ga4Note[] = [];
  for (const one of Array.isArray(raw?.notes) ? raw.notes : []) {
    const where = String(one?.where ?? '').trim();
    const text = String(one?.text ?? '').trim();
    if (!text || !(WHERE as readonly string[]).includes(where)) continue;
    const row = String(one?.row ?? '').trim();
    const known = namesIn(deep, where);
    const kind = (KINDS as readonly string[]).includes(String(one?.kind)) ? String(one.kind) : 'zvážit';
    notes.push({
      where,
      row: row && known.has(row) ? row : null,
      kind: kind as Ga4Note['kind'],
      text: text.slice(0, 260)
    });
    if (notes.length >= 14) break;
  }
  return { summary: String(raw?.summary ?? '').trim().slice(0, 600), notes };
}

function parse(answer: string): any {
  const start = answer.indexOf('{');
  const end = answer.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(answer.slice(start, end + 1)); } catch { return null; }
}

/** Datum rozboru, ze kterého závěry vznikly — podle něj se pozná, že jsou staré. */
function stored(key: string): Ga4Notes | null {
  try { return JSON.parse(getSetting(key, '') || 'null'); } catch { return null; }
}

export async function ga4Notes(days = 365, force = false): Promise<Ga4Notes | null> {
  const deep = await ga4Deep(days);
  if (!deep || deep.error || deep.months.length === 0) return null;

  const key = `ga4Notes${deep.days}`;
  const last = stored(key);
  // Rozbor se nezměnil → závěry taky ne. Nový dotaz by stál tokeny a vrátil
  // tutéž myšlenku jinými slovy.
  if (!force && last && last.from === deep.at) return last;

  const digest = ga4DeepForAi(deep);
  if (!digest) return last;

  const s = getSettings();
  const model = s.insightModel || s.draftModel;
  try {
    const answer = await askLong(model, SYSTEM, digest, { maxTokens: 3000, endMark: '}' });
    const parsed = parse(answer);
    if (!parsed) throw new Error('Odpověď se nedala přečíst jako JSON.');
    const out = clean(parsed, deep);
    if (out.notes.length === 0 && !out.summary) throw new Error('Model nevrátil žádný závěr.');
    const notes: Ga4Notes = {
      at: new Date().toISOString(),
      from: deep.at,
      days: deep.days,
      summary: out.summary,
      notes: out.notes,
      error: null
    };
    setSetting(key, JSON.stringify(notes));
    return notes;
  } catch (e: any) {
    // Staré závěry jsou pořád lepší než prázdno; spočítaná vrstva v rozhraní
    // funguje tak jako tak.
    const message = String(e?.message ?? e);
    return last ? { ...last, error: message } : {
      at: '', from: deep.at, days: deep.days, summary: '', notes: [], error: message
    };
  }
}
