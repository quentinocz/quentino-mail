import fs from 'fs';
import { getSetting, setSetting } from '../db';
import { encrypt } from '../secure';
import {
  ZkPrehled, ZkVrstva, ZkVrstvaProOkno, ZkVrstvaTyp, ZK_KSANDY_DIL, ZK_VRSTVY,
  vrstvaDef, vzhledDoTextu, vzhledZTextu
} from '../../shared/zkusebna';
import { nacti, uloz } from './png';
import { zmensi } from './pixely';
import * as store from './store';
import * as vrstvy from './vrstvy';
import * as obrazky from './obrazky';
import * as ukazka from './ukazka';
import * as produkty from './produkty';
import { kabina, velikost } from './manifest';
import { vystavKabinu, zavadecTed, VystavPrubeh } from '../kabina/vystav';
import { KabinaVyber } from '../kabina/loader';
import { jmenoVrstvy, stashKabinu, KABINA_SCHEME } from './nahled';
import { zadaniKusuTed, zadaniPostavyTed } from './zadani';

/**
 * Zkušební kabina — co z ní vidí okno aplikace.
 *
 * Jedno místo, kam sahá rozhraní: generování vrstev, jejich schvalování,
 * zařazení produktů a náhled kabiny tak, jak ji uvidí zákazník.
 */

export function prehled(): ZkPrehled {
  const vse = store.vrstvy();
  const rows = store.produktyRows();
  return {
    postavy: store.postavy().map(p => {
      const moje = vse.filter(one => one.postava === p.id);
      return {
        id: p.id, vek: p.vek, telo: p.telo,
        nazev: `${p.vek}-${p.telo}`,
        hotovo: p.hotovo,
        vrstev: moje.filter(one => one.stav === 'hotovo' || one.stav === 'schvaleno').length,
        chystanych: vrstvy.plan(p.id, false).length + 1,
        nesedi: moje.filter(one => one.stav === 'nesedi').length,
        schvalenych: moje.filter(one => one.stav === 'schvaleno').length
      };
    }),
    maKlic: obrazky.maKlic(),
    model: obrazky.model().id,
    kvalita: getSetting('obrazkyKvalita', 'high')!,
    modely: obrazky.MODELY,
    utrata: obrazky.utrata(),
    produkty: {
      zarazenych: rows.filter(one => one.typ).length,
      sBarvou: rows.filter(one => one.hex).length,
      schvalenych: rows.filter(one => one.schvaleno).length
    },
    ukazkove: vse.some(one => one.zadani === 'ukázková kresba')
  };
}

/* ------------------------------------------------------------- vrstvy */

/**
 * Vrstvy jedné postavy i s náhledem.
 *
 * Náhled je zmenšený a vložený rovnou do odpovědi. Vrstva má přes megabajt
 * a posílat dvacet megabajtů do okna pokaždé, když se na postavu podívám,
 * by znamenalo čekat vteřiny na obrázky, které mají být palcové.
 */
export function vrstvyPostavy(postavaId: string, sirkaNahledu = 150): ZkVrstvaProOkno[] {
  const chci = new Map<string, ZkVrstva>();
  for (const one of store.vrstvy(postavaId)) chci.set(`${one.typ}:${one.varianta}`, one);
  const out: ZkVrstvaProOkno[] = [];
  const p = store.postava(postavaId);
  for (const def of ZK_VRSTVY) {
    if (p && def.nePro?.includes(p.vek)) continue;
    for (const varianta of def.varianty) {
      const mam = chci.get(`${def.typ}:${varianta.id}`);
      out.push({
        postava: postavaId,
        typ: def.typ,
        varianta: varianta.id,
        soubor: mam?.soubor ?? '',
        url: mam?.url ?? '',
        sirka: mam?.sirka ?? 0,
        vyska: mam?.vyska ?? 0,
        podil: mam?.podil ?? 0,
        okraje: mam?.okraje ?? { x: 0, y: 0, w: 0, h: 0 },
        stav: mam?.stav ?? 'ceka',
        potiz: mam?.potiz ?? '',
        zadani: mam?.zadani ?? (def.typ === 'postava'
          ? (p ? zadaniPostavyTed(p.vek, p.telo) : '')
          : zadaniKusuTed(def.typ, varianta.id)),
        kdy: mam?.kdy ?? '',
        nazev: def.nazev,
        variantaNazev: varianta.nazev,
        barvitelna: def.barvitelna,
        nahled: mam?.soubor ? maly(mam.soubor, sirkaNahledu) : ''
      });
    }
  }
  return out;
}

/**
 * Zmenšený obrázek jako adresa `data:`.
 *
 * Mapa světla je šedá a po zmenšení z ní nepoznat, jestli sedí — proto se
 * na náhled podkládá šachovnice: na ní je vidět, kde vrstva končí.
 */
function maly(soubor: string, sirka: number): string {
  try {
    const obraz = nacti(fs.readFileSync(soubor));
    const kolikrat = Math.max(1, Math.round(obraz.sirka / Math.max(40, sirka)));
    const mensi = zmensi(obraz, kolikrat);
    for (let y = 0; y < mensi.vyska; y++) {
      for (let x = 0; x < mensi.sirka; x++) {
        const i = (y * mensi.sirka + x) * 4;
        const a = mensi.body[i + 3] / 255;
        if (a >= 0.99) continue;
        const sach = ((x >> 3) + (y >> 3)) % 2 ? 228 : 250;
        mensi.body[i] = Math.round(mensi.body[i] * a + sach * (1 - a));
        mensi.body[i + 1] = Math.round(mensi.body[i + 1] * a + sach * (1 - a));
        mensi.body[i + 2] = Math.round(mensi.body[i + 2] * a + sach * (1 - a));
        mensi.body[i + 3] = 255;
      }
    }
    return `data:image/png;base64,${uloz(mensi).toString('base64')}`;
  } catch {
    return '';
  }
}

/** Kroky oblékání — na nich je vidět, co model udělal. */
export function krokyPostavy(postavaId: string): { poradi: number; typ: string; nahled: string }[] {
  return store.kroky(postavaId).map(one => ({
    poradi: one.poradi,
    typ: one.typ,
    nahled: one.soubor ? maly(one.soubor, 150) : ''
  }));
}

export async function generujPostavu(postavaId: string) {
  return vrstvy.vygenerujPostavu(postavaId);
}

export async function generujVrstvu(postavaId: string, typ: ZkVrstvaTyp, varianta: string) {
  const { vrstva } = await vrstvy.vygenerujVrstvu(postavaId, typ, varianta);
  return { ...vrstva, nahled: vrstva.soubor ? maly(vrstva.soubor, 150) : '' };
}

export async function generujVse(postavaId: string, jenChybejici = true) {
  return vrstvy.vygenerujVse(postavaId, jenChybejici);
}

export function postavUkazku(postavaId: string) {
  return ukazka.postavUkazku(postavaId);
}

/** Ukázka pro všechny postavy naráz — ať je co zkoušet hned. */
export function postavUkazkuVse(): { hotovo: number; nesedi: string[] } {
  let hotovo = 0;
  const nesedi: string[] = [];
  for (const p of store.postavy()) {
    const vysledek = ukazka.postavUkazku(p.id);
    hotovo += vysledek.hotovo;
    nesedi.push(...vysledek.nesedi);
  }
  return { hotovo, nesedi };
}

/**
 * Schválení vrstvy — a u nepovedené i přijetí jejího kroku.
 *
 * Kontrola je mez, ne soud: vlasy i s kotletami vyjdou na jedenáct
 * procent postavy, mez je deset, a na obrázku je přitom vidět, že jsou
 * to vlasy. Když člověk takovou vrstvu přesto přijme, musí se přijmout
 * i **krok, který z ní vznikl** — jinak by se další kus oblékal na
 * postavu bez ní (sako rovnou na tričko místo na košili).
 */
export function schval(postavaId: string, typ: ZkVrstvaTyp, varianta: string, ano: boolean) {
  store.schval(postavaId, typ, varianta, ano);
  if (!ano) return;
  const def = vrstvaDef(typ);
  if (def.varianty[0]?.id !== varianta) return;
  const poradi = ZK_VRSTVY.findIndex(one => one.typ === typ);
  const krok = store.cestaKroku(postavaId, poradi, `${typ}-${varianta}`);
  if (fs.existsSync(krok)) store.zapisKrok(postavaId, poradi, typ, krok);
}

/* ------------------------------------------------------------- zadání */

export function ulozZadani(klic: string, text: string): void {
  setSetting(`zkZadani:${klic}`, text);
}

export function zadaniZpet(klic: string): void {
  setSetting(`zkZadani:${klic}`, '');
}

/* ----------------------------------------------------------- nastavení */

export function nastav(co: {
  klic?: string; model?: string; strop?: number; kvalita?: string; maska?: boolean;
  kategorie?: Record<string, Record<string, string>>; ksandyDil?: number;
  vyber?: Partial<KabinaVyber>;
}): void {
  if (co.klic !== undefined) setSetting('openaiApiKey', co.klic ? encrypt(co.klic) : '');
  if (co.model !== undefined) setSetting('obrazkovyModel', co.model);
  if (co.strop !== undefined) setSetting('obrazkyStrop', String(Math.max(0, co.strop)));
  if (co.kvalita !== undefined) setSetting('obrazkyKvalita', co.kvalita);
  if (co.maska !== undefined) setSetting('zkMaska', co.maska ? '1' : '0');
  if (co.kategorie !== undefined) ulozKategorie(co.kategorie);
  if (co.vyber !== undefined) ulozVyber(co.vyber);
  if (co.ksandyDil !== undefined) {
    const dil = Number(co.ksandyDil);
    if (dil > 0.2 && dil < 1.2) setSetting('zkKsandyDil', String(Math.round(dil * 1000) / 1000));
  }
}

export function nastaveni() {
  return {
    maKlic: obrazky.maKlic(),
    model: obrazky.model().id,
    kvalita: getSetting('obrazkyKvalita', 'high')!,
    maska: getSetting('zkMaska', '1') === '1',
    strop: Number(getSetting('obrazkyStrop', '40')) || 40,
    kontakt: kontakt(),
    kategorie: kategorie(),
    ksandyDil: ksandyDil(),
    vyber: vyberNaWebu(),
    vystaveno: zavadec()
  };
}

/**
 * Odkazy na kategorie e-shopu pro pobídky z modelu.
 *
 * Když zákazník klikne na prázdné místo v klopě, kabina mu nabídne
 * kapesníčky — a kdo chce vidět celou nabídku, má jít do kategorie.
 * Adresy se ale nedají uhodnout: slug je v každé jazykové verzi jiný a
 * mění se podle toho, jak si je kdo v administraci pojmenuje. Proto se
 * zadávají, a když zadané nejsou, kabina zůstane u hledání v sobě —
 * což je mimochodem rychlejší, jen z e-shopu neodvede.
 */
export function kategorie(): Record<string, Record<string, string>> {
  try {
    const ulozene = JSON.parse(getSetting('zkKabinaKategorie', '{}')!);
    return ulozene && typeof ulozene === 'object' ? ulozene : {};
  } catch { return {}; }
}

export function ulozKategorie(co: Record<string, Record<string, string>>): void {
  setSetting('zkKabinaKategorie', JSON.stringify(co ?? {}));
}

/** Poměr délky kšand k výšce člověka — kvůli radě s velikostí. */
export function ksandyDil(): number {
  const ulozeny = Number(getSetting('zkKsandyDil', String(ZK_KSANDY_DIL)));
  return ulozeny > 0.2 && ulozeny < 1.2 ? ulozeny : ZK_KSANDY_DIL;
}

/** Kontakt „rádi poradíme osobně" — ukazuje se v kabině pořád. */
export function kontakt(): { text: string; telefon: string; mail: string } {
  return {
    text: getSetting('zkKontaktText', 'Nevíte si rady? Rádi poradíme osobně.')!,
    telefon: getSetting('zkKontaktTelefon', '')!,
    mail: getSetting('zkKontaktMail', '')!
  };
}

export function ulozKontakt(co: { text: string; telefon: string; mail: string }): void {
  setSetting('zkKontaktText', co.text ?? '');
  setSetting('zkKontaktTelefon', co.telefon ?? '');
  setSetting('zkKontaktMail', co.mail ?? '');
}

/* ------------------------------------------------------------ produkty */

export async function projdiKatalog(sAi: boolean, sBarvami: boolean) {
  return produkty.projdiKatalog({ sAi, sBarvami });
}

export function produktyPrehled(limit = 300) {
  const rows = store.produktyRows();
  const vKabine = produkty.proKabinu(limit);
  const mapa = new Map(vKabine.map(one => [one.kod, one]));
  return rows.slice(0, limit).map(row => {
    const p = mapa.get(row.kod);
    return {
      ...row,
      nazev: p?.nazev ?? row.kod,
      obrazek: p?.obrazek ?? '',
      cena: p?.cena ?? '',
      vKabine: !!p
    };
  });
}

export function upravProdukt(kod: string, co: { typ?: ZkVrstvaTyp | ''; varianta?: string; hex?: string; schvaleno?: boolean }) {
  const row = store.produktyRows().find(one => one.kod === kod)
    ?? { kod, typ: '' as const, varianta: '', hex: '', vzorek: '', rucne: false, velikosti: false, schvaleno: false };
  store.zapisProdukt({
    ...row,
    typ: co.typ !== undefined ? co.typ : row.typ,
    varianta: co.varianta !== undefined ? co.varianta : row.varianta,
    hex: co.hex !== undefined ? co.hex : row.hex,
    /* Ručně opravená barva se už nikdy nepřepočítá z fotky */
    rucne: co.hex !== undefined ? true : row.rucne,
    schvaleno: co.schvaleno !== undefined ? co.schvaleno : row.schvaleno
  });
}

/* -------------------------------------------------------------- náhled */

/**
 * Adresa náhledu kabiny pro rámeček v okně.
 *
 * Běží na **tomtéž skriptu**, který se vkládá do e-shopu — liší se jen
 * tím, odkud si bere vrstvy.
 */
export function nahledKabiny(): { url: string; velikost: ReturnType<typeof velikost> } {
  const hotove = store.vrstvy().filter(one => one.stav === 'hotovo' || one.stav === 'schvaleno');
  const klicovac = new Map(hotove.map(one => [`${one.postava}:${one.typ}:${one.varianta}`, one]));
  const { url, data } = stashKabinu(
    (klic, adresaProduktu, adresaVzorku) => kabina(v => {
      const mam = klicovac.get(`${v.postava}:${v.typ}:${v.varianta}`);
      return mam?.soubor ? `${KABINA_SCHEME}://nahled/${klic}/vrstva/${jmenoVrstvy(v)}` : '';
    }, 400, {
      kategorie: kategorie(), ksandyDil: ksandyDil(), kontakt: kontakt(),
      url: adresaProduktu, vzorek: adresaVzorku
    }),
    hotove
  );
  return { url, velikost: velikost(data) };
}

/* ------------------------------------------------------------- vystavení */

/**
 * Kde na stránkách e-shopu se tlačítka hledají.
 *
 * Výchozí hodnoty sedí na dnešní šablonu quentino.cz. Jsou tu k přepsání
 * proto, že šablona se mění bez nás: kdyby se karta produktu přestala
 * jmenovat `card-item`, tlačítko by zmizelo a jediná oprava by byla nové
 * vydání aplikace.
 */
export function vyberNaWebu(): Partial<KabinaVyber> {
  try {
    const ulozene = JSON.parse(getSetting('zkKabinaVyber', '{}')!);
    return ulozene && typeof ulozene === 'object' ? ulozene : {};
  } catch { return {}; }
}

export function ulozVyber(co: Partial<KabinaVyber>): void {
  setSetting('zkKabinaVyber', JSON.stringify(co ?? {}));
}

/** Vystaví kabinu na web a vrátí kód zavaděče do šablony. */
export async function vystav(hlas?: (p: VystavPrubeh) => void) {
  const hotove = store.vrstvy().filter(one => one.stav === 'hotovo' || one.stav === 'schvaleno');
  return vystavKabinu(
    (adresa, vzorek) => kabina(adresa, 400, {
      kategorie: kategorie(), ksandyDil: ksandyDil(), kontakt: kontakt(), vzorek
    }),
    hotove,
    { vyber: vyberNaWebu(), hlas }
  );
}

/** Co se vkládá do šablony — i bez vystavení, ať je vidět co a kam. */
export function zavadec() {
  return zavadecTed(vyberNaWebu());
}

/* -------------------------------------------------------------- vzhledy */

export function vzhledy() {
  return store.vzhledy();
}

export function ulozVzhled(id: string, nazev: string, text: string): void {
  store.zapisVzhled(id || String(Date.now()), nazev, text);
}

export function smazVzhled(id: string): void {
  store.smazVzhled(id);
}

export const __test = { maly, vrstvaDef, vzhledDoTextu, vzhledZTextu };
