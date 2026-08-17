import { useEffect, useState } from 'react';

/**
 * Šířka postranního panelu je jedna pro celou aplikaci.
 *
 * Dřív si ji držela jen pošta a chat se sociálními sítěmi měly svoje pevné
 * hodnoty — přepnutím prostoru panel poskočil. Teď je hodnota tady, do CSS
 * jde jako proměnná `--side-w` a táhlo si může vykreslit každý prostor.
 */
const KEY = 'sidebarWidth';
export const SIDE_MIN = 180;
export const SIDE_MAX = 380;
/** Pod touhle šířkou zůstanou v přepínači jen ikony, aby text nepřetékal. */
export const SIDE_COMPACT = 232;

const clamp = (n: number) => Math.min(SIDE_MAX, Math.max(SIDE_MIN, Math.round(n)));

function load(): number {
  const saved = Number(localStorage.getItem(KEY));
  if (Number.isFinite(saved) && saved > 0) return clamp(saved);
  // Starší verze ukládaly šířku spolu se sloupcem zpráv
  try {
    const legacy = JSON.parse(localStorage.getItem('paneWidths') || 'null');
    if (legacy && typeof legacy.side === 'number') return clamp(legacy.side);
  } catch { /* nic */ }
  return 264;
}

let width = load();
const listeners = new Set<(w: number) => void>();

function apply(w: number) {
  document.documentElement.style.setProperty('--side-w', `${w}px`);
}
apply(width);

export function setSidebarWidth(next: number): void {
  const w = clamp(next);
  if (w === width) return;
  width = w;
  apply(w);
  localStorage.setItem(KEY, String(w));
  listeners.forEach(fn => fn(w));
}

export function useSidebarWidth(): number {
  const [w, setW] = useState(width);
  useEffect(() => {
    listeners.add(setW);
    setW(width);
    return () => { listeners.delete(setW); };
  }, []);
  return w;
}

/**
 * Táhlo na okraji panelu. Vykresluje si ho každý pracovní prostor, takže
 * šířku jde měnit v poště, v chatu i na sociálních sítích — a je všude stejná.
 */
export function SidebarResizer() {
  const w = useSidebarWidth();

  const start = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = w;
    document.body.style.cursor = 'col-resize';

    const move = (ev: MouseEvent) => setSidebarWidth(startW + (ev.clientX - startX));
    const up = () => {
      document.body.style.cursor = '';
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  return (
    <div
      className="pane-resizer"
      style={{ left: w - 3 }}
      onMouseDown={start}
      onDoubleClick={() => setSidebarWidth(264)}
      data-tip="Táhnutím změníš šířku panelu, dvojklik ji vrátí na výchozí"
    />
  );
}
