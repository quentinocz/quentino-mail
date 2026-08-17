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

export function decrypt(stored: string): string {
  if (stored.startsWith('enc:')) {
    return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'));
  }
  if (stored.startsWith('raw:')) {
    return Buffer.from(stored.slice(4), 'base64').toString('utf8');
  }
  return stored;
}
