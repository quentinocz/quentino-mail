/**
 * Připojení účtu bez vlastního serveru.
 *
 * Meta vyžaduje návratovou adresu přes HTTPS, takže se v úložišti médií
 * vystaví jedna statická stránka, která přihlášení jen převezme a předá zpět
 * aplikaci přes odkaz `quentino-mail://ig-oauth`. Výměnu kódu za token pak
 * dělá sama aplikace — nic se nikam neposílá.
 *
 * Kdo nechce ani to, může v rozhraní vložit token ručně; obě cesty končí
 * stejně, uložením v systémové klíčence.
 */
import crypto from 'crypto';
import * as graph from './graph';
import * as store from './store';
import type { IgAccount } from '../../shared/types';

interface Pending {
  lang: string;
  nonce: string;
  token?: string;
  accounts?: graph.DiscoveredAccount[];
}

let pending: Pending | null = null;

export function startConnect(lang: string): string {
  const code = lang.trim().toUpperCase();
  if (!code) throw new Error('Vyber trh, ke kterému účet patří.');
  const nonce = crypto.randomBytes(12).toString('hex');
  pending = { lang: code, nonce };
  const state = Buffer.from(JSON.stringify({ lang: code, n: nonce })).toString('base64url');
  return graph.authUrl(state);
}

export interface ConnectResult {
  saved?: IgAccount;
  /** Když má uživatel víc stránek s Instagramem, musí si vybrat. */
  pick?: { igUserId: string; username: string; pageName: string }[];
}

/** Zpracuje adresu `quentino-mail://ig-oauth?...`, kterou vrátí prohlížeč. */
export async function handleCallbackUrl(raw: string): Promise<ConnectResult> {
  const url = new URL(raw);
  const error = url.searchParams.get('error_description') ?? url.searchParams.get('error');
  if (error) throw new Error(`Přihlášení se nedokončilo: ${error}`);

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state') ?? '';
  if (!code) throw new Error('Meta nevrátila přihlašovací kód.');

  let lang = pending?.lang ?? '';
  try {
    const parsed = JSON.parse(Buffer.from(state, 'base64url').toString());
    if (pending && parsed.n !== pending.nonce) throw new Error('Přihlášení nesouhlasí s tím, které aplikace začala.');
    lang = parsed.lang ?? lang;
  } catch (e: any) {
    if (!lang) throw new Error('Přihlášení nelze přiřadit k trhu — zkus to znovu z aplikace.');
  }

  const token = await graph.exchangeCode(code);
  return chooseAccount(lang, token);
}

/** Ruční cesta: uživatel vloží dlouhodobý token z Graph API Exploreru. */
export async function connectWithToken(lang: string, token: string): Promise<ConnectResult> {
  const code = lang.trim().toUpperCase();
  if (!code) throw new Error('Vyber trh, ke kterému účet patří.');
  if (!token.trim()) throw new Error('Vlož token.');
  let longLived = token.trim();
  try {
    longLived = await graph.exchangeLongLived(longLived);
  } catch {
    // Když se výměna nepovede (chybí App Secret), zkusíme token použít rovnou
  }
  await graph.verifyToken(longLived);
  return chooseAccount(code, longLived);
}

/**
 * Přidání dalšího trhu bez nového přihlášení — použije uložený uživatelský
 * token. `null` znamená, že žádný použitelný není a je potřeba se přihlásit.
 */
export async function connectFromSaved(lang: string): Promise<ConnectResult | null> {
  const code = lang.trim().toUpperCase();
  if (!code) throw new Error('Vyber trh, ke kterému účet patří.');
  const token = store.getUserToken();
  if (!token) return null;

  // Token vydaný před rozšířením oprávnění by se tvářil jako platný a selhal
  // by až při publikování na stránku — proto se rovnou zahodí.
  const missing = await graph.missingScopes(token);
  if (missing.length > 0) {
    store.clearUserToken();
    return null;
  }

  try {
    return await chooseAccount(code, token);
  } catch (e) {
    if (graph.isTokenError(e)) {
      store.clearUserToken();
      return null; // vypršelo — pošleme uživatele na přihlášení
    }
    throw e;
  }
}

/** Vynucené nové přihlášení: zahodí uložený přístup a vrátí adresu k otevření. */
export function relogin(lang: string): string {
  store.clearUserToken();
  return startConnect(lang);
}

async function chooseAccount(lang: string, token: string): Promise<ConnectResult> {
  const accounts = await graph.discoverAccounts(token);
  if (accounts.length === 0) {
    throw new Error('Na žádné z tvých stránek není napojený Instagram účet typu Business nebo Creator.');
  }
  // Přístup si pamatujeme, aby další trh nepotřeboval znovu projít přihlášením
  store.setUserToken(token, new Date(Date.now() + 59 * 864e5).toISOString());
  pending = { lang, nonce: pending?.nonce ?? '', token, accounts };
  if (accounts.length === 1) return { saved: saveDiscovered(lang, accounts[0]) };
  return { pick: accounts.map(a => ({ igUserId: a.igUserId, username: a.username, pageName: a.pageName })) };
}

export function finishConnect(igUserId: string): IgAccount {
  if (!pending?.accounts) throw new Error('Není co dokončovat — začni připojení znovu.');
  const found = pending.accounts.find(a => a.igUserId === igUserId);
  if (!found) throw new Error('Vybraný účet už není v nabídce.');
  return saveDiscovered(pending.lang, found);
}

function saveDiscovered(lang: string, a: graph.DiscoveredAccount): IgAccount {
  const account = store.saveAccountToken({
    igUserId: a.igUserId,
    username: a.username || a.pageName,
    lang,
    pageId: a.pageId,
    pageName: a.pageName,
    token: a.pageToken,
    expires: new Date(Date.now() + 59 * 864e5).toISOString(),
    isSource: lang === 'CS' && !store.sourceAccount()
  });
  pending = null;
  return account;
}
