import { useCallback, useEffect, useState } from 'react';
import type { IgOverview, IgSourcePost } from '@shared/types';
import { api } from '../../api';
import { useToast } from '../../toast';
import Icon from '../Icon';
import { LangDot, fmtDate, marketColor, useThumb } from './IgShared';

interface Props {
  overview: IgOverview;
  onOpenPost: (postId: number) => void;
  onSyncAll: () => void;
}

/**
 * Feed zdrojového účtu. U každého příspěvku je hned vidět, které trhy už ho
 * dostaly a které ne — proto ty barevné zkratky pod dlaždicí. Nemusíš nic
 * proklikávat, abys poznal, že španělský účet zaostává.
 */
export default function IgFeed({ overview, onOpenPost, onSyncAll }: Props) {
  const toast = useToast();
  const [posts, setPosts] = useState<IgSourcePost[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'todo' | 'done'>('all');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setPosts(await api.ig.feed(120, 0));
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => api.on('ig:changed', () => load()), [load]);

  const targets = overview.markets.filter(m => m.enabled && !overview.accounts.some(a => a.isSource && a.lang === m.lang));

  const visible = posts.filter(p => {
    if (search && !p.caption.toLowerCase().includes(search.toLowerCase())) return false;
    if (filter === 'todo') return p.done.length < targets.length;
    if (filter === 'done') return targets.length > 0 && p.done.length >= targets.length;
    return true;
  });

  const open = async (p: IgSourcePost) => {
    setBusy(true);
    try {
      const post = await api.ig.createFromSource(p.id);
      onOpenPost(post.id);
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  if (!overview.hasSource) {
    return (
      <div className="empty-state">
        <div className="big">📷</div>
        <p>Není připojený zdrojový účet.</p>
        <p className="ig-muted">V Účtech připoj český Instagram — z něj se budou brát příspěvky.</p>
      </div>
    );
  }

  return (
    <div className="ig-page">
      <div className="ig-head">
        <h2>Feed</h2>
        <div className="ig-head-tools">
          <div className="ig-search">
            <Icon name="search" size={14} />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Hledat v popiscích" />
          </div>
          <div className="ig-seg">
            <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>Vše</button>
            <button className={filter === 'todo' ? 'active' : ''} onClick={() => setFilter('todo')}>Chybí trhy</button>
            <button className={filter === 'done' ? 'active' : ''} onClick={() => setFilter('done')}>Hotové</button>
          </div>
          {/* Na telefonu zůstane jen ikona — podtržený odkaz mezi tlačítky
              vypadal jako cizí prvek z webu a bral celý řádek */}
          <button className="btn ghost ig-archive" onClick={onSyncAll}
            data-tip="Stáhne historii účtu, ne jen nové příspěvky" aria-label="Načíst celý archiv">
            <Icon name="download" size={14} /><span>Načíst celý archiv</span>
          </button>
        </div>
      </div>

      {loading ? (
        <div className="ig-muted ig-pad">Načítám příspěvky…</div>
      ) : visible.length === 0 ? (
        <div className="empty-state">
          <div className="big">🗂️</div>
          <p>{posts.length === 0 ? 'Zatím tu nic není.' : 'Nic neodpovídá filtru.'}</p>
          {posts.length === 0 && <p className="ig-muted">Klikni na „Načíst celý archiv" a stáhne se historie účtu.</p>}
        </div>
      ) : (
        <div className="ig-grid">
          {visible.map(p => (
            <Tile key={p.id} post={p} overview={overview} busy={busy} onOpen={() => open(p)} />
          ))}
        </div>
      )}
    </div>
  );
}

function Tile({ post, overview, busy, onOpen }: {
  post: IgSourcePost; overview: IgOverview; busy: boolean; onOpen: () => void;
}) {
  const thumb = useThumb(post.id);
  const targets = overview.markets.filter(m => m.enabled && m.lang !== 'CS');

  return (
    <button className="ig-tile" onClick={onOpen} disabled={busy}>
      <div className="ig-tile-img">
        {thumb
          ? <img src={thumb} alt="" />
          : <span className="ig-tile-ph"><Icon name="image" size={22} /></span>}
        {post.mediaType === 'VIDEO' && <span className="ig-badge">Reels</span>}
        {post.childCount > 1 && <span className="ig-badge">{post.childCount}×</span>}
      </div>
      <div className="ig-tile-body">
        <div className="ig-tile-caption">{post.caption || <span className="ig-muted">Bez popisku</span>}</div>
        <div className="ig-tile-foot">
          <span className="ig-muted">{fmtDate(post.postedAt)}</span>
          <span className="ig-langs">
            {targets.map(m => (
              <LangDot
                key={m.lang}
                lang={m.lang}
                color={marketColor(overview.markets, m.lang)}
                state={post.done.includes(m.lang) ? 'done' : post.pending.includes(m.lang) ? 'pending' : 'none'}
                title={post.done.includes(m.lang)
                  ? `${m.label}: publikováno`
                  : post.pending.includes(m.lang) ? `${m.label}: rozepsáno` : `${m.label}: zatím nic`}
              />
            ))}
          </span>
        </div>
      </div>
    </button>
  );
}
