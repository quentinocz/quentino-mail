/**
 * Práce s produktovým XML z Upgates — čtení i zápis do stejného tvaru.
 *
 * Záměrně se nestaví DOM. Export musí jít zpátky naimportovat, takže se
 * pracuje s původním blokem `<PRODUCT>…</PRODUCT>` jako s textem a mění se
 * jen ta místa, která se opravdu překládají. Všechno ostatní — pořadí značek,
 * odsazení, prázdné prvky, CDATA i podivnosti konkrétního exportu — zůstane
 * bajt po bajtu stejné. Jakýkoli „chytrý" serializer by tuhle vlastnost
 * ztratil a import by se choval jinak, než člověk čeká.
 */

/** Klíč překládaného pole. `param:<index>:name|value` je parametr produktu. */
export type FieldKey = string;

export const TEXT_FIELDS = ['title', 'short', 'long', 'seo_title', 'seo_desc', 'seo_url',
  'google_title', 'google_desc'] as const;

/** Pole, jejichž obsah je HTML — překlad musí zachovat značky. */
export const HTML_FIELDS = new Set(['short', 'long']);

/** Kde které pole v XML leží. `scope` vymezí jazykovou část, `tag` je značka uvnitř. */
interface FieldSpec {
  scope: 'description' | 'seo' | 'meta';
  tag: string;
  /** Klíč v `<METAS>` (jen pro scope „meta") */
  metaKey?: string;
  /** Obsah se v exportu balí do CDATA */
  cdata?: boolean;
}

const SPECS: Record<string, FieldSpec> = {
  title: { scope: 'description', tag: 'TITLE' },
  short: { scope: 'description', tag: 'SHORT_DESCRIPTION', cdata: true },
  long: { scope: 'description', tag: 'LONG_DESCRIPTION', cdata: true },
  seo_title: { scope: 'seo', tag: 'SEO_TITLE' },
  seo_desc: { scope: 'seo', tag: 'SEO_META_DESCRIPTION' },
  seo_url: { scope: 'seo', tag: 'SEO_URL' },
  google_title: { scope: 'meta', tag: 'META_VALUE', metaKey: 'title_google_merchant' },
  google_desc: { scope: 'meta', tag: 'META_VALUE', metaKey: 'description_google_merchant' }
};

/* ---------- základní pomůcky ---------- */

export function unwrapCdata(raw: string): string {
  const text = raw.trim();
  if (!text.includes('<![CDATA[')) return text;
  // Sekcí může být víc za sebou: `]]>` uvnitř textu se při zápisu rozdělí na dvě
  // (viz encodeValue), takže se čte stejně, jako to čte XML parser — po částech.
  let out = '';
  let at = 0;
  while (at < text.length) {
    const start = text.indexOf('<![CDATA[', at);
    if (start === -1) { out += text.slice(at); break; }
    out += text.slice(at, start);
    const end = text.indexOf(']]>', start + 9);
    if (end === -1) { out += text.slice(start + 9); break; }
    out += text.slice(start + 9, end);
    at = end + 3;
  }
  return out.trim();
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/** Text do XML: buď CDATA (HTML), nebo escapované entity. */
export function encodeValue(value: string, cdata: boolean): string {
  if (cdata) {
    // „]]>" uvnitř CDATA by blok předčasně ukončil — rozdělí se na dva
    return `<![CDATA[${value.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
  }
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Obsah první značky `name` na dané úrovni; `null` když značka chybí. */
export function tagValue(block: string, name: string): string | null {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  if (m) return m[1];
  // `<TAG/>` je prázdná hodnota, ne chybějící značka
  return new RegExp(`<${name}(?:\\s[^>]*)?/>`).test(block) ? '' : null;
}

export function tagText(block: string, name: string): string {
  const raw = tagValue(block, name);
  return raw === null ? '' : decodeEntities(unwrapCdata(raw)).trim();
}

/* ---------- jazykové části produktu ---------- */

/** Rozsah `<DESCRIPTION language="sk">…</DESCRIPTION>` (nebo SEO) v bloku produktu. */
function scopeRange(block: string, scope: 'description' | 'seo', lang: string): [number, number] | null {
  const tag = scope === 'description' ? 'DESCRIPTION' : 'SEO';
  const open = new RegExp(`<${tag} language="${lang}"[^>]*>`, 'g');
  const m = open.exec(block);
  if (!m) return null;
  const start = m.index + m[0].length;
  const end = block.indexOf(`</${tag}>`, start);
  return end === -1 ? null : [start, end];
}

/** Rozsah `<META_VALUE language="sk">` pro daný `META_KEY`. */
function metaRange(block: string, metaKey: string, lang: string): [number, number] | null {
  const meta = new RegExp(
    `<META\\b[^>]*>\\s*<META_KEY>${metaKey}</META_KEY>[\\s\\S]*?</META>`
  ).exec(block);
  if (!meta) return null;
  const inner = meta[0];
  const value = new RegExp(`<META_VALUE language="${lang}"[^>]*>([\\s\\S]*?)</META_VALUE>`).exec(inner);
  if (value) {
    const start = meta.index + value.index + value[0].indexOf('>') + 1;
    return [start, start + value[1].length];
  }
  const empty = new RegExp(`<META_VALUE language="${lang}"[^>]*/>`).exec(inner);
  if (empty) {
    // Prázdný prvek nemá kam psát — zápis si ho přepíše celý (viz setField)
    const at = meta.index + empty.index;
    return [at, at + empty[0].length];
  }
  return null;
}

/** Hodnota překládaného pole tak, jak je ve feedu. */
export function getField(block: string, lang: string, field: FieldKey): string | null {
  const param = parseParamKey(field);
  if (param) return paramValue(block, param.index, param.part, lang);

  const spec = SPECS[field];
  if (!spec) return null;

  if (spec.scope === 'meta') {
    const range = metaRange(block, spec.metaKey!, lang);
    if (!range) return null;
    const raw = block.slice(range[0], range[1]);
    return raw.startsWith('<META_VALUE') ? '' : decodeEntities(unwrapCdata(raw)).trim();
  }

  const range = scopeRange(block, spec.scope, lang);
  if (!range) return null;
  return tagText(block.slice(range[0], range[1]), spec.tag) || '';
}

/**
 * Zápis hodnoty do bloku produktu.
 *
 * Když jazyková část chybí (typicky nový jazyk, který ve feedu ještě není),
 * vytvoří se podle části zdrojové — jinak by nový jazyk nešlo naimportovat.
 */
export function setField(block: string, lang: string, field: FieldKey, value: string,
                         sourceLang = 'cz'): string {
  const param = parseParamKey(field);
  if (param) return setParamValue(block, param.index, param.part, lang, value, sourceLang);

  const spec = SPECS[field];
  if (!spec) return block;

  if (spec.scope === 'meta') {
    return setMetaValue(block, spec.metaKey!, lang, value, sourceLang);
  }

  let out = block;
  if (!scopeRange(out, spec.scope, lang)) {
    out = cloneScope(out, spec.scope, sourceLang, lang);
    if (!scopeRange(out, spec.scope, lang)) return block;
  }
  const range = scopeRange(out, spec.scope, lang)!;
  const inner = out.slice(range[0], range[1]);
  const replaced = replaceTag(inner, spec.tag, value, !!spec.cdata);
  return out.slice(0, range[0]) + replaced + out.slice(range[1]);
}

/** Nahradí obsah značky; když značka chybí, přidá ji na konec části. */
function replaceTag(inner: string, tag: string, value: string, cdata: boolean): string {
  const encoded = encodeValue(value, cdata);
  const pair = new RegExp(`(<${tag}(?:\\s[^>]*)?>)([\\s\\S]*?)(</${tag}>)`);
  if (pair.test(inner)) return inner.replace(pair, `$1${encoded}$3`);

  const empty = new RegExp(`<${tag}((?:\\s[^>]*)?)/>`);
  if (empty.test(inner)) return inner.replace(empty, `<${tag}$1>${encoded}</${tag}>`);

  // Odsazení se odhadne z posledního řádku, ať zůstane soubor čitelný
  const indent = (inner.match(/\n(\t+)\S/) ?? [, '\t\t\t\t'])[1];
  return `${inner.replace(/\s*$/, '')}\n${indent}<${tag}>${encoded}</${tag}>\n${indent.slice(0, -1)}`;
}

/** Zkopíruje jazykovou část ze zdrojového jazyka a přepíše u ní `language`. */
function cloneScope(block: string, scope: 'description' | 'seo', from: string, to: string): string {
  const tag = scope === 'description' ? 'DESCRIPTION' : 'SEO';
  const source = new RegExp(`(\\s*)<${tag} language="${from}"[^>]*>[\\s\\S]*?</${tag}>`).exec(block);
  if (!source) return block;

  // Kopíruje se jen kostra. Nechat v ní zdrojové texty by znamenalo naimportovat
  // do nového jazyka češtinu — tedy přesně to, co se tenhle nástroj snaží vymýtit.
  let copy = source[0].replace(`language="${from}"`, `language="${to}"`);
  for (const name of ['TITLE', 'SHORT_DESCRIPTION', 'LONG_DESCRIPTION', 'URL',
    'SEO_TITLE', 'SEO_META_DESCRIPTION', 'SEO_URL', 'SEO_KEYWORDS']) {
    copy = copy.replace(new RegExp(`(<${name}(?:\\s[^>]*)?>)[\\s\\S]*?(</${name}>)`, 'g'), '$1$2');
  }
  const at = source.index + source[0].length;
  return block.slice(0, at) + copy + block.slice(at);
}

function setMetaValue(block: string, metaKey: string, lang: string, value: string, sourceLang: string): string {
  const meta = new RegExp(`<META\\b[^>]*>\\s*<META_KEY>${metaKey}</META_KEY>[\\s\\S]*?</META>`).exec(block);
  if (!meta) return block;
  let inner = meta[0];

  const encoded = encodeValue(value, false);
  const pair = new RegExp(`(<META_VALUE language="${lang}"[^>]*>)([\\s\\S]*?)(</META_VALUE>)`);
  const empty = new RegExp(`<META_VALUE language="${lang}"[^>]*/>`);

  if (pair.test(inner)) {
    inner = inner.replace(pair, `$1${encoded}$3`);
  } else if (empty.test(inner)) {
    inner = inner.replace(empty, `<META_VALUE language="${lang}">${encoded}</META_VALUE>`);
  } else {
    // Jazyk v METAS chybí — přidá se za zdrojový
    const source = new RegExp(
      `(\\s*)(<META_VALUE language="${sourceLang}"[^>]*(?:/>|>[\\s\\S]*?</META_VALUE>))`
    ).exec(inner);
    if (!source) return block;
    const at = source.index + source[0].length;
    inner = inner.slice(0, at)
      + `${source[1]}<META_VALUE language="${lang}">${encoded}</META_VALUE>`
      + inner.slice(at);
  }
  return block.slice(0, meta.index) + inner + block.slice(meta.index + meta[0].length);
}

/* ---------- parametry ---------- */

export function paramKey(index: number, part: 'name' | 'value'): FieldKey {
  return `param:${index}:${part}`;
}

export function parseParamKey(field: FieldKey): { index: number; part: 'name' | 'value' } | null {
  const m = field.match(/^param:(\d+):(name|value)$/);
  return m ? { index: Number(m[1]), part: m[2] as 'name' | 'value' } : null;
}

/** Bloky `<PARAMETER>` přímo pod produktem (ne ty ve variantách). */
export function productParameters(block: string): string[] {
  const wrap = /<PARAMETERS>([\s\S]*?)<\/PARAMETERS>/.exec(block);
  if (!wrap) return [];
  return wrap[1].split('<PARAMETER>').slice(1).map(part => part.split('</PARAMETER>')[0]);
}

function paramValue(block: string, index: number, part: 'name' | 'value', lang: string): string | null {
  const list = productParameters(block);
  const one = list[index];
  if (one === undefined) return null;
  const tag = part === 'name' ? 'NAME' : 'VALUE';
  const m = new RegExp(`<${tag} language="${lang}"[^>]*>([\\s\\S]*?)</${tag}>`).exec(one);
  if (m) return decodeEntities(unwrapCdata(m[1])).trim();
  return new RegExp(`<${tag} language="${lang}"[^>]*/>`).test(one) ? '' : null;
}

function setParamValue(block: string, index: number, part: 'name' | 'value', lang: string,
                       value: string, sourceLang: string): string {
  const wrap = /<PARAMETERS>([\s\S]*?)<\/PARAMETERS>/.exec(block);
  if (!wrap) return block;
  const pieces = wrap[1].split('<PARAMETER>');
  if (pieces.length <= index + 1) return block;

  const tag = part === 'name' ? 'NAME' : 'VALUE';
  const encoded = encodeValue(value, false);
  const target = pieces[index + 1];
  const body = target.split('</PARAMETER>')[0];
  let next = body;

  const pair = new RegExp(`(<${tag} language="${lang}"[^>]*>)([\\s\\S]*?)(</${tag}>)`);
  const empty = new RegExp(`<${tag} language="${lang}"[^>]*/>`);
  if (pair.test(next)) {
    next = next.replace(pair, `$1${encoded}$3`);
  } else if (empty.test(next)) {
    next = next.replace(empty, `<${tag} language="${lang}">${encoded}</${tag}>`);
  } else {
    const source = new RegExp(
      `(\\s*)(<${tag} language="${sourceLang}"[^>]*(?:/>|>[\\s\\S]*?</${tag}>))`
    ).exec(next);
    if (!source) return block;
    const at = source.index + source[0].length;
    next = next.slice(0, at) + `${source[1]}<${tag} language="${lang}">${encoded}</${tag}>` + next.slice(at);
  }

  pieces[index + 1] = next + target.slice(body.length);
  const rebuilt = pieces.join('<PARAMETER>');
  return block.slice(0, wrap.index) + `<PARAMETERS>${rebuilt}</PARAMETERS>`
    + block.slice(wrap.index + wrap[0].length);
}

/* ---------- rozdělení feedu na produkty ---------- */

export interface RawProduct {
  code: string;
  /** Obsah mezi `<PRODUCT>` a `</PRODUCT>` */
  block: string;
}

export function splitProducts(xml: string): RawProduct[] {
  const out: RawProduct[] = [];
  const parts = xml.split('<PRODUCT>');
  for (let i = 1; i < parts.length; i++) {
    const block = parts[i].split('</PRODUCT>')[0];
    const code = tagText(block, 'CODE');
    if (code) out.push({ code, block });
  }
  return out;
}

/** Jazyky, které feed obsahuje — podle atributů `language`. */
export function feedLanguages(xml: string): string[] {
  const found = new Set<string>();
  const re = /<DESCRIPTION language="([a-z]{2,5})"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) found.add(m[1]);
  return [...found];
}

/** Hlavička souboru (deklarace a `<PRODUCTS …>`), aby export vypadal stejně. */
export function feedHeader(xml: string): { head: string; tail: string } {
  const at = xml.indexOf('<PRODUCT>');
  const head = at === -1 ? '<?xml version="1.0" encoding="UTF-8"?>\n<PRODUCTS version="2.0">\n' : xml.slice(0, at);
  return { head, tail: '</PRODUCTS>\n' };
}
