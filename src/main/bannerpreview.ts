import { protocol } from 'electron';

/**
 * Stránka pro živý náhled bannerů.
 *
 * ## Proč to nekreslí okno samo
 *
 * Náhled musí běžet na **tomtéž skriptu**, jaký poběží na e-shopu — jinak
 * by ukazoval něco jiného, než co zákazník uvidí, a byl by horší než žádný.
 * Ten skript je ale vložený rovnou do stránky, a takový kód okno aplikace
 * spustit nesmí: má `script-src 'self'`, a to platí i pro rámeček vložený
 * přes `srcdoc`, protože ten dědí pravidla svého rodiče. Výsledkem byl
 * prázdný náhled v aplikaci, zatímco na webu bannery běžely.
 *
 * Povolit v celé aplikaci vkládaný kód kvůli náhledu by bylo drahé
 * rozhodnutí na špatném místě — okno zobrazuje cizí poštu. Stránka náhledu
 * proto dostane **vlastní adresu** (`qbnahled://…`), kterou obsluhuje hlavní
 * proces. Není to adresa aplikace, takže si nese svá vlastní pravidla a
 * skript v ní běží; a protože ji vydává hlavní proces z toho, co sám
 * sestavil, nemůže se do ní dostat nic zvenčí.
 *
 * Rámeček zůstává `sandbox="allow-scripts"`, takže na aplikaci nedosáhne.
 */

export const PREVIEW_SCHEME = 'qbnahled';

/** Poslední vydané stránky. Víc než pár jich najednou v okně nikdy není. */
const pages = new Map<string, string>();
let counter = 0;

/**
 * Uloží stránku a vrátí adresu, kterou si má rámeček načíst.
 *
 * Pořadové číslo v adrese je tam kvůli prohlížeči: beze změny adresy by
 * si rámeček ponechal to, co už jednou načetl, a náhled by se přestal
 * hýbat při psaní.
 */
export function stashPreview(html: string): string {
  counter += 1;
  const key = String(counter);
  pages.set(key, html);
  // Starší se zahazují; drží se jen to, na co se rámeček může ještě zeptat
  for (const old of pages.keys()) {
    if (Number(old) < counter - 3) pages.delete(old);
  }
  return `${PREVIEW_SCHEME}://nahled/${key}`;
}

/**
 * Musí se zavolat **před** `app.whenReady()`.
 *
 * Bez tohohle by se adresa chovala jako `data:` — bez vlastního původu,
 * a tedy zase s pravidly aplikace. `standard` jí dá původ, `secure` svolí
 * k načtení písma z internetu a `supportFetchAPI` k načtení plánu.
 */
export function registerPreviewScheme(): void {
  protocol.registerSchemesAsPrivileged([{
    scheme: PREVIEW_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
  }]);
}

/** Zavolat po `app.whenReady()`. */
export function servePreview(): void {
  protocol.handle(PREVIEW_SCHEME, request => {
    const key = new URL(request.url).pathname.replace(/^\/+/, '');
    const html = pages.get(key);
    if (!html) return new Response('Náhled už neplatí.', { status: 404 });
    return new Response(html, {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
    });
  });
}
