import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  ArticleDetail, ArticleListRow, ArticleOverview, ArticleProgress, ArticleCheckProgress,
  ArticleLinkCheck
} from '@shared/types';
import { api } from '../api';
import { useToast } from '../toast';
import Icon from './Icon';
import ArticleSettingsPanel from './ArticleSettings';
import { ArticleBriefPanel, ArticleTextPanel, ArticleLinksPanel } from './ArticleEditor';

/**
 * Články pro e-shop.
 *
 * Zásadní rozdíl proti generátoru „vyplň formulář → stáhni XML" je, že článek
 * tady **zůstává**: rozepsaný se dá zavřít a vrátit se k němu, hotový se dá
 * přeložit do dalšího trhu a kdykoli znovu vyexportovat. Proto je vlevo seznam
 * a vpravo rozpracovaný článek — stejně jako v poště.
 *
 * Kontrola odkazů a mapa adres mezi trhy jsou na vlastních záložkách. Jsou to
 * úlohy nad **všemi** články, ne nad jedním, a v detailu jednoho článku by se
 * po nich nikdo nesháněl.
 */

const STATE_LABEL: Record<string, string> = {
  empty: 'prázdné',
  generated: 'napsáno',
  manual: 'ručně',
  translated: 'přeloženo',
  imported: 'z e-shopu'
};

const LENGTHS: { label: string; words: number }[] = [
  { label: 'Krátký', words: 300 },
  { label: 'Střední', words: 600 },
  { label: 'Dlouhý', words: 1000 },
  { label: 'Extra', words: 1500 }
];

export default function ArticlesModal({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [overview, setOverview] = useState<ArticleOverview | null>(null);
  const [tab, setTab] = useState<'work' | 'check' | 'map' | 'settings'>('work');
  const [rows, setRows] = useState<ArticleListRow[]>([]);
  const [search, setSearch] = useState('');
  const [activeId, setActiveId] = useState<number | null>(null);
  const [article, setArticle] = useState<ArticleDetail | null>(null);
  const [progress, setProgress] = useState<ArticleProgress | null>(null);
  const [pane, setPane] = useState<'brief' | 'text' | 'links'>('brief');
  const [loading, setLoading] = useState(false);

  const langs = useMemo(
    () => (overview?.settings.languages ?? []).filter(l => l.enabled),
    [overview]
  );

  const loadOverview = useCallback(async () => {
    try {
      const data = await api.articles.overview();
      setOverview(data);
      setProgress(data.running);
    } catch (e: any) {
      toast(e.message, 'error');
    }
  }, [toast]);

  const loadList = useCallback(async () => {
    try {
      setRows(await api.articles.list({ search: search.trim() || undefined }));
    } catch (e: any) {
      toast(e.message, 'error');
    }
  }, [search, toast]);

  const loadArticle = useCallback(async (id: number | null) => {
    if (!id) { setArticle(null); return; }
    try {
      setArticle(await api.articles.get(id));
    } catch (e: any) {
      toast(e.message, 'error');
    }
  }, [toast]);

  useEffect(() => { loadOverview(); }, [loadOverview]);
  useEffect(() => {
    const timer = setTimeout(loadList, search ? 250 : 0);
    return () => clearTimeout(timer);
  }, [loadList, search]);
  useEffect(() => { loadArticle(activeId); }, [activeId, loadArticle]);
  useEffect(() => api.on('articles:progress', (p: ArticleProgress) => setProgress(p)), []);
  useEffect(() => api.on('articles:changed', () => { loadList(); loadArticle(activeId); loadOverview(); }),
    [loadList, loadArticle, activeId, loadOverview]);

  /* ---------- akce ---------- */

  const create = async () => {
    try {
      const id = await api.articles.save({ topic: '', langs: langs.map(l => l.code) });
      await loadList();
      setActiveId(id);
      setPane('brief');
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const importXml = async () => {
    setLoading(true);
    try {
      const result = await api.articles.import();
      if (!result) return;
      toast(`Načteno ${result.articles} nových a ${result.updated} stávajících článků`
        + ` · ${result.learned.pairs} dvojic adres`);
      await loadList();
      await loadOverview();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  const exportXml = async () => {
    try {
      const result = await api.articles.export(activeId ? { ids: [activeId], onlyReady: false } : {});
      if (result) toast(`Uloženo ${result.articles} článků (${result.versions} jazykových verzí)`);
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const remove = async (id: number) => {
    try {
      await api.articles.delete(id);
      if (activeId === id) setActiveId(null);
      await loadList();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const listItem = (row: ArticleListRow) => {
    // Název, jinak zadání, jinak aspoň číslo — v seznamu musí být za co chytit
    const label = row.title || row.topic || `Nový článek #${row.id}`;
    return (
      <button key={row.id} className={`ar-item ${activeId === row.id ? 'active' : ''}`}
        onClick={() => setActiveId(row.id)}>
        <div className="ar-item-title">{label}</div>
        <div className="ar-item-meta">
          {row.versions.filter(v => v.words > 0).map(v => (
            <span key={v.lang} className={`ar-chip ${v.state}`} data-tip={`${STATE_LABEL[v.state] ?? v.state} · ${v.words} slov`}>
              {v.lang.toUpperCase()}
            </span>
          ))}
          {row.versions.every(v => v.words === 0) && <span className="ig-muted">zatím prázdné</span>}
          <span style={{ flex: 1 }} />
          {row.status === 'draft' && <span className="ar-draft">rozepsané</span>}
        </div>
      </button>
    );
  };

  return (
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal ar-modal">
        <div className="modal-head">
          <div className="modal-title"><Icon name="fileText" size={16} /> Články</div>
          <span className="pt-feed">
            {overview ? `${overview.summary.total} článků · ${overview.summary.drafts} rozepsaných`
              + ` · ${overview.urlmap} dvojic adres` : ''}
          </span>
          <span style={{ flex: 1 }} />
          <div className="ig-seg pt-tabs">
            <button className={tab === 'work' ? 'active' : ''} onClick={() => setTab('work')}>Články</button>
            <button className={tab === 'check' ? 'active' : ''} onClick={() => setTab('check')}>Odkazy</button>
            <button className={tab === 'map' ? 'active' : ''} onClick={() => setTab('map')}>Mapa adres</button>
            <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>Nastavení</button>
          </div>
          <button className="icon-btn" onClick={importXml} disabled={loading}
            data-tip="Načíst export článků z Upgates — kvůli překladu a kontrole odkazů">
            <Icon name="upload" size={15} />
          </button>
          <button className="icon-btn" onClick={exportXml}
            data-tip={activeId ? 'Uložit tento článek jako XML' : 'Uložit hotové články jako XML'}>
            <Icon name="download" size={15} />
          </button>
          <button className="icon-btn" onClick={onClose} data-tip="Zavřít"><Icon name="x" size={16} /></button>
        </div>

        {progress?.running && (
          <div className="ar-running">
            <span className="spinner-inline" />
            <b>{progress.label}</b>
            <span className="ig-muted">
              {progress.done}/{progress.total}
              {progress.chars > 0 ? ` · ${Math.round(progress.chars / 5)} slov` : ''}
            </span>
            <span style={{ flex: 1 }} />
            <button className="btn ghost" onClick={() => api.articles.stop()}>
              <Icon name="stop" size={12} /> Zastavit
            </button>
          </div>
        )}

        {tab === 'settings' ? (
          <ArticleSettingsPanel overview={overview} onSaved={loadOverview} />
        ) : tab === 'check' ? (
          <LinkCheckPanel langs={langs.map(l => ({ code: l.code, label: l.label }))} />
        ) : tab === 'map' ? (
          <UrlMapPanel langs={langs.map(l => ({ code: l.code, label: l.label }))} />
        ) : (
          <div className="ar-body">
            <div className="ar-list">
              <div className="ar-list-head">
                <div className="ig-search">
                  <Icon name="search" size={14} />
                  <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Hledat článek" />
                </div>
                <button className="btn primary" onClick={create}>
                  <Icon name="plus" size={13} /> Nový
                </button>
              </div>
              <div className="ar-list-scroll">
                {rows.length === 0 && (
                  <div className="ig-muted" style={{ padding: '14px 12px' }}>
                    Zatím žádné články. Nový článek napíše AI podle zadání; „Načíst export"
                    přinese ty, které na e-shopu už jsou.
                  </div>
                )}
                {rows.map(listItem)}
              </div>
            </div>

            <div className="ar-detail">
              {!article ? (
                <div className="ar-empty">
                  <Icon name="fileText" size={30} />
                  <b>Vyber článek nebo založ nový</b>
                  <p className="ig-muted">
                    Zadání zůstane uložené s článkem — dá se k němu vrátit, přegenerovat ho
                    nebo článek přeložit na další trh.
                  </p>
                </div>
              ) : (
                <>
                  <div className="ar-detail-head">
                    <div className="ig-seg">
                      <button className={pane === 'brief' ? 'active' : ''} onClick={() => setPane('brief')}>Zadání</button>
                      <button className={pane === 'text' ? 'active' : ''} onClick={() => setPane('text')}>Text</button>
                      <button className={pane === 'links' ? 'active' : ''} onClick={() => setPane('links')}>Odkazy</button>
                    </div>
                    <span style={{ flex: 1 }} />
                    {article.articleId && (
                      <span className="ar-upgates" data-tip="Článek existuje na e-shopu — export ho aktualizuje, nezaloží nový">
                        Upgates #{article.articleId}
                      </span>
                    )}
                    <button className="icon-btn" data-tip="Smazat článek z aplikace"
                      onClick={() => remove(article.id)}>
                      <Icon name="trash" size={14} />
                    </button>
                  </div>

                  {pane === 'brief' && (
                    <ArticleBriefPanel
                      article={article}
                      langs={langs.map(l => ({ code: l.code, label: l.label }))}
                      lengths={LENGTHS}
                      busy={!!progress?.running}
                      onChanged={() => { loadArticle(article.id); loadList(); }}
                      onGenerated={() => setPane('text')}
                    />
                  )}
                  {pane === 'text' && (
                    <ArticleTextPanel
                      article={article}
                      langs={langs.map(l => ({ code: l.code, label: l.label }))}
                      busy={!!progress?.running}
                      onChanged={() => { loadArticle(article.id); loadList(); }}
                    />
                  )}
                  {pane === 'links' && (
                    <ArticleLinksPanel
                      article={article}
                      langs={langs.map(l => ({ code: l.code, label: l.label }))}
                      onChanged={() => loadArticle(article.id)}
                    />
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ==================== Kontrola odkazů ==================== */

/**
 * Kontrola odkazů napříč články.
 *
 * Nic se neopravuje samo. U každého vadného odkazu se ukáže návrh a odkud
 * pochází — z přesměrování produktu, z produktové databáze nebo z mapy adres.
 * Opraví se to, co se potvrdí; „opravit vše" je pro případ, kdy jsou návrhy
 * zjevně správné a je jich hodně.
 */
function LinkCheckPanel({ langs }: { langs: { code: string; label: string }[] }) {
  const toast = useToast();
  const [rows, setRows] = useState<ArticleLinkCheck[]>([]);
  const [progress, setProgress] = useState<ArticleCheckProgress | null>(null);
  const [images, setImages] = useState(true);
  const [pickLangs, setPickLangs] = useState<string[]>(langs.map(l => l.code));
  const [busy, setBusy] = useState('');

  useEffect(() => { setPickLangs(langs.map(l => l.code)); }, [langs]);
  useEffect(() => { api.articles.lastCheck().then(setRows).catch(() => {}); }, []);
  useEffect(() => api.on('articles:check', (p: ArticleCheckProgress) => setProgress(p)), []);

  const run = async () => {
    try {
      setRows(await api.articles.check({ langs: pickLangs, images }));
      toast('Kontrola dokončená');
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const fix = async (row: ArticleLinkCheck) => {
    if (!row.suggestion) return;
    setBusy(`${row.articleId}|${row.lang}|${row.url}`);
    try {
      const count = await api.articles.fix(row.articleId, row.lang, row.url, row.suggestion);
      if (count > 0) setRows(prev => prev.filter(r => r !== row));
      else toast('Odkaz už v textu není.', 'error');
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const fixAll = async () => {
    try {
      const count = await api.articles.fixAll();
      toast(`Opraveno ${count} odkazů`);
      setRows(await api.articles.lastCheck());
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const withFix = rows.filter(r => r.suggestion).length;

  return (
    <>
      <div className="pt-filters">
        <div className="ig-seg">
          {langs.map(item => (
            <button key={item.code}
              className={pickLangs.includes(item.code) ? 'active' : ''}
              onClick={() => setPickLangs(prev => prev.includes(item.code)
                ? prev.filter(c => c !== item.code)
                : [...prev, item.code])}>
              {item.code.toUpperCase()}
            </button>
          ))}
        </div>
        <label className="pt-check">
          <input type="checkbox" checked={images} onChange={e => setImages(e.target.checked)} />
          <span>Kontrolovat i obrázky</span>
        </label>
        <span className="ig-muted">
          Projde odkazy ve všech načtených článcích a u vadných najde, kam dnes patří.
        </span>
        <span style={{ flex: 1 }} />
        {withFix > 0 && (
          <button className="btn ghost" onClick={fixAll}>
            <Icon name="check" size={13} /> Opravit vše ({withFix})
          </button>
        )}
        {progress?.running ? (
          <button className="btn ghost danger" onClick={() => api.articles.stopCheck()}>
            <Icon name="stop" size={12} /> Zastavit
          </button>
        ) : (
          <button className="btn primary" onClick={run}>
            <Icon name="link" size={13} /> Zkontrolovat
          </button>
        )}
      </div>

      <div className="modal-body ar-check">
        {progress?.running && (
          <div className="ar-check-bar">
            <div className="pt-status-track">
              <span style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} />
            </div>
            <span className="ig-muted">
              {progress.done}/{progress.total} · {progress.broken} vadných
            </span>
          </div>
        )}

        {rows.length === 0 && !progress?.running && (
          <div className="pt-mem-empty">
            <Icon name="link" size={26} />
            <b>Žádné vadné odkazy</b>
            <p className="ig-muted">
              Buď je vše v pořádku, nebo kontrola ještě neproběhla. Nejdřív načti export
              článků z Upgates — kontroluje se to, co je v aplikaci.
            </p>
          </div>
        )}

        {rows.map((row, index) => (
          <div key={index} className="ar-broken">
            <span className={`ar-status ${row.status && row.status < 500 ? 'warn' : 'bad'}`}>
              {row.status ?? '—'}
            </span>
            <div className="ar-broken-main">
              <div className="ar-broken-url">{row.url}</div>
              <div className="ig-muted">
                {row.articleTitle || `článek #${row.articleId}`} · {row.lang.toUpperCase()} · {row.kind} · {row.note}
              </div>
              {row.suggestion && (
                <div className="ar-fix">
                  <Icon name="chevRight" size={12} /> <code>{row.suggestion}</code>
                </div>
              )}
            </div>
            {row.suggestion && (
              <button className="btn ghost" disabled={busy.startsWith(`${row.articleId}|`)}
                onClick={() => fix(row)}>
                <Icon name="check" size={13} /> Opravit
              </button>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

/* ==================== Mapa adres ==================== */

/**
 * Které adresy si na jednotlivých trzích odpovídají.
 *
 * U produktů se to ví z produktové databáze, u kategorií a článků ne — ta se
 * učí z článků, které přeložené už jsou. Ruční záznam se zamkne a učení ho
 * nepřepíše.
 */
function UrlMapPanel({ langs }: { langs: { code: string; label: string }[] }) {
  const toast = useToast();
  const [rows, setRows] = useState<any[]>([]);
  const [search, setSearch] = useState('');
  const [learning, setLearning] = useState(false);
  const [draft, setDraft] = useState<{ fromLang: string; fromPath: string; toLang: string; toPath: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await api.articles.urlmap({ search: search.trim() || undefined }));
    } catch (e: any) {
      toast(e.message, 'error');
    }
  }, [search, toast]);

  useEffect(() => {
    const timer = setTimeout(load, search ? 250 : 0);
    return () => clearTimeout(timer);
  }, [load, search]);

  const learn = async () => {
    setLearning(true);
    try {
      const result = await api.articles.learnLinks();
      toast(`Z ${result.articles} článků ${result.pairs} dvojic adres`);
      await load();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setLearning(false);
    }
  };

  const save = async () => {
    if (!draft?.fromPath || !draft.toPath) { toast('Vyplň obě cesty.', 'error'); return; }
    try {
      await api.articles.saveUrlPair(draft.fromLang, draft.fromPath, draft.toLang, draft.toPath);
      setDraft(null);
      await load();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  return (
    <>
      <div className="pt-filters">
        <div className="ig-search">
          <Icon name="search" size={14} />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Hledat cestu" />
        </div>
        <span className="ig-muted">
          Podle téhle mapy se při překladu článku přepisují odkazy na kategorie a jiné články.
        </span>
        <span style={{ flex: 1 }} />
        <button className="btn ghost"
          onClick={() => setDraft({
            fromLang: langs[0]?.code ?? 'cz', fromPath: '',
            toLang: langs[1]?.code ?? 'sk', toPath: ''
          })}>
          <Icon name="plus" size={13} /> Přidat
        </button>
        <button className="btn primary" onClick={learn} disabled={learning}>
          {learning ? <span className="spinner-inline" /> : <Icon name="brain" size={14} />}
          Naučit se z článků
        </button>
      </div>

      <div className="modal-body ar-map">
        {draft && (
          <div className="ar-map-row editing">
            <select value={draft.fromLang} onChange={e => setDraft({ ...draft, fromLang: e.target.value })}>
              {langs.map(l => <option key={l.code} value={l.code}>{l.code.toUpperCase()}</option>)}
            </select>
            <input value={draft.fromPath} placeholder="/kravaty/"
              onChange={e => setDraft({ ...draft, fromPath: e.target.value })} />
            <Icon name="chevRight" size={12} />
            <select value={draft.toLang} onChange={e => setDraft({ ...draft, toLang: e.target.value })}>
              {langs.map(l => <option key={l.code} value={l.code}>{l.code.toUpperCase()}</option>)}
            </select>
            <input value={draft.toPath} placeholder="/neckties/"
              onChange={e => setDraft({ ...draft, toPath: e.target.value })} />
            <span style={{ flex: 1 }} />
            <button className="btn ghost" onClick={() => setDraft(null)}>Zpět</button>
            <button className="btn primary" onClick={save}><Icon name="save" size={13} /> Uložit</button>
          </div>
        )}

        {rows.length === 0 && !draft && (
          <div className="pt-mem-empty">
            <Icon name="link" size={26} />
            <b>Mapa je prázdná</b>
            <p className="ig-muted">
              Načti export článků z Upgates a dej „Naučit se z článků". Z článků, které
              přeložené jsou, aplikace vyčte, jak se kategorie jmenují na ostatních trzích.
            </p>
          </div>
        )}

        {rows.map((row, index) => (
          <div key={index} className="ar-map-row">
            <span className="ar-lang">{row.fromLang.toUpperCase()}</span>
            <code>{row.fromPath}</code>
            <Icon name="chevRight" size={12} />
            <span className="ar-lang">{row.toLang.toUpperCase()}</span>
            <code>{row.toPath}</code>
            <span className="ar-kind">{row.kind}</span>
            <span style={{ flex: 1 }} />
            {row.locked
              ? <span className="pt-mem-badge manual">ruční</span>
              : <span className="pt-mem-badge">{row.hits}×</span>}
            <button className="icon-btn" data-tip="Smazat"
              onClick={async () => {
                await api.articles.deleteUrlPair(row.fromLang, row.fromPath, row.toLang);
                load();
              }}>
              <Icon name="trash" size={14} />
            </button>
          </div>
        ))}
      </div>
    </>
  );
}
