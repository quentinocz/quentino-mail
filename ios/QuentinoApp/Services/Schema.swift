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
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (template_id, code)
    );
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
        "ALTER TABLE ig_accounts ADD COLUMN share_fb INTEGER NOT NULL DEFAULT 0"
    ]
}
