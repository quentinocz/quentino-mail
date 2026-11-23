import zlib from 'zlib';

/**
 * Minimální ZIP — zápis i čtení, bez knihovny.
 *
 * Aplikace žádnou knihovnu na ZIP nemá a kvůli jednomu exportu podkladů
 * kabiny ji přidávat nestojí za to: formát je jednoduchý a stačí z něj
 * „uložené" a „deflate" položky, které umí každý rozbalovač (Finder,
 * Windows, Python). Čte se z centrálního adresáře, takže projde i ZIP,
 * který Finder znovu zabalil s datovými deskriptory.
 */

export interface ZipPolozka { jmeno: string; data: Buffer }

let tabulka: Uint32Array | null = null;
function crc32(data: Buffer): number {
  if (!tabulka) {
    tabulka = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      tabulka[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = tabulka[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Datum a čas ve formátu DOS (ZIP jiný nezná). */
function dosCas(d: Date): { cas: number; datum: number } {
  return {
    cas: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    datum: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  };
}

export function zabal(polozky: ZipPolozka[]): Buffer {
  const casti: Buffer[] = [];
  const adresar: Buffer[] = [];
  let posun = 0;
  const { cas, datum } = dosCas(new Date());
  for (const p of polozky) {
    const jmeno = Buffer.from(p.jmeno.replace(/\\/g, '/'), 'utf8');
    /* PNG a JPEG se už nezmenší — ukládají se, jak jsou; text se zkomprimuje */
    const komprimovat = !/\.(png|jpe?g|webp)$/i.test(p.jmeno);
    const zabalene = komprimovat ? zlib.deflateRawSync(p.data, { level: 9 }) : p.data;
    const metoda = komprimovat && zabalene.length < p.data.length ? 8 : 0;
    const telo = metoda === 8 ? zabalene : p.data;
    const crc = crc32(p.data);

    const hlava = Buffer.alloc(30);
    hlava.writeUInt32LE(0x04034b50, 0);
    hlava.writeUInt16LE(20, 4);
    hlava.writeUInt16LE(0x0800, 6); /* jména v UTF-8 */
    hlava.writeUInt16LE(metoda, 8);
    hlava.writeUInt16LE(cas, 10);
    hlava.writeUInt16LE(datum, 12);
    hlava.writeUInt32LE(crc, 14);
    hlava.writeUInt32LE(telo.length, 18);
    hlava.writeUInt32LE(p.data.length, 22);
    hlava.writeUInt16LE(jmeno.length, 26);
    hlava.writeUInt16LE(0, 28);
    casti.push(hlava, jmeno, telo);

    const zaznam = Buffer.alloc(46);
    zaznam.writeUInt32LE(0x02014b50, 0);
    zaznam.writeUInt16LE(20, 4);
    zaznam.writeUInt16LE(20, 6);
    zaznam.writeUInt16LE(0x0800, 8);
    zaznam.writeUInt16LE(metoda, 10);
    zaznam.writeUInt16LE(cas, 12);
    zaznam.writeUInt16LE(datum, 14);
    zaznam.writeUInt32LE(crc, 16);
    zaznam.writeUInt32LE(telo.length, 20);
    zaznam.writeUInt32LE(p.data.length, 24);
    zaznam.writeUInt16LE(jmeno.length, 28);
    zaznam.writeUInt32LE(posun, 42);
    adresar.push(zaznam, jmeno);
    posun += hlava.length + jmeno.length + telo.length;
  }
  const adresarData = Buffer.concat(adresar);
  const konec = Buffer.alloc(22);
  konec.writeUInt32LE(0x06054b50, 0);
  konec.writeUInt16LE(polozky.length, 8);
  konec.writeUInt16LE(polozky.length, 10);
  konec.writeUInt32LE(adresarData.length, 12);
  konec.writeUInt32LE(posun, 16);
  return Buffer.concat([...casti, adresarData, konec]);
}

export function rozbal(zip: Buffer): ZipPolozka[] {
  /* Konec centrálního adresáře hledáme od konce — za ním může být komentář */
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Soubor není ZIP (nebo je poškozený).');
  const pocet = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  const out: ZipPolozka[] = [];
  for (let n = 0; n < pocet; n++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error('Poškozený adresář v ZIPu.');
    const metoda = zip.readUInt16LE(p + 10);
    const zabalene = zip.readUInt32LE(p + 20);
    const delkaJmena = zip.readUInt16LE(p + 28);
    const delkaExtra = zip.readUInt16LE(p + 30);
    const delkaKomentare = zip.readUInt16LE(p + 32);
    const hlavaOd = zip.readUInt32LE(p + 42);
    const jmeno = zip.slice(p + 46, p + 46 + delkaJmena).toString('utf8');
    p += 46 + delkaJmena + delkaExtra + delkaKomentare;
    if (jmeno.endsWith('/') || jmeno.startsWith('__MACOSX/') || /(^|\/)\._/.test(jmeno)) continue;
    const odData = hlavaOd + 30 + zip.readUInt16LE(hlavaOd + 26) + zip.readUInt16LE(hlavaOd + 28);
    const telo = zip.slice(odData, odData + zabalene);
    let data: Buffer;
    if (metoda === 0) data = Buffer.from(telo);
    else if (metoda === 8) data = zlib.inflateRawSync(telo);
    else throw new Error(`ZIP používá nepodporovanou kompresi (${metoda}) u ${jmeno}.`);
    out.push({ jmeno, data });
  }
  return out;
}

export const __test = { crc32 };
