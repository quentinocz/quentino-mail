/*
 * Aktualizace aplikace z vydání na GitHubu.
 *
 * Hlídají se tři věci, na kterých to stojí a u kterých se chyba pozná až
 * tím, že se aplikace po aktualizaci nespustí — a to je pozdě:
 *
 *  1. **porovnání verzí** — „5.10.0" je víc než „5.9.0", abecedně naopak,
 *  2. **výběr souboru z vydání** — macOS zip, Windows instalátor,
 *  3. **výměna balíčku** — skript se tu doopravdy spustí nad falešnou
 *     aplikací a kontroluje se, že vyměnil, co měl, a že při nezdaru vrátí
 *     původní stav.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const DIST = process.env.PTDIST || path.join(__dirname, '../dist/ptdist/main');
require.cache[require.resolve('electron')] = {
  id: 'electron', filename: 'electron', loaded: true,
  exports: {
    app: { getVersion: () => '5.1.0', getPath: () => os.tmpdir(), isPackaged: false },
    BrowserWindow: { getAllWindows: () => [] },
    shell: { openExternal: () => {} }
  }
};
const dbPath = require.resolve(path.join(DIST, 'db.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {
  getDb: () => { throw new Error('databáze se v téhle zkoušce nepoužívá'); },
  getSetting: (_key, fallback) => fallback,
  setSetting: () => {}
} };

const update = require(path.join(DIST, 'update.js'));

let failed = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? '✓' : '✗'} ${label}`);
  if (!ok) {
    failed++;
    console.log(`      čekáno: ${JSON.stringify(want)}`);
    console.log(`      dostal: ${JSON.stringify(got)}`);
  }
}

console.log('\nporovnání verzí:\n');

check('novější vyhraje', update.newerThan('v5.1.1', '5.1.0'), true);
check('stejná není novější', update.newerThan('v5.1.0', '5.1.0'), false);
check('starší není novější', update.newerThan('v5.0.9', '5.1.0'), false);
/*
 * Tohle je ten případ, kvůli kterému se verze nesmí porovnávat jako text:
 * abecedně je „5.9.0" víc než „5.10.0" a aktualizace by se po devítce
 * přestala nabízet úplně.
 */
check('desítka je víc než devítka', update.newerThan('v5.10.0', 'v5.9.0'), true);
check('a naopak ne', update.newerThan('v5.9.0', 'v5.10.0'), false);
check('kratší značka se doplní nulami', update.newerThan('v5.2', '5.1.9'), true);
check('nesmysl místo verze nic nerozbije', update.newerThan('nightly', '5.1.0'), false);

console.log('\nsoubor z vydání:\n');

const RELEASE = [
  'quentino-app-5.1.1-arm64.dmg',
  'quentino-app-5.1.1-arm64.zip',
  'quentino-app-5.1.1-x64.exe',
  'QuentinoApp.ipa'
];
/*
 * Na macOS zip, ne dmg: z dmg by se muselo připojovat zařízení a kopírovat
 * z něj, kdežto zip stačí rozbalit — a právě rozbalení vlastní aplikací je
 * to, proč pak Gatekeeper mlčí.
 */
check('macOS bere zip pro svůj procesor',
  update.pickAsset(RELEASE, 'darwin', 'arm64'), 'quentino-app-5.1.1-arm64.zip');
check('Windows bere instalátor',
  update.pickAsset(RELEASE, 'win32', 'x64'), 'quentino-app-5.1.1-x64.exe');
check('na Linuxu se nenabízí nic', update.pickAsset(RELEASE, 'linux', 'x64'), '');
check('vydání bez souboru pro systém vrátí prázdno',
  update.pickAsset(['QuentinoApp.ipa'], 'darwin', 'arm64'), '');

console.log('\nvýměna aplikace:\n');

/*
 * Výměna balíčku je věc macOS. Tam se stahuje zip, rozbalí se stranou
 * a skript pro `/bin/sh` přesune balíčky, zatímco aplikace končí. Na
 * Windows se stahuje instalátor a nasadí se sám (`setup.exe /S`), takže
 * žádný skript k vyzkoušení není — a `/bin/sh` tam ani není čím spustit.
 *
 * Přeskakuje se proto nahlas, ne mlčky. Když tahle část na Windows běžela,
 * `execFileSync` spadl na chybějícím `/bin/sh`, chyba se spolkla a zkouška
 * pak hlásila „nová aplikace není na místě té staré" — tedy něco úplně
 * jiného, než co se doopravdy stalo, a sestavení pro Windows kvůli tomu
 * neprošlo.
 */
if (process.platform === 'win32') {
  console.log('  – přeskočeno: výměnu balíčku dělá skript pro /bin/sh, a ten je jen pro macOS.');
  console.log('    Na Windows nasazuje aktualizaci instalátor NSIS a ten se tu nezkouší.');
} else {
  /*
   * Skript se tu doopravdy spustí. Je to ta část, která se v provozu udělá
   * jednou a když je špatně, aplikace se po aktualizaci nespustí — takže
   * zkoušet ji „očima nad kódem" nestačí.
   */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vymena-'));
  const script = path.join(dir, 'vymena.sh');
  fs.writeFileSync(script, update.swapScript(), 'utf8');
  fs.chmodSync(script, 0o755);

  const app = (where, text) => {
    fs.mkdirSync(path.join(where, 'Contents', 'MacOS'), { recursive: true });
    fs.writeFileSync(path.join(where, 'Contents', 'MacOS', 'app'), text, 'utf8');
  };
  const obsah = where => fs.readFileSync(path.join(where, 'Contents', 'MacOS', 'app'), 'utf8');

  /**
   * Spustí skript a vrátí jeho návratový kód, nebo `null`, když se vůbec
   * nespustil.
   *
   * Ten rozdíl je celý důvod, proč tahle funkce existuje. `open` mimo macOS
   * není, takže poslední řádek skriptu skončí nenulovým kódem — na to, co
   * skript udělal s balíčky na disku, to vliv nemá a dá se to přejít.
   * Chybějící `/bin/sh` je ale něco jiného: skript se nespustil vůbec
   * a všechno, co se po něm kontroluje, pak hlásí nesmysly.
   */
  const spust = (...args) => {
    try {
      execFileSync('/bin/sh', [script, ...args], { stdio: 'ignore' });
      return 0;
    } catch (e) {
      if (e.code === 'ENOENT') {
        failed++;
        console.log('  ✗ /bin/sh se nepodařilo spustit — výměna se vůbec nezkusila');
        return null;
      }
      return e.status ?? 1;
    }
  };

  {
    const cil = path.join(dir, 'Quentino App.app');
    const nova = path.join(dir, 'nova', 'Quentino App.app');
    app(cil, 'stara verze');
    app(nova, 'nova verze');

    // Číslo procesu, který neběží: skript nemá na co čekat a rovnou vymění
    if (spust('999999', nova, cil) !== null) {
      check('nová aplikace je na místě té staré', obsah(cil), 'nova verze');
      check('a stará už na disku neleží', fs.existsSync(`${cil}.stara`), false);
      check('rozbalená kopie se přesunula, ne zkopírovala', fs.existsSync(nova), false);
    }
  }

  {
    /*
     * Nezdar uprostřed. Když se nová aplikace nedá přesunout (tady prostě
     * není), musí zůstat na disku ta stará — jinak by po nepovedené
     * aktualizaci nezbylo nic a nebylo by co spustit.
     */
    const cil = path.join(dir, 'Druha.app');
    app(cil, 'stara verze');
    const code = spust('999999', path.join(dir, 'chybi.app'), cil);
    if (code !== null) {
      check('nezdar se pozná podle návratového kódu', code !== 0, true);
      check('a stará aplikace zůstala na svém místě', obsah(cil), 'stara verze');
    }
  }

  fs.rmSync(dir, { recursive: true, force: true });
}

if (failed) {
  console.log(`\n✗ ${failed} zkoušek selhalo`);
  process.exit(1);
}
console.log('\n✓ aktualizace sedí');
