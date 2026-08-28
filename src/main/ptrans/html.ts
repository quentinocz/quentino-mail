/**
 * Úklid popisů produktů.
 *
 * Popisy se do e-shopu často vkládají kopírováním z jiného okna — z editoru,
 * z dokumentu, z chatu s jazykovým modelem. Do textu se tím dostane celý
 * obal cizí stránky: `<article>` a hromada `<div>`, `class` na půl obrazovky,
 * `data-turn-id`, `data-testid`, `data-start`. Čtenář to nevidí, ale:
 *
 *  - **popis se nemusí vůbec zobrazit** — e-shop takový kód buď zahodí,
 *    nebo mu rozbije rozvržení stránky,
 *  - platí se za to při každém překladu: ve zdejším feedu je **třetina všech
 *    znaků v popisech** jen tenhle balast, a ten se posílá modelu pořád dokola,
 *  - dlouhý popis kvůli němu narazí na strop odpovědi a nepřeloží se vůbec.
 *
 * Pravidlo úklidu je jednoduché a schválně opatrné: **text se nesmí změnit
 * ani o písmeno**. Zahazují se jen značky, které nic neznamenají, a atributy,
 * které nikam nevedou. Když si nejsme jistí, značka se rozbalí (obsah
 * zůstane), ne zahodí — ztratit kus popisu je horší než nechat tam `<span>`.
 */

/** Nese obsah nebo formátování, které má v popisu smysl. */
const KEEP = new Set([
  'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'ul', 'ol', 'li',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'img', 'hr', 'blockquote',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
  'small', 'sub', 'sup', 'figure', 'figcaption', 'code', 'pre'
]);

/** Obal bez vlastního významu — obsah se zachová, značka zmizí. */
const UNWRAP = new Set([
  'div', 'article', 'section', 'main', 'header', 'footer', 'aside', 'nav',
  'span', 'font', 'center', 'body', 'html', 'template', 'picture'
]);

/** Zahodí se i s obsahem — do popisu produktu tohle nepatří. */
const DROP = new Set([
  'script', 'style', 'noscript', 'iframe', 'svg', 'canvas', 'button',
  'form', 'input', 'select', 'textarea', 'meta', 'link', 'head', 'title'
]);

/** Atributy, které něco dělají. Všechno ostatní jde pryč. */
const ATTRS: Record<string, Set<string>> = {
  a: new Set(['href', 'title', 'target', 'rel']),
  img: new Set(['src', 'alt', 'title', 'width', 'height', 'loading']),
  td: new Set(['colspan', 'rowspan']),
  th: new Set(['colspan', 'rowspan']),
  table: new Set(['border']),
  ol: new Set(['start'])
};

/** Značky bez uzavírací části. */
const VOID = new Set(['br', 'hr', 'img']);

/** Vytáhne z otevírací značky povolené atributy. */
function keepAttrs(tag: string, raw: string): string {
  const allowed = ATTRS[tag];
  if (!allowed) return '';
  const out: string[] = [];
  for (const found of raw.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+)/g)) {
    const name = found[1].toLowerCase();
    if (!allowed.has(name)) continue;
    let value = found[2];
    if (!value.startsWith('"') && !value.startsWith("'")) value = `"${value}"`;
    // Odkaz na `javascript:` v popisu produktu nemá co dělat
    if (name === 'href' && /^\s*["']?\s*javascript:/i.test(value)) continue;
    out.push(`${name}=${value.replace(/^'|'$/g, '"')}`);
  }
  return out.length ? ' ' + out.join(' ') : '';
}

/**
 * Očistí HTML popisu.
 *
 * Vrací text se stejným obsahem, jen bez balastu. Když na vstupu HTML není
 * (holý text), vrátí se beze změny.
 */
export function tidyHtml(input: string): string {
  if (!input || !input.includes('<')) return input;

  // 1) Pryč s tím, co nemá v popisu co dělat — i s obsahem
  let html = input;
  for (const tag of DROP) {
    html = html
      .replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'), '')
      .replace(new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi'), '');
  }
  // Komentáře (často `<!--[if mso]>` z Wordu) taky pryč
  html = html.replace(/<!--[\s\S]*?-->/g, '');

  // 2) Značku po značce: nechat, rozbalit, nebo (u neznámé) radši rozbalit
  html = html.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g, (whole, rawName: string, rest: string) => {
    const tag = rawName.toLowerCase();
    const closing = whole.startsWith('</');
    if (UNWRAP.has(tag)) return '';
    if (!KEEP.has(tag)) return '';           // neznámá značka: obsah zůstane, obal ne
    if (closing) return `</${tag}>`;
    if (VOID.has(tag)) return `<${tag}${keepAttrs(tag, rest)}>`;
    return `<${tag}${keepAttrs(tag, rest)}>`;
  });

  // 3) Po rozbalení zbývají prázdné odstavce a přebytečné mezery
  //
  // Pozor na rozdíl mezi `<strong></strong>` (opravdu prázdné, pryč s ním)
  // a `<strong> </strong>` (mezera mezi dvěma slovy, jen zabalená ve značce).
  // To druhé se v popisech běžně vyskytuje — když se zahodí i s obsahem,
  // slepí se dvě slova k sobě. Značka tedy mizí, ale mezera zůstává.
  let previous = '';
  while (previous !== html) {
    previous = html;
    html = html.replace(
      /<(p|li|strong|b|em|i|u|h[1-6]|blockquote|small)>(\s*)<\/\1>/gi,
      (_m, _tag, inner: string) => (inner ? ' ' : '')
    );
  }
  html = html
    .replace(/[ \t]*\n[ \t]*\n+/g, '\n')     // prázdné řádky po zmizelých obalech
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/>\s+</g, (m) => (m.includes('\n') ? '>\n<' : '> <'))
    .trim();

  return html;
}

/** Jen text, bez značek a bez rozdílů v mezerách — na porovnání „nic se neztratilo". */
export function textOnly(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Má smysl to uklízet?
 *
 * Hlásí se jen zřetelný balast, ne každý `<div>`. Cílem není přepisovat
 * poctivě napsané popisy, ale najít ty, do kterých se omylem dostal kus
 * cizí stránky.
 */
export function needsTidy(html: string): boolean {
  if (!html || !html.includes('<')) return false;
  const cleaned = tidyHtml(html);
  if (cleaned === html) return false;
  // Drobnost (jeden `<span>`) nikoho netrápí; hlásí se, až když balast
  // tvoří znatelnou část textu
  return html.length - cleaned.length > 200
    || /data-turn-id|data-testid|conversation-turn|<article\b/i.test(html);
}
