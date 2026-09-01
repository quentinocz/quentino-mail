import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import { igSchema, igAlters } from './instagram/schema';
import { SCHEMA as ptransSchema, ALTERS as ptransAlters } from './ptrans/schema';
import { SCHEMA as artSchema, ALTERS as artAlters } from './articles/schema';

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    const dir = app.getPath('userData');
    fs.mkdirSync(dir, { recursive: true });
    db = new Database(path.join(dir, 'quentino-mail.db'));
    db.pragma('journal_mode = WAL');
    migrate(db);
  }
  return db;
}

function migrate(d: Database.Database) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      imap_host TEXT NOT NULL,
      imap_port INTEGER NOT NULL,
      imap_secure INTEGER NOT NULL DEFAULT 1,
      smtp_host TEXT NOT NULL,
      smtp_port INTEGER NOT NULL,
      smtp_secure INTEGER NOT NULL DEFAULT 1,
      username TEXT NOT NULL,
      pass_enc TEXT NOT NULL,
      signature_html TEXT NOT NULL DEFAULT '',
      color TEXT NOT NULL DEFAULT '#7c5cff'
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      folder TEXT NOT NULL,
      uid INTEGER NOT NULL,
      message_id TEXT NOT NULL DEFAULT '',
      subject TEXT NOT NULL DEFAULT '',
      from_addr TEXT NOT NULL DEFAULT '',
      from_name TEXT NOT NULL DEFAULT '',
      -- Kam odpovídat, když si to odesílatel přeje jinam než na svou adresu.
      -- Používají to hromadné rozesílky i formuláře na webu, které jen
      -- přeposílají zprávu od zákazníka.
      reply_to TEXT NOT NULL DEFAULT '',
      to_addr TEXT NOT NULL DEFAULT '',
      cc TEXT NOT NULL DEFAULT '',
      date TEXT NOT NULL DEFAULT '',
      snippet TEXT NOT NULL DEFAULT '',
      body_html TEXT,
      body_text TEXT,
      seen INTEGER NOT NULL DEFAULT 0,
      flagged INTEGER NOT NULL DEFAULT 0,
      answered INTEGER NOT NULL DEFAULT 0,
      has_attachments INTEGER NOT NULL DEFAULT 0,
      thread_key TEXT NOT NULL DEFAULT '',
      category TEXT,
      summary TEXT,
      detected_lang TEXT,
      translation_cz TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      raw_path TEXT,
      fetched_full INTEGER NOT NULL DEFAULT 0,
      UNIQUE(account_id, folder, uid)
    );
    CREATE INDEX IF NOT EXISTS idx_messages_list ON messages(account_id, folder, date DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_key);
    CREATE INDEX IF NOT EXISTS idx_messages_msgid ON messages(message_id);

    CREATE TABLE IF NOT EXISTS attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_pk INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      mime TEXT NOT NULL DEFAULT 'application/octet-stream',
      size INTEGER NOT NULL DEFAULT 0,
      path TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      to_addr TEXT NOT NULL,
      cc TEXT NOT NULL DEFAULT '',
      bcc TEXT NOT NULL DEFAULT '',
      subject TEXT NOT NULL DEFAULT '',
      html TEXT NOT NULL DEFAULT '',
      attachments_json TEXT NOT NULL DEFAULT '[]',
      in_reply_to TEXT,
      refs TEXT,
      reply_to_db_id INTEGER,
      send_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'scheduled',
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS knowledge (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS persons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      position TEXT NOT NULL DEFAULT '',
      photo_path TEXT
    );

    CREATE TABLE IF NOT EXISTS products (
      code TEXT PRIMARY KEY,
      title_cz TEXT NOT NULL DEFAULT '',
      url_cz TEXT NOT NULL DEFAULT '',
      price_cz TEXT NOT NULL DEFAULT '',
      title_sk TEXT NOT NULL DEFAULT '',
      url_sk TEXT NOT NULL DEFAULT '',
      price_sk TEXT NOT NULL DEFAULT '',
      title_en TEXT NOT NULL DEFAULT '',
      url_en TEXT NOT NULL DEFAULT '',
      price_en TEXT NOT NULL DEFAULT '',
      image TEXT,
      category TEXT NOT NULL DEFAULT '',
      categories TEXT NOT NULL DEFAULT '',
      manufacturer TEXT NOT NULL DEFAULT '',
      availability TEXT NOT NULL DEFAULT '',
      stock INTEGER,
      price_num REAL
    );
    CREATE INDEX IF NOT EXISTS idx_products_title ON products(title_cz);

    -- Varianty produktu (velikost, délka, barva). Mají vlastní kód i vlastní
    -- sklad: „skladem 3 ks" u produktu neříká nic o tom, jestli je skladem
    -- zrovna ta velikost, kterou zákazník chce.
    CREATE TABLE IF NOT EXISTS product_variants (
      code TEXT PRIMARY KEY,
      product_code TEXT NOT NULL,
      variant_id TEXT NOT NULL DEFAULT '',
      label TEXT NOT NULL DEFAULT '',
      ean TEXT NOT NULL DEFAULT '',
      availability TEXT NOT NULL DEFAULT '',
      stock INTEGER,
      price TEXT NOT NULL DEFAULT '',
      main INTEGER NOT NULL DEFAULT 0,
      sort INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_variants_product ON product_variants(product_code);

    -- Naskladnění: co se právě naskladňuje. Řádky jsou samostatně, aby se dala
    -- rozpracované naskladnění slučovat mezi zařízeními (telefon → počítač).
    CREATE TABLE IF NOT EXISTS stockin (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      device TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT '',
      sent_at TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS stockin_items (
      session_id TEXT NOT NULL,
      code TEXT NOT NULL,
      product_code TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      label TEXT NOT NULL DEFAULT '',
      qty INTEGER NOT NULL DEFAULT 0,
      -- Zásoba v okamžiku načtení: po odeslání je z čeho poznat, že se
      -- mezitím prodalo, a nepřepsat tím sklad naslepo
      stock_before INTEGER,
      added_at TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (session_id, code)
    );
    CREATE INDEX IF NOT EXISTS idx_stockin_items ON stockin_items(session_id);

    CREATE TABLE IF NOT EXISTS contacts (
      email TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      uses INTEGER NOT NULL DEFAULT 1,
      last_used TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sync_archive (
      key TEXT PRIMARY KEY
    );

    CREATE TABLE IF NOT EXISTS packing (
      message_pk INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
      packed_json TEXT NOT NULL DEFAULT '[]',
      done INTEGER NOT NULL DEFAULT 0,
      done_at TEXT
    );

    /*
     * Odškrtávání u objednávek, ke kterým nemáme e-mail.
     *
     * Balení dosud stálo na potvrzovacím mailu — jenže načtená faktura bývá
     * i půl roku stará a takový mail už ve schránce být nemusí. Feed
     * objednávek má přitom všechno, co je k balení potřeba, včetně kódů
     * variant. Stav odškrtání se proto u těchhle objednávek vede tady, ne
     * v tabulce packing, kde je klíčem zpráva.
     *
     * Vlastní id je tu kvůli rozhraní: to pracuje s číslem, ne s dvojicí
     * kód + trh, a záporná hodnota mu říká, že objednávka je z feedu.
     */
    CREATE TABLE IF NOT EXISTS packing_shop (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL,
      market TEXT NOT NULL DEFAULT '',
      packed_json TEXT NOT NULL DEFAULT '[]',
      counts_json TEXT NOT NULL DEFAULT '{}',
      done INTEGER NOT NULL DEFAULT 0,
      done_at TEXT,
      UNIQUE (code, market)
    );

    CREATE TABLE IF NOT EXISTS order_cache (
      message_pk INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
      json TEXT,
      at TEXT NOT NULL
    );

    -- Objednávky stažené z exportních feedů e-shopu.
    --
    -- Až dosud se objednávky skládaly z potvrzovacích e-mailů. To stačí na
    -- to, co bylo v mailu, ale telefon tam většinou není — a právě ten je
    -- potřeba, když chce člověk zákazníkovi rovnou zavolat. Feed má úplná
    -- data a je levný: stáhne se celý a přepíše se, co se změnilo.
    --
    -- Klíč je číslo objednávky plus trh. Čísla se totiž mezi doménami
    -- opakují — objednávka 023687 existuje v CZ i v SK a je pokaždé jiná.
    CREATE TABLE IF NOT EXISTS shop_orders (
      code TEXT NOT NULL,
      market TEXT NOT NULL DEFAULT 'cz',
      status TEXT NOT NULL DEFAULT '',
      paid INTEGER NOT NULL DEFAULT 0,
      paid_date TEXT NOT NULL DEFAULT '',
      resolved INTEGER NOT NULL DEFAULT 0,
      invoice TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT '',
      currency TEXT NOT NULL DEFAULT '',
      total REAL NOT NULL DEFAULT 0,
      tracking TEXT NOT NULL DEFAULT '',
      customer_id TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      shipment TEXT NOT NULL DEFAULT '',
      payment TEXT NOT NULL DEFAULT '',
      items_json TEXT NOT NULL DEFAULT '[]',
      billing_json TEXT,
      postal_json TEXT,
      seen_at TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (code, market)
    );
    -- Hledá se skoro vždycky podle e-mailu zákazníka nebo podle čísla
    CREATE INDEX IF NOT EXISTS idx_shop_orders_email ON shop_orders(email);
    CREATE INDEX IF NOT EXISTS idx_shop_orders_code ON shop_orders(code);
    CREATE INDEX IF NOT EXISTS idx_shop_orders_phone ON shop_orders(phone);
    CREATE INDEX IF NOT EXISTS idx_shop_orders_created ON shop_orders(created_at DESC);

    CREATE TABLE IF NOT EXISTS order_index (
      order_number TEXT PRIMARY KEY,
      customer_email TEXT NOT NULL DEFAULT '',
      message_pk INTEGER NOT NULL,
      date TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_order_index_email ON order_index(customer_email);

    CREATE TABLE IF NOT EXISTS order_link (
      message_pk INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
      order_number TEXT NOT NULL DEFAULT '',
      order_msg_pk INTEGER,
      resolved INTEGER NOT NULL DEFAULT 0,
      resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_order_link_open ON order_link(resolved);

    CREATE TABLE IF NOT EXISTS ship_phase (
      skeleton TEXT PRIMARY KEY,
      phase TEXT NOT NULL,
      sample TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'ai',
      at TEXT NOT NULL
    );

    -- Šablony dárkových poukazů a zásoba kódů k nim.
    -- Klíč je UUID, aby šlo šablony slučovat mezi zařízeními bez kolizí ID.
    CREATE TABLE IF NOT EXISTS voucher_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      value TEXT NOT NULL DEFAULT '',
      unit TEXT NOT NULL DEFAULT 'CZK',
      valid_until TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      lang TEXT NOT NULL DEFAULT 'cz',
      code_mode TEXT NOT NULL DEFAULT 'fixed',
      fixed_code TEXT NOT NULL DEFAULT '',
      archived INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS voucher_codes (
      template_id TEXT NOT NULL,
      code TEXT NOT NULL,
      used_at TEXT,
      used_for TEXT NOT NULL DEFAULT '',
      -- Které zařízení kód vydalo. Kdyby ho omylem vydala dvě, pozná se to
      -- podle dvou různých zařízení u jednoho kódu a aplikace to nahlásí.
      used_by TEXT NOT NULL DEFAULT '',
      -- Rezervace: zařízení si kód zamluví dřív, než ho vydá, a vydává jen
      -- ze svých zamluvených. Bez toho by dvě zařízení sáhla po tomtéž
      -- „prvním volném" kódu dřív, než se stihnou domluvit.
      claimed_by TEXT NOT NULL DEFAULT '',
      claimed_at TEXT NOT NULL DEFAULT '',
      -- Kdyby přes všechnu opatrnost jeden kód vydala dvě zařízení, zapíše se
      -- sem to druhé („zařízení@čas") a aplikace na to upozorní.
      used_dup TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (template_id, code)
    );
    CREATE INDEX IF NOT EXISTS idx_voucher_codes_free ON voucher_codes(template_id, used_at);

    CREATE TABLE IF NOT EXISTS ai_usage (
      month TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      calls INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (month, model)
    );
  `);
  // Překlady produktů: katalog z feedu, jednotlivá pole po jazycích a běhy
  d.exec(ptransSchema);
  for (const sql of ptransAlters) {
    try { d.exec(sql); } catch { /* sloupec už existuje */ }
  }
  // Články: zadání, jazykové verze, kontrola odkazů a mapa adres mezi trhy
  d.exec(artSchema);
  for (const sql of artAlters) {
    try { d.exec(sql); } catch { /* sloupec už existuje */ }
  }
  // Instagram: účty, trhy, příspěvky, popisky a fronta publikací
  d.exec(igSchema);
  for (const sql of igAlters) {
    try { d.exec(sql); } catch { /* sloupec už existuje */ }
  }

  // Fulltextové vyhledávání (FTS5) nad zprávami
  d.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      subject, from_name, from_addr, body_text,
      content='messages', content_rowid='id'
    );
    CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, subject, from_name, from_addr, body_text)
      VALUES (new.id, new.subject, new.from_name, new.from_addr, coalesce(new.body_text,''));
    END;
    CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, subject, from_name, from_addr, body_text)
      VALUES ('delete', old.id, old.subject, old.from_name, old.from_addr, coalesce(old.body_text,''));
    END;
    CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, subject, from_name, from_addr, body_text)
      VALUES ('delete', old.id, old.subject, old.from_name, old.from_addr, coalesce(old.body_text,''));
      INSERT INTO messages_fts(rowid, subject, from_name, from_addr, body_text)
      VALUES (new.id, new.subject, new.from_name, new.from_addr, coalesce(new.body_text,''));
    END;
  `);
  try {
    const built = d.prepare("SELECT value FROM settings WHERE key = 'ftsBuilt'").get() as any;
    if (!built) {
      d.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
      d.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES('ftsBuilt','1')").run();
    }
  } catch { /* rebuild při příštím startu */ }

  // Doplňkové migrace pro existující databáze
  try { d.exec('ALTER TABLE accounts ADD COLUMN signature_logo TEXT'); } catch { /* sloupec už existuje */ }
  try { d.exec('ALTER TABLE attachments ADD COLUMN cid TEXT'); } catch { /* sloupec už existuje */ }
  try { d.exec("ALTER TABLE outbox ADD COLUMN inline_json TEXT NOT NULL DEFAULT '[]'"); } catch { /* sloupec už existuje */ }
  try { d.exec('ALTER TABLE accounts ADD COLUMN sig_json TEXT'); } catch { /* sloupec už existuje */ }
  try { d.exec("ALTER TABLE persons ADD COLUMN position_cz TEXT NOT NULL DEFAULT ''"); } catch { /* sloupec už existuje */ }
  try { d.exec("ALTER TABLE persons ADD COLUMN position_sk TEXT NOT NULL DEFAULT ''"); } catch { /* sloupec už existuje */ }
  try { d.exec("ALTER TABLE persons ADD COLUMN position_en TEXT NOT NULL DEFAULT ''"); } catch { /* sloupec už existuje */ }
  try { d.exec("UPDATE persons SET position_cz = position WHERE position_cz = '' AND position != ''"); } catch { /* starý sloupec neexistuje */ }
  try { d.exec("ALTER TABLE persons ADD COLUMN display_cz TEXT NOT NULL DEFAULT ''"); } catch { /* sloupec už existuje */ }
  try { d.exec("ALTER TABLE persons ADD COLUMN display_sk TEXT NOT NULL DEFAULT ''"); } catch { /* sloupec už existuje */ }
  try { d.exec("ALTER TABLE persons ADD COLUMN display_en TEXT NOT NULL DEFAULT ''"); } catch { /* sloupec už existuje */ }
  try { d.exec("ALTER TABLE outbox ADD COLUMN from_name TEXT"); } catch { /* sloupec už existuje */ }
  try { d.exec('ALTER TABLE messages ADD COLUMN size INTEGER NOT NULL DEFAULT 0'); } catch { /* sloupec už existuje */ }
  try { d.exec("ALTER TABLE messages ADD COLUMN reply_to TEXT NOT NULL DEFAULT ''"); } catch { /* sloupec už existuje */ }
  try { d.exec("ALTER TABLE voucher_codes ADD COLUMN used_by TEXT NOT NULL DEFAULT ''"); } catch { /* sloupec už existuje */ }
  try { d.exec("ALTER TABLE voucher_codes ADD COLUMN claimed_by TEXT NOT NULL DEFAULT ''"); } catch { /* sloupec už existuje */ }
  try { d.exec("ALTER TABLE voucher_codes ADD COLUMN claimed_at TEXT NOT NULL DEFAULT ''"); } catch { /* sloupec už existuje */ }
  try { d.exec("ALTER TABLE voucher_codes ADD COLUMN used_dup TEXT NOT NULL DEFAULT ''"); } catch { /* sloupec už existuje */ }
  // Až tady, ne u tabulky: v databázi z minulé verze sloupec `claimed_by`
  // ještě není a rejstřík nad chybějícím sloupcem shodí celé zakládání —
  // aplikace by se spustila a neotevřela okno.
  try { d.exec('CREATE INDEX IF NOT EXISTS idx_voucher_codes_claim ON voucher_codes(template_id, claimed_by, used_at)'); } catch { /* index už existuje */ }

  // Katalog produktů: kategorie a dostupnost pro prohlížeč produktů v kompozeru.
  // Hodnoty se doplní při nejbližší synchronizaci feedu (feedNeedsCategories()).
  try { d.exec("ALTER TABLE products ADD COLUMN category TEXT NOT NULL DEFAULT ''"); } catch { /* sloupec už existuje */ }
  try { d.exec("ALTER TABLE products ADD COLUMN categories TEXT NOT NULL DEFAULT ''"); } catch { /* sloupec už existuje */ }
  try { d.exec("ALTER TABLE products ADD COLUMN manufacturer TEXT NOT NULL DEFAULT ''"); } catch { /* sloupec už existuje */ }
  try { d.exec("ALTER TABLE products ADD COLUMN availability TEXT NOT NULL DEFAULT ''"); } catch { /* sloupec už existuje */ }
  try { d.exec('ALTER TABLE products ADD COLUMN stock INTEGER'); } catch { /* sloupec už existuje */ }
  try { d.exec('ALTER TABLE products ADD COLUMN price_num REAL'); } catch { /* sloupec už existuje */ }
  try { d.exec("ALTER TABLE products ADD COLUMN ean TEXT NOT NULL DEFAULT ''"); } catch { /* sloupec už existuje */ }
  try { d.exec("ALTER TABLE products ADD COLUMN product_id TEXT NOT NULL DEFAULT ''"); } catch { /* sloupec už existuje */ }
  /*
   * Kdy dorazila čerstvá zásoba z rychlého feedu.
   *
   * Není to totéž co načtení katalogu: celý feed s obrázky a popisy se stahuje
   * jednou za den, zásoba každé dvě hodiny. Plést to dohromady by znamenalo
   * tvrdit „skladem" podle čísla starého půl dne.
   */
  try { d.exec("ALTER TABLE products ADD COLUMN stock_at TEXT NOT NULL DEFAULT ''"); } catch { /* sloupec už existuje */ }
  /*
   * Podoba produktu, ve které se dá hledat.
   *
   * `LIKE` porovnává znak po znaku, takže „ksandy" nenajde „Kšandy" a
   * „ps120sm120" nenajde „PS120SM-120" — u regálu ale nikdo nepřepíná
   * klávesnici ani netrefí pomlčku na správné místo. Sloupec proto drží text
   * bez diakritiky, malými písmeny a zvlášť i bez oddělovačů, a jsou v něm
   * i kódy variant, aby se dala najít konkrétní délka.
   *
   * Prázdno znamená „ještě se nespočítalo" a doplní se při prvním hledání.
   */
  try { d.exec("ALTER TABLE products ADD COLUMN search TEXT NOT NULL DEFAULT ''"); } catch { /* sloupec už existuje */ }
  /*
   * Balení po kusech, ne po položkách. Dřív se odškrtávala celá položka, takže
   * u „3 ks" nebylo z čeho poznat, kolik jich už je v krabici — a při balení
   * je právě tohle to jediné, co se počítá.
   */
  try { d.exec("ALTER TABLE packing ADD COLUMN counts_json TEXT NOT NULL DEFAULT '{}'"); } catch { /* sloupec už existuje */ }
  /*
   * Adresy z feedu objednávek.
   *
   * Balení se přestěhovalo z potvrzovacích e-mailů na feed — ten je rychlejší
   * a úplnější, ale dokud se z něj nečetly adresy, chyběla na kartě ta jediná
   * věc, kterou při balení člověk opisuje.
   */
  try { d.exec("ALTER TABLE shop_orders ADD COLUMN billing_json TEXT"); } catch { /* sloupec už existuje */ }
  try { d.exec("ALTER TABLE shop_orders ADD COLUMN postal_json TEXT"); } catch { /* sloupec už existuje */ }
  try { d.exec('CREATE INDEX IF NOT EXISTS idx_products_category ON products(category)'); } catch { /* index už existuje */ }
}

export function getSetting(key: string, fallback: string | null = null): string | null {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? row.value : fallback;
}

export function setSetting(key: string, value: string) {
  getDb()
    .prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}
