import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  AdsStatus, AdsOverview, AdsCampaignRow, AdsProducts, AdsProductRow, AdsSegment, AdsShipMethod,
  AdsGoogleCustomer, AdsConfig, AdsSystemTile
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
 * Návrhy změn a autopilot přijdou až po tom, co se na skutečných datech
 * ukáže, že čísla sedí. Proto okno nemá žádné tlačítko, které by do účtu
 * něco zapsalo.
 */

type Tab = 'today' | 'campaigns' | 'products' | 'settings';

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
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    try {
      const st = await api.ads.status();
      setStatus(st);
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
            <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>Nastavení</button>
          </div>
          <span style={{ flex: 1 }} />
          {tab !== 'settings' && (
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
          {tab === 'today' && <Today overview={overview} status={status} onSettings={() => setTab('settings')} />}
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
        <b>Fáze 1 — jen čte, v účtech nic nemění.</b>{' '}
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

function Today({ overview, status, onSettings }: {
  overview: AdsOverview | null; status: AdsStatus | null; onSettings: () => void;
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
        <div className="ad-side-head"><b>Co je potřeba vědět</b></div>
        {o.alerts.length === 0 && <div className="ad-card ad-alert ok">Data sedí a nic nehoří.</div>}
        {o.alerts.map((one, i) => (
          <div key={i} className={`ad-card ad-alert ${one.level}`}>
            <b>{one.title}</b>
            <div>{one.text}</div>
          </div>
        ))}
        <div className="ad-card ad-gate">
          <b>Než přijdou návrhy změn</b>
          <div className="muted">
            Návrhy a autopilot se zapnou, až se ukáže, že čísla sedí: <b>14 dní</b> dat z Google Ads
            spárovaných s objednávkami.
          </div>
          <div className="ad-bar"><i style={{ width: `${Math.min(100, (daysWithAds / 14) * 100)}%` }} /></div>
          <div className="muted small">{Math.min(daysWithAds, 14)} ze 14 dní</div>
        </div>
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

/* ---------- Nastavení ---------- */

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
              Tenhle Mac je přihlášený{cfg.google.customerId ? <> · účet <b>{cfg.google.customerName || cfg.google.customerId}</b></> : ''}.
              {' '}Poslední stažení: {relTime(status.google.lastFetch)}.
            </p>
            {status.google.lastError && <div className="ad-alert bad ad-card">{status.google.lastError}</div>}
            <div className="ad-set-row">
              <button className="btn" onClick={loadCustomers} disabled={!!busy}>Vybrat účet</button>
              <button className="btn ghost" onClick={async () => onStatus(await api.ads.disconnect())}>Odhlásit tento Mac</button>
            </div>
            {customers && (
              <div className="ad-customers">
                {customers.length === 0 && <span className="muted">Přihlášený uživatel nemá přístup k žádnému účtu.</span>}
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
              Stačí přihlásit <b>jeden Mac</b> — ostatní si data vezmou ze sdílené složky
              {status.shared ? '' : ' (zapni synchronizaci v Nastavení aplikace)'}.
              Přihlášení zůstává v klíčence tohoto Macu.
            </p>
            <ol className="ad-steps">
              <li>V <b>Google Cloud Console</b> vyber projekt a v knihovně API zapni <b>Google Ads API</b>.</li>
              <li>Na stránce Google Ads API → Overview požádej o přístup <b>Explorer</b> (čtení skutečných účtů).</li>
              <li>V Credentials vytvoř <b>OAuth client ID</b> typu <b>Desktop app</b> a zkopíruj ID a tajný klíč.</li>
              <li>OAuth consent screen přepni na <b>In production</b> — ve stavu Testing přihlášení po 7 dnech vyprší.</li>
            </ol>
            <div className="field">
              <label>ID klienta OAuth</label>
              <input value={clientId} onChange={e => setClientId(e.target.value)} placeholder="…apps.googleusercontent.com" />
            </div>
            <div className="field">
              <label>Tajný klíč klienta {status.google.hasSecret && <small>(uložený — vyplň jen pro změnu)</small>}</label>
              <input type="password" value={secret} onChange={e => setSecret(e.target.value)} autoComplete="off" />
            </div>
            <button className="btn primary" onClick={connect}
              disabled={!!busy || !clientId.trim() || (!secret.trim() && !status.google.hasSecret)}>
              {busy === 'connect' ? 'Čekám na prohlížeč…' : 'Přihlásit Google'}
            </button>
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
