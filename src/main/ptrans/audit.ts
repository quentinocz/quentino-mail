import { getDb } from '../db';
import { getPtransSettings, targetLangs, productFields } from './store';
import { tagText, getField } from './xml';
import { plain, detectLanguage } from './detect';
import { parameterMap } from './seo';
import { attributesFor } from './google';
import { colorFor, shadeFromTitle } from './colors';
import { tidyHtml, needsTidy } from './html';

/**
 * Audit feedu — pro každý produkt a jazyk.
 *
 * Feed je jediné, co o produktu ví vyhledávač i porovnávač. Chyba v něm se
 * nikde neprojeví jako chyba: produkt se prostě neukáže, nebo se ukáže hůř,
 * a nikdo se to nedozví. Audit je proto seznam konkrétních vad s tím, co s
 * nimi udělat — ne známka, kterou by šlo odbýt.
 *
 * Závažnost má tři stupně a znamenají různé věci:
 *   - **`error`** — Google nebo vyhledávač nabídku kvůli tomu zahodí nebo
 *     výrazně potlačí (chybí titulek, popis, obrázek, barva u oblečení),
 *   - **`warn`** — projde to, ale připravuje se o dohledatelnost (krátký
 *     popis, titulek mimo doporučenou délku, chybějící parametr),
 *   - **`info`** — kosmetika a doporučení.
 *
 * Skóre je jen převod téhož do čísla, aby šlo seřadit, co spravit nejdřív.
 */

export type Severity = 'error' | 'warn' | 'info';

export interface Issue {
  /** Strojový klíč — podle něj se pozná, co umí opravit tlačítko */
  key: string;
  severity: Severity;
  message: string;
  /** Pole, kterého se to týká; prázdné = celý produkt */
  field?: string;
  /** Aplikace to umí spravit sama */
  fixable?: boolean;
}

export interface ProductAudit {
  code: string;
  title: string;
  lang: string;
  score: number;
  issues: Issue[];
}

const WEIGHT: Record<Severity, number> = { error: 18, warn: 7, info: 2 };

/** Doporučené délky. Vycházejí z toho, co se v inzerátu a ve výsledku vejde. */
const LIMITS = {
  titleMin: 20,
  titleMax: 150,
  /** Kolik z titulku Google v inzerátu zobrazí */
  googleTitleIdeal: 70,
  /** Nad tímhle se do viditelné části nevejde ani polovina podstatného */
  googleTitleNoisy: 85,
  seoTitleMin: 25,
  seoTitleMax: 60,
  seoDescMin: 70,
  seoDescMax: 158,
  googleDescMin: 200,
  descriptionMin: 300
};

function score(issues: Issue[]): number {
  const lost = issues.reduce((sum, issue) => sum + WEIGHT[issue.severity], 0);
  return Math.max(0, 100 - lost);
}

/**
 * Zkontroluje jeden produkt v jednom jazyce.
 *
 * Zdrojový jazyk se kontroluje taky — chyba v češtině se totiž překladem
 * rozšíří do všech ostatních trhů.
 */
export function auditProduct(code: string, lang: string): ProductAudit | null {
  const d = getDb();
  const s = getPtransSettings();
  const product = d.prepare(
    'SELECT code, title, category, categories, manufacturer, raw_xml, image, active FROM ptrans_products WHERE code = ?'
  ).get(code) as any;
  if (!product) return null;

  const rows = productFields(code, [lang]);
  /**
   * Hodnota pole tak, jak by ji viděl Google.
   *
   * Databáze polí obsahuje jen to, co se sleduje podle nastavení — když je
   * třeba Google titulek v nastavení vypnutý, řádek pro něj neexistuje. To ale
   * neznamená, že ve feedu není. Proto se sahá i do původního XML; jinak by
   * audit hlásil stovky chybějících titulků, které tam ve skutečnosti jsou.
   */
  const value = (field: string) => {
    const row = rows.find(f => f.field === field);
    const known = (row?.translated || row?.value || '').trim();
    if (known) return known;
    return (getField(product.raw_xml, lang, field) ?? '').trim();
  };

  const issues: Issue[] = [];
  const add = (key: string, severity: Severity, message: string, field?: string, fixable = false) =>
    issues.push({ key, severity, message, field, fixable });

  /* ---------- název a popis ---------- */

  const title = value('title');
  if (!title) add('title.missing', 'error', 'Chybí název produktu.', 'title');
  else {
    if (title.length < LIMITS.titleMin) {
      add('title.short', 'warn', `Název má jen ${title.length} znaků — je moc obecný na to, aby ho někdo našel.`, 'title');
    }
    if (title === title.toUpperCase() && title.length > 8) {
      add('title.caps', 'warn', 'Název je celý velkými písmeny — Google to bere jako křik.', 'title');
    }
    if (lang !== s.sourceLang && detectLanguage(title, [s.sourceLang, lang]) === s.sourceLang) {
      add('title.untranslated', 'error', 'Název je pořád ve zdrojovém jazyce.', 'title', true);
    }
  }

  /*
   * Balast v HTML popisu.
   *
   * Popis vložený kopírováním z jiného okna s sebou vleče obal cizí stránky.
   * Není to kosmetika: e-shop takový kód nemusí zobrazit vůbec (přesně tohle
   * se stalo u PSSK120SZ3), a při každém překladu se za ten balast platí.
   * Opravit to jde bez modelu — text se nezmění ani o písmeno.
   */
  for (const field of ['long', 'short']) {
    const raw = value(field);
    if (!needsTidy(raw)) continue;
    // Nepřeložený cizojazyčný popis se neuklízí — překlad ho stejně celý
    // přepíše, a čistý bude, protože zdroj se uklidí taky
    const row = rows.find(f => f.field === field);
    if (lang !== s.sourceLang && !row?.translated && !needsTidy(row?.source ?? '')) continue;
    const junk = raw.length - tidyHtml(raw).length;
    const foreign = /<article\b|data-turn-id|data-testid|conversation-turn/i.test(raw);
    add(`${field}.junk`, foreign ? 'error' : 'warn',
      foreign
        ? `${field === 'long' ? 'Popis' : 'Krátký popis'} obsahuje obal cizí stránky`
          + ` (${junk.toLocaleString('cs-CZ')} znaků navíc) — e-shop ho nemusí vůbec zobrazit.`
        : `${field === 'long' ? 'Popis' : 'Krátký popis'} obsahuje ${junk.toLocaleString('cs-CZ')}`
          + ' znaků zbytečného kódu.',
      field, true);
  }

  const long = plain(value('long'));
  const short = plain(value('short'));
  if (!long && !short) add('desc.missing', 'error', 'Produkt nemá žádný popis.', 'long');
  else if ((long || short).length < LIMITS.descriptionMin) {
    add('desc.thin', 'warn',
      `Popis má ${(long || short).length} znaků. Pod ${LIMITS.descriptionMin} se stránka hodnotí jako obsahově slabá.`, 'long');
  }

  /* ---------- SEO ---------- */

  const seoTitle = value('seo_title');
  if (!seoTitle) add('seo_title.missing', 'error', 'Chybí SEO titulek stránky.', 'seo_title', true);
  else {
    if (seoTitle.length > LIMITS.seoTitleMax) {
      add('seo_title.long', 'warn',
        `SEO titulek má ${seoTitle.length} znaků — ve výsledcích se ořízne kolem ${LIMITS.seoTitleMax}.`, 'seo_title', true);
    } else if (seoTitle.length < LIMITS.seoTitleMin) {
      add('seo_title.short', 'info', `SEO titulek má jen ${seoTitle.length} znaků, je tam místo navíc.`, 'seo_title', true);
    }
    const head = title.split(' ').slice(0, 2).join(' ').toLowerCase();
    if (head && !seoTitle.toLowerCase().includes(head.split(' ')[0])) {
      add('seo_title.offtopic', 'warn', 'SEO titulek neobsahuje hlavní slovo z názvu produktu.', 'seo_title', true);
    }
  }

  const seoDesc = value('seo_desc');
  if (!seoDesc) add('seo_desc.missing', 'error', 'Chybí meta popis stránky.', 'seo_desc', true);
  else if (seoDesc.length > LIMITS.seoDescMax) {
    add('seo_desc.long', 'warn',
      `Meta popis má ${seoDesc.length} znaků — zobrazí se jen asi ${LIMITS.seoDescMax}.`, 'seo_desc', true);
  } else if (seoDesc.length < LIMITS.seoDescMin) {
    add('seo_desc.short', 'warn',
      `Meta popis má ${seoDesc.length} znaků, nevyužívá dostupné místo.`, 'seo_desc', true);
  }

  const seoUrl = value('seo_url');
  if (!seoUrl) add('seo_url.missing', 'error', 'Chybí SEO adresa.', 'seo_url', true);
  else if (/[^a-z0-9-]/.test(seoUrl)) {
    add('seo_url.chars', 'warn', 'SEO adresa obsahuje znaky mimo malá písmena, číslice a pomlčky.', 'seo_url', true);
  }

  /* ---------- Google Nákupy ---------- */

  /*
   * Titulek pro Google se kontroluje podle formátu z auditu feedu:
   *   Typ produktu + Barva + Vzor/Detail + Značka [+ Velikost]
   * Nejde jen o délku — pořadí rozhoduje o tom, jestli se nabídka spáruje
   * s tím, co lidé opravdu píší do vyhledávače.
   */
  const googleTitle = value('google_title');
  if (!googleTitle) add('google_title.missing', 'error', 'Chybí titulek pro Google Nákupy.', 'google_title', true);
  else {
    if (googleTitle.length > LIMITS.titleMax) {
      add('google_title.long', 'error',
        `Titulek pro Google má ${googleTitle.length} znaků, limit je ${LIMITS.titleMax}.`, 'google_title', true);
    } else if (googleTitle.length > LIMITS.googleTitleNoisy) {
      add('google_title.trim', 'warn',
        `Titulek pro Google má ${googleTitle.length} znaků — Google zobrazí jen`
        + ` prvních ${LIMITS.googleTitleIdeal}, zbytek zákazník neuvidí.`,
        'google_title', true);
    }
    if (/\b(sleva|akce|výprodej|nejlepší|zdarma|doprava)\b/i.test(googleTitle)) {
      add('google_title.promo', 'error', 'Titulek pro Google obsahuje reklamní text — Google to zamítá.', 'google_title', true);
    }

    // Barva na prvním místě je nejčastější vada: hledá se „vázací motýlek",
    // ne „tmavě modrý". Typ výrobku proto patří dopředu.
    // Poznat se musí obojí — obecná barva („Žlutý…") i odstín („Hořčicově…"),
    // protože v titulku je správně odstín, ale ne na prvním místě
    const first = plain(googleTitle).toLowerCase().split(/\s+/).slice(0, 2).join(' ');
    const shade = shadeFromTitle(title);
    const colour = shade || colorFor(code, lang) || parameterMap(code, s.sourceLang).barva || '';
    if (colour && first.startsWith(plain(colour).toLowerCase().split(/\s+/)[0])) {
      add('google_title.colorfirst', 'warn',
        'Titulek pro Google začíná barvou. Na prvním místě má být typ produktu — tak ho lidé hledají.',
        'google_title', true);
    }

    const brand = (product.manufacturer || '').trim();
    if (brand && !googleTitle.toLowerCase().includes(brand.toLowerCase())) {
      add('google_title.nobrand', 'warn',
        `Titulek pro Google neobsahuje značku „${brand}" — patří na jeho konec.`, 'google_title', true);
    }

    // „pro tátu a syna" funguje na webu, ale nikdo tak nehledá
    if (/\b(pro tátu a syna|pro každou příležitost|na míru vašemu|elegantní doplněk)\b/i.test(googleTitle)) {
      add('google_title.marketing', 'warn',
        'Titulek pro Google obsahuje marketingový obrat, kterým nikdo nehledá.', 'google_title', true);
    }
  }

  const googleDesc = value('google_desc');
  if (!googleDesc) add('google_desc.missing', 'error', 'Chybí popis pro Google Nákupy.', 'google_desc', true);
  else {
    if (googleDesc.length < LIMITS.googleDescMin) {
      add('google_desc.short', 'warn',
        `Popis pro Google má ${googleDesc.length} znaků — pod ${LIMITS.googleDescMin} je málo na spárování s dotazem.`,
        'google_desc', true);
    }
    if (/<[a-z][^>]*>/i.test(googleDesc)) {
      add('google_desc.html', 'error', 'Popis pro Google obsahuje HTML značky.', 'google_desc', true);
    }
    if (/\b(sleva|akce|výprodej|doprava zdarma|klikněte)\b/i.test(googleDesc)) {
      add('google_desc.promo', 'error', 'Popis pro Google obsahuje reklamní text nebo výzvu ke kliknutí.', 'google_desc', true);
    }
  }

  const attrs = attributesFor(code, lang);
  if (!value('google_color')) {
    const derived = colorFor(code, lang);
    add('google_color.missing', derived ? 'warn' : 'error',
      derived
        ? `Chybí barva pro Google. Z parametru vychází „${derived}".`
        : 'Chybí barva pro Google a nedá se odvodit z parametru — doplň převod odstínu.',
      'google_color', !!derived);
  }
  if (!value('google_gender')) {
    add('google_gender.missing', 'warn', `Chybí pohlaví pro Google (vychází „${attrs.google_gender}").`,
      'google_gender', true);
  }
  if (!value('google_age')) {
    add('google_age.missing', 'warn', `Chybí věková skupina (vychází „${attrs.google_age}").`,
      'google_age', true);
  }
  if (!value('google_condition')) {
    add('google_condition.missing', 'info', 'Chybí stav zboží.', 'google_condition', true);
  }
  if (!value('google_bundle')) {
    add('google_bundle.missing', 'info',
      `Chybí příznak setu (vychází „${attrs.google_bundle}" — ${attrs.bundleReason}).`, 'google_bundle', true);
  }

  /* ---------- to, co je společné všem jazykům ---------- */

  if (lang === s.sourceLang) {
    if (!product.image) add('image.missing', 'error', 'Produkt nemá hlavní obrázek.');
    const ean = tagText(product.raw_xml, 'EAN');
    const identifier = value('google_identifier');
    if (!ean && identifier !== 'no') {
      add('identifier.mismatch', 'warn',
        'Produkt nemá EAN, ale nemá ani nastavené „nemá čárový kód" — Google pak nabídku hůř páruje.',
        'google_identifier', true);
    }
    if (!product.manufacturer) add('brand.missing', 'warn', 'Chybí značka výrobce.');
    const params = parameterMap(code, s.sourceLang);
    if (!params.barva) add('param.color', 'warn', 'Produkt nemá parametr Barva — z čeho pak brát barvu pro Google.');
    if (!params.materiál && !params.material) {
      add('param.material', 'info', 'Produkt nemá parametr Materiál.');
    }
  }

  return { code, title: product.title, lang, score: score(issues), issues };
}

/* ---------- hromadný audit ---------- */

export interface AuditSummary {
  checked: number;
  averageScore: number;
  byLang: { lang: string; average: number; errors: number; warnings: number }[];
  /** Nejčastější vady — od nich se má začít */
  top: { key: string; severity: Severity; message: string; count: number }[];
}

export interface AuditOptions {
  codes?: string[];
  langs?: string[];
  /** Kontrolovat i produkty, které jsou vypnuté nebo archivované */
  includeInactive?: boolean;
}

export function runAudit(options: AuditOptions = {}): AuditSummary {
  const d = getDb();
  const s = getPtransSettings();
  const langs = options.langs?.length ? options.langs : [s.sourceLang, ...targetLangs(s)];

  const codes = options.codes?.length
    ? options.codes
    : (d.prepare(
      `SELECT code FROM ptrans_products${options.includeInactive ? '' : ' WHERE active = 1 AND archived = 0'}`
    ).all() as any[]).map(row => row.code);

  const insert = d.prepare(
    `INSERT INTO ptrans_audit (code, lang, score, issues, checked_at) VALUES (?,?,?,?,?)
     ON CONFLICT(code, lang) DO UPDATE SET score = excluded.score, issues = excluded.issues,
       checked_at = excluded.checked_at`
  );
  const now = new Date().toISOString();

  const totals = new Map<string, { sum: number; n: number; errors: number; warnings: number }>();
  const frequency = new Map<string, { key: string; severity: Severity; message: string; count: number }>();
  let checked = 0;

  const write = d.transaction(() => {
    for (const code of codes) {
      for (const lang of langs) {
        const result = auditProduct(code, lang);
        if (!result) continue;
        insert.run(code, lang, result.score, JSON.stringify(result.issues), now);
        checked++;

        const bucket = totals.get(lang) ?? { sum: 0, n: 0, errors: 0, warnings: 0 };
        bucket.sum += result.score;
        bucket.n++;
        for (const issue of result.issues) {
          if (issue.severity === 'error') bucket.errors++;
          if (issue.severity === 'warn') bucket.warnings++;
          const seen = frequency.get(issue.key);
          if (seen) seen.count++;
          else frequency.set(issue.key,
            { key: issue.key, severity: issue.severity, message: issue.message, count: 1 });
        }
        totals.set(lang, bucket);
      }
    }
  });
  write();

  const byLang = [...totals.entries()].map(([lang, bucket]) => ({
    lang,
    average: bucket.n ? Math.round(bucket.sum / bucket.n) : 0,
    errors: bucket.errors,
    warnings: bucket.warnings
  }));

  return {
    checked,
    averageScore: byLang.length
      ? Math.round(byLang.reduce((sum, row) => sum + row.average, 0) / byLang.length)
      : 0,
    byLang,
    top: [...frequency.values()].sort((a, b) => b.count - a.count).slice(0, 15)
  };
}

/**
 * Souhrn z posledního auditu, bez nového počítání.
 *
 * Nutné proto, aby záložka po otevření nebyla prázdná. Projít znovu tisíc
 * produktů kvůli tomu, aby se ukázala tři čísla, by bylo plýtvání — a hlavně
 * by to zakrylo, že jde o výsledek z minula, ne z teď.
 */
export function storedSummary(): (AuditSummary & { checkedAt: string | null }) | null {
  const rows = getDb().prepare(
    'SELECT lang, score, issues, checked_at AS checkedAt FROM ptrans_audit'
  ).all() as any[];
  if (rows.length === 0) return null;

  const totals = new Map<string, { sum: number; n: number; errors: number; warnings: number }>();
  const frequency = new Map<string, { key: string; severity: Severity; message: string; count: number }>();
  let checkedAt: string | null = null;

  for (const row of rows) {
    if (!checkedAt || row.checkedAt > checkedAt) checkedAt = row.checkedAt;
    const bucket = totals.get(row.lang) ?? { sum: 0, n: 0, errors: 0, warnings: 0 };
    bucket.sum += row.score;
    bucket.n++;
    for (const issue of JSON.parse(row.issues || '[]') as Issue[]) {
      if (issue.severity === 'error') bucket.errors++;
      if (issue.severity === 'warn') bucket.warnings++;
      const seen = frequency.get(issue.key);
      if (seen) seen.count++;
      else frequency.set(issue.key,
        { key: issue.key, severity: issue.severity, message: issue.message, count: 1 });
    }
    totals.set(row.lang, bucket);
  }

  const byLang = [...totals.entries()].map(([lang, bucket]) => ({
    lang,
    average: bucket.n ? Math.round(bucket.sum / bucket.n) : 0,
    errors: bucket.errors,
    warnings: bucket.warnings
  }));

  return {
    checked: rows.length,
    averageScore: byLang.length
      ? Math.round(byLang.reduce((sum, row) => sum + row.average, 0) / byLang.length)
      : 0,
    byLang,
    top: [...frequency.values()].sort((a, b) => b.count - a.count).slice(0, 15),
    checkedAt
  };
}

/** Uložený výsledek pro jeden produkt — do karty, bez nového počítání. */
export function auditFor(code: string, langs?: string[]): ProductAudit[] {
  const s = getPtransSettings();
  const list = langs?.length ? langs : [s.sourceLang, ...targetLangs(s)];
  const rows = getDb().prepare(
    `SELECT a.code, a.lang, a.score, a.issues, p.title FROM ptrans_audit a
     JOIN ptrans_products p ON p.code = a.code
     WHERE a.code = ? AND a.lang IN (${list.map(() => '?').join(',')})`
  ).all(code, ...list) as any[];

  if (rows.length === 0) {
    // Ještě neproběhl audit — spočítá se rovnou, je to práce na milisekundy
    return list.map(lang => auditProduct(code, lang)).filter(Boolean) as ProductAudit[];
  }
  return rows.map(row => ({
    code: row.code,
    title: row.title,
    lang: row.lang,
    score: row.score,
    issues: JSON.parse(row.issues || '[]')
  }));
}

/** Produkty seřazené od nejhoršího — s čím začít. */
export function worstProducts(lang: string, limit = 60): { code: string; title: string; score: number; errors: number }[] {
  const rows = getDb().prepare(
    `SELECT a.code, a.score, a.issues, p.title FROM ptrans_audit a
     JOIN ptrans_products p ON p.code = a.code
     WHERE a.lang = ? ORDER BY a.score ASC, p.title LIMIT ?`
  ).all(lang, limit) as any[];

  return rows.map(row => {
    const issues: Issue[] = JSON.parse(row.issues || '[]');
    return {
      code: row.code,
      title: row.title,
      score: row.score,
      errors: issues.filter(issue => issue.severity === 'error').length
    };
  });
}
