import Icon from './Icon';
import type { Workspace } from './WorkspaceSwitch';

const TABS: { id: Workspace; icon: string; label: string }[] = [
  { id: 'mail', icon: 'mail', label: 'Pošta' },
  { id: 'chat', icon: 'chat', label: 'Chat' },
  { id: 'instagram', icon: 'image', label: 'Social' }
];

/**
 * Spodní přepínač prostorů pro telefon.
 *
 * Na iPhonu je horní část obrazovky daleko od palce, proto hlavní navigace
 * patří dolů — stejně jako ji mají systémové aplikace. Lišta si sama nechá
 * místo na spodní ovládací proužek (`env(safe-area-inset-bottom)`), takže
 * o ni tlačítka nezavadí.
 */
export default function MobileTabs({ current, onChange, chatUnread }: {
  current: Workspace;
  onChange: (w: Workspace) => void;
  chatUnread?: number;
}) {
  return (
    <nav className="m-tabs" role="tablist">
      {TABS.map(tab => (
        <button
          key={tab.id}
          role="tab"
          aria-selected={current === tab.id}
          className={current === tab.id ? 'active' : ''}
          onClick={() => current !== tab.id && onChange(tab.id)}
        >
          <span className="m-tab-icon">
            <Icon name={tab.icon} size={22} />
            {tab.id === 'chat' && chatUnread ? (
              <span className="m-tab-badge">{chatUnread > 9 ? '9+' : chatUnread}</span>
            ) : null}
          </span>
          <span className="m-tab-label">{tab.label}</span>
        </button>
      ))}
    </nav>
  );
}
