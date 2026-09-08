import { BrowserWindow, dialog, app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { getDb, getSetting, setSetting } from './db';
import type { PplRow, PplExport, PplSetup, ShopOrderItem } from '../shared/types';

/**
 * Vývoz zásilek pro PPL.
 *
 * PPL nemá volné API — přístup k němu schvalují a bez schválení se štítky
 * nedají vystavit programově. Cesta, která funguje hned, je ta samá, jakou
 * používá i e-shop: **soubor CSV nahraný do klientské administrace**
 * (`klient.ppl.cz` → Import zásilek). Aplikace tedy dělá dvě věci: sestaví
 * ten soubor přesně v podobě, na jakou je v PPL nastavená úloha „Upgates",
 * a otevře stránku importu s tím souborem po ruce.
 *
 * Proč to dělat, když to umí i e-shop: v e-shopu se vyváží všechno, co
 * projde filtrem, a nedá se vybrat „těchhle dvanáct, co mám na stole".
 * A hlavně — PPL nově chce **obsah zásilky**, který e-shop neposílá;
 * aplikace ho umí složit z položek objednávky („2 kravaty, motýlek").
 *
 * ## Kódování
 *
 * Soubor je ve **Windows-1250**, ne v UTF-8. Kdyby byl v UTF-8, jméno
 * „Tomáš Bartoník" dorazí do PPL jako „TomÃ¡Å¡" a štítek se vytiskne
 * s ním. Uložený vzor v PPL se čte podle bajtů, ne podle deklarace, takže
 * to není nastavitelné — musí to prostě sedět.
 */

/* ---------- Windows-1250 ---------- */

/** Horní polovina Windows-1250: bajt 0x80–0xFF → znak. Otočením vznikne tabulka pro zápis. */
const CP1250_HIGH =
  '€�‚�„…†‡�‰Š‹ŚŤŽŹ'
  + '�‘’“”•–—�™š›śťžź'
  + ' ˇ˘Ł¤Ą¦§¨©Ş«¬­®Ż'
  + '°±˛ł´µ¶·¸ąş»Ľ˝ľż'
  + 'ŔÁÂĂÄĹĆÇČÉĘËĚÍÎĎ'
  + 'ĐŃŇÓÔŐÖ×ŘŮÚŰÜÝŢß'
  + 'ŕáâăäĺćçčéęëěíîď'
  + 'đńňóôőö÷řůúűüýţ˙';

const TO_CP1250 = ((): Map<string, number> => {
  const map = new Map<string, number>();
  for (let i = 0; i < CP1250_HIGH.length; i++) {
    const ch = CP1250_HIGH[i];
    if (ch !== '�' && !map.has(ch)) map.set(ch, 0x80 + i);
  }
  return map;
})();

/**
 * Text do Windows-1250.
 *
 * Znak, který v téhle stránce není (třeba čínské jméno nebo emotikon),
 * se nahradí otazníkem — je lepší mít v PPL „?" než rozsypaný soubor,
 * který import odmítne celý.
 */
export function toCp1250(text: string): Buffer {
  const out = Buffer.alloc(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) { out[i] = code; continue; }
    const mapped = TO_CP1250.get(text[i]);
    out[i] = mapped ?? 0x3f;
  }
  return out;
}

/* ---------- obsah zásilky ---------- */

/**
 * Co je v krabici, česky a s číslovkou.
 *
 * PPL nově chce popis obsahu. Z názvů položek se dá složit poctivě: každý
 * druh zboží má svoje slovo a čeština k němu tři tvary („1 kravata,
 * 2 kravaty, 5 kravat"). Vypisovat celé názvy produktů nejde — do kolonky
 * se nevejdou a dopravci neřeknou nic.
 */
const KINDS: { re: RegExp; one: string; few: string; many: string }[] = [
  { re: /kravat/i, one: 'kravata', few: 'kravaty', many: 'kravat' },
  { re: /mot[ýy]l/i, one: 'motýlek', few: 'motýlci', many: 'motýlků' },
  { re: /k[šs]and|[šs]le\b/i, one: 'kšandy', few: 'kšandy', many: 'kšand' },
  { re: /kapes[ní]|kapesn[íi][čc]/i, one: 'kapesníček', few: 'kapesníčky', many: 'kapesníčků' },
  { re: /man[žz]et/i, one: 'manžetové knoflíčky', few: 'manžetové knoflíčky', many: 'manžetových knoflíčků' },
  { re: /p[áa]sek|opasek/i, one: 'pásek', few: 'pásky', many: 'pásků' },
  { re: /[šs][áa]t(ek|k)/i, one: 'šátek', few: 'šátky', many: 'šátků' },
  { re: /pono[žz]k/i, one: 'ponožky', few: 'ponožky', many: 'ponožek' },
  { re: /kloko[čc]|spona|jehlic/i, one: 'spona', few: 'spony', many: 'spon' },
  { re: /d[áa]rk|poukaz|set\b|sada/i, one: 'dárkové balení', few: 'dárková balení', many: 'dárkových balení' }
];

/** Český tvar podle počtu: 1 / 2–4 / 5 a víc. */
function plural(kind: { one: string; few: string; many: string }, count: number): string {
  if (count === 1) return kind.one;
  return count < 5 ? kind.few : kind.many;
}

export function contentOf(items: ShopOrderItem[]): string {
  const counts = new Map<number, number>();
  let unknown = 0;
  for (const item of items) {
    const qty = Math.max(1, Math.round(item.quantity || 1));
    const index = KINDS.findIndex(kind => kind.re.test(item.title || '') || kind.re.test(item.code || ''));
    if (index < 0) { unknown += qty; continue; }
    counts.set(index, (counts.get(index) ?? 0) + qty);
  }

  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([index, count]) => (count > 1 ? `${count} ${plural(KINDS[index], count)}` : KINDS[index].one));

  // Nerozpoznané zboží se nezamlčí — jen se pojmenuje obecně, ať sedí počet
  if (unknown > 0) parts.push(unknown > 1 ? `${unknown} kusy oděvních doplňků` : 'oděvní doplněk');
  if (parts.length === 0) return 'oděvní doplňky';
  // Do kolonky se dlouhý výčet nevejde; po třech druzích se to zkrátí
  const short = parts.slice(0, 3).join(', ');
  return (parts.length > 3 ? `${short} a další` : short).slice(0, 60);
}

/* ---------- řádky ---------- */

const SETUP_KEY = 'pplSetup';

export function pplSetup(): PplSetup {
  const raw = getSetting(SETUP_KEY, '')!;
  let saved: Partial<PplSetup> = {};
  try { saved = raw ? JSON.parse(raw) : {}; } catch { saved = {}; }
  return {
    // Které objednávky do PPL patří — pozná se podle názvu dopravy
    carrier: saved.carrier ?? 'PPL',
    /*
     * Sloupec s obsahem zásilky. PPL ho nově chce, ale uložený vzor v jejich
     * administraci o něm zatím nemusí vědět — proto se dá vypnout, dokud si
     * ho člověk ve vzoru nenamapuje.
     */
    content: saved.content !== false,
    /** Adresa importu v klientské administraci */
    importUrl: saved.importUrl ?? 'https://klient.ppl.cz/import.aspx?loadedControl=importZasilek',
    /** Název uložené úlohy, kterou má import použít */
    mapping: saved.mapping ?? 'Upgates'
  };
}

export function savePplSetup(next: Partial<PplSetup>): PplSetup {
  const merged = { ...pplSetup(), ...next };
  setSetting(SETUP_KEY, JSON.stringify(merged));
  return merged;
}

/** Výdejní místo se pozná podle kódu v obci — PPL ho tam samo píše. */
const POINT_CITY = /^KM\d+/i;
const POINT_SHIP = /parcelshop|parcelbox|abox|v[ýy]dejn|depo\b/i;

/** 46 = výdejní místo, 14 = adresa. Jiné typy Quentino neposílá. */
export function typeOf(city: string, shipment: string): 46 | 14 {
  if (POINT_CITY.test(city.trim())) return 46;
  return POINT_SHIP.test(shipment) ? 46 : 14;
}

function addressOf(raw: string | null): any {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/**
 * Objednávky do řádků pro PPL.
 *
 * Bere se **doručovací adresa**; když chybí, fakturační — doručuje se pak
 * na ni a právě to by jinak skončilo zásilkou bez adresy. U výdejního místa
 * je v doručovací adrese adresa toho místa i s jeho kódem, takže se nic
 * dopočítávat nemusí.
 */
export function pplRows(codes: string[]): { rows: PplRow[]; skipped: { code: string; reason: string }[] } {
  if (codes.length === 0) return { rows: [], skipped: [] };
  const setup = pplSetup();
  const marks = codes.map(() => '?').join(',');
  const orders = getDb().prepare(
    `SELECT code, market, name, email, phone, currency, total, shipment, payment,
            items_json, billing_json, postal_json
     FROM shop_orders WHERE code IN (${marks}) ORDER BY code`
  ).all(...codes) as any[];

  const rows: PplRow[] = [];
  const skipped: { code: string; reason: string }[] = [];

  for (const order of orders) {
    const shipment = String(order.shipment ?? '');
    if (setup.carrier && !new RegExp(setup.carrier, 'i').test(shipment)) {
      skipped.push({ code: order.code, reason: `jiný dopravce (${shipment || 'neuvedený'})` });
      continue;
    }

    const postal = addressOf(order.postal_json);
    const billing = addressOf(order.billing_json);
    const where = postal ?? billing;
    if (!where) { skipped.push({ code: order.code, reason: 'objednávka nemá adresu' }); continue; }

    const city = String(where.city ?? '');
    const items: ShopOrderItem[] = (() => {
      try { return JSON.parse(order.items_json ?? '[]'); } catch { return []; }
    })();

    /*
     * Dobírka. Vybírá se celá částka objednávky včetně dopravy — to je to,
     * co dopravce od zákazníka vybere. U placených předem je nula, ne
     * prázdno: prázdná kolonka se v importu chová jako chyba.
     */
    const cod = /dob[íi]rk|cash\s*on|nachnahme/i.test(String(order.payment ?? ''))
      ? Math.round((Number(order.total) || 0) * 100) / 100
      : 0;

    rows.push({
      code: String(order.code ?? ''),
      name: String(where.name ?? order.name ?? '').trim(),
      company: String(where.company ?? '').trim(),
      street: String(where.street ?? '').trim(),
      city: city.trim(),
      zip: String(where.zip ?? '').trim(),
      country: (String(where.country ?? 'CZ').trim() || 'CZ').toUpperCase(),
      cod,
      currency: String(order.currency ?? 'CZK').trim() || 'CZK',
      // Variabilní symbol je číslo objednávky bez vodicích nul — pod ním se
      // zásilka páruje s objednávkou na obou stranách
      variableSymbol: String(order.code ?? '').replace(/^0+/, ''),
      phone: String(order.phone ?? '').trim(),
      email: String(order.email ?? '').trim(),
      type: typeOf(city, shipment),
      total: Math.round((Number(order.total) || 0) * 100) / 100,
      content: contentOf(items)
    });
  }

  return { rows, skipped };
}

/* ---------- soubor ---------- */

const HEAD = ['name', 'company', 'street', 'city', 'zip', 'country', 'cash_on_delivery',
  'currency', 'variable_symbol', 'phone', 'email', 'type', 'total'];

/**
 * Uvozovky jen tam, kde je vzor z PPL má.
 *
 * Vypadá to jako drobnost, ale uložená úloha čte soubor doslova: kolonka
 * s mezerou musí být v uvozovkách, číslo bez nich. Řídí se to tedy podle
 * hodnoty, ne podle sloupce — přesně jako v exportu, podle kterého je úloha
 * v PPL nastavená.
 */
function cell(value: string | number): string {
  const text = String(value ?? '');
  if (!text) return '';
  if (/[";\s]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function pplCsv(rows: PplRow[], withContent: boolean): Buffer {
  const head = withContent ? [...HEAD, 'content'] : HEAD;
  const lines = [head.join(';')];
  for (const row of rows) {
    const cells = [
      row.name, row.company, row.street, row.city, row.zip, row.country,
      row.cod, row.currency, row.variableSymbol, row.phone, row.email, row.type, row.total
    ].map(cell);
    if (withContent) cells.push(cell(row.content));
    lines.push(cells.join(';'));
  }
  // Konce řádků po windowsku — import je čte tak, jak je zvyklý
  return toCp1250(`${lines.join('\r\n')}\r\n`);
}

/** Sestaví soubor a uloží ho; vrací i to, co se nevyvezlo a proč. */
export async function exportPpl(codes: string[], ask = true): Promise<PplExport> {
  const setup = pplSetup();
  const { rows, skipped } = pplRows(codes);
  if (rows.length === 0) {
    return { file: null, rows: 0, skipped, content: setup.content };
  }

  const csv = pplCsv(rows, setup.content);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const target = path.join(app.getPath('downloads'), `ppl-${stamp}.csv`);

  let file = target;
  if (ask) {
    const res = await dialog.showSaveDialog(BrowserWindow.getFocusedWindow()!, {
      defaultPath: target,
      filters: [{ name: 'CSV pro PPL', extensions: ['csv'] }]
    });
    if (res.canceled || !res.filePath) return { file: null, rows: 0, skipped, content: setup.content };
    file = res.filePath;
  }
  fs.writeFileSync(file, csv);
  return { file, rows: rows.length, skipped, content: setup.content };
}

/* ---------- import do administrace PPL ---------- */

let importWin: BrowserWindow | null = null;

/**
 * Otevře import v klientské administraci PPL a vloží do něj soubor.
 *
 * Postup je ten samý jako u naskladnění: okno s vlastním trvalým sezením,
 * do kterého se člověk jednou přihlásí, a v něm se udělá to, co by dělal
 * klikáním — vybere se uložená úloha („Upgates") a nahraje soubor.
 *
 * Soubor do políčka nejde vložit skriptem — prohlížeč to zakazuje, a je to
 * tak správně. Používá se proto ladicí rozhraní Chromia (`DOM.setFileInputFiles`),
 * tedy totéž, co dělá člověk myší. Když se to nepovede, okno zůstane
 * otevřené na správné stránce a soubor je připravený v Downloads — poslední
 * kliknutí udělá člověk.
 *
 * Samotné odeslání („Vlož") se **nekliká**. Import zásilek je nevratný krok
 * a ten patří člověku, ne aplikaci.
 */
export async function openPplImport(file: string): Promise<{ filled: boolean; note: string }> {
  const setup = pplSetup();
  const win = importWin && !importWin.isDestroyed() ? importWin : new BrowserWindow({
    width: 1200, height: 860,
    title: 'Import zásilek do PPL',
    webPreferences: { partition: 'persist:ppl', sandbox: true }
  });
  importWin = win;
  win.on('closed', () => { importWin = null; });

  if (!win.webContents.getURL().startsWith(setup.importUrl)) await win.loadURL(setup.importUrl);
  win.show();
  win.focus();

  // Vybere uloženou úlohu, pokud je jiná než ta právě zvolená
  await pick(win, setup.mapping);

  try {
    await setFile(win, file);
    return { filled: true, note: 'Soubor je vložený. Zkontroluj úlohu a klikni na „Vlož".' };
  } catch (e: any) {
    return {
      filled: false,
      note: `Soubor se nepodařilo vložit (${String(e?.message ?? e)}). Je uložený v ${file} — vyber ho v okně ručně.`
    };
  }
}

/** Volba uložené úlohy v rozbalovacím seznamu; stránka se pak sama znovu načte. */
async function pick(win: BrowserWindow, mapping: string): Promise<void> {
  if (!mapping) return;
  try {
    await win.webContents.executeJavaScript(`
      (function () {
        var select = document.getElementById('ctl00_contentPH_ctl00_vybnastaveni');
        if (!select) return false;
        var want = ${JSON.stringify(mapping)}.toLowerCase();
        for (var i = 0; i < select.options.length; i++) {
          if (select.options[i].text.trim().toLowerCase() === want) {
            if (select.selectedIndex === i) return true;
            select.selectedIndex = i;
            /* Stránka na změnu reaguje vlastním postbackem — musí se spustit */
            select.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }
        }
        return false;
      })()
    `, true);
    await new Promise(resolve => setTimeout(resolve, 1200));
  } catch { /* výběr úlohy je pohodlí, ne podmínka */ }
}

/**
 * Vloží soubor do políčka přes ladicí rozhraní.
 *
 * `input.value` se ze skriptu nastavit nedá a je to tak správně — kdyby šlo,
 * uměla by libovolná stránka nahrát cizí soubory. `DOM.setFileInputFiles` je
 * cesta, kterou používají i nástroje na testování; okno je naše vlastní
 * a soubor jsme právě vytvořili.
 */
async function setFile(win: BrowserWindow, file: string): Promise<void> {
  if (!fs.existsSync(file)) throw new Error('soubor neexistuje');
  const dbg = win.webContents.debugger;
  let attached = false;
  try {
    if (!dbg.isAttached()) { dbg.attach('1.3'); attached = true; }
    await dbg.sendCommand('DOM.enable');
    const doc: any = await dbg.sendCommand('DOM.getDocument', { depth: -1 });
    const found: any = await dbg.sendCommand('DOM.querySelector', {
      nodeId: doc.root.nodeId,
      selector: '#ctl00_contentPH_ctl00_fupload'
    });
    if (!found?.nodeId) throw new Error('políčko pro soubor na stránce není');
    await dbg.sendCommand('DOM.setFileInputFiles', { nodeId: found.nodeId, files: [file] });
  } finally {
    if (attached && dbg.isAttached()) { try { dbg.detach(); } catch { /* okno se mohlo zavřít */ } }
  }
}

export const __test = { toCp1250, contentOf, typeOf, pplCsv, cell };
