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

/**
 * Klíč v systémové klíčence je vázaný na název aplikace. Po přejmenování
 * (nebo po přenesení dat na jiný počítač) jsou uložená hesla a klíče
 * nečitelná — pozná se to tak, že hodnota v databázi je, ale rozšifrovat
 * se nedá. Rozhraní pak místo záhadných chyb nabídne obnovení ze zálohy.
 */
export function secretsLocked(): boolean {
  const stored = getSetting('anthropicApiKey', '')!
    || (getDb().prepare('SELECT pass_enc FROM accounts LIMIT 1').get() as any)?.pass_enc
    || '';
  if (!stored || !stored.startsWith('enc:')) return false;
  return decrypt(stored) === '';
}

export function getSettings(): Settings {
  return {
    hasApiKey: !!getSetting('anthropicApiKey'),
    secretsLocked: secretsLocked(),
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
    productFeedUrl: getSetting('productFeedUrl', '')!,
    adminOrderRef: getSetting('adminOrderRef', '')!,
    voucherLogo: getSetting('voucherLogo', '')!,
    notifyNewMail: getSetting('notifyNewMail', '1') === '1',
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
  if (s.notifyNewMail !== undefined) setSetting('notifyNewMail', s.notifyNewMail ? '1' : '0');
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
const SECRET_SETTING_KEYS = [
  'anthropicApiKey', 'upgatesKey',
  // Instagram a chat: v databázi jsou zašifrované systémovou klíčenkou, která
  // na jiném počítači nefunguje — do zálohy proto patří rozšifrované
  'igAppSecret', 'igStorageKey', 'igUserToken', 'chatAnonKey',
  // Adresy feedů objednávek nesou tajný klíč, takže se v databázi drží
  // zašifrované. Bez tohohle zápisu by se do zálohy dostala jen nečitelná
  // šifra a na druhém zařízení by se feedy tvářily jako nenastavené.
  'orderFeeds'
];

/** Popisky do hlášky po importu. */
const SECRET_LABELS: Record<string, string> = {
  anthropicApiKey: 'API klíč',
  upgatesKey: 'Upgates klíč',
  orderFeeds: 'feedy objednávek',
  igAppSecret: 'Meta aplikace',
  igStorageKey: 'úložiště médií',
  igUserToken: 'přístup k Instagramu',
  chatAnonKey: 'klíč k chatu'
};

/**
 * Provozní hodnoty, které nemá smysl přenášet.
 *
 * Jsou to razítka „kdy jsem naposledy něco stáhl" a výsledky posledních běhů.
 * Přenést je na jiné zařízení by znamenalo, že se tam aplikace bude tvářit
 * jako čerstvě synchronizovaná a první stažení odloží — přitom nemá nic.
 */
const VOLATILE_SETTING_KEYS = [
  'stateStamp', 'ftsBuilt', 'contactsBackfilled',
  'productFeedSync', 'productFeedSchema',
  'syncLastRun', 'syncLastResult',
  'ptransSyncedAt', 'ptransStateRules',
  // Totožnost zařízení do zálohy nepatří: po obnovení na druhém počítači by
  // obě zařízení tvrdila, že jsou totéž, psala si do stejného deníku a
  // sahala si po týchž zamluvených kódech poukazů.
  'deviceId', 'deviceName'
];

/** Totéž, ale klíčů je celá řada — jeden na každý feed objednávek. */
const VOLATILE_SETTING_PREFIXES = ['orderFeedSync:', 'orderFeedError:'];

function isVolatile(key: string): boolean {
  return VOLATILE_SETTING_KEYS.includes(key)
    || VOLATILE_SETTING_PREFIXES.some(prefix => key.startsWith(prefix));
}

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
  const secrets: Record<string, any> = { accountPasswords: {}, igTokens: {} };
  for (const r of d.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]) {
    if (isVolatile(r.key)) continue;
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

  // Instagram: účty i s přístupem, trhy a barvy
  const igAccounts = (d.prepare('SELECT * FROM ig_accounts ORDER BY id').all() as any[]).map(a => {
    try {
      secrets.igTokens[a.ig_user_id] = a.token_enc ? decrypt(a.token_enc) : '';
    } catch {
      secrets.igTokens[a.ig_user_id] = '';
    }
    return {
      ig_user_id: a.ig_user_id, username: a.username, lang: a.lang, color: a.color,
      is_source: a.is_source, token_expires: a.token_expires,
      page_id: a.page_id ?? '', page_name: a.page_name ?? '', share_fb: a.share_fb ?? 0
    };
  });
  const igMarkets = d.prepare('SELECT * FROM ig_markets ORDER BY ord, lang').all() as any[];

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
    igAccounts,
    igMarkets,
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
  const igTokens: Record<string, string> = secrets.igTokens ?? {};

  /* ---- Nastavení ---- */
  if (data.settings) {
    if (data.version >= 2) {
      // Nová záloha: přenese se celá tabulka nastavení tak, jak byla
      for (const [key, value] of Object.entries(data.settings as Record<string, string>)) {
        if (isVolatile(key)) continue;
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
      parts.push(SECRET_LABELS[key] ?? key);
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

  /* ---- Instagram: trhy a účty ---- */
  if (Array.isArray(data.igMarkets)) {
    for (const m of data.igMarkets) {
      if (!m?.lang) continue;
      d.prepare(
        `INSERT INTO ig_markets (lang, label, note, tags, color, enabled, ord)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(lang) DO UPDATE SET label=excluded.label, note=excluded.note,
           tags=excluded.tags, color=excluded.color, enabled=excluded.enabled, ord=excluded.ord`
      ).run(m.lang, m.label ?? '', m.note ?? '', m.tags ?? '', m.color ?? '#7c5cff', m.enabled ?? 1, m.ord ?? 0);
    }
    if (data.igMarkets.length) parts.push(`${data.igMarkets.length}× trh`);
  }

  if (Array.isArray(data.igAccounts)) {
    let n = 0;
    for (const a of data.igAccounts) {
      if (!a?.ig_user_id) continue;
      const token = igTokens[a.ig_user_id] ?? '';
      d.prepare(
        `INSERT INTO ig_accounts (ig_user_id, username, lang, color, is_source, token_enc, token_expires, page_id, page_name, share_fb)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(ig_user_id) DO UPDATE SET
           username=excluded.username, lang=excluded.lang, color=excluded.color,
           is_source=excluded.is_source, token_expires=excluded.token_expires,
           page_id=excluded.page_id, page_name=excluded.page_name, share_fb=excluded.share_fb,
           token_enc=CASE WHEN excluded.token_enc = '' THEN ig_accounts.token_enc ELSE excluded.token_enc END`
      ).run(
        a.ig_user_id, a.username ?? '', a.lang ?? 'CS', a.color ?? '#7c5cff', a.is_source ?? 0,
        token ? encrypt(token) : '', a.token_expires ?? null,
        a.page_id ?? '', a.page_name ?? '', a.share_fb ?? 0
      );
      n++;
    }
    if (n) parts.push(`${n}× instagramový účet`);
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
