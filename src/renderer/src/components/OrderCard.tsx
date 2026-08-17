import { useEffect, useState } from 'react';
import type { OrderCard as OrderCardData, OrderAddress, OrderCardItem, ShipPhase } from '@shared/types';
import { api } from '../api';
import Icon from './Icon';

/** Popisky karty ve třech jazykových mutacích e-shopu. */
const T = {
  cz: {
    order: 'Objednávka', billing: 'Fakturační adresa', shipping: 'Doručovací adresa',
    shipment: 'Doprava', payment: 'Platba', paid: 'Zaplaceno', unpaid: 'Nezaplaceno',
    track: 'Sledovat zásilku', admin: 'Administrace', detail: 'Detail objednávky',
    copy: 'Kopírovat adresu', copied: 'Zkopírováno', refresh: 'Obnovit stav',
    noFeed: 'není ve feedu', received: 'Přijato', pcs: 'ks', now: 'nyní'
  },
  sk: {
    order: 'Objednávka', billing: 'Fakturačná adresa', shipping: 'Doručovacia adresa',
    shipment: 'Doprava', payment: 'Platba', paid: 'Zaplatené', unpaid: 'Nezaplatené',
    track: 'Sledovať zásielku', admin: 'Administrácia', detail: 'Detail objednávky',
    copy: 'Kopírovať adresu', copied: 'Skopírované', refresh: 'Obnoviť stav',
    noFeed: 'nie je vo feede', received: 'Prijaté', pcs: 'ks', now: 'teraz'
  },
  en: {
    order: 'Order', billing: 'Billing address', shipping: 'Delivery address',
    shipment: 'Shipping', payment: 'Payment', paid: 'Paid', unpaid: 'Unpaid',
    track: 'Track shipment', admin: 'Admin', detail: 'Order detail',
    copy: 'Copy address', copied: 'Copied', refresh: 'Refresh status',
    noFeed: 'not in feed', received: 'Received', pcs: 'pcs', now: 'now'
  }
};

type Dict = typeof T.cz;

function toneOf(card: OrderCardData): 'new' | 'paid' | 'sent' | 'done' | 'problem' {
  const s = (card.tracking?.status ?? card.live?.status ?? '').toLowerCase();
  if (/storn|zru[šs]en|vr[áa]cen|reklamac|cancel|refund/.test(s)) return 'problem';
  if (card.live?.deliveredDate || /doru[čc]en|vyzvednut|dokon[čc]en|complete|delivered/.test(s)) return 'done';
  if (/odesl[áa]n|expedov|p[řr]ed[áa]n|na cest[ěe]|shipped|dispatch/.test(s)) return 'sent';
  if (card.live?.paid || card.tracking?.paidDate || /zaplacen|uhrazen|paid/.test(s)) return 'paid';
  return 'new';
}

/** Popis fáze zásilky — v kartě je vidět dřív než samotná hláška dopravce */
const PHASE: Record<ShipPhase, { label: string; icon: string }> = {
  pending:   { label: 'Čeká na předání', icon: 'clock' },
  transit:   { label: 'Na cestě',        icon: 'truck' },
  ready:     { label: 'K vyzvednutí',    icon: 'pin' },
  delivered: { label: 'Doručeno',        icon: 'check' },
  problem:   { label: 'Pozor',           icon: 'ban' },
  unknown:   { label: '',                icon: 'truck' }
};

function addressText(a: OrderAddress): string {
  return [a.name, a.company, ...a.lines, a.country].filter(Boolean).join('\n');
}

function ItemRow({ it, t, onZoom }: { it: OrderCardItem; t: Dict; onZoom: (it: OrderCardItem) => void }) {
  const [broken, setBroken] = useState(false);
  const href = it.feedUrl || it.url;
  const showImg = !!it.image && !broken;

  return (
    <div className="oc-item">
      <button
        className={`oc-thumb ${showImg ? '' : 'empty'}`}
        disabled={!showImg}
        onClick={() => showImg && onZoom(it)}
        data-tip={showImg ? 'Zobrazit velký obrázek' : undefined}
      >
        {showImg
          ? <><img src={it.image!} alt="" referrerPolicy="no-referrer" onError={() => setBroken(true)} />
              <span className="oc-zoom"><Icon name="expand" size={12} /></span></>
          : <Icon name="image" size={16} />}
      </button>

      <div className="oc-item-main">
        <div className="oc-item-title">
          {href
            ? <button className="oc-link" onClick={() => api.shell.openUrl(href)}>{it.title}</button>
            : <span>{it.title}</span>}
        </div>
        <div className="oc-item-sub">
          {it.code && <span className="oc-code">{it.code}</span>}
          {it.variants.map((v, i) => <span key={i} className="pk-variant">{v}</span>)}
          {it.availability && <span>{it.availability}</span>}
          {!it.matched && <span data-tip="Produkt se nepodařilo najít v produktovém feedu">{t.noFeed}</span>}
        </div>
      </div>

      <div className="oc-item-right">
        <span className={`oc-qty ${(it.qty || 1) > 1 ? 'many' : ''}`}>{it.qty}&nbsp;{it.unit || t.pcs}</span>
        <span className="oc-price">{it.price || '—'}</span>
      </div>
    </div>
  );
}

interface Props {
  card: OrderCardData;
  /** Sevřená varianta pro náhled v seznamu zpráv */
  compact?: boolean;
  /** Ruční obnovení stavu (jen v detailu zprávy) */
  onRefresh?: () => void;
  refreshing?: boolean;
  /** Probíhá dotažení stavu u dopravce (druhá fáze) */
  shipmentLoading?: boolean;
  /** Zopakování pokusu o načtení stavu u dopravce */
  onRetryShipment?: () => void;
}

export default function OrderCard({
  card, compact = false, onRefresh, refreshing, shipmentLoading, onRetryShipment
}: Props) {
  const t: Dict = T[card.lang] ?? T.cz;
  const [zoom, setZoom] = useState<OrderCardItem | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!zoom) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setZoom(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoom]);

  const addr = card.shipping ?? card.billing;
  const copyAddress = async () => {
    if (!addr) return;
    await navigator.clipboard.writeText(addressText(addr));
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const tone = toneOf(card);
  const status = card.tracking?.status ?? card.live?.status ?? null;
  const paid = !!(card.live?.paid || card.tracking?.paidDate);
  const tr = card.tracking;
  const trackUrl = tr?.trackingUrl ?? card.live?.trackingUrl ?? null;
  const trackCode = tr?.trackingCode ?? card.live?.trackingCode ?? null;
  const detailUrl = card.historyUrl;

  return (
    <div className={`order-card ${compact ? 'compact' : ''}`}>
      <div className="oc-head">
        <span className={`oc-badge tone-${tone}`}>
          <Icon name="bag" size={12} />
          {card.orderNumber ? `č. ${card.orderNumber}` : t.order}
        </span>
        {status && <span className="oc-status">{status}</span>}
        <span className="oc-spacer" />
        <span className={`oc-paid ${paid ? 'yes' : 'no'}`}>{paid ? t.paid : t.unpaid}</span>
        {card.total && <span className="oc-total">{card.total}</span>}
        {onRefresh && (
          <button className={`oc-icon-btn ${refreshing ? 'spinning' : ''}`} onClick={onRefresh}
            disabled={refreshing} data-tip={t.refresh}>
            <Icon name="refresh" size={13} />
          </button>
        )}
      </div>

      {card.items.length > 0 && (
        <div className="oc-items">
          {card.items.map((it, i) => <ItemRow key={`${it.code ?? it.title}-${i}`} it={it} t={t} onZoom={setZoom} />)}
        </div>
      )}

      {/* Doprava, platba a poslední stav zásilky */}
      {(card.shipmentName || card.paymentName || tr?.shipment) && (
        <div className="oc-block">
          {card.shipmentName && (
            <div className="oc-row">
              <Icon name="truck" size={13} className="oc-row-icon" />
              <span className="oc-row-label">{t.shipment}</span>
              <span className="oc-row-value">{card.shipmentName}</span>
              {card.shipmentPrice && <span className="oc-row-extra">{card.shipmentPrice}</span>}
            </div>
          )}
          {card.paymentName && (
            <div className="oc-row">
              <Icon name="card" size={13} className="oc-row-icon" />
              <span className="oc-row-label">{t.payment}</span>
              <span className="oc-row-value">{card.paymentName}</span>
              {card.paymentPrice && <span className="oc-row-extra">{card.paymentPrice}</span>}
            </div>
          )}
          {/* Hlásí se jen skutečný neúspěch — ne stav, o který jsme ještě nežádali */}
          {!tr?.shipment && trackCode && (shipmentLoading || tr?.shipmentError) && (
            <div className="oc-ship pending">
              {shipmentLoading
                ? <div className="oc-ship-desc"><span className="spinner-inline" /> Zjišťuji stav u dopravce…</div>
                : <div className="oc-ship-desc">
                    {tr!.shipmentError}
                    {onRetryShipment && <button className="oc-ship-retry" onClick={onRetryShipment}>Zkusit znovu</button>}
                  </div>}
            </div>
          )}
          {tr?.shipment && (() => {
            const ph = tr.shipment.phase ?? 'unknown';
            const meta = PHASE[ph];
            return (
              <div className={`oc-ship phase-${ph}`}>
                <div className="oc-ship-head">
                  <span className="oc-ship-badge"><Icon name={meta.icon} size={12} /></span>
                  <b>{meta.label || tr.shipment!.stage || tr.carrierName || t.track}</b>
                  {tr.carrierName && <span className="oc-ship-carrier">{tr.carrierName}</span>}
                  <span className="oc-spacer" />
                  <span className="oc-ship-at">{tr.shipment!.at}</span>
                </div>
                <div className="oc-ship-desc">{tr.shipment!.description}</div>
              </div>
            );
          })()}
        </div>
      )}

      {(card.billing || card.shipping) && (
        <div className="oc-addrs">
          {card.billing && (
            <div className="oc-addr">
              <div className="oc-addr-head"><Icon name="fileText" size={11} /> {t.billing}</div>
              <div className="oc-addr-body">
                <b>{card.billing.name}</b>
                {card.billing.company && <div>{card.billing.company}</div>}
                {card.billing.lines.map((l, i) => <div key={i}>{l}</div>)}
                {card.billing.country && <div className="oc-dim">{card.billing.country}</div>}
              </div>
            </div>
          )}
          {card.shipping && (
            <div className="oc-addr">
              <div className="oc-addr-head"><Icon name="pin" size={11} /> {t.shipping}</div>
              <div className="oc-addr-body">
                <b>{card.shipping.name}</b>
                {card.shipping.company && <div>{card.shipping.company}</div>}
                {card.shipping.lines.map((l, i) => <div key={i}>{l}</div>)}
                {card.shipping.country && <div className="oc-dim">{card.shipping.country}</div>}
              </div>
            </div>
          )}
        </div>
      )}

      {(card.customerEmail || card.customerPhone || card.placedAt) && (
        <div className="oc-contact">
          {card.customerEmail && <span><Icon name="mail" size={11} /> {card.customerEmail}</span>}
          {card.customerPhone && <span><Icon name="phone" size={11} /> {card.customerPhone}</span>}
          {card.placedAt && <span><Icon name="clock" size={11} /> {t.received}: {card.placedAt}</span>}
        </div>
      )}

      <div className="oc-actions">
        {addr && (
          <button className="oc-btn" onClick={copyAddress}>
            <Icon name={copied ? 'check' : 'copy'} size={12} /> {copied ? t.copied : t.copy}
          </button>
        )}
        {trackUrl && (
          <button className="oc-btn primary" onClick={() => api.shell.openUrl(trackUrl)}>
            <Icon name="truck" size={12} />
            {tr?.carrierName ? `${tr.carrierName}` : t.track}
            {trackCode && <span className="oc-btn-code">{trackCode}</span>}
          </button>
        )}
        {detailUrl && (
          <button className="oc-btn" onClick={() => api.shell.openUrl(detailUrl)}>
            <Icon name="fileText" size={12} /> {t.detail}
          </button>
        )}
        {card.adminUrl && (
          <button className="oc-btn" onClick={() => api.shell.openUrl(card.adminUrl!)}
            data-tip={card.adminSource === 'list'
              ? 'Vede jen na přehled objednávek — přesný odkaz zapneš v Nastavení → AI („Odkaz na objednávku v administraci")'
              : card.adminSource === 'offset'
                ? 'Dopočítáno z kalibrace v nastavení'
                : undefined}>
            <Icon name="settings" size={12} /> {t.admin}{card.adminSource === 'list' ? ' →' : ''}
          </button>
        )}
      </div>

      {zoom && (
        <div className="oc-lightbox" onClick={() => setZoom(null)}>
          <div className="oc-lightbox-inner" onClick={e => e.stopPropagation()}>
            <img src={zoom.image!} alt={zoom.title} referrerPolicy="no-referrer" />
            <div className="oc-lightbox-bar">
              <b>{zoom.title}</b>
              {zoom.code && <span className="oc-code">{zoom.code}</span>}
              <span className="oc-spacer" />
              {(zoom.feedUrl || zoom.url) && (
                <button className="oc-btn" onClick={() => api.shell.openUrl((zoom.feedUrl || zoom.url)!)}>
                  <Icon name="globe" size={12} /> Otevřít produkt
                </button>
              )}
              <button className="oc-btn" onClick={() => setZoom(null)}><Icon name="x" size={12} /></button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
