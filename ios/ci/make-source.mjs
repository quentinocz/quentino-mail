/**
 * Vytvoří `apps.json` — zdroj pro SideStore.
 *
 * SideStore i AltStore čtou jeden JSON se seznamem aplikací a jejich verzí;
 * odkaz na .ipa musí být veřejně dostupný, jinak si ho aplikace nestáhne.
 *
 * Použití: node ios/ci/make-source.mjs <cesta k .ipa> <výstupní json>
 */
import fs from 'fs';
import path from 'path';

const [, , ipaPath = 'QuentinoApp.ipa', outPath = 'apps.json'] = process.argv;

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const version = pkg.version;
const size = fs.existsSync(ipaPath) ? fs.statSync(ipaPath).size : 0;
const date = new Date().toISOString().slice(0, 10);

// Kam se vydání nahrálo — repozitář s vydáními může být jiný než ten se zdrojáky
const repo = process.env.TARGET_REPO || process.env.GITHUB_REPOSITORY || 'quentinocz/quentino-app';
const tag = process.env.GITHUB_REF_NAME || `ios-v${version}`;
const downloadURL = `https://github.com/${repo}/releases/download/${tag}/${path.basename(ipaPath)}`;

const source = {
  name: 'Quentino',
  identifier: 'cz.quentino.source',
  subtitle: 'Interní aplikace Quentino',
  description: 'Pošta, zákaznický chat a publikování na sociální sítě.',
  website: 'https://www.quentino.cz',
  tintColor: '7c5cff',
  apps: [
    {
      name: 'Quentino App',
      bundleIdentifier: 'cz.quentino.app',
      developerName: 'Quentino',
      subtitle: 'Pošta, chat a sociální sítě',
      localizedDescription:
        'E-mailová schránka s AI asistencí, zákaznický chat z e-shopu a vícejazyčné publikování '
        + 'na Instagram a Facebook. Nastavení se synchronizuje se stolní verzí přes sdílenou složku.',
      iconURL: `https://raw.githubusercontent.com/${repo}/main/build/icon.png`,
      tintColor: '7c5cff',
      category: 'productivity',
      screenshotURLs: [],
      versions: [
        {
          version,
          buildVersion: '1',
          date,
          localizedDescription: `Sestaveno automaticky z tagu ${tag}.`,
          downloadURL,
          size,
          minOSVersion: '16.0'
        }
      ]
    }
  ],
  news: []
};

fs.writeFileSync(outPath, JSON.stringify(source, null, 2));
console.log(`Zdroj zapsán do ${outPath} (verze ${version}, ${(size / 1024 / 1024).toFixed(1)} MB)`);
console.log(`Odkaz ke stažení: ${downloadURL}`);
