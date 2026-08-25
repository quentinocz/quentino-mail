import { getDb } from '../db';
import { getPtransSettings } from './store';
import { plain, textLength } from './detect';

/**
 * Jak se v daném jazyce píše.
 *
 * Pravidla pro Google titulek se původně psala jednou pro všechny jazyky a
 * obsahovala pokyn „Piš Velkými Počátečními Písmeny". To je anglický zvyk.
 * V češtině z toho vycházely paskvily typu
 *
 *     Stuha Dámská Barevná Květovaný Quentino
 *
 * kde je špatně skoro všechno: velká písmena uprostřed věty, slovosled po
 * kouscích a přívlastek v jiném rodě než podstatné jméno („květovaný" ke
 * „stuze"). Správně má vyjít
 *
 *     Dámská stuha barevná s květy Quentino
 *
 * Tenhle modul proto drží pravidla **po jazycích**: jak se píšou velká
 * písmena, jak se skládá jmenná fráze a co se hlídá po vygenerování.
 *
 * Druhá polovina je učení. Nejsilnější pokyn není popis, ale ukázka — a těch
 * je ve feedu přes tisíc. Názvy produktů, které Quentino roky používá, jsou
 * v každém jazyce gramaticky správné a psané jednotně; stačí je modelu
 * ukázat ze stejné kategorie a rejstřík si drží sám.
 */

/* ---------- velká písmena ---------- */

/**
 * `sentence` — velké jen první slovo a vlastní jména (čeština, slovenština).
 * `title`    — Velká Písmena U Významových Slov (angličtina).
 * `nouns`    — velká u podstatných jmen, jak to němčina má i v běžném textu.
 */
export type CaseStyle = 'sentence' | 'title' | 'nouns';

const CASE_BY_LANG: Record<string, CaseStyle> = {
  cz: 'sentence', cs: 'sentence', sk: 'sentence', pl: 'sentence',
  hu: 'sentence', ro: 'sentence', sl: 'sentence', hr: 'sentence',
  en: 'title',
  de: 'nouns'
};

export function caseStyleFor(lang: string): CaseStyle {
  return CASE_BY_LANG[lang.toLowerCase()] ?? 'sentence';
}

/** Jazyky, kde přívlastek mění tvar podle rodu a čísla — tam se hlídá shoda. */
const INFLECTED = new Set(['cz', 'cs', 'sk', 'pl', 'ru', 'uk', 'sl', 'hr']);

export function isInflected(lang: string): boolean {
  return INFLECTED.has(lang.toLowerCase());
}

/* ---------- pravidla do promptu ---------- */

const CASE_RULES: Record<CaseStyle, string[]> = {
  sentence: [
    'VELKÁ PÍSMENA: velké je jen první slovo a vlastní jména (značka, název kolekce).',
    'NEPIŠ Každé Slovo S Velkým Písmenem — to je anglický zvyk a v tomhle jazyce to vypadá jako chyba.'
  ],
  title: [
    'CAPITALISATION: Title Case — capitalise the first letter of every significant word.',
    'Keep articles, short prepositions and conjunctions lower case unless they start the title.'
  ],
  nouns: [
    'GROSSSCHREIBUNG: Substantive groß, wie es die Rechtschreibung verlangt — nicht jedes Wort.',
    'Zusammengesetzte Wörter zusammenschreiben, nicht mit Bindestrich auseinanderreißen.'
  ]
};

/**
 * Skladba titulku pro Google Nákupy.
 *
 * Pořadí odpovídá auditu feedu od AdsOne i tomu, co doporučuje Merchant
 * Center: typ výrobku první (zákazník hledá „stuha", ne „barevná"), značka
 * poslední. Novinka je, že to není seznam slotů k mechanickému slepení —
 * u jazyků se skloňováním se výslovně žádá souvislá jmenná fráze se
 * správnou shodou. Bez toho vzniká „Stuha Dámská Barevná Květovaný".
 *
 * Délka cílí na viditelných 70 znaků; technický limit 150 je k ničemu,
 * protože co je za sedmdesátkou, v inzerátu nikdo neuvidí.
 */
export function titleRules(lang: string, limit: number): string {
  const style = caseStyleFor(lang);
  const lines = [
    `Napiš název produktu pro Google Nákupy. Cíl je do ${limit} znaků — víc Google v inzerátu nezobrazí.`,
    '',
    'CO MÁ NÁZEV OBSAHOVAT, V TOMHLE POŘADÍ:',
    '1. Typ produktu i s určujícím přívlastkem („dámská stuha", „pánské kšandy", „dětská kravata") — na začátku',
    '2. Barva — tím odstínem, jaký produkt opravdu má',
    '3. Vzor nebo rozlišující detail',
    '4. Značka na konci',
    '5. Velikost nebo počet kusů, jen když produkt rozlišují',
    ''
  ];

  if (isInflected(lang)) {
    lines.push(
      'MUSÍ TO BÝT SOUVISLÁ JMENNÁ FRÁZE, NE SEZNAM SLOV:',
      '- Přídavná jména se shodují s podstatným jménem v rodě, čísle a pádě.',
      '  „stuha barevná" (ženský rod), ne „stuha barevný"; „kšandy úzké", ne „kšandy úzký".',
      '- Předložkové vazby zůstávají celé a nerozdělují se („s květy", „do saka").',
      '- Když se přívlastek za podstatné jméno gramaticky nehodí, dej ho před něj',
      '  („dámská stuha"), ne aby vzniklo nečeské spojení.',
      '- Název musí jít přečíst nahlas jako běžné slovní spojení. Když to drhne, přepiš to.',
      ''
    );
  }

  lines.push(...CASE_RULES[style], '');
  lines.push(
    'U dětských produktů musí slovo „dětský/dětská" zůstat u typu produktu.',
    'U setu vypiš, co zákazník dostane („set kravata + dětská kravata"), ne marketingový obrat.',
    '',
    'Zakázáno: barva na prvním místě, marketingové obraty, kterými nikdo nehledá',
    '(„pro tátu a syna", „pro každou příležitost"), celá slova velkými písmeny, vykřičníky,',
    '„nejlepší", „akce", „sleva", cena, doprava, dostupnost a text v závorkách.',
    'Nevymýšlej vlastnosti, které nejsou v podkladech.'
  );
  return lines.join('\n');
}

export function descRules(lang: string, limit: number): string {
  const lines = [
    `Napiš popis produktu pro Google Nákupy. Nejvýš ${limit} znaků, čistý text bez HTML a bez odrážek.`,
    'První věta říká, co produkt je a pro koho — ta se zobrazuje nejčastěji.',
    'Dál materiál, rozměry, provedení, k jaké příležitosti se hodí a jak se o něj starat.',
    'Barvu piš tím odstínem, jakým produkt opravdu je („hořčicově žlutá"), ne obecnou barvou.',
    'Piš souvislé věty, ne výčet klíčových slov.'
  ];
  if (isInflected(lang)) {
    lines.push('Hlídej si shodu přívlastků s podstatnými jmény a správné pády — text musí být bez chyb.');
  }
  lines.push(
    'Zakázáno: cena, doprava, slevy, odkazy, informace o dostupnosti, srovnání s konkurencí,',
    'velká písmena přes celé slovo a text typu „klikněte zde".'
  );
  return lines.join('\n');
}

/**
 * Krátká jazyková poznámka pro texty, které nemají vlastní skladbu.
 *
 * SEO titulek a popis nejsou stavěné po slotech jako titulek pro Google,
 * ale narazí na stejnou past: model umí sklouznout do anglického psaní
 * velkých písmen a do doslovných obratů. Tohle je to nutné minimum, které
 * se přidá ke každému pokynu.
 */
export function languageNote(lang: string): string {
  const lines = [...CASE_RULES[caseStyleFor(lang)]];
  if (isInflected(lang)) {
    lines.push('Hlídej shodu přívlastků s podstatnými jmény a správné pády — text musí být bez chyb.',
      'Piš přirozeně, ne doslovným převodem z jiného jazyka.');
  }
  return lines.join('\n');
}

/* ---------- ukázky z feedu ---------- */

/**
 * Skutečné názvy produktů ze stejné kategorie a jazyka.
 *
 * Popsat slovosled je těžké, ukázat ho snadné. Sáhne se proto do feedu pro
 * názvy, které v e-shopu roky fungují — jsou psané jednotně a gramaticky
 * správně, takže model dostane přesně ten rejstřík, do kterého má trefit.
 *
 * Vynechávají se názvy tak krátké, že z nich není poznat tvar, a příliš
 * dlouhé, které by ho zkreslily. Bere se prostřední pásmo.
 */
export function feedExamples(lang: string, category: string, count = 4): string[] {
  if (!category) return [];
  const d = getDb();
  const s = getPtransSettings();

  const rows = lang === s.sourceLang
    ? d.prepare(
      `SELECT title AS value FROM ptrans_products
       WHERE category = ? AND title <> '' AND archived = 0 LIMIT 120`
    ).all(category) as { value: string }[]
    : d.prepare(
      // Vlastní překlad má přednost, ale když ještě žádný není, poslouží
      // to, co v jazykové mutaci je už dnes ve feedu — a to je většina
      `SELECT COALESCE(NULLIF(f.translated, ''), f.value) AS value FROM ptrans_fields f
       JOIN ptrans_products p ON p.code = f.code
       WHERE p.category = ? AND f.lang = ? AND f.field = 'title'
         AND COALESCE(NULLIF(f.translated, ''), f.value) <> '' LIMIT 120`
    ).all(category, lang) as { value: string }[];

  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of rows) {
    const value = plain(row.value).trim();
    if (value.length < 12 || value.length > 90) continue;
    // Ať ukázky nejsou čtyřikrát totéž s jinou barvou — liší se první slovo
    const key = value.toLowerCase().split(' ').slice(1).join(' ');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= count) break;
  }
  return out;
}

/** Blok s ukázkami do promptu — z feedu i z toho, co si uživatel vybral. */
export function styleHint(lang: string, category: string, kind: string): string {
  const learned = learnedStyle(lang, category, kind);
  const examples = feedExamples(lang, category);
  if (!learned && examples.length === 0) return '';

  const lines: string[] = [''];
  if (examples.length) {
    lines.push(`Takhle se u nás jmenují produkty v kategorii „${category}" — drž stejný rejstřík,`,
      'slovosled i způsob psaní velkých písmen:');
    for (const example of examples) lines.push(`    ${example}`);
  }
  if (learned) {
    lines.push('', 'Uživatel si pro tuhle kategorii vybral tenhle tvar — piš stejně:',
      `    ${learned.example}`);
    if (learned.rejected) lines.push(`  (a odmítl tvar: ${learned.rejected})`);
  }
  return lines.join('\n');
}

/* ---------- co si uživatel vybral ---------- */

export interface LearnedStyle {
  lang: string;
  category: string;
  kind: string;
  example: string;
  rejected: string;
  hits: number;
  updatedAt: string;
}

export function learnedStyle(lang: string, category: string, kind: string): LearnedStyle | null {
  if (!category) return null;
  const row = getDb().prepare(
    'SELECT * FROM ptrans_style WHERE lang = ? AND category = ? AND kind = ?'
  ).get(lang, category, kind) as any;
  if (!row?.example) return null;
  return {
    lang: row.lang, category: row.category, kind: row.kind,
    example: row.example, rejected: row.rejected ?? '',
    hits: row.hits ?? 1, updatedAt: row.updated_at ?? ''
  };
}

export function saveStyle(entry: { lang: string; category: string; kind: string; example: string; rejected?: string }): void {
  getDb().prepare(
    `INSERT INTO ptrans_style (lang, category, kind, example, rejected, hits, updated_at)
     VALUES (?,?,?,?,?,1,?)
     ON CONFLICT(lang, category, kind) DO UPDATE SET
       example = excluded.example, rejected = excluded.rejected,
       hits = ptrans_style.hits + 1, updated_at = excluded.updated_at`
  ).run(entry.lang, entry.category, entry.kind, entry.example.trim(),
    (entry.rejected ?? '').trim(), new Date().toISOString());
}

export function listStyles(lang?: string): LearnedStyle[] {
  const rows = lang && lang !== 'all'
    ? getDb().prepare('SELECT * FROM ptrans_style WHERE lang = ? ORDER BY category').all(lang) as any[]
    : getDb().prepare('SELECT * FROM ptrans_style ORDER BY lang, category').all() as any[];
  return rows.map(row => ({
    lang: row.lang, category: row.category, kind: row.kind,
    example: row.example, rejected: row.rejected ?? '',
    hits: row.hits ?? 1, updatedAt: row.updated_at ?? ''
  }));
}

export function forgetStyle(lang: string, category: string, kind: string): void {
  getDb().prepare('DELETE FROM ptrans_style WHERE lang = ? AND category = ? AND kind = ?')
    .run(lang, category, kind);
}

/* ---------- kontrola hotového textu ---------- */

const MARKETING = [
  'nejlepší', 'akce', 'sleva', 'výprodej', 'zdarma', 'skvěl', 'ideální dárek',
  'pro každou příležitost', 'pro tátu a syna', 'must have', 'best', 'sale', 'free shipping'
];

/** Slova, u kterých velké písmeno uprostřed názvu nic neznamená. */
function properNoun(word: string, brand: string): boolean {
  const clean = word.replace(/[^\p{L}\p{N}]/gu, '');
  if (!clean) return true;
  if (brand && clean.toLowerCase() === brand.toLowerCase()) return true;
  // Zkratky a kódy velikostí („XL", „EU42") nejsou překlep
  return /^[A-Z0-9]+$/.test(clean) && clean.length <= 4;
}

export interface TextProblem {
  /** Krátký kód pro strojové zpracování */
  code: string;
  /** Věta pro člověka i pro model při opravném průchodu */
  message: string;
}

/**
 * Co je na hotovém textu vidět jako chyba.
 *
 * Kontroluje se jen to, co jde poznat spolehlivě — velká písmena, délka,
 * zakázané obraty, useknuté slovo, zdvojení. Gramatickou shodu tudy hlídat
 * nejde; tu řeší pravidla a ukázky. Zato falešný poplach je horší než
 * chybějící nález, protože by pak text zbytečně přepisoval.
 */
export function checkText(value: string, options: {
  lang: string;
  kind: 'google_title' | 'google_desc';
  limit: number;
  brand?: string;
}): TextProblem[] {
  const out: TextProblem[] = [];
  const text = plain(value).trim();
  if (!text) return [{ code: 'empty', message: 'Text je prázdný.' }];

  // Počítá se po znacích, jak je vidí člověk — emodži je jeden znak, ne dva
  const length = textLength(text);
  if (length > options.limit) {
    out.push({
      code: 'long',
      message: `Je to ${length} znaků, vejít se musí do ${options.limit}.`
    });
  }

  for (const phrase of MARKETING) {
    if (text.toLowerCase().includes(phrase)) {
      out.push({ code: 'marketing', message: `Obsahuje zakázaný obrat „${phrase}".` });
      break;
    }
  }

  if (/\b\p{Lu}{3,}\b/u.test(text.replace(/\b[A-Z0-9]{1,4}\b/g, ''))) {
    out.push({ code: 'caps', message: 'Nějaké slovo je celé velkými písmeny.' });
  }

  // Zdvojené slovo hned za sebou — typický pozůstatek po slepování slotů
  const words = text.split(/\s+/);
  for (let i = 1; i < words.length; i++) {
    if (words[i].length > 2 && words[i].toLowerCase() === words[i - 1].toLowerCase()) {
      out.push({ code: 'repeat', message: `Slovo „${words[i]}" je tam dvakrát za sebou.` });
      break;
    }
  }

  if (options.kind === 'google_title') {
    const style = caseStyleFor(options.lang);
    if (style === 'sentence') {
      // Velká písmena uprostřed názvu: v češtině je to nejčastější chyba
      const shouty = words.slice(1)
        .filter(word => /^\p{Lu}/u.test(word) && !properNoun(word, options.brand ?? ''));
      if (shouty.length >= 2) {
        out.push({
          code: 'titlecase',
          message: `Slova uprostřed názvu mají velké písmeno (${shouty.slice(0, 3).join(', ')}). `
            + 'V tomhle jazyce se velké píše jen první slovo a vlastní jména.'
        });
      }
    }
    if (/[.!?]$/.test(text)) {
      out.push({ code: 'punctuation', message: 'Název nekončí tečkou ani vykřičníkem.' });
    }
    if (options.brand && !text.toLowerCase().includes(options.brand.toLowerCase())) {
      out.push({ code: 'brand', message: `Chybí značka „${options.brand}" na konci.` });
    }
  }

  return out;
}

/** Pokyn pro opravný průchod — modelu se řekne, co konkrétně přepsat. */
export function fixHint(problems: TextProblem[]): string {
  return ['Předchozí pokus měl tyhle chyby — oprav je a vrať text znovu:',
    ...problems.map(problem => `- ${problem.message}`)].join('\n');
}
