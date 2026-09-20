import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type {
  DigestArchiveRow, DigestDay, DigestFacts, DigestInsight, DigestMonth, DigestReport,
  DigestMoney, DigestNote, DigestMetric, DigestPost, DigestSlice, DigestTask, DigestTotals, DigestTurn,
  Ga4Deep, Ga4Funnel, Ga4Month, Ga4Slice, Ga4Note, Ga4Notes, ArticleStatsView,
  ShopEvent, ShopEventImpact, ShopEventKind, DigestSeason
} from '@shared/types';
import { api } from '../api';
import { useIsPhone } from '../mobile';
import { useToast } from '../toast';
import Icon from './Icon';
import { inToolWindow } from '../toolwindows';

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
function priceHint(source: string, _currency: string): string {
  if (source === 'jiná měna') return 'Prodalo se jen na jiném trhu — částka je v měně toho trhu.';
  return 'Feed u téhle položky cenu nenese a v ceníku ani v jiných objednávkách se nenašla.';
}

/**
 * Tržba zboží ve všech měnách, ve kterých se prodalo.
 *
 * Kapesníček prodaný jen do zahraničí měl v korunách nulu — a „0 Kč"
 * vypadalo jako cena, i když se prodával za 14 €. Měny se nesčítají,
 * píšou se za sebou; hlavní je vždycky první.
 */
function productMoney(all: DigestMoney[] | undefined, currency: string): string {
  const list = (all ?? []).filter(one => one.amount > 0);
  if (!list.length) return '';
  const main = list.filter(one => one.currency === currency);
  const rest = list.filter(one => one.currency !== currency);
  return [...main, ...rest].map(one => money(one.amount, one.currency)).join(' + ');
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
    /*
     * Bez roku se popisek nekreslí. Když se do grafu dostal měsíc bez roku,
     * vypsalo se pod každým sloupcem „led" — a dvanáct stejných popisků je
     * horší než žádný, protože vypadají jako čísla.
     */
    if (year.length !== 4 || !month) return '';
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

/**
 * Návštěvnost po měsících.
 *
 * Dvě řady v jednom obrázku: sloupce jsou návštěvy, tečkovaná čára nákupy.
 * Samotné návštěvy klamou — měsíc s dvojnásobným provozem a stejným počtem
 * nákupů je špatná zpráva, ne dobrá, a to je vidět, až když jsou vedle sebe.
 */
function TrafficChart({ months, notes = [] }: { months: Ga4Month[]; notes?: Ga4Note[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const top = Math.max(1, ...months.map(one => one.sessions));
  const topBuy = Math.max(1, ...months.map(one => one.purchases));
  const width = 100;
  const step = width / Math.max(1, months.length);
  const active = hover != null ? months[hover] : null;
  const line = months
    .map((one, i) => `${i * step + step / 2},${32 - (one.purchases / topBuy) * 26}`)
    .join(' ');

  return (
    <div className="dg-chart">
      <div className={`dg-chart-read${active ? ' on' : ''}`}>
        {active
          ? <>
            <b>{bucketLabel(`${active.month}-01`, 30)}</b>
            {' — '}{fmt(active.sessions)} návštěv · {fmt(active.users)} uživatelů
            {active.purchases ? ` · ${active.purchases} nákupů` : ''}
            {active.revenue ? ` · ${money(active.revenue, 'CZK')}` : ''}
            {/*
              Meziroční srovnání přímo v popisku. U sezónního zboží je
              „srpen proti červenci" k ničemu — smysl dává jen srpen proti
              loňskému srpnu, a ten je v datech hned, jak je okno delší než rok.
            */}
            {(() => {
              const before = months.find(one => one.month === yearBefore(active.month));
              if (!before || before.sessions < 30) return null;
              const change = Math.round(((active.sessions - before.sessions) / before.sessions) * 100);
              return <span className={`dg-yoy ${change >= 0 ? 'up' : 'down'}`}>
                {' '}{change >= 0 ? '+' : '−'}{Math.abs(change)} % proti loňsku
              </span>;
            })()}
          </>
          : <span className="dg-chart-hint">sloupce = návštěvy, čára = nákupy · najeď na sloupec</span>}
      </div>
      <svg
        viewBox={`0 0 ${width} 34`}
        preserveAspectRatio="none"
        role="img"
        aria-label="Návštěvnost po měsících"
        onMouseLeave={() => setHover(null)}
      >
        {months.map((one, i) => {
          const height = (one.sessions / top) * 26;
          return (
            <g key={one.month} onMouseEnter={() => setHover(i)}>
              <rect x={i * step} y={0} width={step} height={34} className="dg-bar-hit" />
              <rect
                x={i * step + 0.6}
                y={32 - height}
                width={step - 1.2}
                height={Math.max(one.sessions > 0 ? 0.8 : 0, height)}
                rx={0.6}
                className={`dg-bar${hover === i ? ' on' : ''}`}
              />
            </g>
          );
        })}
        {months.length > 1 && (
          <polyline points={line} className="dg-line-buy" vectorEffect="non-scaling-stroke" />
        )}
      </svg>
      <div className="dg-chart-axis">
        {months.map((one, i) => (
          <span key={one.month} style={{ width: `${step}%` }}>
            {months.length <= 14 || i % 2 === 0 ? bucketLabel(`${one.month}-01`, 30) : ''}
          </span>
        ))}
      </div>
      {notes.filter(one => one.where === 'months').map((one, i) => (
        <div className={`dg-note ${kindClass(one.kind)}`} key={i}>
          <Icon name="sparkles" size={12} /> <span>{one.text}</span>
        </div>
      ))}
    </div>
  );
}

/** Tentýž měsíc o rok dřív — „2026-08" → „2025-08" */
function yearBefore(month: string): string {
  const [year, mon] = month.split('-');
  return `${Number(year) - 1}-${mon}`;
}

/**
 * Řez návštěvnosti — kanály, stránky, země.
 *
 * Vedle návštěv je vždycky **konverze a tržba**, protože to je ta otázka:
 * kanál, který přivede tisíc lidí a nic neprodá, není lepší než ten, co
 * přivede sto a prodá. Konverze se ukazuje až od sta návštěv — z pěti se
 * poctivě spočítat nedá a procento z mála mate nejvíc.
 */
function TrafficSlice({ title, icon, rows, note, sales = true, notes = [], where = '' }: {
  title: string; icon: string; rows: Ga4Slice[]; note?: string;
  /** Závěry od AI k téhle sestavě — dvojice „řádek → věta" */
  notes?: Ga4Note[];
  where?: string;
  /*
   * Má u téhle sestavy smysl mluvit o konverzi? U kanálů a vstupních
   * stránek ano. U čtených stránek ne: nákup se připisuje vstupní stránce,
   * takže u článku by pořád svítilo „0 %" a četlo by se to jako „nefunguje",
   * i kdyby ten článek přivedl polovinu objednávek.
   */
  sales?: boolean;
}) {
  const top = Math.max(1, ...rows.map(one => one.sessions));
  const all = rows.reduce((sum, one) => sum + one.sessions, 0);
  // Průměr počítaný jen z řádků, kde má konverze vypovídací hodnotu —
  // jinak by ho jeden řádek se třemi návštěvami stáhl kamkoli
  const measured = rows.filter(one => one.conversion != null);
  const avg = measured.length
    ? measured.reduce((sum, one) => sum + (one.conversion ?? 0), 0) / measured.length
    : null;
  const general = notes.filter(one => one.where === where && !one.row);
  const shown = rows.slice(0, 8);
  const moneyCol = shown.map(one => (sales
    ? `${one.conversion != null ? `${dec(one.conversion)} %` : '—'}`
      + (one.revenue ? ` · ${money(one.revenue, 'CZK')}` : '')
    : `${fmt(one.users)} lidí`));

  return (
    <div className="dg-card" style={{
      '--dg-num': colWidth(shown.map(one => fmt(one.sessions))),
      '--dg-money': colWidth(moneyCol, 6)
    } as CSSProperties}>
      <div className="dg-card-head"><Icon name={icon} size={14} /> {title}</div>
      {note && <div className="dg-caption">{note}</div>}
      {rows.length === 0 && <div className="dg-empty">Zatím není z čeho brát.</div>}
      {shown.map((one, i) => (
        // První dva řádky nemají nahoru kam — jim se bublina otevře dolů
        <div className={`dg-bar-row${i < 2 ? ' dg-top' : ''}`} key={one.name}>
          <span className="dg-bar-label" title={one.name}>{one.name}</span>
          <span className="dg-bar-track">
            <span className="dg-bar-fill" style={{ width: `${(one.sessions / top) * 100}%` }} />
          </span>
          <span className="dg-bar-num">{fmt(one.sessions)}</span>
          <span className="dg-bar-money">
            {sales
              ? <>{one.conversion != null ? `${dec(one.conversion)} %` : '—'}
                {one.revenue ? <span className="dg-bar-rev"> · {money(one.revenue, 'CZK')}</span> : null}</>
              : `${fmt(one.users)} lidí`}
          </span>
          {/*
            Vysvětlení až po najetí. V tabulce zůstávají čísla, ale kdo neví,
            co znamenají, dostane po najetí větu — a když AI našla souvislost,
            i tu. Bublina od prohlížeče na to nestačí: neumí víc řádků ani
            odlišit spočítané od odhadnutého.
          */}
          <span className="dg-pop dg-pop-note">
            <span className="dg-pop-title">{one.name}</span>
            {explainSlice(one, all, avg, sales).map((line, i) => (
              <span className="dg-pop-line" key={i}>{line}</span>
            ))}
            {notes.filter(n => n.where === where && n.row === one.name).map((n, i) => (
              <span className={`dg-pop-ai ${kindClass(n.kind)}`} key={i}>
                <Icon name="sparkles" size={11} /> {n.text}
              </span>
            ))}
          </span>
        </div>
      ))}
      {general.map((n, i) => (
        <div className={`dg-note ${kindClass(n.kind)}`} key={i}>
          <Icon name="sparkles" size={12} /> <span>{n.text}</span>
        </div>
      ))}
    </div>
  );
}

/** Barva podle toho, jestli je to pochvala, problém, nebo námět. */
function kindClass(kind: Ga4Note['kind']): string {
  return kind === 'dobré' ? 'good' : kind === 'slabé' ? 'bad' : 'idea';
}

/** Tisíce s mezerou — 8569 se čte hůř než 8 569 */
function fmt(value: number): string {
  return value.toLocaleString('cs-CZ');
}

/**
 * Šířka číselného sloupce v kartě.
 *
 * Čísla mají v každé kartě vlastní šířku podle té nejdelší hodnoty, která
 * se v ní objeví. Bez toho stačilo jedno dlouhé číslo — „194 600 Kč" mezi
 * čtyřmi trojcifernými — a proužek na tom řádku se odsunul doprava:
 * pruhy v kartě přestaly začínat pod sebou a celá tabulka vypadala křivě.
 *
 * Počítá se ve znacích, protože čísla jsou v tabulkovém řezu (`tabular-nums`)
 * a tam má každá číslice stejnou šířku.
 */
function colWidth(values: (string | number)[], least = 3): string {
  const longest = values.reduce<number>((max, one) => Math.max(max, String(one).length), least);
  return `${longest + 0.5}ch`;
}

/** Desetinná čárka, ne tečka — „2.4 %" je v českém textu překlep */
function dec(value: number): string {
  return value.toLocaleString('cs-CZ', { maximumFractionDigits: 1 });
}

/**
 * Co ten řádek znamená — spočítané, ne odhadnuté.
 *
 * Tohle je ta část, která funguje vždycky, i když AI mlčí nebo se netrefí.
 * Srovnává se s **průměrem téhle sestavy**, ne s cizími čísly z oboru:
 * „konverze 1,8 %" nikomu nic neřekne, „skoro polovina průměru webu" ano.
 */
function explainSlice(
  one: Ga4Slice, allSessions: number, avgConversion: number | null, sales: boolean
): string[] {
  const out: string[] = [];
  const share = allSessions > 0 ? Math.round((one.sessions / allSessions) * 100) : 0;
  out.push(`${fmt(one.sessions)} návštěv (${share} % z téhle tabulky) od ${fmt(one.users)} lidí.`);

  if (!sales) {
    const per = one.users > 0 ? Math.round((one.sessions / one.users) * 10) / 10 : 0;
    out.push(per > 1.4
      ? `Vracejí se sem — na jednoho člověka ${dec(per)} návštěvy.`
      : 'Většina lidí sem přijde jednou.');
    out.push('Nákup se připisuje stránce, kudy člověk přišel, ne téhle — proto tu konverze není.');
    return out;
  }

  if (one.conversion == null) {
    out.push('Na konverzi je to málo dat (počítá se od 100 návštěv), takže z toho zatím nic nedělej.');
    return out;
  }

  out.push(`Nakoupilo ${one.purchases} z nich — to je ${dec(one.conversion)} % návštěv.`);
  if (avgConversion != null && avgConversion > 0) {
    const ratio = one.conversion / avgConversion;
    out.push(ratio >= 1.25
      ? `To je nadprůměr: web má v téhle tabulce průměr ${dec(avgConversion)} %.`
      : ratio <= 0.75
        ? `To je podprůměr: web má v téhle tabulce průměr ${dec(avgConversion)} %.`
        : `Zhruba průměr webu (${dec(avgConversion)} %).`);
  }
  if (one.revenue > 0) {
    out.push(`Přineslo to ${money(one.revenue, 'CZK')}, tedy ${dec(one.perSession ?? 0)} Kč na jednu návštěvu.`);
  } else if (one.sessions >= 100) {
    out.push('Tržba nula — lidi to sem přivede, ale nekoupí. Stojí za to zjistit proč.');
  }
  return out;
}

/**
 * Jak si vedou články.
 *
 * Články se v aplikaci píšou a pak se o nich už nic neví. Přitom otázka
 * „vyplatilo se to psát" má odpověď v Analytics. Rozlišují se dvě čísla,
 * protože se pletou: **čtenost** (kolikrát se článek otevřel, i lidmi, co
 * na webu už byli) a **vstupy** (kolikrát byl článek tou první stránkou).
 * Objednávka se připisuje vstupní stránce, takže mluvit o tom, že článek
 * někoho přivedl, jde jen u vstupů.
 */
function ArticleStats({ view }: { view: ArticleStatsView }) {
  const rows = view.rows.filter(one => one.found).slice(0, 8);
  const top = Math.max(1, ...rows.map(one => one.views));
  return (
    <div className="dg-card" style={{
      '--dg-num': colWidth(rows.map(one => fmt(one.views))),
      '--dg-money': colWidth(rows.map(one => (one.entries ? `${fmt(one.entries)} vstupů` : 'bez vstupů')
        + (one.revenue ? ` · ${money(one.revenue, 'CZK')}` : '')), 8)
    } as CSSProperties}>
      <div className="dg-card-head"><Icon name="fileText" size={14} /> Články</div>
      <div className="dg-caption">
        Čtenost a co z toho bylo — {view.scope}. Vlevo návštěvy článku, vpravo kolik lidí
        přes něj do e-shopu vstoupilo a co nakoupili.
      </div>
      {rows.length === 0 && (
        <div className="dg-empty">
          {view.error
            ? `Statistika článků není: ${view.error}`
            : 'Analytics zatím žádný z článků nezná.'}
        </div>
      )}
      {rows.map((one, i) => (
        <div className={`dg-bar-row${i < 2 ? ' dg-top' : ''}`} key={one.id}>
          <span className="dg-bar-label" title={one.title}>{one.title}</span>
          <span className="dg-bar-track">
            <span className="dg-bar-fill" style={{ width: `${(one.views / top) * 100}%` }} />
          </span>
          <span className="dg-bar-num">{fmt(one.views)}</span>
          <span className="dg-bar-money">
            {one.entries ? `${fmt(one.entries)} vstupů` : 'bez vstupů'}
            {one.revenue ? <span className="dg-bar-rev"> · {money(one.revenue, 'CZK')}</span> : null}
          </span>
          <span className="dg-pop dg-pop-note">
            <span className="dg-pop-title">{one.title}</span>
            <span className="dg-pop-line">{one.path}</span>
            <span className="dg-pop-line">
              {fmt(one.views)} otevření od {fmt(one.readers)} lidí za {view.days} dní.
            </span>
            <span className="dg-pop-line">
              {one.entries === 0
                ? 'Nikdo sem nepřišel zvenčí — čtou ho lidé, kteří už na webu jsou.'
                : `Zvenčí sem přišlo ${fmt(one.entries)} návštěv`
                  + (one.purchases
                    ? `, z toho ${one.purchases} objednávek za ${money(one.revenue, 'CZK')}.`
                    : ' — objednávka z toho ale zatím žádná.')}
            </span>
          </span>
        </div>
      ))}
      {view.missing > 0 && (
        <div className="dg-caption">
          {view.missing} článků Analytics nezná — buď ještě nejsou na webu, nebo je nikdo neotevřel.
        </div>
      )}
    </div>
  );
}

/**
 * Cesta k nákupu.
 *
 * Kolik návštěv skončilo košíkem, kolik pokladnou a kolik nákupem. Samotná
 * konverze řekne jen „málo"; tohle řekne **kde** se lidé ztrácejí — jestli
 * na produktu, nebo až v pokladně, což jsou dvě různé opravy.
 */
function Funnel({ funnel, notes = [] }: { funnel: Ga4Funnel; notes?: Ga4Note[] }) {
  const steps = [
    { label: 'Návštěvy', value: funnel.sessions, what: 'Kolik lidí web otevřelo.' },
    { label: 'Do košíku', value: funnel.addToCarts, what: 'Kolik z nich dalo zboží do košíku.' },
    { label: 'Do pokladny', value: funnel.checkouts, what: 'Kolik se jich pustilo do vyplňování objednávky.' },
    { label: 'Nákup', value: funnel.purchases, what: 'Kolik objednávku opravdu dokončilo.' }
  ];
  const top = Math.max(1, funnel.sessions);
  const general = notes.filter(one => one.where === 'funnel' && !one.row);
  return (
    <div className="dg-card" style={{
      '--dg-num': colWidth(steps.map(one => fmt(one.value))),
      '--dg-money': colWidth(['100 %'], 5)
    } as CSSProperties}>
      <div className="dg-card-head"><Icon name="sliders" size={14} /> Cesta k nákupu</div>
      <div className="dg-caption">Kde se lidé cestou ztrácejí. Najeď na krok a dozvíš se, co s ním.</div>
      {steps.map((step, i) => {
        const before = i > 0 ? steps[i - 1].value : 0;
        const drop = i > 0 && before > 0
          ? Math.round(((before - step.value) / before) * 100)
          : null;
        const keep = i > 0 && before > 0 ? Math.round((step.value / before) * 100) : 100;
        return (
          <div className={`dg-bar-row${i < 2 ? ' dg-top' : ''}`} key={step.label}>
            <span className="dg-bar-label">{step.label}</span>
            <span className="dg-bar-track">
              <span className="dg-bar-fill" style={{ width: `${(step.value / top) * 100}%` }} />
            </span>
            <span className="dg-bar-num">{fmt(step.value)}</span>
            {/*
              Do sloupečku patří jedno číslo, ne věta. „−90 % oproti kroku
              výš" se do karty nevešlo a přetékalo přes okraj; co to číslo
              znamená, se dozví ten, kdo na řádek najede.
            */}
            <span className="dg-bar-money">{drop != null ? `−${drop} %` : '100 %'}</span>
            <span className="dg-pop dg-pop-note">
              <span className="dg-pop-title">{step.label}</span>
              <span className="dg-pop-line">{step.what}</span>
              <span className="dg-pop-line">
                {i === 0
                  ? `${fmt(step.value)} návštěv za celé období.`
                  : `Z předchozího kroku (${fmt(before)}) došlo dál ${fmt(step.value)}, tedy ${keep} %. Zbylých ${drop} % odpadlo.`}
              </span>
              {i > 0 && (
                <span className="dg-pop-line">
                  Z celkových návštěv je to {Math.round((step.value / top) * 100)} %.
                </span>
              )}
              {notes.filter(n => n.where === 'funnel' && n.row === step.label).map((n, k) => (
                <span className={`dg-pop-ai ${kindClass(n.kind)}`} key={k}>
                  <Icon name="sparkles" size={11} /> {n.text}
                </span>
              ))}
            </span>
          </div>
        );
      })}
      {general.map((n, i) => (
        <div className={`dg-note ${kindClass(n.kind)}`} key={i}>
          <Icon name="sparkles" size={12} /> <span>{n.text}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Příspěvek ze sítí.
 *
 * Ukazuje se na třech místech (sezóna, nejlepší za půlrok, kandidáti na
 * propagaci) a všude má stejnou podobu: co to bylo, jak si vedl a jestli
 * za tím stál placený dosah. **Nevíme** je vlastní stav — u staršího
 * napojení Instagram propagaci nehlásí a mlčet o tom by znamenalo tvářit
 * se, že příspěvek placený nebyl.
 */
function Post({ post }: { post: DigestPost }) {
  return (
    <a
      className="dg-post"
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
          {post.boosted === true && <> · <b className="dg-paid">propagovaný</b></>}
          {post.boosted === false && <> · bez propagace</>}
        </span>
        {post.why && <span className="dg-basis">{post.why}</span>}
      </span>
    </a>
  );
}

/**
 * Co přijde — tři období vedle sebe.
 *
 * Předtím to byl jeden dlouhý sloupec, ve kterém se sezóny lišily jen
 * tučným jménem; při jedné nalezené sezóně z něj zbyl osamělý odstavec a
 * část „dlouhodobě" vypadala nedodělaně. Tři karty vedle sebe odpovídají
 * na to, na co se kouká: **co je první, jak je to silné a dokdy se má
 * začít**. Zbytek (zboží, příspěvky) je pod tím, protože se čte až potom.
 *
 * Karty jsou tři vždycky, i když žádné období z průměru nevybočuje —
 * slabší se pozná podle indexu a podle toho, že nemá zvýrazněnou hlavičku.
 * Prázdné místo by se četlo jako „nepočítalo se".
 */
function Seasons({ seasons, note }: { seasons: DigestSeason[]; note: string }) {
  if (!seasons.length) {
    return note ? (
      <p className="dg-note sig-eye"><Icon name="clock" size={13} /><span>{note}</span></p>
    ) : null;
  }
  return (
    <>
      {note && <div className="dg-caption">{note}</div>}
      <div className="dg-seasons">
        {seasons.map(season => {
          const strong = season.strong !== false;
          const running = season.inDays === 0;
          /*
           * Proužek pod číslem. Index sám („1,4×") se bez měřítka čte
           * špatně — tohle ukazuje, kde je proti průměrnému měsíci, což je
           * ta jediná hodnota, se kterou se porovnává. Dvojnásobek je strop,
           * aby se silná sezóna nedala splést s mimořádným měsícem.
           */
          const fill = Math.min(100, (season.index / 2) * 100);
          return (
            <div className={`dg-season${strong ? ' strong' : ''}`} key={season.month}>
              <div className="dg-season-head">
                <b>{season.name.charAt(0).toUpperCase()}{season.name.slice(1)}</b>
                {strong && <span className="dg-season-tag">sezóna</span>}
              </div>
              <div className="dg-season-when">
                {running ? 'právě běží' : `za ${season.inDays} dní`} · {season.label}
              </div>
              <div className="dg-season-index" data-tip={season.basis}>
                {season.index.toLocaleString('cs-CZ', { maximumFractionDigits: 1 })}×
                <span className="dg-season-unit">průměrný měsíc</span>
              </div>
              <div className="dg-season-meter" aria-hidden="true">
                <span style={{ width: `${fill}%` }} />
              </div>
              <div className="dg-season-do">
                {running
                  ? 'Běží — držet zásobu toho, co se v ní prodává nejvíc.'
                  : <>Začít do <b>{new Date(season.startBy)
                    .toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric' })}</b>
                    {' '}— tři týdny předem, ať to má náběh a stihne se doskladnit.</>}
              </div>
              {(season.products ?? []).length > 0 && (
                <div className="dg-thumbs season">
                  {(season.products ?? []).slice(0, 3).map(one => (
                    <div className="dg-thumb" key={one.code} data-tip={`${one.title} · ${one.code}`}>
                      {one.image
                        ? <img src={one.image} alt="" loading="lazy" />
                        : <span className="dg-thumb-ph"><Icon name="bag" size={16} /></span>}
                      <span className="dg-thumb-qty">{one.qty} ks</span>
                    </div>
                  ))}
                </div>
              )}
              {(season.posts ?? []).length > 0 && (
                <div className="dg-season-list">
                  {(season.posts ?? []).slice(0, 1).map(post => (
                    <Post key={post.at + post.permalink} post={post} />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="dg-caption">
        Spočítáno z vlastních objednávek napříč roky — zboží pod kartou je to,
        co se v tom období prodávalo nejvíc, příspěvek ten, který tehdy fungoval.
      </div>
    </>
  );
}

/** Řez daty jako proužky — země, doprava, platba, zboží */
function Bars({ title, icon, rows: given, currency, empty }: {
  title: string; icon: string; rows: DigestSlice[] | undefined; currency: string; empty: string;
}) {
  // Starší přehled z archivu některé řezy nemá — prázdno je lepší než pád
  const rows = given ?? [];
  const top = Math.max(1, ...rows.map(one => one.orders));
  const shown = rows.slice(0, 6);
  return (
    <div className="dg-card" style={{ '--dg-num': colWidth(shown.map(one => one.orders)) } as CSSProperties}>
      <div className="dg-card-head"><Icon name={icon} size={14} /> {title}</div>
      {rows.length === 0 && <div className="dg-empty">{empty}</div>}
      {shown.map((one, i) => (
        <div className={`dg-bar-row${i < 2 ? ' dg-top' : ''}`} key={one.key}
          title={`${one.label}: ${money(one.revenue, currency)}`}>
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
      {/* Zbytek se nezahazuje, jen se nekreslí — karty vedle sebe mají mít
          podobnou výšku, jinak vznikají ty díry mezi nimi */}
      {rows.length > shown.length && (
        <div className="dg-caption">a dalších {rows.length - shown.length} s menším podílem</div>
      )}
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

/*
 * Starší přehled se ukládal jen jako hrst souhrnů. Okno ale sahá na
 * včerejšek, na graf dnů i na signály — a na chybějící hodnotě spadlo celé
 * vykreslení, takže po přepnutí zůstalo jen šedé okno. Nové přehledy se
 * ukládají celé; tenhle doplněk drží při životě ty, které se uložily dřív.
 */
const NIC: DigestTotals = { orders: 0, cancelled: 0, unpaid: 0, revenue: [], items: 0 };

function safeFacts(one: any): DigestFacts {
  const totals = (value: any): DigestTotals =>
    value && typeof value === 'object' ? { ...NIC, ...value } : { ...NIC };
  const list = (value: any): any[] => (Array.isArray(value) ? value : []);
  // Zboží ze starého archivu nemá varianty ani původ ceny — okno je čte obojí
  const products = list(one?.products).map((item: any) => ({
    code: item?.code ?? '',
    title: item?.title ?? '',
    qty: item?.qty ?? 0,
    orders: item?.orders ?? 0,
    revenue: item?.revenue ?? 0,
    estimated: item?.estimated ?? false,
    priceSource: item?.priceSource ?? 'feed',
    variants: list(item?.variants),
    // Starší archiv zná jen korunovou tržbu — ať se má co ukázat
    revenueAll: Array.isArray(item?.revenueAll) && item.revenueAll.length
      ? item.revenueAll
      : (item?.revenue > 0 ? [{ currency: one?.currency ?? 'CZK', amount: item.revenue }] : [])
  }));
  const slice = (value: any): any[] => list(value).map((row: any) => ({
    key: row?.key ?? '',
    label: row?.label ?? row?.key ?? '',
    orders: row?.orders ?? 0,
    revenue: row?.revenue ?? 0,
    split: Array.isArray(row?.split) ? row.split : undefined
  }));
  return {
    currency: one?.currency ?? 'CZK',
    today: totals(one?.today),
    yesterday: totals(one?.yesterday),
    window: totals(one?.window),
    prevWindow: totals(one?.prevWindow),
    month: totals(one?.month),
    prevMonth: totals(one?.prevMonth),
    monthLabel: one?.monthLabel ?? '',
    monthDays: one?.monthDays ?? 0,
    days: list(one?.days).map((day: any) => ({
      day: day?.day ?? '', orders: day?.orders ?? 0, revenue: day?.revenue ?? 0
    })),
    countries: slice(one?.countries),
    shipments: slice(one?.shipments),
    payments: slice(one?.payments),
    products,
    returning: one?.returning ?? 0,
    average: one?.average ?? 0,
    signals: list(one?.signals),
    statuses: slice(one?.statuses),
    purchases: one?.purchases ?? 0,
    duplicates: one?.duplicates ?? 0,
    sizes: list(one?.sizes).map((group: any) => ({
      category: group?.category ?? '',
      qty: group?.qty ?? 0,
      sizes: list(group?.sizes).map((row: any) => ({
        label: row?.label ?? '', qty: row?.qty ?? 0, products: row?.products ?? 0
      }))
    })),
    history: {
      months: list(one?.history?.months),
      coverage: one?.history?.coverage ?? 0,
      lastYear: one?.history?.lastYear ?? null,
      rank: one?.history?.rank ?? null,
      season: one?.history?.season ?? null,
      seasons: list(one?.history?.seasons),
      seasonNote: one?.history?.seasonNote ?? ''
    },
    social: one?.social
      ? {
          posts: one.social.posts ?? 0,
          likes: one.social.likes ?? 0,
          comments: one.social.comments ?? 0,
          best: one.social.best ?? null,
          daysWithPost: one.social.daysWithPost ?? 0,
          ordersWithPost: one.social.ordersWithPost ?? 0,
          ordersWithout: one.social.ordersWithout ?? 0,
          prevPosts: one.social.prevPosts ?? 0,
          bestEver: list(one.social.bestEver)
        }
      : null,
    feedAt: one?.feedAt ?? null,
    known: one?.known ?? 0
  };
}

/**
 * Dlaždice s jedním číslem.
 *
 * Pravidlo je jednoduché: **jedno číslo, na první pohled**. Všechno ostatní
 * je buď jednou krátkou větou pod ním, nebo po najetí myší. Dřív měla každá
 * dlaždice pod číslem dva až tři údaje drobným písmem — dohromady dvanáct
 * čísel, ve kterých se to hlavní ztratilo.
 *
 * `note` je postřeh od AI, který se té metriky týká. Ukáže se jako jiskra
 * u čísla a text visí v bublině — u čísla, kterého se týká, je k něčemu;
 * v seznamu postřehů si ho k němu musí každý přiřadit sám.
 *
 * `watch` říká, že tohle číslo si žádá pozornost: dlaždice dostane barevnou
 * hranu a u popisku tečku. Bez toho vypadalo všech dvanáct čísel stejně a
 * jediný způsob, jak poznat, které z nich je dnes to důležité, bylo přečíst
 * všechny komentáře pod sebou — což nikdo nedělá.
 */
function Tile({ label, value, sub, tone, tip, note, watch }: {
  label: string;
  value: string | number;
  sub?: string;
  tone?: 'up' | 'down' | 'flat';
  /** Upřesnění po najetí myší — čísla, ze kterých se to skládá */
  tip?: string;
  note?: DigestNote | null;
  /** `alert` = něco je špatně, `good` = mimořádně dobré; proč, říká `watch.why` */
  watch?: { level: 'alert' | 'good'; why: string } | null;
}) {
  /*
   * Upozornění od AI je silnější než spočítaný rozdíl: když model u čísla
   * píše „pozor", je to ono. Bez postřehu rozhoduje výpočet.
   */
  const level = note?.kind === 'pozor' ? 'alert' : watch?.level ?? null;
  const why = note?.kind === 'pozor' ? note.text : watch?.why ?? '';
  return (
    <div className={`dg-tile${level ? ` is-${level}` : ''}`} data-tip={tip || undefined}>
      <span className="dg-tile-label">
        {level && <span className={`dg-dot ${level}`} data-tip={why} aria-label={why} />}
        {label}
        {note && (
          <span className="dg-tile-ai" data-tip={`${note.text}${note.basis ? ` (${note.basis})` : ''}`}>
            <Icon name="sparkles" size={12} />
          </span>
        )}
      </span>
      <span className="dg-tile-value">{value}</span>
      {sub && <span className={`dg-tile-sub${tone ? ` tone-${tone}` : ''}`}>{sub}</span>}
    </div>
  );
}

/** Jak se druh události jmenuje a jakou má barvu. */
const EVENT_KINDS: { id: ShopEventKind; label: string }[] = [
  { id: 'akce', label: 'Akce' },
  { id: 'dovolena', label: 'Dovolená' },
  { id: 'inventura', label: 'Inventura' },
  { id: 'jine', label: 'Jiné' }
];

function czDay(day: string): string {
  if (!day) return '';
  const at = new Date(`${day}T12:00:00`);
  return at.toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric', year: '2-digit' });
}

/**
 * Události, které čísla vysvětlují.
 *
 * Z feedu se pozná, že týden byl slabý — ne proč. Tahle jediná věta je
 * rozdíl mezi „nedělej nic" a „příště zavři obchod jindy". U každé se
 * spočítá, co se v jejích dnech dělo, proti běžnému dni před ní; je to
 * odhad, ne účetnictví, a přesně tak je to i popsané.
 */
function Events({ currency, note, inDialog = false, limit = 8 }: {
  currency: string;
  note?: DigestNote | null;
  /**
   * Otevřeno z hlavičky jako samostatný dialog. Hlavičku kreslí dialog,
   * formulář je rovnou vyklopený — kdo sem klepnul, jde zapisovat.
   */
  inDialog?: boolean;
  limit?: number;
}) {
  const toast = useToast();
  const [rows, setRows] = useState<ShopEventImpact[]>([]);
  const today0 = new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState<Partial<ShopEvent> | null>(
    inDialog ? { kind: 'akce', from: today0, to: today0 } : null
  );

  const load = useCallback(() => {
    api.events.list(currency).then(setRows).catch(() => {});
  }, [currency]);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    if (!form) return;
    try {
      setRows(await api.events.save(form, currency));
      setForm(null);
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const drop = async (id: number) => {
    try { setRows(await api.events.delete(id, currency)); }
    catch (e: any) { toast(e.message, 'error'); }
  };

  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className={inDialog ? 'dg-card plain' : 'dg-card'}>
      <div className="dg-card-head">
        {!inDialog && <><Icon name="clock" size={14} /> Události</>}
        {note && (
          <span className="dg-tile-ai" data-tip={`${note.text}${note.basis ? ` (${note.basis})` : ''}`}>
            <Icon name="sparkles" size={12} />
          </span>
        )}
        <span className="dg-when">akce, dovolená, inventura — vysvětlují čísla</span>
        {/* V dialogu je formulář otevřený pořád — zavírá se celý dialog */}
        {!inDialog && (
          <button className="dg-again" onClick={() => setForm(form ? null : { kind: 'akce', from: today, to: today })}>
            {form ? 'Zavřít' : 'Přidat'}
          </button>
        )}
      </div>

      {form && (
        <div className="dg-ev-form">
          <select value={form.kind ?? 'akce'}
            onChange={e => setForm({ ...form, kind: e.target.value as ShopEventKind })}>
            {EVENT_KINDS.map(one => <option key={one.id} value={one.id}>{one.label}</option>)}
          </select>
          <input type="date" value={form.from ?? ''}
            onChange={e => setForm({ ...form, from: e.target.value, to: form.to || e.target.value })} />
          <span className="dg-caption">až</span>
          <input type="date" value={form.to ?? form.from ?? ''}
            onChange={e => setForm({ ...form, to: e.target.value })} />
          <input className="dg-ev-title" placeholder="Název — ať se za rok pozná, co to bylo"
            value={form.title ?? ''} onChange={e => setForm({ ...form, title: e.target.value })} />
          <input className="dg-ev-note" placeholder="Poznámka (nepovinná)"
            value={form.note ?? ''} onChange={e => setForm({ ...form, note: e.target.value })} />
          <button className="btn primary" onClick={save}>Uložit</button>
        </div>
      )}

      {rows.length === 0 && !form && (
        <div className="dg-empty">
          Zatím nic. Zapiš akci, dovolenou nebo inventuru — příště bude u čísel vidět proč,
          a za rok se dá říct, co která akce přinesla.
        </div>
      )}

      {rows.slice(0, limit).map(one => (
        <div className="dg-ev" key={one.id}>
          <span className={`dg-ev-kind k-${one.kind}`}>{EVENT_KINDS.find(k => k.id === one.kind)?.label}</span>
          <button className="dg-ev-name" onClick={() => setForm(one)} data-tip={one.note || 'Upravit'}>
            {one.title}
          </button>
          {/*
            * Událost z naplánované změny textů na webu. Je vidět, že ji
            * nezaložil člověk — jinak by vypadala jako cizí zápis v jeho
            * seznamu. Přepsat se dá, ale další úprava textu ji srovná
            * zpátky podle toho, co na webu doopravdy stojí.
            */}
          {one.source === 'webtext' && (
            <span className="dg-ev-auto" data-tip="Založeno z naplánované změny textů na webu">
              <Icon name="globe" size={12} />
            </span>
          )}
          <span className="dg-ev-when">
            {czDay(one.from)}{one.to !== one.from ? ` – ${czDay(one.to)}` : ''}
            {one.days > 1 ? ` · ${one.days} dní` : ''}
          </span>
          <span className="dg-ev-money"
            data-tip={one.future
              ? 'Událost je teprve před námi — měřit zatím není co.'
              : one.moneyDiff == null
                ? 'Před událostí není dost objednávek na to, aby šlo říct, co je běžný den.'
                : `${one.orders} objednávek za ${one.days} dní, tedy ${one.perDay} na den.`
                  + ` Běžný den před událostí: ${one.basePerDay}.`
                  + (one.posts ? ` Na sítích v tom období ${one.posts} příspěvků, ${one.likes} lajků.` : '')}>
            {one.future
              ? 'čeká'
              : one.moneyDiff == null
                ? '—'
                : `${one.moneyDiff > 0 ? '+' : ''}${money(one.moneyDiff, one.currency)}`}
          </span>
          <button className="icon-btn" data-tip="Smazat" onClick={() => drop(one.id)}>
            <Icon name="trash" size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}

export default function DigestModal({ onClose, onOpenMessage, onOpenChat }: Props) {
  // Ve vlastním okně nekreslíme ovládání okna — to má okno svoje
  const okno = inToolWindow();
  const phone = useIsPhone();
  const toast = useToast();
  const [report, setReport] = useState<DigestReport | null>(null);
  /**
   * Postřeh, který patří k danému číslu.
   *
   * Model u každého bodu říká, čeho se týká. Bod pověšený u čísla, kterého
   * se týká, je k něčemu hned; tentýž bod v seznamu dole si musí každý
   * k číslu přiřadit sám — a většinou to neudělá.
   */
  const noteFor = (metric: DigestMetric): DigestNote | null =>
    (report?.insight?.notes ?? []).find(one => one.metric === metric) ?? null;

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
  /** Události v dialogu z hlavičky — zapisuje se u čísel, ne až dole v okně */
  const [eventsOpen, setEventsOpen] = useState(false);
  /** Rozkliknuté zboží — pod řádkem se ukáže, kam se prodávalo a jak si vede */
  const [openProduct, setOpenProduct] = useState<string | null>(null);
  /*
   * Hlubší rozbor návštěvnosti. Je to sedm reportů přes síť, takže se drží
   * den a přepočítává na vyžádání; období má vlastní přepínač, protože
   * u sezónního zboží dává smysl dívat se rok i dva zpátky.
   */
  const [deep, setDeep] = useState<Ga4Deep | null>(null);
  /**
   * Závěry k číslům.
   *
   * Načítají se zvlášť od tabulky, protože jdou přes AI a trvají. Tabulka
   * se ukáže hned se spočítaným vysvětlením u každého řádku; věty od AI se
   * do ní doplní, až doběhnou. Kdyby čekaly na sebe, byl by rozbor
   * pomalejší přesně o tu část, která není nutná.
   */
  const [notes, setNotes] = useState<Ga4Notes | null>(null);
  /** Statistika článků — stojí na týchž datech ze stránek, proto vedle rozboru */
  const [artStats, setArtStats] = useState<ArticleStatsView | null>(null);
  const [deepDays, setDeepDays] = useState(365);
  const [deepBusy, setDeepBusy] = useState(false);
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
    /*
     * Přegenerování se vždycky týká **dnešního** přehledu. Když zůstal
     * otevřený starší, nový postřeh se sice spočítal, ale na obrazovce dál
     * visel ten archivní — a vypadalo to, že tlačítko nic nedělá.
     */
    if (force) { setShowing(null); setRanged(null); setRange(30); }
    setBusy(force ? 'insight' : 'numbers');
    setError(null);
    const before = report?.insight?.at ?? '';
    api.ai.digest(force)
      .then(fresh => {
        setReport(fresh);
        // Po dlouhém čekání se musí říct, jak to dopadlo — jinak se nepozná,
        // jestli se ukazuje nový postřeh, nebo pořád ten včerejší
        if (!force) return;
        if (fresh.insightError) toast(`Postřehy se nepovedly: ${fresh.insightError}`, 'error');
        else if (fresh.insight && fresh.insight.at !== before) toast('Postřehy jsou nové');
        else toast('Postřehy zůstaly beze změny — model nic nového nepřidal');
      })
      .catch(e => setError(e.message))
      .finally(() => setBusy(null));
  };
  useEffect(() => { load(false); }, []);
  useEffect(() => { api.ai.digestArchive().then(setArchive).catch(() => {}); }, [report]);

  /*
   * Rozbor návštěvnosti. Na telefonu se nenačítá vůbec — je to tabulka na
   * šířku a sedm volání přes síť; denní snímek tam zůstává.
   */
  useEffect(() => {
    if (phone) return;
    let alive = true;
    setDeepBusy(true);
    setNotes(null);
    api.ga4.deep(deepDays)
      .then(one => {
        if (!alive) return;
        setDeep(one);
        if (one && !one.error && one.months.length > 0) {
          api.ga4.notes(deepDays).then(text => { if (alive) setNotes(text); }).catch(() => {});
          api.articles.stats(deepDays).then(list => { if (alive) setArtStats(list); }).catch(() => {});
        }
      })
      .catch(() => {})
      .finally(() => { if (alive) setDeepBusy(false); });
    return () => { alive = false; };
  }, [deepDays, phone]);

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
  const facts = useMemo(
    () => (showing && older?.facts?.window ? safeFacts(older.facts) : (ranged ?? report?.facts)),
    [showing, older, ranged, report]
  );
  const insight = showing ? (older?.insight ?? null) : (report?.insight ?? null);
  const currency = facts?.currency ?? 'CZK';
  /*
   * Prohlíží se starší přehled? Pak některé části prostě nejsou — dřív se
   * ukládaly jen souhrny. Prázdno se musí vysvětlit jinak než u dnešního
   * přehledu: tam „ve feedu to není", tady „tenkrát se to neukládalo".
   */
  const archived = !!showing;
  const missing = (what: string) =>
    archived ? `Starší přehled ${what} neuchoval.` : `Ve feedu zatím není ${what}.`;

  const windowDelta = useMemo(() => {
    if (!facts) return null;
    const now = facts.window.revenue.find(one => one.currency === facts.currency)?.amount ?? 0;
    const before = facts.prevWindow.revenue.find(one => one.currency === facts.currency)?.amount ?? 0;
    return delta(now, before);
  }, [facts]);

  /*
   * Která čísla si dnes žádají pozornost.
   *
   * Zvýraznit se dá jen to, co se **spočítá** — jinak by hrana svítila u
   * každé dlaždice a přestala by cokoli znamenat. Hranice jsou schválně
   * hrubé: třetina dolů proti včerejšku je den, kdy se stalo něco jiného
   * než náhoda, a pětina dolů za celé období je trend, ne výkyv. Nahoru
   * se hlásí stejně, ale zeleně — dobrá zpráva se taky snadno přehlédne.
   */
  const watchDay = useMemo(() => {
    if (!facts) return null;
    const { orders } = facts.today;
    const before = facts.yesterday.orders;
    // Do odpoledne je dnešek useknutý a proti celému včerejšku prohraje vždycky
    if (before < 5 || new Date().getHours() < 16) return null;
    const pct = Math.round(((orders - before) / before) * 100);
    if (pct <= -33) return { level: 'alert' as const, why: `Dnešek je o ${Math.abs(pct)} % pod včerejškem.` };
    if (pct >= 50) return { level: 'good' as const, why: `Dnešek je o ${pct} % nad včerejškem.` };
    return null;
  }, [facts]);

  const watchWindow = useMemo(() => {
    if (!facts) return null;
    const now = facts.window.orders;
    const before = facts.prevWindow.orders;
    if (before < 10) return null;
    const pct = Math.round(((now - before) / before) * 100);
    if (pct <= -20) return { level: 'alert' as const, why: `Objednávek je o ${Math.abs(pct)} % míň než v předchozím stejně dlouhém období.` };
    if (pct >= 25) return { level: 'good' as const, why: `Objednávek je o ${pct} % víc než v předchozím stejně dlouhém období.` };
    return null;
  }, [facts]);

  /*
   * Pořadí signálů: nejdřív to, co se kazí, pak dobré zprávy, nakonec
   * pozorování. Kód je počítá v pořadí, v jakém je psal — čtyři věty
   * o pozorování před jedinou o propadu znamenaly, že se ta podstatná
   * přečetla poslední, nebo taky ne.
   */
  const signals = useMemo(() => {
    const vaha: Record<string, number> = { down: 0, watch: 1, up: 2, eye: 3, info: 4 };
    return [...(facts?.signals ?? [])]
      .map((one, i) => ({ one, i }))
      .sort((a, b) => (vaha[a.one.kind] ?? 9) - (vaha[b.one.kind] ?? 9) || a.i - b.i)
      .map(row => row.one);
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
            {/*
              * Události hned vedle přepínače přehledů.
              *
              * Karta s nimi je někde uprostřed okna a zapisuje se do ní
              * většinou ve chvíli, kdy se člověk dívá na čísla nahoře —
              * dolů se kvůli tomu rolovalo a zpátky taky. Tady je to jedno
              * klepnutí od čísel, kterých se zápis týká.
              */}
            <button
              className="icon-btn"
              data-tip="Události — akce, dovolená, inventura"
              onClick={() => setEventsOpen(true)}
            >
              <Icon name="clock" size={15} />
            </button>
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
            {/* Ve vlastním okně zavírá rám okna */}
            {!okno && (
              <button className="icon-btn" data-tip="Zavřít" onClick={onClose}><Icon name="x" size={15} /></button>
            )}
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

              {/*
                * Nový přehled se nespouští sám.
                *
                * Dřív se postřehy začaly sestavovat hned po otevření, jakmile
                * byly starší než den — okno se otevřelo, dvacet vteřin se
                * čekalo a teprve pak šlo listovat. Přitom polovina otevření
                * je „co bylo včera". Čísla jsou z databáze a jsou hned,
                * postřehy si člověk vyžádá, až je bude chtít.
                */}
              {!archived && report.insightStale && (
                <div className="dg-newday">
                  <Icon name="sunrise" size={15} />
                  <span>
                    <b>{insight ? 'Dnešní postřehy zatím nejsou' : 'Postřehy se ještě nedělaly'}</b>
                    <span className="dg-caption">
                      {insight
                        ? `Na obrazovce je poslední hotový přehled (${since(insight.at)}). Čísla výš jsou aktuální.`
                        : 'Čísla jsou z databáze a platí; postřehy sestaví AI nad nimi.'}
                    </span>
                  </span>
                  <button className="btn primary" disabled={!!busy} onClick={() => load(true)}>
                    {busy === 'insight' ? 'Sestavuji…' : 'Sestavit dnešní přehled'}
                  </button>
                </div>
              )}

              {/*
                * Dlaždice. Každá nese **jedno** číslo, které se čte na první
                * pohled; podrobnosti visí v bublině po najetí. Dřív měla
                * každá pod sebou dva až tři údaje drobným písmem a hlavní
                * číslo se v nich ztrácelo — dvanáct čísel vedle sebe se
                * nedá přečíst, jedno ano.
                *
                * Včerejšek dostal vlastní dlaždici zbytečně: sám o sobě
                * neříká nic, zajímavý je jen jako srovnání s dneškem — takže
                * je z něj podtitulek. Místo po něm vzala tržba, což je číslo,
                * na které se u e-shopu kouká první.
                */}
              <div className="dg-tiles">
                <Tile
                  label="Dnes"
                  value={facts.today.orders}
                  sub={`včera ${facts.yesterday.orders} · ${delta(facts.today.orders, facts.yesterday.orders).text}`}
                  tone={delta(facts.today.orders, facts.yesterday.orders).tone}
                  tip={`Dnes ${moneyOf(facts.today, currency)}`
                    + (facts.today.cancelled > 0 ? `, z toho ${facts.today.cancelled}× storno` : '')
                    + `. Včera ${facts.yesterday.orders} objednávek za ${moneyOf(facts.yesterday, currency)}.`}
                  note={noteFor('dnes')}
                  watch={watchDay}
                />
                {/*
                  * Hlavní číslo je klouzavých třicet dní, ne kalendářní měsíc:
                  * prvního v měsíci by se srovnával jeden den s jedním dnem
                  * a vycházely by z toho nesmysly. Měsíc je pod grafem jako údaj.
                  */}
                <Tile
                  label={rangeLabel(range)}
                  value={facts.window.orders}
                  sub={`${windowDelta?.text} proti předchozímu období`}
                  tone={windowDelta?.tone}
                  tip={`Předchozí stejně dlouhé období: ${facts.prevWindow.orders} objednávek`
                    + ` za ${moneyOf(facts.prevWindow, currency)}.`
                    + (facts.window.cancelled > 0 ? ` Storno ${facts.window.cancelled}×.` : '')}
                  note={noteFor('okno')}
                  watch={watchWindow}
                />
                <Tile
                  label="Tržba za období"
                  value={moneyOf(facts.window, currency)}
                  sub={facts.window.unpaid > 0
                    ? `${facts.window.unpaid} objednávek zatím nezaplacených`
                    : 'všechno zaplacené'}
                  tone={facts.window.unpaid > 0 ? 'down' : 'up'}
                  tip={`Stornované objednávky se do tržby nepočítají.`
                    + ` Předtím ${moneyOf(facts.prevWindow, currency)}.`
                    + ` Cizí měny se nesčítají — visí za hlavní částkou.`}
                  note={noteFor('okno')}
                  watch={facts.window.unpaid >= 5
                    ? { level: 'alert' as const,
                        why: `${facts.window.unpaid} objednávek čeká na zaplacení — v tržbě výš už započítané jsou.` }
                    : null}
                />
                <Tile
                  label="Průměrná objednávka"
                  value={money(facts.average, currency)}
                  sub={`${facts.returning}× stálý zákazník`}
                  tip={`Průměr z objednávek v ${currency} za zvolené období.`
                    + ` Dvě objednávky téhož člověka do dvou dnů se počítají jako jeden nákup.`}
                  note={noteFor('prumer')}
                />
              </div>

              {/* Co čeká na vyřízení. Nahoře schválně: je to jediná část, kde
                  se něco dělá — zbytek je na dívání. */}
              <div className="dg-card">
                <div className="dg-card-head">
                  <Icon name="inbox" size={14} /> Čeká na vyřízení
                  <span className="dg-count">{pending.unshipped + report.tasks.length}</span>
                  {/* U staršího přehledu je to jediná část, která platí teď, ne tehdy */}
                  {archived && <span className="dg-when">stav teď, ne k datu přehledu</span>}
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
                    {/*
                      * Kolik z nich je varování. Seznam má pět až osm vět a
                      * všechny vypadají stejně vážně — číslo v hlavičce říká
                      * dřív, než se začne číst, jestli je co řešit.
                      */}
                    {signals.filter(one => one.kind === 'down' || one.kind === 'watch').length > 0 && (
                      <span className="dg-count alert">
                        {signals.filter(one => one.kind === 'down' || one.kind === 'watch').length}× pozor
                      </span>
                    )}
                    <span className="dg-when">spočítáno z feedu</span>
                  </div>
                  {signals.map((one, i) => (
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

              {/*
                * Události. Stojí hned pod spočítanými signály schválně: to,
                * co se stalo mimo data (dovolená, akce, inventura), je
                * nejčastější vysvětlení čísel nad tím — a jediné, které do
                * aplikace nedostane nikdo jiný než člověk.
                */}
              {!archived && <Events currency={currency} note={noteFor('udalosti')} />}

              {/* Graf: počet objednávek, nebo tržba — jedno tlačítko, dvě čtení */}
              <div className="dg-card">
                <div className="dg-card-head">
                  <Icon name="zap" size={14} /> {rangeLabel(range)}
                  <span className="dg-switch">
                    <button className={mode === 'orders' ? 'on' : ''} onClick={() => setMode('orders')}>objednávky</button>
                    <button className={mode === 'revenue' ? 'on' : ''} onClick={() => setMode('revenue')}>tržba</button>
                  </span>
                </div>
                {(facts.days ?? []).length > 0 ? (
                  <DayChart days={facts.days} currency={currency} mode={mode}
                    bucketDays={range <= 62 ? 1 : range <= 200 ? 7 : 30} />
                ) : (
                  <div className="dg-empty">
                    {archived
                      ? 'Starší přehled si graf jednotlivých dnů neuchoval — zůstala jen souhrnná čísla.'
                      : 'Za tohle období nejsou žádné dny s objednávkami.'}
                  </div>
                )}
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
                    * Sezóny. Samotné „prosinec bývá silný" se nedá použít —
                    * proto je u každé i co se v ní prodávalo, dokdy se má
                    * začít a které příspěvky tehdy fungovaly. Všechno je
                    * spočítané z feedu, ne od AI.
                    */}
                  <Seasons
                    seasons={facts.history?.seasons
                      ?? (facts.history?.season ? [facts.history.season] : [])}
                    note={facts.history?.seasonNote ?? ''}
                  />
                </div>
              )}

              <div className="dg-grid">
                <Bars title="Země" icon="globe" rows={facts.countries} currency={currency}
                  empty={archived ? 'Starší přehled země neuchoval.' : 'Feed u objednávek nenese adresu.'} />
                <Bars title="Doprava" icon="truck" rows={facts.shipments} currency={currency}
                  empty={missing('dopravu')} />
                <Bars title="Platba" icon="card" rows={facts.payments} currency={currency}
                  empty={missing('platbu')} />
              </div>

              {/*
                * Čtyři karty do třísloupcové mřížky nejdou: v druhé řadě
                * zůstane jedna a vedle ní dvě prázdné třetiny. Ve dvou
                * sloupcích jsou dvě řady po dvou a nic nezbývá.
                */}
              <div className="dg-grid two">
                <Bars title="Stavy objednávek" icon="fileText" rows={facts.statuses} currency={currency}
                  empty={archived ? 'Starší přehled stavy neuchoval.' : 'Feed stavy nenese.'} />
                {/*
                  * Velikosti **po kategoriích**. Lidé si drží jednu délku bez
                  * ohledu na barvu, takže se podle tohohle skládá sklad — ale
                  * délka kšand a šířka kravaty se sčítat nedají, proto zvlášť.
                  */}
                <div className="dg-card" style={{
                  '--dg-num': colWidth((facts.sizes ?? [])
                    .flatMap(group => group.sizes.map(one => `${one.qty} ks`))),
                  '--dg-money': colWidth((facts.sizes ?? [])
                    .flatMap(group => group.sizes.map(one => `u ${one.products} výrobků`)), 8)
                } as CSSProperties}>
                  <div className="dg-card-head"><Icon name="sliders" size={14} /> Velikosti po kategoriích</div>
                  {/*
                    * Poslední sloupec dřív říkal jen „6× zboží" a nikdo
                    * nevěděl, co to znamená. Je to počet **různých výrobků**,
                    * u kterých se ta velikost prodala — velikost, kterou chce
                    * jeden model, je něco jiného než velikost, kterou lidi
                    * kupují napříč sortimentem.
                    */}
                  {(facts.sizes ?? []).length > 0 && (
                    <div className="dg-caption">
                      Vlevo kusy, vpravo u kolika různých výrobků se ta velikost prodala.
                    </div>
                  )}
                  {(facts.sizes ?? []).length === 0 && (
                    <div className="dg-empty">Zboží v okně nemá varianty, nebo katalog není stažený.</div>
                  )}
                  {/*
                    * Dvě kategorie po čtyřech velikostech. Celý seznam měl
                    * i patnáct řádků a karta pak byla dvakrát vyšší než ta
                    * vedle — přesně to dělalo v mřížce ty prázdné plochy.
                    * Co se nevejde, shrne věta pod tím; podle prvních čtyř
                    * velikostí se stejně objednává.
                    */}
                  {(facts.sizes ?? []).slice(0, 2).map(group => {
                    const top = Math.max(1, ...group.sizes.map(s => s.qty));
                    return (
                      <div key={group.category}>
                        <div className="dg-caption">{group.category} · {group.qty} ks</div>
                        {group.sizes.slice(0, 4).map((one, i) => (
                          <div className={`dg-bar-row${i < 2 ? ' dg-top' : ''}`} key={one.label}>
                            <span className="dg-bar-label">{one.label}</span>
                            <span className="dg-bar-track">
                              <span className="dg-bar-fill" style={{ width: `${(one.qty / top) * 100}%` }} />
                            </span>
                            <span className="dg-bar-num">{one.qty} ks</span>
                            <span className="dg-bar-money" title={`Tuhle velikost mělo ${one.products} různých výrobků`}>
                              u {one.products} {one.products === 1 ? 'výrobku' : one.products < 5 ? 'výrobků' : 'výrobků'}
                            </span>
                          </div>
                        ))}
                        {group.sizes.length > 4 && (
                          <div className="dg-caption">a dalších {group.sizes.length - 4} velikostí</div>
                        )}
                      </div>
                    );
                  })}
                  {(facts.sizes ?? []).length > 2 && (
                    <div className="dg-caption">
                      a dalších {(facts.sizes ?? []).length - 2} kategorií — celé rozdělení je v katalogu
                    </div>
                  )}
                </div>
                {/*
                  * Sítě a návštěvnost byly jedna karta a byla nejvyšší ze
                  * všech — sama zabrala celý sloupec a vedle ní zbylo prázdno
                  * až dolů. Jsou to přitom dvě různé věci: co jsme vydali a
                  * kolik lidí přišlo. Rozdělené se poskládají mezi ostatní.
                  */}
                <div className="dg-card">
                  <div className="dg-card-head">
                    <Icon name="image" size={14} /> Sítě
                    {noteFor('site') && (
                      <span className="dg-tile-ai"
                        data-tip={`${noteFor('site')!.text}${noteFor('site')!.basis ? ` (${noteFor('site')!.basis})` : ''}`}>
                        <Icon name="sparkles" size={12} />
                      </span>
                    )}
                  </div>
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
                        * Co si říká o rozpočet. Úspěch placeného příspěvku je
                        * koupený — přidávat peníze má smysl tam, kde už něco
                        * zabralo samo. Proto je tenhle seznam první.
                        */}
                      {(facts.social.candidates ?? []).length > 0 && (
                        <div className="dg-season-list">
                          <span className="dg-caption">
                            Stálo by za propagaci — čerstvé a nadprůměrné bez placeného dosahu
                          </span>
                          {(facts.social.candidates ?? []).map(post => (
                            <Post key={post.at + post.permalink} post={post} />
                          ))}
                        </div>
                      )}
                      {/*
                        * Jeden nejúspěšnější, ne dva. Karta se čtyřmi
                        * příspěvky byla dvakrát vyšší než sousední a vedle
                        * ní zůstávalo prázdno až dolů; pro rozhodnutí
                        * „čím se inspirovat" stačí ten nejlepší.
                        */}
                      {(facts.social.bestEver ?? []).length > 0 && (
                        <div className="dg-season-list">
                          <span className="dg-caption">Nejúspěšnější za poslední půlrok</span>
                          {(facts.social.bestEver ?? []).slice(0, 1).map(post => (
                            <Post key={post.at + post.permalink} post={post} />
                          ))}
                        </div>
                      )}
                      {/*
                        * Starší úspěchy zvlášť a až za tím. Co fungovalo před
                        * dvěma lety, mohlo mít zaplacený dosah nebo docela
                        * jinou nabídku — jako měřítko pro dnešek to neplatí,
                        * jako připomenutí ano.
                        */}
                      {(facts.social.bestOlder ?? []).length > 0 && (
                        <div className="dg-season-list">
                          <span className="dg-caption">
                            Ze starších — jen na připomenutí, měřítko pro dnešek to není
                          </span>
                          {(facts.social.bestOlder ?? []).slice(0, 1).map(post => (
                            <Post key={post.at + post.permalink} post={post} />
                          ))}
                        </div>
                      )}
                      {facts.social.boostKnown === false && (facts.social.posts > 0) && (
                        <div className="dg-caption">
                          Instagram u tohohle napojení nehlásí, které příspěvky byly propagované —
                          {' '}placený dosah se proto od neplaceného odlišit nedá.
                        </div>
                      )}
                    </>
                  )}
                  {!facts.social && <div className="dg-empty">Instagram není napojený.</div>}
                </div>

                <div className="dg-card" style={{
                  '--dg-num': colWidth((report.ga4?.sources ?? []).slice(0, 5)
                    .map(one => fmt(one.sessions)))
                } as CSSProperties}>
                  <div className="dg-card-head">
                    <Icon name="globe" size={14} /> Návštěvnost
                    {noteFor('navstevnost') && (
                      <span className="dg-tile-ai"
                        data-tip={`${noteFor('navstevnost')!.text}${noteFor('navstevnost')!.basis ? ` (${noteFor('navstevnost')!.basis})` : ''}`}>
                        <Icon name="sparkles" size={12} />
                      </span>
                    )}
                    {/*
                      * Čí návštěvy to jsou. GA4 měří zatím jen jeden web,
                      * objednávky chodí ze všech trhů — dělit jedno druhým
                      * dá nesmysl, tak ať je to vidět hned u nadpisu, ne až
                      * pod čísly, kde si toho nikdo nevšiml.
                      */}
                    {report.ga4?.scope && <span className="dg-when">{report.ga4.scope}</span>}
                  </div>
                  {report.ga4 && !report.ga4.error && (
                    <>
                      <div className="dg-line"
                        data-tip={report.ga4.scope
                          ? `Měří ${report.ga4.scope}; objednávky výš jsou ze všech trhů, konverze proto sedí jen na tenhle web.`
                          : undefined}>
                        <b>{report.ga4.window.sessions ?? '—'}</b> návštěv
                        {report.ga4.conversion != null && <> · konverze {report.ga4.conversion} %</>}
                      </div>
                      {/* Pět zdrojů místo tří: karta vedle je vyšší a tohle
                          je právě to, čím se místo smysluplně zaplní */}
                      {report.ga4.sources.slice(0, 5).map((one, i) => (
                        <div className={`dg-bar-row${i < 2 ? ' dg-top' : ''}`} key={one.name}>
                          <span className="dg-bar-label" title={one.name}>{one.name}</span>
                          <span className="dg-bar-track">
                            <span className="dg-bar-fill"
                              style={{ width: `${(one.sessions / Math.max(1, report.ga4!.sources[0].sessions)) * 100}%` }} />
                          </span>
                          <span className="dg-bar-num">{fmt(one.sessions)}</span>
                        </div>
                      ))}
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


              {/*
                * Návštěvnost do hloubky. Denní snímek výš odpovídá na „kolik
                * jich přišlo"; tohle na „odkud, kudy a co z toho bylo" — a dá
                * se dívat dva roky zpátky, což je u sezónního zboží to jediné
                * měřítko, které dává smysl. Na telefonu se to nenačítá.
                */}
              {!phone && (deep || deepBusy) && (
                <div className="dg-card dg-deep">
                  <div className="dg-card-head">
                    <Icon name="globe" size={14} /> Návštěvnost do hloubky
                    <span className="dg-switch">
                      {[90, 180, 365, 730].map(days => (
                        <button
                          key={days}
                          className={deepDays === days ? 'on' : ''}
                          onClick={() => setDeepDays(days)}
                        >
                          {days === 90 ? '3 měsíce' : days === 180 ? '6 měsíců' : days === 365 ? '1 rok' : '2 roky'}
                        </button>
                      ))}
                    </span>
                    <button
                      className="dg-again"
                      disabled={deepBusy}
                      onClick={() => {
                        setDeepBusy(true);
                        setNotes(null);
                        api.ga4.deep(deepDays, true)
                          .then(one => {
                            setDeep(one);
                            toast('Rozbor je čerstvý.');
                            // Čísla jsou nová, takže i závěry k nim musí být nové
                            api.ga4.notes(deepDays, true).then(setNotes).catch(() => {});
                          })
                          .catch(e => toast(`Nepovedlo se: ${e.message}`, 'error'))
                          .finally(() => setDeepBusy(false));
                      }}
                    >
                      {deepBusy ? 'Počítám…' : 'Přepočítat'}
                    </button>
                  </div>
                  {deepBusy && !deep && (
                    <div className="dg-working">
                      <span className="spinner-inline" />
                      Sedm reportů z Google Analytics — chvilku to trvá.
                    </div>
                  )}
                  {deep?.error && (
                    <div className="dg-empty">Rozbor se nepovedl: {deep.error}</div>
                  )}
                  {deep && deep.months.length > 0 && (
                    <>
                      <div className="dg-caption">
                        Měří {deep.scope}; objednávky v přehledu výš jsou ze všech trhů,
                        {' '}takže konverze tady sedí jen na tenhle web.
                      </div>
                      <TrafficChart months={deep.months} notes={notes?.notes ?? []} />
                      {/*
                        Závěr nahoře, tabulky pod ním. Kdo otevře rozbor
                        jednou za měsíc, potřebuje nejdřív větu „co z toho
                        plyne" — čísla si pak dohledá u toho řádku, který ho
                        zaujal.
                      */}
                      {notes?.summary && (
                        <div className="dg-summary">
                          <Icon name="sparkles" size={13} />
                          <span>{notes.summary}</span>
                        </div>
                      )}
                      {!notes && deep.months.length > 0 && (
                        <div className="dg-summary waiting">
                          <span className="spinner-inline" /> Skládám z čísel závěr…
                        </div>
                      )}
                      <div className="dg-grid">
                        <TrafficSlice
                          title="Kanály" icon="globe" rows={deep.channels} where="channels" notes={notes?.notes ?? []}
                          note="Odkud lidé přišli. Vpravo je konverze a tržba — kanál, který přivede lidi, a kanál, který přivede peníze, jsou dvě různé věci."
                        />
                        <Funnel funnel={deep.funnel} notes={notes?.notes ?? []} />
                      </div>
                      <div className="dg-grid">
                        <TrafficSlice
                          title="Vstupní stránky" icon="fileText" rows={deep.landings} where="landings" notes={notes?.notes ?? []}
                          note="Kudy se do e-shopu chodí — sem míří reklama i vyhledávání."
                        />
                        <TrafficSlice
                          title="Nejčtenější stránky" icon="fileText" rows={deep.pages} sales={false}
                          where="pages" notes={notes?.notes ?? []}
                          note="Články, kategorie a produkty podle návštěv. Konverze se tu neukazuje — nákup se připisuje vstupní stránce, ne té, kde se čte."
                        />
                      </div>
                      {artStats && artStats.rows.some(one => one.found) && (
                        <ArticleStats view={artStats} />
                      )}
                      <div className="dg-grid">
                        <TrafficSlice title="Zařízení" icon="sliders" rows={deep.devices}
                          where="devices" notes={notes?.notes ?? []} />
                        <TrafficSlice
                          title="Země návštěvníků" icon="globe" rows={deep.countries}
                          where="countries" notes={notes?.notes ?? []}
                          note="Proti zemím objednávek je vidět, kde se dívají a nekupují."
                        />
                      </div>
                    </>
                  )}
                </div>
              )}

              {/* Nejprodávanější zboží za zvolené období */}
              <div className="dg-card" style={{
                '--dg-num': colWidth((facts.products ?? []).slice(0, topCount)
                  .map(one => `${one.qty} ks`)),
                '--dg-money': colWidth((facts.products ?? []).slice(0, topCount)
                  .map(one => productMoney(one.revenueAll, currency) || '—'), 9)
              } as CSSProperties}>
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
                  const sold = productMoney(one.revenueAll, currency);
                  const open = openProduct === one.code;
                  return (
                    <div
                      className={`dg-bar-row dg-clickable${open ? ' open' : ''}`}
                      key={one.code}
                      onClick={() => setOpenProduct(open ? null : one.code)}
                      title="Klepnutím ukážeš podrobnosti"
                    >
                      {/* Obrázek z katalogu — zboží se pozná dřív očima než čtením */}
                      {one.image
                        ? <img className="dg-row-thumb" src={one.image} alt="" loading="lazy" />
                        : <span className="dg-row-thumb ph"><Icon name="bag" size={13} /></span>}
                      <span className="dg-bar-label" title={one.variants.length
                        ? `${one.code} — ${one.variants.map(v => `${v.label} ${v.qty}×`).join(', ')}`
                        : one.code}>
                        {one.title}
                      </span>
                      {/*
                        * Varianty mají vlastní sloupec. Jako šedý dovětek za
                        * názvem se přehlédly — přitom „prodalo se 110 cm"
                        * je u kšand a pásků ta hlavní informace: podle ní se
                        * objednává sklad.
                        */}
                      <span className="dg-bar-var" title={one.variants.length
                        ? one.variants.map(v => `${v.label} ${v.qty}×`).join(', ')
                        : 'Zboží bez variant'}>
                        {one.variants.slice(0, 2).map(v => (
                          <span className="dg-var-chip" key={v.label}>{v.label} <b>{v.qty}×</b></span>
                        ))}
                        {one.variants.length > 2 && (
                          <span className="dg-var-more">+{one.variants.length - 2}</span>
                        )}
                      </span>
                      <span className="dg-bar-track">
                        <span className="dg-bar-fill" style={{ width: `${(one.qty / top) * 100}%` }} />
                      </span>
                      <span className="dg-bar-num">{one.qty} ks</span>
                      {/*
                        * Tržba ve všech měnách, ve kterých se prodalo. Kapesníček
                        * prodaný jen do zahraničí měl v korunách nulu a „0 Kč"
                        * vypadalo jako cena — přitom se prodával za 14 €.
                        * Pomlčka zůstává jen tam, kde cena vážně není.
                        */}
                      <span
                        className="dg-bar-money"
                        title={sold
                          ? (one.estimated ? `Odhad ceny podle: ${one.priceSource}` : 'Cena z objednávek')
                          : priceHint(one.priceSource, currency)}
                      >
                        {sold ? `${one.estimated ? '≈ ' : ''}${sold}` : '—'}
                      </span>
                      {/*
                        * Drobná statistika pod řádkem. „18 ks" se přečte za
                        * vteřinu a nic z něj nevyplyne; kam se to prodává,
                        * jestli to roste a za kolik — z toho už se dá
                        * rozhodnout o skladu i o tom, který trh podpořit.
                        * Všechno spočítané z týchž objednávek.
                        */}
                      {open && (
                        <div className="dg-drill" onClick={e => e.stopPropagation()}>
                          {one.note && <p className="dg-drill-note">{one.note}</p>}
                          {(one.countries ?? []).length > 0 && (
                            <div className="dg-drill-cols">
                              <span className="dg-caption">Kam se prodávalo</span>
                              {(one.countries ?? []).map(country => (
                                <div className="dg-pop-row" key={country.key}>
                                  <span>{country.label}</span>
                                  <span>{country.qty} ks</span>
                                </div>
                              ))}
                            </div>
                          )}
                          {(one.variants ?? []).length > 0 && (
                            <div className="dg-drill-cols">
                              <span className="dg-caption">Které varianty</span>
                              {(one.variants ?? []).map(variant => (
                                <div className="dg-pop-row" key={variant.label}>
                                  <span>{variant.label}</span>
                                  <span>{variant.qty} ks</span>
                                </div>
                              ))}
                            </div>
                          )}
                          <div className="dg-drill-cols">
                            <span className="dg-caption">Čísla</span>
                            <div className="dg-pop-row"><span>objednávek</span><span>{one.orders}</span></div>
                            <div className="dg-pop-row">
                              <span>předchozí období</span><span>{one.prevQty ?? 0} ks</span>
                            </div>
                            {(one.unit ?? 0) > 0 && (
                              <div className="dg-pop-row">
                                <span>průměrná cena</span><span>{money(one.unit ?? 0, currency)}</span>
                              </div>
                            )}
                            <div className="dg-pop-row">
                              <span>kód</span><span>{one.code}</span>
                            </div>
                          </div>
                        </div>
                      )}
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
                    {busy === 'insight' ? 'Sestavuji…' : report.insightStale ? 'Sestavit dnešní' : 'Přegenerovat'}
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
                  <div className="dg-empty">
                    Zatím žádné. Tlačítkem výš (nebo tímhle) je AI sestaví nad čísly, která jsou na obrazovce.
                  </div>
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
                    {(insight.notes ?? []).map((note, i) => (
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

      {/*
        * Události z hlavičky. Je to tentýž seznam jako karta v přehledu —
        * jen dosažitelný od čísel nahoře, aniž by se kvůli zápisu rolovalo
        * přes celé okno a zpátky.
        */}
      {eventsOpen && (
        <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) setEventsOpen(false); }}>
          <div className="modal" style={{ width: 'min(720px, 94vw)' }}>
            <div className="modal-head">
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Icon name="clock" size={17} /> Události
              </span>
              <button className="icon-btn" data-tip="Zavřít" onClick={() => setEventsOpen(false)}>
                <Icon name="x" size={15} />
              </button>
            </div>
            <div className="modal-body">
              <Events currency={currency} note={noteFor('udalosti')} inDialog limit={40} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
