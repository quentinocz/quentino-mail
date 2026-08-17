import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { getDb } from './db';
import { encrypt, decrypt } from './secure';
import { AccountConfig, AccountPublic, SigConfig } from '../shared/types';

/**
 * Logo podpisu si držíme v datech aplikace — stejně jako fotky osob.
 *
 * Dokud se ukládala jen cesta k původnímu souboru, stačilo logo přesunout, smazat,
 * nebo ho nechat vystrčit z iCloudu, a do odeslaného e-mailu se pak vložila prázdná
 * příloha: zpráva došla, ale logo v podpisu chybělo.
 */
function logoDir(): string {
  return path.join(app.getPath('userData'), 'logos');
}

function importLogo(src: string | null | undefined): string | null {
  if (!src) return null;
  const dir = logoDir();
  if (src.startsWith(dir)) return src;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, `${Date.now()}-${path.basename(src)}`);
    fs.copyFileSync(src, dest);
    return dest;
  } catch {
    return src; // radši původní cesta než žádné logo
  }
}

let logosChecked = false;

/** Jednorázově přestěhuje loga starších účtů do dat aplikace a zapomene ta, která zmizela. */
function ensureLocalLogos(): void {
  if (logosChecked) return;
  logosChecked = true;
  try {
    const d = getDb();
    const rows = d.prepare('SELECT id, signature_logo FROM accounts WHERE signature_logo IS NOT NULL AND signature_logo != \'\'').all() as
      { id: number; signature_logo: string }[];
    for (const r of rows) {
      if (r.signature_logo.startsWith(logoDir())) continue;
      const moved = fs.existsSync(r.signature_logo) ? importLogo(r.signature_logo) : null;
      // Soubor je pryč → cestu zahodíme, ať se místo loga neposílá prázdná příloha
      d.prepare('UPDATE accounts SET signature_logo = ? WHERE id = ?').run(moved, r.id);
    }
  } catch { /* nekritické — podpis se jen vykreslí bez loga */ }
}

/** Načte sig_json a zmigruje starší tvar (name/email jako string) na jazykové varianty. */
function parseSigConfig(json: string | null): SigConfig | null {
  if (!json) return null;
  try {
    const raw = JSON.parse(json);
    const rec = (v: any): Record<'cz' | 'sk' | 'en', string> =>
      typeof v === 'string' ? { cz: v, sk: v, en: v } : { cz: '', sk: '', en: '', ...(v ?? {}) };
    return {
      phone: raw.phone ?? '',
      names: rec(raw.names ?? raw.name ?? ''),
      emails: rec(raw.emails ?? raw.email ?? ''),
      taglines: rec(raw.taglines ?? ''),
      webs: rec(raw.webs ?? '')
    };
  } catch {
    return null;
  }
}

interface AccountRow {
  id: number;
  name: string;
  email: string;
  imap_host: string;
  imap_port: number;
  imap_secure: number;
  smtp_host: string;
  smtp_port: number;
  smtp_secure: number;
  username: string;
  pass_enc: string;
  signature_html: string;
  signature_logo: string | null;
  sig_json: string | null;
  color: string;
}

function toPublic(r: AccountRow): AccountPublic {
  // Chybějící soubor hlásíme jako „logo není" — jinak by se do e-mailu vložil prázdný obrázek
  const logo = r.signature_logo && fs.existsSync(r.signature_logo) ? r.signature_logo : null;
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    imapHost: r.imap_host,
    imapPort: r.imap_port,
    imapSecure: !!r.imap_secure,
    smtpHost: r.smtp_host,
    smtpPort: r.smtp_port,
    smtpSecure: !!r.smtp_secure,
    username: r.username,
    signatureHtml: r.signature_html,
    sigConfig: parseSigConfig(r.sig_json),
    logoPath: logo,
    color: r.color
  };
}

export function listAccounts(): AccountPublic[] {
  ensureLocalLogos();
  const rows = getDb().prepare('SELECT * FROM accounts ORDER BY id').all() as AccountRow[];
  return rows.map(toPublic);
}

export function getAccountWithPassword(id: number): (AccountPublic & { password: string }) | null {
  const r = getDb().prepare('SELECT * FROM accounts WHERE id = ?').get(id) as AccountRow | undefined;
  if (!r) return null;
  return { ...toPublic(r), password: decrypt(r.pass_enc) };
}

export function saveAccount(cfg: AccountConfig): AccountPublic {
  const d = getDb();
  if (cfg.id) {
    const existing = d.prepare('SELECT pass_enc FROM accounts WHERE id = ?').get(cfg.id) as { pass_enc: string } | undefined;
    const passEnc = cfg.password ? encrypt(cfg.password) : existing?.pass_enc ?? encrypt('');
    d.prepare(
      `UPDATE accounts SET name=?, email=?, imap_host=?, imap_port=?, imap_secure=?, smtp_host=?, smtp_port=?, smtp_secure=?, username=?, pass_enc=?, signature_html=?, signature_logo=?, sig_json=?, color=? WHERE id=?`
    ).run(
      cfg.name, cfg.email, cfg.imapHost, cfg.imapPort, cfg.imapSecure ? 1 : 0,
      cfg.smtpHost, cfg.smtpPort, cfg.smtpSecure ? 1 : 0,
      cfg.username, passEnc, cfg.signatureHtml, importLogo(cfg.logoPath),
      cfg.sigConfig ? JSON.stringify(cfg.sigConfig) : null, cfg.color, cfg.id
    );
    return listAccounts().find(a => a.id === cfg.id)!;
  }
  const info = d.prepare(
    `INSERT INTO accounts(name, email, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure, username, pass_enc, signature_html, signature_logo, sig_json, color)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    cfg.name, cfg.email, cfg.imapHost, cfg.imapPort, cfg.imapSecure ? 1 : 0,
    cfg.smtpHost, cfg.smtpPort, cfg.smtpSecure ? 1 : 0,
    cfg.username, encrypt(cfg.password ?? ''), cfg.signatureHtml, importLogo(cfg.logoPath),
    cfg.sigConfig ? JSON.stringify(cfg.sigConfig) : null, cfg.color
  );
  return listAccounts().find(a => a.id === Number(info.lastInsertRowid))!;
}

export function deleteAccount(id: number) {
  const d = getDb();
  d.prepare('DELETE FROM attachments WHERE message_pk IN (SELECT id FROM messages WHERE account_id = ?)').run(id);
  d.prepare('DELETE FROM messages WHERE account_id = ?').run(id);
  d.prepare('DELETE FROM outbox WHERE account_id = ?').run(id);
  d.prepare('DELETE FROM accounts WHERE id = ?').run(id);
}
