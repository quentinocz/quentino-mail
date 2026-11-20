/**
 * Tabulky modulu Reklamy.
 *
 * Statistiky se ukládají po dnech a po kampaních / produktech tak, jak je
 * reklamní systém vrací. Nic se tu nepřepočítává dopředu: zisk, PNO ani
 * segmenty se neukládají, počítají se při čtení z objednávek a nákupních
 * cen — jinak by stačila jedna opravená nákupní cena a půl databáze by
 * tvrdila staré marže.
 *
 * `system` je 'google' | 'sklik' | 'meta'. Částky jsou v Kč bez DPH (tak je
 * reklamní systémy účtují); hodnota konverzí je tak, jak ji posílá měření
 * na webu — jestli s DPH, říká nastavení modulu.
 */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS ads_campaigns (
  system TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  -- SEARCH, SHOPPING, PERFORMANCE_MAX, DISPLAY, VIDEO, DEMAND_GEN…
  type TEXT NOT NULL DEFAULT '',
  -- ENABLED, PAUSED, REMOVED
  status TEXT NOT NULL DEFAULT '',
  -- Denní rozpočet v Kč; NULL u sdíleného nebo neznámého
  budget REAL,
  -- MAXIMIZE_CONVERSION_VALUE, TARGET_ROAS, MANUAL_CPC…
  bidding TEXT NOT NULL DEFAULT '',
  -- Cílové ROAS jako násobek (3.5 = 350 %); NULL = bez cíle
  target_roas REAL,
  updated_at TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (system, id)
);

CREATE TABLE IF NOT EXISTS ads_campaign_day (
  system TEXT NOT NULL,
  date TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  cost REAL NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  conversions REAL NOT NULL DEFAULT 0,
  value REAL NOT NULL DEFAULT 0,
  fetched_at TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (system, date, campaign_id)
);

-- Výkon po produktech (Nákupy a Performance Max). item_id je ID nabídky
-- z feedu malými písmeny — Google ho v přehledech vrací zmenšené.
CREATE TABLE IF NOT EXISTS ads_product_day (
  system TEXT NOT NULL,
  date TEXT NOT NULL,
  item_id TEXT NOT NULL,
  cost REAL NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  conversions REAL NOT NULL DEFAULT 0,
  value REAL NOT NULL DEFAULT 0,
  fetched_at TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (system, date, item_id)
);

-- Jedna noc = jeden záznam. Podle něj se pozná, že se dnešní běh už
-- udělal, a v přehledu je vidět, jak dopadl.
CREATE TABLE IF NOT EXISTS ads_runs (
  day TEXT PRIMARY KEY,
  started_at TEXT NOT NULL DEFAULT '',
  finished_at TEXT NOT NULL DEFAULT '',
  device TEXT NOT NULL DEFAULT '',
  result TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT ''
);

-- Rejstříky jen nad sloupci, které tabulky mají od založení. Nad sloupci
-- doplněnými ALTERem by shodily migraci staré databáze (viz migrate-test).
CREATE INDEX IF NOT EXISTS idx_ads_campaign_day_date ON ads_campaign_day(date);
CREATE INDEX IF NOT EXISTS idx_ads_product_day_date ON ads_product_day(date);
`;

export const ALTERS: string[] = [];
