import Foundation

/**
 Synchronizace mezi zařízeními přes sdílenou složku.

 Na počítači to je složka v Dropboxu nebo na disku, tady se vybere složka
 v aplikaci Soubory — typicky iCloud Drive. Přístup k ní přežije restart
 díky záložce (`bookmark`), kterou iOS vydá při výběru; bez ní by aplikace
 po zavření ke složce už nesměla.

 Nesynchronizuje se živá databáze, ale tři soubory se stejným tvarem jako na
 počítači:

 - `state.json` — nastavení, znalosti, osoby; vyhrává novější razítko
 - `contacts.json` — našeptávač adres, slučuje se sjednocením
 - `vouchers.json` — šablony a kódy poukazů, slučuje se po řádcích

 Hesla účtů a API klíče se ze zásady nesynchronizují — na to je záloha.
 */
enum AppSync {
    static func config() -> [String: Any] {
        [
            "folder": Store.setting("syncFolder").flatMap { $0.isEmpty ? nil : $0 } ?? NSNull(),
            "enabled": Store.bool("syncEnabled", false),
            "lastRun": Store.setting("syncLastRun").flatMap { $0.isEmpty ? nil : $0 } ?? NSNull(),
            "lastResult": Store.setting("syncLastResult").flatMap { $0.isEmpty ? nil : $0 } ?? NSNull()
        ]
    }

    static func saveConfig(_ patch: [String: Any]) -> [String: Any] {
        if patch["folder"] is NSNull {
            Store.setSetting("syncFolder", "")
            Store.setSetting("syncFolderBookmark", "")
        } else if let folder = patch["folder"] as? String {
            Store.setSetting("syncFolder", folder)
        }
        if let enabled = patch["enabled"] as? Bool { Store.setSetting("syncEnabled", enabled ? "1" : "0") }
        if (Store.setting("stateStamp") ?? "").isEmpty { Store.setSetting("stateStamp", Formats.iso()) }
        return config()
    }

    /// Uloží vybranou složku i s oprávněním, které přežije restart aplikace.
    static func rememberFolder(_ url: URL) throws {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let bookmark = try url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
        Store.setSetting("syncFolderBookmark", bookmark.base64EncodedString())
        Store.setSetting("syncFolder", url.path)
    }

    /// Složka i s otevřeným přístupem; volající musí zavolat `stop`.
    private static func openFolder() -> (url: URL, stop: () -> Void)? {
        guard let base64 = Store.setting("syncFolderBookmark"), !base64.isEmpty,
              let data = Data(base64Encoded: base64) else { return nil }
        var stale = false
        guard let url = try? URL(resolvingBookmarkData: data, options: [], relativeTo: nil,
                                 bookmarkDataIsStale: &stale) else { return nil }
        if stale, let fresh = try? url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil) {
            Store.setSetting("syncFolderBookmark", fresh.base64EncodedString())
        }
        let scoped = url.startAccessingSecurityScopedResource()
        return (url, { if scoped { url.stopAccessingSecurityScopedResource() } })
    }

    // MARK: - Běh

    private static var running = false

    @discardableResult
    static func run() -> String {
        guard Store.bool("syncEnabled", false) else { return "Synchronizace není zapnutá." }
        guard !running else { return "Synchronizace už běží." }
        guard let folder = openFolder() else {
            return "Synchronizační složka není dostupná — vyber ji znovu."
        }
        running = true
        defer { running = false; folder.stop() }

        var parts: [String] = []
        do {
            // 1) Stav — novější vyhrává
            let localStamp = Store.setting("stateStamp", "1970-01-01T00:00:00Z") ?? "1970-01-01T00:00:00Z"
            let remote = readJson(folder.url.appendingPathComponent("state.json")) as? [String: Any]
            let remoteStamp = remote?["updatedAt"] as? String ?? ""

            if (remote?["app"] as? String) == "quentino-mail-sync", remoteStamp > localStamp {
                applyState(folder.url, remote ?? [:])
                parts.append("nastavení přijato")
                Bridge.notify("folders:changed")
            } else if remote == nil || localStamp > remoteStamp {
                try writeState(folder.url, stamp: localStamp)
                parts.append("nastavení odesláno")
            }

            // 2) Kontakty — sjednocení
            syncContacts(folder.url)

            // 3) Poukazy — šablony i odepsané kódy, po řádcích
            syncVouchers(folder.url)

            let summary = parts.isEmpty ? "vše aktuální" : parts.joined(separator: ", ")
            Store.setSetting("syncLastRun", Formats.iso())
            Store.setSetting("syncLastResult", summary)
            Bridge.notify("ig:changed")
            return summary
        } catch {
            let message = "chyba: \(error.readableMessage)"
            Store.setSetting("syncLastResult", message)
            return message
        }
    }

    // MARK: - Stav

    private static func writeState(_ folder: URL, stamp: String) throws {
        var settings = Settings.current()
        settings["hasApiKey"] = nil
        settings["defaultPersonId"] = nil

        let mediaDir = folder.appendingPathComponent("media", isDirectory: true)
        var persons: [[String: Any]] = []
        let all = Settings.persons()
        for person in all {
            var photoFile: Any = NSNull()
            if let path = person["photoPath"] as? String, !path.isEmpty,
               FileManager.default.fileExists(atPath: path) {
                let name = "\(stableHash(person["name"] as? String ?? ""))-\(sanitize((path as NSString).lastPathComponent))"
                let destination = mediaDir.appendingPathComponent(name)
                if !FileManager.default.fileExists(atPath: destination.path) {
                    try? FileManager.default.createDirectory(at: mediaDir, withIntermediateDirectories: true)
                    try? FileManager.default.copyItem(at: URL(fileURLWithPath: path), to: destination)
                }
                photoFile = name
            }
            persons.append([
                "name": person["name"] ?? "",
                "positions": person["positions"] ?? [:],
                "displayNames": person["displayNames"] ?? [:],
                "photoFile": photoFile
            ])
        }

        let defaultId = Int(Store.setting("defaultPersonId", "0") ?? "0") ?? 0
        let defaultName = all.first { ($0["id"] as? Int) == defaultId }?["name"] as? String

        let state: [String: Any] = [
            "app": "quentino-mail-sync",
            "version": 1,
            "updatedAt": stamp,
            "settings": settings,
            "defaultPersonName": defaultName ?? NSNull(),
            "knowledge": Settings.knowledge().map {
                ["title": $0["title"] ?? "", "content": $0["content"] ?? ""]
            },
            "persons": persons
        ]
        try writeJson(state, to: folder.appendingPathComponent("state.json"))
    }

    private static func applyState(_ folder: URL, _ remote: [String: Any]) {
        var settings = remote["settings"] as? [String: Any] ?? [:]
        settings["hasApiKey"] = nil
        settings["anthropicApiKey"] = nil
        settings["defaultPersonId"] = nil
        Settings.save(settings)

        // Znalosti — kompletní náhrada novějším stavem
        if let knowledge = remote["knowledge"] as? [[String: Any]] {
            try? SQLite.shared.run("DELETE FROM knowledge")
            for item in knowledge {
                guard let title = item["title"] as? String, !title.isEmpty else { continue }
                try? SQLite.shared.run("INSERT INTO knowledge (title, content) VALUES (?,?)",
                                       [.text(title), .text(item["content"] as? String ?? "")])
            }
        }

        // Osoby — kompletní náhrada, fotky ze složky media
        if let persons = remote["persons"] as? [[String: Any]] {
            try? SQLite.shared.run("DELETE FROM persons")
            for person in persons {
                guard let name = person["name"] as? String, !name.isEmpty else { continue }
                var photoPath: String?
                if let file = person["photoFile"] as? String, !file.isEmpty {
                    let source = folder.appendingPathComponent("media").appendingPathComponent(file)
                    let target = Files.scratch.appendingPathComponent(file)
                    if FileManager.default.fileExists(atPath: source.path) {
                        if !FileManager.default.fileExists(atPath: target.path) {
                            try? FileManager.default.copyItem(at: source, to: target)
                        }
                        photoPath = target.path
                    }
                }
                let positions = person["positions"] as? [String: String] ?? [:]
                let display = person["displayNames"] as? [String: String] ?? [:]
                try? SQLite.shared.run(
                    """
                    INSERT INTO persons (name, position, position_cz, position_sk, position_en,
                      display_cz, display_sk, display_en, photo_path)
                    VALUES (?,?,?,?,?,?,?,?,?)
                    """,
                    [
                        .text(name), .text(positions["cz"] ?? ""),
                        .text(positions["cz"] ?? ""), .text(positions["sk"] ?? ""), .text(positions["en"] ?? ""),
                        .text(display["cz"] ?? ""), .text(display["sk"] ?? ""), .text(display["en"] ?? ""),
                        photoPath.map { SQLite.Value.text($0) } ?? .null
                    ]
                )
            }
            // Výchozí osoba podle jména — ID se mezi zařízeními liší
            if let wanted = remote["defaultPersonName"] as? String {
                let match = Settings.persons().first { ($0["name"] as? String) == wanted }
                Store.setSetting("defaultPersonId", String(match?["id"] as? Int ?? 0))
            }
        }

        // Razítko srovnat s přijatým stavem — Settings.save ho posunul na „teď"
        Store.setSetting("stateStamp", remote["updatedAt"] as? String ?? Formats.iso())
    }

    // MARK: - Kontakty

    private static func syncContacts(_ folder: URL) {
        let file = folder.appendingPathComponent("contacts.json")
        if let remote = readJson(file) as? [[String: Any]] {
            for contact in remote {
                guard let email = (contact["email"] as? String)?.lowercased(), !email.isEmpty else { continue }
                try? SQLite.shared.run(
                    """
                    INSERT INTO contacts (email, name, uses, last_used) VALUES (?,?,?,?)
                    ON CONFLICT(email) DO UPDATE SET
                      uses = MAX(contacts.uses, excluded.uses),
                      last_used = MAX(contacts.last_used, excluded.last_used),
                      name = CASE WHEN contacts.name = '' THEN excluded.name ELSE contacts.name END
                    """,
                    [
                        .text(email), .text(contact["name"] as? String ?? ""),
                        .int(Int64(contact["uses"] as? Int ?? 1)),
                        .text(contact["last_used"] as? String ?? Formats.iso())
                    ]
                )
            }
        }
        let all = (try? SQLite.shared.query("SELECT email, name, uses, last_used FROM contacts")) ?? []
        try? writeJson(all, to: file)
    }

    // MARK: - Poukazy

    /**
     Šablony a kódy se neslučují jako „novější stav vyhrává", ale po řádcích:
     u šablony vyhrává novější `updated_at` (i smazání, to je jen příznak),
     u kódu vyhrává použití a platí dřívější čas. Kdyby se přenášel celý stav
     najednou, dvě zařízení by si navzájem přepsala odepsané kódy a stejný kód
     by šel ven dvakrát.
     */
    private static func syncVouchers(_ folder: URL) {
        let file = folder.appendingPathComponent("vouchers.json")
        let remote = readJson(file) as? [String: Any]

        for template in remote?["templates"] as? [[String: Any]] ?? [] {
            guard let id = template["id"] as? String, let name = template["name"] as? String,
                  !id.isEmpty, !name.isEmpty else { continue }
            try? SQLite.shared.run(
                """
                INSERT INTO voucher_templates (id, name, value, unit, valid_until, note, lang,
                  code_mode, fixed_code, archived, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(id) DO UPDATE SET
                  name = excluded.name, value = excluded.value, unit = excluded.unit,
                  valid_until = excluded.valid_until, note = excluded.note, lang = excluded.lang,
                  code_mode = excluded.code_mode, fixed_code = excluded.fixed_code,
                  archived = excluded.archived, updated_at = excluded.updated_at
                WHERE excluded.updated_at > voucher_templates.updated_at
                """,
                [
                    .text(id), .text(name), .text(template["value"] as? String ?? ""),
                    .text(template["unit"] as? String ?? "CZK"),
                    .text(template["valid_until"] as? String ?? ""),
                    .text(template["note"] as? String ?? ""),
                    .text(template["lang"] as? String ?? "cz"),
                    .text(template["code_mode"] as? String ?? "fixed"),
                    .text(template["fixed_code"] as? String ?? ""),
                    .int(Int64(template["archived"] as? Int ?? 0)),
                    .text(template["updated_at"] as? String ?? Formats.iso())
                ]
            )
        }

        for code in remote?["codes"] as? [[String: Any]] ?? [] {
            guard let templateId = code["template_id"] as? String, let value = code["code"] as? String,
                  !templateId.isEmpty, !value.isEmpty else { continue }
            try? SQLite.shared.run(
                """
                INSERT INTO voucher_codes (template_id, code, used_at, used_for, created_at)
                VALUES (?,?,?,?,?)
                ON CONFLICT(template_id, code) DO UPDATE SET
                  used_at = CASE
                    WHEN voucher_codes.used_at IS NULL THEN excluded.used_at
                    WHEN excluded.used_at IS NULL THEN voucher_codes.used_at
                    WHEN excluded.used_at < voucher_codes.used_at THEN excluded.used_at
                    ELSE voucher_codes.used_at
                  END,
                  used_for = CASE
                    WHEN excluded.used_at IS NOT NULL
                         AND (voucher_codes.used_at IS NULL OR excluded.used_at < voucher_codes.used_at)
                      THEN excluded.used_for
                    ELSE voucher_codes.used_for
                  END
                """,
                [
                    .text(templateId), .text(value),
                    (code["used_at"] as? String).map { SQLite.Value.text($0) } ?? .null,
                    .text(code["used_for"] as? String ?? ""),
                    .text(code["created_at"] as? String ?? Formats.iso())
                ]
            )
        }

        let out: [String: Any] = [
            "templates": (try? SQLite.shared.query("SELECT * FROM voucher_templates")) ?? [],
            "codes": (try? SQLite.shared.query("SELECT * FROM voucher_codes")) ?? []
        ]
        try? writeJson(out, to: file)
    }

    // MARK: - Soubory

    private static func sanitize(_ text: String) -> String {
        String(text.map { $0.isLetter || $0.isNumber || "@._-".contains($0) ? $0 : "_" }.prefix(80))
    }

    private static func readJson(_ url: URL) -> Any? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONSerialization.jsonObject(with: data)
    }

    /// Zápis vždy naráz — kdyby aplikaci systém uspal uprostřed, druhé
    /// zařízení by jinak našlo půlku souboru.
    private static func writeJson(_ object: Any, to url: URL) throws {
        let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        try data.write(to: url, options: .atomic)
    }

    /// Stabilní otisk (FNV-1a). `hashValue` se v každém spuštění liší, takže
    /// by fotky ve sdílené složce vznikaly pořád znovu pod jiným jménem.
    private static func stableHash(_ text: String) -> String {
        var hash: UInt64 = 0xcbf29ce484222325
        for byte in text.utf8 {
            hash ^= UInt64(byte)
            hash = hash &* 0x100000001b3
        }
        return String(hash, radix: 16).padding(toLength: 12, withPad: "0", startingAt: 0)
    }
}
