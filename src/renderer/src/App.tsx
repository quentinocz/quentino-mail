import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AccountPublic, FolderInfo, MessageHeader, MessageFull, Settings, Category, MessageSort, ListFilters } from '@shared/types';
import { isOutgoingFolder } from '@shared/folders';
import { api } from './api';
import { ToastProvider, useToast } from './toast';
import Sidebar, { View } from './components/Sidebar';
import Icon from './components/Icon';
import MessageList from './components/MessageList';
import MessageView, { replyInitFor } from './components/MessageView';
import Composer, { ComposerInit, UndoInfo } from './components/Composer';
import SettingsModal from './components/SettingsModal';
import MailboxCleanup from './components/MailboxCleanup';
import OutboxModal from './components/OutboxModal';
import TooltipLayer from './components/TooltipLayer';
import DigestModal from './components/DigestModal';
import PackingModal from './components/PackingModal';
import ProductsModal from './components/ProductsModal';
import ArticlesModal from './components/ArticlesModal';
import CatalogModal from './components/CatalogModal';
import PtransStatusBar from './components/PtransStatusBar';
import InstagramWorkspace from './components/instagram/InstagramWorkspace';
import ChatWorkspace from './components/chat/ChatWorkspace';
import type { Workspace, AiTool } from './components/WorkspaceSwitch';
import { SidebarResizer, useSidebarWidth } from './sidebar';
import { useIsPhone } from './mobile';
import { useEdgeBack } from './gestures';
import MobileTabs from './components/MobileTabs';
import { viewTitle, viewUnread } from './viewtitle';

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
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [digestOpen, setDigestOpen] = useState(false);
  const [packingOpen, setPackingOpen] = useState(false);
  // Nástroje pod záložkou AI: překlady a články. Otevírají se přes celé okno,
  // ale běh (překlad) pokračuje i po zavření — proto je stav tady, ne v panelu.
  const [aiTool, setAiTool] = useState<AiTool | null>(null);
  const [orderPending, setOrderPending] = useState(0);
  // Pracovní prostor: pošta nebo Instagram. Pamatuje se mezi spuštěními.
  const [workspace, setWorkspace] = useState<Workspace>(() => {
    const saved = localStorage.getItem('workspace');
    return saved === 'instagram' || saved === 'chat' ? saved : 'mail';
  });
  useEffect(() => { localStorage.setItem('workspace', workspace); }, [workspace]);

  // Telefon: sloupce se nevejdou vedle sebe, prochází se jeden po druhém
  const phone = useIsPhone();
  const [drawer, setDrawer] = useState(false);
  // Zásuvku i otevřenou zprávu zavře přepnutí prostoru — jinak by se otevřel
  // Chat a pod ním zůstal viset panel složek
  useEffect(() => { setDrawer(false); }, [workspace]);

  // Nabídka AI je ve všech prostorech; Instagram je vlastní prostor, zbytek
  // jsou okna nad tím, ve kterém zrovna jsi
  const openAiTool = useCallback((tool: AiTool) => {
    setDrawer(false);
    // Sociální sítě jsou vlastní prostor, přehled dne a balení mají vlastní
    // okna; zbytek se otevírá přes `aiTool`
    if (tool === 'instagram') { setWorkspace('instagram'); return; }
    if (tool === 'digest') { setDigestOpen(true); return; }
    if (tool === 'packing') { setPackingOpen(true); return; }
    setAiTool(tool);
  }, []);

  /*
   * Tah od levého okraje = zpět.
   *
   * Na telefonu se prochází jeden sloupec za druhým a tlačítko „Zpět" je
   * v horním rohu, kam palec nedosáhne. Systémové aplikace to řeší tahem
   * od kraje, tak ať se to tady nemusí učit jinak.
   */
  const readPane = useRef<HTMLDivElement>(null);
  useEdgeBack(() => {
    if (drawer) { setDrawer(false); return; }
    setSelectedId(null);
    setDetail(null);
  }, phone && (drawer || selectedId !== null), drawer ? undefined : readPane);

  // E-mail, který se má otevřít po přepnutí z chatu do pošty
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);

  // Nepřečtené zprávy z chatu — číslo u záložky Chat, i když jsi v poště
  const [chatUnread, setChatUnread] = useState(0);
  useEffect(() => {
    api.chat.overview().then(o => setChatUnread(o.unread)).catch(() => {});
    return api.on('chat:unread', (p: any) => setChatUnread(p?.unread ?? 0));
  }, []);

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
  // Šířka panelu je společná pro všechny prostory (viz `sidebar.tsx`);
  // tady se drží jen šířka seznamu zpráv, ta je vlastní poště.
  const sideW = useSidebarWidth();
  const [listW, setListW] = useState<number>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('paneWidths') || 'null');
      if (saved && typeof saved.list === 'number') return saved.list;
    } catch { /* */ }
    return 360;
  });
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);
  useEffect(() => {
    const move = (e: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      setListW(Math.min(620, Math.max(290, drag.startW + (e.clientX - drag.startX))));
    };
    const up = () => {
      if (dragRef.current) { dragRef.current = null; document.body.style.cursor = ''; }
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
  }, []);
  useEffect(() => { localStorage.setItem('paneWidths', JSON.stringify({ list: listW })); }, [listW]);
  const startListDrag = (e: React.MouseEvent) => {
    dragRef.current = { startX: e.clientX, startW: listW };
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

  /*
   * Kliknutí na upozornění otevře přímo tu zprávu — na počítači ze systémové
   * notifikace, na telefonu z ntfy přes odkaz `quentino-mail://mail?mid=…`.
   *
   * Zpráva v telefonu být nemusí: upozornění posílá počítač ve chvíli, kdy ji
   * stáhl on. Pak se aspoň otevře pošta a řekne se proč, ať klepnutí nevypadá
   * jako by nic neudělalo.
   */
  useEffect(() => api.on('mail:open', (p: any) => {
    setWorkspace('mail');
    if (p?.accountId) setActiveAccountId(p.accountId);
    setView({ type: 'folder', folder: 'INBOX' });
    if (p?.id) { openMessage(p.id); return; }
    // Upozornění chodí z počítače ve chvíli, kdy zprávu stáhl on — telefon ji
    // tedy teprve stahuje a druhá zpráva na stejném kanálu ji pak otevře
    if (p?.pending) toast('Stahuji zprávu…');
    else if (p?.notFound) toast('Zprávu se nepodařilo najít — zkus synchronizaci.', 'error');
  }), [openMessage, toast]);

  // Totéž pro chat: odkaz z notifikace otevře konkrétní konverzaci
  useEffect(() => api.on('chat:open', () => setWorkspace('chat')), []);

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

  /*
   * Odpověď rovnou ze seznamu (tah přes řádek na telefonu). Zpráva se musí
   * dotáhnout celá — bez těla by odpověď přišla o citaci a bez `messageId`
   * by vypadla z vlákna.
   */
  const replyToMessage = useCallback(async (dbId: number) => {
    try {
      const full = await api.messages.get(dbId);
      setComposer(replyInitFor(full));
    } catch (e: any) {
      toast(e.message, 'error');
    }
  }, [toast]);

  // Přišlo z chatu: jakmile je pošta připravená, otevře se nová zpráva na zákazníka
  useEffect(() => {
    if (workspace !== 'mail' || !pendingEmail || !activeAccountId) return;
    setComposer({ mode: 'new', accountId: activeAccountId, to: pendingEmail });
    setPendingEmail(null);
  }, [workspace, pendingEmail, activeAccountId]);

  /**
   * Okna nástrojů AI a pruh s průběhem překladu. Jsou stejná ve všech
   * prostorech — proto se vykreslují z jednoho místa a ne v každé větvi zvlášť.
   *
   * Překlady a články jsou jen na počítači: na malé obrazovce se dělat nedají
   * a nativní obal pro ně nemá kanály. Bez téhle pojistky by se hned po
   * spuštění zeptal na průběh překladu a dostal chybu.
   *
   * Katalog je naopak i na telefonu — naskladnění se dělá u regálu, ne u stolu.
   */
  const aiLayer = (
    <>
      {aiTool === 'catalog' && <CatalogModal onClose={() => setAiTool(null)} />}
      {/* Přehled dne a balení se otevírají z nabídky Funkce, která je ve všech
          prostorech — proto se kreslí tady, ne jen v poště */}
      {digestOpen && <DigestModal onClose={() => setDigestOpen(false)} />}
      {packingOpen && (
        <PackingModal
          onClose={() => setPackingOpen(false)}
          onOpenMessage={id => {
            setPackingOpen(false);
            setWorkspace('mail');
            openMessage(id);
          }}
        />
      )}
      {!phone && (
        <>
          {aiTool === 'ptrans' && <ProductsModal onClose={() => setAiTool(null)} />}
          {aiTool === 'articles' && <ArticlesModal onClose={() => setAiTool(null)} />}
          <PtransStatusBar hidden={aiTool ?? undefined} onOpen={tool => setAiTool(tool)} />
        </>
      )}
    </>
  );

  const currentCategory: Category | null = view.type === 'category' ? view.category : null;

  if (workspace === 'chat') {
    return (
      <>
        <ChatWorkspace
          onOpenSettings={() => setSettingsOpen(true)}
          onWorkspace={setWorkspace}
          chatUnread={chatUnread}
          onComposeEmail={email => { setPendingEmail(email); setWorkspace('mail'); }}
          onAiTool={openAiTool}
          activeTool={aiTool ?? undefined}
        />
        {phone && (
          <MobileTabs current="chat" onChange={setWorkspace} chatUnread={chatUnread}
            onAiTool={openAiTool} activeTool={aiTool ?? undefined} />
        )}
        {settingsOpen && (
          <SettingsModal
            accounts={accounts}
            onClose={() => setSettingsOpen(false)}
            onAccountsChanged={loadAccounts}
            onSettingsChanged={() => api.settings.get().then(setSettings).catch(() => {})}
          />
        )}
        {aiLayer}
        <TooltipLayer />
      </>
    );
  }

  if (workspace === 'instagram') {
    return (
      <>
        <InstagramWorkspace
          onOpenSettings={() => setSettingsOpen(true)}
          onWorkspace={setWorkspace}
          chatUnread={chatUnread}
          onAiTool={openAiTool}
          activeTool={aiTool ?? undefined}
        />
        {phone && (
          <MobileTabs current="instagram" onChange={setWorkspace} chatUnread={chatUnread}
            onAiTool={openAiTool} activeTool={aiTool ?? undefined} />
        )}
        {settingsOpen && (
          <SettingsModal
            accounts={accounts}
            onClose={() => setSettingsOpen(false)}
            onAccountsChanged={loadAccounts}
            onSettingsChanged={() => api.settings.get().then(setSettings).catch(() => {})}
          />
        )}
        {aiLayer}
        <TooltipLayer />
      </>
    );
  }

  // Nadpis mobilní hlavičky — stejným pravidlem jako v seznamu zpráv
  const mobileTitle = viewTitle(view, folders);
  const mobileUnread = viewUnread(view, folders, catStats);

  const closeDetail = () => { setSelectedId(null); setDetail(null); };

  return (
    <div
      className="app"
      data-pane={selectedId ? 'detail' : 'list'}
      data-drawer={drawer ? 'open' : 'closed'}
      style={phone ? undefined : { gridTemplateColumns: `var(--side-w) ${listW}px 1fr` }}
    >
      {phone && (
        <div className="m-head">
          {selectedId ? (
            <>
              <button className="m-head-btn" onClick={closeDetail} aria-label="Zpět na seznam">
                <Icon name="chevLeft" size={20} /><span>Zpět</span>
              </button>
              <div className="m-head-title">{detail?.fromName || detail?.fromAddr || 'Zpráva'}</div>
            </>
          ) : (
            <>
              {/* Ikona složek nalevo je to, co člověk hledá jako první —
                  a nadpis vedle ní dělá totéž, protože je to větší cíl
                  a rovnou říká, kde jsem a kolik tu čeká nepřečtených. */}
              <button className="m-head-btn" onClick={() => setDrawer(true)} aria-label="Složky">
                <Icon name="menu" size={20} />
              </button>
              <button className="m-head-picker" onClick={() => setDrawer(true)}
                aria-label={`${mobileTitle} — otevřít složky`}>
                <span className="m-head-title">{mobileTitle}</span>
                {mobileUnread > 0 && <span className="m-head-count">{mobileUnread}</span>}
                <Icon name="chevDown" size={14} />
              </button>
            </>
          )}
          {!selectedId && (
            <button
              className="m-head-btn right"
              onClick={() => activeAccount && startCompose({ mode: 'new', accountId: activeAccount.id })}
              aria-label="Nová zpráva"
            >
              <Icon name="pen" size={19} />
            </button>
          )}
        </div>
      )}
      {phone && drawer && <div className="m-scrim" onClick={() => setDrawer(false)} />}
      {settings?.secretsLocked && (
        <div className="locked-bar">
          <Icon name="zap" size={14} />
          <span>
            Hesla a klíče jsou zamčené klíčenkou pod původním názvem aplikace.
            Obnov je ze zálohy — Nastavení → Obnovit.
          </span>
          <button className="btn ghost" onClick={() => setSettingsOpen(true)}>Otevřít nastavení</button>
        </div>
      )}
      {!phone && <SidebarResizer />}
      {!phone && (
        <div className="pane-resizer" style={{ left: sideW + listW - 3 }} onMouseDown={startListDrag} />
      )}
      <Sidebar
        accounts={accounts}
        activeAccountId={activeAccountId}
        onSelectAccount={id => { setActiveAccountId(id); setSelectedId(null); setDetail(null); setDrawer(false); }}
        folders={folders}
        view={view}
        onSelectView={v => { setView(v); setSelectedId(null); setDetail(null); setDrawer(false); }}
        catStats={catStats}
        onCompose={() => { setDrawer(false); if (activeAccount) startCompose({ mode: 'new', accountId: activeAccount.id }); }}
        onOpenSettings={() => { setDrawer(false); setSettingsOpen(true); }}
        onOpenOutbox={() => { setDrawer(false); setOutboxOpen(true); }}
        onSyncAll={refresh}
        syncing={syncing}
        quota={quota}
        onCleanup={() => setCleanupOpen(true)}
        orderPending={orderPending}
        onWorkspace={setWorkspace}
        chatUnread={chatUnread}
        onAiTool={openAiTool}
        activeTool={aiTool ?? undefined}
      />
      <MessageList
        messages={messages}
        folders={folders}
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
        isOutgoing={view.type === 'folder'
          && isOutgoingFolder(folders.find(f => f.path === (view as any).folder))}
        productFeedUrl={settings?.productFeedUrl ?? null}
        onChanged={() => { loadMessages(); loadStats(); }}
        onCloseDetail={() => { setSelectedId(null); setDetail(null); }}
        onReply={replyToMessage}
      />
      <MessageView
        paneRef={readPane}
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
      {settingsOpen && (
        <SettingsModal
          accounts={accounts}
          onClose={() => setSettingsOpen(false)}
          onAccountsChanged={loadAccounts}
          onSettingsChanged={() => api.settings.get().then(setSettings).catch(() => {})}
        />
      )}
      {outboxOpen && <OutboxModal onClose={() => setOutboxOpen(false)} />}
      {cleanupOpen && activeAccountId !== null && (
        <MailboxCleanup
          accountId={activeAccountId}
          quota={quota}
          onClose={() => {
            setCleanupOpen(false);
            // Po úklidu se obsazení musí přepočítat, jinak ukazuje minulost
            api.quota.get(activeAccountId).then(setQuota).catch(() => {});
          }}
        />
      )}
      {phone && (
          <MobileTabs current="mail" onChange={setWorkspace} chatUnread={chatUnread}
            onAiTool={openAiTool} activeTool={aiTool ?? undefined} />
        )}
      {aiLayer}
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
