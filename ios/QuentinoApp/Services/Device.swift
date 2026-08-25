import Foundation
#if canImport(UIKit)
import UIKit
#endif

/**
 Trvalá totožnost zařízení.

 Synchronizace přes sdílenou složku má jednu past: když do jednoho souboru
 zapisují všechna zařízení, cloud při souběžném zápisu jednu verzi zahodí
 (nebo z ní udělá „konfliktní kopii", které si nikdo nevšimne) a s ní i
 změny, které měl jen ten jeden. Řešení je, aby **každé zařízení psalo do
 vlastního souboru** a ostatní jen četlo — pak nemá co koho přepsat.

 K tomu je potřeba stálé jméno zařízení. Vygeneruje se jednou a od té chvíle
 se nemění; do zálohy nepatří, protože po obnovení na druhém přístroji by
 obě zařízení tvrdila, že jsou totéž, a psala by si do stejného souboru.
 */
enum Device {
    private static let idKey = "deviceId"
    private static let nameKey = "deviceName"

    static func id() -> String {
        if let stored = Store.setting(idKey), !stored.isEmpty { return stored }
        let fresh = UUID().uuidString
        Store.setSetting(idKey, fresh)
        return fresh
    }

    /// Jméno pro člověka — do hlášek typu „kód vydal iPhone".
    static func name() -> String {
        if let stored = Store.setting(nameKey), !stored.isEmpty { return stored }
        #if canImport(UIKit)
        let fresh = UIDevice.current.name
        #else
        let fresh = ProcessInfo.processInfo.hostName.replacingOccurrences(of: ".local", with: "")
        #endif
        let clean = fresh.isEmpty ? "Tohle zařízení" : fresh
        Store.setSetting(nameKey, clean)
        return clean
    }

    static func setName(_ value: String) -> String {
        let clean = String(value.trimmingCharacters(in: .whitespacesAndNewlines).prefix(60))
        if !clean.isEmpty { Store.setSetting(nameKey, clean) }
        return name()
    }

    /// Jméno v souboru: `id` je jednoznačné, název je jen pro čitelnost.
    static func label() -> String {
        "\(name()) (\(id().prefix(8)))"
    }
}
