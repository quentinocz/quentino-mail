import Foundation

/**
 Katalog produktů z exportu Upgates.

 Feed je obyčejné XML, které se jednou za čas stáhne a rozloží do tabulky
 `products`. Adresa feedu se v kódu nedrží — je to „tajný odkaz", kterým jde
 stáhnout celý katalog s cenami a sklady, takže se vyplňuje v Nastavení
 a leží jen v databázi zařízení.
 */
enum Products {
    private static let languages = ["cz", "sk", "en"]
    private static let currencySymbols = ["CZK": "Kč", "EUR": "€", "USD": "$", "GBP": "£", "PLN": "zł"]

    // MARK: - Čtení XML

    static func tag(_ block: String, _ name: String) -> String? {
        match(block, "<\(name)>([\\s\\S]*?)</\(name)>")
    }

    /// Některé texty Upgates exportuje s jazykovým atributem, jiné bez něj.
    static func tagAny(_ block: String, _ name: String, preferred: String = "cz") -> String? {
        match(block, "<\(name) language=\"\(preferred)\"[^>]*>([\\s\\S]*?)</\(name)>")
            ?? match(block, "<\(name)(?:\\s[^>]*)?>([\\s\\S]*?)</\(name)>")
    }

    static func match(_ text: String, _ pattern: String) -> String? {
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let found = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              let range = Range(found.range(at: 1), in: text) else { return nil }
        return String(text[range]).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func matches(_ text: String, _ pattern: String) -> [[String]] {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
        return regex.matches(in: text, range: NSRange(text.startIndex..., in: text)).map { found in
            (0..<found.numberOfRanges).map { index in
                Range(found.range(at: index), in: text).map { String(text[$0]) } ?? ""
            }
        }
    }

    static func clean(_ text: String) -> String {
        text
            .replacingOccurrences(of: "<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>", with: "$1", options: [.regularExpression])
            .replacingOccurrences(of: "&amp;", with: "&")
            .replacingOccurrences(of: "&lt;", with: "<")
            .replacingOccurrences(of: "&gt;", with: ">")
            .replacingOccurrences(of: "&quot;", with: "\"")
            .replacingOccurrences(of: "&#39;", with: "'")
            .replacingOccurrences(of: "&apos;", with: "'")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Z „1 299,00" nebo „649.00" udělá číslo pro řazení podle ceny.
    static func number(_ raw: String?) -> Double? {
        guard let raw else { return nil }
        let normalized = raw
            .replacingOccurrences(of: "&nbsp;", with: "")
            .replacingOccurrences(of: " ", with: "")
            .replacingOccurrences(of: "\u{00a0}", with: "")
            .replacingOccurrences(of: ",", with: ".")
            .filter { $0.isNumber || $0 == "." || $0 == "-" }
        return Double(normalized)
    }

    private static func categories(_ block: String) -> (primary: String, all: [String]) {
        guard let wrap = match(block, "<CATEGORIES>([\\s\\S]*?)</CATEGORIES>") else { return ("", []) }
        var all: [String] = []
        var primary = ""
        for piece in wrap.components(separatedBy: "<CATEGORY>").dropFirst() {
            let body = piece.components(separatedBy: "</CATEGORY>").first ?? piece
            guard let raw = tagAny(body, "NAME") else { continue }
            let name = clean(raw)
            guard !name.isEmpty else { continue }
            if !all.contains(name) { all.append(name) }
            if primary.isEmpty, tag(body, "PRIMARY_YN") == "1" { primary = name }
        }
        return (primary.isEmpty ? (all.first ?? "") : primary, all)
    }

    @discardableResult
    static func importFeed(_ xml: String) throws -> Int {
        var rows: [[String: SQLite.Value]] = []
        var variants: [[String: SQLite.Value]] = []

        for piece in xml.components(separatedBy: "<PRODUCT>").dropFirst() {
            let block = piece.components(separatedBy: "</PRODUCT>").first ?? piece
            if (tag(block, "ACTIVE_YN") ?? "1") != "1" { continue }
            if (tag(block, "ARCHIVED_YN") ?? "0") == "1" { continue }
            guard let code = tag(block, "CODE"), !code.isEmpty else { continue }

            var row: [String: SQLite.Value] = [
                "code": .text(code),
                // Čárový kód a vnitřní číslo produktu: bez PRODUCT_ID se do
                // naskladňování v Upgates zapsat nedá, formulář kód nepoužívá
                "ean": .text(clean(tag(block, "EAN") ?? "")),
                "product_id": .text(tag(block, "PRODUCT_ID") ?? "")
            ]
            for language in languages {
                row["title_\(language)"] = .text("")
                row["url_\(language)"] = .text("")
                row["price_\(language)"] = .text("")
            }

            for found in matches(block, "<DESCRIPTION language=\"(cz|sk|en)\">([\\s\\S]*?)</DESCRIPTION>") {
                let language = found[1]
                row["title_\(language)"] = .text(clean(tag(found[2], "TITLE") ?? ""))
                row["url_\(language)"] = .text(tag(found[2], "URL") ?? "")
            }

            // Hlavní obrázek (MAIN_YN=1, jinak první)
            var image: String?
            if let images = match(block, "<IMAGES>([\\s\\S]*?)</IMAGES>") {
                var first: String?
                var main: String?
                for piece in images.components(separatedBy: "<IMAGE>").dropFirst() {
                    guard let url = tag(piece, "URL") else { continue }
                    if first == nil { first = url }
                    if main == nil, tag(piece, "MAIN_YN") == "1" { main = url }
                }
                image = main ?? first
            }
            row["image"] = image.map { SQLite.Value.text($0) } ?? .null

            var priceNumber: Double?
            for found in matches(block, "<PRICE language=\"(cz|sk|en)\">([\\s\\S]*?)</PRICE>") {
                let language = found[1]
                let value = tag(found[2], "PRICE_SALE") ?? tag(found[2], "PRICE_WITH_VAT")
                let currency = tag(found[2], "CURRENCY") ?? ""
                guard let value, !value.isEmpty else { continue }
                let symbol = currencySymbols[currency] ?? currency
                row["price_\(language)"] = .text("\(value) \(symbol)".trimmingCharacters(in: .whitespaces))
                if language == "cz" { priceNumber = number(value) }
            }

            let category = categories(block)
            row["category"] = .text(category.primary)
            row["categories"] = .text(category.all.joined(separator: "\n"))
            row["manufacturer"] = .text(clean(tagAny(block, "MANUFACTURER") ?? ""))
            row["availability"] = .text(clean(tagAny(block, "AVAILABILITY") ?? ""))
            row["stock"] = number(tag(block, "STOCK")).map { SQLite.Value.int(Int64($0.rounded())) } ?? .null
            row["price_num"] = priceNumber.map { SQLite.Value.double($0) } ?? .null

            let hasTitle = languages.contains { language in
                if case .text(let value) = row["title_\(language)"] ?? .null { return !value.isEmpty }
                return false
            }
            if hasTitle {
                rows.append(row)
                variants.append(contentsOf: Catalog.parseVariants(block, productCode: code))
            }
        }

        guard !rows.isEmpty else {
            throw BridgeError.message("Feed neobsahuje žádné aktivní produkty — zkontroluj adresu.")
        }

        let columns = ["code", "title_cz", "url_cz", "price_cz", "title_sk", "url_sk", "price_sk",
                       "title_en", "url_en", "price_en", "image", "category", "categories",
                       "manufacturer", "availability", "stock", "price_num", "ean", "product_id"]
        let placeholders = columns.map { _ in "?" }.joined(separator: ",")

        try SQLite.shared.transaction {
            try SQLite.shared.run("DELETE FROM products")
            for row in rows {
                try SQLite.shared.run(
                    "INSERT OR REPLACE INTO products (\(columns.joined(separator: ","))) VALUES (\(placeholders))",
                    columns.map { row[$0] ?? .null }
                )
            }
            try Catalog.replaceVariants(variants)
        }
        Store.setSetting("productFeedSync", Formats.iso())
        // Zvedá se pokaždé, když import začne plnit něco, co dřív neexistovalo
        // — jinak by se u už staženého katalogu nové tabulky nikdy nenaplnily.
        // Naposledy kvůli variantám, EANům a vnitřním číslům produktů.
        Store.setSetting("productFeedSchema", "3")
        return rows.count
    }

    // MARK: - Stažení

    static func refresh() async throws -> [String: Any] {
        let url = (Store.setting("productFeedUrl", "") ?? "").trimmingCharacters(in: .whitespaces)
        guard !url.isEmpty else {
            throw BridgeError.message("Není vyplněná adresa produktového feedu (Nastavení → Produkty).")
        }
        let data = try await Http.request(url, timeout: 120)
        let xml = String(data: data, encoding: .utf8) ?? Mime.string(data, charset: "windows-1250")
        _ = try importFeed(xml)
        // Domény e-shopu se odvozují z feedu — po přesypání musí zestárnout,
        // jinak by se karta objednávky u nových adres neukázala
        Orders.resetShopDomains()
        return status()
    }

    static func status() -> [String: Any] {
        let count = ((try? SQLite.shared.query("SELECT COUNT(*) AS cnt FROM products"))?.first?["cnt"] as? Int) ?? 0
        let variants = ((try? SQLite.shared.query(
            "SELECT COUNT(*) AS cnt FROM product_variants"
        ))?.first?["cnt"] as? Int) ?? 0
        return [
            "url": Store.setting("productFeedUrl", "") ?? "",
            "count": count,
            "lastSync": Store.setting("productFeedSync").flatMap { $0.isEmpty ? nil : $0 } ?? NSNull(),
            "variants": variants
        ]
    }

    /// Feed starší než 20 hodin (nebo prázdný) → aktualizovat.
    static func isStale() -> Bool {
        let current = status()
        if (current["count"] as? Int ?? 0) == 0 { return true }
        if Store.setting("productFeedSchema") != "3" { return true }
        guard let last = Formats.date(current["lastSync"] as? String) else { return true }
        return Date().timeIntervalSince(last) > 20 * 3600
    }

    // MARK: - Hledání

    static func shape(_ row: [String: Any]) -> [String: Any] {
        func byLanguage(_ prefix: String) -> [String: Any] {
            Dictionary(uniqueKeysWithValues: languages.map { ($0, row["\(prefix)_\($0)"] as? String ?? "") })
        }
        let list = (row["categories"] as? String ?? "")
            .components(separatedBy: "\n").filter { !$0.isEmpty }
        return [
            "code": row["code"] ?? "",
            "image": row["image"] ?? NSNull(),
            "title": byLanguage("title"),
            "url": byLanguage("url"),
            "price": byLanguage("price"),
            "category": row["category"] ?? "",
            "categories": list,
            "manufacturer": row["manufacturer"] ?? "",
            "availability": row["availability"] ?? "",
            "stock": row["stock"] ?? NSNull()
        ]
    }

    static func list(_ query: [String: Any]) -> [String: Any] {
        let limit = min(max(query["limit"] as? Int ?? 40, 1), 200)
        let offset = max(query["offset"] as? Int ?? 0, 0)
        let language = query["lang"] as? String ?? "cz"
        let safeLanguage = languages.contains(language) ? language : "cz"

        var conditions: [String] = []
        var params: [SQLite.Value] = []

        let text = (query["query"] as? String ?? "").trimmingCharacters(in: .whitespaces)
        if !text.isEmpty {
            // Každé slovo musí sedět — hledání „modrá kravata" tak funguje podle očekávání
            for word in text.split(separator: " ").prefix(6) {
                conditions.append(
                    "(title_cz LIKE ? OR title_sk LIKE ? OR title_en LIKE ? OR code LIKE ? OR category LIKE ? "
                    + "OR categories LIKE ? OR url_cz LIKE ? OR url_sk LIKE ? OR url_en LIKE ?)"
                )
                params.append(contentsOf: Array(repeating: SQLite.Value.text("%\(word)%"), count: 9))
            }
        }
        if let category = query["category"] as? String, !category.isEmpty {
            conditions.append("(category = ? OR categories LIKE ?)")
            params.append(.text(category))
            params.append(.text("%\(category)%"))
        }
        if query["inStockOnly"] as? Bool == true { conditions.append("(stock IS NULL OR stock > 0)") }

        let whereClause = conditions.isEmpty ? "" : "WHERE \(conditions.joined(separator: " AND "))"
        let order: String
        switch query["sort"] as? String {
        case "price": order = "ORDER BY price_num IS NULL, price_num ASC, title_cz COLLATE NOCASE"
        case "stock": order = "ORDER BY stock IS NULL, stock DESC, title_cz COLLATE NOCASE"
        default:
            order = "ORDER BY (CASE WHEN title_\(safeLanguage) = '' THEN 1 ELSE 0 END), "
                + "title_\(safeLanguage) COLLATE NOCASE"
        }

        let total = ((try? SQLite.shared.query(
            "SELECT COUNT(*) AS cnt FROM products \(whereClause)", params
        ))?.first?["cnt"] as? Int) ?? 0

        let rows = (try? SQLite.shared.query(
            "SELECT * FROM products \(whereClause) \(order) LIMIT ? OFFSET ?",
            params + [.int(Int64(limit)), .int(Int64(offset))]
        )) ?? []

        return ["items": rows.map(shape), "total": total, "offset": offset, "limit": limit]
    }

    static func search(_ query: String, limit: Int = 20) -> [[String: Any]] {
        guard !query.trimmingCharacters(in: .whitespaces).isEmpty else { return [] }
        return list(["query": query, "limit": limit])["items"] as? [[String: Any]] ?? []
    }

    /// Kategorie s počty — filtr v prohlížeči produktů.
    static func facets() -> [String: Any] {
        let rows = (try? SQLite.shared.query("SELECT categories, category FROM products")) ?? []
        var counts: [String: Int] = [:]
        for row in rows {
            let list = (row["categories"] as? String ?? "")
                .components(separatedBy: "\n").filter { !$0.isEmpty }
            let names = list.isEmpty ? [row["category"] as? String ?? ""].filter { !$0.isEmpty } : list
            for name in Set(names) { counts[name, default: 0] += 1 }
        }
        let categories = counts.map { ["name": $0.key, "count": $0.value] as [String: Any] }
            .sorted { left, right in
                let leftCount = left["count"] as? Int ?? 0
                let rightCount = right["count"] as? Int ?? 0
                if leftCount != rightCount { return leftCount > rightCount }
                return (left["name"] as? String ?? "")
                    .localizedCaseInsensitiveCompare(right["name"] as? String ?? "") == .orderedAscending
            }
        return ["categories": categories, "total": rows.count]
    }
}
