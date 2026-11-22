import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AdsStatus, AdsOverview, AdsCampaignRow, AdsProducts, AdsProductRow, AdsSegment, AdsShipMethod,
  AdsGoogleCustomer, AdsConfig, AdsSystemTile, AdsProposals, AdsProposal, AdsChange, AdsGuards, AdsAccount,
  AdsChatTurn, AdsChatSummary, AdsSeasons, AdsSeasonPlan, AdsSeasonEvent, AdsMetaAccount, AdsReport, AdsReportCampaign
} from '@shared/ads';
import { SEGMENT_LABELS, MARKET_LABELS, guessMarket } from '@shared/ads';
import { api } from '../api';
import { useToast } from '../toast';
import Icon from './Icon';
import HelpButton from './HelpPanel';
import { inToolWindow } from '../toolwindows';
import { ADS_TERMS, SEGMENT_HELP } from '../adsTerms';

/**
 * Reklamy.
 *
 * Stáhne výkon z Google Ads a Skliku, spáruje ho
 * s objednávkami a nákupními cenami a ukáže, kolik reklama opravdu
 * vydělává. První číslo na každé obrazovce je **zisk po reklamě** — ne
 * tržba, ne ROAS. Tržba bez marže v e-shopu, kde jedna věc má marži 80 %
 * a jiná 30 %, o úspěchu reklamy nic neříká.
 *
 * Do účtu se zapisuje jen přes návrh, který člověk potvrdí tlačítkem
 * Použít — a každá provedená změna jde vrátit. Autopilot přijde až po
 * tom, co se ukáže, že odhady návrhů vycházejí.
 */

type Tab = 'today' | 'campaigns' | 'products' | 'proposals' | 'report' | 'seasons' | 'advisor' | 'settings';

const SYSTEM_LABEL: Record<string, string> = { google: 'Google Ads', sklik: 'Sklik', meta: 'Meta' };
const SYSTEM_SHORT: Record<string, string> = { google: 'G', sklik: 'S', meta: 'M' };
const SYSTEM_PHASE: Record<string, string> = { sklik: 'připoj v Nastavení', meta: 'připoj v Nastavení' };

const SEGMENT_ORDER: AdsSegment[] = ['hvezdy', 'pracanti', 'zrouti', 'spici', 'novinky', 'doprodej', 'vyprodano'];

const kc = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) ? '—' : `${Math.round(n).toLocaleString('cs-CZ')} Kč`;
const num = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) ? '—' : Math.round(n).toLocaleString('cs-CZ');
const pct = (n: number | null | undefined, digits = 1) =>
  n == null || !Number.isFinite(n) ? '—' : `${(n * 100).toLocaleString('cs-CZ', { maximumFractionDigits: digits })} %`;
const dayLabel = (iso: string) => {
  const [, m, d] = iso.split('-');
  return `${Number(d)}. ${Number(m)}.`;
};
const relTime = (iso: string) => {
  if (!iso) return 'nikdy';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 90_000) return 'teď';
  if (diff < 3600_000) return `před ${Math.round(diff / 60_000)} min`;
  if (diff < 36 * 3600_000) return `před ${Math.round(diff / 3600_000)} h`;
  return new Date(iso).toLocaleDateString('cs-CZ');
};

/**
 * Pojem s vysvětlením po najetí myší (tečkované podtržení). Zkratky jako
 * PNO nebo ROAS se nedají vynechat — jsou to slova z Google Ads — ale
 * nikdo nemusí vědět, co znamenají.
 */
function Term({ k, children }: { k: string; children: React.ReactNode }) {
  return <span className="ad-term" data-tip={ADS_TERMS[k] ?? ''}>{children}</span>;
}

type SortDir = 'asc' | 'desc';

/** Řazení tabulky klikem na hlavičku; druhý klik obrátí směr */
function useSort<T>(rows: T[], initial: { key: string; dir: SortDir }, value: (row: T, key: string) => number | string | null) {
  const [sort, setSort] = useState(initial);
  const sorted = useMemo(() => {
    const out = [...rows];
    out.sort((a, b) => {
      const va = value(a, sort.key);
      const vb = value(b, sort.key);
      // Prázdné hodnoty vždycky na konec, ať je to vzestupně, nebo sestupně
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      const cmp = typeof va === 'string' && typeof vb === 'string' ? va.localeCompare(vb, 'cs') : Number(va) - Number(vb);
      return sort.dir === 'asc' ? cmp : -cmp;
    });
    return out;
  }, [rows, sort, value]);
  const toggle = (key: string, firstDir: SortDir = 'desc') =>
    setSort(prev => (prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: firstDir }));
  return { sorted, sort, toggle };
}

function SortTh({ k, sort, onSort, right, children, tip, firstDir }: {
  k: string; sort: { key: string; dir: SortDir }; onSort: (k: string, d?: SortDir) => void;
  right?: boolean; children: React.ReactNode; tip?: string; firstDir?: SortDir;
}) {
  const on = sort.key === k;
  return (
    <th className={`${right ? 'r' : ''} ad-sortable ${on ? 'on' : ''}`} onClick={() => onSort(k, firstDir)}
      data-tip={tip} aria-sort={on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      {children}<span className="ad-sort-ico">{on ? (sort.dir === 'asc' ? '▲' : '▼') : '↕'}</span>
    </th>
  );
}

/** Změna proti minulému období jako štítek */
function Delta({ now, prev, invert = false }: { now: number; prev: number; invert?: boolean }) {
  if (!prev) return null;
  const change = (now - prev) / Math.abs(prev);
  const good = invert ? change <= 0 : change >= 0;
  return (
    <span className={`ad-chip ${good ? 'ok' : 'bad'}`}
      data-tip={`Předchozí stejně dlouhé období: ${Math.round(prev).toLocaleString('cs-CZ')}`}>
      {change >= 0 ? '+' : ''}{Math.round(change * 100)} %
    </span>
  );
}

/** Malá křivka útraty a hodnoty konverzí */
function Spark({ daily }: { daily: AdsSystemTile['daily'] }) {
  const max = Math.max(1, ...daily.map(d => Math.max(d.cost, d.value)));
  const line = (key: 'cost' | 'value') => daily
    .map((d, i) => `${(i / Math.max(1, daily.length - 1)) * 200},${34 - (d[key] / max) * 30}`).join(' ');
  return (
    <svg className="ad-spark" viewBox="0 0 200 36" preserveAspectRatio="none" aria-hidden>
      <polyline points={line('value')} className="v" />
      <polyline points={line('cost')} className="c" />
    </svg>
  );
}

/** Denní zisk po reklamě: sloupce zisku z objednávek, přes ně útrata */
function DailyChart({ days }: { days: AdsOverview['daily'] }) {
  if (!days.length) return null;
  const max = Math.max(1, ...days.map(d => Math.max(d.profit, d.cost)));
  const w = 100 / days.length;
  return (
    <div className="ad-daily">
      <svg viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden>
        {days.map((d, i) => (
          <g key={d.date}>
            <rect x={i * w + w * 0.15} width={w * 0.7} y={40 - (Math.max(0, d.profit) / max) * 38}
              height={(Math.max(0, d.profit) / max) * 38} className="p" />
            <rect x={i * w + w * 0.3} width={w * 0.4} y={40 - (d.cost / max) * 38}
              height={(d.cost / max) * 38} className="c" />
          </g>
        ))}
      </svg>
      <div className="ad-daily-hover">
        {days.map(d => (
          <span key={d.date} data-tip={`${dayLabel(d.date)}: ${d.orders} obj., zisk ${kc(d.profit)}, reklama ${kc(d.cost)}`} />
        ))}
      </div>
      <div className="ad-daily-axis"><span>{dayLabel(days[0].date)}</span><span>{dayLabel(days[days.length - 1].date)}</span></div>
    </div>
  );
}

export default function AdsModal({ onClose }: { onClose: () => void }) {
  const okno = inToolWindow();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('today');
  const [days, setDays] = useState(30);
  // Trh: 'all' = všechny sledované dohromady
  const [market, setMarket] = useState('all');
  const [status, setStatus] = useState<AdsStatus | null>(null);
  const [overview, setOverview] = useState<AdsOverview | null>(null);
  const [campaigns, setCampaigns] = useState<AdsCampaignRow[] | null>(null);
  const [products, setProducts] = useState<AdsProducts | null>(null);
  const [proposals, setProposals] = useState<AdsProposals | null>(null);
  const [busy, setBusy] = useState('');
  // Otevřený rozhovor s poradcem přežije přepnutí záložky; rozhovory samy jsou uložené
  const [chatId, setChatId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const st = await api.ads.status();
      setStatus(st);
      // Návrhy se načítají vždy — číslo u záložky a „Čeká na tebe" v Dnes
      setProposals(await api.ads.proposals());
      if (tab === 'today') setOverview(await api.ads.overview(days, market));
      if (tab === 'campaigns') setCampaigns(await api.ads.campaigns(days, market));
      if (tab === 'products') setProducts(await api.ads.products(days, market));
    } catch (e: any) {
      toast(e.message, 'error');
    }
  }, [tab, days, market, toast]);
  const markets = status?.config.markets ?? ['cz'];

  useEffect(() => { void load(); }, [load]);
  // Nová data z nočního běhu nebo z jiného Macu
  useEffect(() => api.on('ads:changed', () => { void load(); }), [load]);

  const fetchNow = async () => {
    setBusy('fetch');
    try {
      const result = await api.ads.fetch();
      toast(`Načteno: ${result}`, 'info');
      await load();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const connected = !!status?.google.connected || (!!status?.sklik?.hasToken && !!status?.config.sklik.enabled)
    || (!!status?.meta?.hasToken && !!status?.config.meta.enabled);

  return (
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal ad-modal">
        <div className="modal-head">
          <span className="modal-title"><Icon name="megaphone" size={16} /> Reklamy</span>
          <HelpButton topic="ads" />
          <div className="ig-seg ad-tabs">
            <button className={tab === 'today' ? 'active' : ''} onClick={() => setTab('today')}>Dnes</button>
            <button className={tab === 'campaigns' ? 'active' : ''} onClick={() => setTab('campaigns')}>Kampaně</button>
            <button className={tab === 'products' ? 'active' : ''} onClick={() => setTab('products')}>Produkty</button>
            <button className={tab === 'proposals' ? 'active' : ''} onClick={() => setTab('proposals')}>
              Návrhy{proposals && proposals.open.length > 0 && <b className="ad-count">{proposals.open.length}</b>}
            </button>
            <button className={tab === 'report' ? 'active' : ''} onClick={() => setTab('report')}>Report</button>
            <button className={tab === 'seasons' ? 'active' : ''} onClick={() => setTab('seasons')}>Sezóny</button>
            <button className={tab === 'advisor' ? 'active' : ''} onClick={() => setTab('advisor')}>Poradce</button>
            <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>Nastavení</button>
          </div>
          <span style={{ flex: 1 }} />
          {tab !== 'settings' && tab !== 'proposals' && markets.length > 1 && (
            <select className="ad-period" value={market} onChange={e => setMarket(e.target.value)}
              data-tip="Čísla za všechny trhy dohromady, nebo jen za jeden. Každý trh má cílové PNO podle své marže.">
              <option value="all">Všechny trhy</option>
              {markets.map(m => <option key={m} value={m}>{MARKET_LABELS[m] ?? m}</option>)}
            </select>
          )}
          {tab !== 'settings' && tab !== 'proposals' && tab !== 'advisor' && tab !== 'seasons' && tab !== 'report' && (
            <select className="ad-period" value={days} onChange={e => setDays(Number(e.target.value))}
              data-tip="Období končí včerejškem — dnešek je rozdělaný a srovnával by se celý den s půlkou">
              <option value={7}>7 dní</option>
              <option value={14}>14 dní</option>
              <option value={30}>30 dní</option>
              <option value={90}>90 dní</option>
            </select>
          )}
          {connected && (
            <button className="btn ghost ad-fetch" onClick={fetchNow} disabled={!!busy}
              data-tip="Stáhne kampaně a výkon za posledních 28 dní. Jinak se to děje samo každou noc.">
              <Icon name="refresh" size={14} className={busy === 'fetch' ? 'spinning' : undefined} /> Načíst data
            </button>
          )}
          {!okno && (
            <button className="icon-btn" onClick={onClose} disabled={!!busy}><Icon name="x" size={16} /></button>
          )}
        </div>

        {status && <StatusLine status={status} />}

        <div className={`ad-body ${tab === 'advisor' ? 'ad-body-chat' : ''}`}>
          {tab === 'today' && (
            <Today overview={overview} status={status} proposals={proposals} onSettings={() => setTab('settings')}
              onProposals={() => setTab('proposals')} onChanged={load} />
          )}
          {tab === 'proposals' && status && (
            <Proposals data={proposals} status={status} onChanged={load} busy={busy} setBusy={setBusy} />
          )}
          {tab === 'campaigns' && status && (
            <NewCampaignBar market={market} status={status} onChanged={load} onProposals={() => setTab('proposals')} />
          )}
          {tab === 'campaigns' && <Campaigns rows={campaigns} />}
          {tab === 'products' && <Products data={products} />}
          {tab === 'report' && <Report market={market} />}
          {tab === 'seasons' && status && (
            <Seasons market={market} onChanged={load} onProposals={() => setTab('proposals')} />
          )}
          {tab === 'advisor' && status && (
            <Advisor chatId={chatId} setChatId={setChatId} market={market} status={status} proposals={proposals}
              onChanged={load} onProposals={() => setTab('proposals')} />
          )}
          {tab === 'settings' && status && (
            <Settings status={status} onStatus={setStatus} busy={busy} setBusy={setBusy} />
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------- report ---------- */

/** Číslo se správným tvarem (1 změna, 2 změny, 5 změn) */
const cs = (n: number, one: string, few: string, many: string) => `${n} ${n === 1 ? one : n >= 2 && n <= 4 ? few : many}`;

const SYS_NAME: Record<string, string> = { google: 'Google Ads', sklik: 'Sklik', meta: 'Meta' };
const VERDICT_LABEL: Record<string, string> = { better: 'vyšlo', worse: 'nevyšlo', same: 'beze změny', pending: 'vyhodnotí se' };

/**
 * Graf období: zisk po reklamě po dnech (čára) proti předchozímu období
 * (přerušovaná) a náklady na reklamu (sloupce). Dny se zarovnají podle
 * pořadí — 1. den týdne proti 1. dni předchozího.
 */
function ReportChart({ now, prev }: { now: AdsOverview['daily']; prev: AdsOverview['daily'] }) {
  if (!now.length) return <div className="muted small">Bez dat.</div>;
  const after = (d: AdsOverview['daily'][number]) => d.profit - d.cost;
  const vals = [...now.map(after), ...prev.map(after), ...now.map(d => d.cost), 0];
  const max = Math.max(1, ...vals);
  const min = Math.min(0, ...vals);
  const H = 120;
  const y = (v: number) => 8 + (1 - (v - min) / (max - min)) * (H - 16);
  const w = 100 / now.length;
  const line = (list: AdsOverview['daily']) => list.slice(0, now.length)
    .map((d, i) => `${(i + 0.5) * w},${y(after(d))}`).join(' ');
  return (
    <div className="ad-rchart">
      <svg viewBox={`0 0 100 ${H}`} preserveAspectRatio="none" aria-hidden>
        <line x1={0} x2={100} y1={y(0)} y2={y(0)} className="zero" />
        {now.map((d, i) => (
          <rect key={d.date} x={i * w + w * 0.25} width={w * 0.5} y={y(Math.max(0, d.cost))} height={Math.max(0, y(0) - y(d.cost))} className="cost" />
        ))}
        {prev.length > 1 && <polyline points={line(prev)} className="prev" />}
        <polyline points={line(now)} className="now" />
      </svg>
      <div className="ad-daily-hover">
        {now.map((d, i) => (
          <span key={d.date} data-tip={`${dayLabel(d.date)}: zisk po reklamě ${kc(after(d))}, reklama ${kc(d.cost)}, ${d.orders} obj.`
            + (prev[i] ? ` · předchozí období ${kc(after(prev[i]))}` : '')} />
        ))}
      </div>
      <div className="ad-daily-axis"><span>{dayLabel(now[0].date)}</span><span>{dayLabel(now[now.length - 1].date)}</span></div>
    </div>
  );
}

/** Malá křivka kampaně: útrata (červeně) a hodnota konverzí (zeleně) */
function MiniTrend({ series }: { series: AdsReportCampaign['series'] }) {
  if (series.length < 2) return <span className="muted small">—</span>;
  const max = Math.max(1, ...series.map(d => Math.max(d.cost, d.value)));
  const pts = (k: 'cost' | 'value') => series.map((d, i) => `${(i / (series.length - 1)) * 60},${20 - (d[k] / max) * 18}`).join(' ');
  return (
    <svg className="ad-mini-trend" viewBox="0 0 60 22" preserveAspectRatio="none" aria-hidden>
      <polyline points={pts('value')} className="v" /><polyline points={pts('cost')} className="c" />
    </svg>
  );
}

const reportCampValue = (row: AdsReportCampaign, key: string): number | string | null => {
  if (key === 'delta') return row.prevProfit == null ? null : row.profit - row.prevProfit;
  if (key === 'system') return row.system;
  return campaignValue(row, key);
};

/** Všechny kampaně období: řazení, trend, srovnání s předchozím, rozbalení po dnech */
function ReportCampaigns({ rows }: { rows: AdsReportCampaign[] }) {
  const { sorted, sort, toggle } = useSort(rows, { key: 'cost', dir: 'desc' }, reportCampValue);
  const [open, setOpen] = useState('');
  if (!rows.length) return <div className="muted small">V tomhle období žádná kampaň neutrácela.</div>;
  return (
    <table className="ad-table ad-rcamps">
      <thead>
        <tr>
          <SortTh k="name" sort={sort} onSort={toggle} firstDir="asc">Kampaň</SortTh>
          <SortTh k="cost" sort={sort} onSort={toggle} right>Útrata</SortTh>
          <SortTh k="value" sort={sort} onSort={toggle} right tip={ADS_TERMS.value}>Hodnota</SortTh>
          <SortTh k="profit" sort={sort} onSort={toggle} right tip="Hodnota konverzí × marže − útrata">Zisk</SortTh>
          <SortTh k="delta" sort={sort} onSort={toggle} right tip="Zisk kampaně proti předchozímu stejně dlouhému období">Proti předchozímu</SortTh>
          <SortTh k="pno" sort={sort} onSort={toggle} right tip={`${ADS_TERMS.pno} Cíl: ${ADS_TERMS.targetPno}`}>PNO / cíl</SortTh>
          <th className="r" data-tip="Útrata (červeně) a hodnota konverzí (zeleně) po dnech">Průběh</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map(c => {
          const key = `${c.system}|${c.id}`;
          const delta = c.prevProfit == null ? null : c.profit - c.prevProfit;
          const over = c.pno != null && c.targetPno != null && c.pno > c.targetPno;
          return (
            <React.Fragment key={key}>
              <tr className={`ad-rcamp ${open === key ? 'open' : ''}`} onClick={() => setOpen(open === key ? '' : key)}>
                <td>
                  <div className="ad-name">
                    <span className={`ad-badge ${c.system}`}>{SYSTEM_SHORT[c.system]}</span>
                    <span className="ad-ptitle">{c.name}</span>
                    {c.status !== 'ENABLED' && <span className="ad-chip">stojí</span>}
                    {c.market && <span className="ad-market">{MARKET_LABELS[c.market] ?? c.market}</span>}
                  </div>
                </td>
                <td className="r">{kc(c.cost)}</td>
                <td className="r">{kc(c.value)}</td>
                <td className={`r ${c.profit < 0 ? 'neg' : ''}`}><b>{kc(c.profit)}</b></td>
                <td className={`r ${delta == null ? 'muted' : delta >= 0 ? 'pos' : 'neg'}`}>
                  {delta == null ? 'nová' : `${delta >= 0 ? '+' : '−'}${kc(Math.abs(delta))}`}
                </td>
                <td className={`r ${over ? 'neg' : ''}`}>{pct(c.pno)} / {pct(c.targetPno, 0)}</td>
                <td className="r"><MiniTrend series={c.series} /></td>
              </tr>
              {open === key && (
                <tr className="ad-rcamp-days">
                  <td colSpan={7}>
                    <div className="ad-rdays">
                      <table>
                        <thead><tr><th />{c.series.map(d => <th key={d.date}>{dayLabel(d.date)}</th>)}</tr></thead>
                        <tbody>
                          <tr><th>Útrata</th>{c.series.map(d => <td key={d.date} className="neg">{num(d.cost)}</td>)}</tr>
                          <tr><th>Hodnota</th>{c.series.map(d => <td key={d.date} className="pos">{num(d.value)}</td>)}</tr>
                        </tbody>
                      </table>
                    </div>
                    <div className="muted small">
                      Útrata a hodnota konverzí po dnech. Předchozí období: útrata {kc(c.prevCost)}
                      {c.prevProfit != null ? `, zisk ${kc(c.prevProfit)}` : ''}.
                    </div>
                  </td>
                </tr>
              )}
            </React.Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * Report za uzavřený týden nebo měsíc. Nahoře příběh (jak to dopadlo, proč,
 * co dál), pod ním čísla, graf proti předchozímu období a všechny kampaně
 * s trendem. Shrnutí poradce na požádání, PDF na poslání.
 */
function Report({ market }: { market: string }) {
  const toast = useToast();
  const [kind, setKind] = useState<'week' | 'month'>('week');
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<AdsReport | null>(null);
  const [busy, setBusy] = useState('');
  const [allFindings, setAllFindings] = useState(false);
  const load = useCallback(async () => {
    try { setData(await api.ads.report(kind, offset, market)); } catch (e: any) { toast(e.message, 'error'); }
  }, [kind, offset, market, toast]);
  useEffect(() => { setData(null); void load(); }, [load]);

  const summarize = async () => {
    setBusy('summary');
    try { await api.ads.reportSummary(kind, offset, market); await load(); } catch (e: any) { toast(e.message, 'error'); }
    finally { setBusy(''); }
  };
  const pdf = async () => {
    setBusy('pdf');
    try { const file = await api.ads.reportPdf(kind, offset, market); if (file) toast('Report je uložený jako PDF', 'info'); }
    catch (e: any) { toast(e.message, 'error'); } finally { setBusy(''); }
  };

  const o = data?.overview;
  const sys = o?.systems.filter(x => x.connected && (x.cost > 0 || x.value > 0)) ?? [];
  const sysMax = Math.max(1, ...sys.map(x => Math.max(x.cost, x.profit, 0)));
  return (
    <div className="ad-report">
      <div className="ad-report-bar">
        <div className="ig-seg">
          <button className={kind === 'week' ? 'active' : ''} onClick={() => { setKind('week'); setOffset(0); }}>Týden</button>
          <button className={kind === 'month' ? 'active' : ''} onClick={() => { setKind('month'); setOffset(0); }}>Měsíc</button>
        </div>
        <div className="ad-report-nav">
          <button className="icon-btn" onClick={() => setOffset(offset + 1)} data-tip="Předchozí období"><Icon name="chevron-left" size={16} /></button>
          <b className="ad-report-label">{data?.label ?? '…'}</b>
          <button className="icon-btn" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 1))} data-tip="Další období">
            <Icon name="chevron-right" size={16} /></button>
        </div>
        <span style={{ flex: 1 }} />
        <button className="btn ghost small" disabled={!!busy || !data} onClick={pdf}>
          <Icon name="download" size={13} /> {busy === 'pdf' ? 'Ukládám…' : 'Uložit PDF'}
        </button>
      </div>
      {!data || !o ? <div className="ad-empty">Načítám…</div> : (
        <>
          <section className={`ad-card ad-story ${data.story.tone}`}>
            <div className="ad-story-head">
              <span className="ad-story-dot" />
              <h3>{data.story.headline}</h3>
            </div>
            <div className="ad-story-cols">
              <div>
                <div className="ad-h">Proč</div>
                {data.story.why.length ? <ul>{data.story.why.map((w, i) => <li key={i}>{w}</li>)}</ul>
                  : <div className="muted small">Bez výrazných změn proti předchozímu období.</div>}
              </div>
              <div>
                <div className="ad-h">Co dál</div>
                {data.story.next.length ? <ol>{data.story.next.map((n, i) => <li key={i}>{n}</li>)}</ol>
                  : <div className="muted small">Teď není co měnit.</div>}
              </div>
            </div>
            {data.summary ? (
              <div className="ad-story-ai">
                <div className="ad-h"><Icon name="sparkles" size={12} /> Poradce</div>
                <RichText text={data.summary} />
              </div>
            ) : (
              <button className="btn small ad-story-ask" disabled={!!busy} onClick={summarize}
                data-tip="Poradce napíše pár vět vlastními slovy: co táhlo, co brzdilo a co dál. Uloží se k reportu.">
                <Icon name="sparkles" size={13} /> {busy === 'summary' ? 'Píšu…' : 'Rozepsat poradcem'}
              </button>
            )}
          </section>

          <div className="ad-kpis">
            <div className="ad-card ad-kpi hero">
              <div className="ad-h"><Term k="profitAfterAds">Zisk po reklamě</Term></div>
              <div className="ad-v">{kc(o.profitAfterAds.value)}</div>
              <div className="ad-d"><Delta now={o.profitAfterAds.value} prev={o.profitAfterAds.prev} />
                <span className="muted">{pct(o.profitShare, 1)} z obratu · cíl {pct(data.target, 0)}</span></div>
            </div>
            <div className="ad-card ad-kpi">
              <div className="ad-h">Obrat bez DPH</div><div className="ad-v">{num(o.revenue.value)}</div>
              <div className="ad-d"><Delta now={o.revenue.value} prev={o.revenue.prev} /> <span className="muted">{o.orders.value} objednávek</span></div>
            </div>
            <div className="ad-card ad-kpi">
              <div className="ad-h">Náklady na reklamu</div><div className="ad-v">{num(o.cost.value)}</div>
              <div className="ad-d"><Delta now={o.cost.value} prev={o.cost.prev} invert /> <span className="muted">Kč bez DPH</span></div>
            </div>
            <div className="ad-card ad-kpi">
              <div className="ad-h"><Term k="shopPno">PNO e-shopu</Term></div><div className="ad-v">{pct(o.shopPno)}</div>
              <div className="ad-d"><span className="muted">cíl {pct(o.targetPno, 0)}</span></div>
            </div>
          </div>

          <div className="ad-report-cols wide">
            <section className="ad-card ad-report-box">
              <div className="ad-prop-head"><b>Zisk po reklamě po dnech</b>
                <span className="ad-legend-inline small">
                  <i className="now" /> toto období <i className="prev" /> předchozí <i className="cost" /> náklady na reklamu
                </span>
              </div>
              <ReportChart now={o.daily} prev={data.prevDaily} />
            </section>
            <section className="ad-card ad-report-box">
              <div className="ad-prop-head"><b>Systémy</b><span className="muted small">útrata a zisk z konverzí</span></div>
              {sys.length === 0 && <div className="muted small">V tomhle období bez útraty.</div>}
              {sys.map(x => (
                <div key={x.system} className="ad-sysbar">
                  <div className="ad-sysbar-name"><span className={`ad-badge ${x.system}`}>{SYSTEM_SHORT[x.system]}</span> {SYS_NAME[x.system]}
                    <span className={`muted small ${x.pno != null && x.targetPno != null && x.pno > x.targetPno ? 'neg' : ''}`}>PNO {pct(x.pno)}</span>
                  </div>
                  <div className="ad-sysbar-row"><span className="lbl">útrata</span>
                    <span className="track"><i className="c" style={{ width: `${(x.cost / sysMax) * 100}%` }} /></span><span className="num">{kc(x.cost)}</span></div>
                  <div className="ad-sysbar-row"><span className="lbl">zisk</span>
                    <span className="track"><i className={x.profit >= 0 ? 'p' : 'n'} style={{ width: `${(Math.abs(x.profit) / sysMax) * 100}%` }} /></span>
                    <span className={`num ${x.profit < 0 ? 'neg' : ''}`}>{kc(x.profit)}</span></div>
                </div>
              ))}
              {o.markets.length > 1 && (
                <table className="ad-mini">
                  <thead><tr><th>Trh</th><th className="r">Obrat</th><th className="r">Náklady</th><th className="r">Zisk po reklamě</th></tr></thead>
                  <tbody>
                    {o.markets.map(m => (
                      <tr key={m.market}><td>{MARKET_LABELS[m.market] ?? m.market}</td><td className="r">{kc(m.revenue)}</td>
                        <td className="r">{kc(m.cost)}</td><td className={`r ${m.profitAfterAds < 0 ? 'neg' : ''}`}>{kc(m.profitAfterAds)}</td></tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </div>

          <section className="ad-card ad-report-box">
            <div className="ad-prop-head"><b>Kampaně</b><span className="muted small">klik na řádek ukáže dny · řazení klikem na hlavičku</span></div>
            <ReportCampaigns rows={data.all} />
          </section>

          <div className="ad-report-cols">
            <section className="ad-card ad-report-box">
              <div className="ad-prop-head"><b>Hvězdy</b><span className="muted small">nejvíc vydělaly</span></div>
              {data.stars.length === 0 ? <div className="muted small">—</div> : (
                <ul className="ad-report-list">{data.stars.map(p => <li key={p.code}><span>{p.title}</span><b>{kc(p.profit)}</b></li>)}</ul>
              )}
            </section>
            <section className="ad-card ad-report-box">
              <div className="ad-prop-head"><b>Žrouti</b><span className="muted small">utrácí bez prodeje</span></div>
              {data.eaters.length === 0 ? <div className="muted small">—</div> : (
                <ul className="ad-report-list">{data.eaters.map(p => <li key={p.code}><span>{p.title}</span><b className="neg">{kc(p.cost)}</b></li>)}</ul>
              )}
            </section>
          </div>

          <div className="ad-report-cols">
            <section className="ad-card ad-report-box">
              <div className="ad-prop-head"><b>Změny v účtech</b>
                <span className="muted small">
                  {cs(data.stats.applied, 'změna', 'změny', 'změn')}{data.stats.autopilot ? `, z toho ${data.stats.autopilot} autopilot` : ''}
                  {' · '}{cs(data.stats.dismissed, 'zamítnutý návrh', 'zamítnuté návrhy', 'zamítnutých návrhů')}
                </span>
              </div>
              {data.changes.length === 0 ? <div className="muted small">V tomhle období se v účtech nic neměnilo.</div> : (
                <ul className="ad-report-list">
                  {data.changes.map((c, i) => (
                    <li key={i}><span>{new Date(c.at).toLocaleDateString('cs-CZ')} · {c.title}</span>
                      <b>{c.reverted ? 'vráceno' : VERDICT_LABEL[c.verdict] ?? ''}</b></li>
                  ))}
                </ul>
              )}
            </section>
            <section className="ad-card ad-report-box">
              <div className="ad-prop-head"><b>Všechna zjištění</b><span className="muted small">spočítaná z čísel</span>
                {data.findings.length > 4 && (
                  <button className="linkish small" onClick={() => setAllFindings(!allFindings)}>{allFindings ? 'méně' : 'všechna'}</button>
                )}
              </div>
              {data.findings.length === 0 && <div className="muted small">Bez výrazných změn.</div>}
              <ul className="ad-findings">
                {data.findings.slice(0, allFindings ? 99 : 4).map((f, i) => (
                  <li key={i} className={f.kind}><span>{f.text}</span><small>{f.basis}</small></li>
                ))}
              </ul>
            </section>
          </div>
        </>
      )}
    </div>
  );
}

/* ---------- sezóny ---------- */

const MONTHS = ['led', 'úno', 'bře', 'dub', 'kvě', 'čvn', 'čvc', 'srp', 'zář', 'říj', 'lis', 'pro'];
const weekOf = (day: string) => {
  const d = new Date(`${day}T12:00:00Z`);
  return Math.min(52, Math.floor((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1, 12)) / 86_400_000 / 7));
};
const shortDate = (day: string) => `${Number(day.slice(8, 10))}. ${Number(day.slice(5, 7))}.`;

/** Sezónní index po týdnech roku s pásy událostí a dneškem */
function SeasonChart({ index, events, today }: { index: (number | null)[]; events: AdsSeasonEvent[]; today: string }) {
  const max = Math.max(1.5, ...index.map(v => v ?? 0));
  const w = 100 / 53;
  const year = Number(today.slice(0, 4));
  // Pásy jen pro události, které jsou letos nebo nejbližší příští rok (jinak by se kryly)
  const bands = events.filter((e, i, all) => all.findIndex(x => x.name === e.name) === i);
  const tw = weekOf(today);
  return (
    <div className="ad-season-chart">
      <svg viewBox="0 0 100 44" preserveAspectRatio="none" aria-hidden>
        {bands.map(e => {
          const a = weekOf(e.start);
          const b = weekOf(e.end);
          const segs = a <= b ? [[a, b]] : [[a, 52], [0, b]];
          return segs.map(([x1, x2], k) => (
            <rect key={`${e.id}${k}`} x={x1 * w} width={(x2 - x1 + 1) * w} y={0} height={40} className="band" />
          ));
        })}
        <line x1={0} x2={100} y1={40 - (1 / max) * 38} y2={40 - (1 / max) * 38} className="avg" />
        {index.map((v, i) => v == null ? null : (
          <rect key={i} x={i * w + w * 0.15} width={w * 0.7} y={40 - (v / max) * 38} height={(v / max) * 38}
            className={`bar ${v >= 1.2 ? 'hi' : v <= 0.8 ? 'lo' : ''}`} />
        ))}
        <line x1={(tw + 0.5) * w} x2={(tw + 0.5) * w} y1={0} y2={40} className="today" />
      </svg>
      <div className="ad-season-hover">
        {index.map((v, i) => {
          const start = new Date(Date.UTC(year, 0, 1 + i * 7)).toISOString().slice(0, 10);
          return <span key={i} data-tip={v == null ? `Týden od ${shortDate(start)}: bez dat`
            : `Týden od ${shortDate(start)}: ${v.toLocaleString('cs-CZ')}× průměrného týdne`} />;
        })}
      </div>
      <div className="ad-season-axis">{MONTHS.map(m => <span key={m}>{m}</span>)}</div>
    </div>
  );
}

function SeasonCard({ e, market, onChanged, onProposals }: {
  e: AdsSeasonEvent; market: string; onChanged: () => void; onProposals: () => void;
}) {
  const toast = useToast();
  const [plan, setPlan] = useState<AdsSeasonPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); } catch (err: any) { toast(err.message, 'error'); } finally { setBusy(false); }
  };
  const ups = plan?.steps.filter(s => s.kind === 'budget-up').length ?? 0;
  return (
    <div className={`ad-card ad-season ${e.running ? 'running' : ''}`}>
      <div className="ad-prop-top">
        <b className="ad-season-name">{e.name}</b>
        <span className="ad-chip">{shortDate(e.start)} – {shortDate(e.end)}</span>
        {e.running && <span className="ad-chip warn">právě běží</span>}
        <span className={`ad-chip ${e.uplift >= 1.15 ? 'ok' : ''}`}
          data-tip={e.fromHistory
            ? 'Z vašich objednávek: kolikrát víc se v tomhle období prodává než v průměrném týdnu roku.'
            : 'Odhad — na vlastní historii je potřeba aspoň rok objednávek.'}>
          {e.uplift >= 1 ? '+' : '−'}{Math.abs(Math.round((e.uplift - 1) * 100))} % prodejů{e.fromHistory ? '' : ' (odhad)'}
        </span>
        {e.planned > 0 && <span className="ad-chip info">naplánováno {e.planned} kroků</span>}
      </div>
      <div className="ad-prop-plain">{e.note}</div>
      {plan && (
        <div className="ad-season-plan">
          {plan.steps.length === 0
            ? <div className="muted small">Žádná kampaň teď nedrží cíl tak, aby se jí vyplatilo v sezóně přidat.</div>
            : (
              <>
                <div className="small">
                  Ziskovým kampaním rozpočet nahoru o {Math.round((plan.uplift - 1) * 100)} % ve {ups} krocích, po konci zpátky.
                  Každý krok je návrh, který se ve svůj den nabídne ke schválení.
                </div>
                <ul className="ad-season-steps">
                  {plan.steps.map((s, i) => (
                    <li key={i} className={s.kind === 'budget-up' ? 'up' : 'down'}>
                      <span className="ad-chip">{shortDate(s.date)}</span>
                      {s.system === 'sklik' && <span className="ad-badge sklik">S</span>}
                      <span>{s.title.replace(/^[^:]+: /, '').replace(/ \(od [^)]+\)$/, '')}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          {plan.notes.length > 0 && <ul className="ad-msg-notes">{plan.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
        </div>
      )}
      <div className="ad-prop-btns">
        {!plan && (
          <button className="btn small" disabled={busy}
            onClick={() => run(async () => setPlan(await api.ads.seasonPlan(e.id, false, market)))}>
            {e.planned > 0 ? 'Navrhnout znovu' : 'Navrhnout plán'}
          </button>
        )}
        {plan && plan.steps.length > 0 && (
          <button className="btn primary small" disabled={busy} onClick={() => run(async () => {
            const res = await api.ads.seasonPlan(e.id, true, market);
            toast(`Naplánováno ${res.saved} kroků — najdeš je v Návrzích`, 'info');
            setPlan(null);
            onChanged();
          })}>{e.planned > 0 ? 'Nahradit plán' : 'Uložit do Návrhů'}</button>
        )}
        {plan && <button className="btn ghost small" onClick={() => setPlan(null)}>Zavřít</button>}
        {!plan && e.planned > 0 && (
          <>
            <button className="btn ghost small" onClick={onProposals}>Zobrazit v Návrzích</button>
            <button className="btn ghost small" disabled={busy} onClick={() => run(async () => {
              await api.ads.seasonDrop(e.id);
              toast('Plán zrušený', 'info');
              onChanged();
            })}>Zrušit plán</button>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Sezóny: kdy se prodává víc (z vlastních objednávek) a plán rozpočtů
 * na nejbližší události — kroky se uloží jako naplánované návrhy.
 */
function Seasons({ market, onChanged, onProposals }: { market: string; onChanged: () => void; onProposals: () => void }) {
  const toast = useToast();
  const [data, setData] = useState<AdsSeasons | null>(null);
  const [cat, setCat] = useState('');
  const load = useCallback(async () => {
    try { setData(await api.ads.seasons(market)); } catch (e: any) { toast(e.message, 'error'); }
  }, [market, toast]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => api.on('ads:changed', () => { void load(); }), [load]);
  if (!data) return <div className="ad-empty">Načítám…</div>;
  const series = cat ? data.categories.find(c => c.name === cat)?.index ?? data.index : data.index;
  const changed = () => { void load(); onChanged(); };
  return (
    <div className="ad-seasons">
      <section className="ad-card ad-season-box">
        <div className="ad-prop-head">
          <b>Kdy se prodává víc</b>
          <span className="muted small">
            {data.weeks >= 40
              ? `z objednávek ${data.years.join(', ')} · ${data.weeks} týdnů · 1 = průměrný týden`
              : 'na sezónní index je potřeba aspoň rok objednávek — u událostí je zatím odhad'}
          </span>
          <span style={{ flex: 1 }} />
          {data.categories.length > 0 && (
            <select className="ad-period" value={cat} onChange={e => setCat(e.target.value)}
              data-tip="Kšandy mají jinou sezónu než ponožky — index jde vidět i po hlavních kategoriích">
              <option value="">Celý e-shop</option>
              {data.categories.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
            </select>
          )}
        </div>
        <SeasonChart index={series} events={data.events} today={data.today} />
        <div className="ad-season-legend">
          <span><i className="ad-sw hi" /> silný týden (1,2× a víc)</span>
          <span><i className="ad-sw lo" /> slabý týden</span>
          <span><i className="ad-sw band" /> sezónní událost</span>
          <span><i className="ad-sw today" /> dnes</span>
        </div>
      </section>
      <div className="ad-prop-head"><b>Nejbližší události</b>
        <span className="muted small">plán přidá rozpočet jen kampaním, které drží cíl, a po konci ho vrátí</span>
      </div>
      <div className="ad-season-list">
        {data.events.map(e => <SeasonCard key={e.id} e={e} market={market} onChanged={changed} onProposals={onProposals} />)}
      </div>
    </div>
  );
}

/* ---------- poradce ---------- */

/**
 * Text odpovědi: odstavce, nadpisy „### ", odrážky „- ", číslované
 * seznamy „1. " a **tučně**. Bez HTML z modelu — odpověď se skládá
 * z React prvků, takže v ní nic nespustí skript. Čte se po řádcích, aby
 * smíšený blok (věta a pod ní odrážky) nevypadal rozházeně.
 */
function RichText({ text }: { text: string }) {
  const bold = (line: string) => line.split(/\*\*(.+?)\*\*/g).map((part, i) => (i % 2 ? <b key={i}>{part}</b> : part));
  type Block = { kind: 'p' | 'h' | 'ul' | 'ol'; lines: string[] };
  const blocks: Block[] = [];
  for (const raw of String(text ?? '').replace(/\r/g, '').split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) { blocks.push({ kind: 'p', lines: [] }); continue; }
    const h = line.match(/^\s*#{1,4}\s+(.*)$/);
    const ul = line.match(/^\s*[-•*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    const kind: Block['kind'] = h ? 'h' : ul ? 'ul' : ol ? 'ol' : 'p';
    const body = (h ?? ul ?? ol)?.[1] ?? line.trim();
    const last = blocks[blocks.length - 1];
    if (kind !== 'h' && last && last.kind === kind && last.lines.length) last.lines.push(body);
    else blocks.push({ kind, lines: [body] });
  }
  return (
    <div className="ad-rich">
      {blocks.filter(b => b.lines.length).map((b, i) => {
        if (b.kind === 'h') return <h4 key={i}>{bold(b.lines[0].replace(/\*\*/g, ''))}</h4>;
        if (b.kind === 'ul') return <ul key={i}>{b.lines.map((l, j) => <li key={j}>{bold(l)}</li>)}</ul>;
        if (b.kind === 'ol') return <ol key={i}>{b.lines.map((l, j) => <li key={j}>{bold(l)}</li>)}</ol>;
        return <p key={i}>{b.lines.map((l, j) => <React.Fragment key={j}>{j > 0 && <br />}{bold(l)}</React.Fragment>)}</p>;
      })}
    </div>
  );
}

const ADVISOR_STARTERS = [
  { title: 'Jak si stojíme?', q: 'Jak si stojíme proti cíli za posledních 30 dní a co nás nejvíc brzdí?' },
  { title: 'Co prodělává', q: 'Které kampaně a produkty prodělávají a co s nimi udělat? Navrhni konkrétní změny.' },
  { title: 'Plán na Vánoce', q: 'Naplánuj rozpočty na Vánoce — kdy a kolik přidat, kdy ubrat. Vytvoř kroky.' },
  { title: 'Zbytečné dotazy', q: 'Na jaké hledané dotazy utrácíme bez prodeje? Navrhni vylučující slova.' },
  { title: 'Minulý měsíc', q: 'Jak dopadl minulý měsíc proti předminulému a proč?' },
  { title: 'Kde přidat', q: 'Kde by přidané peníze vydělaly nejvíc? Navrhni, kam přidat rozpočet.' }
];

const ago = (iso: string) => {
  const d = new Date(iso);
  const today = new Date();
  return d.toDateString() === today.toDateString()
    ? d.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric' });
};

/** Návrh vzniklý z odpovědi: dokud je otevřený, jde rovnou použít */
function ChatProposal({ snap, live, status, onChanged }: {
  snap: AdsProposal; live: AdsProposal | undefined; status: AdsStatus; onChanged: () => void;
}) {
  if (live) return <ProposalCard p={live} status={status} compact onChanged={onChanged} />;
  return (
    <div className="ad-chat-prop done">
      <Icon name="check" size={13} /> <span>{snap.title}</span>
    </div>
  );
}

/**
 * Poradce: vlevo rozhovory (uložené, sdílené mezi Macy), vpravo rozhovor.
 * Poradce si data dohledá sám (vidět je, kam se díval) a změny navrhuje
 * jako obyčejné návrhy, které jdou použít přímo z odpovědi.
 */
function Advisor({ chatId, setChatId, market, status, proposals, onChanged, onProposals }: {
  chatId: string | null; setChatId: (id: string | null) => void; market: string; status: AdsStatus;
  proposals: AdsProposals | null; onChanged: () => void; onProposals: () => void;
}) {
  const toast = useToast();
  const [list, setList] = useState<AdsChatSummary[]>([]);
  const [turns, setTurns] = useState<AdsChatTurn[]>([]);
  const [text, setText] = useState('');
  const [pending, setPending] = useState<{ q: string; steps: string[] } | null>(null);
  const [failed, setFailed] = useState<string>('');
  const end = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  const loadList = useCallback(async () => { try { setList(await api.ads.chats()); } catch { /* seznam příště */ } }, []);
  useEffect(() => { void loadList(); }, [loadList]);
  useEffect(() => api.on('ads:changed', (p: any) => { if (p?.chats) void loadList(); }), [loadList]);
  useEffect(() => {
    if (!chatId) { setTurns([]); return; }
    let live = true;
    api.ads.chat(chatId).then(c => { if (live) setTurns(c?.turns ?? []); }).catch(() => {});
    return () => { live = false; };
  }, [chatId]);
  useEffect(() => api.on('ads:advisor', (p: any) => {
    setPending(cur => (cur ? { ...cur, steps: cur.steps.includes(p?.step) ? cur.steps : [...cur.steps, String(p?.step ?? '')] } : cur));
  }), []);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end', behavior: 'smooth' }); }, [turns.length, pending, failed]);
  // Výška pole roste s textem (do pěti řádků)
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(140, el.scrollHeight)}px`;
  }, [text]);

  const liveOpen = new Map((proposals?.open ?? []).concat(proposals?.planned ?? []).map(p => [p.id, p]));

  const send = async (question: string) => {
    const q = question.trim();
    if (!q || pending) return;
    setText('');
    setFailed('');
    setPending({ q, steps: [] });
    try {
      const reply = await api.ads.ask(chatId, q, market);
      if (reply.chat) {
        setChatId(reply.chat.id);
        setTurns(reply.chat.turns);
      }
      if (reply.proposals.length) onChanged();
      void loadList();
    } catch (e: any) {
      setFailed(q);
      toast(e.message, 'error');
    } finally {
      setPending(null);
    }
  };

  const remove = async (id: string) => {
    try {
      setList(await api.ads.chatDelete(id));
      if (id === chatId) setChatId(null);
    } catch (e: any) { toast(e.message, 'error'); }
  };

  const empty = !turns.length && !pending && !failed;
  return (
    <div className="ad-advisor">
      <aside className="ad-chats">
        <button className="btn primary ad-chats-new" onClick={() => { setChatId(null); setTurns([]); setFailed(''); input.current?.focus(); }}>
          <Icon name="plus" size={14} /> Nový rozhovor
        </button>
        <div className="ad-chats-list">
          {list.length === 0 && <div className="muted small ad-pad">Zatím žádné rozhovory.</div>}
          {list.map(c => (
            <div key={c.id} className={`ad-chats-item ${c.id === chatId ? 'active' : ''}`} onClick={() => setChatId(c.id)}>
              <span className="ad-chats-title">{c.title || 'Rozhovor'}</span>
              <span className="ad-chats-meta">{ago(c.updatedAt)}</span>
              <button className="ad-chats-del" data-tip="Smazat rozhovor (na všech Macích)"
                onClick={e => { e.stopPropagation(); void remove(c.id); }}><Icon name="trash" size={12} /></button>
            </div>
          ))}
        </div>
      </aside>

      <section className="ad-chat">
        <div className="ad-chat-scroll">
          {empty && (
            <div className="ad-chat-intro">
              <div className="ad-chat-hello"><Icon name="sparkles" size={22} /></div>
              <h3>Na co se chceš zeptat?</h3>
              <p className="muted">
                Poradce si sám dohledá čísla — libovolné období, kampaně, produkty, hledané dotazy i objednávky
                {market !== 'all' ? ` (výchozí trh ${MARKET_LABELS[market] ?? market})` : ''}. Když navrhne změnu, uvidíš ji
                pod odpovědí a můžeš ji rovnou použít. <b>Nic se nezmění bez tvého schválení.</b>
              </p>
              <div className="ad-chat-starters">
                {ADVISOR_STARTERS.map(s => (
                  <button key={s.title} className="ad-starter" onClick={() => void send(s.q)}>
                    <b>{s.title}</b><span>{s.q}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {turns.map((t, i) => (
            t.role === 'user'
              ? <div key={i} className="ad-msg user"><div className="ad-msg-body">{t.text}</div></div>
              : (
                <div key={i} className="ad-msg assistant">
                  <div className="ad-msg-avatar"><Icon name="sparkles" size={14} /></div>
                  <div className="ad-msg-body">
                    {!!t.steps?.length && (
                      <div className="ad-msg-steps" data-tip="Kam se poradce podíval, než odpověděl">
                        <Icon name="search" size={11} /> {t.steps.join(' · ')}
                      </div>
                    )}
                    <RichText text={t.text} />
                    {!!t.proposals?.length && (
                      <div className="ad-msg-props">
                        <div className="ad-msg-props-head">
                          <b>Návrhy z odpovědi</b>
                          <button className="linkish" onClick={onProposals}>všechny v Návrzích</button>
                        </div>
                        {t.proposals.map(p => (
                          <ChatProposal key={p.id} snap={p} live={liveOpen.get(p.id)} status={status} onChanged={onChanged} />
                        ))}
                      </div>
                    )}
                    {!!t.notes?.length && (
                      <div className="ad-msg-notes">
                        <b>Co jsem nenavrhl</b>
                        <ul>{t.notes.map((n, j) => <li key={j}>{n}</li>)}</ul>
                      </div>
                    )}
                  </div>
                </div>
              )
          ))}
          {pending && (
            <>
              <div className="ad-msg user"><div className="ad-msg-body">{pending.q}</div></div>
              <div className="ad-msg assistant">
                <div className="ad-msg-avatar busy"><Icon name="sparkles" size={14} /></div>
                <div className="ad-msg-body ad-msg-thinking">
                  <span className="ad-dots"><i /><i /><i /></span>
                  {pending.steps.length ? <>Dívám se do: {pending.steps.join(' · ')}</> : 'Přemýšlím…'}
                </div>
              </div>
            </>
          )}
          {failed && !pending && (
            <div className="ad-msg assistant">
              <div className="ad-msg-avatar"><Icon name="alert" size={14} /></div>
              <div className="ad-msg-body">
                Odpověď se nepovedla. <button className="linkish" onClick={() => void send(failed)}>Zkusit znovu</button>
              </div>
            </div>
          )}
          <div ref={end} />
        </div>
        <div className="ad-chat-input">
          <textarea ref={input} value={text} rows={1}
            placeholder={turns.length ? 'Pokračuj v rozhovoru…' : 'Zeptej se na cokoli o reklamě…'}
            onChange={e => setText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(text); } }} />
          <button className="btn primary ad-chat-send" disabled={!!pending || !text.trim()} onClick={() => void send(text)}
            data-tip="Odeslat (Enter) · nový řádek Shift+Enter">
            <Icon name="send" size={15} />
          </button>
        </div>
      </section>
    </div>
  );
}

/* ---------- stavový řádek ---------- */

function StatusLine({ status }: { status: AdsStatus }) {
  const run = status.lastRun;
  return (
    <div className="ad-status">
      <span className={`ad-dot ${status.google.lastError || status.sklik?.lastError || status.meta?.lastError ? 'bad' : run ? 'ok' : ''}`} />
      <span>
        <b>{status.autopilot?.active
          ? 'Autopilot v mezích — malé změny dělá sám v noci, každá jde vrátit.'
          : 'Mění jen to, co schválíš — každá změna jde vrátit.'}</b>{' '}
        {run
          ? <>Noční běh {relTime(run.finishedAt)} ({run.device.replace(/\s*\([^)]*\)$/, '')}){run.error ? ` — chyba: ${run.error}` : ''}</>
          : 'Noční běh zatím neproběhl.'}
      </span>
      <span style={{ flex: 1 }} />
      <span className="ad-status-right">
        Zisk = marže z objednávek + doprava − náklady na dopravu · cíl {pct(status.config.targetProfitShare, 0)} z obratu
      </span>
    </div>
  );
}

/* ---------- Dnes ---------- */

function Today({ overview, status, proposals, onSettings, onProposals, onChanged }: {
  overview: AdsOverview | null; status: AdsStatus | null; proposals: AdsProposals | null;
  onSettings: () => void; onProposals: () => void; onChanged: () => void;
}) {
  if (!overview) return <div className="ad-empty">Načítám…</div>;
  const o = overview;
  const share = o.profitShare;
  const target = status?.config.targetProfitShare ?? 0.5;
  const daysWithAds = o.daily.filter(d => d.cost > 0).length;
  return (
    <div className="ad-today">
      <div className="ad-main">
        <div className="ad-kpis">
          <div className="ad-card ad-kpi hero">
            <div className="ad-h"><Term k="profitAfterAds">Zisk po reklamě</Term> · {o.days} dní</div>
            <div className="ad-v">{kc(o.profitAfterAds.value)}</div>
            <div className="ad-d">
              <Delta now={o.profitAfterAds.value} prev={o.profitAfterAds.prev} />{' '}
              <span className="muted ad-term" data-tip={ADS_TERMS.profitShare}>
                {pct(share, 0)} z obratu · cíl {pct(target, 0)}
              </span>
            </div>
          </div>
          <div className="ad-card ad-kpi">
            <div className="ad-h">Obrat bez DPH</div>
            <div className="ad-v">{num(o.revenue.value)}</div>
            <div className="ad-d"><Delta now={o.revenue.value} prev={o.revenue.prev} /> <span className="muted">{o.orders.value} objednávek</span></div>
          </div>
          <div className="ad-card ad-kpi">
            <div className="ad-h">Náklady na reklamu</div>
            <div className="ad-v">{num(o.cost.value)}</div>
            <div className="ad-d"><Delta now={o.cost.value} prev={o.cost.prev} invert /> <span className="muted">Kč bez DPH</span></div>
          </div>
          <div className="ad-card ad-kpi">
            <div className="ad-h"><Term k="shopPno">PNO e-shopu</Term></div>
            <div className="ad-v">{pct(o.shopPno)}</div>
            <div className="ad-d">
              <span className={`ad-chip ${o.shopPno != null && o.targetPno != null && o.shopPno > o.targetPno ? 'bad' : 'ok'}`}
                data-tip={`${ADS_TERMS.targetPno} Teď: marže objednávek po dopravě ${pct(o.margin, 0)} − cíl ${pct(target, 0)}.`}>
                cíl {pct(o.targetPno, 0)}
              </span>
            </div>
          </div>
        </div>

        <div className="ad-systems">
          {o.systems.map(sys => (
            <div key={sys.system} className={`ad-card ad-sys ${sys.connected ? '' : 'off'}`}>
              <div className="ad-sys-top">
                <span className={`ad-badge ${sys.system}`}>{SYSTEM_SHORT[sys.system]}</span>
                <b>{SYSTEM_LABEL[sys.system]}</b>
                <span style={{ flex: 1 }} />
                {sys.connected
                  ? <span className={`ad-chip ${sys.pno != null && sys.targetPno != null && sys.pno > sys.targetPno ? 'bad' : 'ok'}`}>
                    {sys.pno == null ? 'bez konverzí' : sys.targetPno != null && sys.pno > sys.targetPno ? 'nad cílem' : 'v cíli'}
                  </span>
                  : <span className="ad-chip">{SYSTEM_PHASE[sys.system] ?? 'nepřipojeno'}</span>}
              </div>
              {sys.connected ? (
                <>
                  <div className="ad-row"><span className="muted"><Term k="cost">Útrata</Term></span><b>{kc(sys.cost)}</b></div>
                  <div className="ad-row">
                    <span className="muted ad-term" data-tip="Zisk z nákupů, které si reklama připsala: hodnota konverzí bez DPH × marže trhu − útrata.">Zisk z konverzí</span>
                    <b>{kc(sys.profit)}</b>
                  </div>
                  <div className="ad-row"><span className="muted"><Term k="pno">PNO</Term> / <Term k="targetPno">cíl</Term></span><b>{pct(sys.pno)} / {pct(sys.targetPno, 0)}</b></div>
                  <Spark daily={sys.daily} />
                </>
              ) : (
                <div className="ad-sys-off">
                  {sys.system === 'google'
                    ? <button className="linkish" onClick={onSettings}>Připojit v Nastavení</button>
                    : 'Začínáme Google Ads — v něm je nejvíc peněz a nejlepší API.'}
                </div>
              )}
            </div>
          ))}
        </div>

        {o.markets.length > 1 && (
          <div className="ad-card ad-table-wrap">
            <table className="ad-table">
              <thead>
                <tr>
                  <th>Trh</th><th className="r">Obrat bez DPH</th><th className="r">Náklady na reklamu</th>
                  <th className="r"><Term k="profitAfterAds">Zisk po reklamě</Term></th>
                  <th className="r"><Term k="pno">PNO</Term> / cíl</th>
                </tr>
              </thead>
              <tbody>
                {o.markets.map(m => (
                  <tr key={m.market}>
                    <td><span className="ad-market">{MARKET_LABELS[m.market] ?? m.market}</span></td>
                    <td className="r">{kc(m.revenue)}</td>
                    <td className="r">{kc(m.cost)}</td>
                    <td className={`r ${m.profitAfterAds < 0 ? 'neg' : ''}`}><b>{kc(m.profitAfterAds)}</b></td>
                    <td className={`r ${m.pno != null && m.targetPno != null && m.pno > m.targetPno ? 'neg' : ''}`}>
                      {pct(m.pno)} / {pct(m.targetPno, 0)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="ad-card ad-chart">
          <div className="ad-chart-head">
            <b>Den po dni</b>
            <span className="ad-legend"><i className="p" /> zisk z objednávek <i className="c" /> náklady na reklamu</span>
          </div>
          <DailyChart days={o.daily} />
        </div>
      </div>

      <div className="ad-side">
        {proposals && proposals.open.length > 0 && status && (
          <>
            <div className="ad-side-head">
              <b>Čeká na tebe</b><span style={{ flex: 1 }} /><span className="muted small">seřazeno podle zisku</span>
            </div>
            {proposals.open.slice(0, 3).map(p => (
              <ProposalCard key={p.id} p={p} status={status} compact onChanged={onChanged} />
            ))}
            {proposals.open.length > 3 && (
              <button className="linkish ad-more-link" onClick={onProposals}>Všechny návrhy ({proposals.open.length})</button>
            )}
          </>
        )}
        <div className="ad-side-head"><b>Co je potřeba vědět</b></div>
        {o.alerts.length === 0 && <div className="ad-card ad-alert ok">Data sedí a nic nehoří.</div>}
        {o.alerts.map((one, i) => (
          <div key={i} className={`ad-card ad-alert ${one.level}`}>
            <b>{one.title}</b>
            <div>{one.text}</div>
          </div>
        ))}
        {(proposals?.dataDays ?? daysWithAds) < 14 ? (
          <div className="ad-card ad-gate">
            <b>Než přijdou návrhy změn</b>
            <div className="muted">
              Návrhy se začnou počítat, až bude aspoň <b>14 dní</b> dat z Google Ads spárovaných s objednávkami.
              První stažení vezme 90 dní zpětně, takže to bývá hned.
            </div>
            <div className="ad-bar"><i style={{ width: `${Math.min(100, ((proposals?.dataDays ?? daysWithAds) / 14) * 100)}%` }} /></div>
            <div className="muted small">{Math.min(proposals?.dataDays ?? daysWithAds, 14)} ze 14 dní</div>
          </div>
        ) : (
          <TrackCard proposals={proposals} />
        )}
        {o.estimatedOrders > 0 && (
          <div className="muted small ad-note">
            U {o.estimatedOrders} objednávek chyběla nákupní cena některé položky — marže je u nich odhadnutá podle kategorie.
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- Kampaně ---------- */

const TYPE_LABEL: Record<string, string> = {
  PERFORMANCE_MAX: 'Performance Max', SHOPPING: 'Nákupy', SEARCH: 'Vyhledávání', DISPLAY: 'Obsahová síť',
  VIDEO: 'Video', DEMAND_GEN: 'Demand Gen', SMART: 'Chytrá', LOCAL: 'Místní',
  // Meta podle cíle kampaně
  SALES: 'Prodeje', TRAFFIC: 'Návštěvnost', AWARENESS: 'Povědomí', ENGAGEMENT: 'Interakce', LEADS: 'Potenciální zákazníci'
};
const BIDDING_LABEL: Record<string, string> = {
  MAXIMIZE_CONVERSION_VALUE: 'max. hodnota', TARGET_ROAS: 'cílové ROAS', MAXIMIZE_CONVERSIONS: 'max. konverze',
  TARGET_CPA: 'cílová CPA', MANUAL_CPC: 'ruční CPC', TARGET_SPEND: 'max. kliky', MAXIMIZE_CLICKS: 'max. kliky',
  // Meta
  LOWEST_COST_WITHOUT_CAP: 'nejnižší cena', LOWEST_COST_WITH_BID_CAP: 'strop nabídky', COST_CAP: 'strop ceny',
  LOWEST_COST_WITH_MIN_ROAS: 'min. ROAS'
};

const TYPE_TERM: Record<string, string> = { PERFORMANCE_MAX: 'pmax', SHOPPING: 'shopping', SEARCH: 'search' };

const campaignValue = (row: AdsCampaignRow, key: string): number | string | null => {
  switch (key) {
    case 'name': return row.name;
    case 'market': return row.market;
    case 'type': return TYPE_LABEL[row.type] ?? row.type;
    case 'budget': return row.budget;
    case 'cost': return row.cost;
    case 'conversions': return row.conversions;
    case 'value': return row.value;
    case 'profit': return row.profit;
    case 'pno': return row.pno;
    default: return null;
  }
};

/**
 * Nad tabulkou kampaní: návrh vlastní kampaně Nákupy pro hvězdy trhu.
 * Nic nezakládá hned — vznikne návrh, a teprve Použít kampaň vytvoří
 * (pozastavenou).
 */
function NewCampaignBar({ market, status, onChanged, onProposals }: {
  market: string; status: AdsStatus; onChanged: () => void; onProposals: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const googleMarkets = [...new Set(status.config.google.accounts.filter(a => a.enabled).map(a => a.market))];
  const [pick, setPick] = useState(market !== 'all' ? market : googleMarkets[0] ?? 'cz');
  useEffect(() => { if (market !== 'all') setPick(market); }, [market]);
  if (!status.google.connected || !googleMarkets.length) return null;
  return (
    <div className="ad-card ad-newcamp">
      <div>
        <b>Vlastní kampaň pro hvězdy</b>
        <div className="muted small">Produkty, které vydělávají a mají dost prodejů, dostanou vlastní rozpočet a cíl podle své marže.
          Vznikne návrh; po Použít se kampaň založí pozastavená.</div>
      </div>
      {market === 'all' && googleMarkets.length > 1 && (
        <select className="ad-period" value={pick} onChange={e => setPick(e.target.value)}>
          {googleMarkets.map(m => <option key={m} value={m}>{MARKET_LABELS[m] ?? m}</option>)}
        </select>
      )}
      <button className="btn small" disabled={busy} onClick={async () => {
        setBusy(true);
        try {
          await api.ads.newCampaign(pick);
          toast('Návrh nové kampaně je v Návrzích', 'info');
          onChanged();
          onProposals();
        } catch (e: any) { toast(e.message, 'error'); } finally { setBusy(false); }
      }}>Navrhnout kampaň</button>
    </div>
  );
}

function Campaigns({ rows }: { rows: AdsCampaignRow[] | null }) {
  const { sorted, sort, toggle } = useSort(rows ?? [], { key: 'cost', dir: 'desc' }, campaignValue);
  if (!rows) return <div className="ad-empty">Načítám…</div>;
  if (!rows.length) return <div className="ad-empty">Zatím žádné kampaně. Připoj Google Ads v Nastavení a načti data.</div>;
  const manyMarkets = new Set(rows.map(r => r.market)).size > 1;
  return (
    <div className="ad-card ad-table-wrap">
      <table className="ad-table">
        <thead>
          <tr>
            <SortTh k="name" sort={sort} onSort={toggle} firstDir="asc">Kampaň</SortTh>
            {manyMarkets && <SortTh k="market" sort={sort} onSort={toggle} firstDir="asc" tip={ADS_TERMS.market}>Trh</SortTh>}
            <SortTh k="type" sort={sort} onSort={toggle} firstDir="asc">Typ</SortTh>
            <SortTh k="budget" sort={sort} onSort={toggle} right tip={ADS_TERMS.budget}>Rozpočet/den</SortTh>
            <SortTh k="cost" sort={sort} onSort={toggle} right tip={ADS_TERMS.cost}>Útrata</SortTh>
            <SortTh k="conversions" sort={sort} onSort={toggle} right tip={ADS_TERMS.conversions}>Konverze</SortTh>
            <SortTh k="value" sort={sort} onSort={toggle} right tip={ADS_TERMS.value}>Hodnota</SortTh>
            <SortTh k="profit" sort={sort} onSort={toggle} right tip="Hodnota konverzí × marže trhu − útrata. Kolik kampaň vydělala po zaplacení reklamy.">Zisk</SortTh>
            <SortTh k="pno" sort={sort} onSort={toggle} right tip={`${ADS_TERMS.pno} Cíl: ${ADS_TERMS.targetPno}`}>PNO / cíl</SortTh>
            <th className="ad-term" data-tip={ADS_TERMS.bidding}>Nabízení</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map(row => {
            const over = row.pno != null && row.targetPno != null && row.pno > row.targetPno;
            return (
              <tr key={`${row.system}-${row.id}`} className={row.status !== 'ENABLED' ? 'paused' : ''}>
                <td>
                  <div className="ad-name">
                    <span className={`ad-badge ${row.system}`}>{SYSTEM_SHORT[row.system]}</span>
                    <span className="ad-ptitle">{row.name}</span>
                    {row.status !== 'ENABLED' && <span className="ad-chip">pozastavená</span>}
                  </div>
                </td>
                {manyMarkets && <td><span className="ad-market">{MARKET_LABELS[row.market] ?? row.market}</span></td>}
                <td>{TYPE_TERM[row.type]
                  ? <Term k={TYPE_TERM[row.type]}>{TYPE_LABEL[row.type]}</Term>
                  : (TYPE_LABEL[row.type] ?? row.type)}</td>
                <td className="r">{row.budget != null ? kc(row.budget) : '—'}</td>
                <td className="r">{kc(row.cost)}</td>
                <td className="r">{row.conversions.toLocaleString('cs-CZ', { maximumFractionDigits: 1 })}</td>
                <td className="r">{kc(row.value)}</td>
                <td className={`r ${row.profit < 0 ? 'neg' : ''}`}><b>{kc(row.profit)}</b></td>
                <td className={`r ${over ? 'neg' : ''}`}
                  data-tip={row.pno == null ? 'Bez konverzí se PNO spočítat nedá.' : over
                    ? `Za každých 100 Kč tržby jde na reklamu ${Math.round(row.pno * 100)} Kč — víc, než dovoluje cíl ${Math.round((row.targetPno ?? 0) * 100)} Kč.`
                    : `Za každých 100 Kč tržby jde na reklamu ${Math.round(row.pno * 100)} Kč — v cíli.`}>
                  {pct(row.pno)} / {pct(row.targetPno, 0)}
                </td>
                <td className="muted">
                  {BIDDING_LABEL[row.bidding] ?? row.bidding}
                  {row.targetRoas ? <> <Term k="troas">{Math.round(row.targetRoas * 100)} %</Term></> : ''}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ---------- Produkty ---------- */

function ProductMap({ rows, active, onPick }: {
  rows: AdsProductRow[]; active: AdsSegment | null; onPick: (code: string) => void;
}) {
  const withAds = rows.filter(r => r.cost > 0);
  if (!withAds.length) {
    return <div className="ad-map-empty">Mapa se ukáže, až budou produkty v reklamách utrácet — zatím žádná data po produktech.</div>;
  }
  // Útrata na logaritmické ose: pár produktů utratí stokrát víc než zbytek
  const maxCost = Math.max(...withAds.map(r => r.cost));
  const lx = (cost: number) => Math.log10(1 + cost) / Math.log10(1 + maxCost);
  /*
   * Zisk taky na logaritmické ose (se znaménkem): jedna hvězda se ziskem
   * deset tisíc by jinak všechny ostatní slisovala do čáry u nuly a žrouti
   * s pár stovkami ztráty by nebyli vidět vůbec.
   */
  const slog = (v: number) => Math.sign(v) * Math.log10(1 + Math.abs(v));
  const maxProfit = Math.max(1, ...withAds.map(r => Math.abs(slog(r.profit))));
  const maxValue = Math.max(1, ...withAds.map(r => r.value));
  const costs = withAds.map(r => r.cost).sort((a, b) => a - b);
  const median = costs[Math.floor(costs.length / 2)];
  const X = (cost: number) => 40 + lx(cost) * 470;
  const Y = (profit: number) => 205 - (slog(profit) / maxProfit) * 182;
  return (
    <svg className="ad-map" viewBox="0 0 520 440" role="img" aria-label="Produkty podle útraty a zisku">
      <rect x="40" y="15" width={X(median) - 40} height="190" className="q work" />
      <rect x={X(median)} y="15" width={510 - X(median)} height="190" className="q star" />
      <rect x="40" y="205" width={X(median) - 40} height="190" className="q sleep" />
      <rect x={X(median)} y="205" width={510 - X(median)} height="190" className="q eat" />
      <line x1="40" x2="510" y1="205" y2="205" className="zero" />
      <text x="50" y="34" className="ql work">Pracanti</text>
      <text x="500" y="34" className="ql star" textAnchor="end">Hvězdy</text>
      <text x="50" y="385" className="ql sleep">Málo utrácí</text>
      <text x="500" y="385" className="ql eat" textAnchor="end">Žrouti</text>
      <text x="46" y="200" className="ax">bod zlomu (zisk 0)</text>
      <text x="275" y="420" className="ax" textAnchor="middle">útrata za reklamu →</text>
      <text x="16" y="205" className="ax" textAnchor="middle" transform="rotate(-90 16 205)">zisk po reklamě →</text>
      {withAds.map(r => (
        <circle key={r.code} cx={X(r.cost)} cy={Y(r.profit)} r={3 + Math.sqrt(r.value / maxValue) * 11}
          className={`dot ${r.segment} ${active && active !== r.segment ? 'dim' : ''}`}
          onClick={() => onPick(r.code)}>
          <title>{`${r.title}\n${SEGMENT_LABELS[r.segment]} — útrata ${kc(r.cost)}, zisk ${kc(r.profit)}`}</title>
        </circle>
      ))}
    </svg>
  );
}

const productValue = (r: AdsProductRow, key: string): number | string | null => {
  switch (key) {
    case 'title': return r.title || r.code;
    case 'segment': return SEGMENT_ORDER.indexOf(r.segment);
    case 'margin': return r.margin;
    case 'cost': return r.cost;
    case 'profit': return r.cost || r.value ? r.profit : null;
    case 'pno': return r.pno;
    case 'sold': return r.sold;
    case 'stock': return r.stock;
    default: return null;
  }
};

type Extra = 'all' | 'ads' | 'noads' | 'loss' | 'noprice' | 'instock';

const EXTRA_LABELS: Record<Extra, string> = {
  all: 'Vše', ads: 'Jen s útratou', noads: 'Bez reklamy', loss: 'Prodělávají (PNO nad zlomem)',
  noprice: 'Bez nákupní ceny', instock: 'Jen skladem'
};

function Products({ data }: { data: AdsProducts | null }) {
  const [segment, setSegment] = useState<AdsSegment | null>(null);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const [limit, setLimit] = useState(100);
  const [category, setCategory] = useState('');
  const [extra, setExtra] = useState<Extra>('all');
  const [maxMargin, setMaxMargin] = useState('');

  const categories = useMemo(() => [...new Set((data?.rows ?? []).map(r => r.category).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'cs')), [data]);

  const rows = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    const mm = maxMargin.trim() ? Number(maxMargin) / 100 : null;
    return data.rows.filter(r => (!segment || r.segment === segment)
      && (!q || r.title.toLowerCase().includes(q) || r.code.toLowerCase().includes(q))
      && (!picked || r.code === picked)
      && (!category || r.category === category)
      && (mm == null || (r.margin != null && r.margin <= mm))
      && (extra === 'all'
        || (extra === 'ads' && r.cost > 0)
        || (extra === 'noads' && r.cost === 0)
        || (extra === 'loss' && r.pno != null && r.breakEven != null && r.pno > r.breakEven)
        || (extra === 'noprice' && r.marginEstimated)
        || (extra === 'instock' && (r.stock ?? 0) > 0)));
  }, [data, segment, query, picked, category, extra, maxMargin]);
  const { sorted, sort, toggle } = useSort(rows, { key: 'cost', dir: 'desc' }, productValue);
  const filtered = !!(segment || query || picked || category || extra !== 'all' || maxMargin);

  if (!data) return <div className="ad-empty">Načítám…</div>;
  return (
    <div className="ad-products">
      <div className="ad-card ad-map-card">
        <div className="ad-chart-head">
          <b>Mapa produktů</b>
          <span className="muted small ad-term" data-tip={`Každá tečka je produkt, který v reklamách utrácí. Vodorovně: kolik utratil. Svisle: kolik vydělal po zaplacení reklamy (pod čárkovanou čárou prodělává). Velikost tečky = tržba z reklamy. Klik na tečku ukáže produkt v tabulce.`}>
            jak ji číst?
          </span>
        </div>
        <ProductMap rows={data.rows} active={segment} onPick={code => { setPicked(code); setSegment(null); }} />
        <div className="ad-seglist">
          {SEGMENT_ORDER.map(one => (
            <button key={one} className={`ad-seg ${one} ${segment === one ? 'on' : ''}`} data-tip={SEGMENT_HELP[one]}
              onClick={() => { setSegment(segment === one ? null : one); setPicked(null); }}>
              {SEGMENT_LABELS[one]} <b>{data.counts[one]}</b>
            </button>
          ))}
        </div>
        <div className="muted small ad-note">Najeď myší na štítek segmentu — vysvětlí, co znamená. Kliknutím se tabulka vyfiltruje.</div>
        {data.unmatched.length > 0 && (
          <div className="muted small ad-note">
            {data.unmatched.length} ID z reklam se nespárovalo s katalogem (např. {data.unmatched.slice(0, 3).map(u => u.itemId).join(', ')}).
            Bývají to produkty smazané z e-shopu.
          </div>
        )}
      </div>
      <div className="ad-prod-list">
        <div className="ad-filters">
          <input placeholder="Hledat produkt nebo kód" value={query}
            onChange={e => { setQuery(e.target.value); setPicked(null); }} />
          <select value={segment ?? ''} onChange={e => { setSegment((e.target.value || null) as AdsSegment | null); setPicked(null); }}>
            <option value="">Segment: všechny</option>
            {SEGMENT_ORDER.map(one => <option key={one} value={one}>{SEGMENT_LABELS[one]}</option>)}
          </select>
          <select value={category} onChange={e => setCategory(e.target.value)}>
            <option value="">Kategorie: všechny</option>
            {categories.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <select value={extra} onChange={e => setExtra(e.target.value as Extra)}>
            {(Object.keys(EXTRA_LABELS) as Extra[]).map(k => <option key={k} value={k}>{k === 'all' ? 'Zobrazit: vše' : EXTRA_LABELS[k]}</option>)}
          </select>
          <label className="ad-inline small" data-tip="Jen produkty s marží nejvýš tolik procent — levné zboží, které reklama snadno převálcuje">
            marže do <input type="number" min={0} max={100} value={maxMargin} onChange={e => setMaxMargin(e.target.value)} placeholder="—" /> %
          </label>
          {filtered && (
            <button className="btn ghost small" onClick={() => {
              setSegment(null); setQuery(''); setPicked(null); setCategory(''); setExtra('all'); setMaxMargin('');
            }}>Zrušit filtry</button>
          )}
          <span style={{ flex: 1 }} />
          <span className="muted small">{rows.length} produktů</span>
        </div>
        <div className="ad-card ad-table-wrap">
          <table className="ad-table ad-ptable">
            <thead>
              <tr>
                <SortTh k="title" sort={sort} onSort={toggle} firstDir="asc">Produkt</SortTh>
                <SortTh k="segment" sort={sort} onSort={toggle} firstDir="asc" tip="Segment — najeď na štítek v řádku, vysvětlí se">Segment</SortTh>
                <SortTh k="margin" sort={sort} onSort={toggle} right tip={ADS_TERMS.margin}>Marže</SortTh>
                <SortTh k="cost" sort={sort} onSort={toggle} right tip={ADS_TERMS.cost}>Útrata</SortTh>
                <SortTh k="profit" sort={sort} onSort={toggle} right tip="Zisk po reklamě: tržba z reklamy × marže − útrata">Zisk</SortTh>
                <SortTh k="pno" sort={sort} onSort={toggle} right tip={`PNO produktu / bod zlomu. ${ADS_TERMS.breakEven}`}>PNO / zlom</SortTh>
                <SortTh k="sold" sort={sort} onSort={toggle} right tip={ADS_TERMS.sold}>Prodáno</SortTh>
                <SortTh k="stock" sort={sort} onSort={toggle} right>Sklad</SortTh>
              </tr>
            </thead>
            <tbody>
              {sorted.slice(0, limit).map(r => (
                <tr key={r.code}>
                  <td>
                    <div className="ad-name">
                      {r.image ? <img src={r.image} alt="" loading="lazy" /> : <span className="ad-thumb" />}
                      <span className="ad-ptitle" data-tip={`${r.title} (${r.code})`}>{r.title || r.code}</span>
                    </div>
                  </td>
                  <td><span className={`ad-seg ${r.segment} small`} data-tip={`${SEGMENT_HELP[r.segment]}${r.why ? ` Tenhle produkt: ${r.why}` : ''}`}>{SEGMENT_LABELS[r.segment]}</span></td>
                  <td className="r" data-tip={r.marginEstimated ? 'Nákupní cena chybí — odhad podle kategorie' : undefined}>
                    {pct(r.margin, 0)}{r.marginEstimated ? '*' : ''}
                  </td>
                  <td className="r">{r.cost ? kc(r.cost) : '—'}</td>
                  <td className={`r ${r.profit < 0 ? 'neg' : ''}`}>{r.cost || r.value ? <b>{kc(r.profit)}</b> : '—'}</td>
                  <td className={`r ${r.pno != null && r.breakEven != null && r.pno > r.breakEven ? 'neg' : ''}`}
                    data-tip={r.pno != null && r.breakEven != null
                      ? (r.pno > r.breakEven
                        ? `Reklama spolkne ${Math.round(r.pno * 100)} Kč ze 100 Kč tržby, ale na kuse vyděláme jen ${Math.round(r.breakEven * 100)} Kč — prodělává.`
                        : `Reklama spolkne ${Math.round(r.pno * 100)} Kč ze 100 Kč tržby, na kuse vyděláme ${Math.round(r.breakEven * 100)} Kč — vydělává.`)
                      : undefined}>
                    {pct(r.pno, 0)} / {pct(r.breakEven, 0)}
                  </td>
                  <td className="r">{r.sold || '—'}</td>
                  <td className="r">{r.stock ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {sorted.length > limit && (
            <button className="btn ghost ad-more" onClick={() => setLimit(limit + 200)}>Ukázat další ({sorted.length - limit})</button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------- Návrhy ---------- */

const KIND_LABEL: Record<string, string> = {
  'budget-up': 'Rozpočet', 'budget-down': 'Rozpočet', 'roas-up': 'Cílové ROAS', 'roas-down': 'Cílové ROAS',
  'roas-set': 'Cílové ROAS', negatives: 'Vylučující slova', exclude: 'Produkty', 'campaign-new': 'Nová kampaň',
  'campaign-pause': 'Pozastavit', 'campaign-enable': 'Zapnout'
};

function Confidence({ n }: { n: number }) {
  const label = ['', 'málo dat', 'dost dat', 'hodně dat', 'velmi spolehlivé'][n] ?? '';
  return (
    <span className="ad-conf" data-tip={`Jistota: ${label}. ${ADS_TERMS.confidence}`}>
      {[1, 2, 3, 4].map(i => <i key={i} className={i <= n ? 'on' : ''} />)}
    </span>
  );
}

/** Úspěšnost dřívějších návrhů — podle ní se jednou zapne autopilot */
function TrackCard({ proposals }: { proposals: AdsProposals | null }) {
  const t = proposals?.track;
  return (
    <div className="ad-card ad-gate">
      <b>Jak vycházejí návrhy</b>
      {t && t.evaluated > 0 ? (
        <>
          <div className="muted">
            Z {t.evaluated} vyhodnocených změn vyšlo <b>{t.better}</b> (zisk kampaně 14 dní po změně neklesl).
            Autopilot v mezích se nabídne, až to bude aspoň 70 % po 4 týdnech.
          </div>
          <div className="ad-bar"><i style={{ width: `${Math.round((t.better / t.evaluated) * 100)}%` }} /></div>
        </>
      ) : (
        <div className="muted">Každá provedená změna se po 14 dnech vyhodnotí. Zatím žádná vyhodnocená není.</div>
      )}
    </div>
  );
}

/** Umí tenhle Mac operace zapsat (Google přihlášený, Sklik s tokenem)? Feed zvládne každý. */
function canWriteHere(ops: AdsProposal['ops'], status: AdsStatus): boolean {
  const api = ops.filter(op => op.kind !== 'exclude' && op.kind !== 'exclude-remove');
  const acc = (op: AdsProposal['ops'][number]) => ('account' in op ? op.account ?? '' : '');
  const sklik = api.some(op => acc(op) === 'sklik');
  const meta = api.some(op => acc(op) === 'meta');
  const google = api.some(op => acc(op) !== 'sklik' && acc(op) !== 'meta');
  return (!sklik || (!!status.sklik?.hasToken && status.config.sklik.enabled))
    && (!meta || (!!status.meta?.hasToken && status.config.meta.enabled))
    && (!google || status.google.connected);
}

const fromAdvisor = (p: AdsProposal) => /\|(chat|plan)\|/.test(p.fingerprint);

/** Co se přesně změní — řádek po operaci */
function OpsList({ p }: { p: AdsProposal }) {
  return (
    <ul className="ad-ops">
      {p.ops.map((op, i) => {
        switch (op.kind) {
          case 'budget':
            return <li key={i}>Denní rozpočet <b>{kc(op.from)}</b> → <b>{kc(op.to)}</b></li>;
          case 'troas':
            return <li key={i}>Cílové ROAS <b>{op.from == null ? 'bez cíle' : `${Math.round(op.from * 100)} %`}</b> → <b>{op.to ? `${Math.round(op.to * 100)} %` : 'bez cíle'}</b></li>;
          case 'negative':
            return <li key={i}>Vyloučit „<b>{op.text}</b>" (frázová shoda) <span className="muted">· {op.clicks} kliků, {kc(op.cost)}</span></li>;
          case 'exclude':
            return <li key={i}>Vyřadit {op.codes.length} produktů na {op.days} dní: <span className="muted">{op.codes.slice(0, 8).join(', ')}{op.codes.length > 8 ? '…' : ''}</span></li>;
          case 'campaign-create':
            return (
              <React.Fragment key={i}>
                <li>Založit <b>pozastavenou</b> kampaň Nákupy „<b>{op.name}</b>"</li>
                <li>Denní rozpočet <b>{kc(op.budget)}</b>, cílové ROAS <b>{Math.round(op.troas * 100)} %</b></li>
                <li>Produkty: custom_label_0 = <b>{op.segment}</b>, ostatní vyloučené
                  <span className="muted"> · Merchant Center {op.merchantId}{op.feedLabel ? `, feed ${op.feedLabel}` : ''}</span></li>
              </React.Fragment>
            );
          case 'status':
            return <li key={i}>Kampaň <b>{op.to === 'PAUSED' ? 'pozastavit' : 'zapnout'}</b> <span className="muted">(teď {op.from === 'PAUSED' ? 'stojí' : 'běží'})</span></li>;
          case 'campaign-remove':
            return <li key={i}>Odstranit kampaň „<b>{op.name}</b>" i s jejím rozpočtem</li>;
          default:
            return null;
        }
      })}
    </ul>
  );
}

function ProposalCard({ p, status, compact = false, onChanged }: {
  p: AdsProposal; status: AdsStatus; compact?: boolean; onChanged: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(!compact);
  const [detail, setDetail] = useState(false);
  const viaOther = !canWriteHere(p.ops, status);
  const act = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try { await fn(); toast(done, 'info'); onChanged(); } catch (e: any) { toast(e.message, 'error'); onChanged(); } finally { setBusy(false); }
  };
  return (
    <div className={`ad-card ad-prop ${p.status}`}>
      <div className="ad-prop-top">
        <span className="ad-chip">{KIND_LABEL[p.kind] ?? p.kind}</span>
        {p.market && status.config.markets.length > 1 && (
          <span className="ad-market" data-tip={ADS_TERMS.market}>{MARKET_LABELS[p.market] ?? p.market}</span>
        )}
        {p.system === 'sklik' && <span className="ad-badge sklik" data-tip="Sklik">S</span>}
        {p.kind === 'campaign-new' ? (
          <span className="ad-chip info" data-tip="Nová kampaň — odhad v korunách se ukáže až z jejích vlastních dat. Vzniká pozastavená.">
            vznikne pozastavená
          </span>
        ) : fromAdvisor(p) ? (
          <span className="ad-chip info" data-tip={p.fingerprint.includes('|plan|')
            ? 'Krok sezónního plánu (záložka Sezóny) — odhad v korunách u něj není, prošel ale stejnými pojistkami jako ostatní návrhy.'
            : 'Navrhl poradce na tvou otázku — odhad v korunách u něj není, prošel ale stejnými pojistkami jako ostatní návrhy.'}>
            {p.fingerprint.includes('|plan|') ? 'sezónní plán' : 'z poradce'}
          </span>
        ) : (
          <>
            <span className={`ad-chip ${p.impact >= 0 ? 'ok' : 'warn'}`}
              data-tip={p.impact < 0 ? `${ADS_TERMS.impact} ${ADS_TERMS.holdsTarget}` : ADS_TERMS.impact}>
              {p.impact >= 0 ? '+' : '−'}{kc(Math.abs(p.impact))} / 30 dní{p.impact < 0 ? ' · drží cíl' : ''}
            </span>
            <Confidence n={p.confidence} />
          </>
        )}
      </div>
      <div className="ad-prop-title">{p.title}</div>
      {open && p.plain && <div className="ad-prop-plain">{p.plain}</div>}
      {open && (!p.plain || detail) && (
        <>
          <div className="ad-prop-why"><b>Čísla:</b> {p.why}</div>
          <OpsList p={p} />
        </>
      )}
      {open && p.plain && !detail && (
        <button className="linkish ad-prop-more" onClick={() => setDetail(true)}>Podrobně — čísla a přesné změny</button>
      )}
      {p.error && <div className="ad-prop-err">{p.error}</div>}
      <div className="ad-prop-btns">
        <button className="btn primary small" disabled={busy}
          data-tip={viaOther ? 'Tenhle Mac nemá přístup do účtu — změnu provede Mac, který ho má, do deseti minut' : 'Provede změnu v účtu. Jde vrátit v Historii změn.'}
          onClick={() => act(() => api.ads.apply(p.id), viaOther ? 'Schváleno — provede to Mac s přístupem do účtu' : 'Změna je v účtu')}>
          {viaOther ? 'Schválit' : 'Použít'}
        </button>
        {compact && !open && <button className="btn ghost small" onClick={() => setOpen(true)}>Proč</button>}
        <button className="btn ghost small" disabled={busy} data-tip="Schovat na týden, pak se nabídne znovu"
          onClick={() => act(() => api.ads.decide(p.id, 'snooze'), 'Odloženo na týden')}>Odložit</button>
        {!compact && (
          <>
            <button className="btn ghost small" disabled={busy} data-tip="Nechci teď — dva týdny se nenabídne"
              onClick={() => act(() => api.ads.decide(p.id, 'dismiss'), 'Zamítnuto — dva týdny se nenabídne')}>Zamítnout</button>
            <button className="btn ghost small" disabled={busy}
              data-tip="Tenhle druh návrhu pro tuhle kampaň už nikdy nenabízet (jde vrátit v Rozhodnutých návrzích)"
              onClick={() => act(() => api.ads.decide(p.id, 'never'), 'Tohle už se navrhovat nebude')}>Nenavrhovat</button>
          </>
        )}
      </div>
    </div>
  );
}

const VERDICT: Record<string, { label: string; cls: string }> = {
  better: { label: 'vyšlo', cls: 'ok' }, same: { label: 'beze změny', cls: '' },
  worse: { label: 'nevyšlo', cls: 'bad' }, pending: { label: 'vyhodnotí se po 14 dnech', cls: '' }
};

function ChangeRow({ c, status, onChanged }: { c: AdsChange; status: AdsStatus; onChanged: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const ev = c.evaluation;
  const canRevert = !c.revertOf && !c.revertedAt && canWriteHere(c.undo, status);
  return (
    <div className={`ad-change ${c.revertedAt ? 'reverted' : ''}`}>
      <div className="ad-change-main">
        <div className="ad-change-title">{c.title}</div>
        <div className="muted small">
          {new Date(c.at).toLocaleString('cs-CZ')} · {c.device.replace(/\s*\([^)]*\)$/, '')}
          {c.revertedAt ? ` · vráceno ${new Date(c.revertedAt).toLocaleDateString('cs-CZ')}` : ''}
        </div>
        {ev && !c.revertOf && (
          <div className="small">
            <span className={`ad-chip ${VERDICT[ev.verdict].cls}`}>{VERDICT[ev.verdict].label}</span>{' '}
            {ev.verdict !== 'pending' && <span className="muted">zisk kampaně {kc(ev.before)} → {kc(ev.after)} denně</span>}
          </div>
        )}
      </div>
      {canRevert && (
        <button className="btn ghost small" disabled={busy} onClick={async () => {
          setBusy(true);
          try { await api.ads.revert(c.id); toast('Vráceno', 'info'); } catch (e: any) { toast(e.message, 'error'); }
          finally { setBusy(false); onChanged(); }
        }}>Vrátit</button>
      )}
    </div>
  );
}

function Proposals({ data, status, onChanged, busy, setBusy }: {
  data: AdsProposals | null; status: AdsStatus; onChanged: () => void; busy: string; setBusy: (s: string) => void;
}) {
  const toast = useToast();
  if (!data) return <div className="ad-empty">Načítám…</div>;
  const planned = data.planned ?? [];
  const recompute = async () => {
    setBusy('engine');
    try {
      const fresh = await api.ads.engine();
      toast(fresh ? `${fresh} nových návrhů` : 'Žádné nové návrhy', 'info');
      onChanged();
    } catch (e: any) { toast(e.message, 'error'); } finally { setBusy(''); }
  };
  return (
    <div className="ad-proposals">
      <div className="ad-prop-list">
        <div className="ad-prop-head">
          <b>Návrhy</b>
          <span className="muted small">
            {data.generatedAt ? `spočítané ${relTime(data.generatedAt)}` : 'zatím nespočítané'} · seřazené podle dopadu na zisk
          </span>
          <span style={{ flex: 1 }} />
          <button className="btn ghost small" onClick={recompute} disabled={!!busy}
            data-tip="Přepočítá návrhy z dat, která už aplikace má. Nová data přinese Načíst data.">
            <Icon name="refresh" size={13} className={busy === 'engine' ? 'spinning' : undefined} /> Přepočítat návrhy
          </button>
        </div>
        {data.dataDays < 14 && (
          <div className="ad-card ad-alert info">
            <b>Málo dat</b>
            <div>Návrhy chtějí aspoň 14 dní dat z Google Ads (teď {data.dataDays}). Načti data v hlavičce okna.</div>
          </div>
        )}
        {data.dataDays >= 14 && data.open.length === 0 && (
          <div className="ad-card ad-alert ok">Teď není co měnit — kampaně jsou v mezích cíle.</div>
        )}
        {data.open.map(p => <ProposalCard key={p.id} p={p} status={status} onChanged={onChanged} />)}
        {data.waiting.length > 0 && (
          <>
            <div className="ad-prop-head"><b>Schválené, čekají na přihlášený Mac</b></div>
            {data.waiting.map(p => (
              <div key={p.id} className="ad-card ad-prop approved">
                <div className="ad-prop-title">{p.title}</div>
                <div className="muted small">Schválil {p.decidedBy.replace(/\s*\([^)]*\)$/, '')} · provede se do deseti minut na Macu s přístupem do účtu.</div>
              </div>
            ))}
          </>
        )}
        {planned.length > 0 && (
          <>
            <div className="ad-prop-head"><b>Naplánované kroky</b><span className="muted small">z poradce a sezónních plánů — k použití se nabídnou v daný den</span></div>
            {planned.map(p => (
              <div key={p.id} className="ad-card ad-prop planned">
                <div className="ad-prop-top">
                  <span className="ad-chip info">{new Date(p.snoozeUntil).toLocaleDateString('cs-CZ')}</span>
                  {p.system === 'sklik' && <span className="ad-badge sklik">S</span>}
                </div>
                <div className="ad-prop-title">{p.title}</div>
                {p.plain && <div className="ad-prop-plain">{p.plain}</div>}
                <div className="ad-prop-btns">
                  <button className="btn ghost small" onClick={async () => { await api.ads.decide(p.id, 'dismiss').catch(() => {}); onChanged(); }}>Zrušit krok</button>
                </div>
              </div>
            ))}
          </>
        )}
      </div>
      <div className="ad-history">
        <div className="ad-prop-head"><b>Historie změn</b></div>
        <div className="ad-card ad-history-list">
          {data.changes.length === 0 && <div className="muted small ad-pad">Zatím se v účtu nic neměnilo.</div>}
          {data.changes.map(c => <ChangeRow key={c.id} c={c} status={status} onChanged={onChanged} />)}
        </div>
        {data.excluded.length > 0 && (
          <>
            <div className="ad-prop-head"><b>Vyřazené produkty</b><span className="muted small">custom_label_2 = vyradit</span></div>
            <div className="ad-card ad-pad small">
              {data.excluded.slice(0, 30).map(e => (
                <span key={e.code} className="ad-chip" data-tip={`Vrátí se ${new Date(e.until).toLocaleDateString('cs-CZ')}`}>{e.code}</span>
              ))}
            </div>
          </>
        )}
        {data.decided.length > 0 && (
          <>
            <div className="ad-prop-head"><b>Rozhodnuté návrhy</b></div>
            <div className="ad-card ad-history-list">
              {data.decided.slice(0, 15).map(p => (
                <div key={p.id} className="ad-change">
                  <div className="ad-change-main">
                    <div className="ad-change-title">{p.title}</div>
                    <div className="muted small">
                      {({ applied: 'provedeno', dismissed: 'zamítnuto', snoozed: 'odloženo', never: 'nenavrhovat', stale: 'zastaralé', failed: 'nepovedlo se', open: 'otevřené', approved: 'schválené' } as Record<string, string>)[p.status]}
                      {p.error ? ` · ${p.error}` : ''}
                    </div>
                  </div>
                  {['dismissed', 'snoozed', 'never'].includes(p.status) && (
                    <button className="btn ghost small" onClick={async () => { await api.ads.decide(p.id, 'reopen').catch(() => {}); onChanged(); }}>Znovu nabídnout</button>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ---------- Nastavení ---------- */

/**
 * Účty Google Ads a jejich trhy.
 *
 * Každý trh má obvykle vlastní účet (český v korunách, slovenský v eurech).
 * Modul stahuje ze všech zapnutých, čísla ukazuje dohromady i zvlášť a do
 * každého účtu zapisuje jen jeho kampaně. Trh účtu rozhoduje, s jakými
 * objednávkami se páruje a jakou DPH se počítá.
 */
function AccountsBlock({ cfg, status, customers, busy, onLoad, onSave }: {
  cfg: AdsConfig; status: AdsStatus; customers: AdsGoogleCustomer[] | null; busy: string;
  onLoad: () => void; onSave: (accounts: AdsAccount[]) => void;
}) {
  const accounts = cfg.google.accounts;
  const update = (id: string, patch: Partial<AdsAccount>) =>
    onSave(accounts.map(a => (a.id === id ? { ...a, ...patch } : a)));
  const fmt = (id: string) => id.replace(/(\d{3})(\d{3})(\d{4})/, '$1-$2-$3');
  const fresh = (customers ?? []).filter(c => !c.manager && !accounts.some(a => a.id === c.id));
  return (
    <div className="ad-accounts">
      <div className="ad-set-row">
        <b>Účty a trhy</b>
        <span className="muted small">každý trh má svůj účet; čísla jdou vidět dohromady i zvlášť</span>
      </div>
      {accounts.length === 0 && <div className="muted small">Zatím žádný účet. Klikni na Načíst účty a přidej je.</div>}
      {accounts.map(a => (
        <div key={a.id} className={`ad-account ${a.enabled ? '' : 'off'}`}>
          <label className="ad-check" data-tip="Vypnutý účet se nestahuje a jeho kampaně se nepočítají">
            <input type="checkbox" checked={a.enabled} onChange={e => update(a.id, { enabled: e.target.checked })} />
          </label>
          <div className="ad-account-name">
            <b>{a.name || 'Účet bez názvu'}</b>
            <span className="muted small">{fmt(a.id)} · {a.currency}
              {' · '}
              <span className="ad-term" data-tip="Manažerský účet (MCC), přes který se k účtu chodí. Když k účtu není přímý přístup, aplikace ho při stažení najde a doplní sama; jde ho i přepsat (prázdné = přímo).">
                MCC
              </span>{' '}
              <input className="ad-login" defaultValue={a.login ? fmt(a.login) : ''} placeholder="přímo"
                onBlur={e => { const v = e.target.value.replace(/\D/g, ''); if (v !== (a.login ?? '')) update(a.id, { login: v }); }} />
            </span>
            {status.google.accountErrors?.[a.id] && <span className="ad-prop-err">{status.google.accountErrors[a.id]}</span>}
          </div>
          <select value={a.market} onChange={e => update(a.id, { market: e.target.value })}
            data-tip="Trh účtu: s objednávkami kterého webu se páruje a jaká DPH se odečítá">
            <option value="cz">CZ (quentino.cz)</option>
            <option value="sk">SK (quentino.sk)</option>
            <option value="en">.com (anglický web)</option>
          </select>
          <button className="icon-btn" data-tip="Odebrat účet z modulu (data zůstanou)"
            onClick={() => onSave(accounts.filter(x => x.id !== a.id))}><Icon name="x" size={14} /></button>
        </div>
      ))}
      <div className="ad-set-row">
        <button className="btn" onClick={onLoad} disabled={!!busy}>Načíst účty</button>
      </div>
      {customers && (
        <div className="ad-customers">
          {fresh.length === 0 && (
            <span className="muted small">
              {customers.length === 0
                ? (status.google.service
                  ? 'Servisní účet zatím nemá přístup k žádnému účtu — přidej jeho e-mail v Google Ads jako uživatele.'
                  : 'Přihlášený uživatel nemá přístup k žádnému účtu.')
                : 'Všechny dostupné účty už jsou přidané.'}
            </span>
          )}
          {fresh.map(c => {
            const market = guessMarket(c.name, c.currency);
            return (
              <button key={c.id} className="ad-customer"
                onClick={() => onSave([...accounts, { id: c.id, name: c.name, currency: c.currency || 'CZK', market, enabled: true }])}>
                <b>+ {c.name || 'Účet bez názvu'}</b>
                <span className="muted">{fmt(c.id)} · {c.currency || '?'} · přidat jako {MARKET_LABELS[market]}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

const AUTOPILOT_KIND_LABEL: [AdsProposal['kind'], string][] = [
  ['budget-up', 'Přidat rozpočet'], ['budget-down', 'Ubrat rozpočet'], ['negatives', 'Vylučující slova'],
  ['exclude', 'Vyřadit žrouty'], ['roas-up', 'Přísnější cíl ROAS'], ['roas-down', 'Volnější cíl ROAS']
];

/**
 * Samostatnost: Jen návrhy, nebo autopilot v mezích. Autopilot jde zapnout
 * až po odemčení (4 týdny, 10 vyhodnocených změn, ≥ 70 % vyšlo) — do té
 * doby je vidět, kolik ještě chybí.
 */
function AutopilotSection({ status, onStatus }: { status: AdsStatus; onStatus: (s: AdsStatus) => void }) {
  const toast = useToast();
  const cfg = status.config;
  const st = status.autopilot;
  const ap = cfg.autopilot;
  const on = cfg.autonomy === 'guarded';
  const save = async (patch: Partial<AdsConfig>, note = 'Uloženo') => {
    try { onStatus(await api.ads.config(patch)); toast(note, 'info'); } catch (e: any) { toast(e.message, 'error'); }
  };
  const setAp = (patch: Partial<AdsConfig['autopilot']>) => save({ autopilot: { ...ap, ...patch } });
  const ratio = st.evaluated ? Math.round((st.better / st.evaluated) * 100) : 0;
  return (
    <section className="ad-card ad-set ad-autopilot">
      <h3>Samostatnost</h3>
      <div className="ad-set-row">
        <label className="ad-check">
          <input type="radio" checked={!on} onChange={() => void save({ autonomy: 'suggest' }, 'Jen návrhy')} /> Jen návrhy
        </label>
        <label className={`ad-check ${st.eligible || on ? '' : 'dim'}`}
          data-tip={st.eligible ? 'Malé změny podle pravidel udělá sám v nočním běhu' : `Ještě chybí: ${st.missing.join(', ')}`}>
          <input type="radio" checked={on} disabled={!st.eligible && !on}
            onChange={() => void save({ autonomy: 'guarded' }, 'Autopilot zapnutý')} /> Autopilot v mezích
        </label>
      </div>
      {!st.eligible && (
        <div className="ad-unlock">
          <div className="muted small">Autopilot se odemkne, až se ukáže, že návrhy fungují:</div>
          <div className="ad-unlock-row"><span>Návrhy běží</span><b>{Math.min(st.daysOfProposals, 28)} / 28 dní</b>
            <i style={{ width: `${Math.min(100, (st.daysOfProposals / 28) * 100)}%` }} /></div>
          <div className="ad-unlock-row"><span>Vyhodnocené změny</span><b>{Math.min(st.evaluated, 10)} / 10</b>
            <i style={{ width: `${Math.min(100, st.evaluated * 10)}%` }} /></div>
          <div className="ad-unlock-row"><span>Vyšlo (aspoň 70 %)</span><b>{st.evaluated ? `${ratio} %` : '—'}</b>
            <i className={ratio >= 70 ? '' : 'low'} style={{ width: `${st.evaluated ? ratio : 0}%` }} /></div>
        </div>
      )}
      {on && ap.pausedAt && (
        <div className="ad-alert bad ad-card">
          <b>Autopilot se zabrzdil</b>
          <div>{ap.pausedReason}</div>
          <button className="btn small" onClick={async () => {
            try { onStatus(await api.ads.autopilotResume()); toast('Autopilot zase běží', 'info'); } catch (e: any) { toast(e.message, 'error'); }
          }}>Pustit znovu</button>
        </div>
      )}
      {(on || st.eligible) && (
        <>
          <div className="muted small">Co smí sám (každou noc po stažení dat; každá změna je v Historii a jde vrátit):</div>
          <div className="ad-set-row ad-wrap">
            {AUTOPILOT_KIND_LABEL.map(([kind, label]) => (
              <label key={kind} className="ad-check">
                <input type="checkbox" checked={ap.kinds.includes(kind)}
                  onChange={e => void setAp({ kinds: e.target.checked ? [...ap.kinds, kind] : ap.kinds.filter(k => k !== kind) })} />
                {label}
              </label>
            ))}
          </div>
          <div className="ad-set-row ad-wrap">
            <label className="ad-inline">Nejvýš
              <input type="number" min={1} max={10} defaultValue={ap.maxPerNight}
                onBlur={e => { const n = Number(e.target.value); if (n !== ap.maxPerNight) void setAp({ maxPerNight: n }); }} />
              změn za noc</label>
            <label className="ad-inline" data-tip={ADS_TERMS.confidence}>Jistota aspoň
              <input type="number" min={1} max={4} defaultValue={ap.minConfidence}
                onBlur={e => { const n = Number(e.target.value); if (n !== ap.minConfidence) void setAp({ minConfidence: n }); }} />
              ze 4</label>
            <label className="ad-check">
              <input type="checkbox" checked={ap.seasonPlans} onChange={e => void setAp({ seasonPlans: e.target.checked })} />
              Kroky sezónních plánů ve svůj den
            </label>
          </div>
          <p className="muted small">
            Sám použije jen návrhy s kladným odhadem — „drží cíl za cenu zisku" a návrhy poradce nechá tobě.
            Když ze tří jeho posledních změn vyjdou dvě hůř, sám se zabrzdí.
          </p>
          {st.lastRun && (
            <div className="small">
              Poslední noc ({relTime(st.lastRun.at)}): {st.lastRun.applied.length
                ? st.lastRun.applied.join(' · ') : 'nic k použití'}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function GuardsSection({ guards, onSave }: { guards: AdsGuards; onSave: (g: AdsGuards) => void }) {
  const [g, setG] = useState(guards);
  useEffect(() => setG(guards), [guards]);
  const field = (key: keyof AdsGuards, label: string, unit: string, scale = 1) => (
    <label className="ad-inline">
      {label}
      <input type="number" min={0} value={Math.round(g[key] * scale)}
        onChange={e => setG({ ...g, [key]: (Number(e.target.value) || 0) / scale })}
        onBlur={() => onSave(g)} />
      {unit}
    </label>
  );
  return (
    <section className="ad-card ad-set">
      <h3>Pojistky</h3>
      <p className="muted small">
        Malé kroky a dost dat. Chytré nabízení Googlu se po každé změně týden učí — velký skok ho rozhodí víc, než pomůže.
      </p>
      <div className="ad-guards">
        {field('maxBudgetStep', 'Rozpočet jedním návrhem nejvýš o', '%', 100)}
        {field('maxRoasStep', 'Cílové ROAS jedním návrhem nejvýš o', '%', 100)}
        {field('cooldownDays', 'Kampaň po změně v klidu', 'dní')}
        {field('minConversions', 'Měnit cíl až od', 'konverzí / 30 dní')}
        {field('monthlyBudget', 'Strop útraty za měsíc', 'Kč (0 = bez stropu)')}
      </div>
    </section>
  );
}

/**
 * Sklik: API token a (když se spravuje cizí účet) číslo účtu. Token se
 * po uložení hned vyzkouší — špatný se neuloží, aby noční běh nepadal
 * potichu. Na ostatní Macy ho přenese trezor.
 */
function SklikSection({ status, onStatus, busy, setBusy }: {
  status: AdsStatus; onStatus: (s: AdsStatus) => void; busy: string; setBusy: (s: string) => void;
}) {
  const toast = useToast();
  const cfg = status.config;
  const [token, setToken] = useState('');
  const [userId, setUserId] = useState(cfg.sklik.userId);
  useEffect(() => { setUserId(cfg.sklik.userId); }, [cfg.sklik.userId]);
  const has = status.sklik?.hasToken;

  const test = async () => {
    setBusy('sklik');
    try {
      const res = await api.ads.sklik(token, userId);
      onStatus(res.status);
      setToken('');
      toast(`Sklik připojen: ${res.message}`, 'info');
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy('');
    }
  };

  return (
    <section className="ad-card ad-set ad-sklik">
      <h3><span className="ad-badge sklik">S</span> Sklik</h3>
      {has && cfg.sklik.enabled ? (
        <p>Tenhle Mac má token Skliku. Poslední stažení: {relTime(status.sklik.lastFetch)}.</p>
      ) : (
        <p className="muted">
          Kampaně ze Skliku (Seznam, Zboží.cz) se počítají do zisku po reklamě stejně jako Google. Návrhy umí
          měnit <b>denní rozpočet</b> kampaní; nabídky a cíle zůstávají ve Skliku.
        </p>
      )}
      {status.sklik?.lastError && <div className="ad-alert bad ad-card">{status.sklik.lastError}</div>}
      {!has && (
        <ol className="ad-steps">
          <li>Ve Skliku otevři <b>Nastavení účtu → Správa API tokenů</b> a vytvoř token pro <b>API Drak</b> (ne Fenix — to je jiné API).</li>
          <li>Vlož ho sem a dej <b>Uložit a vyzkoušet</b>. Token je tajný jako heslo — uloží se zašifrovaně a na ostatní Macy ho přenese trezor.</li>
        </ol>
      )}
      <div className="field">
        <label>API token {has && <small>(uložený — vyplň jen pro změnu)</small>}</label>
        <input type="password" value={token} onChange={e => setToken(e.target.value)} autoComplete="off" />
      </div>
      <div className="field">
        <label>Číslo spravovaného účtu <small>(jen když token patří agentuře nebo jinému účtu)</small></label>
        <input value={userId} onChange={e => setUserId(e.target.value.replace(/\D/g, ''))} placeholder="prázdné = vlastní účet" />
      </div>
      <div className="ad-set-row">
        <button className="btn primary" onClick={test} disabled={!!busy || (!token.trim() && !has)}>
          {busy === 'sklik' ? 'Zkouším…' : has ? 'Vyzkoušet připojení' : 'Uložit a vyzkoušet'}
        </button>
        {cfg.sklik.enabled && (
          <label className="ad-check">
            <input type="checkbox" checked={cfg.sklik.enabled}
              onChange={async e => { onStatus(await api.ads.config({ sklik: { ...cfg.sklik, enabled: e.target.checked } })); }} />
            Stahovat Sklik
          </label>
        )}
        {has && (
          <button className="btn ghost" onClick={async () => onStatus(await api.ads.sklikOff())}>Odebrat token z tohoto Macu</button>
        )}
      </div>
    </section>
  );
}

/**
 * Meta: token systémového uživatele z Business Manageru, výběr reklamního
 * účtu a jeho trhu. Token se uloží jen tehdy, když Meta vrátí účty.
 */
function MetaSection({ status, onStatus, busy, setBusy }: {
  status: AdsStatus; onStatus: (s: AdsStatus) => void; busy: string; setBusy: (s: string) => void;
}) {
  const toast = useToast();
  const cfg = status.config;
  const [token, setToken] = useState('');
  const [accounts, setAccounts] = useState<AdsMetaAccount[] | null>(null);
  const [market, setMarket] = useState(cfg.meta.market || 'cz');
  const has = !!status.meta?.hasToken;
  const linked = has && cfg.meta.enabled && !!cfg.meta.accountId;

  const load = async () => {
    setBusy('meta');
    try {
      setAccounts(await api.ads.metaConnect(token));
      setToken('');
      onStatus(await api.ads.status());
    } catch (e: any) { toast(e.message, 'error'); } finally { setBusy(''); }
  };
  const use = async (a: AdsMetaAccount) => {
    setBusy('meta');
    try {
      const res = await api.ads.metaUse(a, market);
      onStatus(res.status);
      setAccounts(null);
      toast(`Meta připojena: ${res.message}`, 'info');
    } catch (e: any) { toast(e.message, 'error'); } finally { setBusy(''); }
  };

  return (
    <section className="ad-card ad-set ad-meta">
      <h3><span className="ad-badge meta">M</span> Meta (Facebook a Instagram)</h3>
      {linked ? (
        <p>Účet <b>{cfg.meta.name}</b> ({cfg.meta.accountId.replace('act_', '')} · {cfg.meta.currency} · {MARKET_LABELS[cfg.meta.market] ?? cfg.meta.market}).
          {' '}Poslední stažení: {relTime(status.meta.lastFetch)}.</p>
      ) : (
        <p className="muted">
          Reklamy na Facebooku a Instagramu se započítají do zisku po reklamě. Návrhy umí měnit <b>denní rozpočet kampaní</b>
          s rozpočtem na kampani (Advantage+); kampaně s rozpočty po sadách reklam se jen čtou.
        </p>
      )}
      {status.meta?.lastError && <div className="ad-alert bad ad-card">{status.meta.lastError}</div>}
      {!has && (
        <ol className="ad-steps">
          <li>V Business Manageru otevři <b>Nastavení firmy → Uživatelé → Systémoví uživatelé</b>, přidej uživatele (role Správce)
            a v <b>Přiřadit aktiva</b> mu dej reklamní účet s plnou kontrolou.</li>
          <li><b>Vygenerovat token</b> — aplikace podle tvé volby, oprávnění <b>ads_read</b> a <b>ads_management</b>, platnost Nikdy.</li>
          <li>Token vlož sem a dej <b>Načíst účty</b>. Je tajný jako heslo — uloží se zašifrovaně a na ostatní Macy ho přenese trezor.</li>
        </ol>
      )}
      <div className="field">
        <label>Token systémového uživatele {has && <small>(uložený — vyplň jen pro změnu)</small>}</label>
        <input type="password" value={token} onChange={e => setToken(e.target.value)} autoComplete="off" />
      </div>
      <div className="ad-set-row">
        <button className="btn primary" onClick={load} disabled={!!busy || (!token.trim() && !has)}>
          {busy === 'meta' ? 'Načítám…' : linked ? 'Změnit účet' : 'Načíst účty'}
        </button>
        {linked && (
          <label className="ad-check">
            <input type="checkbox" checked={cfg.meta.enabled}
              onChange={async e => { onStatus(await api.ads.config({ meta: { ...cfg.meta, enabled: e.target.checked } })); }} />
            Stahovat Metu
          </label>
        )}
        {has && <button className="btn ghost" onClick={async () => onStatus(await api.ads.metaOff())}>Odebrat token z tohoto Macu</button>}
      </div>
      {accounts && (
        <div className="ad-meta-accounts">
          <div className="ad-set-row">
            <span className="muted small">Trh účtu:</span>
            <select value={market} onChange={e => setMarket(e.target.value)}>
              {(['cz', 'sk', 'en'] as const).map(m => <option key={m} value={m}>{MARKET_LABELS[m] ?? m}</option>)}
            </select>
          </div>
          {accounts.length === 0 && <div className="muted small">Token nemá přístup k žádnému reklamnímu účtu — přiřaď ho systémovému uživateli.</div>}
          {accounts.map(a => (
            <div key={a.id} className="ad-account">
              <div>
                <b>{a.name}</b>
                <div className="muted small">{a.id.replace('act_', '')} · {a.currency}{a.active ? '' : ' · neaktivní'}</div>
              </div>
              <button className="btn small" disabled={!!busy} onClick={() => void use(a)}>Použít</button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function Settings({ status, onStatus, busy, setBusy }: {
  status: AdsStatus; onStatus: (s: AdsStatus) => void; busy: string; setBusy: (s: string) => void;
}) {
  const toast = useToast();
  const cfg = status.config;
  const [clientId, setClientId] = useState(cfg.google.clientId);
  const [secret, setSecret] = useState('');
  const [customers, setCustomers] = useState<AdsGoogleCustomer[] | null>(null);
  const [ship, setShip] = useState<AdsShipMethod[] | null>(null);
  const [share, setShare] = useState(String(Math.round(cfg.targetProfitShare * 100)));

  useEffect(() => { api.ads.ship().then(setShip).catch(() => setShip([])); }, []);
  useEffect(() => { setClientId(cfg.google.clientId); }, [cfg.google.clientId]);

  const save = async (patch: Partial<AdsConfig>, note = 'Uloženo') => {
    try {
      onStatus(await api.ads.config(patch));
      toast(note, 'info');
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const connect = async () => {
    setBusy('connect');
    try {
      onStatus(await api.ads.connect(clientId, secret || undefined));
      setSecret('');
      toast('Google Ads připojen', 'info');
      setCustomers(await api.ads.customers());
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const loadCustomers = async () => {
    setBusy('customers');
    try { setCustomers(await api.ads.customers()); } catch (e: any) { toast(e.message, 'error'); } finally { setBusy(''); }
  };

  const publish = async () => {
    setBusy('feed');
    try {
      await api.ads.publishFeed();
      onStatus(await api.ads.status());
      toast('Feed se segmenty je vystavený', 'info');
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const shipCost = (name: string, cost: number) => {
    const list = (ship ?? []).map(m => (m.name === name ? { ...m, cost, guessed: false } : m));
    setShip(list);
  };
  const saveShip = () => save({ shipping: (ship ?? []).map(m => ({ name: m.name, cost: m.cost, guessed: m.guessed })) },
    'Náklady na dopravu uložené');

  return (
    <div className="ad-settings">
      <section className="ad-card ad-set">
        <h3><span className="ad-badge google">G</span> Google Ads</h3>
        {status.google.connected ? (
          <>
            <p>
              {status.google.service ? 'Tenhle Mac se připojuje servisním účtem' : 'Tenhle Mac je přihlášený'}.
              {' '}Poslední stažení: {relTime(status.google.lastFetch)}.
            </p>
            {status.google.service && (
              <div className="ad-feedurl">
                <code>{status.google.service}</code>
                <button className="btn ghost" onClick={() => { void navigator.clipboard.writeText(status.google.service); toast('E-mail zkopírovaný', 'info'); }}>Kopírovat</button>
              </div>
            )}
            {status.google.service && (
              <p className="muted small">
                Tenhle e-mail musí být v Google Ads jako uživatel (Správce → Přístup a zabezpečení) s přístupem Standardní.
                Udělej to v každém účtu, který má modul řídit (CZ, SK, .com). Když Načíst účty některý nenajde, ještě tam přidaný není.
              </p>
            )}
            {status.google.lastError && <div className="ad-alert bad ad-card">{status.google.lastError}</div>}
            <AccountsBlock cfg={cfg} status={status} customers={customers} busy={busy}
              onLoad={loadCustomers} onSave={accounts => save({ google: { ...cfg.google, accounts } }, 'Účty uložené')} />
            <div className="ad-set-row">
              <button className="btn ghost" onClick={async () => onStatus(await api.ads.disconnect())}>
                {status.google.service ? 'Odebrat klíč z tohoto Macu' : 'Odhlásit tento Mac'}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="muted">
              Stačí připojit <b>jeden Mac</b> — ostatní si data vezmou ze sdílené složky
              {status.shared ? '' : ' (zapni synchronizaci v Nastavení aplikace)'}.
              Klíč se na ostatní Macy přenese sám přes šifrovaný trezor (Nastavení → Synchronizace), když je odemčený.
            </p>
            <div className="ad-way">
              <div className="ad-set-row"><b>Servisní účet</b><span className="ad-chip ok">doporučeno</span></div>
              <p className="muted small">
                Bez přihlašovací obrazovky a bez ověřování aplikace u Googlu. Klíč nevyprší.
              </p>
              <ol className="ad-steps">
                <li>V Google Cloud Console (projekt s Google Ads API) otevři <b>IAM &amp; Admin → Service Accounts</b> a dej <b>Create service account</b> (stačí název, role žádné).</li>
                <li>U něj <b>Keys → Add key → Create new key → JSON</b>. Stáhne se soubor s klíčem.</li>
                <li>Soubor nahraj tady. Aplikace pak ukáže e-mail servisního účtu.</li>
                <li>V Google Ads: <b>Správce → Přístup a zabezpečení → +</b>, vlož ten e-mail a dej přístup <b>Standardní</b> (bez něj nepůjde Použít, jen čtení).</li>
              </ol>
              <label className="btn primary ad-file">
                Nahrát klíč (JSON)
                <input type="file" accept=".json,application/json" onChange={async e => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (!file) return;
                  try {
                    onStatus(await api.ads.service(await file.text()));
                    toast('Klíč uložený — teď přidej servisní účet jako uživatele v Google Ads', 'info');
                  } catch (err: any) { toast(err.message, 'error'); }
                }} />
              </label>
            </div>
            <details className="ad-adv">
              <summary>Nebo přihlášení přes prohlížeč (OAuth)</summary>
              <p className="muted small">
                Chce aplikaci v Google Cloudu ve stavu <b>In production</b> — k tomu Google vyžaduje značku, domovskou stránku
                a podmínky. Ve stavu Testing přihlášení po 7 dnech vyprší.
              </p>
              <div className="field">
                <label>ID klienta OAuth</label>
                <input value={clientId} onChange={e => setClientId(e.target.value)} placeholder="…apps.googleusercontent.com" />
              </div>
              <div className="field">
                <label>Tajný klíč klienta {status.google.hasSecret && <small>(uložený — vyplň jen pro změnu)</small>}</label>
                <input type="password" value={secret} onChange={e => setSecret(e.target.value)} autoComplete="off" />
              </div>
              <button className="btn" onClick={connect}
                disabled={!!busy || !clientId.trim() || (!secret.trim() && !status.google.hasSecret)}>
                {busy === 'connect' ? 'Čekám na prohlížeč…' : 'Přihlásit Google'}
              </button>
            </details>
          </>
        )}
        <details className="ad-adv">
          <summary>Pokročilé</summary>
          <div className="field">
            <label>Společný manažerský účet (MCC) <small>(pro účty bez vlastního — ten jde nastavit u účtu v Účtech a trzích)</small></label>
            <input defaultValue={cfg.google.loginCustomerId} placeholder="prázdné = přímo"
              onBlur={e => { if (e.target.value !== cfg.google.loginCustomerId) void save({ google: { ...cfg.google, loginCustomerId: e.target.value.replace(/\D/g, '') } }); }} />
          </div>
          <div className="field">
            <label>ID účtu Merchant Center <small>(pro nové kampaně Nákupy)</small></label>
            <input defaultValue={cfg.google.merchantId} placeholder="např. 123456789"
              onBlur={e => { const v = e.target.value.replace(/\D/g, ''); if (v !== cfg.google.merchantId) void save({ google: { ...cfg.google, merchantId: v } }); }} />
          </div>
          <div className="field">
            <label>Štítek feedu po trzích <small>(feed label v Merchant Center; prázdné = produkty ze všech feedů)</small></label>
            <div className="ad-set-row">
              {cfg.markets.map(m => (
                <label key={m} className="ad-inline">{MARKET_LABELS[m] ?? m}
                  <input defaultValue={cfg.google.feedLabels[m] ?? ''} placeholder={m.toUpperCase()} style={{ width: 70 }}
                    onBlur={e => {
                      const v = e.target.value.trim();
                      if (v !== (cfg.google.feedLabels[m] ?? '')) void save({ google: { ...cfg.google, feedLabels: { ...cfg.google.feedLabels, [m]: v } } });
                    }} />
                </label>
              ))}
            </div>
          </div>
          <div className="field">
            <label>Verze API</label>
            <input defaultValue={cfg.google.apiVersion}
              onBlur={e => { if (e.target.value.trim() && e.target.value !== cfg.google.apiVersion) void save({ google: { ...cfg.google, apiVersion: e.target.value.trim() } }); }} />
          </div>
        </details>
      </section>

      <SklikSection status={status} onStatus={onStatus} busy={busy} setBusy={setBusy} />
      <MetaSection status={status} onStatus={onStatus} busy={busy} setBusy={setBusy} />

      <section className="ad-card ad-set">
        <h3>Cíl</h3>
        <div className="ad-set-row">
          <label className="ad-inline">
            Zisk po reklamě aspoň
            <input type="number" min={0} max={90} value={share} onChange={e => setShare(e.target.value)}
              onBlur={() => void save({ targetProfitShare: Math.max(0, Math.min(90, Number(share) || 0)) / 100 })} />
            % z obratu bez DPH
          </label>
        </div>
        <p className="muted small">
          Z toho se počítá cílové PNO: <b>marže − {share} %</b>. Kravata s marží 75 % tak snese PNO 25 %,
          ponožky s marží 55 % jen 5 %. Jedno PNO pro celý e-shop by na levném zboží prodělávalo.
        </p>
        <label className="ad-check">
          <input type="checkbox" checked={cfg.convValueWithVat}
            onChange={e => void save({ convValueWithVat: e.target.checked })} />
          <span>Hodnota konverze, kterou web posílá do reklam, je <b>s DPH</b></span>
        </label>
        <div className="ad-set-row">
          <span className="muted">Trhy:</span>
          {(['cz', 'sk', 'en'] as const).map(m => (
            <label key={m} className="ad-check">
              <input type="checkbox" checked={cfg.markets.includes(m)}
                onChange={e => {
                  const next = e.target.checked ? [...cfg.markets, m] : cfg.markets.filter(x => x !== m);
                  if (next.length) void save({ markets: next });
                }} />
              {m === 'en' ? '.com' : `.${m}`}
            </label>
          ))}
        </div>
      </section>

      <AutopilotSection status={status} onStatus={onStatus} />

      <GuardsSection guards={cfg.guards} onSave={guards => save({ guards }, 'Pojistky uložené')} />

      <section className="ad-card ad-set">
        <h3>Doprava</h3>
        <p className="muted small">
          Kolik nás stojí doprava podle způsobu (Kč bez DPH za zásilku). Co zaplatil zákazník, se počítá jako příjem;
          tohle je náklad. Odhady aplikace jsou označené.
        </p>
        {!ship && <div className="muted">Načítám…</div>}
        {ship && ship.length === 0 && <div className="muted">V objednávkách za půl roku zatím není žádná doprava.</div>}
        {ship && ship.length > 0 && (
          <table className="ad-table ad-ship">
            <thead><tr><th>Doprava</th><th className="r">Objednávek</th><th className="r">Zákazník platí</th><th className="r">Stojí nás</th></tr></thead>
            <tbody>
              {ship.map(m => (
                <tr key={m.name}>
                  <td>{m.name}{m.guessed && <span className="ad-chip warn">odhad</span>}</td>
                  <td className="r">{m.orders}</td>
                  <td className="r">{kc(m.paidAvg)}</td>
                  <td className="r">
                    <input type="number" min={0} value={Math.round(m.cost)} onChange={e => shipCost(m.name, Number(e.target.value) || 0)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {ship && ship.length > 0 && <button className="btn" onClick={saveShip}>Uložit dopravy</button>}
      </section>

      <section className="ad-card ad-set">
        <h3>Segmenty do Merchant Center</h3>
        <p className="muted small">
          Doplňkový feed s <code>custom_label_0</code> = segment (hvezdy, pracanti, zrouti…) a <code>custom_label_1</code> = pásmo
          marže. V Merchant Center: <b>Produkty → Feedy → Doplňkové feedy → Přidat</b>, plánované načítání z adresy níže,
          jednou denně. Pak jde v kampani rozdělit produkty podle segmentu.
        </p>
        <p className="muted small">
          Vyřazení žroutů jde přes <code>custom_label_2 = vyradit</code>. V Performance Max (skupina položek) nebo v Nákupech
          tuhle hodnotu <b>jednou</b> vylouč — pak se produkty vyřazují a po 30 dnech vracejí jen změnou feedu.
        </p>
        {status.feedUrl
          ? <div className="ad-feedurl"><code>{status.feedUrl}</code>
            <button className="btn ghost" onClick={() => { void navigator.clipboard.writeText(status.feedUrl); toast('Adresa zkopírovaná', 'info'); }}>Kopírovat</button></div>
          : <div className="muted">Chybí úložiště — nastavuje se u Textů na webu (záložka Napojení).</div>}
        <div className="ad-set-row">
          <button className="btn" onClick={publish} disabled={!!busy || !status.feedUrl}>Vystavit feed teď</button>
          <span className="muted small">
            {status.feedPublishedAt ? `Naposledy ${relTime(status.feedPublishedAt)}. ` : ''}Jinak se vystaví sám po nočním běhu.
          </span>
        </div>
      </section>

      <section className="ad-card ad-set">
        <h3>Nákupní ceny</h3>
        <p className="muted small">
          Nákupní cenu v e-shopu má <b>{status.purchase.withPrice} z {status.purchase.total}</b> produktů.
          U ostatních se marže odhaduje mediánem kategorie. Ceny se berou z produktového feedu (Nastavení → Produkty).
        </p>
      </section>
    </div>
  );
}
