/**
 * Zkratky dopravy a plateb.
 *
 * V seznamu pošty na telefonu je na odznak u zprávy místo asi pro dvacet
 * znaků. „Zásilkovna – výdejní místo" se tam nevejde ani zdaleka, a i kdyby,
 * není to to, co se z něj čte: při ranním pohledu na poštu jde o to, jestli
 * jde balík na výdejnu nebo domů a jestli je zaplaceno, nebo se bude vybírat
 * dobírka. Na to stačí dvě slova.
 *
 * ## Slovník je po dopravcích, ne po názvech
 *
 * Ve feedu není „Zásilkovna", ale **konkrétní výdejna**: „PPL ParcelBox -
 * ABOX BRN Kounicova (Billa)", „Zásilkovna Výdejní místo - Libuň, Libuň 53,
 * Potraviny", „Balíkovna - Šumperk Sport Start". Takových názvů jsou stovky,
 * jeden na každou pobočku, a vypisovat je do nastavení po jednom by dalo
 * seznam, který nikdo nikdy nevyplní — a hlavně by to bylo zbytečné: na
 * odznaku má stát „PPL", ať je to kterákoli pobočka.
 *
 * Názvy se proto slučují do **rodin** podle rozlišujícího slova (PPL,
 * Zásilkovna, Balíkovna, dobírka, kartou…) a zkratka se píše k rodině.
 * Deset řádků místo tří set.
 *
 * ## Proč slovník, a ne jen automatické zkracování
 *
 * Rodina se pozná sama, ale její jméno nemusí sedět každému do řádku —
 * někdo chce „Zás.", jinému stačí „Z-Box". Proto se dá u každé rodiny
 * zkratka přepsat. Než někdo něco napíše, platí jméno rodiny, takže
 * aplikace dává smysl hned po nasazení a slovník je na doladění, ne na
 * vyplňování.
 */
import { getDb, getSetting, setSetting } from './db';
import type { CodeShorthand } from '../shared/types';

const KEY = 'orderShorthand';

export type ShorthandKind = 'shipment' | 'payment';

export interface ShorthandRow {
  kind: ShorthandKind;
  /**
   * Jméno rodiny — „PPL", „Zásilkovna", „Dobírka".
   *
   * Není to název z feedu; ten je u dopravy jménem konkrétní pobočky a je
   * jich tolik, kolik má dopravce výdejen.
   */
  name: string;
  /** Zkratka do odznaku; prázdné = platí jméno rodiny */
  short: string;
  /** Co se ukáže bez zadané zkratky (= jméno rodiny) */
  guess: string;
  /** U kolika objednávek se rodina vyskytla — nejčastější patří nahoru */
  count: number;
  /** Kolik různých názvů do rodiny spadá — u dopravy to bývají desítky poboček */
  distinct: number;
  /** Pár názvů na ukázku, aby bylo vidět, co se do rodiny slilo */
  samples: string[];
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
  /*
   * Hermes je německá dopravní síť, kterou u nás vozí Packeta — ve feedu je
   * proto „Hermes PaketShop (Packeta)". Patří před Zásilkovnu, jinak by se
   * německé zásilky slily s českými a na odznaku by se nedaly rozeznat.
   */
  { match: /hermes/i, short: 'Hermes' },
  { match: /zásilkov|zasilkov|packeta/i, short: 'Zásilkovna' },
  { match: /balíkovn|balikovn/i, short: 'Balíkovna' },
  { match: /česk[áa]\s*pošt|ceska\s*post/i, short: 'ČP' },
  { match: /\bppl\b/i, short: 'PPL' },
  { match: /\bdpd\b/i, short: 'DPD' },
  { match: /\bgls\b/i, short: 'GLS' },
  { match: /\bdhl\b/i, short: 'DHL' },
  { match: /\bups\b/i, short: 'UPS' },
  { match: /\bwedo\b/i, short: 'WeDo' },
  // Zahraniční sítě, které e-shop nabízí na polský a francouzský trh
  { match: /inpost|paczkomat|poczta/i, short: 'InPost' },
  { match: /mondial/i, short: 'Mondial' },
  { match: /bartolini/i, short: 'Bartolini' },
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

/**
 * Do které rodiny název patří.
 *
 * Je to totéž, co odhad zkratky — „PPL ParcelBox - ABOX BRN Kounicova"
 * i „PPL / DHL International" spadnou pod „PPL". Právě proto se slovník
 * vede po rodinách: pobočky se mění a přibývají, rodina zůstává.
 */
export function familyOf(name: string | null | undefined): string {
  return guessShort(name ?? '');
}

/** Klíč do slovníku — druh a rodina, ať se „Zdarma" u dopravy neplete s platbou. */
function keyOf(kind: ShorthandKind, family: string): string {
  return `${kind}:${(family ?? '').trim().toLowerCase()}`;
}

/** Co se ukáže na odznaku. */
export function shortFor(kind: ShorthandKind, name: string | null | undefined): string {
  const family = familyOf(name);
  if (!family) return '';
  const mine = saved()[keyOf(kind, family)];
  return (mine?.short ?? '').trim() || family;
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
  const families = new Map<string, {
    kind: ShorthandKind; family: string; count: number; names: Map<string, number>;
  }>();

  const add = (kind: ShorthandKind, raw: unknown, by = 1) => {
    const name = String(raw ?? '').trim();
    if (!name) return;
    const family = familyOf(name);
    if (!family) return;

    const key = keyOf(kind, family);
    const found = families.get(key)
      ?? { kind, family, count: 0, names: new Map<string, number>() };
    found.count += by;
    found.names.set(name, (found.names.get(name) ?? 0) + by);
    families.set(key, found);
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
    if (!families.has(key)) {
      families.set(key, {
        kind,
        family: entry.name || key.slice(cut + 1),
        count: 0,
        names: new Map<string, number>()
      });
    }
  }

  return [...families.values()]
    .map(one => ({
      kind: one.kind,
      name: one.family,
      short: (mine[keyOf(one.kind, one.family)]?.short ?? '').trim(),
      guess: one.family,
      count: one.count,
      distinct: one.names.size,
      /*
       * Ukázka názvů, které se do rodiny slily. Bez ní se nedá poznat, jestli
       * se pod „PPL" schovaly jen parcelshopy, nebo omylem i něco cizího —
       * a slučování je tady to jediné, co se může splést.
       */
      samples: [...one.names.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([name]) => name)
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
export function saveShorthand(kind: ShorthandKind, family: string, short: string): ShorthandRow[] {
  const mine = saved();
  const clean = (family ?? '').trim();
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

/**
 * Zkratky rovnou k číslům objednávek — bez čekání na síť.
 *
 * Odznak v seznamu pošty se skládá ze dvou zdrojů a každý je jinak rychlý.
 * Celý odznak (`orders:badge`) rozebere e-mail, doptá se e-shopu na stav
 * a dopravce na zásilku; než se to vrátí, ukazuje řádek jen to, co jde
 * vyčíst z předmětu — číslo a částku. Na počítači je to jedno, tam se číslo
 * i tak ukazuje. **Na telefonu to ale znamená, že se místo dopravy a platby
 * chvíli kouká na číslo s cenou**, u pár řádků klidně minuty: dotazy jdou
 * po dvou a každý čeká na síť. Přesně tak to vypadalo — část řádků měla
 * „Hermes Karta", část pořád „023830 598,00 Kč".
 *
 * Tohle je proto krátká cesta: číslo z předmětu → řádek ve feedu → zkratky.
 * Žádná síť, jen jeden dotaz do databáze, takže odznak sedí hned a celý
 * odznak ho pak už jen doplní o stav a barvu.
 *
 * Číslo z předmětu bere e-shop jako číslo objednávky, ale u faktur chodí
 * číslo faktury — hledá se proto obojí, nikdy se ale nezamění jedno za druhé:
 * napřed se zkusí číslo objednávky, teprve když není, číslo faktury.
 */
export function shortsForCodes(codes: string[]): Record<string, CodeShorthand> {
  const out: Record<string, CodeShorthand> = {};
  const asked = [...new Set(
    (codes ?? []).map(one => String(one ?? '').trim().replace(/^#/, '')).filter(Boolean)
  )].slice(0, 200);
  if (!asked.length) return out;

  const d = getDb();
  let byCode: any;
  let byInvoice: any;
  try {
    byCode = d.prepare(
      `SELECT code, shipment, payment FROM shop_orders
        WHERE code = ? OR code = ? ORDER BY created_at DESC LIMIT 1`
    );
    byInvoice = d.prepare(
      `SELECT code, shipment, payment FROM shop_orders
        WHERE invoice != '' AND (invoice = ? OR ltrim(invoice, '0') = ?)
        ORDER BY created_at DESC LIMIT 1`
    );
  } catch {
    return out;
  }

  for (const one of asked) {
    // Vedoucí nuly píše e-shop v předmětu, ve feedu bývají oříznuté
    const bare = one.replace(/^0+/, '') || one;
    let row: any = null;
    try { row = byCode.get(one, bare) ?? byInvoice.get(one, bare); } catch { row = null; }
    if (!row) continue;

    const shipmentShort = shortFor('shipment', row.shipment) || null;
    const paymentShort = shortFor('payment', row.payment) || null;
    // Objednávka bez dopravy i platby by odznak jen připravila o číslo
    if (!shipmentShort && !paymentShort) continue;
    out[one] = { code: String(row.code ?? one), shipmentShort, paymentShort };
  }
  return out;
}
