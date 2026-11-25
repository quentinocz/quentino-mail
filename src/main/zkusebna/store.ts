import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { getDb } from '../db';
import {
  ZkPostava, ZkVrstva, ZkVrstvaTyp, ZkVek, ZkTelo, ZK_VEKY, ZK_VRSTVY, postavaId
} from '../../shared/zkusebna';
import type { ZkCast, ZkRozpoznani } from '../../shared/zkusebna';

/**
 * Čtení a zápis zkušební kabiny.
 *
 * Obrázky leží na disku, v tabulce je k nim jen cesta — vrstev je pro
 * všechny postavy skoro dvě stě a v databázi, která se zálohuje a
 * synchronizuje, by to byla desetkrát větší záloha kvůli datům, která se
 * dají vygenerovat znovu.
 */

export function zkDir(): string {
  const dir = path.join(app.getPath('userData'), 'zkusebna');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function postavaDir(id: string, co: 'vrstvy' | 'kroky' | 'vykresleni'): string {
  const dir = path.join(zkDir(), id, co);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function cestaVrstvy(postava: string, typ: ZkVrstvaTyp, varianta: string): string {
  return path.join(postavaDir(postava, 'vrstvy'), `${typ}-${varianta}.png`);
}

export function cestaVykresleni(postava: string, kod: string, cast: number, nahled = false): string {
  const jmeno = `${String(kod).replace(/[^\w.-]+/g, '_')}${cast >= 0 ? `~${cast}` : ''}${nahled ? '-nahled' : ''}.png`;
  return path.join(postavaDir(postava, 'vykresleni'), jmeno);
}

export interface ZkVykresleniRow {
  kod: string; cast: number; postava: string; typ: string; varianta: string;
  soubor: string; nahled: string; x: number; y: number; w: number; h: number;
  stav: 'ceka' | 'hotovo' | 'nesedi' | 'schvaleno' | 'zamitnuto'; potiz: string; model: string; kdy: string;
}

export function vykresleni(kod?: string): ZkVykresleniRow[] {
  const rows = kod
    ? getDb().prepare('SELECT * FROM zk_vykresleni WHERE kod = ?').all(kod)
    : getDb().prepare('SELECT * FROM zk_vykresleni').all();
  return (rows as any[]).map(({ dil, ...r }) => ({ ...r, cast: Number(dil) }));
}

export function zapisVykresleni(v: ZkVykresleniRow): void {
  getDb().prepare(
    `INSERT INTO zk_vykresleni (kod, dil, postava, typ, varianta, soubor, nahled, x, y, w, h, stav, potiz, model, kdy)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(kod, dil, postava) DO UPDATE SET
       typ = excluded.typ, varianta = excluded.varianta, soubor = excluded.soubor, nahled = excluded.nahled,
       x = excluded.x, y = excluded.y, w = excluded.w, h = excluded.h, stav = excluded.stav,
       potiz = excluded.potiz, model = excluded.model, kdy = excluded.kdy`
  ).run(v.kod, v.cast, v.postava, v.typ, v.varianta, v.soubor, v.nahled, v.x, v.y, v.w, v.h, v.stav, v.potiz, v.model, v.kdy);
}

export function nastavStavVykresleni(kod: string, cast: number, postava: string, stav: ZkVykresleniRow['stav']): void {
  getDb().prepare('UPDATE zk_vykresleni SET stav = ? WHERE kod = ? AND dil = ? AND postava = ?').run(stav, kod, cast, postava);
}

export function cestaKroku(postava: string, poradi: number, typ: string): string {
  return path.join(postavaDir(postava, 'kroky'), `${String(poradi).padStart(2, '0')}-${typ}.png`);
}

/* ---------------------------------------------------------------- postavy */

/**
 * Postavy, které kabina má mít.
 *
 * Tři: dospělý, dítě, kojenec. Bývalo jich devět (tři věky krát tři
 * těla) a k tomu každá ve třech účesech a čtyřech vousech — dohromady
 * přes dvě stě obrázků, které se musely povést všechny. Rozdíl mezi
 * „hubeným" a „silným" dospělým přitom na obrázku v obleku nikdo
 * nepozná a zákazník si stejně vybírá kravatu, ne modela.
 *
 * Výška se dělá měřítkem, ne vlastní kresbou. Postava je jedna a
 * postavy v kabině se liší jen tím, jak je vysoká.
 */
export function chystanePostavy(): { vek: ZkVek; telo: ZkTelo }[] {
  return (['dospely', 'dite', 'kojenec'] as ZkVek[]).map(vek => ({ vek, telo: 'bezny' as ZkTelo }));
}

/** Rozměr plátna. Na výšku, protože postava stojí. */
export const PLATNO = { sirka: 1024, vyska: 1536 };

export function postavy(): ZkPostava[] {
  const rows = getDb().prepare('SELECT * FROM zk_postavy').all() as any[];
  const mapa = new Map(rows.map(one => [one.id, one]));
  return chystanePostavy().map(({ vek, telo }) => {
    const id = postavaId(vek, telo);
    const row = mapa.get(id);
    const stredniVyska = Math.round((ZK_VEKY[vek].vyska[0] + ZK_VEKY[vek].vyska[1]) / 2);
    return {
      id,
      vek,
      telo,
      vyskaCm: row?.vyska_cm ?? stredniVyska,
      sirka: row?.sirka ?? PLATNO.sirka,
      vyska: row?.vyska ?? PLATNO.vyska,
      temeno: row?.temeno ?? 0,
      podrazka: row?.podrazka ?? 0,
      hotovo: !!row?.hotovo
    };
  });
}

export function postava(id: string): ZkPostava | null {
  return postavy().find(one => one.id === id) ?? null;
}

export function zapisPostavu(p: ZkPostava, zadani = ''): void {
  getDb().prepare(
    `INSERT INTO zk_postavy (id, vek, telo, vyska_cm, sirka, vyska, temeno, podrazka, zadani, hotovo, kdy)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       vyska_cm = excluded.vyska_cm, sirka = excluded.sirka, vyska = excluded.vyska,
       temeno = excluded.temeno, podrazka = excluded.podrazka,
       zadani = excluded.zadani, hotovo = excluded.hotovo, kdy = excluded.kdy`
  ).run(p.id, p.vek, p.telo, p.vyskaCm, p.sirka, p.vyska, p.temeno, p.podrazka, zadani,
    p.hotovo ? 1 : 0, new Date().toISOString());
}

/* ----------------------------------------------------------------- vrstvy */

export function vrstvy(postavaId?: string): ZkVrstva[] {
  const rows = postavaId
    ? getDb().prepare('SELECT * FROM zk_vrstvy WHERE postava = ?').all(postavaId) as any[]
    : getDb().prepare('SELECT * FROM zk_vrstvy').all() as any[];
  return rows.map(row => ({
    postava: row.postava,
    typ: row.typ,
    varianta: row.varianta,
    soubor: row.soubor,
    url: row.url,
    sirka: row.sirka,
    vyska: row.vyska,
    podil: row.podil,
    okraje: row.okraje ? JSON.parse(row.okraje) : { x: 0, y: 0, w: 0, h: 0 },
    stav: row.stav,
    potiz: row.potiz,
    zadani: row.zadani,
    kdy: row.kdy,
    kov: row.kov || undefined
  }));
}

export function zapisVrstvu(v: ZkVrstva): void {
  getDb().prepare(
    `INSERT INTO zk_vrstvy (postava, typ, varianta, soubor, url, sirka, vyska, podil, okraje, stav, potiz, zadani, kdy, kov)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(postava, typ, varianta) DO UPDATE SET
       soubor = excluded.soubor, url = excluded.url, sirka = excluded.sirka, vyska = excluded.vyska,
       podil = excluded.podil, okraje = excluded.okraje, stav = excluded.stav,
       potiz = excluded.potiz, zadani = excluded.zadani, kdy = excluded.kdy, kov = excluded.kov`
  ).run(v.postava, v.typ, v.varianta, v.soubor, v.url, v.sirka, v.vyska, v.podil,
    JSON.stringify(v.okraje), v.stav, v.potiz, v.zadani, v.kdy || new Date().toISOString(), v.kov ?? '');
}

export function schval(postava: string, typ: ZkVrstvaTyp, varianta: string, ano: boolean): void {
  getDb().prepare(
    `UPDATE zk_vrstvy SET stav = ? WHERE postava = ? AND typ = ? AND varianta = ?`
  ).run(ano ? 'schvaleno' : 'hotovo', postava, typ, varianta);
}

export function nastavUrl(postava: string, typ: ZkVrstvaTyp, varianta: string, url: string): void {
  getDb().prepare(
    `UPDATE zk_vrstvy SET url = ? WHERE postava = ? AND typ = ? AND varianta = ?`
  ).run(url, postava, typ, varianta);
}

/* ------------------------------------------------------------------ kroky */

export function zapisKrok(postava: string, poradi: number, typ: string, soubor: string): void {
  getDb().prepare(
    `INSERT INTO zk_kroky (postava, poradi, typ, soubor) VALUES (?,?,?,?)
     ON CONFLICT(postava, poradi) DO UPDATE SET typ = excluded.typ, soubor = excluded.soubor`
  ).run(postava, poradi, typ, soubor);
}

/**
 * Zahodí všechno, co bylo nakreslené na předchozí podobu postavy.
 *
 * Vrstva je rozdíl dvou kroků **téhož obrázku** — na tom celé skládání
 * stojí. Když se postava nakreslí znovu, je to jiný člověk: jiná ramena,
 * jiný postoj, jiné světlo. Staré sako by na něm viselo o kus vedle a
 * nikdo by nepoznal proč, protože v okně by u něj svítilo „hotovo".
 * Proto se při přegenerování postavy zahodí i to, co se na ni oblékalo.
 */
export function zahodOblekani(postava: string): number {
  const db = getDb();
  const kolik = db.prepare(
    `SELECT COUNT(*) AS n FROM zk_vrstvy WHERE postava = ? AND typ <> 'postava'`
  ).get(postava) as { n: number } | undefined;
  db.prepare(`DELETE FROM zk_vrstvy WHERE postava = ? AND typ <> 'postava'`).run(postava);
  db.prepare('DELETE FROM zk_kroky WHERE postava = ? AND poradi > 0').run(postava);
  return kolik?.n ?? 0;
}

export function kroky(postava: string): { poradi: number; typ: string; soubor: string }[] {
  return getDb().prepare('SELECT poradi, typ, soubor FROM zk_kroky WHERE postava = ? ORDER BY poradi')
    .all(postava) as any[];
}

/** Obrázek, ze kterého se vychází při dokreslení dané vrstvy. */
export function krokPred(postava: string, typ: ZkVrstvaTyp): string {
  const poradi = ZK_VRSTVY.findIndex(one => one.typ === typ);
  const vse = kroky(postava);
  /*
   * Hledá se **nejbližší nižší** krok, který existuje. Nepovinné vrstvy
   * se nemusí generovat vůbec (kdo nechce kšandy, nemá je) a chybějící
   * krok nesmí celý řetěz zastavit.
   */
  let nej: { poradi: number; soubor: string } | null = null;
  for (const krok of vse) {
    if (krok.poradi >= poradi) continue;
    if (!krok.soubor || !fs.existsSync(krok.soubor)) continue;
    if (!nej || krok.poradi > nej.poradi) nej = krok;
  }
  return nej?.soubor ?? '';
}

/* --------------------------------------------------------------- produkty */

export interface ZkProduktRow {
  kod: string;
  typ: ZkVrstvaTyp | '';
  varianta: string;
  hex: string;
  /** Kousek látky z fotky jako `data:` adresa — vzor, ne jedna barva. */
  vzorek: string;
  /** Kolik centimetrů látky vzorek ukazuje (0 = neví se). */
  vzorekCm?: number;
  rucne: boolean;
  /** Variantu vybral člověk — katalog ji nepřepíše. */
  variantaRucne?: boolean;
  /** Další kusy sady, každý s vlastní látkou. */
  casti?: ZkCast[];
  /** Proč potřebuje kontrolu (sada, víc kusů na fotce). Prázdné = nepotřebuje. */
  kontrola?: string;
  /** Ruční doladění velikosti vzoru. */
  meritko?: number;
  /** Co na fotkách poznala AI. */
  ai?: ZkRozpoznani | null;
  velikosti: boolean;
  schvaleno: boolean;
}

export function produktyRows(): ZkProduktRow[] {
  const rows = getDb().prepare('SELECT * FROM zk_produkty').all() as any[];
  return rows.map(row => ({
    kod: row.kod,
    typ: row.typ,
    varianta: row.varianta,
    hex: row.hex,
    vzorek: row.vzorek ?? '',
    vzorekCm: Number(row.vzorek_cm) || 0,
    rucne: !!row.rucne,
    variantaRucne: !!row.varianta_rucne,
    casti: (() => { try { const c = JSON.parse(row.casti || '[]'); return Array.isArray(c) ? c : []; } catch { return []; } })(),
    kontrola: row.kontrola ?? '',
    meritko: Number(row.meritko) || 1,
    ai: (() => { try { return row.ai ? JSON.parse(row.ai) : null; } catch { return null; } })(),
    velikosti: !!row.velikosti,
    schvaleno: !!row.schvaleno
  }));
}

export function zapisProdukt(row: ZkProduktRow): void {
  getDb().prepare(
    `INSERT INTO zk_produkty (kod, typ, varianta, hex, vzorek, vzorek_cm, rucne, varianta_rucne, casti, kontrola, meritko,
       ai, velikosti, schvaleno, kdy)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(kod) DO UPDATE SET
       typ = excluded.typ, varianta = excluded.varianta, hex = excluded.hex,
       vzorek = excluded.vzorek, vzorek_cm = excluded.vzorek_cm, rucne = excluded.rucne,
       varianta_rucne = excluded.varianta_rucne, casti = excluded.casti, kontrola = excluded.kontrola,
       meritko = excluded.meritko, ai = excluded.ai, velikosti = excluded.velikosti,
       schvaleno = excluded.schvaleno, kdy = excluded.kdy`
  ).run(row.kod, row.typ, row.varianta, row.hex, row.vzorek ?? '', row.vzorekCm ?? 0, row.rucne ? 1 : 0,
    row.variantaRucne ? 1 : 0, row.casti?.length ? JSON.stringify(row.casti) : '', row.kontrola ?? '',
    row.meritko ?? 1, row.ai ? JSON.stringify(row.ai) : '', row.velikosti ? 1 : 0, row.schvaleno ? 1 : 0, new Date().toISOString());
}

/* --------------------------------------------------------------- vzhledy */

export function vzhledy(): { id: string; nazev: string; text: string; kdy: string }[] {
  return getDb().prepare('SELECT id, nazev, text, kdy FROM zk_vzhledy ORDER BY kdy DESC').all() as any[];
}

export function zapisVzhled(id: string, nazev: string, text: string): void {
  getDb().prepare(
    `INSERT INTO zk_vzhledy (id, nazev, text, kdy) VALUES (?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET nazev = excluded.nazev, text = excluded.text, kdy = excluded.kdy`
  ).run(id, nazev, text, new Date().toISOString());
}

export function smazVzhled(id: string): void {
  getDb().prepare('DELETE FROM zk_vzhledy WHERE id = ?').run(id);
}
