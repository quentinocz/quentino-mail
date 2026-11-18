import { useEffect, useRef, useState, type ReactNode } from 'react';
import Icon from './Icon';

/**
 * Tlačítko s nabídkou.
 *
 * Vzniklo kvůli liště v překladech: osm tlačítek vedle sebe, u kterých
 * „člověk pomalu neví, co dělají" (Patrik, 18. 11.). Hlavní akce zůstávají
 * vidět, méně časté se schovají sem — každá položka má pod názvem jednu
 * větu, co udělá, takže se nemusí zkoušet.
 */
export interface DropItem {
  label: string;
  /** Jedna věta, co to udělá — pod názvem, ne v bublině */
  hint?: string;
  icon?: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}

export default function DropMenu({ label, icon, items, up = false, align = 'left', className = 'btn ghost', title }: {
  label: ReactNode;
  icon?: string;
  items: (DropItem | null | false)[];
  /** Otevřít nahoru — pro lištu u spodního okraje */
  up?: boolean;
  align?: 'left' | 'right';
  className?: string;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);

  const list = items.filter(Boolean) as DropItem[];
  return (
    <div className="dm" ref={box}>
      <button className={className} onClick={() => setOpen(v => !v)} aria-expanded={open} data-tip={title}>
        {icon && <Icon name={icon} size={13} />}
        {icon ? ' ' : ''}{label}
        <Icon name={up ? 'chevUp' : 'chevDown'} size={12} />
      </button>
      {open && (
        <div className={`dm-pop ${up ? 'up' : ''} ${align}`} role="menu">
          {list.map(item => (
            <button key={item.label} role="menuitem" disabled={item.disabled}
              className={`dm-item${item.danger ? ' danger' : ''}`}
              onClick={() => { setOpen(false); item.onClick(); }}>
              {item.icon && <Icon name={item.icon} size={14} />}
              <span>
                <b>{item.label}</b>
                {item.hint && <small>{item.hint}</small>}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
