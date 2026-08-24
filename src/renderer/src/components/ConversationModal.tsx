import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CustomerContext, CustomerMessage, OrderCard as OrderCardData } from '@shared/types';
import { api } from '../api';
import Icon from './Icon';
import OrderCard from './OrderCard';

/**
 * Karta konverzace se zákazníkem.
 *
 * Celá pošta s jedním člověkem v jedné časové ose jako chat — jeho zprávy
 * vlevo, naše odpovědi vpravo, potvrzení objednávek jako karta uprostřed.
 * Smyslem je, aby se nic neztratilo a šlo se kdykoli podívat zpět: proto se
 * zobrazuje skutečný text zpráv (bez citovaných částí, které konverzaci
 * nafukují) a nahoře je hledání napříč celou historií.
 */

function dayKey(iso: string): string {
  return new Date(iso).toDateString();
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const yest = new Date(now.getTime() - 86_400_000);
  if (d.toDateString() === now.toDateString()) return 'Dnes';
  if (d.toDateString() === yest.toDateString()) return 'Včera';
  return d.toLocaleDateString('cs-CZ', {
    day: 'numeric', month: 'long',
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' })
  });
}

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });
}

/** Zvýraznění hledaného výrazu v textu bubliny */
function highlight(text: string, q: string) {
  if (!q.trim()) return text;
  const parts = text.split(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'));
  return parts.map((s, i) =>
    s.toLowerCase() === q.toLowerCase() ? <mark key={i}>{s}</mark> : <span key={i}>{s}</span>);
}

/** Potvrzení objednávky v časové ose — karta místo bubliny */
function OrderEvent({ m, onOpen }: { m: CustomerMessage; onOpen: (id: number) => void }) {
  const [open, setOpen] = useState(false);
  const [card, setCard] = useState<OrderCardData | null | undefined>(undefined);

  useEffect(() => {
    if (!open || card !== undefined) return;
    let cancelled = false;
    api.orders.card(m.id).then(c => { if (!cancelled) setCard(c); }).catch(() => { if (!cancelled) setCard(null); });
    return () => { cancelled = true; };
  }, [open, card, m.id]);

  // Číslo z rejstříku má přednost — v předmětu bývá i datum nebo částka
  const num = m.orderNumber ?? (m.subject.match(/(?:č\.|no\.|#)\s*(\d{3,})/i) ?? [])[1];
  const sum = (m.subject.match(/\b([\d\s.,]+(?:Kč|CZK|€|EUR))/i) ?? [])[1];

  return (
    <div className="cv-event">
      <button className="cv-event-head" onClick={() => setOpen(o => !o)}>
        <Icon name="bag" size={13} />
        <b>Objednávka {num ?? ''}</b>
        {sum && <span className="cv-event-sum">{sum.trim()}</span>}
        <span className="cv-event-time">{time(m.date)}</span>
        <Icon name="chevDown" size={12}
          style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }} />
      </button>
      {open && (
        <div className="cv-event-body">
          {card === undefined && <div className="cv-loading"><span className="spinner-inline" /> Načítám objednávku…</div>}
          {card === null && <div className="cv-dim">Objednávku se nepodařilo načíst.</div>}
          {card && <OrderCard card={card} compact />}
          <button className="cv-link" onClick={() => onOpen(m.id)}>
            <Icon name="mail" size={11} /> Otevřít e-mail
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Kolik textu se v bublině ukáže, než se nabídne rozbalení.
 *
 * Potvrzení objednávky nebo zpráva s podpisem a patičkou mají klidně dva
 * tisíce znaků. Ve vlákně z toho vznikla stěna textu, ve které se ostatní
 * zprávy ztratily — a na telefonu to bylo několik obrazovek rolování na
 * jednu jedinou zprávu.
 */
const BUBBLE_LIMIT = 420;

/** Bublina zprávy. Dlouhý text se sbalí, ať je vidět celý průběh hovoru. */
function Bubble({ m, q, focus, onOpen }: {
  m: CustomerMessage;
  q: string;
  focus: boolean;
  onOpen: (id: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const body = (m.text ?? m.snippet ?? '').trim();
  const long = body.length > BUBBLE_LIMIT;
  // Krátí se na hranici slova, ne uprostřed — půlka slova vypadá jako chyba
  const shown = !long || open ? body : body.slice(0, body.lastIndexOf(' ', BUBBLE_LIMIT) + 1 || BUBBLE_LIMIT);

  return (
    <div className={`cv-row ${m.incoming ? 'in' : 'out'} ${focus ? 'focus' : ''}`}>
      <div className="cv-bubble">
        <div className="cv-subject">
          {m.subject || '(bez předmětu)'}
          {m.hasAttachments && <Icon name="paperclip" size={11} style={{ marginLeft: 5 }} />}
        </div>
        <div className={`cv-text ${long && !open ? 'clipped' : ''}`}>
          {body ? highlight(shown, q) : <span className="cv-dim">(bez textu)</span>}
        </div>
        {long && (
          <button className="cv-more" onClick={() => setOpen(o => !o)}>
            <Icon name="chevDown" size={11}
              style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }} />
            {open ? 'Sbalit' : `Zobrazit celé (${Math.round(body.length / 100) / 10} tis. znaků)`}
          </button>
        )}
        <div className="cv-meta">
          <span>{time(m.date)}</span>
          {m.incoming && !m.answered && <span className="cv-wait">čeká na odpověď</span>}
          <button className="cv-open" onClick={() => onOpen(m.id)}>otevřít</button>
        </div>
      </div>
    </div>
  );
}

interface Props {
  email: string;
  fallbackName: string;
  /** Zpráva, na kterou se má konverzace odrolovat */
  focusMessageId?: number | null;
  onClose: () => void;
  onOpenMessage: (id: number) => void;
  onReply: (email: string) => void;
}

export default function ConversationModal(p: Props) {
  const [ctx, setCtx] = useState<CustomerContext | null>(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);
  const focusRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    try { setCtx(await api.customer.conversation(p.email)); }
    catch { /* konverzace bez dat se ukáže jako prázdná */ }
    finally { setBusy(false); }
  }, [p.email]);

  useEffect(() => { void load(); }, [load]);

  // Těla, která ještě nejsou stažená, se dotáhnou na pozadí — po dvou,
  // ať se nezahltí spojení, a bublina se doplní hned jak dorazí
  useEffect(() => {
    if (!ctx) return;
    const missing = ctx.messages.filter(m => m.text === null).map(m => m.id);
    if (missing.length === 0) return;
    let cancelled = false;
    let i = 0;
    const next = async (): Promise<void> => {
      if (cancelled || i >= missing.length) return;
      const id = missing[i++];
      try {
        // Čištění textu i odřezání citací dělá main proces, ať je to všude stejné
        const text = await api.customer.messageText(id);
        if (!cancelled) {
          setCtx(prev => prev && {
            ...prev,
            messages: prev.messages.map(m => (m.id === id ? { ...m, text: text.slice(0, 4000) } : m))
          });
        }
      } catch { /* zprávu nejde stáhnout — zůstane u ní útržek */ }
      return next();
    };
    void Promise.all([next(), next()]);
    return () => { cancelled = true; };
  }, [ctx?.email, ctx?.messages.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // V chatu je nejnovější dole
  const messages = useMemo(() => {
    const all = [...(ctx?.messages ?? [])].sort((a, b) => a.date.localeCompare(b.date));
    if (!q.trim()) return all;
    const needle = q.toLowerCase();
    return all.filter(m =>
      m.subject.toLowerCase().includes(needle)
      || (m.text ?? m.snippet ?? '').toLowerCase().includes(needle));
  }, [ctx, q]);

  useEffect(() => {
    if (q.trim()) return;
    const el = focusRef.current ?? endRef.current;
    el?.scrollIntoView({ block: 'center' });
  }, [messages.length, q]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') p.onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [p]);

  const name = ctx?.name || p.fallbackName || p.email;
  const orders = ctx?.orders ?? [];
  let lastDay = '';

  return (
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) p.onClose(); }}>
      <div className="modal cv-modal">
        <div className="modal-head">
          <div className="cv-title">
            <div className="cv-name">{name}</div>
            <div className="cv-sub">
              {p.email}
              {orders.length > 0 && <> · {orders.length} {orders.length === 1 ? 'objednávka' : orders.length < 5 ? 'objednávky' : 'objednávek'}</>}
              {ctx && <> · {ctx.messages.length} zpráv</>}
            </div>
          </div>
          <span style={{ flex: 1 }} />
          <button className="toolbar-btn primary" onClick={() => p.onReply(p.email)}>
            <Icon name="reply" size={14} /> Odpovědět
          </button>
          <button className="icon-btn" onClick={p.onClose} data-tip="Zavřít"><Icon name="x" size={16} /></button>
        </div>

        <div className="cv-search">
          <Icon name="search" size={13} />
          <input placeholder="Hledat v konverzaci…" value={q} onChange={e => setQ(e.target.value)} />
          {q && (
            <>
              <span className="cv-dim">{messages.length} nalezeno</span>
              <button className="icon-btn" onClick={() => setQ('')}><Icon name="x" size={13} /></button>
            </>
          )}
        </div>

        <div className="cv-scroll">
          {busy && !ctx && <div className="cv-loading"><span className="spinner-inline" /> Načítám konverzaci…</div>}
          {ctx && messages.length === 0 && (
            <div className="cv-empty">{q ? 'Nic neodpovídá hledání.' : 'Zatím žádná komunikace.'}</div>
          )}

          {messages.map(m => {
            const day = dayKey(m.date);
            const newDay = day !== lastDay;
            lastDay = day;
            const focus = p.focusMessageId === m.id;

            return (
              <div key={m.id} ref={focus ? focusRef : undefined}>
                {newDay && <div className="cv-day"><span>{dayLabel(m.date)}</span></div>}

                {m.isOrderMail
                  ? <OrderEvent m={m} onOpen={p.onOpenMessage} />
                  : <Bubble m={m} q={q} focus={focus} onOpen={p.onOpenMessage} />}
              </div>
            );
          })}
          <div ref={endRef} />
        </div>
      </div>
    </div>
  );
}
