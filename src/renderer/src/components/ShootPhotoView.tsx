import { useEffect, useRef, useState } from 'react';
import type { ShootPhoto } from '@shared/types';
import { api } from '../api';
import { bytesToBlob } from '../media';
import { sharpShare, SHARP_HELP } from './ShootGallery';

/**
 * Otevřená fotka přes celou obrazovku.
 *
 * ## Proč zvlášť
 *
 * Fotka se otevírá ze dvou míst — z pásu pod náhledem i z mřížky — a
 * v obou se od ní čeká totéž: zvětšit, projít šipkami, vyřadit. Dvě
 * kopie by se rozešly v tom nejhorším: v jedné by šlo zvětšovat, ve
 * druhé ne, a nikdo by nevěděl proč.
 *
 * ## Proč se dá zvětšovat
 *
 * Zmenšená do okna vypadá dobře i rozostřená fotka. Jestli je vazba
 * kravaty ostrá, se pozná až ve stoprocentním zvětšení — a když se to
 * nezjistí u stolu, zjistí se to, až bude zboží uklizené.
 */
export default function ShootPhotoView({ photo, photos, onClose, onGo, onDrop }: {
  photo: ShootPhoto;
  photos: ShootPhoto[];
  onClose: () => void;
  onGo: (photo: ShootPhoto) => void;
  onDrop?: (photo: ShootPhoto) => void;
}) {
  const [url, setUrl] = useState('');
  const [zoom, setZoom] = useState(1);
  const pan = useRef<HTMLDivElement>(null);

  useEffect(() => { setZoom(1); }, [photo.id]);

  useEffect(() => {
    let alive = true;
    let made = '';
    (async () => {
      // `view`, ne `read`: u RAW vrátí JPEG, který do souboru uložil fotoaparát
      const bytes = await api.shoot.view(photo.webp || photo.file);
      if (!alive || !bytes) return;
      made = URL.createObjectURL(bytesToBlob(bytes));
      setUrl(made);
    })();
    return () => { alive = false; if (made) URL.revokeObjectURL(made); setUrl(''); };
  }, [photo.id, photo.webp, photo.file]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key === '+' || e.key === '=') { setZoom(one => Math.min(8, one * 1.5)); return; }
      if (e.key === '-') { setZoom(one => Math.max(1, one / 1.5)); return; }
      if (e.key === '0') { setZoom(1); return; }
      const at = photos.findIndex(one => one.id === photo.id);
      if (e.key === 'ArrowRight' && at < photos.length - 1) { e.preventDefault(); onGo(photos[at + 1]); }
      if (e.key === 'ArrowLeft' && at > 0) { e.preventDefault(); onGo(photos[at - 1]); }
    };
    /*
     * Zachytává se ve fázi zachycení, aby se klávesy dostaly sem dřív než
     * do okna focení. Jinak by šipky zároveň posouvaly vodítka a mezerník
     * fotil, zatímco se člověk jen prohlíží.
     */
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [photo, photos, onClose, onGo]);

  const share = sharpShare(photo, photos);

  return (
    <div className="sh-big" onClick={onClose}>
      <div className="sh-big-inner" onClick={e => e.stopPropagation()}>
        {url
          ? (
            <div
              className={`sh-big-pan ${zoom > 1 ? 'on' : ''}`}
              ref={pan}
              onWheel={e => setZoom(one =>
                Math.max(1, Math.min(8, one * (e.deltaY < 0 ? 1.15 : 1 / 1.15))))}
            >
              <img src={url} alt="" style={{ transform: `scale(${zoom})` }} />
            </div>
          )
          : <div className="sh-blank">Načítám…</div>}
        <div className="sh-big-bar">
          <span>{fileName(photo)}</span>
          {!!share && (
            <span className="sh-big-sharp" title={SHARP_HELP}>
              ostrost {share} % nejostřejší v sérii
            </span>
          )}
          <span className="sh-big-space" />
          <button onClick={() => setZoom(one => Math.max(1, one / 1.5))} disabled={zoom <= 1}>−</button>
          <button onClick={() => setZoom(1)}>{Math.round(zoom * 100)} %</button>
          <button onClick={() => setZoom(one => Math.min(8, one * 1.5))} disabled={zoom >= 8}>+</button>
          <button onClick={() => api.shoot.reveal(photo.file)}>Ve složce</button>
          {onDrop && <button onClick={() => { onDrop(photo); onClose(); }}>Vyřadit</button>}
          <button onClick={onClose}>Zavřít</button>
        </div>
      </div>
    </div>
  );
}

function fileName(photo: ShootPhoto): string {
  const file = photo.file || photo.raw;
  return file.split(/[\\/]/).pop() || file;
}
