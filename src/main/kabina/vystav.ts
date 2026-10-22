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

/** Jméno souboru vrstvy v úložišti. */
export function cestaVrstvy(v: Pick<ZkVrstva, 'postava' | 'typ' | 'varianta'>): string {
  return `${CESTA}/vrstvy/${v.postava}/${v.typ}-${v.varianta}.png`;
}

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
  postav: (adresa: (v: ZkVrstva) => string) => Kabina,
  vrstvy: ZkVrstva[],
  moznosti: { ttl?: number; vyber?: Partial<KabinaVyber>; hlas?: (p: VystavPrubeh) => void } = {}
): Promise<VystavVysledek> {
  const hlas = moznosti.hlas ?? (() => undefined);
  const data = postav(v => verejnaAdresa(cestaVrstvy(v)));
  /* Vystavují se jen vrstvy, které jsou v seznamu — co kabina nepoužívá,
     by v úložišti jen leželo a platilo se za to */
  const chtene = new Set(data.vrstvy.map(one => one.url));
  const kVystaveni = vrstvy.filter(one => one.soubor && chtene.has(verejnaAdresa(cestaVrstvy(one))));

  const zname = otisky();
  const nove: Record<string, string> = { ...zname };
  let nahranych = 0;
  let preskocenych = 0;
  let bajtu = 0;

  const celkem = kVystaveni.length + 2;
  for (let i = 0; i < kVystaveni.length; i++) {
    const vrstva = kVystaveni[i];
    const cesta = cestaVrstvy(vrstva);
    hlas({ hotovo: i, celkem, co: `Vystavuji ${vrstva.typ} ${vrstva.varianta}` });
    let telo: Buffer;
    try { telo = fs.readFileSync(vrstva.soubor!); } catch { continue; }
    const otisk = crypto.createHash('sha1').update(telo).digest('hex');
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
