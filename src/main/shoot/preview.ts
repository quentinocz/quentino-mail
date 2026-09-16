import fs from 'fs';
import path from 'path';

/**
 * Náhled z RAW souboru.
 *
 * ## Proč to musí dělat aplikace
 *
 * Chromium umí JPEG, PNG a WebP — CR2 ani CR3 ne, a nikdy umět nebude:
 * formát je u každé značky jiný a Canon ho mezi řadami mění. V galerii
 * proto u focení do RAW zůstávala prázdná dlaždice s názvem souboru,
 * takže nafocené nešlo zkontrolovat, dokud se soubory neotevřely jinde.
 *
 * ## Odkud se náhled bere
 *
 * Fotoaparát do každého RAW souboru uloží hotový JPEG — právě ten ukazuje
 * na svém displeji. Není potřeba RAW vyvolávat, stačí ten JPEG najít.
 *
 * **CR2, NEF, ARW, DNG a spol.** jsou uvnitř TIFF: tabulka záznamů, kde
 * dvojice značek říká, kde JPEG leží a jak je dlouhý. Ty se přečtou
 * přesně, bez hádání.
 *
 * **CR3** je naopak zabalený jako video (ISO BMFF) a jeho tabulka je jinde.
 * Pro ten je náhradní cesta: projít soubor a najít v něm nejdelší úsek
 * mezi značkami začátku a konce JPEGu. Je to hrubé, ale funguje to
 * i u formátů, které v době psaní ještě neexistovaly.
 */

/** Přípony, u kterých má smysl hledat vnořený náhled. */
const RAW_EXT = ['cr2', 'cr3', 'crw', 'nef', 'nrw', 'arw', 'srf', 'sr2',
  'raf', 'orf', 'rw2', 'pef', 'dng', 'raw', '3fr', 'iiq'];

export function isRawFile(file: string): boolean {
  return RAW_EXT.includes(path.extname(file).replace('.', '').toLowerCase());
}

type Found = { start: number; length: number };

/**
 * Projde tabulky TIFF a posbírá, kde všude leží JPEG.
 *
 * Značky jsou dvě dvojice, protože se to mezi značkami liší: Canon píše
 * náhled jako „pruhy obrazu" (0x0111/0x0117), Nikon jako „vložený JPEG"
 * (0x0201/0x0202). Hledají se obě a bere se ten největší nález — malý
 * náhled pro displej má sto šedesát bodů a v galerii by byl k ničemu.
 */
export function tiffJpegs(buffer: Buffer): Found[] {
  if (buffer.length < 16) return [];
  const order = buffer.readUInt16LE(0);
  const little = order === 0x4949;
  if (!little && order !== 0x4d4d) return [];

  const u16 = (at: number) => (little ? buffer.readUInt16LE(at) : buffer.readUInt16BE(at));
  const u32 = (at: number) => (little ? buffer.readUInt32LE(at) : buffer.readUInt32BE(at));

  if (u16(2) !== 42) return [];

  const out: Found[] = [];
  const seen = new Set<number>();
  const queue: number[] = [u32(4)];

  while (queue.length) {
    const at = queue.shift()!;
    /*
     * Pojistka proti zacyklení a proti poškozenému souboru. Tabulky na sebe
     * odkazují a jeden špatný odkaz by jinak znamenal nekonečnou smyčku
     * uvnitř aplikace — nešlo by ani zavřít okno.
     */
    if (!at || at + 2 > buffer.length || seen.has(at) || seen.size > 32) continue;
    seen.add(at);

    const count = u16(at);
    if (at + 2 + count * 12 + 4 > buffer.length) continue;

    let start = 0;
    let length = 0;
    let jpegAt = 0;
    let jpegLen = 0;

    for (let i = 0; i < count; i++) {
      const entry = at + 2 + i * 12;
      const tag = u16(entry);
      const value = u32(entry + 8);
      if (tag === 0x0111) start = value;          // StripOffsets
      else if (tag === 0x0117) length = value;    // StripByteCounts
      else if (tag === 0x0201) jpegAt = value;    // JPEGInterchangeFormat
      else if (tag === 0x0202) jpegLen = value;   // JPEGInterchangeFormatLength
      else if (tag === 0x014a) {
        // SubIFDs: u Nikonu a Sony je velký náhled až v nich
        const howMany = u32(entry + 4);
        if (howMany === 1) queue.push(value);
        else if (value + howMany * 4 <= buffer.length) {
          for (let k = 0; k < howMany && k < 8; k++) queue.push(u32(value + k * 4));
        }
      }
    }

    for (const hit of [{ start, length }, { start: jpegAt, length: jpegLen }]) {
      if (!hit.start || !hit.length) continue;
      if (hit.start + hit.length > buffer.length) continue;
      // Jen to, co opravdu začíná JPEGem — „pruhy obrazu" bývají i syrová data
      if (buffer[hit.start] !== 0xff || buffer[hit.start + 1] !== 0xd8) continue;
      out.push(hit);
    }

    queue.push(u32(at + 2 + count * 12));
  }
  return out;
}

/**
 * Nejdelší JPEG kdekoliv v souboru.
 *
 * Záchranná cesta pro formáty bez tabulky TIFF (CR3). Hledá se `ffd8ffe0`
 * a podobné začátky, ne jen `ffd8` — samotné `ffd8` se v syrových datech
 * vyskytne každých pár kilobajtů náhodou a vracel by se nesmysl.
 */
export function scanJpegs(buffer: Buffer): Found[] {
  const out: Found[] = [];
  for (let i = 0; i + 3 < buffer.length; i++) {
    if (buffer[i] !== 0xff || buffer[i + 1] !== 0xd8 || buffer[i + 2] !== 0xff) continue;
    const marker = buffer[i + 3];
    // Za začátkem JPEGu stojí hlavička APPn nebo kvantizační tabulka
    if (marker < 0xc0 || marker > 0xef) continue;
    const end = buffer.indexOf(Buffer.from([0xff, 0xd9]), i + 4);
    if (end < 0) continue;
    out.push({ start: i, length: end + 2 - i });
    i = end + 1;
  }
  return out;
}

/** Největší z nalezených. Malé náhledy pro displej jsou v galerii k ničemu. */
export function biggest(found: Found[]): Found | null {
  let best: Found | null = null;
  for (const one of found) {
    if (one.length > 1024 && (!best || one.length > best.length)) best = one;
  }
  return best;
}

export function embeddedJpeg(buffer: Buffer): Buffer | null {
  const hit = biggest(tiffJpegs(buffer)) ?? biggest(scanJpegs(buffer));
  return hit ? buffer.subarray(hit.start, hit.start + hit.length) : null;
}

/**
 * Obsah pro zobrazení v okně.
 *
 * U běžného obrázku vrátí soubor, u RAW vnořený náhled. Když se v RAWu nic
 * nenajde, vrátí `null` a galerie ukáže dlaždici se jménem souboru —
 * to je pořád lepší než rozbitý obrázek bez vysvětlení.
 */
export function viewable(file: string): Uint8Array | null {
  try {
    const bytes = fs.readFileSync(file);
    if (!isRawFile(file)) return new Uint8Array(bytes);
    const inside = embeddedJpeg(bytes);
    return inside ? new Uint8Array(inside) : null;
  } catch {
    return null;
  }
}

export const __test = { tiffJpegs, scanJpegs, biggest, embeddedJpeg, isRawFile };
