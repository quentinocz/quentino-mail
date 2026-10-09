import zlib from 'zlib';

/**
 * Čtení a zápis PNG — vlastní, bez knihovny.
 *
 * ## Proč vlastní, a ne něco hotového
 *
 * Vrstvy pro zkušební kabinu se musí rozebrat na body: z dvou obrázků se
 * počítá rozdíl, z něj maska látky a z té mapa světla. K tomu je potřeba
 * surové RGBA — a to v aplikaci nebylo odkud vzít. Nabízely se tři cesty
 * a každá měla svou cenu:
 *
 *  - **`nativeImage` z Electronu** umí PNG rozbalit, ale vrací body
 *    s předvynásobenou průhledností a v pořadí BGRA. U vrstev, které mají
 *    průhledné okraje, se tím barva na okraji nevratně ztratí — zrovna
 *    tam, kde se maska dolaďuje.
 *  - **ffmpeg** by to zvládl, jenže ten se instaluje zvlášť a zrovna tahle
 *    funkce by na něm stála celá. Oblékání modelu nemá co spadnout na tom,
 *    že na počítači chybí nástroj na video.
 *  - **knihovna** by přibyla do závislostí kvůli dvěma stům řádků, které
 *    se navíc musí dát spustit i ve zkoušce mimo Electron.
 *
 * Zlib je v Node vestavěný, takže zbytek PNG je hlavička, kontrolní součet
 * a odfiltrování řádků. Bonus: zkoušky si můžou obrázky vyrobit a přečíst
 * přímo, bez Electronu i bez dalšího nástroje.
 *
 * ## Co se podporuje
 *
 * Osmibitové PNG bez prokládání — to je přesně to, co posílá OpenAI i to,
 * co si aplikace sama ukládá. Šestnáct bitů a prokládání se odmítnou
 * nahlas; mlčky rozbité body by se poznaly až na obrázku modelu.
 */

export interface Obraz {
  sirka: number;
  vyska: number;
  /** Body jako RGBA, čtyři bajty na bod, bez předvynásobení. */
  body: Uint8Array;
}

export function novyObraz(sirka: number, vyska: number): Obraz {
  return { sirka, vyska, body: new Uint8Array(sirka * vyska * 4) };
}

const PODPIS = [137, 80, 78, 71, 13, 10, 26, 10];

/* Tabulka pro CRC32. Spočítá se jednou — PNG ho má u každého bloku. */
const CRC_TAB = (() => {
  const tab = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    tab[n] = c;
  }
  return tab;
})();

function crc32(buf: Buffer): number {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TAB[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** Jeden bod filtru Paeth — predikce ze tří sousedů. */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Rozbalí PNG na RGBA. */
export function nacti(data: Buffer | Uint8Array): Obraz {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  for (let i = 0; i < PODPIS.length; i++) {
    if (buf[i] !== PODPIS[i]) throw new Error('Tohle není PNG.');
  }

  let sirka = 0;
  let vyska = 0;
  let hloubka = 0;
  let druh = 0;
  let prokladani = 0;
  let paleta: Buffer | null = null;
  let paletaAlfa: Buffer | null = null;
  const idat: Buffer[] = [];

  let pos = 8;
  while (pos + 8 <= buf.length) {
    const delka = buf.readUInt32BE(pos);
    const typ = buf.toString('ascii', pos + 4, pos + 8);
    const telo = buf.subarray(pos + 8, pos + 8 + delka);
    if (typ === 'IHDR') {
      sirka = telo.readUInt32BE(0);
      vyska = telo.readUInt32BE(4);
      hloubka = telo[8];
      druh = telo[9];
      prokladani = telo[12];
    } else if (typ === 'PLTE') {
      paleta = Buffer.from(telo);
    } else if (typ === 'tRNS') {
      paletaAlfa = Buffer.from(telo);
    } else if (typ === 'IDAT') {
      idat.push(Buffer.from(telo));
    } else if (typ === 'IEND') {
      break;
    }
    pos += 12 + delka;
  }

  if (!sirka || !vyska) throw new Error('PNG nemá hlavičku s rozměry.');
  if (hloubka !== 8) throw new Error(`PNG má ${hloubka} bitů na složku; umíme jen 8.`);
  if (prokladani) throw new Error('PNG je prokládané; umíme jen neprokládané.');

  const slozek = druh === 0 ? 1 : druh === 2 ? 3 : druh === 3 ? 1 : druh === 4 ? 2 : druh === 6 ? 4 : 0;
  if (!slozek) throw new Error(`Neznámý druh PNG (${druh}).`);
  if (druh === 3 && !paleta) throw new Error('PNG s paletou, ale paleta chybí.');

  const surove = zlib.inflateSync(Buffer.concat(idat));
  const radek = sirka * slozek;
  if (surove.length < (radek + 1) * vyska) throw new Error('PNG je zkrácené.');

  /* Odfiltrování řádků. Filtr se vždycky počítá z už hotového řádku nad. */
  const plochy = Buffer.alloc(radek * vyska);
  let cti = 0;
  for (let y = 0; y < vyska; y++) {
    const filtr = surove[cti];
    cti += 1;
    const zde = y * radek;
    const nad = zde - radek;
    for (let x = 0; x < radek; x++) {
      const hodnota = surove[cti + x];
      const a = x >= slozek ? plochy[zde + x - slozek] : 0;
      const b = y > 0 ? plochy[nad + x] : 0;
      const c = x >= slozek && y > 0 ? plochy[nad + x - slozek] : 0;
      let out = hodnota;
      if (filtr === 1) out = hodnota + a;
      else if (filtr === 2) out = hodnota + b;
      else if (filtr === 3) out = hodnota + ((a + b) >> 1);
      else if (filtr === 4) out = hodnota + paeth(a, b, c);
      else if (filtr !== 0) throw new Error(`Neznámý filtr řádku (${filtr}).`);
      plochy[zde + x] = out & 0xff;
    }
    cti += radek;
  }

  const body = new Uint8Array(sirka * vyska * 4);
  for (let i = 0, n = sirka * vyska; i < n; i++) {
    const z = i * slozek;
    const k = i * 4;
    if (druh === 0) {
      body[k] = body[k + 1] = body[k + 2] = plochy[z];
      body[k + 3] = 255;
    } else if (druh === 4) {
      body[k] = body[k + 1] = body[k + 2] = plochy[z];
      body[k + 3] = plochy[z + 1];
    } else if (druh === 2) {
      body[k] = plochy[z]; body[k + 1] = plochy[z + 1]; body[k + 2] = plochy[z + 2];
      body[k + 3] = 255;
    } else if (druh === 6) {
      body[k] = plochy[z]; body[k + 1] = plochy[z + 1];
      body[k + 2] = plochy[z + 2]; body[k + 3] = plochy[z + 3];
    } else {
      const idx = plochy[z];
      body[k] = paleta![idx * 3] ?? 0;
      body[k + 1] = paleta![idx * 3 + 1] ?? 0;
      body[k + 2] = paleta![idx * 3 + 2] ?? 0;
      body[k + 3] = paletaAlfa ? (paletaAlfa[idx] ?? 255) : 255;
    }
  }

  return { sirka, vyska, body };
}

function blok(typ: string, telo: Buffer): Buffer {
  const hlava = Buffer.alloc(8);
  hlava.writeUInt32BE(telo.length, 0);
  hlava.write(typ, 4, 'ascii');
  const soucet = Buffer.alloc(4);
  soucet.writeUInt32BE(crc32(Buffer.concat([hlava.subarray(4), telo])), 0);
  return Buffer.concat([hlava, telo, soucet]);
}

/**
 * Zapíše RGBA jako PNG.
 *
 * Řádky se filtrují: zkusí se „nic" a „podle řádku nad" a vybere se ten
 * s menším součtem odchylek. U vrstev, kde jsou velké jednolité plochy a
 * nad sebou stejné hodnoty, to zmenší soubor i na pětinu — a velikost
 * vrstev je to, co na e-shopu rozhoduje o rychlosti.
 */
export function uloz(obraz: Obraz): Buffer {
  const { sirka, vyska, body } = obraz;
  const radek = sirka * 4;
  const out = Buffer.alloc((radek + 1) * vyska);
  let pos = 0;
  const nic = Buffer.alloc(radek);
  const nad = Buffer.alloc(radek);
  for (let y = 0; y < vyska; y++) {
    const zde = y * radek;
    let soucetNic = 0;
    let soucetNad = 0;
    for (let x = 0; x < radek; x++) {
      const hodnota = body[zde + x];
      const vys = y > 0 ? body[zde - radek + x] : 0;
      nic[x] = hodnota;
      nad[x] = (hodnota - vys) & 0xff;
      soucetNic += nic[x] < 128 ? nic[x] : 256 - nic[x];
      soucetNad += nad[x] < 128 ? nad[x] : 256 - nad[x];
    }
    const lepsi = soucetNad < soucetNic ? nad : nic;
    out[pos] = soucetNad < soucetNic ? 2 : 0;
    pos += 1;
    lepsi.copy(out, pos);
    pos += radek;
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(sirka, 0);
  ihdr.writeUInt32BE(vyska, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from(PODPIS),
    blok('IHDR', ihdr),
    blok('IDAT', zlib.deflateSync(out, { level: 9 })),
    blok('IEND', Buffer.alloc(0))
  ]);
}
