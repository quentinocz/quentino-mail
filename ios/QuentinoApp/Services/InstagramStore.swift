import Foundation

/**
 Stav instagramového modulu — účty, trhy, profil značky a fronta.

 Schéma i významy sloupců jsou shodné se stolní verzí, takže záloha přenesená
 z počítače sedne beze změn. Tokeny účtů leží v klíčence pod klíčem
 `ig-token-<účet>`; v databázi zůstává jen odkaz.
 */
enum IgStore {
    // MARK: - Připojení a klíče

    struct Connection {
        var appId: String
        var appSecret: String
        var storageUrl: String
        var storageBucket: String
        var storageKey: String
        var callbackUrl: String
    }

    static func secrets() -> Connection {
        Connection(
            appId: Store.setting("igAppId", "") ?? "",
            appSecret: Secrets.get("igAppSecret") ?? "",
            storageUrl: (Store.setting("igStorageUrl", "") ?? "").trimmedSlash,
            storageBucket: Store.setting("igStorageBucket", "instagram") ?? "instagram",
            storageKey: Secrets.get("igStorageKey") ?? "",
            callbackUrl: Store.setting("igCallbackUrl", "") ?? ""
        )
    }

    static func saveSecrets(_ patch: [String: Any]) {
        if let value = patch["appId"] as? String { Store.setSetting("igAppId", value.trimmingCharacters(in: .whitespaces)) }
        if let value = patch["appSecret"] as? String, !value.isEmpty { Secrets.set("igAppSecret", value) }
        if let value = patch["storageUrl"] as? String { Store.setSetting("igStorageUrl", value.trimmedSlash) }
        if let value = patch["storageBucket"] as? String { Store.setSetting("igStorageBucket", value.isEmpty ? "instagram" : value) }
        if let value = patch["storageKey"] as? String, !value.isEmpty { Secrets.set("igStorageKey", value) }
        if let value = patch["callbackUrl"] as? String { Store.setSetting("igCallbackUrl", value.trimmingCharacters(in: .whitespaces)) }
        if let value = patch["autoSync"] as? Bool { Store.setSetting("igAutoSync", value ? "1" : "0") }
        Store.touchState()
    }

    static func connectionState() -> [String: Any] {
        let s = secrets()
        return [
            "hasAppId": !s.appId.isEmpty,
            "hasAppSecret": !s.appSecret.isEmpty,
            "appId": s.appId,
            "callbackUrl": s.callbackUrl,
            "storage": ["url": s.storageUrl, "bucket": s.storageBucket, "hasKey": !s.storageKey.isEmpty],
            "autoSync": Store.bool("igAutoSync", true)
        ]
    }

    /// Dlouhodobý uživatelský token — díky němu jde přidat další trh bez přihlašování.
    static func userToken() -> String? {
        guard let token = Secrets.get("igUserToken"), !token.isEmpty else { return nil }
        if Formats.expired(Store.setting("igUserTokenExp")) { return nil }
        return token
    }

    static func setUserToken(_ token: String, expires: Date) {
        Secrets.set("igUserToken", token)
        Store.setSetting("igUserTokenExp", Formats.iso(expires))
    }

    static func clearUserToken() {
        Secrets.set("igUserToken", "")
        Store.setSetting("igUserTokenExp", "")
    }

    // MARK: - Účty

    static func accounts() -> [[String: Any]] {
        let rows = (try? SQLite.shared.query("SELECT * FROM ig_accounts ORDER BY is_source DESC, lang")) ?? []
        return rows.map { row in
            [
                "id": row["id"] ?? 0,
                "igUserId": row["ig_user_id"] ?? "",
                "username": row["username"] ?? "",
                "lang": row["lang"] ?? "",
                "color": row["color"] ?? "#7c5cff",
                "isSource": (row["is_source"] as? Int ?? 0) == 1,
                "tokenExpires": row["token_expires"] ?? NSNull(),
                "connectedAt": row["connected_at"] ?? "",
                "lastError": row["last_error"] ?? NSNull(),
                "pageId": row["page_id"] ?? "",
                "pageName": row["page_name"] ?? "",
                "shareFb": (row["share_fb"] as? Int ?? 0) == 1
            ]
        }
    }

    static func account(id: Int) -> [String: Any]? {
        accounts().first { ($0["id"] as? Int) == id }
    }

    static func account(lang: String) -> [String: Any]? {
        accounts().first { ($0["lang"] as? String) == lang }
    }

    static func sourceAccount() -> [String: Any]? {
        accounts().first { ($0["isSource"] as? Bool) == true }
    }

    static func token(accountId: Int) throws -> String {
        guard let account = account(id: accountId) else {
            throw BridgeError.message("Účet už není připojený.")
        }
        guard let token = Secrets.get("ig-token-\(account["igUserId"] as? String ?? "")"), !token.isEmpty else {
            throw BridgeError.message("Účet nemá platný přístup — připoj ho znovu.")
        }
        if Formats.expired(account["tokenExpires"] as? String) {
            throw BridgeError.message("Přístup k účtu vypršel — připoj ho znovu.")
        }
        return token
    }

    @discardableResult
    static func saveAccount(
        igUserId: String, username: String, lang: String, token: String, expires: Date,
        pageId: String, pageName: String, isSource: Bool?
    ) -> [String: Any]? {
        let existing = (try? SQLite.shared.query(
            "SELECT is_source FROM ig_accounts WHERE ig_user_id = ?", [.text(igUserId)]
        ))?.first
        // Zdrojový příznak si účet při opětovném připojení drží
        let source = existing.map { ($0["is_source"] as? Int ?? 0) == 1 } ?? (isSource ?? (lang == "CS"))
        let color = markets().first { ($0["lang"] as? String) == lang }?["color"] as? String ?? "#7c5cff"

        try? SQLite.shared.run(
            """
            INSERT INTO ig_accounts (ig_user_id, username, lang, color, is_source, token_enc, token_expires,
              connected_at, last_error, page_id, page_name)
            VALUES (?,?,?,?,?,'keychain',?,datetime('now'),NULL,?,?)
            ON CONFLICT(ig_user_id) DO UPDATE SET
              username = excluded.username, lang = excluded.lang, color = excluded.color,
              is_source = excluded.is_source, token_expires = excluded.token_expires,
              connected_at = datetime('now'), last_error = NULL,
              page_id = excluded.page_id, page_name = excluded.page_name
            """,
            [
                .text(igUserId), .text(username), .text(lang), .text(color), .int(source ? 1 : 0),
                .text(Formats.iso(expires)), .text(pageId), .text(pageName)
            ]
        )
        Secrets.set("ig-token-\(igUserId)", token)
        if source {
            try? SQLite.shared.run("UPDATE ig_accounts SET is_source = 0 WHERE ig_user_id != ?", [.text(igUserId)])
        }
        Store.touchState()
        return account(lang: lang)
    }

    static func setAccountToken(accountId: Int, token: String, expires: Date) {
        guard let account = account(id: accountId), let igUserId = account["igUserId"] as? String else { return }
        Secrets.set("ig-token-\(igUserId)", token)
        try? SQLite.shared.run(
            "UPDATE ig_accounts SET token_expires = ?, last_error = NULL WHERE id = ?",
            [.text(Formats.iso(expires)), .int(Int64(accountId))]
        )
    }

    static func setAccountError(accountId: Int, message: String?) {
        try? SQLite.shared.run(
            "UPDATE ig_accounts SET last_error = ? WHERE id = ?",
            [message.map { SQLite.Value.text($0) } ?? .null, .int(Int64(accountId))]
        )
    }

    static func deleteAccount(id: Int) {
        if let account = account(id: id), let igUserId = account["igUserId"] as? String {
            Secrets.set("ig-token-\(igUserId)", "")
        }
        try? SQLite.shared.run("DELETE FROM ig_accounts WHERE id = ?", [.int(Int64(id))])
        Store.touchState()
    }

    static func setSource(id: Int) {
        try? SQLite.shared.run("UPDATE ig_accounts SET is_source = 0")
        try? SQLite.shared.run("UPDATE ig_accounts SET is_source = 1 WHERE id = ?", [.int(Int64(id))])
        Store.touchState()
    }

    static func setShareFb(id: Int, value: Bool) {
        try? SQLite.shared.run("UPDATE ig_accounts SET share_fb = ? WHERE id = ?",
                               [.int(value ? 1 : 0), .int(Int64(id))])
        Store.touchState()
    }

    // MARK: - Trhy

    private static let defaultMarkets: [(String, String, String, String)] = [
        ("CS", "Čeština", "#232849", "Domácí trh, zdroj příspěvků."),
        ("EN", "Angličtina", "#2F6BE0", "Mezinárodní publikum, spíš stručně."),
        ("DE", "Němčina", "#B5701A", "Německy mluvící trh, věcný tón."),
        ("PL", "Polština", "#0E7A61", "Polský trh, přátelský tón."),
        ("ES", "Španělština", "#BE3730", "Španělsky mluvící trh, živější tón.")
    ]

    static func markets() -> [[String: Any]] {
        let count = ((try? SQLite.shared.query("SELECT COUNT(*) AS c FROM ig_markets"))?.first?["c"] as? Int) ?? 0
        if count == 0 {
            for (index, market) in defaultMarkets.enumerated() {
                try? SQLite.shared.run(
                    "INSERT INTO ig_markets (lang, label, note, tags, color, enabled, ord) VALUES (?,?,?,'',?,1,?)",
                    [.text(market.0), .text(market.1), .text(market.3), .text(market.2), .int(Int64(index))]
                )
            }
        }
        let rows = (try? SQLite.shared.query("SELECT * FROM ig_markets ORDER BY ord, lang")) ?? []
        return rows.map { row in
            [
                "lang": row["lang"] ?? "",
                "label": row["label"] ?? "",
                "note": row["note"] ?? "",
                "tags": row["tags"] ?? "",
                "color": row["color"] ?? "#7c5cff",
                "enabled": (row["enabled"] as? Int ?? 1) == 1
            ]
        }
    }

    static func saveMarket(_ market: [String: Any]) -> [[String: Any]] {
        guard let lang = (market["lang"] as? String)?.uppercased(), !lang.isEmpty else { return markets() }
        try? SQLite.shared.run(
            """
            INSERT INTO ig_markets (lang, label, note, tags, color, enabled, ord)
            VALUES (?,?,?,?,?,?,(SELECT COALESCE(MAX(ord)+1,0) FROM ig_markets))
            ON CONFLICT(lang) DO UPDATE SET label = excluded.label, note = excluded.note,
              tags = excluded.tags, color = excluded.color, enabled = excluded.enabled
            """,
            [
                .text(lang), .text(market["label"] as? String ?? ""), .text(market["note"] as? String ?? ""),
                .text(market["tags"] as? String ?? ""), .text(market["color"] as? String ?? "#7c5cff"),
                .int((market["enabled"] as? Bool ?? true) ? 1 : 0)
            ]
        )
        Store.touchState()
        return markets()
    }

    static func deleteMarket(lang: String) -> [[String: Any]] {
        try? SQLite.shared.run("DELETE FROM ig_markets WHERE lang = ?", [.text(lang)])
        Store.touchState()
        return markets()
    }

    // MARK: - Profil značky

    static func brand() -> [String: Any] {
        let defaults: [String: Any] = [
            "context": "Quentino — český výrobce a prodejce. Doplň, čím se značka zabývá.",
            "loveOn": false, "love": "",
            "tones": ["přátelský", "věcný", "bez patosu"],
            "avoid": "Superlativy bez obsahu, klišé, vykřičníky na konci každé věty.",
            "rules": "Bez nabubřelých frází. Konkrétní detail místo obecného chvalozpěvu.",
            "emoji": "sparse", "variants": 2, "useKnowledge": false
        ]
        guard let stored = Store.json("igBrand", [:]) as? [String: Any] else { return defaults }
        return defaults.merging(stored) { _, new in new }
    }

    static func saveBrand(_ patch: [String: Any]) -> [String: Any] {
        var next = brand().merging(patch) { _, new in new }
        let variants = next["variants"] as? Int ?? 1
        next["variants"] = min(4, max(1, variants))
        Store.setJson("igBrand", next)
        Store.touchState()
        return next
    }
}
