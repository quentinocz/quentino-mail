import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Shoot, ShootPhoto, ShootState, ShootOverlay, ShootFix } from '@shared/types';
import { api } from '../api';
import { bytesToBlob } from '../media';
import { useToast } from '../toast';
import { applyFix, autoFix, cssFilter, fixActive, PRESETS, preset } from '../shoot/fix';
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
      const bytes = await api.shoot.read(file);
      if (!alive || !bytes) return;
      made = URL.createObjectURL(bytesToBlob(bytes));
      setGhostUrl(made);
    })();
    return () => { alive = false; if (made) URL.revokeObjectURL(made); };
  }, [shoot?.ghost.file]);

  /* ---------- fotí se ---------- */

  const shotFromWebcam = useCallback(async () => {
    const element = video.current;
    if (!shoot || !element?.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width = element.videoWidth;
    canvas.height = element.videoHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    ctx.drawImage(element, 0, 0);
    if (fixActive(shoot.fix)) {
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
      applyFix(data.data, shoot.fix);
      ctx.putImageData(data, 0, 0);
    }
    const type = shoot.webp ? 'image/webp' : 'image/jpeg';
    const quality = shoot.webp ? shoot.webpQuality / 100 : 0.94;
    const blob = await new Promise<Blob | null>(done => canvas.toBlob(done, type, quality));
    if (!blob) { note('Snímek se nepovedl uložit.', true); return; }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const out = await api.shoot.bytes(shoot.id, shoot.webp ? 'webp' : 'jpg', bytes);
    if (!out.ok) note(out.error, true);
  }, [shoot, note]);

  /**
   * Převede právě nafocený snímek do WebP vedle originálu.
   *
   * Originál se **nikdy nepřepisuje**: z JPEGu ze zrcadlovky jde WebP
   * udělat znovu jinak, z WebP originál zpátky ne. Na e-shop jde kopie,
   * na disku zůstane obojí.
   */
  const alsoWebp = useCallback(async (photo: ShootPhoto) => {
    if (!shoot?.webp || !photo.file) return;
    const bytes = await api.shoot.read(photo.file);
    if (!bytes) return;
    try {
      const bitmap = await createImageBitmap(bytesToBlob(bytes));
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      if (fixActive(shoot.fix)) {
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
        applyFix(data.data, shoot.fix);
        ctx.putImageData(data, 0, 0);
      }
      const blob = await new Promise<Blob | null>(done =>
        canvas.toBlob(done, 'image/webp', shoot.webpQuality / 100));
      if (!blob) return;
      const out = await api.shoot.bytes(
        shoot.id, 'webp', new Uint8Array(await blob.arrayBuffer()), photo.file);
      if (out.photo) {
        forgetThumb(out.photo.id);
        setPhotos(list => list.map(one => (one.id === out.photo!.id ? out.photo! : one)));
      }
    } catch {
      // RAW Chromium neotevře; převod se u něj prostě neudělá
    }
  }, [shoot]);

  const capture = useCallback(async () => {
    if (!shoot || busy) return;
    setBusy('shot');
    try {
      if (stream) { await shotFromWebcam(); return; }
      const out = await api.shoot.capture(shoot.id);
      if (!out.ok) { note(out.error, true); return; }
      if (out.photo) await alsoWebp(out.photo);
    } finally {
      setBusy('');
    }
  }, [shoot, busy, stream, shotFromWebcam, note, alsoWebp]);

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

          <ShootView
            frame={frame}
            stream={stream}
            media={video}
            ghost={shoot.ghost}
            ghostUrl={ghostUrl}
            overlay={shoot.overlay}
            fix={shoot.fix}
            tool={tool}
            color={color}
            lineWidth={lineWidth}
            selected={selected}
            onSelect={setSelected}
            onAdd={addShape}
            onChange={changeShape}
            onPickWhite={rgb => setFix({ white: rgb, on: true })}
          />

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
              onClick={async () => {
                if (stream) { stopWebcam(); return; }
                await api.shoot.live(!state.live);
                setState(had => (had ? { ...had, live: !had.live } : had));
              }}
              disabled={!connected && !stream}
            >
              {running ? 'Zastavit náhled' : 'Spustit náhled'}
            </button>
            <span className="sh-top-space" />
            <small>{photos.length} {photoWord(photos.length)}</small>
            <button className="sh-mini" onClick={() => api.shoot.openFolder(shoot.id)}>
              <Icon name="folder" size={12} /> Složka
            </button>
          </div>

          <ShootGallery
            photos={photos}
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
