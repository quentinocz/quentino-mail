/**
 * Upraví pravidla obsahu (CSP) v sestaveném rozhraní pro iOS.
 *
 * Původní hlavička je psaná pro Electron — počítá s `file://` a vývojovým
 * serverem na localhostu. V aplikaci běží stránka pod vlastním schématem
 * `quentino:`, kterému se musí povolit skripty, styly i vstřikovaný můstek,
 * jinak zůstane bílá obrazovka.
 */
import fs from 'fs';

const file = process.argv[2] || 'ios/QuentinoApp/Resources/renderer/index.html';

const csp = [
  "default-src 'self' quentino:",
  "script-src 'self' quentino: 'unsafe-inline'",
  "style-src 'self' quentino: 'unsafe-inline'",
  "img-src 'self' quentino: data: https:",
  "font-src 'self' quentino: data:",
  "frame-src 'self' data: about:",
  "connect-src 'self' quentino: data:"
].join('; ');

let html = fs.readFileSync(file, 'utf8');
const before = html;
html = html.replace(
  /<meta http-equiv="Content-Security-Policy"[^>]*>/,
  `<meta http-equiv="Content-Security-Policy" content="${csp}">`
);
if (html === before) {
  console.warn('CSP hlavička nenalezena — index.html se nezměnil.');
} else {
  fs.writeFileSync(file, html);
  console.log('CSP upraveno pro iOS.');
}
