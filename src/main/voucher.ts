import { BrowserWindow, app } from 'electron';
import fs from 'fs';
import path from 'path';
import { getSetting } from './db';
import type { VoucherSpec, MailLang } from '../shared/types';

/**
 * Dárkové poukazy jako PDF do přílohy e-mailu.
 *
 * Sazba je záměrně typografická a beze stínů — poukaz se často tiskne na
 * domácí tiskárně a přechody a jemné odstíny na papíře zplihnou. Vychází
 * z existující šablony (široký pásek 595×283 pt), ale je vysazená znovu,
 * aby držela hierarchii: hodnota je největší, kód hned za ní, ostatní drobně.
 */

const DOMAIN: Record<MailLang, string> = {
  cz: 'www.quentino.cz',
  sk: 'www.quentino.sk',
  en: 'www.wearquentino.com'
};

const T: Record<MailLang, Record<string, string>> = {
  cz: {
    title: 'Dárkový poukaz', on: 'na', code: 'Váš kód',
    validUntil: 'Poukaz je platný do', tagline: 'Na prémiové pánské doplňky od Quentino',
    discount: 'sleva', shipping: 'Doprava zdarma', file: 'Poukaz'
  },
  sk: {
    title: 'Darčekový poukaz', on: 'na', code: 'Váš kód',
    validUntil: 'Poukaz je platný do', tagline: 'Na prémiové pánske doplnky od Quentino',
    discount: 'zľava', shipping: 'Doprava zadarmo', file: 'Poukaz'
  },
  en: {
    title: 'Gift voucher', on: 'for', code: 'Your code',
    validUntil: 'Valid until', tagline: 'For premium men’s accessories by Quentino',
    discount: 'discount', shipping: 'Free shipping', file: 'Voucher'
  }
};

function esc(s: string): string {
  return (s ?? '').replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]!));
}

/** „1000" + „CZK" → „1 000 Kč"; procenta a doprava zdarma se sází zvlášť. */
export function formatValue(spec: VoucherSpec): string {
  if (spec.unit === 'shipping') return T[spec.lang].shipping;
  const n = Number(String(spec.value).replace(/[^\d.,]/g, '').replace(',', '.'));
  const num = Number.isFinite(n) ? n : 0;
  if (spec.unit === 'percent') return `${num} %`;
  const grouped = num.toLocaleString('cs-CZ', { maximumFractionDigits: 0 }).replace(/ /g, ' ');
  return `${grouped} ${spec.unit === 'EUR' ? '€' : 'Kč'}`;
}

function fmtDate(iso: string, lang: MailLang): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return lang === 'en'
    ? d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })
    : d.toLocaleDateString('cs-CZ', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/**
 * Montserrat zabalený v aplikaci.
 *
 * Řezy se berou z balíčku @fontsource/montserrat a vkládají se do PDF jako
 * data URL, takže poukaz vypadá stejně i bez internetu. Čeština potřebuje
 * i podmnožinu latin-ext (ě, ř, ů, ž), proto se přikládají obě.
 */
const FONT_DIR = 'node_modules/@fontsource/montserrat/files';
const SUBSETS: { name: string; range: string }[] = [
  {
    name: 'latin',
    range: 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,'
      + 'U+0304,U+0308,U+0329,U+2000-206F,U+2074,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD'
  },
  {
    name: 'latin-ext',
    range: 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,'
      + 'U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF'
  }
];

function fontFaces(): string {
  // Kromě balíčku se kouká i do složky s daty aplikace — tam se dají řezy
  // nakopírovat ručně, když instalace balíčku z jakéhokoli důvodu neprojde
  const roots = [
    path.join(app.getAppPath(), FONT_DIR),
    path.join(process.cwd(), FONT_DIR),
    path.join(app.getAppPath(), '..', FONT_DIR),
    path.join(app.getPath('userData'), 'fonts')
  ];
  const dir = roots.find(r => { try { return fs.existsSync(r); } catch { return false; } });
  if (!dir) return ''; // bez balíčku se použije místní geometrický řez

  const out: string[] = [];
  for (const weight of [400, 500, 600, 700]) {
    for (const sub of SUBSETS) {
      const file = path.join(dir, `montserrat-${sub.name}-${weight}-normal.woff2`);
      if (!fs.existsSync(file)) continue;
      const b64 = fs.readFileSync(file).toString('base64');
      out.push(`@font-face{font-family:'Montserrat';font-style:normal;font-weight:${weight};`
        + `src:url(data:font/woff2;base64,${b64}) format('woff2');unicode-range:${sub.range};font-display:block}`);
    }
  }
  return out.join('\n');
}

/** Logo jako data URL, aby se do PDF vysadilo bez síťového požadavku. */
function logoDataUrl(): string | null {
  const p = getSetting('voucherLogo', '') ?? '';
  if (!p || !fs.existsSync(p)) return null;
  try {
    const ext = path.extname(p).toLowerCase();
    const mime = ext === '.svg' ? 'image/svg+xml' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
    return `data:${mime};base64,${fs.readFileSync(p).toString('base64')}`;
  } catch {
    return null;
  }
}

/**
 * Sazba poukazu.
 *
 * Černá plocha, bílá typografie, žádné efekty. Písmo je Montserrat, stejně
 * jako v původní šabloně — geometrický bezpatkový řez. Hierarchii nese
 * kontrast tučnosti a prostrkání: částka je tučná a bez proložení, popisky
 * jsou lehké verzálky s velkými mezerami mezi písmeny.
 *
 * Logo se přebarvuje na bílou (`brightness(0) invert(1)`), aby na černém
 * podkladu fungovalo i tmavé firemní logo bez nutnosti připravovat zvláštní verzi.
 */
export function voucherHtml(spec: VoucherSpec, code: string): string {
  const lang = spec.lang;
  const t = T[lang];
  const logo = logoDataUrl();
  const value = formatValue(spec);
  const isPercent = spec.unit === 'percent';
  // Doprava zdarma je věta, ne číslo — potřebuje menší stupeň a smí se zalomit
  const isShipping = spec.unit === 'shipping';

  return `<!doctype html><html><head><meta charset="utf-8">
  <style>
  ${fontFaces()}
  @page { size: 595pt 283pt; margin: 0; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    width: 595pt; height: 283pt;
    background: #0a0a0b;
    color: #ffffff;
    /* Montserrat je písmo původní šablony; místní náhrady jsou taky geometrické */
    font-family: 'Montserrat', 'Futura', 'Avenir Next', 'Helvetica Neue', Helvetica, sans-serif;
    font-weight: 400;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  .sheet { width: 100%; height: 100%; padding: 26pt 34pt 24pt; display: flex; flex-direction: column; }
  .rule { height: 0.5pt; background: rgba(255,255,255,0.26); }

  .top { display: flex; align-items: baseline; justify-content: space-between; padding-bottom: 12pt; }
  .eyebrow {
    font-size: 6.5pt; font-weight: 500; letter-spacing: 0.3em;
    text-transform: uppercase; color: rgba(255,255,255,0.55);
  }
  .logo { max-height: 20pt; max-width: 110pt; filter: brightness(0) invert(1); opacity: 0.92; }
  .wordmark { font-size: 10pt; font-weight: 600; letter-spacing: 0.38em; text-transform: uppercase; }

  .middle { flex: 1; display: flex; flex-direction: column; justify-content: center; padding: 14pt 0; }
  .title {
    font-size: 13pt; font-weight: 500; letter-spacing: 0.2em;
    text-transform: uppercase; color: rgba(255,255,255,0.9);
  }
  .amount-row { display: flex; align-items: flex-end; gap: 16pt; padding-top: 8pt; }
  .amount {
    font-size: ${isShipping ? '30pt' : isPercent ? '44pt' : value.length > 9 ? '38pt' : '44pt'};
    font-weight: 700; line-height: ${isShipping ? '1.08' : '1'}; letter-spacing: -0.015em;
    ${isShipping ? 'max-width: 250pt;' : ''}
  }
  .amount small { font-size: 0.3em; font-weight: 500; letter-spacing: 0.12em; padding-left: 5pt; text-transform: uppercase; }
  .code-block { padding-bottom: 4pt; }
  .code-label {
    font-size: 6pt; font-weight: 500; letter-spacing: 0.26em;
    text-transform: uppercase; color: rgba(255,255,255,0.5); padding-bottom: 4pt;
  }
  .code {
    font-size: 12pt; font-weight: 600; letter-spacing: 0.22em;
    border: 0.5pt solid rgba(255,255,255,0.4);
    padding: 5pt 11pt 5pt 14pt; display: inline-block;
  }

  .bottom {
    display: flex; align-items: flex-end; justify-content: space-between;
    padding-top: 12pt; font-size: 6.5pt; font-weight: 400; letter-spacing: 0.05em;
    color: rgba(255,255,255,0.6);
  }
  .valid b { color: #fff; font-weight: 600; letter-spacing: 0.06em; }
  .note { padding-top: 4pt; color: rgba(255,255,255,0.38); max-width: 280pt; line-height: 1.5; }
  .site { font-weight: 500; letter-spacing: 0.16em; color: rgba(255,255,255,0.8); }
  </style></head><body>
  <div class="sheet">
    <div class="top">
      <div class="eyebrow">${esc(t.tagline)}</div>
      ${logo ? `<img class="logo" src="${logo}" alt="">` : '<div class="wordmark">Quentino</div>'}
    </div>
    <div class="rule"></div>

    <div class="middle">
      <div class="title">${esc(t.title)}</div>
      <div class="amount-row">
        <div class="amount">${esc(value)}${isPercent ? `<small>${esc(t.discount)}</small>` : ''}</div>
        <div class="code-block">
          <div class="code-label">${esc(t.code)}</div>
          <div class="code">${esc(code)}</div>
        </div>
      </div>
    </div>

    <div class="rule"></div>
    <div class="bottom">
      <div>
        <div class="valid">${spec.validUntil ? `${esc(t.validUntil)} <b>${esc(fmtDate(spec.validUntil, lang))}</b>` : ''}</div>
        ${spec.note ? `<div class="note">${esc(spec.note)}</div>` : ''}
      </div>
      <div class="site">${esc(DOMAIN[lang])}</div>
    </div>
  </div>
  </body></html>`;
}

/** Vysází poukaz do PDF a vrátí cestu k dočasnému souboru pro přílohu. */
export async function createVoucherPdf(spec: VoucherSpec, code: string): Promise<string> {
  const html = voucherHtml(spec, code);
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    // Písmo je vložené přímo v dokumentu, ale vykreslení se dokončí až po jeho
    // rozbalení — bez krátkého čekání by PDF vyjelo náhradním řezem.
    await win.webContents.executeJavaScript(
      'new Promise(r => { const t = setTimeout(r, 2500); document.fonts.ready.then(() => { clearTimeout(t); setTimeout(r, 80); }); })',
      true
    ).catch(() => { /* i tak se vysadí, jen náhradním řezem */ });
    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      pageSize: { width: 595 / 72, height: 283 / 72 }, // printToPDF chce palce
      margins: { marginType: 'none' }
    });
    const dir = path.join(app.getPath('temp'), 'quentino-vouchers');
    fs.mkdirSync(dir, { recursive: true });
    const safe = code.replace(/[^\w-]/g, '') || 'poukaz';
    const file = path.join(dir, `${T[spec.lang].file}-${safe}.pdf`);
    fs.writeFileSync(file, pdf);
    return file;
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

/** Několik kódů na stejnou hodnotu = několik samostatných PDF. */
export async function createVouchers(spec: VoucherSpec): Promise<string[]> {
  const codes = spec.codes.map(c => c.trim()).filter(Boolean);
  const out: string[] = [];
  for (const c of codes) out.push(await createVoucherPdf(spec, c));
  return out;
}
