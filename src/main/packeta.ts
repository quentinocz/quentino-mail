import { net, BrowserWindow, dialog, app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { getDb, getSetting, setSetting } from './db';
import { encrypt, decrypt } from './secure';
import type { PacketaSetup, PacketaResult, PacketaPacket, ShopOrderItem } from '../shared/types';
import { contentOf } from './ppl';
import { shortNote, approvedNotes } from './shipexport';

/**
 * Zásilkovna (Packeta) přes API.
 *
 * Na rozdíl od PPL tady API veřejné je, takže se zásilka založí přímo
 * z aplikace a štítek se rovnou stáhne jako PDF. Protokol je starší, ale
 * přímočarý: **POST XML** na jednu adresu, kořenový prvek je název metody
 * a heslo se posílá uvnitř dokumentu.
 *
 *   <createPacket><apiPassword>…</apiPassword><packetAttributes>…</packetAttributes></createPacket>
 *   <packetsLabelsPdf><apiPassword>…</apiPassword><packetIds><id>…</id></packetIds>
 *     <format>A6 on A4</format><offset>0</offset></packetsLabelsPdf>
 *
 * Odpověď má vždycky `<status>ok|fault</status>`; u chyby je uvnitř `<fault>`
 * a `<string>` s vysvětlením, u chyb v datech ještě `<detail>` s tím, která
 * kolonka vadí. Tyhle věty se přenášejí do rozhraní slovo od slova — u cizí
 * služby je jejich vlastní hláška víc než naše domněnka.
 *
 * ## Výdejní místo
 *
 * Zásilkovna nechce adresu místa, ale **jeho číslo** (`addressId`). To je ve
 * feedu objednávek; kdyby v konkrétní objednávce chybělo, zásilka se
 * nezaloží a řekne se proč — hádat číslo podle názvu by znamenalo poslat
 * balík někam jinam.
 *
 * ## Co se nedělá
 *
 * Zásilka se zakládá, ale **neodesílá se podací list**. To je krok, po
 * kterém se u dopravce účtuje, a ten patří člověku.
 */

const ENDPOINT = 'https://www.zasilkovna.cz/api/rest';
const SETUP_KEY = 'packetaSetup';
const KEY_KEY = 'packetaPassword';

/**
 * Velikosti štítku, které Zásilkovna zná.
 *
 * Seznam je jejich, ne náš — proto se dá v nastavení přepsat vlastní
 * hodnotou. Když ho odmítnou, ukáže se jejich vlastní hláška, ve které
 * bývají povolené hodnoty vypsané.
 */
export const LABEL_FORMATS = [
  'A6 on A4', 'A6 on A6', 'A7 on A7', 'A7 on A4', 'A8 on A8', '105x35mm on A4'
];

export function packetaSetup(): PacketaSetup {
  let saved: Partial<PacketaSetup> = {};
  try { saved = JSON.parse(getSetting(SETUP_KEY, '') || '{}'); } catch { saved = {}; }
  return {
    hasPassword: !!getSetting(KEY_KEY, ''),
    eshop: saved.eshop ?? 'quentino.cz',
    carrier: saved.carrier ?? 'Zásilkovna|Zasilkovna|Packeta',
    labelFormat: saved.labelFormat ?? 'A6 on A4',
    /** Kolik štítků na archu se přeskočí — na načatém archu se tím netiskne do prázdna */
    labelOffset: Math.max(0, Number(saved.labelOffset) || 0),
    defaultWeight: Number(saved.defaultWeight) || 0.5,
    // Poznámka u zásilky; delší text jejich pole neunese
    noteLimit: Math.max(10, Number(saved.noteLimit) || 128)
  };
}

export function savePacketaSetup(next: Partial<PacketaSetup> & { password?: string }): PacketaSetup {
  if (next.password !== undefined) {
    setSetting(KEY_KEY, next.password ? encrypt(next.password) : '');
  }
  const { password, hasPassword, ...rest } = next as any;
  const merged = { ...packetaSetup(), ...rest };
  delete (merged as any).hasPassword;
  setSetting(SETUP_KEY, JSON.stringify(merged));
  return packetaSetup();
}

function password(): string {
  const raw = getSetting(KEY_KEY, '');
  if (!raw) throw new Error('Není vyplněné API heslo Zásilkovny (Nastavení → AI → Zásilkovna).');
  return decrypt(raw);
}

/* ---------- XML ---------- */

/** Do XML patří jen text; `&` a `<` v názvu výdejního místa by dokument rozbily. */
function esc(value: string | number): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function elems(fields: Record<string, string | number | undefined | null>): string {
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && String(value) !== '')
    .map(([name, value]) => `<${name}>${esc(value as any)}</${name}>`)
    .join('');
}

/** Hodnota prvku kdekoli v dokumentu — odpovědi jsou mělké a bez jmenných prostorů. */
export function pick(xml: string, name: string): string {
  const match = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return match ? match[1].trim() : '';
}

/**
 * Chyba tak, jak ji řekla Zásilkovna.
 *
 * Skládá se z obecné věty a z rozpisu kolonek — právě ten druhý je to
 * užitečné („addressId: pobočka neexistuje"). Naše vlastní shrnutí by z toho
 * udělalo „nepovedlo se" a rozdíl mezi špatným místem a chybějícím telefonem
 * by zmizel.
 */
function faultOf(xml: string): string {
  const general = pick(xml, 'string') || pick(xml, 'fault') || 'Zásilkovna odpověď nevysvětlila.';
  /*
   * Dvojice „kolonka: co je s ní". Hledá se jedním vzorem, ne dvěma kroky:
   * rozpis je `<fault><name>…</name><fault>…</fault></fault>`, tedy prvek
   * uvnitř stejnojmenného prvku, a hledání „od fault do fault" se na téhle
   * vnořenosti utrhne uprostřed.
   */
  const details = [...xml.matchAll(/<name>([\s\S]*?)<\/name>\s*<fault>([\s\S]*?)<\/fault>/gi)]
    .map(one => `${one[1].trim()}: ${one[2].trim()}`)
    .filter(one => one.length > 2);
  return details.length ? `${general} (${details.join('; ')})` : general;
}

async function call(method: string, body: string): Promise<string> {
  const fetcher: typeof fetch = (net as any)?.fetch ?? fetch;
  const xml = `<?xml version="1.0" encoding="utf-8"?>\n<${method}>${body}</${method}>`;
  const res = await fetcher(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset=utf-8' },
    body: xml,
    signal: AbortSignal.timeout(60_000)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Zásilkovna odpověděla HTTP ${res.status}.`);
  if (/<status>\s*fault\s*<\/status>/i.test(text)) throw new Error(faultOf(text));
  return text;
}

/* ---------- zásilky ---------- */

/** Co už je založené — druhé založení téže objednávky by znamenalo dva balíky. */
function schema(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS packeta_packets (
      code TEXT PRIMARY KEY,
      packet_id TEXT NOT NULL DEFAULT '',
      barcode TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT ''
    );
  `);
}

export function packetsFor(codes: string[]): PacketaPacket[] {
  schema();
  if (codes.length === 0) return [];
  const marks = codes.map(() => '?').join(',');
  return (getDb().prepare(
    `SELECT code, packet_id, barcode, created_at FROM packeta_packets WHERE code IN (${marks})`
  ).all(...codes) as any[]).map(row => ({
    code: String(row.code), packetId: String(row.packet_id),
    barcode: String(row.barcode), at: String(row.created_at)
  }));
}

function remember(code: string, packetId: string, barcode: string): void {
  schema();
  getDb().prepare(
    `INSERT INTO packeta_packets (code, packet_id, barcode, created_at) VALUES (?,?,?,?)
     ON CONFLICT(code) DO UPDATE SET packet_id = excluded.packet_id, barcode = excluded.barcode`
  ).run(code, packetId, barcode, new Date().toISOString());
}

/** Váha v kilogramech; feed ji vede v gramech. */
function weightOf(order: any, setup: PacketaSetup): number | undefined {
  const grams = Number(order?.weight) || 0;
  if (grams > 0) return Math.round(grams) / 1000;
  return setup.defaultWeight || undefined;
}

function addressOf(raw: string | null): any {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/**
 * Založí zásilky k objednávkám.
 *
 * Jde se po jedné, ne najednou: API zakládá po jedné a hlavně — když jedna
 * objednávka spadne na chybějícím čísle výdejny, ostatní musí projít. Vrací
 * se obojí, co vzniklo i co ne a proč.
 */
/**
 * Text do poznámky zásilky.
 *
 * Zásilkovna má na tohle jedno pole a dlouhý text neunese. Pokyn zákazníka
 * jde první — když se něco useká, ať je to obsah, ne „nechte u sousedů".
 */
export function packetNote(customer: string, content: string, limit = 128): string {
  const parts = [shortNote(customer, limit), content].filter(Boolean);
  return shortNote(parts.join(' • '), limit);
}

export async function createPackets(
  codes: string[], notes: { code: string; text: string }[] = []
): Promise<PacketaResult> {
  const setup = packetaSetup();
  // Schvaluje se každá poznámka zvlášť — jedna může být pokyn kurýrovi, druhá vzkaz nám
  const allowed = approvedNotes(notes, setup.noteLimit);
  const pass = password();
  schema();

  const marks = codes.map(() => '?').join(',');
  const orders = codes.length === 0 ? [] : getDb().prepare(
    `SELECT code, market, name, email, phone, currency, total, shipment, payment, note,
            pickup_id, pickup_name, weight, items_json, billing_json, postal_json
     FROM shop_orders WHERE code IN (${marks}) ORDER BY code`
  ).all(...codes) as any[];

  const done = new Map(packetsFor(codes).map(one => [one.code, one]));
  const created: PacketaPacket[] = [];
  const failed: { code: string; reason: string }[] = [];

  for (const order of orders) {
    const code = String(order.code ?? '');
    const shipment = String(order.shipment ?? '');
    if (setup.carrier && !new RegExp(setup.carrier, 'i').test(shipment)) {
      failed.push({ code, reason: `jiný dopravce (${shipment || 'neuvedený'})` });
      continue;
    }
    // Podruhé už ne — z jedné objednávky by byly dva balíky
    const already = done.get(code);
    if (already?.packetId) { created.push(already); continue; }

    const where = addressOf(order.postal_json) ?? addressOf(order.billing_json);
    const name = String(where?.name ?? order.name ?? '').trim();
    const space = name.lastIndexOf(' ');
    const items: ShopOrderItem[] = (() => {
      try { return JSON.parse(order.items_json ?? '[]'); } catch { return []; }
    })();

    const cod = /dob[íi]rk|cash\s*on|nachnahme/i.test(String(order.payment ?? ''))
      ? Math.round((Number(order.total) || 0) * 100) / 100
      : 0;

    const pickup = String(order.pickup_id ?? '').trim();
    /*
     * Bez čísla výdejny se zásilka nezaloží. Dohledat místo podle názvu by
     * šlo, ale spletený název znamená balík v jiném městě — to je horší než
     * ruční založení jedné zásilky.
     */
    const toAddress = !pickup;
    if (toAddress && !(where?.street && where?.city && where?.zip)) {
      failed.push({
        code,
        reason: order.pickup_name
          ? `výdejní místo „${order.pickup_name}" nemá ve feedu své číslo`
          : 'objednávka nemá ani číslo výdejny, ani úplnou adresu'
      });
      continue;
    }

    const attributes = elems({
      number: code,
      name: space > 0 ? name.slice(0, space) : name,
      surname: space > 0 ? name.slice(space + 1) : '',
      company: where?.company ?? '',
      email: String(order.email ?? ''),
      phone: String(order.phone ?? ''),
      addressId: pickup || undefined,
      street: toAddress ? where.street : undefined,
      city: toAddress ? where.city : undefined,
      zip: toAddress ? String(where.zip).replace(/\s+/g, '') : undefined,
      currency: String(order.currency ?? 'CZK'),
      cod: cod || undefined,
      value: Math.round((Number(order.total) || 0) * 100) / 100,
      /*
       * Váha z feedu, ne paušál. E-shop ji počítá z položek a posílá
       * v gramech; paušál se použije, jen když ji feed nemá — u zásilky
       * s pěti kravatami by 0,5 kg neseděla.
       */
      weight: weightOf(order, setup),
      eshop: setup.eshop,
      /*
       * Poznámka u zásilky. Zásilkovna má jediné takové pole, takže se do
       * něj skládá obojí: napřed poznámka zákazníka (je to pokyn, podle
       * kterého se jedná), pak obsah zásilky. Delší text jejich pole
       * neunese, proto se to zkracuje.
       */
      note: packetNote(allowed.get(code) ?? '', contentOf(items), setup.noteLimit)
    });

    try {
      const answer = await call('createPacket',
        `<apiPassword>${esc(pass)}</apiPassword><packetAttributes>${attributes}</packetAttributes>`);
      const packetId = pick(answer, 'id');
      const barcode = pick(answer, 'barcode') || pick(answer, 'barcodeText');
      if (!packetId) throw new Error('Zásilkovna nevrátila číslo zásilky.');
      remember(code, packetId, barcode);
      created.push({ code, packetId, barcode, at: new Date().toISOString() });
    } catch (e: any) {
      failed.push({ code, reason: String(e?.message ?? e) });
    }
  }

  return { created, failed, skipped: codes.length - orders.length };
}

/**
 * Štítky k založeným zásilkám jako jeden PDF.
 *
 * Zásilkovna umí vrátit štítky ke všem zásilkám najednou, takže se nic
 * neslučuje — přijde jeden hotový arch. `offset` přeskočí štítky, které jsou
 * z archu už odlepené; bez něj by se na načatý arch tisklo do prázdna.
 */
export async function labelsPdf(codes: string[], format?: string, offset?: number):
  Promise<{ file: string | null; count: number; missing: string[] }> {
  const setup = packetaSetup();
  const pass = password();
  const packets = packetsFor(codes).filter(one => one.packetId);
  const missing = codes.filter(code => !packets.some(one => one.code === code));
  if (packets.length === 0) return { file: null, count: 0, missing };

  const ids = packets.map(one => `<id>${esc(one.packetId)}</id>`).join('');
  const answer = await call('packetsLabelsPdf',
    `<apiPassword>${esc(pass)}</apiPassword><packetIds>${ids}</packetIds>`
    + `<format>${esc(format || setup.labelFormat)}</format>`
    + `<offset>${Math.max(0, Number(offset ?? setup.labelOffset) || 0)}</offset>`);

  const base64 = pick(answer, 'result');
  if (!base64) throw new Error('Zásilkovna štítky nevrátila.');
  const pdf = Buffer.from(base64.replace(/\s+/g, ''), 'base64');
  if (pdf.subarray(0, 4).toString('latin1') !== '%PDF') {
    throw new Error('To, co přišlo místo štítků, není PDF.');
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const res = await dialog.showSaveDialog(BrowserWindow.getFocusedWindow()!, {
    defaultPath: path.join(app.getPath('downloads'), `stitky-zasilkovna-${stamp}.pdf`),
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  });
  if (res.canceled || !res.filePath) return { file: null, count: packets.length, missing };
  fs.writeFileSync(res.filePath, pdf);
  return { file: res.filePath, count: packets.length, missing };
}

/** Ověření hesla — nejlevnější dotaz, jaký API má. */
export async function testPacketa(): Promise<string> {
  const pass = password();
  await call('senderGetReturnRouting', `<apiPassword>${esc(pass)}</apiPassword><senderLabel>${esc(packetaSetup().eshop)}</senderLabel>`);
  return 'Heslo platí a Zásilkovna odpovídá.';
}

export const __test = { packetNote, pick, faultOf, elems, esc, weightOf };
