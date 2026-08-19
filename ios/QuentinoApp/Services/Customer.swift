import Foundation

/**
 Historie komunikace se zákazníkem.

 Čte jen z toho, co je v zařízení stažené — žádné volání na server. Používá
 se v kartě zprávy („co jsme si s tímhle člověkem už psali") a jako podklad
 pro návrh odpovědi.
 */
enum Customer {
    static func search(contacts query: String, limit: Int = 8) -> [[String: Any]] {
        let text = query.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else { return [] }
        let like = SQLite.Value.text("%\(text)%")
        let rows = (try? SQLite.shared.query(
            """
            SELECT email, name FROM contacts WHERE email LIKE ? OR name LIKE ?
            ORDER BY uses DESC, last_used DESC LIMIT ?
            """,
            [like, like, .int(Int64(limit))]
        )) ?? []
        return rows.map { ["email": $0["email"] ?? "", "name": $0["name"] ?? ""] }
    }

    /// Přehled: kdo to je, kolik zpráv a jaké objednávky.
    static func context(email rawEmail: String, withBodies: Bool) async -> [String: Any] {
        let email = rawEmail.trimmingCharacters(in: .whitespaces).lowercased()
        guard email.contains("@") else {
            return ["email": rawEmail, "name": "", "messages": [], "orders": [], "total": 0]
        }

        let columns = withBodies
            ? "id, account_id, folder, subject, from_addr, from_name, to_addr, date, snippet, seen, body_text"
            : "id, account_id, folder, subject, from_addr, from_name, to_addr, date, snippet, seen"
        let rows = (try? SQLite.shared.query(
            """
            SELECT \(columns) FROM messages
            WHERE lower(from_addr) = ? OR lower(to_addr) LIKE ?
            ORDER BY date DESC LIMIT 40
            """,
            [.text(email), .text("%\(email)%")]
        )) ?? []

        let name = rows.compactMap { row -> String? in
            guard (row["from_addr"] as? String)?.lowercased() == email else { return nil }
            let value = row["from_name"] as? String ?? ""
            return value.isEmpty ? nil : value
        }.first ?? ""

        let messages = rows.map { row -> [String: Any] in
            var item: [String: Any] = [
                "id": row["id"] ?? 0,
                "folder": row["folder"] ?? "",
                "subject": row["subject"] ?? "",
                "date": row["date"] ?? "",
                "snippet": row["snippet"] ?? "",
                "seen": (row["seen"] as? Int ?? 0) == 1,
                // Odchozí zprávu poznáme podle toho, že adresa je v příjemcích
                "outgoing": (row["from_addr"] as? String)?.lowercased() != email
            ]
            if withBodies { item["text"] = row["body_text"] ?? NSNull() }
            return item
        }

        var orders: [[String: Any]] = []
        if Upgates.isReady { orders = (try? await Upgates.orders(email: email)) ?? [] }

        return [
            "email": email,
            "name": name,
            "messages": messages,
            "orders": orders,
            "total": messages.count
        ]
    }

    /// Text jedné zprávy bez citací — stáhne tělo, pokud ještě chybí.
    static func messageText(_ dbId: Int) async throws -> String {
        try await Task.detached(priority: .userInitiated) { try? MailSync.fetchFull(dbId) }.value
        guard let row = MailStore.row(dbId) else { throw BridgeError.message("Zpráva nenalezena.") }
        let body = row["body_text"] as? String
            ?? (row["body_html"] as? String).map { Mime.snippet(html: $0, text: nil, limit: 8000) }
            ?? row["snippet"] as? String ?? ""

        // Citovaná část odpovědi začíná řádky s „>" nebo oddělovačem klienta
        var lines: [String] = []
        for line in body.components(separatedBy: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix(">") { break }
            if trimmed.range(of: "^(-{2,}\\s*(Původní|Original|Forwarded)|Dne .* napsal|On .* wrote)",
                             options: [.regularExpression, .caseInsensitive]) != nil { break }
            lines.append(line)
        }
        return lines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
