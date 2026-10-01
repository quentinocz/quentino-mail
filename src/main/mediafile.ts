/**
 * Servírování vlastních videí do okna aplikace.
 *
 * ## Proč to nejde jinak
 *
 * Okno aplikace nemá přístup k disku — a je to tak správně. Video se do
 * něj tedy musí nějak dostat: poslat ho přes IPC jako base64 znamená
 * u padesátimegabajtového souboru sto megabajtů v paměti na každé
 * přetočení, a `<video>` v tom navíc neumí přeskakovat. Prohlížeč ale
 * umí streamovat po částech (hlavička `Range`) — stačí mu dát adresu.
 *
 * Proto vlastní protokol. `net.fetch` nad `file://` zařídí i ty části,
 * takže se v časové ose dá skákat, kam je potřeba, bez čekání.
 *
 * ## Co se smí vydat
 *
 * **Jen soubor, který si uživatel v aplikaci sám vybral.** Kdyby protokol
 * vydal jakoukoli cestu, stačila by jedna chyba v okně (nebo text
 * z internetu vložený do titulku) a šel by přes něj přečíst kterýkoli
 * soubor v počítači — třeba klíč v datech aplikace. Seznam povolených
 * plní modul střihu při výběru souboru.
 */
import { protocol, net } from 'electron';
import { pathToFileURL } from 'url';
import { jePovolen } from './instagram/videoedit';

export const FILE_SCHEME = 'qmedia';

/** Musí se zavolat **před** `app.whenReady()`. */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([{
    scheme: FILE_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      // Bez tohohle prohlížeč v `<video>` neumí přeskakovat: potřebuje
      // vydávat soubor po částech, ne celý naráz
      stream: true,
      corsEnabled: true
    }
  }]);
}

/** Adresa pro okno. Cesta jde v dotazu, ať ji nerozbije lomítko ani diakritika. */
export function mediaUrl(soubor: string): string {
  return `${FILE_SCHEME}://soubor/?p=${encodeURIComponent(soubor)}`;
}

/** Zavolat po `app.whenReady()`. */
export function serveMedia(): void {
  protocol.handle(FILE_SCHEME, request => {
    const soubor = new URL(request.url).searchParams.get('p') ?? '';
    if (!soubor || !jePovolen(soubor)) {
      return new Response('Soubor není povolený.', { status: 403 });
    }
    return net.fetch(pathToFileURL(soubor).toString(), {
      // Hlavičku Range předává Chromium samo; tohle jen dovolí čtení z disku
      bypassCustomProtocolHandlers: true,
      headers: request.headers,
      method: request.method
    });
  });
}
