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
import { DEFAULT_ADS_CONFIG, AdsConfig, AdsSystem } from '../../shared/ads';
import type { CampaignInfo, DayRow } from './google';

const CONFIG_KEY = 'adsConfig';

/* ---------- nastavení ---------- */

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
    autonomy: ['suggest', 'guarded', 'full'].includes(src.autonomy) ? src.autonomy : base.autonomy,
    google: { ...base.google, ...(src.google && typeof src.google === 'object' ? src.google : {}) },
    feedToken: typeof src.feedToken === 'string' ? src.feedToken : '',
    updatedAt: typeof src.updatedAt === 'string' ? src.updatedAt : ''
  };
}

export function getAdsConfig(): AdsConfig {
  let raw: any = null;
  try { raw = JSON.parse(getSetting(CONFIG_KEY, '') || 'null'); } catch { raw = null; }
  const cfg = normalizeConfig(raw);
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
    updatedAt: new Date().toISOString()
  });
  setSetting(CONFIG_KEY, JSON.stringify(next));
  shareConfigSoon();
  return next;
}

/* ---------- statistiky ---------- */

export function saveCampaigns(system: AdsSystem, list: CampaignInfo[], at: string): void {
  const d = getDb();
  const up = d.prepare(`
    INSERT INTO ads_campaigns (system, id, name, type, status, budget, bidding, target_roas, updated_at)
    VALUES (@system, @id, @name, @type, @status, @budget, @bidding, @targetRoas, @at)
    ON CONFLICT(system, id) DO UPDATE SET
      name = excluded.name, type = excluded.type, status = excluded.status, budget = excluded.budget,
      bidding = excluded.bidding, target_roas = excluded.target_roas, updated_at = excluded.updated_at
    WHERE excluded.updated_at >= ads_campaigns.updated_at
  `);
  d.transaction(() => {
    for (const one of list) up.run({ system, ...one, at });
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
  table: 'ads_campaign_day' | 'ads_product_day',
  system: AdsSystem,
  from: string,
  to: string,
  rows: DayRow[],
  at: string
): void {
  const d = getDb();
  const key = table === 'ads_campaign_day' ? 'campaign_id' : 'item_id';
  const del = d.prepare(`DELETE FROM ${table} WHERE system = ? AND date BETWEEN ? AND ?`);
  const ins = d.prepare(`
    INSERT OR REPLACE INTO ${table} (system, date, ${key}, cost, clicks, impressions, conversions, value, fetched_at)
    VALUES (@system, @date, @id, @cost, @clicks, @impressions, @conversions, @value, @at)
  `);
  d.transaction(() => {
    del.run(system, from, to);
    for (const row of rows) ins.run({ system, ...row, at });
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
  const days = (d.prepare(
    `SELECT date, campaign_id, cost, clicks, impressions, conversions, value, fetched_at
     FROM ads_campaign_day WHERE system = ? AND date LIKE ?`
  ).all(system, like) as any[]).map(r => [r.date, r.campaign_id, r.cost, r.clicks, r.impressions,
    r.conversions, r.value, r.fetched_at]);
  const products = (d.prepare(
    `SELECT date, item_id, cost, clicks, impressions, conversions, value, fetched_at
     FROM ads_product_day WHERE system = ? AND date LIKE ?`
  ).all(system, like) as any[]).map(r => [r.date, r.item_id, r.cost, r.clicks, r.impressions,
    r.conversions, r.value, r.fetched_at]);
  return { days, products };
}

/**
 * Sloučí cizí řádky. Vyhrává novější stažení *celého dne*: kdyby se
 * slučovalo po řádcích, zůstala by v datech kampaň, kterou novější
 * stažení už nemá.
 */
function mergeRows(table: 'ads_campaign_day' | 'ads_product_day', system: AdsSystem, rows: Packed[]): number {
  const d = getDb();
  const key = table === 'ads_campaign_day' ? 'campaign_id' : 'item_id';
  const byDay = new Map<string, Packed[]>();
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 8) continue;
    const list = byDay.get(String(row[0])) ?? [];
    list.push(row);
    byDay.set(String(row[0]), list);
  }
  const mineAt = d.prepare(`SELECT MAX(fetched_at) AS at FROM ${table} WHERE system = ? AND date = ?`);
  const del = d.prepare(`DELETE FROM ${table} WHERE system = ? AND date = ?`);
  const ins = d.prepare(`
    INSERT OR REPLACE INTO ${table} (system, date, ${key}, cost, clicks, impressions, conversions, value, fetched_at)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  let changed = 0;
  d.transaction(() => {
    for (const [day, list] of byDay) {
      const theirs = list.reduce((max, row) => (String(row[7]) > max ? String(row[7]) : max), '');
      const mine = String((mineAt.get(system, day) as any)?.at ?? '');
      if (theirs <= mine) continue;
      del.run(system, day);
      for (const row of list) {
        ins.run(system, day, String(row[1]), Number(row[2]) || 0, Number(row[3]) || 0, Number(row[4]) || 0,
          Number(row[5]) || 0, Number(row[6]) || 0, String(row[7]));
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
    taken += mergeRows('ads_campaign_day', system, Array.isArray(remote.days) ? remote.days : []);
    mergeRows('ads_product_day', system, Array.isArray(remote.products) ? remote.products : []);
    if (Array.isArray(remote.campaigns)) {
      saveCampaigns(system, remote.campaigns, String(remote.campaignsAt ?? ''));
    }
  }

  // 2) Zapsat měsíce, kde jsem novější
  const months = (d.prepare(
    `SELECT DISTINCT substr(date, 1, 7) AS m FROM ads_campaign_day WHERE system = ?
     UNION SELECT DISTINCT substr(date, 1, 7) FROM ads_product_day WHERE system = ?`
  ).all(system, system) as any[]).map(r => String(r.m)).filter(Boolean);
  const campaigns = (d.prepare(
    'SELECT id, name, type, status, budget, bidding, target_roas AS targetRoas, updated_at FROM ads_campaigns WHERE system = ?'
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
