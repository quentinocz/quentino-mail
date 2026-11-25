import crypto from 'crypto';
import fs from 'fs';
import { getSetting, setSetting } from '../db';
import { webStorage } from '../webtexts';
import { ZkVrstva } from '../../shared/zkusebna';
import { kabinaScript } from './script';
import { kabinaLoader, KabinaVyber } from './loader';
import { Kabina } from '../zkusebna/manifest';

/**
 * Vystavení kabiny na web.
 *
 * ## Co se kam dává
 *
 * Do téhož úložiště, odkud bere data skript s bannery:
 *  * `kabina/kabina.js` — celá kabina,
 *  * `kabina/data.json` — postavy, vrstvy, produkty, číselník,
 *  * `kabina/vrstvy/…png` — obrázky vrstev.
 *
 * Do šablony e-shopu se vkládá jen **zavaděč**, který na tyhle adresy
 * ukazuje. Vkládá se jednou; při další změně kabiny se mění soubory
 * tady, ne kód v administraci.
 *
 * ## Proč se počítá otisk každé vrstvy
 *
 * Vrstev je kolem dvou set a každá má stovky kilobajtů. Vystavit
 * pokaždé všechny znamená desítky megabajtů a několik minut čekání —
 * a to i tehdy, když se změnil jeden odstín v jednom číselníku. Otisk
 * obsahu se proto pamatuje a nahrává se jen to, co se opravdu změnilo.
 *
 * ## Proč se vrstvy nenahrávají do Upgates
 *
 * Fotky banneru patří do správce souborů e-shopu, protože je tam člověk
 * hledá a mění i bez aplikace. Vrstvy kabiny jsou pravý opak: nikdo je
 * ručně neotevře, vznikají a zanikají po stovkách a nikdo je nemá
 * vidět ve správci souborů vedle fotek produktů.
 */

const CESTA = 'kabina';
const OTISKY_KLIC = 'zkVystaveneOtisky';

export interface VystavPrubeh {
  hotovo: number;
  celkem: number;
  co: string;
}

export function verejnaAdresa(cesta: string): string {
  const s = webStorage();
  if (!s.url) return '';
  const clean = String(cesta).replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');
  return `${s.url}/storage/v1/object/public/${encodeURIComponent(s.bucket)}/${clean}`;
}

function adresaObjektu(cesta: string): string {
  const s = webStorage();
  const clean = String(cesta).replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');
  return `${s.url}/storage/v1/object/${encodeURIComponent(s.bucket)}/${clean}`;
}

async function zalozKbelik(): Promise<void> {
  const s = webStorage();
  const res = await fetch(`${s.url}/storage/v1/bucket`, {
    method: 'POST',
    headers: { apikey: s.key, Authorization: `Bearer ${s.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: s.bucket, name: s.bucket, public: true })
  });
  if (!res.ok && res.status !== 409) {
    throw new Error(`Kbelík ${s.bucket} nejde založit: ${res.status} ${(await res.text()).slice(0, 160)}`);
  }
}

/** Uloží soubor do kbelíku a vrátí jeho veřejnou adresu. */
async function nahraj(cesta: string, telo: BodyInit, typ: string, cache: string): Promise<string> {
  const s = webStorage();
  if (!s.url) throw new Error('Chybí adresa projektu Supabase — nastav ji v Textech na webu.');
  if (!s.key) throw new Error('Chybí servisní klíč (service_role) — bez něj se do úložiště zapsat nedá.');

  const poslat = () => fetch(adresaObjektu(cesta), {
    method: 'POST',
    headers: {
      apikey: s.key,
      Authorization: `Bearer ${s.key}`,
      'Content-Type': typ,
      'cache-control': cache,
      'x-upsert': 'true'
    },
    body: telo
  });

  let res = await poslat();
  if (res.status === 400 || res.status === 404) {
    const zprava = await res.text();
    if (/bucket/i.test(zprava)) {
      await zalozKbelik();
      res = await poslat();
    } else {
      throw new Error(`Nahrání se nepovedlo: ${res.status} ${zprava.slice(0, 200)}`);
    }
  }
  if (!res.ok) throw new Error(`Nahrání se nepovedlo: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return verejnaAdresa(cesta);
}

function otisky(): Record<string, string> {
  try {
    const ulozene = JSON.parse(getSetting(OTISKY_KLIC, '{}')!);
    return ulozene && typeof ulozene === 'object' ? ulozene : {};
  } catch { return {}; }
}

/*
 * Otisk obsahu je přímo ve jméně souboru.
 *
 * Vrstvy a vzorky se vystavují s `immutable` na rok — prohlížeč se na ně
 * znovu neptá. Dokud bylo jméno pevné (`kravata-kravata.png`), viděl
 * zákazník po překreslení šablony nebo novém vzorku **pořád ten starý**
 * a z kabiny nešlo poznat, jestli oprava zabrala (Patrik, 23. 11.:
 * „stále nesedí textura"). S otiskem ve jméně je nový obsah nová adresa.
 */
const kratky = (otisk: string) => otisk ? `.${otisk.slice(0, 10)}` : '';

/** Jméno souboru vrstvy v úložišti. */
export function cestaVrstvy(v: Pick<ZkVrstva, 'postava' | 'typ' | 'varianta'>, otisk = '', kov = false): string {
  return `${CESTA}/vrstvy/${v.postava}/${v.typ}-${v.varianta}${kov ? '-kov' : ''}${kratky(otisk)}.png`;
}

/** Jméno souboru se vzorkem látky. */
export function cestaVzorku(kod: string, otisk = ''): string {
  return `${CESTA}/vzorky/${String(kod).replace(/[^\w.-]+/g, '-')}${kratky(otisk)}.png`;
}

const sha1 = (telo: Buffer) => crypto.createHash('sha1').update(telo).digest('hex');

export interface VystavVysledek {
  kdy: string;
  /** Adresa kabiny — tu nese zavaděč v šabloně. */
  skript: string;
  zdroj: string;
  /** Kód k vložení do šablony e-shopu. */
  zavadec: string;
  nahranych: number;
  preskocenych: number;
  megabajtu: number;
}

/**
 * Vystaví kabinu i s vrstvami.
 *
 * `postav` dostane funkci, která z vrstvy udělá **veřejnou adresu** —
 * seznam tak odkazuje rovnou do úložiště. Je to tentýž seznam, jaký
 * dostane náhled v aplikaci; liší se jen adresy, a proto se v aplikaci
 * opravdu zkouší to, co poběží na e-shopu.
 */
export async function vystavKabinu(
  postav: (
    adresa: (v: ZkVrstva, kov?: boolean) => string,
    vzorek?: (vzorek: string, klic: string) => string,
    vykresleni?: (soubor: string, klic: string) => string
  ) => Kabina,
  moznosti: { ttl?: number; vyber?: Partial<KabinaVyber>; hlas?: (p: VystavPrubeh) => void } = {}
): Promise<VystavVysledek> {
  const hlas = moznosti.hlas ?? (() => undefined);

  /* Otisky vrstev napřed — jsou ve jménech souborů, a ta jsou v seznamu */
  const souboryVrstev = new Map<string, { cesta: string; telo: Buffer; popis: string }>();
  const adresa = (v: ZkVrstva, kov = false): string => {
    const zdroj = kov ? v.kov : v.soubor;
    if (!zdroj) return '';
    let telo: Buffer;
    try { telo = fs.readFileSync(zdroj); } catch { return ''; }
    const cesta = cestaVrstvy(v, sha1(telo), kov);
    souboryVrstev.set(cesta, { cesta, telo, popis: `${v.typ} ${v.varianta}${kov ? ' (kov)' : ''}` });
    return verejnaAdresa(cesta);
  };
  /*
   * Vzorky látek jsou v seznamu jako text a u čtyř set produktů dělají
   * dva megabajty, které by si stáhl každý zákazník. Vystaví se proto
   * jako soubory a do seznamu jdou jen jejich adresy — stáhne se jen
   * ten vzorek, který je zrovna na modelu.
   */
  const vzorky = new Map<string, Buffer>();
  const vzorek = (text: string, klic: string): string => {
    const shoda = /^data:image\/png;base64,(.+)$/.exec(text || '');
    if (!shoda) return text || '';
    const telo = Buffer.from(shoda[1], 'base64');
    const cesta = cestaVzorku(klic, sha1(telo));
    vzorky.set(cesta, telo);
    return verejnaAdresa(cesta);
  };
  /* Produkty vykreslené na modelu — soubory s otiskem ve jméně, jako vrstvy */
  const vykresleni = (soubor: string, klic: string): string => {
    let telo: Buffer;
    try { telo = fs.readFileSync(soubor); } catch { return ''; }
    const cesta = `${CESTA}/vykresleni/${String(klic).replace(/[^\w.~/-]+/g, '-')}${kratky(sha1(telo))}.png`;
    souboryVrstev.set(cesta, { cesta, telo, popis: `vykreslení ${klic}` });
    vykreslenePridej.add(verejnaAdresa(cesta));
    return verejnaAdresa(cesta);
  };
  const vykreslenePridej = new Set<string>();
  const data = postav(adresa, vzorek, vykresleni);
  /* Vystavují se jen vrstvy, které jsou v seznamu — co kabina nepoužívá,
     by v úložišti jen leželo a platilo se za to */
  const chtene = new Set<string>();
  for (const one of data.vrstvy) { chtene.add(one.url); if (one.kov) chtene.add(one.kov); }
  for (const url of vykreslenePridej) chtene.add(url);
  const kVystaveni = [...souboryVrstev.values()].filter(one => chtene.has(verejnaAdresa(one.cesta)));

  const zname = otisky();
  const nove: Record<string, string> = { ...zname };
  let nahranych = 0;
  let preskocenych = 0;
  let bajtu = 0;

  const celkem = kVystaveni.length + 2;
  for (let i = 0; i < kVystaveni.length; i++) {
    const { cesta, telo, popis } = kVystaveni[i];
    hlas({ hotovo: i, celkem, co: `Vystavuji ${popis}` });
    const otisk = sha1(telo);
    if (zname[cesta] === otisk) { preskocenych += 1; continue; }
    await nahraj(cesta, new Uint8Array(telo), 'image/png', 'max-age=31536000, immutable');
    nove[cesta] = otisk;
    nahranych += 1;
    bajtu += telo.length;
  }

  let hotovychVzorku = 0;
  for (const [cesta, telo] of vzorky) {
    hotovychVzorku += 1;
    hlas({ hotovo: kVystaveni.length, celkem, co: `Vystavuji vzorky (${hotovychVzorku} z ${vzorky.size})` });
    const otisk = sha1(telo);
    if (zname[cesta] === otisk) { preskocenych += 1; continue; }
    await nahraj(cesta, new Uint8Array(telo), 'image/png', 'max-age=31536000, immutable');
    nove[cesta] = otisk;
    nahranych += 1;
    bajtu += telo.length;
  }

  /*
   * Seznam a skript až nakonec. Kdyby se seznam vystavil první, odkazoval
   * by chvíli na vrstvy, které tam ještě nejsou — a zákazník, který by
   * kabinu zrovna otevřel, by viděl model po kouscích.
   */
  hlas({ hotovo: celkem - 2, celkem, co: 'Vystavuji seznam' });
  const seznam = JSON.stringify(data);
  const zdroj = await nahraj(`${CESTA}/data.json`, seznam, 'application/json; charset=utf-8', 'max-age=300');
  bajtu += Buffer.byteLength(seznam);

  hlas({ hotovo: celkem - 1, celkem, co: 'Vystavuji kabinu' });
  const telo = kabinaScript({ zdroj, ttl: moznosti.ttl ?? 900 });
  const skript = await nahraj(`${CESTA}/kabina.js`, telo, 'text/javascript; charset=utf-8', 'max-age=300');
  bajtu += Buffer.byteLength(telo);

  setSetting(OTISKY_KLIC, JSON.stringify(nove));
  const kdy = new Date().toISOString();
  setSetting('zkVystavenoKdy', kdy);
  return {
    kdy,
    skript,
    zdroj,
    zavadec: kabinaLoader({ skript, vyber: moznosti.vyber }),
    nahranych,
    preskocenych,
    megabajtu: Math.round(bajtu / 1048576 * 10) / 10
  };
}

/** Zavaděč do šablony — i bez vystavení, ať je vidět, co se bude vkládat. */
export function zavadecTed(vyber?: Partial<KabinaVyber>): { kod: string; skript: string; kdy: string } {
  const skript = verejnaAdresa(`${CESTA}/kabina.js`);
  return {
    kod: skript ? kabinaLoader({ skript, vyber }) : '',
    skript,
    kdy: getSetting('zkVystavenoKdy', '')!
  };
}
