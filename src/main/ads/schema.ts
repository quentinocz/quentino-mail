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
  budget_id TEXT NOT NULL DEFAULT '',
  budget_shared INTEGER NOT NULL DEFAULT 0,
  limited INTEGER NOT NULL DEFAULT 0,
  -- Účet Google Ads (číslo bez pomlček). Prázdné = data z doby, kdy byl
  -- účet jen jeden; čtou se jako hlavní účet.
  account TEXT NOT NULL DEFAULT '',
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
  account TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (system, date, campaign_id)
);

-- Výkon po produktech — stará podoba bez účtu. Data se z ní jednou přelijí
-- do ads_item_day (viz store.ts) a dál se nepoužívá.
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

-- Výkon po produktech (Nákupy a Performance Max) po účtech. Tentýž kód
-- produktu běží v českém i slovenském účtu, proto je účet v klíči.
-- item_id je ID nabídky malými písmeny — Google ho v přehledech zmenšuje.
CREATE TABLE IF NOT EXISTS ads_item_day (
  system TEXT NOT NULL,
  account TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL,
  item_id TEXT NOT NULL,
  cost REAL NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  conversions REAL NOT NULL DEFAULT 0,
  value REAL NOT NULL DEFAULT 0,
  fetched_at TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (system, account, date, item_id)
);

-- Hledané dotazy za posledních 30 dní, sečtené po kampani. Přepisují se
-- při každém stažení celé — jde jen o podklad pro vylučující slova.
CREATE TABLE IF NOT EXISTS ads_search_terms (
  system TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  term TEXT NOT NULL,
  clicks INTEGER NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  conversions REAL NOT NULL DEFAULT 0,
  value REAL NOT NULL DEFAULT 0,
  fetched_at TEXT NOT NULL DEFAULT '',
  account TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (system, campaign_id, term)
);

-- Návrhy změn. Operace jsou v absolutních hodnotách („rozpočet 900 → 1 080"),
-- ne v rozdílech: dva Macy, které by tentýž návrh provedly, tak udělají
-- totéž jednou, ne dvakrát.
CREATE TABLE IF NOT EXISTS ads_proposals (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT '',
  system TEXT NOT NULL DEFAULT 'google',
  target_id TEXT NOT NULL DEFAULT '',
  target_name TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  why TEXT NOT NULL DEFAULT '',
  impact REAL NOT NULL DEFAULT 0,
  confidence INTEGER NOT NULL DEFAULT 1,
  ops_json TEXT NOT NULL DEFAULT '[]',
  -- open | approved | applied | dismissed | snoozed | never | failed | stale
  status TEXT NOT NULL DEFAULT 'open',
  snooze_until TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT '',
  decided_by TEXT NOT NULL DEFAULT '',
  -- Trh kampaně (cz, sk, en); prázdné = celý e-shop (vyřazení ve feedu)
  market TEXT NOT NULL DEFAULT '',
  -- Vysvětlení bez zkratek pro člověka, který není PPC specialista
  plain TEXT NOT NULL DEFAULT ''
);

-- Deník změn v účtech. Řádek se nikdy nepřepisuje: vrácení je nová změna
-- s odkazem na tu původní (revert_of). Díky tomu si Macy deníky jen
-- sjednocují a nemohou si navzájem přepsat historii.
-- Rozhovory s poradcem. Sdílí se mezi Macy (každý Mac zapisuje svůj soubor,
-- čte všechny, novější verze rozhovoru vyhrává); smazání = deleted = 1.
CREATE TABLE IF NOT EXISTS ads_chats (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  turns_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT '',
  deleted INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ads_changes (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL DEFAULT '',
  revert_of TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT '',
  system TEXT NOT NULL DEFAULT 'google',
  target_id TEXT NOT NULL DEFAULT '',
  target_name TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  ops_json TEXT NOT NULL DEFAULT '[]',
  -- Co vrátí změnu zpět (u nových vylučujících slov jejich resourceName)
  undo_json TEXT NOT NULL DEFAULT '[]',
  at TEXT NOT NULL DEFAULT '',
  device TEXT NOT NULL DEFAULT ''
);

-- Rejstříky jen nad sloupci, které tabulky mají od založení. Nad sloupci
-- doplněnými ALTERem by shodily migraci staré databáze (viz migrate-test).
CREATE INDEX IF NOT EXISTS idx_ads_campaign_day_date ON ads_campaign_day(date);
CREATE INDEX IF NOT EXISTS idx_ads_product_day_date ON ads_product_day(date);
CREATE INDEX IF NOT EXISTS idx_ads_item_day_date ON ads_item_day(date);
`;

/*
 * Doplněno ve fázi 2: k čemu patří rozpočet (u sdíleného se nesahá, změnil
 * by se i jiným kampaním) a jestli kampaň brzdí rozpočet — jen taková
 * dostane návrh na přidání peněz.
 */
export const ALTERS: string[] = [
  "ALTER TABLE ads_campaigns ADD COLUMN budget_id TEXT NOT NULL DEFAULT ''",
  'ALTER TABLE ads_campaigns ADD COLUMN budget_shared INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE ads_campaigns ADD COLUMN limited INTEGER NOT NULL DEFAULT 0',
  /*
   * Víc účtů Google Ads (CZ, SK, .com). Každý řádek ví, ze kterého účtu je;
   * podle účtu se pozná trh, měna a DPH a do kterého účtu se zapisuje.
   */
  "ALTER TABLE ads_campaigns ADD COLUMN account TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE ads_campaign_day ADD COLUMN account TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE ads_search_terms ADD COLUMN account TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE ads_proposals ADD COLUMN market TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE ads_proposals ADD COLUMN plain TEXT NOT NULL DEFAULT ''"
];
