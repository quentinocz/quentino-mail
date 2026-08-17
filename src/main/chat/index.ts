/**
 * Vnější rozhraní chatu — všechno, co volá `ipc.ts`.
 */
import { BrowserWindow } from 'electron';
import * as config from './config';
import * as db from './supabase';
import * as products from './products';
import * as ai from './ai';
import { listPersons } from '../settings';
import type { ChatConversation, ChatMessage, ChatOverview, ChatProduct } from '../../shared/types';

export { config, products };
export const isConfigured = config.isConfigured;
export const getConfig = config.getConfig;
export const saveConfig = config.saveConfig;
export const test = db.test;
export const conversations = db.listConversations;
export const messages = db.listMessages;
export const markRead = db.markRead;
export const setStatus = db.setStatus;
export const searchProducts = products.search;
export const productsInDomain = products.inDomain;

function emit(channel: string, payload: unknown) {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload);
}

export async function overview(): Promise<ChatOverview> {
  const cfg = config.getConfig();
  if (!cfg.ready) {
    return { config: cfg, unread: 0, waiting: 0, persons: personOptions() };
  }
  const totals = await db.unreadTotal();
  return { config: cfg, unread: totals.unread, waiting: totals.conversations, persons: personOptions() };
}

/** Osoby jsou tytéž jako v podpisech pošty — nikde se nezadávají dvakrát. */
function personOptions(): { id: number; name: string; short: string }[] {
  return listPersons().map(p => ({
    id: p.id,
    name: p.name,
    short: shortName(p)
  }));
}

function shortName(p: { name: string; displayNames?: { cz: string } }): string {
  const display = p.displayNames?.cz?.trim();
  if (display) return display.split(/\s+/)[0];
  return (p.name || '').trim().split(/\s+/)[0];
}

/**
 * Podpis pod odpověď: „Petra, Quentino". Ve výchozím nastavení se přidá jen
 * k první odpovědi v konverzaci — dál už zákazník ví, s kým mluví, a podpis
 * pod každou větou by v chatu působil úředně.
 */
function signature(personId?: number | null): string | null {
  const cfg = config.getConfig();
  // 0 znamená „tuhle zprávu nepodepisovat", undefined „použij nastavení"
  if (personId === 0) return null;
  const id = personId ?? cfg.operatorPersonId;
  if (cfg.signMode === 'off' || !id) return null;
  const person = listPersons().find(p => p.id === id);
  if (!person) return null;
  const short = shortName(person);
  if (!short) return null;
  return cfg.signSuffix ? `${short}, ${cfg.signSuffix}` : short;
}

export async function send(
  conversationId: string,
  text: string,
  personId?: number | null
): Promise<ChatMessage[]> {
  const content = text.trim();
  if (!content) throw new Error('Zpráva je prázdná.');

  const cfg = config.getConfig();
  const sign = signature(personId);
  let finalText = content;

  if (sign) {
    const history = await db.listMessages(conversationId);
    const answeredBefore = history.some(m => m.sender === 'operator');
    const alreadySigned = content.trimEnd().endsWith(sign);
    if (!alreadySigned && (cfg.signMode === 'always' || !answeredBefore)) {
      finalText = `${content}\n\n${sign}`;
    }
  }

  await db.insertMessage(conversationId, finalText);
  await db.markRead(conversationId);
  emit('chat:changed', { conversationId });
  return db.listMessages(conversationId);
}

/** Karty k adresám ve zprávě; prázdné pole, když v ní žádné nejsou. */
export async function cards(text: string): Promise<ChatProduct[]> {
  const urls = products.extractUrls(text).slice(0, 6);
  if (urls.length === 0) return [];
  try {
    return await products.preview(urls);
  } catch {
    return []; // bez karty se zpráva pořád zobrazí
  }
}

export async function suggest(conversationId: string, note: string): Promise<string> {
  const [conv] = (await db.listConversations(false)).filter(c => c.id === conversationId);
  const history = await db.listMessages(conversationId);
  return ai.suggestReply({
    messages: history,
    locale: conv?.locale ?? 'cs',
    note,
    customer: { name: conv?.name, email: conv?.email }
  });
}

/* ---------- Hlídání nepřečtených na pozadí ---------- */

let lastUnread = -1;

export async function pollUnread(): Promise<void> {
  if (!config.isConfigured()) return;
  try {
    const totals = await db.unreadTotal();
    if (totals.unread !== lastUnread) {
      lastUnread = totals.unread;
      emit('chat:unread', totals);
    }
  } catch { /* výpadek sítě se řeší při dalším kole */ }
}

export type { ChatConversation };
