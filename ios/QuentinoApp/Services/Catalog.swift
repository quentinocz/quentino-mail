import Foundation

/**
 Katalog na telefonu: varianty, zásoby a čtečka kódů.

 Proč to na telefonu vůbec je: zboží se přebírá u regálu, ne u počítače.
 Telefon je to, co má člověk v ruce, když otevře krabici — a proto tady musí
 fungovat hledání produktu, jeho varianty a načtení kódu. Zápis do e-shopu
 zůstává na počítači, kde se dá otevřít okno administrace.

 Kód se drží desktopové verze řádek po řádku, včetně dvou pravidel, která
 vypadají jako drobnost a nejsou:

  1. Zásoba varianty se **nesmí** připsat produktu — uvnitř `<VARIANTS>` je
     taky `<STOCK>` a naivní hledání první značky ho vezme celému produktu.
  2. Kód má přednost před EANem a dvojznačný EAN nenajde nic. V katalogu je
     jediný vyplněný EAN a je v něm omylem kód *jiného* produktu.
 */
enum Catalog {
    private static let currencySymbols = ["CZK": "Kč", "EUR": "€", "USD": "$", "GBP": "£", "PLN": "zł"]

    // MARK: - Rozbor variant z feedu

    /// Varianty jednoho produktu z bloku `<PRODUCT>` velkého feedu.
    static func parseVariants(_ block: String, productCode: String) -> [[String: SQLite.Value]] {
        guard let wrap = Products.match(block, "<VARIANTS>([\\s\\S]*?)</VARIANTS>") else { return [] }
        var out: [[String: SQLite.Value]] = []
        var sort = 0

        for piece in wrap.components(separatedBy: "<VARIANT>").dropFirst() {
            let body = piece.components(separatedBy: "</VARIANT>").first ?? piece
            guard let code = Products.tag(body, "CODE"), !code.isEmpty else { continue }
            if (Products.tag(body, "ACTIVE_YN") ?? "1") != "1" { continue }

            // Popisek: „Délka: 120cm" — z parametrů, které variantu odlišují
            var label: [String] = []
            if let params = Products.match(body, "<PARAMETERS>([\\s\\S]*?)</PARAMETERS>") {
                for part in params.components(separatedBy: "<PARAMETER>").dropFirst() {
                    let one = part.components(separatedBy: "</PARAMETER>").first ?? part
                    let name = Products.clean(Products.tagAny(one, "NAME") ?? "")
                    let value = Products.clean(Products.tagAny(one, "VALUE") ?? "")
                    if !value.isEmpty { label.append(name.isEmpty ? value : "\(name): \(value)") }
                }
            }

            let priceBlock = Products.match(body, "<PRICE language=\"cz\">([\\s\\S]*?)</PRICE>") ?? ""
            let value = Products.tag(priceBlock, "PRICE_SALE") ?? Products.tag(priceBlock, "PRICE_WITH_VAT")
            let currency = Products.tag(priceBlock, "CURRENCY") ?? ""
            let price = (value?.isEmpty == false)
                ? "\(value!) \(currencySymbols[currency] ?? currency)".trimmingCharacters(in: .whitespaces)
                : ""

            out.append([
                "code": .text(code),
                "product_code": .text(productCode),
                "variant_id": .text(Products.tag(body, "VARIANT_ID") ?? ""),
                "label": .text(label.joined(separator: " · ")),
                "ean": .text(Products.clean(Products.tag(body, "EAN") ?? "")),
                "availability": .text(Products.clean(Products.tagAny(body, "AVAILABILITY") ?? "")),
                "stock": Products.number(Products.tag(body, "STOCK")).map { SQLite.Value.int(Int64($0.rounded())) } ?? .null,
                "price": .text(price),
                "main": .int(Products.tag(body, "MAIN_YN") == "1" ? 1 : 0),
                "sort": .int(Int64(sort))
            ])
            sort += 1
        }
        return out
    }

    static let variantColumns = ["code", "product_code", "variant_id", "label", "ean",
                                 "availability", "stock", "price", "main", "sort"]

    /// Přepíše varianty jedním vrzem — volá se uvnitř transakce importu feedu.
    static func replaceVariants(_ rows: [[String: SQLite.Value]]) throws {
        try SQLite.shared.run("DELETE FROM product_variants")
        let placeholders = variantColumns.map { _ in "?" }.joined(separator: ",")
        for row in rows {
            try SQLite.shared.run(
                "INSERT OR REPLACE INTO product_variants (\(variantColumns.joined(separator: ","))) "
                + "VALUES (\(placeholders))",
                variantColumns.map { row[$0] ?? .null }
            )
        }
    }

    // MARK: - Rychlý feed jen se zásobami

    /**
     Zásoba se nedá číst z velkého feedu.

     Celý katalog s popisy a obrázky se obnovuje jednou denně — „skladem 4 ks"
     z něj je klidně půl dne staré. Upgates umí vedle toho malý export jen
     s kódy, dostupností, cenami a variantami, který se obnovuje po dvou
     hodinách. Katalog stojí na obou: jak produkt vypadá, ví z velkého, kolik
     ho je, z malého.
     */
    static func refreshStock() async throws -> [String: Any] {
        let url = (Store.setting("stockFeedUrl", "") ?? "").trimmingCharacters(in: .whitespaces)
        guard !url.isEmpty else {
            throw BridgeError.message("Není vyplněná adresa rychlého skladového feedu (Nastavení → AI).")
        }
        let data = try await Http.request(url, timeout: 60)
        let xml = String(data: data, encoding: .utf8) ?? Mime.string(data, charset: "windows-1250")
        return try applyStockXml(xml)
    }

    @discardableResult
    static func applyStockXml(_ xml: String) throws -> [String: Any] {
        let at = Formats.iso()
        var products = 0
        var variants = 0

        try SQLite.shared.transaction {
            for piece in xml.components(separatedBy: "<PRODUCT>").dropFirst() {
                let block = piece.components(separatedBy: "</PRODUCT>").first ?? piece
                guard let code = Products.tag(block, "CODE"), !code.isEmpty else { continue }

                /*
                 Varianty se musí odečíst dřív, než se z bloku vyzobne zásoba
                 produktu: uvnitř VARIANTS je taky STOCK a bez oddělení by se
                 první z nich připsal celému produktu.
                 */
                var head = block
                if let wrap = Products.match(block, "<VARIANTS>([\\s\\S]*?)</VARIANTS>"),
                   let cut = block.range(of: "<VARIANTS>") {
                    head = String(block[block.startIndex..<cut.lowerBound])
                    for part in wrap.components(separatedBy: "<VARIANT>").dropFirst() {
                        let body = part.components(separatedBy: "</VARIANT>").first ?? part
                        guard let vcode = Products.tag(body, "CODE"), !vcode.isEmpty else { continue }
                        let stock = Products.number(Products.tag(body, "STOCK"))
                        variants += try SQLite.shared.run(
                            "UPDATE product_variants SET stock = ?, availability = ? WHERE code = ?",
                            [
                                stock.map { SQLite.Value.int(Int64($0.rounded())) } ?? .null,
                                .text(Products.clean(Products.tagAny(body, "AVAILABILITY") ?? "")),
                                .text(vcode)
                            ]
                        ).changes
                    }
                }

                let stock = Products.number(Products.tag(head, "STOCK"))
                products += try SQLite.shared.run(
                    "UPDATE products SET stock = ?, availability = ?, stock_at = ? WHERE code = ?",
                    [
                        stock.map { SQLite.Value.int(Int64($0.rounded())) } ?? .null,
                        .text(Products.clean(Products.tagAny(head, "AVAILABILITY") ?? "")),
                        .text(at),
                        .text(code)
                    ]
                ).changes
            }
        }

        Store.setSetting("stockFeedSync", at)
        Bridge.notify("products:changed")
        return ["products": products, "variants": variants, "at": at]
    }

    static func stockSyncedAt() -> Any {
        let value = Store.setting("stockFeedSync", "") ?? ""
        return value.isEmpty ? NSNull() : value
    }

    // MARK: - Varianty a detail

    static func variants(of code: String) -> [[String: Any]] {
        let rows = (try? SQLite.shared.query(
            "SELECT * FROM product_variants WHERE product_code = ? ORDER BY sort, code", [.text(code)]
        )) ?? []
        return rows.map { row in
            [
                "code": row["code"] ?? "",
                "productCode": row["product_code"] ?? "",
                "label": row["label"] ?? "",
                "ean": row["ean"] ?? "",
                "availability": row["availability"] ?? "",
                "stock": row["stock"] ?? NSNull(),
                "price": row["price"] ?? "",
                "main": (row["main"] as? Int ?? 0) == 1
            ]
        }
    }

    static func detail(_ code: String) -> Any {
        guard let row = (try? SQLite.shared.query(
            "SELECT * FROM products WHERE code = ? COLLATE NOCASE", [.text(code)]
        ))?.first else { return NSNull() }

        var out = Products.shape(row)
        out["ean"] = row["ean"] ?? ""
        let at = row["stock_at"] as? String ?? ""
        out["stockAt"] = at.isEmpty ? stockSyncedAt() : at
        out["variants"] = variants(of: row["code"] as? String ?? code)
        return out
    }

    // MARK: - Napovídání podle názvu

    /**
     Hledání do naskladnění — podle názvu i kódu, bez ohledu na diakritiku.

     U regálu se stane, že štítek chybí nebo je nečitelný. Psát kód po paměti
     je pak sázka do loterie, kdežto „ksandy modre" člověk napíše bez váhání —
     včetně toho, že nepřepne klávesnici kvůli háčkům. `LIKE` v SQL porovnává
     znak po znaku, takže se katalog projde v paměti; dvanáct set řádků je na
     to nic.

     Vrací se produkt **i s variantami**: naskladňuje se konkrétní délka, ne
     „kšandy", a rozhraní se pak zeptá, která to je.
     */
    static func suggest(_ query: String, limit: Int = 8) -> [[String: Any]] {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.count >= 2 else { return [] }
        let words = fold(text).split(separator: " ").prefix(5).map(String.init)
        guard !words.isEmpty else { return [] }

        let rows = (try? SQLite.shared.query(
            "SELECT code, title_cz, title_en, image, stock, price_cz FROM products"
        )) ?? []

        var out: [[String: Any]] = []
        for row in rows {
            let code = row["code"] as? String ?? ""
            let titleCz = row["title_cz"] as? String ?? ""
            let titleEn = row["title_en"] as? String ?? ""
            let hay = fold("\(code) \(titleCz) \(titleEn)")
            guard words.allSatisfy({ hay.contains($0) }) else { continue }
            out.append([
                "code": code,
                "title": titleCz.isEmpty ? (titleEn.isEmpty ? code : titleEn) : titleCz,
                "image": row["image"] ?? NSNull(),
                "stock": row["stock"] ?? NSNull(),
                "price": row["price_cz"] ?? "",
                "variants": variants(of: code)
            ])
            if out.count >= limit { break }
        }
        return out
    }

    /// Malá písmena bez diakritiky — jediná podoba, ve které se dá porovnávat.
    private static func fold(_ text: String) -> String {
        text.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: Locale(identifier: "cs_CZ"))
    }

    // MARK: - Čtečka

    /**
     Najde produkt nebo variantu podle toho, co přišlo ze čtečky.

     Vrací **přesnou shodu, nebo nic**: u naskladnění je „asi to bude tenhle"
     horší než „nenašel jsem to", protože se přičte zásoba cizímu zboží.
     */
    static func find(_ raw: String) -> Any {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return NSNull() }

        // Z QR kódu vlastní výroby: „quentino:PS120SM" nebo adresa produktu
        var code = text
        if let range = code.range(of: "^quentino:", options: [.regularExpression, .caseInsensitive]) {
            code = String(code[range.upperBound...])
        }
        if let range = code.range(of: "^.*/p/", options: .regularExpression) {
            code = String(code[range.upperBound...])
        }
        code = code.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !code.isEmpty else { return NSNull() }

        // 1) kód varianty — na štítku je právě tenhle
        if let variant = (try? SQLite.shared.query(
            "SELECT * FROM product_variants WHERE code = ? COLLATE NOCASE LIMIT 1", [.text(code)]
        ))?.first {
            return hit(variant: variant)
        }
        // 2) kód produktu
        if let product = (try? SQLite.shared.query(
            "SELECT * FROM products WHERE code = ? COLLATE NOCASE LIMIT 1", [.text(code)]
        ))?.first {
            return hit(product: product)
        }
        // 3) teprve pak EAN, a jen když je jednoznačný
        let byVariant = (try? SQLite.shared.query(
            "SELECT * FROM product_variants WHERE ean != '' AND ean = ? LIMIT 2", [.text(code)]
        )) ?? []
        let byProduct = (try? SQLite.shared.query(
            "SELECT * FROM products WHERE ean != '' AND ean = ? LIMIT 2", [.text(code)]
        )) ?? []
        if byVariant.count + byProduct.count != 1 { return NSNull() }
        if let variant = byVariant.first { return hit(variant: variant) }
        return hit(product: byProduct[0])
    }

    private static func hit(variant: [String: Any]) -> [String: Any] {
        let parentCode = variant["product_code"] as? String ?? ""
        let parent = (try? SQLite.shared.query(
            "SELECT * FROM products WHERE code = ?", [.text(parentCode)]
        ))?.first
        return [
            "code": variant["code"] ?? "",
            "productCode": parentCode,
            "title": (parent?["title_cz"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? parentCode,
            "label": variant["label"] ?? "",
            "image": parent?["image"] ?? NSNull(),
            "stock": variant["stock"] ?? NSNull(),
            "availability": variant["availability"] ?? "",
            "isVariant": true
        ]
    }

    private static func hit(product: [String: Any]) -> [String: Any] {
        let code = product["code"] as? String ?? ""
        let title = (product["title_cz"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            ?? (product["title_en"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            ?? code
        return [
            "code": code,
            "productCode": code,
            "title": title,
            "label": "",
            "image": product["image"] ?? NSNull(),
            "stock": product["stock"] ?? NSNull(),
            "availability": product["availability"] ?? "",
            "isVariant": false
        ]
    }
}
