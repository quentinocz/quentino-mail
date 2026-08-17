import { useEffect, useLayoutEffect, useRef, useState } from 'react';

interface Anchor {
  text: string;
  rect: DOMRect;
}

/**
 * Globální vrstva tooltipů pro prvky s atributem data-tip.
 * Pozice se počítá v JS a vždy se sevře do viditelné plochy okna —
 * bublina nikdy nepřeteče přes okraj.
 */
export default function TooltipLayer() {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [style, setStyle] = useState<{ left: number; top: number; visible: boolean }>({ left: 0, top: 0, visible: false });
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let current: HTMLElement | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const hide = () => {
      current = null;
      if (timer) clearTimeout(timer);
      setAnchor(null);
    };

    const over = (e: MouseEvent) => {
      const el = (e.target as HTMLElement)?.closest?.('[data-tip]') as HTMLElement | null;
      if (el === current) return;
      if (timer) clearTimeout(timer);
      current = el;
      if (!el) { setAnchor(null); return; }
      const text = el.getAttribute('data-tip');
      if (!text) { setAnchor(null); return; }
      timer = setTimeout(() => {
        // prvek mohl mezitím zmizet
        if (document.contains(el)) setAnchor({ text, rect: el.getBoundingClientRect() });
      }, 300);
    };

    document.addEventListener('mouseover', over);
    document.addEventListener('mousedown', hide, true);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      document.removeEventListener('mouseover', over);
      document.removeEventListener('mousedown', hide, true);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
      if (timer) clearTimeout(timer);
    };
  }, []);

  // Po vyrenderování změříme bublinu a sevřeme ji do okna
  useLayoutEffect(() => {
    if (!anchor || !boxRef.current) { setStyle(s => ({ ...s, visible: false })); return; }
    const box = boxRef.current.getBoundingClientRect();
    const M = 8; // odstup od okrajů okna
    let left = anchor.rect.left + anchor.rect.width / 2 - box.width / 2;
    left = Math.max(M, Math.min(left, window.innerWidth - box.width - M));
    let top = anchor.rect.bottom + 7;
    if (top + box.height > window.innerHeight - M) {
      top = anchor.rect.top - box.height - 7; // nevejde se dolů → nahoru
      if (top < M) top = M;
    }
    setStyle({ left, top, visible: true });
  }, [anchor]);

  if (!anchor) return null;
  return (
    <div
      ref={boxRef}
      className="tip-layer"
      style={{ left: style.left, top: style.top, opacity: style.visible ? 1 : 0 }}
    >
      {anchor.text}
    </div>
  );
}
