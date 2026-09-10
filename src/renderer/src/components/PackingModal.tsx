import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  PackingLookup, PackingOrder, PackingProgress, OrderCardItem, OrderNote, ApprovedNote
} from '@shared/types';
import { api } from '../api';
import { useToast } from '../toast';
import Icon from './Icon';
import CallContact from './CallContact';
import { useIsPhone } from '../mobile';

/**
 * Nástroj na balení objednávek.
 *
 * Návrh vychází z toho, jak se dělají skladové pick-and-pack obrazovky: vlevo
 * fronta objednávek, vpravo jedna objednávka jako odškrtávací seznam. Cílem je
 * snížit chybovost, proto je zvlášť zdůrazněno všechno, co se plete —
 * množství větší než kus, varianty (délka, šířka) a kód produktu. Odškrtnutí
 * se ukládá do databáze, takže přerušené balení se dá kdykoli dobrat.
 */

const WINDOWS: { days: number; label: string }[] = [
  { days: 1, label: '24 h' },
  { days: 2, label: '2 dny' },
  { days: 3, label: '3 dny' },
  { days: 7, label: 'týden' },
  { days: 14, label: '14 dní' },
  { days: 30, label: 'měsíc' }
];

/**
 * Fáze objednávky.
 *
 * Stavů má e-shop dvacet a jmenují se pokaždé trochu jinak („Vyřizuje se",
 * „Připraveno k odeslání", „Předáno dopravci"). Při balení jich ale
 * rozhoduje pět a jde v nich o jednu otázku: **mám to teď zabalit?**
 *
 * Dřív se stavy jen schovávaly — seznam pak ukazoval jen to nezabalené a
 * nešlo se podívat, co se za ten den vlastně odeslalo. Teď je v seznamu celé
 * období a fáze je vidět barvou; schovat se dá cokoli, ale nic se neschovává
 * samo za zády.
 *
 * Pořadí je pořadí práce: čeká na platbu → k zabalení → zabaleno → odesláno
 * → doručeno, a stranou storno.
 */
export type PackPhase = 'unpaid' | 'todo' | 'packed' | 'sent' | 'delivered' | 'canceled';

const PHASES: { key: PackPhase; label: string; hint: string }[] = [
  { key: 'unpaid', label: 'Čeká na platbu', hint: 'Nezaplacené — balit se nemá, dokud peníze nedorazí' },
  { key: 'todo', label: 'K zabalení', hint: 'Tohle je práce na dnešek' },
  { key: 'packed', label: 'Zabaleno', hint: 'Odškrtnuté v aplikaci, ale e-shop je ještě nemá jako odeslané' },
  { key: 'sent', label: 'Odesláno', hint: 'Předáno dopravci' },
  { key: 'delivered', label: 'Doručeno', hint: 'U zákazníka nebo vyzvednuté' },
  { key: 'canceled', label: 'Storno', hint: 'Zrušené, vrácené nebo reklamované' }
];

const CANCELED = /storn|zru[šs]en|vr[áa]cen|odstoup|reklamac|nevyzvednut|zam[íi]tnut/i;
const DELIVERED = /doru[čc]en|vyzvednut|dokon[čc]en|uzav[řr]en/i;
const SENT = /odesl[áa]n|expedov|p[řr]ed[áa]n|na\s*cest|v\s*p[řr]eprav|vypraven/i;
const UNPAID = /nezaplac|[čc]ek[áa]\s*na\s*(platb|[úu]hrad)|neuhrazen|nepotvrzen[áa]\s*platb/i;

/**
 * Do jaké fáze objednávka patří.
 *
 * Pořadí testů je pořadí jistoty: storno přebije všechno (stornovaná
 * objednávka se nebalí, i kdyby byla zaplacená), doručení přebije odeslání
 * a teprve pak se řeší platba. „Zabaleno" je naše vlastní odškrtnutí, ne
 * stav z e-shopu — proto se ptá až nakonec, když e-shop ještě nic neví.
 */
export function phaseOf(order: PackingOrder): PackPhase {
  const status = order.shop?.status ?? order.card.tracking?.status ?? order.card.live?.status ?? '';
  if (CANCELED.test(status)) return 'canceled';
  if (DELIVERED.test(status)) return 'delivered';
  if (SENT.test(status)) return 'sent';
  if (order.done) return 'packed';
  if (UNPAID.test(status)) return 'unpaid';
  return 'todo';
}

/**
 * Země, kam se doručuje.
 *
 * Bere se z doručovací adresy, a když chybí, z fakturační — doručuje se pak
 * na ni. Při balení rozhoduje: do zahraničí jde jiný štítek, jiná doba
 * a u některých zemí i celní papír.
 */
export function countryOf(order: PackingOrder): string {
  const raw = order.card.shipping?.country || order.card.billing?.country || '';
  return raw.trim().toUpperCase().slice(0, 2);
}

/** Dobírka se pozná z názvu platby — a při balení na ní záleží nejvíc. */
export function isCod(order: PackingOrder): boolean {
  return /dob[íi]rk|cash\s*on|nachnahme/i.test(order.card.paymentName ?? '');
}

const LS_HIDDEN = 'packingHiddenPhases';

function loadSet(key: string): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(key) || '[]');
    return new Set(Array.isArray(v) ? v : []);
  } catch {
    return new Set();
  }
}

function saveSet(key: string, s: Set<string>) {
  localStorage.setItem(key, JSON.stringify([...s]));
}

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const h = Math.floor(diff / 3600_000);
  if (h < 1) return 'před chvílí';
  if (h < 24) return `před ${h} h`;
  const d = Math.floor(h / 24);
  return d === 1 ? 'včera' : `před ${d} dny`;
}

/**
 * Vlaječka ze dvou písmen kódu země.
 *
 * Unicode má vlajky poskládané z „regionálních písmen": CZ = 🇨🇿. Není to
 * obrázek ani tabulka zemí, jen posun v kódu znaku — takže to funguje i pro
 * zemi, kterou aplikace nikdy neviděla.
 */
function flagOf(code: string): string {
  if (!/^[A-Z]{2}$/.test(code)) return '🏳';
  return String.fromCodePoint(...[...code].map(ch => 0x1f1e6 + ch.charCodeAt(0) - 65));
}

/** Datum bez času — u stavu objednávky stačí den */
function dayOf(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('cs-CZ');
}

function totalPieces(items: OrderCardItem[]): number {
  return items.reduce((s, i) => s + (i.qty || 1), 0);
}

/** Kolik kusů z objednávky už je v krabici — ne kolik položek */
function packedPieces(o: PackingOrder): number {
  return o.card.items.reduce((s, it, i) => {
    const qty = Math.max(1, it.qty || 1);
    return s + Math.min(qty, o.counts?.[String(i)] ?? 0);
  }, 0);
}

/**
 * Číslo, které má člověk před sebou.
 *
 * V ruce drží fakturu a na ní je **číslo faktury** — pod tím zboží hledá,
 * tím se ptá zákazník a tím se ptá i dopravce. Číslo objednávky je jiné
 * a ukazovat ho jako to hlavní znamenalo, že načtená faktura otevřela
 * obrazovku s číslem, které na papíře nikde není.
 *
 * Číslo objednávky se proto ukazuje pod ním, drobně: taky se hodí (v e-shopu
 * se objednávka vede pod ním), jen se podle něj nikdo nerozhoduje.
 */
function numbers(order: PackingOrder): { main: string; sub: string } {
  const invoice = order.shop?.invoice ?? '';
  const code = order.card.orderNumber ?? '';
  if (invoice) return { main: invoice, sub: code };
  // Objednávka bez vystavené faktury — pak je číslo objednávky to jediné
  return { main: code || '—', sub: '' };
}

function customerName(o: PackingOrder): string {
  return o.card.shipping?.name || o.card.billing?.name || o.card.customerEmail || '—';
}

// ---------- položka k odškrtnutí ----------

function PackItem({
  item, index, count, onAdd, onReset, onZoom, flash
}: {
  item: OrderCardItem; index: number; count: number;
  onAdd: () => void; onReset: () => void; onZoom: (it: OrderCardItem) => void;
  /** Krátké zvýraznění po načtení kódu — ať je vidět, co se právě odškrtlo */
  flash: boolean;
}) {
  const [broken, setBroken] = useState(false);
  const qty = Math.max(1, item.qty || 1);
  const many = qty > 1;
  const checked = count >= qty;
  const showImg = !!item.image && !broken;

  return (
    <div className={`pk-item ${checked ? 'checked' : ''} ${many ? 'many' : ''} ${flash ? 'flash' : ''}`}
      data-index={index}>
      {/*
        Ťuknutí přidá jeden kus, ne celou položku. U „3 ks" je právě tohle to
        jediné, co se při balení počítá — a když je hotovo, dalším ťuknutím se
        položka vynuluje, kdyby se člověk překlikl.
      */}
      <button className="pk-check" onClick={checked ? onReset : onAdd} aria-pressed={checked}
        data-tip={checked ? 'Zrušit odškrtnutí' : many ? `Přidat kus (${count}/${qty})` : 'Odškrtnout jako zabalené'}>
        {checked ? <Icon name="check" size={17} /> : <span className="pk-check-num">{index + 1}</span>}
      </button>

      <button className={`pk-photo ${showImg ? '' : 'empty'}`} disabled={!showImg}
        onClick={() => showImg && onZoom(item)} data-tip={showImg ? 'Zvětšit' : undefined}>
        {showImg
          ? <><img src={item.image!} alt="" referrerPolicy="no-referrer" onError={() => setBroken(true)} />
              <span className="pk-photo-zoom"><Icon name="expand" size={14} /></span></>
          : <Icon name="image" size={22} />}
      </button>

      <div className="pk-item-main" onClick={checked ? onReset : onAdd}>
        <div className="pk-item-title">{item.title}</div>
        <div className="pk-item-meta">
          {item.code && <span className="pk-code">{item.code}</span>}
          {item.variants.map((v, i) => <span key={i} className="pk-variant">{v}</span>)}
        </div>
      </div>

      {/* U víc kusů je vidět i to, kolik jich už je v krabici — jinak stačí počet */}
      <div className={`pk-qty ${many ? 'warn' : ''} ${many && checked ? 'full' : ''}`}>
        <span className="pk-qty-num">{many ? `${count}/${qty}` : qty}</span>
        <span className="pk-qty-unit">{item.unit || 'ks'}</span>
      </div>
    </div>
  );
}

// ---------- hlavní okno ----------

interface Props {
  onClose: () => void;
  onOpenMessage: (id: number) => void;
  /**
   * Číslo objednávky, na které se má okno rovnou otevřít.
   *
   * Chodí sem z proužku s prací z telefonu: klepnutí na „pokračovat tady"
   * má skončit u té krabice, kterou někdo balí, ne v seznamu, kde se k ní
   * musí doklikat — a která navíc nemusí do zvoleného období vůbec spadat.
   */
  openOrder?: string | null;
}

export default function PackingModal({ onClose, onOpenMessage, openOrder }: Props) {
  const toast = useToast();
  const [days, setDays] = useState(3);
  const [orders, setOrders] = useState<PackingOrder[]>([]);
  /**
   * Fáze, které se zrovna neukazují.
   *
   * Výchozí je **prázdná množina** — v seznamu je celé zvolené období včetně
   * odeslaného a stornovaného. Dřív se stavy schovávaly samy a nešlo se
   * podívat, co se za ten den odeslalo; kdo chce mít před sebou jen práci,
   * klikne na „K zabalení".
   */
  const [hidden, setHidden] = useState<Set<string>>(() => loadSet(LS_HIDDEN));
  /**
   * Nejstarší napřed je pořadí balení; nejnovější napřed pořadí přehledu.
   *
   * Volba se pamatuje jako velikost okna — kdo si přehodí pořadí, dělá to
   * proto, že tak pracuje, a přepínat to při každém otevření znamená, že
   * na to jednou zapomene a odbaví objednávky ve špatném pořadí.
   */
  const [oldestFirst, setOldestFirstState] = useState(
    () => localStorage.getItem('packingOldestFirst') !== '0'
  );
  const setOldestFirst = useCallback((next: boolean) => {
    setOldestFirstState(next);
    localStorage.setItem('packingOldestFirst', next ? '1' : '0');
  }, []);
  /**
   * Zaškrtnuté objednávky.
   *
   * Dokud není zaškrtnuté nic, platí vývoz na celý seznam — tak se to
   * používá nejčastěji. Jakmile se něco zaškrtne, jde do souboru i na
   * tiskárnu **jen výběr**; jinak by se u stolu snadno vytisklo o dvacet
   * faktur víc, než se balí.
   */
  const [picked, setPicked] = useState<Set<number>>(new Set());
  /** Vybraná země; prázdno = všechny. Do zahraničí jde jiný štítek i doba. */
  const [country, setCountry] = useState('');
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<PackingProgress | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  /**
   * Objednávka otevřená načtením faktury zůstane v seznamu, i když do
   * zvoleného období ani mezi zobrazené stavy nepatří — jinak by zmizela
   * hned, jak by se objevila.
   */
  const [pinned, setPinned] = useState<number | null>(null);
  /** Číslo objednávky nebo faktury napsané rukou — a čtečkou na počítači */
  const [lookup, setLookup] = useState('');
  const [looking, setLooking] = useState(false);
  /** Číslo šlo přečíst dvěma způsoby — druhá možnost k otevření */
  /**
   * Čím je zadané číslo.
   *
   * Z faktury se skenuje **jen číslo faktury** a objednávka se k němu dohledá
   * přes feed. Obě čísla se schválně nemíchají: číslo faktury jedné objednávky
   * může být zároveň číslem jiné objednávky, takže „když to nevyjde jako
   * faktura, zkus to jako objednávku" by tiše otevřelo cizí zboží. Kdo si
   * číslo objednávky opisuje z e-shopu, přepne si to tady.
   */
  const [findAs, setFindAs] = useState<'invoice' | 'code'>('invoice');
  const [zoom, setZoom] = useState<OrderCardItem | null>(null);
  /**
   * Velikost okna.
   *
   * Při balení se kouká hlavně do seznamu a do položek, takže se hodí okno
   * přes celou plochu; při rychlém nakouknutí mezi jinou prací zase malé.
   * Volba se pamatuje, protože kdo si okno jednou zvětší, chce ho velké
   * i příště.
   */
  const [size, setSize] = useState<'normal' | 'full' | 'mini'>(
    () => (localStorage.getItem('packingSize') as 'normal' | 'full' | 'mini') || 'normal'
  );
  const setWindowSize = useCallback((next: 'normal' | 'full' | 'mini') => {
    setSize(next);
    localStorage.setItem('packingSize', next);
  }, []);
  const [copied, setCopied] = useState(false);
  const phone = useIsPhone();
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const lastLoad = useRef(0);

  /* ---------- čtečka fotoaparátem (jen telefon) ---------- */
  const [hasCamera, setHasCamera] = useState(false);
  /** Kolik bodů shora zabírá hledáček — o to se rozhraní posune dolů */
  const [panelH, setPanelH] = useState(0);
  /** Upozornění „ještě 2 ks" a hlášky ze čtečky */
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);
  /** Naposledy odškrtnutá položka — krátce se zvýrazní */
  const [flash, setFlash] = useState<{ id: number; index: number } | null>(null);
  const selectedRef = useRef<number | null>(null);

  const load = useCallback(async (d: number, force = false) => {
    setLoading(true);
    try {
      const res = await api.packing.scan(d, force);
      setOrders(res.orders);
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setLoading(false);
      setProgress(null);
      lastLoad.current = Date.now();
      setLoadedAt(Date.now());
    }
  }, [toast]);

  useEffect(() => { void load(days); }, [days, load]);
  useEffect(() => api.on('packing:progress', p => setProgress(p as PackingProgress)), []);

  // Stavy stárnou — obnoví se samy po deseti minutách a taky pokaždé, když se
  // uživatel k oknu vrátí po delší pauze. Cache v main procesu zajistí, že
  // se stránky nestahují zbytečně často.
  useEffect(() => {
    const REFRESH_AFTER = 10 * 60_000;
    const stale = () => Date.now() - lastLoad.current > REFRESH_AFTER;
    const tick = () => { if (stale() && !loading) void load(days, true); };
    const t = setInterval(tick, 60_000);
    window.addEventListener('focus', tick);
    return () => { clearInterval(t); window.removeEventListener('focus', tick); };
  }, [days, load, loading]);

  /** Fáze u každé objednávky se počítá jednou — čte se z ní na třech místech */
  const phases = useMemo(() => {
    const map = new Map<number, PackPhase>();
    for (const one of orders) map.set(one.messageId, phaseOf(one));
    return map;
  }, [orders]);

  const counts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const one of orders) {
      const key = phases.get(one.messageId) ?? 'todo';
      out[key] = (out[key] ?? 0) + 1;
    }
    return out;
  }, [orders, phases]);

  /** Kolik objednávek jde do které země — podle toho se nabízí filtr */
  const countries = useMemo(() => {
    const out = new Map<string, number>();
    for (const one of orders) {
      const key = countryOf(one) || '??';
      out.set(key, (out.get(key) ?? 0) + 1);
    }
    return [...out.entries()].sort((a, b) => b[1] - a[1]);
  }, [orders]);

  const visible = useMemo(() => {
    const list = orders.filter(o => {
      if (o.messageId === pinned) return true;
      if (hidden.has(phases.get(o.messageId) ?? 'todo')) return false;
      return !country || countryOf(o) === country;
    });
    /*
     * Nejstarší napřed je výchozí, protože tak se balí: co čeká nejdél, jde
     * z fronty ven první. Kdo si jen prohlíží, co dnes přišlo, přepne.
     */
    return list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) * (oldestFirst ? 1 : -1));
  }, [orders, hidden, pinned, phases, oldestFirst, country]);

  /**
   * Rozdělení do dnů.
   *
   * Při měsíčním okně je v seznamu i dvě stě objednávek a bez data se v nich
   * nedá orientovat — „před 12 dny" u každého řádku je k ničemu, hlavička
   * s datem řekne totéž jednou pro celou skupinu.
   */
  const byDay = useMemo(() => {
    const out: { day: string; rows: PackingOrder[] }[] = [];
    for (const one of visible) {
      const day = dayOf(one.date);
      const last = out[out.length - 1];
      if (last && last.day === day) last.rows.push(one);
      else out.push({ day, rows: [one] });
    }
    return out;
  }, [visible]);

  /* ---------- faktury hromadně ---------- */

  /**
   * Faktury k viditelným objednávkám jedním kliknutím.
   *
   * Balení a tisk faktur je jedna práce: člověk vytiskne stoh faktur, podle
   * nich sbírá zboží a fakturu přiloží do krabice. Doteď se každá otvírala
   * v administraci zvlášť. Bere se přesně to, co je vidět v seznamu — tedy
   * i s filtrem stavů a období, aby se netiskly faktury k tomu, co se dnes
   * balit nebude.
   */
  const [invoicing, setInvoicing] = useState(false);
  const [invDone, setInvDone] = useState<{ done: number; total: number } | null>(null);
  useEffect(() => api.on('invoices:progress', p => setInvDone(p as { done: number; total: number })), []);

  /** Objednávky, na které se vývoz vztahuje: výběr, nebo celý seznam */
  const chosen = useMemo(
    () => (picked.size > 0 ? visible.filter(o => picked.has(o.messageId)) : visible),
    [visible, picked]
  );

  const withInvoice = useMemo(
    () => chosen.filter(o => (o.shop?.invoice ?? '').trim())
      .map(o => o.card.orderNumber ?? '')
      .filter(code => code !== ''),
    [chosen]
  );

  /** Zaškrtnutí, které přežije přeskládání seznamu — drží se na ID objednávky */
  const togglePick = useCallback((id: number) => setPicked(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  }), []);

  /** Celý den jedním kliknutím — a druhým zase pryč */
  const toggleDay = useCallback((rows: PackingOrder[]) => setPicked(prev => {
    const next = new Set(prev);
    const allIn = rows.every(one => next.has(one.messageId));
    for (const one of rows) { if (allIn) next.delete(one.messageId); else next.add(one.messageId); }
    return next;
  }), []);

  /**
   * Stahování dopředu.
   *
   * Tisk faktur přijde ve chvíli, kdy člověk stojí u tiskárny — a tam je
   * čekání na sto stažení nejhorší. Jakmile je tedy seznam objednávek
   * načtený, začnou se faktury po jedné stahovat na pozadí. Když se to
   * nepovede (třeba kvůli odhlášení), nic se neoznamuje: pozná se to až při
   * tisku, kde se s tím dá něco udělat.
   */
  const [invReady, setInvReady] = useState(0);
  useEffect(() => {
    if (phone || withInvoice.length === 0) return;
    let alive = true;
    api.invoices.ready(withInvoice).then(one => { if (alive) setInvReady(one.ready); }).catch(() => {});
    const timer = setTimeout(() => {
      api.invoices.prefetch(withInvoice)
        .then(one => { if (alive) setInvReady(one.ready); })
        .catch(() => {});
    }, 1500);
    return () => { alive = false; clearTimeout(timer); };
  }, [withInvoice, phone]);
  useEffect(() => api.on('invoices:ready', p => setInvReady((p as { ready: number }).ready)), []);

  /**
   * Zásilky pro PPL.
   *
   * Bere se totéž, co je v seznamu — a z toho jen ty objednávky, které jedou
   * PPL. Soubor se uloží a rovnou se otevře import v jejich administraci
   * i s vloženým souborem; poslední kliknutí („Vlož") zůstává na člověku,
   * protože nahrání zásilek je nevratné.
   */
  const [pplBusy, setPplBusy] = useState(false);
  const pplCandidates = useMemo(
    () => chosen.map(o => o.card.orderNumber ?? '').filter(Boolean),
    [chosen]
  );

  /**
   * Poznámky zákazníků před vývozem.
   *
   * Poznámka je cizí text a končí na štítku, který uvidí kurýr — schválit
   * ji musí člověk, který si ji přečetl. Když žádná není, nic se neptá
   * a vývoz jde rovnou.
   */
  const [noteAsk, setNoteAsk] = useState<
    { notes: OrderNote[]; limit: number; carrier: string; run: (approved: ApprovedNote[]) => void } | null
  >(null);
  /*
   * Schvaluje se **každá poznámka zvlášť**. Jedna bývá pokyn pro kurýra
   * („zvoňte na Nováka"), druhá vzkaz pro nás, který na štítku nemá co
   * dělat — jedním „ano" na všechno by se to nedalo rozlišit.
   */
  const [notePicked, setNotePicked] = useState<Record<string, boolean>>({});
  /*
   * Text, který půjde dopravci. Dlouhou poznámku je potřeba přepsat ručně:
   * PPL delší text uřízne **uprostřed slova** — z „Prosím kurýra zavolat
   * před domem" vytiskla „Prosím kurýra zavolat před dom". Nechat to na
   * automatickém zkrácení znamená, že smysl věty určí náhoda.
   */
  const [noteText, setNoteText] = useState<Record<string, string>>({});

  const askNotes = useCallback(async (
    carrier: string, label: string, run: (approved: ApprovedNote[]) => Promise<void>
  ) => {
    let found: OrderNote[] = [];
    let limit = 100;
    try {
      const answer = await api.ship.notes(pplCandidates, carrier);
      found = answer.notes;
      limit = answer.limit;
    } catch {
      // Nepovedlo se zjistit poznámky — vývoz se kvůli tomu nezastavuje
      found = [];
    }
    if (found.length === 0) { await run([]); return; }
    // Ve výchozím stavu jsou zaškrtnuté všechny: nejčastěji jde poznámka na štítek
    setNotePicked(Object.fromEntries(found.map(one => [one.code, true])));
    setNoteText(Object.fromEntries(found.map(one => [one.code, one.short])));
    setNoteAsk({
      notes: found, limit, carrier: label,
      run: (approved: ApprovedNote[]) => { setNoteAsk(null); void run(approved); }
    });
  }, [pplCandidates]);

  const exportPpl = useCallback(() => askNotes('ppl', 'PPL', async (approved: ApprovedNote[]) => {
    setPplBusy(true);
    try {
      const out = await api.ppl.export(pplCandidates, approved);
      if (!out.file) {
        toast(out.skipped.length > 0
          ? `Ve výběru není žádná zásilka PPL (${out.skipped.length} objednávek jede jinak).`
          : 'Nic k vývozu.', 'info');
        return;
      }
      toast(`Vyvezeno ${out.rows} zásilek${out.skipped.length ? `, ${out.skipped.length} vynecháno` : ''}`
        + `${out.notes ? `, z toho ${out.notes} s poznámkou` : ''}.`);
      if (approved.length > 0) {
        toast('Sloupec s poznámkou je na konci souboru — v mapování PPL na něj musí být pole.', 'info');
      }
      const opened = await api.ppl.openImport(out.file);
      toast(opened.note, opened.filled ? 'info' : 'error');
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setPplBusy(false);
    }
  }), [pplCandidates, toast, askNotes]);

  /**
   * Zásilkovna: založit zásilky a stáhnout štítky.
   *
   * Dva kroky za sebou, protože tak to při balení jde: nejdřív se zásilky
   * založí (a co nešlo, řekne se proč), a hned nato se stáhne jeden arch se
   * štítky. Zásilka už jednou založená se nezakládá znovu — z jedné
   * objednávky by byly dva balíky.
   */
  const [zasBusy, setZasBusy] = useState(false);

  const sendPacketa = useCallback(() => askNotes('packeta', 'Zásilkovnu', async (approved: ApprovedNote[]) => {
    setZasBusy(true);
    try {
      const out = await api.packeta.create(pplCandidates, approved);
      if (out.created.length === 0) {
        toast(out.failed[0]?.reason
          ? `Zásilkovna: ${out.failed[0].reason}`
          : 'Ve výběru není žádná zásilka pro Zásilkovnu.', 'error');
        return;
      }
      toast(`Založeno ${out.created.length} zásilek${out.failed.length ? `, ${out.failed.length} ne` : ''}. Stahuji štítky…`);
      const labels = await api.packeta.labels(out.created.map(one => one.code));
      if (labels.file) toast(`Štítky uložené (${labels.count} ks) — ${labels.file}`);
      else toast('Uložení štítků zrušeno.', 'info');
      if (out.failed.length > 0) {
        toast(`Nepovedlo se: ${out.failed.map(one => `${one.code} — ${one.reason}`).join(' · ')}`, 'error');
      }
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setZasBusy(false);
    }
  }), [pplCandidates, toast, askNotes]);

  /**
   * Balíkovna přes Podání Online.
   *
   * Stejná cesta jako u PPL — soubor a ruční nahrání — jen jiný formát
   * a jiné místo. Podání se neodesílá: je nevratné a účtuje se.
   */
  const [balBusy, setBalBusy] = useState(false);

  const exportBalikovna = useCallback(() => askNotes('balikovna', 'Balíkovnu', async (approved: ApprovedNote[]) => {
    setBalBusy(true);
    try {
      const out = await api.balikovna.export(pplCandidates, approved);
      if (!out.file) {
        toast(out.skipped.length > 0
          ? `Ve výběru není žádná zásilka Balíkovny (${out.skipped.length} objednávek jede jinak).`
          : 'Nic k vývozu.', 'info');
        return;
      }
      toast(`Vyvezeno ${out.rows} zásilek do ${out.columns} sloupců`
        + `${out.notes ? `, z toho ${out.notes} s poznámkou` : ''}.`);
      if (approved.length > 0) {
        toast('Sloupec „Poznámka" je v souboru navíc — musí být i v konfiguraci importu.', 'info');
      }
      /*
       * Okno zůstane otevřené a čeká: než se člověk přihlásí a proklikne
       * k importu, může to trvat minuty. Jakmile se políčko na soubor
       * objeví, aplikace do něj soubor vloží sama.
       */
      toast('Otevírám Podání Online — přihlas se a jdi na import, soubor tam vložím.', 'info');
      const opened = await api.balikovna.openImport(out.file);
      toast(opened.note, opened.filled ? 'info' : 'error');
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBalBusy(false);
    }
  }), [pplCandidates, toast, askNotes]);

  const grabInvoices = useCallback(async () => {
    if (withInvoice.length === 0) return;
    setInvoicing(true);
    setInvDone({ done: 0, total: withInvoice.length });
    try {
      const run = await api.invoices.download(withInvoice);
      /*
       * Dvě zvláštní odpovědi, dvě různé opravy — a obě má smysl nabídnout
       * rovnou, ne jen oznámit. „Nepovedlo se" bez další cesty je slepá ulička.
       */
      if (run.needsTemplate) {
        toast('Aplikace ještě neví, kde faktura v administraci je. Otevři jednu a zapamatuje si to.', 'info');
        const learned = await api.invoices.learn();
        if ('error' in learned) toast(learned.error, 'error');
        else {
          toast(`Adresa faktury naučená (podle: ${learned.kind}). Zkus stažení znovu.`);
        }
        return;
      }
      if (run.needsLogin) {
        toast('Administrace chce přihlásit — otevírám okno, pak zkus stažení znovu.', 'info');
        await api.invoices.login();
        return;
      }
      if (run.ok === 0) {
        toast(run.failed[0]?.reason ? `Faktury se nestáhly: ${run.failed[0].reason}` : 'Nestáhla se žádná faktura.', 'error');
        return;
      }
      if (!run.file) { toast('Uložení zrušeno.', 'info'); return; }
      toast(
        run.failed.length > 0
          ? `Uloženo ${run.ok} faktur (${run.pages} stran), ${run.failed.length} se nepovedlo.`
          : `Uloženo ${run.ok} faktur, ${run.pages} stran — připraveno k tisku.`,
        'info'
      );
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setInvoicing(false);
      setInvDone(null);
    }
  }, [withInvoice, toast]);

  /** Klik na dlaždici fázi schová nebo vrátí; s Altem zůstane jen ona */
  const togglePhase = (key: PackPhase, only = false) => setHidden(prev => {
    const next = only
      ? new Set(PHASES.map(one => one.key).filter(one => one !== key) as string[])
      : new Set(prev);
    if (!only) { if (next.has(key)) next.delete(key); else next.add(key); }
    // Všechno schované by byl prázdný seznam bez vysvětlení — to je chyba, ne filtr
    if (next.size >= PHASES.length) next.delete(key);
    saveSet(LS_HIDDEN, next);
    return next;
  });

  /**
   * Co se otevře samo.
   *
   * První k zabalení, ne první v seznamu. Od chvíle, kdy je v seznamu celé
   * období, je nahoře většinou něco stornovaného nebo doručeného — a otevřít
   * po startu výstrahu „stará objednávka" místo práce je špatně.
   *
   * Na telefonu se nevybírá nic: je vidět vždy jen jedna část, takže by se
   * rovnou otevřela objednávka a seznam by uživatel nikdy neviděl.
   */
  const firstToPack = useCallback(() => {
    const work = visible.find(o => (phases.get(o.messageId) ?? 'todo') === 'todo');
    return (work ?? visible[0]).messageId;
  }, [visible, phases]);

  useEffect(() => {
    if (visible.length === 0) { setSelected(null); return; }
    if (selected !== null && !visible.some(o => o.messageId === selected)) {
      setSelected(phone ? null : firstToPack());
      return;
    }
    if (selected === null && !phone) setSelected(firstToPack());
  }, [visible, selected, phone, firstToPack]);

  const current = visible.find(o => o.messageId === selected) ?? null;

  // Nová objednávka začíná odshora — po skenování bývá seznam odrolovaný
  useEffect(() => {
    const box = document.querySelector('.pk-detail .pk-scroll');
    if (box) box.scrollTop = 0;
  }, [selected]);

  const patch = (id: number, fn: (o: PackingOrder) => PackingOrder) =>
    setOrders(prev => prev.map(o => (o.messageId === id ? fn(o) : o)));

  const patchState = (id: number, st: { packed: number[]; counts: Record<string, number> }) =>
    patch(id, x => ({ ...x, packed: st.packed, counts: st.counts }));

  /*
   * Odškrtnutí z druhého zařízení.
   *
   * Do databáze se zapsalo hned, ale otevřené okno drží objednávky ve své
   * paměti — bez tohohle by v ní zůstal starý stav a člověk by koukal na
   * položku odškrtnutou v telefonu a neodškrtnutou na obrazovce. Zapisuje se
   * jen do té jedné objednávky: přenačíst celý seznam by u toho, kdo zrovna
   * balí, poskočilo rolování.
   */
  useEffect(() => api.on('packing:changed', (st: any) => {
    if (!st || typeof st.id !== 'number') return;
    patch(st.id, x => ({
      ...x,
      packed: Array.isArray(st.packed) ? st.packed : x.packed,
      counts: st.counts && typeof st.counts === 'object' ? st.counts : x.counts,
      done: !!st.done,
      doneAt: st.doneAt ?? null
    }));
  }), []);

  const countOf = (o: PackingOrder, index: number) => o.counts?.[String(index)] ?? 0;

  /**
   * Hláška nad seznamem — upozornění, že položky je v objednávce víc kusů,
   * a odpovědi čtečky. Na telefonu se totéž pošle i do hledáčku, protože kdo
   * míří fotoaparátem na štítek, se na obrazovku pod ním nedívá.
   */
  const say = useCallback((text: string, ok: boolean, inPage = true) => {
    if (inPage) setNote({ text, ok });
    if (!ok) navigator.vibrate?.(60);
    api.scan.feedback(text, ok).catch(() => { /* čtečka nemusí být otevřená */ });
  }, []);

  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), note.ok ? 2600 : 4000);
    return () => clearTimeout(t);
  }, [note]);

  useEffect(() => {
    if (!flash) return;
    // Při skenování bývá seznam delší než okno — odškrtnutá položka musí být vidět
    document.querySelector(`.pk-items .pk-item[data-index="${flash.index}"]`)
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    const t = setTimeout(() => setFlash(null), 900);
    return () => clearTimeout(t);
  }, [flash]);

  /** Přidá jeden kus položky — a řekne, kolik jich ještě chybí. */
  const addPiece = useCallback(async (id: number, index: number) => {
    const o = orders.find(x => x.messageId === id);
    if (!o) return;
    const item = o.card.items[index];
    const qty = Math.max(1, item?.qty || 1);
    const next = Math.min(qty, countOf(o, index) + 1);
    try {
      const st = await api.packing.setCount(id, index, next);
      patchState(id, st);
      setFlash({ id, index });
      if (qty > 1) {
        const missing = qty - next;
        say(missing > 0
          ? `${item.title} — ${next}/${qty} ks, ještě ${missing}`
          : `${item.title} — všech ${qty} ks hotovo`, missing === 0);
      }
    } catch (e: any) { toast(e.message, 'error'); }
  }, [orders, say, toast]);

  /** Vynuluje položku — ťuknutí na hotovou položku, kdyby se člověk překlikl. */
  const resetPiece = useCallback(async (id: number, index: number) => {
    try { patchState(id, await api.packing.setCount(id, index, 0)); }
    catch (e: any) { toast(e.message, 'error'); }
  }, [toast]);

  const markDone = async (id: number, value: boolean) => {
    patch(id, x => ({ ...x, done: value, doneAt: value ? new Date().toISOString() : null }));
    try { await api.packing.setDone(id, value); }
    catch (e: any) { toast(e.message, 'error'); }
    if (value) {
      // Po dokončení rovnou skočíme na další objednávku ve frontě
      const idx = visible.findIndex(o => o.messageId === id);
      const next = visible[idx + 1] ?? visible[idx - 1] ?? null;
      // Skok na další jen tehdy, když zabalené ze seznamu mizí — jinak by
      // aplikace odskočila jinam, než kam se člověk dívá
      if (next && hidden.has('packed')) setSelected(next.messageId);
    }
  };

  const resetOrder = async (id: number) => {
    patch(id, x => ({ ...x, packed: [], counts: {}, done: false, doneAt: null }));
    try { await api.packing.reset(id); } catch { /* nevadí, přepíše se příštím odškrtnutím */ }
  };

  /** Otevře potvrzovací e-mail — u objednávky z feedu se zpráva teprve hledá. */
  const openMail = useCallback(async (order: PackingOrder) => {
    if (order.source !== 'feed') { onOpenMessage(order.messageId); return; }
    try {
      const id = await api.packing.mailFor(order.card.orderNumber ?? '');
      if (id) onOpenMessage(id);
      else toast('K téhle objednávce ve schránce potvrzovací e-mail nemám.');
    } catch (e: any) {
      toast(e.message, 'error');
    }
  }, [onOpenMessage, toast]);

  const copyAddress = async () => {
    const a = current?.card.shipping ?? current?.card.billing;
    if (!a) return;
    await navigator.clipboard.writeText([a.name, a.company, ...a.lines, a.country].filter(Boolean).join('\n'));
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  // Klávesy: šipky mezi objednávkami, 1–9 odškrtnutí položky, Esc zavírá
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { if (zoom) setZoom(null); else onClose(); return; }
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const idx = visible.findIndex(o => o.messageId === selected);
        const next = visible[idx + (e.key === 'ArrowDown' ? 1 : -1)];
        if (next) setSelected(next.messageId);
        return;
      }
      if (current && /^[1-9]$/.test(e.key)) {
        const i = Number(e.key) - 1;
        if (i < current.card.items.length) { e.preventDefault(); void addPiece(current.messageId, i); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, selected, current, zoom, onClose, addPiece]);

  const allPacked = !!current && current.card.items.every((_, i) => current.packed.includes(i));

  /* ---------- čtení kódů fotoaparátem ---------- */

  useEffect(() => { api.scan.available().then(setHasCamera).catch(() => setHasCamera(false)); }, []);
  useEffect(() => { selectedRef.current = selected; }, [selected]);

  /**
   * Přidá načtenou objednávku do seznamu a otevře ji.
   *
   * Stará objednávka do zvoleného období nespadá a její stav bývá schovaný,
   * takže se připíchne. U konečného stavu (doručeno, storno) se rovnou ozve
   * výstraha — kdo balí, musí se to dozvědět dřív, než sáhne po krabici.
   */
  const openFound = useCallback((found: PackingOrder) => {
    // Hláška od předchozí objednávky by nad tou novou jen mátla
    setNote(null);
    setFlash(null);
    setOrders(prev => {
      const rest = prev.filter(o => o.messageId !== found.messageId);
      return [found, ...rest];
    });
    setPinned(found.messageId);
    setSelected(found.messageId);
    selectedRef.current = found.messageId;

    // Hlásí se to číslo, které je na papíře v ruce — tedy z faktury
    const number = numbers(found).main;
    if (found.shop?.final) {
      // Totéž hlásí červený pruh nad seznamem, tak ať to nestojí dvakrát pod sebou
      say(`Faktura ${number} — ${found.shop.status}${found.shop.at ? `, ${dayOf(found.shop.at)}` : ''}`,
        false, false);
    } else if (found.done) {
      say(`Faktura ${number} už je označená jako zabalená`, false);
    } else {
      say(`Faktura ${number} otevřena`, true);
    }
  }, [say]);

  /*
   * Hledáček zůstane otevřený a kódy chodí po jednom. Načte se dvojí:
   * číslo z faktury, kterým se otevře objednávka, a kódy produktů, kterými se
   * odškrtávají kusy. Rozlišit se to předem nedá — faktura i štítek jsou QR —
   * takže se nejdřív zkusí položka v otevřené objednávce a teprve když tam
   * kód není, hledá se objednávka. Odpověď jde zpátky do hledáčku: kdo míří
   * telefonem na štítek, se na obrazovku pod ním nedívá.
   */
  useEffect(() => {
    if (!panelH) return;

    const off = api.on('scan:code', async (payload: any) => {
      const text = String(payload?.text ?? '').trim();
      if (!text) return;

      const id = selectedRef.current;
      if (id !== null) {
        const hit = await api.packing.scanItem(id, text).catch(() => null);
        if (hit?.ok) {
          setFlash({ id, index: hit.index ?? -1 });
          patch(id, x => ({
            ...x,
            counts: { ...x.counts, [String(hit.index)]: hit.count ?? 0 },
            packed: (hit.count ?? 0) >= (hit.qty ?? 1)
              ? [...new Set([...x.packed, hit.index!])].sort((a, b) => a - b)
              : x.packed.filter(i => i !== hit.index)
          }));
          say(hit.message, (hit.needMore ?? 0) === 0);
          return;
        }
        if (hit && hit.reason === 'already') { say(hit.message, false); return; }
      }

      // Čtečka čte doklad, a na dokladu je číslo faktury — nic jiného
      const out = await api.packing.openOrder(text, 'invoice').catch(() => null);
      if (out?.ok) { openFound(out.order); return; }
      // Hláška z hledání říká, kde to skončilo — na feedu, nebo na položkách
      say(out?.message ?? `Kód ${text} v objednávce není`, false);
    });

    const offClosed = api.on('scan:closed', () => setPanelH(0));
    return () => { off(); offClosed(); };
  }, [panelH, say, openFound]);

  /**
   * Hledání rukou — a na počítači i čtečkou, ta se chová jako klávesnice.
   *
   * Bez pole by šlo číslo zadat jedině fotoaparátem, takže na počítači vůbec.
   */
  const findByNumber = useCallback(async (text: string, as: 'invoice' | 'code' = 'invoice') => {
    const value = text.trim();
    if (!value || looking) return;
    setLooking(true);
    try {
      const out = await api.packing.openOrder(value, as);
      if (out.ok) { openFound(out.order); setLookup(''); }
      else say(out.message, false);
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setLooking(false);
    }
  }, [looking, openFound, say, toast]);

  /*
   * Objednávka z proužku „pracuje se na tomhle". Otevře se jednou, hned po
   * otevření okna: v seznamu být nemusí (může být starší, než sahá zvolené
   * období), takže se dohledá stejnou cestou jako opsané číslo objednávky.
   */
  const jumped = useRef(false);
  useEffect(() => {
    if (!openOrder || jumped.current) return;
    jumped.current = true;
    void findByNumber(openOrder, 'code');
  }, [openOrder, findByNumber]);

  /*
   * „Právě balím tuhle." Posílá se při každém otevření objednávky, ne až
   * při prvním odškrtnutí — rozhodnutí padne dřív a druhé zařízení má
   * nabídnout pokračování hned.
   */
  useEffect(() => {
    if (selected === null) return;
    api.packing.working(selected).catch(() => {});
  }, [selected]);

  /*
   * Dokud je tohle okno otevřené, nic se u balení nenabízí proužkem.
   *
   * Kdo balení otevřel, ten se rozhodl u toho být — a když se v telefonu
   * proklikají čtyři objednávky, hromadily se pod oknem čtyři nabídky, které
   * se po zavření musely jedna po druhé odklikat. Místo toho se okno rovnou
   * přepne na tu, u které se právě stojí.
   */
  useEffect(() => {
    api.live.watch('packing', true).catch(() => {});
    return () => { api.live.watch('packing', false).catch(() => {}); };
  }, []);

  useEffect(() => api.on('live:work', (work: any) => {
    if (work?.kind !== 'packing' || !work.id) return;
    // Už je otevřená — přepínat není co
    const open = orders.find(o => o.messageId === selectedRef.current);
    if ((open?.shop?.code ?? '') === String(work.id)) return;
    void findByNumber(String(work.id), 'code');
  }), [orders, findByNumber]);

  const toggleCamera = async () => {
    if (panelH) { await api.scan.stop().catch(() => {}); setPanelH(0); return; }
    try {
      // Hledáček jen nahoře — pod ním musí zůstat vidět seznam položek
      const out = await api.scan.start({ panel: true, qty: false });
      setPanelH(Number(out?.panel) || 0);
    } catch (e: any) { toast(e.message, 'error'); }
  };

  // Okno se zavírá i s otevřeným hledáčkem — ten by jinak zůstal viset nad ním
  useEffect(() => () => { void api.scan.stop().catch(() => {}); }, []);

  /**
   * Dotaz před vývozem: co zákazníci napsali a jestli to má vidět dopravce.
   *
   * Ukazuje se celý text i to, co se z něj vejde na štítek — kdyby se
   * schvalovala jen věta „tři objednávky mají poznámku", nedalo by se
   * rozhodnout.
   */
  const notesDialog = noteAsk && (
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) setNoteAsk(null); }}>
      <div className="modal" style={{ width: 'min(640px, 94vw)' }}>
        <div className="modal-head">
          <span className="modal-title"><Icon name="pen" size={15} /> Poznámky od zákazníků</span>
          <button className="icon-btn" onClick={() => setNoteAsk(null)}><Icon name="x" size={16} /></button>
        </div>
        <div className="modal-body">
          <p className="desc">
            {noteAsk.notes.length === 1 ? 'Jedna objednávka má' : `${noteAsk.notes.length} objednávek má`}
            {' '}poznámku od zákazníka. Zaškrtnutá půjde na štítek pro {noteAsk.carrier} — přečte si ji kurýr.
            Odškrtni tu, která je vzkaz pro nás. Na štítek se vejde {noteAsk.limit} znaků;
            delší text si dopravce uřízne sám, i uprostřed slova, tak ho radši přepiš.
          </p>
          <div className="pk-notes">
            {noteAsk.notes.map(one => {
              const text = noteText[one.code] ?? one.short;
              const over = one.note.length > noteAsk.limit;
              return (
                <div className={`pk-notes-row ${notePicked[one.code] ? 'on' : ''}`} key={one.code}>
                  <label className="pk-notes-head">
                    <input
                      type="checkbox"
                      checked={!!notePicked[one.code]}
                      onChange={e => setNotePicked(p => ({ ...p, [one.code]: e.target.checked }))}
                    />
                    <b>{one.code}</b>
                    <span className="desc">{one.name}</span>
                  </label>
                  {/*
                    * Celá poznámka zůstává vidět, i když se posílá jen její
                    * část — bez originálu se nedá poznat, co se ztratilo.
                    */}
                  <p>{one.note}</p>
                  {notePicked[one.code] && (
                    <div className="pk-notes-edit">
                      <textarea
                        rows={2}
                        maxLength={noteAsk.limit}
                        value={text}
                        onChange={e => setNoteText(p => ({ ...p, [one.code]: e.target.value }))}
                      />
                      <span className={`pk-notes-count ${text.length >= noteAsk.limit ? 'full' : ''}`}>
                        {text.length}/{noteAsk.limit}
                      </span>
                      {over && (
                        <span className="desc">
                          Poznámka je delší, než co dopravce vytiskne — tohle je zkrácení
                          na hranici slova, přepiš ho, jak potřebuješ.
                        </span>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn ghost" onClick={() => setNoteAsk(null)}>Zrušit</button>
          <button className="btn ghost" onClick={() => noteAsk.run([])}>Vyvézt bez poznámek</button>
          <button
            className="btn primary"
            onClick={() => noteAsk.run(noteAsk.notes
              .filter(one => notePicked[one.code] && (noteText[one.code] ?? one.short).trim())
              .map(one => ({ code: one.code, text: (noteText[one.code] ?? one.short).trim() })))}
          >
            {(() => {
              const picked = noteAsk.notes.filter(one => notePicked[one.code]).length;
              return picked === noteAsk.notes.length
                ? 'Přidat poznámky'
                : picked === 0 ? 'Vyvézt bez poznámek' : `Přidat vybrané (${picked})`;
            })()}
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      {notesDialog}
      {/* Na telefonu je vidět vždy jen jedna část — seznam, nebo rozepsaná objednávka */}
      <div className={`modal pk-modal pk-${size}`} data-pane={selected ? 'detail' : 'list'}
        data-scan={panelH ? 'on' : undefined}
        style={panelH ? { paddingTop: panelH } : undefined}>
        <div className="modal-head">
          <div className="modal-title"><Icon name="bag" size={16} /> Balení objednávek</div>
          <span style={{ flex: 1 }} />
          {/*
            * Skenování je při balení to hlavní, co se dělá — ne jedna ikona
            * z řady. Načtení faktury otevírá objednávku a pípnutí kódu
            * odškrtává kus, takže se na tohle tlačítko sahá u každé krabice
            * několikrát. Proto je barevné a s popiskem, aby se trefilo
            * palcem napoprvé.
            */}
          {hasCamera && (
            <button className={`btn ${panelH ? 'ghost' : 'primary'} pk-scan`} onClick={toggleCamera}
              data-tip={panelH ? 'Zavřít čtečku' : 'Skenovat faktury a kódy produktů'}>
              <Icon name="camera" size={15} /> {panelH ? 'Zavřít' : 'Scan'}
            </button>
          )}
          <button className="icon-btn" disabled={loading} data-tip="Načíst znovu včetně stavů"
            onClick={() => load(days, true)}>
            <Icon name="refresh" size={15} className={loading ? 'spinning' : undefined} />
          </button>
          {/*
            Velikost okna. Při balení se kouká do seznamu i do položek a hodí
            se celá plocha; při nakouknutí mezi jinou prací zase malé okno.
          */}
          {!phone && (
            <>
              <button className="icon-btn" data-tip={size === 'mini' ? 'Obnovit velikost' : 'Zmenšit'}
                onClick={() => setWindowSize(size === 'mini' ? 'normal' : 'mini')}>
                <Icon name={size === 'mini' ? 'expand' : 'minus'} size={15} />
              </button>
              <button className="icon-btn" data-tip={size === 'full' ? 'Obnovit velikost' : 'Na celou plochu'}
                onClick={() => setWindowSize(size === 'full' ? 'normal' : 'full')}>
                <Icon name={size === 'full' ? 'shrink' : 'expand'} size={15} />
              </button>
            </>
          )}
          <button className="icon-btn" onClick={onClose} data-tip="Zavřít"><Icon name="x" size={16} /></button>
        </div>

        <div className="pk-filters">
          <div className="pk-seg">
            {WINDOWS.map(w => (
              <button key={w.days} className={`pk-seg-btn ${days === w.days ? 'on' : ''}`}
                onClick={() => setDays(w.days)}>{w.label}</button>
            ))}
          </div>
          {/*
            Fáze místo seznamu stavů. Stavů má e-shop dvacet, ale při balení
            rozhoduje jedna otázka — mám to teď zabalit? — a na tu stačí pět
            skupin. Číslo u každé je zároveň odpověď na „kolik toho ještě je".
            Klik fázi schová nebo vrátí, klik se Shiftem nechá jen ji.
          */}
          <div className="pk-phases">
            {PHASES.filter(one => (counts[one.key] ?? 0) > 0).map(one => (
              <button key={one.key}
                className={`pk-phase ${one.key} ${hidden.has(one.key) ? 'off' : ''}`}
                data-tip={`${one.hint}${hidden.has(one.key) ? ' · schované' : ''} — Shift+klik nechá jen tuhle skupinu`}
                onClick={e => togglePhase(one.key, e.shiftKey)}>
                <span className="pk-phase-dot" />
                {one.label}
                <b>{counts[one.key]}</b>
              </button>
            ))}
          </div>
          <button className="filter-chip" onClick={() => setOldestFirst(!oldestFirst)}
            data-tip="Nejstarší napřed je pořadí balení — co čeká nejdéle, jde z fronty první">
            <Icon name="sort" size={12} /> {oldestFirst ? 'nejstarší' : 'nejnovější'}
          </button>
          {/*
            Země. Nabízí se, jen když je co filtrovat — u e-shopu, kde jde
            všechno do Česka, by to byl chip navíc bez užitku.
          */}
          {countries.length > 1 && (
            <div className="pk-lands">
              {countries.map(([code, count]) => (
                <button key={code}
                  className={`filter-chip ${country === code ? 'on' : ''}`}
                  data-tip={`Jen objednávky do ${code === '??' ? 'neznámé země' : code}`}
                  onClick={() => setCountry(v => (v === code ? '' : code))}>
                  {flagOf(code)} {code} <b>{count}</b>
                </button>
              ))}
            </div>
          )}

        </div>

        {/*
          Druhý řádek: hledání a vývoz.

          Dřív to viselo v jednom řádku s filtry a podle toho, kolik bylo
          zrovna fází, se tlačítka přelévala jednou nahoru a jednou dolů —
          při práci se pak trefovalo naslepo. Teď má vývoz svůj řádek a je
          pokaždé na stejném místě.
        */}
        <div className="pk-filters pk-second">
          {/*
            Číslo z dokladu. Na počítači je to jediná cesta, jak objednávku
            najít — čtečka se chová jako klávesnice a kód sem spadne i s
            Enterem, takže výchozí je faktura. Přepínač je vedle proto, aby
            bylo pokaždé vidět, které z těch dvou čísel se zrovna hledá.
          */}
          <form className="pk-find" onSubmit={e => { e.preventDefault(); void findByNumber(lookup, findAs); }}>
            <Icon name="search" size={13} />
            <input value={lookup} onChange={e => setLookup(e.target.value)}
              inputMode="numeric"
              placeholder={findAs === 'invoice' ? 'číslo faktury' : 'číslo objednávky'}
              aria-label={findAs === 'invoice'
                ? 'Najít objednávku podle čísla faktury'
                : 'Najít objednávku podle čísla objednávky'} />
            <span className="pk-as">
              <button type="button" className={findAs === 'invoice' ? 'on' : ''}
                onClick={() => setFindAs('invoice')}
                data-tip="Číslo z faktury; objednávka se k němu dohledá ve feedu">faktura</button>
              <button type="button" className={findAs === 'code' ? 'on' : ''}
                onClick={() => setFindAs('code')}
                data-tip="Číslo objednávky opsané z e-shopu">objednávka</button>
            </span>
            {looking && <span className="spinner-inline" />}
          </form>
          {/*
            Vývoz a doklady drží pohromadě.

            Tlačítka byla rozsypaná mezi filtry a Zásilkovna se jako jediná
            lámala na druhý řádek — vypadalo to, že patří jinam než PPL kousek
            od ní. Teď je to jedna skupina: zalomí se celá, nebo žádná.
            Na telefonu se netiskne ani nepodává, tam by jen zabírala místo.
          */}
          {!phone && (
            <div className="pk-ship">
              {/*
                Stáhnout znovu. Faktury se drží v meziskladu, aby byl tisk
                okamžitý — jenže po opravě adresy tam leží ty stažené tou
                starou, špatnou. Tohle je vyhodí.
              */}
              <button className="filter-chip pk-again" data-tip="Zahodí stažené faktury a příště je stáhne znovu"
                onClick={() => {
                  api.invoices.forget([])
                    .then(out => {
                      setInvReady(0);
                      toast(out.removed > 0
                        ? `Zahozeno ${out.removed} stažených faktur — příště se stáhnou znovu.`
                        : 'Mezisklad byl prázdný.');
                    })
                    .catch(e => toast(e.message, 'error'));
                }}>
                <Icon name="refresh" size={12} />
              </button>
              <button className="filter-chip" disabled={invoicing || withInvoice.length === 0}
                onClick={() => void grabInvoices()}
                data-tip={withInvoice.length === 0
                  ? 'K žádné zobrazené objednávce zatím není vystavená faktura'
                  : invReady >= withInvoice.length
                    ? 'Všechny faktury jsou stažené — tisk bude okamžitý'
                    : `Stáhne faktury k zobrazeným objednávkám do jednoho PDF k tisku (${invReady} už je po ruce)`}>
                {invoicing
                  ? <><span className="spinner-inline" /> {invDone ? `${invDone.done}/${invDone.total}` : 'stahuji…'}</>
                  : <><Icon name="printer" size={12} /> Faktury ({withInvoice.length})
                      {/* Kolik z nich je stažených dopředu — ať je vidět, že se čekat nebude */}
                      {invReady > 0 && invReady < withInvoice.length && <span className="pk-inv-ready"> · {invReady} hotovo</span>}
                      {invReady > 0 && invReady >= withInvoice.length && <Icon name="check" size={11} />}
                    </>}
              </button>

              {/* PPL: soubor a import v jejich administraci — API nemají */}
              <button className="filter-chip" disabled={pplBusy || pplCandidates.length === 0}
                onClick={() => void exportPpl()}
                data-tip="Sestaví CSV pro PPL ze zobrazených objednávek a otevře import v jejich administraci">
                {pplBusy
                  ? <><span className="spinner-inline" /> chystám…</>
                  : <><Icon name="truck" size={12} /> PPL</>}
              </button>

              {/*
                Štítky PPL vystavuje jejich administrace až z nahrané zásilky —
                bez API se stáhnout nedají. Tohle na ten seznam aspoň odveze.
              */}
              <button className="filter-chip" onClick={() => { void api.ppl.openLabels(); }}
                data-tip="Otevře v administraci PPL seznam zásilek, odkud se štítky tisknou">
                <Icon name="printer" size={12} /> Štítky PPL
              </button>

              {/* Balíkovna: Podání Online České pošty, zase souborem a v UTF-8 */}
              <button className="filter-chip" disabled={balBusy || pplCandidates.length === 0}
                onClick={() => void exportBalikovna()}
                data-tip="Sestaví CSV pro Podání Online a vloží ho do jejich importu — odeslání zůstává na tobě">
                {balBusy
                  ? <><span className="spinner-inline" /> chystám…</>
                  : <><Icon name="inbox" size={12} /> Balíkovna</>}
              </button>

              {/* Zásilkovna má API: zásilka se založí rovnou a štítek přijde jako arch */}
              <button className="filter-chip" disabled={zasBusy || pplCandidates.length === 0}
                onClick={() => void sendPacketa()}
                data-tip="Založí zásilky u Zásilkovny a stáhne arch se štítky">
                {zasBusy
                  ? <><span className="spinner-inline" /> zakládám…</>
                  : <><Icon name="bag" size={12} /> Zásilkovna</>}
              </button>
            </div>
          )}
          <span style={{ flex: 1 }} />
          <span className="pk-count">
            {loading && progress
              ? `Načítám ${progress.done}/${progress.total}…`
              : <>
                  {picked.size > 0
                    ? <>
                        <b>{picked.size} vybráno</b>
                        {' · '}
                        <button className="pk-clear" onClick={() => setPicked(new Set())}>zrušit výběr</button>
                      </>
                    : <>
                        <b>{counts.todo ?? 0} k zabalení</b>
                        {orders.length > (counts.todo ?? 0) && <> · {orders.length} za období</>}
                      </>}
                  {loadedAt && <span className="pk-fresh"> · stav {relTime(new Date(loadedAt).toISOString())}</span>}
                </>}
          </span>

        </div>

        <div className="pk-body">
          <div className="pk-list">
            {loading && orders.length === 0 && (
              <div className="pk-empty"><span className="spinner-inline" /> Procházím objednávky…</div>
            )}
            {!loading && visible.length === 0 && (
              <div className="pk-empty">
                <Icon name="check" size={26} />
                <div>{hidden.size > 0 ? 'Nic k zobrazení' : 'Nic k balení'}</div>
                <div className="pk-empty-sub">
                  {hidden.size > 0
                    ? 'Zvolené fáze jsou schované — klikni na dlaždici nahoře a vrátí se.'
                    : 'Ve zvoleném období není žádná objednávka.'}
                </div>
              </div>
            )}
            {byDay.map(group => (
              <div className="pk-day" key={group.day}>
                {/*
                  Datum jednou pro celou skupinu. U měsíčního okna je v seznamu
                  i dvě stě objednávek a „před 12 dny" u každého řádku se nedá
                  číst; hlavička řekne totéž jednou.
                */}
                <div className="pk-day-head">
                  {/* Celý den jedním kliknutím — u tisku faktur za den je to ten nejčastější výběr */}
                  <input type="checkbox" className="pk-pick"
                    checked={group.rows.every(one => picked.has(one.messageId))}
                    onChange={() => toggleDay(group.rows)}
                    aria-label={`Vybrat objednávky z ${group.day}`} />
                  <span>{group.day}</span>
                  <span className="pk-day-count">{group.rows.length}</span>
                </div>
                {group.rows.map(o => {
                  const items = o.card.items;
                  const packedCount = packedPieces(o);
                  const many = items.some(i => (i.qty || 1) > 1);
                  const status = o.shop?.status ?? o.card.tracking?.status ?? o.card.live?.status ?? null;
                  const phase = phases.get(o.messageId) ?? 'todo';
                  const cod = isCod(o);
                  return (
                    <div key={o.messageId} role="button" tabIndex={0}
                      className={`pk-row ${phase} ${o.messageId === selected ? 'active' : ''} ${o.done ? 'done' : ''} ${picked.has(o.messageId) ? 'picked' : ''}`}
                      onClick={() => setSelected(o.messageId)}
                      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') setSelected(o.messageId); }}>
                      <div className="pk-row-top">
                        {/*
                          Zaškrtávátko je uvnitř řádku, ale klik na něj řádek
                          neotevírá — jinak by se při vybírání pořád
                          přepínala rozepsaná objednávka.
                        */}
                        <input type="checkbox" className="pk-pick"
                          checked={picked.has(o.messageId)}
                          onClick={e => e.stopPropagation()}
                          onChange={() => togglePick(o.messageId)}
                          aria-label={`Vybrat objednávku ${numbers(o).main}`} />
                        <span className="pk-row-num">{numbers(o).main}</span>
                        {numbers(o).sub && <span className="pk-row-code">obj. {numbers(o).sub}</span>}
                        {o.done && <Icon name="check" size={13} className="pk-row-done" />}
                        <span style={{ flex: 1 }} />
                        <span className="pk-row-age">{relTime(o.date)}</span>
                      </div>
                      <div className="pk-row-name">{customerName(o)}</div>
                      {/*
                        Doprava a platba přímo v řádku. Podle dopravce se vybírá
                        štítek a krabice, a dobírka je ta jediná věc, na kterou
                        se při balení nesmí zapomenout — proto je zvýrazněná.
                      */}
                      <div className="pk-row-ship">
                        {/*
                          Země drobně vlevo. Do zahraničí jde jiný štítek
                          i doba — a poznat se to má dřív než z adresy.
                        */}
                        {countryOf(o) && countryOf(o) !== 'CZ' && (
                          <span className="pk-row-land" data-tip={`Doručení do ${countryOf(o)}`}>
                            {flagOf(countryOf(o))} {countryOf(o)}
                          </span>
                        )}
                        {o.card.shipmentName && (
                          <span className="pk-row-carrier"><Icon name="truck" size={11} /> {o.card.shipmentName}</span>
                        )}
                        {cod
                          ? <span className="pk-row-cod" data-tip="Dobírka — peníze vybírá dopravce">
                              dobírka {o.card.total ?? ''}
                            </span>
                          : o.card.paymentName && <span className="pk-row-pay">{o.card.paymentName}</span>}
                      </div>
                      <div className="pk-row-bot">
                        <span>{items.length} pol. · {totalPieces(items)} ks</span>
                        {many && <span className="pk-row-many" data-tip="Obsahuje více kusů jedné položky">víc kusů</span>}
                        {packedCount > 0 && !o.done && (
                          <span className="pk-row-prog">{packedCount}/{totalPieces(items)} ks</span>
                        )}
                        <span style={{ flex: 1 }} />
                        {status && <span className={`pk-row-status ${phase}`} title={status}>{status}</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>

          <div className="pk-detail">
            {!current && <div className="pk-empty">Vyber objednávku ze seznamu</div>}
            {current && (
              <>
                <div className="pk-head">
                  <button className="m-only m-back" onClick={() => setSelected(null)}
                    aria-label="Zpět na seznam objednávek">
                    <Icon name="chevLeft" size={20} />
                  </button>
                  <div>
                    <div className="pk-head-num">
                      {numbers(current).main}
                      {numbers(current).sub && (
                        <span className="pk-head-code" data-tip="Číslo objednávky v e-shopu">
                          obj. {numbers(current).sub}
                        </span>
                      )}
                    </div>
                    <div className="pk-head-name">{customerName(current)}</div>
                  </div>
                  <span style={{ flex: 1 }} />
                  <div className="pk-head-right">
                    {/* Počítá se v kusech: u „3 ks" je odškrtnutá položka pořád jen třetina práce */}
                    <div className="pk-head-count">
                      {packedPieces(current)}{' / '}{totalPieces(current.card.items)} ks
                    </div>
                    <div className="pk-bar">
                      <span style={{ width: `${(packedPieces(current) / Math.max(1, totalPieces(current.card.items))) * 100}%` }} />
                    </div>
                  </div>
                </div>

                {/*
                  Starší objednávka. Načtená faktura může být i půl roku stará
                  a z potvrzovacího mailu to nepoznat — proto se stav bere
                  z feedu e-shopu a u konečného (doručeno, storno) se řekne
                  nahlas, že se tohle nejspíš balit nemá.
                */}
                {current.shop?.final && (
                  <div className="pk-old">
                    <Icon name="alert" size={15} />
                    <div>
                      <b>Starší objednávka — {current.shop.status}</b>
                      <div className="pk-old-sub">
                        {current.shop.at && `stav z ${dayOf(current.shop.at)} · `}
                        objednávka {current.shop.code}
                        {current.shop.invoice && ` · faktura ${current.shop.invoice}`}
                      </div>
                    </div>
                  </div>
                )}

                {/*
                  Upozornění na kusy navíc. Při balení je nejdražší chyba
                  poslat jeden kus místo tří — hláška proto sedí nad seznamem,
                  ne dole v rohu, a u chybějících kusů je červená.
                */}
                {note && (
                  <div className={`pk-note ${note.ok ? '' : 'warn'}`} onClick={() => setNote(null)}>
                    <Icon name={note.ok ? 'check' : 'alert'} size={14} />
                    <span>{note.text}</span>
                  </div>
                )}

                <div className="pk-scroll">
                  <div className="pk-items">
                    {current.card.items.map((it, i) => (
                      <PackItem key={`${it.code ?? it.title}-${i}`} item={it} index={i}
                        count={countOf(current, i)}
                        onAdd={() => addPiece(current.messageId, i)}
                        onReset={() => resetPiece(current.messageId, i)}
                        flash={flash?.id === current.messageId && flash.index === i}
                        onZoom={setZoom} />
                    ))}
                  </div>

                  <div className="pk-panels">
                    <div className="pk-panel">
                      <div className="pk-panel-head"><Icon name="pin" size={12} /> Doručovací adresa</div>
                      {(() => {
                        const a = current.card.shipping ?? current.card.billing;
                        if (!a || a.lines.length === 0) {
                          return (
                            <div className="pk-dim">
                              {current.source === 'feed'
                                ? 've feedu není — otevři e-mail k objednávce'
                                : 'neuvedena'}
                            </div>
                          );
                        }
                        return (
                          <div className="pk-addr">
                            <b>{a.name}</b>
                            {a.company && <div className="pk-addr-company">{a.company}</div>}
                            {a.lines.map((l, i) => <div key={i}>{l}</div>)}
                            {a.country && <div className="pk-dim">{a.country}</div>}
                          </div>
                        );
                      })()}
                      <button className="oc-btn" onClick={copyAddress} style={{ marginTop: 8 }}>
                        <Icon name={copied ? 'check' : 'copy'} size={12} /> {copied ? 'Zkopírováno' : 'Kopírovat adresu'}
                      </button>
                    </div>

                    {/*
                      * Poznámka zákazníka. Při balení je to jedna z mála věcí,
                      * kvůli které se objednávka dělá jinak („pošlete až po
                      * 20.", „přidejte dárkové balení") — a v potvrzovacím
                      * e-mailu není, takže se dotahuje z feedu. Proto stojí
                      * nad údaji o dopravě a je vidět, ne schovaná mezi nimi.
                      */}
                    {current.card.note && (
                      <div className="pk-panel pk-cnote">
                        <div className="pk-panel-head"><Icon name="pen" size={12} /> Poznámka zákazníka</div>
                        <p>{current.card.note}</p>
                      </div>
                    )}

                    <div className="pk-panel">
                      <div className="pk-panel-head"><Icon name="truck" size={12} /> Doprava a kontakt</div>
                      <div className="pk-kv"><span>Doprava</span><b>{current.card.shipmentName ?? '—'}</b></div>
                      <div className="pk-kv"><span>Platba</span><b>{current.card.paymentName ?? '—'}</b></div>
                      <div className="pk-kv"><span>Celkem</span><b>{current.card.total ?? '—'}</b></div>
                      {current.card.customerEmail && (
                        <div className="pk-kv"><span>E-mail</span><b>{current.card.customerEmail}</b></div>
                      )}
                      {current.card.customerPhone ? (
                        <div className="pk-kv"><span>Telefon</span><b>{current.card.customerPhone}</b></div>
                      ) : (
                        // Při balení je telefon to jediné, čím se dá vyřešit
                        // nejasná adresa na místě — když ho potvrzovací mail
                        // nemá, dohledá se ve feedu objednávek
                        <div className="pk-kv">
                          <span>Telefon</span>
                          <b><CallContact email={current.card.customerEmail}
                            orderCode={current.card.orderNumber} compact /></b>
                        </div>
                      )}
                      {current.card.tracking?.trackingCode && (
                        <div className="pk-kv"><span>Zásilka</span><b>{current.card.tracking.trackingCode}</b></div>
                      )}
                    </div>
                  </div>
                </div>

                <div className="pk-foot">
                  {/*
                    Objednávka ze seznamu je z feedu, takže k ní číslo zprávy
                    nemáme — dohledá se až tady. Pro celý seznam předem by to
                    znamenalo průchod schránkou u každé objednávky.
                  */}
                  <button className="oc-btn" onClick={() => void openMail(current)}>
                    <Icon name="mail" size={12} /> Otevřít e-mail
                  </button>
                  {current.card.historyUrl && (
                    <button className="oc-btn" onClick={() => api.shell.openUrl(current.card.historyUrl!)}>
                      <Icon name="fileText" size={12} /> Detail v e-shopu
                    </button>
                  )}
                  {current.card.adminUrl && (
                    <button className="oc-btn" onClick={() => api.shell.openUrl(current.card.adminUrl!)}>
                      <Icon name="settings" size={12} /> Administrace
                    </button>
                  )}
                  {(current.packed.length > 0 || current.done) && (
                    <button className="oc-btn" onClick={() => resetOrder(current.messageId)}>
                      <Icon name="eraser" size={12} /> Vynulovat
                    </button>
                  )}
                  <span style={{ flex: 1 }} />
                  {current.done
                    ? <button className="btn ghost" onClick={() => markDone(current.messageId, false)}>
                        <Icon name="check" size={13} /> Zabaleno — vrátit zpět
                      </button>
                    : <button className={`btn primary ${allPacked ? '' : 'pk-btn-wait'}`}
                        onClick={() => markDone(current.messageId, true)}>
                        <Icon name="check" size={13} /> {allPacked
                          ? 'Zabaleno'
                          : `Zabaleno (zbývá ${totalPieces(current.card.items) - packedPieces(current)} ks)`}
                      </button>}
                </div>
              </>
            )}
          </div>
        </div>

        <div className="pk-hint">
          <kbd>↑</kbd><kbd>↓</kbd> mezi objednávkami · <kbd>1</kbd>–<kbd>9</kbd> odškrtnout položku · <kbd>Esc</kbd> zavřít
        </div>
      </div>

      {zoom && (
        <div className="oc-lightbox" onClick={e => { e.stopPropagation(); setZoom(null); }}>
          <div className="oc-lightbox-inner" onClick={e => e.stopPropagation()}>
            <img src={zoom.image!} alt={zoom.title} referrerPolicy="no-referrer" />
            <div className="oc-lightbox-bar">
              <b>{zoom.title}</b>
              {zoom.code && <span className="oc-code">{zoom.code}</span>}
              {zoom.variants.map((v, i) => <span key={i} className="pk-variant">{v}</span>)}
              <span style={{ flex: 1 }} />
              <button className="oc-btn" onClick={() => setZoom(null)}><Icon name="x" size={12} /></button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
