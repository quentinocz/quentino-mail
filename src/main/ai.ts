import Anthropic from '@anthropic-ai/sdk';
import { BrowserWindow } from 'electron';
import { getDb } from './db';
import { getSettings, getApiKey, listKnowledge } from './settings';
import { getAccountWithPassword } from './accounts';
import { ordersContextForAi } from './upgates';
import { AiReplyRequest, Category } from '../shared/types';

function emit(channel: string, payload: unknown) {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload);
}

export function client(): Anthropic {
  const key = getApiKey();
  if (!key) throw new Error('Není nastaven Anthropic API klíč (Nastavení → AI)');
  return new Anthropic({ apiKey: key });
}

/** Lokální evidence spotřeby tokenů (Anthropic nezveřejňuje zůstatek kreditu přes API). */
export function recordUsage(model: string, usage: { input_tokens?: number; output_tokens?: number } | undefined) {
  try {
    const month = new Date().toISOString().slice(0, 7);
    getDb().prepare(
      `INSERT INTO ai_usage (month, model, input_tokens, output_tokens, calls) VALUES (?,?,?,?,1)
       ON CONFLICT(month, model) DO UPDATE SET
         input_tokens = input_tokens + excluded.input_tokens,
         output_tokens = output_tokens + excluded.output_tokens,
         calls = calls + 1`
    ).run(month, model, usage?.input_tokens ?? 0, usage?.output_tokens ?? 0);
  } catch { /* evidence nesmí shodit AI funkce */ }
}

/** Orientační ceník USD za 1M tokenů (vstup/výstup) podle rodiny modelu. */
const PRICE_PER_MTOK: [RegExp, number, number][] = [
  [/haiku/i, 1, 5],
  [/sonnet/i, 3, 15],
  [/opus/i, 15, 75]
];

export function getAiUsage(): { month: string; calls: number; inputTokens: number; outputTokens: number; estUsd: number } {
  const month = new Date().toISOString().slice(0, 7);
  const rows = getDb().prepare('SELECT model, input_tokens, output_tokens, calls FROM ai_usage WHERE month = ?').all(month) as any[];
  let calls = 0, inputTokens = 0, outputTokens = 0, estUsd = 0;
  for (const r of rows) {
    calls += r.calls;
    inputTokens += r.input_tokens;
    outputTokens += r.output_tokens;
    const price = PRICE_PER_MTOK.find(([re]) => re.test(r.model)) ?? [null, 3, 15];
    estUsd += (r.input_tokens / 1e6) * (price[1] as number) + (r.output_tokens / 1e6) * (price[2] as number);
  }
  return { month, calls, inputTokens, outputTokens, estUsd: Math.round(estUsd * 100) / 100 };
}

export async function ask(model: string, system: string, user: string, maxTokens = 1024): Promise<string> {
  // Pozn.: `temperature` novější Claude modely již nepodporují — přesnost řešíme
  // instrukcemi v promptu a korekturním průchodem.
  const res = await client().messages.create({
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }]
  });
  recordUsage(model, res.usage as any);
  const block = res.content.find(b => b.type === 'text');
  return block && block.type === 'text' ? block.text.trim() : '';
}

/** Druhé kolo: korektura gramatiky, diakritiky, skloňování a plynulosti. */
async function proofread(model: string, text: string): Promise<string> {
  try {
    const fixed = await ask(
      model,
      'Jsi pečlivý korektor e-mailů. Oprav v textu gramatické chyby, překlepy, diakritiku, skloňování, shodu podmětu s přísudkem a neobratné či nesmyslné formulace. Zachovej jazyk, obsah, tón i délku textu. Nic nepřidávej ani neubírej. Vrať POUZE opravený text.',
      text,
      1500
    );
    return fixed || text;
  } catch {
    return text;
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>(?=.)/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function messageText(row: any, maxLen = 6000): string {
  const t = row.body_text || (row.body_html ? stripHtml(row.body_html) : '') || row.snippet || '';
  return t.slice(0, maxLen);
}

/* ---------- Shrnutí ---------- */

/**
 * Krátká klasifikace do jedné z nabídnutých hodnot. Používá rychlý model
 * a odpověď se omezí na pár tokenů — je to nejlevnější druh dotazu.
 */
export async function classifyText(system: string, user: string, options: string[]): Promise<string> {
  const s = getSettings();
  const answer = await ask(
    s.fastModel,
    `${system} Odpověz výhradně jedním slovem z této nabídky: ${options.join(', ')}.`,
    user,
    12
  );
  return answer.trim().replace(/[^a-z]/gi, '').toLowerCase();
}

export async function summarize(dbId: number): Promise<string> {
  const d = getDb();
  const row = d.prepare('SELECT * FROM messages WHERE id = ?').get(dbId) as any;
  if (!row) throw new Error('Zpráva nenalezena');
  if (row.summary) return row.summary;
  const s = getSettings();
  const text = messageText(row, 4000);
  const summary = await ask(
    s.fastModel,
    'Shrň e-mail do jedné krátké české věty (max 15 slov). Vystihni, co odesílatel chce nebo sděluje. Odpověz jen tou větou, nic víc.',
    `Od: ${row.from_name} <${row.from_addr}>\nPředmět: ${row.subject}\n\n${text}`,
    100
  );
  d.prepare('UPDATE messages SET summary = ? WHERE id = ?').run(summary, dbId);
  emit('messages:changed', { accountId: row.account_id, folder: row.folder });
  return summary;
}

/* ---------- Kategorizace ---------- */

const VALID_CATEGORIES: Category[] = ['orders', 'people', 'companies', 'other'];

export async function categorizeUncategorized(accountId: number, folder: string, limit = 20): Promise<void> {
  const d = getDb();
  const s = getSettings();
  const rows = d.prepare(
    'SELECT id, subject, from_addr, from_name, snippet FROM messages WHERE account_id = ? AND folder = ? AND category IS NULL ORDER BY date DESC LIMIT ?'
  ).all(accountId, folder, limit) as any[];
  if (rows.length === 0) return;

  const upd = d.prepare('UPDATE messages SET category = ? WHERE id = ?');

  // 1) Pravidla (rychlá, zdarma)
  const remaining: any[] = [];
  for (const r of rows) {
    const rule = s.categoryRules.find(cr => {
      const hay = (cr.field === 'from' ? `${r.from_addr} ${r.from_name}` : r.subject).toLowerCase();
      return hay.includes(cr.contains.toLowerCase());
    });
    if (rule) upd.run(rule.category, r.id);
    else remaining.push(r);
  }

  // 2) AI klasifikace zbytku (dávkově)
  if (remaining.length > 0 && getApiKey()) {
    const listing = remaining
      .map((r, i) => `${i + 1}. Od: ${r.from_name} <${r.from_addr}> | Předmět: ${r.subject} | Úryvek: ${r.snippet.slice(0, 100)}`)
      .join('\n');
    try {
      const out = await ask(
        s.fastModel,
        `Třídíš příchozí e-maily e-shopu Quentino do kategorií:
- orders: nové objednávky, potvrzení objednávek, platby, doprava objednávek
- people: zprávy od koncových zákazníků / fyzických osob (dotazy, reklamace, poděkování)
- companies: firemní komunikace (dodavatelé, faktury, B2B nabídky, úřady, služby)
- other: newslettery, spam, automatické notifikace, vše ostatní
Odpověz POUZE řádky ve tvaru "číslo: kategorie", nic jiného.`,
        listing,
        1000
      );
      for (const line of out.split('\n')) {
        const m = line.match(/^(\d+)\s*[:.]\s*(orders|people|companies|other)/i);
        if (!m) continue;
        const idx = parseInt(m[1], 10) - 1;
        const cat = m[2].toLowerCase() as Category;
        if (remaining[idx] && VALID_CATEGORIES.includes(cat)) upd.run(cat, remaining[idx].id);
      }
    } catch {
      /* bez API klíče / chyba sítě — zkusí se příště */
    }
  }
  emit('messages:changed', { accountId, folder });
}

/* ---------- Automatické zpracování po synchronizaci ---------- */

export async function autoProcessNewMessages(
  accountId: number,
  folder: string,
  fetchFull?: (dbId: number) => Promise<unknown>
): Promise<void> {
  const s = getSettings();
  if (folder.toUpperCase() !== 'INBOX') return;
  if (s.autoCategorize) {
    await categorizeUncategorized(accountId, folder).catch(() => {});
  }
  if (!getApiKey()) return;
  const d = getDb();

  // Když je vybraná konkrétní kategorie, platí jen ta — obecné shrnutí by
  // jinak stejně shrnulo všechno, včetně objednávek, které uživatel nechtěl
  const onlyChosen = s.autoSummarizeCategories.length > 0;

  // Obecné auto-shrnutí nepřečtených (pouze již stažená těla)
  if (s.autoSummarize && !onlyChosen) {
    const rows = d.prepare(
      'SELECT id FROM messages WHERE account_id = ? AND folder = ? AND seen = 0 AND summary IS NULL AND fetched_full = 1 ORDER BY date DESC LIMIT 5'
    ).all(accountId, folder) as any[];
    for (const r of rows) await summarize(r.id).catch(() => {});
  }

  // Shrnutí dle zvolených kategorií — stáhne tělo ze serveru, pokud chybí.
  // Zprávy bez kategorie se neshrnují: `IN (…)` je s NULL nespáruje.
  if (onlyChosen && fetchFull) {
    const placeholders = s.autoSummarizeCategories.map(() => '?').join(',');
    const rows = d.prepare(
      `SELECT id, fetched_full FROM messages
       WHERE account_id = ? AND folder = ? AND summary IS NULL AND category IN (${placeholders})
       ORDER BY date DESC LIMIT 8`
    ).all(accountId, folder, ...s.autoSummarizeCategories) as any[];
    for (const r of rows) {
      if (!r.fetched_full) await fetchFull(r.id).catch(() => {});
      await summarize(r.id).catch(() => {});
    }
  }
}

/* ---------- Generování odpovědi ---------- */

function threadContext(dbId: number): { context: string; row: any } {
  const d = getDb();
  const row = d.prepare('SELECT * FROM messages WHERE id = ?').get(dbId) as any;
  if (!row) throw new Error('Zpráva nenalezena');
  const thread = d.prepare(
    'SELECT * FROM messages WHERE account_id = ? AND thread_key = ? ORDER BY date ASC LIMIT 10'
  ).all(row.account_id, row.thread_key) as any[];
  const msgs = thread.length > 0 ? thread : [row];
  const context = msgs
    .map(m => `--- ${m.date} | Od: ${m.from_name} <${m.from_addr}>\nPředmět: ${m.subject}\n${messageText(m, 2500)}`)
    .join('\n\n');
  return { context, row };
}

/** Znalostní báze: kontaktní údaje + nahrané dokumenty (podmínky, reklamační řád…). */
function buildKnowledgeBlock(): string {
  const s = getSettings();
  let out = '';
  if (s.contactInfo.trim()) {
    out += `## Kontaktní údaje firmy\n${s.contactInfo.trim()}\n\n`;
  }
  for (const doc of listKnowledge()) {
    out += `## ${doc.title}\n${doc.content.slice(0, 2500)}\n\n`;
    if (out.length > 9000) break;
  }
  return out.slice(0, 10000);
}

/** Poslední odeslané odpovědi (nejdřív stejnému adresátovi) — vzor stylu a obvyklých řešení. */
function previousReplies(accountId: number, theirAddr: string): string {
  const acc = getAccountWithPassword(accountId);
  if (!acc) return '';
  const rows = getDb().prepare(
    `SELECT subject, body_text FROM messages
     WHERE account_id = ? AND from_addr = ? AND body_text IS NOT NULL AND body_text != ''
     ORDER BY CASE WHEN to_addr LIKE ? THEN 0 ELSE 1 END, date DESC LIMIT 3`
  ).all(accountId, acc.email, `%${theirAddr}%`) as any[];
  if (rows.length === 0) return '';
  return rows
    .map(r => `Předmět: ${r.subject}\n${String(r.body_text).slice(0, 800)}`)
    .join('\n---\n');
}

export async function generateReply(req: AiReplyRequest): Promise<string> {
  const s = getSettings();
  const { context, row } = threadContext(req.messageDbId);
  const langInstr =
    req.language === 'cs'
      ? 'Odpověď napiš česky.'
      : req.language === 'auto'
        ? 'Odpověď napiš ve stejném jazyce, v jakém je poslední příchozí zpráva.'
        : `Odpověď napiš v jazyce s ISO kódem "${req.language}".`;

  const knowledge = buildKnowledgeBlock();
  const examples = previousReplies(row.account_id, row.from_addr);
  const orders = await ordersContextForAi(row.from_addr);

  const system = `${s.brandPrompt}

${orders ? `# Objednávky tohoto zákazníka (ŽIVÁ data z e-shopu Upgates — stav, tracking a částky z nich můžeš uvádět jako fakta):\n${orders}\n\n` : ''}${knowledge ? `# Firemní znalosti (jediný zdroj faktů o podmínkách, kontaktech a procesech):\n${knowledge}\n` : ''}${examples ? `# Ukázky našich dřívějších odpovědí (drž se jejich stylu a obvyklých řešení):\n${examples}\n` : ''}
Tvůj úkol: na základě e-mailového vlákna${req.note ? ' a stručné poznámky uživatele' : ''} napiš kompletní, zdvořilou odpověď v celých větách a se správnou strukturou (oslovení, tělo, závěr). ${langInstr}
Pravidla: Nepiš předmět. Nepřidávej podpis (doplní se automaticky). Nepoužívej zástupné texty v hranatých závorkách. Fakta (doprava, termíny, ceny, podmínky) čerpej výhradně z vlákna a firemních znalostí — nic si nedomýšlej. Odpověz POUZE textem e-mailu.`;

  const draft = await ask(
    s.draftModel,
    system,
    `E-mailové vlákno:\n${context}\n\nPoznámka uživatele (co má odpověď sdělit): ${req.note || 'Vhodně a vstřícně odpověz na poslední zprávu; využij firemní znalosti, pokud jsou relevantní.'}`,
    1500
  );
  // Korekturní průchod výrazně snižuje gramatické a sémantické chyby
  return proofread(s.draftModel, draft);
}

/* ---------- Denní AI přehled ---------- */

export async function generateDigest(): Promise<string> {
  const s = getSettings();
  const d = getDb();
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const rows = d.prepare(
    `SELECT from_name, from_addr, subject, snippet, summary, category, seen, answered, date
     FROM messages WHERE folder = 'INBOX' AND date > ? ORDER BY date DESC LIMIT 60`
  ).all(since) as any[];
  if (rows.length === 0) return 'Za posledních 24 hodin nepřišly žádné nové zprávy. 🎉';

  const catLabel: Record<string, string> = { orders: 'objednávka', people: 'zákazník', companies: 'firma', other: 'ostatní' };
  const listing = rows.map(r =>
    `[${r.seen ? 'přečteno' : 'NEPŘEČTENO'}${r.answered ? ', zodpovězeno' : ''}] (${catLabel[r.category] ?? '—'}) ` +
    `${r.from_name || r.from_addr}: ${r.subject} — ${r.summary || r.snippet.slice(0, 100)}`
  ).join('\n');

  return ask(
    s.draftModel,
    `Jsi asistent e-shopu Quentino. Z výpisu e-mailů za posledních 24 hodin sestav stručný český přehled dne:
1. Dvě–tři věty celkového shrnutí (kolik zpráv, co převažuje).
2. "Vyžaduje reakci:" — seznam nepřečtených/nezodpovězených zpráv od zákazníků, u každé odesílatel a o co jde (jedna řádka). Urgentní věci (reklamace, naštvaný zákazník, problém s doručením) dej na začátek a označ ⚠️.
3. "Objednávky:" — kolik přišlo, případně zajímavosti.
4. "Ostatní:" — jen pokud je něco za zmínku (faktury, dodavatelé). Newslettery a spam ignoruj.
Piš prostý text bez markdownu, přehledně po řádcích.`,
    listing,
    1200
  );
}

/* ---------- Vylepšení / gramatika ---------- */

export async function improveText(text: string, mode: 'improve' | 'grammar'): Promise<string> {
  const s = getSettings();
  const system =
    mode === 'grammar'
      ? 'Oprav v textu e-mailu gramatiku, překlepy, diakritiku a interpunkci. Nic jiného neměň — zachovej styl, obsah i délku. Vrať POUZE opravený text.'
      : `${s.brandPrompt}\n\nVylepši následující text e-mailu: uhlazenější formulace, správná struktura, zdvořilý a pozitivní tón odpovídající značce. Zachovej jazyk originálu a veškerá fakta. Vrať POUZE vylepšený text e-mailu, bez komentářů.`;
  const out = await ask(s.draftModel, system, text, 1500);
  return mode === 'grammar' ? out : proofread(s.draftModel, out);
}

/* ---------- Překlady ---------- */

export async function translateIncoming(dbId: number): Promise<{ lang: string; translation: string }> {
  const d = getDb();
  const row = d.prepare('SELECT * FROM messages WHERE id = ?').get(dbId) as any;
  if (!row) throw new Error('Zpráva nenalezena');
  if (row.translation_cz && row.detected_lang) {
    return { lang: row.detected_lang, translation: row.translation_cz };
  }
  const s = getSettings();
  const text = messageText(row, 5000);
  const out = await ask(
    s.fastModel,
    `Na prvním řádku vrať ISO 639-1 kód jazyka textu (např. "en", "de", "cs").
Pokud je text česky nebo slovensky, na druhý řádek napiš jen "SKIP".
Jinak od druhého řádku dál napiš věrný český překlad celého textu. Žádné komentáře.`,
    `Předmět: ${row.subject}\n\n${text}`,
    2000
  );
  const nl = out.indexOf('\n');
  const lang = (nl === -1 ? out : out.slice(0, nl)).trim().toLowerCase().slice(0, 5);
  const rest = nl === -1 ? '' : out.slice(nl + 1).trim();
  const translation = rest === 'SKIP' ? '' : rest;
  d.prepare('UPDATE messages SET detected_lang = ?, translation_cz = ? WHERE id = ?').run(lang, translation, dbId);
  return { lang, translation };
}

export async function translateHtml(html: string, targetLang: string): Promise<string> {
  const s = getSettings();
  return ask(
    s.draftModel,
    `Přelož text e-mailu do jazyka s ISO kódem "${targetLang}". Vstup může obsahovat jednoduché HTML značky — zachovej je beze změny, přelož pouze text. Vrať POUZE přeložený obsah.`,
    html,
    2500
  );
}

export async function translateText(text: string, targetLang: string): Promise<string> {
  const s = getSettings();
  return ask(
    s.draftModel,
    `Přelož následující text e-mailu do jazyka s ISO kódem "${targetLang}". Zachovej strukturu odstavců. Vrať POUZE překlad.`,
    text,
    2500
  );
}
