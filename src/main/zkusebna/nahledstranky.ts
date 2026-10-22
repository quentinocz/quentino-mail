import { ZkProdukt } from '../../shared/zkusebna';
import { kabinaLoader } from '../kabina/loader';

/**
 * Stránky, které v náhledu zastupují e-shop.
 *
 * ## Proč nejsou prázdné
 *
 * Kabina se na quentino.cz neotevírá tlačítkem, které bychom tam dali
 * sami — otevírá se tlačítkem, které si do **cizí šablony** vloží
 * zavaděč. Náhled s jedním tlačítkem uprostřed prázdné stránky by tedy
 * nezkoušel to jediné, co se dá rozbít změnou šablony: že se tlačítko
 * má kam vložit.
 *
 * Proto jsou tu výpis produktů i detail se **stejnými názvy tříd, jaké
 * má quentino.cz** (`article.card-item` s `data-product-id`,
 * `a.p-i-media`, `form#frm-productForm` se skrytým `product_id`) a
 * formulář košíku, který odpovídá tomu skutečnému. V náhledu jde tím
 * pádem proklikat celá cesta od výpisu po vložení do košíku.
 *
 * ## Proč je to mimo obsluhu adres
 *
 * Aby se to dalo zkoušet bez Electronu. Obsluha adres se bez něj
 * nespustí, kdežto stránky jsou čistý text — a chyba ve stránce, kterou
 * nikdo nezkouší, se pozná až v otevřeném okně.
 */

export interface NahledProdukt {
  kod: string;
  cesta: string;
  nazev: string;
  cena: string;
  obrazek: string;
  /** Číslo produktu v e-shopu. V náhledu vymyšlené, ale tvarem stejné. */
  cislo: string;
  velikosti: { kod: string; popis: string; skladem: boolean }[];
}

export interface NahledKosik {
  cislo: string;
  optionSet: string;
  pocet: number;
}

/**
 * Cesta, pod kterou produkt v náhledu vystupuje.
 *
 * Zachovává se slug z e-shopu, protože kabina produkt poznává **podle
 * cesty v adrese** — tím se v náhledu zkouší i tohle hledání.
 */
export function cestaProduktu(p: Pick<ZkProdukt, 'kod' | 'url'>): string {
  const slug = String(p.url || '').replace(/[?#].*$/, '').split('/').filter(Boolean).pop();
  return `/p/${slug || p.kod.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

/**
 * Hodnota pole z odeslaného formuláře.
 *
 * Prázdné pole se musí přečíst jako prázdné. „Co je na dalším řádku" je
 * u prázdné hodnoty hranice formuláře, takže by u produktu bez velikostí
 * vyšla jako velikost ------WebKitFormBoundary… a náhled by tvrdil, že
 * je všechno v pořádku.
 */
export function poleFormulare(telo: string, jmeno: string): string {
  const m = new RegExp(`name="${jmeno}"\\r?\\n\\r?\\n([\\s\\S]*?)\\r?\\n--`).exec(telo);
  return m ? m[1].trim() : '';
}

function hlavaStranky(klic: string, titulek: string): string {
  return `<!doctype html>
<html lang="cs">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${titulek}</title>
<style>
  :root { color-scheme: light }
  body { margin: 0; font: 14px/1.5 system-ui, -apple-system, 'Segoe UI', sans-serif;
         background: #fff; color: #18181b; }
  header { display: flex; align-items: center; gap: 14px; padding: 12px 18px;
           border-bottom: 1px solid #e8e8eb; }
  header b { font-size: 16px; }
  header a { color: #18181b; text-decoration: none; }
  main { padding: 18px; }
  h1 { font-size: 20px; margin: 0 0 10px; }
  .products { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
              gap: 14px; margin-top: 14px; }
  .card-item { display: flex; flex-direction: column; border: 1px solid #e8e8eb;
               border-radius: 12px; padding: 10px; background: #fff; }
  .p-i-media { display: block; }
  .p-i-media img { width: 100%; height: 150px; object-fit: contain; background: #f7f7f8;
                   border-radius: 8px; }
  .p-i-header { font-size: 14px; margin: 8px 0 4px; }
  .p-i-header a { color: #18181b; text-decoration: none; }
  .price-main { font-size: 15px; font-weight: 700; }
  .btn-to-cart { margin-top: 8px; border: 1px solid #18181b; background: #18181b; color: #fff;
                 border-radius: 9px; padding: 9px 12px; cursor: pointer; text-align: center;
                 text-decoration: none; display: block; }
  .pd-tocart { max-width: 420px; border: 1px solid #e8e8eb; border-radius: 12px; padding: 14px; }
  .pd-add-to-cart { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .AddToCartButton { border: 0; background: #18181b; color: #fff; border-radius: 9px;
                     padding: 11px 16px; cursor: pointer; font-size: 15px; }
  .zprava { margin: 0 0 14px; color: #52525b; }
</style>
</head>
<body>
  <header>
    <b><a href="/${klic}">Quentino — náhled</a></b>
    <a href="/${klic}/kosik">Košík</a>
    <span class="zprava" style="margin:0">náhled e-shopu, nikam se neodesílá</span>
  </header>
`;
}

/**
 * Patička se zavaděčem.
 *
 * Zavaděč se v náhledu vkládá **stejně jako do šablony e-shopu** — tedy
 * jako kus kódu rovnou ve stránce. Kabina samotná se dotahuje zvlášť,
 * takže se v náhledu zkouší i to rozdělení.
 */
function sZavadecem(klic: string): string {
  return `${kabinaLoader({ skript: `/${klic}/kabina.js` })}
</body>
</html>`;
}

export function kartaProduktu(klic: string, p: NahledProdukt): string {
  return `      <article class="card card-item tile p-i" data-product-id="${p.cislo}" data-href="/${klic}${p.cesta}">
        <a href="/${klic}${p.cesta}" class="p-i-media mb-3">
          <picture class="p-i-media-one"><img src="${p.obrazek}" alt="" loading="lazy"></picture>
        </a>
        <h4 class="p-i-header"><a href="/${klic}${p.cesta}">${p.nazev}</a></h4>
        <div class="p-i-price"><strong class="price-main">${p.cena}</strong></div>
        <a href="#" class="btn btn-to-cart AddProductToCart" title="Do košíku">Do košíku</a>
      </article>`;
}

export function vypisStranka(klic: string, vsechny: NahledProdukt[]): string {
  const karty = vsechny.slice(0, 12).map(p => kartaProduktu(klic, p)).join('\n');
  return `${hlavaStranky(klic, 'Výpis produktů — náhled')}
  <main>
    <h1>Doplňky</h1>
    <p class="zprava">Tohle zastupuje výpis produktů na quentino.cz. Zavaděč sem sám přidal
       decentní tlačítko nad obrázek každé karty — ukáže se, když na kartu najedete.</p>
    <div class="products">
${karty}
    </div>
  </main>
${sZavadecem(klic)}`;
}

export function detailStranka(klic: string, p: NahledProdukt, vsechny: NahledProdukt[]): string {
  const vyber = p.velikosti.length > 1
    ? `          <select name="option_set_id" id="frmproductForm-option_set_id">
${p.velikosti.map((v, i) => `            <option value="${2000 + i}">${v.popis}</option>`).join('\n')}
          </select>`
    : `          <input type="hidden" name="option_set_id" value="">`;
  const souvisejici = vsechny
    .filter(one => one.kod !== p.kod)
    .slice(0, 4)
    .map(one => kartaProduktu(klic, one))
    .join('\n');
  return `${hlavaStranky(klic, `${p.nazev} — náhled`)}
  <main>
    <h1>${p.nazev}</h1>
    <p class="zprava">Detail produktu. Zavaděč přidal tlačítko „Vyzkoušet na modelu" pod to
       vaše do košíku — a formulář níž je tentýž, jakým kabina vkládá do košíku.</p>
    <form action="/${klic}${p.cesta}?do=productForm-submit" method="post" id="frm-productForm" class="pd-tocart">
      <div id="snippet--pricesAjax1" class="pd-prices"><strong class="price-main">${p.cena}</strong></div>
      <div id="snippet--toCartAjax" class="pd-order-buttons">
        <div class="pd-add-to-cart">
          <input type="text" class="spinner" name="quantity" value="1" aria-label="Množství">
${vyber}
          <div class="AddToCart">
            <button type="button" class="btn button-to-cart AddToCartButton">Do košíku</button>
          </div>
        </div>
      </div>
      <div style="display:none">
        <input type="hidden" name="product_id" id="frmproductForm-product_id" value="${p.cislo}">
      </div>
    </form>
    <h1 style="margin-top:28px">Hodí se k tomu</h1>
    <div class="products" id="snippet--relatedProducts">
${souvisejici}
    </div>
  </main>
${sZavadecem(klic)}`;
}

/**
 * Košík náhledu — co kabina opravdu odeslala.
 *
 * Bez něj by se o vložení do košíku dalo jen doufat: skript ohlásí
 * „v košíku", a jestli dorazilo to, co si zákazník vybral — a hlavně
 * **ta velikost, kterou vybral** — se pozná až tady.
 */
export function kosikStranka(klic: string, kosik: NahledKosik[], vsechny: NahledProdukt[]): string {
  const radky = kosik.map(one => {
    const produkt = vsechny.find(p => p.cislo === one.cislo);
    const velikost = one.optionSet
      ? (produkt?.velikosti[Number(one.optionSet) - 2000]?.popis ?? one.optionSet)
      : '';
    return `      <li data-cislo="${one.cislo}" data-option="${one.optionSet}">
        ${produkt ? produkt.nazev : one.cislo}${velikost ? ` — ${velikost}` : ''} · ${one.pocet} ks
      </li>`;
  }).join('\n');
  return `${hlavaStranky(klic, 'Košík — náhled')}
  <main>
    <h1>Košík</h1>
    <p class="zprava">Tohle do něj poslala kabina.</p>
    <ul id="kosik">
${radky || '      <li>Prázdný.</li>'}
    </ul>
  </main>
${sZavadecem(klic)}`;
}
