import { getDb } from './db';
import type { ShopOrderItem } from '../shared/types';

/**
 * Společný podklad pro vývoz zásilek dopravcům.
 *
 * Každý dopravce chce jiný soubor — jiné sloupce, jiné kódování, jiné kódy
 * služeb. Co je u všech stejné, je **cesta k datům**: která objednávka do
 * souboru patří, kam se doručuje, kolik se vybírá na dobírku a co je uvnitř.
 * Tahle část tedy bydlí na jednom místě a profil dopravce z ní jen skládá
 * řádky. Když se opraví adresa (třeba že se u výdejny bere doručovací, ne
 * fakturační), opraví se všem najednou.
 */

export interface ShipOrder {
  code: string;
  market: string;
  /** Jméno příjemce; u výdejny je v adrese, ne u objednávky */
  name: string;
  /** U výdejního místa jeho název, jinak firma příjemce */
  company: string;
  street: string;
  city: string;
  zip: string;
  country: string;
  phone: string;
  email: string;
  currency: string;
  /** Celá částka objednávky včetně dopravy */
  total: number;
  /** Cena zboží — to, co se pojišťuje */
  goods: number;
  /** Kolik vybrat na dobírku; 0 u placených předem */
  cod: number;
  /** Váha v gramech, jak ji spočítal e-shop */
  weight: number;
  /** Číslo nebo kód výdejního místa z feedu (`BRANCH_ID`) */
  pickupId: string;
  pickupName: string;
  shipment: string;
  payment: string;
  invoice: string;
  items: ShopOrderItem[];
}

const COD = /dob[íi]rk|cash\s*on|nachnahme/i;

function addressOf(raw: string | null): any {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function itemsOf(raw: string | null): ShopOrderItem[] {
  try { return JSON.parse(raw ?? '[]'); } catch { return []; }
}

/**
 * Objednávky připravené k vývozu.
 *
 * `carrier` je vzor názvu dopravy — podle něj se pozná, které objednávky
 * do souboru patří. Co se vynechá, se vrací i s důvodem: „nic se nevyvezlo"
 * bez vysvětlení je slepá ulička, a nejčastější důvod (jiný dopravce) není
 * chyba, jen informace.
 *
 * Adresa se bere doručovací; když chybí, fakturační — doručuje se pak na ni
 * a bez toho by zásilka odešla bez adresy. U výdejního místa je v doručovací
 * adresa toho místa i jeho název.
 */
export function shipOrders(codes: string[], carrier: string):
  { rows: ShipOrder[]; skipped: { code: string; reason: string }[] } {
  if (codes.length === 0) return { rows: [], skipped: [] };

  const marks = codes.map(() => '?').join(',');
  const found = getDb().prepare(
    `SELECT code, market, name, email, phone, currency, total, shipment, payment,
            pickup_id, pickup_name, weight, invoice, items_json, billing_json, postal_json
     FROM shop_orders WHERE code IN (${marks}) ORDER BY code`
  ).all(...codes) as any[];

  const rows: ShipOrder[] = [];
  const skipped: { code: string; reason: string }[] = [];
  // Neplatný vzor by jinak shodil celý vývoz; radši projdou všechny
  const matches = (() => {
    try { return carrier ? new RegExp(carrier, 'i') : null; } catch { return null; }
  })();

  for (const order of found) {
    const shipment = String(order.shipment ?? '');
    if (matches && !matches.test(shipment)) {
      skipped.push({ code: String(order.code), reason: `jiný dopravce (${shipment || 'neuvedený'})` });
      continue;
    }

    const where = addressOf(order.postal_json) ?? addressOf(order.billing_json);
    if (!where) { skipped.push({ code: String(order.code), reason: 'objednávka nemá adresu' }); continue; }

    const items = itemsOf(order.items_json);
    const total = Math.round((Number(order.total) || 0) * 100) / 100;
    const goods = Math.round(items.reduce((sum, item) =>
      sum + (Number(item.price) || 0) * Math.max(1, Number(item.quantity) || 1), 0) * 100) / 100;

    rows.push({
      code: String(order.code ?? ''),
      market: String(order.market ?? 'cz'),
      name: String(where.name ?? order.name ?? '').trim(),
      company: String(where.company ?? '').trim(),
      street: String(where.street ?? '').trim(),
      city: String(where.city ?? '').trim(),
      zip: String(where.zip ?? '').trim(),
      country: (String(where.country ?? 'CZ').trim() || 'CZ').toUpperCase(),
      phone: String(order.phone ?? '').trim(),
      email: String(order.email ?? '').trim(),
      currency: String(order.currency ?? 'CZK').trim() || 'CZK',
      total,
      // Objednávka bez rozepsaných položek by měla nulovou hodnotu zboží —
      // pak je poctivější poslat celkovou částku než nulu
      goods: goods || total,
      /*
       * Dobírka. Vybírá se celá částka objednávky včetně dopravy — to je to,
       * co dopravce od zákazníka vybere. U placených předem je nula, ne
       * prázdno: prázdná kolonka se v importu chová jako chyba.
       */
      cod: COD.test(String(order.payment ?? '')) ? total : 0,
      weight: Number(order.weight) || 0,
      pickupId: String(order.pickup_id ?? '').trim(),
      pickupName: String(order.pickup_name ?? '').trim(),
      shipment,
      payment: String(order.payment ?? ''),
      invoice: String(order.invoice ?? ''),
      items
    });
  }

  return { rows, skipped };
}

/**
 * Ulice rozdělená na název a čísla.
 *
 * Česká pošta chce ulici, číslo popisné a číslo orientační zvlášť, zatímco
 * e-shop je vede v jednom řetězci („Zenklova 608/150"). Dělí se odzadu:
 * poslední kus s číslicí je číslo, zbytek je název ulice. Když číslo chybí
 * („Zdislavice 204" bez orientačního), zůstane prázdné — vymýšlet si ho
 * nelze a import s prázdným polem počítá.
 */
export function splitStreet(street: string): { street: string; house: string; orient: string } {
  const clean = (street ?? '').trim().replace(/\s+/g, ' ');
  if (!clean) return { street: '', house: '', orient: '' };

  const match = clean.match(/^(.*?)[\s,]*(\d+[a-zA-Z]?)(?:\s*\/\s*(\d+[a-zA-Z]?))?$/);
  if (!match) return { street: clean, house: '', orient: '' };

  const name = match[1].trim();
  // Samotné číslo bez názvu ulice — vesnice bez ulic („Zdislavice 204")
  if (!name) return { street: '', house: match[2], orient: match[3] ?? '' };
  return { street: name, house: match[2], orient: match[3] ?? '' };
}

/**
 * Buňka do CSV.
 *
 * Uvozuje se jen to, co je potřebuje — hodnota s mezerou, středníkem nebo
 * uvozovkou. Import čte soubor doslova a uvozovky navíc u čísla umí
 * rozhodit sloupec, ve kterém čeká číslo.
 */
export function cell(value: string | number | null | undefined): string {
  const text = String(value ?? '');
  if (!text) return '';
  if (/[";\s]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/** Řádek se zakončuje po windowsku — importy jsou na to zvyklé. */
export function csv(lines: string[][]): string {
  return `${lines.map(one => one.map(cell).join(';')).join('\r\n')}\r\n`;
}
