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
  /** Kolik místa má text vodorovně — u kulatých štítků je to tětiva, ne šířka */
  textW: number;
  /** Jak velké QR se doopravdy vytiskne */
  qr: number;
  /** Požadované QR se nevešlo a muselo se zmenšit */
  shrunk: boolean;
  /** Ani po zmenšení není QR na co číst */
  tooSmall: boolean;
  /** Kolik štítků se vejde na jednu stranu */
  perPage: number;
}

/** Svislá mezera; když se neurčí zvlášť, platí ta vodorovná. */
export function gapY(layout: LabelLayout): number {
  return layout.gapY ?? layout.gap;
}

/** Volný okraj uvnitř štítku — u kulatých se drží větší, tam je odchylka vidět. */
export function safeMm(layout: LabelLayout): number {
  return layout.safe ?? (layout.shape === 'round' ? 1.5 : 1);
}

export function labelGeometry(layout: LabelLayout): LabelGeometry {
  const cols = Math.max(1, layout.cols);
  const rows = Math.max(1, layout.rows);
  const cellW = (A4_W - 2 * layout.marginSide - (cols - 1) * layout.gap) / cols;
  const cellH = (A4_H - 2 * layout.marginTop - (rows - 1) * gapY(layout)) / rows;

  /*
   * Kód je jeden řádek, název nejvýš dva. Vnitřní okraj se sem nepočítá —
   * je to `safe` a odečítá se zvlášť, aby nešel do výpočtu dvakrát.
   */
  const codeH = layout.fontSize * PT * 1.1;
  const nameH = layout.withTitle ? Math.max(5, layout.fontSize - 2) * PT * 1.15 * 2 : 0;
  const textH = codeH + nameH + (layout.withTitle ? 1 : 0);
  /** Mezera mezi QR a textem — v sazbě je to `gap: 1mm` */
  const lead = 1;

  const safe = safeMm(layout);
  let room: number;
  let textW: number;

  if (layout.shape === 'round') {
    /*
     * Kulatý štítek. Do rohů políčka se tisknout nedá — QR i text musí zůstat
     * uvnitř kruhu, a to i s rezervou na to, že papír nedojede přesně.
     *
     * Blok QR + text stojí uprostřed, takže nejdál od středu jsou horní rohy
     * QR a dolní rohy textu. Pro čtvercové QR o straně `s` a celkovou výšku
     * bloku `s + k` z toho vyjde
     *
     *     (s/2)² + ((s + k)/2)² ≤ r²   →   s = (√(8r² − k²) − k) / 2
     *
     * což je největší QR, které se i s textem do kruhu vejde.
     */
    const r = Math.min(cellW, cellH) / 2 - safe;
    const k = textH + lead;
    const under = 8 * r * r - k * k;
    room = under > 0 ? (Math.sqrt(under) - k) / 2 : 0;

    // Text sedí dole, kde je kruh užší než uprostřed — šířka je tětiva
    const textMid = (room + k) / 2 - textH / 2;
    textW = 2 * Math.sqrt(Math.max(0, r * r - textMid * textMid));
  } else {
    room = Math.min(cellW - 2 * safe, cellH - 2 * safe - lead - textH);
    textW = cellW - 2 * safe;
  }

  const qr = Math.max(0, Math.min(layout.qr, room));
  return {
    cellW: round(cellW),
    cellH: round(cellH),
    textH: round(textH),
    textW: round(Math.max(0, textW)),
    qr: round(qr),
    shrunk: qr < layout.qr - 0.05,
    // Pod deset milimetrů běžná čtečka na kód o osmi znacích nestačí
    tooSmall: qr < 10,
    perPage: cols * rows
  };
}

function round(v: number): number {
  return Math.round(v * 10) / 10;
}

/* ---------- hotové archy ---------- */

export interface LabelTemplate {
  id: string;
  label: string;
  /** Krátká věta do nabídky — podle čeho arch poznat */
  note: string;
  layout: LabelLayout;
}

/**
 * Archy, které se dají koupit a jejichž rozměry známe přesně.
 *
 * Rozvržení se nedá odhadnout od oka: štítky na archu mají svoji rozteč
 * a okraje dané výsekem, a když se netrefí, tiskne se přes okraje.
 * Rozměry níž jsou změřené přímo z výrobcovy šablony.
 */
export const LABEL_TEMPLATES: LabelTemplate[] = [
  {
    id: 'a4-4x8',
    label: 'Vlastní arch 4 × 8',
    note: 'Obyčejný papír A4, štítky se stříhají. Políčko 46 × 32 mm.',
    layout: {
      cols: 4, rows: 8, marginTop: 10, marginSide: 8, gap: 3,
      qr: 18, fontSize: 9, withTitle: true, cutLines: false,
      shape: 'rect', template: 'a4-4x8'
    }
  },
  {
    /*
     * Y025025W066 — kulaté štítky Ø 25,4 mm, 66 na archu.
     *
     * Čísla jsou vytažená z výrobcovy šablony, ne odhadnutá: šest sloupců
     * s roztečí 30,48 mm, jedenáct řad na sebe navazuje bez mezery. Do
     * kruhu se s QR i kódem vejde jen krátký text, takže název produktu
     * se netiskne — kód je to jediné, co se ze štítku čte.
     */
    id: 'y025025w066',
    label: 'Kulaté Ø 25 mm · 66 na archu',
    note: 'Arch Y025025W066: 6 × 11 kulatých štítků, rozteč 30,5 × 25,4 mm.',
    layout: {
      cols: 6, rows: 11, marginTop: 8.8, marginSide: 16.1,
      gap: 5.08, gapY: 0,
      qr: 14, fontSize: 8, withTitle: false, cutLines: true,
      shape: 'round', safe: 1.5, template: 'y025025w066'
    }
  }
];

export function templateById(id: string | undefined): LabelTemplate | null {
  return LABEL_TEMPLATES.find(t => t.id === id) ?? null;
}
