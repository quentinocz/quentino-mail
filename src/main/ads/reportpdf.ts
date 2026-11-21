/**
 * Report Reklam do PDF — stejný obsah jako záložka Report, vysázený na A4.
 *
 * Sází se do HTML a Electron ho vytiskne do PDF stejně jako AI přehled
 * (digestpdf.ts). Bez obrázků a písem z aplikace, aby PDF vypadalo stejně
 * na každém Macu a dalo se poslat účetní nebo společníkovi.
 */
import fs from 'fs';
import path from 'path';
import { app, dialog, BrowserWindow } from 'electron';
import type { AdsReport, AdsCampaignRow, AdsProductRow } from '../../shared/ads';
import { MARKET_LABELS } from '../../shared/ads';
import { callerWindow } from '../caller';

const kc = (n: number) => `${Math.round(n || 0).toLocaleString('cs-CZ')} Kč`;
const pct = (n: number | null | undefined) => (n == null ? '—' : `${(Math.round(n * 1000) / 10).toLocaleString('cs-CZ')} %`);

function esc(text: unknown): string {
  return String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Odrážky a **tučně** z textu poradce — nic jiného z modelu do HTML nejde */
function rich(text: string): string {
  const bold = (line: string) => esc(line).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const items = lines.filter(l => /^[-•]\s+/.test(l));
  if (items.length === lines.length) return `<ul>${items.map(l => `<li>${bold(l.replace(/^[-•]\s+/, ''))}</li>`).join('')}</ul>`;
  return lines.map(l => `<p>${bold(l)}</p>`).join('');
}

function delta(now: number, prev: number, invert = false): string {
  if (!prev) return '<span class="muted">—</span>';
  const c = (now - prev) / Math.abs(prev);
  const good = invert ? c <= 0 : c >= 0;
  return `<span class="${good ? 'ok' : 'bad'}">${c >= 0 ? '+' : ''}${Math.round(c * 100)} %</span>`;
}

function campaignTable(rows: AdsCampaignRow[]): string {
  if (!rows.length) return '<div class="muted">—</div>';
  return `<table><thead><tr><th>Kampaň</th><th>Systém</th><th class="r">Útrata</th><th class="r">Hodnota</th><th class="r">Zisk</th><th class="r">PNO / cíl</th></tr></thead><tbody>
    ${rows.map(c => `<tr><td>${esc(c.name)}</td><td>${esc(c.system)}${c.market ? ` · ${esc(MARKET_LABELS[c.market] ?? c.market)}` : ''}</td>
      <td class="r">${kc(c.cost)}</td><td class="r">${kc(c.value)}</td><td class="r ${c.profit < 0 ? 'bad' : ''}">${kc(c.profit)}</td>
      <td class="r">${pct(c.pno)} / ${pct(c.targetPno)}</td></tr>`).join('')}
  </tbody></table>`;
}

function productList(rows: AdsProductRow[], what: 'profit' | 'cost'): string {
  if (!rows.length) return '<div class="muted">—</div>';
  return `<ul class="plain">${rows.map(p => `<li>${esc(p.title)} <span class="muted">· ${what === 'profit' ? `zisk ${kc(p.profit)}` : `útrata ${kc(p.cost)}`}</span></li>`).join('')}</ul>`;
}

export function reportHtml(r: AdsReport): string {
  const o = r.overview;
  const kpi = (label: string, now: number, prev: number, invert = false, fmt = kc) =>
    `<div class="kpi"><div class="l">${label}</div><div class="v">${fmt(now)}</div><div class="d">${delta(now, prev, invert)} <span class="muted">proti ${fmt(prev)}</span></div></div>`;
  const verdict: Record<string, string> = { better: 'vyšlo', worse: 'nevyšlo', same: 'beze změny', pending: 'vyhodnotí se' };
  return `<!doctype html><html lang="cs"><head><meta charset="utf-8"><style>
    @page { size: A4; margin: 0; }
    body { font: 11px/1.45 -apple-system, "Helvetica Neue", Arial, sans-serif; color: #1d1b26; margin: 0; padding: 14mm 14mm 12mm; }
    h1 { font-size: 20px; margin: 0 0 2px; } h2 { font-size: 13px; margin: 16px 0 6px; border-bottom: 1px solid #ddd; padding-bottom: 3px; }
    .sub { color: #666; margin-bottom: 12px; }
    .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
    .kpi { border: 1px solid #e2e0ea; border-radius: 8px; padding: 8px 10px; }
    .kpi .l { color: #666; font-size: 10px; text-transform: uppercase; letter-spacing: .03em; }
    .kpi .v { font-size: 16px; font-weight: 700; margin: 2px 0; }
    .ok { color: #2f9e6e; } .bad { color: #e5484d; } .muted { color: #888; }
    table { width: 100%; border-collapse: collapse; } th, td { padding: 4px 6px; border-bottom: 1px solid #eee; text-align: left; }
    th { font-size: 9.5px; color: #666; text-transform: uppercase; } .r { text-align: right; }
    .find { margin: 0; padding: 0; list-style: none; } .find li { padding: 3px 0 3px 14px; position: relative; }
    .find li::before { content: '●'; position: absolute; left: 0; font-size: 8px; top: 6px; }
    .find .up::before { color: #2f9e6e; } .find .down::before { color: #e5484d; } .find .watch::before { color: #d99a1b; } .find .info::before { color: #999; }
    .find .b { color: #888; font-size: 10px; display: block; }
    .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
    .summary { background: #f5f3fb; border-radius: 8px; padding: 8px 12px; } .summary ul { margin: 4px 0; padding-left: 16px; }
    ul.plain { margin: 0; padding-left: 14px; }
    .foot { margin-top: 14px; color: #999; font-size: 9.5px; }
  </style></head><body>
    <h1>Reklamy — ${esc(r.label)}</h1>
    <div class="sub">${esc(r.from)} až ${esc(r.to)} · ${r.market === 'all' ? 'všechny trhy' : esc(MARKET_LABELS[r.market] ?? r.market)}
      · srovnání s ${esc(r.prevFrom)} až ${esc(r.prevTo)} · cíl zisku po reklamě ${pct(r.target)} z obratu</div>
    <div class="kpis">
      ${kpi('Zisk po reklamě', o.profitAfterAds.value, o.profitAfterAds.prev)}
      ${kpi('Obrat bez DPH', o.revenue.value, o.revenue.prev)}
      ${kpi('Náklady na reklamu', o.cost.value, o.cost.prev, true)}
      ${kpi('Objednávky', o.orders.value, o.orders.prev, false, n => String(Math.round(n)))}
    </div>
    <div class="sub" style="margin-top:6px">Podíl zisku po reklamě: <b>${pct(o.profitShare)}</b> · PNO e-shopu ${pct(o.shopPno)} (cíl ${pct(o.targetPno)})</div>
    ${r.summary ? `<h2>Shrnutí poradce</h2><div class="summary">${rich(r.summary)}</div>` : ''}
    <h2>Zjištění</h2>
    <ul class="find">${r.findings.map(f => `<li class="${f.kind}">${esc(f.text)}<span class="b">${esc(f.basis)}</span></li>`).join('') || '<li class="info">Bez výrazných změn.</li>'}</ul>
    <h2>Systémy a trhy</h2>
    <table><thead><tr><th>Systém</th><th class="r">Útrata</th><th class="r">Hodnota konverzí</th><th class="r">Zisk z konverzí</th><th class="r">PNO / cíl</th></tr></thead><tbody>
      ${o.systems.filter(s => s.connected).map(s => `<tr><td>${esc(s.system === 'google' ? 'Google Ads' : s.system === 'sklik' ? 'Sklik' : 'Meta')}</td>
        <td class="r">${kc(s.cost)}</td><td class="r">${kc(s.value)}</td><td class="r">${kc(s.profit)}</td><td class="r">${pct(s.pno)} / ${pct(s.targetPno)}</td></tr>`).join('')}
    </tbody></table>
    ${o.markets.length > 1 ? `<table style="margin-top:8px"><thead><tr><th>Trh</th><th class="r">Obrat</th><th class="r">Náklady</th><th class="r">Zisk po reklamě</th><th class="r">PNO / cíl</th></tr></thead><tbody>
      ${o.markets.map(m => `<tr><td>${esc(MARKET_LABELS[m.market] ?? m.market)}</td><td class="r">${kc(m.revenue)}</td><td class="r">${kc(m.cost)}</td>
        <td class="r ${m.profitAfterAds < 0 ? 'bad' : ''}">${kc(m.profitAfterAds)}</td><td class="r">${pct(m.pno)} / ${pct(m.targetPno)}</td></tr>`).join('')}
    </tbody></table>` : ''}
    <h2>Nejvýnosnější kampaně</h2>${campaignTable(r.best)}
    <h2>Nejslabší kampaně</h2>${campaignTable(r.worst)}
    <div class="cols">
      <div><h2>Hvězdy</h2>${productList(r.stars, 'profit')}</div>
      <div><h2>Žrouti</h2>${productList(r.eaters, 'cost')}</div>
    </div>
    <h2>Změny v účtech</h2>
    ${r.changes.length ? `<table><tbody>${r.changes.map(c => `<tr><td>${esc(c.at.slice(0, 10))}</td><td>${esc(c.title)}</td>
      <td>${esc(c.device)}</td><td>${c.reverted ? 'vráceno' : esc(verdict[c.verdict] ?? '')}</td></tr>`).join('')}</tbody></table>`
    : '<div class="muted">V tomhle období se v účtech nic neměnilo.</div>'}
    <div class="foot">Zisk po reklamě = marže z objednávek + doprava − náklady na dopravu − náklady na reklamu. Částky bez DPH.
      Vytvořeno v Quentino App ${esc(new Date().toLocaleString('cs-CZ'))}.</div>
  </body></html>`;
}

export async function reportToPdf(r: AdsReport): Promise<string | null> {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(reportHtml(r)));
    await win.webContents.executeJavaScript('new Promise(r => setTimeout(r, 150))', true).catch(() => { /* i tak */ });
    const pdf = await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4', margins: { marginType: 'none' } });
    const res = await dialog.showSaveDialog(callerWindow()!, {
      defaultPath: path.join(app.getPath('downloads'), `quentino-reklamy-${r.kind === 'week' ? 'tyden' : 'mesic'}-${r.from}.pdf`),
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    });
    if (res.canceled || !res.filePath) return null;
    fs.writeFileSync(res.filePath, pdf);
    return res.filePath;
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}
