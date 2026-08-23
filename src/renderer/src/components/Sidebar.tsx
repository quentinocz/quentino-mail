import type { AccountPublic, FolderInfo, Category } from '@shared/types';
import { CATEGORY_LABELS } from '@shared/types';
import Icon from './Icon';
import WorkspaceSwitch, { Workspace, AiTool } from './WorkspaceSwitch';

export type View =
  | { type: 'folder'; folder: string }
  | { type: 'category'; category: Category }
  | { type: 'orderInbox' }
  | { type: 'archive' };

const CATEGORY_ICONS: Record<Category, string> = {
  orders: 'bag',
  people: 'chat',
  companies: 'building',
  other: 'layers'
};

function folderIcon(f: FolderInfo): string {
  if (f.path.toUpperCase() === 'INBOX') return 'inbox';
  switch (f.specialUse) {
    case '\\Sent': return 'send';
    case '\\Drafts': return 'pen';
    case '\\Trash': return 'trash';
    case '\\Junk': return 'ban';
    case '\\Archive': return 'archive';
    default: return 'folder';
  }
}

interface Props {
  accounts: AccountPublic[];
  activeAccountId: number | null;
  onSelectAccount: (id: number) => void;
  folders: FolderInfo[];
  view: View;
  onSelectView: (v: View) => void;
  catStats: Record<string, { cnt: number; unseen: number }>;
  onCompose: () => void;
  onOpenSettings: () => void;
  onOpenOutbox: () => void;
  onSyncAll: () => void;
  syncing: boolean;
  quota: { used: number; limit: number } | null;
  onOpenDigest: () => void;
  onOpenPacking: () => void;
  /** Kolik zpráv k objednávkám čeká na odpověď */
  orderPending: number;
  /** Přepnutí pracovního prostoru */
  onWorkspace: (w: Workspace) => void;
  /** Nepřečtené zprávy v chatu */
  chatUnread: number;
  /** Otevření nástroje z nabídky AI */
  onAiTool: (tool: AiTool) => void;
  /** Který nástroj AI je zrovna otevřený */
  activeTool?: AiTool;
}

function fmtGB(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

export default function Sidebar(p: Props) {
  const isFolder = (path: string) => p.view.type === 'folder' && p.view.folder === path;
  const isCat = (c: Category) => p.view.type === 'category' && p.view.category === c;

  return (
    <div className="sidebar">
      <div className="brand">quentino<span> mail</span></div>

      <WorkspaceSwitch current="mail" onChange={p.onWorkspace} chatUnread={p.chatUnread}
        onAiTool={p.onAiTool} activeTool={p.activeTool} />

      <button className="btn-compose" onClick={p.onCompose}><Icon name="pen" size={15} /> Nová zpráva</button>

      <div className="side-scroll">
      <button className="side-item" onClick={p.onOpenDigest}
        data-tip="AI shrne poštu za posledních 24 hodin — co je urgentní a co čeká na odpověď">
        <span className="icon"><Icon name="sunrise" /></span>
        <span className="label">Přehled dne</span>
      </button>

      <button className={`side-item ${p.view.type === 'orderInbox' ? 'active' : ''}`}
        onClick={() => p.onSelectView({ type: 'orderInbox' })}
        data-tip="Zprávy zákazníků k jejich objednávkám, na které se ještě neodpovědělo">
        <span className="icon"><Icon name="reply" /></span>
        <span className="label">K objednávkám</span>
        {p.orderPending > 0 && <span className="count">{p.orderPending}</span>}
      </button>

      <button className="side-item" onClick={p.onOpenPacking}
        data-tip="Odškrtávací seznam objednávek k zabalení — kusy, varianty, adresy">
        <span className="icon"><Icon name="bag" /></span>
        <span className="label">Balení objednávek</span>
      </button>

      {p.accounts.length > 1 && (
        <div className="account-switcher">
          <div className="side-section">Účty</div>
          {p.accounts.map(a => (
            <button
              key={a.id}
              className={`account-chip ${a.id === p.activeAccountId ? 'active' : ''}`}
              onClick={() => p.onSelectAccount(a.id)}
            >
              <span className="account-dot" style={{ background: a.color }} />
              <span className="label">{a.name}</span>
            </button>
          ))}
        </div>
      )}

      <div className="side-section">Doručená pošta</div>
      <button className={`side-item ${isFolder('INBOX') ? 'active' : ''}`} onClick={() => p.onSelectView({ type: 'folder', folder: 'INBOX' })}>
        <span className="icon"><Icon name="inbox" /></span>
        <span className="label">Vše</span>
        {(() => {
          const unseen = p.folders.find(f => f.path.toUpperCase() === 'INBOX')?.unseen ?? 0;
          return unseen > 0 ? <span className="count">{unseen}</span> : null;
        })()}
      </button>
      {(Object.keys(CATEGORY_LABELS) as Category[]).map(c => {
        const st = p.catStats[c];
        return (
          <button key={c} className={`side-item ${isCat(c) ? 'active' : ''}`} onClick={() => p.onSelectView({ type: 'category', category: c })}>
            <span className="icon"><Icon name={CATEGORY_ICONS[c]} /></span>
            <span className="label">{CATEGORY_LABELS[c]}</span>
            {st && st.unseen > 0 && <span className="count">{st.unseen}</span>}
          </button>
        );
      })}

      <div className="side-section">Složky</div>
      {p.folders.filter(f => f.path.toUpperCase() !== 'INBOX').map(f => (
        <button key={f.path} className={`side-item ${isFolder(f.path) ? 'active' : ''}`} onClick={() => p.onSelectView({ type: 'folder', folder: f.path })}>
          <span className="icon"><Icon name={folderIcon(f)} /></span>
          <span className="label">{f.name}</span>
          {f.unseen > 0 && <span className="count">{f.unseen}</span>}
        </button>
      ))}

      <div className="side-section">Lokální</div>
      <button className={`side-item ${p.view.type === 'archive' ? 'active' : ''}`} onClick={() => p.onSelectView({ type: 'archive' })}>
        <span className="icon"><Icon name="save" /></span>
        <span className="label">Archiv</span>
      </button>
      <button className="side-item" onClick={p.onOpenOutbox}>
        <span className="icon"><Icon name="clock" /></span>
        <span className="label">K odeslání</span>
      </button>
      </div>

      <div className="sidebar-footer">
        {p.quota && (() => {
          const pct = Math.min(100, Math.round((p.quota.used / p.quota.limit) * 100));
          return (
            <div className="quota-box" data-tip={`Obsazení schránky na serveru: ${fmtGB(p.quota.used)} z ${fmtGB(p.quota.limit)}`}>
              <div className="quota-bar">
                <div className={pct > 90 ? 'crit' : pct > 70 ? 'warn' : ''} style={{ width: `${pct}%` }} />
              </div>
              Server: {pct} % ({fmtGB(p.quota.used)} / {fmtGB(p.quota.limit)})
            </div>
          );
        })()}
        <button className="side-item" onClick={p.onSyncAll} disabled={p.syncing}>
          <span className={`icon ${p.syncing ? 'spinning' : ''}`}><Icon name="refresh" /></span>
          <span className="label">{p.syncing ? 'Synchronizuji…' : 'Synchronizovat'}</span>
        </button>
        <button className="side-item" onClick={p.onOpenSettings}>
          <span className="icon"><Icon name="settings" /></span>
          <span className="label">Nastavení</span>
        </button>
      </div>
    </div>
  );
}
