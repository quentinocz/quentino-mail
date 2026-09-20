import { useEffect, useLayoutEffect, useRef, useState } from 'react';

interface Anchor {
  text: string;
  rect: DOMRect;
  /** Kde byla myš, když se bublina vyvolala — bublina míří nad kurzor */
  mouse: { x: number; y: number };
}

/**
 * Globální vrstva tooltipů pro prvky s atributem data-tip.
 * Pozice se počítá v JS a vždy se sevře do viditelné plochy okna —
 * bublina nikdy nepřeteče přes okraj.
 *
 * ## Proč nad kurzorem
 *
 * Bublina se otevírá **nad** místem, kde je myš, a dolů se překlopí jen
 * tehdy, když se nahoru nevejde. Když visela pod prvkem, zakrývala přesně
 * to, kam mířila další otázka — u přehledu se čtou čísla shora dolů, takže
 * po každém přečtení se muselo objet kolem bubliny. Nahoře zůstává cesta
 * dolů volná.
 *
 * Bublina je `position: fixed`, takže nikdy nic neodsune; delší vysvětlení
 * má strop v šířce i výšce (`.tip-layer` ve stylech) — dřív se u některých
 * metrik roztáhla přes půl okna.
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
      const mouse = { x: e.clientX, y: e.clientY };
      timer = setTimeout(() => {
        // prvek mohl mezitím zmizet
        if (document.contains(el)) setAnchor({ text, rect: el.getBoundingClientRect(), mouse });
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
    const GAP = 10; // aby se bublina nedotýkala kurzoru
    /*
     * Vodorovně se drží středu prvku, ne kurzoru — u širokého řádku by
     * bublina jezdila sem a tam podle toho, kde zrovna myš je.
     */
    let left = anchor.rect.left + anchor.rect.width / 2 - box.width / 2;
    left = Math.max(M, Math.min(left, window.innerWidth - box.width - M));
    /*
     * Svisle nad kurzor. Prvek může být vysoký (celá dlaždice), takže se
     * měří od myši, ne od jeho horní hrany — bublina se tak objeví tam,
     * kam se člověk zrovna dívá.
     */
    let top = anchor.mouse.y - box.height - GAP;
    if (top < M) {
      // nahoru se to nevejde → pod prvek, ne pod kurzor, ať nepřekáží
      top = Math.min(anchor.rect.bottom + GAP, window.innerHeight - box.height - M);
      if (top < M) top = M;
    }
    setStyle({ left, top, visible: true });
  }, [anchor]);

  if (!anchor) return null;
  return (
    <div
      ref={boxRef}
      className={`tip-layer${anchor.text.length > 60 ? ' long' : ''}`}
      style={{ left: style.left, top: style.top, opacity: style.visible ? 1 : 0 }}
    >
      {anchor.text}
    </div>
  );
}
