import { useEffect, useRef, useState } from 'react';
import type { ShootPhoto } from '@shared/types';
import { api } from '../api';
import { bytesToBlob } from '../media';
import Icon from './Icon';
import ShootPhotoView from './ShootPhotoView';

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
/**
 * Fotky, ze kterých se náhled vyrobit nepodařilo.
 *
 * Bez tohohle seznamu se u nich zkouší znovu při každém překreslení —
 * a každý pokus je čtení pětadvacetimegabajtového RAWu a průchod celým
 * souborem v hlavním procesu. Při focení do RAW se tím náhled zasekával
 * po každém snímku tím víc, čím víc fotek v sérii bylo.
 */
const failed = new Set<string>();

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
  failed.delete(photoId);
}

/**
 * Uklidí náhledy fotek, které už nejsou na obrazovce.
 *
 * Adresy blobů drží dekódovaný obrázek v paměti, dokud se neuvolní. Při
 * přepínání mezi foceními se jinak za den nasbírají stovky obrázků, které
 * už nikdo neuvidí.
 */
export function keepOnly(ids: Set<string>): void {
  for (const [id, url] of [...cache]) {
    if (ids.has(id)) continue;
    URL.revokeObjectURL(url);
    cache.delete(id);
    failed.delete(id);
  }
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

/** Vysvětlení k procentům u dlaždice. Bez něj to číslo nic neříká. */
export const SHARP_HELP = 'Ostrost se porovnává uvnitř jednoho focení: 100 % má '
  + 'nejostřejší snímek série, ostatní podíl z něj. Samotné číslo nic neznamená — '
  + 'závisí na tom, co je na fotce — ale v sérii, kde se fotí pořád totéž, '
  + 'označuje nejnižší hodnota nejhůř zaostřený kus.';

export default function ShootGallery({ photos, working, onDrop, onPick, onGhost }: {
  photos: ShootPhoto[];
  /**
   * Snímek se právě fotí nebo zpracovává.
   *
   * Mezi zmáčknutím spouště a fotkou v pásu je u zrcadlovky několik vteřin
   * — tělo fotí, stahuje po USB a okno z toho pak počítá ostrost a dělá
   * oříznutou kopii. Bez čekající dlaždice to vypadá, že se nestalo nic,
   * a spoušť se zmáčkne podruhé.
   */
  working: boolean;
  onDrop: (photo: ShootPhoto) => void;
  onPick: (photo: ShootPhoto) => void;
  /** Použít fotku jako průsvitku pro další snímky */
  onGhost: (photo: ShootPhoto) => void;
}) {
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [big, setBig] = useState<ShootPhoto | null>(null);

  const strip = useRef<HTMLDivElement>(null);
  const count = photos.length;

  /*
   * Seznam fotek se v závislostech drží podle **identit**, ne podle pole:
   * `photos` je nové pole při každém překreslení a s ním v závislostech
   * se efekt spouštěl pořád dokola.
   */
  const ids = photos.map(one => one.id).join(',');

  useEffect(() => {
    let alive = true;
    (async () => {
      for (const photo of photos) {
        if (cache.has(photo.id) || failed.has(photo.id)) continue;
        const url = await thumbOf(photo);
        if (!alive) return;
        // Neúspěch se zapíše taky — jinak se to u něj zkouší při každém překreslení
        if (url) setThumbs(had => ({ ...had, [photo.id]: url }));
        else failed.add(photo.id);
      }
      if (alive) setThumbs(had => ({ ...had, ...Object.fromEntries(cache) }));
    })();
    return () => { alive = false; };
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [ids]);

  // Náhledy fotek z jiných focení se uvolní; jinak se v paměti hromadí celý den
  useEffect(() => {
    keepOnly(new Set(photos.map(one => one.id)));
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [ids]);

  // Poslední nafocená je ta, na kterou se člověk dívá — posune se k ní sama
  useEffect(() => {
    const box = strip.current;
    if (box) box.scrollLeft = box.scrollWidth;
  }, [count]);

  return (
    <div className="sh-gallery">
      <div className="sh-strip" ref={strip}>
        {!photos.length && !working && <div className="sh-empty">Zatím nic nafoceného</div>}
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
                    soft ? `Ostrost ${share} % nejostřejší fotky v této sérii — nejspíš mimo zaostření.` : '',
                    blown ? `Přepálená barva na ${photo.clipped.toFixed(1)} % plochy.` : '',
                    soft ? SHARP_HELP : ''
                  ].filter(Boolean).join('\n\n')}
                >
                  <Icon name="alert" size={11} />
                  {soft ? `ostrost ${share} %` : 'přepal'}
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
      {working && (
          <div className="sh-tile sh-tile-wait" title="Fotí se a stahuje z těla">
            <span className="sh-spin" />
            <small>Stahuji…</small>
          </div>
        )}
      </div>

      {big && (
        <ShootPhotoView
          photo={big}
          photos={photos}
          onClose={() => setBig(null)}
          onGo={setBig}
          onDrop={onDrop}
        />
      )}
    </div>
  );
}

function fileName(photo: ShootPhoto): string {
  const file = photo.file || photo.raw;
  return file.split(/[\\/]/).pop() || file;
}
