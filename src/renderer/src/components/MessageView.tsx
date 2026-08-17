import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import type { AccountPublic, MessageFull, Settings, OrderCard as OrderCardData } from '@shared/types';
import { api } from '../api';
import { useToast } from '../toast';
import type { ComposerInit } from './Composer';
import Icon from './Icon';
import OrderCard from './OrderCard';
import CustomerPanel from './CustomerPanel';
import { shopLabel } from './OrderBadge';
import ConversationModal from './ConversationModal';

const AVATAR_COLORS = ['#7c5cff', '#e5638d', '#2f9e6e', '#d99a1b', '#2b8fd6', '#b45c14', '#8a5cd6'];

function avatarColor(s: string): string {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

function sanitizeEmailHtml(html: string, allowRemote: boolean): string {
  const clean = DOMPurify.sanitize(html, {
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'base', 'meta'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick'],
    WHOLE_DOCUMENT: false
  });
  let out = clean;
  if (!allowRemote) {
    out = out.replace(/(<img[^>]+src=["'])(https?:)?\/\/[^"']*/gi, '$1');
  }
  return `<!doctype html><html><head><meta charset="utf-8"><base target="_blank">
    <style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;line-height:1.55;color:#222;margin:20px 24px;word-break:break-word}img{max-width:100%;height:auto}a{color:#5f3fe8}blockquote{border-left:3px solid #ddd;margin:8px 0;padding:4px 12px;color:#666}</style>
    </head><body>${out}</body></html>`;
}

function fmtSize(n: number): string {
  if (n > 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n > 1024) return `${Math.round(n / 1024)} kB`;
  return `${n} B`;
}

interface Props {
  detail: MessageFull | null;
  selectedId: number | null;
  account: AccountPublic | null;
  settings: Settings | null;
  onCompose: (init: ComposerInit) => void;
  onChanged: () => void;
  onClose: () => void;
  onOpenMessage: (id: number) => void;
}

export default function MessageView(p: Props) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [translation, setTranslation] = useState<{ lang: string; translation: string } | null>(null);
  const [showRemote, setShowRemote] = useState(false);

  const d = p.detail;

  // Při přepnutí na jinou zprávu resetovat lokální AI stav — jinak zůstane
  // shrnutí/překlad z předchozího mailu zobrazený u nového
  useEffect(() => {
    setSummary(null);
    setTranslation(null);
    setShowRemote(false);
    setBusy(null);
  }, [p.selectedId]);

  // Přehled objednávky z potvrzovacího mailu (null = tahle zpráva objednávku neobsahuje)
  const [order, setOrder] = useState<OrderCardData | null>(null);
  const [orderOpen, setOrderOpen] = useState(true);
  const [orderRefreshing, setOrderRefreshing] = useState(false);
  useEffect(() => {
    setOrder(null);
    setOrderOpen(true);
    setOrderRefreshing(false);
    setShipLoading(false); // jinak by po přepnutí zprávy zůstalo viset načítání
    if (!d?.id) return;
    let cancelled = false;
    const id = d.id;
    api.orders.card(id).then(c => {
      if (cancelled) return;
      setOrder(c);
      // Dopravci jako PPL vypisují cestu zásilky až JavaScriptem — načtení
      // stránky trvá pár vteřin, takže se dotahuje až po zobrazení karty.
      if (c?.tracking?.trackingCode && !c.tracking.shipment && c.tracking.carrierId) {
        setShipLoading(true);
        // Pojistka: načtení stránky dopravce ve skrytém okně má vlastní limit,
        // ale kdyby se cokoli zaseklo, nesmí se točit kolečko donekonečna
        const guard = window.setTimeout(() => setShipLoading(false), 60_000);
        api.orders.shipment(id)
          .then(tr => {
            if (!cancelled && tr) setOrder(prev => (prev ? { ...prev, tracking: tr } : prev));
          })
          .catch(() => {})
          .finally(() => { window.clearTimeout(guard); setShipLoading(false); });
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [d?.id]);

  const [convOpen, setConvOpen] = useState(false);

  const [shipLoading, setShipLoading] = useState(false);
  const retryShipment = async () => {
    if (!d?.id) return;
    setShipLoading(true);
    try {
      const tr = await api.orders.shipment(d.id, true);
      if (tr) setOrder(prev => (prev ? { ...prev, tracking: tr } : prev));
      if (!tr?.shipment) toast('Stránku dopravce se nepodařilo přečíst — zkus sledování otevřít v prohlížeči.');
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setShipLoading(false);
    }
  };

  const refreshOrder = async () => {
    if (!d?.id) return;
    setOrderRefreshing(true);
    try { setOrder(await api.orders.refresh(d.id)); }
    catch (e: any) { toast(e.message, 'error'); }
    finally { setOrderRefreshing(false); }
  };

  // Inline obrázky (cid:) nahradíme lokálně uloženými přílohami
  const [inlineHtml, setInlineHtml] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!d?.bodyHtml) { setInlineHtml(null); return; }
      let html = d.bodyHtml;
      for (const a of d.attachments) {
        if (a.cid && html.includes(`cid:${a.cid}`)) {
          try {
            const url = await api.files.readAsDataUrl(a.path);
            html = html.split(`cid:${a.cid}`).join(url);
          } catch { /* necháme cid — obrázek se prostě nezobrazí */ }
        }
      }
      if (!cancelled) setInlineHtml(html);
    })();
    return () => { cancelled = true; };
  }, [d]);

  /**
   * Rám s tělem zprávy dostane výšku podle svého obsahu, aby neměl vlastní
   * posuvník. Skripty v něm neběží (sandbox bez `allow-scripts`), takže je
   * bezpečné povolit čtení jeho dokumentu a výšku změřit zvenčí.
   */
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const fitFrame = useCallback(() => {
    const el = frameRef.current;
    const doc = el?.contentDocument;
    if (!el || !doc?.body) return;
    const h = Math.max(doc.body.scrollHeight, doc.documentElement?.scrollHeight ?? 0);
    if (h > 0) el.style.height = `${h + 8}px`;
  }, []);

  // Obrázky a písma dorazí až po načtení, proto se měří ještě několikrát
  const onFrameLoad = () => {
    fitFrame();
    [100, 400, 1200].forEach(ms => window.setTimeout(fitFrame, ms));
    const doc = frameRef.current?.contentDocument;
    if (doc?.body && typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => fitFrame());
      ro.observe(doc.body);
      frameObserver.current?.disconnect();
      frameObserver.current = ro;
    }
  };
  const frameObserver = useRef<ResizeObserver | null>(null);
  useEffect(() => () => frameObserver.current?.disconnect(), []);

  const frameHtml = useMemo(() => {
    const src = inlineHtml ?? d?.bodyHtml;
    if (!src) return null;
    return sanitizeEmailHtml(src, (p.settings?.loadRemoteImages ?? false) || showRemote);
  }, [d, inlineHtml, p.settings, showRemote]);

  if (!p.selectedId) {
    return (
      <div className="read-pane">
        <div className="empty-state" style={{ marginTop: '30vh' }}>
          <div className="big"><Icon name="mailOpen" size={36} /></div>
          Vyber zprávu ze seznamu
        </div>
      </div>
    );
  }

  if (!d) {
    return (
      <div className="read-pane">
        <div className="empty-state" style={{ marginTop: '30vh' }}>
          <span className="spinner-inline" /> Načítám zprávu…
        </div>
      </div>
    );
  }

  // U potvrzení objednávky posílá poštu e-shop, takže zákazníkem je příjemce.
  // Bez tohohle by se u starých objednávkových mailů panel vůbec neukázal.
  const shop = shopLabel(p.settings?.productFeedUrl ?? null);
  const fromIsShop = !!shop && (d.fromAddr.split('@')[1] ?? '').toLowerCase().includes(shop);
  const customerEmail = fromIsShop
    ? (d.toAddr.split(',')[0] ?? '').trim()
    : d.fromAddr;
  const customerName = fromIsShop ? '' : d.fromName;

  const shownSummary = summary ?? d.summary;
  const shownTranslation = translation ?? (d.translationCz ? { lang: d.detectedLang ?? '?', translation: d.translationCz } : null);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try { await fn(); } catch (e: any) { toast(e.message, 'error'); } finally { setBusy(null); }
  };

  const doSummarize = () => run('sum', async () => setSummary(await api.ai.summarize(d.id)));
  const doTranslate = () => run('tr', async () => {
    const res = await api.ai.translateIncoming(d.id);
    if (!res.translation) toast('Zpráva je již v češtině (nebo slovenštině).');
    setTranslation(res);
  });
  const doArchive = () => run('arch', async () => {
    await api.messages.archive(d.id);
    toast('Zpráva archivována lokálně včetně příloh.');
    p.onChanged();
  });
  const doDelete = () => run('del', async () => {
    await api.messages.delete(d.id);
    toast('Zpráva smazána.');
    p.onClose();
    p.onChanged();
  });

  const doExportPdf = () => run('pdf', async () => {
    const inner = d.bodyHtml
      ? DOMPurify.sanitize(inlineHtml ?? d.bodyHtml, { FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'base', 'meta'] })
      : `<pre style="white-space:pre-wrap;font-family:inherit">${(d.bodyText ?? '').replace(/</g, '&lt;')}</pre>`;
    const printHtml = `<!doctype html><html><head><meta charset="utf-8"><style>
      body{font-family:-apple-system,Segoe UI,Arial,sans-serif;font-size:13px;color:#222;margin:28px;line-height:1.5}
      img{max-width:100%;height:auto}
      .hdr{border-bottom:2px solid #7c5cff;padding-bottom:12px;margin-bottom:18px}
      .hdr h1{font-size:18px;margin:0 0 8px}
      .hdr div{color:#666;font-size:12px}
    </style></head><body>
      <div class="hdr">
        <h1>${d.subject.replace(/</g, '&lt;') || '(bez předmětu)'}</h1>
        <div>Od: ${(d.fromName || '').replace(/</g, '&lt;')} &lt;${d.fromAddr}&gt;</div>
        <div>Komu: ${d.toAddr.replace(/</g, '&lt;')}</div>
        <div>Datum: ${new Date(d.date).toLocaleString('cs-CZ')}</div>
        ${d.attachments.length ? `<div>Přílohy: ${d.attachments.map(a => a.filename).join(', ')}</div>` : ''}
      </div>${inner}</body></html>`;
    const saved = await api.pdf.export(d.subject || 'zprava', printHtml);
    if (saved) toast('PDF uloženo.');
  });

  const replyInit: ComposerInit = {
    mode: 'reply',
    accountId: d.accountId,
    to: d.fromAddr,
    subject: d.subject.match(/^re:/i) ? d.subject : `Re: ${d.subject}`,
    inReplyTo: d.messageId,
    references: d.messageId,
    replyToDbId: d.id,
    quotedText: d.bodyText ?? '',
    originalLang: shownTranslation?.lang ?? d.detectedLang ?? null
  };

  const reply = () => p.onCompose(replyInit);

  /** Na jedno kliknutí: AI navrhne odpověď dle vlákna, znalostí a předešlých odpovědí */
  const suggestReply = () => run('suggest', async () => {
    const text = await api.ai.reply({ messageDbId: d.id, note: '', language: 'auto' });
    p.onCompose({ ...replyInit, body: text });
  });

  const forward = () => p.onCompose({
    mode: 'forward',
    accountId: d.accountId,
    subject: d.subject.match(/^fwd?:/i) ? d.subject : `Fwd: ${d.subject}`,
    quotedText: `---------- Přeposlaná zpráva ----------\nOd: ${d.fromName} <${d.fromAddr}>\nDatum: ${new Date(d.date).toLocaleString('cs-CZ')}\nPředmět: ${d.subject}\n\n${d.bodyText ?? ''}`,
    attachmentPaths: d.attachments.map(a => a.path)
  });

  return (
    <div className="read-pane">
      {convOpen && (
        <ConversationModal
          email={customerEmail}
          fallbackName={customerName}
          focusMessageId={d.id}
          onClose={() => setConvOpen(false)}
          onOpenMessage={id => { setConvOpen(false); p.onOpenMessage(id); }}
          onReply={() => { setConvOpen(false); reply(); }}
        />
      )}
      <div className="read-toolbar">
        <button className="toolbar-btn primary" onClick={reply}><Icon name="reply" size={14} /> Odpovědět</button>
        <button className="toolbar-btn ai" disabled={busy === 'suggest'} onClick={suggestReply}
          data-tip="AI navrhne odpověď podle vlákna, firemních znalostí a předešlých odpovědí">
          {busy === 'suggest' ? <span className="spinner-inline" /> : <Icon name="zap" size={14} />} Navrhnout odpověď
        </button>
        <button className="toolbar-btn" onClick={forward}><Icon name="forward" size={14} /> Přeposlat</button>
        <button className="toolbar-btn" disabled={!customerEmail} onClick={() => setConvOpen(true)}
          data-tip="Celá komunikace s tímto zákazníkem i jeho objednávky">
          <Icon name="chat" size={14} /> Konverzace
        </button>
        <button className="toolbar-btn ai" disabled={busy === 'sum'} onClick={doSummarize}>
          {busy === 'sum' ? <span className="spinner-inline" /> : <Icon name="sparkles" size={14} />} Shrnout
        </button>
        <button className="toolbar-btn ai" disabled={busy === 'tr'} onClick={doTranslate}>
          {busy === 'tr' ? <span className="spinner-inline" /> : <Icon name="globe" size={14} />} Přeložit
        </button>
        <span className="toolbar-spacer" />
        <button className="toolbar-btn" disabled={busy === 'pdf'} data-tip="Uložit zprávu jako PDF" onClick={doExportPdf}>
          {busy === 'pdf' ? <span className="spinner-inline" /> : <Icon name="printer" size={15} />}
        </button>
        <button className="toolbar-btn" data-tip={d.flagged ? 'Odebrat hvězdičku' : 'Označit hvězdičkou'}
          style={d.flagged ? { color: 'var(--warn)' } : undefined}
          onClick={() => api.messages.setFlag(d.id, 'flagged', !d.flagged).then(p.onChanged)}>
          <Icon name="star" size={15} filled={d.flagged} />
        </button>
        <button className="toolbar-btn" data-tip="Označit jako nepřečtené"
          onClick={() => { api.messages.setFlag(d.id, 'seen', false).then(() => { p.onClose(); p.onChanged(); }); }}>
          <Icon name="mail" size={15} />
        </button>
        <button className="toolbar-btn" disabled={busy === 'arch'} data-tip="Archivovat lokálně (včetně příloh)" onClick={doArchive}>
          {busy === 'arch' ? <span className="spinner-inline" /> : <Icon name="save" size={15} />}
        </button>
        <button className="toolbar-btn" disabled={busy === 'del'} data-tip="Smazat" onClick={doDelete}><Icon name="trash" size={15} /></button>
      </div>

      <div className="read-scroll">
        <div className="read-card">
          <div className="read-header">
            <div className="read-subject">
              {d.subject || '(bez předmětu)'}
              {d.archived && (
                <span className="arch-chip" style={{ marginLeft: 10, verticalAlign: '3px' }}
                  data-tip="Zpráva je uložena v lokálním archivu (včetně příloh, dostupná offline)">
                  <Icon name="save" size={10} /> archiv
                </span>
              )}
            </div>
            <div className="read-meta">
              <div className="avatar" style={{ background: avatarColor(d.fromAddr) }}>
                {(d.fromName || d.fromAddr || '?').charAt(0).toUpperCase()}
              </div>
              <div className="who">
                <div className="name">{d.fromName || d.fromAddr}</div>
                <div className="addr">{d.fromAddr}{d.toAddr ? ` → ${d.toAddr}` : ''}</div>
              </div>
              <div className="when">{new Date(d.date).toLocaleString('cs-CZ')}</div>
            </div>
          </div>

          {/* Kontext zákazníka — kdo píše, jeho historie a objednávky */}
          {customerEmail && (
            <CustomerPanel
              email={customerEmail}
              fallbackName={customerName}
              currentMessageId={d.id}
              orderRef={d.orderRef}
              onOpenMessage={p.onOpenMessage}
              onOpenConversation={() => setConvOpen(true)}
              onResolve={value => {
                api.orderLinks.resolve(d.id, value).then(p.onChanged).catch((e: any) => toast(e.message, 'error'));
              }}
            />
          )}

          {order && (
            <div className="oc-wrap">
              <button className="oc-toggle" onClick={() => setOrderOpen(o => !o)}>
                <Icon name="chevDown" size={13} style={{ transform: orderOpen ? 'none' : 'rotate(-90deg)', transition: 'transform .15s' }} />
                {orderOpen ? 'Skrýt přehled objednávky' : `Zobrazit přehled objednávky${order.orderNumber ? ` č. ${order.orderNumber}` : ''}`}
              </button>
              {orderOpen && (
                <OrderCard card={order} onRefresh={refreshOrder} refreshing={orderRefreshing}
                  shipmentLoading={shipLoading} onRetryShipment={retryShipment} />
              )}
            </div>
          )}



          {shownSummary && (
            <div className="summary-banner"><Icon name="sparkles" size={14} style={{ marginTop: 2 }} /> <span>{shownSummary}</span></div>
          )}

          {shownTranslation?.translation && (
            <div className="translate-banner">
              <div className="tb-head">
                <span><Icon name="globe" size={13} /> Překlad do češtiny (z „{shownTranslation.lang}")</span>
              </div>
              <div style={{ whiteSpace: 'pre-wrap' }}>{shownTranslation.translation}</div>
            </div>
          )}

          {!((p.settings?.loadRemoteImages ?? false) || showRemote) && d.bodyHtml && /img[^>]+src=["'](https?:)?\/\//i.test(d.bodyHtml) && (
            <div className="translate-banner" style={{ background: '#f4f2fa', borderColor: 'var(--border)' }}>
              Vzdálené obrázky jsou kvůli soukromí blokovány.{' '}
              <button style={{ color: 'var(--accent-dark)', fontWeight: 600 }} onClick={() => setShowRemote(true)}>Zobrazit obrázky</button>
            </div>
          )}

          {frameHtml
            ? <iframe ref={frameRef} className="mail-body-frame" sandbox="allow-popups allow-same-origin"
                srcDoc={frameHtml} title="email" onLoad={onFrameLoad} />
            : <div className="mail-body-text">{d.bodyText || d.snippet || '(prázdná zpráva)'}</div>}

          {d.attachments.length > 0 && (
            <div className="attachments-row">
              {d.attachments.map(a => (
                <button key={a.id} className="attachment-chip" data-tip="Otevřít přílohu"
                  onClick={() => api.files.openAttachment(a.path).catch((e: any) => toast(e.message, 'error'))}>
                  <Icon name="paperclip" size={13} /> {a.filename} <span style={{ color: 'var(--text-3)' }}>{fmtSize(a.size)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
