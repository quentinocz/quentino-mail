import { safeStorage } from 'electron';

/**
 * Šifrování citlivých údajů (hesla, API klíč) přes systémovou keychain
 * (macOS Keychain / Windows DPAPI). Ukládá se base64 ciphertext.
 */
export function encrypt(plain: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    return 'enc:' + safeStorage.encryptString(plain).toString('base64');
  }
  // Nouzový fallback (např. Linux bez keyringu) — označený, ne tajně plaintext
  return 'raw:' + Buffer.from(plain, 'utf8').toString('base64');
}

/**
 * Rozšifrování nikdy nevyhodí výjimku ven.
 *
 * Klíč v systémové klíčence je vázaný na název aplikace — po přejmenování
 * (nebo po obnovení dat na jiném počítači) se stará data přečíst nedají.
 * Dřív z toho spadla hláška „Error while decrypting the ciphertext", které
 * uživatel nemohl rozumět. Teď se vrátí prázdná hodnota a aplikace řekne
 * srozumitelně, že chybí heslo nebo klíč — a obnovit je jde ze zálohy.
 */
export function decrypt(stored: string): string {
  if (stored.startsWith('enc:')) {
    try {
      return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'));
    } catch {
      console.error('[secure] uloženou hodnotu nelze rozšifrovat — klíčenka patří k jinému názvu aplikace');
      return '';
    }
  }
  if (stored.startsWith('raw:')) {
    return Buffer.from(stored.slice(4), 'base64').toString('utf8');
  }
  return stored;
}
