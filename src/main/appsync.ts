import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { app, BrowserWindow } from 'electron';
import { getDb, getSetting, setSetting } from './db';
import { getSettings, saveSettings, listKnowledge, listPersons } from './settings';
import { mergeStockin, stockinExport } from './stockin';
import { listAccounts } from './accounts';
import { storeParsedMessage } from './imap';
import { deviceId, deviceLabel } from './device';
import { claimAll } from './vouchers';
import * as live from './live';

/**
 * Synchronizace mezi zařízeními přes sdílenou složku (Dropbox, OneDrive, Google Drive,
 * Syncthing, NAS…). Záměrně se nesynchronizuje živá SQLite databáze — místo toho:
 *  - state.json  — nastavení, pravidla, znalosti, osoby; novější stav vyhrává (razítko)
 *  - contacts.json — našeptávač adres; slučuje se sjednocením (nikdy nic neztratí)
 *  - archive/    — archivované zprávy jako .eml; pouze se přidávají, takže nekolidují
 * Hesla účtů a Anthropic API klíč se ze zásady NEsynchronizují.
 */

function emit(channel: string, payload: unknown) {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload);
}

export interface SyncConfig {
  folder: string | null;
  enabled: boolean;
  lastRun: string | null;
  lastResult: string | null;
}

export function getSyncConfig(): SyncConfig {
  return {
    folder: getSetting('syncFolder'),
    enabled: getSetting('syncEnabled', '0') === '1',
    lastRun: getSetting('syncLastRun'),
    lastResult: getSetting('syncLastResult')
  };
}

export function saveSyncConfig(cfg: { folder?: string | null; enabled?: boolean }): SyncConfig {
  if (cfg.folder !== undefined) setSetting('syncFolder', cfg.folder ?? '');
  if (cfg.enabled !== undefined) setSetting('syncEnabled', cfg.enabled ? '1' : '0');
  if (!getSetting('stateStamp')) setSetting('stateStamp', new Date().toISOString());
  // Nová složka se musí začít hlídat, ta stará přestat
  watchShared();
  return getSyncConfig();
}

const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9@._-]/g, '_').slice(0, 80);
const hash = (s: string) => crypto.createHash('md5').update(s).digest('hex').slice(0, 12);

/**
 * Zápis přes dočasný soubor a přejmenování. Kdyby se psalo rovnou, druhé
 * zařízení by mohlo číst soubor rozepsaný v půlce a považovat ho za pokažený.
 */
function writeJson(file: string, data: unknown): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
  fs.renameSync(tmp, file);
}

/* ---------- Stav (nastavení, znalosti, osoby) ---------- */

function writeState(dir: string, stamp: string) {
  const s = getSettings();
  const persons = listPersons().map(person => {
    let photoFile: string | null = null;
    if (person.photoPath && fs.existsSync(person.photoPath)) {
      photoFile = `${hash(person.name)}-${sanitize(path.basename(person.photoPath))}`;
      const dest = path.join(dir, 'media', photoFile);
      if (!fs.existsSync(dest)) {
        fs.mkdirSync(path.join(dir, 'media'), { recursive: true });
        fs.copyFileSync(person.photoPath, dest);
      }
    }
    return { name: person.name, positions: person.positions, displayNames: person.displayNames, photoFile };
  });
  const defaultPersonName = listPersons().find(x => x.id === s.defaultPersonId)?.name ?? null;
  const state = {
    app: 'quentino-mail-sync',
    version: 1,
    updatedAt: stamp,
    settings: { ...s, hasApiKey: undefined, anthropicApiKey: undefined, defaultPersonId: undefined },
    defaultPersonName,
    knowledge: listKnowledge().map(k => ({ title: k.title, content: k.content })),
    persons
  };
  const tmp = path.join(dir, 'state.json.tmp');
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1), 'utf8');
  fs.renameSync(tmp, path.join(dir, 'state.json'));
}

function applyState(dir: string, remote: any): void {
  const d = getDb();
  // Nastavení (bez klíčů a hesel)
  const { hasApiKey, anthropicApiKey, defaultPersonId, ...rest } = remote.settings ?? {};
  saveSettings(rest);
  // Znalosti — kompletní náhrada novějším stavem
  if (Array.isArray(remote.knowledge)) {
    d.prepare('DELETE FROM knowledge').run();
    const ins = d.prepare('INSERT INTO knowledge (title, content) VALUES (?,?)');
    for (const k of remote.knowledge) if (k?.title) ins.run(k.title, k.content ?? '');
  }
  // Osoby — kompletní náhrada, fotky ze složky media
  if (Array.isArray(remote.persons)) {
    d.prepare('DELETE FROM persons').run();
    const ins = d.prepare(
      'INSERT INTO persons (name, position, position_cz, position_sk, position_en, display_cz, display_sk, display_en, photo_path) VALUES (?,?,?,?,?,?,?,?,?)'
    );
    const photoDir = path.join(app.getPath('userData'), 'persons');
    for (const person of remote.persons) {
      if (!person?.name) continue;
      let photoPath: string | null = null;
      if (person.photoFile) {
        const src = path.join(dir, 'media', person.photoFile);
        if (fs.existsSync(src)) {
          fs.mkdirSync(photoDir, { recursive: true });
          photoPath = path.join(photoDir, person.photoFile);
          if (!fs.existsSync(photoPath)) fs.copyFileSync(src, photoPath);
        }
      }
      const pos = person.positions ?? { cz: '', sk: '', en: '' };
      const dn = person.displayNames ?? { cz: '', sk: '', en: '' };
      ins.run(person.name, pos.cz ?? '', pos.cz ?? '', pos.sk ?? '', pos.en ?? '', dn.cz ?? '', dn.sk ?? '', dn.en ?? '', photoPath);
    }
    // Výchozí osoba dle jména (ID se mezi zařízeními liší)
    if (remote.defaultPersonName) {
      const match = listPersons().find(x => x.name === remote.defaultPersonName);
      setSetting('defaultPersonId', String(match?.id ?? 0));
    }
  }
  // Razítko srovnat s aplikovaným stavem (saveSettings ho posunulo na "teď")
  setSetting('stateStamp', remote.updatedAt);
}

/* ---------- Poukazy: šablony a zásoba kódů ---------- */

/**
 * Poukazy se nesynchronizují jedním společným souborem, ale **složkou
 * deníků**: každé zařízení píše jen do svého `vouchers/<zařízení>.json` a
 * z ostatních jen čte.
 *
 * Důvod je prozaický. Když do jednoho souboru zapisují všichni, cloud při
 * souběžném zápisu jednu verzi zahodí (nebo z ní udělá „konfliktní kopii",
 * které si nikdo nevšimne) — a s ní i to, co měl jen ten jeden. U poukazů to
 * znamená ztracené informace o vydaných kódech, tedy přesně to, co nesmí.
 * Do vlastního souboru nemá kdo zapisovat, takže není co ztratit.
 *
 * Slučuje se po řádcích, ne „novější stav vyhrává":
 *  - šablona: vyhrává novější `updated_at` (i smazání, to je jen příznak),
 *  - vydání kódu: vyhrává vždycky (nikdy se neztratí) a platí dřívější čas,
 *  - rezervace: vyhrává dřívější; při shodě času rozhodne jméno zařízení,
 *    aby obě strany došly k témuž závěru, i když se nevidí,
 *  - vydání dvěma zařízeními: platí to dřívější, to druhé se zapíše jako
 *    kolize a aplikace na ni upozorní.
 *
 * `vouchers.json` ve starém tvaru se pořád čte i píše, aby zařízení se starší
 * verzí aplikace nezůstalo stranou.
 */

interface VoucherJournal {
  device: string;
  name: string;
  updatedAt: string;
  templates: any[];
  codes: any[];
}

/** Jméno zařízení do hlášky o kolizi; když ho neznáme, aspoň zkrácené id. */
function deviceNames(journals: VoucherJournal[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const j of journals) if (j.device) names.set(j.device, j.name || j.device.slice(0, 8));
  return names;
}

/**
 * iCloud umí soubor, do kterého se dlouho nekouklo, z disku uklidit a nechat
 * po něm jen zástupce `.jméno.json.icloud`. Ten se pod původním jménem vůbec
 * nenajde — deník druhého zařízení by tak nikdy nedorazil a vypadalo by to,
 * že se nic nesynchronizuje. Stažení si musí aplikace vyžádat sama; `brctl`
 * je na to systémový nástroj a když chybí (Windows, jiný cloud), nic se
 * neděje — zástupci tam prostě nejsou.
 */
function fetchEvicted(folder: string, names: string[]): void {
  if (process.platform !== 'darwin') return;
  const placeholders = names.filter(f => f.startsWith('.') && f.endsWith('.icloud'));
  if (!placeholders.length) return;
  for (const name of placeholders) {
    try {
      execFile('brctl', ['download', path.join(folder, name)], () => { /* přijde příště */ });
    } catch { /* brctl není — zbývá počkat, až si soubor stáhne systém sám */ }
  }
}

function readJournals(dir: string): VoucherJournal[] {
  const out: VoucherJournal[] = [];
  const folder = path.join(dir, 'vouchers');
  let entries: string[] = [];
  try { entries = fs.readdirSync(folder); } catch { /* první běh */ }
  fetchEvicted(folder, entries);
  const files = entries.filter(f => f.endsWith('.json') && !f.startsWith('.'));
  for (const file of files) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(folder, file), 'utf8'));
      if (j && Array.isArray(j.codes)) out.push(j);
    } catch { /* rozepsaný soubor — přijde příště */ }
  }
  // Starý společný soubor: bere se jako další zdroj, aby se nic neztratilo
  try {
    const legacy = JSON.parse(fs.readFileSync(path.join(dir, 'vouchers.json'), 'utf8'));
    if (legacy && (Array.isArray(legacy.codes) || Array.isArray(legacy.templates))) {
      out.push({ device: '', name: 'starší verze', updatedAt: '', templates: legacy.templates ?? [], codes: legacy.codes ?? [] });
    }
  } catch { /* nikdy nebyl */ }
  return out;
}

/** @returns kolik šablon se skutečně změnilo — podle toho se obnovuje obrazovka */
function mergeTemplates(rows: any[]): number {
  const upsert = getDb().prepare(
    `INSERT INTO voucher_templates (id, name, value, unit, valid_until, note, lang, code_mode, fixed_code, archived, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, value = excluded.value, unit = excluded.unit,
       valid_until = excluded.valid_until, note = excluded.note, lang = excluded.lang,
       code_mode = excluded.code_mode, fixed_code = excluded.fixed_code,
       archived = excluded.archived, updated_at = excluded.updated_at
     WHERE excluded.updated_at > voucher_templates.updated_at`
  );
  let changed = 0;
  for (const t of rows) {
    if (!t?.id || !t?.name) continue;
    changed += upsert.run(
      t.id, t.name, t.value ?? '', t.unit ?? 'CZK', t.valid_until ?? '', t.note ?? '',
      t.lang ?? 'cz', t.code_mode ?? 'fixed', t.fixed_code ?? '', t.archived ?? 0,
      t.updated_at ?? new Date().toISOString()
    ).changes;
  }
  return changed;
}

/** Dřívější rezervace vyhrává; při shodě času rozhodne jméno zařízení. */
function claimWins(atA: string, byA: string, atB: string, byB: string): boolean {
  if (!byB) return false;
  if (!byA) return true;
  if (atB !== atA) return atB < atA;
  return byB < byA;
}

function mergeCodes(rows: any[], names: Map<string, string>): { clashes: number; changed: number } {
  const d = getDb();
  const get = d.prepare('SELECT * FROM voucher_codes WHERE template_id = ? AND code = ?');
  const ins = d.prepare(
    `INSERT INTO voucher_codes (template_id, code, used_at, used_for, used_by, claimed_by, claimed_at, used_dup, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  );
  const upd = d.prepare(
    `UPDATE voucher_codes SET used_at = ?, used_for = ?, used_by = ?, claimed_by = ?, claimed_at = ?, used_dup = ?
     WHERE template_id = ? AND code = ?`
  );
  let clashes = 0;
  let changed = 0;

  for (const c of rows) {
    if (!c?.template_id || !c?.code) continue;
    const local = get.get(c.template_id, c.code) as any;
    if (!local) {
      ins.run(
        c.template_id, c.code, c.used_at ?? null, c.used_for ?? '', c.used_by ?? '',
        c.claimed_by ?? '', c.claimed_at ?? '', c.used_dup ?? '', c.created_at ?? new Date().toISOString()
      );
      if (c.used_dup) clashes++;
      changed++;
      continue;
    }

    let usedAt: string | null = local.used_at ?? null;
    let usedFor: string = local.used_for ?? '';
    let usedBy: string = local.used_by ?? '';
    let dup: string = local.used_dup || c.used_dup || '';

    if (c.used_at) {
      if (!usedAt) {
        usedAt = c.used_at; usedFor = c.used_for ?? ''; usedBy = c.used_by ?? '';
      } else if (usedBy && c.used_by && usedBy !== c.used_by) {
        // Tentýž kód vydala dvě zařízení. Platí dřívější vydání, to druhé se
        // zapíše jako kolize — člověk musí vědět, že poukaz mají dva lidi.
        const remoteFirst = c.used_at < usedAt;
        const loserBy = remoteFirst ? usedBy : c.used_by;
        const loserAt = remoteFirst ? usedAt : c.used_at;
        if (remoteFirst) { usedAt = c.used_at; usedFor = c.used_for ?? ''; usedBy = c.used_by; }
        if (!dup) { dup = `${names.get(loserBy) ?? loserBy.slice(0, 8)}@${loserAt}`; clashes++; }
      } else if (c.used_at < usedAt) {
        usedAt = c.used_at; usedFor = c.used_for ?? ''; usedBy = c.used_by || usedBy;
      }
    }

    // Rezervace řeší jen dosud nevydané kódy — u vydaného už nemá co rozhodovat
    let claimBy: string = local.claimed_by ?? '';
    let claimAt: string = local.claimed_at ?? '';
    if (!usedAt && claimWins(claimAt, claimBy, c.claimed_at ?? '', c.claimed_by ?? '')) {
      claimBy = c.claimed_by; claimAt = c.claimed_at ?? '';
    }
    if (usedAt) { claimBy = usedBy || claimBy; }

    if (usedAt !== (local.used_at ?? null) || usedFor !== (local.used_for ?? '') ||
        usedBy !== (local.used_by ?? '') || claimBy !== (local.claimed_by ?? '') ||
        claimAt !== (local.claimed_at ?? '') || dup !== (local.used_dup ?? '')) {
      upd.run(usedAt, usedFor, usedBy, claimBy, claimAt, dup, c.template_id, c.code);
      changed++;
    }
  }
  return { clashes, changed };
}

/**
 * Otisk toho, co jsme naposledy zapsali do deníku. Bez něj by se soubor
 * přepisoval při každém kole, i když se nic nezměnilo — a cloud by pak měl
 * co dělat s prázdnými změnami místo těch skutečných.
 *
 * Klíčem je zařízení, ne jen jedna hodnota: v běžném provozu má každé
 * zařízení vlastní běh aplikace, ale ve zkouškách běží vedle sebe a otisk
 * jednoho by pak umlčel zápis druhého.
 */
const lastJournal = new Map<string, string>();

function syncVouchers(dir: string): string | null {
  const d = getDb();
  const me = deviceId();
  const journals = readJournals(dir);
  const names = deviceNames(journals);

  let clashes = 0;
  let changed = 0;
  const apply = d.transaction(() => {
    for (const j of journals) {
      if (j.device && j.device === me) continue; // vlastní deník nemá co říct
      changed += mergeTemplates(j.templates ?? []);
      const result = mergeCodes(j.codes ?? [], names);
      clashes += result.clashes;
      changed += result.changed;
    }
  });
  apply();

  // Rezerva na příště se doplní až po sloučení, ať se nezamlouvá kód, který
  // si mezitím zamluvil někdo jiný
  claimAll();

  const templates = d.prepare('SELECT * FROM voucher_templates').all() as any[];
  const codes = d.prepare('SELECT * FROM voucher_codes').all() as any[];
  const body = JSON.stringify({ templates, codes });
  if (body !== lastJournal.get(me)) {
    const out: VoucherJournal = {
      device: me,
      name: deviceLabel(),
      updatedAt: new Date().toISOString(),
      templates,
      codes
    };
    const folder = path.join(dir, 'vouchers');
    fs.mkdirSync(folder, { recursive: true });
    writeJson(path.join(folder, `${me}.json`), out);
    // Pro zařízení se starší verzí aplikace — ta o složce deníků nevědí
    writeJson(path.join(dir, 'vouchers.json'), { templates, codes });
    lastJournal.set(me, body);
  }

  // Otevřená obrazovka s poukazy se dozví, že přibyla šablona nebo ubyl kód,
  // aniž by ji musel člověk zavřít a otevřít
  if (changed) emit('vouchers:changed', {});
  if (clashes) emit('vouchers:clash', {});
  return clashes ? `${clashes}× stejný kód ze dvou zařízení!` : null;
}

/* ---------- Poukazy: rychlá dráha ---------- */

/**
 * Poukazy samotné, mimo velké kolo synchronizace.
 *
 * Velké kolo dělá i archiv, a ten při větší schránce trvá — po tu dobu se
 * nic jiného nesynchronizuje, protože běh je jeden a hlídá si zámek. Nová
 * šablona nebo ubraný kód se tak objevily na druhém zařízení klidně za pár
 * minut. Poukazy proto mají vlastní, krátký běh: přečte cizí deníky, sloučí
 * a zapíše ten svůj. Je to práce se dvěma malými soubory, takže může běžet
 * často a hned po každé změně.
 */
let vouchersRunning = false;

/**
 * Deník poukazů — tentýž tvar, jaký leží ve sdílené složce.
 *
 * Používá ho rychlý posel přes Supabase: druhá strana ho sloučí přesně tím
 * kódem, který by jinak spustila složka, takže není co psát dvakrát.
 */
export function voucherJournal(): VoucherJournal {
  const d = getDb();
  return {
    device: deviceId(),
    name: deviceLabel(),
    updatedAt: new Date().toISOString(),
    templates: d.prepare('SELECT * FROM voucher_templates').all() as any[],
    codes: d.prepare('SELECT * FROM voucher_codes').all() as any[]
  };
}

/**
 * Přijatý deník od druhého zařízení.
 *
 * Slučuje se týmž kódem jako deník ze složky — jediný rozdíl je, že sem
 * dorazil po vteřině místo po minutě. Vlastní deník se zahazuje: co víme,
 * víme.
 *
 * Zpátky se nic neposílá. Kdyby ano, dvě zařízení by si zprávy přehazovala
 * tam a zpět; srovnat zbytek je práce pro složku, která běží tak jako tak.
 */
export function applyVoucherJournal(journal: any): { changed: number; clashes: number } {
  if (!journal || journal.device === deviceId()) return { changed: 0, clashes: 0 };
  const names = deviceNames([journal as VoucherJournal]);

  let changed = 0;
  let clashes = 0;
  getDb().transaction(() => {
    changed += mergeTemplates(journal.templates ?? []);
    const out = mergeCodes(journal.codes ?? [], names);
    changed += out.changed;
    clashes += out.clashes;
  })();

  if (changed) emit('vouchers:changed', {});
  if (clashes) emit('vouchers:clash', {});
  return { changed, clashes };
}

/**
 * Strop na zprávu poslanou po drátě.
 *
 * Broadcast má omezenou velikost a deník roste s počtem kódů. Když se
 * nevejde, prostě se nepošle a doručí ho složka — pomaleji, ale spolehlivě.
 * Mlčky se nic neztrácí.
 */
const MAX_LIVE_JOURNAL = 200_000;

/** Pošle deník poukazů druhému zařízení, pokud se vejde. */
function publishVouchers(): void {
  try {
    const journal = voucherJournal();
    if (JSON.stringify(journal).length > MAX_LIVE_JOURNAL) return;
    live.publish('vouchers', journal);
  } catch { /* posel je jen zkratka, složka doručí */ }
}

export function syncVouchersNow(): void {
  const cfg = getSyncConfig();
  if (!cfg.enabled || !cfg.folder || vouchersRunning) return;
  if (!fs.existsSync(cfg.folder)) return;
  vouchersRunning = true;
  try { syncVouchers(cfg.folder); } catch { /* zkusí se za chvíli znovu */ }
  finally { vouchersRunning = false; }
}

let pushTimer: NodeJS.Timeout | null = null;

/**
 * Odeslat změnu poukazů co nevidět.
 *
 * Odklad je schválně: při vkládání zásoby kódů nebo rychlém klikání by se
 * jinak soubor přepisoval několikrát za sebou. Půl vteřiny stačí, aby se
 * z několika změn stal jeden zápis, a je to pořád „hned".
 */
export function pushVouchersSoon(): void {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    /*
     * Nejdřív po drátě, pak do složky. Posel doručí do vteřiny, kdežto
     * složka podle toho, jak rychle cloud nahraje soubor — a u poukazů
     * na tom záleží: dvě zařízení, která o sobě nevědí, můžou vydat týž
     * kód dvakrát a pozná se to až u zákazníka.
     */
    publishVouchers();
    syncVouchersNow();
  }, 500);
}

/**
 * Hlídání sdílené složky.
 *
 * Kdyby se jen čekalo na další kolo, změna z druhého zařízení by ležela
 * ve složce klidně minutu, než by si jí někdo všiml. Systém přitom umí dát
 * vědět, že se soubor změnil, hned. Na síťové a cloudové složce se na to
 * nedá spolehnout vždycky, proto to není náhrada pravidelného běhu, ale
 * zkratka: když ohlášení přijde, sloučí se hned; když nepřijde, doběhne to
 * v běžném kole.
 */
let watcher: fs.FSWatcher | null = null;
let watchedFolder = '';
let watchTimer: NodeJS.Timeout | null = null;

export function watchShared(): void {
  const folder = getSyncConfig().folder ?? '';
  const dir = folder ? path.join(folder, 'vouchers') : '';
  if (dir === watchedFolder && watcher) return;

  watcher?.close();
  watcher = null;
  watchedFolder = dir;
  if (!dir) return;

  try {
    fs.mkdirSync(dir, { recursive: true });
    watcher = fs.watch(dir, () => {
      // Cloud soubor často uloží nadvakrát; chvilka počkání z toho udělá
      // jedno sloučení místo dvou
      if (watchTimer) clearTimeout(watchTimer);
      watchTimer = setTimeout(() => { watchTimer = null; syncVouchersNow(); }, 700);
    });
    watcher.on('error', () => { watcher?.close(); watcher = null; watchedFolder = ''; });
  } catch {
    // Složka hlídat nejde (síťový disk, práva) — zbude pravidelný běh
    watcher = null;
    watchedFolder = '';
  }
}

/* ---------- Instagram: co už na kterém trhu vyšlo ---------- */

/**
 * Publikace je jednosměrný fakt.
 *
 * Když se reels publikuje na německý trh z počítače, telefon o tom neví a
 * nabízí ho k publikaci znovu. Rozepsané popisky ani odeslané práce se
 * synchronizovat nedají — ty popisují práci na konkrétním zařízení a slévat
 * je by znamenalo hádat, čí verze popisku je ta správná. Zato „tenhle
 * příspěvek na tomhle trhu vyšel" je tvrzení o skutečnosti venku, které
 * platí všude stejně.
 *
 * Proto se slučuje sjednocením a nikdy se nic neruší: co jedno zařízení ví,
 * převezmou ostatní. Při shodě platí **dřívější** čas — první publikace je
 * ta pravá.
 *
 * Klíčem je Instagramové id zdrojového příspěvku, protože místní čísla
 * řádků jsou na každém zařízení jiná.
 */
function syncInstagram(dir: string): void {
  const d = getDb();
  const file = path.join(dir, 'instagram.json');
  let remote: any = null;
  try { remote = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* první běh */ }

  if (remote && Array.isArray(remote.published)) {
    const upsert = d.prepare(
      `INSERT INTO ig_published (source_media_id, lang, at, permalink, ig_media_id)
       VALUES (?,?,?,?,?)
       ON CONFLICT(source_media_id, lang) DO UPDATE SET
         at = CASE WHEN ig_published.at = '' OR excluded.at < ig_published.at
                   THEN excluded.at ELSE ig_published.at END,
         permalink = CASE WHEN ig_published.permalink = ''
                          THEN excluded.permalink ELSE ig_published.permalink END,
         ig_media_id = CASE WHEN ig_published.ig_media_id = ''
                            THEN excluded.ig_media_id ELSE ig_published.ig_media_id END`
    );
    for (const row of remote.published) {
      if (!row?.source_media_id || !row?.lang) continue;
      upsert.run(String(row.source_media_id), String(row.lang).toUpperCase(),
        row.at ?? '', row.permalink ?? '', row.ig_media_id ?? '');
    }
  }

  const out = { published: d.prepare('SELECT * FROM ig_published').all() };
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(out), 'utf8');
  fs.renameSync(tmp, file);
}

/* ---------- Naskladnění (sloučení po řádcích) ---------- */

/**
 * Rozpracované naskladnění z telefonu se musí objevit na počítači.
 *
 * Zboží se počítá u regálu s telefonem v ruce, ale do e-shopu se zapisuje
 * z počítače — okno administrace je jen tam. Naskladnění proto putuje stejnou
 * sdílenou složkou jako poukazy a slučuje se po řádcích, takže je jedno,
 * kdo co přidal dřív.
 */
function syncStockin(dir: string): void {
  const file = path.join(dir, 'stockin.json');
  let remote: any = null;
  try { remote = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* první běh */ }
  if (remote) mergeStockin(remote);

  const out = stockinExport();
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(out), 'utf8');
  fs.renameSync(tmp, file);
}

/* ---------- Kontakty (sjednocení) ---------- */

function syncContacts(dir: string): void {
  const d = getDb();
  const file = path.join(dir, 'contacts.json');
  let remote: any[] = [];
  try { remote = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* první běh */ }
  if (Array.isArray(remote)) {
    const merge = d.prepare(
      `INSERT INTO contacts (email, name, uses, last_used) VALUES (?,?,?,?)
       ON CONFLICT(email) DO UPDATE SET
         uses = MAX(contacts.uses, excluded.uses),
         last_used = MAX(contacts.last_used, excluded.last_used),
         name = CASE WHEN contacts.name = '' THEN excluded.name ELSE contacts.name END`
    );
    for (const c of remote) {
      if (c?.email) merge.run(String(c.email).toLowerCase(), c.name ?? '', c.uses ?? 1, c.last_used ?? new Date().toISOString());
    }
  }
  const all = d.prepare('SELECT email, name, uses, last_used FROM contacts').all();
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(all), 'utf8');
  fs.renameSync(tmp, file);
}

/* ---------- Archiv (.eml, pouze přidávání) ---------- */

function archiveKey(row: any, accountEmail: string): string {
  return row.message_id ? hash(row.message_id) : hash(`${accountEmail}|${row.folder}|${row.uid}`);
}

async function syncArchive(dir: string): Promise<{ exported: number; imported: number }> {
  const d = getDb();
  const archDir = path.join(dir, 'archive');
  fs.mkdirSync(archDir, { recursive: true });
  const known = new Set((d.prepare('SELECT key FROM sync_archive').all() as any[]).map(r => r.key));
  const markKnown = d.prepare('INSERT OR IGNORE INTO sync_archive (key) VALUES (?)');
  const accounts = listAccounts();
  const emailById = new Map(accounts.map(a => [a.id, a.email]));
  let exported = 0;
  let imported = 0;

  // Export: lokálně archivované zprávy, které ještě ve sdílené složce nejsou
  const rows = d.prepare('SELECT * FROM messages WHERE archived = 1 AND raw_path IS NOT NULL').all() as any[];
  for (const row of rows) {
    if (!row.raw_path || !fs.existsSync(row.raw_path)) continue;
    const key = archiveKey(row, emailById.get(row.account_id) ?? '');
    if (known.has(key)) continue;
    const itemDir = path.join(archDir, key);
    fs.mkdirSync(itemDir, { recursive: true });
    fs.copyFileSync(row.raw_path, path.join(itemDir, 'raw.eml'));
    fs.writeFileSync(path.join(itemDir, 'meta.json'), JSON.stringify({
      key,
      messageId: row.message_id,
      accountEmail: emailById.get(row.account_id) ?? '',
      subject: row.subject,
      fromAddr: row.from_addr,
      fromName: row.from_name,
      toAddr: row.to_addr,
      date: row.date,
      category: row.category,
      summary: row.summary
    }), 'utf8');
    markKnown.run(key);
    known.add(key);
    exported++;
  }

  // Import: položky od druhého zařízení, které lokálně nemáme
  if (accounts.length > 0) {
    const localArchiveDir = path.join(app.getPath('userData'), 'archive');
    fs.mkdirSync(localArchiveDir, { recursive: true });
    for (const entry of fs.readdirSync(archDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || known.has(entry.name)) continue;
      const itemDir = path.join(archDir, entry.name);
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(itemDir, 'meta.json'), 'utf8'));
        const eml = fs.readFileSync(path.join(itemDir, 'raw.eml'));
        const account = accounts.find(a => a.email === meta.accountEmail) ?? accounts[0];
        // Duplicitní pojistka podle Message-ID
        if (meta.messageId && d.prepare('SELECT 1 FROM messages WHERE message_id = ? AND archived = 1').get(meta.messageId)) {
          markKnown.run(entry.name);
          known.add(entry.name);
          continue;
        }
        const uid = -Math.abs(Date.now() % 1_000_000_000) - imported; // unikátní záporné UID mimo server
        const info = d.prepare(
          `INSERT INTO messages (account_id, folder, uid, message_id, subject, from_addr, from_name, to_addr, date, snippet, seen, archived, category, summary, thread_key)
           VALUES (?,?,?,?,?,?,?,?,?,'',1,1,?,?,?)`
        ).run(
          account.id, '@archiv', uid, meta.messageId ?? '', meta.subject ?? '', meta.fromAddr ?? '', meta.fromName ?? '',
          meta.toAddr ?? '', meta.date ?? new Date().toISOString(), meta.category ?? null, meta.summary ?? null,
          (meta.messageId ?? entry.name).slice(0, 255)
        );
        const dbId = Number(info.lastInsertRowid);
        const localEml = path.join(localArchiveDir, `${dbId}.eml`);
        fs.writeFileSync(localEml, eml);
        d.prepare('UPDATE messages SET raw_path = ? WHERE id = ?').run(localEml, dbId);
        await storeParsedMessage(dbId, eml);
        markKnown.run(entry.name);
        known.add(entry.name);
        imported++;
      } catch { /* poškozená položka — přeskočit */ }
    }
  }
  return { exported, imported };
}

/* ---------- Hlavní běh ---------- */

let running = false;

export async function runSync(): Promise<string> {
  const cfg = getSyncConfig();
  if (!cfg.enabled || !cfg.folder) return 'Synchronizace není zapnutá.';
  if (running) return 'Synchronizace už běží.';
  if (!fs.existsSync(cfg.folder)) return 'Synchronizační složka není dostupná.';
  running = true;
  try {
    const dir = cfg.folder;
    const parts: string[] = [];

    // 1) Stav — novější vyhrává
    const localStamp = getSetting('stateStamp', '1970-01-01T00:00:00Z')!;
    let remote: any = null;
    try { remote = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')); } catch { /* zatím neexistuje */ }
    if (remote?.app === 'quentino-mail-sync' && remote.updatedAt > localStamp) {
      applyState(dir, remote);
      parts.push('nastavení přijato');
      emit('folders:changed', {});
    } else if (!remote || localStamp > (remote?.updatedAt ?? '')) {
      writeState(dir, localStamp);
      parts.push('nastavení odesláno');
    }

    // 2) Kontakty — sjednocení
    syncContacts(dir);

    // 3) Poukazy — šablony i vydané kódy, po řádcích a přes deníky zařízení
    try {
      const clash = syncVouchers(dir);
      if (clash) parts.push(clash);
    } catch (e: any) {
      parts.push(`poukazy: ${e?.message ?? e}`);
    }

    // 4) Instagram — co už na kterém trhu vyšlo
    try {
      syncInstagram(dir);
    } catch (e: any) {
      parts.push(`Instagram: ${e?.message ?? e}`);
    }

    // 5) Naskladnění — rozpracované naskladnění z telefonu na počítač
    try {
      syncStockin(dir);
      emit('stockin:changed', {});
    } catch (e: any) {
      parts.push(`naskladnění: ${e?.message ?? e}`);
    }

    // 4) Archiv — oboustranné doplnění
    const arch = await syncArchive(dir);
    if (arch.exported) parts.push(`${arch.exported}× archiv odeslán`);
    if (arch.imported) {
      parts.push(`${arch.imported}× archiv přijat`);
      emit('messages:changed', {});
    }

    const summary = parts.length ? parts.join(', ') : 'vše aktuální';
    setSetting('syncLastRun', new Date().toISOString());
    setSetting('syncLastResult', summary);
    return summary;
  } catch (e: any) {
    setSetting('syncLastResult', `chyba: ${e?.message ?? e}`);
    throw e;
  } finally {
    running = false;
  }
}
