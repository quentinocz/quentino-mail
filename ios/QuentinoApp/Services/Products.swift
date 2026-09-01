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
        // Katalog i varianty jsou nové — hledání se dopočítá při prvním dotazu
        try? SQLite.shared.run("UPDATE products SET search = ''")
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

    // MARK: - Hledání

    /**
     Podoba textu, ve které se dá porovnávat: malá písmena bez diakritiky.

     `LIKE` v SQL jde znak po znaku, takže „ksandy" jinak nenajde „Kšandy" —
     a u regálu nikdo nepřepíná klávesnici kvůli jednomu slovu.
     */
    static func fold(_ text: String) -> String {
        text.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: Locale(identifier: "cs_CZ"))
    }

    /**
     Totéž bez oddělovačů — „PS120SM-120" a „ps120sm 120" je jeden a týž kód.

     Kód varianty se opisuje ze štítku, z faktury nebo po paměti a pomlčka se
     v něm netrefí pokaždé na stejné místo.
     */
    static func squash(_ text: String) -> String {
        String(fold(text).unicodeScalars.filter {
            CharacterSet.alphanumerics.contains($0) && $0.isASCII
        })
    }

    /// Slova dotazu; kratší než dva znaky sedí skoro všude a jen matou.
    static func queryWords(_ text: String) -> [String] {
        fold(text).split(whereSeparator: { $0 == " " || $0 == "\n" || $0 == "\t" })
            .map(String.init).filter { $0.count >= 2 }.prefix(6).map { $0 }
    }

    /**
     Doplní sloupec pro hledání tam, kde chybí.

     Je v něm název, kód, kategorie i **kódy variant** — na štítku a ve faktuře
     je kód délky („PS120SM-120"), kdežto v katalogu se produkt vede pod
     seskupujícím kódem („PS120SM"), takže bez variant by se kód ze štítku
     nenašel. Ukládá se dvojmo, s oddělovači i bez nich.

     Volá se před každým hledáním, ale skoro vždycky nic nedělá: naplní se až
     po stažení katalogu nebo po povýšení aplikace.
     */
    static func ensureSearchIndex() {
        let missing = ((try? SQLite.shared.query(
            "SELECT COUNT(*) AS cnt FROM products WHERE search = ''"
        ))?.first?["cnt"] as? Int) ?? 0
        guard missing > 0 else { return }

        var byProduct: [String: [String]] = [:]
        for row in (try? SQLite.shared.query("SELECT code, product_code FROM product_variants")) ?? [] {
            let parent = row["product_code"] as? String ?? ""
            byProduct[parent, default: []].append(row["code"] as? String ?? "")
        }

        let rows = (try? SQLite.shared.query(
            "SELECT code, ean, title_cz, title_sk, title_en, category, categories, manufacturer FROM products"
        )) ?? []
        try? SQLite.shared.transaction {
            for row in rows {
                let code = row["code"] as? String ?? ""
                let parts = ([
                    code,
                    row["ean"] as? String ?? "",
                    row["title_cz"] as? String ?? "",
                    row["title_sk"] as? String ?? "",
                    row["title_en"] as? String ?? "",
                    row["category"] as? String ?? "",
                    row["categories"] as? String ?? "",
                    row["manufacturer"] as? String ?? ""
                ] + (byProduct[code] ?? [])).filter { !$0.isEmpty }.joined(separator: " ")
                try SQLite.shared.run(
                    "UPDATE products SET search = ? WHERE code = ?",
                    [.text("\(fold(parts)) \(squash(parts))"), .text(code)]
                )
            }
        }
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
            ensureSearchIndex()
            /*
             Hledá se v připravené podobě produktu — bez diakritiky, malými
             písmeny a zvlášť i bez oddělovačů, takže „ksandy", „Kšandy"
             i „ps120sm120" najdou totéž. Jsou v ní i kódy variant, protože
             kód ze štítku je kód délky, kdežto v katalogu se produkt vede
             pod seskupujícím kódem.

             Každé slovo musí sedět (AND), aby „modrá kravata" fungovalo
             podle očekávání.
             */
            for word in queryWords(text) {
                conditions.append("(search LIKE ? OR search LIKE ?)")
                params.append(.text("%\(word)%"))
                params.append(.text("%\(squash(word))%"))
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

        return [
            "items": withVariants(rows.map(shape)),
            "total": total, "offset": offset, "limit": limit
        ]
    }

    /**
     Doplní ke kartám varianty i se zásobou.

     Jedním dotazem na celou stránku, ne po produktu: šedesát karet by jinak
     znamenalo šedesát dotazů a listování katalogem by se zadrhávalo.

     Souhrn na produktu sečítá všechny délky dohromady, takže „14 ks" neřekne
     nic o tom, která z nich zrovna došla.
     */
    static func withVariants(_ items: [[String: Any]]) -> [[String: Any]] {
        guard !items.isEmpty else { return items }
        let codes = items.map { $0["code"] as? String ?? "" }
        let holes = codes.map { _ in "?" }.joined(separator: ",")
        let rows = (try? SQLite.shared.query(
            "SELECT code, product_code, label, stock FROM product_variants "
            + "WHERE product_code IN (\(holes)) ORDER BY sort, code",
            codes.map { SQLite.Value.text($0) }
        )) ?? []
        guard !rows.isEmpty else { return items }

        var byProduct: [String: [[String: Any]]] = [:]
        for row in rows {
            let parent = row["product_code"] as? String ?? ""
            let one: [String: Any] = [
                "code": row["code"] ?? "",
                "label": row["label"] ?? "",
                "stock": row["stock"] ?? NSNull()
            ]
            byProduct[parent, default: []].append(one)
        }
        return items.map { item in
            guard let variants = byProduct[item["code"] as? String ?? ""] else { return item }
            var out = item
            out["variants"] = variants
            return out
        }
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
