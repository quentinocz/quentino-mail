/**
 * Střih videa s titulky pro každý trh.
 *
 * ## Co to řeší
 *
 * Z jednoho natočeného záběru (nebo z několika kratších) má vzniknout reel
 * pro každý trh — stejný obraz, titulky v jazyce toho trhu, případně jiný
 * zvuk. Dělat to v cizím editoru znamená pětkrát ručně přepsat titulky,
 * pětkrát vyrenderovat a pětkrát si pohlídat, že se nespletl jazyk. Tohle
 * je přesně ta opakovaná práce, kterou má dělat program: časová osa se
 * nastaví jednou, texty se přeloží a videa se vykreslí na jeden klik.
 *
 * ## Proč se titulky kreslí v okně a ne ve ffmpegu
 *
 * ffmpeg umí vypálit titulky filtrem `subtitles` z `.ass`. Má to dvě
 * potíže, které se v praxi ukážou hned: **emoji** libass nakreslí jako
 * prázdné čtverečky (barevná emoji písma neumí spolehlivě dohledat) a
 * **náhled se rozchází s výsledkem**, protože okno kreslí titulek v CSS
 * a libass po svém. Kdo si v náhledu srovná text na dva řádky, dostane
 * ve videu tři.
 *
 * Proto titulky kreslí **okno na plátno** (Chromium umí barevná emoji
 * i lámání řádků) a sem přijdou hotové průhledné obrázky, které ffmpeg
 * jen přiloží na obraz filtrem `overlay`. Náhled a výsledek pak kreslí
 * tentýž kód, takže se nemohou rozejít.
 *
 * ## Jak se skládá obraz
 *
 * Záběry spojené střihem se slepí `concat`em, přechody mezi skupinami
 * dělá `xfade`. Zvuk se spojuje stejně (`acrossfade` tam, kde má obraz
 * přechod), jinak by po každém přechodu odešel o jeho délku napřed.
 * Časy titulků počítá `osa()` ze společného modulu — týž výpočet, jaký
 * v okně kreslí časovou osu.
 */
import { BrowserWindow, dialog } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { spawn, execFile } from 'child_process';
import { getDb, getSetting, setSetting } from '../db';
import { findFfmpeg } from '../media';
import { ask } from '../ai';
import { getSettings } from '../settings';
import * as store from './store';
import {
  osa, delkaVidea, klipyTrhu, zvukTrhu, textTitulku, potize,
  POMERY, PRECHODY, prazdnyProjekt, MIN_KLIP
} from '../../shared/videoedit';
import type {
  VidProjekt, VidKlip, VidTitulek, VidZvuk, VidZnelka, VidPomer
} from '../../shared/videoedit';

/* ---------- uložení projektu ---------- */

/**
 * Projekt se ukládá jako JSON k příspěvku.
 *
 * Rozepsat časovou osu do sloupců by znamenalo tři tabulky a migraci při
 * každé nové vlastnosti přechodu. Nic se v tom nevyhledává — vždycky se
 * čte celý projekt jednoho příspěvku — takže sloupce by nebyly k ničemu.
 */
export function projekt(postId: number): VidProjekt {
  const row = getDb().prepare('SELECT json FROM ig_video WHERE post_id = ?').get(postId) as any;
  if (!row?.json) return prazdnyProjekt(postId, zdrojovyJazyk());
  try {
    const p = JSON.parse(row.json) as VidProjekt;
    return { ...prazdnyProjekt(postId, zdrojovyJazyk()), ...p, postId };
  } catch {
    // Poškozený JSON nesmí zavřít celou obrazovku — radši prázdný projekt
    return prazdnyProjekt(postId, zdrojovyJazyk());
  }
}

export function saveProjekt(p: VidProjekt): VidProjekt {
  const cely: VidProjekt = { ...p, zmeneno: new Date().toISOString() };
  getDb().prepare(
    `INSERT INTO ig_video (post_id, json, updated_at) VALUES (?,?,datetime('now'))
     ON CONFLICT(post_id) DO UPDATE SET json = excluded.json, updated_at = datetime('now')`
  ).run(p.postId, JSON.stringify(cely));
  return cely;
}

function zdrojovyJazyk(): string {
  try {
    return store.sourceAccount()?.lang ?? 'CS';
  } catch {
    return 'CS';
  }
}

/* ---------- znělky ---------- */

const ZNELKY = 'igVideoZnelky';

/**
 * Znělky jsou videa, která se opakují u každého příspěvku — logo na
 * začátek, odkaz na e-shop na konec. Nahrávat je pokaždé znovu a znovu
 * hledat v Průzkumníku je práce, kterou stačí udělat jednou.
 */
export function znelky(): VidZnelka[] {
  try {
    const list = JSON.parse(getSetting(ZNELKY, '[]') ?? '[]');
    return Array.isArray(list) ? list.filter(z => z && z.soubor) : [];
  } catch {
    return [];
  }
}

function saveZnelky(list: VidZnelka[]): VidZnelka[] {
  setSetting(ZNELKY, JSON.stringify(list));
  return list;
}

export async function addZnelka(kam: VidZnelka['kam'] = 'kamkoli'): Promise<VidZnelka[]> {
  const okno = BrowserWindow.getFocusedWindow();
  const pick = await dialog.showOpenDialog(okno ?? undefined as any, {
    title: 'Video na začátek nebo na konec',
    properties: ['openFile'],
    filters: [{ name: 'Videa', extensions: ['mp4', 'mov', 'm4v', 'webm', 'avi', 'mkv'] }]
  });
  if (pick.canceled || pick.filePaths.length === 0) return znelky();

  const soubor = pick.filePaths[0];
  const info = await popis(soubor);
  const list = znelky();
  list.push({
    id: crypto.randomUUID(),
    nazev: path.basename(soubor, path.extname(soubor)),
    soubor,
    delka: info.delka,
    kam
  });
  povol(soubor);
  return saveZnelky(list);
}

export function saveZnelka(id: string, patch: Partial<VidZnelka>): VidZnelka[] {
  return saveZnelky(znelky().map(z => (z.id === id ? { ...z, ...patch, id: z.id } : z)));
}

export function removeZnelka(id: string): VidZnelka[] {
  return saveZnelky(znelky().filter(z => z.id !== id));
}

/* ---------- výběr souborů a jejich vlastnosti ---------- */

/**
 * Soubory, které se smí posílat do okna k přehrání.
 *
 * Okno si video nemůže přečíst samo (nemá přístup k disku) a posílat
 * padesátimegabajtové video přes IPC jako base64 by sežralo paměť.
 * Servíruje se proto vlastním protokolem — a ten smí vydat jen soubor,
 * který si uživatel v aplikaci sám vybral. Jinak by stačila chyba
 * v okně a šel by přes něj přečíst kterýkoli soubor v počítači.
 */
const povolene = new Set<string>();

export function povol(soubor: string): void {
  if (soubor) povolene.add(path.resolve(soubor));
}

export function jePovolen(soubor: string): boolean {
  return povolene.has(path.resolve(soubor));
}

/** Po otevření projektu se povolí, co v něm už je — jinak by náhled zůstal prázdný. */
export function povolProjekt(p: VidProjekt): void {
  for (const k of p.klipy) povol(k.soubor);
  for (const t of Object.values(p.trhy ?? {})) {
    for (const k of t.klipy ?? []) povol(k.soubor);
    if (t.zvuk?.soubor) povol(t.zvuk.soubor);
  }
  for (const h of Object.values(p.hotovo ?? {})) povol(h.soubor);
  for (const z of znelky()) povol(z.soubor);
}

export interface VidPopis {
  soubor: string;
  delka: number;
  sirka: number;
  vyska: number;
  /** Má soubor zvukovou stopu? Bez toho by `atrim` spadl na neexistující stopě. */
  zvuk: boolean;
}

/**
 * Vlastnosti souboru se čtou z výpisu `ffmpeg -i`, ne z ffprobe.
 *
 * ffprobe bývá vedle ffmpegu, ale ne vždycky — a spolehnout se na druhý
 * program znamená, že polovina funkce spadne u někoho, kdo má jen ffmpeg.
 * Výpis `-i` obsahuje všechno potřebné a formát se nemění.
 */
export async function popis(soubor: string): Promise<VidPopis> {
  const tool = await findFfmpeg();
  if (!tool.ok) throw new Error(tool.note);
  povol(soubor);

  const text = await new Promise<string>(resolve => {
    execFile(tool.path, ['-hide_banner', '-i', soubor], { timeout: 20_000, maxBuffer: 4 << 20 },
      (_err, _out, stderr) => resolve(String(stderr ?? '')));
  });

  const d = /Duration:\s*(\d+):(\d\d):(\d\d(?:\.\d+)?)/.exec(text);
  const delka = d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0;
  const v = /Stream #\d+:\d+[^\n]*: Video:[^\n]*?,\s*(\d{2,5})x(\d{2,5})/.exec(text);
  if (!v && delka === 0) {
    throw new Error(`Soubor „${path.basename(soubor)}" se nepodařilo přečíst jako video.`);
  }
  return {
    soubor,
    delka,
    sirka: v ? Number(v[1]) : 0,
    vyska: v ? Number(v[2]) : 0,
    zvuk: /Stream #\d+:\d+[^\n]*: Audio:/.test(text)
  };
}

export async function pickKlipy(): Promise<VidPopis[]> {
  const okno = BrowserWindow.getFocusedWindow();
  const pick = await dialog.showOpenDialog(okno ?? undefined as any, {
    title: 'Vyber videa',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Videa', extensions: ['mp4', 'mov', 'm4v', 'webm', 'avi', 'mkv'] }]
  });
  if (pick.canceled) return [];
  const out: VidPopis[] = [];
  for (const soubor of pick.filePaths) {
    try { out.push(await popis(soubor)); } catch { /* co nejde přečíst, se přeskočí */ }
  }
  return out;
}

export async function pickZvuk(): Promise<VidPopis | null> {
  const okno = BrowserWindow.getFocusedWindow();
  const pick = await dialog.showOpenDialog(okno ?? undefined as any, {
    title: 'Vyber zvuk',
    properties: ['openFile'],
    filters: [{ name: 'Zvuk a video', extensions: ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus', 'mp4', 'mov'] }]
  });
  if (pick.canceled || pick.filePaths.length === 0) return null;
  return popis(pick.filePaths[0]);
}

/**
 * Nahrávka z mikrofonu. Okno nahrává (přístup k mikrofonu má prohlížeč,
 * ne hlavní proces) a sem posílá hotové bajty — tady se jen uloží pod
 * jménem, které nepřepíše předchozí pokus.
 */
export function saveNahravka(postId: number, lang: string, bytes: Uint8Array, pripona = 'webm'): VidPopis | null {
  const dir = path.join(nahravkyDir(), String(postId));
  fs.mkdirSync(dir, { recursive: true });
  const soubor = path.join(dir, `${lang}-${Date.now()}.${pripona}`);
  fs.writeFileSync(soubor, bytes);
  povol(soubor);
  return { soubor, delka: 0, sirka: 0, vyska: 0, zvuk: true };
}

function nahravkyDir(): string {
  const base = path.join(os.homedir(), 'Library', 'Application Support');
  const dir = fs.existsSync(base)
    ? path.join(base, 'Quentino App', 'videozvuk')
    : path.join(os.tmpdir(), 'quentino-videozvuk');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/* ---------- překlad titulků ---------- */

/**
 * Přeloží titulky do jazyků trhů.
 *
 * Titulek není věta v článku: musí se vejít do dvou řádků na telefonu
 * a přečíst se za dvě sekundy. Doslovný překlad bývá o třetinu delší
 * (němčina spolehlivě), přeteče přes obraz a nikdo ho nedočte. Proto se
 * v zadání říká, že **délka je součást zadání** a smí se kvůli ní
 * přeformulovat.
 *
 * Posílají se všechny titulky naráz a v jednom volání na jazyk — po
 * jednom by model neviděl souvislost a druhý titulek by nevěděl, že
 * navazuje na první.
 */
export async function prelozTitulky(postId: number, langs: string[]): Promise<VidProjekt> {
  const p = projekt(postId);
  const zdroj = p.zdroj;
  const zdrojoveTexty = p.titulky.map(t => textTitulku(t, zdroj, zdroj));
  if (zdrojoveTexty.every(t => !t)) throw new Error('Není co překládat — titulky jsou bez textu.');

  const trhy = store.listMarkets();
  const kam = langs.filter(l => l !== zdroj);
  if (kam.length === 0) throw new Error('Není kam překládat — vyber aspoň jeden další trh.');

  const model = getSettings().draftModel;
  for (const lang of kam) {
    const trh = trhy.find(t => t.lang === lang);
    const system = [
      'Překládáš titulky do krátkého videa pro e-shop s kravatami a pánskými doplňky.',
      `Cílový jazyk: ${trh?.label || lang}.`,
      trh?.note ? `Tón toho trhu: ${trh.note}` : '',
      'Pravidla:',
      '— Titulek se čte dvě sekundy na telefonu. Délka je součást zadání:',
      '  drž se počtu znaků originálu, i za cenu jiné formulace.',
      '— Emoji ponech tam, kde jsou, a ve stejném počtu.',
      '— Nepřidávej hashtagy, tečky na konci ani uvozovky.',
      '— Vrať JSON: {"texty":["…","…"]} se stejným počtem prvků jako vstup,',
      '  ve stejném pořadí. Prázdný vstup zůstane prázdný.'
    ].filter(Boolean).join('\n');

    const user = JSON.stringify({ texty: zdrojoveTexty });
    const raw = await ask(model, system, user, 2000);
    const json = vytahniJson(raw);
    const texty: string[] = Array.isArray(json?.texty) ? json.texty.map((t: any) => String(t ?? '')) : [];
    if (texty.length !== zdrojoveTexty.length) {
      throw new Error(`Překlad do ${lang} se vrátil v jiném počtu titulků (${texty.length} místo ${zdrojoveTexty.length}).`);
    }
    p.titulky.forEach((t, i) => {
      // Prázdný zdroj se nedoplňuje — jinak by se do prázdného titulku
      // vlila výplň, kterou model vymyslel
      if (!zdrojoveTexty[i]) return;
      t.texty = { ...t.texty, [lang]: texty[i] };
    });
  }
  return saveProjekt(p);
}

function vytahniJson(raw: string): any {
  const zacatek = raw.indexOf('{');
  const konec = raw.lastIndexOf('}');
  if (zacatek === -1 || konec <= zacatek) throw new Error('Odpověď nešla přečíst jako JSON.');
  return JSON.parse(raw.slice(zacatek, konec + 1));
}

/* ---------- stavba příkazu pro ffmpeg ---------- */

export interface VidOverlay {
  /** Cesta k průhlednému obrázku s titulkem, vykreslenému v okně. */
  soubor: string;
  od: number;
  do: number;
}

export interface VidPlan {
  klipy: { soubor: string; od: number; do: number; zvuk: boolean }[];
  /** Přechody a časy — spočítané `osa()`, ať se náhled a výsledek shodují. */
  prechody: { xfade: string; delka: number }[];
  overlays: VidOverlay[];
  sirka: number;
  vyska: number;
  delka: number;
  zvuk: VidZvuk;
  /** Má nahrazující zvuk vlastní vstup? Pak je to index v `-i`. */
  zvukVstup: number;
}

/**
 * Filtr pro ffmpeg. Vrací se zvlášť, aby se dal zkoušet bez ffmpegu —
 * tady se totiž dělají chyby, které se na hotovém videu poznají pozdě
 * (posunutý titulek, zvuk odešlý o délku přechodů napřed).
 */
export function stavbaFiltru(plan: VidPlan): { filtr: string; video: string; audio: string } {
  const casti: string[] = [];
  const { sirka, vyska } = plan;

  /*
   * Každý záběr se nejdřív srovná na jeden formát. Bez toho `concat`
   * ani `xfade` nespojí dva soubory z různých telefonů — liší se
   * rozlišením, poměrem pixelu i počtem snímků a ffmpeg to odmítne
   * hláškou o neshodných vstupech.
   *
   * `increase` + `crop` je záměrně ořez, ne černé pruhy: reel s pruhy
   * vypadá jako omyl, kdežto ořez ze středu je to, co by člověk udělal
   * sám.
   */
  plan.klipy.forEach((k, i) => {
    casti.push(
      `[${i}:v]trim=start=${k.od.toFixed(3)}:end=${k.do.toFixed(3)},setpts=PTS-STARTPTS,`
      + `scale=${sirka}:${vyska}:force_original_aspect_ratio=increase,crop=${sirka}:${vyska},`
      /*
       * `settb=AVTB` není kosmetika: `xfade` odmítne spojit dva proudy
       * s jiným časovým základem hláškou „First input link main timebase
       * do not match" a celý převod skončí bez jediného snímku. Rozejde
       * se to hned, jak jedna strana projde `concat`em (ten si základ
       * nastaví po svém) a druhá ne — tedy u prvního přechodu za tvrdým
       * střihem. Srovnáním na jeden základ u každého záběru i u každé
       * slepené skupiny to nemůže nastat.
       */
      + `fps=30,settb=AVTB,format=yuv420p,setsar=1[v${i}]`
    );
  });

  // Skupiny záběrů spojených střihem
  const grp: number[][] = [];
  plan.klipy.forEach((_k, i) => {
    const p = plan.prechody[i];
    if (i === 0 || (p && p.xfade && p.delka > 0)) grp.push([i]);
    else grp[grp.length - 1].push(i);
  });

  const labely: string[] = [];
  grp.forEach((g, gi) => {
    if (g.length === 1) { labely.push(`v${g[0]}`); return; }
    const vstupy = g.map(i => `[v${i}]`).join('');
    casti.push(`${vstupy}concat=n=${g.length}:v=1:a=0,settb=AVTB[g${gi}]`);
    labely.push(`g${gi}`);
  });

  /*
   * Přechody se řetězí: každý bere dosud slepený proud a další skupinu.
   * `offset` je čas v **dosavadním proudu**, kde přechod začne — tedy
   * přesně místo, kde nová skupina vstupuje do výsledku. Stejné číslo
   * spočítá `osa()` pro časovou osu v okně, takže se titulky s obrazem
   * nerozejdou.
   */
  let video = labely[0];
  let běh = delkaSkupiny(plan, grp[0]);
  for (let gi = 1; gi < grp.length; gi++) {
    const prechod = plan.prechody[grp[gi][0]];
    const d = prechod.delka;
    const offset = běh - d;
    const out = `x${gi}`;
    casti.push(
      `[${video}][${labely[gi]}]xfade=transition=${prechod.xfade}:duration=${d.toFixed(3)}`
      + `:offset=${Math.max(0, offset).toFixed(3)}[${out}]`
    );
    video = out;
    běh = offset + delkaSkupiny(plan, grp[gi]);
  }

  /*
   * Titulky. Obrázek je na celý formát, takže se přiloží na nulu —
   * o umístění a lámání řádků se postaralo okno, které ho kreslilo.
   */
  const prvniObrazek = plan.klipy.length;
  plan.overlays.forEach((o, i) => {
    const vstup = prvniObrazek + i;
    const out = `o${i}`;
    casti.push(
      `[${video}][${vstup}:v]overlay=0:0:eof_action=repeat`
      + `:enable='between(t,${o.od.toFixed(3)},${o.do.toFixed(3)})'[${out}]`
    );
    video = out;
  });

  /* Zvuk */
  let audio = '';
  if (plan.zvuk.druh === 'soubor' && plan.zvukVstup >= 0) {
    const od = Math.max(0, plan.zvuk.od ?? 0);
    const do_ = plan.zvuk.do && plan.zvuk.do > od ? plan.zvuk.do : od + plan.delka;
    const hlas = plan.zvuk.hlasitost ?? 1;
    /*
     * `apad` je tu kvůli krátké hudbě: bez něj by se video zkrátilo na
     * délku zvuku (`-shortest` platí pro celý výstup) a z osmnácti sekund
     * by zůstalo pět. Doplněné ticho je menší zlo než uříznutý obraz.
     */
    casti.push(
      `[${plan.zvukVstup}:a]atrim=start=${od.toFixed(3)}:end=${do_.toFixed(3)},asetpts=PTS-STARTPTS,`
      + `volume=${hlas.toFixed(2)},apad,atrim=duration=${plan.delka.toFixed(3)},`
      + `afade=t=out:st=${Math.max(0, plan.delka - 0.4).toFixed(3)}:d=0.4[a]`
    );
    audio = 'a';
  } else if (plan.zvuk.druh === 'original') {
    /*
     * Zvuk ze záběrů. Kde má obraz přechod, musí se zvuk prolnout stejně
     * dlouho (`acrossfade`) — jinak je výsledný zvuk o součet všech
     * přechodů delší než obraz a od prvního přechodu jde slovo napřed.
     */
    plan.klipy.forEach((k, i) => {
      if (k.zvuk) {
        casti.push(
          `[${i}:a]atrim=start=${k.od.toFixed(3)}:end=${k.do.toFixed(3)},asetpts=PTS-STARTPTS,`
          + `aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a${i}]`
        );
      } else {
        // Záběr bez zvuku (třeba znělka) by na neexistující stopě spadl
        const d = (k.do - k.od).toFixed(3);
        casti.push(
          `anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${d},asetpts=PTS-STARTPTS[a${i}]`
        );
      }
    });
    const aLabely: string[] = [];
    grp.forEach((g, gi) => {
      if (g.length === 1) { aLabely.push(`a${g[0]}`); return; }
      casti.push(`${g.map(i => `[a${i}]`).join('')}concat=n=${g.length}:v=0:a=1[ag${gi}]`);
      aLabely.push(`ag${gi}`);
    });
    audio = aLabely[0];
    for (let gi = 1; gi < grp.length; gi++) {
      const d = plan.prechody[grp[gi][0]].delka;
      const out = `ax${gi}`;
      casti.push(`[${audio}][${aLabely[gi]}]acrossfade=d=${d.toFixed(3)}:c1=tri:c2=tri[${out}]`);
      audio = out;
    }
  }

  return { filtr: casti.join(';'), video, audio };
}

function delkaSkupiny(plan: VidPlan, g: number[]): number {
  return g.reduce((s, i) => s + (plan.klipy[i].do - plan.klipy[i].od), 0);
}

/** Celý příkaz. Oddělené od spouštění, ať se dá zkoušet bez ffmpegu. */
export function ffmpegArgy(plan: VidPlan, cil: string): string[] {
  const args = ['-y', '-hide_banner'];
  for (const k of plan.klipy) args.push('-i', k.soubor);
  for (const o of plan.overlays) args.push('-i', o.soubor);
  if (plan.zvuk.druh === 'soubor' && plan.zvukVstup >= 0 && plan.zvuk.soubor) {
    args.push('-i', plan.zvuk.soubor);
  }

  const { filtr, video, audio } = stavbaFiltru(plan);
  args.push('-filter_complex', filtr, '-map', `[${video}]`);
  if (audio) args.push('-map', `[${audio}]`, '-c:a', 'aac', '-b:a', '128k', '-ar', '48000');
  else args.push('-an');

  args.push(
    '-c:v', 'libx264',
    /*
     * H.264 v `high` s `yuv420p`: Instagram si cokoli jiného převede sám
     * a obvykle hůř. `faststart` přesune hlavičku na začátek — bez ní
     * Meta u videa hlásí chyby řady 22070xx, protože si ho nedokáže
     * přehrát bez stažení celého souboru.
     */
    '-profile:v', 'high',
    '-preset', 'veryfast',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-r', '30',
    '-t', plan.delka.toFixed(3),
    cil
  );
  return args;
}

/* ---------- vykreslení ---------- */

export interface VidObrazek {
  /** Který titulek to je — kvůli času, který se bere z projektu. */
  id: string;
  /** PNG z plátna v okně, jako base64 bez hlavičky `data:`. */
  png: string;
}

let bezi: ReturnType<typeof spawn> | null = null;

export function stopRender(): void {
  try { bezi?.kill('SIGTERM'); } catch { /* už doběhlo */ }
  bezi = null;
}

function hlas(payload: unknown) {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('ig:videoStep', payload);
}

/**
 * Vykreslí video pro jeden trh a přiloží ho k příspěvku jako médium
 * toho trhu.
 *
 * Obrázky s titulky posílá okno — pro každý trh jiné, protože je v nich
 * přeložený text. Ukládají se do složky, která se po dokončení uklidí.
 */
export async function vykresli(
  postId: number,
  lang: string,
  obrazky: VidObrazek[]
): Promise<VidProjekt> {
  const tool = await findFfmpeg();
  if (!tool.ok) throw new Error(tool.note);

  const p = projekt(postId);
  const chyby = potize(p, [lang]);
  if (chyby.length > 0) throw new Error(chyby[0]);

  const klipy = klipyTrhu(p, lang);
  const rozmer = POMERY[p.pomer as VidPomer] ?? POMERY['9:16'];
  const { místa, delka } = osa(klipy);
  if (delka < MIN_KLIP) throw new Error('Video by nemělo žádnou délku.');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quentino-video-'));
  try {
    /* Obrázky s titulky na disk — ffmpeg je bere jako vstupy */
    const overlays: VidOverlay[] = [];
    for (const [i, obr] of obrazky.entries()) {
      const t = p.titulky.find(x => x.id === obr.id);
      if (!t) continue;
      const soubor = path.join(dir, `titulek-${i}.png`);
      fs.writeFileSync(soubor, Buffer.from(obr.png, 'base64'));
      overlays.push({ soubor, od: Math.max(0, t.od), do: Math.min(delka, t.do) });
    }

    /* Vlastnosti záběrů — hlavně jestli mají zvuk */
    const popisy = new Map<string, VidPopis>();
    for (const k of klipy) {
      if (!popisy.has(k.soubor)) popisy.set(k.soubor, await popis(k.soubor));
    }

    const zvuk = zvukTrhu(p, lang);
    const plan: VidPlan = {
      klipy: klipy.map(k => ({
        soubor: k.soubor,
        od: Math.max(0, k.od),
        do: Math.max(k.od + MIN_KLIP, k.do),
        zvuk: !!popisy.get(k.soubor)?.zvuk
      })),
      prechody: klipy.map((k, i) => ({
        xfade: PRECHODY[k.prechod]?.xfade ?? '',
        delka: místa[i].prechod
      })),
      overlays,
      sirka: rozmer.sirka,
      vyska: rozmer.vyska,
      delka,
      zvuk,
      zvukVstup: zvuk.druh === 'soubor' && zvuk.soubor ? klipy.length + overlays.length : -1
    };

    const cil = vystup(postId, lang);
    const args = ffmpegArgy(plan, cil);

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(tool.path, args);
      bezi = proc;
      let posledni = '';
      proc.stderr.on('data', chunk => {
        const text = String(chunk);
        posledni = text.trim().split('\n').pop() ?? posledni;
        const at = /time=\s*(\d+):(\d\d):(\d\d(?:\.\d+)?)/.exec(text);
        if (at) {
          const kde = Number(at[1]) * 3600 + Number(at[2]) * 60 + Number(at[3]);
          hlas({ lang, percent: Math.min(99, Math.round((kde / delka) * 100)) });
        }
      });
      proc.on('error', err => { bezi = null; reject(err); });
      proc.on('close', code => {
        bezi = null;
        if (code === 0) return resolve();
        /*
         * Hláška ffmpegu je konkrétnější než cokoli, co bychom vymysleli —
         * jen se zkrátí, aby se vešla do okna.
         */
        reject(new Error(`ffmpeg skončil s chybou (${code}): ${posledni.slice(0, 240)}`));
      });
    });

    povol(cil);
    p.hotovo = { ...p.hotovo, [lang]: { soubor: cil, kdy: new Date().toISOString(), delka } };
    const ulozeny = saveProjekt(p);
    /* Hotové video se hned stane médiem toho trhu, ať se dá publikovat */
    store.setPostMedia(postId, [{
      path: cil,
      mime: 'video/mp4',
      isVideo: true,
      width: rozmer.sirka,
      height: rozmer.vyska
    }], lang);
    hlas({ lang, percent: 100, hotovo: true });
    return ulozeny;
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* úklid není kritický */ }
  }
}

function vystup(postId: number, lang: string): string {
  const dir = path.join(nahravkyDir(), '..', 'videa', String(postId));
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${lang}-${Date.now()}.mp4`);
}

/** Přepínač „reel jen do reelů, nebo i do mřížky profilu". */
export function setDoMrizky(postId: number, on: boolean): VidProjekt {
  const p = projekt(postId);
  p.doMrizky = on;
  store.setPostFeed(postId, on);
  return saveProjekt(p);
}

export const __test = { stavbaFiltru, ffmpegArgy, vytahniJson };

export type { VidProjekt, VidKlip, VidTitulek, VidZvuk, VidZnelka };
export { delkaVidea };
