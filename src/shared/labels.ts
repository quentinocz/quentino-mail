import { LabelLayout } from './types';

/**
 * Kolik místa na štítek zbude a co se do něj vejde.
 *
 * Počítá se na obou stranách: rozhraní to ukazuje předem, sazba podle toho
 * zmenší QR, aby nic nepřeteklo. Proto to bydlí ve sdílené složce — dvě
 * kopie stejného výpočtu by se dřív nebo později rozešly a arch by vypadal
 * jinak v náhledu než na papíře.
 *
 * Proč to vůbec je: výchozí 4 × 10 na A4 dává políčko vysoké 25 mm, jenže
 * QR o 22 mm plus kód pod ním a název potřebují skoro 30. Bez tohohle
 * výpočtu se štítky ořežou — a pozná se to až po vytištění čtyřiceti archů.
 */

const A4_W = 210;
const A4_H = 297;
/** Milimetry na jeden bod písma */
const PT = 25.4 / 72;

export interface LabelGeometry {
  /** Rozměr jednoho políčka v milimetrech */
  cellW: number;
  cellH: number;
  /** Kolik svisle zaberou texty pod kódem */
  textH: number;
  /** Jak velké QR se doopravdy vytiskne */
  qr: number;
  /** Požadované QR se nevešlo a muselo se zmenšit */
  shrunk: boolean;
  /** Ani po zmenšení není QR na co číst */
  tooSmall: boolean;
  /** Kolik štítků se vejde na jednu stranu */
  perPage: number;
}

export function labelGeometry(layout: LabelLayout): LabelGeometry {
  const cols = Math.max(1, layout.cols);
  const rows = Math.max(1, layout.rows);
  const cellW = (A4_W - 2 * layout.marginSide - (cols - 1) * layout.gap) / cols;
  const cellH = (A4_H - 2 * layout.marginTop - (rows - 1) * layout.gap) / rows;

  // Kód je jeden řádek, název nejvýš dva; k tomu mezery a vnitřní okraj
  const codeH = layout.fontSize * PT * 1.1;
  const nameH = layout.withTitle ? Math.max(5, layout.fontSize - 2) * PT * 1.15 * 2 : 0;
  const textH = codeH + nameH + (layout.withTitle ? 2 : 1) + 2;

  const room = Math.min(cellW - 2, cellH - textH);
  const qr = Math.max(0, Math.min(layout.qr, room));
  return {
    cellW: round(cellW),
    cellH: round(cellH),
    textH: round(textH),
    qr: round(qr),
    shrunk: qr < layout.qr - 0.05,
    // Pod deset milimetrů běžná čtečka na kód o osmi znacích nestačí
    tooSmall: qr < 10,
    perPage: cols * rows
  };
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
