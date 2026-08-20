/**
 * Verze aplikace podle značky v gitu.
 *
 * Verze se dřív držela ručně v `package.json` a v `ios/project.yml`, takže
 * `git tag ios-v2.1.7` sice spustil sestavení, ale aplikace se dál hlásila
 * jako 1.1.0 — v macOS „O aplikaci", v názvu instalátoru i v SideStore.
 *
 * Tenhle skript je jediné místo, kde se verze určuje: vezme se ze značky
 * (`v2.2.0` i `ios-v2.2.0` dají „2.2.0") a zapíše do `package.json`. Odtud si
 * ji vezme electron-builder, „O aplikaci" i zdroj pro SideStore. iOS ji dostane
 * jako `MARKETING_VERSION` na příkazové řádce `xcodebuild`.
 *
 * Použití:
 *   node scripts/set-version.mjs                 # bere GITHUB_REF_NAME
 *   node scripts/set-version.mjs ios-v2.2.0      # nebo výslovně
 *
 * Vypíše výslednou verzi, takže se dá v CI použít takhle:
 *   VERSION=$(node scripts/set-version.mjs)
 */
import fs from 'fs';

const raw = process.argv[2] || process.env.GITHUB_REF_NAME || '';
const match = raw.match(/(\d+)\.(\d+)\.(\d+)(?:[-.](\d+))?/);

if (!match) {
  // Ruční sestavení bez značky: verze v package.json se nechá, jak je
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  console.log(pkg.version);
  process.exit(0);
}

// Čtvrté číslo (např. „2.2.0.3") se do CFBundleShortVersionString nevejde,
// patří do buildu — proto se z něj bere jen trojice.
const version = `${match[1]}.${match[2]}.${match[3]}`;

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
if (pkg.version !== version) {
  pkg.version = version;
  fs.writeFileSync('package.json', `${JSON.stringify(pkg, null, 2)}\n`);
}
console.log(version);
