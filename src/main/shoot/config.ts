import type { CameraSetting, CameraChoice } from '../../shared/types';

/**
 * Čtení a zápis nastavení fotoaparátu.
 *
 * ## Proč se nastavení nevypisuje napevno
 *
 * Každé tělo má jiné volby: Canon má „Large Fine JPEG", Nikon „JPEG fine",
 * clona jde po třetinách nebo po polovinách podle objektivu a ISO končí
 * jinde u každé řady. Napsat do aplikace pevný seznam znamená, že s jiným
 * tělem než mým ukáže volby, které neexistují. gphoto2 umí vypsat celý
 * strom nastavení i s povolenými hodnotami — aplikace ho tedy přečte
 * a postaví ovládání podle toho, co tělo opravdu umí.
 *
 * ## Co z toho vidí uživatel
 *
 * Strom má u zrcadlovky přes sto položek, z toho většinu nikdo nikdy
 * nezmění (verze firmwaru, stav baterie, PTP vlastnost 0xd402). Nahoře
 * je proto krátký seznam toho, co při focení produktu dává smysl, a zbytek
 * je schovaný — ne zahozený, protože co je „zbytek", se u jiného těla
 * může lišit.
 */

/**
 * Výpis `--list-all-config`: odstavce oddělené řádkem `END`.
 *
 * ```
 * /main/imgsettings/iso
 * Label: ISO Speed
 * Readonly: 0
 * Type: RADIO
 * Current: 100
 * Choice: 0 Auto
 * Choice: 1 100
 * END
 * ```
 *
 * Starší gphoto2 řádek `Readonly` nevypisuje, proto se nic nepovažuje za
 * povinné kromě cesty a typu.
 */
export function parseConfig(text: string): CameraSetting[] {
  const out: CameraSetting[] = [];
  let current: CameraSetting | null = null;

  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    const trimmed = line.trim();

    if (trimmed === 'END') {
      if (current) out.push(current);
      current = null;
      continue;
    }
    if (trimmed.startsWith('/')) {
      if (current) out.push(current);
      current = {
        path: trimmed,
        name: trimmed.split('/').pop() || trimmed,
        label: '',
        type: 'TEXT',
        readonly: false,
        value: '',
        choices: []
      };
      continue;
    }
    if (!current) continue;

    const at = line.indexOf(':');
    if (at < 0) continue;
    const key = line.slice(0, at).trim();
    const value = line.slice(at + 1).replace(/^ /, '');

    if (key === 'Label') current.label = value.trim();
    else if (key === 'Readonly') current.readonly = value.trim() === '1';
    else if (key === 'Type') current.type = value.trim() as CameraSetting['type'];
    else if (key === 'Current') current.value = value.replace(/\s+$/, '');
    else if (key === 'Bottom') current.bottom = Number(value.trim());
    else if (key === 'Top') current.top = Number(value.trim());
    else if (key === 'Step') current.step = Number(value.trim());
    else if (key === 'Choice') {
      /*
       * „Choice: 3 1/125" — číslo je index, zbytek řádku je hodnota i s
       * mezerami („Large Fine JPEG"). Dělí se proto jen na první mezeře.
       * Hodnota může být i prázdná; taková volba se nenabízí, protože
       * `set-config` s prázdným řetězcem tělo odmítne.
       */
      const hit = /^(\d+)\s?(.*)$/.exec(value.trim());
      if (hit && hit[2].trim()) {
        current.choices.push({ index: Number(hit[1]), value: hit[2] } as CameraChoice);
      }
    }
  }
  if (current) out.push(current);
  return out;
}

/** Odpověď na `get-config` — jeden odstavec bez `END`. */
export function parseOne(text: string, path: string): CameraSetting | null {
  const body = text.trim().startsWith('/') ? text : `${path}\n${text}`;
  const list = parseConfig(`${body}\nEND`);
  return list[0] ?? null;
}

/**
 * Co se při focení produktu opravdu mění.
 *
 * Řadí se podle toho, jak často se na to sahá, ne abecedně: nejdřív expozice,
 * pak barvy, pak formát a ostření. Klíč je konec cesty, protože začátek se
 * mezi značkami liší (`/main/capturesettings/…` vs `/main/other/…`).
 */
export const HANDY: { name: string; label: string; group: CameraSetting['group'] }[] = [
  { name: 'iso', label: 'ISO', group: 'expozice' },
  { name: 'aperture', label: 'Clona', group: 'expozice' },
  { name: 'f-number', label: 'Clona', group: 'expozice' },
  { name: 'shutterspeed', label: 'Čas', group: 'expozice' },
  { name: 'shutterspeed2', label: 'Čas', group: 'expozice' },
  { name: 'exposurecompensation', label: 'Korekce expozice', group: 'expozice' },
  { name: 'autoexposuremode', label: 'Režim', group: 'expozice' },
  { name: 'expprogram', label: 'Režim', group: 'expozice' },
  { name: 'meteringmode', label: 'Měření', group: 'expozice' },

  { name: 'whitebalance', label: 'Vyvážení bílé', group: 'barvy' },
  { name: 'colortemperature', label: 'Teplota barev', group: 'barvy' },
  { name: 'whitebalanceadjusta', label: 'Doladění bílé', group: 'barvy' },
  { name: 'picturestyle', label: 'Styl obrazu', group: 'barvy' },
  { name: 'colorspace', label: 'Barevný prostor', group: 'barvy' },

  { name: 'imageformat', label: 'Formát snímku', group: 'soubor' },
  { name: 'imagequality', label: 'Kvalita', group: 'soubor' },
  { name: 'imagesize', label: 'Velikost', group: 'soubor' },
  { name: 'capturetarget', label: 'Kam ukládat', group: 'soubor' },

  { name: 'focusmode', label: 'Ostření', group: 'ostření' },
  { name: 'focusmode2', label: 'Ostření', group: 'ostření' },
  { name: 'drivemode', label: 'Režim snímání', group: 'ostření' },
  { name: 'aspectratio', label: 'Poměr stran', group: 'ostření' }
];

/**
 * Položky, které se nikdy nenabízejí.
 *
 * Nejsou to volby, ale tlačítka a stavy: `autofocusdrive` spustí ostření,
 * `eosremoterelease` zmáčkne spoušť, `opcode` posílá syrové PTP příkazy.
 * Vykreslit je jako přepínač znamená, že se dá omylem kliknout na něco,
 * co s fotoaparátem udělá nečekanou věc.
 */
const NEVER = new Set([
  'autofocusdrive', 'manualfocusdrive', 'cancelautofocus', 'eosremoterelease',
  'eoszoom', 'eoszoomposition', 'viewfinder', 'opcode', 'syncdatetime',
  'syncdatetimeutc', 'uilock', 'popupflash', 'bulb', 'movierecordtarget',
  'remotemode', 'eventmode', 'testolc', 'datetime', 'datetimeutc',
  'capture', 'capturemode', 'eventleft', 'output'
]);

/**
 * Výpis `list-config` — jen cesty, po jedné na řádku.
 *
 * V shellu jiný způsob není: `--list-all-config` je přepínač příkazové
 * řádky a ten by potřeboval druhý proces, jenže fotoaparát smí držet jen
 * jeden. Hodnoty se proto dočítají po jedné přes `get-config`.
 */
export function parsePaths(text: string): string[] {
  const out: string[] = [];
  for (const line of String(text ?? '').split('\n')) {
    const row = line.trim();
    if (row.startsWith('/') && !row.includes(' ')) out.push(row);
  }
  return out;
}

function nameOf(settingPath: string): string {
  return settingPath.split('/').pop() || settingPath;
}

/**
 * Které cesty se načtou hned a v jakém pořadí.
 *
 * Čte se jen to, co se při focení produktu opravdu mění — u zrcadlovky je
 * ve stromu přes sto položek a každá stojí jeden dotaz na tělo. Načíst
 * všechny znamená čekat při připojení několik vteřin kvůli údajům, na
 * které se nikdo nepodívá.
 */
export function handyPaths(paths: string[]): { path: string; label: string; group: CameraSetting['group'] }[] {
  const out: { path: string; label: string; group: CameraSetting['group'] }[] = [];
  for (const wanted of HANDY) {
    const hit = paths.find(one => nameOf(one) === wanted.name);
    // Tělo má často `aperture` i `f-number`; bere se to, co v něm opravdu je
    if (hit && !out.some(had => had.path === hit)) {
      out.push({ path: hit, label: wanted.label, group: wanted.group });
    }
  }
  return out;
}

/** Zbytek stromu — nabídne se jako seznam, hodnota se dočte až po rozkliknutí. */
export function restPaths(paths: string[]): string[] {
  const handy = new Set(handyPaths(paths).map(one => one.path));
  return paths.filter(one => !handy.has(one) && !NEVER.has(nameOf(one)));
}

/** Dá se tahle položka vůbec nastavit? Jen na čtení nebo bez voleb ne. */
export function settable(setting: CameraSetting): boolean {
  if (setting.readonly) return false;
  if (setting.type === 'DATE') return false;
  if ((setting.type === 'RADIO' || setting.type === 'MENU') && !setting.choices.length) return false;
  return true;
}

export const __test = { parseConfig, parseOne, parsePaths, handyPaths, restPaths, settable, NEVER };
