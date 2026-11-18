/**
 * Nápověda k modulům — zkouška obsahu.
 *
 * ## Proč
 *
 * Nápověda stárne potichu: přejmenuje se tlačítko, zmizí sloupec — a návod
 * dál ukazuje na něco, co v okně není. „Ukázat" by pak neukázalo nic a
 * člověk by hledal tlačítko, které neexistuje. Proto se tu kontroluje:
 *
 *  - každé téma, na které míří otazník v modulu, existuje,
 *  - každý krok odkazuje na oblast, která v mapě okna je,
 *  - každý prvek k ukázání (`target`) má v kódu rozhraní své třídy,
 *  - každé `[Tlačítko]` v textu je v kódu rozhraní napsané (popisek se
 *    nezměnil),
 *  - oblasti mapy leží v mřížce 12 × 8 a nepřekrývají se.
 *
 *   node tools/help-test.cjs
 */
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src/renderer/src');

const built = esbuild.buildSync({
  entryPoints: [path.join(SRC, 'help/index.ts')],
  bundle: true, format: 'cjs', platform: 'node', write: false
});
const mod = { exports: {} };
new Function('module', 'exports', 'require', built.outputFiles[0].text)(mod, mod.exports, require);
const { HELP_TOPICS, helpTopic } = mod.exports;

let bad = 0;
const ok = (label, value, note = '') => {
  if (!value) bad++;
  console.log(`  ${value ? '✓' : '✗'} ${label}${note ? `   ${note}` : ''}`);
};

/* Celý kód rozhraní jako jeden text — v něm se hledají třídy a popisky */
const files = [];
(function walk(dir) {
  for (const one of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, one.name);
    if (one.isDirectory()) { if (one.name !== 'help') walk(full); } else if (/\.(tsx|ts)$/.test(one.name)) files.push(full);
  }
})(SRC);
const code = files.map(one => fs.readFileSync(one, 'utf8')).join('\n');
const css = fs.readFileSync(path.join(SRC, 'styles.css'), 'utf8');

console.log('\nnápověda — témata:\n');

/* Otazníky v modulech */
const pouzita = [...code.matchAll(/<HelpButton[^>]*topic=\{?([^}>]+)\}?/g)]
  // U podmínky (`tab === 'new' ? 'newproduct' : 'ptrans'`) jen výsledky, ne porovnání
  .map(m => (m[1].includes('?') ? m[1].slice(m[1].indexOf('?')) : m[1]))
  .flatMap(expr => [...expr.matchAll(/'([a-z]+)'|"([a-z]+)"/g)].map(x => x[1] || x[2]));
const chybi = pouzita.filter(id => !helpTopic(id));
ok(`otazník je v ${new Set(pouzita).size} modulech a každé téma existuje`, pouzita.length >= 15 && chybi.length === 0,
  chybi.length ? `chybí: ${chybi.join(', ')}` : [...new Set(pouzita)].join(', '));
const bezOtazniku = HELP_TOPICS.filter(t => !pouzita.includes(t.id)).map(t => t.id);
ok('  a každé téma má v aplikaci svůj otazník', bezOtazniku.length === 0, bezOtazniku.join(', '));

for (const topic of HELP_TOPICS) {
  const vady = [];
  if (!topic.intro || topic.intro.length < 60) vady.push('krátký úvod');
  if (topic.guides.length < 1) vady.push('žádný postup');
  const oblasti = new Set(topic.areas.map(a => a.id));
  /* Mřížka a překryvy */
  const obsazeno = new Map();
  for (const a of topic.areas) {
    if (a.x < 0 || a.y < 0 || a.x + a.w > 12 || a.y + a.h > 8) vady.push(`oblast ${a.id} mimo mřížku`);
    for (let x = a.x; x < a.x + a.w; x++) for (let y = a.y; y < a.y + a.h; y++) {
      const k = `${x},${y}`;
      if (obsazeno.has(k)) vady.push(`${a.id} překrývá ${obsazeno.get(k)}`);
      obsazeno.set(k, a.id);
    }
  }
  const targets = [];
  for (const a of topic.areas) if (a.target) targets.push(a.target);
  for (const guide of topic.guides) {
    if (guide.steps.length < 2) vady.push(`„${guide.title}" má jediný krok`);
    for (const step of guide.steps) {
      if (step.area && !oblasti.has(step.area)) vady.push(`krok míří na neznámou oblast ${step.area}`);
      if (step.target) targets.push(step.target);
    }
  }
  /* Třídy z výběrů musí v kódu rozhraní existovat */
  for (const t of targets) {
    for (const cls of t.match(/\.[a-zA-Z][\w-]*/g) ?? []) {
      const name = cls.slice(1);
      if (!new RegExp(`["'\` ]${name}["'\` ]|className="${name}|\\b${name}\\b`).test(code)) vady.push(`třída ${name} v kódu není`);
    }
  }
  /* Popisky tlačítek v textu musí v kódu být (přesně, nebo jako začátek) */
  const texty = [topic.intro, ...topic.tips, ...(topic.warnings ?? []),
    ...topic.guides.flatMap(g => g.steps.map(s => s.text))];
  for (const text of texty) {
    for (const m of text.matchAll(/\[([^\]]+)\]/g)) {
      const label = m[1].replace(/\s*…$/, '').replace(/ \(EN…\)$/, '');
      if (!code.includes(label)) vady.push(`tlačítko „${label}" v kódu není`);
    }
  }
  ok(`${topic.title} — ${topic.guides.length} postupy, ${topic.areas.length} oblasti`, vady.length === 0,
    [...new Set(vady)].slice(0, 4).join(' · '));
}

ok('styly nápovědy jsou v styles.css', /\.hp-panel\b/.test(css) && /\.hp-spot\b/.test(css));

console.log(bad ? `\n✗ ${bad} chyb` : '\n✓ nápověda sedí');
process.exit(bad ? 1 : 0);
