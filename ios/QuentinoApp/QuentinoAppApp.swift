import SwiftUI
import UIKit

/**
 Vstupní bod aplikace.

 Rozhraní je totéž, které běží na počítači — React sestavený Vitem, tady
 hostovaný ve `WKWebView`. Nativně je napsané všechno, co na desktopu dělal
 Electron: pošta, databáze, soubory, klíčenka. Díky tomu má iPad stejné
 obrazovky i logiku jako Mac a opravy se nepíšou dvakrát.
 */
/**
 Delegát kvůli probouzení na pozadí.

 `BGTaskScheduler` chce mít obsluhu zaregistrovanou do konce startu aplikace;
 pozdější registrace skončí výjimkou. V čistém SwiftUI na to není háček, tak
 se sem přidává tenhle jeden.
 */
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        Background.register()
        Notify.requestPermission()
        return true
    }

    /// Odchod na pozadí je poslední chvíle, kdy si jde říct o další probuzení.
    func applicationDidEnterBackground(_ application: UIApplication) {
        Background.schedule()
    }
}

@main
struct QuentinoAppApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var bridge = Bridge()

    var body: some Scene {
        WindowGroup {
            WebHost(bridge: bridge)
                // Rozhraní kreslí přes **celou** obrazovku, i pod stavový
                // řádek. Když se horní bezpečná zóna nechala mimo webview,
                // zůstal nad ní tmavý pruh okna — a `env(safe-area-inset-top)`
                // uvnitř stránky bylo nulové, takže si CSS o odsazení ani
                // nemělo jak říct. Odsazení řeší rozhraní samo přes
                // `--safe-top`, tady se musí jen uvolnit místo.
                .ignoresSafeArea()
                .preferredColorScheme(nil)   // světlý i tmavý režim řídí systém
                .onOpenURL { url in bridge.handleDeepLink(url) }
                .task {
                    Scheduler.shared.start()
                    Background.schedule()
                }
        }
    }
}
