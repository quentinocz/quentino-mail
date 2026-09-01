import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PackingLookup, PackingOrder, PackingProgress, OrderCardItem } from '@shared/types';
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
  { days: 30, label: 'měsíc' }
];

/**
 * Stavy, které při balení nezajímají — nabídnou se rovnou skryté. Jde jen
 * o výchozí nastavení; co uživatel jednou přepne, tomu se už nepřepisuje.
 */
const HIDE_BY_DEFAULT = /odesl[áa]n|expedov|p[řr]ed[áa]n|doru[čc]en|vyzvednut|dokon[čc]en|storn|zru[šs]en|vr[áa]cen|odstoup|reklamac/i;

const LS_HIDDEN = 'packingHiddenStatuses';
const LS_KNOWN = 'packingKnownStatuses';

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
}

export default function PackingModal({ onClose, onOpenMessage }: Props) {
  const toast = useToast();
  const [days, setDays] = useState(3);
  const [orders, setOrders] = useState<PackingOrder[]>([]);
  const [statuses, setStatuses] = useState<string[]>([]);
  const [hidden, setHidden] = useState<Set<string>>(() => loadSet(LS_HIDDEN));
  const [statusOpen, setStatusOpen] = useState(false);
  const [hidePacked, setHidePacked] = useState(true);
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
      setStatuses(res.statuses);

      // Nový stav se poprvé zařadí podle toho, jestli se při balení hodí.
      // Jakmile ho uživatel jednou přepne, zůstane po jeho.
      const known = loadSet(LS_KNOWN);
      const fresh = res.statuses.filter(s => !known.has(s));
      if (fresh.length > 0) {
        setHidden(prev => {
          const next = new Set(prev);
          for (const s of fresh) if (HIDE_BY_DEFAULT.test(s)) next.add(s);
          saveSet(LS_HIDDEN, next);
          return next;
        });
        for (const s of fresh) known.add(s);
        saveSet(LS_KNOWN, known);
      }
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

  const visible = useMemo(() => {
    return orders.filter(o => {
      if (o.messageId === pinned) return true;
      if (hidePacked && o.done) return false;
      const status = o.card.tracking?.status ?? o.card.live?.status ?? null;
      // Objednávka bez zjištěného stavu se nikdy neschovává — je nejspíš čerstvá
      return !(status && hidden.has(status));
    });
  }, [orders, hidePacked, hidden, pinned]);

  const toggleStatus = (s: string) => setHidden(prev => {
    const next = new Set(prev);
    if (next.has(s)) next.delete(s); else next.add(s);
    saveSet(LS_HIDDEN, next);
    return next;
  });

  const setAllStatuses = (show: boolean) => setHidden(() => {
    const next = show ? new Set<string>() : new Set(statuses);
    saveSet(LS_HIDDEN, next);
    return next;
  });

  // Vybraná objednávka musí zůstat ve viditelném seznamu. Na telefonu se ale
  // nic nevybírá samo — je vidět vždy jen jedna část, takže by se rovnou
  // otevřela objednávka a seznam by uživatel nikdy neviděl.
  useEffect(() => {
    if (visible.length === 0) { setSelected(null); return; }
    if (selected !== null && !visible.some(o => o.messageId === selected)) {
      setSelected(phone ? null : visible[0].messageId);
      return;
    }
    if (selected === null && !phone) setSelected(visible[0].messageId);
  }, [visible, selected, phone]);

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
      if (hidePacked && next) setSelected(next.messageId);
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

  return (
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      {/* Na telefonu je vidět vždy jen jedna část — seznam, nebo rozepsaná objednávka */}
      <div className="modal pk-modal" data-pane={selected ? 'detail' : 'list'}
        data-scan={panelH ? 'on' : undefined}
        style={panelH ? { paddingTop: panelH } : undefined}>
        <div className="modal-head">
          <div className="modal-title"><Icon name="bag" size={16} /> Balení objednávek</div>
          <span style={{ flex: 1 }} />
          {hasCamera && (
            <button className={`icon-btn ${panelH ? 'on' : ''}`} onClick={toggleCamera}
              data-tip={panelH ? 'Zavřít čtečku' : 'Skenovat faktury a kódy produktů'}>
              <Icon name="camera" size={15} />
            </button>
          )}
          <button className="icon-btn" disabled={loading} data-tip="Načíst znovu včetně stavů"
            onClick={() => load(days, true)}>
            <Icon name="refresh" size={15} className={loading ? 'spinning' : undefined} />
          </button>
          <button className="icon-btn" onClick={onClose} data-tip="Zavřít"><Icon name="x" size={16} /></button>
        </div>

        <div className="pk-filters">
          <div className="pk-seg">
            {WINDOWS.map(w => (
              <button key={w.days} className={`pk-seg-btn ${days === w.days ? 'on' : ''}`}
                onClick={() => setDays(w.days)}>{w.label}</button>
            ))}
          </div>
          <div className="pk-status-wrap">
            <button className={`filter-chip ${hidden.size > 0 ? 'on' : ''}`} onClick={() => setStatusOpen(v => !v)}>
              Stavy {statuses.length > 0 && `(${statuses.length - hidden.size}/${statuses.length})`}
              <Icon name="chevDown" size={11} />
            </button>
            {statusOpen && (
              <>
                <div className="pk-status-catch" onClick={() => setStatusOpen(false)} />
                <div className="pk-status-pop">
                  <div className="pk-status-head">
                    Které stavy zobrazit
                    <span style={{ flex: 1 }} />
                    <button onClick={() => setAllStatuses(true)}>vše</button>
                    <button onClick={() => setAllStatuses(false)}>nic</button>
                  </div>
                  {statuses.length === 0 && <div className="pk-status-empty">Zatím žádné stavy</div>}
                  {statuses.map(s => (
                    <label key={s} className="pk-status-row">
                      <input type="checkbox" checked={!hidden.has(s)} onChange={() => toggleStatus(s)} />
                      <span>{s}</span>
                    </label>
                  ))}
                </div>
              </>
            )}
          </div>
          <button className={`filter-chip ${hidePacked ? 'on' : ''}`} onClick={() => setHidePacked(v => !v)}>
            Skrýt zabalené
          </button>
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
          <span style={{ flex: 1 }} />
          <span className="pk-count">
            {loading && progress
              ? `Načítám ${progress.done}/${progress.total}…`
              : <>
                  {visible.length} k zabalení
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
                <div>Nic k balení</div>
                <div className="pk-empty-sub">Ve zvoleném období není žádná nezabalená objednávka.</div>
              </div>
            )}
            {visible.map(o => {
              const items = o.card.items;
              const packedCount = packedPieces(o);
              const many = items.some(i => (i.qty || 1) > 1);
              const status = o.card.tracking?.status ?? o.card.live?.status ?? null;
              return (
                <button key={o.messageId}
                  className={`pk-row ${o.messageId === selected ? 'active' : ''} ${o.done ? 'done' : ''}`}
                  onClick={() => setSelected(o.messageId)}>
                  <div className="pk-row-top">
                    <span className="pk-row-num">{numbers(o).main}</span>
                    {/* Číslo objednávky drobně vedle — hlavní je to z faktury */}
                    {numbers(o).sub && <span className="pk-row-code">obj. {numbers(o).sub}</span>}
                    {o.done && <Icon name="check" size={13} className="pk-row-done" />}
                    <span style={{ flex: 1 }} />
                    <span className="pk-row-age">{relTime(o.date)}</span>
                  </div>
                  <div className="pk-row-name">{customerName(o)}</div>
                  <div className="pk-row-bot">
                    <span>{items.length} pol. · {totalPieces(items)} ks</span>
                    {many && <span className="pk-row-many" data-tip="Obsahuje více kusů jedné položky">víc kusů</span>}
                    {packedCount > 0 && !o.done && (
                      <span className="pk-row-prog">{packedCount}/{totalPieces(items)} ks</span>
                    )}
                    <span style={{ flex: 1 }} />
                    {status && <span className="pk-row-status">{status}</span>}
                  </div>
                </button>
              );
            })}
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
