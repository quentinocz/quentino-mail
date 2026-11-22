/**
 * Poradce s nástroji — sám si dohledá data a navrhne změny.
 *
 * ## Proč takhle (a ne jedno shrnutí v promptu)
 *
 * První verze dostávala pevné shrnutí za 30 dní a odpovídala jedním JSON
 * objektem. Dvě potíže: na „jak dopadl říjen" nebo „co hledají lidé, kteří
 * kliknou na kšandy" data neměla, a JSON s českými uvozovkami uvnitř textu
 * se rozbíjel — Patrik (22. 11.) dostal na obrazovku syrový JSON.
 *
 * Teď má model **nástroje**: přehled za libovolné období, kampaně, jednu
 * kampaň po dnech, produkty s filtry, hledané dotazy, objednávky, sezóny,
 * návrhy a změny, nastavení. Sám si řekne, co potřebuje, a odpověď píše
 * jako obyčejný text. Změny jdou přes nástroj `navrhnout_zmeny` — z kroků
 * vzniknou běžné návrhy přes stejné pojistky jako u enginu (chat.draftsFrom);
 * co neprojde, se vrátí modelu i člověku s důvodem. Nic se neprovede samo.
 *
 * Rozhovory se ukládají (chats.ts) a sdílejí mezi Macy.
 */
import { BrowserWindow } from 'electron';
import { client, recordUsage } from '../ai';
import { getSettings } from '../settings';
import { getDb } from '../db';
import type { AdsChatReply, AdsChatTurn, AdsProposal } from '../../shared/ads';
import { MARKET_LABELS } from '../../shared/ads';
import * as ads from './index';
import * as chat from './chat';
import * as chats from './chats';
import * as prop from './proposals';
import { getAdsConfig, accountInfo, accountCzk } from './store';

/* ---------- nástroje ---------- */

const PERIOD = {
  dni: { type: 'number', description: 'Posledních N dní končících včerejškem (výchozí 30). Nepoužívej s od/do.' },
  od: { type: 'string', description: 'Začátek období YYYY-MM-DD (s „do")' },
  do: { type: 'string', description: 'Konec období YYYY-MM-DD (s „od")' },
  trh: { type: 'string', enum: ['all', 'cz', 'sk', 'en'], description: 'Trh; all = všechny (výchozí trh rozhovoru)' }
};

export const TOOLS = [
  {
    name: 'prehled',
    description: 'Souhrn za období proti stejně dlouhému předchozímu: zisk po reklamě, obrat, náklady, objednávky, PNO, '
      + 'systémy (Google, Sklik, Meta), trhy, upozornění a zisk/náklady po dnech.',
    input_schema: { type: 'object', properties: { ...PERIOD } }
  },
  {
    name: 'kampane',
    description: 'Všechny kampaně za období: systém, trh, typ, stav, denní rozpočet (a jestli je sdílený / omezený rozpočtem), '
      + 'nabízení a cílové ROAS, útrata, konverze, hodnota, zisk, PNO a cílové PNO. ID kampaní potřebuješ pro návrhy.',
    input_schema: { type: 'object', properties: { ...PERIOD, system: { type: 'string', enum: ['google', 'sklik', 'meta'] } } }
  },
  {
    name: 'kampan_po_dnech',
    description: 'Jedna kampaň den po dni (náklady, kliky, konverze, hodnota) — na trend a výkyvy.',
    input_schema: {
      type: 'object', required: ['system', 'kampan_id'],
      properties: { system: { type: 'string', enum: ['google', 'sklik', 'meta'] }, kampan_id: { type: 'string' }, ...PERIOD }
    }
  },
  {
    name: 'produkty',
    description: 'Produkty v reklamách (Google Nákupy/PMax): segment (hvezdy, pracanti, zrouti, spici, novinky, doprodej, '
      + 'vyprodano), marže, útrata, konverze, hodnota, zisk, PNO, sklad, prodáno kusů. Filtry a řazení.',
    input_schema: {
      type: 'object',
      properties: {
        dni: PERIOD.dni, trh: PERIOD.trh,
        segment: { type: 'string' }, kategorie: { type: 'string', description: 'Část názvu kategorie' },
        hledat: { type: 'string', description: 'Část názvu nebo kódu produktu' },
        razeni: { type: 'string', enum: ['naklady', 'zisk', 'ztrata', 'prodeje'] },
        limit: { type: 'number', description: 'Výchozí 25, nejvýš 80' }
      }
    }
  },
  {
    name: 'hledane_dotazy',
    description: 'Co lidé hledali, než klikli na reklamu (Google, posledních 30 dní): kliky, náklady, konverze. '
      + 'Podklad pro vylučující slova a nová klíčová slova.',
    input_schema: {
      type: 'object',
      properties: {
        kampan_id: { type: 'string' }, jen_bez_prodeje: { type: 'boolean' },
        hledat: { type: 'string', description: 'Část dotazu' }, limit: { type: 'number', description: 'Výchozí 40, nejvýš 150' }
      }
    }
  },
  {
    name: 'objednavky',
    description: 'Objednávky e-shopu v období (všechny, nejen z reklam): počet, obrat a zisk před reklamou, po trzích, '
      + 'po týdnech a nejprodávanější produkty.',
    input_schema: { type: 'object', properties: { ...PERIOD } }
  },
  {
    name: 'sezony',
    description: 'Nejbližší sezónní události (plesy, Valentýn, svatby, Den otců, Black Friday, Vánoce) s odhadem, '
      + 'kolikrát víc se v nich prodává, a kolik kroků plánu už je naplánovaných.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'navrhy_a_zmeny',
    description: 'Otevřené a naplánované návrhy, posledních 30 změn v účtech s vyhodnocením (vyšlo / nevyšlo) a stav autopilota.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'nastaveni',
    description: 'Cíl zisku, pojistky (max. krok rozpočtu a ROAS, klid po změně, měsíční strop), připojené účty a trhy.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'navrhnout_zmeny',
    description: 'Vytvoří NÁVRHY změn ke schválení (nic se neprovede samo). Každý krok projde pojistkami; co neprojde, '
      + 'vrátí se s důvodem. Typy kroků: '
      + 'budget {system, campaignId, to (Kč/den)}, '
      + 'troas {campaignId, to (násobek, 6.5 = 650 %)} jen Google, '
      + 'negative {campaignId, words[]} jen Google, '
      + 'exclude {codes[], days} vyřadit produkty z reklam, '
      + 'pause / enable {system, campaignId}. '
      + 'Volitelně date (YYYY-MM-DD) = krok platí od toho dne (plán), a vždy reason = 1–2 věty pro laika.',
    input_schema: {
      type: 'object', required: ['kroky'],
      properties: {
        kroky: {
          type: 'array',
          items: {
            type: 'object', required: ['type', 'reason'],
            properties: {
              type: { type: 'string', enum: ['budget', 'troas', 'negative', 'exclude', 'pause', 'enable'] },
              system: { type: 'string', enum: ['google', 'sklik', 'meta'] },
              campaignId: { type: 'string' }, to: { type: 'number' },
              words: { type: 'array', items: { type: 'string' } },
              codes: { type: 'array', items: { type: 'string' } },
              days: { type: 'number' }, date: { type: 'string' }, reason: { type: 'string' }
            }
          }
        }
      }
    }
  }
];

/** Co nástroj dělá — popisek pro okno („Dívám se na kampaně…") */
const STEP_LABEL: Record<string, string> = {
  prehled: 'Přehled období', kampane: 'Kampaně', kampan_po_dnech: 'Kampaň po dnech', produkty: 'Produkty',
  hledane_dotazy: 'Hledané dotazy', objednavky: 'Objednávky', sezony: 'Sezóny', navrhy_a_zmeny: 'Návrhy a změny',
  nastaveni: 'Nastavení', navrhnout_zmeny: 'Návrhy změn'
};

const r0 = (n: number | null | undefined) => (n == null ? null : Math.round(n));
const r3 = (n: number | null | undefined) => (n == null ? null : Math.round(n * 1000) / 1000);

export interface ToolRun { proposals: AdsProposal[]; notes: string[]; question: string; scope: string; ctx?: chat.ChatContext }

/** Provede nástroj a vrátí data pro model (JSON, zkrácený) */
export function runTool(name: string, input: any, run: ToolRun): unknown {
  const i = input && typeof input === 'object' ? input : {};
  const trh = ['all', 'cz', 'sk', 'en'].includes(i.trh) ? i.trh : run.scope;
  const range = ads.rangeOf(i.dni, i.od, i.do);
  switch (name) {
    case 'prehled': {
      const o = ads.overview(30, trh, range);
      return {
        obdobi: { od: range.from, do: range.to, predchozi: `${range.prevFrom} až ${range.prevTo}` }, trh,
        ziskPoReklame: [r0(o.profitAfterAds.value), r0(o.profitAfterAds.prev)], obrat: [r0(o.revenue.value), r0(o.revenue.prev)],
        naklady: [r0(o.cost.value), r0(o.cost.prev)], objednavky: [o.orders.value, o.orders.prev],
        vysvetleni: 'dvojice = [toto období, předchozí]; Kč bez DPH',
        podilZiskuZObratu: r3(o.profitShare), cilPodilu: getAdsConfig().targetProfitShare, pnoEshopu: r3(o.shopPno),
        marze: r3(o.margin), cilovePno: r3(o.targetPno),
        systemy: o.systems.filter(s => s.connected).map(s => ({ system: s.system, naklady: r0(s.cost), hodnota: r0(s.value),
          konverze: Math.round(s.conversions), ziskZKonverzi: r0(s.profit), pno: r3(s.pno) })),
        trhy: o.markets.map(m => ({ trh: m.market, obrat: r0(m.revenue), naklady: r0(m.cost), ziskPoReklame: r0(m.profitAfterAds), pno: r3(m.pno), cilovePno: r3(m.targetPno) })),
        upozorneni: o.alerts.map(a => `${a.level}: ${a.title}`),
        poDnech: o.daily.map(d => [d.date, r0(d.profit), r0(d.cost), d.orders])
      };
    }
    case 'kampane': {
      const meta = new Map((getDb().prepare('SELECT system, id, budget_shared, limited, budget_id FROM ads_campaigns').all() as any[])
        .map(r => [`${r.system}|${r.id}`, r]));
      return ads.campaigns(30, trh, range).filter(c => !i.system || c.system === i.system).map(c => {
        const m = meta.get(`${c.system}|${c.id}`);
        return {
          system: c.system, id: c.id, nazev: c.name, trh: c.market, typ: c.type, stav: c.status, rozpocetDen: r0(c.budget),
          sdilenyRozpocet: !!m?.budget_shared, omezenoRozpoctem: !!m?.limited, rozpocetNaKampani: !!m?.budget_id,
          nabizeni: c.bidding, cilRoas: c.targetRoas, naklady: r0(c.cost), kliky: c.clicks, konverze: Math.round(c.conversions * 10) / 10,
          hodnota: r0(c.value), zisk: r0(c.profit), pno: r3(c.pno), cilovePno: r3(c.targetPno)
        };
      });
    }
    case 'kampan_po_dnech':
      return { od: range.from, do: range.to, dny: ads.campaignDaily(String(i.system ?? 'google'), String(i.kampan_id ?? ''), range) };
    case 'produkty': {
      let rows = ads.products(Math.round(i.dni ?? 30) || 30, trh).rows;
      if (i.segment) rows = rows.filter(p => p.segment === i.segment);
      if (i.kategorie) rows = rows.filter(p => p.category.toLowerCase().includes(String(i.kategorie).toLowerCase()));
      if (i.hledat) {
        const q = String(i.hledat).toLowerCase();
        rows = rows.filter(p => p.title.toLowerCase().includes(q) || p.code.toLowerCase().includes(q));
      }
      const sorter: Record<string, (a: any, b: any) => number> = {
        naklady: (a, b) => b.cost - a.cost, zisk: (a, b) => b.profit - a.profit,
        ztrata: (a, b) => a.profit - b.profit, prodeje: (a, b) => b.sold - a.sold
      };
      rows = [...rows].sort(sorter[i.razeni] ?? sorter.naklady);
      const limit = Math.min(80, Math.max(1, Math.round(i.limit ?? 25)));
      return {
        celkem: rows.length,
        produkty: rows.slice(0, limit).map(p => ({
          kod: p.code, nazev: p.title, kategorie: p.category, segment: p.segment, marze: r3(p.margin), naklady: r0(p.cost),
          konverze: Math.round(p.conversions * 10) / 10, hodnota: r0(p.value), zisk: r0(p.profit), pno: r3(p.pno), sklad: p.stock, prodanoKusu: p.sold
        }))
      };
    }
    case 'hledane_dotazy': {
      const cfg = getAdsConfig();
      let rows = (getDb().prepare(
        "SELECT t.campaign_id, t.term, t.clicks, t.cost, t.conversions, t.value, t.account, c.name FROM ads_search_terms t "
        + "LEFT JOIN ads_campaigns c ON c.system = t.system AND c.id = t.campaign_id WHERE t.system = 'google'"
      ).all() as any[]);
      if (i.kampan_id) rows = rows.filter(r => String(r.campaign_id) === String(i.kampan_id));
      if (i.jen_bez_prodeje) rows = rows.filter(r => !(Number(r.conversions) > 0));
      if (i.hledat) rows = rows.filter(r => String(r.term).toLowerCase().includes(String(i.hledat).toLowerCase()));
      rows.sort((a, b) => Number(b.cost) - Number(a.cost));
      const limit = Math.min(150, Math.max(1, Math.round(i.limit ?? 40)));
      return {
        celkem: rows.length, obdobi: 'posledních 30 dní',
        dotazy: rows.slice(0, limit).map(r => ({
          dotaz: r.term, kampan: r.name ?? r.campaign_id, kampanId: String(r.campaign_id), kliky: r.clicks,
          naklady: r0(accountCzk(cfg, accountInfo(cfg, r.account), Number(r.cost) || 0)), konverze: Math.round(Number(r.conversions) * 10) / 10
        }))
      };
    }
    case 'objednavky':
      return ads.ordersSummary(range, trh);
    case 'sezony':
      return ads.seasons(trh).events.map(e => ({ id: e.id, udalost: e.name, od: e.start, vrchol: e.peak, do: e.end,
        prodejeProtiPrumernemuTydnu: e.uplift, zHistorie: e.fromHistory, naplanovanoKroku: e.planned, poznamka: e.note }));
    case 'navrhy_a_zmeny': {
      const v = ads.proposals();
      return {
        otevrene: v.open.map(p => ({ nazev: p.title, druh: p.kind, odhadKc30dni: p.impact })),
        naplanovane: v.planned.map(p => ({ den: p.snoozeUntil, nazev: p.title })),
        zmeny: v.changes.slice(0, 30).map(c => ({ kdy: c.at.slice(0, 10), co: c.title, kdo: c.device,
          vysledek: c.revertedAt ? 'vráceno' : c.evaluation?.verdict ?? '' })),
        uspesnost: v.track, autopilot: ads.autopilotState(v)
      };
    }
    case 'nastaveni': {
      const cfg = getAdsConfig();
      return {
        cilZiskuPoReklameZObratu: cfg.targetProfitShare, trhy: cfg.markets.map(m => MARKET_LABELS[m] ?? m),
        pojistky: cfg.guards, samostatnost: cfg.autonomy,
        ucty: [
          ...cfg.google.accounts.filter(a => a.enabled).map(a => ({ system: 'google', nazev: a.name, trh: a.market, mena: a.currency })),
          ...(cfg.sklik.enabled ? [{ system: 'sklik', nazev: cfg.sklik.name, trh: 'cz', mena: 'CZK' }] : []),
          ...(cfg.meta.enabled ? [{ system: 'meta', nazev: cfg.meta.name, trh: cfg.meta.market, mena: cfg.meta.currency }] : [])
        ]
      };
    }
    case 'navrhnout_zmeny': {
      run.ctx = run.ctx ?? ads.chatContext(run.scope);
      const steps = Array.isArray(i.kroky) ? i.kroky : [];
      const { drafts, notes } = chat.draftsFrom(steps, run.ctx, run.question);
      const saved = prop.saveChat(drafts);
      run.proposals.push(...saved);
      run.notes.push(...notes);
      return {
        vytvoreneNavrhy: saved.map(p => ({ nazev: p.title, od: p.snoozeUntil || 'hned' })),
        neproslo: notes,
        pozn: 'Návrhy čekají na schválení v záložce Návrhy (s datem v Naplánovaných). Nic se zatím nezměnilo.'
      };
    }
    default:
      return { chyba: `Neznámý nástroj ${name}` };
  }
}

/* ---------- rozhovor ---------- */

function systemPrompt(scope: string): string {
  const cfg = getAdsConfig();
  return `Jsi zkušený PPC poradce e-shopu Quentino (pánské doplňky: kšandy, motýlky, kravaty, ponožky, manžetové knoflíčky).
Mluvíš česky, srozumitelně pro majitele, který není PPC specialista; zkratky (PNO, ROAS, CPC) při prvním použití vysvětli.

Cíl e-shopu: zisk po reklamě aspoň ${Math.round(cfg.targetProfitShare * 100)} % z obratu bez DPH. Řídíš se ziskem, ne obratem.
Zisk po reklamě = marže z objednávek + doprava − náklady na dopravu − náklady na reklamu. Částky jsou v Kč bez DPH.
Dnes je ${new Date().toISOString().slice(0, 10)}. Trh rozhovoru: ${scope === 'all' ? 'všechny trhy' : MARKET_LABELS[scope] ?? scope}.

Jak pracuješ:
- Než odpovíš, dohledej si data nástroji (klidně víc najednou). Nic si nevymýšlej; když data chybí, řekni co.
- Když chce uživatel něco změnit nebo naplánovat, použij navrhnout_zmeny. Vzniknou návrhy ke schválení — nikdy netvrď,
  že je něco změněné. Velkou změnu rozlož do víc kroků s datem (pojistky dovolí jen malý krok najednou).
- Nové kampaně zatím zakládat neumíš (přijde brzy); umíš je doporučit slovy, nebo odkázat na „Navrhnout kampaň" v Kampaních.

Jak píšeš odpověď (obyčejný text, ne JSON):
- Začni jednou dvěma větami s hlavním závěrem. Pak podrobnosti.
- Smíš použít jen: odstavce, odrážky „- ", číslovaný seznam „1. ", nadpis „### " a **tučně**. Žádné tabulky ani HTML.
- U čísel řekni, za jaké období jsou. Buď stručný: radši 3 silné body než 10 slabých.
- Když jsi vytvořil návrhy, na konci napiš jednou větou, kde je najde.`;
}

function emitStep(chatId: string, step: string): void {
  for (const w of BrowserWindow.getAllWindows()) {
    try { w.webContents.send('ads:advisor', { chatId, step }); } catch { /* okno se zavírá */ }
  }
}

async function create(body: any): Promise<any> {
  let last: any = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await client().messages.create(body);
    } catch (e: any) {
      last = e;
      const status = e?.status ?? e?.response?.status;
      if (!(status === 429 || status === 529 || (status >= 500 && status < 600) || /overloaded/i.test(String(e?.message)))) throw e;
      await new Promise(r => setTimeout(r, 2000 * (attempt + 1) ** 2));
    }
  }
  throw last;
}

/** Předchozí tahy jako text pro model (návrhy z nich jednou větou) */
function historyMessages(turns: AdsChatTurn[]): { role: 'user' | 'assistant'; content: string }[] {
  const out: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const t of turns.slice(-12)) {
    const text = t.role === 'assistant' && t.proposals?.length
      ? `${t.text}\n\n(Vytvořené návrhy: ${t.proposals.map(p => p.title).join('; ')})`
      : t.text;
    // API chce střídání rolí — dvě stejné po sobě se spojí
    const prev = out[out.length - 1];
    if (prev && prev.role === t.role) prev.content += `\n\n${text}`;
    else out.push({ role: t.role, content: text.slice(0, 6000) });
  }
  if (out[0]?.role === 'assistant') out.shift();
  return out;
}

/**
 * Otázka v rozhovoru. Smyčka: model si říká o nástroje, dostane výsledky,
 * nakonec napíše odpověď. Nejvýš 10 kol, pak musí odpovědět s tím, co má.
 */
export async function ask(chatId: string | null, question: string, scope = 'all'): Promise<AdsChatReply> {
  const q = String(question ?? '').trim();
  if (!q) throw new Error('Napiš otázku.');
  const conv = chats.startChat(chatId, q);
  const s = getSettings();
  const model = s.insightModel || s.draftModel;
  const messages: any[] = [...historyMessages(conv.turns), { role: 'user', content: q }];
  const run: ToolRun = { proposals: [], notes: [], question: q, scope };
  const steps: string[] = [];
  let answer = '';
  for (let round = 0; round < 10; round++) {
    const last = round === 9;
    const res = await create({
      model, max_tokens: 4000, system: systemPrompt(scope), tools: TOOLS, messages,
      ...(last ? { tool_choice: { type: 'none' } } : {})
    });
    recordUsage(model, res.usage as any);
    const uses = (res.content ?? []).filter((b: any) => b.type === 'tool_use');
    if (res.stop_reason !== 'tool_use' || !uses.length) {
      answer = (res.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim();
      break;
    }
    messages.push({ role: 'assistant', content: res.content });
    const results: any[] = [];
    for (const u of uses) {
      const label = STEP_LABEL[u.name] ?? u.name;
      steps.push(label);
      emitStep(conv.id, label);
      let out: unknown;
      try { out = runTool(u.name, u.input, run); } catch (err: any) { out = { chyba: String(err?.message ?? err) }; }
      let text = JSON.stringify(out);
      if (text.length > 24_000) text = `${text.slice(0, 24_000)}… (zkráceno — zužte dotaz filtrem nebo limitem)`;
      results.push({ type: 'tool_result', tool_use_id: u.id, content: text });
    }
    messages.push({ role: 'user', content: results });
  }
  if (!answer) answer = 'Odpověď nepřišla — zkus otázku položit jinak.';
  const at = new Date().toISOString();
  const turns: AdsChatTurn[] = [
    ...conv.turns,
    { role: 'user', text: q, at },
    { role: 'assistant', text: answer, proposals: run.proposals, notes: run.notes, steps: [...new Set(steps)], at }
  ];
  const saved = chats.saveChat(conv, turns);
  if (run.proposals.length) {
    for (const w of BrowserWindow.getAllWindows()) { try { w.webContents.send('ads:changed', { proposals: run.proposals.length }); } catch { /* */ } }
  }
  return { chat: saved, answer, proposals: run.proposals, notes: run.notes };
}
