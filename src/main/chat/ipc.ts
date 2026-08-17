/**
 * Kanály chatu. Stejná dohoda jako ve zbytku aplikace: `{ ok, data | error }`.
 */
import { ipcMain } from 'electron';
import * as chat from './index';

function handle(channel: string, fn: (...args: any[]) => any) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  });
}

export function registerChatIpc() {
  handle('chat:overview', () => chat.overview());
  handle('chat:saveConfig', (p: any) => chat.saveConfig(p ?? {}));
  handle('chat:test', () => chat.test());

  handle('chat:conversations', (onlyOpen?: boolean) => chat.conversations(onlyOpen !== false));
  handle('chat:messages', (id: string) => chat.messages(id));
  handle('chat:send', (id: string, text: string, personId?: number | null) => chat.send(id, text, personId));
  handle('chat:markRead', (id: string) => chat.markRead(id));
  handle('chat:setStatus', (id: string, status: 'open' | 'closed') => chat.setStatus(id, status));

  handle('chat:cards', (text: string) => chat.cards(text));
  handle('chat:searchProducts', (q: string) => chat.searchProducts(q));
  handle('chat:productInDomain', (id: string, domain: any) => chat.productsInDomain(id, domain));

  handle('chat:suggest', (id: string, note?: string) => chat.suggest(id, note ?? ''));
}
