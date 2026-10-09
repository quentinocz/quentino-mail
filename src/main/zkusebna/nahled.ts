import fs from 'fs';
import { protocol, net } from 'electron';
import { ZkVrstva } from '../../shared/zkusebna';
import { kabinaScript } from '../modelscript';
import { Kabina } from './manifest';

/**
 * Stránka pro náhled zkušební kabiny v okně aplikace.
 *
 * ## Proč vlastní adresa
 *
 * Náhled musí běžet na **tomtéž skriptu**, jaký poběží na e-shopu — jinak
 * by ukazoval něco jiného, než co uvidí zákazník, a byl by horší než
 * žádný. Ten skript je ale vložený rovnou do stránky a takový kód okno
 * aplikace spustit nesmí (`script-src 'self'`, a to platí i pro rámeček
 * přes `srcdoc`, který dědí pravidla rodiče). Stejnou cestou jde už
 * náhled bannerů; tohle je její druhé použití, jen s jedním rozdílem:
 * kabina si kromě stránky stahuje ještě **seznam vrstev a obrázky**,
 * takže je obsluhuje tatáž adresa.
 *
 * ## Co se odsud vydá a co ne
 *
 * Jen to, co hlavní proces sám připravil: stránka, seznam, a obrázky
 * vrstev z **výslovného seznamu cest**. Kdokoli by si adresu uhodl,
 * nedostane se k ničemu jinému na disku.
 */

export const KABINA_SCHEME = 'qkbnahled';

interface Nahled {
  html: string;
  data: string;
  soubory: Map<string, string>;
}

const stranky = new Map<string, Nahled>();
let pocitadlo = 0;

/** Musí se zavolat **před** `app.whenReady()`. */
export function registerKabinaScheme(): void {
  protocol.registerSchemesAsPrivileged([{
    scheme: KABINA_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
  }]);
}

export function serveKabina(): void {
  protocol.handle(KABINA_SCHEME, async request => {
    const url = new URL(request.url);
    const casti = url.pathname.replace(/^\/+/, '').split('/');
    const klic = casti[0] ?? '';
    const nahled = stranky.get(klic);
    if (!nahled) return new Response('Náhled už neplatí.', { status: 404 });

    if (casti.length === 1 || casti[1] === 'index.html') {
      return new Response(nahled.html, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
      });
    }
    if (casti[1] === 'data.json') {
      return new Response(nahled.data, {
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
      });
    }
    if (casti[1] === 'vrstva') {
      const soubor = nahled.soubory.get(casti.slice(2).join('/'));
      if (!soubor || !fs.existsSync(soubor)) return new Response('Vrstva není.', { status: 404 });
      return net.fetch(`file://${soubor}`);
    }
    return new Response('Nenalezeno.', { status: 404 });
  });
}

/** Jméno, pod kterým vrstva v náhledu vystupuje. */
export function jmenoVrstvy(v: ZkVrstva): string {
  return `${v.postava}/${v.typ}-${v.varianta}.png`;
}

/**
 * Uloží náhled a vrátí adresu pro rámeček.
 *
 * Pořadové číslo v adrese je kvůli prohlížeči: beze změny adresy by si
 * rámeček nechal to, co už jednou načetl, a náhled by se přestal měnit.
 */
export function stashKabinu(
  postav: (klic: string) => Kabina,
  vrstvy: ZkVrstva[],
  kontakt: { text: string; telefon: string; mail: string }
): { url: string; data: Kabina } {
  pocitadlo += 1;
  const klic = String(pocitadlo);
  /*
   * Seznam se staví **až se známým klíčem**: adresy vrstev ho v sobě
   * nesou. Dřív se seznam stavěl dopředu se značkou v adrese a pak se
   * ukládal podruhé, aby se značka nahradila — tedy dvakrát tatáž práce
   * jen kvůli pořadí dvou řádků.
   */
  const data = postav(klic);
  const soubory = new Map<string, string>();
  for (const v of vrstvy) {
    if (v.soubor) soubory.set(jmenoVrstvy(v), v.soubor);
  }
  const skript = kabinaScript({ zdroj: `${KABINA_SCHEME}://nahled/${klic}/data.json`, ttl: 30, kontakt });
  const html = stranka(skript);
  stranky.set(klic, { html, data: JSON.stringify(data), soubory });
  for (const stary of stranky.keys()) {
    if (Number(stary) < pocitadlo - 3) stranky.delete(stary);
  }
  return { url: `${KABINA_SCHEME}://nahled/${klic}`, data };
}

/**
 * Stránka kolem skriptu.
 *
 * Schválně **chudá**: zastupuje libovolnou stránku e-shopu, na které se
 * kabina otevírá. Kdyby si náhled kreslil vlastní rámeček a vlastní
 * písma, posuzovalo by se něco jiného, než co zákazník uvidí.
 */
function stranka(skript: string): string {
  return `<!doctype html>
<html lang="cs">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Zkušební kabina — náhled</title>
<style>
  body { margin: 0; font: 14px/1.5 system-ui, -apple-system, 'Segoe UI', sans-serif;
         background: #fff; color: #18181b; }
  .stranka { padding: 22px; }
  .vzor { max-width: 760px; }
  .vzor h1 { font-size: 20px; margin: 0 0 6px; }
  .vzor p { color: #52525b; margin: 0 0 16px; }
  .otevri { border: 1px solid #18181b; background: #18181b; color: #fff;
            border-radius: 9px; padding: 9px 16px; font-size: 14px; cursor: pointer; }
</style>
</head>
<body>
  <div class="stranka">
    <div class="vzor">
      <h1>Stránka e-shopu</h1>
      <p>Tohle zastupuje libovolnou stránku na quentino.cz. Kabina se otevírá tlačítkem,
         které se dá dát k produktu, do kategorie i do patičky.</p>
      <button class="otevri" data-quentino-kabina type="button">Vyzkoušet na modelu</button>
    </div>
  </div>
${skript}
<script>
  /* V náhledu se kabina otevře rovnou — proklikávat se k ní pokaždé je zdržení */
  window.addEventListener('load', function () {
    if (window.quentinoKabina) window.quentinoKabina.otevri(null);
  });
</script>
</body>
</html>`;
}
