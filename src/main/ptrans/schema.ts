/**
 * Tabulky pro překlady produktů.
 *
 * V samostatném souboru schválně: `db.ts` je nejnižší vrstva a nesmí tahat
 * `store.ts`, který si `db.ts` sám importuje — kruh v závislostech by se
 * projevil až za běhu prázdnými funkcemi.
 */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS ptrans_products (
  code TEXT PRIMARY KEY,
  product_id TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  archived INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL DEFAULT '',
  image TEXT,
  category TEXT NOT NULL DEFAULT '',
  categories TEXT NOT NULL DEFAULT '',
  manufacturer TEXT NOT NULL DEFAULT '',
  availability TEXT NOT NULL DEFAULT '',
  stock INTEGER,
  price TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  raw_xml TEXT NOT NULL DEFAULT '',
  source_hash TEXT NOT NULL DEFAULT '',
  seen_at TEXT NOT NULL DEFAULT '',
  -- 'feed' = z online feedu, 'file' = ručně nahraný soubor s novinkami,
  -- které se do feedu ještě nepropsaly. Po objevení ve feedu se přepne na 'feed'.
  origin TEXT NOT NULL DEFAULT 'feed',
  added_at TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS ptrans_fields (
  code TEXT NOT NULL,
  lang TEXT NOT NULL,
  field TEXT NOT NULL,
  value TEXT NOT NULL DEFAULT '',
  source_value TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'ok',
  translated TEXT,
  translated_at TEXT,
  translated_hash TEXT,
  model TEXT NOT NULL DEFAULT '',
  manual INTEGER NOT NULL DEFAULT 0,
  -- 1 = v textu je balast po kopírování z cizí stránky (viz ptrans/html.ts).
  -- Drží se v databázi, aby se dal seznam produktů podle toho filtrovat
  -- jedním dotazem místo procházení všech popisů při každém otevření.
  messy INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (code, lang, field)
);
CREATE INDEX IF NOT EXISTS idx_ptrans_fields_state ON ptrans_fields(lang, state);
CREATE INDEX IF NOT EXISTS idx_ptrans_fields_code ON ptrans_fields(code);

-- Paměť překladů: co se aplikace naučila z hotových jazykových mutací
CREATE TABLE IF NOT EXISTS ptrans_memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  lang TEXT NOT NULL,
  source TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  hits INTEGER NOT NULL DEFAULT 0,
  confidence REAL NOT NULL DEFAULT 1,
  origin TEXT NOT NULL DEFAULT 'feed',
  locked INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT '',
  UNIQUE(kind, lang, source, category)
);
CREATE INDEX IF NOT EXISTS idx_ptrans_memory_use ON ptrans_memory(kind, lang, category);

-- Převodník odstínů na základní barvu pro Google Nákupy
CREATE TABLE IF NOT EXISTS ptrans_colors (
  source TEXT PRIMARY KEY,
  base TEXT NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  origin TEXT NOT NULL DEFAULT 'feed',
  locked INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT ''
);

-- Naučená pravidla, které tvary názvů jsou sety a které ne
CREATE TABLE IF NOT EXISTS ptrans_bundles (
  category TEXT NOT NULL DEFAULT '',
  pattern TEXT NOT NULL,
  is_bundle INTEGER NOT NULL DEFAULT 0,
  hits INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (category, pattern)
);

-- Výsledek posledního auditu: co u produktu vadí a jak moc
CREATE TABLE IF NOT EXISTS ptrans_audit (
  code TEXT NOT NULL,
  lang TEXT NOT NULL,
  score INTEGER NOT NULL DEFAULT 0,
  issues TEXT NOT NULL DEFAULT '[]',
  checked_at TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (code, lang)
);
CREATE INDEX IF NOT EXISTS idx_ptrans_audit_score ON ptrans_audit(lang, score);

CREATE TABLE IF NOT EXISTS ptrans_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  total INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  seconds REAL NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT ''
);

-- Zvolený tvar textu podle jazyka a kategorie.
--
-- Když si model není jistý, napíše dvě varianty a uživatel vybere. Výběr se
-- uloží sem a od té chvíle slouží jako závazná ukázka pro celou kategorii —
-- rozhodnutí se dělá jednou, ne u každého produktu znovu.
CREATE TABLE IF NOT EXISTS ptrans_style (
  lang TEXT NOT NULL,
  category TEXT NOT NULL,
  kind TEXT NOT NULL,
  example TEXT NOT NULL DEFAULT '',
  rejected TEXT NOT NULL DEFAULT '',
  hits INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (lang, category, kind)
);

-- Nerozhodnuté dvojice variant. Běh překladu na odpověď nečeká — uloží
-- variantu A a jede dál; uživatel rozhodne, až se k tomu dostane.
CREATE TABLE IF NOT EXISTS ptrans_trials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  lang TEXT NOT NULL,
  field TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  variant_a TEXT NOT NULL,
  variant_b TEXT NOT NULL,
  chosen TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT '',
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_ptrans_trials_open ON ptrans_trials(chosen, lang, category);
`;

/** Doplňkové sloupce pro databáze založené dřív — chyba „už existuje" je v pořádku. */
export const ALTERS = [
  `ALTER TABLE ptrans_products ADD COLUMN origin TEXT NOT NULL DEFAULT 'feed'`,
  `ALTER TABLE ptrans_products ADD COLUMN added_at TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE ptrans_fields ADD COLUMN messy INTEGER NOT NULL DEFAULT 0`
];
