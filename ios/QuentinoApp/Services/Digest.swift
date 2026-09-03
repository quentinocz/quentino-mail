import Foundation

/**
 AI Přehled.

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
    /// Délka hlavního okna ve dnech
    private static let window = 30

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

    /**
     Kódy zboží na produkty.

     Ve feedu objednávek je kód **varianty**: šle 110 cm a 120 cm mají každé
     svůj. Pro otázku „co se prodává" jsou to ale jedny šle — a naopak pro
     otázku „jaká velikost jde nejvíc" je zajímavá právě varianta. Ceník je
     tu kvůli položkám, u kterých feed cenu nenese (dárek, sada): nula
     u nejprodávanějšího zboží vypadá jako chyba.
     */
    struct CatalogEntry {
        let base: String
        let title: String
        let label: String
        let price: Double
    }

    static func catalogIndex() -> [String: CatalogEntry] {
        var out: [String: CatalogEntry] = [:]
        for row in (try? SQLite.shared.query("SELECT code, title_cz, price_num FROM products")) ?? [] {
            let code = (row["code"] as? String ?? "").trimmingCharacters(in: .whitespaces)
            if code.isEmpty { continue }
            let price = row["price_num"] as? Double ?? Double(row["price_num"] as? Int ?? 0)
            out[code.lowercased()] = CatalogEntry(
                base: code, title: row["title_cz"] as? String ?? code, label: "", price: price)
        }
        for row in (try? SQLite.shared.query("SELECT code, product_code, label, price FROM product_variants")) ?? [] {
            let code = (row["code"] as? String ?? "").trimmingCharacters(in: .whitespaces)
            if code.isEmpty { continue }
            let base = (row["product_code"] as? String ?? "").trimmingCharacters(in: .whitespaces)
            let parent = out[(base.isEmpty ? code : base).lowercased()]
            let text = (row["price"] as? String ?? "")
                .replacingOccurrences(of: "[^0-9.,]", with: "", options: .regularExpression)
                .replacingOccurrences(of: ",", with: ".")
            let price = Double(text) ?? parent?.price ?? 0
            out[code.lowercased()] = CatalogEntry(
                base: base.isEmpty ? code : base,
                title: parent?.title ?? base,
                label: (row["label"] as? String ?? "").trimmingCharacters(in: .whitespaces),
                price: price)
        }
        return out
    }

    /// Do kolika hodin se dvě objednávky téhož zákazníka počítají jako jeden nákup
    static let samePurchaseHours = 48

    /**
     Objednávky slité na nákupy.

     Když zákazníkovi neprojde platba, objedná znovu. Pro tržbu jsou to dvě
     objednávky, pro otázku „kolik lidí u nás nakoupilo" jeden nákup — bez
     slučování vycházel opakovaný nákup nesmyslně vysoko.
     */
    static func purchases(_ rows: [[String: Any]]) -> (purchases: Int, duplicates: Int) {
        var byEmail: [String: [String]] = [:]
        var anonymous = 0
        for row in rows {
            if isCancelled(row["status"] as? String ?? "") { continue }
            let email = (row["email"] as? String ?? "").trimmingCharacters(in: .whitespaces).lowercased()
            if email.isEmpty { anonymous += 1; continue }
            byEmail[email, default: []].append(row["created_at"] as? String ?? "")
        }

        var purchases = anonymous
        var orders = anonymous
        for times in byEmail.values {
            orders += times.count
            var last: Date?
            for at in times.sorted() {
                let when = Formats.date(at)
                if let last, let when, when.timeIntervalSince(last) <= Double(samePurchaseHours) * 3600 {
                    // Tentýž nákup, jen druhý pokus
                } else {
                    purchases += 1
                }
                if let when { last = when }
            }
        }
        return (purchases, max(0, orders - purchases))
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

    // MARK: - Signály: závěry, které spočítá kód

    private static let dayNames = ["neděle", "pondělí", "úterý", "středa", "čtvrtek", "pátek", "sobota"]

    /// O kolik procent se to změnilo; bez základu se nepočítá nic
    private static func pct(_ now: Int, _ before: Int) -> Int? {
        guard before != 0 else { return nil }
        return Int((Double(now - before) / Double(before) * 100).rounded())
    }

    private static func signal(_ kind: String, _ text: String, _ basis: String) -> [String: Any] {
        var one: [String: Any] = [:]
        one["kind"] = kind
        one["text"] = text
        one["basis"] = basis
        return one
    }

    /**
     Co se v číslech změnilo.

     Schválně **kód, ne model**: srovnat dvě čísla umí kód přesně a zadarmo,
     kdežto model se v tom umí splést a hlavně si dokáže vymyslet trend,
     který v datech není. Prahy jsou tu proto, aby se z šumu nedělaly zprávy.
     */
    private static func signals(
        currency: String, days: [[String: Any]], window now: Totals, prevWindow before: Totals,
        returning: Int, windowRows: [[String: Any]], prevRows: [[String: Any]],
        payments: [[String: Any]], shipments: [[String: Any]], countries: [[String: Any]],
        products: [[String: Any]], prevQuantity: [String: Int], sizes: [[String: Any]],
        purchases: Int, duplicates: Int, history: [String: Any], social: [String: Any]?
    ) -> [[String: Any]] {
        var out: [[String: Any]] = []
        // Kód měny je v tabulce v pořádku, ve větě ne — „19 400 CZK" nikdo neříká
        func money(_ value: Int) -> String { "\(value) \(currency == "CZK" ? "Kč" : currency)" }

        // 1) Objednávky, tržba a průměrná objednávka proti předchozím 30 dnům
        if before.orders >= 5 {
            if let change = pct(now.orders, before.orders), abs(change) >= 10 {
                out.append(signal(change > 0 ? "up" : "down",
                                  "Objednávek je o \(abs(change)) % \(change > 0 ? "víc" : "míň") "
                                  + "než v předchozích 30 dnech.",
                                  "\(now.orders) proti \(before.orders)"))
            }
            let nowMoney = now.amount(currency)
            let beforeMoney = before.amount(currency)
            if let change = pct(nowMoney, beforeMoney), abs(change) >= 10 {
                out.append(signal(change > 0 ? "up" : "down",
                                  "Tržba je o \(abs(change)) % \(change > 0 ? "vyšší" : "nižší") "
                                  + "než v předchozích 30 dnech.",
                                  "\(money(nowMoney)) proti \(money(beforeMoney))"))
            }
            let nowPaid = now.orders - now.cancelled
            let beforePaid = before.orders - before.cancelled
            if nowPaid > 0, beforePaid > 0 {
                let nowAvg = Int((Double(nowMoney) / Double(nowPaid)).rounded())
                let beforeAvg = Int((Double(beforeMoney) / Double(beforePaid)).rounded())
                if let change = pct(nowAvg, beforeAvg), abs(change) >= 10 {
                    out.append(signal(change > 0 ? "up" : "down",
                                      "Průměrná objednávka \(change > 0 ? "vzrostla" : "klesla") "
                                      + "o \(abs(change)) %.",
                                      "\(money(nowAvg)) proti \(money(beforeAvg))"))
                }
            }
        }

        // 2) Nejsilnější a nejslabší den v týdnu
        if now.orders >= 15 {
            var perWeekday: [Int: (orders: Int, days: Int)] = [:]
            for entry in days {
                guard let key = entry["day"] as? String, let date = dateOfDay(key) else { continue }
                let weekday = Calendar.current.component(.weekday, from: date) - 1
                var found = perWeekday[weekday] ?? (0, 0)
                found.orders += entry["orders"] as? Int ?? 0
                found.days += 1
                perWeekday[weekday] = found
            }
            let averages = perWeekday.map { (weekday: $0.key, avg: Double($0.value.orders) / Double(max(1, $0.value.days))) }
                .sorted { $0.avg > $1.avg }
            if let best = averages.first, let worst = averages.last,
               best.avg >= worst.avg * 1.5, best.avg >= 1 {
                out.append(signal("info",
                                  "Nejvíc se objednává v \(dayNames[best.weekday]), nejmíň v \(dayNames[worst.weekday]).",
                                  String(format: "průměrně %.1f proti %.1f objednávky na den", best.avg, worst.avg)))
            }
        }

        // 3) Posun v platbách a dopravě — podíl, ne počet: při růstu roste všechno
        func shareShift(_ title: String, _ list: [[String: Any]], _ pick: ([String: Any]) -> String) {
            guard now.orders >= 10, before.orders >= 10 else { return }
            var beforeCount: [String: Int] = [:]
            for row in prevRows {
                let key = pick(row)
                if !key.isEmpty { beforeCount[key] = (beforeCount[key] ?? 0) + 1 }
            }
            var bigKey = ""
            var bigFrom = 0.0
            var bigTo = 0.0
            var bigDiff = 0.0
            for one in list {
                let key = one["key"] as? String ?? ""
                let orders = one["orders"] as? Int ?? 0
                let fromShare = Double(beforeCount[key] ?? 0) / Double(before.orders) * 100
                let toShare = Double(orders) / Double(now.orders) * 100
                let diff = toShare - fromShare
                if abs(diff) > abs(bigDiff) {
                    bigKey = key; bigFrom = fromShare; bigTo = toShare; bigDiff = diff
                }
            }
            guard abs(bigDiff) >= 8, !bigKey.isEmpty else { return }
            out.append(signal("watch",
                              "\(title): \(bigKey) \(bigDiff > 0 ? "roste" : "ustupuje") — "
                              + "\(Int(bigTo.rounded())) % objednávek místo \(Int(bigFrom.rounded())) %.",
                              "\(Int(bigTo.rounded())) % z \(now.orders) proti \(Int(bigFrom.rounded())) % z \(before.orders)"))
        }
        shareShift("Platba", payments) { Shorthand.shortFor("payment", $0["payment"] as? String) }
        shareShift("Doprava", shipments) { Shorthand.shortFor("shipment", $0["shipment"] as? String) }

        // 4) Zboží, které vyskočilo nebo spadlo
        for product in products.prefix(5) {
            let code = product["code"] as? String ?? ""
            let title = product["title"] as? String ?? code
            let qty = product["qty"] as? Int ?? 0
            let was = prevQuantity[code] ?? 0
            if qty < 3 { continue }
            if was == 0, qty >= 5 {
                out.append(signal("up", "\(title) se předtím neprodával, teď je mezi nejprodávanějšími.",
                                  "\(qty) ks za 30 dní, předtím 0"))
            } else if let change = pct(qty, was), abs(change) >= 50 {
                out.append(signal(change > 0 ? "up" : "down",
                                  "\(title): prodej \(change > 0 ? "vzrostl" : "klesl") o \(abs(change)) %.",
                                  "\(qty) ks proti \(was) ks"))
            }
        }

        // 5) Nezaplacené, které leží — peníze, o kterých se neví
        let limit = Formats.iso(Date().addingTimeInterval(-3 * 86_400))
        let stale = windowRows.filter { row in
            (row["paid"] as? Int ?? 0) == 0
                && !isCancelled(row["status"] as? String ?? "")
                && (row["created_at"] as? String ?? "") < limit
        }
        if stale.count >= 3 {
            var sum = 0.0
            for row in stale where (row["currency"] as? String ?? "CZK").uppercased() == currency {
                sum += row["total"] as? Double ?? Double(row["total"] as? Int ?? 0)
            }
            out.append(signal("watch", "\(stale.count) objednávek čeká na zaplacení déle než tři dny.",
                              "dohromady \(money(Int(sum.rounded())))"))
        }

        // 6) Storna
        if now.orders >= 10, now.cancelled > 0 {
            let rate = Int((Double(now.cancelled) / Double(now.orders) * 100).rounded())
            let beforeRate = before.orders >= 10
                ? Int((Double(before.cancelled) / Double(before.orders) * 100).rounded()) : nil
            if rate >= 8 || (beforeRate != nil && rate - beforeRate! >= 5) {
                let tail = beforeRate != nil ? " (předtím \(beforeRate!) %)" : ""
                out.append(signal("watch", "Storna jsou na \(rate) % objednávek\(tail).",
                                  "\(now.cancelled) z \(now.orders)"))
            }
        }

        /*
         7) Opakovaný nákup — u galanterie to dělá rozdíl mezi kampaní
         a obchodem. Počítá se z **nákupů**, ne z objednávek: dvě objednávky
         téhož člověka do dvou dnů jsou jeden nákup, ne návrat.
         */
        if purchases >= 10 {
            let share = Int((Double(returning) / Double(purchases) * 100).rounded())
            out.append(signal(share >= 25 ? "up" : "watch",
                              "Opakovaně nakupuje \(share) % zákazníků.",
                              "\(returning) z \(purchases) nákupů za 30 dní"))
        }

        // 7b) Rozdvojené objednávky — když jich je hodně, drhne něco v košíku
        if duplicates >= 3, now.orders >= 10 {
            let share = Int((Double(duplicates) / Double(now.orders) * 100).rounded())
            if share >= 8 {
                out.append(signal("watch",
                                  "\(duplicates) objednávek jsou druhé pokusy téhož zákazníka do dvou dnů (\(share) %).",
                                  "\(now.orders) objednávek se slilo na \(purchases) nákupů"))
            }
        }

        // 8) Zahraničí
        if let home = countries.first, now.orders >= 10 {
            let homeKey = home["key"] as? String ?? ""
            let abroad = now.orders - (home["orders"] as? Int ?? 0)
            if abroad > 0 {
                let rest = countries.dropFirst().prefix(3).map { one in
                    "\(one["key"] as? String ?? "") \(one["orders"] as? Int ?? 0)"
                }.joined(separator: ", ")
                out.append(signal("info",
                                  "Mimo \(homeKey) jde \(Int((Double(abroad) / Double(now.orders) * 100).rounded())) % objednávek.",
                                  rest))
            }
        }

        // 9) Velikost napříč barvami — podle toho se skládá sklad, ne podle barev
        if let size = sizes.first, (size["products"] as? Int ?? 0) >= 2, now.orders >= 10 {
            let all = sizes.reduce(0) { $0 + ($1["qty"] as? Int ?? 0) }
            let qty = size["qty"] as? Int ?? 0
            if all > 0 {
                out.append(signal("info",
                                  "Nejžádanější velikost je \(size["label"] as? String ?? "") — "
                                  + "\(Int((Double(qty) / Double(all) * 100).rounded())) % kusů s velikostí.",
                                  "\(qty) z \(all) kusů, napříč \(size["products"] as? Int ?? 0) produkty"))
            }
        }

        // 10) Zasazení do roku — „113 objednávek" je jinak číslo bez váhy
        if let rank = history["rank"] as? [String: Any] {
            let better = rank["better"] as? Int ?? 0
            let of = rank["of"] as? Int ?? 0
            if of >= 6 {
                if better == of {
                    out.append(signal("up", "Posledních 30 dní je nejsilnějších za celou dobu, co feed sahá.",
                                      "\(now.orders) objednávek, víc než kterýkoli z \(of) uzavřených měsíců"))
                } else if better <= of / 4 {
                    out.append(signal("down", "Posledních 30 dní patří k nejslabším obdobím roku.",
                                      "slabších bylo jen \(better) z \(of) měsíců"))
                }
            }
        }

        // 10b) Loňsko — jediné srovnání, které nemate sezónou
        if let lastYear = history["lastYear"] as? [String: Any] {
            let orders = lastYear["orders"] as? Int ?? 0
            if orders >= 5, let change = pct(now.orders, orders), abs(change) >= 10 {
                out.append(signal(change > 0 ? "up" : "down",
                                  "Proti stejným 30 dnům loni \(change > 0 ? "víc" : "míň") o \(abs(change)) %.",
                                  "\(now.orders) proti \(orders) loni"))
            }
        }

        // 10c) Sezóna — z vlastních dat, ne z kalendáře
        if let season = history["season"] as? [String: Any] {
            out.append(signal("watch", season["text"] as? String ?? "", season["basis"] as? String ?? ""))
        }

        // 11) Sítě — korelace, ne důkaz, a tak se to i píše
        if let social, days.count >= 14 {
            let posts = social["posts"] as? Int ?? 0
            let prevPosts = social["prevPosts"] as? Int ?? 0
            let withPost = social["ordersWithPost"] as? Double ?? 0
            let without = social["ordersWithout"] as? Double ?? 0
            if posts == 0, prevPosts > 0 {
                out.append(signal("watch",
                                  "Za posledních 30 dní nevyšel žádný příspěvek, předtím jich bylo \(prevPosts).",
                                  "\(prevPosts) příspěvků v předchozím období"))
            } else if posts >= 3, without > 0 {
                let change = pct(Int((withPost * 10).rounded()), Int((without * 10).rounded()))
                if let change, abs(change) >= 20 {
                    out.append(signal(change > 0 ? "up" : "info",
                                      "Ve dnech s příspěvkem chodilo o \(abs(change)) % "
                                      + "\(change > 0 ? "víc" : "míň") objednávek (souvislost, ne důkaz).",
                                      "\(withPost) proti \(without) objednávky na den, "
                                      + "\(social["daysWithPost"] as? Int ?? 0) dní s příspěvkem"))
                }
            }
        }

        return out
    }

    /**
     Signály z návštěvnosti.

     Zvlášť, protože GA4 přichází ze sítě a zbytek přehledu na něj nečeká.
     Konverzní poměr je to hlavní, co objednávky samy o sobě neřeknou.
     */
    static func ga4Signals(_ snapshot: [String: Any]?) -> [[String: Any]] {
        guard let snapshot, snapshot["error"] is NSNull else { return [] }
        var out: [[String: Any]] = []
        let now = snapshot["window"] as? [String: Any] ?? [:]
        let before = snapshot["prevWindow"] as? [String: Any] ?? [:]

        if let sessions = now["sessions"] as? Int, let was = before["sessions"] as? Int, was > 0,
           let change = pct(sessions, was), abs(change) >= 10 {
            out.append(signal(change > 0 ? "up" : "down",
                              "Návštěvnost je o \(abs(change)) % \(change > 0 ? "vyšší" : "nižší") "
                              + "než v předchozích 30 dnech.",
                              "\(sessions) proti \(was) návštěvám"))
        }

        if let conversion = snapshot["conversion"] as? Double,
           let previous = snapshot["prevConversion"] as? Double, previous > 0 {
            let diff = ((conversion - previous) * 10).rounded() / 10
            if abs(diff) >= 0.3 {
                out.append(signal(diff > 0 ? "up" : "watch",
                                  "Konverzní poměr \(diff > 0 ? "stoupl" : "klesl") na \(conversion) %.",
                                  "předtím \(previous) %"))
            }
        }

        let sources = snapshot["sources"] as? [[String: Any]] ?? []
        if let top = sources.first, let sessions = now["sessions"] as? Int, sessions > 0 {
            let share = Int((Double(top["sessions"] as? Int ?? 0) / Double(sessions) * 100).rounded())
            let rest = sources.prefix(3).map { "\($0["name"] as? String ?? "") \($0["sessions"] as? Int ?? 0)" }
            out.append(signal("info",
                              "Nejvíc návštěv chodí z „\(top["name"] as? String ?? "")“ — \(share) %.",
                              rest.joined(separator: ", ")))
        }

        return out
    }

    /// `YYYY-MM-DD` na datum — na poledne, ať časové pásmo nepřehodí den
    private static func dateOfDay(_ key: String) -> Date? {
        let parts = key.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        var components = DateComponents()
        components.year = parts[0]
        components.month = parts[1]
        components.day = parts[2]
        components.hour = 12
        return Calendar.current.date(from: components)
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

        /*
         Hlavní okno jsou **klouzavé dny**, ne kalendářní měsíc. Prvního září
         má měsíc jeden den a srovnává se s jedním dnem srpna — z toho vyjde
         cokoli. Třicet dní je stejně dlouhých pořád.
         */
        let windowStart = shiftDays(now, -(window - 1))
        let prevWindowStart = shiftDays(now, -(2 * window - 1))
        let from = min(dayKey(prevWindowStart), dayKey(prevMonthStart))

        let rows = (try? SQLite.shared.query(
            """
            SELECT code, market, status, paid, created_at, currency, total, email,
                   shipment, payment, items_json, billing_json, postal_json
              FROM shop_orders WHERE created_at >= ? ORDER BY created_at DESC LIMIT 5000
            """,
            [.text(from)]
        )) ?? []

        let todayKey = dayKey(now)
        let yesterdayKey = dayKey(shiftDays(now, -1))
        let monthKey = dayKey(monthStart)
        let prevStartKey = dayKey(prevMonthStart)
        let prevEndKey = dayKey(prevMonthEnd)
        let windowKey = dayKey(windowStart)
        let prevWindowKey = dayKey(prevWindowStart)

        let windowRows = rows.filter { day(of: $0) >= windowKey }
        let prevRows = rows.filter { day(of: $0) >= prevWindowKey && day(of: $0) < windowKey }
        let today = totals(rows.filter { day(of: $0) == todayKey })
        let yesterday = totals(rows.filter { day(of: $0) == yesterdayKey })
        let windowTotals = totals(windowRows)
        let prevWindow = totals(prevRows)
        let month = totals(rows.filter { day(of: $0) >= monthKey })
        let prevMonth = totals(rows.filter { day(of: $0) >= prevStartKey && day(of: $0) < prevEndKey })

        // Sčítat koruny s eury nejde, ale dlaždice i graf potřebují jedno
        // číslo — bere se měna, ve které je nejvíc peněz
        let currency = windowTotals.mainCurrency ?? today.mainCurrency ?? "CZK"

        // Celé okno i s prázdnými dny — díra po víkendu je informace
        var days: [[String: Any]] = []
        for back in stride(from: window - 1, through: 0, by: -1) {
            let key = dayKey(shiftDays(now, -back))
            let one = totals(rows.filter { day(of: $0) == key })
            var entry: [String: Any] = [:]
            entry["day"] = key
            entry["orders"] = one.orders
            entry["revenue"] = one.amount(currency)
            days.append(entry)
        }

        /*
         Nejprodávanější zboží. Skládá se po kódech — týž produkt chodí ve
         feedu s názvem v jazyce trhu. Do tržby jdou jen objednávky
         v převažující měně (osm eur připsaných ke korunám dělalo z pásku
         zboží za 32 Kč) a bere se cena za **řádek**, ne za kus.
         */
        let catalog = catalogIndex()
        var titles: [String: String] = [:]
        var quantity: [String: Int] = [:]
        var inOrders: [String: Int] = [:]
        var earned: [String: Double] = [:]
        var estimated = Set<String>()
        var sizeQty: [String: Int] = [:]
        var sizeProducts: [String: Set<String>] = [:]
        var variantQty: [String: [String: Int]] = [:]

        for row in windowRows where !isCancelled(row["status"] as? String ?? "") {
            let sameCurrency = (row["currency"] as? String ?? "CZK").uppercased() == currency
            var counted = Set<String>()
            for item in items(row) {
                let code = ((item["code"] as? String) ?? (item["title"] as? String) ?? "")
                    .trimmingCharacters(in: .whitespaces)
                if code.isEmpty { continue }
                // Varianta se přiřadí k produktu — jinak by 110 a 120 cm byly dvoje šle
                let known = catalog[code.lowercased()]
                let base = known?.base ?? code
                let qty = item["quantity"] as? Int ?? Int(item["quantity"] as? Double ?? 0)
                let unit = item["price"] as? Double ?? Double(item["price"] as? Int ?? 0)
                let line = item["total"] as? Double ?? Double(item["total"] as? Int ?? 0)

                titles[base] = titles[base] ?? known?.title ?? (item["title"] as? String ?? base)
                quantity[base] = (quantity[base] ?? 0) + qty
                if sameCurrency {
                    let value = line > 0 ? line : unit * Double(qty)
                    if value > 0 {
                        earned[base] = (earned[base] ?? 0) + value
                    } else if let price = known?.price, price > 0 {
                        // Feed u dárků a sad cenu nenese; ceník je lepší než nula
                        earned[base] = (earned[base] ?? 0) + price * Double(qty)
                        estimated.insert(base)
                    }
                }
                if !counted.contains(base) {
                    inOrders[base] = (inOrders[base] ?? 0) + 1
                    counted.insert(base)
                }

                // Velikost sama o sobě: lidé si ji drží napříč barvami
                if let label = known?.label, !label.isEmpty {
                    sizeQty[label] = (sizeQty[label] ?? 0) + qty
                    sizeProducts[label, default: []].insert(base)
                    variantQty[base, default: [:]][label] = (variantQty[base]?[label] ?? 0) + qty
                }
            }
        }

        // Totéž za předchozích třicet dní — jen na srovnání, na obrazovku nejde
        var prevQuantity: [String: Int] = [:]
        for row in prevRows where !isCancelled(row["status"] as? String ?? "") {
            for item in items(row) {
                let code = ((item["code"] as? String) ?? (item["title"] as? String) ?? "")
                    .trimmingCharacters(in: .whitespaces)
                if code.isEmpty { continue }
                let base = catalog[code.lowercased()]?.base ?? code
                let qty = item["quantity"] as? Int ?? Int(item["quantity"] as? Double ?? 0)
                prevQuantity[base] = (prevQuantity[base] ?? 0) + qty
            }
        }
        let products: [[String: Any]] = quantity.sorted { $0.value > $1.value }.prefix(8).map { pair in
            let variants: [[String: Any]] = (variantQty[pair.key] ?? [:])
                .sorted { $0.value > $1.value }.prefix(4).map { one in
                    var entry: [String: Any] = [:]
                    entry["label"] = one.key
                    entry["qty"] = one.value
                    return entry
                }
            var one: [String: Any] = [:]
            one["code"] = pair.key
            one["title"] = titles[pair.key] ?? pair.key
            one["qty"] = pair.value
            one["orders"] = inOrders[pair.key] ?? 0
            one["revenue"] = Int((earned[pair.key] ?? 0).rounded())
            one["estimated"] = estimated.contains(pair.key)
            one["variants"] = variants
            return one
        }

        let sizes: [[String: Any]] = sizeQty.sorted { $0.value > $1.value }.prefix(6).map { pair in
            var one: [String: Any] = [:]
            one["label"] = pair.key
            one["qty"] = pair.value
            one["products"] = sizeProducts[pair.key]?.count ?? 0
            return one
        }

        // Vracející se zákazníci — proti celé historii ve feedu, ne jen proti
        // načtenému oknu, jinak by každý vypadal jako nový
        let returning = ((try? SQLite.shared.query(
            """
            SELECT COUNT(*) AS n FROM shop_orders o
             WHERE o.created_at >= ? AND o.email != ''
               AND lower(o.status) NOT LIKE '%storn%' AND lower(o.status) NOT LIKE '%zrušen%'
               AND EXISTS (SELECT 1 FROM shop_orders p
                            WHERE p.email = o.email
                              AND p.created_at < datetime(o.created_at, '-48 hours')
                              AND lower(p.status) NOT LIKE '%storn%'
                              AND lower(p.status) NOT LIKE '%zrušen%')
            """,
            [.text(windowKey)]
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

        let paidOrders = windowTotals.orders - windowTotals.cancelled
        let average = paidOrders > 0
            ? Int((Double(windowTotals.amount(currency)) / Double(paidOrders)).rounded()) : 0

        let countries = slices(windowRows, by: country)
        // Dopravci a platby ve zkratkách ze slovníku — pobočky by daly stovku
        // řádků, jednu na výdejnu
        let shipments = slices(windowRows) { Shorthand.shortFor("shipment", $0["shipment"] as? String) }
        let payments = slices(windowRows) { Shorthand.shortFor("payment", $0["payment"] as? String) }

        let counted = purchases(windowRows)
        let statuses = slices(windowRows) { ($0["status"] as? String ?? "").trimmingCharacters(in: .whitespaces) }
        let history = DigestHistory.view(windowOrders: windowTotals.orders, currency: currency, now: now)
        let social = DigestSocial.view(days: days, windowDays: window)

        var out: [String: Any] = [:]
        out["currency"] = currency
        out["today"] = today.json
        out["yesterday"] = yesterday.json
        out["window"] = windowTotals.json
        out["prevWindow"] = prevWindow.json
        out["month"] = month.json
        out["prevMonth"] = prevMonth.json
        out["monthLabel"] = monthLabel
        out["monthDays"] = dayOfMonth
        out["days"] = days
        out["countries"] = countries
        out["shipments"] = shipments
        out["payments"] = payments
        out["products"] = products
        out["sizes"] = sizes
        out["statuses"] = statuses
        out["purchases"] = counted.purchases
        out["duplicates"] = counted.duplicates
        out["history"] = history
        out["social"] = social
        out["returning"] = returning
        out["average"] = average
        out["signals"] = signals(
            currency: currency, days: days, window: windowTotals, prevWindow: prevWindow,
            returning: returning, windowRows: windowRows, prevRows: prevRows,
            payments: payments, shipments: shipments, countries: countries,
            products: products, prevQuantity: prevQuantity, sizes: sizes,
            purchases: counted.purchases, duplicates: counted.duplicates,
            history: history, social: social as? [String: Any]
        )
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
            "SELECT at, facts, insight FROM digest_reports ORDER BY at DESC LIMIT ?", [.int(Int64(limit))])) ?? []
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

        let monthDays = facts["monthDays"] as? Int ?? 0

        var lines: [String] = []
        lines.append("Posledních 30 dní: \(count("window", "orders")) objednávek za \(money("window"))"
                     + ", průměr \(facts["average"] as? Int ?? 0) \(currency)"
                     + ", storno \(count("window", "cancelled"))"
                     + ", nezaplacených \(count("window", "unpaid"))"
                     + ", opakovaný nákup \(facts["returning"] as? Int ?? 0)")
        lines.append("Předchozích 30 dní: \(count("prevWindow", "orders")) objednávek za \(money("prevWindow"))"
                     + ", storno \(count("prevWindow", "cancelled"))")
        lines.append("Dnes: \(count("today", "orders")) objednávek za \(money("today"))"
                     + ", storno \(count("today", "cancelled"))")
        lines.append("Včera: \(count("yesterday", "orders")) objednávek za \(money("yesterday"))")
        /*
         Kalendářní měsíc je tu jen jako údaj a rovnou se říká, kolik dní má.
         Bez toho model druhého v měsíci srovnával dva dny s dvěma dny
         a stavěl na tom závěry.
         */
        lines.append("\(facts["monthLabel"] as? String ?? "Tento měsíc") (zatím \(monthDays) dní): "
                     + "\(count("month", "orders")) objednávek za \(money("month")) — stejná část "
                     + "minulého měsíce \(count("prevMonth", "orders")) za \(money("prevMonth")). "
                     + "Krátký měsíc není trend, závěry stav na 30denním okně.")
        lines.append("Denní řada (30 dní, počet objednávek): \(days)")
        lines.append("Země (30 dní): \(slice("countries"))")
        lines.append("Doprava (30 dní): \(slice("shipments"))")
        lines.append("Platba (30 dní): \(slice("payments"))")
        lines.append("Nejprodávanější (30 dní, varianty sloučené pod produkt): \(products.isEmpty ? "—" : products)")

        let sizes = (facts["sizes"] as? [[String: Any]] ?? []).map { one in
            "\(one["label"] as? String ?? "") \(one["qty"] as? Int ?? 0) ks u \(one["products"] as? Int ?? 0) produktů"
        }.joined(separator: ", ")
        lines.append("Velikosti napříč zbožím: \(sizes.isEmpty ? "—" : sizes)")
        lines.append("Stavy objednávek: \(slice("statuses"))")
        lines.append("Nákupy (objednávky téhož zákazníka do 48 h sloučené): \(facts["purchases"] as? Int ?? 0)"
                     + ", z toho druhé pokusy nebo dokupy: \(facts["duplicates"] as? Int ?? 0)")

        let history = historyForAi(facts["history"] as? [String: Any])
        if !history.isEmpty { lines.append(history) }
        let social = socialForAi(facts["social"] as? [String: Any])
        if !social.isEmpty { lines.append(social) }
        return lines.joined(separator: "\n")
    }

    /// Dlouhodobý kontext — bez něj je „113 objednávek" číslo bez váhy
    private static func historyForAi(_ history: [String: Any]?) -> String {
        guard let history else { return "" }
        var parts: [String] = []
        if let lastYear = history["lastYear"] as? [String: Any] {
            parts.append("stejných 30 dní loni: \(lastYear["orders"] as? Int ?? 0) objednávek "
                         + "za \(lastYear["revenue"] as? Int ?? 0)")
        }
        if let rank = history["rank"] as? [String: Any] {
            parts.append("slabších než současné okno bylo \(rank["better"] as? Int ?? 0) "
                         + "z \(rank["of"] as? Int ?? 0) uzavřených měsíců")
        }
        let months = (history["months"] as? [[String: Any]] ?? []).map {
            "\($0["month"] as? String ?? ""):\($0["orders"] as? Int ?? 0)"
        }.joined(separator: " ")
        if !months.isEmpty { parts.append("měsíce (počet objednávek): \(months)") }
        if let season = history["season"] as? [String: Any] {
            parts.append("sezóna: \(season["text"] as? String ?? "") (\(season["basis"] as? String ?? ""))")
        }
        if parts.isEmpty { return "" }
        return "Dlouhodobě (feed pokrývá \(history["coverage"] as? Int ?? 0) měsíců): "
            + parts.joined(separator: "; ")
    }

    /**
     Sociální sítě do zadání.

     Rovnou se říká, že je to souvislost, ne důkaz — jinak z toho model udělá
     „příspěvky zvýšily prodej o 30 %", což z těchhle dat nikdo neví.
     */
    private static func socialForAi(_ social: [String: Any]?) -> String {
        guard let social else { return "" }
        let posts = social["posts"] as? Int ?? 0
        let prevPosts = social["prevPosts"] as? Int ?? 0
        if posts == 0, prevPosts == 0 { return "Sociální sítě: za posledních 60 dní nevyšel žádný příspěvek." }
        var best = ""
        if let one = social["best"] as? [String: Any] {
            let caption = String((one["caption"] as? String ?? "").prefix(60))
            best = "; nejúspěšnější „\(caption)“ (\(one["likes"] as? Int ?? 0) lajků, "
                + "\(one["comments"] as? Int ?? 0) komentářů)"
        }
        return "Sociální sítě (30 dní): \(posts) příspěvků (předchozích 30 dní \(prevPosts)), "
            + "\(social["likes"] as? Int ?? 0) lajků, \(social["comments"] as? Int ?? 0) komentářů; "
            + "ve dnech s příspěvkem průměrně \(social["ordersWithPost"] as? Double ?? 0) objednávky, "
            + "ve dnech bez \(social["ordersWithout"] as? Double ?? 0) — je to souvislost, ne důkaz"
            + best + ". Zhlédnutí ani dosah aplikace nemá."
    }

    /// Návštěvnost do zadání — jen když se povedla stáhnout
    private static func ga4ForAi(_ ga4: [String: Any]?) -> String {
        guard let ga4, ga4["error"] is NSNull else { return "" }
        func period(_ key: String) -> String {
            let one = ga4[key] as? [String: Any] ?? [:]
            let sessions = one["sessions"] as? Int
            let users = one["users"] as? Int
            let purchases = one["purchases"] as? Int
            return "\(sessions.map(String.init) ?? "?") návštěv, \(users.map(String.init) ?? "?") uživatelů, "
                + "\(purchases.map(String.init) ?? "?") nákupů"
        }
        let sources = (ga4["sources"] as? [[String: Any]] ?? []).map {
            "\($0["name"] as? String ?? "") \($0["sessions"] as? Int ?? 0)"
        }.joined(separator: ", ")
        var text = "Návštěvnost z GA4 (30 dní): \(period("window")); předchozích 30 dní: \(period("prevWindow"))"
        if let conversion = ga4["conversion"] as? Double { text += "; konverzní poměr \(conversion) %" }
        if let previous = ga4["prevConversion"] as? Double { text += " proti \(previous) %" }
        if !sources.isEmpty { text += "; zdroje: \(sources)" }
        return text
    }

    /**
     Spočítané signály do zadání.

     To hlavní, o co se má postřeh opírat: hotové srovnání, které spočítal
     kód. Model tedy neodvozuje trend z řady čísel a zbývá mu práce, ve které
     je dobrý — co z toho je důležité a co s tím dělat.
     */
    private static func signalsForAi(_ facts: [String: Any]) -> String {
        let list = facts["signals"] as? [[String: Any]] ?? []
        if list.isEmpty { return "(žádný, čísla se proti minulému období výrazně nezměnila)" }
        return list.map { one in
            "- \(one["text"] as? String ?? "") [\(one["basis"] as? String ?? "")]"
        }.joined(separator: "\n")
    }

    /// Co bylo minule — aby AI navazovala a neopakovala se
    private static func memoryForAi(_ history: [(at: String, facts: [String: Any], insight: [String: Any])]) -> String {
        history.map { one -> String in
            let when = String(one.at.prefix(10))
            let orders = ((one.facts["window"] as? [String: Any]) ?? (one.facts["month"] as? [String: Any]))?["orders"] as? Int
            let notes = (one.insight["notes"] as? [[String: Any]] ?? []).map { note in
                "- \(note["text"] as? String ?? "")"
            }.joined(separator: "\n")
            // Vlastní poznámka „na co se podívat příště" je to hlavní, kvůli
            // čemu se paměť vede — bez ní by každý den začínal od nuly
            var focus = ""
            if let text = one.insight["focus"] as? String, !text.isEmpty {
                focus = "\nChtěl jsi příště ověřit: \(text)"
            }
            let head = orders != nil ? "[\(when), za 30 dní tehdy \(orders!) objednávek]" : "[\(when)]"
            return "\(head)\n\(one.insight["headline"] as? String ?? "")\n\(notes)\(focus)"
        }.joined(separator: "\n\n")
    }

    private static let insightSystem = """
    Jsi obchodní analytik e-shopu Quentino (pásky, kšandy, kravaty a kožená galanterie; trhy CZ, SK a EU).
    Dostaneš spočítané signály, čísla z feedu objednávek a svoje dřívější postřehy. Tvůj úkol NENÍ počítat — \
    to je hotové. Tvůj úkol je vybrat, co z toho stojí za pozornost, říct proč a co s tím.

    Jak přemýšlej:
    1. Projdi signály a čísla a najdi ty, které mají skutečný dopad na tržbu, marži nebo práci navíc.
    2. U každého se zeptej: opírá se to o dost velký vzorek? Nemá to jiné vysvětlení (víkend, svátek, \
    jednorázová velká objednávka)? Když ano, napiš to místo závěru.
    3. Teprve co projde, napiš jako bod.

    Tvrdá pravidla:
    - Ke každému bodu MUSÍŠ do "basis" napsat konkrétní čísla ze zadání, o která se opírá. Když je nemáš, \
    ten bod nepiš.
    - Nevymýšlej si čísla ani skutečnosti, které v zadání nejsou (náklady, marže, ceny dopravy, kampaně, \
    konkurence). Když by závěr takový údaj potřeboval, napiš, co by bylo potřeba zjistit.
    - Návrh (kind "napad") musí mít cíl a být proveditelný tenhle týden; do "check" napiš, podle čeho se \
    za týden pozná, jestli zabral.
    - Nikdy nepiš obecné rady typu „zaměřte se na marketing" nebo „zlepšete komunikaci se zákazníky".
    - Radši dva podložené body než pět dojmů. Když data na nic nestačí (málo objednávek, krátké období), \
    napiš jeden bod, že zatím není z čeho soudit.
    - Když už jsi něco navrhoval dřív, navaž: co se potvrdilo, co ne.
    - Česky, věcně, bez oslovení a bez marketingových frází. Každý bod jedna věta, nejvýš čtyři body. \
    Celá odpověď do 1200 znaků.

    Vrať POUZE JSON, nic dalšího, a hlídej, ať se celý vejde:
    {"headline":"jedna až dvě věty souhrnu",
     "followUp":"navázání na minulý přehled nebo null",
     "notes":[{"kind":"trend|napad|pozor","text":"…","basis":"čísla, ze kterých to plyne",\
    "check":"u návrhu jak se pozná, že zabral, jinak null"}],
     "focus":"co si sám chceš ověřit v příštím přehledu, nebo null",
     "questions":["dvě až tři otázky, na které se podle tebe vyplatí doptat"]}
    """

    /**
     Záchrana z nedopsané odpovědi.

     Model občas narazí na strop tokenů a JSON zůstane rozseknutý uprostřed
     věty. Rozbor na tom skončí a v okně se pak objevil **celý surový JSON
     i se závorkami**. Vytahat z něj hotové kusy jde i tak.
     */
    private static func salvage(_ raw: String) -> [String: Any] {
        func first(_ pattern: String) -> String? {
            guard let found = raw.range(of: pattern, options: .regularExpression) else { return nil }
            let text = String(raw[found])
            guard let colon = text.firstIndex(of: ":") else { return nil }
            let value = text[text.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            let clean = value.trimmingCharacters(in: CharacterSet(charactersIn: "\""))
            return clean.isEmpty ? nil : unescape(clean)
        }

        var out: [String: Any] = [:]
        if let headline = first("\"headline\"\\s*:\\s*\"(?:[^\"\\\\]|\\\\.)*\"") { out["headline"] = headline }
        if let follow = first("\"followUp\"\\s*:\\s*\"(?:[^\"\\\\]|\\\\.)*\"") { out["followUp"] = follow }
        if let focus = first("\"focus\"\\s*:\\s*\"(?:[^\"\\\\]|\\\\.)*\"") { out["focus"] = focus }

        var notes: [[String: Any]] = []
        let pattern = "\"kind\"\\s*:\\s*\"(trend|napad|pozor)\"\\s*,\\s*\"text\"\\s*:\\s*\"(?:[^\"\\\\]|\\\\.)*\""
        var search = raw.startIndex..<raw.endIndex
        while let found = raw.range(of: pattern, options: .regularExpression, range: search) {
            let chunk = String(raw[found])
            search = found.upperBound..<raw.endIndex
            let parts = chunk.components(separatedBy: "\"text\"")
            guard parts.count > 1 else { continue }
            let kind = chunk.contains("\"napad\"") ? "napad" : chunk.contains("\"pozor\"") ? "pozor" : "trend"
            let tail = parts[1].drop(while: { $0 != "\"" }).dropFirst()
            let text = unescape(String(tail.prefix(while: { $0 != "\"" })))
            if text.isEmpty { continue }
            var entry: [String: Any] = [:]
            entry["kind"] = kind
            entry["text"] = text
            notes.append(entry)
            if notes.count >= 6 { break }
        }
        out["notes"] = notes
        return out
    }

    private static func unescape(_ text: String) -> String {
        text.replacingOccurrences(of: "\\n", with: " ")
            .replacingOccurrences(of: "\\\"", with: "\"")
            .trimmingCharacters(in: .whitespaces)
    }

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
                entry["basis"] = NSNull()
                if let basis = note["basis"] as? String, !basis.isEmpty { entry["basis"] = basis }
                entry["check"] = NSNull()
                if let check = note["check"] as? String, !check.isEmpty { entry["check"] = check }
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

        // Nedopsaný JSON — vytahá se z něj, co je hotové
        if raw.contains("\"headline\"") || raw.contains("\"notes\"") {
            let saved = salvage(raw)
            for (key, value) in saved { out[key] = value }
            if out["notes"] == nil { out["notes"] = [[String: Any]]() }
            if out["headline"] == nil { out["headline"] = "" }
            return out
        }

        /*
         Model se úplně minul formátem a napsal prostý text. Řádky se vezmou
         tak, jak jsou — ale nikdy se do okna nepustí něco, co začíná složenou
         závorkou: surový JSON na obrazovce je horší než prázdno.
         */
        let lines = raw.split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && !$0.hasPrefix("{") && !$0.hasPrefix("}") }
        out["headline"] = lines.first ?? ""
        var notes: [[String: Any]] = []
        for line in lines.dropFirst().prefix(4) {
            var entry: [String: Any] = [:]
            entry["kind"] = "trend"
            entry["text"] = line.replacingOccurrences(of: "^[-•*]\\s*", with: "", options: .regularExpression)
            entry["basis"] = NSNull()
            entry["check"] = NSNull()
            notes.append(entry)
        }
        out["notes"] = notes
        return out
    }

    /// Dopadl postřeh k něčemu, nebo se odpověď nevešla?
    private static func usable(_ one: [String: Any]) -> Bool {
        let headline = one["headline"] as? String ?? ""
        let notes = one["notes"] as? [[String: Any]] ?? []
        return !headline.isEmpty && !headline.hasPrefix("{") && !notes.isEmpty
    }

    private static func makeInsight(_ facts: [String: Any], ga4: [String: Any]? = nil) async throws -> [String: Any] {
        let history = stored()
        let memory = memoryForAi(history)
        let traffic = ga4ForAi(ga4)
        let user = "# Spočítané signály (z nich vycházej)\n\(signalsForAi(facts))\n\n"
            + "# Čísla\n\(factsForAi(facts))\n\n"
            + (traffic.isEmpty ? "" : "# Návštěvnost\n\(traffic)\n\n")
            + (memory.isEmpty ? "" : "# Co jsi psal dřív (nejnovější nahoře)\n\(memory)\n")

        /*
         Strop je schválně vysoký a přesto se hlídá. Když se odpověď nevejde,
         zůstane JSON rozseknutý uprostřed věty — a takový postřeh se nesmí
         uložit jako postřeh dne, jinak by se celý den ukazoval zmetek.
         */
        var answer = try await AI.ask(
            model: AI.draftModel, system: insightSystem, user: user, maxTokens: 2400)
        var insight = parseInsight(answer, model: AI.draftModel)
        if !usable(insight) {
            answer = try await AI.ask(
                model: AI.draftModel,
                system: insightSystem + "\n\nMinulý pokus se nevešel do limitu. Piš výrazně stručněji: "
                    + "nejvýš dva body, každý do 140 znaků, \"basis\" do 60 znaků.",
                user: user,
                maxTokens: 2400
            )
            let second = parseInsight(answer, model: AI.draftModel)
            if usable(second) { insight = second }
        }

        ensureTable()
        var snapshot: [String: Any] = [:]
        for key in ["today", "window", "prevWindow", "month", "currency", "average", "returning"] {
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
            // Denní přehled za půl roku je 180 zápisů; drží se jich 200
            "DELETE FROM digest_reports WHERE at NOT IN "
            + "(SELECT at FROM digest_reports ORDER BY at DESC LIMIT 200)")
        Store.setSetting(insightKey, insight["at"] as? String ?? "")

        /*
         Ostatní zařízení ať to nepočítají znovu. Posel je jen zkratka —
         když nedoletí, dojde to sdílenou složkou při synchronizaci.
         */
        if let share = self.share() { Live.publish("digest", share) }
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
        var facts = self.facts()
        let mail = mailTasks()
        let chat = await chatTasks()

        /*
         Návštěvnost je jediná část, která jde ven ze zařízení — ptá se
         nejvýš jednou denně a výpadek jen ubere kartu.
         */
        let ga4 = await Ga4.snapshot(force: force)
        if let ga4, ga4["error"] is NSNull {
            let extra = ga4Signals(ga4)
            if !extra.isEmpty {
                facts["signals"] = (facts["signals"] as? [[String: Any]] ?? []) + extra
            }
        }

        let history = stored(1)
        var insight: Any = history.first.map { $0.insight as Any } ?? NSNull()
        let lastAt = (history.first?.insight["at"] as? String) ?? Store.setting(insightKey, "") ?? ""
        let age = lastAt.isEmpty ? Double.greatestFiniteMagnitude
            : Date().timeIntervalSince(Formats.date(lastAt) ?? Date(timeIntervalSince1970: 0))

        var insightError: Any = NSNull()
        if force || age >= everySeconds {
            do {
                insight = try await makeInsight(facts, ga4: ga4)
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
        out["ga4"] = ga4 ?? NSNull()
        out["tasks"] = tasks
        out["insight"] = insight
        out["nextInsightAt"] = nextInsightAt
        out["insightError"] = insightError
        out["chatError"] = chat.error
        return out
    }

    // MARK: - Starší přehledy

    /**
     Seznam uložených přehledů.

     Postřehy se ukládají den po dni a je to jediná část přehledu, která se
     **nedá spočítat znovu**: čísla se dopočítají z feedu, ale text vznikl
     nad tím, co platilo tehdy.
     */
    static func archive(_ limit: Int = 200) -> [[String: Any]] {
        ensureTable()
        let rows = (try? SQLite.shared.query(
            "SELECT at, facts, insight FROM digest_reports ORDER BY at DESC LIMIT ?",
            [.int(Int64(min(400, max(1, limit))))])) ?? []

        return rows.map { row in
            let facts = json(row["facts"] as? String) ?? [:]
            let insight = json(row["insight"] as? String) ?? [:]
            let window = (facts["window"] as? [String: Any]) ?? (facts["month"] as? [String: Any])
            var one: [String: Any] = [:]
            one["at"] = row["at"] as? String ?? ""
            one["headline"] = insight["headline"] as? String ?? ""
            one["orders"] = window?["orders"] as? Int ?? NSNull()
            let revenue = (window?["revenue"] as? [[String: Any]])?.first?["amount"] as? Int
            one["revenue"] = revenue ?? NSNull()
            one["currency"] = facts["currency"] as? String ?? "CZK"
            return one
        }
    }

    /// Jeden starší přehled i s čísly, ze kterých vznikl
    static func fromArchive(_ at: String) -> [String: Any]? {
        ensureTable()
        guard let row = (try? SQLite.shared.query(
            "SELECT at, facts, insight FROM digest_reports WHERE at = ?", [.text(at)]))?.first else { return nil }
        var one: [String: Any] = [:]
        one["at"] = row["at"] as? String ?? at
        one["facts"] = json(row["facts"] as? String) ?? [:]
        one["insight"] = json(row["insight"] as? String) ?? [:]
        return one
    }

    // MARK: - Sdílení mezi zařízeními

    /**
     Postřehy pro ostatní zařízení.

     Postřeh stojí volání modelu a den co den vyjde stejný — počítat ho na
     počítači, notebooku a dvou telefonech zvlášť je čtyřnásobná cena za
     totéž. Kdo ho udělá první, pošle ho ostatním.
     */
    static func share() -> [String: Any]? {
        guard let last = stored(1).first, !(last.insight["at"] as? String ?? "").isEmpty else { return nil }
        var out: [String: Any] = [:]
        out["at"] = last.at
        out["facts"] = last.facts
        out["insight"] = last.insight
        return out
    }

    /// Přijetí postřehu odjinud; novější vyhrává
    @discardableResult
    static func applyShare(_ share: Any?) -> Bool {
        guard let one = share as? [String: Any] else { return false }
        let insight = one["insight"] as? [String: Any] ?? [:]
        let at = ((insight["at"] as? String) ?? (one["at"] as? String) ?? "")
            .trimmingCharacters(in: .whitespaces)
        guard !at.isEmpty else { return false }

        let mine = stored(1).first?.at ?? ""
        if !mine.isEmpty, mine >= at { return false }

        ensureTable()
        let facts = OrderFeed.jsonText(one["facts"] ?? [String: Any]()) ?? "{}"
        let text = OrderFeed.jsonText(insight) ?? "{}"
        _ = try? SQLite.shared.run(
            "INSERT OR REPLACE INTO digest_reports (at, facts, insight) VALUES (?,?,?)",
            [.text(at), .text(facts), .text(text)]
        )
        Store.setSetting(insightKey, at)
        return true
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

        let traffic = ga4ForAi(await Ga4.snapshot())
        var user = "# Spočítané signály\n\(signalsForAi(facts))\n\n"
        user += "# Čísla\n\(factsForAi(facts))\n\n"
        if !traffic.isEmpty { user += "# Návštěvnost\n\(traffic)\n\n" }
        user += "# Čeká na vyřízení (\(tasks.count))\n\(waiting.isEmpty ? "— nic" : waiting)"
        if !memory.isEmpty { user += "\n\n# Tvoje dřívější postřehy\n\(memory)" }
        if !talk.isEmpty { user += "\n\n# Dosavadní hovor\n\(talk)" }
        user += "\n\n# Otázka\n\(asked)"

        return try await AI.ask(model: AI.draftModel, system: askSystem, user: user, maxTokens: 900)
    }
}
