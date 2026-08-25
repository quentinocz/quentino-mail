/**
 * Šablony dárkových poukazů.
 *
 * Šablona drží hodnotu, platnost a jazyk — a k tomu buď jeden pevný kód
 * (hromadná akce, všichni dostanou stejný), nebo zásobu unikátních kódů,
 * ze které se při každém vložení odebere jeden.
 *
 * ── Proč se stejný kód nemůže rozeslat dvakrát ──────────────────────────
 *
 * Zásoba kódů je jedna, ale zařízení víc a každé má vlastní databázi; mezi
 * sebou se domlouvají jen přes sdílenou složku, tedy se zpožděním. Kdyby
 * každé prostě sáhlo po „prvním volném" kódu, dva počítače by ve stejnou
 * chvíli vzaly tentýž. Proto to funguje na tři doby:
 *
 *  1. **Rezervace předem.** Každé zařízení si při synchronizaci zamluví
 *     zásobu kódů dopředu ({@link CLAIM_AHEAD}) a zapíše si k nim své jméno.
 *     Vydává pak jen ze svých — do cizí rezervy nesáhne.
 *  2. **Usazení.** Vydává se jen z rezervací starších než
 *     {@link CLAIM_SETTLE_MS}, tedy z těch, které už ostatní zařízení viděla
 *     a případný spor o ně je dávno rozhodnutý (vyhrává dřívější rezervace).
 *  3. **Vlastní pořadí.** Kdyby rezerva došla a bylo potřeba vydat hned,
 *     nesáhne zařízení po prvním volném kódu, ale po prvním ve svém vlastním
 *     pořadí — každé zařízení prochází zásobu jinak, takže i tahle nouzová
 *     cesta obě zařízení rozvede k jinému kódu.
 *
 * A kdyby přes to všechno jeden kód vydala dvě zařízení, pozná se to: u kódu
 * je zapsané, kdo ho vydal, a synchronizace při rozdílu zapíše to druhé
 * vydání do `used_dup`. Aplikace pak na kolizi upozorní, místo aby se
 * potichu stalo, že dva zákazníci dostali stejný poukaz.
 *
 * Použití se navíc při slučování nikdy neztrácí — vyhrává vždycky ono, a
 * platí ten dřívější čas.
 */
import crypto from 'crypto';
import { getDb } from './db';
import { touchState } from './settings';
import { deviceId } from './device';
import type { MailLang, VoucherClash, VoucherCode, VoucherSpec, VoucherTemplate } from '../shared/types';

/** Kolik kódů si zařízení drží zamluvených dopředu. */
const CLAIM_AHEAD = 20;

/**
 * Jak dlouho musí rezervace ležet, než se z ní smí vydávat. Dvě minuty jsou
 * s rezervou nad běžným kolem synchronizace — do té doby se stihne případný
 * spor o tentýž kód rozhodnout.
 */
const CLAIM_SETTLE_MS = 2 * 60_000;

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
    codesMine: r.codes_mine ?? 0,
    codesDup: r.codes_dup ?? 0,
    updatedAt: r.updated_at
  };
}

export function listTemplates(): VoucherTemplate[] {
  const rows = getDb().prepare(
    `SELECT t.*,
            (SELECT COUNT(*) FROM voucher_codes c WHERE c.template_id = t.id) AS codes_total,
            (SELECT COUNT(*) FROM voucher_codes c WHERE c.template_id = t.id AND c.used_at IS NULL) AS codes_free,
            (SELECT COUNT(*) FROM voucher_codes c WHERE c.template_id = t.id AND c.used_at IS NULL AND c.claimed_by = ?) AS codes_mine,
            (SELECT COUNT(*) FROM voucher_codes c WHERE c.template_id = t.id AND c.used_dup != '') AS codes_dup
     FROM voucher_templates t
     WHERE t.archived = 0
     ORDER BY t.name COLLATE NOCASE`
  ).all(deviceId()) as any[];
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
  // Z čerstvé zásoby si tohle zařízení rovnou ukrojí svůj díl, ať má z čeho
  // vydávat, než doběhne první synchronizace
  claimCodes(templateId);
  touchState();
  return { added, skipped: codes.length - added };
}

export function listCodes(templateId: string): VoucherCode[] {
  const me = deviceId();
  const rows = getDb().prepare(
    `SELECT code, used_at, used_for, used_by, claimed_by, used_dup
     FROM voucher_codes WHERE template_id = ? ORDER BY used_at IS NOT NULL, code`
  ).all(templateId) as any[];
  return rows.map(r => ({
    code: r.code,
    usedAt: r.used_at,
    usedFor: r.used_for,
    usedBy: r.used_by ?? '',
    claimedElsewhere: !r.used_at && !!r.claimed_by && r.claimed_by !== me,
    duplicate: r.used_dup ?? ''
  }));
}

export function deleteCode(templateId: string, code: string): VoucherCode[] {
  getDb().prepare('DELETE FROM voucher_codes WHERE template_id = ? AND code = ?').run(templateId, code);
  touchState();
  return listCodes(templateId);
}

/* ---------- rezervace kódů ---------- */

/**
 * Pořadí, ve kterém tohle zařízení prochází zásobu. Je z jména zařízení a
 * kódu, takže je pro každé zařízení jiné, ale pořád stejné — dvě zařízení
 * tak sáhnou po jiném kódu, i kdyby to obě dělala v tutéž vteřinu.
 */
function order(me: string, code: string): string {
  return crypto.createHash('md5').update(`${me}|${code}`).digest('hex');
}

const byMyOrder = (me: string) => (a: string, b: string) =>
  order(me, a) < order(me, b) ? -1 : 1;

/**
 * Doplní rezervu zamluvených kódů. Zamlouvá se jen to, co si nedrží nikdo
 * jiný — o kód, který má zamluvený druhé zařízení, se nikdo nepere.
 *
 * @returns kolik kódů přibylo
 */
export function claimCodes(templateId: string, want = CLAIM_AHEAD): number {
  const d = getDb();
  const me = deviceId();
  const mine = (d.prepare(
    'SELECT COUNT(*) AS n FROM voucher_codes WHERE template_id = ? AND used_at IS NULL AND claimed_by = ?'
  ).get(templateId, me) as any).n as number;
  const missing = want - mine;
  if (missing <= 0) return 0;

  const free = (d.prepare(
    "SELECT code FROM voucher_codes WHERE template_id = ? AND used_at IS NULL AND claimed_by = '' LIMIT 1000"
  ).all(templateId) as any[]).map(r => r.code as string);
  if (!free.length) return 0;

  const picked = free.sort(byMyOrder(me)).slice(0, missing);
  const now = new Date().toISOString();
  const upd = d.prepare(
    "UPDATE voucher_codes SET claimed_by = ?, claimed_at = ? WHERE template_id = ? AND code = ? AND used_at IS NULL AND claimed_by = ''"
  );
  const tx = d.transaction(() => {
    let n = 0;
    for (const code of picked) n += upd.run(me, now, templateId, code).changes;
    return n;
  });
  const added = tx();
  if (added) touchState();
  return added;
}

/** Doplní rezervu u všech šablon se zásobou — volá se před synchronizací. */
export function claimAll(): number {
  const ids = (getDb().prepare(
    "SELECT id FROM voucher_templates WHERE archived = 0 AND code_mode = 'unique'"
  ).all() as any[]).map(r => r.id as string);
  let n = 0;
  for (const id of ids) n += claimCodes(id);
  return n;
}

/* ---------- vydání kódu ---------- */

/**
 * Vydání kódu k odeslání. U pevného kódu se nic neodepisuje, u zásoby se
 * odebere jeden ze zamluvených — přednost má rezervace, která už se usadila,
 * teprve když žádná není, sáhne se do zásoby napřímo (viz úvod souboru).
 */
export function takeCode(templateId: string, forWhom = ''): { code: string; remaining: number } {
  const d = getDb();
  const me = deviceId();
  const t = d.prepare('SELECT * FROM voucher_templates WHERE id = ?').get(templateId) as any;
  if (!t) throw new Error('Šablona nenalezena.');

  if (t.code_mode !== 'unique') {
    if (!t.fixed_code?.trim()) throw new Error('Šablona nemá vyplněný kód.');
    return { code: t.fixed_code.trim(), remaining: -1 };
  }

  const settledBefore = new Date(Date.now() - CLAIM_SETTLE_MS).toISOString();
  const take = d.transaction(() => {
    // 1) usazená vlastní rezervace — bezpečná cesta
    let code = (d.prepare(
      `SELECT code FROM voucher_codes
       WHERE template_id = ? AND used_at IS NULL AND claimed_by = ? AND claimed_at <= ?
       ORDER BY claimed_at, code LIMIT 1`
    ).get(templateId, me, settledBefore) as any)?.code as string | undefined;

    // 2) rezerva došla: vlastní čerstvá rezervace, jinak volný kód — v obou
    //    případech v pořadí tohohle zařízení, aby druhé sáhlo jinam
    if (!code) {
      const free = (d.prepare(
        `SELECT code FROM voucher_codes
         WHERE template_id = ? AND used_at IS NULL AND (claimed_by = '' OR claimed_by = ?) LIMIT 1000`
      ).all(templateId, me) as any[]).map(r => r.code as string);
      if (!free.length) {
        // Zbývat můžou ještě kódy zamluvené jiným zařízením. Vzít je by bylo
        // přesně to, čemu se tenhle celý mechanismus vyhýbá.
        const held = (d.prepare(
          "SELECT COUNT(*) AS n FROM voucher_codes WHERE template_id = ? AND used_at IS NULL AND claimed_by != ''"
        ).get(templateId) as any).n as number;
        throw new Error(held
          ? 'Volné kódy si drží jiné zařízení. Doplň zásobu v Poukazech.'
          : 'Šabloně došly kódy — doplň je v Poukazech.');
      }
      code = free.sort(byMyOrder(me))[0];
    }

    const now = new Date().toISOString();
    d.prepare(
      `UPDATE voucher_codes
       SET used_at = ?, used_for = ?, used_by = ?,
           claimed_by = ?, claimed_at = CASE WHEN claimed_at = '' THEN ? ELSE claimed_at END
       WHERE template_id = ? AND code = ?`
    ).run(now, forWhom.slice(0, 200), me, me, now, templateId, code);
    return code;
  });

  const code = take();
  // Rezerva se doplní hned, ne až při synchronizaci — ať je příště z čeho brát
  claimCodes(templateId);
  const remaining = (d.prepare(
    'SELECT COUNT(*) AS n FROM voucher_codes WHERE template_id = ? AND used_at IS NULL'
  ).get(templateId) as any).n as number;
  touchState();
  return { code, remaining };
}

/** Vrácení kódu do zásoby — když se e-mail nakonec neodeslal. */
export function releaseCode(templateId: string, code: string): void {
  // Rezervace zůstává tomuhle zařízení: kód se vrací do vlastní zásoby, ne
  // do společné, takže ho mezitím nikdo jiný nestihne vzít.
  getDb().prepare(
    `UPDATE voucher_codes SET used_at = NULL, used_for = '', used_by = '',
            claimed_by = ?, claimed_at = ?
     WHERE template_id = ? AND code = ?`
  ).run(deviceId(), new Date().toISOString(), templateId, code);
  touchState();
}

/* ---------- kolize ---------- */

/**
 * Kódy, u kterých se ukázalo, že je vydala dvě zařízení. Za normálních
 * okolností prázdné; když ne, je potřeba dát vědět člověku — poukaz už je
 * u dvou zákazníků a to za nás aplikace nevyřeší.
 */
export function listClashes(): VoucherClash[] {
  const rows = getDb().prepare(
    `SELECT c.template_id, c.code, c.used_at, c.used_for, c.used_dup, t.name
     FROM voucher_codes c
     JOIN voucher_templates t ON t.id = c.template_id
     WHERE c.used_dup != ''
     ORDER BY c.used_at DESC`
  ).all() as any[];
  return rows.map(r => ({
    templateId: r.template_id,
    templateName: r.name,
    code: r.code,
    used: r.used_at ?? '',
    usedFor: r.used_for ?? '',
    duplicate: r.used_dup
  }));
}

/** „Vyřešeno" — člověk se s tím vypořádal, hláška může zmizet. */
export function clearClash(templateId: string, code: string): VoucherClash[] {
  getDb().prepare("UPDATE voucher_codes SET used_dup = '' WHERE template_id = ? AND code = ?")
    .run(templateId, code);
  return listClashes();
}

/**
 * Zápis kolize při slučování. Volá se ze synchronizace, když druhé zařízení
 * hlásí u téhož kódu vydání pod jiným jménem.
 */
export function markClash(templateId: string, code: string, other: string): void {
  getDb().prepare("UPDATE voucher_codes SET used_dup = ? WHERE template_id = ? AND code = ? AND used_dup = ''")
    .run(other.slice(0, 120), templateId, code);
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
