/**
 * Návrhy změn, jejich schválení, zápis do účtu, deník a vrácení.
 *
 * ## Jak putují mezi Macy
 *
 * Návrhy vznikají na Macu, který udělal noční běh, a jdou do sdílené
 * složky (`reklamy/navrhy.json`). Schválit se dají na kterémkoli Macu:
 * když je ten Mac přihlášený ke Googlu, změna se provede hned; když ne,
 * návrh dostane stav „schváleno" a provede ho přihlášený Mac při další
 * kontrole (do deseti minut).
 *
 * Deník změn má každý Mac vlastní soubor (`reklamy/zmeny-<mac>.json`),
 * do kterého jen přidává. Vrácení je nová změna s odkazem na tu původní,
 * takže si Macy nikdy nepřepíšou historii navzájem.
 *
 * ## Proč absolutní hodnoty a kontrola před zápisem
 *
 * Operace říká „rozpočet z 900 na 1 080", ne „+20 %". Před zápisem se
 * hodnota v účtu přečte znovu: když mezitím někdo rozpočet změnil ručně,
 * návrh se neprovede a označí se jako zastaralý. A kdyby tentýž návrh
 * provedly dva Macy, výsledek je stejný jako jednou.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getDb, getSetting } from '../db';
import { deviceId, deviceLabel } from '../device';
import type {
  AdsConfig, AdsOp, AdsProposal, AdsProposalStatus, AdsChange, AdsProposals, AdsSystem, AdsAccount
} from '../../shared/ads';
import type { ProposalDraft } from './engine';
import * as google from './google';
import * as sklik from './sklik';
import * as meta from './meta';
import { shiftDay, localDay } from './economics';
import { accountInfo } from './store';

/* ---------- řádky ---------- */

function parse<T>(json: string, fallback: T): T {
  try { return JSON.parse(json) as T; } catch { return fallback; }
}

function toProposal(row: any): AdsProposal {
  return {
    id: row.id, fingerprint: row.fingerprint, kind: row.kind, system: row.system, market: row.market ?? '',
    targetId: row.target_id, targetName: row.target_name, title: row.title, plain: row.plain ?? '', why: row.why,
    impact: Number(row.impact) || 0, confidence: Number(row.confidence) || 1,
    ops: parse<AdsOp[]>(row.ops_json, []), status: row.status, snoozeUntil: row.snooze_until,
    error: row.error, createdAt: row.created_at, updatedAt: row.updated_at, decidedBy: row.decided_by
  };
}

function toChange(row: any): AdsChange {
  return {
    id: row.id, proposalId: row.proposal_id, revertOf: row.revert_of, kind: row.kind, system: row.system,
    targetId: row.target_id, targetName: row.target_name, title: row.title,
    ops: parse<AdsOp[]>(row.ops_json, []), undo: parse<AdsOp[]>(row.undo_json, []),
    at: row.at, device: row.device
  };
}

function writeProposal(p: AdsProposal): void {
  getDb().prepare(`
    INSERT INTO ads_proposals (id, fingerprint, kind, system, target_id, target_name, title, why, impact,
      confidence, ops_json, status, snooze_until, error, created_at, updated_at, decided_by, market, plain)
    VALUES (@id, @fingerprint, @kind, @system, @targetId, @targetName, @title, @why, @impact,
      @confidence, @ops, @status, @snoozeUntil, @error, @createdAt, @updatedAt, @decidedBy, @market, @plain)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title, why = excluded.why, plain = excluded.plain, impact = excluded.impact, confidence = excluded.confidence,
      ops_json = excluded.ops_json, status = excluded.status, snooze_until = excluded.snooze_until,
      error = excluded.error, updated_at = excluded.updated_at, decided_by = excluded.decided_by,
      target_name = excluded.target_name
    WHERE excluded.updated_at >= ads_proposals.updated_at
  `).run({ ...p, market: p.market ?? '', plain: p.plain ?? '', ops: JSON.stringify(p.ops) });
}

function writeChange(c: AdsChange): void {
  getDb().prepare(`
    INSERT OR IGNORE INTO ads_changes (id, proposal_id, revert_of, kind, system, target_id, target_name, title,
      ops_json, undo_json, at, device)
    VALUES (@id, @proposalId, @revertOf, @kind, @system, @targetId, @targetName, @title, @ops, @undo, @at, @device)
  `).run({ ...c, ops: JSON.stringify(c.ops), undo: JSON.stringify(c.undo) });
}

export function getProposal(id: string): AdsProposal | null {
  const row = getDb().prepare('SELECT * FROM ads_proposals WHERE id = ?').get(id);
  return row ? toProposal(row) : null;
}

export function allChanges(): AdsChange[] {
  const rows = (getDb().prepare('SELECT * FROM ads_changes ORDER BY at DESC').all() as any[]).map(toChange);
  const reverted = new Map(rows.filter(c => c.revertOf).map(c => [c.revertOf, c.at]));
  return rows.map(c => (reverted.has(c.id) ? { ...c, revertedAt: reverted.get(c.id) } : c));
}

/* ---------- co engine nemá navrhovat ---------- */

/**
 * Otisky návrhů, které se teď nenabízejí: zamítnuté v posledních dvou
 * týdnech, odložené, „tohle už nenavrhovat" a schválené čekající na
 * provedení.
 */
export function blockedFingerprints(today = localDay()): Set<string> {
  const rows = getDb().prepare(
    "SELECT fingerprint, status, snooze_until, updated_at FROM ads_proposals WHERE status IN ('dismissed','snoozed','never','approved')"
  ).all() as any[];
  const out = new Set<string>();
  const twoWeeks = shiftDay(today, -14);
  for (const r of rows) {
    if (r.status === 'never' || r.status === 'approved') out.add(r.fingerprint);
    else if (r.status === 'snoozed' && r.snooze_until > today) out.add(r.fingerprint);
    else if (r.status === 'dismissed' && String(r.updated_at).slice(0, 10) >= twoWeeks) out.add(r.fingerprint);
  }
  // „Nenavrhovat" platí pro kampaň a druh návrhu, ne jen pro přesná čísla
  for (const r of rows) {
    if (r.status === 'never') out.add(String(r.fingerprint).split('|').slice(0, 3).join('|'));
  }
  return out;
}

/** Kampaně, kterým se v posledních dnech měnilo — týden v klidu */
export function coolingCampaigns(days: number, today = localDay()): Set<string> {
  const since = shiftDay(today, -days);
  const rows = getDb().prepare(
    "SELECT target_id FROM ads_changes WHERE substr(at, 1, 10) >= ? AND kind NOT IN ('negatives','exclude')"
  ).all(since) as any[];
  return new Set(rows.map(r => String(r.target_id)));
}

/** Produkty vyřazené přes doplňkový feed, s datem, kdy se vrátí */
export function excludedCodes(today = localDay()): { code: string; until: string }[] {
  const out = new Map<string, string>();
  for (const change of allChanges()) {
    if (change.revertedAt || change.revertOf) continue;
    for (const op of change.ops) {
      if (op.kind !== 'exclude') continue;
      const until = shiftDay(change.at.slice(0, 10), op.days);
      if (until <= today) continue;
      for (const code of op.codes) if ((out.get(code) ?? '') < until) out.set(code, until);
    }
  }
  return [...out.entries()].map(([code, until]) => ({ code, until })).sort((a, b) => a.code.localeCompare(b.code));
}

/* ---------- uložení výsledku enginu ---------- */

const idOf = (text: string) => crypto.createHash('sha1').update(text).digest('hex').slice(0, 16);

/**
 * Zapíše návrhy z běhu enginu.
 *
 * Otevřený návrh se stejným otiskem se jen aktualizuje (čísla se mohla
 * pohnout). Otevřený návrh, který engine tentokrát nevyrobil, zastará —
 * podmínky se změnily a nabízet ho dál by znamenalo radit podle starých dat.
 */
export function saveGenerated(drafts: ProposalDraft[], system: AdsSystem = 'google'): number {
  const d = getDb();
  const at = new Date().toISOString();
  const seen = new Set<string>();
  let fresh = 0;
  d.transaction(() => {
    for (const draft of drafts) {
      seen.add(draft.fingerprint);
      const last = d.prepare(
        'SELECT * FROM ads_proposals WHERE fingerprint = ? ORDER BY created_at DESC LIMIT 1'
      ).get(draft.fingerprint) as any;
      const reuse = last && ['open', 'failed', 'stale', 'snoozed'].includes(last.status);
      if (last && ['approved', 'never'].includes(last.status)) continue;
      const proposal: AdsProposal = {
        id: reuse ? last.id : idOf(`${draft.fingerprint}|${at}`),
        fingerprint: draft.fingerprint, kind: draft.kind, system, market: draft.market ?? '',
        targetId: draft.targetId, targetName: draft.targetName, title: draft.title, plain: draft.plain, why: draft.why,
        impact: Math.round(draft.impact), confidence: draft.confidence, ops: draft.ops,
        status: 'open', snoozeUntil: '', error: '',
        createdAt: reuse ? last.created_at : at, updatedAt: at, decidedBy: ''
      };
      writeProposal(proposal);
      if (!reuse) fresh++;
    }
    const open = d.prepare("SELECT * FROM ads_proposals WHERE status = 'open' AND system = ?").all(system) as any[];
    for (const row of open) {
      // Návrhy z poradce engine nevyrábí — zastarat by tedy neměly jen proto, že je nový běh nezopakoval
      if (seen.has(row.fingerprint) || /\|(chat|plan)\|/.test(String(row.fingerprint)) || row.kind === 'campaign-new') continue;
      writeProposal({ ...toProposal(row), status: 'stale', error: 'Podmínky se změnily — návrh už neplatí.', updatedAt: at });
    }
  })();
  return fresh;
}

/**
 * Zapíše návrhy z poradce. Na rozdíl od enginu nic jiného nezastará.
 * Krok s datem se uloží jako odložený do toho dne — v Návrzích se objeví
 * sám, až přijde čas (stejně jako návrh odložený na týden).
 */
export function saveChat(drafts: (ProposalDraft & { system: AdsSystem; notBefore: string })[]): AdsProposal[] {
  const at = new Date().toISOString();
  const out: AdsProposal[] = [];
  getDb().transaction(() => {
    for (const draft of drafts) {
      const proposal: AdsProposal = {
        id: idOf(`${draft.fingerprint}|${at}`),
        fingerprint: draft.fingerprint, kind: draft.kind, system: draft.system, market: draft.market ?? '',
        targetId: draft.targetId, targetName: draft.targetName, title: draft.title, plain: draft.plain, why: draft.why,
        impact: Math.round(draft.impact), confidence: draft.confidence, ops: draft.ops,
        status: draft.notBefore ? 'snoozed' : 'open', snoozeUntil: draft.notBefore, error: '',
        createdAt: at, updatedAt: at, decidedBy: ''
      };
      writeProposal(proposal);
      out.push(proposal);
    }
  })();
  if (out.length) shareSoon();
  return out;
}

/**
 * Zruší dosavadní kroky sezónního plánu události (čekající i naplánované),
 * aby nový plán nezdvojil kroky starého. Provedené změny zůstávají.
 */
export function dropPlan(eventId: string): number {
  const rows = getDb().prepare(
    "SELECT * FROM ads_proposals WHERE status IN ('open','snoozed','failed','stale') AND fingerprint LIKE ?"
  ).all(`%|plan|${eventId}|%`) as any[];
  const at = new Date().toISOString();
  for (const row of rows) {
    writeProposal({ ...toProposal(row), status: 'dismissed', error: 'Nahrazeno novým plánem.', updatedAt: at, decidedBy: deviceLabel() });
  }
  if (rows.length) shareSoon();
  return rows.length;
}

/** Kolik kroků plánu události ještě čeká (naplánované, otevřené, schválené) */
export function planCount(eventId: string): number {
  return Number((getDb().prepare(
    "SELECT COUNT(*) AS n FROM ads_proposals WHERE status IN ('open','snoozed','approved') AND fingerprint LIKE ?"
  ).get(`%|plan|${eventId}|%`) as any)?.n ?? 0);
}

/**
 * Dá se s návrhem teď něco dělat? Otevřený, nepovedený, nebo odložený,
 * jehož den už přišel — v okně je mezi otevřenými (krok sezónního plánu,
 * „Odložit" po týdnu) a Použít na něm musí fungovat.
 */
function actionable(p: AdsProposal, today = localDay()): boolean {
  return p.status === 'open' || p.status === 'failed' || (p.status === 'snoozed' && p.snoozeUntil <= today);
}

/* ---------- rozhodnutí ---------- */

export type Decision = 'approve' | 'dismiss' | 'snooze' | 'never' | 'reopen';

export function decide(id: string, decision: Decision): AdsProposal {
  const p = getProposal(id);
  if (!p) throw new Error('Návrh nenalezen.');
  const at = new Date().toISOString();
  const status: Record<Decision, AdsProposalStatus> = {
    approve: 'approved', dismiss: 'dismissed', snooze: 'snoozed', never: 'never', reopen: 'open'
  };
  if (decision === 'approve' && !actionable(p)) {
    throw new Error('Tenhle návrh už není otevřený.');
  }
  const next: AdsProposal = {
    ...p, status: status[decision], updatedAt: at, decidedBy: deviceLabel(),
    snoozeUntil: decision === 'snooze' ? shiftDay(localDay(), 7) : '',
    error: decision === 'reopen' ? '' : p.error
  };
  writeProposal(next);
  shareSoon();
  return next;
}

/* ---------- zápis do účtu ---------- */

export class StaleError extends Error {}

/**
 * Do kterého účtu operace patří.
 *
 * Návrh ho nese s sebou; starší návrhy z doby jednoho účtu ho nemají
 * a dohledá se podle kampaně. Kampaň patří vždy jen jednomu účtu.
 */
function accountOfOp(cfg: AdsConfig, op: AdsOp): AdsAccount {
  const own = 'account' in op ? op.account : '';
  if (own) return accountInfo(cfg, own);
  const campaignId = 'campaignId' in op ? op.campaignId : '';
  const row = campaignId
    ? getDb().prepare("SELECT account FROM ads_campaigns WHERE system = 'google' AND id = ?").get(campaignId) as any
    : null;
  return accountInfo(cfg, row?.account ?? '');
}

/** Přepočet korun na měnu účtu */
function rateOf(cfg: AdsConfig, account: AdsAccount): number {
  return /eur/i.test(account.currency) ? cfg.eurRate : 1;
}

/**
 * Provede operace v účtu a vrátí, čím se dají vrátit.
 *
 * Před zápisem se přečte skutečný stav. Rozpočet i cíl musí sedět s tím,
 * z čeho návrh vycházel — jinak se nic nezapíše (StaleError).
 */
export async function execute(cfg: AdsConfig, ops: AdsOp[]): Promise<{ undo: AdsOp[]; note: string }> {
  // Sklik: jen denní rozpočty a ty se zapisují po jednom (Sklik nemá zápis „naoko")
  const isSklik = (op: AdsOp) => 'account' in op && op.account === 'sklik';
  const sklikOps = ops.filter(isSklik);
  for (const op of sklikOps) {
    if (op.kind !== 'budget') throw new Error('Ve Skliku umí aplikace měnit jen denní rozpočet kampaně.');
    const current = await sklik.sklikBudgetNow(op.campaignId, cfg.sklik.userId);
    if (current == null || Math.abs(current - op.from) > Math.max(1, op.from * 0.01)) {
      throw new StaleError(`Rozpočet ve Skliku je teď ${current == null ? 'neznámý' : `${Math.round(current)} Kč`}, `
        + `návrh počítal s ${Math.round(op.from)} Kč — někdo ho mezitím změnil.`);
    }
  }
  ops = ops.filter(op => !isSklik(op));

  // Meta: taky jen denní rozpočty, v měně účtu (op je v korunách)
  const isMeta = (op: AdsOp) => 'account' in op && op.account === 'meta';
  const metaOps = ops.filter(isMeta);
  const metaRate = rateOf(cfg, accountInfo(cfg, 'meta'));
  for (const op of metaOps) {
    if (op.kind !== 'budget') throw new Error('V Metě umí aplikace měnit jen denní rozpočet kampaně.');
    const now = await meta.metaBudgetNow(op.campaignId);
    const current = now != null ? now * metaRate : null;
    if (current == null || Math.abs(current - op.from) > Math.max(1, op.from * 0.01)) {
      throw new StaleError(`Rozpočet v Metě je teď ${current == null ? 'nastavený po sadách reklam' : `${Math.round(current)} Kč`}, `
        + `návrh počítal s ${Math.round(op.from)} Kč — někdo ho mezitím změnil.`);
    }
  }
  ops = ops.filter(op => !isMeta(op));

  // Nová kampaň / její odstranění: vlastní požadavek, ne úprava existující
  const creates = ops.filter((op): op is Extract<AdsOp, { kind: 'campaign-create' }> => op.kind === 'campaign-create');
  const removes = ops.filter((op): op is Extract<AdsOp, { kind: 'campaign-remove' }> => op.kind === 'campaign-remove');
  for (const op of creates) {
    const existing = await google.campaignNamed(cfg, op.account, op.name);
    if (existing) throw new StaleError(`Kampaň „${op.name}" už v účtu je (ID ${existing}) — druhou stejnou nezakládám.`);
    await google.createShoppingCampaign(cfg, op.account, op, true, rateOf(cfg, accountInfo(cfg, op.account)));
  }
  for (const op of removes) {
    // Vrácení smí smazat jen kampaň, která pořád stojí — běžící kampaň by smazání připravilo o data i prodeje
    const rows = await google.gaql(cfg, `SELECT campaign.id, campaign.status FROM campaign WHERE campaign.id = ${op.campaignId.replace(/\D/g, '')}`, op.account);
    const state = String(rows[0]?.campaign?.status ?? '');
    if (state && state !== 'PAUSED' && state !== 'REMOVED') {
      throw new StaleError(`Kampaň „${op.name}" už běží — vracet ji smazáním nebudu. Pozastav nebo odstraň ji v Google Ads.`);
    }
  }
  ops = ops.filter(op => op.kind !== 'campaign-create' && op.kind !== 'campaign-remove');
  for (const op of ops) {
    if (op.kind !== 'budget' && op.kind !== 'troas') continue;
    const account = accountOfOp(cfg, op);
    const now = await google.readCampaignNow(cfg, op.campaignId, account.id);
    if (op.kind === 'budget') {
      const current = now.budget != null ? now.budget * rateOf(cfg, account) : null;
      if (current == null || Math.abs(current - op.from) > Math.max(1, op.from * 0.01)) {
        throw new StaleError(`Rozpočet je teď ${current == null ? 'neznámý' : `${Math.round(current)} Kč`}, `
          + `návrh počítal s ${Math.round(op.from)} Kč — někdo ho mezitím změnil.`);
      }
    } else {
      const same = op.from == null ? now.targetRoas == null : now.targetRoas != null && Math.abs(now.targetRoas - op.from) < 0.02;
      if (!same) {
        throw new StaleError(`Cílové ROAS je teď ${now.targetRoas == null ? 'nenastavené' : `${Math.round(now.targetRoas * 100)} %`}, `
          + `návrh počítal s ${op.from == null ? 'žádným' : `${Math.round(op.from * 100)} %`} — někdo ho mezitím změnil.`);
      }
    }
  }

  // Seskupit podle účtu a služby, nejdřív naoko, pak doopravdy
  const groups = new Map<string, { account: string; service: string; items: { op: AdsOp; mutation: any }[] }>();
  for (const op of ops) {
    const account = accountOfOp(cfg, op);
    const m = google.buildMutation(account.id, op, rateOf(cfg, account));
    if (!m) continue;
    const key = `${account.id}|${m.service}`;
    const group = groups.get(key) ?? { account: account.id, service: m.service, items: [] };
    group.items.push({ op: { ...op, account: account.id } as AdsOp, mutation: m.operation });
    groups.set(key, group);
  }
  for (const g of groups.values()) {
    await google.mutate(cfg, g.service as any, g.items.map(x => x.mutation), true, g.account);
  }
  const undo: AdsOp[] = [];
  const notes: string[] = [];
  for (const op of sklikOps) {
    if (op.kind !== 'budget') continue;
    await sklik.sklikSetBudget(op.campaignId, op.to, cfg.sklik.userId);
    undo.push({ ...op, from: op.to, to: op.from });
  }
  for (const op of metaOps) {
    if (op.kind !== 'budget') continue;
    await meta.metaSetBudget(op.campaignId, op.to / metaRate);
    undo.push({ ...op, from: op.to, to: op.from });
  }
  for (const op of creates) {
    const made = await google.createShoppingCampaign(cfg, op.account, op, false, rateOf(cfg, accountInfo(cfg, op.account)));
    undo.push({ kind: 'campaign-remove', account: op.account, campaignId: made.campaignId, budgetId: made.budgetId, name: op.name });
    notes.push(`Kampaň „${op.name}" je v účtu jako pozastavená — zkontroluj ji v Google Ads a zapni.`);
  }
  for (const op of removes) {
    await google.removeCampaign(cfg, op.account, op.campaignId, op.budgetId);
  }
  for (const g of groups.values()) {
    const result = await google.mutate(cfg, g.service as any, g.items.map(x => x.mutation), false, g.account);
    if (result.partial) notes.push(result.partial);
    g.items.forEach((x, i) => {
      const op = x.op;
      if (op.kind === 'budget') undo.push({ ...op, from: op.to, to: op.from });
      else if (op.kind === 'troas') undo.push({ ...op, from: op.to, to: op.from ?? 0 });
      else if (op.kind === 'negative' && result.resources[i]) {
        undo.push({ kind: 'negative-remove', campaignId: op.campaignId, resource: result.resources[i], text: op.text, account: g.account });
      }
    });
  }
  for (const op of ops) {
    if (op.kind === 'exclude') undo.push({ kind: 'exclude-remove', codes: op.codes });
  }
  return { undo, note: notes.join(' ') };
}

/**
 * Umí tenhle Mac zapsat tyhle operace? Google potřebuje přihlášení
 * a zapnutý účet, Sklik token. Feed (vyřazení) zvládne každý Mac.
 */
function canWrite(cfg: AdsConfig, ops?: AdsOp[]): boolean {
  const googleOk = google.googleSecrets().connected && cfg.google.accounts.some(one => one.enabled);
  const sklikOk = cfg.sklik.enabled && !!sklik.sklikToken();
  const metaOk = cfg.meta.enabled && !!cfg.meta.accountId && !!meta.metaToken();
  if (!ops) return googleOk || sklikOk || metaOk;
  const api = ops.filter(op => op.kind !== 'exclude' && op.kind !== 'exclude-remove');
  const acc = (op: AdsOp) => ('account' in op ? op.account ?? '' : '');
  const needSklik = api.some(op => acc(op) === 'sklik');
  const needMeta = api.some(op => acc(op) === 'meta');
  const needGoogle = api.some(op => acc(op) !== 'sklik' && acc(op) !== 'meta');
  return (!needSklik || sklikOk) && (!needMeta || metaOk) && (!needGoogle || googleOk);
}

/**
 * Použít návrh. Na přihlášeném Macu se provede hned, jinak se jen schválí
 * a provede ho přihlášený Mac při další kontrole.
 */
export async function applyProposal(
  cfg: AdsConfig, id: string, afterFeed: () => Promise<unknown>, by = ''
): Promise<AdsProposal> {
  const p = getProposal(id);
  if (!p) throw new Error('Návrh nenalezen.');
  if (p.status !== 'approved' && !actionable(p)) throw new Error('Tenhle návrh už není otevřený.');
  if (!canWrite(cfg, p.ops)) {
    return decide(id, 'approve');
  }
  const who = by || deviceLabel();
  const at = new Date().toISOString();
  try {
    const { undo, note } = await execute(cfg, p.ops);
    writeChange({
      id: idOf(`${p.id}|${at}|${deviceId()}`), proposalId: p.id, revertOf: '', kind: p.kind, system: p.system,
      targetId: p.targetId, targetName: p.targetName, title: p.title, ops: p.ops, undo, at, device: who
    });
    const done: AdsProposal = { ...p, status: 'applied', updatedAt: at, decidedBy: who, error: note };
    writeProposal(done);
    if (p.ops.some(op => op.kind === 'exclude')) await afterFeed().catch(() => {});
    shareSoon();
    return done;
  } catch (err: any) {
    const failed: AdsProposal = {
      ...p, status: err instanceof StaleError ? 'stale' : 'failed', updatedAt: at,
      error: String(err?.message ?? err)
    };
    writeProposal(failed);
    shareSoon();
    throw err;
  }
}

/** Provede návrhy schválené na jiných Macích (běží na přihlášeném Macu). */
export async function applyApproved(cfg: AdsConfig, afterFeed: () => Promise<unknown>): Promise<number> {
  if (!canWrite(cfg)) return 0;
  const rows = getDb().prepare("SELECT id FROM ads_proposals WHERE status = 'approved'").all() as any[];
  let done = 0;
  for (const row of rows) {
    try { await applyProposal(cfg, row.id, afterFeed); done++; } catch { /* stav je u návrhu */ }
  }
  return done;
}

/** Vrátí změnu. Kontrola stavu účtu je stejná jako u zápisu. */
export async function revertChange(
  cfg: AdsConfig, id: string, afterFeed: () => Promise<unknown>
): Promise<AdsChange> {
  const change = allChanges().find(c => c.id === id);
  if (!change) throw new Error('Změna nenalezena.');
  if (change.revertedAt) throw new Error('Tahle změna už je vrácená.');
  if (change.revertOf) throw new Error('Vrácení se nevrací — udělej nový návrh.');
  if (!canWrite(cfg, change.undo)) {
    throw new Error(change.system === 'sklik' ? 'Vrátit jde jen na Macu s uloženým tokenem Skliku.'
      : change.system === 'meta' ? 'Vrátit jde jen na Macu s uloženým tokenem Meta.'
        : 'Vrátit jde jen na Macu přihlášeném ke Google Ads.');
  }
  const { undo } = await execute(cfg, change.undo);
  const at = new Date().toISOString();
  const back: AdsChange = {
    id: idOf(`${change.id}|zpet|${at}`), proposalId: change.proposalId, revertOf: change.id, kind: change.kind,
    system: change.system, targetId: change.targetId, targetName: change.targetName,
    title: `Vráceno: ${change.title}`, ops: change.undo, undo, at, device: deviceLabel()
  };
  writeChange(back);
  if (change.ops.some(op => op.kind === 'exclude')) await afterFeed().catch(() => {});
  shareSoon();
  return { ...back };
}

/* ---------- vyhodnocení ---------- */

/**
 * Vyšel návrh? Zisk kampaně za den 14 dní před změnou proti 14 dnům po ní.
 *
 * Je to hrubé srovnání — sezóna ho umí posunout — ale přesně tohle člověk
 * chce vědět: „od té doby, co jsme přidali rozpočet, vydělává víc, nebo
 * míň?" Do 14 dní po změně je výsledek „čeká se".
 */
/** Jak přepočítat čísla kampaně: marže jejího trhu, měna a DPH jejího účtu */
export type EvalMoney = (campaignId: string) => { margin: number; cost: (n: number) => number; value: (n: number) => number };

export function evaluate(change: AdsChange, money: EvalMoney, today = localDay()): AdsChange['evaluation'] {
  if (!['budget-up', 'budget-down', 'roas-up', 'roas-down', 'roas-set'].includes(change.kind)) return undefined;
  const day = change.at.slice(0, 10);
  const afterEnd = shiftDay(day, 14);
  const profit = (from: string, to: string) => {
    const r = getDb().prepare(
      'SELECT SUM(cost) AS cost, SUM(value) AS value, COUNT(DISTINCT date) AS days FROM ads_campaign_day '
      + 'WHERE campaign_id = ? AND date BETWEEN ? AND ?'
    ).get(change.targetId, from, to) as any;
    const days = Number(r?.days) || 0;
    const m = money(change.targetId);
    return { perDay: days ? (m.value(Number(r.value) || 0) * m.margin - m.cost(Number(r.cost) || 0)) / days : 0, days };
  };
  const before = profit(shiftDay(day, -14), shiftDay(day, -1));
  if (afterEnd >= today) return { before: before.perDay, after: 0, days: 0, verdict: 'pending' };
  const after = profit(shiftDay(day, 1), afterEnd);
  const diff = after.perDay - before.perDay;
  const verdict = Math.abs(diff) < Math.max(50, Math.abs(before.perDay) * 0.05) ? 'same' : diff > 0 ? 'better' : 'worse';
  return { before: before.perDay, after: after.perDay, days: after.days, verdict };
}

/* ---------- přehled pro okno ---------- */

export function proposalsView(money: EvalMoney): AdsProposals {
  const rows = (getDb().prepare('SELECT * FROM ads_proposals ORDER BY impact DESC').all() as any[]).map(toProposal);
  const today = localDay();
  const open = rows.filter(p => p.status === 'open' || (p.status === 'snoozed' && p.snoozeUntil <= today)
    || p.status === 'failed');
  // Kroky plánu z poradce, které čekají na svůj den — zvlášť, ať je nevytlačí historie
  const planned = rows.filter(p => p.status === 'snoozed' && p.snoozeUntil > today && /\|(chat|plan)\|/.test(p.fingerprint))
    .sort((a, b) => a.snoozeUntil.localeCompare(b.snoozeUntil));
  const decided = rows
    .filter(p => !open.includes(p) && !planned.includes(p) && p.status !== 'approved')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 40);
  const changes = allChanges().slice(0, 60).map(c => ({ ...c, evaluation: evaluate(c, money, today) }));
  const evaluated = changes.filter(c => c.evaluation && c.evaluation.verdict !== 'pending' && !c.revertOf);
  const dataDays = (getDb().prepare('SELECT COUNT(DISTINCT date) AS n FROM ads_campaign_day').get() as any)?.n ?? 0;
  return {
    open,
    waiting: rows.filter(p => p.status === 'approved'),
    planned,
    decided,
    changes,
    dataDays: Number(dataDays) || 0,
    track: { evaluated: evaluated.length, better: evaluated.filter(c => c.evaluation!.verdict !== 'worse').length },
    generatedAt: getSetting('adsProposalsAt', '') || '',
    excluded: excludedCodes(today)
  };
}

/* ---------- sdílená složka ---------- */

function sharedDir(): string | null {
  if (getSetting('syncEnabled', '0') !== '1') return null;
  const folder = (getSetting('syncFolder', '') || '').trim();
  if (!folder || !fs.existsSync(folder)) return null;
  const dir = path.join(folder, 'reklamy');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { return null; }
  return dir;
}

function writeJson(file: string, data: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
  fs.renameSync(tmp, file);
}

function readJson(file: string): any {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * Návrhy a deníky: přečíst cizí, sloučit, zapsat svoje. Vrací true, když
 * přišlo něco nového (okno se má překreslit).
 */
export function shareProposals(): boolean {
  const dir = sharedDir();
  if (!dir) return false;
  const d = getDb();
  let changed = false;

  // Návrhy: po jednom, novější razítko vyhrává
  const file = path.join(dir, 'navrhy.json');
  const remote = readJson(file);
  const before = (d.prepare('SELECT COUNT(*) AS n, MAX(updated_at) AS at FROM ads_proposals').get() as any);
  for (const raw of Array.isArray(remote?.proposals) ? remote.proposals : []) {
    if (!raw?.id || !raw?.updatedAt) continue;
    writeProposal({ ...raw, ops: Array.isArray(raw.ops) ? raw.ops : [] } as AdsProposal);
  }
  const after = (d.prepare('SELECT COUNT(*) AS n, MAX(updated_at) AS at FROM ads_proposals').get() as any);
  if (after.n !== before.n || after.at !== before.at) changed = true;
  // Zapisuje se jen staré dva měsíce — starší rozhodnutí nikoho nezajímají
  const since = shiftDay(localDay(), -60);
  const mine = (d.prepare('SELECT * FROM ads_proposals WHERE updated_at >= ?').all(since) as any[]).map(toProposal);
  const remoteAt = (Array.isArray(remote?.proposals) ? remote.proposals : [])
    .reduce((max: string, one: any) => (String(one?.updatedAt ?? '') > max ? String(one.updatedAt) : max), '');
  const mineAt = mine.reduce((max, one) => (one.updatedAt > max ? one.updatedAt : max), '');
  if (mine.length && (mineAt > remoteAt || mine.length !== (remote?.proposals?.length ?? -1))) {
    writeJson(file, { app: 'quentino-reklamy', proposals: mine });
  }

  // Deníky: každý Mac svůj soubor, ostatní se jen čtou
  const own = `zmeny-${deviceId().slice(0, 8)}.json`;
  let files: string[] = [];
  try { files = fs.readdirSync(dir).filter(name => /^zmeny-[\w-]+\.json$/.test(name)); } catch { files = []; }
  const countBefore = (d.prepare('SELECT COUNT(*) AS n FROM ads_changes').get() as any).n;
  for (const name of files) {
    if (name === own) continue;
    const list = readJson(path.join(dir, name));
    for (const raw of Array.isArray(list?.changes) ? list.changes : []) {
      if (raw?.id) writeChange({ ...raw, ops: raw.ops ?? [], undo: raw.undo ?? [] } as AdsChange);
    }
  }
  if ((d.prepare('SELECT COUNT(*) AS n FROM ads_changes').get() as any).n !== countBefore) changed = true;
  const label = deviceLabel();
  const ownChanges = (d.prepare('SELECT * FROM ads_changes WHERE device = ?').all(label) as any[]).map(toChange);
  const ownFile = readJson(path.join(dir, own));
  if (ownChanges.length !== (ownFile?.changes?.length ?? -1)) {
    writeJson(path.join(dir, own), { app: 'quentino-reklamy', device: label, changes: ownChanges });
  }
  return changed;
}

let shareTimer: NodeJS.Timeout | null = null;
function shareSoon(): void {
  if (shareTimer) clearTimeout(shareTimer);
  shareTimer = setTimeout(() => { shareTimer = null; try { shareProposals(); } catch { /* příště */ } }, 1000);
}
