import { getDb } from '../../db';
import { productParameters } from '../xml';

/**
 * Číselník parametrů e-shopu.
 *
 * Parametry se u nového produktu nesmějí psát rukou. „Barva" vedle „barva"
 * nebo „Šířka 7 cm" vedle „Šíře 7cm" jsou pro e-shop dva různé parametry:
 * rozpadne se filtrování v kategorii a v Google Nákupech to vypadá jako dva
 * nesouvisející produkty.
 *
 * Číselník se proto **neudržuje ručně** — skládá se z toho, co ve feedu
 * doopravdy je, včetně už hotových překladů. U nového produktu se pak
 * slovenština a angličtina neberou z modelu, ale z e-shopu, takže se parametr
 * jmenuje všude stejně jako u sousedních produktů.
 */

export interface ParamEntry {
  /** Normalizovaný český tvar — klíč pro hledání a slučování */
  key: string;
  /** Ke kterému parametru hodnota patří; u názvu prázdné */
  nameKey: string;
  /** Znění po jazycích */
  langs: Record<string, string>;
  hits: number;
}

/**
 * Klíč pro slučování.
 *
 * Slučuje se bez diakritiky, bez velikosti písmen a bez mezer okolo — přesně
 * ty rozdíly, kvůli kterým vzniká „Barva" a „barva" jako dvě položky. Mezery
 * uvnitř se **nechávají**: „7 cm" a „7cm" jsou dvě různé hodnoty a sloučit je
 * by znamenalo rozhodnout za člověka, která je ta správná.
 */
export function paramKeyOf(text: string): string {
  return text.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Přečte parametry z jednoho bloku produktu: název i hodnota po jazycích. */
export function readParams(block: string): { name: Record<string, string>; value: Record<string, string> }[] {
  const out: { name: Record<string, string>; value: Record<string, string> }[] = [];
  for (const part of productParameters(block)) {
    const name: Record<string, string> = {};
    const value: Record<string, string> = {};
    for (const [tag, target] of [['NAME', name], ['VALUE', value]] as const) {
      const re = new RegExp(`<${tag} language="([^"]+)"[^>]*>([\\s\\S]*?)</${tag}>`, 'g');
      let m: RegExpExecArray | null;
      while ((m = re.exec(part))) {
        const text = m[2].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
          .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
          .replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&').trim();
        if (text) target[m[1]] = text;
      }
    }
    if (Object.keys(name).length) out.push({ name, value });
  }
  return out;
}

/**
 * Projde katalog a přepíše číselník.
 *
 * Bere se **celý feed pokaždé znovu**, ne přírůstek: parametr, který z e-shopu
 * zmizel, se má z nabídky ztratit taky. Přírůstkové učení by nabídku donekonečna
 * nafukovalo o hodnoty, které už nikde nejsou.
 */
export function learnParams(sourceLang = 'cz'): { names: number; values: number } {
  const d = getDb();
  const rows = d.prepare('SELECT raw_xml FROM ptrans_products').all() as { raw_xml: string }[];

  type Acc = { langs: Record<string, string>; hits: number };
  const names = new Map<string, Acc>();
  const values = new Map<string, Map<string, Acc>>();

  for (const row of rows) {
    for (const one of readParams(row.raw_xml)) {
      const nameCz = one.name[sourceLang];
      if (!nameCz) continue;
      const nameKey = paramKeyOf(nameCz);
      const acc = names.get(nameKey) ?? { langs: {}, hits: 0 };
      // Poslední vyhrává schválně: novější produkty mívají překlad hotový,
      // starší ho často nemají vůbec
      Object.assign(acc.langs, one.name);
      acc.hits++;
      names.set(nameKey, acc);

      const valueCz = one.value[sourceLang];
      if (!valueCz) continue;
      const bucket = values.get(nameKey) ?? new Map<string, Acc>();
      const vkey = paramKeyOf(valueCz);
      const vacc = bucket.get(vkey) ?? { langs: {}, hits: 0 };
      Object.assign(vacc.langs, one.value);
      vacc.hits++;
      bucket.set(vkey, vacc);
      values.set(nameKey, bucket);
    }
  }

  const now = new Date().toISOString();
  const write = d.transaction(() => {
    d.prepare('DELETE FROM ptrans_params').run();
    const insert = d.prepare(`INSERT INTO ptrans_params (kind, key, name_key, langs, hits, updated_at)
                              VALUES (?, ?, ?, ?, ?, ?)`);
    for (const [key, acc] of names) {
      insert.run('name', key, '', JSON.stringify(acc.langs), acc.hits, now);
    }
    for (const [nameKey, bucket] of values) {
      for (const [key, acc] of bucket) {
        insert.run('value', key, nameKey, JSON.stringify(acc.langs), acc.hits, now);
      }
    }
  });
  write();

  let valueCount = 0;
  for (const bucket of values.values()) valueCount += bucket.size;
  return { names: names.size, values: valueCount };
}

function toEntry(row: any): ParamEntry {
  let langs: Record<string, string> = {};
  try { langs = JSON.parse(row.langs || '{}'); } catch { langs = {}; }
  return { key: row.key, nameKey: row.name_key ?? '', langs, hits: row.hits ?? 0 };
}

/** Názvy parametrů, nejpoužívanější první. */
export function paramNames(): ParamEntry[] {
  return (getDb().prepare(
    `SELECT * FROM ptrans_params WHERE kind = 'name' ORDER BY hits DESC`
  ).all() as any[]).map(toEntry);
}

/** Hodnoty jednoho parametru. Prázdný název = hodnoty všech parametrů. */
export function paramValues(name: string): ParamEntry[] {
  const key = paramKeyOf(name);
  const sql = key
    ? `SELECT * FROM ptrans_params WHERE kind = 'value' AND name_key = ? ORDER BY hits DESC`
    : `SELECT * FROM ptrans_params WHERE kind = 'value' ORDER BY hits DESC LIMIT 400`;
  const rows = (key ? getDb().prepare(sql).all(key) : getDb().prepare(sql).all()) as any[];
  return rows.map(toEntry);
}

export interface ParamLookup {
  /** Znění názvu po jazycích; prázdné, když parametr v e-shopu ještě není */
  name: Record<string, string>;
  value: Record<string, string>;
  /** Je název v e-shopu už zavedený? */
  knownName: boolean;
  knownValue: boolean;
}

/**
 * Dohledá překlady parametru v číselníku.
 *
 * Tohle je celý smysl číselníku: u nového produktu se slovenština a angličtina
 * neberou z modelu, ale z e-shopu — parametr se tak jmenuje přesně stejně jako
 * u sousedních produktů a filtrování v kategorii se nerozpadne.
 */
export function lookupParam(name: string, value: string): ParamLookup {
  const d = getDb();
  const nameKey = paramKeyOf(name);
  const nameRow = nameKey
    ? d.prepare(`SELECT * FROM ptrans_params WHERE kind = 'name' AND key = ?`).get(nameKey) as any
    : undefined;
  const valueRow = nameKey && value.trim()
    ? d.prepare(`SELECT * FROM ptrans_params WHERE kind = 'value' AND name_key = ? AND key = ?`)
      .get(nameKey, paramKeyOf(value)) as any
    : undefined;
  return {
    name: nameRow ? toEntry(nameRow).langs : {},
    value: valueRow ? toEntry(valueRow).langs : {},
    knownName: !!nameRow,
    knownValue: !!valueRow
  };
}

/**
 * Doplní parametrům rozdělaného produktu znění ve všech jazycích.
 *
 * Co číselník nezná, zůstane prázdné — dopřekládá se s texty. Vymyslet si
 * překlad parametru by bylo horší než ho nemít: ve filtru by vznikla druhá
 * položka s jiným zněním a zákazník by u ní našel jediný produkt.
 */
export function resolveParams(params: { name: string; value: string }[], langs: string[]):
  Record<string, { name: string; value: string }[]> {
  const out: Record<string, { name: string; value: string }[]> = {};
  for (const lang of langs) out[lang] = [];
  for (const one of params) {
    const found = lookupParam(one.name, one.value);
    for (const lang of langs) {
      out[lang].push({ name: found.name[lang] ?? '', value: found.value[lang] ?? '' });
    }
  }
  return out;
}

export const __test = { paramKeyOf, readParams };
