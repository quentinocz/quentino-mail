/**
 * Zkouška focení — bez fotoaparátu, zato se skutečným protokolem.
 *
 * Fotoaparát tady není a nikdy nebude, takže se místo něj spustí
 * `tools/fake-gphoto2.cjs`, který mluví přesně tak jako gphoto2 2.5.28.
 * Zkouší se to, co rozhoduje o výsledku a co se okem nepozná:
 *
 *  1. **konec odpovědi** — shell nevrací návratový kód, konec se pozná jen
 *     podle výzvy; při chybě v tom se fronta zasekne a náhled zamrzne,
 *  2. **jména stažených souborů** — při RAW+JPEG přijdou dva a RAW musí
 *     skončit vedle JPEGu, ne místo něj,
 *  3. **rozbor nabídky voleb** — hodnota s mezerou („Large Fine JPEG")
 *     a hodnota s lomítkem („1/125") se dělí jinak než ostatní,
 *  4. **zpětné čtení po nastavení** — tělo hodnotu často přijme a tiše dá
 *     jinou; bez zpětného čtení by v aplikaci svítila lež,
 *  5. **chyba jako chyba** — `*** Error ***` nesmí projít jako odpověď,
 *  6. **časový limit** — tělo, které přestane odpovídat, nesmí zavěsit celé
 *     focení,
 *  7. **korekce barev** — bílé pozadí se má vybělit, světlá látka ne.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DIST, db } = require('./ptrans/harness.cjs');

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

const gphoto = require(path.join(DIST, 'shoot/gphoto.js'));
const session = require(path.join(DIST, 'shoot/session.js'));
const config = require(path.join(DIST, 'shoot/config.js'));
const live = require(path.join(DIST, 'shoot/live.js'));
const store = require(path.join(DIST, 'shoot/store.js'));
db.exec(store.SCHEMA);

console.log('\nfocení:\n');

/* ---------- rozbor výpisů ---------- */

{
  const rows = gphoto.__test.parseCameras([
    'Model                          Port',
    '----------------------------------------------------------',
    'Canon EOS 250D                 usb:001,004',
    'Nikon DSC D3300 (PTP mode)     usb:001,007',
    ''
  ].join('\n'));
  check('dvě těla ze seznamu', rows.length, 2);
  // Model má sám mezery, takže se dělí odzadu podle portu, ne prvním oddělovačem
  check('model s mezerami zůstal celý', rows[0], { model: 'Canon EOS 250D', port: 'usb:001,004' });
  check('model se závorkou taky', rows[1].model, 'Nikon DSC D3300 (PTP mode)');
  check('hlavička tabulky není tělo', gphoto.__test.parseCameras('Model  Port\n----\n').length, 0);
}

{
  const raw = 'gphoto2: {/tmp} /> list-config\nlist-config\n/main/imgsettings/iso\n\ngphoto2: {/tmp} /> ';
  check('ozvěna i výzva pryč', session.__test.strip(raw, 'list-config'), '/main/imgsettings/iso');
}

{
  const err = '*** Error (-53: \'Could not claim the USB device\') ***\n'
    + 'An error occurred in the io-library.\nFor debugging messages, please use --debug';
  check('chyba i s důvodem pod ní',
    session.__test.errorIn(err, ''),
    "-53: 'Could not claim the USB device' — An error occurred in the io-library.");
  check('čistý výpis chybu nehlásí', session.__test.errorIn('Saving file as a.jpg', ''), '');
  // Chyba občas přijde jen na chybový výstup, ne do odpovědi
  ok('chyba ze stderr se najde', !!session.__test.errorIn('', '*** Error ***\nCould not claim.'));
}

{
  const text = [
    'New file is in location /store/DCIM/IMG_1001.CR3 on the camera',
    'Saving file as IMG_1001.CR3',
    'New file is in location /store/DCIM/IMG_1001.JPG on the camera',
    'Saving file as IMG_1001.JPG'
  ].join('\n');
  check('RAW i JPEG z jednoho zmáčknutí',
    session.__test.savedFiles(text), ['IMG_1001.CR3', 'IMG_1001.JPG']);
}

/* ---------- nabídka voleb ---------- */

{
  const text = [
    '/main/imgsettings/imageformat',
    'Label: Image Format',
    'Readonly: 0',
    'Type: RADIO',
    'Current: Large Fine JPEG',
    'Choice: 0 Large Fine JPEG',
    'Choice: 1 RAW + Large Fine JPEG',
    'Choice: 2 ',
    'END',
    '/main/capturesettings/exposurecompensation',
    'Label: Exposure Compensation',
    'Readonly: 0',
    'Type: RANGE',
    'Current: 0',
    'Bottom: -3',
    'Top: 3',
    'Step: 0.333333',
    'END'
  ].join('\n');
  const list = config.__test.parseConfig(text);
  check('dva odstavce', list.length, 2);
  // Hodnota s mezerami se dělí jen na prvním oddělovači za číslem volby
  check('volba s mezerami zůstala celá', list[0].choices[1].value, 'RAW + Large Fine JPEG');
  check('prázdná volba se zahodila', list[0].choices.length, 2);
  check('současná hodnota i s mezerami', list[0].value, 'Large Fine JPEG');
  check('rozsah má meze i krok',
    [list[1].bottom, list[1].top, list[1].step], [-3, 3, 0.333333]);
}

{
  const one = config.__test.parseOne(
    'Label: ISO Speed\nReadonly: 0\nType: RADIO\nCurrent: 400\nChoice: 0 Auto\nChoice: 1 400',
    '/main/imgsettings/iso');
  // `get-config` vrací odstavec bez cesty a bez END — parser si obojí doplní
  check('odpověď na get-config se přečte', [one.path, one.name, one.value], ['/main/imgsettings/iso', 'iso', '400']);
}

{
  const paths = [
    '/main/actions/autofocusdrive', '/main/status/batterylevel',
    '/main/imgsettings/iso', '/main/capturesettings/aperture',
    '/main/capturesettings/shutterspeed', '/main/other/d402'
  ];
  const handy = config.__test.handyPaths(paths);
  check('běžné volby v pořadí podle použití',
    handy.map(one => one.label), ['ISO', 'Clona', 'Čas']);
  check('ISO je ve skupině expozice', handy[0].group, 'expozice');
  const rest = config.__test.restPaths(paths);
  ok('spoušť ani ostření se nenabízí', !rest.includes('/main/actions/autofocusdrive'), rest.join(' '));
  ok('zbytek stromu zůstal', rest.includes('/main/other/d402') && rest.includes('/main/status/batterylevel'));
  check('jen na čtení se nedá nastavit',
    config.__test.settable({ readonly: true, type: 'RADIO', choices: [{ index: 0, value: 'a' }] }), false);
  check('volba bez voleb se nedá nastavit',
    config.__test.settable({ readonly: false, type: 'RADIO', choices: [] }), false);
}

/* ---------- názvy souborů ---------- */

{
  const shoot = { name: 'Kravaty hedvábí 2026' };
  check('název focení dá jméno souboru',
    require(path.join(DIST, 'shoot/index.js')).__test.targetName(shoot, 7, '.CR3'),
    'kravaty-hedvabi-2026-007.CR3');
  check('focení bez názvu má aspoň něco',
    require(path.join(DIST, 'shoot/index.js')).__test.targetName({ name: '   ' }, 1, 'jpg'),
    'foceni-001.jpg');
  const np = require(path.join(DIST, 'shoot/index.js')).__test;
  check('CR3 je RAW, JPG ne', [np.isRaw('a.CR3'), np.isRaw('a.NEF'), np.isRaw('a.JPG')], [true, true, false]);
}

/* ---------- uložená focení ---------- */

{
  const made = store.newShoot('Kravaty', '/tmp/x');
  ok('nové focení má název i datum', made.name === 'Kravaty' && !!made.createdAt);
  check('bez názvu se doplní datum', store.newShoot('', '').name.startsWith('Focení '), true);

  store.saveShoot(made.id, {
    overlay: [{ id: 'a', kind: 'rect', x: 0.1, y: 0.1, x2: 0.9, y2: 0.9, color: '#fff', width: 2 }],
    ghost: { file: '/tmp/g.jpg', opacity: 55, mirror: true },
    webp: true, webpQuality: 90
  });
  const back = store.getShoot(made.id);
  // Vodítka i průsvitka musí přežít zavření aplikace — od toho se focení ukládá
  check('vodítko se vrátilo tak, jak bylo', back.overlay[0].x2, 0.9);
  check('průsvitka taky', [back.ghost.opacity, back.ghost.mirror], [55, true]);
  check('WebP se pamatuje', [back.webp, back.webpQuality], [true, 90]);

  const a = store.addPhoto(made.id, { file: '/tmp/a.jpg', raw: '/tmp/a.cr3' });
  const b = store.addPhoto(made.id, { file: '/tmp/b.jpg' });
  check('fotky se řadí, jak přišly', store.listPhotos(made.id).map(one => one.sort), [1, 2]);
  check('RAW se drží bokem, ne místo JPEGu', store.getPhoto(a.id).raw, '/tmp/a.cr3');
  store.dropPhoto(b.id);
  check('vyřazená fotka zmizela', store.listPhotos(made.id).length, 1);
}

/* ---------- živé spojení s falešným gphoto2 ---------- */

const fake = path.join(__dirname, 'fake-gphoto2.cjs');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shoot-'));

/*
 * gphoto2 je skript pro node, ne binárka. Cesta se proto podstrčí jako
 * spouštěč i s argumentem — jinak by se musela do repozitáře dávat
 * zkompilovaná náhrada.
 */
const wrapper = path.join(work, 'gphoto2');
fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`);
fs.chmodSync(wrapper, 0o755);

(async () => {
  const tool = await (async () => {
    const { setSetting } = require(path.join(DIST, 'db.js'));
    setSetting('shootGphoto', wrapper);
    return gphoto.findGphoto();
  })();
  check('falešný gphoto2 se našel', [tool.ok, tool.version], [true, 'gphoto2 2.5.28']);

  const cameras = await gphoto.detectCameras();
  check('tělo se ohlásilo', cameras[0], { model: 'Canon EOS 250D', port: 'usb:001,004' });

  const talk = new session.CameraSession();
  // Pracovní složka je jinde než ta z Electronu — v testu žádná aplikace není
  Object.defineProperty(talk, 'dir', { value: work });
  const opened = await talk.open('usb:001,004', 'Canon EOS 250D');
  check('spojení se otevřelo', opened, true);

  const listed = await talk.send('list-config');
  ok('seznam voleb dorazil celý', listed.ok && listed.text.split('\n').length === 14, String(listed.text.split('\n').length));

  const bad = await talk.send('bogus');
  check('neznámý příkaz je chyba', [bad.ok, bad.error.includes('not known')], [false, true]);

  /*
   * Druhý příkaz po chybě musí projít. Kdyby se chybová odpověď ve frontě
   * zasekla, focení by po první chybě přestalo reagovat úplně.
   */
  const after = await talk.send('get-config /main/imgsettings/iso');
  check('po chybě se dá pokračovat', after.ok, true);
  check('ISO je 100', config.parseOne(after.text, '/main/imgsettings/iso').value, '100');

  // Hodnota s lomítkem a mezerou musí projít nerozdělená
  await talk.send('set-config-value /main/imgsettings/imageformat=RAW + Large Fine JPEG');
  const format = config.parseOne(
    (await talk.send('get-config /main/imgsettings/imageformat')).text, '/main/imgsettings/imageformat');
  check('formát s mezerami se nastavil', format.value, 'RAW + Large Fine JPEG');

  /*
   * Tělo hodnotu přijalo, ale dalo jinou — přesně proto se čte zpátky.
   * Bez toho by v aplikaci svítil čas, kterým se nefotí.
   */
  await talk.send('set-config-value /main/capturesettings/shutterspeed=1/200');
  const speed = config.parseOne(
    (await talk.send('get-config /main/capturesettings/shutterspeed')).text,
    '/main/capturesettings/shutterspeed');
  check('tělo dalo jiný čas, než jsme chtěli', speed.value, '1/60');

  const preview = await talk.send('capture-preview');
  const frame = live.__test.readFrame(path.join(work, 'nic.jpg'), preview.text, work);
  ok('snímek náhledu je obrázek', frame && frame[0] === 0xff && frame[1] === 0xd8,
    frame ? `${frame.length} B` : 'nic');

  const shot = await talk.send('capture-image-and-download');
  const made = session.__test.savedFiles(shot.text);
  // Formát je RAW+JPEG, takže musí přijít oba soubory
  check('RAW i JPEG se stáhly', made, ['IMG_1001.JPG', 'IMG_1001.CR3']);
  ok('a oba jsou na disku', made.every(name => fs.existsSync(path.join(work, name))));

  /*
   * Tělo, které přestane odpovídat. Spojení se musí samo ukončit a čekající
   * příkaz dostat odpověď — jinak by focení tiše zamrzlo a nešlo by poznat,
   * že se něco stalo.
   */
  const stuck = await talk.send('hang', { timeout: 600 });
  check('mlčící tělo neuvízne', [stuck.ok, talk.alive], [false, false]);
  ok('a je poznat proč', talk.lastError.includes('hang'), talk.lastError);

  talk.close();

  /* ---------- korekce barev ---------- */

  /*
   * Korekce barev bydlí v okně (`src/renderer`), takže ji `tsc -p
   * tsconfig.main.json` nepřeloží — musí se přeložit zvlášť. esbuild je
   * v repozitáři jen jako závislost Vite, ne přímá; když ho tam npm
   * uklidí jinam, zkouška se přeskočí místo toho, aby spadla celá
   * kontrola. Přesně tohle už jednou udělal chybějící playwright.
   */
  let fix = null;
  try {
    const esbuild = require('esbuild');
    const outFile = path.join(work, 'fix.cjs');
    esbuild.buildSync({
      entryPoints: [path.join(__dirname, '../src/renderer/src/shoot/fix.ts')],
      outfile: outFile, bundle: true, format: 'cjs', platform: 'node', logLevel: 'silent'
    });
    fix = require(outFile);
  } catch (error) {
    console.log('  – korekce barev přeskočena (esbuild není):', error.message.split('\n')[0]);
  }

  if (fix) {

  check('zelené světlo se srovná',
    Object.values(fix.whiteGains({ r: 200, g: 230, b: 200 })).map(one => one.toFixed(3)),
    ['1.050', '0.913', '1.050']);
  // Bez omezení by klik do tmavého stínu barvy úplně rozhodil
  const wild = fix.whiteGains({ r: 10, g: 200, b: 200 });
  check('zesílení se nepustí přes dvojnásobek', wild.r, 2);

  const blank = { on: true, white: '', exposure: 0, contrast: 0, saturation: 0,
    temperature: 0, background: 0, backgroundLevel: 242, preset: '' };

  {
    /*
     * Tři body vedle sebe: papír jistě nad prahem (250), papír těsně nad
     * prahem (244) a světlá látka pod prahem (232). Bělit se má jen to
     * první úplně, druhé částečně — přechod je tam schválně, aby kolem
     * produktu nevznikl ostrý obrys — a třetí vůbec.
     */
    const pixels = new Uint8ClampedArray([
      250, 251, 250, 255,
      244, 245, 244, 255,
      232, 230, 228, 255
    ]);
    fix.applyFix(pixels, { ...blank, background: 100, backgroundLevel: 242 });
    check('papír nad prahem je čistá bílá', [pixels[0], pixels[1], pixels[2]], [255, 255, 255]);
    ok('papír těsně nad prahem se bělí jen zčásti',
      pixels[4] > 244 && pixels[4] < 255, String(pixels[4]));
    ok('světlá látka pod prahem zůstala', pixels[8] === 232, String(pixels[8]));
  }

  {
    // Poloviční síla znamená poloviční cestu k bílé, ne bílou
    const pixels = new Uint8ClampedArray([250, 250, 250, 255]);
    fix.applyFix(pixels, { ...blank, background: 50, backgroundLevel: 242 });
    ok('poloviční dočištění je poloviční', pixels[0] > 250 && pixels[0] < 255, String(pixels[0]));
  }

  {
    /*
     * Sytě žlutá má vysoký jas, ale nízkou modrou. Kdyby se bělilo podle
     * jasu, zmizela by spolu s pozadím.
     */
    const pixels = new Uint8ClampedArray([250, 250, 120, 255]);
    fix.applyFix(pixels, { ...blank, background: 100, backgroundLevel: 242 });
    check('sytá žlutá se nevybělí', [pixels[0], pixels[1], pixels[2]], [250, 250, 120]);
  }

  {
    const pixels = new Uint8ClampedArray([100, 100, 100, 255]);
    fix.applyFix(pixels, { ...blank, on: false, exposure: 1 });
    check('vypnutá korekce nic nemění', pixels[0], 100);
  }

  {
    const pixels = new Uint8ClampedArray([100, 100, 100, 255]);
    fix.applyFix(pixels, { ...blank, exposure: 1 });
    check('o jeden EV výš je dvojnásobek', pixels[0], 200);
  }

  {
    /*
     * Obraz s namodralým papírem: bílá se má odečíst z pásma papíru, ne
     * z odlesku, a práh pozadí se má posadit pod něj.
     */
    const pixels = new Uint8ClampedArray(4000 * 4);
    for (let i = 0; i < pixels.length; i += 4) {
      const flare = i < 40 * 4;
      pixels[i] = flare ? 255 : 240;
      pixels[i + 1] = flare ? 255 : 242;
      pixels[i + 2] = flare ? 255 : 250;
      pixels[i + 3] = 255;
    }
    const guess = fix.autoFix(pixels);
    ok('bílá se odečetla z papíru, ne z odlesku', guess.white === '240,242,250', guess.white);
    ok('práh pozadí sedí pod papírem', guess.backgroundLevel < 240 && guess.backgroundLevel > 200,
      String(guess.backgroundLevel));
  }

  {
    // Tmavá fotka bez bílého pozadí — hádat bílou by znamenalo posunout barvy náhodně
    const dark = new Uint8ClampedArray(4000 * 4).fill(40);
    check('z tmavé fotky se bílá nehádá', fix.autoFix(dark).white, '');
  }

  check('předvolba „bílé pozadí" existuje', !!fix.preset('bile-pozadi'), true);
  check('neznámá předvolba nic nevrátí', fix.preset('nic'), null);
  }

  fs.rmSync(work, { recursive: true, force: true });
  console.log(failed ? `\n${failed} chyb\n` : '\nfocení sedí\n');
  process.exit(failed ? 1 : 0);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
