import fs from 'fs';
import path from 'path';
import { app, BrowserWindow } from 'electron';
import { getDb } from './db';
import { withClient, storeParsedMessage } from './imap';

/**
 * Úklid schránky na serveru.
 *
 * Poštovní schránka má na serveru pevný strop a naplní ji pár set starých
 * zpráv s přílohami — faktury, fotky reklamací, náhledy grafiky. Mazat je
 * ručně nikdo nechce a nikdo si netroufne: co když to jednou bude potřeba.
 *
 * Tenhle úklid proto nic nezahazuje. Zprávu **nejdřív stáhne celou k sobě**
 * (soubor `.eml` na disku, čitelný i mimo aplikaci) a teprve pak ji smaže ze
 * serveru. V aplikaci zůstane dohledatelná a otevřít se dá dál — jen už
 * nezabírá místo v poště.
 *
 * Dvě věci, kvůli kterým to nejde postavit na místní databázi:
 *  - synchronizuje se jen posledních 300 zpráv na složku, takže staré
 *    zprávy — přesně ty, o které tu jde — v databázi vůbec nejsou,
 *  - velikost zprávy zná spolehlivě jen server.
 * Proto se hledá přímo na serveru přes IMAP.
 */

function emit(channel: string, payload: unknown) {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload);
}

export interface CleanupItem {
  folder: string;
  uid: number;
  subject: string;
  from: string;
  date: string;
  size: number;
  attachments: boolean;
}

export interface CleanupScan {
  /** Největší napřed — od nich se uvolní nejvíc nejrychleji */
  items: CleanupItem[];
  /** Kolik zpráv odpovídá zadání celkem (i těch, které se do seznamu nevešly) */
  count: number;
  bytes: number;
  folders: string[];
  /** Koš se neuklízí, ale stojí za zmínku — vysypat ho je uvolnění zadarmo */
  trash: { folder: string; count: number } | null;
}

/** Kolik zpráv na složku se prohlédne. Víc už by trvalo dlouho a nemá to smysl. */
const PER_FOLDER = 3000;
/** Kolik se jich vrátí do rozhraní — seznam se stejně prochází očima. */
const LIST_LIMIT = 300;

/** Složky, kterých se úklid nedotýká. */
function skipped(box: { path: string; specialUse?: string }): 'trash' | 'skip' | null {
  const use = box.specialUse ?? '';
  if (use === '\\Trash') return 'trash';
  if (use === '\\Drafts' || use === '\\Junk') return 'skip';
  if (/^(koncepty|rozepsan|spam|nevyzadan)/i.test(box.path)) return 'skip';
  return null;
}

/**
 * Co by šlo uvolnit.
 *
 * Hledá se na serveru: zprávy starší než zadané datum a větší než zadaná
 * velikost. Označené (`\Flagged`) se přeskakují — hvězdička je jasný pokyn
 * „tohle si nech".
 */
export async function scanOld(accountId: number, olderThanDays: number, minSizeKb: number):
  Promise<CleanupScan> {
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);
  const minSize = Math.max(0, minSizeKb) * 1024;

  return withClient(accountId, async client => {
    const items: CleanupItem[] = [];
    const folders: string[] = [];
    let count = 0;
    let bytes = 0;
    let trash: CleanupScan['trash'] = null;

    for (const box of await client.list()) {
      const skip = skipped(box as any);
      if (skip === 'trash') {
        const st = await client.status(box.path, { messages: true });
        if ((st.messages ?? 0) > 0) trash = { folder: box.path, count: st.messages ?? 0 };
        continue;
      }
      if (skip === 'skip') continue;

      emit('cleanup:progress', { phase: 'scan', folder: box.path });
      const lock = await client.getMailboxLock(box.path);
      try {
        const uids = (await client.search({ before: cutoff }, { uid: true })) as number[] | false;
        if (!uids || uids.length === 0) continue;
        folders.push(box.path);
        // Nejstarší napřed: když je jich přes limit, ořízne se ten mladší konec
        const wanted = uids.slice(0, PER_FOLDER);
        for await (const msg of client.fetch(wanted, {
          uid: true, envelope: true, size: true, flags: true, bodyStructure: true
        }, { uid: true })) {
          const size = msg.size ?? 0;
          if (size < minSize) continue;
          if (msg.flags?.has('\\Flagged')) continue;
          count++;
          bytes += size;
          const env = msg.envelope ?? ({} as any);
          items.push({
            folder: box.path,
            uid: msg.uid,
            subject: env.subject ?? '(bez předmětu)',
            from: env.from?.[0]?.address ?? '',
            date: env.date ? new Date(env.date).toISOString() : '',
            size,
            attachments: hasAttachments(msg.bodyStructure)
          });
        }
      } finally {
        lock.release();
      }
    }

    items.sort((a, b) => b.size - a.size);
    return { items: items.slice(0, LIST_LIMIT), count, bytes, folders, trash };
  });
}

/** Nese zpráva přílohu? Stačí hrubý odhad z tvaru zprávy. */
function hasAttachments(node: any): boolean {
  if (!node) return false;
  if (node.disposition === 'attachment') return true;
  if (Array.isArray(node.childNodes)) return node.childNodes.some(hasAttachments);
  return false;
}

export interface CleanupResult {
  done: number;
  failed: number;
  freed: number;
  errors: string[];
}

/**
 * Stáhne vybrané zprávy k sobě a smaže je ze serveru.
 *
 * Pořadí je to podstatné a je schválně opatrné: nejdřív se soubor zapíše
 * a ověří, teprve pak se maže. Když se stažení nepovede, zpráva na serveru
 * zůstane — raději neuvolněné místo než ztracená pošta.
 *
 * Nemaže se do koše: tam by zabírala dál a smysl úklidu by byl pryč.
 */
export async function freeUp(accountId: number, items: CleanupItem[]): Promise<CleanupResult> {
  const d = getDb();
  const dir = path.join(app.getPath('userData'), 'archive', String(accountId));
  fs.mkdirSync(dir, { recursive: true });

  const byFolder = new Map<string, CleanupItem[]>();
  for (const item of items) {
    const list = byFolder.get(item.folder) ?? [];
    list.push(item);
    byFolder.set(item.folder, list);
  }

  const upsert = d.prepare(`
    INSERT INTO messages (account_id, folder, uid, message_id, subject, from_addr, from_name,
      reply_to, to_addr, cc, date, seen, flagged, answered, has_attachments, thread_key, snippet,
      size, archived, raw_path)
    VALUES (@account_id, @folder, @uid, '', @subject, @from_addr, '', '', '', '', @date,
      1, 0, 0, @has_attachments, @thread_key, '', @size, 1, @raw_path)
    ON CONFLICT(account_id, folder, uid) DO UPDATE SET archived = 1, raw_path = excluded.raw_path
  `);
  const findId = d.prepare('SELECT id, fetched_full FROM messages WHERE account_id = ? AND folder = ? AND uid = ?');

  const result: CleanupResult = { done: 0, failed: 0, freed: 0, errors: [] };
  let seen = 0;

  for (const [folder, list] of byFolder) {
    await withClient(accountId, async client => {
      const lock = await client.getMailboxLock(folder);
      try {
        const safe = folder.replace(/[^A-Za-z0-9._-]+/g, '_');
        const saved: number[] = [];
        for (const item of list) {
          seen++;
          emit('cleanup:progress', {
            phase: 'save', folder, done: seen, total: items.length, subject: item.subject
          });
          try {
            const msg = await client.fetchOne(String(item.uid), { uid: true, source: true }, { uid: true });
            if (!msg || !msg.source) throw new Error('zprávu se nepodařilo stáhnout');
            const file = path.join(dir, `${safe}-${item.uid}.eml`);
            fs.writeFileSync(file, msg.source);
            // Ověření, že soubor opravdu vznikl — mazat se smí až podle disku,
            // ne podle toho, že zápis nevyhodil výjimku
            if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
              throw new Error('kopii se nepodařilo uložit');
            }
            upsert.run({
              account_id: accountId,
              folder,
              uid: item.uid,
              subject: item.subject,
              from_addr: item.from,
              date: item.date || new Date().toISOString(),
              has_attachments: item.attachments ? 1 : 0,
              thread_key: `uid-${item.uid}`,
              size: item.size,
              raw_path: file
            });
            const row = findId.get(accountId, folder, item.uid) as { id: number; fetched_full: number } | undefined;
            if (row && !row.fetched_full) {
              try { await storeParsedMessage(row.id, msg.source as Buffer); } catch { /* text se dočte z .eml */ }
            }
            saved.push(item.uid);
            result.freed += item.size;
            result.done++;
          } catch (e: any) {
            result.failed++;
            if (result.errors.length < 10) {
              result.errors.push(`${item.subject.slice(0, 40)}: ${e.message ?? e}`);
            }
          }
        }

        // Maže se až nakonec a jen to, co je opravdu uložené na disku
        if (saved.length) {
          emit('cleanup:progress', { phase: 'delete', folder, done: seen, total: items.length });
          await client.messageFlagsAdd(saved, ['\\Deleted'], { uid: true });
          await client.messageDelete(saved, { uid: true });
        }
      } finally {
        lock.release();
      }
    });
    emit('messages:changed', { accountId, folder });
  }

  emit('cleanup:progress', { phase: 'done', done: seen, total: items.length });
  return result;
}
