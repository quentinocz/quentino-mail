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
 * Umí tenhle JPEG vykreslit prohlížeč?
 *
 * ## Proč se to musí ptát
 *
 * V CR2 nejsou JPEGy dva, ale tři, a jeden z nich je past: syrová data ze
 * senzoru jsou uložená jako **bezztrátový JPEG** (SOF3). Začíná stejnou
 * značkou jako obyčejný JPEG a je zdaleka největší, takže „vezmi ten
 * největší" sáhne přesně po něm — a Chromium ho neotevře, protože
 * bezztrátový JPEG neumí nikdo kromě vyvolávacích programů. V galerii pak
 * zůstane prázdná dlaždice a vypadá to, že se náhled nenašel.
 *
 * ## Jak se to pozná
 *
 * Projdou se značky až k té, která popisuje snímek (SOF). Prohlížeč umí
 * SOF0 (základní), SOF1 (rozšířený) a SOF2 (postupný); cokoliv jiného —
 * hlavně SOF3 — je pro něj k ničemu.
 */
export function browserReadable(buffer: Buffer, start: number, length: number): boolean {
  const end = Math.min(buffer.length, start + length);
  let at = start + 2;
  while (at + 3 < end) {
    if (buffer[at] !== 0xff) return false;
    const marker = buffer[at + 1];
    // Výplňové bajty mezi značkami se přeskakují
    if (marker === 0xff) { at++; continue; }
    // SOF0/1/2 — tyhle prohlížeč vykreslí
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) return true;
    // Bezztrátový (c3), aritmetický (c9–cb) a hierarchický (c5–c7, cd–cf) ne
    if (marker >= 0xc3 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xcc) return false;
    // Začátek obrazových dat bez předchozího SOF — dál se nic nedozvíme
    if (marker === 0xda) return false;
    const size = buffer.readUInt16BE(at + 2);
    if (size < 2) return false;
    at += 2 + size;
  }
  return false;
}

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
      /*
       * A jen to, co prohlížeč vykreslí. Tabulka IFD#3 ukazuje na syrová
       * data ze senzoru, taky uložená jako JPEG — jenže bezztrátový, a ten
       * je navíc desetkrát větší než náhled, takže by vyhrál.
       */
      if (!browserReadable(buffer, hit.start, hit.length)) continue;
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
    const length = end + 2 - i;
    if (browserReadable(buffer, i, length)) out.push({ start: i, length });
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

/**
 * Pod touhle velikostí je nález nejspíš jen náhled pro displej.
 *
 * Sto šedesát na sto dvacet bodů má pár desítek kilobajtů. V galerii by
 * to byla rozmazaná placka, takže se radši ještě projde celý soubor —
 * velký náhled bývá i tam, kde ho tabulka neuvádí tak, jak čekáme.
 */
const TOO_SMALL = 200 * 1024;

export function embeddedJpeg(buffer: Buffer): Buffer | null {
  const fromTables = biggest(tiffJpegs(buffer));
  /*
   * Průchodem se hledá jen tehdy, když tabulky nic pořádného nedaly.
   * U dvacetimegabajtového souboru to není zadarmo a v obvyklém případě
   * to není potřeba.
   */
  const hit = fromTables && fromTables.length >= TOO_SMALL
    ? fromTables
    : biggest([...(fromTables ? [fromTables] : []), ...scanJpegs(buffer)]);
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

export const __test = { tiffJpegs, scanJpegs, biggest, embeddedJpeg, isRawFile, browserReadable };
