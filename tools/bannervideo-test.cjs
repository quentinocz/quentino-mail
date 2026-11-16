/**
 * Převod videa pro banner — zkouška s opravdovým ffmpegem.
 *
 * Video na pozadí banneru se dřív nahrávalo, jak přišlo. Teď se převádí,
 * a tři věci, kvůli kterým se to dělá, nejsou na videu vidět: že nemá
 * zvukovou stopu, že ho přehraje i prohlížeč, který neumí desetibitový
 * obraz, a že se dá hrát dřív, než se stáhne celé. Všechny tři se dají
 * změřit jen na hotovém souboru — proto se tu opravdu převádí.
 *
 * Bez ffmpegu se část s převodem přeskočí; na sestavovacím stroji být nemusí.
 *
 *   node tools/bannervideo-test.cjs
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { DIST } = require('./ptrans/harness.cjs');
const B = require(path.join(DIST, 'bannervideo.js'));

let failed = 0;
function ok(label, value, note = '') {
  if (!value) failed++;
  console.log(`  ${value ? '✓' : '✗'} ${label}${note ? `   ${note}` : ''}`);
}

console.log('\nvideo pro banner — převod:\n');

const args = B.mp4Args('/tmp/a.mov', '/tmp/b.mp4', B.STUPNE[0]).join(' ');
ok('MP4 jde bez zvuku, osmibitově a s hlavičkou na začátku',
  args.includes('-an') && args.includes('-pix_fmt yuv420p') && args.includes('+faststart'));
ok('a nejvýš dvacet vteřin a třicet snímků', args.includes(`-t ${B.MAX_SEKUND}`) && args.includes('-fpsmax 30'));
ok('stupně zmenšování jdou od nejlepší kvality dolů',
  B.STUPNE.every((one, i) => i === 0 || one.crf > B.STUPNE[i - 1].crf));

let FF = '';
for (const kandidat of ['ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']) {
  try { execFileSync(kandidat, ['-version'], { stdio: 'ignore' }); FF = kandidat; break; } catch { /* další */ }
}

(async () => {
  if (!FF) {
    console.log('  · převod přeskočen — ffmpeg v tomhle počítači není');
  } else {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbn-prevod-'));
    const vstup = path.join(dir, 'z-telefonu.mov');
    /* Jako z telefonu: šedesát snímků, desetibitový obraz, zvuk, moc velké */
    execFileSync(FF, ['-y', '-v', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=60:duration=3',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
      '-c:v', 'libx264', '-pix_fmt', 'yuv422p10le', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', vstup]);
    const popis = soubor => {
      let text = '';
      try { execFileSync(FF, ['-hide_banner', '-i', soubor], { stdio: ['ignore', 'ignore', 'pipe'] }); }
      catch (e) { text = String(e.stderr ?? ''); }
      return text;
    };
    const predtim = popis(vstup);
    ok('  (vstup má zvuk, deset bitů a šedesát snímků — to se má změnit)',
      /Audio:/.test(predtim) && /yuv422p10/.test(predtim) && /60 fps/.test(predtim));

    const out = await B.prevedVideo(FF, vstup, path.join(dir, 'out'));
    const potom = popis(out.mp4);
    ok('z videa z telefonu vyjde MP4 s H.264', /Video: h264/.test(potom), out.mp4.split('/').pop());
    ok('  bez zvukové stopy', !/Audio:/.test(potom));
    ok('  osmibitové — přehraje ho i Safari a starší telefon', /yuv420p[,(]/.test(potom) && !/10le/.test(potom));
    ok('  zmenšené a nejvýš třicet snímků', out.sirka === 1280 && out.vyska === 720 && /\b30 fps/.test(potom),
      `${out.sirka}×${out.vyska}`);
    const data = fs.readFileSync(out.mp4);
    ok('  s hlavičkou na začátku, ať hraje dřív, než se stáhne celé',
      data.indexOf('moov') > 0 && data.indexOf('moov') < data.indexOf('mdat'),
      `moov na ${data.indexOf('moov')}, data na ${data.indexOf('mdat')}`);
    /* Totéž bez příznaku — ať je vidět, že hlavičku na začátek dává on, ne náhoda */
    const bez = path.join(dir, 'bez.mp4');
    execFileSync(FF, B.mp4Args(vstup, bez, B.STUPNE[0]).filter(one => one !== '-movflags' && one !== '+faststart'));
    const bezData = fs.readFileSync(bez);
    ok('  (bez toho příznaku je hlavička až na konci)', bezData.indexOf('moov') > bezData.indexOf('mdat'));
    ok('  o řády menší než vstup', out.mp4Bajtu < fs.statSync(vstup).size / 5,
      `${Math.round(out.mp4Bajtu / 1024)} kB z ${Math.round(fs.statSync(vstup).size / 1024)} kB`);
    const snimek = out.snimek ? fs.readFileSync(out.snimek) : Buffer.alloc(0);
    ok('k videu je první snímek jako fotka', snimek.length > 1000 && snimek[0] === 0xff && snimek[1] === 0xd8,
      `${Math.round(snimek.length / 1024)} kB`);
    ok('krátký záběr se nezkracuje', !out.zkraceno && Math.abs(out.sekund - 3) < 0.3, `${out.sekund} s`);
    ok('WebM se nechá, jen když je znatelně menší',
      out.webm === '' ? out.webmBajtu === 0 : out.webmBajtu <= out.mp4Bajtu * 0.9,
      out.webm ? `${Math.round(out.webmBajtu / 1024)} kB` : 'nevyplatil se');

    /* Dlouhý záběr: vezme se jen začátek */
    const dlouhy = path.join(dir, 'dlouhy.mp4');
    execFileSync(FF, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10:duration=24',
      '-c:v', 'libx264', '-preset', 'ultrafast', dlouhy]);
    const kratsi = await B.prevedVideo(FF, dlouhy, path.join(dir, 'out2'));
    ok('z dlouhého záběru se vezme prvních dvacet vteřin', kratsi.zkraceno && kratsi.sekund <= B.MAX_SEKUND + 0.3,
      `${kratsi.sekund} s`);

    /* Co není video, se řekne česky — ne výpisem ffmpegu */
    const text = path.join(dir, 'neni-video.mp4');
    fs.writeFileSync(text, 'tohle není video');
    let hlaska = '';
    try { await B.prevedVideo(FF, text, path.join(dir, 'out3')); } catch (e) { hlaska = e.message; }
    ok('soubor, který není video, se odmítne srozumitelně', /nepodařilo přečíst jako video/.test(hlaska), hlaska);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* uklidí systém */ }
  }
  console.log(failed ? `\n✗ ${failed} chyb` : '\n✓ převod videa pro banner sedí');
  process.exit(failed ? 1 : 0);
})();
