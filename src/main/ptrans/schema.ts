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
  PRIMARY KEY (code, lang, field)
);
CREATE INDEX IF NOT EXISTS idx_ptrans_fields_state ON ptrans_fields(lang, state);
CREATE INDEX IF NOT EXISTS idx_ptrans_fields_code ON ptrans_fields(code);

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
`;

/** Doplňkové sloupce pro databáze založené dřív — chyba „už existuje" je v pořádku. */
export const ALTERS = [
  `ALTER TABLE ptrans_products ADD COLUMN origin TEXT NOT NULL DEFAULT 'feed'`,
  `ALTER TABLE ptrans_products ADD COLUMN added_at TEXT NOT NULL DEFAULT ''`
];
