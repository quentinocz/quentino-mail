/**
 * Drobná kontrola swiftového kódu — na chybu, kterou tady nejde odhalit jinak
 * než čtením.
 *
 * Zdrojáky pro iOS se v tomhle prostředí nepřekládají (Xcode tu není), takže
 * o překlepu se člověk dozví až z běhu na GitHubu — a to je čtvrt hodiny
 * čekání na jeden řádek — a chyby, které se projeví až za běhu, se takhle
 * nechytí vůbec. Skript proto hlídá vzory, které to už jednou způsobily.
 *
 *   node tools/swift-lint.cjs
 *
 * Hlídané vzory jsou dva a oba už jednou překlad nebo běh shodily.
 *
 * ## 1. Vnořený slovník s `NSNull()` psaný rovnou do jiného slovníku
 *
 * Swift si typ `[String: Any]` z vnějšího literálu do vnitřního
 * nepropíše, takže se u podmínky uvnitř pohádá o to, že `NSNull` a text nejsou
 * totéž. Ve vnějším literálu, který má typ z návratové hodnoty funkce, je
 * přitom všechno v pořádku — proto se to špatně hledá okem.
 *
 * Náprava: vytáhnout vnořený slovník do proměnné s uvedeným typem.
 *
 *     let tracking: [String: Any] = [ … ]
 *     return [ "tracking": tracking ]
 *
 * ## 2. `JSONSerialization` nad hodnotou, která může být `NSNull`
 *
 * Na nejvyšší úrovni bere serializace jen pole a slovník. U čehokoli jiného
 * nevyhodí chybu, kterou by `try?` chytil — **shodí aplikaci**. Objednávka bez
 * adresy přitom `NSNull` nese úplně běžně, takže se to projeví až v provozu
 * a jen u některých dat.
 *
 * Náprava: ověřit tvar předem přes `JSONSerialization.isValidJSONObject`.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'ios');
const REPO = path.join(__dirname, '..');

/** Řádek tvaru `"klíč": [` — začátek vnořeného literálu */
const OPENS_NESTED = /^\s*"[^"]+"\s*:\s*\[\s*$/;

/** `data(withJSONObject: … ?? NSNull())` — serializace něčeho, co nemusí být slovník */
const NULL_TO_JSON = /data\(withJSONObject:[^)]*NSNull\(\)/;

function swiftFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...swiftFiles(full));
    else if (entry.name.endsWith('.swift')) out.push(full);
  }
  return out;
}

/** Kde končí literál otevřený na daném řádku — počítají se hranaté závorky. */
function endOfLiteral(lines, from) {
  let depth = 0;
  for (let i = from; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '[') depth++;
      else if (ch === ']') {
        depth--;
        if (depth === 0) return i;
      }
    }
  }
  return lines.length - 1;
}

let found = 0;
for (const file of swiftFiles(ROOT)) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!OPENS_NESTED.test(lines[i])) continue;
    const end = endOfLiteral(lines, i);
    const body = lines.slice(i + 1, end + 1).join('\n');
    if (!body.includes('NSNull()')) continue;

    found++;
    console.log(`  ✗ ${path.relative(REPO, file)}:${i + 1} — vnořený slovník s NSNull()`);
    console.log(`      ${lines[i].trim()}`);
    console.log('      vytáhni ho do proměnné s uvedeným typem: let x: [String: Any] = [ … ]');
  }

  lines.forEach((line, i) => {
    if (!NULL_TO_JSON.test(line)) return;
    found++;
    console.log(`  ✗ ${path.relative(REPO, file)}:${i + 1} — serializace hodnoty, která může být NSNull`);
    console.log(`      ${line.trim()}`);
    console.log('      ověř tvar předem: JSONSerialization.isValidJSONObject(value)');
  });
}

console.log(found === 0 ? '  ✓ swift: nic podezřelého' : `\n✗ ${found} k opravě`);
process.exit(found === 0 ? 0 : 1);
