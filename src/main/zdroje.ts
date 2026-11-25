import { getDb, getSetting, setSetting } from './db';
import { encrypt, decrypt } from './secure';
import { webStorage } from './webtexts';
import * as ga4 from './ga4';
import { ordersSince } from './orderfeed';
import { getAdsConfig } from './ads/store';
import { gaql, googleSecrets } from './ads/google';
import { ZDROJE_SQL, TABULKA_ZDROJU, zdrojeSkript } from './zdrojeskript';
import type {
  ZdrojKanal, ZdrojObjednavky, ZdrojStrucne, ZdrojRadek, ZdrojePrehled, ZdrojeStav, ZdrojeNastaveni
} from '../shared/types';

/**
 * Zdroj objednávek — odkud přišel zákazník, který nakoupil.
 *
 * Patrik (25. 11.): „detekce a párování objednávky se zdrojem — organic,
 * google, facebook, případně přes proklik i konkrétní kampaň… v reklamě
 * seznam všech objednávek, u balení a u e-mailu zmínka".
 *
 * Upgates zdroj u objednávky nevede (ověřeno v jeho API), takže se skládá
 * ze dvou měření a páruje číslem objednávky:
 *
 *  1. **Google Analytics** (přes Sequel) — u každého nákupu zná zdroj,
 *     médium, kampaň, sestavu a klíčové slovo z Google Ads, vstupní stránku
 *     a odkud zákazník přišel poprvé. Funguje hned i zpětně, ale jen pro
 *     web, na který je napojené (.cz).
 *  2. **Vlastní měřicí skript** na e-shopu (zdrojeskript.ts) — zapíše
 *     přímo proklik (gclid, fbclid, sznclid, UTM, odkazující web) na všech
 *     trzích; podle `gclid` se v Google Ads dohledá přesná kampaň.
 *
 * Oboje se řídí souhlasem s cookies — u zákazníka, který měření odmítl,
 * zdroj chybí a okno to říká, místo aby hádalo.
 */

/* ------------------------------------------------------------ úložiště */

let pripraveno = false;
function db() {
  const d = getDb();
  if (!pripraveno) {
    d.exec(`CREATE TABLE IF NOT EXISTS order_sources (
      kod TEXT NOT NULL,
      trh TEXT NOT NULL,
      ga4 TEXT NOT NULL DEFAULT '',
      mereni TEXT NOT NULL DEFAULT '',
      ads TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (kod, trh)
    )`);
    pripraveno = true;
  }
  return d;
}

/** Číslo objednávky bez nul na začátku a bez mřížky — tak se páruje. */
export function klicObjednavky(code: string): string {
  return String(code ?? '').trim().replace(/^#/, '').replace(/^0+(?=\d)/, '');
}

/** Trh z adresy webu, ze kterého přišel záznam. */
export function trhZWebu(web: string): string {
  const h = String(web || '').toLowerCase();
  if (/\.sk$/.test(h)) return 'sk';
  if (/wearquentino|\.com$/.test(h)) return 'en';
  return 'cz';
}

function zapis(kod: string, trh: string, co: 'ga4' | 'mereni' | 'ads', hodnota: unknown): void {
  const k = klicObjednavky(kod);
  if (!k) return;
  db().prepare(`INSERT INTO order_sources (kod, trh, ${co}, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(kod, trh) DO UPDATE SET ${co} = excluded.${co}, updated_at = excluded.updated_at`)
    .run(k, trh, JSON.stringify(hodnota), new Date().toISOString());
}

interface Zaznam { ga4: ga4.Ga4Transakce | null; mereni: ZaznamMereni | null; ads: AdsKlik | null }

function cti(json: string): any {
  if (!json) return null;
  try { return JSON.parse(json); } catch { return null; }
}

function zaznamy(): Map<string, Zaznam> {
  const out = new Map<string, Zaznam>();
  for (const r of db().prepare('SELECT * FROM order_sources').all() as any[]) {
    out.set(`${r.kod}|${r.trh}`, { ga4: cti(r.ga4), mereni: cti(r.mereni), ads: cti(r.ads) });
  }
  return out;
}

/* ------------------------------------------------------------- třídění */

export interface Dotek {
  zdroj?: string; medium?: string; kampan?: string; klic?: string; obsah?: string;
  referrer?: string; clid?: string; clidHodnota?: string; vstup?: string; kdy?: string;
}

export interface ZaznamMereni {
  web: string;
  kdy: string;
  prvni: Dotek | null;
  posledni: Dotek | null;
  dotyky: Dotek[];
  zarizeni: string;
}

export interface AdsKlik { kampan: string; sestava: string; klic: string; nenalezeno?: boolean }

const NAZVY: Record<ZdrojKanal, string> = {
  google_ads: 'Google Ads',
  google: 'Google (organicky)',
  sklik: 'Sklik',
  seznam: 'Seznam (organicky)',
  meta_ads: 'Facebook / Instagram reklama',
  meta: 'Facebook / Instagram',
  srovnavac: 'Srovnávač',
  email: 'E-mail / newsletter',
  odkaz: 'Odkaz z jiného webu',
  primo: 'Přímo',
  jine: 'Jiné'
};

export const NAZVY_KANALU = NAZVY;

const velke = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

/**
 * Do kanálu podle zdroje, média, prokliku a odkazujícího webu.
 *
 * Pořadí je schválně: placený proklik vyhrává (gclid je jistota, „google"
 * v referreru ne), pak srovnávače a e-mail (mají vlastní UTM), teprve
 * potom vyhledávače a sítě bez placení, přímý vstup a odkaz.
 */
export function zarad(d: { zdroj?: string; medium?: string; kampan?: string; referrer?: string; clid?: string; kanalGa4?: string }): ZdrojStrucne {
  const s = String(d.zdroj ?? '').toLowerCase().trim();
  const m = String(d.medium ?? '').toLowerCase().trim();
  const r = String(d.referrer ?? '').toLowerCase().trim();
  const c = String(d.clid ?? '').toLowerCase();
  const g = String(d.kanalGa4 ?? '').toLowerCase();
  const kampan = String(d.kampan ?? '').trim();
  const placene = /^(cpc|ppc|cpm|cpv|paid|display|ads?|banner|retargeting|remarketing|social_paid|paid_?social|paidsocial|paid_?search)$/.test(m)
    || /paid|cpc|ppc/.test(m);
  const vysledek = (kanal: ZdrojKanal, nazev = NAZVY[kanal]): ZdrojStrucne => ({ kanal, nazev, kampan });
  const sit = (t: string) => /facebook|^fb$|instagram|^ig$|^meta$|threads|messenger/.test(t);

  if (['gclid', 'gbraid', 'wbraid'].includes(c) || (/google|adwords/.test(s) && placene)
    || ((g === 'paid search' || g === 'cross-network' || g === 'paid shopping' || g === 'paid video') && (!s || /google|youtube/.test(s)))) {
    return vysledek('google_ads');
  }
  if (c === 'sznclid' || /sklik/.test(s) || (/seznam|szn|firmy\.cz/.test(s) && placene)
    || (g === 'paid search' && /seznam|sklik/.test(s))) {
    return vysledek('sklik');
  }
  if ((sit(s) && placene) || (g === 'paid social' && (sit(s) || sit(r) || !s))) return vysledek('meta_ads');
  const srovnavac = /heureka|zbozi|srovname|pricemania|glami|biano|favi|arukereso|najnakup/.exec(`${s} ${r}`);
  if (srovnavac) return vysledek('srovnavac', velke(srovnavac[0] === 'zbozi' ? 'Zboží.cz' : srovnavac[0]));
  if (/e-?mail|newsletter/.test(m) || /ecomail|mailchimp|smartemailing|mailkit|newsletter|klaviyo|brevo/.test(s) || g === 'email') {
    return vysledek('email');
  }
  const hledac = `${s} ${r}`;
  if (m === 'organic' || g === 'organic search' || g === 'organic shopping'
    || /(^|\.)google\.|search\.seznam|^seznam|bing\.|duckduckgo|yahoo|ecosia|yandex|search\.|startpage/.test(r)) {
    if (/google/.test(hledac)) return vysledek('google', g === 'organic shopping' ? 'Google Nákupy (zdarma)' : NAZVY.google);
    if (/seznam|szn/.test(hledac)) return vysledek('seznam');
    const kdo = /bing|duckduckgo|yahoo|ecosia|yandex|startpage/.exec(hledac);
    return vysledek('jine', `${kdo ? velke(kdo[0]) : velke(s || r)} (organicky)`);
  }
  if (sit(s) || sit(r) || /facebook\.com|instagram\.com|fb\.me|l\.facebook|lm\.facebook|threads\.net/.test(r) || c === 'fbclid'
    || g === 'organic social') {
    return vysledek('meta');
  }
  if (c === 'msclkid') return vysledek('jine', 'Microsoft Ads');
  if (c === 'ttclid' || /tiktok/.test(`${s} ${r}`)) return vysledek('jine', 'TikTok');
  if (s === '(direct)' || g === 'direct' || (!s && !r && !m)) return vysledek('primo');
  if (r || m === 'referral' || g === 'referral') return vysledek('odkaz', `Odkaz: ${r || s}`);
  return vysledek('jine', [s, m].filter(Boolean).join(' / ') || NAZVY.jine);
}

const ZARIZENI: Record<string, string> = { mobile: 'mobil', mobil: 'mobil', desktop: 'počítač', pocitac: 'počítač', tablet: 'tablet' };

export function zdrojZMereni(z: ZaznamMereni, ads: AdsKlik | null): ZdrojObjednavky | null {
  const dotyky = Array.isArray(z.dotyky) ? z.dotyky : [];
  const posledni = z.posledni ?? dotyky[dotyky.length - 1] ?? null;
  const zaklad = posledni ?? z.prvni;
  if (!zaklad) return null;
  const hlavni = zarad({ zdroj: zaklad.zdroj, medium: zaklad.medium, kampan: zaklad.kampan, referrer: zaklad.referrer, clid: zaklad.clid });
  const detail: string[] = [];
  const vysledek: ZdrojObjednavky = { ...hlavni, detail, prvni: null, dotyku: dotyky.length, odkud: 'mereni' };
  if (ads && !ads.nenalezeno) {
    vysledek.kampan = ads.kampan || vysledek.kampan;
    if (ads.sestava) detail.push(`sestava: ${ads.sestava}`);
    if (ads.klic) detail.push(`klíčové slovo: ${ads.klic}`);
  }
  if (zaklad.klic && !ads?.klic) detail.push(`hledáno: ${zaklad.klic}`);
  if (zaklad.obsah) detail.push(`reklama: ${zaklad.obsah}`);
  if (zaklad.referrer && hlavni.kanal !== 'odkaz') detail.push(`z webu ${zaklad.referrer}`);
  if (zaklad.vstup) detail.push(`vstup: ${zaklad.vstup}`);
  if (z.zarizeni) detail.push(ZARIZENI[z.zarizeni] ?? z.zarizeni);
  if (z.prvni && (posledni || z.prvni.zdroj !== '(direct)')) {
    const p = zarad({ zdroj: z.prvni.zdroj, medium: z.prvni.medium, kampan: z.prvni.kampan, referrer: z.prvni.referrer, clid: z.prvni.clid });
    if (p.kanal !== hlavni.kanal || (p.kampan && p.kampan !== vysledek.kampan)) vysledek.prvni = p;
  }
  return vysledek;
}

export function zdrojZGa4(t: ga4.Ga4Transakce): ZdrojObjednavky {
  const hlavni = zarad({ zdroj: t.zdroj, medium: t.medium, kampan: t.adsKampan || t.kampan, kanalGa4: t.kanal });
  const detail: string[] = [];
  if (t.adsSestava) detail.push(`sestava: ${t.adsSestava}`);
  if (t.adsKlic) detail.push(`klíčové slovo: ${t.adsKlic}`);
  else if (t.term) detail.push(`hledáno: ${t.term}`);
  if (t.obsah) detail.push(`reklama: ${t.obsah}`);
  if (t.vstup) detail.push(`vstup: ${t.vstup.slice(0, 120)}`);
  if (t.zarizeni) detail.push(ZARIZENI[t.zarizeni.toLowerCase()] ?? t.zarizeni);
  let prvni: ZdrojStrucne | null = null;
  if (t.prvniZdroj || t.prvniMedium) {
    const p = zarad({ zdroj: t.prvniZdroj, medium: t.prvniMedium, kampan: t.prvniKampan });
    if (p.kanal !== hlavni.kanal || (p.kampan && p.kampan !== hlavni.kampan)) prvni = p;
  }
  return { ...hlavni, detail, prvni, dotyku: 0, odkud: 'ga4' };
}

/**
 * Obě měření dohromady. Přednost má vlastní měření (přímo proklik);
 * z Analytics se doplní, co v něm chybí — kampaň, sestava, klíčové slovo.
 */
export function spoj(z: Zaznam | undefined): ZdrojObjednavky | null {
  if (!z) return null;
  const m = z.mereni ? zdrojZMereni(z.mereni, z.ads) : null;
  const g = z.ga4 ? zdrojZGa4(z.ga4) : null;
  if (m && g) {
    const out: ZdrojObjednavky = { ...m, odkud: 'oboje', detail: [...m.detail] };
    if (m.kanal === g.kanal) {
      if (!out.kampan && g.kampan) out.kampan = g.kampan;
      const zarizeni = new Set(Object.values(ZARIZENI));
      for (const d of g.detail) {
        if (zarizeni.has(d) ? out.detail.some(one => zarizeni.has(one)) : out.detail.some(one => one.split(':')[0] === d.split(':')[0])) continue;
        out.detail.push(d);
      }
    }
    if (!out.prvni && g.prvni) out.prvni = g.prvni;
    return out;
  }
  return m ?? g;
}

/* ---------------------------------------------------------- nastavení */

interface Pripojeni { url: string; anon: string; tajny: string; zUloziste: boolean }

function pripojeni(): Pripojeni {
  const ul = webStorage();
  const url = (getSetting('zdrojeUrl', '') || ul.url || '').replace(/\/+$/, '');
  const anon = getSetting('zdrojeAnon', '') ? decrypt(getSetting('zdrojeAnon', '')!) || '' : '';
  const vlastni = getSetting('zdrojeTajny', '') ? decrypt(getSetting('zdrojeTajny', '')!) || '' : '';
  /* Tajný klíč z úložiště médií jen tehdy, když jde o tentýž projekt */
  const zUloziste = !vlastni && !!ul.key && (!getSetting('zdrojeUrl', '') || url === ul.url.replace(/\/+$/, ''));
  return { url, anon, tajny: vlastni || (zUloziste ? ul.key : ''), zUloziste };
}

export function nastaveni(): ZdrojeNastaveni {
  const p = pripojeni();
  return {
    url: p.url, anonKey: p.anon, maTajny: !!p.tajny, tajnyZUloziste: p.zUloziste,
    skript: p.url && p.anon ? zdrojeSkript(p.url, p.anon) : '',
    sql: ZDROJE_SQL
  };
}

export function ulozNastaveni(co: { url?: string; anonKey?: string; tajny?: string }): ZdrojeNastaveni {
  if (co.url !== undefined) setSetting('zdrojeUrl', co.url.trim().replace(/\/+$/, ''));
  if (co.anonKey !== undefined) setSetting('zdrojeAnon', co.anonKey.trim() ? encrypt(co.anonKey.trim()) : '');
  if (co.tajny !== undefined) setSetting('zdrojeTajny', co.tajny.trim() ? encrypt(co.tajny.trim()) : '');
  return nastaveni();
}

function stavZ(klic: string): { kdy: string | null; chyba: string | null; pocet: number; posledni?: string | null } {
  return cti(getSetting(klic, '') || '') ?? { kdy: null, chyba: null, pocet: 0 };
}

export function stav(): ZdrojeStav {
  const g = stavZ('zdrojeGa4Stav');
  const m = stavZ('zdrojeMereniStav');
  const a = stavZ('zdrojeAdsStav');
  const p = pripojeni();
  return {
    ga4: { pripojeno: ga4.getGa4Config().ready, kdy: g.kdy, chyba: g.chyba, transakci: g.pocet },
    mereni: { nastaveno: !!(p.url && p.tajny), kdy: m.kdy, chyba: m.chyba, zaznamu: m.pocet, posledni: m.posledni ?? null },
    googleAds: { pripojeno: googleSecrets().connected, kdy: a.kdy, chyba: a.chyba }
  };
}

/* ------------------------------------------------------------- stahování */

const HODINY = 3600_000;

/**
 * Analytics: poprvé čtyři měsíce zpátky, pak každé tři hodiny poslední
 * čtyři dny (nákupy se v Analytics dopočítávají až den, dva zpětně).
 */
export async function obnovGa4(vynutit = false): Promise<number> {
  if (!ga4.getGa4Config().ready) return 0;
  const minule = stavZ('zdrojeGa4Stav');
  if (!vynutit && minule.kdy && Date.now() - new Date(minule.kdy).getTime() < 3 * HODINY && !minule.chyba) return 0;
  const zpet = getSetting('zdrojeGa4Zpet', '') === '1';
  try {
    const transakce = await ga4.ga4Transakce(zpet ? 4 : 120);
    const trh = 'cz';
    for (const t of transakce) zapis(t.id, trh, 'ga4', t);
    setSetting('zdrojeGa4Zpet', '1');
    const celkem = (db().prepare("SELECT COUNT(*) AS n FROM order_sources WHERE ga4 != ''").get() as any)?.n ?? 0;
    setSetting('zdrojeGa4Stav', JSON.stringify({ kdy: new Date().toISOString(), chyba: null, pocet: celkem }));
    return transakce.length;
  } catch (e: any) {
    setSetting('zdrojeGa4Stav', JSON.stringify({ ...minule, kdy: new Date().toISOString(), chyba: String(e?.message ?? e).slice(0, 300) }));
    return 0;
  }
}

async function supabase(cesta: string): Promise<any> {
  const p = pripojeni();
  if (!p.url || !p.tajny) throw new Error('Měření není nastavené — chybí adresa Supabase nebo tajný klíč.');
  const res = await fetch(`${p.url}/rest/v1/${cesta}`, { headers: { apikey: p.tajny, Authorization: `Bearer ${p.tajny}` } });
  const telo: any = await res.json().catch(() => null);
  if (res.status === 404 || /does not exist|relation|schema cache/i.test(String(telo?.message ?? ''))) {
    throw new Error(`Tabulka ${TABULKA_ZDROJU} v Supabase není — spusť jednou SQL z nastavení měření.`);
  }
  if (res.status === 401 || res.status === 403) throw new Error('Supabase odmítlo klíč — ke čtení je potřeba tajný (service_role) klíč.');
  if (!res.ok) throw new Error(`Supabase: HTTP ${res.status} ${String(telo?.message ?? '').slice(0, 120)}`);
  return telo;
}

/** Záznamy ze skriptu na e-shopu — jen nové od minula. */
export async function obnovMereni(): Promise<number> {
  const p = pripojeni();
  if (!p.url || !p.tajny) return 0;
  const minule = stavZ('zdrojeMereniStav');
  let kurzor = getSetting('zdrojeMereniKurzor', '') || '1970-01-01T00:00:00Z';
  let novych = 0;
  try {
    for (let strana = 0; strana < 20; strana++) {
      const rows: any[] = await supabase(`${TABULKA_ZDROJU}?select=objednavka,web,data,kdy&kdy=gt.${encodeURIComponent(kurzor)}&order=kdy.asc&limit=500`);
      if (!Array.isArray(rows) || !rows.length) break;
      for (const r of rows) {
        const d = r?.data && typeof r.data === 'object' ? r.data : {};
        const z: ZaznamMereni = {
          web: String(r.web ?? ''), kdy: String(r.kdy ?? ''),
          prvni: d.prvni ?? null, posledni: d.posledni ?? null,
          dotyky: Array.isArray(d.dotyky) ? d.dotyky.slice(-12) : [], zarizeni: String(d.zarizeni ?? '')
        };
        zapis(String(r.objednavka ?? ''), trhZWebu(z.web), 'mereni', z);
        kurzor = String(r.kdy);
        novych += 1;
      }
      setSetting('zdrojeMereniKurzor', kurzor);
      if (rows.length < 500) break;
    }
    const celkem = (db().prepare("SELECT COUNT(*) AS n FROM order_sources WHERE mereni != ''").get() as any)?.n ?? 0;
    setSetting('zdrojeMereniStav', JSON.stringify({
      kdy: new Date().toISOString(), chyba: null, pocet: celkem, posledni: novych ? kurzor : (minule.posledni ?? null)
    }));
  } catch (e: any) {
    setSetting('zdrojeMereniStav', JSON.stringify({ ...minule, kdy: new Date().toISOString(), chyba: String(e?.message ?? e).slice(0, 300) }));
  }
  return novych;
}

/** Ověří tabulku a klíč — pro tlačítko v nastavení. */
export async function overMereni(): Promise<string> {
  await supabase(`${TABULKA_ZDROJU}?select=id&limit=1`);
  const n = await obnovMereni();
  return n ? `Měření funguje, staženo ${n} nových záznamů.` : 'Tabulka je v pořádku a aplikace ji umí číst. Záznamy přibudou s první objednávkou po vložení skriptu.';
}

const denPraha = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague', year: 'numeric', month: '2-digit', day: '2-digit' })
  .format(new Date(iso));

/**
 * Proklik z Google Ads → kampaň, sestava, klíčové slovo.
 *
 * `gclid` v adrese je jen číslo; Google Ads ho ale zná (`click_view`)
 * až 90 dní zpátky, vždy po jednotlivých dnech. Dotazuje se jen na dny,
 * kdy byl proklik, a výsledek se pamatuje.
 */
export async function doplnAds(): Promise<number> {
  if (!googleSecrets().connected) return 0;
  const cekaji = (db().prepare("SELECT kod, trh, mereni FROM order_sources WHERE mereni != '' AND ads = ''").all() as any[])
    .map(r => ({ kod: r.kod as string, trh: r.trh as string, m: cti(r.mereni) as ZaznamMereni | null }))
    .filter(r => r.m?.posledni?.clid === 'gclid' && r.m.posledni.clidHodnota && r.m.posledni.kdy
      && Date.now() - new Date(r.m.posledni.kdy).getTime() < 88 * 86_400_000);
  if (!cekaji.length) return 0;
  const cfg = getAdsConfig();
  const ucty = (cfg.google.accounts ?? []).map(one => one.id).filter(Boolean);
  if (!ucty.length) return 0;
  const dny = [...new Set(cekaji.map(r => denPraha(r.m!.posledni!.kdy!)))].slice(0, 10);
  let doplneno = 0;
  try {
    for (const den of dny) {
      const kliky = new Map<string, AdsKlik>();
      for (const ucet of ucty) {
        const rows = await gaql(cfg,
          `SELECT click_view.gclid, campaign.name, ad_group.name, click_view.keyword_info.text FROM click_view WHERE segments.date = '${den}'`,
          ucet);
        for (const r of rows) {
          const gclid = String(r?.clickView?.gclid ?? '');
          if (gclid) kliky.set(gclid, { kampan: String(r?.campaign?.name ?? ''), sestava: String(r?.adGroup?.name ?? ''), klic: String(r?.clickView?.keywordInfo?.text ?? '') });
        }
      }
      for (const r of cekaji.filter(one => denPraha(one.m!.posledni!.kdy!) === den)) {
        const klik = kliky.get(String(r.m!.posledni!.clidHodnota));
        zapis(r.kod, r.trh, 'ads', klik ?? { kampan: '', sestava: '', klic: '', nenalezeno: true });
        if (klik) doplneno += 1;
      }
    }
    setSetting('zdrojeAdsStav', JSON.stringify({ kdy: new Date().toISOString(), chyba: null, pocet: doplneno }));
  } catch (e: any) {
    setSetting('zdrojeAdsStav', JSON.stringify({ kdy: new Date().toISOString(), chyba: String(e?.message ?? e).slice(0, 300), pocet: 0 }));
  }
  return doplneno;
}

let bezi: Promise<void> | null = null;
/** Všechno najednou — z plánovače každou půlhodinu a z tlačítka „Obnovit". */
export function obnov(vynutit = false): Promise<void> {
  if (bezi) return bezi;
  bezi = (async () => {
    await obnovMereni();
    await obnovGa4(vynutit);
    await doplnAds();
  })().finally(() => { bezi = null; });
  return bezi;
}

/* ------------------------------------------------------------- dotazy */

export function zdrojObjednavky(code: string, market = 'cz'): ZdrojObjednavky | null {
  const kod = klicObjednavky(code);
  if (!kod) return null;
  const r = db().prepare('SELECT * FROM order_sources WHERE kod = ? AND trh = ?').get(kod, market || 'cz') as any;
  return r ? spoj({ ga4: cti(r.ga4), mereni: cti(r.mereni), ads: cti(r.ads) }) : null;
}

export function prehled(days = 30, market = 'all'): ZdrojePrehled {
  const vse = zaznamy();
  const radky: ZdrojRadek[] = ordersSince(Math.max(1, Math.min(400, days)), 5000)
    .filter(o => market === 'all' || o.market === market)
    .map(o => ({
      code: o.code, market: o.market, createdAt: o.createdAt, total: o.total, currency: o.currency, status: o.status, name: o.name,
      zdroj: spoj(vse.get(`${klicObjednavky(o.code)}|${o.market}`))
    }));
  const kanaly = new Map<ZdrojKanal, { kanal: ZdrojKanal; nazev: string; pocet: number; trzba: Record<string, number> }>();
  for (const r of radky) {
    if (!r.zdroj) continue;
    const k = kanaly.get(r.zdroj.kanal) ?? { kanal: r.zdroj.kanal, nazev: NAZVY[r.zdroj.kanal], pocet: 0, trzba: {} };
    k.pocet += 1;
    const mena = r.currency || 'CZK';
    k.trzba[mena] = Math.round(((k.trzba[mena] ?? 0) + (Number(r.total) || 0)) * 100) / 100;
    kanaly.set(r.zdroj.kanal, k);
  }
  return {
    radky,
    kanaly: [...kanaly.values()].sort((a, b) => b.pocet - a.pocet),
    bezZdroje: radky.filter(r => !r.zdroj).length,
    stav: stav()
  };
}

export const __test = { zarad, zdrojZMereni, zdrojZGa4, spoj, klicObjednavky, trhZWebu };
