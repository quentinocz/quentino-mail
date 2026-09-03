import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CodeShorthand, MessageHeader, OrderBadge as OrderBadgeData, OrderCard as OrderCardData } from '@shared/types';
import { api } from '../api';
import { useIsPhone } from '../mobile';
import Icon from './Icon';
import OrderCard from './OrderCard';

/**
 * Odznak objednávky v seznamu zpráv.
 *
 * Číslo a částka se čtou rovnou z předmětu, takže odznak naskočí okamžitě bez
 * jediného dotazu. Stav objednávky se dotahuje až ve chvíli, kdy je řádek
 * doopravdy vidět, a to nejvýš ve dvou souběžných dotazech — seznam tak zůstane
 * svižný i ve složce s tisícem objednávek. Najetí myší vysune celou kartu.
 */

const ORDER_SUBJECT = /(objedn[áa]v|order\b|bestellung|zam[óo]wien)/i;
const SUBJECT_NUMBER = /(?:č\.|c\.|no\.|nr\.|#)\s*(\d{3,})/i;
const SUBJECT_TOTAL = /\b(?:za|for|celkem|total)\s+([\d\s .,]+(?:Kč|CZK|€|EUR|\$|USD|£|zł|PLN))/i;

/** „quentino.cz" → „quentino"; podle toho se poznají i .sk a .com mutace e-shopu */
export function shopLabel(feedUrl: string | undefined | null): string | null {
  if (!feedUrl) return null;
  try {
    const host = new URL(feedUrl).hostname.toLowerCase().replace(/^www\./, '');
    const parts = host.split('.');
    const label = (parts.length > 2 ? parts[parts.length - 2] : parts[0]) || '';
    return label.length >= 4 ? label : null;
  } catch {
    return null;
  }
}

/**
 * Rychlý odhad z hlavičky. Potvrzení objednávky chodí z vlastního e-shopu —
 * bez téhle podmínky by odznak naskočil i u nákupu v Tescu nebo Alze.
 */
export function looksLikeOrder(m: MessageHeader, shop: string | null): boolean {
  if (!shop) return false;
  if (!(m.fromAddr.split('@')[1] ?? '').toLowerCase().includes(shop)) return false;
  if (!SUBJECT_NUMBER.test(m.subject)) return false;
  return m.category === 'orders' || ORDER_SUBJECT.test(m.subject);
}

const TONE_LABEL: Record<OrderBadgeData['tone'], string> = {
  new: 'nová', paid: 'zaplaceno', sent: 'odesláno', done: 'doručeno', problem: 'pozor'
};

// ---------- fronta dotazů, ať se seznam nezahltí ----------

const badgeCache = new Map<number, OrderBadgeData | null>();
const cardCache = new Map<number, OrderCardData | null>();
const queue: (() => Promise<void>)[] = [];
let active = 0;

function pump() {
  while (active < 2 && queue.length > 0) {
    const job = queue.shift()!;
    active++;
    void job().finally(() => { active--; pump(); });
  }
}

function enqueue(job: () => Promise<void>) {
  queue.push(job);
  pump();
}

// ---------- zkratky napřed, odznak potom ----------

/*
 * Celý odznak se ptá e-shopu na stav a dopravce na zásilku — než se vrátí,
 * ukazuje řádek číslo a částku z předmětu. Na telefonu je ale právě tohle
 * to, co se mělo nahradit dopravou a platbou, a u části řádků to trvalo tak
 * dlouho, že tam číslo s cenou zůstalo viset. Zkratky se proto dotahují
 * zvlášť: jeden dotaz do databáze na všechna právě viditelná čísla, bez sítě
 * a bez fronty. Odznak je pak jen doplní o stav a barvu.
 */
const shortsCache = new Map<string, CodeShorthand | null>();
const shortsWaiting = new Map<string, ((value: CodeShorthand | null) => void)[]>();
let shortsTimer: number | null = null;

function askShorts(number: string): Promise<CodeShorthand | null> {
  if (shortsCache.has(number)) return Promise.resolve(shortsCache.get(number) ?? null);
  return new Promise(resolve => {
    const waiting = shortsWaiting.get(number) ?? [];
    waiting.push(resolve);
    shortsWaiting.set(number, waiting);
    if (shortsTimer !== null) return;
    // Krátké zdržení sloučí celou obrazovku do jediného dotazu
    shortsTimer = window.setTimeout(async () => {
      shortsTimer = null;
      const batch = new Map(shortsWaiting);
      shortsWaiting.clear();
      let found: Record<string, CodeShorthand> | null = null;
      try {
        found = await api.orders.shorts([...batch.keys()]);
      } catch {
        // Výpadek neznamená, že zkratka není — jen se neuloží a zkusí se znovu
      }
      for (const [code, fns] of batch) {
        const one = found ? (found[code] ?? null) : null;
        if (found) shortsCache.set(code, one);
        for (const fn of fns) fn(one);
      }
    }, 30);
  });
}

interface Props {
  message: MessageHeader;
}

export default function OrderBadge({ message }: Props) {
  const phone = useIsPhone();
  const chipRef = useRef<HTMLSpanElement | null>(null);
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);

  const [badge, setBadge] = useState<OrderBadgeData | null | undefined>(badgeCache.get(message.id));
  const [shorts, setShorts] = useState<CodeShorthand | null>(null);
  const [card, setCard] = useState<OrderCardData | null | undefined>(cardCache.get(message.id));
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; maxH: number } | null>(null);

  // Z předmětu: číslo a částka jsou k dispozici hned, bez čekání na cokoli
  const subjectNumber = (message.subject.match(SUBJECT_NUMBER) ?? [])[1] ?? null;
  const subjectTotal = ((message.subject.match(SUBJECT_TOTAL) ?? [])[1] ?? '').replace(/\s+/g, ' ').trim() || null;

  /*
   * Zkratky rovnou podle čísla z předmětu. Nejde přes frontu — je to dotaz
   * do databáze, ne na síť — takže na telefonu je doprava s platbou na
   * odznaku dřív, než se stihne cokoli stáhnout.
   */
  useEffect(() => {
    if (!phone || !subjectNumber) return;
    let alive = true;
    void askShorts(subjectNumber).then(one => { if (alive && one) setShorts(one); });
    return () => { alive = false; };
  }, [phone, subjectNumber]);

  // Stav se dotáhne, teprve až je odznak vidět
  useEffect(() => {
    if (badgeCache.has(message.id)) return;
    const el = chipRef.current;
    if (!el) return;
    const io = new IntersectionObserver(entries => {
      if (!entries.some(e => e.isIntersecting)) return;
      io.disconnect();
      enqueue(async () => {
        if (badgeCache.has(message.id)) { setBadge(badgeCache.get(message.id)); return; }
        try {
          const b = await api.orders.badge(message.id);
          badgeCache.set(message.id, b);
          setBadge(b);
        } catch {
          // Výpadek sítě neznamená, že objednávka neexistuje — necháme odznak s číslem
          // z předmětu a výsledek neukládáme do cache, ať se dá zkusit znovu.
        }
      });
    }, { rootMargin: '120px' });
    io.observe(el);
    return () => io.disconnect();
  }, [message.id]);

  const clearTimers = () => {
    if (openTimer.current) { window.clearTimeout(openTimer.current); openTimer.current = null; }
    if (closeTimer.current) { window.clearTimeout(closeTimer.current); closeTimer.current = null; }
  };
  useEffect(() => clearTimers, []);

  const place = () => {
    const r = chipRef.current?.getBoundingClientRect();
    if (!r) return;
    const width = 420;
    let left = r.right + 12;
    if (left + width > window.innerWidth - 12) left = Math.max(12, r.left - width - 12);
    const maxH = Math.min(600, window.innerHeight - 32);
    setPos({ top: Math.min(Math.max(12, r.top - 10), window.innerHeight - maxH - 12), left, maxH });
  };

  const loadCard = () => {
    if (cardCache.has(message.id)) { setCard(cardCache.get(message.id)); return; }
    enqueue(async () => {
      try {
        const c = await api.orders.card(message.id, true);
        cardCache.set(message.id, c);
        setCard(c);
      } catch {
        setCard(null);
      }
    });
  };

  const show = () => {
    clearTimers();
    openTimer.current = window.setTimeout(() => { place(); setOpen(true); loadCard(); }, 300);
  };

  const hide = () => {
    clearTimers();
    if (pinned) return;
    closeTimer.current = window.setTimeout(() => setOpen(false), 180);
  };

  const togglePin = (e: React.MouseEvent) => {
    e.stopPropagation();
    clearTimers();
    if (pinned) { setPinned(false); setOpen(false); return; }
    place();
    setOpen(true);
    loadCard();
    setPinned(true);
  };

  useEffect(() => {
    if (!pinned) return;
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { setPinned(false); setOpen(false); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pinned]);

  // Odhad z předmětu se občas netrefí — jakmile e-mail objednávku prokazatelně
  // neobsahuje, odznak zmizí a příště se už nenabídne (výsledek je v cache).
  if (badge === null || card === null) return null;

  const number = badge?.orderNumber ?? subjectNumber;
  const tone = badge?.tone ?? 'new';
  // Než dorazí stav z e-shopu, ukáže odznak aspoň částku z předmětu
  const statusText = badge ? (badge.status ?? TONE_LABEL[badge.tone]) : subjectTotal;
  /*
   * Zkratky ze dvou zdrojů: co dorazí dřív, to platí. Odznak zná i
   * objednávky, které v předmětu číslo nemají, krátká cesta je zase hned —
   * a když nic neví ani jeden, zůstane číslo s částkou.
   */
  const shipmentShort = badge?.shipmentShort || shorts?.shipmentShort || null;
  const paymentShort = badge?.paymentShort || shorts?.paymentShort || null;

  return (
    <>
      <span
        ref={chipRef}
        className={`ord-chip tone-${tone} ${open ? 'on' : ''}`}
        onMouseEnter={show}
        onMouseLeave={hide}
        onClick={togglePin}
        data-tip={pinned ? 'Zavřít objednávku' : 'Objednávka — najeď myší'}
      >
        <span className="ord-dot" />
        {/*
          * Na telefonu se do řádku vejde asi dvacet znaků a číslo objednávky
          * s částkou z nich nic neřeknou — číslo si nikdo nepamatuje a částka
          * je v e-mailu o řádek níž. Co se z odznaku ráno čte doopravdy, je
          * kam balík jde a jestli je zaplaceno. Dokud se doprava nedohledá
          * (objednávka mimo feed, cizí e-shop), ukáže se aspoň číslo.
          */}
        {phone && (shipmentShort || paymentShort) ? (
          <>
            {shipmentShort && <span className="ord-num">{shipmentShort}</span>}
            {paymentShort && <span className="ord-state">{paymentShort}</span>}
          </>
        ) : (
          <>
            <span className="ord-num">{number ?? 'objednávka'}</span>
            {statusText && <span className="ord-state">{statusText}</span>}
          </>
        )}
      </span>

      {open && pos && createPortal(
        <div
          className={`ord-pop ${pinned ? 'pinned' : ''}`}
          style={{ top: pos.top, left: pos.left, maxHeight: pos.maxH }}
          onMouseEnter={clearTimers}
          onMouseLeave={hide}
          onClick={e => e.stopPropagation()}
        >
          {pinned && (
            <button className="ord-pop-close" onClick={() => { setPinned(false); setOpen(false); }} data-tip="Zavřít">
              <Icon name="x" size={13} />
            </button>
          )}
          {card === undefined && (
            <div className="ord-pop-msg"><span className="spinner-inline" /> Načítám objednávku…</div>
          )}
          {card && <OrderCard card={card} compact />}
        </div>,
        document.body
      )}
    </>
  );
}
