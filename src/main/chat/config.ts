/**
 * Nastavení napojení na Quentino Chat.
 *
 * Aplikace mluví se stejnou databází jako webový admin — přes Supabase REST
 * s veřejným (anon) klíčem, protože pravidla přístupu jsou nastavená tam.
 * Produktové karty a vyhledávání produktů obstarává nasazený Vercel projekt.
 * Do samotného chatu se nic nepřidává, takže widget i admin fungují dál beze změn.
 */
import { getSetting, setSetting } from '../db';
import { encrypt, decrypt } from '../secure';
import type { ChatConfig } from '../../shared/types';

export interface ChatSecrets {
  url: string;
  anonKey: string;
  apiBase: string;
}

export function getSecrets(): ChatSecrets {
  const key = getSetting('chatAnonKey', '')!;
  return {
    url: (getSetting('chatSupabaseUrl', '')! || '').replace(/\/+$/, ''),
    anonKey: key ? decrypt(key) : '',
    apiBase: (getSetting('chatApiBase', '')! || '').replace(/\/+$/, '')
  };
}

export function isConfigured(): boolean {
  const s = getSecrets();
  return !!(s.url && s.anonKey);
}

export function getConfig(): ChatConfig {
  const s = getSecrets();
  return {
    url: s.url,
    hasKey: !!s.anonKey,
    apiBase: s.apiBase,
    ready: !!(s.url && s.anonKey),
    operatorPersonId: Number(getSetting('chatOperatorPersonId', '0')) || null,
    signMode: (getSetting('chatSignMode', 'first') as ChatConfig['signMode']),
    signSuffix: getSetting('chatSignSuffix', 'Quentino')!
  };
}

export function saveConfig(p: Partial<ChatConfig> & { anonKey?: string }): ChatConfig {
  if (p.url !== undefined) setSetting('chatSupabaseUrl', p.url.trim().replace(/\/+$/, ''));
  if (p.anonKey !== undefined) setSetting('chatAnonKey', p.anonKey ? encrypt(p.anonKey.trim()) : '');
  if (p.apiBase !== undefined) setSetting('chatApiBase', p.apiBase.trim().replace(/\/+$/, ''));
  if (p.operatorPersonId !== undefined) setSetting('chatOperatorPersonId', String(p.operatorPersonId ?? 0));
  if (p.signMode !== undefined) setSetting('chatSignMode', p.signMode);
  if (p.signSuffix !== undefined) setSetting('chatSignSuffix', p.signSuffix.trim());
  return getConfig();
}
