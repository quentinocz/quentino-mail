import type {
  DigestFacts, DigestGa4, DigestNote, DigestPending, ShopEventImpact
} from './types';

/**
 * Co z čísel plyne — řečí člověka, který není analytik.
 *
 * Přehled uměl říct **co se stalo** („113 objednávek, +16 %"), ale ne
 * **co s tím**. Kdo čísla v e-shopu nečte denně, se z něj nedozvěděl,
 * jestli je 2,2 % konverze dobře nebo špatně, které číslo si dnes žádá
 * pozornost a co má jako první udělat. Tenhle modul z týchž čísel skládá
 * tři věci:
 *
 *  - **co funguje** — ať se v tom pokračuje, ne aby se to omylem zrušilo,
 *  - **co zlepšit** — kde se ztrácejí peníze a jaký je první krok,
 *  - **co zkusit** — nápad, který z dat plyne, ale jistota to není.
 *
 * Všechno je **spočítané**, ne od modelu: věty se skládají z čísel, která
 * jsou o kus výš na obrazovce, takže se dají ověřit. Postřehy od AI se
 * k nim přidávají zvlášť a je u nich poznat, že jsou od AI.
 *
 * Hranice jsou schválně hrubé a vysvětlené v místě, kde se používají.
 * Lepší je mlčet, než hlásit „pozor" u výkyvu, který znamená dvě
 * objednávky sem nebo tam — po třetím planém poplachu přestane člověk
 * číst i to, co platí.
 *
 * Modul je ve `shared`, protože počítač i telefon kreslí týž přehled
 * týmž rendererem; kdyby to bylo v hlavním procesu, musel by se výpočet
 * psát podruhé ve Swiftu a druhý den by se obě verze rozešly.
 */

export type AdviceLevel = 'good' | 'watch' | 'idea';

export interface AdviceItem {
  /** Klíč pro React a pro testy — ne pro uživatele */
  id: string;
  level: AdviceLevel;
  /** Co se děje, jednou větou a bez odborných slov */
  title: string;
  /** Čísla, ze kterých to plyne — aby se to dalo ověřit očima o kus výš */
  basis: string;
  /** První krok. Konkrétní, proveditelný dnes, ne „zamyslet se nad". */
  todo: string;
  /** Čím výš, tím dřív se to ukáže */
  weight: number;
  /** Spočítané z feedu, nebo postřeh od AI */
  from: 'pocitane' | 'ai';
}

/** Verdikt u jednoho čísla — slovo, které se čte bez přemýšlení */
export interface TileVerdict {
  level: 'good' | 'watch' | 'ok';
  /** „dobré", „slabší", „v normě" — jedno slovo, ne věta */
  word: string;
  /** Proč to tak je, do bubliny */
  why: string;
}

function money(amount: number, currency: string): string {
  const text = new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 0 }).format(Math.round(amount));
  return `${text} ${currency === 'CZK' ? 'Kč' : currency}`;
}

function pct(now: number, before: number): number | null {
  if (!before) return null;
  return Math.round(((now - before) / before) * 100);
}

function main(totals: { revenue: { currency: string; amount: number }[] }, currency: string): number {
  return totals.revenue.find(one => one.currency === currency)?.amount ?? 0;
}

/**
 * Verdikt u dlaždice.
 *
 * Číslo samo o sobě nic neříká: „1 765 Kč průměrná objednávka" je dobře
 * nebo špatně? Proti čemu? Verdikt se proto vždycky opírá o **srovnání
 * s vlastní minulostí** e-shopu, ne s oborem — cizí čísla se stejně
 * nedají ověřit a jen matou.
 *
 * Tři stupně stačí. Pátý stupeň by nikdo nerozlišil a u „mírně
 * podprůměrné" by se stejně nic nedělalo.
 */
export function tileVerdicts(facts: DigestFacts): {
  dnes: TileVerdict | null;
  okno: TileVerdict | null;
  trzba: TileVerdict | null;
  prumer: TileVerdict | null;
} {
  const currency = facts.currency || 'CZK';

  /*
   * Dnešek se s celým včerejškem srovnávat nedá dřív, než je den z větší
   * části za námi. V deset dopoledne je „−60 % proti včerejšku" pravda
   * a zároveň nesmysl.
   */
  const hours = new Date().getHours();
  const dnesRatio = pct(facts.today.orders, facts.yesterday.orders);
  const dnes: TileVerdict | null = hours < 16 || facts.yesterday.orders < 3 || dnesRatio == null
    ? (hours < 16
      ? { level: 'ok', word: 'den běží', why: 'Den ještě neskončil — na srovnání s včerejškem je brzo.' }
      : null)
    : dnesRatio <= -33
      ? { level: 'watch', word: 'slabší den', why: `O ${Math.abs(dnesRatio)} % míň objednávek než včera.` }
      : dnesRatio >= 50
        ? { level: 'good', word: 'silný den', why: `O ${dnesRatio} % víc objednávek než včera.` }
        : { level: 'ok', word: 'jako obvykle', why: 'Dnešek se od včerejška podstatně neliší.' };

  const oknoRatio = pct(facts.window.orders, facts.prevWindow.orders);
  const okno: TileVerdict | null = facts.prevWindow.orders < 10 || oknoRatio == null
    ? null
    : oknoRatio <= -20
      ? { level: 'watch', word: 'klesá', why: `O ${Math.abs(oknoRatio)} % míň objednávek než v předchozím stejně dlouhém období. Stojí za to zjistit, jestli ubylo návštěv, nebo lidé přestali kupovat.` }
      : oknoRatio >= 20
        ? { level: 'good', word: 'roste', why: `O ${oknoRatio} % víc objednávek než v předchozím stejně dlouhém období.` }
        : { level: 'ok', word: 'drží se', why: 'Objednávky se drží na úrovni předchozího období.' };

  const now = main(facts.window, currency);
  const before = main(facts.prevWindow, currency);
  const trzbaRatio = pct(now, before);
  /*
   * U tržby je nezaplacené důležitější než růst. Peníze, které nedorazily,
   * jsou v čísle započítané — a „+30 %" u tržby, ze které pětina nikdy
   * nepřijde, je špatná zpráva vydávaná za dobrou.
   */
  const unpaidShare = facts.window.orders > 0 ? facts.window.unpaid / facts.window.orders : 0;
  const trzba: TileVerdict | null = unpaidShare >= 0.1 && facts.window.unpaid >= 3
    ? { level: 'watch', word: 'čeká na platbu',
        why: `${facts.window.unpaid} z ${facts.window.orders} objednávek zatím není zaplacených — v tržbě jsou ale započítané.` }
    : before <= 0 || trzbaRatio == null
      ? null
      : trzbaRatio <= -20
        ? { level: 'watch', word: 'klesá', why: `O ${Math.abs(trzbaRatio)} % míň než předtím (${money(before, currency)}).` }
        : trzbaRatio >= 20
          ? { level: 'good', word: 'roste', why: `O ${trzbaRatio} % víc než předtím (${money(before, currency)}).` }
          : { level: 'ok', word: 'drží se', why: `Předchozí období ${money(before, currency)}.` };

  /*
   * Průměrná objednávka se srovnává s předchozím obdobím jen tehdy, když
   * je z čeho průměrovat. U pěti objednávek udělá jedna velká rozdíl,
   * který nic neznamená.
   */
  const prevAvg = facts.prevWindow.orders > 0 ? before / facts.prevWindow.orders : 0;
  const avgRatio = prevAvg > 0 ? pct(facts.average, prevAvg) : null;
  const prumer: TileVerdict | null = facts.window.orders < 10 || facts.prevWindow.orders < 10 || avgRatio == null
    ? null
    : avgRatio <= -10
      ? { level: 'watch', word: 'nižší',
          why: `Lidé utratí o ${Math.abs(avgRatio)} % míň než předtím (${money(prevAvg, currency)}). Pomáhá set nebo doprava zdarma od částky.` }
      : avgRatio >= 10
        ? { level: 'good', word: 'vyšší', why: `O ${avgRatio} % víc než předtím (${money(prevAvg, currency)}).` }
        : { level: 'ok', word: 'v normě', why: `Předtím ${money(prevAvg, currency)}.` };

  return { dnes, okno, trzba, prumer };
}

/**
 * Co dělat — seřazené podle toho, kolik je v tom peněz.
 *
 * Pravidla jsou schválně jednoduchá a každé odpovídá na otázku „a co s tím".
 * Rada bez kroku („sleduj konverzi") je k ničemu; rada s krokem („pošli
 * připomínku k platbě u jedenácti objednávek za 19 400 Kč") se dá udělat
 * hned.
 */
export function adviceItems(input: {
  facts: DigestFacts;
  ga4?: DigestGa4 | null;
  pending?: DigestPending | null;
  events?: ShopEventImpact[];
  notes?: DigestNote[];
}): AdviceItem[] {
  const { facts } = input;
  const currency = facts.currency || 'CZK';
  const out: AdviceItem[] = [];
  const add = (one: Omit<AdviceItem, 'from'> & { from?: AdviceItem['from'] }) =>
    out.push({ from: 'pocitane', ...one });

  /* ---------- peníze, které leží ---------- */

  /*
   * Nezaplacené objednávky jsou nejrychlejší peníze v celém přehledu:
   * zboží je vybrané, zákazník ho chce, jen neproběhla platba. Připomínka
   * stojí minutu a vrátí část z toho zpátky.
   */
  if (facts.window.unpaid >= 3) {
    add({
      id: 'nezaplacene',
      level: 'watch',
      title: `${facts.window.unpaid} objednávek čeká na zaplacení`,
      basis: `z ${facts.window.orders} objednávek za posledních 30 dní`,
      todo: 'Pošli k nim připomínku k platbě — zboží je vybrané, chybí jen peníze.',
      weight: 90 + facts.window.unpaid
    });
  }

  const pending = input.pending;
  if (pending && pending.unshipped >= 3 && (pending.oldestDays ?? 0) >= 3) {
    add({
      id: 'neodeslane',
      level: 'watch',
      title: `${pending.unshipped} objednávek čeká na odeslání`,
      basis: `nejstarší leží ${pending.oldestDays} dní`,
      todo: 'Odbav nejdřív ty nejstarší — po třech dnech bez balíku chodí dotazy a ruší se objednávky.',
      weight: 85 + (pending.oldestDays ?? 0)
    });
  }

  /* ---------- prodej proti minulému období ---------- */

  const oknoRatio = pct(facts.window.orders, facts.prevWindow.orders);
  if (facts.prevWindow.orders >= 10 && oknoRatio != null && oknoRatio <= -20) {
    /*
     * Propad má dvě různé příčiny a každá se řeší jinak: buď přestali
     * chodit lidé (pak je to propagace a vyhledávání), nebo chodí a
     * nekupují (pak je to web, cena nebo doprava). Návštěvnost to
     * rozhodne, tak ať to rozhodne rovnou.
     */
    const ga4 = input.ga4;
    const sessions = ga4?.window?.sessions ?? null;
    const prevSessions = ga4?.prevWindow?.sessions ?? null;
    const navstevy = sessions != null && prevSessions != null ? pct(sessions, prevSessions) : null;
    const lidiUbylo = navstevy != null && navstevy <= -10;
    add({
      id: 'propad',
      level: 'watch',
      title: `Objednávek je o ${Math.abs(oknoRatio)} % míň než v předchozím období`,
      basis: `${facts.window.orders} proti ${facts.prevWindow.orders}`
        + (navstevy != null ? `, návštěv ${navstevy > 0 ? '+' : ''}${navstevy} %` : ''),
      todo: navstevy == null
        ? 'Zapni si návštěvnost (Google Analytics) — bez ní se nepozná, jestli ubylo lidí, nebo přestali kupovat.'
        : lidiUbylo
          ? 'Ubylo lidí na webu, ne chuti kupovat — chce to propagaci: příspěvek, newsletter nebo reklamu na to, co se prodává nejvíc.'
          : 'Lidí chodí stejně, ale nekupují — podívej se na cenu, dopravu a na to, co je na webu nové oproti minulému měsíci.',
      weight: 80 + Math.abs(oknoRatio)
    });
  }
  if (facts.prevWindow.orders >= 10 && oknoRatio != null && oknoRatio >= 20) {
    const top = facts.products?.[0];
    add({
      id: 'rust',
      level: 'good',
      title: `Objednávek je o ${oknoRatio} % víc než v předchozím období`,
      basis: `${facts.window.orders} proti ${facts.prevWindow.orders}`,
      todo: top
        ? `Drž zásobu u toho, co to táhne — ${top.title} (${top.qty} ks za 30 dní).`
        : 'Drž zásobu u nejprodávanějšího zboží, ať růst nezastaví prázdný sklad.',
      weight: 60 + oknoRatio
    });
  }

  /* ---------- konverze a návštěvnost ---------- */

  const ga4 = input.ga4;
  if (ga4 && !ga4.error && ga4.conversion != null && ga4.prevConversion != null) {
    const rozdil = Math.round((ga4.conversion - ga4.prevConversion) * 10) / 10;
    if (rozdil <= -0.4) {
      add({
        id: 'konverze-dolu',
        level: 'watch',
        title: 'Z návštěvníků nakupuje míň lidí než dřív',
        basis: `konverze ${ga4.conversion} % proti ${ga4.prevConversion} % v předchozím období`,
        todo: 'Projdi cestu k nákupu — nejčastěji za to může doprava, cena nad očekávání nebo povinná registrace v pokladně.',
        weight: 70
      });
    } else if (rozdil >= 0.4) {
      add({
        id: 'konverze-nahoru',
        level: 'good',
        title: 'Z návštěvníků nakupuje víc lidí než dřív',
        basis: `konverze ${ga4.conversion} % proti ${ga4.prevConversion} %`,
        todo: 'Co se na webu změnilo v posledním měsíci, nech být — zabírá to.',
        weight: 55
      });
    }
  }

  /* ---------- platba a doprava ---------- */

  /*
   * Dobírka stojí poplatek u dopravce a část balíků se nevyzvedne. Když ji
   * volí většina, je to největší jednotlivá úspora, kterou má e-shop po ruce
   * — a stačí k tomu zvýhodnit platbu předem.
   */
  const platby = facts.payments ?? [];
  const platbyCelkem = platby.reduce((sum, one) => sum + one.orders, 0);
  const dobirka = platby.find(one => /dob[ií]rk/i.test(one.label));
  if (platbyCelkem >= 20 && dobirka) {
    const podil = Math.round((dobirka.orders / platbyCelkem) * 100);
    if (podil >= 40) {
      add({
        id: 'dobirka',
        level: 'idea',
        title: `Dobírkou platí ${podil} % zákazníků`,
        basis: `${dobirka.orders} z ${platbyCelkem} objednávek`,
        todo: 'Zvýhodni platbu předem (doprava zdarma nebo pár desetikorun sleva) — ušetříš poplatek dopravci a nevyzvednuté balíky.',
        weight: 50 + podil / 2
      });
    }
  }

  /* ---------- stálí zákazníci ---------- */

  const stali = facts.window.orders > 0 ? Math.round((facts.returning / facts.window.orders) * 100) : 0;
  if (facts.window.orders >= 20 && stali >= 25) {
    add({
      id: 'stali',
      level: 'good',
      title: `${stali} % objednávek je od lidí, kteří u tebe už nakoupili`,
      basis: `${facts.returning} z ${facts.window.orders} objednávek za 30 dní`,
      todo: 'Vracejí se — vyplatí se jim napsat: novinka, sada k tomu, co koupili, nebo poukaz pro stálé zákazníky.',
      weight: 45
    });
  } else if (facts.window.orders >= 30 && stali <= 10) {
    add({
      id: 'bez-navratu',
      level: 'idea',
      title: 'Zákazníci se skoro nevracejí',
      basis: `jen ${facts.returning} z ${facts.window.orders} objednávek je od někoho, kdo už nakoupil`,
      todo: 'Zkus po doručení poslat poděkování s tipem na doplněk — druhý nákup je nejlevnější objednávka, jakou můžeš mít.',
      weight: 40
    });
  }

  /* ---------- sociální sítě ---------- */

  const social = facts.social;
  if (social) {
    if (social.posts === 0) {
      add({
        id: 'site-ticho',
        level: 'idea',
        title: 'Za posledních 30 dní nevyšel na sítích žádný příspěvek',
        basis: `předtím ${social.prevPosts}`,
        todo: 'Vydej aspoň jeden týdně — nejjednodušší je fotka toho, co se zrovna nejvíc prodává.',
        weight: 42
      });
    } else if (social.ordersWithPost > social.ordersWithout * 1.2 && social.daysWithPost >= 3) {
      add({
        id: 'site-funguji',
        level: 'good',
        title: 'Ve dnech s příspěvkem chodí víc objednávek',
        basis: `${social.ordersWithPost} na den s příspěvkem proti ${social.ordersWithout} bez něj — souvislost, ne důkaz`,
        todo: 'Drž pravidelnost: příspěvek ve dnech, kdy se běžně prodává nejmíň, vyrovná slabé dny.',
        weight: 44
      });
    }
    const kandidat = (social.candidates ?? [])[0];
    if (kandidat) {
      add({
        id: 'site-propagace',
        level: 'idea',
        title: 'Jeden příspěvek zabral sám, bez placení',
        basis: `„${kandidat.caption.slice(0, 60)}" · ${kandidat.likes} lajků`,
        todo: 'Do tohohle se vyplatí dát rozpočet — funguje sám, peníze ho jen rozšíří k víc lidem.',
        weight: 41
      });
    }
  }

  /* ---------- sezóna ---------- */

  const sezona = (facts.history?.seasons ?? []).find(one => one.strong !== false);
  if (sezona && sezona.inDays > 0 && sezona.inDays <= 75) {
    const zbozi = (sezona.products ?? []).slice(0, 2).map(one => one.title).join(', ');
    add({
      id: 'sezona',
      level: 'idea',
      title: `Za ${sezona.inDays} dní začíná ${sezona.name}`,
      basis: `${sezona.label} bývá ${sezona.index.toLocaleString('cs-CZ', { maximumFractionDigits: 1 })}× silnější než průměrný měsíc`,
      todo: `Doskladni do ${new Date(sezona.startBy).toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric' })}`
        + (zbozi ? ` to, co se v ní prodává nejvíc: ${zbozi}.` : ' zboží, které v ní táhne.'),
      weight: 65 - Math.round(sezona.inDays / 10)
    });
  }

  /* ---------- události, které už něco ukázaly ---------- */

  /*
   * Zapsaná akce s měřeným dopadem je to nejcennější, co v přehledu je:
   * je to jediné místo, kde se dá říct „tohle fungovalo" o něčem, co se
   * dá zopakovat. Bere se ta nejvýraznější z posledního půlroku.
   */
  const pulrok = Date.now() - 182 * 86_400_000;
  const mereno = (input.events ?? []).filter(one =>
    !one.future && one.moneyDiff != null && new Date(`${one.to}T12:00:00`).getTime() >= pulrok);
  const nejlepsi = [...mereno].sort((a, b) => (b.moneyDiff ?? 0) - (a.moneyDiff ?? 0))[0];
  if (nejlepsi && (nejlepsi.moneyDiff ?? 0) > 0 && nejlepsi.kind === 'akce') {
    add({
      id: 'akce-zabrala',
      level: 'good',
      title: `Akce „${nejlepsi.title}" přinesla navíc ${money(nejlepsi.moneyDiff ?? 0, nejlepsi.currency || currency)}`,
      basis: `${nejlepsi.orders} objednávek za ${nejlepsi.days} dní proti běžnému dni před ní`,
      todo: 'Tohle je recept, který se dá zopakovat — naplánuj stejnou akci na další slabší týden.',
      weight: 58
    });
  }
  const nejhorsi = [...mereno].sort((a, b) => (a.moneyDiff ?? 0) - (b.moneyDiff ?? 0))[0];
  if (nejhorsi && (nejhorsi.moneyDiff ?? 0) < 0 && nejhorsi.kind === 'dovolena') {
    add({
      id: 'dovolena-stala',
      level: 'idea',
      title: `Zavřeno („${nejhorsi.title}") stálo ${money(Math.abs(nejhorsi.moneyDiff ?? 0), nejhorsi.currency || currency)}`,
      basis: `${nejhorsi.days} dní, ${nejhorsi.orders} objednávek místo obvyklých ${nejhorsi.basePerDay} na den`,
      todo: 'Příště se vyplatí zavírat v nejslabším období roku — v přehledu „Dlouhodobě" je vidět které to je.',
      weight: 38
    });
  }

  /* ---------- postřehy od AI ---------- */

  /*
   * Body od modelu se připojují k témuž seznamu, ale **označené**: spočítané
   * věty se dají ověřit o kus výš na obrazovce, tyhle ne. Míchat je bez
   * rozlišení by znamenalo tvářit se, že platí stejně.
   *
   * Berou se jen **varování a nápady**. Bod typu „trend" popisuje, co se
   * s čísly děje — to je pozorování, ne úkol, a do sloupce „co funguje"
   * mezi ověřitelné věty nepatří; zůstává v postřezích na konci okna.
   */
  for (const note of input.notes ?? []) {
    if (!note?.text) continue;
    if (note.kind !== 'pozor' && note.kind !== 'napad') continue;
    // Co už spočítal kód, model neopakuje — dvakrát tatáž věta vedle sebe
    // vypadá jako dvě zjištění a jedno z nich je vždycky hůř podložené
    if (out.some(one => one.from === 'pocitane' && similar(one.title, note.text))) continue;
    out.push({
      id: `ai-${note.kind}-${note.text.slice(0, 20)}`,
      level: note.kind === 'pozor' ? 'watch' : 'idea',
      title: note.text,
      basis: note.basis ?? '',
      todo: note.check ?? '',
      weight: note.kind === 'pozor' ? 75 : 35,
      from: 'ai'
    });
  }

  return out.sort((a, b) => b.weight - a.weight);
}

/**
 * Mluví dvě věty o tomtéž?
 *
 * Hrubé, ale spolehlivé: shoda dvou delších slov. „11 objednávek čeká na
 * zaplacení" a „Jedenáct nezaplacených objednávek čeká déle než tři dny"
 * se potkají na „objednávek" a „zaplacen…", a to stačí — o nezaplacených
 * objednávkách má být v přehledu jedna věta, ne dvě.
 */
function similar(a: string, b: string): boolean {
  /*
   * Záporka se odřezává. „nezaplacených" a „zaplacení" je totéž slovo
   * o téže věci — a právě na tomhle páru se dvě věty o nezaplacených
   * objednávkách minuly a ukázaly se v přehledu obě.
   */
  const slova = (text: string) => new Set(
    text.toLowerCase()
      .replace(/[^\p{L}\p{N} ]+/gu, ' ')
      .split(/\s+/)
      .map(one => (one.length > 8 && one.startsWith('ne') ? one.slice(2) : one))
      .filter(one => one.length >= 6)
      .map(one => one.slice(0, 7))
  );
  const left = slova(a);
  let shoda = 0;
  for (const word of slova(b)) if (left.has(word)) shoda++;
  return shoda >= 2;
}

/** Tři sloupce, v jakých se to čte: co funguje, co zlepšit, co zkusit */
export function adviceColumns(items: AdviceItem[], limit = 3): {
  good: AdviceItem[]; watch: AdviceItem[]; idea: AdviceItem[];
} {
  return {
    good: items.filter(one => one.level === 'good').slice(0, limit),
    watch: items.filter(one => one.level === 'watch').slice(0, limit),
    idea: items.filter(one => one.level === 'idea').slice(0, limit)
  };
}
