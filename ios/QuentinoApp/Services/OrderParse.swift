import Foundation

/**
 Rozbor potvrzovacího e-mailu z Upgates — CZ / SK / EN.

 Doslovný převod stolního modulu `src/main/orderparse.ts`. Čte se jen tělo
 zprávy, takže modul nepotřebuje databázi ani síť a nesahá na `Orders`
 ani `Upgates` — dá se volat i tam, kde API e-shopu nastavené není nebo kde
 objednávka v něm ještě není vidět.

 Výsledek je slovník se stejnými klíči, jaké má typ `OrderCard` na počítači,
 aby ho mohl bez překladu převzít most do JavaScriptu. Co je v TypeScriptu
 `null`, je tady `NSNull()` — `nil` by se ze slovníku ztratil a druhá strana
 by nepoznala rozdíl mezi „nevyplněno" a „klíč chybí".
 */
enum OrderParse {

    // MARK: - Práce s regulárními výrazy

    /**
     Vzory se překládají přes `NSRegularExpression`.

     `String.range(of:options:.regularExpression)` sice existuje, ale u vzorů
     se zpětnými referencemi a skupinami je na iOS nespolehlivý a hlavně
     nevrací obsah skupin — a bez skupin je z parseru půlka k ničemu.
     */
    private static func regex(_ pattern: String,
                              _ options: NSRegularExpression.Options) -> NSRegularExpression? {
        return try? NSRegularExpression(pattern: pattern, options: options)
    }

    /// Obsah všech skupin jednoho zásahu; nezachycená skupina je prázdný řetězec,
    /// aby se v kódu níž nemuselo pořád rozlišovat `nil` od `""`.
    private static func groups(_ match: NSTextCheckingResult, in source: NSString) -> [String] {
        var out: [String] = []
        for index in 0..<match.numberOfRanges {
            let range = match.range(at: index)
            if range.location == NSNotFound {
                out.append("")
            } else {
                out.append(source.substring(with: range))
            }
        }
        return out
    }

    private static func firstGroups(_ value: String,
                                    _ pattern: String,
                                    _ options: NSRegularExpression.Options = [.caseInsensitive]) -> [String]? {
        guard let expression = regex(pattern, options) else { return nil }
        let source = value as NSString
        let range = NSRange(location: 0, length: source.length)
        guard let match = expression.firstMatch(in: value, range: range) else { return nil }
        return groups(match, in: source)
    }

    private static func allGroups(_ value: String,
                                  _ pattern: String,
                                  _ options: NSRegularExpression.Options = [.caseInsensitive]) -> [[String]] {
        guard let expression = regex(pattern, options) else { return [] }
        let source = value as NSString
        let range = NSRange(location: 0, length: source.length)
        return expression.matches(in: value, range: range).map { match -> [String] in
            return groups(match, in: source)
        }
    }

    private static func test(_ value: String,
                             _ pattern: String,
                             _ options: NSRegularExpression.Options = [.caseInsensitive]) -> Bool {
        return firstGroups(value, pattern, options) != nil
    }

    private static func replacing(_ value: String,
                                  _ pattern: String,
                                  with template: String,
                                  options: NSRegularExpression.Options = [.caseInsensitive]) -> String {
        guard let expression = regex(pattern, options) else { return value }
        let source = value as NSString
        let range = NSRange(location: 0, length: source.length)
        return expression.stringByReplacingMatches(in: value, range: range, withTemplate: template)
    }

    /**
     Náhrada, kde novou podobu počítá kód (entity, číselné kódy znaků).

     Šablony `stringByReplacingMatches` umí jen poskládat skupiny, ne převést
     hex na znak. Zásahy se proto nahrazují od konce — jinak by první náhrada
     posunula rozsahy všech dalších.
     */
    private static func rewriting(_ value: String,
                                  _ pattern: String,
                                  _ options: NSRegularExpression.Options = [.caseInsensitive],
                                  transform: ([String]) -> String) -> String {
        guard let expression = regex(pattern, options) else { return value }
        let source = value as NSString
        let range = NSRange(location: 0, length: source.length)
        let found = expression.matches(in: value, range: range)
        guard !found.isEmpty else { return value }
        let out = NSMutableString(string: value)
        for match in found.reversed() {
            out.replaceCharacters(in: match.range, with: transform(groups(match, in: source)))
        }
        return out as String
    }

    /// Prázdný řetězec znamená „nevyplněno" — stejně jako `x || null` v JS.
    private static func text(_ value: String?) -> String? {
        guard let value else { return nil }
        return value.isEmpty ? nil : value
    }

    private static func trim(_ value: String) -> String {
        return value.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: - Pomocné funkce nad HTML

    private static let entities: [String: String] = [
        "amp": "&", "lt": "<", "gt": ">", "quot": "\"", "apos": "'", "nbsp": " ",
        "eacute": "é", "aacute": "á", "iacute": "í", "oacute": "ó", "uacute": "ú", "yacute": "ý",
        "hellip": "…", "ndash": "–", "mdash": "—", "bdquo": "„", "ldquo": "“", "rdquo": "”", "euro": "€"
    ]

    private static func decodeEntities(_ value: String) -> String {
        var out = rewriting(value, "&#x([0-9a-f]+);") { parts -> String in
            guard let code = UInt32(parts[1], radix: 16) else { return parts[0] }
            guard let scalar = Unicode.Scalar(code) else { return parts[0] }
            return String(Character(scalar))
        }
        out = rewriting(out, "&#([0-9]+);") { parts -> String in
            guard let code = UInt32(parts[1]) else { return parts[0] }
            guard let scalar = Unicode.Scalar(code) else { return parts[0] }
            return String(Character(scalar))
        }
        // Neznámou entitu je lepší nechat být než ji spolknout — v textu objednávky
        // by po ní zůstala díra uprostřed slova.
        return rewriting(out, "&([a-z]+);") { parts -> String in
            return entities[parts[1].lowercased()] ?? parts[0]
        }
    }

    /// HTML → text; `<br>` a `</p>` se mění na zalomení, aby šly rozeznat řádky adres.
    private static func toText(_ html: String) -> String {
        var out = replacing(html, "<\\s*br\\s*/?>", with: "\n")
        out = replacing(out, "</\\s*(p|div|tr|h\\d|li)\\s*>", with: "\n")
        out = replacing(out, "<[^>]+>", with: "")
        out = decodeEntities(out)
        // Nedělitelná mezera se v šablonách používá i uvnitř adres; kdyby zůstala,
        // rozpadlo by se každé pozdější porovnání s klíčovým slovem.
        out = out.replacingOccurrences(of: "\u{00a0}", with: " ")
        out = replacing(out, "[ \\t]+", with: " ")

        let lines = out.components(separatedBy: "\n").map { line -> String in
            return trim(line)
        }
        var kept: [String] = []
        for (index, line) in lines.enumerated() {
            // Dvě prázdné řádky za sebou se slučují do jedné, tři a víc také —
            // rozestupy mezi bloky adres tím zůstanou předvídatelné.
            if line.isEmpty, index > 0, lines[index - 1].isEmpty { continue }
            kept.append(line)
        }
        return trim(kept.joined(separator: "\n"))
    }

    private static func oneLine(_ html: String) -> String {
        return trim(replacing(toText(html), "\\s*\\n\\s*", with: " "))
    }

    /**
     Vrátí jen nejvnitřnější řádky tabulek.

     E-mailové šablony vnořují tabulky do sebe, takže prosté hledání `<tr>…</tr>`
     by první položku spolklo do obalového řádku — proto se hlídá zanoření.
     Rozsahy se počítají v UTF-16 přes `NSString`, protože z toho počítá i
     `NSRegularExpression`; se `String.Index` by se to muselo pořád převádět.
     */
    private static func innerRows(_ html: String) -> [String] {
        var out: [String] = []
        var stack: [Int] = []
        let source = html as NSString
        for match in allGroups2(html, "<(/?)tr\\b[^>]*>") {
            if match.groups[1].isEmpty {
                stack.append(match.range.location + match.range.length)
                continue
            }
            guard let start = stack.popLast() else { continue }
            let length = match.range.location - start
            guard length > 0 else { continue }
            let inner = source.substring(with: NSRange(location: start, length: length))
            if !test(inner, "<tr\\b") { out.append(inner) }
        }
        return out
    }

    /// Varianta `allGroups`, která si nechává i rozsah zásahu — potřebuje ji
    /// jen hlídání zanoření tabulek.
    private static func allGroups2(_ value: String,
                                   _ pattern: String) -> [(range: NSRange, groups: [String])] {
        guard let expression = regex(pattern, [.caseInsensitive]) else { return [] }
        let source = value as NSString
        let range = NSRange(location: 0, length: source.length)
        return expression.matches(in: value, range: range).map { match -> (range: NSRange, groups: [String]) in
            return (match.range, groups(match, in: source))
        }
    }

    // MARK: - Jazykové sady

    private enum KW {
        static let billing = ["fakturační adresa", "fakturačná adresa", "fakturační údaje",
                              "billing address", "invoice address"]
        static let shipping = ["poštovní adresa", "poštová adresa", "doručovací adresa", "dodacia adresa",
                               "dodací adresa", "adresa doručení", "shipping address", "delivery address",
                               "postal address"]
        static let items = ["položky objednávky", "order items", "items"]
        static let shipment = ["doprava", "doručení", "doručenie", "přeprava", "shipping", "delivery", "postage"]
        static let payment = ["platba", "způsob platby", "spôsob platby", "payment"]
        static let total = ["celkem", "celkom", "spolu", "total", "k úhradě", "k úhrade", "grand total"]
        static let code = ["kód", "kod", "code", "sku"]
        static let availability = ["dostupnost", "dostupnosť", "availability", "stock"]
    }

    /// Jazyk se určuje podle počtu zásahů, ne podle pořadí — smíšené maily
    /// (česká šablona s anglickým patičkovým textem) by jinak vždy vyšly jako čeština.
    private static func detectLang(_ value: String) -> String {
        let haystack = value.lowercased()
        let marks: [String: [String]] = [
            "sk": ["fakturačná", "poštová adresa", "prijat[áé]", "dostupnosť", "celkom", "objednávk[ay] číslo"],
            "cz": ["fakturační", "poštovní adresa", "přijat[áéo]", "dostupnost\\b", "celkem", "děkujeme"],
            "en": ["billing address", "order items", "delivery address", "availability", "\\btotal\\b", "thank you"]
        ]
        var score: [String: Int] = ["cz": 0, "sk": 0, "en": 0]
        let order = ["cz", "sk", "en"]
        for lang in order {
            for pattern in marks[lang] ?? [] where test(haystack, pattern) {
                score[lang] = (score[lang] ?? 0) + 1
            }
        }
        var best = "cz"
        for lang in order where (score[lang] ?? 0) > (score[best] ?? 0) { best = lang }
        return (score[best] ?? 0) > 0 ? best : "cz"
    }

    private static func startsWithKw(_ value: String, _ list: [String]) -> Bool {
        let needle = trim(value).lowercased()
        return list.contains { keyword -> Bool in
            return needle == keyword
                || needle.hasPrefix(keyword + " ")
                || needle.hasPrefix(keyword + ":")
                || needle.hasPrefix(keyword + "\n")
        }
    }

    private static func containsKw(_ value: String, _ list: [String]) -> Bool {
        let needle = value.lowercased()
        return list.contains { keyword -> Bool in
            return needle.contains(keyword)
        }
    }

    // MARK: - Adresy

    private static let countryPattern = "^(česk[áé]\\s+republika|slovensk[áé]\\s+republika|slovensko|čechy"
        + "|czech republic|czechia|slovakia|deutschland|germany|austria|rakousko|polska|poland"
        + "|united kingdom|usa)$"

    /// Firma se pozná podle právní formy; druhý řádek adresy bývá buď ona, nebo už ulice.
    private static let companyPattern = "\\b(s\\.?\\s?r\\.?\\s?o|a\\.?\\s?s|spol|ltd|llc|gmbh|inc|k\\.?s|v\\.?o\\.?s)\\b"

    private static func parseAddress(_ block: String) -> [String: Any]? {
        let lines = toText(block).components(separatedBy: "\n").map { line -> String in
            return trim(line)
        }.filter { line -> Bool in
            return !line.isEmpty
        }
        guard let name = lines.first else { return nil }

        var rest = Array(lines.dropFirst())
        var country: String? = nil
        if let last = rest.last, test(last, countryPattern) {
            country = last
            rest.removeLast()
        }
        var company: String? = nil
        if rest.count > 1, test(rest[0], companyPattern) {
            company = rest.removeFirst()
        }
        return [
            "name": name,
            "company": company ?? NSNull(),
            "lines": rest,
            "country": country ?? NSNull()
        ]
    }

    // MARK: - Ceny

    private static let currencyPattern = "kč|czk|€|eur|\\$|usd|£|gbp|zł|pln"

    /**
     Vypadá text jako cena?

     Pozor na past ze stolní verze: za „Kč" nejde dát `\b`. V JavaScriptu proto,
     že `č` není znak slova, takže hranice slova padne na špatné místo; v ICU
     (tady) zase `\w` písmena s háčky bere, takže by se `\b` chovalo jinak než
     na počítači. Negativní pohled dopředu na libovolné písmeno je stejný
     v obou světech — a přesně o to jde, ať karta vypadá všude stejně.
     */
    private static func looksLikePrice(_ value: String) -> Bool {
        return test(trim(value), "\\d[\\d\\s .,]*\\s*(" + currencyPattern + ")(?![\\p{L}])")
    }

    private static func normPrice(_ value: String) -> String {
        return trim(replacing(value, "\\s+", with: " "))
    }

    /**
     Varianty produktu („- Délka: 110cm", „Šířka: 7cm").

     Při balení jsou zásadní — kšandy 110 a 120 cm vypadají na fotce stejně,
     takže musí být vidět zvlášť.
     */
    private static func parseVariants(_ cellText: String) -> [String] {
        let skip = KW.code + KW.availability
        var out: [String] = []
        for raw in cellText.components(separatedBy: "\n").dropFirst() {
            let line = trim(replacing(raw, "^[-–•*]\\s*", with: ""))
            guard let parts = firstGroups(line, "^([\\p{L} ]{2,24}?)\\s*:\\s*(.{1,40})$") else { continue }
            let label = parts[1].lowercased()
            let isMeta = skip.contains { keyword -> Bool in
                return label.hasPrefix(keyword)
            }
            if isMeta { continue }
            out.append("\(trim(parts[1])): \(trim(parts[2]))")
        }
        return out
    }

    /// Odřízne cenu z konce řádku a vrátí zbytek textu i cenu zvlášť.
    private static func splitTrailingPrice(_ line: String) -> (text: String, price: String?) {
        let pattern = "^([\\s\\S]*?)\\s*([\\d][\\d\\s .,]*\\s*(?:" + currencyPattern + "))\\s*$"
        guard let parts = firstGroups(line, pattern) else { return (trim(line), nil) }
        return (trim(parts[1]), normPrice(parts[2]))
    }

    /// Množství: `Number(x) || 1` z JS. Nula i nečitelná hodnota končí na jedničce,
    /// aby se v kartě neobjevilo „0 ks". Celá čísla jdou dál jako `Int`, ať se
    /// v mostu nezobrazí „2.0 ks".
    private static func quantity(_ raw: String) -> Any {
        let normalized = raw.replacingOccurrences(of: ",", with: ".")
        guard let value = Double(normalized), value != 0 else { return 1 }
        if value == value.rounded() { return Int(value) }
        return value
    }

    // MARK: - Položka

    private static func item(qty: Any,
                             unit: String?,
                             title: String,
                             code: String?,
                             url: String?,
                             price: String,
                             availability: String?,
                             variants: [String]) -> [String: Any] {
        return [
            "qty": qty,
            "unit": unit ?? NSNull(),
            "title": title,
            "code": code ?? NSNull(),
            "url": url ?? NSNull(),
            "price": price,
            "availability": availability ?? NSNull(),
            "variants": variants,
            // Obrázek a cena z produktového feedu se doplňují až jinde,
            // parser sám nic nestahuje.
            "image": NSNull(),
            "feedUrl": NSNull(),
            "feedPrice": NSNull(),
            "matched": false
        ]
    }

    /// Rozpis objednávky bez ohledu na to, jestli přišel z HTML nebo z textu.
    private typealias Lines = (items: [[String: Any]],
                               shipmentName: String?,
                               shipmentPrice: String?,
                               paymentName: String?,
                               paymentPrice: String?,
                               total: String?)

    /**
     Položky z textové varianty mailu (bez HTML).

     Šablona drží pořadí: „1 ks / Název", „Kód: X", „Dostupnost: Y <cena>",
     pak Doprava / Platba / CELKEM. Doprava a platba mají název až na dalším
     řádku, proto se čeká přes `pending`.
     */
    private static func parsePlainItems(_ value: String) -> Lines {
        let lines = value.components(separatedBy: "\n").map { line -> String in
            return trim(line)
        }.filter { line -> Bool in
            return !line.isEmpty
        }

        var items: [[String: Any]] = []
        var shipmentName: String? = nil
        var shipmentPrice: String? = nil
        var paymentName: String? = nil
        var paymentPrice: String? = nil
        var total: String? = nil
        var current: [String: Any]? = nil
        var pending: String? = nil

        for raw in lines {
            let split = splitTrailingPrice(raw)
            let line = split.text
            let price = split.price

            if let waiting = pending {
                let name = text(trim(replacing(line, "<[^>]*>", with: "")))
                if waiting == "shipment" {
                    shipmentName = name
                    shipmentPrice = price
                } else {
                    paymentName = name
                    paymentPrice = price
                }
                pending = nil
                continue
            }

            if let parts = firstGroups(line, "^(\\d+(?:[.,]\\d+)?)\\s*([\\p{L}.]{0,4})\\s*[/×x]\\s*(.+)$") {
                if let done = current { items.append(done); current = nil }
                // V textové variantě je URL za názvem v lomených závorkách
                var url: String? = nil
                if let link = firstGroups(parts[3], "<(https?://[^>]+)>") { url = link[1] }
                current = item(qty: quantity(parts[1]),
                               unit: text(replacing(parts[2], "\\.$", with: "")),
                               title: trim(replacing(parts[3], "<[^>]*>\\s*$", with: "")),
                               code: nil,
                               url: url,
                               price: price ?? "",
                               availability: nil,
                               variants: [])
                continue
            }

            let codePattern = "^(?:" + KW.code.joined(separator: "|") + ")\\s*:\\s*(.+)$"
            if let parts = firstGroups(line, codePattern), current != nil {
                current?["code"] = trim(parts[1])
                if let price { current?["price"] = price }
                continue
            }

            let availPattern = "^(?:" + KW.availability.joined(separator: "|") + ")\\s*:\\s*(.+)$"
            if let parts = firstGroups(line, availPattern), current != nil {
                current?["availability"] = trim(parts[1])
                if let price { current?["price"] = price }
                continue
            }

            if startsWithKw(line, KW.total) {
                if let done = current { items.append(done); current = nil }
                if let price { total = price }
                continue
            }
            if startsWithKw(line, KW.shipment), !line.contains(":") {
                if let done = current { items.append(done); current = nil }
                pending = "shipment"
                continue
            }
            if startsWithKw(line, KW.payment), !line.contains(":") {
                if let done = current { items.append(done); current = nil }
                pending = "payment"
                continue
            }
        }
        if let done = current { items.append(done) }

        return (items, shipmentName, shipmentPrice, paymentName, paymentPrice, total)
    }

    // MARK: - Rozpis z HTML tabulky

    private static func parseTableRows(_ html: String) -> Lines {
        var items: [[String: Any]] = []
        var shipmentName: String? = nil
        var shipmentPrice: String? = nil
        var paymentName: String? = nil
        var paymentPrice: String? = nil
        var total: String? = nil

        for row in innerRows(html) {
            let cells = allGroups(row, "<t[dh]\\b[^>]*>([\\s\\S]*?)</t[dh]>").map { parts -> String in
                return parts[1]
            }
            if cells.count < 2 { continue }

            let priceTxt = oneLine(cells[cells.count - 1])
            let textCells = cells.map { cell -> String in
                return toText(cell)
            }.filter { cell -> Bool in
                return !cell.isEmpty
            }

            // Popisná buňka = ta nejobsáhlejší mimo poslední (cenovou);
            // obrázkové buňky jsou po odstranění značek prázdné
            let contentCells = Array(cells.dropLast())
            var bodyCell = contentCells[0]
            for cell in contentCells where toText(cell).count > toText(bodyCell).count {
                bodyCell = cell
            }
            let cellText = toText(bodyCell)

            // Položka: „1 ks / Název" (+ Kód / Dostupnost). Samotné množství nestačí —
            // stejně začíná i řádek se slevou, proto se chce ještě kód nebo odkaz.
            let qtyParts = firstGroups(cellText, "^\\s*(\\d+(?:[.,]\\d+)?)\\s*([\\p{L}.]{0,4})\\s*[/×x]\\s*([\\s\\S]+)")
            let isItem = qtyParts != nil
                && (containsKw(cellText, KW.code) || test(bodyCell, "<a\\b[^>]*href="))

            if isItem, let parts = qtyParts {
                let link = firstGroups(bodyCell, "<a\\b[^>]*href=\"([^\"]+)\"[^>]*>([\\s\\S]*?)</a>")
                let firstLine = trim(parts[3].components(separatedBy: "\n")[0])
                let codeParts = firstGroups(cellText, "(?:" + KW.code.joined(separator: "|") + ")\\s*:\\s*([^\\n]+)")
                let availParts = firstGroups(cellText, "(?:" + KW.availability.joined(separator: "|") + ")\\s*:\\s*([^\\n]+)")

                var title = firstLine
                var url: String? = nil
                if let link {
                    title = oneLine(link[2])
                    url = decodeEntities(link[1])
                }
                var code: String? = nil
                if let codeParts { code = trim(codeParts[1]) }
                var availability: String? = nil
                if let availParts { availability = trim(availParts[1]) }
                var price = ""
                if looksLikePrice(priceTxt) { price = normPrice(priceTxt) }

                items.append(item(qty: quantity(parts[1]),
                                  unit: text(replacing(parts[2], "\\.$", with: "")),
                                  title: title,
                                  code: code,
                                  url: url,
                                  price: price,
                                  availability: availability,
                                  variants: parseVariants(cellText)))
                continue
            }

            // Doprava / platba / celkem
            if !looksLikePrice(priceTxt), !containsKw(cellText, KW.total) { continue }
            let parts = cellText.components(separatedBy: "\n")
            let label = trim(parts[0])
            let detail = trim(parts.dropFirst().joined(separator: " "))

            // Součtový řádek bývá bez dvojtečky a jen o dvou buňkách; u širší
            // tabulky by „celkem" ve větě jinak přepsalo skutečný součet.
            if startsWithKw(label, KW.total) || (textCells.count <= 2 && containsKw(label, KW.total)) {
                total = normPrice(priceTxt)
            } else if startsWithKw(label, KW.shipment), shipmentName == nil {
                shipmentName = detail.isEmpty ? label : detail
                shipmentPrice = looksLikePrice(priceTxt) ? normPrice(priceTxt) : nil
            } else if startsWithKw(label, KW.payment), paymentName == nil {
                paymentName = detail.isEmpty ? label : detail
                paymentPrice = looksLikePrice(priceTxt) ? normPrice(priceTxt) : nil
            }
        }

        return (items, shipmentName, shipmentPrice, paymentName, paymentPrice, total)
    }

    // MARK: - Hlavičkové údaje

    private static let numberPatterns = [
        "(?:objednávk\\w*|objednávka|order|bestellung)[^\\n\\d]{0,40}?(?:čísl\\w+|číslo|č\\.|number|no\\.?|#)"
            + "\\s*:?\\s*([0-9][0-9\\-/]{2,})",
        "(?:čísl\\w+\\s+objednávky|order\\s+number|order\\s+no\\.?)\\s*:?\\s*([0-9][0-9\\-/]{2,})",
        "(?:č\\.|no\\.|#)\\s*([0-9][0-9\\-/]{3,})"
    ]

    /// Předmět má přednost před tělem — v patičce mailu bývají odkazy s dalšími čísly.
    private static func orderNumber(subject: String, bodyText: String) -> String? {
        for source in [subject, bodyText] {
            for pattern in numberPatterns {
                guard let parts = firstGroups(source, pattern) else { continue }
                return replacing(parts[1], "[^0-9\\-/]", with: "")
            }
        }
        return nil
    }

    /**
     Fakturační a doručovací adresa.

     V HTML je šablona drží jako dvojici „nadpis + odstavec"; když HTML část
     chybí, hledá se blok pod řádkem s klíčovým slovem.
     */
    private static func addresses(html: String, bodyText: String) -> (billing: [String: Any]?, shipping: [String: Any]?) {
        var billing: [String: Any]? = nil
        var shipping: [String: Any]? = nil

        let sections = allGroups(html, "<h[1-4][^>]*>([\\s\\S]*?)</h[1-4]>\\s*(?:<[^>]+>\\s*)*?<p[^>]*>([\\s\\S]*?)</p>")
        for section in sections {
            let label = oneLine(section[1])
            if billing == nil, containsKw(label, KW.billing) {
                billing = parseAddress(section[2])
            } else if shipping == nil, containsKw(label, KW.shipping) {
                shipping = parseAddress(section[2])
            }
        }
        if billing != nil || shipping != nil { return (billing, shipping) }

        // Záloha pro čistě textové maily: zalomení se vrátí zpátky na <br>,
        // aby šel použít stejný rozbor bloku jako u HTML
        let billingPattern = "(?:fakturační|fakturačná|billing)[^\\n]*\\n([\\s\\S]{0,220}?)(?:\\n\\n|$)"
        let shippingPattern = "(?:poštovní|poštová|doručovací|dodací|shipping|delivery)[^\\n]*\\n([\\s\\S]{0,220}?)(?:\\n\\n|$)"
        if let parts = firstGroups(bodyText, billingPattern) {
            billing = parseAddress(parts[1].replacingOccurrences(of: "\n", with: "<br>"))
        }
        if let parts = firstGroups(bodyText, shippingPattern) {
            shipping = parseAddress(parts[1].replacingOccurrences(of: "\n", with: "<br>"))
        }
        return (billing, shipping)
    }

    // MARK: - Výsledná karta

    /// Rozpracovaná karta. Slovník s tuctem klíčů se skládá až na jednom místě —
    /// u velkých literálů si překladač jinak stěžuje na dobu překladu.
    private struct Draft {
        var orderNumber: String = ""
        var lang: String = "cz"
        var placedAt: String? = nil
        var customerEmail: String? = nil
        var customerPhone: String? = nil
        var billing: [String: Any]? = nil
        var shipping: [String: Any]? = nil
        var items: [[String: Any]] = []
        var shipmentName: String? = nil
        var shipmentPrice: String? = nil
        var paymentName: String? = nil
        var paymentPrice: String? = nil
        var total: String? = nil
        var historyUrl: String? = nil
    }

    private static func card(_ draft: Draft) -> [String: Any] {
        var billing: Any = NSNull()
        if let value = draft.billing { billing = value }
        var shipping: Any = NSNull()
        if let value = draft.shipping { shipping = value }

        return [
            "orderNumber": draft.orderNumber,
            "lang": draft.lang,
            "placedAt": draft.placedAt ?? NSNull(),
            "customerEmail": draft.customerEmail ?? NSNull(),
            "customerPhone": draft.customerPhone ?? NSNull(),
            "billing": billing,
            "shipping": shipping,
            "items": draft.items,
            "shipmentName": draft.shipmentName ?? NSNull(),
            "shipmentPrice": draft.shipmentPrice ?? NSNull(),
            "paymentName": draft.paymentName ?? NSNull(),
            "paymentPrice": draft.paymentPrice ?? NSNull(),
            "total": draft.total ?? NSNull(),
            "historyUrl": draft.historyUrl ?? NSNull(),
            // Odkaz do administrace, živý stav a sledování zásilky doplňuje
            // až vrstva nad parserem; z mailu se vyčíst nedají.
            "adminUrl": NSNull(),
            "adminSource": NSNull(),
            "live": NSNull(),
            "tracking": NSNull()
        ]
    }

    // MARK: - Hlavní parser

    /**
     Rozbor potvrzovacího e-mailu.

     Odpovídá `parseOrderEmail({ subject, html, text, toAddr })` ze stolní verze.
     Vrací `nil`, když zpráva potvrzení objednávky není — parametr se jmenuje
     `text`, ale uvnitř `plain`, aby nezastínil pomocnou funkci `text(_:)`.
     */
    static func parseOrderEmail(subject: String,
                                html: String?,
                                text plain: String?,
                                toAddr: String) -> [String: Any]? {
        let html = html ?? ""
        let plainText = plain ?? ""
        let bodyText = html.isEmpty ? plainText : toText(html)
        if bodyText.isEmpty { return nil }

        var draft = Draft()
        draft.lang = detectLang("\(subject)\n\(bodyText)")

        guard let number = orderNumber(subject: subject, bodyText: bodyText) else {
            // Potvrzení objednávky má vždy číslo. Bez něj by se karta nabídla
            // i u běžné zprávy, ve které padne nějaké číslo.
            return nil
        }
        draft.orderNumber = number

        if let hist = firstGroups(html, "href=\"([^\"]*(?:history-detail|order-detail|objednavka)[^\"]*)\"") {
            draft.historyUrl = decodeEntities(hist[1])
        }

        let datePattern = "(?:datum a čas přijetí|dátum a čas prijatia|date received|order date"
            + "|datum objednávky)\\s*:?\\s*([^\\n]+)"
        if let parts = firstGroups(bodyText, datePattern) {
            draft.placedAt = trim(parts[1])
        }

        let found = addresses(html: html, bodyText: bodyText)
        draft.billing = found.billing
        draft.shipping = found.shipping

        var lines = parseTableRows(html)
        // Záloha pro maily bez HTML části — textová varianta má stejné pořadí řádků
        if lines.items.isEmpty {
            let fallback = parsePlainItems(bodyText)
            lines.items = fallback.items
            lines.shipmentName = lines.shipmentName ?? fallback.shipmentName
            lines.shipmentPrice = lines.shipmentPrice ?? fallback.shipmentPrice
            lines.paymentName = lines.paymentName ?? fallback.paymentName
            lines.paymentPrice = lines.paymentPrice ?? fallback.paymentPrice
            lines.total = lines.total ?? fallback.total
        }
        draft.items = lines.items
        draft.shipmentName = lines.shipmentName
        draft.shipmentPrice = lines.shipmentPrice
        draft.paymentName = lines.paymentName
        draft.paymentPrice = lines.paymentPrice
        draft.total = lines.total

        // Celková částka jako záloha z předmětu („… za 2 037,00 Kč")
        if draft.total == nil {
            let pattern = "(?:za|for|celkem|total)\\s+([\\d\\s\u{00a0} .,]+(?:" + currencyPattern + "))"
            if let parts = firstGroups(subject, pattern) {
                draft.total = normPrice(parts[1])
            }
        }

        // Adresa z pole „komu" je spolehlivější než první e-mail v textu —
        // v patičce bývá adresa e-shopu.
        if toAddr.contains("@") {
            draft.customerEmail = trim(toAddr)
        } else if let parts = firstGroups(bodyText, "[\\w.+-]+@[\\w-]+\\.[\\w.]{2,}") {
            draft.customerEmail = parts[0]
        }

        let phonePattern = "(?:tel|telefon|phone|mobil|kontakt)[^\\d+]{0,12}"
            + "((?:\\+\\d{1,3}[\\s\u{00a0}]?)?(?:\\d[\\s\u{00a0}-]?){8,14})"
        if let parts = firstGroups(bodyText, phonePattern) {
            draft.customerPhone = trim(replacing(parts[1], "[\\s\u{00a0}]+", with: " "))
        }

        // K číslu musí být buď rozpis položek, nebo aspoň součet — jinak
        // by se karta ukázala prázdná.
        if draft.items.isEmpty, draft.total == nil { return nil }

        return card(draft)
    }
}
