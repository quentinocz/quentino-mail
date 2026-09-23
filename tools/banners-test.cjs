/**
 * Zkouška bannerů na úvodní stránce.
 *
 * Zkouší se dvě strany téže věci a hlavně to, že si rozumí:
 *
 *  1. **aplikace** — co se pošle na web, co se z toho vyhodí, jak se hlídá
 *     čitelnost a co se nepustí do stylu stránky e-shopu,
 *  2. **skript na webu** — že se dá přeložit, že v něm je zapečená záložní
 *     sada a že čte přesně ta pole, která aplikace vystavuje.
 *
 * Druhá část je tu proto, že tudy vede cesta k tiché chybě: aplikace by
 * vystavila jinak pojmenované pole, než jaké skript čte, obojí by prošlo
 * překladem a na úvodní stránce by zůstalo prázdné místo.
 */
const fs = require('fs');
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
const aiPath = require.resolve(path.join(DIST, 'ai.js'));
require.cache[aiPath] = { id: aiPath, filename: aiPath, loaded: true, exports: {
  ask: async () => '[]'
} };
const setPath = require.resolve(path.join(DIST, 'settings.js'));
require.cache[setPath] = { id: setPath, filename: setPath, loaded: true, exports: {
  getSettings: () => ({ draftModel: 'zkousky-model', fastModel: 'zkousky-model' })
} };

const banners = require(path.join(DIST, 'banners.js'));
const { bannerScript } = require(path.join(DIST, 'bannerscript.js'));
const T = banners.__test;

void db;

console.log('\nbannery:\n');

const banner = (extra = {}) => ({
  id: 'b1',
  name: 'Kšandy',
  copy: {
    kicker: { cz: 'Novinka', sk: '', en: '' },
    title: { cz: 'Kšandy k obleku', sk: '', en: '' },
    text: { cz: 'Ručně šité', sk: '', en: '' },
    button: { cz: 'Prohlédnout', sk: '', en: '' },
    href: { cz: '/ksandy', sk: '', en: '' }
  },
  look: { image: '', bg: '#123456', fg: '#ffffff', overlay: 40, align: 'left', pos: 'bottom', focus: '50% 50%' },
  ...extra
});

/* ---------- designový jazyk e-shopu ---------- */

console.log('design podle e-shopu:\n');

/*
 * Výchozí hodnoty nejsou vkus, ale opis z quentino.cz (změřeno 22. 9. 2026):
 * web je psaný Rajdhani, nadpisy má ve váze **400** (ne tučné), primární
 * barva je černá a rohy i tlačítka jsou **hranaté**. Tučný nadpis
 * v zakulacené dlaždici by vedle zbytku stránky byl cizí prvek — a je to
 * přesně ten druh nesouladu, kterého si nikdo nevšimne v kódu, jen na webu.
 */
const vychozi = T.normalizeBanner({}).look;
check('nadpis má výchozí váhu jako nadpisy e-shopu', vychozi.titleWeight, 400);
check('rohy jsou hranaté jako na e-shopu', vychozi.radius, 0);
check('primární barva e-shopu je černá', vychozi.bg, '#000000');
check('písmo se dědí ze stránky, žádné se nestahuje', vychozi.font, 'shop');
check('tlačítko je to ze šablony e-shopu', vychozi.button, 'shop');
check('text stojí na střed jako banner e-shopu', [vychozi.align, vychozi.pos], ['center', 'middle']);
check('tloušťka se zaokrouhlí po stovkách',
  T.normalizeBanner({ titleWeight: 651 }).look.titleWeight, 700);
check('nesmyslná tloušťka spadne na výchozí',
  T.normalizeBanner({ titleWeight: 1400 }).look.titleWeight, 400);
check('neznámé písmo spadne na písmo e-shopu',
  T.normalizeBanner({ font: 'comic-sans' }).look.font, 'shop');
check('velikost nadpisu se drží v mezích',
  [T.normalizeBanner({ titleSize: 500 }).look.titleSize,
    T.normalizeBanner({ titleSize: 5 }).look.titleSize], [150, 70]);


const sada = (extra = {}) => T.normalizeSet({
  id: 's1', name: 'Podzim', layout: 'quad', phone: 'grid', rotate: 6,
  banners: [banner()],
  ...extra
});

/* ---------- platnost ---------- */

console.log('platnost sady:\n');

const porad = sada();
check('bez data platí sada pořád', [porad.fromMs, porad.toMs > Date.now() + 1e12], [0, true]);

const okno = sada({ from: '2026-12-01T08:00', to: '2026-12-24T12:00' });
check('konec je včetně své minuty', new Date(okno.toMs).toISOString(), '2026-12-24T11:00:59.999Z');
check('sada s koncem před začátkem neprojde',
  T.validateSet(sada({ from: '2026-12-10T08:00', to: '2026-12-01T08:00' })),
  'Konec platnosti musí být po jejím začátku.');
check('sada bez jména neprojde', T.validateSet(sada({ name: '' })),
  'Sada nemá jméno — bez něj se v seznamu nepozná.');
check('sada bez bannerů neprojde', T.validateSet(sada({ banners: [] })),
  'Sada nemá ani jeden banner s textem nebo fotkou.');
check('hotová sada projde', T.validateSet(okno), '');

/*
 * Odpočet bez data by na webu tikal do roku 1970 a banner by hlásil, že
 * akce skončila před půl stoletím. Pozná se to tady, ne na e-shopu.
 */
check('odpočet bez data neprojde',
  T.validateSet(sada({ banners: [banner({ smart: { kind: 'countdown', until: '' } })] })),
  'Banner „Kšandy" má odpočet bez data, do kdy běží.');

/* ---------- čitelnost ---------- */

console.log('\nčitelnost:\n');

/*
 * Tohle je to nejdůležitější pravidlo celého modulu: bílý nadpis na světlé
 * fotce látky je na telefonu ve slunci nečitelný a nikdo to nenahlásí —
 * jen se z banneru nekline. Ztmavení se proto dorovná i proti nastavení.
 */
const svetly = T.normalizeBanner(banner({
  look: { image: 'https://cdn.quentino.cz/a.webp', bg: '#fff', fg: '#fff', overlay: 0 }
}));
check('fotka s textem dostane ztmavení, i když se posuvník stáhne na nulu',
  svetly.look.overlay, 18);
const holy = T.normalizeBanner({
  ...banner(), copy: { title: {}, text: {}, button: {}, href: {} },
  look: { image: 'https://cdn.quentino.cz/a.webp', overlay: 0 }
});
check('samotná fotka bez textu ztmavení nepotřebuje', holy.look.overlay, 0);

/* ---------- co se nepustí do stránky e-shopu ---------- */

console.log('\nbezpečnost:\n');

/*
 * Adresa fotky jde do stylu jako url(...) a odkaz do atributu href. Plán je
 * veřejný soubor — tohle je to místo, kudy by se dal na e-shop dostat cizí
 * kód, takže se pravidlo hlídá tady i podruhé ve skriptu.
 */
check('javascript: se jako odkaz nebere', T.safeHref('javascript:alert(1)'), '');
check('relativní cesta ano', T.safeHref('/kravatove-sety'), '/kravatove-sety');
check('celá adresa taky', T.safeHref('https://quentino.sk/kravaty'), 'https://quentino.sk/kravaty');
check('uvozovka v adrese fotky ji zahodí',
  T.safeImage('https://cdn.quentino.cz/a.webp") ; background: url(zlo'), '');
check('závorka taky', T.safeImage('https://cdn.quentino.cz/a(1).webp'), '');
check('obyčejná adresa fotky projde',
  T.safeImage('https://cdn.quentino.cz/bannery/a-1234.webp'),
  'https://cdn.quentino.cz/bannery/a-1234.webp');
check('kód se zbaví všeho, co se nedá přepsat do košíku',
  T.normalizeBanner(banner({ smart: { kind: 'code', code: ' sleva 10%! ' } })).smart.code, 'SLEVA10');

/* ---------- co jde na web ---------- */

console.log('\nco jde na web:\n');

const vystaveno = JSON.parse(T.payload([
  sada({ id: 'a', name: 'Běžná' }),
  sada({ id: 'b', name: 'Vypnutá', off: true }),
  sada({ id: 'c', name: 'Prázdná', banners: [] })
]));
check('vypnutá ani prázdná sada se nevystavuje', vystaveno.sets.map(one => one.id), ['a']);

const rada = T.setRow(sada({
  banners: [
    banner({ name: 'pracovní poznámka' }),
    banner({ id: 'b2', off: true }),
    banner({ id: 'b3', copy: { title: {}, text: {}, button: {}, href: {} }, look: { image: '' } })
  ]
}));
check('vypnutý i prázdný banner ze sady vypadnou', rada.banners.map(one => one.id), ['b1']);
/* Jméno banneru je pracovní poznámka, ne obsah — na veřejný web nepatří */
ok('jméno banneru se na web neposílá', !JSON.stringify(rada).includes('pracovní poznámka'));

const chytry = T.setRow(sada({
  banners: [banner({
    smart: { kind: 'countdown', until: '2026-12-24T12:00', code: '', emoji: '⏳', effect: 'snow' }
  })]
})).banners[0];
ok('odpočet jde na web v milisekundách', Number.isFinite(chytry.smart.untilMs) && chytry.smart.untilMs > 0);
check('a emoji i efekt s ním', [chytry.smart.emoji, chytry.smart.effect], ['⏳', 'snow']);
ok('obyčejný banner chytrou část vůbec nemá', T.setRow(sada()).banners[0].smart === undefined);

/* ---------- překryvy ---------- */

console.log('\npřekryvy:\n');

const seznam = [
  sada({ id: 'x', name: 'Dřívější', from: '2026-12-01T00:00', to: '2026-12-10T00:00' }),
  sada({ id: 'y', name: 'Pozdější', from: '2026-12-20T00:00', to: '2026-12-25T00:00' })
];
const nova = sada({ id: 'z', name: 'Nová', from: '2026-12-05T09:30', to: '2026-12-22T12:00' });
const kolize = T.setClashes(nova, seznam);
check('najdou se obě kolize', kolize.map(one => one.id), ['x', 'y']);
check('dřívější se dá zkrátit na minutu před novou', kolize[0].shortenTo, '2026-12-05T09:29');
check('pozdější zkrátit nejde', kolize[1].shortenTo, '');
check('sada, co platí pořád, se pere s každou',
  T.setClashes(sada({ id: 'w', name: 'Stálá' }), seznam).map(one => one.id), ['x', 'y']);

/* ---------- skript pro e-shop ---------- */

console.log('\nskript na e-shopu:\n');

const zaloha = T.setRow(sada({ id: 'zaloha', name: 'Záložní' }));
const script = bannerScript({
  url: 'https://xyz.supabase.co/storage/v1/object/public/web/b.json',
  ttl: 300,
  fallback: zaloha
});
const body = script.slice(script.indexOf('<script>') + 8, script.lastIndexOf('</script>'));

let compiled = null;
try {
  // eslint-disable-next-line no-new-func
  compiled = new Function(
    'window', 'document', 'location', 'fetch', 'setInterval', 'setTimeout',
    'localStorage', 'navigator', 'MutationObserver', body
  );
  ok('skript se dá přeložit', true);
} catch (e) {
  ok(`skript se dá přeložit — ${e.message}`, false);
}
void compiled;

ok('adresa plánu je v něm doplněná',
  script.includes('https://xyz.supabase.co/storage/v1/object/public/web/b.json'));
ok('a platnost uložené kopie taky', body.includes('300 * 1000'));
/*
 * Záložní sada musí ve skriptu opravdu být, a to jako JSON, ne jako text
 * v uvozovkách. Bez ní by při nedostupném úložišti zůstalo na úvodní
 * stránce prázdné místo — původní karusel je v tu chvíli už schovaný.
 */
ok('záložní sada je ve skriptu zapečená', body.includes('"id":"zaloha"'));
ok('a nadpis banneru v ní taky', body.includes('Kšandy k obleku'));
ok('žádná značka nezůstala nenahrazená', !script.includes('__QUENTINO_BANNERS'));

const bezZalohy = bannerScript({ url: '', ttl: 300, fallback: null });
ok('bez vybrané sady je záloha prázdná', bezZalohy.includes('var FALLBACK = "";'));

/*
 * Aplikace vystavuje jedno pojmenování, skript čte druhé — a kdyby se
 * rozešly, přeložilo by se obojí a na webu by se prostě nic neukázalo.
 * Proto se hlídá, že skript sahá na každé pole, které do plánu píšeme.
 */
const kod = body.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
for (const field of ['fromMs', 'toMs', 'layout', 'phone', 'rotate', 'banners',
  'kicker', 'title', 'text', 'button', 'href', 'look', 'smart', 'overlay', 'focus',
  'untilMs', 'code', 'emoji', 'effect',
  // Typografie a tlačítko — ta část, o kterou šlo, aby banner ladil s webem
  'font', 'titleWeight', 'titleSize', 'textWeight', 'caps', 'radius']) {
  ok(`skript čte pole ${field}`, kod.includes(field));
}
for (const font of ['inter', 'jost', 'playfair', 'bebas']) {
  ok(`skript umí písmo ${font}`, kod.includes(font + ':'));
}
for (const style of ['fill', 'outline', 'soft', 'link']) {
  ok(`skript umí tlačítko ${style}`, script.includes('data-style="' + style + '"'));
}
/*
 * Tlačítko „jako na e-shopu" musí nést přesně ty třídy, kterými je psané
 * tlačítko v původním banneru. Holá třída `btn` je na quentino.cz
 * průhledná s černým písmem — na tmavé fotce by z ní nezbylo nic.
 */
ok('tlačítko e-shopu nese jeho vlastní třídy', kod.includes('btn fg bg-pr pt-3 pr-5 pb-3 pl-5 fs-4'));
ok('a je pojištěné pro případ, že šablona třídu ztratí', kod.includes('getComputedStyle'));
/* Písmo e-shopu se dědí — kdyby se nastavovalo, stahoval by se font navíc */
ok('výchozí písmo se nenastavuje, ale dědí', script.includes('font-family: var(--qbn-font, inherit)'));
ok('vlastní písmo se stahuje s display=swap', kod.includes('display=swap'));
/* Tučná slova dvěma hvězdičkami — stejně jako v naplánovaných textech */
ok('tučné slovo se skládá z uzlů, ne z HTML', kod.includes('createTextNode'));
/* Jedno zaoblení pro dlaždici i tlačítko, ať si neodporují */
ok('tlačítko má stejné zaoblení jako dlaždice',
  script.includes('border-radius: var(--qbn-radius, 0)'));
for (const kind of ['countdown', 'code', 'delivery']) {
  ok(`skript umí chytrý banner ${kind}`, kod.includes('"' + kind + '"'));
}
for (const effect of ['snow', 'shine', 'pulse', 'float']) {
  ok(`skript umí efekt ${effect}`, kod.includes('"' + effect + '"'));
}

/*
 * Text z plánu se do stránky vkládá jedině přes textContent. innerHTML by
 * z veřejného souboru udělal cestu, jak na e-shopu spustit cizí kód.
 */
ok('text se do stránky vkládá jen jako text, ne jako HTML', !kod.includes('innerHTML'));
/* Poměr stran je to, co drží stránku v klidu, než dotečou fotky */
ok('dlaždice má pevný poměr stran', script.includes('aspect-ratio'));
/* Rotace prolíná, neposouvá — posun mění výšku a stránka pod ním poskakuje */
ok('stránky bannerů leží přes sebe v téže buňce', script.includes('grid-area: 1 / 1'));
ok('a přepínají se průhledností', script.includes('.qbn-page.qbn-now'));
/* Komu systém hlásí, že nechce pohyb, se nesmí nic hýbat */
ok('pohyb se dá vypnout systémem', script.includes('prefers-reduced-motion'));
/* Původní karusel se schová až ve chvíli, kdy je čím ho nahradit */
ok('původní karusel se schovává až třídou', script.includes('.qbn-on #banner1'));
ok('a třídu přidá až kreslení', kod.includes('classList.add("qbn-on")'));

/* ---------- společný vzhled sady ---------- */

console.log('\nspolečný vzhled sady:\n');

/*
 * Zaoblení, písmo nebo podoba tlačítka jsou vlastnosti celé řady dlaždic.
 * Čtyři vedle sebe, každá s jiným zaoblením, vypadají jako čtyři cizí
 * bannery slepené k sobě — a nastavovat je čtyřikrát je navíc práce, při
 * které se na jednu zapomene. Skládá se to v aplikaci, takže skript na
 * webu o sdílení vůbec neví a dostane hotové hodnoty.
 */
const spolecna = { radius: 18, font: 'jost', titleWeight: 700, align: 'right', fg: '#ffcc00' };
const sSdilenym = sada({ look: spolecna, banners: [
  banner({ id: 'bez', look: { image: '', bg: '#101010', focus: '0% 0%' } }),
  banner({ id: 'vlastni', ownLook: true,
    look: { image: '', bg: '#202020', radius: 0, font: 'shop', align: 'left' } })
] });
const bez = T.resolveLook(sSdilenym.banners[0], sSdilenym);
const vlastni = T.resolveLook(sSdilenym.banners[1], sSdilenym);
check('banner bez výjimky si vezme zaoblení ze sady', bez.radius, 18);
check('i písmo a zarovnání', [bez.font, bez.align, bez.fg], ['jost', 'right', '#ffcc00']);
check('barva pozadí a výřez zůstanou vždycky jeho', [bez.bg, bez.focus], ['#101010', '0% 0%']);
check('banner s výjimkou se sadou neřídí',
  [vlastni.radius, vlastni.font, vlastni.align], [0, 'shop', 'left']);
/*
 * Ztmavení může přijít ze sady, kde o téhle fotce nikdo neví — čitelnost
 * se proto dorovnává až po sloučení, ne před ním.
 */
const sFotkou = sada({
  look: { ...spolecna, overlay: 0 },
  banners: [banner({ look: { image: 'https://cdn.quentino.cz/a.webp' } })]
});
check('čitelnost se hlídá až nad sloučeným vzhledem',
  T.resolveLook(sFotkou.banners[0], sFotkou).overlay, 18);
ok('na web jde hotový vzhled, ne odkaz na sadu',
  T.setRow(sSdilenym).banners[0].look.radius === 18);

/* ---------- tvar dlaždice ---------- */

console.log('\ntvar dlaždice:\n');

check('bez volby se tvar nechává na rozvržení', sada().ratio, 'auto');
check('nesmyslný tvar spadne na „podle rozvržení"', sada({ ratio: '7:13' }).ratio, 'auto');
check('vybraný tvar jde na web', T.setRow(sada({ ratio: '3:4', phoneRatio: '2:3' })).ratio, '3:4');
ok('a telefon má svůj vlastní', T.setRow(sada({ phoneRatio: '2:3' })).phoneRatio === '2:3');
/*
 * Nevybraný tvar nesmí ve skriptu nic nastavit — teprve pak se uplatní
 * náhradní hodnota, která je jiná pro každé rozvržení i šířku obrazovky.
 * A telefon bez vlastní volby dědí ten z počítače: kdo chce dlaždice na
 * výšku, chce je na výšku i na telefonu.
 */
ok('tvar se do stránky vkládá proměnnou', script.includes('aspect-ratio: var(--qbn-ar'));
ok('a telefon dědí tvar z počítače',
  script.includes('var(--qbn-ar-phone, var(--qbn-ar, 1 / 1))'));

/* ---------- kopie sady ---------- */

console.log('\nkopie sady:\n');

/*
 * Nová kampaň bývá „jako ta minulá, ale jiné texty". Kopie musí dostat
 * **nové identifikátory** — se stejnými by si dvě sady nárokovaly tytéž
 * dlaždice a slučování se stavem z webu by jednu z nich přepsalo.
 */
const puvodni = sada({
  id: 'orig', banners: [banner({ id: 'b1' }), banner({ id: 'b2' })],
  links: { on: true, shape: 'circle',
    items: [{ id: 'l1', text: { cz: 'Kravaty' }, href: { cz: '/kravaty' } }] }
});
const kopie = T.normalizeSet({
  ...puvodni, id: 'kopie', name: puvodni.name + ' (kopie)', off: true,
  banners: puvodni.banners.map((one, i) => ({ ...one, id: 'nova' + i })),
  links: { ...puvodni.links, items: puvodni.links.items.map(one => ({ ...one, id: 'novyodkaz' })) }
});
ok('kopie má vlastní identifikátor', kopie.id !== puvodni.id);
ok('a dlaždice v ní taky',
  kopie.banners.every(one => !puvodni.banners.some(orig => orig.id === one.id)));
ok('i odkazy pod bannerem',
  kopie.links.items.every(one => !puvodni.links.items.some(orig => orig.id === one.id)));
/*
 * Kopie se zakládá vypnutá. Sada platná pořád by se jinak hned začala
 * prát s originálem o tentýž čas a na webu by se objevila dřív, než se
 * v ní stihne cokoli přepsat.
 */
check('a je vypnutá, takže se na web nedostane', JSON.parse(T.payload([kopie])).sets.length, 0);

/* ---------- kam se nahrávají fotky ---------- */

console.log('\nnahrávání fotek:\n');

/*
 * Fotky bannerů jdou do správce souborů e-shopu. **Naučená adresa není
 * podmínka** — cesta se skládá z adresy administrace a naučení je jen
 * pojistka pro případ, že by ji Upgates změnily. Ptát se na naučení
 * znamenalo hlásit „není naučené" i tam, kde nahrávání roky fungovalo,
 * a přesně to se stalo.
 */
{
  const dbm = require(path.join(DIST, 'db.js'));
  const files = require(path.join(DIST, 'articles/files.js'));
  dbm.setSetting('articleFilesUrl', '');
  dbm.setSetting('invoiceAdminHome', 'https://quentino.s19.upgates.com/manager/');
  ok('nahrávat jde i bez naučené adresy správce souborů',
    files.filesReady() && !files.filesUrlLearned());
  dbm.setSetting('invoiceAdminHome', '');
  dbm.setSetting('upgatesUrl', '');
  ok('bez adresy administrace se ale nahrávat nedá', !files.filesReady());
}

/*
 * Otevření nahrávání ve správci souborů.
 *
 * Výpis souborů žádné políčko na soubor nemá — Dropzone si ho vyrobí
 * teprve po kliknutí na „Nahrát soubory". Dřív se na něj čekalo tři
 * minuty a pak vypadlo „políčko se neobjevilo", tedy hláška, ze které
 * nebylo poznat, co dělat. Hledá se **podle textu**, protože třídy se
 * v šabloně mění s každou verzí, kdežto „Nahrát soubory" zůstává.
 */
{
  const files = require(path.join(DIST, 'articles/files.js'));
  const prvek = (text, cls, vidi = true, atr = {}, ikona = '') => ({
    textContent: text, className: cls || '',
    getAttribute: name => atr[name] ?? null,
    /* Tlačítka v administraci bývají jen ikona — popisek je v title nebo v obsluze */
    querySelector: () => (ikona ? { className: ikona } : null),
    getBoundingClientRect: () => (vidi ? { width: 120, height: 32 } : { width: 0, height: 0 }),
    click() { this.kliknuto = true; },
    kliknuto: false
  });
  const spust = prvky => {
    const doc = { querySelectorAll: () => prvky };
    /*
     * Závorky kolem schválně: skript začíná novým řádkem a „return" by se
     * jinak ukončil středníkem sám od sebe — vrátilo by se `undefined`
     * a zkouška by měřila vlastní chybu místo skriptu.
     */
    // eslint-disable-next-line no-new-func
    return { vysledek: new Function('document', 'return (' + files.__test.REVEAL + ')')(doc), prvky };
  };

  const a = spust([prvek('Zpět'), prvek('Nahrát soubory'), prvek('Smazat')]);
  check('nahrávání se otevře klepnutím na „Nahrát soubory"',
    [a.vysledek, a.prvky[1].kliknuto], [true, true]);
  const b = spust([prvek('Upload files', 'btn')]);
  ok('anglická šablona taky', b.vysledek === true);
  const c = spust([prvek('Nahrát soubory', '', false), prvek('Vložit soubor')]);
  check('schované tlačítko se přeskočí — klikat na neviditelné nemá smysl',
    [c.prvky[0].kliknuto, c.prvky[1].kliknuto], [false, true]);
  const d = spust([prvek('Zpět'), prvek('Smazat')]);
  ok('a když tam nic takového není, nic se neklikne', d.vysledek === false);

  /*
   * Tlačítko bez textu. Ve správci souborů Upgates je popisek v "title"
   * nebo "data-tip" a obsluha v "onclick" — podle samotného textu se
   * nenašlo nic a nahrávání hlásilo, že se políčko neobjevilo.
   */
  const e = spust([prvek('', 'smi', true, { onclick: 'dialogUploadFiles(1021);' })]);
  ok('pozná se i tlačítko, které má jen obsluhu v onclick', e.vysledek === true);
  const f = spust([prvek('', 'btn', true, { title: 'Nahrát soubory' }, 'fa fa-upload')]);
  ok('a tlačítko, které je jen ikona s popiskem', f.vysledek === true);

  /*
   * A hlavně: ve stromu složek se **nesmí** kliknout na nic. Jsou tam
   * vedle sebe „Přidat podkategorii", „Upravit" a „Smazat" — a klik na to
   * poslední maže složku i s podsložkami.
   */
  const strom = spust([
    prvek('', 'smi menu-add', true, { onclick: 'dialogAddFolder(1019);', title: 'Přidat podkategorii' }, 'fa fa-plus'),
    prvek('', 'smi menu-edit', true, { href: '/manager/files/?category_id=1019&do=editFolder' }, 'fa fa-pencil'),
    prvek('', 'smi menu-delete', true, {
      'data-href': '/manager/files/?category_id=1019&do=deleteFolder',
      'data-confirmation': 'Opravdu chcete smazat tuto položku?'
    }, 'fa fa-trash-can'),
    prvek('Vše', '', true, { href: '/manager/files/default/default/all/?filesPaginator-page=1' })
  ]);
  check('ve stromu složek se neklikne na nic',
    [strom.vysledek, strom.prvky.filter(one => one.kliknuto).length], [false, 0]);
}

/* ---------- ikonky v pruhu odkazů ---------- */

console.log('\nikonky odkazů:\n');

/*
 * Do políčka na emoji se dá napsat cokoli — a písmeno v šedém čtverci
 * na webu vypadá jako nenačtený obrázek, ne jako ikonka. Přesně tak
 * skončil pruh odkazů na e-shopu: svítilo v něm „N B S B".
 */
check('písmeno není emoji a na web se nedostane', T.onlyEmoji('N'), '');
check('ani celé slovo', T.onlyEmoji('Necktie'), '');
check('obyčejné emoji projde', T.onlyEmoji('👔'), '👔');
check('složené emoji se nerozpadne', T.onlyEmoji('👨‍👩‍👦', 5), '👨‍👩‍👦');
check('a z textu s emoji zbude emoji', T.onlyEmoji('Kravaty 👔'), '👔');
check('v odkazu pod bannerem platí totéž',
  T.normalizeSet({ links: { on: true, items: [
    { id: 'l1', emoji: 'B', text: { cz: 'Motýlky' }, href: { cz: '/motylky' } }
  ] } }).links.items[0].emoji, '');
/*
 * Prázdný rámeček se vůbec nekreslí. Šedý čtverec bez obsahu vypadá
 * jako chyba vykreslování a samotný text je čitelný i bez něj.
 */
ok('bez obrázku i emoji se rámeček ikonky nekreslí', kod.includes('maObrazek || one.emoji'));

/* ---------- druhý blok bannerů ze šablony ---------- */

/*
 * Šablona má bannerů víc než jeden blok: pod hlavním karuselem je ještě
 * skupina bannerů — velké fotky bez textu, které nikam nevedou. Zůstávaly
 * pod naším blokem a vypadalo to, jako by se banner vykreslil dvakrát.
 */
ok('skupina bannerů ze šablony se schová taky', script.includes('.qbn-on .bnr-group'));
ok('a zahodí se i s obrázky', kod.includes('.bnr-group'));
/* Pruh odkazů se lepil rovnou na další sekci stránky */
ok('pruh odkazů má pod sebou vzduch',
  /\.qbn-links \{[^}]*margin:[^;]*clamp\(20px/.test(script));

/* ---------- náhled v aplikaci ---------- */

console.log('\nnáhled v aplikaci:\n');

/*
 * Živý náhled spouští skript vložený přímo do stránky. Okno aplikace má
 * ale `script-src 'self'`, a to platí i pro rámeček vložený přes `srcdoc`,
 * protože ten dědí pravidla rodiče — náhled proto zůstával prázdný,
 * zatímco na webu bannery běžely. Stránku teď vydává hlavní proces na
 * vlastní adrese, a ta musí být v pravidlech povolená. Kdyby jedno
 * z toho vypadlo, pozná se to tady, ne až v aplikaci.
 */
const indexHtml = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8');
const preview = require(path.join(DIST, 'bannerpreview.js'));
const frameSrc = /frame-src ([^;"]*)/.exec(indexHtml)?.[1] ?? '';
ok(`adresa náhledu je v pravidlech okna povolená (${frameSrc.trim()})`,
  frameSrc.includes(preview.PREVIEW_SCHEME + ':'));
ok('a nepovoluje se kvůli ní vkládaný kód v celé aplikaci',
  !/script-src[^;]*unsafe-inline/.test(indexHtml));
const adresa = preview.stashPreview('<!doctype html><p>zkouška</p>');
ok('stránka náhledu se vydává adresou, ne textem',
  adresa.indexOf(preview.PREVIEW_SCHEME + '://') === 0, adresa);

/* ---------- pruh odkazů pod bannerem ---------- */

console.log('\nodkazy pod bannerem:\n');

const sOdkazy = sada({
  links: { on: true, shape: 'circle', items: [
    { id: 'l1', emoji: '👔', text: { cz: 'Kravaty' }, href: { cz: '/kravaty' } },
    { id: 'l2', emoji: '🎀', text: { cz: '' }, href: { cz: '/motylky' } },
    { id: 'l3', emoji: '🧵', text: { cz: 'Kšandy' }, href: { cz: '' } }
  ] }
});
check('odkaz bez textu ani bez cíle se nevystavuje',
  T.liveLinks(sOdkazy).map(one => one.id), ['l1']);
check('vypnutý pruh se nevystavuje vůbec',
  T.liveLinks(sada({ links: { on: false, items: [{ id: 'x', text: { cz: 'A' }, href: { cz: '/a' } }] } })).length, 0);
ok('pruh jde na web i s podobou', T.setRow(sOdkazy).links.shape === 'circle');
ok('sada, ve které je jen pruh odkazů, taky projde',
  T.validateSet(sada({ banners: [], links: sOdkazy.links })) === '');
ok('skript pruh odkazů kreslí', kod.includes('qbn-link'));
ok('a na telefonu se posouvá prstem', script.includes('scroll-snap-type'));

/* ---------- ikonka od AI ---------- */

console.log('\nikonky od AI:\n');

const ikony = require(path.join(DIST, 'bannericon.js'));
const I = ikony.__test;

/*
 * Jádro věci: SVG skládá aplikace z ověřených tvarů, ne model. Kdyby se
 * model mohl vyjádřit volně, byl by `<script>` v ikonce na e-shopu kus
 * cizího kódu na cizí stránce — a nikdo by ho nečetl.
 */
ok('z cesty se stane tah', I.iconSvg([{ cesta: 'M4 12 L20 12' }]).includes('<path d="M4 12 L20 12"'));
ok('kružnice, obdélník i čára projdou',
  I.iconSvg([{ kruh: [12, 12, 5] }, { obdelnik: [4, 6, 16, 12, 2] }, { cara: [3, 3, 21, 21] }])
    .includes('<circle') === true
  && I.iconSvg([{ obdelnik: [4, 6, 16, 12, 2] }]).includes('rx="2"'));
check('skript v cestě propadne sítem', I.pathData('M4 4 L20 20"/><script>x()</script>'), '');
check('a cesta, co nezačíná příkazem, taky', I.pathData('url(https://cizi/x.svg)'), '');
check('z tvarů, ze kterých nezbylo nic, se ikonka nedělá', I.iconSvg([{ cesta: '<img>' }]), '');
ok('souřadnice mimo mřížku se zahodí', I.iconSvg([{ kruh: [12, 12, 9999] }]) === '');
ok('ikonka je černá a obrysová', I.iconSvg([{ cesta: 'M4 12 L20 12' }]).includes('stroke="#000000"'));
ok('a vyplněná varianta je opravdu vyplněná',
  I.iconSvg([{ cesta: 'M4 12 L20 12' }], true).includes('fill="#000000"'));

const ikonaUrl = I.svgUrl(I.iconSvg([{ cesta: 'M4 12 L20 12' }]));
ok('adresa ikonky je base64 bez uvozovek a mezer',
  /^data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+$/.test(ikonaUrl), ikonaUrl.slice(0, 40));
check('a projde přes kontrolu obrázků do plánu', banners.safeImage(ikonaUrl), ikonaUrl);
check('kdežto cizí data: adresa ne', banners.safeImage('data:text/html;base64,PHNjcmlwdD4='), '');
ok('skript na webu kreslenou ikonku pozná a nechá kolem ní vzduch',
  kod.includes('data-kresba') && script.includes('.qbn-link-ico[data-kresba]'));

/* ---------- video na pozadí ---------- */

console.log('\nvideo v banneru:\n');

check('webm projde', banners.safeVideo('https://cdn.upgates.com/x/video.webm'),
  'https://cdn.upgates.com/x/video.webm');
check('mp4 taky', banners.safeVideo('https://cdn.upgates.com/x/a.mp4?v=2'),
  'https://cdn.upgates.com/x/a.mp4?v=2');
check('obrázek jako video ne', banners.safeVideo('https://cdn.upgates.com/x/a.webp'), '');
check('a uvozovka v adrese už vůbec ne',
  banners.safeVideo('https://cdn.x/a.webm") url(javascript:alert(1)'), '');

const sVideo = sada({ banners: [banner({
  look: { ...banner().look, video: 'https://cdn.upgates.com/x/video.webm' }
}) ] });
ok('video se vystavuje na web', T.setRow(sVideo).banners[0].look.video.endsWith('.webm'));
ok('banner jen s videem je platná sada', T.validateSet(sVideo) === '');
/*
 * Text na pohyblivém obraze je čitelný ještě hůř než na fotce, takže
 * ztmavení platí stejně jako u fotky — i když se posuvník stáhl na nulu.
 */
const sVideoTma = T.normalizeSet(sada({ banners: [banner({
  look: { ...banner().look, video: 'https://cdn.upgates.com/x/video.webm', overlay: 0 }
}) ] }));
ok('a pod textem se video ztmaví stejně jako fotka',
  sVideoTma.banners[0].look.overlay >= banners.MIN_OVERLAY);
ok('skript video pouští bez zvuku, ve smyčce a v rámci stránky',
  kod.includes('vid.muted = true') && kod.includes('vid.loop = true')
  && kod.includes('vid.playsInline = true'));
ok('kdo nechce pohyb, dostane jen fotku',
  /prefers-reduced-motion[\s\S]{0,200}return/.test(kod));
ok('a než video naběhne, je vidět fotka pod ním',
  script.includes('.qbn-video[data-hraje]') && kod.includes('poster'));

/* ---------- vkládání souborů do správce ---------- */

console.log('\nnahrávání do správce souborů:\n');

const formfile = require(path.join(DIST, 'formfile.js'));
const F = formfile.__test;
const vkladani = F.dropScript([{ name: 'a.webp', type: 'image/webp', b64: 'AAAA' }]);

/*
 * Nahrávání končilo na „políčko se ve správci souborů neobjevilo".
 * Důvod: políčko na výpisu vůbec není a když je, bývá ve vnořeném rámu.
 * Soubory se proto předávají rovnou Dropzonu.
 */
ok('soubor se předává Dropzonu', vkladani.includes('kam.addFile(one)'));
ok('a když není, zkusí se políčko na soubor', vkladani.includes('policko.files = prenos.files'));
ok('a jako poslední se soubor do stránky upustí', vkladani.includes('new DragEvent'));
ok('obsah souboru cestuje s sebou, disk stránka nevidí',
  vkladani.includes('atob(one.b64)') && vkladani.includes('new File('));
ok('a když není kam, upustí se rovnou na výpis souborů',
  vkladani.includes('.manager-file'));
ok('hledá se i v místech, kde Dropzone teprve bude', F.PROBE.includes('input[type=file]'));
/*
 * Diagnostika. Nahrávání se ladí na cizím počítači přes zprávu v chatu —
 * bez toho, co přesně na stránce bylo, zní „nešlo to" stejně u iframu
 * z cizí domény jako u přejmenovaného tlačítka.
 */
ok('hláška umí říct, co na stránce bylo',
  F.PROBE.includes('tiles') && F.PROBE.includes('buttons') && F.PROBE.includes('location.href'));

/*
 * Hledání se nesmí rozbít o stránku.
 *
 * Když skript v okně spadne, vrátí Electron odmítnuté volání — a to
 * vypadá úplně stejně jako zavřené okno. Přesně takhle vzniklo
 * „stránka neodpověděla vůbec": nebylo poznat, jestli je hluchá
 * administrace, nebo tenhle kus kódu. Chyba proto musí přijít jako
 * hodnota, ne jako výjimka.
 */
{
  // eslint-disable-next-line no-new-func
  const spust = doc => new Function('document', 'window', 'location',
    'return (' + F.PROBE + ')')(doc, {}, { href: 'https://admin/x' });
  const zdravy = spust({
    title: 'Soubory', querySelector: () => null,
    querySelectorAll: sel => (sel === '.manager-file' ? [{}, {}, {}] : [])
  });
  check('na obyčejné stránce spočítá, co na ní je',
    [zdravy.tiles, zdravy.chyba], [3, '']);
  const zlobivy = spust({
    title: 'Soubory',
    querySelector: () => { throw new Error('Permission denied'); },
    querySelectorAll: () => { throw new Error('Permission denied'); }
  });
  ok('a když se stránka brání, vrátí chybu místo výjimky',
    !!zlobivy && zlobivy.chyba.includes('Permission denied'), JSON.stringify(zlobivy));
}

/* ---------- co se opravilo ---------- */

console.log('\nopravené drobnosti:\n');

/*
 * Emoji padala jen v horním proužku: posouvala se transformací v procentech,
 * a ta se počítá z velikosti samotného znaku, ne z dlaždice. Procenta
 * u "top" se počítají z výšky rodiče — tedy z dlaždice.
 */
ok('padání jde přes celou dlaždici, ne podle velikosti znaku',
  script.includes('top: 115%') && !/translate3d\([^)]*5\d\d%/.test(script));
ok('a dá se u něj nastavit hustota, velikost i rychlost',
  kod.includes('fxCount') && kod.includes('fxSize') && kod.includes('fxSpeed'));
/* Blok se lepil na hlavičku i na obsah pod sebou */
ok('blok má kolem sebe vzduch', /\.qbn \{[^}]*margin:/.test(script));
/* Na telefonu přeskakovalo rolování rovnou na banner */
ok('a nepřetahuje si kotvu rolování', script.includes('overflow-anchor: none'));
/* Schovaný karusel si dál stahoval své fotky */
ok('původní karusel se ze stránky odstraní, ne jen schová', kod.includes('removeChild'));
ok('a jeho obrázkům se nejdřív sebere adresa', kod.includes('removeAttribute("srcset")'));

if (failed) {
  console.log(`\n✗ ${failed} zkoušek selhalo`);
  process.exit(1);
}
console.log('\n✓ bannery sedí');
