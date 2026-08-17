/**
 * Tenký klient nad Supabase REST. Žádná knihovna — jsou to čtyři druhy dotazů
 * a `fetch` na ně stačí.
 */
import { getSecrets } from './config';
import type { ChatConversation, ChatMessage } from '../../shared/types';

function base(): { url: string; key: string } {
  const s = getSecrets();
  if (!s.url || !s.anonKey) {
    throw new Error('Chat není nastavený (Chat → Nastavení: adresa Supabase a anon klíč).');
  }
  return { url: s.url, key: s.anonKey };
}

async function rest(path: string, init: RequestInit = {}): Promise<any> {
  const { url, key } = base();
  const res = await fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(init.method && init.method !== 'GET' ? { Prefer: 'return=representation' } : {}),
      ...(init.headers as Record<string, string> | undefined)
    }
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Chat: ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

function toConversation(r: any): ChatConversation {
  return {
    id: r.id,
    sessionId: r.session_id,
    status: r.status,
    name: r.customer_name ?? null,
    email: r.customer_email ?? null,
    phone: r.customer_phone ?? null,
    locale: r.customer_locale ?? 'cs',
    lastMessageAt: r.last_message_at,
    unread: r.unread_operator ?? 0,
    channel: r.channel ?? 'widget',
    createdAt: r.created_at,
    leftAt: r.left_at ?? null,
    answered: false
  };
}

function toMessage(r: any): ChatMessage {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    sender: r.sender,
    content: r.content,
    contentType: r.content_type ?? null,
    createdAt: r.created_at,
    readAt: r.read_at ?? null
  };
}

/**
 * Kdo psal v konverzaci naposled. Počítadlo `unread_operator` totiž zvyšuje
 * server u každé zprávy zákazníka, ale nuluje ho jen ten, kdo konverzaci
 * otevře ve webovém adminu — když se odpoví z Telegramu nebo z jiného
 * zařízení, zůstane viset. Poslední zpráva je spolehlivější znamení: pokud
 * je od nás, je vyřízeno.
 */
async function lastSenders(): Promise<Map<string, string>> {
  const rows = await rest('messages?select=conversation_id,sender,created_at&order=created_at.desc&limit=600');
  const map = new Map<string, string>();
  for (const r of rows ?? []) {
    if (!map.has(r.conversation_id)) map.set(r.conversation_id, r.sender);
  }
  return map;
}

/** Nepřečtené podle skutečnosti, ne podle počítadla. */
function effectiveUnread(row: any, lastSender: string | undefined): number {
  if (lastSender && lastSender !== 'customer') return 0;
  const counter = row.unread_operator ?? 0;
  // Poslední zpráva je od zákazníka, ale počítadlo je nulové (odpovědělo se
  // odjinud a pak přišla další otázka) — pořád je to jedna nepřečtená.
  return counter > 0 ? counter : (lastSender === 'customer' ? 1 : 0);
}

export async function listConversations(onlyOpen: boolean): Promise<ChatConversation[]> {
  const filter = onlyOpen ? '&status=eq.open' : '';
  const [rows, senders] = await Promise.all([
    rest(`conversations?select=*&order=last_message_at.desc&limit=150${filter}`),
    lastSenders().catch(() => new Map<string, string>())
  ]);

  const list: ChatConversation[] = [];
  for (const r of rows ?? []) {
    const last = senders.get(r.id);
    const unread = effectiveUnread(r, last);
    // Zapomenuté počítadlo rovnou srovnáme, ať se webový admin i Telegram
    // dívají na totéž
    if ((r.unread_operator ?? 0) > 0 && unread === 0) {
      patchConversation(r.id, { unread_operator: 0 }).catch(() => {});
    }
    list.push({ ...toConversation(r), unread, answered: !!last && last !== 'customer' });
  }
  return list;
}

/** Součet nepřečtených u otevřených konverzací — pro odznak v přepínači. */
export async function unreadTotal(): Promise<{ unread: number; conversations: number }> {
  const list = await listConversations(true);
  return {
    unread: list.reduce((sum, c) => sum + c.unread, 0),
    conversations: list.filter(c => c.unread > 0).length
  };
}

export async function listMessages(conversationId: string): Promise<ChatMessage[]> {
  const rows = await rest(
    `messages?select=*&conversation_id=eq.${encodeURIComponent(conversationId)}&order=created_at.asc&limit=500`
  );
  return (rows ?? []).map(toMessage);
}

export async function insertMessage(conversationId: string, content: string): Promise<ChatMessage> {
  const rows = await rest('messages', {
    method: 'POST',
    body: JSON.stringify({ conversation_id: conversationId, content, sender: 'operator' })
  });
  await patchConversation(conversationId, { last_message_at: new Date().toISOString() });
  return toMessage(Array.isArray(rows) ? rows[0] : rows);
}

export async function patchConversation(id: string, patch: Record<string, unknown>): Promise<void> {
  await rest(`conversations?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch)
  });
}

export async function markRead(id: string): Promise<void> {
  await patchConversation(id, { unread_operator: 0 });
}

export async function setStatus(id: string, status: 'open' | 'closed'): Promise<void> {
  await patchConversation(id, { status });
}

/** Ověření nastavení — dotaz, který nic nemění. */
export async function test(): Promise<string> {
  const rows = await rest('conversations?select=id&limit=1');
  return `Spojení funguje, konverzace se čtou (${(rows ?? []).length ? 'nějaké tam jsou' : 'zatím žádné'}).`;
}
