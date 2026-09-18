import { useEffect, useState } from 'react';
import type { ShootPhoto } from '@shared/types';
import { api } from '../api';
import { bytesToBlob } from '../media';
import { sharpShare, SHARP_HELP } from './ShootGallery';
import ShootPhotoView from './ShootPhotoView';
import Icon from './Icon';

/**
 * Mřížka nafocených fotek.
 *
 * ## Proč zvlášť od pásu v okně
 *
 * Pás pod náhledem ukazuje pořadí a poslední snímek; mřížka ukazuje
 * **sérii jako celek** — jestli mají všechny kusy stejný výřez, stejné
 * světlo a stejné pozadí. To se pozná jedině tak, že jsou vedle sebe
 * dost velké, a na to je pás na pár set pixelů krátký.
 *
 * Bydlí to zvlášť, protože totéž potřebují dvě místa: velká obrazovka
 * u stolu a okno aplikace, když je na velké obrazovce živý náhled.
 *
 * ## Vlastní náhledy, ne ty z pásu
 *
 * Dlaždice tady mají být velké, takže zmenšenina z pásu by byla rozmazaná.
 * Vyrábí se proto ve větším a drží se jen tady — po zavření mřížky se
 * uvolní, aby se v paměti nehromadily dvě sady obrázků.
 */

async function bigThumb(photo: ShootPhoto, side: number): Promise<string> {
  const file = photo.webp || photo.file;
  if (!file) return '';
  const bytes = await api.shoot.view(file);
  if (!bytes) return '';
  try {
    const bitmap = await createImageBitmap(bytesToBlob(bytes));
    const k = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * k));
    canvas.height = Math.max(1, Math.round(bitmap.height * k));
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>(done => canvas.toBlob(done, 'image/jpeg', 0.85));
    canvas.width = 0;
    canvas.height = 0;
    return blob ? URL.createObjectURL(blob) : '';
  } catch {
    // RAW bez vnořeného náhledu — dlaždice zůstane se jménem souboru
    return '';
  }
}

export default function ShootGrid({ photos, tile, onTile, onDrop, big = false }: {
  photos: ShootPhoto[];
  /** Velikost dlaždice v bodech. */
  tile: number;
  /** Když chybí, mřížka velikost nenabízí — na velké obrazovce se neovládá. */
  onTile?: (size: number) => void;
  /** Vyřazení z otevřené fotky. Na velké obrazovce se nic neovládá, takže chybí. */
  onDrop?: (photo: ShootPhoto) => void;
  /** Na velké obrazovce: bez ovládání, tmavší, hustší. */
  big?: boolean;
}) {
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  /*
   * Otevřená fotka. Na velké obrazovce se neotevírá — u stolu se do ní
   * neklika a zakrytá mřížka by tam jen překážela.
   */
  const [open, setOpen] = useState<ShootPhoto | null>(null);
  const ids = photos.map(one => one.id).join(',');
  /*
   * Zmenšenina se vyrábí pro největší velikost dlaždice, ne pro tu
   * současnou. Při posouvání posuvníku by se jinak všechny fotky
   * překreslovaly znovu a u dvaceti kusů by to znamenalo číst dvacet
   * souborů při každém cvaknutí.
   */
  const side = 720;

  useEffect(() => {
    let alive = true;
    const made: string[] = [];
    (async () => {
      for (const photo of photos) {
        const url = await bigThumb(photo, side);
        if (!alive) { if (url) URL.revokeObjectURL(url); return; }
        if (!url) continue;
        made.push(url);
        setThumbs(had => ({ ...had, [photo.id]: url }));
      }
    })();
    return () => {
      alive = false;
      // Obrázky se uvolní se zavřením mřížky; jinak by v paměti ležely dvě sady
      for (const url of made) URL.revokeObjectURL(url);
      setThumbs({});
    };
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [ids]);

  return (
    <div className={`sh-grid-wrap ${big ? 'big' : ''}`}>
      {open && (
        <ShootPhotoView
          photo={open}
          photos={photos}
          onClose={() => setOpen(null)}
          onGo={setOpen}
          onDrop={onDrop}
        />
      )}
      {!!onTile && (
        <div className="sh-grid-bar">
          <Icon name="layers" size={13} />
          <span>{photos.length} {photos.length === 1 ? 'fotka' : 'fotek'}</span>
          <span className="sh-top-space" />
          <label className="sh-range">
            <Icon name="shrink" size={12} />
            <input
              type="range" min={120} max={520} step={20}
              value={tile}
              onChange={e => onTile(Number(e.target.value))}
              title="Velikost dlaždice"
            />
            <Icon name="expand" size={12} />
          </label>
        </div>
      )}
      <div
        className="sh-grid"
        style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${Math.max(80, tile)}px, 1fr))` }}
      >
        {!photos.length && <div className="sh-empty">Zatím nic nafoceného</div>}
        {photos.map((photo, index) => {
          const share = sharpShare(photo, photos);
          const soft = !!share && share < 67;
          return (
            <button
              key={photo.id}
              className={`sh-cell ${photo.pick ? 'pick' : ''} ${big ? 'still' : ''}`}
              onClick={() => { if (!big) setOpen(photo); }}
              title={soft
                ? `Ostrost ${share} % nejostřejší fotky v této sérii.\n\n${SHARP_HELP}`
                : fileName(photo)}
            >
              {thumbs[photo.id]
                ? <img src={thumbs[photo.id]} alt="" />
                : <span className="sh-cell-name">{fileName(photo)}</span>}
              <span className="sh-cell-no">{index + 1}</span>
              {soft && <span className="sh-cell-soft">ostrost {share} %</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function fileName(photo: ShootPhoto): string {
  const file = photo.file || photo.raw;
  return file.split(/[\\/]/).pop() || file;
}
