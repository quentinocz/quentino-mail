import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatConversation, ChatMessage as Msg, ChatOverview } from '@shared/types';
import { api } from '../../api';
import { useToast } from '../../toast';
import Icon from '../Icon';
import WorkspaceSwitch, { Workspace } from '../WorkspaceSwitch';
import { SidebarResizer } from '../../sidebar';
import ChatMessageView from './ChatMessage';
import ChatProductPicker from './ChatProductPicker';
import ChatSettings from './ChatSettings';
import { Sheet, SheetActions } from '../Sheet';
import { useIsPhone } from '../../mobile';

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
  /** Napsat zákazníkovi e-mail — přepne do pošty a otevře novou zprávu */
  onComposeEmail: (email: string) => void;
}

/**
 * Chat ze zákaznického widgetu. Data jsou tatáž, se kterou pracuje webový
 * admin — aplikace do nich jen píše, takže widget ani nasazený chat se nemění.
 */
export default function ChatWorkspace({ onOpenSettings, onWorkspace, chatUnread, onComposeEmail }: Props) {
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
  /** Kdo podepisuje tuhle odpověď; 0 = bez podpisu, null = ještě podle nastavení */
  const [signPerson, setSignPerson] = useState<number | null>(null);
  /** Na telefonu se akce hlavičky a nástroje odpovědi schovávají do panelů */
  const [headSheet, setHeadSheet] = useState(false);
  const [toolSheet, setToolSheet] = useState(false);
  const [listSheet, setListSheet] = useState(false);
  const phone = useIsPhone();
  const endRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);

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

  // Pole odpovědi roste s textem — jeden řádek, dokud je co psát, nejvýš pět
  useEffect(() => {
    const box = boxRef.current;
    if (!box || !phone) return;
    box.style.height = 'auto';
    box.style.height = `${Math.min(box.scrollHeight, 132)}px`;
  }, [reply, phone]);
  useEffect(() => api.on('chat:changed', () => { loadConvs(); loadOverview(); }), [loadConvs, loadOverview]);

  const send = async () => {
    if (!activeId || !reply.trim()) return;
    setBusy('send');
    try {
      setMessages(await api.chat.send(activeId, reply, signPerson ?? undefined));
      setReply('');
      loadConvs();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const sendImage = async () => {
    if (!activeId) return;
    const file = await api.files.pickImage();
    if (!file) return;
    setBusy('image');
    try {
      setMessages(await api.chat.sendImage(activeId, file));
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

  const cfg = overview?.config;
  const personId = signPerson ?? cfg?.operatorPersonId ?? 0;
  const person = overview?.persons.find(p => p.id === personId);
  const signText = person && cfg?.signMode !== 'off'
    ? (cfg?.signSuffix ? `${person.short}, ${cfg.signSuffix}` : person.short)
    : null;
  /** Podepisuje se jen první odpověď — pokud není nastaveno jinak */
  const wouldSign = !!signText && (cfg?.signMode === 'always' || !messages.some(m => m.sender === 'operator'));
  const alreadyInText = !!signText && reply.trimEnd().endsWith(signText);

  const label = (c: ChatConversation) =>
    c.name || c.email || c.phone || `Anonymní #${c.sessionId.slice(0, 6).toUpperCase()}`;

  return (
    <div className="app ch-app" data-pane={activeId ? 'detail' : 'list'}>
      <SidebarResizer />
      <div className="sidebar">
        <div className="ch-brandrow">
          <div className="brand">quentino<span> chat</span></div>
          {/* Na telefonu je nastavení pod ozubeným kolečkem — dvě tlačítka přes
              celou šířku dole braly místo konverzacím */}
          {phone && (
            <button className="m-round" onClick={() => setListSheet(true)} aria-label="Nastavení">
              <Icon name="settings" size={18} />
            </button>
          )}
        </div>
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
                  {/* Poslední slovo má zákazník — tohle je fronta, kterou je potřeba projít */}
                  {!c.answered && c.status !== 'closed' && <b className="ch-wait"> · čeká na odpověď</b>}
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
              {/* Na telefonu je vidět vždy jen jedna obrazovka — odsud vede cesta zpět na seznam */}
              <button className="m-only m-back" onClick={() => setActiveId(null)} aria-label="Zpět na konverzace">
                <Icon name="chevLeft" size={20} />
              </button>
              <div className="ch-head-text">
                <div className="ch-head-name">
                  {FLAG[active.locale] ?? '🌍'} {label(active)}
                </div>
                <div className="ig-muted ch-head-sub">
                  {[active.email, active.phone].filter(Boolean).join(' · ') || 'bez kontaktu'}
                  {active.leftAt ? ' · zákazník odešel ze stránky' : ''}
                </div>
              </div>
              {phone ? (
                <button className="m-round" onClick={() => setHeadSheet(true)} aria-label="Další akce">
                  <Icon name="dots" size={18} />
                </button>
              ) : (
                <div className="ig-head-tools">
                  {active.email && (
                    <button className="btn ghost" data-tip={`Otevře novou zprávu na ${active.email}`}
                      onClick={() => onComposeEmail(active.email!)}>
                      <Icon name="mail" size={13} /> Napsat e-mail
                    </button>
                  )}
                  <button className="btn ghost" onClick={toggleStatus}>
                    {active.status === 'closed' ? 'Otevřít znovu' : 'Uzavřít'}
                  </button>
                </div>
              )}
            </div>

            <div className="ch-thread">
              {messages.map(m => (
                <ChatMessageView key={m.id} m={m} onOpenImage={setLightbox} />
              ))}
              <div ref={endRef} />
            </div>

            {phone ? (
              /* Telefon: jeden řádek — nástroje do panelu, pole roste s textem */
              <div className="ch-composer phone">
                {wouldSign && !alreadyInText && signText && (
                  <div className="ch-sign-strip">Podepíše se: <b>{signText}</b></div>
                )}
                <div className="ch-bar">
                  <button className="m-round" onClick={() => setToolSheet(true)} aria-label="Nástroje odpovědi">
                    <Icon name="sliders" size={18} />
                  </button>
                  <textarea
                    ref={boxRef}
                    rows={1}
                    value={reply}
                    onChange={e => setReply(e.target.value)}
                    placeholder="Odpověď…"
                  />
                  <button
                    className="m-round send"
                    onClick={send}
                    disabled={!reply.trim() || busy === 'send'}
                    aria-label="Odeslat"
                  >
                    {busy === 'send' ? <span className="spinner-inline" /> : <Icon name="send" size={17} />}
                  </button>
                </div>
              </div>
            ) : (
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
              <div className="ch-signline">
                <select
                  value={personId}
                  onChange={e => setSignPerson(Number(e.target.value))}
                  data-tip="Kdo tuhle odpověď podepíše"
                >
                  <option value={0}>Bez podpisu</option>
                  {overview?.persons.map(p => (
                    <option key={p.id} value={p.id}>{p.short}</option>
                  ))}
                </select>
                {alreadyInText
                  ? <span className="ch-sign-note">Podpis už máš v textu — přidávat se nebude.</span>
                  : wouldSign
                    ? <span className="ch-sign-note added">Na konec se přidá: <b>{signText}</b></span>
                    : signText
                      ? <span className="ch-sign-note">Podepsáno bylo dřív — tahle odpověď podpis mít nebude.</span>
                      : <span className="ch-sign-note">Bez podpisu.</span>}
              </div>

              <div className="ch-tools">
                <button className="btn ghost" onClick={() => setPicker(true)}
                  data-tip="Vloží odkaz na produkt — zákazníkovi se ve widgetu zobrazí jako karta">
                  <Icon name="bag" size={13} /> Produkt
                </button>
                <button className="btn ghost" onClick={sendImage} disabled={!!busy}
                  data-tip="Odešle obrázek rovnou — bez textu">
                  {busy === 'image' ? <span className="spinner-inline" /> : <Icon name="image" size={13} />} Obrázek
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

                <button className="btn primary" onClick={send} disabled={!reply.trim() || busy === 'send'}>
                  {busy === 'send' ? <span className="spinner-inline" /> : <Icon name="send" size={13} />} Odeslat
                </button>
              </div>
            </div>
            )}
          </>
        )}
      </div>

      {listSheet && (
        <Sheet title="Nastavení" onClose={() => setListSheet(false)}>
          <SheetActions
            onDone={() => setListSheet(false)}
            actions={[
              { icon: 'settings', label: 'Nastavení chatu', hint: 'Napojení, podpisy, kdo odpovídá', onClick: () => setSettingsOpen(true) },
              { icon: 'user', label: 'Nastavení aplikace', hint: 'Účty, osoby, AI, poukazy', onClick: onOpenSettings }
            ]}
          />
        </Sheet>
      )}

      {headSheet && active && (
        <Sheet title={label(active)} onClose={() => setHeadSheet(false)}>
          <SheetActions
            onDone={() => setHeadSheet(false)}
            actions={[
              ...(active.email ? [{
                icon: 'mail', label: 'Napsat e-mail', hint: active.email,
                onClick: () => onComposeEmail(active.email!)
              }] : []),
              ...(active.phone ? [{
                icon: 'phone', label: 'Zavolat', hint: active.phone,
                onClick: () => { window.location.href = `tel:${active.phone!.replace(/\s/g, '')}`; }
              }] : []),
              {
                icon: active.status === 'closed' ? 'inbox' : 'check',
                label: active.status === 'closed' ? 'Otevřít znovu' : 'Uzavřít konverzaci',
                hint: active.status === 'closed' ? undefined : 'Zmizí ze seznamu otevřených',
                onClick: toggleStatus
              },
              { icon: 'settings', label: 'Nastavení chatu', onClick: () => setSettingsOpen(true) }
            ]}
          />
        </Sheet>
      )}

      {toolSheet && active && (
        <Sheet title="Nástroje odpovědi" onClose={() => setToolSheet(false)}>
          <SheetActions
            onDone={() => setToolSheet(false)}
            actions={[
              { icon: 'sparkles', label: 'Navrhnout odpověď', hint: 'Podle průběhu konverzace; rozepsaný text bere jako zadání', busy: busy === 'ai', onClick: suggest },
              { icon: 'zap', label: 'Vylepšit text', disabled: !reply.trim(), busy: busy === 'improve', onClick: improve },
              { icon: 'globe', label: 'Přeložit', hint: `Do jazyka zákazníka (${active.locale})`, disabled: !reply.trim(), busy: busy === 'translate', onClick: translate },
              { icon: 'bag', label: 'Vložit produkt', hint: 'Zákazníkovi se ukáže jako karta', onClick: () => setPicker(true) },
              { icon: 'image', label: 'Poslat obrázek', hint: 'Odešle se rovnou, bez textu', busy: busy === 'image', onClick: sendImage }
            ]}
          />
          <div className="sheet-section">Podpis</div>
          <div className="sheet-field">
            <select value={personId} onChange={e => setSignPerson(Number(e.target.value))}>
              <option value={0}>Bez podpisu</option>
              {overview?.persons.map(p => (
                <option key={p.id} value={p.id}>{p.short}</option>
              ))}
            </select>
            <small>
              {alreadyInText
                ? 'Podpis už máš v textu — přidávat se nebude.'
                : wouldSign
                  ? `Na konec se přidá: ${signText}`
                  : signText
                    ? 'Podepsáno bylo dřív — tahle odpověď podpis mít nebude.'
                    : 'Bez podpisu.'}
            </small>
          </div>
        </Sheet>
      )}

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
