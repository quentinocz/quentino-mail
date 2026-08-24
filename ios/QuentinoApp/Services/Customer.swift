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
            ? """
              m.id, m.account_id, m.folder, m.subject, m.from_addr, m.from_name, m.to_addr,
              m.date, m.snippet, m.seen, m.answered, m.has_attachments, m.body_text
              """
            : """
              m.id, m.account_id, m.folder, m.subject, m.from_addr, m.from_name, m.to_addr,
              m.date, m.snippet, m.seen, m.answered, m.has_attachments
              """
        // Rejstřík objednávek se přidává rovnou k řádku: podle něj se pozná
        // potvrzení objednávky, které se ve vlákně ukazuje jako karta, ne
        // jako celý text
        let rows = (try? SQLite.shared.query(
            """
            SELECT \(columns), oi.order_number AS order_number
            FROM messages m
            LEFT JOIN order_index oi ON oi.message_pk = m.id
            WHERE lower(m.from_addr) = ? OR lower(m.to_addr) LIKE ?
            ORDER BY m.date DESC LIMIT 40
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
                "answered": (row["answered"] as? Int ?? 0) == 1,
                "hasAttachments": (row["has_attachments"] as? Int ?? 0) == 1,
                // Příchozí = od zákazníka. Rozhraní čeká `incoming`, ne
                // `outgoing` — dokud se to neshodovalo, tvářily se ve vlákně
                // všechny zprávy jako naše odpovědi.
                "incoming": (row["from_addr"] as? String)?.lowercased() == email,
                /*
                 Je to potvrzení objednávky?

                 Rozhoduje záznam v rejstříku — ten vzniká z rozboru potvrzení
                 a je spolehlivý. Doména odesílatele sama nestačí: e-shop
                 rozesílá poštu přes poskytovatele (`system@upgates.com`),
                 takže shoda s doménou e-shopu neplatí a potvrzení se ve
                 vlákně vypisovala jako obří kus textu místo karty.
                 */
                "isOrderMail": {
                    if let number = row["order_number"] as? String, !number.isEmpty { return true }
                    let from = row["from_addr"] as? String ?? ""
                    let subject = row["subject"] as? String ?? ""
                    let looksLikeOrder = subject.range(
                        of: "(objedn[áa]v|potvrzen[íi]|order\\b|bestellung)",
                        options: [.regularExpression, .caseInsensitive]) != nil
                    if !looksLikeOrder { return false }
                    return Orders.shopMatchesSender(from) || FormMail.isRelaySender(from)
                }(),
                "orderNumber": row["order_number"] ?? NSNull()
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
