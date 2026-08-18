import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { app, BrowserWindow } from 'electron';
import { getDb, getSetting, setSetting } from './db';
import { getSettings, saveSettings, listKnowledge, listPersons } from './settings';
import { listAccounts } from './accounts';
import { storeParsedMessage } from './imap';

/**
 * Synchronizace mezi zařízeními přes sdílenou složku (Dropbox, OneDrive, Google Drive,
 * Syncthing, NAS…). Záměrně se nesynchronizuje živá SQLite databáze — místo toho:
 *  - state.json  — nastavení, pravidla, znalosti, osoby; novější stav vyhrává (razítko)
 *  - contacts.json — našeptávač adres; slučuje se sjednocením (nikdy nic neztratí)
 *  - archive/    — archivované zprávy jako .eml; pouze se přidávají, takže nekolidují
 * Hesla účtů a Anthropic API klíč se ze zásady NEsynchronizují.
 */

function emit(channel: string, payload: unknown) {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload);
}

export interface SyncConfig {
  folder: string | null;
  enabled: boolean;
  lastRun: string | null;
  lastResult: string | null;
}

export function getSyncConfig(): SyncConfig {
  return {
    folder: getSetting('syncFolder'),
    enabled: getSetting('syncEnabled', '0') === '1',
    lastRun: getSetting('syncLastRun'),
    lastResult: getSetting('syncLastResult')
  };
}

export function saveSyncConfig(cfg: { folder?: string | null; enabled?: boolean }): SyncConfig {
  if (cfg.folder !== undefined) setSetting('syncFolder', cfg.folder ?? '');
  if (cfg.enabled !== undefined) setSetting('syncEnabled', cfg.enabled ? '1' : '0');
  if (!getSetting('stateStamp')) setSetting('stateStamp', new Date().toISOString());
  return getSyncConfig();
}

const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9@._-]/g, '_').slice(0, 80);
const hash = (s: string) => crypto.createHash('md5').update(s).digest('hex').slice(0, 12);

/* ---------- Stav (nastavení, znalosti, osoby) ---------- */

function writeState(dir: string, stamp: string) {
  const s = getSettings();
  const persons = listPersons().map(person => {
    let photoFile: string | null = null;
    if (person.photoPath && fs.existsSync(person.photoPath)) {
      photoFile = `${hash(person.name)}-${sanitize(path.basename(person.photoPath))}`;
      const dest = path.join(dir, 'media', photoFile);
      if (!fs.existsSync(dest)) {
        fs.mkdirSync(path.join(dir, 'media'), { recursive: true });
        fs.copyFileSync(person.photoPath, dest);
      }
    }
    return { name: person.name, positions: person.positions, displayNames: person.displayNames, photoFile };
  });
  const defaultPersonName = listPersons().find(x => x.id === s.defaultPersonId)?.name ?? null;
  const state = {
    app: 'quentino-mail-sync',
    version: 1,
    updatedAt: stamp,
    settings: { ...s, hasApiKey: undefined, anthropicApiKey: undefined, defaultPersonId: undefined },
    defaultPersonName,
    knowledge: listKnowledge().map(k => ({ title: k.title, content: k.content })),
    persons
  };
  const tmp = path.join(dir, 'state.json.tmp');
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1), 'utf8');
  fs.renameSync(tmp, path.join(dir, 'state.json'));
}

function applyState(dir: string, remote: any): void {
  const d = getDb();
  // Nastavení (bez klíčů a hesel)
  const { hasApiKey, anthropicApiKey, defaultPersonId, ...rest } = remote.settings ?? {};
  saveSettings(rest);
  // Znalosti — kompletní náhrada novějším stavem
  if (Array.isArray(remote.knowledge)) {
    d.prepare('DELETE FROM knowledge').run();
    const ins = d.prepare('INSERT INTO knowledge (title, content) VALUES (?,?)');
    for (const k of remote.knowledge) if (k?.title) ins.run(k.title, k.content ?? '');
  }
  // Osoby — kompletní náhrada, fotky ze složky media
  if (Array.isArray(remote.persons)) {
    d.prepare('DELETE FROM persons').run();
    const ins = d.prepare(
      'INSERT INTO persons (name, position, position_cz, position_sk, position_en, display_cz, display_sk, display_en, photo_path) VALUES (?,?,?,?,?,?,?,?,?)'
    );
    const photoDir = path.join(app.getPath('userData'), 'persons');
    for (const person of remote.persons) {
      if (!person?.name) continue;
      let photoPath: string | null = null;
      if (person.photoFile) {
        const src = path.join(dir, 'media', person.photoFile);
        if (fs.existsSync(src)) {
          fs.mkdirSync(photoDir, { recursive: true });
          photoPath = path.join(photoDir, person.photoFile);
          if (!fs.existsSync(photoPath)) fs.copyFileSync(src, photoPath);
        }
      }
      const pos = person.positions ?? { cz: '', sk: '', en: '' };
      const dn = person.displayNames ?? { cz: '', sk: '', en: '' };
      ins.run(person.name, pos.cz ?? '', pos.cz ?? '', pos.sk ?? '', pos.en ?? '', dn.cz ?? '', dn.sk ?? '', dn.en ?? '', photoPath);
    }
    // Výchozí osoba dle jména (ID se mezi zařízeními liší)
    if (remote.defaultPersonName) {
      const match = listPersons().find(x => x.name === remote.defaultPersonName);
      setSetting('defaultPersonId', String(match?.id ?? 0));
    }
  }
  // Razítko srovnat s aplikovaným stavem (saveSettings ho posunulo na "teď")
  setSetting('stateStamp', remote.updatedAt);
}

/* ---------- Poukazy: šablony a zásoba kódů (sjednocení) ---------- */

/**
 * Šablony a kódy se neslučují jako „novější stav vyhrává", ale po řádcích:
 *  - šablona: vyhrává novější `updated_at` (i smazání, to je jen příznak),
 *  - kód: použití vyhrává vždycky a platí dřívější čas.
 *
 * Kdyby se přenášel celý stav najednou, dvě zařízení by si navzájem přepsala
 * odepsané kódy a stejný kód by šel ven dvakrát.
 */
function syncVouchers(dir: string): void {
  const d = getDb();
  const file = path.join(dir, 'vouchers.json');
  let remote: any = null;
  try { remote = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* první běh */ }

  if (remote && Array.isArray(remote.templates)) {
    const upsert = d.prepare(
      `INSERT INTO voucher_templates (id, name, value, unit, valid_until, note, lang, code_mode, fixed_code, archived, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, value = excluded.value, unit = excluded.unit,
         valid_until = excluded.valid_until, note = excluded.note, lang = excluded.lang,
         code_mode = excluded.code_mode, fixed_code = excluded.fixed_code,
         archived = excluded.archived, updated_at = excluded.updated_at
       WHERE excluded.updated_at > voucher_templates.updated_at`
    );
    for (const t of remote.templates) {
      if (!t?.id || !t?.name) continue;
      upsert.run(
        t.id, t.name, t.value ?? '', t.unit ?? 'CZK', t.valid_until ?? '', t.note ?? '',
        t.lang ?? 'cz', t.code_mode ?? 'fixed', t.fixed_code ?? '', t.archived ?? 0,
        t.updated_at ?? new Date().toISOString()
      );
    }
  }

  if (remote && Array.isArray(remote.codes)) {
    const upsert = d.prepare(
      `INSERT INTO voucher_codes (template_id, code, used_at, used_for, created_at)
       VALUES (?,?,?,?,?)
       ON CONFLICT(template_id, code) DO UPDATE SET
         used_at = CASE
           WHEN voucher_codes.used_at IS NULL THEN excluded.used_at
           WHEN excluded.used_at IS NULL THEN voucher_codes.used_at
           WHEN excluded.used_at < voucher_codes.used_at THEN excluded.used_at
           ELSE voucher_codes.used_at
         END,
         used_for = CASE
           WHEN excluded.used_at IS NOT NULL
                AND (voucher_codes.used_at IS NULL OR excluded.used_at < voucher_codes.used_at)
             THEN excluded.used_for
           ELSE voucher_codes.used_for
         END`
    );
    for (const c of remote.codes) {
      if (!c?.template_id || !c?.code) continue;
      upsert.run(c.template_id, c.code, c.used_at ?? null, c.used_for ?? '', c.created_at ?? new Date().toISOString());
    }
  }

  const out = {
    templates: d.prepare('SELECT * FROM voucher_templates').all(),
    codes: d.prepare('SELECT * FROM voucher_codes').all()
  };
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(out), 'utf8');
  fs.renameSync(tmp, file);
}

/* ---------- Kontakty (sjednocení) ---------- */

function syncContacts(dir: string): void {
  const d = getDb();
  const file = path.join(dir, 'contacts.json');
  let remote: any[] = [];
  try { remote = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* první běh */ }
  if (Array.isArray(remote)) {
    const merge = d.prepare(
      `INSERT INTO contacts (email, name, uses, last_used) VALUES (?,?,?,?)
       ON CONFLICT(email) DO UPDATE SET
         uses = MAX(contacts.uses, excluded.uses),
         last_used = MAX(contacts.last_used, excluded.last_used),
         name = CASE WHEN contacts.name = '' THEN excluded.name ELSE contacts.name END`
    );
    for (const c of remote) {
      if (c?.email) merge.run(String(c.email).toLowerCase(), c.name ?? '', c.uses ?? 1, c.last_used ?? new Date().toISOString());
    }
  }
  const all = d.prepare('SELECT email, name, uses, last_used FROM contacts').all();
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(all), 'utf8');
  fs.renameSync(tmp, file);
}

/* ---------- Archiv (.eml, pouze přidávání) ---------- */

function archiveKey(row: any, accountEmail: string): string {
  return row.message_id ? hash(row.message_id) : hash(`${accountEmail}|${row.folder}|${row.uid}`);
}

async function syncArchive(dir: string): Promise<{ exported: number; imported: number }> {
  const d = getDb();
  const archDir = path.join(dir, 'archive');
  fs.mkdirSync(archDir, { recursive: true });
  const known = new Set((d.prepare('SELECT key FROM sync_archive').all() as any[]).map(r => r.key));
  const markKnown = d.prepare('INSERT OR IGNORE INTO sync_archive (key) VALUES (?)');
  const accounts = listAccounts();
  const emailById = new Map(accounts.map(a => [a.id, a.email]));
  let exported = 0;
  let imported = 0;

  // Export: lokálně archivované zprávy, které ještě ve sdílené složce nejsou
  const rows = d.prepare('SELECT * FROM messages WHERE archived = 1 AND raw_path IS NOT NULL').all() as any[];
  for (const row of rows) {
    if (!row.raw_path || !fs.existsSync(row.raw_path)) continue;
    const key = archiveKey(row, emailById.get(row.account_id) ?? '');
    if (known.has(key)) continue;
    const itemDir = path.join(archDir, key);
    fs.mkdirSync(itemDir, { recursive: true });
    fs.copyFileSync(row.raw_path, path.join(itemDir, 'raw.eml'));
    fs.writeFileSync(path.join(itemDir, 'meta.json'), JSON.stringify({
      key,
      messageId: row.message_id,
      accountEmail: emailById.get(row.account_id) ?? '',
      subject: row.subject,
      fromAddr: row.from_addr,
      fromName: row.from_name,
      toAddr: row.to_addr,
      date: row.date,
      category: row.category,
      summary: row.summary
    }), 'utf8');
    markKnown.run(key);
    known.add(key);
    exported++;
  }

  // Import: položky od druhého zařízení, které lokálně nemáme
  if (accounts.length > 0) {
    const localArchiveDir = path.join(app.getPath('userData'), 'archive');
    fs.mkdirSync(localArchiveDir, { recursive: true });
    for (const entry of fs.readdirSync(archDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || known.has(entry.name)) continue;
      const itemDir = path.join(archDir, entry.name);
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(itemDir, 'meta.json'), 'utf8'));
        const eml = fs.readFileSync(path.join(itemDir, 'raw.eml'));
        const account = accounts.find(a => a.email === meta.accountEmail) ?? accounts[0];
        // Duplicitní pojistka podle Message-ID
        if (meta.messageId && d.prepare('SELECT 1 FROM messages WHERE message_id = ? AND archived = 1').get(meta.messageId)) {
          markKnown.run(entry.name);
          known.add(entry.name);
          continue;
        }
        const uid = -Math.abs(Date.now() % 1_000_000_000) - imported; // unikátní záporné UID mimo server
        const info = d.prepare(
          `INSERT INTO messages (account_id, folder, uid, message_id, subject, from_addr, from_name, to_addr, date, snippet, seen, archived, category, summary, thread_key)
           VALUES (?,?,?,?,?,?,?,?,?,'',1,1,?,?,?)`
        ).run(
          account.id, '@archiv', uid, meta.messageId ?? '', meta.subject ?? '', meta.fromAddr ?? '', meta.fromName ?? '',
          meta.toAddr ?? '', meta.date ?? new Date().toISOString(), meta.category ?? null, meta.summary ?? null,
          (meta.messageId ?? entry.name).slice(0, 255)
        );
        const dbId = Number(info.lastInsertRowid);
        const localEml = path.join(localArchiveDir, `${dbId}.eml`);
        fs.writeFileSync(localEml, eml);
        d.prepare('UPDATE messages SET raw_path = ? WHERE id = ?').run(localEml, dbId);
        await storeParsedMessage(dbId, eml);
        markKnown.run(entry.name);
        known.add(entry.name);
        imported++;
      } catch { /* poškozená položka — přeskočit */ }
    }
  }
  return { exported, imported };
}

/* ---------- Hlavní běh ---------- */

let running = false;

export async function runSync(): Promise<string> {
  const cfg = getSyncConfig();
  if (!cfg.enabled || !cfg.folder) return 'Synchronizace není zapnutá.';
  if (running) return 'Synchronizace už běží.';
  if (!fs.existsSync(cfg.folder)) return 'Synchronizační složka není dostupná.';
  running = true;
  try {
    const dir = cfg.folder;
    const parts: string[] = [];

    // 1) Stav — novější vyhrává
    const localStamp = getSetting('stateStamp', '1970-01-01T00:00:00Z')!;
    let remote: any = null;
    try { remote = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')); } catch { /* zatím neexistuje */ }
    if (remote?.app === 'quentino-mail-sync' && remote.updatedAt > localStamp) {
      applyState(dir, remote);
      parts.push('nastavení přijato');
      emit('folders:changed', {});
    } else if (!remote || localStamp > (remote?.updatedAt ?? '')) {
      writeState(dir, localStamp);
      parts.push('nastavení odesláno');
    }

    // 2) Kontakty — sjednocení
    syncContacts(dir);

    // 3) Poukazy — šablony i odepsané kódy, po řádcích
    try {
      syncVouchers(dir);
    } catch (e: any) {
      parts.push(`poukazy: ${e?.message ?? e}`);
    }

    // 4) Archiv — oboustranné doplnění
    const arch = await syncArchive(dir);
    if (arch.exported) parts.push(`${arch.exported}× archiv odeslán`);
    if (arch.imported) {
      parts.push(`${arch.imported}× archiv přijat`);
      emit('messages:changed', {});
    }

    const summary = parts.length ? parts.join(', ') : 'vše aktuální';
    setSetting('syncLastRun', new Date().toISOString());
    setSetting('syncLastResult', summary);
    return summary;
  } catch (e: any) {
    setSetting('syncLastResult', `chyba: ${e?.message ?? e}`);
    throw e;
  } finally {
    running = false;
  }
}
