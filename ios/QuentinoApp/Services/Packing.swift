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

    /**
     Nastaví, kolik kusů položky už je v krabici.

     Seznam odškrtnutých položek se z počtů dopočítá — položka je odškrtnutá
     teprve tehdy, když je v krabici všech svých kusů. Zbytek aplikace se tak
     nemusí ptát dvakrát.
     */
    @discardableResult
    static func setCount(messageId: Int, index: Int, count: Int) -> [String: Any] {
        let qty = qtyOf(messageId: messageId, index: index)
        let value = max(0, min(qty, count))
        var state = packed(messageId)

        if value == 0 { state.counts.removeValue(forKey: String(index)) }
        else { state.counts[String(index)] = value }

        if value >= qty {
            if !state.items.contains(index) { state.items.append(index) }
            state.items.sort()
        } else {
            state.items.removeAll { $0 == index }
        }

        save(messageId: messageId, state: state)
        return payload(state)
    }

    /// Odškrtne (nebo odškrtnutí zruší) celou položku — tedy všechny její kusy.
    @discardableResult
    static func setItem(messageId: Int, index: Int, value: Bool) -> [String: Any] {
        setCount(messageId: messageId, index: index,
                 count: value ? qtyOf(messageId: messageId, index: index) : 0)
    }

    /**
     Načtený kód přiřadí k položce objednávky a přidá jeden kus.

     Na štítku bývá kód varianty, v objednávce může být kód produktu (nebo
     naopak), takže se hledá přes katalog: ten z kódu vrátí obojí a porovnává
     se pak proti oběma. Když je táž položka v objednávce vícekrát, přednost
     dostane ta, které ještě kusy chybí — jinak by se druhý kus neměl kam
     připsat.
     */
    static func scanItem(messageId: Int, raw: String) -> [String: Any] {
        let text = normCode(raw)
        guard !text.isEmpty else { return ["ok": false, "reason": "empty", "message": "Prázdný kód"] }
        guard let card = card(messageId), let items = card["items"] as? [[String: Any]] else {
            return ["ok": false, "reason": "noOrder", "message": "Objednávka není načtená"]
        }

        let found = Catalog.find(text) as? [String: Any]
        var wanted: Set<String> = [text]
        if let code = found?["code"] as? String { wanted.insert(normCode(code)) }
        if let code = found?["productCode"] as? String { wanted.insert(normCode(code)) }
        wanted.remove("")

        var state = packed(messageId)
        let matching = items.enumerated().filter { wanted.contains(normCode($0.element["code"] as? String ?? "")) }

        guard !matching.isEmpty else {
            let title = found?["title"] as? String
            return [
                "ok": false, "reason": "notInOrder",
                "message": title.map { "\($0) v téhle objednávce není" } ?? "Kód \(text) v objednávce není"
            ]
        }

        // Nejdřív položky, kterým ještě kusy chybí
        let spot = matching.first { entry in
            (state.counts[String(entry.offset)] ?? 0) < max(1, entry.element["qty"] as? Int ?? 1)
        } ?? matching[0]

        let qty = max(1, spot.element["qty"] as? Int ?? 1)
        let title = spot.element["title"] as? String ?? ""
        let code = spot.element["code"] as? String
        let before = state.counts[String(spot.offset)] ?? 0

        if before >= qty {
            return [
                "ok": false, "reason": "already", "index": spot.offset,
                "code": code ?? NSNull(), "title": title,
                "count": before, "qty": qty, "needMore": 0,
                "message": "\(title) — všech \(qty) ks už je odškrtnutých"
            ]
        }

        setCount(messageId: messageId, index: spot.offset, count: before + 1)
        state = packed(messageId)
        let count = state.counts[String(spot.offset)] ?? 0
        let needMore = qty - count

        var message = title
        if qty > 1 {
            message = "\(title) — \(count)/\(qty) ks"
            if needMore > 0 { message += ", ještě \(needMore)" }
        }

        return [
            "ok": true, "index": spot.offset, "code": code ?? NSNull(), "title": title,
            "count": count, "qty": qty, "needMore": needMore, "message": message
        ]
    }

    /**
     Stav objednávky z feedu e-shopu.

     U starší objednávky je feed to jediné, co je aktuální: potvrzovací mail
     říká, co si zákazník objednal v den nákupu, ale ne to, že je zásilka dávno
     doručená nebo stornovaná. Právě tohle je potřeba vidět dřív, než někdo
     začne balit něco, co se balit nemá.
     */
    private static func shopState(_ orderNumber: String?) -> [String: Any]? {
        let forms = numberForms(orderNumber ?? "")
        guard !forms.isEmpty else { return nil }
        let row = (try? SQLite.shared.query(
            """
            SELECT code, invoice, status, created_at, updated_at FROM shop_orders
            WHERE code = ? OR code = ? ORDER BY created_at DESC LIMIT 1
            """,
            [.text(forms[0]), .text(forms[forms.count - 1])]
        ))?.first
        guard let row else { return nil }

        let status = row["status"] as? String ?? ""
        let updated = row["updated_at"] as? String ?? ""
        let created = row["created_at"] as? String ?? ""
        let at = !updated.isEmpty ? updated : created
        return [
            "code": row["code"] as? String ?? "",
            "invoice": row["invoice"] as? String ?? "",
            "status": status,
            "at": at.isEmpty ? NSNull() : at,
            "final": OrderTrack.isFinalStatus(status)
        ]
    }

    /// Čísla objednávky, pod kterými se dá hledat — vodicí nuly se všude liší.
    private static func numberForms(_ value: String) -> [String] {
        let digits = value.filter { $0.isNumber }
        guard !digits.isEmpty else { return [] }
        let bare = String(digits.drop { $0 == "0" })
        return (!bare.isEmpty && bare != digits) ? [digits, bare] : [digits]
    }

    /**
     Číslo z QR na faktuře přeložené na čísla objednávek, pod kterými ji hledat.

     Faktura a objednávka mají v e-shopu různá čísla, takže se překlad dělá vždy
     přes feed objednávek — tam stojí faktura vedle svého čísla objednávky.
     Načtené číslo se zkouší i samo o sobě, kdyby se náhodou skenovalo přímo
     číslo objednávky.
     */
    private static func orderNumbers(for raw: String) -> [String] {
        let forms = numberForms(raw)
        guard !forms.isEmpty else { return [] }

        var out = forms
        let rows = (try? SQLite.shared.query(
            """
            SELECT code FROM shop_orders WHERE invoice != '' AND (invoice = ? OR invoice = ?)
            ORDER BY created_at DESC LIMIT 20
            """,
            [.text(forms[0]), .text(forms[forms.count - 1])]
        )) ?? []
        for row in rows {
            for form in numberForms(row["code"] as? String ?? "") where !out.contains(form) {
                out.append(form)
            }
        }
        return out
    }

    /**
     Zpráva s potvrzením objednávky daného čísla — bez ohledu na stáří.

     Běžný seznam k balení sahá jen pár dní zpátky, ale načtená faktura může být
     i půl roku stará; hledá se proto rovnou podle čísla v předmětu, ne v okně.
     */
    private static func message(numbers: [String]) -> Candidate? {
        // Nejdřív hotové karty — u nich se ví, že číslo sedí přesně
        let cached = (try? SQLite.shared.query(
            """
            SELECT c.message_pk AS id, c.json, m.date, m.subject, m.from_addr
            FROM order_cache c JOIN messages m ON m.id = c.message_pk
            WHERE c.json IS NOT NULL ORDER BY m.date DESC LIMIT 800
            """, []
        )) ?? []
        for row in cached {
            guard let text = row["json"] as? String, let data = text.data(using: .utf8),
                  let card = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let id = row["id"] as? Int else { continue }
            let forms = numberForms(card["orderNumber"] as? String ?? "")
            guard forms.contains(where: { numbers.contains($0) }) else { continue }
            return Candidate(id: id, date: row["date"] as? String ?? "",
                             subject: row["subject"] as? String ?? "")
        }

        // Pak podle předmětu — na starší objednávku se karta teprve sestaví
        for number in numbers {
            let rows = (try? SQLite.shared.query(
                """
                SELECT id, date, subject, from_addr FROM messages
                WHERE subject LIKE ? ORDER BY date DESC LIMIT 40
                """,
                [.text("%\(number)%")]
            )) ?? []
            for row in rows {
                guard let id = row["id"] as? Int else { continue }
                let subject = row["subject"] as? String ?? ""
                guard matches(subject, orderSubject) else { continue }
                guard Orders.shopMatchesSender(row["from_addr"] as? String ?? "") else { continue }
                return Candidate(id: id, date: row["date"] as? String ?? "", subject: subject)
            }
        }
        return nil
    }

    /**
     Otevře objednávku podle načteného čísla — i takovou, která je dávno mimo
     seznam k balení.

     Vrací rovnou celou objednávku i s kartou a stavem odškrtání, aby ji
     rozhraní mohlo přidat do seznamu, i když do zvoleného období nepatří.
     `shop` nese stav z feedu; u konečného stavu (doručeno, storno) se
     v rozhraní ukáže výstraha, že jde o starší objednávku.
     */
    static func openOrder(_ raw: String) async -> [String: Any]? {
        let numbers = orderNumbers(for: raw)
        guard !numbers.isEmpty, let found = message(numbers: numbers) else { return nil }

        var card = cached(found.id)
        if card == nil {
            card = await Orders.card(dbId: found.id)
            Orders.writeCache(found.id, card)
        }
        guard let order = card else { return nil }

        let state = packed(found.id)
        var out = payload(state)
        out["messageId"] = found.id
        out["date"] = found.date
        out["card"] = order
        out["shop"] = shopState(order["orderNumber"] as? String) ?? NSNull()
        return out
    }

    /// Označí celou objednávku jako zabalenou (nebo označení zruší).
    static func setDone(messageId: Int, value: Bool) {
        var state = packed(messageId)
        state.done = value
        state.doneAt = value ? Formats.iso(Date()) : nil
        save(messageId: messageId, state: state)
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
                "counts": state.counts,
                "done": state.done,
                "doneAt": doneAt,
                "shop": shopState(order["orderNumber"] as? String) ?? NSNull()
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

    private struct State {
        var items: [Int]
        /// Index položky → kolik kusů z ní už je v krabici
        var counts: [String: Int]
        var done: Bool
        var doneAt: String?
    }

    private static func packed(_ messageId: Int) -> State {
        let row = (try? SQLite.shared.query(
            "SELECT packed_json, counts_json, done, done_at FROM packing WHERE message_pk = ?",
            [.int(Int64(messageId))]
        ))?.first
        guard let row else { return State(items: [], counts: [:], done: false, doneAt: nil) }

        var items: [Int] = []
        if let text = row["packed_json"] as? String, let data = text.data(using: .utf8),
           let parsed = try? JSONSerialization.jsonObject(with: data) as? [Int] {
            items = parsed
        }
        var counts: [String: Int] = [:]
        if let text = row["counts_json"] as? String, let data = text.data(using: .utf8),
           let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Int] {
            counts = parsed
        }

        /*
         Záznamy z doby před počítáním kusů mají jen seznam odškrtnutých
         položek. Odškrtnutá položka znamenala „celá zabalená", takže se
         dopočítá na plný počet — jinak by po aktualizaci vypadalo rozdělané
         balení jako nezačaté.
         */
        if counts.isEmpty, !items.isEmpty {
            for index in items {
                counts[String(index)] = qtyOf(messageId: messageId, index: index)
            }
        }

        return State(items: items, counts: counts,
                     done: (row["done"] as? Int ?? 0) == 1, doneAt: row["done_at"] as? String)
    }

    private static func save(messageId: Int, state: State) {
        var doneAt = SQLite.Value.null
        if let stamp = state.doneAt { doneAt = .text(stamp) }
        _ = try? SQLite.shared.run(
            """
            INSERT INTO packing (message_pk, packed_json, counts_json, done, done_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(message_pk) DO UPDATE SET packed_json = excluded.packed_json,
              counts_json = excluded.counts_json, done = excluded.done, done_at = excluded.done_at
            """,
            [.int(Int64(messageId)), .text(json(state.items)), .text(json(state.counts)),
             .int(state.done ? 1 : 0), doneAt]
        )
    }

    private static func payload(_ state: State) -> [String: Any] {
        [
            "packed": state.items,
            "counts": state.counts,
            "done": state.done,
            "doneAt": state.doneAt ?? NSNull()
        ]
    }

    /// Karta objednávky z uložených podkladů — bez ohledu na stáří, jen kvůli počtům.
    private static func card(_ messageId: Int) -> [String: Any]? {
        let row = (try? SQLite.shared.query(
            "SELECT json FROM order_cache WHERE message_pk = ?", [.int(Int64(messageId))]
        ))?.first
        guard let text = row?["json"] as? String, let data = text.data(using: .utf8) else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }

    /// Kolik kusů má být u položky — z uložené karty, s pojistkou na jeden kus.
    private static func qtyOf(messageId: Int, index: Int) -> Int {
        guard let items = card(messageId)?["items"] as? [[String: Any]],
              index >= 0, index < items.count else { return 1 }
        return max(1, items[index]["qty"] as? Int ?? 1)
    }

    /**
     Kód ze štítku do porovnatelné podoby.

     Na vlastních QR je „quentino:PS120CRV", na těch z e-shopu celá adresa
     produktu — a v objednávce je holý kód. Bez tohohle by se nesešly.
     */
    private static func normCode(_ raw: String) -> String {
        var code = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if let range = code.range(of: "^quentino:", options: [.regularExpression, .caseInsensitive]) {
            code = String(code[range.upperBound...])
        }
        if let range = code.range(of: "^.*/p/", options: .regularExpression) {
            code = String(code[range.upperBound...])
        }
        return code.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
    }

    private static func json(_ value: Any) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: value),
              let text = String(data: data, encoding: .utf8) else { return "[]" }
        return text
    }

    private static func matches(_ text: String, _ pattern: String) -> Bool {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else { return false }
        return regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
    }
}
