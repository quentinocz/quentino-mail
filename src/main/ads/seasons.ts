/**
 * Sezóny — kdy se pánské doplňky prodávají víc a jak na to připravit rozpočty.
 *
 * ## Proč
 *
 * Engine návrhů se dívá 30 dní zpátky. Na sezónu tím reaguje pozdě: když
 * před Vánoci začne kampaním docházet rozpočet, návrh přidat přijde až
 * po týdnu klidu a dalším nočním běhu — a nejsilnější dny jsou pryč. Po
 * svátcích je to naopak: rozpočty zůstanou nahoře a kampaně týden
 * přeplácejí prázdný trh.
 *
 * Proto kalendář: události českého a slovenského e-shopu (Valentýn, plesy,
 * svatby, Den otců, Black Friday, Vánoce) a **sezónní index** z vlastních
 * objednávek — o kolik se v daném týdnu roku prodávalo víc nebo míň než
 * v průměrném týdnu. Z obojího se postaví plán: rozpočet ziskových kampaní
 * nahoru po krocích před začátkem, zpátky po konci. Kroky jsou obyčejné
 * naplánované návrhy (jako z poradce) — schvaluje je člověk, ve svůj den.
 *
 * Všechno tady je čisté počítání; data a ukládání dělá index.ts.
 */
import crypto from 'crypto';
import type { AdsConfig, AdsSeasonEvent, AdsProposalKind } from '../../shared/ads';
import type { ChatDraft } from './chat';
import { shiftDay } from './economics';

/* ---------- kalendář ---------- */

interface EventDef {
  id: string;
  name: string;
  /** Kdy začít přidávat, kdy je vrchol a kdy končí (v roce `year`) */
  dates: (year: number) => { start: string; peak: string; end: string };
  /** Odhad navýšení, když historie objednávek nestačí (1,3 = o 30 % víc) */
  fallbackUplift: number;
  note: string;
}

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

/** N-tý den v týdnu (0 = neděle) v měsíci */
function nthWeekday(year: number, month: number, weekday: number, n: number): string {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const day = 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
  return ymd(year, month, day);
}

const EVENTS: EventDef[] = [
  {
    id: 'plesy', name: 'Plesová sezóna', fallbackUplift: 1.2,
    dates: y => ({ start: ymd(y, 1, 5), peak: ymd(y, 1, 31), end: ymd(y, 2, 25) }),
    note: 'Motýlky, kšandy a kapesníčky k obleku. Nejvíc se nakupuje týden až dva před plesem.'
  },
  {
    id: 'valentyn', name: 'Valentýn', fallbackUplift: 1.3,
    dates: y => ({ start: ymd(y, 2, 1), peak: ymd(y, 2, 10), end: ymd(y, 2, 12) }),
    note: 'Dárky pro muže. Po 11. 2. už zásilka do 14. 2. nemusí dojít — rozpočet se pak vrací.'
  },
  {
    id: 'maturity', name: 'Maturity a promoce', fallbackUplift: 1.15,
    dates: y => ({ start: ymd(y, 5, 5), peak: ymd(y, 6, 5), end: ymd(y, 6, 30) }),
    note: 'Oblek na maturitu a promoci — motýlky, kravaty, manžetové knoflíčky.'
  },
  {
    id: 'svatby', name: 'Svatební sezóna', fallbackUplift: 1.2,
    dates: y => ({ start: ymd(y, 4, 20), peak: ymd(y, 6, 20), end: ymd(y, 9, 20) }),
    note: 'Kšandy a motýlky pro ženicha i svědky, často víc kusů do jedné objednávky.'
  },
  {
    id: 'den-otcu', name: 'Den otců', fallbackUplift: 1.25,
    dates: y => {
      const day = nthWeekday(y, 6, 0, 3);
      return { start: shiftDay(day, -12), peak: shiftDay(day, -5), end: shiftDay(day, -3) };
    },
    note: 'Třetí neděle v červnu (v Česku i na Slovensku). Dárek musí dojít — konec tři dny předem.'
  },
  {
    id: 'black-friday', name: 'Black Friday', fallbackUplift: 1.4,
    dates: y => {
      const friday = nthWeekday(y, 11, 5, 4);
      return { start: shiftDay(friday, -7), peak: friday, end: shiftDay(friday, 3) };
    },
    note: 'Čtvrtý pátek v listopadu až Cyber Monday. Lidé srovnávají ceny — pomáhá sleva v reklamě i na webu.'
  },
  {
    id: 'vanoce', name: 'Vánoce', fallbackUplift: 1.6,
    dates: y => ({ start: ymd(y, 11, 28), peak: ymd(y, 12, 12), end: ymd(y, 12, 19) }),
    note: 'Nejsilnější období roku. Po 19. 12. už většina zásilek pod stromeček nedojde — rozpočty dolů.'
  }
];

/** Události, které ještě neskončily, od dneška na rok dopředu */
export function upcomingEvents(today: string): { def: EventDef; year: number; start: string; peak: string; end: string }[] {
  const year = Number(today.slice(0, 4));
  const limit = shiftDay(today, 366);
  const out = [];
  for (const y of [year, year + 1]) {
    for (const def of EVENTS) {
      const d = def.dates(y);
      if (d.end < today || d.start > limit) continue;
      out.push({ def, year: y, ...d });
    }
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

/* ---------- sezónní index z objednávek ---------- */

/** Týden roku 0–52 (den roku / 7) — stačí na porovnání stejného období napříč roky */
export function weekOfYear(day: string): number {
  const d = new Date(`${day}T12:00:00Z`);
  const start = Date.UTC(d.getUTCFullYear(), 0, 1, 12);
  return Math.min(52, Math.floor((d.getTime() - start) / 86_400_000 / 7));
}

export interface SeasonIndex {
  /** 53 čísel: tržba týdne / průměrný týden (1 = běžný týden); null = žádná data */
  index: (number | null)[];
  /** Kolik týdnů dat za tím stojí (kvůli tomu, nakolik se mu dá věřit) */
  weeks: number;
  years: number[];
}

/**
 * Index z denních tržeb. Každý rok se dělí svým průměrem — e-shop roste,
 * a tak by starší roky jinak táhly index dolů. Neúplný rok (letošek,
 * první rok provozu) se počítá jen z týdnů, které má; poslední, rozdělaný
 * týden se vynechává.
 */
export function seasonIndex(daily: Map<string, number>, today: string): SeasonIndex {
  /*
   * Počítá se průměrná tržba na den týdne, ne součet: poslední „týden"
   * roku má jen den dva, a se součtem by vypadal jako propad po Vánocích.
   * Den bez objednávky v datech chybí — počet dní se proto bere z kalendáře
   * mezi první a poslední objednávkou roku, ne z počtu záznamů.
   */
  const byYear = new Map<number, Map<number, { sum: number; days: number }>>();
  const currentWeek = `${today.slice(0, 4)}|${weekOfYear(today)}`;
  const days = [...daily.keys()].filter(d => d < today).sort();
  if (days.length) {
    for (let d = days[0]; d < today; d = shiftDay(d, 1)) {
      const y = Number(d.slice(0, 4));
      const w = weekOfYear(d);
      if (`${y}|${w}` === currentWeek) continue;
      const weeks = byYear.get(y) ?? new Map<number, { sum: number; days: number }>();
      const one = weeks.get(w) ?? { sum: 0, days: 0 };
      one.sum += daily.get(d) ?? 0;
      one.days += 1;
      weeks.set(w, one);
      byYear.set(y, weeks);
    }
  }
  const sums = Array.from({ length: 53 }, () => ({ total: 0, n: 0 }));
  let weeks = 0;
  const used: number[] = [];
  for (const [year, map] of byYear) {
    // Rok s pár týdny by index rozhodil — chce se aspoň čtvrt roku
    if (map.size < 13) continue;
    const all = [...map.values()];
    const mean = all.reduce((s, v) => s + v.sum, 0) / Math.max(1, all.reduce((s, v) => s + v.days, 0));
    if (!(mean > 0)) continue;
    for (const [w, v] of map) {
      sums[w].total += v.sum / v.days / mean;
      sums[w].n += 1;
    }
    used.push(year);
    weeks += map.size;
  }
  // Vyhlazení přes sousední týdny — jedna velká objednávka nedělá sezónu
  const raw = sums.map(s => (s.n ? s.total / s.n : null));
  const index = raw.map((v, i) => {
    if (v == null) return null;
    const near = [raw[i - 1], v, v, raw[i + 1]].filter((x): x is number => x != null);
    return Math.round((near.reduce((s, x) => s + x, 0) / near.length) * 100) / 100;
  });
  return { index, weeks, years: used.sort() };
}

/** Kolikrát víc se v období prodává než v běžném týdnu (průměr indexu týdnů období) */
export function upliftFrom(idx: SeasonIndex, start: string, end: string): number | null {
  if (idx.weeks < 40) return null;
  const from = weekOfYear(start);
  const to = weekOfYear(end);
  const list: number[] = [];
  for (let w = from; w !== (to + 1) % 53; w = (w + 1) % 53) {
    const v = idx.index[w];
    if (v != null) list.push(v);
    if (list.length > 53) break;
  }
  if (!list.length) return null;
  return Math.round((list.reduce((s, v) => s + v, 0) / list.length) * 100) / 100;
}

/** Přehled událostí pro okno (bez plánů — ty doplní index.ts) */
export function eventsView(idx: SeasonIndex, today: string): AdsSeasonEvent[] {
  return upcomingEvents(today).map(e => {
    const history = upliftFrom(idx, e.start, e.end);
    return {
      id: `${e.def.id}-${e.year}`, name: e.def.name, start: e.start, peak: e.peak, end: e.end, note: e.def.note,
      uplift: history ?? e.def.fallbackUplift, fromHistory: history != null, planned: 0, running: e.start <= today
    };
  });
}

/* ---------- plán rozpočtů ---------- */

export interface PlanCampaign {
  system: 'google' | 'sklik' | 'meta';
  id: string;
  account: string;
  market: string;
  name: string;
  status: string;
  budget: number | null;
  budgetId: string;
  budgetShared: boolean;
  /** Za 30 dní */
  pno: number | null;
  targetPno: number | null;
  conversions: number;
}

const kc = (n: number) => `${Math.round(n).toLocaleString('cs-CZ')} Kč`;
const dl = (d: string) => `${Number(d.slice(8, 10))}. ${Number(d.slice(5, 7))}.`;
const hash = (text: string) => crypto.createHash('sha1').update(text).digest('hex').slice(0, 8);

/**
 * Plán pro jednu událost: rozpočty ziskových kampaní nahoru před začátkem
 * a zpátky po konci.
 *
 * - Jen kampaně, které drží cíl (PNO do cíle + 10 %) a mají aspoň pár
 *   konverzí. Prodělávající kampani víc peněz v sezóně jen zvětší ztrátu.
 * - Kroky nejvýš o pojistku (±20 %), po 3–4 dnech, ať se chytré nabízení
 *   stihne srovnat. Nahoru se končí v den začátku události.
 * - Dolů se jde stejně po krocích hned po konci zpátky na výchozí rozpočet.
 * - Navýšení podle sezónního indexu (o kolik víc se loni prodávalo), bez
 *   historie podle odhadu u události; nejvýš 2×.
 */
export function planEvent(
  cfg: AdsConfig, eventId: string, campaigns: PlanCampaign[], idx: SeasonIndex, today: string
): { drafts: ChatDraft[]; notes: string[]; uplift: number } {
  const ev = upcomingEvents(today).find(e => `${e.def.id}-${e.year}` === eventId);
  if (!ev) throw new Error('Tahle událost už proběhla nebo není v kalendáři.');
  const history = upliftFrom(idx, ev.start, ev.end);
  // Rozpočty jsou nastavené na posledních pár týdnů, ne na průměr roku: navýšení se měří proti nim
  const now = upliftFrom(idx, shiftDay(today, -28), shiftDay(today, -1));
  const relative = history != null ? history / (now && now > 0 ? now : 1) : null;
  const uplift = Math.min(2, Math.max(1.05, relative ?? ev.def.fallbackUplift));
  const step = Math.max(0.05, cfg.guards.maxBudgetStep);
  const gap = Math.max(2, Math.min(4, cfg.guards.cooldownDays));
  const drafts: ChatDraft[] = [];
  const notes: string[] = [];
  const why = `Sezónní plán: ${ev.def.name} ${dl(ev.start)}–${dl(ev.end)}, `
    + (history != null ? `v tomhle období se prodává ${Math.round(history * 100)} % průměrného týdne, `
      + `proti posledním 4 týdnům ${Math.round(uplift * 100)} % (z vašich objednávek)`
      : `odhad +${Math.round((uplift - 1) * 100)} % (na vlastní historii zatím málo dat)`);

  let addedDaily = 0;
  for (const c of campaigns) {
    if (c.status !== 'ENABLED' || !c.budget) continue;
    if (c.system === 'meta' && !c.budgetId) { notes.push(`„${c.name}" (Meta) má rozpočty po sadách reklam — v plánu není.`); continue; }
    if (c.budgetShared || !c.budgetId) { notes.push(`„${c.name}" má sdílený rozpočet — v plánu není.`); continue; }
    if (c.pno == null || c.targetPno == null || c.conversions < 3) {
      notes.push(`„${c.name}" má za 30 dní málo prodejů — přidávat se jí nebude.`);
      continue;
    }
    if (c.pno > c.targetPno * 1.1) {
      notes.push(`„${c.name}" teď nedrží cíl (PNO ${Math.round(c.pno * 1000) / 10} % při cíli ${Math.round(c.targetPno * 1000) / 10} %) — v sezóně by prodělala víc.`);
      continue;
    }
    const base = c.budget;
    const target = Math.round(base * uplift);
    const ups: number[] = [];
    for (let b = base; b < target - 1 && ups.length < 5;) {
      b = Math.min(target, Math.round(b * (1 + step)));
      ups.push(b);
    }
    if (!ups.length) continue;
    /*
     * Data kroků nahoru: poslední v den začátku, předchozí po `gap` dnech
     * zpátky. Když je začátek blízko, kroky se nesmrsknou do jednoho dne
     * (to by obešlo pojistku) — jdou den po dni, i kdyby poslední padl
     * až do události.
     */
    let prev = today;
    const upDates = ups.map((_, i) => {
      let d = shiftDay(ev.start, -(ups.length - 1 - i) * gap);
      if (d <= prev) d = shiftDay(prev, 1);
      prev = d;
      return d;
    });
    let from = base;
    ups.forEach((to, i) => {
      drafts.push(step1(c, 'budget-up', eventId, i, upDates[i], from, to, ev.def.name, why));
      from = to;
    });
    // Dolů po konci, stejně velkými kroky
    let i = 0;
    let day = shiftDay(ev.end > prev ? ev.end : prev, 1);
    while (from > base + 1 && i < 6) {
      const to = Math.max(base, Math.round(from * (1 - step)));
      drafts.push(step1(c, 'budget-down', eventId, 10 + i, day, from, to, ev.def.name, why));
      from = to;
      day = shiftDay(day, 2);
      i++;
    }
    addedDaily += target - base;
  }
  if (cfg.guards.monthlyBudget > 0 && addedDaily > 0) {
    notes.push(`Na vrcholu je to o ${kc(addedDaily)} denně víc — zkontroluj měsíční strop ${kc(cfg.guards.monthlyBudget)} v Pojistkách.`);
  }
  return { drafts, notes, uplift };
}

function step1(
  c: PlanCampaign, kind: AdsProposalKind, eventId: string, n: number, date: string,
  from: number, to: number, eventName: string, why: string
): ChatDraft {
  const up = kind === 'budget-up';
  return {
    fingerprint: `${kind}|${c.system}|${c.id}|plan|${eventId}|${n}|${hash(`${date}|${from}|${to}`)}`,
    system: c.system, market: c.market, notBefore: date, kind, targetId: c.id, targetName: c.name,
    title: `${eventName}: ${up ? 'přidat' : 'ubrat'} rozpočet ${c.name} ${kc(from)} → ${kc(to)} denně (od ${dl(date)})`,
    plain: up
      ? `Blíží se ${eventName.toLowerCase()} a lidé nakupují víc. Kampaň „${c.name}" vydělává, tak dostane víc peněz, `
        + `aby jí rozpočet nedocházel v nejsilnějších dnech: ${kc(from)} → ${kc(to)} denně.`
      : `Období „${eventName}" skončilo a poptávka klesá. Rozpočet kampaně „${c.name}" se vrací zpátky: ${kc(from)} → ${kc(to)} denně, `
        + 'ať reklama nepřeplácí prázdný trh.',
    why, impact: 0, confidence: 1,
    ops: [{ kind: 'budget', campaignId: c.id, budgetId: c.budgetId, from, to, account: c.account }]
  };
}
