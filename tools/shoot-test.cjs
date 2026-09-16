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

/* ---------- náhled z RAW ---------- */

/*
 * Chromium CR2 ani CR3 neotevře, takže se z RAWu vytahuje JPEG, který do
 * něj uložil fotoaparát. Skládá se tady skutečná struktura TIFF — jen tak
 * se pozná, že se čtou správné značky a ne jen náhodná shoda bajtů.
 */
{
  const rawlib = require(path.join(DIST, 'shoot/preview.js'));

  /**
   * Obyčejný JPEG, jaký do RAWu ukládá fotoaparát.
   *
   * Značky musí mít platné délky, ne jen správný začátek — právě podle
   * nich se prochází až k popisu snímku (SOF0). Výplň o samých 0x55 by
   * se četla jako délka 21845 a skočilo by se mimo soubor.
   */
  const jpeg = (size) => {
    const body = Buffer.alloc(size, 0x55);
    let at = 0;
    const put = (bytes) => { Buffer.from(bytes).copy(body, at); at += bytes.length; };
    put([0xff, 0xd8]);                          // SOI
    put([0xff, 0xe0, 0x00, 0x10]);              // APP0 s délkou 16
    at += 14;
    put([0xff, 0xdb, 0x00, 0x08]); at += 6;     // DQT
    put([0xff, 0xc0, 0x00, 0x0b]);              // SOF0 — tuhle značku prohlížeč umí
    at += 9;
    put([0xff, 0xda, 0x00, 0x08]);              // SOS, za ním obrazová data
    Buffer.from([0xff, 0xd9]).copy(body, size - 2);
    return body;
  };

  /**
   * Poskládá CR2: hlavička TIFF, tabulka se značkami „kde leží pruhy
   * obrazu", a za ní dva JPEGy — malý náhled pro displej a velký pro
   * prohlížení. Vrátit se musí ten velký.
   */
  const makeCr2 = () => {
    const small = jpeg(2048);
    const large = jpeg(40000);
    const head = Buffer.alloc(200);
    head.write('II', 0, 'ascii');
    head.writeUInt16LE(42, 2);
    head.writeUInt32LE(16, 4);           // IFD0 začíná na 16

    // IFD#3 ukazuje na syrová data — taky „JPEG", ale bezztrátový a největší
    const senzor = lossless(120000);

    let at = 16;
    head.writeUInt16LE(2, at); at += 2;  // IFD0: velký náhled
    head.writeUInt16LE(0x0111, at); head.writeUInt32LE(200, at + 8); at += 12;
    head.writeUInt16LE(0x0117, at); head.writeUInt32LE(large.length, at + 8); at += 12;
    head.writeUInt32LE(at + 4, at);
    at += 4;

    head.writeUInt16LE(2, at); at += 2;  // IFD1: malý náhled pro displej
    head.writeUInt16LE(0x0111, at); head.writeUInt32LE(200 + large.length, at + 8); at += 12;
    head.writeUInt16LE(0x0117, at); head.writeUInt32LE(small.length, at + 8); at += 12;
    head.writeUInt32LE(at + 4, at);
    at += 4;

    head.writeUInt16LE(2, at); at += 2;  // IFD3: syrová data ze senzoru
    head.writeUInt16LE(0x0111, at);
    head.writeUInt32LE(200 + large.length + small.length, at + 8); at += 12;
    head.writeUInt16LE(0x0117, at); head.writeUInt32LE(senzor.length, at + 8); at += 12;
    head.writeUInt32LE(0, at);

    return Buffer.concat([head, large, small, senzor]);
  };

  /*
   * Bezztrátový JPEG, jak v CR2 leží syrová data ze senzoru: začíná
   * stejnou značkou jako obyčejný JPEG, ale má SOF3. Prohlížeč ho
   * neotevře — a protože je zdaleka největší, „vezmi ten největší" by
   * sáhl přesně po něm a v galerii by zůstala prázdná dlaždice.
   */
  const lossless = (size) => {
    const body = Buffer.alloc(size, 0x55);
    let at = 0;
    Buffer.from([0xff, 0xd8]).copy(body, at); at += 2;
    // DHT s hlavičkou délky, jak to má bezztrátový JPEG
    Buffer.from([0xff, 0xc4, 0x00, 0x04]).copy(body, at); at += 4;
    // SOF3 — právě tohle prohlížeč nezvládne
    Buffer.from([0xff, 0xc3, 0x00, 0x0b]).copy(body, at);
    Buffer.from([0xff, 0xd9]).copy(body, size - 2);
    return body;
  };

  check('bezztrátový JPEG prohlížeč nevykreslí',
    rawlib.__test.browserReadable(lossless(5000), 0, 5000), false);
  check('obyčejný ano', rawlib.__test.browserReadable(jpeg(5000), 0, 5000), true);

  const cr2 = makeCr2();
  const found = rawlib.__test.tiffJpegs(cr2);
  // Tři tabulky, ale syrová data se zahodí — vykreslit se nedají
  check('ze tří tabulek zbydou dva použitelné náhledy', found.length, 2);
  const out = rawlib.__test.embeddedJpeg(cr2);
  /*
   * Přesně ta chyba, na kterou to spadlo: vracela se syrová data (120 kB),
   * protože byla největší. Vrátit se musí náhled (40 kB).
   */
  check('vrací se náhled, ne syrová data ze senzoru', out.length, 40000);
  ok('a je to opravdu JPEG', out[0] === 0xff && out[1] === 0xd8
    && out[out.length - 2] === 0xff && out[out.length - 1] === 0xd9);

  /*
   * CR3 tabulku TIFF nemá — je zabalený jako video. Tam se soubor projde
   * a vezme nejdelší JPEG. Napodobí se to souborem bez hlavičky TIFF.
   */
  const cr3 = Buffer.concat([
    Buffer.from('ftypcrx ', 'ascii'), Buffer.alloc(64, 7),
    jpeg(3000), Buffer.alloc(128, 9), jpeg(30000)
  ]);
  check('v CR3 se hledá průchodem', rawlib.__test.tiffJpegs(cr3).length, 0);
  check('a najde se ten největší', rawlib.__test.embeddedJpeg(cr3).length, 30000);

  /*
   * Syrová data obsahují `ffd8` náhodou každou chvíli. Bez kontroly, co za
   * ním následuje, by se vracel nesmysl — a v galerii by svítil rozbitý
   * obrázek, u kterého nikdo nepozná proč.
   */
  const sum = Buffer.concat([Buffer.alloc(4, 0), Buffer.from([0xff, 0xd8, 0x12, 0x34]), Buffer.alloc(9000, 3)]);
  check('náhodné ffd8 v datech se nebere', rawlib.__test.scanJpegs(sum).length, 0);

  check('malý drobek se nebere', rawlib.__test.biggest([{ start: 0, length: 300 }]), null);
  check('JPG není RAW', rawlib.__test.isRawFile('/x/a.JPG'), false);
  check('CR2 je RAW', rawlib.__test.isRawFile('/x/a.CR2'), true);

  // Poškozený soubor nesmí zacyklit smyčku přes tabulky
  const cyklus = Buffer.alloc(64);
  cyklus.write('II', 0, 'ascii');
  cyklus.writeUInt16LE(42, 2);
  cyklus.writeUInt32LE(16, 4);
  cyklus.writeUInt16LE(0, 16);
  cyklus.writeUInt32LE(16, 18);   // tabulka odkazuje sama na sebe
  check('poškozený soubor nezacyklí', rawlib.__test.tiffJpegs(cyklus).length, 0);
}

/* ---------- živé spojení s falešným gphoto2 ---------- */

const fake = path.join(__dirname, 'fake-gphoto2.cjs');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shoot-'));

/**
 * Rozhovor s gphoto2 se zkouší jen tam, kde gphoto2 existuje.
 *
 * Falešný gphoto2 je skript pro node, ne binárka, takže se spouští přes
 * `#!/bin/sh`. Na Windows takový spouštěč nejde — a `.cmd` by nepomohlo,
 * protože `execFile` ho od Node 18 bez shellu odmítá. Hlavně ale **gphoto2
 * pro Windows vůbec neexistuje**: tahle část aplikace se tam nikdy
 * nespustí, takže ověřovat ji tam znamená zkoušet něco, co se nemůže stát.
 * Na Windows se místo toho fotí přes webkameru a tu obsluhuje okno samo.
 *
 * Rozbor výpisů — konec odpovědi, chyby, jména souborů, nabídka voleb —
 * běží všude; ten na systému nezávisí.
 */
const CAN_SPAWN = process.platform !== 'win32';

const wrapper = path.join(work, 'gphoto2');
if (CAN_SPAWN) {
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`);
  fs.chmodSync(wrapper, 0o755);
}

async function liveSection() {
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
  // `every` na prázdném poli je true — bez počtu by se prázdné stažení tvářilo jako úspěch
  ok('a oba jsou na disku',
    made.length === 2 && made.every(name => fs.existsSync(path.join(work, name))));

  /*
   * Tělo, které přestane odpovídat. Spojení se musí samo ukončit a čekající
   * příkaz dostat odpověď — jinak by focení tiše zamrzlo a nešlo by poznat,
   * že se něco stalo.
   */
  const stuck = await talk.send('hang', { timeout: 600 });
  check('mlčící tělo neuvízne', [stuck.ok, talk.alive], [false, false]);
  ok('a je poznat proč', talk.lastError.includes('hang'), talk.lastError);

  talk.close();

  /* ---------- zabrané tělo ---------- */

  /*
   * Přesně ta chyba, na kterou to spadlo na Macu: Digitalizace obrazu drží
   * fotoaparát a gphoto2 vrátí -53. Hláška je přeložená do systémového
   * jazyka, takže rozpoznat se musí podle čísla, ne podle slov.
   */
  const shoot = require(path.join(DIST, 'shoot/index.js'));
  check('zabrané tělo se pozná i česky',
    shoot.claimFailed("-53: 'Nelze přidělit USB zařízení' — Nelze přidělit rozhraní 0"), true);
  check('a anglicky taky',
    shoot.claimFailed("-53: 'Could not claim the USB device' — Could not claim interface 0"), true);
  check('jiná chyba se za zabrané tělo nepovažuje',
    shoot.claimFailed("-1: 'Unspecified error'"), false);

  const busyFile = path.join(work, 'busy.txt');
  process.env.FAKE_BUSY_FILE = busyFile;

  /*
   * První pokus narazí na zabrané tělo, druhý projde. Kdyby se to zkoušelo
   * jen jednou, focení by hlásilo poruchu tam, kde stačí zkusit znovu —
   * a přesně tak se to chovalo, než tahle zkouška vznikla.
   */
  fs.writeFileSync(busyFile, '1');
  const second = await shoot.connect('usb:001,004', 'Canon EOS 250D');
  check('napodruhé se připojí', second.connected, true);
  await shoot.disconnect();

  // Když tělo drží někdo pořád, musí se to říct srozumitelně, ne číslem chyby
  fs.writeFileSync(busyFile, '9');
  const never = await shoot.connect('usb:001,004', 'Canon EOS 250D');
  check('trvale zabrané tělo se vzdá', never.connected, false);
  ok('a poradí, co s tím', never.error.includes('Digitalizaci obrazu'), never.error);
  await shoot.disconnect();
  delete process.env.FAKE_BUSY_FILE;

  /* ---------- samo si to najde a připojí ---------- */

  /*
   * Po zapojení kabelu dostane tělo pokaždé jiný port, takže se pamatuje
   * model. Kdyby se pamatoval port, podruhé by se nepoznalo nic.
   */
  const { setSetting: remember } = require(path.join(DIST, 'db.js'));
  remember('shootSetup', JSON.stringify({ lastCamera: 'Canon EOS 250D' }));
  const auto = await shoot.autoConnect();
  check('známé tělo se připojí samo', [auto.connected, auto.camera],
    [true, 'Canon EOS 250D']);
  ok('a rovnou běží náhled', auto.live);
  await shoot.disconnect();

  // Cizí tělo se nepřipojí — jinak by aplikace sáhla na fotoaparát, který obsluhuje někdo jiný
  remember('shootSetup', JSON.stringify({ lastCamera: 'Nikon Z6' }));
  const foreign = await shoot.autoConnect();
  check('neznámé tělo se samo nepřipojí', foreign.connected, false);
  ok('ale najde se, aby šlo kliknout', foreign.cameras.length === 2, String(foreign.cameras.length));

  // Bez paměti se nic nepřipojuje; první připojení si model zapamatuje
  remember('shootSetup', JSON.stringify({ lastCamera: '' }));
  check('bez paměti se nepřipojuje', (await shoot.autoConnect()).connected, false);
  await shoot.connect('usb:001,004', 'Canon EOS 250D');
  check('po ručním připojení se model pamatuje',
    shoot.shootSetup().lastCamera, 'Canon EOS 250D');
  await shoot.disconnect();

  /* ---------- spouštění a zastavování náhledu ---------- */

  /*
   * Zaseknuté tlačítko „Spustit/Zastavit náhled". Zastavení smyčku
   * neukončí hned — ta ještě čeká na odpověď na poslední `capture-preview`.
   * Dřív se odkaz na ni rovnou zahodil, takže se dala spustit druhá, obě
   * pak posílaly dotazy naráz a náhled se zasekl tak, že nešel ani
   * spustit, ani zastavit.
   */
  {
    const sent = [];
    const okno = { webContents: { send: (channel, payload) => sent.push({ channel, payload }) } };
    const elektron = require.cache[require.resolve('electron')].exports;
    const puvodni = elektron.BrowserWindow.getAllWindows;
    elektron.BrowserWindow.getAllWindows = () => [okno];

    const pocet = () => sent.filter(one => one.channel === 'shoot:frame').length;
    const pauza = (ms) => new Promise(done => setTimeout(done, ms));

    /*
     * Tělo odpovídá na snímek náhledu se zpožděním, jako to skutečné.
     * Bez něj by falešný gphoto2 odpovídal okamžitě, stav „smyčka čeká na
     * odpověď" by nikdy nenastal a závod, kvůli kterému se náhled
     * zasekával, by se neměl kde projevit — zkouška by procházela i s tou
     * chybou.
     */
    process.env.FAKE_PREVIEW_DELAY = '120';
    remember('shootSetup', JSON.stringify({ lastCamera: 'Canon EOS 250D' }));
    await shoot.connect('usb:001,004', 'Canon EOS 250D');

    await shoot.startLive();
    await pauza(600);
    const prvni = pocet();
    ok('náhled posílá snímky', prvni > 0, `${prvni}`);

    shoot.stopLive();
    await pauza(600);
    const poZastaveni = pocet();
    await pauza(400);
    check('po zastavení už nic nechodí', pocet(), poZastaveni);

    /* A hlavně: musí jít spustit znovu. */
    await shoot.startLive();
    await pauza(700);
    ok('a dá se spustit znovu', pocet() > poZastaveni, `${pocet() - poZastaveni} snímků`);

    /*
     * Dvakrát spuštěný náhled musí běžet pořád jen jednou. Dvě smyčky by
     * posílaly na tělo dvakrát tolik dotazů — pozná se to podle toho, že
     * se tempo snímků skokem zdvojnásobí.
     */
    /*
     * Dvakrát spuštěný náhled běží pořád jen jednou. Dvě smyčky by na tělo
     * posílaly dvakrát tolik dotazů — pozná se to podle skokově vyššího
     * tempa snímků.
     */
    const zacatek = pocet();
    await pauza(800);
    const samo = pocet() - zacatek;

    await shoot.startLive();
    const pred = pocet();
    await pauza(800);
    const podruhe = pocet() - pred;
    ok('podruhé spuštěný náhled běží pořád jednou', podruhe < samo * 1.6,
      `${samo} → ${podruhe} snímků za 0,8 s`);

    shoot.stopLive();
    await pauza(400);
    await shoot.disconnect();
    delete process.env.FAKE_PREVIEW_DELAY;
    elektron.BrowserWindow.getAllWindows = puvodni;
  }

  /* ---------- zapomenutý vlastní proces ---------- */

  /*
   * Tohle byla ta skutečná příčina na Macu: `gphoto2 --shell`, který
   * zůstal viset po nepovedeném pokusu, držel fotoaparát sám proti sobě.
   * Další připojení pak hlásilo „Could not claim the USB device" i po
   * odpojení kabelu — proces to přežil a zmizel až s restartem počítače.
   */
  const orphan = require('child_process').spawn(
    wrapper, ['--force-overwrite', '--port', 'usb:001,004', '--shell'],
    /*
     * Vstup musí zůstat otevřený. Se zavřeným vstupem shell hned skončí —
     * a právě tím se liší od skutečnosti: aplikace mu rouru drží otevřenou,
     * takže zapomenutý proces žije dál a drží s sebou i fotoaparát.
     */
    { cwd: work, stdio: ['pipe', 'ignore', 'ignore'], detached: true });
  orphan.unref();
  await new Promise(done => setTimeout(done, 400));
  check('zapomenutý proces je vidět', await gphoto.ownShellsAlive(), true);

  await gphoto.freeOwnShells();
  await new Promise(done => setTimeout(done, 400));
  check('a uklidí se před dalším připojením', await gphoto.ownShellsAlive(), false);

  /*
   * Zavření musí být nekompromisní. Slušné SIGTERM proces uprostřed
   * přenosu po USB nemusí slyšet a přežít — a přežilý proces je přesně
   * ten, který pak fotoaparát blokuje.
   */
  const closing = new session.CameraSession();
  Object.defineProperty(closing, 'dir', { value: work });
  await closing.open('usb:001,004', 'Canon EOS 250D');
  check('spojení běží', closing.alive, true);
  closing.close();
  await new Promise(done => setTimeout(done, 600));
  check('a po zavření nezůstane nic', await gphoto.ownShellsAlive(), false);
}

(async () => {
  if (CAN_SPAWN) await liveSection();
  else console.log('  – rozhovor s gphoto2 přeskočen (pro Windows gphoto2 není)');

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

  /* ---------- ostrost ---------- */

  /**
   * Dvě stejně velké plochy: jedna s ostrou hranou, druhá rozmazaná
   * přechodem. Ostrá musí vyjít výrazně výš — kdyby ne, hlásilo by se
   * rozmazání u ostrých fotek a naopak.
   */
  const plocha = (draw) => {
    const w = 64, h = 64;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = draw(x, y);
        const at = (y * w + x) * 4;
        data[at] = data[at + 1] = data[at + 2] = v;
        data[at + 3] = 255;
      }
    }
    return { data, w, h };
  };

  const ostra = plocha((x) => (x < 32 ? 40 : 220));
  // Rozmazaná: tatáž hrana roztažená přes dvacet bodů
  const mekka = plocha((x) => {
    if (x < 22) return 40;
    if (x > 42) return 220;
    return 40 + ((x - 22) / 20) * 180;
  });
  const hladka = plocha(() => 128);

  const sOstra = fix.sharpness(ostra.data, ostra.w, ostra.h);
  const sMekka = fix.sharpness(mekka.data, mekka.w, mekka.h);
  ok('ostrá hrana má vyšší ostrost než měkká', sOstra > sMekka * 3,
    `${Math.round(sOstra)} vs ${Math.round(sMekka)}`);
  check('jednolitá plocha nemá hrany',
    Math.round(fix.sharpness(hladka.data, hladka.w, hladka.h)), 0);
  check('na drobku se nepočítá nic', fix.sharpness(new Uint8ClampedArray(16), 2, 2), 0);

  /* ---------- přepaly ---------- */

  {
    /*
     * Vybílené bílé pozadí je záměr, ne vada. Kdyby se hlásilo, svítilo
     * by varování u každé fotky produktu na papíru — a to si za týden
     * nikdo nevšimne.
     */
    const bily = new Uint8ClampedArray([255, 255, 255, 255, 254, 255, 255, 255]);
    check('bílé pozadí není přepal', fix.clipping(bily, 250), 0);

    /*
     * Barevný přepal: červená dojela na 255, modrá zůstala nízko. Právě
     * tady vzniká lem, kterého si na fotce všimne každý.
     */
    const lem = new Uint8ClampedArray([255, 200, 120, 255]);
    check('barevný přepal se hlásí', Math.round(fix.clipping(lem, 250)), 100);

    const klidny = new Uint8ClampedArray([200, 200, 200, 255]);
    check('normální obraz je bez přepalů', fix.clipping(klidny, 250), 0);
  }

  /* ---------- ořez ---------- */

  {
    const box = fix.cropBox({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, 6000, 4000);
    check('ořez v pixelech sedí', box, { x: 1500, y: 1000, w: 3000, h: 2000 });

    // Ven z obrazu se ořez nedostane, i když se rámeček přetáhne
    const big = fix.cropBox({ x: 0.9, y: 0.9, w: 0.5, h: 0.5 }, 1000, 1000);
    ok('ořez nepřeteče snímek', big.x + big.w <= 1000 && big.y + big.h <= 1000,
      JSON.stringify(big));

    /*
     * Čtverec na obraze 3:2 není v podílech čtverec — na šířku zabírá
     * dvě třetiny toho, co na výšku. Kdyby se to nepřepočítalo, vyšel by
     * z „čtverce" obdélník a na e-shopu by fotka vyčnívala z řady.
     */
    const ctverec = fix.lockRatio({ x: 0.1, y: 0.1, w: 0.9, h: 0.6 }, 1, 3 / 2);
    const px = fix.cropBox(ctverec, 6000, 4000);
    ok('čtverec je na fotce opravdu čtverec', Math.abs(px.w - px.h) <= 1,
      `${px.w}×${px.h}`);

    check('volný poměr nic nemění',
      fix.lockRatio({ x: 0, y: 0, w: 0.8, h: 0.3 }, null, 1.5).h, 0.3);
    check('čtverec je výchozí poměr', fix.ratioValue('1:1'), 1);
  }
  }

  fs.rmSync(work, { recursive: true, force: true });
  console.log(failed ? `\n${failed} chyb\n` : '\nfocení sedí\n');
  process.exit(failed ? 1 : 0);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
