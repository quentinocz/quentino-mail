import Foundation

/**
 Schéma databáze — shodné se stolní verzí.

 Tabulky pošty (`messages`, `attachments`, `outbox`) přibudou spolu s IMAP;
 zatím jsou tu ty, které používají moduly běžící na iOS už teď. Názvy
 i sloupce se drží desktopu, aby záloha z jednoho zařízení sedla do druhého.
 */
enum Schema {
    static let sql = """
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
      position_cz TEXT NOT NULL DEFAULT '',
      position_sk TEXT NOT NULL DEFAULT '',
      position_en TEXT NOT NULL DEFAULT '',
      display_cz TEXT NOT NULL DEFAULT '',
      display_sk TEXT NOT NULL DEFAULT '',
      display_en TEXT NOT NULL DEFAULT '',
      photo_path TEXT
    );

    CREATE TABLE IF NOT EXISTS contacts (
      email TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      uses INTEGER NOT NULL DEFAULT 1,
      last_used TEXT NOT NULL DEFAULT (datetime('now'))
    );

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
      signature_logo TEXT,
      sig_json TEXT,
      color TEXT NOT NULL DEFAULT '#7c5cff'
    );

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
    CREATE INDEX IF NOT EXISTS idx_voucher_codes_claim ON voucher_codes(template_id, claimed_by, used_at);
    CREATE INDEX IF NOT EXISTS idx_voucher_codes_free ON voucher_codes(template_id, used_at);

    CREATE TABLE IF NOT EXISTS ig_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ig_user_id TEXT NOT NULL UNIQUE,
      username TEXT NOT NULL DEFAULT '',
      lang TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#7c5cff',
      is_source INTEGER NOT NULL DEFAULT 0,
      token_enc TEXT NOT NULL DEFAULT '',
      token_expires TEXT,
      connected_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_error TEXT,
      page_id TEXT NOT NULL DEFAULT '',
      page_name TEXT NOT NULL DEFAULT '',
      share_fb INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS ig_markets (
      lang TEXT PRIMARY KEY,
      label TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '',
      color TEXT NOT NULL DEFAULT '#7c5cff',
      enabled INTEGER NOT NULL DEFAULT 1,
      ord INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS ig_source_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ig_media_id TEXT NOT NULL UNIQUE,
      media_type TEXT NOT NULL DEFAULT 'IMAGE',
      permalink TEXT NOT NULL DEFAULT '',
      caption TEXT NOT NULL DEFAULT '',
      posted_at TEXT NOT NULL DEFAULT '',
      like_count INTEGER NOT NULL DEFAULT 0,
      comment_count INTEGER NOT NULL DEFAULT 0,
      children_json TEXT NOT NULL DEFAULT '[]',
      thumb_path TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ig_source_date ON ig_source_posts(posted_at DESC);

    CREATE TABLE IF NOT EXISTS ig_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL DEFAULT 'new',
      source_post_id INTEGER,
      brief TEXT NOT NULL DEFAULT '',
      media_note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      archived INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS ig_post_media (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      path TEXT NOT NULL DEFAULT '',
      mime TEXT NOT NULL DEFAULT '',
      is_video INTEGER NOT NULL DEFAULT 0,
      width INTEGER,
      height INTEGER,
      cover_offset REAL,
      source_url TEXT,
      public_url TEXT,
      storage_key TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ig_media_post ON ig_post_media(post_id, position);

    CREATE TABLE IF NOT EXISTS ig_captions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL,
      lang TEXT NOT NULL,
      variants_json TEXT NOT NULL DEFAULT '[]',
      chosen INTEGER NOT NULL DEFAULT 0,
      edited TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(post_id, lang)
    );

    CREATE TABLE IF NOT EXISTS ig_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      caption_id INTEGER NOT NULL,
      account_id INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'scheduled',
      scheduled_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      finished_at TEXT,
      container_id TEXT,
      ig_media_id TEXT,
      permalink TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      fb_post_id TEXT,
      fb_error TEXT,
      channels TEXT NOT NULL DEFAULT 'ig'
    );
    CREATE INDEX IF NOT EXISTS idx_ig_jobs_due ON ig_jobs(state, scheduled_at);

    -- Co už na kterém trhu vyšlo. Popisky a odeslané práce popisují práci na
    -- tomhle zařízení; tahle tabulka popisuje skutečnost venku na Instagramu,
    -- a ta je pro všechna zařízení stejná — proto se dá bezpečně slučovat.
    CREATE TABLE IF NOT EXISTS ig_published (
      source_media_id TEXT NOT NULL,
      lang TEXT NOT NULL,
      at TEXT NOT NULL DEFAULT '',
      permalink TEXT NOT NULL DEFAULT '',
      ig_media_id TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (source_media_id, lang)
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
      -- Kam odpovídat, když si to odesílatel přeje jinam než na svou adresu
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
      size INTEGER NOT NULL DEFAULT 0,
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
      path TEXT NOT NULL,
      cid TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_attachments_msg ON attachments(message_pk);

    CREATE TABLE IF NOT EXISTS outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      to_addr TEXT NOT NULL,
      cc TEXT NOT NULL DEFAULT '',
      bcc TEXT NOT NULL DEFAULT '',
      subject TEXT NOT NULL DEFAULT '',
      html TEXT NOT NULL DEFAULT '',
      attachments_json TEXT NOT NULL DEFAULT '[]',
      inline_json TEXT NOT NULL DEFAULT '[]',
      from_name TEXT,
      in_reply_to TEXT,
      refs TEXT,
      reply_to_db_id INTEGER,
      send_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'scheduled',
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sync_archive (
      key TEXT PRIMARY KEY
    );

    -- Objednávky u zpráv: uložené hotové karty, párování dotazů na objednávky
    -- a odškrtávání při balení. Stejné schéma jako na počítači, ať se databáze
    -- a zálohy dají přenášet oběma směry.
    CREATE TABLE IF NOT EXISTS packing (
      message_pk INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
      packed_json TEXT NOT NULL DEFAULT '[]',
      done INTEGER NOT NULL DEFAULT 0,
      done_at TEXT
    );

    CREATE TABLE IF NOT EXISTS order_cache (
      message_pk INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
      json TEXT,
      at TEXT NOT NULL
    );

    -- Objednávky z exportních feedů e-shopu. Stejná tabulka jako na počítači:
    -- kvůli telefonu na zákazníka, který v potvrzovacím e-mailu většinou není.
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
      seen_at TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (code, market)
    );
    CREATE INDEX IF NOT EXISTS idx_shop_orders_email ON shop_orders(email);
    CREATE INDEX IF NOT EXISTS idx_shop_orders_code ON shop_orders(code);

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

    CREATE TABLE IF NOT EXISTS ai_usage (
      month TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      calls INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (month, model)
    );
    """

    /// Spouští se po jednom a chyba „sloupec už existuje" se ignoruje.
    static let migrations: [String] = [
        "ALTER TABLE ig_accounts ADD COLUMN page_id TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE ig_accounts ADD COLUMN page_name TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE ig_accounts ADD COLUMN share_fb INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE messages ADD COLUMN reply_to TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE voucher_codes ADD COLUMN used_by TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE voucher_codes ADD COLUMN claimed_by TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE voucher_codes ADD COLUMN claimed_at TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE voucher_codes ADD COLUMN used_dup TEXT NOT NULL DEFAULT ''"
    ]
}
