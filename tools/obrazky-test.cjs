/**
 * Zkouška kreslení obrázků — proti falešnému OpenAI.
 *
 * ## Proč vůbec
 *
 * Tahle část aplikace neměla zkoušku žádnou a hned první ostré použití
 * skončilo chybou, která se dala poznat předem: kreslení od nuly
 * (`/images/generations`) se posílalo jako **formulář**, jenže ta adresa
 * bere jen JSON. Odpověď zněla „Unsupported content type:
 * 'multipart/form-data'" a žádná postava nevznikla. Vidět to nebylo,
 * protože se do té doby pracovalo jen se zástupnou kresbou, a ručně se
 * to zkoušet nedá — každý pokus stojí peníze.
 *
 * Falešné OpenAI je proto obyčejný server na localhostu, který si
 * zapíše, **co a jak** mu přišlo, a vrátí platný obrázek. Adresa
 * rozhraní je v nastavení právě kvůli tomuhle.
 *
 * ## Co se měří
 *
 *  1. kreslení od nuly jde jako JSON, dokreslování jako formulář se
 *     souborem — záměna jedné za druhou je ta chyba výš,
 *  2. do formuláře se vstupní obrázek i maska opravdu vloží,
 *  3. průhledné pozadí a rozměr se posílají tak, jak si je uživatel
 *     nastavil,
 *  4. utrácení se připíše jen za povedený obrázek,
 *  5. hláška „neznámý model" poradí, kam sáhnout — rodiny obrázkových
 *     modelů se mění rychleji než aplikace.
 *
 *   node tools/obrazky-test.cjs
 */
const http = require('http');
const path = require('path');
const { DIST, db } = require('./ptrans/harness.cjs');

const png = require(path.join(DIST, 'zkusebna/png.js'));
const { setSetting } = require(path.join(DIST, 'db.js'));
const secure = require(path.join(DIST, 'secure.js'));
/* Šifrování čte nastavení přes líné propojení — v aplikaci ho navazuje
   start, tady se musí navázat ručně, jinak sáhne po systémové klíčence */
secure.connectSecure(
  require(path.join(DIST, 'db.js')).getSetting,
  require(path.join(DIST, 'db.js')).setSetting
);

let failed = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${label}`);
  if (!ok) {
    console.log('      čekáno:', JSON.stringify(want));
    console.log('      dostal:', JSON.stringify(got));
  }
}
function ok(label, podminka, poznamka = '') {
  if (!podminka) failed++;
  console.log(`  ${podminka ? '✓' : '✗'} ${label}${poznamka ? `   ${poznamka}` : ''}`);
}

void db;

/** Malý platný PNG — takový, jaký by vrátilo rozhraní. */
function obrazekBase64(sirka, vyska) {
  const obraz = png.novyObraz(sirka, vyska);
  for (let i = 0; i < obraz.body.length; i += 4) {
    obraz.body[i] = 200; obraz.body[i + 1] = 170; obraz.body[i + 2] = 140; obraz.body[i + 3] = 255;
  }
  return png.uloz(obraz).toString('base64');
}

const prisло = [];
let odpovez = null;

const server = http.createServer((req, res) => {
  /* Tělo se sbírá po bajtech a čte se jako UTF-8: „Muž v obleku" se
     v latin1 rozsype a zkouška by hlídala něco jiného, než co se posílá */
  const kusy = [];
  req.on('data', kus => { kusy.push(kus); });
  req.on('end', () => {
    const telo = Buffer.concat(kusy).toString('utf8');
    prisло.push({
      cesta: req.url,
      typ: String(req.headers['content-type'] || ''),
      klic: String(req.headers.authorization || ''),
      telo
    });
    const vlastni = odpovez;
    odpovez = null;
    if (vlastni) {
      res.writeHead(vlastni.stav, { 'Content-Type': 'application/json' });
      res.end(vlastni.telo);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ b64_json: obrazekBase64(8, 12) }] }));
  });
});

async function main() {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  /* Klíč se ukládá zašifrovaně; v zkoušce se šifruje místním klíčem,
     protože systémová klíčenka mimo aplikaci není */
  setSetting('secureMode', 'local');
  setSetting('openaiApiKey', secure.encrypt('sk-test-123'));
  setSetting('openaiBase', `http://127.0.0.1:${port}/v1`);
  setSetting('obrazkyKvalita', 'high');
  setSetting('obrazkyStrop', '40');
  setSetting('obrazkovyModel', 'gpt-image-2.5-sunburst');

  const obrazky = require(path.join(DIST, 'zkusebna/obrazky.js'));

  console.log('\nkreslení obrázků:\n');

  /* ---------- kreslení od nuly ---------- */

  const postava = await obrazky.nakresli('Muž v obleku', { sirka: 1024, vyska: 1536 });
  const prvni = prisло[0];
  check('kreslení jde na správnou adresu', prvni.cesta, '/v1/images/generations');
  /*
   * Tohle je ta chyba. `/images/generations` bere jen JSON a formulář
   * odmítne dřív, než se na zadání vůbec podívá.
   */
  ok('  a posílá se jako JSON, ne jako formulář',
    prvni.typ.startsWith('application/json') && !/multipart/.test(prvni.typ), prvni.typ);
  const zadani = JSON.parse(prvni.telo);
  check('  s modelem, zadáním, rozměrem a kvalitou',
    [zadani.model, zadani.prompt, zadani.size, zadani.quality, zadani.output_format, zadani.n],
    ['gpt-image-2.5-sunburst', 'Muž v obleku', '1024x1536', 'high', 'png', 1]);
  check('  a s průhledným pozadím', zadani.background, 'transparent');
  check('klíč se posílá v hlavičce', prvni.klic, 'Bearer sk-test-123');
  check('vrácený obrázek se přečte', [postava.sirka, postava.vyska], [8, 12]);

  const bezPrusvitu = await obrazky.nakresli('Pozadí', { sirka: 1024, vyska: 1024 }, false);
  ok('bez průhlednosti se pozadí vůbec neposílá',
    JSON.parse(prisло[1].telo).background === undefined);
  void bezPrusvitu;

  /* ---------- dokreslování ---------- */

  const vstup = png.nacti(Buffer.from(obrazekBase64(16, 24), 'base64'));
  const maska = png.nacti(Buffer.from(obrazekBase64(16, 24), 'base64'));
  await obrazky.dokresli('Obleč sako', vstup, maska);
  const druhy = prisло[prisло.length - 1];
  check('dokreslování jde na adresu pro úpravy', druhy.cesta, '/v1/images/edits');
  /*
   * Tady naopak formulář **být musí** — nese soubory. JSON by je neunesl.
   */
  ok('  a posílá se jako formulář, protože nese soubory',
    /^multipart\/form-data; boundary=/.test(druhy.typ), druhy.typ);
  ok('  ve formuláři je vstupní obrázek i maska',
    druhy.telo.includes('name="image"') && druhy.telo.includes('name="mask"')
    && druhy.telo.includes('filename="postava.png"'));
  ok('  a rozměr se bere ze vstupního obrázku',
    druhy.telo.includes('16x24'), '16x24');
  /*
   * `input_fidelity` se posílá jen modelům, které ho berou. Poslat ho
   * ostatním je chyba rozhraní, ne jen zbytečnost.
   */
  ok('  model, který vstup drží vždy, nedostane input_fidelity',
    !druhy.telo.includes('input_fidelity'));

  setSetting('obrazkovyModel', 'gpt-image-1');
  await obrazky.dokresli('Obleč sako', vstup);
  ok('  a model, který se musí doprošovat, ho dostane',
    prisло[prisло.length - 1].telo.includes('input_fidelity'));
  setSetting('obrazkovyModel', 'gpt-image-2.5-sunburst');

  /* ---------- modely ---------- */

  /*
   * Model, který u OpenAI dosloužil, se tiše přepne na současný. Kdo si
   * ho kdysi vybral v okně, jinak zůstane s nastavením, které vrací
   * „unknown model" — a to vypadá jako porucha aplikace.
   */
  setSetting('obrazkovyModel', 'gpt-image-1.5');
  check('dosloužilý model se přepne na současný', obrazky.model().id, 'gpt-image-2.5-sunburst');
  setSetting('obrazkovyModel', 'muj-vlastni-model');
  check('  ale vlastnoručně zadané jméno zůstane', obrazky.model().id, 'muj-vlastni-model');
  setSetting('obrazkovyModel', 'gpt-image-2.5-sunburst');

  /* ---------- utrácení a chyby ---------- */

  const pred = obrazky.utrata().kusu;
  odpovez = { stav: 400, telo: JSON.stringify({ error: { message: "Unknown model: 'gpt-image-9'" } }) };
  let chyba = '';
  try { await obrazky.nakresli('Zkouška', { sirka: 1024, vyska: 1024 }); }
  catch (e) { chyba = String(e.message); }
  /*
   * Odmítnutí bezpečnostní kontrolou je zadání, ne porucha — a hláška od
   * OpenAI je anglická a končí číslem požadavku, takže z ní nikdo
   * nepozná, co s tím.
   */
  odpovez = {
    stav: 400,
    telo: JSON.stringify({ error: { message: 'Your request was rejected by the safety system. safety_violations=[sexual].' } })
  };
  let bezpecnost = '';
  try { await obrazky.nakresli('Zkouška', { sirka: 1024, vyska: 1024 }); }
  catch (e) { bezpecnost = String(e.message); }
  ok('u odmítnutí bezpečnostní kontrolou se poradí, kde přepsat zadání',
    /bezpečnostní kontrolou/.test(bezpecnost) && /Vizuály/.test(bezpecnost), bezpecnost.slice(-120));

  ok('chyba se vrátí česky a s radou, kam sáhnout',
    /Obrázek se nepodařilo nakreslit/.test(chyba) && /Nastavení/.test(chyba), chyba.slice(0, 120));
  check('  a za nepovedený obrázek se nic nepřipíše', obrazky.utrata().kusu, pred);

  /*
   * Strop je tvrdý: překročit se nedá ani opakováním. Jedno zapomenuté
   * `n: 10` v zadání jinak znamená sto obrázků místo deseti.
   */
  setSetting('obrazkyStrop', '0');
  let strop = '';
  try { await obrazky.nakresli('Zkouška', { sirka: 1024, vyska: 1024 }); }
  catch (e) { strop = String(e.message); }
  ok('přes měsíční strop se nekreslí', /strop/i.test(strop), strop.slice(0, 90));

  server.close();
  console.log(failed ? `\n✗ ${failed} chyb` : '\n✓ kreslení obrázků sedí');
  process.exit(failed ? 1 : 0);
}

main().catch(e => {
  console.log('✗ zkouška spadla:', e?.stack || e);
  server.close();
  process.exit(1);
});
