import Foundation

/**
 Přehled dne.

 Sesterský modul k `src/main/digest.ts` — schválně stejný, protože ráno se
 na telefon kouká dřív než na počítač a nesmí tam stát jiná čísla.

 Ráno jde o tři věci: **jak se prodává**, **co čeká na odpověď** a **co
 s tím**. První dvě jsou fakta z feedu objednávek a z pošty — počítají se při
 každém otevření, jsou to dotazy do místní databáze. Třetí je úvaha a na tu
 je tu AI; ta stojí čas i peníze, a proto se dělá **nejvýš jednou za 24
 hodin**. Do té doby se ukazuje uložená a přegenerovat jde tlačítkem.

 Postřehy se ukládají i s čísly, ze kterých vznikly. Do příštího zadání jde
 pár posledních, takže AI vidí, co navrhla minule, a může navazovat místo
 opakování téhož.
 */
enum Digest {
    private static let insightKey = "digestInsightAt"
    private static let everySeconds: TimeInterval = 24 * 3600

    // MARK: - Pomůcky

    /// Kalendářní den v místním čase jako `YYYY-MM-DD`
    private static func dayKey(_ date: Date) -> String {
        let parts = Calendar.current.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }

    private static func shiftDays(_ date: Date, _ by: Int) -> Date {
        Calendar.current.date(byAdding: .day, value: by, to: date) ?? date
    }

    /// Stornovaná objednávka do tržby nepatří, ale zmizet nesmí
    private static func isCancelled(_ status: String) -> Bool {
        status.range(of: "storn|zru[šs]en|vr[áa]cen|cancel|refund",
                     options: [.regularExpression, .caseInsensitive]) != nil
    }

    private static func items(_ row: [String: Any]) -> [[String: Any]] {
        guard let text = row["items_json"] as? String, let data = text.data(using: .utf8),
              let list = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]] else { return [] }
        return list
    }

    /**
     Země objednávky.

     Nejdřív doručovací adresa — rozhoduje, kam balík jede, ne kam jde
     faktura. Když adresa chybí (rychlý feed ji nenese), zbývá trh.
     */
    private static func country(_ row: [String: Any]) -> String {
        for key in ["postal_json", "billing_json"] {
            guard let text = row[key] as? String, let data = text.data(using: .utf8),
                  let one = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  let value = one["country"] as? String else { continue }
            let clean = value.trimmingCharacters(in: .whitespaces)
            if !clean.isEmpty { return String(clean.uppercased().prefix(3)) }
        }
        return (row["market"] as? String ?? "").uppercased()
    }

    private static func day(of row: [String: Any]) -> String {
        String((row["created_at"] as? String ?? "").prefix(10))
    }

    // MARK: - Souhrny

    private struct Totals {
        var orders = 0
        var cancelled = 0
        var unpaid = 0
        var items = 0
        var money: [String: Double] = [:]

        var revenue: [[String: Any]] {
            money.sorted { $0.value > $1.value }.map { pair in
                var one: [String: Any] = [:]
                one["currency"] = pair.key
                one["amount"] = Int(pair.value.rounded())
                return one
            }
        }

        var json: [String: Any] {
            var out: [String: Any] = [:]
            out["orders"] = orders
            out["cancelled"] = cancelled
            out["unpaid"] = unpaid
            out["items"] = items
            out["revenue"] = revenue
            return out
        }

        func amount(_ currency: String) -> Int { Int((money[currency] ?? 0).rounded()) }
        var mainCurrency: String? { money.sorted { $0.value > $1.value }.first?.key }
    }

    private static func totals(_ rows: [[String: Any]]) -> Totals {
        var out = Totals()
        for row in rows {
            out.orders += 1
            if isCancelled(row["status"] as? String ?? "") { out.cancelled += 1; continue }
            if (row["paid"] as? Int ?? 0) == 0 { out.unpaid += 1 }
            let currency = (row["currency"] as? String ?? "CZK").uppercased()
            let total = row["total"] as? Double ?? Double(row["total"] as? Int ?? 0)
            out.money[currency] = (out.money[currency] ?? 0) + total
            for item in items(row) {
                out.items += item["quantity"] as? Int ?? Int(item["quantity"] as? Double ?? 0)
            }
        }
        return out
    }

    /// Řez daty — země, doprava, platba
    private static func slices(_ rows: [[String: Any]], by keyOf: ([String: Any]) -> String) -> [[String: Any]] {
        var orders: [String: Int] = [:]
        var money: [String: Double] = [:]
        for row in rows {
            let key = keyOf(row)
            if key.isEmpty { continue }
            orders[key] = (orders[key] ?? 0) + 1
            if !isCancelled(row["status"] as? String ?? "") {
                let total = row["total"] as? Double ?? Double(row["total"] as? Int ?? 0)
                money[key] = (money[key] ?? 0) + total
            }
        }
        return orders.sorted { $0.value > $1.value }.map { pair in
            var one: [String: Any] = [:]
            one["key"] = pair.key
            one["label"] = pair.key
            one["orders"] = pair.value
            one["revenue"] = Int((money[pair.key] ?? 0).rounded())
            return one
        }
    }

    // MARK: - Čísla

    /// Všechno, co jde spočítat bez AI. Jen dotazy do databáze, žádná síť.
    static func facts(now: Date = Date()) -> [String: Any] {
        let calendar = Calendar.current
        let monthStart = calendar.date(from: calendar.dateComponents([.year, .month], from: now)) ?? now
        let prevMonthStart = calendar.date(byAdding: .month, value: -1, to: monthStart) ?? monthStart
        // Minulý měsíc se srovnává po stejný den — jinak by třetího vycházel
        // propad proti celému minulému měsíci
        let dayOfMonth = calendar.component(.day, from: now)
        let prevMonthEnd = shiftDays(
            calendar.date(byAdding: .day, value: dayOfMonth - 1, to: prevMonthStart) ?? prevMonthStart, 1)

        let rows = (try? SQLite.shared.query(
            """
            SELECT code, market, status, paid, created_at, currency, total, email,
                   shipment, payment, items_json, billing_json, postal_json
              FROM shop_orders WHERE created_at >= ? ORDER BY created_at DESC LIMIT 5000
            """,
            [.text(dayKey(prevMonthStart))]
        )) ?? []

        let todayKey = dayKey(now)
        let yesterdayKey = dayKey(shiftDays(now, -1))
        let monthKey = dayKey(monthStart)
        let prevStartKey = dayKey(prevMonthStart)
        let prevEndKey = dayKey(prevMonthEnd)

        let monthRows = rows.filter { day(of: $0) >= monthKey }
        let today = totals(rows.filter { day(of: $0) == todayKey })
        let yesterday = totals(rows.filter { day(of: $0) == yesterdayKey })
        let month = totals(monthRows)
        let prevMonth = totals(rows.filter { day(of: $0) >= prevStartKey && day(of: $0) < prevEndKey })

        // Sčítat koruny s eury nejde, ale dlaždice i graf potřebují jedno
        // číslo — bere se měna, ve které je nejvíc peněz
        let currency = month.mainCurrency ?? today.mainCurrency ?? "CZK"

        // Posledních 30 dní i s prázdnými — díra po víkendu je informace
        var days: [[String: Any]] = []
        for back in stride(from: 29, through: 0, by: -1) {
            let key = dayKey(shiftDays(now, -back))
            let one = totals(rows.filter { day(of: $0) == key })
            var entry: [String: Any] = [:]
            entry["day"] = key
            entry["orders"] = one.orders
            entry["revenue"] = one.amount(currency)
            days.append(entry)
        }

        // Nejprodávanější zboží měsíce. Skládá se po kódech — týž produkt
        // chodí ve feedu s názvem v jazyce trhu
        var titles: [String: String] = [:]
        var quantity: [String: Int] = [:]
        var inOrders: [String: Int] = [:]
        var earned: [String: Double] = [:]
        for row in monthRows where !isCancelled(row["status"] as? String ?? "") {
            var counted = Set<String>()
            for item in items(row) {
                let code = ((item["code"] as? String) ?? (item["title"] as? String) ?? "")
                    .trimmingCharacters(in: .whitespaces)
                if code.isEmpty { continue }
                let qty = item["quantity"] as? Int ?? Int(item["quantity"] as? Double ?? 0)
                let price = item["price"] as? Double ?? Double(item["price"] as? Int ?? 0)
                titles[code] = titles[code] ?? (item["title"] as? String ?? code)
                quantity[code] = (quantity[code] ?? 0) + qty
                earned[code] = (earned[code] ?? 0) + price * Double(qty)
                if !counted.contains(code) {
                    inOrders[code] = (inOrders[code] ?? 0) + 1
                    counted.insert(code)
                }
            }
        }
        let products: [[String: Any]] = quantity.sorted { $0.value > $1.value }.prefix(8).map { pair in
            var one: [String: Any] = [:]
            one["code"] = pair.key
            one["title"] = titles[pair.key] ?? pair.key
            one["qty"] = pair.value
            one["orders"] = inOrders[pair.key] ?? 0
            one["revenue"] = Int((earned[pair.key] ?? 0).rounded())
            return one
        }

        // Vracející se zákazníci — proti celé historii ve feedu, ne jen proti
        // načtenému oknu, jinak by každý vypadal jako nový
        let returning = ((try? SQLite.shared.query(
            """
            SELECT COUNT(*) AS n FROM shop_orders o
             WHERE o.created_at >= ? AND o.email != ''
               AND EXISTS (SELECT 1 FROM shop_orders p
                            WHERE p.email = o.email AND p.created_at < o.created_at)
            """,
            [.text(monthKey)]
        ))?.first?["n"] as? Int) ?? 0

        let feedRow = (try? SQLite.shared.query(
            "SELECT COUNT(*) AS n, MAX(seen_at) AS at FROM shop_orders"))?.first
        let known = feedRow?["n"] as? Int ?? 0
        var feedAt: Any = NSNull()
        if let at = feedRow?["at"] as? String, !at.isEmpty { feedAt = at }

        let months = ["ledna", "února", "března", "dubna", "května", "června",
                      "července", "srpna", "září", "října", "listopadu", "prosince"]
        let monthIndex = max(1, min(12, calendar.component(.month, from: now))) - 1
        let monthLabel = "\(months[monthIndex]) \(calendar.component(.year, from: now))"

        let paidOrders = month.orders - month.cancelled
        let average = paidOrders > 0 ? Int((Double(month.amount(currency)) / Double(paidOrders)).rounded()) : 0

        var out: [String: Any] = [:]
        out["currency"] = currency
        out["today"] = today.json
        out["yesterday"] = yesterday.json
        out["month"] = month.json
        out["prevMonth"] = prevMonth.json
        out["monthLabel"] = monthLabel
        out["days"] = days
        out["countries"] = slices(monthRows, by: country)
        // Dopravci a platby ve zkratkách ze slovníku — pobočky by daly stovku
        // řádků, jednu na výdejnu
        out["shipments"] = slices(monthRows) { Shorthand.shortFor("shipment", $0["shipment"] as? String) }
        out["payments"] = slices(monthRows) { Shorthand.shortFor("payment", $0["payment"] as? String) }
        out["products"] = products
        out["returning"] = returning
        out["average"] = average
        out["feedAt"] = feedAt
        out["known"] = known
        return out
    }

    // MARK: - Co čeká na vyřízení

    private static let urgent = "reklamac|stížnost|stiznost|nedoruč|nedoruc|nedorazil|ztrat|poškoz|poskoz|storn|vrácen|vracen|urgent|právn|pravn|advokát"

    /**
     Nevyřízená pošta.

     Rozhoduje **vlákno**, ne příznak: odpověď odeslaná z jiného zařízení
     příznak „zodpovězeno" nenastaví a přehled pak dokola připomíná hotovou
     věc. Když ve vlákně po zprávě něco odešlo, je vyřízeno.
     */
    static func mailTasks(days: Int = 7, limit: Int = 12) -> [[String: Any]] {
        let since = Formats.iso(Date().addingTimeInterval(-Double(days) * 86_400))
        let rows = (try? SQLite.shared.query(
            """
            SELECT m.id, m.from_name, m.from_addr, m.subject, m.snippet, m.summary, m.date, m.thread_key
              FROM messages m
             WHERE m.folder = 'INBOX' AND m.archived = 0 AND m.answered = 0 AND m.date >= ?
               AND (m.category IS NULL OR m.category != 'other')
               AND NOT EXISTS (
                 SELECT 1 FROM messages r
                  WHERE r.thread_key != '' AND r.thread_key = m.thread_key AND r.date > m.date
                    AND (lower(r.folder) LIKE '%sent%' OR lower(r.folder) LIKE '%odeslan%'))
               AND NOT EXISTS (
                 SELECT 1 FROM outbox o
                  WHERE o.reply_to_db_id = m.id AND o.status != 'failed')
             ORDER BY m.date DESC LIMIT 60
            """,
            [.text(since)]
        )) ?? []

        // Z jednoho vlákna stačí poslední zpráva — zákazník, který třikrát
        // urguje, je jedna věc k vyřízení, ne tři řádky
        var seen = Set<String>()
        var out: [[String: Any]] = []
        for row in rows {
            let id = row["id"] as? Int ?? 0
            let thread = (row["thread_key"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "id:\(id)"
            if seen.contains(thread) { continue }
            seen.insert(thread)

            let subject = row["subject"] as? String ?? ""
            let preview = (row["summary"] as? String).flatMap { $0.isEmpty ? nil : $0 }
                ?? (row["snippet"] as? String ?? "")
            let who = (row["from_name"] as? String).flatMap { $0.isEmpty ? nil : $0 }
                ?? (row["from_addr"] as? String ?? "")
            let hot = "\(subject) \(preview)".range(
                of: urgent, options: [.regularExpression, .caseInsensitive]) != nil

            var one: [String: Any] = [:]
            one["kind"] = "mail"
            one["id"] = String(id)
            one["who"] = who
            one["subject"] = subject
            one["preview"] = String(preview.prefix(140))
            one["at"] = row["date"] as? String ?? ""
            one["urgent"] = hot
            one["reason"] = "nikdo neodpověděl"
            out.append(one)
        }
        return Array(out.prefix(limit))
    }

    /// Otevřené konverzace, kde poslední slovo má zákazník
    private static func chatTasks() async -> (tasks: [[String: Any]], error: Any) {
        guard Chat.isReady else { return ([], NSNull()) }
        do {
            let list = try await Chat.conversations(onlyOpen: true)
            var out: [[String: Any]] = []
            for row in list where (row["answered"] as? Bool ?? false) == false {
                var one: [String: Any] = [:]
                one["kind"] = "chat"
                one["id"] = row["id"] as? String ?? ""
                let name = (row["name"] as? String).flatMap { $0.isEmpty ? nil : $0 }
                    ?? (row["email"] as? String)
                one["who"] = name ?? "návštěvník chatu"
                one["subject"] = "Chat na webu"
                one["preview"] = ""
                one["at"] = row["lastMessageAt"] as? String ?? ""
                one["urgent"] = false
                one["reason"] = (row["unread"] as? Int ?? 0) > 0
                    ? "čeká na odpověď" : "poslední slovo má zákazník"
                out.append(one)
                if out.count >= 8 { break }
            }
            return (out, NSNull())
        } catch {
            // Chat je za sítí; přehled kvůli němu nepadá, jen se řekne proč
            return ([], error.localizedDescription)
        }
    }

    // MARK: - Postřehy

    private static func ensureTable() {
        _ = try? SQLite.shared.run("""
            CREATE TABLE IF NOT EXISTS digest_reports (
              at TEXT PRIMARY KEY,
              facts TEXT NOT NULL DEFAULT '{}',
              insight TEXT NOT NULL DEFAULT '{}'
            )
            """)
    }

    private static func stored(_ limit: Int = 6) -> [(at: String, facts: [String: Any], insight: [String: Any])] {
        ensureTable()
        let rows = (try? SQLite.shared.query(
            "SELECT at, facts, insight FROM digest_reports ORDER BY at DESC LIMIT ?", [.int(limit)])) ?? []
        var out: [(at: String, facts: [String: Any], insight: [String: Any])] = []
        for row in rows {
            let facts = json(row["facts"] as? String) ?? [:]
            let insight = json(row["insight"] as? String) ?? [:]
            out.append((row["at"] as? String ?? "", facts, insight))
        }
        return out
    }

    private static func json(_ text: String?) -> [String: Any]? {
        guard let text, let data = text.data(using: .utf8) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    /// Čísla do zadání — krátce a v jednotkách, ať se v tom AI vyzná
    private static func factsForAi(_ facts: [String: Any]) -> String {
        let currency = facts["currency"] as? String ?? "CZK"
        func money(_ key: String) -> String {
            let totals = facts[key] as? [String: Any] ?? [:]
            let list = totals["revenue"] as? [[String: Any]] ?? []
            let parts = list.map { one -> String in
                let amount = one["amount"] as? Int ?? 0
                let name = one["currency"] as? String ?? ""
                return "\(amount) \(name)"
            }
            return parts.isEmpty ? "0" : parts.joined(separator: " + ")
        }
        func count(_ key: String, _ field: String) -> Int {
            (facts[key] as? [String: Any])?[field] as? Int ?? 0
        }
        func slice(_ key: String) -> String {
            let list = (facts[key] as? [[String: Any]] ?? []).prefix(6).map { one -> String in
                "\(one["label"] as? String ?? "") \(one["orders"] as? Int ?? 0)×"
            }
            return list.isEmpty ? "—" : list.joined(separator: ", ")
        }

        let days = (facts["days"] as? [[String: Any]] ?? []).map { one -> String in
            let day = String((one["day"] as? String ?? "").suffix(5))
            return "\(day):\(one["orders"] as? Int ?? 0)"
        }.joined(separator: " ")

        let products = (facts["products"] as? [[String: Any]] ?? []).map { one -> String in
            let title = one["title"] as? String ?? ""
            let code = one["code"] as? String ?? ""
            let qty = one["qty"] as? Int ?? 0
            let revenue = one["revenue"] as? Int ?? 0
            return "\(title) (\(code)) \(qty) ks za \(revenue) \(currency)"
        }.joined(separator: "; ")

        var lines: [String] = []
        lines.append("Dnes: \(count("today", "orders")) objednávek za \(money("today"))"
                     + ", storno \(count("today", "cancelled"))"
                     + ", nezaplacených \(count("today", "unpaid"))")
        lines.append("Včera: \(count("yesterday", "orders")) objednávek za \(money("yesterday"))")
        lines.append("\(facts["monthLabel"] as? String ?? "Tento měsíc"): "
                     + "\(count("month", "orders")) objednávek za \(money("month")), "
                     + "průměr \(facts["average"] as? Int ?? 0) \(currency), "
                     + "vracejících se zákazníků \(facts["returning"] as? Int ?? 0)")
        lines.append("Stejná část minulého měsíce: \(count("prevMonth", "orders")) objednávek za \(money("prevMonth"))")
        lines.append("Denní řada (posledních 30 dní, počet objednávek): \(days)")
        lines.append("Země: \(slice("countries"))")
        lines.append("Doprava: \(slice("shipments"))")
        lines.append("Platba: \(slice("payments"))")
        lines.append("Nejprodávanější tento měsíc: \(products.isEmpty ? "—" : products)")
        return lines.joined(separator: "\n")
    }

    /// Co bylo minule — aby AI navazovala a neopakovala se
    private static func memoryForAi(_ history: [(at: String, facts: [String: Any], insight: [String: Any])]) -> String {
        history.map { one -> String in
            let when = String(one.at.prefix(10))
            let orders = (one.facts["month"] as? [String: Any])?["orders"] as? Int
            let notes = (one.insight["notes"] as? [[String: Any]] ?? []).map { note in
                "- \(note["text"] as? String ?? "")"
            }.joined(separator: "\n")
            // Vlastní poznámka „na co se podívat příště" je to hlavní, kvůli
            // čemu se paměť vede — bez ní by každý den začínal od nuly
            var focus = ""
            if let text = one.insight["focus"] as? String, !text.isEmpty {
                focus = "\nChtěl jsi příště ověřit: \(text)"
            }
            let head = orders != nil ? "[\(when), měsíc měl tehdy \(orders!) objednávek]" : "[\(when)]"
            return "\(head)\n\(one.insight["headline"] as? String ?? "")\n\(notes)\(focus)"
        }.joined(separator: "\n\n")
    }

    private static let insightSystem = """
    Jsi obchodní analytik e-shopu Quentino (pásky, peněženky a kožená galanterie; trhy CZ, SK a EU).
    Dostaneš čísla z feedu objednávek a svoje dřívější postřehy. Napiš krátký, konkrétní rozbor pro majitele.

    Pravidla:
    - Piš česky, věcně, bez marketingových frází a bez oslovení.
    - Vycházej JEN z předložených čísel. Nic si nedomýšlej; když na něco data nestačí, napiš to.
    - Čísla v textu musí sedět na zadání.
    - Hledej trendy (růst/pokles, změny v dopravě, platbách, zemích, zboží), rizika (nezaplacené, storna, propad) \
    a konkrétní návrhy (cena, sada, zásoba, doprava) — návrh musí být proveditelný tenhle týden.
    - Když už jsi něco navrhoval dřív, navaž: co se potvrdilo, co ne.
    - Nejvýš pět bodů, každý jedna věta.

    Vrať POUZE JSON, nic dalšího:
    {"headline":"jedna až dvě věty souhrnu",
     "followUp":"navázání na minulý přehled nebo null",
     "notes":[{"kind":"trend|napad|pozor","text":"…"}],
     "focus":"co si sám chceš ověřit v příštím přehledu, nebo null",
     "questions":["dvě až tři otázky, na které se podle tebe vyplatí doptat"]}
    """

    /// Odpověď modelu na strukturu; když se JSON nepovede, zachrání se text
    private static func parseInsight(_ raw: String, model: String) -> [String: Any] {
        let at = Formats.iso(Date())
        var out: [String: Any] = [:]
        out["at"] = at
        out["model"] = model
        out["followUp"] = NSNull()
        out["focus"] = NSNull()
        out["questions"] = [String]()

        if let start = raw.firstIndex(of: "{"), let end = raw.lastIndex(of: "}"), start < end,
           let one = json(String(raw[start...end])) {
            out["headline"] = (one["headline"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            var notes: [[String: Any]] = []
            for note in (one["notes"] as? [[String: Any]] ?? []) {
                let text = (note["text"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                if text.isEmpty { continue }
                let kind = note["kind"] as? String ?? "trend"
                var entry: [String: Any] = [:]
                entry["kind"] = ["trend", "napad", "pozor"].contains(kind) ? kind : "trend"
                entry["text"] = text
                notes.append(entry)
                if notes.count >= 6 { break }
            }
            out["notes"] = notes
            if let follow = one["followUp"] as? String, !follow.isEmpty { out["followUp"] = follow }
            if let focus = one["focus"] as? String, !focus.isEmpty { out["focus"] = focus }
            let questions = (one["questions"] as? [String] ?? [])
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
            out["questions"] = Array(questions.prefix(3))
            return out
        }

        // Model se občas rozpovídá mimo JSON; věta navíc je pořád lepší než nic
        let lines = raw.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        out["headline"] = lines.first ?? ""
        var notes: [[String: Any]] = []
        for line in lines.dropFirst().prefix(5) {
            var entry: [String: Any] = [:]
            entry["kind"] = "trend"
            entry["text"] = line.replacingOccurrences(of: "^[-•*]\\s*", with: "", options: .regularExpression)
            notes.append(entry)
        }
        out["notes"] = notes
        return out
    }

    private static func makeInsight(_ facts: [String: Any]) async throws -> [String: Any] {
        let history = stored()
        let memory = memoryForAi(history)
        let answer = try await AI.ask(
            model: AI.draftModel,
            system: insightSystem,
            user: "# Čísla\n\(factsForAi(facts))\n\n"
                + (memory.isEmpty ? "" : "# Co jsi psal dřív (nejnovější nahoře)\n\(memory)\n"),
            maxTokens: 1200
        )
        let insight = parseInsight(answer, model: AI.draftModel)

        ensureTable()
        var snapshot: [String: Any] = [:]
        for key in ["today", "month", "prevMonth", "currency", "average", "returning"] {
            snapshot[key] = facts[key]
        }
        snapshot["products"] = Array((facts["products"] as? [[String: Any]] ?? []).prefix(5))
        snapshot["countries"] = Array((facts["countries"] as? [[String: Any]] ?? []).prefix(5))

        let factsText = OrderFeed.jsonText(snapshot) ?? "{}"
        let insightText = OrderFeed.jsonText(insight) ?? "{}"
        _ = try? SQLite.shared.run(
            "INSERT OR REPLACE INTO digest_reports (at, facts, insight) VALUES (?,?,?)",
            [.text(insight["at"] as? String ?? Formats.iso(Date())), .text(factsText), .text(insightText)]
        )
        // Historie je paměť, ne archiv — třicet zápisů je půl roku ohlédnutí
        _ = try? SQLite.shared.run(
            "DELETE FROM digest_reports WHERE at NOT IN "
            + "(SELECT at FROM digest_reports ORDER BY at DESC LIMIT 30)")
        Store.setSetting(insightKey, insight["at"] as? String ?? "")
        return insight
    }

    // MARK: - Celý přehled

    /**
     Přehled pro okno.

     Čísla a seznam k vyřízení se počítají vždy — jsou z místní databáze
     a zastaralá by jen mátla. Postřehy od AI se dělají nejvýš jednou za
     24 hodin; `force` je tlačítko „Přegenerovat".
     */
    static func report(force: Bool = false) async -> [String: Any] {
        let facts = self.facts()
        let mail = mailTasks()
        let chat = await chatTasks()

        let history = stored(1)
        var insight: Any = history.first.map { $0.insight as Any } ?? NSNull()
        let lastAt = (history.first?.insight["at"] as? String) ?? Store.setting(insightKey, "") ?? ""
        let age = lastAt.isEmpty ? Double.greatestFiniteMagnitude
            : Date().timeIntervalSince(Formats.date(lastAt) ?? Date(timeIntervalSince1970: 0))

        var insightError: Any = NSNull()
        if force || age >= everySeconds {
            do {
                insight = try await makeInsight(facts)
            } catch {
                // Starý postřeh je pořád lepší než prázdné místo — jen se
                // řekne, že se nový nepovedl
                insightError = error.localizedDescription
            }
        }

        var nextInsightAt: Any = NSNull()
        if let one = insight as? [String: Any], let at = one["at"] as? String,
           let when = Formats.date(at) {
            nextInsightAt = Formats.iso(when.addingTimeInterval(everySeconds))
        }

        let tasks = (mail + chat.tasks).sorted { left, right in
            let hotLeft = left["urgent"] as? Bool ?? false
            let hotRight = right["urgent"] as? Bool ?? false
            if hotLeft != hotRight { return hotLeft }
            return (left["at"] as? String ?? "") > (right["at"] as? String ?? "")
        }

        var out: [String: Any] = [:]
        out["facts"] = facts
        out["tasks"] = tasks
        out["insight"] = insight
        out["nextInsightAt"] = nextInsightAt
        out["insightError"] = insightError
        out["chatError"] = chat.error
        return out
    }

    // MARK: - Doptávání

    private static let askSystem = """
    Jsi obchodní analytik e-shopu Quentino. Odpovídáš majiteli na otázky nad čísly z feedu objednávek, \
    která máš v zadání.

    Pravidla:
    - Piš česky, krátce (nejvýš pět vět nebo pár odrážek), věcně a konkrétně.
    - Odpovídej JEN z předložených čísel a z pošty uvedené v zadání. Když na odpověď data nestačí, řekni to \
    rovnou a napiš, co by k tomu bylo potřeba dotáhnout.
    - Čísla neodhaduj a nezaokrouhluj jinak, než jak jsou.
    - Když se hodí návrh, ať je proveditelný — cena, sada, zásoba, doprava, text.
    """

    /**
     Otázka nad přehledem.

     Odpovídá se nad **týmiž čísly**, která jsou na obrazovce — nic se
     nedohledává jinde, takže se odpověď dá porovnat s tím, co je vidět.
     */
    static func ask(_ question: String, history: [[String: Any]] = []) async throws -> String {
        let asked = question.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !asked.isEmpty else { return "" }

        let facts = self.facts()
        let tasks = mailTasks(days: 7, limit: 8)
        let memory = memoryForAi(stored(3))

        let talk = history.suffix(6).map { one -> String in
            let who = (one["role"] as? String) == "user" ? "Majitel" : "Ty"
            return "\(who): \(one["text"] as? String ?? "")"
        }.joined(separator: "\n")

        let waiting = tasks.map { one in
            "- \(one["who"] as? String ?? ""): \(one["subject"] as? String ?? "")"
        }.joined(separator: "\n")

        var user = "# Čísla\n\(factsForAi(facts))\n\n"
        user += "# Čeká na vyřízení (\(tasks.count))\n\(waiting.isEmpty ? "— nic" : waiting)"
        if !memory.isEmpty { user += "\n\n# Tvoje dřívější postřehy\n\(memory)" }
        if !talk.isEmpty { user += "\n\n# Dosavadní hovor\n\(talk)" }
        user += "\n\n# Otázka\n\(asked)"

        return try await AI.ask(model: AI.draftModel, system: askSystem, user: user, maxTokens: 900)
    }
}
