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

/** Jak se období jmenuje v nadpisech — čísla dní by se špatně četla */
function rangeLabel(days: number): string {
  if (days <= 30) return 'Posledních 30 dní';
  if (days <= 90) return 'Poslední 3 měsíce';
  if (days <= 180) return 'Posledních 6 měsíců';
  if (days <= 365) return 'Poslední rok';
  return 'Poslední 2 roky';
}

/** Proč u zboží není cena — pomlčka sama o sobě mate víc než nula */
function priceHint(source: string, currency: string): string {
  if (source === 'cizí měna') return `Prodalo se jen na jiném trhu — do tržby v ${currency} to nepatří.`;
  return 'Feed u téhle položky cenu nenese a v ceníku ani v jiných objednávkách se nenašla.';
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

/** Popiska bloku v grafu — den, týden od–do, nebo měsíc */
function bucketLabel(day: string, bucketDays: number): string {
  if (bucketDays <= 1) return dayLabel(day);
  if (bucketDays >= 28) {
    const [year, month] = day.split('-');
    return `${MONTH_SHORT[Number(month) - 1] ?? month} ${year.slice(2)}`;
  }
  const from = new Date(`${day}T12:00:00`);
  const to = new Date(from.getTime() + (bucketDays - 1) * 86_400_000);
  return `${from.getDate()}. ${from.getMonth() + 1}. – ${to.getDate()}. ${to.getMonth() + 1}.`;
}

const MONTH_SHORT = ['led', 'úno', 'bře', 'dub', 'kvě', 'čvn', 'čvc', 'srp', 'zář', 'říj', 'lis', 'pro'];
const WEEKDAY_SHORT = ['ne', 'po', 'út', 'st', 'čt', 'pá', 'so'];

/**
 * Sloupcový graf.
 *
 * Kreslí se rovnou do SVG, bez knihovny: jsou to obdélníky a všechno, co by
 * knihovna přidala navíc, by se stejně muselo přebarvovat podle světlého
 * a tmavého motivu.
 *
 * ## Proč tolik práce s popiskami
 *
 * Třicet sloupků vedle sebe vypadá hezky a neřekne nic — nedalo se poznat,
 * který je který den. Proto:
 *
 *  - **pod osou jsou popisky**, ale jen tam, kde se vejdou (u třiceti dnů
 *    každý pátý, u měsíců každý),
 *  - **najetím myší** se sloupec zvýrazní a nad grafem se vypíše celá věta
 *    („čtvrtek 4. 9. — 7 objednávek, 11 430 Kč"); bublina od prohlížeče
 *    se objevovala se zpožděním a v rychlém přejetí se nedala přečíst,
 *  - **víkendy jsou světlejší**, aby se propad po neděli nepletl s propadem
 *    v obchodě.
 */
function DayChart({ days: given, currency, mode, bucketDays = 1 }: {
  days: DigestDay[] | undefined;
  currency: string;
  mode: 'orders' | 'revenue';
  /** Kolik dní je v jednom sloupci — u delších období se shlukuje */
  bucketDays?: number;
}) {
  const days = given ?? [];
  const [hover, setHover] = useState<number | null>(null);
  const value = (day: DigestDay) => (mode === 'orders' ? day.orders : day.revenue);
  const top = Math.max(1, ...days.map(value));
  const width = 100;
  const gap = days.length > 40 ? 0.3 : 0.6;
  const step = width / Math.max(1, days.length);

  // Popisky jen tam, kde se vejdou — jinak se slijí do šedé kaše
  const everyNth = Math.max(1, Math.ceil(days.length / 7));
  const active = hover != null ? days[hover] : null;

  return (
    <div className="dg-chart">
      {/*
        * Řádek nad grafem drží místo i bez najetí, aby graf pod ním
        * neposkakoval sem a tam.
        */}
      <div className={`dg-chart-read${active ? ' on' : ''}`}>
        {active
          ? <>
            <b>{bucketDays <= 1
              ? `${WEEKDAY_SHORT[new Date(`${active.day}T12:00:00`).getDay()]} ${dayLabel(active.day)}`
              : bucketLabel(active.day, bucketDays)}</b>
            {' — '}{active.orders} {active.orders === 1 ? 'objednávka' : 'objednávek'}
            {' · '}{money(active.revenue, currency)}
          </>
          : <span className="dg-chart-hint">najeď myší na sloupec</span>}
      </div>
      <svg
        viewBox={`0 0 ${width} 34`}
        preserveAspectRatio="none"
        role="img"
        aria-label="Objednávky po dnech"
        onMouseLeave={() => setHover(null)}
      >
        {days.map((day, i) => {
          const height = (value(day) / top) * 30;
          const weekend = bucketDays <= 1 && [0, 6].includes(new Date(`${day.day}T12:00:00`).getDay());
          const classes = ['dg-bar'];
          if (weekend) classes.push('weekend');
          if (hover === i) classes.push('on');
          return (
            <g key={day.day} onMouseEnter={() => setHover(i)}>
              {/* Neviditelný pruh přes celou výšku: trefit se dá i do nuly */}
              <rect x={i * step} y={0} width={step} height={34} className="dg-bar-hit" />
              <rect
                x={i * step + gap / 2}
                y={32 - height}
                width={step - gap}
                height={Math.max(value(day) > 0 ? 0.8 : 0, height)}
                rx={0.6}
                className={classes.join(' ')}
              />
            </g>
          );
        })}
      </svg>
      <div className="dg-chart-axis">
        {days.map((day, i) => (
          <span key={day.day} style={{ width: `${step}%` }}>
            {i % everyNth === 0 ? bucketLabel(day.day, bucketDays) : ''}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Řez daty jako proužky — země, doprava, platba, zboží */
function Bars({ title, icon, rows: given, currency, empty }: {
  title: string; icon: string; rows: DigestSlice[] | undefined; currency: string; empty: string;
}) {
  // Starší přehled z archivu některé řezy nemá — prázdno je lepší než pád
  const rows = given ?? [];
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
          {/*
            * Rozpad po najetí myší. „Zásilkovna 44×" je půl odpovědi —
            * jestli se u ní platí kartou nebo dobírkou, rozhoduje o penězích
            * i o práci s balíkem.
            */}
          {one.split && one.split.length > 1 && (
            <span className="dg-pop">
              <b>{one.label}</b> · {money(one.revenue, currency)}
              {one.split.map(part => (
                <span className="dg-pop-row" key={part.label}>
                  {part.label}
                  <b>{part.orders}× ({Math.round((part.orders / one.orders) * 100)} %)</b>
                </span>
              ))}
            </span>
          )}
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
function MonthChart({ months: given, currency }: { months: DigestMonth[] | undefined; currency: string }) {
  const months = given ?? [];
  const [hover, setHover] = useState<number | null>(null);
  const top = Math.max(1, ...months.map(one => one.orders));
  const width = 100;
  const step = width / Math.max(1, months.length);
  const active = hover != null ? months[hover] : null;

  return (
    <div className="dg-chart">
      <div className={`dg-chart-read${active ? ' on' : ''}`}>
        {active
          ? <>
            <b>{bucketLabel(`${active.month}-01`, 30)}</b>
            {' — '}{active.orders} objednávek · {money(active.revenue, active.currency || currency)}
            {active.complete ? '' : ' · měsíc ještě běží'}
          </>
          : <span className="dg-chart-hint">najeď myší na měsíc</span>}
      </div>
      <svg
        viewBox={`0 0 ${width} 34`}
        preserveAspectRatio="none"
        role="img"
        aria-label="Objednávky po měsících"
        onMouseLeave={() => setHover(null)}
      >
        {months.map((one, i) => {
          const height = (one.orders / top) * 30;
          const classes = ['dg-bar'];
          // Rozdělaný měsíc je světlejší, ať se nesrovnává celý s půlkou
          if (!one.complete) classes.push('weekend');
          if (hover === i) classes.push('on');
          return (
            <g key={one.month} onMouseEnter={() => setHover(i)}>
              <rect x={i * step} y={0} width={step} height={34} className="dg-bar-hit" />
              <rect
                x={i * step + 0.6}
                y={32 - height}
                width={step - 1.2}
                height={Math.max(one.orders > 0 ? 0.8 : 0, height)}
                rx={0.6}
                className={classes.join(' ')}
              />
            </g>
          );
        })}
      </svg>
      {/* U dvanácti měsíců se popisky vejdou všechny — a bez nich se nedá
          poznat, který sloupec je prosinec */}
      <div className="dg-chart-axis">
        {months.map(one => (
          <span key={one.month} style={{ width: `${step}%` }}>
            {MONTH_SHORT[Number(one.month.slice(5, 7)) - 1] ?? ''}
          </span>
        ))}
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
  /** Co se počítá: čísla z databáze (hned), nebo postřehy od AI (dlouho) */
  const [busy, setBusy] = useState<'numbers' | 'insight' | null>(null);
  const [mode, setMode] = useState<'orders' | 'revenue'>('orders');
  const [turns, setTurns] = useState<DigestTurn[]>([]);
  /*
   * Starší přehledy. Postřeh se nedá spočítat znovu — vznikl nad čísly,
   * která platila tehdy — tak se drží půl roku zpátky a dá se v nich listovat.
   */
  const [archive, setArchive] = useState<DigestArchiveRow[]>([]);
  const [showing, setShowing] = useState<string | null>(null);
  const [older, setOlder] = useState<{ at: string; facts: DigestFacts; insight: DigestInsight } | null>(null);
  /** Jednotlivé zprávy jsou pod rozbalením — v souhrnu je jen počet */
  const [openTasks, setOpenTasks] = useState(false);
  /*
   * Období, za které se čísla počítají. Třicet dní je denní chod, dva roky
   * odpovídají na jinou otázku — jestli má výrobek stálé místo v sortimentu.
   * Postřehy od AI zůstávají na třicítce, aby měly každý den stejné měřítko.
   */
  const [range, setRange] = useState(30);
  const [ranged, setRanged] = useState<DigestFacts | null>(null);
  const [rangeBusy, setRangeBusy] = useState(false);
  /** Kolik nejprodávanějších ukázat — u dvouletého okna je osm málo */
  const [topCount, setTopCount] = useState(8);
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const talkEnd = useRef<HTMLDivElement | null>(null);

  /*
   * Co se zrovna děje, ne jen „něco se děje". Přepočet čísel je hotový dřív,
   * než se stihne mrknout, kdežto postřehy trvají deset i dvacet vteřin —
   * a po kliknutí na „Přegenerovat" to do teď vypadalo, že se neděje nic.
   */
  const load = (force: boolean) => {
    setBusy(force ? 'insight' : 'numbers');
    setError(null);
    api.ai.digest(force)
      .then(setReport)
      .catch(e => setError(e.message))
      .finally(() => setBusy(null));
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
  /*
   * Čísla, která se ukazují: buď z otevřeného staršího přehledu, nebo
   * z přepnutého období, jinak z dnešního přehledu.
   */
  const facts = (showing && older?.facts?.window ? older.facts : (ranged ?? report?.facts));
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

  /*
   * Přepnutí období nesahá na postřehy: `digest:facts` počítá jen čísla
   * z místní databáze. Třicítka se bere z už načteného přehledu, aby se
   * zbytečně nepočítala dvakrát.
   */
  useEffect(() => {
    if (range === 30) { setRanged(null); return; }
    let alive = true;
    setRangeBusy(true);
    api.ai.digestFacts(range)
      .then(one => { if (alive) setRanged(one); })
      .catch(e => toast(`Období se nepodařilo spočítat: ${e.message}`, 'error'))
      .finally(() => { if (alive) setRangeBusy(false); });
    return () => { alive = false; };
  }, [range, toast]);

  /*
   * Souhrn nemusí přijít — starší hlavní proces ho neposílá a u přehledu
   * z archivu se nepočítá vůbec. Prázdné počty jsou lepší než rozbité okno.
   */
  const pending = report?.pending
    ?? { unshipped: 0, unpaidOld: 0, oldestDays: null, mails: 0, urgentMails: 0, chats: 0 };

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
              className={`icon-btn${busy ? ' spinning' : ''}`}
              data-tip={busy === 'insight' ? 'Sestavuji postřehy…' : 'Přepočítat čísla'}
              disabled={!!busy}
              onClick={() => load(false)}
            >
              <Icon name="refresh" size={15} />
            </button>
            <button className="icon-btn" data-tip="Zavřít" onClick={onClose}><Icon name="x" size={15} /></button>
          </span>
        </div>

        {/* Proužek přes celou šířku: na první pohled je vidět, že se pracuje */}
        {busy && <div className="dg-progress" role="status" aria-label="Pracuji" />}

        <div className="modal-body dg-body">
          {!report && !error && (
            <div className="empty-state" style={{ padding: '40px 20px' }}>
              <span className="spinner-inline" /> Skládám přehled…
            </div>
          )}
          {error && <div className="pp-empty">Přehled se nepodařilo sestavit: {error}</div>}

          {report && facts && (
            <>
              {/*
                * Přepínač období. Čísla se přepočítají z databáze — postřehy
                * od AI zůstávají na třiceti dnech, aby měly každý den stejné
                * měřítko a nestály volání modelu při každém přepnutí.
                */}
              <div className="dg-ranges">
                <span className="dg-switch">
                  {[[30, '30 dní'], [90, '3 měsíce'], [180, '6 měsíců'], [365, '1 rok'], [730, '2 roky']]
                    .map(([days, label]) => (
                      <button
                        key={days}
                        className={range === days ? 'on' : ''}
                        disabled={rangeBusy || !!showing}
                        onClick={() => setRange(Number(days))}
                      >
                        {label}
                      </button>
                    ))}
                </span>
                {rangeBusy && <span className="dg-caption"><span className="spinner-inline" /> počítám…</span>}
                {showing && <span className="dg-caption">u staršího přehledu platí čísla, která k němu patří</span>}
              </div>

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
                  <span className="dg-tile-label">{rangeLabel(range)}</span>
                  <span className="dg-tile-value">{facts.window.orders}</span>
                  <span className={`dg-tile-sub tone-${windowDelta?.tone ?? 'flat'}`}>
                    {moneyOf(facts.window, currency)} · {windowDelta?.text} proti předchozímu období
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
                  <span className="dg-count">{pending.unshipped + report.tasks.length}</span>
                  {report.tasks.length > 0 && (
                    <button className="dg-again" onClick={() => setOpenTasks(!openTasks)}>
                      {openTasks ? 'Sbalit' : 'Rozbalit zprávy'}
                    </button>
                  )}
                </div>
                {/*
                  * Souhrn, ne seznam. Ráno nejde o to, která objednávka je
                  * která — na to je balení — ale jestli něco leží. Jednotlivé
                  * zprávy se dají rozbalit, protože u nich se klikáním
                  * pokračuje v práci.
                  */}
                {pending.unshipped > 0 && (
                  <p className="dg-note sig-watch">
                    <Icon name="bag" size={13} />
                    <span>
                      {pending.unshipped} objednávek zatím není odesláno.
                      <span className="dg-basis">
                        {pending.unpaidOld > 0 && <>{pending.unpaidOld} z nich čeká na platbu déle než tři dny · </>}
                        nejstarší leží {pending.oldestDays ?? 0} dní
                      </span>
                    </span>
                  </p>
                )}
                {pending.mails > 0 && (
                  <p className={`dg-note ${pending.urgentMails > 0 ? 'sig-down' : 'sig-info'}`}>
                    <Icon name="mail" size={13} />
                    <span>
                      {pending.mails} zpráv čeká na odpověď
                      {pending.urgentMails > 0 && <> — {pending.urgentMails} naléhavě</>}.
                      {pending.chats > 0 && (
                        <span className="dg-basis">a {pending.chats} chatů, kde má poslední slovo zákazník</span>
                      )}
                    </span>
                  </p>
                )}
                {report.tasks.length === 0 && pending.unshipped === 0 && (
                  <div className="dg-empty">Nic neleží — všechno je odbavené. 🎉</div>
                )}
                {openTasks && (report.tasks ?? []).map(task => (
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
              {(facts.signals ?? []).length > 0 && (
                <div className="dg-card">
                  <div className="dg-card-head">
                    <Icon name="sliders" size={14} /> Čísla, co stojí za pozornost
                    <span className="dg-when">spočítáno z feedu</span>
                  </div>
                  {(facts.signals ?? []).map((one, i) => (
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
                  <Icon name="zap" size={14} /> {rangeLabel(range)}
                  <span className="dg-switch">
                    <button className={mode === 'orders' ? 'on' : ''} onClick={() => setMode('orders')}>objednávky</button>
                    <button className={mode === 'revenue' ? 'on' : ''} onClick={() => setMode('revenue')}>tržba</button>
                  </span>
                </div>
                <DayChart days={facts.days} currency={currency} mode={mode}
                  bucketDays={range <= 62 ? 1 : range <= 200 ? 7 : 30} />
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
              {(facts.history?.months ?? []).length > 1 && (
                <div className="dg-card">
                  <div className="dg-card-head">
                    <Icon name="layers" size={14} /> Dlouhodobě
                    <span className="dg-when">{facts.history?.coverage ?? 0} měsíců ve feedu</span>
                  </div>
                  <MonthChart months={facts.history?.months} currency={currency} />
                  <div className="dg-caption">
                    {facts.history?.lastYear
                      ? <>Stejných 30 dní loni: {facts.history?.lastYear.orders} objednávek
                        {' '}za {money(facts.history?.lastYear?.revenue ?? 0, currency)}. </>
                      : <>Na srovnání s loňskem zatím feed nesahá dost daleko. </>}
                    {facts.history?.rank && <>Slabších bylo {facts.history?.rank?.better}
                      {' '}z {facts.history?.rank?.of} uzavřených měsíců.</>}
                  </div>
                  {/*
                    * Sezóna. Samotné „prosinec bývá silný" se nedá použít —
                    * proto je u ní i co se v ní prodávalo, dokdy se má začít
                    * a které příspěvky tehdy fungovaly. To všechno je z dat,
                    * ne od AI.
                    */}
                  {facts.history?.season && (
                    <div className="dg-season">
                      <p className="dg-note sig-watch">
                        <Icon name="clock" size={13} />
                        <span>
                          {facts.history.season!.text}
                          <span className="dg-basis">{facts.history.season!.basis}</span>
                        </span>
                      </p>
                      {(facts.history.season!.products ?? []).length > 0 && (
                        <div className="dg-season-list">
                          <span className="dg-caption">Tehdy se prodávalo nejvíc</span>
                          {(facts.history.season!.products ?? []).map(one => (
                            <div className="dg-bar-row" key={one.code}>
                              <span className="dg-bar-label" title={one.code}>{one.title}</span>
                              <span className="dg-bar-num">{one.qty} ks</span>
                            </div>
                          ))}
                        </div>
                      )}
                      {(facts.history.season!.posts ?? []).length > 0 && (
                        <div className="dg-season-list">
                          <span className="dg-caption">
                            Nejúspěšnější příspěvky z toho období (lajky a komentáře jsou z Instagramu)
                          </span>
                          {(facts.history.season!.posts ?? []).map(post => (
                            <a
                              className="dg-post"
                              key={post.at + post.permalink}
                              href={post.permalink || undefined}
                              onClick={e => {
                                e.preventDefault();
                                if (post.permalink) api.shell.openUrl(post.permalink).catch(() => {});
                              }}
                            >
                              <Icon name="image" size={13} />
                              <span className="dg-task-main">
                                <b>{post.caption || 'bez popisku'}</b>
                                <span className="dg-task-what">
                                  {new Date(post.at).toLocaleDateString('cs-CZ')}
                                  {' · '}{post.likes} lajků · {post.comments} komentářů
                                  {post.channels && <> · {post.channels}</>}
                                  {post.marketLabels?.length ? <> · {post.marketLabels.join(', ')}</> : null}
                                </span>
                              </span>
                            </a>
                          ))}
                        </div>
                      )}
                    </div>
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
                  * Velikosti **po kategoriích**. Lidé si drží jednu délku bez
                  * ohledu na barvu, takže se podle tohohle skládá sklad — ale
                  * délka kšand a šířka kravaty se sčítat nedají, proto zvlášť.
                  */}
                <div className="dg-card">
                  <div className="dg-card-head"><Icon name="sliders" size={14} /> Velikosti po kategoriích</div>
                  {(facts.sizes ?? []).length === 0 && (
                    <div className="dg-empty">Zboží v okně nemá varianty, nebo katalog není stažený.</div>
                  )}
                  {(facts.sizes ?? []).map(group => {
                    const top = Math.max(1, ...group.sizes.map(s => s.qty));
                    return (
                      <div key={group.category}>
                        <div className="dg-caption">{group.category} · {group.qty} ks</div>
                        {group.sizes.map(one => (
                          <div className="dg-bar-row" key={one.label}>
                            <span className="dg-bar-label">{one.label}</span>
                            <span className="dg-bar-track">
                              <span className="dg-bar-fill" style={{ width: `${(one.qty / top) * 100}%` }} />
                            </span>
                            <span className="dg-bar-num">{one.qty} ks</span>
                            <span className="dg-bar-money">{one.products}× zboží</span>
                          </div>
                        ))}
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
                      {/*
                        * Dlouhý pohled. Co fungovalo za celou dobu je pro
                        * chystanou kampaň lepší podklad než tenhle měsíc —
                        * a bez tohohle to nebylo nikde vidět.
                        */}
                      {(facts.social.bestEver ?? []).length > 0 && (
                        <div className="dg-season-list">
                          <span className="dg-caption">Nejúspěšnější za celou dobu</span>
                          {(facts.social.bestEver ?? []).map(post => (
                            <a
                              className="dg-post"
                              key={post.at + post.permalink}
                              href={post.permalink || undefined}
                              onClick={e => {
                                e.preventDefault();
                                if (post.permalink) api.shell.openUrl(post.permalink).catch(() => {});
                              }}
                            >
                              <Icon name="image" size={13} />
                              <span className="dg-task-main">
                                <b>{post.caption || 'bez popisku'}</b>
                                <span className="dg-task-what">
                                  {new Date(post.at).toLocaleDateString('cs-CZ')}
                                  {' · '}{post.likes} lajků · {post.comments} komentářů
                                  {post.channels && <> · {post.channels}</>}
                                  {post.marketLabels?.length ? <> · {post.marketLabels.join(', ')}</> : null}
                                </span>
                              </span>
                            </a>
                          ))}
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

              {/* Nejprodávanější zboží za zvolené období */}
              <div className="dg-card">
                <div className="dg-card-head">
                  <Icon name="bag" size={14} /> Nejprodávanější — {rangeLabel(range).toLowerCase()}
                  {/*
                    * Kolik jich ukázat. U dvouletého okna je osm položek
                    * málo na to, aby se z toho dalo něco poznat.
                    */}
                  <span className="dg-switch">
                    {[8, 20, 50].map(count => (
                      <button
                        key={count}
                        className={topCount === count ? 'on' : ''}
                        onClick={() => setTopCount(count)}
                      >
                        {count}
                      </button>
                    ))}
                  </span>
                </div>
                {(facts.products ?? []).length === 0 && <div className="dg-empty">Za tohle období nic neprošlo.</div>}
                {(facts.products ?? []).slice(0, topCount).map(one => {
                  const top = Math.max(1, ...(facts.products ?? []).map(p => p.qty));
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
                        title={one.revenue
                          ? (one.estimated ? `Odhad ceny podle: ${one.priceSource}` : 'Cena z objednávek')
                          : priceHint(one.priceSource, currency)}
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
                  <button className="dg-again" disabled={!!busy} onClick={() => load(true)}>
                    {busy === 'insight' ? 'Sestavuji…' : 'Přegenerovat'}
                  </button>
                </div>
                {/*
                  * Postřehy trvají deset i dvacet vteřin — bez tohohle řádku
                  * to po kliknutí vypadalo, že tlačítko nic neudělalo.
                  */}
                {busy === 'insight' && (
                  <div className="dg-working">
                    <span className="spinner-inline" />
                    Sestavuji postřehy nad čerstvými čísly — chvilku to trvá (10–20 s).
                  </div>
                )}
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
