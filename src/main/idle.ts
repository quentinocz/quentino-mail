/**
 * Okamžité doručení nové pošty (IMAP IDLE).
 *
 * Periodická synchronizace zůstává jako záchranná síť, ale běžně se nová
 * zpráva objeví hned: ke každému účtu se drží jedno otevřené spojení nad
 * složkou Doručená pošta a server sám ohlásí, že přibyla zpráva.
 *
 * Spojení umírá při každém uspání počítače, výpadku sítě i rozmaru serveru,
 * takže se počítá s tím, že se bude průběžně obnovovat — a nikdy nesmí
 * shodit aplikaci.
 */
import { ImapFlow } from 'imapflow';
import { BrowserWindow, Notification, app } from 'electron';
import { getAccountWithPassword, listAccounts } from './accounts';
import { getCaCertificates } from './systemca';
import { getDb } from './db';
import { getSettings } from './settings';
import { syncFolder } from './imap';
import { mailLink, mailNotification, notifyPhone, wantsNotify } from './notify';

interface Watcher {
  accountId: number;
  client: ImapFlow | null;
  timer: NodeJS.Timeout | null;
  attempts: number;
  stopped: boolean;
}

const watchers = new Map<number, Watcher>();

/** Po výpadku se nezkouší donekonečna dokola — pauza roste do minuty. */
function backoff(attempts: number): number {
  return Math.min(60_000, 4000 * Math.max(1, attempts));
}

function emit(channel: string, payload: unknown) {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload);
}

/* ---------- Upozornění na nové zprávy ---------- */

function newestId(accountId: number): number {
  const row = getDb().prepare(
    "SELECT MAX(id) AS id FROM messages WHERE account_id = ? AND folder = 'INBOX'"
  ).get(accountId) as any;
  return row?.id ?? 0;
}

function notifyAbout(accountId: number, sinceId: number): void {
  const rows = getDb().prepare(
    `SELECT id, message_id, from_name, from_addr, subject FROM messages
     WHERE account_id = ? AND folder = 'INBOX' AND id > ? AND seen = 0
     ORDER BY id DESC LIMIT 5`
  ).all(accountId, sinceId) as any[];
  if (rows.length === 0) return;

  /*
   * Telefon se ozve i tehdy, když se člověk dívá na počítač — právě proto,
   * že smyslem je vědět o poště, když u počítače nesedí, a pravidlo „okno je
   * v popředí" o tom nic neříká. Odesílá se na pozadí; když ntfy neodpoví,
   * synchronizace tím nesmí utrpět.
   */
  if (wantsNotify('mail')) {
    const { title, message } = mailNotification(rows.map(r => ({
      fromName: r.from_name, fromAddr: r.from_addr, subject: r.subject
    })));
    /*
     * Odkaz jen u jedné zprávy. U několika naráz by ukázal na jednu z nich
     * a zbytek by vypadal jako přeskočený — tam stačí otevřít poštu.
     */
    const click = rows.length === 1 ? mailLink(rows[0].message_id) : mailLink(null);
    void notifyPhone('mail', title, message, { click }).catch(() => { /* nevadí */ });
  }

  if (!getSettings().notifyNewMail) return;
  if (!Notification.isSupported()) return;

  // Když se uživatel na aplikaci zrovna dívá, upozornění na ploše je na obtíž
  const focused = BrowserWindow.getAllWindows().some(w => w.isFocused());
  if (focused) return;

  const show = (title: string, body: string, openId?: number) => {
    const n = new Notification({ title, body, silent: false });
    n.on('click', () => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      }
      if (openId) emit('mail:open', { accountId, id: openId });
    });
    n.show();
  };

  if (rows.length === 1) {
    const m = rows[0];
    show(m.from_name || m.from_addr || 'Nová zpráva', m.subject || '(bez předmětu)', m.id);
    return;
  }
  show(
    `${rows.length} nových zpráv`,
    rows.map(r => `${r.from_name || r.from_addr}: ${r.subject || '(bez předmětu)'}`).join('\n').slice(0, 240),
    rows[0].id
  );
}

/* ---------- Sledování jednoho účtu ---------- */

async function pull(accountId: number): Promise<void> {
  const before = newestId(accountId);
  try {
    await syncFolder(accountId, 'INBOX');
    notifyAbout(accountId, before);
  } catch { /* chyba se ohlásí přes sync:state, spojení tím nekončí */ }
}

async function connect(w: Watcher): Promise<void> {
  if (w.stopped) return;
  const acc = getAccountWithPassword(w.accountId);
  if (!acc || !acc.password) return; // účet bez hesla (zamčená klíčenka) nemá co sledovat

  const client = new ImapFlow({
    host: acc.imapHost,
    port: acc.imapPort,
    secure: acc.imapSecure,
    auth: { user: acc.username, pass: acc.password },
    tls: { ca: getCaCertificates() },
    logger: false,
    // Spojení se drží dlouho; server musí občas dostat najevo, že žijeme
    socketTimeout: 10 * 60_000,
    maxIdleTime: 4 * 60_000
  });
  w.client = client;

  // Bez těchhle dvou by useknuté spojení shodilo celý proces
  client.on('error', () => reconnect(w));
  client.on('close', () => reconnect(w));

  client.on('exists', () => { pull(w.accountId); });

  try {
    await client.connect();
    await client.mailboxOpen('INBOX');
    w.attempts = 0;
    // Po navázání spojení dorovnáme, co přišlo, když jsme neposlouchali
    await pull(w.accountId);
  } catch {
    reconnect(w);
  }
}

function reconnect(w: Watcher): void {
  if (w.stopped || w.timer) return;
  const client = w.client;
  w.client = null;
  if (client) {
    try { client.removeAllListeners(); } catch { /* už je po něm */ }
    try { client.close(); } catch { /* už je zavřené */ }
  }
  w.attempts += 1;
  w.timer = setTimeout(() => {
    w.timer = null;
    connect(w).catch(() => reconnect(w));
  }, backoff(w.attempts));
}

function stop(w: Watcher): void {
  w.stopped = true;
  if (w.timer) { clearTimeout(w.timer); w.timer = null; }
  const client = w.client;
  w.client = null;
  if (client) {
    try { client.removeAllListeners(); } catch { /* nic */ }
    try { client.close(); } catch { /* nic */ }
  }
}

/* ---------- Vnější rozhraní ---------- */

/** Srovná sledované účty se seznamem účtů — volá se po startu i po změně účtů. */
export function refreshWatchers(): void {
  const accounts = listAccounts();
  const wanted = new Set(accounts.map(a => a.id));

  for (const [id, w] of watchers) {
    if (!wanted.has(id)) { stop(w); watchers.delete(id); }
  }

  for (const acc of accounts) {
    if (watchers.has(acc.id)) continue;
    const w: Watcher = { accountId: acc.id, client: null, timer: null, attempts: 0, stopped: false };
    watchers.set(acc.id, w);
    connect(w).catch(() => reconnect(w));
  }
}

/** Po probuzení počítače jsou stará spojení mrtvá, i když o tom ještě nevědí. */
export function restartWatchers(): void {
  for (const w of watchers.values()) {
    w.attempts = 0;
    reconnect(w);
  }
}

export function stopWatchers(): void {
  for (const w of watchers.values()) stop(w);
  watchers.clear();
}

app.on('before-quit', stopWatchers);
