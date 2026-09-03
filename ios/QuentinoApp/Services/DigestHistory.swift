import Foundation

/**
 Dlouhodobá čísla k AI přehledu.

 Sesterský modul k `src/main/digesthistory.ts`. Třicet dní samo o sobě
 neřekne, jestli je to hodně nebo málo — „sto třináct objednávek" je dobrá
 zpráva v lednu a špatná v prosinci. Drží se proto měsíční souhrny za celou
 historii ve feedu a z nich se počítá zasazení do roku, srovnání s loňskem
 a sezóny.

 Sezóny se **nehádají podle kalendáře**: index měsíce se počítá z vlastních
 dat, takže Vánoce, svatby i letní útlum vyjdou samy, pokud v číslech
 doopravdy jsou. Když e-shop žádnou sezónu nemá, žádná se nenajde.

 Uzavřené měsíce se ukládají do `digest_months` — procházet tisíce
 objednávek při každém otevření je zbytečné, když se už nezmění.
 */
enum DigestHistory {
    private static let monthNames = ["leden", "únor", "březen", "duben", "květen", "červen",
                                     "červenec", "srpen", "září", "říjen", "listopad", "prosinec"]

    private static func ensureTable() {
        _ = try? SQLite.shared.run("""
            CREATE TABLE IF NOT EXISTS digest_months (
              month TEXT PRIMARY KEY,
              orders INTEGER NOT NULL DEFAULT 0,
              cancelled INTEGER NOT NULL DEFAULT 0,
              revenue REAL NOT NULL DEFAULT 0,
              currency TEXT NOT NULL DEFAULT '',
              items INTEGER NOT NULL DEFAULT 0,
              customers INTEGER NOT NULL DEFAULT 0,
              complete INTEGER NOT NULL DEFAULT 0,
              computed_at TEXT NOT NULL DEFAULT ''
            )
            """)
    }

    private static func monthKey(_ date: Date) -> String {
        let parts = Calendar.current.dateComponents([.year, .month], from: date)
        return String(format: "%04d-%02d", parts.year ?? 0, parts.month ?? 0)
    }

    private static func dayKey(_ date: Date) -> String {
        let parts = Calendar.current.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }

    private static func isCancelled(_ status: String) -> Bool {
        status.range(of: "storn|zru[šs]en|vr[áa]cen|cancel|refund",
                     options: [.regularExpression, .caseInsensitive]) != nil
    }

    /// Spočítá jeden měsíc z feedu; storna do tržby nejdou
    private static func computeMonth(_ month: String) -> [String: Any] {
        let rows = (try? SQLite.shared.query(
            "SELECT status, currency, total, email, items_json FROM shop_orders "
            + "WHERE substr(created_at, 1, 7) = ?", [.text(month)])) ?? []

        var money: [String: Double] = [:]
        var customers = Set<String>()
        var orders = 0
        var cancelled = 0
        var items = 0

        for row in rows {
            orders += 1
            let email = (row["email"] as? String ?? "").trimmingCharacters(in: .whitespaces).lowercased()
            if !email.isEmpty { customers.insert(email) }
            if isCancelled(row["status"] as? String ?? "") { cancelled += 1; continue }
            let currency = (row["currency"] as? String ?? "CZK").uppercased()
            let total = row["total"] as? Double ?? Double(row["total"] as? Int ?? 0)
            money[currency] = (money[currency] ?? 0) + total
            if let text = row["items_json"] as? String, let data = text.data(using: .utf8),
               let list = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]] {
                for item in list {
                    items += item["quantity"] as? Int ?? Int(item["quantity"] as? Double ?? 0)
                }
            }
        }

        let best = money.sorted { $0.value > $1.value }.first
        var out: [String: Any] = [:]
        out["month"] = month
        out["orders"] = orders
        out["cancelled"] = cancelled
        out["revenue"] = Int((best?.value ?? 0).rounded())
        out["currency"] = best?.key ?? ""
        out["items"] = items
        out["customers"] = customers.count
        out["complete"] = month < monthKey(Date())
        return out
    }

    /**
     Měsíční souhrny.

     Uzavřené měsíce se berou z tabulky, rozdělaný se počítá vždy znovu —
     a s ním i poslední uzavřený, protože feed dobíhá a objednávka
     z posledního dne může dorazit až prvního.
     */
    static func monthlyStats(_ count: Int = 13, now: Date = Date()) -> [[String: Any]] {
        ensureTable()
        guard let first = (try? SQLite.shared.query(
            "SELECT MIN(substr(created_at, 1, 7)) AS m FROM shop_orders WHERE created_at != ''"
        ))?.first?["m"] as? String, !first.isEmpty else { return [] }

        var wanted: [String] = []
        for back in stride(from: count - 1, through: 0, by: -1) {
            guard let when = Calendar.current.date(byAdding: .month, value: -back, to: now) else { continue }
            let key = monthKey(when)
            if key >= first { wanted.append(key) }
        }

        var cached: [String: [String: Any]] = [:]
        for row in (try? SQLite.shared.query("SELECT * FROM digest_months")) ?? [] {
            if let month = row["month"] as? String { cached[month] = row }
        }

        let thisMonth = monthKey(now)
        let lastClosed = monthKey(Calendar.current.date(byAdding: .month, value: -1, to: now) ?? now)

        var out: [[String: Any]] = []
        for month in wanted {
            let known = cached[month]
            let complete = (known?["complete"] as? Int ?? 0) == 1
            let stale = known == nil || !complete || month == thisMonth || month == lastClosed
            var stat: [String: Any]
            if stale {
                stat = computeMonth(month)
                _ = try? SQLite.shared.run(
                    "INSERT OR REPLACE INTO digest_months "
                    + "(month, orders, cancelled, revenue, currency, items, customers, complete, computed_at) "
                    + "VALUES (?,?,?,?,?,?,?,?,?)",
                    [.text(month),
                     .int(Int64(stat["orders"] as? Int ?? 0)),
                     .int(Int64(stat["cancelled"] as? Int ?? 0)),
                     .double(Double(stat["revenue"] as? Int ?? 0)),
                     .text(stat["currency"] as? String ?? ""),
                     .int(Int64(stat["items"] as? Int ?? 0)),
                     .int(Int64(stat["customers"] as? Int ?? 0)),
                     .int((stat["complete"] as? Bool ?? false) ? 1 : 0),
                     .text(Formats.iso(Date()))]
                )
            } else {
                var known = known ?? [:]
                known["complete"] = complete
                known["revenue"] = Int(known["revenue"] as? Double ?? Double(known["revenue"] as? Int ?? 0))
                stat = known
            }
            out.append(stat)
        }
        return out
    }

    private static func totalsBetween(_ from: String, _ to: String, _ currency: String) -> (orders: Int, revenue: Int) {
        let rows = (try? SQLite.shared.query(
            "SELECT status, currency, total FROM shop_orders "
            + "WHERE substr(created_at, 1, 10) >= ? AND substr(created_at, 1, 10) <= ?",
            [.text(from), .text(to)])) ?? []

        var orders = 0
        var revenue = 0.0
        for row in rows {
            orders += 1
            if isCancelled(row["status"] as? String ?? "") { continue }
            if (row["currency"] as? String ?? "CZK").uppercased() != currency { continue }
            revenue += row["total"] as? Double ?? Double(row["total"] as? Int ?? 0)
        }
        return (orders, Int(revenue.rounded()))
    }

    /**
     Sezóna z vlastních dat.

     Index měsíce je jeho průměrný denní počet objednávek dělený celoročním
     průměrem. Hlásí se nejbližší měsíc s indexem aspoň o čtvrtinu nad
     průměrem — a datum, do kterého se má začít chystat.
     */
    private static func season(_ months: [[String: Any]], _ now: Date) -> [String: Any]? {
        let closed = months.filter { ($0["complete"] as? Bool ?? false) }
        guard closed.count >= 12 else { return nil }

        var orders: [Int: Int] = [:]
        var days: [Int: Int] = [:]
        for one in closed {
            guard let month = one["month"] as? String else { continue }
            let parts = month.split(separator: "-").compactMap { Int($0) }
            guard parts.count == 2 else { continue }
            let index = parts[1] - 1
            var components = DateComponents()
            components.year = parts[0]
            components.month = parts[1]
            let inMonth = Calendar.current.date(from: components).map {
                Calendar.current.range(of: .day, in: .month, for: $0)?.count ?? 30
            } ?? 30
            orders[index] = (orders[index] ?? 0) + (one["orders"] as? Int ?? 0)
            days[index] = (days[index] ?? 0) + inMonth
        }

        var daily: [Int: Double] = [:]
        var sum = 0.0
        for (index, count) in orders {
            let value = Double(count) / Double(max(1, days[index] ?? 1))
            daily[index] = value
            sum += value
        }
        guard !daily.isEmpty else { return nil }
        let average = sum / Double(daily.count)
        guard average > 0 else { return nil }

        for ahead in 0...3 {
            guard let when = Calendar.current.date(byAdding: .month, value: ahead, to: now) else { continue }
            let index = Calendar.current.component(.month, from: when) - 1
            guard let value = daily[index] else { continue }
            let ratio = value / average
            if ratio < 1.25 { continue }

            let startBy = when.addingTimeInterval(-21 * 86_400)
            let label = monthNames[max(0, min(11, index))]
            let percent = Int(((ratio - 1) * 100).rounded())
            let startDay = Calendar.current.component(.day, from: startBy)
            let startMonth = Calendar.current.component(.month, from: startBy)

            var out: [String: Any] = [:]
            out["month"] = monthKey(when)
            out["label"] = label
            out["index"] = (ratio * 100).rounded() / 100
            out["startBy"] = dayKey(startBy)
            out["text"] = ahead == 0
                ? "Běží \(label) — bývá o \(percent) % silnější než průměrný měsíc."
                : "\(label.prefix(1).uppercased())\(label.dropFirst()) bývá o \(percent) % silnější "
                  + "než průměrný měsíc — chystat se má do \(startDay). \(startMonth)."
            out["basis"] = String(format: "průměrně %.1f objednávky na den proti celoročním %.1f, z %d měsíců historie",
                                  value, average, closed.count)
            return out
        }
        return nil
    }

    /// Zasazení posledních třiceti dní do delší historie
    static func view(windowOrders: Int, currency: String, now: Date = Date()) -> [String: Any] {
        let months = monthlyStats(13, now: now)

        let from = now.addingTimeInterval(-29 * 86_400)
        var lastYear: Any = NSNull()
        if let yearFrom = Calendar.current.date(byAdding: .year, value: -1, to: from),
           let yearTo = Calendar.current.date(byAdding: .year, value: -1, to: now),
           let oldest = (try? SQLite.shared.query(
               "SELECT MIN(substr(created_at, 1, 10)) AS d FROM shop_orders WHERE created_at != ''"
           ))?.first?["d"] as? String,
           oldest <= dayKey(yearFrom) {
            let totals = totalsBetween(dayKey(yearFrom), dayKey(yearTo), currency)
            var one: [String: Any] = [:]
            one["orders"] = totals.orders
            one["revenue"] = totals.revenue
            lastYear = one
        }

        let closed = months.filter { ($0["complete"] as? Bool ?? false) }.suffix(12)
        var rank: Any = NSNull()
        if closed.count >= 3 {
            let better = closed.filter { ($0["orders"] as? Int ?? 0) < windowOrders }.count
            var one: [String: Any] = [:]
            one["better"] = better
            one["of"] = closed.count
            rank = one
        }

        var out: [String: Any] = [:]
        out["months"] = months
        out["coverage"] = months.count
        out["lastYear"] = lastYear
        out["rank"] = rank
        out["season"] = season(months, now) ?? NSNull()
        return out
    }
}
