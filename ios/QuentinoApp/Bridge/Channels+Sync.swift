import Foundation
import UniformTypeIdentifiers

/**
 Kanály zálohy a synchronizace.

 Rozhraní volá totéž co na počítači. Rozdíl je jen v tom, odkud se bere
 soubor a složka: místo systémového dialogu Electronu se otevře výběr
 v aplikaci Soubory.
 */
extension Bridge {
    func registerSyncChannels() {
        // MARK: Záloha

        register("config:export") { args in
            let passphrase = args.first as? String ?? ""
            let payload = Backup.export(passphrase: passphrase.isEmpty ? nil : passphrase)
            let data = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted])
            let name = "quentino-app-zaloha-\(String(Formats.iso().prefix(10))).json"
            let file = Files.scratch.appendingPathComponent(name)
            try data.write(to: file, options: .atomic)
            return await MediaPicker.exportFile(file)
        }

        register("config:import") { _ in
            guard let url = await MediaPicker.pickFile(types: [.json]) else { return NSNull() }
            guard let data = try? Data(contentsOf: url),
                  let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                throw BridgeError.message("Soubor se nepodařilo přečíst — je to opravdu záloha Quentino App?")
            }
            // Zamčenou zálohu si odložíme a počkáme, až uživatel doplní heslo
            if Backup.needsPassphrase(parsed) {
                await PendingImport.shared.hold(parsed)
                return ["needPassphrase": true]
            }
            await PendingImport.shared.clear()
            return ["message": try Backup.restore(parsed, passphrase: nil)]
        }

        register("config:importUnlock") { args in
            guard let data = await PendingImport.shared.take() else {
                throw BridgeError.message("Není co odemykat — vyber soubor se zálohou znovu.")
            }
            let passphrase = args.first as? String ?? ""
            // Odvození klíče je schválně pomalé; na hlavním vlákně by aplikace ztuhla
            return ["message": try await Task.detached(priority: .userInitiated) {
                try Backup.restore(data, passphrase: passphrase)
            }.value]
        }

        // MARK: Synchronizace složkou

        register("appsync:get") { _ in AppSync.config() }
        register("appsync:save") { args in AppSync.saveConfig(args.first as? [String: Any] ?? [:]) }
        register("appsync:run") { _ in
            await Task.detached(priority: .utility) { AppSync.run() }.value
        }
        register("appsync:pickFolder") { _ in
            guard let url = await MediaPicker.pickFolder() else { return NSNull() }
            try AppSync.rememberFolder(url)
            return url.path
        }
    }
}

/// Záloha čekající na heslo. Aktér proto, že mezi výběrem souboru a zadáním
/// hesla je celá jedna obrazovka a mezitím může přijít jiné volání.
actor PendingImport {
    static let shared = PendingImport()
    private var data: [String: Any]?

    func hold(_ value: [String: Any]) { data = value }
    func clear() { data = nil }

    func take() -> [String: Any]? {
        let value = data
        data = nil
        return value
    }
}
