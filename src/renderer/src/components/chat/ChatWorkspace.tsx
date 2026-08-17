import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatConversation, ChatMessage as Msg, ChatOverview } from '@shared/types';
import { api } from '../../api';
import { useToast } from '../../toast';
import Icon from '../Icon';
import WorkspaceSwitch, { Workspace } from '../WorkspaceSwitch';
import ChatMessageView from './ChatMessage';
import ChatProductPicker from './ChatProductPicker';
import ChatSettings from './ChatSettings';

const FLAG: Record<string, string> = { cs: '🇨🇿', sk: '🇸🇰', en: '🇬🇧' };

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'teď';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h`;
  return new Date(iso).toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric' });
}

interface Props {
  onOpenSettings: () => void;
  onWorkspace: (w: Workspace) => void;
  chatUnread: number;
}

/**
 * Chat ze zákaznického widgetu. Data jsou tatáž, se kterou pracuje webový
 * admin — aplikace do nich jen píše, takže widget ani nasazený chat se nemění.
 */
export default function ChatWorkspace({ onOpenSettings, onWorkspace, chatUnread }: Props) {
  const toast = useToast();
  const [overview, setOverview] = useState<ChatOverview | null>(null);
  const [convs, setConvs] = useState<ChatConversation[]>([]);
  const [onlyOpen, setOnlyOpen] = useState(true);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState('');
  const [picker, setPicker] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const active = useMemo(() => convs.find(c => c.id === activeId) ?? null, [convs, activeId]);
  const ready = overview?.config.ready ?? false;

  const loadOverview = useCallback(async () => {
    try {
      setOverview(await api.chat.overview());
    } catch (e: any) {
      toast(e.message, 'error');
    }
  }, [toast]);

  const loadConvs = useCallback(async () => {
    if (!ready) return;
    try {
      setConvs(await api.chat.conversations(onlyOpen));
    } catch (e: any) {
      toast(e.message, 'error');
    }
  }, [ready, onlyOpen, toast]);

  const loadMessages = useCallback(async (id: string) => {
    try {
      setMessages(await api.chat.messages(id));
    } catch (e: any) {
      toast(e.message, 'error');
    }
  }, [toast]);

  useEffect(() => { loadOverview(); }, [loadOverview]);
  useEffect(() => { loadConvs(); }, [loadConvs]);

  // Nové zprávy chodí bez upozornění, proto se seznam i vlákno občas přečtou znovu
  useEffect(() => {
    if (!ready) return;
    const t = setInterval(loadConvs, 8000);
    return () => clearInterval(t);
  }, [ready, loadConvs]);

  useEffect(() => {
    if (!activeId) { setMessages([]); return; }
    loadMessages(activeId);
    api.chat.markRead(activeId).then(loadOverview).catch(() => {});
    const t = setInterval(() => loadMessages(activeId), 4000);
    return () => clearInterval(t);
  }, [activeId, loadMessages, loadOverview]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages.length]);
  useEffect(() => api.on('chat:changed', () => { loadConvs(); loadOverview(); }), [loadConvs, loadOverview]);

  const send = async () => {
    if (!activeId || !reply.trim()) return;
    setBusy('send');
    try {
      setMessages(await api.chat.send(activeId, reply));
      setReply('');
      loadConvs();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const suggest = async () => {
    if (!activeId) return;
    setBusy('ai');
    try {
      // Rozepsaný text se bere jako pokyn, co má odpověď říct
      const text = await api.chat.suggest(activeId, reply);
      if (text) setReply(text);
      else toast('Model nic nevrátil, zkus to znovu.', 'error');
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const improve = async () => {
    if (!reply.trim()) return;
    setBusy('improve');
    try {
      setReply(await api.ai.improve(reply, 'improve'));
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const translate = async () => {
    if (!reply.trim() || !active) return;
    setBusy('translate');
    try {
      setReply(await api.ai.translateText(reply, active.locale || 'cs'));
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const toggleStatus = async () => {
    if (!active) return;
    try {
      await api.chat.setStatus(active.id, active.status === 'closed' ? 'open' : 'closed');
      await loadConvs();
      if (active.status !== 'closed') setActiveId(null);
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const label = (c: ChatConversation) =>
    c.name || c.email || c.phone || `Anonymní #${c.sessionId.slice(0, 6).toUpperCase()}`;

  return (
    <div className="app ch-app">
      <div className="sidebar">
        <div className="brand">quentino<span> chat</span></div>
        <WorkspaceSwitch current="chat" onChange={onWorkspace} chatUnread={chatUnread} />

        <div className="ig-seg" style={{ margin: '0 10px 8px' }}>
          <button className={onlyOpen ? 'active' : ''} onClick={() => setOnlyOpen(true)}>Otevřené</button>
          <button className={!onlyOpen ? 'active' : ''} onClick={() => setOnlyOpen(false)}>Vše</button>
        </div>

        <div className="side-scroll">
          {!ready && (
            <button className="ig-setup-hint" onClick={() => setSettingsOpen(true)}>
              <Icon name="zap" size={13} /> Chat není nastavený
            </button>
          )}
          {ready && convs.length === 0 && <div className="ig-muted" style={{ padding: '10px 12px' }}>Žádné konverzace.</div>}
          {convs.map(c => (
            <button
              key={c.id}
              className={`ch-conv ${c.id === activeId ? 'active' : ''}`}
              onClick={() => setActiveId(c.id)}
            >
              <span className="ch-conv-flag">{FLAG[c.locale] ?? '🌍'}</span>
              <span className="ch-conv-body">
                <span className="ch-conv-name">{label(c)}</span>
                <span className="ch-conv-meta">
                  {timeAgo(c.lastMessageAt)}
                  {c.status === 'closed' ? ' · uzavřeno' : ''}
                  {c.channel !== 'widget' ? ` · ${c.channel}` : ''}
                </span>
              </span>
              {c.unread > 0 && <span className="count">{c.unread}</span>}
            </button>
          ))}
        </div>

        <div className="sidebar-footer">
          <button className="side-item" onClick={() => setSettingsOpen(true)}>
            <span className="icon"><Icon name="settings" /></span>
            <span className="label">Nastavení chatu</span>
          </button>
          <button className="side-item" onClick={onOpenSettings}>
            <span className="icon"><Icon name="user" /></span>
            <span className="label">Nastavení aplikace</span>
          </button>
        </div>
      </div>

      <div className="ch-main">
        {!active ? (
          <div className="empty-state">
            <div className="big">💬</div>
            <p>{ready ? 'Vyber konverzaci vlevo.' : 'Nejdřív nastav napojení na chat.'}</p>
          </div>
        ) : (
          <>
            <div className="ch-head">
              <div>
                <div className="ch-head-name">
                  {FLAG[active.locale] ?? '🌍'} {label(active)}
                </div>
                <div className="ig-muted">
                  {[active.email, active.phone].filter(Boolean).join(' · ') || 'bez kontaktu'}
                  {active.leftAt ? ' · zákazník odešel ze stránky' : ''}
                </div>
              </div>
              <div className="ig-head-tools">
                {active.email && (
                  <button className="btn ghost" data-tip="Přepne do pošty a najde e-maily tohoto zákazníka"
                    onClick={() => { onWorkspace('mail'); }}>
                    <Icon name="mail" size={13} /> Do pošty
                  </button>
                )}
                <button className="btn ghost" onClick={toggleStatus}>
                  {active.status === 'closed' ? 'Otevřít znovu' : 'Uzavřít'}
                </button>
              </div>
            </div>

            <div className="ch-thread">
              {messages.map(m => (
                <ChatMessageView key={m.id} m={m} onOpenImage={setLightbox} />
              ))}
              <div ref={endRef} />
            </div>

            <div className="ch-composer">
              <textarea
                rows={3}
                value={reply}
                onChange={e => setReply(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
                }}
                placeholder="Odpověď… (⌘+Enter odešle)"
              />
              <div className="ch-tools">
                <button className="btn ghost" onClick={() => setPicker(true)}
                  data-tip="Vloží odkaz na produkt — zákazníkovi se ve widgetu zobrazí jako karta">
                  <Icon name="bag" size={13} /> Produkt
                </button>
                <button className="btn ghost" onClick={suggest} disabled={!!busy}
                  data-tip="Napíše návrh podle průběhu konverzace; rozepsaný text použije jako zadání">
                  {busy === 'ai' ? <span className="spinner-inline" /> : <Icon name="sparkles" size={13} />} Návrh
                </button>
                <button className="btn ghost" onClick={improve} disabled={!reply.trim() || !!busy}>
                  {busy === 'improve' ? <span className="spinner-inline" /> : <Icon name="zap" size={13} />} Vylepšit
                </button>
                <button className="btn ghost" onClick={translate} disabled={!reply.trim() || !!busy}
                  data-tip={`Přeloží do jazyka zákazníka (${active.locale})`}>
                  {busy === 'translate' ? <span className="spinner-inline" /> : <Icon name="globe" size={13} />} Přeložit
                </button>

                <span className="ch-sign">
                  {overview?.config.operatorPersonId
                    ? `podepisuje ${overview.persons.find(p => p.id === overview.config.operatorPersonId)?.short ?? ''}`
                    : 'bez podpisu'}
                </span>

                <button className="btn primary" onClick={send} disabled={!reply.trim() || busy === 'send'}>
                  {busy === 'send' ? <span className="spinner-inline" /> : <Icon name="send" size={13} />} Odeslat
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {picker && active && (
        <ChatProductPicker
          locale={active.locale === 'sk' ? 'sk' : active.locale === 'en' ? 'en' : 'cz'}
          onInsert={url => setReply(prev => (prev ? `${prev.trimEnd()}\n${url}` : url))}
          onClose={() => setPicker(false)}
        />
      )}

      {settingsOpen && (
        <ChatSettings
          overview={overview}
          onClose={() => setSettingsOpen(false)}
          onSaved={() => { loadOverview(); loadConvs(); }}
        />
      )}

      {lightbox && (
        <div className="overlay" onMouseDown={() => setLightbox(null)}>
          <img className="ch-lightbox" src={lightbox} alt="" />
        </div>
      )}
    </div>
  );
}
