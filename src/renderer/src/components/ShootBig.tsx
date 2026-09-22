import { useEffect, useRef, useState } from 'react';
import type { ShootPhoto, ShootSecond, Shoot } from '@shared/types';
import { api } from '../api';
import { bytesToBlob } from '../media';
import { cssFilter } from '../shoot/fix';
import ShootGrid from './ShootGrid';

/**
 * Obsah velké obrazovky u stolu s fotoaparátem.
 *
 * Přes celou plochu je jedna věc — buď živý náhled, nebo mřížka
 * nafoceného — a nic se tu neovládá: u stolu se drží fotoaparát, ne myš.
 * Přepíná se z okna aplikace, které vždycky ukazuje to druhé.
 *
 * Vodítka se sem schválně **nekreslí**. Na velkou obrazovku se člověk
 * dívá kvůli tomu, jak produkt vypadá; čáry přes něj jsou k míření
 * v okně, kde se skládá záběr.
 */
export default function ShootBig() {
  const [mode, setMode] = useState<ShootSecond['mode']>('live');
  /**
   * Která fotka je velká. Prázdné = ta poslední vyfocená.
   *
   * Po každém snímku se vrací na prázdno: u stolu se fotí a kouká se na
   * to, co právě cvaklo. Konkrétní fotku pošle okno aplikace, když si ji
   * člověk vybere v pásu — a ta platí, dokud nepřijde další snímek.
   */
  const [photoId, setPhotoId] = useState('');
  const [tile, setTile] = useState(220);
  const [frame, setFrame] = useState('');
  const [photos, setPhotos] = useState<ShootPhoto[]>([]);
  const [shoot, setShoot] = useState<Shoot | null>(null);
  /**
   * Obraz z webkamery si tahle obrazovka otevírá sama.
   *
   * Proud z `getUserMedia` se mezi okny poslat nedá — je to živé spojení
   * s ovladačem, ne data. Z okna aplikace proto přijde jen to, které
   * zařízení to je, a obraz se otevře znovu tady. Bez toho tu při focení
   * přes webkameru svítilo „Náhled neběží" u kamery, která běžela.
   */
  const [webcam, setWebcam] = useState('');
  const [webcamLabel, setWebcamLabel] = useState('');
  const [failed, setFailed] = useState('');
  const stream = useRef<MediaStream | null>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  const last = useRef('');

  useEffect(() => {
    api.shoot.secondState().then(one => {
      setMode(one.mode);
      setTile(one.tile);
      setPhotoId(one.photoId || '');
      setWebcam(one.webcam || '');
      setWebcamLabel(one.webcamLabel || '');
    });
  }, []);

  useEffect(() => api.on('shoot:second', (one: ShootSecond) => {
    setMode(one.mode);
    setTile(one.tile);
    setPhotoId(one.photoId || '');
    setWebcam(one.webcam || '');
    setWebcamLabel(one.webcamLabel || '');
  }), []);

  useEffect(() => {
    let alive = true;
    stream.current?.getTracks().forEach(track => track.stop());
    stream.current = null;
    setFailed('');
    if (!webcam) return;
    (async () => {
      const size = { width: { ideal: 3840 }, height: { ideal: 2160 } };
      const open = (id: string) => navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: id }, ...size }
      });

      let got: MediaStream | null = null;
      try {
        got = await open(webcam);
      } catch {
        /*
         * Chromium čísluje zařízení zvlášť pro každé okno, takže `deviceId`
         * z okna aplikace tady neplatí a skončí na `OverconstrainedError`.
         * Dohledá se proto podle názvu — ten je to jediné, co mezi okny
         * přenese. Bez tohohle tu při focení přes webkameru svítilo
         * „Náhled neběží" u kamery, která běžela.
         */
        try {
          const all = await navigator.mediaDevices.enumerateDevices();
          const hit = all.find(one => one.kind === 'videoinput' && one.label === webcamLabel)
            ?? all.find(one => one.kind === 'videoinput');
          if (hit) got = await open(hit.deviceId);
        } catch { got = null; }
      }

      if (!alive) { got?.getTracks().forEach(track => track.stop()); return; }
      if (!got) {
        setFailed('Kameru se nepodařilo otevřít. Přepni velkou obrazovku na mřížku.');
        return;
      }
      stream.current = got;
      if (video.current) {
        video.current.srcObject = got;
        video.current.play().catch(() => { /* prohlížeč odmítl */ });
      }
    })();
    return () => {
      alive = false;
      stream.current?.getTracks().forEach(track => track.stop());
      stream.current = null;
    };
  }, [webcam, webcamLabel]);

  /*
   * Snímek náhledu chodí jako bajty; předchozí adresa se hned uvolní.
   * Bez toho by za hodinu focení leželo v paměti padesát tisíc obrázků.
   */
  useEffect(() => api.on('shoot:frame', (bytes: Uint8Array) => {
    const url = URL.createObjectURL(bytesToBlob(bytes, 'image/jpeg'));
    const had = last.current;
    last.current = url;
    setFrame(url);
    if (had) URL.revokeObjectURL(had);
  }), []);

  useEffect(() => () => { if (last.current) URL.revokeObjectURL(last.current); }, []);

  const load = async (id: string) => {
    if (!id) { setShoot(null); setPhotos([]); return; }
    setShoot(await api.shoot.shoot(id));
    setPhotos(await api.shoot.photos(id));
  };

  useEffect(() => { api.shoot.current().then(load); }, []);
  useEffect(() => api.on('shoot:current', (id: string) => { load(id); }), []);
  useEffect(() => api.on('shoot:photo', (photo: ShootPhoto) => {
    setPhotos(list => (list.some(one => one.id === photo.id) ? list : [...list, photo]));
    // Nový snímek přebíjí vybranou fotku — u stolu se kouká na to, co cvaklo
    setPhotoId('');
  }), []);

  const filter = shoot ? cssFilter(shoot.fix) : '';

  /*
   * Jedna fotka přes celou plochu.
   *
   * Mřížka odpoví na otázku „mají všechny kusy stejný výřez a světlo",
   * ale na „je tahle ostrá" ne — na to je potřeba fotka velká. U stolu
   * se přitom po každém snímku kouká právě na tohle, takže se ukazuje
   * poslední vyfocená sama; jinou pošle okno aplikace z pásu pod náhledem.
   */
  if (mode === 'photo') {
    const chosen = photos.find(one => one.id === photoId) ?? photos[photos.length - 1] ?? null;
    return (
      <div className="sh-big-screen photo">
        {chosen
          ? <BigPhoto photo={chosen} index={photos.indexOf(chosen) + 1} count={photos.length} />
          : <div className="sh-blank">Zatím nic nafoceného</div>}
      </div>
    );
  }

  if (mode === 'grid') {
    return (
      <div className="sh-big-screen">
        <ShootGrid photos={photos} tile={tile} big />
      </div>
    );
  }

  return (
    <div className="sh-big-screen live">
      {webcam
        ? (
          <>
            <video
              ref={video}
              muted
              playsInline
              style={filter ? { filter } : undefined}
              onLoadedMetadata={e => e.currentTarget.play().catch(() => { /* odmítnuto */ })}
            />
            {failed && <div className="sh-blank">{failed}</div>}
          </>
        )
        : frame
          ? <img src={frame} alt="" style={filter ? { filter } : undefined} />
          : <div className="sh-blank">Náhled neběží</div>}
    </div>
  );
}

/**
 * Jedna fotka na velké obrazovce.
 *
 * Kreslí se z celého souboru, ne ze zmenšeniny: kvůli téhle obrazovce se
 * kouká na ostrost a ta je na zmenšenině vždycky v pořádku. Adresa se
 * uvolňuje při každé změně — při sérii dvaceti kusů by jinak v paměti
 * zůstalo dvacet plnohodnotných fotek.
 */
function BigPhoto({ photo, index, count }: { photo: ShootPhoto; index: number; count: number }) {
  const [url, setUrl] = useState('');

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

  const name = (photo.file || photo.raw).split(/[\\/]/).pop() || '';
  return (
    <>
      {url ? <img src={url} alt="" /> : <div className="sh-blank">Načítám…</div>}
      {/* Kolikátá to je a jak se jmenuje — jinak se u stolu nepozná, na co se kouká */}
      <span className="sh-big-tag">{index} / {count} · {name}</span>
    </>
  );
}
