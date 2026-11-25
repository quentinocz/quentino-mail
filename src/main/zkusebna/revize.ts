import crypto from 'crypto';
import fs from 'fs';
import { getDb, getSetting, setSetting } from '../db';
import { rozbal, zabal, ZipPolozka } from '../zip';
import { ZK_SABLONY, ZK_VRSTVY, ZkVrstva, ZkVrstvaTyp } from '../../shared/zkusebna';
import { nacti } from './png';
import * as px from './pixely';
import * as store from './store';
import * as sablony from './sablony';
import { kabina } from './manifest';
import { proKabinu, dekoduj, nahraneLatky } from './produkty';
import { kabinaScript } from '../kabina/script';
import * as obrazky from './obrazky';

/**
 * Revize podkladů kabiny — export a zpětný import.
 *
 * Patrik (23. 11.): „funguje to vcelku, ale výsledek nevypadá dobře,
 * vypadá to nedotažené, kostrbaté… co kdybys udělal nějaký export těch
 * podkladů do nějaké formy, kterou budeš schopen zrevidovat a upravit".
 *
 * ## Co je v exportu
 *
 * Všechno, z čeho se model v kabině skládá, **ve stejné podobě, jak to
 * leží v aplikaci** — vrstvy (mapy světla i kov), původní obrázky postav
 * od modelu, změřené a ručně posunuté body, vzorky látek a co o nich
 * víme (centimetry, měřítko, co poznala AI), k tomu fotky sad. A celá
 * kabina k spuštění (`kabina/index.html`): tentýž skript, tentýž seznam,
 * jen s adresami do exportu. Revize tak vidí přesně to, co zákazník,
 * a může to bez aplikace překreslit, porovnat a vyladit.
 *
 * ## Co jde zpátky
 *
 * Upravený ZIP se stejnou stavbou. Načte se jen to, co se změnilo:
 * vrstvy (musí mít rozměr postavy), vzorky, a v `revize.json` čísla —
 * centimetry vzorku, měřítko, barva, varianta, body postavy. Ručně
 * upravené šablony se pak při hromadném překreslení nepřepíšou.
 */

export const VERZE_REVIZE = 1;

const bezpecne = (text: string) => String(text).replace(/[^\w.~-]+/g, '_');
const otisk = (data: Buffer) => crypto.createHash('sha1').update(data).digest('hex');

function obrazZData(data: string): Buffer | null {
  const shoda = /^data:image\/png;base64,(.+)$/.exec(data || '');
  return shoda ? Buffer.from(shoda[1], 'base64') : null;
}

function cestaVrstvyVExportu(v: Pick<ZkVrstva, 'postava' | 'typ' | 'varianta'>, kov = false): string {
  return `vrstvy/${bezpecne(v.postava)}/${v.typ}-${v.varianta}${kov ? '-kov' : ''}.png`;
}

function fotkyProduktu(kod: string): string[] {
  try {
    const row = getDb().prepare('SELECT image, images FROM products WHERE code = ?').get(kod) as { image?: string; images?: string } | undefined;
    const vse = [row?.image ?? '', ...String(row?.images ?? '').split('\n')].map(one => one.trim()).filter(Boolean);
    return [...new Set(vse)].slice(0, 3);
  } catch { return []; }
}

const README = `Quentino — podklady zkušební kabiny k revizi
==============================================

revize.json      postavy (rozměry, body), vrstvy (stav, okraje, zadání),
                 produkty (varianta, barva, vzorekCm, měřítko, sady, AI)
vrstvy/          vrstvy po postavách: mapy světla (šedá 128 = látka),
                 *-kov.png = kov kšand ve skutečné barvě, postava-zaklad.png
kroky/           původní obrázek postavy od modelu (před vyříznutím)
vzorky/          vzorky látek: <kód>.png, další kus sady <kód>~<pořadí>.png
fotky/           fotky sad a kusů ke kontrole z e-shopu
kabina/          spustitelná kabina — podávat přes http z kořene exportu
                 (např. python3 -m http.server) a otevřít /kabina/index.html

Zpátky do aplikace: upravené soubory nechat na stejných místech, ZIP
a v aplikaci Zkušební kabina → Nastavení → Revize podkladů → Načíst.
Vrstvy musí mít přesně rozměr své postavy. V revize.json se načtou
změněné hodnoty u produktů (vzorekCm, meritko, hex, varianta) a v
"kotvy" ruční body postav.
`;

export interface ExportVysledek { soubor: string; souboru: number; megabajtu: number }

/**
 * Sestaví ZIP s podklady. `postavy` prázdné = všechny.
 */
export async function exportuj(cil: string, moznosti: { postavy?: string[]; fotky?: boolean } = {}): Promise<ExportVysledek> {
  const polozky: ZipPolozka[] = [];
  const pridej = (jmeno: string, data: Buffer | string) =>
    polozky.push({ jmeno, data: typeof data === 'string' ? Buffer.from(data, 'utf8') : data });

  const vybrane = new Set(moznosti.postavy?.filter(Boolean) ?? []);
  const postavy = store.postavy().filter(one => !vybrane.size || vybrane.has(one.id));
  const idPostav = new Set(postavy.map(one => one.id));

  /* Vrstvy a původní obrázky postav */
  const vrstvy = store.vrstvy().filter(one => idPostav.has(one.postava));
  for (const v of vrstvy) {
    if (v.soubor && fs.existsSync(v.soubor)) pridej(cestaVrstvyVExportu(v), fs.readFileSync(v.soubor));
    if (v.kov && fs.existsSync(v.kov)) pridej(cestaVrstvyVExportu(v, true), fs.readFileSync(v.kov));
  }
  for (const p of postavy) {
    for (const k of store.kroky(p.id)) {
      if (k.soubor && fs.existsSync(k.soubor)) {
        pridej(`kroky/${bezpecne(p.id)}/${String(k.poradi).padStart(2, '0')}-${k.typ}.png`, fs.readFileSync(k.soubor));
      }
    }
  }

  /* Produkty: vzorky jako soubory, čísla do revize.json */
  const katalog = new Map(proKabinu(1000, true).map(one => [one.kod, one]));
  const vzorkySoubory: Record<string, { kod: string; cast: number }> = {};
  const produkty = store.produktyRows().filter(one => one.typ).map(row => {
    const p = katalog.get(row.kod);
    const hlavni = obrazZData(row.vzorek);
    if (hlavni) {
      const jmeno = `vzorky/${bezpecne(row.kod)}.png`;
      pridej(jmeno, hlavni);
      vzorkySoubory[jmeno] = { kod: row.kod, cast: -1 };
    }
    (row.casti ?? []).forEach((c, i) => {
      const data = obrazZData(c.vzorek);
      if (!data) return;
      const jmeno = `vzorky/${bezpecne(row.kod)}~${i}.png`;
      pridej(jmeno, data);
      vzorkySoubory[jmeno] = { kod: row.kod, cast: i };
    });
    return {
      kod: row.kod, nazev: p?.nazev ?? '', url: p?.url ?? '', obrazek: p?.obrazek ?? '', fotky: fotkyProduktu(row.kod),
      typ: row.typ, varianta: row.varianta, hex: row.hex, vzorekCm: row.vzorekCm ?? 0, meritko: row.meritko ?? 1,
      rucne: row.rucne, schvaleno: row.schvaleno, kontrola: row.kontrola ?? '', proVek: p?.proVek,
      casti: (row.casti ?? []).map(c => ({ typ: c.typ, varianta: c.varianta, hex: c.hex, vzorekCm: c.vzorekCm ?? 0 })),
      ai: row.ai ?? null
    };
  });

  /* Fotky sad a kusů, které AI viděla jinak — na nich se kontroluje látka */
  if (moznosti.fotky !== false) {
    const sFotkou = produkty.filter(one => one.casti.length || one.kontrola || one.ai);
    for (const p of sFotkou.slice(0, 60)) {
      for (let i = 0; i < p.fotky.length; i++) {
        try {
          const odpoved = await fetch(p.fotky[i]);
          if (!odpoved.ok) continue;
          const data = Buffer.from(await odpoved.arrayBuffer());
          const pripona = /\.png($|\?)/i.test(p.fotky[i]) ? 'png' : /\.webp($|\?)/i.test(p.fotky[i]) ? 'webp' : 'jpg';
          pridej(`fotky/${bezpecne(p.kod)}-${i}.${pripona}`, data);
        } catch { /* fotka, která se nestáhne, revizi nezastaví */ }
      }
    }
  }

  /* Body postav: změřené i ruční */
  const postavyInfo = postavy.map(p => {
    let kotvy = null;
    try { kotvy = sablony.kotvyPostavy(p.id)?.kotvy ?? null; } catch { /* bez postavy nic */ }
    return { ...p, kotvy, rucneKotvy: sablony.rucneKotvy(p.id) };
  });

  pridej('revize.json', JSON.stringify({
    verze: VERZE_REVIZE,
    kdy: new Date().toISOString(),
    model: obrazky.model().id,
    kvalita: getSetting('obrazkyKvalita', 'high'),
    sablony: ZK_SABLONY,
    katalogVrstev: ZK_VRSTVY.map(one => ({ typ: one.typ, nazev: one.nazev, zbozi: one.zbozi, sablona: !!one.sablona, varianty: one.varianty })),
    postavy: postavyInfo,
    vrstvy: vrstvy.map(v => ({
      postava: v.postava, typ: v.typ, varianta: v.varianta, stav: v.stav, potiz: v.potiz, zadani: v.zadani,
      okraje: v.okraje, podil: v.podil, kdy: v.kdy,
      soubor: v.soubor ? cestaVrstvyVExportu(v) : '', kov: v.kov ? cestaVrstvyVExportu(v, true) : ''
    })),
    produkty,
    vzorky: vzorkySoubory,
    vykresleni: store.vykresleni().map(v => ({ ...v, soubor: '', nahled: '' })),
    /* Sem se při revizi píšou ruční body: { "dospely-bezny": { "limec": [0.5, 0.15] } } */
    kotvy: Object.fromEntries(postavy.map(p => [p.id, sablony.rucneKotvy(p.id)]))
  }, null, 2));

  /* Spustitelná kabina s adresami do exportu */
  const data = kabina(
    (v, kov) => (kov ? v.kov : v.soubor) ? `../${cestaVrstvyVExportu(v, kov)}` : '',
    1000,
    {
      vzorek: (_vzorek, klic) => {
        const [kod, cast] = klic.split('~');
        return `../vzorky/${bezpecne(kod)}${cast !== undefined ? `~${cast}` : ''}.png`;
      },
      /* Produkty vykreslené na modelu jdou do exportu taky — revize vidí, co zákazník */
      vykresleni: (soubor, klic) => {
        if (!fs.existsSync(soubor)) return '';
        const jmeno = `vykresleni/${klic.split('/').map(bezpecne).join('/')}.png`;
        pridej(jmeno, fs.readFileSync(soubor));
        return `../${jmeno}`;
      }
    }
  );
  data.postavy = data.postavy.filter(one => idPostav.has(one.id));
  data.vrstvy = data.vrstvy.filter(one => idPostav.has(one.postava));
  pridej('kabina/data.json', JSON.stringify(data));
  pridej('kabina/kabina.js', kabinaScript({ zdroj: 'data.json', ttl: 30 }));
  pridej('kabina/index.html', '<!doctype html><html lang="cs"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1"><title>Kabina — revize</title></head>'
    + '<body><script src="kabina.js"></script><script>window.quentinoKabina.otevri(null);</script></body></html>');
  pridej('README.txt', README);

  const zip = zabal(polozky);
  fs.writeFileSync(cil, zip);
  return { soubor: cil, souboru: polozky.length, megabajtu: Math.round(zip.length / 104857.6) / 10 };
}

export interface ImportVysledek {
  vrstev: number;
  vzorku: number;
  produktu: number;
  kotev: number;
  preskoceno: string[];
}

/**
 * Načte upravený ZIP. Jen změny — co je stejné jako v aplikaci, se přeskočí.
 */
export function importuj(zdroj: string): ImportVysledek {
  const polozky = rozbal(fs.readFileSync(zdroj));
  /* Finder rád obalí obsah složkou: najde se revize.json a od něj se počítá */
  const kotva = polozky.find(one => /(^|\/)revize\.json$/.test(one.jmeno));
  const koren = kotva ? kotva.jmeno.replace(/revize\.json$/, '') : '';
  const soubory = new Map(polozky.filter(one => one.jmeno.startsWith(koren)).map(one => [one.jmeno.slice(koren.length), one.data]));
  let revize: any = {};
  if (kotva) {
    try { revize = JSON.parse(kotva.data.toString('utf8')); } catch { throw new Error('revize.json se nedá přečíst — není to platný JSON.'); }
  }
  const vysledek: ImportVysledek = { vrstev: 0, vzorku: 0, produktu: 0, kotev: 0, preskoceno: [] };
  const kdy = new Date().toISOString();
  const den = kdy.slice(0, 10);

  /* Vrstvy */
  const postavyPodleJmena = new Map(store.postavy().map(one => [bezpecne(one.id), one]));
  for (const [jmeno, data] of soubory) {
    const shoda = /^vrstvy\/([^/]+)\/([a-z]+)-(.+?)(-kov)?\.png$/.exec(jmeno);
    if (!shoda) continue;
    const postava = postavyPodleJmena.get(shoda[1]);
    const typ = shoda[2] as ZkVrstvaTyp;
    const varianta = shoda[3];
    const kov = !!shoda[4];
    if (!postava) { vysledek.preskoceno.push(`${jmeno}: postava v aplikaci není`); continue; }
    const def = ZK_VRSTVY.find(one => one.typ === typ);
    if (!def || !(def.varianty.some(one => one.id === varianta) || typ === 'postava')) {
      vysledek.preskoceno.push(`${jmeno}: takovou vrstvu kabina nezná`); continue;
    }
    let obraz;
    try { obraz = nacti(data); } catch { vysledek.preskoceno.push(`${jmeno}: není PNG`); continue; }
    if (obraz.sirka !== postava.sirka || obraz.vyska !== postava.vyska) {
      vysledek.preskoceno.push(`${jmeno}: rozměr ${obraz.sirka}×${obraz.vyska}, postava má ${postava.sirka}×${postava.vyska}`);
      continue;
    }
    const stara = store.vrstvy(postava.id).find(one => one.typ === typ && one.varianta === varianta);
    const cesta = kov
      ? store.cestaVrstvy(postava.id, typ, varianta).replace(/\.png$/, '-kov.png')
      : store.cestaVrstvy(postava.id, typ, varianta);
    const puvodni = kov ? stara?.kov : stara?.soubor;
    if (puvodni && fs.existsSync(puvodni) && otisk(fs.readFileSync(puvodni)) === otisk(data)) continue;
    fs.writeFileSync(cesta, data);
    if (kov) {
      if (!stara) { vysledek.preskoceno.push(`${jmeno}: kov bez vrstvy, ke které patří`); continue; }
      store.zapisVrstvu({ ...stara, kov: cesta, zadani: stara.zadani.startsWith(sablony.REVIZE) ? stara.zadani : `${sablony.REVIZE} ${den} — ${stara.zadani}` });
    } else {
      const maska = new Uint8Array(obraz.sirka * obraz.vyska);
      for (let i = 0; i < maska.length; i++) maska[i] = obraz.body[i * 4 + 3] > 128 ? 255 : 0;
      const kde = px.okraje(maska, obraz.sirka, obraz.vyska);
      const zaklad = store.vrstvy(postava.id).find(one => one.typ === 'postava');
      store.zapisVrstvu({
        postava: postava.id, typ, varianta, soubor: cesta, url: '',
        sirka: obraz.sirka, vyska: obraz.vyska,
        podil: zaklad?.podil ? kde.podil / zaklad.podil : kde.podil,
        okraje: { x: kde.x, y: kde.y, w: kde.w, h: kde.h },
        /* Schválená zůstává schválená — revize ji jen dotáhla */
        stav: stara?.stav === 'schvaleno' ? 'schvaleno' : 'hotovo', potiz: '',
        zadani: `${sablony.REVIZE} ${den}${stara?.zadani ? ` — ${stara.zadani.replace(new RegExp(`^${sablony.REVIZE} \\S+ — `), '')}` : ''}`,
        kdy, kov: stara?.kov
      });
    }
    vysledek.vrstev += 1;
  }

  /* Vzorky látek */
  const mapaVzorku: Record<string, { kod: string; cast: number }> = revize.vzorky ?? {};
  const nahrane = nahraneLatky();
  const rows = new Map(store.produktyRows().map(one => [one.kod, one]));
  const zmenene = new Set<string>();
  for (const [jmeno, data] of soubory) {
    if (!/^vzorky\/.+\.png$/.test(jmeno)) continue;
    let cil = mapaVzorku[jmeno];
    if (!cil) {
      const s = /^vzorky\/(.+?)(?:~(\d+))?\.png$/.exec(jmeno)!;
      cil = { kod: s[1], cast: s[2] !== undefined ? Number(s[2]) : -1 };
    }
    const row = rows.get(cil.kod);
    if (!row) { vysledek.preskoceno.push(`${jmeno}: produkt ${cil.kod} v kabině není`); continue; }
    try { dekoduj(data); } catch { vysledek.preskoceno.push(`${jmeno}: není obrázek`); continue; }
    const uri = `data:image/png;base64,${data.toString('base64')}`;
    if (cil.cast < 0) {
      if (row.vzorek === uri) continue;
      row.vzorek = uri;
    } else {
      const c = row.casti?.[cil.cast];
      if (!c) { vysledek.preskoceno.push(`${jmeno}: sada nemá kus ${cil.cast}`); continue; }
      if (c.vzorek === uri) continue;
      c.vzorek = uri;
    }
    nahrane.add(cil.cast < 0 ? cil.kod : `${cil.kod}~${cil.cast}`);
    zmenene.add(cil.kod);
    vysledek.vzorku += 1;
  }

  /* Čísla produktů z revize.json */
  for (const p of Array.isArray(revize.produkty) ? revize.produkty : []) {
    const row = rows.get(String(p?.kod ?? ''));
    if (!row) continue;
    let zmena = false;
    const cislo = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const cm = cislo(p.vzorekCm);
    if (cm !== null && Math.abs(cm - (row.vzorekCm ?? 0)) > 1e-6) { row.vzorekCm = cm; zmena = true; }
    const meritko = cislo(p.meritko);
    if (meritko !== null && Math.abs(meritko - (row.meritko ?? 1)) > 1e-6) { row.meritko = Math.max(0.3, Math.min(3, meritko)); zmena = true; }
    if (typeof p.hex === 'string' && /^#[0-9a-f]{6}$/i.test(p.hex) && p.hex.toLowerCase() !== String(row.hex).toLowerCase()) {
      row.hex = p.hex.toLowerCase(); row.rucne = true; zmena = true;
    }
    if (typeof p.varianta === 'string' && p.varianta && p.varianta !== row.varianta
      && ZK_VRSTVY.some(d => d.typ === row.typ && d.varianty.some(v => v.id === p.varianta))) {
      row.varianta = p.varianta; row.variantaRucne = true; zmena = true;
    }
    if (Array.isArray(p.casti)) {
      p.casti.forEach((c: any, i: number) => {
        const mam = row.casti?.[i];
        if (!mam) return;
        const ccm = cislo(c?.vzorekCm);
        if (ccm !== null && Math.abs(ccm - (mam.vzorekCm ?? 0)) > 1e-6) { mam.vzorekCm = ccm; zmena = true; }
        if (typeof c?.hex === 'string' && /^#[0-9a-f]{6}$/i.test(c.hex) && c.hex.toLowerCase() !== mam.hex.toLowerCase()) { mam.hex = c.hex.toLowerCase(); zmena = true; }
      });
    }
    if (zmena) { zmenene.add(row.kod); vysledek.produktu += 1; }
  }
  for (const kod of zmenene) store.zapisProdukt(rows.get(kod)!);
  setSetting('zkNahraneLatky', JSON.stringify([...nahrane]));

  /* Ruční body postav — šablony se po nich překreslí */
  for (const [id, rucne] of Object.entries(revize.kotvy ?? {})) {
    const postava = store.postava(id);
    if (!postava || !rucne || typeof rucne !== 'object') continue;
    const ted = sablony.rucneKotvy(id);
    if (JSON.stringify(ted) === JSON.stringify(rucne)) continue;
    sablony.ulozRucneKotvy(id, Object.keys(rucne as object).length ? rucne as sablony.KotvyRucne : null);
    try { sablony.vygenerujSablony(id, undefined, false); } catch { /* bez postavy se nepřekreslí */ }
    vysledek.kotev += 1;
  }
  /*
   * Šablony se po načtení překreslí podle současného kódu — kotvy, kapsa
   * na saku i límec se mohly změnit s novými vrstvami. Ručně upravené
   * šablony zůstávají (prepsatRevize = false).
   */
  if (vysledek.vrstev || vysledek.kotev) {
    for (const p of store.postavy().filter(one => one.hotovo)) {
      try { sablony.vygenerujSablony(p.id, undefined, false); } catch { /* postava bez obrázku se přeskočí */ }
    }
  }
  setSetting('zkRevizeNactena', kdy);
  return vysledek;
}
