/**
 * Články pro e-shop.
 *
 * Článek je jedna věc v několika jazycích — proto `art_articles` drží zadání
 * (téma, produkty, obrázky, prompt) a `art_langs` jednotlivé jazykové verze.
 * Rozepsané a hotové články se neliší tabulkou, jen stavem: rozdělávat a
 * vracet se k tomu je běžný způsob práce, ne výjimka.
 *
 * `art_urlmap` je mapa odkazů mezi jazyky. Články na e-shopu odkazují na
 * produkty a kategorie a ty mají v každém jazyce jinou adresu; mapa se plní
 * z už přeložených článků (stejný článek ve dvou jazycích = dvojice adres)
 * a z produktové databáze.
 */

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS art_articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id TEXT,
  topic TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',
  source_lang TEXT NOT NULL DEFAULT 'cz',
  word_count INTEGER NOT NULL DEFAULT 600,
  langs TEXT NOT NULL DEFAULT '[]',
  prompt TEXT NOT NULL DEFAULT '',
  brief TEXT NOT NULL DEFAULT '{}',
  terms TEXT NOT NULL DEFAULT '',
  raw_xml TEXT,
  origin TEXT NOT NULL DEFAULT 'new',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS art_articles_status ON art_articles(status);
CREATE UNIQUE INDEX IF NOT EXISTS art_articles_upgates ON art_articles(article_id) WHERE article_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS art_langs (
  article_id INTEGER NOT NULL,
  lang TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  slug TEXT NOT NULL DEFAULT '',
  short TEXT NOT NULL DEFAULT '',
  long TEXT NOT NULL DEFAULT '',
  seo_title TEXT NOT NULL DEFAULT '',
  seo_desc TEXT NOT NULL DEFAULT '',
  seo_url TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'empty',
  updated_at TEXT,
  PRIMARY KEY (article_id, lang)
);

CREATE TABLE IF NOT EXISTS art_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id INTEGER NOT NULL,
  lang TEXT NOT NULL,
  url TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'other',
  status INTEGER,
  suggestion TEXT,
  note TEXT,
  checked_at TEXT
);
CREATE INDEX IF NOT EXISTS art_links_article ON art_links(article_id);
CREATE INDEX IF NOT EXISTS art_links_url ON art_links(url);

CREATE TABLE IF NOT EXISTS art_urlmap (
  from_lang TEXT NOT NULL,
  from_path TEXT NOT NULL,
  to_lang TEXT NOT NULL,
  to_path TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'other',
  hits INTEGER NOT NULL DEFAULT 1,
  locked INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT,
  PRIMARY KEY (from_lang, from_path, to_lang)
);
`;

/** Doplňky ke starším databázím. Selhání se ignoruje — sloupec už existuje. */
export const ALTERS = [
  `ALTER TABLE art_articles ADD COLUMN origin TEXT NOT NULL DEFAULT 'new'`,
  `ALTER TABLE art_articles ADD COLUMN terms TEXT NOT NULL DEFAULT ''`
];
