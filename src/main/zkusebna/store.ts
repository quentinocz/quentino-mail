import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { getDb } from '../db';
import {
  ZkPostava, ZkVrstva, ZkVrstvaTyp, ZkVek, ZkTelo, ZK_VEKY, ZK_VRSTVY, postavaId
} from '../../shared/zkusebna';

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

function postavaDir(id: string, co: 'vrstvy' | 'kroky'): string {
  const dir = path.join(zkDir(), id, co);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function cestaVrstvy(postava: string, typ: ZkVrstvaTyp, varianta: string): string {
  return path.join(postavaDir(postava, 'vrstvy'), `${typ}-${varianta}.png`);
}

export function cestaKroku(postava: string, poradi: number, typ: string): string {
  return path.join(postavaDir(postava, 'kroky'), `${String(poradi).padStart(2, '0')}-${typ}.png`);
}

/* ---------------------------------------------------------------- postavy */

/**
 * Postavy, které kabina má mít.
 *
 * Je jich **devět**: tři věky krát tři těla. Výška se dělá měřítkem, ne
 * vlastní kresbou — jinak by jich bylo šedesát a rozdíl mezi nimi by
 * nikdo nepoznal. Kojenec má jen jedno tělo: hubené a silné miminko je
 * rozdíl, který na obrázku v obleku nikdo neuvidí, a jsou to tři obrázky
 * k ničemu.
 */
export function chystanePostavy(): { vek: ZkVek; telo: ZkTelo }[] {
  const out: { vek: ZkVek; telo: ZkTelo }[] = [];
  for (const vek of ['dospely', 'dite', 'kojenec'] as ZkVek[]) {
    const tela: ZkTelo[] = vek === 'kojenec' ? ['bezny'] : ['hubeny', 'bezny', 'silny'];
    for (const telo of tela) out.push({ vek, telo });
  }
  return out;
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
    kdy: row.kdy
  }));
}

export function zapisVrstvu(v: ZkVrstva): void {
  getDb().prepare(
    `INSERT INTO zk_vrstvy (postava, typ, varianta, soubor, url, sirka, vyska, podil, okraje, stav, potiz, zadani, kdy)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(postava, typ, varianta) DO UPDATE SET
       soubor = excluded.soubor, url = excluded.url, sirka = excluded.sirka, vyska = excluded.vyska,
       podil = excluded.podil, okraje = excluded.okraje, stav = excluded.stav,
       potiz = excluded.potiz, zadani = excluded.zadani, kdy = excluded.kdy`
  ).run(v.postava, v.typ, v.varianta, v.soubor, v.url, v.sirka, v.vyska, v.podil,
    JSON.stringify(v.okraje), v.stav, v.potiz, v.zadani, v.kdy || new Date().toISOString());
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
  rucne: boolean;
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
    rucne: !!row.rucne,
    velikosti: !!row.velikosti,
    schvaleno: !!row.schvaleno
  }));
}

export function zapisProdukt(row: ZkProduktRow): void {
  getDb().prepare(
    `INSERT INTO zk_produkty (kod, typ, varianta, hex, vzorek, rucne, velikosti, schvaleno, kdy)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(kod) DO UPDATE SET
       typ = excluded.typ, varianta = excluded.varianta, hex = excluded.hex,
       vzorek = excluded.vzorek, rucne = excluded.rucne, velikosti = excluded.velikosti,
       schvaleno = excluded.schvaleno, kdy = excluded.kdy`
  ).run(row.kod, row.typ, row.varianta, row.hex, row.vzorek ?? '', row.rucne ? 1 : 0,
    row.velikosti ? 1 : 0, row.schvaleno ? 1 : 0, new Date().toISOString());
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
