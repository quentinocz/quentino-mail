/**
 * Engine návrhů — co by se v kampaních mělo změnit a proč.
 *
 * Čísla počítá kód, ne model: každý návrh musí jít ověřit z dat, ze kterých
 * vznikl, a stejná data musí dát stejný návrh. Pravidla jsou ta, podle
 * kterých by postupoval opatrný PPC specialista:
 *
 *  - **Rozpočet nahoru** jen kampani, kterou opravdu brzdí rozpočet, je
 *    hluboko pod cílovým PNO a má dost konverzí. Další koruna vydělá méně
 *    než průměrná (mezní návratnost klesá), proto se v odhadu počítá
 *    s horším PNO, než má kampaň dnes.
 *  - **Přísnější cíl** (vyšší cílové ROAS) kampani nad cílovým PNO; když
 *    cíl nemá, nejdřív se jí navrhne nastavit, a u ručního nabízení se
 *    ubere rozpočet.
 *  - **Volnější cíl** kampani, která je hluboko pod cílem a rozpočet ji
 *    nebrzdí — brzdí ji vlastní přísný cíl a nechává peníze ležet.
 *  - **Vylučující slova** z hledaných dotazů, které utrácejí bez prodeje.
 *    Nikdy slovo, které je v názvu některého produktu: „kšandy" s nulou
 *    konverzí znamená špatný dotaz, ne špatné slovo.
 *  - **Vyřadit žrouty** z produktových kampaní na 30 dní (přes doplňkový
 *    feed — v účtu se nemaže nic).
 *
 * Pojistky: kroky nejvýš ±20 % rozpočtu a ±15 % cíle, kampaň po změně
 * týden v klidu, cíl se nemění pod 20 konverzí za 30 dní.
 */
import type { AdsConfig, AdsOp, AdsProposalKind } from '../../shared/ads';

export interface EngineCampaign {
  id: string;
  name: string;
  type: string;
  status: string;
  bidding: string;
  targetRoas: number | null;
  /** Denní rozpočet v Kč */
  budget: number | null;
  budgetId: string;
  budgetShared: boolean;
  limited: boolean;
  /** Za 30 dní: náklady a hodnota konverzí bez DPH */
  cost: number;
  conversions: number;
  value: number;
}

export interface EngineTerm {
  campaignId: string;
  term: string;
  clicks: number;
  cost: number;
  conversions: number;
}

export interface EngineProduct {
  code: string;
  title: string;
  segment: string;
  cost: number;
  profit: number;
}

export interface EngineInput {
  cfg: AdsConfig;
  /** Marže objednávek po dopravě (bez reklamy) */
  margin: number;
  /** Cílové PNO e-shopu (na hodnotě bez DPH) */
  targetPno: number;
  campaigns: EngineCampaign[];
  terms: EngineTerm[];
  /** Slova z názvů produktů — ta se nikdy nevylučují */
  vocabulary: Set<string>;
  products: EngineProduct[];
  /** Kódy, které už jsou vyřazené */
  excluded: Set<string>;
  /** Kampaně změněné v posledních dnech (pojistka „týden v klidu") */
  cooling: Set<string>;
  /** Otisky návrhů, které se teď nemají nabízet (odložené, „nenavrhovat") */
  blocked: Set<string>;
  /** Útrata tento měsíc a kolik dní měsíce zbývá — kvůli stropu */
  monthSpend: number;
  daysLeft: number;
  /** Kolik dní dat je k dispozici */
  dataDays: number;
}

export interface ProposalDraft {
  fingerprint: string;
  kind: AdsProposalKind;
  targetId: string;
  targetName: string;
  title: string;
  why: string;
  impact: number;
  confidence: number;
  ops: AdsOp[];
}

const kc = (n: number) => `${Math.round(n).toLocaleString('cs-CZ')} Kč`;
const pct = (n: number) => `${(n * 100).toLocaleString('cs-CZ', { maximumFractionDigits: 1 })} %`;
const roasPct = (n: number) => `${Math.round(n * 100)} %`;

/** Jistota podle počtu konverzí: kolik dat za návrhem stojí */
function confidenceOf(conversions: number): number {
  if (conversions >= 100) return 4;
  if (conversions >= 50) return 3;
  if (conversions >= 20) return 2;
  return 1;
}

/** Normalizace slova pro porovnání s názvy produktů (bez diakritiky, malá) */
export function plainWord(word: string): string {
  return word.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Kořen slova, aby „kšandy", „kšand" a „kšandami" byly totéž. Jen hrubé
 * useknutí koncovky — na rozhodnutí „je to slovo z katalogu" stačí a je
 * opatrné: radši nevyloučit, než vyloučit slovo, které prodává.
 */
export function stem(word: string): string {
  const plain = plainWord(word);
  return plain.length > 5 ? plain.slice(0, plain.length - 2) : plain;
}

export function vocabularyOf(titles: string[]): Set<string> {
  const out = new Set<string>();
  for (const title of titles) {
    for (const word of title.split(/[\s,.;:()/+\-–]+/)) {
      if (plainWord(word).length >= 3) out.add(stem(word));
    }
  }
  return out;
}

/** ROAS, jak ho počítá Google: hodnota tak, jak ji posílá měření (obvykle s DPH) */
function vatFactor(cfg: AdsConfig): number {
  return cfg.convValueWithVat ? 1 + (cfg.vat[cfg.markets[0] ?? 'cz'] ?? 21) / 100 : 1;
}

/**
 * Cílové ROAS v jednotkách Googlu pro dané PNO.
 * PNO je na hodnotě bez DPH, Google počítá s hodnotou z měření.
 */
export function roasForPno(cfg: AdsConfig, pno: number): number {
  return vatFactor(cfg) / pno;
}

export function generate(input: EngineInput): ProposalDraft[] {
  const { cfg, margin, targetPno } = input;
  const g = cfg.guards;
  const out: ProposalDraft[] = [];
  if (input.dataDays < 14 || !(targetPno > 0)) return out;

  const push = (draft: ProposalDraft) => {
    if (input.blocked.has(draft.fingerprint)) return;
    out.push(draft);
  };

  // Kolik se smí přidat, aby se nepřekročil měsíční strop
  let headroom = Infinity;
  if (g.monthlyBudget > 0) {
    const daily = input.campaigns.filter(c => c.status === 'ENABLED').reduce((s, c) => s + (c.budget ?? 0), 0);
    headroom = Math.max(0, (g.monthlyBudget - input.monthSpend) / Math.max(1, input.daysLeft) - daily);
  }

  for (const c of input.campaigns) {
    if (c.status !== 'ENABLED' || input.cooling.has(c.id)) continue;
    const pno = c.value > 0 ? c.cost / c.value : null;
    const enough = c.conversions >= g.minConversions;
    const hasTarget = c.targetRoas != null
      && (c.bidding === 'MAXIMIZE_CONVERSION_VALUE' || c.bidding === 'TARGET_ROAS');
    const field = c.bidding === 'TARGET_ROAS' ? 'target_roas' as const : 'maximize_conversion_value' as const;
    const conf = confidenceOf(c.conversions);

    /* --- Rozpočet nahoru: brzdí ho rozpočet a vydělává --- */
    if (c.limited && enough && pno != null && pno <= targetPno * 0.85 && c.budget && !c.budgetShared && c.budgetId) {
      const add = Math.min(c.budget * g.maxBudgetStep, headroom);
      if (add >= 10) {
        const to = Math.round(c.budget + add);
        // Další koruna vydělá méně než průměrná — počítá se s PNO o třetinu horším
        const marginal = pno * 1.35;
        const extraCost = (to - c.budget) * 30 * 0.8;
        const impact = (extraCost / marginal) * margin - extraCost;
        push({
          fingerprint: `budget-up|google|${c.id}`,
          kind: 'budget-up', targetId: c.id, targetName: c.name,
          title: `Přidat rozpočet: ${c.name} ${kc(c.budget)} → ${kc(to)} denně`,
          why: `Kampaň brzdí rozpočet a má PNO ${pct(pno)} při cíli ${pct(targetPno)} (${Math.round(c.conversions)} konverzí `
            + `za 30 dní). Další koruna vydělá méně než průměrná — odhad počítá s PNO ${pct(marginal)}.`
            + (headroom < Infinity ? ` Vejde se do měsíčního stropu.` : ''),
          impact, confidence: Math.min(conf, 3),
          ops: [{ kind: 'budget', campaignId: c.id, budgetId: c.budgetId, from: c.budget, to }]
        });
        if (headroom < Infinity) headroom -= add;
        continue;
      }
    }

    /* --- Nad cílem: přísnější cíl, nebo méně peněz --- */
    if (pno != null && pno > targetPno * 1.15 && enough) {
      const need = roasForPno(cfg, targetPno);
      /*
       * Odhad: útrata klesne o 15 % a odpadnou nejhorší aukce, které mají
       * PNO o polovinu horší, než je průměr kampaně. Když je marže vysoká,
       * vyjde i tak záporně — kampaň nad cílem pořád vydělává, jen ne tolik
       * procent z obratu, kolik je cíl. Návrh pak drží cíl za cenu části
       * zisku a v textu to stojí.
       */
      const cut = c.cost * 0.15;
      const impact = cut - (cut / (pno * 1.5)) * margin;
      const cost = impact < 0
        ? ` Zisk po reklamě tím klesne asi o ${kc(-impact)} za 30 dní — kampaň vydělává i nad cílem, `
          + `ale cíl ${pct(cfg.targetProfitShare)} zisku z obratu je přednější. Když má mít přednost zisk v korunách, sniž cíl v Nastavení.`
        : '';
      if (hasTarget) {
        const to = Math.min(c.targetRoas! * (1 + g.maxRoasStep), need);
        if (to > c.targetRoas! * 1.01) {
          push({
            fingerprint: `roas-up|google|${c.id}`,
            kind: 'roas-up', targetId: c.id, targetName: c.name,
            title: `Přísnější cíl: ${c.name} cílové ROAS ${roasPct(c.targetRoas!)} → ${roasPct(to)}`,
            why: `PNO ${pct(pno)} je nad cílem ${pct(targetPno)} (marže ${pct(margin)} − požadovaný zisk). `
              + `Na cíl by bylo potřeba ROAS ${roasPct(need)}; krok je omezený na ${Math.round(g.maxRoasStep * 100)} %, `
              + 'aby se chytré nabízení nerozhodilo.' + cost,
            impact, confidence: conf,
            ops: [{ kind: 'troas', campaignId: c.id, field, from: c.targetRoas, to }]
          });
        }
      } else if (c.bidding === 'MAXIMIZE_CONVERSION_VALUE') {
        // Bez cíle: nastavit ho mírně nad tím, co kampaň dnes dělá
        const now = c.cost > 0 ? (c.value * vatFactor(cfg)) / c.cost : 0;
        const to = Math.min(now * (1 + g.maxRoasStep), need);
        if (to > 0) {
          push({
            fingerprint: `roas-set|google|${c.id}`,
            kind: 'roas-set', targetId: c.id, targetName: c.name,
            title: `Nastavit cílové ROAS: ${c.name} → ${roasPct(to)}`,
            why: `Kampaň maximalizuje hodnotu bez cíle a dosahuje PNO ${pct(pno)} při cíli ${pct(targetPno)}. `
              + `Cíl o ${Math.round(g.maxRoasStep * 100)} % nad dnešní návratností (${roasPct(now)}) ji začne krotit postupně.` + cost,
            impact, confidence: Math.max(1, conf - 1),
            ops: [{ kind: 'troas', campaignId: c.id, field: 'maximize_conversion_value', from: null, to }]
          });
        }
      } else if (c.budget && !c.budgetShared && c.budgetId) {
        const to = Math.round(c.budget * (1 - g.maxBudgetStep));
        push({
          fingerprint: `budget-down|google|${c.id}`,
          kind: 'budget-down', targetId: c.id, targetName: c.name,
          title: `Ubrat rozpočet: ${c.name} ${kc(c.budget)} → ${kc(to)} denně`,
          why: `PNO ${pct(pno)} je nad cílem ${pct(targetPno)} a nabízení nemá cíl, kterým by se dalo zpřísnit.`
            + ((c.budget - to) * 30 * 0.8 * (1 - margin / (pno * 1.3)) < 0
              ? ` Zisk po reklamě tím mírně klesne — drží se cíl ${pct(cfg.targetProfitShare)} zisku z obratu.` : ''),
          // Ubere se nejhorší část útraty — počítá se s PNO o třetinu horším než průměr
          impact: (c.budget - to) * 30 * 0.8 * (1 - margin / (pno * 1.3)),
          confidence: conf,
          ops: [{ kind: 'budget', campaignId: c.id, budgetId: c.budgetId, from: c.budget, to }]
        });
      }
      continue;
    }

    /* --- Prodělává a dat je málo: aspoň ubrat peníze --- */
    if (!enough && c.cost >= 1500 && c.budget && !c.budgetShared && c.budgetId
      && (pno == null || pno > margin)) {
      const to = Math.round(c.budget * (1 - g.maxBudgetStep));
      push({
        fingerprint: `budget-down|google|${c.id}`,
        kind: 'budget-down', targetId: c.id, targetName: c.name,
        title: `Ubrat rozpočet: ${c.name} ${kc(c.budget)} → ${kc(to)} denně`,
        why: pno == null
          ? `Za 30 dní ${kc(c.cost)} a žádná konverze.`
          : `PNO ${pct(pno)} je nad marží ${pct(margin)} — každá objednávka z kampaně prodělá.`,
        impact: Math.max(0, (c.budget - to) * 30 * 0.8 - (pno ? ((c.budget - to) * 30 * 0.8 / pno) * margin : 0)),
        confidence: 1,
        ops: [{ kind: 'budget', campaignId: c.id, budgetId: c.budgetId, from: c.budget, to }]
      });
      continue;
    }

    /* --- Hluboko pod cílem a nebrzdí ho rozpočet: volnější cíl --- */
    if (hasTarget && pno != null && pno < targetPno * 0.6 && enough && !c.limited) {
      const to = c.targetRoas! * (1 - g.maxRoasStep);
      // Odhad: útrata +15 %, hodnota +8 % — dražší aukce, horší návratnost
      const impact = c.value * 0.08 * margin - c.cost * 0.15;
      if (impact > 0) {
        push({
          fingerprint: `roas-down|google|${c.id}`,
          kind: 'roas-down', targetId: c.id, targetName: c.name,
          title: `Volnější cíl pro růst: ${c.name} cílové ROAS ${roasPct(c.targetRoas!)} → ${roasPct(to)}`,
          why: `PNO ${pct(pno)} je hluboko pod cílem ${pct(targetPno)} a rozpočet kampaň nebrzdí — brzdí ji vlastní `
            + 'přísný cíl. Mírně volnější cíl ji pustí do dalších aukcí, zisk po reklamě by měl růst.',
          impact, confidence: Math.max(1, conf - 1),
          ops: [{ kind: 'troas', campaignId: c.id, field, from: c.targetRoas, to }]
        });
      }
    }
  }

  /* --- Vylučující slova --- */
  const byCampaign = new Map<string, EngineTerm[]>();
  for (const t of input.terms) {
    const list = byCampaign.get(t.campaignId) ?? [];
    list.push(t);
    byCampaign.set(t.campaignId, list);
  }
  const allClicks = input.terms.reduce((s, t) => s + t.clicks, 0);
  const allConv = input.terms.reduce((s, t) => s + t.conversions, 0);
  const rate = allClicks > 0 && allConv > 0 ? allConv / allClicks : 0.02;
  for (const [campaignId, terms] of byCampaign) {
    const c = input.campaigns.find(one => one.id === campaignId);
    if (!c || c.status !== 'ENABLED' || !['SEARCH', 'SHOPPING'].includes(c.type)) continue;
    // Slova z dotazů, které prodaly, se nevylučují nikdy
    const selling = new Set<string>();
    for (const t of terms) {
      if (t.conversions > 0) for (const w of t.term.split(/\s+/)) selling.add(stem(w));
    }
    const words = new Map<string, { clicks: number; cost: number; terms: number }>();
    for (const t of terms) {
      if (t.conversions > 0) continue;
      for (const w of new Set(t.term.split(/\s+/))) {
        const key = stem(w);
        if (plainWord(w).length < 3 || selling.has(key) || input.vocabulary.has(key) || /quentino/.test(plainWord(w))) continue;
        const one = words.get(w) ?? { clicks: 0, cost: 0, terms: 0 };
        one.clicks += t.clicks; one.cost += t.cost; one.terms++;
        words.set(w, one);
      }
    }
    // Aspoň tolik kliků, aby se při běžném poměru čekaly dvě objednávky
    const need = Math.max(10, 2 / rate);
    const picked = [...words.entries()]
      .filter(([, v]) => v.clicks >= need && v.cost >= 100)
      .sort((a, b) => b[1].cost - a[1].cost)
      .slice(0, 10);
    if (!picked.length) continue;
    const cost = picked.reduce((s, [, v]) => s + v.cost, 0);
    push({
      fingerprint: `negatives|google|${campaignId}|${picked.map(([w]) => w).sort().join(',')}`,
      kind: 'negatives', targetId: campaignId, targetName: c.name,
      title: `Vyloučit ${picked.length} ${picked.length === 1 ? 'slovo' : picked.length < 5 ? 'slova' : 'slov'} v kampani ${c.name}`,
      why: `Dotazy s ${picked.map(([w]) => `„${w}"`).join(', ')} stály za 30 dní ${kc(cost)} bez jediné objednávky. `
        + 'Slova z názvů produktů a z dotazů, které prodaly, se nevylučují nikdy.',
      impact: cost * 0.9,
      confidence: picked.reduce((s, [, v]) => s + v.clicks, 0) >= 200 ? 3 : 2,
      ops: picked.map(([w, v]) => ({ kind: 'negative' as const, campaignId, text: w, match: 'PHRASE' as const, cost: v.cost, clicks: v.clicks }))
    });
  }

  /* --- Žrouti ven z produktových kampaní na 30 dní --- */
  const eaters = input.products
    .filter(p => p.segment === 'zrouti' && p.cost >= 150 && !input.excluded.has(p.code))
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 40);
  if (eaters.length) {
    const cost = eaters.reduce((s, p) => s + p.cost, 0);
    const gain = eaters.reduce((s, p) => s - Math.min(0, p.profit), 0);
    push({
      fingerprint: `exclude|google|${eaters.map(p => p.code).sort().join(',')}`,
      kind: 'exclude', targetId: 'feed', targetName: 'Doplňkový feed',
      title: `Vyřadit ${eaters.length} žroutů z produktových kampaní na 30 dní`,
      why: `Za 30 dní stály ${kc(cost)} a na zisku po reklamě skončily na ${kc(-gain)}. Vyřazení jde přes doplňkový feed `
        + '(custom_label_2 = vyradit); po 30 dnech se vrátí samy a dostanou novou šanci.',
      impact: gain,
      confidence: 2,
      ops: [{ kind: 'exclude', codes: eaters.map(p => p.code), days: 30 }]
    });
  }

  /*
   * Návrhy, které drží cíl (přísnější cíl, méně peněz nad cílem), zůstávají
   * i se záporným odhadem — je to cena za cíl, který si majitel nastavil.
   * Ostatní bez kladného přínosu nemají smysl.
   */
  const holdsTarget = ['roas-up', 'roas-set', 'budget-down'];
  return out
    .filter(one => one.impact > 0 || holdsTarget.includes(one.kind))
    .sort((a, b) => b.impact - a.impact);
}
