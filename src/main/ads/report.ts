/**
 * Report Reklam — týden a měsíc.
 *
 * ## Proč zvlášť od přehledu Dnes
 *
 * Dnes je klouzavé okno (posledních 30 dní) — dobré na ranní kontrolu,
 * špatné na otázku „jak dopadl listopad". Report bere **uzavřené**
 * období (pondělí–neděle, kalendářní měsíc) a srovnává ho s předchozím
 * stejným, takže čísla sedí s účetnictvím a dají se poslat dál (PDF).
 *
 * Zjištění pod čísly jsou spočítaná pravidly, ne modelem — u každého je
 * vidět, z jakých čísel plyne. Shrnutí od poradce je volitelné, uloží se
 * k reportu a podruhé se neplatí.
 */
import { getSetting, setSetting } from '../db';
import { ask } from '../ai';
import { getSettings } from '../settings';
import type { AdsReport, AdsFinding, AdsOverview } from '../../shared/ads';
import { MARKET_LABELS } from '../../shared/ads';
import { shiftDay, localDay } from './economics';
import { isAutopilot } from './autopilot';
import { overview, campaigns, products, proposals, AdsRange } from './index';
import { getAdsConfig } from './store';

const MONTHS = ['leden', 'únor', 'březen', 'duben', 'květen', 'červen', 'červenec', 'srpen', 'září', 'říjen', 'listopad', 'prosinec'];
const dl = (d: string) => `${Number(d.slice(8, 10))}. ${Number(d.slice(5, 7))}.`;
const kc = (n: number) => `${Math.round(n).toLocaleString('cs-CZ')} Kč`;
const pct = (n: number) => `${(Math.round(n * 1000) / 10).toLocaleString('cs-CZ')} %`;

/**
 * Uzavřené období. Týden: pondělí–neděle, `offset` 0 = minulý týden.
 * Měsíc: kalendářní, 0 = minulý měsíc. Srovnává se s obdobím těsně před ním.
 */
export function reportRange(kind: 'week' | 'month', offset: number, today = localDay()): AdsRange & { label: string } {
  const n = Math.max(0, Math.round(offset) || 0);
  if (kind === 'week') {
    const d = new Date(`${today}T12:00:00Z`);
    const monday = shiftDay(today, -((d.getUTCDay() + 6) % 7));
    const from = shiftDay(monday, -7 * (n + 1));
    const to = shiftDay(from, 6);
    return { from, to, prevFrom: shiftDay(from, -7), prevTo: shiftDay(from, -1),
      label: `Týden ${dl(from)}–${dl(to)} ${to.slice(0, 4)}` };
  }
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7)) - 1 - (n + 1); // 0 = leden
  const first = new Date(Date.UTC(y, m, 1, 12));
  const from = first.toISOString().slice(0, 10);
  const to = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0, 12)).toISOString().slice(0, 10);
  const prevFirst = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() - 1, 1, 12));
  return {
    from, to,
    prevFrom: prevFirst.toISOString().slice(0, 10),
    prevTo: shiftDay(from, -1),
    label: `${MONTHS[first.getUTCMonth()][0].toUpperCase()}${MONTHS[first.getUTCMonth()].slice(1)} ${first.getUTCFullYear()}`
  };
}

const change = (now: number, prev: number) => (prev ? (now - prev) / Math.abs(prev) : null);

/**
 * Zjištění z čísel. Každé má `basis` — čísla, ze kterých plyne — aby se
 * dalo ověřit a nebylo to „pocitové" hodnocení.
 */
export function findingsOf(o: AdsOverview, target: number, extra: {
  worst: { name: string; profit: number }[]; eaters: { cost: number }[]; evaluated: number; better: number;
}): AdsFinding[] {
  const out: AdsFinding[] = [];
  const p = o.profitAfterAds;
  const c = change(p.value, p.prev);
  if (c != null && Math.abs(c) >= 0.05) {
    out.push({
      kind: c > 0 ? 'up' : 'down',
      text: `Zisk po reklamě ${c > 0 ? 'vzrostl' : 'klesl'} o ${pct(Math.abs(c))} proti předchozímu období.`,
      basis: `${kc(p.value)} proti ${kc(p.prev)}`
    });
  }
  if (o.profitShare != null) {
    const ok = o.profitShare >= target;
    out.push({
      kind: ok ? 'up' : 'watch',
      text: ok ? `Cíl zisku drží: po reklamě zůstalo ${pct(o.profitShare)} z obratu.`
        : `Pod cílem: po reklamě zůstalo ${pct(o.profitShare)} z obratu, cíl je ${pct(target)}.`,
      basis: `zisk po reklamě ${kc(p.value)} z obratu ${kc(o.revenue.value)}`
    });
  }
  const cc = change(o.cost.value, o.cost.prev);
  const rc = change(o.revenue.value, o.revenue.prev);
  if (cc != null && rc != null && cc > 0.15 && cc > rc + 0.1) {
    out.push({
      kind: 'watch',
      text: 'Náklady na reklamu rostly rychleji než obrat — přidané peníze se zatím nevrátily.',
      basis: `náklady ${cc > 0 ? '+' : ''}${pct(cc)}, obrat ${rc > 0 ? '+' : ''}${pct(rc)}`
    });
  }
  for (const s of o.systems.filter(x => x.connected && x.cost > 0 && x.pno != null && x.targetPno != null)) {
    if (s.pno! > s.targetPno! * 1.5) {
      out.push({
        kind: 'watch',
        text: `${s.system === 'google' ? 'Google Ads' : s.system === 'sklik' ? 'Sklik' : 'Meta'} je daleko nad cílovým PNO.`,
        basis: `PNO ${pct(s.pno!)} při cíli ${pct(s.targetPno!)}, útrata ${kc(s.cost)}`
      });
    }
  }
  if (o.markets.length > 1) {
    const loss = o.markets.filter(m => m.cost > 0 && m.profitAfterAds < 0);
    for (const m of loss) {
      out.push({ kind: 'down', text: `Trh ${MARKET_LABELS[m.market] ?? m.market} po reklamě prodělal.`,
        basis: `zisk po reklamě ${kc(m.profitAfterAds)}, útrata ${kc(m.cost)}` });
    }
  }
  const lossy = extra.worst.filter(w => w.profit < 0);
  if (lossy.length) {
    out.push({
      kind: 'down',
      text: `${lossy.length === 1 ? 'Jedna kampaň prodělala' : `${lossy.length} kampaně prodělaly`}: ${lossy.slice(0, 3).map(w => `„${w.name}"`).join(', ')}.`,
      basis: lossy.slice(0, 3).map(w => `${w.name} ${kc(w.profit)}`).join(' · ')
    });
  }
  const eaten = extra.eaters.reduce((s, e) => s + e.cost, 0);
  if (eaten >= 300) {
    out.push({ kind: 'watch', text: `Žrouti (produkty bez prodeje z reklamy) stáli ${kc(eaten)}.`,
      basis: `${extra.eaters.length} produktů v segmentu Žrouti` });
  }
  if (extra.evaluated >= 3) {
    out.push({
      kind: extra.better / extra.evaluated >= 0.7 ? 'up' : 'info',
      text: `Z vyhodnocených změn vyšlo ${extra.better} z ${extra.evaluated}.`,
      basis: 'zisk kampaně za den 14 dní před a po změně'
    });
  }
  if (o.alerts.some(a => a.level === 'bad')) {
    out.push({ kind: 'watch', text: 'V přehledu svítí červené upozornění — čísla mohou být zkreslená.',
      basis: o.alerts.filter(a => a.level === 'bad').map(a => a.title).join(' · ') });
  }
  return out;
}

const SUMMARY_KEY = 'adsReportSummaries';

function summaries(): Record<string, { text: string; at: string }> {
  try { return JSON.parse(getSetting(SUMMARY_KEY, '{}') || '{}'); } catch { return {}; }
}

const keyOf = (kind: string, from: string, market: string) => `${kind}|${from}|${market}`;

export function report(kind: 'week' | 'month' = 'week', offset = 0, scope = 'all'): AdsReport {
  const cfg = getAdsConfig();
  const range = reportRange(kind, offset);
  const o = overview(30, scope, range);
  const rows = campaigns(30, scope, range).filter(c => c.cost > 0);
  const best = [...rows].sort((a, b) => b.profit - a.profit).slice(0, 5);
  const worst = [...rows].sort((a, b) => a.profit - b.profit).slice(0, 5);
  const prods = products(30, scope, range).rows;
  const stars = prods.filter(p => p.segment === 'hvezdy').sort((a, b) => b.profit - a.profit).slice(0, 8);
  const eaters = prods.filter(p => p.segment === 'zrouti').sort((a, b) => b.cost - a.cost).slice(0, 8);
  const view = proposals();
  const inRange = (at: string) => at.slice(0, 10) >= range.from && at.slice(0, 10) <= range.to;
  const changes = view.changes.filter(c => inRange(c.at) && !c.revertOf).map(c => ({
    at: c.at, title: c.title, device: c.device.replace(/\s*\([^)]*\)$/, ''),
    verdict: c.evaluation?.verdict ?? '', reverted: !!c.revertedAt
  }));
  const decided = [...view.decided, ...view.open];
  const evaluated = view.changes.filter(c => !c.revertOf && c.evaluation && c.evaluation.verdict !== 'pending');
  return {
    kind, offset: Math.max(0, Math.round(offset) || 0), label: range.label,
    from: range.from, to: range.to, prevFrom: range.prevFrom, prevTo: range.prevTo, market: scope || 'all',
    overview: o, target: cfg.targetProfitShare, best, worst, stars, eaters, changes,
    stats: {
      applied: changes.length,
      autopilot: view.changes.filter(c => inRange(c.at) && !c.revertOf && isAutopilot(c.device)).length,
      dismissed: decided.filter(p => p.status === 'dismissed' && inRange(p.updatedAt)).length,
      open: view.open.length
    },
    findings: findingsOf(o, cfg.targetProfitShare, {
      worst, eaters, evaluated: evaluated.length, better: evaluated.filter(c => c.evaluation!.verdict !== 'worse').length
    }),
    summary: summaries()[keyOf(kind, range.from, scope || 'all')]?.text ?? ''
  };
}

const SUMMARY_SYSTEM = `Jsi poradce pro reklamu e-shopu Quentino (pánské doplňky). Napiš česky krátké shrnutí reportu
pro majitele, který není PPC specialista: 3 až 5 odrážek začínajících „- ", každá jedna dvě věty. Nejdřív jak dopadl zisk
po reklamě proti cíli a předchozímu období, pak co táhlo a co brzdilo (kampaně, trhy, systémy), nakonec 1–2 konkrétní kroky
na další období. Jen z dodaných čísel, nic si nevymýšlej; zkratky (PNO, ROAS) vysvětli. Důležité **tučně**. Bez nadpisu.`;

/** Shrnutí reportu od poradce — uloží se k období a trhu */
export async function reportSummary(kind: 'week' | 'month', offset: number, scope = 'all'): Promise<string> {
  const r = report(kind, offset, scope);
  const o = r.overview;
  const data = {
    obdobi: r.label, trh: r.market, cilZiskuZObratu: r.target,
    ziskPoReklame: [Math.round(o.profitAfterAds.value), Math.round(o.profitAfterAds.prev)],
    obrat: [Math.round(o.revenue.value), Math.round(o.revenue.prev)],
    naklady: [Math.round(o.cost.value), Math.round(o.cost.prev)],
    objednavky: [o.orders.value, o.orders.prev], podilZisku: o.profitShare, pnoEshopu: o.shopPno, cilovePno: o.targetPno,
    systemy: o.systems.filter(s => s.connected).map(s => ({ system: s.system, naklady: Math.round(s.cost), hodnota: Math.round(s.value), pno: s.pno })),
    trhy: o.markets.map(m => ({ trh: m.market, obrat: Math.round(m.revenue), naklady: Math.round(m.cost), ziskPoReklame: Math.round(m.profitAfterAds) })),
    nejlepsiKampane: r.best.map(c => ({ nazev: c.name, zisk: Math.round(c.profit), pno: c.pno })),
    nejhorsiKampane: r.worst.map(c => ({ nazev: c.name, zisk: Math.round(c.profit), pno: c.pno })),
    zrouti: r.eaters.map(p => ({ nazev: p.title, naklady: Math.round(p.cost) })),
    zmeny: r.changes.map(c => `${c.at.slice(0, 10)} ${c.title}${c.verdict ? ` (${c.verdict})` : ''}`),
    zjisteni: r.findings.map(f => `${f.text} [${f.basis}]`)
  };
  const s = getSettings();
  const text = (await ask(s.insightModel || s.draftModel, SUMMARY_SYSTEM, JSON.stringify(data), 1500)).trim();
  const all = summaries();
  all[keyOf(kind, r.from, r.market)] = { text, at: new Date().toISOString() };
  // Jen posledních 24 shrnutí — starší reporty se dají shrnout znovu
  const keep = Object.entries(all).sort((a, b) => b[1].at.localeCompare(a[1].at)).slice(0, 24);
  setSetting(SUMMARY_KEY, JSON.stringify(Object.fromEntries(keep)));
  return text;
}

/**
 * Signály pro Přehled dne (AI přehled): krátce, jak si reklama vedla za
 * posledních 7 dní. Bez dat z reklam nic — přehled se nemá plnit nulami.
 */
export function adsDigestSignals(): { kind: 'up' | 'down' | 'watch' | 'info'; text: string; basis: string }[] {
  const cfg = getAdsConfig();
  const o = overview(7, 'all');
  if (!o.cost.value) return [];
  const out: { kind: 'up' | 'down' | 'watch' | 'info'; text: string; basis: string }[] = [];
  const share = o.profitShare;
  out.push({
    kind: share == null ? 'info' : share >= cfg.targetProfitShare ? 'up' : 'watch',
    text: `Reklama za 7 dní: zisk po reklamě ${kc(o.profitAfterAds.value)}${share != null ? ` (${pct(share)} z obratu, cíl ${pct(cfg.targetProfitShare)})` : ''}.`,
    basis: `útrata ${kc(o.cost.value)}, obrat ${kc(o.revenue.value)}`
  });
  const open = proposals().open.length;
  if (open) out.push({ kind: 'info', text: `V Reklamách čeká ${open} návrhů změn.`, basis: 'záložka Návrhy' });
  for (const a of o.alerts.filter(x => x.level === 'bad').slice(0, 2)) {
    out.push({ kind: 'watch', text: `Reklamy: ${a.title}.`, basis: a.text.slice(0, 140) });
  }
  return out;
}
