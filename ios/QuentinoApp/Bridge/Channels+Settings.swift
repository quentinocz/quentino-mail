import Foundation

/**
 Kanály nastavení, znalostní báze a osob.

 Tvar dat je stejný jako na počítači — rozhraní si nesmí všimnout, že pod ním
 místo Electronu odpovídá Swift.
 */
extension Bridge {
    func registerSettingsChannels() {
        register("settings:get") { _ in Settings.current() }
        register("settings:save") { args in
            Settings.save(args.first as? [String: Any] ?? [:])
            return true
        }

        register("knowledge:list") { _ in Settings.knowledge() }
        register("knowledge:save") { args in
            guard let doc = args.first as? [String: Any],
                  let title = doc["title"] as? String else { throw BridgeError.message("Chybí název dokumentu.") }
            let content = doc["content"] as? String ?? ""
            if let id = doc["id"] as? Int {
                try SQLite.shared.run("UPDATE knowledge SET title = ?, content = ? WHERE id = ?",
                                      [.text(title), .text(content), .int(Int64(id))])
            } else {
                try SQLite.shared.run("INSERT INTO knowledge (title, content) VALUES (?,?)",
                                      [.text(title), .text(content)])
            }
            Store.touchState()
            return Settings.knowledge()
        }
        register("knowledge:delete") { args in
            guard let id = args.first as? Int else { throw BridgeError.message("Chybí ID.") }
            try SQLite.shared.run("DELETE FROM knowledge WHERE id = ?", [.int(Int64(id))])
            Store.touchState()
            return Settings.knowledge()
        }

        register("persons:list") { _ in Settings.persons() }
        register("persons:save") { args in
            guard let person = args.first as? [String: Any],
                  let name = person["name"] as? String else { throw BridgeError.message("Chybí jméno.") }
            let positions = person["positions"] as? [String: String] ?? [:]
            let display = person["displayNames"] as? [String: String] ?? [:]
            let positionCz = positions["cz"] ?? ""
            let common: [SQLite.Value] = [
                .text(name),
                .text(positionCz), .text(positions["sk"] ?? ""), .text(positions["en"] ?? ""),
                .text(display["cz"] ?? ""), .text(display["sk"] ?? ""), .text(display["en"] ?? "")
            ]
            if let id = person["id"] as? Int {
                try SQLite.shared.run(
                    """
                    UPDATE persons SET name = ?, position_cz = ?, position_sk = ?, position_en = ?,
                      display_cz = ?, display_sk = ?, display_en = ? WHERE id = ?
                    """,
                    common + [.int(Int64(id))]
                )
            } else {
                // Sloupec `position` je pozůstatek starší verze; drží kopii české pozice
                try SQLite.shared.run(
                    """
                    INSERT INTO persons (name, position, position_cz, position_sk, position_en,
                      display_cz, display_sk, display_en)
                    VALUES (?,?,?,?,?,?,?,?)
                    """,
                    [common[0], .text(positionCz)] + common[1...].map { $0 }
                )
            }
            Store.touchState()
            return Settings.persons()
        }
        register("persons:delete") { args in
            guard let id = args.first as? Int else { throw BridgeError.message("Chybí ID.") }
            try SQLite.shared.run("DELETE FROM persons WHERE id = ?", [.int(Int64(id))])
            Store.touchState()
            return Settings.persons()
        }
    }
}

/// Čtení a zápis nastavení ve tvaru, jaký očekává rozhraní.
enum Settings {
    static func current() -> [String: Any] {
        [
            "hasApiKey": Secrets.has("anthropicApiKey"),
            "secretsLocked": false,
            "brandPrompt": Store.setting("brandPrompt", "") ?? "",
            "draftModel": Store.setting("draftModel", "claude-sonnet-5") ?? "claude-sonnet-5",
            "fastModel": Store.setting("fastModel", "claude-haiku-4-5-20251001") ?? "claude-haiku-4-5-20251001",
            "autoSummarize": Store.bool("autoSummarize", true),
            "autoCategorize": Store.bool("autoCategorize", true),
            "autoTranslate": Store.bool("autoTranslate", true),
            "loadRemoteImages": Store.bool("loadRemoteImages", false),
            "notifyNewMail": Store.bool("notifyNewMail", true),
            "categoryRules": Store.json("categoryRules", []),
            "autoSummarizeCategories": Store.json("autoSummarizeCategories", []),
            "contactInfo": Store.setting("contactInfo", "") ?? "",
            "productFeedUrl": Store.setting("productFeedUrl", "") ?? "",
            // Malý export jen se zásobami; obnovuje se po dvou hodinách,
            // zatímco celý katalog jednou denně
            "stockFeedUrl": Store.setting("stockFeedUrl", "") ?? "",
            "adminOrderRef": Store.setting("adminOrderRef", "") ?? "",
            "voucherLogo": Store.setting("voucherLogo", "") ?? "",
            "defaultPersonId": Int(Store.setting("defaultPersonId", "0") ?? "0") ?? 0,
            "theme": Store.setting("theme", "light") ?? "light"
        ]
    }

    static func save(_ patch: [String: Any]) {
        // Klíč patří do klíčenky, ne do databáze
        if let key = patch["anthropicApiKey"] as? String {
            Secrets.set("anthropicApiKey", key)
        }
        for key in ["brandPrompt", "draftModel", "fastModel", "contactInfo",
                    "productFeedUrl", "stockFeedUrl", "adminOrderRef", "voucherLogo", "theme"] {
            if let value = patch[key] as? String { Store.setSetting(key, value) }
        }
        for key in ["autoSummarize", "autoCategorize", "autoTranslate", "loadRemoteImages", "notifyNewMail"] {
            if let value = patch[key] as? Bool { Store.setSetting(key, value ? "1" : "0") }
        }
        for key in ["categoryRules", "autoSummarizeCategories"] {
            if let value = patch[key] { Store.setJson(key, value) }
        }
        if let personId = patch["defaultPersonId"] as? Int { Store.setSetting("defaultPersonId", String(personId)) }
        Store.touchState()
    }

    static func knowledge() -> [[String: Any]] {
        (try? SQLite.shared.query("SELECT id, title, content FROM knowledge ORDER BY id")) ?? []
    }

    static func persons() -> [[String: Any]] {
        let rows = (try? SQLite.shared.query(
            """
            SELECT id, name, position_cz, position_sk, position_en,
                   display_cz, display_sk, display_en, photo_path
            FROM persons ORDER BY name
            """
        )) ?? []
        return rows.map { row -> [String: Any] in
            [
                "id": row["id"] ?? 0,
                "name": row["name"] ?? "",
                "positions": [
                    "cz": row["position_cz"] ?? "", "sk": row["position_sk"] ?? "", "en": row["position_en"] ?? ""
                ],
                "displayNames": [
                    "cz": row["display_cz"] ?? "", "sk": row["display_sk"] ?? "", "en": row["display_en"] ?? ""
                ],
                "photoPath": row["photo_path"] ?? NSNull()
            ]
        }
    }
}
