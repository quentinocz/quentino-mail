/**
 * AI přehled do PDF.
 *
 * Přehled je jediná obrazovka v aplikaci, kterou má smysl si vytisknout nebo
 * někomu poslat: čísla za měsíc, co z nich plyne a co s tím. Tiskne se
 * **totéž, co je vidět** — jen vysázené na papír, aby se nemuselo skládat
 * dohromady ze snímků obrazovky.
 *
 * Sází se do HTML a Electron ho vytiskne do PDF stejně jako archy štítků.
 * Grafy jsou obyčejné obdélníky v SVG, takže na papíře drží i bez písma
 * a barev z aplikace.
 */
import fs from 'fs';
import path from 'path';
import { app, dialog, BrowserWindow } from 'electron';
import type { DigestFacts, DigestInsight, DigestSignal, DigestSlice } from '../shared/types';

const MONEY = new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 0 });

function money(amount: number, currency: string): string {
  return `${MONEY.format(Math.round(amount || 0))} ${currency === 'CZK' ? 'Kč' : currency}`;
}

/** Text do HTML — do přehledu jdou i názvy zboží od zákazníků a z feedu */
function esc(text: unknown): string {
  return String(text ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function bars(rows: DigestSlice[], unit = ''): string {
  if (!rows.length) return '<div class="empty">—</div>';
  const top = Math.max(1, ...rows.map(one => one.orders));
  return rows.slice(0, 6).map(one => `
    <div class="row">
      <span class="label">${esc(one.label)}</span>
      <span class="track"><span class="fill" style="width:${Math.round((one.orders / top) * 100)}%"></span></span>
      <span class="num">${one.orders}${unit}</span>
    </div>`).join('');
}

function dayChart(facts: DigestFacts): string {
  const top = Math.max(1, ...facts.days.map(one => one.orders));
  const step = 100 / Math.max(1, facts.days.length);
  const rects = facts.days.map((one, i) => {
    const height = (one.orders / top) * 30;
    return `<rect x="${(i * step + 0.3).toFixed(2)}" y="${(32 - height).toFixed(2)}"`
      + ` width="${(step - 0.6).toFixed(2)}" height="${Math.max(one.orders ? 0.8 : 0, height).toFixed(2)}"`
      + ` rx="0.5" fill="#7c5cff"></rect>`;
  }).join('');
  return `<svg viewBox="0 0 100 34" preserveAspectRatio="none" class="chart">${rects}</svg>`;
}

function monthChart(facts: DigestFacts): string {
  const months = facts.history.months;
  if (months.length < 2) return '';
  const top = Math.max(1, ...months.map(one => one.orders));
  const step = 100 / months.length;
  const rects = months.map((one, i) => {
    const height = (one.orders / top) * 30;
    return `<rect x="${(i * step + 0.6).toFixed(2)}" y="${(32 - height).toFixed(2)}"`
      + ` width="${(step - 1.2).toFixed(2)}" height="${Math.max(one.orders ? 0.8 : 0, height).toFixed(2)}"`
      + ` rx="0.5" fill="${one.complete ? '#7c5cff' : '#b9a7ff'}"></rect>`;
  }).join('');
  return `
    <h2>Dlouhodobě</h2>
    <svg viewBox="0 0 100 34" preserveAspectRatio="none" class="chart">${rects}</svg>
    <div class="cap">${esc(months[0]?.month)} – ${esc(months[months.length - 1]?.month)}
      ${facts.history.lastYear
        ? `· stejných 30 dní loni: ${facts.history.lastYear.orders} objednávek za `
          + `${money(facts.history.lastYear.revenue, facts.currency)}`
        : ''}
      ${facts.history.rank ? `· slabších bylo ${facts.history.rank.better} z ${facts.history.rank.of} měsíců` : ''}
    </div>`;
}

function signals(list: DigestSignal[]): string {
  if (!list.length) return '';
  return `<h2>Čísla, co stojí za pozornost</h2>` + list.map(one => `
    <div class="note">
      <b>${esc(one.text)}</b>
      <span class="basis">${esc(one.basis)}</span>
    </div>`).join('');
}

function insightBlock(insight: DigestInsight | null): string {
  if (!insight) return '';
  const notes = insight.notes.map(one => `
    <div class="note">
      <b>${esc(one.text)}</b>
      ${one.basis ? `<span class="basis">opřeno o: ${esc(one.basis)}</span>` : ''}
      ${one.check ? `<span class="basis">zabralo, když: ${esc(one.check)}</span>` : ''}
    </div>`).join('');
  return `
    <h2>Postřehy</h2>
    <p class="head">${esc(insight.headline)}</p>
    ${insight.followUp ? `<p class="cap">${esc(insight.followUp)}</p>` : ''}
    ${notes}
    ${insight.focus ? `<p class="cap">Příště ověřit: ${esc(insight.focus)}</p>` : ''}`;
}

/** Celý přehled jako stránka A4 */
export function digestHtml(facts: DigestFacts, insight: DigestInsight | null, at: string): string {
  const when = new Date(at || Date.now());
  const products = facts.products.map(one => `
    <div class="row">
      <span class="label">${esc(one.title)}</span>
      <span class="num">${one.qty} ks</span>
      <span class="num money">${one.revenue ? `${one.estimated ? '≈ ' : ''}${money(one.revenue, facts.currency)}` : '—'}</span>
    </div>`).join('') || '<div class="empty">—</div>';

  return `<!doctype html><html lang="cs"><head><meta charset="utf-8"><style>
    @page { size: A4; margin: 14mm; }
    * { box-sizing: border-box; }
    body { font-family: -apple-system, 'Helvetica Neue', Arial, sans-serif; color: #201d29; font-size: 10pt; margin: 0; }
    h1 { font-size: 16pt; margin: 0 0 2mm; }
    h2 { font-size: 11pt; margin: 6mm 0 2mm; border-bottom: 0.4mm solid #e7e4ee; padding-bottom: 1mm; }
    .sub { color: #6b6579; font-size: 9pt; margin-bottom: 4mm; }
    .tiles { display: flex; gap: 3mm; }
    .tile { flex: 1; border: 0.3mm solid #e7e4ee; border-radius: 2mm; padding: 3mm; }
    .tile .k { font-size: 7.5pt; text-transform: uppercase; letter-spacing: .04em; color: #9a94a8; }
    .tile .v { font-size: 15pt; font-weight: 700; }
    .tile .s { font-size: 8pt; color: #6b6579; }
    .grid { display: flex; gap: 4mm; }
    .grid > div { flex: 1; }
    .row { display: flex; align-items: center; gap: 2mm; font-size: 9pt; padding: 0.6mm 0; }
    .label { flex: 0 0 42%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .track { flex: 1; height: 1.6mm; background: #f1eefa; border-radius: 1mm; }
    .fill { display: block; height: 100%; background: #7c5cff; border-radius: 1mm; }
    .num { flex: 0 0 auto; color: #6b6579; }
    .money { min-width: 22mm; text-align: right; }
    .chart { width: 100%; height: 22mm; display: block; }
    .cap, .basis { color: #6b6579; font-size: 8pt; }
    .note { margin: 1.5mm 0; }
    .note b { font-weight: 600; font-size: 9.5pt; }
    .note .basis { display: block; }
    .head { font-size: 11pt; font-weight: 600; margin: 0 0 2mm; }
    .empty { color: #9a94a8; font-size: 9pt; }
    .foot { margin-top: 6mm; color: #9a94a8; font-size: 8pt; }
  </style></head><body>
    <h1>AI Přehled</h1>
    <div class="sub">${when.toLocaleString('cs-CZ', { dateStyle: 'long', timeStyle: 'short' })}
      · posledních 30 dní · ${esc(facts.monthLabel)}</div>

    <div class="tiles">
      <div class="tile"><span class="k">Dnes</span><div class="v">${facts.today.orders}</div>
        <span class="s">${money(facts.today.revenue[0]?.amount ?? 0, facts.currency)}</span></div>
      <div class="tile"><span class="k">30 dní</span><div class="v">${facts.window.orders}</div>
        <span class="s">${money(facts.window.revenue[0]?.amount ?? 0, facts.currency)}</span></div>
      <div class="tile"><span class="k">Předchozích 30</span><div class="v">${facts.prevWindow.orders}</div>
        <span class="s">${money(facts.prevWindow.revenue[0]?.amount ?? 0, facts.currency)}</span></div>
      <div class="tile"><span class="k">Průměrná objednávka</span>
        <div class="v">${money(facts.average, facts.currency)}</div>
        <span class="s">${facts.returning}× stálý zákazník</span></div>
    </div>

    <h2>Posledních 30 dní</h2>
    ${dayChart(facts)}

    ${signals(facts.signals)}

    <div class="grid">
      <div><h2>Země</h2>${bars(facts.countries)}</div>
      <div><h2>Doprava</h2>${bars(facts.shipments)}</div>
      <div><h2>Platba</h2>${bars(facts.payments)}</div>
    </div>

    <h2>Nejprodávanější</h2>
    ${products}

    ${monthChart(facts)}
    ${insightBlock(insight)}

    <div class="foot">Quentino · sestaveno z feedu objednávek
      ${facts.known ? `(${facts.known} objednávek)` : ''}</div>
  </body></html>`;
}

/**
 * Uloží přehled do PDF.
 *
 * Vysází se stejné HTML, jaké by se dalo vytisknout z prohlížeče, a Electron
 * ho převede — stejnou cestou jako archy štítků, takže se na to nemusí
 * přibírat žádná knihovna.
 */
export async function digestToPdf(
  facts: DigestFacts, insight: DigestInsight | null, at: string
): Promise<string | null> {
  const html = digestHtml(facts, insight, at);
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    // Bez krátkého čekání se občas vysází stránka, na které ještě nedosedlo
    // rozvržení — sloupce grafu pak přetečou
    await win.webContents.executeJavaScript('new Promise(r => setTimeout(r, 150))', true)
      .catch(() => { /* i tak se vysadí */ });

    const pdf = await win.webContents.printToPDF({
      printBackground: true, pageSize: 'A4', margins: { marginType: 'none' }
    });

    const stamp = (at || new Date().toISOString()).slice(0, 10);
    const res = await dialog.showSaveDialog(BrowserWindow.getFocusedWindow()!, {
      defaultPath: path.join(app.getPath('downloads'), `quentino-prehled-${stamp}.pdf`),
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    });
    if (res.canceled || !res.filePath) return null;
    fs.writeFileSync(res.filePath, pdf);
    return res.filePath;
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}
