/**
 * Sdílené nastavení a trezor s klíči — mezi všemi Macy.
 *
 * ## Proč
 *
 * Synchronizace přes sdílenou složku přenášela jen část nastavení (AI,
 * znalosti, osoby) a hesla s klíči záměrně vůbec. Na každém ze tří Maců se
 * tak muselo zvlášť vyplnit totéž: feedy, Upgates, úložiště, Google Ads,
 * Analytics… a po každé změně zase. Tenhle modul přenáší **celou tabulku
 * nastavení** a e-mailové účty — a hesla s klíči v šifrovaném trezoru.
 *
 * ## Jak je to zabezpečené
 *
 * Klíče a hesla nejdou do sdílené složky jako text. Jsou v jednom bloku
 * zašifrovaném AES-256-GCM klíčem odvozeným (scrypt) z **hesla trezoru**.
 * To heslo se zadává na každém Macu ručně a jednou — v souboru ve složce
 * (iCloud, Dropbox…) není, a kdo ho nezná, z bloku nic nepřečte. Na Macu se
 * heslo drží zašifrované klíčenkou systému, stejně jako ostatní hesla.
 *
 * Bez hesla trezoru se přenáší jen nastavení bez tajemství; klíče zůstávají
 * na každém Macu, jak byly.
 *
 * ## Jak se slučuje
 *
 * Po jednotlivých položkách (klíčích nastavení, účtech, heslech) a vyhrává
 * novější změna. Kdy se položka změnila, se pozná podle otisku hodnoty:
 * aplikace si pamatuje otisk z minula a když se liší, položka dostane
 * razítko „teď". Čerstvě zapnutý Mac dá všemu razítko z roku 1970, takže
 * výchozí hodnoty nikdy nepřebijí to, co už nastavily jiné Macy.
 *
 * Prázdné tajemství se nepřenáší: „odebrat klíč z tohoto Macu" nesmí
 * smazat klíč na ostatních. Stejně tak se nemažou účty.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getDb, getSetting, setSetting } from './db';
import { encrypt, decrypt } from './secure';
import { isVolatile, isEncrypted, seal, unseal } from './settings';

const FILE = 'nastaveni-aplikace.json';
const PASS_KEY = 'vaultPass';
const STATE_KEY = 'vaultState';
const EPOCH = '1970-01-01T00:00:00.000Z';
/** Hodnoty větší než tohle nejsou nastavení, ale uložená data — nepřenáší se */
const MAX_VALUE = 256 * 1024;

/**
 * Klíče, které patří jen tomuhle Macu. Synchronizace, režim klíčenky
 * a hesla trezoru jsou vlastnost zařízení; nastavení Reklam má vlastní
 * sdílení (reklamy/nastaveni.json) a dvě cesty by se praly.
 */
const DEVICE_ONLY = new Set([
  'syncFolder', 'syncEnabled', 'secureMode', 'adsConfig', PASS_KEY, STATE_KEY,
  // Cesty k programům a souborům na tomhle disku — jinde neplatí
  'mediaFfmpeg', 'shootGphoto', 'shootCurrent', 'voucherLogo',
  /*
   * Konvertor médií hlídá složky na disku tohoto Macu. Kdyby se nastavení
   * přeneslo, hlídaly by tutéž složku v iCloudu dva Macy a každý soubor by
   * se převedl dvakrát.
   */
  'mediaSetup',
  // Druhá obrazovka u focení je monitor připojený k tomuhle Macu
  'shootSecond',
  // Zprávy o posledním běhu na tomhle Macu
  'chatNudgeAt', 'ga4LastAt', 'ga4LastDetail', 'ga4LastError', 'zkVystavenoKdy',
  // Upozornění přímo na tomhle zařízení
  'notifyPhoneLocal'
]);

/**
 * Seznam je výčtem, ne vzorem podle jména: „bannersPath" i „webTextsPath"
 * jsou cesty v úložišti na webu a přenášet se mají — vzor „…Path" by je
 * schoval a druhý Mac by publikoval jinam.
 */
function deviceOnly(key: string): boolean {
  return DEVICE_ONLY.has(key) || isVolatile(key);
}

export interface VaultStatus {
  /** Má tenhle Mac zadané heslo trezoru */
  unlocked: boolean;
  /** Ve sdílené složce už trezor je (jiný Mac ho založil) */
  exists: boolean;
  /** Heslo tohoto Macu trezor ve složce neotevře */
  mismatch: boolean;
  lastAt: string;
  lastResult: string;
  /** Kolik položek se sdílí (nastavení / tajemství) */
  counts: { plain: number; secret: number };
}

interface Entry { v: string; t: string }
interface State { stamps: Record<string, { h: string; t: string }>; lastAt?: string; lastResult?: string; mismatch?: boolean }

function readState(): State {
  try {
    const raw = JSON.parse(getSetting(STATE_KEY, '') || '{}');
    return { stamps: raw?.stamps && typeof raw.stamps === 'object' ? raw.stamps : {}, ...raw };
  } catch {
    return { stamps: {} };
  }
}

function writeState(state: State): void {
  setSetting(STATE_KEY, JSON.stringify(state));
}

function passphrase(): string {
  const raw = getSetting(PASS_KEY, '') || '';
  if (!raw) return '';
  try { return decrypt(raw); } catch { return ''; }
}

const hashOf = (value: string) => crypto.createHash('sha256').update(value).digest('hex').slice(0, 24);

function sharedFile(): string | null {
  if (getSetting('syncEnabled', '0') !== '1') return null;
  const folder = (getSetting('syncFolder', '') || '').trim();
  if (!folder || !fs.existsSync(folder)) return null;
  return path.join(folder, FILE);
}

function readRemote(file: string): any {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/* ---------- co tenhle Mac má ---------- */

const ACCOUNT_FIELDS = ['name', 'imap_host', 'imap_port', 'imap_secure', 'smtp_host', 'smtp_port', 'smtp_secure',
  'username', 'signature_html', 'sig_json', 'color'];
const IG_FIELDS = ['username', 'lang', 'color', 'is_source', 'token_expires', 'page_id', 'page_name', 'share_fb'];

/**
 * Všechny sdílené položky tohoto Macu.
 *
 * Jména mají předponu podle druhu: `s:` nastavení, `a:` e-mailový účet
 * (bez hesla), `p:` heslo k účtu, `i:` instagramový účet i s přístupem.
 * Tajemství (`secret`) jdou jen do šifrovaného bloku.
 */
export function localEntries(): Map<string, { value: string; secret: boolean }> {
  const d = getDb();
  const out = new Map<string, { value: string; secret: boolean }>();
  for (const r of d.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]) {
    if (deviceOnly(r.key)) continue;
    if (isEncrypted(r.value)) {
      let plain = '';
      try { plain = decrypt(r.value); } catch { plain = ''; }
      if (plain) out.set(`s:${r.key}`, { value: plain, secret: true });
      continue;
    }
    if ((r.value ?? '').length > MAX_VALUE) continue;
    out.set(`s:${r.key}`, { value: r.value ?? '', secret: false });
  }
  try {
    for (const a of d.prepare('SELECT * FROM accounts').all() as any[]) {
      if (!a.email) continue;
      const cfg: Record<string, unknown> = {};
      for (const f of ACCOUNT_FIELDS) cfg[f] = a[f] ?? null;
      out.set(`a:${a.email}`, { value: JSON.stringify(cfg), secret: false });
      let pass = '';
      try { pass = a.pass_enc ? decrypt(a.pass_enc) : ''; } catch { pass = ''; }
      if (pass) out.set(`p:${a.email}`, { value: pass, secret: true });
    }
  } catch { /* tabulka účtů ještě není */ }
  try {
    for (const a of d.prepare('SELECT * FROM ig_accounts').all() as any[]) {
      if (!a.ig_user_id) continue;
      let token = '';
      try { token = a.token_enc ? decrypt(a.token_enc) : ''; } catch { token = ''; }
      const cfg: Record<string, unknown> = { token };
      for (const f of IG_FIELDS) cfg[f] = a[f] ?? null;
      out.set(`i:${a.ig_user_id}`, { value: JSON.stringify(cfg), secret: true });
    }
  } catch { /* Instagram ještě není */ }
  return out;
}

/* ---------- zápis cizí hodnoty ---------- */

function apply(name: string, value: string): boolean {
  const d = getDb();
  const kind = name.slice(0, 2);
  const id = name.slice(2);
  if (kind === 's:') {
    if (deviceOnly(id)) return false;
    // Tajemství přišlo jako text z trezoru — tady se zašifruje klíčenkou tohoto Macu
    const secret = currentlySecret.has(name);
    setSetting(id, secret ? encrypt(value) : value);
    return true;
  }
  if (kind === 'a:') {
    let cfg: any;
    try { cfg = JSON.parse(value); } catch { return false; }
    const exists = d.prepare('SELECT id FROM accounts WHERE email = ?').get(id) as any;
    if (exists) {
      d.prepare(`UPDATE accounts SET ${ACCOUNT_FIELDS.map(f => `${f} = @${f}`).join(', ')} WHERE id = @id`)
        .run({ ...Object.fromEntries(ACCOUNT_FIELDS.map(f => [f, cfg[f] ?? null])), id: exists.id });
    } else {
      // Nový účet z jiného Macu; heslo dorazí z trezoru jako `p:`
      d.prepare(`INSERT INTO accounts (email, pass_enc, ${ACCOUNT_FIELDS.join(', ')})
        VALUES (@email, '', ${ACCOUNT_FIELDS.map(f => `@${f}`).join(', ')})`)
        .run({ email: id, ...Object.fromEntries(ACCOUNT_FIELDS.map(f => [f, cfg[f] ?? null])) });
    }
    return true;
  }
  if (kind === 'p:') {
    return d.prepare('UPDATE accounts SET pass_enc = ? WHERE email = ?').run(encrypt(value), id).changes > 0;
  }
  if (kind === 'i:') {
    let cfg: any;
    try { cfg = JSON.parse(value); } catch { return false; }
    d.prepare(
      `INSERT INTO ig_accounts (ig_user_id, username, lang, color, is_source, token_enc, token_expires, page_id, page_name, share_fb)
       VALUES (@id, @username, @lang, @color, @is_source, @token, @token_expires, @page_id, @page_name, @share_fb)
       ON CONFLICT(ig_user_id) DO UPDATE SET username = excluded.username, lang = excluded.lang, color = excluded.color,
         is_source = excluded.is_source, token_expires = excluded.token_expires, page_id = excluded.page_id,
         page_name = excluded.page_name, share_fb = excluded.share_fb,
         token_enc = CASE WHEN excluded.token_enc = '' THEN ig_accounts.token_enc ELSE excluded.token_enc END`
    ).run({
      id, username: cfg.username ?? '', lang: cfg.lang ?? 'CS', color: cfg.color ?? '#7c5cff', is_source: cfg.is_source ?? 0,
      token: cfg.token ? encrypt(cfg.token) : '', token_expires: cfg.token_expires ?? null,
      page_id: cfg.page_id ?? '', page_name: cfg.page_name ?? '', share_fb: cfg.share_fb ?? 0
    });
    return true;
  }
  return false;
}

/** Která jména jsou tajemství — u nastavení se podle toho rozhodne, jestli šifrovat */
let currentlySecret = new Set<string>();

/* ---------- synchronizace ---------- */

/**
 * Jedno kolo: zjistit vlastní změny, převzít novější cizí, zapsat sloučené.
 * Vrací krátkou zprávu do výsledku synchronizace.
 */
export function syncVault(now = new Date().toISOString()): string {
  const file = sharedFile();
  if (!file) return '';
  const state = readState();
  const local = localEntries();
  const pass = passphrase();
  const remote = readRemote(file);
  /*
   * První kolo na tomhle Macu: když už ve složce něco je, platí to, co tam
   * je (razítko 1970) — čerstvá instalace má jen výchozí hodnoty. Když ve
   * složce nic není, je tenhle Mac první a jeho nastavení je ta pravda.
   */
  const first = Object.keys(state.stamps).length === 0;
  const firstStamp = remote ? EPOCH : now;

  // 1) Vlastní změny podle otisku hodnoty
  for (const [name, entry] of local) {
    const h = hashOf(entry.value);
    const known = state.stamps[name];
    if (!known) state.stamps[name] = { h, t: first ? firstStamp : now };
    else if (known.h !== h) state.stamps[name] = { h, t: now };
  }

  // 2) Cizí stav
  const remotePlain: Record<string, Entry> = remote?.plain && typeof remote.plain === 'object' ? remote.plain : {};
  let remoteSecret: Record<string, Entry> = {};
  let mismatch = false;
  if (remote?.vault) {
    if (pass) {
      try {
        const box = unseal(remote.vault, pass);
        if (box?.check === 'quentino') remoteSecret = box.entries ?? {};
        else mismatch = true;
      } catch { mismatch = true; }
    }
  }
  currentlySecret = new Set([
    ...[...local.entries()].filter(([, e]) => e.secret).map(([n]) => n),
    ...Object.keys(remoteSecret)
  ]);

  // 3) Převzít novější
  let taken = 0;
  const take = (name: string, entry: Entry, secret: boolean) => {
    if (!entry || typeof entry.v !== 'string' || typeof entry.t !== 'string') return;
    if (secret && !entry.v) return; // prázdné tajemství nic nemaže
    const mine = state.stamps[name];
    if (mine && mine.t >= entry.t) return;
    const current = local.get(name);
    if (current && current.value === entry.v) { state.stamps[name] = { h: hashOf(entry.v), t: entry.t }; return; }
    try {
      if (apply(name, entry.v)) {
        state.stamps[name] = { h: hashOf(entry.v), t: entry.t };
        taken++;
      }
    } catch { /* jedna položka nesmí zastavit ostatní */ }
  };
  // Účty dřív než hesla — heslo potřebuje existující účet
  const order = (names: string[]) => names.sort((a, b) => (a.startsWith('a:') ? 0 : 1) - (b.startsWith('a:') ? 0 : 1));
  for (const name of order(Object.keys(remotePlain))) take(name, remotePlain[name], false);
  if (pass && !mismatch) for (const name of order(Object.keys(remoteSecret))) take(name, remoteSecret[name], true);

  // 4) Zapsat sloučené, když mám něco novějšího nebo něco chybí
  const after = taken ? localEntries() : local;
  const plain: Record<string, Entry> = { ...remotePlain };
  const secret: Record<string, Entry> = { ...remoteSecret };
  let changed = false;
  for (const [name, entry] of after) {
    const stamp = state.stamps[name]?.t ?? EPOCH;
    if (entry.secret) {
      if (!pass || mismatch) continue;
      if (!secret[name] || secret[name].t < stamp) { secret[name] = { v: entry.value, t: stamp }; changed = true; }
    } else if (!plain[name] || plain[name].t < stamp) {
      plain[name] = { v: entry.value, t: stamp };
      changed = true;
    }
  }
  if (changed || (!remote && after.size)) {
    const out = {
      app: 'quentino-nastaveni',
      version: 1,
      updatedAt: now,
      plain,
      // Bez hesla na tomhle Macu se cizí trezor jen nese dál, nepřepisuje
      vault: pass && !mismatch ? seal({ check: 'quentino', entries: secret }, pass) : (remote?.vault ?? null)
    };
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(out), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  const result = [
    taken ? `${taken}× nastavení převzato` : '',
    mismatch ? 'heslo trezoru nesedí s ostatními Macy' : ''
  ].filter(Boolean).join(', ');
  writeState({ ...state, lastAt: now, lastResult: result || 'nastavení aktuální', mismatch });
  return result;
}

/* ---------- heslo trezoru ---------- */

export function vaultStatus(): VaultStatus {
  const state = readState();
  const file = sharedFile();
  const remote = file ? readRemote(file) : null;
  const local = localEntries();
  return {
    unlocked: !!passphrase(),
    exists: !!remote?.vault,
    mismatch: !!state.mismatch,
    lastAt: state.lastAt ?? '',
    lastResult: state.lastResult ?? '',
    counts: {
      plain: [...local.values()].filter(e => !e.secret).length,
      secret: [...local.values()].filter(e => e.secret).length
    }
  };
}

/**
 * Nastaví heslo trezoru na tomhle Macu.
 *
 * Když trezor ve složce už je (založil ho jiný Mac), heslo se nejdřív
 * ověří — špatné heslo by jinak trezor při dalším zápisu přešifrovalo
 * a ostatní Macy by se k němu nedostaly.
 */
export function setVaultPassphrase(pass: string): VaultStatus {
  const clean = String(pass ?? '');
  if (clean.length < 10) throw new Error('Heslo trezoru musí mít aspoň 10 znaků.');
  const file = sharedFile();
  const remote = file ? readRemote(file) : null;
  if (remote?.vault) {
    let ok = false;
    try { ok = unseal(remote.vault, clean)?.check === 'quentino'; } catch { ok = false; }
    if (!ok) throw new Error('Tohle heslo trezor ve sdílené složce neotevře — zadej stejné heslo jako na ostatních Macích.');
  }
  setSetting(PASS_KEY, encrypt(clean));
  const state = readState();
  writeState({ ...state, mismatch: false });
  try { syncVault(); } catch { /* proběhne v dalším kole */ }
  return vaultStatus();
}

export function forgetVaultPassphrase(): VaultStatus {
  setSetting(PASS_KEY, '');
  return vaultStatus();
}
