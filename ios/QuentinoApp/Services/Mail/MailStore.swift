import Foundation

/**
 Účty a zprávy v databázi.

 Tabulky jsou shodné se stolní verzí, jen hesla nejsou v databázi zašifrovaná
 — leží v klíčence pod `mail-pass-<adresa>` a ve sloupci `pass_enc` zůstává
 jen značka. Záloha z počítače proto sedne beze změny.
 */
enum MailStore {
    // MARK: - Účty

    static func account(_ row: [String: Any]) -> [String: Any] {
        let logo = row["signature_logo"] as? String
        let hasLogo = logo.map { FileManager.default.fileExists(atPath: $0) } ?? false
        var sig: Any = NSNull()
        if let json = row["sig_json"] as? String, let data = json.data(using: .utf8),
           let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            sig = normalizeSignature(parsed)
        }
        return [
            "id": row["id"] ?? 0,
            "name": row["name"] ?? "",
            "email": row["email"] ?? "",
            "imapHost": row["imap_host"] ?? "",
            "imapPort": row["imap_port"] ?? 993,
            "imapSecure": (row["imap_secure"] as? Int ?? 1) == 1,
            "smtpHost": row["smtp_host"] ?? "",
            "smtpPort": row["smtp_port"] ?? 465,
            "smtpSecure": (row["smtp_secure"] as? Int ?? 1) == 1,
            "username": row["username"] ?? "",
            "signatureHtml": row["signature_html"] ?? "",
            "sigConfig": sig,
            // Chybějící soubor hlásíme jako „logo není" — jinak by se do e-mailu
            // vložil prázdný obrázek
            "logoPath": hasLogo ? (logo ?? "") : NSNull(),
            "color": row["color"] ?? "#7c5cff"
        ]
    }

    /// Starší tvar (jméno jako jeden řetězec) se převede na jazykové varianty.
    private static func normalizeSignature(_ raw: [String: Any]) -> [String: Any] {
        func variants(_ value: Any?) -> [String: String] {
            if let text = value as? String { return ["cz": text, "sk": text, "en": text] }
            let dictionary = value as? [String: String] ?? [:]
            return ["cz": dictionary["cz"] ?? "", "sk": dictionary["sk"] ?? "", "en": dictionary["en"] ?? ""]
        }
        return [
            "phone": raw["phone"] as? String ?? "",
            "names": variants(raw["names"] ?? raw["name"]),
            "emails": variants(raw["emails"] ?? raw["email"]),
            "taglines": variants(raw["taglines"]),
            "webs": variants(raw["webs"])
        ]
    }

    static func accounts() -> [[String: Any]] {
        ((try? SQLite.shared.query("SELECT * FROM accounts ORDER BY id")) ?? []).map(account)
    }

    static func accountRow(_ id: Int) -> [String: Any]? {
        (try? SQLite.shared.query("SELECT * FROM accounts WHERE id = ?", [.int(Int64(id))]))?.first
    }

    static func password(for email: String) -> String {
        Secrets.get("mail-pass-\(email)") ?? ""
    }

    @discardableResult
    static func saveAccount(_ patch: [String: Any]) throws -> [String: Any] {
        let email = (patch["email"] as? String ?? "").trimmingCharacters(in: .whitespaces)
        guard !email.isEmpty else { throw BridgeError.message("Účet musí mít e-mailovou adresu.") }

        let values: [SQLite.Value] = [
            .text(patch["name"] as? String ?? email),
            .text(patch["imapHost"] as? String ?? ""),
            .int(Int64(patch["imapPort"] as? Int ?? 993)),
            .int((patch["imapSecure"] as? Bool ?? true) ? 1 : 0),
            .text(patch["smtpHost"] as? String ?? ""),
            .int(Int64(patch["smtpPort"] as? Int ?? 465)),
            .int((patch["smtpSecure"] as? Bool ?? true) ? 1 : 0),
            .text(patch["username"] as? String ?? email),
            .text(patch["signatureHtml"] as? String ?? ""),
            (patch["logoPath"] as? String).map { SQLite.Value.text($0) } ?? .null,
            jsonValue(patch["sigConfig"]),
            .text(patch["color"] as? String ?? "#7c5cff")
        ]

        if let password = patch["password"] as? String, !password.isEmpty {
            Secrets.set("mail-pass-\(email)", password)
        }

        if let id = patch["id"] as? Int, id > 0 {
            try SQLite.shared.run(
                """
                UPDATE accounts SET name=?, imap_host=?, imap_port=?, imap_secure=?,
                  smtp_host=?, smtp_port=?, smtp_secure=?, username=?,
                  signature_html=?, signature_logo=?, sig_json=?, color=? WHERE id=?
                """,
                values + [.int(Int64(id))]
            )
            MailSync.forgetFolders(id)
            Store.touchState()
            return account(accountRow(id) ?? [:])
        }

        let result = try SQLite.shared.run(
            """
            INSERT INTO accounts (name, email, imap_host, imap_port, imap_secure,
              smtp_host, smtp_port, smtp_secure, username, pass_enc,
              signature_html, signature_logo, sig_json, color)
            VALUES (?,?,?,?,?,?,?,?,?,'keychain',?,?,?,?)
            """,
            [values[0], .text(email)] + Array(values[1...])
        )
        Store.touchState()
        return account(accountRow(Int(result.lastId)) ?? [:])
    }

    private static func jsonValue(_ value: Any?) -> SQLite.Value {
        guard let value, !(value is NSNull),
              let data = try? JSONSerialization.data(withJSONObject: value),
              let text = String(data: data, encoding: .utf8) else { return .null }
        return .text(text)
    }

    static func deleteAccount(_ id: Int) {
        if let row = accountRow(id), let email = row["email"] as? String {
            Secrets.set("mail-pass-\(email)", "")
        }
        try? SQLite.shared.run("DELETE FROM messages WHERE account_id = ?", [.int(Int64(id))])
        try? SQLite.shared.run("DELETE FROM accounts WHERE id = ?", [.int(Int64(id))])
        MailSync.forgetFolders(id)
        Store.touchState()
    }

    // MARK: - Zprávy

    private static let sortOptions: [String: String] = [
        "date_desc": "date DESC",
        "date_asc": "date ASC",
        "size_desc": "size DESC",
        "size_asc": "size ASC",
        "from_az": "COALESCE(NULLIF(from_name,''), from_addr) COLLATE NOCASE ASC, date DESC"
    ]

    static func header(_ row: [String: Any]) -> [String: Any] {
        [
            "id": row["id"] ?? 0,
            "accountId": row["account_id"] ?? 0,
            "folder": row["folder"] ?? "",
            "uid": row["uid"] ?? 0,
            "messageId": row["message_id"] ?? "",
            "subject": row["subject"] ?? "",
            "fromAddr": row["from_addr"] ?? "",
            "fromName": row["from_name"] ?? "",
            "toAddr": row["to_addr"] ?? "",
            "date": row["date"] ?? "",
            "snippet": row["snippet"] ?? "",
            "seen": (row["seen"] as? Int ?? 0) == 1,
            "flagged": (row["flagged"] as? Int ?? 0) == 1,
            "answered": (row["answered"] as? Int ?? 0) == 1,
            "hasAttachments": (row["has_attachments"] as? Int ?? 0) == 1,
            "category": row["category"] ?? NSNull(),
            "summary": row["summary"] ?? NSNull(),
            "archived": (row["archived"] as? Int ?? 0) == 1,
            "threadKey": row["thread_key"] ?? "",
            "size": row["size"] ?? 0,
            "orderRef": NSNull()
        ]
    }

    static func messages(accountId: Int, folder: String, options: [String: Any]) -> [[String: Any]] {
        var conditions: [String] = []
        var params: [SQLite.Value] = []

        if options["archivedOnly"] as? Bool == true {
            conditions.append("archived = 1")
            if accountId > 0 {
                conditions.append("account_id = ?")
                params.append(.int(Int64(accountId)))
            }
        } else {
            conditions.append("account_id = ? AND folder = ? AND archived IN (0,1)")
            params.append(.int(Int64(accountId)))
            params.append(.text(folder))
        }
        if let category = options["category"] as? String, !category.isEmpty {
            conditions.append("category = ?")
            params.append(.text(category))
        }
        if options["unread"] as? Bool == true { conditions.append("seen = 0") }
        if options["flagged"] as? Bool == true { conditions.append("flagged = 1") }
        if options["attachments"] as? Bool == true { conditions.append("has_attachments = 1") }

        if let search = (options["search"] as? String)?.trimmingCharacters(in: .whitespaces), !search.isEmpty {
            conditions.append("(subject LIKE ? OR from_addr LIKE ? OR from_name LIKE ? OR body_text LIKE ?)")
            let like = SQLite.Value.text("%\(search)%")
            params.append(contentsOf: [like, like, like, like])
        }

        let order = sortOptions[options["sort"] as? String ?? "date_desc"] ?? "date DESC"
        params.append(.int(Int64(options["limit"] as? Int ?? 200)))
        params.append(.int(Int64(options["offset"] as? Int ?? 0)))

        let rows = (try? SQLite.shared.query(
            """
            SELECT id, account_id, folder, uid, message_id, subject, from_addr, from_name, to_addr, date,
                   snippet, seen, flagged, answered, has_attachments, category, summary, archived,
                   thread_key, size
            FROM messages WHERE \(conditions.joined(separator: " AND "))
            ORDER BY \(order) LIMIT ? OFFSET ?
            """,
            params
        )) ?? []
        return rows.map(header)
    }

    static func row(_ dbId: Int) -> [String: Any]? {
        (try? SQLite.shared.query("SELECT * FROM messages WHERE id = ?", [.int(Int64(dbId))]))?.first
    }

    static func attachments(_ dbId: Int) -> [[String: Any]] {
        let rows = (try? SQLite.shared.query(
            "SELECT id, filename, mime, size, path, cid FROM attachments WHERE message_pk = ?",
            [.int(Int64(dbId))]
        )) ?? []
        return rows.map { row in
            [
                "id": row["id"] ?? 0,
                "filename": row["filename"] ?? "",
                "mime": row["mime"] ?? "",
                "size": row["size"] ?? 0,
                "path": row["path"] ?? "",
                "cid": row["cid"] ?? NSNull()
            ]
        }
    }

    static func full(_ dbId: Int) throws -> [String: Any] {
        guard let row = row(dbId) else { throw BridgeError.message("Zpráva nenalezena.") }
        var out = header(row)
        out["cc"] = row["cc"] ?? ""
        out["bodyHtml"] = row["body_html"] ?? NSNull()
        out["bodyText"] = row["body_text"] ?? NSNull()
        out["attachments"] = attachments(dbId)
        out["detectedLang"] = row["detected_lang"] ?? NSNull()
        out["translationCz"] = row["translation_cz"] ?? NSNull()
        return out
    }

    static func thread(_ dbId: Int) -> [[String: Any]] {
        guard let row = row(dbId), let key = row["thread_key"] as? String, !key.isEmpty else { return [] }
        let rows = (try? SQLite.shared.query(
            """
            SELECT id, account_id, folder, uid, message_id, subject, from_addr, from_name, to_addr, date,
                   snippet, seen, flagged, answered, has_attachments, category, summary, archived,
                   thread_key, size
            FROM messages WHERE thread_key = ? ORDER BY date
            """,
            [.text(key)]
        )) ?? []
        return rows.map(header)
    }

    static func categoryStats(accountId: Int) -> [String: Any] {
        let rows = (try? SQLite.shared.query(
            """
            SELECT COALESCE(category, 'other') AS cat, COUNT(*) AS cnt,
                   SUM(CASE WHEN seen = 0 THEN 1 ELSE 0 END) AS unseen
            FROM messages WHERE account_id = ? AND folder = 'INBOX' AND archived = 0
            GROUP BY cat
            """,
            [.int(Int64(accountId))]
        )) ?? []
        var out: [String: Any] = [:]
        for row in rows {
            out[row["cat"] as? String ?? "other"] = [
                "cnt": row["cnt"] ?? 0, "unseen": row["unseen"] ?? 0
            ]
        }
        return out
    }

    // MARK: - Fronta odeslání

    static func outbox() -> [[String: Any]] {
        let rows = (try? SQLite.shared.query(
            """
            SELECT id, account_id, to_addr, subject, send_at, status, error FROM outbox
            WHERE status != 'sent' OR datetime(created_at) > datetime('now', '-2 days')
            ORDER BY send_at DESC LIMIT 100
            """
        )) ?? []
        return rows.map { row in
            [
                "id": row["id"] ?? 0,
                "accountId": row["account_id"] ?? 0,
                "toAddr": row["to_addr"] ?? "",
                "subject": row["subject"] ?? "",
                "sendAt": row["send_at"] ?? "",
                "status": row["status"] ?? "scheduled",
                "error": row["error"] ?? NSNull()
            ]
        }
    }

    @discardableResult
    static func enqueue(_ draft: [String: Any]) throws -> Int {
        func json(_ value: Any?) -> String {
            guard let value, let data = try? JSONSerialization.data(withJSONObject: value),
                  let text = String(data: data, encoding: .utf8) else { return "[]" }
            return text
        }
        let result = try SQLite.shared.run(
            """
            INSERT INTO outbox (account_id, to_addr, cc, bcc, subject, html, attachments_json,
              inline_json, from_name, in_reply_to, refs, reply_to_db_id, send_at, status)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'scheduled')
            """,
            [
                .int(Int64(draft["accountId"] as? Int ?? 0)),
                .text(draft["to"] as? String ?? ""),
                .text(draft["cc"] as? String ?? ""),
                .text(draft["bcc"] as? String ?? ""),
                .text(draft["subject"] as? String ?? ""),
                .text(draft["html"] as? String ?? ""),
                .text(json(draft["attachmentPaths"])),
                .text(json(draft["inlineImages"])),
                (draft["fromName"] as? String).map { SQLite.Value.text($0) } ?? .null,
                (draft["inReplyTo"] as? String).map { SQLite.Value.text($0) } ?? .null,
                (draft["references"] as? String).map { SQLite.Value.text($0) } ?? .null,
                (draft["replyToDbId"] as? Int).map { SQLite.Value.int(Int64($0)) } ?? .null,
                .text(draft["sendAt"] as? String ?? Formats.iso())
            ]
        )
        return Int(result.lastId)
    }

    static func cancelOutbox(_ id: Int) {
        try? SQLite.shared.run(
            "DELETE FROM outbox WHERE id = ? AND status IN ('scheduled','failed')", [.int(Int64(id))]
        )
    }

    /// Složka pro stažené zprávy a přílohy.
    static var mailDirectory: URL {
        let url = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Quentino/posta", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
}
