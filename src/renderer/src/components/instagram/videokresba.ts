/**
 * Kreslení titulků na plátno.
 *
 * ## Proč plátno a ne CSS
 *
 * Titulek se musí objevit **ve videu**, ne jen v náhledu — a vypaluje ho
 * ffmpeg. Kdyby náhled kreslilo CSS a výsledek libass (filtr `subtitles`),
 * rozcházely by se ve všem, na čem záleží: kde se zlomí řádek, jak silný
 * je obtah a jak vysoko text sedí. Kdo si v náhledu srovná titulek na dva
 * řádky, dostal by ve videu tři a poslední by čouhal z obrazu.
 *
 * Proto kreslí **tenhle jeden kód obojí**: náhled v okně i průhledný
 * obrázek, který se pošle ffmpegu k přiložení na obraz. Náhled je tedy
 * doslova ten obrázek, jen menší.
 *
 * Emoji jsou druhý důvod: barevná emoji písma libass spolehlivě nedohledá
 * a místo 👋 vypálí prázdný čtvereček. Chromium je na plátno nakreslí tak,
 * jak je člověk vidí v editoru.
 *
 * ## Proč se všechno počítá z výšky
 *
 * Náhled je široký podle okna, výsledek 1080 × 1920. Kdyby se velikosti
 * psaly v pixelech, v náhledu by písmo bylo obří a ve videu drobné. Každý
 * rozměr se proto násobí `vyska / 1920` — náhled i výsledek pak vypadají
 * stejně v jakékoli velikosti.
 */
import type { VidStyl, VidPozice } from '@shared/videoedit';

export interface KresbaVstup {
  text: string;
  styl: VidStyl;
  pozice: VidPozice;
}

/** Šalvějová zelená z e-shopu — táž barva jako odznak košíku. */
const SALVEJ = '#acc2ab';

interface Popis {
  velikost: number;
  tuk: number;
  obtah: number;
  barva: string;
  barvaObtahu: string;
  /** Pruh nebo cedulka za textem. */
  pozadi: string;
  /** Vnitřní okraj pozadí vůči textu, v dílech velikosti písma. */
  vycpavka: number;
  radius: number;
  /** Vertikální mezera mezi řádky, v dílech velikosti písma. */
  rozteč: number;
  verzalky: boolean;
  stin: number;
  /** Kolik šířky obrazu smí text nejvýš zabrat. */
  sirkaDilu: number;
}

/**
 * Pět stylů, ne dvacet.
 *
 * Každý řeší jinou situaci: obtah na nesourodém záběru, pruh na
 * nejhorším možném pozadí, verzálky na krátké heslo, cedulka když má
 * titulek vypadat jako z e-shopu, jemný když nemá přebít obraz. Víc
 * možností by znamenalo vybírat mezi variantami téhož.
 */
const POPISY: Record<VidStyl, Popis> = {
  klasik: {
    velikost: 66, tuk: 700, obtah: 9, barva: '#fff', barvaObtahu: 'rgba(0,0,0,0.92)',
    pozadi: '', vycpavka: 0, radius: 0, rozteč: 1.16, verzalky: false, stin: 10, sirkaDilu: 0.86
  },
  pruh: {
    velikost: 58, tuk: 600, obtah: 0, barva: '#fff', barvaObtahu: '',
    pozadi: 'rgba(0,0,0,0.62)', vycpavka: 0.34, radius: 0.22, rozteč: 1.34, verzalky: false,
    stin: 0, sirkaDilu: 0.82
  },
  vyrazny: {
    velikost: 92, tuk: 800, obtah: 13, barva: '#fff', barvaObtahu: 'rgba(0,0,0,0.95)',
    pozadi: '', vycpavka: 0, radius: 0, rozteč: 1.06, verzalky: true, stin: 14, sirkaDilu: 0.84
  },
  cedule: {
    velikost: 56, tuk: 700, obtah: 0, barva: '#111', barvaObtahu: '',
    pozadi: SALVEJ, vycpavka: 0.4, radius: 0.28, rozteč: 1.32, verzalky: false,
    stin: 6, sirkaDilu: 0.8
  },
  jemny: {
    velikost: 44, tuk: 400, obtah: 0, barva: 'rgba(255,255,255,0.96)', barvaObtahu: '',
    pozadi: '', vycpavka: 0, radius: 0, rozteč: 1.26, verzalky: false, stin: 16, sirkaDilu: 0.78
  }
};

/*
 * Písmo: aplikace má Montserrat, a ten titulkům sluší. Emoji se z něj
 * nevezme — prohlížeč pro ně sáhne do systémového emoji písma sám, když
 * je v seznamu za hlavním. Bez `Apple Color Emoji` by na Macu zůstal
 * u některých znaků čtvereček.
 */
const PISMO = 'Montserrat, "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", system-ui, sans-serif';

function radky(ctx: CanvasRenderingContext2D, text: string, maxSirka: number): string[] {
  const out: string[] = [];
  /*
   * Vlastní zlom řádku (Enter) se respektuje: když si člověk text rozdělí
   * sám, myslí to tak — automatické lámání by mu to slepilo.
   */
  for (const odstavec of text.split('\n')) {
    const slova = odstavec.split(/\s+/).filter(Boolean);
    if (slova.length === 0) { out.push(''); continue; }
    let radek = slova[0];
    for (const slovo of slova.slice(1)) {
      const zkouska = `${radek} ${slovo}`;
      if (ctx.measureText(zkouska).width <= maxSirka) radek = zkouska;
      else { out.push(radek); radek = slovo; }
    }
    out.push(radek);
  }
  return out;
}

function zakulacenyObdelnik(
  ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
  ctx.fill();
}

/**
 * Nakreslí titulek na plátno o rozměrech `sirka × vyska`.
 *
 * Plátno se **nemaže** — volající si rozhodne, jestli kreslí na průhledno
 * (obrázek pro ffmpeg) nebo přes video (náhled).
 */
export function nakresliTitulek(
  ctx: CanvasRenderingContext2D,
  sirka: number,
  vyska: number,
  vstup: KresbaVstup
): void {
  const text = (vstup.text ?? '').trim();
  if (!text) return;

  const p = POPISY[vstup.styl] ?? POPISY.klasik;
  const k = vyska / 1920;              // všechno se počítá z výšky, viz hlavička
  const velikost = p.velikost * k;
  const psane = p.verzalky ? text.toLocaleUpperCase('cs-CZ') : text;

  ctx.save();
  ctx.font = `${p.tuk} ${velikost}px ${PISMO}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const maxSirka = sirka * p.sirkaDilu;
  const rady = radky(ctx, psane, maxSirka);
  const rozteč = velikost * p.rozteč;
  const blok = rozteč * rady.length;

  /*
   * Kam text sedí. Dole se nechává větší odstup než nahoře: na Instagramu
   * přes spodní část přebíhají ovládací prvky přehrávače a titulek pod
   * nimi nikdo nepřečte.
   */
  const stred = vstup.pozice === 'stred'
    ? vyska / 2
    : vstup.pozice === 'nahore'
      ? vyska * 0.16 + blok / 2
      : vyska * 0.86 - blok / 2;

  if (p.pozadi) {
    ctx.fillStyle = p.pozadi;
    const vycpavkaX = velikost * p.vycpavka;
    const vycpavkaY = velikost * p.vycpavka * 0.6;
    if (vstup.styl === 'pruh') {
      // Pruh za každým řádkem zvlášť: jeden obdélník přes celý blok by
      // u krátkého druhého řádku vypadal jako omyl
      rady.forEach((radek, i) => {
        const w = ctx.measureText(radek).width + vycpavkaX * 2;
        const y = stred - blok / 2 + rozteč * i;
        zakulacenyObdelnik(ctx, sirka / 2 - w / 2, y + (rozteč - velikost) / 2 - vycpavkaY,
          w, velikost + vycpavkaY * 2, velikost * p.radius);
      });
    } else {
      const sirkaTextu = Math.max(...rady.map(r => ctx.measureText(r).width));
      const w = sirkaTextu + vycpavkaX * 2;
      const h = blok + vycpavkaY * 2;
      zakulacenyObdelnik(ctx, sirka / 2 - w / 2, stred - h / 2, w, h, velikost * p.radius);
    }
  }

  if (p.stin > 0) {
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = p.stin * k;
    ctx.shadowOffsetY = 2 * k;
  }

  rady.forEach((radek, i) => {
    const y = stred - blok / 2 + rozteč * i + rozteč / 2;
    if (p.obtah > 0 && p.barvaObtahu) {
      ctx.lineWidth = p.obtah * k;
      ctx.strokeStyle = p.barvaObtahu;
      // `round` — ostré spoje dělají na diakritice trny
      ctx.lineJoin = 'round';
      ctx.miterLimit = 2;
      ctx.strokeText(radek, sirka / 2, y);
    }
    ctx.fillStyle = p.barva;
    ctx.fillText(radek, sirka / 2, y);
  });

  ctx.restore();
}

/**
 * Průhledný PNG s titulkem na celý formát — to, co dostane ffmpeg.
 *
 * Obrázek je na celý obraz schválně: ffmpeg ho pak jen přiloží na nulu
 * a o umístění se nemusí starat. Pár set kilobajtů za to, že se náhled
 * a výsledek nemohou rozejít, je dobrá cena.
 */
export function titulekPng(sirka: number, vyska: number, vstup: KresbaVstup): string {
  const plátno = document.createElement('canvas');
  plátno.width = sirka;
  plátno.height = vyska;
  const ctx = plátno.getContext('2d');
  if (!ctx) throw new Error('Plátno pro titulky se nepodařilo otevřít.');
  nakresliTitulek(ctx, sirka, vyska, vstup);
  return plátno.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
}
