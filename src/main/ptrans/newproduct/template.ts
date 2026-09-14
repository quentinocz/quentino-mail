import { getDb } from '../../db';
import { ask } from '../../ai';
import { getSettings } from '../../settings';
import { getPtransSettings, fieldValue } from '../store';
import { productParameters, paramKey } from '../xml';
import { plain } from '../detect';
import { DraftProduct, DraftParam, DraftTexts, emptyTexts } from './draft';
import { storedTree } from '../categories';

/**
 * Nový produkt podle předlohy.
 *
 * Skoro každá novinka v e-shopu je variace na něco, co už tam je: jiná barva,
 * jiný vzor, jiná velikost. Psát popis od nuly je zbytečná práce a výsledek
 * se pokaždé trochu liší — tón textů se pak v kategorii rozjíždí.
 *
 * Riziko je opačné: z předlohy zůstane věta o modré barvě u zeleného
 * produktu. Proto se text nepřebírá mlčky — model označí místa, která
 * o předloze **mluví konkrétně**, a v rozhraní se zvýrazní.
 */

export interface TemplateLoad {
  templateCode: string;
  langs: Record<string, DraftTexts>;
  params: DraftParam[];
  categories: string[];
  mainCategory: string;
  manufacturer: string;
  google: Record<string, string>;
}

const GOOGLE_CARRY = ['google_color', 'google_gender', 'google_age',
  'google_condition', 'google_bundle', 'google_identifier'];

/**
 * Načte z feedu všechno, co se dá u nového produktu použít jako základ.
 *
 * Cena, sklad a EAN se schválně neberou — to jsou jediné údaje, které musí
 * být u nového produktu vlastní, a převzatá cena by se dala přehlédnout.
 */
export function loadTemplate(code: string, langs: string[]): TemplateLoad {
  const d = getDb();
  const product = d.prepare(
    'SELECT raw_xml, manufacturer, category, categories FROM ptrans_products WHERE code = ?'
  ).get(code) as { raw_xml: string; manufacturer: string; category: string; categories: string } | undefined;
  if (!product) throw new Error(`Produkt ${code} v katalogu není — stáhni feed a zkus to znovu.`);

  const out: TemplateLoad = {
    templateCode: code,
    langs: {},
    params: [],
    categories: [],
    mainCategory: '',
    manufacturer: product.manufacturer ?? '',
    google: {}
  };

  for (const lang of langs) {
    const texts = emptyTexts();
    for (const field of Object.keys(texts) as (keyof DraftTexts)[]) {
      texts[field] = fieldValue(code, lang, field);
    }
    /*
     * Adresa se nepřebírá. Dvě stránky se stejnou `seo_url` znamenají, že
     * jedna z nich v e-shopu přestane existovat — a je to ta nová.
     */
    texts.seo_url = '';
    out.langs[lang] = texts;
  }

  const names = productParameters(product.raw_xml);
  names.forEach((_name, index) => {
    const name = fieldValue(code, 'cz', paramKey(index, 'name'));
    const value = fieldValue(code, 'cz', paramKey(index, 'value'));
    if (name) out.params.push({ name, value, fromTemplate: true });
  });

  /*
   * Kategorie se ve feedu u produktu jmenují, ale importovat se musí kódem.
   * Přiřazuje se podle názvu proti exportu kategorií; co se nespáruje, se
   * prostě nepřevezme a uživatel to doklikne — tiché „skoro správně" by tady
   * bylo horší než prázdno.
   */
  const tree = storedTree();
  if (tree) {
    const byName = new Map<string, string>();
    for (const one of tree.items) {
      if (!one.holdsProducts) continue;
      for (const name of Object.values(one.names)) byName.set(name.toLowerCase(), one.code);
    }
    const all = (product.categories || '').split('|').map(s => s.trim()).filter(Boolean);
    for (const name of all) {
      const found = byName.get(name.toLowerCase());
      if (found && !out.categories.includes(found)) out.categories.push(found);
    }
    const primary = byName.get((product.category || '').toLowerCase());
    out.mainCategory = primary && out.categories.includes(primary) ? primary : (out.categories[0] ?? '');
  }

  for (const field of GOOGLE_CARRY) {
    const value = fieldValue(code, 'cz', field);
    if (value) out.google[field] = value;
  }
  return out;
}

/* ---------- co je na předloze specifické ---------- */

export interface Specific {
  lang: string;
  field: string;
  text: string;
  why: string;
}

/**
 * Nechá model vypsat úryvky, které mluví konkrétně o předloze.
 *
 * Vrací **doslovné výřezy textu**, ne pozice. Text se hned poté edituje a
 * jakákoli čísla znaků by po prvním napsaném písmenu ukazovala jinam;
 * hledání podle obsahu přežije i přepsání okolí.
 */
export async function findSpecifics(texts: DraftTexts, lang = 'cz',
                                    signal?: AbortSignal): Promise<Specific[]> {
  const s = getPtransSettings();
  const model = s.model || getSettings().fastModel;
  const fields: (keyof DraftTexts)[] = ['title', 'short', 'long'];
  const source = fields
    .map(field => `### ${field}\n${plain(texts[field])}`)
    .filter(part => part.split('\n')[1]?.trim())
    .join('\n\n');
  if (!source.trim()) return [];

  const answer = await ask(
    model,
    [
      'Dostaneš texty jednoho produktu z e-shopu s pánskou módou.',
      'Vypiš úryvky, které mluví KONKRÉTNĚ o tomhle kusu a u jiné varianty by',
      'nebyly pravda: barva, odstín, vzor, materiál, velikost, rozměr, počet kusů',
      'v sadě, příležitost vázaná na barvu, jméno kolekce.',
      'Obecné věty o kvalitě, dopravě nebo značce NEVYPISUJ.',
      '',
      'Odpověz JSON polem, každá položka {"field":"title|short|long","text":"doslovný úryvek","why":"barva|vzor|materiál|velikost|sada|kolekce|jiné"}.',
      'Úryvek musí být PŘESNĚ tak, jak stojí v textu, a co nejkratší (slovo až věta).',
      'Nic jiného než JSON nevracej.'
    ].join('\n'),
    source,
    1500,
    { signal }
  );

  let rows: any[] = [];
  try {
    const slice = answer.slice(answer.indexOf('['), answer.lastIndexOf(']') + 1);
    rows = JSON.parse(slice);
  } catch {
    return [];
  }
  const out: Specific[] = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const field = String(row?.field ?? '');
    const text = String(row?.text ?? '').trim();
    if (!fields.includes(field as keyof DraftTexts) || !text) continue;
    /*
     * Co v textu doopravdy není, se zahodí. Model občas úryvek „opraví"
     * (doplní diakritiku, zkrátí) a zvýraznění by se pak nemělo čeho chytit —
     * uživatel by viděl seznam míst, která na obrazovce nikde nesvítí.
     */
    if (!plain(texts[field as keyof DraftTexts]).includes(text)) continue;
    if (out.some(one => one.field === field && one.text === text)) continue;
    out.push({ lang, field, text, why: String(row?.why ?? 'jiné') });
  }
  return out;
}

/**
 * Je kód už v e-shopu?
 *
 * Kód si zadává člověk sám — aplikace ho nevymýšlí, jen zkontroluje, že
 * nekoliduje. Import se stejným kódem by totiž nezaložil nový produkt, ale
 * **přepsal stávající**, a to potichu.
 */
export function codeTaken(code: string, ownCode = ''): { taken: boolean; title: string } {
  const clean = code.trim();
  if (!clean) return { taken: false, title: '' };
  /*
   * Vlastní produkt se za kolizi nepočítá.
   *
   * Po uložení do katalogu tam produkt je — a kontrola pak u jeho vlastního
   * kódu hlásila „má ho …" a ukazovala přitom sama na sebe. Vypadalo to,
   * že se kód musí změnit, přitom bylo všechno v pořádku.
   */
  if (ownCode && ownCode.trim().toLowerCase() === clean.toLowerCase()) {
    return { taken: false, title: '' };
  }
  const row = getDb().prepare(
    'SELECT code, title FROM ptrans_products WHERE LOWER(code) = LOWER(?)'
  ).get(clean) as { code: string; title: string } | undefined;
  return { taken: !!row, title: row?.title ?? '' };
}
