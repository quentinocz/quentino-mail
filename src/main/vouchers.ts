/**
 * Šablony dárkových poukazů.
 *
 * Šablona drží hodnotu, platnost a jazyk — a k tomu buď jeden pevný kód
 * (hromadná akce, všichni dostanou stejný), nebo zásobu unikátních kódů,
 * ze které se při každém vložení odebere jeden.
 *
 * Kódy se odepisují v transakci a odepsání se pozná i na druhém zařízení
 * (synchronizace slučuje použití, ne poslední stav), takže se stejný kód
 * nerozešle dvakrát.
 */
import crypto from 'crypto';
import { getDb } from './db';
import { touchState } from './settings';
import type { MailLang, VoucherSpec, VoucherTemplate } from '../shared/types';

function rowToTemplate(r: any): VoucherTemplate {
  return {
    id: r.id,
    name: r.name,
    value: r.value,
    unit: r.unit as VoucherSpec['unit'],
    validUntil: r.valid_until,
    note: r.note,
    lang: r.lang as MailLang,
    codeMode: r.code_mode === 'unique' ? 'unique' : 'fixed',
    fixedCode: r.fixed_code,
    codesTotal: r.codes_total ?? 0,
    codesFree: r.codes_free ?? 0,
    updatedAt: r.updated_at
  };
}

export function listTemplates(): VoucherTemplate[] {
  const rows = getDb().prepare(
    `SELECT t.*,
            (SELECT COUNT(*) FROM voucher_codes c WHERE c.template_id = t.id) AS codes_total,
            (SELECT COUNT(*) FROM voucher_codes c WHERE c.template_id = t.id AND c.used_at IS NULL) AS codes_free
     FROM voucher_templates t
     WHERE t.archived = 0
     ORDER BY t.name COLLATE NOCASE`
  ).all() as any[];
  return rows.map(rowToTemplate);
}

export function saveTemplate(t: Partial<VoucherTemplate> & { name: string }): VoucherTemplate[] {
  const d = getDb();
  const id = t.id || crypto.randomUUID();
  d.prepare(
    `INSERT INTO voucher_templates (id, name, value, unit, valid_until, note, lang, code_mode, fixed_code, archived, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,0,?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, value = excluded.value, unit = excluded.unit,
       valid_until = excluded.valid_until, note = excluded.note, lang = excluded.lang,
       code_mode = excluded.code_mode, fixed_code = excluded.fixed_code,
       archived = 0, updated_at = excluded.updated_at`
  ).run(
    id, t.name.trim(), t.value ?? '', t.unit ?? 'CZK', t.validUntil ?? '', t.note ?? '',
    t.lang ?? 'cz', t.codeMode ?? 'fixed', (t.fixedCode ?? '').trim(), new Date().toISOString()
  );
  touchState();
  return listTemplates();
}

/**
 * Smazání je jen příznak. Kdyby se šablona rovnou vymazala, druhé zařízení by
 * ji při nejbližší synchronizaci vrátilo zpátky.
 */
export function deleteTemplate(id: string): VoucherTemplate[] {
  getDb().prepare('UPDATE voucher_templates SET archived = 1, updated_at = ? WHERE id = ?')
    .run(new Date().toISOString(), id);
  touchState();
  return listTemplates();
}

/** Vložený seznam se rozseká po řádcích i čárkách; duplicity se tiše přeskočí. */
export function addCodes(templateId: string, raw: string): { added: number; skipped: number } {
  const d = getDb();
  const codes = Array.from(new Set(
    raw.split(/[\s,;]+/).map(c => c.trim()).filter(Boolean)
  ));
  const ins = d.prepare('INSERT OR IGNORE INTO voucher_codes (template_id, code) VALUES (?,?)');
  let added = 0;
  const tx = d.transaction(() => {
    for (const code of codes) added += ins.run(templateId, code).changes;
  });
  tx();
  touchState();
  return { added, skipped: codes.length - added };
}

export interface VoucherCodeRow {
  code: string;
  usedAt: string | null;
  usedFor: string;
}

export function listCodes(templateId: string): VoucherCodeRow[] {
  const rows = getDb().prepare(
    'SELECT code, used_at, used_for FROM voucher_codes WHERE template_id = ? ORDER BY used_at IS NOT NULL, code'
  ).all(templateId) as any[];
  return rows.map(r => ({ code: r.code, usedAt: r.used_at, usedFor: r.used_for }));
}

export function deleteCode(templateId: string, code: string): VoucherCodeRow[] {
  getDb().prepare('DELETE FROM voucher_codes WHERE template_id = ? AND code = ?').run(templateId, code);
  touchState();
  return listCodes(templateId);
}

/**
 * Vydání kódu k odeslání. U pevného kódu se nic neodepisuje, u zásoby se
 * odebere nejstarší nepoužitý — obojí v jedné transakci, aby dvě rychlá
 * kliknutí nevydala stejný kód.
 */
export function takeCode(templateId: string, forWhom = ''): { code: string; remaining: number } {
  const d = getDb();
  const t = d.prepare('SELECT * FROM voucher_templates WHERE id = ?').get(templateId) as any;
  if (!t) throw new Error('Šablona nenalezena.');

  if (t.code_mode !== 'unique') {
    if (!t.fixed_code?.trim()) throw new Error('Šablona nemá vyplněný kód.');
    return { code: t.fixed_code.trim(), remaining: -1 };
  }

  const take = d.transaction(() => {
    const row = d.prepare(
      'SELECT code FROM voucher_codes WHERE template_id = ? AND used_at IS NULL ORDER BY created_at, code LIMIT 1'
    ).get(templateId) as any;
    if (!row) throw new Error('Šabloně došly kódy — doplň je v Poukazech.');
    d.prepare('UPDATE voucher_codes SET used_at = ?, used_for = ? WHERE template_id = ? AND code = ?')
      .run(new Date().toISOString(), forWhom.slice(0, 200), templateId, row.code);
    return row.code as string;
  });

  const code = take();
  const remaining = (d.prepare(
    'SELECT COUNT(*) AS n FROM voucher_codes WHERE template_id = ? AND used_at IS NULL'
  ).get(templateId) as any).n as number;
  touchState();
  return { code, remaining };
}

/** Vrácení kódu do zásoby — když se e-mail nakonec neodeslal. */
export function releaseCode(templateId: string, code: string): void {
  getDb().prepare(
    "UPDATE voucher_codes SET used_at = NULL, used_for = '' WHERE template_id = ? AND code = ?"
  ).run(templateId, code);
  touchState();
}

/** Zadání poukazu poskládané ze šablony — hodnoty jdou rovnou do sazby PDF. */
export function specFromTemplate(templateId: string, code: string): VoucherSpec {
  const t = getDb().prepare('SELECT * FROM voucher_templates WHERE id = ?').get(templateId) as any;
  if (!t) throw new Error('Šablona nenalezena.');
  return {
    codes: [code],
    value: t.value,
    unit: t.unit,
    validUntil: t.valid_until,
    lang: t.lang,
    note: t.note
  };
}
