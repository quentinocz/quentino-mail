import Icon from './Icon';

export type Workspace = 'mail' | 'chat' | 'instagram';

/**
 * Přepínač pracovních prostorů. Je ve všech třech postranních panelech na
 * stejném místě, aby se dalo přepínat bez hledání.
 *
 * Rozvržení je mřížka o třech stejných dílech, ne pružný řádek: šířka tlačítek
 * tak nezávisí na délce popisku ani na tom, jestli u chatu zrovna svítí číslo.
 * Popisek se v úzkém panelu zkrátí, tlačítko nikdy nepřeteče.
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
      title={label}
    >
      <Icon name={icon} size={14} />
      <span className="ws-label">{label}</span>
      {badge ? <span className="ws-badge">{badge > 9 ? '9+' : badge}</span> : null}
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
