import { useEffect, useRef, useState } from 'react';
import type { ShootPhoto } from '@shared/types';
import { api } from '../api';
import { bytesToBlob } from '../media';
import Icon from './Icon';

/**
 * Nafocené snímky.
 *
 * ## Proč se náhledy vyrábějí v okně a ukládají do paměti
 *
 * Fotka ze zrcadlovky má dvacet megapixelů a šest megabajtů. Vykreslit
 * padesát takových jako `<img>` znamená gigabajt v paměti prohlížeče a
 * náhled se u toho začne sekat — přesně ve chvíli, kdy se fotí. Z každé
 * se proto jednou udělá zmenšenina, drží se jen ta a plná fotka se načte
 * až při zvětšení.
 *
 * ## Proč se hotové náhledy nezahazují při každém překreslení
 *
 * Seznam se překresluje po každém snímku. Kdyby se náhledy vyráběly ve
 * `useEffect` bez paměti, přepočítávaly by se pořád dokola a aplikace by
 * se po dvaceti fotkách zastavila.
 */

const cache = new Map<string, string>();

async function thumbOf(photo: ShootPhoto): Promise<string> {
  const had = cache.get(photo.id);
  if (had) return had;
  const file = photo.webp || photo.file;
  if (!file) return '';
  /*
   * `view`, ne `read`: u RAW vrátí JPEG, který do souboru uložil
   * fotoaparát. Chromium CR2 ani CR3 neotevře, takže při focení do RAW
   * tu dřív zůstávala prázdná dlaždice se jménem souboru a nafocené
   * nešlo zkontrolovat, dokud se neotevřelo jinde.
   */
  const bytes = await api.shoot.view(file);
  if (!bytes) return '';
  try {
    const bitmap = await createImageBitmap(bytesToBlob(bytes));
    const side = 360;
    const k = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * k));
    canvas.height = Math.max(1, Math.round(bitmap.height * k));
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>(done => canvas.toBlob(done, 'image/jpeg', 0.8));
    if (!blob) return '';
    const url = URL.createObjectURL(blob);
    cache.set(photo.id, url);
    return url;
  } catch {
    /*
     * Ani vnořený náhled se nenašel — starší nebo neobvyklý formát.
     * Dlaždice zůstane se jménem souboru; to je pořád srozumitelnější
     * než rozbitý obrázek bez vysvětlení.
     */
    return '';
  }
}

export function forgetThumb(photoId: string): void {
  const url = cache.get(photoId);
  if (url) URL.revokeObjectURL(url);
  cache.delete(photoId);
}

/**
 * Ostrost jako podíl nejlepší fotky v sérii.
 *
 * Absolutní číslo neříká nic — závisí na tom, co je na fotce. V jednom
 * focení se ale fotí pořád totéž, takže nejlepší snímek je slušné měřítko
 * a „62 % nejlepší" už dává smysl. Hlásí se až pod dvěma třetinami;
 * blíž k sobě jsou rozdíly v kresbě, ne v zaostření.
 */
export function sharpShare(photo: ShootPhoto, photos: ShootPhoto[]): number {
  const best = Math.max(...photos.map(one => one.sharp || 0), 0);
  if (!best || !photo.sharp) return 0;
  return Math.round((photo.sharp / best) * 100);
}

const SHARP_WARN = 67;

export default function ShootGallery({ photos, onDrop, onPick, onGhost }: {
  photos: ShootPhoto[];
  onDrop: (photo: ShootPhoto) => void;
  onPick: (photo: ShootPhoto) => void;
  /** Použít fotku jako průsvitku pro další snímky */
  onGhost: (photo: ShootPhoto) => void;
}) {
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [big, setBig] = useState<ShootPhoto | null>(null);
  const [bigUrl, setBigUrl] = useState('');
  const strip = useRef<HTMLDivElement>(null);
  const count = photos.length;

  useEffect(() => {
    let alive = true;
    (async () => {
      for (const photo of photos) {
        if (thumbs[photo.id]) continue;
        const url = await thumbOf(photo);
        if (!alive) return;
        if (url) setThumbs(had => ({ ...had, [photo.id]: url }));
      }
    })();
    return () => { alive = false; };
  }, [photos, thumbs]);

  // Poslední nafocená je ta, na kterou se člověk dívá — posune se k ní sama
  useEffect(() => {
    const box = strip.current;
    if (box) box.scrollLeft = box.scrollWidth;
  }, [count]);

  useEffect(() => {
    if (!big) { setBigUrl(''); return; }
    let alive = true;
    let made = '';
    (async () => {
      const bytes = await api.shoot.view(big.webp || big.file);
      if (!alive || !bytes) return;
      made = URL.createObjectURL(bytesToBlob(bytes));
      setBigUrl(made);
    })();
    return () => { alive = false; if (made) URL.revokeObjectURL(made); };
  }, [big]);

  useEffect(() => {
    if (!big) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setBig(null); return; }
      const at = photos.findIndex(one => one.id === big.id);
      if (e.key === 'ArrowRight' && at < photos.length - 1) setBig(photos[at + 1]);
      if (e.key === 'ArrowLeft' && at > 0) setBig(photos[at - 1]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [big, photos]);

  return (
    <div className="sh-gallery">
      <div className="sh-strip" ref={strip}>
        {!photos.length && <div className="sh-empty">Zatím nic nafoceného</div>}
        {photos.map((photo, index) => (
          <div key={photo.id} className={`sh-tile ${photo.pick ? 'pick' : ''}`}>
            <button className="sh-tile-open" onClick={() => setBig(photo)} title="Zvětšit">
              {thumbs[photo.id]
                ? <img src={thumbs[photo.id]} alt="" />
                : <span className="sh-tile-raw">{fileName(photo)}</span>}
            </button>
            <span className="sh-tile-no">{index + 1}</span>
            {photo.raw && <span className="sh-tile-raw-tag">RAW</span>}
            {(() => {
              const share = sharpShare(photo, photos);
              const soft = !!share && share < SHARP_WARN;
              const blown = photo.clipped >= 1;
              if (!soft && !blown) return null;
              return (
                <span
                  className="sh-tile-warn"
                  title={[
                    soft ? `Ostrost ${share} % nejlepší v sérii — nejspíš mimo zaostření` : '',
                    blown ? `Přepálená barva na ${photo.clipped.toFixed(1)} % plochy` : ''
                  ].filter(Boolean).join('\n')}
                >
                  <Icon name="alert" size={11} />
                  {soft ? `${share} %` : 'přepal'}
                </span>
              );
            })()}
            <div className="sh-tile-acts">
              <button
                onClick={() => onPick(photo)}
                className={photo.pick ? 'on' : ''}
                title={photo.pick ? 'Vybraná pro e-shop' : 'Označit jako vybranou'}
              >
                <Icon name="star" size={13} />
              </button>
              <button onClick={() => onGhost(photo)} title="Použít jako průsvitku">
                <Icon name="copy" size={13} />
              </button>
              <button onClick={() => api.shoot.reveal(photo.file)} title="Ukázat ve složce">
                <Icon name="folder" size={13} />
              </button>
              <button onClick={() => onDrop(photo)} title="Vyřadit z focení (soubor jde do koše)">
                <Icon name="trash" size={13} />
              </button>
            </div>
          </div>
        ))}
      </div>

      {big && (
        <div className="sh-big" onClick={() => setBig(null)}>
          <div className="sh-big-inner" onClick={e => e.stopPropagation()}>
            {bigUrl ? <img src={bigUrl} alt="" /> : <div className="sh-blank">Načítám…</div>}
            <div className="sh-big-bar">
              <span>{fileName(big)}</span>
              <span className="sh-big-space" />
              <button onClick={() => api.shoot.reveal(big.file)}>Ve složce</button>
              <button onClick={() => { onDrop(big); setBig(null); }}>Vyřadit</button>
              <button onClick={() => setBig(null)}>Zavřít</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function fileName(photo: ShootPhoto): string {
  const file = photo.file || photo.raw;
  return file.split(/[\\/]/).pop() || file;
}
