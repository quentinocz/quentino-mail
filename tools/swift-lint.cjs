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
 *
 * ## 3. Dlouhý výraz plný `as? String ?? ""`
 *
 * Swift odvozuje typy i tam, kde je člověku všechno jasné, a u pole s osmi
 * přetypováními, které se ještě spojuje s jiným polem a prohání přes `filter`
 * a `joined`, to vzdá: **„unable to type-check this expression in reasonable
 * time"**. Není to varování, překlad spadne — a tady se to nepozná, protože
 * Xcode v tomhle prostředí není.
 *
 * Náprava: rozepsat to. Sloupce po jednom do `var parts: [String] = []`
 * a mezivýsledky do proměnných s uvedeným typem.
 *
 * Hlídá se právě ta kombinace, ne přetypování sama o sobě: obyčejný slovník
 * s deseti `as? String ?? ""` má typ daný okolím a přeloží se bez potíží.
 * Teprve když se takové pole ještě spojuje s jiným a prohání přes `filter`
 * nebo `joined`, nemá se odvozování o co opřít.
 *
 * ## 4. `.int(promenna)` v parametrech dotazu
 *
 * `SQLite.Value.int` bere `Int64`, ne `Int`. U čísla napsaného rovnou
 * (`.int(1)`) to nevadí — literál se přizpůsobí — ale u proměnné překlad
 * spadne na „cannot convert value of type 'Int' to expected argument type
 * 'Int64'". V TypeScriptu je to jedno číslo a nic nenapovídá, že tady musí
 * být obal, takže se to píše špatně pokaždé.
 *
 * Náprava: `.int(Int64(limit))`.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'ios');
const REPO = path.join(__dirname, '..');

/** Řádek tvaru `"klíč": [` — začátek vnořeného literálu */
const OPENS_NESTED = /^\s*"[^"]+"\s*:\s*\[\s*$/;

/** `data(withJSONObject: … ?? NSNull())` — serializace něčeho, co nemusí být slovník */
const NULL_TO_JSON = /data\(withJSONObject:[^)]*NSNull\(\)/;

/** Přetypování textu — jedno je v pořádku, hromada v jednom výrazu ne */
const CAST = /as\?\s*String\s*\?\?/g;

/** Kolik jich v jednom výrazu překladač ještě unese */
const CAST_LIMIT = 4;

/**
 * Co z výrazu dělá hádanku: spojení dvou polí, nebo metoda pověšená rovnou
 * na uzavírací závorku literálu. Přetypování uvnitř `[SQLite.Value]` samo
 * o sobě v pořádku je — typ je daný okolím a překladač ho nemusí hledat.
 */
const CHAINED = /\]\s*\+\s*[([]|\]\s*\)?\s*\.(filter|map|compactMap|joined|reduce)\b/;

/**
 * `.int(něco)` v parametrech dotazu. Číslo napsané rovnou i podmínka
 * s jedničkou a nulou (`.int(done ? 1 : 0)`) jsou v pořádku — literál se na
 * `Int64` přizpůsobí sám. Problém dělá proměnná.
 */
const SQL_INT = /(^|[[\s,(])\.int\(([^()?]*)\)/g;

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

  /*
   * Výraz se počítá od řádku, který otevírá hranatou závorku, po ten, který
   * ji zavírá — tam se přetypování hromadí. Čtyři jsou ještě v pohodě,
   * osm překlad shodilo.
   */
  for (let i = 0; i < lines.length; i++) {
    if (!/\[\s*$/.test(lines[i])) continue;
    const end = endOfLiteral(lines, i);
    const body = lines.slice(i, end + 1).join('\n');
    const casts = (body.match(CAST) || []).length;
    if (casts <= CAST_LIMIT || !CHAINED.test(body)) continue;

    found++;
    console.log(`  ✗ ${path.relative(REPO, file)}:${i + 1} — ${casts} přetypování v jednom výrazu`);
    console.log(`      ${lines[i].trim()}`);
    console.log('      rozepiš to: hodnoty po jedné do var parts: [String] = []');
  }

  lines.forEach((line, i) => {
    // `case .int(let n)` je rozebrání hodnoty, ne její tvorba, a `case let n
    // as Int64` už Int64 je — obojí je v pořádku
    if (/^\s*case\b/.test(line)) return;
    for (const match of line.matchAll(SQL_INT)) {
      const inside = match[2].trim();
      // Číslo napsané rovnou je v pořádku, proměnná ne
      if (!inside || /^-?\d+$/.test(inside) || /[Ii]nt64/.test(inside)) continue;
      found++;
      console.log(`  ✗ ${path.relative(REPO, file)}:${i + 1} — .int(${inside}) chce Int64`);
      console.log(`      ${line.trim()}`);
      console.log(`      obal to: .int(Int64(${inside}))`);
    }
  });
}

console.log(found === 0 ? '  ✓ swift: nic podezřelého' : `\n✗ ${found} k opravě`);
process.exit(found === 0 ? 0 : 1);
