import Foundation

/**
 Práce se serverem: složky, stahování zpráv, změny a odesílání.

 Všechno běží po jednom spojení na operaci — na telefonu se aplikace stejně
 uspí a držet otevřené spojení by jen vybíjelo baterii. Volá se z pozadí,
 protože čtení ze socketu blokuje.
 */
enum MailSync {
    private static let headerLimit = 300
    private static var folderCache: [Int: [[String: Any]]] = [:]
    private static let cacheQueue = DispatchQueue(label: "cz.quentino.mail.cache")

    static func forgetFolders(_ accountId: Int) {
        cacheQueue.sync { folderCache[accountId] = nil }
    }

    // MARK: - Spojení

    private static func connect(_ accountId: Int) throws -> (client: IMAP, row: [String: Any]) {
        guard let row = MailStore.accountRow(accountId) else {
            throw BridgeError.message("Účet nenalezen.")
        }
        let email = row["email"] as? String ?? ""
        let password = MailStore.password(for: email)
        guard !password.isEmpty else {
            throw BridgeError.message("Účet \(email) nemá uložené heslo — doplň ho v Nastavení.")
        }
        let client = IMAP(host: row["imap_host"] as? String ?? "",
                          port: row["imap_port"] as? Int ?? 993)
        try client.connect(secure: (row["imap_secure"] as? Int ?? 1) == 1)
        try client.login(user: row["username"] as? String ?? email, password: password)
        return (client, row)
    }

    private static func withClient<T>(_ accountId: Int, _ body: (IMAP) throws -> T) throws -> T {
        let session = try connect(accountId)
        defer { session.client.logout() }
        return try body(session.client)
    }

    static func test(_ config: [String: Any]) throws -> Bool {
        let host = config["imapHost"] as? String ?? ""
        let user = config["username"] as? String ?? config["email"] as? String ?? ""
        var password = config["password"] as? String ?? ""
        if password.isEmpty, let email = config["email"] as? String {
            password = MailStore.password(for: email)
        }
        guard !host.isEmpty, !password.isEmpty else {
            throw BridgeError.message("Vyplň server, uživatele a heslo.")
        }
        let client = IMAP(host: host, port: config["imapPort"] as? Int ?? 993)
        try client.connect(secure: config["imapSecure"] as? Bool ?? true)
        try client.login(user: user, password: password)
        client.logout()

        if let smtpHost = config["smtpHost"] as? String, !smtpHost.isEmpty {
            try SMTP.test(
                host: smtpHost, port: config["smtpPort"] as? Int ?? 465,
                secure: config["smtpSecure"] as? Bool ?? true, user: user, password: password
            )
        }
        return true
    }

    // MARK: - Složky

    static func folders(_ accountId: Int, refresh: Bool) throws -> [[String: Any]] {
        if !refresh, let cached = cacheQueue.sync(execute: { folderCache[accountId] }) { return cached }

        let out = try withClient(accountId) { client -> [[String: Any]] in
            var list: [[String: Any]] = []
            for folder in try client.folders() {
                let status = (try? client.status(folder.path)) ?? IMAP.Status(messages: 0, unseen: 0, uidNext: 0)
                list.append([
                    "path": folder.path,
                    "name": ModifiedUTF7.decode(folder.name),
                    "specialUse": specialUse(flags: folder.flags, path: folder.path) ?? NSNull(),
                    "unseen": status.unseen,
                    "total": status.messages
                ])
            }
            // INBOX první, pak speciální složky, pak abecedně
            return list.sorted { left, right in
                let leftRank = rank(left), rightRank = rank(right)
                if leftRank != rightRank { return leftRank < rightRank }
                return (left["name"] as? String ?? "")
                    .localizedCaseInsensitiveCompare(right["name"] as? String ?? "") == .orderedAscending
            }
        }
        cacheQueue.sync { folderCache[accountId] = out }
        return out
    }

    private static func rank(_ folder: [String: Any]) -> Int {
        if (folder["path"] as? String ?? "").uppercased() == "INBOX" { return 0 }
        switch folder["specialUse"] as? String {
        case "\\Sent": return 1
        case "\\Drafts": return 2
        case "\\Archive": return 3
        case "\\Junk": return 4
        case "\\Trash": return 5
        default: return 6
        }
    }

    /// Server zvláštní složky většinou označí sám; když ne, pozná se podle názvu.
    private static func specialUse(flags: [String], path: String) -> String? {
        let known = ["\\Sent", "\\Drafts", "\\Trash", "\\Junk", "\\Archive", "\\All", "\\Flagged"]
        for flag in flags where known.contains(where: { $0.caseInsensitiveCompare(flag) == .orderedSame }) {
            return known.first { $0.caseInsensitiveCompare(flag) == .orderedSame }
        }
        let lower = ModifiedUTF7.decode(path).lowercased()
        let names: [(String, [String])] = [
            ("\\Sent", ["sent", "odeslan"]),
            ("\\Trash", ["trash", "deleted", "kos", "koš"]),
            ("\\Drafts", ["draft", "koncept"]),
            ("\\Junk", ["junk", "spam", "nevyžád", "nevyzad"]),
            ("\\Archive", ["archive", "archiv"])
        ]
        for (use, candidates) in names where candidates.contains(where: { lower.contains($0) }) {
            return use
        }
        return nil
    }

    static func specialFolder(_ accountId: Int, _ use: String) -> String? {
        let list = cacheQueue.sync { folderCache[accountId] } ?? (try? folders(accountId, refresh: false)) ?? []
        return list.first { ($0["specialUse"] as? String) == use }?["path"] as? String
    }

    // MARK: - Synchronizace

    private static var syncing = Set<String>()

    @discardableResult
    static func sync(accountId: Int, folder: String) throws -> Int {
        let key = "\(accountId)|\(folder)"
        if cacheQueue.sync(execute: { syncing.contains(key) }) { return 0 }
        cacheQueue.sync { _ = syncing.insert(key) }
        defer { cacheQueue.sync { _ = syncing.remove(key) } }

        Bridge.notify("sync:state", ["accountId": accountId, "syncing": true])
        do {
            let stored = try withClient(accountId) { client -> Int in
                let total = try client.select(folder)
                guard total > 0 else { return 0 }
                let start = max(1, total - headerLimit + 1)
                let headers = try client.headers(from: start)
                store(headers, accountId: accountId, folder: folder)
                return headers.count
            }
            Bridge.notify("sync:state", [
                "accountId": accountId, "syncing": false, "lastSync": Formats.iso()
            ])
            Bridge.notify("messages:changed", ["accountId": accountId, "folder": folder])
            return stored
        } catch {
            Bridge.notify("sync:state", [
                "accountId": accountId, "syncing": false, "error": error.readableMessage
            ])
            throw error
        }
    }

    private static func store(_ headers: [IMAP.Header], accountId: Int, folder: String) {
        var uids: [Int] = []
        try? SQLite.shared.transaction {
            for header in headers {
                let parsed = Mime.parseHeadersOnly(header.raw)
                let contentType = (parsed.headers["content-type"] ?? "").lowercased()
                let hasAttachments = contentType.contains("multipart/mixed")
                    || contentType.contains("multipart/related")
                let thread = String((parsed.inReplyTo.isEmpty ? parsed.messageId : parsed.inReplyTo)
                    .replacingOccurrences(of: "[<>]", with: "", options: [.regularExpression])
                    .prefix(255))

                try SQLite.shared.run(
                    """
                    INSERT INTO messages (account_id, folder, uid, message_id, subject, from_addr, from_name,
                      to_addr, cc, date, seen, flagged, answered, has_attachments, thread_key, snippet, size)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'',?)
                    ON CONFLICT(account_id, folder, uid) DO UPDATE SET
                      seen = excluded.seen, flagged = excluded.flagged,
                      answered = excluded.answered, size = excluded.size
                    """,
                    [
                        .int(Int64(accountId)), .text(folder), .int(Int64(header.uid)),
                        .text(parsed.messageId),
                        .text(parsed.subject.isEmpty ? "(bez předmětu)" : parsed.subject),
                        .text(parsed.from?.address ?? ""),
                        .text(parsed.from?.name ?? ""),
                        .text(parsed.to.map { $0.address }.joined(separator: ", ")),
                        .text(parsed.cc.map { $0.address }.joined(separator: ", ")),
                        .text(Formats.iso(parsed.date ?? Date())),
                        .int(header.flags.contains("\\Seen") ? 1 : 0),
                        .int(header.flags.contains("\\Flagged") ? 1 : 0),
                        .int(header.flags.contains("\\Answered") ? 1 : 0),
                        .int(hasAttachments ? 1 : 0),
                        .text(thread.isEmpty ? "uid-\(header.uid)" : thread),
                        .int(Int64(header.size))
                    ]
                )
                uids.append(header.uid)
                if let from = parsed.from, !from.address.isEmpty {
                    rememberContact(from.address, from.name)
                }
            }
        }

        // Co na serveru v tomhle rozsahu není, nemá být ani u nás
        if let smallest = uids.min() {
            let list = uids.map(String.init).joined(separator: ",")
            try? SQLite.shared.run(
                """
                DELETE FROM messages WHERE account_id = ? AND folder = ? AND uid >= ?
                  AND uid NOT IN (\(list)) AND archived = 0
                """,
                [.int(Int64(accountId)), .text(folder), .int(Int64(smallest))]
            )
        }
    }

    private static func rememberContact(_ email: String, _ name: String) {
        try? SQLite.shared.run(
            """
            INSERT INTO contacts (email, name, uses, last_used) VALUES (?,?,1,?)
            ON CONFLICT(email) DO UPDATE SET uses = uses + 1, last_used = excluded.last_used,
              name = CASE WHEN contacts.name = '' THEN excluded.name ELSE contacts.name END
            """,
            [.text(email.lowercased()), .text(name), .text(Formats.iso())]
        )
    }

    static func syncAll() {
        for account in MailStore.accounts() {
            guard let id = account["id"] as? Int else { continue }
            _ = try? folders(id, refresh: true)
            Bridge.notify("folders:changed", ["accountId": id])
            _ = try? sync(accountId: id, folder: "INBOX")
        }
    }

    // MARK: - Celá zpráva

    static func fetchFull(_ dbId: Int) throws {
        guard let row = MailStore.row(dbId) else { throw BridgeError.message("Zpráva nenalezena.") }
        guard (row["fetched_full"] as? Int ?? 0) == 0 else { return }
        let accountId = row["account_id"] as? Int ?? 0
        let folder = row["folder"] as? String ?? "INBOX"
        let uid = row["uid"] as? Int ?? 0

        let raw = try withClient(accountId) { client -> Data in
            _ = try client.select(folder, readOnly: true)
            return try client.body(uid: uid)
        }
        storeParsed(dbId, raw)
    }

    /// Uloží tělo, přílohy i obrázky vložené do textu.
    static func storeParsed(_ dbId: Int, _ raw: Data) {
        let message = Mime.parse(raw)
        var html = message.html

        let directory = MailStore.mailDirectory.appendingPathComponent("\(dbId)", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try? SQLite.shared.run("DELETE FROM attachments WHERE message_pk = ?", [.int(Int64(dbId))])

        for (index, attachment) in message.attachments.enumerated() {
            let safe = attachment.filename
                .replacingOccurrences(of: "/", with: "-")
                .replacingOccurrences(of: ":", with: "-")
            let file = directory.appendingPathComponent("\(index)-\(safe.isEmpty ? "priloha" : safe)")
            try? attachment.data.write(to: file)

            // Obrázek vložený do textu se v HTML nahradí odkazem na soubor,
            // aby ho zobrazila i webová část aplikace
            if let cid = attachment.contentId, attachment.isInline, html != nil {
                let dataUrl = "data:\(attachment.mime);base64,\(attachment.data.base64EncodedString())"
                html = html?.replacingOccurrences(of: "cid:\(cid)", with: dataUrl)
            }
            try? SQLite.shared.run(
                "INSERT INTO attachments (message_pk, filename, mime, size, path, cid) VALUES (?,?,?,?,?,?)",
                [
                    .int(Int64(dbId)), .text(attachment.filename), .text(attachment.mime),
                    .int(Int64(attachment.data.count)), .text(file.path),
                    attachment.contentId.map { SQLite.Value.text($0) } ?? .null
                ]
            )
        }

        let visible = message.attachments.filter { !$0.isInline }.count
        try? SQLite.shared.run(
            """
            UPDATE messages SET body_html = ?, body_text = ?, snippet = ?, fetched_full = 1,
              has_attachments = ? WHERE id = ?
            """,
            [
                html.map { SQLite.Value.text($0) } ?? .null,
                message.text.map { SQLite.Value.text($0) } ?? .null,
                .text(Mime.snippet(html: html, text: message.text)),
                .int(visible > 0 ? 1 : 0),
                .int(Int64(dbId))
            ]
        )
    }

    // MARK: - Změny

    static func setFlag(_ dbId: Int, flag: String, value: Bool) throws {
        guard let row = MailStore.row(dbId) else { return }
        let column = flag == "seen" ? "seen" : "flagged"
        try? SQLite.shared.run("UPDATE messages SET \(column) = ? WHERE id = ?",
                               [.int(value ? 1 : 0), .int(Int64(dbId))])
        let imapFlag = flag == "seen" ? "\\Seen" : "\\Flagged"
        try withClient(row["account_id"] as? Int ?? 0) { client in
            _ = try client.select(row["folder"] as? String ?? "INBOX")
            try client.store(uid: row["uid"] as? Int ?? 0, flag: imapFlag, value: value)
        }
    }

    static func delete(_ dbId: Int) throws {
        guard let row = MailStore.row(dbId) else { return }
        let accountId = row["account_id"] as? Int ?? 0
        let folder = row["folder"] as? String ?? "INBOX"
        let trash = specialFolder(accountId, "\\Trash")

        try withClient(accountId) { client in
            _ = try client.select(folder)
            try client.delete(uid: row["uid"] as? Int ?? 0, trash: trash)
        }
        if (row["archived"] as? Int ?? 0) == 0 {
            try? SQLite.shared.run("DELETE FROM attachments WHERE message_pk = ?", [.int(Int64(dbId))])
            try? SQLite.shared.run("DELETE FROM messages WHERE id = ?", [.int(Int64(dbId))])
        }
        Bridge.notify("messages:changed", ["accountId": accountId, "folder": folder])
    }

    static func move(_ dbId: Int, to target: String) throws {
        guard let row = MailStore.row(dbId), (row["folder"] as? String) != target else { return }
        let accountId = row["account_id"] as? Int ?? 0
        try withClient(accountId) { client in
            _ = try client.select(row["folder"] as? String ?? "INBOX")
            try client.move(uid: row["uid"] as? Int ?? 0, to: target)
        }
        try? SQLite.shared.run("DELETE FROM messages WHERE id = ?", [.int(Int64(dbId))])
        Bridge.notify("messages:changed", ["accountId": accountId])
    }

    /// Archivace: zpráva se stáhne celá a zůstane v zařízení i po smazání ze serveru.
    @discardableResult
    static func archive(_ dbId: Int) throws -> String {
        guard let row = MailStore.row(dbId) else { throw BridgeError.message("Zpráva nenalezena.") }
        let accountId = row["account_id"] as? Int ?? 0
        let folder = row["folder"] as? String ?? "INBOX"

        let raw = try withClient(accountId) { client -> Data in
            _ = try client.select(folder, readOnly: true)
            return try client.body(uid: row["uid"] as? Int ?? 0)
        }
        let file = MailStore.mailDirectory.appendingPathComponent("\(dbId).eml")
        try? raw.write(to: file)
        if (row["fetched_full"] as? Int ?? 0) == 0 { storeParsed(dbId, raw) }

        try? SQLite.shared.run("UPDATE messages SET archived = 1, raw_path = ? WHERE id = ?",
                               [.text(file.path), .int(Int64(dbId))])
        Bridge.notify("messages:changed", ["accountId": accountId, "folder": folder])
        return file.path
    }

    static func emptyTrash(_ accountId: Int) throws -> Int {
        guard let trash = specialFolder(accountId, "\\Trash") else {
            throw BridgeError.message("Složka koše nebyla nalezena.")
        }
        let count = try withClient(accountId) { try $0.emptyTrash(trash) }
        try? SQLite.shared.run(
            """
            DELETE FROM messages WHERE account_id = ? AND folder = ? AND archived = 0
            """,
            [.int(Int64(accountId)), .text(trash)]
        )
        Bridge.notify("messages:changed", ["accountId": accountId, "folder": trash])
        Bridge.notify("folders:changed", ["accountId": accountId])
        return count
    }

    static func quota(_ accountId: Int) -> [String: Any]? {
        // `try?` sloučí obě volitelnosti do jedné, takže stačí jedno rozbalení
        guard let quota = try? withClient(accountId, { $0.quota() }), quota.limit > 0 else { return nil }
        return ["used": quota.used, "limit": quota.limit]
    }

    // MARK: - Odeslání

    static func send(_ draft: [String: Any]) throws {
        let accountId = draft["accountId"] as? Int ?? 0
        guard let row = MailStore.accountRow(accountId) else {
            throw BridgeError.message("Účet nenalezen.")
        }
        let email = row["email"] as? String ?? ""
        let password = MailStore.password(for: email)
        guard !password.isEmpty else {
            throw BridgeError.message("Účet \(email) nemá uložené heslo — doplň ho v Nastavení.")
        }

        var inline: [(cid: String, path: String)] = []
        for item in draft["inlineImages"] as? [[String: Any]] ?? [] {
            guard let cid = item["cid"] as? String, let path = item["path"] as? String else { continue }
            inline.append((cid, path))
        }
        let html = draft["html"] as? String ?? ""
        // Logo podpisu se přiloží samo, když na něj text odkazuje
        if let logo = row["signature_logo"] as? String, !logo.isEmpty,
           html.contains("cid:sig-logo"), !inline.contains(where: { $0.cid == "sig-logo" }) {
            inline.append(("sig-logo", logo))
        }

        let envelope = SMTP.Envelope(
            fromName: draft["fromName"] as? String ?? row["name"] as? String ?? "",
            fromAddress: email,
            to: draft["to"] as? String ?? "",
            cc: draft["cc"] as? String ?? "",
            bcc: draft["bcc"] as? String ?? "",
            subject: draft["subject"] as? String ?? "",
            html: html,
            attachments: draft["attachmentPaths"] as? [String] ?? [],
            inline: inline,
            inReplyTo: (draft["inReplyTo"] as? String).map { Mime.clean($0) },
            references: draft["references"] as? String
        )
        let message = SMTP.build(envelope)

        let recipients = [envelope.to, envelope.cc, envelope.bcc]
            .joined(separator: ",")
            .split(separator: ",")
            .map { Mime.addresses(String($0)).first?.address ?? String($0).trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        guard !recipients.isEmpty else { throw BridgeError.message("Zpráva nemá příjemce.") }

        try SMTP.send(
            host: row["smtp_host"] as? String ?? "",
            port: row["smtp_port"] as? Int ?? 465,
            secure: (row["smtp_secure"] as? Int ?? 1) == 1,
            user: row["username"] as? String ?? email,
            password: password,
            from: email,
            recipients: recipients,
            message: message
        )

        // Kopie do Odeslané pošty na serveru; její selhání odeslání neruší
        if let sent = specialFolder(accountId, "\\Sent") {
            try? withClient(accountId) { client in
                try client.append(folder: sent, message: message)
            }
        }

        if let replyTo = draft["replyToDbId"] as? Int {
            try? SQLite.shared.run("UPDATE messages SET answered = 1 WHERE id = ?", [.int(Int64(replyTo))])
        }
        for list in [envelope.to, envelope.cc, envelope.bcc] where !list.isEmpty {
            for address in Mime.addresses(list) where !address.address.isEmpty {
                rememberContact(address.address, address.name)
            }
        }
    }

    /// Odbaví frontu naplánovaných zpráv.
    static func processOutbox() {
        let due = (try? SQLite.shared.query(
            "SELECT * FROM outbox WHERE status = 'scheduled' AND send_at <= ? ORDER BY send_at LIMIT 10",
            [.text(Formats.iso())]
        )) ?? []

        for item in due {
            let id = item["id"] as? Int ?? 0
            try? SQLite.shared.run("UPDATE outbox SET status = 'sending' WHERE id = ?", [.int(Int64(id))])
            func list(_ key: String) -> [Any] {
                guard let text = item[key] as? String, let data = text.data(using: .utf8),
                      let parsed = try? JSONSerialization.jsonObject(with: data) as? [Any] else { return [] }
                return parsed
            }
            do {
                try send([
                    "accountId": item["account_id"] as? Int ?? 0,
                    "to": item["to_addr"] as? String ?? "",
                    "cc": item["cc"] as? String ?? "",
                    "bcc": item["bcc"] as? String ?? "",
                    "subject": item["subject"] as? String ?? "",
                    "html": item["html"] as? String ?? "",
                    "attachmentPaths": list("attachments_json").compactMap { $0 as? String },
                    "inlineImages": list("inline_json").compactMap { $0 as? [String: Any] },
                    "fromName": item["from_name"] as? String ?? "",
                    "inReplyTo": item["in_reply_to"] as? String ?? "",
                    "references": item["refs"] as? String ?? "",
                    "replyToDbId": item["reply_to_db_id"] as? Int ?? 0
                ])
                try? SQLite.shared.run("UPDATE outbox SET status = 'sent', error = NULL WHERE id = ?",
                                       [.int(Int64(id))])
            } catch {
                try? SQLite.shared.run("UPDATE outbox SET status = 'failed', error = ? WHERE id = ?",
                                       [.text(error.readableMessage), .int(Int64(id))])
            }
            Bridge.notify("outbox:changed")
        }
    }
}
