import Foundation

/**
 Zkratky dopravy a plateb.

 Sesterský modul k `src/main/shorthand.ts` — a schválně stejný, protože
 slovník se mezi zařízeními přenáší jako obyčejné nastavení (`orderShorthand`)
 a obě strany ho musí číst stejně.

 ## Proč to je

 V seznamu pošty **na telefonu** je na odznak u zprávy místo asi pro dvacet
 znaků. Číslo objednávky s částkou se z něj nečtou — číslo si nikdo
 nepamatuje a částka je v e-mailu o řádek níž. Co se z odznaku ráno čte, je
 kam balík jde a jestli je zaplaceno.

 Právě proto je tenhle modul **na telefonu nutný, ne doplňkový**: telefon je
 jediné místo, kde se zkrácený odznak ukazuje. Nastavení slovníku na počítači
 bez něj nastavovalo něco, co se nikde neprojevilo.
 */
enum Shorthand {
    private static let key = "orderShorthand"

    /**
     Slova, podle kterých se pozná, o co jde.

     Není to seznam dopravců, ale seznam **rozlišujících slov**: e-shop název
     kdykoli přejmenuje, ale „dobírka" v něm zůstane dobírkou. Hledá se první
     shoda, takže na pořadí záleží — „kartou" musí být dřív než „online",
     protože „Platba kartou online" je karta, ne cosi online.

     Pořadí i obsah se musí shodovat s verzí na počítači, jinak by tatáž
     objednávka měla na každém zařízení jinou zkratku.
     */
    private static let known: [(pattern: String, short: String)] = [
        // Doprava
        /*
         Hermes je německá dopravní síť, kterou u nás vozí Packeta — ve feedu
         je proto „Hermes PaketShop (Packeta)". Patří před Zásilkovnu, jinak
         by se německé zásilky slily s českými.
         */
        ("hermes", "Hermes"),
        ("zásilkov|zasilkov|packeta", "Zásilkovna"),
        ("balíkovn|balikovn", "Balíkovna"),
        ("česk[áa]\\s*pošt|ceska\\s*post", "ČP"),
        ("\\bppl\\b", "PPL"),
        ("\\bdpd\\b", "DPD"),
        ("\\bgls\\b", "GLS"),
        ("\\bdhl\\b", "DHL"),
        ("\\bups\\b", "UPS"),
        ("\\bwedo\\b", "WeDo"),
        // Zahraniční sítě, které e-shop nabízí na polský a francouzský trh
        ("inpost|paczkomat|poczta", "InPost"),
        ("mondial", "Mondial"),
        ("bartolini", "Bartolini"),
        ("osobn[íi]\\s*odb[ěe]r|vyzvednut[íi]|na\\s*prodejn", "Osobně"),
        ("výdejn|vydejn|pickup|point", "Výdejna"),
        ("kur[ýy]r|dom[ůu]|na\\s*adresu", "Kurýr"),
        // Platba
        ("dob[íi]rk", "Dobírka"),
        ("kart(ou|a|y)|card|comgate|gopay|stripe", "Karta"),
        ("převod|prevod|bankov|transfer|qr\\s*platb", "Převod"),
        ("hotov|cash", "Hotově"),
        ("paypal", "PayPal"),
        ("apple\\s*pay", "Apple Pay"),
        ("google\\s*pay", "Google Pay"),
        ("zdarma|free", "Zdarma")
    ]

    /**
     Odhad zkratky, dokud není ve slovníku.

     Nejdřív známé slovo. Když žádné nesedí, vezme se první slovo názvu — je
     to slabší, ale pořád lepší než celý název přes půl obrazovky, a
     v nastavení je ten odhad vidět, takže se dá opravit.
     */
    static func guess(_ name: String) -> String {
        let text = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return "" }

        for one in known {
            if text.range(of: one.pattern, options: [.regularExpression, .caseInsensitive]) != nil {
                return one.short
            }
        }

        // Závorky a to za pomlčkou je upřesnění, ne jméno — „Zásilkovna (CZ)"
        let head = text.components(separatedBy: CharacterSet(charactersIn: "(–—-"))
            .first?.trimmingCharacters(in: .whitespaces) ?? text
        let first = head.components(separatedBy: .whitespaces).first ?? head
        if first.count > 12 { return String(first.prefix(11)) + "…" }
        return first
    }

    /**
     Do které rodiny název patří.

     Ve feedu není „Zásilkovna", ale konkrétní výdejna — „PPL ParcelBox -
     ABOX BRN Kounicova (Billa)". Takových názvů jsou stovky, jeden na
     pobočku, a na odznaku má stát „PPL", ať je to kterákoli. Rodina je
     proto totéž, co odhad zkratky.
     */
    static func family(_ name: String?) -> String {
        guess(name ?? "")
    }

    /// Klíč do slovníku — druh a rodina, ať se „Zdarma" u dopravy neplete s platbou.
    private static func keyOf(_ kind: String, _ family: String) -> String {
        "\(kind):\(family.trimmingCharacters(in: .whitespaces).lowercased())"
    }

    private struct Entry { let name: String; let short: String }

    /**
     Uložený slovník.

     U každého záznamu se drží i název tak, jak ho někdo napsal — klíč je
     kvůli porovnávání malými písmeny a sám o sobě by z „Balíkovna" udělal
     „balíkovna". Starší zápisy jsou holý text a čtou se dál.
     */
    private static func saved() -> [String: Entry] {
        let text = Store.setting(key, "{}") ?? "{}"
        guard let data = text.data(using: .utf8),
              let raw = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return [:] }

        var out: [String: Entry] = [:]
        for (mapKey, value) in raw {
            if let short = value as? String {
                let name = String(mapKey.drop(while: { $0 != ":" }).dropFirst())
                out[mapKey] = Entry(name: name, short: short)
            } else if let one = value as? [String: Any] {
                out[mapKey] = Entry(name: one["name"] as? String ?? "", short: one["short"] as? String ?? "")
            }
        }
        return out
    }

    private static func store(_ entries: [String: Entry]) {
        var raw: [String: Any] = [:]
        for (mapKey, entry) in entries {
            raw[mapKey] = ["name": entry.name, "short": entry.short]
        }
        guard JSONSerialization.isValidJSONObject(raw),
              let data = try? JSONSerialization.data(withJSONObject: raw),
              let text = String(data: data, encoding: .utf8) else { return }
        Store.setSetting(key, text)
    }

    /// Co se ukáže na odznaku.
    static func shortFor(_ kind: String, _ name: String?) -> String {
        let group = family(name)
        guard !group.isEmpty else { return "" }
        let mine = saved()[keyOf(kind, group)]?.short.trimmingCharacters(in: .whitespaces) ?? ""
        return mine.isEmpty ? group : mine
    }

    /**
     Co všechno se vyskytlo — podklad pro nastavení.

     Sbírá se ze tří míst: z feedu objednávek, z rozebraných potvrzovacích
     e-mailů a ze slovníku samotného. Feed sám nestačí — sloupce se plní
     teprve od verze, která je umí číst, takže u dřív stažených objednávek
     jsou prázdné.
     */
    static func rows() -> [[String: Any]] {
        let mine = saved()
        var groups: [String: (kind: String, family: String, count: Int, names: [String: Int])] = [:]

        func add(_ kind: String, _ raw: Any?, _ by: Int = 1) {
            let name = (raw as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !name.isEmpty else { return }
            let group = family(name)
            guard !group.isEmpty else { return }

            let mapKey = keyOf(kind, group)
            var found = groups[mapKey] ?? (kind, group, 0, [:])
            found.count += by
            found.names[name] = (found.names[name] ?? 0) + by
            groups[mapKey] = found
        }

        // 1) Feed objednávek
        for kind in ["shipment", "payment"] {
            let list = (try? SQLite.shared.query(
                "SELECT \(kind) AS name, COUNT(*) AS cnt FROM shop_orders "
                + "WHERE \(kind) IS NOT NULL AND \(kind) != '' GROUP BY \(kind)"
            )) ?? []
            for row in list { add(kind, row["name"], row["cnt"] as? Int ?? 1) }
        }

        // 2) Rozebrané potvrzovací e-maily
        let cached = (try? SQLite.shared.query(
            "SELECT json FROM order_cache WHERE json IS NOT NULL ORDER BY at DESC LIMIT 500"
        )) ?? []
        for row in cached {
            guard let text = row["json"] as? String, let data = text.data(using: .utf8),
                  let card = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { continue }
            add("shipment", card["shipmentName"])
            add("payment", card["paymentName"])
        }

        // 3) Co je ve slovníku — ručně napsaná zkratka nesmí zmizet
        for (mapKey, entry) in mine {
            guard let cut = mapKey.firstIndex(of: ":") else { continue }
            let kind = String(mapKey[mapKey.startIndex..<cut])
            guard kind == "shipment" || kind == "payment" else { continue }
            if groups[mapKey] == nil {
                let fallback = String(mapKey[mapKey.index(after: cut)...])
                groups[mapKey] = (kind, entry.name.isEmpty ? fallback : entry.name, 0, [:])
            }
        }

        let sorted = groups.values.sorted { left, right in
            if left.kind != right.kind { return left.kind == "shipment" }
            if left.count != right.count { return left.count > right.count }
            return left.family.localizedCaseInsensitiveCompare(right.family) == .orderedAscending
        }
        return sorted.map { one in
            /*
             Ukázka názvů, které se do rodiny slily. Bez ní se nedá poznat,
             jestli se pod „PPL" schovaly jen parcelshopy, nebo omylem
             i něco cizího — a slučování je tady to jediné, co se může splést.
             */
            let samples = one.names.sorted { $0.value > $1.value }.prefix(3).map { $0.key }
            return [
                "kind": one.kind,
                "name": one.family,
                "short": mine[keyOf(one.kind, one.family)]?.short
                    .trimmingCharacters(in: .whitespaces) ?? "",
                "guess": one.family,
                "count": one.count,
                "distinct": one.names.count,
                "samples": samples
            ]
        }
    }

    /// Kolik objednávek se prošlo a kolik z nich dopravu vůbec mělo.
    static func scope() -> [String: Any] {
        func count(_ sql: String) -> Int {
            ((try? SQLite.shared.query(sql))?.first?["n"] as? Int) ?? 0
        }
        return [
            "orders": count("SELECT COUNT(*) AS n FROM shop_orders"),
            "withShipment": count("SELECT COUNT(*) AS n FROM shop_orders WHERE shipment != ''"),
            "withPayment": count("SELECT COUNT(*) AS n FROM shop_orders WHERE payment != ''")
        ]
    }

    /// Uloží zkratku; prázdná ji ze slovníku vyhodí a vrátí se k odhadu.
    static func save(kind rawKind: String, name family: String, short: String) -> [String: Any] {
        let kind = rawKind == "payment" ? "payment" : "shipment"
        let clean = family.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return view() }

        var mine = saved()
        let value = short.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.isEmpty { mine.removeValue(forKey: keyOf(kind, clean)) }
        else { mine[keyOf(kind, clean)] = Entry(name: clean, short: value) }
        store(mine)
        return view()
    }

    /// Slovník i s tím, z čeho se sestavil — prázdný seznam se má umět vysvětlit.
    static func view() -> [String: Any] {
        ["rows": rows(), "scope": scope()]
    }

    /**
     Zkratky rovnou k číslům objednávek — bez čekání na síť.

     Odznak v seznamu pošty se skládá ze dvou zdrojů a každý je jinak rychlý.
     Celý odznak rozebere e-mail, doptá se e-shopu na stav a dopravce na
     zásilku; než se to vrátí, svítí v řádku jen to, co jde vyčíst
     z předmětu — číslo a částka. Na počítači to nevadí, tam se číslo ukazuje
     tak jako tak. **Na telefonu to ale znamená, že se místo dopravy a platby
     kouká na číslo s cenou**, u části řádků klidně minuty: dotazy jdou po
     dvou a každý čeká na síť.

     Tohle je proto krátká cesta: číslo z předmětu → řádek ve feedu →
     zkratky. Jeden dotaz do databáze, žádná síť.

     Číslo z předmětu bývá číslo objednávky, u faktur ale číslo faktury.
     Hledá se obojí a nikdy se jedno nezamění za druhé: napřed objednávka,
     teprve když není, faktura.
     */
    static func forCodes(_ codes: [String]) -> [String: Any] {
        var out: [String: Any] = [:]
        var asked: [String] = []
        for one in codes {
            let clean = one.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "#", with: "")
            if !clean.isEmpty, !asked.contains(clean) { asked.append(clean) }
            if asked.count >= 200 { break }
        }
        guard !asked.isEmpty else { return out }

        for one in asked {
            // Vedoucí nuly píše e-shop v předmětu, ve feedu bývají oříznuté
            let bare = String(one.drop(while: { $0 == "0" }))
            let trimmed = bare.isEmpty ? one : bare
            var rows = (try? SQLite.shared.query(
                "SELECT code, shipment, payment FROM shop_orders "
                + "WHERE code = ? OR code = ? ORDER BY created_at DESC LIMIT 1",
                [.text(one), .text(trimmed)]
            )) ?? []
            if rows.isEmpty {
                rows = (try? SQLite.shared.query(
                    "SELECT code, shipment, payment FROM shop_orders "
                    + "WHERE invoice != '' AND (invoice = ? OR ltrim(invoice, '0') = ?) "
                    + "ORDER BY created_at DESC LIMIT 1",
                    [.text(one), .text(trimmed)]
                )) ?? []
            }
            guard let row = rows.first else { continue }

            let shipment = shortFor("shipment", row["shipment"] as? String)
            let payment = shortFor("payment", row["payment"] as? String)
            // Objednávka bez dopravy i platby by odznak jen připravila o číslo
            if shipment.isEmpty && payment.isEmpty { continue }

            /*
             Prázdná zkratka je „nemám co ukázat", ne prázdný text. `NSNull`
             se ale s textem v jednom výrazu neporovná, proto se to skládá
             po krocích — v ternárním operátoru se o tom Swift pohádá.
             */
            var shipmentShort: Any = NSNull()
            if !shipment.isEmpty { shipmentShort = shipment }
            var paymentShort: Any = NSNull()
            if !payment.isEmpty { paymentShort = payment }

            var found: [String: Any] = [:]
            found["code"] = row["code"] as? String ?? one
            found["shipmentShort"] = shipmentShort
            found["paymentShort"] = paymentShort
            out[one] = found
        }
        return out
    }
}
