import Icon from './Icon';
import { SIDE_COMPACT, useSidebarWidth } from '../sidebar';

export type Workspace = 'mail' | 'chat' | 'instagram';

const TABS: { id: Workspace; icon: string; label: string; tip: string }[] = [
  { id: 'mail', icon: 'mail', label: 'Pošta', tip: 'E-mailová schránka' },
  { id: 'chat', icon: 'chat', label: 'Chat', tip: 'Chat ze zákaznického widgetu na e-shopu' },
  { id: 'instagram', icon: 'image', label: 'Social', tip: 'Vícejazyčné publikování na Instagram a Facebook' }
];

/**
 * Přepínač pracovních prostorů — ve všech panelech na stejném místě.
 *
 * Rozvržení je mřížka o třech stejných dílech, takže šířka tlačítek nezávisí
 * na délce popisku ani na odznaku s počtem. V úzkém panelu se popisky schovají
 * a zůstanou jen ikony; text tak nemá jak přetéct.
 */
export default function WorkspaceSwitch({ current, onChange, chatUnread }: {
  current: Workspace;
  onChange: (w: Workspace) => void;
  /** Nepřečtené zprávy v chatu — číslo u záložky */
  chatUnread?: number;
}) {
  const compact = useSidebarWidth() < SIDE_COMPACT;

  return (
    <div className={`ig-switch ${compact ? 'compact' : ''}`}>
      {TABS.map(t => (
        <button
          key={t.id}
          className={current === t.id ? 'active' : ''}
          onClick={() => current !== t.id && onChange(t.id)}
          data-tip={t.tip}
          aria-label={t.label}
        >
          <Icon name={t.icon} size={14} />
          {!compact && <span className="ws-label">{t.label}</span>}
          {t.id === 'chat' && chatUnread ? (
            <span className="ws-badge">{chatUnread > 9 ? '9+' : chatUnread}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
