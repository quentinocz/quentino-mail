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
let closeOpenRow: (() => void) | null = null;

const ACTION_W = 82;
/** Kolik se musí táhnout, než se tah bere jako vodorovný */
const AXIS = 10;

export function SwipeRow({ left, right, className = '', children }: {
  /** Odkryje se tahem doprava (tlačítka vlevo) */
  left?: SwipeAction[];
  /** Odkryje se tahem doleva (tlačítka vpravo) */
  right?: SwipeAction[];
  className?: string;
  children: React.ReactNode;
}) {
  const phone = useIsPhone();
  const [dx, setDx] = useState(0);
  /*
   * Posun se drží i v odkazu, ne jen ve stavu.
   *
   * Puštění prstu se vyhodnocuje v obsluze, která vidí stav z posledního
   * překreslení — a to při rychlém švihnutí ještě nemusí proběhnout. Řádka
   * pak vyskočila zpátky, i když ji člověk odsunul přes půlku.
   */
  const dxRef = useRef(0);
  /*
   * Která strana je právě odkrytá. Nestačí se ptát na znaménko posunu:
   * při zavírání je posun hned nula, ale řádka ještě dojíždí — a kdyby
   * tlačítka v tu chvíli zmizela, prosvitlo by pod ní pozadí.
   */
  const [side, setSide] = useState<'left' | 'right' | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef({ x: 0, y: 0, base: 0, axis: '' as '' | 'x' | 'y' });
  const box = useRef<HTMLDivElement>(null);

  const move = useCallback((value: number) => {
    dxRef.current = value;
    setDx(value);
    if (value !== 0) {
      if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; }
      setSide(value > 0 ? 'left' : 'right');
    }
  }, []);

  const close = useCallback(() => {
    dxRef.current = 0;
    setDx(0);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setSide(null), 220);
    if (closeOpenRow) closeOpenRow = null;
  }, []);

  useEffect(() => () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    if (closeOpenRow) closeOpenRow = null;
  }, []);

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
      if (start.current.axis === 'x' && closeOpenRow) { closeOpenRow(); closeOpenRow = null; }
    }
    if (start.current.axis !== 'x') return;

    /*
     * Za poslední tlačítko se dá přetáhnout ještě kus — v tom prostoru žije
     * dlouhý tah, který rovnou spustí první akci. Kdyby se dalo táhnout jen
     * po šířku tlačítek, u třech akcích by se dlouhý tah nedal provést vůbec.
     */
    const raw = start.current.base + mx;
    move(Math.max(-rightW - 120, Math.min(leftW + 120, raw)));
  };

  const onEnd = () => {
    if (start.current.axis !== 'x') return;
    const width = box.current?.offsetWidth ?? 320;
    const at = dxRef.current;

    const side = at > 0 ? left : right;
    const openW = at > 0 ? leftW : rightW;
    if (!side?.length) { close(); return; }

    /*
     * Dlouhý tah spustí první akci — pokud není nevratná.
     *
     * Práh musí být **za** odkrytými tlačítky, ne na půlce řádku: se třemi
     * akcemi zabírají tlačítka víc než půlku, takže by se tah nikdy nedostal
     * k odkrytí a rovnou by spouštěl akci.
     */
    const full = Math.max(width * 0.6, openW + 70);
    const first = side[0];
    if (Math.abs(at) > full && !first.confirm) {
      close();
      first.run();
      return;
    }
    if (Math.abs(at) > openW * 0.5) {
      move(at > 0 ? leftW : -rightW);
      closeOpenRow = close;
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
        style={{ transform: `translateX(${dx}px)`, transition: start.current.axis === 'x' ? 'none' : undefined }}
        onTouchStart={onStart}
        onTouchMove={onMove}
        onTouchEnd={onEnd}
        onTouchCancel={close}
        /* Když je řádka odsunutá, klepnutí ji jen zavře — jinak by se pod
           prstem otevřela zpráva, kterou chtěl člověk jen zaklapnout */
        onClickCapture={e => { if (dx !== 0) { e.stopPropagation(); e.preventDefault(); close(); } }}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * Tažení dolů nad začátkem seznamu = synchronizovat.
 *
 * Reaguje se, jen když je seznam úplně nahoře a tah je svislý — jinak by
 * se každé rolování prsty měnilo v synchronizaci.
 */
export function usePullToRefresh(
  ref: React.RefObject<HTMLElement | null>,
  onRefresh: () => void,
  enabled = true
): number {
  const [pull, setPull] = useState(0);
  const state = useRef({ y: 0, active: false });

  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;

    const onStart = (e: TouchEvent) => {
      state.current = { y: e.touches[0].clientY, active: el.scrollTop <= 0 };
    };
    const onMove = (e: TouchEvent) => {
      if (!state.current.active) return;
      const dy = e.touches[0].clientY - state.current.y;
      if (dy <= 0) { setPull(0); return; }
      // Odpor: sto pixelů prstu je padesát pixelů pruhu, ať se to netahá samo
      setPull(Math.min(90, dy * 0.5));
      if (dy > 6 && e.cancelable) e.preventDefault();
    };
    const onEnd = () => {
      if (pull > 55) onRefresh();
      state.current.active = false;
      setPull(0);
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
  }, [ref, onRefresh, enabled, pull]);

  return pull;
}

/**
 * Tah od levého okraje = zpět.
 *
 * Začíná jen v pruhu širokém pár milimetrů u kraje displeje. Kdyby se chytal
 * kdekoliv, nešlo by vodorovně listovat ničím jiným.
 */
export function useEdgeBack(onBack: () => void, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    let armed = false;
    let x = 0;
    let y = 0;

    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      armed = t.clientX <= 24;
      x = t.clientX;
      y = t.clientY;
    };
    const onMove = (e: TouchEvent) => {
      if (!armed) return;
      const t = e.touches[0];
      if (Math.abs(t.clientY - y) > 45) { armed = false; return; }
      if (t.clientX - x > 70) {
        armed = false;
        onBack();
      }
    };
    const off = () => { armed = false; };

    window.addEventListener('touchstart', onStart, { passive: true });
    window.addEventListener('touchmove', onMove, { passive: true });
    window.addEventListener('touchend', off);
    window.addEventListener('touchcancel', off);
    return () => {
      window.removeEventListener('touchstart', onStart);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', off);
      window.removeEventListener('touchcancel', off);
    };
  }, [onBack, enabled]);
}
