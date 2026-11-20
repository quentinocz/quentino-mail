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
  google: {
    /** Číslo účtu Google Ads bez pomlček */
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

/** Stav připojení a posledního běhu — mění se na každém Macu jinak. */
export interface AdsStatus {
  config: AdsConfig;
  google: {
    /** Má tenhle Mac přihlášení (refresh token) */
    connected: boolean;
    hasSecret: boolean;
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
  google: {
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
