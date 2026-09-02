/**
 * Zkratky dopravy a plateb.
 *
 * V seznamu pošty na telefonu je na odznak u zprávy místo asi pro dvacet
 * znaků. „Zásilkovna – výdejní místo" se tam nevejde ani zdaleka, a i kdyby,
 * není to to, co se z něj čte: při ranním pohledu na poštu jde o to, jestli
 * jde balík na výdejnu nebo domů a jestli je zaplaceno, nebo se bude vybírat
 * dobírka. Na to stačí dvě slova.
 *
 * ## Proč slovník, a ne automatické zkracování
 *
 * Názvy dopravy si e-shop pojmenovává sám a mění se: „Zásilkovna", pak
 * „Zásilkovna - na výdejní místo", pak „Packeta CZ". Zkracovat je pravidlem
 * (první slovo, iniciály) dopadne u jednoho dobře a u druhého nesmyslně —
 * z „Platba kartou online" by bylo „Platba", což neříká nic. Proto se
 * nabídnou **hodnoty, které doopravdy jsou ve feedu**, a ke každé se dá
 * napsat zkratka, jakou má člověk v hlavě.
 *
 * Než někdo něco napíše, platí odhad: nejdřív se zkusí najít známé slovo
 * (dobírka, kartou, Zásilkovna, PPL…), a když ani to ne, vezme se první
 * slovo názvu. Aplikace tak dává smysl hned po nasazení a slovník je na
 * doladění, ne na vyplňování.
 */
import { getDb, getSetting, setSetting } from './db';

const KEY = 'orderShorthand';

export type ShorthandKind = 'shipment' | 'payment';

export interface ShorthandRow {
  kind: ShorthandKind;
  /** Název tak, jak přišel z feedu */
  name: string;
  /** Zkratka do odznaku; prázdné = platí odhad */
  short: string;
  /** Odhad, který platí bez zadané zkratky — aby bylo v nastavení vidět, co se ukáže */
  guess: string;
  /** U kolika objednávek se to vyskytlo — nejčastější patří nahoru */
  count: number;
}

/**
 * Slova, podle kterých se pozná, o co jde.
 *
 * Není to seznam dopravců, ale seznam **rozlišujících slov**: e-shop název
 * kdykoli přejmenuje, ale „dobírka" v něm zůstane dobírkou. Hledá se první
 * shoda, takže na pořadí záleží — „kartou" musí být dřív než „online",
 * protože „Platba kartou online" je karta, ne cosi online.
 */
const KNOWN: { match: RegExp; short: string }[] = [
  // Doprava
  { match: /zásilkov|zasilkov|packeta/i, short: 'Zásilkovna' },
  { match: /balíkovn|balikovn/i, short: 'Balíkovna' },
  { match: /česk[áa]\s*pošt|ceska\s*post/i, short: 'ČP' },
  { match: /\bppl\b/i, short: 'PPL' },
  { match: /\bdpd\b/i, short: 'DPD' },
  { match: /\bgls\b/i, short: 'GLS' },
  { match: /\bdhl\b/i, short: 'DHL' },
  { match: /\bups\b/i, short: 'UPS' },
  { match: /\bwedo\b/i, short: 'WeDo' },
  { match: /osobn[íi]\s*odb[ěe]r|vyzvednut[íi]|na\s*prodejn/i, short: 'Osobně' },
  { match: /výdejn|vydejn|pickup|point/i, short: 'Výdejna' },
  { match: /kur[ýy]r|dom[ůu]|na\s*adresu/i, short: 'Kurýr' },
  // Platba
  { match: /dob[íi]rk/i, short: 'Dobírka' },
  { match: /kart(ou|a|y)|card|comgate|gopay|stripe/i, short: 'Karta' },
  { match: /převod|prevod|bankov|transfer|qr\s*platb/i, short: 'Převod' },
  { match: /hotov|cash/i, short: 'Hotově' },
  { match: /paypal/i, short: 'PayPal' },
  { match: /apple\s*pay/i, short: 'Apple Pay' },
  { match: /google\s*pay/i, short: 'Google Pay' },
  { match: /zdarma|free/i, short: 'Zdarma' }
];

/**
 * Odhad zkratky, dokud není v slovníku.
 *
 * Nejdřív známé slovo. Když žádné nesedí, vezme se první slovo názvu — je to
 * slabší, ale pořád lepší než celý název přes půl obrazovky, a v nastavení je
 * ten odhad vidět, takže se dá opravit.
 */
export function guessShort(name: string): string {
  const text = (name ?? '').trim();
  if (!text) return '';
  for (const one of KNOWN) if (one.match.test(text)) return one.short;

  // Závorky a to za pomlčkou je upřesnění, ne jméno — „Zásilkovna (CZ)"
  const head = text.split(/[(–—-]/)[0].trim();
  const first = head.split(/\s+/)[0] ?? head;
  return first.length > 12 ? `${first.slice(0, 11)}…` : first;
}

function saved(): Record<string, string> {
  try {
    const raw = JSON.parse(getSetting(KEY, '{}') || '{}');
    return raw && typeof raw === 'object' ? raw as Record<string, string> : {};
  } catch {
    return {};
  }
}

/** Klíč do slovníku — druh a název, ať se „Zdarma" u dopravy neplete s platbou. */
function keyOf(kind: ShorthandKind, name: string): string {
  return `${kind}:${(name ?? '').trim().toLowerCase()}`;
}

/** Co se ukáže na odznaku. */
export function shortFor(kind: ShorthandKind, name: string | null | undefined): string {
  const text = (name ?? '').trim();
  if (!text) return '';
  const mine = saved()[keyOf(kind, text)];
  return (mine ?? '').trim() || guessShort(text);
}

/**
 * Co všechno se ve feedu vyskytlo — podklad pro nastavení.
 *
 * Nabízí se jen to, co v objednávkách doopravdy je. Vypisovat seznam všeho,
 * co e-shop umí nabídnout, by znamenalo dvacet řádků, ze kterých se používají
 * tři.
 */
export function shorthandRows(): ShorthandRow[] {
  const d = getDb();
  const mine = saved();
  const out: ShorthandRow[] = [];

  for (const kind of ['shipment', 'payment'] as ShorthandKind[]) {
    const rows = d.prepare(
      `SELECT ${kind} AS name, COUNT(*) AS cnt FROM shop_orders
        WHERE ${kind} != '' GROUP BY ${kind} ORDER BY cnt DESC, name`
    ).all() as any[];
    for (const row of rows) {
      const name = String(row.name ?? '');
      out.push({
        kind,
        name,
        short: (mine[keyOf(kind, name)] ?? '').trim(),
        guess: guessShort(name),
        count: Number(row.cnt ?? 0)
      });
    }
  }
  return out;
}

/** Uloží zkratku; prázdná ji ze slovníku vyhodí a vrátí se k odhadu. */
export function saveShorthand(kind: ShorthandKind, name: string, short: string): ShorthandRow[] {
  const mine = saved();
  const key = keyOf(kind, name);
  const value = (short ?? '').trim();
  if (value) mine[key] = value; else delete mine[key];
  setSetting(KEY, JSON.stringify(mine));
  return shorthandRows();
}
