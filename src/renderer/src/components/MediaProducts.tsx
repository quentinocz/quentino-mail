import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MediaProduct, MediaProductSetup, MediaSetup, ProductFacets } from '@shared/types';
import { api } from '../api';
import { toWebp } from '../media';
import { useToast } from '../toast';
import Icon from './Icon';
import MediaCompare from './MediaCompare';

/**
 * Fotky produktů z e-shopu — najít produkt, převést jeho fotky a nahrát je.
 *
 * ## Proč je vidět, co je hotové
 *
 * Katalog má stovky produktů a převádět se budou po jednom, mezi jinou
 * prací, klidně týdny. Bez toho, aby seznam sám ukázal, co ještě chybí, by
 * se muselo pamatovat, kde se minule skončilo — a to je přesně ten důvod,
 * proč se takové úklidy nikdy nedodělají. Stav se bere z adres obrázků ve
 * feedu: přípona v adrese říká, jaký soubor na e-shopu leží.
 *
 * ## Proč se u nahrání zastavíme
 *
 * Fotky se do administrace vloží, ale **staré se nemažou a produkt se
 * neukládá**. Obojí je nevratné a patří člověku, který se na výsledek
 * podívá — aplikace neví, jestli jsou nové fotky oříznuté tak, jak mají
 * být.
 */

type Step = { label: string; state: 'čeká' | 'běží' | 'hotovo' | 'chyba'; note?: string };

interface Shot {
  url: string;
  ext: string;
  /** Cesta k převedenému souboru, jakmile vznikne */
  out: string;
  before: number;
  after: number;
  use: boolean;
  error: string;
}

const FILTERS: { id: 'todo' | 'all' | 'done'; label: string }[] = [
  { id: 'todo', label: 'Chybí WebP' },
  { id: 'all', label: 'Vše s fotkami' },
  { id: 'done', label: 'Hotové' }
];

function pretty(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${bytes} B`;
}

function stateLabel(one: MediaProduct): { text: string; cls: string } {
  if (one.convertedAt) return { text: 'právě nahráno', cls: 'fresh' };
  if (one.state === 'webp') return { text: 'vše WebP', cls: 'ok' };
  if (one.state === 'mixed') return { text: `${one.webp} z ${one.images.length} WebP`, cls: 'half' };
  return { text: `${one.images.length}× chybí`, cls: 'todo' };
}

export default function MediaProducts({ setup }: { setup: MediaSetup }) {
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [only, setOnly] = useState<'todo' | 'all' | 'done'>('todo');
  const [category, setCategory] = useState('');
  const [facets, setFacets] = useState<ProductFacets | null>(null);

  const [items, setItems] = useState<MediaProduct[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [stats, setStats] = useState<{ total: number; webp: number; todo: number; empty: number } | null>(null);

  const [picked, setPicked] = useState<MediaProduct | null>(null);
  const [shots, setShots] = useState<Shot[]>([]);
  const [steps, setSteps] = useState<Step[]>([]);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState<string[]>([]);
  /** Vlastní nastavení produktu; `null` = platí obecné */
  const [own, setOwn] = useState<MediaProductSetup | null>(null);
  /** Která fotka je právě otevřená v srovnání před/po */
  const [compare, setCompare] = useState<number | null>(null);

  /** Roste s každou změnou filtru — odpovědi ze zastaralých dotazů se zahodí */
  const reqId = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 220);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    api.products.facets().then(setFacets).catch(() => setFacets(null));
    api.media.productStats().then(setStats).catch(() => setStats(null));
  }, []);

  const load = useCallback(async () => {
    const id = ++reqId.current;
    setLoading(true);
    try {
      const page = await api.media.products({ query: debounced, category, only, limit: 120 });
      if (id !== reqId.current) return;
      setItems(page.items);
      setTotal(page.total);
    } catch (e: any) {
      if (id === reqId.current) toast(e.message, 'error');
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, [debounced, category, only, toast]);

  useEffect(() => { void load(); }, [load]);

  /** Nově vybraný produkt: fotky z feedu, předvybrané ty, co ještě nejsou WebP. */
  const pick = (one: MediaProduct) => {
    setPicked(one);
    setSteps([]);
    setReady([]);
    setOwn(null);
    api.media.productSetup(one.code).then(setOwn).catch(() => setOwn(null));
    // Přípony počítá hlavní proces — okno jen vybere, co ještě není WebP
    setShots(one.images.map(img =>
      ({ url: img.url, ext: img.ext, out: '', before: 0, after: 0, use: img.ext !== 'webp', error: '' })));
  };

  /**
   * Podle čeho se převádí. Vlastní nastavení produktu přebíjí obecné —
   * a je to vidět v hlášce pod fotkami, ať se nikdo nediví, proč u jednoho
   * produktu vychází jiná velikost.
   */
  const rules: MediaProductSetup = own ?? {
    quality: setup.quality, resize: setup.resize,
    maxWidth: setup.maxWidth, maxHeight: setup.maxHeight,
    exactWidth: setup.exactWidth, exactHeight: setup.exactHeight,
    percent: setup.percent, keepSmaller: setup.keepSmaller
  };

  const step = (label: string, state: Step['state'], note = '') =>
    setSteps(list => {
      const found = list.findIndex(one => one.label === label);
      const next = { label, state, note };
      if (found < 0) return [...list, next];
      return list.map((one, i) => (i === found ? next : one));
    });

  /**
   * Stáhne originály a převede je do WebP.
   *
   * Stažení dělá hlavní proces (fotky jsou na e-shopu), převod okno (kodér
   * je v Chromiu) a uložení zase hlavní proces. Vrací cesty k hotovým
   * souborům, ať se dají rovnou nahrát.
   */
  const convert = useCallback(async (one: MediaProduct, chosen: Shot[]): Promise<string[]> => {
    step('Stažení fotek', 'běží');
    const got = await api.media.productFetch(one.code, chosen.map(s => s.url));
    step('Stažení fotek', 'hotovo',
      `${got.files.length} fotek${got.skipped.length ? ` · ${got.skipped.length} se nestáhlo` : ''}`);
    if (got.skipped.length) toast(`Nestáhlo se: ${got.skipped.join('; ')}`, 'error');

    step('Převod do WebP', 'běží');
    const out: string[] = [];
    let before = 0;
    let after = 0;
    for (let i = 0; i < got.files.length; i++) {
      const file = got.files[i];
      // Adresa ze stejného pořadí říká, ke kterému náhledu výsledek patří
      const url = got.urls[i];
      try {
        const bytes = await api.media.read(file.path);
        const webp = await toWebp(bytes, { ...rules, crop: null });
        const saved = await api.media.productSave(one.code, file.name, webp.bytes);
        out.push(saved.file);
        before += file.size;
        after += saved.size;
        setShots(list => list.map(s =>
          (s.url === url ? { ...s, out: saved.file, before: file.size, after: saved.size, error: '' } : s)));
      } catch (e: any) {
        setShots(list => list.map(s =>
          (s.url === url ? { ...s, error: String(e?.message ?? e) } : s)));
      }
    }
    if (out.length === 0) throw new Error('Nepovedlo se převést ani jednu fotku.');
    step('Převod do WebP', 'hotovo',
      `${out.length} souborů · ${pretty(before)} → ${pretty(after)}`);
    setReady(out);
    return out;
  }, [rules, toast]);

  const chosen = useMemo(() => shots.filter(s => s.use), [shots]);


  const runConvert = async () => {
    if (!picked || chosen.length === 0) return;
    setBusy(true);
    try {
      await convert(picked, chosen);
      toast('Fotky jsou převedené a uložené ve složce produktu.');
    } catch (e: any) {
      step('Převod do WebP', 'chyba', String(e?.message ?? e));
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const runAll = async () => {
    if (!picked || chosen.length === 0) return;
    setBusy(true);
    try {
      const files = ready.length > 0 ? ready : await convert(picked, chosen);
      step('Nahrání do administrace', 'běží');
      const out = await api.media.productUpload(picked.code, files);
      step('Nahrání do administrace', out.filled ? 'hotovo' : 'chyba', out.note);
      toast(out.note, out.filled ? undefined : 'error');
      if (out.filled) {
        // Seznam se překreslí, aby produkt hned dostal značku „právě nahráno"
        await load();
        api.media.productStats().then(setStats).catch(() => {});
      }
    } catch (e: any) {
      step('Nahrání do administrace', 'chyba', String(e?.message ?? e));
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mp-wrap">
      <div className="mp-bar">
        <div className="mp-search">
          <Icon name="search" size={14} />
          <input value={query} onChange={e => setQuery(e.target.value)}
            placeholder="Název nebo kód produktu…" />
          {query && (
            <button className="icon-btn" onClick={() => setQuery('')}><Icon name="x" size={13} /></button>
          )}
        </div>
        <div className="ig-seg">
          {FILTERS.map(f => (
            <button key={f.id} className={only === f.id ? 'active' : ''} onClick={() => setOnly(f.id)}>
              {f.label}
            </button>
          ))}
        </div>
        <select value={category} onChange={e => setCategory(e.target.value)}>
          <option value="">Všechny kategorie</option>
          {(facets?.categories ?? []).map(c => (
            <option key={c.name} value={c.name}>{c.name} ({c.count})</option>
          ))}
        </select>
        <span style={{ flex: 1 }} />
        {stats && (
          <span className="desc mp-stats">
            Hotovo <b>{stats.webp}</b> · chybí <b>{stats.todo}</b>
            {stats.empty > 0 ? ` · bez fotek ${stats.empty}` : ''}
          </span>
        )}
      </div>

      <div className="mp-body">
        <div className="mp-list">
          {loading && items.length === 0 && <p className="desc" style={{ padding: 12 }}>načítám…</p>}
          {!loading && items.length === 0 && (
            <div className="empty-state" style={{ padding: '30px 10px' }}>
              <div className="big">📷</div>
              <p>{only === 'todo' ? 'Všechny produkty mají fotky ve WebP.' : 'Nic k zobrazení.'}</p>
              <p className="desc">
                Stav se bere z feedu. Když katalog ještě nebyl stažený novou verzí aplikace,
                obnov ho v prohlížeči katalogu.
              </p>
            </div>
          )}
          {items.map(one => {
            const tag = stateLabel(one);
            return (
              <button key={one.code} className={`mp-item ${picked?.code === one.code ? 'on' : ''}`}
                onClick={() => pick(one)} disabled={busy}>
                {one.thumb
                  ? <img src={one.thumb} alt="" loading="lazy" />
                  : <span className="mp-noimg"><Icon name="image" size={15} /></span>}
                <span className="mp-name">
                  <b>{one.title}</b>
                  <small className="desc">{one.code} · {one.images.length} fotek</small>
                </span>
                <span className={`mp-tag ${tag.cls}`}>{tag.text}</span>
              </button>
            );
          })}
          {total > items.length && (
            <p className="desc" style={{ padding: '8px 12px' }}>
              Zobrazeno {items.length} z {total} — zpřesni hledáním nebo kategorií.
            </p>
          )}
        </div>

        <div className="mp-detail">
          {!picked ? (
            <div className="empty-state" style={{ padding: '40px 14px' }}>
              <div className="big">🖼️</div>
              <p>Vyber produkt vlevo.</p>
              <p className="desc">
                Aplikace stáhne jeho fotky, převede je do WebP podle nastavení a otevře
                produkt v administraci, kde je nahraje. Staré fotky nemaže a produkt neukládá
                — to zůstává na tobě.
              </p>
            </div>
          ) : (
            <>
              <div className="mp-head">
                <div>
                  <b>{picked.title}</b>
                  <small className="desc">{picked.code}</small>
                </div>
                <span style={{ flex: 1 }} />
                {picked.url && (
                  <a className="btn ghost" href={picked.url} target="_blank" rel="noreferrer">
                    <Icon name="link" size={14} /> Na e-shopu
                  </a>
                )}
                {ready.length > 0 && (
                  <button className="btn ghost" onClick={() => api.media.productReveal(picked.code)}>
                    <Icon name="folder" size={14} /> Složka
                  </button>
                )}
              </div>

              <div className="mp-shots">
                {shots.map((shot, index) => (
                  <label key={shot.url + index} className={`mp-shot ${shot.use ? 'on' : ''}`}>
                    <input type="checkbox" checked={shot.use} disabled={busy}
                      onChange={e => {
                        // Jiný výběr = jiná dávka; hotové soubory z minula už neplatí
                        setReady([]);
                        setShots(list => list.map((s, j) =>
                          (j === index ? { ...s, use: e.target.checked } : s)));
                      }} />
                    <img src={shot.url} alt="" loading="lazy" />
                    <span className={`mp-ext ${shot.ext === 'webp' ? 'ok' : ''}`}>{shot.ext || '?'}</span>
                    {/*
                      * Srovnání před/po. Je u každé fotky zvlášť, protože se
                      * kvalita pozná na konkrétním místě konkrétní fotky —
                      * jedno tlačítko „ukaž náhled" u produktu by nutilo
                      * hádat, která z nich je ta ošemetná.
                      */}
                    <button type="button" className="mp-peek" data-tip="Porovnat před a po"
                      onClick={e => { e.preventDefault(); setCompare(index); }}>
                      <Icon name="search" size={13} /> Porovnat
                    </button>
                    {shot.after > 0 && (
                      <span className="mp-gain">{pretty(shot.before)} → {pretty(shot.after)}</span>
                    )}
                    {shot.error && <span className="mp-gain bad">{shot.error}</span>}
                  </label>
                ))}
              </div>

              <p className="desc mp-hint">
                {own ? 'Vlastní nastavení tohoto produktu' : 'Obecné nastavení konvertoru'}
                : kvalita {rules.quality}
                {rules.resize === 'max' ? `, nejvíc ${rules.maxWidth}×${rules.maxHeight} px`
                  : rules.resize === 'exact' ? `, přesně ${rules.exactWidth}×${rules.exactHeight} px`
                    : rules.resize === 'percent' ? `, na ${rules.percent} % rozměru` : ', rozlišení beze změny'}.
                {shots.some(s => s.ext === 'webp')
                  ? ' Fotky, které už ve WebP jsou, se předem nevybírají.' : ''}
                {own && (
                  <>
                    {' '}
                    <button className="linkish" onClick={() => {
                      api.media.productSetupSave(picked.code, null)
                        .then(() => { setOwn(null); setReady([]); })
                        .catch(e => toast(e.message, 'error'));
                    }}>Vrátit na obecné</button>
                  </>
                )}
              </p>

              {steps.length > 0 && (
                <ol className="mp-steps">
                  {steps.map(one => (
                    <li key={one.label} className={one.state}>
                      <Icon size={13} name={one.state === 'hotovo' ? 'check'
                        : one.state === 'chyba' ? 'alert' : 'clock'} />
                      <span>{one.label}</span>
                      {one.note && <small className="desc">{one.note}</small>}
                    </li>
                  ))}
                </ol>
              )}

              <div className="mp-actions">
                <span className="desc">
                  {chosen.length === 0 ? 'Vyber aspoň jednu fotku' : `Vybráno ${chosen.length} fotek`}
                </span>
                <span style={{ flex: 1 }} />
                <button className="btn ghost" onClick={runConvert} disabled={busy || chosen.length === 0}>
                  <Icon name="download" size={14} /> Jen převést
                </button>
                <button className="btn primary" onClick={runAll}
                  disabled={busy || chosen.length === 0 || !picked.productId}>
                  {busy
                    ? <><span className="spinner-inline" /> pracuju…</>
                    : <><Icon name="zap" size={14} /> Převést a nahrát</>}
                </button>
              </div>
              {!picked.productId && (
                <p className="md-warn">
                  <Icon name="alert" size={13} /> Produkt nemá ve feedu ID, takže se v administraci
                  nedá otevřít. Stáhni katalog znovu a zkus to znovu.
                </p>
              )}
            </>
          )}
        </div>
      </div>
      {compare !== null && picked && shots[compare] && (
        <MediaCompare
          code={picked.code}
          url={shots[compare].url}
          name={`${picked.title} · fotka ${compare + 1}`}
          rules={rules}
          own={!!own}
          base={setup}
          onClose={() => setCompare(null)}
          onSave={value => {
            api.media.productSetupSave(picked.code, value)
              .then(next => {
                setOwn(next);
                // Jiné nastavení = jiný výsledek; hotové soubory z minula už neplatí
                setReady([]);
                toast(next ? 'Nastavení uloženo u produktu.' : 'Platí zase obecné nastavení.');
              })
              .catch(e => toast(e.message, 'error'));
          }}
        />
      )}
    </div>
  );
}
