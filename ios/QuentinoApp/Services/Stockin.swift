import Foundation

/**
 Naskladnění — naskladnění zboží.

 Zboží dorazí v krabici, někdo ho projde kus po kuse a v e-shopu musí přibýt
 na skladě. Dělá se to u regálu, ne u počítače, takže se to **začíná na
 telefonu** a dokončuje na Macu — a mezi tím se nesmí nic ztratit.

 Naskladnění je proto seznam řádků, ne jeden dokument: každý řádek je kód
 a počet. Řádky se mezi zařízeními slučují po jednom (stejně jako deníky
 poukazů), takže když se na telefonu přidá pět položek a na Macu tři,
 výsledek má osm — bez ohledu na to, které zařízení bylo první.

 Zápis do e-shopu tady není schválně: okno administrace se dá otevřít jen na
 počítači. Telefon naskladnění připraví a pošle ji sdílenou složkou dál.
 */
enum Stockin {
    private static func touch(_ id: String) {
        try? SQLite.shared.run("UPDATE stockin SET updated_at = ? WHERE id = ?",
                               [.text(Formats.iso()), .text(id)])
    }

    private static func shape(_ row: [String: Any]) -> [String: Any] {
        [
            "id": row["id"] ?? "",
            "title": row["title"] ?? "",
            "note": row["note"] ?? "",
            "device": row["device"] ?? "",
            "state": (row["state"] as? String) == "sent" ? "sent" : "open",
            "createdAt": row["created_at"] ?? "",
            "updatedAt": row["updated_at"] ?? "",
            "sentAt": (row["sent_at"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? NSNull(),
            "lines": row["lines"] ?? 0,
            "pieces": row["pieces"] ?? 0
        ]
    }

    private static let counted = """
    SELECT s.*, (SELECT COUNT(*) FROM stockin_items i WHERE i.session_id = s.id) AS lines,
           (SELECT COALESCE(SUM(qty), 0) FROM stockin_items i WHERE i.session_id = s.id) AS pieces
    FROM stockin s
    """

    static func list() -> [[String: Any]] {
        let rows = (try? SQLite.shared.query(
            counted + " ORDER BY (s.state = 'open') DESC, s.updated_at DESC LIMIT 60"
        )) ?? []
        return rows.map(shape)
    }

    static func session(_ id: String) -> Any {
        guard let row = (try? SQLite.shared.query(counted + " WHERE s.id = ?", [.text(id)]))?.first
        else { return NSNull() }
        return shape(row)
    }

    static func create(_ title: String) -> Any {
        let id = "\(Device.id().prefix(6))-\(String(Int(Date().timeIntervalSince1970 * 1000), radix: 36))"
        let at = Formats.iso()
        let stamp = DateFormatter()
        stamp.locale = Locale(identifier: "cs_CZ")
        stamp.dateStyle = .medium
        stamp.timeStyle = .none
        let name = title.isEmpty ? "Naskladnění \(stamp.string(from: Date()))" : title
        try? SQLite.shared.run(
            "INSERT INTO stockin (id, title, device, state, created_at, updated_at) VALUES (?,?,?,'open',?,?)",
            [.text(id), .text(name), .text(Device.name()), .text(at), .text(at)]
        )
        return session(id)
    }

    static func items(_ id: String) -> [[String: Any]] {
        let rows = (try? SQLite.shared.query(
            "SELECT * FROM stockin_items WHERE session_id = ? ORDER BY added_at DESC", [.text(id)]
        )) ?? []
        return rows.map { row in
            [
                "code": row["code"] ?? "",
                "productCode": row["product_code"] ?? "",
                "title": row["title"] ?? "",
                "label": row["label"] ?? "",
                "qty": row["qty"] ?? 0,
                "stockBefore": row["stock_before"] ?? NSNull(),
                "addedAt": row["added_at"] ?? ""
            ]
        }
    }

    /**
     Přidá načtený kód. Když už na naskladnění je, jen se přičte počet.

     Když se nenajde nic, **nic se nepřidá**: naskladnění s řádkem „neznámý kód"
     by se nedala odeslat a při zápisu do e-shopu by se stejně musela řešit
     ručně.
     */
    static func scan(_ id: String, _ raw: String, qty: Int) -> [String: Any] {
        guard let found = Catalog.find(raw) as? [String: Any],
              let code = found["code"] as? String else {
            return ["added": false, "unknown": raw.trimmingCharacters(in: .whitespacesAndNewlines)]
        }
        let count = max(1, qty)
        let existing = (try? SQLite.shared.query(
            "SELECT qty FROM stockin_items WHERE session_id = ? AND code = ?", [.text(id), .text(code)]
        ))?.first

        if existing != nil {
            try? SQLite.shared.run(
                "UPDATE stockin_items SET qty = qty + ? WHERE session_id = ? AND code = ?",
                [.int(Int64(count)), .text(id), .text(code)]
            )
        } else {
            let stock = found["stock"] as? Int
            try? SQLite.shared.run(
                """
                INSERT INTO stockin_items (session_id, code, product_code, title, label, qty, stock_before, added_at)
                VALUES (?,?,?,?,?,?,?,?)
                """,
                [
                    .text(id), .text(code),
                    .text(found["productCode"] as? String ?? ""),
                    .text(found["title"] as? String ?? ""),
                    .text(found["label"] as? String ?? ""),
                    .int(Int64(count)),
                    stock.map { SQLite.Value.int(Int64($0)) } ?? .null,
                    .text(Formats.iso())
                ]
            )
        }
        touch(id)
        let item = items(id).first { ($0["code"] as? String) == code }
        return ["added": true, "item": item ?? NSNull()]
    }

    static func setQty(_ id: String, _ code: String, _ qty: Int) {
        if qty <= 0 {
            try? SQLite.shared.run("DELETE FROM stockin_items WHERE session_id = ? AND code = ?",
                                   [.text(id), .text(code)])
        } else {
            try? SQLite.shared.run("UPDATE stockin_items SET qty = ? WHERE session_id = ? AND code = ?",
                                   [.int(Int64(qty)), .text(id), .text(code)])
        }
        touch(id)
    }

    static func rename(_ id: String, title: String, note: String) {
        try? SQLite.shared.run("UPDATE stockin SET title = ?, note = ?, updated_at = ? WHERE id = ?",
                               [.text(title), .text(note), .text(Formats.iso()), .text(id)])
    }

    static func remove(_ id: String) {
        try? SQLite.shared.run("DELETE FROM stockin_items WHERE session_id = ?", [.text(id)])
        try? SQLite.shared.run("DELETE FROM stockin WHERE id = ?", [.text(id)])
    }

    static func markSent(_ id: String) {
        let at = Formats.iso()
        try? SQLite.shared.run("UPDATE stockin SET state = 'sent', sent_at = ?, updated_at = ? WHERE id = ?",
                               [.text(at), .text(at), .text(id)])
    }

    /**
     Podklad pro zápis do e-shopu.

     Vnitřní čísla (`product_id`, `variant_id`) se doplní z feedu — bez nich
     Upgates zápis nepřijme. Co se dohledat nepodaří, se nezamlčí: vrátí se
     s prázdným `productId` a rozhraní to ukáže jako řádek k ručnímu dořešení.
     */
    static func plan(_ id: String) -> [[String: Any]] {
        items(id).map { item in
            let code = item["code"] as? String ?? ""
            let variant = (try? SQLite.shared.query(
                "SELECT * FROM product_variants WHERE code = ?", [.text(code)]
            ))?.first
            let productCode = (variant?["product_code"] as? String) ?? code
            let product = (try? SQLite.shared.query(
                "SELECT * FROM products WHERE code = ?", [.text(productCode)]
            ))?.first
            let stockNow = (variant?["stock"] as? Int) ?? (product?["stock"] as? Int)
            let before = item["stockBefore"] as? Int

            return [
                "code": code,
                "title": (item["title"] as? String).flatMap { $0.isEmpty ? nil : $0 }
                    ?? (product?["title_cz"] as? String) ?? code,
                "label": item["label"] ?? "",
                "qty": item["qty"] ?? 0,
                "productId": product?["product_id"] ?? "",
                "variantId": variant?["variant_id"] ?? "",
                "stockNow": stockNow.map { $0 as Any } ?? NSNull(),
                "stockBefore": before.map { $0 as Any } ?? NSNull(),
                // Zásoba se od načtení změnila — mezitím se prodalo nebo někdo
                // naskladnil ručně. Není to chyba, ale je to jediná informace,
                // kvůli které se má člověk před odesláním podívat.
                "moved": before != nil && stockNow != nil && before != stockNow
            ]
        }
    }

    // MARK: - Synchronizace mezi zařízeními

    /**
     Sloučení naskladnění ze sdílené složky.

     Počet se bere jako **vyšší z obou stran**, ne jako součet: kdyby se
     sčítalo, každá další synchronizace by počet nafoukla. Odeslané naskladnění
     se nikdy nevrací do stavu „rozpracované" — jednou zapsané zboží se nemá
     naskladnit podruhé.
     */
    static func merge(_ remote: [String: Any]) {
        for row in remote["sessions"] as? [[String: Any]] ?? [] {
            guard let id = row["id"] as? String, !id.isEmpty else { continue }
            try? SQLite.shared.run(
                """
                INSERT INTO stockin (id, title, note, device, state, created_at, updated_at, sent_at)
                VALUES (?,?,?,?,?,?,?,?)
                ON CONFLICT(id) DO UPDATE SET
                  title = CASE WHEN excluded.updated_at > stockin.updated_at THEN excluded.title ELSE stockin.title END,
                  note = CASE WHEN excluded.updated_at > stockin.updated_at THEN excluded.note ELSE stockin.note END,
                  state = CASE WHEN excluded.state = 'sent' THEN 'sent' ELSE stockin.state END,
                  sent_at = CASE WHEN stockin.sent_at = '' THEN excluded.sent_at ELSE stockin.sent_at END,
                  updated_at = MAX(stockin.updated_at, excluded.updated_at)
                """,
                [
                    .text(id),
                    .text(row["title"] as? String ?? ""),
                    .text(row["note"] as? String ?? ""),
                    .text(row["device"] as? String ?? ""),
                    .text((row["state"] as? String) == "sent" ? "sent" : "open"),
                    .text(row["created_at"] as? String ?? Formats.iso()),
                    .text(row["updated_at"] as? String ?? Formats.iso()),
                    .text(row["sent_at"] as? String ?? "")
                ]
            )
        }

        for row in remote["items"] as? [[String: Any]] ?? [] {
            guard let session = row["session_id"] as? String, !session.isEmpty,
                  let code = row["code"] as? String, !code.isEmpty else { continue }
            let stock = row["stock_before"] as? Int
            try? SQLite.shared.run(
                """
                INSERT INTO stockin_items (session_id, code, product_code, title, label, qty, stock_before, added_at)
                VALUES (?,?,?,?,?,?,?,?)
                ON CONFLICT(session_id, code) DO UPDATE SET
                  qty = MAX(stockin_items.qty, excluded.qty),
                  title = CASE WHEN stockin_items.title = '' THEN excluded.title ELSE stockin_items.title END,
                  label = CASE WHEN stockin_items.label = '' THEN excluded.label ELSE stockin_items.label END,
                  stock_before = COALESCE(stockin_items.stock_before, excluded.stock_before)
                """,
                [
                    .text(session), .text(code),
                    .text(row["product_code"] as? String ?? ""),
                    .text(row["title"] as? String ?? ""),
                    .text(row["label"] as? String ?? ""),
                    .int(Int64(row["qty"] as? Int ?? 0)),
                    stock.map { SQLite.Value.int(Int64($0)) } ?? .null,
                    .text(row["added_at"] as? String ?? Formats.iso())
                ]
            )
        }
    }

    /// Co se má poslat do sdílené složky — jen rozpracované a nedávno odeslané.
    static func export() -> [String: Any] {
        let cutoff = Formats.iso(Date().addingTimeInterval(-30 * 86_400))
        let sessions = (try? SQLite.shared.query(
            "SELECT * FROM stockin WHERE state = 'open' OR updated_at > ? ORDER BY updated_at DESC LIMIT 60",
            [.text(cutoff)]
        )) ?? []
        let ids = sessions.compactMap { $0["id"] as? String }
        let items: [[String: Any]] = ids.isEmpty ? [] : ((try? SQLite.shared.query(
            "SELECT * FROM stockin_items WHERE session_id IN (\(ids.map { _ in "?" }.joined(separator: ",")))",
            ids.map { SQLite.Value.text($0) }
        )) ?? [])
        return ["sessions": sessions, "items": items]
    }
}
