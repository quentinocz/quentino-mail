import fs from 'fs';
import path from 'path';
import { app, BrowserWindow, dialog } from 'electron';
import QRCode from 'qrcode';
import { getDb } from './db';
import { LabelLayout, RollLabel, ZplPlan } from '../shared/types';
import { gapY, labelGeometry, safeMm } from '../shared/labels';

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
export function labelItems(codes: string[], perItem = 1, byStock = false): LabelItem[] {
  const d = getDb();
  const out: LabelItem[] = [];
  for (const code of codes) {
    const variants = d.prepare(
      'SELECT code, label, stock FROM product_variants WHERE product_code = ? ORDER BY sort, code'
    ).all(code) as any[];
    const product = d.prepare('SELECT code, title_cz, stock FROM products WHERE code = ?')
      .get(code) as any;
    const title = product?.title_cz ?? code;

    /*
     * Počet podle skladu se bere u té věci, na kterou štítek je. U produktu
     * s variantami je zásoba na variantě — souhrn na „hlavním" kódu sečítá
     * všechny délky dohromady a nálepek by se vytisklo tolik, kolik je kusů
     * celkem, na každou variantu zvlášť.
     */
    const many = (stock: unknown) => byStock
      ? Math.max(0, Math.floor(Number(stock) || 0))
      : Math.max(1, perItem);

    if (variants.length > 0) {
      for (const v of variants) {
        const count = many(v.stock);
        if (count > 0) out.push({ code: v.code, title, label: v.label ?? '', count });
      }
    } else if (product) {
      const count = many(product.stock);
      if (count > 0) out.push({ code: product.code, title, label: '', count });
    }
  }
  return out;
}

/**
 * Štítky na to, co se právě naskladnilo.
 *
 * Zboží se naskladní a hned se na ně lepí štítky — počet je tedy ten, který
 * se naskladňoval, ne zásoba na skladě: ta v tu chvíli ještě neví o tom, co
 * leží na stole.
 */
export function stockinLabelItems(sessionId: string): LabelItem[] {
  const rows = getDb().prepare(
    `SELECT code, title, label, qty FROM stockin_items
     WHERE session_id = ? AND qty > 0 ORDER BY added_at`
  ).all(sessionId) as any[];

  return rows.map(r => ({
    code: r.code,
    title: r.title ?? r.code,
    label: r.label ?? '',
    count: Math.max(1, Number(r.qty) || 1)
  }));
}

/**
 * Vysází archy štítků do HTML.
 *
 * Políčka se pokládají na **absolutní pozice**, ne do mřížky. U koupených
 * archů je rozteč daná výsekem — u Y025025W066 vodorovně 30,48 mm a svisle
 * 25,4 mm bez mezery — a mřížka, která si rozměry dopočítá z volného místa,
 * se do desetiny milimetru netrefí. Tady se každý štítek posadí přesně tam,
 * kde na papíře je.
 */
async function sheetHtml(items: LabelItem[], layout: LabelLayout): Promise<string> {
  // Kolik se do políčka vejde, počítá sdílený výpočet — stejný, jaký v
  // rozhraní ukazuje „štítek 46 × 25 mm". QR se podle něj zmenší, místo aby
  // přeteklo přes okraj a oříznulo se
  const geom = labelGeometry(layout);
  const round = layout.shape === 'round';
  const safe = safeMm(layout);
  const stepX = geom.cellW + layout.gap;
  const stepY = geom.cellH + gapY(layout);
  const offsetX = layout.offsetX ?? 0;
  const offsetY = layout.offsetY ?? 0;

  const cells: string[] = [];
  for (const item of items) {
    const svg = await QRCode.toString(item.code, {
      type: 'svg', margin: 0, errorCorrectionLevel: 'M'
    });
    // Vlastní rozměr se řídí stylem, ne atributem v SVG
    const qr = svg.replace(/<svg([^>]*)>/, '<svg$1 preserveAspectRatio="xMidYMid meet">');
    for (let i = 0; i < item.count; i++) {
      cells.push(`<div class="qr">${qr}</div>
        <div class="code">${esc(item.code)}</div>
        ${layout.withTitle && (item.label || item.title)
          ? `<div class="name">${esc(item.label || item.title)}</div>`
          : ''}`);
    }
  }

  const perPage = Math.max(1, layout.cols * layout.rows);
  const pages: string[] = [];
  for (let i = 0; i < cells.length; i += perPage) {
    const placed = cells.slice(i, i + perPage).map((inner, n) => {
      const col = n % layout.cols;
      const row = Math.floor(n / layout.cols);
      const left = layout.marginSide + col * stepX + offsetX;
      const top = layout.marginTop + row * stepY + offsetY;
      return `<div class="cell" style="left:${mm(left)}mm;top:${mm(top)}mm">${inner}</div>`;
    });
    pages.push(`<div class="page">${placed.join('')}</div>`);
  }
  if (pages.length === 0) pages.push('<div class="page"></div>');

  return `<!doctype html><html lang="cs"><head><meta charset="utf-8">
<style>
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, "Segoe UI", Arial, sans-serif; }
  .page { position: relative; width: 210mm; height: 297mm; page-break-after: always; }
  .page:last-child { page-break-after: auto; }
  /* Políčko sedí na svém místě podle rozteče archu, ne podle mřížky */
  .cell {
    position: absolute;
    width: ${mm(geom.cellW)}mm; height: ${mm(geom.cellH)}mm;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 1mm; overflow: hidden; padding: ${mm(safe)}mm;
    ${round ? 'border-radius: 50%;' : ''}
    ${layout.cutLines ? 'outline: 0.2mm dashed #bbb; outline-offset: -0.1mm;' : ''}
  }
  .qr { width: ${mm(geom.qr)}mm; height: ${mm(geom.qr)}mm; flex: 0 0 auto; }
  .qr svg { width: 100%; height: 100%; display: block; }
  /* Kód pod QR je pojistka pro chvíli, kdy čtečka nedosáhne — proto
     jednoprostorové písmo a rozpal, ať se nedá splést O a 0 */
  .code {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: ${layout.fontSize}pt; font-weight: 700; letter-spacing: 0.04em;
    line-height: 1.1; text-align: center; word-break: break-all;
    /* U kulatých štítků je dole místa míň než uprostřed — šířka je tětiva */
    max-width: ${mm(geom.textW)}mm;
  }
  .name {
    font-size: ${Math.max(5, layout.fontSize - 2)}pt; color: #444;
    line-height: 1.15; text-align: center; max-width: ${mm(geom.textW)}mm;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }
</style></head><body>${pages.join('')}</body></html>`;
}

/** Milimetry do stylu — na dvě desetiny stačí, dál už tiskárna nedosáhne. */
function mm(value: number): string {
  return String(Math.round(value * 100) / 100);
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

/* ---------- štítkové tiskárny (role, ne archy) ---------- */

/**
 * Proč dva různé vývozy a ne jeden.
 *
 * **Zebra** rozumí ZPL — prostému textu, který se dá poslat na tiskárnu tak,
 * jak je. Štítek se v něm popíše celý: kam přijde QR, jak velké, co se pod
 * něj napíše. Proto pro ni umíme vygenerovat hotový soubor.
 *
 * **Brother** takhle univerzální textový jazyk nemá. Modely P-touch i QL se
 * ovládají binárním protokolem, který se u každé řady liší, a obrázek se do
 * nich posílá jako rastr; obvyklá cesta je proto P-touch Editor, kde si
 * člověk štítek jednou nakreslí a data do něj **naslučuje z tabulky**.
 * Vyvážíme tedy CSV v podobě, kterou Editor (a stejně tak ZebraDesigner)
 * umí načíst. Předstírat, že „umíme tisknout na Brother", by znamenalo
 * napsat ovladač pro každou řadu zvlášť.
 */

export const DEFAULT_ROLL: RollLabel = {
  widthMm: 50,
  heightMm: 30,
  dpi: 203,
  qrMm: 18,
  textMm: 3.5,
  withTitle: false
};

/** Body na milimetr — 203 dpi je 8 bodů, 300 dpi necelých 12. */
function dots(mm: number, dpi: number): number {
  return Math.round((mm * dpi) / 25.4);
}

/**
 * `^` a `~` jsou v ZPL řídicí znaky.
 *
 * Kódy produktů je neobsahují, ale vyvezený soubor jde na tiskárnu bez
 * dalšího čtení — a jeden takový znak v datech by z něj udělal příkaz.
 */
function zplSafe(text: string): string {
  return String(text ?? '').replace(/[\^~]/g, '-').replace(/[\r\n]+/g, ' ').trim();
}

/**
 * Kolik se toho na štítek vejde — a kam se to položí.
 *
 * Jeden výpočet pro rozvahu i pro sazbu. Když je počítal každý zvlášť,
 * rozešly se: rozvaha si na text nechávala jinou rezervu, než jakou sazba
 * doopravdy potřebovala, a na malém štítku text přetekl přes spodní okraj.
 *
 * QR se navíc v ZPL neškáluje na milimetry, ale násobkem modulu — a modul je
 * celé číslo bodů. Skutečná velikost proto skáče po krocích a je poctivější
 * ji spočítat a ukázat, než slíbit 18 mm a vytisknout 15.
 */
export function zplPlan(roll: RollLabel): ZplPlan {
  const dpi = roll.dpi;
  const widthDots = dots(roll.widthMm, dpi);
  const heightDots = dots(roll.heightMm, dpi);

  const top = dots(1.5, dpi);
  const gap = dots(1, dpi);
  const codeH = dots(roll.textMm, dpi);
  const nameGap = dots(0.6, dpi);
  const nameH = roll.withTitle ? Math.max(dots(2.2, dpi), Math.round(codeH * 0.75)) : 0;
  const bottomPad = dots(0.8, dpi);
  const textBlock = gap + codeH + (roll.withTitle ? nameGap + nameH : 0) + bottomPad;

  // Nejmenší QR verze má 21 modulů; s rezervou na delší kódy počítáme s 25
  const MODULES = 25;
  const room = Math.min(widthDots - dots(3, dpi), heightDots - top - textBlock);
  const wanted = dots(roll.qrMm, dpi);
  const magnification = Math.max(1, Math.min(10, Math.floor(Math.min(wanted, room) / MODULES)));
  const qrDots = magnification * MODULES;
  const qrMm = Math.round((qrDots * 25.4 / dpi) * 10) / 10;

  const codeY = top + qrDots + gap;
  return {
    magnification,
    qrDots,
    qrMm,
    widthDots,
    heightDots,
    qrX: Math.max(0, Math.round((widthDots - qrDots) / 2)),
    qrY: top,
    codeY,
    codeH,
    nameY: codeY + codeH + nameGap,
    nameH,
    shrunk: qrDots < wanted - 1,
    // Pod deset milimetrů běžná čtečka na kód o osmi znacích nestačí
    tooSmall: qrMm < 10 || qrDots > room
  };
}

/**
 * ZPL pro Zebru — jeden štítek na položku, `^PQ` na počet kusů.
 *
 * Souřadnice se počítají od levého horního rohu v bodech a berou se
 * z rozvahy, aby se sazba s tím, co rozhraní ukazuje, nemohla rozejít.
 */
export function zplLabels(items: LabelItem[], roll: RollLabel): string {
  const plan = zplPlan(roll);
  const out: string[] = [];

  for (const item of items) {
    const code = zplSafe(item.code);
    const name = zplSafe(item.label || item.title).slice(0, 40);

    out.push([
      '^XA',
      `^PW${plan.widthDots}`,
      `^LL${plan.heightDots}`,
      '^LH0,0',
      '^CI28',                                   // UTF-8, jinak by háčky vyšly jako otazníky
      `^FO${plan.qrX},${plan.qrY}^BQN,2,${plan.magnification}^FDLA,${code}^FS`,
      // Kód pod QR: ^FB zarovná na střed přes celou šířku štítku
      `^FO0,${plan.codeY}^A0N,${plan.codeH},${Math.round(plan.codeH * 0.6)}`
      + `^FB${plan.widthDots},1,0,C,0^FD${code}^FS`,
      ...(roll.withTitle && name
        ? [`^FO0,${plan.nameY}^A0N,${plan.nameH},${Math.round(plan.nameH * 0.6)}`
          + `^FB${plan.widthDots},1,0,C,0^FD${name}^FS`]
        : []),
      `^PQ${Math.max(1, item.count)}`,
      '^XZ'
    ].join('\n'));
  }

  return out.join('\n') + '\n';
}

/**
 * CSV pro P-touch Editor a ZebraDesigner.
 *
 * Středník a BOM, protože obojí se otevírá i v Excelu a ten bez nich rozhází
 * sloupce i diakritiku. Jeden řádek na štítek — a `pocet` zvlášť, aby si
 * v šabloně šlo nastavit, kolikrát se má vytisknout.
 */
export function labelsCsv(items: LabelItem[]): string {
  const cell = (value: string) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const lines = [['kod', 'nazev', 'varianta', 'pocet'].join(';')];
  for (const item of items) {
    lines.push([
      cell(item.code), cell(item.title), cell(item.label), String(Math.max(1, item.count))
    ].join(';'));
  }
  return '﻿' + lines.join('\r\n') + '\r\n';
}

/** Uloží vývoz pro štítkovou tiskárnu tam, kam uživatel řekne. */
export async function labelsExport(kind: 'zpl' | 'csv', items: LabelItem[], roll: RollLabel):
  Promise<{ path: string; labels: number } | null> {
  const total = items.reduce((sum, one) => sum + Math.max(1, one.count), 0);
  if (total === 0) throw new Error('Není co tisknout — nejdřív vyber produkty.');

  const body = kind === 'zpl' ? zplLabels(items, roll) : labelsCsv(items);
  const stamp = new Date().toISOString().slice(0, 10);
  const res = await dialog.showSaveDialog(BrowserWindow.getFocusedWindow()!, {
    defaultPath: path.join(app.getPath('downloads'), `stitky-${stamp}.${kind}`),
    filters: kind === 'zpl'
      ? [{ name: 'ZPL pro Zebru', extensions: ['zpl', 'txt'] }]
      : [{ name: 'CSV pro šablonu štítku', extensions: ['csv'] }]
  });
  if (res.canceled || !res.filePath) return null;

  fs.writeFileSync(res.filePath, body, 'utf8');
  return { path: res.filePath, labels: total };
}
