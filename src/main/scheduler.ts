import { BrowserWindow } from 'electron';
import { getDb } from './db';
import { sendNow } from './smtp';
import { syncAllAccounts } from './imap';
import { refreshFeed, feedIsStale, refreshStock } from './products';
import { refreshDueFeeds } from './orderfeed';
import { runSync, syncVouchersNow, watchShared } from './appsync';
import { start as startLive } from './live';
import { startLiveWork } from './livework';
import { refreshStatesIfNeeded } from './ptrans/store';
import { processQueue as processIgQueue, refreshTokens as refreshIgTokens, syncSource as syncIgSource } from './instagram/publish';
import { getSetting } from './db';
import { pollUnread as pollChatUnread } from './chat';
import { keepAwake } from './keepalive';
import { OutboxItem } from '../shared/types';

const OUTBOX_INTERVAL = 5_000; // kontrola plánovaných odeslání (krátká kvůli „Zpět" po odeslání)
const SYNC_INTERVAL = 3 * 60_000; // periodická synchronizace
const FEED_CHECK_INTERVAL = 60 * 60_000; // kontrola stáří produktového feedu
const IG_QUEUE_INTERVAL = 30_000; // fronta instagramových publikací
const IG_TOKEN_INTERVAL = 6 * 60 * 60_000; // obnova přístupu k účtům (tokeny platí 60 dní)
const IG_SYNC_INTERVAL = 6 * 60 * 60_000; // dotažení nových příspěvků ze zdrojového účtu
const CHAT_UNREAD_INTERVAL = 20_000; // nepřečtené zprávy z chatu pro odznak v přepínači

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

  /*
   * Zásoby zvlášť a častěji než celý katalog.
   *
   * Malý export z Upgates se obnovuje po dvou hodinách a nese jen kódy,
   * dostupnost, ceny a varianty — stáhnout ho stojí zlomek toho, co celý
   * feed s popisy. „Skladem 4 ks" má být čerstvé; jak produkt vypadá, se
   * za den nezmění.
   */
  const stock = () => {
    if (!getSetting('stockFeedUrl', '')) return;
    refreshStock().then(() => emit('products:changed', {})).catch(() => { /* zkusí se za dvě hodiny */ });
  };
  setTimeout(stock, 20_000);
  setInterval(stock, 2 * 3600_000);
  setTimeout(checkFeed, 10_000);
  // Projekty Supabase na bezplatném tarifu se po pár dnech ticha uspí.
  // Chat drží vzhůru načítání nepřečtených, ale úložiště médií pro Instagram
  // se ozve jen když se publikuje příspěvek — a mezi dvěma příspěvky uplyne
  // klidně týden.
  setInterval(() => keepAwake().catch(() => {}), 6 * 60 * 60_000);
  setTimeout(() => keepAwake().catch(() => {}), 60_000);

  /*
   * Feedy objednávek.
   *
   * E-shop soubor přegenerovává v pevných značkách (pětiminutový v :00, :05,
   * :10…) a `refreshDueFeeds` na ně čeká. Kontroluje se proto po půl minutě,
   * ne po minutě — jinak by se stahovalo se zpožděním až minutu po značce,
   * což je u pětiminutového feedu pětina periody. Kontrola samotná je jen
   * čtení jedné hodnoty z nastavení, takže nic nestojí.
   */
  const orders = () => refreshDueFeeds().then(result => {
    if (result.some(item => item.orders > 0)) emit('orderfeed:changed', {});
  }).catch(() => {});
  setInterval(orders, 30_000);
  setTimeout(orders, 15_000);

  // Synchronizace mezi zařízeními (sdílená složka) — každou minutu
  setInterval(() => runSync().catch(() => {}), 60_000);
  setTimeout(() => runSync().catch(() => {}), 8_000);

  // Poukazy zvlášť a mnohem častěji. Velké kolo dělá i archiv, který při
  // větší schránce trvá, a po tu dobu se nic jiného nesynchronizuje — nová
  // šablona nebo ubraný kód se pak na druhém zařízení objevily za minuty.
  // Tohle jsou dva malé soubory, takže se to zvládne po deseti vteřinách.
  watchShared();
  setInterval(syncVouchersNow, 10_000);
  setTimeout(syncVouchersNow, 3_000);

  /*
   * Živé propojení telefonu a počítače.
   *
   * Sdílená složka zůstává tím, co platí — tohle je jen rychlý posel, aby
   * se naskladnění z regálu neobjevilo na počítači až za dvě minuty. Zapíná
   * se se zpožděním, ať se aplikace nejdřív v klidu nastartuje.
   */
  startLiveWork();
  setTimeout(() => { try { startLive(); } catch { /* zbývá složka */ } }, 5_000);

  // Stavy překladů se počítají dopředu a leží v databázi. Když se změní
  // pravidla, podle kterých se určují, musí se jednou přepočítat — jinak by
  // oprava zůstala jen v kódu a v seznamu by pořád svítila stará čísla.
  setTimeout(() => { try { refreshStatesIfNeeded(); } catch { /* projde se s dalším feedem */ } }, 6_000);
  // Instagram: fronta se odbavuje často, tokeny a synchronizace zdroje zřídka
  setInterval(() => processIgQueue().catch(() => {}), IG_QUEUE_INTERVAL);
  setInterval(() => refreshIgTokens().catch(() => {}), IG_TOKEN_INTERVAL);
  setTimeout(() => refreshIgTokens().catch(() => {}), 30_000);
  const igSync = () => {
    if (getSetting('igAutoSync', '1') !== '1') return;
    syncIgSource(false).catch(() => {}); // bez připojeného účtu jen tiše skončí
  };
  setInterval(igSync, IG_SYNC_INTERVAL);
  setTimeout(igSync, 45_000);

  // Chat: odznak s nepřečtenými. Vlastní obrazovka si data načítá sama a častěji.
  setInterval(() => pollChatUnread().catch(() => {}), CHAT_UNREAD_INTERVAL);
  setTimeout(() => pollChatUnread().catch(() => {}), 6_000);

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
