import Foundation

/**
 Karta objednávky u zprávy.

 Postup je stejný jako na počítači: z těla potvrzovacího e-mailu se vyčte
 objednávka (funguje i bez API), položky se spárují s produktovým feedem kvůli
 obrázkům a odkazům a nakonec se doplní živý stav z Upgates a sledování
 zásilky. Když se z e-mailu vyčíst nedá nic — třeba u dotazu od zákazníka —
 zkusí se ještě dohledání přes API podle čísla objednávky nebo adresy;
 tuhle záložní cestu počítač nemá, na telefonu se ale hodí, protože je stejně
 vždycky online.

 Rozbor e-mailu dělá `OrderParse`, sledování zásilky `OrderTrack`.
 */
enum Orders {
    // MARK: - Veřejné vstupy

    /**
     Karta objednávky ke zprávě.

     - Parameters:
       - withLive: doplnit stav z e-shopu a od dopravce (bez toho jen rozbor mailu)
       - withRendered: druhá fáze sledování — stránka dopravce ve skrytém webview
       - force: přeskočit uložený stav u uzavřených objednávek
     */
    static func card(dbId: Int,
                     withLive: Bool = true,
                     withRendered: Bool = false,
                     force: Bool = false) async -> [String: Any]? {
        guard let message = MailStore.row(dbId) else { return nil }

        let subject = string(message["subject"]) ?? ""
        let fromAddr = string(message["from_addr"]) ?? ""
        var card = OrderParse.parseOrderEmail(
            subject: subject,
            html: string(message["body_html"]),
            text: string(message["body_text"]),
            toAddr: string(message["to_addr"]) ?? ""
        )

        if var parsed = card {
            var items = parsed["items"] as? [[String: Any]] ?? []
            matchItemsToFeed(&items, lang: parsed["lang"] as? String ?? "cz")
            parsed["items"] = items
            // Cizí e-shop (Alza, Tesco…) má potvrzení k nerozeznání od našeho —
            // karta se ukáže jen tehdy, když zpráva prokazatelně patří k nám
            card = isOurShop(parsed, fromAddr: fromAddr) ? parsed : nil
        }

        // Záloha pro telefon: dotaz zákazníka není potvrzení objednávky, ale
        // objednávku k němu často dohledáme přes API
        if card == nil {
            card = await apiCard(dbId: dbId, message: message)
            if card == nil { return nil }
        }

        guard var result = card else { return nil }

        if withLive {
            // Uzavřená objednávka se už nezmění — čte se z databáze
            if !force, let done = finalCache(dbId) { return done }

            let number = result["orderNumber"] as? String ?? ""
            if !number.isEmpty, Upgates.isReady, result["live"] as? [String: Any] == nil {
                if let live = try? await Upgates.orderLive(orderNumber: number,
                                                           email: result["customerEmail"] as? String) {
                    result["live"] = live
                }
            }

            let live = result["live"] as? [String: Any]
            let fallback = OrderTrack.Fallback(
                shipmentName: result["shipmentName"] as? String,
                trackingCode: live?["trackingCode"] as? String,
                trackingUrl: live?["trackingUrl"] as? String
            )
            if let tracking = await OrderTrack.liveTracking(
                historyUrl: result["historyUrl"] as? String,
                fallback: fallback,
                withRendered: withRendered,
                force: force
            ) {
                result["tracking"] = tracking
                // Telefon v mailu nebývá, na stránce objednávky ano
                if string(result["customerPhone"]) == nil,
                   let phone = tracking["customerPhone"] as? String {
                    result["customerPhone"] = phone
                }
            }

            let tracking = result["tracking"] as? [String: Any]
            let status = (tracking?["status"] as? String) ?? (live?["status"] as? String)
            let hasEvent = (tracking?["shipment"] as? [String: Any]) != nil
            let hasCode = (tracking?["trackingCode"] as? String)?.isEmpty == false
            // Uložit až s poslední hláškou dopravce, jinak by se stav zamrazil
            // ve chvíli, kdy o zásilce ještě nic nevíme
            if OrderTrack.isFinalStatus(status), hasEvent || !hasCode {
                var finished = result
                let admin = adminLink(finished)
                finished["adminUrl"] = admin.url
                finished["adminSource"] = admin.source
                writeCache(dbId, finished)
            }
        }

        let admin = adminLink(result)
        result["adminUrl"] = admin.url
        result["adminSource"] = admin.source
        return result
    }

    /// Zkrácený odznak do seznamu zpráv — jen číslo, částka a stav.
    static func badge(dbId: Int) async -> [String: Any]? {
        guard let card = await card(dbId: dbId) else { return nil }
        let live = card["live"] as? [String: Any]
        let tracking = card["tracking"] as? [String: Any]
        let status = (tracking?["status"] as? String) ?? (live?["status"] as? String)
        let paid = (live?["paid"] as? Bool ?? false) || (tracking?["paidDate"] as? String != nil)
        let delivered = live?["deliveredDate"] as? String != nil

        var stage: Any = NSNull()
        if let shipment = tracking?["shipment"] as? [String: Any] {
            if let value = shipment["stage"] as? String ?? shipment["description"] as? String { stage = value }
        }

        let number = card["orderNumber"] as? String ?? ""
        let feed = number.isEmpty ? nil : OrderFeed.byCode(number)
        let shipmentName = (feed?["shipment"] as? String) ?? (card["shipmentName"] as? String)
        let paymentName = (feed?["payment"] as? String) ?? (card["paymentName"] as? String)
        /*
         Prázdná zkratka je „nemám co ukázat", ne prázdný text — rozhraní
         podle toho pozná, že má nechat číslo a stav. `NSNull` v ternárním
         výrazu si Swift s textem neporovná, proto se to skládá po krocích.
         */
        var shipmentShort: Any = NSNull()
        let shipmentValue = Shorthand.shortFor("shipment", shipmentName)
        if !shipmentValue.isEmpty { shipmentShort = shipmentValue }
        var paymentShort: Any = NSNull()
        let paymentValue = Shorthand.shortFor("payment", paymentName)
        if !paymentValue.isEmpty { paymentShort = paymentValue }

        return [
            "orderNumber": card["orderNumber"] ?? NSNull(),
            "total": card["total"] ?? NSNull(),
            "status": status ?? NSNull(),
            "tone": tone(status: status, paid: paid, delivered: delivered),
            "carrierName": tracking?["carrierName"] ?? NSNull(),
            "shipmentStage": stage,
            /*
             Doprava a platba ve zkratce — na telefonu to jediné, co se na
             odznak vejde. Berou se z feedu, ne z potvrzovacího e-mailu:
             v mailu je, co si zákazník vybral při objednání, ve feedu to,
             co u objednávky platí teď.
             */
            "shipmentShort": shipmentShort,
            "paymentShort": paymentShort
        ]
    }

    /// Dotažení stavu zásilky po zobrazení karty (druhá fáze, se skrytým webview).
    static func shipment(dbId: Int, force: Bool = false) async -> [String: Any]? {
        guard let card = await card(dbId: dbId, withLive: true, withRendered: true, force: force) else { return nil }
        return card["tracking"] as? [String: Any]
    }

    /// Stav e-shopu (volný text) na barvu odznaku.
    static func tone(status: String?, paid: Bool, delivered: Bool) -> String {
        let value = (status ?? "").lowercased()
        if matches(value, "storn|zru[šs]en|vr[áa]cen|reklamac|cancel|refund") { return "problem" }
        if delivered || matches(value, "doru[čc]en|vyzvednut|dokon[čc]en|uzav[řr]en|complete|delivered") { return "done" }
        if matches(value, "odesl[áa]n|expedov|p[řr]ed[áa]n|na cest[ěe]|shipped|dispatch") { return "sent" }
        if paid || matches(value, "zaplacen|uhrazen|paid") { return "paid" }
        return "new"
    }

    /// Je odesílatel z našeho e-shopu? Používá i balení při výběru zpráv.
    static func shopMatchesSender(_ fromAddr: String) -> Bool {
        let host = String(fromAddr.split(separator: "@").last ?? "").lowercased()
        return matchesShop(strippingWww(host))
    }

    /// Po přesynchronizování feedu se sada domén nesmí držet zastaralá.
    static func resetShopDomains() {
        domainsLock.lock()
        domainsCache = nil
        domainsLock.unlock()
    }

    // MARK: - Párování s produktovým feedem

    private static let feedLangs = ["cz", "sk", "en"]

    /// Doplní obrázek, kanonickou adresu a aktuální cenu z tabulky `products`.
    static func matchItemsToFeed(_ items: inout [[String: Any]], lang: String) {
        guard !items.isEmpty else { return }
        var all: [[String: Any]]?

        for index in items.indices {
            var item = items[index]
            var row: [String: Any]?

            if let code = (item["code"] as? String)?.trimmingCharacters(in: .whitespaces), !code.isEmpty {
                row = (try? SQLite.shared.query(
                    "SELECT * FROM products WHERE lower(code) = lower(?)", [.text(code)]
                ))?.first
            }

            if row == nil, let url = item["url"] as? String, let slug = slug(url) {
                if all == nil { all = (try? SQLite.shared.query("SELECT * FROM products")) ?? [] }
                row = all?.first { candidate in
                    feedLangs.contains { Self.slug(candidate["url_\($0)"] as? String ?? "") == slug }
                }
            }

            if row == nil, let title = item["title"] as? String, !title.isEmpty {
                let wanted = title.trimmingCharacters(in: .whitespaces).lowercased()
                if all == nil { all = (try? SQLite.shared.query("SELECT * FROM products")) ?? [] }
                row = all?.first { candidate in
                    feedLangs.contains {
                        (candidate["title_\($0)"] as? String ?? "")
                            .trimmingCharacters(in: .whitespaces).lowercased() == wanted
                    }
                }
            }

            guard let product = row else { continue }
            let pick: (String) -> String? = { field in
                for key in [lang] + feedLangs {
                    if let value = product["\(field)_\(key)"] as? String, !value.isEmpty { return value }
                }
                return nil
            }

            item["matched"] = true
            item["image"] = product["image"] as? String ?? NSNull()
            item["feedUrl"] = pick("url") ?? NSNull()
            item["feedPrice"] = pick("price") ?? NSNull()
            if (item["code"] as? String ?? "").isEmpty, let code = product["code"] as? String {
                item["code"] = code
            }
            if (item["title"] as? String ?? "").isEmpty, let title = pick("title") {
                item["title"] = title
            }
            items[index] = item
        }
    }

    private static func slug(_ url: String?) -> String? {
        guard let url, !url.isEmpty else { return nil }
        if let parts = groups(url, "/p/([^/?#]+)") { return parts[1].lowercased() }
        if let parts = groups(url, "/([^/?#]+)/?$") { return parts[1].lowercased() }
        return nil
    }

    // MARK: - Domény vlastního e-shopu

    private static var domainsCache: (at: Date, hosts: Set<String>, labels: Set<String>)?
    private static let domainsLock = NSLock()

    private static func shopDomains() -> (hosts: Set<String>, labels: Set<String>) {
        domainsLock.lock()
        defer { domainsLock.unlock() }
        if let cached = domainsCache, Date().timeIntervalSince(cached.at) < 600 {
            return (cached.hosts, cached.labels)
        }

        var hosts = Set<String>()
        if let feed = Store.setting("productFeedUrl"), let host = host(of: feed) { hosts.insert(host) }
        let rows = (try? SQLite.shared.query(
            "SELECT url_cz, url_sk, url_en FROM products WHERE url_cz != '' OR url_sk != '' OR url_en != '' LIMIT 40"
        )) ?? []
        for row in rows {
            for key in ["url_cz", "url_sk", "url_en"] {
                if let host = host(of: row[key] as? String ?? "") { hosts.insert(host) }
            }
        }
        let labels = Set(hosts.map { baseLabel($0) })
        domainsCache = (Date(), hosts, labels)
        return (hosts, labels)
    }

    private static func host(of url: String) -> String? {
        guard !url.isEmpty, let host = URL(string: url)?.host else { return nil }
        return strippingWww(host.lowercased())
    }

    private static func strippingWww(_ host: String) -> String {
        host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
    }

    /// „quentino.cz" → „quentino"; podle toho projdou i .sk a .com mutace
    private static func baseLabel(_ host: String) -> String {
        let parts = host.split(separator: ".")
        if parts.count > 2 { return String(parts[parts.count - 2]) }
        if let first = parts.first { return String(first) }
        return host
    }

    private static func matchesShop(_ host: String?) -> Bool {
        guard let host, !host.isEmpty else { return false }
        let domains = shopDomains()
        if domains.hosts.contains(host) { return true }
        let label = baseLabel(host)
        return domains.labels.contains { $0.count >= 4 && (label == $0 || label.contains($0)) }
    }

    private static func isOurShop(_ card: [String: Any], fromAddr: String) -> Bool {
        guard !shopDomains().hosts.isEmpty else { return false }
        if shopMatchesSender(fromAddr) { return true }

        let items = card["items"] as? [[String: Any]] ?? []
        if items.contains(where: { matchesShop(host(of: $0["url"] as? String ?? "")) }) { return true }
        if let history = card["historyUrl"] as? String, matchesShop(host(of: history)) { return true }
        if items.contains(where: { $0["matched"] as? Bool == true }) { return true }
        return false
    }

    // MARK: - Odkaz do administrace

    /**
     Adresa administrace Upgates. Bere se z nastavení API, a když není vyplněné,
     odvodí se z domény obrázků ve feedu — „quentino.s19.cdn-upgates.com" má
     administraci na „quentino.admin.s19.upgates.com".
     */
    private static func adminBase() -> String? {
        if let configured = Store.setting("upgatesUrl"), !configured.isEmpty {
            var value = configured
            while value.hasSuffix("/") { value.removeLast() }
            return value
        }
        let row = (try? SQLite.shared.query(
            "SELECT image FROM products WHERE image != '' AND image IS NOT NULL LIMIT 1"
        ))?.first
        guard let image = row?["image"] as? String, let host = URL(string: image)?.host,
              let parts = groups(host, "^([a-z0-9-]+)\\.([a-z0-9]+)\\.cdn-upgates\\.com$") else { return nil }
        return "https://\(parts[1]).admin.\(parts[2]).upgates.com"
    }

    /**
     Adresa objednávky v administraci obsahuje vnitřní ID záznamu, ne číslo
     objednávky. Přesně ho dá jen API; bez něj se dopočítá z kalibrace — jedné
     známé dvojice „číslo objednávky : ID v administraci". Obě řady rostou po
     jedné, takže rozdíl zůstává stálý.
     */
    private static func adminLink(_ card: [String: Any]) -> (url: Any, source: Any) {
        if let live = card["live"] as? [String: Any], let url = live["adminUrl"] as? String, !url.isEmpty {
            return (url, "api")
        }
        guard let base = adminBase() else { return (NSNull(), NSNull()) }

        let reference = (Store.setting("adminOrderRef") ?? "").trimmingCharacters(in: .whitespaces)
        let digits = (card["orderNumber"] as? String ?? "").filter { $0.isNumber }
        if let parts = groups(reference, "^(\\d+)\\s*[:/]\\s*(\\d+)$"),
           let number = Int(digits), let from = Int(parts[1]), let to = Int(parts[2]) {
            let id = number - (from - to)
            if id > 0 { return ("\(base)/orders/edit-order/default/\(id)/", "offset") }
        }
        return ("\(base)/orders/", "list")
    }

    // MARK: - Uložené hotové objednávky

    /**
     Doručená, stornovaná nebo vrácená objednávka se už nezmění. Načte se tedy
     naposledy — i se stavem zásilky — a od té chvíle se čte jen z databáze.
     */
    private static func finalCache(_ dbId: Int) -> [String: Any]? {
        let row = (try? SQLite.shared.query(
            "SELECT json FROM order_cache WHERE message_pk = ?", [.int(Int64(dbId))]
        ))?.first
        guard let text = row?["json"] as? String, let data = text.data(using: .utf8),
              let card = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }

        let tracking = card["tracking"] as? [String: Any]
        let live = card["live"] as? [String: Any]
        let status = (tracking?["status"] as? String) ?? (live?["status"] as? String)
        guard OrderTrack.isFinalStatus(status) else { return nil }
        // Starší záznamy vznikly dřív, než se u uzavřených objednávek dotahoval
        // stav zásilky — u těch by dopravce chyběl navždy
        if (tracking?["trackingCode"] as? String)?.isEmpty == false,
           (tracking?["shipment"] ?? NSNull()) is NSNull {
            return nil
        }
        return card
    }

    static func writeCache(_ dbId: Int, _ card: [String: Any]?) {
        var value = SQLite.Value.null
        if let card, let data = try? JSONSerialization.data(withJSONObject: card),
           let text = String(data: data, encoding: .utf8) {
            value = .text(text)
        }
        _ = try? SQLite.shared.run(
            """
            INSERT INTO order_cache (message_pk, json, at) VALUES (?, ?, ?)
            ON CONFLICT(message_pk) DO UPDATE SET json = excluded.json, at = excluded.at
            """,
            [.int(Int64(dbId)), value, .text(Formats.iso(Date()))]
        )
    }

    // MARK: - Záložní cesta přes API

    /// Číslo objednávky v textu zprávy. U Quentina je osmiciferné.
    static func orderNumber(in message: [String: Any]) -> String? {
        let subject = string(message["subject"]) ?? ""
        let haystack = [
            subject,
            string(message["body_text"]) ?? "",
            Mime.snippet(html: string(message["body_html"]), text: nil, limit: 4000),
            string(message["snippet"]) ?? ""
        ].joined(separator: "\n")

        let pattern = "(?:objedn\\w*|order|číslo|number)\\D{0,20}(\\d{6,12})"
        if let parts = groups(haystack, pattern) { return parts[1] }
        if let parts = groups(subject, "\\b(\\d{8})\\b") { return parts[1] }
        return nil
    }

    /**
     Objednávka dohledaná přes API, když se z e-mailu nedá vyčíst nic.

     Potvrzení chodí z e-shopu, ne od zákazníka, takže se zkouší adresa
     odesílatele i adresy z pole „komu". Rozhoduje číslo objednávky z textu;
     když ve zprávě není, karta se ukáže jen tehdy, má-li zákazník jedinou
     objednávku — jinak by se hádalo.
     */
    private static func apiCard(dbId: Int, message: [String: Any]) async -> [String: Any]? {
        guard Upgates.isReady else { return nil }
        let number = orderNumber(in: message)

        var candidates: [String] = []
        if let from = string(message["from_addr"])?.lowercased(), from.contains("@") {
            candidates.append(from)
        }
        for address in Mime.addresses(string(message["to_addr"]) ?? "") where address.address.contains("@") {
            let mail = address.address.lowercased()
            if !candidates.contains(mail) { candidates.append(mail) }
        }
        guard !candidates.isEmpty else { return nil }

        for candidate in candidates {
            guard let orders = try? await Upgates.rawOrders(email: candidate), !orders.isEmpty else { continue }
            if let number {
                if let hit = orders.first(where: { sameNumber($0["order_number"], number) }) {
                    return apiCardBody(hit, email: candidate)
                }
            } else if orders.count == 1 {
                return apiCardBody(orders[0], email: candidate)
            }
        }
        return nil
    }

    private static func sameNumber(_ candidate: Any?, _ wanted: String) -> Bool {
        guard let candidate = string(candidate) else { return false }
        let trim: (String) -> String = { value in
            var out = value
            while out.hasPrefix("0"), out.count > 1 { out.removeFirst() }
            return out
        }
        return trim(candidate) == trim(wanted)
    }

    /// Objednávka z API převedená do stejného tvaru, jaký vrací rozbor e-mailu.
    private static func apiCardBody(_ raw: [String: Any], email: String?) -> [String: Any] {
        let currency = string(raw["currency_id"]) ?? "CZK"
        let shipment = raw["shipment"] as? [String: Any]
        let payment = raw["payment"] as? [String: Any]

        var customerEmail: Any = NSNull()
        if let found = string(raw["email"]) ?? email { customerEmail = found }

        var items = products(raw, currency: currency)
        let lang = (string(raw["language_id"]) ?? "cz").lowercased()
        matchItemsToFeed(&items, lang: lang)

        let live: [String: Any] = [
            "status": string(raw["status"]) ?? NSNull(),
            "paid": string(raw["paid_date"]) != nil,
            "paidDate": string(raw["paid_date"]) ?? NSNull(),
            "deliveredDate": string(raw["delivered_date"]) ?? NSNull(),
            "trackingCode": string(raw["tracking_code"]) ?? NSNull(),
            "trackingUrl": string(raw["tracking_url"]) ?? NSNull(),
            "adminUrl": string(raw["admin_url"]) ?? NSNull()
        ]

        return [
            "orderNumber": string(raw["order_number"]) ?? NSNull(),
            "lang": lang,
            "placedAt": string(raw["creation_time"]) ?? NSNull(),
            "customerEmail": customerEmail,
            "customerPhone": string(raw["phone"]) ?? NSNull(),
            "billing": address(raw, prefix: "_invoice"),
            "shipping": address(raw, prefix: "_postal"),
            "items": items,
            "shipmentName": string(shipment?["name"]) ?? NSNull(),
            "shipmentPrice": money(shipment?["price_with_vat"], currency: currency) ?? NSNull(),
            "paymentName": string(payment?["name"]) ?? NSNull(),
            "paymentPrice": money(payment?["price_with_vat"], currency: currency) ?? NSNull(),
            "total": money(raw["order_total"], currency: currency) ?? NSNull(),
            "historyUrl": NSNull(),
            "adminUrl": NSNull(),
            "adminSource": NSNull(),
            "live": live,
            "tracking": NSNull()
        ]
    }

    /// Adresa zákazníka; API má fakturační a dodací pod různými prefixy.
    private static func address(_ raw: [String: Any], prefix: String) -> Any {
        let name = [string(raw["firstname\(prefix)"]), string(raw["surname\(prefix)"])]
            .compactMap { $0 }.joined(separator: " ")
        let street = string(raw["street\(prefix)"])
        let cityLine = [string(raw["zip\(prefix)"]), string(raw["city\(prefix)"])]
            .compactMap { $0 }.joined(separator: " ")
        let lines = [street, cityLine.isEmpty ? nil : cityLine].compactMap { $0 }
        if name.isEmpty && lines.isEmpty { return NSNull() }
        return [
            "name": name,
            "company": string(raw["company\(prefix)"]) ?? NSNull(),
            "lines": lines,
            "country": string(raw["country\(prefix)"]) ?? NSNull()
        ] as [String: Any]
    }

    private static func products(_ raw: [String: Any], currency: String) -> [[String: Any]] {
        (raw["products"] as? [[String: Any]] ?? [])
            .filter { ($0["type"] as? String) != "shipment" && ($0["type"] as? String) != "payment" }
            // Typ návratu explicitně — u víceřádkové uzávěry se slovník s tuctem
            // klíčů jinak překládá neúnosně dlouho
            .map { product -> [String: Any] in
                let variants = (product["parameters"] as? [[String: Any]] ?? []).compactMap { parameter -> String? in
                    guard let name = string(parameter["name"]), let value = string(parameter["value"]) else { return nil }
                    return "\(name): \(value)"
                }
                return [
                    "qty": (product["quantity"] as? NSNumber)?.intValue ?? 1,
                    "unit": string(product["unit"]) ?? NSNull(),
                    "title": string(product["title"]) ?? "",
                    "code": string(product["code"]) ?? NSNull(),
                    "url": string(product["url"]) ?? NSNull(),
                    "price": money(product["price_per_unit_with_vat"] ?? product["price_with_vat"],
                                   currency: currency) ?? "",
                    "availability": string(product["availability"]) ?? NSNull(),
                    "variants": variants,
                    "image": string(product["image_url"]) ?? NSNull(),
                    "feedUrl": NSNull(),
                    "feedPrice": NSNull(),
                    "matched": false
                ]
            }
    }

    // MARK: - Drobnosti

    private static func string(_ value: Any?) -> String? {
        guard let value, !(value is NSNull) else { return nil }
        let text = value as? String ?? String(describing: value)
        return text.isEmpty ? nil : text
    }

    private static func money(_ value: Any?, currency: String) -> String? {
        guard let value, !(value is NSNull) else { return nil }
        let number = (value as? NSNumber)?.doubleValue ?? Double(String(describing: value))
        guard let number else { return nil }
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        formatter.maximumFractionDigits = number == number.rounded() ? 0 : 2
        formatter.groupingSeparator = "\u{00a0}"
        let formatted = formatter.string(from: NSNumber(value: number)) ?? String(number)
        let symbol = ["CZK": "Kč", "EUR": "€", "PLN": "zł"][currency] ?? currency
        return "\(formatted)\u{00a0}\(symbol)"
    }

    private static func groups(_ text: String, _ pattern: String) -> [String]? {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]),
              let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) else { return nil }
        var out: [String] = []
        for index in 0..<match.numberOfRanges {
            if let range = Range(match.range(at: index), in: text) {
                out.append(String(text[range]))
            } else {
                out.append("")
            }
        }
        return out
    }

    private static func matches(_ text: String, _ pattern: String) -> Bool {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else { return false }
        return regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
    }
}
