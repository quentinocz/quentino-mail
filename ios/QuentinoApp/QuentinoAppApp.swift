import SwiftUI

/**
 Vstupní bod aplikace.

 Rozhraní je totéž, které běží na počítači — React sestavený Vitem, tady
 hostovaný ve `WKWebView`. Nativně je napsané všechno, co na desktopu dělal
 Electron: pošta, databáze, soubory, klíčenka. Díky tomu má iPad stejné
 obrazovky i logiku jako Mac a opravy se nepíšou dvakrát.
 */
@main
struct QuentinoAppApp: App {
    @StateObject private var bridge = Bridge()

    var body: some Scene {
        WindowGroup {
            WebHost(bridge: bridge)
                .ignoresSafeArea(.container, edges: .bottom)
                .preferredColorScheme(nil)   // světlý i tmavý režim řídí systém
                .onOpenURL { url in bridge.handleDeepLink(url) }
                .task { Scheduler.shared.start() }
        }
    }
}
