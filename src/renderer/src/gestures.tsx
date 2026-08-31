import { useCallback, useEffect, useRef, useState } from 'react';
import Icon from './components/Icon';
import { useIsPhone } from './mobile';

/**
 * Dotyková gesta pro telefon.
 *
 * Na telefonu se ovládá palcem, ne kurzorem: co je na počítači tlačítko
 * v panelu, tady bývá tah přes řádek. Systémová pošta i chatovací aplikace
 * to dělají stejně, takže se to nemusí učit — a hlavně to zkracuje cestu
 * ke smazání nebo hvězdičce ze tří klepnutí na jedno gesto.
 *
 * Tři gesta, každé s jedním pravidlem navíc, které rozhoduje o tom, jestli
 * se s tím dá žít:
 *
 *  1. **Tah přes řádek** odkryje tlačítka. Dlouhý tah rovnou spustí to první,
 *     ale jen když **není nevratné** — smazat se dá jen klepnutím na tlačítko,
 *     aby se zpráva neztratila při listování.
 *  2. **Tažení dolů** nad začátkem seznamu synchronizuje. Reaguje se až po
 *     kousku tahu, aby se to nepletlo s obyčejným rolováním.
 *  3. **Tah od levého okraje** je krok zpět. Začíná jen v úzkém pruhu
 *     u kraje, kde se nedá omylem chytit obsah.
 */

export interface SwipeAction {
  key: string;
  label: string;
  icon: string;
  tone?: 'danger' | 'warn' | 'ok';
  /** Nevratná akce se nespustí dlouhým tahem, jen klepnutím */
  confirm?: boolean;
  run: () => void;
}

/** Odsunutá smí být jen jedna řádka — jinak se v seznamu ztratí přehled. */
let openRow: { close: () => void } | null = null;

const ACTION_W = 82;
/** Kolik se musí táhnout, než se tah bere jako vodorovný */
const AXIS = 10;
const SNAP = 'transform 0.22s cubic-bezier(0.22, 0.9, 0.28, 1)';

export function SwipeRow({ left, right, className = '', children }: {
  /** Odkryje se tahem doprava (tlačítka vlevo) */
  left?: SwipeAction[];
  /** Odkryje se tahem doleva (tlačítka vpravo) */
  right?: SwipeAction[];
  className?: string;
  children: React.ReactNode;
}) {
  const phone = useIsPhone();
  /*
   * Posun se do Reactu nehlásí.
   *
   * Původně se každý pohyb prstu ukládal do stavu, takže se při jednom tahu
   * překreslil celý seznam šedesátkrát za vteřinu — a bylo to na pohybu vidět.
   * Teď se posouvá přímo prvek a stav se dotkne jen jednou za gesto, aby se
   * vykreslila správná strana tlačítek.
   */
  const front = useRef<HTMLDivElement>(null);
  const dxRef = useRef(0);
  /*
   * Která strana je odkrytá. Nestačí se ptát na znaménko posunu: při zavírání
   * je posun hned nula, ale řádka ještě dojíždí — a kdyby tlačítka v tu chvíli
   * zmizela, prosvitlo by pod ní pozadí.
   */
  const [side, setSide] = useState<'left' | 'right' | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef({ x: 0, y: 0, base: 0, axis: '' as '' | 'x' | 'y' });
  const box = useRef<HTMLDivElement>(null);

  const apply = useCallback((value: number, animate: boolean) => {
    dxRef.current = value;
    const el = front.current;
    if (!el) return;
    el.style.transition = animate ? SNAP : 'none';
    el.style.transform = `translateX(${value}px)`;
  }, []);

  const close = useCallback(() => {
    apply(0, true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setSide(null), 260);
    if (openRow?.close === close) openRow = null;
  }, [apply]);

  useEffect(() => () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    if (openRow?.close === close) openRow = null;
  }, [close]);

  if (!phone || (!left?.length && !right?.length)) {
    return <div className={className}>{children}</div>;
  }

  const leftW = (left?.length ?? 0) * ACTION_W;
  const rightW = (right?.length ?? 0) * ACTION_W;

  const onStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    start.current = { x: t.clientX, y: t.clientY, base: dxRef.current, axis: '' };
  };

  const onMove = (e: React.TouchEvent) => {
    const t = e.touches[0];
    const mx = t.clientX - start.current.x;
    const my = t.clientY - start.current.y;

    if (!start.current.axis) {
      if (Math.abs(mx) < AXIS && Math.abs(my) < AXIS) return;
      start.current.axis = Math.abs(mx) > Math.abs(my) ? 'x' : 'y';
      /*
       * Zavřít se má **jiná** otevřená řádka, ne tahle. Když se zavírala
       * i ta, po které prst zrovna jel, vynulovala si posun uprostřed gesta,
       * ale tah dál počítal od původního místa — řádka poskočila zpátky
       * a zavřít se nedala vůbec.
       */
      if (start.current.axis === 'x' && openRow && openRow.close !== close) {
        openRow.close();
        openRow = null;
      }
    }
    if (start.current.axis !== 'x') return;

    /*
     * Za poslední tlačítko se dá přetáhnout ještě kus — v tom prostoru žije
     * dlouhý tah, který rovnou spustí první akci. Kdyby se dalo táhnout jen
     * po šířku tlačítek, u třech akcí by se dlouhý tah nedal provést vůbec.
     */
    const raw = start.current.base + mx;
    const value = Math.max(-rightW - 120, Math.min(leftW + 120, raw));

    if (value !== 0) {
      const want = value > 0 ? 'left' : 'right';
      if (want !== side) {
        if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; }
        setSide(want);
      }
    }
    apply(value, false);
  };

  const onEnd = () => {
    if (start.current.axis !== 'x') return;
    const width = box.current?.offsetWidth ?? 320;
    const at = dxRef.current;

    const acts = at > 0 ? left : right;
    const openW = at > 0 ? leftW : rightW;
    if (!acts?.length) { close(); return; }

    /*
     * Dlouhý tah spustí první akci — pokud není nevratná.
     *
     * Práh musí být **za** odkrytými tlačítky, ne na půlce řádku: se třemi
     * akcemi zabírají tlačítka víc než půlku, takže by se tah nikdy nedostal
     * k odkrytí a rovnou by spouštěl akci.
     */
    const full = Math.max(width * 0.6, openW + 70);
    const first = acts[0];
    if (Math.abs(at) > full && !first.confirm) {
      close();
      first.run();
      return;
    }
    if (Math.abs(at) > openW * 0.5) {
      apply(at > 0 ? leftW : -rightW, true);
      openRow = { close };
      return;
    }
    close();
  };

  const button = (a: SwipeAction) => (
    <button key={a.key} className={`swipe-act ${a.tone ?? ''}`}
      onClick={e => { e.stopPropagation(); close(); a.run(); }}>
      <Icon name={a.icon} size={17} />
      <span>{a.label}</span>
    </button>
  );

  return (
    <div className={`swipe-row ${className}`} ref={box}>
      {side === 'left' && !!left?.length && <div className="swipe-side left">{left.map(button)}</div>}
      {side === 'right' && !!right?.length && <div className="swipe-side right">{right.map(button)}</div>}
      <div
        className="swipe-front"
        ref={front}
        onTouchStart={onStart}
        onTouchMove={onMove}
        onTouchEnd={onEnd}
        onTouchCancel={close}
        /* Když je řádka odsunutá, klepnutí ji jen zavře — jinak by se pod
           prstem otevřela zpráva, kterou chtěl člověk jen zaklapnout */
        onClickCapture={e => {
          if (dxRef.current !== 0) { e.stopPropagation(); e.preventDefault(); close(); }
        }}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * Tažení dolů nad začátkem seznamu = synchronizovat.
 *
 * Reaguje se, jen když je seznam úplně nahoře **a tah je svislý**. Bez
 * rozpoznání směru se pruh objevoval i při tahu přes řádek do strany a obě
 * gesta si pak přeskakovala pod rukama.
 */
export function usePullToRefresh(
  ref: React.RefObject<HTMLElement | null>,
  onRefresh: () => void,
  enabled = true
): number {
  const [pull, setPull] = useState(0);
  const value = useRef(0);
  const state = useRef({ x: 0, y: 0, live: false, axis: '' as '' | 'x' | 'y' });

  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;

    const set = (next: number) => {
      if (next === value.current) return;
      value.current = next;
      setPull(next);
    };

    const onStart = (e: TouchEvent) => {
      state.current = {
        x: e.touches[0].clientX,
        y: e.touches[0].clientY,
        live: el.scrollTop <= 0,
        axis: ''
      };
    };
    const onMove = (e: TouchEvent) => {
      if (!state.current.live) return;
      const dx = e.touches[0].clientX - state.current.x;
      const dy = e.touches[0].clientY - state.current.y;

      if (!state.current.axis) {
        if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
        state.current.axis = Math.abs(dy) > Math.abs(dx) ? 'y' : 'x';
        // Tah do strany patří řádce pod prstem, ne synchronizaci
        if (state.current.axis === 'x') { state.current.live = false; set(0); return; }
      }
      if (dy <= 0) { set(0); return; }
      // Odpor: sto pixelů prstu je padesát pixelů pruhu, ať se to netahá samo
      set(Math.min(90, Math.round(dy * 0.5)));
      if (dy > 6 && e.cancelable) e.preventDefault();
    };
    const onEnd = () => {
      if (value.current > 55) onRefresh();
      state.current.live = false;
      set(0);
    };

    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', onEnd);
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
    };
  }, [ref, onRefresh, enabled]);

  return pull;
}

/**
 * Tah od levého okraje = zpět.
 *
 * Začíná jen v pruhu širokém pár milimetrů u kraje displeje. Kdyby se chytal
 * kdekoliv, nešlo by vodorovně listovat ničím jiným.
 *
 * Když se předá `pane`, **jde obrazovka s prstem**: odsouvá se doprava, jak
 * se táhne, a po puštění dojede nebo se vrátí. Bez toho gesto jen v jednu
 * chvíli přepnulo, co je vidět, a vypadalo to jako bliknutí — člověk nevěděl,
 * jestli se něco stalo, nebo se aplikace zakuckala.
 */
export function useEdgeBack(
  onBack: () => void,
  enabled = true,
  pane?: React.RefObject<HTMLElement | null>
): void {
  useEffect(() => {
    if (!enabled) return;
    let armed = false;
    let dragging = false;
    let x = 0;
    let y = 0;

    const el = () => pane?.current ?? null;
    const slide = (value: number, animate: boolean) => {
      const node = el();
      if (!node) return;
      node.style.transition = animate ? 'transform 0.26s cubic-bezier(0.22, 0.9, 0.28, 1)' : 'none';
      node.style.transform = value ? `translateX(${value}px)` : '';
    };

    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      armed = t.clientX <= 24;
      dragging = false;
      x = t.clientX;
      y = t.clientY;
    };

    const onMove = (e: TouchEvent) => {
      if (!armed) return;
      const t = e.touches[0];
      const dx = t.clientX - x;
      const dy = t.clientY - y;

      if (!dragging) {
        if (Math.abs(dy) > 45) { armed = false; return; }
        if (dx < 12) return;
        dragging = true;
      }
      if (!el()) {
        // Bez plochy k posunu zbývá práh — tak se zavírá zásuvka
        if (dx > 70) { armed = false; onBack(); }
        return;
      }
      slide(Math.max(0, dx), false);
    };

    const onEnd = () => {
      if (!armed || !dragging) { armed = false; dragging = false; return; }
      armed = false;
      dragging = false;
      const node = el();
      if (!node) return;

      const moved = new DOMMatrixReadOnly(getComputedStyle(node).transform).m41;
      if (moved > Math.min(90, node.offsetWidth * 0.3)) {
        slide(node.offsetWidth, true);
        /*
         * Zpátky se přepíná až po dojetí. Kdyby se přepnulo hned, obrazovka
         * by zmizela uprostřed pohybu — přesně to bliknutí, kvůli kterému
         * se tohle dělá.
         */
        setTimeout(() => { onBack(); slide(0, false); }, 240);
      } else {
        slide(0, true);
      }
    };

    window.addEventListener('touchstart', onStart, { passive: true });
    window.addEventListener('touchmove', onMove, { passive: true });
    window.addEventListener('touchend', onEnd);
    window.addEventListener('touchcancel', onEnd);
    return () => {
      window.removeEventListener('touchstart', onStart);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
      window.removeEventListener('touchcancel', onEnd);
    };
  }, [onBack, enabled, pane]);
}
