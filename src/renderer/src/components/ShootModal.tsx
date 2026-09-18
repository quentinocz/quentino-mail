import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Shoot, ShootPhoto, ShootState, ShootOverlay, ShootFix, ShootCrop, ShootSlot
} from '@shared/types';
import { api } from '../api';
import { bytesToBlob } from '../media';
import { useToast } from '../toast';
import {
  applyFix, autoFix, cssFilter, fixActive, PRESETS, preset,
  sharpness, clipping, cropBox, lockRatio, ratioValue, RATIOS
} from '../shoot/fix';
import Icon from './Icon';
import ShootView, { Tool } from './ShootView';
import ShootGallery, { forgetThumb } from './ShootGallery';
import ShootSettings from './ShootSettings';

/**
 * Focení produktů.
 *
 * ## K čemu to je
 *
 * Nafotit dvacet kravat tak, aby na e-shopu tvořily řadu, znamená mít
 * u každé stejný výřez, stejné světlo a stejné nastavení těla. Přes displej
 * fotoaparátu se to hlídá od oka a po deseti kusech se to rozjede. Tady je
 * tělo připojené k počítači, náhled přes celou obrazovku, přes něj se dá
 * nakreslit rámeček, kam produkt patří, a jako průsvitka podložit fotka
 * z minula.
 *
 * ## Proč se všechno ukládá průběžně a samo
 *
 * Focení trvá hodinu a při něm se sahá na fotoaparát, ne na klávesnici.
 * Tlačítko „Uložit" by znamenalo, že o vodítka přijde ten, kdo na něj
 * zapomene — a ten to zjistí až za týden, když se má série dofotit.
 *
 * ## Dva způsoby připojení
 *
 * **Přes gphoto2**: plné ovládání a snímky v plném rozlišení rovnou do
 * složky. **Jako webkamera**: jen náhled a snímek z něj, zato všude včetně
 * Windows, kde gphoto2 není.
 */

const COLORS = ['#37d67a', '#ff4d6d', '#ffd166', '#4dabff', '#ffffff', '#111111'];

type Panel = 'kamera' | 'vodítka' | 'barvy' | 'soubor';

/** Záběry, kterými produktové focení obvykle začíná. Jde je přepsat. */
const PLAN_START = ['Celek', 'Detail vazby', 'Rub'];

let slotSeq = 0;
function makeSlot(name: string): ShootSlot {
  return { id: `s${Date.now().toString(36)}${(slotSeq++).toString(36)}`, name };
}

export default function ShootModal({ onClose, standalone = false }: {
  onClose: () => void;
  /** Ve vlastním okně se nezavírá křížkem do aplikace, ale zavře se okno. */
  standalone?: boolean;
}) {
  const toast = useToast();
  const [state, setState] = useState<ShootState | null>(null);
  const [shoot, setShoot] = useState<Shoot | null>(null);
  const [photos, setPhotos] = useState<ShootPhoto[]>([]);
  const [frame, setFrame] = useState('');
  const [busy, setBusy] = useState('');
  const [panel, setPanel] = useState<Panel>('kamera');
  const [tool, setTool] = useState<Tool>('zoom');
  const [color, setColor] = useState(COLORS[0]);
  const [lineWidth, setLineWidth] = useState(2);
  const [selected, setSelected] = useState('');
  const [ghostUrl, setGhostUrl] = useState('');
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [cams, setCams] = useState<MediaDeviceInfo[]>([]);
  const [webcamId, setWebcamId] = useState('');
  /** Ke kterému záběru ze série patří příští snímek. */
  const [slot, setSlot] = useState('');
  /** Srovnání vedle sebe místo průsvitky přes sebe. */
  const [side, setSide] = useState(false);
  /** Poměr stran obrazu z fotoaparátu — podle něj se přepočítává zámek ořezu. */
  const [frameRatio, setFrameRatio] = useState(3 / 2);
  /**
   * Zvětšení živého náhledu.
   *
   * Náhled má osminu rozlišení snímku, takže se v něm zaostření pozná
   * špatně. Zvětšení nezlepší kvalitu obrazu, ale ukáže detail větší —
   * a na to, jestli je vazba kravaty ostrá, to stačí.
   */
  const [viewZoom, setViewZoom] = useState(1);
  const video = useRef<HTMLVideoElement | null>(null);
  const lastFrame = useRef('');

  const note = useCallback((text: string, bad = false) => {
    toast(text, bad ? 'error' : 'info');
  }, [toast]);

  /* ---------- načtení ---------- */

  const refresh = useCallback(async () => {
    const next = await api.shoot.state();
    setState(next);
    return next;
  }, []);

  /*
   * Připojit se smí jen jednou. React v režimu kontroly spustí efekt při
   * prvním vykreslení dvakrát — a dvě připojení naráz znamenají dva
   * procesy gphoto2, z nichž si ten druhý sáhne na fotoaparát, který už
   * drží ten první, a oba skončí chybou.
   */
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      /*
       * Fotoaparát se hledá sám a známé tělo se rovnou připojí i s
       * náhledem. Focení začíná vždycky stejně — zapojit kabel, otevřít
       * okno — a klikat u toho ještě dvakrát je práce navíc pokaždé.
       */
      const next = await api.shoot.auto();
      setState(next);
      const last = localStorage.getItem('shootLast') || '';
      const pick = next.shoots.find(one => one.id === last) ?? next.shoots[0] ?? null;
      if (pick) openShoot(pick.id);
      else {
        const made = await api.shoot.create('', '');
        setShoot(made);
        setPhotos([]);
        await refresh();
      }
    })();
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, []);

  /*
   * Snímek náhledu chodí jako bajty a musí se z něj udělat adresa blobu.
   * Ta předchozí se hned uvolní — bez toho by po hodině focení leželo
   * v paměti padesát tisíc obrázků a aplikace by spadla na nedostatek
   * paměti, aniž by bylo poznat proč.
   */
  useEffect(() => api.on('shoot:frame', (bytes: Uint8Array) => {
    const url = URL.createObjectURL(bytesToBlob(bytes, 'image/jpeg'));
    const had = lastFrame.current;
    lastFrame.current = url;
    setFrame(url);
    if (had) URL.revokeObjectURL(had);
  }), []);

  useEffect(() => () => { if (lastFrame.current) URL.revokeObjectURL(lastFrame.current); }, []);

  useEffect(() => api.on('shoot:live', (payload: { running: boolean; error: string }) => {
    setState(had => (had ? { ...had, live: payload.running } : had));
    if (payload.error) note(payload.error, true);
  }), [note]);

  useEffect(() => api.on('shoot:photo', (photo: ShootPhoto) => {
    setPhotos(list => (list.some(one => one.id === photo.id) ? list : [...list, photo]));
  }), []);

  /* ---------- focení jako celek ---------- */

  const openShoot = useCallback(async (id: string) => {
    const one = await api.shoot.shoot(id);
    if (!one) return;
    setShoot(one);
    setPhotos(await api.shoot.photos(id));
    setSelected('');
    localStorage.setItem('shootLast', id);
  }, []);

  /**
   * Uloží změnu focení.
   *
   * Nejdřív se přepíše to, co je na obrazovce, a teprve pak se to pošle
   * dál. Opačně by každé posunutí posuvníku čekalo na odpověď z databáze
   * a ovládání by drhlo.
   */
  const patch = useCallback(async (change: Partial<Shoot>) => {
    if (!shoot) return;
    setShoot(had => (had ? { ...had, ...change } : had));
    await api.shoot.save(shoot.id, change);
  }, [shoot]);

  const newShoot = useCallback(async () => {
    const made = await api.shoot.create('', shoot?.folder ?? '');
    setShoot(made);
    setPhotos([]);
    localStorage.setItem('shootLast', made.id);
    await refresh();
  }, [shoot, refresh]);

  const dropShoot = useCallback(async (id: string) => {
    /*
     * Maže se jen záznam o focení, soubory na disku zůstávají. Smazat
     * s ním i nafocené fotky by znamenalo, že jedno kliknutí vedle zahodí
     * hodinu práce — a to se nedá vzít zpět.
     */
    await api.shoot.deleteShoot(id);
    const next = await refresh();
    const pick = next.shoots[0];
    if (pick) openShoot(pick.id);
    else newShoot();
  }, [refresh, openShoot, newShoot]);

  /* ---------- fotoaparát ---------- */

  const connect = useCallback(async (port: string, model: string) => {
    setBusy('connect');
    try {
      const next = await api.shoot.connect(port, model);
      setState(next);
      if (!next.connected) {
        note(next.error || 'fotoaparát se nepodařilo otevřít', true);
        return;
      }
      if (shoot) await patch({ camera: model, port });
      await api.shoot.live(true);
    } finally {
      setBusy('');
    }
  }, [note, shoot, patch]);

  const scan = useCallback(async () => {
    setBusy('scan');
    try {
      const found = await api.shoot.scan();
      setState(had => (had ? { ...had, cameras: found } : had));
      if (!found.length) note('Žádný fotoaparát na USB. Zkontroluj kabel a zapnuté tělo.', true);
      else if (found.length === 1) await connect(found[0].port, found[0].model);
    } finally {
      setBusy('');
    }
  }, [note, connect]);

  /* ---------- webkamera ---------- */

  const listWebcams = useCallback(async () => {
    try {
      /*
       * Bez povolení vrátí prohlížeč zařízení bez názvů. Proud se proto
       * jednou otevře a hned zavře — jinak by v nabídce byly jen prázdné
       * řádky a nešlo by poznat, který je fotoaparát.
       */
      const probe = await navigator.mediaDevices.getUserMedia({ video: true });
      probe.getTracks().forEach(track => track.stop());
      const all = await navigator.mediaDevices.enumerateDevices();
      setCams(all.filter(one => one.kind === 'videoinput'));
    } catch {
      note('Přístup ke kameře systém nepovolil.', true);
    }
  }, [note]);

  const startWebcam = useCallback(async (deviceId: string) => {
    stream?.getTracks().forEach(track => track.stop());
    try {
      const next = await navigator.mediaDevices.getUserMedia({
        video: deviceId
          // Nejvyšší, co kamera dá — u fotoaparátu v režimu webkamery to bývá Full HD
          ? { deviceId: { exact: deviceId }, width: { ideal: 3840 }, height: { ideal: 2160 } }
          : { width: { ideal: 3840 }, height: { ideal: 2160 } }
      });
      setStream(next);
      setWebcamId(deviceId);
    } catch {
      note('Kameru se nepodařilo otevřít. Používá ji nejspíš jiný program.', true);
    }
  }, [stream, note]);

  const stopWebcam = useCallback(() => {
    stream?.getTracks().forEach(track => track.stop());
    setStream(null);
  }, [stream]);

  useEffect(() => () => { stream?.getTracks().forEach(track => track.stop()); }, [stream]);

  /* ---------- průsvitka ---------- */

  useEffect(() => {
    const file = shoot?.ghost.file ?? '';
    if (!file) { setGhostUrl(''); return; }
    let alive = true;
    let made = '';
    (async () => {
      // `view` kvůli tomu, aby jako průsvitka šla použít i fotka v RAW
      const bytes = await api.shoot.view(file);
      if (!alive || !bytes) return;
      made = URL.createObjectURL(bytesToBlob(bytes));
      setGhostUrl(made);
    })();
    return () => { alive = false; if (made) URL.revokeObjectURL(made); };
  }, [shoot?.ghost.file]);

  /* ---------- fotí se ---------- */

  /**
   * Prohlédne hotový snímek.
   *
   * Měří se **uvnitř ořezu**, ne přes celý obraz. Kolem produktu je bílý
   * papír bez hran — kdyby se počítal s ním, vyšla by ostrost tím nižší,
   * čím víc je kolem místa, a s číslem by nešlo pracovat.
   */
  const inspect = useCallback((ctx: CanvasRenderingContext2D, crop: ShootCrop,
    width: number, height: number): { sharp: number; clipped: number } => {
    const box = crop.on ? cropBox(crop, width, height) : { x: 0, y: 0, w: width, h: height };
    /*
     * Ostrost se počítá z prostředka, ne z celého ořezu. Dvacet megapixelů
     * projet po bodech znamená vteřinu čekání po každém snímku — a na
     * zaostření produktu uprostřed záběru stačí střed.
     */
    const side = Math.max(64, Math.min(600, Math.round(Math.min(box.w, box.h) / 2)));
    const mid = {
      x: box.x + Math.round((box.w - side) / 2),
      y: box.y + Math.round((box.h - side) / 2)
    };
    const middle = ctx.getImageData(Math.max(0, mid.x), Math.max(0, mid.y), side, side);
    /*
     * Přepaly se počítají z vodorovných pruhů, ne z celé plochy. Celý
     * dvacetimegapixelový snímek znamená osmdesát megabajtů dat na jeden
     * `getImageData` — a k nim ještě plátno, obrázek a kopii s korekcí.
     * Okno se u toho na vteřinu zastaví a paměť vyskočí o stovky
     * megabajtů; podíl přepalů z toho přitom vyjde stejný.
     */
    const bands = 12;
    const bandHigh = Math.max(1, Math.floor(box.h / (bands * 2)));
    let clipped = 0;
    for (let i = 0; i < bands; i++) {
      const y = box.y + Math.round((box.h - bandHigh) * (i / (bands - 1 || 1)));
      const strip = ctx.getImageData(box.x, Math.max(0, y), box.w, bandHigh);
      clipped += clipping(strip.data, shoot?.fix.zebraLevel ?? 250);
    }
    return {
      sharp: Math.round(sharpness(middle.data, side, side)),
      clipped: Math.round((clipped / bands) * 10) / 10
    };
  }, [shoot?.fix.zebraLevel]);

  /**
   * Nakreslí snímek na plátno, ořízne ho a použije korekci.
   *
   * Pořadí je dané: nejdřív ořez, pak korekce. Obráceně by se bílá počítala
   * i z toho, co se stejně odřízne — a kus stolu za okrajem papíru by
   * posunul barvy celé série.
   */
  const toCanvas = useCallback((
    source: CanvasImageSource, width: number, height: number, crop: ShootCrop, fix: ShootFix
  ): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null => {
    const box = crop.on ? cropBox(crop, width, height) : { x: 0, y: 0, w: width, h: height };
    const canvas = document.createElement('canvas');
    canvas.width = box.w;
    canvas.height = box.h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(source, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
    if (fixActive(fix)) {
      const data = ctx.getImageData(0, 0, box.w, box.h);
      applyFix(data.data, fix);
      ctx.putImageData(data, 0, 0);
    }
    return { canvas, ctx };
  }, []);

  const shotFromWebcam = useCallback(async () => {
    const element = video.current;
    if (!shoot || !element?.videoWidth) return;
    const made = toCanvas(element, element.videoWidth, element.videoHeight, shoot.crop, shoot.fix);
    if (!made) return;
    const type = shoot.webp ? 'image/webp' : 'image/jpeg';
    const quality = shoot.webp ? shoot.webpQuality / 100 : 0.94;
    const blob = await new Promise<Blob | null>(done => made.canvas.toBlob(done, type, quality));
    if (!blob) { note('Snímek se nepovedl uložit.', true); return; }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const out = await api.shoot.bytes(shoot.id, shoot.webp ? 'webp' : 'jpg', bytes);
    if (!out.ok) { note(out.error, true); return; }
    if (out.photo) {
      const look = inspect(made.ctx, { ...shoot.crop, on: false }, made.canvas.width, made.canvas.height);
      await api.shoot.savePhoto(out.photo.id, { ...look, slot });
    }
  }, [shoot, note, toCanvas, inspect, slot]);

  /**
   * Ořízne a převede právě nafocený snímek — vedle originálu.
   *
   * Originál se **nikdy nepřepisuje**: z JPEGu ze zrcadlovky jde kopie
   * udělat znovu jinak, z oříznuté kopie originál zpátky ne. Na e-shop
   * jde kopie, na disku zůstane obojí.
   *
   * Kopie vzniká, i když je WebP vypnuté — tehdy jako JPEG. Ořez je důvod
   * sám o sobě: bez kopie by se čtvercový výřez musel dělat ručně u každé
   * fotky zvlášť.
   */
  const afterShot = useCallback(async (photo: ShootPhoto) => {
    if (!shoot) return;

    /*
     * Záběr ze série se zapíše hned, ještě před prohlédnutím fotky.
     * Prohlédnout se dá jen to, co Chromium otevře — u samotného RAW nic —
     * a kdyby se zápis vázal na to, při focení do RAW by se seznam záběrů
     * nikdy neodškrtl a vypadal by jako rozbitý.
     */
    if (slot) {
      const marked = await api.shoot.savePhoto(photo.id, { slot });
      if (marked) setPhotos(list => list.map(one => (one.id === marked.id ? marked : one)));
    }

    if (!photo.file) return;
    /*
     * U RAW se prohlíží vnořený náhled — na porovnání ostrosti v rámci
     * série stačí, protože se u všech snímků měří stejně. Vyvolaná kopie
     * se z něj ale nedělá: ta by měla horší rozlišení než originál.
     */
    const bytes = await api.shoot.view(photo.file);
    if (!bytes) return;
    const fromRaw = /\.(cr2|cr3|nef|arw|dng|raf|orf|rw2|pef)$/i.test(photo.file);
    try {
      const bitmap = await createImageBitmap(bytesToBlob(bytes));
      const made = toCanvas(bitmap, bitmap.width, bitmap.height, shoot.crop, shoot.fix);
      bitmap.close();
      if (!made) return;

      const look = inspect(made.ctx, { ...shoot.crop, on: false }, made.canvas.width, made.canvas.height);
      let saved = await api.shoot.savePhoto(photo.id, { ...look, slot });

      const wantCopy = (shoot.webp || shoot.crop.on) && !fromRaw;
      if (wantCopy) {
        const ext = shoot.webp ? 'webp' : 'jpg';
        const blob = await new Promise<Blob | null>(done => made.canvas.toBlob(
          done,
          shoot.webp ? 'image/webp' : 'image/jpeg',
          shoot.webp ? shoot.webpQuality / 100 : 0.94
        ));
        if (blob) {
          const out = await api.shoot.bytes(
            shoot.id, ext, new Uint8Array(await blob.arrayBuffer()), photo.file);
          if (out.photo) saved = out.photo;
        }
      }
      if (saved) {
        forgetThumb(saved.id);
        setPhotos(list => list.map(one => (one.id === saved!.id ? saved! : one)));
      }
      /*
       * Plátno se uvolní hned. Bez toho zůstane osmdesát megabajtů viset,
       * dokud se uklízeč paměti neprobere — a při sérii dvaceti kusů se
       * to nasčítá do gigabajtů a okno spadne na nedostatek paměti.
       */
      made.canvas.width = 0;
      made.canvas.height = 0;
    } catch {
      // RAW Chromium neotevře; kopie ani kontrola se u něj prostě neudělá
    }
  }, [shoot, toCanvas, inspect, slot]);

  /** Po snímku se přeskočí na další nenafocený záběr v seznamu. */
  const nextSlot = useCallback((taken: ShootPhoto[]) => {
    if (!shoot?.plan.length) return;
    const done = new Set(taken.map(one => one.slot).filter(Boolean));
    const next = shoot.plan.find(one => !done.has(one.id));
    setSlot(next?.id ?? '');
  }, [shoot]);

  const capture = useCallback(async () => {
    if (!shoot || busy) return;
    setBusy('shot');
    try {
      if (stream) { await shotFromWebcam(); return; }
      let out = await api.shoot.capture(shoot.id);
      /*
       * Spadlé spojení uprostřed focení se navazuje samo a snímek se
       * zkusí ještě jednou. gphoto2 umí skončit kvůli uspanému USB nebo
       * pohnutému kabelu — bez tohohle by v okně zbylo „fotoaparát není
       * připojený" a dál by se nedalo fotit, přestože tělo je na kabelu.
       */
      if (!out.ok && /není připojený|gphoto2 skončil|spojení s fotoaparátem/i.test(out.error)) {
        note('Spojení spadlo, připojuji znovu…');
        const back = await api.shoot.reconnect();
        setState(back);
        if (back.connected) out = await api.shoot.capture(shoot.id);
      }
      if (!out.ok) { note(out.error, true); return; }
      if (out.photo) await afterShot(out.photo);
    } finally {
      setBusy('');
      const fresh = await api.shoot.photos(shoot.id);
      setPhotos(fresh);
      nextSlot(fresh);
    }
  }, [shoot, busy, stream, shotFromWebcam, note, afterShot, nextSlot]);

  // Mezerník fotí. Při psaní do políčka ne — tam patří mezera do textu.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName ?? '') || target?.isContentEditable;
      if (typing) return;
      if (e.code === 'Space') { e.preventDefault(); capture(); }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selected) { e.preventDefault(); dropShape(selected); }
      }
      /*
       * Šipkami po drobných krocích. Myší se vodítko umístí zhruba, ale
       * „zhruba" je přesně to, co u série fotek nestačí — s Shiftem je
       * krok desetkrát větší na hrubé posunutí.
       */
      if (selected && /^Arrow(Left|Right|Up|Down)$/.test(e.key)) {
        e.preventDefault();
        const step = e.shiftKey ? 0.01 : 0.001;
        nudge(selected,
          e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0,
          e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [capture, selected]);

  /* ---------- vodítka ---------- */

  const addShape = useCallback((shape: ShootOverlay) => {
    if (!shoot) return;
    patch({ overlay: [...shoot.overlay, shape] });
  }, [shoot, patch]);

  /**
   * Posunuté vodítko. Nahradí se podle `id`, ostatní zůstávají.
   *
   * Přepsat celé pole novým seznamem by při přetahování jednoho vodítka
   * přepsalo i to, co mezitím vzniklo jinde — třeba střed přidaný
   * kliknutím uprostřed tažení.
   */
  const changeShape = useCallback((shape: ShootOverlay) => {
    if (!shoot) return;
    patch({ overlay: shoot.overlay.map(one => (one.id === shape.id ? shape : one)) });
  }, [shoot, patch]);

  /** Posun vodítka z klávesnice. Mřížka a třetiny drží celý obraz, ty se nehýbou. */
  const nudge = useCallback((id: string, dx: number, dy: number) => {
    if (!shoot) return;
    const shape = shoot.overlay.find(one => one.id === id);
    if (!shape || shape.kind === 'thirds' || shape.kind === 'grid') return;
    const keep = (value: number) => Math.max(0, Math.min(1, value));
    const moved: ShootOverlay = shape.kind === 'cross'
      ? { ...shape, x: keep(shape.x + dx), y: keep(shape.y + dy) }
      : { ...shape, x: shape.x + dx, x2: shape.x2 + dx, y: shape.y + dy, y2: shape.y2 + dy };
    changeShape(moved);
  }, [shoot, changeShape]);

  const dropShape = useCallback((id: string) => {
    if (!shoot) return;
    setSelected('');
    patch({ overlay: shoot.overlay.filter(one => one.id !== id) });
  }, [shoot, patch]);

  /* ---------- korekce ---------- */

  const setFix = useCallback((change: Partial<ShootFix>) => {
    if (!shoot) return;
    patch({ fix: { ...shoot.fix, ...change } });
  }, [shoot, patch]);

  /**
   * Nastaví korekci podle toho, co je právě v náhledu.
   *
   * Hádá se z obrazu, ne z čísel v nastavení: světlo u stolu se v průběhu
   * dne mění a nastavení, které sedělo ráno, odpoledne nesedí.
   */
  const guessFix = useCallback(async () => {
    const source: HTMLImageElement | HTMLVideoElement | null = stream
      ? video.current
      : (document.querySelector('img.sh-frame') as HTMLImageElement | null);
    const width = source instanceof HTMLVideoElement ? source.videoWidth : source?.naturalWidth ?? 0;
    const height = source instanceof HTMLVideoElement ? source.videoHeight : source?.naturalHeight ?? 0;
    if (!source || !width) { note('Nejdřív musí běžet náhled.', true); return; }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    ctx.drawImage(source, 0, 0);
    const guess = autoFix(ctx.getImageData(0, 0, width, height).data);
    if (!guess.white) {
      note('Na obraze není bílé pozadí, ze kterého by se dala barva odečíst.', true);
      return;
    }
    setFix({ ...guess, on: true, preset: '' });
  }, [stream, note, setFix]);

  /* ---------- vykreslení ---------- */

  const connected = !!state?.connected;
  const running = !!state?.live || !!stream;
  const filter = useMemo(() => (shoot ? cssFilter(shoot.fix) : ''), [shoot]);

  if (!state || !shoot) return <div className="sh-wrap"><div className="sh-blank">Načítám…</div></div>;

  return (
    <div className={`sh-wrap ${standalone ? 'standalone' : ''}`}>
      <header className="sh-top">
        <Icon name="camera" size={16} />
        <input
          className="sh-name"
          value={shoot.name}
          onChange={e => patch({ name: e.target.value })}
          placeholder="Název focení"
        />
        <small className="sh-when">{when(shoot.createdAt)}</small>

        <span className="sh-top-space" />

        <button className="sh-mini" onClick={newShoot}><Icon name="plus" size={12} /> Nové focení</button>
        <select
          className="sh-pick"
          value={shoot.id}
          onChange={e => openShoot(e.target.value)}
        >
          {state.shoots.map(one => (
            <option key={one.id} value={one.id}>
              {one.name} — {when(one.createdAt)} ({one.photos})
            </option>
          ))}
        </select>
        {!standalone && (
          <button className="sh-mini" onClick={() => { api.shoot.window(); onClose(); }} title="Otevřít ve vlastním okně">
            <Icon name="expand" size={12} /> Vlastní okno
          </button>
        )}
        <button className="sh-mini" onClick={onClose} title="Zavřít"><Icon name="x" size={13} /></button>
      </header>

      <div className="sh-body">
        <main className="sh-main">
          <div className="sh-tools">
            {/*
              * Popisek je u ikony vidět, ne jen v bublině. Nástrojů je osm
              * a nakreslit „elipsu" jde poznat z obrázku, ale „třetiny" od
              * „mřížky" ne — bez popisku by se mezi nimi hádalo.
              */}
            <ToolButton now={tool} id="zoom" icon="cursor" label="Vybrat" set={setTool} />
            <ToolButton now={tool} id="line" icon="drawLine" label="Čára" set={setTool} />
            <ToolButton now={tool} id="rect" icon="drawRect" label="Rámeček" set={setTool} />
            <ToolButton now={tool} id="ellipse" icon="drawEllipse" label="Elipsa" set={setTool} />
            <ToolButton now={tool} id="cross" icon="drawCross" label="Střed" set={setTool} />
            <ToolButton now={tool} id="thirds" icon="drawThirds" label="Třetiny" set={setTool} />
            <ToolButton now={tool} id="grid" icon="drawGrid" label="Mřížka" set={setTool} />
            <span className="sh-sep" />
            <ToolButton now={tool} id="crop" icon="crop" label="Ořez" set={setTool} />
            <ToolButton now={tool} id="pick" icon="pipette" label="Bílá z obrazu" set={setTool} />
            <span className="sh-sep" />
            {COLORS.map(one => (
              <button
                key={one}
                className={`sh-color ${one === color ? 'on' : ''}`}
                style={{ background: one }}
                onClick={() => setColor(one)}
                title="Barva vodítka"
              />
            ))}
            <input
              className="sh-thick"
              type="range" min={1} max={6} step={1}
              value={lineWidth}
              onChange={e => setLineWidth(Number(e.target.value))}
              title="Tloušťka čáry"
            />
            <span className="sh-sep" />
            <button
              className="sh-mini"
              onClick={() => setViewZoom(one => Math.max(1, one / 1.5))}
              disabled={viewZoom <= 1}
              title="Oddálit náhled"
            >
              <Icon name="minus" size={12} />
            </button>
            <button className="sh-mini" onClick={() => setViewZoom(1)} title="Celý obraz">
              {Math.round(viewZoom * 100)} %
            </button>
            <button
              className="sh-mini"
              onClick={() => setViewZoom(one => Math.min(6, one * 1.5))}
              disabled={viewZoom >= 6}
              title="Přiblížit náhled"
            >
              <Icon name="plus" size={12} />
            </button>
            <span className="sh-top-space" />
            {!!selected && (
              <button className="sh-mini" onClick={() => dropShape(selected)}>
                <Icon name="trash" size={12} /> Smazat vodítko
              </button>
            )}
            {!!shoot.overlay.length && (
              <button className="sh-mini" onClick={() => patch({ overlay: [] })}>
                Smazat všechna ({shoot.overlay.length})
              </button>
            )}
          </div>

          {/*
            * Srovnání vedle sebe, ne přes sebe. Průsvitka ukáže, jestli
            * produkt leží stejně, ale rozdíl ve světle se v prolnutí dvou
            * obrazů ztratí — a právě ten je na řadě fotek vidět nejvíc.
            */}
          <div className={`sh-pair ${side && ghostUrl ? 'on' : ''}`}>
          <ShootView
            frame={frame}
            stream={stream}
            media={video}
            ghost={shoot.ghost}
            /* Vedle sebe se průsvitka přes náhled nekreslí — byla by dvakrát */
            ghostUrl={side ? '' : ghostUrl}
            overlay={shoot.overlay}
            fix={shoot.fix}
            tool={tool}
            color={color}
            lineWidth={lineWidth}
            selected={selected}
            onSelect={setSelected}
            onAdd={addShape}
            onChange={changeShape}
            crop={shoot.crop}
            onCrop={box => patch({ crop: { ...shoot.crop, ...box, on: true } })}
            onAspect={setFrameRatio}
            zoom={viewZoom}
            onPickWhite={rgb => setFix({ white: rgb, on: true })}
          />
          {side && ghostUrl && (
            <div className="sh-view sh-ref">
              <img src={ghostUrl} alt="" />
              <span className="sh-ref-tag">minulá série</span>
            </div>
          )}
          </div>

          <div className="sh-shoot">
            <button
              className="sh-shutter"
              onClick={capture}
              disabled={!running || !!busy}
              title="Vyfotit (mezerník)"
            >
              <Icon name="camera" size={18} />
              {busy === 'shot' ? 'Fotím…' : 'Vyfotit'}
            </button>
            {connected && (
              <button className="sh-mini" onClick={async () => {
                const out = await api.shoot.focus();
                if (!out.ok) note(out.error || 'zaostřit se nepovedlo', true);
              }}>
                Zaostřit
              </button>
            )}
            <button
              className="sh-mini"
              onClick={() => {
                if (stream) { stopWebcam(); return; }
                /*
                 * Jen se řekne, co se má stát — jestli náhled běží, hlásí
                 * hlavní proces událostí `shoot:live`. Dřív se stav měnil
                 * i tady, takže se přehodil dvakrát: událost ho srovnala
                 * a obrácení hned zase vrátilo zpátky. Tlačítko pak
                 * navždy hlásilo „Zastavit náhled" u něčeho, co neběží,
                 * a spustit se to už nedalo.
                 */
                api.shoot.live(!state.live);
              }}
              disabled={!connected && !stream}
            >
              {running ? 'Zastavit náhled' : 'Spustit náhled'}
            </button>
            {!!shoot.plan.length && (
              <div className="sh-slots">
                {shoot.plan.map(one => {
                  const done = photos.some(photo => photo.slot === one.id);
                  return (
                    <button
                      key={one.id}
                      className={`sh-slot ${done ? 'done' : ''} ${slot === one.id ? 'now' : ''}`}
                      onClick={() => setSlot(one.id)}
                      title={done ? 'Už nafoceno — kliknutím se k němu vrátíš' : 'Tenhle záběr se fotí teď'}
                    >
                      {done ? <Icon name="check" size={11} /> : null}
                      {one.name}
                    </button>
                  );
                })}
              </div>
            )}
            <span className="sh-top-space" />
            {!!shoot.ghost.file && (
              <button
                className={`sh-mini ${side ? 'on' : ''}`}
                onClick={() => setSide(one => !one)}
                title="Minulá série vedle náhledu místo přes něj"
              >
                <Icon name="layers" size={12} /> {side ? 'Přes sebe' : 'Vedle sebe'}
              </button>
            )}
            <small>{photos.length} {photoWord(photos.length)}</small>
            <button className="sh-mini" onClick={() => api.shoot.openFolder(shoot.id)}>
              <Icon name="folder" size={12} /> Složka
            </button>
          </div>

          <ShootGallery
            photos={photos}
            working={busy === 'shot'}
            onDrop={async photo => {
              await api.shoot.dropPhoto(photo.id, true);
              forgetThumb(photo.id);
              setPhotos(list => list.filter(one => one.id !== photo.id));
            }}
            onPick={async photo => {
              const next = await api.shoot.savePhoto(photo.id, { pick: !photo.pick });
              if (next) setPhotos(list => list.map(one => (one.id === next.id ? next : one)));
            }}
            onGhost={photo => patch({ ghost: { ...shoot.ghost, file: photo.webp || photo.file } })}
          />
        </main>

        <aside className="sh-side">
          <nav className="sh-tabs">
            {(['kamera', 'vodítka', 'barvy', 'soubor'] as Panel[]).map(one => (
              <button key={one} className={panel === one ? 'on' : ''} onClick={() => setPanel(one)}>
                {one === 'vodítka' ? 'Šablona' : one[0].toUpperCase() + one.slice(1)}
              </button>
            ))}
          </nav>

          {panel === 'kamera' && (
            <div className="sh-panel">
              <div className="sh-panel-head"><b>Připojení</b></div>
              {!state.tool.ok && <div className="sh-panel-note">{state.tool.note}</div>}

              {state.tool.ok && (
                <>
                  <div className="sh-row">
                    <button className="sh-mini" onClick={scan} disabled={busy === 'scan'}>
                      <Icon name="refresh" size={12} /> {busy === 'scan' ? 'Hledám…' : 'Najít fotoaparát'}
                    </button>
                    {connected && (
                      <button className="sh-mini" onClick={async () => setState(await api.shoot.disconnect())}>
                        Odpojit
                      </button>
                    )}
                  </div>
                  {state.cameras.map(one => (
                    <button
                      key={one.port}
                      className={`sh-cam ${state.port === one.port && connected ? 'on' : ''}`}
                      onClick={() => connect(one.port, one.model)}
                      disabled={busy === 'connect'}
                    >
                      <b>{one.model}</b><small>{one.port}</small>
                    </button>
                  ))}
                  {connected && <div className="sh-ok">Připojeno: {state.camera}</div>}
                  {!!state.error && !connected && <div className="sh-panel-note bad">{state.error}</div>}
                </>
              )}

              <div className="sh-panel-head" style={{ marginTop: 14 }}>
                <b>Nebo jako webkamera</b>
              </div>
              <div className="sh-panel-note">
                Fotoaparát v režimu webkamery (u Canonu „EOS Webcam Utility"). Náhled
                a snímek z něj fungují, ovládání těla a plné rozlišení ne.
              </div>
              <div className="sh-row">
                <button className="sh-mini" onClick={listWebcams}>Najít kamery</button>
                {stream && <button className="sh-mini" onClick={stopWebcam}>Zastavit</button>}
              </div>
              {cams.map(one => (
                <button
                  key={one.deviceId}
                  className={`sh-cam ${webcamId === one.deviceId && stream ? 'on' : ''}`}
                  onClick={() => startWebcam(one.deviceId)}
                >
                  <b>{one.label || 'Kamera'}</b>
                </button>
              ))}

              <div style={{ marginTop: 14 }}>
                <ShootSettings connected={connected} onNote={note} />
              </div>

              <CameraLog onNote={note} />
            </div>
          )}

          {panel === 'vodítka' && (
            <div className="sh-panel">
              <div className="sh-panel-head"><b>Průsvitka</b></div>
              <div className="sh-panel-note">
                Fotka podložená pod náhled. Slouží k tomu, aby další kus ležel
                přesně tam, kde ležel minulý.
              </div>
              <div className="sh-row">
                <button className="sh-mini" onClick={async () => {
                  const file = await api.shoot.ghost();
                  if (file) patch({ ghost: { ...shoot.ghost, file } });
                }}>
                  <Icon name="image" size={12} /> Vybrat fotku
                </button>
                {shoot.ghost.file && (
                  <button className="sh-mini" onClick={() => patch({ ghost: { ...shoot.ghost, file: '' } })}>
                    Sundat
                  </button>
                )}
              </div>
              {shoot.ghost.file && (
                <>
                  <label className="sh-field">
                    <span>Krytí</span>
                    <span className="sh-range">
                      <input
                        type="range" min={0} max={100} step={5}
                        value={shoot.ghost.opacity}
                        onChange={e => patch({ ghost: { ...shoot.ghost, opacity: Number(e.target.value) } })}
                      />
                      <b>{shoot.ghost.opacity} %</b>
                    </span>
                  </label>
                  <label className="sh-field sh-field-toggle">
                    <span>Překlopit vodorovně</span>
                    <input
                      type="checkbox"
                      checked={shoot.ghost.mirror}
                      onChange={e => patch({ ghost: { ...shoot.ghost, mirror: e.target.checked } })}
                    />
                  </label>
                </>
              )}

              <div className="sh-panel-head" style={{ marginTop: 14 }}><b>Záběry v sérii</b></div>
              <div className="sh-panel-note">
                Seznam toho, co se u každého kusu fotí. Po snímku se sám posune
                na další nenafocený — nemusíš hlídat, jestli ti něco nechybí.
              </div>
              {!shoot.plan.length && (
                <button
                  className="sh-mini"
                  onClick={() => patch({ plan: PLAN_START.map(makeSlot) })}
                >
                  <Icon name="plus" size={12} /> Založit seznam záběrů
                </button>
              )}
              {shoot.plan.map((one, index) => (
                <div className="sh-shape-row" key={one.id}>
                  <input
                    className="sh-slot-name"
                    value={one.name}
                    onChange={e => patch({
                      plan: shoot.plan.map(row =>
                        (row.id === one.id ? { ...row, name: e.target.value } : row))
                    })}
                  />
                  <button
                    onClick={() => patch({ plan: shoot.plan.filter(row => row.id !== one.id) })}
                    title="Odebrat záběr"
                  >
                    <Icon name="x" size={11} />
                  </button>
                  {index === shoot.plan.length - 1 && (
                    <button
                      onClick={() => patch({ plan: [...shoot.plan, makeSlot('Další záběr')] })}
                      title="Přidat záběr"
                    >
                      <Icon name="plus" size={11} />
                    </button>
                  )}
                </div>
              ))}

              <div className="sh-panel-head" style={{ marginTop: 14 }}><b>Vodítka</b></div>
              <div className="sh-panel-note">
                {shoot.overlay.length
                  ? `${shoot.overlay.length} ${shapeWord(shoot.overlay.length)}. Kreslí se nástroji nad náhledem.`
                  : 'Zatím žádná. Vyber nástroj nad náhledem a táhni myší přes obraz.'}
              </div>
              {shoot.overlay.map(one => (
                <div key={one.id} className={`sh-shape-row ${selected === one.id ? 'on' : ''}`}>
                  <button onClick={() => setSelected(one.id)}>
                    <i style={{ background: one.color }} />
                    {shapeName(one.kind)}
                  </button>
                  <button onClick={() => dropShape(one.id)}><Icon name="x" size={11} /></button>
                </div>
              ))}
            </div>
          )}

          {panel === 'barvy' && (
            <div className="sh-panel">
              <div className="sh-panel-head">
                <b>Korekce</b>
                <label className="sh-switch">
                  <input
                    type="checkbox"
                    checked={shoot.fix.on}
                    onChange={e => setFix({ on: e.target.checked })}
                  />
                  <span>zapnout</span>
                </label>
              </div>
              <div className="sh-panel-note">
                Používá se na náhled i na uložené kopie. Originál ze zrcadlovky
                zůstává na disku nedotčený.
              </div>

              <div className="sh-row">
                <button className="sh-mini" onClick={guessFix}>
                  <Icon name="sparkles" size={12} /> Nastavit podle obrazu
                </button>
                <button className="sh-mini" onClick={() => setTool('pick')}>
                  Kliknout na bílou
                </button>
              </div>
              {shoot.fix.white && (
                <div className="sh-white">
                  <i style={{ background: `rgb(${shoot.fix.white})` }} />
                  bílá odečtena z obrazu
                  <button onClick={() => setFix({ white: '' })}><Icon name="x" size={11} /></button>
                </div>
              )}

              <div className="sh-presets">
                {PRESETS.map(one => (
                  <button
                    key={one.id}
                    className={shoot.fix.preset === one.id ? 'on' : ''}
                    title={one.hint}
                    onClick={() => setFix({ ...(preset(one.id) ?? {}), preset: one.id, on: true })}
                  >
                    {one.label}
                  </button>
                ))}
              </div>

              <Slide label="Jas" min={-1} max={1} step={0.05} value={shoot.fix.exposure}
                onChange={value => setFix({ exposure: value, preset: '' })} unit=" EV" />
              <Slide label="Kontrast" min={-50} max={50} step={1} value={shoot.fix.contrast}
                onChange={value => setFix({ contrast: value, preset: '' })} />
              <Slide label="Sytost" min={-50} max={50} step={1} value={shoot.fix.saturation}
                onChange={value => setFix({ saturation: value, preset: '' })} />
              <Slide label="Teplota" min={-40} max={40} step={1} value={shoot.fix.temperature}
                onChange={value => setFix({ temperature: value, preset: '' })} />

              <div className="sh-panel-head" style={{ marginTop: 14 }}>
                <b>Přepálená světla</b>
                <label className="sh-switch">
                  <input
                    type="checkbox"
                    checked={shoot.fix.zebra}
                    onChange={e => setFix({ zebra: e.target.checked })}
                  />
                  <span>ukazovat</span>
                </label>
              </div>
              <div className="sh-panel-note">
                Růžové pruhy v náhledu tam, kde už není kresba. Na displeji
                fotoaparátu se to nepozná a v postprodukci se to nespraví.
              </div>
              <Slide label="Od světlosti" min={230} max={255} step={1} value={shoot.fix.zebraLevel}
                onChange={value => setFix({ zebraLevel: value })} />

              <div className="sh-panel-head" style={{ marginTop: 10 }}><b>Bílé pozadí</b></div>
              <Slide label="Dočistit" min={0} max={100} step={5} value={shoot.fix.background}
                onChange={value => setFix({ background: value, preset: '' })} unit=" %" />
              <Slide label="Od světlosti" min={180} max={255} step={1} value={shoot.fix.backgroundLevel}
                onChange={value => setFix({ backgroundLevel: value, preset: '' })} />
              <div className="sh-panel-note">
                Níž než 230 se spolu s papírem vybělí i světlá látka. Náhled ukazuje
                jen jas a kontrast — dočištění pozadí je vidět až na uložené fotce.
              </div>
            </div>
          )}

          {panel === 'soubor' && (
            <div className="sh-panel">
              <div className="sh-panel-head"><b>Kam se fotí</b></div>
              <div className="sh-folder">{shoot.folder || 'Obrázky ▸ Quentino focení'}</div>
              <button className="sh-mini" onClick={async () => {
                const dir = await api.shoot.folder(shoot.id);
                if (dir) setShoot(had => (had ? { ...had, folder: dir } : had));
              }}>
                <Icon name="folder" size={12} /> Vybrat složku
              </button>

              <div className="sh-panel-head" style={{ marginTop: 14 }}>
                <b>Ořez</b>
                <label className="sh-switch">
                  <input
                    type="checkbox"
                    checked={shoot.crop.on}
                    onChange={e => patch({ crop: { ...shoot.crop, on: e.target.checked } })}
                  />
                  <span>zapnout</span>
                </label>
              </div>
              <div className="sh-panel-note">
                Rámeček se táhne nástrojem <b>Ořez</b> nad náhledem. Oříznutá kopie
                vzniká vedle originálu — ten zůstává celý pro Photoshop.
              </div>
              <label className="sh-field">
                <span>Poměr stran</span>
                <select
                  value={shoot.crop.ratio}
                  onChange={e => {
                    const ratio = e.target.value;
                    /*
                     * Změna poměru musí rámeček rovnou srovnat, ne čekat na
                     * další tažení — jinak by „čtverec" ořízl obdélník až do
                     * chvíle, kdy si toho někdo všimne na hotových fotkách.
                     */
                    const box = lockRatio(shoot.crop, ratioValue(ratio), frameRatio);
                    patch({ crop: { ...shoot.crop, ...box, ratio } });
                  }}
                >
                  {RATIOS.map(one => (
                    <option key={one.id || 'free'} value={one.id}>{one.label}</option>
                  ))}
                </select>
              </label>
              <div className="sh-row">
                <button
                  className="sh-mini"
                  onClick={() => {
                    // Vycentrovat na největší rámeček, který se do obrazu vejde
                    const box = lockRatio({ x: 0, y: 0, w: 1, h: 1 }, ratioValue(shoot.crop.ratio), frameRatio);
                    patch({ crop: { ...shoot.crop, on: true,
                      x: (1 - box.w) / 2, y: (1 - box.h) / 2, w: box.w, h: box.h } });
                  }}
                >
                  Na střed, co největší
                </button>
              </div>

              <div className="sh-panel-head" style={{ marginTop: 14 }}><b>Formát</b></div>
              <div className="sh-panel-note">
                RAW nebo JPEG se přepíná na fotoaparátu — v záložce Kamera pod
                „Formát snímku". Aplikace stáhne to, co tělo pošle, a RAW uloží
                vedle JPEGu.
              </div>
              <label className="sh-field sh-field-toggle">
                <span>Udělat i kopii ve WebP</span>
                <input
                  type="checkbox"
                  checked={shoot.webp}
                  onChange={e => patch({ webp: e.target.checked })}
                />
              </label>
              {shoot.webp && (
                <Slide label="Kvalita WebP" min={40} max={100} step={1} value={shoot.webpQuality}
                  onChange={value => patch({ webpQuality: value })} />
              )}
              <div className="sh-panel-note">
                Kopie vzniká vedle originálu a je v ní i korekce barev. Původní
                soubor se nepřepisuje.
              </div>

              <div className="sh-panel-head" style={{ marginTop: 14 }}><b>Poznámka k focení</b></div>
              <textarea
                className="sh-note"
                value={shoot.note}
                placeholder="Světla, vzdálenost, objektiv… co bude potřeba vědět, až se série bude dofocovat"
                onChange={e => patch({ note: e.target.value })}
              />

              <div className="sh-panel-head" style={{ marginTop: 14 }}><b>Uložená focení</b></div>
              {state.shoots.map(one => (
                <div key={one.id} className={`sh-shoot-row ${one.id === shoot.id ? 'on' : ''}`}>
                  <button onClick={() => openShoot(one.id)}>
                    <b>{one.name}</b>
                    <small>{when(one.createdAt)} · {one.photos} {photoWord(one.photos)}</small>
                  </button>
                  <button onClick={() => dropShoot(one.id)} title="Zapomenout focení (fotky na disku zůstanou)">
                    <Icon name="x" size={11} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

/**
 * Protokol posledních příkazů.
 *
 * Focení běží u fotoaparátu, který nikdo jiný nemá. Když se něco pokazí,
 * je rozdíl mezi „nefunguje to" a přesným výpisem toho, co tělo
 * odpovědělo — a získat ten výpis jinak znamená spouštět gphoto2 ručně
 * v terminálu.
 */
function CameraLog({ onNote }: { onNote: (text: string, bad?: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<{ at: string; command: string; ok: boolean; error: string; text: string }[]>([]);

  const load = useCallback(async () => {
    // Prázdný protokol se vrací jako nic; pole musí zůstat polem
    setRows((await api.shoot.log()) ?? []);
  }, []);

  useEffect(() => { if (open) load(); }, [open, load]);

  const asText = () => rows.map(one =>
    `${one.at.slice(11, 19)}  ${one.ok ? 'ok ' : 'CHYBA'}  ${one.command}`
    + (one.error ? `\n   ${one.error}` : '')
    + (one.text ? `\n   ${one.text.replace(/\n/g, '\n   ')}` : '')
  ).join('\n');

  return (
    <div style={{ marginTop: 14 }}>
      <button className="sh-more" onClick={() => setOpen(one => !one)}>
        <Icon name={open ? 'chevDown' : 'chevRight'} size={12} />
        Protokol fotoaparátu
      </button>
      {open && (
        <>
          <div className="sh-row">
            <button className="sh-mini" onClick={load}>
              <Icon name="refresh" size={12} /> Načíst
            </button>
            <button
              className="sh-mini"
              onClick={async () => {
                await navigator.clipboard.writeText(asText());
                onNote('Protokol je ve schránce.');
              }}
              disabled={!rows.length}
            >
              <Icon name="copy" size={12} /> Zkopírovat
            </button>
          </div>
          <div className="sh-log">
            {!rows.length && <small>Zatím nic — protokol se plní při práci s fotoaparátem.</small>}
            {rows.slice().reverse().map((one, index) => (
              <div key={`${one.at}-${index}`} className={one.ok ? '' : 'bad'}>
                <b>{one.at.slice(11, 19)}</b> {one.command}
                {one.error ? <i>{one.error}</i> : null}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ToolButton({ now, id, icon, label, set }: {
  now: Tool; id: Tool; icon: string; label: string; set: (tool: Tool) => void;
}) {
  return (
    <button className={`sh-tool ${now === id ? 'on' : ''}`} onClick={() => set(id)} title={label}>
      <Icon name={icon} size={15} />
      <span>{label}</span>
    </button>
  );
}

function Slide({ label, min, max, step, value, onChange, unit = '' }: {
  label: string; min: number; max: number; step: number;
  value: number; onChange: (value: number) => void; unit?: string;
}) {
  return (
    <label className="sh-field">
      <span>{label}</span>
      <span className="sh-range">
        <input
          type="range" min={min} max={max} step={step}
          value={value}
          onChange={e => onChange(Number(e.target.value))}
        />
        <b>{step < 1 ? value.toFixed(2) : value}{unit}</b>
      </span>
    </label>
  );
}

function when(iso: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('cs-CZ');
}

function photoWord(count: number): string {
  if (count === 1) return 'fotka';
  if (count >= 2 && count <= 4) return 'fotky';
  return 'fotek';
}

function shapeWord(count: number): string {
  if (count === 1) return 'vodítko';
  if (count >= 2 && count <= 4) return 'vodítka';
  return 'vodítek';
}

function shapeName(kind: ShootOverlay['kind']): string {
  return kind === 'line' ? 'Čára'
    : kind === 'rect' ? 'Rámeček'
      : kind === 'ellipse' ? 'Elipsa'
        : kind === 'cross' ? 'Střed'
          : kind === 'thirds' ? 'Třetiny'
            : 'Mřížka';
}
