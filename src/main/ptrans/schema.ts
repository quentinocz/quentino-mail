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
  -- Co v poli přišlo z paměti odstavců: JSON [{b, s}] (viz ptrans/reuse.ts).
  -- Prázdné = celé napsal model nebo člověk.
  reuse_marks TEXT NOT NULL DEFAULT '',
  -- Otisk textu, který byl v e-shopu ve chvíli překladu. Když je v e-shopu
  -- při exportu jiný (někdo ho mezitím přepsal), export ho nepřepíše.
  base_hash TEXT,
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
-- Rozdělaný nový produkt.
--
-- Celý obsah je jeden JSON schválně: vyplnit nový produkt je práce na dvacet
-- minut a polí přibývá (parametry, Google atributy, obrázky). Sloupec za
-- každé pole by znamenal migraci databáze u všech, kdo aplikaci mají.
-- Číselník parametrů posbíraný z feedu.
--
-- Parametry se u nového produktu nesmějí vypisovat rukou: „Barva" vedle
-- „barva" a „Šířka 7 cm" vedle „Šíře 7cm" rozbije filtry v e-shopu a v Google
-- Nákupech to vypadá jako dva různé produkty. Číselník se skládá z toho, co
-- ve feedu doopravdy je — i s hotovými překlady, takže se u nového produktu
-- nemusí překládat znovu.
CREATE TABLE IF NOT EXISTS ptrans_params (
  -- 'name' = název parametru, 'value' = jeho hodnota
  kind TEXT NOT NULL,
  -- Normalizovaný český tvar (malá písmena, bez diakritiky) — klíč pro hledání
  key TEXT NOT NULL,
  -- U hodnoty: ke kterému parametru patří. U názvu prázdné.
  name_key TEXT NOT NULL DEFAULT '',
  -- Znění po jazycích: {"cz":"Barva","sk":"Farba","en":"Colour"}
  langs TEXT NOT NULL DEFAULT '{}',
  hits INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (kind, key, name_key)
);
CREATE INDEX IF NOT EXISTS idx_ptrans_params_use ON ptrans_params(kind, name_key, hits);

-- Přeložené odstavce (viz ptrans/reuse.ts).
--
-- Sourozenci v e-shopu (kravata v deseti barvách) mají popisy shodné až na
-- větu o barvě. Co už jednou přeložené je, dosadí se odsud a model dostane
-- jen to, čím se produkt liší. skey je otisk jazyka, rozsahu a textu;
-- source se drží kvůli kontrole, že otisk opravdu sedí.
CREATE TABLE IF NOT EXISTS ptrans_segments (
  lang TEXT NOT NULL,
  skey TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL,
  target TEXT NOT NULL,
  hits INTEGER NOT NULL DEFAULT 1,
  -- 1 = opravil člověk; překladač to nepřepíše
  manual INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (lang, skey)
);

-- Rejstřík podobných vět: dvě poloviny každé věty. Věta, která se od známé
-- liší jedním slovem (barvou), má jednu polovinu stejnou a najde se jedním
-- dotazem. Model pak dostane hotový překlad podobné věty jako vzor.
CREATE TABLE IF NOT EXISTS ptrans_seg_index (
  lang TEXT NOT NULL,
  skey TEXT NOT NULL,
  half INTEGER NOT NULL,
  scope TEXT NOT NULL,
  ntok INTEGER NOT NULL,
  hkey TEXT NOT NULL,
  PRIMARY KEY (lang, skey, half)
);
CREATE INDEX IF NOT EXISTS idx_ptrans_seg_index_find ON ptrans_seg_index(lang, scope, ntok, hkey);

-- Co už se paměť naučila z hotových překladů: otisk dvojice zdroj → překlad.
-- Při dalším průchodu (po stažení feedu) se nezměněné přeskočí — celý
-- katalog by jinak zabral vteřiny pokaždé.
CREATE TABLE IF NOT EXISTS ptrans_learned (
  code TEXT NOT NULL,
  lang TEXT NOT NULL,
  field TEXT NOT NULL,
  hash TEXT NOT NULL,
  PRIMARY KEY (code, lang, field)
);

CREATE TABLE IF NOT EXISTS ptrans_drafts (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  template TEXT NOT NULL DEFAULT '',
  data TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT '',
  exported_at TEXT
);
`;

/** Doplňkové sloupce pro databáze založené dřív — chyba „už existuje" je v pořádku. */
export const ALTERS = [
  `ALTER TABLE ptrans_products ADD COLUMN origin TEXT NOT NULL DEFAULT 'feed'`,
  `ALTER TABLE ptrans_products ADD COLUMN added_at TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE ptrans_fields ADD COLUMN messy INTEGER NOT NULL DEFAULT 0`,
  // Co v poli přišlo z paměti odstavců (JSON) — na zvýraznění v náhledu
  `ALTER TABLE ptrans_fields ADD COLUMN reuse_marks TEXT NOT NULL DEFAULT ''`,
  // Otisk textu, který byl v e-shopu, když aplikace pole přeložila (viz exportxml)
  `ALTER TABLE ptrans_fields ADD COLUMN base_hash TEXT`
];
