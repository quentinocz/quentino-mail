import { useCallback, useEffect, useRef, useState } from 'react';
import type { ShootOverlay, ShootGhost, ShootFix, ShootCrop } from '@shared/types';
import { cssFilter, lockRatio, ratioValue } from '../shoot/fix';

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

export type Tool = 'zoom' | 'line' | 'rect' | 'ellipse' | 'cross' | 'thirds' | 'grid'
  | 'pick' | 'crop';

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

function p(value: number): number {
  return value * 100;
}

/** Rámeček tažený zprava doleva má zápornou šířku — srovná se na kladnou. */
function normalize(box: { x: number; y: number; w: number; h: number }):
  { x: number; y: number; w: number; h: number } {
  const x = box.w < 0 ? box.x + box.w : box.x;
  const y = box.h < 0 ? box.y + box.h : box.y;
  const w = Math.abs(box.w);
  const h = Math.abs(box.h);
  return {
    x: clamp01(x), y: clamp01(y),
    w: Math.min(w, 1 - clamp01(x)), h: Math.min(h, 1 - clamp01(y))
  };
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
  frame, stream, media, ghost, ghostUrl, overlay, fix, crop, tool, color, lineWidth,
  selected, onSelect, onAdd, onChange, onCrop, onPickWhite, onAspect
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
  crop: ShootCrop;
  onCrop: (box: { x: number; y: number; w: number; h: number }) => void;
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
  /** Rozdělaný ořez. Do focení se zapíše až po puštění, jako u vodítek. */
  const [cropDraft, setCropDraft] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const zebra = useRef<HTMLCanvasElement>(null);

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
    if (tool === 'crop') {
      (e.target as Element).setPointerCapture?.(e.pointerId);
      setCropDraft({ x: point.x, y: point.y, w: 0, h: 0 });
      return;
    }
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
    if (cropDraft) {
      /*
       * Drží se počátek a rozdíl, ne srovnaný rámeček. Tažením doleva nebo
       * nahoru vyjde záporná šířka — srovnává se až při zápisu (`normalize`),
       * aby se počátek tažení nikdy neposunul pod rukou.
       */
      setCropDraft(had => (had ? { ...had, w: point.x - had.x, h: point.y - had.y } : had));
      return;
    }
    if (drag) {
      setDrag(had => (had ? { ...had, x: point.x, y: point.y } : had));
      return;
    }
    if (!draft) return;
    setDraft(had => (had ? { ...had, x2: point.x, y2: point.y } : had));
  }, [draft, drag, cropDraft, at]);

  const onUp = useCallback(() => {
    if (cropDraft) {
      const box = lockRatio(normalize(cropDraft), ratioValue(crop.ratio), ratio);
      // Klepnutí bez tažení ořez nemění — jinak by jedno kliknutí zrušilo nastavený výřez
      if (box.w > 0.02 && box.h > 0.02) onCrop(box);
      setCropDraft(null);
      return;
    }
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
  }, [draft, drag, cropDraft, onAdd, onChange, onCrop, shift, crop.ratio, ratio]);

  useEffect(() => {
    if (tool === 'zoom') setDraft(null);
  }, [tool]);

  /**
   * Zebra přes přepálená místa.
   *
   * Kreslí se na zmenšeném plátně, ne v plném rozlišení náhledu: rozhoduje,
   * **kde** přepal je, ne jak přesně je velký, a čtyřnásobně méně bodů
   * znamená, že se náhled kvůli kontrole nezačne trhat.
   *
   * Šikmé pruhy, ne plná barva — přes plnou by nebylo vidět, co se pod ní
   * přepaluje, a tím by kontrola ztratila smysl.
   */
  useEffect(() => {
    const canvas = zebra.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    if (!fix.zebra) { ctx.clearRect(0, 0, canvas.width, canvas.height); return; }
    const source: HTMLImageElement | HTMLVideoElement | null = stream ? video.current : image.current;
    const wide = source instanceof HTMLVideoElement ? source.videoWidth : source?.naturalWidth ?? 0;
    const tall = source instanceof HTMLVideoElement ? source.videoHeight : source?.naturalHeight ?? 0;
    if (!source || !wide || !tall) return;

    const k = Math.min(1, 480 / wide);
    canvas.width = Math.max(1, Math.round(wide * k));
    canvas.height = Math.max(1, Math.round(tall * k));
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);

    const level = Math.max(0, Math.min(255, fix.zebraLevel ?? 250));
    const picture = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = picture.data;
    for (let y = 0, i = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++, i += 4) {
        const top = Math.max(data[i], data[i + 1], data[i + 2]);
        // Šikmý pruh každých osm bodů; mezi nimi je vidět obraz
        const stripe = ((x + y) % 8) < 4;
        if (top >= level && stripe) {
          data[i] = 255; data[i + 1] = 40; data[i + 2] = 90; data[i + 3] = 235;
        } else {
          data[i + 3] = 0;
        }
      }
    }
    ctx.putImageData(picture, 0, 0);
  }, [frame, stream, fix.zebra, fix.zebraLevel]);

  const dragged = drag ? shift(drag.from, drag.x - drag.startX, drag.y - drag.startY) : null;
  const shown = dragged
    ? overlay.map(one => (one.id === dragged.id ? dragged : one))
    : overlay;
  const shapes = draft ? [...shown, draft] : shown;
  const filter = cssFilter(fix);
  /*
   * Zámek poměru se uplatňuje **už při tažení**, ne až po puštění. Jinak
   * se táhne obdélník, po puštění skočí na čtverec a výřez je jinde, než
   * kam se mířilo — a musí se táhnout znovu.
   */
  const box = cropDraft
    ? lockRatio(normalize(cropDraft), ratioValue(crop.ratio), ratio)
    : crop;
  const showCrop = crop.on || !!cropDraft;

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

        <canvas className={`sh-zebra ${fix.zebra ? 'on' : ''}`} ref={zebra} />

        {showCrop && (
          <svg className="sh-crop" viewBox="0 0 100 100" preserveAspectRatio="none">
            {/*
              * Ztmavení okolo ořezu, ne jen rámeček. Na obrázku s bílým
              * pozadím se tenká čára ztratí a nebylo by poznat, co z fotky
              * doopravdy zbude.
              */}
            <path
              d={`M0,0 H100 V100 H0 Z M${p(box.x)},${p(box.y)} v${p(box.h)} h${p(box.w)} v${-p(box.h)} Z`}
              fill="rgba(0,0,0,.55)"
              fillRule="evenodd"
            />
            <rect
              x={p(box.x)} y={p(box.y)} width={p(box.w)} height={p(box.h)}
              fill="none" stroke="#fff" strokeWidth={1.5} vectorEffect="non-scaling-stroke"
            />
          </svg>
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
