import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  AdsStatus, AdsOverview, AdsCampaignRow, AdsProducts, AdsProductRow, AdsSegment, AdsShipMethod,
  AdsGoogleCustomer, AdsConfig, AdsSystemTile, AdsProposals, AdsProposal, AdsChange, AdsGuards
} from '@shared/ads';
import { SEGMENT_LABELS } from '@shared/ads';
import { api } from '../api';
import { useToast } from '../toast';
import Icon from './Icon';
import HelpButton from './HelpPanel';
import { inToolWindow } from '../toolwindows';

/**
 * Reklamy — fáze 1.
 *
 * Modul zatím jen čte: stáhne výkon z Google Ads, spáruje ho
 * s objednávkami a nákupními cenami a ukáže, kolik reklama opravdu
 * vydělává. První číslo na každé obrazovce je **zisk po reklamě** — ne
 * tržba, ne ROAS. Tržba bez marže v e-shopu, kde jedna věc má marži 80 %
 * a jiná 30 %, o úspěchu reklamy nic neříká.
 *
 * Do účtu se zapisuje jen přes návrh, který člověk potvrdí tlačítkem
 * Použít — a každá provedená změna jde vrátit. Autopilot přijde až po
 * tom, co se ukáže, že odhady návrhů vycházejí.
 */

type Tab = 'today' | 'campaigns' | 'products' | 'proposals' | 'settings';

const SYSTEM_LABEL: Record<string, string> = { google: 'Google Ads', sklik: 'Sklik', meta: 'Meta' };
const SYSTEM_SHORT: Record<string, string> = { google: 'G', sklik: 'S', meta: 'M' };
const SYSTEM_PHASE: Record<string, string> = { sklik: 'připojí se ve fázi 3', meta: 'připojí se ve fázi 4' };

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
  const [status, setStatus] = useState<AdsStatus | null>(null);
  const [overview, setOverview] = useState<AdsOverview | null>(null);
  const [campaigns, setCampaigns] = useState<AdsCampaignRow[] | null>(null);
  const [products, setProducts] = useState<AdsProducts | null>(null);
  const [proposals, setProposals] = useState<AdsProposals | null>(null);
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    try {
      const st = await api.ads.status();
      setStatus(st);
      // Návrhy se načítají vždy — číslo u záložky a „Čeká na tebe" v Dnes
      setProposals(await api.ads.proposals());
      if (tab === 'today') setOverview(await api.ads.overview(days));
      if (tab === 'campaigns') setCampaigns(await api.ads.campaigns(days));
      if (tab === 'products') setProducts(await api.ads.products(days));
    } catch (e: any) {
      toast(e.message, 'error');
    }
  }, [tab, days, toast]);

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

  const connected = !!status?.google.connected;

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
            <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>Nastavení</button>
          </div>
          <span style={{ flex: 1 }} />
          {tab !== 'settings' && tab !== 'proposals' && (
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

        <div className="ad-body">
          {tab === 'today' && (
            <Today overview={overview} status={status} proposals={proposals} onSettings={() => setTab('settings')}
              onProposals={() => setTab('proposals')} onChanged={load} />
          )}
          {tab === 'proposals' && status && (
            <Proposals data={proposals} status={status} onChanged={load} busy={busy} setBusy={setBusy} />
          )}
          {tab === 'campaigns' && <Campaigns rows={campaigns} />}
          {tab === 'products' && <Products data={products} />}
          {tab === 'settings' && status && (
            <Settings status={status} onStatus={setStatus} busy={busy} setBusy={setBusy} />
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------- stavový řádek ---------- */

function StatusLine({ status }: { status: AdsStatus }) {
  const run = status.lastRun;
  return (
    <div className="ad-status">
      <span className={`ad-dot ${status.google.lastError ? 'bad' : run ? 'ok' : ''}`} />
      <span>
        <b>Mění jen to, co schválíš — každá změna jde vrátit.</b>{' '}
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
            <div className="ad-h">Zisk po reklamě · {o.days} dní</div>
            <div className="ad-v">{kc(o.profitAfterAds.value)}</div>
            <div className="ad-d">
              <Delta now={o.profitAfterAds.value} prev={o.profitAfterAds.prev} />{' '}
              <span className="muted" data-tip="Podíl zisku po reklamě na obratu bez DPH">
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
            <div className="ad-h" data-tip="Náklady na reklamu / obrat bez DPH ze všech objednávek">PNO e-shopu</div>
            <div className="ad-v">{pct(o.shopPno)}</div>
            <div className="ad-d">
              <span className={`ad-chip ${o.shopPno != null && o.targetPno != null && o.shopPno > o.targetPno ? 'bad' : 'ok'}`}
                data-tip={`Marže objednávek po dopravě ${pct(o.margin, 0)} − cílový podíl zisku ${pct(target, 0)}`}>
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
                  <div className="ad-row"><span className="muted">Útrata</span><b>{kc(sys.cost)}</b></div>
                  <div className="ad-row"><span className="muted" data-tip="Hodnota konverzí bez DPH × marže − útrata">Zisk z konverzí</span><b>{kc(sys.profit)}</b></div>
                  <div className="ad-row"><span className="muted">PNO / cíl</span><b>{pct(sys.pno)} / {pct(sys.targetPno, 0)}</b></div>
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
  VIDEO: 'Video', DEMAND_GEN: 'Demand Gen', SMART: 'Chytrá', LOCAL: 'Místní'
};
const BIDDING_LABEL: Record<string, string> = {
  MAXIMIZE_CONVERSION_VALUE: 'max. hodnota', TARGET_ROAS: 'cílové ROAS', MAXIMIZE_CONVERSIONS: 'max. konverze',
  TARGET_CPA: 'cílová CPA', MANUAL_CPC: 'ruční CPC', TARGET_SPEND: 'max. kliky', MAXIMIZE_CLICKS: 'max. kliky'
};

function Campaigns({ rows }: { rows: AdsCampaignRow[] | null }) {
  if (!rows) return <div className="ad-empty">Načítám…</div>;
  if (!rows.length) return <div className="ad-empty">Zatím žádné kampaně. Připoj Google Ads v Nastavení a načti data.</div>;
  return (
    <div className="ad-card ad-table-wrap">
      <table className="ad-table">
        <thead>
          <tr>
            <th>Kampaň</th><th>Typ</th><th className="r">Rozpočet/den</th><th className="r">Útrata</th>
            <th className="r">Konverze</th><th className="r" data-tip="Hodnota konverzí bez DPH">Hodnota</th>
            <th className="r" data-tip="Hodnota × marže objednávek − útrata">Zisk</th><th className="r">PNO / cíl</th><th>Nabízení</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => {
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
                <td>{TYPE_LABEL[row.type] ?? row.type}</td>
                <td className="r">{row.budget != null ? kc(row.budget) : '—'}</td>
                <td className="r">{kc(row.cost)}</td>
                <td className="r">{row.conversions.toLocaleString('cs-CZ', { maximumFractionDigits: 1 })}</td>
                <td className="r">{kc(row.value)}</td>
                <td className={`r ${row.profit < 0 ? 'neg' : ''}`}><b>{kc(row.profit)}</b></td>
                <td className={`r ${over ? 'neg' : ''}`}>{pct(row.pno)} / {pct(row.targetPno, 0)}</td>
                <td className="muted">
                  {BIDDING_LABEL[row.bidding] ?? row.bidding}
                  {row.targetRoas ? ` ${Math.round(row.targetRoas * 100)} %` : ''}
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

function Products({ data }: { data: AdsProducts | null }) {
  const [segment, setSegment] = useState<AdsSegment | null>(null);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const [limit, setLimit] = useState(100);

  const rows = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    return data.rows.filter(r => (!segment || r.segment === segment)
      && (!q || r.title.toLowerCase().includes(q) || r.code.toLowerCase().includes(q))
      && (!picked || r.code === picked));
  }, [data, segment, query, picked]);

  if (!data) return <div className="ad-empty">Načítám…</div>;
  return (
    <div className="ad-products">
      <div className="ad-card ad-map-card">
        <div className="ad-chart-head"><b>Mapa produktů</b><span className="muted small">velikost tečky = hodnota konverzí</span></div>
        <ProductMap rows={data.rows} active={segment} onPick={code => { setPicked(code); setSegment(null); }} />
        <div className="ad-seglist">
          {SEGMENT_ORDER.map(one => (
            <button key={one} className={`ad-seg ${one} ${segment === one ? 'on' : ''}`}
              onClick={() => { setSegment(segment === one ? null : one); setPicked(null); }}>
              {SEGMENT_LABELS[one]} <b>{data.counts[one]}</b>
            </button>
          ))}
        </div>
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
          {picked && <button className="btn ghost" onClick={() => setPicked(null)}>Zrušit výběr</button>}
          <span style={{ flex: 1 }} />
          <span className="muted small">{rows.length} produktů</span>
        </div>
        <div className="ad-card ad-table-wrap">
          <table className="ad-table ad-ptable">
            <thead>
              <tr>
                <th>Produkt</th><th>Segment</th><th className="r">Marže</th><th className="r">Útrata</th>
                <th className="r">Zisk</th><th className="r" data-tip="PNO produktu / bod zlomu (= marže)">PNO / zlom</th>
                <th className="r" data-tip="Prodáno kusů ve všech objednávkách, nejen z reklam">Prodáno</th><th className="r">Sklad</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, limit).map(r => (
                <tr key={r.code} data-tip={r.why}>
                  <td>
                    <div className="ad-name">
                      {r.image ? <img src={r.image} alt="" loading="lazy" /> : <span className="ad-thumb" />}
                      <span className="ad-ptitle">{r.title || r.code}</span>
                    </div>
                  </td>
                  <td><span className={`ad-seg ${r.segment} small`}>{SEGMENT_LABELS[r.segment]}</span></td>
                  <td className="r" data-tip={r.marginEstimated ? 'Nákupní cena chybí — odhad podle kategorie' : undefined}>
                    {pct(r.margin, 0)}{r.marginEstimated ? '*' : ''}
                  </td>
                  <td className="r">{r.cost ? kc(r.cost) : '—'}</td>
                  <td className={`r ${r.profit < 0 ? 'neg' : ''}`}>{r.cost || r.value ? <b>{kc(r.profit)}</b> : '—'}</td>
                  <td className={`r ${r.pno != null && r.breakEven != null && r.pno > r.breakEven ? 'neg' : ''}`}>
                    {pct(r.pno, 0)} / {pct(r.breakEven, 0)}
                  </td>
                  <td className="r">{r.sold || '—'}</td>
                  <td className="r">{r.stock ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > limit && (
            <button className="btn ghost ad-more" onClick={() => setLimit(limit + 200)}>Ukázat další ({rows.length - limit})</button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------- Návrhy ---------- */

const KIND_LABEL: Record<string, string> = {
  'budget-up': 'Rozpočet', 'budget-down': 'Rozpočet', 'roas-up': 'Cílové ROAS', 'roas-down': 'Cílové ROAS',
  'roas-set': 'Cílové ROAS', negatives: 'Vylučující slova', exclude: 'Produkty'
};

function Confidence({ n }: { n: number }) {
  const label = ['', 'málo dat', 'dost dat', 'hodně dat', 'velmi spolehlivé'][n] ?? '';
  return (
    <span className="ad-conf" data-tip={`Jistota: ${label}`}>
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

function needsGoogle(p: AdsProposal): boolean {
  return p.ops.some(op => op.kind !== 'exclude');
}

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
  const viaOther = needsGoogle(p) && !status.google.connected;
  const act = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try { await fn(); toast(done, 'info'); onChanged(); } catch (e: any) { toast(e.message, 'error'); onChanged(); } finally { setBusy(false); }
  };
  return (
    <div className={`ad-card ad-prop ${p.status}`}>
      <div className="ad-prop-top">
        <span className="ad-chip">{KIND_LABEL[p.kind] ?? p.kind}</span>
        <span className={`ad-chip ${p.impact >= 0 ? 'ok' : 'warn'}`}
          data-tip="Odhad změny zisku po reklamě za 30 dní">
          {p.impact >= 0 ? '+' : '−'}{kc(Math.abs(p.impact))} / 30 dní{p.impact < 0 ? ' · drží cíl' : ''}
        </span>
        <Confidence n={p.confidence} />
      </div>
      <div className="ad-prop-title">{p.title}</div>
      {open && <div className="ad-prop-why">{p.why}</div>}
      {open && <OpsList p={p} />}
      {p.error && <div className="ad-prop-err">{p.error}</div>}
      <div className="ad-prop-btns">
        <button className="btn primary small" disabled={busy}
          data-tip={viaOther ? 'Tenhle Mac není přihlášený ke Google Ads — změnu provede přihlášený Mac do deseti minut' : 'Provede změnu v účtu. Jde vrátit v Historii změn.'}
          onClick={() => act(() => api.ads.apply(p.id), viaOther ? 'Schváleno — provede to přihlášený Mac' : 'Změna je v účtu')}>
          {viaOther ? 'Schválit' : 'Použít'}
        </button>
        {compact && !open && <button className="btn ghost small" onClick={() => setOpen(true)}>Proč</button>}
        <button className="btn ghost small" disabled={busy}
          onClick={() => act(() => api.ads.decide(p.id, 'snooze'), 'Odloženo na týden')}>Odložit</button>
        {!compact && (
          <>
            <button className="btn ghost small" disabled={busy}
              onClick={() => act(() => api.ads.decide(p.id, 'dismiss'), 'Zamítnuto — dva týdny se nenabídne')}>Zamítnout</button>
            <button className="btn ghost small" disabled={busy}
              data-tip="Tenhle druh návrhu pro tuhle kampaň už nenabízet"
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
  const canRevert = !c.revertOf && !c.revertedAt && (status.google.connected || c.undo.every(op => op.kind === 'exclude-remove'));
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
                <div className="muted small">Schválil {p.decidedBy.replace(/\s*\([^)]*\)$/, '')} · provede se do deseti minut na Macu přihlášeném ke Google Ads.</div>
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
              {status.google.service ? 'Tenhle Mac se připojuje servisním účtem' : 'Tenhle Mac je přihlášený'}
              {cfg.google.customerId ? <> · účet <b>{cfg.google.customerName || cfg.google.customerId}</b></> : ''}.
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
                Když po kliknutí na Vybrat účet žádný účet nenajde, ještě tam přidaný není.
              </p>
            )}
            {status.google.lastError && <div className="ad-alert bad ad-card">{status.google.lastError}</div>}
            <div className="ad-set-row">
              <button className="btn" onClick={loadCustomers} disabled={!!busy}>Vybrat účet</button>
              <button className="btn ghost" onClick={async () => onStatus(await api.ads.disconnect())}>
                {status.google.service ? 'Odebrat klíč z tohoto Macu' : 'Odhlásit tento Mac'}
              </button>
            </div>
            {customers && (
              <div className="ad-customers">
                {customers.length === 0 && (
                  <span className="muted">
                    {status.google.service
                      ? 'Servisní účet zatím nemá přístup k žádnému účtu — přidej jeho e-mail v Google Ads jako uživatele.'
                      : 'Přihlášený uživatel nemá přístup k žádnému účtu.'}
                  </span>
                )}
                {customers.map(c => (
                  <button key={c.id} className={`ad-customer ${cfg.google.customerId === c.id ? 'on' : ''}`}
                    onClick={() => void save({ google: { ...cfg.google, customerId: c.id, customerName: c.name, currency: c.currency || 'CZK' } }, 'Účet vybraný')}>
                    <b>{c.name || 'Účet bez názvu'}</b>
                    <span className="muted">{c.id.replace(/(\d{3})(\d{3})(\d{4})/, '$1-$2-$3')} · {c.currency || '?'}{c.manager ? ' · manažerský' : ''}</span>
                  </button>
                ))}
              </div>
            )}
          </>
        ) : (
          <>
            <p className="muted">
              Stačí připojit <b>jeden Mac</b> — ostatní si data vezmou ze sdílené složky
              {status.shared ? '' : ' (zapni synchronizaci v Nastavení aplikace)'}.
              Klíč i přihlášení zůstávají jen v tomhle Macu.
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
            <label>Manažerský účet (MCC), přes který se k účtu chodí</label>
            <input defaultValue={cfg.google.loginCustomerId} placeholder="prázdné = přímo"
              onBlur={e => { if (e.target.value !== cfg.google.loginCustomerId) void save({ google: { ...cfg.google, loginCustomerId: e.target.value.replace(/\D/g, '') } }); }} />
          </div>
          <div className="field">
            <label>Verze API</label>
            <input defaultValue={cfg.google.apiVersion}
              onBlur={e => { if (e.target.value.trim() && e.target.value !== cfg.google.apiVersion) void save({ google: { ...cfg.google, apiVersion: e.target.value.trim() } }); }} />
          </div>
        </details>
      </section>

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
        <div className="ad-set-row">
          <span className="muted">Samostatnost:</span>
          <label className="ad-check"><input type="radio" checked readOnly /> Jen návrhy</label>
          <label className="ad-check dim" data-tip="Zapne se po 4 týdnech návrhů, když aspoň 70 % odhadů vyjde">
            <input type="radio" disabled /> Autopilot v mezích
          </label>
        </div>
      </section>

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
