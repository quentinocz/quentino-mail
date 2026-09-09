import { BrowserWindow, session, dialog, app, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { PDFDocument } from 'pdf-lib';
import { getDb, getSetting, setSetting } from './db';
import { getUpgatesConfig } from './upgates';
import { adminOrderId } from './ordercard';
import { openUrl } from './formfile';
import { signIn, keepSignedIn } from './portallogin';
import type { InvoiceJob, InvoiceOutcome, InvoiceRun, InvoiceSetup, InvoiceLearned } from '../shared/types';

/**
 * Hromadné stažení faktur z administrace — bez API.
 *
 * Proč stahovat, a ne generovat. Fakturu vystavuje e-shop a je to účetní
 * doklad: číslo, kurz, rekapitulace DPH, QR platba. Kdyby ji aplikace
 * kreslila podle šablon sama, vznikl by druhý zdroj pravdy, který se dřív
 * nebo později rozejde s tím, co má zákazník v mailu a účetní v systému —
 * a poznalo by se to až na kontrole. Stažený PDF je tentýž soubor, jaký
 * odešel zákazníkovi.
 *
 * Proč přes okno administrace a ne přes API. API na faktury má vlastní
 * oprávnění, které tenhle klíč nemusí mít, a hlavně: do administrace se
 * člověk stejně hlásí kvůli naskladnění. Sezení `persist:upgates` je tedy
 * už přihlášené a stahování z něj je jen to, co by dělal ručním klikáním —
 * jen paralelně a bez pěti set kliknutí.
 *
 * Proč se adresa faktury učí a není napsaná v kódu. Nikdo tu adresu nezná
 * dopředu: liší se verzí administrace a v čase se mění. Napevno zadaná by
 * jednou přestala platit a chyba by vypadala jako „faktury nejdou stáhnout".
 * Proto se jednou naučí z toho, jak fakturu otevře sám uživatel, a pak se
 * jen dosazuje číslo. Když se rozbije, naučí se znovu — jedno kliknutí.
 */

const PARTITION = 'persist:upgates';
const TPL_KEY = 'invoiceUrlTemplate';
const PAR_KEY = 'invoiceParallel';
const OPEN_KEY = 'invoiceOpenAfter';
/** Kde se otevírá administrace, když se učí adresa faktury */
const HOME_KEY = 'invoiceAdminHome';
/** Jak se k faktuře jde: přímou adresou, nebo přes detail objednávky */
const MODE_KEY = 'invoiceMode';
/** Adresa detailu objednávky se značkou {id} nebo {code} */
const DETAIL_KEY = 'invoiceDetailUrl';

/* ---------- co se naposledy dělo ---------- */

/**
 * Zápisník pokusů.
 *
 * U Sequelu se ukázalo, že jediná použitelná zpětná vazba u cizího systému
 * je přesný výpis toho, co se zkusilo a co odpovědělo. Bez něj je hlášení
 * „nepovedlo se" slepá ulička; s ním stačí jedno kolo na opravu.
 */
let lastDetail: string[] = [];
function note(line: string): void {
  lastDetail.push(line);
  if (lastDetail.length > 200) lastDetail.shift();
}
export function invoicesLastDetail(): string {
  return lastDetail.join('\n');
}

function emit(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload);
}

/* ---------- nastavení ---------- */

export function invoiceSetup(): InvoiceSetup {
  return {
    template: getSetting(TPL_KEY, '')!,
    adminHome: adminHome(),
    mode: getSetting(MODE_KEY, 'template') === 'detail' ? 'detail' : 'template',
    detailUrl: getSetting(DETAIL_KEY, '')!,
    parallel: Math.min(8, Math.max(1, Number(getSetting(PAR_KEY, '4')) || 4)),
    openAfter: getSetting(OPEN_KEY, '1') !== '0'
  };
}

export function saveInvoiceSetup(next: Partial<InvoiceSetup>): InvoiceSetup {
  if (next.template !== undefined) setSetting(TPL_KEY, next.template.trim());
  if (next.adminHome !== undefined) setSetting(HOME_KEY, next.adminHome.trim());
  if (next.mode !== undefined) setSetting(MODE_KEY, next.mode === 'detail' ? 'detail' : 'template');
  if (next.detailUrl !== undefined) setSetting(DETAIL_KEY, next.detailUrl.trim());
  if (next.parallel !== undefined) setSetting(PAR_KEY, String(Math.min(8, Math.max(1, next.parallel))));
  if (next.openAfter !== undefined) setSetting(OPEN_KEY, next.openAfter ? '1' : '0');
  return invoiceSetup();
}

/* ---------- adresa faktury ---------- */

/**
 * Dosazení do naučené adresy.
 *
 * Zástupné značky jsou tři, protože administrace používá tři různá čísla a
 * dopředu se neví které: číslo faktury, číslo objednávky a vnitřní ID
 * záznamu. Který z nich je v adrese, se pozná při učení.
 */
export function fillTemplate(template: string, job: InvoiceJob): string | null {
  const id = job.adminId ?? null;
  if (template.includes('{id}') && !id) return null;
  if (template.includes('{invoice}') && !job.invoice) return null;
  return template
    .replace(/\{invoice\}/g, encodeURIComponent(job.invoice))
    .replace(/\{invoiceDigits\}/g, job.invoice.replace(/\D/g, ''))
    .replace(/\{code\}/g, encodeURIComponent(job.code))
    .replace(/\{codeDigits\}/g, job.code.replace(/\D/g, ''))
    .replace(/\{id\}/g, String(id ?? ''));
}

/**
 * Z jedné otevřené faktury udělá vzor.
 *
 * V adrese se najdou všechna delší čísla a zkusí se, jestli některé z nich
 * není číslo faktury, číslo objednávky nebo ID záznamu některé ze známých
 * objednávek. To, které sedne, se nahradí značkou. Hádat podle pozice v
 * adrese by nešlo: `/invoice/default/12345/` a `?invoice_id=12345` vypadají
 * úplně jinak, ale číslo je v obou stejné.
 */
export function templateFrom(url: string, known: InvoiceJob[]):
  { template: string; matched: InvoiceJob | null; kind: string; leftovers: string[] } | null {
  const numbers = url.match(/\d{2,}/g) ?? [];
  let template = url;
  let matched: InvoiceJob | null = null;
  const kinds: string[] = [];
  const leftovers: string[] = [];

  /*
   * Nahrazují se **všechna** čísla, která se dají spojit s objednávkou, ne
   * jen první.
   *
   * Adresa faktury v Upgates vypadá takhle:
   *   /orders/edit-order/view-invoice/1185/?invoice_id=1446
   * — dvě různá čísla. První verze nahradila jen to první a `invoice_id`
   * nechala tak, jak bylo. Výsledek: ke každé objednávce se stáhla pořád
   * tatáž faktura. Proto se teď prochází všechna a co se spojit nedá,
   * vrátí se v `leftovers` — s takovou adresou se stahovat nesmí.
   */
  for (const raw of numbers) {
    const bare = raw.replace(/^0+/, '');
    let mark = '';
    for (const job of known) {
      const invoice = job.invoice.replace(/\D/g, '').replace(/^0+/, '');
      const code = job.code.replace(/\D/g, '').replace(/^0+/, '');
      const id = job.adminId ? String(job.adminId) : '';
      // Pořadí je schválně: číslo faktury je nejjistější, ID záznamu
      // nejméně — to se dopočítává z kalibrace a může být posunuté.
      if (invoice && bare === invoice) { mark = '{invoice}'; kinds.push('číslo faktury'); }
      else if (code && bare === code) { mark = '{code}'; kinds.push('číslo objednávky'); }
      else if (id && bare === id) { mark = '{id}'; kinds.push('ID záznamu v administraci'); }
      if (mark) { matched = matched ?? job; break; }
    }
    if (mark) template = swap(template, raw, mark);
    // Rok v adrese ani čísla portu nejsou čísla objednávky — krátká se přeskočí
    else if (raw.length >= 3) leftovers.push(raw);
  }

  if (!matched) return null;
  return { template, matched, kind: kinds.join(' + '), leftovers };
}

/** Nahradí jen ten jeden výskyt čísla, ne všechna stejná čísla v adrese. */
function swap(url: string, needle: string, mark: string): string {
  const at = url.indexOf(needle);
  return at < 0 ? url : url.slice(0, at) + mark + url.slice(at + needle.length);
}

/* ---------- objednávky ke stažení ---------- */

/** Řádky z feedu — číslo faktury má jen ta objednávka, u které už byla vystavená. */
export function jobsFor(codes: string[]): InvoiceJob[] {
  if (codes.length === 0) return [];
  const d = getDb();
  const marks = codes.map(() => '?').join(',');
  const rows = d.prepare(
    `SELECT code, market, invoice, created_at, name FROM shop_orders WHERE code IN (${marks}) ORDER BY invoice, code`
  ).all(...codes) as any[];
  return rows.map(row => ({
    code: String(row.code ?? ''),
    market: String(row.market ?? 'cz'),
    invoice: String(row.invoice ?? ''),
    name: String(row.name ?? ''),
    adminId: adminOrderId(String(row.code ?? ''))
  }));
}

/** Objednávky za období — podklad pro „stáhni faktury za poslední týden". */
export function jobsSince(days: number): InvoiceJob[] {
  const since = new Date(Date.now() - Math.max(1, days) * 86_400_000).toISOString().slice(0, 10);
  const rows = getDb().prepare(
    "SELECT code FROM shop_orders WHERE created_at >= ? AND invoice <> '' ORDER BY created_at"
  ).all(since) as any[];
  return jobsFor(rows.map(row => String(row.code)));
}

/* ---------- stahování ---------- */

export interface Fetched { status: number; type: string; body: Buffer }

/**
 * Stažení jedné adresy přihlášeným sezením.
 *
 * Sezení je to samé, ve kterém je otevřená administrace, takže se posílají
 * její přihlašovací cookies. `session.fetch` navíc jde přes síťovou vrstvu
 * prohlížeče — Node má jinou TLS stopu a ochrana proti robotům na ni umí
 * odpovědět 403, což tenhle projekt už jednou stálo půl dne.
 */
let fetcher: ((url: string) => Promise<Fetched>) | null = null;

async function grab(url: string): Promise<Fetched> {
  if (fetcher) return fetcher(url);
  const ses = session.fromPartition(PARTITION);
  const res = await ses.fetch(url, { redirect: 'follow' });
  const body = Buffer.from(await res.arrayBuffer());
  return { status: res.status, type: String(res.headers.get('content-type') ?? ''), body };
}

/** PDF se pozná podle prvních čtyř bajtů, ne podle hlavičky — ta umí lhát. */
function isPdf(one: Fetched): boolean {
  return one.body.length > 4 && one.body.subarray(0, 4).toString('latin1') === '%PDF';
}

/** Proč to nebyl PDF — přihlášení a chyba serveru se řeší úplně jinak. */
function whyNot(one: Fetched): string {
  const head = one.body.subarray(0, 400).toString('utf8').toLowerCase();
  if (one.status === 401 || one.status === 403) return 'administrace odmítla přístup (nepřihlášeno)';
  if (/<input[^>]+type=["']?password|přihlá|prihla|login/.test(head)) return 'místo faktury přišla přihlašovací stránka';
  if (one.status >= 500) return `administrace vrátila chybu ${one.status}`;
  if (one.status === 404) return 'na téhle adrese faktura není (404)';
  if (one.status >= 400) return `HTTP ${one.status}`;
  return `odpověď není PDF (${one.type || 'bez typu'}, ${one.body.length} B)`;
}

/**
 * Paralelní fronta.
 *
 * Faktur bývá i sto a jedna po druhé je několik minut čekání. Paralelně jich
 * běží jen pár — administrace je cizí server a zahltit ho znamená dostat 429
 * nebo se rovnou odhlásit. Čtyři najednou je kompromis, který se dá v
 * nastavení posunout.
 */
async function pool<T, R>(items: T[], limit: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      out[index] = await work(items[index], index);
    }
  });
  await Promise.all(runners);
  return out;
}

/**
 * Sloučení do jednoho souboru k tisku.
 *
 * Sto samostatných PDF znamená sto otevření a sto tisků. Jeden soubor se
 * vytiskne jednou. Stránky se kopírují tak, jak jsou — včetně rozměru —
 * takže výsledek vypadá stejně jako jednotlivé faktury.
 */
export async function mergePdfs(parts: { name: string; body: Buffer }[]):
  Promise<{ pdf: Buffer; pages: number; bad: { name: string; reason: string }[] }> {
  const merged = await PDFDocument.create();
  merged.setTitle('Faktury Quentino');
  const bad: { name: string; reason: string }[] = [];
  for (const part of parts) {
    try {
      // Některé faktury mají v sobě podpisové pole; `ignoreEncryption` jen
      // říká, ať se kvůli němu nezastaví celá dávka.
      const one = await PDFDocument.load(part.body, { ignoreEncryption: true });
      const pages = await merged.copyPages(one, one.getPageIndices());
      for (const page of pages) merged.addPage(page);
    } catch (error) {
      bad.push({ name: part.name, reason: (error as Error).message });
    }
  }
  const bytes = await merged.save();
  return { pdf: Buffer.from(bytes), pages: merged.getPageCount(), bad };
}

/**
 * Hlavní cesta: z čísel objednávek jeden PDF k tisku.
 *
 * Kroky jdou schválně v tomhle pořadí: nejdřív se ověří jedna faktura, a až
 * když projde, spustí se zbytek. Když je člověk odhlášený, pozná se to na
 * první, ne po sto marných pokusech.
 */
export async function downloadInvoices(codes: string[]): Promise<InvoiceRun> {
  lastDetail = [];
  // O tisk si člověk řekl — i to, co se na pozadí nepovedlo, se zkusí znovu
  skipUntilRestart.clear();
  const setup = invoiceSetup();
  const jobs = jobsFor(codes).filter(job => job.invoice || job.adminId);
  const empty: InvoiceRun = { file: null, ok: 0, pages: 0, failed: [], needsLogin: false, needsTemplate: false };

  if (jobs.length === 0) throw new Error('K vybraným objednávkám není ve feedu žádná faktura.');
  if (!setup.template) return { ...empty, needsTemplate: true };

  /*
   * Adresa se shání až tady, protože v režimu „přes detail" je to dotaz do
   * administrace. Z meziskladu se bere přednostně, takže u stažených faktur
   * se detail neotvírá vůbec.
   */
  const failed: InvoiceOutcome[] = [];
  const ready: { job: InvoiceJob; url: string }[] = [];
  const cached: { job: InvoiceJob; body: Buffer }[] = [];

  for (const job of jobs) {
    const have = fromCache(job);
    if (have) { cached.push({ job, body: have }); continue; }
    const found = await urlFor(job, setup);
    if (found.url) ready.push({ job, url: found.url });
    else if (found.reason === 'nepřihlášeno') return { ...empty, failed, needsLogin: true };
    else failed.push({ code: job.code, invoice: job.invoice, ok: false, pages: 0, reason: found.reason });
  }
  if (ready.length === 0 && cached.length === 0) return { ...empty, failed };

  /*
   * Nejdřív mezisklad. Faktury se stahují na pozadí už při procházení
   * objednávek, takže při tisku jich většina bývá po ruce a čeká se jen na
   * ty zbylé — což je celý smysl toho stahování dopředu.
   */
  const parts: { name: string; body: Buffer }[] = cached
    .map(one => ({ name: one.job.invoice || one.job.code, body: one.body }));
  const todo = ready;
  note(`z meziskladu ${parts.length}, stáhnout ${todo.length}`);

  if (todo.length > 0) {
    // Zkouška na první chybějící faktuře: přihlášení se řeší jednou, ne stokrát
    const first = await grab(todo[0].url).catch(error => ({ status: 0, type: '', body: Buffer.from(String((error as Error).message)) }));
    note(`1. ${todo[0].url} → ${first.status} ${first.type} ${first.body.length} B`);
    if (!isPdf(first)) {
      const reason = whyNot(first);
      note(`   ${reason}`);
      const login = /nepřihlášeno|přihlašovací/.test(reason);
      if (login) return { ...empty, failed, needsLogin: true };
      failed.push({ code: todo[0].job.code, invoice: todo[0].job.invoice, ok: false, pages: 0, reason });
    } else {
      parts.push({ name: todo[0].job.invoice || todo[0].job.code, body: first.body });
      toCache(todo[0].job, first.body);
    }

    let done = 1;
    emit('invoices:progress', { done, total: todo.length, code: todo[0].job.code });

    const got = await pool(todo.slice(1), setup.parallel, async one => {
      let out: Fetched;
      try {
        out = await grab(one.url);
      } catch (error) {
        out = { status: 0, type: '', body: Buffer.from(String((error as Error).message)) };
      }
      done++;
      emit('invoices:progress', { done, total: todo.length, code: one.job.code });
      return { one, out };
    });

    for (const { one, out } of got) {
      if (isPdf(out)) {
        parts.push({ name: one.job.invoice || one.job.code, body: out.body });
        toCache(one.job, out.body);
      } else {
        const reason = whyNot(out);
        note(`× ${one.url} → ${out.status} ${out.type} · ${reason}`);
        failed.push({ code: one.job.code, invoice: one.job.invoice, ok: false, pages: 0, reason });
      }
    }
  }

  if (parts.length === 0) return { ...empty, failed };

  // Pořadí podle čísla faktury: v šanonu i na tiskárně jdou za sebou
  parts.sort((a, b) => a.name.localeCompare(b.name, 'cs', { numeric: true }));

  const merged = await mergePdfs(parts);
  for (const one of merged.bad) {
    failed.push({ code: one.name, invoice: one.name, ok: false, pages: 0, reason: `soubor se nedal otevřít: ${one.reason}` });
  }
  note(`sloučeno ${parts.length - merged.bad.length} faktur, ${merged.pages} stran`);

  const stamp = new Date().toISOString().slice(0, 10);
  const res = await dialog.showSaveDialog(BrowserWindow.getFocusedWindow()!, {
    defaultPath: path.join(app.getPath('downloads'), `faktury-${stamp}.pdf`),
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  });
  if (res.canceled || !res.filePath) return { ...empty, failed };
  fs.writeFileSync(res.filePath, merged.pdf);
  if (setup.openAfter) void shell.openPath(res.filePath);

  return {
    file: res.filePath,
    ok: parts.length - merged.bad.length,
    pages: merged.pages,
    failed,
    needsLogin: false,
    needsTemplate: false
  };
}

/**
 * Číslo v adrese, které k téhle objednávce nepatří.
 *
 * Dívá se jen na cestu a parametry, ne na doménu — v `s19.upgates.com` je
 * číslo taky a nic neznamená. Krátká čísla se přeskakují (verze API, port);
 * jde o čísla dokladů, a ta mají aspoň tři místa.
 */
export function strangeNumber(url: string, job: InvoiceJob): string {
  let tail = url;
  try {
    const parsed = new URL(url);
    tail = `${parsed.pathname}${parsed.search}`;
  } catch { /* není-li to adresa, projde se celá */ }

  const mine = new Set([
    job.invoice, job.invoice.replace(/^0+/, ''),
    job.code, job.code.replace(/^0+/, ''),
    job.adminId ? String(job.adminId) : ''
  ].filter(Boolean));

  for (const raw of tail.match(/\d{3,}/g) ?? []) {
    if (!mine.has(raw) && !mine.has(raw.replace(/^0+/, ''))) return raw;
  }
  return '';
}

/**
 * Odkaz na fakturu v detailu objednávky.
 *
 * Používá se, když adresa faktury nese vnitřní číslo faktury, které se
 * dopočítat nedá (`?invoice_id=1446`). Detail objednávky ten odkaz obsahuje
 * — a je to odkaz **na tuhle** fakturu, takže se nemůže splést s cizí.
 *
 * Hledá se `view-invoice` nebo `invoice_id`; teprve když ani jedno na
 * stránce není, zkusí se cokoli, co vypadá jako faktura. Pořadí je od
 * nejjistějšího k nejmlhavějšímu, protože splést odkaz znamená stáhnout
 * cizí doklad.
 */
export function invoiceHref(html: string, base: string): string {
  const hrefs = [...html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map(one => one[1]);
  const pick = hrefs.find(one => /view-invoice|invoice_id/i.test(one))
    ?? hrefs.find(one => /faktur|invoice/i.test(one) && /pdf|print|tisk|view/i.test(one));
  if (!pick) return '';
  const clean = pick.replace(/&amp;/g, '&');
  try {
    return new URL(clean, base).toString();
  } catch {
    return '';
  }
}

/**
 * Adresa faktury pro jednu objednávku.
 *
 * Buď se dosadí do naučeného vzoru, nebo — když vzor nese cizí číslo — se
 * otevře detail objednávky a odkaz se přečte z něj. Ta druhá cesta stojí
 * jeden dotaz navíc, zato nemůže sáhnout na cizí fakturu.
 */
async function urlFor(job: InvoiceJob, setup: InvoiceSetup): Promise<{ url: string; reason: string }> {
  if (setup.mode !== 'detail') {
    const url = fillTemplate(setup.template, job);
    if (!url) return { url: '', reason: 'chybí číslo, které naučená adresa potřebuje' };
    /*
     * Pojistka proti stažení cizí faktury.
     *
     * Když v adrese zůstane číslo, které k téhle objednávce nepatří —
     * typicky `?invoice_id=1446` z faktury, na které se vzor učil —,
     * přišla by ke všem objednávkám tatáž faktura. Přesně to se stalo:
     * u objednávky 023853 se stáhla faktura 023855. Radši nic než cizí
     * doklad.
     */
    const foreign = strangeNumber(url, job);
    if (foreign) {
      return {
        url: '',
        reason: `naučená adresa nese cizí číslo (${foreign}) — nauč ji znovu, `
          + 'aplikace pak fakturu najde v detailu objednávky'
      };
    }
    return { url, reason: '' };
  }

  const detail = setup.detailUrl ? fillTemplate(setup.detailUrl, job) : '';
  if (!detail) return { url: '', reason: 'není naučená adresa detailu objednávky' };

  let page: Fetched;
  try {
    page = await grab(detail);
  } catch (error) {
    return { url: '', reason: `detail objednávky se nenačetl: ${String((error as Error).message)}` };
  }
  const html = page.body.toString('utf8');
  if (/<input[^>]+type=["']?password/i.test(html)) return { url: '', reason: 'nepřihlášeno' };

  const href = invoiceHref(html, detail);
  note(`detail ${detail} → ${href || 'bez odkazu na fakturu'}`);
  return href
    ? { url: href, reason: '' }
    : { url: '', reason: 'v detailu objednávky není odkaz na fakturu (možná není vystavená)' };
}

/* ---------- zásoba stažených faktur ---------- */

/**
 * Faktury stažené dopředu.
 *
 * Tisk faktur přijde ve chvíli, kdy člověk stojí u tiskárny a chce balit —
 * a tam je čekání na sto stažení nejhorší. Proto se faktury stahují na
 * pozadí už při procházení objednávek: jedna po druhé, pomalu, a když je
 * potřeba tisknout, je většina z nich na disku.
 *
 * Uloženo je to v datech aplikace, ne v Downloads: je to mezisklad, ne
 * výsledek. Starší než měsíc se maže — faktura z loňska se tiskne jednou
 * a držet ji tu není proč.
 */
function cacheDir(): string {
  const dir = path.join(app.getPath('userData'), 'faktury');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Název souboru z čísla faktury — bez lomítek a diakritiky, ať projde všude. */
function cacheFile(job: InvoiceJob): string {
  const name = (job.invoice || job.code).replace(/[^\w-]/g, '_');
  return path.join(cacheDir(), `${name}.pdf`);
}

function fromCache(job: InvoiceJob): Buffer | null {
  try {
    const file = cacheFile(job);
    if (!fs.existsSync(file)) return null;
    const body = fs.readFileSync(file);
    // Poškozený soubor v meziskladu by tiše zkazil celý tisk
    return body.length > 4 && body.subarray(0, 4).toString('latin1') === '%PDF' ? body : null;
  } catch {
    return null;
  }
}

function toCache(job: InvoiceJob, body: Buffer): void {
  try { fs.writeFileSync(cacheFile(job), body); } catch { /* mezisklad je doplněk */ }
}

/** Úklid: co je starší než měsíc, se už tisknout nebude. */
function sweepCache(): void {
  try {
    const dir = cacheDir();
    const old = Date.now() - 30 * 86_400_000;
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      if (fs.statSync(file).mtimeMs < old) fs.rmSync(file, { force: true });
    }
  } catch { /* úklid nesmí nic zastavit */ }
}

let prefetching = false;
/**
 * Faktury, které v tomhle běhu aplikace nešly stáhnout.
 *
 * Bez tohohle seznamu by se objednávka bez faktury zkoušela znovu při
 * každém načtení seznamu — a to je dotaz do cizí administrace zadarmo.
 * Při tisku se zkouší znovu: tam si o to člověk řekl.
 */
const skipUntilRestart = new Set<string>();

/**
 * Stažení dopředu, na pozadí.
 *
 * Tři pravidla, každé kvůli tomu, že se sahá do cizí administrace:
 *
 *  - **jen to, co chybí** — stažené faktury se znovu netahají,
 *  - **po jedné** — na pozadí není kam spěchat a zahltit administraci při
 *    běžné práci by bylo horší než pomalý tisk,
 *  - **odhlášení to zastaví, chybějící faktura ne** — když administrace
 *    chce přihlásit, je dalších sto dotazů zbytečných; ale objednávka, ke
 *    které faktura vystavená není, je běžná věc a zbytek dávky kvůli ní
 *    stát nemá.
 */
export async function prefetchInvoices(codes: string[]): Promise<{ ready: number; fetched: number; stopped: string | null }> {
  const setup = invoiceSetup();
  if (!setup.template || prefetching) return { ready: 0, fetched: 0, stopped: null };

  const jobs = jobsFor(codes).filter(job => job.invoice || job.adminId);
  const missing = jobs.filter(job => !fromCache(job) && !skipUntilRestart.has(job.code));
  const ready = jobs.filter(job => !!fromCache(job)).length;
  if (missing.length === 0) return { ready, fetched: 0, stopped: null };

  prefetching = true;
  let fetched = 0;
  let stopped: string | null = null;
  try {
    sweepCache();
    for (const job of missing) {
      const found = await urlFor(job, setup);
      if (found.reason === 'nepřihlášeno') { stopped = found.reason; break; }
      const url = found.url;
      if (!url) { skipUntilRestart.add(job.code); continue; }
      let out: Fetched;
      try {
        out = await grab(url);
      } catch (error) {
        stopped = String((error as Error).message);
        break;
      }
      if (!isPdf(out)) {
        const reason = whyNot(out);
        // Odhlášení platí pro všechny; chybějící faktura jen pro tuhle jednu
        if (/nepřihlášeno|přihlašovací/.test(reason)) { stopped = reason; break; }
        skipUntilRestart.add(job.code);
        note(`× ${url} → ${reason}`);
        continue;
      }
      toCache(job, out.body);
      fetched++;
      emit('invoices:ready', { ready: ready + fetched, total: jobs.length });
      // Malá pauza mezi dotazy: na pozadí se nespěchá a administrace to pozná
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  } finally {
    prefetching = false;
  }
  if (stopped) note(`stahování dopředu zastaveno: ${stopped}`);
  return { ready: ready + fetched, fetched, stopped };
}

/** Kolik z těch objednávek už má fakturu po ruce — rozhraní to říká u tlačítka. */
export function invoicesReady(codes: string[]): { ready: number; total: number } {
  const jobs = jobsFor(codes).filter(job => job.invoice || job.adminId);
  return { ready: jobs.filter(job => !!fromCache(job)).length, total: jobs.length };
}

/**
 * Kde se administrace otevírá.
 *
 * Ne na hádané cestě: `/manager/orders/` vrátilo 404, protože Upgates má
 * seznam objednávek jinde a názvy stránek se mezi verzemi liší. Kořen
 * administrace existuje vždycky a zbytek je jedno kliknutí — učení stejně
 * čeká na to, až se otevře **jakákoli** faktura.
 */
function adminHome(): string {
  const saved = (getSetting(HOME_KEY, '') ?? '').trim();
  if (saved) return saved;
  const cfg = getUpgatesConfig();
  return `${cfg.url.replace(/\/+$/, '')}/manager/`;
}

/* ---------- učení adresy ---------- */

let learning: BrowserWindow | null = null;

/**
 * Naučení adresy faktury z jednoho otevření.
 *
 * Aplikace se nesnaží uhodnout, kde v administraci faktura je. Otevře okno,
 * uživatel v něm fakturu otevře tak, jak je zvyklý, a aplikace si všimne
 * odpovědi, která je PDF. Z její adresy pak udělá vzor. Je to jediný postup,
 * který přežije změnu administrace: kdyby se odkaz přesunul, naučí se znovu.
 */
export async function learnInvoiceUrl(timeoutMs = 5 * 60_000):
  Promise<InvoiceLearned | { error: string }> {
  lastDetail = [];
  const cfg = getUpgatesConfig();
  if (!cfg.url) return { error: 'Není vyplněná adresa administrace (Nastavení → AI → Upgates).' };

  // Porovnává se s objednávkami z posledního půl roku — starší faktura se
  // otevírá málokdy a dlouhý seznam by jen zpomalil hledání shody.
  const known = jobsSince(180);
  if (known.length === 0) return { error: 'Ve feedu nejsou žádné objednávky s fakturou, není podle čeho adresu poznat.' };

  const ses = session.fromPartition(PARTITION);
  const win = learning && !learning.isDestroyed() ? learning : new BrowserWindow({
    width: 1200, height: 860,
    title: 'Otevři jednu fakturu — adresu si zapamatuju',
    webPreferences: { partition: PARTITION, sandbox: true }
  });
  learning = win;
  win.on('closed', () => { learning = null; });
  keepSignedIn(win, 'upgates');
  await openUrl(win, adminHome());
  win.show();
  win.focus();
  // Když sezení vypršelo, přihlásí se samo — jinak by tu byl jen formulář
  await signIn(win, 'upgates');

  return await new Promise(resolve => {
    let settled = false;
    const finish = (out: InvoiceLearned | { error: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ses.webRequest.onCompleted(null); } catch { /* posluchač už být nemusí */ }
      if (!win.isDestroyed()) win.close();
      resolve(out);
    };

    const timer = setTimeout(
      () => finish({ error: 'Za pět minut se žádná faktura neotevřela. Zkus to znovu a otevři jednu fakturu v PDF.' }),
      timeoutMs
    );
    if (typeof win.once === 'function') {
      win.once('closed', () => finish({ error: 'Okno se zavřelo dřív, než se nějaká faktura otevřela.' }));
    }

    /*
     * Stránka, ze které se faktura otevřela. Je to detail objednávky
     * a právě v něm je odkaz na fakturu i s jejím vnitřním číslem —
     * když se adresa faktury sama dosadit nedá, hledá se odkaz tady.
     */
    let lastPage = '';
    if (typeof win.webContents.on === 'function') {
      win.webContents.on('did-navigate', (_e: unknown, url: string) => { lastPage = url; });
      win.webContents.on('did-navigate-in-page', (_e: unknown, url: string) => { lastPage = url; });
    }

    ses.webRequest.onCompleted({ urls: ['<all_urls>'] }, (details: any) => {
      const type = String(
        Object.entries(details.responseHeaders ?? {})
          .find(([key]) => key.toLowerCase() === 'content-type')?.[1] ?? ''
      );
      if (!/pdf/i.test(type)) return;
      note(`${details.method} ${details.url} → ${details.statusCode} ${type}`);

      /*
       * Zapamatovat se dá jen adresa, kterou umí aplikace zopakovat. POST
       * s formulářem a jednorázovým tokenem zopakovat nejde — pak to radši
       * řekneme rovnou, než aby se stahování tvářilo, že bude fungovat.
       */
      if (String(details.method ?? 'GET').toUpperCase() !== 'GET') {
        finish({ error: `Administrace fakturu posílá jako ${details.method}, ne prostým odkazem — hromadné stažení takhle nepůjde.` });
        return;
      }

      const guess = templateFrom(String(details.url ?? ''), known);
      if (!guess) {
        finish({ error: `V adrese ${details.url} není žádné číslo, které by šlo spojit s objednávkou. Pošli tenhle výpis dál.` });
        return;
      }
      setSetting(TPL_KEY, guess.template);

      /*
       * Zbylá čísla v adrese.
       *
       * `…/view-invoice/1185/?invoice_id=1446` nese dvě čísla: první je
       * objednávka, druhé vnitřní číslo faktury, které se z ničeho
       * dopočítat nedá. S takovou adresou se stahovat **nesmí** — dosadilo
       * by se číslo objednávky a `invoice_id` by zůstalo cizí, takže by ke
       * každé objednávce přišla jedna a tatáž faktura. Přepne se proto na
       * druhý způsob: odkaz se u každé objednávky najde v jejím detailu.
       */
      const page = String(lastPage || '');
      const detail = page ? templateFrom(page, known) : null;
      const viaDetail = guess.leftovers.length > 0;
      setSetting(MODE_KEY, viaDetail ? 'detail' : 'template');
      if (detail && detail.leftovers.length === 0) setSetting(DETAIL_KEY, detail.template);

      note(`vzor: ${guess.template}`);
      if (viaDetail) note(`v adrese zbyla cizí čísla: ${guess.leftovers.join(', ')} — jede se přes detail objednávky`);
      if (detail) note(`detail objednávky: ${detail.template}`);

      finish({
        template: guess.template,
        sample: String(details.url),
        kind: guess.kind,
        matched: guess.matched?.invoice || guess.matched?.code || '',
        mode: viaDetail ? 'detail' : 'template',
        detail: (detail && detail.leftovers.length === 0 ? detail.template : '') || ''
      });
    });
  });
}

/** Přihlášení do administrace — otevře okno a nechá to na člověku. */
export async function openAdminLogin(): Promise<boolean> {
  const cfg = getUpgatesConfig();
  if (!cfg.url) throw new Error('Není vyplněná adresa administrace (Nastavení → AI → Upgates).');
  const win = new BrowserWindow({
    width: 1100, height: 800,
    title: 'Přihlášení do administrace',
    webPreferences: { partition: PARTITION, sandbox: true }
  });
  keepSignedIn(win, 'upgates');
  await openUrl(win, adminHome());
  win.show();
  await signIn(win, 'upgates');
  return true;
}

export const __test = {
  fillTemplate, templateFrom, mergePdfs, pool, isPdf, whyNot, strangeNumber,
  setFetch: (fn: ((url: string) => Promise<Fetched>) | null) => { fetcher = fn; }
};
