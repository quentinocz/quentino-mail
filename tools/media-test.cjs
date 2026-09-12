/**
 * Zkouška konvertoru médií — bez ffmpegu a bez plátna.
 *
 * Samotný převod dělá Chromium v okně aplikace a ten se odsud vyzkoušet
 * nedá. Zkouší se proto to, co rozhoduje o výsledku a co se okem nepozná:
 *
 *  1. **parametry pro ffmpeg** — jeden překlep a video je bez zvuku nebo
 *     v liché výšce, kterou kodér odmítne,
 *  2. **čtení postupu** z jeho výpisu,
 *  3. **ukládání vedle originálu** — hlídaná složka běží na pozadí a nikdy
 *     nesmí přepsat, co už jednou vzniklo,
 *  4. **nastavení hlídané složky** — vlastní hodnoty u každé, výchozí tam,
 *     kde nic není.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DIST } = require('./ptrans/harness.cjs');

let failed = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${label}`);
  if (!ok) { console.log('      čekáno:', JSON.stringify(want)); console.log('      dostal:', JSON.stringify(got)); }
}
function ok(label, value, note = '') {
  check(label + (value || !note ? '' : ` (${note})`), !!value, true);
}

const media = require(path.join(DIST, 'media.js'));
const { __test } = media;

console.log('\nkonvertor médií:\n');

/* ---------- ffmpeg ---------- */

{
  const setup = { ...__test.DEFAULTS };
  const args = __test.ffmpegArgs('/in/a.mov', '/out/a.webm', setup);
  const at = name => args.indexOf(name);

  ok('vstup i výstup jsou na svém místě',
    args[0] === '-y' && args[2] === '/in/a.mov' && args[args.length - 1] === '/out/a.webm', args.join(' '));
  check('VP9 je výchozí kodek', args[at('-c:v') + 1], 'libvpx-vp9');
  /*
   * `-crf` s `-b:v 0` je režim konstantní kvality: bitrate si ffmpeg zvolí
   * podle obsahu. Kdyby `-b:v 0` chybělo, chová se `-crf` jako strop a
   * výsledek je znatelně horší při stejné velikosti.
   */
  check('kvalita jede na konstantní kvalitu', args[at('-b:v') + 1], '0');
  ok('a běží na víc jádrech', at('-row-mt') > 0);
  /*
   * `scale=…:-2` dopočítá výšku a zaokrouhlí ji na sudé číslo. Liché
   * rozměry kodéry videa odmítají a převod spadne až po minutách práce.
   */
  ok('výška se dopočítá na sudé číslo', args[at('-vf') + 1].endsWith(':-2'), args[at('-vf') + 1]);
  ok('a šířka se nikdy nezvětšuje', args[at('-vf') + 1].includes('min(1280,iw)'));

  const bezZvuku = __test.ffmpegArgs('/in/a.mov', '/out/a.webm', { ...setup, videoAudio: 0 });
  ok('nula znamená bez zvuku', bezZvuku.includes('-an') && !bezZvuku.includes('libopus'));
  const seZvukem = __test.ffmpegArgs('/in/a.mov', '/out/a.webm', { ...setup, videoAudio: 128 });
  check('a jinak se zvuk překóduje', seZvukem[seZvukem.indexOf('-b:a') + 1], '128k');
  // Zachovat rozlišení znamená žádné škálování, ne škálování na nulu
  ok('nulová šířka nechá rozlišení být',
    !__test.ffmpegArgs('/in/a.mov', '/o.webm', { ...setup, videoWidth: 0 }).includes('-vf'));
  check('VP8 se dá zvolit',
    __test.ffmpegArgs('/i', '/o', { ...setup, videoCodec: 'vp8' })[at('-c:v') + 1], 'libvpx');
}

/* ---------- postup z výpisu ffmpegu ---------- */

check('délka videa se přečte', __test.secondsOf('Duration: 00:01:23.45, start:'), 83.45);
check('i aktuální čas', __test.secondsOf('time=00:00:41.72 bitrate='), 41.72);
check('bez času vyjde nula', __test.secondsOf('nic tu není'), 0);

/* ---------- které soubory se berou ---------- */

check('fotka je fotka', __test.kindOf('IMG_1234.JPG'), 'image');
check('video je video', __test.kindOf('klip.MOV'), 'video');
// Do konvertoru se dá přetáhnout cokoli; textový soubor se prostě přeskočí
check('ostatní se přeskočí', __test.kindOf('poznamky.txt'), 'other');

/* ---------- ukládání vedle originálu ---------- */

console.log('\nhlídaná složka:');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-'));
  const source = path.join(dir, 'motylek.jpg');
  fs.writeFileSync(source, 'původní fotka');

  const first = __test.writeBeside(source, 'web', new Uint8Array([1, 2, 3]));
  check('výsledek jde do podsložky vedle originálu',
    path.relative(dir, first.file), path.join('web', 'motylek.webp'));
  ok('podsložka se založí sama', fs.existsSync(path.join(dir, 'web')));
  ok('originál zůstane nedotčený', fs.readFileSync(source, 'utf8') === 'původní fotka');

  /*
   * Hlídaná složka běží na pozadí. Přepsat v ní bez ptaní něco, co už
   * jednou vzniklo — třeba ručně doladěný ořez — je způsob, jak tiše
   * přijít o práci.
   */
  const again = __test.writeBeside(source, 'web', new Uint8Array([9, 9, 9, 9, 9]));
  ok('podruhé se hotový soubor nepřepíše', again.skipped);
  check('a zůstane ten původní', fs.statSync(first.file).size, 3);

  fs.rmSync(dir, { recursive: true, force: true });
}

/* ---------- nastavení složky ---------- */

{
  const prazdna = __test.normalizeWatch({ path: '/foto' });
  ok('nová složka dostane identifikátor', prazdna.id.length > 10);
  check('a hlídá se hned', prazdna.enabled, true);
  check('podsložka má výchozí název', prazdna.subfolder, 'web');
  // Bez ořezu se jen převádí — to je platný stav, ne chybějící nastavení
  check('bez ořezu je ořez prázdný', prazdna.crop, null);
  check('kvalita se vezme z obecného nastavení', prazdna.quality, __test.DEFAULTS.quality);

  const vlastni = __test.normalizeWatch({
    path: '/foto', quality: 92, resize: 'exact', exactWidth: 1200, subfolder: '  ',
    crop: { x: 0.1, y: 0.2, w: 0.5, h: 0.5 }
  });
  check('vlastní kvalita přebije obecnou', vlastni.quality, 92);
  check('i způsob zmenšení', [vlastni.resize, vlastni.exactWidth], ['exact', 1200]);
  // Prázdný název podsložky by uložil webp mezi originály
  check('prázdná podsložka se vrátí na výchozí', vlastni.subfolder, 'web');
  check('ořez se zachová', vlastni.crop, { x: 0.1, y: 0.2, w: 0.5, h: 0.5 });
  // Nesmysl v nastavení nesmí shodit hlídání celé složky
  check('nesmyslný způsob zmenšení se opraví',
    __test.normalizeWatch({ path: '/f', resize: 'nesmysl' }).resize, __test.DEFAULTS.resize);
}

console.log(failed === 0 ? '\nvše sedí\n' : `\n${failed} nesedí\n`);
process.exit(failed === 0 ? 0 : 1);
