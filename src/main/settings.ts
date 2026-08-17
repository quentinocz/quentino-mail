import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { app } from 'electron';
import { getDb, getSetting, setSetting } from './db';
import { encrypt, decrypt } from './secure';
import { Settings, DEFAULT_BRAND_PROMPT, CategoryRule, KnowledgeDoc, Person } from '../shared/types';

const DEFAULT_RULES: CategoryRule[] = [
  { field: 'subject', contains: 'objednávk', category: 'orders' },
  { field: 'subject', contains: 'order', category: 'orders' },
  { field: 'subject', contains: 'faktura', category: 'companies' }
];

export function getSettings(): Settings {
  return {
    hasApiKey: !!getSetting('anthropicApiKey'),
    brandPrompt: getSetting('brandPrompt', DEFAULT_BRAND_PROMPT)!,
    draftModel: getSetting('draftModel', 'claude-sonnet-5')!,
    fastModel: getSetting('fastModel', 'claude-haiku-4-5-20251001')!,
    autoSummarize: getSetting('autoSummarize', '1') === '1',
    autoCategorize: getSetting('autoCategorize', '1') === '1',
    autoTranslate: getSetting('autoTranslate', '1') === '1',
    loadRemoteImages: getSetting('loadRemoteImages', '0') === '1',
    categoryRules: JSON.parse(getSetting('categoryRules', JSON.stringify(DEFAULT_RULES))!),
    autoSummarizeCategories: JSON.parse(getSetting('autoSummarizeCategories', '[]')!),
    contactInfo: getSetting('contactInfo', '')!,
    productFeedUrl: getSetting('productFeedUrl', 'https://www.quentino.cz/export-full-products-he7RJAV2iN.xml')!,
    adminOrderRef: getSetting('adminOrderRef', '')!,
    voucherLogo: getSetting('voucherLogo', '')!,
    defaultPersonId: (() => {
      const v = parseInt(getSetting('defaultPersonId', '0')!, 10);
      return v > 0 ? v : null;
    })(),
    theme: (getSetting('theme', 'light') === 'dark' ? 'dark' : 'light')
  };
}

export function saveSettings(s: Partial<Settings>) {
  if (s.anthropicApiKey !== undefined) {
    setSetting('anthropicApiKey', s.anthropicApiKey ? encrypt(s.anthropicApiKey) : '');
  }
  if (s.brandPrompt !== undefined) setSetting('brandPrompt', s.brandPrompt);
  if (s.draftModel !== undefined) setSetting('draftModel', s.draftModel);
  if (s.fastModel !== undefined) setSetting('fastModel', s.fastModel);
  if (s.autoSummarize !== undefined) setSetting('autoSummarize', s.autoSummarize ? '1' : '0');
  if (s.autoCategorize !== undefined) setSetting('autoCategorize', s.autoCategorize ? '1' : '0');
  if (s.autoTranslate !== undefined) setSetting('autoTranslate', s.autoTranslate ? '1' : '0');
  if (s.loadRemoteImages !== undefined) setSetting('loadRemoteImages', s.loadRemoteImages ? '1' : '0');
  if (s.categoryRules !== undefined) setSetting('categoryRules', JSON.stringify(s.categoryRules));
  if (s.autoSummarizeCategories !== undefined) setSetting('autoSummarizeCategories', JSON.stringify(s.autoSummarizeCategories));
  if (s.contactInfo !== undefined) setSetting('contactInfo', s.contactInfo);
  if (s.productFeedUrl !== undefined) setSetting('productFeedUrl', s.productFeedUrl);
  if (s.adminOrderRef !== undefined) setSetting('adminOrderRef', s.adminOrderRef.trim());
  if (s.voucherLogo !== undefined) setSetting('voucherLogo', s.voucherLogo);
  if (s.defaultPersonId !== undefined) setSetting('defaultPersonId', String(s.defaultPersonId ?? 0));
  if (s.theme !== undefined) setSetting('theme', s.theme);
  setSetting('stateStamp', new Date().toISOString());
}

/* ---------- Znalostní báze (obchodní podmínky, reklamační řád…) ---------- */

export function listKnowledge(): KnowledgeDoc[] {
  return getDb().prepare('SELECT id, title, content FROM knowledge ORDER BY id').all() as KnowledgeDoc[];
}

export function saveKnowledge(doc: { id?: number; title: string; content: string }): KnowledgeDoc[] {
  const d = getDb();
  if (doc.id) {
    d.prepare('UPDATE knowledge SET title = ?, content = ? WHERE id = ?').run(doc.title, doc.content, doc.id);
  } else {
    d.prepare('INSERT INTO knowledge (title, content) VALUES (?, ?)').run(doc.title, doc.content);
  }
  touchState();
  return listKnowledge();
}

export function deleteKnowledge(id: number): KnowledgeDoc[] {
  getDb().prepare('DELETE FROM knowledge WHERE id = ?').run(id);
  touchState();
  return listKnowledge();
}

/* ---------- Osoby pro podpisy ---------- */

export function listPersons(): Person[] {
  const rows = getDb().prepare(
    'SELECT id, name, position_cz, position_sk, position_en, display_cz, display_sk, display_en, photo_path FROM persons ORDER BY name'
  ).all() as any[];
  return rows.map(r => ({
    id: r.id,
    name: r.name,
    positions: { cz: r.position_cz ?? '', sk: r.position_sk ?? '', en: r.position_en ?? '' },
    displayNames: { cz: r.display_cz ?? '', sk: r.display_sk ?? '', en: r.display_en ?? '' },
    photoPath: r.photo_path
  }));
}

/** Fotku zkopírujeme do dat aplikace, aby podpis fungoval i po přesunutí originálu. */
function importPhoto(src: string | null | undefined): string | null {
  if (!src) return null;
  const dir = path.join(app.getPath('userData'), 'persons');
  if (src.startsWith(dir)) return src;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, `${Date.now()}-${path.basename(src)}`);
    fs.copyFileSync(src, dest);
    return dest;
  } catch {
    return src;
  }
}

export function savePerson(p: {
  id?: number; name: string;
  positions: { cz: string; sk: string; en: string };
  displayNames?: { cz: string; sk: string; en: string };
  photoPath?: string | null;
}): Person[] {
  const d = getDb();
  const photo = importPhoto(p.photoPath);
  const dn = p.displayNames ?? { cz: '', sk: '', en: '' };
  if (p.id) {
    d.prepare(
      'UPDATE persons SET name = ?, position_cz = ?, position_sk = ?, position_en = ?, display_cz = ?, display_sk = ?, display_en = ?, photo_path = ? WHERE id = ?'
    ).run(p.name, p.positions.cz, p.positions.sk, p.positions.en, dn.cz, dn.sk, dn.en, photo, p.id);
  } else {
    d.prepare(
      'INSERT INTO persons (name, position, position_cz, position_sk, position_en, display_cz, display_sk, display_en, photo_path) VALUES (?,?,?,?,?,?,?,?,?)'
    ).run(p.name, p.positions.cz, p.positions.cz, p.positions.sk, p.positions.en, dn.cz, dn.sk, dn.en, photo);
  }
  touchState();
  return listPersons();
}

export function deletePerson(id: number): Person[] {
  getDb().prepare('DELETE FROM persons WHERE id = ?').run(id);
  touchState();
  return listPersons();
}

/* ---------- Export / import kompletního nastavení ---------- */

/**
 * Záloha je úplná: celá tabulka nastavení, účty i s hesly, API klíče, znalostní báze,
 * osoby a **všechny obrázky** (logo v podpisu, fotky osob, logo na poukazech) zabalené
 * do jednoho souboru jako base64. Po importu na jiném počítači tedy nezbývá nic doplňovat.
 *
 * Citlivé údaje (hesla, API klíče) se ukládají odděleně v bloku `secrets` a dají se
 * zamknout heslem (AES-256-GCM). Bez hesla jsou v souboru čitelné — proto je záloha
 * něco, s čím se zachází jako s trezorem.
 */

/** Klíče, které nesou tajemství — v souboru jsou dešifrované v `secrets`, ne v `settings`. */
const SECRET_SETTING_KEYS = ['anthropicApiKey', 'upgatesKey'];

/** Provozní hodnoty, které nemá smysl přenášet (razítka synchronizace apod.). */
const VOLATILE_SETTING_KEYS = ['stateStamp', 'ftsBuilt', 'productFeedSync', 'productFeedSchema', 'appsyncLastRun', 'appsyncLastResult'];

/** Strop pro vkládané obrázky — záloha má zůstat rozumně velká. */
const MAX_EMBED_BYTES = 12 * 1024 * 1024;

interface EmbeddedFile { name: string; data: string }

function embedFile(files: Record<string, EmbeddedFile>, filePath: string | null | undefined, id: string): string | null {
  if (!filePath) return null;
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile() || st.size > MAX_EMBED_BYTES) return null;
    files[id] = { name: path.basename(filePath), data: fs.readFileSync(filePath).toString('base64') };
    return id;
  } catch {
    return null; // soubor mezitím zmizel — zálohu to nezastaví
  }
}

function restoreFile(files: any, ref: string | null | undefined, subdir: string): string | null {
  if (!ref || !files || !files[ref]?.data) return null;
  try {
    const dir = path.join(app.getPath('userData'), subdir);
    fs.mkdirSync(dir, { recursive: true });
    const safe = String(files[ref].name || 'obrazek').replace(/[^\w.\-]/g, '_');
    const dest = path.join(dir, `${Date.now()}-${safe}`);
    fs.writeFileSync(dest, Buffer.from(files[ref].data, 'base64'));
    return dest;
  } catch {
    return null;
  }
}

function seal(obj: unknown, passphrase: string): object {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(passphrase, salt, 32);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return {
    alg: 'aes-256-gcm',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: c.getAuthTag().toString('base64'),
    data: data.toString('base64')
  };
}

function unseal(box: any, passphrase: string): any {
  try {
    const key = crypto.scryptSync(passphrase, Buffer.from(box.salt, 'base64'), 32);
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
    d.setAuthTag(Buffer.from(box.tag, 'base64'));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(box.data, 'base64')), d.final()]).toString('utf8'));
  } catch {
    throw new Error('Špatné heslo k záloze — údaje se nepodařilo rozšifrovat.');
  }
}

/** Je záloha zamčená heslem? */
export function configNeedsPassphrase(data: any): boolean {
  return !!data?.encrypted;
}

export function exportConfig(passphrase?: string): object {
  const d = getDb();
  const files: Record<string, EmbeddedFile> = {};

  // Celá tabulka nastavení 1:1 — přenese se i to, co nemá políčko v UI
  const settings: Record<string, string> = {};
  const secrets: Record<string, any> = { accountPasswords: {} };
  for (const r of d.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]) {
    if (VOLATILE_SETTING_KEYS.includes(r.key)) continue;
    if (SECRET_SETTING_KEYS.includes(r.key)) {
      try { secrets[r.key] = r.value ? decrypt(r.value) : ''; } catch { secrets[r.key] = ''; }
      continue;
    }
    settings[r.key] = r.value;
  }

  // Logo na dárkových poukazech
  const voucherLogoFile = embedFile(files, settings.voucherLogo, 'voucher-logo');

  // Účty i s hesly a logem v podpisu
  const accounts = (d.prepare('SELECT * FROM accounts ORDER BY id').all() as any[]).map((a, i) => {
    let password = '';
    try { password = a.pass_enc ? decrypt(a.pass_enc) : ''; } catch { /* z jiné keychain se nepřečte */ }
    secrets.accountPasswords[a.email] = password;
    return {
      name: a.name,
      email: a.email,
      imap_host: a.imap_host,
      imap_port: a.imap_port,
      imap_secure: a.imap_secure,
      smtp_host: a.smtp_host,
      smtp_port: a.smtp_port,
      smtp_secure: a.smtp_secure,
      username: a.username,
      signature_html: a.signature_html ?? '',
      sig_json: a.sig_json ?? null,
      color: a.color ?? '#7c5cff',
      signature_logo: a.signature_logo ?? null,
      logoFile: embedFile(files, a.signature_logo, `account-logo-${i}`)
    };
  });

  // Osoby i s fotkami do podpisu
  const persons = listPersons().map((p, i) => ({
    name: p.name,
    positions: p.positions,
    displayNames: p.displayNames,
    photoPath: p.photoPath,
    photoFile: embedFile(files, p.photoPath, `person-photo-${i}`)
  }));

  return {
    app: 'quentino-mail',
    version: 2,
    exportedAt: new Date().toISOString(),
    encrypted: !!passphrase,
    settings,
    voucherLogoFile,
    knowledge: listKnowledge().map(k => ({ title: k.title, content: k.content })),
    persons,
    accounts,
    files,
    secrets: passphrase ? seal(secrets, passphrase) : secrets
  };
}

export function importConfig(data: any, passphrase?: string): string {
  if (!data || data.app !== 'quentino-mail') throw new Error('Neplatný soubor s nastavením');
  const d = getDb();
  const parts: string[] = [];
  const files = data.files ?? {};

  const secrets: Record<string, any> = data.encrypted
    ? unseal(data.secrets, passphrase ?? '')
    : (data.secrets ?? {});
  const accountPasswords: Record<string, string> = secrets.accountPasswords ?? {};

  /* ---- Nastavení ---- */
  if (data.settings) {
    if (data.version >= 2) {
      // Nová záloha: přenese se celá tabulka nastavení tak, jak byla
      for (const [key, value] of Object.entries(data.settings as Record<string, string>)) {
        if (VOLATILE_SETTING_KEYS.includes(key)) continue;
        setSetting(key, String(value ?? ''));
      }
      const voucherLogo = restoreFile(files, data.voucherLogoFile, 'vouchers');
      if (voucherLogo) setSetting('voucherLogo', voucherLogo);
      parts.push('nastavení');
    } else {
      const { hasApiKey, anthropicApiKey, ...rest } = data.settings;
      saveSettings(rest);
      parts.push('nastavení');
    }
  }

  /* ---- Tajemství: API klíče ---- */
  for (const key of SECRET_SETTING_KEYS) {
    if (typeof secrets[key] === 'string' && secrets[key]) {
      setSetting(key, encrypt(secrets[key]));
      parts.push(key === 'anthropicApiKey' ? 'API klíč' : 'Upgates klíč');
    }
  }

  /* ---- Znalostní báze (bez duplikátů podle názvu) ---- */
  if (Array.isArray(data.knowledge)) {
    let n = 0;
    for (const k of data.knowledge) {
      if (!k?.title || !k?.content) continue;
      const exists = d.prepare('SELECT id FROM knowledge WHERE title = ?').get(k.title) as { id: number } | undefined;
      if (exists) d.prepare('UPDATE knowledge SET content = ? WHERE id = ?').run(k.content, exists.id);
      else d.prepare('INSERT INTO knowledge (title, content) VALUES (?,?)').run(k.title, k.content);
      n++;
    }
    if (n) parts.push(`${n}× znalost`);
  }

  /* ---- Osoby včetně fotek ---- */
  if (Array.isArray(data.persons)) {
    let n = 0;
    for (const p of data.persons) {
      if (!p?.name) continue;
      const pos = p.positions ?? { cz: p.position ?? '', sk: '', en: '' };
      const dn = p.displayNames ?? { cz: '', sk: '', en: '' };
      const photo = restoreFile(files, p.photoFile, 'persons') ?? p.photoPath ?? null;
      const exists = d.prepare('SELECT id FROM persons WHERE name = ?').get(p.name) as { id: number } | undefined;
      if (exists) {
        d.prepare(
          'UPDATE persons SET position_cz=?, position_sk=?, position_en=?, display_cz=?, display_sk=?, display_en=?, photo_path=COALESCE(?, photo_path) WHERE id=?'
        ).run(pos.cz ?? '', pos.sk ?? '', pos.en ?? '', dn.cz ?? '', dn.sk ?? '', dn.en ?? '', photo, exists.id);
      } else {
        d.prepare(
          'INSERT INTO persons (name, position, position_cz, position_sk, position_en, display_cz, display_sk, display_en, photo_path) VALUES (?,?,?,?,?,?,?,?,?)'
        ).run(p.name, pos.cz ?? '', pos.cz ?? '', pos.sk ?? '', pos.en ?? '', dn.cz ?? '', dn.sk ?? '', dn.en ?? '', photo);
      }
      n++;
    }
    if (n) parts.push(`${n}× osoba`);
  }

  /* ---- Účty včetně hesel a loga v podpisu ---- */
  if (Array.isArray(data.accounts)) {
    let added = 0;
    let updated = 0;
    let missingPass = 0;
    for (const a of data.accounts) {
      if (!a?.email) continue;
      const password = accountPasswords[a.email] ?? '';
      if (!password) missingPass++;
      const logo = restoreFile(files, a.logoFile, 'logos') ?? a.signature_logo ?? null;
      const exists = d.prepare('SELECT id, pass_enc FROM accounts WHERE email = ?').get(a.email) as { id: number; pass_enc: string } | undefined;
      if (exists) {
        // Prázdné heslo v záloze nesmí přepsat funkční heslo, které tu už je
        const passEnc = password ? encrypt(password) : exists.pass_enc;
        d.prepare(
          `UPDATE accounts SET name=?, imap_host=?, imap_port=?, imap_secure=?, smtp_host=?, smtp_port=?, smtp_secure=?, username=?,
             pass_enc=?, signature_html=?, signature_logo=?, sig_json=?, color=? WHERE id=?`
        ).run(
          a.name, a.imap_host, a.imap_port, a.imap_secure, a.smtp_host, a.smtp_port, a.smtp_secure, a.username,
          passEnc, a.signature_html ?? '', logo, a.sig_json ?? null, a.color ?? '#7c5cff', exists.id
        );
        updated++;
      } else {
        d.prepare(
          `INSERT INTO accounts (name, email, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure, username, pass_enc, signature_html, signature_logo, sig_json, color)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        ).run(
          a.name, a.email, a.imap_host, a.imap_port, a.imap_secure, a.smtp_host, a.smtp_port, a.smtp_secure,
          a.username, encrypt(password), a.signature_html ?? '', logo, a.sig_json ?? null, a.color ?? '#7c5cff'
        );
        added++;
      }
    }
    if (added) parts.push(`${added}× nový účet`);
    if (updated) parts.push(`${updated}× aktualizovaný účet`);
    if (missingPass) parts.push(`u ${missingPass} účtů chybí heslo — doplň ho ručně`);
  }

  const embedded = Object.keys(files).length;
  if (embedded) parts.push(`${embedded}× obrázek`);

  touchState();
  return parts.length ? `Importováno: ${parts.join(', ')}.` : 'V souboru nebylo co importovat.';
}

export function getApiKey(): string | null {
  const stored = getSetting('anthropicApiKey');
  if (!stored) return null;
  return decrypt(stored);
}

/** Zvedne razítko lokálního stavu — synchronizace pozná, že je co odeslat. */
export function touchState(): void {
  setSetting('stateStamp', new Date().toISOString());
}
