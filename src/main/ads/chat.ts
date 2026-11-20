/**
 * Poradce v Reklamách — chat nad daty modulu.
 *
 * ## Proč takhle
 *
 * Čísla v záložkách odpoví na „kolik", ale ne na „proč klesl zisk" nebo
 * „co udělat na Vánoce". Na to je poradce: dostane shrnutí dat (přehled,
 * kampaně, produkty, otevřené návrhy, poslední změny) a odpoví lidsky.
 *
 * Když má něco změnit, **nikdy to neprovádí sám**. Vrátí kroky ve stejném
 * tvaru, jaký mají návrhy enginu, a z nich se tu postaví obyčejné návrhy —
 * s kartou, Použít / Zamítnout, kontrolou stavu před zápisem a cestou zpět.
 * Model si tak nemůže vymyslet kampaň, přetáhnout pojistky ani vyloučit
 * slovo, které prodává: všechno, co navrhne, projde stejnými pravidly jako
 * engine, a co neprojde, se uživateli řekne (`notes`).
 *
 * Plán do budoucna (sezóna, akce) jsou kroky s datem: návrh se uloží jako
 * odložený do toho dne a v Návrzích se objeví sám, až přijde čas.
 */
import crypto from 'crypto';
import type {
  AdsConfig, AdsOp, AdsProposalKind, AdsSystem, AdsCampaignRow, AdsProductRow, AdsOverview,
  AdsProposal, AdsChange
} from '../../shared/ads';
import type { ProposalDraft } from './engine';
import { stem, plainWord, roasForPno } from './engine';
import { shiftDay } from './economics';

export interface ChatTurn { role: 'user' | 'assistant'; text: string }

/** Krok, jak ho vrací model (volný JSON — ověřuje se tady) */
export interface ChatAction {
  type: string;
  system?: string;
  campaignId?: string | number;
  /** Rozpočet v Kč za den, nebo cílové ROAS jako číslo (6.5 = 650 %) */
  to?: number;
  words?: string[];
  codes?: string[];
  days?: number;
  /** Den, od kterého krok platí (YYYY-MM-DD) — pro plán */
  date?: string;
  reason?: string;
}

export interface ChatContext {
  cfg: AdsConfig;
  today: string;
  overview: AdsOverview;
  campaigns: AdsCampaignRow[];
  /** Kampaň → rozpočet sdílený / číslo rozpočtu (z tabulky kampaní) */
  meta: Map<string, { budgetId: string; budgetShared: boolean; limited: boolean }>;
  products: AdsProductRow[];
  open: AdsProposal[];
  changes: AdsChange[];
  vocabulary: Set<string>;
  /** Marže po trzích (bez reklamy) */
  margins: Record<string, number>;
  monthSpend: number;
  daysLeft: number;
}

export interface ChatDraft extends ProposalDraft {
  system: AdsSystem;
  /** Den, od kdy návrh platí; prázdné = hned */
  notBefore: string;
}

const kc = (n: number) => `${Math.round(n).toLocaleString('cs-CZ')} Kč`;
const r2 = (n: number | null | undefined) => (n == null ? null : Math.round(n * 1000) / 1000);
const hash = (text: string) => crypto.createHash('sha1').update(text).digest('hex').slice(0, 8);
const key = (system: string, id: string) => `${system}|${id}`;

/* ---------- co model dostane ---------- */

/**
 * Shrnutí dat pro model. Kompaktní JSON — celé tabulky by zbytečně
 * prodražily každou otázku a model by se v nich ztrácel. Produkty jen ty,
 * na kterých záleží (nejvíc utrácejí, nejvíc vydělávají, prodělávají).
 */
export function contextText(ctx: ChatContext): string {
  const o = ctx.overview;
  const prods = [...ctx.products];
  const pick = new Map<string, AdsProductRow>();
  for (const p of [...prods].sort((a, b) => b.cost - a.cost).slice(0, 15)) pick.set(p.code, p);
  for (const p of [...prods].sort((a, b) => b.profit - a.profit).slice(0, 10)) pick.set(p.code, p);
  for (const p of prods.filter(p => p.profit < 0).sort((a, b) => a.profit - b.profit).slice(0, 15)) pick.set(p.code, p);
  const data = {
    dnes: ctx.today,
    cil: {
      ziskPoReklameZObratu: ctx.cfg.targetProfitShare,
      vysvetleni: 'cílové PNO = marže − požadovaný podíl zisku; PNO = náklady / hodnota konverzí bez DPH',
      pojistky: ctx.cfg.guards,
      hodnotaKonverzeSDph: ctx.cfg.convValueWithVat
    },
    obdobi: { od: o.from, do: o.to, dni: o.days },
    prehled: {
      ziskPoReklame: Math.round(o.profitAfterAds.value), ziskPredtim: Math.round(o.profitAfterAds.prev),
      obrat: Math.round(o.revenue.value), obratPredtim: Math.round(o.revenue.prev),
      naklady: Math.round(o.cost.value), nakladyPredtim: Math.round(o.cost.prev),
      objednavky: o.orders.value, podilZisku: r2(o.profitShare), pnoEshopu: r2(o.shopPno),
      marze: r2(o.margin), cilovePno: r2(o.targetPno),
      trhy: o.markets.map(m => ({ trh: m.market, obrat: Math.round(m.revenue), naklady: Math.round(m.cost),
        ziskPoReklame: Math.round(m.profitAfterAds), pno: r2(m.pno), cilovePno: r2(m.targetPno) })),
      systemy: o.systems.filter(s => s.connected).map(s => ({ system: s.system, naklady: Math.round(s.cost),
        hodnota: Math.round(s.value), konverze: Math.round(s.conversions), pno: r2(s.pno) })),
      upozorneni: o.alerts.map(a => a.title),
      poslednich14Dni: o.daily.slice(-14).map(d => [d.date, Math.round(d.profit), Math.round(d.cost), d.orders])
    },
    marzePoTrzich: ctx.margins,
    mesic: { utracenoTentoMesic: Math.round(ctx.monthSpend), zbyvaDni: ctx.daysLeft },
    kampane: ctx.campaigns.map(c => {
      const m = ctx.meta.get(key(c.system, c.id));
      return {
        system: c.system, id: c.id, nazev: c.name, trh: c.market, typ: c.type, stav: c.status,
        rozpocetDen: c.budget, sdilenyRozpocet: !!m?.budgetShared, omezenoRozpoctem: !!m?.limited,
        nabizeni: c.bidding, cilRoas: c.targetRoas, naklady: Math.round(c.cost), konverze: Math.round(c.conversions),
        hodnota: Math.round(c.value), zisk: Math.round(c.profit), pno: r2(c.pno), cilovePno: r2(c.targetPno)
      };
    }),
    produkty: [...pick.values()].map(p => ({
      kod: p.code, nazev: p.title, segment: p.segment, marze: r2(p.margin), naklady: Math.round(p.cost),
      hodnota: Math.round(p.value), zisk: Math.round(p.profit), pno: r2(p.pno), sklad: p.stock
    })),
    otevreneNavrhy: ctx.open.slice(0, 15).map(p => p.title),
    posledniZmeny: ctx.changes.slice(0, 10).map(c => `${c.at.slice(0, 10)} ${c.title}${c.revertedAt ? ' (vráceno)' : ''}`)
  };
  return JSON.stringify(data);
}

export const SYSTEM = `Jsi poradce pro PPC reklamu e-shopu Quentino (pánské doplňky: kšandy, motýlky, kravaty, ponožky…).
Mluvíš česky, srozumitelně i pro člověka, který není PPC specialista. Zkratky (PNO, ROAS, CPC) při prvním použití vysvětli.

Řídíš se ziskem, ne obratem: cílem je zisk po reklamě aspoň daný podíl z obratu bez DPH. Pracuješ JEN s daty, která dostaneš
v bloku DATA — nic si nevymýšlej, a když data na odpověď nestačí, řekni to a co by pomohlo. Částky jsou v Kč bez DPH.

Když se uživatel ptá, odpověz. Když chce něco změnit nebo naplánovat (nebo je změna zjevně výhodná a on se ptá „co dělat"),
přidej kroky do "actions". Kroky se NEPROVÁDĚJÍ samy — z každého vznikne návrh, který uživatel schválí. Povolené kroky:
- {"type":"budget","system":"google|sklik","campaignId":"…","to":1200,"date":"YYYY-MM-DD","reason":"…"} — denní rozpočet v Kč.
  Jeden krok smí změnit rozpočet nejvýš o pojistky.maxBudgetStep (0.2 = 20 %); větší změnu rozlož do víc kroků s datem.
  Nesahej na sdílené rozpočty. Sklik umí jen tohle.
- {"type":"troas","campaignId":"…","to":6.5,"date":"…","reason":"…"} — cílové ROAS jako násobek (6.5 = 650 %), jen Google
  a jen u nabízení MAXIMIZE_CONVERSION_VALUE / TARGET_ROAS. Krok nejvýš o pojistky.maxRoasStep. Vyšší ROAS = přísnější.
- {"type":"negative","campaignId":"…","words":["bazar"],"reason":"…"} — vylučující slova (jen Google). Nikdy ne slova,
  která jsou v názvech produktů.
- {"type":"exclude","codes":["KOD"],"days":30,"reason":"…"} — dočasně vyřadit produkty z reklam (přes feed).
"date" vynech, když má krok platit hned; pro plán (sezóna, akce) dej den, od kdy má platit (nejvýš 120 dní dopředu).
"reason" piš jednou dvěma větami pro laika: co se změní a proč to vydělá (nebo ušetří).

Odpovídej VÝHRADNĚ jedním JSON objektem bez dalšího textu:
{"answer":"odpověď — odstavce oddělené prázdným řádkem, odrážky začínají '- ', důležité **tučně**","actions":[…]}`;

/** Zpráva pro model: data, dosavadní rozhovor, otázka */
export function userMessage(ctx: ChatContext, history: ChatTurn[], question: string): string {
  const past = history.slice(-8).map(t => `${t.role === 'user' ? 'UŽIVATEL' : 'PORADCE'}: ${t.text.slice(0, 2000)}`).join('\n\n');
  return `DATA:\n${contextText(ctx)}\n\n${past ? `DOSAVADNÍ ROZHOVOR:\n${past}\n\n` : ''}OTÁZKA:\n${question}`;
}

/** Odpověď modelu → text a kroky. Model občas obalí JSON do ```, nebo vrátí jen text. */
export function parseReply(text: string): { answer: string; actions: ChatAction[] } {
  const raw = String(text ?? '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const json = JSON.parse(raw.slice(start, end + 1));
      return {
        answer: String(json.answer ?? '').trim(),
        actions: Array.isArray(json.actions) ? json.actions.filter((a: any) => a && typeof a === 'object') : []
      };
    } catch { /* níž jako text */ }
  }
  return { answer: raw.replace(/^```\w*\s*|```$/g, '').trim(), actions: [] };
}

/* ---------- z kroků návrhy ---------- */

const dateLabel = (d: string) => `${Number(d.slice(8, 10))}. ${Number(d.slice(5, 7))}.`;

/**
 * Kroky modelu → návrhy. Každý krok se ověří stejně přísně jako u enginu;
 * co neprojde, skončí v `notes` s vysvětlením, místo aby se tiše zahodilo.
 *
 * Kroky téže kampaně s datem jdou za sebou: druhý krok počítá s hodnotou,
 * kterou nastaví první (jinak by ho kontrola stavu před zápisem odmítla).
 */
export function draftsFrom(actions: ChatAction[], ctx: ChatContext, question: string): { drafts: ChatDraft[]; notes: string[] } {
  const g = ctx.cfg.guards;
  const drafts: ChatDraft[] = [];
  const notes: string[] = [];
  const why = `Z poradce na otázku „${question.slice(0, 120)}${question.length > 120 ? '…' : ''}"`;
  const last = ctx.today;
  const maxDay = shiftDay(last, 120);
  // Stav po předchozích krocích: kampaň → rozpočet / cíl
  const budgetAfter = new Map<string, number>();
  const roasAfter = new Map<string, number | null>();
  let addedNow = 0;

  const ordered = actions.slice(0, 20).map((a, i) => ({ a, i, date: validDate(a.date, last, maxDay) }))
    .sort((x, y) => (x.date || '').localeCompare(y.date || '') || x.i - y.i);

  const findCampaign = (a: ChatAction): AdsCampaignRow | null => {
    const id = String(a.campaignId ?? '').trim();
    const sys = String(a.system ?? '').toLowerCase();
    const hits = ctx.campaigns.filter(c => c.id === id && (!sys || c.system === sys));
    return hits.length === 1 ? hits[0] : null;
  };

  for (const { a, date } of ordered) {
    const type = String(a.type ?? '').toLowerCase();
    if (a.date && !date) {
      notes.push(`Krok s datem ${a.date} jsem vynechal — datum musí být mezi zítřkem a 120 dny dopředu.`);
      continue;
    }
    const when = date ? ` (od ${dateLabel(date)})` : '';
    const plain = String(a.reason ?? '').trim();

    if (type === 'budget') {
      const c = findCampaign(a);
      if (!c) { notes.push(`Kampaň ${a.campaignId ?? '?'} v datech není — rozpočet jsem nenavrhl.`); continue; }
      const m = ctx.meta.get(key(c.system, c.id));
      if (c.status !== 'ENABLED') { notes.push(`„${c.name}" neběží — rozpočet pozastavené kampaně nemá smysl měnit.`); continue; }
      if (m?.budgetShared || !m?.budgetId) { notes.push(`„${c.name}" má sdílený rozpočet — změna by se týkala i jiných kampaní, proto ji nenavrhuji.`); continue; }
      const from = budgetAfter.get(key(c.system, c.id)) ?? c.budget;
      const wanted = Number(a.to);
      if (from == null || !(wanted > 0)) { notes.push(`U „${c.name}" chybí rozpočet — krok jsem vynechal.`); continue; }
      const lo = from * (1 - g.maxBudgetStep);
      const hi = from * (1 + g.maxBudgetStep);
      const to = Math.round(Math.min(hi, Math.max(lo, wanted)));
      if (Math.abs(to - from) < 1) { notes.push(`„${c.name}": rozpočet ${kc(from)} už odpovídá — beze změny.`); continue; }
      if (to !== Math.round(wanted)) {
        notes.push(`„${c.name}": ${kc(wanted)} je za pojistkou ±${Math.round(g.maxBudgetStep * 100)} % na krok — navrhuji ${kc(to)}; zbytek přidej dalším krokem s pozdějším datem.`);
      }
      if (!date && to > from && g.monthlyBudget > 0) {
        const daily = ctx.campaigns.filter(x => x.status === 'ENABLED').reduce((s, x) => s + (x.budget ?? 0), 0);
        if (ctx.monthSpend + (daily + addedNow + to - from) * ctx.daysLeft > g.monthlyBudget) {
          notes.push(`„${c.name}": přidání by přetáhlo měsíční strop ${kc(g.monthlyBudget)} — nenavrhuji.`);
          continue;
        }
        addedNow += to - from;
      }
      budgetAfter.set(key(c.system, c.id), to);
      const kind: AdsProposalKind = to > from ? 'budget-up' : 'budget-down';
      drafts.push(draft(c.system, kind, c, date, {
        title: `${to > from ? 'Přidat' : 'Ubrat'} rozpočet: ${c.name} ${kc(from)} → ${kc(to)} denně${when}`,
        plain: plain || `Denní rozpočet kampaně „${c.name}" se změní z ${kc(from)} na ${kc(to)}.`,
        why,
        ops: [{ kind: 'budget', campaignId: c.id, budgetId: m.budgetId, from, to, account: c.account }]
      }));
      continue;
    }

    if (type === 'troas') {
      const c = findCampaign({ ...a, system: 'google' });
      if (!c) { notes.push(`Kampaň ${a.campaignId ?? '?'} v Google Ads není — cíl návratnosti jsem nenavrhl.`); continue; }
      if (c.status !== 'ENABLED') { notes.push(`„${c.name}" neběží — cíl nemá smysl měnit.`); continue; }
      if (c.bidding !== 'MAXIMIZE_CONVERSION_VALUE' && c.bidding !== 'TARGET_ROAS') {
        notes.push(`„${c.name}" nemá nabízení na hodnotu konverzí — cílové ROAS se u ní nastavit nedá.`);
        continue;
      }
      const k = key(c.system, c.id);
      const from = roasAfter.has(k) ? roasAfter.get(k)! : c.targetRoas;
      let wanted = Number(a.to);
      if (wanted > 30) wanted /= 100; // model napsal procenta (650 místo 6.5)
      if (!(wanted > 0)) { notes.push(`„${c.name}": chybí cílové ROAS — krok jsem vynechal.`); continue; }
      let to = wanted;
      if (from != null) {
        to = Math.min(from * (1 + g.maxRoasStep), Math.max(from * (1 - g.maxRoasStep), wanted));
      } else {
        // Nový cíl: nejvýš tak přísný, aby kampaň šla aspoň na bod zlomu (PNO = marže)
        const margin = ctx.margins[c.market] ?? ctx.cfg.fallbackMargin;
        to = Math.max(wanted, roasForPno(ctx.cfg, margin, c.market));
      }
      to = Math.round(to * 100) / 100;
      if (from != null && Math.abs(to - from) < 0.01) { notes.push(`„${c.name}": cíl ${Math.round(from * 100)} % už odpovídá.`); continue; }
      if (Math.abs(to - wanted) >= 0.01) {
        notes.push(`„${c.name}": cíl ${Math.round(wanted * 100)} % je za pojistkou — navrhuji ${Math.round(to * 100)} %.`);
      }
      roasAfter.set(k, to);
      const kind: AdsProposalKind = from == null ? 'roas-set' : to > from ? 'roas-up' : 'roas-down';
      const field = c.bidding === 'TARGET_ROAS' ? 'target_roas' as const : 'maximize_conversion_value' as const;
      drafts.push(draft('google', kind, c, date, {
        title: from == null
          ? `Nastavit cílové ROAS: ${c.name} ${Math.round(to * 100)} %${when}`
          : `${to > from ? 'Přísnější' : 'Volnější'} cíl: ${c.name} ROAS ${Math.round(from * 100)} % → ${Math.round(to * 100)} %${when}`,
        plain: plain || `Kampaň „${c.name}" dostane cíl návratnosti ${Math.round(to * 100)} %.`,
        why,
        ops: [{ kind: 'troas', campaignId: c.id, field, from, to, account: c.account }]
      }));
      continue;
    }

    if (type === 'negative') {
      const c = findCampaign({ ...a, system: 'google' });
      if (!c) { notes.push(`Kampaň ${a.campaignId ?? '?'} v Google Ads není — vylučující slova jsem nenavrhl.`); continue; }
      const words = [...new Set((Array.isArray(a.words) ? a.words : []).map(w => String(w).trim().toLowerCase()).filter(Boolean))];
      const banned = words.filter(w => w.split(/\s+/).some(part => ctx.vocabulary.has(stem(part))));
      const ok = words.filter(w => !banned.includes(w) && plainWord(w).length >= 3).slice(0, 20);
      if (banned.length) notes.push(`Slova ${banned.map(w => `„${w}"`).join(', ')} jsou v názvech produktů — ta se nevylučují.`);
      if (!ok.length) continue;
      drafts.push(draft('google', 'negatives', c, date, {
        title: `Vyloučit ${ok.length === 1 ? 'slovo' : `${ok.length} slova`} v ${c.name}: ${ok.join(', ')}${when}`,
        plain: plain || `Reklama kampaně „${c.name}" se přestane ukazovat na hledání se slovy ${ok.join(', ')}.`,
        why,
        ops: ok.map(text => ({ kind: 'negative' as const, campaignId: c.id, text, match: 'PHRASE' as const, cost: 0, clicks: 0, account: c.account }))
      }, ok.join(',')));
      continue;
    }

    if (type === 'exclude') {
      const known = new Map(ctx.products.map(p => [p.code.toLowerCase(), p]));
      const codes = [...new Set((Array.isArray(a.codes) ? a.codes : []).map(x => String(x).trim()))];
      const found = codes.map(x => known.get(x.toLowerCase())).filter(Boolean) as AdsProductRow[];
      const missing = codes.filter(x => !known.has(x.toLowerCase()));
      if (missing.length) notes.push(`Produkty ${missing.join(', ')} v reklamách nejsou — vynechal jsem je.`);
      if (!found.length) continue;
      const daysOff = Math.min(60, Math.max(7, Math.round(Number(a.days) || 30)));
      const list = found.map(p => p.code);
      drafts.push({
        fingerprint: `exclude|google|${hash(list.sort().join(','))}|chat|${hash(`${date}|${list.join(',')}`)}`,
        system: 'google', market: '', notBefore: date,
        kind: 'exclude', targetId: 'feed', targetName: 'Doplňkový feed',
        title: `Vyřadit z reklam na ${daysOff} dní: ${found.length === 1 ? found[0].title : `${found.length} produktů`}${when}`,
        plain: plain || `Produkty ${found.map(p => p.title).join(', ')} se na ${daysOff} dní přestanou ukazovat v reklamách.`,
        why, impact: 0, confidence: 1,
        ops: [{ kind: 'exclude', codes: list, days: daysOff }]
      });
      continue;
    }

    notes.push(`Krok „${type || '?'}" aplikace neumí — zůstává jen jako rada v textu.`);
  }
  return { drafts, notes };
}

function validDate(value: unknown, today: string, maxDay: string): string {
  const d = String(value ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return '';
  if (d <= today || d > maxDay) return '';
  return d;
}

function draft(
  system: AdsSystem, kind: AdsProposalKind, c: AdsCampaignRow, date: string,
  body: { title: string; plain: string; why: string; ops: AdsOp[] }, extra = ''
): ChatDraft {
  return {
    // Stejný začátek otisku jako u enginu (druh|systém|kampaň) — „Nenavrhovat" a pojistky platí i tady
    fingerprint: `${kind}|${system}|${c.id}|chat|${hash(`${date}|${JSON.stringify(body.ops)}|${extra}`)}`,
    system, market: c.market, notBefore: date, kind, targetId: c.id, targetName: c.name,
    title: body.title, plain: body.plain, why: body.why, impact: 0, confidence: 1, ops: body.ops
  };
}
