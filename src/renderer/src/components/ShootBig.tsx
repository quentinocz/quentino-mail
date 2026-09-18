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
  const [tile, setTile] = useState(220);
  const [frame, setFrame] = useState('');
  const [photos, setPhotos] = useState<ShootPhoto[]>([]);
  const [shoot, setShoot] = useState<Shoot | null>(null);
  const last = useRef('');

  useEffect(() => {
    api.shoot.secondState().then(one => { setMode(one.mode); setTile(one.tile); });
  }, []);

  useEffect(() => api.on('shoot:second', (one: ShootSecond) => {
    setMode(one.mode);
    setTile(one.tile);
  }), []);

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
  }), []);

  const filter = shoot ? cssFilter(shoot.fix) : '';

  if (mode === 'grid') {
    return (
      <div className="sh-big-screen">
        <ShootGrid photos={photos} tile={tile} big />
      </div>
    );
  }

  return (
    <div className="sh-big-screen live">
      {frame
        ? <img src={frame} alt="" style={filter ? { filter } : undefined} />
        : <div className="sh-blank">Náhled neběží</div>}
    </div>
  );
}
