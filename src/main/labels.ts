import fs from 'fs';
import path from 'path';
import { app, BrowserWindow, dialog } from 'electron';
import QRCode from 'qrcode';
import { getDb } from './db';
import { LabelLayout } from '../shared/types';
import { labelGeometry } from '../shared/labels';

/**
 * Štítky s kódem na A4.
 *
 * Zboží v e-shopu nemá čárové kódy — ve feedu je jediný neprázdný EAN
 * z dvanácti set produktů. Skenovat tedy není co, dokud si štítky
 * nevytiskneme sami. Na štítku je QR s kódem varianty a **pod ním ten kód
 * i písmem**: čtečka občas nedosáhne (zmačkaný štítek, špatné světlo) a
 * člověk si ho musí umět přečíst a napsat.
 *
 * Do QR jde holý kód, ne adresa. Kratší kód znamená menší a čitelnější
 * mřížku, a čtečka u skladu stejně nikam neproklikává. Aplikace přitom umí
 * načíst i `quentino:KÓD` a adresu produktu, takže starší štítky projdou.
 */

/*
 * Výchozí rozvržení není odhad: 4 × 8 dává na A4 políčko 46 × 32 mm, do
 * kterého se QR o 18 mm vejde i s kódem a názvem pod ním. Předchozí 4 × 10
 * vypadalo úsporněji, jenže políčko mělo jen 25 mm a QR se ořezávalo —
 * což se pozná až po vytištění.
 */
export const DEFAULT_LAYOUT: LabelLayout = {
  cols: 4,
  rows: 8,
  marginTop: 10,
  marginSide: 8,
  gap: 3,
  qr: 18,
  fontSize: 9,
  withTitle: true,
  cutLines: false
};

export interface LabelItem {
  code: string;
  title: string;
  label: string;
  /** Kolikrát se má štítek vytisknout */
  count: number;
}

function esc(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Podklady pro štítky z výběru produktů.
 *
 * Když má produkt varianty, tisknou se **varianty**, ne produkt: naskladňuje
 * se konkrétní délka, ne „kšandy". U produktu bez variant je štítek jeden.
 */
export function labelItems(codes: string[], perItem = 1): LabelItem[] {
  const d = getDb();
  const out: LabelItem[] = [];
  for (const code of codes) {
    const variants = d.prepare(
      'SELECT code, label FROM product_variants WHERE product_code = ? ORDER BY sort, code'
    ).all(code) as any[];
    const product = d.prepare('SELECT code, title_cz FROM products WHERE code = ?').get(code) as any;
    const title = product?.title_cz ?? code;

    if (variants.length > 0) {
      for (const v of variants) {
        out.push({ code: v.code, title, label: v.label ?? '', count: Math.max(1, perItem) });
      }
    } else if (product) {
      out.push({ code: product.code, title, label: '', count: Math.max(1, perItem) });
    }
  }
  return out;
}

async function sheetHtml(items: LabelItem[], layout: LabelLayout): Promise<string> {
  // Kolik se do políčka vejde, počítá sdílený výpočet — stejný, jaký v
  // rozhraní ukazuje „štítek 46 × 25 mm". QR se podle něj zmenší, místo aby
  // přeteklo přes okraj a oříznulo se
  const geom = labelGeometry(layout);
  const cells: string[] = [];
  for (const item of items) {
    const svg = await QRCode.toString(item.code, {
      type: 'svg', margin: 0, errorCorrectionLevel: 'M'
    });
    // Vlastní rozměr se řídí stylem, ne atributem v SVG
    const qr = svg.replace(/<svg([^>]*)>/, '<svg$1 preserveAspectRatio="xMidYMid meet">');
    for (let i = 0; i < item.count; i++) {
      cells.push(`<div class="cell">
        <div class="qr">${qr}</div>
        <div class="code">${esc(item.code)}</div>
        ${layout.withTitle && (item.label || item.title)
          ? `<div class="name">${esc(item.label || item.title)}</div>`
          : ''}
      </div>`);
    }
  }

  const perPage = Math.max(1, layout.cols * layout.rows);
  const pages: string[] = [];
  for (let i = 0; i < cells.length; i += perPage) {
    pages.push(`<div class="page">${cells.slice(i, i + perPage).join('')}</div>`);
  }
  if (pages.length === 0) pages.push('<div class="page"></div>');

  return `<!doctype html><html lang="cs"><head><meta charset="utf-8">
<style>
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, "Segoe UI", Arial, sans-serif; }
  .page {
    width: 210mm; height: 297mm;
    padding: ${layout.marginTop}mm ${layout.marginSide}mm;
    display: grid;
    grid-template-columns: repeat(${layout.cols}, 1fr);
    /* Řádky se předepisují všechny, i když je poslední arch poloprázdný.
       S automatickými řádky by se jediná řada roztáhla přes celou stránku a
       štítky by se vytiskly uprostřed papíru místo na svých místech. */
    grid-template-rows: repeat(${layout.rows}, 1fr);
    gap: ${layout.gap}mm;
    page-break-after: always;
  }
  .page:last-child { page-break-after: auto; }
  .cell {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 1mm; overflow: hidden; padding: 1mm;
    ${layout.cutLines ? 'border: 0.2mm dashed #bbb;' : ''}
  }
  .qr { width: ${geom.qr}mm; height: ${geom.qr}mm; flex: 0 0 auto; }
  .qr svg { width: 100%; height: 100%; display: block; }
  /* Kód pod QR je pojistka pro chvíli, kdy čtečka nedosáhne — proto
     jednoprostorové písmo a rozpal, ať se nedá splést O a 0 */
  .code {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: ${layout.fontSize}pt; font-weight: 700; letter-spacing: 0.04em;
    line-height: 1.1; text-align: center; word-break: break-all;
  }
  .name {
    font-size: ${Math.max(5, layout.fontSize - 2)}pt; color: #444;
    line-height: 1.15; text-align: center;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }
</style></head><body>${pages.join('')}</body></html>`;
}

/** Náhled do rozhraní — stejné HTML, jaké půjde do tisku. */
export async function labelPreview(items: LabelItem[], layout: LabelLayout): Promise<string> {
  return sheetHtml(items.slice(0, Math.max(1, layout.cols * layout.rows)), layout);
}

/** Vysází archy štítků do PDF a uloží je tam, kam uživatel řekne. */
export async function labelsToPdf(items: LabelItem[], layout: LabelLayout):
  Promise<{ path: string; labels: number; pages: number } | null> {
  const total = items.reduce((sum, one) => sum + Math.max(1, one.count), 0);
  if (total === 0) throw new Error('Není co tisknout — nejdřív vyber produkty.');

  const html = await sheetHtml(items, layout);
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    // Bez krátkého čekání se občas vysází stránka, na které ještě nedosedlo
    // rozvržení mřížky — štítky pak přetečou přes okraj
    await win.webContents.executeJavaScript(
      'new Promise(r => setTimeout(r, 150))', true
    ).catch(() => { /* i tak se vysadí */ });

    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      margins: { marginType: 'none' }
    });

    const stamp = new Date().toISOString().slice(0, 10);
    const res = await dialog.showSaveDialog(BrowserWindow.getFocusedWindow()!, {
      defaultPath: path.join(app.getPath('downloads'), `stitky-${stamp}.pdf`),
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    });
    if (res.canceled || !res.filePath) return null;
    fs.writeFileSync(res.filePath, pdf);
    return {
      path: res.filePath,
      labels: total,
      pages: Math.ceil(total / Math.max(1, layout.cols * layout.rows))
    };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}
