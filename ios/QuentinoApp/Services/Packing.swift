import Foundation

/**
 Podklady pro balení objednávek.

 Objednávky se sbírají z potvrzovacích e-mailů: projdou se zprávy za zvolené
 období, z každé se sestaví karta objednávky a výsledek se uloží do
 `order_cache`, aby se při dalším otevření nemuselo stahovat nic než živý stav.

 Na telefonu je to jediná obrazovka, která umí běžet klidně minutu — proto se
 průběh hlásí událostí `packing:progress`, ať je vidět, co se děje.
 */
enum Packing {
    /// Jak dlouho platí uložená karta u objednávky, která se ještě může měnit.
    private static let cacheTtl: TimeInterval = 600
    private static let orderSubject = "(objedn[áa]v|order\\b|bestellung)"
    private static let subjectNumber = "(?:č\\.|c\\.|no\\.|nr\\.|#)\\s*\\d{3,}"

    // MARK: - Odškrtávání

    /// Odškrtne (nebo odškrtnutí zruší) jednu položku objednávky.
    static func setItem(messageId: Int, index: Int, value: Bool) -> [Int] {
        let current = packed(messageId)
        var next = current.items
        if value {
            if !next.contains(index) { next.append(index) }
            next.sort()
        } else {
            next.removeAll { $0 == index }
        }

        var doneAt = SQLite.Value.null
        if let stamp = current.doneAt { doneAt = .text(stamp) }
        _ = try? SQLite.shared.run(
            """
            INSERT INTO packing (message_pk, packed_json, done, done_at) VALUES (?, ?, ?, ?)
            ON CONFLICT(message_pk) DO UPDATE SET packed_json = excluded.packed_json
            """,
            [.int(Int64(messageId)), .text(json(next)), .int(current.done ? 1 : 0), doneAt]
        )
        return next
    }

    /// Označí celou objednávku jako zabalenou (nebo označení zruší).
    static func setDone(messageId: Int, value: Bool) {
        let current = packed(messageId)
        var doneAt = SQLite.Value.null
        if value { doneAt = .text(Formats.iso(Date())) }
        _ = try? SQLite.shared.run(
            """
            INSERT INTO packing (message_pk, packed_json, done, done_at) VALUES (?, ?, ?, ?)
            ON CONFLICT(message_pk) DO UPDATE SET done = excluded.done, done_at = excluded.done_at
            """,
            [.int(Int64(messageId)), .text(json(current.items)), .int(value ? 1 : 0), doneAt]
        )
    }

    /// Vynuluje odškrtání u objednávky.
    static func reset(messageId: Int) {
        _ = try? SQLite.shared.run("DELETE FROM packing WHERE message_pk = ?", [.int(Int64(messageId))])
    }

    // MARK: - Sken

    /**
     Projde e-maily za zvolené období a sestaví seznam objednávek k balení.

     `force` přeskočí uložené karty — hodí se, když se stav objednávky změnil
     dřív, než vypršela desetiminutová platnost.
     */
    static func scan(days: Int, force: Bool = false) async -> [String: Any] {
        let list = candidates(days: days)
        var orders: [[String: Any]] = []
        var statuses: Set<String> = []

        Bridge.notify("packing:progress", ["done": 0, "total": list.count, "label": NSNull()])

        for (index, candidate) in list.enumerated() {
            Bridge.notify("packing:progress", [
                "done": index, "total": list.count, "label": candidate.subject
            ])

            var card = force ? nil : cached(candidate.id)
            if card == nil {
                card = await Orders.card(dbId: candidate.id)
                Orders.writeCache(candidate.id, card)
            }
            guard let order = card else { continue }

            let tracking = order["tracking"] as? [String: Any]
            let live = order["live"] as? [String: Any]
            if let status = (tracking?["status"] as? String) ?? (live?["status"] as? String), !status.isEmpty {
                statuses.insert(status)
            }

            let state = packed(candidate.id)
            var doneAt: Any = NSNull()
            if let stamp = state.doneAt { doneAt = stamp }
            orders.append([
                "messageId": candidate.id,
                "date": candidate.date,
                "card": order,
                "packed": state.items,
                "done": state.done,
                "doneAt": doneAt
            ])
        }

        Bridge.notify("packing:progress", ["done": list.count, "total": list.count, "label": NSNull()])

        return [
            "orders": orders,
            "statuses": statuses.sorted { $0.localizedStandardCompare($1) == .orderedAscending },
            "scannedAt": Formats.iso(Date())
        ]
    }

    // MARK: - Vnitřnosti

    private struct Candidate {
        let id: Int
        let date: String
        let subject: String
    }

    /// Zprávy, které podle hlavičky vypadají na potvrzení objednávky z našeho e-shopu.
    private static func candidates(days: Int) -> [Candidate] {
        let since = Formats.iso(Date().addingTimeInterval(-Double(days) * 86_400))
        let rows = (try? SQLite.shared.query(
            """
            SELECT id, date, subject, from_addr FROM messages
            WHERE date >= ? ORDER BY date DESC LIMIT 400
            """,
            [.text(since)]
        )) ?? []

        return rows.compactMap { row -> Candidate? in
            guard let id = row["id"] as? Int else { return nil }
            let subject = row["subject"] as? String ?? ""
            guard matches(subject, orderSubject), matches(subject, subjectNumber) else { return nil }
            guard Orders.shopMatchesSender(row["from_addr"] as? String ?? "") else { return nil }
            return Candidate(id: id, date: row["date"] as? String ?? "", subject: subject)
        }
    }

    /**
     Uložená karta objednávky.

     Doručené a stornované objednávky se už nezmění — ty se znovu nenačítají
     ani při ručním obnovení, jinak by každý sken zbytečně stahoval historii.
     Výjimkou jsou starší záznamy uložené ještě bez stavu zásilky.
     */
    private static func cached(_ messageId: Int) -> [String: Any]? {
        let row = (try? SQLite.shared.query(
            "SELECT json, at FROM order_cache WHERE message_pk = ?", [.int(Int64(messageId))]
        ))?.first
        guard let row else { return nil }
        guard let text = row["json"] as? String, let data = text.data(using: .utf8),
              let card = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }

        let tracking = card["tracking"] as? [String: Any]
        let live = card["live"] as? [String: Any]
        let status = (tracking?["status"] as? String) ?? (live?["status"] as? String)
        let hasCode = (tracking?["trackingCode"] as? String)?.isEmpty == false
        let hasEvent = (tracking?["shipment"] as? [String: Any]) != nil
        if OrderTrack.isFinalStatus(status), !(hasCode && !hasEvent) { return card }

        guard let stamp = Formats.date(row["at"] as? String),
              Date().timeIntervalSince(stamp) <= cacheTtl else { return nil }
        return card
    }

    private static func packed(_ messageId: Int) -> (items: [Int], done: Bool, doneAt: String?) {
        let row = (try? SQLite.shared.query(
            "SELECT packed_json, done, done_at FROM packing WHERE message_pk = ?", [.int(Int64(messageId))]
        ))?.first
        guard let row else { return ([], false, nil) }

        var items: [Int] = []
        if let text = row["packed_json"] as? String, let data = text.data(using: .utf8),
           let parsed = try? JSONSerialization.jsonObject(with: data) as? [Int] {
            items = parsed
        }
        return (items, (row["done"] as? Int ?? 0) == 1, row["done_at"] as? String)
    }

    private static func json(_ value: [Int]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: value),
              let text = String(data: data, encoding: .utf8) else { return "[]" }
        return text
    }

    private static func matches(_ text: String, _ pattern: String) -> Bool {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else { return false }
        return regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
    }
}
