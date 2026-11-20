/**
 * Segmenty produktů.
 *
 * Reklama na celý katalog s jedním cílem utrácí stejně za kravatu, která
 * vydělává, i za ponožky, které jen sbírají kliky. Segment říká, jak se
 * k produktu má reklama chovat — a jde do kampaní jako `custom_label_0`
 * v doplňkovém feedu, takže kampaň v Google Ads může mít pro každý
 * segment jiný cíl a jiný rozpočet.
 *
 * Pořadí pravidel je záměrné: vyprodané ven ze všeho, novinky se nesoudí
 * podle prázdných dat, a teprve pak se dívá na výkon. Prahy jsou výchozí
 * podle návrhu modulu; pro e-shop velikosti Quentina sedí, ale jsou tu
 * na jednom místě, aby se daly upravit.
 */
import type { AdsSegment } from '../../shared/ads';

export const SEGMENT_RULES = {
  /** Kolik dní je produkt novinkou */
  newDays: 30,
  /** Pod kolik kusů skladem se z produktu stává doprodej */
  lowStock: 3,
  /** Žrout: aspoň tolik kliků bez jediné konverze… */
  minClicksZrout: 20,
  /**
   * …a tolik, že by při běžném konverzním poměru e-shopu měly přijít
   * aspoň dvě objednávky. Pevný počet kliků by u levných produktů
   * soudil moc brzy a u drahých pozdě; tohle je otázka „je nula ještě
   * náhoda?".
   */
  zroutExpected: 2,
  /** Spící: méně zobrazení za období */
  sleepImpressions: 100,
  /** Hvězdy: horních 20 % produktů se ziskem */
  starsShare: 0.2
};

export interface SegmentInput {
  code: string;
  cost: number;
  clicks: number;
  impressions: number;
  conversions: number;
  /** Hodnota konverzí bez DPH */
  value: number;
  margin: number | null;
  stock: number | null;
  /** Kolik dní je produkt v katalogu; null = nevíme */
  ageDays: number | null;
}

export interface SegmentResult {
  segment: AdsSegment;
  why: string;
  profit: number;
}

const kc = (n: number) => `${Math.round(n).toLocaleString('cs-CZ')} Kč`;

/**
 * Rozdělí produkty do segmentů.
 *
 * `fallbackMargin` je marže, se kterou se počítá zisk produktu bez
 * nákupní ceny — jinak by takový produkt nikdy nemohl být hvězdou ani
 * žroutem a schoval by se mezi spícími.
 */
export function segmentProducts(list: SegmentInput[], fallbackMargin: number): Map<string, SegmentResult> {
  const out = new Map<string, SegmentResult>();
  const profitOf = (one: SegmentInput) => one.value * (one.margin ?? fallbackMargin) - one.cost;

  const clicks = list.reduce((sum, one) => sum + one.clicks, 0);
  const conversions = list.reduce((sum, one) => sum + one.conversions, 0);
  // Bez jediné konverze v celém katalogu se konverzní poměr odhadnout nedá
  const rate = clicks > 0 && conversions > 0 ? conversions / clicks : 0;
  const zroutClicks = rate > 0
    ? Math.max(SEGMENT_RULES.minClicksZrout, SEGMENT_RULES.zroutExpected / rate)
    : Infinity;

  // Hranice hvězd: zisk, nad kterým je horních 20 % produktů se ziskem
  const profits = list.map(profitOf).filter(p => p > 0).sort((a, b) => b - a);
  const starCount = Math.max(1, Math.round(profits.length * SEGMENT_RULES.starsShare));
  const starLine = profits.length ? profits[Math.min(starCount, profits.length) - 1] : Infinity;

  for (const one of list) {
    const profit = profitOf(one);
    const set = (segment: AdsSegment, why: string) => out.set(one.code, { segment, why, profit });

    if (one.stock !== null && one.stock <= 0) {
      set('vyprodano', 'Není skladem — reklama na něj nemá platit kliky.');
      continue;
    }
    if (one.ageDays !== null && one.ageDays < SEGMENT_RULES.newDays) {
      set('novinky', `V katalogu ${one.ageDays} dní — ochranná doba, data ještě nejsou.`);
      continue;
    }
    if (one.cost > 0 && (
      (one.conversions === 0 && one.clicks >= zroutClicks) ||
      (one.conversions > 0 && profit < 0)
    )) {
      set('zrouti', one.conversions === 0
        ? `${one.clicks} kliků za ${kc(one.cost)} a žádný prodej — při běžném poměru by měl prodat ${Math.floor(one.clicks * rate)}×.`
        : `Reklama stála ${kc(one.cost)}, marže z prodejů ji nepokryla (${kc(profit)}).`);
      continue;
    }
    if (one.stock !== null && one.stock < SEGMENT_RULES.lowStock) {
      set('doprodej', `Skladem ${one.stock} ks — brzy dojde.`);
      continue;
    }
    if (profit > 0 && profit >= starLine) {
      set('hvezdy', `Zisk po reklamě ${kc(profit)} — mezi nejlepšími.`);
      continue;
    }
    if (one.conversions > 0 && profit >= 0) {
      set('pracanti', `Prodává se se ziskem ${kc(profit)}.`);
      continue;
    }
    set('spici', one.impressions < SEGMENT_RULES.sleepImpressions
      ? `Jen ${one.impressions} zobrazení — reklama ho skoro neukazuje.`
      : `${one.impressions} zobrazení, ${one.clicks} kliků, zatím bez prodeje.`);
  }
  return out;
}

/**
 * Pásmo marže pro `custom_label_1`.
 *
 * Do feedu nejde přesná marže — feed je na veřejné adrese a přesné
 * nákupní ceny tam nemají co dělat. Pásmo stačí, aby se kampaně daly
 * rozdělit podle toho, kolik snesou.
 */
export function marginBand(margin: number | null): string {
  if (margin == null) return 'marze-neznama';
  if (margin >= 0.7) return 'marze-70-plus';
  if (margin >= 0.5) return 'marze-50-70';
  if (margin >= 0.3) return 'marze-30-50';
  return 'marze-do-30';
}

/**
 * Doplňkový feed pro Merchant Center (TSV).
 *
 * Řádek pro produkt i pro každou variantu: Google zná nabídky pod tím ID,
 * které mu poslal hlavní feed, a doplňkový feed s ID, které v hlavním není,
 * prostě ignoruje — takže je bezpečné poslat obojí.
 */
export function supplementalTsv(rows: { id: string; segment: AdsSegment; band: string }[]): string {
  const clean = (value: string) => value.replace(/[\t\r\n]+/g, ' ').trim();
  const lines = ['id\tcustom_label_0\tcustom_label_1'];
  for (const row of rows) {
    if (!row.id) continue;
    lines.push(`${clean(row.id)}\t${row.segment}\t${row.band}`);
  }
  return lines.join('\n') + '\n';
}
