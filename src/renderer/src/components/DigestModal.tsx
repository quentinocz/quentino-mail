import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  DigestArchiveRow, DigestDay, DigestFacts, DigestInsight, DigestMonth, DigestReport,
  DigestSlice, DigestTask, DigestTotals, DigestTurn
} from '@shared/types';
import { api } from '../api';
import { useIsPhone } from '../mobile';
import { useToast } from '../toast';
import Icon from './Icon';

/**
 * AI Přehled.
 *
 * Ráno jde o tři věci: **jak se prodává**, **co čeká na odpověď** a **co
 * s tím**. Podle toho je okno postavené — čísla nahoře, seznam k vyřízení
 * hned pod nimi (a klikací, aby se z něj dalo rovnou skočit do zprávy nebo
 * do chatu), grafy uprostřed a postřehy od AI na konci.
 *
 * Čísla se počítají při každém otevření — jsou z místní databáze. Postřehy
 * stojí čas i peníze, a proto se dělají **nejvýš jednou za 24 hodin**;
 * do té doby se ukazuje uložený a přegenerovat jde tlačítkem.
 */

const MONEY = new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 0 });

function money(amount: number, currency: string): string {
  return `${MONEY.format(Math.round(amount))} ${currency === 'CZK' ? 'Kč' : currency}`;
}

function moneyOf(totals: DigestTotals, currency: string): string {
  const main = totals.revenue.find(one => one.currency === currency);
  const rest = totals.revenue.filter(one => one.currency !== currency);
  const head = money(main?.amount ?? 0, currency);
  // Cizí měny se nesčítají, ale zmizet nesmí — visí za hlavní částkou
  return rest.length ? `${head} + ${rest.map(one => money(one.amount, one.currency)).join(' + ')}` : head;
}

/** Rozdíl proti srovnávanému období — bez procent u nuly, ta se dělit nedá */
function delta(now: number, before: number): { text: string; tone: 'up' | 'down' | 'flat' } {
  if (!before && !now) return { text: 'stejně jako minule', tone: 'flat' };
  if (!before) return { text: 'poprvé', tone: 'up' };
  const pct = Math.round(((now - before) / before) * 100);
  if (pct === 0) return { text: 'stejně', tone: 'flat' };
  return { text: `${pct > 0 ? '+' : ''}${pct} %`, tone: pct > 0 ? 'up' : 'down' };
}

function dayLabel(day: string): string {
  const [, month, date] = day.split('-');
  return `${Number(date)}. ${Number(month)}.`;
}

function since(at: string): string {
  const ms = Date.now() - new Date(at).getTime();
  if (!Number.isFinite(ms)) return '';
  const hours = Math.floor(ms / 3600_000);
  if (hours < 1) return 'právě teď';
  if (hours < 24) return `před ${hours} h`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'včera' : `před ${days} dny`;
}

/* ---------- graf ---------- */

/**
 * Sloupce za posledních třicet dní.
 *
 * Kreslí se rovnou do SVG, bez knihovny: je to třicet obdélníků a všechno,
 * co by knihovna přidala navíc, by se stejně muselo přebarvovat podle
 * světlého a tmavého motivu. Víkendy jsou světlejší — bez nich se v řadě
 * nedá poznat, jestli je propad problém, nebo neděle.
 */
function DayChart({ days, currency, mode }: { days: DigestDay[]; currency: string; mode: 'orders' | 'revenue' }) {
  const value = (day: DigestDay) => (mode === 'orders' ? day.orders : day.revenue);
  const top = Math.max(1, ...days.map(value));
  const width = 100;
  const gap = 0.6;
  const step = width / days.length;

  return (
    <div className="dg-chart">
      <svg viewBox={`0 0 ${width} 34`} preserveAspectRatio="none" role="img" aria-label="Objednávky po dnech">
        {days.map((day, i) => {
          const height = (value(day) / top) * 30;
          const weekend = [0, 6].includes(new Date(`${day.day}T12:00:00`).getDay());
          return (
            <rect
              key={day.day}
              x={i * step + gap / 2}
              y={32 - height}
              width={step - gap}
              height={Math.max(value(day) > 0 ? 0.8 : 0, height)}
              rx={0.6}
              className={weekend ? 'dg-bar weekend' : 'dg-bar'}
            >
              <title>
                {`${dayLabel(day.day)} — ${day.orders} objednávek, ${money(day.revenue, currency)}`}
              </title>
            </rect>
          );
        })}
      </svg>
      <div className="dg-chart-x">
        <span>{dayLabel(days[0]?.day ?? '')}</span>
        <span>{dayLabel(days[Math.floor(days.length / 2)]?.day ?? '')}</span>
        <span>dnes</span>
      </div>
    </div>
  );
}

/** Řez daty jako proužky — země, doprava, platba, zboží */
function Bars({ title, icon, rows, currency, empty }: {
  title: string; icon: string; rows: DigestSlice[]; currency: string; empty: string;
}) {
  const top = Math.max(1, ...rows.map(one => one.orders));
  return (
    <div className="dg-card">
      <div className="dg-card-head"><Icon name={icon} size={14} /> {title}</div>
      {rows.length === 0 && <div className="dg-empty">{empty}</div>}
      {rows.slice(0, 6).map(one => (
        <div className="dg-bar-row" key={one.key} title={`${one.label}: ${money(one.revenue, currency)}`}>
          <span className="dg-bar-label">{one.label}</span>
          <span className="dg-bar-track"><span className="dg-bar-fill" style={{ width: `${(one.orders / top) * 100}%` }} /></span>
          <span className="dg-bar-num">{one.orders}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Měsíce za poslední rok.
 *
 * Bez tohohle je „113 objednávek" číslo bez váhy — v lednu je to hodně,
 * v prosinci málo. Rozdělaný měsíc je světlejší, ať se nesrovnává celý
 * s půlkou.
 */
function MonthChart({ months, currency }: { months: DigestMonth[]; currency: string }) {
  const top = Math.max(1, ...months.map(one => one.orders));
  const width = 100;
  const step = width / Math.max(1, months.length);

  return (
    <div className="dg-chart">
      <svg viewBox={`0 0 ${width} 34`} preserveAspectRatio="none" role="img" aria-label="Objednávky po měsících">
        {months.map((one, i) => {
          const height = (one.orders / top) * 30;
          return (
            <rect
              key={one.month}
              x={i * step + 0.6}
              y={32 - height}
              width={step - 1.2}
              height={Math.max(one.orders > 0 ? 0.8 : 0, height)}
              rx={0.6}
              className={one.complete ? 'dg-bar' : 'dg-bar weekend'}
            >
              <title>
                {`${one.month} — ${one.orders} objednávek, ${money(one.revenue, one.currency || currency)}`}
                {one.complete ? '' : ' (měsíc ještě běží)'}
              </title>
            </rect>
          );
        })}
      </svg>
      <div className="dg-chart-x">
        <span>{months[0]?.month ?? ''}</span>
        <span>{months[months.length - 1]?.month ?? ''}</span>
      </div>
    </div>
  );
}

/* ---------- okno ---------- */

interface Props {
  onClose: () => void;
  /** Skok do zprávy, které se položka týká */
  onOpenMessage?: (id: number) => void;
  /** Skok do konverzace v chatu */
  onOpenChat?: (id: string) => void;
}

export default function DigestModal({ onClose, onOpenMessage, onOpenChat }: Props) {
  const phone = useIsPhone();
  const toast = useToast();
  const [report, setReport] = useState<DigestReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'orders' | 'revenue'>('orders');
  const [turns, setTurns] = useState<DigestTurn[]>([]);
  /*
   * Starší přehledy. Postřeh se nedá spočítat znovu — vznikl nad čísly,
   * která platila tehdy — tak se drží půl roku zpátky a dá se v nich listovat.
   */
  const [archive, setArchive] = useState<DigestArchiveRow[]>([]);
  const [showing, setShowing] = useState<string | null>(null);
  const [older, setOlder] = useState<{ at: string; facts: DigestFacts; insight: DigestInsight } | null>(null);
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const talkEnd = useRef<HTMLDivElement | null>(null);

  const load = (force: boolean) => {
    setBusy(true);
    setError(null);
    api.ai.digest(force)
      .then(setReport)
      .catch(e => setError(e.message))
      .finally(() => setBusy(false));
  };
  useEffect(() => { load(false); }, []);
  useEffect(() => { api.ai.digestArchive().then(setArchive).catch(() => {}); }, [report]);

  // Přepnutí na starší přehled: čísla i postřeh se berou tak, jak byly tehdy
  useEffect(() => {
    if (!showing) { setOlder(null); return; }
    let alive = true;
    api.ai.digestOld(showing).then(one => { if (alive) setOlder(one); }).catch(() => {});
    return () => { alive = false; };
  }, [showing]);

  // Starší přehled má vlastní čísla; bez výběru platí ta dnešní
  const facts = (showing && older?.facts?.window ? older.facts : report?.facts);
  const insight = showing ? (older?.insight ?? null) : (report?.insight ?? null);
  const currency = facts?.currency ?? 'CZK';

  const windowDelta = useMemo(() => {
    if (!facts) return null;
    const now = facts.window.revenue.find(one => one.currency === facts.currency)?.amount ?? 0;
    const before = facts.prevWindow.revenue.find(one => one.currency === facts.currency)?.amount ?? 0;
    return delta(now, before);
  }, [facts]);

  const ask = async (text: string) => {
    const asked = text.trim();
    if (!asked || asking) return;
    const history = [...turns, { role: 'user' as const, text: asked }];
    setTurns(history);
    setQuestion('');
    setAsking(true);
    try {
      const answer = await api.ai.digestAsk(asked, turns);
      setTurns([...history, { role: 'ai', text: answer }]);
    } catch (e: any) {
      setTurns([...history, { role: 'ai', text: `Nepovedlo se odpovědět: ${e.message}` }]);
    } finally {
      setAsking(false);
      window.setTimeout(() => talkEnd.current?.scrollIntoView({ behavior: 'smooth' }), 50);
    }
  };

  const openTask = (task: DigestTask) => {
    if (task.kind === 'mail') { onOpenMessage?.(Number(task.id)); onClose(); return; }
    onOpenChat?.(task.id);
    onClose();
  };

  return (
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal dg-modal" style={{ width: phone ? '100vw' : 'min(1040px, 96vw)' }}>
        <div className="modal-head">
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon name="sunrise" size={18} /> AI Přehled
            {showing && (
              <span className="dg-when">
                {new Date(showing).toLocaleDateString('cs-CZ', { dateStyle: 'long' })}
              </span>
            )}
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {/*
              * Listování zpátky. Starší přehledy se drží půl roku — postřeh
              * se nedá spočítat znovu, protože vznikl nad čísly, která
              * platila tehdy.
              */}
            {archive.length > 1 && (
              <select
                className="dg-pick"
                value={showing ?? ''}
                onChange={e => setShowing(e.target.value || null)}
                title="Starší přehledy"
              >
                <option value="">Dnešní přehled</option>
                {archive.map(one => (
                  <option key={one.at} value={one.at}>
                    {new Date(one.at).toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric', year: '2-digit' })}
                    {one.orders != null ? ` · ${one.orders} obj.` : ''}
                  </option>
                ))}
              </select>
            )}
            {/* PDF ukládá počítač — na telefonu není kam */}
            {!phone && (
              <button
                className="icon-btn"
                data-tip="Uložit přehled do PDF"
                onClick={() => {
                  api.ai.digestPdf(showing ?? undefined)
                    .then(file => { if (file) toast(`Uloženo do ${file}`); })
                    .catch(e => toast(`PDF se nepovedlo: ${e.message}`, 'error'));
                }}
              >
                <Icon name="printer" size={15} />
              </button>
            )}
            {/*
              * Kolečko v hlavičce jen přepočítá čísla — ta jsou z databáze
              * a nic nestojí. Nové postřehy dělá výhradně tlačítko
              * „Přegenerovat" u nich, aby zvědavé kliknutí nestálo volání AI.
              */}
            <button
              className="icon-btn"
              data-tip="Přepočítat čísla"
              disabled={busy}
              onClick={() => load(false)}
            >
              <Icon name="refresh" size={15} />
            </button>
            <button className="icon-btn" data-tip="Zavřít" onClick={onClose}><Icon name="x" size={15} /></button>
          </span>
        </div>

        <div className="modal-body dg-body">
          {!report && !error && (
            <div className="empty-state" style={{ padding: '40px 20px' }}>
              <span className="spinner-inline" /> Skládám přehled…
            </div>
          )}
          {error && <div className="pp-empty">Přehled se nepodařilo sestavit: {error}</div>}

          {report && facts && (
            <>
              {/* Dlaždice: dnešek proti včerejšku a měsíc proti minulému */}
              <div className="dg-tiles">
                <div className="dg-tile">
                  <span className="dg-tile-label">Dnes</span>
                  <span className="dg-tile-value">{facts.today.orders}</span>
                  <span className="dg-tile-sub">
                    {moneyOf(facts.today, currency)}
                    {facts.today.cancelled > 0 && <> · {facts.today.cancelled}× storno</>}
                  </span>
                </div>
                <div className="dg-tile">
                  <span className="dg-tile-label">Včera</span>
                  <span className="dg-tile-value">{facts.yesterday.orders}</span>
                  <span className={`dg-tile-sub tone-${delta(facts.today.orders, facts.yesterday.orders).tone}`}>
                    dnes {delta(facts.today.orders, facts.yesterday.orders).text}
                  </span>
                </div>
                {/*
                  * Hlavní číslo je klouzavých třicet dní, ne kalendářní měsíc:
                  * prvního v měsíci by se srovnával jeden den s jedním dnem
                  * a vycházely by z toho nesmysly. Měsíc je pod grafem jako údaj.
                  */}
                <div className="dg-tile">
                  <span className="dg-tile-label">Posledních 30 dní</span>
                  <span className="dg-tile-value">{facts.window.orders}</span>
                  <span className={`dg-tile-sub tone-${windowDelta?.tone ?? 'flat'}`}>
                    {moneyOf(facts.window, currency)} · {windowDelta?.text} proti předchozím 30
                  </span>
                </div>
                <div className="dg-tile">
                  <span className="dg-tile-label">Průměrná objednávka</span>
                  <span className="dg-tile-value">{money(facts.average, currency)}</span>
                  <span className="dg-tile-sub">
                    {facts.returning}× stálý zákazník
                    {facts.window.unpaid > 0 && <> · {facts.window.unpaid} nezaplacených</>}
                  </span>
                </div>
              </div>

              {/* Co čeká na vyřízení. Nahoře schválně: je to jediná část, kde
                  se něco dělá — zbytek je na dívání. */}
              <div className="dg-card">
                <div className="dg-card-head">
                  <Icon name="inbox" size={14} /> Čeká na vyřízení
                  <span className="dg-count">{report.tasks.length}</span>
                </div>
                {report.tasks.length === 0 && (
                  <div className="dg-empty">Nic nečeká — všechno je zodpovězené. 🎉</div>
                )}
                {report.tasks.map(task => (
                  <button
                    key={`${task.kind}:${task.id}`}
                    className={`dg-task${task.urgent ? ' urgent' : ''}`}
                    onClick={() => openTask(task)}
                    title="Otevřít"
                  >
                    <Icon name={task.kind === 'chat' ? 'chat' : task.urgent ? 'alert' : 'mail'} size={14} />
                    <span className="dg-task-main">
                      <b>{task.who}</b>
                      <span className="dg-task-what">{task.subject || task.preview}</span>
                    </span>
                    <span className="dg-task-when">{since(task.at)}</span>
                    <Icon name="chevRight" size={14} />
                  </button>
                ))}
                {report.chatError && (
                  <div className="dg-empty">Chat se nepodařilo načíst: {report.chatError}</div>
                )}
              </div>

              {/*
                * Co spočítal kód. Není to od AI a schválně to stojí zvlášť:
                * pod každou větou je vidět, z čeho vznikla, takže se to dá
                * ověřit očima na grafu vedle.
                */}
              {facts.signals.length > 0 && (
                <div className="dg-card">
                  <div className="dg-card-head">
                    <Icon name="sliders" size={14} /> Čísla, co stojí za pozornost
                    <span className="dg-when">spočítáno z feedu</span>
                  </div>
                  {facts.signals.map((one, i) => (
                    <p className={`dg-note sig-${one.kind}`} key={i}>
                      <Icon
                        name={one.kind === 'up' ? 'zap' : one.kind === 'down' ? 'chevDown' : one.kind === 'watch' ? 'alert' : 'eye'}
                        size={13}
                      />
                      <span>
                        {one.text}
                        <span className="dg-basis">{one.basis}</span>
                      </span>
                    </p>
                  ))}
                </div>
              )}

              {/* Graf: počet objednávek, nebo tržba — jedno tlačítko, dvě čtení */}
              <div className="dg-card">
                <div className="dg-card-head">
                  <Icon name="zap" size={14} /> Posledních 30 dní
                  <span className="dg-switch">
                    <button className={mode === 'orders' ? 'on' : ''} onClick={() => setMode('orders')}>objednávky</button>
                    <button className={mode === 'revenue' ? 'on' : ''} onClick={() => setMode('revenue')}>tržba</button>
                  </span>
                </div>
                <DayChart days={facts.days} currency={currency} mode={mode} />
                {/* Kalendářní měsíc zůstává jako údaj — jen se z něj nedělají závěry */}
                <div className="dg-caption">
                  {facts.monthLabel} zatím {facts.month.orders} objednávek za {moneyOf(facts.month, currency)}
                  {' · '}stejná část minulého měsíce {facts.prevMonth.orders} za {moneyOf(facts.prevMonth, currency)}
                </div>
              </div>

              {/*
                * Dlouhodobě. Je to čistě z feedu, bez AI — proto se to dá
                * prohlížet, i když se postřehy ten den negenerovaly.
                */}
              {facts.history.months.length > 1 && (
                <div className="dg-card">
                  <div className="dg-card-head">
                    <Icon name="layers" size={14} /> Dlouhodobě
                    <span className="dg-when">{facts.history.coverage} měsíců ve feedu</span>
                  </div>
                  <MonthChart months={facts.history.months} currency={currency} />
                  <div className="dg-caption">
                    {facts.history.lastYear
                      ? <>Stejných 30 dní loni: {facts.history.lastYear.orders} objednávek
                        {' '}za {money(facts.history.lastYear.revenue, currency)}. </>
                      : <>Na srovnání s loňskem zatím feed nesahá dost daleko. </>}
                    {facts.history.rank && <>Slabších bylo {facts.history.rank.better}
                      {' '}z {facts.history.rank.of} uzavřených měsíců.</>}
                  </div>
                  {facts.history.season && (
                    <p className="dg-note sig-watch">
                      <Icon name="clock" size={13} />
                      <span>
                        {facts.history.season.text}
                        <span className="dg-basis">{facts.history.season.basis}</span>
                      </span>
                    </p>
                  )}
                </div>
              )}

              <div className="dg-grid">
                <Bars title="Země" icon="globe" rows={facts.countries} currency={currency}
                  empty="Feed u objednávek nenese adresu." />
                <Bars title="Doprava" icon="truck" rows={facts.shipments} currency={currency}
                  empty="Ve feedu zatím není doprava." />
                <Bars title="Platba" icon="card" rows={facts.payments} currency={currency}
                  empty="Ve feedu zatím není platba." />
              </div>

              <div className="dg-grid">
                <Bars title="Stavy objednávek" icon="fileText" rows={facts.statuses} currency={currency}
                  empty="Feed stavy nenese." />
                {/*
                  * Velikosti napříč zbožím. Lidé si drží jednu délku bez ohledu
                  * na barvu, takže se podle tohohle skládá sklad — ne podle barev.
                  */}
                <div className="dg-card">
                  <div className="dg-card-head"><Icon name="sliders" size={14} /> Velikosti</div>
                  {facts.sizes.length === 0 && (
                    <div className="dg-empty">Zboží v okně nemá varianty, nebo katalog není stažený.</div>
                  )}
                  {facts.sizes.map(one => {
                    const top = Math.max(1, ...facts.sizes.map(s => s.qty));
                    return (
                      <div className="dg-bar-row" key={one.label}>
                        <span className="dg-bar-label">{one.label}</span>
                        <span className="dg-bar-track">
                          <span className="dg-bar-fill" style={{ width: `${(one.qty / top) * 100}%` }} />
                        </span>
                        <span className="dg-bar-num">{one.qty} ks</span>
                        <span className="dg-bar-money">{one.products}× zboží</span>
                      </div>
                    );
                  })}
                </div>
                {/* Sítě a návštěvnost — obojí jen když je z čeho brát */}
                <div className="dg-card">
                  <div className="dg-card-head"><Icon name="image" size={14} /> Sítě a návštěvnost</div>
                  {facts.social && (
                    <>
                      <div className="dg-line">
                        <b>{facts.social.posts}</b> příspěvků za 30 dní
                        {facts.social.prevPosts > 0 && <> (předtím {facts.social.prevPosts})</>}
                      </div>
                      <div className="dg-line">
                        {facts.social.likes} lajků · {facts.social.comments} komentářů
                      </div>
                      {facts.social.posts > 0 && (
                        <div className="dg-caption">
                          Ve dnech s příspěvkem {facts.social.ordersWithPost} objednávky na den,
                          {' '}bez něj {facts.social.ordersWithout} — souvislost, ne důkaz.
                        </div>
                      )}
                    </>
                  )}
                  {!facts.social && <div className="dg-empty">Instagram není napojený.</div>}
                  {report.ga4 && !report.ga4.error && (
                    <>
                      <div className="dg-line">
                        <b>{report.ga4.window.sessions ?? '—'}</b> návštěv
                        {report.ga4.conversion != null && <> · konverze {report.ga4.conversion} %</>}
                      </div>
                      {report.ga4.sources[0] && (
                        <div className="dg-caption">
                          Nejvíc z „{report.ga4.sources[0].name}" ({report.ga4.sources[0].sessions})
                        </div>
                      )}
                    </>
                  )}
                  {report.ga4?.error && (
                    <div className="dg-empty">Návštěvnost se nepodařilo načíst: {report.ga4.error}</div>
                  )}
                  {!report.ga4 && (
                    <div className="dg-empty">Google Analytics se dá napojit v nastavení.</div>
                  )}
                </div>
              </div>

              {/* Nejprodávanější zboží za posledních 30 dní */}
              <div className="dg-card">
                <div className="dg-card-head"><Icon name="bag" size={14} /> Nejprodávanější — 30 dní</div>
                {facts.products.length === 0 && <div className="dg-empty">Za posledních 30 dní zatím nic neprošlo.</div>}
                {facts.products.map(one => {
                  const top = Math.max(1, ...facts.products.map(p => p.qty));
                  return (
                    <div className="dg-bar-row" key={one.code}>
                      <span className="dg-bar-label" title={one.variants.length
                        ? `${one.code} — ${one.variants.map(v => `${v.label} ${v.qty}×`).join(', ')}`
                        : one.code}>
                        {one.title}
                        {/* Varianty jsou sloučené pod produkt; co se pod ním prodalo, je vidět po najetí */}
                        {one.variants.length > 1 && <span className="dg-sub"> {one.variants.length} velikostí</span>}
                      </span>
                      <span className="dg-bar-track">
                        <span className="dg-bar-fill" style={{ width: `${(one.qty / top) * 100}%` }} />
                      </span>
                      <span className="dg-bar-num">{one.qty} ks</span>
                      {/*
                        * Nula není tržba, ale „nevíme": zboží prodané v jiné měně
                        * se do korunového sloupce nepočítá a u dárků cena chybí.
                        * Vypsaná „0 Kč" vypadala jako chyba ve feedu.
                        */}
                      <span
                        className="dg-bar-money"
                        title={one.estimated
                          ? 'Část tržby dopočítaná z ceníku — feed u položky cenu nenesl'
                          : (one.revenue ? '' : `Tržba jen z objednávek v ${currency}`)}
                      >
                        {one.revenue ? `${one.estimated ? '≈ ' : ''}${money(one.revenue, currency)}` : '—'}
                      </span>
                    </div>
                  );
                })}
              </div>

              {/* Postřehy. Jediná část, která stojí peníze — proto jednou denně. */}
              <div className="dg-card dg-insight">
                <div className="dg-card-head">
                  <Icon name="brain" size={14} /> Postřehy
                  {insight && <span className="dg-when">{since(insight.at)}</span>}
                  <button className="dg-again" disabled={busy} onClick={() => load(true)}>
                    {busy ? 'Počítám…' : 'Přegenerovat'}
                  </button>
                </div>
                {!insight && !report.insightError && (
                  <div className="dg-empty">Postřehy se sestaví při prvním ranním otevření.</div>
                )}
                {report.insightError && (
                  <div className="dg-empty">Nové postřehy se nepovedly: {report.insightError}</div>
                )}
                {insight && (
                  <>
                    <p className="dg-headline">{insight.headline}</p>
                    {insight.followUp && (
                      <p className="dg-follow"><Icon name="clock" size={13} /> {insight.followUp}</p>
                    )}
                    {/*
                      * Pod každým bodem je vidět, o co se opírá. Není to
                      * ozdoba: tvrzení bez čísla se tím pozná na první pohled
                      * a nedá se schovat za sebejistou větu.
                      */}
                    {insight.notes.map((note, i) => (
                      <p className={`dg-note ${note.kind}`} key={i}>
                        <Icon name={note.kind === 'pozor' ? 'alert' : note.kind === 'napad' ? 'sparkles' : 'zap'} size={13} />
                        <span>
                          {note.text}
                          {note.basis && <span className="dg-basis">opřeno o: {note.basis}</span>}
                          {note.check && <span className="dg-basis">zabralo, když: {note.check}</span>}
                        </span>
                      </p>
                    ))}
                    {insight.focus && (
                      <p className="dg-focus">Příště se chce podívat na: {insight.focus}</p>
                    )}
                  </>
                )}
              </div>

              {/* Doptání nad týmiž čísly, která jsou na obrazovce */}
              <div className="dg-card">
                <div className="dg-card-head"><Icon name="chat" size={14} /> Doptat se na čísla</div>
                {turns.length === 0 && (
                  <div className="dg-chips">
                    {(insight?.questions?.length
                      ? insight.questions
                      : ['Co se prodává líp než minulý měsíc?', 'Kde ztrácíme na dopravě?']
                    ).map(one => (
                      <button key={one} className="dg-chip" onClick={() => ask(one)}>{one}</button>
                    ))}
                  </div>
                )}
                {turns.map((turn, i) => (
                  <p className={`dg-turn ${turn.role}`} key={i}>{turn.text}</p>
                ))}
                {asking && <p className="dg-turn ai"><span className="spinner-inline" /> Počítám odpověď…</p>}
                <div ref={talkEnd} />
                <form
                  className="dg-ask"
                  onSubmit={e => { e.preventDefault(); void ask(question); }}
                >
                  <input
                    value={question}
                    onChange={e => setQuestion(e.target.value)}
                    placeholder="Zeptej se na cokoli z těchto čísel…"
                  />
                  <button className="btn primary" disabled={asking || !question.trim()}>Zeptat se</button>
                </form>
              </div>

              <div className="dg-foot">
                {facts.known} objednávek ve feedu
                {facts.feedAt && <> · naposledy staženo {since(facts.feedAt)}</>}
                {report.nextInsightAt && (
                  <> · nové postřehy {new Date(report.nextInsightAt).toLocaleString('cs-CZ',
                    { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' })}</>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
