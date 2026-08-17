import { useEffect, useState } from 'react';
import type { MessageHeader, Category, MessageSort, ListFilters } from '@shared/types';
import { CATEGORY_LABELS } from '@shared/types';
import type { View } from './Sidebar';
import { api } from '../api';
import { useToast } from '../toast';
import Icon from './Icon';
import OrderBadge, { looksLikeOrder, shopLabel } from './OrderBadge';

function fmtDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString('cs-CZ', sameYear ? { day: 'numeric', month: 'numeric' } : { day: 'numeric', month: 'numeric', year: '2-digit' });
}

function fmtSize(n: number): string {
  if (!n) return '';
  if (n > 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} kB`;
}

const SORT_OPTIONS: { value: MessageSort; label: string }[] = [
  { value: 'date_desc', label: 'Nejnovější' },
  { value: 'date_asc', label: 'Nejstarší' },
  { value: 'size_desc', label: 'Největší' },
  { value: 'size_asc', label: 'Nejmenší' },
  { value: 'from_az', label: 'Odesílatel A–Z' }
];

interface Props {
  messages: MessageHeader[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  search: string;
  onSearch: (q: string) => void;
  sort: MessageSort;
  onSort: (s: MessageSort) => void;
  filters: ListFilters;
  onFilters: (f: ListFilters) => void;
  syncing: boolean;
  onRefresh: () => void;
  view: View;
  category: Category | null;
  hasAccount: boolean;
  accountId: number | null;
  isTrash: boolean;
  /** URL produktového feedu — z ní se pozná doména vlastního e-shopu */
  productFeedUrl: string | null;
  onChanged: () => void;
  onCloseDetail: () => void;
}

export default function MessageList(p: Props) {
  const toast = useToast();
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);

  // Reset výběru při změně pohledu; jinak jen pročistit o zmizelé zprávy
  useEffect(() => { setChecked(new Set()); }, [p.view]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setChecked(prev => {
      const ids = new Set(p.messages.map(m => m.id));
      const next = new Set([...prev].filter(id => ids.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [p.messages]);

  const title =
    p.view.type === 'orderInbox' ? 'K objednávkám'
    : p.view.type === 'archive' ? 'Archiv'
    : p.view.type === 'category' ? CATEGORY_LABELS[p.view.category]
    : p.view.folder.toUpperCase() === 'INBOX' ? 'Doručená pošta'
    : p.view.folder.split('/').pop() ?? p.view.folder;

  const toggle = (id: number) => setChecked(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const allChecked = p.messages.length > 0 && checked.size === p.messages.length;
  const toggleAll = () => setChecked(allChecked ? new Set() : new Set(p.messages.map(m => m.id)));

  const ids = [...checked];

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try { await fn(); } catch (e: any) { toast(e.message, 'error'); } finally { setBusy(null); }
  };

  const bulk = {
    read: (value: boolean) => run('read', async () => {
      await api.messages.bulkFlag(ids, 'seen', value);
      setChecked(new Set());
      p.onChanged();
    }),
    star: () => run('star', async () => {
      await api.messages.bulkFlag(ids, 'flagged', true);
      setChecked(new Set());
      p.onChanged();
    }),
    archive: (deleteAfter: boolean) => run(deleteAfter ? 'archdel' : 'arch', async () => {
      if (deleteAfter && !confirm(`Archivovat ${ids.length} zpráv lokálně a poté je SMAZAT ze serveru?`)) return;
      await api.messages.bulkArchive(ids, deleteAfter);
      toast(deleteAfter
        ? `${ids.length} zpráv archivováno a smazáno ze serveru.`
        : `${ids.length} zpráv archivováno lokálně.`);
      setChecked(new Set());
      p.onCloseDetail();
      p.onChanged();
    }),
    del: () => run('del', async () => {
      if (!confirm(`Smazat ${ids.length} zpráv? (přesunou se do koše na serveru)`)) return;
      await api.messages.bulkDelete(ids);
      toast(`${ids.length} zpráv smazáno.`);
      setChecked(new Set());
      p.onCloseDetail();
      p.onChanged();
    })
  };

  const emptyTrash = () => run('trash', async () => {
    if (!p.accountId) return;
    if (!confirm('Trvale smazat VŠECHNY zprávy v koši? Tuto akci nelze vzít zpět.')) return;
    const n = await api.trash.empty(p.accountId);
    toast(n > 0 ? `Koš vysypán (${n} zpráv trvale smazáno).` : 'Koš už byl prázdný.');
    p.onCloseDetail();
    p.onChanged();
  });

  const setF = (patch: ListFilters) => p.onFilters({ ...p.filters, ...patch });
  const shop = shopLabel(p.productFeedUrl);

  return (
    <div className="list-pane">
      <div className="list-header">
        <div className="list-title-row">
          <div className="list-title">{title}</div>
          <div className="list-actions">
            {p.isTrash && (
              <button className="toolbar-btn" disabled={busy === 'trash'} onClick={emptyTrash}
                data-tip="Trvale smazat vše v koši" style={{ color: 'var(--danger)' }}>
                {busy === 'trash' ? <span className="spinner-inline" /> : <Icon name="trash" size={14} />} Vysypat
              </button>
            )}
            <button className={`icon-btn ${p.syncing ? 'spinning' : ''}`} data-tip="Synchronizovat" onClick={p.onRefresh}>
              <Icon name="refresh" size={15} />
            </button>
          </div>
        </div>
        <input
          className="search-input"
          placeholder="Hledat…"
          value={p.search}
          onChange={e => p.onSearch(e.target.value)}
        />
        <div className="filter-row">
          {p.view.type === 'orderInbox' && (
            <button className={`filter-chip ${p.filters.orderAll ? 'on' : ''}`}
              onClick={() => setF({ orderAll: !p.filters.orderAll })}
              data-tip="Zobrazit i vyřízené a starší zprávy k objednávkám">
              <Icon name="archive" size={11} /> Včetně vyřízených
            </button>
          )}
          <button className={`filter-chip ${p.filters.unread ? 'on' : ''}`}
            onClick={() => setF({ unread: !p.filters.unread })}>Nepřečtené</button>
          <button className={`filter-chip ${p.filters.attachments ? 'on' : ''}`}
            onClick={() => setF({ attachments: !p.filters.attachments })}>
            <Icon name="paperclip" size={11} /> Příloha
          </button>
          <button className={`filter-chip ${p.filters.flagged ? 'on' : ''}`}
            onClick={() => setF({ flagged: !p.filters.flagged })}>
            <Icon name="star" size={11} /> Hvězdička
          </button>
          <span style={{ flex: 1 }} />
          <select className="sort-select" value={p.sort} onChange={e => p.onSort(e.target.value as MessageSort)}>
            {SORT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
      </div>

      {checked.size > 0 && (
        <div className="bulk-bar">
          <label className="check-row" style={{ gap: 6 }}>
            <input type="checkbox" checked={allChecked} onChange={toggleAll} />
            <b>{checked.size}</b>&nbsp;vybráno
          </label>
          <span style={{ flex: 1 }} />
          <button className="icon-btn" data-tip="Označit jako přečtené" disabled={!!busy} onClick={() => bulk.read(true)}>
            <Icon name="mailOpen" size={15} />
          </button>
          <button className="icon-btn" data-tip="Označit jako nepřečtené" disabled={!!busy} onClick={() => bulk.read(false)}>
            <Icon name="mail" size={15} />
          </button>
          <button className="icon-btn" data-tip="Přidat hvězdičku" disabled={!!busy} onClick={bulk.star}>
            <Icon name="star" size={15} />
          </button>
          <button className="icon-btn" data-tip="Archivovat lokálně" disabled={!!busy} onClick={() => bulk.archive(false)}>
            {busy === 'arch' ? <span className="spinner-inline" /> : <Icon name="save" size={15} />}
          </button>
          <button className="icon-btn" data-tip="Archivovat lokálně a smazat ze serveru" disabled={!!busy}
            style={{ color: 'var(--warn)' }} onClick={() => bulk.archive(true)}>
            {busy === 'archdel' ? <span className="spinner-inline" /> : <Icon name="archive" size={15} />}
          </button>
          <button className="icon-btn" data-tip="Smazat (do koše)" disabled={!!busy}
            style={{ color: 'var(--danger)' }} onClick={bulk.del}>
            {busy === 'del' ? <span className="spinner-inline" /> : <Icon name="trash" size={15} />}
          </button>
          <button className="icon-btn" data-tip="Zrušit výběr" onClick={() => setChecked(new Set())}>
            <Icon name="x" size={14} />
          </button>
        </div>
      )}

      {checked.size === 0 && p.messages.length > 0 && (
        <div className="select-hint">
          <label className="check-row" style={{ gap: 6, fontSize: 12, color: 'var(--text-3)' }}>
            <input type="checkbox" checked={false} onChange={toggleAll} />
            Vybrat vše ({p.messages.length})
          </label>
        </div>
      )}

      <div className="msg-list">
        {!p.hasAccount && (
          <div className="empty-state">
            <div className="big"><Icon name="mail" size={36} /></div>
            Vítej v Quentino Mail!<br />Začni přidáním e-mailového účtu v Nastavení.
          </div>
        )}
        {p.hasAccount && p.messages.length === 0 && (
          <div className="empty-state">
            <div className="big"><Icon name={p.view.type === 'orderInbox' ? 'check' : 'inbox'} size={36} /></div>
            {p.view.type === 'orderInbox'
              ? <>Nic nečeká na odpověď<br /><span style={{ fontSize: 12 }}>Starší zprávy zobrazíš přepínačem „Včetně vyřízených".</span></>
              : 'Žádné zprávy'}
          </div>
        )}
        {p.messages.map(m => {
          // U objednávek nahrazuje odznak objednávky štítek kategorie — jinak by
          // vedle sebe stálo „Objednávky" a „Objednávka" a řádek by byl přeplácaný
          const isOrder = looksLikeOrder(m, shop);
          return (
          <div key={m.id} className={`msg-item ${m.id === p.selectedId ? 'selected' : ''} ${!m.seen ? 'unread' : ''} ${checked.has(m.id) ? 'checked' : ''}`}>
            <input
              type="checkbox"
              className="msg-check"
              checked={checked.has(m.id)}
              onChange={() => toggle(m.id)}
              onClick={e => e.stopPropagation()}
            />
            <div className="msg-body" role="button" tabIndex={0}
              onClick={() => p.onSelect(m.id)}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); p.onSelect(m.id); } }}>
              <div className="row1">
                {!m.seen && <span className="unread-dot" />}
                {m.flagged && <span className="flag-star"><Icon name="star" size={12} filled /></span>}
                <span className="from">{m.fromName || m.fromAddr || '(neznámý)'}</span>
                {m.orderRef && !isOrder && (
                  <span className={`ord-chip ref ${m.answered || m.orderRef.resolved ? 'done' : ''}`}
                    data-tip={`Zpráva k objednávce ${m.orderRef.orderNumber}`}>
                    <Icon name="reply" size={10} /> {m.orderRef.orderNumber}
                  </span>
                )}
                {isOrder
                  ? <OrderBadge message={m} />
                  : m.category && p.view.type !== 'category' && (
                    <span className={`cat-chip cat-${m.category}`}>{CATEGORY_LABELS[m.category]}</span>
                  )}
                {m.archived && p.view.type !== 'archive' && (
                  <span className="arch-chip" data-tip="Zpráva je uložena v lokálním archivu (včetně příloh, dostupná offline)">
                    <Icon name="save" size={10} /> archiv
                  </span>
                )}
                <span className="date">{fmtDate(m.date)}</span>
              </div>
              <div className="subject">
                {m.hasAttachments && <Icon name="paperclip" size={12} style={{ marginRight: 4, color: 'var(--text-3)' }} />}
                {m.subject || '(bez předmětu)'}
                {(p.sort === 'size_desc' || p.sort === 'size_asc') && m.size > 0 && (
                  <span className="msg-size"> · {fmtSize(m.size)}</span>
                )}
              </div>
              {m.summary
                ? <div className="ai-badge"><Icon name="sparkles" size={12} style={{ marginTop: 2 }} /> {m.summary}</div>
                : m.snippet && <div className="snippet">{m.snippet}</div>}
            </div>
          </div>
          );
        })}
      </div>
    </div>
  );
}
