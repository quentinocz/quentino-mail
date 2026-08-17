#!/usr/bin/env node
/**
 * Kontrola před sestavením instalátoru.
 *
 * Smysl je jediný: nepustit dál build, ze kterého by vzešel instalátor,
 * co spadne až u zákazníka. Nativní modul `better-sqlite3` se kompiluje
 * pro konkrétní systém *a procesor*, křížem to nejde a electron-builder
 * na to sám neupozorní. Tři nejčastější způsoby, jak se to pokazí:
 *
 *   1. build pro Windows spuštěný na Macu (nebo naopak);
 *   2. build pro jinou architekturu, než na které stojíme — typicky
 *      instalátor pro x64 sestavovaný na ARM stroji. Tohle je nejzrádnější,
 *      protože se sestaví bez chyby;
 *   3. `node_modules` zkopírované z jiného počítače.
 *
 * Všechno tři se pozná dřív, než se cokoli zabalí.
 *
 * Použití:
 *   node scripts/preflight.mjs env --target=mac|win|auto
 *   node scripts/preflight.mjs dist
 *   node scripts/preflight.mjs tools    — jen kompilátor pro nativní moduly
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const problems = [];
const notes = [];

const fail = (msg, hint) => problems.push(hint ? `${msg}\n     → ${hint}` : msg);
const warn = (msg) => notes.push(msg);

const read = (rel) => {
  try {
    return fs.readFileSync(path.join(ROOT, rel));
  } catch {
    return null;
  }
};

const readJson = (rel) => {
  const buf = read(rel);
  if (!buf) return null;
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return null;
  }
};

const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

/** Spustí příkaz a vrátí jeho výstup, nebo null když neexistuje či selže. */
function run(cmd, args) {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15_000,
      windowsHide: true
    }).trim();
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Rozpoznání binárky podle prvních bajtů                              */
/* ------------------------------------------------------------------ */

const ARCH_NAMES = {
  0x01000007: 'x64',
  0x0100000c: 'arm64',
  0x00000007: 'ia32',
  0x0000000c: 'arm'
};

/**
 * Vrátí { os, arch } zkompilované knihovny, nebo null když se to nedá poznat.
 * Nečte se celý soubor — stačí hlavička.
 */
function inspectBinary(relPath) {
  let fd;
  try {
    fd = fs.openSync(path.join(ROOT, relPath), 'r');
  } catch {
    return null;
  }
  try {
    const head = Buffer.alloc(24);
    const n = fs.readSync(fd, head, 0, 24, 0);
    if (n < 8) return null;

    // Mach-O (macOS)
    const magic = head.readUInt32LE(0);
    if (magic === 0xfeedfacf || magic === 0xfeedface) {
      return { os: 'darwin', arch: ARCH_NAMES[head.readUInt32LE(4)] ?? null };
    }
    // Mach-O uložené naopak (big-endian magic) nebo universal binary
    const magicBE = head.readUInt32BE(0);
    if (magicBE === 0xfeedfacf || magicBE === 0xfeedface) return { os: 'darwin', arch: null };
    if (magicBE === 0xcafebabe) return { os: 'darwin', arch: 'universal' };

    // PE (Windows) — „MZ", architektura je až v COFF hlavičce
    if (head[0] === 0x4d && head[1] === 0x5a) {
      let arch = null;
      try {
        const off = Buffer.alloc(4);
        fs.readSync(fd, off, 0, 4, 0x3c);
        const peOff = off.readUInt32LE(0);
        const coff = Buffer.alloc(6);
        fs.readSync(fd, coff, 0, 6, peOff);
        if (coff.readUInt32LE(0) === 0x00004550) {
          const machine = coff.readUInt16LE(4);
          arch = machine === 0x8664 ? 'x64' : machine === 0x014c ? 'ia32' : machine === 0xaa64 ? 'arm64' : null;
        }
      } catch { /* architekturu se poznat nepodařilo, systém stačí */ }
      return { os: 'win32', arch };
    }

    // ELF (Linux)
    if (head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46) {
      const machine = head.readUInt16LE(18);
      return { os: 'linux', arch: machine === 0x3e ? 'x64' : machine === 0xb7 ? 'arm64' : null };
    }
    return null;
  } catch {
    return null;
  } finally {
    try { fs.closeSync(fd); } catch { /* zavření se nepovedlo, nevadí */ }
  }
}

const OS_NAMES = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };
const osName = (p) => OS_NAMES[p] ?? p;

/* ------------------------------------------------------------------ */
/* Architektury z electron-builder.yml                                 */
/* ------------------------------------------------------------------ */

/**
 * Vytáhne z konfigurace architektury nastavené pro danou sekci (`mac` / `win`).
 *
 * Schválně se sem netahá parser YAML — konfigurace je náš vlastní krátký soubor
 * a jediná věc, kterou odsud potřebujeme, jsou řádky `arch:`. Když se struktura
 * změní tak, že tomu přestane rozumět, vrátí null a kontrola se jen přeskočí;
 * nikdy kvůli tomu nespadne build, který by jinak prošel.
 */
function configuredArches(section) {
  const raw = read('electron-builder.yml');
  if (!raw) return null;

  const lines = raw.toString('utf8').split(/\r?\n/);
  const out = [];
  let inSection = false;
  let collecting = false;

  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue;

    // Klíč na nulovém odsazení ukončuje předchozí sekci
    const topKey = /^([A-Za-z][\w-]*):/.exec(line);
    if (topKey) {
      inSection = topKey[1] === section;
      collecting = false;
      continue;
    }
    if (!inSection) continue;

    // arch: [x64, arm64]
    const inline = /^\s*arch:\s*\[([^\]]*)\]/.exec(line);
    if (inline) {
      out.push(...inline[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean));
      collecting = false;
      continue;
    }
    // arch:
    //   - x64
    if (/^\s*arch:\s*$/.test(line)) {
      collecting = true;
      continue;
    }
    if (collecting) {
      const item = /^\s*-\s*(\S+)\s*$/.exec(line);
      if (item) {
        out.push(item[1].replace(/['"]/g, ''));
        continue;
      }
      collecting = false;
    }
  }

  return out.length ? [...new Set(out)] : null;
}

/* ------------------------------------------------------------------ */
/* Kompilátor pro nativní moduly                                       */
/* ------------------------------------------------------------------ */

/**
 * `better-sqlite3` nemá pro každou kombinaci systému, procesoru a verze
 * Electronu hotovou binárku, takže se často kompiluje ze zdrojáků. K tomu je
 * potřeba Python a C++ kompilátor. Bez nich `npm install` spadne uprostřed
 * postinstall kroku — což je nesrozumitelná chyba, když člověk neví, co hledat.
 */
function checkNativeToolchain() {
  // `prefix` jsou argumenty, kterými se tentýž interpret spustí znovu (kvůli `py -3`)
  const pythonCandidates = process.platform === 'win32'
    ? [['py', ['-3']], ['python', []], ['python3', []]]
    : [['python3', []], ['python', []]];

  const configured = process.env.npm_config_python || process.env.PYTHON;
  if (configured) pythonCandidates.unshift([configured, []]);

  let python = null;
  let pythonCmd = null;
  let pythonPrefix = null;
  for (const [cmd, prefix] of pythonCandidates) {
    const out = run(cmd, [...prefix, '--version']);
    if (out && /Python 3\./.test(out)) {
      python = out;
      pythonCmd = cmd;
      pythonPrefix = prefix;
      break;
    }
  }

  if (!python) {
    fail(
      'Chybí Python 3 — bez něj se nativní modul better-sqlite3 nezkompiluje.',
      process.platform === 'win32'
        ? 'Nainstaluj ho: `winget install -e --id Python.Python.3.11` a otevři nové okno příkazové řádky. '
          + '(Zástupce „python" z Microsoft Store nestačí, node-gyp ho nepozná.)'
        : 'Na macOS je Python součástí Xcode Command Line Tools: `xcode-select --install`.'
    );
  } else {
    notes.push(`Kompilátor: ${python}`);

    // Python 3.12 vyhodil modul `distutils` (PEP 632). node-gyp 9, který si
    // s sebou nese electron-builder 25 přes @electron/rebuild, ho ale pořád
    // importuje — kompilace pak skončí na `ModuleNotFoundError: No module
    // named 'distutils'` uprostřed výpisu, ze kterého to není poznat.
    const hasDistutils = run(pythonCmd, [...pythonPrefix, '-c', 'import distutils']) !== null;
    if (!hasDistutils) {
      const ver = /Python (\d+\.\d+)/.exec(python)?.[1] ?? '3.12+';
      fail(
        `Python ${ver} neobsahuje modul distutils, ale node-gyp ho potřebuje.`,
        'Modul byl z Pythonu 3.12 odstraněn (PEP 632), zatímco node-gyp 9 — ten si přes\n'
        + '       @electron/rebuild nese electron-builder — ho pořád importuje. Dvě cesty:\n\n'
        + '       a) doplnit chybějící modul do stávajícího Pythonu (rychlé):\n'
        + `          ${process.platform === 'win32' ? 'py -3 -m pip' : 'python3 -m pip'} install setuptools\n\n`
        + '       b) používat Python 3.11, se kterým node-gyp počítá (spolehlivější):\n'
        + (process.platform === 'win32'
          ? '          winget install -e --id Python.Python.3.11\n'
            + '          py -3.11 -c "import sys; print(sys.executable)"\n'
            + '          npm config set python "<cesta, kterou to vypsalo>"\n'
          : '          brew install python@3.11 && npm config set python "$(brew --prefix python@3.11)/bin/python3.11"\n')
        + '\n       Pak `npm install` znovu.'
      );
    }
  }

  if (process.platform === 'win32') {
    // Nativní modul se kompiluje pro procesor tohohle počítače, takže ve Visual
    // Studiu musí být sada nástrojů právě pro něj. Instalace „Desktop development
    // with C++" přidá na ARM stroji jen x64/x86 nástroje — ARM64 je samostatná
    // komponenta a bez ní kompilace skončí na `error MSB8020`.
    const COMPONENT = process.arch === 'arm64'
      ? { id: 'Microsoft.VisualStudio.Component.VC.Tools.ARM64', label: 'MSVC v143 – C++ ARM64/ARM64EC build tools' }
      : { id: 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', label: 'MSVC v143 – C++ x64/x86 build tools' };

    const pf = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const vswhere = path.join(pf, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
    if (!fs.existsSync(vswhere)) {
      fail(
        'Nejsou nainstalované Visual Studio Build Tools (C++).',
        'Nainstaluj je příkazem:\n       winget install -e --id Microsoft.VisualStudio.2022.BuildTools '
          + `--override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --add ${COMPONENT.id} --includeRecommended"`
      );
    } else {
      const found = run(vswhere, [
        '-products', '*', '-latest', '-prerelease',
        '-requires', COMPONENT.id,
        '-property', 'installationPath'
      ]);
      if (!found) {
        const anyVs = run(vswhere, ['-products', '*', '-latest', '-prerelease', '-property', 'installationPath']);
        fail(
          `Ve Visual Studiu chybí komponenta „${COMPONENT.label}" (${process.arch}).`,
          (anyVs
            ? 'Visual Studio nainstalované je, ale bez sady nástrojů pro tenhle procesor — '
              + 'kompilace by skončila na `error MSB8020: Nenašly se nástroje sestavení pro v143`.\n'
            : '')
          + '       Doplň ji: spusť **Visual Studio Installer** → u Build Tools **Upravit** →\n'
          + `       záložka **Jednotlivé komponenty** → vyhledej „${process.arch === 'arm64' ? 'ARM64' : 'x64/x86'}" →\n`
          + `       zaškrtni „${COMPONENT.label} (Latest)" → **Upravit**.\n\n`
          + '       Nebo z příkazové řádky:\n'
          + `       "${path.join(pf, 'Microsoft Visual Studio', 'Installer', 'setup.exe')}" modify ^\n`
          + `         --installPath "${anyVs ? anyVs.split(/\r?\n/)[0] : path.join(pf, 'Microsoft Visual Studio', '2022', 'BuildTools')}" ^\n`
          + `         --add ${COMPONENT.id} --passive --norestart`
        );
      } else {
        notes.push(`Visual Studio C++ (${process.arch}): ${found.split(/\r?\n/)[0]}`);
      }
    }
  } else if (process.platform === 'darwin') {
    if (!run('xcode-select', ['-p'])) {
      fail(
        'Nejsou nainstalované Xcode Command Line Tools.',
        'Spusť `xcode-select --install`.'
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/* Kontrola prostředí                                                  */
/* ------------------------------------------------------------------ */

const TARGETS = {
  mac: { platform: 'darwin', label: 'macOS', section: 'mac' },
  win: { platform: 'win32', label: 'Windows', section: 'win' }
};

function checkEnv(requested) {
  const here = process.platform;

  // 1) Cílová platforma musí být ta, na které stojíme
  let target = requested;
  if (target === 'auto') {
    target = here === 'darwin' ? 'mac' : here === 'win32' ? 'win' : null;
    if (!target) {
      fail(
        `Sestavení instalátoru z ${osName(here)} není podporované.`,
        'Aplikace se balí na macOS (npm run dist:mac) nebo na Windows (npm run dist:win).'
      );
      return;
    }
  }

  const want = TARGETS[target];
  if (!want) {
    fail(`Neznámý cíl „${requested}".`, 'Použij --target=mac, --target=win nebo --target=auto.');
    return;
  }
  if (here !== want.platform) {
    fail(
      `Instalátor pro ${want.label} nejde sestavit na ${osName(here)}.`,
      'Nativní modul better-sqlite3 se kompiluje pro konkrétní systém. Build by buď selhal, '
      + 'nebo — což je horší — vyrobil instalátor, který spadne až u zákazníka. '
      + `Spusť build na ${want.label}.`
    );
    return;
  }

  // 2) Architektura: instalátor se musí stavět na procesoru, pro který je určený
  const arches = configuredArches(want.section);
  if (!arches) {
    warn('V electron-builder.yml se nepodařilo přečíst nastavené architektury — kontrola přeskočena.');
  } else if (!arches.includes(process.arch) && !arches.includes('universal')) {
    const list = arches.join(', ');
    fail(
      `electron-builder.yml staví ${want.label} pro ${list}, ale tenhle počítač je ${process.arch}.`,
      `Nativní modul better-sqlite3 by se zkompiloval pro ${process.arch} a do ${list} aplikace se nenačte. `
      + 'Instalátor by se sestavil bez jediné chyby a spadl by až u zákazníka.\n'
      + `       Možnosti:\n`
      + `       a) sestavit build na počítači s procesorem ${list};\n`
      + '       b) nechat to na GitHub Actions — runner `windows-latest` je x64, `macos-14` je arm64;\n'
      + `       c) když je aplikace jen pro tenhle stroj, přepiš v electron-builder.yml v sekci `
      + `\`${want.section}\` arch na [${process.arch}].\n`
      + '       Na vyzkoušení aplikace tady žádný build nepotřebuješ — `npm start` běží nativně.'
    );
  }

  // 3) Node
  const major = Number(process.versions.node.split('.')[0]);
  if (!Number.isFinite(major) || major < 20) {
    fail(
      `Node.js ${process.versions.node} je pro sestavení příliš starý.`,
      'Nainstaluj Node.js 20 nebo 22 (LTS) z https://nodejs.org'
    );
  } else if (major % 2 === 1) {
    warn(`Node.js ${process.versions.node} není LTS verze — pokud build selže na kompilaci, zkus Node 22.`);
  }

  // 4) Závislosti vůbec nainstalované
  if (!exists('node_modules')) {
    fail('Chybí složka node_modules.', 'Spusť `npm install`.');
    checkNativeToolchain(); // ať se rovnou ví, jestli `npm install` vůbec projde
    return;
  }
  for (const dep of ['electron', 'electron-builder', 'better-sqlite3', 'vite', 'typescript']) {
    if (!exists(path.join('node_modules', dep))) {
      fail(`Chybí balíček ${dep}.`, 'Spusť `npm install`.');
    }
  }
  if (problems.some((p) => p.includes('Chybí balíček'))) return;

  // 5) Nativní modul: existuje a je pro tenhle systém a procesor?
  const nativeRel = path.join('node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
  if (!exists(nativeRel)) {
    fail(
      'Nativní modul better-sqlite3 není sestavený.',
      'Spusť `npx electron-builder install-app-deps`.'
    );
    checkNativeToolchain();
  } else {
    const bin = inspectBinary(nativeRel);
    if (!bin) {
      warn('Nativní modul better-sqlite3 se nepodařilo přečíst — pokračuji, ale build ověř spuštěním `npm start`.');
    } else if (bin.os !== here) {
      fail(
        `Nativní modul better-sqlite3 je zkompilovaný pro ${osName(bin.os)}, ale stavíš na ${osName(here)}.`,
        'Typicky to znamená zkopírovanou složku node_modules z jiného počítače. '
        + 'Smaž ji a spusť `npm install` znovu — node_modules se mezi systémy nepřenáší.'
      );
    } else if (bin.arch && bin.arch !== 'universal' && bin.arch !== process.arch) {
      fail(
        `Nativní modul better-sqlite3 je pro ${bin.arch}, ale Node běží jako ${process.arch}.`,
        'Smaž node_modules a spusť `npm install` znovu.'
      );
    }
  }

  // 6) Stažený Electron patří k tomuhle systému?
  const electronPath = read(path.join('node_modules', 'electron', 'path.txt'));
  if (electronPath) {
    const p = electronPath.toString('utf8').trim();
    const forWin = p.endsWith('.exe');
    const forMac = p.includes('.app/');
    const mismatch = (here === 'win32' && !forWin) || (here === 'darwin' && !forMac);
    if (mismatch) {
      fail(
        `Stažený Electron patří k jinému systému (${p}).`,
        'Smaž node_modules a spusť `npm install` znovu.'
      );
    }
  }

  const electronPkg = readJson(path.join('node_modules', 'electron', 'package.json'));
  const builderPkg = readJson(path.join('node_modules', 'electron-builder', 'package.json'));
  if (electronPkg && builderPkg) {
    notes.unshift(`Electron ${electronPkg.version}, electron-builder ${builderPkg.version}, Node ${process.versions.node} (${process.platform}/${process.arch}).`);
  }

  // 7) Podpis a notarizace na macOS — jen informativně
  if (here === 'darwin' && !problems.length) {
    const haveCreds = process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID;
    if (!haveCreds) {
      warn('APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID nejsou nastavené — notarizace se přeskočí. '
        + 'Aplikace bude fungovat, ale na cizím Macu ji jde poprvé spustit jen pravým klikem → Otevřít.');
    }
  }
}

/* ------------------------------------------------------------------ */
/* Kontrola sestavených souborů                                        */
/* ------------------------------------------------------------------ */

/**
 * electron-builder zabalí, co najde — když některý krok buildu tiše neproběhl,
 * vznikne instalátor s prázdným oknem. Proto se před balením ověří, že
 * v dist/ leží všechny tři části aplikace.
 */
function checkDist() {
  const pkg = readJson('package.json');
  const entry = pkg?.main;
  if (!entry) {
    fail('V package.json chybí pole `main`.');
    return;
  }

  const required = [
    [entry, 'hlavní proces', 'npm run build:main'],
    ['dist/main/preload/preload.js', 'preload skript', 'npm run build:main'],
    ['dist/renderer/index.html', 'rozhraní aplikace', 'npm run build:renderer']
  ];

  for (const [rel, what, how] of required) {
    if (!exists(rel)) {
      fail(`Chybí ${what} (${rel}).`, `Spusť \`${how}\`.`);
    }
  }

  // Vite vysází JS bundle do dist/renderer/assets — prázdná složka znamená,
  // že build renderer části doběhl do prázdna
  const assetsDir = path.join(ROOT, 'dist', 'renderer', 'assets');
  if (fs.existsSync(assetsDir)) {
    const js = fs.readdirSync(assetsDir).filter((f) => f.endsWith('.js'));
    if (!js.length) fail('V dist/renderer/assets není žádný JS soubor.', 'Spusť `npm run build:renderer` znovu.');
  } else if (exists('dist/renderer/index.html')) {
    fail('Chybí dist/renderer/assets.', 'Spusť `npm run build:renderer` znovu.');
  }

  // Odkazy v index.html musí být relativní (base: './'), jinak se v zabalené
  // aplikaci načítané přes file:// nenajdou
  const html = read('dist/renderer/index.html');
  if (html && /(?:src|href)="\//.test(html.toString('utf8'))) {
    fail(
      'dist/renderer/index.html odkazuje na soubory absolutní cestou od kořene.',
      'V zabalené aplikaci se načítá přes file:// a takové odkazy nefungují. '
      + "Ověř, že vite.config.ts má `base: './'`."
    );
  }
}

/* ------------------------------------------------------------------ */

const [mode, ...rest] = process.argv.slice(2);
const targetArg = (rest.find((a) => a.startsWith('--target=')) ?? '--target=auto').slice('--target='.length);

if (mode === 'env') {
  checkEnv(targetArg);
} else if (mode === 'dist') {
  checkDist();
} else if (mode === 'tools') {
  checkNativeToolchain();
} else {
  console.error('Použití: node scripts/preflight.mjs env [--target=mac|win|auto] | dist | tools');
  process.exit(2);
}

for (const n of notes) console.log(`  · ${n}`);

if (problems.length) {
  console.error(mode === 'tools' ? '\n  Chybí nástroje pro kompilaci:\n' : '\n  Build zastaven:\n');
  for (const p of problems) console.error(`   ✖ ${p}\n`);
  process.exit(1);
}

const OK = {
  env: '  ✓ prostředí je připravené',
  dist: '  ✓ sestavené soubory jsou kompletní',
  tools: '  ✓ kompilátor pro nativní moduly je k dispozici'
};
console.log(OK[mode]);
