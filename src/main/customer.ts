import { getDb } from './db';
import { shopMatchesSender } from './ordercard';
import type { CustomerContext, CustomerMessage, CustomerOrder } from '../shared/types';

/**
 * Kontext zákazníka — celá dosavadní komunikace a jeho objednávky.
 *
 * Skládá se jen z toho, co už je v databázi: zprávy podle e-mailové adresy
 * (v obou směrech, napříč složkami) a objednávky z indexu potvrzení. Nic se
 * nestahuje, takže se panel otevře okamžitě.
 */

/** Zpráva odešla od nás? */
function isOurs(row: { from_addr?: string; folder?: string }, ours: Set<string>): boolean {
  const from = normEmail(row.from_addr ?? '');
  if (from && ours.has(from)) return true;
  if (shopMatchesSender(row.from_addr ?? '')) return true;
  return /^(sent|odeslan|drafts|koncept)/i.test(row.folder ?? '');
}

function normEmail(s: string): string {
  const m = (s ?? '').match(/[\w.+-]+@[\w-]+\.[\w.]{2,}/);
  return m ? m[0].toLowerCase() : '';
}

/**
 * Odřízne citovanou část odpovědi. V chatu je zajímavý jen nový text —
 * podepsané citace předchozí zprávy by bubliny nafoukly na několik obrazovek.
 */
const QUOTE_MARKERS = [
  /^\s*d(?:ne|ňa)\b[\s\S]{0,120}?\bnaps?al[aoiy]?\b[^\n]{0,40}:/im,
  /^\s*on\b[\s\S]{0,120}?\bwrote:/im,
  /^\s*-{2,}\s*(p[ůu]vodn[íi]|original|forwarded|p[řr]eposlan)[^\n]*/im,
  /^\s*_{5,}\s*$/m,
  /^\s*(od|from|de)\s*:\s*[^\n]+\n\s*(odesl[áa]no|komu|to|sent|date|datum|p[řr]edm[ěe]t|subject)\s*:/im,
  /^\s*>{1,}\s*\S/m
];

/**
 * Citace v HTML mailech. Klienti je zabalují do <blockquote> nebo do vlastních
 * kontejnerů a vždy je dávají na konec — stačí tedy uříznout od prvního výskytu.
 * Bez tohohle se do bubliny slila celá historie vlákna jako jedna dlouhá zpráva.
 */
const HTML_QUOTE_STARTS = [
  /<blockquote/i,
  /class="[^"]*gmail_quote/i,
  /class="[^"]*moz-cite-prefix/i,
  /class="[^"]*yahoo_quoted/i,
  /id="divRplyFwdMsg/i,
  /id="appendonsend/i,
  /<hr[^>]*id="?stopSpelling/i,
  /<div[^>]*class="[^"]*OutlookMessageHeader/i
];

/** HTML → čitelný text: bloky se lámou na řádky a citace se odřízne. */
export function htmlToPlain(html: string): string {
  let src = html ?? '';
  let cut = src.length;
  for (const re of HTML_QUOTE_STARTS) {
    const m = src.match(re);
    if (m && m.index !== undefined && m.index < cut) cut = m.index;
  }
  // Řez padne doprostřed značky (hledá se atribut, ne její začátek), takže
  // se ještě odstraní nedokončený zbytek — jinak by v textu zůstalo „<div"
  src = src.slice(0, cut).replace(/<[^>]*$/, '');

  return src
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|tr|li|h[1-6]|table)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .split('\n')
    .map(l => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function stripQuoted(text: string): string {
  let body = (text ?? '').replace(/\r\n/g, '\n');
  let cut = body.length;
  for (const re of QUOTE_MARKERS) {
    const m = body.match(re);
    if (m && m.index !== undefined && m.index < cut) cut = m.index;
  }
  body = body.slice(0, cut);
  // Zbylé řádky citace („> …") a podpisový oddělovač
  const lines = body.split('\n');
  const kept: string[] = [];
  for (const l of lines) {
    if (/^\s*>/.test(l)) continue;
    if (/^--\s*$/.test(l)) break;
    kept.push(l);
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Text zprávy pro bublinu v chatu. HTML se čistí jinak než čistý text, ale
 * obojí nakonec projde ještě odřezáním textových citací — mail často obsahuje
 * obě podoby a citace může být v kterékoli z nich.
 */
export function messageText(bodyText: string | null, bodyHtml: string | null): string {
  const fromText = bodyText ? stripQuoted(bodyText) : '';
  const fromHtml = bodyHtml ? stripQuoted(htmlToPlain(bodyHtml)) : '';
  // Vybíráme kratší smysluplnou variantu — delší obvykle znamená, že se
  // citaci v dané podobě nepodařilo odříznout
  if (fromText && fromHtml) return fromText.length <= fromHtml.length ? fromText : fromHtml;
  return fromText || fromHtml;
}

/** Zprávy konverzace i s textem, pokud už je tělo stažené v databázi. */
export function customerConversation(emailRaw: string, limit = 80): CustomerContext {
  const ctx = customerContext(emailRaw, limit);
  const d = getDb();
  const get = d.prepare('SELECT body_text, body_html, fetched_full FROM messages WHERE id = ?');

  for (const m of ctx.messages) {
    const row = get.get(m.id) as any;
    if (!row?.fetched_full) { m.text = null; continue; }
    m.text = messageText(row.body_text, row.body_html).slice(0, 4000);
  }
  return ctx;
}

/** Adresy vlastních účtů — podle nich se pozná, co jsme poslali my. */
function ourAddresses(): Set<string> {
  try {
    const rows = getDb().prepare('SELECT email, username FROM accounts').all() as any[];
    const out = new Set<string>();
    for (const r of rows) {
      const a = normEmail(r.email ?? ''); if (a) out.add(a);
      const b = normEmail(r.username ?? ''); if (b) out.add(b);
    }
    return out;
  } catch {
    return new Set();
  }
}

export function customerContext(emailRaw: string, limit = 60): CustomerContext {
  const email = normEmail(emailRaw);
  if (!email) return { email: '', name: '', messages: [], orders: [] };

  const d = getDb();
  const ours = ourAddresses();
  const like = `%${email}%`;

  const rows = d.prepare(
    `SELECT id, date, subject, from_addr, from_name, to_addr, seen, answered, snippet, folder, has_attachments
     FROM messages
     WHERE lower(from_addr) LIKE ? OR lower(to_addr) LIKE ? OR lower(cc) LIKE ?
     ORDER BY date DESC LIMIT ?`
  ).all(like, like, like, limit) as any[];

  const messages: CustomerMessage[] = rows.map(r => ({
    id: r.id,
    date: r.date,
    subject: r.subject ?? '',
    snippet: r.snippet ?? '',
    // Odchozí je to, co odešlo od nás — podle adresy účtu, domény e-shopu
    // nebo složky Odeslané. Dřív se to poznávalo podle adresy zákazníka, takže
    // cokoli od třetí strany se tvářilo jako naše odpověď.
    incoming: !isOurs(r, ours),
    text: null,
    hasAttachments: !!r.has_attachments,
    seen: !!r.seen,
    answered: !!r.answered,
    isOrderMail: shopMatchesSender(r.from_addr ?? '') && /(objedn[áa]v|order\b)/i.test(r.subject ?? '')
  }));

  // Jméno bereme z poslední zprávy, kterou zákazník poslal
  const name = rows.find(r => normEmail(r.from_addr ?? '') === email && r.from_name)?.from_name ?? '';

  const orders: CustomerOrder[] = (d.prepare(
    `SELECT order_number, message_pk, date FROM order_index
     WHERE customer_email = ? ORDER BY date DESC LIMIT 25`
  ).all(email) as any[]).map(r => ({
    orderNumber: r.order_number,
    messageId: r.message_pk,
    date: r.date ?? ''
  }));

  return { email, name, messages, orders };
}
