import { useCallback, useEffect, useState } from 'react';
import type { IgOverview } from '@shared/types';
import { api } from '../../api';
import { useToast } from '../../toast';
import Icon from '../Icon';
import WorkspaceSwitch, { Workspace } from '../WorkspaceSwitch';
import IgFeed from './IgFeed';
import IgCompose from './IgCompose';
import IgQueue from './IgQueue';
import IgAccounts from './IgAccounts';
import IgBrand from './IgBrand';

export type IgView = 'feed' | 'compose' | 'queue' | 'accounts' | 'brand';

interface Props {
  onOpenSettings: () => void;
  onWorkspace: (w: Workspace) => void;
  chatUnread: number;
}

/**
 * Instagramový pracovní prostor. Sdílí s poštou vzhled i postranní panel,
 * ale obsah okna je jiný — pošta a sociální sítě spolu nesoupeří o místo.
 */
export default function InstagramWorkspace({ onOpenSettings, onWorkspace, chatUnread }: Props) {
  const toast = useToast();
  const [view, setView] = useState<IgView>('feed');
  const [overview, setOverview] = useState<IgOverview | null>(null);
  const [postId, setPostId] = useState<number | null>(null);
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(async () => {
    try {
      setOverview(await api.ig.overview());
    } catch (e: any) {
      toast(e.message, 'error');
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => api.on('ig:changed', () => { load(); }), [load]);

  // Návrat z přihlášení v prohlížeči
  useEffect(() => api.on('ig:connected', (p: any) => {
    if (p?.error) { toast(p.error, 'error'); return; }
    if (p?.saved) {
      toast(`Účet @${p.saved.username} je připojený jako ${p.saved.lang}.`);
      load();
    }
    if (p?.pick) {
      setView('accounts');
      toast('Vyber, který účet se má připojit.');
    }
  }), [toast, load]);

  const openPost = useCallback((id: number) => { setPostId(id); setView('compose'); }, []);

  const newPost = useCallback(() => { setPostId(null); setView('compose'); }, []);

  const sync = useCallback(async (full = false) => {
    if (!overview?.hasSource) { toast('Nejdřív připoj zdrojový účet.', 'error'); setView('accounts'); return; }
    setSyncing(true);
    try {
      const n = await api.ig.sync(full);
      toast(n > 0 ? `Načteno ${n} příspěvků.` : 'Žádné nové příspěvky.');
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setSyncing(false);
    }
  }, [overview, toast]);

  const item = (v: IgView, icon: string, label: string, count?: number, tip?: string) => (
    <button className={`side-item ${view === v ? 'active' : ''}`} onClick={() => setView(v)} data-tip={tip}>
      <span className="icon"><Icon name={icon} /></span>
      <span className="label">{label}</span>
      {count ? <span className="count">{count}</span> : null}
    </button>
  );

  const needsSetup = overview && (!overview.connection.hasAppId || !overview.storageReady || !overview.hasSource);

  return (
    <div className="app ig-app">
      <div className="sidebar">
        <div className="brand">quentino<span> social</span></div>

        <WorkspaceSwitch current="instagram" onChange={onWorkspace} chatUnread={chatUnread} />

        <button className="btn-compose" onClick={newPost}>
          <Icon name="plus" size={15} /> Nový příspěvek
        </button>

        <div className="side-scroll">
          <div className="side-section">Obsah</div>
          {item('feed', 'layers', 'Feed', undefined, 'Příspěvky ze zdrojového účtu — odsud se přepisují pro další trhy')}
          {item('compose', 'pen', 'Rozpracované')}
          {item('queue', 'clock', 'Fronta a plán', (overview?.queued ?? 0) + (overview?.failed ?? 0))}

          <div className="side-section">Nastavení</div>
          {item('accounts', 'users', 'Účty a připojení')}
          {item('brand', 'sparkles', 'Značka a trhy')}

          {needsSetup && (
            <button className="ig-setup-hint" onClick={() => setView('accounts')}>
              <Icon name="zap" size={13} />
              {!overview?.connection.hasAppId
                ? 'Chybí Meta aplikace'
                : !overview?.storageReady
                  ? 'Chybí úložiště médií'
                  : 'Není připojený zdrojový účet'}
            </button>
          )}
        </div>

        <div className="sidebar-footer">
          <button className="side-item" onClick={() => sync(false)} disabled={syncing}>
            <span className={`icon ${syncing ? 'spinning' : ''}`}><Icon name="refresh" /></span>
            <span className="label">{syncing ? 'Načítám…' : 'Načíst nové'}</span>
          </button>
          <button className="side-item" onClick={onOpenSettings}>
            <span className="icon"><Icon name="settings" /></span>
            <span className="label">Nastavení</span>
          </button>
        </div>
      </div>

      <div className="ig-main">
        {view === 'feed' && overview && (
          <IgFeed overview={overview} onOpenPost={openPost} onSyncAll={() => sync(true)} />
        )}
        {view === 'compose' && overview && (
          <IgCompose
            overview={overview}
            postId={postId}
            onPostId={setPostId}
            onGoQueue={() => setView('queue')}
          />
        )}
        {view === 'queue' && overview && <IgQueue overview={overview} onOpenPost={openPost} />}
        {view === 'accounts' && overview && <IgAccounts overview={overview} onChanged={load} />}
        {view === 'brand' && overview && <IgBrand overview={overview} onChanged={load} />}
      </div>
    </div>
  );
}
