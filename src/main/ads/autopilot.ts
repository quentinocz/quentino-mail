/**
 * Autopilot v mezích — po čtyřech týdnech návrhů smí modul malé změny
 * dělat sám.
 *
 * ## Kdy se odemkne
 *
 * Patrik (20. 11.): „4 týdny jen návrhy, pak autopilot v mezích". Aby to
 * nebyl jen kalendář, musí se zároveň ukázat, že návrhy fungují: aspoň
 * 10 provedených změn je po 14 dnech vyhodnocených a aspoň 70 % z nich
 * nevyšlo hůř. Dokud to neplatí, přepínač v Nastavení nejde zapnout.
 *
 * ## Co smí
 *
 * Jen druhy návrhů, které v Nastavení zaškrtneš (výchozí: rozpočty,
 * vylučující slova, vyřazení žroutů), jen s dost daty (jistota) a s
 * kladným odhadem — návrh „drží cíl za cenu části zisku" nechá na člověku.
 * Nejvýš pár změn za noc. Všechny pojistky enginu platí dál (krok ±20 %,
 * týden klidu, měsíční strop), každá změna jde do deníku a jde vrátit.
 *
 * ## Brzda
 *
 * Když ze tří posledních vyhodnocených změn autopilota dvě vyjdou hůř,
 * autopilot se sám zabrzdí a čeká, až ho člověk znovu pustí. Špatná série
 * většinou znamená, že se změnil trh (sezóna, konkurence, výpadek měření)
 * a pravidla na to nejsou stavěná.
 */
import type { AdsConfig, AdsProposal, AdsChange, AdsAutopilotState } from '../../shared/ads';

/** Podpis změn autopilota v deníku — podle něj se pozná, co udělal sám */
export const AUTOPILOT_PREFIX = 'Autopilot';

export const isAutopilot = (device: string) => String(device ?? '').startsWith(AUTOPILOT_PREFIX);

export function autopilotState(
  cfg: AdsConfig, changes: AdsChange[], firstProposalAt: string, today: string,
  lastRun: { at: string; applied: string[] } | null
): AdsAutopilotState {
  const evaluated = changes.filter(c => !c.revertOf && c.evaluation && c.evaluation.verdict !== 'pending');
  const better = evaluated.filter(c => c.evaluation!.verdict !== 'worse').length;
  const days = firstProposalAt
    ? Math.max(0, Math.round((Date.parse(today) - Date.parse(firstProposalAt.slice(0, 10))) / 86_400_000))
    : 0;
  const missing: string[] = [];
  if (days < 28) missing.push(`ještě ${28 - days} dní návrhů (4 týdny)`);
  if (evaluated.length < 10) missing.push(`ještě ${10 - evaluated.length} vyhodnocených změn (aspoň 10)`);
  if (evaluated.length >= 10 && better / evaluated.length < 0.7) {
    missing.push(`úspěšnost ${Math.round((better / evaluated.length) * 100)} % — potřeba aspoň 70 %`);
  }
  const eligible = missing.length === 0;
  return {
    eligible, missing, daysOfProposals: days, evaluated: evaluated.length, better,
    active: eligible && cfg.autonomy === 'guarded' && !cfg.autopilot.pausedAt,
    lastRun
  };
}

/**
 * Které otevřené návrhy smí autopilot použít, v pořadí podle odhadu.
 * Z poradce nic (ty chtějí člověka), kroky sezónního plánu jen když je
 * to v Nastavení povolené.
 */
export function pick(cfg: AdsConfig, open: AdsProposal[]): AdsProposal[] {
  const a = cfg.autopilot;
  return open
    .filter(p => p.status === 'open' || p.status === 'snoozed')
    .filter(p => {
      if (p.fingerprint.includes('|chat|')) return false;
      if (p.fingerprint.includes('|plan|')) return a.seasonPlans && a.kinds.includes(p.kind);
      // Odložené ručně („Odložit") nechat člověku, i když už je jejich den
      if (p.status === 'snoozed') return false;
      return a.kinds.includes(p.kind) && p.confidence >= a.minConfidence && p.impact > 0;
    })
    .sort((x, y) => {
      // Kroky plánu mají svůj den — jdou první, ať se nezpozdí
      const px = x.fingerprint.includes('|plan|') ? 1 : 0;
      const py = y.fingerprint.includes('|plan|') ? 1 : 0;
      return py - px || y.impact - x.impact;
    })
    .slice(0, a.maxPerNight);
}

/**
 * Brzda: dvě ze tří posledních vyhodnocených změn autopilota vyšly hůř.
 * Vrací důvod, nebo prázdný text.
 */
export function brake(changes: AdsChange[]): string {
  const mine = changes
    .filter(c => isAutopilot(c.device) && !c.revertOf && c.evaluation && c.evaluation.verdict !== 'pending')
    .sort((x, y) => y.at.localeCompare(x.at))
    .slice(0, 3);
  const worse = mine.filter(c => c.evaluation!.verdict === 'worse');
  if (mine.length >= 3 && worse.length >= 2) {
    return `Ze tří posledních změn autopilota vyšly ${worse.length} hůř (${worse.map(c => c.targetName || c.title).join(', ')}). `
      + 'Zabrzdil se — zkontroluj měření a sezónu, a když je vše v pořádku, pusť ho znovu.';
  }
  return '';
}
