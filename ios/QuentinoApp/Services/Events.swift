import Foundation

/**
 Události, které čísla vysvětlují.

 Sesterský modul k `src/main/events.ts`. Z feedu se pozná, že týden byl
 slabý — ne proč; jestli byla dovolená, inventura, nebo prostě nikdo
 nekupoval. Tuhle jedinou větu ví jen člověk, a to jen chvíli.

 ## Proč to je i v telefonu

 Zapisuje se, když si na to člověk vzpomene — a to bývá u kávy, ne
 u počítače. Dokud to uměl jen počítač, dovolená zapsaná nebyla vůbec,
 a v přehledu pak zely nevysvětlené propady. Události se navíc sdílejí:
 zapsané kdekoli platí všude, slučuje se podle `uid` a **novější zápis
 vyhrává**. Smazání je značka, ne výmaz — jinak by se událost vrátila
 z druhého zařízení, kde o smazání nikdo neví.

 Dopad se počítá stejně jako na počítači: co se dělo v dnech události
 proti běžnému dni **před** ní (čtyři týdny, bez dnů jiných událostí).
 Je to odhad, ne účetnictví, a tak je to i popsané.
 */
enum Events {
    static let kinds = ["akce", "dovolena", "inventura", "jine"]

    /// Kolik dní před událostí se bere jako „běžný provoz"
    private static let baseDays = 28

    private static func ensureTable() {
        _ = try? SQLite.shared.run("""
            CREATE TABLE IF NOT EXISTS shop_events (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              kind TEXT NOT NULL DEFAULT 'jine',
              title TEXT NOT NULL DEFAULT '',
              from_day TEXT NOT NULL,
              to_day TEXT NOT NULL,
              note TEXT NOT NULL DEFAULT '',
              created_at TEXT NOT NULL DEFAULT ''
            )
            """)
        _ = try? SQLite.shared.run("CREATE INDEX IF NOT EXISTS idx_shop_events_from ON shop_events(from_day)")
        /*
         Sloupce přibyly později — u databáze z minulé verze se doplní,
         u nové projde `ALTER` naprázdno.
         */
        for sql in [
            "ALTER TABLE shop_events ADD COLUMN source TEXT NOT NULL DEFAULT 'rucne'",
            "ALTER TABLE shop_events ADD COLUMN source_id TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE shop_events ADD COLUMN source_hash TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE shop_events ADD COLUMN uid TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE shop_events ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE shop_events ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0"
        ] {
            _ = try? SQLite.shared.run(sql)
        }
        // Události zapsané před sdílením — bez uid by se neměly čím představit
        let stare = (try? SQLite.shared.query("SELECT id, created_at FROM shop_events WHERE uid = ''")) ?? []
        for row in stare {
            guard let id = row["id"] as? Int else { continue }
            _ = try? SQLite.shared.run(
                "UPDATE shop_events SET uid = ?, updated_at = CASE WHEN updated_at = '' THEN ? ELSE updated_at END WHERE id = ?",
                [.text(UUID().uuidString), .text(row["created_at"] as? String ?? ""), .int(Int64(id))])
        }
    }

    private static func day(_ value: Any?) -> String {
        let text = String(describing: value ?? "").prefix(10)
        let parts = text.split(separator: "-")
        guard parts.count == 3, parts[0].count == 4, text.count == 10 else { return "" }
        return String(text)
    }

    private static func shift(_ dayText: String, _ by: Int) -> String {
        guard let at = Formats.date("\(dayText)T12:00:00Z") else { return dayText }
        return String(Formats.iso(at.addingTimeInterval(Double(by) * 86_400)).prefix(10))
    }

    /// Kolik dní má období včetně obou krajů
    private static func span(_ from: String, _ to: String) -> Int {
        guard let a = Formats.date("\(from)T12:00:00Z"), let b = Formats.date("\(to)T12:00:00Z") else { return 1 }
        return max(1, Int(((b.timeIntervalSince(a)) / 86_400).rounded()) + 1)
    }

    private static func row(_ one: [String: Any]) -> [String: Any] {
        [
            "id": one["id"] as? Int ?? 0,
            "kind": one["kind"] as? String ?? "jine",
            "title": one["title"] as? String ?? "",
            "from": one["from_day"] as? String ?? "",
            "to": one["to_day"] as? String ?? "",
            "note": one["note"] as? String ?? "",
            "createdAt": one["created_at"] as? String ?? "",
            "source": one["source"] as? String ?? "rucne"
        ]
    }

    static func list() -> [[String: Any]] {
        ensureTable()
        let rows = (try? SQLite.shared.query(
            "SELECT * FROM shop_events WHERE deleted = 0 ORDER BY from_day DESC, id DESC")) ?? []
        return rows.map(row)
    }

    /**
     Uložení. Otočené datum se narovná — kdo píše „od 20. do 15.", myslel
     obojí naopak a chyba by jinak tiše nastavila prázdné období.
     */
    static func save(_ patch: [String: Any]) throws -> [[String: Any]] {
        ensureTable()
        let from = day(patch["from"])
        var to = day(patch["to"])
        if to.isEmpty { to = from }
        guard !from.isEmpty else { throw BridgeError.message("Událost musí mít datum.") }
        let title = (patch["title"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else {
            throw BridgeError.message("Událost musí mít název — za rok už nikdo nepozná, co to bylo.")
        }
        let kind = kinds.contains(patch["kind"] as? String ?? "") ? (patch["kind"] as! String) : "jine"
        let note = (patch["note"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let start = from <= to ? from : to
        let end = from <= to ? to : from
        let now = Formats.iso(Date())

        if let id = patch["id"] as? Int, id > 0 {
            _ = try? SQLite.shared.run(
                "UPDATE shop_events SET kind = ?, title = ?, from_day = ?, to_day = ?, note = ?, updated_at = ? WHERE id = ?",
                [.text(kind), .text(title), .text(start), .text(end), .text(note), .text(now), .int(Int64(id))])
        } else {
            _ = try? SQLite.shared.run(
                """
                INSERT INTO shop_events (kind, title, from_day, to_day, note, created_at, uid, updated_at)
                VALUES (?,?,?,?,?,?,?,?)
                """,
                [.text(kind), .text(title), .text(start), .text(end), .text(note),
                 .text(now), .text(UUID().uuidString), .text(now)])
        }
        share()
        return list()
    }

    /**
     Smazání je **značka**, ne výmaz — jinak by se událost vrátila při první
     synchronizaci z druhého zařízení, kde o smazání nikdo neví.
     */
    static func remove(_ id: Int) -> [[String: Any]] {
        ensureTable()
        _ = try? SQLite.shared.run("UPDATE shop_events SET deleted = 1, updated_at = ? WHERE id = ?",
                                   [.text(Formats.iso(Date())), .int(Int64(id))])
        share()
        return list()
    }

    // MARK: - Sdílení mezi zařízeními

    /// Všechny události k odeslání — **včetně smazaných**, jinak by je druhá strana poslala zpátky
    static func export() -> [[String: Any]] {
        ensureTable()
        let rows = (try? SQLite.shared.query("SELECT * FROM shop_events")) ?? []
        return rows.compactMap { one in
            let uid = one["uid"] as? String ?? ""
            guard !uid.isEmpty else { return nil }
            return [
                "uid": uid,
                "kind": one["kind"] as? String ?? "jine",
                "title": one["title"] as? String ?? "",
                "from": one["from_day"] as? String ?? "",
                "to": one["to_day"] as? String ?? "",
                "note": one["note"] as? String ?? "",
                "createdAt": one["created_at"] as? String ?? "",
                "updatedAt": one["updated_at"] as? String ?? one["created_at"] as? String ?? "",
                "deleted": (one["deleted"] as? Int ?? 0) == 1,
                "source": one["source"] as? String ?? "rucne",
                "sourceId": one["source_id"] as? String ?? "",
                "sourceHash": one["source_hash"] as? String ?? ""
            ]
        }
    }

    /// Sloučení toho, co přišlo odjinud. **Novější zápis vyhrává.**
    @discardableResult
    static func importShare(_ data: Any?) -> Bool {
        guard let list = data as? [[String: Any]] else { return false }
        ensureTable()

        var mine: [String: (id: Int, updated: String)] = [:]
        for one in (try? SQLite.shared.query("SELECT id, uid, updated_at, created_at FROM shop_events")) ?? [] {
            guard let uid = one["uid"] as? String, !uid.isEmpty, let id = one["id"] as? Int else { continue }
            let updated = (one["updated_at"] as? String).flatMap { $0.isEmpty ? nil : $0 }
                ?? (one["created_at"] as? String ?? "")
            mine[uid] = (id, updated)
        }

        var changed = false
        for one in list {
            let uid = (one["uid"] as? String ?? "").trimmingCharacters(in: .whitespaces)
            let from = day(one["from"])
            guard !uid.isEmpty, !from.isEmpty else { continue }
            let updated = (one["updatedAt"] as? String) ?? (one["createdAt"] as? String) ?? ""
            if let found = mine[uid], found.updated >= updated { continue }
            let kind = kinds.contains(one["kind"] as? String ?? "") ? (one["kind"] as! String) : "jine"
            var to = day(one["to"])
            if to.isEmpty { to = from }
            let values: [SQLite.Value] = [
                .text(kind), .text(one["title"] as? String ?? ""), .text(from), .text(to),
                .text(one["note"] as? String ?? ""), .text(updated),
                .int((one["deleted"] as? Bool ?? false) ? 1 : 0),
                .text(one["source"] as? String ?? "rucne"),
                .text(one["sourceId"] as? String ?? ""),
                .text(one["sourceHash"] as? String ?? "")
            ]
            if let found = mine[uid] {
                _ = try? SQLite.shared.run(
                    """
                    UPDATE shop_events SET kind = ?, title = ?, from_day = ?, to_day = ?, note = ?,
                      updated_at = ?, deleted = ?, source = ?, source_id = ?, source_hash = ? WHERE id = ?
                    """, values + [.int(Int64(found.id))])
            } else {
                _ = try? SQLite.shared.run(
                    """
                    INSERT INTO shop_events (kind, title, from_day, to_day, note, updated_at, deleted,
                      source, source_id, source_hash, uid, created_at)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
                    """, values + [.text(uid), .text((one["createdAt"] as? String) ?? updated)])
            }
            changed = true
        }
        return changed
    }

    /// Rozeslání ostatním zařízením; když posel nedrží, dojde to sdílenou složkou
    private static func share() {
        if Live.isEnabled() { Live.publish("events", export()) }
    }

    // MARK: - Co se v událostech dělo

    private struct Totals { var orders = 0; var revenue = 0.0 }

    private static func sumOrders(_ from: String, _ to: String, currency: String, skip: Set<String>) -> Totals {
        let rows = (try? SQLite.shared.query(
            """
            SELECT created_at, status, currency, total FROM shop_orders
             WHERE substr(created_at, 1, 10) >= ? AND substr(created_at, 1, 10) <= ?
            """, [.text(from), .text(to)])) ?? []
        var out = Totals()
        for row in rows {
            let at = String((row["created_at"] as? String ?? "").prefix(10))
            if skip.contains(at) { continue }
            let status = row["status"] as? String ?? ""
            if status.range(of: "storn|cancel|zrus|zruš", options: [.regularExpression, .caseInsensitive]) != nil {
                continue
            }
            out.orders += 1
            if (row["currency"] as? String ?? "CZK").uppercased() == currency {
                out.revenue += row["total"] as? Double ?? Double(row["total"] as? Int ?? 0)
            }
        }
        return out
    }

    private static func postsBetween(_ from: String, _ to: String) -> (posts: Int, likes: Int, comments: Int) {
        let rows = (try? SQLite.shared.query(
            """
            SELECT like_count, comment_count FROM ig_source_posts
             WHERE substr(posted_at, 1, 10) >= ? AND substr(posted_at, 1, 10) <= ?
            """, [.text(from), .text(to)])) ?? []
        return (rows.count,
                rows.reduce(0) { $0 + ($1["like_count"] as? Int ?? 0) },
                rows.reduce(0) { $0 + ($1["comment_count"] as? Int ?? 0) })
    }

    /**
     Události i s tím, co se v nich dělo.

     Porovnává se s běžným dnem **před** událostí, ne s ročním průměrem:
     sezóna sama o sobě zvedá čísla natolik, že by akce v prosinci vyšla
     skvěle, i kdyby nebyla.
     */
    static func withImpact(currency: String = "CZK", today: String = String(Formats.iso(Date()).prefix(10))) -> [[String: Any]] {
        let all = list()
        // Dny, které patří nějaké události — základ se z nich nesmí počítat
        var busy = Set<String>()
        for one in all {
            let from = one["from"] as? String ?? ""
            let to = one["to"] as? String ?? from
            guard !from.isEmpty else { continue }
            var at = from
            var guardCount = 0
            while at <= to && guardCount < 400 {
                busy.insert(at)
                at = shift(at, 1)
                guardCount += 1
            }
        }

        return all.map { one in
            let from = one["from"] as? String ?? ""
            let to = one["to"] as? String ?? from
            let days = span(from, to)
            let future = from > today
            let inside = sumOrders(from, to, currency: currency, skip: [])

            let baseFrom = shift(from, -baseDays)
            let baseTo = shift(from, -1)
            let skip = busy.filter { $0 >= baseFrom && $0 <= baseTo }
            let baseDayCount = max(1, baseDays - skip.count)
            let base = sumOrders(baseFrom, baseTo, currency: currency, skip: skip)

            let perDay = Double(inside.orders) / Double(days)
            let basePerDay = Double(base.orders) / Double(baseDayCount)
            let baseMoneyPerDay = base.revenue / Double(baseDayCount)
            // Bez čeho srovnávat se nic netvrdí — prázdný základ by udělal
            // z každé události zázrak (dělení skoro nulou)
            let known = !future && base.orders >= 5

            var out = one
            out["days"] = days
            out["future"] = future
            out["orders"] = inside.orders
            out["revenue"] = Int(inside.revenue.rounded())
            out["currency"] = currency
            out["perDay"] = (perDay * 10).rounded() / 10
            out["basePerDay"] = known ? ((basePerDay * 10).rounded() / 10) as Any : NSNull()
            out["deltaPct"] = known && basePerDay > 0
                ? Int((((perDay - basePerDay) / basePerDay) * 100).rounded()) as Any : NSNull()
            /*
             Rozdíl v penězích za celé období. U dovolené vyjde záporný
             (tolik se neprodalo), u akce kladný — odhad, ne účetnictví.
             */
            out["moneyDiff"] = known
                ? Int((inside.revenue - baseMoneyPerDay * Double(days)).rounded()) as Any : NSNull()
            let social = postsBetween(from, to)
            out["posts"] = social.posts
            out["likes"] = social.likes
            out["comments"] = social.comments
            return out
        }
    }

    /**
     Události do zadání pro model.

     Řádek je schválně jedna věta s čísly — ať se dá citovat jako podklad
     odpovědi na „o kolik přijdu, když zavřu na týden".
     */
    static func forAi(currency: String = "CZK", limit: Int = 12) -> String {
        let rows = withImpact(currency: currency)
            .sorted { ($0["from"] as? String ?? "") > ($1["from"] as? String ?? "") }
            .prefix(limit)
        let lines: [String] = rows.map { one in
            let title = one["title"] as? String ?? ""
            let kind = one["kind"] as? String ?? "jine"
            let from = one["from"] as? String ?? ""
            let to = one["to"] as? String ?? from
            let obdobi = from == to ? from : "\(from) až \(to)"
            var text = "\(obdobi) · \(kind) · \(title)"
            if one["future"] as? Bool ?? false {
                text += " — teprve bude"
            } else if let diff = one["moneyDiff"] as? Int, let base = one["basePerDay"] as? Double {
                text += " — \(one["orders"] as? Int ?? 0) objednávek za \(one["days"] as? Int ?? 0) dní"
                    + " (běžný den před tím \(base)), rozdíl \(diff) \(currency)"
            } else {
                text += " — na srovnání nebylo dost objednávek před událostí"
            }
            if let note = one["note"] as? String, !note.isEmpty { text += "; \(note)" }
            return text
        }
        return lines.isEmpty ? "" : lines.joined(separator: "\n")
    }
}
