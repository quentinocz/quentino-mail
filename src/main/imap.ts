import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import path from 'path';
import fs from 'fs';
import { app, BrowserWindow } from 'electron';
import { getDb } from './db';
import { getAccountWithPassword, listAccounts } from './accounts';
import { FolderInfo, MessageFull, MessageHeader, AttachmentInfo } from '../shared/types';
import { autoProcessNewMessages } from './ai';
import { rememberContact, rememberAddressList } from './contacts';
import { getCaCertificates } from './systemca';
import { replyAddress, formContact } from './formmail';

const SYNC_HEADERS_LIMIT = 300; // kolik posledních zpráv na složku synchronizujeme

const syncing = new Map<number, boolean>();
const folderCache = new Map<number, FolderInfo[]>();

function emit(channel: string, payload: unknown) {
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send(channel, payload);
  }
}

/**
 * Když počítač usne, server spojení utne a socket vyhodí ECONNRESET mimo náš
 * await. Neodchycená událost „error" na EventEmitteru shodí celý proces, proto
 * ji každý klient musí mít obslouženou — chyba se pak projeví jen tím, že
 * probíhající operace selže a příští synchronizace naváže nové spojení.
 */
function silenceSocketErrors(client: ImapFlow): void {
  client.on('error', () => { /* spojení je mrtvé, další pokus si otevře nové */ });
}

async function withClient<T>(accountId: number, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const acc = getAccountWithPassword(accountId);
  if (!acc) throw new Error('Účet nenalezen');
  const client = new ImapFlow({
    host: acc.imapHost,
    port: acc.imapPort,
    secure: acc.imapSecure,
    auth: { user: acc.username, pass: acc.password },
    tls: { ca: getCaCertificates() },
    logger: false,
    socketTimeout: 60_000
  });
  silenceSocketErrors(client);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    try {
      await client.logout();
    } catch {
      client.close();
    }
  }
}

export async function testConnection(cfg: {
  imapHost: string; imapPort: number; imapSecure: boolean; username: string; password: string;
}): Promise<void> {
  const client = new ImapFlow({
    host: cfg.imapHost,
    port: cfg.imapPort,
    secure: cfg.imapSecure,
    auth: { user: cfg.username, pass: cfg.password },
    tls: { ca: getCaCertificates() },
    logger: false,
    socketTimeout: 20_000
  });
  silenceSocketErrors(client);
  await client.connect();
  await client.logout();
}

export async function listFolders(accountId: number, refresh = false): Promise<FolderInfo[]> {
  if (!refresh && folderCache.has(accountId)) return folderCache.get(accountId)!;
  const folders = await withClient(accountId, async client => {
    const list = await client.list();
    const out: FolderInfo[] = [];
    for (const f of list) {
      if (f.flags?.has('\\Noselect')) continue;
      let unseen = 0;
      let total = 0;
      try {
        const st = await client.status(f.path, { messages: true, unseen: true });
        unseen = st.unseen ?? 0;
        total = st.messages ?? 0;
      } catch {
        /* některé složky status nepodporují */
      }
      out.push({ path: f.path, name: f.name, specialUse: f.specialUse ?? null, unseen, total });
    }
    // INBOX první, pak speciální složky, pak abecedně
    const rank = (fi: FolderInfo) =>
      fi.path.toUpperCase() === 'INBOX' ? 0
      : fi.specialUse === '\\Sent' ? 1
      : fi.specialUse === '\\Drafts' ? 2
      : fi.specialUse === '\\Archive' ? 3
      : fi.specialUse === '\\Junk' ? 4
      : fi.specialUse === '\\Trash' ? 5
      : 6;
    out.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, 'cs'));
    return out;
  });
  folderCache.set(accountId, folders);
  return folders;
}

export function getSpecialFolder(accountId: number, use: string): string | null {
  const folders = folderCache.get(accountId);
  const hit = folders?.find(f => f.specialUse === use);
  if (hit) return hit.path;
  // heuristika podle názvu
  const names: Record<string, string[]> = {
    '\\Sent': ['sent', 'odeslan'],
    '\\Trash': ['trash', 'deleted', 'kos', 'koš'],
    '\\Drafts': ['draft', 'koncept'],
    '\\Archive': ['archive', 'archiv']
  };
  const cands = names[use] ?? [];
  const byName = folders?.find(f => cands.some(c => f.path.toLowerCase().includes(c)));
  return byName?.path ?? null;
}

/** Synchronizace hlaviček zpráv pro jednu složku účtu. */
export async function syncFolder(accountId: number, folder: string): Promise<void> {
  const syncKey = `${accountId}:${folder}` as unknown as number; // klíč per účet+složka
  if (syncing.get(syncKey)) return;
  syncing.set(syncKey, true);
  emit('sync:state', { accountId, syncing: true, error: null });
  try {
    await withClient(accountId, async client => {
      const lock = await client.getMailboxLock(folder);
      try {
        const st = await client.status(folder, { messages: true, uidNext: true });
        const total = st.messages ?? 0;
        if (total === 0) return;
        const startSeq = Math.max(1, total - SYNC_HEADERS_LIMIT + 1);
        const d = getDb();
        const upsert = d.prepare(`
          INSERT INTO messages (account_id, folder, uid, message_id, subject, from_addr, from_name, reply_to, to_addr, cc, date, seen, flagged, answered, has_attachments, thread_key, snippet, size)
          VALUES (@account_id, @folder, @uid, @message_id, @subject, @from_addr, @from_name, @reply_to, @to_addr, @cc, @date, @seen, @flagged, @answered, @has_attachments, @thread_key, '', @size)
          ON CONFLICT(account_id, folder, uid) DO UPDATE SET
            seen = excluded.seen, flagged = excluded.flagged, answered = excluded.answered, size = excluded.size
        `);
        const existsStmt = d.prepare('SELECT 1 FROM messages WHERE account_id = ? AND folder = ? AND uid = ?');
        const seenUids: number[] = [];
        for await (const msg of client.fetch(`${startSeq}:*`, {
          uid: true, flags: true, envelope: true, bodyStructure: true, size: true
        })) {
          const env = msg.envelope ?? {};
          const from = env.from?.[0];
          // Našeptávač adres: pamatujeme si odesílatele i příjemce nových zpráv
          if (!existsStmt.get(accountId, folder, msg.uid)) {
            if (from?.address) rememberContact(from.address, from.name ?? '');
            for (const rcpt of env.to ?? []) {
              if (rcpt.address) rememberContact(rcpt.address, rcpt.name ?? '');
            }
          }
          const flags = msg.flags ?? new Set<string>();
          const hasAtt = detectAttachments(msg.bodyStructure);
          const threadKey = (env.inReplyTo || env.messageId || `uid-${msg.uid}`)
            .replace(/[<>]/g, '')
            .slice(0, 255);
          upsert.run({
            account_id: accountId,
            folder,
            uid: msg.uid,
            message_id: (env.messageId ?? '').replace(/[<>]/g, ''),
            subject: env.subject ?? '(bez předmětu)',
            from_addr: from?.address ?? '',
            from_name: from?.name ?? '',
            // Hlavička Reply-To: když ji odesílatel pošle, odpověď patří tam.
            // Bez toho by odpověď na rozesílku šla na „noreply" adresu.
            // Typy imapflow ji v obálce nevyjmenovávají, i když ji server
            // posílá, proto to přetypování.
            reply_to: ((env as any).replyTo ?? [])
              .map((a: any) => a.address).filter(Boolean).join(', '),
            to_addr: (env.to ?? []).map(a => a.address).filter(Boolean).join(', '),
            cc: (env.cc ?? []).map(a => a.address).filter(Boolean).join(', '),
            date: env.date ? new Date(env.date).toISOString() : new Date().toISOString(),
            seen: flags.has('\\Seen') ? 1 : 0,
            flagged: flags.has('\\Flagged') ? 1 : 0,
            answered: flags.has('\\Answered') ? 1 : 0,
            has_attachments: hasAtt ? 1 : 0,
            thread_key: threadKey,
            size: msg.size ?? 0
          });
          seenUids.push(msg.uid);
        }
        // Smazat lokální záznamy zpráv, které už na serveru (v rozsahu) nejsou
        if (seenUids.length > 0) {
          const minUid = Math.min(...seenUids);
          const placeholders = seenUids.map(() => '?').join(',');
          d.prepare(
            `DELETE FROM messages WHERE account_id = ? AND folder = ? AND uid >= ? AND uid NOT IN (${placeholders}) AND archived = 0`
          ).run(accountId, folder, minUid, ...seenUids);
        }
      } finally {
        lock.release();
      }
    });
    emit('sync:state', { accountId, syncing: false, error: null, lastSync: new Date().toISOString() });
    emit('messages:changed', { accountId, folder });
    // AI zpracování nových zpráv (kategorie, shrnutí) běží na pozadí
    autoProcessNewMessages(accountId, folder, (dbId) => getMessageFull(dbId)).catch(() => {});
  } catch (e: any) {
    emit('sync:state', { accountId, syncing: false, error: e?.message ?? String(e) });
    throw e;
  } finally {
    syncing.set(syncKey, false);
  }
}

function detectAttachments(struct: any): boolean {
  if (!struct) return false;
  if (struct.disposition === 'attachment') return true;
  if (Array.isArray(struct.childNodes)) return struct.childNodes.some((c: any) => detectAttachments(c));
  return false;
}

export async function syncAllAccounts(): Promise<void> {
  for (const acc of listAccounts()) {
    try {
      await listFolders(acc.id, true);
      emit('folders:changed', { accountId: acc.id });
      await syncFolder(acc.id, 'INBOX');
    } catch {
      /* chyba už byla nahlášena přes sync:state */
    }
  }
}

const SORT_SQL: Record<string, string> = {
  date_desc: 'date DESC',
  date_asc: 'date ASC',
  size_desc: 'size DESC',
  size_asc: 'size ASC',
  from_az: "COALESCE(NULLIF(from_name,''), from_addr) COLLATE NOCASE ASC, date DESC"
};

export function listMessages(accountId: number, folder: string, opts: {
  category?: string | null; search?: string; limit?: number; offset?: number; archivedOnly?: boolean;
  sort?: string; unread?: boolean; flagged?: boolean; attachments?: boolean;
  /** Jen zprávy k objednávkám */
  orderInbox?: boolean;
  /** Včetně vyřízených a zodpovězených */
  orderAll?: boolean;
}): MessageHeader[] {
  const d = getDb();
  const cond: string[] = [];
  const params: any[] = [];
  if (opts.archivedOnly) {
    cond.push('archived = 1');
    if (accountId > 0) { cond.push('account_id = ?'); params.push(accountId); }
  } else {
    cond.push('account_id = ? AND folder = ? AND archived IN (0,1)');
    params.push(accountId, folder);
  }
  if (opts.category) { cond.push('category = ?'); params.push(opts.category); }
  if (opts.unread) cond.push('seen = 0');
  if (opts.flagged) cond.push('flagged = 1');
  if (opts.attachments) cond.push('has_attachments = 1');
  // Složka „K objednávkám": zprávy s vazbou na objednávku, na které se ještě neodpovědělo
  if (opts.orderInbox) {
    cond.push('ol.message_pk IS NOT NULL');
    // Výchozí je jen to, co čeká na odpověď; s „orderAll" se ukáže celá historie
    if (!opts.orderAll) cond.push('ol.resolved = 0 AND answered = 0');
  }
  const order = SORT_SQL[opts.sort ?? 'date_desc'] ?? SORT_SQL.date_desc;
  const select = (extraCond: string, extraParams: any[]) => d.prepare(
    `SELECT id, account_id, folder, uid, message_id, subject, from_addr, from_name, to_addr, date, snippet,
            seen, flagged, answered, has_attachments, category, summary, archived, thread_key, size,
            ol.order_number AS order_number, ol.order_msg_pk AS order_msg_pk, ol.resolved AS order_resolved
     FROM messages LEFT JOIN order_link ol ON ol.message_pk = messages.id
     WHERE ${[...cond, ...(extraCond ? [extraCond] : [])].join(' AND ')}
     ORDER BY ${order} LIMIT ? OFFSET ?`
  ).all(...params, ...extraParams, opts.limit ?? 200, opts.offset ?? 0) as any[];

  let rows: any[];
  if (opts.search?.trim()) {
    // Fulltext přes FTS5 (prefixové hledání); při chybě dotazu fallback na LIKE
    const ftsQuery = opts.search.trim().split(/\s+/).filter(Boolean)
      .map(t => `"${t.replace(/"/g, '')}"*`).join(' ');
    try {
      rows = select('messages.id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)', [ftsQuery]);
    } catch {
      const q = `%${opts.search}%`;
      rows = select('(subject LIKE ? OR from_addr LIKE ? OR from_name LIKE ? OR body_text LIKE ?)', [q, q, q, q]);
    }
  } else {
    rows = select('', []);
  }
  return rows.map(rowToHeader);
}

function rowToHeader(r: any): MessageHeader {
  return {
    id: r.id,
    accountId: r.account_id,
    folder: r.folder,
    uid: r.uid,
    messageId: r.message_id,
    subject: r.subject,
    fromAddr: r.from_addr,
    fromName: r.from_name,
    toAddr: r.to_addr,
    date: r.date,
    snippet: r.snippet,
    seen: !!r.seen,
    flagged: !!r.flagged,
    answered: !!r.answered,
    hasAttachments: !!r.has_attachments,
    category: r.category ?? null,
    summary: r.summary ?? null,
    archived: !!r.archived,
    threadKey: r.thread_key,
    size: r.size ?? 0,
    orderRef: r.order_number
      ? { orderNumber: r.order_number, orderMessageId: r.order_msg_pk ?? null, resolved: !!r.order_resolved }
      : null
  };
}

/** Načte celé tělo zprávy (stáhne ze serveru, pokud ještě není lokálně). */
export async function getMessageFull(dbId: number): Promise<MessageFull> {
  const d = getDb();
  const row = d.prepare(
    `SELECT messages.*, ol.order_number AS order_number, ol.order_msg_pk AS order_msg_pk, ol.resolved AS order_resolved
     FROM messages LEFT JOIN order_link ol ON ol.message_pk = messages.id
     WHERE messages.id = ?`
  ).get(dbId) as any;
  if (!row) throw new Error('Zpráva nenalezena');

  if (!row.fetched_full) {
    await fetchAndStoreFull(row);
    return getMessageFull(dbId);
  }

  const atts = d.prepare('SELECT id, filename, mime, size, path, cid FROM attachments WHERE message_pk = ?').all(dbId) as AttachmentInfo[];
  return {
    ...rowToHeader(row),
    cc: row.cc,
    bodyHtml: row.body_html,
    bodyText: row.body_text,
    attachments: atts,
    detectedLang: row.detected_lang,
    translationCz: row.translation_cz
  };
}

async function fetchAndStoreFull(row: any): Promise<void> {
  await withClient(row.account_id, async client => {
    const lock = await client.getMailboxLock(row.folder);
    try {
      const msg = await client.fetchOne(String(row.uid), { uid: true, source: true }, { uid: true });
      if (!msg || !msg.source) throw new Error('Zprávu se nepodařilo stáhnout ze serveru');
      await storeParsedMessage(row.id, msg.source);
    } finally {
      lock.release();
    }
  });
}

export async function storeParsedMessage(dbId: number, source: Buffer): Promise<void> {
  const d = getDb();
  const parsed = await simpleParser(source);
  const attDir = path.join(app.getPath('userData'), 'attachments', String(dbId));
  const insAtt = d.prepare('INSERT INTO attachments (message_pk, filename, mime, size, path, cid) VALUES (?,?,?,?,?,?)');
  d.prepare('DELETE FROM attachments WHERE message_pk = ?').run(dbId);
  let i = 0;
  for (const att of parsed.attachments ?? []) {
    if (!att.content) continue;
    fs.mkdirSync(attDir, { recursive: true });
    const safeName = (att.filename ?? `priloha-${++i}`).replace(/[/\\:*?"<>|]/g, '_');
    const p = path.join(attDir, safeName);
    fs.writeFileSync(p, att.content);
    const cid = (att as any).contentId ? String((att as any).contentId).replace(/[<>]/g, '') : null;
    insAtt.run(dbId, safeName, att.contentType ?? 'application/octet-stream', att.size ?? att.content.length, p, cid);
  }
  const text = parsed.text ?? '';
  const html = typeof parsed.html === 'string' ? parsed.html : null;
  const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 160);
  d.prepare(
    'UPDATE messages SET body_html = ?, body_text = ?, snippet = CASE WHEN snippet = \'\' THEN ? ELSE snippet END, fetched_full = 1, has_attachments = ? WHERE id = ?'
  ).run(html, text, snippet, (parsed.attachments?.length ?? 0) > 0 ? 1 : 0, dbId);
}

/** Uloží surový EML na disk (lokální archiv) a označí zprávu jako archivovanou. */
export async function archiveMessage(dbId: number): Promise<string> {
  const d = getDb();
  const row = d.prepare('SELECT * FROM messages WHERE id = ?').get(dbId) as any;
  if (!row) throw new Error('Zpráva nenalezena');
  const dir = path.join(app.getPath('userData'), 'archive');
  fs.mkdirSync(dir, { recursive: true });
  const emlPath = path.join(dir, `${dbId}.eml`);

  await withClient(row.account_id, async client => {
    const lock = await client.getMailboxLock(row.folder);
    try {
      const msg = await client.fetchOne(String(row.uid), { uid: true, source: true }, { uid: true });
      if (!msg || !msg.source) throw new Error('Zprávu se nepodařilo stáhnout');
      fs.writeFileSync(emlPath, msg.source);
      if (!row.fetched_full) await storeParsedMessage(dbId, msg.source);
    } finally {
      lock.release();
    }
  });

  d.prepare('UPDATE messages SET archived = 1, raw_path = ? WHERE id = ?').run(emlPath, dbId);
  emit('messages:changed', { accountId: row.account_id, folder: row.folder });
  return emlPath;
}

export async function setFlags(dbId: number, flag: 'seen' | 'flagged', value: boolean): Promise<void> {
  const d = getDb();
  const row = d.prepare('SELECT * FROM messages WHERE id = ?').get(dbId) as any;
  if (!row) return;
  const imapFlag = flag === 'seen' ? '\\Seen' : '\\Flagged';
  d.prepare(`UPDATE messages SET ${flag} = ? WHERE id = ?`).run(value ? 1 : 0, dbId);
  emit('messages:changed', { accountId: row.account_id, folder: row.folder });
  try {
    await withClient(row.account_id, async client => {
      const lock = await client.getMailboxLock(row.folder);
      try {
        if (value) await client.messageFlagsAdd([row.uid], [imapFlag], { uid: true });
        else await client.messageFlagsRemove([row.uid], [imapFlag], { uid: true });
      } finally {
        lock.release();
      }
    });
  } catch {
    /* offline — lokální stav zůstává, srovná se při další synchronizaci */
  }
}

export async function deleteMessage(dbId: number): Promise<void> {
  const d = getDb();
  const row = d.prepare('SELECT * FROM messages WHERE id = ?').get(dbId) as any;
  if (!row) return;
  const trash = getSpecialFolder(row.account_id, '\\Trash');
  await withClient(row.account_id, async client => {
    const lock = await client.getMailboxLock(row.folder);
    try {
      if (trash && trash !== row.folder) {
        await client.messageMove([row.uid], trash, { uid: true });
      } else {
        await client.messageFlagsAdd([row.uid], ['\\Deleted'], { uid: true });
        await client.messageDelete([row.uid], { uid: true });
      }
    } finally {
      lock.release();
    }
  });
  if (!row.archived) {
    d.prepare('DELETE FROM attachments WHERE message_pk = ?').run(dbId);
    d.prepare('DELETE FROM messages WHERE id = ?').run(dbId);
  }
  emit('messages:changed', { accountId: row.account_id, folder: row.folder });
}

export async function moveMessage(dbId: number, targetFolder: string): Promise<void> {
  const d = getDb();
  const row = d.prepare('SELECT * FROM messages WHERE id = ?').get(dbId) as any;
  if (!row || row.folder === targetFolder) return;
  await withClient(row.account_id, async client => {
    const lock = await client.getMailboxLock(row.folder);
    try {
      await client.messageMove([row.uid], targetFolder, { uid: true });
    } finally {
      lock.release();
    }
  });
  d.prepare('DELETE FROM messages WHERE id = ?').run(dbId);
  emit('messages:changed', { accountId: row.account_id, folder: row.folder });
}

/** Vlákno: všechny lokálně známé zprávy se stejným thread_key nebo návazností message_id. */
export function getThread(dbId: number): MessageHeader[] {
  const d = getDb();
  const row = d.prepare('SELECT * FROM messages WHERE id = ?').get(dbId) as any;
  if (!row) return [];
  const rows = d.prepare(
    `SELECT * FROM messages
     WHERE account_id = ? AND (thread_key = ? OR message_id = ? OR thread_key = ?)
     ORDER BY date ASC`
  ).all(row.account_id, row.thread_key, row.thread_key, row.message_id) as any[];
  const seen = new Set<number>();
  return rows.filter(r => (seen.has(r.id) ? false : (seen.add(r.id), true))).map(rowToHeader);
}

/** Zaplnění schránky na serveru (IMAP QUOTA, pokud ji server podporuje). */
export async function getMailboxQuota(accountId: number): Promise<{ used: number; limit: number } | null> {
  try {
    return await withClient(accountId, async client => {
      const q = await client.getQuota('INBOX');
      if (!q || !q.storage) return null;
      const used = q.storage.used ?? q.storage.usage ?? 0;
      const limit = q.storage.limit ?? 0;
      return limit > 0 ? { used, limit } : null;
    });
  } catch {
    return null;
  }
}

/* ---------- Hromadné operace ---------- */

function groupByFolder(ids: number[]): Map<string, { accountId: number; folder: string; rows: any[] }> {
  const d = getDb();
  const get = d.prepare('SELECT * FROM messages WHERE id = ?');
  const groups = new Map<string, { accountId: number; folder: string; rows: any[] }>();
  for (const id of ids) {
    const row = get.get(id) as any;
    if (!row) continue;
    const key = `${row.account_id}|${row.folder}`;
    if (!groups.has(key)) groups.set(key, { accountId: row.account_id, folder: row.folder, rows: [] });
    groups.get(key)!.rows.push(row);
  }
  return groups;
}

export async function bulkSetFlags(ids: number[], flag: 'seen' | 'flagged', value: boolean): Promise<void> {
  const d = getDb();
  const imapFlag = flag === 'seen' ? '\\Seen' : '\\Flagged';
  for (const g of groupByFolder(ids).values()) {
    const marks = g.rows.map(() => '?').join(',');
    d.prepare(`UPDATE messages SET ${flag} = ? WHERE id IN (${marks})`).run(value ? 1 : 0, ...g.rows.map(r => r.id));
    emit('messages:changed', { accountId: g.accountId, folder: g.folder });
    try {
      await withClient(g.accountId, async client => {
        const lock = await client.getMailboxLock(g.folder);
        try {
          const uids = g.rows.map(r => r.uid);
          if (value) await client.messageFlagsAdd(uids, [imapFlag], { uid: true });
          else await client.messageFlagsRemove(uids, [imapFlag], { uid: true });
        } finally {
          lock.release();
        }
      });
    } catch {
      /* offline — srovná se při další synchronizaci */
    }
  }
}

export async function bulkDelete(ids: number[]): Promise<void> {
  const d = getDb();
  for (const g of groupByFolder(ids).values()) {
    const trash = getSpecialFolder(g.accountId, '\\Trash');
    await withClient(g.accountId, async client => {
      const lock = await client.getMailboxLock(g.folder);
      try {
        const uids = g.rows.map(r => r.uid);
        if (trash && trash !== g.folder) {
          await client.messageMove(uids, trash, { uid: true });
        } else {
          await client.messageFlagsAdd(uids, ['\\Deleted'], { uid: true });
          await client.messageDelete(uids, { uid: true });
        }
      } finally {
        lock.release();
      }
    });
    for (const r of g.rows) {
      if (!r.archived) {
        d.prepare('DELETE FROM attachments WHERE message_pk = ?').run(r.id);
        d.prepare('DELETE FROM messages WHERE id = ?').run(r.id);
      }
    }
    emit('messages:changed', { accountId: g.accountId, folder: g.folder });
  }
}

/** Hromadná lokální archivace (.eml + přílohy); volitelně poté smaže zprávy ze serveru. */
export async function bulkArchive(ids: number[], deleteAfter: boolean): Promise<void> {
  const d = getDb();
  const dir = path.join(app.getPath('userData'), 'archive');
  fs.mkdirSync(dir, { recursive: true });
  for (const g of groupByFolder(ids).values()) {
    const trash = deleteAfter ? getSpecialFolder(g.accountId, '\\Trash') : null;
    await withClient(g.accountId, async client => {
      const lock = await client.getMailboxLock(g.folder);
      try {
        for (const r of g.rows) {
          const msg = await client.fetchOne(String(r.uid), { uid: true, source: true }, { uid: true });
          if (!msg || !msg.source) continue;
          const emlPath = path.join(dir, `${r.id}.eml`);
          fs.writeFileSync(emlPath, msg.source);
          if (!r.fetched_full) await storeParsedMessage(r.id, msg.source);
          d.prepare('UPDATE messages SET archived = 1, raw_path = ? WHERE id = ?').run(emlPath, r.id);
        }
        if (deleteAfter) {
          const uids = g.rows.map(r => r.uid);
          if (trash && trash !== g.folder) {
            await client.messageMove(uids, trash, { uid: true });
          } else {
            await client.messageFlagsAdd(uids, ['\\Deleted'], { uid: true });
            await client.messageDelete(uids, { uid: true });
          }
        }
      } finally {
        lock.release();
      }
    });
    emit('messages:changed', { accountId: g.accountId, folder: g.folder });
  }
}

/** Trvale smaže všechny zprávy v koši (na serveru i lokálně). */
export async function emptyTrash(accountId: number): Promise<number> {
  const trash = getSpecialFolder(accountId, '\\Trash');
  if (!trash) throw new Error('Složka koše nebyla nalezena');
  let count = 0;
  await withClient(accountId, async client => {
    const st = await client.status(trash, { messages: true });
    count = st.messages ?? 0;
    if (count === 0) return;
    const lock = await client.getMailboxLock(trash);
    try {
      await client.messageFlagsAdd('1:*', ['\\Deleted']);
      await client.messageDelete('1:*');
    } finally {
      lock.release();
    }
  });
  const d = getDb();
  d.prepare('DELETE FROM attachments WHERE message_pk IN (SELECT id FROM messages WHERE account_id = ? AND folder = ? AND archived = 0)').run(accountId, trash);
  d.prepare('DELETE FROM messages WHERE account_id = ? AND folder = ? AND archived = 0').run(accountId, trash);
  emit('messages:changed', { accountId, folder: trash });
  emit('folders:changed', { accountId });
  return count;
}

export async function appendToSent(accountId: number, raw: Buffer): Promise<void> {
  const sent = getSpecialFolder(accountId, '\\Sent');
  if (!sent) return;
  await withClient(accountId, async client => {
    await client.append(sent, raw, ['\\Seen']);
  });
}
