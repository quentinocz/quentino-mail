import Foundation

/**
 Zprávy z formulářů na webu.

 Totéž, co na počítači dělá `src/main/formmail.ts`. E-shop posílá „Rychlý
 kontakt" a podobné dotazy sám za sebe — v hlavičce `From` je adresa
 poskytovatele (`system@upgates.com`) a odpověď na ni se k zákazníkovi
 nedostane. Jeho adresa je přitom ve zprávě, jen o řádek níž v textu:

     Eshop: www.quentino.cz
     Email: tuckovaterez@gmail.com
     Čas: 22.08.2026 10:36:28

 Hledá se **popiska**, ne první adresa v textu — ve zprávě je i adresa
 e-shopu, odkaz na produkt a patička, takže „vezmi první e-mail" by odpověď
 poslalo někam úplně jinam.
 */
enum FormMail {
    struct Contact {
        var email: String
        var phone: String
        var name: String
        var form: String
        var page: String
    }

    /**
     Odesílatelé, kteří píšou za někoho jiného.

     Rozhoduje doména, ne celá adresa — poskytovatel střídá `system@`,
     `noreply@` i adresu s číslem instance, a vyjmenovat je všechny by
     znamenalo, že první nová varianta zase spadne pod stůl.
     */
    private static let relayDomains = ["upgates.com", "upgates.cz", "shoptet.cz", "shopify.com"]

    static func isRelaySender(_ fromAddr: String) -> Bool {
        let address = fromAddr.lowercased()
        let parts = address.split(separator: "@", maxSplits: 1).map(String.init)
        guard parts.count == 2 else { return false }
        let (user, domain) = (parts[0], parts[1])
        if relayDomains.contains(where: { domain == $0 || domain.hasSuffix(".\($0)") }) { return true }
        return user.range(
            of: "^(no-?reply|nereply|donotreply|system|mailer|robot)",
            options: [.regularExpression]
        ) != nil
    }

    // MARK: - Čtení hodnot

    private static let emailLabels = ["e-?mail", "email", "kontaktní e-?mail", "odesílatel"]
    private static let phoneLabels = ["telefonní číslo", "telefon", "mobil", "phone", "tel"]
    private static let nameLabels = ["jméno a příjmení", "jméno", "meno", "name"]
    private static let formLabels = ["formulář", "formular", "form"]
    private static let pageLabels = ["stránka", "stranka", "page", "url"]

    private static func first(_ text: String, _ pattern: String, group: Int = 1) -> String {
        guard let regex = try? NSRegularExpression(
                pattern: pattern, options: [.caseInsensitive, .anchorsMatchLines]),
              let found = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              found.numberOfRanges > group,
              let range = Range(found.range(at: group), in: text) else { return "" }
        return String(text[range]).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func labelled(_ text: String, _ labels: [String]) -> String {
        for label in labels {
            let value = first(text, "^[\\s>*_-]*\(label)\\s*[:：]\\s*(.+)$")
            if !value.isEmpty { return value }
        }
        return ""
    }

    /**
     HTML na text, jen pro čtení popisek.

     Bloky se lámou na řádky: popiska a hodnota bývají v HTML mailu každá
     ve své buňce tabulky a bez zlomu by se slily do jedné věty, na které
     by popiskový vzor nesedl.
     */
    private static func stripHtml(_ html: String) -> String {
        var text = html
        for (pattern, replacement) in [
            ("<(script|style)[\\s\\S]*?</\\1>", " "),
            ("<br\\s*/?>", "\n"),
            ("</(p|div|tr|td|th|li|h[1-6])>", "\n"),
            ("<[^>]+>", " ")
        ] {
            text = text.replacingOccurrences(
                of: pattern, with: replacement, options: [.regularExpression, .caseInsensitive])
        }
        for (entity, character) in [("&nbsp;", " "), ("&lt;", "<"), ("&gt;", ">"),
                                    ("&quot;", "\""), ("&#39;", "'"), ("&amp;", "&")] {
            text = text.replacingOccurrences(of: entity, with: character, options: [.caseInsensitive])
        }
        return text
            .replacingOccurrences(of: "[ \\t]+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Telefon do tvaru, na který jde rovnou klepnout.
    static func normalizePhone(_ raw: String) -> String {
        let clean = raw.filter { $0.isNumber || $0 == "+" }
        if clean.count < 9 { return "" }
        if clean.hasPrefix("+") { return clean }
        if clean.hasPrefix("00") { return "+" + clean.dropFirst(2) }
        if clean.count == 9 { return "+420" + clean }
        // Dvanáct číslic začínajících předvolbou bez plus („420733573771")
        if clean.count == 12, clean.hasPrefix("420") || clean.hasPrefix("421") { return "+" + clean }
        return clean
    }

    // MARK: - Rozbor

    /// Vrací `nil`, když zpráva na formulář nevypadá — volající se pak chová jako dřív.
    static func contact(_ message: [String: Any]) -> Contact? {
        // Když odesílatel poslal Reply-To, je rozhodnuto a nemá cenu hádat z textu
        let replyTo = (message["replyTo"] as? String ?? "").trimmingCharacters(in: .whitespaces)
        if !replyTo.isEmpty { return nil }
        guard isRelaySender(message["fromAddr"] as? String ?? "") else { return nil }

        let bodyText = (message["bodyText"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let text = bodyText.isEmpty ? stripHtml(message["bodyHtml"] as? String ?? "") : bodyText
        if text.isEmpty { return nil }

        let emailValue = labelled(text, emailLabels)
        let email = first(emailValue, "([\\w.+-]+@[\\w-]+\\.[\\w.]{2,})", group: 1).lowercased()
        if email.isEmpty { return nil }
        // Adresa e-shopu není zákazník
        if isRelaySender(email) { return nil }

        // Formulář se na číslo ptá větou, ne popiskou („…můžete napsat i své
        // telefonní číslo: 733573771"), proto se zkouší i volnější vzor
        let byLabel = labelled(text, phoneLabels)
        let loose = first(text, "telefon(?:ní)?\\s*(?:číslo|cislo)?\\s*[:：]?\\s*([\\d\\s+().-]{9,20})")
        let phone = normalizePhone(byLabel.isEmpty ? loose : byLabel)

        return Contact(
            email: email,
            phone: phone,
            name: labelled(text, nameLabels),
            form: {
                let value = labelled(text, formLabels)
                return value.isEmpty ? (message["subject"] as? String ?? "") : value
            }(),
            page: labelled(text, pageLabels)
        )
    }

    /**
     Komu odpovědět.

     Pořadí je dané tím, jak spolehlivý který zdroj je: `Reply-To` si přeje
     sám odesílatel, adresa z formuláře je vytažená z těla zprávy, a teprve
     když není ani jedno, zbývá `From`.
     */
    static func replyTarget(_ message: [String: Any]) -> [String: Any] {
        let replyTo = (message["replyTo"] as? String ?? "")
            .split(separator: ",").first.map(String.init)?
            .trimmingCharacters(in: .whitespaces) ?? ""
        if !replyTo.isEmpty {
            return ["address": replyTo, "name": "", "source": "reply-to", "phone": "", "form": ""]
        }
        if let found = contact(message) {
            return ["address": found.email, "name": found.name, "source": "formulář",
                    "phone": found.phone, "form": found.form]
        }
        return [
            "address": message["fromAddr"] as? String ?? "",
            "name": message["fromName"] as? String ?? "",
            "source": "odesílatel", "phone": "", "form": ""
        ]
    }
}
