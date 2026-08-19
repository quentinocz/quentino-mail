import Foundation

/**
 Karta objednávky u zprávy.

 Na počítači se skládá ze dvou zdrojů: rozboru potvrzovacího e-mailu (funguje
 i bez internetu) a živých dat z Upgates. Na telefonu je aplikace stejně vždy
 online, takže se jde rovnou k API — z e-mailu se bere jen číslo objednávky.
 Ušetří to tisíc řádků rozboru e-mailových šablon a výsledek je přesnější:
 stav, platba, doprava i sledovací číslo jsou z e-shopu, ne z textu měsíc
 starého e-mailu.

 Co z toho plyne: bez nastaveného Upgates API karta není. Na počítači by se
 v takovém případě vysadila aspoň z e-mailu — tady se radši neukáže nic, než
 aby se ukazovala neúplná.
 */
enum Orders {
    /// Číslo objednávky v textu. U Quentina je osmiciferné (`20260819`),
    /// hranice šesti číslic drží stranou roky a částky.
    private static let numberPattern = "(?:objedn\\w*|order|číslo|number)\\D{0,20}(\\d{6,12})"

    static func orderNumber(in message: [String: Any]) -> String? {
        let subject = message["subject"] as? String ?? ""
        let haystack = [
            subject,
            message["body_text"] as? String ?? "",
            (message["body_html"] as? String).map { Mime.snippet(html: $0, text: nil, limit: 4000) } ?? "",
            message["snippet"] as? String ?? ""
        ].joined(separator: "\n")

        if let found = firstMatch(haystack, numberPattern) { return found }
        // Záloha: samotné osmiciferné číslo v předmětu
        return firstMatch(subject, "\\b(\\d{8})\\b")
    }

    private static func firstMatch(_ text: String, _ pattern: String) -> String? {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]),
              let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              match.numberOfRanges > 1,
              let range = Range(match.range(at: 1), in: text) else { return nil }
        return String(text[range])
    }

    // MARK: - Převod odpovědi API

    private static func text(_ value: Any?) -> String? {
        guard let value, !(value is NSNull) else { return nil }
        let string = value as? String ?? String(describing: value)
        return string.isEmpty ? nil : string
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

    /// Adresa zákazníka; API má fakturační a dodací pod různými prefixy.
    private static func address(_ raw: [String: Any], prefix: String) -> Any {
        let name = [text(raw["firstname\(prefix)"]), text(raw["surname\(prefix)"])]
            .compactMap { $0 }.joined(separator: " ")
        let street = text(raw["street\(prefix)"])
        let cityLine = [text(raw["zip\(prefix)"]), text(raw["city\(prefix)"])]
            .compactMap { $0 }.joined(separator: " ")
        let lines = [street, cityLine.isEmpty ? nil : cityLine].compactMap { $0 }
        if name.isEmpty && lines.isEmpty { return NSNull() }
        return [
            "name": name,
            "company": text(raw["company\(prefix)"]) ?? NSNull(),
            "lines": lines,
            "country": text(raw["country\(prefix)"]) ?? NSNull()
        ] as [String: Any]
    }

    private static func items(_ raw: [String: Any], currency: String) -> [[String: Any]] {
        (raw["products"] as? [[String: Any]] ?? [])
            .filter { ($0["type"] as? String) != "shipment" && ($0["type"] as? String) != "payment" }
            .map { product in
                let variants = (product["parameters"] as? [[String: Any]] ?? []).compactMap { parameter -> String? in
                    guard let name = text(parameter["name"]), let value = text(parameter["value"]) else { return nil }
                    return "\(name): \(value)"
                }
                return [
                    "qty": (product["quantity"] as? NSNumber)?.intValue ?? 1,
                    "unit": text(product["unit"]) ?? NSNull(),
                    "title": text(product["title"]) ?? "",
                    "code": text(product["code"]) ?? NSNull(),
                    "url": text(product["url"]) ?? NSNull(),
                    "price": money(product["price_per_unit_with_vat"] ?? product["price_with_vat"],
                                   currency: currency) ?? "",
                    "availability": text(product["availability"]) ?? NSNull(),
                    "variants": variants,
                    "image": text(product["image_url"]) ?? NSNull(),
                    "feedUrl": NSNull(),
                    "feedPrice": NSNull(),
                    "matched": false
                ]
            }
    }

    /**
     Sledování zásilky.

     Stránky dopravců se na telefonu nestahují — na počítači to obstarává
     `ordertrack.ts` a znamená to načítat cizí weby včetně těch, které stav
     dokreslují až JavaScriptem. Údaje z e-shopu (kód, odkaz, datum doručení)
     pokryjí to podstatné a jsou hned.
     */
    private static func tracking(_ raw: [String: Any]) -> [String: Any] {
        let code = text(raw["tracking_code"])
        let delivered = text(raw["delivered_date"])
        var event: Any = NSNull()
        if let delivered {
            event = ["description": "Zásilka doručena", "at": delivered, "phase": "delivered"] as [String: Any]
        } else if code != nil {
            event = [
                "description": "Předáno dopravci",
                "at": text(raw["creation_time"]) ?? "",
                "phase": "transit"
            ] as [String: Any]
        }
        return [
            "source": "api",
            "status": text(raw["status"]) ?? NSNull(),
            "createdAt": text(raw["creation_time"]) ?? NSNull(),
            "paidDate": text(raw["paid_date"]) ?? NSNull(),
            "customerPhone": text(raw["phone"]) ?? NSNull(),
            "carrierId": NSNull(),
            "carrierName": text((raw["shipment"] as? [String: Any])?["name"]) ?? NSNull(),
            "trackingCode": code ?? NSNull(),
            "trackingUrl": text(raw["tracking_url"]) ?? NSNull(),
            "shipment": event,
            "shipmentError": NSNull()
        ]
    }

    private static func card(_ raw: [String: Any], email: String?) -> [String: Any] {
        let currency = text(raw["currency_id"]) ?? "CZK"
        let shipment = raw["shipment"] as? [String: Any]
        let payment = raw["payment"] as? [String: Any]

        let live: [String: Any] = [
            "status": text(raw["status"]) ?? NSNull(),
            "paid": text(raw["paid_date"]) != nil,
            "paidDate": text(raw["paid_date"]) ?? NSNull(),
            "deliveredDate": text(raw["delivered_date"]) ?? NSNull(),
            "trackingCode": text(raw["tracking_code"]) ?? NSNull(),
            "trackingUrl": text(raw["tracking_url"]) ?? NSNull(),
            "adminUrl": text(raw["admin_url"]) ?? NSNull()
        ]

        return [
            "orderNumber": text(raw["order_number"]) ?? NSNull(),
            "lang": (text(raw["language_id"]) ?? "cz").lowercased(),
            "placedAt": text(raw["creation_time"]) ?? NSNull(),
            "customerEmail": text(raw["email"]) ?? email ?? NSNull(),
            "customerPhone": text(raw["phone"]) ?? NSNull(),
            "billing": address(raw, prefix: "_invoice"),
            "shipping": address(raw, prefix: "_postal"),
            "items": items(raw, currency: currency),
            "shipmentName": text(shipment?["name"]) ?? NSNull(),
            "shipmentPrice": money(shipment?["price_with_vat"], currency: currency) ?? NSNull(),
            "paymentName": text(payment?["name"]) ?? NSNull(),
            "paymentPrice": money(payment?["price_with_vat"], currency: currency) ?? NSNull(),
            "total": money(raw["order_total"], currency: currency) ?? NSNull(),
            "historyUrl": NSNull(),
            "adminUrl": text(raw["admin_url"]) ?? NSNull(),
            "adminSource": text(raw["admin_url"]) == nil ? NSNull() : "api",
            "live": live,
            "tracking": tracking(raw)
        ]
    }

    // MARK: - Vyhledání objednávky ke zprávě

    /**
     Ke které objednávce zpráva patří.

     Potvrzení chodí z e-shopu, ne od zákazníka, takže se zkouší adresa
     odesílatele i adresy z pole „komu". Rozhoduje číslo objednávky z textu;
     když ve zprávě není, karta se ukáže jen tehdy, má-li zákazník jedinou
     objednávku — jinak by se hádalo.
     */
    static func find(dbId: Int) async -> (raw: [String: Any], email: String)? {
        guard Upgates.isReady, let message = MailStore.row(dbId) else { return nil }
        let number = orderNumber(in: message)

        var candidates: [String] = []
        if let from = (message["from_addr"] as? String)?.lowercased(), from.contains("@") {
            candidates.append(from)
        }
        for address in Mime.addresses(message["to_addr"] as? String ?? "") where address.address.contains("@") {
            let mail = address.address.lowercased()
            if !candidates.contains(mail) { candidates.append(mail) }
        }
        guard !candidates.isEmpty else { return nil }

        for candidate in candidates {
            guard let orders = try? await Upgates.rawOrders(email: candidate), !orders.isEmpty else { continue }
            if let number {
                if let hit = orders.first(where: { sameNumber($0["order_number"], number) }) {
                    return (hit, candidate)
                }
            } else if orders.count == 1 {
                return (orders[0], candidate)
            }
        }
        return nil
    }

    private static func sameNumber(_ candidate: Any?, _ wanted: String) -> Bool {
        guard let candidate = text(candidate) else { return false }
        let trim: (String) -> String = { value in
            var out = value
            while out.hasPrefix("0"), out.count > 1 { out.removeFirst() }
            return out
        }
        return trim(candidate) == trim(wanted)
    }

    // MARK: - Vstupy pro most

    static func card(dbId: Int) async -> [String: Any]? {
        guard let found = await find(dbId: dbId) else { return nil }
        return card(found.raw, email: found.email)
    }

    /// Zkrácený odznak do seznamu zpráv.
    static func badge(dbId: Int) async -> [String: Any]? {
        guard let found = await find(dbId: dbId) else { return nil }
        let raw = found.raw
        let status = text(raw["status"])
        let paid = text(raw["paid_date"]) != nil
        let delivered = text(raw["delivered_date"]) != nil
        return [
            "orderNumber": text(raw["order_number"]) ?? NSNull(),
            "total": money(raw["order_total"], currency: text(raw["currency_id"]) ?? "CZK") ?? NSNull(),
            "status": status ?? NSNull(),
            "tone": tone(status: status, paid: paid, delivered: delivered),
            "carrierName": text((raw["shipment"] as? [String: Any])?["name"]) ?? NSNull(),
            "shipmentStage": delivered ? "doručeno" : (text(raw["tracking_code"]) != nil ? "na cestě" : NSNull())
        ]
    }

    /// Zjednodušení stavu do barvy odznaku — stejné dělení jako na počítači.
    private static func tone(status: String?, paid: Bool, delivered: Bool) -> String {
        let value = (status ?? "").lowercased()
        if value.contains("storn") || value.contains("vrác") || value.contains("cancel") { return "problem" }
        if delivered || value.contains("dokonč") || value.contains("vyříz") { return "done" }
        if value.contains("odesl") || value.contains("expedo") || value.contains("ship") { return "sent" }
        if paid || value.contains("zaplac") || value.contains("uhraz") { return "paid" }
        return "new"
    }

    static func shipment(dbId: Int) async -> [String: Any]? {
        guard let found = await find(dbId: dbId) else { return nil }
        return tracking(found.raw)
    }
}
