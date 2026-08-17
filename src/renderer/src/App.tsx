import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AccountPublic, FolderInfo, MessageHeader, MessageFull, Settings, Category, MessageSort, ListFilters } from '@shared/types';
import { api } from './api';
import { ToastProvider, useToast } from './toast';
import Sidebar, { View } from './components/Sidebar';
import MessageList from './components/MessageList';
import MessageView from './components/MessageView';
import Composer, { ComposerInit, UndoInfo } from './components/Composer';
import SettingsModal from './components/SettingsModal';
import OutboxModal from './components/OutboxModal';
import TooltipLayer from './components/TooltipLayer';
import DigestModal from './components/DigestModal';
import PackingModal from './components/PackingModal';

function AppInner() {
  const toast = useToast();
  const [accounts, setAccounts] = useState<AccountPublic[]>([]);
  const [activeAccountId, setActiveAccountId] = useState<number | null>(null);
  const [folders, setFolders] = useState<FolderInfo[]>([]);
  const [view, setView] = useState<View>({ type: 'folder', folder: 'INBOX' });
  const [messages, setMessages] = useState<MessageHeader[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<MessageFull | null>(null);
  const [composer, setComposer] = useState<ComposerInit | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [outboxOpen, setOutboxOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<MessageSort>('date_desc');
  const [filters, setFilters] = useState<ListFilters>({});
  const [syncing, setSyncing] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [catStats, setCatStats] = useState<Record<string, { cnt: number; unseen: number }>>({});
  const [quota, setQuota] = useState<{ used: number; limit: number } | null>(null);
  const [digestOpen, setDigestOpen] = useState(false);
  const [packingOpen, setPackingOpen] = useState(false);
  const [orderPending, setOrderPending] = useState(0);

  // Undo send — lišta s odpočtem, zprávu lze do ~10 s vzít zpět
  const [undoSend, setUndoSend] = useState<(UndoInfo & { until: number }) | null>(null);
  const [undoLeft, setUndoLeft] = useState(0);
  useEffect(() => {
    if (!undoSend) return;
    const t = setInterval(() => {
      const left = Math.max(0, Math.ceil((undoSend.until - Date.now()) / 1000));
      setUndoLeft(left);
      if (left === 0) { setUndoSend(null); }
    }, 250);
    return () => clearInterval(t);
  }, [undoSend]);

  // Vzhled (světlý/tmavý)
  useEffect(() => {
    document.documentElement.dataset.theme = settings?.theme ?? 'light';
  }, [settings?.theme]);

  // Zaplnění schránky na serveru (IMAP QUOTA) — při změně účtu a pak jednou za 10 minut
  useEffect(() => {
    if (!activeAccountId) { setQuota(null); return; }
    let cancelled = false;
    const load = () => api.quota.get(activeAccountId).then(q => { if (!cancelled) setQuota(q); }).catch(() => {});
    load();
    const t = setInterval(load, 10 * 60_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [activeAccountId]);

  // Nastavitelné šířky sloupců (přetažením oddělovačů), pamatují se mezi spuštěními
  const [paneW, setPaneW] = useState<{ side: number; list: number }>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('paneWidths') || 'null');
      if (saved && typeof saved.side === 'number' && typeof saved.list === 'number') return saved;
    } catch { /* */ }
    return { side: 232, list: 360 };
  });
  const dragRef = useRef<{ which: 'side' | 'list'; startX: number; startW: number } | null>(null);
  useEffect(() => {
    const move = (e: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const dx = e.clientX - drag.startX;
      setPaneW(prev => drag.which === 'side'
        ? { ...prev, side: Math.min(340, Math.max(180, drag.startW + dx)) }
        : { ...prev, list: Math.min(620, Math.max(290, drag.startW + dx)) });
    };
    const up = () => {
      if (dragRef.current) { dragRef.current = null; document.body.style.cursor = ''; }
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
  }, []);
  useEffect(() => { localStorage.setItem('paneWidths', JSON.stringify(paneW)); }, [paneW]);
  const startDrag = (which: 'side' | 'list') => (e: React.MouseEvent) => {
    dragRef.current = { which, startX: e.clientX, startW: which === 'side' ? paneW.side : paneW.list };
    document.body.style.cursor = 'col-resize';
    e.preventDefault();
  };

  const activeAccount = useMemo(
    () => accounts.find(a => a.id === activeAccountId) ?? null,
    [accounts, activeAccountId]
  );

  const loadAccounts = useCallback(async () => {
    const list = await api.accounts.list();
    setAccounts(list);
    setActiveAccountId(prev => (prev && list.some(a => a.id === prev) ? prev : list[0]?.id ?? null));
    if (list.length === 0) setSettingsOpen(true);
  }, []);

  const loadFolders = useCallback(async (accountId: number) => {
    try {
      setFolders(await api.folders.list(accountId));
    } catch (e: any) {
      toast(`Složky se nepodařilo načíst: ${e.message}`, 'error');
    }
  }, [toast]);

  const loadMessages = useCallback(async () => {
    if (!activeAccountId) { setMessages([]); return; }
    try {
      const opts: any = { search: search || undefined, sort, ...filters };
      let msgs: MessageHeader[];
      if (view.type === 'orderInbox') {
        msgs = await api.messages.list(activeAccountId, 'INBOX', { ...opts, orderInbox: true, orderAll: !!filters.orderAll });
      } else if (view.type === 'archive') {
        msgs = await api.messages.list(activeAccountId, '', { ...opts, archivedOnly: true });
      } else if (view.type === 'category') {
        msgs = await api.messages.list(activeAccountId, 'INBOX', { ...opts, category: view.category });
      } else {
        msgs = await api.messages.list(activeAccountId, view.folder, opts);
      }
      setMessages(msgs);
    } catch (e: any) {
      toast(e.message, 'error');
    }
  }, [activeAccountId, view, search, sort, filters, toast]);

  const loadStats = useCallback(async () => {
    if (!activeAccountId) return;
    try { setCatStats(await api.stats.categories(activeAccountId)); } catch { /* */ }
    // Vazby zpráv na objednávky se počítají jen z hlaviček, takže je levné
    // je přepočítat po každé změně pošty
    try {
      await api.orderLinks.refresh();
      setOrderPending(await api.orderLinks.pending(activeAccountId));
    } catch { /* */ }
  }, [activeAccountId]);

  useEffect(() => { loadAccounts(); api.settings.get().then(setSettings).catch(() => {}); }, [loadAccounts]);
  useEffect(() => { if (activeAccountId) { loadFolders(activeAccountId); } }, [activeAccountId, loadFolders]);
  useEffect(() => { loadMessages(); loadStats(); }, [loadMessages, loadStats]);

  // Při otevření složky (Odeslané, Koncepty…) ji na pozadí synchronizovat ze serveru,
  // aby se zprávy zobrazily i bez ručního obnovení
  const syncedFolders = useMemo(() => new Set<string>(), [activeAccountId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!activeAccountId || view.type !== 'folder') return;
    const key = view.folder;
    if (syncedFolders.has(key)) return;
    syncedFolders.add(key);
    api.sync.folder(activeAccountId, key).catch(() => syncedFolders.delete(key));
  }, [activeAccountId, view, syncedFolders]);

  // živé aktualizace z main procesu
  useEffect(() => {
    const un1 = api.on('messages:changed', () => { loadMessages(); loadStats(); });
    const un2 = api.on('folders:changed', (p: any) => {
      if (p.accountId === activeAccountId) loadFolders(p.accountId);
    });
    const un3 = api.on('sync:state', (p: any) => {
      if (p.accountId === activeAccountId) {
        setSyncing(p.syncing);
        if (p.error) toast(`Synchronizace selhala: ${p.error}`, 'error');
      }
    });
    return () => { un1(); un2(); un3(); };
  }, [activeAccountId, loadMessages, loadStats, loadFolders, toast]);

  const openMessage = useCallback(async (id: number) => {
    setSelectedId(id);
    setDetail(null);
    try {
      const full = await api.messages.get(id);
      setDetail(full);
      if (!full.seen) api.messages.setFlag(id, 'seen', true).catch(() => {});
    } catch (e: any) {
      toast(`Zprávu se nepodařilo načíst: ${e.message}`, 'error');
    }
  }, [toast]);

  const refresh = useCallback(async () => {
    if (!activeAccountId) return;
    const folder = view.type === 'folder' ? view.folder : 'INBOX';
    try {
      await api.sync.folder(activeAccountId, folder);
      await loadFolders(activeAccountId);
    } catch (e: any) {
      toast(`Synchronizace selhala: ${e.message}`, 'error');
    }
  }, [activeAccountId, view, loadFolders, toast]);

  const startCompose = useCallback((init: ComposerInit) => setComposer(init), []);

  const currentCategory: Category | null = view.type === 'category' ? view.category : null;

  return (
    <div className="app" style={{ gridTemplateColumns: `${paneW.side}px ${paneW.list}px 1fr` }}>
      <div className="pane-resizer" style={{ left: paneW.side - 3 }} onMouseDown={startDrag('side')} />
      <div className="pane-resizer" style={{ left: paneW.side + paneW.list - 3 }} onMouseDown={startDrag('list')} />
      <Sidebar
        accounts={accounts}
        activeAccountId={activeAccountId}
        onSelectAccount={id => { setActiveAccountId(id); setSelectedId(null); setDetail(null); }}
        folders={folders}
        view={view}
        onSelectView={v => { setView(v); setSelectedId(null); setDetail(null); }}
        catStats={catStats}
        onCompose={() => activeAccount && startCompose({ mode: 'new', accountId: activeAccount.id })}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenOutbox={() => setOutboxOpen(true)}
        onSyncAll={refresh}
        syncing={syncing}
        quota={quota}
        onOpenDigest={() => setDigestOpen(true)}
        onOpenPacking={() => setPackingOpen(true)}
        orderPending={orderPending}
      />
      <MessageList
        messages={messages}
        selectedId={selectedId}
        onSelect={openMessage}
        search={search}
        onSearch={setSearch}
        sort={sort}
        onSort={setSort}
        filters={filters}
        onFilters={setFilters}
        syncing={syncing}
        onRefresh={refresh}
        view={view}
        category={currentCategory}
        hasAccount={!!activeAccount}
        accountId={activeAccountId}
        isTrash={view.type === 'folder' && folders.some(f => f.path === (view as any).folder && f.specialUse === '\\Trash')}
        productFeedUrl={settings?.productFeedUrl ?? null}
        onChanged={() => { loadMessages(); loadStats(); }}
        onCloseDetail={() => { setSelectedId(null); setDetail(null); }}
      />
      <MessageView
        detail={detail}
        selectedId={selectedId}
        account={activeAccount}
        settings={settings}
        onCompose={startCompose}
        onChanged={() => { loadMessages(); loadStats(); }}
        onClose={() => { setSelectedId(null); setDetail(null); }}
        onOpenMessage={openMessage}
      />
      {composer && activeAccount && (
        <Composer
          init={composer}
          accounts={accounts}
          onClose={() => setComposer(null)}
          onSent={(undo) => {
            setComposer(null);
            if (undo) { setUndoSend({ ...undo, until: Date.now() + 10_000 }); setUndoLeft(10); }
            loadMessages();
          }}
        />
      )}
      {undoSend && (
        <div className="undo-bar">
          <span className="spinner-inline" style={{ borderTopColor: '#fff', borderColor: 'rgba(255,255,255,0.3)' }} />
          Zpráva se odešle za {undoLeft} s
          <button onClick={async () => {
            try {
              await api.outbox.cancel(undoSend.outboxId);
              setComposer(undoSend.reopen);
              toast('Odeslání zrušeno — zprávu můžeš upravit.');
            } catch (e: any) {
              toast(e.message, 'error');
            }
            setUndoSend(null);
          }}>Zpět</button>
        </div>
      )}
      {digestOpen && <DigestModal onClose={() => setDigestOpen(false)} />}
      {packingOpen && (
        <PackingModal
          onClose={() => setPackingOpen(false)}
          onOpenMessage={id => { setPackingOpen(false); openMessage(id); }}
        />
      )}
      {settingsOpen && (
        <SettingsModal
          accounts={accounts}
          onClose={() => setSettingsOpen(false)}
          onAccountsChanged={loadAccounts}
          onSettingsChanged={() => api.settings.get().then(setSettings).catch(() => {})}
        />
      )}
      {outboxOpen && <OutboxModal onClose={() => setOutboxOpen(false)} />}
      <TooltipLayer />
    </div>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <AppInner />
    </ToastProvider>
  );
}
