import { getDb, getSetting, setSetting } from './db';
import { ContactHit } from '../shared/types';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Zapamatuje si adresu pro našeptávač (nová = uses 1, existující = +1). */
export function rememberContact(emailRaw: string, name = ''): void {
  const email = emailRaw.trim().toLowerCase().replace(/[<>]/g, '');
  if (!EMAIL_RE.test(email)) return;
  getDb().prepare(
    `INSERT INTO contacts (email, name) VALUES (?, ?)
     ON CONFLICT(email) DO UPDATE SET
       uses = uses + 1,
       last_used = datetime('now'),
       name = CASE WHEN excluded.name != '' THEN excluded.name ELSE contacts.name END`
  ).run(email, name.trim());
}

export function rememberAddressList(list: string, name = ''): void {
  for (const part of list.split(/[,;]/)) {
    // Formáty: "jmeno@domena.cz" i "Jméno Příjmení <jmeno@domena.cz>"
    const m = part.match(/<([^>]+)>/);
    const display = part.replace(/<[^>]*>/, '').replace(/["']/g, '').trim();
    rememberContact(m ? m[1] : part, m ? display : name);
  }
}

export function searchContacts(query: string, limit = 8): ContactHit[] {
  const q = `%${query.trim()}%`;
  if (!query.trim()) return [];
  return getDb().prepare(
    'SELECT email, name FROM contacts WHERE email LIKE ? OR name LIKE ? ORDER BY uses DESC, last_used DESC LIMIT ?'
  ).all(q, q, limit) as ContactHit[];
}

/** Jednorázově naplní kontakty z už stažených zpráv (existující instalace). */
export function backfillContacts(): void {
  if (getSetting('contactsBackfilled') === '1') return;
  const d = getDb();
  const rows = d.prepare('SELECT from_addr, from_name, to_addr FROM messages').all() as any[];
  for (const r of rows) {
    if (r.from_addr) rememberContact(r.from_addr, r.from_name ?? '');
    if (r.to_addr) rememberAddressList(r.to_addr);
  }
  setSetting('contactsBackfilled', '1');
}
