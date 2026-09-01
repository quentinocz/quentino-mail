import Foundation

/**
 Objednávky z exportních feedů e-shopu.

 Totéž, co na počítači dělá `src/main/orderfeed.ts`, a ze stejného důvodu:
 potvrzovací e-mail telefon na zákazníka většinou nenese, kdežto export
 objednávek ano. Na telefonu je to o to cennější — tady se nechce číslo
 přečíst, ale rovnou na něj klepnout a volat.

 Adresy feedů obsahují tajný klíč (kdo ji zná, stáhne si všechny objednávky
 e-shopu), proto leží v klíčence, ne v tabulce nastavení.
 */
enum OrderFeed {
    private static let secretKey = "orderFeeds"

    // MARK: - Nastavení

    struct Feed {
        var id: String
        var label: String
        var url: String
        var market: String
        var everyMinutes: Int
        var recent: Bool
        var enabled: Bool

        var asDict: [String: Any] {
            ["id": id, "label": label, "url": url, "market": market,
             "everyMinutes": everyMinutes, "recent": recent, "enabled": enabled]
        }
    }

    /// Trh podle domény — jinak by ho musel u každého feedu vyplňovat člověk.
    private static func market(from url: String) -> String {
        let lower = url.lowercased()
        if lower.contains(".sk/") || lower.hasSuffix(".sk") { return "sk" }
        if lower.contains("wearquentino.com") || lower.contains(".com/") { return "en" }
        return "cz"
    }

    static func feeds() -> [Feed] {
        guard let raw = Secrets.get(secretKey), let data = raw.data(using: .utf8),
              let list = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return [] }
        return list.compactMap { item in
            guard let url = item["url"] as? String, !url.isEmpty else { return nil }
            return Feed(
                id: item["id"] as? String ?? url,
                label: item["label"] as? String ?? "Feed",
                url: url,
                market: (item["market"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? market(from: url),
                everyMinutes: max(5, item["everyMinutes"] as? Int ?? 60),
                recent: item["recent"] as? Bool ?? false,
                enabled: item["enabled"] as? Bool ?? true
            )
        }
    }

    static func save(_ input: [[String: Any]]) -> [[String: Any]] {
        let clean: [[String: Any]] = input.enumerated().compactMap { index, item in
            guard let url = (item["url"] as? String)?.trimmingCharacters(in: .whitespaces), !url.isEmpty else {
                return nil
            }
            let label = (item["label"] as? String)?.trimmingCharacters(in: .whitespaces) ?? ""
            return Feed(
                id: item["id"] as? String ?? "feed\(index + 1)",
                label: label.isEmpty ? "Feed \(index + 1)" : label,
                url: url,
                market: (item["market"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? market(from: url),
                everyMinutes: max(5, item["everyMinutes"] as? Int ?? 60),
                recent: item["recent"] as? Bool ?? false,
                enabled: item["enabled"] as? Bool ?? true
            ).asDict
        }
        if let data = try? JSONSerialization.data(withJSONObject: clean),
           let text = String(data: data, encoding: .utf8) {
            Secrets.set(secretKey, text)
        }
        return statuses()
    }

    /// SQLite vrací počty jednou jako `Int`, jindy jako `Int64` — sjednoceno tady.
    private static func count(_ value: Any?) -> Int {
        if let n = value as? Int { return n }
        if let n = value as? Int64 { return Int(n) }
        if let n = value as? Double { return Int(n) }
        return 0
    }

    /// Adresa nese tajný klíč — ven jde jen její konec, ať je poznat která je která.
    private static func hint(_ url: String) -> String {
        guard let parsed = URL(string: url), let host = parsed.host else { return String(url.suffix(24)) }
        return "\(host)/…\(String(parsed.path.suffix(12)))"
    }

    static func statuses() -> [[String: Any]] {
        feeds().map { feed in
            let rows = (try? SQLite.shared.query(
                "SELECT COUNT(*) AS n, MAX(created_at) AS newest FROM shop_orders WHERE market = ?",
                [.text(feed.market)]
            )) ?? []
            return [
                "id": feed.id, "label": feed.label, "market": feed.market,
                "recent": feed.recent, "enabled": feed.enabled, "everyMinutes": feed.everyMinutes,
                "urlHint": hint(feed.url),
                "orders": count(rows.first?["n"]),
                "newest": rows.first?["newest"] as? String ?? "",
                "lastSync": Store.setting("orderFeedSync:\(feed.id)", "") ?? "",
                "lastError": Store.setting("orderFeedError:\(feed.id)", "") ?? ""
            ]
        }
    }

    static func stats() -> [String: Any] {
        let total = count((try? SQLite.shared.query("SELECT COUNT(*) AS n FROM shop_orders"))?.first?["n"])
        let withPhone = count((try? SQLite.shared.query(
            "SELECT COUNT(*) AS n FROM shop_orders WHERE phone <> ''"))?.first?["n"])
        let markets = ((try? SQLite.shared.query(
            "SELECT market, COUNT(*) AS n FROM shop_orders GROUP BY market ORDER BY n DESC")) ?? [])
        return ["total": total, "withPhone": withPhone, "markets": markets]
    }

    // MARK: - Rozbor XML

    private static func matches(_ text: String, _ pattern: String) -> [[String]] {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else { return [] }
        return regex.matches(in: text, range: NSRange(text.startIndex..., in: text)).map { found in
            (0..<found.numberOfRanges).map { index in
                Range(found.range(at: index), in: text).map { String(text[$0]) } ?? ""
            }
        }
    }

    private static func blocks(_ xml: String, _ name: String) -> [String] {
        matches(xml, "<\(name)[^>]*>[\\s\\S]*?</\(name)>").map { $0[0] }
    }

    /**
     Značka se hledá kdekoli uvnitř bloku, ne po pevné cestě.

     Upgates umí strukturu exportu měnit podle toho, co si člověk ve feedu
     zaškrtne — telefon je jednou v `COMMUNICATION`, jindy přímo u zákazníka.
     Hledání podle názvu obojí přežije; pevná cesta by se rozbila při první
     změně nastavení a nikdo by nevěděl proč.
     */
    private static func tag(_ block: String, _ names: String...) -> String {
        for name in names {
            for found in matches(block, "<\(name)[^>]*>([\\s\\S]*?)</\(name)>") {
                let value = clean(found[1])
                // Vnořený blok není hodnota
                if value.range(of: "<[a-z_]+[\\s>]", options: [.regularExpression, .caseInsensitive]) != nil { continue }
                if !value.isEmpty { return value }
            }
        }
        return ""
    }

    private static func clean(_ text: String) -> String {
        text
            .replacingOccurrences(of: "<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>", with: "$1", options: [.regularExpression])
            .replacingOccurrences(of: "&lt;", with: "<")
            .replacingOccurrences(of: "&gt;", with: ">")
            .replacingOccurrences(of: "&quot;", with: "\"")
            .replacingOccurrences(of: "&#39;", with: "'")
            .replacingOccurrences(of: "&apos;", with: "'")
            .replacingOccurrences(of: "&amp;", with: "&")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Telefon do tvaru, na který jde rovnou klepnout.
    static func normalizePhone(_ raw: String, market: String) -> String {
        let clean = raw.filter { $0.isNumber || $0 == "+" }
        if clean.isEmpty { return "" }
        if clean.hasPrefix("+") { return clean }
        if clean.hasPrefix("00") { return "+" + clean.dropFirst(2) }
        // Devět číslic bez předvolby je české nebo slovenské číslo
        if clean.count == 9 { return (market == "sk" ? "+421" : "+420") + clean }
        return clean
    }

    static func parse(_ xml: String, market: String) -> [[String: Any]] {
        blocks(xml, "ORDER").compactMap { block in
            let code = tag(block, "CODE", "ORDER_NUMBER")
            guard !code.isEmpty else { return nil }

            let items: [[String: Any]] = blocks(block, "ITEM").compactMap { item in
                let title = tag(item, "TITLE", "NAME")
                let itemCode = tag(item, "CODE", "PRODUCT_CODE")
                if title.isEmpty && itemCode.isEmpty { return nil }
                return [
                    "title": title, "code": itemCode,
                    "quantity": Int(tag(item, "QUANTITY")) ?? 1,
                    "price": Double(tag(item, "PRICE_WITH_VAT", "PRICE")) ?? 0
                ]
            }

            /*
             Adresy. Hledají se uvnitř `<ADDRESSES>`, ne v celé objednávce:
             `<STREET>` je v obou blocích a bez ohraničení by se fakturační
             ulice vydávala za doručovací.
             */
            let addresses = blocks(block, "ADDRESSES").first ?? block
            let billing = address(blocks(addresses, "BILLING").first ?? "")
            let postal = address(blocks(addresses, "POSTAL").first
                ?? blocks(addresses, "DELIVERY").first ?? "")

            // Doprava i platba mají uvnitř vlastní NAME — mimo tyhle bloky by
            // se chytlo prvního výskytu, ať patří komukoli
            let shipmentBlock = blocks(block, "SHIPMENT").first ?? ""
            let paymentBlock = blocks(block, "PAYMENT").first ?? ""
            let customerBlock = blocks(block, "CUSTOMER").first ?? block

            let name = [tag(customerBlock, "FIRSTNAME", "FIRST_NAME"),
                        tag(customerBlock, "SURNAME", "LASTNAME", "LAST_NAME")]
                .filter { !$0.isEmpty }.joined(separator: " ")

            return [
                "code": code,
                "market": market,
                "status": tag(block, "STATUS"),
                "paid": tag(block, "PAID_YN") == "1",
                "paidDate": tag(block, "PAID_DATE"),
                "resolved": tag(block, "RESOLVED_YN") == "1",
                "invoice": tag(block, "INVOICE_NUMBER"),
                "createdAt": tag(block, "CREATION_TIME", "CREATED_AT"),
                "updatedAt": tag(block, "LAST_UPDATE_TIME", "UPDATED_AT"),
                "currency": tag(block, "CURRENCY", "CURRENCY_ID"),
                "total": Double(tag(block, "TOTAL_PRICE_WITH_VAT", "TOTAL_WITH_VAT")) ?? 0,
                "tracking": tag(block, "TRACING_CODE", "TRACKING_CODE"),
                "customerId": tag(customerBlock, "CUSTOMER_ID"),
                "name": name,
                "email": tag(customerBlock, "EMAIL").lowercased(),
                "phone": normalizePhone(tag(customerBlock, "PHONE"), market: market),
                "shipment": tag(shipmentBlock, "NAME"),
                "payment": tag(paymentBlock, "NAME"),
                "items": items,
                "billing": billing ?? NSNull(),
                "postal": postal ?? NSNull()
            ]
        }
    }

    /**
     Adresa z bloku `<BILLING>` nebo `<POSTAL>`.

     Názvy značek se mezi šablonami exportu liší (`ZIP_CODE` i `ZIP`,
     `COUNTRY_ID` i `COUNTRY`), takže se u každého pole zkouší víc variant.
     Prázdné pole export vynechává, proto se nikde nespoléhá na to, že značka
     existuje — a z bloku bez jediné vyplněné hodnoty se vrací „nic": prázdná
     adresa na kartě vypadá, jako by se doručovalo nikam.
     */
    private static func address(_ block: String) -> [String: Any]? {
        let street = [tag(block, "STREET"), tag(block, "HOUSENUMBER", "HOUSE_NUMBER")]
            .filter { !$0.isEmpty }.joined(separator: " ")
        let person = [tag(block, "FIRSTNAME", "FIRST_NAME"),
                      tag(block, "SURNAME", "LASTNAME", "LAST_NAME")]
            .filter { !$0.isEmpty }.joined(separator: " ")

        let out: [String: String] = [
            "name": person.isEmpty ? tag(block, "NAME") : person,
            "company": tag(block, "COMPANY_NAME", "COMPANY"),
            "street": street,
            "city": tag(block, "CITY"),
            "zip": tag(block, "ZIP_CODE", "ZIP", "POSTCODE"),
            "country": tag(block, "COUNTRY_ID", "COUNTRY", "COUNTRY_CODE"),
            "state": tag(block, "STATE")
        ]
        return out.values.contains(where: { !$0.isEmpty }) ? out : nil
    }

    // MARK: - Stahování

    /// Slovník do JSONu pro uložení; `NSNull` a nesmysl se ukládají jako prázdno.
    private static func json(_ value: Any?) -> SQLite.Value {
        guard let value, !(value is NSNull),
              let data = try? JSONSerialization.data(withJSONObject: value),
              let text = String(data: data, encoding: .utf8) else { return .null }
        return .text(text)
    }

    private static func store(_ orders: [[String: Any]]) {
        let now = ISO8601DateFormatter().string(from: Date())
        for order in orders {
            let items = (try? JSONSerialization.data(withJSONObject: order["items"] ?? []))
                .flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
            _ = try? SQLite.shared.run("""
                INSERT INTO shop_orders (code, market, status, paid, paid_date, resolved, invoice,
                  created_at, updated_at, currency, total, tracking, customer_id, name, email, phone,
                  shipment, payment, items_json, billing_json, postal_json, seen_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(code, market) DO UPDATE SET
                  status = excluded.status, paid = excluded.paid, paid_date = excluded.paid_date,
                  resolved = excluded.resolved, invoice = excluded.invoice,
                  updated_at = excluded.updated_at, total = excluded.total,
                  tracking = excluded.tracking, name = excluded.name, email = excluded.email,
                  -- Prázdným telefonem se dobré číslo nepřepisuje: malý feed
                  -- ho občas nemá a přišli bychom o jediné, co potřebujeme
                  phone = CASE WHEN excluded.phone <> '' THEN excluded.phone ELSE shop_orders.phone END,
                  shipment = excluded.shipment, payment = excluded.payment,
                  items_json = excluded.items_json, seen_at = excluded.seen_at,
                  -- Adresu přepisuje jen ta, která za něco stojí: rychlý feed
                  -- ji nemusí nést vůbec a prázdnou hodnotou by se ztratila
                  billing_json = CASE WHEN excluded.billing_json IS NOT NULL
                    THEN excluded.billing_json ELSE shop_orders.billing_json END,
                  postal_json = CASE WHEN excluded.postal_json IS NOT NULL
                    THEN excluded.postal_json ELSE shop_orders.postal_json END
                """, [
                .text(order["code"] as? String ?? ""),
                .text(order["market"] as? String ?? "cz"),
                .text(order["status"] as? String ?? ""),
                .int((order["paid"] as? Bool ?? false) ? 1 : 0),
                .text(order["paidDate"] as? String ?? ""),
                .int((order["resolved"] as? Bool ?? false) ? 1 : 0),
                .text(order["invoice"] as? String ?? ""),
                .text(order["createdAt"] as? String ?? ""),
                .text(order["updatedAt"] as? String ?? ""),
                .text(order["currency"] as? String ?? ""),
                .double(order["total"] as? Double ?? 0),
                .text(order["tracking"] as? String ?? ""),
                .text(order["customerId"] as? String ?? ""),
                .text(order["name"] as? String ?? ""),
                .text(order["email"] as? String ?? ""),
                .text(order["phone"] as? String ?? ""),
                .text(order["shipment"] as? String ?? ""),
                .text(order["payment"] as? String ?? ""),
                .text(items),
                json(order["billing"]),
                json(order["postal"]),
                .text(now)
            ])
        }
    }

    @discardableResult
    static func refresh(id: String) async throws -> Int {
        guard let feed = feeds().first(where: { $0.id == id }) else {
            throw BridgeError.message("Feed objednávek nenalezen.")
        }
        do {
            let data = try await Http.request(feed.url, timeout: 120)
            let xml = String(data: data, encoding: .utf8) ?? Mime.string(data, charset: "windows-1250")
            let orders = parse(xml, market: feed.market)
            if orders.isEmpty && xml.range(of: "<ORDERS?\\b", options: [.regularExpression, .caseInsensitive]) == nil {
                throw BridgeError.message("Odpověď nevypadá jako export objednávek.")
            }
            store(orders)
            Store.setSetting("orderFeedSync:\(feed.id)", ISO8601DateFormatter().string(from: Date()))
            Store.setSetting("orderFeedError:\(feed.id)", "")
            return orders.count
        } catch {
            Store.setSetting("orderFeedError:\(feed.id)", error.localizedDescription)
            throw error
        }
    }

    /**
     Kolik vteřin se počká po celé značce, než se sáhne pro soubor.

     E-shop ho v tu chvíli teprve zapisuje; stažení přesně v :05:00 by vrátilo
     ten předchozí.
     */
    private static let grace: TimeInterval = 40

    /**
     Je feed na řadě?

     Nepočítá se od posledního stažení, ale podle skutečného času. E-shop
     přegenerovává soubor v pevných značkách — pětiminutový v :00, :05, :10 —
     takže „naposledy plus pět minut" znamená trvalé opoždění: stáhne se ve
     12:03, další pokus ve 12:08, jenže to je pořád soubor z 12:05. Takhle se
     místo toho pozná, že přibyla nová značka.

     U feedů delších než hodina (celý export jednou denně) na značky nezáleží
     a rozhoduje prostý odstup.
     */
    static func due(everyMinutes: Int, lastRun: String, now: Date = Date()) -> Bool {
        let period = Double(max(1, everyMinutes)) * 60
        guard !lastRun.isEmpty, let last = ISO8601DateFormatter().date(from: lastRun) else { return true }
        // Hodiny na telefonu se dají posunout; budoucí značka by feed zamkla
        if last > now { return true }
        if period > 3600 { return now.timeIntervalSince(last) >= period }

        let slot = { (t: Date) in floor((t.timeIntervalSince1970 - grace) / period) }
        return slot(now) > slot(last)
    }

    /// Obnova těch feedů, kterým došel jejich vlastní interval.
    @discardableResult
    static func refreshDue(force: Bool = false) async -> [[String: Any]] {
        var out: [[String: Any]] = []
        for feed in feeds() where feed.enabled {
            let last = Store.setting("orderFeedSync:\(feed.id)", "") ?? ""
            if !force && !due(everyMinutes: feed.everyMinutes, lastRun: last) { continue }
            do {
                let count = try await refresh(id: feed.id)
                out.append(["feed": feed.label, "orders": count])
            } catch {
                // Chyba jednoho feedu nesmí zastavit ostatní: velký export
                // může být chvíli nedostupný, a přitom ten s dnešními
                // objednávkami funguje
                out.append(["feed": feed.label, "orders": 0, "error": error.localizedDescription])
            }
        }
        return out
    }

    // MARK: - Dotazy

    private static func row(_ raw: [String: Any]) -> [String: Any] {
        var items: [Any] = []
        if let json = raw["items_json"] as? String, let data = json.data(using: .utf8),
           let parsed = try? JSONSerialization.jsonObject(with: data) as? [Any] {
            items = parsed
        }
        return [
            "code": raw["code"] as? String ?? "",
            "market": raw["market"] as? String ?? "",
            "status": raw["status"] as? String ?? "",
            "paid": (raw["paid"] as? Int ?? 0) == 1,
            "paidDate": raw["paid_date"] as? String ?? "",
            "resolved": (raw["resolved"] as? Int ?? 0) == 1,
            "invoice": raw["invoice"] as? String ?? "",
            "createdAt": raw["created_at"] as? String ?? "",
            "updatedAt": raw["updated_at"] as? String ?? "",
            "currency": raw["currency"] as? String ?? "",
            "total": raw["total"] as? Double ?? Double(count(raw["total"])),
            "tracking": raw["tracking"] as? String ?? "",
            "customerId": raw["customer_id"] as? String ?? "",
            "name": raw["name"] as? String ?? "",
            "email": raw["email"] as? String ?? "",
            "phone": raw["phone"] as? String ?? "",
            "shipment": raw["shipment"] as? String ?? "",
            "payment": raw["payment"] as? String ?? "",
            "items": items,
            "billing": parsed(raw["billing_json"]) ?? NSNull(),
            "postal": parsed(raw["postal_json"]) ?? NSNull()
        ]
    }

    /// Uložený JSON zpátky na slovník; poškozený řádek se bere jako prázdný.
    private static func parsed(_ value: Any?) -> [String: Any]? {
        guard let text = value as? String, let data = text.data(using: .utf8) else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }

    /**
     Obnova feedů před sestavením seznamu k balení.

     Rychlý feed s posledními 24 h se sahá vždycky — právě o dnešní objednávky
     při balení jde. Kompletní exporty jen tehdy, když okno sahá dál než den;
     jsou velké a přegenerovávají se stejně jednou denně.

     Chyba se polyká: bez sítě se má seznam poskládat z uloženého, ne se
     neotevřít.
     */
    static func refreshForPacking(days: Int, force: Bool = false) async {
        for feed in feeds() where feed.enabled && (feed.recent || days > 1) {
            let last = Store.setting("orderFeedSync:\(feed.id)", "") ?? ""
            if !force && !due(everyMinutes: feed.everyMinutes, lastRun: last) { continue }
            _ = try? await refresh(id: feed.id)
        }
    }

    /**
     Objednávky za posledních `days` dní, jak je vede feed.

     Řadí se podle vzniku, ne podle poslední změny: při balení se jde odshora
     a nejstarší nezabalená objednávka nesmí spadnout dolů jen proto, že se
     u ní něco přepsalo.
     */
    static func since(days: Int, limit: Int = 400) -> [[String: Any]] {
        let from = Date().addingTimeInterval(-Double(max(1, days)) * 86_400)
        let rows = (try? SQLite.shared.query(
            "SELECT * FROM shop_orders WHERE created_at >= ? ORDER BY created_at DESC LIMIT ?",
            [.text(ISO8601DateFormatter().string(from: from)), .int(Int64(limit))]
        )) ?? []
        return rows.map { row($0) }
    }

    static func byEmail(_ email: String, limit: Int = 12) -> [[String: Any]] {
        let clean = email.trimmingCharacters(in: .whitespaces).lowercased()
        guard !clean.isEmpty else { return [] }
        let rows = (try? SQLite.shared.query(
            "SELECT * FROM shop_orders WHERE email = ? ORDER BY created_at DESC LIMIT ?",
            [.text(clean), .int(Int64(limit))]
        )) ?? []
        return rows.map(row)
    }

    static func byCode(_ code: String) -> [String: Any]? {
        let clean = code.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "#", with: "")
        guard !clean.isEmpty else { return nil }
        let trimmed = clean.drop(while: { $0 == "0" })
        let rows = (try? SQLite.shared.query(
            "SELECT * FROM shop_orders WHERE code = ? OR code = ? ORDER BY created_at DESC LIMIT 1",
            [.text(clean), .text(String(trimmed))]
        )) ?? []
        return rows.first.map(row)
    }

    /// Čísla objednávek zmíněná v textu — zákazník je v chatu píše do zprávy.
    static func codesInText(_ text: String) -> [String] {
        var seen: [String] = []
        for found in matches(text, "\\b(?:č\\.|c\\.|no\\.|nr\\.|#)?\\s*(\\d{5,10})\\b") where found.count > 1 {
            if !seen.contains(found[1]) { seen.append(found[1]) }
            if seen.count >= 5 { break }
        }
        return seen
    }

    /**
     Kontakt na zákazníka — to hlavní, kvůli čemu se feedy tahají.

     Hledá se od nejjednoznačnějšího: číslo objednávky, pak e-mail, a nakonec
     číslo zmíněné v textu zprávy pro případ, kdy zákazník píše z jiné adresy,
     než na kterou objednával.
     */
    static func contact(_ input: [String: Any]) -> [String: Any] {
        let email = (input["email"] as? String ?? "").trimmingCharacters(in: .whitespaces)
        let orderCode = (input["orderCode"] as? String ?? "").trimmingCharacters(in: .whitespaces)
        let text = input["text"] as? String ?? ""

        func answer(phone: String, name: String, order: [String: Any]?, orders: Int, via: String) -> [String: Any] {
            ["phone": phone, "name": name, "order": order ?? NSNull(), "orders": orders, "via": via]
        }

        if !orderCode.isEmpty, let order = byCode(orderCode) {
            let phone = order["phone"] as? String ?? ""
            if !phone.isEmpty {
                return answer(phone: phone, name: order["name"] as? String ?? "",
                              order: order, orders: 1, via: "podle objednávky")
            }
            // Objednávka bez telefonu ještě není smůla — týž zákazník ho mohl
            // vyplnit u jiné
            let list = byEmail(order["email"] as? String ?? "")
            if let withPhone = list.first(where: { !(($0["phone"] as? String) ?? "").isEmpty }) {
                return answer(phone: withPhone["phone"] as? String ?? "",
                              name: withPhone["name"] as? String ?? "",
                              order: order, orders: list.count, via: "podle objednávky")
            }
        }

        if !email.isEmpty {
            let list = byEmail(email)
            if let withPhone = list.first(where: { !(($0["phone"] as? String) ?? "").isEmpty }) {
                return answer(phone: withPhone["phone"] as? String ?? "",
                              name: withPhone["name"] as? String ?? "",
                              order: list.first, orders: list.count, via: "podle e-mailu")
            }
            if !list.isEmpty {
                return answer(phone: "", name: list[0]["name"] as? String ?? "",
                              order: list.first, orders: list.count, via: "podle e-mailu")
            }
        }

        for code in codesInText(text) {
            let found = contact(["orderCode": code])
            if !((found["phone"] as? String) ?? "").isEmpty {
                return answer(phone: found["phone"] as? String ?? "",
                              name: found["name"] as? String ?? "",
                              order: found["order"] as? [String: Any],
                              orders: found["orders"] as? Int ?? 1,
                              via: "podle čísla \(code) ze zprávy")
            }
        }

        return answer(phone: "", name: "", order: nil, orders: 0, via: "")
    }
}
