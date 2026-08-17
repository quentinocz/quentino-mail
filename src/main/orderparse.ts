import type { OrderCard, OrderCardItem, OrderAddress, MailLang } from '../shared/types';

/**
 * Čistý parser potvrzení objednávky (Upgates e-mailová šablona) — CZ / SK / EN.
 * Bez závislostí na Electronu ani databázi, aby šel testovat samostatně.
 */

// ---------- pomocné funkce nad HTML ----------

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  eacute: 'é', aacute: 'á', iacute: 'í', oacute: 'ó', uacute: 'ú', yacute: 'ý',
  hellip: '…', ndash: '–', mdash: '—', bdquo: '„', ldquo: '“', rdquo: '”', euro: '€'
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

/** HTML → text; <br> a </p> se mění na zalomení, aby šly rozeznat řádky adres. */
function toText(html: string): string {
  return decodeEntities(
    html
      .replace(/<\s*br\s*\/?>/gi, '\n')
      .replace(/<\/\s*(p|div|tr|h\d|li)\s*>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/ /g, ' ')
    .replace(/[ \t]+/g, ' ')
    .split('\n')
    .map(l => l.trim())
    .filter((l, i, arr) => !(l === '' && arr[i - 1] === ''))
    .join('\n')
    .trim();
}

function oneLine(html: string): string {
  return toText(html).replace(/\s*\n\s*/g, ' ').trim();
}

/**
 * Vrátí jen nejvnitřnější řádky tabulek. E-mailové šablony vnořují tabulky do
 * sebe, takže prosté hledání <tr>…</tr> by první položku spolklo do obalového
 * řádku — proto se hlídá zanoření.
 */
function innerRows(html: string): string[] {
  const out: string[] = [];
  const stack: number[] = [];
  const re = /<(\/?)tr\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (!m[1]) { stack.push(re.lastIndex); continue; }
    const start = stack.pop();
    if (start === undefined) continue;
    const inner = html.slice(start, m.index);
    if (!/<tr\b/i.test(inner)) out.push(inner);
  }
  return out;
}

// ---------- jazykové sady ----------

const KW = {
  billing: ['fakturační adresa', 'fakturačná adresa', 'fakturační údaje', 'billing address', 'invoice address'],
  shipping: ['poštovní adresa', 'poštová adresa', 'doručovací adresa', 'dodacia adresa', 'dodací adresa',
    'adresa doručení', 'shipping address', 'delivery address', 'postal address'],
  items: ['položky objednávky', 'položky objednávky', 'order items', 'items'],
  shipment: ['doprava', 'doručení', 'doručenie', 'přeprava', 'shipping', 'delivery', 'postage'],
  payment: ['platba', 'způsob platby', 'spôsob platby', 'payment'],
  total: ['celkem', 'celkom', 'spolu', 'total', 'k úhradě', 'k úhrade', 'grand total'],
  code: ['kód', 'kod', 'code', 'sku'],
  availability: ['dostupnost', 'dostupnosť', 'availability', 'stock'],
  qtyUnit: ['ks', 'pcs', 'pc', 'x', 'szt', 'kus']
};

/** Jazyk se určuje podle počtu zásahů, ne podle pořadí — smíšené maily jinak vždy vyjdou jako čeština. */
function detectLang(text: string): MailLang {
  const t = text.toLowerCase();
  const score: Record<MailLang, number> = { cz: 0, sk: 0, en: 0 };
  const marks: Record<MailLang, RegExp[]> = {
    sk: [/fakturačná/, /poštová adresa/, /prijat[áé]/, /dostupnosť/, /celkom/, /objednávk[ay] číslo/],
    cz: [/fakturační/, /poštovní adresa/, /přijat[áéo]/, /dostupnost\b/, /celkem/, /děkujeme/],
    en: [/billing address/, /order items/, /delivery address/, /availability/, /\btotal\b/, /thank you/]
  };
  for (const l of ['cz', 'sk', 'en'] as MailLang[]) {
    for (const re of marks[l]) if (re.test(t)) score[l]++;
  }
  const best = (['cz', 'sk', 'en'] as MailLang[]).reduce((a, b) => (score[b] > score[a] ? b : a), 'cz');
  return score[best] > 0 ? best : 'cz';
}

function startsWithKw(s: string, list: string[]): boolean {
  const t = s.trim().toLowerCase();
  return list.some(k => t === k || t.startsWith(k + ' ') || t.startsWith(k + ':') || t.startsWith(k + '\n'));
}

function containsKw(s: string, list: string[]): boolean {
  const t = s.toLowerCase();
  return list.some(k => t.includes(k));
}

// ---------- adresy ----------

const COUNTRIES = /^(česk[áé]\s+republika|slovensk[áé]\s+republika|slovensko|čechy|czech republic|czechia|slovakia|deutschland|germany|austria|rakousko|polska|poland|united kingdom|usa)$/i;

function parseAddress(block: string): OrderAddress | null {
  const lines = toText(block).split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  const name = lines[0];
  let rest = lines.slice(1);
  let country: string | null = null;
  if (rest.length && COUNTRIES.test(rest[rest.length - 1])) country = rest.pop()!;
  // Druhý řádek bývá firma (obsahuje s.r.o./a.s./spol. apod. nebo nemá číslo popisné)
  let company: string | null = null;
  if (rest.length > 1 && /\b(s\.?\s?r\.?\s?o|a\.?\s?s|spol|ltd|llc|gmbh|inc|k\.?s|v\.?o\.?s)\b/i.test(rest[0])) {
    company = rest.shift()!;
  }
  return { name, company, lines: rest, country };
}

// ---------- ceny ----------

function looksLikePrice(s: string): boolean {
  // Pozor: bez \b — hranice slova za „Kč“ v JS regulárním výrazu neplatí (č není [a-z0-9_])
  return /\d[\d\s .,]*\s*(kč|czk|€|eur|\$|usd|£|gbp|zł|pln)(?![\p{L}])/iu.test(s.trim());
}

function normPrice(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Varianty produktu („- Délka: 110cm", „Šířka: 7cm"). Při balení jsou zásadní —
 * kšandy 110 a 120 cm vypadají na fotce stejně, takže musí být vidět zvlášť.
 */
function parseVariants(cellText: string): string[] {
  const skip = [...KW.code, ...KW.availability];
  const out: string[] = [];
  for (const raw of cellText.split('\n').slice(1)) {
    const line = raw.replace(/^[-–•*]\s*/, '').trim();
    const m = line.match(/^([\p{L} ]{2,24}?)\s*:\s*(.{1,40})$/u);
    if (!m) continue;
    if (skip.some(k => m[1].toLowerCase().startsWith(k))) continue;
    out.push(`${m[1].trim()}: ${m[2].trim()}`);
  }
  return out;
}

/** Odřízne cenu z konce řádku a vrátí zbytek textu i cenu zvlášť. */
function splitTrailingPrice(line: string): { text: string; price: string | null } {
  const m = line.match(/^([\s\S]*?)\s*([\d][\d\s .,]*\s*(?:kč|czk|€|eur|\$|usd|£|gbp|zł|pln))\s*$/iu);
  return m ? { text: m[1].trim(), price: normPrice(m[2]) } : { text: line.trim(), price: null };
}

/**
 * Položky z textové varianty mailu (bez HTML). Šablona drží pořadí:
 * „1 ks / Název", „Kód: X", „Dostupnost: Y <cena>", pak Doprava / Platba / CELKEM.
 */
function parsePlainItems(text: string): {
  items: OrderCardItem[];
  shipmentName: string | null; shipmentPrice: string | null;
  paymentName: string | null; paymentPrice: string | null;
  total: string | null;
} {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const items: OrderCardItem[] = [];
  let shipmentName: string | null = null, shipmentPrice: string | null = null;
  let paymentName: string | null = null, paymentPrice: string | null = null;
  let total: string | null = null;
  let cur: OrderCardItem | null = null;
  let pending: 'shipment' | 'payment' | null = null;

  const push = () => { if (cur) { items.push(cur); cur = null; } };

  for (const raw of lines) {
    const { text: line, price } = splitTrailingPrice(raw);

    if (pending) {
      const name = line.replace(/<[^>]*>/g, '').trim();
      if (pending === 'shipment') { shipmentName = name || null; shipmentPrice = price; }
      else { paymentName = name || null; paymentPrice = price; }
      pending = null;
      continue;
    }

    const qtyM = line.match(/^(\d+(?:[.,]\d+)?)\s*([\p{L}.]{0,4})\s*[/×x]\s*(.+)$/u);
    if (qtyM) {
      push();
      cur = {
        qty: Number(qtyM[1].replace(',', '.')) || 1,
        unit: (qtyM[2] || '').replace(/\.$/, '') || null,
        // V textové variantě je URL za názvem v lomených závorkách
        title: qtyM[3].replace(/<[^>]*>\s*$/, '').trim(),
        code: null,
        url: (qtyM[3].match(/<(https?:\/\/[^>]+)>/) ?? [])[1] ?? null,
        price: price ?? '',
        availability: null, variants: [], image: null, feedUrl: null, feedPrice: null, matched: false
      };
      continue;
    }

    const codeM = line.match(new RegExp(`^(?:${KW.code.join('|')})\\s*:\\s*(.+)$`, 'i'));
    if (codeM && cur) { cur.code = codeM[1].trim(); if (price) cur.price = price; continue; }

    const availM = line.match(new RegExp(`^(?:${KW.availability.join('|')})\\s*:\\s*(.+)$`, 'i'));
    if (availM && cur) { cur.availability = availM[1].trim(); if (price) cur.price = price; continue; }

    if (startsWithKw(line, KW.total)) { push(); total = price ?? total; continue; }
    if (startsWithKw(line, KW.shipment) && !line.includes(':')) { push(); pending = 'shipment'; continue; }
    if (startsWithKw(line, KW.payment) && !line.includes(':')) { push(); pending = 'payment'; continue; }
  }
  push();
  return { items, shipmentName, shipmentPrice, paymentName, paymentPrice, total };
}

// ---------- hlavní parser ----------

export function parseOrderEmail(input: {
  subject: string;
  html: string | null;
  text: string | null;
  toAddr: string;
}): OrderCard | null {
  const html = input.html ?? '';
  const plain = input.text ?? '';
  const bodyText = html ? toText(html) : plain;
  if (!bodyText) return null;

  const lang = detectLang(`${input.subject}\n${bodyText}`);

  // --- číslo objednávky ---
  let orderNumber: string | null = null;
  const numPatterns: RegExp[] = [
    /(?:objednávk\w*|objednávka|order|bestellung)[^\n\d]{0,40}?(?:čísl\w+|číslo|č\.|number|no\.?|#)\s*:?\s*([0-9][0-9\-/]{2,})/i,
    /(?:čísl\w+\s+objednávky|order\s+number|order\s+no\.?)\s*:?\s*([0-9][0-9\-/]{2,})/i,
    /(?:č\.|no\.|#)\s*([0-9][0-9\-/]{3,})/i
  ];
  for (const src of [input.subject, bodyText]) {
    for (const re of numPatterns) {
      const m = src.match(re);
      if (m) { orderNumber = m[1].replace(/[^0-9\-/]/g, ''); break; }
    }
    if (orderNumber) break;
  }

  // --- odkaz na historii objednávky ---
  const hist = html.match(/href="([^"]*(?:history-detail|order-detail|objednavka)[^"]*)"/i);
  const historyUrl = hist ? decodeEntities(hist[1]) : null;

  // --- datum přijetí ---
  const dateM = bodyText.match(/(?:datum a čas přijetí|dátum a čas prijatia|date received|order date|datum objednávky)\s*:?\s*([^\n]+)/i);
  const placedAt = dateM ? dateM[1].trim() : null;

  // --- adresy (dvojice <h2>nadpis</h2><p>obsah</p>) ---
  let billing: OrderAddress | null = null;
  let shipping: OrderAddress | null = null;
  const headed: { label: string; block: string }[] = [];
  const secRe = /<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>\s*(?:<[^>]+>\s*)*?<p[^>]*>([\s\S]*?)<\/p>/gi;
  let sm: RegExpExecArray | null;
  while ((sm = secRe.exec(html))) headed.push({ label: oneLine(sm[1]), block: sm[2] });
  for (const h of headed) {
    if (!billing && containsKw(h.label, KW.billing)) billing = parseAddress(h.block);
    else if (!shipping && containsKw(h.label, KW.shipping)) shipping = parseAddress(h.block);
  }
  // Záloha pro čistě textové maily
  if (!billing && !shipping) {
    const tb = bodyText.match(/(?:fakturační|fakturačná|billing)[^\n]*\n([\s\S]{0,220}?)(?:\n\n|$)/i);
    const ts = bodyText.match(/(?:poštovní|poštová|doručovací|dodací|shipping|delivery)[^\n]*\n([\s\S]{0,220}?)(?:\n\n|$)/i);
    if (tb) billing = parseAddress(tb[1].replace(/\n/g, '<br>'));
    if (ts) shipping = parseAddress(ts[1].replace(/\n/g, '<br>'));
  }

  // --- řádky tabulky ---
  const items: OrderCardItem[] = [];
  let shipmentName: string | null = null;
  let shipmentPrice: string | null = null;
  let paymentName: string | null = null;
  let paymentPrice: string | null = null;
  let total: string | null = null;

  for (const row of innerRows(html)) {
    const cells = [...row.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(c => c[1]);
    if (cells.length < 2) continue;

    const priceTxt = oneLine(cells[cells.length - 1]);
    const textCells = cells.map(c => toText(c)).filter(Boolean);
    // Popisná buňka = ta nejobsáhlejší mimo poslední (cenovou); obrázkové buňky jsou prázdné
    const contentCells = cells.slice(0, -1);
    const bodyCell = contentCells.reduce((best, c) => (toText(c).length > toText(best).length ? c : best), contentCells[0]);
    const cellText = toText(bodyCell);

    // Položka: "1 ks / Název" (+ Kód / Dostupnost)
    const qtyM = cellText.match(/^\s*(\d+(?:[.,]\d+)?)\s*([\p{L}.]{0,4})\s*[/×x]\s*([\s\S]+)/u);
    const isItem = !!qtyM && (containsKw(cellText, KW.code) || /<a\b[^>]*href=/i.test(bodyCell));

    if (isItem && qtyM) {
      const linkM = bodyCell.match(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
      const firstLine = qtyM[3].split('\n')[0].trim();
      const codeM = cellText.match(new RegExp(`(?:${KW.code.join('|')})\\s*:\\s*([^\\n]+)`, 'i'));
      const availM = cellText.match(new RegExp(`(?:${KW.availability.join('|')})\\s*:\\s*([^\\n]+)`, 'i'));
      items.push({
        qty: Number(qtyM[1].replace(',', '.')) || 1,
        unit: (qtyM[2] || '').replace(/\.$/, '') || null,
        title: linkM ? oneLine(linkM[2]) : firstLine,
        code: codeM ? codeM[1].trim() : null,
        url: linkM ? decodeEntities(linkM[1]) : null,
        price: looksLikePrice(priceTxt) ? normPrice(priceTxt) : '',
        availability: availM ? availM[1].trim() : null,
        variants: parseVariants(cellText),
        image: null,
        feedUrl: null,
        feedPrice: null,
        matched: false
      });
      continue;
    }

    // Doprava / platba / celkem
    if (!looksLikePrice(priceTxt) && !containsKw(cellText, KW.total)) continue;
    const label = cellText.split('\n')[0].trim();
    const detail = cellText.split('\n').slice(1).join(' ').trim();

    if (startsWithKw(label, KW.total) || (textCells.length <= 2 && containsKw(label, KW.total))) {
      total = normPrice(priceTxt);
    } else if (startsWithKw(label, KW.shipment) && shipmentName === null) {
      shipmentName = detail || label;
      shipmentPrice = looksLikePrice(priceTxt) ? normPrice(priceTxt) : null;
    } else if (startsWithKw(label, KW.payment) && paymentName === null) {
      paymentName = detail || label;
      paymentPrice = looksLikePrice(priceTxt) ? normPrice(priceTxt) : null;
    }
  }

  // Záloha pro maily bez HTML části — textová varianta má stejné pořadí řádků
  if (items.length === 0) {
    const t = parsePlainItems(bodyText);
    items.push(...t.items);
    shipmentName = shipmentName ?? t.shipmentName;
    shipmentPrice = shipmentPrice ?? t.shipmentPrice;
    paymentName = paymentName ?? t.paymentName;
    paymentPrice = paymentPrice ?? t.paymentPrice;
    total = total ?? t.total;
  }

  // Celková částka jako záloha z předmětu ("… za 2 037,00 Kč")
  if (!total) {
    const sm2 = input.subject.match(/(?:za|for|celkem|total)\s+([\d\s .,]+(?:kč|czk|€|eur|\$|usd|£|zł))/i);
    if (sm2) total = normPrice(sm2[1]);
  }

  // Kontakt na zákazníka
  const emailM = bodyText.match(/[\w.+-]+@[\w-]+\.[\w.]{2,}/);
  const customerEmail = (input.toAddr || '').includes('@')
    ? input.toAddr.trim()
    : (emailM ? emailM[0] : null);
  const phoneM = bodyText.match(/(?:tel|telefon|phone|mobil|kontakt)[^\d+]{0,12}((?:\+\d{1,3}[\s ]?)?(?:\d[\s -]?){8,14})/i);

  // Potvrzení objednávky má vždy číslo a k tomu buď rozpis položek, nebo součet.
  // Volnější podmínka by kartu nabídla i u běžné zprávy, kde padne nějaké číslo.
  if (!orderNumber) return null;
  if (items.length === 0 && !total) return null;

  return {
    orderNumber,
    lang,
    placedAt,
    customerEmail,
    customerPhone: phoneM ? phoneM[1].replace(/[\s ]+/g, ' ').trim() : null,
    billing,
    shipping,
    items,
    shipmentName,
    shipmentPrice,
    paymentName,
    paymentPrice,
    total,
    historyUrl,
    adminUrl: null,
    adminSource: null,
    live: null,
    tracking: null
  };
}
