/**
 * Typy modulu Reklamy, společné pro hlavní proces i okno.
 *
 * Všechny částky jsou v Kč bez DPH, pokud u pole nestojí jinak. Reklamní
 * systémy účtují bez DPH a marže se z ceny s DPH počítat nedá — míchat to
 * dohromady by u každého čísla vyrobilo chybu o pětinu.
 */

export type AdsSystem = 'google' | 'sklik' | 'meta';

/** Jak moc smí modul měnit kampaně sám. Ve fázi 1 jen čte. */
export type AdsAutonomy = 'suggest' | 'guarded' | 'full';

/** Účet Google Ads a trh, ke kterému patří */
export interface AdsAccount {
  /** Číslo účtu bez pomlček */
  id: string;
  name: string;
  /** Měna účtu (CZK, EUR…) — částky se přepočítají na koruny */
  currency: string;
  /** cz | sk | en — podle trhu se páruje s objednávkami a počítá DPH */
  market: string;
  enabled: boolean;
}

export const MARKET_LABELS: Record<string, string> = { cz: 'CZ', sk: 'SK', en: '.com' };

/**
 * Trh účtu podle názvu a měny — jen výchozí odhad, v Nastavení jde změnit.
 * Název má přednost: anglický web může účtovat taky v eurech.
 */
export function guessMarket(name: string, currency: string): string {
  const n = (name ?? '').toLowerCase();
  if (/\.com|\ben\b|english|international|wearquentino|world|global/.test(n)) return 'en';
  if (/\.sk|\bsk\b|slovens|slovak/.test(n)) return 'sk';
  if (/\.cz|\bcz\b|česk|cesk/.test(n)) return 'cz';
  return /eur/i.test(currency ?? '') ? 'sk' : 'cz';
}

/** Náklad na dopravu podle způsobu doručení — kolik to stojí nás, ne zákazníka. */
export interface AdsShipCost {
  /** Název dopravy tak, jak je v objednávce („Zásilkovna Z-Box") */
  name: string;
  /** Kč bez DPH za jednu objednávku */
  cost: number;
  /** Odhad aplikace, který ještě nikdo nepotvrdil */
  guessed: boolean;
}

/**
 * Nastavení modulu, které platí na všech Macích.
 *
 * Putuje sdílenou složkou (novější vyhrává). Hesla a přihlášení k Googlu
 * v něm nejsou — ta zůstávají v klíčence každého Macu zvlášť.
 */
export interface AdsConfig {
  /**
   * Kolik z obratu bez DPH má zbýt jako zisk po reklamě (0,5 = 50 %).
   * Z toho a z marže se odvozuje cílové PNO: PNO = marže − tenhle podíl.
   */
  targetProfitShare: number;
  /** Hodnota konverze, kterou měření posílá do reklam, je s DPH */
  convValueWithVat: boolean;
  /** DPH v procentech podle trhu */
  vat: Record<string, number>;
  /** Kurz eura pro objednávky ze .sk a .com */
  eurRate: number;
  /** Trhy, které modul řídí (začíná se českým) */
  markets: string[];
  /** Náklad dopravy podle způsobu; co tu není, bere `defaultShipCost` */
  shipping: AdsShipCost[];
  defaultShipCost: number;
  /** Marže pro produkty bez nákupní ceny, když ji nejde odhadnout z kategorie */
  fallbackMargin: number;
  autonomy: AdsAutonomy;
  /** Pojistky pro návrhy (a později autopilot) */
  guards: AdsGuards;
  google: {
    /**
     * Účty Google Ads — každý patří jednomu trhu (CZ, SK, .com). Modul
     * stahuje ze všech zapnutých a do každého zapisuje zvlášť.
     */
    accounts: AdsAccount[];
    /** Starší podoba s jediným účtem — převede se do `accounts` */
    customerId: string;
    customerName: string;
    /** Manažerský účet (MCC), přes který se k účtu chodí; prázdné = přímo */
    loginCustomerId: string;
    /** ID klienta OAuth z Google Cloudu (typ Desktop) */
    clientId: string;
    /** Verze API, např. v26 */
    apiVersion: string;
    currency: string;
  };
  /** Náhodná část adresy doplňkového feedu se segmenty */
  feedToken: string;
  updatedAt: string;
}

/**
 * Pojistky. Malé kroky a dost dat: chytré nabízení Googlu se po každé
 * změně týden učí a skok o polovinu rozpočtu ho rozhodí víc, než pomůže.
 */
export interface AdsGuards {
  /** Nejvyšší změna rozpočtu jedním návrhem (0,2 = ±20 %) */
  maxBudgetStep: number;
  /** Nejvyšší změna cílového ROAS jedním návrhem (0,15 = ±15 %) */
  maxRoasStep: number;
  /** Kolik dní se kampaň po změně nechá být */
  cooldownDays: number;
  /** Kolik konverzí za 30 dní musí kampaň mít, aby se jí měnil cíl nebo rozpočet */
  minConversions: number;
  /** Strop útraty za měsíc ve všech systémech, Kč bez DPH; 0 = bez stropu */
  monthlyBudget: number;
}

/**
 * Jedna operace v účtu — vždy v absolutních hodnotách („z 900 na 1 080"),
 * aby se dala zkontrolovat proti skutečnosti a provést bezpečně dvakrát.
 */
export type AdsOp =
  | { kind: 'budget'; campaignId: string; budgetId: string; from: number; to: number; account?: string }
  | { kind: 'troas'; campaignId: string; field: 'maximize_conversion_value' | 'target_roas'; from: number | null; to: number; account?: string }
  | { kind: 'negative'; campaignId: string; text: string; match: 'PHRASE' | 'EXACT'; cost: number; clicks: number; account?: string }
  | { kind: 'negative-remove'; campaignId: string; resource: string; text: string; account?: string }
  | { kind: 'exclude'; codes: string[]; days: number }
  | { kind: 'exclude-remove'; codes: string[] };

export type AdsProposalKind = 'budget-up' | 'budget-down' | 'roas-up' | 'roas-down' | 'roas-set' | 'negatives' | 'exclude';

export type AdsProposalStatus = 'open' | 'approved' | 'applied' | 'dismissed' | 'snoozed' | 'never' | 'failed' | 'stale';

export interface AdsProposal {
  id: string;
  fingerprint: string;
  /** Trh, kterého se návrh týká ('' = celý e-shop, např. vyřazení ve feedu) */
  market?: string;
  kind: AdsProposalKind;
  system: AdsSystem;
  targetId: string;
  targetName: string;
  title: string;
  /** Co to znamená, polopaticky — bez zkratek */
  plain?: string;
  /** Proč — čísla, ze kterých návrh vychází */
  why: string;
  /** Odhad změny zisku po reklamě za 30 dní, Kč */
  impact: number;
  /** 1 = málo dat, 4 = hodně dat */
  confidence: number;
  ops: AdsOp[];
  status: AdsProposalStatus;
  snoozeUntil: string;
  error: string;
  createdAt: string;
  updatedAt: string;
  decidedBy: string;
}

export interface AdsChange {
  id: string;
  proposalId: string;
  revertOf: string;
  kind: string;
  system: AdsSystem;
  targetId: string;
  targetName: string;
  title: string;
  ops: AdsOp[];
  undo: AdsOp[];
  at: string;
  device: string;
  /** Dopočítává se při čtení */
  revertedAt?: string;
  /** Vyhodnocení po 14 dnech: zisk kampaně za den před a po změně */
  evaluation?: { before: number; after: number; days: number; verdict: 'better' | 'worse' | 'same' | 'pending' };
}

export interface AdsProposals {
  open: AdsProposal[];
  /** Schválené na jiném Macu, čekají na Mac přihlášený ke Googlu */
  waiting: AdsProposal[];
  decided: AdsProposal[];
  changes: AdsChange[];
  /** Kolik dní dat z reklam je k dispozici — návrhy chtějí aspoň 14 */
  dataDays: number;
  /** Úspěšnost dřívějších odhadů (vyšlo / vyhodnocené) */
  track: { evaluated: number; better: number };
  generatedAt: string;
  /** Produkty, které právě reklama vynechává (doplňkový feed) */
  excluded: { code: string; until: string }[];
}

/** Stav připojení a posledního běhu — mění se na každém Macu jinak. */
export interface AdsStatus {
  config: AdsConfig;
  google: {
    /** Má tenhle Mac přihlášení (refresh token) */
    connected: boolean;
    hasSecret: boolean;
    /** E-mail servisního účtu, když se tenhle Mac prokazuje klíčem; jinak prázdné */
    service: string;
    /** Chyby posledního stažení po účtech (účet → text) */
    accountErrors: Record<string, string>;
    account: string;
    lastFetch: string;
    lastError: string;
  };
  /** Poslední noční běh — z kteréhokoli Macu */
  lastRun: { day: string; device: string; finishedAt: string; result: string; error: string } | null;
  /** Data jsou ve sdílené složce, takže je uvidí i Mac bez přihlášení */
  shared: boolean;
  feedUrl: string;
  feedPublishedAt: string;
  /** Kolik produktů má nákupní cenu — bez ní je marže jen odhad */
  purchase: { withPrice: number; total: number };
}

/** Jedno číslo s porovnáním proti předchozímu období */
export interface AdsKpi {
  value: number;
  prev: number;
}

export interface AdsSystemTile {
  system: AdsSystem;
  connected: boolean;
  cost: number;
  /** Hodnota konverzí bez DPH */
  value: number;
  conversions: number;
  /** Odhad zisku z konverzí: hodnota × marže − náklady */
  profit: number;
  /** Náklady / hodnota konverzí, v procentech */
  pno: number | null;
  targetPno: number | null;
  daily: { date: string; cost: number; value: number }[];
}

/** Upozornění, které má být vidět dřív než čísla */
export interface AdsAlert {
  level: 'warn' | 'bad' | 'info';
  title: string;
  text: string;
}

export interface AdsDay {
  date: string;
  orders: number;
  revenue: number;
  profit: number;
  cost: number;
  conversions: number;
}

export interface AdsOverview {
  from: string;
  to: string;
  days: number;
  /** Trh, za který jsou čísla ('all' = všechny sledované) */
  market: string;
  /** Rozpad po trzích — u 'all', aby bylo vidět, který trh táhne */
  markets: { market: string; revenue: number; cost: number; profitAfterAds: number; pno: number | null; targetPno: number | null }[];
  /** Zisk z objednávek (marže + doprava) minus všechny náklady na reklamu */
  profitAfterAds: AdsKpi;
  /** Obrat bez DPH ze všech objednávek ve sledovaných trzích */
  revenue: AdsKpi;
  cost: AdsKpi;
  orders: AdsKpi;
  /** Podíl zisku po reklamě na obratu (0,52 = 52 %) */
  profitShare: number | null;
  /** Náklady na reklamu / obrat bez DPH — PNO celého e-shopu */
  shopPno: number | null;
  /** Hrubá marže objednávek po dopravě (bez reklamy) */
  margin: number | null;
  /** Cílové PNO z marže a požadovaného podílu zisku */
  targetPno: number | null;
  systems: AdsSystemTile[];
  daily: AdsDay[];
  alerts: AdsAlert[];
  /** Kolik objednávek mělo položku bez nákupní ceny (marže odhadnutá) */
  estimatedOrders: number;
}

export interface AdsCampaignRow {
  system: AdsSystem;
  /** Účet a trh kampaně */
  account: string;
  market: string;
  id: string;
  name: string;
  type: string;
  status: string;
  budget: number | null;
  bidding: string;
  targetRoas: number | null;
  cost: number;
  clicks: number;
  conversions: number;
  value: number;
  profit: number;
  pno: number | null;
  targetPno: number | null;
}

export type AdsSegment = 'hvezdy' | 'pracanti' | 'zrouti' | 'spici' | 'novinky' | 'doprodej' | 'vyprodano';

export const SEGMENT_LABELS: Record<AdsSegment, string> = {
  hvezdy: 'Hvězdy',
  pracanti: 'Pracanti',
  zrouti: 'Žrouti',
  spici: 'Spící',
  novinky: 'Novinky',
  doprodej: 'Doprodej',
  vyprodano: 'Vyprodáno'
};

export interface AdsProductRow {
  code: string;
  title: string;
  image: string | null;
  category: string;
  segment: AdsSegment;
  /** Proč zrovna tenhle segment — věta do bubliny */
  why: string;
  /** Marže z ceny bez DPH; `estimated` = nákupní cena chybí */
  margin: number | null;
  marginEstimated: boolean;
  stock: number | null;
  cost: number;
  clicks: number;
  impressions: number;
  conversions: number;
  value: number;
  /** Hodnota × marže − náklady */
  profit: number;
  pno: number | null;
  /** Bod zlomu = marže; nad ním produkt na reklamě prodělává */
  breakEven: number | null;
  targetPno: number | null;
  /** Prodáno kusů ve všech objednávkách (nejen z reklam) */
  sold: number;
}

export interface AdsProducts {
  from: string;
  to: string;
  rows: AdsProductRow[];
  counts: Record<AdsSegment, number>;
  /** Produkty z reklam, které se nepodařilo spárovat s katalogem */
  unmatched: { itemId: string; cost: number }[];
}

export interface AdsShipMethod {
  name: string;
  orders: number;
  /** Průměr, který zaplatil zákazník, bez DPH */
  paidAvg: number;
  cost: number;
  guessed: boolean;
}

export interface AdsGoogleCustomer {
  id: string;
  name: string;
  currency: string;
  manager: boolean;
}

export const DEFAULT_ADS_CONFIG: AdsConfig = {
  targetProfitShare: 0.5,
  convValueWithVat: true,
  vat: { cz: 21, sk: 23, en: 21 },
  eurRate: 25,
  markets: ['cz'],
  shipping: [],
  defaultShipCost: 79,
  fallbackMargin: 0.6,
  autonomy: 'suggest',
  guards: { maxBudgetStep: 0.2, maxRoasStep: 0.15, cooldownDays: 7, minConversions: 20, monthlyBudget: 0 },
  google: {
    accounts: [],
    customerId: '',
    customerName: '',
    loginCustomerId: '',
    clientId: '',
    apiVersion: 'v26',
    currency: 'CZK'
  },
  feedToken: '',
  updatedAt: ''
};
