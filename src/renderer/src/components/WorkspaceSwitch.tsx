import Icon from './Icon';

export type Workspace = 'mail' | 'chat' | 'instagram';

/**
 * Přepínač pracovních prostorů. Je ve všech třech postranních panelech na
 * stejném místě, aby se dalo přepínat bez hledání.
 */
export default function WorkspaceSwitch({ current, onChange, chatUnread }: {
  current: Workspace;
  onChange: (w: Workspace) => void;
  /** Nepřečtené zprávy v chatu — číslo u záložky */
  chatUnread?: number;
}) {
  const tab = (id: Workspace, icon: string, label: string, tip: string, badge?: number) => (
    <button
      key={id}
      className={current === id ? 'active' : ''}
      onClick={() => current !== id && onChange(id)}
      data-tip={tip}
    >
      <Icon name={icon} size={14} /> {label}
      {badge ? <span className="ig-switch-badge">{badge > 99 ? '99+' : badge}</span> : null}
    </button>
  );

  return (
    <div className="ig-switch">
      {tab('mail', 'mail', 'Pošta', 'E-mailová schránka')}
      {tab('chat', 'chat', 'Chat', 'Chat ze zákaznického widgetu na e-shopu', chatUnread)}
      {tab('instagram', 'image', 'Social', 'Vícejazyčné publikování na Instagram a Facebook')}
    </div>
  );
}
