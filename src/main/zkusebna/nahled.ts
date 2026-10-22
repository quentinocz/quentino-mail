import fs from 'fs';
import { protocol, net } from 'electron';
import { ZkProdukt, ZkVrstva } from '../../shared/zkusebna';
import { kabinaScript } from '../kabina/script';
import { Kabina } from './manifest';
import {
  NahledKosik, NahledProdukt, cestaProduktu, detailStranka, kosikStranka, poleFormulare, vypisStranka
} from './nahledstranky';

/**
 * Náhled zkušební kabiny v okně aplikace — a to včetně e-shopu kolem ní.
 *
 * ## Proč vlastní adresa
 *
 * Náhled musí běžet na **tomtéž skriptu**, jaký poběží na e-shopu — jinak
 * by ukazoval něco jiného, než co uvidí zákazník, a byl by horší než
 * žádný. Ten skript ale okno aplikace spustit nesmí (`script-src 'self'`,
 * a to platí i pro rámeček přes `srcdoc`, který dědí pravidla rodiče).
 * Stejnou cestou jde už náhled bannerů; tohle je její druhé použití.
 *
 * ## Proč se tu předstírá celý e-shop
 *
 * Kabina se na e-shopu neotevírá tlačítkem, které bychom tam dali sami.
 * Otevírá se **tlačítkem, které si do cizí šablony vloží zavaděč** —
 * vedle „do košíku" na detailu a decentně nad obrázkem ve výpisu. Kdyby
 * náhled byl prázdná stránka s jedním tlačítkem, nezkoušelo by se to
 * jediné, co se dá rozbít změnou šablony: že se tlačítko vůbec má kam
 * vložit.
 *
 * Proto se tady vydává výpis produktů i detail produktu **se stejnými
 * názvy tříd, jaké má quentino.cz** (`article.card-item`, `a.p-i-media`,
 * `form#frm-productForm`, skryté `product_id`), a formulář košíku
 * opravdu odpovídá. V náhledu jde tedy proklikat celá cesta od výpisu až
 * po vložení do košíku — a je to tatáž cesta, jakou projde zákazník.
 */

export const KABINA_SCHEME = 'qkbnahled';

interface Nahled {
  html: string;
  skript: string;
  data: string;
  soubory: Map<string, string>;
  produkty: NahledProdukt[];
  /** Co se v náhledu „vložilo do košíku". */
  kosik: NahledKosik[];
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

    /* Vložení do košíku — tentýž formulář, jaký odesílá kabina na e-shopu */
    if (request.method === 'POST' && url.searchParams.get('do') === 'productForm-submit') {
      const telo = await request.text().catch(() => '');
      nahled.kosik.push({
        cislo: poleFormulare(telo, 'product_id'),
        optionSet: poleFormulare(telo, 'option_set_id'),
        pocet: Number(poleFormulare(telo, 'quantity')) || 1
      });
      return new Response(JSON.stringify({ ok: true, kusu: nahled.kosik.length }), {
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
      });
    }

    if (casti.length === 1 || casti[1] === 'index.html') {
      return new Response(nahled.html, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
      });
    }
    if (casti[1] === 'kabina.js') {
      return new Response(nahled.skript, {
        headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' }
      });
    }
    if (casti[1] === 'data.json') {
      return new Response(nahled.data, {
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
      });
    }
    if (casti[1] === 'kosik') {
      return new Response(kosikStranka(klic, nahled.kosik, nahled.produkty), {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
      });
    }
    if (casti[1] === 'p') {
      const hledana = `/${casti.slice(1).join('/')}`;
      const produkt = nahled.produkty.find(one => one.cesta === hledana);
      if (!produkt) return new Response('Produkt není.', { status: 404 });
      return new Response(detailStranka(klic, produkt, nahled.produkty), {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
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
  postav: (klic: string, url: (p: ZkProdukt) => string) => Kabina,
  vrstvy: ZkVrstva[]
): { url: string; data: Kabina } {
  pocitadlo += 1;
  const klic = String(pocitadlo);
  /*
   * Seznam se staví **až se známým klíčem**: adresy vrstev i produktů ho
   * v sobě nesou. Dřív se seznam stavěl dopředu se značkou v adrese a
   * pak se ukládal podruhé, aby se značka nahradila — tedy dvakrát tatáž
   * práce jen kvůli pořadí dvou řádků.
   */
  const data = postav(klic, p => `/${klic}${cestaProduktu(p)}`);
  const soubory = new Map<string, string>();
  for (const v of vrstvy) {
    if (v.soubor) soubory.set(jmenoVrstvy(v), v.soubor);
  }
  /* Čísla produktů jsou v náhledu vymyšlená, ale stabilní — kabina si je
     mezi stránkami pamatuje a na nestálých by to nešlo zkoušet */
  const produkty: NahledProdukt[] = data.produkty.map((p, i) => ({
    kod: p.kod,
    cesta: cestaProduktu(p),
    nazev: p.nazev,
    cena: p.cena,
    obrazek: p.obrazek,
    cislo: String(1000 + i),
    velikosti: p.velikostiSeznam ?? []
  }));
  const nahled: Nahled = {
    html: '',
    skript: kabinaScript({ zdroj: `/${klic}/data.json`, ttl: 30 }),
    data: JSON.stringify(data),
    soubory,
    produkty,
    kosik: []
  };
  nahled.html = vypisStranka(klic, produkty);
  stranky.set(klic, nahled);
  for (const stary of stranky.keys()) {
    if (Number(stary) < pocitadlo - 3) stranky.delete(stary);
  }
  return { url: `${KABINA_SCHEME}://nahled/${klic}`, data };
}

/** Co se v náhledu vložilo do košíku — pro zkoušky. */
export function kosikNahledu(klic: string): { cislo: string; optionSet: string; pocet: number }[] {
  return stranky.get(klic)?.kosik ?? [];
}
