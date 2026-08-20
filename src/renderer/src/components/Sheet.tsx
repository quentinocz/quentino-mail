import { ReactNode, useEffect } from 'react';
import Icon from './Icon';

/**
 * Vysouvací panel odspodu.
 *
 * Na telefonu je jediné rozumné místo, kam schovat sadu akcí — vodorovné
 * rolování lišty se na dotyku hledá špatně a půlka tlačítek zůstane za
 * okrajem. Na počítači se z toho stane běžný dialog uprostřed, takže se
 * stejná komponenta dá použít v obou režimech.
 */
export function Sheet({ title, onClose, children, footer }: {
  title?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="sheet-scrim" onClick={onClose}>
      <div className="sheet" role="dialog" aria-label={title} onClick={e => e.stopPropagation()}>
        <div className="sheet-grab" />
        {title && (
          <div className="sheet-head">
            <span>{title}</span>
            <button className="sheet-x" onClick={onClose} aria-label="Zavřít"><Icon name="x" size={16} /></button>
          </div>
        )}
        <div className="sheet-body">{children}</div>
        {footer && <div className="sheet-foot">{footer}</div>}
      </div>
    </div>
  );
}

export interface SheetAction {
  icon?: string;
  label: string;
  hint?: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  busy?: boolean;
  /** Přepínač, který je zrovna zapnutý */
  active?: boolean;
  /** Nechá panel otevřený — pro přepínače, kde se hodí zaškrtnout víc věcí */
  keepOpen?: boolean;
}

/** Seznam akcí v panelu — jedna pod druhou, ať se do nich dá trefit palcem. */
export function SheetActions({ actions, onDone }: { actions: SheetAction[]; onDone: () => void }) {
  return (
    <div className="sheet-actions">
      {actions.map((action, index) => (
        <button
          key={index}
          className={`sheet-action${action.danger ? ' danger' : ''}${action.active ? ' on' : ''}`}
          disabled={action.disabled || action.busy}
          onClick={() => { action.onClick(); if (!action.keepOpen) onDone(); }}
        >
          <span className="sheet-action-icon">
            {action.busy ? <span className="spinner-inline" /> : action.icon ? <Icon name={action.icon} size={17} /> : null}
          </span>
          <span className="sheet-action-text">
            {action.label}
            {action.hint && <small>{action.hint}</small>}
          </span>
          {action.active && <Icon name="check" size={15} />}
        </button>
      ))}
    </div>
  );
}
