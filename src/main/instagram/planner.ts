import { BrowserWindow } from 'electron';
import { ask, askLong } from '../ai';
import { getSettings } from '../settings';
import { getSetting, setSetting } from '../db';
import { digestFacts } from '../digest';
import { listProducts } from '../products';
import * as store from './store';
import type { IgPlanSetup, IgPlanned, IgPlanProposal } from '../../shared/types';

/**
 * Plánovač příspěvků na měsíc dopředu.
 *
 * ## Co se řeší
 *
 * Příspěvky se dělají tehdy, když na ně zbyde čas — a ten zbyde nejmíň
 * v sezóně, kdy by jich mělo být nejvíc. Výsledkem je měsíc mlčení a pak
 * pět příspěvků za týden, všechny o tomtéž zboží. Chybí ne nápady, ale
 * **rozhodnutí dopředu**: o čem se bude psát a kdy.
 *
 * ## Z čeho se vychází
 *
 * Ze skutečných prodejů, ne z dojmu. Co se prodává, si zaslouží posílit;
 * co leží na skladě a přitom se vůbec neukazuje, si zaslouží šanci.
 * Třetí díl je sezóna (Vánoce, svatby, Valentýn) a čtvrtý zákulisí —
 * bez něj by z profilu byl katalog.
 *
 * ## Co plánovač **nedělá**
 *
 * Nepublikuje a nevymýšlí fotky. Návrh je záměr s textem a nápadem na
 * snímek; média přidá člověk a teprve pak se příspěvek zařadí k
 * publikaci. Kdyby plánovač publikoval sám, byl by z profilu robot —
 * a to je přesně to, co na sociální síti nikdo nechce číst.
 */

const SETUP_KEY = 'igPlanSetup';

/** Kolik příspěvků měsíčně dává smysl, když se má každý pořádně nafotit. */
const DEFAULT_COUNT = 12;

export function planSetup(): IgPlanSetup {
  try {
    const saved = JSON.parse(getSetting(SETUP_KEY, '') || '{}');
    return {
      count: clamp(saved.count, 1, 60, DEFAULT_COUNT),
      days: Array.isArray(saved.days) && saved.days.length > 0
        ? saved.days.filter((one: any) => Number.isInteger(one) && one >= 0 && one <= 6)
        : [1, 3, 5],
      hour: clamp(saved.hour, 0, 23, 18),
      /*
       * Poměr mezi „co se prodává" a „co leží". Šedesát procent na
       * osvědčené je záměr: profil má hlavně prodávat, ale měsíc bez
       * jediného opomíjeného kusu znamená, že se sklad nikdy nepohne.
       */
      mixBest: clamp(saved.mixBest, 0, 100, 60),
      langs: Array.isArray(saved.langs) && saved.langs.length > 0 ? saved.langs : ['CS'],
      note: String(saved.note ?? '')
    };
  } catch {
    return { count: DEFAULT_COUNT, days: [1, 3, 5], hour: 18, mixBest: 60, langs: ['CS'], note: '' };
  }
}

export function savePlanSetup(value: any): IgPlanSetup {
  const next = {
    count: clamp(value?.count, 1, 60, DEFAULT_COUNT),
    days: Array.isArray(value?.days)
      ? value.days.filter((one: any) => Number.isInteger(one) && one >= 0 && one <= 6)
      : [1, 3, 5],
    hour: clamp(value?.hour, 0, 23, 18),
    mixBest: clamp(value?.mixBest, 0, 100, 60),
    langs: Array.isArray(value?.langs) && value.langs.length > 0 ? value.langs : ['CS'],
    note: String(value?.note ?? '').slice(0, 400)
  };
  setSetting(SETUP_KEY, JSON.stringify(next));
  return planSetup();
}

const clamp = (value: any, low: number, high: number, fallback: number) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.max(low, Math.min(high, n)) : fallback;
};

/* ---------- kdy ---------- */

const den = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * Termíny na měsíc dopředu.
 *
 * Rozprostírá se to po vybraných dnech v týdnu — ne „každý třetí den",
 * protože lidé chodí na sítě jinak ve středu večer a jinak v neděli ráno.
 * Když je příspěvků víc než termínů, přidají se další dny; když míň,
 * termíny se rovnoměrně prořídí, aby nebyly všechny na začátku měsíce.
 */
export function planDays(setup: IgPlanSetup, from = new Date()): string[] {
  const dny = setup.days.length > 0 ? setup.days : [1, 3, 5];
  const out: string[] = [];
  const kurzor = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  // Začíná se zítřkem: dnešní příspěvek se stejně nestihne nafotit
  kurzor.setDate(kurzor.getDate() + 1);

  const konec = new Date(kurzor);
  konec.setDate(konec.getDate() + 34);
  const volne: string[] = [];
  while (kurzor <= konec) {
    if (dny.includes(kurzor.getDay())) volne.push(den(kurzor));
    kurzor.setDate(kurzor.getDate() + 1);
  }
  if (volne.length === 0) return [];

  if (setup.count <= volne.length) {
    /* Rovnoměrně po celém měsíci, ne prvních N za sebou */
    const krok = volne.length / setup.count;
    for (let i = 0; i < setup.count; i++) out.push(volne[Math.floor(i * krok)]);
    return out;
  }
  /* Víc příspěvků než termínů: den se použije víckrát, ale ne třikrát po sobě */
  for (let i = 0; i < setup.count; i++) out.push(volne[i % volne.length]);
  return out.sort();
}

/* ---------- z čeho se vychází ---------- */

/**
 * Podklady pro návrh: co se prodávalo, co leží a co už vyšlo.
 *
 * Vrací se **text**, ne surová data — model má rozhodovat o nápadech,
 * ne luštit tabulky, a stručný podklad se navíc vejde do jednoho dotazu.
 */
export function planFacts(now = new Date()): string {
  const facts = digestFacts(now, 60) as any;
  const mena = facts?.currency ?? 'Kč';

  const prodej = (facts?.products ?? []).slice(0, 14)
    .map((one: any) => `- ${one.title || one.code} (${one.code}): ${one.qty} ks, ${one.revenue} ${mena}`)
    .join('\n');

  /*
   * Opomíjené zboží. Ne „co se neprodalo" (to je většina katalogu), ale
   * **co je skladem a přitom se za dva měsíce neprodal ani kus** — jen
   * tam má smysl zkoušet, jestli chybí pozornost, a ne zboží.
   */
  const prodane = new Set((facts?.products ?? []).map((one: any) => String(one.code)));
  const lezi = listProducts({ inStockOnly: true, limit: 120, sort: 'stock' }).items
    .filter(one => !prodane.has(String(one.code)))
    .slice(0, 14)
    .map(one => `- ${one.title} (${one.code}), skladem ${one.stock ?? '?'}`)
    .join('\n');

  const uzVyslo = store.listSourcePosts(12, 0)
    .map(one => `- ${String(one.caption ?? '').replace(/\s+/g, ' ').slice(0, 90)}`)
    .join('\n');

  const mesic = new Intl.DateTimeFormat('cs-CZ', { month: 'long', year: 'numeric' }).format(now);

  return [
    `Dnes je ${now.toLocaleDateString('cs-CZ')}, plánuje se od ${mesic}.`,
    '',
    'Nejprodávanější za poslední dva měsíce:',
    prodej || '(zatím žádná data o prodejích)',
    '',
    'Skladem, ale za dva měsíce se neprodalo ani kus:',
    lezi || '(nic takového)',
    '',
    'Co už na profilu nedávno vyšlo (ať se to neopakuje):',
    uzVyslo || '(nic)'
  ].join('\n');
}

/* ---------- návrh ---------- */

const SYSTEM = `Jsi člověk, který roky dělá obsah pro český e-shop s pánskou módou
(kravaty, motýlky, šle, kapesníčky, svatební doplňky). Píšeš na Instagram.

Dostaneš čísla z e-shopu a termíny. Navrhni na každý termín jeden příspěvek.

Pravidla, na kterých záleží:
- Každý příspěvek má **jediné sdělení**. „Máme kravaty i motýlky i šle" není příspěvek.
- Druhy se střídají, ať měsíc není třicetkrát totéž:
  · "bestseller" — co se prodává, to se má ukázat znovu,
  · "lezak" — co je skladem a nikdo o tom neví; hledej důvod, proč to stojí za pohled,
  · "sezona" — co se zrovna děje (svatby, Vánoce, plesy, Valentýn, návrat do práce),
  · "zakulisi" — jak to vzniká, detail látky, balení, příběh; bez toho je z profilu katalog.
- Text piš **hotový k vložení**, ne osnovu. Dva až čtyři krátké odstavce, bez frází
  typu "neváhejte" a bez vykřičníků na konci každé věty. Emoji nanejvýš dvě.
- Nápad na fotku popiš tak, aby ho šlo nafotit doma: co je v záběru, co je na pozadí,
  jestli je to fotka, série nebo krátké video.
- Hashtagy 5 až 8, česky i anglicky, bez #love a podobných vycpávek.

Vrať JEN JSON bez komentářů:
{"posts":[{"day":"YYYY-MM-DD","kind":"bestseller|lezak|sezona|zakulisi",
"title":"krátký název do přehledu","text":"hotový text příspěvku",
"idea":"co a jak nafotit","code":"kód produktu nebo prázdné",
"tags":["#kravaty","#quentino"]}]}`;

/**
 * Nechá AI navrhnout měsíc.
 *
 * Vrací **návrh**, nic se neukládá. Je to schválně dvoukrokové: návrh se
 * dá přečíst, přehodit a vyhodit, a teprve pak se z něj stanou příspěvky.
 * Rovnou uložený měsíc by znamenal třicet rozdělaných příspěvků, které
 * pak někdo maže po jednom.
 */
/**
 * Celé objekty z rozepsaného JSONu.
 *
 * Model posílá návrh po kouscích a čekat na poslední znak znamená dívat se
 * minutu na tlačítko „Přemýšlím". Příspěvky jsou přitom v odpovědi jeden
 * po druhém — jakmile je některý dopsaný, dá se ukázat.
 *
 * Hledají se vyvážené složené závorky a **hlídá se, co je uvnitř řetězce**:
 * bez toho by závorka v textu příspěvku („{"text": "sleva {akce}"}")
 * rozhodila počítání a od té chvíle by se neukázalo nic.
 *
 * Vrací nalezené kusy a místo, odkud pokračovat příště.
 */
export function hotoveObjekty(text: string, from = 0): { kusy: string[]; dal: number } {
  const kusy: string[] = [];
  let dal = from;
  let i = from;
  let start = -1;
  let hloubka = 0;
  let vRetezci = false;
  while (i < text.length) {
    const ch = text[i];
    if (vRetezci) {
      if (ch === '\\') i += 1;
      else if (ch === '"') vRetezci = false;
    } else if (ch === '"') vRetezci = true;
    else if (ch === '{') {
      if (hloubka === 0) start = i;
      hloubka += 1;
    } else if (ch === '}') {
      hloubka -= 1;
      if (hloubka === 0 && start >= 0) {
        kusy.push(text.slice(start, i + 1));
        dal = i + 1;
        start = -1;
      }
      if (hloubka < 0) hloubka = 0;
    }
    i += 1;
  }
  return { kusy, dal };
}

/** Jeden návrh z toho, co poslal model — termín si dosazujeme sami. */
function navrhZ(one: any, den: string, hodina: number): IgPlanProposal {
  const tags = Array.isArray(one?.tags) ? one.tags.filter((t: any) => typeof t === 'string').slice(0, 8) : [];
  return {
    /* Termín z naší strany, ne z modelu: ten si ho umí vymyslet mimo měsíc */
    day: den,
    hour: hodina,
    kind: ['bestseller', 'lezak', 'sezona', 'zakulisi'].includes(String(one?.kind))
      ? String(one.kind) : 'sezona',
    title: String(one?.title ?? '').trim().slice(0, 80) || 'Příspěvek',
    text: String(one?.text ?? '').trim().slice(0, 2200),
    idea: String(one?.idea ?? '').trim().slice(0, 400),
    code: String(one?.code ?? '').trim().slice(0, 40),
    tags
  } as IgPlanProposal;
}

function rozhlas(channel: string, payload: unknown): void {
  try {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload);
  } catch { /* okno se mezitím zavřelo — návrh kvůli tomu neshodíme */ }
}

export async function proposeMonth(now = new Date()): Promise<IgPlanProposal[]> {
  const setup = planSetup();
  const terminy = planDays(setup, now);
  if (terminy.length === 0) throw new Error('Nejsou vybrané žádné dny v týdnu, kdy se má postovat.');

  const kolikBest = Math.round((setup.count * setup.mixBest) / 100);
  const zadani = [
    planFacts(now),
    '',
    `Termíny (přesně tolik příspěvků, kolik je termínů): ${terminy.join(', ')}`,
    `Z toho zhruba ${kolikBest} o tom, co se prodává, a ${setup.count - kolikBest} o zbytku`
      + ' (opomíjené zboží, sezóna, zákulisí).',
    setup.note ? `Na co nezapomenout: ${setup.note}` : ''
  ].filter(Boolean).join('\n');

  /*
   * Návrh se **streamuje**. Měsíc příspěvků je dlouhá odpověď a čekat na
   * její poslední znak znamenalo dívat se přes minutu na tlačítko
   * „Přemýšlím" bez jediné známky toho, že se něco děje. Každý dopsaný
   * příspěvek se proto pošle do okna hned, jak je hotový — a když se
   * model uprostřed zadrhne, zůstane aspoň to, co už stihl.
   */
  const out: IgPlanProposal[] = [];
  let dal = 0;
  /* První složená závorka patří obalu {"posts": [...]}, ne příspěvku */
  let obalPryc = false;

  const krok = (text: string) => {
    if (!obalPryc) {
      const zacatek = text.indexOf('[');
      if (zacatek < 0) return;
      dal = Math.max(dal, zacatek);
      obalPryc = true;
    }
    const { kusy, dal: konec } = hotoveObjekty(text, dal);
    dal = konec;
    for (const kus of kusy) {
      if (out.length >= terminy.length) break;
      let one: any = null;
      try { one = JSON.parse(kus); } catch { continue; }
      out.push(navrhZ(one, terminy[out.length], setup.hour));
    }
    if (kusy.length > 0) {
      rozhlas('ig:planStep', { hotovo: out.length, celkem: terminy.length, items: out.slice() });
    }
  };

  rozhlas('ig:planStep', { hotovo: 0, celkem: terminy.length, items: [] });
  /*
   * Strop se **nezvedá nad osm tisíc**.
   *
   * Vypadá to jako omezení, ale je to naopak pojistka: každý model má
   * svůj vlastní strop na délku odpovědi a požadavek nad ním server
   * odmítne. U dlouhého měsíce se místo toho spoléhá na to, že si
   * askLong řekne o pokračování — useknutou odpověď pozná a nechá ji
   * dopsat, takže se dlouhý návrh poskládá ze dvou kusů.
   */
  const strop = 8_000;
  let raw = '';
  try {
    raw = await askLong(getSettings().draftModel, SYSTEM, zadani, {
      maxTokens: strop,
      onChunk: text => krok(text)
    });
  } catch (e: any) {
    /*
     * Přerušené spojení nezahazuje hotovou práci. Když model stihl
     * napsat osm příspěvků z dvanácti, je to pořád osm příspěvků —
     * spadnout na hlášku a začít znovu by znamenalo napsat je podruhé.
     */
    if (!e?.stalled && !e?.truncated) throw e;
    raw = String(e.partial ?? '');
    krok(raw);
    if (out.length === 0) throw e;
  }
  /*
   * Doběh: poslední kus mohl dorazit až s koncem odpovědi a některé
   * modely balí JSON do ```json bloku, takže se na závěr projde celý text.
   */
  krok(raw);

  if (out.length === 0) {
    throw new Error('Model nevrátil použitelný návrh. Zkus to ještě jednou.');
  }
  rozhlas('ig:planStep', { hotovo: out.length, celkem: terminy.length, items: out.slice(), konec: true });
  return out;
}

/**
 * Jeden příspěvek na vyžádání.
 *
 * Plán na měsíc je pro rozvahu dopředu; tohle je pro chvíli, kdy je
 * důvod hned teď — přišly nové vzory, je hezké světlo, nebo se prostě
 * chce něco poslat ven. Přání je nepovinné: bez něj se vybere z toho,
 * co se prodává a co leží skladem, se stejnými čísly jako měsíční plán.
 *
 * Termín se **nepřiděluje**. Příspěvek na teď se dodělá a pošle, ne
 * zařadí do rozvrhu; termín si k němu dá člověk sám, když chce.
 */
export async function proposeOne(wish = '', now = new Date()): Promise<IgPlanProposal> {
  const setup = planSetup();
  const prani = String(wish ?? '').trim().slice(0, 200);
  const zadani = [
    planFacts(now),
    '',
    prani
      ? `Chci jeden příspěvek na tohle: ${prani}`
      : 'Chci jeden příspěvek. Vyber téma sám — podle toho, co se prodává nebo co leží'
        + ' skladem a zaslouží si pozornost.',
    setup.note ? `Na co nezapomenout: ${setup.note}` : ''
  ].filter(Boolean).join('\n');

  /*
   * Useknutá odpověď se nezahazuje. Když model narazí na strop uprostřed
   * druhého příspěvku, ten první je celý a je z čeho vyjít — spadnout na
   * „Odpověď se nevešla do limitu" by znamenalo zahodit hotovou práci.
   */
  let raw = '';
  try {
    raw = await ask(getSettings().draftModel, SYSTEM, zadani, 3000);
  } catch (e: any) {
    if (!e?.truncated || !e?.partial) throw e;
    raw = String(e.partial);
  }
  const { kusy } = hotoveObjekty(raw, Math.max(0, raw.indexOf('[')));
  for (const kus of kusy) {
    let one: any = null;
    try { one = JSON.parse(kus); } catch { continue; }
    if (!one || (!one.title && !one.text)) continue;
    /* Bez termínu: příspěvek na teď se dodělává, ne plánuje */
    return navrhZ(one, '', setup.hour);
  }
  throw new Error('Model nevrátil použitelný návrh. Zkus to ještě jednou, případně jinými slovy.');
}

/**
 * Z návrhu udělá rozdělané příspěvky.
 *
 * Text jde do zadání (`brief`) a nápad na fotku do poznámky k médiím —
 * tedy přesně tam, kde je hledá ten, kdo příspěvek dodělává. Publikace se
 * nezakládá: dokud nejsou média, není co publikovat.
 */
export function acceptPlan(items: any[]): number {
  const list = Array.isArray(items) ? items : [];
  let kolik = 0;
  for (const one of list) {
    /*
     * V měsíčním plánu je příspěvek bez data vada, ne záměr — termín mu
     * přidělujeme my a nesmysl místo data znamená, že se něco pokazilo.
     * Zahodit ho je lepší než uložit na rok 1970.
     */
    if (zaloz(one, true) > 0) kolik++;
  }
  return kolik;
}

/**
 * Z jednoho návrhu rozdělaný příspěvek.
 *
 * Termín je **nepovinný**. Příspěvek „na teď" žádný nemá: dodělá se a
 * pošle, ne zařadí do rozvrhu. Dokud se termín vyžadoval, návrh na
 * vyžádání se tiše zahodil a v seznamu rozdělaných se nic neobjevilo.
 */
export function zaloz(one: any, terminPovinny = false): number {
  const den = String(one?.day ?? '').slice(0, 10);
  const maTermin = /^\d{4}-\d{2}-\d{2}$/.test(den);
  if (terminPovinny && !maTermin) return 0;
  const hodina = clamp(one?.hour, 0, 23, 18);
  const tags = Array.isArray(one?.tags) ? one.tags.join(' ') : '';
  const text = String(one?.text ?? '').trim();
  if (!text && !String(one?.idea ?? '').trim()) return 0;
  return store.createPost({
    kind: 'new',
    brief: [text, tags].filter(Boolean).join('\n\n'),
    mediaNote: String(one?.idea ?? '').trim(),
    planAt: maTermin ? `${den} ${String(hodina).padStart(2, '0')}:00` : '',
    planKind: String(one?.kind ?? ''),
    /* Krátký název do přehledu — bez něj v plánu stála první věta textu */
    planTitle: String(one?.title ?? '').trim().slice(0, 80),
    planIdea: String(one?.idea ?? '').trim(),
    planCode: String(one?.code ?? '').trim(),
    /* Z návrhu, ne od člověka — v seznamu se to má poznat */
    origin: 'ai'
  });
}

/** Návrh na teď: rovnou se z něj stane rozdělaný příspěvek a vrátí se jeho id. */
export function acceptOne(one: any): number {
  const id = zaloz(one);
  if (!id) throw new Error('Návrh je prázdný — není z čeho příspěvek založit.');
  return id;
}

/* ---------- co je v plánu ---------- */

/**
 * Plán na období, i s tím, co k příspěvku chybí.
 *
 * „Chybí" je tu to podstatné: měsíc dopředu je k ničemu, když se den
 * před termínem zjistí, že u poloviny příspěvků nejsou fotky. Proto se
 * ke každému počítá, jestli má média, text a jestli je zařazený
 * k publikaci.
 */
export function plannedPosts(fromDay: string, toDay: string): IgPlanned[] {
  return store.listPlanned(fromDay, toDay).map(row => {
    const post = store.getPost(row.id);
    const media = post?.media.length ?? 0;
    const texty = (post?.captions ?? []).filter(one => (one.text ?? '').trim()).length;
    const vyslo = (post?.captions ?? []).some(one => one.status === 'published');
    /*
     * „Čeká na odeslání" se pozná podle schváleného textu, ne podle stavu
     * fronty: práce ve frontě je záznam o odesílání, kdežto tady jde
     * o to, jestli je příspěvek z pohledu člověka hotový.
     */
    const ceka = (post?.captions ?? []).some(one => one.status === 'approved');
    return {
      id: row.id,
      at: String(row.plan_at ?? ''),
      kind: String(row.plan_kind ?? ''),
      /*
       * Název z návrhu, ne první řádek zadání. Zadání začíná textem
       * příspěvku, takže v přehledu stála první věta useknutá uprostřed
       * slova — a u příspěvku bez textu „Bez názvu".
       */
      title: String(row.plan_title ?? '').trim() || prvniRadek(String(row.brief ?? '')),
      idea: String(row.plan_idea ?? ''),
      code: String(row.plan_code ?? ''),
      media,
      texts: texty,
      state: vyslo ? 'published' : ceka ? 'scheduled' : media > 0 ? 'ready' : 'waiting'
    };
  });
}

/**
 * Náhradní název pro příspěvky, které vznikly dřív, než se název ukládal.
 *
 * Nejde o celý první řádek: zadání začíná textem příspěvku, takže by
 * v přehledu stála celá první věta useknutá uprostřed slova. Bere se
 * proto první věta, a když je dlouhá, utne se **na mezeře**.
 */
function prvniRadek(text: string): string {
  const radek = text.split('\n').map(one => one.trim()).find(Boolean) ?? '';
  const veta = (radek.split(/(?<=[.!?])\s/)[0] ?? radek).trim();
  if (veta.length <= 60) return veta.replace(/[.]$/, '');
  const kratsi = veta.slice(0, 60);
  const mezera = kratsi.lastIndexOf(' ');
  return (mezera > 24 ? kratsi.slice(0, mezera) : kratsi) + '…';
}

export const __test = { planDays, clamp, prvniRadek, hotoveObjekty, navrhZ, zaloz };
