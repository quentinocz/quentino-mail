#!/usr/bin/env node
/**
 * Smaže výstupy předchozího buildu.
 *
 * Existuje kvůli tomu, že `rm -rf` na Windows v PowerShellu ani v cmd nefunguje.
 * Bez úklidu by se do instalátoru mohly dostat soubory z dřívějšího buildu —
 * typicky zbytky po přejmenovaném nebo smazaném modulu.
 *
 * Použití:
 *   node scripts/clean.mjs           # dist/ (spouští se před každým buildem)
 *   node scripts/clean.mjs --release # navíc i release/ s hotovými instalátory
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const targets = ['dist'];
if (process.argv.includes('--release')) targets.push('release');

for (const name of targets) {
  const dir = path.join(ROOT, name);

  // Pojistka proti smazání něčeho mimo projekt
  if (path.dirname(dir) !== ROOT || !name || name.includes('..')) {
    console.error(`  ✖ ${name} neleží v projektu, mažu jen podsložky kořene`);
    process.exit(1);
  }

  if (!fs.existsSync(dir)) continue;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`  · smazáno ${name}/`);
  } catch (err) {
    console.error(`  ✖ ${name}/ se nepodařilo smazat: ${err?.message ?? err}`);
    console.error('     → Nemá otevřený běžící Electron nebo otevřené okno Finderu/Průzkumníka?');
    process.exit(1);
  }
}
