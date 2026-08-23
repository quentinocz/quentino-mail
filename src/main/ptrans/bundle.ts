import { getDb } from '../db';
import { getPtransSettings } from './store';
import { plain } from './detect';
import { normalize } from './colors';

/**
 * Rozpoznání setů (`is_bundle_google_merchant`).
 *
 * Google chce vědět, jestli je nabídka **set několika výrobků prodávaný za
 * jednu cenu**. U Quentina to je motýlek s kapesníčkem nebo set pro tátu a
 * syna; naopak kšandy s motýlkem nemusí být set, pokud jde o jeden výrobek
 * ve dvou kusech příslušenství. Kde je hranice, ví jenom on — proto se to
 * **neurčuje natvrdo, ale učí**.
 *
 * Postup: pravidla dají návrh a spolu s ním důvod, proč tak rozhodla.
 * Když člověk návrh otočí, uloží se to jako pravidlo pro **kategorii a tvar
 * názvu**, ne jen pro ten jeden produkt — takže se stejné sety příště označí
 * správně samy. Naučené pravidlo má vždycky přednost před tím zabudovaným.
 */

/** Slova, po kterých je v názvu skoro jistě set. */
const STRONG = ['set', 'sada', 'souprava', 'balicek', 'duo', 'trio', 'kit', 'bundle'];

/** Slova, která set naznačují až ve spojení s druhým výrobkem. */
const JOINERS = ['a', 's', 'se', 'and', 'with', '+', '&'];

/**
 * Druhy výrobků, seskupené podle toho, co to ve skutečnosti je.
 *
 * Seskupení je podstatné: „manžetové knoflíčky" jsou **jeden** výrobek psaný
 * dvěma slovy, ne dva. A tvary se vypisují celé, protože se porovnávají jako
 * **celá slova**. První verze hledala podřetězce a označila „paisley" za šle
 * („…sle…") — takový set pak vznikl skoro u každé kravaty se vzorem.
 *
 * Ze stejného důvodu tu nejsou množná čísla v 7. pádě („květinkami"): to už
 * není výrobek, ale výšivka. Tvar „květinka" naopak výrobek je.
 */
const KINDS: { id: string; words: string[] }[] = [
  { id: 'kravata', words: ['kravata', 'kravatu', 'kravatou', 'kravaty', 'necktie', 'tie'] },
  { id: 'motylek', words: ['motylek', 'motylka', 'motylkem', 'motylik', 'motylikom', 'bow'] },
  { id: 'ksandy', words: ['ksandy', 'ksandami', 'sle', 'slemi', 'traky', 'trakmi', 'suspenders', 'braces'] },
  { id: 'kapesnicek', words: ['kapesnicek', 'kapesnickem', 'kapesnik', 'vreckovka', 'vreckovkou'] },
  { id: 'ponozky', words: ['ponozky', 'ponozkami', 'socks'] },
  { id: 'knofliky', words: ['knoflicky', 'knoflickami', 'knofliky', 'cufflinks'] },
  { id: 'kvetinka', words: ['kvetinka', 'kvetinkou', 'boutonniere'] },
  { id: 'spona', words: ['spona', 'sponou', 'clip'] },
  { id: 'stuha', words: ['stuha', 'stuhou'] }
];

export interface BundleRule {
  /** Kategorie, které se pravidlo týká; prázdné = všechny */
  category: string;
  /** Tvar názvu — slova, která musí být v názvu obsažena */
  pattern: string;
  isBundle: boolean;
  hits: number;
  updatedAt: string | null;
}

export interface BundleVerdict {
  isBundle: boolean;
  /** Proč — do rozhraní, ať je vidět, na základě čeho se to rozhodlo */
  reason: string;
  /** Rozhodlo naučené pravidlo, ne zabudovaná úvaha */
  learned: boolean;
}

/* ---------- naučená pravidla ---------- */

export function listBundleRules(): BundleRule[] {
  return getDb().prepare(
    `SELECT category, pattern, is_bundle AS isBundle, hits, updated_at AS updatedAt
     FROM ptrans_bundles ORDER BY hits DESC, category, pattern LIMIT 300`
  ).all().map((row: any) => ({ ...row, isBundle: !!row.isBundle })) as BundleRule[];
}

export function saveBundleRule(category: string, pattern: string, isBundle: boolean): void {
  const key = normalize(pattern);
  if (!key) return;
  getDb().prepare(
    `INSERT INTO ptrans_bundles (category, pattern, is_bundle, hits, updated_at)
     VALUES (?,?,?,1,?)
     ON CONFLICT(category, pattern) DO UPDATE SET
       is_bundle = excluded.is_bundle, hits = ptrans_bundles.hits + 1,
       updated_at = excluded.updated_at`
  ).run(category ?? '', key, isBundle ? 1 : 0, new Date().toISOString());
}

export function deleteBundleRule(category: string, pattern: string): void {
  getDb().prepare('DELETE FROM ptrans_bundles WHERE category = ? AND pattern = ?')
    .run(category ?? '', normalize(pattern));
}

/**
 * Tvar názvu, na který se pravidlo váže.
 *
 * Z názvu zbudou jen druhy výrobků a spojovací slova — barva, materiál ani
 * značka o tom, jestli je něco set, nevypovídají. „Bordó set motýlka a
 * kapesníčku" i „Modrý set motýlka a kapesníčku" tak dají stejný tvar a
 * jedno rozhodnutí pokryje obojí.
 */
export function bundlePattern(title: string): string {
  const words = normalize(title).split(' ');
  const out: string[] = [];
  for (const word of words) {
    if (STRONG.includes(word) && !out.includes(word)) { out.push(word); continue; }
    // Druh se zapisuje pod svým skupinovým názvem, aby „motýlek" i „motýlkem"
    // daly stejný tvar — jinak by se každý pád učil zvlášť
    const kind = KINDS.find(item => item.words.includes(word));
    if (kind && !out.includes(kind.id)) out.push(kind.id);
  }
  return out.join(' ');
}

function learnedFor(category: string, title: string): boolean | null {
  const pattern = bundlePattern(title);
  if (!pattern) return null;
  const d = getDb();
  // Pravidlo pro konkrétní kategorii má přednost před obecným
  const row = d.prepare(
    `SELECT is_bundle FROM ptrans_bundles WHERE pattern = ? AND category IN (?, '')
     ORDER BY CASE WHEN category = '' THEN 1 ELSE 0 END LIMIT 1`
  ).get(pattern, category ?? '') as any;
  return row ? !!row.is_bundle : null;
}

/* ---------- rozpoznávání ---------- */

/**
 * Které druhy výrobku jsou v názvu zmíněné a na jaké pozici.
 *
 * Porovnává se po celých slovech. Podřetězec by našel „šle" uvnitř
 * „paisley" a udělal set z každé vzorované kravaty.
 */
function kindsIn(title: string): { id: string; at: number }[] {
  const words = normalize(title).split(' ');
  const found: { id: string; at: number }[] = [];
  words.forEach((word, index) => {
    const kind = KINDS.find(item => item.words.includes(word));
    if (kind && !found.some(f => f.id === kind.id)) found.push({ id: kind.id, at: index });
  });
  return found;
}

export function detectBundle(code: string): BundleVerdict {
  const s = getPtransSettings();
  const row = getDb().prepare(
    'SELECT title, category, categories FROM ptrans_products WHERE code = ?'
  ).get(code) as any;
  if (!row) return { isBundle: false, reason: 'produkt není v databázi', learned: false };

  const title = plain(row.title ?? '');
  const category = row.category ?? '';

  const learned = learnedFor(category, title);
  if (learned !== null) {
    return {
      isBundle: learned,
      reason: learned
        ? 'naučené pravidlo pro tenhle tvar názvu říká: set'
        : 'naučené pravidlo pro tenhle tvar názvu říká: není set',
      learned: true
    };
  }

  const key = normalize(title);
  const strong = STRONG.find(word => key.split(' ').includes(word));
  if (strong) return { isBundle: true, reason: `název obsahuje „${strong}"`, learned: false };

  const categories = normalize(`${category} ${row.categories ?? ''}`);
  if (STRONG.some(word => categories.split(' ').includes(word))) {
    return { isBundle: true, reason: 'produkt je v kategorii setů', learned: false };
  }

  const kinds = kindsIn(title);
  if (kinds.length >= 2) {
    // Spojka musí stát **mezi** oběma výrobky. „Motýlek s kapesníčkem" je set,
    // „motýlek s vyšitými květinkami" ne — a poznat se to dá jen podle toho,
    // co je mezi nimi, ne podle toho, že spojka někde v názvu je.
    const words = normalize(title).split(' ');
    const [first, second] = kinds.slice(0, 2);
    const between = words.slice(first.at + 1, second.at);
    if (between.some(word => JOINERS.includes(word))) {
      return {
        isBundle: true,
        reason: `název spojuje dva výrobky (${first.id} + ${second.id})`,
        learned: false
      };
    }
  }

  return { isBundle: false, reason: 'jeden výrobek', learned: false };
}

/**
 * Ruční otočení rozhodnutí.
 *
 * Kromě uložení hodnoty u produktu se rozhodnutí zapíše i jako pravidlo, aby
 * se stejné sety příště označily samy. Tohle je ta část, kvůli které se to
 * vůbec učí — jednorázová oprava jednoho produktu by nikomu nepomohla.
 */
export function teachBundle(code: string, isBundle: boolean): BundleRule | null {
  const row = getDb().prepare('SELECT title, category FROM ptrans_products WHERE code = ?')
    .get(code) as any;
  if (!row) return null;

  const pattern = bundlePattern(plain(row.title ?? ''));
  if (!pattern) return null;

  saveBundleRule(row.category ?? '', pattern, isBundle);
  return {
    category: row.category ?? '',
    pattern,
    isBundle,
    hits: 1,
    updatedAt: new Date().toISOString()
  };
}

/** Kolik produktů by se právě teď označilo jako set — přehled před zápisem. */
export function bundlePreview(): { total: number; bundles: number; samples: { code: string; title: string; reason: string }[] } {
  const rows = getDb().prepare(
    'SELECT code, title FROM ptrans_products WHERE active = 1 AND archived = 0'
  ).all() as any[];

  const samples: { code: string; title: string; reason: string }[] = [];
  let bundles = 0;
  for (const row of rows) {
    const verdict = detectBundle(row.code);
    if (!verdict.isBundle) continue;
    bundles++;
    if (samples.length < 30) samples.push({ code: row.code, title: row.title, reason: verdict.reason });
  }
  return { total: rows.length, bundles, samples };
}
