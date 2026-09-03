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

/**
 * Uložený slovník.
 *
 * U každého záznamu se drží i **název tak, jak ho někdo napsal**. Klíč je
 * kvůli porovnávání malými písmeny, takže sám o sobě by z „Balíkovna" udělal
 * „balíkovna" — a přesně tak by se to pak ukazovalo v nastavení. Starší
 * zápisy jsou holý text a čtou se dál.
 */
interface SavedEntry { name: string; short: string }

function saved(): Record<string, SavedEntry> {
  let raw: any = null;
  try { raw = JSON.parse(getSetting(KEY, '{}') || '{}'); } catch { return {}; }
  if (!raw || typeof raw !== 'object') return {};

  const out: Record<string, SavedEntry> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') {
      // Starší podoba: jen zkratka, název se odvodí z klíče
      out[key] = { name: key.slice(key.indexOf(':') + 1), short: value };
    } else if (value && typeof value === 'object') {
      const one = value as any;
      out[key] = { name: String(one.name ?? ''), short: String(one.short ?? '') };
    }
  }
  return out;
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
  return (mine?.short ?? '').trim() || guessShort(text);
}

/**
 * Co všechno se vyskytlo — podklad pro nastavení.
 *
 * Sbírá se ze **tří míst**, protože žádné samo o sobě nestačí:
 *
 *  1. feed objednávek (`shop_orders`) — nejspolehlivější, ale sloupce
 *     `shipment` a `payment` se plní teprve od chvíle, kdy se feed stáhl
 *     verzí, která je umí číst; starší řádky je mají prázdné,
 *  2. rozebrané potvrzovací e-maily (`order_cache`) — tam je doprava
 *     a platba tak, jak si ji zákazník vybral,
 *  3. co už je ve slovníku — zkratka napsaná ručně nesmí zmizet jen proto,
 *     že se objednávka mezitím vysypala z feedu.
 *
 * První verze četla jen feed a u prázdných sloupců neukázala vůbec nic —
 * nastavení pak vypadalo pokažené, i když fungovalo přesně tak, jak bylo
 * napsané.
 */
export function shorthandRows(): ShorthandRow[] {
  const mine = saved();
  const counts = new Map<string, { kind: ShorthandKind; name: string; count: number }>();

  const add = (kind: ShorthandKind, raw: unknown, by = 1) => {
    const name = String(raw ?? '').trim();
    if (!name) return;
    const key = keyOf(kind, name);
    const found = counts.get(key);
    if (found) found.count += by;
    else counts.set(key, { kind, name, count: by });
  };

  const d = getDb();

  // 1) Feed objednávek
  for (const kind of ['shipment', 'payment'] as ShorthandKind[]) {
    try {
      const rows = d.prepare(
        `SELECT ${kind} AS name, COUNT(*) AS cnt FROM shop_orders
          WHERE ${kind} IS NOT NULL AND ${kind} != '' GROUP BY ${kind}`
      ).all() as any[];
      for (const row of rows) add(kind, row.name, Number(row.cnt ?? 1));
    } catch { /* starší databáze ten sloupec mít nemusí */ }
  }

  // 2) Rozebrané potvrzovací e-maily
  try {
    const rows = d.prepare(
      'SELECT json FROM order_cache WHERE json IS NOT NULL ORDER BY at DESC LIMIT 500'
    ).all() as any[];
    for (const row of rows) {
      let card: any = null;
      try { card = JSON.parse(row.json); } catch { continue; }
      add('shipment', card?.shipmentName);
      add('payment', card?.paymentName);
    }
  } catch { /* tabulka nemusí být */ }

  // 3) Co je ve slovníku — ručně napsaná zkratka nesmí zmizet
  for (const [key, entry] of Object.entries(mine)) {
    const cut = key.indexOf(':');
    if (cut < 0) continue;
    const kind = key.slice(0, cut) as ShorthandKind;
    if (kind !== 'shipment' && kind !== 'payment') continue;
    // Název z uloženého záznamu, ne z klíče — ten je malými písmeny
    if (!counts.has(key)) {
      counts.set(key, { kind, name: entry.name || key.slice(cut + 1), count: 0 });
    }
  }

  return [...counts.values()]
    .map(one => ({
      kind: one.kind,
      name: one.name,
      short: (mine[keyOf(one.kind, one.name)]?.short ?? '').trim(),
      guess: guessShort(one.name),
      count: one.count
    }))
    .sort((a, b) => (a.kind === b.kind
      ? (b.count - a.count) || a.name.localeCompare(b.name, 'cs')
      : (a.kind === 'shipment' ? -1 : 1)));
}

/**
 * Kolik objednávek se prošlo a kolik z nich dopravu vůbec mělo.
 *
 * Když nabídka zůstane prázdná, tohle je jediné, co řekne proč: jestli
 * nejsou stažené objednávky, nebo jestli je stažené jsou, ale doprava v nich
 * chybí. Bez toho by v nastavení bylo prázdno bez vysvětlení.
 */
export function shorthandScope(): { orders: number; withShipment: number; withPayment: number } {
  const d = getDb();
  const count = (sql: string) => {
    try { return Number((d.prepare(sql).get() as any)?.n ?? 0); } catch { return 0; }
  };
  return {
    orders: count('SELECT COUNT(*) AS n FROM shop_orders'),
    withShipment: count("SELECT COUNT(*) AS n FROM shop_orders WHERE shipment != ''"),
    withPayment: count("SELECT COUNT(*) AS n FROM shop_orders WHERE payment != ''")
  };
}

/**
 * Uloží zkratku; prázdná ji ze slovníku vyhodí a vrátí se k odhadu.
 *
 * Zapsat se dá i k názvu, který zatím v žádné objednávce není — když e-shop
 * dopravu právě zavedl nebo přejmenoval, nemá smysl čekat, až přijde první
 * objednávka.
 */
export function saveShorthand(kind: ShorthandKind, name: string, short: string): ShorthandRow[] {
  const mine = saved();
  const clean = (name ?? '').trim();
  if (!clean) return shorthandRows();

  const key = keyOf(kind, clean);
  const value = (short ?? '').trim();
  /*
   * Prázdná zkratka u názvu, který se nikde jinde nebere, by řádek nechala
   * viset naprázdno — proto se ukládá i sám název, aby se dal ze seznamu
   * zase vyhodit smazáním zkratky.
   */
  if (value) mine[key] = { name: clean, short: value }; else delete mine[key];
  setSetting(KEY, JSON.stringify(mine));
  return shorthandRows();
}
