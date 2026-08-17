#!/usr/bin/env node
/**
 * Krok `postinstall` — sestavení nativního modulu `better-sqlite3` pro tenhle
 * systém, procesor a verzi Electronu.
 *
 * Volá se odsud a ne přímo z package.json kvůli jediné věci: když kompilace
 * selže, `electron-builder install-app-deps` vypíše třicet řádků zásobníku
 * node-gyp, ve kterých se skutečná příčina ztratí. Nejčastěji přitom jde
 * o chybějící Python nebo C++ kompilátor — a to je něco, co jde říct jednou
 * větou i s příkazem, kterým se to spraví.
 *
 * Návratový kód se zachovává, takže `npm install` selže dál jako předtím.
 */

import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// npm přidává node_modules/.bin do PATH, takže se binárka najde sama.
// shell:true je kvůli Windows, kde jde o electron-builder.cmd.
const built = spawnSync('electron-builder', ['install-app-deps'], {
  stdio: 'inherit',
  shell: true,
  cwd: path.resolve(HERE, '..')
});

if (built.status === 0) process.exit(0);

const line = '──────────────────────────────────────────────────────────────';
console.error(`\n${line}`);
console.error('  Nativní modul better-sqlite3 se nepodařilo sestavit.');
console.error('  Hledám, co chybí:\n');

const tools = spawnSync(process.execPath, [path.join(HERE, 'preflight.mjs'), 'tools'], { stdio: 'inherit' });

console.error('');
if (tools.status === 0) {
  // Kompilátor je na místě, takže příčina je jinde — výš ve výpisu node-gyp.
  console.error('  Kompilátor i Python jsou na místě, chyba je tedy jinde.');
  console.error('  Podívej se na první řádek `gyp ERR!` ve výpisu nahoře;');
  console.error('  BUILD.md má na konci tabulku nejčastějších hlášek.');
} else {
  console.error('  Až bude chybějící doinstalované, otevři NOVÉ okno příkazové');
  console.error('  řádky (kvůli PATH) a spusť `npm install` znovu.');
}
console.error(`${line}\n`);

process.exit(built.status ?? 1);
