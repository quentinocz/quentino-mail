/*
 * Co z čísel plyne.
 *
 * Tohle je ta část přehledu, kterou čte člověk, co čísla v e-shopu nečte
 * denně — a proto se hlídá přísněji než zbytek: každá rada musí mít **krok**
 * (co udělat) a **podklad** (z čeho to plyne), jinak je to jen hezká věta.
 * A hlavně se hlídají hranice: rada, která vyskočí u výkyvu o dvě
 * objednávky, naučí člověka přehled ignorovat.
 */
const path = require('path');
const DIST = path.join(__dirname, '..', 'dist', 'ptdist');
const { adviceItems, adviceColumns, tileVerdicts } = require(path.join(DIST, 'shared', 'advice.js'));

let failed = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? '✓' : '✗'} ${name}`);
  if (!ok) {
    failed++;
    console.log(`      čekáno: ${JSON.stringify(want)}`);
    console.log(`      dostal: ${JSON.stringify(got)}`);
  }
}

const NIC = { orders: 0, cancelled: 0, unpaid: 0, revenue: [], items: 0 };
const castka = amount => [{ currency: 'CZK', amount }];

function facts(over = {}) {
  return {
    currency: 'CZK',
    today: { ...NIC, orders: 5 },
    yesterday: { ...NIC, orders: 5 },
    window: { ...NIC, orders: 100, revenue: castka(200000) },
    prevWindow: { ...NIC, orders: 100, revenue: castka(200000) },
    month: { ...NIC }, prevMonth: { ...NIC }, monthLabel: '', monthDays: 20,
    days: [], countries: [], shipments: [], payments: [], products: [],
    // Osmnáct procent návratů je nijak — ani chvála, ani výtka
    returning: 18, average: 2000, signals: [], statuses: [], purchases: 0,
    duplicates: 0, sizes: [], history: { months: [], coverage: 0, lastYear: null, rank: null, season: null, seasons: [] },
    social: null, feedAt: null, known: 100,
    ...over
  };
}
const ids = list => list.map(one => one.id);

console.log('\nco z toho plyne:\n');

/*
 * Klidný měsíc. Nic se nekazí, nic nevystřelilo — a přesně tehdy se nesmí
 * nic hlásit. Rada „pro jistotu" je horší než ticho: po třetí naučí člověka
 * kartu přeskakovat.
 */
check('u klidných čísel se nic nehlásí', ids(adviceItems({ facts: facts() })), []);

/* Nezaplacené jsou nejrychlejší peníze v přehledu — zboží je vybrané */
const nezaplacene = adviceItems({ facts: facts({ window: { ...NIC, orders: 100, unpaid: 8, revenue: castka(200000) } }) });
check('nezaplacené objednávky se hlásí', ids(nezaplacene).includes('nezaplacene'), true);
check('a má to krok, ne jen konstatování',
  nezaplacene[0].todo.length > 20 && nezaplacene[0].basis.length > 5, true);

/*
 * Propad se dá spravit dvěma různými způsoby a každý stojí jinak. Bez
 * návštěvnosti se neví který — a tehdy je jediná poctivá rada „zapni si
 * měření", ne hádat.
 */
const propadBezGa4 = adviceItems({ facts: facts({ window: { ...NIC, orders: 60, revenue: castka(120000) } }) });
check('propad se pozná', ids(propadBezGa4).includes('propad'), true);
check('bez návštěvnosti se neradí naslepo',
  propadBezGa4.find(one => one.id === 'propad').todo.includes('Analytics'), true);

const propadLidiUbylo = adviceItems({
  facts: facts({ window: { ...NIC, orders: 60, revenue: castka(120000) } }),
  ga4: { window: { sessions: 3000 }, prevWindow: { sessions: 5000 }, conversion: null, prevConversion: null, error: null }
});
check('ubylo lidí → propagace',
  propadLidiUbylo.find(one => one.id === 'propad').todo.includes('propagaci'), true);

const propadNekupuji = adviceItems({
  facts: facts({ window: { ...NIC, orders: 60, revenue: castka(120000) } }),
  ga4: { window: { sessions: 5100 }, prevWindow: { sessions: 5000 }, conversion: null, prevConversion: null, error: null }
});
check('chodí stejně a nekupují → web, cena, doprava',
  propadNekupuji.find(one => one.id === 'propad').todo.includes('cenu'), true);

/* Dobírka: poplatek dopravci a nevyzvednuté balíky — největší úspora po ruce */
const dobirka = adviceItems({
  facts: facts({ payments: [
    { key: 'dob', label: 'Dobírka', orders: 60, revenue: 0 },
    { key: 'kar', label: 'Karta', orders: 40, revenue: 0 }
  ] })
});
check('vysoký podíl dobírky se ozve', ids(dobirka).includes('dobirka'), true);

/* Sezóna se hlásí dopředu, ale ne celý rok — na pololetní výhled se nechystá */
const sezonaBlizko = adviceItems({ facts: facts({ history: { months: [], coverage: 12, lastYear: null, rank: null, season: null,
  seasons: [{ month: '2026-12', label: 'prosinec', name: 'vánoční sezóna', index: 1.9, strong: true,
    startBy: '2026-11-10', inDays: 60, text: '', basis: '', products: [{ code: 'A', title: 'Pásek', qty: 9 }], posts: [] }] } }) });
check('blížící se sezóna se ozve', ids(sezonaBlizko).includes('sezona'), true);
const sezonaDaleko = adviceItems({ facts: facts({ history: { months: [], coverage: 12, lastYear: null, rank: null, season: null,
  seasons: [{ month: '2027-05', label: 'květen', name: 'svatební sezóna', index: 1.5, strong: true,
    startBy: '2027-04-10', inDays: 200, text: '', basis: '', products: [], posts: [] }] } }) });
check('a vzdálená mlčí', ids(sezonaDaleko).includes('sezona'), false);

/*
 * Zapsaná akce s měřeným dopadem je jediné místo v přehledu, kde se dá
 * říct „tohle zabralo" o něčem, co jde zopakovat.
 */
const akce = adviceItems({
  facts: facts(),
  events: [{ id: 1, kind: 'akce', title: 'Sleva 20 %', from: '2026-09-05', to: '2026-09-08', days: 4,
    orders: 31, perDay: 7.8, basePerDay: 3.2, moneyDiff: 22600, currency: 'CZK', future: false, known: true,
    posts: 0, likes: 0 }]
});
check('povedená akce se připomene', ids(akce).includes('akce-zabrala'), true);

/*
 * Postřehy od AI. Berou se jen varování a nápady — „trend" je pozorování,
 * ne úkol. A co už spočítal kód, se neopakuje: dvě věty o nezaplacených
 * objednávkách vedle sebe vypadají jako dvě zjištění.
 */
const sAi = adviceItems({
  facts: facts({ window: { ...NIC, orders: 100, unpaid: 8, revenue: castka(200000) } }),
  notes: [
    { kind: 'trend', text: 'Podíl karty stoupl na 60 % objednávek.', basis: '60 ze 100', check: null },
    { kind: 'pozor', text: 'Osm nezaplacených objednávek čeká déle než tři dny.', basis: '8 ze 100', check: null },
    { kind: 'napad', text: 'K pásku nabídnout kšandy v setu.', basis: '12 ze 34', check: 'pět objednávek se setem' }
  ]
});
check('trend od AI mezi úkoly nepatří', sAi.some(one => one.title.includes('Podíl karty')), false);
check('varování, které kód už spočítal, se neopakuje',
  sAi.filter(one => /zaplac/i.test(one.title)).length, 1);
check('nápad od AI projde', sAi.some(one => one.from === 'ai' && one.level === 'idea'), true);

/* Tři sloupce: co funguje, co zlepšit, co zkusit */
const sloupce = adviceColumns(adviceItems({
  facts: facts({
    window: { ...NIC, orders: 140, unpaid: 8, revenue: castka(300000) },
    returning: 40,
    payments: [{ key: 'dob', label: 'Dobírka', orders: 80, revenue: 0 }, { key: 'k', label: 'Karta', orders: 60, revenue: 0 }]
  })
}));
check('dobré zprávy mají svůj sloupec', sloupce.good.length > 0, true);
check('problémy taky', sloupce.watch.length > 0, true);
check('a nápady taky', sloupce.idea.length > 0, true);

console.log('\nverdikt u čísla:\n');

/*
 * Verdikt je to, co z údaje dělá zprávu. Musí vyjít i tam, kde se srovnávat
 * nedá — tehdy prostě chybí a dlaždice zůstane bez slova, což je lepší než
 * verdikt vymyšlený z ničeho.
 */
const klid = tileVerdicts(facts());
check('beze změny se hlásí, že se drží', klid.okno.word, 'drží se');
check('a je to neutrální', klid.okno.level, 'ok');

const rust = tileVerdicts(facts({ window: { ...NIC, orders: 140, revenue: castka(300000) } }));
check('růst se pozná', rust.okno.level, 'good');
check('a tržba taky', rust.trzba.level, 'good');

const pokles = tileVerdicts(facts({ window: { ...NIC, orders: 70, revenue: castka(140000) } }));
check('pokles se pozná', pokles.okno.level, 'watch');
check('a řekne, kde hledat příčinu', /návštěv/.test(pokles.okno.why), true);

/* U nezaplacených jde nezaplacené před růstem — započítaná tržba, co nedorazí */
const cekaNaPlatbu = tileVerdicts(facts({ window: { ...NIC, orders: 140, unpaid: 20, revenue: castka(300000) } }));
check('nezaplacené přebijí růst tržby', cekaNaPlatbu.trzba.word, 'čeká na platbu');

/* Malá čísla se nehodnotí — jedna velká objednávka by udělala „trend" */
const malo = tileVerdicts(facts({ window: { ...NIC, orders: 5, revenue: castka(20000) }, prevWindow: { ...NIC, orders: 4, revenue: castka(8000) } }));
check('u pár objednávek se verdikt nevymýšlí', malo.okno, null);
check('ani u průměrné objednávky', malo.prumer, null);

if (failed) {
  console.log(`\n✗ ${failed} zkoušek selhalo`);
  process.exit(1);
}
console.log('\n✓ co z čísel plyne sedí');
