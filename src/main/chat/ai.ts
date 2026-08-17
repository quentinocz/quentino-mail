/**
 * Návrh odpovědi do chatu.
 *
 * Vychází ze stejných podkladů jako pošta — hlas značky, znalostní báze,
 * kontaktní údaje — ale píše se jinak: krátce, bez oslovení a podpisu (ten
 * doplní aplikace) a v jazyce, kterým píše zákazník.
 */
import { client, recordUsage } from '../ai';
import { getSettings, listKnowledge } from '../settings';
import type { ChatMessage } from '../../shared/types';

const LANG_NAME: Record<string, string> = { cs: 'česky', sk: 'slovensky', en: 'anglicky' };

export interface ReplyRequest {
  messages: ChatMessage[];
  locale: string;
  /** Poznámka operátora — co má odpověď říct */
  note?: string;
  customer?: { name?: string | null; email?: string | null };
}

export async function suggestReply(req: ReplyRequest): Promise<string> {
  const s = getSettings();
  const knowledge = listKnowledge().map(k => `${k.title}: ${k.content}`).join('\n\n').slice(0, 12_000);

  const history = req.messages
    .slice(-25)
    .map(m => `${m.sender === 'operator' ? 'My' : m.sender === 'system' ? 'Systém' : 'Zákazník'}: ${m.content}`)
    .join('\n');

  const system = [
    s.brandPrompt,
    '',
    'Píšeš odpovědi do živého chatu na e-shopu, ne e-maily.',
    `Odpovídej ${LANG_NAME[req.locale] ?? 'česky'} — jazykem, kterým píše zákazník.`,
    'Drž se do tří vět. Žádné oslovení, žádný podpis, žádný pozdrav na konci — chat na to není.',
    'Když něco nevíš jistě, řekni to a nabídni, že to zjistíš.',
    'Nikdy si nevymýšlej ceny, termíny dodání ani dostupnost.',
    'Když se hodí konkrétní produkt, popiš ho slovy — odkaz vloží člověk sám.',
    s.contactInfo ? `\nKONTAKTNÍ ÚDAJE\n${s.contactInfo}` : '',
    knowledge ? `\nZNALOSTNÍ BÁZE\n${knowledge}` : ''
  ].filter(Boolean).join('\n');

  const user = [
    `PRŮBĚH KONVERZACE\n${history || '(zatím nic)'}`,
    req.customer?.name || req.customer?.email
      ? `\nZÁKAZNÍK: ${[req.customer?.name, req.customer?.email].filter(Boolean).join(' · ')}`
      : '',
    req.note?.trim() ? `\nCO MÁ ODPOVĚĎ ŘÍCT\n${req.note.trim()}` : '',
    '\nNapiš jen text odpovědi, nic jiného.'
  ].filter(Boolean).join('\n');

  const res = await client().messages.create({
    model: s.draftModel,
    max_tokens: 600,
    system,
    messages: [{ role: 'user', content: user }]
  });
  recordUsage(s.draftModel, res.usage as any);

  const block = res.content.find(b => b.type === 'text');
  return block && block.type === 'text' ? block.text.trim() : '';
}
