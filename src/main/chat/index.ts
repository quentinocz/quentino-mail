/**
 * Vnější rozhraní chatu — všechno, co volá `ipc.ts`.
 */
import fs from 'fs';
import path from 'path';
import { BrowserWindow } from 'electron';
import * as config from './config';
import * as db from './supabase';
import * as products from './products';
import * as ai from './ai';
import { listPersons, getSettings } from '../settings';
import { getSetting, setSetting } from '../db';
import { notifyPhone, wantsNotify, chatLink } from '../notify';
import type {
  ChatConversation, ChatMessage, ChatOverview, ChatProduct, ChatWaiting
} from '../../shared/types';

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

const IMAGE_MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  webp: 'image/webp', gif: 'image/gif', heic: 'image/heic', heif: 'image/heif'
};

/**
 * Obrázek zákazníkovi. Soubor se nahrává tam, kam ho nahrává i widget
 * (`/api/chat/upload` nasazeného chatu), a do konverzace pak jde zpráva
 * s adresou a typem `image` — přesně jak to dělá webový admin, takže se
 * obrázek zobrazí i ve widgetu.
 */
export async function sendImage(conversationId: string, file: string): Promise<ChatMessage[]> {
  const base = config.getSecrets().apiBase;
  if (!base) throw new Error('Není vyplněná adresa chatu (Chat → Nastavení).');

  const ext = path.extname(file).toLowerCase().slice(1);
  const mime = IMAGE_MIME[ext];
  if (!mime) throw new Error('Podporují se jen obrázky (JPG, PNG, WebP, GIF, HEIC).');

  const data = fs.readFileSync(file);
  if (data.length > 8 * 1024 * 1024) throw new Error('Obrázek je větší než 8 MB — chat víc nepřijme.');

  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(data)], { type: mime }), path.basename(file));
  form.append('conversation_id', conversationId);

  const res = await fetch(`${base}/api/chat/upload`, { method: 'POST', body: form });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body?.url) {
    throw new Error(`Obrázek se nepodařilo nahrát: ${body?.error ?? res.status}`);
  }

  await db.insertMessage(conversationId, body.url, 'image');
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
let lastCeka = -1;

/**
 * Kdo čeká na odpověď.
 *
 * Nepřečtené zprávy nejsou totéž co nevyřízený chat: zprávu si lze
 * přečíst a nechat ji ležet — a právě to se stávalo. Čeká ten otevřený
 * rozhovor, kde poslední slovo má zákazník (`answered === false`),
 * a je jedno, jestli se na něj někdo díval.
 */
export async function cekajici(): Promise<ChatWaiting> {
  if (!config.isConfigured()) return { pocet: 0, minut: 0, jmena: [], id: '' };
  const list = await db.listConversations(true);
  const ceka = list
    .filter(c => !c.answered)
    .sort((a, b) => String(a.lastMessageAt).localeCompare(String(b.lastMessageAt)));
  if (ceka.length === 0) return { pocet: 0, minut: 0, jmena: [], id: '' };
  const nejstarsi = ceka[0];
  const kdy = Date.parse(nejstarsi.lastMessageAt || '') || Date.now();
  return {
    pocet: ceka.length,
    minut: Math.max(0, Math.round((Date.now() - kdy) / 60000)),
    // Jména jen pár — do bubliny v panelu se jich víc nevejde
    jmena: ceka.slice(0, 3).map(c => (c.name || c.email || 'Zákazník').trim()),
    id: nejstarsi.id
  };
}

/**
 * Připomínka na telefon, dokud se neodpoví.
 *
 * Jedno upozornění při příchodu zprávy posílá sám projekt (spoušť
 * v databázi). Jenže zpráva přijde ve chvíli, kdy je člověk u jiné
 * práce — a druhá už nepřijde, takže zákazník čeká do večera. Proto
 * je na výběr i opakování: každých pár minut, dokud se neodpoví.
 *
 * Hlídá to počítač, ne telefon — spoušť v databázi se spustí jen při
 * nové zprávě a telefon na pozadí budit nelze spolehlivě.
 */
async function pripomen(ceka: ChatWaiting): Promise<void> {
  const s = getSettings();
  if (s.notifyChatMode !== 'repeat' || !wantsNotify('chat')) return;
  const kazdych = Math.max(1, Math.min(240, s.notifyChatEvery || 15));
  if (ceka.pocet === 0 || ceka.minut < kazdych) return;

  const posledni = Number(getSetting('chatNudgeAt', '0')) || 0;
  if (Date.now() - posledni < kazdych * 60_000) return;
  setSetting('chatNudgeAt', String(Date.now()));

  const kdo = ceka.jmena[0] || 'Zákazník';
  await notifyPhone(
    'chat',
    ceka.pocet === 1 ? 'Zákazník čeká na odpověď' : `${ceka.pocet} zákazníci čekají na odpověď`,
    ceka.pocet === 1
      ? `${kdo} napsal před ${ceka.minut} min a zatím bez odpovědi.`
      : `Nejdéle čeká ${kdo} — ${ceka.minut} min.`,
    { click: chatLink(ceka.id), priority: 4 }
  );
}

export async function pollUnread(): Promise<void> {
  if (!config.isConfigured()) return;
  try {
    const totals = await db.unreadTotal();
    // Každý úspěšný dotaz se počítá jako oťukání — projekt se právě ozval
    config.markSeen();
    const ceka = await cekajici();
    /*
     * Hlásí se i změna počtu čekajících, ne jen nepřečtených. Bublina
     * u tlačítka chatu na tom stojí: zpráva přečtená a nezodpovězená
     * nepřečtené nemění, ale čekat zákazník nepřestane.
     */
    if (totals.unread !== lastUnread || ceka.pocet !== lastCeka) {
      lastUnread = totals.unread;
      lastCeka = ceka.pocet;
      emit('chat:unread', { ...totals, ceka });
    }
    await pripomen(ceka);
  } catch { /* výpadek sítě se řeší při dalším kole */ }
}

export type { ChatConversation };
