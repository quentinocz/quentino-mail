import Foundation

/**
 Podklady pro balení objednávek.

 Zdrojem je **feed objednávek**. Dřív se procházela schránka a ke každému
 potvrzovacímu e-mailu se skládala karta — na telefonu to byla jediná
 obrazovka, která uměla běžet klidně minutu. Feed má přitom všechno potřebné
 v jedné lokální tabulce, u položek rovnou kód varianty (ten je i na štítku)
 a k tomu aktuální stav objednávky.

 E-mail zůstává na dvě věci: na objednávku zadanou před chvílí, kterou feed
 ještě nestihl, a na tlačítko „Otevřít e-mail" u konkrétní objednávky.

 Průběh se hlásí událostí `packing:progress`, ať je vidět, co se děje.
 */
enum Packing {
    /// Jak dlouho platí uložená karta u objednávky, která se ještě může měnit.
    private static let cacheTtl: TimeInterval = 600
    private static let orderSubject = "(objedn[áa]v|order\\b|bestellung)"
    private static let subjectNumber = "(?:č\\.|c\\.|no\\.|nr\\.|#)\\s*\\d{3,}"

    // SQL s víc řádky stojí zvlášť — v těle metody by se pletlo s textem
    private static let SQL_UPDATE_SHOP = """
    UPDATE packing_shop SET packed_json = ?, counts_json = ?, done = ?, done_at = ?
    WHERE id = ?
    """

    private static let SQL_RESET_SHOP = """
    UPDATE packing_shop SET packed_json = '[]', counts_json = '{}',
      done = 0, done_at = NULL WHERE id = ?
    """

    private static let SQL_CACHED_CARDS = """
    SELECT c.message_pk AS id, c.json, m.date, m.subject, m.from_addr
    FROM order_cache c JOIN messages m ON m.id = c.message_pk
    WHERE c.json IS NOT NULL ORDER BY m.date DESC LIMIT 800
    """

    private static let SQL_BY_SUBJECT = """
    SELECT id, date, subject, from_addr FROM messages
    WHERE subject LIKE ? ORDER BY date DESC LIMIT 40
    """

    private static let SQL_BY_INVOICE = """
    SELECT * FROM shop_orders WHERE invoice != '' AND (invoice = ? OR ltrim(invoice, '0') = ?)
    ORDER BY created_at DESC LIMIT 4
    """

    private static let SQL_BY_CODE = """
    SELECT * FROM shop_orders WHERE code = ? OR ltrim(code, '0') = ?
    ORDER BY created_at DESC LIMIT 8
    """

    private static let SQL_ORDER_MAILS = """
    SELECT id, date, subject, from_addr FROM messages
    WHERE date >= ? ORDER BY date DESC LIMIT ?
    """

    // MARK: - Odškrtávání

    /**
     Nastaví, kolik kusů položky už je v krabici.

     Seznam odškrtnutých položek se z počtů dopočítá — položka je odškrtnutá
     teprve tehdy, když je v krabici všech svých kusů. Zbytek aplikace se tak
     nemusí ptát dvakrát.
     */
    @discardableResult
    static func setCount(messageId: Int, index: Int, count: Int) -> [String: Any] {
        let qty = qtyOf(messageId: messageId, index: index)
        let value = max(0, min(qty, count))
        var state = packed(messageId)

        if value == 0 { state.counts.removeValue(forKey: String(index)) }
        else { state.counts[String(index)] = value }

        if value >= qty {
            if !state.items.contains(index) { state.items.append(index) }
            state.items.sort()
        } else {
            state.items.removeAll { $0 == index }
        }

        save(messageId: messageId, state: state)
        return payload(state)
    }

    /// Odškrtne (nebo odškrtnutí zruší) celou položku — tedy všechny její kusy.
    @discardableResult
    static func setItem(messageId: Int, index: Int, value: Bool) -> [String: Any] {
        setCount(messageId: messageId, index: index,
                 count: value ? qtyOf(messageId: messageId, index: index) : 0)
    }

    /**
     Načtený kód přiřadí k položce objednávky a přidá jeden kus.

     Na štítku bývá kód varianty, v objednávce může být kód produktu (nebo
     naopak), takže se hledá přes katalog: ten z kódu vrátí obojí a porovnává
     se pak proti oběma. Když je táž položka v objednávce vícekrát, přednost
     dostane ta, které ještě kusy chybí — jinak by se druhý kus neměl kam
     připsat.
     */
    static func scanItem(messageId: Int, raw: String) -> [String: Any] {
        let text = normCode(raw)
        guard !text.isEmpty else { return ["ok": false, "reason": "empty", "message": "Prázdný kód"] }
        guard let card = card(messageId), let items = card["items"] as? [[String: Any]] else {
            return ["ok": false, "reason": "noOrder", "message": "Objednávka není načtená"]
        }

        let found = Catalog.find(text) as? [String: Any]
        var wanted: Set<String> = [text]
        if let code = found?["code"] as? String { wanted.insert(normCode(code)) }
        if let code = found?["productCode"] as? String { wanted.insert(normCode(code)) }
        wanted.remove("")

        var state = packed(messageId)
        let matching = items.enumerated().filter { wanted.contains(normCode($0.element["code"] as? String ?? "")) }

        guard !matching.isEmpty else {
            let title = found?["title"] as? String
            return [
                "ok": false, "reason": "notInOrder",
                "message": title.map { "\($0) v téhle objednávce není" } ?? "Kód \(text) v objednávce není"
            ]
        }

        // Nejdřív položky, kterým ještě kusy chybí
        let spot = matching.first { entry in
            (state.counts[String(entry.offset)] ?? 0) < max(1, entry.element["qty"] as? Int ?? 1)
        } ?? matching[0]

        let qty = max(1, spot.element["qty"] as? Int ?? 1)
        let title = spot.element["title"] as? String ?? ""
        let code = spot.element["code"] as? String
        let before = state.counts[String(spot.offset)] ?? 0

        if before >= qty {
            return [
                "ok": false, "reason": "already", "index": spot.offset,
                "code": code ?? NSNull(), "title": title,
                "count": before, "qty": qty, "needMore": 0,
                "message": "\(title) — všech \(qty) ks už je odškrtnutých"
            ]
        }

        setCount(messageId: messageId, index: spot.offset, count: before + 1)
        state = packed(messageId)
        let count = state.counts[String(spot.offset)] ?? 0
        let needMore = qty - count

        var message = title
        if qty > 1 {
            message = "\(title) — \(count)/\(qty) ks"
            if needMore > 0 { message += ", ještě \(needMore)" }
        }

        return [
            "ok": true, "index": spot.offset, "code": code ?? NSNull(), "title": title,
            "count": count, "qty": qty, "needMore": needMore, "message": message
        ]
    }

    /**
     Prázdný text jako `null` do JSONu.

     Psát to podmínkou `text.isEmpty ? NSNull() : text` nejde: Swift u ternárního
     operátoru nehledá pro obě větve společného předka, takže `NSNull` a `String`
     v jedné podmínce neprojdou. U `??` to projde — proto ten rozdíl níž v souboru.
     */
    private static func orNull(_ text: String?) -> Any {
        guard let text, !text.isEmpty else { return NSNull() }
        return text
    }

    /// Cena tak, jak ji skládá i verze pro počítač — číslo a měna, nic navíc.
    private static func money(_ value: Double, _ currency: String) -> String {
        let number = value == value.rounded() ? String(Int(value)) : String(value)
        return currency.isEmpty ? number : "\(number) \(currency)"
    }

    /**
     Objednávka z feedu podle čísla.

     Vodicí nuly se mezi doklady liší — na faktuře „022605", ve variabilním
     symbolu „22605". Porovnává se proto i tvar bez nul na obou stranách, jinak
     by se stejné číslo napsané jinak nenašlo.
     */
    private static func shopOrder(_ code: String, market: String? = nil) -> [String: Any]? {
        let forms = numberForms(code)
        guard !forms.isEmpty else { return nil }
        let rows = (try? SQLite.shared.query(
            SQL_BY_CODE, [.text(forms[0]), .text(forms[forms.count - 1])]
        )) ?? []
        guard !rows.isEmpty else { return nil }
        if let market, let exact = rows.first(where: { ($0["market"] as? String ?? "") == market }) {
            return exact
        }
        return rows[0]
    }

    /**
     Stav objednávky z feedu e-shopu.

     U starší objednávky je feed to jediné, co je aktuální: potvrzovací mail
     říká, co si zákazník objednal v den nákupu, ale ne to, že je zásilka dávno
     doručená nebo stornovaná. Právě tohle je potřeba vidět dřív, než někdo
     začne balit něco, co se balit nemá.
     */
    private static func shopState(_ orderNumber: String?) -> [String: Any]? {
        guard let row = shopOrder(orderNumber ?? "") else { return nil }
        let status = row["status"] as? String ?? ""
        let updated = row["updated_at"] as? String ?? ""
        let created = row["created_at"] as? String ?? ""
        let at = !updated.isEmpty ? updated : created
        return [
            "code": row["code"] as? String ?? "",
            "invoice": row["invoice"] as? String ?? "",
            "status": status,
            "at": orNull(at),
            "final": OrderTrack.isFinalStatus(status)
        ]
    }

    /// Čísla objednávky, pod kterými se dá hledat — vodicí nuly se všude liší.
    private static func numberForms(_ value: String) -> [String] {
        let digits = value.filter { $0.isNumber }
        guard !digits.isEmpty else { return [] }
        let bare = String(digits.drop { $0 == "0" })
        return (!bare.isEmpty && bare != digits) ? [digits, bare] : [digits]
    }

    /**
     Zpráva s potvrzením objednávky daného čísla — bez ohledu na stáří.

     Běžný seznam k balení sahá jen pár dní zpátky, ale načtená faktura může být
     i půl roku stará; hledá se proto rovnou podle čísla v předmětu, ne v okně.
     */
    private static func message(numbers: [String]) -> Candidate? {
        let cached = (try? SQLite.shared.query(SQL_CACHED_CARDS, [])) ?? []
        for row in cached {
            guard let text = row["json"] as? String, let data = text.data(using: .utf8),
                  let card = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let id = row["id"] as? Int else { continue }
            let forms = numberForms(card["orderNumber"] as? String ?? "")
            guard forms.contains(where: { numbers.contains($0) }) else { continue }
            return Candidate(id: id, date: row["date"] as? String ?? "",
                             subject: row["subject"] as? String ?? "")
        }

        for number in numbers {
            let rows = (try? SQLite.shared.query(SQL_BY_SUBJECT, [.text("%\(number)%")])) ?? []
            for row in rows {
                guard let id = row["id"] as? Int else { continue }
                let subject = row["subject"] as? String ?? ""
                guard matches(subject, orderSubject) else { continue }
                guard Orders.shopMatchesSender(row["from_addr"] as? String ?? "") else { continue }
                return Candidate(id: id, date: row["date"] as? String ?? "", subject: subject)
            }
        }
        return nil
    }

    /**
     Karta objednávky sestavená z feedu e-shopu.

     Feed nese u položek rovnou kód varianty — přesně ten, co je na štítku —
     takže se proti němu odškrtává líp než proti mailu, kde bývá kód produktu
     a varianta jen jako věta. Název, varianta a obrázek se doplní z katalogu;
     adresu feed nemá, ta zůstane prázdná.
     */
    private static func cardFromFeed(_ row: [String: Any]) -> [String: Any] {
        let market = row["market"] as? String ?? "cz"
        let currency = row["currency"] as? String ?? ""

        var items: [[String: Any]] = []
        if let text = row["items_json"] as? String, let data = text.data(using: .utf8),
           let parsed = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] {
            items = parsed
        }

        let cardItems: [[String: Any]] = items.map { item in
            let code = item["code"] as? String ?? ""
            let hit = code.isEmpty ? nil : Catalog.find(code) as? [String: Any]
            let label = hit?["label"] as? String ?? ""
            let price = item["price"] as? Double ?? 0
            let variants: [String] = label.isEmpty ? [] : [label]
            let out: [String: Any] = [
                "qty": max(1, item["quantity"] as? Int ?? 1),
                "unit": "ks",
                "title": (hit?["title"] as? String) ?? (item["title"] as? String) ?? code,
                "code": orNull(code),
                "url": NSNull(),
                "price": price > 0 ? money(price, currency) : "",
                "availability": hit?["availability"] ?? NSNull(),
                "variants": variants,
                "image": hit?["image"] ?? NSNull(),
                "feedUrl": NSNull(),
                "feedPrice": NSNull(),
                "matched": hit != nil
            ]
            return out
        }

        let status = row["status"] as? String ?? ""
        let phone = row["phone"] as? String ?? ""
        let name = row["name"] as? String ?? ""
        let total = row["total"] as? Double ?? 0

        /*
         Adresa. Doručovací nemusí být vyplněná — pak se doručuje na fakturační,
         a právě to je na kartě potřeba vidět. U výdejních míst je v doručovací
         adresa toho místa, což je při balení to, co se opisuje.
         */
        let postal = cardAddress(row["postal_json"], fallbackName: name)
        let billing = cardAddress(row["billing_json"], fallbackName: name)
        let shipping: Any = postal ?? billing ?? NSNull()

        /*
         Stav a číslo zásilky z feedu. Vnořený slovník stojí zvlášť schválně:
         v jednom velkém literálu si Swift u smíšených hodnot nepomůže typem
         zvenčí a překlad spadne na tom, že „NSNull" a text nejsou totéž.
         */
        let tracking: [String: Any] = [
            "source": "api",
            "status": orNull(status),
            "createdAt": row["created_at"] ?? NSNull(),
            "paidDate": row["paid_date"] ?? NSNull(),
            "customerPhone": orNull(phone),
            "carrierId": NSNull(), "carrierName": NSNull(),
            "trackingCode": row["tracking"] ?? NSNull(),
            "trackingUrl": NSNull(), "shipment": NSNull(), "shipmentError": NSNull()
        ]

        return [
            "orderNumber": row["code"] as? String ?? "",
            "lang": (market == "sk" || market == "en") ? market : "cz",
            "placedAt": row["created_at"] ?? NSNull(),
            "customerEmail": row["email"] ?? NSNull(),
            "customerPhone": orNull(phone),
            "billing": billing ?? NSNull(),
            "shipping": shipping,
            "items": cardItems,
            "shipmentName": row["shipment"] ?? NSNull(),
            "shipmentPrice": NSNull(),
            "paymentName": row["payment"] ?? NSNull(),
            "paymentPrice": NSNull(),
            "total": orNull(total > 0 ? money(total, currency) : ""),
            "historyUrl": NSNull(),
            "adminUrl": NSNull(),
            "adminSource": NSNull(),
            "live": NSNull(),
            "tracking": tracking
        ]
    }

    /**
     Adresa z feedu do tvaru, jaký zná karta objednávky.

     Jméno se bere z adresy, a když v ní není, ze zákazníka — u firemních
     objednávek bývá vyplněná jen firma, ale balík stejně přebírá člověk.
     */
    private static func cardAddress(_ value: Any?, fallbackName: String) -> [String: Any]? {
        guard let text = value as? String, let data = text.data(using: .utf8),
              let a = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }

        let field = { (key: String) in (a[key] as? String ?? "").trimmingCharacters(in: .whitespaces) }
        let zipCity = [field("zip"), field("city")].filter { !$0.isEmpty }.joined(separator: " ")
        let lines = [field("street"), zipCity, field("state")].filter { !$0.isEmpty }

        let company = field("company")
        let name = field("name").isEmpty ? fallbackName : field("name")
        if name.isEmpty && company.isEmpty && lines.isEmpty { return nil }

        return [
            "name": name.isEmpty ? company : name,
            "company": company.isEmpty ? NSNull() : company,
            "lines": lines,
            "country": field("country").isEmpty ? NSNull() : field("country")
        ]
    }

    /// Číslo, pod kterým rozhraní vede objednávku z feedu — řádek se založí, když chybí.
    private static func shopId(code: String, market: String) -> Int {
        _ = try? SQLite.shared.run(
            "INSERT OR IGNORE INTO packing_shop (code, market) VALUES (?, ?)",
            [.text(code), .text(market)]
        )
        let row = (try? SQLite.shared.query(
            "SELECT id FROM packing_shop WHERE code = ? AND market = ?", [.text(code), .text(market)]
        ))?.first
        return -(row?["id"] as? Int ?? 0)
    }

    /// Objednávka postavená na feedu — použije se, když k ní není potvrzovací mail.
    private static func orderFromFeed(_ row: [String: Any]) -> [String: Any] {
        let id = shopId(code: row["code"] as? String ?? "", market: row["market"] as? String ?? "")
        var out = payload(packed(id))
        out["messageId"] = id
        out["date"] = row["created_at"] as? String ?? ""
        out["card"] = cardFromFeed(row)
        out["source"] = "feed"
        out["shop"] = shopState(row["code"] as? String) ?? NSNull()
        return out
    }

    /// Objednávka postavená na potvrzovacím mailu — má navíc adresu.
    private static func orderFromMail(_ found: Candidate) async -> [String: Any]? {
        var card = cached(found.id)
        if card == nil {
            card = await Orders.card(dbId: found.id)
            Orders.writeCache(found.id, card)
        }
        guard let order = card else { return nil }

        var out = payload(packed(found.id))
        out["messageId"] = found.id
        out["date"] = found.date
        out["card"] = order
        out["source"] = "mail"
        out["shop"] = shopState(order["orderNumber"] as? String) ?? NSNull()
        return out
    }

    /**
     Krátký přehled feedu do hlášky, když se číslo nenajde.

     Rozsah dat řekne obojí, na čem hledání stojí: jak daleko feed sahá do
     historie a jestli není starý. Bez toho by „nenašlo se" nešlo rozlišit od
     „feed se týden nestáhl".
     */
    private static func feedReach() -> String {
        let row = (try? SQLite.shared.query(
            "SELECT COUNT(*) AS n, MIN(created_at) AS oldest, MAX(created_at) AS newest FROM shop_orders",
            []
        ))?.first
        let count = row?["n"] as? Int ?? 0
        guard count > 0 else { return "feed objednávek je zatím prázdný, načti ho v nastavení" }
        let oldest = String((row?["oldest"] as? String ?? "").prefix(10))
        let newest = String((row?["newest"] as? String ?? "").prefix(10))
        guard !oldest.isEmpty, !newest.isEmpty else { return "feed má \(count) objednávek" }
        return "feed má \(count) objednávek (\(oldest) až \(newest))"
    }

    /**
     Otevře objednávku podle načteného čísla — i takovou, která je dávno mimo
     seznam k balení.

     Pořadí je dané tím, co je na papíře: na faktuře je číslo faktury, takže se
     nejdřív přeloží přes feed na číslo objednávky. Teprve když načtené číslo
     žádná faktura nemá, bere se jako číslo objednávky — jinak by se u čísla,
     které je zároveň fakturou jedné a objednávkou druhé, otevřela ta nesprávná.
     Když nastane obojí, druhá možnost se vrátí v „also" a rozhraní ji nabídne.

     Podklady se berou z mailu, když existuje (má navíc adresu), jinak z feedu —
     ten má u položek rovnou kód varianty, takže se proti němu dá odškrtávat taky.
     */
    static func openOrder(_ raw: String) async -> [String: Any] {
        let asked = numberForms(raw)
        guard !asked.isEmpty else {
            return ["ok": false, "reason": "noNumber", "message": "To není číslo objednávky ani faktury"]
        }
        let shown = asked[0]

        let byInvoice = (try? SQLite.shared.query(
            SQL_BY_INVOICE, [.text(asked[0]), .text(asked[asked.count - 1])]
        )) ?? []
        let byCode = shopOrder(shown)

        guard let primary = byInvoice.first ?? byCode else {
            return [
                "ok": false, "reason": "notInFeed",
                "message": "Faktura ani objednávka \(shown) ve feedu není — \(feedReach())"
            ]
        }

        let code = primary["code"] as? String ?? ""
        guard let order = await open(primary) else {
            return [
                "ok": false, "reason": "noItems",
                "message": "Objednávka \(code) nemá ve feedu položky a e-mail k ní nenajdu"
            ]
        }

        var out: [String: Any] = ["ok": true, "order": order]
        if !byInvoice.isEmpty, let other = byCode, (other["code"] as? String ?? "") != code {
            let otherCode = other["code"] as? String ?? ""
            out["also"] = [
                "orderNumber": otherCode,
                "note": "Číslo \(shown) je faktura objednávky \(code), ale existuje i objednávka \(otherCode)"
            ]
        }
        return out
    }

    /**
     Podklady k objednávce z feedu.

     Feed má přednost, i když k objednávce e-mail existuje, a to kvůli jediné
     věci: **totožnosti**. Odškrtání se drží u čísla, pod kterým se objednávka
     v seznamu vede, a kdyby ji jednou otevřel feed a podruhé mail, byla by to
     dvě různá čísla a odškrtané kusy by se rozešly.
     */
    private static func open(_ row: [String: Any]) async -> [String: Any]? {
        var items: [Any] = []
        if let text = row["items_json"] as? String, let data = text.data(using: .utf8),
           let parsed = try? JSONSerialization.jsonObject(with: data) as? [Any] {
            items = parsed
        }
        if !items.isEmpty { return orderFromFeed(row) }

        let numbers = numberForms(row["code"] as? String ?? "")
        guard !numbers.isEmpty, let found = message(numbers: numbers) else { return nil }
        return await orderFromMail(found)
    }

    /**
     Zpráva s potvrzením dané objednávky — pro tlačítko „Otevřít e-mail".

     Hledá se až ve chvíli, kdy na tlačítko někdo klepne. Pro celý seznam
     předem by to byl průchod schránkou u každé objednávky — přesně to, čeho
     se sestavením z feedu zbavujeme.
     */
    static func mailForOrder(_ orderNumber: String) -> Int? {
        let numbers = numberForms(orderNumber)
        guard !numbers.isEmpty else { return nil }
        return message(numbers: numbers)?.id
    }

    /// Označí celou objednávku jako zabalenou (nebo označení zruší).
    static func setDone(messageId: Int, value: Bool) {
        var state = packed(messageId)
        state.done = value
        state.doneAt = value ? Formats.iso(Date()) : nil
        save(messageId: messageId, state: state)
    }

    /// Vynuluje odškrtání u objednávky.
    static func reset(messageId: Int) {
        if isShopId(messageId) {
            _ = try? SQLite.shared.run(SQL_RESET_SHOP, [.int(Int64(-messageId))])
            return
        }
        _ = try? SQLite.shared.run("DELETE FROM packing WHERE message_pk = ?", [.int(Int64(messageId))])
    }

    // MARK: - Sken

    /**
     Kolik minut zpátky se po sestavení seznamu ještě kouká do pošty.

     Rychlý feed se přegenerovává po pěti minutách, takže objednávka zadaná
     před chvílí v něm ještě není — potvrzovací e-mail ale dorazil hned. Deset
     minut je s rezervou na obojí.
     */
    private static let mailTopupMinutes = 10.0

    /**
     Rozdělané balení z doby, kdy seznam stál na e-mailech.

     Odškrtání se drží u čísla, pod kterým se objednávka vede. Přechodem na
     feed se to číslo změnilo, takže by rozdělaná objednávka vypadala jako
     nezačatá. Projde se to jednou a stav se přenese.
     */
    private static func migrateMailPacking() {
        guard Store.setting("packingFeedMigrated", "") != "1" else { return }

        let rows = (try? SQLite.shared.query("""
            SELECT p.message_pk AS id, p.packed_json, p.counts_json, p.done, p.done_at, c.json
            FROM packing p JOIN order_cache c ON c.message_pk = p.message_pk
            WHERE c.json IS NOT NULL
            """, [])) ?? []

        for row in rows {
            guard let text = row["json"] as? String, let data = text.data(using: .utf8),
                  let card = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let order = shopOrder(card["orderNumber"] as? String ?? "") else { continue }

            let id = shopId(code: order["code"] as? String ?? "",
                            market: order["market"] as? String ?? "")
            // Co je na novém místě rozdělané, se nepřepisuje
            let existing = packed(id)
            if !existing.items.isEmpty || !existing.counts.isEmpty || existing.done { continue }

            var doneAt = SQLite.Value.null
            if let stamp = row["done_at"] as? String { doneAt = .text(stamp) }
            _ = try? SQLite.shared.run(SQL_UPDATE_SHOP, [
                .text(row["packed_json"] as? String ?? "[]"),
                .text(row["counts_json"] as? String ?? "{}"),
                .int(Int64(row["done"] as? Int ?? 0)),
                doneAt,
                .int(Int64(-id))
            ])
        }

        Store.setSetting("packingFeedMigrated", "1")
    }

    /**
     Sestaví seznam objednávek k balení.

     Zdrojem je **feed objednávek**, ne potvrzovací e-maily. Dřív se procházela
     schránka a ke každé zprávě se skládala karta — u týdenního okna to
     znamenalo desítky rozborů a stahování stránek objednávek. Feed má přitom
     všechno potřebné v jedné lokální tabulce, u položek rovnou kód varianty
     a k tomu aktuální stav objednávky.

     Před sestavením se obnoví rychlý feed s posledními 24 h; kompletní exporty
     jen tehdy, když okno sahá dál než den. Objednávku zadanou před chvílí feed
     ještě nemusí mít, takže se nakonec dokouká do pošty za posledních pár minut.
     */
    static func scan(days: Int, force: Bool = false) async -> [String: Any] {
        Bridge.notify("packing:progress",
                      ["done": 0, "total": 0, "label": "Obnovuji feed objednávek…"])
        await OrderFeed.refreshForPacking(days: days, force: force)
        migrateMailPacking()

        let rows = OrderFeed.since(days: days)
        var orders: [[String: Any]] = []
        var statuses: Set<String> = []
        var seen: Set<String> = []

        for (index, order) in rows.enumerated() {
            if index % 25 == 0 {
                Bridge.notify("packing:progress",
                              ["done": index, "total": rows.count, "label": NSNull()])
            }
            guard let items = order["items"] as? [Any], !items.isEmpty else { continue }

            /*
             Bez čísla by objednávka nedostala platné id a odškrtávala by se
             pod nulou — tedy do řádku patřícího zprávě. Takový řádek ve feedu
             nemá co dělat, ale stát se to může.
             */
            let code = order["code"] as? String ?? ""
            guard !code.isEmpty else { continue }
            let market = order["market"] as? String ?? ""
            let id = shopId(code: code, market: market)
            guard id < 0 else { continue }
            let state = packed(id)

            let status = order["status"] as? String ?? ""
            if !status.isEmpty { statuses.insert(status) }
            for form in numberForms(code) { seen.insert(form) }

            let updated = order["updatedAt"] as? String ?? ""
            let created = order["createdAt"] as? String ?? ""
            var out = payload(state)
            out["messageId"] = id
            out["date"] = created
            out["card"] = cardFromFeed(feedRow(order))
            out["source"] = "feed"
            out["shop"] = [
                "code": code,
                "invoice": order["invoice"] as? String ?? "",
                "status": status,
                "at": orNull(updated.isEmpty ? created : updated),
                "final": OrderTrack.isFinalStatus(status)
            ] as [String: Any]
            orders.append(out)
        }

        /*
         Doplnění z pošty. Feed se přegenerovává po pěti minutách, takže
         objednávka zadaná před chvílí v něm chybí — a právě ta je při balení
         ta nejdůležitější.
         */
        Bridge.notify("packing:progress",
                      ["done": rows.count, "total": rows.count, "label": "Kontroluji poštu…"])
        for fresh in await recentFromMail(seen: seen) {
            orders.insert(fresh, at: 0)
            if let card = fresh["card"] as? [String: Any],
               let tracking = card["tracking"] as? [String: Any],
               let status = tracking["status"] as? String, !status.isEmpty {
                statuses.insert(status)
            }
        }

        Bridge.notify("packing:progress",
                      ["done": rows.count, "total": rows.count, "label": NSNull()])

        return [
            "orders": orders,
            "statuses": statuses.sorted { $0.localizedStandardCompare($1) == .orderedAscending },
            "scannedAt": Formats.iso(Date())
        ]
    }

    /// Objednávka z feedu zpátky do tvaru řádku, se kterým pracuje `cardFromFeed`.
    private static func feedRow(_ order: [String: Any]) -> [String: Any] {
        // Objednávka bez adresy nese `NSNull` a ta se na nejvyšší úrovni
        // serializovat nedá — `OrderFeed.jsonText` si tvar ověří předem
        let items = OrderFeed.jsonText(order["items"]) ?? "[]"
        let billing = OrderFeed.jsonText(order["billing"])
        let postal = OrderFeed.jsonText(order["postal"])

        return [
            "code": order["code"] ?? "", "market": order["market"] ?? "cz",
            "currency": order["currency"] ?? "", "items_json": items,
            "status": order["status"] ?? "", "phone": order["phone"] ?? "",
            "name": order["name"] ?? "", "email": order["email"] ?? "",
            "total": order["total"] ?? 0.0, "created_at": order["createdAt"] ?? "",
            "paid_date": order["paidDate"] ?? "", "shipment": order["shipment"] ?? "",
            "payment": order["payment"] ?? "", "tracking": order["tracking"] ?? "",
            "billing_json": billing ?? NSNull(), "postal_json": postal ?? NSNull()
        ]
    }

    /**
     Objednávky z posledních pár minut, které ve feedu ještě nejsou.

     Prochází se jen zprávy z tohohle krátkého okna, takže je to pár řádků, ne
     celá schránka. Karta se skládá z mailu — ta objednávka ve feedu prostě
     ještě není a čekat na něj by znamenalo o ní nevědět.
     */
    private static func recentFromMail(seen: Set<String>) async -> [[String: Any]] {
        let since = Date().addingTimeInterval(-mailTopupMinutes * 60)
        var out: [[String: Any]] = []

        for candidate in orderMails(since: Formats.iso(since)) {
            var card = cached(candidate.id)
            if card == nil {
                card = await Orders.card(dbId: candidate.id)
                Orders.writeCache(candidate.id, card)
            }
            guard let order = card else { continue }
            let number = order["orderNumber"] as? String ?? ""
            if numberForms(number).contains(where: { seen.contains($0) }) { continue }

            var entry = payload(packed(candidate.id))
            entry["messageId"] = candidate.id
            entry["date"] = candidate.date
            entry["card"] = order
            entry["source"] = "mail"
            entry["shop"] = shopState(number) ?? NSNull()
            out.append(entry)
        }
        return out
    }

    // MARK: - Vnitřnosti

    private struct Candidate {
        let id: Int
        let date: String
        let subject: String
    }

    /// Zprávy, které podle hlavičky vypadají na potvrzení objednávky z našeho e-shopu.
    private static func orderMails(since: String, limit: Int = 40) -> [Candidate] {
        let rows = (try? SQLite.shared.query(
            SQL_ORDER_MAILS, [.text(since), .int(Int64(limit))]
        )) ?? []

        return rows.compactMap { row -> Candidate? in
            guard let id = row["id"] as? Int else { return nil }
            let subject = row["subject"] as? String ?? ""
            guard matches(subject, orderSubject), matches(subject, subjectNumber) else { return nil }
            guard Orders.shopMatchesSender(row["from_addr"] as? String ?? "") else { return nil }
            return Candidate(id: id, date: row["date"] as? String ?? "", subject: subject)
        }
    }

    /**
     Uložená karta objednávky.

     Doručené a stornované objednávky se už nezmění — ty se znovu nenačítají
     ani při ručním obnovení, jinak by každý sken zbytečně stahoval historii.
     Výjimkou jsou starší záznamy uložené ještě bez stavu zásilky.
     */
    private static func cached(_ messageId: Int) -> [String: Any]? {
        let row = (try? SQLite.shared.query(
            "SELECT json, at FROM order_cache WHERE message_pk = ?", [.int(Int64(messageId))]
        ))?.first
        guard let row else { return nil }
        guard let text = row["json"] as? String, let data = text.data(using: .utf8),
              let card = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }

        let tracking = card["tracking"] as? [String: Any]
        let live = card["live"] as? [String: Any]
        let status = (tracking?["status"] as? String) ?? (live?["status"] as? String)
        let hasCode = (tracking?["trackingCode"] as? String)?.isEmpty == false
        let hasEvent = (tracking?["shipment"] as? [String: Any]) != nil
        if OrderTrack.isFinalStatus(status), !(hasCode && !hasEvent) { return card }

        guard let stamp = Formats.date(row["at"] as? String),
              Date().timeIntervalSince(stamp) <= cacheTtl else { return nil }
        return card
    }

    private struct State {
        var items: [Int]
        /// Index položky → kolik kusů z ní už je v krabici
        var counts: [String: Int]
        var done: Bool
        var doneAt: String?
    }

    /**
     Objednávka z feedu, ne z pošty.

     Rozhraní pracuje s jedním číslem, ne s dvojicí zpráva/objednávka. Záporné
     číslo proto znamená „tohle je řádek v packing_shop" — jeden pohled na
     hodnotu stačí, aby bylo jasné, odkud se čte a kam se zapisuje.
     */
    private static func isShopId(_ id: Int) -> Bool { id < 0 }

    private static func packed(_ messageId: Int) -> State {
        let sql = isShopId(messageId)
            ? "SELECT packed_json, counts_json, done, done_at FROM packing_shop WHERE id = ?"
            : "SELECT packed_json, counts_json, done, done_at FROM packing WHERE message_pk = ?"
        let row = (try? SQLite.shared.query(
            sql, [.int(Int64(isShopId(messageId) ? -messageId : messageId))]
        ))?.first
        guard let row else { return State(items: [], counts: [:], done: false, doneAt: nil) }

        var items: [Int] = []
        if let text = row["packed_json"] as? String, let data = text.data(using: .utf8),
           let parsed = try? JSONSerialization.jsonObject(with: data) as? [Int] {
            items = parsed
        }
        var counts: [String: Int] = [:]
        if let text = row["counts_json"] as? String, let data = text.data(using: .utf8),
           let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Int] {
            counts = parsed
        }

        /*
         Záznamy z doby před počítáním kusů mají jen seznam odškrtnutých
         položek. Odškrtnutá položka znamenala „celá zabalená", takže se
         dopočítá na plný počet — jinak by po aktualizaci vypadalo rozdělané
         balení jako nezačaté.
         */
        if counts.isEmpty, !items.isEmpty {
            for index in items {
                counts[String(index)] = qtyOf(messageId: messageId, index: index)
            }
        }

        return State(items: items, counts: counts,
                     done: (row["done"] as? Int ?? 0) == 1, doneAt: row["done_at"] as? String)
    }

    private static func save(messageId: Int, state: State) {
        var doneAt = SQLite.Value.null
        if let stamp = state.doneAt { doneAt = .text(stamp) }
        if isShopId(messageId) {
            // Řádek už existuje — zakládá se při otevření objednávky, aby vůbec bylo id
            _ = try? SQLite.shared.run(
                SQL_UPDATE_SHOP,
                [.text(json(state.items)), .text(json(state.counts)),
                 .int(state.done ? 1 : 0), doneAt, .int(Int64(-messageId))]
            )
            return
        }
        _ = try? SQLite.shared.run(
            """
            INSERT INTO packing (message_pk, packed_json, counts_json, done, done_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(message_pk) DO UPDATE SET packed_json = excluded.packed_json,
              counts_json = excluded.counts_json, done = excluded.done, done_at = excluded.done_at
            """,
            [.int(Int64(messageId)), .text(json(state.items)), .text(json(state.counts)),
             .int(state.done ? 1 : 0), doneAt]
        )
    }

    private static func payload(_ state: State) -> [String: Any] {
        [
            "packed": state.items,
            "counts": state.counts,
            "done": state.done,
            "doneAt": state.doneAt ?? NSNull()
        ]
    }

    /// Karta objednávky z uložených podkladů — bez ohledu na stáří, jen kvůli počtům.
    private static func card(_ messageId: Int) -> [String: Any]? {
        if isShopId(messageId) {
            let row = (try? SQLite.shared.query(
                "SELECT code, market FROM packing_shop WHERE id = ?", [.int(Int64(-messageId))]
            ))?.first
            guard let row, let order = shopOrder(row["code"] as? String ?? "",
                                                 market: row["market"] as? String) else { return nil }
            return cardFromFeed(order)
        }
        let row = (try? SQLite.shared.query(
            "SELECT json FROM order_cache WHERE message_pk = ?", [.int(Int64(messageId))]
        ))?.first
        guard let text = row?["json"] as? String, let data = text.data(using: .utf8) else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }

    /// Kolik kusů má být u položky — z uložené karty, s pojistkou na jeden kus.
    private static func qtyOf(messageId: Int, index: Int) -> Int {
        guard let items = card(messageId)?["items"] as? [[String: Any]],
              index >= 0, index < items.count else { return 1 }
        return max(1, items[index]["qty"] as? Int ?? 1)
    }

    /**
     Kód ze štítku do porovnatelné podoby.

     Na vlastních QR je „quentino:PS120CRV", na těch z e-shopu celá adresa
     produktu — a v objednávce je holý kód. Bez tohohle by se nesešly.
     */
    private static func normCode(_ raw: String) -> String {
        var code = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if let range = code.range(of: "^quentino:", options: [.regularExpression, .caseInsensitive]) {
            code = String(code[range.upperBound...])
        }
        if let range = code.range(of: "^.*/p/", options: .regularExpression) {
            code = String(code[range.upperBound...])
        }
        return code.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
    }

    private static func json(_ value: Any) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: value),
              let text = String(data: data, encoding: .utf8) else { return "[]" }
        return text
    }

    private static func matches(_ text: String, _ pattern: String) -> Bool {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else { return false }
        return regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
    }
}
