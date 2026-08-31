import Foundation
import UIKit
import UserNotifications

/**
 Upozornění na telefon.

 Dvě cesty ke stejnému cíli, protože každá pokrývá jinou situaci:

 **Okamžitá cesta vede přes ntfy a odesílá ji počítač** (`src/main/notify.ts`):
 push přímo do téhle aplikace by znamenal placený účet u Applu — oprávnění
 „Push Notifications" volný profil neunese a aplikace se navíc podepisuje přes
 SideStore. Odsud se přes ntfy posílá jen zkušební zpráva z nastavení, aby šlo
 ověřit, že téma sedí; běžná upozornění by chodila dvakrát.

 **Záchranná síť je lokální notifikace**: když se telefon sám probudí na
 pozadí a najde novou poštu, upozorní z vlastní aplikace a nic neteče ven.
 Systém ale probuzení pouští, kdy uzná za vhodné — okamžité to není.

 Ven jde odesílatel a předmět, ne text zprávy.
 */
enum Notify {
    static let defaultServer = "https://ntfy.sh"

    // MARK: - Povolení

    /**
     Zeptá se na povolení notifikací.

     Ptá se jen jednou; když člověk odmítne, systém další dotaz stejně zahodí
     a musel by to povolit v Nastavení. Volá se při startu, ať je odpověď
     k dispozici dřív, než se telefon poprvé probudí na pozadí.
     */
    static func requestPermission() {
        UNUserNotificationCenter.current()
            .requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
    }

    // MARK: - Lokální notifikace

    /**
     Ukáže notifikaci z téhle aplikace. Bez sítě a bez cizí služby.

     `link` je adresa ve vlastním schématu aplikace; po klepnutí ji otevře
     `AppDelegate` a rozhraní na ni skočí. Bez něj by klepnutí jen spustilo
     aplikaci a hledat zprávu by musel člověk sám.
     */
    static func showLocal(title: String, body: String, id: String, link: String? = nil) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        if let link { content.userInfo = ["link": link] }

        let request = UNNotificationRequest(identifier: id, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request)
    }

    // MARK: - ntfy

    /// Zkušební notifikace z nastavení — pošle se i s vypnutými přepínači.
    static func test(server: String, topic: String) async -> [String: Any] {
        let clean = topic.trimmingCharacters(in: .whitespaces)
        guard !clean.isEmpty else { return ["ok": false, "error": "Vyplň název tématu"] }
        let ok = await send(server: server.isEmpty ? defaultServer : server, topic: clean,
                            title: "Quentino",
                            message: "Zkušební upozornění. Když tohle vidíš na telefonu, je hotovo.",
                            tag: "white_check_mark")
        return ok ? ["ok": true] : ["ok": false, "error": "Nepodařilo se odeslat"]
    }

    /**
     Odesílá se JSONem na kořen serveru, ne hlavičkami na adresu tématu:
     hlavičky musí být ASCII, takže „Nová objednávka" by se cestou rozsypalo.
     */
    private static func send(server: String, topic: String, title: String,
                             message: String, tag: String) async -> Bool {
        let base = server.trimmingCharacters(in: .whitespaces)
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard let url = URL(string: base) else { return false }

        let payload: [String: Any] = [
            "topic": topic,
            "title": title,
            "message": message,
            "tags": [tag],
            "priority": 3
        ]
        guard let body = try? JSONSerialization.data(withJSONObject: payload) else { return false }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        request.timeoutInterval = 8

        guard let (_, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse else { return false }
        return (200...299).contains(http.statusCode)
    }

    // MARK: - Co ohlásit

    /**
     Ohlásí novou poštu, kterou telefon našel sám.

     Hlídá se poslední ohlášená zpráva, aby se totéž neopakovalo při každém
     probuzení. Značka se drží zvlášť od „přečteno": zpráva zůstane nepřečtená
     klidně den a upozornit na ni stačí jednou.
     */
    static func announceNewMail() async {
        guard Store.bool("notifyPhoneLocal", true) else { return }
        let last = Int(Store.setting("notifyLastMailId", "0") ?? "0") ?? 0
        let rows = (try? SQLite.shared.query(
            """
            SELECT id, message_id, from_name, from_addr, subject FROM messages
            WHERE folder = 'INBOX' AND seen = 0 AND id > ?
            ORDER BY id DESC LIMIT 5
            """,
            [.int(Int64(last))]
        )) ?? []
        guard !rows.isEmpty else { return }

        let newest = rows.compactMap { $0["id"] as? Int }.max() ?? last
        Store.setSetting("notifyLastMailId", String(newest))

        // Při prvním spuštění se značka teprve zakládá — ohlásit celou
        // schránku by znamenalo pět notifikací hned po instalaci
        guard last > 0 else { return }

        let lines = rows.map { row -> (String, String) in
            let who = (row["from_name"] as? String).flatMap { $0.isEmpty ? nil : $0 }
                ?? (row["from_addr"] as? String) ?? "Neznámý odesílatel"
            let subject = (row["subject"] as? String).flatMap { $0.isEmpty ? nil : $0 }
                ?? "(bez předmětu)"
            return (who, subject)
        }

        let title: String
        let body: String
        if lines.count == 1 {
            title = lines[0].0
            body = lines[0].1
        } else {
            title = "\(lines.count) \(lines.count < 5 ? "nové zprávy" : "nových zpráv")"
            body = lines.map { "\($0.0): \($0.1)" }.joined(separator: "\n")
        }

        /*
         Odkaz jen u jedné zprávy. U několika naráz by ukázal na jednu z nich
         a zbytek by vypadal jako přeskočený — tam stačí otevřít poštu.
         */
        var link = "quentino-mail://mail"
        if rows.count == 1, let mid = rows[0]["message_id"] as? String, !mid.isEmpty,
           let escaped = mid.addingPercentEncoding(withAllowedCharacters: .alphanumerics) {
            link = "quentino-mail://mail?mid=\(escaped)"
        }

        showLocal(title: title, body: body, id: "mail-\(newest)", link: link)
    }
}
