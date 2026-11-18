/**
 * Čtení JSON, který ještě není celý.
 *
 * Živý náhled překladu dostává odpověď modelu po kouscích — `{"sk": {"title":
 * "Modrá pán` — a `JSON.parse` na tom spadne až do posledního znaku. Tady
 * se z rozepsané odpovědi vytáhne, co už v ní je: hotové hodnoty celé,
 * rozepsanou poslední hodnotu tak, jak zrovna je.
 *
 * Bere jen objekty a řetězce (víc odpověď překladu nemá); čísla a pole se
 * přeskočí. Na nečekaném znaku čtení skončí a vrátí, co stihlo — náhled je
 * pomůcka, nesmí kvůli němu spadnout nic jiného.
 */

type Tree = { [key: string]: string | Tree };

const END = Symbol('konec');

export function partialJson(raw: string): Tree {
  const text = raw ?? '';
  let i = text.indexOf('{');
  if (i < 0) return {};

  const ws = () => { while (i < text.length && /\s/.test(text[i])) i++; };

  /** Řetězec od uvozovky; rozepsaný vrátí s `open: true`. */
  const str = (): { value: string; open: boolean } => {
    i++;                                   // úvodní uvozovka
    let out = '';
    while (i < text.length) {
      const ch = text[i];
      if (ch === '"') { i++; return { value: out, open: false }; }
      if (ch === '\\') {
        const next = text[i + 1];
        if (next === undefined) break;     // escape se teprve píše
        if (next === 'u') {
          const hex = text.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
          continue;
        }
        out += ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' } as Record<string, string>)[next] ?? next;
        i += 2;
        continue;
      }
      out += ch;
      i++;
    }
    return { value: out, open: true };
  };

  const obj = (into: Tree): void => {
    i++;                                   // {
    for (;;) {
      ws();
      if (i >= text.length) throw END;
      if (text[i] === '}') { i++; return; }
      if (text[i] === ',') { i++; continue; }
      if (text[i] !== '"') throw END;
      const key = str();
      if (key.open) throw END;
      ws();
      if (text[i] !== ':') throw END;
      i++;
      ws();
      if (i >= text.length) throw END;
      if (text[i] === '"') {
        const value = str();
        into[key.value] = value.value;
        if (value.open) throw END;
      } else if (text[i] === '{') {
        const inner: Tree = {};
        into[key.value] = inner;
        obj(inner);
      } else {
        // Číslo, true/false, pole — v odpovědi překladu nejsou; přeskočí se
        while (i < text.length && text[i] !== ',' && text[i] !== '}') i++;
      }
    }
  };

  const root: Tree = {};
  try { obj(root); } catch (e) { if (e !== END) return root; }
  return root;
}
