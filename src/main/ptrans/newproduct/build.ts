import { getDb } from '../../db';
import { setField, encodeValue, feedHeader } from '../xml';
import { categoryByCode } from '../categories';
import { DraftProduct } from './draft';

/**
 * Sestavení XML pro nový produkt.
 *
 * Základ je **blok předlohy z feedu**, ne prázdná kostra. Upgates u produktu
 * vydává desítky značek, o kterých aplikace nic neví (hmotnost, jednotka,
 * sazba DPH, dodací lhůta, příznaky viditelnosti) — a u sourozeneckého
 * produktu jsou skoro vždycky správně. Psát blok od nuly by znamenalo buď je
 * všechny vyjmenovat, nebo je nechat na výchozích hodnotách Upgates, což se
 * pozná až na e-shopu.
 *
 * Nebezpečné značky se naopak vyhazují ručně a jmenovitě — viz `DROP`.
 */

/**
 * Co se z předlohy NESMÍ přenést.
 *
 * `PRODUCT_ID` identifikuje existující produkt — s ním by import nezaložil
 * nový, ale přepsal předlohu. `STOCK` a `AVAILABILITY` patří administraci a
 * naskladnění. `VARIANTS` nesou vlastní kódy a zásoby předlohy. `EAN` je
 * unikátní číslo, dvakrát existovat nesmí.
 */
const DROP = ['PRODUCT_ID', 'STOCK', 'AVAILABILITY', 'AVAILABILITY_ID', 'STOCK_POSITION',
  'VARIANTS', 'EAN', 'RELATED_PRODUCTS', 'ALTERNATIVE_PRODUCTS', 'ACCESSORIES',
  'GIFTS', 'BENEFITS', 'LABELS', 'DISCOUNTS'];

/** Značky uvnitř ceny, které se z předlohy nepřenášejí — viz `buildPrices`. */
const DROP_IN_PRICE = ['PRICE_SALE', 'PRICE_WITHOUT_VAT', 'PRICE_ORIGINAL',
  'PRICE_COMMON', 'PRICE_PURCHASE', 'ACTION_PRICE_YN', 'ACTION_PRICE_FROM', 'ACTION_PRICE_TO'];

/* ---------- práce se značkami ---------- */

function dropSection(block: string, name: string): string {
  return block
    .replace(new RegExp(`[ \\t]*<${name}>[\\s\\S]*?</${name}>\\s*\\n?`, 'g'), '')
    .replace(new RegExp(`[ \\t]*<${name}\\s*/>\\s*\\n?`, 'g'), '');
}

function hasSection(block: string, name: string): boolean {
  return new RegExp(`<${name}[\\s>/]`).test(block);
}

/** Nahradí obsah značky; když značka chybí, přidá ji hned za `<CODE>`. */
function setSection(block: string, name: string, inner: string): string {
  const pair = new RegExp(`<${name}>[\\s\\S]*?</${name}>`);
  const empty = new RegExp(`<${name}\\s*/>`);
  const replacement = `<${name}>${inner}</${name}>`;
  if (pair.test(block)) return block.replace(pair, replacement);
  if (empty.test(block)) return block.replace(empty, replacement);
  const afterCode = /<\/CODE>/.exec(block);
  if (!afterCode) return block + `\n\t\t${replacement}`;
  const at = afterCode.index + afterCode[0].length;
  return block.slice(0, at) + `\n\t\t${replacement}` + block.slice(at);
}

function setSimple(block: string, name: string, value: string): string {
  return setSection(block, name, encodeValue(value, false));
}

/* ---------- jednotlivé sekce ---------- */

/**
 * Kategorie se zapisují kódem, ne názvem.
 *
 * Kód je to jediné, co je v e-shopu stálé — název se dá přejmenovat a import
 * podle názvu by pak založil kategorii novou, se stejným jménem a prázdnou.
 */
export function buildCategories(codes: string[], main: string,
                                names: (code: string) => Record<string, string> = () => ({})): string {
  const list = codes.filter(Boolean);
  if (list.length === 0) return '';
  return '\n' + list.map(code => {
    /*
     * Kromě kódu se zapisuje i název. Import se řídí kódem, ale aplikace si
     * z vlastního exportu čte kategorii produktu **podle názvu** — bez něj by
     * nový produkt zůstal „bez kategorie" a přišel by o všechno, co se podle
     * kategorie řídí: tvar názvu, styl textů i atributy pro Google.
     */
    const langs = Object.entries(names(code));
    const naming = langs.length
      ? langs.map(([lang, name]) =>
        `\n\t\t\t\t<NAME language="${lang}">${encodeValue(name, false)}</NAME>`).join('')
      : '';
    return `\t\t\t<CATEGORY>\n\t\t\t\t<CODE>${encodeValue(code, false)}</CODE>${naming}\n`
      + `\t\t\t\t<PRIMARY_YN>${code === main ? 1 : 0}</PRIMARY_YN>\n\t\t\t</CATEGORY>`;
  }).join('\n') + '\n\t\t';
}

export function buildImages(images: DraftProduct['images']): string {
  const list = images.filter(one => one.url);
  if (list.length === 0) return '';
  return '\n' + list.map((one, index) =>
    `\t\t\t<IMAGE>\n\t\t\t\t<URL>${encodeValue(one.url!, false)}</URL>\n`
    + `\t\t\t\t<MAIN_YN>${one.main ? 1 : 0}</MAIN_YN>\n`
    + `\t\t\t\t<LIST_YN>${one.main ? 1 : 0}</LIST_YN>\n`
    + `\t\t\t\t<POSITION>${index + 1}</POSITION>\n\t\t\t</IMAGE>`
  ).join('\n') + '\n\t\t';
}

/**
 * Parametry se zapisují ve všech jazycích najednou.
 *
 * Nepřeložený parametr se v cizí mutaci ukáže česky — a „Barva: modrá"
 * v anglickém e-shopu je vidět na první pohled. Dokud překlad není, použije
 * se čeština u všech jazyků; přepíše se, jakmile překlad doběhne.
 */
export function buildParameters(params: DraftProduct['params'], langs: string[],
                                translated: Record<string, { name: string; value: string }[]> = {}): string {
  const list = params.filter(one => one.name.trim());
  if (list.length === 0) return '';
  const pieces = list.map((one, index) => {
    const names = langs.map(lang => {
      const t = translated[lang]?.[index];
      return `\t\t\t\t<NAME language="${lang}">${encodeValue(t?.name || one.name, false)}</NAME>`;
    }).join('\n');
    const values = langs.map(lang => {
      const t = translated[lang]?.[index];
      return `\t\t\t\t<VALUE language="${lang}">${encodeValue(t?.value || one.value, false)}</VALUE>`;
    }).join('\n');
    return `\t\t\t<PARAMETER>\n${names}\n${values}\n\t\t\t</PARAMETER>`;
  });
  return '\n' + pieces.join('\n') + '\n\t\t';
}

/**
 * Ceny.
 *
 * Z předlohy se bere **tvar** bloku (sazba DPH, ceník, měna), ale ne částky —
 * a hlavně se vyhazuje akční cena. Přenesená akční cena by nový produkt
 * rovnou vystavila ve slevě, aniž by to bylo kdekoli vidět.
 */
export function buildPrices(templatePrices: string, prices: Record<string, string>,
                            langs: string[]): string {
  const shape = new Map<string, string>();
  for (const piece of templatePrices.split('<PRICE ').slice(1)) {
    const lang = /^language="([^"]+)"/.exec(piece)?.[1];
    if (lang) shape.set(lang, piece.slice(piece.indexOf('>') + 1).split('</PRICE>')[0]);
  }
  const fallbackCurrency = (lang: string) => (lang === 'cz' ? 'CZK' : 'EUR');

  const pieces: string[] = [];
  for (const lang of langs) {
    const amount = (prices[lang] ?? '').trim().replace(',', '.');
    if (!amount) continue;
    let body = shape.get(lang) ?? shape.get('cz') ?? '';
    for (const name of DROP_IN_PRICE) body = dropSection(body, name);
    if (!body.trim() || !hasSection(body, 'CURRENCY')) {
      body = `\n\t\t\t\t<CURRENCY>${fallbackCurrency(lang)}</CURRENCY>\n\t\t\t`;
    }
    body = hasSection(body, 'PRICE_WITH_VAT')
      ? setSection(body, 'PRICE_WITH_VAT', encodeValue(amount, false))
      : body.replace(/\s*$/, `\n\t\t\t\t<PRICE_WITH_VAT>${encodeValue(amount, false)}</PRICE_WITH_VAT>\n\t\t\t`);
    pieces.push(`\t\t\t<PRICE language="${lang}">${body}</PRICE>`);
  }
  return pieces.length ? '\n' + pieces.join('\n') + '\n\t\t' : '';
}

/**
 * Vyprázdní adresy zděděné po předloze.
 *
 * Tohle je nejtišší ze všech chyb, které tady hrozí: `<SEO_URL>` se v bloku
 * předlohy veze dál a nový produkt by se naimportoval **na adresu předlohy**.
 * Dvě stránky se stejnou adresou znamenají, že jedna z nich v e-shopu
 * přestane existovat — a je to ta nová. Stejně tak `<URL>` v popisu (odkaz na
 * produkt) a přesměrování starých adres.
 *
 * Vyprázdní se, ne vyhodí: Upgates si adresu doplní z názvu, a než se doplní
 * překlad, je prázdná adresa jediná bezpečná hodnota.
 */
export function clearInheritedUrls(block: string): string {
  let out = block.replace(/<SEO_URL>[\s\S]*?<\/SEO_URL>/g, '<SEO_URL></SEO_URL>');
  const wrap = /<DESCRIPTIONS>([\s\S]*?)<\/DESCRIPTIONS>/.exec(out);
  if (wrap) {
    // Jen uvnitř popisů — `<URL>` je i v obrázcích a ty se stejně přepisují celé
    const inner = wrap[1].replace(/<URL>[\s\S]*?<\/URL>/g, '<URL></URL>');
    out = out.slice(0, wrap.index) + `<DESCRIPTIONS>${inner}</DESCRIPTIONS>`
      + out.slice(wrap.index + wrap[0].length);
  }
  // Přesměrování starých adres patří předloze; u nového produktu žádná stará
  // adresa neexistuje a zděděné přesměrování by vedlo jinam, než čeká
  return out.replace(
    /(<META_KEY>redirect_301<\/META_KEY>[\s\S]*?<META_VALUES>)([\s\S]*?)(<\/META_VALUES>)/g,
    (_all, head, body, tail) => head + body.replace(/(<META_VALUE[^>]*>)[\s\S]*?(<\/META_VALUE>)/g, '$1$2') + tail
  );
}

/* ---------- celý produkt ---------- */

export interface BuildOptions {
  langs: string[];
  /** Přeložené parametry podle jazyka, v pořadí odpovídajícím `draft.params` */
  params?: Record<string, { name: string; value: string }[]>;
  sourceLang?: string;
}

/** Kostra pro případ, že se nový produkt nedělá podle předlohy. */
const SKELETON = [
  '\n\t\t<CODE></CODE>',
  '\t\t<ACTIVE_YN>1</ACTIVE_YN>',
  '\t\t<ARCHIVED_YN>0</ARCHIVED_YN>',
  '\t\t<CAN_ADD_TO_BASKET_YN>1</CAN_ADD_TO_BASKET_YN>',
  '\t\t<DESCRIPTIONS></DESCRIPTIONS>',
  '\t\t<SEO_OPTIMALIZATION></SEO_OPTIMALIZATION>',
  '\t\t<METAS></METAS>',
  '\t\t<CATEGORIES></CATEGORIES>',
  '\t\t<IMAGES></IMAGES>',
  '\t\t<PARAMETERS></PARAMETERS>',
  '\t\t<PRICES></PRICES>\n\t'
].join('\n');

export function buildProductBlock(draft: DraftProduct, options: BuildOptions): string {
  const d = getDb();
  const template = draft.templateCode
    ? (d.prepare('SELECT raw_xml FROM ptrans_products WHERE code = ?').get(draft.templateCode) as
        { raw_xml: string } | undefined)?.raw_xml
    : undefined;

  const sourceLang = options.sourceLang ?? 'cz';
  const priceShape = /<PRICES>([\s\S]*?)<\/PRICES>/.exec(template ?? '')?.[1] ?? '';

  let block = template ?? SKELETON;
  for (const name of DROP) block = dropSection(block, name);
  block = clearInheritedUrls(block);

  block = setSimple(block, 'CODE', draft.code.trim());
  if (draft.ean.trim()) block = setSimple(block, 'EAN', draft.ean.trim());
  if (draft.manufacturer.trim()) block = setSimple(block, 'MANUFACTURER', draft.manufacturer.trim());

  block = setSection(block, 'CATEGORIES',
    buildCategories(draft.categories, draft.mainCategory, code => categoryByCode(code)?.names ?? {}));
  block = setSection(block, 'IMAGES', buildImages(draft.images));
  block = setSection(block, 'PARAMETERS', buildParameters(draft.params, options.langs, options.params));
  block = setSection(block, 'PRICES', buildPrices(priceShape, draft.prices, options.langs));

  /*
   * Texty se zapisují přes `setField` — stejnou cestou jako překlady. Kdyby
   * se skládaly zvlášť, rozešel by se tvar (CDATA, prázdné prvky, pořadí
   * značek) a nový produkt by se do e-shopu dostal jinak než opravený.
   */
  for (const lang of options.langs) {
    const texts = draft.langs[lang];
    if (!texts) continue;
    for (const [field, value] of Object.entries(texts)) {
      if (!value?.trim()) continue;
      block = setField(block, lang, field, value, sourceLang);
    }
    for (const [field, value] of Object.entries(draft.google)) {
      if (!value?.trim()) continue;
      block = setField(block, lang, field, value, sourceLang);
    }
  }
  return block;
}

export function buildProductXml(draft: DraftProduct, options: BuildOptions): string {
  const block = buildProductBlock(draft, options);
  const head = '<?xml version="1.0" encoding="UTF-8"?>\n'
    + `<!--Quentino App: nový produkt ${draft.code} · ${new Date().toLocaleString('cs-CZ')}-->\n`
    + '<PRODUCTS version="2.0">\n';
  return `${head}\t<PRODUCT>${block}</PRODUCT>\n</PRODUCTS>\n`;
}

export const __test = { dropSection, setSection, setSimple, clearInheritedUrls, DROP, feedHeader };
