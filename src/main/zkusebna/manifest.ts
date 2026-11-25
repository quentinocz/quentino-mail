import {
  ZkVrstva, ZK_BARVY, ZK_KSANDY_DIL, ZK_PORADI, ZK_TELA, ZK_VEKY, ZK_VLASY, ZK_VRSTVY,
  vychoziVzhled
} from '../../shared/zkusebna';
import { ZkProdukt } from '../../shared/zkusebna';
import * as store from './store';
import { proKabinu } from './produkty';
import { kotvyPostavy } from './sablony';
import { doKabiny } from './vykresleni';

/** Body pro kabinu — zaokrouhlené, ať seznam zbytečně nebobtná. */
function kotvyProKabinu(postavaId: string) {
  try {
    const mereni = kotvyPostavy(postavaId);
    if (!mereni) return undefined;
    const k = mereni.kotvy;
    const r = (v: number) => Math.round(v);
    return {
      pas: r(k.pas),
      kravata: [r(k.limec.x), r(k.limec.y + 2.5 * k.naCm)] as [number, number],
      ksandy: [
        r(k.ramenoL.x + (k.sponaL.x - k.ramenoL.x) * 0.4),
        r(k.ramenoL.y + (k.sponaL.y - k.ramenoL.y) * 0.4)
      ] as [number, number],
      kapesnicek: [r(k.kapsa.x), r(k.kapsa.y - 1.2 * k.naCm)] as [number, number]
    };
  } catch {
    return undefined;
  }
}

/**
 * Seznam, který si skript na e-shopu stáhne.
 *
 * ## Proč je v něm i číselník
 *
 * Skript by si mohl pořadí vrstev, názvy variant a nabídku barev nést
 * v sobě. Jenže pak by každá změna — přibylá varianta kravaty, jiná
 * nabídka barev — znamenala **znovu vložit skript do šablony e-shopu**.
 * Takhle se mění jen tenhle soubor a skript v šabloně zůstává, jak je.
 *
 * ## Proč se neposílá všechno
 *
 * Posílají se jen hotové vrstvy a produkty skladem. Vrstva, která se
 * nepovedla, by v kabině chyběla v půlce obleku; produkt, který došel,
 * je zklamání na jedno kliknutí.
 */
export interface Kabina {
  verze: number;
  kdy: string;
  postavy: {
    id: string; vek: string; telo: string; vyskaCm: number;
    sirka: number; vyska: number; temeno: number; podrazka: number;
    /**
     * Změřené body na postavě v bodech plátna: kam patří bod „přidat"
     * u každého doplňku a kde je pas. Podle pasu se model ořízne — ukazuje
     * se po stehna, ne celý (boty neprodáváme).
     */
    kotvy?: { pas: number; kravata: [number, number]; ksandy: [number, number]; kapesnicek: [number, number] };
  }[];
  vrstvy: {
    postava: string; typ: string; varianta: string; url: string;
    /**
     * Kov kšand (spony, posuvky) jako zvláštní obrázek, který se nebarví.
     * Patrik (23. 11.): „ty spony vypadají divně" — byly obarvené látkou.
     */
    kov?: string;
    /** Obdélník vrstvy [x, y, š, v] — kapesníček na něj natáhne roh z fotky. */
    okraje?: [number, number, number, number];
  }[];
  produkty: ReturnType<typeof proKabinu>;
  katalog: {
    poradi: string[];
    vrstvy: {
      typ: string; nazev: string; popis: string;
      barvitelna: boolean; nepovinna: boolean; zbozi: boolean;
      varianty: { id: string; nazev: string }[];
      /** Citlivé místo na modelu — díl šířky a výšky. */
      bod?: { x: number; y: number };
      pobidka?: string;
    }[];
    barvy: { id: string; nazev: string; hex: string }[];
    vlasy: { id: string; nazev: string; hex: string }[];
    veky: {
      id: string; nazev: string; popis: string;
      vyska: [number, number];
      /** Kolik je takovému modelu let — kabina z toho radí velikost. */
      roky: [number, number];
    }[];
    tela: { id: string; nazev: string; popis: string }[];
    vychozi: ReturnType<typeof vychoziVzhled>;
  };
  /**
   * Co se dá změnit bez zasahování do šablony e-shopu.
   *
   * Všechno, co by jinak bylo zadrátované ve skriptu v šabloně: odkazy
   * na kategorie pro pobídky, poměr pro radu s délkou kšand, kontakt.
   * Jednou vložený skript v šabloně se tak nemusí vkládat znovu — a to
   * je v e-shopu, kde je vložení ruční práce v administraci, rozdíl
   * mezi „to se opraví" a „to se opraví někdy".
   */
  nastaveni: {
    /** Odkaz na kategorii pro každý typ zboží a jazykovou verzi. */
    kategorie: Record<string, Record<string, string>>;
    /** Jakou část výšky člověka měří kšandy — pro radu s velikostí. */
    ksandyDil: number;
    kontakt: { text: string; telefon: string; mail: string };
  };
}

export interface KabinaNastaveni {
  kategorie?: Record<string, Record<string, string>>;
  ksandyDil?: number;
  kontakt?: { text: string; telefon: string; mail: string };
  /**
   * Přepsání adres produktů — jen pro náhled v aplikaci.
   *
   * V náhledu zastupuje e-shop stránka, kterou vydává aplikace sama, a
   * kabina produkt poznává podle cesty v adrese. Bez přepsání by
   * ukazovala na quentino.cz a v náhledu by se nedalo proklikat nic.
   */
  url?: (p: ZkProdukt) => string;
  /**
   * Adresa vzorku látky místo jeho obsahu.
   *
   * Vzorek je kousek fotky produktu a v seznamu je jako text — u čtyř
   * set produktů z toho jsou **dva megabajty**, které si stáhne každý,
   * kdo kabinu otevře, a potřebuje z nich jeden. Když se vzorky vystaví
   * jako soubory, stáhne se jen ten, co je zrovna na modelu.
   *
   * `klic` je kód produktu, u dalšího kusu sady `kód~pořadí` — sada
   * kšandy s motýlkem má vzorek pro každý kus zvlášť.
   */
  vzorek?: (vzorek: string, klic: string) => string;
  /**
   * Adresa produktu vykresleného na modelu (soubor → adresa). Bez ní se
   * vykreslení do seznamu nedává — kabina zůstane u šablony se vzorkem.
   */
  vykresleni?: (soubor: string, klic: string) => string;
}

/**
 * Postaví seznam pro kabinu.
 *
 * `adresa` říká, kde vrstva leží — na e-shopu je to veřejná adresa
 * z úložiště, v náhledu v aplikaci vlastní adresa, kterou obsluhuje
 * hlavní proces. Je to jediný rozdíl mezi náhledem a ostrým provozem,
 * takže se v aplikaci opravdu zkouší tentýž skript.
 */
export function kabina(
  adresa: (v: ZkVrstva, kov?: boolean) => string,
  produktu = 400,
  nastaveni: KabinaNastaveni = {}
): Kabina {
  const hotove = store.vrstvy().filter(one => one.stav === 'hotovo' || one.stav === 'schvaleno');
  const maPostavu = new Set(
    hotove.filter(one => one.typ === 'postava').map(one => one.postava)
  );
  const vykreslene = nastaveni.vykresleni ? doKabiny() : new Map();
  return {
    verze: 1,
    kdy: new Date().toISOString(),
    postavy: store.postavy()
      .filter(one => one.hotovo && maPostavu.has(one.id))
      .map(one => ({
        id: one.id, vek: one.vek, telo: one.telo, vyskaCm: one.vyskaCm,
        sirka: one.sirka, vyska: one.vyska, temeno: one.temeno, podrazka: one.podrazka,
        kotvy: kotvyProKabinu(one.id)
      })),
    vrstvy: hotove
      .filter(one => maPostavu.has(one.postava))
      /* Jen to, co kabina zná — pásek nebo zrušená varianta z dřívějška se neposílá */
      .filter(one => ZK_VRSTVY.some(def => def.typ === one.typ && def.varianty.some(v => v.id === one.varianta)))
      .map(one => ({
        postava: one.postava, typ: one.typ, varianta: one.varianta, url: adresa(one),
        kov: one.kov ? adresa(one, true) || undefined : undefined,
        okraje: one.typ === 'kapesnicek' && one.okraje?.w
          ? [one.okraje.x, one.okraje.y, one.okraje.w, one.okraje.h] as [number, number, number, number]
          : undefined
      }))
      .filter(one => !!one.url),
    produkty: proKabinu(produktu).map(p => {
      /* Vykreslení na modelu — jen to, co je pro dnešní variantu (šířku) a postavu, která je v seznamu */
      if (nastaveni.vykresleni) {
        const moje = vykreslene.get(p.kod) ?? [];
        const proKus = (cast: number, varianta: string) => {
          const out: Record<string, [string, number, number, number, number]> = {};
          for (const v of moje) {
            if (v.cast !== cast || v.varianta !== varianta || !maPostavu.has(v.postava)) continue;
            const url = nastaveni.vykresleni!(v.soubor, `${v.postava}/${p.kod}${cast >= 0 ? `~${cast}` : ''}`);
            if (url) out[v.postava] = [url, v.x, v.y, v.w, v.h];
          }
          return Object.keys(out).length ? out : undefined;
        };
        p = {
          ...p,
          vykresleni: proKus(-1, p.varianta),
          casti: p.casti?.map((c, i) => ({ ...c, vykresleni: proKus(i, c.varianta) }))
        };
      }
      if (!nastaveni.url && !nastaveni.vzorek) return p;
      return {
        ...p,
        url: nastaveni.url ? nastaveni.url(p) : p.url,
        /* V náhledu se adresy přepisují na vlastní, takže cizí jazykové
           verze by vedly na quentino.cz — tam se proklikat nedá */
        trhy: nastaveni.url ? undefined : p.trhy,
        vzorek: nastaveni.vzorek && p.vzorek ? nastaveni.vzorek(p.vzorek, p.kod) : p.vzorek,
        casti: p.casti?.map((c, i) => ({
          ...c,
          vzorek: nastaveni.vzorek && c.vzorek ? nastaveni.vzorek(c.vzorek, `${p.kod}~${i}`) : c.vzorek
        }))
      };
    }),
    katalog: {
      poradi: [...ZK_PORADI],
      vrstvy: ZK_VRSTVY.map(one => ({
        typ: one.typ, nazev: one.nazev, popis: one.popis,
        barvitelna: one.barvitelna, nepovinna: one.nepovinna, zbozi: one.zbozi,
        varianty: one.varianty,
        bod: one.bod,
        pobidka: one.pobidka
      })),
      barvy: ZK_BARVY,
      vlasy: ZK_VLASY,
      veky: (Object.keys(ZK_VEKY) as (keyof typeof ZK_VEKY)[]).map(id => ({
        id, nazev: ZK_VEKY[id].nazev, popis: ZK_VEKY[id].popis,
        vyska: ZK_VEKY[id].vyska, roky: ZK_VEKY[id].roky
      })),
      tela: (Object.keys(ZK_TELA) as (keyof typeof ZK_TELA)[]).map(id => ({
        id, nazev: ZK_TELA[id].nazev, popis: ZK_TELA[id].popis
      })),
      vychozi: vychoziVzhled('dospely')
    },
    nastaveni: {
      kategorie: nastaveni.kategorie ?? {},
      ksandyDil: nastaveni.ksandyDil ?? ZK_KSANDY_DIL,
      kontakt: nastaveni.kontakt ?? { text: '', telefon: '', mail: '' }
    }
  };
}

/** Kolik toho kabina zákazníkovi stáhne — rozhoduje o tom, jak je svižná. */
export function velikost(data: Kabina): { seznamKb: number; postav: number; vrstev: number; produktu: number } {
  return {
    seznamKb: Math.round(JSON.stringify(data).length / 102.4) / 10,
    postav: data.postavy.length,
    vrstev: data.vrstvy.length,
    produktu: data.produkty.length
  };
}
