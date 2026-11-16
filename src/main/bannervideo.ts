import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

/**
 * Převod videa na pozadí banneru.
 *
 * ## Proč se převádí
 *
 * Dřív se video nahrávalo, jak přišlo — a člověk ho musel napřed sám
 * zmenšit v Konvertoru médií, trefit formát a hlídat dvanáct megabajtů.
 * Co prošlo, mělo tři vady, které nikdo neviděl:
 *
 *  * **formát.** WebM nehraje všude; kde nehraje, zůstala jen fotka a
 *    nikdo se nedozvěděl proč. MP4 s H.264 hraje v každém prohlížeči.
 *  * **zvuková stopa.** Video na pozadí je bez zvuku, ale stopa se
 *    stahovala dál — desítky procent souboru k ničemu.
 *  * **velikost.** Záběr z telefonu má 4K a šedesát snímků; dlaždice
 *    banneru z toho ukáže zlomek. Stahuje to přitom každý návštěvník
 *    úvodní stránky.
 *
 * Výsledek je proto vždycky **MP4** (zmenšené, bez zvuku, nanejvýš
 * dvacet vteřin, s hlavičkou na začátku, ať se dá hrát dřív, než se
 * stáhne celé), k němu **WebM**, když vyjde znatelně menší — prohlížeč,
 * který ho umí, si vezme to menší — a **první snímek** jako fotka pro
 * chvíli, než se video rozběhne.
 */

/** Delší smyčku na pozadí nikdo nedokouká a platí ji daty každý návštěvník. */
export const MAX_SEKUND = 20;
/** Nejvíc, co má smysl pouštět na úvodní stránce jako pozadí banneru. */
export const MAX_MB = 12;

/**
 * Stupně, kterými se video zmenšuje, dokud se nevejde.
 *
 * Začíná se kvalitou, na které není komprese pod ztmavením vidět.
 * Většina záběrů se vejde napoprvé; další stupně jsou pro dlouhý záběr
 * s hodně pohybem (voda, listí), kde by první pokus přetekl.
 */
export const STUPNE = [
  { crf: 27, sirka: 1280 },
  { crf: 31, sirka: 1280 },
  { crf: 34, sirka: 960 }
];

const zmenseni = (sirka: number) => `scale='min(${sirka},iw)':-2`;

/** MP4 pro každý prohlížeč. */
export function mp4Args(vstup: string, vystup: string, stupen: { crf: number; sirka: number }): string[] {
  return [
    '-y', '-hide_banner', '-v', 'error',
    '-i', vstup,
    '-t', String(MAX_SEKUND),
    '-map', '0:v:0',
    /* Zvuk pryč: banner je němý a stopa by se stahovala pro nic */
    '-an',
    '-vf', zmenseni(stupen.sirka),
    /* Šedesát snímků z telefonu je dvojnásobek dat a pod textem to nikdo nepozná */
    '-fpsmax', '30',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', String(stupen.crf),
    /*
     * `yuv420p` není kosmetika: záběr z iPhonu bývá desetibitový a
     * takové H.264 Safari ani starší telefony nepřehrají.
     */
    '-pix_fmt', 'yuv420p', '-profile:v', 'high',
    /* Hlavička na začátek — jinak prohlížeč nezačne hrát, dokud nestáhne celý soubor */
    '-movflags', '+faststart',
    vystup
  ];
}

/** WebM (VP9) — menší, pro prohlížeče, které ho umí. */
export function webmArgs(vstup: string, vystup: string, stupen: { crf: number; sirka: number }): string[] {
  return [
    '-y', '-hide_banner', '-v', 'error',
    '-i', vstup,
    '-t', String(MAX_SEKUND),
    '-map', '0:v:0', '-an',
    '-vf', zmenseni(stupen.sirka),
    '-fpsmax', '30',
    /* VP9 má stupnici posunutou: stejný dojem jako H.264 dává číslo asi o osm vyšší */
    '-c:v', 'libvpx-vp9', '-crf', String(stupen.crf + 8), '-b:v', '0',
    '-deadline', 'good', '-cpu-used', '4', '-row-mt', '1',
    '-pix_fmt', 'yuv420p',
    vystup
  ];
}

/** První snímek hotového videa — fotka pro chvíli, než se video rozběhne. */
export function snimekArgs(video: string, vystup: string): string[] {
  return ['-y', '-hide_banner', '-v', 'error', '-i', video, '-frames:v', '1', '-q:v', '2', vystup];
}

function spust(ffmpeg: string, args: string[], limitMs = 10 * 60_000): Promise<string> {
  return new Promise(resolve => {
    execFile(ffmpeg, args, { timeout: limitMs, maxBuffer: 8 << 20 }, (err, _out, stderr) => {
      resolve(err ? (String(stderr ?? '').trim().split('\n').pop() || String(err.message)) : '');
    });
  });
}

/** Délka a rozměr — z výpisu `ffmpeg -i`, ffprobe vedle ffmpegu být nemusí. */
export function popisVidea(ffmpeg: string, soubor: string): Promise<{ sekund: number; sirka: number; vyska: number }> {
  return new Promise(resolve => {
    execFile(ffmpeg, ['-hide_banner', '-i', soubor], { timeout: 20_000, maxBuffer: 4 << 20 }, (_e, _o, stderr) => {
      const text = String(stderr ?? '');
      const d = /Duration:\s*(\d+):(\d\d):(\d\d(?:\.\d+)?)/.exec(text);
      const v = /Stream #\d+:\d+[^\n]*: Video:[^\n]*?,\s*(\d{2,5})x(\d{2,5})/.exec(text);
      resolve({
        sekund: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0,
        sirka: v ? Number(v[1]) : 0,
        vyska: v ? Number(v[2]) : 0
      });
    });
  });
}

export interface BannerVideoHotove {
  /** MP4 — hraje všude. */
  mp4: string;
  /** WebM — jen když vyšlo znatelně menší, jinak prázdné. */
  webm: string;
  /** První snímek (JPEG), nebo prázdné, když se nepodařil. */
  snimek: string;
  sekund: number;
  /** Původní záběr byl delší a vzal se jen začátek. */
  zkraceno: boolean;
  sirka: number;
  vyska: number;
  mp4Bajtu: number;
  webmBajtu: number;
}

/**
 * Převede video a vrátí cesty k hotovým souborům ve složce `dir`.
 *
 * Bez sítě a bez aplikace — tudy chodí i zkouška.
 */
export async function prevedVideo(ffmpeg: string, vstup: string, dir: string): Promise<BannerVideoHotove> {
  const puvodni = await popisVidea(ffmpeg, vstup);
  if (!puvodni.sirka) {
    throw new Error(`Soubor „${path.basename(vstup)}" se nepodařilo přečíst jako video.`);
  }
  fs.mkdirSync(dir, { recursive: true });
  const mp4 = path.join(dir, 'banner.mp4');
  const webm = path.join(dir, 'banner.webm');
  const snimek = path.join(dir, 'banner.jpg');
  const strop = MAX_MB * 1024 * 1024;

  let stupen = STUPNE[0];
  let chyba = '';
  let vesloSe = false;
  for (const zkus of STUPNE) {
    stupen = zkus;
    chyba = await spust(ffmpeg, mp4Args(vstup, mp4, zkus));
    if (chyba || !fs.existsSync(mp4)) break;
    if (fs.statSync(mp4).size <= strop) { vesloSe = true; break; }
  }
  if (chyba || !fs.existsSync(mp4)) {
    throw new Error(`Video se nepodařilo převést: ${chyba || 'ffmpeg nic nevyrobil'}`);
  }
  if (!vesloSe) {
    throw new Error(`Video má i po zmenšení ${(fs.statSync(mp4).size / 1024 / 1024).toFixed(1)} MB. `
      + `Na pozadí banneru se vejde do ${MAX_MB} MB — zkus kratší nebo klidnější záběr.`);
  }

  /*
   * WebM je navíc: když se nepovede (tenhle ffmpeg nemá VP9) nebo
   * nevyjde aspoň o desetinu menší, obejde se banner bez něj. Druhý
   * soubor, který nic neušetří, je jen druhé nahrávání.
   */
  let webmBajtu = 0;
  const webmChyba = await spust(ffmpeg, webmArgs(vstup, webm, stupen));
  if (!webmChyba && fs.existsSync(webm)) {
    webmBajtu = fs.statSync(webm).size;
    if (webmBajtu <= 0 || webmBajtu > fs.statSync(mp4).size * 0.9) {
      webmBajtu = 0;
      try { fs.rmSync(webm, { force: true }); } catch { /* uklidí systém */ }
    }
  }

  const snimekChyba = await spust(ffmpeg, snimekArgs(mp4, snimek), 60_000);
  const hotove = await popisVidea(ffmpeg, mp4);
  return {
    mp4,
    webm: webmBajtu > 0 ? webm : '',
    snimek: !snimekChyba && fs.existsSync(snimek) && fs.statSync(snimek).size > 0 ? snimek : '',
    sekund: hotove.sekund,
    zkraceno: puvodni.sekund > MAX_SEKUND + 0.5,
    sirka: hotove.sirka,
    vyska: hotove.vyska,
    mp4Bajtu: fs.statSync(mp4).size,
    webmBajtu
  };
}
