import { useEffect, useRef, useState } from 'react';
import Icon from './Icon';
import { SIDE_COMPACT, useSidebarWidth } from '../sidebar';

export type Workspace = 'mail' | 'chat' | 'instagram';

/** Co se skrývá pod „AI" — nástroje, které pracují s modelem nad e-shopem. */
export type AiTool = 'instagram' | 'ptrans' | 'articles';

const TABS: { id: Workspace | 'ai'; icon: string; label: string; tip: string }[] = [
  { id: 'mail', icon: 'mail', label: 'Pošta', tip: 'E-mailová schránka' },
  { id: 'chat', icon: 'chat', label: 'Chat', tip: 'Chat ze zákaznického widgetu na e-shopu' },
  { id: 'ai', icon: 'sparkles', label: 'AI', tip: 'Sociální sítě, překlady produktů a články' }
];

const AI_TOOLS: { id: AiTool; icon: string; label: string; hint: string }[] = [
  { id: 'instagram', icon: 'image', label: 'Sociální sítě', hint: 'Instagram a Facebook ve všech trzích' },
  { id: 'ptrans', icon: 'globe', label: 'Překlady produktů', hint: 'Jazykové mutace z produktového feedu' },
  { id: 'articles', icon: 'fileText', label: 'Články', hint: 'Psaní a překlad článků pro e-shop' }
];

/**
 * Přepínač pracovních prostorů — ve všech panelech na stejném místě.
 *
 * Pošta a chat jsou samostatné prostory, protože se v nich tráví celý den.
 * Nástroje, které pracují s modelem nad e-shopem, se do řady nevešly a hlavně
 * spolu souvisí — proto jsou pod jedním tlačítkem **AI** a rozbalí se
 * nabídkou. Přibude-li další, přidá se jen řádek, ne další záložka.
 */
export default function WorkspaceSwitch({ current, onChange, onAiTool, chatUnread, activeTool }: {
  current: Workspace;
  onChange: (w: Workspace) => void;
  /** Otevření nástroje z nabídky AI */
  onAiTool?: (tool: AiTool) => void;
  /** Nepřečtené zprávy v chatu — číslo u záložky */
  chatUnread?: number;
  /** Který nástroj je zrovna otevřený (kvůli zvýraznění) */
  activeTool?: AiTool;
}) {
  const compact = useSidebarWidth() < SIDE_COMPACT;
  const [menu, setMenu] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  // Klik mimo nabídku ji zavře; bez toho by zůstala viset přes celou aplikaci
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setMenu(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  const aiActive = current === 'instagram' || !!activeTool;

  return (
    <div className={`ig-switch ${compact ? 'compact' : ''}`} ref={box}>
      {TABS.map(t => (
        <button
          key={t.id}
          className={t.id === 'ai' ? (aiActive ? 'active' : '') : (current === t.id ? 'active' : '')}
          onClick={() => {
            if (t.id === 'ai') { setMenu(open => !open); return; }
            if (current !== t.id) onChange(t.id as Workspace);
          }}
          data-tip={t.tip}
          aria-label={t.label}
        >
          <Icon name={t.icon} size={14} />
          {!compact && <span className="ws-label">{t.label}</span>}
          {t.id === 'ai' && !compact && <Icon name="chevDown" size={10} className="ws-caret" />}
          {t.id === 'chat' && chatUnread ? (
            <span className="ws-badge">{chatUnread > 9 ? '9+' : chatUnread}</span>
          ) : null}
        </button>
      ))}

      {menu && (
        <div className="ws-menu">
          {AI_TOOLS.map(tool => (
            <button
              key={tool.id}
              className={`ws-menu-item ${(tool.id === 'instagram' ? current === 'instagram' : activeTool === tool.id) ? 'on' : ''}`}
              onClick={() => {
                setMenu(false);
                if (tool.id === 'instagram') onChange('instagram');
                else onAiTool?.(tool.id);
              }}
            >
              <Icon name={tool.icon} size={15} />
              <span>
                <b>{tool.label}</b>
                <small>{tool.hint}</small>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
