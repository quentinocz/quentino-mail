import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  PtransConsistency, PtransField, PtransOverview, PtransProduct, PtransProgress, PtransQuery, PtransState,
  PtransMemoryEntry, PtransMemoryKind, PtransMemoryStat
} from '@shared/types';
import { api } from '../api';
import { useToast } from '../toast';
import Icon from './Icon';
import PtransSettingsPanel from './PtransSettings';

/**
 * Překlady produktů.
 *
 * Práce má dvě roviny a obrazovka je drží oddělené: **seznam** odpovídá na
 * otázku „co je potřeba udělat" (proto jsou filtry postavené na stavu překladu,
 * ne na kategoriích), **detail** na otázku „je to dobře přeložené" (proto vedle
 * sebe zdroj a překlad, ne jen výsledek).
 *
 * Hromadný překlad běží v hlavním procesu, takže se sem průběh jen posílá.
 * Okno se dá zavřít a překlad běží dál.
 */

const STATE_LABEL: Record<PtransState, string> = {
  missing: 'chybí',
  same: 'čeština',
  source: 'zdrojový jazyk',
  stale: 'zdroj se změnil',
  manual: 'ručně',
  ok: 'hotovo'
};

const STATE_TONE: Record<PtransState, string> = {
  missing: 'miss', same: 'src', source: 'src', stale: 'stale', manual: 'manual', ok: 'ok'
};

const FIELD_LABEL: Record<string, string> = {
  title: 'Název',
  short: 'Krátký popis',
  long: 'Dlouhý popis',
  seo_title: 'SEO titulek',
  seo_desc: 'SEO popis',
  seo_url: 'SEO adresa',
  redirect: 'Přesměrování 301',
  google_title: 'Google titulek',
  google_desc: 'Google popis'
};

const FIELD_ORDER = ['title', 'short', 'long', 'seo_title', 'seo_desc', 'seo_url', 'redirect',
  'google_title', 'google_desc'];

function fieldLabel(field: string): string {
  const param = field.match(/^param:(\d+):(name|value)$/);
  if (param) return `Parametr ${Number(param[1]) + 1} — ${param[2] === 'name' ? 'název' : 'hodnota'}`;
  return FIELD_LABEL[field] ?? field;
}

/** „2 min 30 s" — u odhadů je vteřinová přesnost k ničemu. */
function humanTime(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '—';
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s`;
  const min = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  if (min < 60) return rest > 5 ? `${min} min ${rest} s` : `${min} min`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

function relTime(iso: string | null): string {
  if (!iso) return 'nikdy';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'před chvílí';
  if (diff < 3_600_000) return `před ${Math.floor(diff / 60_000)} min`;
  if (diff < 86_400_000) return `před ${Math.floor(diff / 3_600_000)} h`;
  return new Date(iso).toLocaleDateString('cs-CZ');
}

export default function ProductsModal({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [overview, setOverview] = useState<PtransOverview | null>(null);
  const [tab, setTab] = useState<'work' | 'consistency' | 'memory' | 'settings'>('work');

  const [query, setQuery] = useState<PtransQuery>({ state: 'todo', limit: 60, offset: 0 });
  const [search, setSearch] = useState('');
  const [page, setPage] = useState<{ rows: PtransProduct[]; total: number; todo: number }>(
    { rows: [], total: 0, todo: 0 }
  );
  const [loading, setLoading] = useState(false);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [active, setActive] = useState<string | null>(null);
  const [fields, setFields] = useState<PtransField[]>([]);
  /** Které jazykové sloupce jsou v detailu vidět (výchozí: všechny zapnuté) */
  const [shownLangs, setShownLangs] = useState<string[]>([]);
  const [busyField, setBusyField] = useState('');
  const [runOpen, setRunOpen] = useState(false);
  const [progress, setProgress] = useState<PtransProgress | null>(null);

  const langs = useMemo(
    () => (overview?.settings.languages ?? []).filter(l => l.enabled),
    [overview]
  );

  /* ---------- načítání ---------- */

  const loadOverview = useCallback(async () => {
    try {
      const data = await api.ptrans.overview();
      setOverview(data);
      setProgress(data.running);
      setShownLangs(prev => (prev.length
        ? prev
        : data.settings.languages.filter(l => l.enabled).map(l => l.code)));
    } catch (e: any) {
      toast(e.message, 'error');
    }
  }, [toast]);

  const loadPage = useCallback(async () => {
    setLoading(true);
    try {
      setPage(await api.ptrans.list(query));
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setLoading(false);
    }
  }, [query, toast]);

  useEffect(() => { loadOverview(); }, [loadOverview]);
  useEffect(() => { loadPage(); }, [loadPage]);
  useEffect(() => api.on('ptrans:progress', (p: PtransProgress) => setProgress(p)), []);
  useEffect(() => api.on('ptrans:changed', () => { loadPage(); loadOverview(); }), [loadPage, loadOverview]);

  // Hledání se posílá se zpožděním, ať se při psaní nedotazuje na každé písmeno
  useEffect(() => {
    const timer = setTimeout(() => setQuery(q => ({ ...q, search, offset: 0 })), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const loadFields = useCallback(async (code: string) => {
    try {
      setFields(await api.ptrans.fields(code));
    } catch (e: any) {
      toast(e.message, 'error');
    }
  }, [toast]);

  useEffect(() => {
    if (!active) { setFields([]); return; }
    loadFields(active);
  }, [active, loadFields]);

  /* ---------- výběr ---------- */

  const toggle = (code: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code); else next.add(code);
      return next;
    });
  };

  const selectAllVisible = () => {
    setSelected(prev => {
      const next = new Set(prev);
      const all = page.rows.every(row => next.has(row.code));
      for (const row of page.rows) {
        if (all) next.delete(row.code); else next.add(row.code);
      }
      return next;
    });
  };

  /* ---------- akce ---------- */

  const refreshFeed = async () => {
    setLoading(true);
    try {
      const result = await api.ptrans.refresh();
      toast(`Feed načten: ${result.products} produktů`);
      await loadOverview();
      await loadPage();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  const importFile = async () => {
    try {
      const result = await api.ptrans.importFile();
      if (!result) return;
      toast(result.paired > 0
        ? `Načteno ${result.products} produktů, ${result.paired} se spárovalo s feedem`
        : `Načteno ${result.products} produktů ze souboru`);
      await loadOverview();
      await loadPage();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const saveField = async (row: PtransField, value: string) => {
    try {
      await api.ptrans.edit(row.code, row.lang, row.field, value);
      await loadFields(row.code);
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const retranslate = async (row: PtransField) => {
    setBusyField(`${row.lang}:${row.field}`);
    try {
      await api.ptrans.retranslate(row.code, row.lang, row.field);
      await loadFields(row.code);
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusyField('');
    }
  };

  const generate = async (row: PtransField, kind: 'seo_title' | 'seo_desc' | 'google_desc') => {
    setBusyField(`${row.lang}:${row.field}`);
    try {
      await api.ptrans.generateSeo(row.code, row.lang, kind);
      await loadFields(row.code);
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusyField('');
    }
  };

  const exportXml = async () => {
    try {
      const codes = selected.size > 0 ? [...selected] : undefined;
      const result = await api.ptrans.export({ codes });
      if (result) toast(`Uloženo: ${result.products} produktů, ${result.fields} textů`);
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const googleTitles = async () => {
    if (selected.size === 0) { toast('Nejdřív vyber produkty.', 'error'); return; }
    try {
      const result = await api.ptrans.googleTitles([...selected]);
      toast(result.written > 0
        ? `Titulky doplněny u ${result.written} položek`
        : 'Není nastavená šablona titulku (Nastavení → Google)', result.written ? 'info' : 'error');
      await loadPage();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  /**
   * Pole se v detailu neseskupují po jazycích, ale po polích: jeden řádek =
   * jedno pole a v něm zdroj a vedle sebe všechny jazyky. Tak je na první pohled
   * vidět, co je přeložené a co ne, a nemusí se nikam přepínat.
   */
  const fieldRows = useMemo(() => {
    const keys: string[] = [];
    for (const row of fields) if (!keys.includes(row.field)) keys.push(row.field);
    keys.sort((a, b) => {
      const ia = FIELD_ORDER.indexOf(a);
      const ib = FIELD_ORDER.indexOf(b);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
    return keys.map(field => ({
      field,
      source: fields.find(row => row.field === field)?.source ?? '',
      byLang: Object.fromEntries(
        fields.filter(row => row.field === field).map(row => [row.lang, row])
      ) as Record<string, PtransField>
    }));
  }, [fields]);

  const activeProduct = page.rows.find(row => row.code === active);

  return (
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal pt-modal">
        <div className="modal-head">
          <div className="modal-title"><Icon name="globe" size={16} /> Překlady produktů</div>
          <span className="pt-feed">
            {overview ? `${overview.feed.products} produktů · feed ${relTime(overview.feed.syncedAt)}` : ''}
          </span>
          <span style={{ flex: 1 }} />
          <div className="ig-seg pt-tabs">
            <button className={tab === 'work' ? 'active' : ''} onClick={() => setTab('work')}>Produkty</button>
            <button className={tab === 'consistency' ? 'active' : ''}
              onClick={() => setTab('consistency')}>Jednotnost</button>
            <button className={tab === 'memory' ? 'active' : ''}
              onClick={() => setTab('memory')}>Paměť</button>
            <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>Nastavení</button>
          </div>
          <button className="icon-btn" onClick={importFile}
            data-tip="Přidat produkty z XML souboru — novinky, které ve feedu ještě nejsou">
            <Icon name="upload" size={15} />
          </button>
          <button className="icon-btn" onClick={refreshFeed} data-tip="Stáhnout feed znovu">
            <Icon name="refresh" size={15} className={loading ? 'spinning' : undefined} />
          </button>
          {/* Během běhu je zavření ve skutečnosti zmenšení — překlad jede dál
              v hlavním procesu a průběh se přesune do pruhu dole */}
          {progress?.running && (
            <button className="btn ghost pt-minimize" onClick={onClose}>
              <Icon name="minimize" size={13} /> Na pozadí
            </button>
          )}
          <button className="icon-btn" onClick={onClose}
            data-tip={progress?.running ? 'Zavřít — překlad běží dál na pozadí' : 'Zavřít'}>
            <Icon name="x" size={16} />
          </button>
        </div>

        {tab === 'consistency' ? (
          <ConsistencyPanel
            langs={langs.map(l => ({ code: l.code, label: l.label }))}
            onOpenProduct={code => { setActive(code); setTab('work'); }}
          />
        ) : tab === 'memory' ? (
          <MemoryPanel langs={langs.map(l => ({ code: l.code, label: l.label }))} />
        ) : tab === 'settings' ? (
          <PtransSettingsPanel
            overview={overview}
            sampleCode={active ?? page.rows[0]?.code ?? ''}
            onSaved={loadOverview}
          />
        ) : (
          <>
            <div className="pt-filters">
              <div className="ig-search">
                <Icon name="search" size={14} />
                <input value={search} onChange={e => setSearch(e.target.value)}
                  placeholder="Hledat název nebo kód" />
              </div>

              {/* Filtr, ne přepínač obsahu: „ukaž produkty, kde má práci slovenština" */}
              <label className="pt-filter">
                <span>Jazyk</span>
                <select value={query.lang ?? 'all'}
                  onChange={e => setQuery(q => ({ ...q, lang: e.target.value, offset: 0 }))}>
                  <option value="all">všechny jazyky</option>
                  {langs.map(lang => (
                    <option key={lang.code} value={lang.code}>{lang.label}</option>
                  ))}
                </select>
              </label>

              <label className="pt-filter">
                <span>Stav</span>
              <select value={query.state ?? 'todo'}
                onChange={e => setQuery(q => ({ ...q, state: e.target.value as any, offset: 0 }))}>
                <option value="todo">Čeká na překlad</option>
                <option value="missing">Chybí text</option>
                <option value="same">Zůstala čeština</option>
                <option value="source">Rozpoznán zdrojový jazyk</option>
                <option value="stale">Zdroj se změnil</option>
                <option value="ok">Hotové</option>
                <option value="all">Všechny produkty</option>
              </select>
              </label>

              <label className="pt-filter">
                <span>Pole</span>
                <select value={query.field ?? ''}
                  onChange={e => setQuery(q => ({ ...q, field: e.target.value || undefined, offset: 0 }))}>
                  <option value="">všechna pole</option>
                  {FIELD_ORDER.map(field => (
                    <option key={field} value={field}>{FIELD_LABEL[field]}</option>
                  ))}
                </select>
              </label>

              <span style={{ flex: 1 }} />
              <span className="pt-count">
                {page.total} produktů{page.todo ? ` · ${page.todo} s prací` : ''}
              </span>
            </div>

            {progress?.running && (
              <div className="pt-progress">
                <div className="pt-bar">
                  <span style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} />
                </div>
                <div className="pt-progress-text">
                  <b>{progress.done}/{progress.total}</b>
                  <span>{progress.label}</span>
                  <span className="pt-eta">
                    zbývá ~{humanTime(progress.etaSeconds)}
                    <small> · {progress.secondsPerUnit} s na produkt</small>
                  </span>
                  {progress.failed > 0 && <span className="pt-fail">{progress.failed}× chyba</span>}
                  <button className="btn ghost" onClick={() => api.ptrans.stop()}>Zastavit</button>
                </div>
              </div>
            )}

            <div className="pt-body">
              <div className="pt-list">
                <div className="pt-list-head">
                  <label className="pt-check">
                    <input type="checkbox"
                      checked={page.rows.length > 0 && page.rows.every(row => selected.has(row.code))}
                      onChange={selectAllVisible} />
                    Vybrat vše na stránce
                  </label>
                  {selected.size > 0 && (
                    <button className="btn ghost" onClick={() => setSelected(new Set())}>
                      Zrušit výběr ({selected.size})
                    </button>
                  )}
                </div>

                <div className="pt-rows">
                  {loading && page.rows.length === 0 && (
                    <div className="pt-empty"><span className="spinner-inline" /> Načítám…</div>
                  )}
                  {!loading && page.rows.length === 0 && (
                    <div className="pt-empty">
                      <Icon name="check" size={24} />
                      <div>Nic k překladu</div>
                      <div className="ig-muted">V tomhle filtru je všechno hotové.</div>
                    </div>
                  )}
                  {page.rows.map(row => (
                    <div key={row.code}
                      className={`pt-row ${row.code === active ? 'active' : ''}`}
                      onClick={() => setActive(row.code)}>
                      <input type="checkbox" checked={selected.has(row.code)}
                        onClick={e => e.stopPropagation()}
                        onChange={() => toggle(row.code)} />
                      {row.image
                        ? <img className="pt-thumb" src={row.image} alt="" loading="lazy" />
                        : <span className="pt-thumb empty"><Icon name="image" size={14} /></span>}
                      <div className="pt-row-main">
                        <div className="pt-row-title">{row.title || row.code}</div>
                        <div className="pt-row-sub">
                          <span className="pt-code">{row.code}</span>
                          {row.category && <span>{row.category}</span>}
                        </div>
                      </div>
                      <div className="pt-chips">
                        {langs.map(lang => {
                          const state = row.states[lang.code];
                          if (!state) return null;
                          const tone = state.todo > 0 ? STATE_TONE[state.worst] : 'ok';
                          return (
                            <span key={lang.code} className={`pt-chip ${tone}`}
                              title={state.todo > 0
                                ? `${lang.label}: ${state.todo} z ${state.total} polí čeká (${STATE_LABEL[state.worst]})`
                                : `${lang.label}: hotovo`}>
                              {lang.code.toUpperCase()}
                              {state.todo > 0 && <b>{state.todo}</b>}
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>

                {page.total > (query.limit ?? 60) && (
                  <div className="pt-pager">
                    <button className="btn ghost" disabled={(query.offset ?? 0) === 0}
                      onClick={() => setQuery(q => ({ ...q, offset: Math.max(0, (q.offset ?? 0) - (q.limit ?? 60)) }))}>
                      <Icon name="chevLeft" size={13} /> Předchozí
                    </button>
                    <span className="ig-muted">
                      {(query.offset ?? 0) + 1}–{Math.min(page.total, (query.offset ?? 0) + page.rows.length)} z {page.total}
                    </span>
                    <button className="btn ghost"
                      disabled={(query.offset ?? 0) + page.rows.length >= page.total}
                      onClick={() => setQuery(q => ({ ...q, offset: (q.offset ?? 0) + (q.limit ?? 60) }))}>
                      Další <Icon name="chevRight" size={13} />
                    </button>
                  </div>
                )}
              </div>

              <div className="pt-detail">
                {!active && (
                  <div className="pt-empty">
                    <Icon name="fileText" size={24} />
                    <div>Vyber produkt vlevo</div>
                    <div className="ig-muted">
                      Uvidíš češtinu a vedle ní všechny jazyky najednou — dá se v nich rovnou psát.
                    </div>
                  </div>
                )}
                {active && (
                  <>
                    <div className="pt-detail-head">
                      <div>
                        <div className="pt-detail-title">{activeProduct?.title ?? active}</div>
                        <div className="ig-muted">{active}{activeProduct?.price ? ` · ${activeProduct.price}` : ''}</div>
                      </div>
                      <span style={{ flex: 1 }} />
                      <span className="ig-muted pt-cols-label">Sloupce:</span>
                      <div className="ig-seg" data-tip="Které jazyky ukázat vedle zdroje">
                        {langs.map(lang => (
                          <button key={lang.code}
                            className={shownLangs.includes(lang.code) ? 'active' : ''}
                            onClick={() => setShownLangs(prev => (prev.includes(lang.code)
                              ? prev.filter(code => code !== lang.code)
                              : langs.map(l => l.code).filter(code => prev.includes(code) || code === lang.code)))}>
                            {lang.code.toUpperCase()}
                          </button>
                        ))}
                      </div>
                      <button className="btn ghost" onClick={() => setRunOpen(true)}>
                        <Icon name="sparkles" size={13} /> Přeložit produkt
                      </button>
                    </div>

                    <div className="pt-fields">
                      <div className="pt-cols-head" style={{ '--pt-cols': shownLangs.length } as any}>
                        <span>Zdroj ({overview?.settings.sourceLang ?? 'cz'})</span>
                        {shownLangs.map(code => (
                          <span key={code}>{langs.find(l => l.code === code)?.label ?? code}</span>
                        ))}
                      </div>
                      {fieldRows.map(row => (
                        <FieldRow
                          key={row.field}
                          field={row.field}
                          source={row.source}
                          byLang={row.byLang}
                          langs={shownLangs}
                          busy={busyField}
                          onSave={(lang, value) => {
                            const target = row.byLang[lang];
                            if (target) saveField(target, value);
                          }}
                          onRetranslate={lang => {
                            const target = row.byLang[lang];
                            if (target) retranslate(target);
                          }}
                          onGenerate={(lang, kind) => {
                            const target = row.byLang[lang];
                            if (target) generate(target, kind);
                          }}
                        />
                      ))}
                      {fieldRows.length === 0 && (
                        <div className="pt-empty ig-muted">U tohohle produktu se zatím nic nesleduje.</div>
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>

            <div className="modal-foot pt-foot">
              <span className="ig-muted">
                {selected.size > 0 ? `Vybráno ${selected.size} produktů` : 'Nic není vybráno'}
              </span>
              <span style={{ flex: 1 }} />
              <button className="btn ghost" onClick={googleTitles} disabled={selected.size === 0}
                data-tip="Poskládá Google titulek ze šablony — bez modelu">
                <Icon name="bag" size={13} /> Google titulky
              </button>
              <button className="btn ghost" onClick={exportXml}>
                <Icon name="download" size={13} /> Export XML{selected.size > 0 ? ` (${selected.size})` : ''}
              </button>
              <button className="btn primary" disabled={selected.size === 0 || progress?.running}
                onClick={() => setRunOpen(true)}>
                <Icon name="sparkles" size={13} /> Přeložit vybrané
              </button>
            </div>
          </>
        )}
      </div>

      {runOpen && overview && (
        <RunDialog
          codes={selected.size > 0 ? [...selected] : active ? [active] : []}
          overview={overview}
          onClose={() => setRunOpen(false)}
          onStarted={() => { setRunOpen(false); }}
        />
      )}
    </div>
  );
}

/* ---------- jedno pole ve všech jazycích ---------- */

/**
 * Řádek jednoho pole: vlevo zdroj, vedle něj sloupec na každý jazyk.
 *
 * Dřív se jazyk přepínal záložkami a člověk musel klikat, aby zjistil, jestli
 * je slovenština hotová. Takhle je to vidět naráz a případný rozdíl mezi
 * jazyky bije do očí.
 */
function FieldRow({ field, source, byLang, langs, busy, onSave, onRetranslate, onGenerate }: {
  field: string;
  source: string;
  byLang: Record<string, PtransField>;
  langs: string[];
  busy: string;
  onSave: (lang: string, value: string) => void;
  onRetranslate: (lang: string) => void;
  onGenerate: (lang: string, kind: 'seo_title' | 'seo_desc' | 'google_desc') => void;
}) {
  const long = field === 'long' || field === 'short' || field === 'google_desc' || field === 'redirect';
  const [openSource, setOpenSource] = useState(false);

  return (
    <div className="pt-frow" style={{ '--pt-cols': langs.length } as any}>
      <div className="pt-frow-head">
        <span className="pt-field-name">{fieldLabel(field)}</span>
        {field === 'seo_url' && (
          <span className="ig-muted">při změně se stará adresa přidá do přesměrování 301</span>
        )}
        {field === 'redirect' && (
          <span className="ig-muted">staré adresy, ze kterých se přesměrovává — každá na svém řádku</span>
        )}
      </div>

      <div className="pt-frow-cols">
        <div className="pt-cell source">
          <button className="pt-cell-source" onClick={() => setOpenSource(o => !o)}
            data-tip="Rozbalit celý zdrojový text">
            <span className={openSource ? 'full' : 'clip'}>{source || <i>prázdné</i>}</span>
          </button>
        </div>

        {langs.map(lang => {
          const row = byLang[lang];
          if (!row) return <div key={lang} className="pt-cell empty ig-muted">—</div>;
          return (
            <LangCell
              key={lang}
              row={row}
              long={long}
              busy={busy === `${lang}:${field}`}
              onSave={value => onSave(lang, value)}
              onRetranslate={() => onRetranslate(lang)}
              onGenerate={kind => onGenerate(lang, kind)}
            />
          );
        })}
      </div>
    </div>
  );
}

/** Jedno pole v jednom jazyce — text, stav a akce nad ním. */
function LangCell({ row, long, busy, onSave, onRetranslate, onGenerate }: {
  row: PtransField;
  long: boolean;
  busy: boolean;
  onSave: (value: string) => void;
  onRetranslate: () => void;
  onGenerate: (kind: 'seo_title' | 'seo_desc' | 'google_desc') => void;
}) {
  const current = row.translated ?? row.value;
  const [value, setValue] = useState(current);
  const dirty = value !== current;
  const generable = row.field === 'seo_title' || row.field === 'seo_desc' || row.field === 'google_desc';
  const derived = row.field === 'seo_url' || row.field === 'redirect';

  useEffect(() => { setValue(current); }, [current]);

  return (
    <div className={`pt-cell ${row.state}`}>
      <div className="pt-cell-top">
        <span className={`pt-chip ${STATE_TONE[row.state]}`}>{STATE_LABEL[row.state]}</span>
        <span style={{ flex: 1 }} />
        {generable && (
          <button className="icon-btn tiny" disabled={busy} onClick={() => onGenerate(row.field as any)}
            data-tip="Napsat text znovu podle přeloženého popisu">
            <Icon name="zap" size={12} />
          </button>
        )}
        {!derived && (
          <button className="icon-btn tiny" disabled={busy} onClick={onRetranslate}
            data-tip="Přeložit tohle pole znovu ze zdroje">
            {busy ? <span className="spinner-inline" /> : <Icon name="refresh" size={12} />}
          </button>
        )}
      </div>

      <textarea
        className={long ? 'pt-input tall' : 'pt-input'}
        rows={long ? 5 : 2}
        value={value}
        onChange={e => setValue(e.target.value)}
        onBlur={() => { if (dirty) onSave(value); }}
      />

      <div className="pt-cell-foot">
        <span className="ig-muted">{value.length} zn.</span>
        {dirty && (
          <>
            <button className="btn ghost small" onClick={() => setValue(current)}>Vrátit</button>
            <button className="btn small primary" onClick={() => onSave(value)}>Uložit</button>
          </>
        )}
      </div>
    </div>
  );
}

/* ---------- spuštění překladu ---------- */

function RunDialog({ codes, overview, onClose, onStarted }: {
  codes: string[];
  overview: PtransOverview;
  onClose: () => void;
  onStarted: () => void;
}) {
  const toast = useToast();
  const enabled = overview.settings.languages.filter(l => l.enabled);
  const [langs, setLangs] = useState<string[]>(enabled.map(l => l.code));
  const [force, setForce] = useState(false);
  const [plan, setPlan] = useState<number | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.ptrans.plan(codes, langs, { force })
      .then(count => { if (!cancelled) setPlan(count); })
      .catch(() => { if (!cancelled) setPlan(null); });
    return () => { cancelled = true; };
  }, [codes, langs, force]);

  const seconds = plan === null ? null : (plan * overview.settings.secondsPerUnit) / Math.max(1, overview.settings.concurrency);

  const start = async () => {
    setStarting(true);
    try {
      onStarted();
      const result = await api.ptrans.run({ codes, langs, force });
      toast(result.failed
        ? `Hotovo: ${result.done - result.failed} přeloženo, ${result.failed} selhalo`
        : `Hotovo: ${result.done} položek za ${humanTime(result.seconds)}`);
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="overlay pt-run-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal pt-run">
        <div className="modal-head">
          <div className="modal-title"><Icon name="sparkles" size={15} /> Přeložit</div>
          <span style={{ flex: 1 }} />
          <button className="icon-btn" onClick={onClose}><Icon name="x" size={15} /></button>
        </div>
        <div className="modal-body">
          <p className="ig-muted">
            {codes.length === 1 ? 'Jeden produkt' : `${codes.length} produktů`} · překládá se jen to,
            co ještě přeložené není.
          </p>

          <label className="pt-label">Jazyky</label>
          <div className="pt-lang-picks">
            {enabled.map(lang => (
              <label key={lang.code} className={`pt-pick ${langs.includes(lang.code) ? 'on' : ''}`}>
                <input type="checkbox" checked={langs.includes(lang.code)}
                  onChange={() => setLangs(prev => prev.includes(lang.code)
                    ? prev.filter(code => code !== lang.code)
                    : [...prev, lang.code])} />
                {lang.label}
              </label>
            ))}
          </div>

          <label className="pt-switch">
            <input type="checkbox" checked={force} onChange={e => setForce(e.target.checked)} />
            <span>Přeložit znovu i to, co už přeložené je <small>(ručně upravená pole zůstanou)</small></span>
          </label>

          <div className="pt-estimate">
            <div>
              <b>{plan === null ? '…' : plan}</b> položek k překladu
              <div className="ig-muted">jeden produkt a jazyk = jedno volání modelu</div>
            </div>
            <div className="pt-estimate-time">
              <b>~{humanTime(seconds)}</b>
              <div className="ig-muted">
                podle naměřených {overview.settings.secondsPerUnit} s a {overview.settings.concurrency} souběžných
              </div>
            </div>
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose}>Zrušit</button>
          <span style={{ flex: 1 }} />
          <button className="btn primary" disabled={!plan || starting || langs.length === 0} onClick={start}>
            <Icon name="sparkles" size={13} /> Spustit překlad
          </button>
        </div>
      </div>
    </div>
  );
}


/* ---------- jednotnost názvů ---------- */

/* ==================== Paměť ==================== */

const KIND_TABS: { id: PtransMemoryKind; label: string; hint: string }[] = [
  { id: 'term', label: 'Výrazy', hint: 'Slovo nebo spojení, které má vždycky znít stejně — kšandy → traky.' },
  { id: 'pattern', label: 'Tvary názvů', hint: 'Slovosled v kategorii. ⟨…⟩ jsou místa, kam patří konkrétní slova.' },
  { id: 'example', label: 'Hotové dvojice', hint: 'Celé názvy, které se modelu ukazují jako vzor.' }
];

/**
 * Paměť překladů.
 *
 * Část produktů je ve feedu přeložená ručně a je na nich vidět styl, kterým se
 * to má dělat dál — jak se skládá název, jak se překládají barvy a materiály.
 * Tlačítko „Naučit se z feedu" to z hotových překladů vytáhne; do každého
 * dalšího překladu se pak posílá jen ta část paměti, která se týká zrovna
 * překládaného textu.
 *
 * Ruční úprava záznam **zamkne** — další učení ho nepřepíše. To je důležité:
 * jinak by se špatný, ale častý zvyk z feedu pořád vracel.
 */
function MemoryPanel({ langs }: { langs: { code: string; label: string }[] }) {
  const toast = useToast();
  const [lang, setLang] = useState(langs[0]?.code ?? '');
  const [kind, setKind] = useState<PtransMemoryKind>('term');
  const [search, setSearch] = useState('');
  const [entries, setEntries] = useState<PtransMemoryEntry[]>([]);
  const [stats, setStats] = useState<PtransMemoryStat[]>([]);
  const [loading, setLoading] = useState(false);
  const [learning, setLearning] = useState(false);
  const [draft, setDraft] = useState<PtransMemoryEntry | null>(null);

  const load = useCallback(async () => {
    if (!lang) return;
    setLoading(true);
    try {
      const data = await api.ptrans.memory({ lang, kind, search: search.trim() || undefined });
      setEntries(data.entries);
      setStats(data.stats);
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setLoading(false);
    }
  }, [lang, kind, search, toast]);

  useEffect(() => {
    const timer = setTimeout(load, search ? 250 : 0);
    return () => clearTimeout(timer);
  }, [load, search]);

  const learn = async () => {
    setLearning(true);
    try {
      const result = await api.ptrans.learn(langs.map(l => l.code));
      const summary = result
        .map(r => `${r.lang.toUpperCase()}: ${r.terms} výrazů, ${r.patterns} tvarů (z ${r.pairs} názvů)`)
        .join(' · ');
      toast(summary || 'Zatím není z čeho se učit.');
      await load();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setLearning(false);
    }
  };

  const save = async (entry: PtransMemoryEntry) => {
    if (!entry.source.trim() || !entry.target.trim()) { toast('Vyplň obě strany.', 'error'); return; }
    try {
      await api.ptrans.saveMemory(entry);
      setDraft(null);
      await load();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const remove = async (id?: number) => {
    if (!id) return;
    try {
      await api.ptrans.deleteMemory(id);
      await load();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const stat = stats.find(row => row.lang === lang);
  const tab = KIND_TABS.find(t => t.id === kind)!;

  return (
    <>
      <div className="pt-filters">
        <div className="ig-seg">
          {langs.map(item => (
            <button key={item.code} className={lang === item.code ? 'active' : ''}
              onClick={() => setLang(item.code)}>{item.code.toUpperCase()}</button>
          ))}
        </div>
        <div className="ig-seg">
          {KIND_TABS.map(item => (
            <button key={item.id} className={kind === item.id ? 'active' : ''}
              onClick={() => setKind(item.id)}>{item.label}</button>
          ))}
        </div>
        <div className="ig-search">
          <Icon name="search" size={14} />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Hledat v paměti" />
        </div>
        <span style={{ flex: 1 }} />
        <button className="btn ghost" onClick={() => setDraft({
          kind, lang, source: '', target: '', category: '', hits: 0, confidence: 1,
          origin: 'manual', locked: true
        })}>
          <Icon name="plus" size={13} /> Přidat
        </button>
        <button className="btn primary" onClick={learn} disabled={learning}>
          {learning ? <span className="spinner-inline" /> : <Icon name="brain" size={14} />}
          Naučit se z feedu
        </button>
      </div>

      <div className="modal-body pt-memory">
        <div className="pt-mem-head">
          <p className="ig-muted">{tab.hint}</p>
          {stat && (
            <div className="pt-mem-stats">
              <span><b>{stat.terms}</b> výrazů</span>
              <span><b>{stat.patterns}</b> tvarů</span>
              <span><b>{stat.examples}</b> dvojic</span>
              <span><b>{stat.manual}</b> zamčených</span>
            </div>
          )}
        </div>

        {draft && (
          <MemoryRow entry={draft} editing onChange={setDraft} onSave={save} onCancel={() => setDraft(null)} />
        )}

        {loading && entries.length === 0 && <div className="ig-muted">Načítám…</div>}
        {!loading && entries.length === 0 && !draft && (
          <div className="pt-mem-empty">
            <Icon name="brain" size={26} />
            <b>Paměť je zatím prázdná</b>
            <p className="ig-muted">
              Ve feedu už nějaké přeložené produkty jsou — „Naučit se z feedu" z nich
              vytáhne ustálené výrazy a slovosled a použije je při dalších překladech.
            </p>
          </div>
        )}

        {entries.map(entry => (
          <MemoryRow key={entry.id} entry={entry} onSave={save} onDelete={() => remove(entry.id)} />
        ))}
      </div>
    </>
  );
}

/** Jeden záznam paměti. Klik na text ho otevře k úpravě — a tím i zamkne. */
function MemoryRow({ entry, editing, onChange, onSave, onCancel, onDelete }: {
  entry: PtransMemoryEntry;
  editing?: boolean;
  onChange?: (entry: PtransMemoryEntry) => void;
  onSave: (entry: PtransMemoryEntry) => void;
  onCancel?: () => void;
  onDelete?: () => void;
}) {
  const [open, setOpen] = useState(!!editing);
  const [local, setLocal] = useState(entry);
  useEffect(() => { setLocal(entry); }, [entry]);

  const value = editing ? entry : local;
  const patch = (part: Partial<PtransMemoryEntry>) => {
    const next = { ...value, ...part };
    if (editing) onChange?.(next); else setLocal(next);
  };

  if (!open) {
    return (
      <div className="pt-mem-row" onClick={() => setOpen(true)}>
        <div className="pt-mem-pair">
          <span className="pt-mem-src">{value.source}</span>
          <Icon name="chevRight" size={12} />
          <span className="pt-mem-tgt">{value.target}</span>
        </div>
        {value.category && <span className="pt-mem-cat">{value.category}</span>}
        <span style={{ flex: 1 }} />
        {value.locked
          ? <span className="pt-mem-badge manual" data-tip="Ručně upravené — učení to nepřepíše">ruční</span>
          : <span className="pt-mem-badge" data-tip={`Doloženo ${value.hits}× ve feedu`}>
              {value.hits}× · {Math.round(value.confidence * 100)} %
            </span>}
        <button className="icon-btn" data-tip="Smazat"
          onClick={e => { e.stopPropagation(); onDelete?.(); }}>
          <Icon name="trash" size={14} />
        </button>
      </div>
    );
  }

  return (
    <div className="pt-mem-row editing">
      <input value={value.source} placeholder="zdroj (česky)"
        onChange={e => patch({ source: e.target.value })} />
      <Icon name="chevRight" size={12} />
      <input value={value.target} placeholder="překlad"
        onChange={e => patch({ target: e.target.value })} />
      <input className="pt-mem-catin" value={value.category} placeholder="kategorie (nepovinné)"
        onChange={e => patch({ category: e.target.value })} />
      <span style={{ flex: 1 }} />
      <button className="btn ghost" onClick={() => { setOpen(false); onCancel?.(); }}>Zpět</button>
      <button className="btn primary" onClick={() => { onSave(value); setOpen(false); }}>
        <Icon name="save" size={13} /> Uložit
      </button>
    </div>
  );
}

/**
 * Kontrola slovosledu.
 *
 * Model přeloží každý produkt zvlášť, takže si u „pánská černá kravata" může
 * jednou zvolit „Men's black tie" a podruhé „Black tie for men". Tady je vidět,
 * jaký tvar v kategorii převládá a co se mu vymyká — a dá se to rovnou spravit.
 */
function ConsistencyPanel({ langs, onOpenProduct }: {
  langs: { code: string; label: string }[];
  onOpenProduct: (code: string) => void;
}) {
  const toast = useToast();
  const [lang, setLang] = useState(langs[0]?.code ?? '');
  const [data, setData] = useState<PtransConsistency | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    if (!lang) return;
    setLoading(true);
    try {
      setData(await api.ptrans.consistency(lang));
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setLoading(false);
    }
  }, [lang, toast]);

  useEffect(() => { load(); }, [load]);

  const fix = async (code: string) => {
    setBusy(code);
    try {
      await api.ptrans.retranslate(code, lang, 'title');
      await load();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy('');
    }
  };

  return (
    <>
      <div className="pt-filters">
        <div className="ig-seg">
          {langs.map(item => (
            <button key={item.code} className={lang === item.code ? 'active' : ''}
              onClick={() => setLang(item.code)}>{item.code.toUpperCase()}</button>
          ))}
        </div>
        <span className="ig-muted">
          Tvar názvu se odvozuje z hotových překladů v kategorii. Ruční pravidlo z nastavení má přednost.
        </span>
        <span style={{ flex: 1 }} />
        <button className="btn ghost" onClick={load} disabled={loading}>
          {loading ? <span className="spinner-inline" /> : <Icon name="refresh" size={13} />} Přepočítat
        </button>
      </div>

      <div className="modal-body pt-consistency">
        <section>
          <h3>Tvary názvů podle kategorií</h3>
          <table className="pt-table">
            <thead>
              <tr><th>Kategorie</th><th>Tvar názvu</th><th>Sedí</th></tr>
            </thead>
            <tbody>
              {(data?.patterns ?? []).map(row => (
                <tr key={row.category}>
                  <td>{row.category}</td>
                  <td><code>{row.pattern || <span className="ig-muted">zatím málo překladů</span>}</code></td>
                  <td className={row.samples && row.matching / row.samples < 0.8 ? 'pt-warn' : ''}>
                    {row.matching}/{row.samples}
                  </td>
                </tr>
              ))}
              {(data?.patterns ?? []).length === 0 && (
                <tr><td colSpan={3} className="ig-muted">Zatím není z čeho tvar odvodit.</td></tr>
              )}
            </tbody>
          </table>
        </section>

        <section>
          <h3>Názvy, které se vymykají {data?.deviations.length ? `(${data.deviations.length})` : ''}</h3>
          {(data?.deviations ?? []).length === 0 && (
            <div className="ig-muted">Všechny názvy odpovídají tvaru své kategorie.</div>
          )}
          {(data?.deviations ?? []).map(row => (
            <div key={row.code} className="pt-dev">
              <div className="pt-dev-main">
                <div className="pt-dev-title">{row.translated}</div>
                <div className="ig-muted">
                  <span className="pt-code">{row.code}</span> · {row.category} · očekávaný tvar <code>{row.pattern}</code>
                </div>
                <div className="ig-muted">zdroj: {row.title}</div>
              </div>
              <button className="btn ghost" onClick={() => onOpenProduct(row.code)}>Otevřít</button>
              <button className="btn ghost" disabled={busy === row.code} onClick={() => fix(row.code)}>
                {busy === row.code ? <span className="spinner-inline" /> : <Icon name="refresh" size={13} />}
                Přeložit znovu
              </button>
            </div>
          ))}
        </section>
      </div>
    </>
  );
}
