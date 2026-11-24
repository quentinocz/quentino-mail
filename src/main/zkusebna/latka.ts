import { Obraz, novyObraz } from './png';
import { pozadiOdKraje, prevzorkuj, zmensi } from './pixely';
import { ZkVrstvaTyp, sablonaPro } from '../../shared/zkusebna';

/**
 * Látka z fotek produktu — výběr místa, vyrovnání světla, dlaždice bez švů.
 *
 * ## Proč znovu
 *
 * Revize podkladů (Patrik, 24. 11.) ukázala tři chyby, které dělaly
 * kabinu „kostrbatou":
 *
 *  1. **Kšandy měly vzorek ze spony.** První fotka kšand je detail
 *     klipu, a „největší čtverec bez pozadí" byl kus černého plastu
 *     a chromu. Béžové kšandy pak byly na modelu černobíle pruhované.
 *  2. **Zrcadlení dělalo kaleidoskop.** Dlaždice 2 × 2 ze zrcadlených
 *     kopií navazuje, ale z motýlka s uzlem udělala „oko" a z květin
 *     souměrný ornament, který na látce není.
 *  3. **Lesk a stíny z fotky byly ve vzorku.** Saténový motýlek měl ve
 *     vzorku přechod ze světla do stínu — a na modelu se pak opakoval
 *     jako pruhy, přes skutečné záhyby šablony.
 *
 * ## Jak ted
 *
 *  * Kandidáti se hledají **na všech fotkách** produktu a u kšand
 *    přednostně na pásku: dlouhý rovný pruh produktu, z něj vnitřek
 *    bez kraje. Šířka pásku je známá z katalogu (2,5 / 3,5 / 4 cm),
 *    takže je přesně známé i měřítko.
 *  * U motýlka se bere křídlo, ne střed s uzlem.
 *  * Každý kandidát dostane skóre: barva podle názvu („Béžové kšandy"
 *    nejsou černé), kov a lesk (šedá bez sytosti, ostré světlo), a
 *    nerovnoměrné světlo (záhyby a stíny se poznají podle rozdílu
 *    průměrů velkých bloků — vzor se v bloku zprůměruje, záhyb ne).
 *  * Vybraný výřez se **vyrovná**: nízké frekvence jasu (stín, lesk) se
 *    odečtou, vzor zůstane. Světlo dodá až šablona na modelu.
 *  * Dlaždice bez švů prolnutím s posunutou kopií (ne zrcadlením).
 */

export interface Latka {
  /** Dlaždice, která navazuje na všech stranách. */
  obraz: Obraz;
  /** Kolik centimetrů látky dlaždice na šířku ukazuje. */
  cm: number;
  /** Průměrná barva vybraného výřezu. */
  hex: string;
  /** Jak moc výběru věřit (0–1) — pro okno a pro rozhodnutí o AI. */
  jistota: number;
  /** Co se vybralo, česky (pro okno a zkoušky). */
  popis: string;
  /** Odkud: pořadí fotky a obdélník v jejích bodech. */
  kde: { foto: number; x: number; y: number; w: number; h: number };
}

/* ------------------------------------------------------------- barvy */

const hexNaRgb = (hex: string): [number, number, number] =>
  [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];

export function rgbNaHex(rgb: number[]): string {
  return '#' + rgb.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
}

const bezDiakritiky = (t: string) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/*
 * Barvy podle názvu. Pořadí je důležité: „tmavě modrá" se musí poznat
 * dřív než „modrá", „starorůžová" dřív než „růžová".
 */
const BARVY_NAZVU: [RegExp, string][] = [
  [/tmave ?modr|namornick|navy/, '#1f2d4d'],
  [/svetle ?modr|nebesk|baby ?blue/, '#8fb3dc'],
  [/kralovsk|kobalt/, '#2a46b4'],
  [/chrp/, '#5b74c8'],
  [/tyrkys/, '#2fb5b5'],
  [/petrolej/, '#1f5f6b'],
  [/modr/, '#2d4a8c'],
  [/tmave ?sed|antracit|grafit/, '#3e4146'],
  [/svetle ?sed|stribr/, '#b4b7bb'],
  [/sed/, '#76797e'],
  [/cern/, '#1b1b1d'],
  [/bil|ecru|smetan|krem/, '#f1ede3'],
  [/bez|pisk|kava s mlek/, '#d8c9a8'],
  [/bordo|vinov|burgund/, '#6d1a2a'],
  [/cihl|terakot|rezav/, '#b35a34'],
  [/cerven/, '#b3202c'],
  [/starorůž|starorui|staroruz|pudrov/, '#c99a9a'],
  [/ruzov|fuchsi|malinov/, '#e07fa0'],
  [/levand|lil/, '#b39ad6'],
  [/fial|svestk|lilk/, '#7d5a9a'],
  [/mint/, '#9ad5bf'],
  [/smaragd/, '#11806a'],
  [/salvej/, '#9bae95'],
  [/oliv|khaki/, '#6b6b3a'],
  [/lahv|tmave ?zelen/, '#1f4a35'],
  [/zelen/, '#3c7a4a'],
  [/horcic/, '#cf9f1c'],
  [/kanar|citron/, '#f2cf1d'],
  [/zlut/, '#e8c21f'],
  [/zlat/, '#c9a548'],
  [/oranz|meruňk|merunk/, '#e07b28'],
  [/broskv|lososov|korál|koral/, '#f0a88a'],
  [/cokolad|tmave ?hned/, '#3f2a1f'],
  [/hned|kavov|karamel/, '#6b4630']
];

/**
 * Barva výrobku podle názvu — jen když je v názvu jedna hlavní barva.
 * U „barevné", „květované", „kostkované" nic: tam název barvu neříká.
 */
export function barvaZNazvu(nazev: string): [number, number, number] | null {
  const t = bezDiakritiky(nazev);
  if (/barevn|kvet|kvetin|kostk|kar[oa]|vzor|ornament|paisley|pruh|duh/.test(t)) {
    /* Vzor — ale první slovo názvu často pořád říká podkladovou barvu („Bordó … s puntíky") */
    const prvni = t.split(/\s+/)[0] || '';
    for (const [re, hex] of BARVY_NAZVU) if (re.test(prvni)) return hexNaRgb(hex);
    return null;
  }
  for (const [re, hex] of BARVY_NAZVU) if (re.test(t)) return hexNaRgb(hex);
  return null;
}

/** Rozdíl barev přibližně tak, jak ho vidí oko (vážené RGB, „redmean"). */
export function rozdilBarev(a: number[], b: number[]): number {
  const r = (a[0] + b[0]) / 2;
  const dr = a[0] - b[0]; const dg = a[1] - b[1]; const db = a[2] - b[2];
  return Math.sqrt((2 + r / 256) * dr * dr + 4 * dg * dg + (2 + (255 - r) / 256) * db * db);
}

/* ---------------------------------------------------------- pomůcky */

interface Obd { x: number; y: number; w: number; h: number }

function vyrizni(o: Obraz, r: Obd): Obraz {
  const out = novyObraz(r.w, r.h);
  for (let y = 0; y < r.h; y++) {
    const z = ((r.y + y) * o.sirka + r.x) * 4;
    out.body.set(o.body.subarray(z, z + r.w * 4), y * r.w * 4);
  }
  return out;
}

function prumernaBarva(o: Obraz): [number, number, number] {
  let r = 0; let g = 0; let b = 0;
  const n = o.sirka * o.vyska;
  for (let i = 0; i < o.body.length; i += 4) { r += o.body[i]; g += o.body[i + 1]; b += o.body[i + 2]; }
  return [r / n, g / n, b / n];
}

/** Integrální obraz masky — kolik pozadí je v obdélníku, za konstantní čas. */
function integral(maska: Uint8Array, sirka: number, vyska: number): Int32Array {
  const I = new Int32Array((sirka + 1) * (vyska + 1));
  for (let y = 0; y < vyska; y++) {
    let radek = 0;
    for (let x = 0; x < sirka; x++) {
      radek += maska[y * sirka + x] ? 1 : 0;
      I[(y + 1) * (sirka + 1) + x + 1] = I[y * (sirka + 1) + x + 1] + radek;
    }
  }
  return I;
}
const soucet = (I: Int32Array, sirka: number, r: Obd) => {
  const s = sirka + 1;
  return I[(r.y + r.h) * s + r.x + r.w] - I[r.y * s + r.x + r.w] - I[(r.y + r.h) * s + r.x] + I[r.y * s + r.x];
};

/**
 * Hodnocení výřezu — čím menší, tím lepší.
 *
 *  * **barva**: rozdíl od barvy z názvu (když ji název říká),
 *  * **kov**: podíl bodů bez sytosti, které jsou buď velmi světlé, nebo
 *    velmi tmavé — chrom a černý plast spony; u barevného výrobku je to
 *    skoro jistě něco, co látka není,
 *  * **světlo**: rozptyl jasu mezi bloky 4 × 4 — vzor se v bloku
 *    zprůměruje, záhyb nebo lesk ne.
 */
export function hodnoceni(vyrez: Obraz, ocekavana: number[] | null): { skore: number; kov: number; svetlo: number; barva: number } {
  const { sirka, vyska, body } = vyrez;
  let kov = 0;
  const bloky = new Float64Array(16);
  const pocty = new Float64Array(16);
  for (let y = 0; y < vyska; y++) {
    for (let x = 0; x < sirka; x++) {
      const k = (y * sirka + x) * 4;
      const r = body[k]; const g = body[k + 1]; const b = body[k + 2];
      const max = Math.max(r, g, b); const min = Math.min(r, g, b);
      const sytost = max ? (max - min) / max : 0;
      if (sytost < 0.12 && (max > 215 || max < 38)) kov += 1;
      const jas = 0.299 * r + 0.587 * g + 0.114 * b;
      const bi = Math.min(3, Math.floor((y * 4) / vyska)) * 4 + Math.min(3, Math.floor((x * 4) / sirka));
      bloky[bi] += jas; pocty[bi] += 1;
    }
  }
  const n = sirka * vyska;
  let s = 0; let s2 = 0;
  for (let i = 0; i < 16; i++) { const m = bloky[i] / Math.max(1, pocty[i]); s += m; s2 += m * m; }
  const svetlo = Math.sqrt(Math.max(0, s2 / 16 - (s / 16) ** 2));
  const prumer = prumernaBarva(vyrez);
  const barva = ocekavana ? rozdilBarev(prumer, ocekavana) : 0;
  /* Barevný výrobek: kov je cizí. Bílý nebo černý: světlé/tmavé body jsou látka */
  const sedy = ocekavana ? (Math.max(...ocekavana) - Math.min(...ocekavana)) < 40 : false;
  const kovPodil = sedy ? 0 : kov / n;
  return {
    skore: barva * 1.0 + kovPodil * 400 + svetlo * 2.2,
    kov: kovPodil, svetlo, barva
  };
}

/* --------------------------------------------------------- kandidáti */

interface Kandidat { foto: number; r: Obd; cmNaBod: number; popis: string; bonus: number }

/*
 * Fotka s modelem (košile, sako, interiér) je pro výřez látky horší než
 * produktová na bílém: obrys výrobku na ní nejde poznat a „pásek" se
 * snadno najde v rukávu. Pozná se podle toho, kolik je na ní pozadí.
 */
const POKUTA_FOTKY_S_MODELEM = 60;

/**
 * Pásky kšand: sloupce (nebo řádky), kde je produkt v dlouhém souvislém
 * úseku. Vedle sebe ležící takové sloupce tvoří pásek; jeho šířka je
 * šířka kšand z katalogu, a tím je dané měřítko.
 */
function pasky(maska: Uint8Array, sirka: number, vyska: number, sirkaCm: number, otoceno: boolean): { r: Obd; sirkaPasku: number }[] {
  const W = otoceno ? vyska : sirka;
  const H = otoceno ? sirka : vyska;
  const je = (x: number, y: number) => (otoceno ? maska[x * sirka + y] : maska[y * sirka + x]) !== 0;
  /* Nejdelší souvislý úsek produktu v každém sloupci */
  const delka = new Int32Array(W); const od = new Int32Array(W);
  for (let x = 0; x < W; x++) {
    let nej = 0; let nejOd = 0; let ted = 0; let tedOd = 0;
    for (let y = 0; y < H; y++) {
      if (je(x, y)) { if (!ted) tedOd = y; ted += 1; if (ted > nej) { nej = ted; nejOd = tedOd; } } else ted = 0;
    }
    delka[x] = nej; od[x] = nejOd;
  }
  const prah = H * 0.35;
  const out: { r: Obd; sirkaPasku: number }[] = [];
  let x = 0;
  while (x < W) {
    if (delka[x] < prah) { x += 1; continue; }
    let x2 = x;
    while (x2 + 1 < W && delka[x2 + 1] >= prah) x2 += 1;
    /*
     * Jádro pásku: sloupce, které jdou skoro celou jeho délkou. Kraje pásu
     * bývají „zakousnuté" motýlkem nebo očkem spony a jejich kratší úsek
     * by pásek zkrátil pod práh.
     */
    const pasDelka = Math.max(...Array.from(delka.subarray(x, x2 + 1)));
    const pasX = x2;
    while (x <= x2 && delka[x] < pasDelka * 0.8) x += 1;
    while (x2 >= x && delka[x2] < pasDelka * 0.8) x2 -= 1;
    if (x2 < x) { x = pasX + 1; continue; }
    const sirkaPasku = x2 - x + 1;
    /* Pásek je úzký proti své délce — široký blok je jiný kus (motýlek, krabička) */
    const delkaPasku = Math.min(...Array.from(delka.subarray(x, x2 + 1)));
    if (sirkaPasku >= 6 && sirkaPasku * 4.5 < delkaPasku) {
      const y0 = Math.max(...Array.from(od.subarray(x, x2 + 1)));
      const y1 = Math.min(...Array.from({ length: sirkaPasku }, (_, i) => od[x + i] + delka[x + i]));
      /* Vnitřek pásku: bez prošitého kraje */
      const okraj = Math.max(1, Math.round(sirkaPasku * 0.15));
      const sirkaVyrezu = sirkaPasku - 2 * okraj;
      const vyska2 = Math.min(y1 - y0, Math.round(sirkaVyrezu * 2.2));
      if (sirkaVyrezu >= 4 && vyska2 >= sirkaVyrezu) {
        /* Několik poloh podél pásku — vybere se ta s nejrovnějším světlem a bez motýlka */
        const kroku = 6;
        for (let k = 0; k < kroku; k++) {
          const y = Math.round(y0 + ((y1 - y0 - vyska2) * (k + 0.5)) / kroku);
          const r = { x: x + okraj, y, w: sirkaVyrezu, h: vyska2 };
          out.push({ r: otoceno ? { x: r.y, y: r.x, w: r.h, h: r.w } : r, sirkaPasku });
        }
      }
    }
    x = pasX + 1;
  }
  void sirkaCm;
  return out;
}

/** Je pásek osamocený? Těsně vedle něj má být pozadí — jinak je přes něj motýlek. */
function osamoceny(maska: Uint8Array, sirka: number, r: Obd, svisle: boolean, sirkaPasku: number): boolean {
  const odstup = Math.max(2, Math.round(sirkaPasku * 0.3)) + Math.round(sirkaPasku * 0.15);
  let venku = 0; let n = 0;
  if (svisle) {
    for (let y = r.y; y < r.y + r.h; y++) {
      for (const x of [r.x - odstup, r.x + r.w - 1 + odstup]) {
        if (x < 0 || x >= sirka) continue;
        n += 1; if (!maska[y * sirka + x]) venku += 1;
      }
    }
  } else {
    for (let x = r.x; x < r.x + r.w; x++) {
      for (const y of [r.y - odstup, r.y + r.h - 1 + odstup]) {
        if (y < 0 || y * sirka >= maska.length) continue;
        n += 1; if (!maska[y * sirka + x]) venku += 1;
      }
    }
  }
  return n > 0 && venku / n > 0.8;
}

/**
 * Najde látku pro kus na fotkách.
 *
 * `fotky` v plném rozlišení, `nazev` kvůli barvě, `ignoruj` = obdélníky
 * (v dílech fotky), kde látka hledaného kusu není — u sady pásky kšand,
 * když se hledá motýlek.
 */
export function najdiLatku(
  fotky: Obraz[],
  typ: ZkVrstvaTyp | '',
  varianta: string,
  nazev: string,
  moznosti: { barva?: number[] | null; jenKus?: 'motylek' | 'pasek' } = {}
): Latka | null {
  const ocekavana = moznosti.barva !== undefined ? moznosti.barva : barvaZNazvu(nazev);
  const motylek = typ === 'kravata' && varianta.startsWith('motylek');
  const ksandy = typ === 'ksandy';
  const kandidati: Kandidat[] = [];
  const mensi: Obraz[] = [];
  const masky: Uint8Array[] = [];

  fotky.forEach((foto, fi) => {
    const m = zmensi(foto, Math.max(1, Math.round(foto.sirka / 600)));
    mensi.push(m);
    const pozadi = pozadiOdKraje(m);
    const maska = new Uint8Array(pozadi.length);
    for (let i = 0; i < maska.length; i++) maska[i] = pozadi[i] ? 0 : 255;
    masky.push(maska);
    const I = integral(pozadi, m.sirka, m.vyska);
    let pozadiPodil = 0;
    for (let i = 0; i < pozadi.length; i++) if (pozadi[i]) pozadiPodil += 1;
    pozadiPodil /= pozadi.length;
    const pokutaFotky = pozadiPodil < 0.3 ? POKUTA_FOTKY_S_MODELEM : 0;
    const pocatek = kandidati.length;
    const bezPozadi = (r: Obd) => soucet(I, m.sirka, r) / (r.w * r.h) <= 0.01;

    /*
     * Maska barvy z názvu: na fotce s modelem nebo u sady, kde je motýlek
     * jiné barvy, odliší pásek kšand od košile a od motýlka líp než
     * obrys výrobku (pásek na košili obrys nemá).
     */
    const barevna = ocekavana ? (() => {
      const b = new Uint8Array(maska.length);
      for (let i = 0; i < b.length; i++) {
        const k = i * 4;
        b[i] = rozdilBarev([m.body[k], m.body[k + 1], m.body[k + 2]], ocekavana) < 95 ? 255 : 0;
      }
      return b;
    })() : null;

    /* Kšandy: pásek */
    if ((ksandy && moznosti.jenKus !== 'motylek') || moznosti.jenKus === 'pasek') {
      const s = sablonaPro('ksandy', varianta || 'siroke');
      const sirkaCm = s?.sirkaCm ?? 3.5;
      for (const [mm, popis] of [[maska, 'pásek kšand'], [barevna, 'pásek kšand podle barvy']] as [Uint8Array | null, string][]) {
        if (!mm) continue;
        for (const svisle of [true, false]) {
          for (const p of pasky(mm, m.sirka, m.vyska, sirkaCm, !svisle)) {
            if (mm === maska && !bezPozadi(p.r)) continue;
            const sam = osamoceny(mm, m.sirka, p.r, svisle, p.sirkaPasku);
            /* Vodorovný „pásek" bez okolí je skoro vždycky motýlek — kšandy se fotí svisle */
            if (!svisle && !sam) continue;
            kandidati.push({
              foto: fi, r: p.r, cmNaBod: sirkaCm / p.sirkaPasku,
              popis, bonus: (sam ? -40 : 25) + (svisle ? 0 : 15)
            });
          }
        }
      }
    }

    /* Motýlek: křídlo — ne uzel uprostřed, ne pásek kšand, který jde za ním */
    if ((motylek && moznosti.jenKus !== 'pasek') || moznosti.jenKus === 'motylek') {
      const delky = new Int32Array(m.sirka);
      for (let x = 0; x < m.sirka; x++) {
        let ted = 0; let nej = 0;
        for (let y = 0; y < m.vyska; y++) { if (maska[y * m.sirka + x]) { ted += 1; nej = Math.max(nej, ted); } else ted = 0; }
        delky[x] = nej;
      }
      const pasekSloupec = (x: number) => delky[x] > m.vyska * 0.5;
      const sirkaRadku = (y: number) => {
        let n = 0;
        for (let x = 0; x < m.sirka; x++) if (maska[y * m.sirka + x] && !pasekSloupec(x)) n += 1;
        return n;
      };
      let nejSirsi = 0; let radek = -1;
      for (let y = 0; y < m.vyska; y++) { const n = sirkaRadku(y); if (n > nejSirsi) { nejSirsi = n; radek = y; } }
      if (radek >= 0 && nejSirsi > 20) {
        let y0 = radek; let y1 = radek;
        while (y0 > 0 && sirkaRadku(y0 - 1) > nejSirsi * 0.5) y0 -= 1;
        while (y1 < m.vyska - 1 && sirkaRadku(y1 + 1) > nejSirsi * 0.5) y1 += 1;
        let x0 = m.sirka; let x1 = -1;
        for (let x = 0; x < m.sirka; x++) if (maska[radek * m.sirka + x]) { x0 = Math.min(x0, x); x1 = x; }
        const w = x1 - x0; const h = y1 - y0;
        if (w > 20 && h > 10) {
          const s = sablonaPro('kravata', varianta.startsWith('motylek') ? varianta : 'motylek');
          const zaklad = Math.round(Math.min(h * 0.45, w * 0.16));
          for (const strana of [zaklad, Math.round(zaklad * 0.75), Math.round(zaklad * 0.55)]) {
            if (strana < 10) continue;
            for (let kde = 0.08; kde <= 0.921; kde += 0.04) {
              /* Uzel uprostřed vynechat */
              if (Math.abs(kde - 0.5) < 0.1) continue;
              for (const vy of [0.4, 0.5, 0.6]) {
                const r = { x: Math.round(x0 + w * kde - strana / 2), y: Math.round(y0 + h * vy - strana / 2), w: strana, h: strana };
                if (r.x < 0 || r.y < 0 || r.x + r.w > m.sirka || r.y + r.h > m.vyska) continue;
                if (!bezPozadi(r)) continue;
                let pasek = 0;
                for (let x = r.x; x < r.x + r.w; x++) if (pasekSloupec(x)) pasek += 1;
                if (pasek > 0) continue;
                kandidati.push({ foto: fi, r, cmNaBod: (s?.sirkaCm ?? 12) / Math.max(1, w), popis: 'křídlo motýlka', bonus: -10 });
              }
            }
          }
        }
      }
    }

    for (let i = pocatek; i < kandidati.length; i++) kandidati[i].bonus += pokutaFotky;

    /* Obecně: čtverce plně na výrobku, po mřížce */
    if (!moznosti.jenKus) {
      const typicky: Record<string, number> = { kravata: 40, ksandy: 30, kapesnicek: 24 };
      const naCm = (typicky[typ] ?? 32) * (m.sirka / 600);
      for (const strana of [128, 96, 72, 52, 36]) {
        const krok = Math.max(6, Math.round(strana / 3));
        for (let y = 0; y + strana <= m.vyska; y += krok) {
          for (let x = 0; x + strana <= m.sirka; x += krok) {
            const r = { x, y, w: strana, h: strana };
            if (!bezPozadi(r)) continue;
            kandidati.push({ foto: fi, r, cmNaBod: 1 / naCm, popis: 'čtverec látky', bonus: (ksandy ? 30 : 0) + pokutaFotky });
          }
        }
      }
    }
  });

  if (!kandidati.length) return null;
  /* Ohodnocení — u velkého počtu čtverců jen vzorek, ať to netrvá */
  const vyber = kandidati.length > 400
    ? kandidati.filter((_, i) => i % Math.ceil(kandidati.length / 400) === 0 || kandidati[i].popis !== 'čtverec látky')
    : kandidati;
  let nej: { k: Kandidat; skore: number; h: ReturnType<typeof hodnoceni> } | null = null;
  for (const k of vyber) {
    const h = hodnoceni(vyrizni(mensi[k.foto], k.r), ocekavana);
    /* Úplně jiná barva, než říká název (košile místo bordó kšand) — jen když není nic lepšího */
    if (ocekavana && h.barva > 170) { if (!nej) nej = { k, skore: 1e9, h }; continue; }
    /* Větší výřez je lepší — víc vzoru, méně opakování */
    const velikost = -Math.min(30, Math.sqrt(k.r.w * k.r.h) / 4);
    const skore = h.skore + k.bonus + velikost;
    if (!nej || skore < nej.skore) nej = { k, skore, h };
  }
  if (!nej) return null;

  /* Výřez z plného rozlišení */
  const foto = fotky[nej.k.foto];
  const meritko = foto.sirka / mensi[nej.k.foto].sirka;
  const r = nej.k.r;
  const kde = {
    x: Math.round(r.x * meritko), y: Math.round(r.y * meritko),
    w: Math.max(4, Math.min(foto.sirka - Math.round(r.x * meritko), Math.round(r.w * meritko))),
    h: Math.max(4, Math.min(foto.vyska - Math.round(r.y * meritko), Math.round(r.h * meritko)))
  };
  const plne = vyrizni(foto, kde);
  const vyrovnany = vyrovnejSvetlo(plne);
  const k = Math.min(1, 200 / Math.max(vyrovnany.sirka, vyrovnany.vyska));
  const finalni = k < 1
    ? prevzorkuj(vyrovnany, Math.max(4, Math.round(vyrovnany.sirka * k)), Math.max(4, Math.round(vyrovnany.vyska * k)))
    : vyrovnany;
  const dlazdice = bezSvu(finalni);
  const cm = Math.round(r.w * nej.k.cmNaBod * 100) / 100;
  const jistota = Math.max(0, Math.min(1, 1 - (nej.h.barva / 220) - nej.h.kov * 2 - nej.h.svetlo / 60));
  return { obraz: dlazdice, cm, hex: rgbNaHex(prumernaBarva(vyrovnany)), jistota, popis: nej.k.popis, kde: { foto: nej.k.foto, ...kde } };
}

/* ------------------------------------------------------ úprava výřezu */

function rozmazJas(jas: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    let s = 0; let n = 0;
    for (let x = -r; x < w + r; x++) {
      const pridat = x + r; const ubrat = x - r - 1;
      if (pridat >= 0 && pridat < w) { s += jas[y * w + pridat]; n += 1; }
      if (ubrat >= 0 && ubrat < w) { s -= jas[y * w + ubrat]; n -= 1; }
      if (x >= 0 && x < w) tmp[y * w + x] = s / Math.max(1, n);
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0; let n = 0;
    for (let y = -r; y < h + r; y++) {
      const pridat = y + r; const ubrat = y - r - 1;
      if (pridat >= 0 && pridat < h) { s += tmp[pridat * w + x]; n += 1; }
      if (ubrat >= 0 && ubrat < h) { s -= tmp[ubrat * w + x]; n -= 1; }
      if (y >= 0 && y < h) out[y * w + x] = s / Math.max(1, n);
    }
  }
  return out;
}

/**
 * Vyrovná světlo: odečte velké přechody jasu (stín, lesk, záhyb), vzor
 * nechá. Záhyby a světlo kreslí šablona na modelu — kdyby zůstaly i ve
 * vzorku, opakovaly by se po celé kravatě jako pruhy.
 */
export function vyrovnejSvetlo(o: Obraz, sila = 0.85): Obraz {
  const { sirka: w, vyska: h } = o;
  const jas = new Float32Array(w * h);
  let suma = 0;
  for (let i = 0; i < w * h; i++) {
    const k = i * 4;
    jas[i] = 0.299 * o.body[k] + 0.587 * o.body[k + 1] + 0.114 * o.body[k + 2] + 1;
    suma += jas[i];
  }
  const prumer = suma / (w * h);
  const r = Math.max(3, Math.round(Math.min(w, h) / 4));
  /* Dvakrát rozmazat ≈ Gauss: bez toho by na přechodech zůstaly hrany */
  const rozmazany = rozmazJas(rozmazJas(jas, w, h, r), w, h, r);
  const out = novyObraz(w, h);
  for (let i = 0; i < w * h; i++) {
    const k = i * 4;
    const f = Math.max(0.72, Math.min(1.4, prumer / rozmazany[i]));
    const g = 1 + sila * (f - 1);
    out.body[k] = Math.min(255, o.body[k] * g);
    out.body[k + 1] = Math.min(255, o.body[k + 1] * g);
    out.body[k + 2] = Math.min(255, o.body[k + 2] * g);
    out.body[k + 3] = 255;
  }
  return out;
}

/**
 * Dlaždice bez švů: výřez se prolne se svou kopií posunutou o půlku.
 *
 * Na krajích výřezu má váhu kopie (ta je tam souvislá přes hranu
 * dlaždice), uprostřed původní výřez. Žádné zrcadlení — vzor zůstane,
 * jaký je, jen bez viditelného švu.
 */
export function bezSvu(o: Obraz): Obraz {
  const { sirka: w, vyska: h } = o;
  const out = novyObraz(w, h);
  const hw = Math.floor(w / 2); const hh = Math.floor(h / 2);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = (x + hw) % w; const sy = (y + hh) % h;
      const a = Math.min(x, w - 1 - x, y, h - 1 - y) + 1;
      const b = Math.min(sx, w - 1 - sx, sy, h - 1 - sy) + 1;
      const wa = a ** 3; const wb = b ** 3;
      const k = (y * w + x) * 4; const z = (sy * w + sx) * 4;
      for (let j = 0; j < 3; j++) out.body[k + j] = (o.body[k + j] * wa + o.body[z + j] * wb) / (wa + wb);
      out.body[k + 3] = 255;
    }
  }
  return out;
}

export const __test = { pasky, hodnoceni, barvaZNazvu, bezSvu, vyrovnejSvetlo };
