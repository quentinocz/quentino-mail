/*
 * Zmenší skript bannerů a zapíše ho do src/main/bannerscript.min.ts.
 *
 * Proč vůbec a proč předem, je popsané u funkce `sablona` v
 * src/main/bannerscript.ts. Tady jen jak:
 *
 *  1. čitelný skript se vezme přímo ze zdroje (přeloží se esbuildem
 *     v paměti, nic se nikam nezapisuje),
 *  2. styl a kód se zmenší zvlášť — jsou to dva jazyky,
 *  3. k výsledku se zapíše otisk zdroje, ze kterého vznikl. Aplikace
 *     zmenšenou podobu použije jen tehdy, když otisk sedí.
 *
 * Značky, na jejichž místo se za běhu dosazuje adresa plánu a záložní
 * sada, jsou ve skriptu řetězce. Zmenšovač smí řetězec, o kterém ví, že
 * je vždycky pravdivý, vyhodnotit předem a větev „bez zálohy" zahodit —
 * a skript by pak bez záložní sady nefungoval. Před zmenšením se proto
 * vymění za jména, o kterých zmenšovač neví nic, a po něm vrátí zpátky.
 *
 *   node scripts/banner-min.mjs          zapíše zmenšenou podobu
 *   node scripts/banner-min.mjs --check  jen řekne, jestli je aktuální
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CIL = path.join(ROOT, 'src/main/bannerscript.min.ts');
const require = createRequire(import.meta.url);

let esbuild;
try { esbuild = require('esbuild'); }
catch { console.log('esbuild není — zmenšená podoba se nevyrobí (npm install ho přinese)'); process.exit(1); }

const slozeno = await esbuild.build({
  entryPoints: [path.join(ROOT, 'src/main/bannerscript.ts')],
  bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent'
});
const modul = { exports: {} };
// eslint-disable-next-line no-new-func
new Function('module', 'exports', 'require', slozeno.outputFiles[0].text)(modul, modul.exports, require);
const { citelnySkript, otiskSkriptu } = modul.exports;

const zdroj = citelnySkript();
const otisk = otiskSkriptu(zdroj);

if (process.argv.includes('--check')) {
  const ted = fs.existsSync(CIL) ? fs.readFileSync(CIL, 'utf8') : '';
  const plati = ted.includes(`'${otisk}'`);
  console.log(plati ? '✓ zmenšený skript bannerů je aktuální'
    : '✗ zmenšený skript bannerů je zastaralý — spusť node scripts/banner-min.mjs');
  process.exit(plati ? 0 : 1);
}

const styl = /<style>([\s\S]*?)<\/style>/.exec(zdroj);
const kod = /<script>([\s\S]*?)<\/script>/.exec(zdroj);
if (!styl || !kod) { console.log('✗ ve skriptu chybí <style> nebo <script>'); process.exit(1); }
if (zdroj.split('<script>').length !== 2 || zdroj.split('<style>').length !== 2) {
  console.log('✗ skript má víc bloků <style> nebo <script>, než se čeká'); process.exit(1);
}

const ZNACKY = [
  ['"__QUENTINO_BANNERS_URL__"', '__QBN_URL__'],
  ['"__QUENTINO_BANNERS_FALLBACK__"', '__QBN_FALLBACK__']
];
let kPrevodu = kod[1];
for (const [znacka, jmeno] of ZNACKY) {
  if (kPrevodu.split(znacka).length !== 2) {
    console.log(`✗ značka ${znacka} má být ve skriptu právě jednou`); process.exit(1);
  }
  kPrevodu = kPrevodu.split(znacka).join(jmeno);
}

const malyKod = await esbuild.transform(kPrevodu, { minify: true, target: 'es2015', charset: 'utf8' });
const malyStyl = await esbuild.transform(styl[1], { minify: true, loader: 'css', charset: 'utf8' });

let vysledek = malyKod.code.trim();
for (const [znacka, jmeno] of ZNACKY) {
  if (vysledek.split(jmeno).length !== 2) {
    console.log(`✗ značka ${znacka} se při zmenšování ztratila nebo zdvojila`); process.exit(1);
  }
  vysledek = vysledek.split(jmeno).join(znacka);
}
if (vysledek.split('__QUENTINO_BANNERS_TTL__').length !== 2) {
  console.log('✗ značka platnosti kopie se při zmenšování ztratila nebo zdvojila'); process.exit(1);
}
/* Konec bloku uvnitř kódu by stránku rozbil dřív, než by se skript spustil */
if (/<\/script/i.test(vysledek) || /<\/style/i.test(malyStyl.code)) {
  console.log('✗ ve zmenšeném kódu je uzavírací značka bloku'); process.exit(1);
}

const cely = `<style>${malyStyl.code.trim()}</style>\n<script>${vysledek}</script>`;
fs.writeFileSync(CIL, [
  '/* Vyrobeno skriptem scripts/banner-min.mjs — neupravovat ručně. */',
  `export const MIN_OF = '${otisk}';`,
  `export const MIN = ${JSON.stringify(cely)};`,
  ''
].join('\n'));
console.log(`✓ zmenšeno: ${zdroj.length} → ${cely.length} znaků (${Math.round((1 - cely.length / zdroj.length) * 100)} % dolů)`);
