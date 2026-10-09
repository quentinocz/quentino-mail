import {
  ZkVrstva, ZK_BARVY, ZK_PORADI, ZK_TELA, ZK_VEKY, ZK_VLASY, ZK_VRSTVY, vychoziVzhled
} from '../../shared/zkusebna';
import * as store from './store';
import { proKabinu } from './produkty';

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
  }[];
  vrstvy: { postava: string; typ: string; varianta: string; url: string }[];
  produkty: ReturnType<typeof proKabinu>;
  katalog: {
    poradi: string[];
    vrstvy: {
      typ: string; nazev: string; popis: string;
      barvitelna: boolean; nepovinna: boolean;
      varianty: { id: string; nazev: string }[];
    }[];
    barvy: { id: string; nazev: string; hex: string }[];
    vlasy: { id: string; nazev: string; hex: string }[];
    veky: { id: string; nazev: string; popis: string; vyska: [number, number] }[];
    tela: { id: string; nazev: string; popis: string }[];
    vychozi: ReturnType<typeof vychoziVzhled>;
  };
}

/**
 * Postaví seznam pro kabinu.
 *
 * `adresa` říká, kde vrstva leží — na e-shopu je to veřejná adresa
 * z úložiště, v náhledu v aplikaci vlastní adresa, kterou obsluhuje
 * hlavní proces. Je to jediný rozdíl mezi náhledem a ostrým provozem,
 * takže se v aplikaci opravdu zkouší tentýž skript.
 */
export function kabina(adresa: (v: ZkVrstva) => string, produktu = 400): Kabina {
  const hotove = store.vrstvy().filter(one => one.stav === 'hotovo' || one.stav === 'schvaleno');
  const maPostavu = new Set(
    hotove.filter(one => one.typ === 'postava').map(one => one.postava)
  );
  return {
    verze: 1,
    kdy: new Date().toISOString(),
    postavy: store.postavy()
      .filter(one => one.hotovo && maPostavu.has(one.id))
      .map(one => ({
        id: one.id, vek: one.vek, telo: one.telo, vyskaCm: one.vyskaCm,
        sirka: one.sirka, vyska: one.vyska, temeno: one.temeno, podrazka: one.podrazka
      })),
    vrstvy: hotove
      .filter(one => maPostavu.has(one.postava))
      .map(one => ({ postava: one.postava, typ: one.typ, varianta: one.varianta, url: adresa(one) }))
      .filter(one => !!one.url),
    produkty: proKabinu(produktu),
    katalog: {
      poradi: [...ZK_PORADI],
      vrstvy: ZK_VRSTVY.map(one => ({
        typ: one.typ, nazev: one.nazev, popis: one.popis,
        barvitelna: one.barvitelna, nepovinna: one.nepovinna,
        varianty: one.varianty
      })),
      barvy: ZK_BARVY,
      vlasy: ZK_VLASY,
      veky: (Object.keys(ZK_VEKY) as (keyof typeof ZK_VEKY)[]).map(id => ({
        id, nazev: ZK_VEKY[id].nazev, popis: ZK_VEKY[id].popis, vyska: ZK_VEKY[id].vyska
      })),
      tela: (Object.keys(ZK_TELA) as (keyof typeof ZK_TELA)[]).map(id => ({
        id, nazev: ZK_TELA[id].nazev, popis: ZK_TELA[id].popis
      })),
      vychozi: vychoziVzhled('dospely')
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
