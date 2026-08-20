import Foundation
import UIKit
import WebKit

/**
 Živý stav objednávky a zásilky bez Upgates API.

 Zdroje jsou dva veřejné a server-renderované:
  1) stránka „historie objednávky", jejíž odkaz je přímo v potvrzovacím mailu
     — dá stav objednávky, datum zaplacení, telefon zákazníka a odkaz na dopravce,
  2) stránka dopravce podle tracking kódu — dá poslední stav zásilky.

 Obojí se čte přes převod HTML na text a hledání dvojic „štítek: hodnota",
 ne přes konkrétní značky. Redesign šablony to tedy většinou přežije a když ne,
 funkce vrátí `nil` a karta se prostě zobrazí bez živých dat.

 Proti počítači je jediný podstatný rozdíl v tom, čím se stránka načte:
 tam skryté okno Electronu, tady skryté `WKWebView` (`HeadlessPage`). Dopravci,
 kteří výpis vypisují rovnou do HTML, se stahují obyčejným `Http.request` —
 je to o řád levnější a na telefonu i o poznání rychlejší.

 Výstup je slovník se stejnými klíči, jaké má na počítači typ `OrderTracking`,
 aby rozhraní nepoznalo rozdíl (`NSNull()` tam, kde TypeScript má `null`).
 */
enum OrderTrack {

    // MARK: - Konstanty

    /// Dopravci servírují mobilním prohlížečům jiné (a často osekané) stránky,
    /// proto se hlásíme jako desktopový Chrome — stejně jako stolní verze.
    static let userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
        + " (KHTML, like Gecko) Chrome/125.0 Safari/537.36"

    /// Stažení statické stránky. Delší čekání nemá smysl: karta se ukazuje hned
    /// a stav zásilky se do ní doplní, až doběhne.
    static let httpTimeout: TimeInterval = 12

    /// Strop pro skryté webview. Stránky dopravců jsou plné měřicích skriptů
    /// a rámů, které nikdy nedoběhnou — čeká se proto na obsah, ne na „hotovo",
    /// a po dvaceti sekundách se to vzdá.
    static let renderLimit: TimeInterval = 20

    private static let pageTtl: TimeInterval = 5 * 60
    /// U doručených, stornovaných a vrácených objednávek se stav už nemění
    private static let pageTtlFinal: TimeInterval = 30 * 86_400
    private static let shipTtl: TimeInterval = 10 * 60
    /// Neúspěch se drží krátce, ať „Zkusit znovu" opravdu zkusí znovu
    private static let missTtl: TimeInterval = 60

    /// Nadpis, za kterým začíná výpis událostí — ať se nechytí datum z patičky
    /// nebo z reklamy. Slouží zároveň jako značka, na kterou čeká skryté webview.
    static let historyWords = "cesta z[áa]silk|historie z[áa]silk|stav z[áa]silk|stav a pohyb|priebeh"
        + "|tracking history|shipment history|pohyb z[áa]silk|datum a [čc]as|d[áa]tum a [čc]as"
        + "|sledov[áa]n[ií] z[áa]silk|informace o z[áa]silce|ud[áa]losti|pr[ůu]b[ěe]h"

    /// Datum ve tvaru „19. 8. 2026" nebo „19.8.2026 14:05"
    private static let dateBody = #"(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4})(?:\s+(\d{1,2})[:.](\d{2}))?"#

    /// Každý dopravce si pojmenovává parametr po svém: Zásilkovna `id`,
    /// PPL `idSearch`, Česká pošta `parcelNumbers`… bere se první, který v odkazu je.
    private static let codeParams = [
        "id", "idSearch", "shipmentId", "parcelNumbers", "parcelNumber", "match", "tracking-id", "code", "cislo"
    ]

    // MARK: - Dopravci

    struct Carrier {
        /// Shodné s typem `CarrierId` na počítači
        let id: String
        let name: String
        /// Podle názvu dopravy v objednávce
        let match: String
        /// Podle domény odkazu na sledování
        let host: String
        /// Odkaz na sledování; `{code}` se nahradí kódem bez mezer
        let template: String
        /// Vypisuje dopravce stav rovnou do HTML, nebo ho dotahuje až JavaScriptem?
        let needsJs: Bool

        /// Kód se u některých dopravců píše s mezerami, do URL patří bez nich
        func normalize(_ code: String) -> String {
            code.components(separatedBy: .whitespacesAndNewlines).joined()
        }

        func url(code: String) -> String {
            template.replacingOccurrences(of: "{code}", with: Http.escaped(normalize(code)))
        }
    }

    static let carriers: [Carrier] = [
        Carrier(
            id: "packeta", name: "Zásilkovna",
            match: #"z[áa]silkovn|packeta|z-?box"#, host: #"packeta\.com|zasilkovna\.cz"#,
            template: "https://tracking.packeta.com/cs/tracking/search?id={code}",
            needsJs: false
        ),
        Carrier(
            id: "ppl", name: "PPL",
            match: #"\bppl\b|parcelshop|parcelbox"#, host: #"ppl\.cz|ppl\.sk"#,
            // Starý odkaz main2.aspx?cls=Package&idSearch= e-shop pořád používá,
            // sám se přesměruje sem
            template: "https://www.ppl.cz/vyhledat-zasilku?shipmentId={code}",
            needsJs: true
        ),
        Carrier(
            id: "cpost", name: "Česká pošta",
            match: #"česk[áé] po[šs]t|bal[íi]kovn|post[aá] ?online|balik(do|na)|npb"#,
            host: #"postaonline\.cz|ceskaposta\.cz|cpost\.cz|balikovna\.cz"#,
            template: "https://www.postaonline.cz/trackandtrace/-/zasilka/cislo?parcelNumbers={code}",
            needsJs: false
        ),
        Carrier(
            id: "dpd", name: "DPD",
            match: #"\bdpd\b"#, host: #"dpd(group)?\.(cz|com|sk)"#,
            template: "https://www.dpdgroup.com/cz/mydpd/my-parcels/incoming?parcelNumber={code}",
            needsJs: true
        ),
        Carrier(
            id: "gls", name: "GLS",
            match: #"\bgls\b"#, host: #"gls-group\.(eu|com)"#,
            template: "https://gls-group.eu/CZ/cs/sledovani-zasilek?match={code}",
            needsJs: true
        ),
        Carrier(
            id: "dhl", name: "DHL",
            match: #"\bdhl\b"#, host: #"dhl\.com"#,
            template: "https://www.dhl.com/cz-cs/home/tracking/tracking-parcel.html?tracking-id={code}",
            needsJs: true
        ),
        Carrier(
            id: "wedo", name: "WEDO",
            match: #"wedo|ulo[žz]enk"#, host: #"wedo\.cz|ulozenka\.cz"#,
            template: "https://www.wedo.cz/sledovani-zasilky?code={code}",
            needsJs: true
        )
    ]

    /// Určí dopravce podle názvu dopravy, odkazu na tracking nebo tvaru kódu.
    static func detectCarrier(shipmentName: String?, trackingUrl: String?, code: String?) -> Carrier? {
        if let trackingUrl, let host = URL(string: trackingUrl)?.host {
            if let byHost = carriers.first(where: { TrackRx($0.host).test(host) }) { return byHost }
        }
        if let shipmentName, !shipmentName.isEmpty {
            if let byName = carriers.first(where: { TrackRx($0.match).test(shipmentName) }) { return byName }
        }
        // Zásilkovna má charakteristické „Z 450 7169 485"
        if let code, TrackRx(#"^z\s?\d[\d\s]{7,}$"#).test(trimmedText(code)) { return carriers.first }
        return nil
    }

    /// Konečný stav objednávky — nemá smysl ho znovu ověřovat ani u e-shopu, ani u dopravce.
    static func isFinalStatus(_ status: String?) -> Bool {
        guard let status, !status.isEmpty else { return false }
        return TrackRx(
            #"doru[čc]en|vyzvednut|dokon[čc]en|uzav[řr]en|storn|zru[šs]en|vr[áa]cen|odstoup|reklamac"#
            + #"|complete|delivered|cancel|refund"#
        ).test(status)
    }

    // MARK: - Stránka historie objednávky

    /**
     Přečte veřejnou stránku „historie objednávky" (odkaz je v každém
     potvrzovacím mailu). Vrací stav, zaplacení, telefon a odkaz na sledování
     zásilky ve tvaru `OrderTracking`.
     */
    static func readOrderPage(_ historyUrl: String) async -> [String: Any]? {
        if let hit = await TrackCache.shared.page(historyUrl) {
            let cached = decodeJson(hit.json)
            let ttl = isFinalStatus(cached?["status"] as? String) ? pageTtlFinal : pageTtl
            if Date().timeIntervalSince(hit.at) < ttl { return cached }
        }

        guard let html = await fetchText(historyUrl) else {
            await TrackCache.shared.setPage(historyUrl, nil)
            return nil
        }
        let lines = textLines(html: html)

        let status = labelValue(lines, ["Stav objednávky", "Stav objednávok", "Order status", "Status objednávky"])
        let createdAt = labelValue(lines, ["Vytvořeno", "Vytvorené", "Created"])
        let paidDate = labelValue(lines, ["Zaplaceno", "Zaplatené", "Paid"])
        let phone = labelValue(lines, ["Telefon", "Telefón", "Phone"])

        // Odkaz na dopravce — v šabloně stojí u štítku „Sledování zásilky".
        // Hostitelské vzory se překládají jednou, ne pro každý odkaz na stránce.
        let hostRules = carriers.map { TrackRx($0.host) }
        let hrefs = TrackRx(#"href="([^"]+)""#).matches(html, group: 1).map { decodeEntities($0) }
        let carrierLink = hrefs.first { href in hostRules.contains { $0.test(href) } }

        var trackingUrl: String?
        var trackingCode: String?
        if let carrierLink {
            // Odkaz může být i relativní — základem je pak stránka objednávky
            if let resolved = URL(string: carrierLink, relativeTo: URL(string: historyUrl)) {
                trackingUrl = resolved.absoluteString
                let items = URLComponents(url: resolved, resolvingAgainstBaseURL: true)?.queryItems ?? []
                let digit = TrackRx(#"\d"#)
                for name in codeParams {
                    guard let value = items.first(where: { $0.name == name })?.value, digit.test(value) else { continue }
                    trackingCode = value
                    break
                }
                if trackingCode == nil {
                    let tail = TrackRx(#"/([A-Z]{0,2}\d[\d\s]{6,}[A-Z]?)/?$"#).match(resolved.path)
                    if let tail, tail.count > 1 { trackingCode = tail[1] }
                }
            } else {
                trackingUrl = carrierLink // neparsovatelný odkaz aspoň nabídneme k otevření
            }
        }

        var shipmentName = labelValue(lines, ["Sledování zásilky", "Sledovanie zásielky", "Shipment tracking"])
        if let name = shipmentName, TrackRx(#"^https?:"#).test(name) || name.count > 60 { shipmentName = nil }

        // Slovník se plní po klíčích, ne jedním výrazem: větve „hodnota / null"
        // mají různý typ a Swift by je do jednoho ternárního operátoru nedal.
        var data = emptyTracking(source: "page")
        if let status, status.count < 60 { data["status"] = status }
        if let createdAt { data["createdAt"] = createdAt }
        if let paidDate, !TrackRx(#"^ne"#).test(paidDate) { data["paidDate"] = paidDate }
        if let phone, TrackRx(#"\d{6,}"#).test(phone) { data["customerPhone"] = phone }
        if let trackingUrl { data["trackingUrl"] = trackingUrl }

        var code: String?
        if let trackingCode {
            let cleaned = trimmedText(trackingCode)
            if !cleaned.isEmpty {
                code = cleaned
                data["trackingCode"] = cleaned
            }
        }

        if let carrier = detectCarrier(shipmentName: shipmentName, trackingUrl: trackingUrl, code: code) {
            data["carrierId"] = carrier.id
            // E-shop pojmenovává dopravu přesněji než my („PPL ParcelBox",
            // „Zásilkovna Výdejní místo")
            if let shipmentName {
                data["carrierName"] = shipmentName
            } else {
                data["carrierName"] = carrier.name
            }
            // Odkaz z e-shopu bývá zastaralý nebo obsahuje kód s mezerami —
            // přestavíme ho načisto
            if let code { data["trackingUrl"] = carrier.url(code: code) }
        }

        await TrackCache.shared.setPage(historyUrl, encodeJson(data))
        return data
    }

    // MARK: - Stránka dopravce

    /**
     Poslední záznam z cesty zásilky (`ShipmentEvent`).

     Dopravci se liší úplně ve všem: Zásilkovna dává popis nad datum a nejnovější
     nahoru, PPL má tabulku „Datum a čas | Stav zásilky" a nejnovější dole. Proto
     se posbírají všechny dvojice datum + popis a vybere se ta s nejnovějším časem —
     na pořadí ani směru pak nezáleží.

     `useRenderer` znamená načtení ve skrytém webview; bez něj se stahuje jen
     holé HTML.
     */
    static func readShipmentStatus(
        carrierId: String,
        code: String,
        url: String,
        useRenderer: Bool = false,
        force: Bool = false
    ) async -> [String: Any]? {
        // Vykreslený a nevykreslený pokus mají vlastní cache — jinak by prázdný
        // výsledek z holého HTML zablokoval i pozdější načtení přes webview
        let key = "\(carrierId):\(code):\(useRenderer ? "js" : "raw")"
        if !force, let hit = await TrackCache.shared.ship(key) {
            let ttl = hit.json == nil ? missTtl : shipTtl
            if Date().timeIntervalSince(hit.at) < ttl { return decodeJson(hit.json) }
        }

        var page: String?
        if useRenderer {
            page = await HeadlessPage.text(url: url, marker: historyWords, limit: renderLimit)
        } else {
            page = await fetchText(url)
        }
        guard let page else {
            await TrackCache.shared.setShip(key, nil)
            return nil
        }

        // Ze skrytého webview chodí rovnou `innerText`, ze stažení celé HTML.
        // Převod na řádky zvládá obojí: v textu se jen nemá co odstraňovat.
        let lines = textLines(html: page)
        let rules = LineRules()

        // Když stránka má nadpis výpisu, bereme jen to za ním — jinak by se chytla
        // data z otevírací doby pobočky nebo z reklamních bannerů.
        let start = lines.firstIndex(where: { rules.historyHead.test($0) }) ?? 0
        // Dopravci občas vypisují i plánované doručení; víc než den a půl dopředu
        // už ale bude překlep nebo datum z patičky
        let horizon = Date().addingTimeInterval(36 * 3600)

        // Popis stojí buď nad datem (Zásilkovna: „popis / datum"), nebo pod ním
        // (PPL: tabulka „datum | stav"). U jednotlivé události to nejde rozlišit,
        // protože oba sousedi bývají texty — pořadí se proto určí jednou za stránku
        // podle toho, co ve výpisu přijde první.
        var descFirst = true
        for index in start..<lines.count {
            let line = lines[index]
            if rules.historyHead.test(line) { continue }
            if parseDate(line, rules) != nil { descFirst = false; break }
            if isDescription(line, rules) { descFirst = true; break }
        }

        let lineAt: (Int) -> String? = { index in
            index >= 0 && index < lines.count ? lines[index] : nil
        }

        var events: [(at: Date, event: [String: Any])] = []
        for index in start..<lines.count {
            let line = lines[index]

            if let stamp = parseDate(line, rules) {
                let near = lineAt(descFirst ? index - 1 : index + 1)
                let far = lineAt(descFirst ? index + 1 : index - 1)
                var desc: String?
                if let near, isDescription(near, rules) {
                    desc = near
                } else if let far, isDescription(far, rules) {
                    desc = far
                }
                if let desc, stamp <= horizon {
                    events.append((at: stamp, event: ["description": desc, "at": line]))
                }
                continue
            }

            // Popis i datum na jednom řádku („Doručeno 19. 8. 2026 14:05")
            guard let tail = rules.dateTail.match(line), tail.count > 2,
                  let descRaw = tail[1], let dateRaw = tail[2] else { continue }
            let desc = trimmedText(descRaw)
            guard isDescription(desc, rules), let stamp = parseDate(dateRaw, rules), stamp <= horizon else { continue }
            events.append((at: stamp, event: ["description": desc, "at": dateRaw]))
        }

        guard var event = events.max(by: { $0.at < $1.at })?.event else {
            await TrackCache.shared.setShip(key, nil)
            return nil
        }

        // Zásilkovna má nad výpisem ještě souhrnnou fázi („2. Zásilka je na cestě").
        // Hledá se dřív než zařazení, ať se dá do klasifikace poslat i ona —
        // souhrn bývá jednoznačnější než hláška z depa.
        if let stage = lines.first(where: { rules.stage.test($0) && !rules.dateLine.test($0) }) {
            event["stage"] = rules.stageNumber.replacing(stage, with: "")
        }

        // Zařazení do fáze kvůli barevnému odlišení. Pravidla a naučené hlášky
        // jsou zadarmo, AI se ptáme jen na hlášku, kterou ještě nikdo neviděl.
        let description = event["description"] as? String ?? ""
        let stage = event["stage"] as? String ?? ""
        event["phase"] = await ShipPhase.classify(trimmedText("\(stage) \(description)"))

        await TrackCache.shared.setShip(key, encodeJson(event))
        return event
    }

    // MARK: - Dohromady

    /// Co je o zásilce známo i bez stránky historie (z Upgates API).
    struct Fallback {
        let shipmentName: String?
        let trackingCode: String?
        let trackingUrl: String?

        init(shipmentName: String? = nil, trackingCode: String? = nil, trackingUrl: String? = nil) {
            self.shipmentName = shipmentName
            self.trackingCode = trackingCode
            self.trackingUrl = trackingUrl
        }
    }

    /**
     Kompletní živá data: stránka objednávky + poslední stav zásilky.

     `withRendered = false` je první fáze (karta se ukáže hned), `true` je druhá
     fáze se skrytým webview — ta se dělá u každého dopravce, ne jen u těch
     označených: i stránka, která část obsahu vypisuje rovnou, může výpis zásilky
     dokreslovat až doběhem skriptů.
     */
    static func liveTracking(
        historyUrl: String?,
        fallback: Fallback,
        withRendered: Bool = false,
        force: Bool = false
    ) async -> [String: Any]? {
        var data: [String: Any]?
        if let historyUrl, !historyUrl.isEmpty {
            data = await readOrderPage(historyUrl)
        }

        // Bez stránky historie (nebo když nic nevrátila) zkusíme aspoň dopravce
        // z toho, co je známo z API
        if data == nil, fallback.trackingCode != nil || fallback.trackingUrl != nil {
            let carrier = detectCarrier(
                shipmentName: fallback.shipmentName,
                trackingUrl: fallback.trackingUrl,
                code: fallback.trackingCode
            )
            var built = emptyTracking(source: "api")
            if let carrier {
                built["carrierId"] = carrier.id
                built["carrierName"] = carrier.name
            }
            if let code = fallback.trackingCode, !code.isEmpty { built["trackingCode"] = code }
            if let url = fallback.trackingUrl, !url.isEmpty {
                built["trackingUrl"] = url
            } else if let carrier, let code = fallback.trackingCode, !code.isEmpty {
                built["trackingUrl"] = carrier.url(code: code)
            }
            data = built
        }

        guard var result = data else { return nil }
        guard let carrierId = result["carrierId"] as? String,
              let carrier = carriers.first(where: { $0.id == carrierId }),
              let code = result["trackingCode"] as? String, !code.isEmpty,
              let url = result["trackingUrl"] as? String, !url.isEmpty else { return result }

        if withRendered {
            let shipment = await readShipmentStatus(
                carrierId: carrier.id, code: code, url: url, useRenderer: true, force: force
            )
            if let shipment {
                result["shipment"] = shipment
            } else {
                result["shipmentError"] = "Stránku dopravce se nepodařilo přečíst"
            }
            return result
        }

        // První fáze: jen rychlé stažení, a to jen tam, kde má smysl
        if !carrier.needsJs {
            if let shipment = await readShipmentStatus(carrierId: carrier.id, code: code, url: url) {
                result["shipment"] = shipment
            }
        }
        return result
    }

    /// Vyprázdní cache — po ručním obnovení karty.
    static func clearCache() async {
        await TrackCache.shared.clear()
    }

    // MARK: - HTML → řádky textu

    /// Blokové značky se lámou na řádky, inline (span, strong, a) zůstávají v řádku.
    static func textLines(html: String) -> [String] {
        var text = html
        text = TrackRx(#"<script[\s\S]*?</script>"#).replacing(text, with: " ")
        text = TrackRx(#"<style[\s\S]*?</style>"#).replacing(text, with: " ")
        text = TrackRx(#"<\s*br\s*/?>"#).replacing(text, with: "\n")
        text = TrackRx(#"</\s*(p|div|tr|td|th|h[1-6]|li|section|article|dt|dd|table)\s*>"#).replacing(text, with: "\n")
        text = TrackRx("<[^>]+>").replacing(text, with: " ")
        text = decodeEntities(text)
        // Pevná mezera z HTML by jinak zůstala v textu a rozbila porovnávání štítků
        text = text.replacingOccurrences(of: "\u{00a0}", with: " ")

        let spaces = TrackRx(#"[ \t]+"#)
        return text.components(separatedBy: "\n")
            .map { line -> String in trimmedText(spaces.replacing(line, with: " ")) }
            .filter { !$0.isEmpty }
    }

    static func decodeEntities(_ text: String) -> String {
        guard text.contains("&") else { return text }
        var out = text
        out = TrackRx(#"&#x([0-9a-f]+);"#).rewrite(out) { hex in
            guard let value = UInt32(hex, radix: 16), let scalar = UnicodeScalar(value) else { return nil }
            return String(Character(scalar))
        }
        out = TrackRx(#"&#(\d+);"#).rewrite(out) { digits in
            guard let value = UInt32(digits), let scalar = UnicodeScalar(value) else { return nil }
            return String(Character(scalar))
        }
        // Jmenné entity jen ty, které v šablonách e-shopů a dopravců opravdu jsou;
        // neznámá entita se nechává, jak je (lepší než ji ztratit)
        let named = ["amp": "&", "lt": "<", "gt": ">", "quot": "\"", "apos": "'", "nbsp": " "]
        return TrackRx(#"&([a-z]+);"#).rewrite(out) { name in named[name.lowercased()] }
    }

    /// Najde hodnotu k štítku — buď za dvojtečkou na stejném řádku, nebo na následujícím.
    static func labelValue(_ lines: [String], _ labels: [String]) -> String? {
        let whitespace = TrackRx(#"\s+"#)
        let colon = TrackRx(#"^\s*:\s*"#)
        // Následující řádek nesmí být zase štítek
        let labelOnly = TrackRx(#"^[^:]{1,28}:$"#)
        let normalize: (String) -> String = { value in
            trimmedText(whitespace.replacing(value.lowercased(), with: " "))
        }
        let keys = labels.map { normalize($0) }

        for (index, line) in lines.enumerated() {
            let normalized = normalize(line)
            for (position, key) in keys.enumerated() {
                guard normalized.hasPrefix(key) else { continue }
                let after = trimmedText(colon.replacing(String(line.dropFirst(min(labels[position].count, line.count))), with: ""))
                if !after.isEmpty { return after }
                guard index + 1 < lines.count else { continue }
                let next = trimmedText(lines[index + 1])
                if !next.isEmpty, !labelOnly.test(next) { return next }
            }
        }
        return nil
    }

    // MARK: - Pomocné

    /// Prázdný `OrderTracking` — všechny klíče, které rozhraní čeká.
    private static func emptyTracking(source: String) -> [String: Any] {
        // Typ se píše natvrdo: slovník míchá texty a `NSNull()`, takže by se
        // jinak odvodil jako `[String: NSObject]` a překlad by si stěžoval
        let empty: [String: Any] = [
            "source": source,
            "status": NSNull(),
            "createdAt": NSNull(),
            "paidDate": NSNull(),
            "customerPhone": NSNull(),
            "carrierId": NSNull(),
            "carrierName": NSNull(),
            "trackingCode": NSNull(),
            "trackingUrl": NSNull(),
            "shipment": NSNull(),
            "shipmentError": NSNull()
        ]
        return empty
    }

    private static func fetchText(_ url: String) async -> String? {
        do {
            let data = try await Http.request(
                url,
                headers: ["User-Agent": userAgent, "Accept-Language": "cs,sk;q=0.9,en;q=0.8"],
                timeout: httpTimeout
            )
            if let text = String(data: data, encoding: .utf8) { return text }
            // Starší e-shopy posílají stránky ve středoevropském kódování
            return String(data: data, encoding: .isoLatin2)
        } catch {
            return nil // nedostupná stránka není chyba, karta se ukáže bez živých dat
        }
    }

    /// Vzory pro čtení výpisu; překládají se jednou za stránku, ne za řádek.
    /// Vlastnosti jsou `fileprivate` schválně: typ `TrackRx` je viditelný jen
    /// v tomhle souboru a širší přístup by překlad neprošel.
    private struct LineRules {
        fileprivate let dateLine = TrackRx("^" + OrderTrack.dateBody + "$")
        fileprivate let dateTail = TrackRx("^(.*?)\\s+(" + OrderTrack.dateBody + ")$")
        fileprivate let historyHead = TrackRx("^(" + OrderTrack.historyWords + ")")
        fileprivate let numbersOnly = TrackRx(#"^[\d\s.,:/-]+$"#)
        fileprivate let clockOnly = TrackRx(#"^\d{1,2}[:.]\d{2}$"#)
        fileprivate let word = TrackRx(#"\p{L}{3,}"#)
        fileprivate let stage = TrackRx(#"^\d\.\s+\S.{4,60}$"#)
        fileprivate let stageNumber = TrackRx(#"^\d\.\s*"#)
    }

    /// Datum se čte v místním čase, stejně jako na počítači — dopravci píšou
    /// časy tak, jak je vidí zákazník.
    private static func parseDate(_ text: String, _ rules: LineRules) -> Date? {
        guard let groups = rules.dateLine.match(text), groups.count > 3,
              let dayText = groups[1], let day = Int(dayText),
              let monthText = groups[2], let month = Int(monthText),
              let yearText = groups[3], let year = Int(yearText) else { return nil }

        var parts = DateComponents()
        parts.year = year
        parts.month = month
        parts.day = day
        // Čas dopravce uvádět nemusí („19. 8. 2026"); pak je to půlnoc
        parts.hour = 0
        parts.minute = 0
        if groups.count > 5, let hourText = groups[4], let hour = Int(hourText),
           let minuteText = groups[5], let minute = Int(minuteText) {
            parts.hour = hour
            parts.minute = minute
        }
        return Calendar.current.date(from: parts)
    }

    /**
     Popis stavu, ne nadpis tabulky ani samotné datum.

     Délka musí být benevolentní — dopravci hlásí i „Doručeno" nebo „Na cestě",
     což je osm znaků a míň. Vyloučí se proto jen věci, které popisem zjevně
     nejsou: datum, samotný čas, číslo zásilky, nadpis sloupce.
     */
    private static func isDescription(_ text: String, _ rules: LineRules) -> Bool {
        let value = trimmedText(text)
        if value.count < 4 || value.count > 200 { return false }
        if rules.dateLine.test(value) || rules.historyHead.test(value) { return false }
        if rules.numbersOnly.test(value) { return false }   // čísla, časy, kódy
        if rules.clockOnly.test(value) { return false }     // samotný čas
        return rules.word.test(value)                       // musí obsahovat slovo
    }

    // Cache drží hodnoty jako JSON text: přes hranici actoru smí jen typy, které
    // Swift umí označit za bezpečné, a `[String: Any]` mezi ně nepatří.
    private static func encodeJson(_ value: [String: Any]) -> String? {
        guard let data = try? JSONSerialization.data(withJSONObject: value) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private static func decodeJson(_ text: String?) -> [String: Any]? {
        guard let text, let data = text.data(using: .utf8) else { return nil }
        guard let parsed = try? JSONSerialization.jsonObject(with: data) else { return nil }
        return parsed as? [String: Any]
    }
}

// MARK: - Skryté webview

/**
 Načte stránku ve skrytém `WKWebView` a vrátí její text.

 PPL, DPD, GLS i další vypisují cestu zásilky až z JavaScriptu, takže prosté
 stažení vrátí prázdnou kostru. Na počítači to řeší skryté okno Electronu, tady
 webview mimo viditelnou plochu.

 Čekání je záměrně shovívavé: stránky dopravců jsou plné reklam a měřicích
 skriptů, jejichž rámy běžně selhávají a „hotovo" nemusí přijít nikdy. Proto se
 po dokončení navigace (nebo po vypršení pojistky) opakovaně čte `innerText`,
 dokud v něm nenajdeme nadpis výpisu, a pak se ještě chvíli počká, než doběhnou
 řádky tabulky.

 Celá třída je na `@MainActor` — s `WKWebView` se jinde pracovat nesmí.
 */
@MainActor
final class HeadlessPage {
    /// Rozměr běžného telefonu; některé stránky podle šířky rozhodují, jestli
    /// výpis vůbec vykreslí
    private static let viewport = CGSize(width: 390, height: 844)
    /// Kratší než text celé stránky nemá cenu považovat za načtený obsah
    private static let minContent = 200

    private var webView: WKWebView?
    private var waiter: PageLoadWaiter?

    /// Text stránky, nebo `nil`, když se nic rozumného nenačetlo.
    static func text(url: String, marker: String, limit: TimeInterval = 20) async -> String? {
        guard let target = URL(string: url) else { return nil }
        let page = HeadlessPage()
        defer { page.dispose() }
        return await page.read(target, marker: marker, limit: limit)
    }

    private func read(_ url: URL, marker: String, limit: TimeInterval) async -> String? {
        let deadline = Date().addingTimeInterval(limit)
        let view = makeWebView()

        var request = URLRequest(url: url, timeoutInterval: limit)
        request.setValue("cs,sk;q=0.9,en;q=0.8", forHTTPHeaderField: "Accept-Language")
        view.load(request)

        // Na dokončení navigace se čeká jen část limitu — zbytek patří čekání
        // na dokreslený obsah, které je u těchhle stránek to podstatné.
        let loader = PageLoadWaiter()
        waiter = loader
        view.navigationDelegate = loader
        await loader.wait(limit: min(limit * 0.6, 12))

        let found = TrackRx(marker)
        var best: String?
        while Date() < deadline {
            let text = await innerText()
            if let text, text.count > HeadlessPage.minContent { best = text }
            if let text, found.test(text) {
                // Nadpis výpisu je tam — krátce počkáme, než doběhnou řádky tabulky
                try? await Task.sleep(nanoseconds: 700_000_000)
                if let settled = await innerText() { best = settled } else { best = text }
                break
            }
            try? await Task.sleep(nanoseconds: 250_000_000)
        }
        return best
    }

    private func makeWebView() -> WKWebView {
        let configuration = WKWebViewConfiguration()
        // Cizí weby si u nás nemají co ukládat; sezení navíc nedrží nic mezi pokusy
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true

        let view = WKWebView(
            frame: CGRect(origin: .zero, size: HeadlessPage.viewport),
            configuration: configuration
        )
        view.customUserAgent = OrderTrack.userAgent
        view.isUserInteractionEnabled = false

        // Webview mimo hierarchii oken systém přiškrtí (časovače i vykreslování),
        // takže se React widget dopravce nedokreslí. Vloží se proto do okna,
        // ale mimo viditelnou plochu — uživatel o něm neví.
        if let window = HeadlessPage.hostWindow {
            view.frame = CGRect(
                origin: CGPoint(x: -HeadlessPage.viewport.width - 10, y: 0),
                size: HeadlessPage.viewport
            )
            window.addSubview(view)
        }
        webView = view
        return view
    }

    private static var hostWindow: UIWindow? {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap { $0.windows }
            .first { $0.isKeyWindow }
    }

    /// Během čekání se čte jen text, ne celé HTML — u PPL má přes megabajt
    /// a tahat ho při každém pokusu bylo to, co načítání zdržovalo.
    private func innerText() async -> String? {
        guard let view = webView else { return nil }
        do {
            // Vrací se vždy řetězec: asynchronní `evaluateJavaScript` si
            // s `undefined` neporadí
            let value = try await view.evaluateJavaScript("document.body ? document.body.innerText : ''")
            return value as? String
        } catch {
            return nil // stránka se zrovna překresluje, zkusíme za chvíli
        }
    }

    private func dispose() {
        waiter?.cancelWait()
        waiter = nil
        webView?.stopLoading()
        webView?.navigationDelegate = nil
        webView?.removeFromSuperview()
        webView = nil
    }
}

/**
 Počká na dokončení navigace, ale nejvýš zadaný čas.

 Delegát WebKitu chodí na hlavním vlákně, pojistka odjinud — proto zámek
 a jednorázové dokončení: druhé `resume` téže continuation je pád aplikace.
 Třída je proto `@unchecked Sendable`, celý stav hlídá `NSLock`.
 */
final class PageLoadWaiter: NSObject, WKNavigationDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Void, Never>?
    private var finished = false

    func wait(limit: TimeInterval) async {
        // Pojistka: kdyby navigace nikdy neskončila (mrtvý rám, měřicí skript
        // bez odpovědi), čekání se ukončí samo
        let alarm = Task.detached { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(max(limit, 1) * 1_000_000_000))
            self?.done()
        }
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            lock.lock()
            if finished {
                lock.unlock()
                continuation.resume()
                return
            }
            self.continuation = continuation
            lock.unlock()
        }
        alarm.cancel()
    }

    /// Uvolní případné čekání při úklidu, ať nic nezůstane viset.
    func cancelWait() {
        done()
    }

    private func done() {
        lock.lock()
        if finished {
            lock.unlock()
            return
        }
        finished = true
        let waiting = continuation
        continuation = nil
        lock.unlock()
        waiting?.resume()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { done() }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { done() }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        done()
    }
}

// MARK: - Cache

/**
 Cache stránek e-shopu a dopravců.

 Actor, protože se do ní sahá z několika souběžných načítání karty najednou.
 Hodnoty se drží jako JSON text — slovník `[String: Any]` by přes hranici
 actoru neprošel a překlad by na to hlasitě upozornil.
 */
private actor TrackCache {
    struct Entry {
        let at: Date
        /// `nil` = pokus dopadl naprázdno (drží se kratší dobu)
        let json: String?
    }

    static let shared = TrackCache()

    private var pages: [String: Entry] = [:]
    private var ships: [String: Entry] = [:]

    func page(_ key: String) -> Entry? { pages[key] }

    func setPage(_ key: String, _ json: String?) {
        pages[key] = Entry(at: Date(), json: json)
    }

    func ship(_ key: String) -> Entry? { ships[key] }

    func setShip(_ key: String, _ json: String?) {
        ships[key] = Entry(at: Date(), json: json)
    }

    func clear() {
        pages.removeAll()
        ships.removeAll()
    }
}

// MARK: - Regulární výrazy

/// Obal nad `NSRegularExpression`: vzor se překládá jednou, chybný vzor jen
/// nikdy nenajde shodu (žádné `try!` a žádný pád kvůli překlepu ve vzoru).
fileprivate struct TrackRx {
    private let regex: NSRegularExpression?

    init(_ pattern: String, options: NSRegularExpression.Options = [.caseInsensitive]) {
        regex = try? NSRegularExpression(pattern: pattern, options: options)
    }

    func test(_ text: String) -> Bool {
        guard let regex else { return false }
        return regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
    }

    /// Skupiny první shody; index 0 je celá shoda, `nil` na místě skupiny,
    /// která se neúčastnila.
    func match(_ text: String) -> [String?]? {
        guard let regex else { return nil }
        let range = NSRange(text.startIndex..., in: text)
        guard let found = regex.firstMatch(in: text, range: range) else { return nil }
        return (0..<found.numberOfRanges).map { index -> String? in
            guard let part = Range(found.range(at: index), in: text) else { return nil }
            return String(text[part])
        }
    }

    /// Zadaná skupina ze všech shod (např. všechny `href` na stránce).
    func matches(_ text: String, group: Int = 0) -> [String] {
        guard let regex else { return [] }
        let range = NSRange(text.startIndex..., in: text)
        return regex.matches(in: text, range: range).compactMap { found -> String? in
            guard found.numberOfRanges > group,
                  let part = Range(found.range(at: group), in: text) else { return nil }
            return String(text[part])
        }
    }

    func replacing(_ text: String, with template: String) -> String {
        guard let regex else { return text }
        return regex.stringByReplacingMatches(
            in: text,
            range: NSRange(text.startIndex..., in: text),
            withTemplate: template
        )
    }

    /// Nahradí každou shodu tím, co z její první skupiny udělá `transform`.
    /// `nil` znamená „nech to být" — používá se u neznámých HTML entit.
    /// Jde se odzadu, aby zbylé shody nepřestaly sedět po každé náhradě.
    func rewrite(_ text: String, _ transform: (String) -> String?) -> String {
        guard let regex else { return text }
        var out = text
        let found = regex.matches(in: text, range: NSRange(text.startIndex..., in: text))
        for match in found.reversed() {
            guard match.numberOfRanges > 1,
                  let whole = Range(match.range, in: out),
                  let group = Range(match.range(at: 1), in: out),
                  let value = transform(String(out[group])) else { continue }
            out.replaceSubrange(whole, with: value)
        }
        return out
    }
}

fileprivate func trimmedText(_ text: String) -> String {
    text.trimmingCharacters(in: .whitespacesAndNewlines)
}
