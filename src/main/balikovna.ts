import { BrowserWindow, dialog, app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { getSetting, setSetting } from './db';
import { shipOrders, splitStreet, csv, ShipOrder } from './shipexport';
import { contentOf } from './ppl';
import type { BalikovnaSetup, BalikovnaExport } from '../shared/types';

/**
 * Vývoz zásilek pro Balíkovnu (Podání Online České pošty).
 *
 * Česká pošta má vlastní aplikaci **Podání Online**, do které se zásilky
 * nahrávají souborem. Na rozdíl od PPL tam ale není jeden pevný formát:
 * uživatel si v Podání Online založí konfiguraci importu a v ní ke každému
 * poli napíše, **ve kterém sloupci** souboru ho má hledat. Soubor tedy může
 * mít sloupce v libovolném pořadí — musí jen sedět s tou konfigurací.
 *
 * Proto je pořadí sloupců tady nastavitelné a ve výchozím stavu odpovídá
 * pořadí, které Česká pošta v návodech uvádí (Příjmení/Název 1, Jméno 2,
 * IČ 3, DIČ 4, Obec 5 … VS poukázka 23). Kdo má v Podání Online konfiguraci
 * jinak, přehází si sloupce v nastavení a nemusí čekat na novou verzi.
 *
 * Kódování je **UTF-8**, ne Windows-1250 jako u PPL. Je to jediný rozdíl,
 * který nejde uhodnout a přitom rozhodne o tom, jestli se jméno vytiskne
 * správně — proto je to tady napsané.
 *
 * Co aplikace **nedělá**: nepodává zásilky. Soubor se nahraje a odešle
 * v Podání Online ručně; podání je nevratné a účtuje se.
 */

const SETUP_KEY = 'balikovnaSetup';

/**
 * Pole, která umí aplikace do souboru dát.
 *
 * Názvy jsou české a shodují se s tím, jak se pole jmenují v konfiguraci
 * Podání Online — ať se dá nastavení porovnat řádek po řádku, ne odhadovat.
 */
export const FIELDS: { key: string; label: string; hint: string }[] = [
  { key: 'prijmeni', label: 'Příjmení/Název', hint: 'Jméno příjemce; u výdejny název místa' },
  { key: 'jmeno', label: 'Jméno', hint: 'Křestní jméno, když jde jméno rozdělit' },
  { key: 'ic', label: 'IČ', hint: 'Nevyplňuje se' },
  { key: 'dic', label: 'DIČ', hint: 'Nevyplňuje se' },
  { key: 'obec', label: 'Obec', hint: 'Město z doručovací adresy' },
  { key: 'castObce', label: 'Část obce', hint: 'Nevyplňuje se' },
  { key: 'ulice', label: 'Ulice', hint: 'Název ulice bez čísla' },
  { key: 'cisloPopisne', label: 'Č. popisné', hint: 'Číslo z adresy' },
  { key: 'cisloOrientacni', label: 'Č. orientační', hint: 'Číslo za lomítkem' },
  { key: 'psc', label: 'PSČ', hint: 'Bez mezery' },
  { key: 'stat', label: 'Stát', hint: 'Kód země, CZ' },
  { key: 'telefon', label: 'Telefon', hint: 'Nevyplňuje se, číslo jde do Mobilu' },
  { key: 'mobil', label: 'Mobil', hint: 'Telefon zákazníka — na něj chodí zpráva o zásilce' },
  { key: 'email', label: 'E-mail', hint: 'E-mail zákazníka' },
  { key: 'typ', label: 'Typ zásilky', hint: 'Kód produktu České pošty' },
  { key: 'hmotnost', label: 'Hmotnost', hint: 'V kilogramech, z feedu' },
  { key: 'cena', label: 'Udaná cena', hint: 'Cena zboží — to, co se pojišťuje' },
  { key: 'vs', label: 'VS zásilka', hint: 'Číslo objednávky bez vodicích nul' },
  { key: 'sluzby', label: 'Doplň. služby', hint: 'Kódy doplňkových služeb' },
  { key: 'dobirka', label: 'Dobírka', hint: 'Částka k vybrání; 0 u placených předem' },
  { key: 'mena', label: 'Měna (ISO)', hint: 'CZK' },
  { key: 'pocetVk', label: 'Počet VK', hint: 'Nevyplňuje se' },
  { key: 'vsPoukazka', label: 'VS poukázka', hint: 'Číslo objednávky — párování platby dobírky' },
  { key: 'obsah', label: 'Obsah zásilky', hint: 'Složený z položek: „2 kravaty, motýlek"' },
  { key: 'mistoNazev', label: 'Název výdejního místa', hint: 'Z doručovací adresy' },
  { key: 'mistoId', label: 'ID výdejního místa', hint: 'Z feedu (BRANCH_ID)' }
];

/** Pořadí sloupců podle návodů České pošty — 23 polí, jak je Podání Online číslu je. */
const DEFAULT_ORDER = [
  'prijmeni', 'jmeno', 'ic', 'dic', 'obec', 'castObce', 'ulice', 'cisloPopisne',
  'cisloOrientacni', 'psc', 'stat', 'telefon', 'mobil', 'email', 'typ', 'hmotnost',
  'cena', 'vs', 'sluzby', 'dobirka', 'mena', 'pocetVk', 'vsPoukazka'
].join(',');

export function balikovnaSetup(): BalikovnaSetup {
  let saved: Partial<BalikovnaSetup> = {};
  try { saved = JSON.parse(getSetting(SETUP_KEY, '') || '{}'); } catch { saved = {}; }
  return {
    // Které objednávky sem patří — pozná se podle názvu dopravy
    carrier: saved.carrier ?? 'Balíkovna|Balikovna',
    /*
     * Pořadí sloupců. Podání Online si mapuje pole na čísla sloupců, takže
     * tohle musí sedět s tou konfigurací — a měnit se to má tady, ne v kódu.
     */
    order: saved.order ?? DEFAULT_ORDER,
    /** Psát první řádek s názvy? Konfigurace importu umí obojí. */
    header: saved.header === true,
    /*
     * Kód produktu. Balíkovna má u České pošty vlastní kód a v konfiguraci
     * se zadává jako „Typ zásilky"; správný je ten, který je v Podání Online
     * u téhle služby vidět.
     */
    type: saved.type ?? 'NB',
    services: saved.services ?? '',
    /** Podání Online, kam se soubor nahrává */
    portalUrl: saved.portalUrl ?? 'https://podanionline.ceskaposta.cz/',
    value: saved.value === 'order' ? 'order' : 'goods'
  };
}

export function saveBalikovnaSetup(next: Partial<BalikovnaSetup>): BalikovnaSetup {
  const merged = { ...balikovnaSetup(), ...next };
  setSetting(SETUP_KEY, JSON.stringify(merged));
  return balikovnaSetup();
}

/**
 * Jedna objednávka jako pojmenované hodnoty.
 *
 * Teprve nastavené pořadí z nich udělá řádek. Rozdělení na hodnoty a jejich
 * pořadí je schválně oddělené: pořadí se mění v nastavení, hodnoty ne.
 */
export function valuesOf(order: ShipOrder, setup: BalikovnaSetup): Record<string, string> {
  const address = splitStreet(order.street);
  /*
   * U výdejního místa je příjemcem člověk, ale na zásilce musí být i název
   * místa — jinak se neví, kam ji doručit. Jméno se dělí na příjmení
   * a křestní podle poslední mezery; jednoslovné jméno zůstane v příjmení,
   * protože povinné je právě to.
   */
  const full = order.name.trim();
  const space = full.lastIndexOf(' ');
  const surname = space > 0 ? full.slice(space + 1) : full;
  const first = space > 0 ? full.slice(0, space) : '';

  const price = setup.value === 'order' ? order.total : order.goods;

  return {
    prijmeni: surname,
    jmeno: first,
    ic: '',
    dic: '',
    obec: order.city,
    castObce: '',
    ulice: address.street,
    cisloPopisne: address.house,
    cisloOrientacni: address.orient,
    // PSČ bez mezery: import ho jinak u některých konfigurací nepřečte
    psc: order.zip.replace(/\s+/g, ''),
    stat: order.country,
    telefon: '',
    // Číslo patří do Mobilu — na něj Česká pošta posílá zprávu o zásilce
    mobil: order.phone,
    email: order.email,
    typ: setup.type,
    // Hmotnost v kilogramech; feed ji vede v gramech
    hmotnost: order.weight > 0 ? String(Math.round(order.weight) / 1000) : '',
    cena: String(price),
    vs: order.code.replace(/^0+/, ''),
    sluzby: setup.services,
    dobirka: String(order.cod),
    mena: order.currency,
    pocetVk: '',
    // Poukázka se páruje týmž číslem — jinak se platba dobírky nespojí
    vsPoukazka: order.cod > 0 ? order.code.replace(/^0+/, '') : '',
    obsah: contentOf(order.items),
    mistoNazev: order.company,
    mistoId: order.pickupId
  };
}

/** Sloupce z nastavení; neznámý název se přeskočí, ať soubor nespadne. */
function columns(setup: BalikovnaSetup): string[] {
  const known = new Set(FIELDS.map(one => one.key));
  return setup.order.split(',').map(one => one.trim()).filter(one => known.has(one));
}

export function balikovnaCsv(rows: ShipOrder[], setup: BalikovnaSetup): Buffer {
  const keys = columns(setup);
  const lines: string[][] = [];
  if (setup.header) {
    lines.push(keys.map(key => FIELDS.find(one => one.key === key)?.label ?? key));
  }
  for (const row of rows) {
    const values = valuesOf(row, setup);
    lines.push(keys.map(key => values[key] ?? ''));
  }
  // UTF-8, ne Windows-1250 jako u PPL — Podání Online čte soubor v UTF-8
  return Buffer.from(csv(lines), 'utf8');
}

export function balikovnaRows(codes: string[]):
  { rows: ShipOrder[]; skipped: { code: string; reason: string }[] } {
  return shipOrders(codes, balikovnaSetup().carrier);
}

export async function exportBalikovna(codes: string[]): Promise<BalikovnaExport> {
  const setup = balikovnaSetup();
  const { rows, skipped } = balikovnaRows(codes);
  if (rows.length === 0) return { file: null, rows: 0, skipped, columns: columns(setup).length };

  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const res = await dialog.showSaveDialog(BrowserWindow.getFocusedWindow()!, {
    defaultPath: path.join(app.getPath('downloads'), `balikovna-${stamp}.csv`),
    filters: [{ name: 'CSV pro Podání Online', extensions: ['csv'] }]
  });
  if (res.canceled || !res.filePath) return { file: null, rows: 0, skipped, columns: columns(setup).length };

  fs.writeFileSync(res.filePath, balikovnaCsv(rows, setup));
  return { file: res.filePath, rows: rows.length, skipped, columns: columns(setup).length };
}

let portal: BrowserWindow | null = null;

/**
 * Otevře Podání Online.
 *
 * Nahrání souboru ani odeslání podání aplikace nedělá: podání je nevratné
 * a účtuje se. Okno má vlastní trvalé sezení, takže přihlášení platí i příště.
 */
export async function openBalikovna(): Promise<boolean> {
  const setup = balikovnaSetup();
  const win = portal && !portal.isDestroyed() ? portal : new BrowserWindow({
    width: 1200, height: 860,
    title: 'Podání Online — Balíkovna',
    webPreferences: { partition: 'persist:cposta', sandbox: true }
  });
  portal = win;
  win.on('closed', () => { portal = null; });
  await win.loadURL(setup.portalUrl);
  win.show();
  win.focus();
  return true;
}

export const __test = { valuesOf, columns, balikovnaCsv, DEFAULT_ORDER };
