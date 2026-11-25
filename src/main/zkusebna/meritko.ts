import { Obraz, novyObraz } from './png';
import * as px from './pixely';

/**
 * Měřítko vzoru z fotky — kolik bodů fotky je jeden centimetr látky.
 *
 * ## Proč
 *
 * Patrik (25. 11.): „AI by měla dávat větší pozor i na velikost vzoru,
 * jak se opakuje v reálu… na první pohled to vypadá ok, ale v detailu to
 * úplně neodpovídá". Velikost vzoru na modelu stojí na jednom čísle:
 * kolik centimetrů látky ukazuje vzorek. U kravat se to dosud **hádalo**
 * („40 bodů na centimetr při šířce fotky 600") nebo to odhadla AI
 * od oka — obojí se snadno splete o třetinu, a pak jsou květy na modelu
 * o třetinu větší nebo menší.
 *
 * ## Jak
 *
 * Skutečný rozměr výrobku je známý (šířka kravaty a kšand z katalogu,
 * rozpětí motýlka, strana kapesníčku). AI s viděním na fotce ukáže, kde
 * se dá změřit (přes list kravaty v nejširším místě, přes pásek kšand,
 * od křídla ke křídlu motýlka). **Měří se ale v bodech fotky**, ne od oka:
 *
 *  * u pruhu (list kravaty, pásek) se přes ukázaný bod hledá nejkratší
 *    tětiva výrobku ve všech směrech — to je kolmice na hrany, tedy
 *    šířka; u kravaty se ještě posune po listu k nejširšímu místu,
 *  * u rozpětí (motýlek, kapesníček) se měří souvislý úsek výrobku na
 *    ukázané přímce.
 *
 * Když měření s ukázanou čarou nesouhlasí (bílý vzor splynul s pozadím,
 * stočená kravata), vezme se délka čáry od AI — a ví se o tom.
 *
 * Z tětivy je známý i **směr listu**: vzorek se pak vyřízne otočený tak,
 * aby list šel svisle, jako na modelu. Proužky na kravatě vyfocené
 * šikmo tak nejsou na modelu pootočené.
 */

export interface Mereni {
  /** Bodů fotky na centimetr látky. */
  bodyNaCm: number;
  /** Změřená šířka (rozpětí) v bodech. */
  bodu: number;
  /** Směr listu / pásku v radiánech (0 = svisle dolů po obrázku); u rozpětí směr čáry. */
  uhel: number;
  /** Střed měření v bodech fotky. */
  stred: { x: number; y: number };
  /** Změřeno z pixelů (true), nebo jen délka čáry od AI (false). */
  zMereni: boolean;
}

/**
 * Výrobek na fotce jako maska — bez pozadí, s dírami zavřenými (bílý vzor
 * u kraje).
 *
 * Doplnění od kraje se umí „prolít" měkkou hranou do tmavého pásku
 * (revize fotky DST70BA03: pravý pásek kšand vyšel jako pozadí). Pro
 * měření proto platí i opačná cesta: co je od barvy pozadí daleko, je
 * výrobek, ať doplnění řeklo cokoli.
 */
export function maskaVyrobku(fotka: Obraz, pozadi: Uint8Array): Uint8Array {
  const kraj = px.barvyKraje(fotka);
  const bg = kraj.barvy[0] ?? [255, 255, 255];
  const m = new Uint8Array(pozadi.length);
  for (let i = 0; i < m.length; i++) {
    const k = i * 4;
    const daleko = Math.abs(fotka.body[k] - bg[0]) + Math.abs(fotka.body[k + 1] - bg[1]) + Math.abs(fotka.body[k + 2] - bg[2]) > 90;
    m[i] = !pozadi[i] || daleko ? 255 : 0;
  }
  return px.zavriDiry(m, fotka.sirka, fotka.vyska, Math.max(2, Math.round(Math.min(fotka.sirka, fotka.vyska) / 300)));
}

/** Délka souvislého úseku masky bodem `s` ve směru (ux, uy) — na obě strany. */
export function tetiva(maska: Uint8Array, w: number, h: number, sx: number, sy: number, ux: number, uy: number, max = 4000): number {
  const uvnitr = (x: number, y: number) => {
    const xi = Math.round(x); const yi = Math.round(y);
    return xi >= 0 && yi >= 0 && xi < w && yi < h && maska[yi * w + xi] > 0;
  };
  if (!uvnitr(sx, sy)) return 0;
  let a = 0; while (a < max && uvnitr(sx + ux * (a + 1), sy + uy * (a + 1))) a += 1;
  let b = 0; while (b < max && uvnitr(sx - ux * (b + 1), sy - uy * (b + 1))) b += 1;
  return a + b + 1;
}

/** Nejkratší tětiva bodem — šířka pruhu a její směr. */
export function sirkaVBode(maska: Uint8Array, w: number, h: number, sx: number, sy: number): { delka: number; uhel: number } {
  let nej = { delka: Infinity, uhel: 0 };
  for (let st = 0; st < 180; st += 3) {
    const a = (st * Math.PI) / 180;
    const d = tetiva(maska, w, h, sx, sy, Math.cos(a), Math.sin(a));
    if (d > 0 && d < nej.delka) nej = { delka: d, uhel: a };
  }
  return Number.isFinite(nej.delka) ? nej : { delka: 0, uhel: 0 };
}

/**
 * Změří měřítko na fotce podle čáry od AI.
 *
 * `cara` = [x1, y1, x2, y2] v dílech fotky, `cm` = skutečná délka toho,
 * přes co čára vede. `druh`: 'pruh' (kravata, pásek — měří se kolmice),
 * 'list' (kravata — kolmice v nejširším místě poblíž), 'rozpeti' (čára
 * sama, motýlek a kapesníček).
 */
export function zmerMeritko(
  fotka: Obraz,
  maska: Uint8Array,
  cara: number[],
  cm: number,
  druh: 'pruh' | 'list' | 'rozpeti'
): Mereni | null {
  if (cara.length !== 4 || cm <= 0) return null;
  const { sirka: w, vyska: h } = fotka;
  const x1 = cara[0] * w; const y1 = cara[1] * h; const x2 = cara[2] * w; const y2 = cara[3] * h;
  const delkaAi = Math.hypot(x2 - x1, y2 - y1);
  if (delkaAi < 8) return null;
  const sx = (x1 + x2) / 2; const sy = (y1 + y2) / 2;
  const ux = (x2 - x1) / delkaAi; const uy = (y2 - y1) / delkaAi;
  const zAi = (): Mereni => ({
    bodyNaCm: delkaAi / cm, bodu: delkaAi,
    /* Osa „dolů" je (sin u, cos u); u pruhu kolmo na čáru přes něj */
    uhel: druh === 'rozpeti' ? Math.atan2(ux, uy) : -Math.atan2(uy, ux),
    stred: { x: sx, y: sy }, zMereni: false
  });
  /* Bod musí být na výrobku; když není (AI se o kus netrefila), zkusí se okolí na čáře */
  let bx = sx; let by = sy;
  if (!maska[Math.round(by) * w + Math.round(bx)]) {
    let nalez = false;
    for (let t = -0.3; t <= 0.3 && !nalez; t += 0.05) {
      const x = sx + ux * delkaAi * t; const y = sy + uy * delkaAi * t;
      if (maska[Math.round(y) * w + Math.round(x)]) { bx = x; by = y; nalez = true; }
    }
    if (!nalez) return zAi();
  }

  if (druh === 'rozpeti') {
    const d = tetiva(maska, w, h, bx, by, ux, uy);
    if (d < delkaAi * 0.75 || d > delkaAi * 1.3) return zAi();
    return { bodyNaCm: d / cm, bodu: d, uhel: Math.atan2(ux, uy), stred: { x: bx, y: by }, zMereni: true };
  }

  let nej = sirkaVBode(maska, w, h, bx, by);
  let stred = { x: bx, y: by };
  if (druh === 'list' && nej.delka > 0) {
    /*
     * Kravata se zužuje ke krku — AI ukáže „u špičky", ale o kus vedle.
     * Po ose listu se hledá nejširší místo poblíž (do ±půl šířky).
     */
    const osaX = -Math.sin(nej.uhel); const osaY = Math.cos(nej.uhel);
    for (let t = -0.6; t <= 0.6; t += 0.1) {
      const x = bx + osaX * nej.delka * t; const y = by + osaY * nej.delka * t;
      const s = sirkaVBode(maska, w, h, x, y);
      if (s.delka > nej.delka && s.delka <= delkaAi * 1.3) { nej = s; stred = { x, y }; }
    }
  }
  if (nej.delka < delkaAi * 0.6 || nej.delka > delkaAi * 1.3) return zAi();
  return {
    bodyNaCm: nej.delka / cm, bodu: nej.delka,
    /* Osa pruhu je kolmo na nejkratší tětivu (cos a, sin a) → (−sin a, cos a) */
    uhel: -nej.uhel,
    stred, zMereni: true
  };
}

/**
 * Výřez otočený o `uhel` kolem středu — `w` napříč, `h` po ose.
 * Bilineárně; mimo fotku průhledné.
 */
export function vyrizniOtocene(o: Obraz, stred: { x: number; y: number }, uhel: number, w: number, h: number): Obraz {
  const W = Math.max(1, Math.round(w)); const H = Math.max(1, Math.round(h));
  const out = novyObraz(W, H);
  /* Osa výřezu „dolů" = směr uhel (0 = svisle dolů po fotce) */
  const dx = Math.sin(uhel); const dy = Math.cos(uhel);
  const nx = dy; const ny = -dx;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = x - W / 2 + 0.5; const v = y - H / 2 + 0.5;
      const fx = stred.x + nx * u + dx * v; const fy = stred.y + ny * u + dy * v;
      const x0 = Math.floor(fx); const y0 = Math.floor(fy);
      if (x0 < 0 || y0 < 0 || x0 + 1 >= o.sirka || y0 + 1 >= o.vyska) continue;
      const tx = fx - x0; const ty = fy - y0;
      const i = (y * W + x) * 4;
      for (let c = 0; c < 4; c++) {
        const a = o.body[(y0 * o.sirka + x0) * 4 + c]; const b = o.body[(y0 * o.sirka + x0 + 1) * 4 + c];
        const d = o.body[((y0 + 1) * o.sirka + x0) * 4 + c]; const e = o.body[((y0 + 1) * o.sirka + x0 + 1) * 4 + c];
        out.body[i + c] = Math.round((a * (1 - tx) + b * tx) * (1 - ty) + (d * (1 - tx) + e * tx) * ty);
      }
    }
  }
  return out;
}

/** Kolik výřezu leží mimo výrobek (0–1). */
export function mimoVyrobek(maska: Uint8Array, w: number, h: number, stred: { x: number; y: number }, uhel: number, sw: number, sh: number): number {
  const dx = Math.sin(uhel); const dy = Math.cos(uhel);
  const nx = dy; const ny = -dx;
  let n = 0; let mimo = 0;
  const krok = Math.max(1, Math.round(Math.min(sw, sh) / 24));
  for (let v = -sh / 2; v <= sh / 2; v += krok) {
    for (let u = -sw / 2; u <= sw / 2; u += krok) {
      const x = Math.round(stred.x + nx * u + dx * v); const y = Math.round(stred.y + ny * u + dy * v);
      n += 1;
      if (x < 0 || y < 0 || x >= w || y >= h || !maska[y * w + x]) mimo += 1;
    }
  }
  return n ? mimo / n : 1;
}

/**
 * Látka z listu nebo pásku: obdélník podél osy, otočený svisle.
 *
 * Napříč 3/4 šířky (hrany a šev zůstanou venku), po ose co nejdelší,
 * kam to jde bez pozadí — víc látky = méně viditelné opakování dlaždice.
 * Zkouší se od středu měření na obě strany osy.
 */
export function latkaZListu(fotka: Obraz, maska: Uint8Array, m: Mereni): Obraz | null {
  const sw = m.bodu * 0.72;
  let nej: { stred: { x: number; y: number }; sh: number } | null = null;
  for (const delka of [3, 2.4, 1.8, 1.3, 1]) {
    const sh = sw * delka;
    for (const posun of [0, 0.5, -0.5, 1, -1, 1.5, -1.5]) {
      const stred = { x: m.stred.x + Math.sin(m.uhel) * sh * posun * 0.5, y: m.stred.y + Math.cos(m.uhel) * sh * posun * 0.5 };
      if (mimoVyrobek(maska, fotka.sirka, fotka.vyska, stred, m.uhel, sw, sh) <= 0.01) { nej = { stred, sh }; break; }
    }
    if (nej) break;
  }
  if (!nej) return null;
  return vyrizniOtocene(fotka, nej.stred, m.uhel, sw, nej.sh);
}
