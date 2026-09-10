/**
 * Zkouška naplánovaných náhrad textů na webu.
 *
 * Zkouší se dvě strany téže věci a hlavně to, že si rozumí:
 *
 *  1. **aplikace** — počítání pražského času na minutu přesně (včetně noci,
 *     kdy se přehazuje letní čas), hlídání překryvů a to, co se posílá na web,
 *  2. **skript na webu** — že se dá přeložit, že z plánu vybere to, co zrovna
 *     platí, a že když plán chybí nebo je úložiště nedostupné, vykreslí se
 *     přesně to, co se vykreslovalo doteď.
 *
 * Druhá část je tu proto, že přesně tudy vede cesta k tiché chybě: aplikace
 * by vystavila jinak pojmenované pole, než jaké skript čte, obojí by prošlo
 * překladem a na webu by se prostě nic nezměnilo.
 */
const path = require('path');
const { db, DIST } = require('./ptrans/harness.cjs');

let failed = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${label}`);
  if (!ok) { console.log('      čekáno:', JSON.stringify(want)); console.log('      dostal:', JSON.stringify(got)); }
}
function ok(label, value, note = '') {
  check(label + (value ? '' : note ? ` (${note})` : ''), !!value, true);
}

// Trezor mimo Electron není; zkouší se plánování, ne šifrování
const secPath = require.resolve(path.join(DIST, 'secure.js'));
require.cache[secPath] = { id: secPath, filename: secPath, loaded: true, exports: {
  encrypt: v => v, decrypt: v => v
} };

const webtexts = require(path.join(DIST, 'webtexts.js'));
const { headScript } = require(path.join(DIST, 'webscript.js'));
const T = webtexts.__test;

console.log('\ntexty na webu:\n');

/* ---------- pražský čas ---------- */

/*
 * Napevno napsaný posun by fungoval půl roku. V zimě je Praha na +01:00,
 * v létě na +02:00 a plán se dělá i přes ten přechod — dovolená přes konec
 * října by jinak skončila o hodinu jinde, než co je napsané na papíře.
 */
check('zimní čas je UTC+1', new Date(T.czMs('2026-01-15T08:00')).toISOString(), '2026-01-15T07:00:00.000Z');
check('letní čas je UTC+2', new Date(T.czMs('2026-07-15T08:00')).toISOString(), '2026-07-15T06:00:00.000Z');
// Poslední březnová neděle: ve 2:00 se přeskočí na 3:00
check('ráno po přechodu na letní čas', new Date(T.czMs('2026-03-29T08:00')).toISOString(), '2026-03-29T06:00:00.000Z');
check('a zpátky se to trefí', T.czLocal(T.czMs('2026-03-29T08:00')), '2026-03-29T08:00');
check('konec platnosti je včetně své minuty',
  T.czMs('2026-01-15T18:00', true) - T.czMs('2026-01-15T18:00'), 59999);
check('minuta zpět přes půlnoc', T.shiftMinutes('2026-01-15T00:00', -1), '2026-01-14T23:59');

/* ---------- co je platná změna ---------- */

const plan = (over = {}) => T.normalize(Object.assign({
  id: 'a', name: 'Dovolená', from: '2026-07-01T08:00', to: '2026-07-07T18:00',
  topbar: { on: true, text: { cz: '🏖️ Do 7. 7. máme dovolenou', sk: '', en: '' } }
}, over));

check('změna bez konce se neuloží', T.validate(plan({ to: '' })), 'Chybí platnost do.');
check('ani obráceně otočená', T.validate(plan({ to: '2026-06-01T08:00' })),
  'Konec platnosti musí být po jejím začátku.');
check('ani prázdná', T.validate(plan({ topbar: { on: true, text: { cz: '', sk: '', en: '' } } })),
  'Změna nic nenastavuje — vyplň aspoň jeden text.');
check('vyplněná projde', T.validate(plan()), '');
// Emoji jsou v zadání: JSON i úložiště jsou UTF-8, nic se s nimi dělat nemusí
ok('emoji přežije uložení', JSON.parse(T.payload([plan()])).plans[0].topbar.text.cz.includes('🏖️'));

/* ---------- co se posílá na web ---------- */

const vanoce = T.normalize({
  id: 'b', name: 'Vánoce', from: '2026-12-20T00:00', to: '2026-12-26T23:59',
  product: { on: true, ship: { cz: '🎄 Expedujeme až 27. 12.', sk: '', en: '' } },
  links: { on: false, mode: 'add', items: [{ text: { cz: 'nepoužito' } }] },
  button: { on: true, text: { cz: 'Doprava zdarma', sk: '', en: '' } }
});
const vypnuta = T.normalize({
  id: 'c', name: 'Vypnutá', from: '2026-07-02T00:00', to: '2026-07-03T00:00', off: true,
  topbar: { on: true, text: { cz: 'nemá se ukázat' } }
});

const sent = JSON.parse(T.payload([plan(), vanoce, vypnuta]));
check('na web jdou jen zapnuté změny', sent.plans.map(p => p.id), ['a', 'b']);
// Nezaškrtnutá oblast se neposílá — web ji má počítat dál po svém
ok('nezaškrtnutá oblast se neposílá', sent.plans[1].links === undefined);
ok('zaškrtnutá ano', !!sent.plans[1].product);
ok('název změny na web nepatří', sent.plans[0].name === undefined);
ok('časy jdou v milisekundách', typeof sent.plans[0].fromMs === 'number');

/* ---------- vánoční garance ---------- */

/*
 * Garance není naplánovaná změna: platí každý rok ve stejném období.
 * Zadává se proto dnem a měsícem, bez roku — jinak by se na ni muselo
 * každý listopad myslet znovu.
 */
const vychozi = T.season(null);
check('bez nastavení platí to, co bylo napevno',
  [vychozi.on, vychozi.fromDay, vychozi.fromMonth, vychozi.toDay, vychozi.toMonth],
  [true, 1, 12, 18, 12]);
// Nesmysl v datu nesmí garanci umlčet — vrátí se na výchozí den
check('den mimo rozsah se opraví', T.season({ on: true, fromDay: 44, fromMonth: 0 }).fromMonth, 12);
ok('znění se uloží ve třech jazycích',
  T.season({ on: true, text: { cz: '🎄 Do 20.12.', sk: '🎄 Do 20.12.', en: '' } }).text.cz === '🎄 Do 20.12.');
// Na web musí jít vedle plánu, ne v něm — plán má okna, tohle se opakuje
ok('garance jde na web vedle plánu', !!JSON.parse(T.payload([plan()])).xmas);

/* ---------- překryvy ---------- */

/*
 * Překryv není chyba — prohlížeč si vybere tu, která začala později. Je to
 * ale pravidlo, které nikdo nevidí, takže se na to musí umět upozornit dřív,
 * než se změna uloží.
 */
const seznam = [
  T.normalize({ id: 'x', name: 'Dřívější', from: '2026-07-01T00:00', to: '2026-07-10T23:59',
    topbar: { on: true, text: { cz: 'A' } } }),
  T.normalize({ id: 'y', name: 'Pozdější', from: '2026-07-20T00:00', to: '2026-07-25T00:00',
    topbar: { on: true, text: { cz: 'B' } } })
];
const nova = T.normalize({ id: 'z', name: 'Nová', from: '2026-07-05T09:30', to: '2026-07-22T12:00',
  topbar: { on: true, text: { cz: 'C' } } });

const kolize = T.clashes(nova, seznam);
check('najdou se obě kolize', kolize.map(k => k.id), ['x', 'y']);
// Zkrátit jde jen tu, která začala dřív — u pozdější by posun konce nepomohl
check('dřívější se dá zkrátit na minutu před novou', kolize[0].shortenTo, '2026-07-05T09:29');
check('pozdější zkrátit nejde', kolize[1].shortenTo, '');
check('mimo okno se nic nehlásí',
  T.clashes(T.normalize({ id: 'w', from: '2026-08-01T00:00', to: '2026-08-02T00:00',
    topbar: { on: true, text: { cz: 'D' } } }), seznam).length, 0);

/* ---------- skript pro web ---------- */

console.log('\nskript na e-shopu:\n');

const script = headScript({ url: 'https://xyz.supabase.co/storage/v1/object/public/web/t.json', ttl: 300 });
const body = script.replace(/^<script>/, '').replace(/<\/script>$/, '');

/*
 * Že se skript dá přeložit, je to nejdůležitější: chyba v něm se jinak
 * projeví až na e-shopu tím, že se nic nezobrazí, a nikdo neví proč.
 */
/*
 * Kód bez komentářů. Hledá se v něm, co se ve skriptu **nesmí** objevit —
 * a komentář, který přesně tyhle věci vyjmenovává jako zakázané, by
 * takové hledání pokaždé shodil.
 */
const code = body.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

let compiled = null;
try {
  // eslint-disable-next-line no-new-func
  compiled = new Function(
    'window', 'document', 'location', 'fetch', 'setInterval', 'setTimeout',
    'requestAnimationFrame', 'MutationObserver', body
  );
  ok('skript se dá přeložit', true);
} catch (e) {
  ok(`skript se dá přeložit — ${e.message}`, false);
}
ok('adresa plánu je v něm doplněná', script.includes('https://xyz.supabase.co/storage/v1/object/public/web/t.json'));
ok('a platnost uložené kopie taky', body.includes('300 * 1000'));

/* ---------- skript v náhradním prohlížeči ---------- */

/*
 * Prohlížeč se nahradí tím nejmenším, co skript potřebuje. Nejde o to
 * vykreslit stránku — jde o dvě hodnoty, které skript nastavuje do CSS,
 * a o to, že se k nim dostane i bez sítě.
 */
function fakeElement(name) {
  const props = {};
  const classes = new Set();
  const attrs = {};
  /* Co skript s prvkem provedl — u tlačítka objednávky na tom záleží nejvíc */
  const touched = [];
  const listeners = [];
  const handlers = {};
  const el = {
    tagName: name,
    className: '',
    innerHTML: '',
    children: [],
    firstChild: null,
    parentNode: null,
    style: {
      setProperty: (k, v) => { props[k] = v; },
      getPropertyValue: k => props[k] || ''
    },
    classList: {
      add: c => classes.add(c), remove: c => classes.delete(c),
      toggle() {}, contains: c => classes.has(c)
    },
    setAttribute: (k, v) => { touched.push('setAttribute:' + k); attrs[k] = v; },
    getAttribute: k => (k in attrs ? attrs[k] : null),
    removeAttribute: k => { touched.push('removeAttribute:' + k); delete attrs[k]; },
    appendChild: child => { el.children.push(child); child.parentNode = el; return child; },
    insertBefore: child => { el.children.unshift(child); child.parentNode = el; return child; },
    removeChild: child => { el.children = el.children.filter(x => x !== child); return child; },
    insertAdjacentHTML() {},
    addEventListener: (name, fn) => { listeners.push(name); if (fn) handlers[name] = fn; },
    click: () => { touched.push('click'); },
    // Hledá se jen podle třídy — víc toho skript po prvcích nechce
    querySelector: sel => {
      const want = String(sel).replace(/^\./, '');
      const walk = node => {
        for (const kid of node.children) {
          if (String(kid.className).split(' ').includes(want)) return kid;
          const deeper = walk(kid);
          if (deeper) return deeper;
        }
        return null;
      };
      return walk(el);
    },
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0, bottom: 0 }),
    textContent: '',
    classes, props, touched, listeners, handlers
  };
  return el;
}

/** Spustí skript s daným plánem v úschově a vrátí, co nastavil do CSS. */
function run(plans, opts = {}) {
  const box = fakeElement('div');
  const bar = fakeElement('div');
  const button = fakeElement('button');
  const wrap = fakeElement('div');
  wrap.appendChild(button);
  const known = {
    '.pd-shrt-desc': box, '.hdr-phn': bar,
    'button[name="formSendButton"]': button
  };

  const store = {};
  if (plans) {
    const data = { v: 1, plans };
    if (opts.xmas) data.xmas = opts.xmas;
    store['quentino-texty-1'] = JSON.stringify({ at: Date.now(), data });
  }

  /*
   * Prohlížeč kreslí text z proměnné v pseudoprvku. Náhrada dělá totéž:
   * ::before hlásí to, co je zrovna v proměnné — jinak by se skript neměl
   * podle čeho rozhodnout, kam vložit prvky s tučným textem.
   */
  const win = {
    localStorage: {
      getItem: k => (opts.brokenStorage ? (() => { throw new Error('zakázáno'); })() : (store[k] ?? null)),
      setItem: (k, v) => { store[k] = v; }
    },
    matchMedia: () => ({ matches: false }),
    addEventListener() {},
    getComputedStyle: (el, which) => ({
      content: which === '::before' ? (el.props ? el.props['--shipbox-content'] || el.props['--topbar-msg'] || '' : '') : 'none',
      display: 'block', color: 'rgb(0, 0, 0)', fontWeight: '600', whiteSpace: 'pre-line'
    }),
    innerWidth: 1200
  };
  const doc = {
    readyState: 'complete',
    hidden: false,
    head: fakeElement('head'),
    body: fakeElement('body'),
    getElementById: () => null,
    createElement: fakeElement,
    querySelector: sel => known[sel] ?? null,
    addEventListener() {}
  };
  const fetchStub = () => (opts.offline
    ? Promise.reject(new Error('bez sítě'))
    : Promise.resolve({ ok: true, json: async () => ({ v: 1, plans: plans ?? [] }) }));

  const ticks = [];
  compiled(win, doc, { hostname: opts.host || 'www.quentino.cz' }, fetchStub,
    fn => { ticks.push(fn); return 0; }, () => 0, cb => cb(),
    function () { return { observe() {}, disconnect() {} }; });
  // Přepočet po minutě: dělá se jím totéž znovu nad už vykreslenou stránkou
  for (let i = 0; i < (opts.ticks || 0); i++) ticks.forEach(fn => fn());

  /*
   * Zpátky z hodnoty CSS: uvozovky pryč, oddělovač řádků je „\A “ i s tou
   * mezerou, která ho ukončuje, a zdvojené uvozovky se vrátí na jednoduché.
   */
  const unquote = s => s.replace(/^"|"$/g, '').replace(/\\"/g, '"');
  const rich = node => (node.children[0] ? node.children[0].innerHTML : '');
  return {
    button,
    raw: box.style.getPropertyValue('--shipbox-content'),
    box: unquote(box.style.getPropertyValue('--shipbox-content')).split('\\A '),
    bar: unquote(bar.style.getPropertyValue('--topbar-msg')),
    boxRich: rich(box),
    barRich: rich(bar),
    boxHidden: box.classes.has('q-no-before')
  };
}

if (compiled) {
  /* Bez plánu se musí chovat přesně jako doteď */
  const bez = run(null);
  ok('bez plánu se vykreslí nadpis boxu', bez.box.some(l => l.includes('PŘEDPOKLÁDANÝ STAV DORUČENÍ')));
  ok('bez plánu má box řádek o expedici', bez.box.some(l => l.includes('Expedice')));
  ok('bez plánu má box řádek o doručení', bez.box.some(l => l.includes('Předpokládané doručení')));
  ok('a horní lišta není prázdná', bez.bar.length > 5);

  /* Nedostupné úložiště nesmí nic pokazit */
  const spadle = run(null, { offline: true });
  ok('výpadek úložiště nechá dynamický text', spadle.box.some(l => l.includes('Expedice')));
  const bezUschovy = run(null, { brokenStorage: true });
  ok('zakázaná úschova v prohlížeči taky', bezUschovy.box.some(l => l.includes('Expedice')));

  /* Běžící změna přepíše jen to, co má vyplněné */
  const ted = Date.now();
  const bezici = [{
    id: 'a', fromMs: ted - 60000, toMs: ted + 3600000,
    product: { on: true, ship: { cz: 'až 8. 7., máme dovolenou' } },
    topbar: { on: true, text: { cz: '🏖️ Dovolená do 7. 7.' } },
    button: { on: true, text: { cz: 'Odesíláme po dovolené' } }
  }];
  const s = run(bezici);
  ok('náhradní hodnota expedice se ukáže', s.box.some(l => l.includes('máme dovolenou')));
  /*
   * Popisek musí zůstat. Bez něj by v boxu viselo holé datum a nikdo by
   * nevěděl, čeho se týká — přesně tak to dopadlo při prvním nasazení.
   */
  ok('a popisek řádku zůstane', s.box.some(l => l.startsWith('✅ Expedice: ')));
  ok('emoji v hodnotě projde', run([{
    id: 'a2', fromMs: ted - 60000, toMs: ted + 3600000,
    product: { on: true, ship: { cz: '🏖️ až 8. 7.' } }
  }]).box.some(l => l.includes('🏖️')));
  // Nadpis boxu se nesmí ztratit jen tím, že se oblast zaškrtne
  ok('nadpis boxu zůstane', s.box.some(l => l.includes('PŘEDPOKLÁDANÝ STAV DORUČENÍ')));
  // Nevyplněný řádek se nesmí ztratit — má se dál počítat podle kalendáře
  ok('nevyplněné doručení se počítá dál', s.box.some(l => l.includes('Předpokládané doručení')));
  check('horní lišta je nahrazená', s.bar, '🏖️ Dovolená do 7. 7.');

  /*
   * Číslo hned za koncem řádku. Únik „\A“ je šestnáctkové číslo znaku,
   * takže „\A21.9.“ prohlížeč přečte jako znak 0A21 — na e-shopu se místo
   * data objevilo „ਡ.9.“ a předchozí řádek se ztratil. Mezera za únikem
   * ho ukončí; kdyby zmizela, projeví se to zase až na webu.
   */
  const datum = run([{
    id: 'd1', fromMs: ted - 60000, toMs: ted + 3600000,
    product: { on: true, ship: { cz: '21.9.' } }
  }]);
  ok('oddělovač řádků končí mezerou', datum.raw.includes('\\A '));
  ok('datum za koncem řádku zůstane datem', datum.box.some(l => l === '✅ Expedice: 21.9.'));
  ok('a nadpis se před ním neztratí', datum.box.some(l => l.includes('PŘEDPOKLÁDANÝ STAV DORUČENÍ')));

  /* Řádky jde i schovat */
  const schovane = run([{
    id: 'd2', fromMs: ted - 60000, toMs: ted + 3600000,
    product: { on: true, hideShip: true, hideDelivery: true, hidePickup: true, hideHeader: true,
      above: { cz: 'Máme zavřeno' } }
  }]);
  check('schová se, co se schovat má', schovane.box, ['Máme zavřeno']);

  /* Uvozovka v textu nesmí hodnotu CSS ukončit */
  const uvozovka = run([{
    id: 'd3', fromMs: ted - 60000, toMs: ted + 3600000,
    topbar: { on: true, text: { cz: 'Akce "podzim" končí' } }
  }]);
  check('uvozovka v textu projde', uvozovka.bar, 'Akce "podzim" končí');

  /*
   * Tučné slovo. Hodnota CSS „content“ formátování uvnitř neumí, takže se
   * na to místo vloží skutečné prvky a pseudoprvek se schová. V samotné
   * hodnotě nesmí zůstat hvězdičky — kdyby se rendrování nepovedlo,
   * ukázaly by se na webu.
   */
  const tucne = run([{
    id: 'd4', fromMs: ted - 60000, toMs: ted + 3600000,
    topbar: { on: true, text: { cz: 'Doprava **zdarma** do konce týdne' } }
  }]);
  ok('hvězdičky se do CSS nedostanou', !tucne.bar.includes('**'));
  check('a text zůstane celý', tucne.bar, 'Doprava zdarma do konce týdne');
  ok('tučné slovo se vykreslí prvkem', tucne.barRich.includes('<b>zdarma</b>'));
  // Bez tučného slova se nic navíc nekreslí — na vzhled boxu se nesahá
  ok('bez hvězdiček se nic nevkládá', !run(bezici).boxRich);

  /*
   * Přepočet po minutě nesmí tučný text zahodit. Prvek, který text kreslí,
   * se hledá podle vykresleného obsahu — a ten je po schování pseudoprvku
   * pryč. Kdyby se hledalo pokaždé znovu, text by každou minutu na okamžik
   * zmizel a zase se objevil.
   */
  const znovu = run([{
    id: 'd5', fromMs: ted - 60000, toMs: ted + 3600000,
    topbar: { on: true, text: { cz: 'Doprava **zdarma** do konce týdne' } }
  }], { ticks: 3 });
  ok('tučný text přežije přepočet', znovu.barRich.includes('<b>zdarma</b>'));

  /* Jeden náhradní text místo tří řádků */
  const jeden = run([{
    id: 'b', fromMs: ted - 60000, toMs: ted + 3600000,
    product: { on: true, one: { cz: '⛔ Do 5. 1. neexpedujeme' }, hideHeader: true }
  }]);
  check('místo tří řádků jeden', jeden.box, ['⛔ Do 5. 1. neexpedujeme']);

  /* Řádek nad a pod */
  const okolo = run([{
    id: 'c', fromMs: ted - 60000, toMs: ted + 3600000,
    product: { on: true, above: { cz: 'NAHOŘE' }, below: { cz: 'DOLE' } }
  }]);
  // Řádek navíc patří pod nadpis, ne nad něj — nadpis je hlavička boxu
  check('řádek navíc je pod nadpisem', okolo.box[1], 'NAHOŘE');
  ok('a nadpis zůstal první', okolo.box[0].includes('PŘEDPOKLÁDANÝ STAV DORUČENÍ'));
  check('druhý řádek je dole', okolo.box[okolo.box.length - 1], 'DOLE');

  /* Okno, které ještě nezačalo nebo už skončilo, se ignoruje */
  const mimo = run([{
    id: 'd', fromMs: ted + 3600000, toMs: ted + 7200000,
    topbar: { on: true, text: { cz: 'ZATÍM NE' } }
  }]);
  ok('naplánovaná změna se neukáže dřív', mimo.bar !== 'ZATÍM NE');
  const stara = run([{
    id: 'e', fromMs: ted - 7200000, toMs: ted - 3600000,
    topbar: { on: true, text: { cz: 'UŽ NE' } }
  }]);
  ok('skončená změna se sama přestane ukazovat', stara.bar !== 'UŽ NE');

  /*
   * Dvě běžící okna naráz aplikace nepustí, ale kdyby se to stalo, musí být
   * jasné, které vyhraje: to, které začalo později — je to novější rozhodnutí.
   */
  const dve = run([
    { id: 'f', fromMs: ted - 7200000, toMs: ted + 3600000, topbar: { on: true, text: { cz: 'STARŠÍ' } } },
    { id: 'g', fromMs: ted - 60000, toMs: ted + 3600000, topbar: { on: true, text: { cz: 'NOVĚJŠÍ' } } }
  ]);
  check('při překryvu vyhraje pozdější začátek', dve.bar, 'NOVĚJŠÍ');

  /*
   * Garance na webu. Zkouší se přes dnešek — období se zadává dnem
   * a měsícem, takže se dá nastavit tak, aby zrovna platilo.
   */
  const dnes = new Date();
  const dnesni = { day: dnes.getDate(), month: dnes.getMonth() + 1 };
  const sGaranci = (extra) => run([], Object.assign({ xmas: Object.assign({
    on: true, fromDay: dnesni.day, fromMonth: dnesni.month,
    toDay: dnesni.day, toMonth: dnesni.month,
    text: { cz: '🎄 Vlastní znění garance', sk: '', en: '' }
  }, extra || {}) }));

  const garance = sGaranci();
  ok('nastavené znění garance je nad boxem', garance.box[0] === '🎄 Vlastní znění garance');
  check('a je i v horní liště', garance.bar, '🎄 Vlastní znění garance');
  // Vypnutá garance nesmí nechat prázdný řádek
  ok('vypnutá garance se neukáže', !sGaranci({ on: false }).box.some(l => l.includes('garance')));
  // Mimo období taky ne — jinak by visela na webu celý rok
  ok('mimo období se neukáže',
    !sGaranci({ fromDay: 1, fromMonth: dnesni.month === 12 ? 11 : 12,
      toDay: 2, toMonth: dnesni.month === 12 ? 11 : 12 }).box.some(l => l.includes('garance')));
  // Prázdné znění znamená vestavěný text, ne prázdný řádek
  ok('prázdné znění vezme vestavěné',
    sGaranci({ text: { cz: '', sk: '', en: '' } }).box[0].includes('Garance doručení do Vánoc'));
  /*
   * Období přes Silvestr: konec je „menší“ než začátek, takže prosté
   * porovnání by nefungovalo a garance by v prosinci zmizela.
   */
  ok('období přes konec roku funguje',
    sGaranci({ fromDay: dnesni.day, fromMonth: dnesni.month, toDay: 1, toMonth: dnesni.month === 1 ? 12 : 1 })
      .box[0] === '🎄 Vlastní znění garance');

  /* ---------- odhad doručení a datum expedice ---------- */

  /*
   * Přepsaná expedice a dopočítané doručení se nesmí prát. Bez data se
   * doručení počítalo z dneška, takže box hlásil odeslání za deset dní
   * a doručení zítra — dvě věty pod sebou, obě nepravdivé dohromady.
   */
  const slovy = run([{
    id: 'e1', fromMs: ted - 60000, toMs: ted + 3600000,
    product: { on: true, ship: { cz: 'až 21.9., máme dovolenou' } }
  }]);
  ok('bez data se doručení neslibuje na den',
    slovy.box.some(l => l === '✅ Předpokládané doručení: co nejdříve'));
  ok('a lišta nad tím taky ne', slovy.bar.includes('co nejdříve'));

  /* Se zadaným datem je doručení odvoditelné napevno */
  const zaTyden = new Date(Date.now() + 7 * 86400000);
  const iso = zaTyden.toISOString().slice(0, 10);
  const den = String(zaTyden.getDate()).padStart(2, '0') + '.'
    + String(zaTyden.getMonth() + 1).padStart(2, '0') + '.';
  const datem = run([{
    id: 'e2', fromMs: ted - 60000, toMs: ted + 3600000,
    product: { on: true, shipFrom: iso }
  }]);
  ok('datum expedice se doplní do řádku', datem.box.some(l => l === '✅ Expedice: ' + den));
  /*
   * Doručení musí vyjít po datu expedice, ne kolem dneška. Kontroluje se
   * proti zítřku: přesně ten se tam objevoval, když se odhad počítal
   * z dneška, a vypadal na první pohled věrohodně.
   */
  const zitra = new Date(Date.now() + 86400000);
  const zitraDen = String(zitra.getDate()).padStart(2, '0') + '.'
    + String(zitra.getMonth() + 1).padStart(2, '0') + '.';
  const dorucen = datem.box.find(l => l.startsWith('✅ Předpokládané doručení: ')) || '';
  ok('doručení je konkrétní den', /\d\d\.\d\d\./.test(dorucen), dorucen);
  ok('a není to zítřek počítaný z dneška', !dorucen.includes(zitraDen), dorucen);
  ok('a lišta hlásí tentýž den odeslání', datem.bar.includes('Odesíláme ' + den));
  // Vlastní text expedice popis přebije, ale datum dál řídí odhad doručení
  const oboji = run([{
    id: 'e3', fromMs: ted - 60000, toMs: ted + 3600000,
    product: { on: true, shipFrom: iso, ship: { cz: 'až po dovolené, ' + den } }
  }]);
  ok('vlastní text vyhraje nad datem', oboji.box.some(l => l.includes('až po dovolené')));
  ok('odhad doručení se přesto počítá z data',
    oboji.box.some(l => /Předpokládané doručení: \d\d\.\d\d\./.test(l)));

  /* ---------- tlačítko objednávky ---------- */

  /*
   * Tlačítko „Objednávka zavazující k platbě“ je to jediné místo, kde se
   * nesmí nic pokazit. Bublina se ho proto nesmí dotknout: žádný zápis do
   * atributů, žádné vlastní kliknutí, jen čtyři posluchače, které nic neruší.
   */
  const sBublinou = run([{
    id: 'b1', fromMs: ted - 60000, toMs: ted + 3600000,
    button: { on: true, text: { cz: 'Odesíláme do 24 hodin' } }
  }]);
  check('na tlačítko se nic nezapisuje', sBublinou.button.touched, []);
  check('a poslouchá se jen to, co nic neruší',
    sBublinou.button.listeners.sort(), ['blur', 'focus', 'mouseenter', 'mouseleave']);
  ok('nikde se neruší výchozí chování',
    !/preventDefault|stopPropagation|stopImmediatePropagation/.test(code));
  ok('ani se za člověka neklikne', !/\.click\(\)/.test(code));
  ok('tlačítko se nikdy nezakáže', !/\.disabled\s*=/.test(code));
  // Bublina ani řádek pod tlačítkem nesmí odchytit klepnutí místo tlačítka
  ok('bublina neodchytává kliknutí', body.includes('pointer-events: none'));
  ok('řádek pod tlačítkem taky ne',
    /\.q-btnnote \{[\s\S]*?pointer-events: none/.test(body));

  /*
   * Výjimka uvnitř posluchače nesmí vylézt ven. Kdyby vylezla při najetí
   * myší, byla by to chyba v konzoli přesně nad tlačítkem, které má odeslat
   * objednávku — a nikdo by nevěděl, odkud se vzala.
   */
  let vybuch = null;
  try {
    sBublinou.button.handlers.mouseenter();
  } catch (e) {
    vybuch = e.message;
  }
  ok('najetí myší nikdy nevyhodí výjimku' + (vybuch ? ` (${vybuch})` : ''), !vybuch);

  // Bez nastaveného textu se nemá dít vůbec nic
  const bezBubliny = run([{
    id: 'b2', fromMs: ted - 60000, toMs: ted + 3600000,
    topbar: { on: true, text: { cz: 'jen lišta' } }
  }]);
  check('bez textu se na tlačítko nesahá', bezBubliny.button.listeners, []);

  /* Jazyky: chybí-li slovenština, ukáže se čeština */
  const sk = run([{
    id: 'h', fromMs: ted - 60000, toMs: ted + 3600000,
    topbar: { on: true, text: { cz: 'ČESKY', sk: 'SLOVENSKY' } }
  }], { host: 'www.quentino.sk' });
  check('slovenský web bere slovenský text', sk.bar, 'SLOVENSKY');
  const en = run([{
    id: 'i', fromMs: ted - 60000, toMs: ted + 3600000,
    topbar: { on: true, text: { cz: 'ČESKY' } }
  }], { host: 'www.wearquentino.com' });
  check('chybějící překlad padne na češtinu', en.bar, 'ČESKY');
}

/* ---------- názvy polí sedí na obou stranách ---------- */

/*
 * Tohle je ta tichá chyba, kvůli které zkouška vznikla: aplikace vystaví
 * pole a skript čte jiné. Obojí se přeloží, na webu se nezmění nic a hledá
 * se to hodinu.
 */
for (const field of ['fromMs', 'toMs', 'product', 'topbar', 'links', 'button',
  'hideHeader', 'hideShip', 'hideDelivery', 'hidePickup', 'above', 'below', 'one',
  'xmas', 'fromMonth', 'toMonth']) {
  ok(`skript čte pole ${field}`, body.includes(field));
}

console.log(failed === 0 ? '\nvše sedí\n' : `\n${failed} nesedí\n`);
process.exit(failed === 0 ? 0 : 1);
