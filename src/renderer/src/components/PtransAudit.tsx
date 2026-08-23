import { useCallback, useEffect, useState } from 'react';
import type { PtransAuditSummary, PtransColorRule, PtransBaseColor, PtransBundleRule } from '@shared/types';
import { api } from '../api';
import { useToast } from '../toast';
import Icon from './Icon';

/**
 * Audit feedu.
 *
 * Odpovídá na jednu otázku: **co v tomhle feedu brání tomu, aby se produkty
 * dohledaly.** Není to známka na vysvědčení — je to seznam konkrétních vad
 * seřazený podle toho, kolika produktů se týkají, protože jedna vada u tří set
 * produktů je jiná práce než tři sta různých vad.
 *
 * Vedle auditu jsou dvě věci, které se z něj řídí: **převodník barev** (bez něj
 * se barva pro Google nedá odvodit) a **pravidla pro sety** (co se aplikace
 * naučila o tom, co u Quentina set je a co ne). Obojí jsou znalosti, ne
 * nastavení — proto sedí tady a ne v Nastavení.
 */

const SEVERITY_LABEL: Record<string, string> = { error: 'chyba', warn: 'varování', info: 'doporučení' };

export default function PtransAuditPanel({ langs, onOpenProduct }: {
  langs: { code: string; label: string }[];
  onOpenProduct: (code: string) => void;
}) {
  const toast = useToast();
  const [view, setView] = useState<'audit' | 'colors' | 'bundles'>('audit');
  const [summary, setSummary] = useState<(PtransAuditSummary & { checkedAt?: string | null }) | null>(null);
  const [worst, setWorst] = useState<{ code: string; title: string; score: number; errors: number }[]>([]);
  const [lang, setLang] = useState(langs[0]?.code ?? 'cz');
  const [running, setRunning] = useState(false);

  const loadWorst = useCallback(async () => {
    try { setWorst(await api.ptrans.worst(lang, 40)); }
    catch (e: any) { toast(e.message, 'error'); }
  }, [lang, toast]);

  useEffect(() => { loadWorst(); }, [loadWorst]);

  // Po otevření se ukáže výsledek z minula. Projít kvůli třem číslům znovu
  // tisíc produktů by bylo plýtvání — a zakrylo by to, že jde o starší stav.
  useEffect(() => {
    api.ptrans.auditSummary().then(stored => { if (stored) setSummary(stored); }).catch(() => {});
  }, []);

  const run = async () => {
    setRunning(true);
    try {
      const result = await api.ptrans.audit({});
      setSummary(result);
      await loadWorst();
      toast(`Zkontrolováno ${result.checked} kombinací produkt–jazyk`);
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setRunning(false);
    }
  };

  return (
    <>
      <div className="pt-filters">
        <div className="ig-seg">
          <button className={view === 'audit' ? 'active' : ''} onClick={() => setView('audit')}>Kvalita feedu</button>
          <button className={view === 'colors' ? 'active' : ''} onClick={() => setView('colors')}>Barvy</button>
          <button className={view === 'bundles' ? 'active' : ''} onClick={() => setView('bundles')}>Sety</button>
        </div>
        {view === 'audit' && (
          <>
            <div className="ig-seg">
              {langs.map(item => (
                <button key={item.code} className={lang === item.code ? 'active' : ''}
                  onClick={() => setLang(item.code)}>{item.code.toUpperCase()}</button>
              ))}
            </div>
            <span className="ig-muted">
              {summary?.checkedAt
                ? `Poslední kontrola ${new Date(summary.checkedAt).toLocaleString('cs-CZ')}`
                : 'Projde všechny produkty a vypíše, co brání jejich dohledatelnosti.'}
            </span>
            <span style={{ flex: 1 }} />
            <button className="btn primary" onClick={run} disabled={running}>
              {running ? <span className="spinner-inline" /> : <Icon name="search" size={13} />}
              Zkontrolovat feed
            </button>
          </>
        )}
      </div>

      {view === 'colors' ? <ColorsPanel langs={langs} />
        : view === 'bundles' ? <BundlesPanel onOpenProduct={onOpenProduct} />
          : (
            <div className="modal-body pa-body">
              {summary && (
                <section className="pa-cards">
                  <div className="pa-card">
                    <b className={summary.averageScore >= 85 ? 'ok' : summary.averageScore >= 60 ? 'warn' : 'bad'}>
                      {summary.averageScore}
                    </b>
                    <small>průměrné skóre</small>
                  </div>
                  {summary.byLang.map(row => (
                    <div key={row.lang} className="pa-card">
                      <b className={row.average >= 85 ? 'ok' : row.average >= 60 ? 'warn' : 'bad'}>{row.average}</b>
                      <small>{row.lang.toUpperCase()} · {row.errors} chyb</small>
                    </div>
                  ))}
                </section>
              )}

              {summary && (
                <section>
                  <h3>Nejčastější vady</h3>
                  <p className="ig-muted">
                    Řazeno podle počtu produktů — jedna vada u tří set produktů je jedna
                    oprava, ne tři sta.
                  </p>
                  {summary.top.map(row => (
                    <div key={row.key} className={`pa-issue ${row.severity}`}>
                      <span className="pa-count">{row.count}×</span>
                      <span className={`pg-sev ${row.severity}`}>{SEVERITY_LABEL[row.severity]}</span>
                      <span className="pa-msg">{row.message}</span>
                    </div>
                  ))}
                </section>
              )}

              <section>
                <h3>Produkty, u kterých začít ({lang.toUpperCase()})</h3>
                {worst.length === 0 && (
                  <div className="ig-muted">
                    Audit ještě neproběhl. „Zkontrolovat feed" projde všechny produkty —
                    u tisícovky je to práce na pár vteřin.
                  </div>
                )}
                {worst.map(row => (
                  <button key={row.code} className="pa-row" onClick={() => onOpenProduct(row.code)}>
                    <span className={`pa-score ${row.score >= 85 ? 'ok' : row.score >= 60 ? 'warn' : 'bad'}`}>
                      {row.score}
                    </span>
                    <span className="pa-title">{row.title}</span>
                    <span className="pt-code">{row.code}</span>
                    <span style={{ flex: 1 }} />
                    {row.errors > 0 && <span className="pa-errors">{row.errors} chyb</span>}
                    <Icon name="chevRight" size={13} />
                  </button>
                ))}
              </section>
            </div>
          )}
    </>
  );
}

/* ==================== barvy ==================== */

/**
 * Převodník odstínů na základní barvy.
 *
 * Google filtruje podle hrstky základních barev; „světle modrá" mu shodu jen
 * rozmělní. Většinu převodů se aplikace naučí z produktů, které je vyplněné
 * mají, zbytek se dopíše sem.
 */
function ColorsPanel({ langs }: { langs: { code: string; label: string }[] }) {
  const toast = useToast();
  const [rules, setRules] = useState<PtransColorRule[]>([]);
  const [base, setBase] = useState<PtransBaseColor[]>([]);
  const [missing, setMissing] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [learning, setLearning] = useState(false);

  const load = useCallback(async () => {
    try {
      const [data, overview] = await Promise.all([
        api.ptrans.colors(search.trim() || undefined),
        api.ptrans.overview()
      ]);
      setRules(data.rules);
      setBase(data.base);
      setMissing(overview.colors.missing);
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
      const result = await api.ptrans.learnColors();
      toast(`Z ${result.products} produktů naučeno ${result.learned} převodů`
        + `${result.unknown.length ? `, ${result.unknown.length} odstínů nezařazeno` : ''}`);
      await load();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setLearning(false);
    }
  };

  const assign = async (source: string, key: string) => {
    try {
      await api.ptrans.saveColor(source, key);
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
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Hledat odstín" />
        </div>
        <span className="ig-muted">
          Google zná jen několik základních barev — odstín navíc mu shodu s dotazem rozmělní.
        </span>
        <span style={{ flex: 1 }} />
        <button className="btn primary" onClick={learn} disabled={learning}>
          {learning ? <span className="spinner-inline" /> : <Icon name="brain" size={14} />}
          Naučit se z feedu
        </button>
      </div>

      <div className="modal-body pa-body">
        {missing.length > 0 && (
          <section>
            <h3>Odstíny, které se nedají zařadit ({missing.length})</h3>
            <p className="ig-muted">
              U těchhle produktů zůstane barva pro Google prázdná, dokud jim nepřiřadíš
              základní barvu.
            </p>
            {missing.map(shade => (
              <div key={shade} className="pa-color missing">
                <b>{shade}</b>
                <span style={{ flex: 1 }} />
                <select defaultValue="" onChange={e => e.target.value && assign(shade, e.target.value)}>
                  <option value="">zařadit jako…</option>
                  {base.map(color => (
                    <option key={color.key} value={color.key}>{color.labels.cz}</option>
                  ))}
                </select>
              </div>
            ))}
          </section>
        )}

        <section>
          <h3>Převodník ({rules.length})</h3>
          {rules.length === 0 && (
            <div className="ig-muted">
              Zatím prázdný. „Naučit se z feedu" vytáhne převody z produktů, které
              základní barvu vyplněnou mají.
            </div>
          )}
          {rules.map(rule => {
            const color = base.find(item => item.key === rule.base);
            return (
              <div key={rule.source} className="pa-color">
                <b>{rule.source}</b>
                <Icon name="chevRight" size={12} />
                <select value={rule.base} onChange={e => assign(rule.source, e.target.value)}>
                  {base.map(item => (
                    <option key={item.key} value={item.key}>{item.labels.cz}</option>
                  ))}
                </select>
                <span className="ig-muted pa-langs">
                  {langs.filter(l => l.code !== 'cz').map(l => color?.labels[l.code] ?? '—').join(' · ')}
                </span>
                <span style={{ flex: 1 }} />
                {rule.locked
                  ? <span className="pt-mem-badge manual">ruční</span>
                  : <span className="pt-mem-badge">{rule.hits}×</span>}
                <button className="icon-btn" data-tip="Smazat"
                  onClick={async () => { await api.ptrans.deleteColor(rule.source); load(); }}>
                  <Icon name="trash" size={14} />
                </button>
              </div>
            );
          })}
        </section>
      </div>
    </>
  );
}

/* ==================== sety ==================== */

/**
 * Co se aplikace naučila o setech.
 *
 * Pravidlo se váže na **tvar názvu**, ne na jeden produkt — proto stačí jedno
 * rozhodnutí a přeřadí se všechny stejné sety naráz. Tady je vidět, jaká
 * pravidla platí, a dají se smazat.
 */
function BundlesPanel({ onOpenProduct }: { onOpenProduct: (code: string) => void }) {
  const toast = useToast();
  const [rules, setRules] = useState<PtransBundleRule[]>([]);
  const [preview, setPreview] = useState<{
    total: number; bundles: number; samples: { code: string; title: string; reason: string }[];
  } | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.ptrans.bundles();
      setRules(data.rules);
      setPreview(data.preview);
    } catch (e: any) {
      toast(e.message, 'error');
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="modal-body pa-body">
      <section>
        <h3>Jak to teď vychází</h3>
        {preview && (
          <p className="ig-muted">
            Z {preview.total} aktivních produktů vychází <b>{preview.bundles}</b> jako set.
            Google tím rozliší nabídku několika výrobků za jednu cenu od jednoho výrobku.
          </p>
        )}
        {(preview?.samples ?? []).map(item => (
          <button key={item.code} className="pa-row" onClick={() => onOpenProduct(item.code)}>
            <span className="pa-title">{item.title}</span>
            <span className="ig-muted pa-reason">{item.reason}</span>
            <span style={{ flex: 1 }} />
            <Icon name="chevRight" size={13} />
          </button>
        ))}
      </section>

      <section>
        <h3>Naučená pravidla ({rules.length})</h3>
        <p className="ig-muted">
          Vznikají tím, že v kartě produktu přepneš „Set" / „Jeden výrobek". Pravidlo
          platí pro stejný tvar názvu, takže jedno rozhodnutí přeřadí všechny obdobné
          produkty.
        </p>
        {rules.length === 0 && <div className="ig-muted">Zatím se aplikace nic nenaučila.</div>}
        {rules.map((rule, index) => (
          <div key={index} className="pa-rule">
            <span className={`pt-chip ${rule.isBundle ? 'done' : 'src'}`}>
              {rule.isBundle ? 'set' : 'jeden výrobek'}
            </span>
            <code>{rule.pattern}</code>
            {rule.category && <span className="ar-kind">{rule.category}</span>}
            <span style={{ flex: 1 }} />
            <span className="pt-mem-badge">{rule.hits}×</span>
            <button className="icon-btn" data-tip="Smazat pravidlo"
              onClick={async () => {
                await api.ptrans.deleteBundleRule(rule.category, rule.pattern);
                load();
              }}>
              <Icon name="trash" size={14} />
            </button>
          </div>
        ))}
      </section>
    </div>
  );
}
