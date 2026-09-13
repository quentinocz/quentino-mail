import { ask } from '../../ai';
import { getSettings } from '../../settings';
import { getPtransSettings } from '../store';
import { plain } from '../detect';

/**
 * Přepisy textu pod rukama uživatele.
 *
 * Dvě věci, které se u nového produktu podle předlohy dělají pořád:
 *
 *  1. přepíše se barva (nebo vzor, materiál) — a věty o tom, k čemu se
 *     produkt hodí, najednou nesedí; je potřeba přepsat **jen ten kus**,
 *     ale s vědomím celého zbytku,
 *  2. změní se název — a textem se táhne starý název i to, co z něj plynulo.
 *
 * Obojí model zvládne, ale ani jedno se nesmí zapsat samo. Vrací se návrh,
 * který člověk přijme nebo zahodí.
 */

function model(): string {
  const s = getPtransSettings();
  return s.model || getSettings().draftModel;
}

/** Společný základ pokynů, aby se přepis nerozešel s tónem ostatních textů. */
function house(): string {
  const s = getPtransSettings();
  return [
    'Píšeš texty pro český e-shop s pánskou módou.',
    'Drž se tónu okolního textu — stejná délka vět, stejné oslovení, stejná míra nadšení.',
    'Nevymýšlej vlastnosti, které z podkladů neplynou (materiál, rozměr, původ).',
    s.prompt.trim() ? `\nVlastní pokyny:\n${s.prompt.trim()}` : ''
  ].filter(Boolean).join('\n');
}

/**
 * Přepíše označený kus textu podle zbytku.
 *
 * Model dostane celý text, ale vrací **jen náhradu za výběr**. Kdyby vracel
 * celý text, přepsal by cestou i místa, kterých se uživatel nedotkl — a ta
 * už mohou být ručně doladěná.
 */
export async function rewriteSelection(options: {
  full: string;
  selection: string;
  instruction?: string;
  html?: boolean;
  signal?: AbortSignal;
}): Promise<string> {
  const selection = options.selection.trim();
  if (!selection) throw new Error('Není označený žádný text.');
  if (!options.full.includes(options.selection)) {
    throw new Error('Označený text se v poli nenašel — mezitím se změnil.');
  }

  const marked = options.full.replace(options.selection, `⟦${options.selection}⟧`);
  const answer = await ask(
    model(),
    [
      house(),
      '',
      'Dostaneš celý text produktu; přepisovaná část je mezi ⟦ a ⟧.',
      'Přepiš POUZE tuhle část tak, aby dávala smysl se zbytkem textu.',
      options.html
        ? 'V části mohou být HTML značky — zachovej je i s atributy, měň jen text mezi nimi.'
        : 'Odpověz holým textem bez HTML.',
      'Zachovej přibližnou délku původní části.',
      options.instruction?.trim() ? `\nPokyn uživatele: ${options.instruction.trim()}` : '',
      '',
      'Vrať POUZE novou podobu té části. Žádný úvod, žádné ⟦ ⟧, žádné uvozovky navíc.'
    ].filter(Boolean).join('\n'),
    marked.slice(0, 8000),
    900,
    { signal: options.signal }
  );
  return answer.replace(/^⟦|⟧$/g, '').trim();
}

/* ---------- návrh úprav podle nového názvu ---------- */

export interface TextChange {
  field: string;
  before: string;
  after: string;
  why: string;
}

/**
 * Projde texty předlohy a navrhne, co změnit podle nového názvu.
 *
 * Vrací se seznam dvojic „tohle → tohle", ne hotový text. Jednak se dá každá
 * změna zvlášť přijmout nebo odmítnout, jednak je vidět, čeho se model dotkl —
 * u převzatého popisu je to podstatnější než u psaní od nuly, protože chyba
 * tady nevypadá jako chyba, ale jako věta, která tam odjakživa byla.
 */
export async function proposeByTitle(options: {
  oldTitle: string;
  newTitle: string;
  fields: { field: string; value: string }[];
  signal?: AbortSignal;
}): Promise<TextChange[]> {
  const newTitle = options.newTitle.trim();
  if (!newTitle) throw new Error('Není vyplněný nový název.');

  const source = [
    `Původní název: ${options.oldTitle}`,
    `Nový název: ${newTitle}`,
    '',
    ...options.fields
      .filter(one => one.value.trim())
      .map(one => `### ${one.field}\n${one.value.slice(0, 4000)}`)
  ].join('\n');

  const answer = await ask(
    model(),
    [
      house(),
      '',
      'Texty jsou převzaté z jiného produktu. Podle nového názvu vypiš, co je v nich',
      'potřeba změnit, aby seděly: barva, vzor, materiál, velikost, počet kusů v sadě,',
      'věty o příležitosti navázané na barvu.',
      'Co platí pro oba produkty stejně, NECH BÝT.',
      '',
      'Odpověz JSON polem, každá položka:',
      '{"field":"název pole z nadpisu ###","before":"doslovný úryvek z textu","after":"jak má znít","why":"stručně proč"}',
      '„before" musí být PŘESNĚ tak, jak stojí v textu, a co nejkratší.',
      'V HTML polích zachovej značky i s atributy.',
      'Nic jiného než JSON nevracej.'
    ].join('\n'),
    source,
    2500,
    { signal: options.signal }
  );

  let rows: any[] = [];
  try {
    rows = JSON.parse(answer.slice(answer.indexOf('['), answer.lastIndexOf(']') + 1));
  } catch {
    return [];
  }
  const byField = new Map(options.fields.map(one => [one.field, one.value]));
  const out: TextChange[] = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const field = String(row?.field ?? '');
    const before = String(row?.before ?? '');
    const after = String(row?.after ?? '');
    const value = byField.get(field);
    if (!value || !before || before === after) continue;
    /*
     * Návrh, jehož „before" v textu není, se zahodí. Jinak by se v seznamu
     * objevila změna, která po kliknutí neudělá nic — a to je horší než
     * kdyby ji model nenavrhl vůbec.
     */
    if (!value.includes(before)) continue;
    if (out.some(one => one.field === field && one.before === before)) continue;
    out.push({ field, before, after, why: String(row?.why ?? '') });
  }
  return out;
}

/** Použije jednu navrženou změnu. Vrací text i s informací, jestli se opravdu chytla. */
export function applyChange(value: string, change: TextChange): { value: string; applied: boolean } {
  if (!value.includes(change.before)) return { value, applied: false };
  return { value: value.replace(change.before, change.after), applied: true };
}

/** Krátký náhled změny do seznamu — bez HTML, ať je vidět, o čem se rozhoduje. */
export function changeSummary(change: TextChange): string {
  return `${plain(change.before).slice(0, 80)} → ${plain(change.after).slice(0, 80)}`;
}
