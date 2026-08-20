import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  PtransConsistency, PtransField, PtransOverview, PtransProduct, PtransProgress, PtransQuery, PtransState
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
  google_title: 'Google titulek',
  google_desc: 'Google popis'
};

const FIELD_ORDER = ['title', 'short', 'long', 'seo_title', 'seo_desc', 'seo_url',
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
  const [tab, setTab] = useState<'work' | 'consistency' | 'settings'>('work');

  const [query, setQuery] = useState<PtransQuery>({ state: 'todo', limit: 60, offset: 0 });
  const [search, setSearch] = useState('');
  const [page, setPage] = useState<{ rows: PtransProduct[]; total: number; todo: number }>(
    { rows: [], total: 0, todo: 0 }
  );
  const [loading, setLoading] = useState(false);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [active, setActive] = useState<string | null>(null);
  const [fields, setFields] = useState<PtransField[]>([]);
  const [detailLang, setDetailLang] = useState<string>('');
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
      setDetailLang(prev => prev || data.settings.languages.find(l => l.enabled)?.code || '');
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

  const detailFields = fields
    .filter(row => row.lang === detailLang)
    .sort((a, b) => {
      const ia = FIELD_ORDER.indexOf(a.field);
      const ib = FIELD_ORDER.indexOf(b.field);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });

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
            <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>Nastavení</button>
          </div>
          <button className="icon-btn" onClick={importFile}
            data-tip="Přidat produkty z XML souboru — novinky, které ve feedu ještě nejsou">
            <Icon name="upload" size={15} />
          </button>
          <button className="icon-btn" onClick={refreshFeed} data-tip="Stáhnout feed znovu">
            <Icon name="refresh" size={15} className={loading ? 'spinning' : undefined} />
          </button>
          <button className="icon-btn" onClick={onClose} data-tip="Zavřít"><Icon name="x" size={16} /></button>
        </div>

        {tab === 'consistency' ? (
          <ConsistencyPanel
            langs={langs.map(l => ({ code: l.code, label: l.label }))}
            onOpenProduct={code => { setActive(code); setTab('work'); }}
          />
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

              <div className="ig-seg">
                <button className={!query.lang || query.lang === 'all' ? 'active' : ''}
                  onClick={() => setQuery(q => ({ ...q, lang: 'all', offset: 0 }))}>Vše</button>
                {langs.map(lang => (
                  <button key={lang.code} className={query.lang === lang.code ? 'active' : ''}
                    onClick={() => setQuery(q => ({ ...q, lang: lang.code, offset: 0 }))}>
                    {lang.code.toUpperCase()}
                  </button>
                ))}
              </div>

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

              <select value={query.field ?? ''}
                onChange={e => setQuery(q => ({ ...q, field: e.target.value || undefined, offset: 0 }))}>
                <option value="">Všechna pole</option>
                {FIELD_ORDER.map(field => (
                  <option key={field} value={field}>{FIELD_LABEL[field]}</option>
                ))}
              </select>

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
                    <div className="ig-muted">Uvidíš zdroj i překlad vedle sebe a můžeš je upravit.</div>
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
                      <div className="ig-seg">
                        {langs.map(lang => (
                          <button key={lang.code} className={detailLang === lang.code ? 'active' : ''}
                            onClick={() => setDetailLang(lang.code)}>{lang.code.toUpperCase()}</button>
                        ))}
                      </div>
                      <button className="btn ghost" onClick={() => setRunOpen(true)}>
                        <Icon name="sparkles" size={13} /> Přeložit produkt
                      </button>
                    </div>

                    <div className="pt-fields">
                      {detailFields.map(row => (
                        <FieldEditor
                          key={`${row.lang}:${row.field}`}
                          row={row}
                          busy={busyField === `${row.lang}:${row.field}`}
                          onSave={value => saveField(row, value)}
                          onRetranslate={() => retranslate(row)}
                          onGenerate={kind => generate(row, kind)}
                        />
                      ))}
                      {detailFields.length === 0 && (
                        <div className="pt-empty ig-muted">Pro tenhle jazyk se zatím nic nesleduje.</div>
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

/* ---------- jedno pole ---------- */

function FieldEditor({ row, busy, onSave, onRetranslate, onGenerate }: {
  row: PtransField;
  busy: boolean;
  onSave: (value: string) => void;
  onRetranslate: () => void;
  onGenerate: (kind: 'seo_title' | 'seo_desc' | 'google_desc') => void;
}) {
  const current = row.translated ?? row.value;
  const [value, setValue] = useState(current);
  const [open, setOpen] = useState(false);
  const dirty = value !== current;
  const long = row.field === 'long' || row.field === 'short' || row.field === 'google_desc';
  const generable = row.field === 'seo_title' || row.field === 'seo_desc' || row.field === 'google_desc';
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { setValue(current); }, [current]);

  return (
    <div className={`pt-field ${row.state}`}>
      <div className="pt-field-head">
        <span className="pt-field-name">{fieldLabel(row.field)}</span>
        <span className={`pt-chip ${STATE_TONE[row.state]}`}>{STATE_LABEL[row.state]}</span>
        {row.translatedAt && (
          <span className="ig-muted pt-field-when">
            {row.model === 'ruční' ? 'upraveno ručně' : `přeloženo ${relTime(row.translatedAt)}`}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {generable && (
          <button className="btn ghost small" disabled={busy}
            onClick={() => onGenerate(row.field as any)}
            data-tip="Nechá text napsat znovu podle přeloženého popisu">
            <Icon name="zap" size={12} /> Napsat znovu
          </button>
        )}
        <button className="btn ghost small" disabled={busy} onClick={onRetranslate}
          data-tip="Přeloží pole znovu ze zdroje">
          {busy ? <span className="spinner-inline" /> : <Icon name="refresh" size={12} />} Přeložit
        </button>
      </div>

      <button className="pt-source" onClick={() => setOpen(o => !o)}>
        <Icon name="chevDown" size={11}
          style={{ transform: open ? 'none' : 'rotate(-90deg)', transition: 'transform .15s' }} />
        <span className="pt-source-text">{row.source || <i>zdroj je prázdný</i>}</span>
      </button>
      {open && <div className="pt-source-full">{row.source}</div>}

      <textarea
        ref={box}
        className={long ? 'pt-input tall' : 'pt-input'}
        rows={long ? 6 : 2}
        value={value}
        onChange={e => setValue(e.target.value)}
        onBlur={() => { if (dirty) onSave(value); }}
      />
      <div className="pt-field-foot">
        <span className="ig-muted">{value.length} znaků</span>
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
