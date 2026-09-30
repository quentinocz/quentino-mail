import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { app, safeStorage } from 'electron';

/**
 * Šifrování citlivých údajů — hesel k poště, klíčů k API a přístupů k sítím.
 *
 * ## Dvě cesty a proč
 *
 * Výchozí je **systémová klíčenka** (macOS Keychain, Windows DPAPI): klíč
 * drží operační systém a z disku se sám o sobě přečíst nedá.
 *
 * Má to ale jeden provozní háček, kvůli kterému tu je i druhá cesta.
 * macOS váže přístup ke klíčence na **podpis aplikace**. Aplikace bez
 * certifikátu od Apple se podepisuje provizorně (ad-hoc) a takový podpis
 * je po každém sestavení jiný — systém proto po každé aktualizaci považuje
 * aplikaci za cizí a ptá se na heslo ke klíčence. U aplikace, která se
 * aktualizuje jednou za pár dní, je to otravné natolik, že to lidi vede
 * k horším zvykům (třeba k ukládání hesel mimo aplikaci).
 *
 * Druhá cesta je proto **klíč v datech aplikace**: náhodných 32 bajtů
 * v souboru, který smí číst jen přihlášený uživatel (chmod 600), a
 * AES-256-GCM. Na heslo se nikdo neptá.
 *
 * ## Co si tím člověk kupuje a co platí
 *
 * Je to slabší: kdo umí číst soubory v domovské složce, přečte i klíč.
 * Ve stejné složce ale už leží databáze s celou poštou, objednávkami
 * a zákazníky — takže rozdíl je menší, než se zdá. Rozhodnutí patří
 * uživateli, ne nám: výchozí zůstává klíčenka.
 */

const REZIM = 'secureMode';
const SOUBOR = 'klic.bin';

/** Nastavení se čte přes db, ale to by tu dělalo kruh — proto líná vazba. */
let cist: ((key: string, fallback?: string) => string | null) | null = null;
let psat: ((key: string, value: string) => void) | null = null;

export function connectSecure(
  getSetting: (key: string, fallback?: string) => string | null,
  setSetting: (key: string, value: string) => void
): void {
  cist = getSetting;
  psat = setSetting;
}

export type SecureMode = 'keychain' | 'local';

export function secureMode(): SecureMode {
  const v = cist ? cist(REZIM, 'keychain') : 'keychain';
  return v === 'local' ? 'local' : 'keychain';
}

function keyFile(): string {
  return path.join(app.getPath('userData'), SOUBOR);
}

/**
 * Klíč v datech aplikace. Vyrobí se při prvním použití a **nikdy se
 * nepřepisuje** — přepsaný klíč znamená ztracená hesla.
 */
function localKey(): Buffer {
  const file = keyFile();
  try {
    const raw = fs.readFileSync(file);
    if (raw.length === 32) return raw;
  } catch { /* ještě není, vyrobí se níž */ }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(file, key, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* Windows práva neřeší */ }
  return key;
}

function localEncrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', localKey(), iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  // Pohromadě v jednom řetězci: iv | kontrolní značka | šifra
  return 'loc:' + Buffer.concat([iv, c.getAuthTag(), data]).toString('base64');
}

function localDecrypt(stored: string): string {
  const raw = Buffer.from(stored.slice(4), 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const d = crypto.createDecipheriv('aes-256-gcm', localKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}

export function encrypt(plain: string): string {
  if (secureMode() === 'local') return localEncrypt(plain);
  if (safeStorage.isEncryptionAvailable()) {
    return 'enc:' + safeStorage.encryptString(plain).toString('base64');
  }
  // Nouzový fallback (např. Linux bez keyringu) — označený, ne tajně plaintext
  return 'raw:' + Buffer.from(plain, 'utf8').toString('base64');
}

/**
 * Rozšifrování nikdy nevyhodí výjimku ven.
 *
 * Klíč v systémové klíčence je vázaný na název i podpis aplikace — po
 * přejmenování, po obnovení dat na jiném počítači nebo po aktualizaci bez
 * certifikátu se stará data přečíst nedají. Dřív z toho spadla hláška
 * „Error while decrypting the ciphertext", které uživatel nemohl rozumět.
 * Teď se vrátí prázdná hodnota a aplikace řekne srozumitelně, že chybí
 * heslo nebo klíč — a obnovit je jde ze zálohy.
 *
 * Čte se **oběma způsoby**, ať je zapnutý kterýkoli: po přepnutí režimu
 * se staré hodnoty přepíšou postupně, ne najednou.
 */
export function decrypt(stored: string): string {
  if (stored.startsWith('enc:')) {
    try {
      return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'));
    } catch {
      console.error('[secure] uloženou hodnotu nelze rozšifrovat — klíčenka patří k jinému podpisu aplikace');
      return '';
    }
  }
  if (stored.startsWith('loc:')) {
    try {
      return localDecrypt(stored);
    } catch {
      console.error('[secure] uloženou hodnotu nelze rozšifrovat — klíč v datech aplikace nesedí');
      return '';
    }
  }
  if (stored.startsWith('raw:')) {
    return Buffer.from(stored.slice(4), 'base64').toString('utf8');
  }
  return stored;
}

/**
 * Přepnutí režimu i s přepsáním toho, co je uložené.
 *
 * Bez přepsání by se uložená hesla dala přečíst jen tím starým způsobem —
 * a právě o to jde: po přepnutí na klíč v datech se **už nikdo nemá na co
 * ptát**. Prochází se jen tabulky, kde tajné hodnoty opravdu jsou; projít
 * celou databázi by znamenalo číst i poštu.
 */
export function resealAll(
  db: {
    prepare: (sql: string) => {
      all: (...args: any[]) => any[];
      run: (...args: any[]) => any
    }
  }
): number {
  let kolik = 0;
  const prepis = (sql: string, radky: any[], sloupec: string, klic: string) => {
    for (const row of radky) {
      const stara = String(row[sloupec] ?? '');
      if (!stara.startsWith('enc:') && !stara.startsWith('loc:')) continue;
      const plain = decrypt(stara);
      // Co se nepodařilo přečíst, se nesmí přepsat prázdnotou
      if (!plain) continue;
      db.prepare(sql).run(encrypt(plain), row[klic]);
      kolik++;
    }
  };

  prepis('UPDATE settings SET value = ? WHERE key = ?',
    db.prepare("SELECT key, value FROM settings WHERE value LIKE 'enc:%' OR value LIKE 'loc:%'").all(),
    'value', 'key');
  prepis('UPDATE accounts SET pass_enc = ? WHERE id = ?',
    db.prepare('SELECT id, pass_enc FROM accounts').all(), 'pass_enc', 'id');
  try {
    prepis('UPDATE ig_accounts SET token_enc = ? WHERE id = ?',
      db.prepare('SELECT id, token_enc FROM ig_accounts').all(), 'token_enc', 'id');
  } catch { /* modul sociálních sítí ještě nemá tabulky */ }
  return kolik;
}

/** Přepne způsob uložení a rovnou přepíše, co je uložené. */
export function setSecureMode(mode: SecureMode, db: any): { mode: SecureMode; changed: number } {
  if (!psat) throw new Error('Nastavení není připojené.');
  if (mode === secureMode()) return { mode, changed: 0 };
  /*
   * Pořadí je důležité: nejdřív se přečte starým způsobem, teprve pak se
   * přepne. Proto se hodnoty načtou a zapíšou až po změně nastavení —
   * `decrypt` umí obojí, `encrypt` se řídí novým režimem.
   */
  psat(REZIM, mode);
  const changed = resealAll(db);
  return { mode, changed };
}
