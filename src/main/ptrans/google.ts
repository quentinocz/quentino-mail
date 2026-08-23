import { getDb } from '../db';
import { ask } from '../ai';
import { getSettings } from '../settings';
import { getPtransSettings, saveTranslation, productFields, targetLangs } from './store';
import { getField, tagText } from './xml';
import { parameterMap, renderTemplate } from './seo';
import { clamp } from './translate';
import { plain } from './detect';
import { colorFor, shadeFromTitle } from './colors';
import { detectBundle } from './bundle';
import { memoryHint } from './memory';

/**
 * Atributy pro Google Nákupy.
 *
 * Feed z Upgates má klíče připravené, ale u velké části produktů prázdné — a
 * prázdný atribut je pro Google totéž co žádný: nabídka se hůř páruje s
 * dotazem a v porovnávači spadne níž. Tenhle modul je doplní.
 *
 * Dělí se to na dvě skupiny, protože se chovají úplně jinak:
 *
 *  - **Texty** (titulek, popis) píše model. U titulku je to změna proti
 *    šabloně: šablona je předvídatelná, ale skládá slova mechanicky a Google
 *    hodnotí, jestli titulek odpovídá tomu, co lidé hledají. Šablona zůstává
 *    jako záloha a jako rychlá volba pro tisíce produktů naráz.
 *  - **Číselníky** (barva, pohlaví, věk, stav, set) model nepíše vůbec.
 *    Google u nich zná jen konkrétní hodnoty a „skoro správně" znamená
 *    zahozeno. Skládá je proto kód z parametrů a kategorií.
 */

export type GoogleField = 'google_title' | 'google_desc' | 'google_color' | 'google_gender'
  | 'google_age' | 'google_condition' | 'google_bundle' | 'google_identifier';

export const GOOGLE_LABELS: Record<GoogleField, string> = {
  google_title: 'Titulek',
  google_desc: 'Popis',
  google_color: 'Barva',
  google_gender: 'Pohlaví',
  google_age: 'Věková skupina',
  google_condition: 'Stav',
  google_bundle: 'Set',
  google_identifier: 'Má čárový kód'
};

/* ---------- titulek a popis modelem ---------- */

/**
 * Skladba titulku pro Google Nákupy.
 *
 * Pravidla nejsou vymyšlená — odpovídají auditu feedu, který Quentino dostal
 * od AdsOne, a tomu, co Merchant Center sám doporučuje:
 *
 *     Typ produktu + Barva + Vzor/Detail + Značka [+ Velikost/Balení]
 *
 * Podstatné je pořadí. Zákazník hledá „vázací motýlek", ne „tmavě modrý" —
 * typ výrobku proto patří na první místo, ne barva. Značka jde naopak na
 * konec: do aukcí ji nese atribut `brand`, v titulku slouží jen k potvrzení.
 *
 * Délka cílí na **70 znaků**, protože jen tolik Google v inzerátu zobrazí.
 * Technický limit je 150, ale co je za sedmdesátkou, čtenář nikdy neuvidí.
 *
 * Marketingové obraty se vypouštějí: „pro tátu a syna" na webu funguje, ale
 * nikdo to takhle do vyhledávače nepíše. U setů se místo toho vypisuje, co
 * zákazník doopravdy dostane („Set Kravata + Dětská Kravata").
 */
const TITLE_RULES = (limit: number) =>
  [`Napiš název produktu pro Google Nákupy. Cíl je do ${limit} znaků — víc Google v inzerátu nezobrazí.`,
    '',
    'ZÁVAZNÉ POŘADÍ SLOV:',
    '1. Typ produktu (např. „Vázací Motýlek", „Kapesníček do Saka", „Dětská Kravata") — vždy na prvním místě',
    '2. Barva',
    '3. Vzor nebo rozlišující detail — jedním slovem („Puntíky", ne „s jemnými puntíky")',
    '4. Značka na konci',
    '5. Velikost nebo počet kusů, jen když produkt rozlišují',
    '',
    'Piš Velkými Počátečními Písmeny U Podstatných Slov, bez spojek a předložek navíc.',
    'U dětských produktů musí slovo „Dětský/Dětská" zůstat v typu produktu.',
    'U setu vypiš, co zákazník dostane („Set Kravata + Dětská Kravata"), ne marketingový obrat.',
    '',
    'Zakázáno: barva na prvním místě, marketingové obraty, kterými nikdo nehledá',
    '(„pro tátu a syna", „pro každou příležitost"), celá slova velkými písmeny, vykřičníky,',
    '„nejlepší", „akce", „sleva", cena, doprava, dostupnost a text v závorkách.',
    'Nevymýšlej vlastnosti, které nejsou v podkladech.'].join('\n');

const DESC_RULES = (limit: number) =>
  [`Napiš popis produktu pro Google Nákupy. Nejvýš ${limit} znaků, čistý text bez HTML a bez odrážek.`,
    'První věta říká, co produkt je a pro koho — ta se zobrazuje nejčastěji.',
    'Dál materiál, rozměry, provedení, k jaké příležitosti se hodí a jak se o něj starat.',
    'Barvu piš tím odstínem, jakým produkt opravdu je („hořčicově žlutá"), ne obecnou barvou.',
    'Piš souvislé věty, ne výčet klíčových slov.',
    'Zakázáno: cena, doprava, slevy, odkazy, informace o dostupnosti, srovnání s konkurencí,',
    'velká písmena přes celé slovo a text typu „klikněte zde".'].join('\n');

/** Odstín a základní barva jsou totéž — pak není co rozlišovat. */
function normalizeSame(a: string, b: string): boolean {
  const clean = (value: string) => plain(value ?? '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  return clean(a) === clean(b);
}

/**
 * Podklady o produktu, ze kterých model píše.
 *
 * Skladba titulku má pevné pořadí, takže se stavební díly předávají
 * **rozebrané**, ne jako jedna věta. Model pak neluští z názvu, co je typ a
 * co barva — dostane obojí zvlášť a jeho úkolem je to jen správně poskládat
 * a přeložit. Tím se z nejčastější chyby (barva na prvním místě) stane
 * obtížně udělatelná věc.
 */
function productBrief(code: string, lang: string, forTitle = false): string {
  const s = getPtransSettings();
  const d = getDb();
  const product = d.prepare(
    'SELECT title, category, categories, manufacturer, raw_xml FROM ptrans_products WHERE code = ?'
  ).get(code) as any;
  if (!product) return '';

  const fields = productFields(code, [lang]);
  const pick = (field: string) => {
    const row = fields.find(f => f.field === field);
    return row?.translated || row?.value || '';
  };
  const params = parameterMap(code, lang);
  const bundle = detectBundle(code);

  const parts = [
    `Název: ${pick('title') || product.title}`,
    product.manufacturer ? `Značka: ${product.manufacturer}` : '',
    product.category ? `Kategorie: ${product.category}` : ''
  ];

  if (forTitle) {
    // Odstín se bere z **přeloženého** názvu, ne z parametru. Parametr má jen
    // základní barvu („žlutá"), do textu ale patří to, jak produkt doopravdy
    // vypadá („hořčicově žlutá") — základní barva slouží jen atributu g:color.
    const localTitle = pick('title') || product.title;
    const shade = shadeFromTitle(localTitle) || params.barva || '';
    const base = colorFor(code, lang);

    parts.push(
      `— TYP PRODUKTU (na první místo): odvoď z kategorie „${product.category}" a názvu`,
      shade ? `— BARVA do textu (použij tenhle odstín, ne obecnou barvu): ${shade}` : '— BARVA: (není)',
      base && normalizeSame(base, shade)
        ? ''
        : base ? `— (základní barva „${base}" jde jen do atributu g:color, do titulku ji nedávej)` : '',
      params.vzor ? `— VZOR: ${params.vzor}` : '',
      params.materiál || params.material ? `— MATERIÁL: ${params.materiál ?? params.material}` : '',
      params.šířka || params.velikost ? `— ROZMĚR: ${params.šířka ?? params.velikost}` : '',
      `— ZNAČKA (na konec): ${product.manufacturer || 'Quentino'}`,
      bundle.isBundle ? '— JE TO SET: vypiš, co zákazník dostane, ne marketingový obrat' : ''
    );
  }

  if (!forTitle) {
    // I v popisu má být odstín, ne obecná barva — „hořčicově žlutá" je to,
    // jak produkt vypadá; „žlutá" je jen zařazení do filtru
    const shade = shadeFromTitle(pick('title') || product.title);
    if (shade) parts.push(`— ODSTÍN do textu (ne obecná barva): ${shade}`);
  }

  parts.push(
    Object.entries(params).map(([name, value]) => `${name}: ${value}`).join(', '),
    tagText(product.raw_xml, 'EAN') ? `EAN: ${tagText(product.raw_xml, 'EAN')}` : '',
    `Popis: ${plain(pick('long') || pick('short')).slice(0, forTitle ? 500 : 1400)}`
  );

  return parts.filter(Boolean).join('\n');
}

/**
 * Nechá model napsat titulek nebo popis pro Google.
 *
 * Do pokynů jde i paměť překladů — tím se drží stejné názvosloví jako ve
 * zbytku jazykové mutace. Bez toho by v titulku pro Google byly „suspenders"
 * a v názvu produktu „braces", a Google by to bral jako dvě různé věci.
 */
export async function writeGoogleText(code: string, lang: string,
  kind: 'google_title' | 'google_desc'): Promise<string> {
  const s = getPtransSettings();
  const model = s.model || getSettings().draftModel;
  // U titulku se cílí na viditelných 70 znaků, ne na technických 150 —
  // co je za sedmdesátkou, zákazník v inzerátu nikdy neuvidí
  const limit = kind === 'google_title'
    ? Math.min(s.limits.googleTitleVisible || 70, 150)
    : Math.min(s.limits.googleDesc || 5000, 1200);

  const brief = productBrief(code, lang, kind === 'google_title');
  if (!brief) throw new Error('Produkt není v databázi.');

  const category = (getDb().prepare('SELECT category FROM ptrans_products WHERE code = ?')
    .get(code) as any)?.category ?? '';

  const answer = await ask(
    model,
    [
      `Píšeš pro e-shop do Google Nákupů v jazyce s kódem „${lang}". Piš výhradně tímhle jazykem.`,
      kind === 'google_title' ? TITLE_RULES(limit) : DESC_RULES(limit),
      memoryHint(brief, lang, category),
      s.prompt.trim() ? `\nVlastní pokyny:\n${s.prompt.trim()}` : '',
      '\nVrať POUZE výsledný text, nic dalšího.'
    ].filter(Boolean).join('\n'),
    brief,
    kind === 'google_title' ? 300 : 800
  );

  const value = clamp(answer.replace(/^["„]+|["“]+$/g, '').replace(/\s+/g, ' ').trim(), limit);
  if (value) saveTranslation(code, lang, kind, value, model);
  return value;
}

/* ---------- číselníky ---------- */

export interface AttributeRules {
  /** Kategorie → pohlaví; hledá se podle podřetězce, malými písmeny */
  gender: { match: string; value: 'male' | 'female' | 'unisex' }[];
  /** Kategorie → věková skupina */
  age: { match: string; value: 'adult' | 'kids' | 'infant' | 'newborn' | 'toddler' }[];
  /** Výchozí hodnoty, když nesedí žádné pravidlo */
  defaultGender: 'male' | 'female' | 'unisex';
  defaultAge: 'adult' | 'kids' | 'infant' | 'newborn' | 'toddler';
  condition: 'new' | 'refurbished' | 'used';
}

export const DEFAULT_ATTRIBUTE_RULES: AttributeRules = {
  gender: [
    { match: 'dámsk', value: 'female' },
    { match: 'dievč', value: 'female' },
    { match: 'pánsk', value: 'male' },
    { match: 'chlapec', value: 'male' },
    { match: 'dětsk', value: 'unisex' },
    { match: 'detsk', value: 'unisex' }
  ],
  age: [
    { match: 'dětsk', value: 'kids' },
    { match: 'detsk', value: 'kids' },
    { match: 'kojenec', value: 'infant' },
    { match: 'baby', value: 'infant' }
  ],
  defaultGender: 'male',
  defaultAge: 'adult',
  condition: 'new'
};

function ruleFor<T extends { match: string; value: string }>(list: T[], haystack: string): string | null {
  const key = haystack.toLowerCase();
  for (const rule of list) if (rule.match && key.includes(rule.match.toLowerCase())) return rule.value;
  return null;
}

export interface AttributeSet {
  google_color: string;
  google_gender: string;
  google_age: string;
  google_condition: string;
  google_bundle: string;
  google_identifier: string;
  /** Proč vyšel set tak, jak vyšel — do karty produktu */
  bundleReason: string;
  bundleLearned: boolean;
}

/**
 * Spočítá číselníkové atributy pro jeden produkt a jazyk.
 *
 * `is_bundle` a `identifier_exists` jsou v Upgates ano/ne hodnoty; Google je
 * čte jako `yes`/`no`. Píší se stejně do všech jazyků — nejsou to texty.
 */
export function attributesFor(code: string, lang: string, rules = getAttributeRules()): AttributeSet {
  const d = getDb();
  const row = d.prepare(
    'SELECT title, category, categories, raw_xml FROM ptrans_products WHERE code = ?'
  ).get(code) as any;
  if (!row) {
    return {
      google_color: '', google_gender: '', google_age: '', google_condition: '',
      google_bundle: '', google_identifier: '', bundleReason: '', bundleLearned: false
    };
  }

  const haystack = `${row.title ?? ''} ${row.category ?? ''} ${row.categories ?? ''}`;
  const bundle = detectBundle(code);
  const ean = tagText(row.raw_xml, 'EAN');

  return {
    google_color: colorFor(code, lang),
    google_gender: ruleFor(rules.gender, haystack) ?? rules.defaultGender,
    google_age: ruleFor(rules.age, haystack) ?? rules.defaultAge,
    google_condition: rules.condition,
    google_bundle: bundle.isBundle ? 'yes' : 'no',
    google_identifier: ean ? 'yes' : 'no',
    bundleReason: bundle.reason,
    bundleLearned: bundle.learned
  };
}

const RULES_KEY = 'ptrans.googleRules';

export function getAttributeRules(): AttributeRules {
  try {
    const saved = JSON.parse(
      (getDb().prepare('SELECT value FROM settings WHERE key = ?').get(RULES_KEY) as any)?.value ?? '{}'
    );
    return { ...DEFAULT_ATTRIBUTE_RULES, ...saved };
  } catch {
    return { ...DEFAULT_ATTRIBUTE_RULES };
  }
}

export function saveAttributeRules(patch: Partial<AttributeRules>): AttributeRules {
  const next = { ...getAttributeRules(), ...patch };
  getDb().prepare(
    'INSERT INTO settings(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(RULES_KEY, JSON.stringify(next));
  return next;
}

/**
 * Zapíše číselníky vybraným produktům.
 *
 * Ručně upravená hodnota se nepřepisuje — to je jediný způsob, jak si člověk
 * může u konkrétního produktu prosadit svoje a nepřijít o to při příštím
 * hromadném zápisu.
 */
export function applyAttributes(codes: string[], langs?: string[], force = false):
  { written: number; skipped: number } {
  const s = getPtransSettings();
  const list = langs?.length ? langs : targetLangs(s);
  const all = [...new Set([s.sourceLang, ...list])];
  const rules = getAttributeRules();

  const manual = new Set(
    (getDb().prepare(
      `SELECT code || '|' || lang || '|' || field AS key FROM ptrans_fields WHERE manual = 1`
    ).all() as any[]).map(r => r.key)
  );

  let written = 0;
  let skipped = 0;
  for (const code of codes) {
    for (const lang of all) {
      const attrs = attributesFor(code, lang, rules);
      for (const field of ['google_color', 'google_gender', 'google_age',
        'google_condition', 'google_bundle', 'google_identifier'] as const) {
        const value = attrs[field];
        if (!value) { skipped++; continue; }
        if (!force && manual.has(`${code}|${lang}|${field}`)) { skipped++; continue; }
        saveTranslation(code, lang, field, value, 'pravidla');
        written++;
      }
    }
  }
  return { written, skipped };
}

/**
 * Napíše titulky a popisy modelem pro vybrané produkty.
 *
 * Běží po jednom, protože každé volání je krátké a paralelně by se snadno
 * narazilo na limit API; hromadné psaní pro tisíce produktů má jít přes
 * šablonu, ne přes tohle.
 */
export async function writeGoogleTexts(codes: string[], langs: string[],
  kinds: ('google_title' | 'google_desc')[],
  onProgress?: (done: number, total: number, label: string) => boolean | void
): Promise<{ written: number; failed: number; errors: string[] }> {
  const total = codes.length * langs.length * kinds.length;
  const errors: string[] = [];
  let written = 0;
  let failed = 0;
  let done = 0;

  for (const code of codes) {
    for (const lang of langs) {
      for (const kind of kinds) {
        const stop = onProgress?.(done, total, `${code} → ${lang.toUpperCase()}`);
        if (stop === false) return { written, failed, errors };
        try {
          const value = await writeGoogleText(code, lang, kind);
          if (value) written++; else failed++;
        } catch (e: any) {
          failed++;
          if (errors.length < 20) errors.push(`${code}/${lang}: ${e.message}`);
        }
        done++;
      }
    }
  }
  onProgress?.(done, total, '');
  return { written, failed, errors };
}

/** Přehled atributů pro kartu produktu — co je vyplněné a odkud to je. */
export interface GoogleView {
  lang: string;
  fields: {
    field: GoogleField;
    label: string;
    value: string;
    /** Co je právě teď ve feedu */
    feed: string;
    /** Co by aplikace zapsala */
    suggested: string;
    manual: boolean;
  }[];
  bundleReason: string;
  bundleLearned: boolean;
}

export function googleView(code: string, langs?: string[]): GoogleView[] {
  const s = getPtransSettings();
  const list = langs?.length ? langs : [s.sourceLang, ...targetLangs(s)];
  const template = s.googleTitle;

  return list.map(lang => {
    const rows = productFields(code, [lang]);
    const attrs = attributesFor(code, lang);
    const fields = (Object.keys(GOOGLE_LABELS) as GoogleField[]).map(field => {
      const row = rows.find(f => f.field === field);
      const suggested = field === 'google_title'
        ? (template[lang] ? renderTemplate(template[lang], { code, lang }) : '')
        : field === 'google_desc' ? '' : (attrs as any)[field] ?? '';
      return {
        field,
        label: GOOGLE_LABELS[field],
        value: row?.translated || row?.value || '',
        feed: row?.value ?? '',
        suggested,
        manual: !!row?.manual
      };
    });
    return { lang, fields, bundleReason: attrs.bundleReason, bundleLearned: attrs.bundleLearned };
  });
}
