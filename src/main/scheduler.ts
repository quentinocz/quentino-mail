import { BrowserWindow } from 'electron';
import { getDb } from './db';
import { sendNow } from './smtp';
import { syncAllAccounts } from './imap';
import { refreshFeed, feedIsStale } from './products';
import { runSync } from './appsync';
import { OutboxItem } from '../shared/types';

const OUTBOX_INTERVAL = 5_000; // kontrola plánovaných odeslání (krátká kvůli „Zpět" po odeslání)
const SYNC_INTERVAL = 3 * 60_000; // periodická synchronizace
const FEED_CHECK_INTERVAL = 60 * 60_000; // kontrola stáří produktového feedu

function emit(channel: string, payload: unknown) {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload);
}

export function startScheduler() {
  setInterval(processOutbox, OUTBOX_INTERVAL);
  setInterval(() => syncAllAccounts().catch(() => {}), SYNC_INTERVAL);
  // Produktový feed: automatická aktualizace (starší než ~20 h nebo prázdný)
  const checkFeed = () => {
    if (feedIsStale()) refreshFeed().then(() => emit('products:changed', {})).catch(() => {});
  };
  setInterval(checkFeed, FEED_CHECK_INTERVAL);
  setTimeout(checkFeed, 10_000);
  // Synchronizace mezi zařízeními (sdílená složka) — každou minutu
  setInterval(() => runSync().catch(() => {}), 60_000);
  setTimeout(() => runSync().catch(() => {}), 8_000);
  // první běh krátce po startu
  setTimeout(processOutbox, 5_000);
}

let running = false;

export async function processOutbox(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const d = getDb();
    const due = d.prepare(
      "SELECT * FROM outbox WHERE status = 'scheduled' AND send_at <= ? ORDER BY send_at LIMIT 10"
    ).all(new Date().toISOString()) as any[];
    for (const item of due) {
      d.prepare("UPDATE outbox SET status = 'sending' WHERE id = ?").run(item.id);
      try {
        await sendNow({
          accountId: item.account_id,
          to: item.to_addr,
          cc: item.cc,
          bcc: item.bcc,
          subject: item.subject,
          html: item.html,
          attachmentPaths: JSON.parse(item.attachments_json || '[]'),
          inlineImages: JSON.parse(item.inline_json || '[]'),
          fromName: item.from_name ?? null,
          inReplyTo: item.in_reply_to ?? undefined,
          references: item.refs ?? undefined,
          replyToDbId: item.reply_to_db_id ?? undefined
        });
        d.prepare("UPDATE outbox SET status = 'sent', error = NULL WHERE id = ?").run(item.id);
      } catch (e: any) {
        d.prepare("UPDATE outbox SET status = 'failed', error = ? WHERE id = ?").run(e?.message ?? String(e), item.id);
      }
      emit('outbox:changed', {});
    }
  } finally {
    running = false;
  }
}

export function listOutbox(): OutboxItem[] {
  const rows = getDb().prepare(
    "SELECT id, account_id, to_addr, subject, send_at, status, error FROM outbox WHERE status != 'sent' OR datetime(created_at) > datetime('now', '-2 days') ORDER BY send_at DESC LIMIT 100"
  ).all() as any[];
  return rows.map(r => ({
    id: r.id,
    accountId: r.account_id,
    toAddr: r.to_addr,
    subject: r.subject,
    sendAt: r.send_at,
    status: r.status,
    error: r.error
  }));
}

export function cancelOutbox(id: number): void {
  getDb().prepare("DELETE FROM outbox WHERE id = ? AND status IN ('scheduled','failed')").run(id);
}
