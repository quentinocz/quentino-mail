import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MediaFile, MediaLogRow, MediaResult, MediaSetup, MediaTool, MediaWatch } from '@shared/types';
import { api } from '../api';
import { bytesToBlob, targetSize, toWebp } from '../media';
import { useToast } from '../toast';
import Icon from './Icon';

/**
 * Konvertor médií — fotky do WebP, videa do WebM.
 *
 * ## Proč to převádí okno, a ne hlavní proces
 *
 * Electron v sobě má celé Chromium i s kodérem WebP. Obrázek se vykreslí
 * na plátno a plátno se uloží — žádná nativní knihovna, žádné překládání
 * při instalaci a na Macu i na Windows stejný výsledek. Hlavní proces jen
 * přečte soubor a zapíše výsledek.
 *
 * ## Co se dělá v jakém pořadí
 *
 * Ořez → zmenšení → komprese. V tomhle pořadí, protože zmenšovat to, co
 * se pak stejně ořízne, znamená zahodit pixely, které jsou ještě potřeba:
 * z oříznuté poloviny fotky zmenšené na 1600 px vyjde ostřejší výsledek než
 * z ořezu už zmenšené fotky.
 *
 * ## Ořez
 *
 * Rámeček se táhne myší přes náhled. Poměr stran jde zamknout — čtverec je
 * předvolba, protože na produktové fotky a na sociální sítě se hodí nejvíc
 * a odhadnout ho okem nejde.
 */

type Stage = 'čeká' | 'převádím' | 'hotovo' | 'chyba';

interface Row {
  file: MediaFile;
  stage: Stage;
  /** Rozměry originálu; zjistí se při načtení náhledu */
  width: number;
  height: number;
  preview: string;
  crop: Crop | null;
  result: MediaResult | null;
  error: string;
  percent: number;
}

/** Ořez v poměrných hodnotách 0–1, aby nezávisel na velikosti náhledu. */
interface Crop { x: number; y: number; w: number; h: number }

const RATIOS: { id: string; label: string; value: number | null }[] = [
  { id: 'free', label: 'Volně', value: null },
  { id: 'square', label: 'Čtverec 1:1', value: 1 },
  { id: 'landscape', label: 'Na šířku 4:3', value: 4 / 3 },
  { id: 'wide', label: 'Široký 16:9', value: 16 / 9 },
  { id: 'portrait', label: 'Na výšku 3:4', value: 3 / 4 }
];

function pretty(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${bytes} B`;
}

export default function MediaModal({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [setup, setSetup] = useState<MediaSetup | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [tool, setTool] = useState<MediaTool | null>(null);
  const [cropping, setCropping] = useState<number | null>(null);
  const [tab, setTab] = useState<'files' | 'watch' | 'setup'>('files');
  const [size, setSize] = useState<'normal' | 'full'>(
    () => (localStorage.getItem('mediaSize') as 'normal' | 'full') || 'normal'
  );

  useEffect(() => {
    api.media.setup().then(setSetup).catch(() => {});
    api.media.ffmpeg().then(setTool).catch(() => {});
  }, []);

  useEffect(() => api.on('media:progress', (p: { file: string; percent: number }) => {
    setRows(list => list.map(row =>
      (row.file.name === p.file ? { ...row, percent: p.percent } : row)));
  }), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy && cropping === null) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy, cropping]);

  const patch = (part: Partial<MediaSetup>) => {
    setSetup(prev => (prev ? { ...prev, ...part } : prev));
    api.media.saveSetup(part).catch(() => {});
  };

  /*
   * Náhled se drží jako `blob:` adresa, ne jako base64. U dvaceti fotek po
   * pěti megabajtech by se z base64 stalo sto padesát megabajtů řetězců
   * v paměti okna.
   */
  const load = useCallback(async (files: MediaFile[]) => {
    const fresh: Row[] = [];
    for (const file of files) {
      const row: Row = {
        file, stage: 'čeká', width: 0, height: 0, preview: '',
        crop: null, result: null, error: '', percent: 0
      };
      if (file.kind === 'image') {
        try {
          const bytes = await api.media.read(file.path);
          const blob = bytesToBlob(bytes);
          row.preview = URL.createObjectURL(blob);
          const bitmap = await createImageBitmap(blob);
          row.width = bitmap.width;
          row.height = bitmap.height;
          bitmap.close();
        } catch {
          row.error = 'soubor se nepodařilo přečíst';
          row.stage = 'chyba';
        }
      }
      fresh.push(row);
    }
    setRows(list => [...list, ...fresh]);
  }, []);

  const pick = async () => {
    try {
      const files = await api.media.pick();
      if (files.length > 0) await load(files);
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  /** Přetažení do okna — prohlížeč dá jen cestu, zbytek zjistí hlavní proces. */
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    const paths = [...e.dataTransfer.files].map(f => (f as any).path).filter(Boolean);
    if (paths.length === 0) return;
    try {
      await load(await api.media.add(paths));
    } catch (err: any) {
      toast(err.message, 'error');
    }
  };

  /**
   * Převod jednoho obrázku.
   *
   * Ořez → zmenšení → komprese, přesně v tomhle pořadí. Kreslí se přes
   * `drawImage` s výřezem, takže se zmenšuje až to, co ve výsledku zůstane.
   */
  const convertImage = useCallback(async (row: Row, s: MediaSetup): Promise<MediaResult> => {
    const bytes = await api.media.read(row.file.path);
    const out = await toWebp(bytes, { ...s, crop: row.crop });
    const name = `${row.file.name.replace(/\.[^.]+$/, '')}.webp`;
    const saved = await api.media.write(name, out.bytes);
    return { file: saved.file, name, before: row.file.size, after: saved.size };
  }, []);

  const run = async () => {
    if (!setup) return;
    setBusy(true);
    try {
      for (let i = 0; i < rows.length; i++) {
        if (rows[i].stage === 'hotovo') continue;
        setRows(list => list.map((r, j) => (j === i ? { ...r, stage: 'převádím', error: '', percent: 0 } : r)));
        try {
          const result = rows[i].file.kind === 'image'
            ? await convertImage(rows[i], setup)
            : await api.media.video(rows[i].file.path);
          setRows(list => list.map((r, j) =>
            (j === i ? { ...r, stage: 'hotovo', result, percent: 100 } : r)));
        } catch (e: any) {
          setRows(list => list.map((r, j) =>
            (j === i ? { ...r, stage: 'chyba', error: String(e.message ?? e) } : r)));
        }
      }
      toast('Hotovo. Soubory jsou ve výstupní složce.');
    } finally {
      setBusy(false);
    }
  };

  const done = rows.filter(r => r.stage === 'hotovo' && r.result);
  const saved = useMemo(() => done.reduce((sum, r) => sum + (r.result!.before - r.result!.after), 0), [done]);
  const videos = rows.filter(r => r.file.kind === 'video').length;

  return (
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className={`modal md-modal md-${size}`} onDragOver={e => e.preventDefault()} onDrop={onDrop}>
        <div className="modal-head">
          <span className="modal-title"><Icon name="image" size={15} /> Konvertor médií</span>
          <span style={{ flex: 1 }} />
          <div className="ig-seg">
            <button className={tab === 'files' ? 'active' : ''} onClick={() => setTab('files')}>Soubory</button>
            <button className={tab === 'watch' ? 'active' : ''} onClick={() => setTab('watch')}>Focení</button>
            <button className={tab === 'setup' ? 'active' : ''} onClick={() => setTab('setup')}>Nastavení</button>
          </div>
          <button className="icon-btn"
            onClick={() => {
              const next = size === 'full' ? 'normal' : 'full';
              setSize(next);
              localStorage.setItem('mediaSize', next);
            }}
            data-tip={size === 'full' ? 'Zmenšit okno' : 'Na celou obrazovku'}>
            <Icon name={size === 'full' ? 'shrink' : 'expand'} size={15} />
          </button>
          <button className="icon-btn" onClick={onClose} disabled={busy}><Icon name="x" size={16} /></button>
        </div>

        {tab === 'files' ? (
          <>
            <div className="md-bar">
              <button className="btn" onClick={pick} disabled={busy}>
                <Icon name="plus" size={14} /> Vybrat soubory
              </button>
              <span className="desc">nebo je sem přetáhni</span>
              <span style={{ flex: 1 }} />
              {done.length > 0 && (
                <span className="md-saved">
                  Ušetřeno {pretty(Math.max(0, saved))} z {done.length} souborů
                </span>
              )}
              <button className="btn ghost" onClick={() => api.media.outDir().then(dir => patch({ outDir: dir }))}
                disabled={busy}>
                <Icon name="folder" size={14} /> Kam ukládat
              </button>
              <button className="btn primary" onClick={run} disabled={busy || rows.length === 0}>
                {busy ? <><span className="spinner-inline" /> převádím…</> : <><Icon name="zap" size={14} /> Převést</>}
              </button>
            </div>

            {videos > 0 && tool && !tool.ok && (
              <p className="md-warn">
                <Icon name="alert" size={13} /> {tool.note}
              </p>
            )}

            <div className="modal-body md-list">
              {rows.length === 0 && (
                <div className="empty-state" style={{ padding: '40px 10px' }}>
                  <div className="big">🖼️</div>
                  <p>Přetáhni sem fotky nebo videa.</p>
                  <p className="desc">
                    Fotky se převedou do WebP, videa do WebM. Originály zůstanou nedotčené —
                    výsledky se ukládají zvlášť.
                  </p>
                </div>
              )}
              {rows.map((row, index) => {
                const target = setup && row.width
                  ? targetSize(
                    Math.round((row.crop?.w ?? 1) * row.width),
                    Math.round((row.crop?.h ?? 1) * row.height),
                    setup)
                  : null;
                return (
                  <div className={`md-row ${row.stage === 'chyba' ? 'bad' : ''}`} key={row.file.path + index}>
                    {row.preview
                      ? <img src={row.preview} alt="" />
                      : <span className="md-noimg"><Icon name={row.file.kind === 'video' ? 'image' : 'image'} size={16} /></span>}
                    <div className="md-main">
                      <b>{row.file.name}</b>
                      <small className="desc">
                        {pretty(row.file.size)}
                        {row.width ? ` · ${row.width}×${row.height} px` : ''}
                        {target && (target.width !== row.width || target.height !== row.height)
                          ? ` → ${target.width}×${target.height} px` : ''}
                        {row.crop ? ' · oříznuto' : ''}
                      </small>
                      {row.stage === 'hotovo' && row.result && (
                        <small className="md-ok">
                          {pretty(row.result.before)} → <b>{pretty(row.result.after)}</b>
                          {' '}({Math.max(0, Math.round((1 - row.result.after / row.result.before) * 100))} % míň)
                        </small>
                      )}
                      {row.stage === 'chyba' && <small className="md-bad">{row.error}</small>}
                      {row.stage === 'převádím' && row.file.kind === 'video' && (
                        <div className="md-progress"><span style={{ width: `${row.percent}%` }} /></div>
                      )}
                    </div>
                    {row.file.kind === 'image' && (
                      <button className="icon-btn" data-tip="Oříznout" disabled={busy}
                        onClick={() => setCropping(index)}>
                        <Icon name="expand" size={15} />
                      </button>
                    )}
                    {row.result && (
                      <button className="icon-btn" data-tip="Ukázat ve složce"
                        onClick={() => api.media.reveal(row.result!.file)}>
                        <Icon name="folder" size={15} />
                      </button>
                    )}
                    <button className="icon-btn" disabled={busy}
                      onClick={() => setRows(list => list.filter((_, j) => j !== index))}>
                      <Icon name="x" size={15} />
                    </button>
                  </div>
                );
              })}
            </div>
          </>
        ) : tab === 'watch' ? (
          <WatchFolders />
        ) : (
          setup && <MediaSettings setup={setup} tool={tool} onPatch={patch} onTool={setTool} />
        )}
      </div>

      {cropping !== null && rows[cropping] && (
        <CropDialog
          row={{
            name: rows[cropping].file.name, preview: rows[cropping].preview,
            width: rows[cropping].width, height: rows[cropping].height, crop: rows[cropping].crop
          }}
          allLabel="Použít na všechny fotky"
          onClose={() => setCropping(null)}
          onApply={(crop, toAll) => {
            setRows(list => list.map((r, j) =>
              (toAll ? (r.file.kind === 'image' ? { ...r, crop } : r) : (j === cropping ? { ...r, crop } : r))));
            setCropping(null);
          }}
        />
      )}
    </div>
  );
}

/* ==================== Hlídané složky pro focení ==================== */

/**
 * Složky, do kterých se sypou fotky z foťáku.
 *
 * Nafotí se deset motýlků nastejno a všechny se ořezávají stejně. Ořez se
 * nastaví **jednou, podle jedné fotky**, a co do složky přibude, se zpracuje
 * samo — i se zavřeným tímhle oknem. Výsledky jdou do podsložky vedle
 * originálů, takže leží u sebe a nemíchají se.
 */
function WatchFolders() {
  const toast = useToast();
  const [folders, setFolders] = useState<MediaWatch[]>([]);
  const [log, setLog] = useState<MediaLogRow[]>([]);
  const [cropping, setCropping] = useState<{ folder: MediaWatch; target: CropTarget } | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    api.media.watches().then(setFolders).catch(() => {});
    api.media.watchLog().then(setLog).catch(() => {});
  }, []);
  useEffect(reload, [reload]);
  // Zpracované fotky se hlásí i sem, ať je vidět, že hlídání jede
  useEffect(() => api.on('media:watched', (p: { log: MediaLogRow[] }) => {
    setLog(p.log);
    api.media.watches().then(setFolders).catch(() => {});
  }), []);

  const save = async (id: string, patch: Partial<MediaWatch>) => {
    try {
      setFolders(await api.media.watchSave(id, patch));
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  /**
   * Ořez se nastavuje podle **nejnovější fotky ve složce** — té, co se
   * právě nafotila. Nastavovat ho naslepo bez fotky nedává smysl: je to
   * rámeček kolem motýlka, ne abstraktní obdélník.
   */
  const setCrop = async (folder: MediaWatch) => {
    setBusy(true);
    try {
      const newest = await api.media.watchNewest(folder.path);
      if (!newest) {
        toast('Ve složce zatím žádná fotka není — nafoť jednu a zkus to znovu.', 'error');
        return;
      }
      const bytes = await api.media.read(newest.path);
      const blob = bytesToBlob(bytes);
      const bitmap = await createImageBitmap(blob);
      setCropping({
        folder,
        target: {
          name: newest.name, preview: URL.createObjectURL(blob),
          width: bitmap.width, height: bitmap.height, crop: folder.crop
        }
      });
      bitmap.close();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-body md-watch">
      <p className="desc">
        Co do hlídané složky přibude, aplikace sama ořízne a převede do WebP — i když
        je tohle okno zavřené. Výsledky se ukládají do podsložky uvnitř, originály
        zůstávají nedotčené. Ořez se nastaví jednou podle jedné fotky a použije se na
        všechny další; bez ořezu se jen převádí.
      </p>

      <button className="btn" onClick={() => api.media.watchAdd().then(setFolders)} disabled={busy}>
        <Icon name="plus" size={14} /> Přidat složku
      </button>

      {folders.length === 0 && (
        <div className="empty-state" style={{ padding: '24px 10px' }}>
          <div className="big">📸</div>
          <p>Zatím žádná hlídaná složka.</p>
          <p className="desc">
            Přidej složku, kam ukládáš fotky z foťáku, a nastav u ní ořez podle první fotky.
          </p>
        </div>
      )}

      {folders.map(folder => (
        <section className={`md-folder ${folder.enabled ? 'on' : ''}`} key={folder.id}>
          <header>
            <label className="check-row">
              <input type="checkbox" checked={folder.enabled}
                onChange={e => save(folder.id, { enabled: e.target.checked })} />
              <b>{folder.path.split(/[\\/]/).filter(Boolean).pop()}</b>
            </label>
            <span className="desc md-path">{folder.path}</span>
            <span style={{ flex: 1 }} />
            {folder.done > 0 && (
              <span className="md-count">
                {folder.done} fotek
                {folder.lastAt ? ` · naposledy ${new Date(folder.lastAt).toLocaleTimeString('cs-CZ')}` : ''}
              </span>
            )}
            <button className="icon-btn" data-tip="Ukázat složku"
              onClick={() => api.media.reveal(folder.path)}>
              <Icon name="folder" size={15} />
            </button>
            <button className="icon-btn" data-tip="Přestat hlídat"
              onClick={() => api.media.watchRemove(folder.id).then(setFolders)}>
              <Icon name="trash" size={15} />
            </button>
          </header>

          <div className="md-folder-body">
            <div className="md-folder-crop">
              <span className="desc">Ořez</span>
              <b>{folder.crop
                ? `${Math.round(folder.crop.w * 100)} × ${Math.round(folder.crop.h * 100)} % plochy`
                : 'bez ořezu — jen převod'}</b>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn ghost" onClick={() => setCrop(folder)} disabled={busy}>
                  <Icon name="expand" size={13} /> {folder.crop ? 'Upravit' : 'Nastavit'}
                </button>
                {folder.crop && (
                  <button className="btn ghost" onClick={() => save(folder.id, { crop: null })}>
                    Zrušit ořez
                  </button>
                )}
              </div>
            </div>

            <div className="md-folder-opts">
              <div className="field">
                <label>Podsložka</label>
                <input value={folder.subfolder}
                  onChange={e => save(folder.id, { subfolder: e.target.value })} />
              </div>
              <div className="field">
                <label>Kvalita: {folder.quality}</label>
                <input type="range" min={40} max={100} value={folder.quality}
                  onChange={e => save(folder.id, { quality: Number(e.target.value) })} />
              </div>
              <div className="field">
                <label>Rozlišení</label>
                <select value={folder.resize}
                  onChange={e => save(folder.id, { resize: e.target.value as any })}>
                  <option value="keep">Zachovat</option>
                  <option value="max">Zmenšit do mezí</option>
                  <option value="exact">Přesný rozměr</option>
                  <option value="percent">Procenta</option>
                </select>
              </div>
              {folder.resize === 'max' && (
                <div className="field">
                  <label>Nejvíc (px)</label>
                  <input type="number" min={64} max={8000} value={folder.maxWidth}
                    onChange={e => save(folder.id, {
                      maxWidth: Number(e.target.value) || 1600,
                      maxHeight: Number(e.target.value) || 1600
                    })} />
                </div>
              )}
              {folder.resize === 'exact' && (
                <div className="field">
                  <label>Rozměr (px)</label>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input type="number" min={16} max={8000} value={folder.exactWidth}
                      onChange={e => save(folder.id, { exactWidth: Number(e.target.value) || 1000 })} />
                    <input type="number" min={16} max={8000} value={folder.exactHeight}
                      onChange={e => save(folder.id, { exactHeight: Number(e.target.value) || 1000 })} />
                  </div>
                </div>
              )}
              {folder.resize === 'percent' && (
                <div className="field">
                  <label>Procenta: {folder.percent} %</label>
                  <input type="range" min={10} max={100} step={5} value={folder.percent}
                    onChange={e => save(folder.id, { percent: Number(e.target.value) })} />
                </div>
              )}
            </div>
          </div>
        </section>
      ))}

      {log.length > 0 && (
        <section className="md-log">
          <h3>Poslední zpracované</h3>
          {log.slice(0, 12).map((row, index) => (
            <div className={`md-log-row ${row.error ? 'bad' : ''}`} key={index}>
              <span className="desc">{new Date(row.at).toLocaleTimeString('cs-CZ')}</span>
              <b>{row.name}</b>
              {row.error
                ? <span className="md-bad">{row.error}</span>
                : <span className="md-ok">{pretty(row.before)} → {pretty(row.after)}</span>}
            </div>
          ))}
        </section>
      )}

      {cropping && (
        <CropDialog
          row={cropping.target}
          onClose={() => setCropping(null)}
          onApply={crop => { void save(cropping.folder.id, { crop }); setCropping(null); }}
        />
      )}
    </div>
  );
}

/* ==================== Nastavení ==================== */

function MediaSettings({ setup, tool, onPatch, onTool }: {
  setup: MediaSetup;
  tool: MediaTool | null;
  onPatch: (part: Partial<MediaSetup>) => void;
  onTool: (tool: MediaTool) => void;
}) {
  const [ffmpeg, setFfmpeg] = useState('');
  return (
    <div className="modal-body md-setup">
      <section>
        <h3>Fotky → WebP</h3>
        <div className="field">
          <label>Kvalita: {setup.quality}</label>
          <input type="range" min={40} max={100} value={setup.quality}
            onChange={e => onPatch({ quality: Number(e.target.value) })} />
          <span className="desc">
            Kolem 80 je hranice, kde na fotce látky ještě nejsou vidět artefakty a soubor už je
            zlomkový. Nad 90 roste velikost rychleji než kvalita.
          </span>
        </div>

        <div className="field">
          <label>Rozlišení</label>
          <select value={setup.resize} onChange={e => onPatch({ resize: e.target.value as any })}>
            <option value="keep">Zachovat</option>
            <option value="max">Zmenšit, aby se vešlo do mezí</option>
            <option value="exact">Přesný rozměr</option>
            <option value="percent">Procenta původní velikosti</option>
          </select>
        </div>

        {setup.resize === 'max' && (
          <div className="field-grid">
            <div className="field"><label>Nejvíc na šířku (px)</label>
              <input type="number" min={64} max={8000} value={setup.maxWidth}
                onChange={e => onPatch({ maxWidth: Number(e.target.value) || 1600 })} /></div>
            <div className="field"><label>Nejvíc na výšku (px)</label>
              <input type="number" min={64} max={8000} value={setup.maxHeight}
                onChange={e => onPatch({ maxHeight: Number(e.target.value) || 1600 })} /></div>
          </div>
        )}
        {setup.resize === 'exact' && (
          <div className="field-grid">
            <div className="field"><label>Šířka (px)</label>
              <input type="number" min={16} max={8000} value={setup.exactWidth}
                onChange={e => onPatch({ exactWidth: Number(e.target.value) || 1000 })} /></div>
            <div className="field"><label>Výška (px)</label>
              <input type="number" min={16} max={8000} value={setup.exactHeight}
                onChange={e => onPatch({ exactHeight: Number(e.target.value) || 1000 })} /></div>
          </div>
        )}
        {setup.resize === 'percent' && (
          <div className="field">
            <label>Procenta původní velikosti: {setup.percent} %</label>
            <input type="range" min={10} max={100} step={5} value={setup.percent}
              onChange={e => onPatch({ percent: Number(e.target.value) })} />
          </div>
        )}

        <label className="check-row">
          <input type="checkbox" checked={setup.keepSmaller}
            onChange={e => onPatch({ keepSmaller: e.target.checked })} />
          menší obrázek nezvětšovat
        </label>
        <span className="desc">
          Z malé fotky se velká neudělá — jen rozmazaná, a soubor přitom naroste.
        </span>
      </section>

      <section>
        <h3>Videa → WebM</h3>
        {tool && (
          <p className={tool.ok ? 'desc' : 'md-warn'}>
            {tool.ok
              ? `ffmpeg nalezen: ${tool.path}`
              : <><Icon name="alert" size={13} /> {tool.note}</>}
          </p>
        )}
        {tool && !tool.ok && (
          <div className="field">
            <label>Cesta k ffmpeg</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input value={ffmpeg} placeholder="/opt/homebrew/bin/ffmpeg"
                onChange={e => setFfmpeg(e.target.value)} />
              <button className="btn ghost" onClick={async () => {
                await api.media.ffmpegPath(ffmpeg);
                onTool(await api.media.ffmpeg());
              }}>Ověřit</button>
            </div>
          </div>
        )}

        <div className="field-grid">
          <div className="field"><label>Kodek</label>
            <select value={setup.videoCodec} onChange={e => onPatch({ videoCodec: e.target.value as any })}>
              <option value="vp9">VP9 — menší soubor</option>
              <option value="vp8">VP8 — rychlejší převod</option>
            </select></div>
          <div className="field"><label>Šířka (px, 0 = zachovat)</label>
            <input type="number" min={0} max={3840} step={160} value={setup.videoWidth}
              onChange={e => onPatch({ videoWidth: Number(e.target.value) || 0 })} /></div>
        </div>
        <div className="field">
          <label>Kvalita videa (CRF): {setup.videoCrf}</label>
          <input type="range" min={18} max={45} value={setup.videoCrf}
            onChange={e => onPatch({ videoCrf: Number(e.target.value) })} />
          <span className="desc">
            Nižší číslo = lepší obraz a větší soubor. Kolem 33 je rozumný web; pod 25 už je to
            zbytečně velké, nad 40 to je vidět.
          </span>
        </div>
        <div className="field">
          <label>Zvuk (kb/s, 0 = bez zvuku)</label>
          <input type="number" min={0} max={256} step={16} value={setup.videoAudio}
            onChange={e => onPatch({ videoAudio: Number(e.target.value) || 0 })} />
        </div>
      </section>

      <section>
        <h3>Kam se ukládá</h3>
        <div className="field">
          <input value={setup.outDir} readOnly placeholder="Stažené soubory / quentino-web" />
          <span className="desc">
            Originály se nikdy nepřepisují — jsou jediná verze, ze které jde převod udělat znovu jinak.
          </span>
        </div>
      </section>
    </div>
  );
}

/* ==================== Ořez ==================== */

/**
 * Ořezávátko.
 *
 * Rámeček se táhne myší přes náhled a drží se v poměrných hodnotách 0–1,
 * takže nezávisí na tom, jak velký náhled zrovna je — a dá se použít
 * i na jiné fotky ve stejném poměru. Poměr stran jde zamknout: čtverec
 * okem neodhadne nikdo.
 */
interface CropTarget {
  name: string;
  preview: string;
  width: number;
  height: number;
  crop: Crop | null;
}

function CropDialog({ row, onClose, onApply, allLabel }: {
  row: CropTarget;
  onClose: () => void;
  onApply: (crop: Crop | null, toAll: boolean) => void;
  /** Text tlačítka „použít na všechny"; prázdné = tlačítko se neukáže */
  allLabel?: string;
}) {
  const [ratio, setRatio] = useState<string>('free');
  const [crop, setCrop] = useState<Crop>(row.crop ?? { x: 0.1, y: 0.1, w: 0.8, h: 0.8 });
  const boxRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ startX: number; startY: number; from: Crop; mode: string } | null>(null);

  const lock = RATIOS.find(r => r.id === ratio)?.value ?? null;

  /*
   * Poměr se počítá v pixelech, ne v poměrných hodnotách: u fotky na šířku
   * je „polovina šířky" jiný kus než „polovina výšky" a čtverec zadaný
   * v poměrných hodnotách by čtverec nebyl.
   */
  const applyRatio = useCallback((next: Crop): Crop => {
    if (!lock || !row.width || !row.height) return next;
    const pixelW = next.w * row.width;
    const wantH = pixelW / lock;
    const h = Math.min(1, wantH / row.height);
    return { ...next, h, y: Math.min(next.y, 1 - h) };
  }, [lock, row.width, row.height]);

  useEffect(() => { setCrop(c => applyRatio(c)); }, [ratio, applyRatio]);

  const onDown = (mode: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    drag.current = { startX: e.clientX, startY: e.clientY, from: crop, mode };
  };

  useEffect(() => {
    const move = (e: MouseEvent) => {
      const state = drag.current;
      const box = boxRef.current?.getBoundingClientRect();
      if (!state || !box) return;
      const dx = (e.clientX - state.startX) / box.width;
      const dy = (e.clientY - state.startY) / box.height;
      const from = state.from;

      let next: Crop;
      if (state.mode === 'move') {
        next = {
          ...from,
          x: Math.max(0, Math.min(1 - from.w, from.x + dx)),
          y: Math.max(0, Math.min(1 - from.h, from.y + dy))
        };
      } else {
        // Táhne se za roh: mění se šířka i výška, počátek zůstává
        const w = Math.max(0.05, Math.min(1 - from.x, from.w + dx));
        const h = Math.max(0.05, Math.min(1 - from.y, from.h + dy));
        next = applyRatio({ ...from, w, h });
      }
      setCrop(next);
    };
    const up = () => { drag.current = null; };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
  }, [applyRatio]);

  const pixels = {
    w: Math.round(crop.w * row.width),
    h: Math.round(crop.h * row.height)
  };

  return (
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal md-crop">
        <div className="modal-head">
          <span className="modal-title"><Icon name="expand" size={15} /> Ořez — {row.name}</span>
          <span style={{ flex: 1 }} />
          <button className="icon-btn" onClick={onClose}><Icon name="x" size={16} /></button>
        </div>
        <div className="modal-body">
          <div className="md-ratios">
            {RATIOS.map(one => (
              <button key={one.id} className={`filter-chip ${ratio === one.id ? 'on' : ''}`}
                onClick={() => setRatio(one.id)}>{one.label}</button>
            ))}
            <span style={{ flex: 1 }} />
            <span className="desc">{pixels.w} × {pixels.h} px</span>
          </div>
          <div className="md-canvas" ref={boxRef}>
            <img src={row.preview} alt="" draggable={false} />
            <div className="md-shade" style={{
              clipPath: `polygon(0 0, 100% 0, 100% 100%, 0 100%, 0 0,
                ${crop.x * 100}% ${crop.y * 100}%,
                ${crop.x * 100}% ${(crop.y + crop.h) * 100}%,
                ${(crop.x + crop.w) * 100}% ${(crop.y + crop.h) * 100}%,
                ${(crop.x + crop.w) * 100}% ${crop.y * 100}%,
                ${crop.x * 100}% ${crop.y * 100}%)`
            }} />
            <div className="md-frame" onMouseDown={onDown('move')} style={{
              left: `${crop.x * 100}%`, top: `${crop.y * 100}%`,
              width: `${crop.w * 100}%`, height: `${crop.h * 100}%`
            }}>
              <span className="md-handle" onMouseDown={onDown('resize')} />
            </div>
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn ghost" onClick={() => onApply(null, false)}>Zrušit ořez</button>
          <span style={{ flex: 1 }} />
          {allLabel && (
            <button className="btn ghost" onClick={() => onApply(crop, true)}>{allLabel}</button>
          )}
          <button className="btn primary" onClick={() => onApply(crop, false)}>
            <Icon name="check" size={13} /> Použít
          </button>
        </div>
      </div>
    </div>
  );
}
