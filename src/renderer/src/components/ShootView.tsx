import { useCallback, useEffect, useRef, useState } from 'react';
import type { ShootOverlay, ShootGhost, ShootFix } from '@shared/types';
import { cssFilter } from '../shoot/fix';

/**
 * Živý náhled s vodítky a průsvitkou.
 *
 * ## Proč jsou souřadnice v podílu, ne v pixelech
 *
 * Nakreslený rámeček musí sedět stejně na náhledu v okně (960 px na šířku)
 * i na hotové fotce (6000 px) a musí přežít zvětšení okna i přepnutí na
 * druhou obrazovku. Ukládá se proto 0–1 vůči obrazu a přepočítává se až
 * při vykreslení. Kdyby se ukládaly pixely, po roztažení okna by vodítka
 * seděla jinde než při focení — a to je přesně ta chyba, kterou by nikdo
 * nehledal na správném místě.
 *
 * ## Proč SVG a ne plátno
 *
 * Vodítka se kreslí jednou a pak se jen dívají; náhled se pod nimi mění
 * patnáctkrát za vteřinu. Na plátně by se musela překreslovat s každým
 * snímkem. V SVG je prohlížeč drží sám a překresluje se jen obraz.
 */

export type Tool = 'zoom' | 'line' | 'rect' | 'ellipse' | 'cross' | 'thirds' | 'grid' | 'pick';

let nextId = 0;
function makeId(): string {
  return `o${Date.now().toString(36)}${(nextId++).toString(36)}`;
}

/** Vodítko přes celý obraz — přidá se kliknutím, netáhne se. */
export function wholeStage(kind: 'cross' | 'thirds' | 'grid', color: string, width: number,
  at = { x: 0.5, y: 0.5 }): ShootOverlay {
  // Střed se dá posouvat, takže vzniká tam, kam se kliklo; mřížka je vždy celá
  const middle = kind === 'cross' ? at : { x: 0, y: 0 };
  return {
    id: makeId(), kind, x: middle.x, y: middle.y, x2: 1, y2: 1,
    color, width, cells: kind === 'grid' ? 4 : 3
  };
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * Přetahování vodítka.
 *
 * `from` je tvar, jak vypadal před začátkem tažení, a posun se počítá vždy
 * proti `startX`/`startY`, ne proti minulé poloze myši. Přičítat rozdíly
 * po krocích znamená, že se chyby zaokrouhlení sčítají a vodítko po
 * několika taženích uteče od kurzoru.
 */
type Drag = { id: string; from: ShootOverlay; startX: number; startY: number; x: number; y: number };

export default function ShootView({
  frame, stream, media, ghost, ghostUrl, overlay, fix, tool, color, lineWidth,
  selected, onSelect, onAdd, onChange, onPickWhite, onAspect
}: {
  /** Adresa blobu s posledním snímkem náhledu, nebo prázdné. */
  frame: string;
  /**
   * Obraz z webkamery. Fotoaparát v režimu webkamery posílá souvislý proud,
   * ne jednotlivé snímky — vykreslit ho jako `<video>` je plynulejší i
   * levnější než skládat ho z obrázků, a vodítka i průsvitka nad ním
   * fungují stejně.
   */
  stream: MediaStream | null;
  /** Odkaz na prvek s obrazem; focení z webkamery z něj bere snímek. */
  media?: React.MutableRefObject<HTMLVideoElement | null>;
  ghost: ShootGhost;
  /**
   * Průsvitka jako adresa blobu. Soubor z disku se do okna nedostane
   * adresou — `file://` je v obsahové politice zakázané a povolit ho kvůli
   * jednomu obrázku by otevřelo celý disk. Bajty proto projdou kanálem.
   */
  ghostUrl: string;
  overlay: ShootOverlay[];
  fix: ShootFix;
  tool: Tool;
  color: string;
  lineWidth: number;
  selected: string;
  onSelect: (id: string) => void;
  onAdd: (shape: ShootOverlay) => void;
  /** Posunuté vodítko — volá se až po puštění, ne při každém pohybu myši. */
  onChange: (shape: ShootOverlay) => void;
  onPickWhite: (rgb: string) => void;
  onAspect?: (ratio: number) => void;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  const [draft, setDraft] = useState<ShootOverlay | null>(null);
  const [ratio, setRatio] = useState(3 / 2);
  /*
   * Přesouvané vodítko se drží stranou a do focení se zapíše až po
   * puštění. Ukládat ho při každém pohybu myši by znamenalo stovku zápisů
   * do databáze na jedno přetažení a trhaný pohyb.
   */
  const [drag, setDrag] = useState<Drag | null>(null);

  /*
   * Poměr stran se drží podle obrazu, aby se vodítka nemusela přepočítávat
   * na „kam se obraz uvnitř rámu vešel". Rám má tvar obrazu, takže podíl
   * 0–1 je přímo podíl rámu.
   */
  const onLoad = useCallback(() => {
    const source = stream ? video.current : image.current;
    const width = source instanceof HTMLVideoElement ? source.videoWidth : source?.naturalWidth;
    const height = source instanceof HTMLVideoElement ? source.videoHeight : source?.naturalHeight;
    if (!width || !height) return;
    const next = width / height;
    setRatio(had => (Math.abs(had - next) > 0.001 ? next : had));
    onAspect?.(next);
  }, [onAspect, stream]);

  useEffect(() => {
    const element = video.current;
    if (!element) return;
    element.srcObject = stream;
    if (media) media.current = element;
    if (stream) element.play().catch(() => { /* prohlížeč přehrávání odmítl */ });
  }, [stream, media]);

  const at = useCallback((e: React.PointerEvent): { x: number; y: number } => {
    const box = stage.current?.getBoundingClientRect();
    if (!box?.width || !box.height) return { x: 0, y: 0 };
    return {
      x: Math.max(0, Math.min(1, (e.clientX - box.left) / box.width)),
      y: Math.max(0, Math.min(1, (e.clientY - box.top) / box.height))
    };
  }, []);

  /**
   * Odečte barvu pod kurzorem.
   *
   * Náhled je `<img>`, ne plátno — pixely z něj přímo přečíst nejde. Kreslí
   * se proto do plátna až v okamžiku kliknutí; dělat to u každého snímku
   * kvůli jednomu kliknutí za focení by znamenalo překreslovat celý obraz
   * patnáctkrát za vteřinu nazmar.
   */
  const pick = useCallback((point: { x: number; y: number }) => {
    const source: HTMLImageElement | HTMLVideoElement | null = stream ? video.current : image.current;
    const width = source instanceof HTMLVideoElement ? source.videoWidth : source?.naturalWidth ?? 0;
    const height = source instanceof HTMLVideoElement ? source.videoHeight : source?.naturalHeight ?? 0;
    if (!source || !width || !height) return;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    ctx.drawImage(source, 0, 0);
    const x = Math.min(canvas.width - 1, Math.round(point.x * canvas.width));
    const y = Math.min(canvas.height - 1, Math.round(point.y * canvas.height));
    /*
     * Průměr z okolí, ne jeden pixel. Jeden pixel může být šum nebo prach na
     * papíru a podle něj by se srovnala barva celé série.
     */
    const size = 9;
    const sx = Math.max(0, x - (size >> 1));
    const sy = Math.max(0, y - (size >> 1));
    const data = ctx.getImageData(sx, sy, Math.min(size, canvas.width - sx), Math.min(size, canvas.height - sy)).data;
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < data.length; i += 4) { r += data[i]; g += data[i + 1]; b += data[i + 2]; n++; }
    if (!n) return;
    onPickWhite(`${Math.round(r / n)},${Math.round(g / n)},${Math.round(b / n)}`);
  }, [onPickWhite, stream]);

  /**
   * Posune vodítko o daný kus. Drží ho celé uvnitř obrazu.
   *
   * Kdyby se dalo vytáhnout ven, zmizelo by a zpátky by se nedalo dostat
   * jinak než smazáním a nakreslením znovu — a přesně to vodítko, které
   * se dolaďuje, je to, o které nechceš přijít.
   */
  const shift = useCallback((shape: ShootOverlay, dx: number, dy: number): ShootOverlay => {
    const whole = shape.kind === 'thirds' || shape.kind === 'grid';
    if (whole) return shape;
    if (shape.kind === 'cross') {
      return { ...shape, x: clamp01(shape.x + dx), y: clamp01(shape.y + dy) };
    }
    const left = Math.min(shape.x, shape.x2);
    const right = Math.max(shape.x, shape.x2);
    const top = Math.min(shape.y, shape.y2);
    const bottom = Math.max(shape.y, shape.y2);
    const okX = Math.max(-left, Math.min(1 - right, dx));
    const okY = Math.max(-top, Math.min(1 - bottom, dy));
    return {
      ...shape,
      x: shape.x + okX, x2: shape.x2 + okX,
      y: shape.y + okY, y2: shape.y2 + okY
    };
  }, []);

  const grab = useCallback((shape: ShootOverlay, e: React.PointerEvent) => {
    if (tool !== 'zoom') return;
    onSelect(shape.id);
    if (shape.kind === 'thirds' || shape.kind === 'grid') return;
    const point = at(e);
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    e.stopPropagation();
    setDrag({ id: shape.id, from: shape, startX: point.x, startY: point.y, x: point.x, y: point.y });
  }, [tool, onSelect, at]);

  const onDown = useCallback((e: React.PointerEvent) => {
    const point = at(e);
    if (tool === 'pick') { pick(point); return; }
    if (tool === 'zoom') { onSelect(''); return; }
    if (tool === 'cross' || tool === 'thirds' || tool === 'grid') {
      onAdd(wholeStage(tool, color, lineWidth, point));
      return;
    }
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setDraft({
      id: makeId(), kind: tool, x: point.x, y: point.y, x2: point.x, y2: point.y, color, width: lineWidth
    });
  }, [at, tool, pick, onSelect, onAdd, color, lineWidth]);

  const onMove = useCallback((e: React.PointerEvent) => {
    const point = at(e);
    if (drag) {
      setDrag(had => (had ? { ...had, x: point.x, y: point.y } : had));
      return;
    }
    if (!draft) return;
    setDraft(had => (had ? { ...had, x2: point.x, y2: point.y } : had));
  }, [draft, drag, at]);

  const onUp = useCallback(() => {
    if (drag) {
      const moved = shift(drag.from, drag.x - drag.startX, drag.y - drag.startY);
      // Klepnutí bez tažení jen vybírá; zapsat by znamenalo uložení beze změny
      if (moved.x !== drag.from.x || moved.y !== drag.from.y) onChange(moved);
      setDrag(null);
      return;
    }
    if (!draft) return;
    const tiny = Math.abs(draft.x2 - draft.x) < 0.01 && Math.abs(draft.y2 - draft.y) < 0.01;
    // Klepnutí bez tažení není tvar, ale nechtěná čárka o nulové délce
    if (!tiny) onAdd(draft);
    setDraft(null);
  }, [draft, drag, onAdd, onChange, shift]);

  useEffect(() => {
    if (tool === 'zoom') setDraft(null);
  }, [tool]);

  const dragged = drag ? shift(drag.from, drag.x - drag.startX, drag.y - drag.startY) : null;
  const shown = dragged
    ? overlay.map(one => (one.id === dragged.id ? dragged : one))
    : overlay;
  const shapes = draft ? [...shown, draft] : shown;
  const filter = cssFilter(fix);

  return (
    <div className="sh-view">
      <div
        className={`sh-stage tool-${tool}`}
        ref={stage}
        style={{ aspectRatio: String(ratio) }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        {stream
          ? (
            <video
              ref={video}
              className="sh-frame"
              muted
              playsInline
              style={filter ? { filter } : undefined}
              onLoadedMetadata={onLoad}
            />
          )
          : frame
            ? <img ref={image} className="sh-frame" src={frame} alt="" style={filter ? { filter } : undefined} onLoad={onLoad} />
            : <div className="sh-blank">Náhled neběží</div>}

        {ghostUrl && ghost.opacity > 0 && (
          <img
            className="sh-ghost"
            src={ghostUrl}
            alt=""
            style={{
              opacity: Math.max(0, Math.min(100, ghost.opacity)) / 100,
              transform: ghost.mirror ? 'scaleX(-1)' : undefined
            }}
          />
        )}

        <svg className="sh-lines" viewBox="0 0 100 100" preserveAspectRatio="none">
          {shapes.map(shape => (
            <Shape
              key={shape.id}
              shape={shape}
              on={shape.id === selected}
              movable={tool === 'zoom'}
              onGrab={e => grab(shape, e)}
            />
          ))}
        </svg>
      </div>
    </div>
  );
}

/**
 * Jeden tvar.
 *
 * Čáry mají `vectorEffect="non-scaling-stroke"`, protože `viewBox` je
 * roztažený na tvar obrazu. Bez toho by svislé čáry byly tenčí než
 * vodorovné — souřadnice se v každé ose škálují jinak.
 */
function Shape({ shape, on, movable, onGrab }: {
  shape: ShootOverlay;
  on: boolean;
  movable: boolean;
  onGrab: (e: React.PointerEvent) => void;
}) {
  const stroke = { stroke: shape.color, strokeWidth: shape.width, vectorEffect: 'non-scaling-stroke' as const };
  /*
   * Průhledná čára navíc pod tou vidět. Dvoupixelovou čáru myš netrefí —
   * přesouvalo by se až na desátý pokus. `stroke-width` v obrazových
   * jednotkách je široký pás, který se dá chytit pohodlně.
   */
  const grabArea = {
    stroke: 'transparent',
    strokeWidth: 14,
    fill: 'none',
    vectorEffect: 'non-scaling-stroke' as const
  };
  const hit = {
    className: `sh-shape ${on ? 'on' : ''} ${movable && shape.kind !== 'thirds' && shape.kind !== 'grid' ? 'movable' : ''}`,
    onPointerDown: onGrab
  };
  const p = (value: number) => value * 100;

  if (shape.kind === 'line') {
    return (
      <g {...hit}>
        <line x1={p(shape.x)} y1={p(shape.y)} x2={p(shape.x2)} y2={p(shape.y2)} {...grabArea} />
        <line x1={p(shape.x)} y1={p(shape.y)} x2={p(shape.x2)} y2={p(shape.y2)} {...stroke} fill="none" />
      </g>
    );
  }
  if (shape.kind === 'rect') {
    const x = Math.min(shape.x, shape.x2);
    const y = Math.min(shape.y, shape.y2);
    return (
      <g {...hit}>
        <rect
          x={p(x)} y={p(y)}
          width={p(Math.abs(shape.x2 - shape.x))} height={p(Math.abs(shape.y2 - shape.y))}
          {...grabArea}
        />
        <rect
          x={p(x)} y={p(y)}
          width={p(Math.abs(shape.x2 - shape.x))} height={p(Math.abs(shape.y2 - shape.y))}
          {...stroke} fill="none"
        />
      </g>
    );
  }
  if (shape.kind === 'ellipse') {
    return (
      <g {...hit}>
        <ellipse
          cx={p((shape.x + shape.x2) / 2)} cy={p((shape.y + shape.y2) / 2)}
          rx={p(Math.abs(shape.x2 - shape.x) / 2)} ry={p(Math.abs(shape.y2 - shape.y) / 2)}
          {...grabArea}
        />
        <ellipse
          cx={p((shape.x + shape.x2) / 2)} cy={p((shape.y + shape.y2) / 2)}
          rx={p(Math.abs(shape.x2 - shape.x) / 2)} ry={p(Math.abs(shape.y2 - shape.y) / 2)}
          {...stroke} fill="none"
        />
      </g>
    );
  }
  if (shape.kind === 'cross') {
    // Střed je tam, kam se posune; 0,5/0,5 je jen výchozí poloha
    const cx = p(shape.x || 0.5);
    const cy = p(shape.y || 0.5);
    return (
      <g {...hit}>
        <line x1={cx} y1={0} x2={cx} y2={100} {...grabArea} />
        <line x1={0} y1={cy} x2={100} y2={cy} {...grabArea} />
        <line x1={cx} y1={0} x2={cx} y2={100} {...stroke} />
        <line x1={0} y1={cy} x2={100} y2={cy} {...stroke} />
      </g>
    );
  }

  // Třetiny a mřížka — týž kód, liší se jen počtem dílků
  const cells = shape.kind === 'thirds' ? 3 : Math.max(2, Math.min(12, shape.cells ?? 4));
  const lines = [];
  for (let i = 1; i < cells; i++) {
    const at = (100 / cells) * i;
    lines.push(<line key={`v${i}`} x1={at} y1={0} x2={at} y2={100} {...stroke} />);
    lines.push(<line key={`h${i}`} x1={0} y1={at} x2={100} y2={at} {...stroke} />);
  }
  return <g {...hit}>{lines}</g>;
}
