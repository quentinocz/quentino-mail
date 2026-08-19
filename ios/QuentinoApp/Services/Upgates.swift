import Foundation

/**
 Upgates API — živá data e-shopu.

 Používá se jen čtení objednávek podle e-mailu zákazníka. Přihlašuje se
 uživatelem API a klíčem (basic auth); klíč leží v klíčence, ne v databázi.
 Odpovědi se drží deset minut v paměti, aby se nešahalo na limit dotazů
 pokaždé, když se otevře stejná zpráva.
 */
enum Upgates {
    private static var cache: [String: (at: Date, orders: [[String: Any]])] = [:]
    private static let cacheQueue = DispatchQueue(label: "cz.quentino.upgates")

    static func config() -> [String: Any] {
        [
            "url": Store.setting("upgatesUrl", "") ?? "",
            "login": Store.setting("upgatesLogin", "") ?? "",
            "hasKey": Secrets.has("upgatesKey")
        ]
    }

    static func saveConfig(_ patch: [String: Any]) -> [String: Any] {
        if let url = patch["url"] as? String {
            Store.setSetting("upgatesUrl", url.trimmedSlash)
        }
        if let login = patch["login"] as? String {
            Store.setSetting("upgatesLogin", login.trimmingCharacters(in: .whitespaces))
        }
        if let key = patch["apiKey"] as? String, !key.isEmpty { Secrets.set("upgatesKey", key) }
        cacheQueue.sync { cache.removeAll() }
        Store.touchState()
        return config()
    }

    static var isReady: Bool {
        let current = config()
        return !(current["url"] as? String ?? "").isEmpty
            && !(current["login"] as? String ?? "").isEmpty
            && (current["hasKey"] as? Bool ?? false)
    }

    private static func call(_ pathAndQuery: String) async throws -> [String: Any] {
        let current = config()
        let url = current["url"] as? String ?? ""
        let login = current["login"] as? String ?? ""
        let key = Secrets.get("upgatesKey") ?? ""
        guard !url.isEmpty, !login.isEmpty, !key.isEmpty else {
            throw BridgeError.message("Upgates API není nastaveno (Nastavení → AI → Upgates).")
        }
        let auth = Data("\(login):\(key)".utf8).base64EncodedString()
        do {
            return try await Http.dictionary(
                "\(url)\(pathAndQuery)",
                headers: ["Authorization": "Basic \(auth)", "Content-Type": "application/json"],
                timeout: 20
            )
        } catch let failure as Http.Failure {
            if failure.status == 401 || failure.status == 403 {
                throw BridgeError.message("Upgates API odmítlo přihlášení — zkontroluj login a klíč.")
            }
            throw BridgeError.message("Upgates API: HTTP \(failure.status)")
        }
    }

    static func test() async throws -> String {
        let data = try await call("/api/v2/status")
        let allowed = (data["services"] as? [[String: Any]] ?? [])
            .filter { ($0["privilege"] as? String) != "deny" }.count
        return "Připojení funguje (\(allowed) povolených endpointů)."
    }

    private static func order(_ raw: [String: Any]) -> [String: Any] {
        let products = (raw["products"] as? [[String: Any]] ?? [])
            .filter { ($0["type"] as? String) != "shipment" && ($0["type"] as? String) != "payment" }
            .prefix(8)
            .map { "\($0["quantity"] ?? 1)× \($0["title"] as? String ?? "")" }
        return [
            "orderNumber": raw["order_number"] as? String ?? "",
            "status": raw["status"] as? String ?? "",
            "creationTime": raw["creation_time"] as? String ?? "",
            "paidDate": raw["paid_date"] ?? NSNull(),
            "deliveredDate": raw["delivered_date"] ?? NSNull(),
            "trackingCode": raw["tracking_code"] ?? NSNull(),
            "trackingUrl": raw["tracking_url"] ?? NSNull(),
            "total": raw["order_total"] ?? 0,
            "currency": raw["currency_id"] as? String ?? "",
            "shipmentName": (raw["shipment"] as? [String: Any])?["name"] as? String ?? "",
            "paymentName": (raw["payment"] as? [String: Any])?["name"] as? String ?? "",
            "products": Array(products),
            "adminUrl": raw["admin_url"] ?? NSNull()
        ]
    }

    /**
     Objednávky zákazníka tak, jak je vrátí API.

     Karta objednávky z nich potřebuje víc než zjednodušený přehled (položky
     s variantami, adresy, ceny dopravy), proto se drží obojí a mapuje se až
     na výstupu.
     */
    static func rawOrders(email rawEmail: String) async throws -> [[String: Any]] {
        let email = rawEmail.trimmingCharacters(in: .whitespaces).lowercased()
        guard email.contains("@") else { return [] }
        if let hit = cacheQueue.sync(execute: { cache[email] }), Date().timeIntervalSince(hit.at) < 600 {
            return hit.orders
        }
        let data = try await call(
            "/api/v2/orders?email=\(Http.escaped(email))&order_by=creation_time&order_dir=desc"
        )
        let out = Array((data["orders"] as? [[String: Any]] ?? []).prefix(10))
        cacheQueue.sync { cache[email] = (Date(), out) }
        return out
    }

    static func orders(email rawEmail: String) async throws -> [[String: Any]] {
        try await rawOrders(email: rawEmail).map(order)
    }

    /// Textový blok pro AI — poslední objednávky zákazníka jako zdroj faktů.
    static func contextForAi(email: String) async -> String {
        guard isReady, let list = try? await orders(email: email), !list.isEmpty else { return "" }
        return list.prefix(3).map { order -> String in
            var bits = ["Objednávka č. \(order["orderNumber"] as? String ?? "")"]
            bits.append("stav: \((order["status"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "neuveden")")
            bits.append((order["paidDate"] as? String).map { "zaplaceno \($0)" } ?? "nezaplaceno")
            if let delivered = order["deliveredDate"] as? String { bits.append("doručeno \(delivered)") }
            bits.append("doprava: \((order["shipmentName"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "—")")
            if let tracking = order["trackingCode"] as? String {
                bits.append("tracking: \(tracking)")
            } else {
                bits.append("tracking zatím není")
            }
            bits.append("celkem \(order["total"] ?? 0) \(order["currency"] as? String ?? "")")
            let products = (order["products"] as? [String] ?? []).joined(separator: ", ")
            bits.append("položky: \(products.isEmpty ? "—" : products)")
            return "- \(bits.joined(separator: " | "))"
        }.joined(separator: "\n")
    }
}
