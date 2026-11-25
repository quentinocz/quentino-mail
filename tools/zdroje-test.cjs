/**
 * Zkouška zdroje objednávek — třídění do kanálů, spojení měření,
 * měřicí skript na e-shopu a stažení záznamů ze Supabase.
 *
 * Patrik (25. 11.): „detekce a párování objednávky se zdrojem — organic,
 * google, facebook, případně přes proklik i konkrétní kampaň". Hlídá se
 * hlavně to, co by se v okně tvářilo jako pravda a nebyla: návrat
 * z platební brány jako „odkaz", fbclid jako placená reklama, měření
 * u zákazníka, který cookies odmítl.
 *
 * Síť se nikam nevolá — `fetch` je podstrčený.
 */
const path = require('path');
const vm = require('vm');
const { db, DIST } = require('./ptrans/harness.cjs');

db.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
const secPath = require.resolve(path.join(DIST, 'secure.js'));
require.cache[secPath] = { id: secPath, filename: secPath, loaded: true, exports: {
  encrypt: v => v, decrypt: v => v, connectSecure: () => {}
} };

let failed = 0;
const ok = (name, cond, detail = '') => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail ? `   ${detail}` : ''}`);
  if (!cond) failed += 1;
};

const zdroje = require(path.join(DIST, 'zdroje.js'));
const skript = require(path.join(DIST, 'zdrojeskript.js'));
const { zarad, zdrojZMereni, zdrojZGa4, spoj, klicObjednavky, trhZWebu } = zdroje.__test;

console.log('\ntřídění do kanálů');
const k = d => zarad(d).kanal;
ok('gclid = Google Ads, i bez UTM', k({ clid: 'gclid' }) === 'google_ads');
ok('google / cpc = Google Ads', k({ zdroj: 'google', medium: 'cpc', kampan: 'PMax CZ' }) === 'google_ads');
ok('google / organic = Google organicky', k({ zdroj: 'google', medium: 'organic' }) === 'google');
ok('odkaz z google.com bez UTM = Google organicky', k({ referrer: 'google.com' }) === 'google');
ok('sznclid = Sklik', k({ clid: 'sznclid' }) === 'sklik');
ok('seznam / cpc = Sklik, search.seznam.cz = Seznam organicky',
  k({ zdroj: 'seznam', medium: 'cpc' }) === 'sklik' && k({ referrer: 'search.seznam.cz' }) === 'seznam');
ok('facebook / paid = reklama na Metě', k({ zdroj: 'facebook', medium: 'paid' }) === 'meta_ads');
ok('fbclid bez UTM = Facebook (ne nutně reklama)', k({ clid: 'fbclid' }) === 'meta');
ok('l.facebook.com = Facebook organicky', k({ referrer: 'l.facebook.com' }) === 'meta');
ok('heureka = srovnávač s názvem', zarad({ zdroj: 'heureka.cz', medium: 'cpc' }).kanal === 'srovnavac'
  && zarad({ zdroj: 'heureka.cz', medium: 'cpc' }).nazev === 'Heureka');
ok('ecomail / email = newsletter', k({ zdroj: 'ecomail', medium: 'email' }) === 'email');
ok('(direct) i nic = přímo', k({ zdroj: '(direct)', medium: '(none)' }) === 'primo' && k({}) === 'primo');
ok('jiný web = odkaz s doménou', zarad({ referrer: 'modnipanove.cz' }).nazev === 'Odkaz: modnipanove.cz');
ok('kanál z Analytics rozhodne, když chybí médium', k({ zdroj: 'google', kanalGa4: 'Paid Search' }) === 'google_ads'
  && k({ zdroj: 'instagram.com', kanalGa4: 'Organic Social' }) === 'meta');

console.log('\nspojení měření');
const mereni = {
  web: 'www.quentino.sk', kdy: '2026-11-20T10:00:00Z', zarizeni: 'mobil',
  prvni: { zdroj: 'facebook', medium: 'paid', kampan: 'Vánoce SK', kdy: '2026-11-10T10:00:00Z' },
  posledni: { clid: 'gclid', clidHodnota: 'abc', vstup: '/kravaty', kdy: '2026-11-20T09:50:00Z' },
  dotyky: [{ zdroj: 'facebook', medium: 'paid' }, { clid: 'gclid', clidHodnota: 'abc' }]
};
const z1 = zdrojZMereni(mereni, { kampan: 'Search – kravaty', sestava: 'hedvábné', klic: 'hedvábná kravata' });
ok('poslední proklik rozhoduje, kampaň a klíčové slovo z Google Ads podle gclid',
  z1.kanal === 'google_ads' && z1.kampan === 'Search – kravaty' && z1.detail.includes('klíčové slovo: hedvábná kravata')
    && z1.detail.includes('vstup: /kravaty') && z1.detail.includes('mobil'), JSON.stringify(z1));
ok('  poprvé přišel z reklamy na Facebooku (jiný kanál) a prokliků bylo víc',
  z1.prvni && z1.prvni.kanal === 'meta_ads' && z1.prvni.kampan === 'Vánoce SK' && z1.dotyku === 2);
const ga = {
  id: '2026001', datum: '2026-11-20', zdroj: 'google', medium: 'cpc', kampan: '', kanal: 'Paid Search', zarizeni: 'desktop',
  vstup: '/motylky', trzba: 1290, adsKampan: 'Shopping CZ', adsSestava: '', adsKlic: '', term: '', obsah: '',
  prvniZdroj: 'google', prvniMedium: 'organic', prvniKampan: ''
};
const z2 = zdrojZGa4(ga);
ok('Analytics: kampaň z Google Ads, zařízení a vstup, první návštěva organicky',
  z2.kanal === 'google_ads' && z2.kampan === 'Shopping CZ' && z2.detail.includes('počítač') && z2.prvni && z2.prvni.kanal === 'google');
const z3 = spoj({ ga4: ga, mereni: { ...mereni, posledni: { zdroj: 'google', medium: 'cpc', kdy: 'x' }, prvni: null, dotyky: [] }, ads: null });
ok('oboje: kanál z měření, kampaň doplněná z Analytics', z3.odkud === 'oboje' && z3.kampan === 'Shopping CZ', JSON.stringify(z3));
ok('číslo objednávky se páruje bez nul a mřížky; trh podle webu',
  klicObjednavky('#0026001') === '26001' && trhZWebu('www.quentino.sk') === 'sk' && trhZWebu('wearquentino.com') === 'en'
    && trhZWebu('www.quentino.cz') === 'cz');

console.log('\nměřicí skript na e-shopu');
const kod = skript.zdrojeSkript('https://abc.supabase.co/', 'anon-klic');
ok('skript má vyplněnou adresu, klíč i tabulku', /https:\/\/abc\.supabase\.co"/.test(kod) && /"anon-klic"/.test(kod)
  && /quentino_zdroje/.test(kod) && !/__QZ_/.test(kod));
const telo = kod.replace(/^<script>/, '').replace(/<\/script>$/, '');

function spust({ url, referrer = '', consent = null, ulozeno = null }) {
  const store = new Map(ulozeno ? [['quentino-zdroje-1', ulozeno]] : []);
  const odeslano = [];
  const dl = [];
  if (consent) dl.push(['consent', 'default', { analytics_storage: consent }]);
  const u = new URL(url);
  const okno = {
    dataLayer: dl,
    location: { search: u.search, pathname: u.pathname, hostname: u.hostname },
    matchMedia: () => ({ matches: true }),
    localStorage: { getItem: k2 => store.get(k2) ?? null, setItem: (k2, v) => store.set(k2, v) },
    fetch: (adresa, init) => { odeslano.push({ adresa, init }); return Promise.resolve({ ok: true }); }
  };
  okno.window = okno;
  okno.document = { referrer, documentElement: { lang: 'cs' } };
  vm.runInNewContext(telo, okno);
  return { okno, store, odeslano };
}
const a = spust({ url: 'https://www.quentino.cz/kravaty?gclid=XYZ&utm_campaign=Zima', referrer: 'https://www.google.com/' });
ok('příchod z reklamy: proklik a kampaň se uloží', /"clid":"gclid"/.test(a.store.get('quentino-zdroje-1') || '')
  && /"kampan":"Zima"/.test(a.store.get('quentino-zdroje-1') || ''));
const b = spust({ url: 'https://www.quentino.cz/dekujeme', referrer: 'https://gw.gopay.com/x', ulozeno: a.store.get('quentino-zdroje-1') });
ok('návrat z platební brány není nový zdroj', JSON.parse(b.store.get('quentino-zdroje-1')).dotyky.length === 1);
b.okno.dataLayer.push({ event: 'purchase', ecommerce: { transaction_id: '2026123', value: 1290, currency: 'CZK' } });
const poslane = b.odeslano[0];
const json = poslane ? JSON.parse(poslane.init.body) : null;
ok('nákup: jeden záznam do Supabase s číslem objednávky a prokliky',
  b.odeslano.length === 1 && /rest\/v1\/quentino_zdroje$/.test(poslane.adresa) && json.objednavka === '2026123'
    && json.data.posledni.clid === 'gclid' && json.data.celkem === 1290 && poslane.init.headers.apikey === 'anon-klic',
  poslane ? poslane.adresa : 'nic');
b.okno.dataLayer.push({ event: 'purchase', ecommerce: { transaction_id: '2026123' } });
ok('  stejná objednávka podruhé (obnovení stránky) se neposílá', b.odeslano.length === 1);
const c = spust({ url: 'https://www.quentino.cz/?fbclid=1', consent: 'denied' });
c.okno.dataLayer.push(['event', 'purchase', { transaction_id: '99' }]);
ok('odmítnuté cookies: nic se neuloží ani neodešle', !c.store.size && !c.odeslano.length);
const d = spust({ url: 'https://www.quentino.cz/?utm_source=ecomail&utm_medium=email' });
d.okno.dataLayer.push(['event', 'purchase', { transaction_id: '100', value: 500, currency: 'CZK' }]);
ok('nákup přes gtag (pole argumentů) se pozná taky', d.odeslano.length === 1);
ok('SQL: zápis jen pro e-shop, čtení jen s tajným klíčem', /for insert to anon/.test(skript.ZDROJE_SQL)
  && !/for select/.test(skript.ZDROJE_SQL) && /enable row level security/.test(skript.ZDROJE_SQL));

console.log('\nstažení a přehled');
(async () => {
  const { setSetting } = require(path.join(DIST, 'db.js'));
  db.exec(`CREATE TABLE IF NOT EXISTS shop_orders (code TEXT NOT NULL, market TEXT NOT NULL DEFAULT 'cz', status TEXT NOT NULL DEFAULT '',
    paid INTEGER NOT NULL DEFAULT 0, paid_date TEXT NOT NULL DEFAULT '', resolved INTEGER NOT NULL DEFAULT 0, invoice TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '', currency TEXT NOT NULL DEFAULT '', total REAL NOT NULL DEFAULT 0,
    tracking TEXT NOT NULL DEFAULT '', customer_id TEXT NOT NULL DEFAULT '', name TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '', shipment TEXT NOT NULL DEFAULT '', payment TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
    items_json TEXT NOT NULL DEFAULT '[]', billing_json TEXT, postal_json TEXT, seen_at TEXT NOT NULL DEFAULT '', PRIMARY KEY (code, market))`);
  const ted = new Date().toISOString();
  for (const [code, market, total, currency] of [['2026123', 'cz', 1290, 'CZK'], ['2026124', 'sk', 49, 'EUR'], ['2026125', 'cz', 690, 'CZK']]) {
    db.prepare('INSERT OR REPLACE INTO shop_orders (code, market, created_at, total, currency, name) VALUES (?, ?, ?, ?, ?, ?)')
      .run(code, market, ted, total, currency, 'Jan Novák');
  }
  setSetting('zdrojeUrl', 'https://abc.supabase.co');
  setSetting('zdrojeTajny', 'tajny');
  const dotazy = [];
  global.fetch = async (adresa, init) => {
    dotazy.push({ adresa, init });
    const rows = /kdy=gt\.1970/.test(adresa) ? [
      { objednavka: '2026123', web: 'www.quentino.cz', kdy: '2026-11-25T10:00:00Z', data: json.data },
      { objednavka: '2026124', web: 'www.quentino.sk', kdy: '2026-11-25T11:00:00Z',
        data: { prvni: null, posledni: { referrer: 'l.facebook.com', kdy: 'x' }, dotyky: [{ referrer: 'l.facebook.com' }], zarizeni: 'pocitac' } }
    ] : [];
    return { ok: true, status: 200, json: async () => rows };
  };
  const n = await zdroje.obnovMereni();
  ok('záznamy ze Supabase se stáhnou tajným klíčem a jen nové', n === 2 && dotazy[0].init.headers.apikey === 'tajny'
    && /order=kdy\.asc/.test(dotazy[0].adresa));
  const n2 = await zdroje.obnovMereni();
  ok('  podruhé se ptá od posledního záznamu', n2 === 0 && /kdy=gt\.2026-11-25T11/.test(decodeURIComponent(dotazy[1].adresa)));
  const p = zdroje.prehled(30, 'all');
  const cz = p.radky.find(r => r.code === '2026123');
  const sk = p.radky.find(r => r.code === '2026124');
  ok('přehled: objednávky se zdrojem podle trhu, bez zdroje zvlášť',
    cz.zdroj.kanal === 'google_ads' && sk.zdroj.kanal === 'meta' && p.bezZdroje === 1, JSON.stringify(p.kanaly));
  ok('  souhrn po kanálech s tržbou v měně trhu',
    p.kanaly.some(x => x.kanal === 'meta' && x.trzba.EUR === 49) && p.kanaly.some(x => x.kanal === 'google_ads' && x.trzba.CZK === 1290));
  ok('zdroj jedné objednávky (balení, karta u e-mailu)', zdroje.zdrojObjednavky('2026124', 'sk').nazev === 'Facebook / Instagram'
    && zdroje.zdrojObjednavky('2026124', 'cz') === null);
  global.fetch = async () => ({ ok: false, status: 404, json: async () => ({ message: 'relation "public.quentino_zdroje" does not exist' }) });
  let chyba = '';
  try { await zdroje.overMereni(); } catch (e) { chyba = e.message; }
  ok('chybějící tabulka: řekne, ať se spustí SQL', /spusť jednou SQL/.test(chyba), chyba);

  console.log(failed ? `\n✗ ${failed} chyb` : '\n✓ zdroj objednávek sedí');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('  ✗ spadlo:', e && e.stack || e); process.exit(1); });
