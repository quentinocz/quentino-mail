import { useCallback, useEffect, useRef, useState } from 'react';
import type { MediaProductSetup, MediaSetup } from '@shared/types';
import { bytesToBlob, targetSize, toWebp } from '../media';
import { api } from '../api';
import Icon from './Icon';

/**
 * Srovnání originálu a WebP vedle sebe.
 *
 * ## Proč to musí být vedle sebe a přiblížené naráz
 *
 * Rozdíl mezi kvalitou 78 a 86 není na celé fotce vidět. Pozná se na jednom
 * místě — na vazbě látky, na přechodu v pozadí, na jemném písmu štítku —
 * a jen tehdy, když se obojí ukáže **ve stejném výřezu a stejně velké**.
 * Přepínat mezi dvěma okny a hledat pokaždé totéž místo znamená, že se to
 * neudělá a kvalita se nastaví od oka.
 *
 * Oba pohledy proto sdílejí jedno přiblížení i posun. Fotky se do svého
 * rámečku nejdřív vejdou celé (originál i výsledek jsou tedy stejně velké,
 * i když má výsledek méně pixelů) a společná lupa se počítá až nad tím.
 * Kdyby se srovnávaly v původních rozměrech, byl by výsledek menší a
 * rozdíl by šel na vrub zmenšení, ne komprese.
 *
 * ## Proč se tady dá měnit nastavení
 *
 * Protože právě tady se pozná, jestli sedí. Nastavení se ukládá u produktu:
 * fotka s jemnou strukturou látky snese míň komprese než rovná plocha, a
 * kdyby změna platila jen do zavření okna, druhý pokus o tentýž produkt by
 * dopadl jinak než ten první.
 */

interface Props {
  code: string;
  /** Adresa fotky na e-shopu — originál se stahuje přes hlavní proces */
  url: string;
  name: string;
  /** Co platí teď: vlastní nastavení produktu, jinak obecné */
  rules: MediaProductSetup;
  /** Má produkt vlastní nastavení, nebo platí obecné? */
  own: boolean;
  base: MediaSetup;
  onClose: () => void;
  /** Uložit nastavení u produktu; `null` = zpátky na obecné */
  onSave: (value: MediaProductSetup | null) => void;
}

interface Shot {
  src: string;
  bytes: number;
  width: number;
  height: number;
}

function pretty(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${bytes} B`;
}

/** Násobky lupy. Nad osm už se kouká na jednotlivé pixely, ne na fotku. */
const MIN_ZOOM = 1;
const MAX_ZOOM = 8;

export default function MediaCompare(p: Props) {
  const [rules, setRules] = useState<MediaProductSetup>(p.rules);
  const [origin, setOrigin] = useState<Shot | null>(null);
  const [webp, setWebp] = useState<Shot | null>(null);
  const [error, setError] = useState('');
  const [working, setWorking] = useState(true);

  /** Společné přiblížení a posun — v podílech šířky rámečku, ne v pixelech */
  const [view, setView] = useState({ zoom: 1, x: 0.5, y: 0.5 });
  const dragging = useRef<{ x: number; y: number; box: DOMRect } | null>(null);
  /** Bajty originálu; drží se, ať se při každé změně nastavení nestahuje znovu */
  const source = useRef<Uint8Array | null>(null);
  const jobs = useRef(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') p.onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [p]);

  /** Převod podle právě nastavených pravidel. Výsledek se neukládá na disk. */
  const render = useCallback(async (bytes: Uint8Array, use: MediaProductSetup) => {
    const mine = ++jobs.current;
    setWorking(true);
    try {
      const out = await toWebp(bytes, { ...use, crop: null });
      // Mezitím se mohlo nastavení změnit znovu — starší výsledek se zahodí
      if (mine !== jobs.current) return;
      setWebp(old => {
        if (old) URL.revokeObjectURL(old.src);
        return {
          src: URL.createObjectURL(bytesToBlob(out.bytes, 'image/webp')),
          bytes: out.bytes.length, width: out.width, height: out.height
        };
      });
    } catch (e: any) {
      if (mine === jobs.current) setError(String(e?.message ?? e));
    } finally {
      if (mine === jobs.current) setWorking(false);
    }
  }, []);

  // Stažení originálu — jednou; převod se pak dělá z bajtů v paměti
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const got = await api.media.productFetch(p.code, [p.url]);
        const file = got.files[0];
        if (!file) throw new Error('fotku se nepodařilo stáhnout');
        const bytes = await api.media.read(file.path);
        if (!alive) return;
        source.current = bytes;
        const blob = bytesToBlob(bytes);
        const bitmap = await createImageBitmap(blob);
        if (!alive) { bitmap.close(); return; }
        setOrigin({
          src: URL.createObjectURL(blob), bytes: file.size,
          width: bitmap.width, height: bitmap.height
        });
        bitmap.close();
        await render(bytes, p.rules);
      } catch (e: any) {
        if (alive) { setError(String(e?.message ?? e)); setWorking(false); }
      }
    })();
    return () => { alive = false; };
    // Schválně jen při otevření: pravidla se mění samostatnou cestou níž
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.code, p.url]);

  useEffect(() => () => {
    if (origin) URL.revokeObjectURL(origin.src);
    if (webp) URL.revokeObjectURL(webp.src);
  }, [origin, webp]);

  /** Změna nastavení: překreslí se s odkladem, ať se nepřepočítává při každém pixelu posuvníku */
  const change = (patch: Partial<MediaProductSetup>) => {
    const next = { ...rules, ...patch };
    setRules(next);
    if (source.current) {
      window.clearTimeout((change as any).timer);
      (change as any).timer = window.setTimeout(() => {
        if (source.current) void render(source.current, next);
      }, 260);
    }
  };

  /*
   * Lupa se přibližuje k místu pod kurzorem, ne do středu. Jinak se hledaný
   * detail po každém kroku odsune a člověk ho honí po obrazovce.
   */
  const zoomAt = useCallback((box: DOMRect, clientX: number, clientY: number, up: boolean) => {
    setView(now => {
      const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, now.zoom * (up ? 1.15 : 1 / 1.15)));
      if (zoom === now.zoom) return now;
      if (zoom === 1) return { zoom: 1, x: 0.5, y: 0.5 };
      const px = (clientX - box.left) / box.width;
      const py = (clientY - box.top) / box.height;
      // Bod pod kurzorem má po změně přiblížení zůstat pod kurzorem
      const x = now.x + (px - 0.5) * (1 / now.zoom - 1 / zoom);
      const y = now.y + (py - 0.5) * (1 / now.zoom - 1 / zoom);
      return { zoom, x: clampMid(x, zoom), y: clampMid(y, zoom) };
    });
  }, []);

  /*
   * Kolečko se věší napřímo, ne přes `onWheel`.
   *
   * React si posluchače `wheel` drží na kořeni stránky jako **pasivní**,
   * takže `preventDefault` v něm nic neudělá — a stránka pod oknem by se
   * při přibližování rolovala. Vlastní posluchač s `passive: false` je
   * jediná cesta, jak kolečko opravdu zachytit.
   */
  const paneRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      zoomAt(node.getBoundingClientRect(), e.clientX, e.clientY, e.deltaY < 0);
    };
    node.addEventListener('wheel', handler, { passive: false });
  }, [zoomAt]);

  const onDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (view.zoom <= 1) return;
    dragging.current = { x: e.clientX, y: e.clientY, box: e.currentTarget.getBoundingClientRect() };
  };

  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const drag = dragging.current;
    if (!drag) return;
    const dx = (e.clientX - drag.x) / drag.box.width / view.zoom;
    const dy = (e.clientY - drag.y) / drag.box.height / view.zoom;
    dragging.current = { ...drag, x: e.clientX, y: e.clientY };
    setView(now => ({
      zoom: now.zoom,
      x: clampMid(now.x - dx, now.zoom),
      y: clampMid(now.y - dy, now.zoom)
    }));
  };

  const endDrag = () => { dragging.current = null; };

  const saved = origin && webp ? origin.bytes - webp.bytes : 0;
  const target = origin ? targetSize(origin.width, origin.height, rules) : null;
  const changed = JSON.stringify(rules) !== JSON.stringify(p.rules);

  return (
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) p.onClose(); }}>
      <div className="modal mc-modal">
        <div className="modal-head">
          <span className="modal-title"><Icon name="image" size={15} /> Před a po — {p.name}</span>
          <span style={{ flex: 1 }} />
          <div className="mc-zoom">
            <button className="btn ghost" onClick={() => setView({ zoom: 1, x: 0.5, y: 0.5 })}
              disabled={view.zoom === 1}>Celá fotka</button>
            {[2, 4, 8].map(z => (
              <button key={z} className={`btn ghost ${Math.abs(view.zoom - z) < 0.01 ? 'on' : ''}`}
                onClick={() => setView(now => ({ ...now, zoom: z }))}>{z}×</button>
            ))}
          </div>
          <button className="icon-btn" onClick={p.onClose}><Icon name="x" size={16} /></button>
        </div>

        {error && <p className="md-warn"><Icon name="alert" size={13} /> {error}</p>}

        <div className="mc-panes">
          {[{ shot: origin, label: 'Originál' }, { shot: webp, label: 'WebP' }].map(pane => (
            <div className="mc-pane" key={pane.label}>
              <header>
                <b>{pane.label}</b>
                {pane.shot && (
                  <small className="desc">
                    {pane.shot.width}×{pane.shot.height} px · {pretty(pane.shot.bytes)}
                  </small>
                )}
              </header>
              {/*
                * Při velkém přiblížení se mají ukázat pixely, ne domyšlené
                * mezihodnoty — jinak by prohlížeč rozmazal právě ty artefakty,
                * kvůli kterým se sem kouká. Při pohledu na celou fotku by ale
                * totéž zbytečně zdrsnilo zmenšený obraz.
                */}
              <div ref={paneRef}
                className={`mc-view ${view.zoom > 1 ? 'grab' : ''} ${view.zoom >= 2 ? 'raw' : ''}`}
                onMouseDown={onDown} onMouseMove={onMove}
                onMouseUp={endDrag} onMouseLeave={endDrag}>
                {pane.shot
                  ? (
                    /*
                     * Nejdřív se posune sledovaný bod do středu rámečku, teprve
                     * pak se přiblíží. Opačné pořadí by lupu zvětšovalo kolem
                     * středu fotky a sledované místo by při každém kroku
                     * uteklo jinam.
                     */
                    <img src={pane.shot.src} alt="" draggable={false} style={{
                      transform: `scale(${view.zoom}) `
                        + `translate(${(0.5 - view.x) * 100}%, ${(0.5 - view.y) * 100}%)`
                    }} />
                  )
                  : <span className="mc-wait"><span className="spinner-inline" /></span>}
                {pane.label === 'WebP' && working && pane.shot && (
                  <span className="mc-busy"><span className="spinner-inline" /> přepočítávám…</span>
                )}
              </div>
            </div>
          ))}
        </div>

        <p className="desc mc-hint">
          {view.zoom > 1
            ? 'Kolečkem přiblížíš, tažením posuneš — obě fotky naráz.'
            : 'Kolečkem myši přiblížíš na detail. Obě fotky se hýbou zároveň, takže se kouká na totéž místo.'}
          {origin && webp && (
            <>
              {' '}Úspora <b className={saved > 0 ? 'mc-good' : 'mc-bad'}>
                {saved > 0 ? pretty(saved) : `−${pretty(-saved)}`}
              </b>
              {saved > 0 ? ` (${Math.round((1 - webp.bytes / origin.bytes) * 100)} % míň)` : ' — výsledek je větší než originál'}
              {target && ` · výsledek ${target.width}×${target.height} px`}
            </>
          )}
        </p>

        <div className="mc-setup">
          <div className="field">
            <label>Kvalita: {rules.quality}</label>
            <input type="range" min={40} max={100} value={rules.quality}
              onChange={e => change({ quality: Number(e.target.value) })} />
          </div>
          <div className="field">
            <label>Rozlišení</label>
            <select value={rules.resize} onChange={e => change({ resize: e.target.value as any })}>
              <option value="keep">Zachovat</option>
              <option value="max">Zmenšit do mezí</option>
              <option value="exact">Přesný rozměr</option>
              <option value="percent">Procenta</option>
            </select>
          </div>
          {rules.resize === 'max' && (
            <div className="field">
              <label>Nejvíc (px)</label>
              <input type="number" value={rules.maxWidth}
                onChange={e => change({
                  maxWidth: Number(e.target.value) || 0, maxHeight: Number(e.target.value) || 0
                })} />
            </div>
          )}
          {rules.resize === 'exact' && (
            <>
              <div className="field">
                <label>Šířka (px)</label>
                <input type="number" value={rules.exactWidth}
                  onChange={e => change({ exactWidth: Number(e.target.value) || 0 })} />
              </div>
              <div className="field">
                <label>Výška (px)</label>
                <input type="number" value={rules.exactHeight}
                  onChange={e => change({ exactHeight: Number(e.target.value) || 0 })} />
              </div>
            </>
          )}
          {rules.resize === 'percent' && (
            <div className="field">
              <label>Procenta</label>
              <input type="number" value={rules.percent}
                onChange={e => change({ percent: Number(e.target.value) || 0 })} />
            </div>
          )}
        </div>

        <div className="modal-foot">
          <span className="desc">
            {p.own
              ? 'Tenhle produkt má vlastní nastavení.'
              : 'Zatím platí obecné nastavení konvertoru.'}
          </span>
          <span style={{ flex: 1 }} />
          {p.own && (
            <button className="btn ghost" onClick={() => { p.onSave(null); p.onClose(); }}>
              Vrátit na obecné
            </button>
          )}
          <button className="btn ghost" onClick={p.onClose}>Zavřít</button>
          <button className="btn primary" disabled={!changed && p.own}
            onClick={() => { p.onSave(rules); p.onClose(); }}>
            <Icon name="check" size={14} /> Použít u tohoto produktu
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Drží střed pohledu tak, aby se nekoukalo mimo fotku.
 *
 * Při přiblížení `z` je vidět `1/z` obrázku, takže střed se smí pohybovat
 * jen v prostředním pásu. Bez toho se dá fotka odtáhnout pryč a zůstane
 * prázdno — a hlavně by se obě strany rozešly v tom, na co koukají.
 */
function clampMid(value: number, zoom: number): number {
  const half = 1 / (2 * zoom);
  return Math.min(1 - half, Math.max(half, value));
}
