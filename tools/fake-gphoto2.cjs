/**
 * Falešný gphoto2 — mluví stejným protokolem jako ten pravý.
 *
 * ## Proč to existuje
 *
 * Fotoaparát v testovacím prostředí není a nikdy nebude, takže to jediné,
 * co jde poctivě ověřit, je **domluva mezi aplikací a gphoto2**: že se
 * pozná konec odpovědi, že se z výpisu přečtou jména stažených souborů,
 * že se nabídka voleb rozebere správně a že se chyba pozná jako chyba.
 * Přesně v těchhle místech se to rozbije a na hotové fotce se to nepozná.
 *
 * Výstupy jsou opsané z pravého gphoto2 2.5.28 včetně toho, že shell
 * zapsaný příkaz vypíše ozvěnou dvakrát a že výzva nekončí novým řádkem.
 *
 *   node tools/fake-gphoto2.cjs --version
 *   node tools/fake-gphoto2.cjs --port usb:001,004 --shell
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');

/* Malý platný JPEG. Náhled musí vrátit obrázek, ne jen nějaké bajty. */
const FRAME = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEi' +
  'MEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7' +
  'Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAAwAEADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcI' +
  'CQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRol' +
  'JicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ip' +
  'qrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAA' +
  'AAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLR' +
  'ChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaX' +
  'mJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEA' +
  'PwD16iiikMKKoarrum6L5X9o3Pk+dnZ8jNnGM9AfUVn/APCdeGv+gl/5Ak/+Jq1CTV0iXJLdm/RWB/wnXhr/AKCX/kCT' +
  '/wCJrQ0rXdN1rzf7OufO8nG/5GXGc46gehocJJXaBST2ZfoooqCgooooA4D4pf8AML/7bf8Aslef16B8Uv8AmF/9tv8A' +
  '2SvP69Oh/DRx1fjYV6B8Lf8AmKf9sf8A2evP69A+Fv8AzFP+2P8A7PRX/hsKXxo7+iiivMOwKKKKAKGq6FputeV/aNt5' +
  '3k52fOy4zjPQj0FZ/wDwgvhr/oG/+R5P/iq36KtTklZMlxT3Rgf8IL4a/wCgb/5Hk/8Aiq0NK0LTdF83+zrbyfOxv+dm' +
  'zjOOpPqav0UOcmrNgopbIKKKKgo//9k=', 'base64');

/**
 * Strom nastavení opsaný z Canonu EOS 250D.
 *
 * Schválně je v něm i to, co se nesmí nabídnout (`autofocusdrive`,
 * `eosremoterelease`), položka jen na čtení (`batterylevel`) a volba
 * s mezerami v hodnotě (`imageformat`) — na každé z nich se dá zaseknout
 * jinak.
 */
const TREE = {
  '/main/actions/autofocusdrive': { label: 'Drive Canon DSLR Autofocus', type: 'TOGGLE', value: '0' },
  '/main/actions/eosremoterelease': {
    label: 'Canon EOS Remote Release', type: 'RADIO', value: 'None',
    choices: ['None', 'Press Half', 'Press Full', 'Release Full']
  },
  '/main/status/batterylevel': { label: 'Battery Level', type: 'TEXT', value: '100%', readonly: true },
  '/main/imgsettings/iso': {
    label: 'ISO Speed', type: 'RADIO', value: '100',
    choices: ['Auto', '100', '200', '400', '800', '1600', '3200', '6400']
  },
  '/main/imgsettings/whitebalance': {
    label: 'WhiteBalance', type: 'RADIO', value: 'Auto',
    choices: ['Auto', 'Daylight', 'Shadow', 'Cloudy', 'Tungsten', 'Fluorescent', 'Flash', 'Manual']
  },
  '/main/imgsettings/colortemperature': { label: 'Color Temperature', type: 'TEXT', value: '5200' },
  '/main/imgsettings/imageformat': {
    label: 'Image Format', type: 'RADIO', value: 'Large Fine JPEG',
    choices: ['Large Fine JPEG', 'Large Normal JPEG', 'RAW + Large Fine JPEG', 'RAW']
  },
  '/main/capturesettings/aperture': {
    label: 'Aperture', type: 'RADIO', value: '8',
    choices: ['4', '4.5', '5', '5.6', '6.3', '7.1', '8', '9', '10', '11']
  },
  '/main/capturesettings/shutterspeed': {
    label: 'Shutter Speed', type: 'RADIO', value: '1/125',
    choices: ['1/30', '1/40', '1/50', '1/60', '1/80', '1/100', '1/125', '1/160', '1/200']
  },
  '/main/capturesettings/exposurecompensation': {
    label: 'Exposure Compensation', type: 'RADIO', value: '0',
    choices: ['-2', '-1.6', '-1.3', '-1', '-0.6', '-0.3', '0', '0.3', '0.6', '1', '1.3', '1.6', '2']
  },
  '/main/capturesettings/picturestyle': {
    label: 'Picture Style', type: 'RADIO', value: 'Standard',
    choices: ['Standard', 'Portrait', 'Landscape', 'Neutral', 'Faithful', 'Monochrome']
  },
  '/main/capturesettings/focusmode': {
    label: 'Focus Mode', type: 'RADIO', value: 'One Shot',
    choices: ['One Shot', 'AI Focus', 'AI Servo', 'Manual']
  },
  '/main/settings/capturetarget': {
    label: 'Capture Target', type: 'RADIO', value: 'Memory card',
    choices: ['Internal RAM', 'Memory card']
  },
  '/main/other/d402': { label: 'PTP Property 0xd402', type: 'TEXT', value: 'Canon EOS 250D' }
};

/**
 * Nastavení, které tělo přijme, ale tiše dá jinou hodnotu.
 *
 * Skutečná vlastnost fotoaparátů: v automatu nejde přestavit čas. Aplikace
 * na to musí být připravená a hodnotu si přečíst zpátky.
 */
const STUBBORN = { '/main/capturesettings/shutterspeed': '1/60' };

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);

if (has('--version')) {
  process.stdout.write('gphoto2 2.5.28\n\nCopyright (c) 2000-2021 Marcus Meissner and others\n');
  process.exit(0);
}

if (has('--auto-detect')) {
  process.stdout.write([
    'Model                          Port',
    '----------------------------------------------------------',
    'Canon EOS 250D                 usb:001,004',
    'Nikon DSC D3300 (PTP mode)     usb:001,007',
    ''
  ].join('\n'));
  process.exit(0);
}

if (!has('--shell')) process.exit(0);

let shots = 0;

/**
 * Zabrané tělo, jak ho hlásí macOS.
 *
 * Soubor z `FAKE_BUSY_FILE` drží počet spuštění, která mají skončit chybou
 * -53. Každé spuštění si číslo sníží — díky tomu jde vyzkoušet, že se
 * aplikace o připojení pokusí znovu a že se napodruhé chytí. Digitalizace
 * obrazu se chová stejně: je to závod, ne trvalý stav.
 */
let busy = 0;
const busyFile = process.env.FAKE_BUSY_FILE || '';
if (busyFile) {
  try {
    busy = Number(fs.readFileSync(busyFile, 'utf8').trim()) || 0;
    if (busy > 0) fs.writeFileSync(busyFile, String(busy - 1));
  } catch { busy = 0; }
}

const prompt = () => process.stdout.write(`\ngphoto2: {${process.cwd()}} /> `);

function fail(code, message, why) {
  process.stdout.write(`*** Error (${code}: '${message}') ***       \n`);
  if (why) process.stdout.write(`${why}\n`);
}

function describe(settingPath) {
  const one = TREE[settingPath];
  if (!one) { fail(-101, 'Unknown model', ''); return; }
  const lines = [`Label: ${one.label}`, `Readonly: ${one.readonly ? 1 : 0}`,
    `Type: ${one.type}`, `Current: ${one.value}`];
  (one.choices || []).forEach((value, index) => lines.push(`Choice: ${index} ${value}`));
  lines.push('END');
  process.stdout.write(lines.join('\n') + '\n');
}

function run(line) {
  const command = line.trim();
  if (!command) return;

  if (command === 'exit' || command === 'quit' || command === 'q') { process.exit(0); }

  if (busy > 0) {
    /*
     * Hláška je opsaná z macOS i s tím, že ji systém překládá — chyba se
     * proto musí poznat podle čísla -53, ne podle textu.
     */
    fail(-53, 'Nelze přidělit USB zařízení',
      'Vyskytla se chyba ve vstupně/výstupní knihovně („Nelze přidělit USB zařízení“): '
      + 'Nelze přidělit rozhraní 0 (No such file or directory).');
    return;
  }

  if (command === 'list-config') {
    process.stdout.write(Object.keys(TREE).join('\n') + '\n');
    return;
  }
  if (command.startsWith('get-config ')) { describe(command.slice(11).trim()); return; }

  if (command.startsWith('set-config-value ') || command.startsWith('set-config ')) {
    const body = command.replace(/^set-config(-value)? /, '');
    const at = body.indexOf('=');
    const settingPath = body.slice(0, at);
    const value = body.slice(at + 1);
    const one = TREE[settingPath];
    if (!one) { fail(-101, 'Unknown model', ''); return; }
    if (one.readonly) { fail(-2, 'Bad parameters', 'The property is read only.'); return; }
    one.value = STUBBORN[settingPath] || value;
    return;
  }

  if (command === 'capture-preview') {
    fs.writeFileSync(path.join(process.cwd(), 'capture_preview.jpg'), FRAME);
    process.stdout.write('Saving file as capture_preview.jpg\n');
    return;
  }

  if (command === 'capture-image-and-download') {
    shots++;
    const raw = TREE['/main/imgsettings/imageformat'].value.startsWith('RAW');
    const jpeg = TREE['/main/imgsettings/imageformat'].value.includes('JPEG');
    const base = `IMG_${String(1000 + shots)}`;
    const made = [];
    if (jpeg) made.push(`${base}.JPG`);
    if (raw) made.push(`${base}.CR3`);
    for (const name of made) {
      fs.writeFileSync(path.join(process.cwd(), name), FRAME);
      process.stdout.write(`New file is in location /store_00020001/DCIM/100CANON/${name} on the camera\n`);
      process.stdout.write(`Saving file as ${name}\n`);
      process.stdout.write(`Deleting file /store_00020001/DCIM/100CANON/${name} on the camera\n`);
    }
    return;
  }

  if (command === 'hang') return;  // odpoví výzvou až nikdy — na zkoušku časového limitu

  fail(-1, 'Unspecified error', `The command '${command}' is not known.`);
}

/**
 * Zpoždění odpovědi na snímek náhledu.
 *
 * Skutečné tělo odpovídá desetinu vteřiny. Bez toho odpovídá falešný
 * gphoto2 okamžitě, takže se do aplikace nevejde stav „smyčka ještě čeká
 * na odpověď" — a právě v něm vznikají závody, kvůli kterým se náhled
 * zasekával. Pro takové zkoušky se dá zpoždění zapnout.
 */
const SLOW = Number(process.env.FAKE_PREVIEW_DELAY || 0);

prompt();
readline.createInterface({ input: process.stdin, terminal: false }).on('line', (line) => {
  // Pravý shell zapsaný řádek vypíše ozvěnou — jednou za výzvu, podruhé samostatně
  process.stdout.write(`${line}\n${line}\n`);
  const hang = line.trim() === 'hang';
  const finish = () => { run(line); if (!hang) prompt(); };
  if (SLOW > 0 && line.trim() === 'capture-preview') setTimeout(finish, SLOW);
  else finish();
});
