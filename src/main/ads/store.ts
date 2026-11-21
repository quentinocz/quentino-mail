/**
 * Nastavení modulu Reklamy a sdílení mezi Macy.
 *
 * Aplikace běží na třech Macích a v Reklamách se má dát pracovat na
 * kterémkoli z nich, aniž by si přepisovaly práci. Proto:
 *
 *  - **Nastavení** (cíl zisku, náklady dopravy, účet) je jedno pro všechny.
 *    Putuje sdílenou složkou jako `reklamy/nastaveni.json` a novější
 *    razítko vyhrává — stejně jako ostatní nastavení aplikace.
 *  - **Statistiky** z reklamních systémů jdou do `reklamy/google-RRRR-MM.json`
 *    po měsících. Slučují se po řádcích a u každého řádku vyhrává novější
 *    stažení, takže dva Macy, které stáhly totéž, se nepohádají. Měsíční
 *    soubory znamenají, že se v iCloudu přepisuje jen ten letošní, ne celá
 *    historie.
 *  - **Přihlášení ke Googlu** zůstává v klíčence každého Macu. Stačí ho mít
 *    na jednom: ostatní si data vezmou ze sdílené složky.
 *  - **Noční běh** zapíše, kdo ho udělal (`reklamy/beh.json`). Mac, který
 *    se probudí později, ho podle toho nezopakuje.
 *
 * Bez zapnuté synchronizace modul funguje dál, jen každý Mac sám za sebe.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getDb, getSetting, setSetting } from '../db';
import { DEFAULT_ADS_CONFIG, AdsConfig, AdsSystem, AdsAccount } from '../../shared/ads';
import type { CampaignInfo, DayRow } from './google';

const CONFIG_KEY = 'adsConfig';

/* ---------- nastavení ---------- */

/** Druhy návrhů, které autopilot smí dělat — nastavit cíl ROAS poprvé (roas-set) vždy jen člověk */
const AUTOPILOT_KINDS = ['budget-up', 'budget-down', 'negatives', 'exclude', 'roas-up', 'roas-down'];

/**
 * Doplní chybějící klíče z výchozího nastavení. Nastavení uložené starší
 * verzí nemá všechny klíče a `undefined` v cíli zisku by tiše rozbil
 * každý výpočet.
 */
export function normalizeConfig(raw: any): AdsConfig {
  const base = DEFAULT_ADS_CONFIG;
  const src = raw && typeof raw === 'object' ? raw : {};
  const numIn = (value: unknown, min: number, max: number, fallback: number) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  return {
    targetProfitShare: numIn(src.targetProfitShare, 0, 0.95, base.targetProfitShare),
    convValueWithVat: src.convValueWithVat !== undefined ? !!src.convValueWithVat : base.convValueWithVat,
    vat: { ...base.vat, ...(src.vat && typeof src.vat === 'object' ? src.vat : {}) },
    eurRate: numIn(src.eurRate, 1, 100, base.eurRate),
    markets: Array.isArray(src.markets) && src.markets.length
      ? src.markets.map((one: unknown) => String(one).toLowerCase()) : [...base.markets],
    shipping: Array.isArray(src.shipping)
      ? src.shipping
        .filter((one: any) => one && String(one.name ?? '').trim())
        .map((one: any) => ({
          name: String(one.name).trim(),
          cost: numIn(one.cost, 0, 10_000, base.defaultShipCost),
          guessed: !!one.guessed
        }))
      : [],
    defaultShipCost: numIn(src.defaultShipCost, 0, 10_000, base.defaultShipCost),
    fallbackMargin: numIn(src.fallbackMargin, 0, 0.95, base.fallbackMargin),
    autonomy: ['suggest', 'guarded'].includes(src.autonomy) ? src.autonomy : base.autonomy,
    autopilot: {
      kinds: Array.isArray(src.autopilot?.kinds)
        ? src.autopilot.kinds.filter((k: string) => AUTOPILOT_KINDS.includes(k))
        : base.autopilot.kinds,
      maxPerNight: Math.round(numIn(src.autopilot?.maxPerNight, 1, 10, base.autopilot.maxPerNight)),
      minConfidence: Math.round(numIn(src.autopilot?.minConfidence, 1, 4, base.autopilot.minConfidence)),
      seasonPlans: src.autopilot?.seasonPlans == null ? base.autopilot.seasonPlans : !!src.autopilot.seasonPlans,
      pausedAt: String(src.autopilot?.pausedAt ?? ''),
      pausedReason: String(src.autopilot?.pausedReason ?? '')
    },
    sklik: {
      enabled: !!src.sklik?.enabled,
      userId: String(src.sklik?.userId ?? '').replace(/\D/g, ''),
      name: String(src.sklik?.name ?? 'Sklik') || 'Sklik'
    },
    guards: (() => {
      const g = src.guards && typeof src.guards === 'object' ? src.guards : {};
      const b = base.guards;
      return {
        maxBudgetStep: numIn(g.maxBudgetStep, 0.05, 0.5, b.maxBudgetStep),
        maxRoasStep: numIn(g.maxRoasStep, 0.05, 0.3, b.maxRoasStep),
        cooldownDays: numIn(g.cooldownDays, 1, 30, b.cooldownDays),
        minConversions: numIn(g.minConversions, 5, 200, b.minConversions),
        monthlyBudget: numIn(g.monthlyBudget, 0, 10_000_000, b.monthlyBudget)
      };
    })(),
    google: (() => {
      const g = { ...base.google, ...(src.google && typeof src.google === 'object' ? src.google : {}) };
      let accounts: AdsAccount[] = Array.isArray(g.accounts)
        ? g.accounts
          .filter((one: any) => one && String(one.id ?? '').replace(/\D/g, ''))
          .map((one: any) => ({
            id: String(one.id).replace(/\D/g, ''),
            name: String(one.name ?? ''),
            currency: String(one.currency ?? 'CZK') || 'CZK',
            market: ['cz', 'sk', 'en'].includes(one.market) ? one.market : 'cz',
            enabled: one.enabled !== false
          }))
        : [];
      /*
       * Nastavení z doby, kdy šel vybrat jen jeden účet: ten se stane
       * prvním účtem českého trhu, aby se nic nemuselo vybírat znovu.
       */
      if (!accounts.length && String(g.customerId ?? '').replace(/\D/g, '')) {
        accounts = [{
          id: String(g.customerId).replace(/\D/g, ''), name: String(g.customerName ?? ''),
          currency: String(g.currency ?? 'CZK') || 'CZK', market: 'cz', enabled: true
        }];
      }
      // Stejný účet dvakrát by stáhl a sečetl totéž dvakrát
      const seen = new Set<string>();
      accounts = accounts.filter(one => (seen.has(one.id) ? false : (seen.add(one.id), true)));
      return { ...g, accounts };
    })(),
    feedToken: typeof src.feedToken === 'string' ? src.feedToken : '',
    updatedAt: typeof src.updatedAt === 'string' ? src.updatedAt : ''
  };
}

/**
 * Trh zapnutého účtu se sleduje vždycky — účet pro Slovensko bez
 * slovenských objednávek by ukazoval jen náklady a žádný zisk.
 */
function withAccountMarkets(cfg: AdsConfig): AdsConfig {
  const extra = cfg.google.accounts.filter(a => a.enabled).map(a => a.market)
    .concat(cfg.sklik.enabled ? ['cz'] : [])
    .filter((m, i, all) => !cfg.markets.includes(m) && all.indexOf(m) === i);
  return extra.length ? { ...cfg, markets: [...cfg.markets, ...extra] } : cfg;
}

export function getAdsConfig(): AdsConfig {
  let raw: any = null;
  try { raw = JSON.parse(getSetting(CONFIG_KEY, '') || 'null'); } catch { raw = null; }
  const cfg = withAccountMarkets(normalizeConfig(raw));
  /*
   * Adresa doplňkového feedu musí být neuhodnutelná a stejná na všech
   * Macích. Razítko se při tom NEposouvá: čerstvě zapnutý Mac by jinak měl
   * „nejnovější" nastavení a přepsal by ve sdílené složce cíle a dopravy,
   * které ostatní Macy nastavily, výchozími hodnotami. S prázdným razítkem
   * vyhraje cokoli, co už ve složce je — i cizí adresa feedu.
   */
  if (!cfg.feedToken) {
    cfg.feedToken = crypto.randomBytes(12).toString('hex');
    writeLocal(cfg);
  }
  return cfg;
}

/** Zápis bez posunutí razítka — pro věci, které aplikace doplnila sama. */
export function writeLocal(cfg: AdsConfig): void {
  setSetting(CONFIG_KEY, JSON.stringify(cfg));
}

export function saveAdsConfig(patch: Partial<AdsConfig>): AdsConfig {
  const current = getAdsConfig();
  const next = normalizeConfig({
    ...current,
    ...patch,
    google: { ...current.google, ...(patch.google ?? {}) },
    vat: { ...current.vat, ...(patch.vat ?? {}) },
    guards: { ...current.guards, ...(patch.guards ?? {}) },
    updatedAt: new Date().toISOString()
  });
  setSetting(CONFIG_KEY, JSON.stringify(next));
  shareConfigSoon();
  return next;
}

/* ---------- účty ---------- */

/** Zapnuté účty Google Ads */
export function activeAccounts(cfg: AdsConfig): AdsAccount[] {
  return cfg.google.accounts.filter(one => one.enabled);
}

/**
 * Účet řádku. Prázdné číslo mají data z doby, kdy byl účet jen jeden —
 * patří prvnímu účtu (to je ten, který byl tehdy vybraný).
 */
export function accountInfo(cfg: AdsConfig, id: string): AdsAccount {
  // Sklik je jeden účet českého trhu v korunách
  if (id === 'sklik') {
    return { id: 'sklik', name: cfg.sklik.name || 'Sklik', currency: 'CZK', market: 'cz', enabled: cfg.sklik.enabled };
  }
  const clean = String(id ?? '').replace(/\D/g, '');
  return cfg.google.accounts.find(one => one.id === clean)
    ?? cfg.google.accounts[0]
    ?? { id: clean, name: '', currency: cfg.google.currency || 'CZK', market: 'cz', enabled: true };
}

/** Částka v měně účtu → Kč */
export function accountCzk(cfg: AdsConfig, account: AdsAccount, amount: number): number {
  return /eur/i.test(account.currency) ? amount * cfg.eurRate : amount;
}

/**
 * Hodnota konverze z účtu → Kč bez DPH. DPH podle trhu účtu: slovenský
 * účet posílá hodnotu se slovenskou DPH, ne s českou.
 */
export function accountValue(cfg: AdsConfig, account: AdsAccount, value: number): number {
  const czk = accountCzk(cfg, account, value);
  return cfg.convValueWithVat ? czk / (1 + (cfg.vat[account.market] ?? 21) / 100) : czk;
}

/**
 * Data o produktech z doby jednoho účtu se jednou přelijí do tabulky
 * s účtem. Stará tabulka neměla účet v klíči, takže český a slovenský
 * výkon téhož produktu by se v ní přepsaly.
 */
export function migrateItems(cfg: AdsConfig): void {
  if (getSetting('adsItemsMigrated', '') === '1') return;
  const d = getDb();
  const primary = cfg.google.accounts[0]?.id ?? '';
  try {
    d.transaction(() => {
      d.prepare(`INSERT OR IGNORE INTO ads_item_day (system, account, date, item_id, cost, clicks, impressions,
          conversions, value, fetched_at)
        SELECT system, ?, date, item_id, cost, clicks, impressions, conversions, value, fetched_at FROM ads_product_day`)
        .run(primary);
      d.prepare('DELETE FROM ads_product_day').run();
      // Řádky bez účtu dostanou ten, ke kterému tehdy patřily
      if (primary) {
        d.prepare("UPDATE ads_campaigns SET account = ? WHERE account = ''").run(primary);
        d.prepare("UPDATE ads_campaign_day SET account = ? WHERE account = ''").run(primary);
        d.prepare("UPDATE ads_search_terms SET account = ? WHERE account = ''").run(primary);
      }
    })();
    setSetting('adsItemsMigrated', '1');
  } catch { /* zkusí se příště */ }
}

/* ---------- statistiky ---------- */

export function saveCampaigns(system: AdsSystem, list: (CampaignInfo & { account?: string })[], at: string, account = ''): void {
  const d = getDb();
  const up = d.prepare(`
    INSERT INTO ads_campaigns (system, id, name, type, status, budget, bidding, target_roas, updated_at,
      budget_id, budget_shared, limited, account)
    VALUES (@system, @id, @name, @type, @status, @budget, @bidding, @targetRoas, @at,
      @budgetId, @budgetShared, @limited, @account)
    ON CONFLICT(system, id) DO UPDATE SET
      name = excluded.name, type = excluded.type, status = excluded.status, budget = excluded.budget,
      bidding = excluded.bidding, target_roas = excluded.target_roas, updated_at = excluded.updated_at,
      budget_id = excluded.budget_id, budget_shared = excluded.budget_shared, limited = excluded.limited,
      account = excluded.account
    WHERE excluded.updated_at >= ads_campaigns.updated_at
  `);
  d.transaction(() => {
    for (const one of list) {
      up.run({
        system, id: one.id, name: one.name, type: one.type, status: one.status, budget: one.budget,
        bidding: one.bidding, targetRoas: one.targetRoas, at,
        budgetId: one.budgetId ?? '', budgetShared: one.budgetShared ? 1 : 0, limited: one.limited ? 1 : 0,
        account: one.account ?? account
      });
    }
  })();
}

/**
 * Zapíše dny z jednoho stažení.
 *
 * Řádek, který v novém stažení chybí, se v daném rozsahu smaže: Google
 * vrací jen dny se zobrazeními, a kdyby kampaň zpětně „zmizela" (třeba
 * přepočtená neplatná kliknutí), zůstalo by u ní staré číslo navždy.
 */
export function saveDays(
  table: 'ads_campaign_day' | 'ads_item_day',
  system: AdsSystem,
  from: string,
  to: string,
  rows: DayRow[],
  at: string,
  account = ''
): void {
  const d = getDb();
  const key = table === 'ads_campaign_day' ? 'campaign_id' : 'item_id';
  // Maže se jen tenhle účet — stažení slovenského účtu nesmí smazat český
  const del = d.prepare(`DELETE FROM ${table} WHERE system = ? AND account = ? AND date BETWEEN ? AND ?`);
  const ins = d.prepare(`
    INSERT OR REPLACE INTO ${table} (system, account, date, ${key}, cost, clicks, impressions, conversions, value, fetched_at)
    VALUES (@system, @account, @date, @id, @cost, @clicks, @impressions, @conversions, @value, @at)
  `);
  d.transaction(() => {
    del.run(system, account, from, to);
    for (const row of rows) ins.run({ system, account, ...row, at });
  })();
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

export function isShared(): boolean {
  return sharedDir() !== null;
}

/** Zápis přes dočasný soubor — druhý Mac nesmí číst rozepsaný soubor. */
function writeJson(file: string, data: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
  fs.renameSync(tmp, file);
}

function readJson(file: string): any {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

let configTimer: NodeJS.Timeout | null = null;
function shareConfigSoon(): void {
  if (configTimer) clearTimeout(configTimer);
  configTimer = setTimeout(() => { configTimer = null; try { syncConfig(); } catch { /* příště */ } }, 1500);
}

/** Nastavení: novější vyhrává. Vrací true, když se převzalo cizí. */
export function syncConfig(): boolean {
  const dir = sharedDir();
  if (!dir) return false;
  const file = path.join(dir, 'nastaveni.json');
  const remote = readJson(file);
  const mine = getAdsConfig();
  const remoteCfg = remote?.config ? normalizeConfig(remote.config) : null;
  if (remoteCfg && remoteCfg.updatedAt > mine.updatedAt) {
    setSetting(CONFIG_KEY, JSON.stringify(remoteCfg));
    return true;
  }
  if (!remoteCfg || mine.updatedAt > remoteCfg.updatedAt) {
    writeJson(file, { app: 'quentino-reklamy', config: mine });
  }
  return false;
}

type Packed = (string | number)[];

/**
 * Statistiky po měsících. Řádek = pole, ne objekt: měsíc produktů má
 * tisíce řádků a názvy klíčů by soubor zdvojnásobily.
 */
function packMonth(system: AdsSystem, month: string) {
  const d = getDb();
  const like = `${month}-%`;
  // Účet je na konci řádku: starší soubory ho nemají a čtou se jako hlavní účet
  const days = (d.prepare(
    `SELECT date, campaign_id, cost, clicks, impressions, conversions, value, fetched_at, account
     FROM ads_campaign_day WHERE system = ? AND date LIKE ?`
  ).all(system, like) as any[]).map(r => [r.date, r.campaign_id, r.cost, r.clicks, r.impressions,
    r.conversions, r.value, r.fetched_at, r.account]);
  const products = (d.prepare(
    `SELECT date, item_id, cost, clicks, impressions, conversions, value, fetched_at, account
     FROM ads_item_day WHERE system = ? AND date LIKE ?`
  ).all(system, like) as any[]).map(r => [r.date, r.item_id, r.cost, r.clicks, r.impressions,
    r.conversions, r.value, r.fetched_at, r.account]);
  return { days, products };
}

/**
 * Sloučí cizí řádky. Vyhrává novější stažení *celého dne*: kdyby se
 * slučovalo po řádcích, zůstala by v datech kampaň, kterou novější
 * stažení už nemá.
 */
function mergeRows(table: 'ads_campaign_day' | 'ads_item_day', system: AdsSystem, rows: Packed[], primary: string): number {
  const d = getDb();
  const key = table === 'ads_campaign_day' ? 'campaign_id' : 'item_id';
  // Slučuje se po dnech a účtech: novější stažení slovenského účtu nesmí smazat český den
  const byDay = new Map<string, { day: string; account: string; list: Packed[] }>();
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 8) continue;
    const account = String(row[8] ?? '') || primary;
    const k = `${row[0]}|${account}`;
    const one = byDay.get(k) ?? { day: String(row[0]), account, list: [] };
    one.list.push(row);
    byDay.set(k, one);
  }
  const mineAt = d.prepare(`SELECT MAX(fetched_at) AS at FROM ${table} WHERE system = ? AND date = ? AND account = ?`);
  const del = d.prepare(`DELETE FROM ${table} WHERE system = ? AND date = ? AND account = ?`);
  const ins = d.prepare(`
    INSERT OR REPLACE INTO ${table} (system, date, ${key}, cost, clicks, impressions, conversions, value, fetched_at, account)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  let changed = 0;
  d.transaction(() => {
    for (const { day, account, list } of byDay.values()) {
      const theirs = list.reduce((max, row) => (String(row[7]) > max ? String(row[7]) : max), '');
      const mine = String((mineAt.get(system, day, account) as any)?.at ?? '');
      if (theirs <= mine) continue;
      del.run(system, day, account);
      for (const row of list) {
        ins.run(system, day, String(row[1]), Number(row[2]) || 0, Number(row[3]) || 0, Number(row[4]) || 0,
          Number(row[5]) || 0, Number(row[6]) || 0, String(row[7]), account);
      }
      changed++;
    }
  })();
  return changed;
}

/** Poslední stažení v měsíci — podle něj se pozná, kdo má novější data. */
function newest(rows: Packed[]): string {
  return rows.reduce((max, row) => (String(row[7]) > max ? String(row[7]) : max), '');
}

/**
 * Statistiky: přečte cizí měsíce a zapíše ty, ve kterých má tenhle Mac
 * něco novějšího. Vrací počet převzatých dnů.
 */
export function syncStats(system: AdsSystem = 'google'): number {
  const dir = sharedDir();
  if (!dir) return 0;
  const d = getDb();
  let taken = 0;

  // 1) Převzít, co mají jiné Macy
  const prefix = `${system}-`;
  let files: string[] = [];
  try { files = fs.readdirSync(dir).filter(name => name.startsWith(prefix) && /\d{4}-\d{2}\.json$/.test(name)); }
  catch { files = []; }
  for (const name of files) {
    const remote = readJson(path.join(dir, name));
    if (!remote) continue;
    const primary = getAdsConfig().google.accounts[0]?.id ?? '';
    taken += mergeRows('ads_campaign_day', system, Array.isArray(remote.days) ? remote.days : [], primary);
    mergeRows('ads_item_day', system, Array.isArray(remote.products) ? remote.products : [], primary);
    if (Array.isArray(remote.campaigns)) {
      saveCampaigns(system, remote.campaigns, String(remote.campaignsAt ?? ''));
    }
  }

  // 2) Zapsat měsíce, kde jsem novější
  const months = (d.prepare(
    `SELECT DISTINCT substr(date, 1, 7) AS m FROM ads_campaign_day WHERE system = ?
     UNION SELECT DISTINCT substr(date, 1, 7) FROM ads_item_day WHERE system = ?`
  ).all(system, system) as any[]).map(r => String(r.m)).filter(Boolean);
  const campaigns = (d.prepare(
    `SELECT id, name, type, status, budget, bidding, target_roas AS targetRoas, updated_at,
       budget_id AS budgetId, budget_shared AS budgetShared, limited, account FROM ads_campaigns WHERE system = ?`
  ).all(system) as any[]);
  const campaignsAt = campaigns.reduce((max, one) => (one.updated_at > max ? one.updated_at : max), '');
  const latestMonth = months.sort().slice(-1)[0];
  for (const month of months) {
    const file = path.join(dir, `${system}-${month}.json`);
    const remote = readJson(file);
    const mine = packMonth(system, month);
    const mineAt = newest([...mine.days, ...mine.products]);
    const theirAt = newest([...(remote?.days ?? []), ...(remote?.products ?? [])]);
    if (mineAt > theirAt) {
      writeJson(file, {
        app: 'quentino-reklamy', system, month, ...mine,
        // Seznam kampaní stačí u nejnovějšího měsíce
        ...(month === latestMonth
          ? { campaigns: campaigns.map(({ updated_at, ...one }) => one), campaignsAt } : {})
      });
    }
  }
  return taken;
}

export interface RunMark {
  day: string;
  device: string;
  finishedAt: string;
  result: string;
  error: string;
}

/** Poslední noční běh podle sdílené složky (nebo tohoto Macu). */
export function lastRun(): RunMark | null {
  const dir = sharedDir();
  const shared = dir ? readJson(path.join(dir, 'beh.json')) : null;
  const local = getDb().prepare(
    'SELECT day, device, finished_at AS finishedAt, result, error FROM ads_runs ORDER BY day DESC LIMIT 1'
  ).get() as RunMark | undefined;
  const candidates = [shared, local].filter(one => one && one.day) as RunMark[];
  if (!candidates.length) return null;
  return candidates.sort((a, b) => (`${b.day}${b.finishedAt}`).localeCompare(`${a.day}${a.finishedAt}`))[0];
}

export function markRun(mark: RunMark): void {
  getDb().prepare(`
    INSERT INTO ads_runs (day, started_at, finished_at, device, result, error)
    VALUES (@day, @finishedAt, @finishedAt, @device, @result, @error)
    ON CONFLICT(day) DO UPDATE SET finished_at = excluded.finished_at, device = excluded.device,
      result = excluded.result, error = excluded.error
  `).run(mark);
  const dir = sharedDir();
  if (dir && !mark.error) writeJson(path.join(dir, 'beh.json'), mark);
}
