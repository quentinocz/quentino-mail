/**
 * Zkouška střihu videa s titulky.
 *
 * Zkouší se to, co se okem nepozná a v hotovém videu se pozná pozdě:
 *
 *  1. **časová osa** — přechod se s oběma záběry překrývá, takže výsledek
 *     je kratší než součet záběrů. Kdyby se to počítalo „od začátku
 *     záběru", titulek u pátého záběru by byl posunutý o součet všech
 *     přechodů před ním — a to se v obraze ukáže až po vykreslení.
 *  2. **shoda okna a ffmpegu** — `offset` u `xfade` musí být totéž číslo,
 *     jaké okno kreslí do časové osy. Rozejde-li se to, titulky sedí
 *     v náhledu a ve videu ne.
 *  3. **zvuk se nesmí rozejít s obrazem** — kde má obraz přechod, musí
 *     se zvuk prolnout stejně dlouho; jinak jde od prvního přechodu
 *     slovo napřed o jeho délku.
 *  4. **záběr bez zvukové stopy** — znělka s logem zvuk nemá a `atrim`
 *     nad neexistující stopou shodí celý převod.
 *
 *   node tools/video-test.cjs
 */
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
  if (!value) failed++;
  console.log(`  ${value ? '✓' : '✗'} ${label}`);
  if (!value && note) console.log(`      ${note}`);
}

const V = require(path.join(DIST, '../shared/videoedit.js'));

/* Modul střihu potřebuje electron a databázi; zkouší se z něj jen stavba
 * příkazu, která na ničem z toho nezávisí — proto se obojí podstrčí. */
for (const [jmeno, exports] of [
  ['electron', { BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null }, dialog: {} }],
  ['../db.js', { getDb: () => ({}), getSetting: () => '', setSetting: () => {} }],
  ['../media.js', { findFfmpeg: async () => ({ ok: false, path: '', version: '', note: 'není' }) }],
  ['../ai.js', { ask: async () => '{}' }],
  ['../settings.js', { getSettings: () => ({ draftModel: 'x' }) }],
  ['./store.js', { sourceAccount: () => null, listMarkets: () => [], setPostMedia: () => {} }]
]) {
  const cesta = jmeno.startsWith('.')
    ? require.resolve(path.join(DIST, 'instagram', jmeno))
    : require.resolve(jmeno);
  require.cache[cesta] = { id: cesta, filename: cesta, loaded: true, exports };
}
const E = require(path.join(DIST, 'instagram/videoedit.js'));

const klip = (od, dokdy, prechod = 'zadny', delkaP = 0.5) => ({
  id: `k${od}-${dokdy}`, soubor: `/x/${od}-${dokdy}.mp4`, zdrojDelka: 60,
  od, do: dokdy, prechod, prechodDelka: delkaP
});

console.log('střih videa s titulky:\n');

/* ---------- 1) časová osa ---------- */

console.log('  časová osa');
{
  const klipy = [klip(0, 4), klip(2, 5)];
  const { místa, delka } = V.osa(klipy);
  check('dva záběry střihem jdou hned za sebou', [místa[0].start, místa[1].start], [0, 4]);
  check('délka je součet výstřižků', delka, 7);
}
{
  // Tři sekundy + čtyři s půlsekundovou prolínačkou = 6,5, ne 7
  const klipy = [klip(0, 3), klip(0, 4, 'prolinacka', 0.5)];
  const { místa, delka } = V.osa(klipy);
  check('přechod zkracuje výsledek o svou délku', delka, 6.5);
  check('druhý záběr začíná dřív, než první skončí', místa[1].start, 2.5);
  check('u prvního záběru žádný přechod není', místa[0].prechod, 0);
}
{
  /*
   * Přechod delší než záběr: `xfade` takový odmítne a hláška to neprozradí.
   * Musí se zkrátit na půlku kratší části.
   */
  const klipy = [klip(0, 1), klip(0, 1, 'prolinacka', 3)];
  const { místa, delka } = V.osa(klipy);
  check('přechod se zkrátí, aby se vešel', místa[1].prechod, 0.5);
  check('délka odpovídá zkrácenému přechodu', delka, 1.5);
}
{
  const klipy = [klip(0, 2), klip(0, 2, 'prolinacka', 0.05)];
  check('přechod pod desetinu sekundy se zahodí', V.osa(klipy).místa[1].prechod, 0);
}
{
  /*
   * Skupiny: střih se slepí natvrdo, přechod je jen mezi skupinami.
   * Tady to je [0,1] — [2] — [3,4].
   */
  const klipy = [klip(0, 2), klip(0, 3), klip(0, 4, 'cerna', 1), klip(0, 2, 'prolinacka', 0.5), klip(0, 2)];
  check('skupiny podle střihů', V.skupiny(klipy), [[0, 1], [2], [3, 4]]);
  const { místa, delka } = V.osa(klipy);
  // 2+3 = 5, přechod 1 → třetí začíná v 4, končí v 8; přechod 0,5 → čtvrtý
  // v 7,5, pátý v 9,5, konec 11,5
  check('starty přes skupiny', místa.map(m => m.start), [0, 2, 4, 7.5, 9.5]);
  check('celková délka přes dva přechody', delka, 11.5);
}

/* ---------- 2) shoda okna a ffmpegu ---------- */

console.log('\n  příkaz pro ffmpeg');
{
  const klipy = [klip(0, 3), klip(1, 5, 'prolinacka', 0.5)];
  const { místa, delka } = V.osa(klipy);
  const plan = {
    klipy: klipy.map(k => ({ soubor: k.soubor, od: k.od, do: k.do, zvuk: true })),
    prechody: klipy.map((k, i) => ({ xfade: V.PRECHODY[k.prechod].xfade, delka: místa[i].prechod })),
    overlays: [{ soubor: '/x/t0.png', od: 0.5, do: 2 }],
    sirka: 1080, vyska: 1920, delka,
    zvuk: { druh: 'original' }, zvukVstup: -1
  };
  const { filtr, video, audio } = E.__test.stavbaFiltru(plan);

  ok('záběr se ustřihne ve zdroji', filtr.includes('[1:v]trim=start=1.000:end=5.000'), filtr);
  ok('formát se srovná ořezem, ne černými pruhy',
    filtr.includes('force_original_aspect_ratio=increase,crop=1080:1920'), filtr);
  /*
   * Tohle je jádro celé zkoušky: `offset` musí být start druhé skupiny
   * spočítaný `osou()`. Když se rozejde, titulky v náhledu sedí a ve videu ne.
   */
  ok(`offset přechodu je start druhé skupiny (${místa[1].start})`,
    filtr.includes(`xfade=transition=fade:duration=0.500:offset=${místa[1].start.toFixed(3)}`), filtr);
  ok('titulek se přiloží podle času ve výsledku',
    filtr.includes("overlay=0:0:eof_action=repeat:enable='between(t,0.500,2.000)'"), filtr);
  ok('zvuk se prolne stejně dlouho jako obraz', filtr.includes('acrossfade=d=0.500'), filtr);
  ok('poslední proud obrazu je ten s titulkem', video === 'o0', video);
  ok('zvuk má svůj proud', !!audio, audio);

  const args = E.__test.ffmpegArgy(plan, '/tmp/out.mp4');
  check('vstupy v pořadí záběry, pak titulky',
    args.filter((a, i) => args[i - 1] === '-i'),
    ['/x/0-3.mp4', '/x/1-5.mp4', '/x/t0.png']);
  ok('délka výstupu je uříznutá na spočítanou', args.includes(delka.toFixed(3)), args.join(' '));
  ok('hlavička putuje na začátek souboru (Meta jinak video nepřečte)',
    args.includes('+faststart'), args.join(' '));
}

/* ---------- 3) záběr bez zvuku ---------- */

console.log('\n  záběr bez zvukové stopy');
{
  const klipy = [klip(0, 3), klip(0, 2, 'prolinacka', 0.4)];
  const { místa, delka } = V.osa(klipy);
  const plan = {
    // Druhý je znělka s logem — zvukovou stopu nemá
    klipy: [{ soubor: 'a.mp4', od: 0, do: 3, zvuk: true }, { soubor: 'logo.mp4', od: 0, do: 2, zvuk: false }],
    prechody: klipy.map((k, i) => ({ xfade: V.PRECHODY[k.prechod].xfade, delka: místa[i].prechod })),
    overlays: [], sirka: 1080, vyska: 1920, delka,
    zvuk: { druh: 'original' }, zvukVstup: -1
  };
  const { filtr } = E.__test.stavbaFiltru(plan);
  ok('místo chybějící stopy se podloží ticho', filtr.includes('anullsrc'), filtr);
  ok('nad neexistující stopou se atrim nepouští',
    !filtr.includes('[1:a]atrim'), filtr);
}

/* ---------- 4) vlastní zvuk ---------- */

console.log('\n  vlastní zvuk');
{
  const plan = {
    klipy: [{ soubor: 'a.mp4', od: 0, do: 8, zvuk: true }],
    prechody: [{ xfade: '', delka: 0 }],
    overlays: [], sirka: 1080, vyska: 1920, delka: 8,
    zvuk: { druh: 'soubor', soubor: 'hudba.mp3', od: 10, do: 14, hlasitost: 0.8 },
    zvukVstup: 1
  };
  const { filtr } = E.__test.stavbaFiltru(plan);
  ok('hudba se vystřihne od–do', filtr.includes('[1:a]atrim=start=10.000:end=14.000'), filtr);
  ok('hlasitost se nastaví', filtr.includes('volume=0.80'), filtr);
  /*
   * Krátká hudba nesmí uříznout obraz: `-shortest` platí na celý výstup,
   * takže z osmi sekund videa by zůstaly čtyři. Doplněné ticho je menší zlo.
   */
  ok('kratší hudba se doplní tichem, ne uříznutím obrazu',
    filtr.includes('apad,atrim=duration=8.000'), filtr);
  ok('na konci zvuk doznívá', filtr.includes('afade=t=out'), filtr);

  const bezZvuku = E.__test.ffmpegArgy({ ...plan, zvuk: { druh: 'ticho' }, zvukVstup: -1 }, '/tmp/x.mp4');
  ok('bez zvuku se stopa vůbec nezakládá', bezZvuku.includes('-an'), bezZvuku.join(' '));
}

/* ---------- 5) co brání vykreslení ---------- */

console.log('\n  kontrola před vykreslením');
{
  const zaklad = {
    postId: 1, pomer: '9:16', zdroj: 'CS', klipy: [klip(0, 5)], trhy: {}, hotovo: {}, doMrizky: true,
    titulky: [{ id: 't1', od: 0, do: 2, styl: 'klasik', pozice: 'dole', texty: { CS: 'Ahoj 👋' } }]
  };
  check('hotový projekt projde', V.potize(zaklad, ['CS']), []);
  check('bez záběru se nedá nic vykreslit',
    V.potize({ ...zaklad, klipy: [] }, ['CS']), ['Zatím tu není žádný záběr.']);
  ok('titulek za koncem videa se pozná',
    V.potize({ ...zaklad, titulky: [{ ...zaklad.titulky[0], od: 9, do: 11 }] }, ['CS'])
      .some(x => x.includes('za koncem')));
  /*
   * Dva titulky na témže místě se v obraze slijí do nečitelné kaše.
   * ffmpeg to udělá bez mrknutí, takže to musí zachytit kontrola.
   */
  ok('překryté titulky na stejné pozici se poznají',
    V.potize({
      ...zaklad,
      titulky: [
        { id: 'a', od: 0, do: 3, styl: 'klasik', pozice: 'dole', texty: { CS: 'první' } },
        { id: 'b', od: 2, do: 4, styl: 'klasik', pozice: 'dole', texty: { CS: 'druhý' } }
      ]
    }, ['CS']).some(x => x.includes('překrývají')));
  ok('titulky nad sebou v různých pásech se neplácají',
    V.potize({
      ...zaklad,
      titulky: [
        { id: 'a', od: 0, do: 3, styl: 'klasik', pozice: 'dole', texty: { CS: 'první' } },
        { id: 'b', od: 2, do: 4, styl: 'klasik', pozice: 'nahore', texty: { CS: 'druhý' } }
      ]
    }, ['CS']).length === 0);
}

/* ---------- 6) texty pro trhy ---------- */

console.log('\n  texty pro trhy');
{
  const t = { id: 't', od: 0, do: 2, styl: 'klasik', pozice: 'dole', texty: { CS: 'Nové kravaty', EN: 'New ties' } };
  check('trh má svůj text', V.textTitulku(t, 'EN', 'CS'), 'New ties');
  /*
   * Nepřeložený trh dostane zdrojový text. Prázdné místo v obraze by bylo
   * horší: video vyjde, jen v něm nic nestojí, a to se pozná až venku.
   */
  check('nepřeložený trh použije zdroj', V.textTitulku(t, 'DE', 'CS'), 'Nové kravaty');
  check('prázdný text trhu se nebere jako překlad',
    V.textTitulku({ ...t, texty: { CS: 'Nové kravaty', DE: '   ' } }, 'DE', 'CS'), 'Nové kravaty');
}

/* ---------- 7) záběry a zvuk podle trhu ---------- */

console.log('\n  vlastní verze pro trh');
{
  const p = {
    postId: 1, pomer: '9:16', zdroj: 'CS', titulky: [], hotovo: {}, doMrizky: true,
    klipy: [klip(0, 5)],
    trhy: { DE: { klipy: [klip(0, 3)], zvuk: { druh: 'soubor', soubor: 'de.mp3' } } }
  };
  check('trh bez vlastních bere společné', V.klipyTrhu(p, 'EN').length, 1);
  check('trh s vlastními bere své', V.klipyTrhu(p, 'DE')[0].do, 3);
  check('zvuk podle trhu', V.zvukTrhu(p, 'DE').druh, 'soubor');
  check('trh bez zvuku má originál', V.zvukTrhu(p, 'EN').druh, 'original');
  // Prázdný seznam vlastních záběrů se nesmí tvářit jako „trh nemá nic"
  check('prázdné vlastní záběry padnou zpět na společné',
    V.klipyTrhu({ ...p, trhy: { DE: { klipy: [] } } }, 'DE').length, 1);
}

/* ---------- 8) opravdové vykreslení ---------- */

/*
 * Až sem se zkoušely řetězce. Řetězec ale může být celý správně a video
 * přesto vyjde špatně: `xfade` odmítne přechod, `overlay` přiloží titulek
 * o sekundu jinam, `acrossfade` utne konec. Proto se tady pustí **skutečný
 * ffmpeg** nad opravdovými soubory a výsledek se změří.
 *
 * Zkouší se to na drobném rozlišení a na pár sekundách, ať to netrvá.
 * Bez ffmpegu se tahle část přeskočí — na sestavovacím stroji být nemusí.
 */
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');

function najdiFfmpeg() {
  for (const kandidat of ['ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']) {
    const r = spawnSync(kandidat, ['-version'], { encoding: 'utf8' });
    if (!r.error && r.status === 0) return kandidat;
  }
  return '';
}

const FF = najdiFfmpeg();
console.log('\n  opravdové vykreslení');
if (!FF) {
  console.log('  · přeskočeno — ffmpeg v tomhle počítači není');
} else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quentino-videozk-'));
  const ff = (args) => execFileSync(FF, ['-v', 'error', '-y', ...args], { encoding: 'utf8' });

  /* Tři záběry: červený se zvukem, modrý se zvukem, zelený bez zvuku */
  const zdroj = (jmeno, barva, sekund, zvuk) => {
    const soubor = path.join(dir, jmeno);
    const args = ['-f', 'lavfi', '-i', `color=c=${barva}:s=180x320:d=${sekund}:r=30`];
    if (zvuk) args.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=${sekund}`, '-c:a', 'aac');
    else args.push('-an');
    ff([...args, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-t', String(sekund), soubor]);
    return soubor;
  };
  const cerveny = zdroj('cerveny.mp4', 'red', 3, true);
  const modry = zdroj('modry.mp4', 'blue', 3, true);
  const zeleny = zdroj('zeleny.mp4', 'green', 2, false);

  /* Titulek: místo písma neprůhledný bílý obdélník na celý obraz. Takhle
   * se dá změřit, ve které sekundě se v obraze objevil — o písmenech by to
   * z rawvidea nikdo nepoznal. */
  const titulek = path.join(dir, 'titulek.png');
  ff(['-f', 'lavfi', '-i', 'color=c=white:s=180x320', '-frames:v', '1', titulek]);

  const klipy = [klip(0, 2), klip(0, 2, 'prolinacka', 1), klip(0, 1.5)];
  klipy[0].soubor = cerveny; klipy[1].soubor = modry; klipy[2].soubor = zeleny;
  const { místa, delka } = V.osa(klipy);
  // 2 + 2 − 1 (přechod) + 1,5 = 4,5
  check('spočítaná délka tří záběrů s jedním přechodem', delka, 4.5);

  const plan = {
    klipy: [
      { soubor: cerveny, od: 0, do: 2, zvuk: true },
      { soubor: modry, od: 0, do: 2, zvuk: true },
      { soubor: zeleny, od: 0, do: 1.5, zvuk: false }
    ],
    prechody: klipy.map((k, i) => ({ xfade: V.PRECHODY[k.prechod].xfade, delka: místa[i].prechod })),
    overlays: [{ soubor: titulek, od: 3.2, do: 3.8 }],
    sirka: 180, vyska: 320, delka,
    zvuk: { druh: 'original' }, zvukVstup: -1
  };

  const cil = path.join(dir, 'vysledek.mp4');
  let padlo = '';
  try {
    execFileSync(FF, ['-v', 'error', ...E.__test.ffmpegArgy(plan, cil)], { encoding: 'utf8' });
  } catch (e) {
    padlo = String(e.stderr || e.message).slice(0, 300);
  }
  ok('ffmpeg příkaz přijme a video vyrobí', !padlo && fs.existsSync(cil), padlo);

  if (!padlo && fs.existsSync(cil)) {
    const vypis = spawnSync(FF, ['-hide_banner', '-i', cil], { encoding: 'utf8' }).stderr;
    const d = /Duration:\s*(\d+):(\d\d):(\d\d(?:\.\d+)?)/.exec(vypis);
    const skutecna = d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0;
    ok(`délka výsledku odpovídá spočítané (${skutecna} ≈ ${delka})`,
      Math.abs(skutecna - delka) < 0.2, `${skutecna} s`);
    ok('výsledek má zvukovou stopu i přes záběr bez zvuku',
      /Stream #\d+:\d+[^\n]*: Audio:/.test(vypis), vypis.slice(0, 200));

    /** Barva pixelu ze středu obrazu v daném čase. */
    const pixel = (t) => {
      const raw = execFileSync(FF, ['-v', 'error', '-ss', String(t), '-i', cil,
        '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
        { maxBuffer: 1 << 22 });
      const stred = ((320 / 2) * 180 + 90) * 3;
      return [raw[stred], raw[stred + 1], raw[stred + 2]];
    };

    const prvni = pixel(0.5);
    ok('první záběr je v obraze', prvni[0] > 150 && prvni[2] < 90, prvni.join(','));

    /*
     * Uprostřed přechodu nesmí být ani čistě první, ani čistě druhý záběr.
     * Tohle je jediná zkouška, která opravdu dokáže, že se přechod stal —
     * a stal se tam, kde ho okno kreslí do časové osy (v 1,5 s).
     */
    const vPrechodu = pixel(místa[1].start + místa[1].prechod / 2);
    ok(`uprostřed přechodu (${místa[1].start + místa[1].prechod / 2} s) se barvy míchají`,
      vPrechodu[0] > 40 && vPrechodu[0] < 200 && vPrechodu[2] > 40, vPrechodu.join(','));

    const druhy = pixel(2.5);
    ok('po přechodu je v obraze druhý záběr', druhy[2] > 150 && druhy[0] < 90, druhy.join(','));
    /*
     * Třetí záběr navazuje tvrdým střihem, takže patří do téže skupiny
     * jako druhý a začíná ve 3 s — ne ve 3,5, jak by vyšlo, kdyby se
     * přechod nezapočítal. Právě tímhle se pozná, že `concat` a `xfade`
     * sedí na stejné časové ose jako okno.
     */
    const treti = pixel(4.0);
    ok('třetí záběr navazuje střihem tam, kde ho čeká časová osa',
      treti[1] > 90 && treti[0] < 90 && treti[2] < 90, treti.join(','));

    /*
     * A titulek: v obraze musí být přesně v okně 3,2–3,8 s. Posunutý
     * titulek je nejčastější chyba celého střihu a na hotovém videu se
     * pozná až po zveřejnění.
     */
    const vTitulku = pixel(3.5);
    ok('titulek je v obraze, když má být', vTitulku.every(v => v > 200), vTitulku.join(','));
    const predTitulkem = pixel(2.9);
    ok('a před svým časem v obraze není', !predTitulkem.every(v => v > 200), predTitulkem.join(','));
    const zaTitulkem = pixel(4.2);
    ok('ani po něm', !zaTitulkem.every(v => v > 200), zaTitulkem.join(','));
  }

  /*
   * Vlastní zvuk kratší než video. `apad` má doplnit ticho; kdyby tam
   * nebyl, `-shortest` by celý výstup uřízl na délku hudby a z pěti
   * sekund by zůstaly dvě. Zkouší se proto délka, ne to, jak to zní.
   */
  {
    const hudba = path.join(dir, 'hudba.m4a');
    ff(['-f', 'lavfi', '-i', 'sine=frequency=330:duration=2', '-c:a', 'aac', hudba]);
    const plan2 = {
      klipy: [{ soubor: cerveny, od: 0, do: 3, zvuk: true }],
      prechody: [{ xfade: '', delka: 0 }],
      overlays: [], sirka: 180, vyska: 320, delka: 3,
      zvuk: { druh: 'soubor', soubor: hudba, od: 0, do: 2, hlasitost: 0.9 },
      zvukVstup: 1
    };
    const cil2 = path.join(dir, 'shudbou.mp4');
    let potiz = '';
    try {
      execFileSync(FF, ['-v', 'error', ...E.__test.ffmpegArgy(plan2, cil2)], { encoding: 'utf8' });
    } catch (e) { potiz = String(e.stderr || e.message).slice(0, 200); }
    ok('video s vlastní hudbou se vykreslí', !potiz, potiz);
    if (!potiz) {
      const vypis2 = spawnSync(FF, ['-hide_banner', '-i', cil2], { encoding: 'utf8' }).stderr;
      const d2 = /Duration:\s*(\d+):(\d\d):(\d\d(?:\.\d+)?)/.exec(vypis2);
      const skutecna2 = d2 ? Number(d2[2]) * 60 + Number(d2[3]) : 0;
      ok(`kratší hudba nezkrátila obraz (${skutecna2} ≈ 3)`, Math.abs(skutecna2 - 3) < 0.2, `${skutecna2} s`);
    }
  }

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* úklid není kritický */ }
}

console.log(failed
  ? `\n${failed} věcí nesedí`
  : '\nstřih videa: časová osa, příkaz i opravdové vykreslení sedí');
process.exit(failed ? 1 : 0);
