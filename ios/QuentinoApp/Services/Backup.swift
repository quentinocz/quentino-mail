import Foundation
import CryptoKit

/**
 Záloha a obnovení kompletního nastavení.

 Tvar souboru je přesně ten, který dělá stolní verze (`src/main/settings.ts`,
 `version: 2`): celá tabulka nastavení, účty i s hesly, instagramové účty
 s přístupy, znalostní báze, osoby a všechny obrázky jako base64. Záloha
 z Macu se tedy obnoví na iPadu a naopak.

 Tajemství jsou v odděleném bloku `secrets` a dají se zamknout heslem
 (AES-256-GCM, klíč přes scrypt — proto `Scrypt.swift`). Na počítači leží
 v systémové klíčence, tady taky; do souboru jdou rozšifrované, protože
 na jiném zařízení by zašifrované byly k ničemu.
 */
enum Backup {
    /// Klíče, které nesou tajemství. V databázi nejsou vůbec — leží v klíčence.
    private static let secretKeys = [
        "anthropicApiKey", "upgatesKey", "igAppSecret", "igStorageKey", "igUserToken", "chatAnonKey",
        // Adresy feedů objednávek nesou tajný klíč, proto leží v klíčence
        "orderFeeds"
    ]

    private static let secretLabels: [String: String] = [
        "anthropicApiKey": "API klíč",
        "upgatesKey": "Upgates klíč",
        "igAppSecret": "Meta aplikace",
        "igStorageKey": "úložiště médií",
        "igUserToken": "přístup k Instagramu",
        "chatAnonKey": "klíč k chatu",
        "orderFeeds": "feedy objednávek"
    ]

    /**
     Provozní hodnoty, které nemá smysl přenášet.

     Jsou to razítka „kdy jsem naposledy něco stáhl" a výsledky posledních
     běhů. Na druhém zařízení by způsobily, že se aplikace tváří jako
     čerstvě synchronizovaná a první stažení odloží — přitom nemá nic.
     */
    private static let volatileKeys = [
        "stateStamp", "ftsBuilt", "contactsBackfilled", "windowState",
        "productFeedSync", "productFeedSchema",
        "syncLastRun", "syncLastResult", "appsyncLastRun", "appsyncLastResult",
        "ptransSyncedAt",
        // Totožnost zařízení do zálohy nepatří: po obnovení na druhém přístroji
        // by obě zařízení tvrdila, že jsou totéž, psala si do stejného deníku
        // a sahala si po týchž zamluvených kódech poukazů.
        "deviceId", "deviceName"
    ]

    /// Totéž, ale klíčů je celá řada — jeden na každý feed objednávek.
    private static let volatilePrefixes = ["orderFeedSync:", "orderFeedError:"]

    private static func isVolatile(_ key: String) -> Bool {
        volatileKeys.contains(key) || volatilePrefixes.contains { key.hasPrefix($0) }
    }

    private static let maxEmbedBytes = 12 * 1024 * 1024

    // MARK: - Export

    static func export(passphrase: String?) -> [String: Any] {
        var files: [String: [String: String]] = [:]
        var settings: [String: String] = [:]
        var secrets: [String: Any] = [:]
        var accountPasswords: [String: String] = [:]
        var igTokens: [String: String] = [:]

        for row in (try? SQLite.shared.query("SELECT key, value FROM settings")) ?? [] {
            guard let key = row["key"] as? String, !isVolatile(key) else { continue }
            settings[key] = row["value"] as? String ?? ""
        }
        for key in secretKeys {
            secrets[key] = Secrets.get(key) ?? ""
        }

        let voucherLogoFile = embed(&files, path: settings["voucherLogo"], id: "voucher-logo")

        // Poštovní účty i s hesly a logem v podpisu
        var accounts: [[String: Any]] = []
        for (index, row) in ((try? SQLite.shared.query("SELECT * FROM accounts ORDER BY id")) ?? []).enumerated() {
            let email = row["email"] as? String ?? ""
            accountPasswords[email] = Secrets.get("mail-pass-\(email)") ?? ""
            let logo = row["signature_logo"] as? String
            accounts.append([
                "name": row["name"] ?? "", "email": email,
                "imap_host": row["imap_host"] ?? "", "imap_port": row["imap_port"] ?? 993,
                "imap_secure": row["imap_secure"] ?? 1,
                "smtp_host": row["smtp_host"] ?? "", "smtp_port": row["smtp_port"] ?? 465,
                "smtp_secure": row["smtp_secure"] ?? 1,
                "username": row["username"] ?? "",
                "signature_html": row["signature_html"] ?? "",
                "sig_json": row["sig_json"] ?? NSNull(),
                "color": row["color"] ?? "#7c5cff",
                "signature_logo": logo ?? NSNull(),
                "logoFile": embed(&files, path: logo, id: "account-logo-\(index)") ?? NSNull()
            ])
        }

        // Instagram: účty i s přístupem, trhy a barvy
        var igAccounts: [[String: Any]] = []
        for row in (try? SQLite.shared.query("SELECT * FROM ig_accounts ORDER BY id")) ?? [] {
            let igUserId = row["ig_user_id"] as? String ?? ""
            igTokens[igUserId] = Secrets.get("ig-token-\(igUserId)") ?? ""
            igAccounts.append([
                "ig_user_id": igUserId, "username": row["username"] ?? "", "lang": row["lang"] ?? "CS",
                "color": row["color"] ?? "#7c5cff", "is_source": row["is_source"] ?? 0,
                "token_expires": row["token_expires"] ?? NSNull(),
                "page_id": row["page_id"] ?? "", "page_name": row["page_name"] ?? "",
                "share_fb": row["share_fb"] ?? 0
            ])
        }

        // Osoby i s fotkami do podpisu
        var persons: [[String: Any]] = []
        for (index, person) in Settings.persons().enumerated() {
            let photo = person["photoPath"] as? String
            persons.append([
                "name": person["name"] ?? "",
                "positions": person["positions"] ?? [:],
                "displayNames": person["displayNames"] ?? [:],
                "photoPath": photo ?? NSNull(),
                "photoFile": embed(&files, path: photo, id: "person-photo-\(index)") ?? NSNull()
            ])
        }

        secrets["accountPasswords"] = accountPasswords
        secrets["igTokens"] = igTokens

        return [
            "app": "quentino-mail",
            "version": 2,
            "exportedAt": Formats.iso(),
            "encrypted": !(passphrase ?? "").isEmpty,
            "settings": settings,
            "voucherLogoFile": voucherLogoFile ?? NSNull(),
            "knowledge": Settings.knowledge().map {
                ["title": $0["title"] ?? "", "content": $0["content"] ?? ""]
            },
            "persons": persons,
            "accounts": accounts,
            "igAccounts": igAccounts,
            "igMarkets": (try? SQLite.shared.query("SELECT * FROM ig_markets ORDER BY ord, lang")) ?? [],
            "files": files,
            "secrets": (passphrase ?? "").isEmpty ? secrets : seal(secrets, passphrase: passphrase!)
        ]
    }

    // MARK: - Import

    static func needsPassphrase(_ data: [String: Any]) -> Bool {
        (data["encrypted"] as? Bool) ?? false
    }

    static func restore(_ data: [String: Any], passphrase: String?) throws -> String {
        guard (data["app"] as? String) == "quentino-mail" else {
            throw BridgeError.message("Neplatný soubor s nastavením.")
        }
        var parts: [String] = []
        let files = data["files"] as? [String: [String: String]] ?? [:]

        let secrets: [String: Any] = needsPassphrase(data)
            ? try unseal(data["secrets"], passphrase: passphrase ?? "")
            : (data["secrets"] as? [String: Any] ?? [:])
        let accountPasswords = secrets["accountPasswords"] as? [String: String] ?? [:]
        let igTokens = secrets["igTokens"] as? [String: String] ?? [:]

        // Nastavení — celá tabulka tak, jak byla
        if let settings = data["settings"] as? [String: Any] {
            for (key, value) in settings where !isVolatile(key) {
                Store.setSetting(key, value as? String ?? String(describing: value))
            }
            if let logo = materialize(files, data["voucherLogoFile"] as? String) {
                Store.setSetting("voucherLogo", logo)
            }
            parts.append("nastavení")
        }

        // Tajemství do klíčenky
        for key in secretKeys {
            if let value = secrets[key] as? String, !value.isEmpty {
                Secrets.set(key, value)
                parts.append(secretLabels[key] ?? key)
            }
        }

        // Znalostní báze — bez duplikátů podle názvu
        if let knowledge = data["knowledge"] as? [[String: Any]] {
            var count = 0
            for item in knowledge {
                guard let title = item["title"] as? String, !title.isEmpty,
                      let content = item["content"] as? String, !content.isEmpty else { continue }
                let existing = (try? SQLite.shared.query("SELECT id FROM knowledge WHERE title = ?", [.text(title)]))?.first
                if let id = existing?["id"] as? Int {
                    _ = try? SQLite.shared.run("UPDATE knowledge SET content = ? WHERE id = ?",
                                           [.text(content), .int(Int64(id))])
                } else {
                    _ = try? SQLite.shared.run("INSERT INTO knowledge (title, content) VALUES (?,?)",
                                           [.text(title), .text(content)])
                }
                count += 1
            }
            if count > 0 { parts.append("\(count)× znalost") }
        }

        // Osoby včetně fotek
        if let persons = data["persons"] as? [[String: Any]] {
            var count = 0
            for person in persons {
                guard let name = person["name"] as? String, !name.isEmpty else { continue }
                let positions = person["positions"] as? [String: String] ?? [:]
                let display = person["displayNames"] as? [String: String] ?? [:]
                let photo = materialize(files, person["photoFile"] as? String) ?? person["photoPath"] as? String
                let existing = (try? SQLite.shared.query("SELECT id FROM persons WHERE name = ?", [.text(name)]))?.first

                if let id = existing?["id"] as? Int {
                    _ = try? SQLite.shared.run(
                        """
                        UPDATE persons SET position_cz=?, position_sk=?, position_en=?,
                          display_cz=?, display_sk=?, display_en=?,
                          photo_path=COALESCE(?, photo_path) WHERE id=?
                        """,
                        [
                            .text(positions["cz"] ?? ""), .text(positions["sk"] ?? ""), .text(positions["en"] ?? ""),
                            .text(display["cz"] ?? ""), .text(display["sk"] ?? ""), .text(display["en"] ?? ""),
                            photo.map { SQLite.Value.text($0) } ?? .null, .int(Int64(id))
                        ]
                    )
                } else {
                    _ = try? SQLite.shared.run(
                        """
                        INSERT INTO persons (name, position, position_cz, position_sk, position_en,
                          display_cz, display_sk, display_en, photo_path)
                        VALUES (?,?,?,?,?,?,?,?,?)
                        """,
                        [
                            .text(name), .text(positions["cz"] ?? ""),
                            .text(positions["cz"] ?? ""), .text(positions["sk"] ?? ""), .text(positions["en"] ?? ""),
                            .text(display["cz"] ?? ""), .text(display["sk"] ?? ""), .text(display["en"] ?? ""),
                            photo.map { SQLite.Value.text($0) } ?? .null
                        ]
                    )
                }
                count += 1
            }
            if count > 0 { parts.append("\(count)× osoba") }
        }

        // Poštovní účty včetně hesel
        if let accounts = data["accounts"] as? [[String: Any]] {
            var added = 0, updated = 0, missing = 0
            for account in accounts {
                guard let email = account["email"] as? String, !email.isEmpty else { continue }
                let password = accountPasswords[email] ?? ""
                if password.isEmpty { missing += 1 } else { Secrets.set("mail-pass-\(email)", password) }
                let logo = materialize(files, account["logoFile"] as? String) ?? account["signature_logo"] as? String
                let existing = (try? SQLite.shared.query("SELECT id FROM accounts WHERE email = ?", [.text(email)]))?.first

                let common: [SQLite.Value] = [
                    .text(account["name"] as? String ?? ""),
                    .text(account["imap_host"] as? String ?? ""),
                    .int(Int64(account["imap_port"] as? Int ?? 993)),
                    .int(Int64(account["imap_secure"] as? Int ?? 1)),
                    .text(account["smtp_host"] as? String ?? ""),
                    .int(Int64(account["smtp_port"] as? Int ?? 465)),
                    .int(Int64(account["smtp_secure"] as? Int ?? 1)),
                    .text(account["username"] as? String ?? ""),
                    .text(account["signature_html"] as? String ?? ""),
                    logo.map { SQLite.Value.text($0) } ?? .null,
                    (account["sig_json"] as? String).map { SQLite.Value.text($0) } ?? .null,
                    .text(account["color"] as? String ?? "#7c5cff")
                ]

                if let id = existing?["id"] as? Int {
                    _ = try? SQLite.shared.run(
                        """
                        UPDATE accounts SET name=?, imap_host=?, imap_port=?, imap_secure=?,
                          smtp_host=?, smtp_port=?, smtp_secure=?, username=?,
                          signature_html=?, signature_logo=?, sig_json=?, color=? WHERE id=?
                        """,
                        common + [.int(Int64(id))]
                    )
                    updated += 1
                } else {
                    _ = try? SQLite.shared.run(
                        """
                        INSERT INTO accounts (name, email, imap_host, imap_port, imap_secure,
                          smtp_host, smtp_port, smtp_secure, username, pass_enc,
                          signature_html, signature_logo, sig_json, color)
                        VALUES (?,?,?,?,?,?,?,?,?,'keychain',?,?,?,?)
                        """,
                        [common[0], .text(email)] + Array(common[1...])
                    )
                    added += 1
                }
            }
            if added > 0 { parts.append("\(added)× nový účet") }
            if updated > 0 { parts.append("\(updated)× aktualizovaný účet") }
            if missing > 0 { parts.append("u \(missing) účtů chybí heslo — doplň ho ručně") }
        }

        // Instagram: trhy a účty
        if let markets = data["igMarkets"] as? [[String: Any]] {
            for market in markets {
                guard let lang = market["lang"] as? String, !lang.isEmpty else { continue }
                _ = try? SQLite.shared.run(
                    """
                    INSERT INTO ig_markets (lang, label, note, tags, color, enabled, ord)
                    VALUES (?,?,?,?,?,?,?)
                    ON CONFLICT(lang) DO UPDATE SET label=excluded.label, note=excluded.note,
                      tags=excluded.tags, color=excluded.color, enabled=excluded.enabled, ord=excluded.ord
                    """,
                    [
                        .text(lang), .text(market["label"] as? String ?? ""), .text(market["note"] as? String ?? ""),
                        .text(market["tags"] as? String ?? ""), .text(market["color"] as? String ?? "#7c5cff"),
                        .int(Int64(market["enabled"] as? Int ?? 1)), .int(Int64(market["ord"] as? Int ?? 0))
                    ]
                )
            }
            if !markets.isEmpty { parts.append("\(markets.count)× trh") }
        }

        if let igAccounts = data["igAccounts"] as? [[String: Any]] {
            var count = 0
            for account in igAccounts {
                guard let igUserId = account["ig_user_id"] as? String, !igUserId.isEmpty else { continue }
                if let token = igTokens[igUserId], !token.isEmpty { Secrets.set("ig-token-\(igUserId)", token) }
                _ = try? SQLite.shared.run(
                    """
                    INSERT INTO ig_accounts (ig_user_id, username, lang, color, is_source, token_enc,
                      token_expires, page_id, page_name, share_fb)
                    VALUES (?,?,?,?,?,'keychain',?,?,?,?)
                    ON CONFLICT(ig_user_id) DO UPDATE SET
                      username=excluded.username, lang=excluded.lang, color=excluded.color,
                      is_source=excluded.is_source, token_expires=excluded.token_expires,
                      page_id=excluded.page_id, page_name=excluded.page_name, share_fb=excluded.share_fb
                    """,
                    [
                        .text(igUserId), .text(account["username"] as? String ?? ""),
                        .text(account["lang"] as? String ?? "CS"),
                        .text(account["color"] as? String ?? "#7c5cff"),
                        .int(Int64(account["is_source"] as? Int ?? 0)),
                        (account["token_expires"] as? String).map { SQLite.Value.text($0) } ?? .null,
                        .text(account["page_id"] as? String ?? ""),
                        .text(account["page_name"] as? String ?? ""),
                        .int(Int64(account["share_fb"] as? Int ?? 0))
                    ]
                )
                count += 1
            }
            if count > 0 { parts.append("\(count)× instagramový účet") }
        }

        if !files.isEmpty { parts.append("\(files.count)× obrázek") }
        Store.touchState()
        return parts.isEmpty ? "V souboru nebylo co importovat." : "Importováno: \(parts.joined(separator: ", "))."
    }

    // MARK: - Obrázky

    private static func embed(_ files: inout [String: [String: String]], path: String?, id: String) -> String? {
        guard let path, !path.isEmpty,
              let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
              data.count <= maxEmbedBytes else { return nil }
        files[id] = ["name": (path as NSString).lastPathComponent, "data": data.base64EncodedString()]
        return id
    }

    private static func materialize(_ files: [String: [String: String]], _ reference: String?) -> String? {
        guard let reference, let entry = files[reference],
              let base64 = entry["data"], let data = Data(base64Encoded: base64) else { return nil }
        let safe = (entry["name"] ?? "obrazek").filter { $0.isLetter || $0.isNumber || $0 == "." || $0 == "-" }
        let target = Files.scratch.appendingPathComponent("\(Int(Date().timeIntervalSince1970))-\(safe)")
        _ = try? data.write(to: target)
        return FileManager.default.fileExists(atPath: target.path) ? target.path : nil
    }

    // MARK: - Zámek heslem

    private static func seal(_ object: [String: Any], passphrase: String) -> [String: Any] {
        var salt = [UInt8](repeating: 0, count: 16)
        var nonceBytes = [UInt8](repeating: 0, count: 12)
        _ = SecRandomCopyBytes(kSecRandomDefault, salt.count, &salt)
        _ = SecRandomCopyBytes(kSecRandomDefault, nonceBytes.count, &nonceBytes)

        let key = SymmetricKey(data: Data(Scrypt.derive(password: passphrase, salt: salt)))
        guard let payload = try? JSONSerialization.data(withJSONObject: object),
              let nonce = try? AES.GCM.Nonce(data: Data(nonceBytes)),
              let box = try? AES.GCM.seal(payload, using: key, nonce: nonce) else { return object }

        return [
            "alg": "aes-256-gcm",
            "salt": Data(salt).base64EncodedString(),
            "iv": Data(nonceBytes).base64EncodedString(),
            "tag": box.tag.base64EncodedString(),
            "data": box.ciphertext.base64EncodedString()
        ]
    }

    private static func unseal(_ raw: Any?, passphrase: String) throws -> [String: Any] {
        guard let box = raw as? [String: Any],
              let salt = (box["salt"] as? String).flatMap({ Data(base64Encoded: $0) }),
              let iv = (box["iv"] as? String).flatMap({ Data(base64Encoded: $0) }),
              let tag = (box["tag"] as? String).flatMap({ Data(base64Encoded: $0) }),
              let payload = (box["data"] as? String).flatMap({ Data(base64Encoded: $0) }) else {
            throw BridgeError.message("Zamčená část zálohy je poškozená.")
        }

        let key = SymmetricKey(data: Data(Scrypt.derive(password: passphrase, salt: [UInt8](salt))))
        guard let nonce = try? AES.GCM.Nonce(data: iv),
              let sealed = try? AES.GCM.SealedBox(nonce: nonce, ciphertext: payload, tag: tag),
              let plain = try? AES.GCM.open(sealed, using: key),
              let object = try? JSONSerialization.jsonObject(with: plain) as? [String: Any] else {
            throw BridgeError.message("Špatné heslo k záloze — údaje se nepodařilo rozšifrovat.")
        }
        return object
    }
}
