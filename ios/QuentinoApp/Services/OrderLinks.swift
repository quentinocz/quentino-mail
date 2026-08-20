import Foundation

/**
 Propojení příchozí pošty s objednávkami.

 Když se zákazník ptá na objednávku, měla by taková zpráva vyčnívat — jinak
 zapadne mezi ostatní poštu. Vazba se hledá jen z hlaviček, které jsou
 v databázi tak jako tak: číslo objednávky je v předmětu potvrzení a adresa
 zákazníka v poli „komu". Odpadá tím stahování těl zpráv i jakýkoli dotaz na
 e-shop, takže to jde i na telefonu přes mobilní data.
 */
enum OrderLinks {
    private static let orderSubject = "(objedn[áa]v|order\\b|bestellung)"
    private static let subjectNumber = "(?:č\\.|c\\.|no\\.|nr\\.|#)\\s*(\\d{3,})"
    /// Číslo objednávky kdekoli v textu — pro odpovědi, kde bývá i bez „č."
    private static let anyNumber = "\\b(\\d{5,7})\\b"

    /**
     Projde potvrzení objednávek a zapíše dvojice „číslo objednávky → zákazník".
     Čte se výhradně z hlaviček, takže je to levné i pro tisíce zpráv.
     */
    @discardableResult
    static func reindexOrders(days: Int = 400) -> Int {
        let since = Formats.iso(Date().addingTimeInterval(-Double(days) * 86_400))
        let rows = (try? SQLite.shared.query(
            "SELECT id, subject, from_addr, to_addr, date FROM messages WHERE date >= ? ORDER BY date ASC",
            [.text(since)]
        )) ?? []

        var count = 0
        _ = try? SQLite.shared.transaction {
            for row in rows {
                let subject = row["subject"] as? String ?? ""
                guard matches(subject, orderSubject) else { continue }
                guard Orders.shopMatchesSender(row["from_addr"] as? String ?? "") else { continue }
                guard let number = group(subject, subjectNumber, 1) else { continue }
                let email = normalizedEmail(row["to_addr"] as? String ?? "")
                guard !email.isEmpty, let id = row["id"] as? Int else { continue }

                _ = try? SQLite.shared.run(
                    """
                    INSERT INTO order_index (order_number, customer_email, message_pk, date)
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT(order_number) DO UPDATE SET
                      customer_email = excluded.customer_email,
                      message_pk = excluded.message_pk,
                      date = excluded.date
                    """,
                    [.text(number), .text(email), .int(Int64(id)), .text(row["date"] as? String ?? "")]
                )
                count += 1
            }
        }
        return count
    }

    /**
     Přiřadí příchozí zprávy k objednávkám — i staré, aby šlo dohledat zpětně.
     Nejdřív podle čísla objednávky v předmětu, jinak podle adresy odesílatele;
     u té se bere jeho nejnovější objednávka, protože zákazník se ptá typicky
     na tu poslední.
     */
    @discardableResult
    static func linkMessages(days: Int = 400) -> Int {
        let since = Formats.iso(Date().addingTimeInterval(-Double(days) * 86_400))
        let messages = (try? SQLite.shared.query(
            """
            SELECT m.id, m.subject, m.from_addr, m.date FROM messages m
            LEFT JOIN order_link ol ON ol.message_pk = m.id
            WHERE m.date >= ? AND ol.message_pk IS NULL AND m.folder NOT IN ('Sent', 'Drafts')
            """,
            [.text(since)]
        )) ?? []

        var count = 0
        _ = try? SQLite.shared.transaction {
            for message in messages {
                // Potvrzení objednávky samo o sobě není dotaz zákazníka
                guard !Orders.shopMatchesSender(message["from_addr"] as? String ?? "") else { continue }
                guard let id = message["id"] as? Int else { continue }

                var hit: [String: Any]?
                for number in allGroups(message["subject"] as? String ?? "", anyNumber, 1) {
                    // Zákazník číslo často opíše bez úvodní nuly („23702" místo
                    // „023702"), proto se porovnává číselně, ne jako text
                    hit = (try? SQLite.shared.query(
                        """
                        SELECT order_number, message_pk FROM order_index
                        WHERE CAST(order_number AS INTEGER) = CAST(? AS INTEGER)
                        """,
                        [.text(number)]
                    ))?.first
                    if hit != nil { break }
                }
                if hit == nil {
                    let email = normalizedEmail(message["from_addr"] as? String ?? "")
                    if !email.isEmpty {
                        hit = (try? SQLite.shared.query(
                            """
                            SELECT order_number, message_pk FROM order_index
                            WHERE customer_email = ? ORDER BY date DESC LIMIT 1
                            """,
                            [.text(email)]
                        ))?.first
                    }
                }
                guard let found = hit else { continue }

                var orderMessage = SQLite.Value.null
                if let pk = found["message_pk"] as? Int { orderMessage = .int(Int64(pk)) }
                _ = try? SQLite.shared.run(
                    """
                    INSERT INTO order_link (message_pk, order_number, order_msg_pk, resolved)
                    VALUES (?, ?, ?, 0) ON CONFLICT(message_pk) DO NOTHING
                    """,
                    [.int(Int64(id)), .text(found["order_number"] as? String ?? ""), orderMessage]
                )
                count += 1
            }
        }
        return count
    }

    /// Přeindexuje objednávky i vazby — po synchronizaci a při otevření složky.
    static func refresh() -> [String: Any] {
        let orders = reindexOrders()
        let links = linkMessages()
        return ["orders": orders, "links": links]
    }

    /// Kolik zpráv k objednávkám čeká na odpověď.
    static func pendingCount(accountId: Int?) -> Int {
        let rows: [[String: Any]]?
        if let accountId {
            rows = try? SQLite.shared.query(
                """
                SELECT COUNT(*) AS n FROM order_link ol JOIN messages m ON m.id = ol.message_pk
                WHERE ol.resolved = 0 AND m.answered = 0 AND m.account_id = ?
                """,
                [.int(Int64(accountId))]
            )
        } else {
            rows = try? SQLite.shared.query(
                """
                SELECT COUNT(*) AS n FROM order_link ol JOIN messages m ON m.id = ol.message_pk
                WHERE ol.resolved = 0 AND m.answered = 0
                """
            )
        }
        return rows?.first?["n"] as? Int ?? 0
    }

    /// Ruční označení zprávy jako vyřízené (nebo návrat mezi čekající).
    static func setResolved(messageId: Int, value: Bool) {
        var stamp = SQLite.Value.null
        if value { stamp = .text(Formats.iso(Date())) }
        _ = try? SQLite.shared.run(
            "UPDATE order_link SET resolved = ?, resolved_at = ? WHERE message_pk = ?",
            [.int(value ? 1 : 0), stamp, .int(Int64(messageId))]
        )
    }

    // MARK: - Drobnosti

    private static func normalizedEmail(_ value: String) -> String {
        group(value, "[\\w.+-]+@[\\w-]+\\.[\\w.]{2,}", 0)?.lowercased() ?? ""
    }

    private static func matches(_ text: String, _ pattern: String) -> Bool {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else { return false }
        return regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
    }

    private static func group(_ text: String, _ pattern: String, _ index: Int) -> String? {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]),
              let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              match.numberOfRanges > index,
              let range = Range(match.range(at: index), in: text) else { return nil }
        return String(text[range])
    }

    private static func allGroups(_ text: String, _ pattern: String, _ index: Int) -> [String] {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else { return [] }
        let matches = regex.matches(in: text, range: NSRange(text.startIndex..., in: text))
        return matches.compactMap { match -> String? in
            guard match.numberOfRanges > index, let range = Range(match.range(at: index), in: text) else { return nil }
            return String(text[range])
        }
    }
}
