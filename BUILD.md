# Sestavení aplikace

Quentino Mail je Electron aplikace. Používá **nativní modul `better-sqlite3`**, což je
jediná věc, která celý postup komplikuje: nativní modul se kompiluje pro konkrétní
operační systém a procesor, takže **build pro Windows musí proběhnout na Windows**
a build pro macOS na macOS. Křížem to nejde.

Totéž platí pro **procesor**: instalátor pro x64 se musí sestavit na x64 stroji,
instalátor pro ARM na ARM stroji. Tohle je zrádnější než rozdíl systémů, protože
build proběhne bez jediné chybové hlášky — a rozbité je až to, co dostane zákazník.

Projekt to hlídá sám — před každým balením proběhne kontrola (`scripts/preflight.mjs`),
která build zastaví dřív, než vznikne instalátor, co by spadl až u zákazníka. Když
kontrola něco najde, vypíše, co s tím; seznam hlášek je [na konci](#kdyz-build-selze).

**Na vyzkoušení aplikace žádný build nepotřebuješ.** `npm start` ji sestaví a spustí
nativně pro procesor, na kterém zrovna jsi, ať je jakýkoli. Omezení výše se týkají
jen výroby instalátoru pro někoho jiného.

---

## Co musí být na počítači nainstalované

### Společné pro obě platformy

| Co | Verze | Kde vzít |
| --- | --- | --- |
| Node.js | 20 nebo 22 (LTS) | <https://nodejs.org> — instalátor obsahuje i npm |
| Git | libovolná | jen pokud projekt klonuješ, ne pokud kopíruješ složku |

Ověření, že je vše na místě:

```bash
node -v      # v20.x nebo v22.x
npm -v
```

### macOS navíc

**Xcode Command Line Tools** — obsahují kompilátor, kterým se `better-sqlite3` sestaví:

```bash
xcode-select --install
```

Pokud už jsou nainstalované, příkaz to oznámí a skončí. Celé Xcode potřeba není.

### Windows navíc

`better-sqlite3` nemá hotovou binárku pro každou kombinaci Windows, procesoru a verze
Electronu, takže se běžně kompiluje ze zdrojáků. K tomu je potřeba **Python 3**
a **C++ kompilátor z Visual Studio Build Tools**. Bez nich `npm install` spadne
uprostřed kroku `postinstall` hláškou `Could not find any Python installation to use`.

Nejrychleji přes winget:

```powershell
winget install -e --id Python.Python.3.11
winget install -e --id Microsoft.VisualStudio.2022.BuildTools --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

> **Schválně Build Tools 2022, ne novější.** node-gyp 9 hledá Visual Studio
> napevno podle verzí 12 až 17 (VS 2013 až 2022). **Visual Studio 2026 má verzi 18
> a node-gyp ho přejde** hláškou `Could not find any Visual Studio installation
> to use`, i když je nainstalované celé — [nodejs/node-gyp#3282](https://github.com/nodejs/node-gyp/issues/3282).
> Když už 2026 na počítači máš, nech ho být a doinstaluj Build Tools 2022 vedle;
> vedle sebe fungují.

> **Schválně Python 3.11, ne novější.** `electron-builder` si přes `@electron/rebuild`
> nese **node-gyp 9**, jehož `gyp` importuje modul `distutils` — a ten byl
> z Pythonu **3.12 odstraněn** ([PEP 632](https://peps.python.org/pep-0632/)).
> S Pythonem 3.12+ kompilace skončí na `ModuleNotFoundError: No module named 'distutils'`.
> Když už 3.12 nainstalovaný máš, buď doplň `py -3 -m pip install setuptools`,
> nebo nainstaluj 3.11 a nasměruj na něj npm:
>
> ```powershell
> py -3.11 -c "import sys; print(sys.executable)"
> npm config set python "<cesta, kterou to vypsalo>"
> ```

Instalace Build Tools trvá i deset minut a nic mezitím nevypisuje. Potom **zavři
okno příkazové řádky a otevři nové** — jinak se nenačte změněná PATH a Python
zůstane „nenalezený" i po instalaci.

> **Pozor na Python z Microsoft Store.** Když napíšeš `python` a Windows nabídnou
> instalaci ze Storu, vznikne jen zástupce, který node-gyp nerozpozná. Nainstaluj
> Python přes winget nebo z <https://python.org> s volbou „Add Python to PATH".

Na **ARM počítači** je potřeba ještě jedna komponenta navíc. Úloha „Desktop
development with C++" přidá jen nástroje pro x64/x86 — sada pro ARM64 je zvlášť
a bez ní kompilace skončí na `error MSB8020: Nenašly se nástroje sestavení pro v143`.
Doplníš ji takhle:

1. Spusť **Visual Studio Installer** (je v nabídce Start)
2. U položky **Visual Studio Build Tools 2022** klikni na **Upravit**
3. Přepni na záložku **Jednotlivé komponenty** a do hledání napiš `ARM64`
4. Zaškrtni **„MSVC v143 – VS 2022 C++ ARM64/ARM64EC build tools (Latest)"**
5. Vpravo dole **Upravit** a nech to doinstalovat

Nebo jedním příkazem:

```powershell
& "C:\Program Files (x86)\Microsoft Visual Studio\Installer\setup.exe" modify `
  --installPath "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools" `
  --add Microsoft.VisualStudio.Component.VC.Tools.ARM64 --passive --norestart
```

Kontrola `npm run check` tuhle komponentu ověřuje podle procesoru, na kterém
zrovna běží — na x64 stroji chce `…VC.Tools.x86.x64`, na ARM `…VC.Tools.ARM64`.

Ověření — tohle projde jen tehdy, když je vše na místě:

```powershell
npm run check
```

---

## Příprava projektu

Na novém počítači vždy nejdřív:

```bash
cd cesta/k/quentino-mail
npm install
```

`npm install` udělá dvě věci: stáhne závislosti a přes krok `postinstall` spustí
`electron-builder install-app-deps`, který **zkompiluje `better-sqlite3` pro tvůj
systém a pro verzi Electronu použitou v projektu**. Bez toho aplikace nenaběhne.

Když se něco pokazí zrovna v tomhle kroku, spusť ho samostatně:

```bash
npx electron-builder install-app-deps
```

Kontrola, že je prostředí připravené (nic nesestavuje, jen se rozhlédne):

```bash
npm run check
```

Zkouška, že vše funguje, ještě před sestavením instalátoru:

```bash
npm start
```

---

## Příkazy

| Příkaz | Co dělá |
| --- | --- |
| `npm run check` | Ověří prostředí — Node, závislosti, nativní modul. Nic nesestavuje. |
| `npm run typecheck` | Zkontroluje typy v hlavním procesu i v rozhraní. |
| `npm run clean` | Smaže `dist/`. S `-- --release` smaže i hotové instalátory v `release/`. |
| `npm run build` | Úklid + sestavení hlavního procesu a rozhraní do `dist/`. |
| `npm start` | Sestaví a spustí aplikaci lokálně. |
| `npm run dev` | Vývojový režim s hot reloadem. |
| `npm run dist` | Instalátor **pro systém, na kterém stojíš**. |
| `npm run dist:mac` | Instalátor pro macOS. Na jiném systému se odmítne spustit. |
| `npm run dist:win` | Instalátor pro Windows. Na jiném systému se odmítne spustit. |

Všechny tři `dist:*` příkazy dělají totéž v tomhle pořadí: kontrola prostředí →
kontrola typů → úklid → sestavení → kontrola, že v `dist/` je kompletní aplikace →
zabalení. Kterýkoli krok umí build zastavit.

---

## Build pro macOS

```bash
cd cesta/k/quentino-mail
npm run dist:mac
```

Výsledky najdeš ve složce `release`:

- `quentino-mail-1.0.0-arm64.dmg` — instalátor
- `quentino-mail-1.0.0-arm64.zip` — tatáž aplikace zabalená
- `release/mac-arm64/Quentino Mail.app` — hotová aplikace

Buildí se pro **Apple Silicon (arm64)**. Na Intel Macu takto sestavená aplikace
nepoběží.

### Rozdávání aplikace bez certifikátu

Build dostane vždycky aspoň **provizorní podpis** (`scripts/afterpack-adhoc.cjs`).
Bez něj by se aplikace na Apple Silicon vůbec nespustila — systém by ji ukončil
hláškou „je poškozená a nelze ji otevřít". Notarizaci to ale nenahrazuje.

Co uvidí příjemce, závisí na tom, **jak se k aplikaci dostane**:

| Cesta | Co se stane |
| --- | --- |
| **USB flashka nebo sdílená složka v síti** | Otevře se rovnou, bez varování. Kopírování z disku nebo ze sítě značku „staženo z internetu" nepřidává. |
| Stažení z prohlížeče, AirDrop, e-mail | Jednorázové varování Gatekeeperu — viz níže. |

Takže nejjednodušší cesta ke kolegům bez jediného varování a bez terminálu:

1. Stáhni `.dmg` na svém Macu, otevři a přetáhni aplikaci do Aplikací
2. Jednou u sebe sundej značku:
   ```bash
   xattr -dr com.apple.quarantine "/Applications/Quentino Mail.app"
   ```
3. Zkopíruj `Quentino Mail.app` na flashku nebo do sdílené složky
4. Kolega si ji přetáhne do svých Aplikací a spustí dvojklikem

Když aplikace přijde stažením, musí příjemce na **macOS 15 Sequoia a novějším**
projít tudy (pravý klik → Otevřít už Apple zrušil):

1. dvojklik → objeví se varování, kliknout na **Hotovo**
2. **Systémová nastavení → Soukromí a zabezpečení** → dole řádek
   *„Quentino Mail bylo zablokováno…"* → **Přesto otevřít**

Na macOS 14 a starším stačí pravý klik na aplikaci → **Otevřít** → **Otevřít**.

### Podpis a notarizace

Bez certifikátu se aplikace nepodepíše. Funguje, ale na cizím Macu ji jde poprvé
spustit jen pravým klikem → **Otevřít**. Kontrola před buildem na to upozorní.

S členstvím v Apple Developer Programu ($99/rok) stačí před buildem nastavit tři
proměnné — konfigurace už s nimi počítá a bez nich notarizaci sama přeskočí:

```bash
export APPLE_ID="tvuj@apple-id.cz"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="TVUJTEAMID"
npm run dist:mac
```

- **Certifikát** vytvoříš v Xcode → Settings → Accounts → Manage Certificates → **+** →
  *Developer ID Application*. Ověření: `security find-identity -v -p codesigning`
- **Heslo pro aplikaci** vygeneruješ na <https://appleid.apple.com> → Přihlášení a
  zabezpečení → Hesla pro aplikace
- **Team ID** najdeš na <https://developer.apple.com/account> → Membership

Notarizace trvá typicky 2–10 minut a build na ni počká.

---

## Build pro Windows

Musí běžet **na Windows** (stačí virtuál nebo běžný počítač). Zkopíruj nebo naklonuj
projekt **bez složky `node_modules`**, pak:

```powershell
cd cesta\k\quentino-mail
npm install
npm run dist:win
```

Výsledek je v `release`: instalátor `quentino-mail-setup-1.0.0-x64.exe` (NSIS, x64).
Instaluje se pro přihlášeného uživatele, takže nevyžaduje práva správce, a umožňuje
zvolit cílovou složku.

Nepodepsaný instalátor ohlásí SmartScreen varování — uživatel musí kliknout na
**Více informací → Přesto spustit**. Odstranit to jde jen kódovým podpisovým
certifikátem (Code Signing), který je placený.

<a id="windows-na-arm-nestaci"></a>

### Windows na ARM nestačí

Windows ve virtuálu na Apple Silicon Macu (Parallels, VMware, UTM) je vždycky
**ARM verze** — Apple Silicon x64 Windows spustit neumí. Totéž platí pro Surface
a notebooky se Snapdragonem. Takový stroj **instalátor pro běžné x64 Windows PC
bezpečně nevyrobí**:

- `npm install` zkompiluje `better-sqlite3` pro arm64 (v logu je vidět
  `installing native dependencies arch=arm64`);
- `electron-builder.yml` staví `nsis` pro x64;
- arm64 knihovna se do x64 aplikace nenačte, ale zabalí se bez chyby.

Kontrola před buildem tohle zastaví hláškou *„electron-builder.yml staví Windows
pro x64, ale tenhle počítač je arm64"*. Cesty ven jsou tři:

| Kudy | Co to obnáší |
| --- | --- |
| **x64 Windows počítač** | Fyzický stroj nebo virtuál na Intel/AMD. Nejjednodušší, když ho máš po ruce. |
| **GitHub Actions** | Runner `windows-latest` je x64. Projekt se musí dostat do Git repozitáře, build pak běží v cloudu při každém tagu. Pro soukromé repozitáře je měsíční příděl minut zdarma. |
| **Cloudový Windows virtuál** | Azure / AWS na hodinu. Řádově koruny, ale nastavení je na půl hodiny. |

Na ARM stroji jde aplikaci pořád **vyzkoušet** (`npm start`) a klidně i sestavit
instalátor sám pro sebe — stačí v `electron-builder.yml` v sekci `win` přepsat
`arch: [x64]` na `arch: [arm64]`. Takový instalátor ale nedávej dál, na běžném
Windows PC nepoběží.

---

## Na co si dát pozor

**Nekopíruj `node_modules` mezi počítači.** Obsahuje zkompilovanou verzi
`better-sqlite3` pro konkrétní systém. Kontrola před buildem tohle pozná — přečte
si hlavičku binárky a build zastaví — ale nejjistější je složku vůbec nepřenášet
a udělat čisté `npm install`.

**Instalátor pro Windows nejde vyrobit na Macu ani naopak.** Dřív to šlo omylem
spustit a vznikl instalátor, který spadl až u zákazníka; dnes to `npm run dist:win`
na Macu rovnou odmítne. `npm run dist` bez přepínače sestaví instalátor pro systém,
na kterém zrovna stojíš.

**Stejně tak nejde vyrobit x64 instalátor na ARM stroji.** Viz
[Windows na ARM nestačí](#windows-na-arm-nestaci) — tohle je jediná chyba z celého
seznamu, kterou by bez kontroly nikdo nepoznal, protože build proběhne v pořádku.

**Verzi aplikace** změníš v `package.json` v poli `version`. Promítne se do názvů
instalátorů.

**Konce řádků** hlídá `.gitattributes` — v repozitáři jsou vždy LF, i když se
projekt naklonuje na Windows.

**Data uživatele** (účty, nastavení, archiv, databáze) se ukládají mimo aplikaci:

- macOS: `~/Library/Application Support/quentino-mail`
- Windows: `%APPDATA%\quentino-mail`

Přeinstalace novou verzí o ně tedy nepřipraví.

---

<a id="ci"></a>

## Sestavení přes GitHub Actions

V `.github/workflows/release.yml` je nachystaný build, který vyrobí **oba
instalátory najednou** na cizích počítačích — Windows x64 na runneru
`windows-latest`, macOS arm64 na `macos-14`. Tím odpadají všechny starosti
s architekturami, Pythonem i Visual Studiem: runnery mají nástroje připravené
a mají správný procesor.

### Jak se to spustí

Označením verze:

```bash
npm version 1.0.1 --no-git-tag-version   # změní číslo v package.json
git add -A && git commit -m "Verze 1.0.1"
git tag v1.0.1
git push && git push --tags
```

Za deset minut jsou instalátory v záložce **Releases**. Bez tagu jde build
spustit i ručně — záložka **Actions** → *Instalátory* → **Run workflow**; výsledky
pak visí u běhu jako *Artifacts* a mažou se po 30 dnech.

### Co stojí za pozornost

- **Python je pevně 3.11.** Novější verze nemá `distutils`, který node-gyp 9
  potřebuje. Bez toho kroku by build spadl stejně jako lokálně.
- **Windows runner je pevně `windows-2022`, ne `windows-latest`.** Ten má dnes
  Visual Studio 2026 (verze 18), které node-gyp 9 nerozpozná. Až electron-builder
  povýší node-gyp, dá se vrátit zpátky. Kdyby GitHub `windows-2022` jednou
  vyřadil, bude potřeba buď novější electron-builder, nebo `overrides` na
  node-gyp v `package.json`.
- **Instalátory nejsou podepsané.** Windows ohlásí SmartScreen, macOS vyžádá
  pravý klik → Otevřít. Pro podpis a notarizaci macOS verze přidej v repozitáři
  *Settings → Secrets and variables → Actions* položky `APPLE_ID`,
  `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, `CSC_LINK` (certifikát .p12
  zakódovaný v base64) a `CSC_KEY_PASSWORD`, předej je kroku *Sestavení
  instalátoru* a smaž řádek `CSC_IDENTITY_AUTO_DISCOVERY`.
- **Minuty.** U soukromého repozitáře je zdarma 2 000 minut měsíčně, ale Windows
  se počítá dvojnásobně a macOS **desetinásobně**. Jedno vydání sebere kolem
  90 minut, takže se vejdeš zhruba do dvaceti vydání měsíčně. Proto se build
  spouští jen na tag, ne při každém commitu.
- **Lokální build tím nezaniká.** `npm run dist:mac` na Macu je dál nejrychlejší
  cesta k odzkoušení a jako jediný umí použít certifikáty z tvého keychainu.

---

<a id="kdyz-build-selze"></a>

## Když build selže

### Hlášky kontroly před buildem

| Hláška | Co s tím |
| --- | --- |
| `Instalátor pro Windows nejde sestavit na macOS` | Přenes projekt (bez `node_modules`) na Windows a spusť build tam. |
| `electron-builder.yml staví Windows pro x64, ale tenhle počítač je arm64` | Viz [Windows na ARM nestačí](#windows-na-arm-nestaci). |
| `Sestavení instalátoru z Linux není podporované` | Aplikace se balí jen na macOS a na Windows. |
| `Chybí Python 3` | `winget install -e --id Python.Python.3.11` a otevři nové okno příkazové řádky. |
| `Python 3.12 neobsahuje modul distutils` | `py -3 -m pip install setuptools`, nebo přejít na Python 3.11 — postup je přímo v hlášce. |
| `Nejsou nainstalované Visual Studio Build Tools (C++)` | Příkaz je přímo v hlášce; pak nové okno a `npm install`. |
| `Ve Visual Studiu chybí komponenta „MSVC v143 …"` | Postup je přímo v hlášce; podrobně v sekci s požadavky pro Windows. |
| `node-gyp … neumí rozpoznat Visual Studio 2026` | Doinstaluj Build Tools **2022** vedle stávajícího — příkaz je v hlášce. |
| `Nejsou nainstalované Xcode Command Line Tools` | `xcode-select --install` |
| `Nativní modul better-sqlite3 je zkompilovaný pro …` | `node_modules` je z jiného počítače. Smaž ji a spusť `npm install`. |
| `Nativní modul better-sqlite3 není sestavený` | `npx electron-builder install-app-deps` |
| `Stažený Electron patří k jinému systému` | Totéž — smaž `node_modules` a `npm install`. |
| `Chybí hlavní proces / preload skript` | `npm run build:main` |
| `Chybí rozhraní aplikace` / `V dist/renderer/assets není žádný JS soubor` | `npm run build:renderer` |
| `dist/renderer/index.html odkazuje … absolutní cestou` | Ve `vite.config.ts` musí zůstat `base: './'`. |
| `Node.js … je pro sestavení příliš starý` | Nainstaluj Node.js 20 nebo 22 (LTS). |

### Hlášky nástrojů

| Hláška | Co s tím |
| --- | --- |
| `gyp ERR!`, `node-gyp rebuild failed` | Chybí kompilátor — viz sekce s požadavky pro tvůj systém. Pak `npx electron-builder install-app-deps` |
| `ModuleNotFoundError: No module named 'distutils'` | Python je 3.12 nebo novější — viz řádek o distutils v tabulce výše. |
| `Could not find any Visual Studio installation to use` | Buď VS není vůbec, nebo je to VS 2026, které node-gyp nezná. `npm run check` rozliší které. |
| `error MSB8020: Nenašly se nástroje sestavení pro v143` | Ve Visual Studiu chybí sada nástrojů pro tenhle procesor — na ARM stroji komponenta `…VC.Tools.ARM64`. |
| `Cannot find module 'better-sqlite3'` nebo pád při startu | Nativní modul není sestavený: `npx electron-builder install-app-deps` |
| `Rollup failed to resolve import` | Chybí některá závislost: `npm install` |
| `Cannot find module '@rollup/rollup-…'` | Rozbité `node_modules` po přenosu mezi systémy: smaž složku a `npm install` |
| `skipped macOS application code signing` | Jen upozornění, že není certifikát. Aplikace se sestaví a funguje. |
| `dist/ se nepodařilo smazat` | Běží ještě Electron z předchozího spuštění, nebo je složka otevřená v Průzkumníku. |
