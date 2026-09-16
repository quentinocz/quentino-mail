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
export function wholeStage(kind: 'cross' | 'thirds' | 'grid', color: string, width: number): ShootOverlay {
  return { id: makeId(), kind, x: 0, y: 0, x2: 1, y2: 1, color, width, cells: kind === 'grid' ? 4 : 3 };
}

export default function ShootView({
  frame, stream, media, ghost, ghostUrl, overlay, fix, tool, color, lineWidth,
  selected, onSelect, onAdd, onPickWhite, onAspect
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
  onPickWhite: (rgb: string) => void;
  onAspect?: (ratio: number) => void;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  const [draft, setDraft] = useState<ShootOverlay | null>(null);
  const [ratio, setRatio] = useState(3 / 2);

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

  const onDown = useCallback((e: React.PointerEvent) => {
    const point = at(e);
    if (tool === 'pick') { pick(point); return; }
    if (tool === 'zoom') { onSelect(''); return; }
    if (tool === 'cross' || tool === 'thirds' || tool === 'grid') {
      onAdd(wholeStage(tool, color, lineWidth));
      return;
    }
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setDraft({
      id: makeId(), kind: tool, x: point.x, y: point.y, x2: point.x, y2: point.y, color, width: lineWidth
    });
  }, [at, tool, pick, onSelect, onAdd, color, lineWidth]);

  const onMove = useCallback((e: React.PointerEvent) => {
    if (!draft) return;
    const point = at(e);
    setDraft(had => (had ? { ...had, x2: point.x, y2: point.y } : had));
  }, [draft, at]);

  const onUp = useCallback(() => {
    if (!draft) return;
    const tiny = Math.abs(draft.x2 - draft.x) < 0.01 && Math.abs(draft.y2 - draft.y) < 0.01;
    // Klepnutí bez tažení není tvar, ale nechtěná čárka o nulové délce
    if (!tiny) onAdd(draft);
    setDraft(null);
  }, [draft, onAdd]);

  useEffect(() => {
    if (tool === 'zoom') setDraft(null);
  }, [tool]);

  const shapes = draft ? [...overlay, draft] : overlay;
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
              onPick={() => { if (tool === 'zoom') onSelect(shape.id); }}
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
function Shape({ shape, on, onPick }: { shape: ShootOverlay; on: boolean; onPick: () => void }) {
  const stroke = { stroke: shape.color, strokeWidth: shape.width, vectorEffect: 'non-scaling-stroke' as const };
  const hit = { className: `sh-shape ${on ? 'on' : ''}`, onPointerDown: onPick };
  const p = (value: number) => value * 100;

  if (shape.kind === 'line') {
    return (
      <g {...hit}>
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
          {...stroke} fill="none"
        />
      </g>
    );
  }
  if (shape.kind === 'cross') {
    return (
      <g {...hit}>
        <line x1={50} y1={0} x2={50} y2={100} {...stroke} />
        <line x1={0} y1={50} x2={100} y2={50} {...stroke} />
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
