import { useEffect, useState } from 'react';
import type { CustomerContext, OrderRef, OrderCard as OrderCardData } from '@shared/types';
import { api } from '../api';
import Icon from './Icon';
import CallContact from './CallContact';
import OrderCard from './OrderCard';

/**
 * Panel zákazníka nad tělem zprávy.
 *
 * Nahrazuje dřívější tři samostatné bloky (vlákno, objednávky, proužek), které
 * se navzájem přebíjely. Ve složeném stavu je to jeden řádek — kdo píše a
 * čeho se to týká. Rozbalený nabídne dvě karty: celou historii komunikace
 * s tímto člověkem a jeho objednávky, od nejnovější po nejstarší. Text zprávy
 * tak zůstává tím hlavním a kontext je po ruce, ale až na vyžádání.
 */

const AVATAR_COLORS = ['#7c5cff', '#e5638d', '#2f9e6e', '#d99a1b', '#2b8fd6', '#b45c14', '#8a5cd6'];

function avatarColor(s: string): string {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

function fmtDate(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('cs-CZ', {
    day: 'numeric', month: 'numeric',
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: '2-digit' })
  });
}

/** Jedna objednávka v seznamu — karta se načte, až když ji uživatel rozbalí. */
function OrderRow({ orderNumber, messageId, date, highlight, onOpenMessage }: {
  orderNumber: string; messageId: number; date: string; highlight: boolean;
  onOpenMessage: (id: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [card, setCard] = useState<OrderCardData | null | undefined>(undefined);

  useEffect(() => {
    if (!open || card !== undefined) return;
    let cancelled = false;
    api.orders.card(messageId)
      .then(c => { if (!cancelled) setCard(c); })
      .catch(() => { if (!cancelled) setCard(null); });
    return () => { cancelled = true; };
  }, [open, card, messageId]);

  const status = card?.tracking?.status ?? card?.live?.status ?? null;

  return (
    <div className={`cp-order ${highlight ? 'highlight' : ''}`}>
      <button className="cp-order-head" onClick={() => setOpen(o => !o)}>
        <Icon name="chevDown" size={12}
          style={{ transform: open ? 'none' : 'rotate(-90deg)', transition: 'transform .15s', color: 'var(--text-3)' }} />
        <span className="cp-order-num">{orderNumber}</span>
        {highlight && <span className="cp-order-this">tato zpráva</span>}
        <span className="cp-dim">{fmtDate(date)}</span>
        <span style={{ flex: 1 }} />
        {status && <span className="cp-order-status">{status}</span>}
        {card?.total && <span className="cp-order-total">{card.total}</span>}
      </button>
      {open && (
        <div className="cp-order-body">
          {card === undefined && <div className="cp-loading"><span className="spinner-inline" /> Načítám objednávku…</div>}
          {card === null && <div className="cp-dim" style={{ padding: '8px 10px' }}>Objednávku se nepodařilo načíst.</div>}
          {card && (
            <>
              <OrderCard card={card} compact />
              <button className="cp-link" onClick={() => onOpenMessage(messageId)}>
                <Icon name="mail" size={11} /> Otevřít potvrzení objednávky
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

interface Props {
  email: string;
  fallbackName: string;
  currentMessageId: number;
  /** Objednávka, ke které se otevřená zpráva vztahuje */
  orderRef: OrderRef | null;
  onOpenMessage: (id: number) => void;
  onResolve: (value: boolean) => void;
  /** Otevře celou konverzaci jako chat */
  onOpenConversation: () => void;
}

export default function CustomerPanel(p: Props) {
  const [ctx, setCtx] = useState<CustomerContext | null>(null);
  const [tab, setTab] = useState<'orders' | null>(null);
  // Jestli se ve feedu objednávek našel telefon. Řídí se tím, jestli má
  // panel vůbec smysl otevírat.
  const [hasPhone, setHasPhone] = useState(false);

  useEffect(() => {
    setHasPhone(false);
    if (!p.email) return;
    let cancelled = false;
    api.orders.contact({ email: p.email })
      .then(found => { if (!cancelled) setHasPhone(!!found.phone); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [p.email]);

  useEffect(() => {
    setCtx(null);
    setTab(null);
    if (!p.email) return;
    let cancelled = false;
    api.customer.context(p.email).then(c => { if (!cancelled) setCtx(c); }).catch(() => {});
    return () => { cancelled = true; };
  }, [p.email, p.currentMessageId]);

  const name = ctx?.name || p.fallbackName || p.email;
  const msgs = ctx?.messages ?? [];
  const orders = ctx?.orders ?? [];
  const others = msgs.filter(m => m.id !== p.currentMessageId).length;

  // Panel dává smysl jen tam, kde je co ukázat. Telefon dohledaný ve feedu
  // je taky důvod — u zákazníka, který píše poprvé, je to jediná věc, kterou
  // o něm víme, a zároveň ta nejužitečnější.
  if (!p.orderRef && others === 0 && orders.length === 0 && !hasPhone) return null;

  const toggle = (t: 'orders') => setTab(cur => (cur === t ? null : t));

  return (
    <div className={`cpanel ${p.orderRef && !p.orderRef.resolved ? 'pending' : ''}`}>
      <div className="cp-head">
        <span className="cp-avatar" style={{ background: avatarColor(p.email) }}>
          {(name || '?').charAt(0).toUpperCase()}
        </span>
        <span className="cp-name">{name}</span>

        {p.orderRef && (
          <span className="cp-tag"><Icon name="bag" size={11} /> {p.orderRef.orderNumber}</span>
        )}

        <CallContact email={p.email} orderCode={p.orderRef?.orderNumber} compact />

        <span style={{ flex: 1 }} />

        <button className="cp-tab" onClick={p.onOpenConversation} disabled={msgs.length === 0}
          data-tip="Celá komunikace s tímto zákazníkem jako chat">
          <Icon name="chat" size={12} /> Konverzace
          {msgs.length > 0 && <span className="cp-count">{msgs.length}</span>}
        </button>
        <button className={`cp-tab ${tab === 'orders' ? 'on' : ''}`} onClick={() => toggle('orders')}
          disabled={orders.length === 0}>
          <Icon name="bag" size={12} /> Objednávky
          {orders.length > 0 && <span className="cp-count">{orders.length}</span>}
        </button>

        {p.orderRef && (
          <button className={`cp-resolve ${p.orderRef.resolved ? 'done' : ''}`}
            onClick={() => p.onResolve(!p.orderRef!.resolved)}
            data-tip={p.orderRef.resolved
              ? 'Vrátit mezi zprávy čekající na odpověď'
              : 'Označit jako vyřízené — zmizí ze složky K objednávkám'}>
            <Icon name="check" size={12} /> {p.orderRef.resolved ? 'Vyřízeno' : 'Vyřídit'}
          </button>
        )}
      </div>


      {tab === 'orders' && (
        <div className="cp-body">
          {orders.map(o => (
            <OrderRow key={o.orderNumber} orderNumber={o.orderNumber} messageId={o.messageId} date={o.date}
              highlight={p.orderRef?.orderNumber === o.orderNumber}
              onOpenMessage={p.onOpenMessage} />
          ))}
        </div>
      )}
    </div>
  );
}
